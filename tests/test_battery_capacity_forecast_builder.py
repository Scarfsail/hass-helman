from __future__ import annotations

import importlib
import sys
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
TZ = ZoneInfo("Europe/Prague")
UTC = timezone.utc
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
DST_REFERENCE_TIME = datetime.fromisoformat("2026-03-29T01:50:00+01:00")


def _install_import_stubs() -> None:
    custom_components_pkg = sys.modules.get("custom_components")
    if custom_components_pkg is None:
        custom_components_pkg = types.ModuleType("custom_components")
        sys.modules["custom_components"] = custom_components_pkg
    custom_components_pkg.__path__ = [str(ROOT / "custom_components")]

    helman_pkg = sys.modules.get("custom_components.helman")
    if helman_pkg is None:
        helman_pkg = types.ModuleType("custom_components.helman")
        sys.modules["custom_components.helman"] = helman_pkg
    helman_pkg.__path__ = [str(ROOT / "custom_components" / "helman")]

    homeassistant_pkg = sys.modules.get("homeassistant")
    if homeassistant_pkg is None:
        homeassistant_pkg = types.ModuleType("homeassistant")
        sys.modules["homeassistant"] = homeassistant_pkg

    core_mod = sys.modules.get("homeassistant.core")
    if core_mod is None:
        core_mod = types.ModuleType("homeassistant.core")
        sys.modules["homeassistant.core"] = core_mod
    if not hasattr(core_mod, "HomeAssistant"):
        core_mod.HomeAssistant = type("HomeAssistant", (), {})

    components_pkg = sys.modules.get("homeassistant.components")
    if components_pkg is None:
        components_pkg = types.ModuleType("homeassistant.components")
        sys.modules["homeassistant.components"] = components_pkg

    recorder_mod = sys.modules.get("homeassistant.components.recorder")
    if recorder_mod is None:
        recorder_mod = types.ModuleType("homeassistant.components.recorder")
        sys.modules["homeassistant.components.recorder"] = recorder_mod
    if not hasattr(recorder_mod, "get_instance"):
        recorder_mod.get_instance = lambda hass: None

    history_mod = sys.modules.get("homeassistant.components.recorder.history")
    if history_mod is None:
        history_mod = types.ModuleType("homeassistant.components.recorder.history")
        sys.modules["homeassistant.components.recorder.history"] = history_mod
    if not hasattr(history_mod, "state_changes_during_period"):
        history_mod.state_changes_during_period = lambda *args, **kwargs: {}

    util_pkg = sys.modules.get("homeassistant.util")
    if util_pkg is None:
        util_pkg = types.ModuleType("homeassistant.util")
        sys.modules["homeassistant.util"] = util_pkg

    dt_mod = sys.modules.get("homeassistant.util.dt")
    if dt_mod is None:
        dt_mod = types.ModuleType("homeassistant.util.dt")
        sys.modules["homeassistant.util.dt"] = dt_mod
    if not hasattr(dt_mod, "as_local"):
        dt_mod.as_local = lambda value: value
    if not hasattr(dt_mod, "as_utc"):
        dt_mod.as_utc = lambda value: value
    if not hasattr(dt_mod, "parse_datetime"):
        dt_mod.parse_datetime = datetime.fromisoformat
    if not hasattr(dt_mod, "now"):
        dt_mod.now = lambda: REFERENCE_TIME
    util_pkg.dt = dt_mod


class _FakeDtUtil:
    @staticmethod
    def as_local(value: datetime) -> datetime:
        if value.tzinfo == TZ:
            return value
        return value.astimezone(TZ)

    @staticmethod
    def as_utc(value: datetime) -> datetime:
        if value.tzinfo == UTC:
            return value
        return value.astimezone(UTC)

    @staticmethod
    def parse_datetime(value: str) -> datetime:
        return datetime.fromisoformat(value)

    @staticmethod
    def now() -> datetime:
        return REFERENCE_TIME


def _make_house_forecast(
    *,
    current_slot_start: datetime,
    current_slot_value: float,
    future_values: list[float],
) -> dict:
    current_slot = {
        "timestamp": current_slot_start.isoformat(),
        "nonDeferrable": {"value": current_slot_value},
    }
    series = []
    next_slot_utc = _FakeDtUtil.as_utc(current_slot_start)
    for index, value in enumerate(future_values, start=1):
        slot_start = _FakeDtUtil.as_local(
            next_slot_utc + battery_capacity_forecast_builder._CANONICAL_SLOT_DURATION * index
        )
        series.append(
            {
                "timestamp": slot_start.isoformat(),
                "nonDeferrable": {"value": value},
            }
        )
    return {
        "status": "available",
        "currentSlot": current_slot,
        "series": series,
    }


def _make_solar_forecast(points: dict[datetime, float]) -> dict:
    return {
        "status": "available",
        "points": [
            {
                "timestamp": timestamp.isoformat(),
                "value": value,
            }
            for timestamp, value in points.items()
        ],
    }


class _FakeScheduleOverlay:
    def __init__(
        self,
        *,
        horizon_end: datetime,
        actions_by_slot: dict[datetime, SimpleNamespace] | None = None,
    ) -> None:
        self.horizon_end = horizon_end
        self._actions_by_slot = {} if actions_by_slot is None else dict(actions_by_slot)

    def lookup_action(self, slot_start: datetime) -> SimpleNamespace:
        return self._actions_by_slot.get(
            slot_start,
            SimpleNamespace(kind="normal", target_soc=None),
        )


_install_import_stubs()
from custom_components.helman import (  # noqa: E402
    battery_capacity_forecast_builder,
    battery_forecast_response,
    recorder_hourly_series,
)


