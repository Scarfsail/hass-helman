"""The EV charging ledger (#428): detection, replay, boundary energy, the store, attribution and the 30-day view.

The recorder is faked at ``read_states``, the ledger's one read: it answers the
rows inside the window and, like the recorder's ``include_start_time_state``,
the last row before it restamped at the window's start. The house dataset is
a stand-in holding just what ``attribute_energy`` reads.
"""

from __future__ import annotations

import asyncio
import json
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace as NS
from unittest.mock import patch
from zoneinfo import ZoneInfo

import pytest
from homeassistant.util import dt as dt_util

from custom_components.helman.device_reports.dataset import ChargeOrigin, HourMix
from custom_components.helman.ev_sessions import service as service_module
from custom_components.helman.ev_sessions.service import EvSessionService, TrackedCharger
from custom_components.helman.node_details.ev_charger import charging_intervals, charging_runs
from custom_components.helman.vendors import PROFILES
from tests._fakes import DummyStore

PRAGUE = ZoneInfo("Europe/Prague")
UTC = timezone.utc
RUN_MODE = "sensor.solax_ev_charger_run_mode"
METER = "sensor.solax_ev_charger_charge_added_total"
SESSION = "sensor.solax_ev_charger_charge_added"
CONDITIONS = PROFILES["solax_ev_charger"].run_mode_conditions
CHARGER = "garage-ev"
STORE = "custom_components.helman.ev_sessions.store.storage.Store"


@pytest.fixture(autouse=True)
def prague():
    previous = dt_util.get_default_time_zone()
    dt_util.set_default_time_zone(PRAGUE)
    yield
    dt_util.set_default_time_zone(previous)


def at(day: int, hour: int, minute: int = 0, month: int = 10) -> datetime:
    """A UTC instant in 2026."""
    return datetime(2026, month, day, hour, minute, tzinfo=UTC)


def row(state: str, when: datetime, unit: str | None = None):
    return NS(state=state, last_changed=when, last_updated=when,
              attributes={} if unit is None else {"unit_of_measurement": unit})


def run_mode(*changes: tuple[str, datetime]) -> list:
    return [row(state, when) for state, when in changes]


def meter(*points: tuple[datetime, float], step=timedelta(minutes=5)) -> list:
    """Meter rows linear between ``points``, a row every ``step`` while it rises."""
    rows = []
    for (start, low), (end, high) in zip(points, points[1:]):
        when = start
        while when < end:
            value = low + (high - low) * (when - start) / (end - start)
            rows.append(row(f"{value:.4f}", when, "kWh"))
            when += step if high > low else end - start
    last_at, last_value = points[-1]
    rows.append(row(f"{last_value:.4f}", last_at, "kWh"))
    return rows


class Recorder:
    """``read_states`` over fixed rows; ``fail`` makes every read raise."""

    def __init__(self, history: dict[str, list]):
        self.history = history
        self.fail = False
        self.reads: list[tuple[str, datetime, datetime]] = []

    async def read_states(self, hass, ids, start, end, *, include_start_state=True, no_attributes=True, strict=False):
        assert strict, "the ledger must never take a failure for an empty stretch"
        if self.fail:
            raise RuntimeError("recorder down")
        result = {}
        for entity_id in ids:
            self.reads.append((entity_id, start, end))
            rows = sorted(self.history.get(entity_id, []), key=lambda item: item.last_updated)
            before = [item for item in rows if item.last_updated < start]
            within = [item for item in rows if start <= item.last_updated < end]
            if include_start_state and before:
                carried = before[-1]
                within = [NS(state=carried.state, last_changed=start, last_updated=start, attributes=carried.attributes), *within]
            result[entity_id] = within
        return result


def dataset(*, hours=(), mix=None, import_rate=None, export_rate=None, origin=None, complete=True):
    """What ``attribute_energy`` reads of a day's dataset."""
    mix = mix or HourMix(solar=0.5, battery=0.0, grid=0.5, unattributed=0.0, ambiguous_kwh=0.0, mismatch_kwh=0.0)
    return NS(
        mix={hour: mix for hour in hours} if not isinstance(mix, dict) else mix,
        charge_origin=origin or ChargeOrigin(),
        import_rate=import_rate if import_rate is not None else {hour: 4.0 for hour in hours},
        import_rate_source={},
        export_rate=export_rate if export_rate is not None else {hour: 1.0 for hour in hours},
        complete=complete,
    )


def every_hour(start: datetime, end: datetime) -> list[datetime]:
    hours, hour = [], start.replace(minute=0)
    while hour < end:
        hours.append(hour)
        hour += timedelta(hours=1)
    return hours


