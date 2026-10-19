from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Awaitable, Callable

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.util import dt as dt_util

from ..appliances.execution import (
    ApplianceExecutionMemory,
    AppliancesExecutor,
)
from ..appliances.schedule import ApplianceScheduleActionDict
from ..appliances.state import AppliancesRuntimeRegistry
from ..battery_state import BatteryLiveState
from ..controllables.controllers import SelectEntityController
from ..const import (
    SCHEDULE_ACTION_EMPTY,
    SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_NORMAL,
    SCHEDULE_ACTION_STOP_EXPORT,
    SCHEDULE_EXECUTOR_INTERVAL_SECONDS,
)
from .action_resolution import resolve_executed_schedule_action
from .actuation import ScheduleActuator
from .runtime_status import (
    ActiveSlotRuntimeStatus,
    ControllableRuntimeStatus,
    RuntimeActionKind,
    ScheduleExecutionStatus,
)
from .schedule import (
    EMPTY_SCHEDULE_ACTION,
    INVERTER_ACTION_KINDS,
    NORMAL_SCHEDULE_ACTION,
    REQUIRED_INVERTER_ACTIONS,
    ScheduleAction,
    ScheduleControlConfig,
    ScheduleDocument,
    ScheduleError,
    ScheduleExecutionUnavailableError,
    ScheduleNotConfiguredError,
    appliance_actions,
    build_horizon_start,
    find_active_slot,
    format_slot_id,
    inverter_action,
    parse_slot_id,
    strip_candidate_actions,
)

_LOGGER = logging.getLogger(__name__)
# Names the inverter's mode entity in every diagnostic the shared select
# controller raises, so a failure still says which select failed.
_INVERTER_MODE_DESCRIPTION = "Schedule mode"


@dataclass(frozen=True)
class ScheduleExecutorDependencies:
    # The pruned document as of the given time, read under the schedule lock and
    # released before it returns -- the one prune the schedule service owns.
    read_schedule_document: Callable[[datetime], Awaitable[ScheduleDocument]]
    # The stored document as it is, lock-free: what the actuation gate reads
    # the execution flag from on every write.
    load_schedule_document: Callable[[], ScheduleDocument]
    read_schedule_control_config: Callable[[], ScheduleControlConfig | None]
    read_battery_state: Callable[[], BatteryLiveState | None]
    read_appliances_registry: Callable[[], AppliancesRuntimeRegistry]
    # Pre-execution reality check: given the reconcile time, returns True if the
    # plan is stale and current conditions differ from it — in which case a
    # re-plan has been triggered and execution should defer this cycle. Optional
    # so tests can omit it (defaults to "never defer").
    check_reality_and_maybe_replan: Callable[[datetime], Awaitable[bool]] | None = (
        None
    )
    announce_schedule_changed: Callable[[], None] | None = None


@dataclass
class ScheduleExecutionRuntime:
    last_applied_action: ScheduleAction | None = None
    last_active_slot_id: str | None = None
    last_runtime_action_kind: RuntimeActionKind | None = None
    last_error: str | None = None
    appliance_memories: dict[str, ApplianceExecutionMemory] = field(
        default_factory=dict
    )
    execution_status: ScheduleExecutionStatus = field(
        default_factory=ScheduleExecutionStatus
    )


@dataclass(frozen=True)
class InverterExecutionResult:
    runtime: ControllableRuntimeStatus
    error: ScheduleError | None = None


