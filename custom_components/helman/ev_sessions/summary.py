"""The charging ledger as the EV detail reads it: the last 30 days, the newest segments.

**The window** is ``[now − 30 days, now]`` as UTC instants, sliding. Its totals
sum the ledger's hourly slices starting inside it, so a segment crossing the
window's start counts only its slices after it, and the segment still
charging counts once, as far as it was read.

**Money** keeps its coverage: an amount comes with the kWh it priced and the
kWh it could not. Paid per kWh is all paid money over priced charger kWh, the
solar share free; the grid's price is the grid's paid money over priced grid
kWh. Forgone export value is the direct solar share's, its own figure: never
part of paid; its rate is that value over the priced solar kWh. ``virtual``
adds it to paid, over the kWh priced on both sides: what a charged kWh costs
had that solar been exported instead. The battery's
paid money is what is left of paid once the grid's is taken out (the solar
share pays nothing), so it reads from the stored slices as they are; its rate
is that money over the battery kWh its charge origin priced. A slice not yet attributed (no house dataset answered for its day)
is unknown source and unpriced, never free.

**Charging days** are the local days (HA's time zone) on which a segment with
delivered energy starts, inside the window: three segments on one day are one
charge. ``coveredDays`` is how many of the window's 30 days the ledger has
read (from the later of the window's start and where its records begin, in
whole days up); ``perWeek`` is charging days over the covered days, times 7.
``secondsPerDay`` is the counted segments' charging time (start to end, the
one still charging up to its last read) over the charging days.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from datetime import datetime, timedelta, tzinfo
from typing import Any


from .ledger import MONEY_SIDES, Segment, Slice, _iso

WINDOW = timedelta(days=30)
#: How many of the newest segments the detail lists.
RECENT_SEGMENTS = 20
_EPSILON_KWH = 1e-9


class _Totals:
    """Slices summed: kWh, the source split and every money side."""

    def __init__(self) -> None:
        self.kwh = 0.0
        self.attributed_kwh = 0.0
        self.sources = {"solar": 0.0, "battery": 0.0, "grid": 0.0}
        self.money = {side: [0.0, 0.0, 0.0] for side in MONEY_SIDES}

    def add(self, item: Slice) -> None:
        if item.kwh is None:
            return
        self.kwh += item.kwh
        attribution = item.attribution
        if attribution is None:
            # Not attributed: unknown source, and unpriced on every side.
            for side in self.money.values():
                side[2] += item.kwh
            return
        self.attributed_kwh += item.kwh
        for source in self.sources:
            self.sources[source] += float(attribution.get(source) or 0.0)
        for name, side in self.money.items():
            amount, priced, unpriced = attribution.get(name) or (0.0, 0.0, item.kwh)
            side[0] += amount
            side[1] += priced
            side[2] += unpriced

    def battery_paid(self) -> list[float]:
        """The battery share's paid side: paid less the grid's, its priced kWh less the grid's and the free solar's.

        Unpriced, like every side, includes the slices not attributed yet.
        """
        paid, grid = self.money["paid"], self.money["grid_paid"]
        priced = max(0.0, paid[1] - grid[1] - self.sources["solar"])
        return [paid[0] - grid[0], priced, max(0.0, self.sources["battery"] - priced) + self.kwh - self.attributed_kwh]

    def virtual(self) -> list[float]:
        """Paid plus the direct solar's export value: the cost had that solar been exported instead.

        Priced on the kWh paid prices less the solar kWh no export rate
        prices, so each kWh it divides by is priced on both sides. Only the
        direct solar counts, as on the solar figure; the battery's solar
        share stays free.
        """
        paid, solar = self.money["paid"], self.money["solar_forgone"]
        priced = max(0.0, paid[1] - (self.sources["solar"] - solar[1]))
        return [paid[0] + solar[0], priced, max(0.0, self.kwh - priced)]

    def payload(self) -> dict[str, Any]:
        known = sum(self.sources.values())
        money = {**self.money, "battery_paid": self.battery_paid(), "virtual": self.virtual()}
        return {
            "kwh": self.kwh,
            # ``None`` when nothing at all is attributed: the source is unknown, not zero.
            "sources": (
                None
                if self.attributed_kwh <= _EPSILON_KWH and self.kwh > _EPSILON_KWH
                else {**self.sources, "unknown": max(0.0, self.kwh - known)}
            ),
            "knownKwh": known,
            **{
                _camel(name): {"amount": amount, "pricedKwh": priced, "unpricedKwh": unpriced}
                for name, (amount, priced, unpriced) in money.items()
            },
        }


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part.title() for part in rest)


def _rate(money: dict[str, float]) -> float | None:
    return money["amount"] / money["pricedKwh"] if money["pricedKwh"] > _EPSILON_KWH else None


def window_summary(
    segments: Iterable[Segment], *, now: datetime, local_tz: tzinfo, recorded_since: datetime | None = None
) -> dict[str, Any]:
    """The last 30 days' totals, charging days and rates; ``recorded_since`` is where the ledger's records begin."""
    start = now - WINDOW
    covered = now - max(start, recorded_since or start)
    covered_days = min(WINDOW.days, max(1, math.ceil(covered / timedelta(days=1))))
    totals = _Totals()
    days = set()
    charging_time = timedelta()
    provisional = False
    for segment in segments:
        included = [item for item in segment.slices if start <= item.start < now]
        for item in included:
            totals.add(item)
        if included and segment.active:
            provisional = True
        if start <= segment.start < now and segment.kwh > _EPSILON_KWH:
            days.add(segment.start.astimezone(local_tz).date())
            charging_time += max(timedelta(), segment.end - segment.start)
    payload = totals.payload()
    return {
        "window": {"start": _iso(start), "end": _iso(now)},
        "totals": {**payload, "provisional": provisional},
        "chargingDays": len(days),
        "coveredDays": covered_days,
        "perWeek": len(days) / covered_days * 7,
        "secondsPerDay": charging_time.total_seconds() / len(days) if days else None,
        "paidPerKwh": _rate(payload["paid"]),
        "gridPricePerKwh": _rate(payload["gridPaid"]),
        "batteryPricePerKwh": _rate(payload["batteryPaid"]),
        "solarForgonePerKwh": _rate(payload["solarForgone"]),
        # Only where some solar has an export value: otherwise it is the paid rate.
        "virtualPerKwh": _rate(payload["virtual"]) if payload["solarForgone"]["pricedKwh"] > _EPSILON_KWH else None,
    }


def recent_segments(
    segments: Sequence[Segment], *, local_tz: tzinfo, limit: int = RECENT_SEGMENTS
) -> list[dict[str, Any]]:
    """The newest ``limit`` segments, newest first, whatever the window."""
    newest = sorted(segments, key=lambda segment: segment.start, reverse=True)[:limit]
    result = []
    for segment in newest:
        totals = _Totals()
        for item in segment.slices:
            totals.add(item)
        payload = totals.payload()
        result.append(
            {
                "id": segment.id,
                "start": _iso(segment.start),
                "end": _iso(segment.end),
                "localDate": segment.start.astimezone(local_tz).date().isoformat(),
                "startKnown": segment.start_known,
                "endKnown": segment.end_known,
                "status": "active" if segment.active else "closed",
                "final": segment.energy_final and all(item.final for item in segment.slices),
                "kwhComplete": segment.kwh_complete,
                **payload,
            }
        )
    return result