class Harness:
    """One ledger service over a faked recorder, live states and house datasets."""

    def __init__(self, history: dict[str, list], *, datasets=None, live=None, meter_entity=METER, stored=None):
        self.recorder = Recorder(history)
        self.datasets = datasets if datasets is not None else {}
        self.dataset_calls: list[date] = []
        self.live = dict(live or {})
        self.task_names: list[str] = []
        hass = NS(states=NS(get=self.live.get), async_create_background_task=self._background)
        with patch(STORE, DummyStore):
            self.service = EvSessionService(hass, read_config=lambda: {}, day_dataset=self._dataset)
        self.service.store._store._data = stored
        self.service.chargers = {
            CHARGER: TrackedCharger(CHARGER, RUN_MODE, meter_entity, CONDITIONS),
        }
        self.oldest = None

    def _background(self, coro, name):
        self.task_names.append(name)
        return asyncio.ensure_future(coro)

    async def _dataset(self, day: date):
        self.dataset_calls.append(day)
        found = self.datasets.get(day) if not callable(self.datasets) else self.datasets(day)
        if isinstance(found, Exception):
            raise found
        return found

    def run(self, coro):
        async def _run():
            with patch.object(service_module, "read_states", self.recorder.read_states), patch(
                "custom_components.helman.recorder_statistics_span.query_oldest_state_date",
                side_effect=self._oldest,
            ):
                if self.service.store.chargers == {} and self.service.store._store._data is not None:
                    await self.service.store.async_load()
                return await coro
        return asyncio.run(_run())

    async def _oldest(self, hass, entity_id, *, local_tz):
        return self.oldest

    def history(self, now: datetime) -> dict:
        return self.run(self.service.async_history(CHARGER, now))

    def backfill(self, now: datetime) -> None:
        with patch.object(service_module.dt_util, "utcnow", return_value=now):
            self.run(self.service.async_backfill(CHARGER))

    @property
    def segments(self):
        return self.service.store.ledger(CHARGER).segments

    def stored(self):
        return json.loads(json.dumps(self.service.store._store._data))


def bounds(payload_segments):
    return [(item["start"], item["end"], item["status"]) for item in payload_segments]


def live_run_mode(state: str, since: datetime):
    return {RUN_MODE: row(state, since)}


# --- Detection --------------------------------------------------------------------


def test_todays_segments_are_the_segment_sections_charging_stretches():
    # Local midnight is 22:00 UTC the day before.
    states = run_mode(
        ("Available", at(10, 5)),
        ("Charging", at(10, 6)),
        ("unavailable", at(10, 6, 30)), ("Charging", at(10, 6, 35)),  # a short blip: bridged
        ("SuspendedEV", at(10, 7, 30)),  # a pause: a new segment follows
        ("Charging", at(10, 9)),
        ("unavailable", at(10, 9, 30)),  # a long gap: the end is not recorded
        ("Charging", at(10, 9, 50)),
    )
    now = at(10, 12)
    harness = Harness({RUN_MODE: states}, live=live_run_mode("Charging", at(10, 9, 50)))

    payload = harness.history(now)

    day_start = at(9, 22)
    stretches = charging_intervals(states, CONDITIONS, day_start, now)
    assert [(s.start, s.end, s.active) for s in harness.segments] == stretches
    assert [(s.start_known, s.end_known) for s in harness.segments] == [(True, True), (True, False), (False, False)]
    newest = payload["segments"][0]
    assert newest["status"] == "active" and newest["startKnown"] is False
    assert payload["segments"][1]["endKnown"] is False


def test_repeated_identical_states_change_nothing():
    states = run_mode(("Available", at(10, 5)), ("Charging", at(10, 6)), ("Charging", at(10, 6, 20)), ("Available", at(10, 7)))
    harness = Harness({RUN_MODE: states})

    harness.history(at(10, 12))

    assert [(s.start, s.end) for s in harness.segments] == [(at(10, 6), at(10, 7))]


def test_a_charge_entered_or_left_through_a_restart_gap_keeps_its_stretch_but_not_its_bound():
    # HA down 09:30-10:30 UTC: at startup the run mode is unavailable for seconds.
    restart, settled = at(10, 10, 30), at(10, 10, 30) + timedelta(seconds=20)
    now = at(10, 12)
    started = run_mode(("Available", at(10, 9)), ("unavailable", restart), ("Charging", settled), ("Available", at(10, 11)))
    ended = run_mode(("Available", at(10, 8)), ("Charging", at(10, 9)), ("unavailable", restart), ("Available", settled))

    assert [(r.start, r.end, r.start_known, r.end_known) for r in charging_runs(started, CONDITIONS, now)] == [
        (settled, at(10, 11), False, True),
    ]
    assert [(r.start, r.end, r.start_known, r.end_known) for r in charging_runs(ended, CONDITIONS, now)] == [
        (at(10, 9), restart, True, False),
    ]
    # The stretches the Schedule strip draws are unchanged.
    assert charging_intervals(started, CONDITIONS, at(10, 0), now) == [(settled, at(10, 11), False)]
    assert charging_intervals(ended, CONDITIONS, at(10, 0), now) == [(at(10, 9), restart, False)]


# --- Energy -----------------------------------------------------------------------


