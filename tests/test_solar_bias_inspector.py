from __future__ import annotations

import asyncio
import importlib

import pytest
import sys
import types
from datetime import date, datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo
from unittest.mock import patch, AsyncMock

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
        "dataGranularityMinutes": 15,
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
            "impact": [],
            "houseForecast": [],
            "houseActual": [],
            "houseActualBreakdown": [],
            "houseForecastBreakdown": [],
            "batterySocForecast": [],
            "batterySocActual": [],
            "gridForecast": [],
            "gridActual": [],
            "batteryForecast": [],
            "batteryActual": [],
            "importPrice": [],
            "exportPrice": [],
            "moneyActual": [],
            "moneyForecast": [],
        },
        "totals": {
            "rawWh": 420.0,
            "correctedWh": 510.0,
            "actualWh": 480.0,
            "houseForecastWh": None,
            "houseActualWh": None,
            "gridForecastWh": None,
            "gridActualWh": None,
            "batteryForecastWh": None,
            "batteryActualWh": None,
            "moneyActual": None,
            "moneyForecast": None,
        },
        "availability": {
            "hasRawForecast": True,
            "hasCorrectedForecast": True,
            "hasActuals": True,
            "hasProfile": True,
            "hasInvalidated": False,
            "hasHouseForecast": False,
            "hasHouseActual": False,
            "hasHouseActualBreakdown": False,
            "hasHouseForecastBreakdown": False,
            "hasBatterySocForecast": False,
            "hasBatterySocActual": False,
            "hasGridForecast": False,
            "hasGridActual": False,
            "hasBatteryForecast": False,
            "hasBatteryActual": False,
            "hasImportPrice": False,
            "hasExportPrice": False,
        },
        "houseUnmeasuredLabel": None,
        "priceUnit": None,
        "batterySocBounds": [],
        "trainingExplainability": None,
    }


def test_inspector_day_serializes_battery_soc_bounds():
    payload = models.inspector_day_to_payload(
        models.SolarBiasInspectorDay(
            date="2026-04-25",
            timezone="Europe/Prague",
            status="applied",
            effective_variant="adjusted",
            trained_at=None,
            min_date="2026-04-18",
            max_date="2026-04-27",
            series=models.SolarBiasInspectorSeries(
                raw=[], corrected=[], actual=[], factors=[]
            ),
            totals=models.SolarBiasInspectorTotals(
                raw_wh=None, corrected_wh=None, actual_wh=None
            ),
            availability=models.SolarBiasInspectorAvailability(
                has_raw_forecast=False,
                has_corrected_forecast=False,
                has_actuals=False,
                has_profile=True,
            ),
            is_today=True,
            is_future=False,
            battery_soc_bounds=[
                models.BatterySocBoundsPoint(slot="00:00", min_pct=15.0, max_pct=90.0),
                models.BatterySocBoundsPoint(slot="00:15", min_pct=20.0, max_pct=None),
            ],
        )
    )

    assert payload["batterySocBounds"] == [
        {"slot": "00:00", "minPct": 15.0, "maxPct": 90.0},
        {"slot": "00:15", "minPct": 20.0, "maxPct": None},
    ]


