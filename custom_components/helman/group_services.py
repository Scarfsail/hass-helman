"""HA services that let automations act on a helman device group.

``helman.get_group_entities`` lists a group's entities; ``helman.group_action``
turns them on, off or toggles them. A group's entities are its direct members'
running signals (:func:`.controllables.config.group_member_entities`); a member
without one is logged and reported, never silently dropped.

The config is read fresh on every call, so an edit in the config editor applies
at once.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping
from typing import Any

import voluptuous as vol
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN
from .controllables.config import group_exists, group_member_entities
from .scheduling.actuation import ScheduleActuator

_LOGGER = logging.getLogger(__name__)

SERVICE_GET_GROUP_ENTITIES = "get_group_entities"
SERVICE_GROUP_ACTION = "group_action"
GROUP_ACTIONS = ("turn_on", "turn_off", "toggle")

_GROUP_FIELDS = {
    vol.Required("grouping"): vol.All(cv.string, vol.Length(min=1)),
    vol.Required("group"): vol.All(cv.string, vol.Length(min=1)),
}
GET_GROUP_ENTITIES_SCHEMA = vol.Schema(_GROUP_FIELDS)
GROUP_ACTION_SCHEMA = vol.Schema(
    {
        **_GROUP_FIELDS,
        vol.Required("action"): vol.In(GROUP_ACTIONS),
        vol.Optional("delay_ms", default=500): vol.All(
            vol.Coerce(int), vol.Range(min=0)
        ),
        vol.Optional("continue_on_error", default=True): cv.boolean,
    }
)


def _resolve_group(
    hass: HomeAssistant, data: Mapping[str, Any]
) -> tuple[list[str], list[str]]:
    """The group's ``(entity ids, skipped device ids)``; unknown group raises."""
    config = hass.data[DOMAIN]["storage"].config
    grouping_id, group_id = data["grouping"], data["group"]
    if not group_exists(config, grouping_id, group_id):
        raise ServiceValidationError(
            f"Unknown helman group '{group_id}' in grouping '{grouping_id}'"
        )
    entity_ids, skipped = group_member_entities(config, grouping_id, group_id)
    for device_id in skipped:
        _LOGGER.warning(
            "Device '%s' is in helman group %s/%s but has no switch, charge or "
            "climate control; it is skipped",
            device_id,
            grouping_id,
            group_id,
        )
    return entity_ids, skipped


def async_register_group_services(hass: HomeAssistant) -> None:
    """Register ``helman.get_group_entities`` and ``helman.group_action``."""
    # The command comes from the user's own automation, so the schedule
    # execution gate must not block it.
    actuator = ScheduleActuator(hass, is_execution_enabled=lambda: True)

    async def get_group_entities(call: ServiceCall) -> dict[str, Any]:
        entity_ids, skipped = _resolve_group(hass, call.data)
        return {"entity_ids": entity_ids, "skipped": skipped}

    async def group_action(call: ServiceCall) -> None:
        entity_ids, _skipped = _resolve_group(hass, call.data)
        action = call.data["action"]
        delay_seconds = call.data["delay_ms"] / 1000
        failed: list[str] = []
        for index, entity_id in enumerate(entity_ids):
            if index and delay_seconds:
                await asyncio.sleep(delay_seconds)
            domain = entity_id.split(".", 1)[0]
            try:
                await actuator.async_call(
                    domain, action, {"entity_id": entity_id}, context=call.context
                )
            except Exception:
                _LOGGER.exception(
                    "helman.group_action: %s.%s failed for %s",
                    domain,
                    action,
                    entity_id,
                )
                failed.append(entity_id)
        if failed and not call.data["continue_on_error"]:
            raise HomeAssistantError(
                f"helman.group_action {action} failed for: {', '.join(failed)}"
            )

    hass.services.async_register(
        DOMAIN,
        SERVICE_GET_GROUP_ENTITIES,
        get_group_entities,
        schema=GET_GROUP_ENTITIES_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_GROUP_ACTION,
        group_action,
        schema=GROUP_ACTION_SCHEMA,
    )
