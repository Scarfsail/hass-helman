"""The contract the config editor's entity groups render without understanding.

Two things are under test, and the second is the point of the first.

The **registry** must answer for a path it knows, and answer *something* for a
path it does not: an unclaimed path falls through to the fallback and reads its
entity's current value, and a path holding no entity id at all comes back as
``unsupported`` rather than as an error that blanks the whole poll. Every failure mode a half-edited draft can produce -- no entity yet, an
entity that does not exist, a state that is not a number, a polarity pasted
from another device's block -- is an ordinary answer here, because this
endpoint is polled every couple of seconds while the user types.

The **facts** must carry no rendered text. Each assertion below reads a token,
not a sentence, because a sentence in this payload would mean the editor is
being handed English rather than something it localizes. If a test here starts
asserting on prose, the boundary this package exists to hold has moved.
"""

from __future__ import annotations

import asyncio
import sys
import types
import unittest
import unittest.mock
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]

for _name, _path in [
    ("custom_components", ROOT / "custom_components"),
    ("custom_components.helman", ROOT / "custom_components" / "helman"),
]:
    _pkg = sys.modules.get(_name) or types.ModuleType(_name)
    _pkg.__path__ = [str(_path)]
    sys.modules[_name] = _pkg

from custom_components.helman.entity_inspection import (  # noqa: E402
    FALLBACK_EVALUATOR,
    evaluator_for,
    has_list_index,
    inspect_target,
    inspect_targets,
    match_key,
)
from custom_components.helman import recorder_statistics_span as span_mod  # noqa: E402
from custom_components.helman.const import (  # noqa: E402
    HOUSE_FORECAST_DEFAULT_MIN_HISTORY_DAYS,
    SOLAR_BIAS_DEFAULT_MIN_HISTORY_DAYS,
)
from custom_components.helman.consumption_forecast_profiles import (  # noqa: E402
    _compute_history_days,
)
from custom_components.helman.entity_inspection import history  # noqa: E402
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
                self.assertEqual(found[1], (device,))
                self.assertIsNot(found[0], FALLBACK_EVALUATOR)

    def test_an_unclaimed_path_resolves_to_the_fallback(self):
        evaluator, wildcards = evaluator_for(("power_devices", "grid", "entities", "soc"))
        self.assertIs(evaluator, FALLBACK_EVALUATOR)
        self.assertEqual(wildcards, ())


SOC_PATH = ("power_devices", "grid", "entities", "soc")


def _soc_config(value: Any) -> dict:
    """A document with something at a path no registry key claims."""
    return {"power_devices": {"grid": {"entities": {"soc": value}}}}


