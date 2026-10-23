"""The house detail: what powered it, what used the energy, what comes next, what is usual.

The overview carries the entity ids the card reads live: the house power
meter, Helman's live source-ratio sensors, Helman's battery time-to-empty
sensor, Helman's measured house consumption per phase and the hardware
profile's phase readings it is computed from (telemetry: inverter output, grid
meter, EPS) for the phase and off-grid answers. The device tree the phase answer estimates from, the forecast
and the plan come from the card and the existing forecast and schedule clients,
so they are not repeated.

Two sections:

* ``today``: today's ranking device report, requested with the overview
  because the overview shows its energy and paid cost. The house's source
  split, grid independence, solar self-consumption (the solar detail's own
  accounting, :func:`.solar.solar_destinations`) and the top consumers, every
  load counted once;
* ``pattern``: requested only while its answer is open. Today against up to
  four previous same weekdays over the same completed hours, the lowest
  recorded overnight load and the learned weekday/hour profile.

Nothing here is a diagnosis: the overnight minimum is an observation, not proof
that something was left on, and the learned profile is an expectation, not
measured history.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from datetime import date, datetime, time, timedelta
from typing import Any

from homeassistant.util import dt as dt_util

from ..const import (
    HOUSE_CONSUMPTION_ENTITY_ID,
    house_consumption_phase_entity_id,
)
from ..consumption_forecast_profiles import HourOfWeekWinsorizedMeanProfile
from ..power_polarity import is_power_inverted
from ..vendors import INVERTER_TELEMETRY_KEY
from .battery import TIME_SENSORS, helman_sensor_ids, today_ranking_report
from .context import NodeDetailContext
from .day_stats import async_day_stats, day_window
from .inverter import run_mode_condition
from .solar import in_watts, node_config, node_entity, solar_destinations

PHASES = (1, 2, 3)

#: The telemetry the house answers read, by metric key: the measured phase
#: formula's inputs and the run mode that switches it off-grid.
_TELEMETRY_KEYS = (
    *(
        f"{quantity}_l{phase}"
        for quantity in ("ac_power", "grid_power", "eps_power")
        for phase in PHASES
    ),
    "run_mode",
)

#: Helman's measured house consumption, per phase and in total.
_PHASE_POWER_SENSORS = {
    **{
        f"phase_power_l{phase}": (
            f"house_consumption_power_l{phase}",
            house_consumption_phase_entity_id(phase),
        )
        for phase in PHASES
    },
    "phase_power_total": ("house_consumption_power", HOUSE_CONSUMPTION_ENTITY_ID),
}

#: Helman's live source-ratio sensors: each source's share of the power
#: supplied now, the mix the card colours its consumers with.
_RATIO_SENSORS = {
    f"{source}_ratio": (f"{source}_source_ratio", f"sensor.helman_{source}_source_ratio")
    for source in ("solar", "battery", "grid")
}

#: How many top consumers the answer names, the rest summed.
TOP_CONSUMERS = 3

#: How many previous same weekdays today is compared with.
COMPARED_WEEKS = 4

#: The overnight window ends at this local hour.
OVERNIGHT_END = time(5)


def build_house_overview(
    hass: Any, ctx: NodeDetailContext, now: datetime
) -> dict[str, Any]:
    """The house's mappings and overview facts; no recorder read.

    ``profile`` is ``None`` for a Custom inverter: the telemetry keys are then
    absent from ``entities``. A telemetry key the profile has but the registry
    does not (disabled, missing) is present as ``None``. ``pattern`` is offered
    with a house power meter or a house energy meter to read history from.
    """
    config = ctx.config
    telemetry = ctx.telemetry.get(INVERTER_TELEMETRY_KEY)
    house = node_config(config, "house")

    entities: dict[str, str | None] = {}
    if telemetry is not None:
        for key in _TELEMETRY_KEYS:
            if key in telemetry.entities:
                entities[key] = telemetry.entities[key]
    entities["power"] = node_entity(house, "power")
    entities.update(
        helman_sensor_ids(
            hass,
            {
                **_RATIO_SENSORS,
                **_PHASE_POWER_SENSORS,
                "time_to_empty": TIME_SENSORS["time_to_empty"],
            },
        )
    )

    sections = ["today", "ranking"]
    if entities["power"] or _energy_meter(house):
        sections.append("pattern")
    return {
        "node": "house",
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
        "condition": run_mode_condition(hass, telemetry),
        "sections": sections,
    }


async def async_house_section(
    hass: Any, ctx: NodeDetailContext, section: str, now: datetime
) -> dict[str, Any]:
    """One of the house's sections, over today so far."""
    config = ctx.config
    local_now = dt_util.as_local(now)
    start, end = day_window(local_now)
    payload: dict[str, Any] = {
        "node": "house",
        "section": section,
        "asOf": local_now.isoformat(),
        "period": {
            "start": dt_util.as_local(start).isoformat(),
            "end": dt_util.as_local(end).isoformat(),
        },
    }
    if section == "today":
        return {**payload, **await _today(ctx, local_now)}
    if section == "ranking":
        report = await today_ranking_report(ctx, local_now)
        return {
            **payload,
            "asOf": report.get("asOf", payload["asOf"]),
            "unavailable": report.get("unavailable"),
            "report": None if "unavailable" in report else report,
        }
    house = node_config(config, "house")
    comparison, overnight = await asyncio.gather(
        _weekday_comparison(hass, _energy_meter(house), local_now),
        _overnight(hass, house, local_now),
    )
    return {
        **payload,
        "comparison": comparison,
        "overnight": overnight,
        "profile": learned_profile(ctx.house_profile),
    }


