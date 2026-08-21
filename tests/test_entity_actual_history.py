from __future__ import annotations

import asyncio
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
PRAGUE = ZoneInfo("Europe/Prague")


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

    scheduling_pkg = sys.modules.get("custom_components.helman.scheduling")
    if scheduling_pkg is None:
        scheduling_pkg = types.ModuleType("custom_components.helman.scheduling")
        sys.modules["custom_components.helman.scheduling"] = scheduling_pkg
    scheduling_pkg.__path__ = [
        str(ROOT / "custom_components" / "helman" / "scheduling")
    ]

    def _ensure(name: str) -> types.ModuleType:
        mod = sys.modules.get(name)
        if mod is None:
            mod = types.ModuleType(name)
            sys.modules[name] = mod
        return mod

    homeassistant_pkg = _ensure("homeassistant")
    components_pkg = _ensure("homeassistant.components")
    recorder_pkg = _ensure("homeassistant.components.recorder")
    recorder_pkg.get_instance = lambda hass: _FakeRecorder()
    history_mod = _ensure("homeassistant.components.recorder.history")
    history_mod.state_changes_during_period = lambda *args, **kwargs: {}
    history_mod.get_significant_states = lambda *args, **kwargs: {}
    components_pkg.recorder = recorder_pkg
    core_mod = _ensure("homeassistant.core")
    core_mod.HomeAssistant = object
    homeassistant_pkg.components = components_pkg

    util_pkg = _ensure("homeassistant.util")
    dt_mod = _ensure("homeassistant.util.dt")
    # The real helper converts into the configured zone; an identity stub would
    # leave UTC timestamps looking like local ones and shift every slot.
    dt_mod.as_local = lambda value: (
        value.astimezone(PRAGUE)
        if value.tzinfo is not None
        else value.replace(tzinfo=PRAGUE)
    )
    dt_mod.as_utc = lambda value: (
        value.astimezone(timezone.utc)
        if value.tzinfo is not None
        else value.replace(tzinfo=timezone.utc)
    )
    dt_mod.parse_datetime = datetime.fromisoformat
    util_pkg.dt = dt_mod

    sys.modules.pop("custom_components.helman.recorder_hourly_series", None)
    sys.modules.pop("custom_components.helman.scheduling.actual_history", None)


class _FakeRecorder:
    """Runs the "executor" job inline; there is no database in these tests."""

    async def async_add_executor_job(self, target, *args):
        return target(*args)


_install_import_stubs()

from custom_components.helman.scheduling import actual_history  # noqa: E402
from custom_components.helman.scheduling.actual_history import (  # noqa: E402
    build_entity_actual_histories,
    build_entity_actual_history,
)


class _FakeState:
    def __init__(self, state: str, last_updated: datetime) -> None:
        self.state = state
        self.last_updated = last_updated


def _local(hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 7, 25, hour, minute, tzinfo=PRAGUE)


class BuildEntityActualHistoryTests(unittest.IsolatedAsyncioTestCase):
    """What the recorder saw, bucketed onto the schedule's own slot grid."""

    def setUp(self) -> None:
        self._saved = actual_history.state_changes_during_period

    def tearDown(self) -> None:
        actual_history.state_changes_during_period = self._saved

    def _serve(self, states: list[_FakeState]) -> None:
        actual_history.state_changes_during_period = (
            lambda *args, **kwargs: {"switch.boiler": states}
        )

    async def _build(self, states: list[_FakeState], *, now: datetime):
        self._serve(states)
        return await build_entity_actual_history(
            object(),
            entity_id="switch.boiler",
            normal_state="off",
            reference_time=now,
            interval_minutes=30,
        )

    async def test_a_run_covers_the_slots_it_spans(self) -> None:
        history = await self._build(
            [
                _FakeState("off", _local(0)),
                _FakeState("on", _local(8)),
                _FakeState("off", _local(9)),
            ],
            now=_local(10, 20),
        )

        self.assertEqual(
            [(entry["slot"][11:16], entry["state"], entry["ratio"]) for entry in history],
            [("08:00", "on", 1.0), ("08:30", "on", 1.0)],
        )

    async def test_a_partial_slot_reports_the_share_it_ran(self) -> None:
        history = await self._build(
            [
                _FakeState("off", _local(0)),
                _FakeState("on", _local(8, 20)),
                _FakeState("off", _local(8, 30)),
            ],
            now=_local(10, 20),
        )

        # Ten of thirty minutes: drawn as a whole slot, counted as a third.
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["ratio"], 0.333)

    async def test_the_running_slot_is_left_to_the_schedule(self) -> None:
        history = await self._build(
            [_FakeState("off", _local(0)), _FakeState("on", _local(9))],
            now=_local(10, 20),
        )

        # 10:00-10:30 is running now and belongs to the schedule, which the card
        # already draws; reporting it here would draw it twice.
        self.assertEqual(
            [entry["slot"][11:16] for entry in history],
            ["09:00", "09:30"],
        )

    async def test_states_that_are_not_the_resting_one_are_kept_apart(self) -> None:
        actual_history.state_changes_during_period = (
            lambda *args, **kwargs: {
                "select.inverter": [
                    _FakeState("Normal", _local(0)),
                    _FakeState("Charge", _local(8)),
                    _FakeState("Discharge", _local(8, 30)),
                    _FakeState("Normal", _local(9)),
                ]
            }
        )
        history = await build_entity_actual_history(
            object(),
            entity_id="select.inverter",
            normal_state="Normal",
            reference_time=_local(10, 20),
            interval_minutes=30,
        )

        # Each slot is labelled with the state it spent the most of itself in.
        self.assertEqual(
            [(entry["slot"][11:16], entry["state"]) for entry in history],
            [("08:00", "Charge"), ("08:30", "Discharge")],
        )

    async def test_unreadable_states_count_as_nothing(self) -> None:
        history = await self._build(
            [
                _FakeState("off", _local(0)),
                _FakeState("unavailable", _local(8)),
                _FakeState("off", _local(9)),
            ],
            now=_local(10, 20),
        )

        self.assertEqual(history, [])

    async def test_nothing_to_report_before_the_first_slot_completes(self) -> None:
        history = await self._build(
            [_FakeState("on", _local(0))],
            now=_local(0, 20),
        )

        self.assertEqual(history, [])


