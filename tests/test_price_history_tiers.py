"""Where each slot's historical rate comes from, tier by tier.

``query_price_history`` is the one reader every historical price in this
integration goes through, and it resolves two tiers over Helman's own price
entities: raw recorder states wherever they exist, the containing hour's
statistical ``mean`` for every slot they do not. These tests pin the join --
which tier answers a slot, how a partly-covered hour comes out, and that the
reads stay bounded -- because a wrong join shows up as a plausible number rather
than as an error.
"""

from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]

PRAGUE = ZoneInfo("Europe/Prague")

#: What each stubbed recorder table holds for this test, and what it was asked.
RECORDER: dict[str, object] = {
    "states": {},
    "statistics": {},
    "oldest_state": {},
    "state_queries": [],
    "statistics_queries": [],
    "probe_queries": [],
}


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

    def _state_changes_during_period(
        hass, start, end, entity_id, *args, limit=None, **kwargs
    ):
        # The coverage probe: one indexed ``LIMIT 1`` ascending row per entity.
        RECORDER["probe_queries"].append(entity_id)
        oldest = RECORDER["oldest_state"].get(entity_id)
        return {} if oldest is None else {entity_id: [_state(oldest, 0.0)]}

    def _get_significant_states(hass, start, end, entity_ids=None, *args, **kwargs):
        RECORDER["state_queries"].append(
            {"entity_ids": list(entity_ids or []), "start": start, "end": end}
        )
        return {
            entity_id: RECORDER["states"].get(entity_id, [])
            for entity_id in (entity_ids or [])
        }

    history_mod = types.ModuleType("homeassistant.components.recorder.history")
    history_mod.state_changes_during_period = _state_changes_during_period
    history_mod.get_significant_states = _get_significant_states
    sys.modules["homeassistant.components.recorder.history"] = history_mod

    def _statistics_during_period(
        hass, start, end, statistic_ids, period, *args, **kwargs
    ):
        RECORDER["statistics_queries"].append(
            {"statistic_ids": set(statistic_ids or ()), "period": period}
        )
        return {
            statistic_id: RECORDER["statistics"].get(statistic_id, [])
            for statistic_id in (statistic_ids or ())
        }

    statistics_mod = types.ModuleType("homeassistant.components.recorder.statistics")
    statistics_mod.statistics_during_period = _statistics_during_period
    statistics_mod.get_metadata = lambda hass, statistic_ids=None: {}
    sys.modules["homeassistant.components.recorder.statistics"] = statistics_mod

    core_mod = types.ModuleType("homeassistant.core")
    core_mod.HomeAssistant = type("HomeAssistant", (), {})
    core_mod.callback = lambda func: func
    sys.modules["homeassistant.core"] = core_mod

    util_mod = types.ModuleType("homeassistant.util")
    sys.modules["homeassistant.util"] = util_mod
    dt_mod = types.ModuleType("homeassistant.util.dt")
    # Real conversions, not identities: this file is about which UTC instant a
    # slot is, and a DST day is one of the cases under test.
    dt_mod.now = lambda: datetime(2026, 5, 11, 10, 0, tzinfo=PRAGUE)
    dt_mod.as_local = lambda value: value.astimezone(PRAGUE)
    dt_mod.as_utc = lambda value: value.astimezone(timezone.utc)
    sys.modules["homeassistant.util.dt"] = dt_mod
    util_mod.dt = dt_mod

    sys.modules.pop("custom_components.helman.recorder_hourly_series", None)
    sys.modules.pop("custom_components.helman.recorder_statistics_span", None)


def _state(when: datetime, value):
    return SimpleNamespace(last_updated=when, state=value)


_install_import_stubs()

import importlib  # noqa: E402

span_mod = importlib.import_module("custom_components.helman.recorder_statistics_span")

IMPORT_PRICE = "sensor.helman_grid_import_price"
EXPORT_PRICE = "sensor.helman_grid_export_price"
EXTERNAL_PRICE = "sensor.spot_sell_price"


def _row(hour: datetime, mean):
    return {"start": hour.timestamp(), "mean": mean}


