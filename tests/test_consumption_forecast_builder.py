from __future__ import annotations

from homeassistant.util import dt as dt_util

import importlib
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo

from _ha_stubs import stub_module

REFERENCE_TIME = datetime.fromisoformat("2026-03-20T21:07:00+01:00")
TZ = ZoneInfo("Europe/Prague")
UTC = timezone.utc


async def _inline_executor_job(func, *args):
    """Run the offloaded callable inline so tests don't need a real executor."""
    return func(*args)


def _make_hass() -> SimpleNamespace:
    return SimpleNamespace(
        config=SimpleNamespace(time_zone="Europe/Prague"),
        states=SimpleNamespace(
            get=lambda entity_id: SimpleNamespace(
                attributes={"unit_of_measurement": "kWh"}
            )
        ),
        async_add_executor_job=_inline_executor_job,
    )


def _replay_window(
    states: list[SimpleNamespace], start: datetime, end: datetime
) -> list[SimpleNamespace]:
    """What the recorder hands back for [start, end): the end bound is
    exclusive, and include_start_time_state replays the value in force at the
    start of the window, stamped with the start."""
    window = [state for state in states if start <= state.last_updated < end]
    earlier = [state for state in states if state.last_updated < start]
    if earlier:
        window.insert(
            0,
            SimpleNamespace(
                state=earlier[-1].state,
                attributes=earlier[-1].attributes,
                last_updated=start,
            ),
        )
    return window


def _install_import_stubs() -> None:

    core_mod = stub_module("homeassistant.core")
    if not hasattr(core_mod, "HomeAssistant"):
        core_mod.HomeAssistant = type("HomeAssistant", (), {})

    recorder_mod = stub_module("homeassistant.components.recorder")
    if not hasattr(recorder_mod, "get_instance"):
        recorder_mod.get_instance = lambda hass: None

    history_mod = stub_module("homeassistant.components.recorder.history")
    if not hasattr(history_mod, "state_changes_during_period"):
        history_mod.state_changes_during_period = lambda *args, **kwargs: {}
    if not hasattr(history_mod, "get_significant_states"):
        history_mod.get_significant_states = lambda *args, **kwargs: {}

    util_pkg = stub_module("homeassistant.util")
    dt_mod = stub_module("homeassistant.util.dt")
    if not hasattr(dt_mod, "as_local"):
        dt_mod.as_local = lambda value: value
    if not hasattr(dt_mod, "as_utc"):
        dt_mod.as_utc = lambda value: value
    if not hasattr(dt_mod, "now"):
        dt_mod.now = lambda: REFERENCE_TIME
    if not hasattr(dt_mod, "utc_from_timestamp"):
        dt_mod.utc_from_timestamp = lambda ts: datetime.fromtimestamp(ts, tz=UTC)
    util_pkg.dt = dt_mod




_install_import_stubs()


class _RecordingSlotHistory:
    """Stands in for the coordinator-owned reader and records what it was asked.

    The builder no longer queries the recorder itself, so what these tests can
    still pin is the shape of the request: which entities, at which reference
    time, and that a build with nothing to serve makes none at all.
    """

    def __init__(self) -> None:
        self.queries: list[tuple[str, datetime]] = []

    async def async_query_slot_energy_changes(
        self, entity_id, reference_time, *, interval_minutes
    ):
        self.queries.append((entity_id, reference_time))
        return {}


