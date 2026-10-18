from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo

from custom_components.helman.recorder_states import numeric_timeline, read_states

PRAGUE = ZoneInfo("Europe/Prague")


class RecorderStatesTests(unittest.IsolatedAsyncioTestCase):
    def test_numeric_timeline_empty(self) -> None:
        self.assertEqual(numeric_timeline([]), [])
        self.assertEqual(numeric_timeline(None), [])

    def test_numeric_timeline_prefers_last_updated(self) -> None:
        t_changed = datetime(2026, 5, 10, 10, 0, tzinfo=timezone.utc)
        t_updated = datetime(2026, 5, 10, 10, 5, tzinfo=timezone.utc)
        state = SimpleNamespace(
            state="42.5",
            last_changed=t_changed,
            last_updated=t_updated,
        )
        timeline = numeric_timeline([state])
        self.assertEqual(len(timeline), 1)
        self.assertEqual(timeline[0][0], t_updated.astimezone())
        self.assertEqual(timeline[0][1], 42.5)

    def test_numeric_timeline_falls_back_to_last_changed(self) -> None:
        t_changed = datetime(2026, 5, 10, 10, 0, tzinfo=timezone.utc)
        state = SimpleNamespace(
            state="42.5",
            last_changed=t_changed,
        )
        timeline = numeric_timeline([state])
        self.assertEqual(len(timeline), 1)
        self.assertEqual(timeline[0][0], t_changed.astimezone())
        self.assertEqual(timeline[0][1], 42.5)

    def test_numeric_timeline_drops_non_numeric_by_default(self) -> None:
        t1 = datetime(2026, 5, 10, 10, 0, tzinfo=timezone.utc)
        t2 = datetime(2026, 5, 10, 10, 1, tzinfo=timezone.utc)
        states = [
            SimpleNamespace(state="unavailable", last_updated=t1),
            SimpleNamespace(state="12.0", last_updated=t2),
        ]
        timeline = numeric_timeline(states)
        self.assertEqual(len(timeline), 1)
        self.assertEqual(timeline[0][1], 12.0)

    def test_numeric_timeline_keeps_non_numeric_when_asked(self) -> None:
        t1 = datetime(2026, 5, 10, 10, 0, tzinfo=timezone.utc)
        t2 = datetime(2026, 5, 10, 10, 1, tzinfo=timezone.utc)
        states = [
            SimpleNamespace(state="unavailable", last_updated=t1),
            SimpleNamespace(state="12.0", last_updated=t2),
        ]
        timeline = numeric_timeline(states, keep_non_numeric=True)
        self.assertEqual(len(timeline), 2)
        self.assertIsNone(timeline[0][1])
        self.assertEqual(timeline[1][1], 12.0)

    def test_numeric_timeline_sorts_by_timestamp(self) -> None:
        t1 = datetime(2026, 5, 10, 10, 0, tzinfo=timezone.utc)
        t2 = datetime(2026, 5, 10, 9, 0, tzinfo=timezone.utc)
        states = [
            SimpleNamespace(state="10", last_updated=t1),
            SimpleNamespace(state="20", last_updated=t2),
        ]
        timeline = numeric_timeline(states)
        self.assertEqual(timeline[0][1], 20.0)
        self.assertEqual(timeline[1][1], 10.0)

    async def test_read_states_empty_ids(self) -> None:
        hass = SimpleNamespace()
        t1 = datetime(2026, 5, 10, 0, 0, tzinfo=PRAGUE)
        t2 = datetime(2026, 5, 11, 0, 0, tzinfo=PRAGUE)
        result = await read_states(hass, [], t1, t2)
        self.assertEqual(result, {})

    async def test_read_states_lowercase_key_fallback(self) -> None:
        t1 = datetime(2026, 5, 10, 0, 0, tzinfo=PRAGUE)
        t2 = datetime(2026, 5, 11, 0, 0, tzinfo=PRAGUE)
        st = SimpleNamespace(state="1", last_updated=t1)
        fake_history = {"sensor.test_entity": [st]}

        class _FakeRecorder:
            async def async_add_executor_job(self, func, *args):
                return func(*args)

            def get_significant_states(self, *args, **kwargs):
                return fake_history

        hass = SimpleNamespace()
        with patch(
            "homeassistant.components.recorder.get_instance",
            return_value=_FakeRecorder(),
        ):
            # Uppercase lookup
            res = await read_states(hass, ["sensor.TEST_ENTITY", "sensor.missing"], t1, t2)
            self.assertEqual(res["sensor.TEST_ENTITY"], [st])
            self.assertEqual(res["sensor.missing"], [])
