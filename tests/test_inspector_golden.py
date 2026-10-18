import importlib
import json
import unittest
from datetime import date, datetime, time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo

from _fakes import (
    DummyStore,
    FakeConnection,
    FakeInspectorLiveSources,
    _bias_service_config,
)

from custom_components.helman.const import DOMAIN
from custom_components.helman.solar_bias_correction import models
from custom_components.helman.solar_bias_correction.websocket import (
    ws_get_solar_bias_day_aggregates,
    ws_get_solar_bias_inspector,
)
from custom_components.helman.solar_inspector import service as service_mod

recorder_series_mod = importlib.import_module("custom_components.helman.recorder_slot_energy")
span_mod = importlib.import_module("custom_components.helman.recorder_statistics_span")
span_test = importlib.import_module("test_inspector_span_aggregates")

PRAGUE = ZoneInfo("Europe/Prague")
NOW = datetime(2026, 4, 25, 10, 0, tzinfo=PRAGUE)
GOLDEN_DAY_PATH = Path(__file__).parent / "fixtures" / "inspector_day_golden.json"
GOLDEN_SPAN_PATH = Path(__file__).parent / "fixtures" / "inspector_span_golden.json"


class InspectorGoldenTests(unittest.IsolatedAsyncioTestCase):
    async def test_ws_inspector_day_golden(self) -> None:
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
            {"timestamp": "2026-04-25T08:00:00+02:00", "value": 37.5},
            {"timestamp": "2026-04-25T08:15:00+02:00", "value": 25.0},
            {"timestamp": "2026-04-25T08:30:00+02:00", "value": 25.0},
            {"timestamp": "2026-04-25T08:45:00+02:00", "value": 25.0},
            {"timestamp": "2026-04-25T09:00:00+02:00", "value": 25.0},
            {"timestamp": "2026-04-25T09:15:00+02:00", "value": 50.0},
            {"timestamp": "2026-04-25T09:30:00+02:00", "value": 50.0},
            {"timestamp": "2026-04-25T09:45:00+02:00", "value": 50.0},
        ]

        async def _canonical_provider(*, reference_time):
            return {"rawPoints": raw_15min, "correctedPoints": corrected_15min}

        async def _executor_job(func, *args):
            return func(*args)

        cfg = models.BiasConfig(
            enabled=True,
            min_history_days=2,
            training_time="03:00",
            clamp_min=0.3,
            clamp_max=2.0,
            aggregation_method="ratio_of_sums",
            daily_energy_entity_ids=["sensor.solar_today"],
            total_energy_entity_id="sensor.solar_total",
        )

        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague"),
            bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None),
            async_add_executor_job=_executor_job,
            data={},
            states=SimpleNamespace(get=lambda entity_id: None),
        )

        old_load_archived = getattr(service_mod, "load_archived_forecast_points", None)

        async def _fake_archived(h, d, tz):
            return raw_15min

        service_mod.load_archived_forecast_points = _fake_archived

        try:
            service = service_mod.SolarInspector(
                hass,
                DummyStore(),
                cfg,
                live_sources=FakeInspectorLiveSources(
                    canonical_solar_forecast=_canonical_provider,
                ),
                config=_bias_service_config(cfg),
            )
            service._profile = models.SolarBiasProfile(
                factors={"08:00": 1.5, "09:00": 0.5},
                omitted_slots=[],
            )
            service._metadata = models.SolarBiasMetadata(
                trained_at="2026-04-25T03:00:00+02:00",
                training_config_fingerprint="fp",
                usable_days=12,
                dropped_days=[],
                factor_min=0.5,
                factor_max=1.5,
                factor_median=1.0,
                omitted_slot_count=0,
                last_outcome="profile_trained",
                error_reason=None,
            )
            service._async_probe_history_floor = AsyncMock(return_value=date(2026, 4, 1))

            target_d = date.fromisoformat("2026-04-25")
            service._load_slot_energy_kwh_for_entities = AsyncMock(
                return_value=recorder_series_mod.SlotEnergyBatch(
                    by_entity={
                        "sensor.solar_total": {
                            datetime.combine(target_d, time(8, 0), tzinfo=PRAGUE): 0.09,
                        }
                    },
                    liveness_instants=[],
                )
            )

            coordinator = SimpleNamespace(solar_inspector=service)
            hass.data[DOMAIN] = {"coordinator": coordinator}
            conn = FakeConnection()

            old_now = service_mod.dt_util.now
            service_mod.dt_util.now = lambda: NOW
            try:
                with patch(
                    "custom_components.helman.solar_bias_correction.house_forecast_history.load_house_forecast_points_for_day",
                    AsyncMock(return_value=[]),
                ), patch(
                    "custom_components.helman.solar_bias_correction.battery_forecast_history.load_battery_forecast_points_for_day",
                    AsyncMock(return_value=[]),
                ):
                    await ws_get_solar_bias_inspector.__wrapped__(
                        hass,
                        conn,
                        {"id": 1, "type": "helman/solar_bias/inspector", "date": "2026-04-25"},
                    )
            finally:
                service_mod.dt_util.now = old_now

            self.assertEqual(conn.errors, [])
            self.assertEqual(len(conn.results), 1)
            expected = json.loads(GOLDEN_DAY_PATH.read_text())
            self.assertEqual(conn.results[0][1], expected)
        finally:
            if old_load_archived is not None:
                service_mod.load_archived_forecast_points = old_load_archived

    async def test_ws_inspector_day_aggregates_golden(self) -> None:
        span_test._set_rows(
            {
                span_test.SOLAR_METER: [
                    span_test._row(span_test._hour("2026-04-22T23:00:00+02:00"), state=99.0),
                    span_test._row(span_test._hour("2026-04-23T08:00:00+02:00"), state=100.5),
                    span_test._row(span_test._hour("2026-04-23T09:00:00+02:00"), state=103.0),
                    span_test._row(span_test._hour("2026-04-24T10:00:00+02:00"), state=106.0),
                ],
                span_test.GRID_IMPORT_METER: [
                    span_test._row(span_test._hour("2026-04-23T19:00:00+02:00"), state=48.75),
                    span_test._row(span_test._hour("2026-04-23T20:00:00+02:00"), state=50.0),
                ],
                span_test.GRID_EXPORT_METER: [
                    span_test._row(span_test._hour("2026-04-24T11:00:00+02:00"), state=7.25),
                    span_test._row(span_test._hour("2026-04-24T12:00:00+02:00"), state=8.0),
                ],
                span_test.HOUSE_METER: [
                    span_test._row(span_test._hour("2026-04-23T06:00:00+02:00"), state=68.0),
                    span_test._row(span_test._hour("2026-04-23T07:00:00+02:00"), state=70.0),
                ],
                span_test.BATTERY_CHARGE_METER: [
                    span_test._row(span_test._hour("2026-04-23T12:00:00+02:00"), state=36.0),
                    span_test._row(span_test._hour("2026-04-23T13:00:00+02:00"), state=40.0),
                ],
                span_test.BATTERY_DISCHARGE_METER: [
                    span_test._row(span_test._hour("2026-04-24T18:00:00+02:00"), state=11.0),
                    span_test._row(span_test._hour("2026-04-24T19:00:00+02:00"), state=12.0),
                ],
                span_test.BATTERY_SOC: [
                    span_test._row(span_test._hour("2026-04-23T06:00:00+02:00"), min=41.0, max=60.0),
                    span_test._row(span_test._hour("2026-04-23T14:00:00+02:00"), min=55.0, max=88.0),
                    span_test._row(span_test._hour("2026-04-24T05:00:00+02:00"), min=30.0, max=30.0),
                ],
            }
        )
        service = span_test._make_service()
        service._async_probe_history_floor = AsyncMock(return_value=date(2026, 4, 1))

        with patch.object(
            span_mod, "query_oldest_statistics_date", AsyncMock(return_value=date(2026, 4, 1))
        ), patch.object(
            span_mod, "get_instance", lambda hass: span_test.RECORDER_STUB
        ), patch.object(
            span_mod, "statistics_during_period", span_test._fake_statistics_during_period
        ):
            hass = service._hass
            coordinator = SimpleNamespace(solar_inspector=service)
            hass.data[DOMAIN] = {"coordinator": coordinator}
            conn = FakeConnection()

            await ws_get_solar_bias_day_aggregates.__wrapped__(
                hass,
                conn,
                {
                    "id": 1,
                    "type": "helman/solar_bias/day_aggregates",
                    "start_date": "2026-04-23",
                    "end_date": "2026-04-24",
                    "bucket": "day",
                },
            )

            self.assertEqual(conn.errors, [])
            self.assertEqual(len(conn.results), 1)
            expected = json.loads(GOLDEN_SPAN_PATH.read_text())
            self.assertEqual(conn.results[0][1], expected)
