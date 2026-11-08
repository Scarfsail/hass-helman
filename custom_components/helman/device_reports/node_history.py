"""One house-subtree node's energy and money, as every consumer's detail shows them.

Pure: built on the device dataset the reports share, so a node's history is
the same hourly kWh, source mix and money the device reports read. One node,
whatever it is -- a metered device, an estimated child, a breaker with its
whole meter or the unmeasured remainder -- gets the same payload; the only
per-kind difference is :data:`HOUR_FLOOR_KWH`.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date, datetime
from typing import Any

from ..controllables.kinds import CONTROLLABLE_KIND_EV_CHARGER
from ..span_buckets import period_buckets
from .dataset import DeviceDataset, MoneySide, attribute_energy, find_house_node
from .reports import _money_side, _node_fields, _round_kwh, _round_rate

#: Hours below this many kWh are dropped from a node's history, by appliance kind.
#:
#: The EV charger's standby draw would otherwise count as charging. The
#: ledger tells charging from standby by charge power
#: (:data:`~..ev_sessions.ledger.CHARGING_POWER_W`), a test hourly kWh cannot
#: apply; 0.1 kWh in an hour sits far above standby and below any hour with
#: charging in it. Every other node uses 0.
HOUR_FLOOR_KWH = {CONTROLLABLE_KIND_EV_CHARGER: 0.1}
#: A local day whose kWh (after the floor) exceeds this is an active day.
ACTIVE_DAY_KWH = 0.05
_EPSILON_KWH = 1e-9


def hour_floor_kwh(tree: Any, node_id: str) -> float:
    """The hourly floor for ``node_id``, from its tree node's ``applianceKind``."""

    def _find(node: Mapping[str, Any]) -> Mapping[str, Any] | None:
        if node.get("id") == node_id:
            return node
        for child in node.get("children") or []:
            found = _find(child) if isinstance(child, Mapping) else None
            if found is not None:
                return found
        return None

    house = find_house_node(tree)
    found = _find(house) if house is not None else None
    return HOUR_FLOOR_KWH.get(found.get("applianceKind"), 0.0) if found is not None else 0.0


def _rate(side: MoneySide) -> float | None:
    return _round_rate(side.amount / side.priced_kwh) if side.priced_kwh > _EPSILON_KWH else None


def _series(dataset: DeviceDataset, kwh: dict[datetime, float]) -> tuple[str, list[dict[str, Any]]]:
    """``kwh`` per hour of a one-day period, or per local day of a longer one, by source.

    Every bucket of the period is there, zero where nothing ran, each
    attributed on its own hours so the buckets sum to the totals.
    """
    days = period_buckets(dataset.local_start, dataset.local_end, "day", dataset.now)
    if len(days) == 1:
        bucket = "hour"
        spans = [(hour.astimezone(dataset.local_tz).isoformat(), [hour]) for hour in dataset.hours]
    else:
        bucket = "day"
        spans = [(day.start_date.isoformat(), day.hours) for day in days]
    series = []
    for start, hours in spans:
        bucket_kwh = {hour: kwh[hour] for hour in hours if hour in kwh}
        attribution = attribute_energy(dataset, bucket_kwh)
        series.append(
            {
                "start": start,
                "kwh": _round_kwh(sum(bucket_kwh.values())),
                "solar": _round_kwh(attribution.solar),
                "battery": _round_kwh(attribution.battery),
                "grid": _round_kwh(attribution.grid),
                "unknown": _round_kwh(attribution.unattributed),
            }
        )
    return bucket, series


def build_node_history(
    dataset: DeviceDataset,
    node_id: str,
    *,
    hour_floor_kwh: float,
    price_unit: str | None,
    navigation_range: dict[str, str],
) -> dict[str, Any]:
    """``node_id``'s kWh, sources, money and how often it ran, over the dataset's period and per bucket of it.

    Hours below ``hour_floor_kwh`` are dropped before anything is summed.
    """
    node = next((item for item in dataset.nodes if item.id == node_id), None)
    if node is None:
        return {"unavailable": "unknown_node"}
    kwh = {hour: value for hour, value in node.kwh.items() if value >= hour_floor_kwh}
    attribution = attribute_energy(dataset, kwh)
    total = sum(kwh.values())
    known = attribution.solar + attribution.battery + attribution.grid

    by_day: dict[date, float] = {}
    for hour, value in kwh.items():
        day = hour.astimezone(dataset.local_tz).date()
        by_day[day] = by_day.get(day, 0.0) + value
    active = [value for value in by_day.values() if value > ACTIVE_DAY_KWH]
    covered_days = max(
        1,
        len({hour.astimezone(dataset.local_tz).date() for hour, share in node.coverage.items() if share > 0}),
    )

    battery_paid = attribution.battery_paid()
    virtual = attribution.virtual()
    bucket, series = _series(dataset, kwh)
    return {
        **_node_fields(dataset, node),
        "startDate": dataset.local_start.date().isoformat(),
        "endDate": dataset.hours[-1].astimezone(dataset.local_tz).date().isoformat(),
        "priceUnit": price_unit,
        "complete": dataset.complete,
        "navigationRange": navigation_range,
        "bucket": bucket,
        "series": series,
        "totals": {
            "kwh": _round_kwh(total),
            # ``None`` when nothing at all is attributed: the source is unknown, not zero.
            "sources": (
                None
                if known <= _EPSILON_KWH and total > _EPSILON_KWH
                else {
                    "solar": _round_kwh(attribution.solar),
                    "battery": _round_kwh(attribution.battery),
                    "grid": _round_kwh(attribution.grid),
                    "unknown": _round_kwh(attribution.unattributed),
                }
            ),
            "knownKwh": _round_kwh(known),
            "paid": _money_side(attribution.paid, tariff=False),
            "forgone": _money_side(attribution.forgone, tariff=False),
            "gridPaid": _money_side(attribution.grid_paid, tariff=False),
            "batteryPaid": _money_side(battery_paid, tariff=False),
            "solarForgone": _money_side(attribution.solar_forgone, tariff=False),
            "virtual": _money_side(virtual, tariff=False),
        },
        "paidPerKwh": _rate(attribution.paid),
        "gridPricePerKwh": _rate(attribution.grid_paid),
        "batteryPricePerKwh": _rate(battery_paid),
        "solarForgonePerKwh": _rate(attribution.solar_forgone),
        # Only where some solar has an export value: otherwise it is the paid rate.
        "virtualPerKwh": _rate(virtual) if attribution.solar_forgone.priced_kwh > _EPSILON_KWH else None,
        "activeDays": len(active),
        "coveredDays": covered_days,
        "perWeek": len(active) / covered_days * 7,
        "kwhPerActiveDay": _round_kwh(sum(active) / len(active)) if active else None,
    }
