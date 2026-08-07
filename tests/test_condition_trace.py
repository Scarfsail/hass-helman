"""The HA condition trace behind an optimizer's ``custom`` conditions.

Runs against the *real* Home Assistant condition machinery — the whole point of
the feature is that HA's own instrumentation is what produces the tree, so a
stubbed checker would assert nothing about the paths, the recorded readings or
the short-circuit. A ``hass`` with states and a bus is all the built-in
``state``/``numeric_state``/``and``/``or``/``time`` conditions ever touch.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from homeassistant.core import State  # noqa: E402

from custom_components.helman.const import DOMAIN  # noqa: E402
from custom_components.helman.automation.condition_trace import (  # noqa: E402
    evaluate_traced,
    extract_entity_ids,
    read_entity_states,
)
from custom_components.helman.coordinator import HelmanCoordinator  # noqa: E402
from custom_components.helman.websockets import ws_get_condition_trace  # noqa: E402


class FakeBus:
    """Only ever asked to register listeners (by the entity registry)."""

    def async_listen(self, *args, **kwargs):
        return lambda: None

    def async_listen_once(self, *args, **kwargs):
        return lambda: None


class FakeStates:
    def __init__(self, states: dict[str, State]) -> None:
        self._states = states

    def get(self, entity_id: str) -> State | None:
        return self._states.get(entity_id)


class FakeHass:
    def __init__(
        self,
        states: dict[str, str] | None = None,
        attributes: dict[str, dict] | None = None,
    ) -> None:
        self.bus = FakeBus()
        self.states = FakeStates(
            {
                entity_id: State(entity_id, value, (attributes or {}).get(entity_id))
                for entity_id, value in (states or {}).items()
            }
        )
        self.data: dict = {}
        self.config = SimpleNamespace(
            time_zone="Europe/Prague", config_dir=str(ROOT / ".pytest-hass")
        )


class FakeStorage:
    def __init__(self, config: dict) -> None:
        self.config = config
        self.schedule_document: dict = {}


class FakeConnection:
    def __init__(self, *, is_admin: bool = True) -> None:
        self.user = SimpleNamespace(is_admin=is_admin)
        self.results: list[tuple[int, object]] = []
        self.errors: list[tuple[int, str, str]] = []

    def send_result(self, msg_id: int, result: object) -> None:
        self.results.append((msg_id, result))

    def send_error(self, msg_id: int, code: str, message: str) -> None:
        self.errors.append((msg_id, code, message))


def _optimizer(*groups: dict) -> dict:
    return {"id": "export", "kind": "export_price", "conditions": list(groups)}


def _coordinator(hass: FakeHass, *optimizers: dict) -> HelmanCoordinator:
    config = {"automation": {"optimizers": list(optimizers)}}
    coordinator = HelmanCoordinator(hass, FakeStorage(config))
    coordinator._active_config = config
    return coordinator


async def _build_checker(hass: FakeHass, entry: dict):
    """One entry's checker, built exactly as the coordinator builds it."""
    checker, _entity_ids = await _build_checker_and_entities(hass, entry)
    return checker


async def _build_checker_and_entities(hass: FakeHass, entry: dict):
    """The checker and the entities the entry reads, as the coordinator gets them."""
    coordinator = _coordinator(hass, _optimizer({"custom": [entry]}))
    return await coordinator._build_optimizer_condition_checker(
        key=("export", 0), entry_index=0, condition_config=[entry]
    )