class InverterExecutor:
    def __init__(
        self,
        actuator: ScheduleActuator,
        runtime: ScheduleExecutionRuntime,
        *,
        read_battery_state: Callable[[], BatteryLiveState | None] | None = None,
    ) -> None:
        self._actuator = actuator
        self._runtime = runtime
        self._read_battery_state = read_battery_state or (lambda: None)

    def validate_control_entity(
        self,
        *,
        control_config: ScheduleControlConfig,
    ) -> tuple[SelectEntityController, Any]:
        controller = SelectEntityController(
            control_config.mode_entity_id,
            description=_INVERTER_MODE_DESCRIPTION,
        )
        state = controller.read_state(self._actuator)
        for action_kind in INVERTER_ACTION_KINDS:
            if action_kind in REQUIRED_INVERTER_ACTIONS:
                controller.validate_option(state, control_config.options[action_kind])
        return controller, state

    async def async_reconcile(
        self,
        control_config: ScheduleControlConfig | None,
        action: ScheduleAction,
        slot_id: str,
        now: datetime,
    ) -> tuple[ControllableRuntimeStatus, ScheduleError | None]:
        if action.kind == SCHEDULE_ACTION_EMPTY:
            cached_runtime = self.build_cached_empty_runtime(
                active_slot_id=slot_id
            )
            if cached_runtime is not None:
                return cached_runtime, None
            if _empty_inverter_action_requires_slot_stop(self._runtime):
                if control_config is None:
                    return (
                        ControllableRuntimeStatus(
                            action_kind="slot_stop",
                            outcome="failed",
                            executed_action=NORMAL_SCHEDULE_ACTION,
                            reason="scheduled",
                            error_code="not_configured",
                        ),
                        ScheduleNotConfiguredError(
                            "Schedule control config is required to restore normal mode "
                            "after an inverter schedule override"
                        ),
                    )
                result = await self.async_cleanup_empty_slot(
                    control_config=control_config,
                    active_slot_id=slot_id,
                )
                return result.runtime, result.error
            return (
                self.build_empty_noop_runtime(active_slot_id=slot_id),
                None,
            )

        if control_config is None:
            return (
                ControllableRuntimeStatus(
                    action_kind="apply",
                    outcome="failed",
                    executed_action=action,
                    reason="scheduled",
                    error_code="not_configured",
                ),
                ScheduleNotConfiguredError(
                    "Schedule control config is required to execute the schedule"
                ),
            )

        result = await self.async_execute(
            control_config=control_config,
            action=action,
            active_slot_id=slot_id,
            reference_time=now,
            read_battery_state=self._read_battery_state,
        )
        return result.runtime, result.error

    async def async_execute(
        self,
        *,
        control_config: ScheduleControlConfig,
        action: ScheduleAction,
        active_slot_id: str,
        reference_time: datetime,
        read_battery_state: Callable[[], BatteryLiveState | None],
    ) -> InverterExecutionResult:
        try:
            resolution = self._resolve_action(
                action=action,
                read_battery_state=read_battery_state,
            )
            controller, state = self.validate_control_entity(
                control_config=control_config
            )
            await self._async_apply_action(
                controller=controller,
                state=state,
                control_config=control_config,
                action=resolution.executed_action,
                active_slot_id=active_slot_id,
                action_kind="apply",
            )
        except ScheduleError as err:
            fallback_reason = "scheduled"
            fallback_action = action
            if "resolution" in locals():
                fallback_reason = resolution.reason
                fallback_action = resolution.executed_action
            return InverterExecutionResult(
                runtime=ControllableRuntimeStatus(
                    action_kind="apply",
                    outcome="failed",
                    executed_action=fallback_action,
                    reason=fallback_reason,
                    error_code=err.code,
                ),
                error=err,
            )

        return InverterExecutionResult(
            runtime=ControllableRuntimeStatus(
                action_kind="apply",
                outcome="success",
                executed_action=resolution.executed_action,
                reason=resolution.reason,
            )
        )

    async def async_restore_normal(
        self,
        *,
        control_config: ScheduleControlConfig,
    ) -> None:
        controller, state = self.validate_control_entity(control_config=control_config)
        await self._async_apply_action(
            controller=controller,
            state=state,
            control_config=control_config,
            action=NORMAL_SCHEDULE_ACTION,
            active_slot_id=None,
            action_kind="apply",
        )

    async def async_cleanup_empty_slot(
        self,
        *,
        control_config: ScheduleControlConfig,
        active_slot_id: str,
    ) -> InverterExecutionResult:
        try:
            controller, state = self.validate_control_entity(control_config=control_config)
            await self._async_apply_action(
                controller=controller,
                state=state,
                control_config=control_config,
                action=NORMAL_SCHEDULE_ACTION,
                active_slot_id=active_slot_id,
                action_kind="slot_stop",
            )
        except ScheduleError as err:
            return InverterExecutionResult(
                runtime=ControllableRuntimeStatus(
                    action_kind="slot_stop",
                    outcome="failed",
                    executed_action=NORMAL_SCHEDULE_ACTION,
                    reason="scheduled",
                    error_code=err.code,
                ),
                error=err,
            )

        return InverterExecutionResult(
            runtime=ControllableRuntimeStatus(
                action_kind="slot_stop",
                outcome="success",
                executed_action=NORMAL_SCHEDULE_ACTION,
                reason="scheduled",
            )
        )

    def build_empty_noop_runtime(self, *, active_slot_id: str) -> ControllableRuntimeStatus:
        self._runtime.last_applied_action = EMPTY_SCHEDULE_ACTION
        self._runtime.last_active_slot_id = active_slot_id
        self._runtime.last_runtime_action_kind = "noop"
        return ControllableRuntimeStatus(
            action_kind="noop",
            outcome="skipped",
            executed_action=EMPTY_SCHEDULE_ACTION,
            reason="scheduled",
        )

    def build_cached_empty_runtime(
        self,
        *,
        active_slot_id: str,
    ) -> ControllableRuntimeStatus | None:
        if self._runtime.last_active_slot_id != active_slot_id:
            return None
        if self._runtime.last_runtime_action_kind == "slot_stop":
            return ControllableRuntimeStatus(
                action_kind="slot_stop",
                outcome="success",
                executed_action=NORMAL_SCHEDULE_ACTION,
                reason="scheduled",
            )
        if (
            self._runtime.last_runtime_action_kind == "noop"
            and self._runtime.last_applied_action == EMPTY_SCHEDULE_ACTION
        ):
            return ControllableRuntimeStatus(
                action_kind="noop",
                outcome="skipped",
                executed_action=EMPTY_SCHEDULE_ACTION,
                reason="scheduled",
            )
        return None

    @staticmethod
    def _resolve_action(
        *,
        action: ScheduleAction,
        read_battery_state: Callable[[], BatteryLiveState | None],
    ):
        battery_state = None
        if action.kind in {
            SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
            SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
        }:
            battery_state = read_battery_state()
        return resolve_executed_schedule_action(
            action=action,
            current_soc=None if battery_state is None else battery_state.current_soc,
        )

    @staticmethod
    def _resolve_option_for_action(
        *,
        control_config: ScheduleControlConfig,
        action: ScheduleAction,
    ) -> str:
        option = control_config.options.get(action.kind)
        if option is None:
            if action.kind in {
                SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
                SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
                SCHEDULE_ACTION_STOP_EXPORT,
            }:
                raise ScheduleNotConfiguredError(
                    f"Schedule control config is missing the {action.kind} action option"
                )
            return control_config.options.get(SCHEDULE_ACTION_NORMAL, "")
        return option

    async def _async_apply_action(
        self,
        *,
        controller: SelectEntityController,
        state: Any,
        control_config: ScheduleControlConfig,
        action: ScheduleAction,
        active_slot_id: str | None,
        action_kind: RuntimeActionKind,
    ) -> None:
        desired_option = self._resolve_option_for_action(
            control_config=control_config,
            action=action,
        )
        controller.validate_option(state, desired_option)

        current_option = getattr(state, "state", None)
        if current_option != desired_option:
            await controller.async_select_option(self._actuator, option=desired_option)

        self._runtime.last_applied_action = action
        self._runtime.last_active_slot_id = active_slot_id
        self._runtime.last_runtime_action_kind = action_kind


