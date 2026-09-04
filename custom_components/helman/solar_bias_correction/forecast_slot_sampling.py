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
    ``None`` for a row a caller keeps as a hold-breaker. Every caller -- the
    bias trainer's ``forecast_slot_history`` and the inspector's house and
    battery readers alike -- keeps a non-numeric row (``unavailable`` and the
    like) and passes it through as ``None``, ending the hold, because a value
    held across a dead stretch would be forecast data for slots nothing was
    ever believed about: a bad fit for the trainer and a false curve for the
    inspector. The frequent sub-second NULL/restore dropouts a live instance
    produces are nearly free under this rule -- the slot's first numeric row is
    still found inside it -- so no threshold is needed to tell them apart from
    a real outage. Nearly, not entirely: a dropout whose restoring row lands
    across a slot boundary blanks the slot it straddles, since that slot ends
    with nothing standing and has no numeric row of its own. Measured on this
    project's reference instance that costs on the order of a tenth of a slot
    per day, which is why it is worn rather than worked around.

    That cost is priced on the slot having a numeric row of its own, so only the
    hold is at risk. Every current-slot forecast entity these callers read --
    the bias trainer's ``forecast_slot_history``, the inspector's house and
    battery readers -- now sets ``force_update``, so each writes a row on every
    beat whether or not the value moved, and the hold is a fallback for genuine
    gaps rather than the normal path for a flat series. Before that, a series
    pinned at one value recorded no rows at all across the stretch and every
    slot in it was hold-derived, which put far more than a tenth of a slot a day
    at the mercy of a single restart.
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