class EvaluateTracedTests(unittest.IsolatedAsyncioTestCase):
    """``evaluate_traced`` — what HA records, re-rooted per ``custom`` entry."""

    async def _trace(self, hass: FakeHass, entries: list[dict]) -> dict:
        trace: dict = {}
        for entry_index, entry in enumerate(entries):
            checker = await _build_checker(hass, entry)
            evaluate_traced(
                checker.async_check, entry_index=entry_index, into=trace
            )
        return trace

    async def test_entries_are_rooted_at_their_own_index(self) -> None:
        hass = FakeHass({"sensor.soc": "42.0", "binary_sensor.a": "on"})
        trace = await self._trace(
            hass,
            [
                {
                    "condition": "numeric_state",
                    "entity_id": "sensor.soc",
                    "above": 10,
                },
                {
                    "condition": "or",
                    "conditions": [
                        {
                            "condition": "state",
                            "entity_id": "binary_sensor.a",
                            "state": "off",
                        },
                        {
                            "condition": "state",
                            "entity_id": "binary_sensor.a",
                            "state": "on",
                        },
                    ],
                },
            ],
        )

        # Both entries are built as their own single-entry checker and would
        # otherwise both land on `condition/0`.
        self.assertEqual(
            sorted(trace),
            [
                "condition/0",
                "condition/0/entity_id/0",
                "condition/1",
                "condition/1/conditions/0",
                "condition/1/conditions/0/entity_id/0",
                "condition/1/conditions/1",
                "condition/1/conditions/1/entity_id/0",
            ],
        )
        # The step repeats its path; it is re-rooted with the key.
        for path, steps in trace.items():
            self.assertEqual([step["path"] for step in steps], [path])

    async def test_leaves_carry_the_result_and_what_was_compared(self) -> None:
        hass = FakeHass({"sensor.soc": "42.0", "binary_sensor.a": "off"})
        trace = await self._trace(
            hass,
            [
                {
                    "condition": "numeric_state",
                    "entity_id": "sensor.soc",
                    "above": 90,
                },
                {
                    "condition": "state",
                    "entity_id": "binary_sensor.a",
                    "state": "on",
                },
            ],
        )

        self.assertEqual(
            trace["condition/0/entity_id/0"][0]["result"],
            {"result": False, "state": 42.0, "wanted_state_above": 90.0},
        )
        self.assertEqual(
            trace["condition/1/entity_id/0"][0]["result"],
            {"result": False, "state": "off", "wanted_state": "on"},
        )
        # The entry node itself carries the verdict the group folds.
        self.assertEqual(trace["condition/0"][0]["result"], {"result": False})

    async def test_a_failing_branch_short_circuits_the_rest_of_its_nest(
        self,
    ) -> None:
        hass = FakeHass({"binary_sensor.a": "off", "binary_sensor.b": "on"})
        trace = await self._trace(
            hass,
            [
                {
                    "condition": "and",
                    "conditions": [
                        {
                            "condition": "state",
                            "entity_id": "binary_sensor.a",
                            "state": "on",
                        },
                        {
                            "condition": "state",
                            "entity_id": "binary_sensor.b",
                            "state": "on",
                        },
                    ],
                }
            ],
        )

        self.assertIn("condition/0/conditions/0", trace)
        # HA stops at the first false child, so the second never records. The
        # trace shows exactly what was evaluated, which is the honest picture.
        self.assertNotIn("condition/0/conditions/1", trace)

    async def test_a_condition_error_is_recorded_as_an_error(self) -> None:
        hass = FakeHass()
        trace = await self._trace(
            hass,
            [
                {
                    "condition": "state",
                    "entity_id": "binary_sensor.missing",
                    "state": "on",
                }
            ],
        )

        self.assertIn(
            "unknown entity binary_sensor.missing", trace["condition/0"][0]["error"]
        )

    async def test_a_raising_checker_still_contributes_what_it_recorded(
        self,
    ) -> None:
        trace: dict = {}
        with self.assertRaises(RuntimeError):
            evaluate_traced(
                Mock(side_effect=RuntimeError("nope")), entry_index=0, into=trace
            )

        # Nothing was traced (the checker never ran), but collection happened in
        # a `finally` rather than being skipped by the exception.
        self.assertEqual(trace, {})

    async def test_the_payload_is_plain_json(self) -> None:
        hass = FakeHass({"sensor.soc": "42.0"})
        trace = await self._trace(
            hass,
            [
                # A `time` condition records `datetime.time` bounds -- the case
                # that makes plain `json.dumps` the assertion worth making.
                {"condition": "time", "after": "00:00:00", "before": "23:59:59"},
                {
                    "condition": "numeric_state",
                    "entity_id": "sensor.soc",
                    "above": 10,
                },
            ],
        )

        round_tripped = json.loads(json.dumps(trace))
        self.assertEqual(round_tripped, trace)
        result = round_tripped["condition/0"][0]["result"]
        self.assertEqual(result["after"], "00:00:00")
        self.assertEqual(result["before"], "23:59:59")


