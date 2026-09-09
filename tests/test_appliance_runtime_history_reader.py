"""The batched, incremental appliance runtime-history reader (issue #244).

Two claims are under test and they need different kinds of assertion.

Equivalence: whatever hours a full read of the whole lookback would have
reported, a reader that kept its settled days and read only the tail has to
report the same numbers. Every such test compares a warm reader against a cold
one over the *same* recorded states, and asserts on the hours rather than on
the maps being merely equal to each other -- two empty answers agree about
nothing.

Cost: the point of the batch is the number of recorder round-trips and the span
each one asks for, neither of which is visible in the returned hours. The fake
recorder records both.
"""

from __future__ import annotations

import sys
import types
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
TZ = ZoneInfo("Europe/Prague")
UTC = timezone.utc


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

    homeassistant_pkg = sys.modules.get("homeassistant")
    if homeassistant_pkg is None:
        homeassistant_pkg = types.ModuleType("homeassistant")
        sys.modules["homeassistant"] = homeassistant_pkg

    core_mod = sys.modules.get("homeassistant.core")
    if core_mod is None:
        core_mod = types.ModuleType("homeassistant.core")
        sys.modules["homeassistant.core"] = core_mod
    if not hasattr(core_mod, "HomeAssistant"):
        core_mod.HomeAssistant = type("HomeAssistant", (), {})

    components_pkg = sys.modules.get("homeassistant.components")
    if components_pkg is None:
        components_pkg = types.ModuleType("homeassistant.components")
        sys.modules["homeassistant.components"] = components_pkg

    recorder_mod = sys.modules.get("homeassistant.components.recorder")
    if recorder_mod is None:
        recorder_mod = types.ModuleType("homeassistant.components.recorder")
        sys.modules["homeassistant.components.recorder"] = recorder_mod
    if not hasattr(recorder_mod, "get_instance"):
        recorder_mod.get_instance = lambda hass: None

    history_mod = sys.modules.get("homeassistant.components.recorder.history")
    if history_mod is None:
        history_mod = types.ModuleType("homeassistant.components.recorder.history")
        sys.modules["homeassistant.components.recorder.history"] = history_mod
    if not hasattr(history_mod, "state_changes_during_period"):
        history_mod.state_changes_during_period = lambda *args, **kwargs: {}
    if not hasattr(history_mod, "get_significant_states"):
        history_mod.get_significant_states = lambda *args, **kwargs: {}

    util_pkg = sys.modules.get("homeassistant.util")
    if util_pkg is None:
        util_pkg = types.ModuleType("homeassistant.util")
        sys.modules["homeassistant.util"] = util_pkg

    dt_mod = sys.modules.get("homeassistant.util.dt")
    if dt_mod is None:
        dt_mod = types.ModuleType("homeassistant.util.dt")
        sys.modules["homeassistant.util.dt"] = dt_mod
    if not hasattr(dt_mod, "as_local"):
        dt_mod.as_local = lambda value: value
    if not hasattr(dt_mod, "as_utc"):
        dt_mod.as_utc = lambda value: value
    util_pkg.dt = dt_mod

    # A sibling test may have installed a fake recorder module; drop it so the
    # real module (with the reader under test) is imported.
    sys.modules.pop("custom_components.helman.recorder_hourly_series", None)


_install_import_stubs()

from custom_components.helman import recorder_hourly_series  # noqa: E402
from custom_components.helman.recorder_hourly_series import (  # noqa: E402
    ApplianceRuntimeHistoryReader,
    ApplianceRuntimeRequest,
)


class _FakeDtUtil:
    tz = TZ

    @classmethod
    def as_local(cls, value: datetime) -> datetime:
        if value.tzinfo == cls.tz:
            return value
        return value.astimezone(cls.tz)

    @staticmethod
    def as_utc(value: datetime) -> datetime:
        if value.tzinfo == UTC:
            return value
        return value.astimezone(UTC)


async def _inline_executor_job(func, *args):
    return func(*args)


def _make_hass() -> SimpleNamespace:
    return SimpleNamespace(states=SimpleNamespace(get=lambda entity_id: None))


def _state(instant: datetime, value: str) -> SimpleNamespace:
    return SimpleNamespace(
        state=value,
        attributes={},
        last_updated=_FakeDtUtil.as_utc(instant),
    )


