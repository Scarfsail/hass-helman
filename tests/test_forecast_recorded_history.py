from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo

import asyncio
from functools import wraps

import pytest

from custom_components.helman.forecast import service
from custom_components.helman.solar_bias_correction import battery_forecast_history as battery_reader
from custom_components.helman.solar_bias_correction import house_forecast_history as house_reader


def run_async(test):
    @wraps(test)
    def run(*args, **kwargs):
        return asyncio.run(test(*args, **kwargs))
    return run


@pytest.mark.parametrize("failed", [None, "house", "battery", "empty"])
@run_async
async def test_response_keeps_forecast_history_independent_and_completed(failed):
    now = datetime.fromisoformat("2026-10-25T03:07:00+01:00")
    forecast = service.ForecastService.__new__(service.ForecastService)
    forecast._hass = SimpleNamespace(config=SimpleNamespace(time_zone="Europe/Prague"))
    forecast._async_get_canonical_solar_forecast = AsyncMock(return_value=None)
    forecast.grid_price_snapshot = lambda _: {}
    forecast._async_current_pipeline = AsyncMock(return_value=SimpleNamespace(
        adjusted_house_forecast={"status": "unavailable"},
        original_house_forecast={}, battery_forecast={"status": "unavailable"},
    ))
    timestamps = ["2026-10-25T02:00:00+01:00", "2026-10-25T02:00:00+02:00",
                  "2026-10-25T02:00:00+01:00", "2026-10-25T03:00:00+01:00",
                  "2026-10-24T23:45:00+02:00"]
    house = AsyncMock(return_value=[{"timestamp": t, "wh": 250} for t in timestamps])
    battery = AsyncMock(return_value=[{"timestamp": t, "value": 42} for t in timestamps])
    if failed == "empty":
        house.return_value = []
        battery.return_value = []
    if failed == "house":
        house.side_effect = RuntimeError("recorder failed")
    if failed == "battery":
        battery.side_effect = RuntimeError("recorder failed")
    with patch.object(service.dt_util, "now", return_value=now), patch.object(
        service, "load_house_forecast_points_for_day", house
    ), patch.object(service, "load_battery_soc_forecast_points_for_day", battery):
        result = await forecast.get_forecast()
    for channel, name, value in [("house_consumption", "house", .25), ("battery_capacity", "battery", 42)]:
        assert result[channel]["series"] == []
        assert result[channel]["actualHistory"] == []
        assert result[channel]["forecastHistory"] == ([] if failed in {name, "empty"} else [
            {"timestamp": "2026-10-25T02:00:00+02:00", "value": value},
            {"timestamp": "2026-10-25T02:00:00+01:00", "value": value},
        ])
    assert house.call_args.kwargs["until"].minute == 0
    assert battery.call_args.kwargs["until"].minute == 0


@pytest.mark.parametrize("reader", ["house", "battery"])
@run_async
async def test_recorded_reader_preserves_repeated_hour_and_hold_breakers(reader):
    tz = ZoneInfo("Europe/Prague")
    hass = SimpleNamespace(config=SimpleNamespace(time_zone="Europe/Prague"))
    target = date(2026, 10, 25)
    until = datetime.fromisoformat("2026-10-25T02:30:00+01:00")
    states = [SimpleNamespace(state=value, last_updated=datetime.fromisoformat(timestamp)) for value, timestamp in [
        ("800", "2026-10-25T02:00:00.5+02:00"),
        ("900", "2026-10-25T02:05:00+02:00"),
        ("unavailable", "2026-10-25T02:20:00+02:00"),
        ("1200", "2026-10-25T02:00:00.5+01:00"),
        ("9999", "2026-10-25T02:30:00.5+01:00"),
    ]]
    mod = house_reader if reader == "house" else battery_reader
    entity = mod.HOUSE_FORECAST_CURRENT_ENTITY if reader == "house" else mod.BATTERY_SOC_FORECAST_CURRENT_ENTITY
    with patch.object(mod, "read_states", AsyncMock(return_value={entity: states})) as read:
        points = await (mod.load_house_forecast_points_for_day(hass, target, until=until) if reader == "house"
                        else mod.load_battery_soc_forecast_points_for_day(hass, target, tz, until=until))
    values = {p["timestamp"]: p.get("wh", p.get("value")) for p in points}
    scale = .25 if reader == "house" else 1
    assert values["2026-10-25T02:00:00+02:00"] == 800 * scale
    assert values["2026-10-25T02:00:00+01:00"] == 1200 * scale
    assert "2026-10-25T02:30:00+02:00" not in values
    assert "2026-10-25T02:30:00+01:00" not in values
    assert read.call_args.args[3] == until