class BatteryCapacityForecastBuilderTests(unittest.IsolatedAsyncioTestCase):
    def _make_builder(self):
        recorder_module = importlib.reload(
            importlib.import_module("custom_components.helman.recorder_hourly_series")
        )
        module = importlib.reload(
            importlib.import_module(
                "custom_components.helman.battery_capacity_forecast_builder"
            )
        )
        module.dt_util = _FakeDtUtil
        recorder_module.dt_util = _FakeDtUtil
        hass = SimpleNamespace(states=SimpleNamespace(get=lambda entity_id: None))
        return module, module.BatteryCapacityForecastBuilder(hass, {})

    async def test_build_is_canonical_quarter_hour_and_uses_slot_values(self) -> None:
        module, builder = self._make_builder()
        house_forecast = _make_house_forecast(
            current_slot_start=datetime(2026, 3, 20, 21, 0, tzinfo=TZ),
            current_slot_value=0.3,
            future_values=[0.4, 0.5, 0.6, 0.7],
        )
        solar_forecast = _make_solar_forecast(
            {
                datetime(2026, 3, 20, 21, 0, tzinfo=TZ): 250.0,
                datetime(2026, 3, 20, 21, 15, tzinfo=TZ): 300.0,
                datetime(2026, 3, 20, 21, 30, tzinfo=TZ): 350.0,
                datetime(2026, 3, 20, 21, 45, tzinfo=TZ): 400.0,
            }
        )
        actual_history_mock = AsyncMock(return_value=[{"timestamp": "history"}])

        with (
            patch.object(
                module,
                "read_battery_entity_config",
                return_value=module.BatteryEntityConfig(
                    remaining_energy_entity_id="sensor.remaining",
                    capacity_entity_id="sensor.capacity",
                    min_soc_entity_id="sensor.min_soc",
                    max_soc_entity_id="sensor.max_soc",
                ),
            ),
            patch.object(
                module,
                "read_battery_forecast_settings",
                return_value=module.BatteryForecastSettings(
                    charge_efficiency=1.0,
                    discharge_efficiency=1.0,
                    max_charge_power_w=10000.0,
                    max_discharge_power_w=10000.0,
                ),
            ),
            patch.object(
                module,
                "read_battery_live_state",
                return_value=module.BatteryLiveState(
                    current_remaining_energy_kwh=5.0,
                    current_soc=50.0,
                    min_soc=0.0,
                    max_soc=100.0,
                    nominal_capacity_kwh=10.0,
                    min_energy_kwh=0.0,
                    max_energy_kwh=10.0,
                ),
            ),
            patch.object(module, "build_battery_actual_history", actual_history_mock),
            patch.object(module, "dt_util", _FakeDtUtil),
            patch.object(recorder_hourly_series, "dt_util", _FakeDtUtil),
        ):
            payload = await builder.build(
                solar_forecast=solar_forecast,
                house_forecast=house_forecast,
                started_at=REFERENCE_TIME,
            )

        self.assertEqual(payload["status"], "partial")
        self.assertEqual(payload["resolution"], "quarter_hour")
        self.assertEqual(payload["sourceGranularityMinutes"], 15)
        self.assertEqual(payload["actualHistory"], [{"timestamp": "history"}])
        self.assertEqual(payload["series"][0]["timestamp"], "2026-03-20T21:07:00+01:00")
        self.assertAlmostEqual(payload["series"][0]["durationHours"], 8 / 60, places=4)
        self.assertLessEqual(payload["series"][0]["durationHours"], 0.25)
        self.assertEqual(payload["series"][1]["timestamp"], "2026-03-20T21:15:00+01:00")
        self.assertEqual(payload["series"][1]["durationHours"], 0.25)
        self.assertAlmostEqual(payload["series"][0]["baselineHouseKwh"], 0.16, places=4)
        self.assertAlmostEqual(payload["series"][1]["baselineHouseKwh"], 0.4, places=4)
        self.assertAlmostEqual(payload["series"][0]["solarKwh"], 250.0 / 1000 * (8 / 15), places=4)
        self.assertAlmostEqual(payload["series"][1]["solarKwh"], 0.3, places=4)
        actual_history_mock.assert_awaited_once_with(
            builder._hass,
            "sensor.capacity",
            REFERENCE_TIME,
            interval_minutes=15,
        )

    async def test_partial_coverage_uses_existing_reason_and_coverage_until(self) -> None:
        module, builder = self._make_builder()
        house_forecast = _make_house_forecast(
            current_slot_start=datetime(2026, 3, 20, 21, 0, tzinfo=TZ),
            current_slot_value=0.1,
            future_values=[0.1, 0.1, 0.1],
        )
        solar_forecast = _make_solar_forecast(
            {
                datetime(2026, 3, 20, 21, 0, tzinfo=TZ): 100.0,
                datetime(2026, 3, 20, 21, 15, tzinfo=TZ): 100.0,
            }
        )

        with (
            patch.object(
                module,
                "read_battery_entity_config",
                return_value=module.BatteryEntityConfig(
                    remaining_energy_entity_id="sensor.remaining",
                    capacity_entity_id="sensor.capacity",
                    min_soc_entity_id="sensor.min_soc",
                    max_soc_entity_id="sensor.max_soc",
                ),
            ),
            patch.object(
                module,
                "read_battery_forecast_settings",
                return_value=module.BatteryForecastSettings(
                    charge_efficiency=1.0,
                    discharge_efficiency=1.0,
                    max_charge_power_w=10000.0,
                    max_discharge_power_w=10000.0,
                ),
            ),
            patch.object(
                module,
                "read_battery_live_state",
                return_value=module.BatteryLiveState(
                    current_remaining_energy_kwh=5.0,
                    current_soc=50.0,
                    min_soc=0.0,
                    max_soc=100.0,
                    nominal_capacity_kwh=10.0,
                    min_energy_kwh=0.0,
                    max_energy_kwh=10.0,
                ),
            ),
            patch.object(module, "build_battery_actual_history", AsyncMock(return_value=[])),
            patch.object(module, "dt_util", _FakeDtUtil),
            patch.object(recorder_hourly_series, "dt_util", _FakeDtUtil),
        ):
            payload = await builder.build(
                solar_forecast=solar_forecast,
                house_forecast=house_forecast,
                started_at=REFERENCE_TIME,
            )

        self.assertEqual(payload["status"], "partial")
        self.assertEqual(payload["partialReason"], "solar_forecast_ended")
        self.assertEqual(payload["coverageUntil"], "2026-03-20T21:30:00+01:00")

    async def test_build_splits_hourly_solar_points_into_quarter_hour_slots(self) -> None:
        module, builder = self._make_builder()
        house_forecast = _make_house_forecast(
            current_slot_start=datetime(2026, 3, 20, 21, 0, tzinfo=TZ),
            current_slot_value=0.0,
            future_values=[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        )
        solar_forecast = _make_solar_forecast(
            {
                datetime(2026, 3, 20, 21, 0, tzinfo=TZ): 400.0,
                datetime(2026, 3, 20, 22, 0, tzinfo=TZ): 800.0,
            }
        )

        with (
            patch.object(
                module,
                "read_battery_entity_config",
                return_value=module.BatteryEntityConfig(
                    remaining_energy_entity_id="sensor.remaining",
                    capacity_entity_id="sensor.capacity",
                    min_soc_entity_id="sensor.min_soc",
                    max_soc_entity_id="sensor.max_soc",
                ),
            ),
            patch.object(
                module,
                "read_battery_forecast_settings",
                return_value=module.BatteryForecastSettings(
                    charge_efficiency=1.0,
                    discharge_efficiency=1.0,
                    max_charge_power_w=10000.0,
                    max_discharge_power_w=10000.0,
                ),
            ),
            patch.object(
                module,
                "read_battery_live_state",
                return_value=module.BatteryLiveState(
                    current_remaining_energy_kwh=5.0,
                    current_soc=50.0,
                    min_soc=0.0,
                    max_soc=100.0,
                    nominal_capacity_kwh=10.0,
                    min_energy_kwh=0.0,
                    max_energy_kwh=10.0,
                ),
            ),
            patch.object(module, "build_battery_actual_history", AsyncMock(return_value=[])),
            patch.object(module, "dt_util", _FakeDtUtil),
            patch.object(recorder_hourly_series, "dt_util", _FakeDtUtil),
        ):
            payload = await builder.build(
                solar_forecast=solar_forecast,
                house_forecast=house_forecast,
                started_at=REFERENCE_TIME,
            )

        self.assertAlmostEqual(payload["series"][0]["solarKwh"], 0.1 * (8 / 15), places=4)
        self.assertAlmostEqual(payload["series"][1]["solarKwh"], 0.1, places=4)
        self.assertAlmostEqual(payload["series"][2]["solarKwh"], 0.1, places=4)
        self.assertAlmostEqual(payload["series"][3]["solarKwh"], 0.1, places=4)
        self.assertAlmostEqual(payload["series"][4]["solarKwh"], 0.2, places=4)

    async def test_build_uses_dst_safe_quarter_hour_stepping(self) -> None:
        module, builder = self._make_builder()
        house_forecast = _make_house_forecast(
            current_slot_start=datetime(2026, 3, 29, 1, 45, tzinfo=TZ),
            current_slot_value=0.1,
            future_values=[0.2, 0.3, 0.4],
        )
        solar_forecast = _make_solar_forecast(
            {
                datetime(2026, 3, 29, 1, 45, tzinfo=TZ): 100.0,
                datetime(2026, 3, 29, 3, 0, tzinfo=TZ): 100.0,
                datetime(2026, 3, 29, 3, 15, tzinfo=TZ): 100.0,
            }
        )

        with (
            patch.object(
                module,
                "read_battery_entity_config",
                return_value=module.BatteryEntityConfig(
                    remaining_energy_entity_id="sensor.remaining",
                    capacity_entity_id="sensor.capacity",
                    min_soc_entity_id="sensor.min_soc",
                    max_soc_entity_id="sensor.max_soc",
                ),
            ),
            patch.object(
                module,
                "read_battery_forecast_settings",
                return_value=module.BatteryForecastSettings(
                    charge_efficiency=1.0,
                    discharge_efficiency=1.0,
                    max_charge_power_w=10000.0,
                    max_discharge_power_w=10000.0,
                ),
            ),
            patch.object(
                module,
                "read_battery_live_state",
                return_value=module.BatteryLiveState(
                    current_remaining_energy_kwh=5.0,
                    current_soc=50.0,
                    min_soc=0.0,
                    max_soc=100.0,
                    nominal_capacity_kwh=10.0,
                    min_energy_kwh=0.0,
                    max_energy_kwh=10.0,
                ),
            ),
            patch.object(module, "build_battery_actual_history", AsyncMock(return_value=[])),
            patch.object(module, "dt_util", _FakeDtUtil),
            patch.object(recorder_hourly_series, "dt_util", _FakeDtUtil),
        ):
            payload = await builder.build(
                solar_forecast=solar_forecast,
                house_forecast=house_forecast,
                started_at=DST_REFERENCE_TIME,
            )

        timestamps = [entry["timestamp"] for entry in payload["series"]]
        self.assertEqual(timestamps[0], "2026-03-29T01:50:00+01:00")
        self.assertEqual(timestamps[1], "2026-03-29T03:00:00+02:00")
        self.assertTrue(all("T02:" not in timestamp for timestamp in timestamps))

    async def test_build_with_stop_charging_overlay_exposes_adjusted_primary_values(
        self,
    ) -> None:
        module, builder = self._make_builder()
        started_at = datetime(2026, 3, 20, 21, 0, tzinfo=TZ)
        house_forecast = _make_house_forecast(
            current_slot_start=started_at,
            current_slot_value=0.1,
            future_values=[0.0, 0.0],
        )
        solar_forecast = _make_solar_forecast(
            {
                started_at: 300.0,
                datetime(2026, 3, 20, 21, 15, tzinfo=TZ): 0.0,
            }
        )
        schedule_overlay = _FakeScheduleOverlay(
            horizon_end=datetime(2026, 3, 22, 21, 0, tzinfo=TZ),
            actions_by_slot={
                started_at: SimpleNamespace(kind="stop_charging", target_soc=None)
            },
        )

        with (
            patch.object(
                module,
                "read_battery_entity_config",
                return_value=module.BatteryEntityConfig(
                    remaining_energy_entity_id="sensor.remaining",
                    capacity_entity_id="sensor.capacity",
                    min_soc_entity_id="sensor.min_soc",
                    max_soc_entity_id="sensor.max_soc",
                ),
            ),
            patch.object(
                module,
                "read_battery_forecast_settings",
                return_value=module.BatteryForecastSettings(
                    charge_efficiency=1.0,
                    discharge_efficiency=1.0,
                    max_charge_power_w=10000.0,
                    max_discharge_power_w=10000.0,
                ),
            ),
            patch.object(
                module,
                "read_battery_live_state",
                return_value=module.BatteryLiveState(
                    current_remaining_energy_kwh=5.0,
                    current_soc=50.0,
                    min_soc=0.0,
                    max_soc=100.0,
                    nominal_capacity_kwh=10.0,
                    min_energy_kwh=0.0,
                    max_energy_kwh=10.0,
                ),
            ),
            patch.object(module, "build_battery_actual_history", AsyncMock(return_value=[])),
            patch.object(module, "dt_util", _FakeDtUtil),
            patch.object(recorder_hourly_series, "dt_util", _FakeDtUtil),
        ):
            payload = await builder.build(
                solar_forecast=solar_forecast,
                house_forecast=house_forecast,
                started_at=started_at,
                schedule_overlay=schedule_overlay,
            )

        self.assertTrue(payload["scheduleAdjusted"])
        self.assertEqual(
            payload["scheduleAdjustmentCoverageUntil"],
            "2026-03-20T21:30:00+01:00",
        )
        self.assertEqual(payload["series"][0]["chargedKwh"], 0.0)
        self.assertEqual(payload["series"][0]["remainingEnergyKwh"], 5.0)
        self.assertEqual(payload["series"][0]["socPct"], 50.0)
        self.assertEqual(payload["series"][0]["exportedToGridKwh"], 0.2)
        self.assertEqual(payload["series"][0]["baselineRemainingEnergyKwh"], 5.2)
        self.assertEqual(payload["series"][0]["baselineSocPct"], 52.0)

    async def test_build_with_normal_only_overlay_keeps_baseline_contract(self) -> None:
        module, builder = self._make_builder()
        started_at = datetime(2026, 3, 20, 21, 0, tzinfo=TZ)
        house_forecast = _make_house_forecast(
            current_slot_start=started_at,
            current_slot_value=0.1,
            future_values=[0.0, 0.0],
        )
        solar_forecast = _make_solar_forecast(
            {
                started_at: 300.0,
                datetime(2026, 3, 20, 21, 15, tzinfo=TZ): 0.0,
            }
        )
        schedule_overlay = _FakeScheduleOverlay(
            horizon_end=datetime(2026, 3, 22, 21, 0, tzinfo=TZ),
        )

        with (
            patch.object(
                module,
                "read_battery_entity_config",
                return_value=module.BatteryEntityConfig(
                    remaining_energy_entity_id="sensor.remaining",
                    capacity_entity_id="sensor.capacity",
                    min_soc_entity_id="sensor.min_soc",
                    max_soc_entity_id="sensor.max_soc",
                ),
            ),
            patch.object(
                module,
                "read_battery_forecast_settings",
                return_value=module.BatteryForecastSettings(
                    charge_efficiency=1.0,
                    discharge_efficiency=1.0,
                    max_charge_power_w=10000.0,
                    max_discharge_power_w=10000.0,
                ),
            ),
            patch.object(
                module,
                "read_battery_live_state",
                return_value=module.BatteryLiveState(
                    current_remaining_energy_kwh=5.0,
                    current_soc=50.0,
                    min_soc=0.0,
                    max_soc=100.0,
                    nominal_capacity_kwh=10.0,
                    min_energy_kwh=0.0,
                    max_energy_kwh=10.0,
                ),
            ),
            patch.object(module, "build_battery_actual_history", AsyncMock(return_value=[])),
            patch.object(module, "dt_util", _FakeDtUtil),
            patch.object(recorder_hourly_series, "dt_util", _FakeDtUtil),
        ):
            payload = await builder.build(
                solar_forecast=solar_forecast,
                house_forecast=house_forecast,
                started_at=started_at,
                schedule_overlay=schedule_overlay,
            )

        self.assertFalse(payload["scheduleAdjusted"])
        self.assertIsNone(payload["scheduleAdjustmentCoverageUntil"])
        self.assertEqual(payload["series"][0]["remainingEnergyKwh"], 5.2)
        self.assertNotIn("baselineRemainingEnergyKwh", payload["series"][0])
        self.assertNotIn("baselineSocPct", payload["series"][0])

    async def test_build_with_stop_discharging_overlay_blocks_discharge(self) -> None:
        module, builder = self._make_builder()
        started_at = datetime(2026, 3, 20, 21, 0, tzinfo=TZ)
        house_forecast = _make_house_forecast(
            current_slot_start=started_at,
            current_slot_value=0.3,
            future_values=[0.0, 0.0],
        )
        solar_forecast = _make_solar_forecast(
            {
                started_at: 100.0,
                datetime(2026, 3, 20, 21, 15, tzinfo=TZ): 0.0,
            }
        )
        schedule_overlay = _FakeScheduleOverlay(
            horizon_end=datetime(2026, 3, 22, 21, 0, tzinfo=TZ),
            actions_by_slot={
                started_at: SimpleNamespace(kind="stop_discharging", target_soc=None)
            },
        )

        with (
            patch.object(
                module,
                "read_battery_entity_config",
                return_value=module.BatteryEntityConfig(
                    remaining_energy_entity_id="sensor.remaining",
                    capacity_entity_id="sensor.capacity",
                    min_soc_entity_id="sensor.min_soc",
                    max_soc_entity_id="sensor.max_soc",
                ),
            ),
            patch.object(
                module,
                "read_battery_forecast_settings",
                return_value=module.BatteryForecastSettings(
                    charge_efficiency=1.0,
                    discharge_efficiency=1.0,
                    max_charge_power_w=10000.0,
                    max_discharge_power_w=10000.0,
                ),
            ),
            patch.object(
                module,
                "read_battery_live_state",
                return_value=module.BatteryLiveState(
                    current_remaining_energy_kwh=5.0,
                    current_soc=50.0,
                    min_soc=0.0,
                    max_soc=100.0,
                    nominal_capacity_kwh=10.0,
                    min_energy_kwh=0.0,
                    max_energy_kwh=10.0,
                ),
            ),
            patch.object(module, "build_battery_actual_history", AsyncMock(return_value=[])),
            patch.object(module, "dt_util", _FakeDtUtil),
            patch.object(recorder_hourly_series, "dt_util", _FakeDtUtil),
        ):
            payload = await builder.build(
                solar_forecast=solar_forecast,
                house_forecast=house_forecast,
                started_at=started_at,
                schedule_overlay=schedule_overlay,
            )

        self.assertTrue(payload["scheduleAdjusted"])
        self.assertEqual(payload["series"][0]["dischargedKwh"], 0.0)
        self.assertEqual(payload["series"][0]["importedFromGridKwh"], 0.2)
        self.assertEqual(payload["series"][0]["remainingEnergyKwh"], 5.0)
        self.assertEqual(payload["series"][0]["socPct"], 50.0)
        self.assertEqual(payload["series"][0]["baselineRemainingEnergyKwh"], 4.8)
        self.assertEqual(payload["series"][0]["baselineSocPct"], 48.0)

    async def test_build_with_later_stop_action_backfills_baseline_fields_for_hourly_response(
        self,
    ) -> None:
        module, builder = self._make_builder()
        started_at = REFERENCE_TIME
        house_forecast = _make_house_forecast(
            current_slot_start=datetime(2026, 3, 20, 21, 0, tzinfo=TZ),
            current_slot_value=0.1,
            future_values=[0.1, 0.1, 0.1, 0.0],
        )
        solar_forecast = _make_solar_forecast(
            {
                datetime(2026, 3, 20, 21, 0, tzinfo=TZ): 100.0,
                datetime(2026, 3, 20, 21, 15, tzinfo=TZ): 100.0,
                datetime(2026, 3, 20, 21, 30, tzinfo=TZ): 300.0,
                datetime(2026, 3, 20, 21, 45, tzinfo=TZ): 300.0,
            }
        )
        schedule_overlay = _FakeScheduleOverlay(
            horizon_end=datetime(2026, 3, 22, 21, 0, tzinfo=TZ),
            actions_by_slot={
                datetime(2026, 3, 20, 21, 30, tzinfo=TZ): SimpleNamespace(
                    kind="stop_charging",
                    target_soc=None,
                ),
                datetime(2026, 3, 20, 21, 45, tzinfo=TZ): SimpleNamespace(
                    kind="stop_charging",
                    target_soc=None,
                ),
            },
        )

        with (
            patch.object(
                module,
                "read_battery_entity_config",
                return_value=module.BatteryEntityConfig(
                    remaining_energy_entity_id="sensor.remaining",
                    capacity_entity_id="sensor.capacity",
                    min_soc_entity_id="sensor.min_soc",
                    max_soc_entity_id="sensor.max_soc",
                ),
            ),
            patch.object(
                module,
                "read_battery_forecast_settings",
                return_value=module.BatteryForecastSettings(
                    charge_efficiency=1.0,
                    discharge_efficiency=1.0,
                    max_charge_power_w=10000.0,
                    max_discharge_power_w=10000.0,
                ),
            ),
            patch.object(
                module,
                "read_battery_live_state",
                return_value=module.BatteryLiveState(
                    current_remaining_energy_kwh=5.0,
                    current_soc=50.0,
                    min_soc=0.0,
                    max_soc=100.0,
                    nominal_capacity_kwh=10.0,
                    min_energy_kwh=0.0,
                    max_energy_kwh=10.0,
                ),
            ),
            patch.object(module, "build_battery_actual_history", AsyncMock(return_value=[])),
            patch.object(module, "dt_util", _FakeDtUtil),
            patch.object(recorder_hourly_series, "dt_util", _FakeDtUtil),
            patch.object(battery_forecast_response, "dt_util", _FakeDtUtil),
        ):
            payload = await builder.build(
                solar_forecast=solar_forecast,
                house_forecast=house_forecast,
                started_at=started_at,
                schedule_overlay=schedule_overlay,
            )
            response = battery_forecast_response.build_battery_forecast_response(
                payload,
                granularity=60,
                forecast_days=1,
            )

        self.assertTrue(payload["scheduleAdjusted"])
        self.assertIn("baselineRemainingEnergyKwh", payload["series"][0])
        self.assertIn("baselineRemainingEnergyKwh", payload["series"][1])
        self.assertIn("baselineSocPct", response["series"][0])
        self.assertIn("baselineRemainingEnergyKwh", response["series"][0])

    async def test_build_keeps_adjusted_series_for_future_charge_target_action(
        self,
    ) -> None:
        module, builder = self._make_builder()
        started_at = datetime(2026, 3, 20, 21, 0, tzinfo=TZ)
        house_forecast = _make_house_forecast(
            current_slot_start=started_at,
            current_slot_value=0.1,
            future_values=[0.0, 0.0, 0.0],
        )
        solar_forecast = _make_solar_forecast(
            {
                started_at: 300.0,
                datetime(2026, 3, 20, 21, 15, tzinfo=TZ): 0.0,
                datetime(2026, 3, 20, 21, 30, tzinfo=TZ): 0.0,
            }
        )
        schedule_overlay = _FakeScheduleOverlay(
            horizon_end=datetime(2026, 3, 22, 21, 0, tzinfo=TZ),
            actions_by_slot={
                started_at: SimpleNamespace(kind="stop_charging", target_soc=None),
                datetime(2026, 3, 20, 21, 15, tzinfo=TZ): SimpleNamespace(
                    kind="charge_to_target_soc",
                    target_soc=70,
                ),
            },
        )

        with (
            patch.object(
                module,
                "read_battery_entity_config",
                return_value=module.BatteryEntityConfig(
                    remaining_energy_entity_id="sensor.remaining",
                    capacity_entity_id="sensor.capacity",
                    min_soc_entity_id="sensor.min_soc",
                    max_soc_entity_id="sensor.max_soc",
                ),
            ),
            patch.object(
                module,
                "read_battery_forecast_settings",
                return_value=module.BatteryForecastSettings(
                    charge_efficiency=1.0,
                    discharge_efficiency=1.0,
                    max_charge_power_w=10000.0,
                    max_discharge_power_w=10000.0,
                ),
            ),
            patch.object(
                module,
                "read_battery_live_state",
                return_value=module.BatteryLiveState(
                    current_remaining_energy_kwh=5.0,
                    current_soc=50.0,
                    min_soc=0.0,
                    max_soc=100.0,
                    nominal_capacity_kwh=10.0,
                    min_energy_kwh=0.0,
                    max_energy_kwh=10.0,
                ),
            ),
            patch.object(module, "build_battery_actual_history", AsyncMock(return_value=[])),
            patch.object(module, "dt_util", _FakeDtUtil),
            patch.object(recorder_hourly_series, "dt_util", _FakeDtUtil),
        ):
            payload = await builder.build(
                solar_forecast=solar_forecast,
                house_forecast=house_forecast,
                started_at=started_at,
                schedule_overlay=schedule_overlay,
            )

        self.assertTrue(payload["scheduleAdjusted"])
        self.assertEqual(payload["series"][0]["remainingEnergyKwh"], 5.0)
        self.assertEqual(payload["series"][1]["chargedKwh"], 2.0)
        self.assertEqual(payload["series"][1]["importedFromGridKwh"], 2.0)
        self.assertEqual(payload["series"][1]["remainingEnergyKwh"], 7.0)
        self.assertEqual(payload["series"][1]["baselineRemainingEnergyKwh"], 5.2)

    async def test_build_with_charge_target_overlay_resolves_slot_start_target_hit(
        self,
    ) -> None:
        module, builder = self._make_builder()
        started_at = datetime(2026, 3, 20, 21, 0, tzinfo=TZ)
        house_forecast = _make_house_forecast(
            current_slot_start=started_at,
            current_slot_value=0.3,
            future_values=[0.0, 0.0],
        )
        solar_forecast = _make_solar_forecast(
            {
                started_at: 100.0,
                datetime(2026, 3, 20, 21, 15, tzinfo=TZ): 0.0,
            }
        )
        schedule_overlay = _FakeScheduleOverlay(
            horizon_end=datetime(2026, 3, 22, 21, 0, tzinfo=TZ),
            actions_by_slot={
                started_at: SimpleNamespace(kind="charge_to_target_soc", target_soc=70)
            },
        )

        with (
            patch.object(
                module,
                "read_battery_entity_config",
                return_value=module.BatteryEntityConfig(
                    remaining_energy_entity_id="sensor.remaining",
                    capacity_entity_id="sensor.capacity",
                    min_soc_entity_id="sensor.min_soc",
                    max_soc_entity_id="sensor.max_soc",
                ),
            ),
            patch.object(
                module,
                "read_battery_forecast_settings",
                return_value=module.BatteryForecastSettings(
                    charge_efficiency=1.0,
                    discharge_efficiency=1.0,
                    max_charge_power_w=10000.0,
                    max_discharge_power_w=10000.0,
                ),
            ),
            patch.object(
                module,
                "read_battery_live_state",
                return_value=module.BatteryLiveState(
                    current_remaining_energy_kwh=7.0,
                    current_soc=70.0,
                    min_soc=0.0,
                    max_soc=100.0,
                    nominal_capacity_kwh=10.0,
                    min_energy_kwh=0.0,
                    max_energy_kwh=10.0,
                ),
            ),
            patch.object(module, "build_battery_actual_history", AsyncMock(return_value=[])),
            patch.object(module, "dt_util", _FakeDtUtil),
            patch.object(recorder_hourly_series, "dt_util", _FakeDtUtil),
        ):
            payload = await builder.build(
                solar_forecast=solar_forecast,
                house_forecast=house_forecast,
                started_at=started_at,
                schedule_overlay=schedule_overlay,
            )

        self.assertTrue(payload["scheduleAdjusted"])
        self.assertEqual(payload["series"][0]["chargedKwh"], 0.0)
        self.assertEqual(payload["series"][0]["dischargedKwh"], 0.0)
        self.assertEqual(payload["series"][0]["importedFromGridKwh"], 0.2)
        self.assertEqual(payload["series"][0]["remainingEnergyKwh"], 7.0)
        self.assertEqual(payload["series"][0]["baselineRemainingEnergyKwh"], 6.8)

    async def test_build_with_charge_target_overlay_splits_fractional_first_slot(
        self,
    ) -> None:
        module, builder = self._make_builder()
        started_at = datetime(2026, 3, 20, 21, 7, tzinfo=TZ)
        current_slot_start = datetime(2026, 3, 20, 21, 0, tzinfo=TZ)
        house_forecast = _make_house_forecast(
            current_slot_start=current_slot_start,
            current_slot_value=0.0,
            future_values=[0.0, 0.0],
        )
        solar_forecast = _make_solar_forecast(
            {
                current_slot_start: 0.0,
                datetime(2026, 3, 20, 21, 15, tzinfo=TZ): 0.0,
            }
        )
        schedule_overlay = _FakeScheduleOverlay(
            horizon_end=datetime(2026, 3, 22, 21, 0, tzinfo=TZ),
            actions_by_slot={
                current_slot_start: SimpleNamespace(
                    kind="charge_to_target_soc",
                    target_soc=60,
                )
            },
        )

        with (
            patch.object(
                module,
                "read_battery_entity_config",
                return_value=module.BatteryEntityConfig(
                    remaining_energy_entity_id="sensor.remaining",
                    capacity_entity_id="sensor.capacity",
                    min_soc_entity_id="sensor.min_soc",
                    max_soc_entity_id="sensor.max_soc",
                ),
            ),
            patch.object(
                module,
                "read_battery_forecast_settings",
                return_value=module.BatteryForecastSettings(
                    charge_efficiency=1.0,
                    discharge_efficiency=1.0,
                    max_charge_power_w=10000.0,
                    max_discharge_power_w=10000.0,
                ),
            ),
            patch.object(
                module,
                "read_battery_live_state",
                return_value=module.BatteryLiveState(
                    current_remaining_energy_kwh=5.0,
                    current_soc=50.0,
                    min_soc=0.0,
                    max_soc=100.0,
                    nominal_capacity_kwh=10.0,
                    min_energy_kwh=0.0,
                    max_energy_kwh=10.0,
                ),
            ),
            patch.object(module, "build_battery_actual_history", AsyncMock(return_value=[])),
            patch.object(module, "dt_util", _FakeDtUtil),
            patch.object(recorder_hourly_series, "dt_util", _FakeDtUtil),
        ):
            payload = await builder.build(
                solar_forecast=solar_forecast,
                house_forecast=house_forecast,
                started_at=started_at,
                schedule_overlay=schedule_overlay,
            )

        self.assertTrue(payload["scheduleAdjusted"])
        self.assertEqual(payload["series"][0]["durationHours"], 0.1333)
        self.assertEqual(payload["series"][0]["chargedKwh"], 1.0)
        self.assertEqual(payload["series"][0]["importedFromGridKwh"], 1.0)
        self.assertEqual(payload["series"][0]["remainingEnergyKwh"], 6.0)
        self.assertEqual(payload["series"][0]["baselineRemainingEnergyKwh"], 5.0)

    async def test_build_with_discharge_target_overlay_resolves_slot_start_target_hit(
        self,
    ) -> None:
        module, builder = self._make_builder()
        started_at = datetime(2026, 3, 20, 21, 0, tzinfo=TZ)
        house_forecast = _make_house_forecast(
            current_slot_start=started_at,
            current_slot_value=0.1,
            future_values=[0.0, 0.0],
        )
        solar_forecast = _make_solar_forecast(
            {
                started_at: 300.0,
                datetime(2026, 3, 20, 21, 15, tzinfo=TZ): 0.0,
            }
        )
        schedule_overlay = _FakeScheduleOverlay(
            horizon_end=datetime(2026, 3, 22, 21, 0, tzinfo=TZ),
            actions_by_slot={
                started_at: SimpleNamespace(
                    kind="discharge_to_target_soc",
                    target_soc=30,
                )
            },
        )

        with (
            patch.object(
                module,
                "read_battery_entity_config",
                return_value=module.BatteryEntityConfig(
                    remaining_energy_entity_id="sensor.remaining",
                    capacity_entity_id="sensor.capacity",
                    min_soc_entity_id="sensor.min_soc",
                    max_soc_entity_id="sensor.max_soc",
                ),
            ),
            patch.object(
                module,
                "read_battery_forecast_settings",
                return_value=module.BatteryForecastSettings(
                    charge_efficiency=1.0,
                    discharge_efficiency=1.0,
                    max_charge_power_w=10000.0,
                    max_discharge_power_w=10000.0,
                ),
            ),
            patch.object(
                module,
                "read_battery_live_state",
                return_value=module.BatteryLiveState(
                    current_remaining_energy_kwh=3.0,
                    current_soc=30.0,
                    min_soc=0.0,
                    max_soc=100.0,
                    nominal_capacity_kwh=10.0,
                    min_energy_kwh=0.0,
                    max_energy_kwh=10.0,
                ),
            ),
            patch.object(module, "build_battery_actual_history", AsyncMock(return_value=[])),
            patch.object(module, "dt_util", _FakeDtUtil),
            patch.object(recorder_hourly_series, "dt_util", _FakeDtUtil),
        ):
            payload = await builder.build(
                solar_forecast=solar_forecast,
                house_forecast=house_forecast,
                started_at=started_at,
                schedule_overlay=schedule_overlay,
            )

        self.assertTrue(payload["scheduleAdjusted"])
        self.assertEqual(payload["series"][0]["chargedKwh"], 0.0)
        self.assertEqual(payload["series"][0]["exportedToGridKwh"], 0.2)
        self.assertEqual(payload["series"][0]["remainingEnergyKwh"], 3.0)
        self.assertEqual(payload["series"][0]["baselineRemainingEnergyKwh"], 3.2)

    async def test_build_with_discharge_target_overlay_splits_fractional_first_slot(
        self,
    ) -> None:
        module, builder = self._make_builder()
        started_at = datetime(2026, 3, 20, 21, 7, tzinfo=TZ)
        current_slot_start = datetime(2026, 3, 20, 21, 0, tzinfo=TZ)
        house_forecast = _make_house_forecast(
            current_slot_start=current_slot_start,
            current_slot_value=0.0,
            future_values=[0.0, 0.0],
        )
        solar_forecast = _make_solar_forecast(
            {
                current_slot_start: 0.0,
                datetime(2026, 3, 20, 21, 15, tzinfo=TZ): 0.0,
            }
        )
        schedule_overlay = _FakeScheduleOverlay(
            horizon_end=datetime(2026, 3, 22, 21, 0, tzinfo=TZ),
            actions_by_slot={
                current_slot_start: SimpleNamespace(
                    kind="discharge_to_target_soc",
                    target_soc=40,
                )
            },
        )

        with (
            patch.object(
                module,
                "read_battery_entity_config",
                return_value=module.BatteryEntityConfig(
                    remaining_energy_entity_id="sensor.remaining",
                    capacity_entity_id="sensor.capacity",
                    min_soc_entity_id="sensor.min_soc",
                    max_soc_entity_id="sensor.max_soc",
                ),
            ),
            patch.object(
                module,
                "read_battery_forecast_settings",
                return_value=module.BatteryForecastSettings(
                    charge_efficiency=1.0,
                    discharge_efficiency=1.0,
                    max_charge_power_w=10000.0,
                    max_discharge_power_w=10000.0,
                ),
            ),
            patch.object(
                module,
                "read_battery_live_state",
                return_value=module.BatteryLiveState(
                    current_remaining_energy_kwh=5.0,
                    current_soc=50.0,
                    min_soc=0.0,
                    max_soc=100.0,
                    nominal_capacity_kwh=10.0,
                    min_energy_kwh=0.0,
                    max_energy_kwh=10.0,
                ),
            ),
            patch.object(module, "build_battery_actual_history", AsyncMock(return_value=[])),
            patch.object(module, "dt_util", _FakeDtUtil),
            patch.object(recorder_hourly_series, "dt_util", _FakeDtUtil),
        ):
            payload = await builder.build(
                solar_forecast=solar_forecast,
                house_forecast=house_forecast,
                started_at=started_at,
                schedule_overlay=schedule_overlay,
            )

        self.assertTrue(payload["scheduleAdjusted"])
        self.assertEqual(payload["series"][0]["durationHours"], 0.1333)
        self.assertEqual(payload["series"][0]["dischargedKwh"], 1.0)
        self.assertEqual(payload["series"][0]["exportedToGridKwh"], 1.0)
        self.assertEqual(payload["series"][0]["remainingEnergyKwh"], 4.0)
        self.assertEqual(payload["series"][0]["baselineRemainingEnergyKwh"], 5.0)

    async def test_build_with_unknown_schedule_action_keeps_baseline_output(self) -> None:
        module, builder = self._make_builder()
        started_at = datetime(2026, 3, 20, 21, 0, tzinfo=TZ)
        house_forecast = _make_house_forecast(
            current_slot_start=started_at,
            current_slot_value=0.1,
            future_values=[0.0, 0.0],
        )
        solar_forecast = _make_solar_forecast(
            {
                started_at: 300.0,
                datetime(2026, 3, 20, 21, 15, tzinfo=TZ): 0.0,
            }
        )
        schedule_overlay = _FakeScheduleOverlay(
            horizon_end=datetime(2026, 3, 22, 21, 0, tzinfo=TZ),
            actions_by_slot={
                started_at: SimpleNamespace(kind="unsupported_action", target_soc=80)
            },
        )

        with (
            patch.object(
                module,
                "read_battery_entity_config",
                return_value=module.BatteryEntityConfig(
                    remaining_energy_entity_id="sensor.remaining",
                    capacity_entity_id="sensor.capacity",
                    min_soc_entity_id="sensor.min_soc",
                    max_soc_entity_id="sensor.max_soc",
                ),
            ),
            patch.object(
                module,
                "read_battery_forecast_settings",
                return_value=module.BatteryForecastSettings(
                    charge_efficiency=1.0,
                    discharge_efficiency=1.0,
                    max_charge_power_w=10000.0,
                    max_discharge_power_w=10000.0,
                ),
            ),
            patch.object(
                module,
                "read_battery_live_state",
                return_value=module.BatteryLiveState(
                    current_remaining_energy_kwh=5.0,
                    current_soc=50.0,
                    min_soc=0.0,
                    max_soc=100.0,
                    nominal_capacity_kwh=10.0,
                    min_energy_kwh=0.0,
                    max_energy_kwh=10.0,
                ),
            ),
            patch.object(module, "build_battery_actual_history", AsyncMock(return_value=[])),
            patch.object(module, "dt_util", _FakeDtUtil),
            patch.object(recorder_hourly_series, "dt_util", _FakeDtUtil),
        ):
            payload = await builder.build(
                solar_forecast=solar_forecast,
                house_forecast=house_forecast,
                started_at=started_at,
                schedule_overlay=schedule_overlay,
            )

        self.assertFalse(payload["scheduleAdjusted"])
        self.assertIsNone(payload["scheduleAdjustmentCoverageUntil"])
        self.assertEqual(payload["series"][0]["remainingEnergyKwh"], 5.2)
        self.assertNotIn("baselineRemainingEnergyKwh", payload["series"][0])
        self.assertNotIn("baselineSocPct", payload["series"][0])


if __name__ == "__main__":
    unittest.main()
