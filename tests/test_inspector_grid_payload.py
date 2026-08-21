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

    # The inspector day asks the recorder where its statistics begin, which
    # imports the span module. Answering with nothing leaves the floor at the
    # trainer's window, which is what every assertion in this file was written
    # against.
    statistics_mod = types.ModuleType("homeassistant.components.recorder.statistics")
    statistics_mod.statistics_during_period = lambda *args, **kwargs: {}
    sys.modules["homeassistant.components.recorder.statistics"] = statistics_mod

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
TARGET_DATE = "2026-05-10"


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


class TestFilterGridForecastFuture(unittest.TestCase):
    """Net grid forecast: positive is exported, negative is imported."""

    def _filter(self, series, local_now):
        """The net series, which is what these cases are about."""
        return self._filter_all(series, local_now)[0]

    def _filter_all(self, series, local_now):
        return service_mod._filter_grid_forecast_future(
            {"series": series},
            target_date=date(2026, 5, 10),
            local_now=local_now,
            timezone=PRAGUE,
        )

    def test_nets_export_against_import(self):
        points = self._filter(
            [
                {
                    "timestamp": _slot(18).isoformat(),
                    "importedFromGridKwh": 1.2,
                    "exportedToGridKwh": 0.0,
                },
                {
                    "timestamp": _slot(19).isoformat(),
                    "importedFromGridKwh": 0.0,
                    "exportedToGridKwh": 0.5,
                },
            ],
            local_now=_slot(12),
        )
        self.assertEqual([p["wh"] for p in points], [-1200.0, 500.0])

    def test_skips_slots_already_started(self):
        points = self._filter(
            [
                {"timestamp": _slot(9).isoformat(), "importedFromGridKwh": 1.0},
                {"timestamp": _slot(18).isoformat(), "importedFromGridKwh": 2.0},
            ],
            local_now=_slot(12),
        )
        self.assertEqual([p["wh"] for p in points], [-2000.0])

    def test_skips_entries_without_grid_fields(self):
        points = self._filter(
            [{"timestamp": _slot(18).isoformat(), "socPct": 65.0}],
            local_now=_slot(12),
        )
        self.assertEqual(points, [])

    def test_missing_side_counts_as_zero(self):
        points = self._filter(
            [{"timestamp": _slot(18).isoformat(), "exportedToGridKwh": 0.4}],
            local_now=_slot(12),
        )
        self.assertEqual([p["wh"] for p in points], [400.0])


class TestGridSidesSurviveSeparately(unittest.TestCase):
    """The split money needs: a slot's two directions, not their difference."""

    def _filter_all(self, series, local_now):
        return service_mod._filter_grid_forecast_future(
            {"series": series},
            target_date=date(2026, 5, 10),
            local_now=local_now,
            timezone=PRAGUE,
        )

    def test_a_slot_that_both_imported_and_exported_keeps_both(self):
        # The case netting destroys, and the reason this split exists: each side
        # is billed at its own rate, so 0.4 net says nothing about what was paid.
        net, imported, exported = self._filter_all(
            [
                {
                    "timestamp": _slot(18).isoformat(),
                    "importedFromGridKwh": 0.3,
                    "exportedToGridKwh": 0.7,
                }
            ],
            local_now=_slot(12),
        )

        self.assertEqual([p["wh"] for p in net], [400.0])
        self.assertEqual([p["wh"] for p in imported], [300.0])
        self.assertEqual([p["wh"] for p in exported], [700.0])

    def test_each_side_is_a_positive_magnitude_of_its_own_direction(self):
        _, imported, exported = self._filter_all(
            [
                {
                    "timestamp": _slot(18).isoformat(),
                    "importedFromGridKwh": 1.2,
                    "exportedToGridKwh": 0.0,
                }
            ],
            local_now=_slot(12),
        )

        # Net would be -1200; the side itself is not signed by direction.
        self.assertEqual([p["wh"] for p in imported], [1200.0])
        self.assertEqual([p["wh"] for p in exported], [0.0])


class TestLoadGridActualSides(unittest.IsolatedAsyncioTestCase):
    async def test_the_meters_are_returned_unnetted(self):
        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague"),
            bus=SimpleNamespace(async_fire=lambda *a, **kw: None),
        )
        service = service_mod.SolarBiasCorrectionService(
            hass,
            _DummyStore(),
            _make_cfg(),
            grid_import_energy_entity_id_provider=lambda: "sensor.grid_import",
            grid_export_energy_entity_id_provider=lambda: "sensor.grid_export",
        )
        by_entity = {
            "sensor.grid_import": {_slot(6): 0.3},
            "sensor.grid_export": {_slot(6): 0.7},
        }

        net, imported, exported = await service._load_grid_actual_for_date(
            date(2026, 5, 10), by_entity
        )

        self.assertAlmostEqual(net[0]["wh"], 400.0, places=6)
        self.assertAlmostEqual(imported[0]["wh"], 300.0, places=6)
        self.assertAlmostEqual(exported[0]["wh"], 700.0, places=6)


class TestGridActualFailureStaysContained(unittest.IsolatedAsyncioTestCase):
    """One dead meter must not take the whole inspector day with it."""

    async def test_a_raising_loader_degrades_to_three_empty_series(self):
        # The loader returns a tuple, so the boundary's degraded value has to
        # have that shape: a bare [] would be unpacked by the caller and raise,
        # turning a contained failure into a failed request.
        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague"),
            bus=SimpleNamespace(async_fire=lambda *a, **kw: None),
        )
        service = service_mod.SolarBiasCorrectionService(
            hass, _DummyStore(), _make_cfg()
        )

        async def _boom():
            raise RuntimeError("recorder is down")

        self.assertEqual(
            await service._guarded_point_sets(_boom(), "grid actual", count=3),
            ([], [], []),
        )


