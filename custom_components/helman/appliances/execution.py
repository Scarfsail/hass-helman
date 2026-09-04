from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from homeassistant.util import dt as dt_util

from ..scheduling.runtime_status import (
    ApplianceRuntimeStatus,
    RuntimeActionKind,
    RuntimeOutcome,
)
from ..scheduling.actuation import (
    ScheduleActuator,
    ScheduleExecutionDisabledError,
)
from ..controllables.controllers import SelectEntityController
from ..controllables.spec import (
    CONTROLLABLE_KIND_CLIMATE,
    CONTROLLABLE_KIND_EV_CHARGER,
    CONTROLLABLE_KIND_GENERIC,
    appliance_controllable_kinds,
)
from ..scheduling.schedule import ScheduleError, ScheduleExecutionUnavailableError
from .climate_appliance import ClimateApplianceRuntime
from .climate_schedule import ClimateApplianceScheduleActionDict
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

    def read_state(self, actuator: ScheduleActuator) -> Any:
        state = actuator.read_state(self.entity_id)
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

    async def async_turn_on(self, actuator: ScheduleActuator) -> None:
        try:
            await actuator.async_call(
                "switch",
                "turn_on",
                {"entity_id": self.entity_id},
            )
        except ScheduleExecutionDisabledError:
            raise
        except Exception as err:
            raise ScheduleExecutionUnavailableError(
                f"Failed to turn on {self._description.lower()} '{self.entity_id}'"
            ) from err

    async def async_turn_off(self, actuator: ScheduleActuator) -> None:
        try:
            await actuator.async_call(
                "switch",
                "turn_off",
                {"entity_id": self.entity_id},
            )
        except ScheduleExecutionDisabledError:
            raise
        except Exception as err:
            raise ScheduleExecutionUnavailableError(
                f"Failed to turn off {self._description.lower()} '{self.entity_id}'"
            ) from err


class ClimateEntityController:
    def __init__(self, entity_id: str) -> None:
        domain, separator, object_id = entity_id.partition(".")
        if not separator or not object_id or domain != "climate":
            raise ScheduleExecutionUnavailableError(
                "Climate entity must use the climate domain"
            )
        self.entity_id = entity_id

    def read_state(self, actuator: ScheduleActuator) -> Any:
        state = actuator.read_state(self.entity_id)
        if state is None:
            raise ScheduleExecutionUnavailableError(
                f"Climate entity '{self.entity_id}' is not available"
            )

        raw_state = getattr(state, "state", None)
        if (
            not isinstance(raw_state, str)
            or not raw_state.strip()
            or raw_state.strip().lower() in _UNAVAILABLE_STATES
        ):
            raise ScheduleExecutionUnavailableError(
                f"Climate entity '{self.entity_id}' is unavailable"
            )
        return state

    @staticmethod
    def read_available_hvac_modes(state: Any) -> list[str]:
        raw_attributes = getattr(state, "attributes", {})
        if not isinstance(raw_attributes, Mapping):
            raise ScheduleExecutionUnavailableError(
                "Climate HVAC modes are unavailable"
            )

        raw_modes = raw_attributes.get("hvac_modes")
        if not isinstance(raw_modes, (list, tuple)) or not raw_modes:
            raise ScheduleExecutionUnavailableError(
                "Climate HVAC modes are unavailable"
            )

        modes = [mode for mode in raw_modes if isinstance(mode, str) and mode.strip()]
        if len(modes) != len(raw_modes):
            raise ScheduleExecutionUnavailableError(
                "Climate HVAC modes must be non-empty strings"
            )
        return modes

    def validate_hvac_mode(self, state: Any, hvac_mode: str) -> None:
        if hvac_mode not in self.read_available_hvac_modes(state):
            raise ScheduleExecutionUnavailableError(
                f"Climate HVAC mode '{hvac_mode}' is not available on "
                f"'{self.entity_id}'"
            )

    async def async_set_hvac_mode(
        self,
        actuator: ScheduleActuator,
        *,
        hvac_mode: str,
    ) -> None:
        try:
            await actuator.async_call(
                "climate",
                "set_hvac_mode",
                {"entity_id": self.entity_id, "hvac_mode": hvac_mode},
            )
        except ScheduleExecutionDisabledError:
            raise
        except Exception as err:
            raise ScheduleExecutionUnavailableError(
                f"Failed to apply climate HVAC mode '{hvac_mode}' to "
                f"'{self.entity_id}'"
            ) from err


