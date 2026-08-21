"""The export price back-fill: what it computes, how far it walks, where it stops.

The month and year views price every exported kilowatt-hour off hourly long-term
statistics, and the configured sell-price entity typically has none -- it
declares no ``state_class``, so Home Assistant never compiles any. Helman's own
mirror fixes that from the day it ships; this back-fill is the one pass that
recovers whatever the recorder still holds of the source entity's raw states.

Four ways it could produce plausible numbers rather than an error, one test each:

* averaging the samples instead of weighting them by how long each stood, which
  is nearly right for a quiet hour and wrong by the whole step at exactly the
  hours the rate moves;
* walking forward, or writing the hours Home Assistant's own compiler owns, so
  that two writers contend for one row;
* restarting from scratch after an interruption instead of resuming from the
  persisted cursor;
* walking past the end of the source's history for ever, or stopping at some
  arbitrary cap short of it.

Faked at the API boundary -- ``state_changes_during_period``,
``async_import_statistics`` and ``Store`` -- so the module under test is really
exercised, in the style of ``test_inspector_span_aggregates.py``.
"""

from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]

PRAGUE = ZoneInfo("Europe/Prague")
#: The clock every test runs against.
NOW = datetime(2026, 5, 25, 10, 30, tzinfo=PRAGUE)

#: What ``state_changes_during_period`` hands back, as ``(instant, value)`` pairs
#: for the whole of the fake recorder's memory. Tests rewrite it in place.
SOURCE_STATES: list[tuple[datetime, object]] = []
#: Every window the back-fill read, in order.
HISTORY_CALLS: list[tuple[datetime, datetime]] = []
#: Every ``async_import_statistics`` call, as ``(metadata, rows)``.
IMPORTS: list[tuple[dict, list[dict]]] = []
#: What the compiler has already written for the mirror, keyed by UTC hour.
COMPILED_ROWS: dict[datetime, dict] = {}
#: The single fake ``Store``'s contents, so a test can seed or inspect a cursor.
STORED: dict[str, object] = {}


class _FakeState:
    def __init__(self, instant: datetime, value: object) -> None:
        self.state = value
        self.last_updated = instant


