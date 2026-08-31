"""The solar bias window is spliced out of both recorder tables, at two grains.

Raw states are what ``purge_keep_days`` deletes; hourly long-term statistics are
not. The bias trainer read *both* of its inputs from raw states -- the meter for
the actual and Helman's own forecast sensor for the forecast -- so a
``max_training_window_days: 90`` trained on the eight days the recorder still
held (#173, #175).

Every test here stubs **both** recorder tables and makes them disagree on
purpose -- deep statistics, shallow states -- because that is the only
configuration the bug lives in and no fixture has it by default. Statistics are
hourly and this trainer works per fifteen-minute slot, so the tail is trained at
hourly resolution: one ratio per hour, given to each of that hour's four slots.
What must never happen is the opposite -- an hour's number presented as a
fifteen-minute measurement -- and most of what follows is that claim, tested.
"""

from __future__ import annotations

import importlib
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]


def _install_package_stubs() -> None:
    for name, path in [
        ("custom_components", ROOT / "custom_components"),
        ("custom_components.helman", ROOT / "custom_components" / "helman"),
    ]:
        pkg = sys.modules.get(name) or types.ModuleType(name)
        pkg.__path__ = [str(path)]
        sys.modules[name] = pkg


_install_package_stubs()

span_mod = importlib.import_module("custom_components.helman.recorder_statistics_span")
series_mod = importlib.import_module("custom_components.helman.recorder_hourly_series")
history_mod = importlib.import_module("homeassistant.components.recorder.history")
actuals_mod = importlib.import_module(
    "custom_components.helman.solar_bias_correction.actuals"
)
slot_history_mod = importlib.import_module(
    "custom_components.helman.solar_bias_correction.forecast_slot_history"
)
forecast_history_mod = importlib.import_module(
    "custom_components.helman.solar_bias_correction.forecast_history"
)
trainer_mod = importlib.import_module(
    "custom_components.helman.solar_bias_correction.trainer"
)
models_mod = importlib.import_module(
    "custom_components.helman.solar_bias_correction.models"
)

PRAGUE = ZoneInfo("Europe/Prague")
#: The clock every test runs against.
NOW = datetime(2026, 8, 27, 10, 0, tzinfo=PRAGUE)

METER = "sensor.solar_total_energy"
FORECAST = slot_history_mod.SOLAR_FORECAST_CURRENT_ENTITY
SOC = "sensor.battery_soc"
GRID = "sensor.grid_power"

#: What ``max_training_window_days: 90`` asks for, and what the recorder's two
#: tables actually hold on the instance #173 was written from.
WINDOW_DAYS = 90
RAW_STATE_DAYS = 8
STATISTICS_DAYS = 195

#: The modelled day: eight production hours, each of them four equal slots.
FIRST_PRODUCTION_HOUR = 8
LAST_PRODUCTION_HOUR = 15
SLOT_WH = 250.0
HOUR_WH = SLOT_WH * 4


def _local_midnight(days_ago: int) -> datetime:
    return NOW.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(
        days=days_ago
    )


def _is_production(local_hour: datetime) -> bool:
    return FIRST_PRODUCTION_HOUR <= local_hour.hour <= LAST_PRODUCTION_HOUR