def test_two_segments_in_one_hour_count_only_their_own_energy():
    states = run_mode(
        ("Available", at(10, 9)), ("Charging", at(10, 10, 5)), ("SuspendedEV", at(10, 10, 20)),
        ("Charging", at(10, 10, 35)), ("Available", at(10, 10, 50)),
    )
    # 1.0 kWh, a pause that delivers nothing, then 2.0 kWh: 3.0 in the hour.
    energy = meter((at(10, 10, 5), 100.0), (at(10, 10, 20), 101.0), (at(10, 10, 35), 101.0), (at(10, 10, 50), 103.0))
    harness = Harness({RUN_MODE: states, METER: [row("100.0", at(10, 8), "kWh"), *energy]})

    payload = harness.history(at(10, 12))

    assert [round(item["kwh"], 6) for item in payload["segments"]] == [2.0, 1.0]
    assert payload["totals"]["kwh"] == pytest.approx(3.0)
    # The hardware's resetting session counter is never read.
    assert {entity_id for entity_id, *_ in harness.recorder.reads} == {RUN_MODE, METER}


def test_a_meter_reset_inside_a_segment_follows_the_shared_unwrap_convention():
    states = run_mode(("Available", at(10, 9)), ("Charging", at(10, 10)), ("Available", at(10, 11)))
    energy = [
        row("9000.0", at(10, 9), "kWh"), row("9000.5", at(10, 10, 10), "kWh"), row("9001.0", at(10, 10, 20), "kWh"),
        # The counter restarts from zero and climbs on.
        row("0.0", at(10, 10, 30), "kWh"), row("0.5", at(10, 10, 40), "kWh"), row("1.0", at(10, 10, 55), "kWh"),
    ]
    harness = Harness({RUN_MODE: states, METER: energy})

    payload = harness.history(at(10, 12))

    assert payload["segments"][0]["kwh"] == pytest.approx(2.0)


def test_a_segment_is_split_at_hours_and_local_midnight_and_listed_under_its_start_day():
    # 23:30–01:30 Prague local: 21:30–23:30 UTC; local midnight is 22:00 UTC.
    states = run_mode(("Available", at(9, 20)), ("Charging", at(9, 21, 30)), ("Available", at(9, 23, 30)))
    energy = meter((at(9, 21, 30), 10.0), (at(9, 23, 30), 14.0))
    harness = Harness({RUN_MODE: states, METER: [row("10.0", at(9, 20), "kWh"), *energy]})
    harness.service.store.ledger(CHARGER).live_since = at(9, 12)

    payload = harness.history(at(10, 12))

    slices = harness.segments[0].slices
    assert [(item.start, item.end) for item in slices] == [
        (at(9, 21, 30), at(9, 22)), (at(9, 22), at(9, 23)), (at(9, 23), at(9, 23, 30)),
    ]
    assert [round(item.kwh, 6) for item in slices] == [1.0, 2.0, 1.0]
    assert payload["segments"][0]["localDate"] == "2026-10-09"
    assert payload["chargingDays"] == 1


def test_a_repeated_dst_hour_is_two_distinct_utc_slices():
    # 2026-10-25 Prague falls back at 03:00 CEST: 00:00–02:00 UTC both read 02:xx locally.
    states = run_mode(("Available", at(24, 23)), ("Charging", at(25, 0, 30)), ("Available", at(25, 1, 30)))
    energy = meter((at(25, 0, 30), 5.0), (at(25, 1, 30), 7.0))
    harness = Harness({RUN_MODE: states, METER: [row("5.0", at(24, 23), "kWh"), *energy]})

    harness.history(at(25, 12))

    slices = harness.segments[0].slices
    assert [item.hour for item in slices] == [at(25, 0), at(25, 1)]
    assert [round(item.kwh, 6) for item in slices] == [1.0, 1.0]
    assert {dt_util.as_local(item.start).hour for item in slices} == {2}


def test_a_meter_gap_is_missing_energy_never_zero_and_the_end_gap_a_lower_bound():
    states = run_mode(("Available", at(10, 7)), ("Charging", at(10, 8)), ("unavailable", at(10, 11)))
    # The meter stops reporting at 08:30, and the charger goes offline at 11:00.
    energy = [row("50.0", at(10, 7), "kWh"), *meter((at(10, 8), 50.0), (at(10, 8, 30), 52.0))]
    harness = Harness({RUN_MODE: states, METER: energy})

    payload = harness.history(at(10, 13))

    slices = harness.segments[0].slices
    assert slices[0].kwh == pytest.approx(2.0)
    # By 11:00 the 08:30 reading is older than the staleness limit: unknown, not zero.
    assert slices[-1].kwh is None
    segment = payload["segments"][0]
    assert segment["endKnown"] is False and segment["kwhComplete"] is False
    assert segment["kwh"] == pytest.approx(2.0)


# --- Replay, restart, reload, purge -----------------------------------------------