def _reset(*, states=None, statistics=None, oldest_state=None) -> None:
    RECORDER["states"] = states or {}
    RECORDER["statistics"] = statistics or {}
    RECORDER["oldest_state"] = oldest_state or {}
    RECORDER["state_queries"] = []
    RECORDER["statistics_queries"] = []
    RECORDER["probe_queries"] = []


async def _resolve(
    entity_ids=(EXPORT_PRICE,),
    *,
    local_start=datetime(2026, 5, 10, 0, 0, tzinfo=PRAGUE),
    local_end=datetime(2026, 5, 11, 0, 0, tzinfo=PRAGUE),
    statistics_rows=None,
):
    return await span_mod.query_price_history(
        SimpleNamespace(),
        list(entity_ids),
        local_start=local_start,
        local_end=local_end,
        statistics_rows=statistics_rows,
    )


def _local_slots(history) -> dict[str, float]:
    return {
        slot.astimezone(PRAGUE).strftime("%H:%M"): value
        for slot, value in sorted(history.by_slot.items())
    }


class TestTierSelection(unittest.IsolatedAsyncioTestCase):
    """Raw wins; hourly fills what raw did not cover, and only that."""

    async def test_raw_states_beat_the_hourly_mean_for_the_same_hour(self):
        # Deliberately disagreeing: the hourly mean is 99.0 and the raw states
        # say 2.0/4.0. Whichever the reader picks it produces a plausible rail,
        # so only conflicting values can tell which tier answered.
        _reset(
            states={
                EXPORT_PRICE: [
                    _state(datetime(2026, 5, 10, 8, 0, 2, tzinfo=PRAGUE), "2.0"),
                    _state(datetime(2026, 5, 10, 8, 30, 2, tzinfo=PRAGUE), "4.0"),
                ]
            },
            statistics={
                EXPORT_PRICE: [_row(datetime(2026, 5, 10, 8, 0, tzinfo=PRAGUE), 99.0)]
            },
            oldest_state={EXPORT_PRICE: datetime(2026, 5, 10, 8, 0, tzinfo=PRAGUE)},
        )

        slots = _local_slots((await _resolve())[EXPORT_PRICE])

        self.assertEqual(
            {slot: slots[slot] for slot in ("08:00", "08:15", "08:30", "08:45")},
            {"08:00": 2.0, "08:15": 2.0, "08:30": 4.0, "08:45": 4.0},
        )
        self.assertNotIn(99.0, set(slots.values()))

    async def test_hourly_means_fill_only_the_hours_raw_never_reached(self):
        # Raw states begin at 08:00; the statistics table also holds 06:00 and
        # 07:00. The earlier hours are the statistics table's, the later ones
        # are not -- carrying 08:00's raw value backwards, or letting 08:00's
        # mean overwrite it, are the two ways to get this wrong.
        _reset(
            states={
                EXPORT_PRICE: [
                    _state(datetime(2026, 5, 10, 8, 0, 2, tzinfo=PRAGUE), "2.0")
                ]
            },
            statistics={
                EXPORT_PRICE: [
                    _row(datetime(2026, 5, 10, 6, 0, tzinfo=PRAGUE), 6.5),
                    _row(datetime(2026, 5, 10, 7, 0, tzinfo=PRAGUE), 7.5),
                    _row(datetime(2026, 5, 10, 8, 0, tzinfo=PRAGUE), 99.0),
                ]
            },
            oldest_state={EXPORT_PRICE: datetime(2026, 5, 10, 8, 0, tzinfo=PRAGUE)},
        )

        slots = _local_slots((await _resolve())[EXPORT_PRICE])

        self.assertNotIn("05:45", slots)
        self.assertEqual([slots[s] for s in ("06:00", "06:45")], [6.5, 6.5])
        self.assertEqual(slots["07:30"], 7.5)
        self.assertEqual(slots["08:00"], 2.0)
        self.assertEqual(slots["23:45"], 2.0)

    async def test_an_hour_is_half_raw_and_half_statistical(self):
        # The mixed case the per-slot resolution exists for: raw states open
        # part-way through 08:00, so its first two slots are the hourly mean's
        # and its last two are the states'. A per-day or per-hour choice would
        # have to blank one half or overwrite the other.
        _reset(
            states={
                EXPORT_PRICE: [
                    _state(datetime(2026, 5, 10, 8, 30, 2, tzinfo=PRAGUE), "4.0")
                ]
            },
            statistics={
                EXPORT_PRICE: [_row(datetime(2026, 5, 10, 8, 0, tzinfo=PRAGUE), 1.0)]
            },
            oldest_state={EXPORT_PRICE: datetime(2026, 5, 10, 8, 30, tzinfo=PRAGUE)},
        )

        slots = _local_slots((await _resolve())[EXPORT_PRICE])

        self.assertEqual(
            {slot: slots.get(slot) for slot in ("08:00", "08:15", "08:30", "08:45")},
            {"08:00": 1.0, "08:15": 1.0, "08:30": 4.0, "08:45": 4.0},
        )

    async def test_raw_purged_away_leaves_the_statistics_tier_alone(self):
        _reset(
            statistics={
                EXPORT_PRICE: [_row(datetime(2026, 5, 10, 8, 0, tzinfo=PRAGUE), 3.25)]
            }
        )

        slots = _local_slots((await _resolve())[EXPORT_PRICE])

        self.assertEqual([slots[s] for s in ("08:00", "08:45")], [3.25, 3.25])
        # Nothing to read raw, so nothing was read raw.
        self.assertEqual(RECORDER["state_queries"], [])

    async def test_a_missing_hour_stays_missing_at_both_tiers(self):
        # Never interpolated from the hours around it, and never a zero: a rate
        # nobody recorded is a fact about the recorder, and a fabricated one
        # would be spent by whatever prices energy with it.
        _reset(
            statistics={
                EXPORT_PRICE: [
                    _row(datetime(2026, 5, 10, 8, 0, tzinfo=PRAGUE), 3.0),
                    _row(datetime(2026, 5, 10, 10, 0, tzinfo=PRAGUE), 5.0),
                ]
            }
        )

        slots = _local_slots((await _resolve())[EXPORT_PRICE])

        self.assertEqual(slots["08:00"], 3.0)
        self.assertNotIn("09:00", slots)
        self.assertNotIn("09:45", slots)
        self.assertEqual(slots["10:00"], 5.0)

    async def test_nothing_at_either_tier_is_an_empty_series(self):
        _reset()

        resolved = await _resolve((IMPORT_PRICE, EXPORT_PRICE))

        # Present and empty rather than missing, so a caller's lookup behaves.
        self.assertEqual(sorted(resolved), sorted([IMPORT_PRICE, EXPORT_PRICE]))
        self.assertEqual(resolved[EXPORT_PRICE].by_slot, {})
        self.assertEqual(resolved[EXPORT_PRICE].hourly_means(), {})

    async def test_the_configured_ingestion_entity_is_never_read(self):
        # The whole point of #133: history for an entity Helman does not own
        # changes nothing, because nothing asks it anything.
        _reset(
            states={
                EXTERNAL_PRICE: [
                    _state(datetime(2026, 5, 10, 0, 0, tzinfo=PRAGUE), "9.0")
                ]
            },
            statistics={
                EXTERNAL_PRICE: [_row(datetime(2026, 5, 10, 8, 0, tzinfo=PRAGUE), 9.0)]
            },
            oldest_state={EXTERNAL_PRICE: datetime(2026, 5, 10, 0, 0, tzinfo=PRAGUE)},
        )

        resolved = await _resolve((IMPORT_PRICE, EXPORT_PRICE))

        self.assertEqual(resolved[EXPORT_PRICE].by_slot, {})
        self.assertNotIn(EXTERNAL_PRICE, RECORDER["probe_queries"])
        for query in RECORDER["statistics_queries"]:
            self.assertNotIn(EXTERNAL_PRICE, query["statistic_ids"])