class _Recorder:
    """One recorder, two tables, and a count of every read of either.

    Both tables describe the same modelled installation, so a spliced day can be
    checked against the same expectation whichever side of the seam it fell on.
    ``actual_scale`` is how the tests bend one against the other: a factor
    applied to the meter, per local hour, leaving the forecast alone.
    """

    def __init__(self) -> None:
        self.meter_states_from = _local_midnight(RAW_STATE_DAYS) + timedelta(hours=6)
        self.forecast_states_from = _local_midnight(RAW_STATE_DAYS) + timedelta(hours=6)
        self.statistics_from = _local_midnight(STATISTICS_DAYS)
        #: ``{local hour of day: factor}`` applied to the meter only.
        self.actual_scale: dict[int, float] = {}
        #: Hourly rows for the curtailment sensors: ``{entity: (min, max)}``.
        self.sensor_rows: dict[str, tuple[float, float]] = {}
        #: Raw states for the same sensors, flat: ``{entity: value}``. They
        #: begin where the meter's do, which is what makes a day the forecast
        #: sensor is hourly for still have state-grain evidence.
        self.sensor_states: dict[str, float] = {}
        self.statistics_calls: list[set[str]] = []
        self.state_reads: list[str] = []

    async def async_add_executor_job(self, func, *args):
        return func(*args)

    # -- the modelled installation --------------------------------------

    def _slot_wh(self, local_slot_start: datetime, *, actual: bool) -> float:
        if not _is_production(local_slot_start):
            return 0.0
        if not actual:
            return SLOT_WH
        return SLOT_WH * self.actual_scale.get(local_slot_start.hour, 1.0)

    def _meter_readings(self, since: datetime, *, step_minutes: int):
        """``(instant, cumulative kWh)`` on a fixed grid, oldest first.

        Stepped in UTC so a fall-back day gets its twenty-five hours, and
        cumulative because that is what the readers difference.

        A reading is what the meter had accumulated *before* its own instant, so
        differencing two of them gives the energy of the period that starts at
        the first -- the convention every reader in the component follows. Adding
        the period's energy before yielding instead would hand each period the
        one before it, and a modelled day would come back a slot early.
        """
        cursor = since.astimezone(timezone.utc)
        end = NOW.astimezone(timezone.utc)
        total = 1000.0
        while cursor <= end:
            yield cursor, total
            local = cursor.astimezone(PRAGUE)
            slot_start = local - timedelta(minutes=local.minute % 15)
            total += (
                self._slot_wh(slot_start, actual=True)
                * (step_minutes / 15.0)
                / 1000.0
            )
            cursor += timedelta(minutes=step_minutes)

    # -- the long-term statistics table ---------------------------------

    def statistics_during_period(
        self, hass, start_time, end_time, statistic_ids, period, units, types_
    ):
        self.statistics_calls.append(set(statistic_ids or ()))
        result: dict[str, list[dict]] = {}
        for entity_id in statistic_ids or ():
            rows = self._statistics_rows(entity_id, start_time, end_time)
            if rows:
                result[entity_id] = rows
        return result

    def _statistics_rows(self, entity_id, start_time, end_time) -> list[dict]:
        def _inside(instant: datetime) -> bool:
            return start_time <= instant and (end_time is None or instant < end_time)

        if entity_id == METER:
            # A statistics row carries the meter's reading at its hour's *end*,
            # which is what makes an hour's energy the difference between its own
            # row and the previous one. So each row is stamped with the hour it
            # starts and carries the reading taken an hour later.
            readings = list(
                self._meter_readings(self.statistics_from, step_minutes=60)
            )
            return [
                {"start": instant.timestamp(), "state": next_total}
                for (instant, _), (_, next_total) in zip(readings, readings[1:])
                if _inside(instant)
            ]
        if entity_id == FORECAST:
            # What ``solar_forecast_backfill`` writes: the hour's time-weighted
            # mean of a sensor whose state is the *current slot's* Wh -- and
            # then converted to kWh on the way out, because the span read asks
            # for the energy class in kWh and the sensor records Wh.
            rows = []
            cursor = self.statistics_from.astimezone(timezone.utc)
            end = NOW.astimezone(timezone.utc)
            while cursor <= end:
                if _inside(cursor):
                    mean_wh = self._slot_wh(cursor.astimezone(PRAGUE), actual=False)
                    rows.append({"start": cursor.timestamp(), "mean": mean_wh / 1000.0})
                cursor += timedelta(hours=1)
            return rows
        if entity_id in self.sensor_rows:
            low, high = self.sensor_rows[entity_id]
            rows = []
            cursor = self.statistics_from.astimezone(timezone.utc)
            end = NOW.astimezone(timezone.utc)
            while cursor <= end:
                if _inside(cursor):
                    rows.append(
                        {"start": cursor.timestamp(), "min": low, "max": high}
                    )
                cursor += timedelta(hours=1)
            return rows
        return []

    # -- the raw states table -------------------------------------------

    def state_changes_during_period(
        self, hass, start_time, end_time, entity_id, *args, **kwargs
    ):
        self.state_reads.append(entity_id)
        states = self._raw_states(entity_id, start_time, end_time, kwargs, args)
        limit = kwargs.get("limit")
        if limit is not None:
            states = states[:limit]
        return {entity_id: states} if states else {}

    def _raw_states(self, entity_id, start_time, end_time, kwargs, args):
        include_start = kwargs.get(
            "include_start_time_state", args[-1] if args else False
        )
        if entity_id == METER:
            readings = list(self._meter_readings(self.meter_states_from, step_minutes=15))
        elif entity_id == FORECAST:
            readings = list(self._forecast_states())
        elif entity_id in self.sensor_states:
            readings = list(self._flat_states(self.sensor_states[entity_id]))
        else:
            return []

        states = [
            _FakeState(value, instant)
            for instant, value in readings
            if start_time <= instant and (end_time is None or instant <= end_time)
        ]
        carried = [
            (instant, value)
            for instant, value in readings
            if instant < start_time
        ]
        if carried and include_start:
            instant, value = carried[-1]
            states.insert(0, _FakeState(value, instant))
        return states

    def _flat_states(self, value: float):
        """One reading per slot, unchanging, from where the meter's states do."""
        cursor = self.meter_states_from.astimezone(timezone.utc)
        end = NOW.astimezone(timezone.utc)
        while cursor <= end:
            yield cursor, value
            cursor += timedelta(minutes=15)

    def _forecast_states(self):
        """The forecast sensor's own history: the current slot's Wh, per slot."""
        cursor = self.forecast_states_from.astimezone(timezone.utc)
        end = NOW.astimezone(timezone.utc)
        while cursor <= end:
            yield cursor, self._slot_wh(cursor.astimezone(PRAGUE), actual=False)
            cursor += timedelta(minutes=15)

    def get_significant_states(self, hass, start, end, entity_ids, **kwargs):
        entity_id = entity_ids[0]
        states = self._raw_states(entity_id, start, end, kwargs, ())
        self.state_reads.append(entity_id)
        return {entity_id: states} if states else {}