class ConsumptionForecastBuilderTests(unittest.IsolatedAsyncioTestCase):
    def _make_builder(self, *, min_history_days: int = 14, training_window_days: int = 56):
        recorder_module = importlib.reload(
            importlib.import_module("custom_components.helman.today_slot_readers")
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
            "energy_nodes": {
                "house": {
                    "forecast": {
                        "total_energy_entity_id": "sensor.house_total",
                    }
                }
            },
            # Since the v14 relocation these two live at an absolute path, not
            # as siblings of the entity they govern.
            "training": {
                "house_consumption": {
                    "min_history_days": min_history_days,
                    "training_window_days": training_window_days,
                }
            },
            # The deferrable split is read off the controllables now: the
            # washer is one because it is a controllable that names its meter,
            # not because a second list said so.
            "devices": {"consumers": [
                {
                    "kind": "generic",
                    "schedulable": True,
                    "id": "washer",
                    "name": "Washer",
                    "controls": {"switch": {"entity_id": "switch.washer"}},
                    "consumption": {
                        "energy_entity_id": "sensor.washer_energy",
                        "projection": {"strategy": "fixed", "hourly_energy_kwh": 0.5},
                    },
                }
            ]},
        }
        return (
            consumption_module,
            recorder_module,
            consumption_module.ConsumptionForecastBuilder(
                hass, config, _RecordingSlotHistory()
            ),
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
            patch.object(consumption_module, "dt_util", dt_util),
            patch.object(recorder_module, "dt_util", dt_util),
        ):
            return builder.assemble(
                self._flat_profile(consumption_module, consumers=consumers),
                local_now=dt_util.as_local(reference_time),
                consumers_config=[
                    {"energy_entity_id": "sensor.washer_energy", "label": "Washer"}
                ],
                actual_history=[],
                forecast_days=forecast_days,
                training_window_days=56,
                min_history_days=14,
                config_fingerprint="fingerprint",
            )

    async def test_build_reports_insufficient_history_below_the_minimum(self) -> None:
        """A profile fitted from three days against a 14-day minimum: no model,
        no series."""
        consumption_module, recorder_module, builder = self._make_builder()
        profile = consumption_module.HouseConsumptionProfile(
            schema_version=1,
            history_days=3,
            non_deferrable=[consumption_module.ForecastBand(1.0, 1.0, 1.0)] * 168,
            consumers={},
        )

        with (
            patch.object(consumption_module, "dt_util", dt_util),
            patch.object(recorder_module, "dt_util", dt_util),
            patch.object(
                builder,
                "_build_actual_history",
                AsyncMock(return_value=[]),
            ),
        ):
            payload = await builder.build(
                reference_time=REFERENCE_TIME,
                profile=profile,
                forecast_days=1,
            )

        self.assertEqual(payload["status"], "insufficient_history")
        self.assertEqual(payload["historyDaysAvailable"], 3)
        self.assertEqual(payload["requiredHistoryDays"], 14)
        self.assertIsNone(payload["model"])
        self.assertEqual(payload["series"], [])
        self.assertNotIn("currentSlot", payload)

    async def test_build_reads_the_minimum_from_training_house_consumption(self) -> None:
        """A non-default value proves the field is read from its new home --
        the v14 relocation moved it out from under energy_nodes.house.forecast."""
        consumption_module, recorder_module, builder = self._make_builder(
            min_history_days=21, training_window_days=90
        )
        profile = consumption_module.HouseConsumptionProfile(
            schema_version=1,
            history_days=10,
            non_deferrable=[consumption_module.ForecastBand(1.0, 1.0, 1.0)] * 168,
            consumers={},
        )

        with (
            patch.object(consumption_module, "dt_util", dt_util),
            patch.object(recorder_module, "dt_util", dt_util),
            patch.object(
                builder,
                "_build_actual_history",
                AsyncMock(return_value=[]),
            ),
        ):
            payload = await builder.build(
                reference_time=REFERENCE_TIME,
                profile=profile,
                forecast_days=1,
            )

        self.assertEqual(payload["status"], "insufficient_history")
        self.assertEqual(payload["requiredHistoryDays"], 21)
        self.assertEqual(payload["trainingWindowDays"], 90)

    async def test_build_without_a_profile_is_unavailable_and_queries_nothing(
        self,
    ) -> None:
        """The whole point of the nightly batch: a build with no profile must
        not reach for the recorder at all, let alone for a training window."""
        consumption_module, recorder_module, builder = self._make_builder()

        with (
            patch.object(consumption_module, "dt_util", dt_util),
            patch.object(recorder_module, "dt_util", dt_util),
        ):
            payload = await builder.build(
                reference_time=REFERENCE_TIME,
                profile=None,
                forecast_days=1,
            )

        self.assertEqual(payload["status"], "unavailable")
        self.assertEqual(payload["series"], [])
        self.assertEqual(builder._slot_history.queries, [])

    async def test_every_payload_matches_the_snapshot_filter_for_its_config(
        self,
    ) -> None:
        """The coordinator's read path trusts this: a snapshot the refresh
        stores always passes ``_has_matching_forecast_snapshot`` for the config
        it was built from, so the getter carries no fingerprint check."""
        from tests._fakes import make_coordinator

        consumption_module, recorder_module, builder = self._make_builder()
        unconfigured = consumption_module.ConsumptionForecastBuilder(
            builder._hass, {}, builder._slot_history
        )
        cases = (
            (builder, self._flat_profile(consumption_module)),
            (builder, None),
            (unconfigured, None),
        )

        for case_builder, profile in cases:
            with (
                patch.object(consumption_module, "dt_util", dt_util),
                patch.object(recorder_module, "dt_util", dt_util),
            ):
                payload = await case_builder.build(
                    reference_time=REFERENCE_TIME, profile=profile
                )
            request = consumption_module.read_house_forecast_request(
                case_builder._config
            )
            coordinator = make_coordinator()
            coordinator.forecast._cached_forecast = payload

            with self.subTest(status=payload["status"]):
                self.assertTrue(
                    coordinator.forecast._has_matching_forecast_snapshot(
                        total_energy_entity_id=request.total_energy_entity_id,
                        training_window_days=request.training_window_days,
                        min_history_days=request.min_history_days,
                        config_fingerprint=request.config_fingerprint,
                    )
                )

    async def test_build_issues_no_multi_day_recorder_query(self) -> None:
        """Job #4's acceptance criterion: only today-scoped queries remain."""
        consumption_module, recorder_module, builder = self._make_builder()

        self.assertFalse(
            hasattr(builder, "_query_hourly_history"),
            "the multi-day query belongs to the training job, not the builder",
        )

        with (
            patch.object(consumption_module, "dt_util", dt_util),
            patch.object(recorder_module, "dt_util", dt_util),
        ):
            payload = await builder.build(
                reference_time=REFERENCE_TIME,
                profile=self._flat_profile(consumption_module),
                forecast_days=1,
            )

        self.assertEqual(payload["status"], "available")
        # Both queries are the today-scoped slot query, one per entity.
        self.assertEqual(
            [entity_id for entity_id, _ in builder._slot_history.queries],
            ["sensor.house_total", "sensor.washer_energy"],
        )

    async def test_build_carries_the_training_metadata_into_the_payload(self) -> None:
        consumption_module, recorder_module, builder = self._make_builder()

        with (
            patch.object(consumption_module, "dt_util", dt_util),
            patch.object(recorder_module, "dt_util", dt_util),
            patch.object(
                builder, "_build_actual_history", AsyncMock(return_value=[])
            ),
        ):
            payload = await builder.build(
                reference_time=REFERENCE_TIME,
                profile=self._flat_profile(consumption_module),
                trained_at="2026-03-20T03:00:00+01:00",
                last_outcome="profile_trained",
                forecast_days=1,
            )

        self.assertEqual(payload["trainedAt"], "2026-03-20T03:00:00+01:00")
        self.assertEqual(payload["lastOutcome"], "profile_trained")

    def test_actual_history_keeps_slot_with_missing_consumer_value(self) -> None:
        consumption_module, _, builder = self._make_builder()
        slot = datetime(2026, 3, 20, 10, 0, tzinfo=TZ)
        timestamp_key = dt_util.as_utc(slot)

        actual = builder._build_slot_actual_history(
            house_by_slot={timestamp_key: 2.5},
            consumers=[
                consumption_module._ConsumerSlotHistoryData(
                    "sensor.washer", "Washer", {timestamp_key: 0.75}
                ),
                consumption_module._ConsumerSlotHistoryData("sensor.pool", "Pool", {}),
            ],
            completed_slots=[slot],
        )

        self.assertEqual(
            actual,
            [{
                "timestamp": slot.isoformat(),
                "nonDeferrable": {"value": 1.75},
                "deferrableConsumers": [
                    {"entityId": "sensor.washer", "label": "Washer", "value": 0.75},
                    {"entityId": "sensor.pool", "label": "Pool", "value": 0.0},
                ],
            }],
        )

    async def test_actual_history_keeps_every_house_slot_after_consumer_query_failure(
        self,
    ) -> None:
        consumption_module, _, builder = self._make_builder()
        slots = [datetime(2026, 3, 20, hour, 0, tzinfo=TZ) for hour in (10, 11)]
        house_by_slot = {
            dt_util.as_utc(slot): value for slot, value in zip(slots, (1.25, 2.5))
        }

        with (
            patch.object(
                builder,
                "_query_slot_history",
                AsyncMock(side_effect=[house_by_slot, RuntimeError("meter offline")]),
            ),
            patch.object(
                consumption_module,
                "get_today_completed_local_slots",
                return_value=slots,
            ),
            self.assertLogs(consumption_module.__name__, level="WARNING") as logs,
        ):
            actual = await builder._build_actual_history(
                total_energy_entity_id="sensor.house_total",
                consumers_config=[{"energy_entity_id": "sensor.pool", "label": "Pool"}],
                reference_time=REFERENCE_TIME,
            )

        self.assertEqual(len(actual), 2)
        self.assertEqual(
            [entry["timestamp"] for entry in actual],
            [slot.isoformat() for slot in slots],
        )
        self.assertEqual(
            [entry["nonDeferrable"]["value"] for entry in actual], [1.25, 2.5]
        )
        self.assertEqual(
            [entry["deferrableConsumers"] for entry in actual],
            [[{"entityId": "sensor.pool", "label": "Pool", "value": 0.0}]] * 2,
        )
        self.assertIn("Failed to query slot history", logs.output[0])

    def test_actual_history_drops_materially_negative_residual(self) -> None:
        consumption_module, _, builder = self._make_builder()
        slot = datetime(2026, 3, 20, 10, 0, tzinfo=TZ)
        timestamp_key = dt_util.as_utc(slot)

        actual = builder._build_slot_actual_history(
            house_by_slot={timestamp_key: 1.0},
            consumers=[
                consumption_module._ConsumerSlotHistoryData(
                    "sensor.washer", "Washer", {timestamp_key: 1.1}
                )
            ],
            completed_slots=[slot],
        )

        self.assertEqual(actual, [])

    def test_actual_history_skips_slot_without_house_value(self) -> None:
        consumption_module, _, builder = self._make_builder()
        missing_slot = datetime(2026, 3, 20, 10, 0, tzinfo=TZ)
        present_slot = datetime(2026, 3, 20, 10, 15, tzinfo=TZ)

        actual = builder._build_slot_actual_history(
            house_by_slot={dt_util.as_utc(present_slot): 1.0},
            consumers=[
                consumption_module._ConsumerSlotHistoryData("sensor.pool", "Pool", {})
            ],
            completed_slots=[missing_slot, present_slot],
        )

        self.assertEqual(len(actual), 1)
        self.assertEqual(actual[0]["timestamp"], present_slot.isoformat())
        self.assertEqual(actual[0]["nonDeferrable"]["value"], 1.0)

    def test_assemble_one_day_series_is_canonical_quarter_hour(self) -> None:
        payload = self._assemble_payload(
            reference_time=REFERENCE_TIME,
            forecast_days=1,
        )

        self.assertEqual(payload["currentSlot"]["timestamp"], "2026-03-20T21:00:00+01:00")
        self.assertEqual(len(payload["series"]), 96)
        self.assertEqual(payload["series"][0]["timestamp"], "2026-03-20T21:15:00+01:00")

    def test_assemble_seven_day_series_length_matches_requested_horizon(self) -> None:
        payload = self._assemble_payload(
            reference_time=REFERENCE_TIME,
            forecast_days=7,
        )

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
    """The slot-history cache lives on the reader the coordinator owns.

    The builder is constructed fresh on every refresh, so a cache held by the
    builder could never produce a hit. These tests wire it the way the
    coordinator does — one reader, a new builder per refresh — and fail if
    today's completed slots go back to being re-read in full.
    """

    ENTITY_ID = "sensor.a"

    def _make_modules(self):
        recorder_module = importlib.reload(
            importlib.import_module("custom_components.helman.today_slot_readers")
        )
        consumption_module = importlib.reload(
            importlib.import_module("custom_components.helman.consumption_forecast_builder")
        )
        return consumption_module, recorder_module

    @staticmethod
    def _states() -> list[SimpleNamespace]:
        """A counter climbing 0.1 kWh every quarter hour from local midnight."""
        midnight = datetime(2026, 5, 10, 0, 0, tzinfo=TZ)
        return [
            SimpleNamespace(
                state=str(round(index * 0.1, 4)),
                attributes={"unit_of_measurement": "kWh"},
                last_updated=dt_util.as_utc(
                    midnight + timedelta(minutes=15 * index)
                ),
            )
            for index in range(96)
        ]

    async def _refresh(
        self,
        consumption_module,
        recorder_module,
        reader,
        *,
        reference_time: datetime,
        windows: list[tuple[datetime, datetime]],
    ) -> dict:
        """One production-shaped refresh: a brand new builder, the same reader."""
        states = self._states()

        def _fake_state_changes_during_period(hass, start, end, entity_id, *args):
            windows.append((start, end))
            return {entity_id: _replay_window(states, start, end)}

        builder = consumption_module.ConsumptionForecastBuilder(
            _make_hass(), {}, reader
        )
        consumers = [{"energy_entity_id": self.ENTITY_ID, "label": "A"}]
        with (
            patch.object(recorder_module, "dt_util", dt_util),
            patch.object(
                recorder_module,
                "state_changes_during_period",
                _fake_state_changes_during_period,
            ),
            patch.object(
                recorder_module,
                "get_instance",
                lambda hass: SimpleNamespace(
                    async_add_executor_job=_inline_executor_job
                ),
            ),
        ):
            histories = await builder._query_consumer_slot_histories(
                consumers, reference_time=reference_time
            )
        return histories[0].values_by_slot

    async def test_a_later_refresh_reads_only_the_unsettled_tail(self) -> None:
        consumption_module, recorder_module = self._make_modules()
        reader = recorder_module.TodaySlotEnergyReader(_make_hass())
        windows: list[tuple[datetime, datetime]] = []

        await self._refresh(
            consumption_module,
            recorder_module,
            reader,
            reference_time=datetime(2026, 5, 10, 23, 30, tzinfo=TZ),
            windows=windows,
        )
        values = await self._refresh(
            consumption_module,
            recorder_module,
            reader,
            reference_time=datetime(2026, 5, 10, 23, 50, tzinfo=TZ),
            windows=windows,
        )

        # The first refresh of the day has to read the day -- widened back by
        # the 15-minute grid's 30-minute staleness limit (decision 4), so a
        # carry spanning the window start can still be judged on its true age
        # -- and the second reads only what could still change: the slots
        # inside the rebound window.
        self.assertEqual(
            windows[0],
            (
                dt_util.as_utc(datetime(2026, 5, 9, 23, 30, tzinfo=TZ)),
                dt_util.as_utc(datetime(2026, 5, 10, 23, 30, tzinfo=TZ)),
            ),
        )
        self.assertEqual(
            windows[1],
            (
                dt_util.as_utc(datetime(2026, 5, 10, 22, 45, tzinfo=TZ)),
                dt_util.as_utc(datetime(2026, 5, 10, 23, 45, tzinfo=TZ)),
            ),
        )
        # And the answer is still the whole day, not just the tail.
        self.assertEqual(len(values), 95)

    async def test_the_cached_refresh_matches_a_cold_one(self) -> None:
        consumption_module, recorder_module = self._make_modules()
        reader = recorder_module.TodaySlotEnergyReader(_make_hass())
        windows: list[tuple[datetime, datetime]] = []

        for hour in range(1, 24):
            await self._refresh(
                consumption_module,
                recorder_module,
                reader,
                reference_time=datetime(2026, 5, 10, hour, 50, tzinfo=TZ),
                windows=windows,
            )
        warm = await self._refresh(
            consumption_module,
            recorder_module,
            reader,
            reference_time=datetime(2026, 5, 10, 23, 50, tzinfo=TZ),
            windows=windows,
        )
        cold = await self._refresh(
            consumption_module,
            recorder_module,
            recorder_module.TodaySlotEnergyReader(_make_hass()),
            reference_time=datetime(2026, 5, 10, 23, 50, tzinfo=TZ),
            windows=windows,
        )

        self.assertEqual(warm, cold)


if __name__ == "__main__":
    unittest.main()
