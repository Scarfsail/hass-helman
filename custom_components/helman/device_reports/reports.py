"""The report registry: each report is a spec built on the shared device dataset.

A report never handles a period, a recorder read or a price itself. It is a
``build(dataset, query) -> dict`` over :class:`~.dataset.DeviceDataset`, and
:func:`build_report` wraps whatever it returns in the fields every report
carries. Adding a report is a spec here, a registry entry in the card and an
element to render it.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from ..span_buckets import period_buckets
from .dataset import Attribution, DatasetNode, DeviceDataset, MoneySide, attribute_energy

#: The widest period a report may cover, in days, inclusive.
MAX_REPORT_DAYS = 366


@dataclass(frozen=True)
class ReportQuery:
    """The period a report is asked for, local dates, both inclusive.

    ``granularity`` is one of :data:`~..span_buckets.BUCKETS`; only a report
    whose spec ``uses_granularity`` reads it.
    """

    start_date: date
    end_date: date
    granularity: str = "day"


@dataclass(frozen=True)
class ReportSpec:
    build: Callable[[DeviceDataset, ReportQuery], dict[str, Any]]
    #: The report is bucketed by ``query.granularity``, so the card offers it.
    uses_granularity: bool = False


def _round_kwh(value: float) -> float:
    return round(value, 3)


def _round_money(value: float | None) -> float | None:
    return None if value is None else round(value, 3)


def _round_rate(value: float | None) -> float | None:
    return None if value is None else round(value, 6)


def _money_side(side: MoneySide, *, tariff: bool) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "amount": _round_money(side.known_amount),
        "priced_kwh": _round_kwh(side.priced_kwh),
        "unpriced_kwh": _round_kwh(side.unpriced_kwh),
    }
    if tariff:
        payload["tariff_kwh"] = _round_kwh(side.tariff_kwh)
    return payload


def _sources(attribution: Attribution) -> dict[str, float]:
    return {
        "solar": _round_kwh(attribution.solar),
        "battery": _round_kwh(attribution.battery),
        "grid": _round_kwh(attribution.grid),
        "unattributed": _round_kwh(attribution.unattributed),
    }


def _local_iso(dataset: DeviceDataset, instant: datetime | None) -> str | None:
    return None if instant is None else instant.astimezone(dataset.local_tz).isoformat()


def _ranking_node(dataset: DeviceDataset, node: DatasetNode) -> dict[str, Any]:
    attribution = attribute_energy(dataset, node.kwh)
    covered = sum(node.coverage.values())
    return {
        "id": node.id,
        "parent_id": node.parent_id,
        "depth": node.depth,
        "label": node.label,
        "icon": node.icon,
        "estimated": node.estimated,
        "unmeasured": node.unmeasured,
        "children": list(node.children),
        "kwh": _round_kwh(node.total_kwh),
        "sources": _sources(attribution),
        "money": {
            "paid": _money_side(attribution.paid, tariff=True),
            "forgone": _money_side(attribution.forgone, tariff=False),
        },
        "coverage": (
            round(min(1.0, covered / dataset.elapsed_hours), 4)
            if dataset.elapsed_hours > 0
            else 0.0
        ),
        "first_hour": _local_iso(dataset, node.first_hour),
        "overallocated_kwh": _round_kwh(node.overallocated_kwh),
    }


def _build_ranking(dataset: DeviceDataset, query: ReportQuery) -> dict[str, Any]:
    """Every node of the house subtree, with its kWh, sources and money.

    Flat and pre-order, each node naming its children; ``nodes[0]`` is the
    house. Sorting is the card's: it is a control, and no fetch depends on it.
    """
    return {"nodes": [_ranking_node(dataset, node) for node in dataset.nodes]}


def _bucket_sums(
    kwh: dict[datetime, float], bucket_of: dict[datetime, int], count: int
) -> list[float]:
    """``kwh`` folded into ``count`` buckets, in one pass over its own hours."""
    sums = [0.0] * count
    for hour, value in kwh.items():
        index = bucket_of.get(hour)
        if index is not None:
            sums[index] += value
    return [_round_kwh(value) for value in sums]


def _build_over_time(dataset: DeviceDataset, query: ReportQuery) -> dict[str, Any]:
    """Every top-level device's kWh per bucket of ``query.granularity``.

    ``series`` holds all top-level devices, ranked once by their period total
    rather than per bucket, so a device keeps its place, and its colour, in
    every column; the card cuts its Top X from them. Per bucket, ``house`` is
    the house meter, ``unmeasured`` the house's remainder and ``overallocated``
    the house's over-allocation, so over the hours the house meter measured
    ``Σ values + unmeasured − overallocated = house``.
    """
    by_id = {node.id: node for node in dataset.nodes}
    house = dataset.house
    children = [by_id[child] for child in house.children]
    devices = sorted(
        (node for node in children if not node.unmeasured),
        key=lambda node: node.total_kwh,
        reverse=True,
    )
    unmeasured = next((node for node in children if node.unmeasured), None)

    spans = period_buckets(dataset.local_start, dataset.local_end, query.granularity, dataset.now)
    bucket_of = {hour: index for index, span in enumerate(spans) for hour in span.hours}

    def sums(kwh: dict[datetime, float]) -> list[float]:
        return _bucket_sums(kwh, bucket_of, len(spans))

    house_kwh = sums(house.kwh)
    overallocated = sums(house.overallocated)
    unmeasured_kwh = sums(unmeasured.kwh) if unmeasured else [0.0] * len(spans)
    device_kwh = {node.id: sums(node.kwh) for node in devices}
    return {
        "buckets": [
            {
                "start": span.start_date.isoformat(),
                "end": span.end_date.isoformat(),
                "partial": span.partial,
                "house": house_kwh[index],
                "values": {node_id: values[index] for node_id, values in device_kwh.items()},
                "unmeasured": unmeasured_kwh[index],
                "overallocated": overallocated[index],
            }
            for index, span in enumerate(spans)
        ],
        "series": [
            {
                "id": node.id,
                "label": node.label,
                "icon": node.icon,
                "estimated": node.estimated,
                "first_hour": _local_iso(dataset, node.first_hour),
            }
            for node in devices
        ],
    }


REPORTS: dict[str, ReportSpec] = {
    "ranking": ReportSpec(build=_build_ranking),
    "over_time": ReportSpec(build=_build_over_time, uses_granularity=True),
}


def build_report(
    report: str,
    dataset: DeviceDataset,
    query: ReportQuery,
    *,
    currency: str | None,
    navigation_range: dict[str, str],
) -> dict[str, Any]:
    """One report's payload, with the fields every report carries."""
    spec = REPORTS[report]
    origin = dataset.charge_origin
    house = attribute_energy(dataset, dataset.house.kwh)
    return {
        **spec.build(dataset, query),
        "report": report,
        "start_date": query.start_date.isoformat(),
        "end_date": query.end_date.isoformat(),
        **({"granularity": query.granularity} if spec.uses_granularity else {}),
        "currency": currency,
        "charge_origin": {
            "charged_kwh": _round_kwh(origin.charged_kwh),
            "grid": round(origin.grid, 4),
            "grid_recorded": round(origin.grid_recorded, 4),
            "grid_tariff": round(origin.grid_tariff, 4),
            "grid_unpriced": round(origin.grid_unpriced, 4),
            "solar": round(origin.solar, 4),
            "solar_priced": round(origin.solar_priced, 4),
            "solar_unpriced": round(origin.solar_unpriced, 4),
            "unknown": round(origin.unknown, 4),
            "paid_rate": _round_rate(origin.paid_rate),
            "forgone_rate": _round_rate(origin.forgone_rate),
        },
        "house_kwh": _round_kwh(dataset.house.total_kwh),
        "ambiguous_kwh": _round_kwh(dataset.ambiguous_kwh),
        "unattributed_kwh": _round_kwh(house.unattributed),
        "mismatch_kwh": _round_kwh(dataset.mismatch_kwh),
        "meters": dict(dataset.meters),
        "as_of": dataset.now.isoformat(),
        "complete": dataset.complete,
        "range": navigation_range,
    }
