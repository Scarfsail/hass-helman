from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import pytest

import sys
import types
import os

from homeassistant.util import dt as dt_util

from custom_components.helman.solar_bias_correction.adjuster import (
    adjust,
    apply_live_day_ratio,
    live_day_ratio,
)
from custom_components.helman.solar_bias_correction.models import (
    BiasConfig,
    SolarBiasProfile,
)


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


# --- live day ratio ---------------------------------------------------------

PRAGUE = ZoneInfo("Europe/Prague")
DAY = date(2026, 11, 2)


@pytest.fixture
def prague():
    previous = dt_util.get_default_time_zone()
    dt_util.set_default_time_zone(PRAGUE)
    yield
    dt_util.set_default_time_zone(previous)


def _cfg(**overrides) -> BiasConfig:
    return BiasConfig(
        enabled=True,
        min_history_days=10,
        training_time="03:00",
        clamp_min=0.0,
        clamp_max=3.0,
        daily_energy_entity_ids=[],
        total_energy_entity_id=None,
        **overrides,
    )


def _at(hhmm: str, day: date = DAY) -> datetime:
    hour, minute = (int(part) for part in hhmm.split(":"))
    return datetime.combine(day, time(hour, minute), tzinfo=PRAGUE)


def _points(values: dict[str, float], day: date = DAY) -> list[dict[str, Any]]:
    return [
        {"timestamp": _at(hhmm, day).isoformat(), "value": value}
        for hhmm, value in values.items()
    ]


def _by_slot(points: list[dict[str, Any]], day: date = DAY) -> dict[str, float]:
    return {
        datetime.fromisoformat(p["timestamp"]).astimezone(PRAGUE).strftime("%H:%M"): p["value"]
        for p in points
        if datetime.fromisoformat(p["timestamp"]).astimezone(PRAGUE).date() == day
    }


# Today's corrected forecast: four production slots of 100 Wh each.
FORECAST = {"09:45": 0.0, "10:00": 100.0, "10:15": 100.0, "10:30": 100.0, "10:45": 100.0}
HALF = {"09:45": 0.0, "10:00": 50.0, "10:15": 50.0, "10:30": 50.0}


@pytest.mark.parametrize(
    ("now", "share", "weight"),
    [
        # 100 of 400 Wh elapsed: half way to full confidence.
        ("10:15", 0.25, 0.5),
        # 200 of 400 Wh: exactly at full_confidence_share.
        ("10:30", 0.5, 1.0),
        # 300 of 400 Wh: past it, the weight stays at 1.
        ("10:52", 0.75, 1.0),
    ],
)
def test_live_day_ratio_ramps_weight_with_the_elapsed_share(prague, now, share, weight):
    live = live_day_ratio(_points(FORECAST), _points(HALF), _at(now), _cfg())

    assert live.ratio == pytest.approx(0.5)
    assert live.applied_ratio == pytest.approx(0.5)
    assert live.elapsed_share == pytest.approx(share)
    assert live.weight == pytest.approx(weight)
    assert live.factor == pytest.approx(0.5**weight)


@pytest.mark.parametrize(
    ("actual_wh", "ratio", "applied"),
    [(10.0, 0.1, 0.3), (500.0, 5.0, 2.0)],
)
def test_live_day_ratio_clamps_at_both_ends(prague, actual_wh, ratio, applied):
    actual = _points({"10:00": actual_wh, "10:15": actual_wh})

    live = live_day_ratio(_points(FORECAST), actual, _at("10:30"), _cfg())

    assert live.ratio == pytest.approx(ratio)
    assert live.applied_ratio == pytest.approx(applied)
    assert live.factor == pytest.approx(applied)


def test_apply_scales_only_todays_remaining_slots(prague):
    yesterday = DAY - timedelta(days=1)
    tomorrow = DAY + timedelta(days=1)
    points = (
        _points(FORECAST, yesterday) + _points(FORECAST) + _points(FORECAST, tomorrow)
    )
    original = deepcopy(points)
    now = _at("10:37")
    live = live_day_ratio(points, _points(HALF), now, _cfg())

    out = apply_live_day_ratio(points, live, now)

    assert points == original
    assert all(o is not p for o, p in zip(out, points))
    assert _by_slot(out) == {
        "09:45": 0.0,
        "10:00": 100.0,
        "10:15": 100.0,
        # The running slot is still ahead of the meter and is scaled.
        "10:30": 50.0,
        "10:45": 50.0,
    }
    assert _by_slot(out, yesterday) == FORECAST
    assert _by_slot(out, tomorrow) == FORECAST


