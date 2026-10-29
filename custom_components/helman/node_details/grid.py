"""The grid detail: how the grid is used per phase, and how stable its voltage is.

The overview carries the entity ids the card reads live: the hardware
profile's per-phase power and the inverter's phase voltages (telemetry), the
grid's own today-energy meters (config), the limits and runtimes the off-grid
answer shows. Money uses the existing inspector aggregate service.

The history sections are ``money``, today's bought and sold energy from the
inspector aggregate; ``voltage``, today's three phase voltages from
:func:`.day_stats.async_day_stats` plus the largest spread between phases (the
inverter's terminal readings, not the meter's); and ``power``, the grid
meter's power over the last 24 hours.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from typing import Any

from homeassistant.util import dt as dt_util

from ..span_history_model import read_span_meters

from ..vendors import INVERTER_TELEMETRY_KEY
from .context import NodeDetailContext
from .day_stats import (
    BUCKET,
    async_day_stats,
    day_window,
    last_24h_window,
    node_config,
    node_entity,
    node_power,
)
from .inverter import run_mode_condition

PHASES = (1, 2, 3)

#: The telemetry the grid answers read, by metric key.
_TELEMETRY_KEYS = (
    *(f"grid_power_l{phase}" for phase in PHASES),
    *(f"ac_voltage_l{phase}" for phase in PHASES),
    "grid_import",
    "grid_export",
    "grid_frequency",
    "run_mode",
    "export_limit",
    "main_breaker_limit",
    "grid_mode_runtime",
    "eps_mode_runtime",
)

#: The grid's own config meters the overview reads, by payload key.
_CONFIG_ENTITIES = {
    "power": "power",
    "today_import": "today_import",
    "today_export": "today_export",
}


def build_grid_overview(
    hass: Any, ctx: NodeDetailContext, now: datetime
) -> dict[str, Any]:
    """The grid's mappings and overview facts; no recorder read.

    ``profile`` is ``None`` for a Custom inverter: the telemetry keys are then
    absent from ``entities``. A telemetry key the profile has but the registry
    does not (disabled, missing) is present as ``None``.
    """
    config = ctx.config
    telemetry = ctx.telemetry.get(INVERTER_TELEMETRY_KEY)
    energy_nodes = config.get("energy_nodes") if isinstance(config, Mapping) else None
    grid = energy_nodes.get("grid") if isinstance(energy_nodes, Mapping) else None
    if not isinstance(grid, Mapping):
        grid = {}
    grid_entities = grid.get("entities")
    if not isinstance(grid_entities, Mapping):
        grid_entities = {}

    meters = read_span_meters(config)
    entities: dict[str, str | None] = {}
    if telemetry is not None:
        for key in _TELEMETRY_KEYS:
            if key in telemetry.entities:
                entities[key] = telemetry.entities[key]
    for key, slot in _CONFIG_ENTITIES.items():
        if slot == "today_import":
            entity_id = meters.grid_import
        elif slot == "today_export":
            entity_id = meters.grid_export
        else:
            entity_id = grid_entities.get(slot)
        entities[key] = entity_id if isinstance(entity_id, str) and entity_id else None

    return {
        "node": "grid",
        "asOf": dt_util.as_local(now).isoformat(),
        "profile": (
            None
            if telemetry is None
            else {"id": telemetry.profile.id, "label": telemetry.profile.label}
        ),
        "entities": entities,
        "phasePowerPolarity": (
            None if telemetry is None else telemetry.profile.grid_phase_power_polarity
        ),
        "maxAllowedExportPower": grid.get("max_allowed_export_power"),
        "condition": run_mode_condition(hass, telemetry),
        "sections": [
            "money",
            *(["voltage"] if any(entities.get(f"ac_voltage_l{phase}") for phase in PHASES) else []),
            *(["power"] if entities["power"] else []),
        ],
    }


def money_amount(money: Any, kwh: Any) -> float | None:
    """A money figure, ``0`` when no energy flowed, ``None`` when none was priced."""
    return money if money is not None else 0.0 if kwh == 0 else None


async def async_grid_section(
    hass: Any, ctx: NodeDetailContext, section: str, now: datetime
) -> dict[str, Any]:
    """One of the grid's history sections.

    ``voltage``: ``phases`` holds each phase's day, ``None`` for a phase whose
    sensor the profile does not resolve. ``power``: the grid meter over the last
    24 hours in W, in Helman's convention whatever the sensor's polarity:
    **positive is export, negative is import**; ``None`` without the meter or
    in a unit not known.
    """
    if section == "money":
        local_now = dt_util.as_local(now)
        day = local_now.date().isoformat()
        aggregate = await ctx.day_aggregates(day) if ctx.day_aggregates else {}
        row = next((item for item in aggregate.get("days", []) if item.get("date") == day), None)
        return {
            "node": "grid", "section": "money", "asOf": local_now.isoformat(),
            "priceUnit": aggregate.get("priceUnit"),
            "unavailable": None if row is not None else "no_day_aggregate",
            "importCost": money_amount(row.get("moneyCost"), row.get("gridImportKwh")) if row else None,
            "exportRevenue": money_amount(row.get("moneyGain"), row.get("gridExportKwh")) if row else None,
            "importKwh": row.get("gridImportKwh") if row else None,
            "exportKwh": row.get("gridExportKwh") if row else None,
            "importPricedKwh": row.get("moneyCostKwh") if row else None,
            "exportPricedKwh": row.get("moneyGainKwh") if row else None,
        }
    if section == "power":
        grid = node_config(ctx.config, "grid")
        entity_id = node_entity(grid, "power")
        start, end = last_24h_window(now)
        stats = (
            await async_day_stats(hass, [entity_id], start=start, end=end, now=now)
            if entity_id
            else {}
        )
        return {
            "node": "grid",
            "section": section,
            "asOf": dt_util.as_local(now).isoformat(),
            "period": {
                "start": dt_util.as_local(start).isoformat(),
                "end": dt_util.as_local(end).isoformat(),
            },
            **node_power(stats, grid, "grid"),
        }
    telemetry = ctx.telemetry.get(INVERTER_TELEMETRY_KEY)
    entity_ids = {
        phase: None if telemetry is None else telemetry.entities.get(f"ac_voltage_l{phase}")
        for phase in PHASES
    }
    start, end = day_window(dt_util.as_local(now))
    stats = await async_day_stats(
        hass, entity_ids.values(), start=start, end=end, now=now
    )
    phases = {
        str(phase): stats.get(entity_id) if entity_id else None
        for phase, entity_id in entity_ids.items()
    }
    stop = min(end, dt_util.as_utc(now))
    return {
        "node": "grid",
        "section": section,
        "asOf": dt_util.as_local(now).isoformat(),
        "period": {
            "start": dt_util.as_local(start).isoformat(),
            "end": dt_util.as_local(end).isoformat(),
        },
        "phases": phases,
        "spread": phase_spread(phases, start=start, stop=stop),
    }


def phase_spread(
    phases: Mapping[str, Mapping[str, Any] | None],
    *,
    start: datetime,
    stop: datetime,
) -> dict[str, Any]:
    """The largest difference between phases at one time, and how much is known.

    Compared only within a five-minute bucket every compared phase has a
    reading for, as the difference of their bucket means: a maximum of one
    phase and a minimum of another from unrelated hours is not a spread. The
    compared phases are those with any reading today; ``coverage`` is the share
    of the elapsed day in which all of them were known together, each bucket
    counted at its least-covered phase's known share. Fewer than two
    such phases compare nothing: ``max`` is ``None``.
    """
    by_phase = {
        phase: {point["start"]: point for point in (day or {}).get("points", [])}
        for phase, day in phases.items()
    }
    compared = sorted(phase for phase, points in by_phase.items() if points)
    elapsed = max((stop - start).total_seconds(), 0.0)
    result: dict[str, Any] = {
        "phases": [int(phase) for phase in compared],
        "max": None,
        "maxAt": None,
        "coverage": 0.0,
    }
    if len(compared) < 2 or elapsed <= 0:
        return result

    aligned = set.intersection(*(set(by_phase[phase]) for phase in compared))
    covered = 0.0
    for bucket_start in sorted(aligned):
        local = datetime.fromisoformat(bucket_start)
        points = [by_phase[phase][bucket_start] for phase in compared]
        covered += (min(local + BUCKET, stop) - local).total_seconds() * min(
            point["coverage"] for point in points
        )
        means: Sequence[float] = [point["mean"] for point in points]
        spread = max(means) - min(means)
        if result["max"] is None or spread > result["max"]:
            result["max"] = spread
            result["maxAt"] = bucket_start
    result["coverage"] = min(1.0, covered / elapsed)
    return result
