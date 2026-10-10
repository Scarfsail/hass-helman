"""The single choke point through which Helman touches hardware.

Every service call the integration makes goes through :class:`ScheduleActuator`.
When schedule execution is disabled, the actuator is closed: reads still work,
writes raise. Nothing else in the integration calls ``hass.services.async_call``
directly, so a new actuation site cannot be added without passing through the
gate -- the executors hold an actuator instead of a ``HomeAssistant``, so
``hass`` is not even in scope where actions are applied.

The gate reads the persisted flag fresh on every call rather than caching it,
and fails closed when it cannot be read.

The one exception to the gate is the always-open actuator of the
``helman.group_action`` service (:mod:`..group_services`): that command comes
from the user's own automation, not from a schedule, so the schedule execution
flag must not block it. It still goes through this class for the single call
site and its timeout.

Every call is also bounded: a service that never returns would otherwise hold
the executor's execution lock forever and stall every later reconcile.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Mapping
from typing import TYPE_CHECKING, Any

from homeassistant.core import HomeAssistant

from .schedule import ScheduleError, ScheduleExecutionUnavailableError

if TYPE_CHECKING:
    from homeassistant.core import Context

_LOGGER = logging.getLogger(__name__)
# Shared by every hardware write. ``blocking=True`` waits for the target
# integration to finish, which a stalled charger or cloud API may never do.
SERVICE_CALL_TIMEOUT_SECONDS = 30.0


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
        service_call_timeout_seconds: float = SERVICE_CALL_TIMEOUT_SECONDS,
    ) -> None:
        self._hass = hass
        self._is_execution_enabled = is_execution_enabled
        self._service_call_timeout_seconds = service_call_timeout_seconds

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
        *,
        context: Context | None = None,
    ) -> None:
        if not self.is_open:
            raise ScheduleExecutionDisabledError(
                f"Schedule execution is disabled; refusing to call "
                f"{domain}.{service} for {data.get('entity_id')}"
            )
        timeout = asyncio.timeout(self._service_call_timeout_seconds)
        try:
            async with timeout:
                await self._hass.services.async_call(
                    domain,
                    service,
                    dict(data),
                    blocking=True,
                    context=context,
                )
        except TimeoutError as err:
            # A TimeoutError raised by the target integration itself is its own
            # failure, not Helman's bound expiring.
            if not timeout.expired():
                raise
            raise ScheduleExecutionUnavailableError(
                f"Timed out calling {domain}.{service} for "
                f"'{data.get('entity_id')}' after "
                f"{self._service_call_timeout_seconds:g} seconds"
            ) from err


async def async_write_vendor_entity(
    hass: HomeAssistant, entity_id: str, target: str | float
) -> None:
    """Set one vendor entity: a number to a value, a select to an option."""
    # Imported here so this module still loads under the trimmed Home
    # Assistant stubs of the pipeline tests, as the vendors package does.
    from homeassistant.exceptions import HomeAssistantError

    domain = entity_id.partition(".")[0]
    if domain == "number":
        service, data = "set_value", {"value": target}
    else:
        service, data = "select_option", {"option": target}
    # Bounded like the executor's own writes: a stalled vendor call would
    # otherwise hold the caller's lock, and every later write, indefinitely.
    timeout = asyncio.timeout(SERVICE_CALL_TIMEOUT_SECONDS)
    try:
        async with timeout:
            await hass.services.async_call(
                domain, service, {"entity_id": entity_id, **data}, blocking=True
            )
    except HomeAssistantError:
        raise
    except TimeoutError as err:
        if not timeout.expired():
            raise HomeAssistantError(
                f"Failed to set {entity_id} to {target!r}: {err}"
            ) from err
        raise HomeAssistantError(
            f"Timed out setting {entity_id} to {target!r} after "
            f"{SERVICE_CALL_TIMEOUT_SECONDS:g} seconds"
        ) from err
    except Exception as err:
        raise HomeAssistantError(
            f"Failed to set {entity_id} to {target!r}: {err}"
        ) from err
