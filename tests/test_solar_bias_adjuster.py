from __future__ import annotations

from copy import deepcopy
from typing import Any

import pytest

import sys
import types
import os

from custom_components.helman.solar_bias_correction.adjuster import adjust
from custom_components.helman.solar_bias_correction.models import SolarBiasProfile


def test_applies_factor_to_matching_slot():
    profile = SolarBiasProfile(factors={"10:00": 2.0}, omitted_slots=[])
    raw = [{"timestamp": "2026-04-24T08:00:00+00:00", "value": 100.0}]

    out = adjust(raw, profile)

    assert out[0]["value"] == 200.0
    assert out[0]["timestamp"] == raw[0]["timestamp"]


def test_missing_slot_defaults_to_factor_1():
    profile = SolarBiasProfile(factors={}, omitted_slots=[])
    raw = [{"timestamp": "2026-04-24T08:00:00+00:00", "value": 100.0}]

    out = adjust(raw, profile)

    assert out[0]["value"] == 100.0


def test_zero_raw_stays_zero():
    profile = SolarBiasProfile(factors={"10:00": 2.0}, omitted_slots=[])
    raw = [{"timestamp": "2026-04-24T08:00:00+00:00", "value": 0.0}]

    out = adjust(raw, profile)

    assert out[0]["value"] == 0.0


def test_non_negativity_clamp():
    profile = SolarBiasProfile(factors={"10:00": -1.0}, omitted_slots=[])
    raw = [{"timestamp": "2026-04-24T08:00:00+00:00", "value": 100.0}]

    out = adjust(raw, profile)

    assert out[0]["value"] == 0.0


def test_preserves_timestamp():
    profile = SolarBiasProfile(factors={"10:00": 1.5}, omitted_slots=[])
    raw = [{"timestamp": "2026-04-24T08:00:00+00:00", "value": 10.0}]

    out = adjust(raw, profile)

    assert out[0]["timestamp"] == "2026-04-24T08:00:00+00:00"


def test_raw_series_is_not_mutated():
    profile = SolarBiasProfile(factors={"10:00": 2.0}, omitted_slots=[])
    raw = [{"timestamp": "2026-04-24T08:00:00+00:00", "value": 5.0}]
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
    raw = [{"timestamp": "2026-04-24T08:00:00+00:00"}]

    out = adjust(raw, profile)

    assert out == raw
    assert out is not raw
    assert out[0] is not raw[0]