@dataclass
class _ReconcileRequest:
    """One coalesced reconcile: why it was asked for, and who awaits it."""

    reason: str
    waiters: list[asyncio.Future[None]] = field(default_factory=list)


class ScheduleExecutor:
    def __init__(
        self,
        hass: HomeAssistant,
        dependencies: ScheduleExecutorDependencies,
        *,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._hass = hass
        self._dependencies = dependencies
        # The execution clock. Read after the execution lock is taken, so a
        # request that waited behind a slow attempt still runs the slot that is
        # current when it actually starts.
        self._now = now or dt_util.now
        # The gate every hardware write goes through. It reads the persisted
        # flag fresh on each call, so a schedule saved by anyone -- the user,
        # automation, a restore -- takes effect immediately.
        self._actuator = ScheduleActuator(
            hass,
            is_execution_enabled=(
                lambda: dependencies.load_schedule_document().execution_enabled
            ),
        )
        self._runtime = ScheduleExecutionRuntime()
        self._inverter_executor = InverterExecutor(
            self._actuator,
            self._runtime,
            read_battery_state=lambda: self._dependencies.read_battery_state(),
        )
        self._appliances_executor = AppliancesExecutor(self._actuator)
        # Serializes every hardware-touching path -- reconcile and explicit
        # restore. The schedule lock is only ever taken inside it, briefly, to
        # snapshot the document; never the other way round.
        self._execution_lock = asyncio.Lock()
        self._unsub_interval: Callable[[], None] | None = None
        # The coalesced reconcile worker: at most one attempt running and one
        # merged follow-up pending, however many ticks, saves and enable
        # requests arrive while hardware is slow.
        self._worker_task: asyncio.Task[None] | None = None
        self._pending_request: _ReconcileRequest | None = None
        self._stopped = True
        self._unloaded = False

    @property
    def is_running(self) -> bool:
        return not self._stopped

    @property
    def runtime(self) -> ScheduleExecutionRuntime:
        return self._runtime

    def get_execution_status(self) -> ScheduleExecutionStatus:
        return self._runtime.execution_status

    def reset_runtime(self) -> None:
        self._runtime = ScheduleExecutionRuntime()
        self._inverter_executor = InverterExecutor(
            self._actuator,
            self._runtime,
            read_battery_state=lambda: self._dependencies.read_battery_state(),
        )

    async def async_start(self) -> None:
        if self._unloaded:
            return
        self._stopped = False
        if self._unsub_interval is not None:
            return

        @callback
        def _handle_interval_tick(now: datetime) -> None:
            del now
            self.request_reconcile(reason="interval")

        self._unsub_interval = async_track_time_interval(
            self._hass,
            _handle_interval_tick,
            timedelta(seconds=SCHEDULE_EXECUTOR_INTERVAL_SECONDS),
        )

    async def async_stop(self) -> None:
        self._stopped = True
        if self._unsub_interval is not None:
            self._unsub_interval()
            self._unsub_interval = None

        pending = self._pending_request
        self._pending_request = None
        if pending is not None:
            for waiter in pending.waiters:
                waiter.cancel()

        worker = self._worker_task
        if worker is not None:
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)
        self._worker_task = None

        self.reset_runtime()

    async def async_unload(self) -> None:
        # Final: a startup callback racing the unload must not bring the
        # interval back on a coordinator that is going away.
        self._unloaded = True
        await self.async_stop()

    def request_reconcile(self, *, reason: str) -> None:
        """Ask the worker for a reconcile and return without waiting for it."""
        self._queue_reconcile(reason=reason, wait=False)

    async def async_reconcile_and_wait(self, *, reason: str) -> None:
        """Ask the worker for a reconcile and wait for the attempt serving it.

        Joins the same queue as every background request rather than running
        its own, and raises that attempt's error. A reconcile that never ran --
        the executor is stopped, or stops while this waits -- is reported as
        unavailable, never as a success.
        """
        waiter = self._queue_reconcile(reason=reason, wait=True)
        if waiter is None:
            raise ScheduleExecutionUnavailableError("Schedule execution is not running")
        try:
            await waiter
        except asyncio.CancelledError:
            # Our own cancellation propagates; a waiter cancelled by stop or
            # unload is a reconcile that did not happen.
            current = asyncio.current_task()
            if current is not None and current.cancelling():
                raise
            raise ScheduleExecutionUnavailableError(
                "Schedule execution stopped before the reconcile completed"
            ) from None

    def _queue_reconcile(
        self,
        *,
        reason: str,
        wait: bool,
    ) -> asyncio.Future[None] | None:
        if self._stopped:
            return None
        # A request arriving mid-attempt merges into the single follow-up, which
        # reads the time and the schedule afresh when it starts.
        if self._pending_request is None:
            self._pending_request = _ReconcileRequest(reason=reason)
        waiter: asyncio.Future[None] | None = None
        if wait:
            waiter = asyncio.get_running_loop().create_future()
            self._pending_request.waiters.append(waiter)
        # ``done()`` rather than ``None``: an eagerly started worker can drain
        # the queue and finish before its task is even assigned here.
        if self._worker_task is None or self._worker_task.done():
            # A background task: a worker waiting on stalled hardware must not
            # hold up Home Assistant's startup or shutdown.
            self._worker_task = self._hass.async_create_background_task(
                self._async_run_reconcile_worker(),
                "helman schedule reconcile worker",
            )
        return waiter

    async def _async_run_reconcile_worker(self) -> None:
        while self._pending_request is not None:
            request = self._pending_request
            self._pending_request = None
            try:
                error = await self._async_run_reconcile_request(request)
            except asyncio.CancelledError:
                for waiter in request.waiters:
                    waiter.cancel()
                raise
            for waiter in request.waiters:
                if waiter.done():
                    continue
                if error is None:
                    waiter.set_result(None)
                else:
                    waiter.set_exception(error)

    async def _async_run_reconcile_request(
        self,
        request: _ReconcileRequest,
    ) -> Exception | None:
        try:
            await self.async_reconcile(reason=request.reason)
        except ScheduleError as err:
            # A waiting caller reports the failure itself; otherwise -- no
            # waiter, or every waiter gone -- it is logged here, once per
            # distinct error.
            if all(waiter.done() for waiter in request.waiters):
                self._log_reconcile_failure(err, reason=request.reason)
            return err
        except Exception as err:
            _LOGGER.exception(
                "Schedule execution reconcile failed unexpectedly during %s",
                request.reason,
            )
            return err
        return None

    async def async_reconcile(
        self,
        *,
        reason: str,
        reference_time: datetime | None = None,
    ) -> None:
        del reason

        async with self._execution_lock:
            request_now = reference_time or self._now()
            # Reality check before execution: if the plan is stale and
            # conditions have changed since it was built, a re-plan is queued and
            # we defer this cycle. Execution itself never re-checks conditions —
            # it always trusts the plan's condition_met. It only queues the
            # re-plan, so it never waits on the locks that re-plan needs.
            check_reality = self._dependencies.check_reality_and_maybe_replan
            if check_reality is not None and await check_reality(request_now):
                return
            # The schedule lock covers the snapshot only: reads, saves and the
            # execution toggle must stay responsive while hardware is slow.
            schedule_document = await self._dependencies.read_schedule_document(
                request_now
            )
            await self._async_execute_snapshot(
                schedule_document=schedule_document,
                request_now=request_now,
            )

    async def _async_execute_snapshot(
        self,
        *,
        schedule_document: ScheduleDocument,
        request_now: datetime,
    ) -> None:
        if not schedule_document.execution_enabled:
            self.reset_runtime()
            return

        # Execute only committed actions: candidate actions (placed by
        # optimizers whose execution condition is not met) are stripped so
        # they are neither applied nor treated as the last scheduled state.
        # They remain in the stored document for display and promotion.
        committed_document = strip_candidate_actions(schedule_document)

        current_slot_id = format_slot_id(build_horizon_start(request_now))
        active_slot = find_active_slot(
            stored_slots=committed_document.slots,
            reference_time=request_now,
        )
        active_action = (
            EMPTY_SCHEDULE_ACTION
            if active_slot is None
            else inverter_action(active_slot.controllables)
        )
        active_actions = (
            {} if active_slot is None else appliance_actions(active_slot.controllables)
        )
        last_scheduled_actions = _build_last_scheduled_appliance_actions(
            stored_slots=committed_document.slots,
            reference_time=request_now,
        )

        control_config = self._dependencies.read_schedule_control_config()
        inverter_runtime, first_error = (
            await self._inverter_executor.async_reconcile(
                control_config,
                active_action,
                current_slot_id,
                request_now,
            )
        )

        appliance_result = await self._appliances_executor.async_execute(
            registry=self._dependencies.read_appliances_registry(),
            active_slot_id=current_slot_id,
            active_actions=active_actions,
            last_scheduled_actions=last_scheduled_actions,
            previous_memories=self._runtime.appliance_memories,
            reference_time=request_now,
        )
        if first_error is None:
            first_error = appliance_result.first_error

        self._runtime.appliance_memories = appliance_result.memories
        self._set_execution_status(
            ScheduleExecutionStatus(
                active_slot_id=current_slot_id,
                active_slot_runtime=ActiveSlotRuntimeStatus(
                    inverter=inverter_runtime,
                    appliances=appliance_result.runtimes,
                    reconciled_at=self._format_reconciled_at(request_now),
                ),
            )
        )
        if first_error is not None:
            raise first_error

        self._runtime.last_error = None

    def _log_reconcile_failure(self, err: ScheduleError, *, reason: str) -> None:
        error_key = f"{err.code}:{err}"
        if self._runtime.last_error == error_key:
            return

        context = self._build_failure_log_context()
        _LOGGER.warning(
            "Schedule execution reconcile failed during %s%s: %s (%s)",
            reason,
            f" [{context}]" if context else "",
            err,
            err.code,
        )
        self._runtime.last_error = error_key

    async def async_restore_normal(self, *, reason: str) -> None:
        del reason

        async with self._execution_lock:
            reference_time = self._now()
            schedule_document = await self._dependencies.read_schedule_document(
                reference_time
            )
            control_config = self._dependencies.read_schedule_control_config()
            if control_config is None:
                raise ScheduleNotConfiguredError(
                    "Schedule control config is required to restore normal mode"
                )

            active_slot = find_active_slot(
                stored_slots=schedule_document.slots,
                reference_time=reference_time,
            )
            active_actions = (
                {} if active_slot is None else appliance_actions(active_slot.controllables)
            )

            appliance_result = await self._appliances_executor.async_restore_active_slot(
                registry=self._dependencies.read_appliances_registry(),
                active_actions=active_actions,
                reference_time=reference_time,
            )
            if appliance_result.first_error is not None:
                raise appliance_result.first_error

            await self._inverter_executor.async_restore_normal(
                control_config=control_config
            )
            self._set_execution_status(
                ScheduleExecutionStatus(
                    active_slot_id=None,
                    active_slot_runtime=None,
                )
            )
            self._runtime.appliance_memories = {}
            self._runtime.last_error = None

    def clear_appliance_memories(self) -> None:
        self._runtime.appliance_memories = {}

    def _set_execution_status(self, status: ScheduleExecutionStatus) -> None:
        previous = self._runtime.execution_status
        self._runtime.execution_status = status
        if (
            self._material_status(previous) != self._material_status(status)
            and self._dependencies.announce_schedule_changed is not None
        ):
            self._dependencies.announce_schedule_changed()

    @staticmethod
    def _material_status(status: ScheduleExecutionStatus) -> tuple:
        runtime = status.active_slot_runtime
        if runtime is None:
            return (status.active_slot_id, None)
        inverter = runtime.inverter
        return (
            status.active_slot_id,
            (
                None
                if inverter is None
                else (
                    inverter.action_kind,
                    inverter.outcome,
                    inverter.executed_action,
                    inverter.reason,
                    inverter.error_code,
                )
            ),
            tuple(
                sorted(
                    (
                        appliance_id,
                        item.action_kind,
                        item.outcome,
                        item.error_code,
                        item.message,
                    )
                    for appliance_id, item in runtime.appliances.items()
                )
            ),
        )

    def _build_failure_log_context(self) -> str:
        parts: list[str] = []
        execution_status = self._runtime.execution_status
        if execution_status.active_slot_id is not None:
            parts.append(f"active_slot_id={execution_status.active_slot_id}")

        runtime = execution_status.active_slot_runtime
        if runtime is not None and runtime.executed_action is not None:
            parts.append(
                f"executed_action={self._format_action(runtime.executed_action)}"
            )

        return ", ".join(parts)

    @staticmethod
    def _format_action(action: ScheduleAction) -> str:
        if action.target_soc is None:
            return action.kind
        return f"{action.kind}({action.target_soc})"

    @staticmethod
    def _format_reconciled_at(reference_time: datetime) -> str:
        return dt_util.as_local(reference_time).isoformat(timespec="seconds")


def _build_last_scheduled_appliance_actions(
    *,
    stored_slots: Mapping[str, Any],
    reference_time: datetime,
) -> dict[str, ApplianceScheduleActionDict]:
    current_slot_start = build_horizon_start(reference_time)
    last_actions: dict[str, ApplianceScheduleActionDict] = {}

    for slot_id, actions in sorted(
        stored_slots.items(),
        key=lambda item: parse_slot_id(item[0]),
    ):
        if parse_slot_id(slot_id) > current_slot_start:
            break
        for appliance_id, action in appliance_actions(actions).items():
            last_actions[appliance_id] = action

    return last_actions


def _empty_inverter_action_requires_slot_stop(
    runtime: ScheduleExecutionRuntime,
) -> bool:
    last_action = runtime.last_applied_action
    if last_action is None or runtime.last_runtime_action_kind == "noop":
        return False
    return last_action.kind not in {
        SCHEDULE_ACTION_EMPTY,
        SCHEDULE_ACTION_NORMAL,
    }