class TestLoadGridActual(unittest.IsolatedAsyncioTestCase):
    def _make_service(self, *, import_entity="sensor.grid_import", export_entity="sensor.grid_export"):
        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague"),
            bus=SimpleNamespace(async_fire=lambda *a, **kw: None),
        )
        return service_mod.SolarBiasCorrectionService(
            hass,
            _DummyStore(),
            _make_cfg(),
            grid_import_energy_entity_id_provider=lambda: import_entity,
            grid_export_energy_entity_id_provider=lambda: export_entity,
        )

    async def test_nets_the_two_meters_per_slot(self):
        service = self._make_service()
        by_entity = {
            "sensor.grid_import": {_slot(6): 0.3, _slot(12): 0.0},
            "sensor.grid_export": {_slot(12): 0.8, _slot(13): 0.5},
        }

        points, _, _ = await service._load_grid_actual_for_date(
            date(2026, 5, 10), by_entity
        )

        # Positive is exported to the grid, negative is imported from it.
        self.assertEqual(
            [(p["timestamp"], p["wh"]) for p in points],
            [
                (_slot(6).isoformat(), -300.0),
                (_slot(12).isoformat(), 800.0),
                (_slot(13).isoformat(), 500.0),
            ],
        )

    async def test_import_only_setup_still_yields_a_series(self):
        service = self._make_service(export_entity=None)

        points, _, _ = await service._load_grid_actual_for_date(
            date(2026, 5, 10), {"sensor.grid_import": {_slot(6): 0.3}}
        )

        self.assertEqual([(p["timestamp"], p["wh"]) for p in points], [(_slot(6).isoformat(), -300.0)])

    async def test_export_only_setup_still_yields_a_series(self):
        service = self._make_service(import_entity=None)

        points, _, _ = await service._load_grid_actual_for_date(
            date(2026, 5, 10), {"sensor.grid_export": {_slot(12): 0.8}}
        )

        self.assertEqual([(p["timestamp"], p["wh"]) for p in points], [(_slot(12).isoformat(), 800.0)])

    async def test_keeps_the_still_running_slot_for_the_daily_total(self):
        service = self._make_service()

        points, _, _ = await service._load_grid_actual_for_date(
            date(2026, 5, 10),
            {"sensor.grid_import": {_slot(9, 45): 0.2, _slot(10, 0): 0.1}},
        )

        # The loader reports every Wh the meter recorded; the running slot is
        # dropped from the drawn series where the payload is assembled, so the
        # day's total still counts it.
        self.assertEqual(
            [p["timestamp"] for p in points],
            [_slot(9, 45).isoformat(), _slot(10, 0).isoformat()],
        )

    async def test_returns_empty_when_neither_meter_is_configured(self):
        service = self._make_service(import_entity=None, export_entity=None)
        self.assertEqual(
            await service._load_grid_actual_for_date(date(2026, 5, 10), PRAGUE),
            ([], [], []),
        )


class TestInspectorGridPayload(unittest.IsolatedAsyncioTestCase):
    async def test_payload_exposes_grid_series_totals_and_availability(self):
        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague"),
            bus=SimpleNamespace(async_fire=lambda *a, **kw: None),
        )
        service = service_mod.SolarBiasCorrectionService(
            hass,
            _DummyStore(),
            _make_cfg(),
            grid_import_energy_entity_id_provider=lambda: "sensor.grid_import",
            grid_export_energy_entity_id_provider=lambda: "sensor.grid_export",
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

        grid_actual = [
            {"timestamp": _slot(6).isoformat(), "wh": -300.0},
            {"timestamp": _slot(12).isoformat(), "wh": 800.0},
        ]
        grid_import_actual = [
            {"timestamp": _slot(6).isoformat(), "wh": 300.0},
            {"timestamp": _slot(12).isoformat(), "wh": 0.0},
        ]
        grid_export_actual = [
            {"timestamp": _slot(6).isoformat(), "wh": 0.0},
            {"timestamp": _slot(12).isoformat(), "wh": 800.0},
        ]

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
                AsyncMock(return_value=[]),
            ), patch.object(
                service, "_load_house_actual_for_date", AsyncMock(return_value=[])
            ), patch.object(
                service, "_load_battery_soc_actual_for_date", AsyncMock(return_value=[])
            ), patch.object(
                service,
                "_load_grid_actual_for_date",
                AsyncMock(
                    return_value=(grid_actual, grid_import_actual, grid_export_actual)
                ),
            ):
                payload = await service.async_get_inspector_day(TARGET_DATE)
        finally:
            service_mod.dt_util.now = old_now
            service_mod.load_actuals_for_day = old_actuals

        self.assertEqual(
            [p["valueWh"] for p in payload["series"]["gridActual"]], [-300.0, 800.0]
        )
        self.assertTrue(payload["availability"]["hasGridActual"])
        # Past date, so no forecast slots come out of the battery snapshot.
        self.assertFalse(payload["availability"]["hasGridForecast"])
        self.assertEqual(payload["totals"]["gridActualWh"], 500.0)
        self.assertIsNone(payload["totals"]["gridForecastWh"])