class TestFallbackReadings(unittest.TestCase):
    """A path with no evaluator of its own still shows what its entity reads.

    Most entities in the configuration carry nothing to interpret -- a switch,
    a select, an energy meter -- and every one of them still has to show a
    current value, because the editor's promise is that no configured entity is
    left blank. That is one registry fallback, not a frontend branch for
    "a picker with no facts".
    """

    def test_a_configured_entity_reads_its_value(self):
        hass = _Hass({"sensor.soc": _State("42", unit="%")})
        inspection = inspect_target(hass, _soc_config("sensor.soc"), SOC_PATH)
        self.assertEqual(inspection.status, "ok")
        self.assertEqual(
            [(fact.id, fact.token, fact.params) for fact in inspection.facts],
            [("value", "value", {"value": "42", "unit": "%"})],
        )

    def test_a_state_that_is_not_a_number_is_still_a_reading(self):
        # A switch saying ``on`` is not a broken sensor. Only an evaluator
        # about to do arithmetic has cause to call that a problem.
        hass = _Hass({"switch.boiler": _State("on", unit=None)})
        inspection = inspect_target(hass, _soc_config("switch.boiler"), SOC_PATH)
        self.assertEqual(inspection.status, "ok")
        fact = inspection.facts[0]
        self.assertEqual((fact.token, fact.severity), ("value", "neutral"))
        self.assertEqual(fact.params["value"], "on")

    def test_a_select_sitting_on_none_shows_the_option_rather_than_a_warning(self):
        # ``None`` is an ordinary option of a select, not one of Home
        # Assistant's absence sentinels -- those are ``unknown``, ``unavailable``
        # and the empty state. Reading it as an absence put an orange warning
        # beside a correctly configured control entity.
        hass = _Hass({"input_select.eco_gear": _State("None", unit=None)})
        inspection = inspect_target(hass, _soc_config("input_select.eco_gear"), SOC_PATH)
        self.assertEqual(inspection.status, "ok")
        fact = inspection.facts[0]
        self.assertEqual((fact.token, fact.severity), ("value", "neutral"))
        self.assertEqual(fact.params["value"], "None")

    def test_a_power_sensor_reading_none_is_still_a_warning(self):
        # The other half of the same change: a *numeric* evaluator has to keep
        # objecting, and ``not_numeric`` is what it should object with.
        hass = _Hass({"sensor.grid_power": _State("None")})
        inspection = inspect_target(hass, _config(), POWER_PATH)
        self.assertEqual(inspection.status, "unavailable")
        self.assertEqual([fact.token for fact in inspection.facts], ["not_numeric"])

    def test_a_missing_entity_says_so_rather_than_showing_nothing(self):
        inspection = inspect_target(_Hass(), _soc_config("sensor.gone"), SOC_PATH)
        self.assertEqual(inspection.status, "unavailable")
        self.assertEqual(inspection.facts[0].token, "entity_missing")

    def test_an_unset_path_reads_as_unset(self):
        self.assertEqual(inspect_target(_Hass(), _soc_config(""), SOC_PATH).status, "unset")
        self.assertEqual(inspect_target(_Hass(), _config(), SOC_PATH).status, "unset")

    def test_a_reading_depends_on_the_entity_alone(self):
        hass = _Hass({"sensor.soc": _State("42", unit="%")})
        inspection = inspect_target(hass, _soc_config("sensor.soc"), SOC_PATH)
        self.assertEqual(inspection.depends_on, (SOC_PATH,))

    def test_a_specific_evaluator_still_wins(self):
        # The fallback must never take a path someone registered for: a power
        # sensor would lose its direction and read as a bare number.
        hass = _Hass({"sensor.grid_power": _State("1400")})
        inspection = inspect_target(hass, _config(), POWER_PATH)
        self.assertIn("power_reading.", _fact(inspection.to_dict(), "reading")["token"])


class TestUnsupportedPaths(unittest.TestCase):
    """A path nothing speaks for is answered, not refused."""

    def test_a_path_holding_something_other_than_an_entity_id_is_unsupported(self):
        # A group pointed at a mapping or a list is a call-site mistake, and a
        # fabricated reading would hide it.
        for value in ({"nested": "sensor.x"}, ["sensor.x"], 42):
            with self.subTest(value=value):
                inspection = inspect_target(_Hass(), _soc_config(value), SOC_PATH)
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
        # The whole document is not an entity id.
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


HOUSE_HISTORY_PATH = (
    "power_devices",
    "house",
    "forecast",
    "total_energy_entity_id",
)
SOLAR_HISTORY_PATH = (
    "power_devices",
    "solar",
    "forecast",
    "total_energy_entity_id",
)
BIAS_HISTORY_PATH = (
    "power_devices",
    "solar",
    "forecast",
    "bias_correction",
    "total_energy_entity_id",
)
DAILY_HISTORY_PATH = (
    "power_devices",
    "solar",
    "forecast",
    "daily_energy_entity_ids",
    0,
)

HOUSE_METER = "sensor.house_energy"


class _ProbingHass(_Hass):
    """A hass that runs a scheduled probe to completion, and counts them.

    The evaluator answers synchronously and measures in the background, so a
    test that wants to see a measured value has to let the task actually run.
    Running it inline is also what makes "one query for two polls" assertable
    at all.
    """

    def __init__(self, states: dict[str, _State] | None = None) -> None:
        super().__init__(states)
        self.tasks = 0

    def async_create_task(self, coro):
        self.tasks += 1
        asyncio.run(coro)


class _Probe:
    """A stand-in for the one recorder read, counting how often it is made."""

    def __init__(self, days: int | None = 41, error: Exception | None = None) -> None:
        self.days = days
        self.error = error
        self.calls: list[str] = []

    async def __call__(self, hass, entity_id: str) -> int:
        self.calls.append(entity_id)
        if self.error is not None:
            raise self.error
        return self.days