class ApplianceActionDriver(Protocol):
    """The per-kind half of appliance execution.

    Everything an appliance kind does differently lives behind these three
    methods; the slot-stop / signature / noop / apply decision sequence around
    them is written once, in :class:`ApplianceExecutor`.
    """

    def signature(self, action: Any) -> tuple[object, ...]:
        """What makes two actions the same action within one slot."""

    def is_enabled(self, appliance: Any, action: Any) -> bool:
        """Whether this action means the appliance is running."""

    async def async_apply(
        self,
        actuator: ScheduleActuator,
        *,
        appliance: Any,
        action: Any | None,
        action_kind: RuntimeActionKind,
        reference_time: datetime,
    ) -> ApplianceRuntimeStatus:
        """Drive the appliance; ``action is None`` means "go to rest"."""


class EvChargerDriver:
    def __init__(
        self,
        *,
        charge_on_wait_seconds: float = 30.0,
        poll_interval_seconds: float = _CHARGE_POLL_INTERVAL_SECONDS,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._charge_on_wait_seconds = charge_on_wait_seconds
        self._poll_interval_seconds = poll_interval_seconds
        self._sleep = sleep

    def signature(self, action: EvChargerScheduleActionDict) -> tuple[object, ...]:
        return (
            bool(action["charge"]),
            action.get("vehicleId"),
            action.get("useMode"),
            action.get("ecoGear"),
        )

    def is_enabled(
        self,
        appliance: EvChargerApplianceRuntime,
        action: EvChargerScheduleActionDict,
    ) -> bool:
        return bool(action["charge"])

    async def async_apply(
        self,
        actuator: ScheduleActuator,
        *,
        appliance: EvChargerApplianceRuntime,
        action: EvChargerScheduleActionDict | None,
        action_kind: RuntimeActionKind,
        reference_time: datetime,
    ) -> ApplianceRuntimeStatus:
        if action is None or not bool(action["charge"]):
            return await self._async_stop_charge_only(
                actuator,
                appliance=appliance,
                action_kind=action_kind,
                reference_time=reference_time,
            )

        try:
            switch_controller = SwitchEntityController(
                appliance.charge_entity_id,
                description="EV charge entity",
            )
            charge_state = switch_controller.read_state(actuator)
            if not switch_controller.is_on(charge_state):
                await switch_controller.async_turn_on(actuator)
                await self._async_wait_until_charge_on(
                    actuator,
                    switch_controller=switch_controller,
                )

            use_mode = action.get("useMode")
            if use_mode is not None:
                mode_controller = SelectEntityController(
                    appliance.use_mode_entity_id,
                    description="EV select",
                )
                mode_state = mode_controller.read_state(actuator)
                mode_controller.validate_option(mode_state, use_mode)
                if getattr(mode_state, "state", None) != use_mode:
                    await mode_controller.async_select_option(
                        actuator,
                        option=use_mode,
                    )

            eco_gear = action.get("ecoGear")
            if eco_gear is not None:
                eco_controller = SelectEntityController(
                    appliance.eco_gear_entity_id,
                    description="EV select",
                )
                eco_state = eco_controller.read_state(actuator)
                eco_controller.validate_option(eco_state, eco_gear)
                if getattr(eco_state, "state", None) != eco_gear:
                    await eco_controller.async_select_option(
                        actuator,
                        option=eco_gear,
                    )
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

    async def _async_stop_charge_only(
        self,
        actuator: ScheduleActuator,
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
            charge_state = switch_controller.read_state(actuator)
            if switch_controller.is_on(charge_state):
                await switch_controller.async_turn_off(actuator)
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
        actuator: ScheduleActuator,
        *,
        switch_controller: SwitchEntityController,
    ) -> None:
        state = switch_controller.read_state(actuator)
        if switch_controller.is_on(state):
            return

        deadline = asyncio.get_running_loop().time() + self._charge_on_wait_seconds
        while asyncio.get_running_loop().time() < deadline:
            await self._sleep(self._poll_interval_seconds)
            state = switch_controller.read_state(actuator)
            if switch_controller.is_on(state):
                return

        raise ScheduleExecutionUnavailableError(
            f"Timed out waiting for EV charge entity '{switch_controller.entity_id}' "
            f"to turn on within {int(self._charge_on_wait_seconds)} seconds"
        )


class GenericApplianceDriver:
    def signature(
        self,
        action: GenericApplianceScheduleActionDict,
    ) -> tuple[object, ...]:
        return (bool(action["on"]),)

    def is_enabled(
        self,
        appliance: GenericApplianceRuntime,
        action: GenericApplianceScheduleActionDict,
    ) -> bool:
        return bool(action["on"])

    async def async_apply(
        self,
        actuator: ScheduleActuator,
        *,
        appliance: GenericApplianceRuntime,
        action: GenericApplianceScheduleActionDict | None,
        action_kind: RuntimeActionKind,
        reference_time: datetime,
    ) -> ApplianceRuntimeStatus:
        enabled = action is not None and bool(action["on"])
        try:
            switch_controller = SwitchEntityController(
                appliance.switch_entity_id,
                description="Appliance switch entity",
            )
            switch_state = switch_controller.read_state(actuator)
            if enabled and not switch_controller.is_on(switch_state):
                await switch_controller.async_turn_on(actuator)
            if not enabled and switch_controller.is_on(switch_state):
                await switch_controller.async_turn_off(actuator)
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


class ClimateApplianceDriver:
    def signature(
        self,
        action: ClimateApplianceScheduleActionDict,
    ) -> tuple[object, ...]:
        return (action["mode"],)

    def is_enabled(
        self,
        appliance: ClimateApplianceRuntime,
        action: ClimateApplianceScheduleActionDict,
    ) -> bool:
        # Read straight off the appliance rather than through the controllable
        # registry: ``resting_state()`` substitutes "off" when stop_hvac_mode is
        # unset, which would quietly turn "cannot be stopped" into a success.
        return action["mode"] != appliance.stop_hvac_mode

    async def async_apply(
        self,
        actuator: ScheduleActuator,
        *,
        appliance: ClimateApplianceRuntime,
        action: ClimateApplianceScheduleActionDict | None,
        action_kind: RuntimeActionKind,
        reference_time: datetime,
    ) -> ApplianceRuntimeStatus:
        hvac_mode = appliance.stop_hvac_mode if action is None else action["mode"]
        if hvac_mode is None:
            return _build_runtime_status(
                action_kind=action_kind,
                outcome="failed",
                error=ScheduleExecutionUnavailableError(
                    f"Climate appliance {appliance.id!r} cannot be stopped because "
                    "HVAC mode 'off' is unavailable"
                ),
                reference_time=reference_time,
            )
        try:
            climate_controller = ClimateEntityController(appliance.climate_entity_id)
            climate_state = climate_controller.read_state(actuator)
            climate_controller.validate_hvac_mode(climate_state, hvac_mode)
            if getattr(climate_state, "state", None) != hvac_mode:
                await climate_controller.async_set_hvac_mode(
                    actuator,
                    hvac_mode=hvac_mode,
                )
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


class ApplianceExecutor:
    """The decision sequence every appliance kind shares.

    Slot stop, signature comparison, noop, apply, memory — written once, with
    the per-kind differences behind :class:`ApplianceActionDriver`. Memory is
    only advanced on a successful apply, so a failed actuation is retried on the
    next reconcile instead of being remembered as done.
    """

    def __init__(
        self,
        actuator: ScheduleActuator,
        driver: ApplianceActionDriver,
    ) -> None:
        self._actuator = actuator
        self._driver = driver

    async def async_execute(
        self,
        *,
        appliance: Any,
        action: ApplianceScheduleActionDict | None,
        last_scheduled_action: ApplianceScheduleActionDict | None,
        memory: ApplianceExecutionMemory | None,
        active_slot_id: str,
        reference_time: datetime,
    ) -> tuple[ApplianceRuntimeStatus | None, ApplianceExecutionMemory | None]:
        if action is None:
            if (
                memory is not None
                and memory.last_active_slot_id == active_slot_id
                and memory.last_runtime_action_kind == "slot_stop"
            ):
                return None, memory
            if memory is not None and not memory.last_enabled:
                return None, memory
            if memory is None and not (
                last_scheduled_action is not None
                and self._driver.is_enabled(appliance, last_scheduled_action)
            ):
                return None, None
            runtime = await self._driver.async_apply(
                self._actuator,
                appliance=appliance,
                action=None,
                action_kind="slot_stop",
                reference_time=reference_time,
            )
            if runtime.outcome != "success":
                return runtime, memory
            return (
                None,
                ApplianceExecutionMemory(
                    last_active_slot_id=active_slot_id,
                    last_action_signature=None,
                    last_enabled=False,
                    last_runtime_action_kind="slot_stop",
                ),
            )

        signature = self._driver.signature(action)
        enabled = self._driver.is_enabled(appliance, action)
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
                    last_enabled=enabled,
                    last_runtime_action_kind="noop",
                ),
            )

        runtime = await self._driver.async_apply(
            self._actuator,
            appliance=appliance,
            action=action,
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
        appliance: Any,
        action: ApplianceScheduleActionDict | None,
        reference_time: datetime,
    ) -> ApplianceRuntimeStatus | None:
        if action is None or not self._driver.is_enabled(appliance, action):
            return None
        return await self._driver.async_apply(
            self._actuator,
            appliance=appliance,
            action=None,
            action_kind="slot_stop",
            reference_time=reference_time,
        )


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