class _FakeState:
    def __init__(self, value: float, when: datetime) -> None:
        self.state = str(value)
        self.last_updated = when
        self.last_changed = when
        self.attributes = {"unit_of_measurement": "kWh"}


def _make_hass(config: dict | None = None):
    async def _executor_job(func, *args):
        return func(*args)

    return SimpleNamespace(
        states=SimpleNamespace(get=lambda entity_id: None),
        config=SimpleNamespace(time_zone="Europe/Prague"),
        data={"helman": {"coordinator": SimpleNamespace(config=config or {})}},
        async_add_executor_job=_executor_job,
    )


class _FixedDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz or timezone.utc)


def _patches(recorder: _Recorder):
    """Point every reader at the fake recorder for the duration of a block."""
    return [
        patch.object(span_mod, "statistics_during_period", recorder.statistics_during_period),
        patch.object(span_mod, "get_instance", lambda hass: recorder),
        patch.object(series_mod, "get_instance", lambda hass: recorder),
        patch.object(
            series_mod, "state_changes_during_period", recorder.state_changes_during_period
        ),
        # The oldest-state probe imports this at call time, so it has to be
        # patched where it is looked up rather than where a reader bound it.
        patch.object(
            history_mod, "state_changes_during_period", recorder.state_changes_during_period
        ),
        patch.object(slot_history_mod, "get_instance", lambda hass: recorder),
        patch.object(
            slot_history_mod, "get_significant_states", recorder.get_significant_states
        ),
        patch.object(actuals_mod, "get_instance", lambda hass: recorder),
        patch.object(
            actuals_mod,
            "state_changes_during_period",
            recorder.state_changes_during_period,
        ),
        patch.object(actuals_mod, "datetime", _FixedDateTime),
        patch.object(actuals_mod.dt_util, "now", lambda: NOW),
    ]