def _history_config(
    *,
    entity: str | None = HOUSE_METER,
    min_history_days: Any = None,
    solar_entity: str | None = None,
) -> dict:
    forecast: dict = {}
    if entity is not None:
        forecast["total_energy_entity_id"] = entity
    if min_history_days is not None:
        forecast["min_history_days"] = min_history_days
    solar_forecast: dict = {}
    if solar_entity is not None:
        solar_forecast["total_energy_entity_id"] = solar_entity
    return {
        "power_devices": {
            "house": {"forecast": forecast},
            "solar": {"forecast": solar_forecast},
        }
    }


class _HistoryTestCase(unittest.TestCase):
    """Shared plumbing: a clean cache and a counted probe around every test."""

    def setUp(self) -> None:
        history.reset_history_cache()
        self.probe = _Probe()
        patcher = unittest.mock.patch.object(history, "_query", self.probe)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(history.reset_history_cache)

    def inspect_twice(self, hass, config, path) -> tuple[dict, dict]:
        """The poll before the measurement lands, and the one after it.

        The evaluator cannot block a websocket callback on a database, so the
        first answer is deliberately without a history fact and the second --
        one tick later in the editor, one line later here -- carries it.
        """
        first = inspect_target(hass, config, path).to_dict()
        second = inspect_target(hass, config, path).to_dict()
        return first, second