class ExtractEntityIdsTests(unittest.TestCase):
    """Which entities an entry reads, across the condition shapes HA accepts.

    The ``target`` shape is the one that matters most: it is what the condition
    builder writes for an entity platform condition, and it is exactly what a
    hand-rolled walk over ``entity_id`` would miss.
    """

    def test_a_platform_condition_is_read_through_its_target(self) -> None:
        self.assertEqual(
            extract_entity_ids({
                "condition": "temperature.is_value",
                "target": {"entity_id": "sensor.pool"},
                "options": {"threshold": {"type": "below", "value": 30.5}},
            }),
            ("sensor.pool",),
        )

    def test_a_legacy_condition_is_read_through_its_entity_id(self) -> None:
        self.assertEqual(
            extract_entity_ids(
                {"condition": "numeric_state", "entity_id": "sensor.soc", "above": 20}
            ),
            ("sensor.soc",),
        )

    def test_a_list_of_entities_is_kept_whole(self) -> None:
        self.assertEqual(
            extract_entity_ids(
                {"condition": "state", "entity_id": ["b.two", "a.one"], "state": "on"}
            ),
            ("a.one", "b.two"),
        )

    def test_a_nest_reaches_both_shapes(self) -> None:
        self.assertEqual(
            extract_entity_ids({
                "condition": "and",
                "conditions": [
                    {"condition": "state", "entity_id": "x.one", "state": "on"},
                    {
                        "condition": "temperature.is_value",
                        "target": {"entity_id": "z.two"},
                    },
                ],
            }),
            ("x.one", "z.two"),
        )

    def test_a_config_ha_cannot_walk_yields_nothing(self) -> None:
        """A reading is worth less than the run it would otherwise cost."""
        self.assertEqual(extract_entity_ids({"not": "a condition"}), ())


class ReadEntityStatesTests(unittest.TestCase):
    """What the reading carries -- and that a missing entity still carries."""

    def test_a_reading_carries_its_unit_and_name(self) -> None:
        hass = FakeHass(
            {"sensor.pool": "28.4"},
            {"sensor.pool": {"unit_of_measurement": "°C", "friendly_name": "Bazén"}},
        )

        self.assertEqual(
            read_entity_states(hass, ["sensor.pool"]),
            [{
                "entityId": "sensor.pool",
                "state": "28.4",
                "unit": "°C",
                "name": "Bazén",
            }],
        )

    def test_an_entity_without_those_attributes_still_reads(self) -> None:
        hass = FakeHass({"sensor.soc": "42.0"})

        self.assertEqual(
            read_entity_states(hass, ["sensor.soc"]),
            [{"entityId": "sensor.soc", "state": "42.0", "unit": None, "name": None}],
        )

    def test_a_missing_entity_is_kept_rather_than_dropped(self) -> None:
        """That a condition reads something absent is the reader's answer."""
        self.assertEqual(
            read_entity_states(FakeHass(), ["sensor.gone"]),
            [{"entityId": "sensor.gone", "state": None, "unit": None, "name": None}],
        )


