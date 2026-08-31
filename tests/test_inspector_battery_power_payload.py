from __future__ import annotations

import sys
import types
import unittest
from datetime import date, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
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

        points = await service._load_battery_actual_for_date(
            date(2026, 5, 10), by_entity
        )

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

        points = await service._load_battery_actual_for_date(
            date(2026, 5, 10), {"sensor.batt_charge": {_slot(12): 0.8}}
        )

        self.assertEqual(
            [(p["timestamp"], p["wh"]) for p in points], [(_slot(12).isoformat(), 800.0)]
        )

    async def test_discharge_only_setup_still_yields_a_series(self):
        service = self._make_service(charge_entity=None)

        points = await service._load_battery_actual_for_date(
            date(2026, 5, 10), {"sensor.batt_discharge": {_slot(19): 0.3}}
        )

        self.assertEqual(
            [(p["timestamp"], p["wh"]) for p in points], [(_slot(19).isoformat(), -300.0)]
        )

    async def test_keeps_the_still_running_slot_for_the_daily_total(self):
        service = self._make_service()

        points = await service._load_battery_actual_for_date(
            date(2026, 5, 10),
            {"sensor.batt_charge": {_slot(9, 45): 0.2, _slot(10, 0): 0.1}},
        )

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


class TestRecordedBatteryForecastPoints(unittest.IsolatedAsyncioTestCase):
    """The reader now reads the five published entities' recorder history.

    The store is gone, so these pin the branch and the trim rather than the
    ``.storage`` derivation (which moved to
    ``coordinator._battery_forecast_slot_values`` with the accessor).
    """

    def _make_service(self):
        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague"),
            bus=SimpleNamespace(async_fire=lambda *a, **kw: None),
        )
        return service_mod.SolarBiasCorrectionService(
            hass,
            _DummyStore(),
            _make_cfg(),
        )

    def _loader(self, *, soc=None, grid_net=None, battery_net=None):
        return AsyncMock(
            return_value=(
                soc or [],
                grid_net or [],
                battery_net or [],
                [],
                [],
            )
        )

    async def test_reads_battery_net_alongside_soc_and_grid(self):
        service = self._make_service()
        loader = self._loader(
            soc=[{"slot": "08:00", "pct": 40.0}],
            grid_net=[{"timestamp": _slot(8).isoformat(), "wh": -100.0}],
            battery_net=[{"timestamp": _slot(8).isoformat(), "wh": 250.0}],
        )
        with patch.object(service_mod, "load_battery_forecast_points_for_day", loader):
            soc, grid, battery, _, _ = await service._recorded_battery_forecast_points(
                date(2026, 5, 10),
                cutoff=None,
                timezone=PRAGUE,
                reads_statistics=False,
                statistics_day=service_mod.StatisticsDay(),
            )
        self.assertEqual(soc, [{"slot": "08:00", "pct": 40.0}])
        self.assertEqual([p["wh"] for p in grid], [-100.0])
        self.assertEqual(
            [(p["timestamp"], p["wh"]) for p in battery],
            [(_slot(8).isoformat(), 250.0)],
        )

    async def test_the_cutoff_trims_both_point_shapes(self):
        service = self._make_service()
        loader = self._loader(
            soc=[{"slot": "08:00", "pct": 40.0}, {"slot": "10:00", "pct": 55.0}],
            grid_net=[
                {"timestamp": _slot(8).isoformat(), "wh": -100.0},
                {"timestamp": _slot(10).isoformat(), "wh": 20.0},
            ],
        )
        with patch.object(service_mod, "load_battery_forecast_points_for_day", loader):
            soc, grid, *_ = await service._recorded_battery_forecast_points(
                date(2026, 5, 10),
                cutoff=_slot(9),
                timezone=PRAGUE,
                reads_statistics=False,
                statistics_day=service_mod.StatisticsDay(),
            )
        self.assertEqual([p["slot"] for p in soc], ["08:00"])
        self.assertEqual([p["wh"] for p in grid], [-100.0])

    async def test_a_purged_day_takes_the_five_from_the_statistics_day(self):
        service = self._make_service()
        stats = service_mod.StatisticsDay(
            battery_soc_forecast_points=[{"slot": "08:00", "pct": 33.0}],
            grid_net_forecast_points=[{"timestamp": _slot(8).isoformat(), "wh": 12.0}],
            battery_net_forecast_points=[{"timestamp": _slot(8).isoformat(), "wh": 9.0}],
        )
        loader = self._loader()
        with patch.object(service_mod, "load_battery_forecast_points_for_day", loader):
            soc, grid, battery, _, _ = await service._recorded_battery_forecast_points(
                date(2026, 5, 10),
                cutoff=None,
                timezone=PRAGUE,
                reads_statistics=True,
                statistics_day=stats,
            )
        loader.assert_not_awaited()
        self.assertEqual(soc, [{"slot": "08:00", "pct": 33.0}])
        self.assertEqual([p["wh"] for p in grid], [12.0])
        self.assertEqual([p["wh"] for p in battery], [9.0])


