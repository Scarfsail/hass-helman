"""The inspector's two price rails: where each slot's rate comes from.

A rail spans the whole day, but no single source can cover it. Elapsed slots are
recorder history — the import sensor Helman publishes, and the configured
sell-price entity, which has always recorded itself. Slots the clock has not
reached are the live price feed's. And the import side has a third source under
both of them: the window config, which prices any minute of any date and is what
fills the days that predate the sensor. These tests pin the joins between the
three, because a wrong join shows up as a gap in the strip or as a slot drawn
twice, neither of which any single source can be blamed for.
"""

from __future__ import annotations

import sys
import types
import unittest
from datetime import date, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
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


_install_import_stubs()

import importlib  # noqa: E402

service_mod = importlib.import_module(
    "custom_components.helman.solar_bias_correction.service"
)
models = importlib.import_module(
    "custom_components.helman.solar_bias_correction.models"
)
price_builder = importlib.import_module(
    "custom_components.helman.grid_price_forecast_builder"
)

PRAGUE = ZoneInfo("Europe/Prague")
#: "Now" for every test here: 10:00 local on 2026-05-11.
TODAY = "2026-05-11"
PAST_DAY = "2026-05-10"
IMPORT_ENTITY = "sensor.helman_grid_import_price"
EXPORT_ENTITY = "sensor.spot_sell_price"


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
        daily_energy_entity_ids=["sensor.solar_today"],
        total_energy_entity_id="sensor.solar_total",
    )


def _import_config(price: float = 4.0, night_price: float = 2.0):
    """A two-window day tariff: cheap overnight, dearer from 06:00."""
    return price_builder.FixedGridImportPriceConfig(
        unit="CZK/kWh",
        windows=(
            price_builder.FixedGridImportPriceWindow(
                start_minutes=6 * 60, end_minutes=22 * 60, price=price
            ),
            price_builder.FixedGridImportPriceWindow(
                start_minutes=22 * 60, end_minutes=6 * 60, price=night_price
            ),
        ),
    )


def _live_snapshot(day: str, *, import_from: str = "10:00", export_from: str = "10:00"):
    """A live price feed running from a slot to the end of the named day."""

    def _points(start_slot: str, value: float):
        start = _slot_index(start_slot)
        return [
            {
                "timestamp": f"{day}T{_slot_label(index)}:00+02:00",
                "value": value,
            }
            for index in range(start, 96)
        ]

    return {
        "import": {"status": "available", "unit": "CZK/kWh", "points": _points(import_from, 9.0)},
        "export": {"status": "available", "unit": "CZK/kWh", "points": _points(export_from, 1.5)},
    }


def _slot_index(slot: str) -> int:
    hour, minute = slot.split(":")
    return (int(hour) * 60 + int(minute)) // 15


def _slot_label(index: int) -> str:
    minutes = index * 15
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _rail(slots: list[str], value: float) -> list[dict]:
    return [{"slot": slot, "value": value} for slot in slots]


def _all_slots() -> list[str]:
    return [_slot_label(index) for index in range(96)]


class TestLivePriceRail(unittest.TestCase):
    """What the live feed delivers, laid onto the rail's own slot grid."""

    def test_keys_points_by_local_slot_and_drops_other_days(self):
        rail = service_mod._live_price_rail(
            {
                "points": [
                    {"timestamp": "2026-05-10T23:45:00+02:00", "value": 1.0},
                    {"timestamp": "2026-05-11T10:00:00+02:00", "value": 2.0},
                    {"timestamp": "2026-05-11T10:15:00+02:00", "value": 3.0},
                    {"timestamp": "2026-05-12T00:00:00+02:00", "value": 4.0},
                ]
            },
            date(2026, 5, 11),
            PRAGUE,
        )

        # Only this day's points, and nothing before the first of them: the
        # elapsed half of a forward-only feed stays the recorder's to answer.
        self.assertNotIn("09:45", rail)
        self.assertEqual(rail["10:00"], 2.0)
        # The last point carries to the end of the day rather than stopping dead.
        self.assertEqual(rail["10:15"], 3.0)
        self.assertEqual(rail["23:45"], 3.0)

    def test_an_hourly_feed_fills_the_quarter_hours_between_its_points(self):
        # The sell-price entity publishes hourly. Matching only exact slots would
        # leave three of every four empty, and the recorder would then fill them
        # with whatever stale sample it held -- which is the sawtooth this
        # carry-forward exists to prevent.
        rail = service_mod._live_price_rail(
            {
                "points": [
                    {"timestamp": "2026-05-11T00:00:00+02:00", "value": 3.9},
                    {"timestamp": "2026-05-11T01:00:00+02:00", "value": 3.5},
                ]
            },
            date(2026, 5, 11),
            PRAGUE,
        )

        self.assertEqual(
            [rail[slot] for slot in ("00:00", "00:15", "00:30", "00:45")],
            [3.9, 3.9, 3.9, 3.9],
        )
        self.assertEqual([rail["01:00"], rail["01:45"]], [3.5, 3.5])

    def test_an_absent_channel_is_an_empty_rail(self):
        self.assertEqual(service_mod._live_price_rail(None, date(2026, 5, 11), PRAGUE), {})