class TestHistoryDepth(_HistoryTestCase):
    """What the history evaluator says, over the drafts a user can produce."""

    def test_a_measurement_arrives_on_the_poll_after_it_is_asked_for(self):
        hass = _ProbingHass({HOUSE_METER: _State("1234.5", unit="kWh")})
        first, second = self.inspect_twice(hass, _history_config(), HOUSE_HISTORY_PATH)
        self.assertIsNone(_fact(first, "history"))
        self.assertEqual(_fact(first, "value")["params"], {"value": "1234.5", "unit": "kWh"})
        self.assertEqual(_fact(second, "history")["token"], "history_depth")

    def test_enough_history_reads_as_ok_against_the_setting_in_the_draft(self):
        hass = _ProbingHass({HOUSE_METER: _State("1234.5", unit="kWh")})
        _, inspection = self.inspect_twice(
            hass, _history_config(min_history_days=30), HOUSE_HISTORY_PATH
        )
        fact = _fact(inspection, "history")
        self.assertEqual(fact["params"], {"available": 41, "required": 30})
        self.assertEqual(fact["severity"], "ok")

    def test_not_enough_history_reads_as_a_warning(self):
        hass = _ProbingHass({HOUSE_METER: _State("1234.5", unit="kWh")})
        self.probe.days = 3
        _, inspection = self.inspect_twice(
            hass, _history_config(min_history_days=30), HOUSE_HISTORY_PATH
        )
        fact = _fact(inspection, "history")
        self.assertEqual(fact["params"], {"available": 3, "required": 30})
        self.assertEqual(fact["severity"], "warn")

    def test_no_recorder_rows_is_zero_days_rather_than_no_answer(self):
        # A meter picked a minute ago. "Nothing yet" is the most useful thing
        # the badge can say, and it is short of any requirement.
        hass = _ProbingHass({HOUSE_METER: _State("0", unit="kWh")})
        self.probe.days = 0
        _, inspection = self.inspect_twice(hass, _history_config(), HOUSE_HISTORY_PATH)
        fact = _fact(inspection, "history")
        self.assertEqual(fact["params"]["available"], 0)
        self.assertEqual(fact["severity"], "warn")

    def test_an_absent_setting_is_judged_against_the_runtime_default(self):
        # The draft says nothing about min_history_days, so the badge has to
        # use the number the integration itself would fall back to -- which is
        # knowledge that lives on the backend and nowhere else.
        hass = _ProbingHass({HOUSE_METER: _State("1234.5", unit="kWh")})
        _, inspection = self.inspect_twice(hass, _history_config(), HOUSE_HISTORY_PATH)
        self.assertEqual(
            _fact(inspection, "history")["params"]["required"],
            HOUSE_FORECAST_DEFAULT_MIN_HISTORY_DAYS,
        )

    def test_a_half_typed_day_count_falls_back_rather_than_moving_the_bar(self):
        hass = _ProbingHass({HOUSE_METER: _State("1234.5", unit="kWh")})
        for raw in ("", 0, -5, "30", True):
            with self.subTest(raw=raw):
                history.reset_history_cache()
                _, inspection = self.inspect_twice(
                    hass, _history_config(min_history_days=raw), HOUSE_HISTORY_PATH
                )
                self.assertEqual(
                    _fact(inspection, "history")["params"]["required"],
                    HOUSE_FORECAST_DEFAULT_MIN_HISTORY_DAYS,
                )

    def test_a_path_with_no_requirement_states_the_depth_and_judges_nothing(self):
        hass = _ProbingHass({"sensor.solar_total": _State("55", unit="kWh")})
        _, inspection = self.inspect_twice(
            hass,
            _history_config(entity=None, solar_entity="sensor.solar_total"),
            SOLAR_HISTORY_PATH,
        )
        fact = _fact(inspection, "history")
        self.assertEqual(fact["token"], "history_depth_only")
        self.assertEqual(fact["params"], {"available": 41})
        self.assertEqual(fact["severity"], "neutral")

    def test_every_registered_history_path_answers(self):
        config = {
            "power_devices": {
                "house": {"forecast": {"total_energy_entity_id": HOUSE_METER}},
                "solar": {
                    "forecast": {
                        "total_energy_entity_id": HOUSE_METER,
                        "daily_energy_entity_ids": [HOUSE_METER],
                        "bias_correction": {"total_energy_entity_id": HOUSE_METER},
                    }
                },
            }
        }
        hass = _ProbingHass({HOUSE_METER: _State("1234.5", unit="kWh")})
        for path in (
            HOUSE_HISTORY_PATH,
            SOLAR_HISTORY_PATH,
            BIAS_HISTORY_PATH,
            DAILY_HISTORY_PATH,
        ):
            with self.subTest(path=path):
                _, inspection = self.inspect_twice(hass, config, path)
                self.assertEqual(inspection["status"], "ok")
                self.assertIsNotNone(_fact(inspection, "history"))

    def test_the_bias_entity_is_judged_against_its_own_default(self):
        config = {
            "power_devices": {
                "solar": {
                    "forecast": {
                        "bias_correction": {"total_energy_entity_id": HOUSE_METER}
                    }
                }
            }
        }
        hass = _ProbingHass({HOUSE_METER: _State("1234.5", unit="kWh")})
        _, inspection = self.inspect_twice(hass, config, BIAS_HISTORY_PATH)
        self.assertEqual(
            _fact(inspection, "history")["params"]["required"],
            SOLAR_BIAS_DEFAULT_MIN_HISTORY_DAYS,
        )

    def test_an_unset_entity_reads_as_unset_without_touching_the_recorder(self):
        hass = _ProbingHass()
        inspection = inspect_target(hass, _history_config(entity=None), HOUSE_HISTORY_PATH)
        self.assertEqual(inspection.status, "unset")
        self.assertEqual(self.probe.calls, [])

    def test_a_dead_entity_id_is_never_probed(self):
        # Nothing in the state machine means nothing worth a database scan, and
        # the picker is what needs fixing rather than the history.
        hass = _ProbingHass()
        first, second = self.inspect_twice(hass, _history_config(), HOUSE_HISTORY_PATH)
        self.assertEqual(second["status"], "unavailable")
        self.assertEqual([fact["token"] for fact in second["facts"]], ["entity_missing"])
        self.assertEqual(self.probe.calls, [])

    def test_an_entity_that_exists_but_reads_unknown_still_reports_its_history(self):
        hass = _ProbingHass({HOUSE_METER: _State("unknown", unit="kWh")})
        _, inspection = self.inspect_twice(hass, _history_config(), HOUSE_HISTORY_PATH)
        self.assertEqual(inspection["status"], "unavailable")
        self.assertEqual(
            [fact["token"] for fact in inspection["facts"]],
            ["state_absent", "history_depth"],
        )

    def test_a_history_fact_carries_tokens_and_numbers_rather_than_prose(self):
        hass = _ProbingHass({HOUSE_METER: _State("1234.5", unit="kWh")})
        _, inspection = self.inspect_twice(hass, _history_config(), HOUSE_HISTORY_PATH)
        for fact in inspection["facts"]:
            self.assertNotIn(" ", fact["token"])
            self.assertIn(fact["severity"], {"neutral", "info", "ok", "warn"})
        for value in _fact(inspection, "history")["params"].values():
            self.assertIsInstance(value, int)


