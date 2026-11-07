"""The charging ledger's records, kept pure: segments, their hourly slices, and what each slice is attributed.

A **segment** is one continuous recorded stretch in which the charger's
charge power is above :data:`CHARGING_POWER_W`, as
:func:`~..node_details.ev_charger.charging_runs` walks it with
:func:`charging_power`: a dip to standby followed by charging starts another,
and nothing here says when a car was plugged in or out. The run mode is not
read: a charger can report ``Charging`` while it draws only standby watts. Its bounds are UTC instants, each with whether a recorded
transition fixes it: a stretch carried in at the start of a read, or one cut
by a long gap, keeps the instant it was last known charging, never an
invented one.

Its energy is the charger's cumulative meter between its bounds, split into
**slices** at every UTC hour boundary inside it; in a zone with a whole-hour
UTC offset local midnights fall on hour boundaries, so a slice never spans two
local days (in a half-hour offset zone one does), and a repeated or skipped
DST hour is its own UTC hour. A slice's ``kwh`` is ``None`` where the meter
has no trusted reading at either end: a gap, never a zero.

Each slice keeps what :func:`~..device_reports.dataset.attribute_energy` says
of it in its hour of the house mix: the source split and four money sides,
each as ``[amount, priced kWh, unpriced kWh]``. ``paid`` and ``forgone`` are the
slice's whole kWh; ``grid_paid`` is the grid share at the hour's import rate
and ``solar_forgone`` the direct solar share at its export rate, the two the
30-day tiles divide by. ``attribution`` is ``None`` until a house dataset has
answered for the slice's day.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from homeassistant.util import dt as dt_util

from ..device_reports.dataset import DeviceDataset, MoneySide, attribute_energy
from ..node_details.ev_charger import ChargingRun
from ..power_reading import power_unit_factor

_HOUR = timedelta(hours=1)
#: Above this charge power a charger is charging; at or below it it stands by.
CHARGING_POWER_W = 1000.0
#: The money sides a slice keeps, as ``Attribution`` names them.
MONEY_SIDES = ("paid", "forgone", "grid_paid", "solar_forgone")
SOURCES = ("solar", "battery", "grid", "unknown")


def charging_power(state: Any, default_unit: str | None = None) -> bool | None:
    """Whether a charge power state is charging; ``None`` for a gap (a non-numeric or unconvertible reading).

    The state's own unit, else ``default_unit`` (a read without attributes).
    """
    attributes = getattr(state, "attributes", None) or {}
    factor = power_unit_factor(attributes.get("unit_of_measurement", default_unit))
    try:
        value = float(state.state)
    except (TypeError, ValueError):
        return None
    if factor is None or not math.isfinite(value):
        return None
    return value * factor > CHARGING_POWER_W


@dataclass
class Slice:
    start: datetime
    end: datetime
    kwh: float | None
    #: ``{solar, battery, grid, unknown, paid, forgone, grid_paid, solar_forgone}``.
    attribution: dict[str, Any] | None = None
    #: The attribution is from a complete day: it is kept as it is for good.
    final: bool = False

    @property
    def hour(self) -> datetime:
        return self.start.replace(minute=0, second=0, microsecond=0)


@dataclass
class Segment:
    id: str
    start: datetime
    #: While ``active``, when the last read saw it still charging.
    end: datetime
    start_known: bool
    end_known: bool
    active: bool
    #: The end of the newest power read that placed ``end``: only a read
    #: reaching as far moves it.
    seen_until: datetime
    power_entity_id: str
    meter_entity_id: str | None
    #: Its energy can no longer move: it is never read again.
    energy_final: bool = False
    slices: list[Slice] = field(default_factory=list)

    @property
    def kwh(self) -> float:
        return sum(item.kwh for item in self.slices if item.kwh is not None)

    @property
    def kwh_complete(self) -> bool:
        """Every slice measured and both bounds recorded: ``kwh`` is not a lower bound."""
        return (
            self.start_known
            and (self.end_known or self.active)
            and bool(self.slices)
            and all(item.kwh is not None for item in self.slices)
        )


def merge_runs(
    segments: list[Segment],
    runs: Iterable[ChargingRun],
    *,
    read_end: datetime,
    live: bool,
    power_entity_id: str,
    meter_entity_id: str | None,
) -> list[Segment]:
    """Fold one read's charging runs into ``segments``, in place; the segments the runs landed on.

    A run overlapping or touching a stored segment of the same power entity is
    that segment again: its identity stays, an earlier start replaces a later
    one (in a live read only a recorded one: a start carried in at the read's
    start says only that it was charging by then, and would creep back a read
    margin each reconciliation; backfill recovers the real one), and the end moves only for a read reaching at least as far as the one
    that placed it. Replaying a read changes nothing. Any other run is a new
    segment, identified by its start. ``live`` is a read that ends now: only
    its run still going is ``active``; a run open at the end of an older read
    is one whose end was not recorded there. A segment whose bounds moved has
    its energy read again.
    """
    landed: list[Segment] = []
    for run in runs:
        is_active = run.open and live
        end_known = run.end_known and not (run.open and not live)
        match = next(
            (
                segment
                for segment in segments
                if segment.power_entity_id == power_entity_id
                and segment.start <= run.end
                and run.start <= segment.end
            ),
            None,
        )
        if match is None:
            segment = Segment(
                id=_iso(run.start),
                start=run.start,
                end=run.end,
                start_known=run.start_known,
                end_known=end_known,
                active=is_active,
                seen_until=read_end,
                power_entity_id=power_entity_id,
                meter_entity_id=meter_entity_id,
            )
            segments.append(segment)
            landed.append(segment)
            continue
        before = (match.start, match.start_known, match.end, match.end_known, match.active)
        if run.start < match.start and (run.start_known or not live):
            match.start, match.start_known = run.start, run.start_known
        elif run.start == match.start:
            match.start_known = match.start_known or run.start_known
        # An older read never ends a segment a live read still sees charging.
        if read_end >= match.seen_until and (live or not match.active):
            match.end, match.end_known, match.active = run.end, end_known, is_active
            match.seen_until = read_end
        if (match.start, match.start_known, match.end, match.end_known, match.active) != before:
            match.energy_final = False
        if match not in landed:
            landed.append(match)
    segments.sort(key=lambda segment: segment.start)
    return landed


def close_unseen(
    segments: Iterable[Segment], *, landed: Sequence[Segment]
) -> list[Segment]:
    """Close the active segments a live read should have seen and did not.

    A segment of another power entity (the config was rebound) is never
    continued by this one's readings. Either way its end stays where it was
    last seen charging, not recorded.
    """
    closed = []
    for segment in segments:
        if not segment.active or segment in landed:
            continue
        segment.active = False
        segment.end_known = False
        segment.energy_final = False
        closed.append(segment)
    return closed


def slice_boundaries(start: datetime, end: datetime) -> list[datetime]:
    """``start``, every UTC hour boundary strictly inside ``[start, end]``, and ``end``."""
    boundaries = [start]
    hour = start.replace(minute=0, second=0, microsecond=0) + _HOUR
    while hour < end:
        boundaries.append(hour)
        hour += _HOUR
    if end > start:
        boundaries.append(end)
    return boundaries


def measured_slices(segment: Segment, deltas: Mapping[datetime, float]) -> list[Slice]:
    """The segment's slices from the meter's ``deltas`` by interval start.

    A slice whose bounds are unchanged keeps what it had where the new read
    has nothing for it: a failed or expired read never empties a known value.
    Its attribution is kept while its energy is.
    """
    previous = {(item.start, item.end): item for item in segment.slices}
    boundaries = slice_boundaries(segment.start, segment.end)
    slices = []
    for start, end in zip(boundaries, boundaries[1:]):
        kwh = deltas.get(start)
        old = previous.get((start, end))
        if old is not None and (kwh is None or old.kwh is not None and abs(old.kwh - kwh) < 1e-9):
            slices.append(old)
        else:
            slices.append(Slice(start=start, end=end, kwh=kwh))
    return slices


def attribute_slice(dataset: DeviceDataset, item: Slice) -> dict[str, Any]:
    """``item``'s kWh split in its hour of the house mix, with its money sides."""
    attribution = attribute_energy(dataset, {item.hour: item.kwh or 0.0})
    return {
        "solar": attribution.solar,
        "battery": attribution.battery,
        "grid": attribution.grid,
        "unknown": attribution.unattributed,
        **{
            side: _money(getattr(attribution, side))
            for side in MONEY_SIDES
        },
    }


