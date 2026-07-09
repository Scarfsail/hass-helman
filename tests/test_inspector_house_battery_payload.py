from __future__ import annotations

import asyncio
import sys
import types
import unittest
from datetime import date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]


def _install_import_stubs() -> None:
    for name, path in [
        ("custom_components", ROOT / "custom_components"),
        ("custom_components.helman", ROOT / "custom_components" / "helman"),
        (
            "custom_components.helman.solar_bias_correction",
            ROOT / "custom_components" / "helman" / "solar_bias_correction",
        ),
    ]:
        pkg = sys.modules.get(name) or types.ModuleType(name)
        pkg.__path__ = [str(path)]
        sys.modules[name] = pkg

    ha_mod = types.ModuleType("homeassistant")
    ha_mod.__path__ = []
    sys.modules["homeassistant"] = ha_mod

    components_mod = types.ModuleType("homeassistant.components")
    components_mod.__path__ = []
    sys.modules["homeassistant.components"] = components_mod

    recorder_mod = types.ModuleType("homeassistant.components.recorder")
    recorder_mod.get_instance = lambda hass: None
    sys.modules["homeassistant.components.recorder"] = recorder_mod

    history_mod = types.ModuleType("homeassistant.components.recorder.history")
    history_mod.state_changes_during_period = lambda *args, **kwargs: {}

    async def _fake_get_significant_states(*args, **kwargs):
        return {}

    history_mod.get_significant_states = _fake_get_significant_states
    sys.modules["homeassistant.components.recorder.history"] = history_mod

    core_mod = types.ModuleType("homeassistant.core")
    core_mod.HomeAssistant = type("HomeAssistant", (), {})
    core_mod.callback = lambda func: func
    sys.modules["homeassistant.core"] = core_mod

    util_mod = types.ModuleType("homeassistant.util")
    sys.modules["homeassistant.util"] = util_mod
    dt_mod = types.ModuleType("homeassistant.util.dt")
    # "now" is after 2026-05-10, so that date is in the past
    dt_mod.now = lambda: datetime.fromisoformat("2026-05-11T10:00:00+02:00")
    dt_mod.as_local = lambda value: value
    dt_mod.as_utc = lambda value: value
    sys.modules["homeassistant.util.dt"] = dt_mod
    util_mod.dt = dt_mod

    # Force a fresh service import (test_solar_bias_service_runtime.py pops the
    # service module at collection time, which can leave it cached without the
    # load_house_forecast_points_for_day attribute when tests run in full suite).
    sys.modules.pop(
        "custom_components.helman.solar_bias_correction.service", None
    )
    sys.modules.pop(
        "custom_components.helman.solar_bias_correction.house_forecast_history", None
    )


_install_import_stubs()

import importlib  # noqa: E402

service_mod = importlib.import_module(
    "custom_components.helman.solar_bias_correction.service"
)
models = importlib.import_module(
    "custom_components.helman.solar_bias_correction.models"
)

TARGET_DATE = "2026-05-10"

HOUSE_FC_POINTS = [
    {"timestamp": f"{TARGET_DATE}T00:00:00+02:00", "wh": 200.0}
]
HOUSE_ACTUAL_POINTS = [
    {"timestamp": f"{TARGET_DATE}T00:00:00+02:00", "wh": 180.0}
]
BATTERY_SOC_ACTUAL = [
    {"slot": "00:00", "pct": 88.0}
]
BATTERY_SNAPSHOT = {
    "status": "available",
    "series": [
        {"timestamp": f"{TARGET_DATE}T18:00:00+02:00", "socPct": 65.0},
    ],
}


async def _battery_forecast_provider():
    return BATTERY_SNAPSHOT


class _DummyStore:
    profile = None

    async def async_save(self, payload):
        self.saved = payload


def _make_cfg():
    return models.BiasConfig(
        enabled=True,
        min_history_days=2,
        training_time="03:00",
        clamp_min=0.3,
        clamp_max=2.0,
        aggregation_method="ratio_of_sums",
        daily_energy_entity_ids=["sensor.solar_today", "sensor.solar_tomorrow"],
        total_energy_entity_id="sensor.solar_total",
    )


class TestInspectorHouseBatteryPayload(unittest.IsolatedAsyncioTestCase):

    async def test_inspector_payload_includes_house_and_battery_fields(self):
        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague"),
            bus=SimpleNamespace(async_fire=lambda *a, **kw: None),
        )
        service = service_mod.SolarBiasCorrectionService(
            hass,
            _DummyStore(),
            _make_cfg(),
            battery_forecast_provider=_battery_forecast_provider,
            house_energy_entity_id_provider=lambda: "sensor.house_energy",
            battery_soc_entity_id_provider=lambda: "sensor.battery_soc",
        )

        service._profile = models.SolarBiasProfile(factors={}, omitted_slots=[])
        service._metadata = models.SolarBiasMetadata(
            trained_at="2026-05-01T03:00:00+02:00",
            training_config_fingerprint="fp",
            usable_days=5,
            dropped_days=[],
            factor_min=None,
            factor_max=None,
            factor_median=None,
            omitted_slot_count=0,
            last_outcome="profile_trained",
        )

        old_now = service_mod.dt_util.now
        old_actuals = service_mod.load_actuals_for_day
        try:
            service_mod.dt_util.now = lambda: datetime.fromisoformat(
                "2026-05-11T10:00:00+02:00"
            )
            service_mod.load_actuals_for_day = AsyncMock(return_value={})
            with patch.object(
                service_mod,
                "load_house_forecast_points_for_day",
                AsyncMock(return_value=HOUSE_FC_POINTS),
            ), patch.object(
                service,
                "_load_house_actual_for_date",
                AsyncMock(return_value=HOUSE_ACTUAL_POINTS),
            ), patch.object(
                service,
                "_load_battery_soc_actual_for_date",
                AsyncMock(return_value=BATTERY_SOC_ACTUAL),
            ):
                payload = await service.async_get_inspector_day(TARGET_DATE)
        finally:
            service_mod.dt_util.now = old_now
            service_mod.load_actuals_for_day = old_actuals

        # series
        self.assertEqual(payload["series"]["houseForecast"][0]["valueWh"], 200.0)
        self.assertEqual(payload["series"]["houseActual"][0]["valueWh"], 180.0)
        self.assertEqual(payload["series"]["batterySocActual"][0]["slot"], "00:00")
        self.assertAlmostEqual(payload["series"]["batterySocActual"][0]["pct"], 88.0)

        # availability
        self.assertTrue(payload["availability"]["hasHouseForecast"])
        self.assertTrue(payload["availability"]["hasHouseActual"])
        self.assertTrue(payload["availability"]["hasBatterySocActual"])
        # past date → battery SoC forecast is not populated
        self.assertFalse(payload["availability"]["hasBatterySocForecast"])

        # totals
        self.assertEqual(payload["totals"]["houseForecastWh"], 200.0)
        self.assertEqual(payload["totals"]["houseActualWh"], 180.0)