class TestHistoryCache(_HistoryTestCase):
    """The recorder is asked once a minute, not once every two seconds."""

    def test_a_second_poll_is_served_from_the_measurement_the_first_made(self):
        hass = _ProbingHass({HOUSE_METER: _State("1234.5", unit="kWh")})
        for _ in range(5):
            inspect_target(hass, _history_config(), HOUSE_HISTORY_PATH)
        self.assertEqual(self.probe.calls, [HOUSE_METER])

    def test_a_measurement_older_than_the_ttl_is_taken_again(self):
        hass = _ProbingHass({HOUSE_METER: _State("1234.5", unit="kWh")})
        self.inspect_twice(hass, _history_config(), HOUSE_HISTORY_PATH)
        self.assertEqual(len(self.probe.calls), 1)

        aged = history._MEASUREMENTS[HOUSE_METER]
        history._MEASUREMENTS[HOUSE_METER] = history._Measurement(
            days=aged.days, at=aged.at - history.HISTORY_CACHE_TTL - 1
        )
        inspect_target(hass, _history_config(), HOUSE_HISTORY_PATH)
        self.assertEqual(len(self.probe.calls), 2)

    def test_a_failed_probe_is_remembered_so_it_is_not_retried_every_tick(self):
        # A recorder that is not set up must not be asked thirty times a
        # minute, and the row it cannot answer for simply carries no badge.
        hass = _ProbingHass({HOUSE_METER: _State("1234.5", unit="kWh")})
        self.probe.error = RuntimeError("recorder not ready")
        for _ in range(4):
            inspection = inspect_target(hass, _history_config(), HOUSE_HISTORY_PATH).to_dict()
        self.assertEqual(len(self.probe.calls), 1)
        self.assertIsNone(_fact(inspection, "history"))
        self.assertEqual(inspection["status"], "ok")

    def test_a_hass_that_cannot_take_a_task_still_answers(self):
        inspection = inspect_target(
            _Hass({HOUSE_METER: _State("1234.5", unit="kWh")}),
            _history_config(),
            HOUSE_HISTORY_PATH,
        ).to_dict()
        self.assertEqual(inspection["status"], "ok")
        self.assertIsNone(_fact(inspection, "history"))


class TestHistoryDraftVersusSaved(_HistoryTestCase):
    """A requirement the user just typed is part of what the reading depends on."""

    def test_changing_the_required_days_produces_a_saved_reading(self):
        hass = _ProbingHass({HOUSE_METER: _State("1234.5", unit="kWh")})
        # Warm the measurement so both readings carry a history fact.
        inspect_target(hass, _history_config(), HOUSE_HISTORY_PATH)
        [result] = inspect_targets(
            hass,
            _history_config(min_history_days=90),
            [{"key": "house", "path": list(HOUSE_HISTORY_PATH)}],
            saved_config=_history_config(min_history_days=30),
        )
        self.assertEqual(_fact(result["draft"], "history")["severity"], "warn")
        self.assertIsNotNone(result["saved"])
        self.assertEqual(_fact(result["saved"], "history")["severity"], "ok")

    def test_an_unrelated_day_count_in_the_same_group_changes_nothing(self):
        # ``training_window_days`` rides in the same group's slot, because it is
        # the same entity's setting -- but the badge does not consult it, so
        # editing it must not offer a revert.
        hass = _ProbingHass({HOUSE_METER: _State("1234.5", unit="kWh")})
        inspect_target(hass, _history_config(), HOUSE_HISTORY_PATH)
        draft = _history_config()
        draft["power_devices"]["house"]["forecast"]["training_window_days"] = 90
        [result] = inspect_targets(
            hass,
            draft,
            [{"key": "house", "path": list(HOUSE_HISTORY_PATH)}],
            saved_config=_history_config(),
        )
        self.assertIsNone(result["saved"])


