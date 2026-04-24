from __future__ import annotations

from copy import deepcopy
from typing import Any

import pytest

import sys
import types

# Create a minimal stub for homeassistant.util.dt.as_local for tests
if "homeassistant" not in sys.modules:
    hass_mod = types.ModuleType("homeassistant")
    util_mod = types.ModuleType("homeassistant.util")
    dt_mod = types.ModuleType("homeassistant.util.dt")
    dt_mod.as_local = lambda dt_obj: dt_obj
    sys.modules["homeassistant"] = hass_mod
    sys.modules["homeassistant.util"] = util_mod
    sys.modules["homeassistant.util.dt"] = dt_mod

import homeassistant.util.dt as hass_dt

import os
from dataclasses import dataclass

# Minimal stand-in for the real SolarBiasProfile to keep tests focused and
# avoid importing the whole Home Assistant environment during unit tests.
@dataclass
class SolarBiasProfile:
    factors: dict[str, float]
    omitted_slots: list[str]

# adjust will be implemented in adjuster.py; import it at runtime to keep collection fast
import importlib.util

def _get_adjust():
    path = os.path.abspath(
        os.path.join(
            os.path.dirname(__file__),
            "..",
            "custom_components",
            "helman",
            "solar_bias_correction",
            "adjuster.py",
        )
    )
    spec = importlib.util.spec_from_file_location("helman.solar_bias_correction.adjuster", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.adjust


def test_applies_factor_to_matching_slot():
    profile = SolarBiasProfile(factors={"10:00": 2.0}, omitted_slots=[])
    raw = [{"timestamp": "2026-04-24T10:00:00+00:00", "value": 100.0}]

    adjust = _get_adjust()

    out = adjust(raw, profile)

    assert out[0]["value"] == 200.0
    assert out[0]["timestamp"] == raw[0]["timestamp"]


def test_missing_slot_defaults_to_factor_1():
    profile = SolarBiasProfile(factors={}, omitted_slots=[])
    raw = [{"timestamp": "2026-04-24T10:00:00+00:00", "value": 100.0}]

    adjust = _get_adjust()

    out = adjust(raw, profile)

    assert out[0]["value"] == 100.0


def test_zero_raw_stays_zero():
    profile = SolarBiasProfile(factors={"10:00": 2.0}, omitted_slots=[])
    raw = [{"timestamp": "2026-04-24T10:00:00+00:00", "value": 0.0}]

    adjust = _get_adjust()

    out = adjust(raw, profile)

    assert out[0]["value"] == 0.0


def test_non_negativity_clamp():
    profile = SolarBiasProfile(factors={"10:00": -1.0}, omitted_slots=[])
    raw = [{"timestamp": "2026-04-24T10:00:00+00:00", "value": 100.0}]

    adjust = _get_adjust()

    out = adjust(raw, profile)

    assert out[0]["value"] == 0.0


def test_preserves_timestamp():
    profile = SolarBiasProfile(factors={"10:00": 1.5}, omitted_slots=[])
    raw = [{"timestamp": "2026-04-24T10:00:00+00:00", "value": 10.0}]

    adjust = _get_adjust()

    out = adjust(raw, profile)

    assert out[0]["timestamp"] == "2026-04-24T10:00:00+00:00"


def test_raw_series_is_not_mutated():
    profile = SolarBiasProfile(factors={"10:00": 2.0}, omitted_slots=[])
    raw = [{"timestamp": "2026-04-24T10:00:00+00:00", "value": 5.0}]
    raw_copy = deepcopy(raw)

    adjust = _get_adjust()

    out = adjust(raw, profile)

    # original should be unchanged
    assert raw == raw_copy
    # output is a new list
    assert out is not raw
    assert out[0] is not raw[0]


def test_empty_raw_returns_empty():
    profile = SolarBiasProfile(factors={"10:00": 2.0}, omitted_slots=[])
    raw: list[dict[str, Any]] = []

    adjust = _get_adjust()

    out = adjust(raw, profile)

    assert out == []
