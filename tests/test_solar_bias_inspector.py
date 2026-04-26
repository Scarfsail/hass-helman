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
            "invalidated": [],
            "factors": [{"slot": "08:00", "factor": 1.21}],
        },
        "totals": {"rawWh": 420.0, "correctedWh": 510.0, "actualWh": 480.0},
        "availability": {
            "hasRawForecast": True,
            "hasCorrectedForecast": True,
            "hasActuals": True,
            "hasProfile": True,
            "hasInvalidated": False,
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


def test_load_forecast_points_for_day_reads_history_for_past_days():
    async def mock_read_historical(hass, cfg, target_date, local_tz):
        # Create 24 hourly entries with 100 at 06:00 and 200 at 07:00, 0 for all others
        wh_period = {}
        for hour in range(24):
            timestamp = f"2026-04-24T{hour:02d}:00:00+02:00"
            if hour == 6:
                wh_period[timestamp] = 100
            elif hour == 7:
                wh_period[timestamp] = 200
            else:
                wh_period[timestamp] = 0

        return SimpleNamespace(
            attributes={
                "wh_period": wh_period
            }
        )

    original = forecast_history._read_historical_forecast_state
    forecast_history._read_historical_forecast_state = mock_read_historical

    try:
        hass = SimpleNamespace(
            states=SimpleNamespace(get=lambda entity_id: None),
            config=SimpleNamespace(time_zone="Europe/Prague"),
        )

        cfg = _make_cfg()
        cfg.daily_energy_entity_ids = ["sensor.today", "sensor.tomorrow"]

        result = asyncio.run(
            forecast_history.load_forecast_points_for_day(
                hass,
                cfg,
                date.fromisoformat("2026-04-24"),
                local_now=datetime.fromisoformat("2026-04-25T10:00:00+02:00"),
            )
        )

        assert len(result) == 24
        # 6:00 is slot 6
        assert result[6]["timestamp"] == "2026-04-24T06:00:00+02:00"
        assert result[6]["value"] == 100.0
        # 7:00 is slot 7
        assert result[7]["timestamp"] == "2026-04-24T07:00:00+02:00"
        assert result[7]["value"] == 200.0
    finally:
        forecast_history._read_historical_forecast_state = original


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


service_mod = importlib.import_module("custom_components.helman.solar_bias_correction.service")


class _DummyStore:
    profile = None

    async def async_save(self, payload):
        self.saved = payload


def _make_service():
    hass = SimpleNamespace(
        config=SimpleNamespace(time_zone="Europe/Prague"),
        bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None),
    )
    return service_mod.SolarBiasCorrectionService(hass, _DummyStore(), _make_cfg())


