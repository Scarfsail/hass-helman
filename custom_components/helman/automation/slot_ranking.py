"""Slot ordering shared by the optimizers that rank and cut at a need.

``charge_hold`` and capped ``appliance_runtime`` both rank a day's slots and
take a prefix. Ranking by key alone breaks ties by time, so the cut can leave a
one-slot gap inside what should be one run: the battery flips between charging
and exporting, an appliance stops and starts again. Among exactly equal keys
this ordering prefers a slot next to one already picked, so the picks grow into
contiguous runs without ever changing which keys are bought.
"""

from __future__ import annotations

from collections.abc import Callable, Hashable, Iterable
from typing import Any
from datetime import datetime

from homeassistant.util import dt as dt_util

from ..scheduling.slots import SCHEDULE_SLOT_DURATION, parse_slot_id


def rank_slots_contiguous(
    slot_ids: Iterable[str],
    *,
    # Keys must be hashable and orderable (groups are sorted); Hashable alone
    # does not express the ordering, so the return type is Any.
    key: Callable[[str], Any],
    seed: str | None = None,
    picked: Iterable[str] = (),
) -> list[str]:
    """Order ``slot_ids`` by ``key``, ties going to a slot adjacent to a pick.

    Groups of equal key are walked in ascending order. Within a group, the
    earliest remaining slot that starts one slot before or after an already
    ordered slot (from any earlier group or earlier in this group) comes next;
    with none adjacent, the earliest remaining slot does. A ``seed`` among
    ``slot_ids`` goes first and seeds adjacency; the rest of its group is walked
    with its key as usual. ``picked`` slots are already bought elsewhere: they
    seed adjacency but are not part of the ordering.
    """
    start_by_slot = {
        slot_id: dt_util.as_utc(parse_slot_id(slot_id)) for slot_id in slot_ids
    }
    groups: dict[Hashable, list[str]] = {}
    for slot_id in start_by_slot:
        groups.setdefault(key(slot_id), []).append(slot_id)

    ordered: list[str] = []
    ordered_starts: set[datetime] = {
        dt_util.as_utc(parse_slot_id(slot_id)) for slot_id in picked
    }

    def append(slot_id: str) -> None:
        ordered.append(slot_id)
        ordered_starts.add(start_by_slot[slot_id])

    if seed in start_by_slot:
        append(seed)
    for group_key in sorted(groups):
        remaining = sorted(
            (slot_id for slot_id in groups[group_key] if slot_id != seed),
            key=start_by_slot.__getitem__,
        )
        while remaining:
            pick = next(
                (
                    slot_id
                    for slot_id in remaining
                    if start_by_slot[slot_id] - SCHEDULE_SLOT_DURATION
                    in ordered_starts
                    or start_by_slot[slot_id] + SCHEDULE_SLOT_DURATION
                    in ordered_starts
                ),
                remaining[0],
            )
            remaining.remove(pick)
            append(pick)
    return ordered