def _install_import_stubs() -> None:
    for name, path in [
        ("custom_components", ROOT / "custom_components"),
        ("custom_components.helman", ROOT / "custom_components" / "helman"),
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

    def _fake_state_changes_during_period(
        hass,
        start_time,
        end_time,
        entity_id,
        no_attributes=False,
        descending=False,
        limit=None,
        include_start_time_state=True,
    ):
        HISTORY_CALLS.append((start_time, end_time))
        inside = [
            _FakeState(instant, value)
            for instant, value in SOURCE_STATES
            if start_time <= instant < end_time
        ]
        # The real reader replays the state in force when the window opens, and
        # stamps it with its own ``last_updated`` -- from *before* the window.
        # Every carry-forward in the module under test depends on that, so the
        # fake has to do it too.
        if include_start_time_state:
            earlier = [
                (instant, value)
                for instant, value in SOURCE_STATES
                if instant < start_time
            ]
            if earlier:
                instant, value = max(earlier, key=lambda sample: sample[0])
                inside.insert(0, _FakeState(instant, value))
        return {entity_id: inside} if inside else {}

    history_mod = types.ModuleType("homeassistant.components.recorder.history")
    history_mod.state_changes_during_period = _fake_state_changes_during_period
    history_mod.get_significant_states = lambda *args, **kwargs: {}
    sys.modules["homeassistant.components.recorder.history"] = history_mod

    def _fake_statistics_during_period(
        hass, start_time, end_time, statistic_ids, period, units, types_
    ):
        rows = [
            {"start": hour.timestamp(), "end": hour.timestamp() + 3600.0, **row}
            for hour, row in sorted(COMPILED_ROWS.items())
            if start_time <= hour < end_time
        ]
        if not rows:
            return {}
        return {statistic_id: list(rows) for statistic_id in statistic_ids}

    def _fake_async_import_statistics(hass, metadata, statistics):
        IMPORTS.append((dict(metadata), [dict(row) for row in statistics]))

    statistics_mod = types.ModuleType("homeassistant.components.recorder.statistics")
    statistics_mod.statistics_during_period = _fake_statistics_during_period
    statistics_mod.async_import_statistics = _fake_async_import_statistics
    sys.modules["homeassistant.components.recorder.statistics"] = statistics_mod

    # The real models module is a plain TypedDict/IntEnum module with no
    # dependencies, but the package it lives in is stubbed above, so it is
    # restated here rather than imported through a half-real package.
    models_mod = types.ModuleType("homeassistant.components.recorder.models")
    models_mod.StatisticData = dict
    models_mod.StatisticMetaData = dict
    models_mod.StatisticMeanType = SimpleNamespace(NONE=0, ARITHMETIC=1, CIRCULAR=2)
    sys.modules["homeassistant.components.recorder.models"] = models_mod

    core_mod = types.ModuleType("homeassistant.core")
    core_mod.HomeAssistant = type("HomeAssistant", (), {})
    core_mod.callback = lambda func: func
    sys.modules["homeassistant.core"] = core_mod

    class _FakeStore:
        def __init__(self, hass, version, key) -> None:
            self.key = key

        async def async_load(self):
            return STORED.get(self.key)

        async def async_save(self, document):
            STORED[self.key] = document

    helpers_mod = types.ModuleType("homeassistant.helpers")
    helpers_mod.__path__ = []
    sys.modules["homeassistant.helpers"] = helpers_mod
    storage_mod = types.ModuleType("homeassistant.helpers.storage")
    storage_mod.Store = _FakeStore
    sys.modules["homeassistant.helpers.storage"] = storage_mod
    helpers_mod.storage = storage_mod

    util_mod = types.ModuleType("homeassistant.util")
    sys.modules["homeassistant.util"] = util_mod
    dt_mod = types.ModuleType("homeassistant.util.dt")
    dt_mod.now = lambda: NOW
    dt_mod.as_local = lambda value: value.astimezone(PRAGUE)
    dt_mod.as_utc = lambda value: value.astimezone(timezone.utc)
    sys.modules["homeassistant.util.dt"] = dt_mod
    util_mod.dt = dt_mod

    sys.modules.pop("custom_components.helman.grid_export_price_backfill", None)


_install_import_stubs()

import importlib  # noqa: E402

backfill = importlib.import_module("custom_components.helman.grid_export_price_backfill")

# The real walk pauses a second between chunks so the recorder's queue stays
# short. Nothing here is queued, and the pacing is not what these tests are
# about, so they run it flat out.
backfill._CHUNK_PAUSE_SECONDS = 0

SOURCE = "sensor.spot_sell_price"
MIRROR = "sensor.helman_grid_export_price"
#: The current hour in UTC -- the newest hour the back-fill may ever write to is
#: the one *before* this, because the compiler owns this one onward.
CURRENT_HOUR = NOW.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)


def _utc(raw: str) -> datetime:
    return datetime.fromisoformat(raw).astimezone(timezone.utc)


def _reset(states: list[tuple[datetime, object]], *, compiled=None, stored=None) -> None:
    SOURCE_STATES[:] = sorted(states, key=lambda sample: sample[0])
    HISTORY_CALLS.clear()
    IMPORTS.clear()
    COMPILED_ROWS.clear()
    COMPILED_ROWS.update(compiled or {})
    STORED.clear()
    STORED.update(stored or {})


async def _run(unit: str | None = "CZK/kWh") -> None:
    await backfill.async_backfill_grid_export_price_statistics(
        SimpleNamespace(),
        source_entity_id=SOURCE,
        unit_of_measurement=unit,
        target_entity_id=MIRROR,
    )


def _imported_rows() -> dict[datetime, dict]:
    """Every row written, keyed by its hour -- the walk's order is asserted apart."""
    return {row["start"]: row for _metadata, rows in IMPORTS for row in rows}