def _runs(
    *spans: tuple[datetime, datetime], value: str = "on"
) -> list[SimpleNamespace]:
    """State rows for a series of active spans, off in between."""
    rows: list[SimpleNamespace] = []
    for span_start, span_end in spans:
        rows.append(_state(span_start, value))
        rows.append(_state(span_end, "off"))
    return sorted(rows, key=lambda row: row.last_updated)


class _Recorder:
    """Several entities' history, honouring the real window bounds.

    ``get_significant_states`` keeps rows stamped at or after the start and
    strictly before the end, and replays the row in force at the window start
    stamped with the start itself. That last part is what a resumed read leans
    on for the state carried into its first day.
    """

    def __init__(self, states_by_entity: dict[str, list[SimpleNamespace]]) -> None:
        self.states_by_entity = states_by_entity
        #: One entry per query: ``(start, end, tuple of entity ids)``.
        self.queries: list[tuple[datetime, datetime, tuple[str, ...]]] = []
        self.rows_returned = 0
        self.fail_next = False

    def get_significant_states(self, _hass, start, end, *, entity_ids, **_kwargs):
        if self.fail_next:
            self.fail_next = False
            raise RuntimeError("database is locked")
        self.queries.append((start, end, tuple(entity_ids)))
        history: dict[str, list[SimpleNamespace]] = {}
        for entity_id in entity_ids:
            states = self.states_by_entity.get(entity_id, [])
            window = [row for row in states if start <= row.last_updated < end]
            earlier = [row for row in states if row.last_updated < start]
            if earlier:
                window.insert(
                    0,
                    SimpleNamespace(
                        state=earlier[-1].state,
                        attributes=earlier[-1].attributes,
                        last_updated=start,
                    ),
                )
            history[entity_id] = window
            self.rows_returned += len(window)
        return history

    @property
    def spans(self) -> list[tuple[datetime, datetime]]:
        return [(start, end) for start, end, _ in self.queries]


