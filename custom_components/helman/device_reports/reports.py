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

from .dataset import Attribution, DatasetNode, DeviceDataset, MoneySide, attribute_energy

#: The widest period a report may cover, in days, inclusive.
MAX_REPORT_DAYS = 366


@dataclass(frozen=True)
class ReportQuery:
    """The period a report is asked for, local dates, both inclusive."""

    start_date: date
    end_date: date


@dataclass(frozen=True)
class ReportSpec:
    build: Callable[[DeviceDataset, ReportQuery], dict[str, Any]]


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


REPORTS: dict[str, ReportSpec] = {
    "ranking": ReportSpec(build=_build_ranking),
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
    origin = dataset.charge_origin
    house = attribute_energy(dataset, dataset.house.kwh)
    return {
        **REPORTS[report].build(dataset, query),
        "report": report,
        "start_date": query.start_date.isoformat(),
        "end_date": query.end_date.isoformat(),
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
