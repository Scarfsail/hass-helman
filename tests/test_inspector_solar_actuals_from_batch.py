"""The inspector's solar actuals come out of the meter batch it already reads.

The solar meter is in that batch because the batch's liveness trace is what
tells its quiet nights apart from a recorder outage (#208), and the batch parses,
unwraps and samples it with the very helper the actuals reader called -- so
reading it a second time bought nothing (#245). What is left is the day's own
cutoff, which is what this file pins: the batch spans the whole local day, the
actuals stop at the current *completed* slot.

The equivalence tests below serve one set of recorder rows to both paths and
compare the two answers value by value, so "same semantics" is asserted against
numbers rather than against the shape of the call site.
"""

from __future__ import annotations

import sys
import types
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
UTC = timezone.utc


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

    async def _run_in_executor(func, *args):
        return func(*args)

    recorder_mod = types.ModuleType("homeassistant.components.recorder")
    recorder_mod.get_instance = lambda hass: SimpleNamespace(
        async_add_executor_job=_run_in_executor
    )
    sys.modules["homeassistant.components.recorder"] = recorder_mod

    history_mod = types.ModuleType("homeassistant.components.recorder.history")
    history_mod.state_changes_during_period = lambda *args, **kwargs: {}
    history_mod.get_significant_states = lambda *args, **kwargs: {}
    sys.modules["homeassistant.components.recorder.history"] = history_mod

    core_mod = types.ModuleType("homeassistant.core")
    core_mod.HomeAssistant = type("HomeAssistant", (), {})
    core_mod.callback = lambda func: func
    sys.modules["homeassistant.core"] = core_mod

    util_mod = types.ModuleType("homeassistant.util")
    sys.modules["homeassistant.util"] = util_mod
    dt_mod = types.ModuleType("homeassistant.util.dt")
    dt_mod.now = lambda: datetime(2026, 4, 17, 12, 7, tzinfo=UTC)
    dt_mod.as_local = lambda value: value.astimezone(UTC)
    dt_mod.as_utc = lambda value: value.astimezone(UTC)
    sys.modules["homeassistant.util.dt"] = dt_mod
    util_mod.dt = dt_mod

    sys.modules.pop("custom_components.helman.recorder_hourly_series", None)
    sys.modules.pop("custom_components.helman.solar_bias_correction.actuals", None)


_install_import_stubs()

import importlib  # noqa: E402

recorder_series = importlib.import_module(
    "custom_components.helman.recorder_hourly_series"
)
actuals = importlib.import_module(
    "custom_components.helman.solar_bias_correction.actuals"
)
models = importlib.import_module(
    "custom_components.helman.solar_bias_correction.models"
)

METER = "sensor.solar_total"
DAY = date(2026, 4, 16)
TODAY = date(2026, 4, 17)
#: The clock every test runs against: 12:07 puts 12:00 in progress.
NOW = datetime(2026, 4, 17, 12, 7, tzinfo=UTC)
HASS = SimpleNamespace(states=SimpleNamespace(get=lambda entity_id: None))


class _State:
    def __init__(self, instant: datetime, value: float | str) -> None:
        self.last_updated = instant
        self.state = str(value)
        self.attributes = {"unit_of_measurement": "kWh"}


def _rising(day: date, readings: list[tuple[str, float | str]]) -> list[_State]:
    """A meter's rows for one day, ``[("HH:MM", reading_kwh)]``."""
    return [
        _State(
            datetime.combine(day, datetime.min.time(), tzinfo=UTC)
            + timedelta(
                hours=int(clock.split(":")[0]), minutes=int(clock.split(":")[1])
            ),
            value,
        )
        for clock, value in readings
    ]


def _serving(rows_by_entity: dict[str, list[_State]]):
    """Serve each entity's rows to both readers, windowed the way the recorder does.

    ``include_start_time_state`` is what both callers pass, so the last row
    before the window comes back stamped at the window start; rows are kept from
    the start inclusive to the end exclusive.
    """

    def _window(entity_id, start, end):
        rows = rows_by_entity.get(entity_id) or []
        inside = [row for row in rows if start <= row.last_updated < end]
        before = [row for row in rows if row.last_updated < start]
        if before:
            return [_State(start, before[-1].state), *inside]
        return inside

    def _per_entity(hass, start, end, entity_id, *args, **kwargs):
        return {entity_id: _window(entity_id, start, end)}

    def _batched(hass, start, end, entity_ids=None, *args, **kwargs):
        return {
            entity_id: _window(entity_id, start, end)
            for entity_id in entity_ids or []
        }

    return patch.multiple(
        recorder_series,
        state_changes_during_period=_per_entity,
        get_significant_states=_batched,
    )


