"""Explicit registry suggestions; callers decide whether to use a candidate."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import (
    device_registry as dr,
    entity_registry as er,
    label_registry as lr,
)


def suggest_entities(
    hass: HomeAssistant, anchor_entity_ids: Sequence[str], config: dict[str, Any]
) -> dict[str, list[dict[str, Any]]]:
    """Ranked candidates from the HA device of the first anchor that has one.

    The editor sends every entity the device names, most telling first; a
    helper (a utility meter, an ``input_select``) has no HA device, so the
    next anchor is tried rather than returning nothing.
    """
    registry = er.async_get(hass)
    anchor = next(
        (
            entry
            for entity_id in anchor_entity_ids
            if (entry := registry.async_get(entity_id.strip())) is not None
            and entry.device_id is not None
        ),
        None,
    )
    result: dict[str, list[dict[str, Any]]] = {
        field: [] for field in ("energy", "power", "switch")
    }
    if anchor is None:
        return result
    labels = lr.async_get(hass)
    power_devices = config.get("power_devices") or {}
    house = power_devices.get("house") or {}
    device = dr.async_get(hass).async_get(anchor.device_id)
    device_name = ((device.name_by_user or device.name or "") if device else "").casefold()
    for entry in er.async_entries_for_device(registry, anchor.device_id):
        if entry.disabled_by is not None:
            continue
        state = hass.states.get(entry.entity_id)
        attrs = state.attributes if state else {}
        device_class = (
            attrs.get("device_class")
            or entry.device_class
            or entry.original_device_class
        )
        field = (
            "switch"
            if entry.domain == "switch"
            else device_class
            if entry.domain == "sensor" and device_class in ("energy", "power")
            else None
        )
        if field is None:
            continue
        # Reasons are codes (with a value where one applies); the editor words them.
        reasons: list[dict[str, str]] = [{"code": "same_device"}]
        score = 1
        if field != "switch":
            reasons.append({"code": f"device_class_{field}"})
            score += 2
        label_key = "power_switch_label" if field == "switch" else "power_sensor_label"
        wanted = house.get(label_key)
        if wanted and any(
            (label := labels.async_get_label(label_id)) and label.name == wanted
            for label_id in entry.labels
        ):
            reasons.append({"code": "label", "value": wanted})
            score += 4
        name = str(
            attrs.get("friendly_name")
            or entry.name
            or entry.original_name
            or entry.entity_id
        )
        if field == "switch" and device_name and name.casefold() == device_name:
            reasons.append({"code": "name_match"})
            score += 3
        result[field].append(
            {
                "entityId": entry.entity_id,
                "name": name,
                "reasons": reasons,
                "rank": score,
            }
        )
    for candidates in result.values():
        candidates.sort(
            key=lambda candidate: (-candidate["rank"], candidate["entityId"])
        )
    return result
