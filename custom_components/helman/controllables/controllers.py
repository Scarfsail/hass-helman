"""Entity drivers shared by more than one kind of controllable.

:class:`SelectEntityController` was written twice — once in the schedule
executor for the inverter's mode entity, once among the appliance executors for
the EV charger's use-mode and eco-gear selects. The two were the same class:
same domain check, same availability check, same option reading, same
validation, same service call. Only the error strings differed, and only
because one lived on the "inverter" side of a split that had no reason to exist.

The fold keeps every diagnostic exactly as specific as it was: ``description``
names the thing being driven ("Schedule mode", "EV select") and every message is
built from it, the same way :class:`..appliances.execution.SwitchEntityController`
already does. A caller that drives two different selects passes two different
descriptions, so a failure still says which one failed.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ..scheduling.actuation import ScheduleActuator, ScheduleExecutionDisabledError
from ..scheduling.schedule import ScheduleExecutionUnavailableError

_SELECT_DOMAINS = {"input_select", "select"}
_UNAVAILABLE_STATES = {"unknown", "unavailable", "none"}


class SelectEntityController:
    """Drives one ``select`` / ``input_select`` entity by picking an option."""

    def __init__(self, entity_id: str, *, description: str) -> None:
        domain, separator, object_id = entity_id.partition(".")
        if not separator or not object_id or domain not in _SELECT_DOMAINS:
            raise ScheduleExecutionUnavailableError(
                f"{description} entity must use the input_select or select domain"
            )
        self.entity_id = entity_id
        # Both domains name their service after their own domain, so the domain
        # the entity id declares is also the one the call goes to.
        self.service_domain = domain
        self._description = description

    def read_state(self, actuator: ScheduleActuator) -> Any:
        state = actuator.read_state(self.entity_id)
        if state is None:
            raise ScheduleExecutionUnavailableError(
                f"{self._description} entity '{self.entity_id}' is not available"
            )

        raw_state = getattr(state, "state", None)
        if (
            not isinstance(raw_state, str)
            or not raw_state.strip()
            or raw_state.strip().lower() in _UNAVAILABLE_STATES
        ):
            raise ScheduleExecutionUnavailableError(
                f"{self._description} entity '{self.entity_id}' is unavailable"
            )
        return state

    def read_available_options(self, state: Any) -> list[str]:
        raw_attributes = getattr(state, "attributes", {})
        if not isinstance(raw_attributes, Mapping):
            raise ScheduleExecutionUnavailableError(
                f"{self._description} entity options are unavailable"
            )

        raw_options = raw_attributes.get("options")
        if not isinstance(raw_options, (list, tuple)) or not raw_options:
            raise ScheduleExecutionUnavailableError(
                f"{self._description} entity options are unavailable"
            )

        options = [
            option
            for option in raw_options
            if isinstance(option, str) and option.strip()
        ]
        if len(options) != len(raw_options):
            raise ScheduleExecutionUnavailableError(
                f"{self._description} entity options must be non-empty strings"
            )
        return options

    def validate_option(self, state: Any, option: str) -> None:
        if option not in self.read_available_options(state):
            raise ScheduleExecutionUnavailableError(
                f"{self._description} option '{option}' is not available on "
                f"'{self.entity_id}'"
            )

    async def async_select_option(
        self,
        actuator: ScheduleActuator,
        *,
        option: str,
    ) -> None:
        try:
            await actuator.async_call(
                self.service_domain,
                "select_option",
                {"entity_id": self.entity_id, "option": option},
            )
        except ScheduleExecutionDisabledError:
            # The gate is closed on purpose; it is not a fault of this entity.
            raise
        except Exception as err:
            raise ScheduleExecutionUnavailableError(
                f"Failed to apply {self._description} option '{option}' to "
                f"'{self.entity_id}'"
            ) from err