class CoordinatorConditionTraceTests(unittest.IsolatedAsyncioTestCase):
    """What one run leaves behind for ``get_condition_trace``."""

    async def test_an_evaluated_group_records_its_run_config_and_trace(
        self,
    ) -> None:
        hass = FakeHass({"sensor.soc": "42.0"})
        custom = [
            {"condition": "numeric_state", "entity_id": "sensor.soc", "above": 10}
        ]
        coordinator = _coordinator(
            hass, _optimizer({"when_price_below": 1.0, "custom": custom})
        )

        await coordinator._async_evaluate_optimizer_conditions()

        payload = coordinator.get_condition_trace(optimizer_id="export", group_index=0)
        self.assertEqual(payload["optimizerId"], "export")
        self.assertEqual(payload["groupIndex"], 0)
        self.assertEqual(payload["config"], custom)
        self.assertEqual(payload["trace"]["condition/0"][0]["result"], {"result": True})
        # `runAt` is what tells a reader the trace may be newer than the plan
        # row they clicked.
        self.assertIsInstance(payload["runAt"], str)
        json.dumps(payload)

    async def test_each_entry_records_the_entities_it_read(self) -> None:
        """Keyed by entry root, so a reading sits under the node that used it."""
        hass = FakeHass(
            {"sensor.soc": "42.0", "sensor.pool": "28.4"},
            {"sensor.pool": {"unit_of_measurement": "°C", "friendly_name": "Bazén"}},
        )
        coordinator = _coordinator(
            hass,
            _optimizer({
                "when_price_below": 1.0,
                "custom": [
                    {
                        "condition": "numeric_state",
                        "entity_id": "sensor.soc",
                        "above": 10,
                    },
                    {
                        "condition": "numeric_state",
                        "entity_id": "sensor.pool",
                        "below": 30.5,
                    },
                ],
            }),
        )

        await coordinator._async_evaluate_optimizer_conditions()

        payload = coordinator.get_condition_trace(optimizer_id="export", group_index=0)
        self.assertEqual(
            payload["entityStates"],
            {
                "condition/0": [{
                    "entityId": "sensor.soc",
                    "state": "42.0",
                    "unit": None,
                    "name": None,
                }],
                "condition/1": [{
                    "entityId": "sensor.pool",
                    "state": "28.4",
                    "unit": "°C",
                    "name": "Bazén",
                }],
            },
        )
        json.dumps(payload)

    async def test_an_entry_reading_no_entity_gets_no_key(self) -> None:
        """Nothing to show is an absent key, not an empty list to render."""
        hass = FakeHass()
        coordinator = _coordinator(
            hass,
            _optimizer({
                "when_price_below": 1.0,
                "custom": [{"condition": "time", "after": "06:00:00"}],
            }),
        )

        await coordinator._async_evaluate_optimizer_conditions()

        payload = coordinator.get_condition_trace(optimizer_id="export", group_index=0)
        self.assertEqual(payload["entityStates"], {})

    async def test_a_missing_entity_is_recorded_as_missing(self) -> None:
        hass = FakeHass()
        coordinator = _coordinator(
            hass,
            _optimizer({
                "when_price_below": 1.0,
                "custom": [
                    {"condition": "state", "entity_id": "sensor.gone", "state": "on"}
                ],
            }),
        )

        await coordinator._async_evaluate_optimizer_conditions()

        payload = coordinator.get_condition_trace(optimizer_id="export", group_index=0)
        self.assertEqual(
            payload["entityStates"]["condition/0"],
            [{"entityId": "sensor.gone", "state": None, "unit": None, "name": None}],
        )

    async def test_the_reading_follows_the_entity_between_runs(self) -> None:
        """The entity ids are cached with the checker; their states are not."""
        hass = FakeHass({"sensor.soc": "42.0"})
        coordinator = _coordinator(
            hass,
            _optimizer({
                "when_price_below": 1.0,
                "custom": [
                    {
                        "condition": "numeric_state",
                        "entity_id": "sensor.soc",
                        "above": 10,
                    }
                ],
            }),
        )

        await coordinator._async_evaluate_optimizer_conditions()
        hass.states._states["sensor.soc"] = State("sensor.soc", "11.0")
        await coordinator._async_evaluate_optimizer_conditions()

        payload = coordinator.get_condition_trace(optimizer_id="export", group_index=0)
        self.assertEqual(
            payload["entityStates"]["condition/0"][0]["state"], "11.0"
        )

    async def test_a_group_without_custom_conditions_records_nothing(self) -> None:
        coordinator = _coordinator(
            FakeHass(), _optimizer({"when_price_below": 1.0})
        )

        await coordinator._async_evaluate_optimizer_conditions()

        self.assertIsNone(
            coordinator.get_condition_trace(optimizer_id="export", group_index=0)
        )

    async def test_nothing_is_recorded_before_the_first_run(self) -> None:
        coordinator = _coordinator(
            FakeHass({"sensor.soc": "42.0"}),
            _optimizer(
                {
                    "custom": [
                        {
                            "condition": "numeric_state",
                            "entity_id": "sensor.soc",
                            "above": 10,
                        }
                    ]
                }
            ),
        )

        self.assertIsNone(
            coordinator.get_condition_trace(optimizer_id="export", group_index=0)
        )

    async def test_a_group_dropped_from_config_stops_being_recorded(self) -> None:
        hass = FakeHass({"sensor.soc": "42.0"})
        custom = [
            {"condition": "numeric_state", "entity_id": "sensor.soc", "above": 10}
        ]
        coordinator = _coordinator(
            hass,
            _optimizer(
                {"when_price_below": 1.0, "custom": custom},
                {"when_price_below": 2.0, "custom": custom},
            ),
        )
        await coordinator._async_evaluate_optimizer_conditions()
        self.assertIsNotNone(
            coordinator.get_condition_trace(optimizer_id="export", group_index=1)
        )

        coordinator._active_config = {
            "automation": {
                "optimizers": [_optimizer({"when_price_below": 1.0, "custom": custom})]
            }
        }
        await coordinator._async_evaluate_optimizer_conditions()

        self.assertIsNotNone(
            coordinator.get_condition_trace(optimizer_id="export", group_index=0)
        )
        self.assertIsNone(
            coordinator.get_condition_trace(optimizer_id="export", group_index=1)
        )

    async def test_a_raising_entry_stays_errored_and_traces_what_it_reached(
        self,
    ) -> None:
        hass = FakeHass({"sensor.soc": "42.0"})
        coordinator = _coordinator(
            hass,
            _optimizer(
                {
                    "custom": [
                        {
                            "condition": "numeric_state",
                            "entity_id": "sensor.soc",
                            "above": 10,
                        },
                        {
                            "condition": "numeric_state",
                            "entity_id": "sensor.soc",
                            "above": 20,
                        },
                    ]
                }
            ),
        )
        real_build = coordinator._build_optimizer_condition_checker

        async def _build(*, key, entry_index, condition_config):
            if entry_index == 1:
                return Mock(
                    async_check=Mock(side_effect=RuntimeError("nope")),
                    async_unload=Mock(),
                ), ()
            return await real_build(
                key=key, entry_index=entry_index, condition_config=condition_config
            )

        coordinator._build_optimizer_condition_checker = _build

        results = await coordinator._async_evaluate_optimizer_conditions()

        group = results["export"][0]
        self.assertEqual(
            [(entry.met, entry.errored) for entry in group.entries],
            [(True, False), (False, True)],
        )
        # The entry that blew up recorded nothing, and did not take the entry
        # before it down with it.
        trace = coordinator.get_condition_trace(
            optimizer_id="export", group_index=0
        )["trace"]
        self.assertIn("condition/0", trace)
        self.assertNotIn("condition/1", trace)

    async def test_unload_drops_the_record(self) -> None:
        hass = FakeHass({"sensor.soc": "42.0"})
        coordinator = _coordinator(
            hass,
            _optimizer(
                {
                    "custom": [
                        {
                            "condition": "numeric_state",
                            "entity_id": "sensor.soc",
                            "above": 10,
                        }
                    ]
                }
            ),
        )
        await coordinator._async_evaluate_optimizer_conditions()

        await coordinator.async_unload()

        self.assertIsNone(
            coordinator.get_condition_trace(optimizer_id="export", group_index=0)
        )