def _cfg(**overrides):
    defaults = dict(
        enabled=True,
        min_history_days=1,
        training_time="03:00",
        clamp_min=0.0,
        clamp_max=5.0,
        daily_energy_entity_ids=[],
        total_energy_entity_id=METER,
        min_valid_slot_days=1,
        aggregation_method="ratio_of_sums",
        max_interpolated_consecutive_slots=0,
        max_training_window_days=WINDOW_DAYS,
        slot_invalidation_data_glitch_min_neighbour_forecast_wh=0.0,
    )
    defaults.update(overrides)
    return models_mod.BiasConfig(**defaults)


async def _train(recorder: _Recorder, cfg, *, hass=None):
    hass = hass or _make_hass()
    started = _patches(recorder)
    for item in started:
        item.start()
    try:
        samples = await forecast_history_mod.load_trainer_samples(hass, cfg, NOW)
        actuals = await actuals_mod.load_actuals_window(
            hass, cfg, days=cfg.max_training_window_days
        )
    finally:
        for item in started:
            item.stop()
    return samples, actuals, trainer_mod.train(samples, actuals, cfg, now=NOW)


class SplicedTrainingWindowTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_purged_window_trains_on_every_day_the_statistics_hold(self):
        """The bug itself: 8 days of states, 195 of statistics, 90 asked for."""
        recorder = _Recorder()

        samples, actuals, outcome = await _train(recorder, _cfg())

        self.assertEqual(len(samples), WINDOW_DAYS)
        self.assertEqual(outcome.metadata.usable_days, WINDOW_DAYS)
        self.assertEqual(outcome.metadata.last_outcome, "profile_trained")
        # Every day older than where the meter's raw states begin is hour-grain,
        # and the recent ones are not. The day the states begin *on* counts as
        # hour-grain too: they begin part-way through it, so the splice is the
        # midnight after and the whole day is served from statistics -- which is
        # the one day the arithmetic here would otherwise miss.
        self.assertEqual(
            len(actuals.hourly_grain_dates), WINDOW_DAYS - RAW_STATE_DAYS + 1
        )
        self.assertNotIn(str(NOW.date() - timedelta(days=1)), actuals.hourly_grain_dates)

    async def test_a_tail_day_matching_its_forecast_gives_factors_of_one(self):
        """An hour whose actual is exactly its forecast moves nothing."""
        recorder = _Recorder()

        _, _, outcome = await _train(recorder, _cfg())

        production_slots = [
            slot
            for slot in outcome.profile.factors
            if FIRST_PRODUCTION_HOUR <= int(slot[:2]) <= LAST_PRODUCTION_HOUR
        ]
        self.assertEqual(len(production_slots), 32)
        for slot in production_slots:
            self.assertAlmostEqual(outcome.profile.factors[slot], 1.0, places=6)

    async def test_one_underdelivering_hour_moves_only_its_own_four_slots(self):
        """The hour's ratio is not smeared across the day or re-shaped inside it."""
        recorder = _Recorder()
        recorder.actual_scale = {11: 0.5}

        _, _, outcome = await _train(recorder, _cfg())

        for minute in (0, 15, 30, 45):
            self.assertAlmostEqual(
                outcome.profile.factors[f"11:{minute:02d}"], 0.5, places=6
            )
        for slot in ("10:45", "12:00", "12:15", "09:30"):
            self.assertAlmostEqual(outcome.profile.factors[slot], 1.0, places=6)

    async def test_an_hour_grain_day_says_so_in_its_contribution_rows(self):
        """G3: an hour-derived ratio is never presented as a 15-minute one."""
        recorder = _Recorder()

        _, actuals, outcome = await _train(recorder, _cfg())

        rows = outcome.explainability.slots["11:15"].rows
        by_date = {row.date: row for row in rows if row.status == "included"}
        tail_day = sorted(actuals.hourly_grain_dates)[0]
        recent_day = str(NOW.date() - timedelta(days=2))
        self.assertEqual(by_date[tail_day].reason, "hourly_statistics_grain")
        self.assertIsNone(by_date[recent_day].reason)

    async def test_the_tail_costs_one_statistics_read_however_deep_it_is(self):
        """G4: the tail's cost stops growing with ``max_training_window_days``."""
        counts = {}
        for days in (30, WINDOW_DAYS):
            recorder = _Recorder()
            await _train(recorder, _cfg(max_training_window_days=days))
            counts[days] = (
                len(recorder.statistics_calls),
                len([entity for entity in recorder.state_reads if entity == METER]),
            )

        # One statistics read for the actuals tail and one for the forecast
        # tail, whichever depth is asked for; and the per-day raw reads stop at
        # the days raw states actually cover instead of running the full window.
        self.assertEqual(counts[30][0], counts[WINDOW_DAYS][0])
        self.assertEqual(counts[30][1], counts[WINDOW_DAYS][1])
        self.assertLessEqual(counts[WINDOW_DAYS][1], RAW_STATE_DAYS + 1)


