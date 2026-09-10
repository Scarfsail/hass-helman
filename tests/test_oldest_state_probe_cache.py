"""Where an entity's raw states begin is asked once, not once per reader.

``query_oldest_state_date`` is one indexed ``LIMIT 1`` row, which is cheap, and
the recorder answers every query from a single database executor thread, which
is what makes it expensive anyway: a day open probes both price entities, the
meters a spliced window covers and the forecast entity, and each probe is a
serial round trip in front of the reads the view actually came for. The cache
lives in the probe rather than in any one caller, so these tests pin the
lifetime rules -- an answer held, ``None`` held like any other answer, a failure
raised but retried sooner -- and the two things a cache must not do: serve two
callers with two reads, or outlive the config entry that filled it.
"""

from __future__ import annotations

import asyncio
import sys
import types
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]

PRAGUE = ZoneInfo("Europe/Prague")

#: The stubbed recorder's clock and its raw-state table, plus what it was asked.
RECORDER: dict[str, object] = {
    "now": datetime(2026, 5, 11, 10, 0, tzinfo=PRAGUE),
    "oldest_state": {},
    "error": None,
    "probes": [],
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
        # A real executor hand-off suspends the caller, which is the whole
        # point of the concurrency test below: without a suspension point the
        # second caller would find the answer already cached whether the lock
        # existed or not.
        await asyncio.sleep(0)
        return func(*args)

    recorder_mod = types.ModuleType("homeassistant.components.recorder")
    recorder_mod.get_instance = lambda hass: SimpleNamespace(
        async_add_executor_job=_run_in_executor
    )
    sys.modules["homeassistant.components.recorder"] = recorder_mod

    def _state_changes_during_period(hass, start, end, entity_id, *args, **kwargs):
        RECORDER["probes"].append(entity_id)
        if RECORDER["error"] is not None:
            raise RECORDER["error"]
        oldest = RECORDER["oldest_state"].get(entity_id)
        if oldest is None:
            return {}
        return {entity_id: [SimpleNamespace(last_updated=oldest, state="1.0")]}

    history_mod = types.ModuleType("homeassistant.components.recorder.history")
    history_mod.state_changes_during_period = _state_changes_during_period
    # The sibling raw reader binds this at import time; nothing here reads it.
    history_mod.get_significant_states = lambda *args, **kwargs: {}
    sys.modules["homeassistant.components.recorder.history"] = history_mod

    statistics_mod = types.ModuleType("homeassistant.components.recorder.statistics")
    statistics_mod.statistics_during_period = lambda *args, **kwargs: {}
    sys.modules["homeassistant.components.recorder.statistics"] = statistics_mod

    core_mod = types.ModuleType("homeassistant.core")
    core_mod.HomeAssistant = type("HomeAssistant", (), {})
    core_mod.callback = lambda func: func
    sys.modules["homeassistant.core"] = core_mod

    util_mod = types.ModuleType("homeassistant.util")
    sys.modules["homeassistant.util"] = util_mod
    dt_mod = types.ModuleType("homeassistant.util.dt")
    # The cache's own clock: every test that is about a lifetime moves this
    # rather than waiting.
    dt_mod.now = lambda: RECORDER["now"]
    dt_mod.as_local = lambda value: value.astimezone(PRAGUE)
    dt_mod.as_utc = lambda value: value
    sys.modules["homeassistant.util.dt"] = dt_mod
    util_mod.dt = dt_mod

    sys.modules.pop("custom_components.helman.recorder_hourly_series", None)
    sys.modules.pop("custom_components.helman.recorder_statistics_span", None)


_install_import_stubs()

import importlib  # noqa: E402

span_mod = importlib.import_module("custom_components.helman.recorder_statistics_span")

ENTITY = "sensor.helman_grid_export_price"
OTHER_ENTITY = "sensor.helman_grid_import_price"


def _reset(*, oldest_state=None, error=None) -> None:
    RECORDER["now"] = datetime(2026, 5, 11, 10, 0, tzinfo=PRAGUE)
    RECORDER["oldest_state"] = oldest_state or {}
    RECORDER["error"] = error
    RECORDER["probes"] = []


def _hass():
    """A Home Assistant stub with somewhere for the cache to live."""
    return SimpleNamespace(data={})


async def _ask(hass, entity_id=ENTITY):
    return await span_mod.query_oldest_state_date(hass, entity_id, local_tz=PRAGUE)


class TestCachedAnswers(unittest.IsolatedAsyncioTestCase):
    async def test_repeated_reads_over_the_lifetime_cost_one_probe_per_entity(self):
        _reset(
            oldest_state={
                ENTITY: datetime(2026, 4, 27, 6, 30, tzinfo=PRAGUE),
                OTHER_ENTITY: datetime(2026, 4, 28, 6, 30, tzinfo=PRAGUE),
            }
        )
        hass = _hass()

        for _ in range(3):
            self.assertEqual(await _ask(hass), datetime(2026, 4, 27).date())
            self.assertEqual(
                await _ask(hass, OTHER_ENTITY), datetime(2026, 4, 28).date()
            )

        # Per entity, not per read: the second entity is a separate question and
        # gets its own answer, but neither is asked twice.
        self.assertEqual(RECORDER["probes"], [ENTITY, OTHER_ENTITY])

    async def test_an_expired_answer_is_asked_again(self):
        _reset(oldest_state={ENTITY: datetime(2026, 4, 27, 6, 30, tzinfo=PRAGUE)})
        hass = _hass()

        await _ask(hass)
        RECORDER["now"] += span_mod._OLDEST_STATE_TTL - timedelta(minutes=1)
        await _ask(hass)
        self.assertEqual(RECORDER["probes"], [ENTITY])

        # A purge trims the far end, and past the TTL the reader is told about it.
        RECORDER["now"] += timedelta(minutes=1)
        RECORDER["oldest_state"][ENTITY] = datetime(2026, 5, 4, 0, 5, tzinfo=PRAGUE)
        self.assertEqual(await _ask(hass), datetime(2026, 5, 4).date())
        self.assertEqual(RECORDER["probes"], [ENTITY, ENTITY])

    async def test_no_raw_states_at_all_is_an_answer_and_is_held(self):
        # The most valuable answer to hold: it is what lets a caller skip the
        # raw read entirely, so re-probing for it would cost a round trip to
        # learn nothing on exactly the path the cache exists to make cheap.
        _reset()
        hass = _hass()

        self.assertIsNone(await _ask(hass))
        self.assertIsNone(await _ask(hass))

        self.assertEqual(RECORDER["probes"], [ENTITY])

    async def test_concurrent_readers_share_one_probe(self):
        _reset(oldest_state={ENTITY: datetime(2026, 4, 27, 6, 30, tzinfo=PRAGUE)})
        hass = _hass()

        answers = await asyncio.gather(_ask(hass), _ask(hass), _ask(hass))

        self.assertEqual(answers, [datetime(2026, 4, 27).date()] * 3)
        self.assertEqual(RECORDER["probes"], [ENTITY])

    async def test_a_reload_does_not_inherit_the_answers(self):
        _reset(oldest_state={ENTITY: datetime(2026, 4, 27, 6, 30, tzinfo=PRAGUE)})
        hass = _hass()

        await _ask(hass)
        span_mod.clear_oldest_state_probe_cache(hass)
        await _ask(hass)

        self.assertEqual(RECORDER["probes"], [ENTITY, ENTITY])

    async def test_clearing_an_untouched_instance_is_not_an_error(self):
        span_mod.clear_oldest_state_probe_cache(_hass())


class TestCachedFailures(unittest.IsolatedAsyncioTestCase):
    """A failure is not an answer, and is not treated as one."""

    async def test_a_failure_still_reaches_the_caller(self):
        # The callers handle a raised probe themselves -- the price reader skips
        # that entity's raw tier, the depth probe reports nothing -- so a
        # swallowed failure here would be read as "this entity has no raw
        # states", which is a different fact entirely.
        _reset(error=RuntimeError("recorder busy"))
        hass = _hass()

        with self.assertRaisesRegex(RuntimeError, "recorder busy"):
            await _ask(hass)
        with self.assertRaisesRegex(RuntimeError, "recorder busy"):
            await _ask(hass)

        # And the second caller was told so without a second round trip: a
        # recorder failing under load must not be asked again by every request.
        self.assertEqual(RECORDER["probes"], [ENTITY])

    async def test_a_failure_is_retried_sooner_than_an_answer_is_refreshed(self):
        _reset(error=RuntimeError("recorder busy"))
        hass = _hass()

        with self.assertRaises(RuntimeError):
            await _ask(hass)

        RECORDER["now"] += span_mod._OLDEST_STATE_RETRY
        RECORDER["error"] = None
        RECORDER["oldest_state"] = {ENTITY: datetime(2026, 4, 27, 6, 30, tzinfo=PRAGUE)}

        # Well inside the six-hour TTL, and asked again anyway: a moment's
        # unavailability must not pin the recorder's silence for a session.
        self.assertLess(span_mod._OLDEST_STATE_RETRY, span_mod._OLDEST_STATE_TTL)
        self.assertEqual(await _ask(hass), datetime(2026, 4, 27).date())
        self.assertEqual(RECORDER["probes"], [ENTITY, ENTITY])

    async def test_a_later_failure_serves_the_answer_it_already_had(self):
        _reset(oldest_state={ENTITY: datetime(2026, 4, 27, 6, 30, tzinfo=PRAGUE)})
        hass = _hass()

        self.assertEqual(await _ask(hass), datetime(2026, 4, 27).date())

        RECORDER["now"] += span_mod._OLDEST_STATE_TTL
        RECORDER["error"] = RuntimeError("recorder busy")

        # A coverage date already learned beats a hard failure. Two of the
        # callers have no guard of their own, and a blip the recorder has
        # already recovered from must not fail every span read for five minutes.
        self.assertEqual(await _ask(hass), datetime(2026, 4, 27).date())

        # Still remembered as a failure, though: the recorder is not asked again
        # until the retry window has passed, and then it is.
        self.assertEqual(RECORDER["probes"], [ENTITY, ENTITY])
        RECORDER["now"] += span_mod._OLDEST_STATE_RETRY
        RECORDER["error"] = None
        self.assertEqual(await _ask(hass), datetime(2026, 4, 27).date())
        self.assertEqual(RECORDER["probes"], [ENTITY, ENTITY, ENTITY])

    async def test_a_cancelled_probe_is_not_stamped_as_an_answer(self):
        # CancelledError is a BaseException, so it misses ``except Exception``.
        # Stamping the attempt anyway would leave the probe looking freshly
        # answered with ``None`` -- the one answer that skips the raw read --
        # for the whole six-hour lifetime, on nothing worse than a browser
        # closing the inspector mid-request.
        _reset(error=asyncio.CancelledError())
        hass = _hass()

        with self.assertRaises(asyncio.CancelledError):
            await _ask(hass)

        RECORDER["error"] = None
        RECORDER["oldest_state"] = {ENTITY: datetime(2026, 4, 27, 6, 30, tzinfo=PRAGUE)}
        self.assertEqual(await _ask(hass), datetime(2026, 4, 27).date())
        self.assertEqual(RECORDER["probes"], [ENTITY, ENTITY])

    async def test_a_held_failure_does_not_grow_a_traceback_per_caller(self):
        # One held instance, raised again for every request in the window:
        # raising an exception that already carries a traceback appends to it,
        # so the depth would climb per request and every frame it came from --
        # the recorder closure and its ``hass`` -- would stay pinned in
        # ``hass.data`` for the whole of it.
        _reset(error=RuntimeError("recorder busy"))
        hass = _hass()

        depths = []
        for _ in range(4):
            try:
                await _ask(hass)
            except RuntimeError as err:
                depth = 0
                traceback = err.__traceback__
                while traceback is not None:
                    depth += 1
                    traceback = traceback.tb_next
                depths.append(depth)

        self.assertEqual(len(set(depths)), 1, depths)


if __name__ == "__main__":
    unittest.main()
