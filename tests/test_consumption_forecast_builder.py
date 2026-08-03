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
REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
TZ = ZoneInfo("Europe/Prague")
UTC = timezone.utc


async def _inline_executor_job(func, *args):
    """Run the offloaded callable inline so tests don't need a real executor."""
    return func(*args)


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
    if not hasattr(dt_mod, "now"):
        dt_mod.now = lambda: REFERENCE_TIME
    if not hasattr(dt_mod, "utc_from_timestamp"):
        dt_mod.utc_from_timestamp = lambda ts: datetime.fromtimestamp(ts, tz=UTC)
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
    def now() -> datetime:
        return REFERENCE_TIME

    @staticmethod
    def utc_from_timestamp(timestamp: float) -> datetime:
        return datetime.fromtimestamp(timestamp, tz=UTC)


_install_import_stubs()


class ConsumptionForecastBuilderTests(unittest.IsolatedAsyncioTestCase):
    def _make_builder(self):
        recorder_module = importlib.reload(
            importlib.import_module("custom_components.helman.recorder_hourly_series")
        )
        consumption_module = importlib.reload(
            importlib.import_module("custom_components.helman.consumption_forecast_builder")
        )
        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague"),
            states=SimpleNamespace(get=lambda entity_id: None),
            async_add_executor_job=_inline_executor_job,
        )
        config = {
            "power_devices": {
                "house": {
                    "forecast": {
                        "total_energy_entity_id": "sensor.house_total",
                        "training_window_days": 56,
                        "min_history_days": 14,
                        "deferrable_consumers": [
                            {
                                "energy_entity_id": "sensor.washer_energy",
                                "label": "Washer",
                            }
                        ],
                    }
                }
            }
        }
        return (
            consumption_module,
            recorder_module,
            consumption_module.ConsumptionForecastBuilder(hass, config),
        )

    @staticmethod
    def _flat_profile(consumption_module, *, consumers: bool = True):
        """A fitted profile whose 168 bands are all the same, so the assertions
        below are about slot arithmetic and scaling, never about the fit."""
        band = consumption_module.ForecastBand
        return consumption_module.HouseConsumptionProfile(
            schema_version=1,
            history_days=28,
            non_deferrable=[band(4.0, 2.0, 6.0)] * 168,
            consumers=(
                {"sensor.washer_energy": [band(2.0, 1.0, 3.0)] * 168}
                if consumers
                else {}
            ),
        )

    def _assemble_payload(
        self,
        *,
        reference_time: datetime,
        forecast_days: int,
        consumers: bool = True,
    ) -> dict:
        consumption_module, recorder_module, builder = self._make_builder()

        with (
            patch.object(consumption_module, "dt_util", _FakeDtUtil),
            patch.object(recorder_module, "dt_util", _FakeDtUtil),
        ):
            return builder.assemble(
                self._flat_profile(consumption_module, consumers=consumers),
                local_now=_FakeDtUtil.as_local(reference_time),
                consumers_config=[
                    {"energy_entity_id": "sensor.washer_energy", "label": "Washer"}
                ],
                actual_history=[],
                forecast_days=forecast_days,
                alignment_padding_slots=0,
                training_window_days=56,
                min_history_days=14,
                config_fingerprint="fingerprint",
                canonical_resolution=consumption_module.get_forecast_resolution(15),
                horizon_hours=forecast_days * 24,
            )

    async def test_build_reports_insufficient_history_below_the_minimum(self) -> None:
        """Three days of rows against a 14-day minimum: no model, no series."""
        consumption_module, recorder_module, builder = self._make_builder()
        hourly_rows = [
            {
                "start": datetime(2026, 3, 17, 10, 0, tzinfo=UTC).timestamp(),
                "change": 1.0,
            }
        ]

        with (
            patch.object(consumption_module, "dt_util", _FakeDtUtil),
            patch.object(recorder_module, "dt_util", _FakeDtUtil),
            patch.object(
                builder,
                "_query_hourly_history",
                AsyncMock(return_value=hourly_rows),
            ),
            patch.object(
                builder,
                "_query_consumer_histories",
                AsyncMock(return_value=[]),
            ),
            patch.object(
                builder,
                "_build_actual_history",
                AsyncMock(return_value=[]),
            ),
        ):
            payload = await builder.build(
                reference_time=REFERENCE_TIME,
                forecast_days=1,
            )

        self.assertEqual(payload["status"], "insufficient_history")
        self.assertEqual(payload["historyDaysAvailable"], 3)
        self.assertEqual(payload["requiredHistoryDays"], 14)
        self.assertIsNone(payload["model"])
        self.assertEqual(payload["series"], [])
        self.assertNotIn("currentSlot", payload)

    def test_assemble_one_day_series_is_canonical_quarter_hour(self) -> None:
        payload = self._assemble_payload(
            reference_time=REFERENCE_TIME,
            forecast_days=1,
        )

        self.assertEqual(payload["resolution"], "quarter_hour")
        self.assertEqual(payload["horizonHours"], 24)
        self.assertEqual(payload["currentSlot"]["timestamp"], "2026-03-20T21:00:00+01:00")
        self.assertNotIn("currentHour", payload)
        self.assertEqual(len(payload["series"]), 96)
        self.assertEqual(payload["series"][0]["timestamp"], "2026-03-20T21:15:00+01:00")

    def test_assemble_seven_day_series_length_matches_requested_horizon(self) -> None:
        payload = self._assemble_payload(
            reference_time=REFERENCE_TIME,
            forecast_days=7,
        )

        self.assertEqual(payload["horizonHours"], 168)
        self.assertEqual(len(payload["series"]), 672)

    def test_quarter_hour_values_sum_back_to_hourly_band(self) -> None:
        payload = self._assemble_payload(
            reference_time=REFERENCE_TIME,
            forecast_days=1,
        )

        first_hour_entries = [payload["currentSlot"], *payload["series"][:3]]
        self.assertAlmostEqual(
            sum(entry["nonDeferrable"]["value"] for entry in first_hour_entries),
            4.0,
        )
        self.assertAlmostEqual(
            sum(entry["nonDeferrable"]["lower"] for entry in first_hour_entries),
            2.0,
        )
        self.assertAlmostEqual(
            sum(entry["nonDeferrable"]["upper"] for entry in first_hour_entries),
            6.0,
        )
        self.assertAlmostEqual(
            sum(
                entry["deferrableConsumers"][0]["value"]
                for entry in first_hour_entries
            ),
            2.0,
        )
        self.assertAlmostEqual(
            sum(
                entry["deferrableConsumers"][0]["lower"]
                for entry in first_hour_entries
            ),
            1.0,
        )
        self.assertAlmostEqual(
            sum(
                entry["deferrableConsumers"][0]["upper"]
                for entry in first_hour_entries
            ),
            3.0,
        )

    def test_current_slot_alignment_follows_quarter_hour_boundaries(self) -> None:
        payload = self._assemble_payload(
            reference_time=datetime.fromisoformat("2026-03-20T21:16:00+01:00"),
            forecast_days=1,
        )

        self.assertEqual(payload["currentSlot"]["timestamp"], "2026-03-20T21:15:00+01:00")

    def test_assemble_forecasts_zero_for_a_series_the_profile_lacks(self) -> None:
        """A consumer the profile never saw must not blank the whole payload."""
        payload = self._assemble_payload(
            reference_time=REFERENCE_TIME,
            forecast_days=1,
            consumers=False,
        )

        consumer = payload["currentSlot"]["deferrableConsumers"][0]
        self.assertEqual(consumer["entityId"], "sensor.washer_energy")
        self.assertEqual(consumer["label"], "Washer")
        self.assertEqual(
            (consumer["value"], consumer["lower"], consumer["upper"]),
            (0.0, 0.0, 0.0),
        )
        self.assertEqual(payload["status"], "available")

    def _assert_pure(self, func_object, what: str) -> None:
        """Both halves of the offloaded work must be safe in a worker thread:
        synchronous and never touching ``self._hass``."""
        import ast
        import inspect
        import textwrap

        func = ast.parse(textwrap.dedent(inspect.getsource(func_object))).body[0]
        self.assertNotIsInstance(
            func, ast.AsyncFunctionDef, f"{what} must be synchronous"
        )
        for node in ast.walk(func):
            self.assertNotIsInstance(node, ast.Await, f"{what} must not await")
            if (
                isinstance(node, ast.Attribute)
                and isinstance(node.value, ast.Name)
                and node.value.id == "self"
            ):
                self.assertNotEqual(
                    node.attr,
                    "_hass",
                    f"{what} must not touch self._hass (runs off-loop)",
                )

    def test_assemble_is_pure_no_hass_no_await(self) -> None:
        consumption_module = importlib.import_module(
            "custom_components.helman.consumption_forecast_builder"
        )
        self._assert_pure(
            consumption_module.ConsumptionForecastBuilder.assemble,
            "assembly",
        )

    def test_fit_house_profile_is_pure_no_hass_no_await(self) -> None:
        profiles_module = importlib.import_module(
            "custom_components.helman.consumption_forecast_profiles"
        )
        self._assert_pure(profiles_module.fit_house_profile, "the fit")