def test_inspector_day_serializes_impact_and_training_explainability():
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
                raw=[],
                corrected=[],
                actual=[],
                factors=[models.SolarBiasFactorPoint(slot="12:00", factor=1.34)],
                impact=[
                    models.SolarBiasImpactPoint(
                        slot="12:00",
                        raw_wh=840.0,
                        corrected_wh=1120.0,
                        impact_wh=280.0,
                        factor=1.34,
                    )
                ],
            ),
            totals=models.SolarBiasInspectorTotals(
                raw_wh=None,
                corrected_wh=None,
                actual_wh=None,
            ),
            availability=models.SolarBiasInspectorAvailability(
                has_raw_forecast=False,
                has_corrected_forecast=False,
                has_actuals=False,
                has_profile=True,
            ),
            is_today=True,
            is_future=False,
            training_explainability=models.SolarBiasTrainingExplainability(
                trained_at="2026-04-25T03:00:04+02:00",
                aggregation_method="ratio_of_sums",
                slots={
                    "12:00": models.SolarBiasSlotExplainability(
                        factor=1.34,
                        raw_ratio=1.34,
                        clamped=False,
                        forecast_sum_wh=1500.0,
                        actual_sum_wh=2010.0,
                        rows=[
                            models.SolarBiasContributionRow(
                                date="2026-04-21",
                                forecast_wh=520.0,
                                actual_wh=610.0,
                                ratio=1.1730769231,
                                status="included",
                                reason=None,
                            )
                        ],
                    )
                },
            ),
        )
    )

    assert payload["series"]["impact"] == [
        {
            "slot": "12:00",
            "rawWh": 840.0,
            "correctedWh": 1120.0,
            "impactWh": 280.0,
            "factor": 1.34,
        }
    ]
    assert payload["trainingExplainability"] == {
        "trainedAt": "2026-04-25T03:00:04+02:00",
        "aggregationMethod": "ratio_of_sums",
        "slots": {
            "12:00": {
                "factor": 1.34,
                "rawRatio": 1.34,
                "clamped": False,
                "forecastSumWh": 1500.0,
                "actualSumWh": 2010.0,
                "interpolated": False,
                "interpolationAnchors": None,
                "rows": [
                    {
                        "date": "2026-04-21",
                        "forecastWh": 520.0,
                        "actualWh": 610.0,
                        "ratio": 1.1730769231,
                        "status": "included",
                        "reason": None,
                    }
                ],
            }
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
        aggregation_method="ratio_of_sums",
        daily_energy_entity_ids=["sensor.solar_today", "sensor.solar_tomorrow"],
        total_energy_entity_id="sensor.solar_total",
    )


def test_load_archived_forecast_points_reads_the_whole_archived_day():
    """The day is drawn from what the trainer was fitted to, not the entity."""

    class _FakeStore:
        def slots_for_day(self, target_date):
            assert str(target_date) == "2026-04-24"
            return {"06:00": 25.0, "06:45": 25.0, "07:00": 50.0}

    result = forecast_history.load_archived_forecast_points(
        _FakeStore(),
        date.fromisoformat("2026-04-24"),
        ZoneInfo("Europe/Prague"),
    )

    assert result == [
        {"timestamp": "2026-04-24T06:00:00+02:00", "value": 25.0},
        {"timestamp": "2026-04-24T06:45:00+02:00", "value": 25.0},
        {"timestamp": "2026-04-24T07:00:00+02:00", "value": 50.0},
    ]


def test_load_archived_forecast_points_without_a_store_is_empty():
    result = forecast_history.load_archived_forecast_points(
        None,
        date.fromisoformat("2026-04-24"),
        ZoneInfo("Europe/Prague"),
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


service_mod = importlib.import_module("custom_components.helman.solar_bias_correction.service")


class _DummyStore:
    profile = None

    async def async_save(self, payload):
        self.saved = payload


class _ArchiveStore:
    """The forecast archive, keyed the way `SolarForecastHistoryStore` keys it."""

    def __init__(self, points_by_date: dict[str, list[dict]]) -> None:
        self._days = {
            day: {
                datetime.fromisoformat(point["timestamp"]).strftime("%H:%M"): float(
                    point["value"]
                )
                for point in points
            }
            for day, points in points_by_date.items()
        }

    def slots_for_day(self, target_date):
        return dict(self._days.get(str(target_date), {}))


def _archive_of(points: list[dict]) -> _ArchiveStore:
    """An archive holding exactly these points, on the day they fall on.

    Today's elapsed slots come from the archive now, so a test about today has
    to have been running before those slots elapsed -- which in production is
    the ordinary case, the rebuild having archived each slot at its boundary.
    """
    by_date: dict[str, list[dict]] = {}
    for point in points:
        day = datetime.fromisoformat(point["timestamp"]).date().isoformat()
        by_date.setdefault(day, []).append(point)
    return _ArchiveStore(by_date)


def _make_service(canonical_provider=None, archive=None):
    hass = SimpleNamespace(
        config=SimpleNamespace(time_zone="Europe/Prague"),
        bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None),
    )
    return service_mod.SolarBiasCorrectionService(
        hass,
        _DummyStore(),
        _make_cfg(),
        canonical_solar_forecast_provider=canonical_provider,
        solar_forecast_history=archive,
    )


def _canonical_provider(raw_points, corrected_points=None):
    async def provider(*, reference_time):
        return {
            "rawPoints": raw_points,
            "correctedPoints": corrected_points or [],
        }

    return provider


def test_inspector_day_applies_current_profile_and_totals():
    raw_15min = [
        {"timestamp": "2026-04-25T08:00:00+02:00", "value": 25.0},
        {"timestamp": "2026-04-25T08:15:00+02:00", "value": 25.0},
        {"timestamp": "2026-04-25T08:30:00+02:00", "value": 25.0},
        {"timestamp": "2026-04-25T08:45:00+02:00", "value": 25.0},
        {"timestamp": "2026-04-25T09:00:00+02:00", "value": 50.0},
        {"timestamp": "2026-04-25T09:15:00+02:00", "value": 50.0},
        {"timestamp": "2026-04-25T09:30:00+02:00", "value": 50.0},
        {"timestamp": "2026-04-25T09:45:00+02:00", "value": 50.0},
    ]
    corrected_15min = [
        {"timestamp": "2026-04-25T08:00:00+02:00", "value": 31.25},
        {"timestamp": "2026-04-25T08:15:00+02:00", "value": 31.25},
        {"timestamp": "2026-04-25T08:30:00+02:00", "value": 31.25},
        {"timestamp": "2026-04-25T08:45:00+02:00", "value": 31.25},
        {"timestamp": "2026-04-25T09:00:00+02:00", "value": 43.75},
        {"timestamp": "2026-04-25T09:15:00+02:00", "value": 43.75},
        {"timestamp": "2026-04-25T09:30:00+02:00", "value": 43.75},
        {"timestamp": "2026-04-25T09:45:00+02:00", "value": 43.75},
    ]
    service = _make_service(
        _canonical_provider(raw_15min, corrected_15min), _archive_of(raw_15min)
    )
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

    async def fake_actuals(*args, **kwargs):
        return {"08:00": 90.0}

    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-25"))
    finally:
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
        "hasHouseForecast": False,
        "hasHouseActual": False,
        "hasHouseActualBreakdown": False,
        "hasHouseForecastBreakdown": False,
        "hasBatterySocForecast": False,
        "hasBatterySocActual": False,
        "hasGridForecast": False,
        "hasGridActual": False,
        "hasBatteryForecast": False,
        "hasBatteryActual": False,
        "hasImportPrice": False,
        "hasExportPrice": False,
    }
    assert payload["series"]["raw"] == [
        {"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 25.0},
        {"timestamp": "2026-04-25T08:15:00+02:00", "valueWh": 25.0},
        {"timestamp": "2026-04-25T08:30:00+02:00", "valueWh": 25.0},
        {"timestamp": "2026-04-25T08:45:00+02:00", "valueWh": 25.0},
        {"timestamp": "2026-04-25T09:00:00+02:00", "valueWh": 50.0},
        {"timestamp": "2026-04-25T09:15:00+02:00", "valueWh": 50.0},
        {"timestamp": "2026-04-25T09:30:00+02:00", "valueWh": 50.0},
        {"timestamp": "2026-04-25T09:45:00+02:00", "valueWh": 50.0},
    ]
    # Every slot here has elapsed, so the whole curve comes from the archive and
    # is corrected by applying the current profile -- exactly as the same day
    # will be drawn tomorrow. The snapshot's own correctedPoints cover only the
    # slots the clock has not reached, of which this day has none.
    assert payload["series"]["corrected"] == [
        {"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 37.5},
        {"timestamp": "2026-04-25T08:15:00+02:00", "valueWh": 25.0},
        {"timestamp": "2026-04-25T08:30:00+02:00", "valueWh": 25.0},
        {"timestamp": "2026-04-25T08:45:00+02:00", "valueWh": 25.0},
        {"timestamp": "2026-04-25T09:00:00+02:00", "valueWh": 25.0},
        {"timestamp": "2026-04-25T09:15:00+02:00", "valueWh": 50.0},
        {"timestamp": "2026-04-25T09:30:00+02:00", "valueWh": 50.0},
        {"timestamp": "2026-04-25T09:45:00+02:00", "valueWh": 50.0},
    ]
    assert payload["series"]["actual"] == [
        {"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 90.0}
    ]
    assert payload["series"]["factors"] == [
        {"slot": "08:00", "factor": 1.5},
        {"slot": "09:00", "factor": 0.5},
    ]
    assert payload["totals"] == {
        "rawWh": 300.0,
        "correctedWh": 287.5,
        "actualWh": 90.0,
        "houseForecastWh": None,
        "houseActualWh": None,
        "gridForecastWh": None,
        "gridActualWh": None,
        "batteryForecastWh": None,
        "batteryActualWh": None,
        "moneyActual": None,
        "moneyForecast": None,
    }
    assert payload["range"]["minDate"] == "2026-04-13"
    assert payload["range"]["isToday"] is True


def test_inspector_day_today_preserves_15min_granularity():
    """Today/future inspector must surface raw/corrected/impact at 15-min, matching factors and trainingExplainability."""
    raw_15min = [
        {"timestamp": "2026-04-25T16:00:00+02:00", "value": 600.0},
        {"timestamp": "2026-04-25T16:15:00+02:00", "value": 600.0},
        {"timestamp": "2026-04-25T16:30:00+02:00", "value": 600.0},
        {"timestamp": "2026-04-25T16:45:00+02:00", "value": 600.0},
    ]
    corrected_15min = [
        {"timestamp": "2026-04-25T16:00:00+02:00", "value": 600.0},
        {"timestamp": "2026-04-25T16:15:00+02:00", "value": 600.0 * 0.8},
        {"timestamp": "2026-04-25T16:30:00+02:00", "value": 600.0 * 0.9},
        {"timestamp": "2026-04-25T16:45:00+02:00", "value": 600.0 * 1.0},
    ]
    service = _make_service(_canonical_provider(raw_15min, corrected_15min))
    service._profile = models.SolarBiasProfile(
        factors={"16:15": 0.8, "16:30": 0.9, "16:45": 1.0},
        omitted_slots=["16:00"],
    )
    service._metadata = models.SolarBiasMetadata(
        trained_at="2026-04-25T03:00:00+02:00",
        training_config_fingerprint=service_mod.compute_fingerprint(_make_cfg()),
        usable_days=12,
        dropped_days=[],
        factor_min=0.8,
        factor_max=1.0,
        factor_median=0.9,
        omitted_slot_count=1,
        last_outcome="profile_trained",
        error_reason=None,
    )

    async def fake_actuals(*args, **kwargs):
        return {}

    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-25"))
    finally:
        service_mod.load_actuals_for_day = old_actuals
        service_mod.dt_util.now = old_now

    assert payload["series"]["raw"] == [
        {"timestamp": "2026-04-25T16:00:00+02:00", "valueWh": 600.0},
        {"timestamp": "2026-04-25T16:15:00+02:00", "valueWh": 600.0},
        {"timestamp": "2026-04-25T16:30:00+02:00", "valueWh": 600.0},
        {"timestamp": "2026-04-25T16:45:00+02:00", "valueWh": 600.0},
    ]
    assert payload["series"]["corrected"] == [
        {"timestamp": "2026-04-25T16:00:00+02:00", "valueWh": 600.0},
        {"timestamp": "2026-04-25T16:15:00+02:00", "valueWh": 480.0},
        {"timestamp": "2026-04-25T16:30:00+02:00", "valueWh": 540.0},
        {"timestamp": "2026-04-25T16:45:00+02:00", "valueWh": 600.0},
    ]

    impact = payload["series"]["impact"]
    assert [entry["slot"] for entry in impact] == ["16:00", "16:15", "16:30", "16:45"]
    assert impact[0]["factor"] == pytest.approx(1.0)
    assert impact[1]["factor"] == pytest.approx(0.8)
    assert impact[2]["factor"] == pytest.approx(0.9)
    assert impact[3]["factor"] == pytest.approx(1.0)


def test_inspector_day_impact_factor_is_none_when_raw_is_zero():
    raw_15min = [
        {"timestamp": "2026-04-25T22:00:00+02:00", "value": 0.0},
        {"timestamp": "2026-04-25T22:15:00+02:00", "value": 0.0},
        {"timestamp": "2026-04-25T22:30:00+02:00", "value": 0.0},
        {"timestamp": "2026-04-25T22:45:00+02:00", "value": 0.0},
    ]
    corrected_15min = list(raw_15min)
    service = _make_service(_canonical_provider(raw_15min, corrected_15min))
    service._profile = models.SolarBiasProfile(factors={}, omitted_slots=[])
    service._metadata = models.SolarBiasMetadata(
        trained_at="2026-04-25T03:00:00+02:00",
        training_config_fingerprint=service_mod.compute_fingerprint(_make_cfg()),
        usable_days=12,
        dropped_days=[],
        factor_min=None,
        factor_max=None,
        factor_median=None,
        omitted_slot_count=0,
        last_outcome="profile_trained",
        error_reason=None,
    )

    async def fake_actuals(*args, **kwargs):
        return {}

    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-25"))
    finally:
        service_mod.load_actuals_for_day = old_actuals
        service_mod.dt_util.now = old_now

    impact = payload["series"]["impact"]
    assert len(impact) == 4
    for entry in impact:
        assert entry["rawWh"] == 0.0
        assert entry["factor"] is None


def test_inspector_day_uses_trained_usable_days_for_previous_range():
    service = _make_service()
    service._cfg.max_training_window_days = 20
    service._metadata = models.SolarBiasMetadata(
        trained_at="2026-04-25T03:00:00+02:00",
        training_config_fingerprint=service_mod.compute_fingerprint(service._cfg),
        usable_days=15,
        dropped_days=[],
        factor_min=None,
        factor_max=None,
        factor_median=None,
        omitted_slot_count=0,
        last_outcome="profile_trained",
        error_reason=None,
    )

    def fake_forecast_points(*args, **kwargs):
        return []

    async def fake_actuals(*args, **kwargs):
        return {}

    old_forecast = service_mod.load_archived_forecast_points
    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_archived_forecast_points = fake_forecast_points
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-25"))
    finally:
        service_mod.load_archived_forecast_points = old_forecast
        service_mod.load_actuals_for_day = old_actuals
        service_mod.dt_util.now = old_now

    assert payload["range"]["minDate"] == "2026-04-10"
    assert payload["range"]["canGoPrevious"] is True


def test_inspector_day_splices_today_at_the_current_slot():
    """Elapsed slots from the archive, the rest from the live snapshot.

    The source republishes the whole day and revises slots after they run, so
    the snapshot's 09:00 value is what it believes at 10:07, not what it said
    at 09:00. Drawing that beside the 09:00 actual compares a measurement with
    a forecast issued after it -- and the same bar would change height once the
    day became yesterday and the archive took over.
    """
    archived = [
        {"timestamp": "2026-04-25T09:00:00+02:00", "value": 100.0},
        {"timestamp": "2026-04-25T10:00:00+02:00", "value": 200.0},
    ]
    revised_snapshot = [
        # The same two slots, re-read after the fact, plus the day's remainder.
        {"timestamp": "2026-04-25T09:00:00+02:00", "value": 146.0},
        {"timestamp": "2026-04-25T10:00:00+02:00", "value": 250.0},
        {"timestamp": "2026-04-25T10:15:00+02:00", "value": 300.0},
        {"timestamp": "2026-04-25T11:00:00+02:00", "value": 400.0},
    ]
    service = _make_service(
        _canonical_provider(revised_snapshot), _archive_of(archived)
    )

    async def fake_actuals(*args, **kwargs):
        return {}

    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:07:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-25"))
    finally:
        service_mod.load_actuals_for_day = old_actuals
        service_mod.dt_util.now = old_now

    # 09:00 and 10:00 have started, so they keep their archived values; 10:15
    # onward has not, so it comes from the snapshot. No slot is repeated and
    # none is lost across the seam.
    assert payload["series"]["raw"] == [
        {"timestamp": "2026-04-25T09:00:00+02:00", "valueWh": 100.0},
        {"timestamp": "2026-04-25T10:00:00+02:00", "valueWh": 200.0},
        {"timestamp": "2026-04-25T10:15:00+02:00", "valueWh": 300.0},
        {"timestamp": "2026-04-25T11:00:00+02:00", "valueWh": 400.0},
    ]


def test_inspector_day_leaves_a_hole_where_today_was_never_archived():
    """Helman started at 10:00, so nothing earlier today was ever recorded.

    The snapshot still has those slots, but only as the provider re-reads them
    now. Drawing them would put a forecast issued after the fact beside the
    actual it is supposed to be judged against, and nothing on the chart would
    say which bars are honest. The gap is self-healing: it only ever covers the
    part of today that elapsed before Helman came up.
    """
    service = _make_service(
        _canonical_provider(
            [
                {"timestamp": "2026-04-25T08:00:00+02:00", "value": 146.0},
                {"timestamp": "2026-04-25T10:15:00+02:00", "value": 300.0},
            ]
        ),
        _archive_of([]),
    )

    async def fake_actuals(*args, **kwargs):
        return {}

    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:07:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-25"))
    finally:
        service_mod.load_actuals_for_day = old_actuals
        service_mod.dt_util.now = old_now

    assert payload["series"]["raw"] == [
        {"timestamp": "2026-04-25T10:15:00+02:00", "valueWh": 300.0}
    ]


def test_inspector_day_without_profile_keeps_corrected_equal_to_raw():
    points = [{"timestamp": "2026-04-25T08:00:00+02:00", "value": 100.0}]
    service = _make_service(_canonical_provider(points), _archive_of(points))

    async def fake_actuals(*args, **kwargs):
        return {}

    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-25"))
    finally:
        service_mod.load_actuals_for_day = old_actuals
        service_mod.dt_util.now = old_now

    assert payload["effectiveVariant"] == "raw"
    assert payload["availability"]["hasProfile"] is False
    assert payload["availability"]["hasCorrectedForecast"] is True
    assert payload["series"]["corrected"] == payload["series"]["raw"]
    assert payload["series"]["factors"] == []


def test_inspector_day_stale_profile_shows_factors_but_uses_raw_variant():
    service = _make_service(
        _canonical_provider(
            [{"timestamp": "2026-04-25T08:00:00+02:00", "value": 100.0}]
        )
    )
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

    async def fake_actuals(*args, **kwargs):
        return {}

    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-25"))
    finally:
        service_mod.load_actuals_for_day = old_actuals
        service_mod.dt_util.now = old_now

    assert payload["status"] == "config_changed_pending_retrain"
    assert payload["effectiveVariant"] == "raw"
    assert payload["availability"]["hasProfile"] is True
    assert payload["series"]["factors"] == [{"slot": "08:00", "factor": 2.0}]
    assert payload["series"]["corrected"] == payload["series"]["raw"]


def test_inspector_day_training_failed_preserved_profile_remains_adjusted():
    points = [{"timestamp": "2026-04-25T08:00:00+02:00", "value": 100.0}]
    service = _make_service(
        _canonical_provider(
            points,
            [{"timestamp": "2026-04-25T08:00:00+02:00", "value": 200.0}],
        ),
        _archive_of(points),
    )
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

    async def fake_actuals(*args, **kwargs):
        return {}

    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-25"))
    finally:
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
        invalidated_slots_by_date={"2026-04-24": ["08:00", "08:15"]},
        invalidated_slot_count=2,
        error_reason=None,
    )

    def fake_forecast_points(*args, **kwargs):
        return [
            {"timestamp": "2026-04-24T08:00:00+02:00", "value": 100.0},
            {"timestamp": "2026-04-24T09:00:00+02:00", "value": 200.0},
        ]

    async def fake_actuals(*args, **kwargs):
        return {"08:00": 40.0, "08:15": 50.0, "09:00": 60.0}

    old_forecast = service_mod.load_archived_forecast_points
    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_archived_forecast_points = fake_forecast_points
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-24"))
    finally:
        service_mod.load_archived_forecast_points = old_forecast
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

    def fake_forecast_points(*args, **kwargs):
        return [
            {"timestamp": "2026-04-24T08:00:00+02:00", "value": 100.0},
            {"timestamp": "2026-04-24T09:00:00+02:00", "value": 200.0},
        ]

    async def fake_actuals(*args, **kwargs):
        return {"07:45": 30.0, "08:00": 40.0}

    old_forecast = service_mod.load_archived_forecast_points
    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_archived_forecast_points = fake_forecast_points
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-24"))
    finally:
        service_mod.load_archived_forecast_points = old_forecast
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

    def fake_forecast_points(*args, **kwargs):
        return [
            {"timestamp": "2026-04-25T08:00:00+02:00", "value": 100.0},
            {"timestamp": "2026-04-25T09:00:00+02:00", "value": 200.0},
        ]

    async def fake_actuals(*args, **kwargs):
        return {"08:00": 40.0, "08:15": 50.0, "09:00": 60.0}

    old_forecast = service_mod.load_archived_forecast_points
    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_archived_forecast_points = fake_forecast_points
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-25"))
    finally:
        service_mod.load_archived_forecast_points = old_forecast
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

    def fake_forecast_points(*args, **kwargs):
        target_date = args[1]
        return [
            {"timestamp": f"{target_date.isoformat()}T08:00:00+02:00", "value": 100.0},
            {"timestamp": f"{target_date.isoformat()}T09:00:00+02:00", "value": 200.0},
        ]

    async def fake_actuals(*args, **kwargs):
        return {"08:00": 40.0, "08:15": 50.0, "09:00": 60.0}

    old_forecast = service_mod.load_archived_forecast_points
    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_archived_forecast_points = fake_forecast_points
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")

        today_payload = asyncio.run(service.async_get_inspector_day("2026-04-25"))
        future_payload = asyncio.run(service.async_get_inspector_day("2026-04-26"))
    finally:
        service_mod.load_archived_forecast_points = old_forecast
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


def test_inspector_day_returns_selected_day_impact_and_training_explainability():
    points = [
        {"timestamp": "2026-04-25T08:00:00+02:00", "value": 100.0},
        {"timestamp": "2026-04-25T09:00:00+02:00", "value": 200.0},
    ]
    service = _make_service(
        _canonical_provider(
            points,
            [
                {"timestamp": "2026-04-25T08:00:00+02:00", "value": 150.0},
                {"timestamp": "2026-04-25T09:00:00+02:00", "value": 100.0},
            ],
        ),
        _archive_of(points),
    )
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
    service._explainability = models.SolarBiasTrainingExplainability(
        trained_at="2026-04-25T03:00:00+02:00",
        aggregation_method="ratio_of_sums",
        slots={
            "08:00": models.SolarBiasSlotExplainability(
                factor=1.5,
                raw_ratio=1.5,
                clamped=False,
                forecast_sum_wh=100.0,
                actual_sum_wh=150.0,
                rows=[],
            )
        },
    )

    async def fake_actuals(*args, **kwargs):
        return {}

    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-25"))
    finally:
        service_mod.load_actuals_for_day = old_actuals
        service_mod.dt_util.now = old_now

    assert payload["series"]["impact"] == [
        {
            "slot": "08:00",
            "rawWh": 100.0,
            "correctedWh": 150.0,
            "impactWh": 50.0,
            "factor": 1.5,
        },
        {
            "slot": "09:00",
            "rawWh": 200.0,
            "correctedWh": 100.0,
            "impactWh": -100.0,
            "factor": 0.5,
        },
    ]
    assert payload["trainingExplainability"]["slots"]["08:00"]["factor"] == 1.5


def test_service_saves_training_explainability_after_training():
    service = _make_service()
    service._cfg.min_history_days = 1
    sample = models.TrainerSample(
        date="2026-04-24",
        forecast_wh=1000.0,
        slot_forecast_wh={"12:00": 1000.0},
    )

    def fake_samples(*args, **kwargs):
        return [sample]

    async def fake_actuals_window(*args, **kwargs):
        return models.SolarActualsWindow(
            slot_actuals_by_date={"2026-04-24": {"12:00": 1200.0}}
        )

    old_samples = service_mod.load_trainer_samples
    old_actuals_window = service_mod.load_actuals_window
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_trainer_samples = fake_samples
        service_mod.load_actuals_window = fake_actuals_window
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T03:00:00+02:00")
        asyncio.run(service.async_train())
    finally:
        service_mod.load_trainer_samples = old_samples
        service_mod.load_actuals_window = old_actuals_window
        service_mod.dt_util.now = old_now

    saved = service._store.saved
    assert saved["trainingExplainability"]["aggregationMethod"] == "ratio_of_sums"
    assert saved["trainingExplainability"]["slots"]["12:00"]["rows"][0]["status"] == "included"


def _install_fake_statistics_reader(reads, by_entity):
    """Stand in for the one statistics read the span aggregates make.

    Records every call so the test can assert what the span cost: the point of
    the endpoint is a single hourly-statistics read for the whole window, at any
    width, rather than a read per meter or per day.
    """
    import importlib

    span_mod = importlib.import_module(
        "custom_components.helman.recorder_statistics_span"
    )
    original = span_mod.query_hourly_statistics

    async def query_hourly_statistics(
        hass, statistic_ids, *, local_start, local_end, tail_start=None
    ):
        ids = [entity_id for entity_id in statistic_ids if entity_id]
        reads.append((ids, local_start, local_end, tail_start))
        rows = {entity_id: by_entity.get(entity_id, {}) for entity_id in ids}
        # The real derivation, not a second one: the rows above are meter
        # readings, and turning them into per-hour energy is exactly the step
        # that has to survive a compiler-invented reset.
        return span_mod.SpanStatistics(
            rows={
                entity_id: {
                    utc_hour: row
                    for utc_hour, row in entity_rows.items()
                    if local_start <= utc_hour < local_end
                }
                for entity_id, entity_rows in rows.items()
            },
            energy_kwh={
                entity_id: span_mod._hourly_energy_kwh(
                    entity_rows, local_start=local_start, local_end=local_end
                )
                for entity_id, entity_rows in rows.items()
            },
        )

    span_mod.query_hourly_statistics = query_hourly_statistics
    return span_mod, original


def _stat_rows(rows):
    """``{utc_hour: StatisticsRow}``, from ``(local ISO hour, fields)`` pairs."""
    return {
        datetime.fromisoformat(raw).astimezone(timezone.utc): fields
        for raw, fields in rows
    }


def test_day_aggregates_fold_hourly_statistics_into_local_days_in_one_read():
    service = _make_service()
    service._grid_import_energy_entity_id_provider = lambda: "sensor.grid_import"
    service._grid_export_energy_entity_id_provider = lambda: "sensor.grid_export"
    service._battery_soc_entity_id_provider = lambda: "sensor.battery_soc"

    reads: list[tuple] = []
    span_mod, original_query = _install_fake_statistics_reader(
        reads,
        {
            # Meter readings, not deltas: the hour's energy is the step between
            # two of them, which is what survives a compiler-invented reset.
            # Each series opens on the padded hour before the window.
            "sensor.solar_total": _stat_rows(
                [
                    ("2026-04-22T23:00:00+02:00", {"state": 99.0}),
                    ("2026-04-23T08:00:00+02:00", {"state": 100.5}),
                    ("2026-04-23T09:00:00+02:00", {"state": 103.0}),
                    ("2026-04-24T10:00:00+02:00", {"state": 106.0}),
                ]
            ),
            "sensor.grid_import": _stat_rows(
                [
                    ("2026-04-23T19:00:00+02:00", {"state": 48.75}),
                    ("2026-04-23T20:00:00+02:00", {"state": 50.0}),
                ]
            ),
            "sensor.grid_export": _stat_rows(
                [
                    ("2026-04-24T11:00:00+02:00", {"state": 7.25}),
                    ("2026-04-24T12:00:00+02:00", {"state": 8.0}),
                ]
            ),
            "sensor.battery_soc": _stat_rows(
                [
                    ("2026-04-23T06:00:00+02:00", {"min": 41.0, "max": 60.0}),
                    ("2026-04-23T14:00:00+02:00", {"min": 55.0, "max": 88.0}),
                    ("2026-04-24T05:00:00+02:00", {"min": 30.0, "max": 30.0}),
                ]
            ),
        },
    )

    old_now = service_mod.dt_util.now
    try:
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        payload = asyncio.run(
            service.async_get_span_aggregates("2026-04-23", "2026-04-24")
        )
    finally:
        service_mod.dt_util.now = old_now
        span_mod.query_hourly_statistics = original_query

    # One read for every meter and every day of the span.
    assert len(reads) == 1
    entity_ids, local_start, local_end, tail_start = reads[0]
    # The span stops well before today, so nothing is asked of the short-term
    # table: every hour in it is long since compiled.
    assert tail_start is None
    assert {
        "sensor.solar_total",
        "sensor.grid_import",
        "sensor.grid_export",
        "sensor.battery_soc",
    } <= set(entity_ids)
    assert local_start.date() == date.fromisoformat("2026-04-23")
    assert local_end.date() == date.fromisoformat("2026-04-25")

    # The day pills' four fields are unchanged, whatever else the span now
    # carries alongside them.
    assert [
        {
            key: day[key]
            for key in (
                "date",
                "solarWh",
                "gridImportKwh",
                "gridExportKwh",
                "batteryMinSocPct",
                "batteryMaxSocPct",
            )
        }
        for day in payload["days"]
    ] == [
        {
            "date": "2026-04-23",
            "solarWh": 4000.0,
            "gridImportKwh": 1.25,
            "gridExportKwh": None,
            "batteryMinSocPct": 41.0,
            "batteryMaxSocPct": 88.0,
        },
        {
            "date": "2026-04-24",
            "solarWh": 3000.0,
            "gridImportKwh": None,
            "gridExportKwh": 0.75,
            "batteryMinSocPct": 30.0,
            "batteryMaxSocPct": 30.0,
        },
    ]


def test_day_aggregates_stop_at_today_and_cap_the_span():
    service = _make_service()
    reads: list[tuple] = []
    span_mod, original_query = _install_fake_statistics_reader(reads, {})

    old_now = service_mod.dt_util.now
    try:
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        # A span reaching into the future is cut at today, and one reaching far
        # back keeps only the most recent buckets the cap allows.
        payload = asyncio.run(
            service.async_get_span_aggregates("2020-01-01", "2026-05-30")
        )
        future_only = asyncio.run(
            service.async_get_span_aggregates("2026-04-26", "2026-04-30")
        )
    finally:
        service_mod.dt_util.now = old_now
        span_mod.query_hourly_statistics = original_query

    days = [day["date"] for day in payload["days"]]
    assert len(days) == service_mod._MAX_AGGREGATE_BUCKETS["day"]
    assert days[-1] == "2026-04-25"
    assert future_only["days"] == []
