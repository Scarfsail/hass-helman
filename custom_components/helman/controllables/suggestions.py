"""Explicit registry suggestions; callers decide whether to use a candidate."""

from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import (
    device_registry as dr,
    entity_registry as er,
    label_registry as lr,
)


def suggest_entities(
    hass: HomeAssistant, anchor_entity_id: str, config: dict[str, Any]
) -> dict[str, list[dict[str, Any]]]:
    registry = er.async_get(hass)
    anchor = registry.async_get(anchor_entity_id)
    result: dict[str, list[dict[str, Any]]] = {
        field: [] for field in ("energy", "power", "switch")
    }
    if anchor is None or anchor.device_id is None:
        return result
    labels = lr.async_get(hass)
    power_devices = config.get("power_devices") or {}
    house = power_devices.get("house") or {}
    device = dr.async_get(hass).async_get(anchor.device_id)
    device_name = str((device.name_by_user or device.name) if device else "").casefold()
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
        reasons = ["Same Home Assistant device"]
        score = 1
        if field != "switch":
            reasons.append(f"Device class: {field}")
            score += 2
        label_key = "power_switch_label" if field == "switch" else "power_sensor_label"
        wanted = house.get(label_key)
        if wanted and any(
            (label := labels.async_get_label(label_id)) and label.name == wanted
            for label_id in entry.labels
        ):
            reasons.append(f"Label: {wanted}")
            score += 4
        name = str(
            attrs.get("friendly_name")
            or entry.name
            or entry.original_name
            or entry.entity_id
        )
        if field == "switch" and device_name and name.casefold() == device_name:
            reasons.append("Friendly name matches device name")
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
