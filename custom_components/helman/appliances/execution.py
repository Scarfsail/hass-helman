from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from ..scheduling.runtime_status import (
    ApplianceRuntimeStatus,
    RuntimeActionKind,
    RuntimeOutcome,
)
from ..scheduling.schedule import ScheduleError, ScheduleExecutionUnavailableError
from .ev_charger import EvChargerApplianceRuntime
from .ev_schedule import EvChargerScheduleActionDict
from .generic_appliance import GenericApplianceRuntime
from .generic_schedule import GenericApplianceScheduleActionDict
from .schedule import ApplianceScheduleActionDict
from .state import AppliancesRuntimeRegistry

_UNAVAILABLE_STATES = {"unknown", "unavailable", "none"}
_CHARGE_POLL_INTERVAL_SECONDS = 1.0


@dataclass(frozen=True)
class ApplianceExecutionMemory:
    last_active_slot_id: str
    last_action_signature: tuple[object, ...] | None
    last_enabled: bool
    last_runtime_action_kind: str | None = None


@dataclass(frozen=True)
class AppliancesExecutionResult:
    runtimes: dict[str, ApplianceRuntimeStatus]
    memories: dict[str, ApplianceExecutionMemory]
    first_error: ScheduleError | None = None


class SwitchEntityController:
    def __init__(self, entity_id: str, *, description: str) -> None:
        domain, separator, object_id = entity_id.partition(".")
        if not separator or not object_id or domain != "switch":
            raise ScheduleExecutionUnavailableError(
                f"{description} must use the switch domain"
            )
        self.entity_id = entity_id
        self._description = description

    def read_state(self, hass: HomeAssistant) -> Any:
        state = hass.states.get(self.entity_id)
        if state is None:
            raise ScheduleExecutionUnavailableError(
                f"{self._description} '{self.entity_id}' is not available"
            )

        raw_state = getattr(state, "state", None)
        if (
            not isinstance(raw_state, str)
            or not raw_state.strip()
            or raw_state.strip().lower() in _UNAVAILABLE_STATES
        ):
            raise ScheduleExecutionUnavailableError(
                f"{self._description} '{self.entity_id}' is unavailable"
            )
        return state

    @staticmethod
    def is_on(state: Any) -> bool:
        return getattr(state, "state", None) == "on"

    async def async_turn_on(self, hass: HomeAssistant) -> None:
        try:
            await hass.services.async_call(
                "switch",
                "turn_on",
                {"entity_id": self.entity_id},
                blocking=True,
            )
        except Exception as err:
            raise ScheduleExecutionUnavailableError(
                f"Failed to turn on {self._description.lower()} '{self.entity_id}'"
            ) from err

    async def async_turn_off(self, hass: HomeAssistant) -> None:
        try:
            await hass.services.async_call(
                "switch",
                "turn_off",
                {"entity_id": self.entity_id},
                blocking=True,
            )
        except Exception as err:
            raise ScheduleExecutionUnavailableError(
                f"Failed to turn off {self._description.lower()} '{self.entity_id}'"
            ) from err


