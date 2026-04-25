from __future__ import annotations

import asyncio
import importlib
import sys
import types
from datetime import date, datetime
from pathlib import Path
from types import SimpleNamespace

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
    history_mod.get_significant_states = lambda *args, **kwargs: {}
    sys.modules["homeassistant.components.recorder.history"] = history_mod

    core_mod = types.ModuleType("homeassistant.core")
    core_mod.HomeAssistant = type("HomeAssistant", (), {})
    core_mod.callback = lambda func: func
    sys.modules["homeassistant.core"] = core_mod

    util_mod = types.ModuleType("homeassistant.util")
    sys.modules["homeassistant.util"] = util_mod
    dt_mod = types.ModuleType("homeassistant.util.dt")
    dt_mod.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
    dt_mod.as_local = lambda value: value
    dt_mod.as_utc = lambda value: value
    sys.modules["homeassistant.util.dt"] = dt_mod
    util_mod.dt = dt_mod


_install_import_stubs()

models = importlib.import_module("custom_components.helman.solar_bias_correction.models")


def test_inspector_day_serializes_frontend_contract():
    payload = models.inspector_day_to_payload(
        models.SolarBiasInspectorDay(
            date="2026-04-25",
            timezone="Europe/Prague",
            status="applied",
            effective_variant="adjusted",
            trained_at="2026-04-25T03:00:04+02:00",
            min_date="2026-04-18",
            max_date="2026-04-27",
            series=models.SolarBiasInspectorSeries(
                raw=[
                    models.SolarBiasInspectorPoint(
                        timestamp="2026-04-25T08:00:00+02:00",
                        value_wh=420.0,
                    )
                ],
                corrected=[
                    models.SolarBiasInspectorPoint(
                        timestamp="2026-04-25T08:00:00+02:00",
                        value_wh=510.0,
                    )
                ],
                actual=[
                    models.SolarBiasInspectorPoint(
                        timestamp="2026-04-25T08:00:00+02:00",
                        value_wh=480.0,
                    )
                ],
                factors=[models.SolarBiasFactorPoint(slot="08:00", factor=1.21)],
            ),
            totals=models.SolarBiasInspectorTotals(
                raw_wh=420.0,
                corrected_wh=510.0,
                actual_wh=480.0,
            ),
            availability=models.SolarBiasInspectorAvailability(
                has_raw_forecast=True,
                has_corrected_forecast=True,
                has_actuals=True,
                has_profile=True,
            ),
            is_today=True,
            is_future=False,
        )
    )

    assert payload == {
        "date": "2026-04-25",
        "timezone": "Europe/Prague",
        "status": "applied",
        "effectiveVariant": "adjusted",
        "trainedAt": "2026-04-25T03:00:04+02:00",
        "range": {
            "minDate": "2026-04-18",
            "maxDate": "2026-04-27",
            "canGoPrevious": True,
            "canGoNext": True,
            "isToday": True,
            "isFuture": False,
        },
        "series": {
            "raw": [{"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 420.0}],
            "corrected": [{"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 510.0}],
            "actual": [{"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 480.0}],
            "factors": [{"slot": "08:00", "factor": 1.21}],
        },
        "totals": {"rawWh": 420.0, "correctedWh": 510.0, "actualWh": 480.0},
        "availability": {
            "hasRawForecast": True,
            "hasCorrectedForecast": True,
            "hasActuals": True,
            "hasProfile": True,
        },
    }


forecast_history = importlib.import_module(
    "custom_components.helman.solar_bias_correction.forecast_history"
)
actuals = importlib.import_module(
    "custom_components.helman.solar_bias_correction.actuals"
)


def _make_cfg():
    return models.BiasConfig(
        enabled=True,
        min_history_days=2,
        training_time="03:00",
        clamp_min=0.3,
        clamp_max=2.0,
        daily_energy_entity_ids=["sensor.solar_today", "sensor.solar_tomorrow"],
        total_energy_entity_id="sensor.solar_total",
    )


def test_load_forecast_points_for_day_reads_daily_entity_slots():
    class _States:
        def get(self, entity_id):
            if entity_id == "sensor.solar_today":
                return SimpleNamespace(
                    attributes={
                        "wh_period": {
                            "2026-04-25T00:00:00+02:00": 0,
                            "2026-04-25T01:00:00+02:00": 250,
                        }
                    }
                )
            return None

    hass = SimpleNamespace(
        states=_States(),
        config=SimpleNamespace(time_zone="Europe/Prague"),
    )

    result = asyncio.run(
        forecast_history.load_forecast_points_for_day(
            hass,
            _make_cfg(),
            date.fromisoformat("2026-04-25"),
            local_now=datetime.fromisoformat("2026-04-25T10:00:00+02:00"),
        )
    )

    assert result == [
        {"timestamp": "2026-04-25T00:00:00+02:00", "value": 0.0},
        {"timestamp": "2026-04-25T01:00:00+02:00", "value": 250.0},
    ]


def test_load_forecast_points_for_day_selects_entity_by_day_offset():
    requested_entities = []

    class _States:
        def get(self, entity_id):
            requested_entities.append(entity_id)
            if entity_id == "sensor.solar_tomorrow":
                return SimpleNamespace(
                    attributes={
                        "wh_period": {
                            "2026-04-26T00:00:00+02:00": 1,
                            "2026-04-26T01:00:00+02:00": 2,
                        }
                    }
                )
            return None

    hass = SimpleNamespace(
        states=_States(),
        config=SimpleNamespace(time_zone="Europe/Prague"),
    )

    result = asyncio.run(
        forecast_history.load_forecast_points_for_day(
            hass,
            _make_cfg(),
            date.fromisoformat("2026-04-26"),
            local_now=datetime.fromisoformat("2026-04-25T10:00:00+02:00"),
        )
    )

    assert requested_entities == ["sensor.solar_tomorrow"]
    assert result == [
        {"timestamp": "2026-04-26T00:00:00+02:00", "value": 1.0},
        {"timestamp": "2026-04-26T01:00:00+02:00", "value": 2.0},
    ]


def test_load_forecast_points_for_day_sorts_attribute_timestamps_by_utc():
    class _States:
        def get(self, entity_id):
            if entity_id == "sensor.solar_today":
                return SimpleNamespace(
                    attributes={
                        "wh_period": {
                            "2026-04-25T01:00:00+02:00": 2,
                            "2026-04-25T00:00:00+02:00": 1,
                        }
                    }
                )
            return None

    hass = SimpleNamespace(
        states=_States(),
        config=SimpleNamespace(time_zone="Europe/Prague"),
    )

    result = asyncio.run(
        forecast_history.load_forecast_points_for_day(
            hass,
            _make_cfg(),
            date.fromisoformat("2026-04-25"),
            local_now=datetime.fromisoformat("2026-04-25T10:00:00+02:00"),
        )
    )

    assert result == [
        {"timestamp": "2026-04-25T00:00:00+02:00", "value": 1.0},
        {"timestamp": "2026-04-25T01:00:00+02:00", "value": 2.0},
    ]


def test_load_forecast_points_for_day_returns_empty_outside_configured_horizon():
    hass = SimpleNamespace(
        states=SimpleNamespace(get=lambda entity_id: None),
        config=SimpleNamespace(time_zone="Europe/Prague"),
    )

    result = asyncio.run(
        forecast_history.load_forecast_points_for_day(
            hass,
            _make_cfg(),
            date.fromisoformat("2026-04-29"),
            local_now=datetime.fromisoformat("2026-04-25T10:00:00+02:00"),
        )
    )

    assert result == []


def test_load_actuals_for_day_uses_existing_slot_actual_reader():
    captured = {}

    async def fake_read_day_slot_actuals(hass, entity_id, target_date, *, local_now):
        captured["args"] = (entity_id, target_date, local_now)
        return {"08:00": 120.0, "08:15": 80.0}

    original = actuals._read_day_slot_actuals
    actuals._read_day_slot_actuals = fake_read_day_slot_actuals
    try:
        result = asyncio.run(
            actuals.load_actuals_for_day(
                SimpleNamespace(),
                _make_cfg(),
                date.fromisoformat("2026-04-24"),
                local_now=datetime.fromisoformat("2026-04-25T10:00:00+02:00"),
            )
        )
    finally:
        actuals._read_day_slot_actuals = original

    assert captured["args"][0] == "sensor.solar_total"
    assert captured["args"][1] == date.fromisoformat("2026-04-24")
    assert result == {"08:00": 120.0, "08:15": 80.0}