class TestValuesThatAreNotRates(unittest.IsolatedAsyncioTestCase):
    async def test_zero_and_negative_rates_survive_both_tiers(self):
        # A spot market really does pay to take power away, and the day a rate
        # went negative is the day a reader most wants to look at.
        _reset(
            states={
                EXPORT_PRICE: [
                    _state(datetime(2026, 5, 10, 8, 0, 2, tzinfo=PRAGUE), "0.0"),
                    _state(datetime(2026, 5, 10, 9, 0, 2, tzinfo=PRAGUE), "-1.75"),
                ]
            },
            statistics={
                EXPORT_PRICE: [_row(datetime(2026, 5, 10, 7, 0, tzinfo=PRAGUE), -0.5)]
            },
            oldest_state={EXPORT_PRICE: datetime(2026, 5, 10, 8, 0, tzinfo=PRAGUE)},
        )

        slots = _local_slots((await _resolve())[EXPORT_PRICE])

        self.assertEqual(slots["07:00"], -0.5)
        self.assertEqual(slots["08:00"], 0.0)
        self.assertEqual(slots["09:00"], -1.75)

    async def test_unavailable_and_non_finite_readings_are_not_rates(self):
        # ``unavailable`` parses to nothing, and a ``nan`` that reached a total
        # would poison every figure it touched. Both leave the slot to the tier
        # below, which here has nothing either.
        _reset(
            states={
                EXPORT_PRICE: [
                    _state(datetime(2026, 5, 10, 8, 0, 2, tzinfo=PRAGUE), "unavailable"),
                    _state(datetime(2026, 5, 10, 9, 0, 2, tzinfo=PRAGUE), "nan"),
                ]
            },
            statistics={
                EXPORT_PRICE: [_row(datetime(2026, 5, 10, 10, 0, tzinfo=PRAGUE), None)]
            },
            oldest_state={EXPORT_PRICE: datetime(2026, 5, 10, 8, 0, tzinfo=PRAGUE)},
        )

        slots = _local_slots((await _resolve())[EXPORT_PRICE])

        self.assertEqual(slots, {})

    async def test_a_statistics_row_present_but_empty_prices_nothing(self):
        # The span read emits a row for an hour it folded short-term rows onto
        # whether or not any carried a mean, so presence is not a reading.
        _reset(
            statistics={
                EXPORT_PRICE: [
                    _row(datetime(2026, 5, 10, 8, 0, tzinfo=PRAGUE), None),
                    _row(datetime(2026, 5, 10, 9, 0, tzinfo=PRAGUE), 2.0),
                ]
            }
        )

        slots = _local_slots((await _resolve())[EXPORT_PRICE])

        self.assertNotIn("08:00", slots)
        self.assertEqual(slots["09:00"], 2.0)