def test_inspector_day_applies_current_profile_and_totals():
    service = _make_service()
    service._profile = models.SolarBiasProfile(
        factors={"08:00": 1.5, "09:00": 0.5},
        omitted_slots=[],
    )
    service._metadata = models.SolarBiasMetadata(
        trained_at="2026-04-25T03:00:00+02:00",
        training_config_fingerprint=service_mod.compute_fingerprint(_make_cfg()),
        usable_days=12,
        dropped_days=[],
        factor_min=0.5,
        factor_max=1.5,
        factor_median=1.0,
        omitted_slot_count=0,
        last_outcome="profile_trained",
        error_reason=None,
    )

    async def fake_forecast_points(*args, **kwargs):
        return [
            {"timestamp": "2026-04-25T08:00:00+02:00", "value": 100.0},
            {"timestamp": "2026-04-25T09:00:00+02:00", "value": 200.0},
        ]

    async def fake_actuals(*args, **kwargs):
        return {"08:00": 90.0}

    old_forecast = service_mod.load_forecast_points_for_day
    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_forecast_points_for_day = fake_forecast_points
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-25"))
    finally:
        service_mod.load_forecast_points_for_day = old_forecast
        service_mod.load_actuals_for_day = old_actuals
        service_mod.dt_util.now = old_now

    assert payload["status"] == "applied"
    assert payload["effectiveVariant"] == "adjusted"
    assert payload["availability"] == {
        "hasRawForecast": True,
        "hasCorrectedForecast": True,
        "hasActuals": True,
        "hasProfile": True,
        "hasInvalidated": False,
    }
    assert payload["series"]["raw"] == [
        {"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 100.0},
        {"timestamp": "2026-04-25T09:00:00+02:00", "valueWh": 200.0},
    ]
    assert payload["series"]["corrected"] == [
        {"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 150.0},
        {"timestamp": "2026-04-25T09:00:00+02:00", "valueWh": 100.0},
    ]
    assert payload["series"]["actual"] == [
        {"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 90.0}
    ]
    assert payload["series"]["factors"] == [
        {"slot": "08:00", "factor": 1.5},
        {"slot": "09:00", "factor": 0.5},
    ]
    assert payload["totals"] == {"rawWh": 300.0, "correctedWh": 250.0, "actualWh": 90.0}
    assert payload["range"]["minDate"] == "2026-04-18"
    assert payload["range"]["isToday"] is True


def test_inspector_day_without_profile_keeps_corrected_equal_to_raw():
    service = _make_service()

    async def fake_forecast_points(*args, **kwargs):
        return [{"timestamp": "2026-04-25T08:00:00+02:00", "value": 100.0}]

    async def fake_actuals(*args, **kwargs):
        return {}

    old_forecast = service_mod.load_forecast_points_for_day
    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_forecast_points_for_day = fake_forecast_points
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-25"))
    finally:
        service_mod.load_forecast_points_for_day = old_forecast
        service_mod.load_actuals_for_day = old_actuals
        service_mod.dt_util.now = old_now

    assert payload["effectiveVariant"] == "raw"
    assert payload["availability"]["hasProfile"] is False
    assert payload["availability"]["hasCorrectedForecast"] is True
    assert payload["series"]["corrected"] == payload["series"]["raw"]
    assert payload["series"]["factors"] == []


def test_inspector_day_stale_profile_shows_factors_but_uses_raw_variant():
    service = _make_service()
    service._profile = models.SolarBiasProfile(
        factors={"08:00": 2.0},
        omitted_slots=[],
    )
    service._metadata = models.SolarBiasMetadata(
        trained_at="2026-04-25T03:00:00+02:00",
        training_config_fingerprint=service_mod.compute_fingerprint(_make_cfg()),
        usable_days=12,
        dropped_days=[],
        factor_min=2.0,
        factor_max=2.0,
        factor_median=2.0,
        omitted_slot_count=0,
        last_outcome="profile_trained",
        error_reason=None,
    )
    service._is_stale = True

    async def fake_forecast_points(*args, **kwargs):
        return [{"timestamp": "2026-04-25T08:00:00+02:00", "value": 100.0}]

    async def fake_actuals(*args, **kwargs):
        return {}

    old_forecast = service_mod.load_forecast_points_for_day
    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_forecast_points_for_day = fake_forecast_points
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-25"))
    finally:
        service_mod.load_forecast_points_for_day = old_forecast
        service_mod.load_actuals_for_day = old_actuals
        service_mod.dt_util.now = old_now

    assert payload["status"] == "config_changed_pending_retrain"
    assert payload["effectiveVariant"] == "raw"
    assert payload["availability"]["hasProfile"] is True
    assert payload["series"]["factors"] == [{"slot": "08:00", "factor": 2.0}]
    assert payload["series"]["corrected"] == payload["series"]["raw"]


def test_inspector_day_training_failed_preserved_profile_remains_adjusted():
    service = _make_service()
    service._profile = models.SolarBiasProfile(
        factors={"08:00": 2.0},
        omitted_slots=[],
    )
    service._metadata = models.SolarBiasMetadata(
        trained_at="2026-04-25T03:00:00+02:00",
        training_config_fingerprint=service_mod.compute_fingerprint(_make_cfg()),
        usable_days=12,
        dropped_days=[],
        factor_min=2.0,
        factor_max=2.0,
        factor_median=2.0,
        omitted_slot_count=0,
        last_outcome="training_failed",
        error_reason="boom",
    )

    async def fake_forecast_points(*args, **kwargs):
        return [{"timestamp": "2026-04-25T08:00:00+02:00", "value": 100.0}]

    async def fake_actuals(*args, **kwargs):
        return {}

    old_forecast = service_mod.load_forecast_points_for_day
    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_forecast_points_for_day = fake_forecast_points
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-25"))
    finally:
        service_mod.load_forecast_points_for_day = old_forecast
        service_mod.load_actuals_for_day = old_actuals
        service_mod.dt_util.now = old_now

    assert payload["status"] == "training_failed"
    assert payload["effectiveVariant"] == "adjusted"
    assert payload["availability"]["hasProfile"] is True
    assert payload["series"]["factors"] == [{"slot": "08:00", "factor": 2.0}]
    assert payload["series"]["corrected"] == [
        {"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 200.0}
    ]


def test_inspector_day_routes_invalidated_actual_points_out_of_actual_series():
    service = _make_service()
    service._profile = models.SolarBiasProfile(
        factors={"08:15": 1.5, "09:15": 0.5},
        omitted_slots=[],
    )
    service._metadata = models.SolarBiasMetadata(
        trained_at="2026-04-25T03:00:00+02:00",
        training_config_fingerprint=service_mod.compute_fingerprint(_make_cfg()),
        usable_days=12,
        dropped_days=[],
        factor_min=0.5,
        factor_max=1.5,
        factor_median=1.0,
        omitted_slot_count=0,
        last_outcome="profile_trained",
        invalidated_slots_by_date={"2026-04-24": ["08:00"]},
        invalidated_slot_count=1,
        error_reason=None,
    )

    async def fake_forecast_points(*args, **kwargs):
        return [
            {"timestamp": "2026-04-24T08:00:00+02:00", "value": 100.0},
            {"timestamp": "2026-04-24T09:00:00+02:00", "value": 200.0},
        ]

    async def fake_actuals(*args, **kwargs):
        return {"08:00": 40.0, "08:15": 50.0, "09:00": 60.0}

    old_forecast = service_mod.load_forecast_points_for_day
    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_forecast_points_for_day = fake_forecast_points
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-24"))
    finally:
        service_mod.load_forecast_points_for_day = old_forecast
        service_mod.load_actuals_for_day = old_actuals
        service_mod.dt_util.now = old_now

    assert payload["series"]["actual"] == [
        {"timestamp": "2026-04-24T09:00:00+02:00", "valueWh": 60.0}
    ]
    assert payload["series"]["invalidated"] == [
        {"timestamp": "2026-04-24T08:00:00+02:00", "valueWh": 40.0},
        {"timestamp": "2026-04-24T08:15:00+02:00", "valueWh": 50.0},
    ]
    assert payload["availability"]["hasInvalidated"] is True
    assert (
        payload["series"]["actual"] + payload["series"]["invalidated"]
        == [
            {"timestamp": "2026-04-24T09:00:00+02:00", "valueWh": 60.0},
            {"timestamp": "2026-04-24T08:00:00+02:00", "valueWh": 40.0},
            {"timestamp": "2026-04-24T08:15:00+02:00", "valueWh": 50.0},
        ]
    )


def test_inspector_day_uses_raw_forecast_slots_before_profile_slots_for_partition():
    service = _make_service()
    service._profile = models.SolarBiasProfile(
        factors={"08:15": 1.5, "09:15": 0.5},
        omitted_slots=[],
    )
    service._metadata = models.SolarBiasMetadata(
        trained_at="2026-04-25T03:00:00+02:00",
        training_config_fingerprint=service_mod.compute_fingerprint(_make_cfg()),
        usable_days=12,
        dropped_days=[],
        factor_min=0.5,
        factor_max=1.5,
        factor_median=1.0,
        omitted_slot_count=0,
        last_outcome="profile_trained",
        invalidated_slots_by_date={"2026-04-24": ["08:00"]},
        invalidated_slot_count=1,
        error_reason=None,
    )

    async def fake_forecast_points(*args, **kwargs):
        return [
            {"timestamp": "2026-04-24T08:00:00+02:00", "value": 100.0},
            {"timestamp": "2026-04-24T09:00:00+02:00", "value": 200.0},
        ]

    async def fake_actuals(*args, **kwargs):
        return {"08:10": 40.0}

    old_forecast = service_mod.load_forecast_points_for_day
    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_forecast_points_for_day = fake_forecast_points
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-24"))
    finally:
        service_mod.load_forecast_points_for_day = old_forecast
        service_mod.load_actuals_for_day = old_actuals
        service_mod.dt_util.now = old_now

    assert payload["series"]["actual"] == []
    assert payload["series"]["invalidated"] == [
        {"timestamp": "2026-04-24T08:10:00+02:00", "valueWh": 40.0}
    ]


def test_inspector_day_keeps_before_first_forecast_slot_actual_in_actual_series():
    service = _make_service()
    service._profile = models.SolarBiasProfile(
        factors={"08:00": 1.5, "09:00": 0.5},
        omitted_slots=[],
    )
    service._metadata = models.SolarBiasMetadata(
        trained_at="2026-04-25T03:00:00+02:00",
        training_config_fingerprint=service_mod.compute_fingerprint(_make_cfg()),
        usable_days=12,
        dropped_days=[],
        factor_min=0.5,
        factor_max=1.5,
        factor_median=1.0,
        omitted_slot_count=0,
        last_outcome="profile_trained",
        invalidated_slots_by_date={"2026-04-24": ["08:00"]},
        invalidated_slot_count=1,
        error_reason=None,
    )

    async def fake_forecast_points(*args, **kwargs):
        return [
            {"timestamp": "2026-04-24T08:00:00+02:00", "value": 100.0},
            {"timestamp": "2026-04-24T09:00:00+02:00", "value": 200.0},
        ]

    async def fake_actuals(*args, **kwargs):
        return {"07:45": 30.0, "08:00": 40.0}

    old_forecast = service_mod.load_forecast_points_for_day
    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_forecast_points_for_day = fake_forecast_points
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-24"))
    finally:
        service_mod.load_forecast_points_for_day = old_forecast
        service_mod.load_actuals_for_day = old_actuals
        service_mod.dt_util.now = old_now

    assert payload["series"]["actual"] == [
        {"timestamp": "2026-04-24T07:45:00+02:00", "valueWh": 30.0}
    ]
    assert payload["series"]["invalidated"] == [
        {"timestamp": "2026-04-24T08:00:00+02:00", "valueWh": 40.0}
    ]


def test_inspector_day_without_date_invalidations_keeps_invalidated_series_empty():
    service = _make_service()
    service._profile = models.SolarBiasProfile(
        factors={"08:00": 1.5, "09:00": 0.5},
        omitted_slots=[],
    )
    service._metadata = models.SolarBiasMetadata(
        trained_at="2026-04-25T03:00:00+02:00",
        training_config_fingerprint=service_mod.compute_fingerprint(_make_cfg()),
        usable_days=12,
        dropped_days=[],
        factor_min=0.5,
        factor_max=1.5,
        factor_median=1.0,
        omitted_slot_count=0,
        last_outcome="profile_trained",
        invalidated_slots_by_date={"2026-04-24": ["08:00"]},
        invalidated_slot_count=1,
        error_reason=None,
    )

    async def fake_forecast_points(*args, **kwargs):
        return [
            {"timestamp": "2026-04-25T08:00:00+02:00", "value": 100.0},
            {"timestamp": "2026-04-25T09:00:00+02:00", "value": 200.0},
        ]

    async def fake_actuals(*args, **kwargs):
        return {"08:00": 40.0, "08:15": 50.0, "09:00": 60.0}

    old_forecast = service_mod.load_forecast_points_for_day
    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_forecast_points_for_day = fake_forecast_points
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-25"))
    finally:
        service_mod.load_forecast_points_for_day = old_forecast
        service_mod.load_actuals_for_day = old_actuals
        service_mod.dt_util.now = old_now

    assert payload["series"]["actual"] == [
        {"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 40.0},
        {"timestamp": "2026-04-25T08:15:00+02:00", "valueWh": 50.0},
        {"timestamp": "2026-04-25T09:00:00+02:00", "valueWh": 60.0},
    ]
    assert payload["series"]["invalidated"] == []
    assert payload["availability"]["hasInvalidated"] is False


def test_inspector_day_does_not_show_invalidated_series_for_today_or_future():
    service = _make_service()
    service._profile = models.SolarBiasProfile(
        factors={"08:00": 1.5, "09:00": 0.5},
        omitted_slots=[],
    )
    service._metadata = models.SolarBiasMetadata(
        trained_at="2026-04-25T03:00:00+02:00",
        training_config_fingerprint=service_mod.compute_fingerprint(_make_cfg()),
        usable_days=12,
        dropped_days=[],
        factor_min=0.5,
        factor_max=1.5,
        factor_median=1.0,
        omitted_slot_count=0,
        last_outcome="profile_trained",
        invalidated_slots_by_date={
            "2026-04-25": ["08:00"],
            "2026-04-26": ["08:00"],
        },
        invalidated_slot_count=2,
        error_reason=None,
    )

    async def fake_forecast_points(*args, **kwargs):
        target_date = args[2]
        return [
            {"timestamp": f"{target_date.isoformat()}T08:00:00+02:00", "value": 100.0},
            {"timestamp": f"{target_date.isoformat()}T09:00:00+02:00", "value": 200.0},
        ]

    async def fake_actuals(*args, **kwargs):
        return {"08:00": 40.0, "08:15": 50.0, "09:00": 60.0}

    old_forecast = service_mod.load_forecast_points_for_day
    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_forecast_points_for_day = fake_forecast_points
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")

        today_payload = asyncio.run(service.async_get_inspector_day("2026-04-25"))
        future_payload = asyncio.run(service.async_get_inspector_day("2026-04-26"))
    finally:
        service_mod.load_forecast_points_for_day = old_forecast
        service_mod.load_actuals_for_day = old_actuals
        service_mod.dt_util.now = old_now

    assert today_payload["series"]["invalidated"] == []
    assert today_payload["availability"]["hasInvalidated"] is False
    assert today_payload["series"]["actual"] == [
        {"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 40.0},
        {"timestamp": "2026-04-25T08:15:00+02:00", "valueWh": 50.0},
        {"timestamp": "2026-04-25T09:00:00+02:00", "valueWh": 60.0},
    ]
    assert future_payload["series"]["actual"] == []
    assert future_payload["series"]["invalidated"] == []
    assert future_payload["availability"]["hasInvalidated"] is False