# --- Today --------------------------------------------------------------------


async def _today(ctx: NodeDetailContext, local_now: datetime) -> dict[str, Any]:
    """Today's house figures from the ranking report, or why there are none."""
    payload: dict[str, Any] = {
        "priceUnit": None,
        "complete": False,
        "unavailable": None,
        "house": None,
        "independence": None,
        "selfConsumption": None,
        "consumers": None,
    }
    report = await today_ranking_report(ctx, local_now)
    if "unavailable" in report:
        return {**payload, "unavailable": report["unavailable"]}
    nodes = report.get("nodes") or []
    if not nodes:
        return {**payload, "unavailable": "no_house_node"}
    house = nodes[0]
    house_kwh = max(0.0, float(house.get("kwh") or 0.0))
    return {
        **payload,
        # The report's dataset can be a few minutes older than the request.
        "asOf": report["asOf"],
        "priceUnit": report.get("priceUnit"),
        "complete": bool(report.get("complete")),
        "house": {
            "kwh": round(house_kwh, 3),
            "coverage": house.get("coverage", 0.0),
            "sources": house.get("sources") or {},
            "money": ranking_money(house),
            "ambiguousKwh": report.get("ambiguousKwh", 0.0),
            "mismatchKwh": report.get("mismatchKwh", 0.0),
        },
        "independence": grid_independence(house_kwh, house.get("sources") or {}),
        "selfConsumption": solar_self_consumption(report),
        "consumers": top_consumers(nodes),
    }


def grid_independence(house_kwh: float, sources: Mapping[str, Any]) -> dict[str, float] | None:
    """The share of the house's energy not from the grid, and the share unknown.

    ``(house − grid − unattributed) / house``: energy no measured source
    explains is kept apart as ``unknownShare``, never counted as self-supplied.
    ``None`` without house energy, which divides nothing.
    """
    if house_kwh <= 0:
        return None
    grid = max(0.0, float(sources.get("grid") or 0.0))
    unknown = max(0.0, float(sources.get("unattributed") or 0.0))
    return {
        "share": round(max(0.0, house_kwh - grid - unknown) / house_kwh, 4),
        "gridShare": round(grid / house_kwh, 4),
        "unknownShare": round(unknown / house_kwh, 4),
    }


def solar_self_consumption(report: Mapping[str, Any]) -> dict[str, Any]:
    """The share of the solar produced that the house and the battery took.

    ``(solar → house + solar → battery) / solar``, over the hours with a
    source mix only: the destinations are not known for solar in other hours,
    so they are not in the denominator either. The denominator is solar
    production, never the house's consumption. ``share`` is ``None`` with a
    ``reason`` without a solar meter or matched solar.
    """
    result: dict[str, Any] = {"share": None, "reason": None, "destinations": None}
    if not (report.get("meters") or {}).get("solar"):
        return {**result, "reason": "no_solar_meter"}
    destinations = solar_destinations(report)
    result["destinations"] = destinations
    attributed = destinations["attributedKwh"]
    if attributed <= 0:
        return {**result, "reason": "no_matched_solar"}
    used = destinations["houseKwh"] + destinations["batteryKwh"]
    return {**result, "share": round(min(1.0, used / attributed), 4)}


