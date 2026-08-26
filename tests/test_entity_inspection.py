"""The contract the config editor's entity groups render without understanding.

Two things are under test, and the second is the point of the first.

The **registry** must answer for a path it knows, and answer *something* for a
path it does not: the editor may put a group anywhere, so an unmatched path has
to come back as ``unsupported`` rather than as an error that blanks the whole
poll. Every failure mode a half-edited draft can produce -- no entity yet, an
entity that does not exist, a state that is not a number, a polarity pasted
from another device's block -- is an ordinary answer here, because this
endpoint is polled every couple of seconds while the user types.

The **facts** must carry no rendered text. Each assertion below reads a token,
not a sentence, because a sentence in this payload would mean the editor is
being handed English rather than something it localizes. If a test here starts
asserting on prose, the boundary this package exists to hold has moved.
"""

from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

for _name, _path in [
    ("custom_components", ROOT / "custom_components"),
    ("custom_components.helman", ROOT / "custom_components" / "helman"),
]:
    _pkg = sys.modules.get(_name) or types.ModuleType(_name)
    _pkg.__path__ = [str(_path)]
    sys.modules[_name] = _pkg

from custom_components.helman.entity_inspection import (  # noqa: E402
    evaluator_for,
    inspect_target,
    inspect_targets,
    match_key,
)
from custom_components.helman.websockets import ws_inspect_entities  # noqa: E402

POWER_PATH = ("power_devices", "grid", "entities", "power")


class _State:
    def __init__(self, state: str, unit: str | None = "W") -> None:
        self.state = state
        self.attributes = {"unit_of_measurement": unit} if unit else {}


class _Hass:
    """Just enough of ``hass`` for a reading: a state machine and nothing else."""

    def __init__(self, states: dict[str, _State] | None = None) -> None:
        self.states = types.SimpleNamespace(get=(states or {}).get)


def _config(entity: str | None = "sensor.grid_power", polarity: str | None = None) -> dict:
    entities: dict = {}
    if entity is not None:
        entities["power"] = entity
    if polarity is not None:
        entities["power_polarity"] = polarity
    return {"power_devices": {"grid": {"entities": entities}}}


def _fact(inspection: dict, fact_id: str) -> dict | None:
    for fact in inspection["facts"]:
        if fact["id"] == fact_id:
            return fact
    return None


class TestRegistryMatching(unittest.TestCase):
    """A key's ``*`` matches one segment and tells the evaluator what it was."""

    def test_wildcard_reports_the_segment_it_matched(self):
        self.assertEqual(match_key("power_devices.*.entities.power", POWER_PATH), ("grid",))

    def test_a_literal_segment_must_match(self):
        self.assertIsNone(
            match_key("power_devices.*.entities.power", ("power_devices", "grid", "forecast", "power"))
        )

    def test_a_shorter_or_longer_path_does_not_match(self):
        self.assertIsNone(match_key("power_devices.*.entities.power", ("power_devices", "grid")))
        self.assertIsNone(
            match_key("power_devices.*.entities.power", (*POWER_PATH, "extra"))
        )

    def test_a_list_index_matches_a_wildcard_as_its_decimal_form(self):
        # Later kinds key on list positions; an ``int`` from the wire has to
        # match the same ``*`` a string key would.
        self.assertEqual(match_key("a.*.b", ("a", 3, "b")), ("3",))

    def test_every_power_device_resolves_to_an_evaluator(self):
        for device in ("house", "solar", "battery", "grid"):
            with self.subTest(device=device):
                found = evaluator_for(("power_devices", device, "entities", "power"))
                self.assertIsNotNone(found)
                self.assertEqual(found[1], (device,))


class TestUnsupportedPaths(unittest.TestCase):
    """A path nothing speaks for is answered, not refused."""

    def test_no_evaluator_reads_as_unsupported(self):
        inspection = inspect_target(_Hass(), _config(), ("power_devices", "grid", "entities", "soc"))
        self.assertEqual(inspection.status, "unsupported")
        self.assertEqual(inspection.facts, ())

    def test_an_unknown_device_under_a_matching_shape_is_unsupported(self):
        # The key matches, but ``power_polarity`` has no vocabulary for this
        # device, so no sign can be truthfully named.
        inspection = inspect_target(
            _Hass(), {"power_devices": {"heat_pump": {"entities": {"power": "sensor.x"}}}},
            ("power_devices", "heat_pump", "entities", "power"),
        )
        self.assertEqual(inspection.status, "unsupported")

    def test_an_empty_path_is_unsupported(self):
        self.assertEqual(inspect_target(_Hass(), _config(), ()).status, "unsupported")


