"""A draft-only Energy import, including the changes a user must review."""

from __future__ import annotations

from collections import Counter
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
        consumption = device.get("consumption") or {}
        if device_id not in before:
            additions.append(
                {
                    "deviceId": device_id,
                    "parentId": parent_id,
                    "energyEntityId": consumption.get("energy_entity_id"),
                    "powerEntityId": consumption.get("power_entity_id"),
                }
            )
            continue
        previous, previous_parent = before[device_id]
        value = consumption.get("power_entity_id")
        if value and not (previous.get("consumption") or {}).get("power_entity_id"):
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
    # Reasons are codes; the editor words them in the user's language.
    warnings = [asdict(conflict) for conflict in result.warnings]
    return {
        "devices": result.devices,
        "additions": additions,
        "powerEntities": power,
        "nestingChanges": moves,
        "skippedRows": skipped,
        "warnings": warnings,
        "validation": _new_errors_only(config, proposed),
    }


def _new_errors_only(
    config: dict[str, Any], proposed: dict[str, Any]
) -> dict[str, Any]:
    """The proposed draft's validation, limited to errors the import adds.

    Applying is refused only for errors the import introduces; the draft's own
    errors are not the import's to fix, and Save still refuses them. Errors are
    compared by how often each code occurs, not by path: a move shifts index
    paths and can change which of two devices an error is reported on.
    """
    existing = Counter(issue.code for issue in validate_config_document(config).errors)
    report = validate_config_document(proposed).to_dict()
    added = Counter(issue["code"] for issue in report["errors"]) - existing
    errors = [issue for issue in report["errors"] if added[issue["code"]]]
    return {**report, "valid": not errors, "errors": errors}