def charging_history():
    states = run_mode(("Available", at(10, 7)), ("Charging", at(10, 8)), ("Available", at(10, 10)))
    energy = [row("20.0", at(10, 7), "kWh"), *meter((at(10, 8), 20.0), (at(10, 10), 26.0))]
    return states, energy


def test_replaying_twice_restarting_during_charging_and_reloading_keep_identity_and_totals():
    states, energy = charging_history()
    # Read at 09:00 while charging: the active segment as far as it went.
    early = {RUN_MODE: [item for item in states if item.last_changed <= at(10, 9)], METER: [item for item in energy if item.last_updated <= at(10, 9)]}
    harness = Harness(early, live=live_run_mode("Charging", at(10, 8)))
    first = harness.history(at(10, 9))
    again = harness.history(at(10, 9))
    assert len(harness.segments) == 1
    assert first["segments"] == again["segments"]
    assert first["segments"][0]["status"] == "active"
    assert first["totals"]["provisional"] is True
    segment_id = harness.segments[0].id

    # Home Assistant restarts at 09:00 and the charge ends at 10:00: the stored segment goes on.
    restarted = Harness({RUN_MODE: states, METER: energy}, live=live_run_mode("Available", at(10, 10)), stored=harness.stored())
    payload = restarted.history(at(10, 12))
    replayed = restarted.history(at(10, 12))

    assert [segment.id for segment in restarted.segments] == [segment_id]
    assert payload["segments"] == replayed["segments"]
    assert payload["segments"][0]["status"] == "closed"
    assert payload["totals"]["kwh"] == pytest.approx(6.0)
    assert payload["totals"]["provisional"] is False


def test_a_charge_carried_in_at_startup_is_partial_until_backfill_recovers_its_start():
    # Charging since 23:30 local yesterday (21:30 UTC); the ledger starts today.
    states = run_mode(("Available", at(9, 20)), ("Charging", at(9, 21, 30)), ("Available", at(10, 2)))
    energy = [row("0.0", at(9, 20), "kWh"), *meter((at(9, 21, 30), 0.0), (at(10, 2), 9.0))]
    harness = Harness({RUN_MODE: states, METER: energy})
    now = at(10, 12)

    harness.history(now)
    assert len(harness.segments) == 1
    partial = harness.segments[0]
    # Not the startup time, and not a recorded start.
    assert partial.start_known is False and partial.start < at(9, 22)
    segment_id = partial.id

    harness.oldest = date(2026, 10, 8)
    harness.backfill(now)
    harness.backfill(now)  # done: nothing read twice

    assert [(s.id, s.start, s.start_known, s.end) for s in harness.segments] == [(segment_id, at(9, 21, 30), True, at(10, 2))]
    assert harness.segments[0].kwh == pytest.approx(9.0)
    payload = harness.history(now)
    assert payload["health"]["backfill"] == {"status": "done", "recoveredDays": 2}
    assert payload["health"]["recordedSince"] == at(7, 22).isoformat()


def test_a_carried_in_start_of_the_segment_still_charging_stays_put_across_live_reads():
    # Charging since 18:00 UTC yesterday; the ledger starts at local midnight (22:00 UTC).
    states = run_mode(("Available", at(9, 17)), ("Charging", at(9, 18)))
    harness = Harness({RUN_MODE: states}, live=live_run_mode("Charging", at(9, 18)))
    harness.history(at(10, 0))
    [segment] = harness.segments
    carried = segment.start
    assert segment.start_known is False

    for minute in (15, 30, 45):
        harness.history(at(10, 0, minute))

    [segment] = harness.segments
    assert (segment.start, segment.start_known, segment.active) == (carried, False, True)

    # Backfill still recovers the recorded start.
    harness.oldest = date(2026, 10, 9)
    harness.backfill(at(10, 1))
    [segment] = harness.segments
    assert (segment.start, segment.start_known) == (at(9, 18), True)
    harness.history(at(10, 1, 15))
    assert (harness.segments[0].start, harness.segments[0].start_known) == (at(9, 18), True)


def test_backfill_reads_older_days_newest_first_and_carries_open_segments_across_them():
    states = run_mode(
        ("Available", at(7, 10)), ("Charging", at(7, 12)), ("Available", at(7, 13)),
        ("Charging", at(8, 21)), ("Available", at(9, 1)),  # across local midnight
    )
    harness = Harness({RUN_MODE: states})
    now = at(10, 12)
    harness.history(now)
    harness.oldest = date(2026, 10, 6)

    harness.backfill(now)

    run_mode_reads = [start for entity_id, start, _ in harness.recorder.reads if entity_id == RUN_MODE]
    assert run_mode_reads[1:] == sorted(run_mode_reads[1:], reverse=True)
    assert [(s.start, s.end, s.start_known, s.end_known) for s in harness.segments] == [
        (at(7, 12), at(7, 13), True, True), (at(8, 21), at(9, 1), True, True),
    ]