class TestPowerReadings(unittest.TestCase):
    """The one evaluator this phase ships, over the states a draft can hold."""

    def test_an_unset_entity_reads_as_unset_with_no_facts(self):
        inspection = inspect_target(_Hass(), _config(entity=None), POWER_PATH)
        self.assertEqual(inspection.status, "unset")
        self.assertIsNone(inspection.entity_id)
        self.assertEqual(inspection.facts, ())

    def test_a_blank_entity_reads_as_unset(self):
        self.assertEqual(inspect_target(_Hass(), _config(entity="  "), POWER_PATH).status, "unset")

    def test_an_unknown_entity_is_unavailable_and_says_so_as_a_token(self):
        inspection = inspect_target(_Hass(), _config(), POWER_PATH)
        self.assertEqual(inspection.status, "unavailable")
        self.assertEqual([fact.token for fact in inspection.facts], ["entity_missing"])

    def test_a_non_numeric_state_is_unavailable_and_carries_the_raw_state(self):
        hass = _Hass({"sensor.grid_power": _State("not a number")})
        inspection = inspect_target(hass, _config(), POWER_PATH)
        self.assertEqual(inspection.status, "unavailable")
        self.assertEqual([fact.token for fact in inspection.facts], ["not_numeric"])
        self.assertEqual(inspection.facts[0].params, {"state": "not a number"})

    def test_home_assistants_own_absent_states_are_not_reported_as_garbage(self):
        for state in ("unknown", "unavailable"):
            with self.subTest(state=state):
                hass = _Hass({"sensor.grid_power": _State(state)})
                inspection = inspect_target(hass, _config(), POWER_PATH)
                self.assertEqual(inspection.status, "unavailable")
                self.assertEqual([fact.token for fact in inspection.facts], ["state_absent"])

    def test_a_reading_is_a_value_fact_and_a_direction_token(self):
        hass = _Hass({"sensor.grid_power": _State("1400")})
        inspection = inspect_target(hass, _config(), POWER_PATH).to_dict()
        self.assertEqual(inspection["status"], "ok")
        self.assertEqual(
            _fact(inspection, "value")["params"], {"value": "1400", "unit": "W"}
        )
        self.assertEqual(_fact(inspection, "reading")["token"], "power_reading.exporting")

    def test_the_polarity_flips_the_direction_without_touching_the_value(self):
        hass = _Hass({"sensor.grid_power": _State("1400")})
        inspection = inspect_target(
            hass, _config(polarity="positive_is_import"), POWER_PATH
        ).to_dict()
        self.assertEqual(_fact(inspection, "value")["params"]["value"], "1400")
        self.assertEqual(_fact(inspection, "reading")["token"], "power_reading.importing")
        self.assertEqual(_fact(inspection, "polarity")["token"], "polarity_inverted")

    def test_a_polarity_from_another_devices_vocabulary_reads_upright(self):
        # An easy copy-paste slip between the grid and battery YAML blocks. The
        # runtime resolves it to the default, so the reading has to as well --
        # and it must not raise, because this is a poll.
        hass = _Hass({"sensor.grid_power": _State("1400")})
        inspection = inspect_target(
            hass, _config(polarity="positive_is_charging"), POWER_PATH
        ).to_dict()
        self.assertEqual(inspection["status"], "ok")
        self.assertEqual(_fact(inspection, "reading")["token"], "power_reading.exporting")
        self.assertIsNone(_fact(inspection, "polarity"))

    def test_a_non_finite_state_is_a_warning_rather_than_a_blank_row(self):
        # ``nan`` is what a template sensor dividing by an unavailable source
        # emits, and it parses as a float. Formatted rather than caught, it
        # raises and the whole row degrades to ``unsupported`` -- which reads
        # as "the backend does not know this path", the one thing it is not.
        for text in ("nan", "inf", "-inf"):
            with self.subTest(state=text):
                hass = _Hass({"sensor.grid_power": _State(text)})
                inspection = inspect_target(hass, _config(), POWER_PATH)
                self.assertEqual(inspection.status, "unavailable")
                self.assertEqual(inspection.entity_id, "sensor.grid_power")
                self.assertEqual([fact.token for fact in inspection.facts], ["not_numeric"])

    def test_a_value_is_shown_in_full_rather_than_to_six_digits(self):
        hass = _Hass({"sensor.grid_power": _State("12345.67")})
        inspection = inspect_target(hass, _config(), POWER_PATH).to_dict()
        self.assertEqual(_fact(inspection, "value")["params"]["value"], "12345.67")

    def test_a_shown_zero_never_reads_as_a_direction(self):
        # The number and the word come from the same rounded value, so "0 W"
        # cannot be paired with "exporting".
        for text in ("0.004", "-0.004", "0"):
            with self.subTest(state=text):
                hass = _Hass({"sensor.grid_power": _State(text)})
                inspection = inspect_target(hass, _config(), POWER_PATH).to_dict()
                self.assertEqual(_fact(inspection, "value")["params"]["value"], "0")
                self.assertEqual(
                    _fact(inspection, "reading")["token"], "power_reading.idle"
                )

    def test_a_unit_less_sensor_still_reports_its_value(self):
        hass = _Hass({"sensor.grid_power": _State("12.5", unit=None)})
        inspection = inspect_target(hass, _config(), POWER_PATH).to_dict()
        self.assertEqual(_fact(inspection, "value")["params"], {"value": "12.5", "unit": ""})

    def test_facts_name_tokens_rather_than_carrying_prose(self):
        # The guard on the whole boundary: nothing in a fact may be a sentence
        # the editor would render verbatim instead of localizing.
        hass = _Hass({"sensor.grid_power": _State("-1400")})
        inspection = inspect_target(hass, _config(), POWER_PATH).to_dict()
        for fact in inspection["facts"]:
            self.assertNotIn(" ", fact["token"])
            self.assertIn(fact["severity"], {"neutral", "info", "ok", "warn"})