class GrainEquivalenceTests(unittest.TestCase):
    """The precision claim, made explicit: what an hour-grain day keeps and loses."""

    def _fit(self, actuals_slots, *, hourly: bool):
        day = "2026-06-01"
        slot_forecast = {"07:00": 100.0, "07:15": 200.0, "07:30": 300.0, "07:45": 400.0}
        samples = [
            models_mod.TrainerSample(
                date=day,
                forecast_wh=sum(slot_forecast.values()),
                slot_forecast_wh=slot_forecast,
                hourly_grain=hourly,
            )
        ]
        actuals = models_mod.SolarActualsWindow(
            slot_actuals_by_date={day: actuals_slots},
            hourly_grain_dates={day} if hourly else set(),
        )
        return slot_forecast, trainer_mod.train(samples, actuals, _cfg(), now=NOW)

    def test_the_same_day_at_either_grain_gives_the_same_day_ratio(self):
        fine_slots = {"07:00": 50.0, "07:15": 200.0, "07:30": 300.0, "07:45": 400.0}
        forecast, fine = self._fit(fine_slots, hourly=False)
        _, hourly = self._fit({"07:00": sum(fine_slots.values())}, hourly=True)

        def _day_ratio(outcome):
            return sum(
                outcome.profile.factors[slot] * wh for slot, wh in forecast.items()
            ) / sum(forecast.values())

        self.assertAlmostEqual(_day_ratio(fine), 0.95, places=6)
        self.assertAlmostEqual(_day_ratio(hourly), 0.95, places=6)

        # What the hour grain costs is *within* the hour, and only that: the
        # 07:00 slot really delivered half of its forecast and the fine day says
        # so, where the hourly day spreads the hour's 5% shortfall over all four.
        self.assertAlmostEqual(fine.profile.factors["07:00"], 0.5, places=6)
        self.assertAlmostEqual(fine.profile.factors["07:45"], 1.0, places=6)
        for slot in forecast:
            self.assertAlmostEqual(hourly.profile.factors[slot], 0.95, places=6)

    def test_a_trimmed_mean_fit_gets_the_hour_ratio_for_each_slot_too(self):
        """The other aggregation reaches the same place by its own route."""
        day = "2026-06-01"
        slot_forecast = {"07:00": 100.0, "07:15": 200.0, "07:30": 300.0, "07:45": 400.0}
        samples = [
            models_mod.TrainerSample(
                date=day,
                forecast_wh=1000.0,
                slot_forecast_wh=slot_forecast,
                hourly_grain=True,
            )
        ]
        actuals = models_mod.SolarActualsWindow(
            slot_actuals_by_date={day: {"07:00": 950.0}},
            hourly_grain_dates={day},
        )

        outcome = trainer_mod.train(
            samples, actuals, _cfg(aggregation_method="trimmed_mean"), now=NOW
        )

        for slot in slot_forecast:
            self.assertAlmostEqual(outcome.profile.factors[slot], 0.95, places=6)


