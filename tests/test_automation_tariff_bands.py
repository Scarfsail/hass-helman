"""Import bands keep the tariff's meaning as the rolling horizon moves (#792).

The import forecast starts at now, so once today's last cheap window has passed
the points left in today no longer hold the cheap price. The cheap reference is
the tariff's own lowest price, carried as ``dailyMinPrice`` on the import
snapshot, so the remaining expensive hours stay expensive.

Every case runs the real chain: ``GridPriceForecastBuilder`` ->
``OptimizationSnapshot`` -> ``DayContextResolver`` ->
``_build_import_band_timeline`` (-> ``battery_reserve``).
"""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from homeassistant.util import dt as dt_util

from _fakes import make_optimization_context
from automation_config_builders import make_optimizer_config
from automation_trace_contract import run_optimizer_with_trace
from custom_components.helman.automation.optimizers.battery_reserve import (
    _build_import_band_timeline,
    build_battery_reserve_optimizer,
)
from custom_components.helman.automation.pipeline import DayContextResolver
from custom_components.helman.automation.snapshot import OptimizationSnapshot
from custom_components.helman.battery_state import BatteryLiveState
from custom_components.helman.const import MAX_FORECAST_DAYS
from custom_components.helman.grid_price_forecast_builder import GridPriceForecastBuilder
from custom_components.helman.grid_price_forecast_response import (
    build_grid_price_forecast_response,
)
from custom_components.helman.scheduling.schedule import ScheduleDocument, inverter_action

PRAGUE = ZoneInfo("Europe/Prague")

#: The reported tariff: 3.5 is cheap, 6.5 expensive; the day's last cheap
#: window ends at 22:00.
WINDOWS = [
    {"start": "00:00", "end": "03:00", "price": 6.5},
    {"start": "03:00", "end": "07:00", "price": 3.5},
    {"start": "07:00", "end": "18:00", "price": 6.5},
    {"start": "18:00", "end": "22:00", "price": 3.5},
    {"start": "22:00", "end": "00:00", "price": 6.5},
]


@pytest.fixture(autouse=True)
def prague():
    previous = dt_util.get_default_time_zone()
    dt_util.set_default_time_zone(PRAGUE)
    yield
    dt_util.set_default_time_zone(previous)


def _prices(now: datetime, windows: list[dict] = WINDOWS) -> dict:
    builder = GridPriceForecastBuilder(
        SimpleNamespace(config=SimpleNamespace(time_zone="Europe/Prague")),
        {"energy_nodes": {"grid": {"forecast": {
            "import_price_unit": "CZK/kWh", "import_price_windows": windows,
        }}}},
    )
    return builder.build(reference_time=now, export_snapshot={})


def _snapshot(now: datetime, prices: dict) -> OptimizationSnapshot:
    points = prices["import"]["points"]
    return OptimizationSnapshot(
        schedule=ScheduleDocument(),
        adjusted_house_forecast={},
        battery_forecast={"series": [
            {"timestamp": p["timestamp"], "solarKwh": 0,
             "baselineHouseKwh": 0.15, "socPct": 50}
            for p in points
        ]},
        grid_forecast={},
        context=make_optimization_context(
            now=now,
            import_price_forecast=prices["import"],
            export_price_forecast={"points": points},
        ),
    )


def _contexts(snapshot: OptimizationSnapshot):
    return DayContextResolver(
        deficit_below_ratio=0.7, surplus_above_ratio=1.3,
        solar_actual_history=[], house_actual_history=[], previous_bands={},
    )(snapshot, optimizer_id="battery-reserve")


def _today_bands(now: datetime, windows: list[dict] = WINDOWS):
    contexts = _contexts(_snapshot(now, _prices(now, windows)))
    return [(b.level, b.start, b.end) for b in contexts[now.date()].import_bands]


@pytest.mark.parametrize("now_text", [
    "2026-11-21T21:45:00+01:00",
    "2026-11-21T22:00:00+01:00",
    "2026-11-21T23:15:00+01:00",
    "2026-11-22T00:00:00+01:00",
    "2026-03-29T23:15:00+02:00",
    "2026-10-25T23:15:00+01:00",
])
def test_evening_expensive_band_runs_through_3am(now_text):
    now = datetime.fromisoformat(now_text)
    timeline = _build_import_band_timeline(_contexts(_snapshot(now, _prices(now))).values())
    expensive_start = now.replace(hour=0 if now.hour < 3 else 22, minute=0)
    expensive_start = max(expensive_start, now)
    band = next(b for b in timeline if b.start <= expensive_start < b.end)

    assert band.level == "expensive"
    expected_end = now.replace(hour=3, minute=0)
    if now.hour >= 3:
        expected_end += timedelta(days=1)
    assert band.end == expected_end


def test_before_the_last_cheap_window_ends_bands_are_unchanged():
    now = datetime.fromisoformat("2026-11-21T19:00:00+01:00")
    assert _today_bands(now) == [
        ("cheap", now, now.replace(hour=22)),
        ("expensive", now.replace(hour=22), now.replace(hour=0) + timedelta(days=1)),
    ]


