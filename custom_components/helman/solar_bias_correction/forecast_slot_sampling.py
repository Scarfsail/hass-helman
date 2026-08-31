from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import datetime, timedelta


def resolve_forecast_slot_values(
    timeline: Sequence[tuple[datetime, float | None]],
    slot_starts: Iterable[datetime],
    *,
    slot_minutes: int,
) -> dict[datetime, float]:
    """Map each slot to the forecast published *for* it, held forward when absent.

    The sampling rule ``forecast_slot_history`` settled first and documents at
    module level, factored out here because the house and battery current-slot
    forecast readers need exactly the same one. Its point: the current-slot
    forecast sensors are written at the *end* of a rebuild that fires on the
    slot beat, so the state carrying a slot's forecast is stamped a fraction of
    a second *after* the slot start. Sweeping the timeline with ``<= slot_start``
    drops that row and leaves the slot showing whatever was published just after
    the previous beat -- the whole recorded curve one slot late.

    So a slot's value is the first numeric row inside
    ``[slot_start, slot_start + slot_minutes)``; a later row in the same slot is
    a revision and is passed over; a slot with no row of its own takes whatever
    value was standing from before it.

    ``timeline`` is ``(instant, value)`` pairs sorted oldest-first. ``value`` is
    ``None`` for a row a caller keeps as a hold-breaker -- ``forecast_slot_history``
    does that for ``unavailable`` so a gap cannot mint forecast data; the house
    and battery readers drop non-numeric rows before they get here and so never
    pass ``None``, which leaves the rule unchanged for them.
    """
    result: dict[datetime, float] = {}
    cursor = 0
    count = len(timeline)
    standing: float | None = None
    for slot_start in slot_starts:
        slot_end = slot_start + timedelta(minutes=slot_minutes)
        # Everything before this slot only updates what is standing; a ``None``
        # among them clears it rather than being skipped.
        while cursor < count and timeline[cursor][0] < slot_start:
            standing = timeline[cursor][1]
            cursor += 1
        # The slot's own writes. The first numeric one is the boundary write,
        # however late the rebuild published it; a later republication carries a
        # revision and is passed over.
        slot_value: float | None = None
        while cursor < count and timeline[cursor][0] < slot_end:
            value = timeline[cursor][1]
            if slot_value is None and value is not None:
                slot_value = value
            standing = value
            cursor += 1
        resolved = slot_value if slot_value is not None else standing
        if resolved is not None:
            result[slot_start] = resolved
    return result