class TestConfigFallbackFill(unittest.TestCase):
    """The window config under the import rail, applied per slot."""

    def test_fills_only_the_slots_the_recorder_left_empty(self):
        by_slot = {"00:00": 99.0, "07:00": 98.0}
        service_mod._fill_import_rail_from_config(by_slot, _import_config().windows)

        # Recorded slots keep the rate that actually applied; everything else
        # takes the window table's answer for its own minute of the day.
        self.assertEqual(by_slot["00:00"], 99.0)
        self.assertEqual(by_slot["07:00"], 98.0)
        self.assertEqual(by_slot["05:45"], 2.0)
        self.assertEqual(by_slot["06:00"], 4.0)
        self.assertEqual(by_slot["23:45"], 2.0)
        # And the day comes out whole: 96 slots, no hole to draw around.
        self.assertEqual(sorted(by_slot), _all_slots())


class TestDateScopedBoundarySampler(unittest.IsolatedAsyncioTestCase):
    """The one read path both rails go through, freed of "today"."""

    def setUp(self):
        self.recorder = importlib.import_module(
            "custom_components.helman.recorder_hourly_series"
        )

    async def _sample(self, states, *, local_start, local_end):
        captured: dict[str, object] = {}

        def _fake_query(hass, start, end, entity_id, *args):
            captured["start"] = start
            captured["end"] = end
            return {entity_id: states}

        class _Recorder:
            @staticmethod
            async def async_add_executor_job(func):
                return func()

        with patch.object(
            self.recorder, "state_changes_during_period", _fake_query
        ), patch.object(self.recorder, "get_instance", lambda hass: _Recorder()):
            samples = await self.recorder.query_slot_boundary_state_values_for_range(
                object(),
                EXPORT_ENTITY,
                local_start=local_start,
                local_end=local_end,
                interval_minutes=15,
            )
        return samples, captured

    async def test_carries_the_last_state_forward_across_boundaries(self):
        # A price entity writes only when the price changes, so most boundaries
        # have no state of their own; each takes the last one written before it.
        states = [
            SimpleNamespace(
                last_updated=datetime(2026, 5, 10, 0, 0, tzinfo=PRAGUE), state="2.0"
            ),
            SimpleNamespace(
                last_updated=datetime(2026, 5, 10, 0, 30, tzinfo=PRAGUE), state="4.0"
            ),
        ]
        samples, captured = await self._sample(
            states,
            local_start=datetime(2026, 5, 10, 0, 0, tzinfo=PRAGUE),
            local_end=datetime(2026, 5, 10, 1, 0, tzinfo=PRAGUE),
        )

        self.assertEqual(
            {boundary.strftime("%H:%M"): value for boundary, value in samples.items()},
            {"00:00": 2.0, "00:15": 2.0, "00:30": 4.0, "00:45": 4.0},
        )
        # The read is bounded by the caller's window rather than running to now,
        # which is the whole difference from the today-scoped variant.
        self.assertEqual(captured["end"], datetime(2026, 5, 10, 1, 0, tzinfo=PRAGUE))

    async def test_a_write_just_after_the_boundary_belongs_to_that_slot(self):
        # The regression this sampler exists for. The import sensor publishes
        # from the quarter-hour refresh, so its write lands a few seconds after
        # the boundary whose price it carries. Taking the last state at or
        # before the boundary would hand 06:00 the 2.0 that expired there and
        # shift the whole change one slot late.
        states = [
            SimpleNamespace(
                last_updated=datetime(2026, 5, 10, 5, 45, 3, tzinfo=PRAGUE), state="2.0"
            ),
            SimpleNamespace(
                last_updated=datetime(2026, 5, 10, 6, 0, 3, tzinfo=PRAGUE), state="4.0"
            ),
        ]
        samples, _ = await self._sample(
            states,
            local_start=datetime(2026, 5, 10, 5, 45, tzinfo=PRAGUE),
            local_end=datetime(2026, 5, 10, 6, 30, tzinfo=PRAGUE),
        )

        self.assertEqual(
            {boundary.strftime("%H:%M"): value for boundary, value in samples.items()},
            {"05:45": 2.0, "06:00": 4.0, "06:15": 4.0},
        )

    async def test_the_first_write_in_a_slot_wins_over_a_later_one(self):
        # Two writes inside one slot: the slot is billed at the rate it opened
        # with, not at whatever happened to be written last before it closed.
        states = [
            SimpleNamespace(
                last_updated=datetime(2026, 5, 10, 0, 0, 2, tzinfo=PRAGUE), state="3.0"
            ),
            SimpleNamespace(
                last_updated=datetime(2026, 5, 10, 0, 11, tzinfo=PRAGUE), state="9.0"
            ),
        ]
        samples, _ = await self._sample(
            states,
            local_start=datetime(2026, 5, 10, 0, 0, tzinfo=PRAGUE),
            local_end=datetime(2026, 5, 10, 0, 30, tzinfo=PRAGUE),
        )

        self.assertEqual(
            {boundary.strftime("%H:%M"): value for boundary, value in samples.items()},
            {"00:00": 3.0, "00:15": 9.0},
        )

    async def test_an_empty_window_reads_nothing(self):
        samples, _ = await self._sample(
            [],
            local_start=datetime(2026, 5, 10, 0, 0, tzinfo=PRAGUE),
            local_end=datetime(2026, 5, 10, 0, 0, tzinfo=PRAGUE),
        )
        self.assertEqual(samples, {})