class SelectEntityController:
    def __init__(self, entity_id: str) -> None:
        domain, separator, object_id = entity_id.partition(".")
        if (
            not separator
            or not object_id
            or domain not in {"input_select", "select"}
        ):
            raise ScheduleExecutionUnavailableError(
                "EV select entity must use the input_select or select domain"
            )
        self.entity_id = entity_id
        self.service_domain = domain

    def read_state(self, hass: HomeAssistant) -> Any:
        state = hass.states.get(self.entity_id)
        if state is None:
            raise ScheduleExecutionUnavailableError(
                f"EV select entity '{self.entity_id}' is not available"
            )

        raw_state = getattr(state, "state", None)
        if (
            not isinstance(raw_state, str)
            or not raw_state.strip()
            or raw_state.strip().lower() in _UNAVAILABLE_STATES
        ):
            raise ScheduleExecutionUnavailableError(
                f"EV select entity '{self.entity_id}' is unavailable"
            )
        return state

    @staticmethod
    def read_available_options(state: Any) -> list[str]:
        raw_attributes = getattr(state, "attributes", {})
        if not isinstance(raw_attributes, Mapping):
            raise ScheduleExecutionUnavailableError(
                "EV select entity options are unavailable"
            )

        raw_options = raw_attributes.get("options")
        if not isinstance(raw_options, (list, tuple)) or not raw_options:
            raise ScheduleExecutionUnavailableError(
                "EV select entity options are unavailable"
            )

        options = [
            option
            for option in raw_options
            if isinstance(option, str) and option.strip()
        ]
        if len(options) != len(raw_options):
            raise ScheduleExecutionUnavailableError(
                "EV select entity options must be non-empty strings"
            )
        return options

    def validate_option(self, state: Any, option: str) -> None:
        if option not in self.read_available_options(state):
            raise ScheduleExecutionUnavailableError(
                f"EV select option '{option}' is not available on '{self.entity_id}'"
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
                f"Failed to apply EV select option '{option}' to '{self.entity_id}'"
            ) from err


