from __future__ import annotations

import sys
import types
import unittest
from datetime import date, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

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
    dt_mod.now = lambda: datetime.fromisoformat("2026-05-11T10:00:00+02:00")
    dt_mod.as_local = lambda value: value
    dt_mod.as_utc = lambda value: value
    sys.modules["homeassistant.util.dt"] = dt_mod
    util_mod.dt = dt_mod

    sys.modules.pop("custom_components.helman.solar_bias_correction.service", None)
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

PRAGUE = ZoneInfo("Europe/Prague")


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


def _slot(hour: int, minute: int = 0, day: int = 10) -> datetime:
    return datetime(2026, 5, day, hour, minute, tzinfo=PRAGUE)


class TestFilterBatteryForecastFuture(unittest.TestCase):
    """Net battery forecast: positive is charging, negative is discharging."""

    def _filter(self, series, local_now):
        return service_mod._filter_battery_forecast_future(
            {"series": series},
            target_date=date(2026, 5, 10),
            local_now=local_now,
            timezone=PRAGUE,
        )

    def test_nets_charge_against_discharge(self):
        points = self._filter(
            [
                {
                    "timestamp": _slot(13).isoformat(),
                    "chargedKwh": 1.2,
                    "dischargedKwh": 0.0,
                },
                {
                    "timestamp": _slot(19).isoformat(),
                    "chargedKwh": 0.0,
                    "dischargedKwh": 0.5,
                },
            ],
            local_now=_slot(12),
        )
        self.assertEqual([p["wh"] for p in points], [1200.0, -500.0])

    def test_skips_slots_already_started(self):
        points = self._filter(
            [
                {"timestamp": _slot(9).isoformat(), "chargedKwh": 1.0},
                {"timestamp": _slot(18).isoformat(), "chargedKwh": 2.0},
            ],
            local_now=_slot(12),
        )
        self.assertEqual([p["wh"] for p in points], [2000.0])

    def test_skips_entries_without_battery_fields(self):
        points = self._filter(
            [{"timestamp": _slot(18).isoformat(), "socPct": 65.0}],
            local_now=_slot(12),
        )
        self.assertEqual(points, [])

    def test_missing_side_counts_as_zero(self):
        points = self._filter(
            [{"timestamp": _slot(18).isoformat(), "dischargedKwh": 0.4}],
            local_now=_slot(12),
        )
        self.assertEqual([p["wh"] for p in points], [-400.0])