class TestLoadRecordedPriceRail(unittest.IsolatedAsyncioTestCase):
    def _make_service(self):
        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague"),
            bus=SimpleNamespace(async_fire=lambda *a, **kw: None),
        )
        return service_mod.SolarBiasCorrectionService(hass, _DummyStore(), _make_cfg())

    async def test_labels_boundary_samples_by_local_slot(self):
        service = self._make_service()
        samples = {
            datetime(2026, 5, 10, 6, 0, tzinfo=PRAGUE): 2.0,
            datetime(2026, 5, 10, 6, 15, tzinfo=PRAGUE): 4.0,
        }
        with patch.object(
            importlib.import_module("custom_components.helman.recorder_hourly_series"),
            "query_slot_boundary_state_values_for_range",
            AsyncMock(return_value=samples),
        ):
            points = await service._load_recorded_price_rail(
                EXPORT_ENTITY,
                date(2026, 5, 10),
                PRAGUE,
                local_end=datetime(2026, 5, 11, 0, 0, tzinfo=PRAGUE),
            )
        self.assertEqual(
            points,
            [{"slot": "06:00", "value": 2.0}, {"slot": "06:15", "value": 4.0}],
        )

    async def test_an_unconfigured_entity_reads_nothing(self):
        service = self._make_service()
        self.assertEqual(
            await service._load_recorded_price_rail(
                None,
                date(2026, 5, 10),
                PRAGUE,
                local_end=datetime(2026, 5, 11, 0, 0, tzinfo=PRAGUE),
            ),
            [],
        )


