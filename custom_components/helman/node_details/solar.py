"""The solar detail: today's production against the forecast, where it went, what limits it.

The overview carries the entity ids the card reads live: the solar node's own
power and today-energy meters, the lifetime counter bias correction trains on,
the grid's today-export meter, and the hardware profile's string readings,
caps and settings (telemetry). Beside them it carries the facts only the
backend can tell: which strings the profile maps, the configured capacity and
Helman's export cap. The forecast and the plan come from the existing forecast
and schedule clients, so they are not repeated.

Three history sections, each read only while its answer is open:

* ``production``: today's solar power from :func:`.day_stats.async_day_stats`,
  for the peak and its time;
* ``power``: the total solar power and each string's over the last 24 hours,
  and the energy each string delivered today, integrated over the time it was
  known and over the period all were;
* ``destinations``: where today's solar went, from the device reports'
  ranking via :func:`solar_destinations`.

The string energies are estimates from five-minute means, and nothing here is
normalised by a string's size or orientation, which are not known.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
import math
from typing import Any

from homeassistant.util import dt as dt_util

from ..vendors import INVERTER_TELEMETRY_KEY
from .battery import charge_origin_kwh, today_ranking_report
from .context import NodeDetailContext
from .day_stats import (
    BUCKET,
    async_day_stats,
    day_window,
    in_watts,
    last_24h_window,
    node_config,
    node_entity,
    node_power,
)
from .grid import money_amount
from .inverter import run_mode_condition

STRINGS = (1, 2)

#: The telemetry the solar answers read, by metric key.
_TELEMETRY_KEYS = (
    *(f"pv_{quantity}_{string}" for quantity in ("power", "voltage", "current") for string in STRINGS),
    *(f"shade_fix_pv{string}" for string in STRINGS),
    "rated_power",
    "mppt_count",
    "pv_power_limit",
    "export_limit",
    "use_mode",
    "manual_mode",
    "run_mode",
)


def build_solar_overview(
    hass: Any, ctx: NodeDetailContext, now: datetime
) -> dict[str, Any]:
    """The solar node's mappings and overview facts; no recorder read.

    ``profile`` is ``None`` for a Custom inverter: the telemetry keys are then
    absent from ``entities``. A telemetry key the profile has but the registry
    does not (disabled, missing) is present as ``None``. ``strings`` are the
    strings whose power the profile resolves; the chart draws them with two.
    """
    config = ctx.config
    telemetry = ctx.telemetry.get(INVERTER_TELEMETRY_KEY)
    solar = node_config(config, "solar")
    grid = node_config(config, "grid")

    entities: dict[str, str | None] = {}
    if telemetry is not None:
        for key in _TELEMETRY_KEYS:
            if key in telemetry.entities:
                entities[key] = telemetry.entities[key]
    entities["power"] = node_entity(solar, "power")
    entities["today_energy"] = node_entity(solar, "today_energy")
    entities["today_export"] = node_entity(grid, "today_export")
    training = config.get("training") if isinstance(config, Mapping) else None
    solar_bias = training.get("solar_bias") if isinstance(training, Mapping) else None
    lifetime = solar_bias.get("total_energy_entity_id") if isinstance(solar_bias, Mapping) else None
    entities["lifetime_energy"] = lifetime if isinstance(lifetime, str) and lifetime else None

    strings = [string for string in STRINGS if entities.get(f"pv_power_{string}")]
    sections = ["production"] if entities["power"] else []
    if entities["power"] or strings:
        sections.append("power")
    sections.append("destinations")
    return {
        "node": "solar",
        "asOf": dt_util.as_local(now).isoformat(),
        "profile": (
            None
            if telemetry is None
            else {"id": telemetry.profile.id, "label": telemetry.profile.label}
        ),
        "entities": entities,
        "strings": strings,
        "configuredMaxPowerW": _positive(solar.get("max_power")),
        "maxAllowedExportPower": grid.get("max_allowed_export_power"),
        "condition": run_mode_condition(hass, telemetry),
        "sections": sections,
    }


async def async_solar_section(
    hass: Any, ctx: NodeDetailContext, section: str, now: datetime
) -> dict[str, Any]:
    """One of the solar node's history sections: ``power`` over the last 24 hours, the others over today so far."""
    config = ctx.config
    local_now = dt_util.as_local(now)
    start, end = last_24h_window(now) if section == "power" else day_window(local_now)
    payload: dict[str, Any] = {
        "node": "solar",
        "section": section,
        "asOf": local_now.isoformat(),
        "period": {
            "start": dt_util.as_local(start).isoformat(),
            "end": dt_util.as_local(end).isoformat(),
        },
    }
    if section == "destinations":
        return {**payload, **await _destinations(ctx, local_now)}
    solar = node_config(config, "solar")
    power_id = node_entity(solar, "power")
    if section == "production":
        stats = (
            await async_day_stats(hass, [power_id], start=start, end=end, now=now)
            if power_id
            else {}
        )
        return {**payload, **node_power(stats, solar, "solar")}
    telemetry = ctx.telemetry.get(INVERTER_TELEMETRY_KEY)
    entity_ids = {
        str(string): None if telemetry is None else telemetry.entities.get(f"pv_power_{string}")
        for string in STRINGS
    }
    stats = await async_day_stats(
        hass, [power_id, *entity_ids.values()], start=start, end=end, now=now
    )
    # The energy stays today's: a second read over today so far.
    day_start, day_end = day_window(local_now)
    today = await async_day_stats(
        hass, entity_ids.values(), start=day_start, end=day_end, now=now
    )

    def watts(days: Mapping[str, Mapping[str, Any]]) -> dict[str, Any]:
        return {
            string: in_watts(days[entity_id]) if entity_id and entity_id in days else None
            for string, entity_id in entity_ids.items()
        }

    days = watts(stats)
    return {
        **payload,
        **node_power(stats, solar, "solar"),
        "strings": {
            string: None
            if not entity_id or entity_id not in stats
            else {"entityId": entity_id, "unit": stats[entity_id]["unit"], "day": days[string]}
            for string, entity_id in entity_ids.items()
        },
        "energy": string_energy(
            watts(today), start=day_start, stop=min(day_end, dt_util.as_utc(now))
        ),
    }