class TestLoadBatteryActual(unittest.IsolatedAsyncioTestCase):
    def _make_service(
        self,
        *,
        charge_entity="sensor.batt_charge",
        discharge_entity="sensor.batt_discharge",
    ):
        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague"),
            bus=SimpleNamespace(async_fire=lambda *a, **kw: None),
        )
        return service_mod.SolarBiasCorrectionService(
            hass,
            _DummyStore(),
            _make_cfg(),
            battery_charge_energy_entity_id_provider=lambda: charge_entity,
            battery_discharge_energy_entity_id_provider=lambda: discharge_entity,
        )

    async def test_nets_the_two_meters_per_slot(self):
        service = self._make_service()
        by_entity = {
            "sensor.batt_charge": {_slot(12): 0.8, _slot(13): 0.0},
            "sensor.batt_discharge": {_slot(13): 0.5, _slot(19): 0.3},
        }

        async def _fake_load(entity_id, target_date, local_tz):
            return by_entity[entity_id]

        with patch.object(service, "_load_slot_energy_kwh", side_effect=_fake_load):
            points = await service._load_battery_actual_for_date(date(2026, 5, 10), PRAGUE)

        # Positive is charged into the battery, negative is discharged out of it.
        self.assertEqual(
            [(p["timestamp"], p["wh"]) for p in points],
            [
                (_slot(12).isoformat(), 800.0),
                (_slot(13).isoformat(), -500.0),
                (_slot(19).isoformat(), -300.0),
            ],
        )

    async def test_charge_only_setup_still_yields_a_series(self):
        service = self._make_service(discharge_entity=None)

        async def _fake_load(entity_id, target_date, local_tz):
            self.assertEqual(entity_id, "sensor.batt_charge")
            return {_slot(12): 0.8}

        with patch.object(service, "_load_slot_energy_kwh", side_effect=_fake_load):
            points = await service._load_battery_actual_for_date(date(2026, 5, 10), PRAGUE)

        self.assertEqual(
            [(p["timestamp"], p["wh"]) for p in points], [(_slot(12).isoformat(), 800.0)]
        )

    async def test_discharge_only_setup_still_yields_a_series(self):
        service = self._make_service(charge_entity=None)

        async def _fake_load(entity_id, target_date, local_tz):
            self.assertEqual(entity_id, "sensor.batt_discharge")
            return {_slot(19): 0.3}

        with patch.object(service, "_load_slot_energy_kwh", side_effect=_fake_load):
            points = await service._load_battery_actual_for_date(date(2026, 5, 10), PRAGUE)

        self.assertEqual(
            [(p["timestamp"], p["wh"]) for p in points], [(_slot(19).isoformat(), -300.0)]
        )

    async def test_keeps_the_still_running_slot_for_the_daily_total(self):
        service = self._make_service()

        async def _fake_load(entity_id, target_date, local_tz):
            if entity_id == "sensor.batt_charge":
                return {_slot(9, 45): 0.2, _slot(10, 0): 0.1}
            return {}

        with patch.object(service, "_load_slot_energy_kwh", side_effect=_fake_load):
            points = await service._load_battery_actual_for_date(date(2026, 5, 10), PRAGUE)

        # The loader reports every Wh the meter recorded; the running slot is
        # dropped from the drawn series where the payload is assembled, so the
        # day's total still counts it.
        self.assertEqual(
            [p["timestamp"] for p in points],
            [_slot(9, 45).isoformat(), _slot(10, 0).isoformat()],
        )

    async def test_returns_empty_when_neither_meter_is_configured(self):
        service = self._make_service(charge_entity=None, discharge_entity=None)
        points = await service._load_battery_actual_for_date(date(2026, 5, 10), PRAGUE)
        self.assertEqual(points, [])


class TestRecordedBatteryForecastPoints(unittest.TestCase):
    def _make_service(self, slots):
        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague"),
            bus=SimpleNamespace(async_fire=lambda *a, **kw: None),
        )
        history = SimpleNamespace(slots_for_day=lambda target_date: slots)
        return service_mod.SolarBiasCorrectionService(
            hass,
            _DummyStore(),
            _make_cfg(),
            battery_forecast_history=history,
        )

    def test_reads_battery_net_alongside_soc_and_grid(self):
        service = self._make_service(
            {"08:00": {"socPct": 40.0, "gridNetWh": -100.0, "batteryNetWh": 250.0}}
        )
        soc, grid, battery, _, _ = service._recorded_battery_forecast_points(
            date(2026, 5, 10), cutoff=None, timezone=PRAGUE
        )
        self.assertEqual(soc, [{"slot": "08:00", "pct": 40.0}])
        self.assertEqual([p["wh"] for p in grid], [-100.0])
        self.assertEqual(
            [(p["timestamp"], p["wh"]) for p in battery],
            [(_slot(8).isoformat(), 250.0)],
        )

    def test_days_archived_before_battery_net_yield_no_battery_points(self):
        service = self._make_service({"08:00": {"socPct": 40.0, "gridNetWh": -100.0}})
        soc, grid, battery, _, _ = service._recorded_battery_forecast_points(
            date(2026, 5, 10), cutoff=None, timezone=PRAGUE
        )
        self.assertEqual(len(soc), 1)
        self.assertEqual(len(grid), 1)
        self.assertEqual(battery, [])


if __name__ == "__main__":
    unittest.main()