class TestIntervalCoverage(unittest.IsolatedAsyncioTestCase):
    """What a window covers, and what an hour's rate is made of."""

    async def test_hourly_means_are_duration_weighted_over_the_hours_slots(self):
        # Two writes inside 08:00 and one inside 09:00. Averaging the writes
        # would weight the busy hour's minutes unequally; averaging the hour's
        # four equal slots is the duration weighting an hourly consumer needs.
        _reset(
            states={
                EXPORT_PRICE: [
                    _state(datetime(2026, 5, 10, 8, 0, 2, tzinfo=PRAGUE), "2.0"),
                    _state(datetime(2026, 5, 10, 8, 30, 2, tzinfo=PRAGUE), "6.0"),
                    _state(datetime(2026, 5, 10, 9, 0, 2, tzinfo=PRAGUE), "1.0"),
                ]
            },
            oldest_state={EXPORT_PRICE: datetime(2026, 5, 10, 8, 0, tzinfo=PRAGUE)},
        )

        means = (await _resolve())[EXPORT_PRICE].hourly_means()
        by_local_hour = {
            hour.astimezone(PRAGUE).strftime("%H:%M"): row["mean"]
            for hour, row in means.items()
        }

        # 2.0 for two slots and 6.0 for two: four, not the 3.33 an average of
        # the three writes would give.
        self.assertEqual(by_local_hour["08:00"], 4.0)
        self.assertEqual(by_local_hour["09:00"], 1.0)
        self.assertNotIn("07:00", by_local_hour)

    async def test_a_partial_first_day_starts_where_the_data_does(self):
        # The shape of the day a sensor ships on: nothing before its first
        # write, everything from it on.
        _reset(
            states={
                EXPORT_PRICE: [
                    _state(datetime(2026, 5, 10, 15, 5, tzinfo=PRAGUE), "3.0")
                ]
            },
            oldest_state={EXPORT_PRICE: datetime(2026, 5, 10, 15, 5, tzinfo=PRAGUE)},
        )

        slots = _local_slots((await _resolve())[EXPORT_PRICE])

        self.assertNotIn("14:45", slots)
        self.assertEqual(slots["15:00"], 3.0)
        self.assertEqual(slots["23:45"], 3.0)

    async def test_sparse_raw_writes_carry_across_the_slots_between_them(self):
        _reset(
            states={
                EXPORT_PRICE: [
                    _state(datetime(2026, 5, 10, 0, 0, tzinfo=PRAGUE), "1.0"),
                    _state(datetime(2026, 5, 10, 18, 0, 2, tzinfo=PRAGUE), "5.0"),
                ]
            },
            oldest_state={EXPORT_PRICE: datetime(2026, 5, 10, 0, 0, tzinfo=PRAGUE)},
        )

        slots = _local_slots((await _resolve())[EXPORT_PRICE])

        self.assertEqual(len(slots), 96)
        self.assertEqual(slots["17:45"], 1.0)
        self.assertEqual(slots["18:00"], 5.0)

    async def test_an_autumn_fall_back_day_keeps_both_of_its_two_am_hours(self):
        # Prague falls back on 2025-10-26: twenty-five local hours, a hundred
        # slots, and 02:00 lived twice at two different rates. Keying by the
        # local wall clock would collapse them into one.
        _reset(
            statistics={
                EXPORT_PRICE: [
                    _row(datetime(2025, 10, 26, 0, 0, tzinfo=timezone.utc), 2.0),
                    _row(datetime(2025, 10, 26, 1, 0, tzinfo=timezone.utc), 7.0),
                ]
            },
            oldest_state={},
        )

        history = (
            await _resolve(
                local_start=datetime(2025, 10, 26, 0, 0, tzinfo=PRAGUE),
                local_end=datetime(2025, 10, 27, 0, 0, tzinfo=PRAGUE),
            )
        )[EXPORT_PRICE]

        self.assertEqual(len(span_mod._price_slot_starts(
            datetime(2025, 10, 26, 0, 0, tzinfo=PRAGUE),
            datetime(2025, 10, 27, 0, 0, tzinfo=PRAGUE),
        )), 100)
        # Both 02:00 hours survive as their own UTC instants, at their own rates.
        self.assertEqual(
            {
                hour: row["mean"]
                for hour, row in history.hourly_means().items()
            },
            {
                datetime(2025, 10, 26, 0, 0, tzinfo=timezone.utc): 2.0,
                datetime(2025, 10, 26, 1, 0, tzinfo=timezone.utc): 7.0,
            },
        )
        self.assertEqual(
            sorted(
                slot.astimezone(PRAGUE).strftime("%H:%M")
                for slot in history.by_slot
            ),
            sorted(["02:00", "02:15", "02:30", "02:45"] * 2),
        )