class TestDraftVersusSaved(unittest.TestCase):
    """``saved`` appears only when the stored document would read differently."""

    def _results(self, config: dict, saved: dict | None) -> list[dict]:
        hass = _Hass({"sensor.grid_power": _State("1400")})
        return inspect_targets(
            hass,
            config,
            [{"key": "grid", "path": list(POWER_PATH)}],
            saved_config=saved,
        )

    def test_a_polarity_change_alone_produces_a_saved_reading(self):
        [result] = self._results(_config(polarity="positive_is_import"), _config())
        self.assertEqual(result["key"], "grid")
        self.assertEqual(
            _fact(result["draft"], "reading")["token"], "power_reading.importing"
        )
        self.assertIsNotNone(result["saved"])
        self.assertEqual(
            _fact(result["saved"], "reading")["token"], "power_reading.exporting"
        )

    def test_an_unchanged_draft_has_no_saved_reading(self):
        [result] = self._results(_config(), _config())
        self.assertIsNone(result["saved"])

    def test_an_unrelated_edit_elsewhere_does_not_produce_a_saved_reading(self):
        # The comparison is over what the evaluator consulted, not over the two
        # documents: a change anywhere else must not offer a revert here.
        draft = _config()
        draft["history_buckets"] = 60
        [result] = self._results(draft, _config())
        self.assertIsNone(result["saved"])

    def test_no_saved_document_means_no_saved_reading(self):
        [result] = self._results(_config(polarity="positive_is_import"), None)
        self.assertIsNone(result["saved"])

    def test_every_target_gets_a_row_even_when_it_is_malformed(self):
        hass = _Hass()
        results = inspect_targets(hass, _config(), [{"key": "a"}, "nonsense"])
        self.assertEqual([row["key"] for row in results], ["a", "#1"])
        self.assertEqual([row["draft"]["status"] for row in results], ["unsupported"] * 2)


class _Connection:
    def __init__(self, is_admin: bool = True) -> None:
        self.user = types.SimpleNamespace(is_admin=is_admin)
        self.results: list[tuple[int, object]] = []
        self.errors: list[tuple[int, str, str]] = []

    def send_result(self, msg_id: int, result: object) -> None:
        self.results.append((msg_id, result))

    def send_error(self, msg_id: int, code: str, message: str) -> None:
        self.errors.append((msg_id, code, message))


class TestWebsocketCommand(unittest.TestCase):
    """The command is a thin wrapper: admin gate in, facts out."""

    def _msg(self, **extra) -> dict:
        return {
            "id": 1,
            "type": "helman/inspect_entities",
            "config": _config(),
            "targets": [{"key": "grid", "path": list(POWER_PATH)}],
            **extra,
        }

    def test_a_non_admin_is_refused(self):
        connection = _Connection(is_admin=False)
        ws_inspect_entities(_Hass(), connection, self._msg())
        self.assertEqual(connection.results, [])
        self.assertEqual(connection.errors, [(1, "unauthorized", "Admin access required")])

    def test_the_result_is_one_row_per_target(self):
        connection = _Connection()
        hass = _Hass({"sensor.grid_power": _State("1400")})
        ws_inspect_entities(hass, connection, self._msg())
        self.assertEqual(connection.errors, [])
        [(msg_id, payload)] = connection.results
        self.assertEqual(msg_id, 1)
        self.assertEqual([row["key"] for row in payload["results"]], ["grid"])
        self.assertEqual(payload["results"][0]["draft"]["entityId"], "sensor.grid_power")

    def test_the_request_carries_no_entity_id_and_no_settings(self):
        # The contract in one assertion: everything the answer depends on is
        # read out of the document at the path, so the message names only the
        # documents and the paths.
        message = self._msg(saved_config=_config(polarity="positive_is_import"))
        self.assertEqual(
            sorted(message),
            ["config", "id", "saved_config", "targets", "type"],
        )
        self.assertEqual(sorted(message["targets"][0]), ["key", "path"])

    def test_a_saved_document_reaches_the_comparison(self):
        connection = _Connection()
        hass = _Hass({"sensor.grid_power": _State("1400")})
        ws_inspect_entities(
            hass,
            connection,
            self._msg(
                config=_config(polarity="positive_is_import"),
                saved_config=_config(),
            ),
        )
        [(_, payload)] = connection.results
        self.assertIsNotNone(payload["results"][0]["saved"])


if __name__ == "__main__":
    unittest.main()