class _PayloadCase(unittest.IsolatedAsyncioTestCase):
    """Shared rigging for the payload-level rail tests."""

    def _make_service(
        self,
        *,
        import_config=None,
        export_entity: str | None = EXPORT_ENTITY,
        price_snapshot=None,
        export_entity_unit: str | None = None,
    ):
        states = {}
        if export_entity and export_entity_unit:
            states[export_entity] = SimpleNamespace(
                attributes={"unit_of_measurement": export_entity_unit}
            )
        hass = SimpleNamespace(
            config=SimpleNamespace(time_zone="Europe/Prague"),
            bus=SimpleNamespace(async_fire=lambda *a, **kw: None),
            states=SimpleNamespace(get=states.get),
        )
        service = service_mod.SolarBiasCorrectionService(
            hass,
            _DummyStore(),
            _make_cfg(),
            grid_export_price_entity_id_provider=lambda: export_entity,
            grid_import_price_config_provider=lambda: import_config,
            grid_price_snapshot_provider=lambda: price_snapshot or {},
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

    async def _payload(self, service, raw_date: str, *, recorded: dict[str, list[dict]]):
        """Run one inspector day with the recorder rails stubbed out.

        Every other series loader is stubbed to empty: this file is about the
        price rails, and leaving the energy loaders live would only add recorder
        stubs that say nothing about them.
        """

        async def _fake_rail(entity_id, target_date, local_tz, *, local_end):
            return recorded.get(entity_id, [])

        old_actuals = service_mod.load_actuals_for_day
        try:
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
                service, "_load_grid_actual_for_date", AsyncMock(return_value=([], [], []))
            ), patch.object(
                service, "_load_battery_actual_for_date", AsyncMock(return_value=[])
            ), patch.object(
                service,
                "_house_consumer_breakdown_for_date",
                Mock(return_value=([], [])),
            ), patch.object(
                service, "_load_recorded_price_rail", side_effect=_fake_rail
            ):
                return await service.async_get_inspector_day(raw_date)
        finally:
            service_mod.load_actuals_for_day = old_actuals

    @staticmethod
    def _by_slot(series: list[dict]) -> dict[str, float]:
        return {point["slot"]: point["value"] for point in series}


class TestTodayJoinsRecorderAndLiveFeed(_PayloadCase):
    async def test_the_two_halves_meet_at_the_running_slot_without_a_seam(self):
        # Recorder history through the slot in progress (10:00), live feed from
        # the same slot on: the overlap is where a naive concatenation would draw
        # 10:00 twice, and a strict split would drop it.
        elapsed = [_slot_label(index) for index in range(_slot_index("10:00") + 1)]
        service = self._make_service(price_snapshot=_live_snapshot(TODAY))
        payload = await self._payload(
            service,
            TODAY,
            recorded={
                IMPORT_ENTITY: _rail(elapsed, 5.0),
                EXPORT_ENTITY: _rail(elapsed, 0.5),
            },
        )

        import_rail = payload["series"]["importPrice"]
        export_rail = payload["series"]["exportPrice"]
        self.assertEqual([p["slot"] for p in import_rail], _all_slots())
        self.assertEqual([p["slot"] for p in export_rail], _all_slots())

        by_slot = self._by_slot(import_rail)
        self.assertEqual(by_slot["09:45"], 5.0)
        # The running slot is the recorder's, not the live feed's: both describe
        # it, and the recorded sample is what actually applied.
        self.assertEqual(by_slot["10:00"], 5.0)
        self.assertEqual(by_slot["10:15"], 9.0)
        self.assertEqual(self._by_slot(export_rail)["10:15"], 1.5)
        self.assertTrue(payload["availability"]["hasImportPrice"])
        self.assertTrue(payload["availability"]["hasExportPrice"])


class TestTodaysExportFeedBeatsTheRecorder(_PayloadCase):
    """The bug live validation caught: elapsed hours drawn as one flat value."""

    async def test_the_whole_day_feed_overrides_recorded_export_samples(self):
        # The sell-price entity's attributes carry the settled day-ahead
        # schedule for the *whole* day, elapsed hours included, while its
        # recorded state is only a sample of whichever hour was current when
        # Home Assistant happened to be running. Deferring to the recorder drew
        # every elapsed slot at one carried value.
        service = self._make_service(
            import_config=_import_config(),
            price_snapshot=_live_snapshot(TODAY, export_from="00:00"),
        )
        payload = await self._payload(
            service,
            TODAY,
            recorded={EXPORT_ENTITY: _rail(_all_slots(), 6.242)},
        )

        export_rail = self._by_slot(payload["series"]["exportPrice"])
        self.assertEqual(set(export_rail.values()), {1.5})
        self.assertNotIn(6.242, set(export_rail.values()))

    async def test_the_recorder_still_answers_the_slots_the_feed_misses(self):
        # A forward-only feed opened mid-morning: everything before it is the
        # recorder's, everything from it on is the feed's.
        service = self._make_service(
            import_config=_import_config(),
            price_snapshot=_live_snapshot(TODAY, export_from="10:00"),
        )
        payload = await self._payload(
            service,
            TODAY,
            recorded={EXPORT_ENTITY: _rail(_all_slots(), 6.242)},
        )

        export_rail = self._by_slot(payload["series"]["exportPrice"])
        self.assertEqual(export_rail["09:45"], 6.242)
        self.assertEqual(export_rail["10:00"], 1.5)
        self.assertEqual(export_rail["23:45"], 1.5)