class TestBoundedReads(unittest.IsolatedAsyncioTestCase):
    """Two tiers, batched per tier, and never a query per slot."""

    async def test_two_entities_cost_a_probe_each_and_one_read_per_tier(self):
        _reset(
            states={
                EXPORT_PRICE: [
                    _state(datetime(2026, 5, 10, 8, 0, 2, tzinfo=PRAGUE), "2.0")
                ]
            },
            statistics={
                IMPORT_PRICE: [_row(datetime(2026, 5, 10, 8, 0, tzinfo=PRAGUE), 4.0)]
            },
            oldest_state={EXPORT_PRICE: datetime(2026, 5, 10, 8, 0, tzinfo=PRAGUE)},
        )

        await _resolve((IMPORT_PRICE, EXPORT_PRICE))

        # One coverage probe per entity -- an indexed ``LIMIT 1`` row each.
        self.assertEqual(
            sorted(RECORDER["probe_queries"]), sorted([IMPORT_PRICE, EXPORT_PRICE])
        )
        # One raw read for both entities together, and one statistics read.
        self.assertEqual(len(RECORDER["state_queries"]), 1)
        self.assertEqual(
            RECORDER["state_queries"][0]["entity_ids"], [IMPORT_PRICE, EXPORT_PRICE]
        )
        self.assertEqual(len(RECORDER["statistics_queries"]), 1)
        self.assertEqual(
            RECORDER["statistics_queries"][0]["statistic_ids"],
            {IMPORT_PRICE, EXPORT_PRICE},
        )
        self.assertEqual(RECORDER["statistics_queries"][0]["period"], "hour")

    async def test_the_raw_read_opens_where_the_raw_states_do(self):
        # A deep window with a shallow raw history: the raw scan is bounded to
        # the day the states begin on rather than running the whole span.
        _reset(
            states={
                EXPORT_PRICE: [
                    _state(datetime(2026, 5, 9, 12, 0, tzinfo=PRAGUE), "2.0")
                ]
            },
            oldest_state={EXPORT_PRICE: datetime(2026, 5, 9, 12, 0, tzinfo=PRAGUE)},
        )

        await _resolve(
            local_start=datetime(2025, 5, 1, 0, 0, tzinfo=PRAGUE),
            local_end=datetime(2026, 5, 11, 0, 0, tzinfo=PRAGUE),
        )

        self.assertEqual(
            RECORDER["state_queries"][0]["start"],
            datetime(2026, 5, 9, 0, 0, tzinfo=PRAGUE),
        )

    async def test_full_raw_coverage_costs_no_statistics_read_at_all(self):
        _reset(
            states={
                EXPORT_PRICE: [
                    _state(datetime(2026, 5, 9, 23, 0, tzinfo=PRAGUE), "2.0")
                ]
            },
            oldest_state={EXPORT_PRICE: datetime(2026, 5, 9, 0, 0, tzinfo=PRAGUE)},
        )

        slots = _local_slots((await _resolve())[EXPORT_PRICE])

        self.assertEqual(len(slots), 96)
        self.assertEqual(RECORDER["statistics_queries"], [])

    async def test_statistics_already_loaded_are_used_rather_than_re_read(self):
        # The span aggregates read every entity they need in one call and hand
        # the rows over; a second query for the same rows would be pure cost.
        _reset(oldest_state={})
        rows = {
            EXPORT_PRICE: {
                datetime(2026, 5, 10, 6, 0, tzinfo=timezone.utc): {"mean": 8.5}
            }
        }

        history = (await _resolve(statistics_rows=rows))[EXPORT_PRICE]

        self.assertEqual(_local_slots(history)["08:00"], 8.5)
        self.assertEqual(RECORDER["statistics_queries"], [])

    async def test_an_empty_window_reads_nothing(self):
        _reset()

        resolved = await _resolve(
            local_start=datetime(2026, 5, 10, 0, 0, tzinfo=PRAGUE),
            local_end=datetime(2026, 5, 10, 0, 0, tzinfo=PRAGUE),
        )

        self.assertEqual(resolved[EXPORT_PRICE].by_slot, {})
        self.assertEqual(RECORDER["probe_queries"], [])
        self.assertEqual(RECORDER["state_queries"], [])
        self.assertEqual(RECORDER["statistics_queries"], [])


class TestStatisticsUnit(unittest.IsolatedAsyncioTestCase):
    """The unit of last resort, read off the archived metadata."""

    async def test_the_archived_unit_is_read_off_the_metadata_row(self):
        statistics_mod = sys.modules["homeassistant.components.recorder.statistics"]
        asked: list[set] = []

        def _get_metadata(hass, statistic_ids=None):
            asked.append(set(statistic_ids or ()))
            return {EXPORT_PRICE: (7, {"unit_of_measurement": "CZK/kWh"})}

        statistics_mod.get_metadata = _get_metadata
        try:
            unit = await span_mod.query_statistics_unit(SimpleNamespace(), EXPORT_PRICE)
        finally:
            statistics_mod.get_metadata = lambda hass, statistic_ids=None: {}

        self.assertEqual(unit, "CZK/kWh")
        self.assertEqual(asked, [{EXPORT_PRICE}])

    async def test_no_metadata_row_is_no_unit_rather_than_an_error(self):
        self.assertIsNone(
            await span_mod.query_statistics_unit(SimpleNamespace(), EXPORT_PRICE)
        )


if __name__ == "__main__":
    unittest.main()