class TestListTargetsHaveNoSavedReading(_HistoryTestCase):
    """A position in a list is not an identity, so it gets no comparison.

    The revert this withholds is not a nicety. Saved ``[A, B, C]``, the user
    removes ``A``: the draft's index 0 now holds ``B``, the saved document's
    index 0 still holds ``A``, and a revert offered on that comparison writes
    ``A`` back over ``B`` -- deleting an entity the user deliberately kept.
    Reordering two entries is worse still: reverting one of them leaves the
    same sensor listed twice, silently double-counting it.
    """

    def _daily_config(self, *entity_ids: str) -> dict:
        return {
            "power_devices": {
                "solar": {"forecast": {"daily_energy_entity_ids": list(entity_ids)}}
            }
        }

    def _saved_for(self, draft: dict, saved: dict, index: int = 0) -> dict | None:
        hass = _ProbingHass(
            {
                "sensor.a": _State("1", unit="kWh"),
                "sensor.b": _State("2", unit="kWh"),
            }
        )
        [result] = inspect_targets(
            hass,
            draft,
            [
                {
                    "key": f"daily.{index}",
                    "path": ["power_devices", "solar", "forecast", "daily_energy_entity_ids", index],
                }
            ],
            saved_config=saved,
        )
        return result["saved"]

    def test_a_removed_first_entry_does_not_offer_to_restore_itself(self):
        self.assertIsNone(
            self._saved_for(
                self._daily_config("sensor.b"),
                self._daily_config("sensor.a", "sensor.b"),
            )
        )

    def test_a_reorder_offers_no_revert_that_would_duplicate_a_sensor(self):
        self.assertIsNone(
            self._saved_for(
                self._daily_config("sensor.b", "sensor.a"),
                self._daily_config("sensor.a", "sensor.b"),
            )
        )

    def test_the_reading_itself_is_unaffected(self):
        # Only the comparison is withheld. What the entity says is still said.
        hass = _ProbingHass({"sensor.a": _State("1", unit="kWh")})
        config = self._daily_config("sensor.a")
        _, inspection = self.inspect_twice(hass, config, DAILY_HISTORY_PATH)
        self.assertEqual(inspection["status"], "ok")
        self.assertIsNotNone(_fact(inspection, "history"))

    def test_a_path_without_a_list_index_still_compares(self):
        # The guard is about list positions, not about saved readings at large.
        hass = _ProbingHass({"sensor.grid_power": _State("1400")})
        [result] = inspect_targets(
            hass,
            _config(polarity="positive_is_import"),
            [{"key": "grid", "path": list(POWER_PATH)}],
            saved_config=_config(),
        )
        self.assertIsNotNone(result["saved"])

    def test_the_rule_reads_the_path_rather_than_the_evaluator(self):
        self.assertTrue(has_list_index(("a", 0, "b")))
        self.assertFalse(has_list_index(("a", "0", "b")))
        self.assertFalse(has_list_index(POWER_PATH))


class TestWhatARevertRestores(_HistoryTestCase):
    """``dependsOn`` names what the reading was made of, and nothing else."""

    def test_only_the_setting_the_badge_reads_is_listed(self):
        # ``training_window_days`` renders inside the same group because it is
        # the same entity's setting -- but the badge never reads it, so a
        # revert must not reset it. The group learns that from here.
        hass = _ProbingHass({HOUSE_METER: _State("1234.5", unit="kWh")})
        draft = _history_config(min_history_days=30)
        draft["power_devices"]["house"]["forecast"]["training_window_days"] = 90
        _, inspection = self.inspect_twice(hass, draft, HOUSE_HISTORY_PATH)
        self.assertEqual(
            inspection["dependsOn"],
            [
                ["power_devices", "house", "forecast", "total_energy_entity_id"],
                ["power_devices", "house", "forecast", "min_history_days"],
            ],
        )

    def test_a_path_with_no_requirement_depends_on_the_entity_alone(self):
        hass = _ProbingHass({"sensor.solar_total": _State("55", unit="kWh")})
        _, inspection = self.inspect_twice(
            hass,
            _history_config(entity=None, solar_entity="sensor.solar_total"),
            SOLAR_HISTORY_PATH,
        )
        self.assertEqual(
            inspection["dependsOn"],
            [["power_devices", "solar", "forecast", "total_energy_entity_id"]],
        )

    def test_a_power_reading_depends_on_its_entity_and_its_polarity(self):
        inspection = inspect_target(
            _Hass({"sensor.grid_power": _State("1400")}), _config(), POWER_PATH
        ).to_dict()
        self.assertEqual(
            inspection["dependsOn"],
            [
                ["power_devices", "grid", "entities", "power"],
                ["power_devices", "grid", "entities", "power_polarity"],
            ],
        )

    def test_the_paths_and_the_comparison_are_the_same_list(self):
        # One list answers both questions, so a setting cannot enter the
        # draft-versus-saved comparison without also becoming revertible.
        inspection = inspect_target(
            _Hass({"sensor.grid_power": _State("1400")}),
            _config(polarity="positive_is_import"),
            POWER_PATH,
        )
        self.assertEqual(len(inspection.signature), len(inspection.depends_on))
        self.assertEqual(inspection.signature, ("sensor.grid_power", "positive_is_import"))