class ConditionTraceWebsocketTests(unittest.IsolatedAsyncioTestCase):
    """``helman/get_condition_trace`` — the payload the diagram's dialog reads."""

    MESSAGE = {
        "id": 1,
        "type": "helman/get_condition_trace",
        "optimizer_id": "export",
        "group_index": 0,
    }

    @staticmethod
    def _hass(coordinator: object) -> SimpleNamespace:
        return SimpleNamespace(data={DOMAIN: {"coordinator": coordinator}})

    async def test_returns_the_record_for_the_requested_group(self) -> None:
        hass = FakeHass({"sensor.soc": "42.0"})
        coordinator = _coordinator(
            hass,
            _optimizer(
                {
                    "custom": [
                        {
                            "condition": "numeric_state",
                            "entity_id": "sensor.soc",
                            "above": 10,
                        }
                    ]
                }
            ),
        )
        await coordinator._async_evaluate_optimizer_conditions()
        connection = FakeConnection()

        ws_get_condition_trace(self._hass(coordinator), connection, dict(self.MESSAGE))

        self.assertEqual(connection.errors, [])
        payload = connection.results[0][1]
        self.assertEqual(payload["optimizerId"], "export")
        self.assertEqual(payload["groupIndex"], 0)
        self.assertEqual(
            payload["trace"]["condition/0"][0]["result"], {"result": True}
        )

    async def test_returns_null_for_a_group_with_no_custom_conditions(self) -> None:
        coordinator = _coordinator(FakeHass(), _optimizer({"when_price_below": 1.0}))
        await coordinator._async_evaluate_optimizer_conditions()
        connection = FakeConnection()

        ws_get_condition_trace(self._hass(coordinator), connection, dict(self.MESSAGE))

        self.assertEqual(connection.errors, [])
        self.assertEqual(connection.results, [(1, None)])

    async def test_requires_admin(self) -> None:
        coordinator = SimpleNamespace(get_condition_trace=Mock())
        connection = FakeConnection(is_admin=False)

        ws_get_condition_trace(self._hass(coordinator), connection, dict(self.MESSAGE))

        coordinator.get_condition_trace.assert_not_called()
        self.assertEqual(
            connection.errors, [(1, "unauthorized", "Admin access required")]
        )

    async def test_returns_not_loaded_when_the_coordinator_is_missing(self) -> None:
        connection = FakeConnection()

        ws_get_condition_trace(
            SimpleNamespace(data={DOMAIN: {}}), connection, dict(self.MESSAGE)
        )

        self.assertEqual(connection.results, [])
        self.assertEqual(
            connection.errors,
            [(1, "not_loaded", "Helman coordinator not available")],
        )

    def test_the_request_schema_rejects_a_bad_id_and_index(self) -> None:
        import voluptuous as vol

        schema = ws_get_condition_trace._ws_schema
        with self.assertRaises(vol.Invalid):
            schema({**self.MESSAGE, "optimizer_id": ""})
        with self.assertRaises(vol.Invalid):
            schema({**self.MESSAGE, "group_index": -1})
        with self.assertRaises(vol.Invalid):
            schema({**self.MESSAGE, "group_index": True})
        self.assertEqual(schema(dict(self.MESSAGE))["group_index"], 0)