def top_consumers(nodes: Sequence[Mapping[str, Any]], count: int = TOP_CONSUMERS) -> dict[str, Any]:
    """The largest loads of the ranking, each counted once, and what is left.

    A metered parent's kWh includes its children's, so a parent is never a
    load beside them: the loads are the leaves of the house subtree, a parent's
    own share being its remainder (``ownOf`` names the parent). The house's
    own remainder is not a load but ``unmeasuredKwh``: what no device meter
    explains, inverter loss included.
    """
    by_id = {node.get("id"): node for node in nodes}
    house = nodes[0]
    loads: list[dict[str, Any]] = []
    unmeasured: float | None = None

    def load(node: Mapping[str, Any], own_of: Mapping[str, Any] | None = None) -> dict[str, Any]:
        return {
            "id": node.get("id"),
            "label": (own_of or node).get("label") or "",
            "ownOf": None if own_of is None else own_of.get("id"),
            "estimated": bool(node.get("estimated")),
            "kwh": node.get("kwh") or 0.0,
            "coverage": node.get("coverage", 0.0),
            "money": ranking_money(node),
        }

    def walk(parent: Mapping[str, Any]) -> None:
        nonlocal unmeasured
        for child_id in parent.get("children") or []:
            child = by_id.get(child_id)
            if child is None:
                continue
            if child.get("unmeasured"):
                if parent is house:
                    unmeasured = child.get("kwh") or 0.0
                else:
                    loads.append(load(child, own_of=parent))
            elif any(grandchild in by_id for grandchild in child.get("children") or []):
                walk(child)
            else:
                loads.append(load(child))

    walk(house)
    ranked = sorted((item for item in loads if item["kwh"] > 0), key=lambda item: item["kwh"], reverse=True)
    rest = ranked[count:]
    return {
        "top": ranked[:count],
        "others": {"count": len(rest), "kwh": round(sum(item["kwh"] for item in rest), 3)},
        "unmeasuredKwh": unmeasured,
        "overallocatedKwh": round(sum(node.get("overallocatedKwh") or 0.0 for node in nodes), 3),
    }


def ranking_money(node: Mapping[str, Any]) -> dict[str, Any]:
    """A ranking node's attributed money: paid first, the forgone export value apart.

    Estimates by the reports' attribution, not a bill. An amount is ``None``
    when nothing behind it was priced; ``*PricedKwh`` says how much was.
    """
    money = node.get("money") or {}
    paid = money.get("paid") or {}
    forgone = money.get("forgone") or {}
    return {
        "paid": paid.get("amount"),
        "paidPricedKwh": paid.get("pricedKwh", 0.0),
        "paidUnpricedKwh": paid.get("unpricedKwh", 0.0),
        "forgone": forgone.get("amount"),
        "forgonePricedKwh": forgone.get("pricedKwh", 0.0),
        "forgoneUnpricedKwh": forgone.get("unpricedKwh", 0.0),
    }


# --- Pattern ------------------------------------------------------------------