class TestTimeWeighting(unittest.IsolatedAsyncioTestCase):
    """A price holds until it changes, and the sensor writes far more often.

    The reference instance's sell-price entity writes ~440 times a day while the
    value steps once an hour. Averaging the samples is therefore *nearly* right
    for the hours nothing happened -- and wrong by the full step at the hours the
    rate moved, which are the only ones anybody would query.
    """

    async def test_an_hour_the_rate_changes_inside_is_weighted_by_duration(self):
        hour = CURRENT_HOUR - timedelta(hours=2)
        _reset(
            [
                # Held at 1.0 from before the hour began...
                (hour - timedelta(minutes=30), "1.0"),
                # ...then 5.0 for the last quarter of it. Fifteen samples of
                # the new price and one of the old would average to 4.75; the
                # truth is 0.75 x 1.0 + 0.25 x 5.0.
                (hour + timedelta(minutes=45), "5.0"),
                *(
                    (hour + timedelta(minutes=45, seconds=second), "5.0")
                    for second in range(1, 15)
                ),
            ]
        )

        await _run()

        row = _imported_rows()[hour]
        self.assertEqual(row["mean"], 2.0)
        self.assertEqual(row["min"], 1.0)
        self.assertEqual(row["max"], 5.0)

    async def test_an_hour_whose_first_reading_arrives_late_reports_that_reading(self):
        # The entity's very first state, ten minutes before the hour ended. The
        # recorder's own compiler shortens the period rather than stretching the
        # reading backward over time it did not apply to, and so does this.
        hour = CURRENT_HOUR - timedelta(hours=3)
        _reset([(hour + timedelta(minutes=50), "4.0")])

        await _run()

        self.assertEqual(_imported_rows()[hour]["mean"], 4.0)

    async def test_an_unavailable_stretch_leaves_the_previous_rate_standing(self):
        # What the recorder's compiler does with a non-numeric state: drops it,
        # so the previous reading keeps applying. A tariff does not stop being
        # the tariff because the integration reporting it lost its connection.
        hour = CURRENT_HOUR - timedelta(hours=4)
        _reset(
            [
                (hour - timedelta(minutes=5), "3.0"),
                (hour + timedelta(minutes=15), "unavailable"),
                (hour + timedelta(minutes=30), "unknown"),
                (hour + timedelta(minutes=45), "3.0"),
            ]
        )

        await _run()

        self.assertEqual(_imported_rows()[hour]["mean"], 3.0)

    async def test_an_hour_with_nothing_standing_in_it_is_omitted(self):
        # Two hours of history with a hole between them: the hole stays a hole
        # rather than being papered over with a rate nobody published.
        first = CURRENT_HOUR - timedelta(hours=6)
        _reset([(first + timedelta(minutes=10), "2.0")])

        await _run()

        written = _imported_rows()
        self.assertIn(first, written)
        # Hours before the entity's first state have nothing standing in them.
        self.assertNotIn(first - timedelta(hours=1), written)


