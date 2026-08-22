"""The inspector's cumulative-energy meters are read in ONE recorder query.

The recorder serves every query from a single DB executor thread, so a read per
meter is a serial round-trip per meter however the awaits are arranged: the
inspector once issued eighteen of them and spent 0.4-1.7s in the gather. The
batched read is the fix, and it is only a fix while it stays one query, so this
counts the queries rather than trusting the shape of the call site.
"""

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

QUERIES: dict[str, list] = {"batched": [], "per_entity": []}


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

    async def _run_in_executor(func, *args):
        return func(*args)

    recorder_mod = types.ModuleType("homeassistant.components.recorder")
    recorder_mod.get_instance = lambda hass: SimpleNamespace(
        async_add_executor_job=_run_in_executor
    )
    sys.modules["homeassistant.components.recorder"] = recorder_mod

    history_mod = types.ModuleType("homeassistant.components.recorder.history")
    history_mod.state_changes_during_period = lambda *args, **kwargs: {}
    history_mod.get_significant_states = lambda *args, **kwargs: {}
    sys.modules["homeassistant.components.recorder.history"] = history_mod

    # The inspector day asks the recorder where its statistics begin, which
    # imports the span module. Nothing here is about that read -- it is
    # month-reduced and cached, and this file counts the *raw state* queries the
    # meters cost -- so it answers with nothing and the floor falls back to the
    # trainer's window.
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

    sys.modules.pop("custom_components.helman.recorder_hourly_series", None)
    sys.modules.pop("custom_components.helman.recorder_statistics_span", None)
    sys.modules.pop("custom_components.helman.solar_bias_correction.service", None)


_install_import_stubs()

import importlib  # noqa: E402

service_mod = importlib.import_module(
    "custom_components.helman.solar_bias_correction.service"
)
models = importlib.import_module(
    "custom_components.helman.solar_bias_correction.models"
)

recorder_series_mod = importlib.import_module(
    "custom_components.helman.recorder_hourly_series"
)


def _counting_queries():
    """Count the recorder reads the cumulative-meter helpers make, and only those.

    ``get_significant_states`` has other callers on the inspector's path — the
    forecast archive is one — so the counters are installed on the module under
    test rather than on the shared history module.
    """

    def _batched(hass, start, end, entity_ids=None, *args, **kwargs):
        QUERIES["batched"].append(list(entity_ids or []))
        return {}

    def _per_entity(hass, start, end, entity_id, *args, **kwargs):
        QUERIES["per_entity"].append(entity_id)
        return {}

    QUERIES["batched"].clear()
    QUERIES["per_entity"].clear()
    return patch.multiple(
        recorder_series_mod,
        get_significant_states=_batched,
        state_changes_during_period=_per_entity,
    )


PRAGUE = ZoneInfo("Europe/Prague")
TARGET_DATE = "2026-05-10"

HOUSE_METER = "sensor.house_energy"
GRID_IMPORT_METER = "sensor.grid_import"
GRID_EXPORT_METER = "sensor.grid_export"
BATTERY_CHARGE_METER = "sensor.batt_charge"
BATTERY_DISCHARGE_METER = "sensor.batt_discharge"
CONSUMER_METERS = [f"sensor.consumer_{index}" for index in range(13)]


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


def _make_service():
    hass = SimpleNamespace(
        config=SimpleNamespace(time_zone="Europe/Prague"),
        bus=SimpleNamespace(async_fire=lambda *a, **kw: None),
        states=SimpleNamespace(get=lambda entity_id: None),
    )
    service = service_mod.SolarBiasCorrectionService(
        hass,
        _DummyStore(),
        _make_cfg(),
        house_energy_entity_id_provider=lambda: HOUSE_METER,
        grid_import_energy_entity_id_provider=lambda: GRID_IMPORT_METER,
        grid_export_energy_entity_id_provider=lambda: GRID_EXPORT_METER,
        battery_charge_energy_entity_id_provider=lambda: BATTERY_CHARGE_METER,
        battery_discharge_energy_entity_id_provider=lambda: BATTERY_DISCHARGE_METER,
        house_deferrable_consumers_provider=lambda: [
            {"energy_entity_id": entity_id, "label": entity_id}
            for entity_id in CONSUMER_METERS
        ],
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
    return service


class TestInspectorIssuesOneCumulativeEnergyQuery(unittest.IsolatedAsyncioTestCase):
    async def test_eighteen_meters_cost_one_recorder_query(self):
        service = _make_service()

        old_actuals = service_mod.load_actuals_for_day
        try:
            service_mod.load_actuals_for_day = AsyncMock(return_value={})
            with _counting_queries(), patch.object(
                service_mod,
                "load_house_forecast_points_for_day",
                AsyncMock(return_value=[]),
            ), patch.object(
                service,
                "_load_recorded_price_rails",
                AsyncMock(return_value=([], [])),
            ):
                await service.async_get_inspector_day(TARGET_DATE)
        finally:
            service_mod.load_actuals_for_day = old_actuals

        # One query, covering every meter the day's actual series draw.
        self.assertEqual(len(QUERIES["batched"]), 1)
        self.assertEqual(
            sorted(QUERIES["batched"][0]),
            sorted(
                [
                    HOUSE_METER,
                    GRID_IMPORT_METER,
                    GRID_EXPORT_METER,
                    BATTERY_CHARGE_METER,
                    BATTERY_DISCHARGE_METER,
                    *CONSUMER_METERS,
                ]
            ),
        )
        # And not one per meter behind it: the per-entity read is what this
        # replaced, so reaching it at all is the regression.
        self.assertEqual(QUERIES["per_entity"], [])


class TestBatchedMeterRead(unittest.IsolatedAsyncioTestCase):
    """The helper itself, apart from the inspector."""

    async def test_one_query_serves_every_entity_and_de_duplicates(self):
        hass = SimpleNamespace(states=SimpleNamespace(get=lambda entity_id: None))
        local_start = datetime.combine(
            date.fromisoformat(TARGET_DATE), datetime.min.time(), tzinfo=PRAGUE
        )

        with _counting_queries():
            by_entity = (
                await recorder_series_mod.query_cumulative_slot_energy_changes_for_entities(
                    hass,
                    ["sensor.a", "sensor.b", "sensor.a"],
                    local_start=local_start,
                    local_end=local_start.replace(hour=1),
                    interval_minutes=15,
                )
            )

        self.assertEqual(QUERIES["batched"], [["sensor.a", "sensor.b"]])
        # Nothing recorded for either, so each maps to an empty series rather
        # than going missing — the singular function's behaviour.
        self.assertEqual(by_entity, {"sensor.a": {}, "sensor.b": {}})

    async def test_an_empty_entity_list_costs_no_query(self):
        hass = SimpleNamespace(states=SimpleNamespace(get=lambda entity_id: None))
        local_start = datetime.combine(
            date.fromisoformat(TARGET_DATE), datetime.min.time(), tzinfo=PRAGUE
        )

        with _counting_queries():
            self.assertEqual(
                await recorder_series_mod.query_cumulative_slot_energy_changes_for_entities(
                    hass,
                    [],
                    local_start=local_start,
                    local_end=local_start.replace(hour=1),
                    interval_minutes=15,
                ),
                {},
            )
        self.assertEqual(QUERIES["batched"], [])


if __name__ == "__main__":
    unittest.main()