async def _weekday_comparison(
    hass: Any, entity_id: str | None, local_now: datetime
) -> dict[str, Any]:
    """Today so far against the previous same weekdays, over the same completed hours."""
    today = local_now.date()
    until = local_now.replace(minute=0, second=0, microsecond=0)
    base: dict[str, Any] = {"unavailable": None, "until": until.isoformat()}
    if entity_id is None:
        return {**base, **compare_same_weekdays([], elapsed_hours=0), "unavailable": "no_energy_meter"}
    days = [today - timedelta(days=7 * weeks) for weeks in range(COMPARED_WEEKS + 1)]
    windows = [(_local_day_start(day), _local_at(day, until.time())) for day in days]
    elapsed_hours = int((dt_util.as_utc(windows[0][1]) - dt_util.as_utc(windows[0][0])).total_seconds() // 3600)
    if elapsed_hours <= 0:
        return {**base, **compare_same_weekdays([], elapsed_hours=0), "unavailable": "no_elapsed_hour"}
    series = await _hourly_energy(hass, entity_id, windows)
    return {
        **base,
        **compare_same_weekdays(list(zip(days, series)), elapsed_hours=elapsed_hours),
    }


async def _hourly_energy(
    hass: Any, entity_id: str, windows: Sequence[tuple[datetime, datetime]]
) -> list[dict[datetime, float]]:
    """The meter's hourly energy per window, in one batched recorder read.

    Imported here, like :mod:`.day_stats` does, so loading the node details
    needs no recorder.
    """
    from ..recorder_slot_energy import query_cumulative_slot_energy_changes_for_windows

    return await query_cumulative_slot_energy_changes_for_windows(
        hass, entity_id, windows, interval_minutes=60
    )


def compare_same_weekdays(
    days: Sequence[tuple[date, Mapping[datetime, float]]], *, elapsed_hours: int
) -> dict[str, Any]:
    """Today's energy against the average of earlier days over the same hours.

    ``days[0]`` is today, the rest the earlier same weekdays, each a
    ``{hour start: kWh}`` of completed hours, a gap being a missing hour.
    Hours are matched by local hour of day: only the hours today has a reading
    for are compared, and an earlier day counts only when it has every one of
    them, so a partial day is never compared with a full one. ``used`` is the
    number of earlier days that did; ``average`` is ``None`` without one. A
    local hour that occurs twice (the DST fall-back) is no single hour of day:
    it is left out of that day, never summed into one.
    """
    def by_hour(values: Mapping[datetime, float]) -> dict[int, float]:
        hourly: dict[int, float] = {}
        repeated: set[int] = set()
        for start, kwh in values.items():
            hour = dt_util.as_local(start).hour
            if hour in hourly:
                repeated.add(hour)
            hourly[hour] = max(0.0, kwh)
        return {hour: kwh for hour, kwh in hourly.items() if hour not in repeated}

    result: dict[str, Any] = {
        "elapsedHours": elapsed_hours,
        "comparedHours": 0,
        "todayKwh": None,
        "averageKwh": None,
        "ratio": None,
        "used": 0,
        "days": [],
    }
    if not days:
        return result
    today = by_hour(days[0][1])
    hours = sorted(today)
    result["comparedHours"] = len(hours)
    if hours:
        result["todayKwh"] = round(sum(today.values()), 3)
    compared: list[float] = []
    for day, values in days[1:]:
        hourly = by_hour(values)
        complete = bool(hours) and all(hour in hourly for hour in hours)
        kwh = round(sum(hourly[hour] for hour in hours), 3) if complete else None
        if kwh is not None:
            compared.append(kwh)
        result["days"].append(
            {"date": day.isoformat(), "kwh": kwh, "knownHours": len(set(hourly) & set(hours))}
        )
    result["used"] = len(compared)
    if compared:
        average = sum(compared) / len(compared)
        result["averageKwh"] = round(average, 3)
        if average > 0 and result["todayKwh"] is not None:
            result["ratio"] = round(result["todayKwh"] / average, 4)
    return result


async def _overnight(
    hass: Any, house: Mapping[str, Any], local_now: datetime
) -> dict[str, Any]:
    """The lowest recorded five-minute mean of house power between 00:00 and 05:00.

    An observation, not a base load or proof that something was left on.
    Before 05:00 the window is today's so far (``complete`` false). A bucket
    without a reading is a gap, never a low; ``coverage`` is the known share of
    the window so far.
    """
    start = _local_day_start(local_now.date())
    end = _local_at(local_now.date(), OVERNIGHT_END)
    result: dict[str, Any] = {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "complete": local_now >= end,
        "unavailable": None,
        "minimum": None,
        "coverage": 0.0,
    }
    entity_id = node_entity(house, "power")
    if entity_id is None:
        return {**result, "unavailable": "no_power_sensor"}
    stats = await async_day_stats(hass, [entity_id], start=start, end=end, now=local_now)
    day = stats.get(entity_id)
    watts = None if day is None else in_watts(day, inverted=is_power_inverted(house, "house"))
    if watts is None:
        return {**result, "unavailable": "unit"}
    lowest = min(watts["points"], key=lambda point: point["mean"], default=None)
    return {
        **result,
        "coverage": watts.get("coverage", 0.0),
        "minimum": None
        if lowest is None
        else {
            "watts": round(lowest["mean"], 1),
            "at": lowest["start"],
            "coverage": lowest["coverage"],
        },
    }


def learned_profile(house_profile: tuple[Any, str | None]) -> dict[str, Any] | None:
    """The house forecast's fitted weekday/hour profile, kWh per hour, Monday first.

    The base load the forecast learned (deferrable appliances excluded), as
    the forecast serves it: a learned expectation, not measured history.
    ``None`` while no profile is fitted.
    """
    profile, trained_at = house_profile
    if profile is None:
        return None
    slot = HourOfWeekWinsorizedMeanProfile.slot_index
    return {
        "historyDays": profile.history_days,
        "trainedAt": trained_at,
        "kwh": [
            [round(profile.non_deferrable[slot(weekday, hour)].value, 3) for hour in range(24)]
            for weekday in range(7)
        ],
    }


def _energy_meter(house: Mapping[str, Any]) -> str | None:
    """The house's cumulative energy meter, the one the house forecast trains on."""
    forecast = house.get("forecast")
    entity_id = forecast.get("total_energy_entity_id") if isinstance(forecast, Mapping) else None
    return entity_id if isinstance(entity_id, str) and entity_id else None


def _local_day_start(day: date) -> datetime:
    return dt_util.start_of_local_day(day)


def _local_at(day: date, at: time) -> datetime:
    """``day`` at the wall-clock ``at`` in the local zone."""
    return datetime.combine(day, at, tzinfo=dt_util.get_default_time_zone())
