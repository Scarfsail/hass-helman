"""The single choke point through which Helman touches hardware.

Every service call the integration makes goes through :class:`ScheduleActuator`.
When schedule execution is disabled, the actuator is closed: reads still work,
writes raise. Nothing else in the integration calls ``hass.services.async_call``
directly, so a new actuation site cannot be added without passing through the
gate -- the executors hold an actuator instead of a ``HomeAssistant``, so
``hass`` is not even in scope where actions are applied.

The gate reads the persisted flag fresh on every call rather than caching it,
and fails closed when it cannot be read.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from typing import Any

from homeassistant.core import HomeAssistant

from .schedule import ScheduleError

_LOGGER = logging.getLogger(__name__)


class ScheduleExecutionDisabledError(ScheduleError):
    """Raised when something tries to actuate while execution is disabled."""

    def __init__(self, message: str) -> None:
        super().__init__("execution_disabled", message)


class ScheduleActuator:
    """Reads entity state freely; applies changes only when the gate is open."""

    def __init__(
        self,
        hass: HomeAssistant,
        *,
        is_execution_enabled: Callable[[], bool],
    ) -> None:
        self._hass = hass
        self._is_execution_enabled = is_execution_enabled

    def read_state(self, entity_id: str) -> Any:
        """Read an entity state. Always allowed -- reading touches nothing."""
        return self._hass.states.get(entity_id)

    @property
    def is_open(self) -> bool:
        """Whether actuation is currently permitted."""
        try:
            return bool(self._is_execution_enabled())
        except Exception:
            # Fail closed: if we cannot establish that execution is enabled,
            # we must not touch anything.
            _LOGGER.exception(
                "Could not determine whether schedule execution is enabled; "
                "refusing to actuate"
            )
            return False

    async def async_call(
        self,
        domain: str,
        service: str,
        data: Mapping[str, Any],
    ) -> None:
        if not self.is_open:
            raise ScheduleExecutionDisabledError(
                f"Schedule execution is disabled; refusing to call "
                f"{domain}.{service} for {data.get('entity_id')}"
            )
        await self._hass.services.async_call(
            domain,
            service,
            dict(data),
            blocking=True,
        )


class OverrideScheduleActuator(ScheduleActuator):
    """An actuator that is always open, for explicit user-initiated actions.

    Used only by the "turn everything to normal" action the user triggers from
    the scheduling card while execution is disabled. It exists so that the one
    legitimate exception is a distinct, named type rather than a flag threaded
    through the normal execution path.
    """

    def __init__(self, hass: HomeAssistant) -> None:
        super().__init__(hass, is_execution_enabled=lambda: True)
