"""The battery detail: usable reserve, what limits it, today's charge and diagnostics.

The overview carries the entity ids the card reads live: the battery's config
meters (SoC, remaining energy, the active SoC range, today's input and output),
Helman's time-to-full/empty sensors and the hardware profile's battery
telemetry. Beside them it carries the facts only the backend can tell: the
configured planning ceilings, the approximate throughput cycles and a BMS
condition the hardware explicitly reports. The plan and the planned SoC come
from the existing schedule and forecast clients, so they are not repeated.

The one section is ``charge``: today's charge origin from the device reports'
``charge_origin``, converted from period-weighted fractions to kWh. It is what
charged the battery today, not an inventory of what is stored in it now.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any

from homeassistant.util import dt as dt_util

from ..span_history_model import read_span_meters

from ..battery_state import (
    read_battery_entity_config,
    read_battery_forecast_settings,
)
from ..const import DOMAIN
from ..device_reports.reports import ReportQuery
from ..energy_units import normalize_energy_to_kwh
from ..vendors import INVERTER_TELEMETRY_KEY, helman_entity_id
from .context import NodeDetailContext
from .day_stats import day_window
from .inverter import run_mode_condition

#: The telemetry the battery answers read, by metric key.
_TELEMETRY_KEYS = (
    "battery_voltage",
    "battery_current",
    "battery_temperature",
    "chargeable_energy",
    "max_charge_rate",
    "bdc_status",
    "bms_charge_max_current",
    "bms_discharge_max_current",
    "input_energy_total",
    "output_energy_total",
    "cell_voltage_high",
    "cell_voltage_low",
    "cell_voltage_difference",
    "battery_type",
    "battery_temp_high",
    "battery_temp_low",
    "bms_connect_state",
    "battery_heating",
    "battery_heating_start_1",
    "battery_heating_end_1",
    "battery_heating_start_2",
    "battery_heating_end_2",
    # The inverter's configured battery currents, compared with the BMS's.
    "battery_charge_max_current",
    "battery_discharge_max_current",
    "use_mode",
    "run_mode",
)

#: The battery's own config meters the overview reads, by payload key.
_CONFIG_ENTITIES = {
    "soc": "capacity",
    "remaining_energy": "remaining_energy",
    "min_soc": "min_soc",
    "max_soc": "max_soc",
    "today_charge": "today_charge_energy",
    "today_discharge": "today_discharge_energy",
}

#: Helman's own ETA sensors: unique-id suffix and the entity id ``sensor.py``
#: creates them under, the fallback before they are registered.
TIME_SENSORS = {
    "time_to_full": ("battery_time_to_full", "sensor.helman_battery_time_to_full"),
    "time_to_empty": ("battery_time_to_empty", "sensor.helman_battery_time_to_empty"),
}


def helman_sensor_ids(
    hass: Any, sensors: Mapping[str, tuple[str, str]]
) -> dict[str, str]:
    """Helman's own sensors by unique id, so a renamed entity is still found.

    ``sensors`` maps a payload key to the sensor's unique-id suffix and the
    entity id ``sensor.py`` creates it under, the fallback before it is
    registered.
    """
    config_entries = getattr(hass, "config_entries", None)
    entries = config_entries.async_entries(DOMAIN) if config_entries is not None else []
    if not entries:
        return {key: fallback for key, (_, fallback) in sensors.items()}
    entry_id = entries[0].entry_id
    return {
        key: helman_entity_id(hass, "sensor", f"{entry_id}_{suffix}", fallback)
        for key, (suffix, fallback) in sensors.items()
    }


def build_battery_overview(
    hass: Any, ctx: NodeDetailContext, now: datetime
) -> dict[str, Any]:
    """The battery's mappings and overview facts; no recorder read.

    ``profile`` is ``None`` for a Custom inverter: the telemetry keys are then
    absent from ``entities``. A telemetry key the profile has but the registry
    does not (disabled, missing) is present as ``None``.
    """
    config = ctx.config
    telemetry = ctx.telemetry.get(INVERTER_TELEMETRY_KEY)
    battery = _battery_config(config)
    battery_entities = battery.get("entities")
    if not isinstance(battery_entities, Mapping):
        battery_entities = {}

    meters = read_span_meters(config)
    entities: dict[str, str | None] = {}
    for key, slot in _CONFIG_ENTITIES.items():
        if slot == "today_charge_energy":
            entity_id = meters.battery_charge
        elif slot == "today_discharge_energy":
            entity_id = meters.battery_discharge
        else:
            entity_id = battery_entities.get(slot)
        entities[key] = entity_id if isinstance(entity_id, str) and entity_id else None
    entities.update(helman_sensor_ids(hass, TIME_SENSORS))
    if telemetry is not None:
        for key in _TELEMETRY_KEYS:
            if key in telemetry.entities:
                entities[key] = telemetry.entities[key]

    settings = read_battery_forecast_settings(dict(config))
    return {
        "node": "battery",
        "asOf": dt_util.as_local(now).isoformat(),
        "profile": (
            None
            if telemetry is None
            else {"id": telemetry.profile.id, "label": telemetry.profile.label}
        ),
        "entities": entities,
        "configured": {
            "maxChargePowerW": settings.max_charge_power_w,
            "maxDischargePowerW": settings.max_discharge_power_w,
        },
        "cycles": equivalent_full_cycles(
            _read_kwh(hass, entities.get("input_energy_total")),
            _read_kwh(hass, entities.get("output_energy_total")),
            _nominal_capacity_kwh(hass, config),
            counters_mapped=bool(
                entities.get("input_energy_total") and entities.get("output_energy_total")
            ),
        ),
        "condition": _condition(hass, telemetry),
        "sections": ["charge"],
    }


async def today_ranking_report(ctx: NodeDetailContext, local_now: datetime) -> Mapping[str, Any]:
    """Today's ranking device report, or ``{"unavailable": reason}``.

    The one report the battery's and the solar's "today so far" answers read.
    """
    if ctx.device_report is None:
        return {"unavailable": "not_loaded"}
    today = local_now.date()
    return await ctx.device_report(
        "ranking", ReportQuery(start_date=today, end_date=today)
    )


async def async_battery_section(
    hass: Any, ctx: NodeDetailContext, section: str, now: datetime
) -> dict[str, Any]:
    """Today's charge origin, the battery's one history section.

    Reuses the device reports' ``charge_origin`` for today. ``charge`` is
    ``None`` with an ``unavailable`` reason when the reports cannot be built.
    """
    local_now = dt_util.as_local(now)
    start, end = day_window(local_now)
    payload: dict[str, Any] = {
        "node": "battery",
        "section": section,
        "asOf": local_now.isoformat(),
        "period": {
            "start": dt_util.as_local(start).isoformat(),
            "end": dt_util.as_local(end).isoformat(),
        },
        "currency": None,
        "complete": False,
        "unavailable": None,
        "charge": None,
    }
    report = await today_ranking_report(ctx, local_now)
    if "unavailable" in report:
        return {**payload, "unavailable": report["unavailable"]}
    return {
        **payload,
        # The report's dataset can be a few minutes older than the request.
        **({"asOf": report["as_of"]} if report.get("as_of") else {}),
        "currency": report.get("currency"),
        "complete": bool(report.get("complete")),
        "charge": charge_origin_kwh(report["charge_origin"]),
    }


def charge_origin_kwh(origin: Mapping[str, Any]) -> dict[str, Any]:
    """The report's charge-origin fractions as kWh of the period's charge.

    Each fraction is of ``charged_kwh``, so each share is ``charged_kwh ×
    fraction``; nothing is dropped, so ``solar + grid + unknown`` is the
    charge. The paid cost prices only the rated grid share at the
    energy-weighted import rate, and the forgone export value only the rated
    solar share; a side with no kWh is a known zero, a side with kWh but no
    rate is ``None``. With no charge in the period every share is zero and
    there is nothing to price.
    """
    charged = max(0.0, float(origin.get("charged_kwh") or 0.0))

    def share(key: str) -> float:
        return round(charged * float(origin.get(key) or 0.0), 3)

    grid_priced = share("grid_recorded") + share("grid_tariff")
    grid = share("grid")
    solar_priced = share("solar_priced")
    solar = share("solar")
    paid_rate = origin.get("paid_rate")
    forgone_rate = origin.get("forgone_rate")

    def money(kwh: float, priced_kwh: float, rate: Any) -> float | None:
        if kwh <= 0:
            return 0.0
        if rate is None or priced_kwh <= 0:
            return None
        return round(priced_kwh * float(rate), 3)

    return {
        "chargedKwh": round(charged, 3),
        "solarKwh": solar,
        "gridKwh": grid,
        "unknownKwh": share("unknown"),
        "gridPricedKwh": round(grid_priced, 3),
        "gridTariffKwh": share("grid_tariff"),
        "gridUnpricedKwh": share("grid_unpriced"),
        "solarPricedKwh": solar_priced,
        "solarUnpricedKwh": share("solar_unpriced"),
        "paidRate": paid_rate,
        "forgoneRate": forgone_rate,
        "paidCost": money(grid, grid_priced, paid_rate),
        "forgoneValue": money(solar, solar_priced, forgone_rate),
    }


def equivalent_full_cycles(
    input_kwh: float | None,
    output_kwh: float | None,
    capacity_kwh: float | None,
    *,
    counters_mapped: bool = True,
) -> dict[str, Any]:
    """Approximate equivalent full cycles: ``(in + out) / (2 × capacity)``.

    Throughput over the lifetime counters, not state of health or remaining
    life. ``cycles`` is ``None`` with a ``reason`` unless both counters and the
    capacity are valid: ``no_counters`` (not mapped), ``invalid_counters``
    (unavailable, not numeric, negative or in no energy unit) or
    ``no_capacity``.
    """
    result: dict[str, Any] = {
        "cycles": None,
        "inputKwh": input_kwh,
        "outputKwh": output_kwh,
        "capacityKwh": None if capacity_kwh is None else round(capacity_kwh, 3),
        "reason": None,
    }
    if not counters_mapped:
        return {**result, "reason": "no_counters"}
    if input_kwh is None or output_kwh is None or input_kwh < 0 or output_kwh < 0:
        return {**result, "reason": "invalid_counters"}
    if capacity_kwh is None or capacity_kwh <= 0:
        return {**result, "reason": "no_capacity"}
    return {**result, "cycles": round((input_kwh + output_kwh) / (2 * capacity_kwh), 1)}


def _battery_config(config: Mapping[str, Any]) -> Mapping[str, Any]:
    energy_nodes = config.get("energy_nodes") if isinstance(config, Mapping) else None
    battery = energy_nodes.get("battery") if isinstance(energy_nodes, Mapping) else None
    return battery if isinstance(battery, Mapping) else {}


def _nominal_capacity_kwh(hass: Any, config: Mapping[str, Any]) -> float | None:
    """The nominal capacity, remaining energy ÷ SoC, as the forecast computes it.

    Unlike the forecast's live state, a SoC outside the configured planning
    range still gives a capacity: a cycle count needs no planning bounds.
    """
    entity_config = read_battery_entity_config(dict(config))
    if entity_config is None:
        return None
    soc_state = hass.states.get(entity_config.capacity_entity_id)
    try:
        soc = float(soc_state.state) if soc_state is not None else None
    except (TypeError, ValueError):
        soc = None
    remaining = _read_kwh(hass, entity_config.remaining_energy_entity_id)
    if soc is None or not 0 < soc <= 100 or remaining is None or remaining < 0:
        return None
    capacity = remaining / (soc / 100)
    return capacity if capacity > 0 else None


def _read_kwh(hass: Any, entity_id: str | None) -> float | None:
    """An energy reading in kWh; ``None`` when missing, not numeric or unitless."""
    state = hass.states.get(entity_id) if entity_id else None
    if state is None:
        return None
    try:
        value = float(state.state)
    except (TypeError, ValueError):
        return None
    if value != value:  # NaN
        return None
    return normalize_energy_to_kwh(
        value, state.attributes.get("unit_of_measurement"), default_unit=None
    )


def _condition(hass: Any, telemetry: Any) -> dict[str, str] | None:
    """A BMS state, else an off-grid or fault run mode, the profile names.

    Only what the hardware explicitly reports; nothing is inferred from other
    readings.
    """
    if telemetry is None:
        return None
    entity_id = telemetry.entities.get("bms_connect_state")
    state = hass.states.get(entity_id) if entity_id else None
    kind = None if state is None else telemetry.profile.bms_connect_conditions.get(state.state)
    if kind is not None:
        return {"kind": kind, "state": state.state, "entityId": entity_id}
    run_mode = run_mode_condition(hass, telemetry)
    if run_mode is None:
        return None
    return {"kind": run_mode["kind"], "state": run_mode["runMode"], "entityId": run_mode["entityId"]}
