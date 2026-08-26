"""Configurable power-sensor polarity, and the promise that defaults never move.

The whole design rests on one guarantee: a config that says nothing about
polarity must produce exactly the tree it produced before the setting existed.
This is a released integration, and a silent flip would swap Import and Export
on every dashboard in the field. So the default cases here are written as
literal ``value_type`` values rather than derived from the table under test — a
refactor that drifts the table has to fail these, not agree with itself.
"""

from __future__ import annotations

import asyncio
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]

for _name, _path in [
    ("custom_components", ROOT / "custom_components"),
    ("custom_components.helman", ROOT / "custom_components" / "helman"),
]:
    _pkg = sys.modules.get(_name) or types.ModuleType(_name)
    _pkg.__path__ = [str(_path)]
    sys.modules[_name] = _pkg

from custom_components.helman import tree_builder as tree_builder_module  # noqa: E402
from custom_components.helman.config_validation import validate_config_document  # noqa: E402
from custom_components.helman.power_polarity import (  # noqa: E402
    POWER_POLARITY_OPTIONS,
    consumer_value_type,
    default_polarity,
    is_power_inverted,
    source_value_type,
)
from custom_components.helman.tree_builder import HelmanTreeBuilder  # noqa: E402


def _entities(device: str, polarity: str | None) -> dict:
    entities: dict = {"power": f"sensor.{device}_power"}
    if polarity is not None:
        entities["power_polarity"] = polarity
    return entities


def _config(**polarities: str | None) -> dict:
    return {
        "power_devices": {
            device: {"entities": _entities(device, polarities.get(device))}
            for device in ("solar", "house", "battery", "grid")
        }
    }


class _Hass:
    class states:
        @staticmethod
        def get(entity_id):
            return None


def _build(config: dict) -> dict:
    """Run the real async build with the registries and energy prefs stubbed out.

    None of them have any bearing on ``value_type``; they are only what stands
    between this test and the code path that assigns it.
    """
    builder = HelmanTreeBuilder(_Hass(), config)
    manager = types.SimpleNamespace(data=None)

    async def _manager(_hass):
        return manager

    registry = types.SimpleNamespace(async_get=lambda *_a, **_k: None, entities={})
    with (
        mock.patch.object(tree_builder_module.energy_data, "async_get_manager", _manager),
        mock.patch.object(tree_builder_module.er, "async_get", lambda _h: registry),
        mock.patch.object(tree_builder_module.dr, "async_get", lambda _h: registry),
        mock.patch.object(tree_builder_module.lr, "async_get", lambda _h: registry),
    ):
        return asyncio.run(builder.build())


def _value_types(tree: dict) -> dict[str, str]:
    """``{"<group>:<sourceType>": valueType}`` for every node the build made."""
    return {
        f"{group}:{node['sourceType']}": node["valueType"]
        for group in ("sources", "consumers")
        for node in tree[group]
    }


class TestDefaultsAreUnchanged(unittest.TestCase):
    """A polarity-free config reproduces the previously hard-coded tree."""

    #: Exactly what ``tree_builder`` hard-coded before the setting existed.
    EXPECTED = {
        "sources:solar": "default",
        "sources:battery": "negative",
        "sources:grid": "negative",
        "consumers:house": "default",
        "consumers:battery": "positive",
        "consumers:grid": "positive",
    }

    def test_absent_key_builds_the_historical_tree(self):
        self.assertEqual(_value_types(_build(_config())), self.EXPECTED)

    def test_explicit_defaults_match_absent_key(self):
        explicit = _config(**{d: default_polarity(d) for d in POWER_POLARITY_OPTIONS})
        self.assertEqual(_value_types(_build(explicit)), self.EXPECTED)

    def test_every_device_defaults_to_its_first_option(self):
        for device, options in POWER_POLARITY_OPTIONS.items():
            with self.subTest(device=device):
                self.assertEqual(default_polarity(device), options[0])
                self.assertFalse(is_power_inverted(None, device))


class TestInvertedPolarity(unittest.TestCase):
    """The non-default option swaps the pair, and nothing else."""

    def test_inverted_grid_swaps_import_and_export(self):
        tree = _build(_config(grid="positive_is_import"))
        self.assertEqual(tree and _value_types(tree)["sources:grid"], "positive")
        self.assertEqual(_value_types(tree)["consumers:grid"], "negative")

    def test_inverted_battery_swaps_charge_and_discharge(self):
        types_ = _value_types(_build(_config(battery="positive_is_discharging")))
        self.assertEqual(types_["sources:battery"], "positive")
        self.assertEqual(types_["consumers:battery"], "negative")

    def test_inverting_one_device_leaves_the_others_alone(self):
        types_ = _value_types(_build(_config(grid="positive_is_import")))
        self.assertEqual(types_["sources:battery"], "negative")
        self.assertEqual(types_["consumers:battery"], "positive")
        self.assertEqual(types_["consumers:house"], "default")
        self.assertEqual(types_["sources:solar"], "default")

    def test_house_and_solar_invert_too(self):
        types_ = _value_types(
            _build(_config(house="negative_is_consumption", solar="negative_is_production"))
        )
        self.assertEqual(types_["consumers:house"], "negative")
        self.assertEqual(types_["sources:solar"], "negative")

    def test_another_devices_vocabulary_reads_as_upright(self):
        """Validation rejects it; the build path must not raise on it."""
        self.assertFalse(
            is_power_inverted({"entities": {"power_polarity": "positive_is_charging"}}, "grid")
        )

    def test_malformed_config_reads_as_upright(self):
        for bogus in (None, {}, {"entities": None}, {"entities": {}}, "nonsense"):
            with self.subTest(config=bogus):
                self.assertFalse(is_power_inverted(bogus, "battery"))


class TestPolarityValidation(unittest.TestCase):
    def _errors(self, config: dict) -> list:
        report = validate_config_document(config)
        return [e for e in report.errors if "power_polarity" in e.path]

    def test_valid_values_pass(self):
        for device, options in POWER_POLARITY_OPTIONS.items():
            for option in options:
                with self.subTest(device=device, option=option):
                    self.assertEqual(self._errors(_config(**{device: option})), [])

    def test_absent_passes(self):
        self.assertEqual(self._errors(_config()), [])

    def test_other_devices_vocabulary_is_rejected_by_name(self):
        errors = self._errors(_config(grid="positive_is_charging"))
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0].code, "invalid_choice")
        self.assertEqual(errors[0].path, "power_devices.grid.entities.power_polarity")
        self.assertIn("positive_is_export", errors[0].message)

    def test_unknown_value_is_rejected(self):
        errors = self._errors(_config(battery="inverted"))
        self.assertEqual([e.code for e in errors], ["invalid_choice"])

    def test_non_string_is_rejected(self):
        errors = self._errors(_config(house=True))
        self.assertEqual([e.code for e in errors], ["invalid_type"])


class TestValueTypeResolution(unittest.TestCase):
    """The helpers agree with the tree they feed, for every device and option."""

    def test_source_and_consumer_pairs_are_mirror_images(self):
        for device in ("battery", "grid"):
            for option in POWER_POLARITY_OPTIONS[device]:
                with self.subTest(device=device, option=option):
                    config = {"entities": {"power_polarity": option}}
                    self.assertNotEqual(
                        source_value_type(config, device),
                        consumer_value_type(config, device),
                    )


if __name__ == "__main__":
    unittest.main()