class TestWalk(unittest.IsolatedAsyncioTestCase):
    async def test_it_walks_backward_in_chunks_and_stops_where_history_runs_out(self):
        oldest = CURRENT_HOUR - timedelta(days=10)
        _reset(
            [
                (oldest + timedelta(hours=index), str(float(index)))
                for index in range(0, 24 * 10, 6)
            ]
        )

        await _run()

        # Backward: every window ends where the previous one began.
        self.assertTrue(HISTORY_CALLS)
        self.assertEqual(HISTORY_CALLS[0][1], CURRENT_HOUR)
        for (start, _end), (_next_start, next_end) in zip(
            HISTORY_CALLS, HISTORY_CALLS[1:]
        ):
            self.assertEqual(start, next_end)
        # A week at a time.
        for start, end in HISTORY_CALLS:
            self.assertEqual(end - start, timedelta(days=7))
        # Ten days of history: two chunks reach it, the third finds nothing at
        # all and ends the walk rather than grinding back to the cap.
        self.assertEqual(len(HISTORY_CALLS), 3)
        written = _imported_rows()
        self.assertEqual(min(written), oldest)
        self.assertEqual(max(written), CURRENT_HOUR - timedelta(hours=1))
        self.assertTrue(STORED[backfill._STORAGE_KEY]["done"])

    async def test_it_never_writes_an_hour_home_assistant_already_compiled(self):
        # The mirror has been publishing for two days, so the compiler owns
        # every hour from there on. Writing into those rows would mean two
        # writers for one row; the walk has to start strictly before the oldest.
        first_compiled = CURRENT_HOUR - timedelta(days=2)
        _reset(
            [
                (CURRENT_HOUR - timedelta(days=5) + timedelta(hours=index), "2.0")
                for index in range(24 * 5)
            ],
            compiled={
                first_compiled + timedelta(hours=index): {"mean": 2.0}
                for index in range(24)
            },
        )

        await _run()

        self.assertEqual(HISTORY_CALLS[0][1], first_compiled)
        self.assertEqual(max(_imported_rows()), first_compiled - timedelta(hours=1))

    async def test_an_interrupted_run_resumes_from_the_persisted_cursor(self):
        resume_from = CURRENT_HOUR - timedelta(days=14)
        _reset(
            [
                (CURRENT_HOUR - timedelta(days=20) + timedelta(hours=index), "2.0")
                for index in range(24 * 20)
            ],
            stored={
                backfill._STORAGE_KEY: {
                    "version": backfill._STORAGE_VERSION,
                    "oldest_hour": resume_from.isoformat(),
                    "done": False,
                }
            },
        )

        await _run()

        # It picks up where it stopped rather than re-reading the fortnight it
        # already wrote.
        self.assertEqual(HISTORY_CALLS[0][1], resume_from)
        self.assertEqual(max(_imported_rows()), resume_from - timedelta(hours=1))

    async def test_a_finished_walk_is_not_repeated(self):
        _reset(
            [(CURRENT_HOUR - timedelta(hours=3), "2.0")],
            stored={
                backfill._STORAGE_KEY: {
                    "version": backfill._STORAGE_VERSION,
                    "oldest_hour": (CURRENT_HOUR - timedelta(days=30)).isoformat(),
                    "done": True,
                }
            },
        )

        await _run()

        self.assertEqual(HISTORY_CALLS, [])
        self.assertEqual(IMPORTS, [])

    async def test_a_source_with_no_history_at_all_costs_one_read(self):
        _reset([])

        await _run()

        self.assertEqual(len(HISTORY_CALLS), 1)
        self.assertEqual(IMPORTS, [])


class TestImportedMetadata(unittest.IsolatedAsyncioTestCase):
    """What ``async_import_statistics`` validates, and rejects outright.

    ``source`` has to be the *recorder's* domain rather than ``helman``: the
    series is an entity's, and lives in the recorder's own table. ``mean_type``
    and ``unit_class`` are passed explicitly because inferring them is
    deprecated and reports usage against this integration.
    """

    async def test_the_metadata_names_the_recorder_and_the_mirrors_unit(self):
        _reset([(CURRENT_HOUR - timedelta(hours=2), "2.0")])

        await _run()

        metadata, _rows = IMPORTS[0]
        self.assertEqual(
            metadata,
            {
                "mean_type": backfill.StatisticMeanType.ARITHMETIC,
                "has_sum": False,
                "name": None,
                "source": "recorder",
                "statistic_id": MIRROR,
                "unit_class": None,
                "unit_of_measurement": "CZK/kWh",
            },
        )

    async def test_every_row_starts_on_the_top_of_an_hour_in_utc(self):
        _reset(
            [
                (CURRENT_HOUR - timedelta(days=2) + timedelta(minutes=7 * index), "2.0")
                for index in range(400)
            ]
        )

        await _run()

        for _metadata, rows in IMPORTS:
            for row in rows:
                self.assertEqual(row["start"].tzinfo, timezone.utc)
                self.assertEqual(
                    (row["start"].minute, row["start"].second, row["start"].microsecond),
                    (0, 0, 0),
                )


if __name__ == "__main__":
    unittest.main()