class EvChargerExecutor:
    def __init__(
        self,
        hass: HomeAssistant,
        *,
        charge_on_wait_seconds: float = 30.0,
        poll_interval_seconds: float = _CHARGE_POLL_INTERVAL_SECONDS,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._hass = hass
        self._charge_on_wait_seconds = charge_on_wait_seconds
        self._poll_interval_seconds = poll_interval_seconds
        self._sleep = sleep

    async def async_execute(
        self,
        *,
        appliance: EvChargerApplianceRuntime,
        action: EvChargerScheduleActionDict | None,
        memory: ApplianceExecutionMemory | None,
        active_slot_id: str,
        reference_time: datetime,
    ) -> tuple[ApplianceRuntimeStatus | None, ApplianceExecutionMemory | None]:
        if action is None:
            if memory is None or not memory.last_enabled:
                return None, None
            if (
                memory.last_active_slot_id == active_slot_id
                and memory.last_runtime_action_kind == "slot_stop"
            ):
                runtime = _build_runtime_status(
                    action_kind="slot_stop",
                    outcome="success",
                    reference_time=reference_time,
                )
                return runtime, memory
            runtime = await self._async_stop_charge_only(
                appliance=appliance,
                action_kind="slot_stop",
                reference_time=reference_time,
            )
            return (
                runtime,
                ApplianceExecutionMemory(
                    last_active_slot_id=active_slot_id,
                    last_action_signature=None,
                    last_enabled=False,
                    last_runtime_action_kind="slot_stop",
                ),
            )

        signature = self._signature_for_action(action)
        if (
            memory is not None
            and memory.last_active_slot_id == active_slot_id
            and memory.last_action_signature == signature
        ):
            return (
                _build_runtime_status(
                    action_kind="noop",
                    outcome="skipped",
                    reference_time=reference_time,
                ),
                ApplianceExecutionMemory(
                    last_active_slot_id=active_slot_id,
                    last_action_signature=signature,
                    last_enabled=bool(action["charge"]),
                    last_runtime_action_kind="noop",
                ),
            )

        runtime = await self._async_apply_action(
            appliance=appliance,
            action=action,
            reference_time=reference_time,
        )
        return (
            runtime,
            ApplianceExecutionMemory(
                last_active_slot_id=active_slot_id,
                last_action_signature=signature,
                last_enabled=bool(action["charge"]),
                last_runtime_action_kind="apply",
            ),
        )

    async def async_disable_active_action(
        self,
        *,
        appliance: EvChargerApplianceRuntime,
        action: EvChargerScheduleActionDict | None,
        reference_time: datetime,
    ) -> ApplianceRuntimeStatus | None:
        if action is None or not bool(action["charge"]):
            return None
        return await self._async_stop_charge_only(
            appliance=appliance,
            action_kind="slot_stop",
            reference_time=reference_time,
        )

    async def _async_apply_action(
        self,
        *,
        appliance: EvChargerApplianceRuntime,
        action: EvChargerScheduleActionDict,
        reference_time: datetime,
    ) -> ApplianceRuntimeStatus:
        if not bool(action["charge"]):
            return await self._async_stop_charge_only(
                appliance=appliance,
                action_kind="apply",
                reference_time=reference_time,
            )

        try:
            switch_controller = SwitchEntityController(
                appliance.charge_entity_id,
                description="EV charge entity",
            )
            charge_state = switch_controller.read_state(self._hass)
            if not switch_controller.is_on(charge_state):
                await switch_controller.async_turn_on(self._hass)
                await self._async_wait_until_charge_on(
                    switch_controller=switch_controller
                )

            use_mode = action.get("useMode")
            if use_mode is not None:
                mode_controller = SelectEntityController(appliance.use_mode_entity_id)
                mode_state = mode_controller.read_state(self._hass)
                mode_controller.validate_option(mode_state, use_mode)
                if getattr(mode_state, "state", None) != use_mode:
                    await mode_controller.async_select_option(
                        self._hass,
                        option=use_mode,
                    )

            eco_gear = action.get("ecoGear")
            if eco_gear is not None:
                eco_controller = SelectEntityController(appliance.eco_gear_entity_id)
                eco_state = eco_controller.read_state(self._hass)
                eco_controller.validate_option(eco_state, eco_gear)
                if getattr(eco_state, "state", None) != eco_gear:
                    await eco_controller.async_select_option(
                        self._hass,
                        option=eco_gear,
                    )
        except ScheduleError as err:
            return _build_runtime_status(
                action_kind="apply",
                outcome="failed",
                error=err,
                reference_time=reference_time,
            )

        return _build_runtime_status(
            action_kind="apply",
            outcome="success",
            reference_time=reference_time,
        )

    async def _async_stop_charge_only(
        self,
        *,
        appliance: EvChargerApplianceRuntime,
        action_kind: RuntimeActionKind,
        reference_time: datetime,
    ) -> ApplianceRuntimeStatus:
        try:
            switch_controller = SwitchEntityController(
                appliance.charge_entity_id,
                description="EV charge entity",
            )
            charge_state = switch_controller.read_state(self._hass)
            if switch_controller.is_on(charge_state):
                await switch_controller.async_turn_off(self._hass)
        except ScheduleError as err:
            return _build_runtime_status(
                action_kind=action_kind,
                outcome="failed",
                error=err,
                reference_time=reference_time,
            )

        return _build_runtime_status(
            action_kind=action_kind,
            outcome="success",
            reference_time=reference_time,
        )

    async def _async_wait_until_charge_on(
        self,
        *,
        switch_controller: SwitchEntityController,
    ) -> None:
        state = switch_controller.read_state(self._hass)
        if switch_controller.is_on(state):
            return

        deadline = asyncio.get_running_loop().time() + self._charge_on_wait_seconds
        while asyncio.get_running_loop().time() < deadline:
            await self._sleep(self._poll_interval_seconds)
            state = switch_controller.read_state(self._hass)
            if switch_controller.is_on(state):
                return

        raise ScheduleExecutionUnavailableError(
            f"Timed out waiting for EV charge entity '{switch_controller.entity_id}' "
            f"to turn on within {int(self._charge_on_wait_seconds)} seconds"
        )

    @staticmethod
    def _signature_for_action(
        action: EvChargerScheduleActionDict,
    ) -> tuple[object, ...]:
        return (
            bool(action["charge"]),
            action.get("vehicleId"),
            action.get("useMode"),
            action.get("ecoGear"),
        )


class GenericApplianceExecutor:
    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    async def async_execute(
        self,
        *,
        appliance: GenericApplianceRuntime,
        action: GenericApplianceScheduleActionDict | None,
        memory: ApplianceExecutionMemory | None,
        active_slot_id: str,
        reference_time: datetime,
    ) -> tuple[ApplianceRuntimeStatus | None, ApplianceExecutionMemory | None]:
        if action is None:
            if memory is None or not memory.last_enabled:
                return None, None
            if (
                memory.last_active_slot_id == active_slot_id
                and memory.last_runtime_action_kind == "slot_stop"
            ):
                runtime = _build_runtime_status(
                    action_kind="slot_stop",
                    outcome="success",
                    reference_time=reference_time,
                )
                return runtime, memory
            runtime = await self._async_apply_enabled_state(
                appliance=appliance,
                enabled=False,
                action_kind="slot_stop",
                reference_time=reference_time,
            )
            if runtime.outcome != "success":
                return runtime, memory
            return (
                runtime,
                ApplianceExecutionMemory(
                    last_active_slot_id=active_slot_id,
                    last_action_signature=None,
                    last_enabled=False,
                    last_runtime_action_kind="slot_stop",
                ),
            )

        signature = self._signature_for_action(action)
        if (
            memory is not None
            and memory.last_active_slot_id == active_slot_id
            and memory.last_action_signature == signature
        ):
            enabled = bool(action["on"])
            return (
                _build_runtime_status(
                    action_kind="noop",
                    outcome="skipped",
                    reference_time=reference_time,
                ),
                ApplianceExecutionMemory(
                    last_active_slot_id=active_slot_id,
                    last_action_signature=signature,
                    last_enabled=enabled,
                    last_runtime_action_kind="noop",
                ),
            )

        enabled = bool(action["on"])
        runtime = await self._async_apply_enabled_state(
            appliance=appliance,
            enabled=enabled,
            action_kind="apply",
            reference_time=reference_time,
        )
        if runtime.outcome != "success":
            return runtime, memory
        return (
            runtime,
            ApplianceExecutionMemory(
                last_active_slot_id=active_slot_id,
                last_action_signature=signature,
                last_enabled=enabled,
                last_runtime_action_kind="apply",
            ),
        )

    async def async_disable_active_action(
        self,
        *,
        appliance: GenericApplianceRuntime,
        action: GenericApplianceScheduleActionDict | None,
        reference_time: datetime,
    ) -> ApplianceRuntimeStatus | None:
        if action is None or not bool(action["on"]):
            return None
        return await self._async_apply_enabled_state(
            appliance=appliance,
            enabled=False,
            action_kind="slot_stop",
            reference_time=reference_time,
        )

    async def _async_apply_enabled_state(
        self,
        *,
        appliance: GenericApplianceRuntime,
        enabled: bool,
        action_kind: RuntimeActionKind,
        reference_time: datetime,
    ) -> ApplianceRuntimeStatus:
        try:
            switch_controller = SwitchEntityController(
                appliance.switch_entity_id,
                description="Appliance switch entity",
            )
            switch_state = switch_controller.read_state(self._hass)
            if enabled and not switch_controller.is_on(switch_state):
                await switch_controller.async_turn_on(self._hass)
            if not enabled and switch_controller.is_on(switch_state):
                await switch_controller.async_turn_off(self._hass)
        except ScheduleError as err:
            return _build_runtime_status(
                action_kind=action_kind,
                outcome="failed",
                error=err,
                reference_time=reference_time,
            )

        return _build_runtime_status(
            action_kind=action_kind,
            outcome="success",
            reference_time=reference_time,
        )

    @staticmethod
    def _signature_for_action(
        action: GenericApplianceScheduleActionDict,
    ) -> tuple[object, ...]:
        return (bool(action["on"]),)


def _build_runtime_status(
    *,
    action_kind: RuntimeActionKind,
    outcome: RuntimeOutcome,
    reference_time: datetime,
    error: ScheduleError | None = None,
) -> ApplianceRuntimeStatus:
    return ApplianceRuntimeStatus(
        action_kind=action_kind,
        outcome=outcome,
        error_code=None if error is None else error.code,
        message=None if error is None else str(error),
        updated_at=dt_util.as_local(reference_time).isoformat(timespec="seconds"),
    )


class AppliancesExecutor:
    def __init__(
        self,
        hass: HomeAssistant,
        *,
        charge_on_wait_seconds: float = 30.0,
        poll_interval_seconds: float = _CHARGE_POLL_INTERVAL_SECONDS,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._ev_executor = EvChargerExecutor(
            hass,
            charge_on_wait_seconds=charge_on_wait_seconds,
            poll_interval_seconds=poll_interval_seconds,
            sleep=sleep,
        )
        self._generic_executor = GenericApplianceExecutor(hass)

    async def async_execute(
        self,
        *,
        registry: AppliancesRuntimeRegistry,
        active_slot_id: str,
        active_actions: Mapping[str, ApplianceScheduleActionDict],
        previous_memories: Mapping[str, ApplianceExecutionMemory],
        reference_time: datetime,
    ) -> AppliancesExecutionResult:
        runtimes: dict[str, ApplianceRuntimeStatus] = {}
        memories: dict[str, ApplianceExecutionMemory] = {}
        first_error: ScheduleError | None = None

        for appliance in registry.appliances:
            runtime, memory = await self._async_execute_for_appliance(
                appliance=appliance,
                action=active_actions.get(appliance.id),
                memory=previous_memories.get(appliance.id),
                active_slot_id=active_slot_id,
                reference_time=reference_time,
            )
            if runtime is not None:
                runtimes[appliance.id] = runtime
                if runtime.outcome == "failed" and first_error is None:
                    first_error = ScheduleExecutionUnavailableError(
                        runtime.message or f"Appliance {appliance.id!r} execution failed"
                    )
            if memory is not None:
                memories[appliance.id] = memory

        return AppliancesExecutionResult(
            runtimes=runtimes,
            memories=memories,
            first_error=first_error,
        )

    async def async_restore_active_slot(
        self,
        *,
        registry: AppliancesRuntimeRegistry,
        active_actions: Mapping[str, ApplianceScheduleActionDict],
        reference_time: datetime,
    ) -> AppliancesExecutionResult:
        runtimes: dict[str, ApplianceRuntimeStatus] = {}
        first_error: ScheduleError | None = None

        for appliance in registry.appliances:
            runtime = await self._async_disable_appliance_action(
                appliance=appliance,
                action=active_actions.get(appliance.id),
                reference_time=reference_time,
            )
            if runtime is None:
                continue
            runtimes[appliance.id] = runtime
            if runtime.outcome == "failed" and first_error is None:
                first_error = ScheduleExecutionUnavailableError(
                    runtime.message or f"Appliance {appliance.id!r} restore failed"
                )

        return AppliancesExecutionResult(
            runtimes=runtimes,
            memories={},
            first_error=first_error,
        )

    async def _async_execute_for_appliance(
        self,
        *,
        appliance,
        action: ApplianceScheduleActionDict | None,
        memory: ApplianceExecutionMemory | None,
        active_slot_id: str,
        reference_time: datetime,
    ) -> tuple[ApplianceRuntimeStatus | None, ApplianceExecutionMemory | None]:
        if isinstance(appliance, EvChargerApplianceRuntime):
            return await self._ev_executor.async_execute(
                appliance=appliance,
                action=action,
                memory=memory,
                active_slot_id=active_slot_id,
                reference_time=reference_time,
            )
        if isinstance(appliance, GenericApplianceRuntime):
            return await self._generic_executor.async_execute(
                appliance=appliance,
                action=action,
                memory=memory,
                active_slot_id=active_slot_id,
                reference_time=reference_time,
            )
        raise TypeError(f"Unsupported appliance runtime {type(appliance)!r}")

    async def _async_disable_appliance_action(
        self,
        *,
        appliance,
        action: ApplianceScheduleActionDict | None,
        reference_time: datetime,
    ) -> ApplianceRuntimeStatus | None:
        if isinstance(appliance, EvChargerApplianceRuntime):
            return await self._ev_executor.async_disable_active_action(
                appliance=appliance,
                action=action,
                reference_time=reference_time,
            )
        if isinstance(appliance, GenericApplianceRuntime):
            return await self._generic_executor.async_disable_active_action(
                appliance=appliance,
                action=action,
                reference_time=reference_time,
            )
        raise TypeError(f"Unsupported appliance runtime {type(appliance)!r}")