def test_backfill_past_the_live_read_never_ends_the_segment_still_charging():
    # Charging since 23:00 local; the ledger starts at local midnight (22:00 UTC).
    states = run_mode(("Available", at(9, 20)), ("Charging", at(9, 21)))
    harness = Harness({RUN_MODE: states}, live=live_run_mode("Charging", at(9, 21)))
    harness.history(at(9, 22, 5))
    harness.oldest = date(2026, 10, 9)

    harness.backfill(at(9, 22, 10))  # reads to 22:10, past the live read

    [segment] = harness.segments
    assert (segment.start, segment.start_known, segment.active) == (at(9, 21), True, True)
    assert segment.end == at(9, 22, 5)


def test_a_history_request_in_flight_at_unload_schedules_no_save():
    states, energy = charging_history()
    harness = Harness({RUN_MODE: states, METER: energy})
    harness.run(harness.service.async_unload())

    harness.history(at(10, 12))

    assert harness.service.store._store._data is None


def test_recorder_purge_keeps_settled_segments_as_they_were():
    states, energy = charging_history()
    harness = Harness({RUN_MODE: states, METER: energy}, datasets={date(2026, 10, 10): dataset(hours=every_hour(at(10, 8), at(10, 10)))})
    before = harness.history(at(10, 12))
    assert harness.segments[0].energy_final

    harness.recorder.history = {}  # purged
    reads = len(harness.recorder.reads)
    after = harness.history(at(10, 13))

    assert after["segments"] == before["segments"]
    assert after["totals"]["kwh"] == pytest.approx(6.0)
    # A settled segment's meter is never read again.
    assert [read[0] for read in harness.recorder.reads[reads:]] == [RUN_MODE]


def test_a_segment_no_meter_can_measure_settles_as_it_is_past_the_settle_window():
    states, _ = charging_history()
    day = date(2026, 10, 10)
    # The meter history is purged: every slice is missing energy.
    purged = Harness({RUN_MODE: states}, datasets={day: dataset(hours=every_hour(at(10, 8), at(10, 10)))})
    assert purged.history(at(10, 10, 30))["complete"] is False  # still inside the settle window
    payload = purged.history(at(10, 12))
    assert payload["complete"] is True
    assert payload["health"]["settledThrough"] == at(10, 12).isoformat()
    assert [item.kwh for item in purged.segments[0].slices] == [None, None]

    # No meter at all, and no house to attribute in.
    unmetered = Harness({RUN_MODE: states}, meter_entity=None)
    assert unmetered.history(at(10, 12))["complete"] is True

    energy = charging_history()[1]
    no_house = Harness({RUN_MODE: states, METER: energy}, datasets={})
    assert no_house.history(at(10, 12))["complete"] is True
    calls = len(no_house.dataset_calls)
    no_house.history(at(10, 13))
    assert len(no_house.dataset_calls) == calls
    assert all(item.attribution is None for item in no_house.segments[0].slices)


def test_a_failed_read_is_explicit_moves_no_cursor_and_keeps_what_is_stored():
    states, energy = charging_history()
    harness = Harness({RUN_MODE: states, METER: energy})
    harness.history(at(10, 12))
    cursor = harness.service.store.ledger(CHARGER).cursor

    harness.recorder.fail = True
    payload = harness.history(at(10, 13))

    assert payload["unavailable"] is None
    assert payload["complete"] is False
    assert payload["health"]["error"] == "read_failed"
    assert harness.service.store.ledger(CHARGER).cursor == cursor
    assert payload["totals"]["kwh"] == pytest.approx(6.0)


def test_backfill_asks_an_unanswered_days_house_dataset_once_not_after_every_day_read():
    states = run_mode(("Available", at(4, 10)), ("Charging", at(7, 10)), ("Available", at(7, 11)))
    energy = [row("0.0", at(4, 10), "kWh"), *meter((at(7, 10), 0.0), (at(7, 11), 5.0))]
    day = date(2026, 10, 7)
    harness = Harness({RUN_MODE: states, METER: energy}, datasets={day: RuntimeError("statistics down")})
    now = at(10, 12)
    harness.history(now)
    harness.oldest = date(2026, 10, 4)

    harness.backfill(now)  # reads 9, 8, 7, 6, 5 and 4 October

    assert harness.dataset_calls.count(day) == 1
    # The next reconciliation asks again.
    harness.history(now)
    assert harness.dataset_calls.count(day) == 2


def test_a_failed_backfill_day_is_read_again_without_moving_its_cursor():
    harness = Harness({RUN_MODE: run_mode(("Available", at(5, 10)))})
    now = at(10, 12)
    harness.history(now)
    harness.oldest = date(2026, 10, 8)
    ledger = harness.service.store.ledger(CHARGER)
    before = ledger.backfill_before

    harness.recorder.fail = True
    harness.backfill(now)
    assert (ledger.backfill_before, ledger.backfill_failed, ledger.backfill_days) == (before, True, 0)
    assert harness.history(now)["health"]["backfill"]["status"] == "failed"

    harness.recorder.fail = False
    harness.backfill(now)
    assert (ledger.backfill_done, ledger.backfill_failed, ledger.backfill_days) == (True, False, 2)


