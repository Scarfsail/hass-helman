"""Reading the house's individually-measured consumers out of the device tree.

Kept free of Home Assistant imports so the contract below can be tested directly.

The single source of truth for a consumer's controlling switch is the device tree
the power card already renders: whatever ``switchEntityId`` that tree resolved for
a node is exactly what the card shows on it, so anything reading through here
shows the same control the card does — and shows none where the card shows none.
Nothing in this module infers, derives or guesses a switch.
"""

from __future__ import annotations

from typing import Any

#: Tree node flags that never denote a real measured consumer.
_SKIPPED_NODE_FLAGS = ("isUnmeasured", "isVirtual", "isSource")


def _is_readable_entity_id(value: Any) -> bool:
    """Whether an id is a real entity the recorder holds state history for.

    The energy dashboard also allows external statistics ids (``source:stat``),
    which have no state history, so those are skipped rather than read.
    """
    return isinstance(value, str) and "." in value and ":" not in value


def extract_house_device_consumers(tree: Any) -> list[dict[str, Any]]:
    """Disjoint measured rows for inspector history, using tree attribution.

    Passive descendants remain inside their nearest included ancestor. Each
    schedulable leaf exposes its own load separately and is subtracted from its
    nearest included ancestor exactly once. A meterless child reads its
    share-energy sensor like any metered child; the
    synthetic live remainder nodes never own history.

    Only relationships and metadata are resolved here. Missing readings, excess
    child energy and slot alignment belong to the inspector's own-energy reader,
    not the reports' independent hourly coverage and attribution policy.
    """
    if not isinstance(tree, dict) or not isinstance(tree.get("consumers"), list):
        return []
    house = next((node for node in tree["consumers"]
                  if isinstance(node, dict) and node.get("id") == "house"), None)
    if house is None:
        return []

    result: list[dict[str, Any]] = []
    seen: set[str] = set()

    def visit(node: Any, ancestor: dict | None, split_children: bool) -> None:
        if not isinstance(node, dict):
            return
        if any(node.get(flag) for flag in _SKIPPED_NODE_FLAGS):
            return
        meter = node.get("energyEntityId")
        deferrable = bool(node.get("deferrable"))
        if _is_readable_entity_id(meter):
            if meter in seen:
                return
            seen.add(meter)
            if ancestor is None or split_children or deferrable:
                switch = node.get("switchEntityId")
                power = node.get("powerSensorId")
                row = {
                    "energy_entity_id": meter,
                    "label": node.get("displayName") or meter,
                    "switch_entity_id": switch if isinstance(switch, str) and switch else None,
                    "power_entity_id": power if _is_readable_entity_id(power) else None,
                    "deferrable": deferrable,
                    "ids": list(node.get("controllableIds") or []),
                    "metered_children": [],
                }
                if ancestor is not None:
                    ancestor["metered_children"].append(meter)
                    # A controllable is claimed by exactly one row.
                    ancestor["ids"] = [
                        claimed for claimed in ancestor["ids"] if claimed not in row["ids"]
                    ]
                result.append(row)
                ancestor = row
                split_children = deferrable
        for child in node.get("children") or []:
            visit(child, ancestor, split_children)

    for child in house.get("children") or []:
        visit(child, None, False)
    return result