class _ReaderHarness(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._dt_patcher = patch.object(recorder_hourly_series, "dt_util", _FakeDtUtil)
        cls._dt_patcher.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._dt_patcher.stop()
        _FakeDtUtil.tz = TZ

    def setUp(self) -> None:
        _FakeDtUtil.tz = TZ

    async def _query(self, reader, recorder, requests, *, at):
        with (
            patch.object(
                recorder_hourly_series,
                "get_significant_states",
                recorder.get_significant_states,
            ),
            patch.object(
                recorder_hourly_series,
                "get_instance",
                lambda hass: SimpleNamespace(
                    async_add_executor_job=_inline_executor_job
                ),
            ),
        ):
            return await reader.async_query_active_hours_by_local_date(
                requests, reference_time=at
            )

    def _rounded(self, hours_by_date: dict[date, float]) -> dict[date, float]:
        return {day: round(hours, 6) for day, hours in hours_by_date.items()}


def _request(key, entity_id, active_states=("on",), lookback_days=3):
    return ApplianceRuntimeRequest(
        key=key,
        entity_id=entity_id,
        active_states=active_states,
        lookback_days=lookback_days,
    )


DAY = datetime(2026, 5, 10, 0, 0, tzinfo=TZ)


def _at(day_offset: int, hour: int, minute: int = 0) -> datetime:
    return datetime(2026, 5, 10, hour, minute, tzinfo=TZ) + timedelta(days=day_offset)


class QueryCountTests(_ReaderHarness):
    """Round-trips follow the windows, not the appliance count."""

    def _fixture(self, appliance_count: int):
        states_by_entity = {}
        requests = []
        for index in range(appliance_count):
            entity_id = f"switch.appliance_{index}"
            states_by_entity[entity_id] = _runs(
                (_at(-3, 9), _at(-3, 11)),
                (_at(-2, 9), _at(-2, 10)),
                (_at(-1, 8), _at(-1, 12)),
                (_at(0, 7), _at(0, 9)),
            )
            requests.append(_request(f"appliance-{index}", entity_id))
        return states_by_entity, requests

    async def test_ten_appliances_are_one_query_and_the_tail_is_one_more(self) -> None:
        states_by_entity, requests = self._fixture(10)
        recorder = _Recorder(states_by_entity)
        reader = ApplianceRuntimeHistoryReader(_make_hass())

        first = await self._query(reader, recorder, requests, at=_at(0, 12))
        second = await self._query(reader, recorder, requests, at=_at(0, 12, 15))

        # One read for ten appliances, then one more for the tail -- the old
        # per-appliance loop issued ten of each.
        self.assertEqual(len(recorder.queries), 2)
        self.assertEqual(len(recorder.queries[0][2]), 10)
        self.assertEqual(
            recorder.spans[0],
            (
                _FakeDtUtil.as_utc(_at(-3, 0)),
                _FakeDtUtil.as_utc(_at(0, 12)),
            ),
        )
        # The second read opens at today's midnight: the three earlier days are
        # settled and kept.
        self.assertEqual(
            recorder.spans[1],
            (
                _FakeDtUtil.as_utc(_at(0, 0)),
                _FakeDtUtil.as_utc(_at(0, 12, 15)),
            ),
        )
        self.assertEqual(
            self._rounded(second["appliance-0"]),
            {
                date(2026, 5, 7): 2.0,
                date(2026, 5, 8): 1.0,
                date(2026, 5, 9): 4.0,
                date(2026, 5, 10): 2.0,
            },
        )
        self.assertEqual(first["appliance-0"], second["appliance-0"])

    async def test_the_tail_read_returns_far_fewer_rows(self) -> None:
        states_by_entity, requests = self._fixture(4)
        recorder = _Recorder(states_by_entity)
        reader = ApplianceRuntimeHistoryReader(_make_hass())

        await self._query(reader, recorder, requests, at=_at(0, 12))
        cold_rows = recorder.rows_returned
        recorder.rows_returned = 0
        await self._query(reader, recorder, requests, at=_at(0, 12, 15))

        self.assertLess(recorder.rows_returned, cold_rows)


class EquivalenceTests(_ReaderHarness):
    """A resumed read reports what a full read would have reported."""

    async def _cold(self, recorder_states, requests, *, at):
        recorder = _Recorder(recorder_states)
        reader = ApplianceRuntimeHistoryReader(_make_hass())
        return await self._query(reader, recorder, requests, at=at)

    async def test_warm_matches_cold_over_a_day_of_refreshes(self) -> None:
        states = {
            "switch.pool": _runs(
                (_at(-3, 22), _at(-2, 1)),  # spans midnight
                (_at(-2, 13, 30), _at(-2, 14, 45)),
                (_at(-1, 6), _at(-1, 6, 30)),
                (_at(0, 5), _at(0, 11, 15)),
            )
        }
        requests = [_request("pool", "switch.pool")]
        recorder = _Recorder(states)
        reader = ApplianceRuntimeHistoryReader(_make_hass())

        warm = None
        for minute in range(0, 60, 15):
            warm = await self._query(
                reader, recorder, requests, at=_at(0, 11, minute)
            )
        cold = await self._cold(states, requests, at=_at(0, 11, 45))

        self.assertEqual(self._rounded(warm["pool"]), self._rounded(cold["pool"]))
        # Value-precise, so an accidentally empty pair of maps cannot pass.
        self.assertEqual(
            self._rounded(warm["pool"]),
            {
                date(2026, 5, 7): 2.0,
                date(2026, 5, 8): 2.25,
                date(2026, 5, 9): 0.5,
                date(2026, 5, 10): 6.25,
            },
        )

    async def test_a_run_still_going_at_midnight_is_split_across_the_days(self) -> None:
        states = {"switch.pool": _runs((_at(-1, 23), _at(0, 2)))}
        requests = [_request("pool", "switch.pool")]
        recorder = _Recorder(states)
        reader = ApplianceRuntimeHistoryReader(_make_hass())

        # First refresh happens while the run is still in progress, so the
        # freeze has to happen without the run's end being known.
        await self._query(reader, recorder, requests, at=_at(0, 1))
        warm = await self._query(reader, recorder, requests, at=_at(0, 4))
        cold = await self._cold(states, requests, at=_at(0, 4))

        self.assertEqual(self._rounded(warm["pool"]), self._rounded(cold["pool"]))
        self.assertEqual(
            self._rounded(warm["pool"]),
            {
                date(2026, 5, 7): 0.0,
                date(2026, 5, 8): 0.0,
                date(2026, 5, 9): 1.0,
                date(2026, 5, 10): 2.0,
            },
        )

    async def test_a_settled_idle_day_stays_an_explicit_zero(self) -> None:
        states = {"switch.pool": _runs((_at(-3, 9), _at(-3, 10)))}
        requests = [_request("pool", "switch.pool")]
        recorder = _Recorder(states)
        reader = ApplianceRuntimeHistoryReader(_make_hass())

        await self._query(reader, recorder, requests, at=_at(0, 12))
        warm = await self._query(reader, recorder, requests, at=_at(0, 12, 15))

        self.assertEqual(
            self._rounded(warm["pool"]),
            {
                date(2026, 5, 7): 1.0,
                date(2026, 5, 8): 0.0,
                date(2026, 5, 9): 0.0,
                date(2026, 5, 10): 0.0,
            },
        )

    async def test_the_carry_into_the_tail_survives_the_resume(self) -> None:
        """A run that opened before the tail window still counts inside it.

        The tail read starts at today's midnight and the switch went on the
        evening before, so the only evidence it is running is the row the
        recorder replays at the window start.
        """
        states = {"switch.pool": _runs((_at(-1, 20), _at(0, 3)))}
        requests = [_request("pool", "switch.pool")]
        recorder = _Recorder(states)
        reader = ApplianceRuntimeHistoryReader(_make_hass())

        await self._query(reader, recorder, requests, at=_at(-1, 23))
        warm = await self._query(reader, recorder, requests, at=_at(0, 12))
        cold = await self._cold(states, requests, at=_at(0, 12))

        self.assertEqual(self._rounded(warm["pool"]), self._rounded(cold["pool"]))
        self.assertEqual(warm["pool"][date(2026, 5, 10)], 3.0)

    async def test_spring_forward_day_counts_wall_clock_hours(self) -> None:
        dst_day = datetime(2026, 3, 29, 0, 0, tzinfo=TZ)
        run_start = dst_day + timedelta(hours=1)  # 01:00, before the gap
        run_end = dst_day.replace(hour=4)  # 04:00 local, two real hours later
        states = {"switch.pool": _runs((run_start, run_end))}
        requests = [_request("pool", "switch.pool", lookback_days=2)]
        recorder = _Recorder(states)
        reader = ApplianceRuntimeHistoryReader(_make_hass())

        at_noon = dst_day.replace(hour=12)
        await self._query(reader, recorder, requests, at=dst_day.replace(hour=5))
        warm = await self._query(reader, recorder, requests, at=at_noon)
        cold = await self._cold(states, requests, at=at_noon)

        self.assertEqual(self._rounded(warm["pool"]), self._rounded(cold["pool"]))
        self.assertEqual(
            self._rounded(warm["pool"]),
            {
                date(2026, 3, 27): 0.0,
                date(2026, 3, 28): 0.0,
                # 01:00 to 04:00 local is two real hours on the day the clocks jump.
                date(2026, 3, 29): 2.0,
            },
        )


class SharedEntityTests(_ReaderHarness):
    async def test_one_entity_two_active_state_sets_is_one_read_two_answers(
        self,
    ) -> None:
        states = {
            "climate.heat_pump": sorted(
                [
                    _state(_at(-1, 8), "heat"),
                    _state(_at(-1, 10), "off"),
                    _state(_at(-1, 14), "cool"),
                    _state(_at(-1, 15), "off"),
                ],
                key=lambda row: row.last_updated,
            )
        }
        requests = [
            _request("heating", "climate.heat_pump", active_states=("heat",)),
            _request("cooling", "climate.heat_pump", active_states=("cool",)),
            _request("either", "climate.heat_pump", active_states=("heat", "cool")),
        ]
        recorder = _Recorder(states)
        reader = ApplianceRuntimeHistoryReader(_make_hass())

        result = await self._query(reader, recorder, requests, at=_at(0, 12))

        self.assertEqual(len(recorder.queries), 1)
        self.assertEqual(recorder.queries[0][2], ("climate.heat_pump",))
        self.assertEqual(result["heating"][date(2026, 5, 9)], 2.0)
        self.assertEqual(result["cooling"][date(2026, 5, 9)], 1.0)
        self.assertEqual(result["either"][date(2026, 5, 9)], 3.0)

    async def test_the_same_states_spelled_differently_share_one_key(self) -> None:
        states = {"switch.pool": _runs((_at(-1, 8), _at(-1, 9)))}
        requests = [
            _request("a", "switch.pool", active_states=("on",)),
            _request("b", "switch.pool", active_states=(" ON ",)),
        ]
        recorder = _Recorder(states)
        reader = ApplianceRuntimeHistoryReader(_make_hass())

        result = await self._query(reader, recorder, requests, at=_at(0, 12))

        self.assertEqual(len(recorder.queries), 1)
        self.assertEqual(result["a"], result["b"])
        self.assertEqual(result["a"][date(2026, 5, 9)], 1.0)


class LookbackTests(_ReaderHarness):
    async def test_a_long_lookback_does_not_widen_a_short_one(self) -> None:
        states = {
            "switch.short": _runs((_at(-1, 8), _at(-1, 9))),
            "switch.long": _runs((_at(-10, 8), _at(-10, 9))),
        }
        requests = [
            _request("short", "switch.short", lookback_days=1),
            _request("long", "switch.long", lookback_days=14),
        ]
        recorder = _Recorder(states)
        reader = ApplianceRuntimeHistoryReader(_make_hass())

        result = await self._query(reader, recorder, requests, at=_at(0, 12))

        self.assertEqual(len(recorder.queries), 2)
        spans = {query[2]: (query[0], query[1]) for query in recorder.queries}
        self.assertEqual(
            spans[("switch.short",)][0], _FakeDtUtil.as_utc(_at(-1, 0))
        )
        self.assertEqual(
            spans[("switch.long",)][0],
            _FakeDtUtil.as_utc(datetime(2026, 4, 26, 0, 0, tzinfo=TZ)),
        )
        # The short appliance never sees the fortnight of days the long one needs.
        self.assertEqual(
            sorted(result["short"]), [date(2026, 5, 9), date(2026, 5, 10)]
        )
        self.assertEqual(len(result["long"]), 15)

    async def test_two_lookbacks_on_the_same_entity_are_trimmed_apart(self) -> None:
        states = {
            "switch.pool": _runs((_at(-5, 8), _at(-5, 9)), (_at(-1, 8), _at(-1, 9)))
        }
        requests = [
            _request("near", "switch.pool", lookback_days=2),
            _request("far", "switch.pool", lookback_days=6),
        ]
        recorder = _Recorder(states)
        reader = ApplianceRuntimeHistoryReader(_make_hass())

        result = await self._query(reader, recorder, requests, at=_at(0, 12))

        self.assertEqual(len(recorder.queries), 1)
        self.assertNotIn(date(2026, 5, 5), result["near"])
        self.assertEqual(result["far"][date(2026, 5, 5)], 1.0)
        self.assertEqual(result["near"][date(2026, 5, 9)], 1.0)

    async def test_a_widened_lookback_rereads_the_days_it_gained(self) -> None:
        states = {
            "switch.pool": _runs((_at(-5, 8), _at(-5, 9)), (_at(-1, 8), _at(-1, 9)))
        }
        recorder = _Recorder(states)
        reader = ApplianceRuntimeHistoryReader(_make_hass())

        await self._query(
            reader, recorder, [_request("pool", "switch.pool", lookback_days=2)],
            at=_at(0, 12),
        )
        widened = await self._query(
            reader, recorder, [_request("pool", "switch.pool", lookback_days=6)],
            at=_at(0, 12, 15),
        )

        self.assertEqual(recorder.spans[1][0], _FakeDtUtil.as_utc(_at(-6, 0)))
        self.assertEqual(widened["pool"][date(2026, 5, 5)], 1.0)


class InvalidationTests(_ReaderHarness):
    def _pool_states(self):
        return {"switch.pool": _runs((_at(-1, 8), _at(-1, 9)), (_at(0, 8), _at(0, 9)))}

    async def test_yesterday_is_reread_until_the_write_margin_has_passed(self) -> None:
        recorder = _Recorder(self._pool_states())
        reader = ApplianceRuntimeHistoryReader(_make_hass())
        requests = [_request("pool", "switch.pool", lookback_days=1)]

        await self._query(reader, recorder, requests, at=_at(0, 0, 10))
        await self._query(reader, recorder, requests, at=_at(0, 0, 20))
        # Ten past midnight: nothing the recorder wrote for yesterday is
        # guaranteed committed yet, so yesterday is still in the window.
        self.assertEqual(recorder.spans[1][0], _FakeDtUtil.as_utc(_at(-1, 0)))

        await self._query(reader, recorder, requests, at=_at(0, 0, 40))
        await self._query(reader, recorder, requests, at=_at(0, 0, 45))
        self.assertEqual(recorder.spans[3][0], _FakeDtUtil.as_utc(_at(0, 0)))

    async def test_a_late_write_for_yesterday_still_lands(self) -> None:
        """A row stamped before midnight but committed after it is not lost."""
        recorder = _Recorder({"switch.pool": []})
        reader = ApplianceRuntimeHistoryReader(_make_hass())
        requests = [_request("pool", "switch.pool", lookback_days=1)]

        await self._query(reader, recorder, requests, at=_at(0, 0, 10))
        recorder.states_by_entity["switch.pool"] = _runs((_at(-1, 22), _at(-1, 23)))
        late = await self._query(reader, recorder, requests, at=_at(0, 0, 20))

        self.assertEqual(late["pool"][date(2026, 5, 9)], 1.0)

    async def test_a_failed_read_is_retried_rather_than_settled_as_zero(self) -> None:
        recorder = _Recorder(self._pool_states())
        reader = ApplianceRuntimeHistoryReader(_make_hass())
        requests = [_request("pool", "switch.pool", lookback_days=2)]

        recorder.fail_next = True
        failed = await self._query(reader, recorder, requests, at=_at(0, 12))
        self.assertNotIn("pool", failed)

        retried = await self._query(reader, recorder, requests, at=_at(0, 12, 15))
        self.assertEqual(recorder.spans[-1][0], _FakeDtUtil.as_utc(_at(-2, 0)))
        self.assertEqual(retried["pool"][date(2026, 5, 9)], 1.0)
        self.assertEqual(retried["pool"][date(2026, 5, 10)], 1.0)

    async def test_a_changed_active_state_set_discards_the_prefix(self) -> None:
        recorder = _Recorder(self._pool_states())
        reader = ApplianceRuntimeHistoryReader(_make_hass())

        await self._query(
            reader, recorder, [_request("pool", "switch.pool", lookback_days=2)],
            at=_at(0, 12),
        )
        await self._query(
            reader,
            recorder,
            [
                _request(
                    "pool", "switch.pool", active_states=("heat",), lookback_days=2
                )
            ],
            at=_at(0, 12, 15),
        )

        self.assertEqual(recorder.spans[1][0], _FakeDtUtil.as_utc(_at(-2, 0)))

    async def test_a_changed_entity_discards_the_prefix_and_is_not_kept(self) -> None:
        states = self._pool_states()
        states["switch.pool_new"] = states["switch.pool"]
        recorder = _Recorder(states)
        reader = ApplianceRuntimeHistoryReader(_make_hass())

        await self._query(
            reader, recorder, [_request("pool", "switch.pool", lookback_days=2)],
            at=_at(0, 12),
        )
        self.assertEqual(len(reader._settled), 1)
        await self._query(
            reader, recorder, [_request("pool", "switch.pool_new", lookback_days=2)],
            at=_at(0, 12, 15),
        )

        self.assertEqual(recorder.spans[1][0], _FakeDtUtil.as_utc(_at(-2, 0)))
        # The abandoned entity's prefix is dropped rather than kept forever.
        self.assertEqual(
            [key[0] for key in reader._settled], ["switch.pool_new"]
        )

    async def test_a_timezone_change_discards_the_prefix(self) -> None:
        recorder = _Recorder(self._pool_states())
        reader = ApplianceRuntimeHistoryReader(_make_hass())
        requests = [_request("pool", "switch.pool", lookback_days=2)]

        await self._query(reader, recorder, requests, at=_at(0, 12))
        _FakeDtUtil.tz = ZoneInfo("America/New_York")
        try:
            await self._query(reader, recorder, requests, at=_at(0, 12, 15))
        finally:
            _FakeDtUtil.tz = TZ

        self.assertEqual(len(recorder.queries), 2)
        self.assertLess(recorder.spans[1][0], recorder.spans[0][1])
        self.assertEqual(
            recorder.spans[1][0],
            _FakeDtUtil.as_utc(
                datetime(2026, 5, 8, 0, 0, tzinfo=ZoneInfo("America/New_York"))
            ),
        )

    async def test_a_clock_that_stepped_backwards_discards_the_prefix(self) -> None:
        recorder = _Recorder(self._pool_states())
        reader = ApplianceRuntimeHistoryReader(_make_hass())
        requests = [_request("pool", "switch.pool", lookback_days=2)]

        await self._query(reader, recorder, requests, at=_at(0, 12))
        await self._query(reader, recorder, requests, at=_at(-1, 12))

        self.assertEqual(recorder.spans[1][0], _FakeDtUtil.as_utc(_at(-3, 0)))

    async def test_a_request_with_no_active_states_asks_nothing(self) -> None:
        recorder = _Recorder(self._pool_states())
        reader = ApplianceRuntimeHistoryReader(_make_hass())

        result = await self._query(
            reader,
            recorder,
            [_request("pool", "switch.pool", active_states=())],
            at=_at(0, 12),
        )

        self.assertEqual(recorder.queries, [])
        self.assertEqual(result, {"pool": {}})


if __name__ == "__main__":
    unittest.main()