def test_rebound_telemetry_bridges_no_readings():
    states, energy = charging_history()
    harness = Harness({RUN_MODE: states, METER: energy}, live=live_run_mode("Charging", at(10, 8)))
    harness.history(at(10, 9))
    measured = harness.segments[0].kwh

    # The charger now reads another meter and another run mode.
    harness.service.chargers[CHARGER] = TrackedCharger(CHARGER, "sensor.other_run_mode", "sensor.other_meter", CONDITIONS)
    harness.recorder.history["sensor.other_run_mode"] = run_mode(("Available", at(10, 8)))
    harness.recorder.history["sensor.other_meter"] = [row("0", at(10, 7), "kWh"), row("500", at(10, 8, 30), "kWh")]
    harness.history(at(10, 12))

    old = harness.segments[0]
    assert (old.active, old.end_known, old.kwh) == (False, False, measured)
    assert "sensor.other_meter" not in {entity_id for entity_id, *_ in harness.recorder.reads}


def test_a_charger_no_longer_tracked_keeps_its_history_and_has_no_ledger_figures():
    states, energy = charging_history()
    harness = Harness({RUN_MODE: states, METER: energy})
    harness.history(at(10, 12))

    harness.service.chargers = {}

    assert harness.history(at(10, 13)) == {"unavailable": "no_run_mode"}
    assert len(harness.service.store.ledger(CHARGER).segments) == 1


def test_an_unreadable_stored_value_is_dropped_and_the_ledger_still_loads():
    states, energy = charging_history()
    harness = Harness({RUN_MODE: states, METER: energy})
    harness.history(at(10, 12))
    stored = harness.stored()
    stored["chargers"][CHARGER].update(backfill_floor="8. 10. 2026", cursor="soon")

    reloaded = Harness({RUN_MODE: states, METER: energy}, stored=stored)
    reloaded.run(asyncio.sleep(0))

    ledger = reloaded.service.store.ledger(CHARGER)
    assert (ledger.backfill_floor, ledger.cursor) == (None, None)
    assert [segment.id for segment in ledger.segments] == [segment.id for segment in harness.segments]


def test_run_mode_events_skip_attribute_updates_and_coalesce_into_one_follow_up():
    harness = Harness({RUN_MODE: []})
    service = harness.service
    calls = []

    def event(old, new):
        return NS(data={"old_state": row(old, at(10, 8)), "new_state": row(new, at(10, 8))})

    async def scenario():
        gate = asyncio.Event()

        async def reconcile_all():
            calls.append(len(calls))
            await gate.wait()

        service._async_reconcile_all = reconcile_all
        service._on_run_mode_changed(event("Charging", "Charging"))  # attributes only
        assert not service._tasks
        service._on_run_mode_changed(event("Available", "Charging"))
        await asyncio.sleep(0)  # reading now: the changes below came after its read began
        for _ in range(5):
            service._on_run_mode_changed(event("Charging", "SuspendedEV"))
        assert (len(service._tasks), calls) == (1, [0])
        gate.set()
        await asyncio.gather(*tuple(service._tasks))
        assert calls == [0, 1]  # one follow-up for the changes meanwhile
        service._on_run_mode_changed(event("Charging", "Available"))
        await asyncio.gather(*tuple(service._tasks))

    asyncio.run(scenario())
    assert calls == [0, 1, 2]
    assert harness.task_names == ["helman charging ledger reconcile"] * 2


def test_setup_registers_one_listener_set_and_unload_removes_it():
    removed = []
    hass = NS(states=NS(get=lambda _id: None), async_create_background_task=lambda coro, name: asyncio.ensure_future(coro))

    def listener(name):
        return lambda *args, **kwargs: (lambda: removed.append(name))

    profile = PROFILES["solax_ev_charger"]
    telemetry = {CHARGER: NS(profile=profile, entities={"run_mode": RUN_MODE})}
    config = {"devices": {"consumers": [{"id": CHARGER, "kind": "ev_charger", "consumption": {"energy_entity_id": METER}}]}}

    async def scenario():
        with patch.object(service_module, "resolve_vendor_telemetry", return_value=telemetry), patch.object(
            service_module, "async_track_state_change_event", side_effect=listener("state")
        ) as tracked, patch.object(service_module, "async_track_time_interval", side_effect=listener("tick")), patch.object(
            service_module, "async_at_started", side_effect=listener("started")
        ):
            with patch(STORE, DummyStore):
                service = EvSessionService(hass, read_config=lambda: config, day_dataset=None)
            await service.async_setup()
            assert list(service.chargers) == [CHARGER]
            assert service.chargers[CHARGER].meter_entity_id == METER
            assert tracked.call_args.args[1] == [RUN_MODE]
            await service.async_unload()

    asyncio.run(scenario())
    assert sorted(removed) == ["started", "state", "tick"]


