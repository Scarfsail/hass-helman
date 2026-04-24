from __future__ import annotations

from copy import deepcopy
from typing import Any

import pytest

import sys
import types
import os

# Stub homeassistant.util.dt.as_local so tests are deterministic without HA
if "homeassistant" not in sys.modules:
    hass_mod = types.ModuleType("homeassistant")
    util_pkg = types.ModuleType("homeassistant.util")
    dt_mod = types.ModuleType("homeassistant.util.dt")
    dt_mod.as_local = lambda dt_obj: dt_obj
    sys.modules["homeassistant"] = hass_mod
    sys.modules["homeassistant.util"] = util_pkg
    sys.modules["homeassistant.util.dt"] = dt_mod

# Provide package stubs so normal imports below don't execute integration __init__
repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if "custom_components" not in sys.modules:
    cc = types.ModuleType("custom_components")
    cc.__path__ = [os.path.join(repo_root, "custom_components")]
    sys.modules["custom_components"] = cc
if "custom_components.helman" not in sys.modules:
    helman = types.ModuleType("custom_components.helman")
    helman.__path__ = [os.path.join(repo_root, "custom_components", "helman")]
    sys.modules["custom_components.helman"] = helman

# Now import the real modules under test
from custom_components.helman.solar_bias_correction.adjuster import adjust
from custom_components.helman.solar_bias_correction.models import SolarBiasProfile


def test_applies_factor_to_matching_slot():
    profile = SolarBiasProfile(factors={"10:00": 2.0}, omitted_slots=[])
    raw = [{"timestamp": "2026-04-24T10:00:00+00:00", "value": 100.0}]

    out = adjust(raw, profile)

    assert out[0]["value"] == 200.0
    assert out[0]["timestamp"] == raw[0]["timestamp"]


def test_missing_slot_defaults_to_factor_1():
    profile = SolarBiasProfile(factors={}, omitted_slots=[])
    raw = [{"timestamp": "2026-04-24T10:00:00+00:00", "value": 100.0}]

    out = adjust(raw, profile)

    assert out[0]["value"] == 100.0


def test_zero_raw_stays_zero():
    profile = SolarBiasProfile(factors={"10:00": 2.0}, omitted_slots=[])
    raw = [{"timestamp": "2026-04-24T10:00:00+00:00", "value": 0.0}]

    out = adjust(raw, profile)

    assert out[0]["value"] == 0.0


def test_non_negativity_clamp():
    profile = SolarBiasProfile(factors={"10:00": -1.0}, omitted_slots=[])
    raw = [{"timestamp": "2026-04-24T10:00:00+00:00", "value": 100.0}]

    out = adjust(raw, profile)

    assert out[0]["value"] == 0.0


def test_preserves_timestamp():
    profile = SolarBiasProfile(factors={"10:00": 1.5}, omitted_slots=[])
    raw = [{"timestamp": "2026-04-24T10:00:00+00:00", "value": 10.0}]

    out = adjust(raw, profile)

    assert out[0]["timestamp"] == "2026-04-24T10:00:00+00:00"


def test_raw_series_is_not_mutated():
    profile = SolarBiasProfile(factors={"10:00": 2.0}, omitted_slots=[])
    raw = [{"timestamp": "2026-04-24T10:00:00+00:00", "value": 5.0}]
    raw_copy = deepcopy(raw)

    out = adjust(raw, profile)

    # original should be unchanged
    assert raw == raw_copy
    # output is a new list
    assert out is not raw
    assert out[0] is not raw[0]


def test_empty_raw_returns_empty():
    profile = SolarBiasProfile(factors={"10:00": 2.0}, omitted_slots=[])
    raw: list[dict[str, Any]] = []

    out = adjust(raw, profile)

    assert out == []


def test_unparseable_timestamp_preserves_point():
    profile = SolarBiasProfile(factors={"10:00": 2.0}, omitted_slots=[])
    raw = [{"timestamp": "not-a-timestamp", "value": 10.0}]

    out = adjust(raw, profile)

    # point should be preserved (copied but equal)
    assert out == raw
    assert out is not raw
    assert out[0] is not raw[0]


def test_missing_value_preserves_point():
    profile = SolarBiasProfile(factors={"10:00": 2.0}, omitted_slots=[])
    raw = [{"timestamp": "2026-04-24T10:00:00+00:00"}]

    out = adjust(raw, profile)

    assert out == raw
    assert out is not raw
    assert out[0] is not raw[0]
