"""Pin the canonical floor before moving it out of recorder code."""

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from homeassistant.util import dt as dt_util

from custom_components.helman.slot_grid import floor_to_slot

TZ = ZoneInfo("Europe/Prague")


@pytest.mark.parametrize(
    "value",
    [datetime(2026, 1, 3, 12, 38, 59), datetime(2026, 1, 3, 12, 38, 59, tzinfo=TZ)],
)
def test_floor_preserves_current_naive_and_aware_handling(value):
    result = floor_to_slot(value, interval_minutes=15)
    assert result == dt_util.as_local(value).replace(minute=30, second=0, microsecond=0)


@pytest.mark.parametrize("interval", [0, -1, True, 1.5, "15"])
def test_invalid_intervals(interval):
    with pytest.raises(ValueError, match="positive integer"):
        floor_to_slot(datetime(2026, 1, 3, tzinfo=TZ), interval_minutes=interval)


@pytest.mark.parametrize(
    "day, count",
    [(datetime(2026, 3, 29, tzinfo=TZ), 92), (datetime(2026, 10, 25, tzinfo=TZ), 100)],
)
def test_dst_day_floors_every_real_quarter_hour(day, count):
    start = dt_util.as_utc(day)
    end = dt_util.as_utc(day + timedelta(days=1))
    assert int((end - start).total_seconds() / 900) == count
    for index in range(count):
        instant = start + timedelta(minutes=15 * index)
        actual = floor_to_slot(instant + timedelta(minutes=7), interval_minutes=15)
        assert dt_util.as_utc(actual) == instant


@pytest.mark.parametrize(
    "day, count",
    [(datetime(2026, 3, 29, tzinfo=TZ), 92), (datetime(2026, 10, 25, tzinfo=TZ), 100)],
)
def test_real_slots_and_wall_labels_have_distinct_dst_contracts(day, count):
    from custom_components.helman.slot_grid import day_slots, slot_starts

    real = day_slots(day.date(), tzinfo=TZ)
    labels = day_slots(day.date(), tzinfo=TZ, wall_clock=True)
    assert len(real) == count
    assert len(labels) == 96
    assert [value.strftime("%H:%M") for value in labels] == [
        f"{hour:02d}:{minute:02d}" for hour in range(24) for minute in (0, 15, 30, 45)
    ]
    assert slot_starts(day, day + timedelta(days=1), utc=True) == [
        dt_util.as_utc(value) for value in real
    ]


@pytest.mark.parametrize(
    "slot, minutes", [("00:00", 0), ("12:15", 735), ("23:59", 1439)]
)
def test_slot_to_minutes(slot, minutes):
    from custom_components.helman.slot_grid import slot_to_minutes

    assert slot_to_minutes(slot) == minutes


@pytest.mark.parametrize("slot", ["24:00", "-1:00", "12:60", "12", "bad", "12:00:00"])
def test_slot_to_minutes_rejects_invalid_labels(slot):
    from custom_components.helman.slot_grid import slot_to_minutes

    with pytest.raises(ValueError):
        slot_to_minutes(slot)