async def _both_ways(
    rows_by_entity: dict[str, list[_State]], target_date: date
):
    """The two answers for one day: the old second read, and the batch column."""
    cfg = models.BiasConfig(
        enabled=True,
        min_history_days=2,
        training_time="03:00",
        clamp_min=0.3,
        clamp_max=2.0,
        aggregation_method="ratio_of_sums",
        daily_energy_entity_ids=["sensor.solar_today"],
        total_energy_entity_id=METER,
    )
    local_start = datetime.combine(target_date, datetime.min.time(), tzinfo=UTC)
    with _serving(rows_by_entity):
        batch = await recorder_series.query_cumulative_slot_energy_changes_for_entities(
            HASS,
            list(rows_by_entity),
            local_start=local_start,
            local_end=local_start + timedelta(days=1),
            interval_minutes=15,
        )
        separate = await actuals.load_actuals_for_day(
            HASS,
            cfg,
            target_date,
            local_now=NOW,
            liveness_instants=batch.liveness_instants,
        )
    from_batch = actuals.slot_actuals_from_batched_slot_energy(
        batch.by_entity.get(METER), target_date, local_now=NOW
    )
    return separate, from_batch


class TestTheBatchColumnMatchesTheSecondRead(unittest.IsolatedAsyncioTestCase):
    async def test_an_elapsed_day_with_a_counter_reset_agrees_slot_for_slot(self):
        rows = _rising(
            DAY,
            [
                ("00:00", 100.0),
                ("08:00", 100.0),
                ("08:20", 100.5),
                ("09:00", 101.25),
                # Midday reset: the unwrap has to lift the series, not read the
                # dip as a slot the size of the whole meter.
                ("12:00", 0.0),
                ("12:30", 0.75),
                ("18:00", 1.0),
            ],
        )
        separate, from_batch = await _both_ways({METER: rows}, DAY)

        self.assertEqual(from_batch, separate)
        # Value-precise, so an agreement between two empty maps cannot pass for
        # one: the reset slot carries the post-reset delta and nothing else.
        self.assertEqual(from_batch["08:15"], 500.0)
        self.assertEqual(from_batch["08:45"], 750.0)
        self.assertEqual(from_batch["12:00"], 0.0)
        self.assertEqual(from_batch["12:15"], 750.0)

    async def test_a_quiet_night_keeps_its_zeros_on_the_batch_s_own_evidence(self):
        # The solar meter says nothing between 20:00 and 06:00; another meter in
        # the batch keeps writing, which is the evidence that the recorder was up
        # and the night's zeros are real (#208).
        rows = _rising(DAY, [("06:00", 10.0), ("20:00", 12.0)])
        house = [
            _State(
                datetime.combine(DAY, datetime.min.time(), tzinfo=UTC)
                + timedelta(minutes=15 * index),
                40.0 + index,
            )
            for index in range(96)
        ]
        separate, from_batch = await _both_ways(
            {METER: rows, "sensor.house": house}, DAY
        )

        self.assertEqual(from_batch, separate)
        # The night is quiet, not missing: a real zero rather than a hole.
        self.assertEqual(from_batch["21:00"], 0.0)
        self.assertEqual(from_batch["23:45"], 0.0)
        self.assertEqual(from_batch["06:00"], 0.0)
        self.assertEqual(from_batch["19:45"], 2000.0)

    async def test_without_that_evidence_the_same_night_would_drop_out(self):
        # The other half of the rule the batch column has to keep: with no
        # liveness trace at all, the same quiet stretch reads as an outage and
        # its slots drop rather than recording zeros (#208). Asserted so the
        # zeros above cannot be mistaken for a carry that is never judged.
        rows = _rising(DAY, [("06:00", 10.0), ("20:00", 12.0)])
        with _serving({METER: rows}):
            batch = (
                await recorder_series.query_cumulative_slot_energy_changes_for_entities(
                    HASS,
                    [METER],
                    local_start=datetime.combine(
                        DAY, datetime.min.time(), tzinfo=UTC
                    ),
                    local_end=datetime.combine(DAY, datetime.min.time(), tzinfo=UTC)
                    + timedelta(days=1),
                    interval_minutes=15,
                )
            )

        from_batch = actuals.slot_actuals_from_batched_slot_energy(
            batch.by_entity.get(METER), DAY, local_now=NOW
        )
        self.assertNotIn("23:45", from_batch)

    async def test_today_stops_at_the_current_completed_slot(self):
        rows = _rising(
            TODAY,
            [
                ("11:30", 5.0),
                ("11:45", 5.25),
                ("11:59", 5.5),
                # Inside the slot in progress at 12:07.
                ("12:05", 5.6),
            ],
        )
        separate, from_batch = await _both_ways({METER: rows}, TODAY)

        self.assertEqual(from_batch, separate)
        self.assertEqual(from_batch["11:30"], 250.0)
        self.assertEqual(from_batch["11:45"], 250.0)
        # The running slot and everything after it are not the actuals' to draw.
        self.assertNotIn("12:00", from_batch)
        self.assertNotIn("12:15", from_batch)
        self.assertEqual(max(from_batch), "11:45")

    async def test_a_reading_stamped_on_the_cutoff_lands_in_the_completed_slot(self):
        """The one place the batch column knows more than the second read did.

        A single-window read keeps rows stamped strictly before its end, so a
        reading landing exactly on the cutoff instant fell outside the actuals'
        own window and the last completed slot recorded nothing. The batch's
        window is the whole day, so that reading is in hand and the slot records
        the energy it really measured. The cutoff itself is unchanged -- 12:00
        is still not drawn -- and the case needs a reading stamped on the
        boundary to the millisecond, which is why it is pinned here rather than
        left to be discovered as a difference in the field.
        """
        rows = _rising(TODAY, [("11:45", 5.25), ("12:00", 5.5)])
        separate, from_batch = await _both_ways({METER: rows}, TODAY)

        self.assertEqual(separate["11:45"], 0.0)
        self.assertEqual(from_batch["11:45"], 250.0)
        self.assertNotIn("12:00", from_batch)

    async def test_unavailable_readings_are_skipped_rather_than_read_as_zero(self):
        rows = _rising(
            DAY,
            [
                ("08:00", 10.0),
                ("08:10", "unavailable"),
                ("08:20", 10.5),
                ("09:00", 11.0),
            ],
        )
        separate, from_batch = await _both_ways({METER: rows}, DAY)

        self.assertEqual(from_batch, separate)
        # ``unavailable`` is skipped, not read as a zero reading: the meter's
        # value stands at 10.0 across it, so the slot it falls in is flat and
        # the next slot carries the whole 0.5 kWh rise.
        self.assertEqual(from_batch["08:00"], 0.0)
        self.assertEqual(from_batch["08:15"], 500.0)
        self.assertEqual(from_batch["08:45"], 500.0)


class TestTheCutoffAndTheDegradedCases(unittest.IsolatedAsyncioTestCase):
    def test_an_elapsed_day_keeps_every_slot_of_the_batch(self):
        slot_energy = {
            datetime.combine(DAY, datetime.min.time(), tzinfo=UTC)
            + timedelta(minutes=15 * index): 0.1
            for index in range(96)
        }

        by_slot = actuals.slot_actuals_from_batched_slot_energy(
            slot_energy, DAY, local_now=NOW
        )

        self.assertEqual(len(by_slot), 96)
        self.assertEqual(by_slot["23:45"], 100.0)

    def test_a_missing_meter_or_a_failed_read_is_empty_and_never_zeros(self):
        for absent in (None, {}):
            with self.subTest(absent=absent):
                self.assertEqual(
                    actuals.slot_actuals_from_batched_slot_energy(
                        absent, DAY, local_now=NOW
                    ),
                    {},
                )


if __name__ == "__main__":
    unittest.main()