@dataclass(frozen=True)
class ApplianceDriverOptions:
    """The knobs a driver may need, passed to every factory in the registry.

    Only the EV charger reads them today — its wait-for-charge-on loop — but the
    factories take a uniform argument so the registry stays a plain kind → driver
    table rather than a per-kind construction branch.
    """

    charge_on_wait_seconds: float
    poll_interval_seconds: float
    sleep: Callable[[float], Awaitable[None]]


APPLIANCE_DRIVERS: dict[
    str, Callable[[ApplianceDriverOptions], ApplianceActionDriver]
] = {
    CONTROLLABLE_KIND_CLIMATE: lambda options: ClimateApplianceDriver(),
    CONTROLLABLE_KIND_EV_CHARGER: lambda options: EvChargerDriver(
        charge_on_wait_seconds=options.charge_on_wait_seconds,
        poll_interval_seconds=options.poll_interval_seconds,
        sleep=options.sleep,
    ),
    CONTROLLABLE_KIND_GENERIC: lambda options: GenericApplianceDriver(),
}


def _assert_drivers_cover_appliance_kinds() -> None:
    """Fail at import, not at reconcile, when a kind has no driver.

    An appliance kind added to ``CONTROLLABLE_SPECS`` without a driver here used
    to surface as a ``TypeError`` from the dispatch chain, mid-reconcile, on
    whichever appliance happened to be configured.
    """
    declared = appliance_controllable_kinds()
    implemented = frozenset(APPLIANCE_DRIVERS)
    if declared == implemented:
        return
    missing = sorted(declared - implemented)
    unknown = sorted(implemented - declared)
    raise RuntimeError(
        "APPLIANCE_DRIVERS must cover exactly the appliance controllable kinds; "
        f"missing drivers for {missing}, drivers for unknown kinds {unknown}"
    )


