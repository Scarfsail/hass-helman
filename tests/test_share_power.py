"""Live share power: a meterless child's part of its parent's own power.

The AC breaker meters four air conditioners together. Each one's live power is
the breaker's *own* power — its reading minus its metered children's — split
evenly among whichever of them are running, and the breaker's remainder is own
power minus those shares. The tree is built by the real tree builder and the
split computed by the real coordinator, so the wiring between the two is what
is tested, not a hand-written tree.
"""

from __future__ import annotations

import asyncio
import importlib
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import mock

_ROOT = os.path.dirname(os.path.dirname(__file__))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)
try:
    coordinator_module = importlib.import_module("custom_components.helman.coordinator")
    tree_builder = importlib.import_module("custom_components.helman.tree_builder")
    recorder_module = importlib.import_module(
        "custom_components.helman.recorder_hourly_series"
    )
    appliance_energy_module = importlib.import_module(
        "custom_components.helman.training.appliance_energy"
    )
except Exception:  # pragma: no cover - environment guard
    coordinator_module = None

HOUSE = "sensor.house_power"
BREAKER_POWER = "sensor.breaker_power"
HEATER_POWER = "sensor.heater_power"
BREAKER = "sensor.breaker_energy"
REMAINDER = "sensor.helman_unmeasured_power_breaker_energy"
ROOMS = ("obyvak", "bartik", "adelka")


def _share(room: str) -> str:
    return f"sensor.helman_share_power_klima_{room}"


def _devices(*, metered_child: bool = False) -> list[dict]:
    children: list[dict] = [
        {
            "id": f"klima-{room}",
            "kind": "climate",
            "schedulable": True,
            "controls": {"climate": {"entity_id": f"climate.{room}"}},
        }
        for room in ROOMS
    ]
    if metered_child:
        children.insert(
            0,
            {
                "id": "heater",
                "consumption": {
                    "energy_entity_id": "sensor.heater_energy",
                    "power_entity_id": HEATER_POWER,
                },
            },
        )
    return [
        {
            "id": "breaker",
            "consumption": {
                "energy_entity_id": BREAKER,
                "power_entity_id": BREAKER_POWER,
            },
            "children": children,
        }
    ]


class _States:
    def __init__(self, mapping: dict[str, str]) -> None:
        self.mapping = mapping

    def get(self, entity_id: str):
        raw = self.mapping.get(entity_id)
        if raw is None:
            return None
        return SimpleNamespace(state=raw, attributes={})


class _Registry:
    entities: dict = {}

    def async_get(self, entity_id):
        return None

    def async_get_label(self, label_id):
        return None


class _Sensor:
    def __init__(self) -> None:
        self.values: list[float | None] = []

    def update_value(self, watts: float | None) -> None:
        self.values.append(watts)


def _make_coordinator(states: dict[str, str], *, metered_child: bool = False):
    config = {
        "visualization": {"history_buckets": 60, "history_bucket_duration": 1},
        "power_devices": {"house": {"entities": {"power": HOUSE}}},
        "devices": _devices(metered_child=metered_child),
    }
    hass = SimpleNamespace(states=_States(states))
    with mock.patch.object(tree_builder.er, "async_get", lambda _hass: _Registry()), \
            mock.patch.object(tree_builder.lr, "async_get", lambda _hass: _Registry()):
        tree = asyncio.run(tree_builder.HelmanTreeBuilder(hass, config).build())

    c = object.__new__(coordinator_module.HelmanCoordinator)
    c._active_config = config
    c._hass = hass
    c._cached_tree = tree
    c._unmeasured_raw_history = {}
    c._power_sensor_ids = c._collect_power_sensor_ids(tree)
    c._source_ratio_entity_ids = {}
    c._init_buffers(tree)
    return c


def _tick(c) -> tuple[dict, dict]:
    unmeasured, shares = c._compute_derived_powers()
    by_entity = {
        entity_id: shares[node_id] for node_id, entity_id in c._share_entity_id_map.items()
    }
    return unmeasured[BREAKER], by_entity


