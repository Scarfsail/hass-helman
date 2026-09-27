"""A draft-only Energy import, including the changes a user must review."""

from __future__ import annotations

import re
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
    """The proposed draft's validation, minus errors the draft already had.

    Applying is refused only for errors the import introduces; the draft's own
    errors are not the import's to fix, and Save still refuses them.
    """
    existing = Counter(
        (_stable_path(issue.path, config), issue.code)
        for issue in validate_config_document(config).errors
    )
    report = validate_config_document(proposed).to_dict()
    errors = []
    for issue in report["errors"]:
        key = (_stable_path(issue["path"], proposed), issue["code"])
        if existing[key]:
            existing[key] -= 1
        else:
            errors.append(issue)
    return {**report, "valid": not errors, "errors": errors}


_DEVICE_PREFIX = re.compile(r"^devices\[\d+\](?:\.children\[\d+\])*")


def _stable_path(path: str, config: Mapping[str, Any]) -> str:
    """``path`` with its device index prefix replaced by that device's id.

    Index paths shift when the import moves a device; the id does not, so an
    error the draft already had matches itself wherever the device now sits.
    """
    match = _DEVICE_PREFIX.match(path)
    if match is None:
        return path
    items: Any = config.get("devices")
    device: Any = None
    for index in map(int, re.findall(r"\[(\d+)\]", match.group())):
        if not isinstance(items, list) or index >= len(items):
            return path
        device = items[index]
        if not isinstance(device, Mapping):
            return path
        items = device.get("children")
    device_id = peek_controllable_id(device)
    if device_id is None:
        return path
    return f"device:{device_id}{path[match.end():]}"