def _money(side: MoneySide) -> list[float]:
    return [side.amount, side.priced_kwh, side.unpriced_kwh]


# --- Persistence --------------------------------------------------------------


def _iso(at: datetime | None) -> str | None:
    return None if at is None else dt_util.as_utc(at).isoformat()


def _at(value: Any) -> datetime:
    parsed = dt_util.parse_datetime(str(value))
    if parsed is None:
        raise ValueError(f"not a datetime: {value!r}")
    return dt_util.as_utc(parsed)


def segment_to_dict(segment: Segment) -> dict[str, Any]:
    return {
        "id": segment.id,
        "start": _iso(segment.start),
        "end": _iso(segment.end),
        "start_known": segment.start_known,
        "end_known": segment.end_known,
        "active": segment.active,
        "seen_until": _iso(segment.seen_until),
        "power_entity_id": segment.power_entity_id,
        "meter_entity_id": segment.meter_entity_id,
        "energy_final": segment.energy_final,
        "slices": [
            {
                "start": _iso(item.start),
                "end": _iso(item.end),
                "kwh": item.kwh,
                "attribution": item.attribution,
                "final": item.final,
            }
            for item in segment.slices
        ],
    }


def segment_from_dict(raw: Mapping[str, Any]) -> Segment:
    """A stored segment; raises on a record that is not one."""
    return Segment(
        id=str(raw["id"]),
        start=_at(raw["start"]),
        end=_at(raw["end"]),
        start_known=bool(raw["start_known"]),
        end_known=bool(raw["end_known"]),
        active=bool(raw["active"]),
        seen_until=_at(raw["seen_until"]),
        power_entity_id=str(raw["power_entity_id"]),
        meter_entity_id=raw.get("meter_entity_id"),
        energy_final=bool(raw.get("energy_final")),
        slices=[
            Slice(
                start=_at(item["start"]),
                end=_at(item["end"]),
                kwh=None if item.get("kwh") is None else float(item["kwh"]),
                attribution=item.get("attribution"),
                final=bool(item.get("final")),
            )
            for item in raw.get("slices") or []
        ],
    )

