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
    AppliancesExecutionResult,
    AppliancesExecutor,
)
from ..appliances.state import AppliancesRuntimeRegistry
from ..battery_state import BatteryLiveState
from ..const import (
    SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_NORMAL,
    SCHEDULE_ACTION_STOP_CHARGING,
    SCHEDULE_ACTION_STOP_DISCHARGING,
    SCHEDULE_EXECUTOR_INTERVAL_SECONDS,
)
from .action_resolution import resolve_executed_schedule_action
from .runtime_status import (
    ActiveSlotRuntimeStatus,
    InverterRuntimeStatus,
    ScheduleExecutionStatus,
)
from .schedule import (
    NORMAL_SCHEDULE_ACTION,
    ScheduleAction,
    ScheduleControlConfig,
    ScheduleDocument,
    ScheduleError,
    ScheduleExecutionUnavailableError,
    ScheduleNotConfiguredError,
    build_horizon_start,
    find_active_slot,
    format_slot_id,
    prune_expired_slots,
)

_LOGGER = logging.getLogger(__name__)
_UNAVAILABLE_STATES = {"unknown", "unavailable", "none"}


@dataclass(frozen=True)
class ScheduleExecutorDependencies:
    schedule_lock: asyncio.Lock
    load_schedule_document: Callable[[], ScheduleDocument]
    save_schedule_document: Callable[[ScheduleDocument], Awaitable[None]]
    read_schedule_control_config: Callable[[], ScheduleControlConfig | None]
    read_battery_state: Callable[[], BatteryLiveState | None]
    read_appliances_registry: Callable[[], AppliancesRuntimeRegistry]


@dataclass
class ScheduleExecutionRuntime:
    last_applied_entity_id: str | None = None
    last_applied_option: str | None = None
    last_applied_action: ScheduleAction | None = None
    last_active_slot_id: str | None = None
    last_error: str | None = None
    appliance_memories: dict[str, ApplianceExecutionMemory] = field(
        default_factory=dict
    )
    execution_status: ScheduleExecutionStatus = field(
        default_factory=ScheduleExecutionStatus
    )


@dataclass(frozen=True)
class InverterExecutionResult:
    runtime: InverterRuntimeStatus
    error: ScheduleError | None = None


@dataclass(frozen=True)
class ModeEntityController:
    entity_id: str
    service_domain: str

    @classmethod
    def from_entity_id(cls, entity_id: str) -> ModeEntityController:
        domain, separator, object_id = entity_id.partition(".")
        if (
            not separator
            or not object_id
            or domain not in {"input_select", "select"}
        ):
            raise ScheduleExecutionUnavailableError(
                "Schedule mode entity must use the input_select or select domain"
            )
        return cls(entity_id=entity_id, service_domain=domain)

    def read_state(self, hass: HomeAssistant) -> Any:
        state = hass.states.get(self.entity_id)
        if state is None:
            raise ScheduleExecutionUnavailableError(
                f"Schedule mode entity '{self.entity_id}' is not available"
            )

        raw_state = getattr(state, "state", None)
        if (
            not isinstance(raw_state, str)
            or not raw_state.strip()
            or raw_state.strip().lower() in _UNAVAILABLE_STATES
        ):
            raise ScheduleExecutionUnavailableError(
                f"Schedule mode entity '{self.entity_id}' is unavailable"
            )
        return state

    @staticmethod
    def read_available_options(state: Any) -> list[str]:
        raw_attributes = getattr(state, "attributes", {})
        if not isinstance(raw_attributes, Mapping):
            raise ScheduleExecutionUnavailableError(
                "Schedule mode entity options are unavailable"
            )

        raw_options = raw_attributes.get("options")
        if not isinstance(raw_options, (list, tuple)) or not raw_options:
            raise ScheduleExecutionUnavailableError(
                "Schedule mode entity options are unavailable"
            )

        options = [
            option
            for option in raw_options
            if isinstance(option, str) and option.strip()
        ]
        if len(options) != len(raw_options):
            raise ScheduleExecutionUnavailableError(
                "Schedule mode entity options must be non-empty strings"
            )
        return options

    def validate_option(self, state: Any, option: str) -> None:
        if option not in self.read_available_options(state):
            raise ScheduleExecutionUnavailableError(
                f"Schedule mode option '{option}' is not available on "
                f"'{self.entity_id}'"
            )

    async def async_select_option(
        self,
        hass: HomeAssistant,
        *,
        option: str,
    ) -> None:
        try:
            await hass.services.async_call(
                self.service_domain,
                "select_option",
                {"entity_id": self.entity_id, "option": option},
                blocking=True,
            )
        except Exception as err:
            raise ScheduleExecutionUnavailableError(
                f"Failed to apply schedule mode option '{option}' to "
                f"'{self.entity_id}'"
            ) from err