@unittest.skipIf(coordinator_module is None, "homeassistant not importable in this environment")
class SharePowerTests(unittest.TestCase):
    def _run(self, running: tuple[str, ...], *, extra: dict[str, str] | None = None):
        states = {
            HOUSE: "3000",
            BREAKER_POWER: "1000",
            **{f"climate.{room}": "heat" if room in running else "off" for room in ROOMS},
            **(extra or {}),
        }
        c = _make_coordinator(states, metered_child=HEATER_POWER in states)
        return c, _tick(c)

    def test_no_child_running_leaves_everything_on_the_remainder(self) -> None:
        _c, (remainder, shares) = self._run(())

        self.assertEqual(shares, {_share(room): 0.0 for room in ROOMS})
        self.assertEqual(remainder, 1000.0)

    def test_one_running_child_takes_the_whole_own_power(self) -> None:
        _c, (remainder, shares) = self._run(("bartik",))

        self.assertEqual(
            shares,
            {_share("obyvak"): 0.0, _share("bartik"): 1000.0, _share("adelka"): 0.0},
        )
        self.assertEqual(remainder, 0.0)

    def test_three_running_children_split_it_evenly(self) -> None:
        _c, (remainder, shares) = self._run(ROOMS)

        for room in ROOMS:
            self.assertAlmostEqual(shares[_share(room)], 1000.0 / 3)
        self.assertAlmostEqual(sum(shares.values()) + remainder, 1000.0)
        self.assertAlmostEqual(remainder, 0.0)

    def test_shares_are_not_subtracted_and_repeated_ticks_are_stable(self) -> None:
        # The share sensors exist and read back what was published; subtracting
        # them from their own input would shrink every following tick.
        extra = {_share(room): "500" for room in ROOMS}
        extra[REMAINDER] = "0"
        c, first = self._run(("obyvak",), extra=extra)

        for _ in range(30):
            self.assertEqual(_tick(c), first)
        self.assertEqual(first[1][_share("obyvak")], 1000.0)

    def test_a_metered_child_is_subtracted_before_the_split(self) -> None:
        _c, (remainder, shares) = self._run(("obyvak",), extra={HEATER_POWER: "600"})

        self.assertEqual(shares[_share("obyvak")], 400.0)
        self.assertEqual(remainder, 0.0)

    def test_an_unavailable_metered_child_makes_shares_and_remainder_unavailable(self) -> None:
        # Not 1,000 W for the running child and 0 W left over, as reading the
        # missing 600 W heater as 0 W would give.
        _c, (remainder, shares) = self._run(("obyvak",), extra={HEATER_POWER: "unavailable"})

        self.assertEqual(shares, {_share(room): None for room in ROOMS})
        self.assertIsNone(remainder)

    def test_an_unavailable_parent_makes_them_unavailable(self) -> None:
        _c, (remainder, shares) = self._run(("obyvak",), extra={BREAKER_POWER: "unknown"})

        self.assertEqual(shares, {_share(room): None for room in ROOMS})
        self.assertIsNone(remainder)

    def test_a_parent_without_power_publishes_unavailable_shares(self) -> None:
        # No power sensor, so no remainder node: the shares still get a value,
        # and it is unavailable, not a sensor stuck at "unknown".
        c, _ = self._run(("obyvak",))
        del c._active_config["devices"][0]["consumption"]["power_entity_id"]
        with mock.patch.object(tree_builder.er, "async_get", lambda _hass: _Registry()), \
                mock.patch.object(tree_builder.lr, "async_get", lambda _hass: _Registry()):
            c._cached_tree = asyncio.run(
                tree_builder.HelmanTreeBuilder(c._hass, c._active_config).build()
            )
        c._init_buffers(c._cached_tree)

        unmeasured, shares = c._compute_derived_powers()

        self.assertNotIn(BREAKER, unmeasured)
        self.assertEqual(
            {c._share_entity_id_map[node_id]: value for node_id, value in shares.items()},
            {_share(room): None for room in ROOMS},
        )

    def test_the_tick_publishes_unavailable_and_records_zero(self) -> None:
        c, _ = self._run(("obyvak",), extra={HEATER_POWER: "unavailable"})
        c._unmeasured_sensors = {BREAKER: _Sensor()}
        c._share_sensors = {f"klima-{room}": _Sensor() for room in ROOMS}
        c._battery_time_to_full = c._battery_time_to_empty = None
        c._consumption_total_sensor = c._production_total_sensor = None
        c._source_ratio_sensors = {}
        c._source_sensor_ids = []

        c._tick(datetime(2026, 9, 26, 12, 0, 0))

        self.assertEqual(c._unmeasured_sensors[BREAKER].values, [None])
        self.assertEqual(c._share_sensors["klima-obyvak"].values, [None])
        self.assertEqual(list(c._power_history[_share("obyvak")]), [0.0])
        self.assertEqual(list(c._power_history[REMAINDER]), [0.0])


@unittest.skipIf(coordinator_module is None, "homeassistant not importable in this environment")
class RunningPredicateTests(unittest.TestCase):
    """The live split and the history split agree on what "running" is."""

    VALUES = ("on", "off", "heat", "cool", "auto", "dry", "fan_only", "HEAT", " on ",
              "unavailable", "unknown", None)

    def test_the_live_predicate_is_the_one_training_uses(self) -> None:
        start = datetime(2026, 9, 26, tzinfo=timezone.utc)
        for activity, entity_id in (("switch", "switch.plug"), ("climate", "climate.ac")):
            member = appliance_energy_module.SharedMeterMember.for_signal(
                "device", entity_id, activity
            )
            for value in self.VALUES:
                with self.subTest(activity=activity, value=value):
                    trained = bool(
                        recorder_module._build_active_state_intervals(
                            states=[SimpleNamespace(state=value, last_updated=start)],
                            window_start=start,
                            window_end=start + timedelta(hours=1),
                            active_states=member.active_states,
                        )
                    )
                    c = object.__new__(coordinator_module.HelmanCoordinator)
                    c._hass = SimpleNamespace(
                        states=SimpleNamespace(
                            get=lambda _entity_id, value=value: SimpleNamespace(state=value)
                        )
                    )
                    c._share_running_signals = {"device": (entity_id, activity)}

                    self.assertEqual(c._is_share_running("device"), trained)


if __name__ == "__main__":
    unittest.main()