class TestElapsedDayComesFromTheRecorder(_PayloadCase):
    async def test_a_fully_recorded_past_day_uses_no_fallback(self):
        service = self._make_service(import_config=_import_config())
        payload = await self._payload(
            service,
            PAST_DAY,
            recorded={
                IMPORT_ENTITY: _rail(_all_slots(), 7.0),
                EXPORT_ENTITY: _rail(_all_slots(), 0.9),
            },
        )

        import_rail = self._by_slot(payload["series"]["importPrice"])
        # 7.0 everywhere, so no slot silently took the config's 4.0/2.0 instead:
        # a recorded day reports what it cost, not what it would cost today.
        self.assertEqual(set(import_rail.values()), {7.0})
        self.assertEqual(set(self._by_slot(payload["series"]["exportPrice"]).values()), {0.9})
        self.assertEqual(payload["priceUnit"], "CZK/kWh")


class TestPartiallyCoveredDayFallsBackPerSlot(_PayloadCase):
    async def test_recorded_slots_stand_and_the_rest_come_from_config(self):
        # The shape of the day the sensor shipped: history from 08:00 on, nothing
        # before it. A per-day branch would render the whole day from config and
        # throw away the recorded half; the per-slot fill keeps both.
        covered = [_slot_label(index) for index in range(_slot_index("08:00"), 96)]
        service = self._make_service(import_config=_import_config())
        payload = await self._payload(
            service,
            PAST_DAY,
            recorded={IMPORT_ENTITY: _rail(covered, 7.0), EXPORT_ENTITY: []},
        )

        import_rail = self._by_slot(payload["series"]["importPrice"])
        self.assertEqual([p["slot"] for p in payload["series"]["importPrice"]], _all_slots())
        self.assertEqual(import_rail["05:45"], 2.0)
        self.assertEqual(import_rail["06:00"], 4.0)
        self.assertEqual(import_rail["07:45"], 4.0)
        self.assertEqual(import_rail["08:00"], 7.0)
        self.assertEqual(import_rail["23:45"], 7.0)
        # Export has no config to fall back on -- a spot price is not derivable --
        # so it stays absent rather than being invented.
        self.assertEqual(payload["series"]["exportPrice"], [])
        self.assertFalse(payload["availability"]["hasExportPrice"])


class TestUnconfiguredSides(_PayloadCase):
    async def test_no_sell_price_entity_still_renders_the_import_rail(self):
        service = self._make_service(
            import_config=_import_config(), export_entity=None
        )
        payload = await self._payload(service, PAST_DAY, recorded={})

        self.assertEqual(len(payload["series"]["importPrice"]), 96)
        self.assertTrue(payload["availability"]["hasImportPrice"])
        self.assertEqual(payload["series"]["exportPrice"], [])
        self.assertFalse(payload["availability"]["hasExportPrice"])

    async def test_no_import_windows_and_no_history_leaves_the_rail_empty(self):
        service = self._make_service(import_config=None, export_entity=None)
        payload = await self._payload(service, PAST_DAY, recorded={})

        self.assertEqual(payload["series"]["importPrice"], [])
        self.assertFalse(payload["availability"]["hasImportPrice"])
        self.assertIsNone(payload["priceUnit"])

    async def test_an_elapsed_day_takes_the_unit_off_the_sell_price_entity(self):
        # A past day builds no live snapshot, so with no import windows there is
        # no unit from either source the live path uses -- and the export bars
        # would be drawn as bare numbers. The entity the recorded rail came from
        # states its own unit.
        service = self._make_service(
            import_config=None, export_entity_unit="CZK/kWh"
        )
        payload = await self._payload(
            service, PAST_DAY, recorded={EXPORT_ENTITY: _rail(_all_slots(), 1.5)}
        )

        self.assertEqual(payload["priceUnit"], "CZK/kWh")

    async def test_the_unit_falls_back_to_the_live_export_channel(self):
        # With no import windows configured there is no unit from config, but the
        # export rail still needs one to label its bars.
        service = self._make_service(
            import_config=None, price_snapshot=_live_snapshot(TODAY)
        )
        payload = await self._payload(service, TODAY, recorded={})

        self.assertEqual(payload["priceUnit"], "CZK/kWh")