class InverterExecutor:
    def __init__(self, hass: HomeAssistant, runtime: ScheduleExecutionRuntime) -> None:
        self._hass = hass
        self._runtime = runtime

    def validate_control_entity(
        self,
        *,
        control_config: ScheduleControlConfig,
    ) -> tuple[ModeEntityController, Any]:
        controller = ModeEntityController.from_entity_id(control_config.mode_entity_id)
        state = controller.read_state(self._hass)
        controller.validate_option(state, control_config.normal_option)
        controller.validate_option(state, control_config.stop_charging_option)
        controller.validate_option(state, control_config.stop_discharging_option)
        return controller, state

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
            )
        except ScheduleError as err:
            fallback_reason = "scheduled"
            fallback_action = action
            if "resolution" in locals():
                fallback_reason = resolution.reason
                fallback_action = resolution.executed_action
            return InverterExecutionResult(
                runtime=InverterRuntimeStatus(
                    action_kind="apply",
                    outcome="failed",
                    executed_action=fallback_action,
                    reason=fallback_reason,
                    error_code=err.code,
                ),
                error=err,
            )

        return InverterExecutionResult(
            runtime=InverterRuntimeStatus(
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
        )

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
        if action.kind == SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC:
            if control_config.charge_to_target_soc_option is None:
                raise ScheduleNotConfiguredError(
                    "Schedule control config is missing the charge_to_target_soc action option"
                )
            return control_config.charge_to_target_soc_option
        if action.kind == SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC:
            if control_config.discharge_to_target_soc_option is None:
                raise ScheduleNotConfiguredError(
                    "Schedule control config is missing the discharge_to_target_soc action option"
                )
            return control_config.discharge_to_target_soc_option
        if action.kind == SCHEDULE_ACTION_STOP_CHARGING:
            return control_config.stop_charging_option
        if action.kind == SCHEDULE_ACTION_STOP_DISCHARGING:
            return control_config.stop_discharging_option
        return control_config.normal_option

    async def _async_apply_action(
        self,
        *,
        controller: ModeEntityController,
        state: Any,
        control_config: ScheduleControlConfig,
        action: ScheduleAction,
        active_slot_id: str | None,
    ) -> None:
        desired_option = self._resolve_option_for_action(
            control_config=control_config,
            action=action,
        )
        controller.validate_option(state, desired_option)

        current_option = getattr(state, "state", None)
        if current_option != desired_option:
            await controller.async_select_option(self._hass, option=desired_option)

        self._runtime.last_applied_entity_id = control_config.mode_entity_id
        self._runtime.last_applied_option = desired_option
        self._runtime.last_applied_action = action
        self._runtime.last_active_slot_id = active_slot_id


class ScheduleExecutor:
    def __init__(
        self,
        hass: HomeAssistant,
        dependencies: ScheduleExecutorDependencies,
    ) -> None:
        self._hass = hass
        self._dependencies = dependencies
        self._runtime = ScheduleExecutionRuntime()
        self._inverter_executor = InverterExecutor(hass, self._runtime)
        self._appliances_executor = AppliancesExecutor(hass)
        self._unsub_interval: Callable[[], None] | None = None
        self._reconcile_tasks: set[asyncio.Task[Any]] = set()
        self._stopped = True

    @property
    def runtime(self) -> ScheduleExecutionRuntime:
        return self._runtime

    def get_execution_status(self) -> ScheduleExecutionStatus:
        return self._runtime.execution_status

    def reset_runtime(self) -> None:
        self._runtime = ScheduleExecutionRuntime()
        self._inverter_executor = InverterExecutor(self._hass, self._runtime)

    async def async_start(self) -> None:
        self._stopped = False
        if self._unsub_interval is not None:
            return

        @callback
        def _handle_interval_tick(now: datetime) -> None:
            if self._stopped:
                return
            task = self._hass.async_create_task(
                self.async_reconcile_safely(
                    reason="interval",
                    reference_time=now,
                )
            )
            self._reconcile_tasks.add(task)
            task.add_done_callback(self._reconcile_tasks.discard)

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

        tasks = tuple(self._reconcile_tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._reconcile_tasks.clear()

        self.reset_runtime()

    async def async_unload(self) -> None:
        await self.async_stop()

    async def async_reconcile(
        self,
        *,
        reason: str,
        reference_time: datetime | None = None,
    ) -> None:
        del reason

        request_now = reference_time or dt_util.now()
        async with self._dependencies.schedule_lock:
            schedule_document = await self._load_pruned_schedule_document_locked(
                reference_time=request_now
            )
            if not schedule_document.execution_enabled:
                self.reset_runtime()
                return

            current_slot_id = format_slot_id(build_horizon_start(request_now))
            active_slot = find_active_slot(
                stored_slots=schedule_document.slots,
                reference_time=request_now,
            )
            active_action = (
                NORMAL_SCHEDULE_ACTION if active_slot is None else active_slot.domains.inverter
            )
            active_actions = {} if active_slot is None else dict(active_slot.domains.appliances)

            control_config = self._dependencies.read_schedule_control_config()
            inverter_runtime: InverterRuntimeStatus | None = None
            first_error: ScheduleError | None = None
            if control_config is None:
                inverter_runtime = InverterRuntimeStatus(
                    action_kind="apply",
                    outcome="failed",
                    executed_action=active_action,
                    reason="scheduled",
                    error_code="not_configured",
                )
                first_error = ScheduleNotConfiguredError(
                    "Schedule control config is required to execute the schedule"
                )
            else:
                inverter_result = await self._inverter_executor.async_execute(
                    control_config=control_config,
                    action=active_action,
                    active_slot_id=current_slot_id,
                    reference_time=request_now,
                    read_battery_state=self._dependencies.read_battery_state,
                )
                inverter_runtime = inverter_result.runtime
                if inverter_result.error is not None:
                    first_error = inverter_result.error

            appliance_result = await self._appliances_executor.async_execute(
                registry=self._dependencies.read_appliances_registry(),
                active_slot_id=current_slot_id,
                active_actions=active_actions,
                previous_memories=self._runtime.appliance_memories,
                reference_time=request_now,
            )
            if first_error is None:
                first_error = appliance_result.first_error

            self._runtime.appliance_memories = appliance_result.memories
            self._runtime.execution_status = ScheduleExecutionStatus(
                active_slot_id=current_slot_id,
                active_slot_runtime=ActiveSlotRuntimeStatus(
                    inverter=inverter_runtime,
                    appliances=appliance_result.runtimes,
                    reconciled_at=self._format_reconciled_at(request_now),
                ),
            )
            if first_error is not None:
                raise first_error

            self._runtime.last_error = None

    async def async_reconcile_safely(
        self,
        *,
        reason: str,
        reference_time: datetime | None = None,
    ) -> None:
        try:
            await self.async_reconcile(
                reason=reason,
                reference_time=reference_time,
            )
        except ScheduleError as err:
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

        async with self._dependencies.schedule_lock:
            reference_time = dt_util.now()
            schedule_document = await self._load_pruned_schedule_document_locked(
                reference_time=reference_time
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
            active_actions = {} if active_slot is None else dict(active_slot.domains.appliances)

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
            self._runtime.execution_status = ScheduleExecutionStatus(
                active_slot_id=None,
                active_slot_runtime=None,
            )
            self._runtime.appliance_memories = {}
            self._runtime.last_error = None

    def clear_appliance_memories(self) -> None:
        self._runtime.appliance_memories = {}

    async def _load_pruned_schedule_document_locked(
        self,
        *,
        reference_time: datetime,
    ) -> ScheduleDocument:
        schedule_document = self._dependencies.load_schedule_document()
        pruned_slots = prune_expired_slots(
            stored_slots=schedule_document.slots,
            reference_time=reference_time,
        )
        pruned_document = ScheduleDocument(
            execution_enabled=schedule_document.execution_enabled,
            slots=pruned_slots,
        )
        if pruned_document != schedule_document:
            await self._dependencies.save_schedule_document(pruned_document)
        return pruned_document

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