class ConsumptionForecastBuilderCacheTests(unittest.IsolatedAsyncioTestCase):
    def _make_builder(self):
        importlib.reload(
            importlib.import_module("custom_components.helman.recorder_hourly_series")
        )
        consumption_module = importlib.reload(
            importlib.import_module("custom_components.helman.consumption_forecast_builder")
        )
        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague"),
            states=SimpleNamespace(get=lambda entity_id: None),
            async_add_executor_job=_inline_executor_job,
        )
        return (
            consumption_module,
            consumption_module.ConsumptionForecastBuilder(hass, config={}),
        )

    async def test_consumer_slot_history_cache_avoids_duplicate_recorder_calls(self):
        """Two builds in quick succession should hit the recorder only once
        per consumer."""
        from unittest.mock import AsyncMock, patch

        consumption_module, builder = self._make_builder()

        calls: list[str] = []

        async def _fake_query(_hass, entity_id, _ref, **_kw):
            calls.append(entity_id)
            return {}

        consumers = [{"energy_entity_id": "sensor.a", "label": "A"}]
        ref = datetime(2026, 5, 10, 12, 0, tzinfo=UTC)

        with patch.object(consumption_module, "query_slot_energy_changes", _fake_query):
            await builder._query_consumer_slot_histories(consumers, reference_time=ref)
            await builder._query_consumer_slot_histories(consumers, reference_time=ref)

        self.assertEqual(calls, ["sensor.a"])  # second call hit the cache


if __name__ == "__main__":
    unittest.main()