def string_energy(
    days: Mapping[str, Mapping[str, Any] | None],
    *,
    start: datetime,
    stop: datetime,
) -> dict[str, Any]:
    """Each string's energy today, and the strings' shares over a common period.

    A string's energy integrates its five-minute means over the time each was
    known: ``Σ mean_W × covered_hours / 1000``. A gap stays missing, never a
    zero, so two strings known for different stretches are not comparable;
    ``common`` integrates every string with any reading over only the buckets
    all of them know, each bucket for the time its least-known string was
    known, so their kWh compare like with like. ``coverage`` is that common
    period's share of the elapsed day. A negative mean, which PV power cannot
    be, counts as zero. Fewer than two strings with readings compare nothing.
    """
    elapsed = max((stop - start).total_seconds(), 0.0)

    def seconds(point: Mapping[str, Any]) -> float:
        bucket = datetime.fromisoformat(point["start"])
        return max((min(bucket + BUCKET, stop) - bucket).total_seconds(), 0.0)

    def kwh(mean: float, covered_seconds: float) -> float:
        return max(mean, 0.0) * covered_seconds / 3_600_000

    strings: dict[str, Any] = {}
    by_string: dict[str, dict[str, Mapping[str, Any]]] = {}
    for string, day in days.items():
        if day is None:
            strings[string] = {"kwh": None, "coverage": 0.0}
            continue
        points = day.get("points", [])
        strings[string] = {
            "kwh": round(sum(kwh(p["mean"], seconds(p) * p["coverage"]) for p in points), 3),
            "coverage": day.get("coverage", 0.0),
        }
        if points:
            by_string[string] = {point["start"]: point for point in points}

    compared = sorted(by_string)
    common: dict[str, Any] = {"strings": [int(string) for string in compared], "coverage": 0.0, "kwh": None}
    if len(compared) < 2 or elapsed <= 0:
        return {"strings": strings, "common": common}
    totals = {string: 0.0 for string in compared}
    covered = 0.0
    for bucket in set.intersection(*(set(by_string[string]) for string in compared)):
        points = [by_string[string][bucket] for string in compared]
        known = seconds(points[0]) * min(point["coverage"] for point in points)
        covered += known
        for string, point in zip(compared, points):
            totals[string] += kwh(point["mean"], known)
    common["coverage"] = min(1.0, covered / elapsed)
    common["kwh"] = {string: round(total, 3) for string, total in totals.items()}
    return {"strings": strings, "common": common}


