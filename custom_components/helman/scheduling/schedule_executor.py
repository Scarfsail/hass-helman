from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Awaitable, Callable

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.util import dt as dt_util

from ..const import (
    SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_NORMAL,
    SCHEDULE_ACTION_STOP_CHARGING,
    SCHEDULE_ACTION_STOP_DISCHARGING,
    SCHEDULE_EXECUTOR_INTERVAL_SECONDS,
)
from .schedule import (
    NORMAL_SCHEDULE_ACTION,
    ScheduleAction,
    ScheduleControlConfig,
    ScheduleDocument,
    ScheduleError,
    ScheduleExecutionUnavailableError,
    ScheduleNotConfiguredError,
    ScheduleSlot,
    find_active_slot,
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


@dataclass
class ScheduleExecutionRuntime:
    last_applied_entity_id: str | None = None
    last_applied_option: str | None = None
    last_applied_action: ScheduleAction | None = None
    last_active_slot_id: str | None = None
    last_error: str | None = None
    last_warning_key: str | None = None


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

            control_config = self._dependencies.read_schedule_control_config()
            if control_config is None:
                raise ScheduleNotConfiguredError(
                    "Schedule control config is required to execute the schedule"
                )

            controller, state = self.validate_control_entity(
                control_config=control_config
            )
            active_slot_id, action = self._coerce_slice2_runtime_action(
                find_active_slot(
                    stored_slots=schedule_document.slots,
                    reference_time=request_now,
                )
            )
            await self._async_apply_action_locked(
                controller=controller,
                state=state,
                control_config=control_config,
                action=action,
                active_slot_id=active_slot_id,
            )

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

    def _coerce_slice2_runtime_action(
        self,
        slot: ScheduleSlot | None,
    ) -> tuple[str | None, ScheduleAction]:
        if slot is None:
            self._runtime.last_warning_key = None
            return None, NORMAL_SCHEDULE_ACTION

        if slot.action.kind in {
            SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
            SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
        }:
            warning_key = f"{slot.id}:{slot.action.kind}:{slot.action.target_soc}"
            if self._runtime.last_warning_key != warning_key:
                _LOGGER.warning(
                    "Schedule slot '%s' uses unsupported slice-2 action '%s'; "
                    "applying normal until target-action execution is implemented",
                    slot.id,
                    slot.action.kind,
                )
                self._runtime.last_warning_key = warning_key
            return slot.id, NORMAL_SCHEDULE_ACTION

        self._runtime.last_warning_key = None
        return slot.id, slot.action

    @staticmethod
    def _resolve_option_for_action(
        *,
        control_config: ScheduleControlConfig,
        action: ScheduleAction,
    ) -> str:
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