# --- Attribution and money ----------------------------------------------------------


def two_hours(**dataset_kwargs):
    """A charge of 2 kWh at 08:00 and 4 kWh at 09:00 UTC, and that day's dataset."""
    states, energy = charging_history()
    energy = [row("20.0", at(10, 7), "kWh"), *meter((at(10, 8), 20.0), (at(10, 9), 22.0), (at(10, 10), 26.0))]
    hours = [at(10, 8), at(10, 9)]
    harness = Harness({RUN_MODE: states, METER: energy}, datasets={date(2026, 10, 10): dataset(hours=hours, **dataset_kwargs)})
    return harness, hours


def test_rates_divide_by_priced_energy_and_partial_pricing_names_its_coverage():
    # Half solar, half grid; the 09:00 hour has no import price.
    harness, hours = two_hours(import_rate={at(10, 8): 4.0})

    payload = harness.history(at(10, 12))

    totals = payload["totals"]
    assert totals["sources"] == pytest.approx({"solar": 3.0, "battery": 0.0, "grid": 3.0, "unknown": 0.0})
    # Paid: 1 grid kWh at 4.0; solar is a known zero; 2 grid kWh are unpriced.
    assert totals["paid"] == pytest.approx({"amount": 4.0, "pricedKwh": 4.0, "unpricedKwh": 2.0})
    assert payload["paidPerKwh"] == pytest.approx(1.0)
    assert totals["gridPaid"] == pytest.approx({"amount": 4.0, "pricedKwh": 1.0, "unpricedKwh": 2.0})
    assert payload["gridPricePerKwh"] == pytest.approx(4.0)


def test_forgone_export_value_stays_out_of_paid_and_every_rate():
    harness, _ = two_hours(import_rate={}, export_rate={at(10, 8): 1.5, at(10, 9): 1.5})

    payload = harness.history(at(10, 12))

    totals = payload["totals"]
    assert totals["solarForgone"] == pytest.approx({"amount": 4.5, "pricedKwh": 3.0, "unpricedKwh": 0.0})
    assert totals["paid"]["amount"] == 0.0
    # Only the solar half is priced on paid (a known zero): the grid half is not.
    assert payload["paidPerKwh"] == pytest.approx(0.0)
    assert payload["gridPricePerKwh"] is None


def test_battery_supply_takes_the_days_charge_origin():
    battery = HourMix(solar=0.0, battery=1.0, grid=0.0, unattributed=0.0, ambiguous_kwh=0.0, mismatch_kwh=0.0)
    origin = ChargeOrigin(charged_kwh=10.0, grid_recorded=0.5, solar_priced=0.5, unknown=0.0, paid_rate=3.0, forgone_rate=1.0)
    harness, _ = two_hours(mix=battery, origin=origin)

    totals = harness.history(at(10, 12))["totals"]

    assert totals["sources"]["battery"] == pytest.approx(6.0)
    assert totals["paid"] == pytest.approx({"amount": 9.0, "pricedKwh": 6.0, "unpricedKwh": 0.0})
    assert totals["gridPaid"]["amount"] == 0.0


def test_a_negative_price_is_paid_back():
    harness, _ = two_hours(import_rate={at(10, 8): -2.0, at(10, 9): -2.0})

    payload = harness.history(at(10, 12))

    assert payload["totals"]["gridPaid"]["amount"] == pytest.approx(-6.0)
    assert payload["segments"][0]["paid"]["amount"] == pytest.approx(-6.0)


def test_unknown_source_hours_and_a_missing_house_dataset_keep_the_kwh():
    harness, _ = two_hours(mix={at(10, 8): HourMix(solar=1.0, battery=0.0, grid=0.0, unattributed=0.0, ambiguous_kwh=0.0, mismatch_kwh=0.0)})
    totals = harness.history(at(10, 12))["totals"]
    assert totals["sources"] == pytest.approx({"solar": 2.0, "battery": 0.0, "grid": 0.0, "unknown": 4.0})
    assert totals["knownKwh"] == pytest.approx(2.0)

    states, energy = charging_history()
    no_house = Harness({RUN_MODE: states, METER: energy}, datasets={})
    payload = no_house.history(at(10, 12))
    assert payload["totals"]["kwh"] == pytest.approx(6.0)
    assert payload["totals"]["sources"] is None
    assert payload["totals"]["paid"] == {"amount": 0.0, "pricedKwh": 0.0, "unpricedKwh": pytest.approx(6.0)}
    assert payload["paidPerKwh"] is None


def test_delayed_compilation_is_attributed_again_then_kept_through_a_failed_read():
    hours = [at(10, 8), at(10, 9)]
    states, energy = charging_history()
    answers = {"day": dataset(hours=[], mix={}, complete=False)}
    harness = Harness({RUN_MODE: states, METER: energy}, datasets=lambda day: answers["day"])

    first = harness.history(at(10, 12))
    assert first["totals"]["sources"]["unknown"] == pytest.approx(6.0)
    assert first["complete"] is False

    answers["day"] = dataset(hours=hours)
    second = harness.history(at(10, 13))
    assert second["totals"]["sources"]["solar"] == pytest.approx(3.0)
    assert second["complete"] is True

    answers["day"] = RuntimeError("statistics down")
    third = harness.history(at(10, 14))
    assert third["totals"] == second["totals"]