def solar_destinations(report: Mapping[str, Any]) -> dict[str, Any]:
    """Where a report's period of solar went, estimated, with what stays open.

    The report's ``solarTotals`` sum the same per-hour flows the source mix
    and the charge origin are solved from: in each hour with a source mix,
    solar straight to the house, into the battery and to the grid. What the
    meters do not explain in those hours, and all solar in hours without a
    mix, is unresolved, never forced into a destination, so
    ``house + battery + export + unresolved = produced``. The export the solar
    did not account for (``otherExportKwh``) came from the battery. Every
    figure is kWh over the report's period, except ``exportMoney``: the solar
    export priced at each hour's export rate, over ``exportPricedKwh`` of it.
    """
    totals = report.get("solarTotals") or {}

    def kwh(key: str) -> float:
        return max(0.0, float(totals.get(key) or 0.0))

    attributed = kwh("attributedKwh")
    unattributed = kwh("unattributedKwh")
    house, battery, export = kwh("houseKwh"), kwh("batteryKwh"), kwh("exportKwh")
    measured_export = kwh("measuredExportKwh")
    priced_export = kwh("exportPricedKwh")
    return {
        "producedKwh": round(attributed + unattributed, 3),
        "attributedKwh": round(attributed, 3),
        "unattributedKwh": round(unattributed, 3),
        "houseKwh": round(house, 3),
        "batteryKwh": round(battery, 3),
        "exportKwh": round(export, 3),
        "unresolvedKwh": round(max(0.0, attributed - house - battery - export) + unattributed, 3),
        "measuredExportKwh": round(measured_export, 3),
        "otherExportKwh": round(max(0.0, measured_export - export), 3),
        "exportMoney": money_amount(
            totals.get("exportMoney") if priced_export > 0 else None, export
        ),
        "exportPricedKwh": round(priced_export, 3),
    }


async def _destinations(ctx: NodeDetailContext, local_now: datetime) -> dict[str, Any]:
    """Today's solar destinations, or why there are none."""
    payload: dict[str, Any] = {
        "priceUnit": None,
        "complete": False,
        "unavailable": None,
        "destinations": None,
        "charge": None,
    }
    report = await today_ranking_report(ctx, local_now)
    if "unavailable" in report:
        return {**payload, "unavailable": report["unavailable"]}
    if not (report.get("meters") or {}).get("solar"):
        return {**payload, "unavailable": "no_solar_meter"}
    return {
        **payload,
        # The report's dataset can be a few minutes older than the request.
        "asOf": report["asOf"],
        "priceUnit": report.get("priceUnit"),
        "complete": bool(report.get("complete")),
        "destinations": solar_destinations(report),
        "charge": charge_origin_kwh(report["chargeOrigin"]),
    }


def _positive(value: Any) -> float | None:
    """A configured number above zero, else ``None``: a zero capacity divides nothing."""
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number > 0 else None
