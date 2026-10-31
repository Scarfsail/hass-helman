"""The per-kind half of appliance execution: one driver per appliance kind.

Each driver knows how to read and drive its kind's entities;
:class:`.execution.ApplianceExecutor` owns the decision sequence around them.
The kind's registry entry (:data:`..controllables.spec.CONTROLLABLE_SPECS`)
names the driver to build, so this module imports nothing from it.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from homeassistant.util import dt as dt_util

from ..controllables.config import SWITCH_CONTROL_DOMAINS, is_switch_on
from ..controllables.controllers import SelectEntityController
from ..scheduling.actuation import ScheduleActuator
from ..scheduling.runtime_status import (
    ControllableRuntimeStatus,
    RuntimeActionKind,
    RuntimeOutcome,
)
from ..scheduling.slots import ScheduleError, ScheduleExecutionUnavailableError
from .climate_appliance import ClimateApplianceRuntime
from .climate_schedule import (
    ClimateApplianceScheduleActionDict,
    is_climate_action_running,
)
from .ev_charger import EvChargerApplianceRuntime
from .ev_schedule import EvChargerScheduleActionDict, is_ev_charger_action_running
from .generic_appliance import GenericApplianceRuntime
from .generic_schedule import (
    GenericApplianceScheduleActionDict,
    is_generic_action_running,
)

_UNAVAILABLE_STATES = {"unknown", "unavailable", "none"}
CHARGE_POLL_INTERVAL_SECONDS = 1.0


class SwitchEntityController:
    def __init__(self, entity_id: str, *, description: str) -> None:
        domain, separator, object_id = entity_id.partition(".")
        if not separator or not object_id or domain not in SWITCH_CONTROL_DOMAINS:
            raise ScheduleExecutionUnavailableError(
                f"{description} must use the switch, light, media_player or fan domain"
            )
        self.entity_id = entity_id
        self._domain = domain
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
        return is_switch_on(getattr(state, "state", None))

    async def async_turn_on(self, actuator: ScheduleActuator) -> None:
        try:
            await actuator.async_call(
                self._domain,
                "turn_on",
                {"entity_id": self.entity_id},
            )
        except ScheduleError:
            raise
        except Exception as err:
            raise ScheduleExecutionUnavailableError(
                f"Failed to turn on {self._description.lower()} '{self.entity_id}'"
            ) from err

    async def async_turn_off(self, actuator: ScheduleActuator) -> None:
        try:
            await actuator.async_call(
                self._domain,
                "turn_off",
                {"entity_id": self.entity_id},
            )
        except ScheduleError:
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
        except ScheduleError:
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
    ) -> ControllableRuntimeStatus:
        """Drive the appliance; ``action is None`` means "go to rest"."""


class EvChargerDriver:
    def __init__(
        self,
        *,
        charge_on_wait_seconds: float = 30.0,
        poll_interval_seconds: float = CHARGE_POLL_INTERVAL_SECONDS,
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
        return is_ev_charger_action_running(action)

    async def async_apply(
        self,
        actuator: ScheduleActuator,
        *,
        appliance: EvChargerApplianceRuntime,
        action: EvChargerScheduleActionDict | None,
        action_kind: RuntimeActionKind,
        reference_time: datetime,
    ) -> ControllableRuntimeStatus:
        if action is None or not is_ev_charger_action_running(action):
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
            return build_runtime_status(
                action_kind=action_kind,
                outcome="failed",
                error=err,
                reference_time=reference_time,
            )

        return build_runtime_status(
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
    ) -> ControllableRuntimeStatus:
        try:
            switch_controller = SwitchEntityController(
                appliance.charge_entity_id,
                description="EV charge entity",
            )
            charge_state = switch_controller.read_state(actuator)
            if switch_controller.is_on(charge_state):
                await switch_controller.async_turn_off(actuator)
        except ScheduleError as err:
            return build_runtime_status(
                action_kind=action_kind,
                outcome="failed",
                error=err,
                reference_time=reference_time,
            )

        return build_runtime_status(
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
        return is_generic_action_running(action)

    async def async_apply(
        self,
        actuator: ScheduleActuator,
        *,
        appliance: GenericApplianceRuntime,
        action: GenericApplianceScheduleActionDict | None,
        action_kind: RuntimeActionKind,
        reference_time: datetime,
    ) -> ControllableRuntimeStatus:
        enabled = action is not None and is_generic_action_running(action)
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
            return build_runtime_status(
                action_kind=action_kind,
                outcome="failed",
                error=err,
                reference_time=reference_time,
            )

        return build_runtime_status(
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
        return is_climate_action_running(action)

    async def async_apply(
        self,
        actuator: ScheduleActuator,
        *,
        appliance: ClimateApplianceRuntime,
        action: ClimateApplianceScheduleActionDict | None,
        action_kind: RuntimeActionKind,
        reference_time: datetime,
    ) -> ControllableRuntimeStatus:
        hvac_mode = appliance.stop_hvac_mode if action is None else action["mode"]
        if hvac_mode is None:
            return build_runtime_status(
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
            return build_runtime_status(
                action_kind=action_kind,
                outcome="failed",
                error=err,
                reference_time=reference_time,
            )

        return build_runtime_status(
            action_kind=action_kind,
            outcome="success",
            reference_time=reference_time,
        )


def build_runtime_status(
    *,
    action_kind: RuntimeActionKind,
    outcome: RuntimeOutcome,
    reference_time: datetime,
    error: ScheduleError | None = None,
) -> ControllableRuntimeStatus:
    return ControllableRuntimeStatus(
        action_kind=action_kind,
        outcome=outcome,
        error_code=None if error is None else error.code,
        message=None if error is None else str(error),
        updated_at=dt_util.as_local(reference_time).isoformat(timespec="seconds"),
    )


@dataclass(frozen=True)
class ApplianceDriverOptions:
    """The knobs a driver may need, passed to every kind's driver factory.

    Only the EV charger reads them today — its wait-for-charge-on loop — but the
    factories take a uniform argument so each spec entry names its driver the
    same way rather than through a per-kind construction branch.
    """

    charge_on_wait_seconds: float
    poll_interval_seconds: float
    sleep: Callable[[float], Awaitable[None]]