class _SyncRecorderInstance:
    async def async_add_executor_job(self, func):
        return func()


def _forecast_state(value: float, ts_iso: str):
    return SimpleNamespace(
        state=str(value), last_changed=datetime.fromisoformat(ts_iso)
    )


class TestLoadBatteryForecastPointsForDay(unittest.IsolatedAsyncioTestCase):
    """The raw-state reader's slot resolution.

    The sensors are written at the end of a rebuild that fires on the slot beat,
    so a slot's forecast is stamped a fraction of a second *after* the slot
    start. A ``<= slot_start`` sweep dropped that row and the slot kept the
    value published just after the previous beat -- the whole curve one slot
    late. States are seeded stamped late within their slot so a boundary-only
    seeding would not reproduce it.
    """

    async def _load(self, states_by_entity):
        battery_history = importlib.import_module(
            "custom_components.helman.solar_bias_correction.battery_forecast_history"
        )
        with patch.object(
            battery_history, "get_significant_states", lambda *a, **kw: states_by_entity
        ), patch.object(
            battery_history, "get_instance", lambda hass: _SyncRecorderInstance()
        ):
            return await battery_history.load_battery_forecast_points_for_day(
                SimpleNamespace(config=SimpleNamespace(time_zone="Europe/Prague")),
                date(2026, 5, 10),
                PRAGUE,
            )

    async def test_a_write_late_in_its_slot_is_that_slots_value(self):
        battery_history = importlib.import_module(
            "custom_components.helman.solar_bias_correction.battery_forecast_history"
        )
        soc_entity = battery_history.BATTERY_FORECAST_SOC_CURRENT_ENTITY
        net_entity = battery_history.BATTERY_FORECAST_GRID_NET_CURRENT_ENTITY
        soc, grid_net, *_ = await self._load(
            {
                soc_entity: [
                    _forecast_state(40.0, "2026-05-10T10:00:00.300000+02:00"),
                    _forecast_state(55.0, "2026-05-10T10:15:00.400000+02:00"),
                ],
                net_entity: [
                    _forecast_state(-100.0, "2026-05-10T10:00:00.300000+02:00"),
                    _forecast_state(20.0, "2026-05-10T10:15:00.400000+02:00"),
                ],
            }
        )

        by_slot = {p["slot"]: p["pct"] for p in soc}
        self.assertEqual(by_slot["10:00"], 40.0)
        # Its own value, published 0.4s into the slot -- not 40.0 held over.
        self.assertEqual(by_slot["10:15"], 55.0)
        # And held forward past the last write.
        self.assertEqual(by_slot["23:45"], 55.0)

        net_by_slot = {p["timestamp"][11:16]: p["wh"] for p in grid_net}
        self.assertEqual(net_by_slot["10:00"], -100.0)
        self.assertEqual(net_by_slot["10:15"], 20.0)

    async def test_a_later_write_in_the_same_slot_is_a_revision_and_ignored(self):
        battery_history = importlib.import_module(
            "custom_components.helman.solar_bias_correction.battery_forecast_history"
        )
        soc_entity = battery_history.BATTERY_FORECAST_SOC_CURRENT_ENTITY
        soc, *_ = await self._load(
            {
                soc_entity: [
                    _forecast_state(40.0, "2026-05-10T10:15:00.400000+02:00"),
                    # A republication later in the same slot: passed over.
                    _forecast_state(99.0, "2026-05-10T10:22:00+02:00"),
                ]
            }
        )
        by_slot = {p["slot"]: p["pct"] for p in soc}
        self.assertEqual(by_slot["10:15"], 40.0)


if __name__ == "__main__":
    unittest.main()
