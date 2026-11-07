"""The charging ledger as the EV detail reads it: the newest segments.

**Money** keeps its coverage: an amount comes with the kWh it priced and the
kWh it could not. The battery's paid side and the virtual cost are derived by
:class:`~..device_reports.dataset.Attribution`, the one place those formulas
live, from the stored slices as they are. A slice not yet attributed (no house
dataset answered for its day) is unknown source and unpriced, never free.

The last 30 days' totals are not the ledger's: the node history
(:mod:`~..device_reports.node_history`) builds them from the device dataset.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import tzinfo
from typing import Any

from ..device_reports.dataset import Attribution
from .ledger import MONEY_SIDES, Segment, Slice, _iso

#: How many of the newest segments the detail lists.
RECENT_SEGMENTS = 20
_EPSILON_KWH = 1e-9


class _Totals:
    """Slices summed into one :class:`Attribution`: kWh, the source split and every money side."""

    def __init__(self) -> None:
        self.kwh = 0.0
        self.attributed_kwh = 0.0
        self.attribution = Attribution()

    def add(self, item: Slice) -> None:
        if item.kwh is None:
            return
        self.kwh += item.kwh
        attribution = item.attribution
        if attribution is None:
            # Not attributed: unknown source, and unpriced on every side.
            self.attribution.unattributed += item.kwh
            for name in MONEY_SIDES:
                getattr(self.attribution, name).unpriced_kwh += item.kwh
            return
        self.attributed_kwh += item.kwh
        self.attribution.solar += float(attribution.get("solar") or 0.0)
        self.attribution.battery += float(attribution.get("battery") or 0.0)
        self.attribution.grid += float(attribution.get("grid") or 0.0)
        self.attribution.unattributed += float(attribution.get("unknown") or 0.0)
        for name in MONEY_SIDES:
            amount, priced, unpriced = attribution.get(name) or (0.0, 0.0, item.kwh)
            side = getattr(self.attribution, name)
            side.amount += amount
            side.priced_kwh += priced
            side.unpriced_kwh += unpriced

    def payload(self) -> dict[str, Any]:
        attribution = self.attribution
        sources = {"solar": attribution.solar, "battery": attribution.battery, "grid": attribution.grid}
        known = sum(sources.values())
        money = {
            **{name: getattr(attribution, name) for name in MONEY_SIDES},
            "battery_paid": attribution.battery_paid(),
            "virtual": attribution.virtual(),
        }
        return {
            "kwh": self.kwh,
            # ``None`` when nothing at all is attributed: the source is unknown, not zero.
            "sources": (
                None
                if self.attributed_kwh <= _EPSILON_KWH and self.kwh > _EPSILON_KWH
                else {**sources, "unknown": max(0.0, self.kwh - known)}
            ),
            "knownKwh": known,
            **{
                _camel(name): {"amount": side.amount, "pricedKwh": side.priced_kwh, "unpricedKwh": side.unpriced_kwh}
                for name, side in money.items()
            },
        }


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part.title() for part in rest)


def recent_segments(
    segments: Sequence[Segment], *, local_tz: tzinfo, limit: int = RECENT_SEGMENTS
) -> list[dict[str, Any]]:
    """The newest ``limit`` segments, newest first."""
    newest = sorted(segments, key=lambda segment: segment.start, reverse=True)[:limit]
    result = []
    for segment in newest:
        totals = _Totals()
        for item in segment.slices:
            totals.add(item)
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
                **totals.payload(),
            }
        )
    return result
