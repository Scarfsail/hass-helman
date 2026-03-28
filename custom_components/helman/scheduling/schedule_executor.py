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
from .runtime_status import (
    ActiveSlotRuntimeStatus,
    ScheduleExecutionStatus,
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


@dataclass
class ScheduleExecutionRuntime:
    last_applied_entity_id: str | None = None
    last_applied_option: str | None = None
    last_applied_action: ScheduleAction | None = None
    last_active_slot_id: str | None = None
    last_error: str | None = None
    execution_status: ScheduleExecutionStatus = field(
        default_factory=ScheduleExecutionStatus
    )


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


class ScheduleExecutor:
    def __init__(
        self,
        hass: HomeAssistant,
        dependencies: ScheduleExecutorDependencies,
    ) -> None:
        self._hass = hass
        self._dependencies = dependencies
        self._runtime = ScheduleExecutionRuntime()
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

            execution_status: ScheduleExecutionStatus | None = None
            try:
                control_config = self._dependencies.read_schedule_control_config()
                if control_config is None:
                    raise ScheduleNotConfiguredError(
                        "Schedule control config is required to execute the schedule"
                    )

                controller, state = self.validate_control_entity(
                    control_config=control_config
                )
                execution_status = self.describe_execution_status(
                    schedule_document=schedule_document,
                    reference_time=request_now,
                )
                await self._async_apply_action_locked(
                    controller=controller,
                    state=state,
                    control_config=control_config,
                    action=execution_status.active_slot_runtime.executed_action,
                    active_slot_id=execution_status.active_slot_id,
                )
            except ScheduleError as err:
                self._runtime.execution_status = self._build_error_execution_status(
                    schedule_document=schedule_document,
                    reference_time=request_now,
                    error=err,
                    execution_status=execution_status,
                )
                raise

            self._runtime.execution_status = execution_status

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

            _LOGGER.warning(
                "Schedule execution reconcile failed during %s: %s",
                reason,
                err,
            )
            self._runtime.last_error = error_key

    async def async_restore_normal(self, *, reason: str) -> None:
        del reason

        async with self._dependencies.schedule_lock:
            await self._load_pruned_schedule_document_locked(
                reference_time=dt_util.now()
            )

            control_config = self._dependencies.read_schedule_control_config()
            if control_config is None:
                raise ScheduleNotConfiguredError(
                    "Schedule control config is required to restore normal mode"
                )

            controller, state = self.validate_control_entity(
                control_config=control_config
            )
            await self._async_apply_action_locked(
                controller=controller,
                state=state,
                control_config=control_config,
                action=NORMAL_SCHEDULE_ACTION,
                active_slot_id=None,
            )

    def validate_control_entity(
        self,
        *,
        control_config: ScheduleControlConfig,
    ) -> tuple[ModeEntityController, Any]:
        controller = ModeEntityController.from_entity_id(
            control_config.mode_entity_id
        )
        state = controller.read_state(self._hass)
        controller.validate_option(state, control_config.normal_option)
        controller.validate_option(state, control_config.stop_charging_option)
        controller.validate_option(state, control_config.stop_discharging_option)
        return controller, state

    def describe_execution_status(
        self,
        *,
        schedule_document: ScheduleDocument,
        reference_time: datetime,
    ) -> ScheduleExecutionStatus:
        if not schedule_document.execution_enabled:
            return ScheduleExecutionStatus()

        current_slot_id = format_slot_id(build_horizon_start(reference_time))
        active_slot = find_active_slot(
            stored_slots=schedule_document.slots,
            reference_time=reference_time,
        )
        if active_slot is None:
            return ScheduleExecutionStatus(
                active_slot_id=current_slot_id,
                active_slot_runtime=ActiveSlotRuntimeStatus(
                    status="applied",
                    executed_action=NORMAL_SCHEDULE_ACTION,
                    reason="scheduled",
                ),
            )

        return ScheduleExecutionStatus(
            active_slot_id=current_slot_id,
            active_slot_runtime=self._describe_active_slot_runtime(slot=active_slot),
        )

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

    def _describe_active_slot_runtime(
        self,
        *,
        slot,
    ) -> ActiveSlotRuntimeStatus:
        battery_state = None
        if slot.action.kind in {
            SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
            SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
        }:
            battery_state = self._dependencies.read_battery_state()
        resolution = resolve_executed_schedule_action(
            action=slot.action,
            current_soc=None if battery_state is None else battery_state.current_soc,
        )
        return ActiveSlotRuntimeStatus(
            status="applied",
            executed_action=resolution.executed_action,
            reason=resolution.reason,
        )

    def _build_error_execution_status(
        self,
        *,
        schedule_document: ScheduleDocument,
        reference_time: datetime,
        error: ScheduleError,
        execution_status: ScheduleExecutionStatus | None,
    ) -> ScheduleExecutionStatus:
        if not schedule_document.execution_enabled:
            return ScheduleExecutionStatus()

        if (
            execution_status is not None
            and execution_status.active_slot_id is not None
            and execution_status.active_slot_runtime is not None
        ):
            return ScheduleExecutionStatus(
                active_slot_id=execution_status.active_slot_id,
                active_slot_runtime=ActiveSlotRuntimeStatus(
                    status="error",
                    executed_action=execution_status.active_slot_runtime.executed_action,
                    reason=execution_status.active_slot_runtime.reason,
                    error_code=error.code,
                ),
            )

        return ScheduleExecutionStatus(
            active_slot_id=format_slot_id(build_horizon_start(reference_time)),
            active_slot_runtime=ActiveSlotRuntimeStatus(
                status="error",
                error_code=error.code,
            ),
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

    async def _async_apply_action_locked(
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
            await controller.async_select_option(
                self._hass,
                option=desired_option,
            )

        self._runtime.last_applied_entity_id = control_config.mode_entity_id
        self._runtime.last_applied_option = desired_option
        self._runtime.last_applied_action = action
        self._runtime.last_active_slot_id = active_slot_id
        self._runtime.last_error = None