def test_a_zero_energy_segment_is_listed_but_is_no_charging_day():
    states = run_mode(("Available", at(10, 7)), ("Charging", at(10, 8)), ("Available", at(10, 8, 30)))
    energy = [row("20.0", at(10, 7), "kWh"), row("20.0", at(10, 8, 15), "kWh")]
    harness = Harness({RUN_MODE: states, METER: energy}, datasets={date(2026, 10, 10): dataset(hours=[at(10, 8)])})

    payload = harness.history(at(10, 12))

    assert payload["segments"][0]["kwh"] == 0.0
    assert payload["chargingDays"] == 0
    assert payload["paidPerKwh"] is None


# --- The 30-day window ------------------------------------------------------------------


def test_a_segment_crossing_the_window_start_counts_only_its_in_window_hours():
    now = at(30, 12)
    start = now - timedelta(days=30)  # 2026-09-30 12:00 UTC
    states = run_mode(("Available", start - timedelta(hours=3)), ("Charging", start - timedelta(hours=1)), ("Available", start + timedelta(hours=2)))
    energy = [row("0.0", start - timedelta(hours=3), "kWh"), *meter((start - timedelta(hours=1), 0.0), (start + timedelta(hours=2), 3.0))]
    harness = Harness({RUN_MODE: states, METER: energy})
    harness.service.store.ledger(CHARGER).live_since = start - timedelta(days=1)

    payload = harness.history(now)

    assert payload["window"] == {"start": start.isoformat(), "end": now.isoformat()}
    assert payload["totals"]["kwh"] == pytest.approx(2.0)
    assert payload["segments"][0]["kwh"] == pytest.approx(3.0)
    # It started before the window: not one of its charging days.
    assert payload["chargingDays"] == 0


def test_charging_days_count_local_days_with_energy_by_segment_start():
    states = run_mode(
        ("Available", at(8, 5)),
        ("Charging", at(8, 6)), ("SuspendedEV", at(8, 7)),
        ("Charging", at(8, 8)), ("SuspendedEV", at(8, 9)),
        ("Charging", at(8, 10)), ("Available", at(8, 11)),
        ("Charging", at(9, 6)), ("Available", at(9, 7)),
    )
    energy = [row("0.0", at(8, 5), "kWh")]
    total = 0.0
    for begin in (at(8, 6), at(8, 8), at(8, 10), at(9, 6)):
        energy += meter((begin, total), (begin + timedelta(hours=1), total + 1.0))
        total += 1.0
    harness = Harness({RUN_MODE: states, METER: energy})
    ledger = harness.service.store.ledger(CHARGER)
    ledger.live_since = at(7, 22)
    ledger.backfill_before = at(10, 12) - timedelta(days=30)  # the whole window recorded

    payload = harness.history(at(10, 12))

    assert len(payload["segments"]) == 4
    assert payload["chargingDays"] == 2
    assert payload["coveredDays"] == 30
    assert payload["perWeek"] == pytest.approx(2 / 30 * 7)


def test_per_week_counts_by_the_days_recorded_when_the_recorder_keeps_fewer_than_30():
    # The recorder keeps ten local days (11–20 October) and the car charged on each.
    changes = [("Available", at(10, 22))]
    energy = [row("0.0", at(10, 22), "kWh")]
    for day in range(11, 21):
        changes += [("Charging", at(day, 6)), ("Available", at(day, 7))]
        energy += meter((at(day, 6), day - 11.0), (at(day, 7), day - 10.0))
    harness = Harness({RUN_MODE: run_mode(*changes), METER: energy})
    now = at(20, 12)
    harness.history(now)
    harness.oldest = date(2026, 10, 11)
    harness.backfill(now)

    payload = harness.history(now)

    assert payload["chargingDays"] == 10
    assert payload["coveredDays"] == 10
    assert payload["perWeek"] == pytest.approx(7.0)


def test_the_newest_twenty_segments_are_listed_whatever_the_window():
    changes = [("Available", at(1, 5, month=8))]
    for day in range(1, 23):
        changes += [("Charging", at(day, 6, month=8)), ("Available", at(day, 7, month=8))]
    harness = Harness({RUN_MODE: run_mode(*changes)})
    harness.service.store.ledger(CHARGER).live_since = at(1, 0, month=8)

    payload = harness.history(at(10, 12))

    assert len(harness.segments) == 22
    assert [item["start"] for item in payload["segments"]] == [at(day, 6, month=8).isoformat() for day in range(22, 2, -1)]
    assert payload["totals"]["kwh"] == 0.0