def test_no_live_ratio_before_anything_has_elapsed(prague):
    assert live_day_ratio(_points(FORECAST), _points(HALF), _at("10:00"), _cfg()) is None


def test_no_live_ratio_when_the_elapsed_forecast_is_zero(prague):
    # Only the dark 09:45 slot has elapsed: a measured zero against a zero forecast.
    actual = _points({"09:45": 0.0})

    assert live_day_ratio(_points(FORECAST), actual, _at("10:05"), _cfg()) is None


def test_no_live_ratio_from_an_empty_actual_history(prague):
    assert live_day_ratio(_points(FORECAST), [], _at("10:52"), _cfg()) is None


def test_no_live_ratio_without_a_corrected_forecast_today(prague):
    forecast = {hhmm: 0.0 for hhmm in FORECAST}

    assert live_day_ratio(_points(forecast), _points(HALF), _at("10:52"), _cfg()) is None


def test_a_missing_slot_is_no_evidence_but_an_explicit_zero_counts(prague):
    # The 2026-11-10 shape: the day's first production slot never reached the
    # history, the next one is a measured zero.
    forecast = {"08:30": 100.0, "08:45": 100.0, "09:00": 100.0, "09:15": 100.0}
    actual = _points({"08:45": 0.0, "09:00": 100.0})

    live = live_day_ratio(_points(forecast), actual, _at("09:15"), _cfg())

    # 08:30 is out of both sides; 08:45 and 09:00 are in.
    assert live.ratio == pytest.approx(100.0 / 200.0)
    assert live.elapsed_share == pytest.approx(200.0 / 400.0)


def test_partial_coverage_lowers_the_weight(prague):
    # Ten slots of 100 Wh; five have elapsed (50 % of the day) but one of them
    # is missing from the history, holding 10 % of the day's energy.
    slots = [f"{10 + i // 4:02d}:{(i % 4) * 15:02d}" for i in range(10)]
    forecast = {hhmm: 100.0 for hhmm in slots}
    actual = _points({hhmm: 50.0 for hhmm in slots[:5] if hhmm != slots[2]})

    live = live_day_ratio(_points(forecast), actual, _at(slots[5]), _cfg())

    assert live.elapsed_share == pytest.approx(0.4)
    assert live.weight == pytest.approx(0.8)
    assert live.factor == pytest.approx(0.5**0.8)


def test_live_day_ratio_on_a_dst_length_day(prague):
    # 2026-10-25 is 25 hours long in Prague: 100 slots, 02:00-02:45 twice.
    dst_day = date(2026, 10, 25)
    start = datetime.combine(dst_day, time(0, 0), tzinfo=PRAGUE).astimezone(timezone.utc)
    end = datetime.combine(dst_day + timedelta(days=1), time(0, 0), tzinfo=PRAGUE).astimezone(
        timezone.utc
    )
    slots = []
    while start < end:
        slots.append(start)
        start += timedelta(minutes=15)
    assert len(slots) == 100
    points = [
        {"timestamp": dt_util.as_local(slot).isoformat(), "value": 10.0} for slot in slots
    ]
    # Now is the second 02:15, after the clocks went back.
    now = slots[13]
    assert dt_util.as_local(now).strftime("%H:%M") == "02:15"
    assert dt_util.as_local(now).fold == 1
    actual = [
        {"timestamp": dt_util.as_local(slot).isoformat(), "value": 5.0}
        for slot in slots[:13]
    ]

    live = live_day_ratio(points, actual, now, _cfg())
    out = apply_live_day_ratio(points, live, now)

    assert live.elapsed_share == pytest.approx(13 / 100)
    assert live.weight == pytest.approx(0.26)
    # The first 02:15 has elapsed and keeps its value; the second is scaled.
    assert out[9]["value"] == 10.0
    assert out[13]["value"] == pytest.approx(10.0 * live.factor)
    assert [p["value"] for p in out[:13]] == [10.0] * 13
    assert all(p["value"] == pytest.approx(10.0 * live.factor) for p in out[13:])
