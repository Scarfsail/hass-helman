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


def _coverage(dataset: DeviceDataset, node: DatasetNode) -> float:
    """The node's covered hours over the period's elapsed hours, 0..1."""
    if dataset.elapsed_hours <= 0:
        return 0.0
    return round(min(1.0, sum(node.coverage.values()) / dataset.elapsed_hours), 4)


def _node_fields(dataset: DeviceDataset, node: DatasetNode) -> dict[str, Any]:
    """What every report says about a node's identity, size and data coverage."""
    return {
        "id": node.id,
        "label": node.label,
        "icon": node.icon,
        "estimated": node.estimated,
        "unmeasured": node.unmeasured,
        "kwh": _round_kwh(node.total_kwh),
        "coverage": _coverage(dataset, node),
        "first_hour": _local_iso(dataset, node.first_hour),
    }


def _ranking_node(dataset: DeviceDataset, node: DatasetNode) -> dict[str, Any]:
    attribution = attribute_energy(dataset, node.kwh)
    return {
        **_node_fields(dataset, node),
        "parent_id": node.parent_id,
        "depth": node.depth,
        "children": list(node.children),
        "sources": _sources(attribution),
        "money": {
            "paid": _money_side(attribution.paid, tariff=True),
            "forgone": _money_side(attribution.forgone, tariff=False),
        },
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
    house = dataset.house
    children = _top_level(dataset)
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


def _top_level(dataset: DeviceDataset) -> list[DatasetNode]:
    """The house's children: its top-level devices and its remainder."""
    by_id = {node.id: node for node in dataset.nodes}
    return [by_id[child] for child in dataset.house.children]


def _hour_of_day_means(
    values: dict[datetime, float],
    weights: dict[datetime, float],
    hour_of_day: dict[datetime, int],
) -> list[float | None]:
    """``Σ values ÷ Σ weights`` per local hour of day, over the hours with a weight.

    ``None`` for an hour of day nothing weighed in on. Keyed by UTC hour, so
    the fall-back day's repeated hour counts twice in both sums and the
    spring-forward day's missing hour in neither: neither skews the mean.
    """
    sums = [0.0] * 24
    totals = [0.0] * 24
    for hour, weight in weights.items():
        index = hour_of_day.get(hour)
        if index is None or weight <= 0:
            continue
        sums[index] += values.get(hour, 0.0)
        totals[index] += weight
    return [sums[i] / totals[i] if totals[i] > 0 else None for i in range(24)]


def _build_daily_profile(dataset: DeviceDataset, query: ReportQuery) -> dict[str, Any]:
    """Each top-level device's, and the house remainder's, mean W per local hour.

    A row averages over the hours it was observed -- its coverage, the hour in
    progress by its elapsed part -- so a device that starts mid-period, or has
    gaps, is not diluted by the hours it has no data for; an hour of day with
    none is ``None``, not 0. Rows are in period-kWh order. The import and export
    rates are plain means per local hour over the elapsed hours that had one.
    """
    hour_of_day = {hour: hour.astimezone(dataset.local_tz).hour for hour in dataset.hours}
    rows = sorted(_top_level(dataset), key=lambda node: node.total_kwh, reverse=True)

    def rate_means(rates: dict[datetime, float]) -> list[float | None]:
        elapsed = {hour: 1.0 for hour in rates if hour < dataset.now}
        return [_round_rate(rate) for rate in _hour_of_day_means(rates, elapsed, hour_of_day)]

    return {
        "rows": [
            {
                **_node_fields(dataset, node),
                "watts": [
                    None if kw is None else round(kw * 1000.0, 1)
                    for kw in _hour_of_day_means(node.kwh, node.coverage, hour_of_day)
                ],
            }
            for node in rows
        ],
        "import_rate": rate_means(dataset.import_rate),
        "export_rate": rate_means(dataset.export_rate),
    }


REPORTS: dict[str, ReportSpec] = {
    "ranking": ReportSpec(build=_build_ranking),
    "over_time": ReportSpec(build=_build_over_time, uses_granularity=True),
    "daily_profile": ReportSpec(build=_build_daily_profile),
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
