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
    """The house's top-level measured consumers, as the power card knows them.

    Each entry is ``{energy_entity_id, label, switch_entity_id}``, taken verbatim
    from the tree node: its ``id`` is the device's energy stat, ``displayName``
    the name the card shows, and ``switchEntityId`` the control the card offers —
    ``None`` when the tree resolved none, which is the card's own behaviour.

    Only top-level house children are returned. Nested sub-meters are already
    counted inside their parent's stat, so including them would double-count
    against the house total.
    """
    if not isinstance(tree, dict):
        return []
    consumers = tree.get("consumers")
    if not isinstance(consumers, list):
        return []
    house_node = next(
        (
            node
            for node in consumers
            if isinstance(node, dict) and node.get("id") == "house"
        ),
        None,
    )
    if house_node is None:
        return []

    result: list[dict[str, Any]] = []
    for child in house_node.get("children") or []:
        if not isinstance(child, dict):
            continue
        if any(child.get(flag) for flag in _SKIPPED_NODE_FLAGS):
            continue
        energy_entity_id = child.get("id")
        if not _is_readable_entity_id(energy_entity_id):
            continue
        switch_entity_id = child.get("switchEntityId")
        result.append(
            {
                "energy_entity_id": energy_entity_id,
                "label": child.get("displayName") or energy_entity_id,
                "switch_entity_id": (
                    switch_entity_id if isinstance(switch_entity_id, str) and switch_entity_id else None
                ),
            }
        )
    return result