class HourGrainCurtailmentTests(unittest.IsolatedAsyncioTestCase):
    """Curtailment on the tail, where the evidence is an hourly row's min/max."""

    def _hass(self, *, inverted: bool):
        # The polarity lives on the entity map, named for what a positive
        # reading *means* rather than as an ``inverted`` flag -- see
        # ``power_polarity``.
        grid: dict = {"entities": {"power": GRID}}
        if inverted:
            grid["entities"]["power_polarity"] = "positive_is_import"
        return _make_hass(
            {
                "power_devices": {
                    "battery": {"entities": {"capacity": SOC}},
                    "grid": grid,
                }
            }
        )

    async def _window(self, *, inverted: bool, export_w: float):
        recorder = _Recorder()
        # A battery at the threshold all hour, and a grid that never exported.
        recorder.sensor_rows[SOC] = (95.0, 96.0)
        recorder.sensor_rows[GRID] = (
            (-export_w, 0.0) if inverted else (0.0, export_w)
        )
        # Every hour underdelivers against its forecast, which is rule (3).
        recorder.actual_scale = {hour: 0.4 for hour in range(24)}

        cfg = _cfg(
            slot_invalidation_max_battery_soc_percent=90.0,
            slot_invalidation_curtailment_max_export_w=50.0,
            slot_invalidation_curtailment_max_actual_forecast_ratio=0.8,
        )
        started = _patches(recorder)
        for item in started:
            item.start()
        try:
            return await actuals_mod.load_actuals_window(
                self._hass(inverted=inverted), cfg, days=WINDOW_DAYS
            )
        finally:
            for item in started:
                item.stop()

    async def test_a_curtailed_hour_invalidates_its_four_slots(self):
        window = await self._window(inverted=False, export_w=10.0)

        tail_day = sorted(window.hourly_grain_dates)[0]
        invalidated = window.invalidated_slots_by_date[tail_day]
        self.assertTrue(
            {"11:00", "11:15", "11:30", "11:45"} <= invalidated,
            invalidated,
        )

    async def test_an_inverted_grid_sensor_invalidates_identically(self):
        """The row's ``min`` negated is the export peak; reading ``max`` there
        would turn "never exported" into "exported all hour" and stop the rule
        firing at all."""
        upright = await self._window(inverted=False, export_w=10.0)
        inverted = await self._window(inverted=True, export_w=10.0)

        self.assertEqual(
            {day: sorted(slots) for day, slots in upright.invalidated_slots_by_date.items()},
            {day: sorted(slots) for day, slots in inverted.invalidated_slots_by_date.items()},
        )
        self.assertTrue(inverted.invalidated_slots_by_date)

    async def test_a_freely_exporting_hour_is_left_alone(self):
        """Rule (2) still has to hold: energy that left had somewhere to go."""
        window = await self._window(inverted=True, export_w=4000.0)

        self.assertEqual(window.invalidated_slots_by_date, {})