class BuildEntityActualHistoriesTests(unittest.IsolatedAsyncioTestCase):
    """The whole roster off one recorder read."""

    def setUp(self) -> None:
        self._saved = actual_history.get_significant_states
        self._calls: list[dict] = []

    def tearDown(self) -> None:
        actual_history.get_significant_states = self._saved

    def _serve(self, history: dict[str, list[_FakeState]]):
        def _fake(hass, start, end, **kwargs):
            self._calls.append({"start": start, "end": end, **kwargs})
            return history

        actual_history.get_significant_states = _fake

    async def _build(self, history, normal_states, *, now: datetime):
        self._serve(history)
        return await build_entity_actual_histories(
            object(),
            normal_states=normal_states,
            reference_time=now,
            interval_minutes=30,
        )

    async def test_every_entity_comes_out_of_a_single_query(self) -> None:
        history = await self._build(
            {
                "switch.boiler": [
                    _FakeState("off", _local(0)),
                    _FakeState("on", _local(8)),
                    _FakeState("off", _local(9)),
                ],
                "select.inverter": [
                    _FakeState("Normal", _local(0)),
                    _FakeState("Charge", _local(8, 30)),
                    _FakeState("Normal", _local(9)),
                ],
            },
            {"switch.boiler": "off", "select.inverter": "Normal"},
            now=_local(10, 20),
        )

        self.assertEqual(len(self._calls), 1)
        self.assertEqual(
            self._calls[0]["entity_ids"], ["switch.boiler", "select.inverter"]
        )
        # The same rows the singular query reads: state changes only, no
        # attributes, and the state standing when the window opened.
        self.assertTrue(self._calls[0]["significant_changes_only"])
        self.assertTrue(self._calls[0]["no_attributes"])
        self.assertTrue(self._calls[0]["include_start_time_state"])
        self.assertFalse(self._calls[0]["minimal_response"])
        # Each entity is bucketed against its own resting state.
        self.assertEqual(
            [
                (entry["slot"][11:16], entry["state"])
                for entry in history["switch.boiler"]
            ],
            [("08:00", "on"), ("08:30", "on")],
        )
        self.assertEqual(
            [
                (entry["slot"][11:16], entry["state"])
                for entry in history["select.inverter"]
            ],
            [("08:30", "Charge")],
        )

    async def test_the_batched_result_matches_the_singular_one(self) -> None:
        states = [
            _FakeState("off", _local(0)),
            _FakeState("on", _local(8, 20)),
            _FakeState("off", _local(8, 30)),
        ]
        actual_history.state_changes_during_period = (
            lambda *args, **kwargs: {"switch.boiler": states}
        )
        try:
            singular = await build_entity_actual_history(
                object(),
                entity_id="switch.boiler",
                normal_state="off",
                reference_time=_local(10, 20),
                interval_minutes=30,
            )
        finally:
            actual_history.state_changes_during_period = (
                lambda *args, **kwargs: {}
            )

        batched = await self._build(
            {"switch.boiler": states},
            {"switch.boiler": "off"},
            now=_local(10, 20),
        )
        self.assertEqual(batched["switch.boiler"], singular)

    async def test_attribute_only_rows_change_nothing(self) -> None:
        # ``climate`` is in both SIGNIFICANT_DOMAINS and NEED_ATTRIBUTE_DOMAINS,
        # so significant_changes_only=True still returns rows written for an
        # attribute change alone. Such a row repeats the state beside it, and a
        # row that does not change the state is not a boundary of anything.
        without_attribute_rows = await self._build(
            {
                "climate.pool": [
                    _FakeState("off", _local(0)),
                    _FakeState("heat", _local(8)),
                    _FakeState("off", _local(9)),
                ]
            },
            {"climate.pool": "off"},
            now=_local(10, 20),
        )
        with_attribute_rows = await self._build(
            {
                "climate.pool": [
                    _FakeState("off", _local(0)),
                    _FakeState("heat", _local(8)),
                    _FakeState("heat", _local(8, 10)),
                    _FakeState("heat", _local(8, 40)),
                    _FakeState("off", _local(9)),
                ]
            },
            {"climate.pool": "off"},
            now=_local(10, 20),
        )

        self.assertEqual(with_attribute_rows, without_attribute_rows)

    async def test_an_entity_the_recorder_has_nothing_for_reports_nothing(self) -> None:
        history = await self._build(
            {},
            {"switch.boiler": "off", "switch.pump": "off"},
            now=_local(10, 20),
        )

        self.assertEqual(history, {"switch.boiler": [], "switch.pump": []})

    async def test_no_entities_means_no_query(self) -> None:
        history = await self._build({}, {}, now=_local(10, 20))

        self.assertEqual(history, {})
        self.assertEqual(self._calls, [])

    async def test_nothing_to_report_before_the_first_slot_completes(self) -> None:
        history = await self._build(
            {"switch.boiler": [_FakeState("on", _local(0))]},
            {"switch.boiler": "off"},
            now=_local(0, 20),
        )

        self.assertEqual(history, {"switch.boiler": []})
        self.assertEqual(self._calls, [])


if __name__ == "__main__":
    unittest.main()