_assert_drivers_cover_appliance_kinds()


class AppliancesExecutor:
    def __init__(
        self,
        actuator: ScheduleActuator,
        *,
        charge_on_wait_seconds: float = 30.0,
        poll_interval_seconds: float = _CHARGE_POLL_INTERVAL_SECONDS,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        options = ApplianceDriverOptions(
            charge_on_wait_seconds=charge_on_wait_seconds,
            poll_interval_seconds=poll_interval_seconds,
            sleep=sleep,
        )
        self._executors: dict[str, ApplianceExecutor] = {
            kind: ApplianceExecutor(actuator, build_driver(options))
            for kind, build_driver in APPLIANCE_DRIVERS.items()
        }

    async def async_execute(
        self,
        *,
        registry: AppliancesRuntimeRegistry,
        active_slot_id: str,
        active_actions: Mapping[str, ApplianceScheduleActionDict],
        last_scheduled_actions: Mapping[str, ApplianceScheduleActionDict],
        previous_memories: Mapping[str, ApplianceExecutionMemory],
        reference_time: datetime,
    ) -> AppliancesExecutionResult:
        runtimes: dict[str, ApplianceRuntimeStatus] = {}
        memories: dict[str, ApplianceExecutionMemory] = {}
        first_error: ScheduleError | None = None

        for appliance in registry.appliances:
            runtime, memory = await self._executor_for(appliance).async_execute(
                appliance=appliance,
                action=active_actions.get(appliance.id),
                last_scheduled_action=last_scheduled_actions.get(appliance.id),
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
            executor = self._executor_for(appliance)
            runtime = await executor.async_disable_active_action(
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

    def _executor_for(self, appliance: Any) -> ApplianceExecutor:
        executor = self._executors.get(appliance.kind)
        if executor is None:
            raise TypeError(f"Unsupported appliance runtime {type(appliance)!r}")
        return executor