@pytest.mark.parametrize("rate", [6.5, 0, -2.0])
def test_flat_tariff_is_all_cheap(rate):
    now = datetime.fromisoformat("2026-11-21T23:15:00+01:00")
    windows = [{"start": "00:00", "end": "12:00", "price": rate},
               {"start": "12:00", "end": "00:00", "price": rate}]
    contexts = _contexts(_snapshot(now, _prices(now, windows)))
    assert all(b.level == "cheap" for ctx in contexts.values() for b in ctx.import_bands)


def test_three_rate_tariff_keeps_only_the_lowest_price_cheap():
    now = datetime.fromisoformat("2026-11-21T12:00:00+01:00")
    windows = [{"start": "00:00", "end": "08:00", "price": 2},
               {"start": "08:00", "end": "16:00", "price": 4},
               {"start": "16:00", "end": "00:00", "price": 6}]
    assert [level for level, _, _ in _today_bands(now, windows)] == ["expensive"]


def test_single_early_cheap_window_leaves_the_rest_of_today_expensive():
    now = datetime.fromisoformat("2026-11-21T12:00:00+01:00")
    windows = [{"start": "00:00", "end": "06:00", "price": 3},
               {"start": "06:00", "end": "00:00", "price": 6}]
    assert _today_bands(now, windows) == [
        ("expensive", now, now.replace(hour=0) + timedelta(days=1)),
    ]


def test_cheap_window_across_midnight_is_cheap_tonight():
    now = datetime.fromisoformat("2026-11-21T23:00:00+01:00")
    windows = [{"start": "22:00", "end": "06:00", "price": 3},
               {"start": "06:00", "end": "22:00", "price": 6}]
    assert _today_bands(now, windows) == [
        ("cheap", now, now.replace(hour=0) + timedelta(days=1)),
    ]


@pytest.mark.parametrize("now_text", [
    "2026-03-29T01:30:00+01:00",
    "2026-10-25T01:30:00+02:00",
    "2026-11-21T23:15:00+01:00",
])
def test_public_points_keep_the_rolling_horizon_and_dst_slots(now_text):
    now = datetime.fromisoformat(now_text)
    prices = _prices(now)
    response = build_grid_price_forecast_response(prices, forecast_days=MAX_FORECAST_DAYS)
    points = response["importPricePoints"]
    assert "dailyMinPrice" not in response
    assert points == prices["import"]["points"]
    assert len(points) == MAX_FORECAST_DAYS * 96
    assert datetime.fromisoformat(points[0]["timestamp"]) == now
    instants = [datetime.fromisoformat(p["timestamp"]).astimezone(timezone.utc) for p in points]
    assert all(b - a == timedelta(minutes=15) for a, b in zip(instants, instants[1:]))


@pytest.mark.parametrize("soc,expected_kind", [(50, "empty"), (19, "stop_discharging")])
def test_reserve_discharges_an_adequate_battery_but_keeps_the_floor_hold(soc, expected_kind):
    now = datetime.fromisoformat("2026-11-21T23:15:00+01:00")
    prices = _prices(now)
    # 1.08 kW through 03:00 fits a 50 %-full 17.28 kWh battery above its 20 %
    # reserve, but not above the 30 % charge-sizing goal. The bug made
    # 23:15-24:00 a cheap bridge and held the battery to that higher goal.
    series = [
        {"timestamp": p["timestamp"], "durationHours": 0.25, "solarKwh": 0,
         "baselineHouseKwh": 0.27,
         "socPct": max(15, soc - (i + 1) * 0.27 / 0.95 / 17.28 * 100)}
        for i, p in enumerate(prices["import"]["points"][:192])
    ]
    snapshot = replace(
        _snapshot(now, prices),
        battery_forecast={"status": "available", "series": series},
        context=make_optimization_context(
            now=now,
            import_price_forecast=prices["import"],
            export_price_forecast={"points": prices["import"]["points"]},
            battery_state=BatteryLiveState(
                current_remaining_energy_kwh=17.28 * soc / 100,
                current_soc=soc, min_soc=15, max_soc=90,
                nominal_capacity_kwh=17.28,
                min_energy_kwh=17.28 * 0.15, max_energy_kwh=17.28 * 0.90,
            ),
            battery_max_charge_power_kw=10,
            battery_max_discharge_power_kw=10,
            battery_charge_efficiency=0.95,
            battery_discharge_efficiency=0.95,
        ),
    )
    snapshot = replace(snapshot, context=replace(snapshot.context, day_contexts=_contexts(snapshot)))
    config = make_optimizer_config(
        id="reserve", kind="battery_reserve", conditions=[{
            "reserve_floor_soc": 20, "expensive_window_buffer_pct": 10,
            "solar_dip_floor_soc": 15, "solar_dip_buffer_pct": 5,
            "hold_reserve_in_expensive_windows": True,
        }],
    )
    result, _trace = run_optimizer_with_trace(
        build_battery_reserve_optimizer(config), snapshot, config, reference_time=now,
    )
    assert inverter_action(result.slots.get(now.isoformat(), {})).kind == expected_kind


def test_snapshot_without_a_tariff_minimum_has_no_import_bands():
    now = datetime.fromisoformat("2026-11-21T23:15:00+01:00")
    prices = _prices(now)
    del prices["import"]["dailyMinPrice"]
    contexts = _contexts(_snapshot(now, prices))
    assert contexts
    assert all(ctx.import_bands == () for ctx in contexts.values())