class SplitHorizonTests(unittest.IsolatedAsyncioTestCase):
    """The two horizons need not agree, and the younger one is the forecast's.

    Helman's forecast sensor is typically the newer entity, so the ordinary
    shape of the window is a band of days whose actuals are still fifteen-minute
    while their forecast is already hourly. Those days are judged per hour --
    the coarser side wins -- but they still have raw states for every sensor,
    and both halves of that have gone wrong before.
    """

    #: Where the forecast sensor's own states begin: four days back, against the
    #: meter's eight. Days 7 through 4 are the split band.
    FORECAST_STATE_DAYS = 4
    SPLIT_BAND_DAY = 5

    def _hass(self):
        return _make_hass(
            {
                "power_devices": {
                    "battery": {"entities": {"capacity": SOC}},
                    "grid": {"entities": {"power": GRID}},
                }
            }
        )

    async def _window(self, *, export_w: float, actual_scale: float):
        recorder = _Recorder()
        recorder.forecast_states_from = _local_midnight(
            self.FORECAST_STATE_DAYS
        ) + timedelta(hours=6)
        # A battery at the threshold and a grid exporting whatever the case
        # under test needs, as raw states rather than as statistics rows.
        recorder.sensor_states = {SOC: 96.0, GRID: export_w}
        recorder.sensor_rows = {SOC: (95.0, 96.0), GRID: (0.0, export_w)}
        recorder.actual_scale = {hour: actual_scale for hour in range(24)}

        cfg = _cfg(
            slot_invalidation_max_battery_soc_percent=90.0,
            slot_invalidation_curtailment_max_export_w=50.0,
            slot_invalidation_curtailment_max_actual_forecast_ratio=0.8,
        )
        started = _patches(recorder)
        for item in started:
            item.start()
        try:
            return await actuals_mod.load_actuals_window(
                self._hass(), cfg, days=WINDOW_DAYS
            )
        finally:
            for item in started:
                item.stop()

    def _split_band_day(self) -> str:
        return str(NOW.date() - timedelta(days=self.SPLIT_BAND_DAY))

    async def test_a_split_band_day_is_judged_per_hour_but_read_from_states(self):
        """Its evidence is raw states; looking for statistics rows finds none.

        The tail read stops at the *meter's* splice, so a day past it has no row
        for any sensor. Sourcing the samples off the grid the day is judged on
        would find nothing here and quietly retire curtailment for the whole
        band.
        """
        window = await self._window(export_w=10.0, actual_scale=0.4)

        day = self._split_band_day()
        self.assertNotIn(day, window.hourly_grain_dates)
        self.assertTrue(
            {"11:00", "11:15", "11:30", "11:45"}
            <= window.invalidated_slots_by_date.get(day, set()),
            window.invalidated_slots_by_date.get(day),
        )

    async def test_a_healthy_split_band_day_is_left_alone(self):
        """The fold, pinned: an hour's actual against an hour's forecast.

        The day's actuals are fifteen-minute and its forecast is hourly, so
        without folding the actuals onto the same grid rule (3) would compare
        one quarter of the hour against the whole of it, read every hour as
        having delivered a quarter of its forecast, and invalidate a day on
        which nothing whatsoever happened.
        """
        window = await self._window(export_w=10.0, actual_scale=1.0)

        self.assertEqual(window.invalidated_slots_by_date.get(self._split_band_day()), None)


class HourlyPeakLookupTests(unittest.TestCase):
    """The hour asked about is local; the rows are stamped on whole UTC hours."""

    def _samples(self, local_tz: str):
        hour_start = datetime(
            2026, 6, 1, 11, 0, tzinfo=ZoneInfo(local_tz)
        ).astimezone(timezone.utc)
        rows = {
            hour_start.replace(minute=0) + timedelta(hours=offset): {
                "max": 10.0 * (offset + 1)
            }
            for offset in (0, 1)
        }
        return actuals_mod._hourly_peak_samples(
            rows, [hour_start], peak=actuals_mod._row_max
        )

    def test_a_whole_hour_offset_reads_its_one_row(self):
        self.assertEqual(self._samples("Europe/Prague")[0].value, 10.0)

    def test_a_half_hour_offset_reads_both_rows_it_lies_across(self):
        """India, Nepal and parts of Australia. Looking the hour up by its own
        instant finds no row there at all, so every tail hour reads as no
        evidence and curtailment invalidation silently stops firing."""
        self.assertEqual(self._samples("Asia/Kolkata")[0].value, 20.0)


if __name__ == "__main__":
    unittest.main()