class TestHistoryDaysAgreement(unittest.IsolatedAsyncioTestCase):
    """The two halves of one measurement must not drift apart.

    ``_compute_history_days`` reduces rows a training run already fetched;
    ``query_history_days`` asks the recorder from an entity id, for the editor,
    which holds no rows. Same question, same arithmetic -- and if that stops
    being true, a group will contradict the card that reads the same history.
    """

    async def test_both_paths_report_the_same_depth_for_the_same_oldest_sample(self):
        today = date(2026, 8, 26)
        for days_back in (0, 1, 41, 400):
            with self.subTest(days_back=days_back):
                oldest = today - timedelta(days=days_back)
                rows = [
                    {
                        "start": datetime(
                            oldest.year, oldest.month, oldest.day, tzinfo=timezone.utc
                        ).timestamp()
                    },
                    {
                        "start": datetime(
                            today.year, today.month, today.day, tzinfo=timezone.utc
                        ).timestamp()
                    },
                ]
                from_rows = _compute_history_days(rows, today_local=today)

                async def _oldest(hass, ids, *, local_tz, _date=oldest):
                    return _date

                with unittest.mock.patch.object(
                    span_mod, "query_oldest_statistics_date", _oldest
                ):
                    from_entity = await span_mod.query_history_days(
                        None,
                        "sensor.house_energy",
                        today_local=today,
                        local_tz=timezone.utc,
                    )
                self.assertEqual(from_rows, days_back)
                self.assertEqual(from_entity, from_rows)

    async def test_nothing_recorded_is_zero_days_on_both_paths(self):
        async def _nothing(hass, ids, *, local_tz):
            return None

        async def _no_states(hass, entity_id, *, local_tz):
            return None

        with unittest.mock.patch.object(
            span_mod, "query_oldest_statistics_date", _nothing
        ), unittest.mock.patch.object(span_mod, "_query_oldest_state_date", _no_states):
            from_entity = await span_mod.query_history_days(
                None,
                "sensor.house_energy",
                today_local=date(2026, 8, 26),
                local_tz=timezone.utc,
            )
        self.assertEqual(from_entity, 0)
        self.assertEqual(_compute_history_days([], today_local=date(2026, 8, 26)), 0)


class TestHistoryDaysFallback(unittest.IsolatedAsyncioTestCase):
    """Statistics answer where they exist; raw states answer where they do not."""

    async def _days(self, *, statistics, state_date, calls: list[str]):
        async def _stats(hass, ids, *, local_tz):
            calls.append("statistics")
            return statistics

        async def _states(hass, entity_id, *, local_tz):
            calls.append("states")
            return state_date

        with unittest.mock.patch.object(
            span_mod, "query_oldest_statistics_date", _stats
        ), unittest.mock.patch.object(span_mod, "_query_oldest_state_date", _states):
            return await span_mod.query_history_days(
                None,
                "sensor.forecast_today",
                today_local=date(2026, 8, 26),
                local_tz=timezone.utc,
            )

    async def test_statistics_answer_alone_when_there_are_any(self):
        calls: list[str] = []
        days = await self._days(
            statistics=date(2026, 7, 16), state_date=date(2020, 1, 1), calls=calls
        )
        self.assertEqual(days, 41)
        self.assertEqual(calls, ["statistics"])

    async def test_an_entity_the_recorder_compiles_no_statistics_for_still_has_history(self):
        # A forecast sensor with no ``state_class`` has no statistics at all,
        # and calling that zero days would be a plain falsehood about an entity
        # the recorder has been storing all year.
        calls: list[str] = []
        days = await self._days(
            statistics=None, state_date=date(2026, 7, 16), calls=calls
        )
        self.assertEqual(days, 41)
        self.assertEqual(calls, ["statistics", "states"])

    async def test_neither_source_holding_anything_is_zero(self):
        calls: list[str] = []
        self.assertEqual(
            await self._days(statistics=None, state_date=None, calls=calls), 0
        )


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
