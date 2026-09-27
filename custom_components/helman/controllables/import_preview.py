"""A draft-only Energy import, including the changes a user must review."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from dataclasses import asdict
from .config import iter_devices, peek_controllable_id
from .energy_import import import_energy_preferences
from ..config_validation import validate_config_document


def preview_energy_import(
    config: dict[str, Any], preferences: Mapping[str, Any] | None
) -> dict[str, Any]:
    result = import_energy_preferences(
        config.get("devices") or [], preferences, manual=True
    )
    proposed = {**config, "devices": result.devices}
    before = {
        peek_controllable_id(d): (d, peek_controllable_id(p) if p else None)
        for d, p in iter_devices(config)
    }
    additions, power, moves = [], [], []
    for device, parent in iter_devices(proposed):
        device_id = peek_controllable_id(device)
        parent_id = peek_controllable_id(parent) if parent else None
        if device_id not in before:
            additions.append(
                {
                    "deviceId": device_id,
                    "parentId": parent_id,
                    "energyEntityId": device.get("consumption", {}).get(
                        "energy_entity_id"
                    ),
                }
            )
            continue
        previous, previous_parent = before[device_id]
        value = device.get("consumption", {}).get("power_entity_id")
        if value and not previous.get("consumption", {}).get("power_entity_id"):
            power.append({"deviceId": device_id, "entityId": value})
        if previous_parent != parent_id:
            moves.append(
                {
                    "deviceId": device_id,
                    "fromParentId": previous_parent,
                    "parentId": parent_id,
                }
            )
    skipped = [asdict(conflict) for conflict in result.conflicts]
    skipped.extend(
        {
            "energy_entity_id": statistic,
            "reason": "external_statistic",
            "device_id": None,
        }
        for statistic in result.external_statistics
    )
    warnings = [
        {
            **asdict(conflict),
            "message": "Energy reports this meter inside a schedulable device. Both are counted independently. Restructure them under a passive meter-owning parent in the editor."
            if conflict.reason == "schedulable"
            else "This move needs a power entity because the parent has meterless children.",
        }
        for conflict in result.warnings
    ]
    validation = validate_config_document(proposed).to_dict()
    return {
        "devices": result.devices,
        "additions": additions,
        "powerEntities": power,
        "nestingChanges": moves,
        "skippedRows": skipped,
        "warnings": warnings,
        "validation": validation,
    }
