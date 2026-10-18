from __future__ import annotations

import sys
import unittest
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from _ha_stubs import stub_module


PRAGUE = ZoneInfo("Europe/Prague")


def _install_import_stubs() -> None:

    homeassistant_pkg = stub_module("homeassistant")
    components_pkg = stub_module("homeassistant.components")
    recorder_pkg = stub_module("homeassistant.components.recorder")
    recorder_pkg.get_instance = lambda hass: None
    history_mod = stub_module("homeassistant.components.recorder.history")
    history_mod.state_changes_during_period = lambda *args, **kwargs: {}
    history_mod.get_significant_states = lambda *args, **kwargs: {}
    components_pkg.recorder = recorder_pkg
    core_mod = stub_module("homeassistant.core")
    core_mod.HomeAssistant = object
    homeassistant_pkg.components = components_pkg

    util_pkg = stub_module("homeassistant.util")
    dt_mod = stub_module("homeassistant.util.dt")
    if not hasattr(dt_mod, "as_local"):
        dt_mod.as_local = lambda value: value
    if not hasattr(dt_mod, "as_utc"):
        dt_mod.as_utc = lambda value: value
    dt_mod.parse_datetime = datetime.fromisoformat
    util_pkg.dt = dt_mod

    # A sibling automation test may have installed a fake recorder module; drop it
    # so the real module (with the helper under test) is imported.
    sys.modules.pop("custom_components.helman.appliance_runtime_history", None)


_install_import_stubs()

import homeassistant.util.dt as _dt_mod  # noqa: E402


def _as_local(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=PRAGUE)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)

from custom_components.helman.appliance_runtime_history import (  # noqa: E402
    _bucket_interval_hours_by_local_date,
)


class BucketIntervalHoursByLocalDateTests(unittest.TestCase):
    def setUp(self) -> None:
        # Scope a UTC-converting dt to this test's runtime so DST is handled
        # correctly (CPython returns naive wall-clock for same-tzinfo
        # subtraction) without leaking into sibling tests' identity dt stubs.
        self._saved = (_dt_mod.as_local, _dt_mod.as_utc)
        _dt_mod.as_local = _as_local
        _dt_mod.as_utc = _as_utc

    def tearDown(self) -> None:
        _dt_mod.as_local, _dt_mod.as_utc = self._saved

    def test_single_interval_within_one_day(self) -> None:
        start = datetime(2026, 7, 10, 8, 0, tzinfo=PRAGUE)
        end = datetime(2026, 7, 10, 14, 0, tzinfo=PRAGUE)
        result = _bucket_interval_hours_by_local_date([(start, end)])
        self.assertEqual(result, {date(2026, 7, 10): 6.0})

    def test_interval_spanning_midnight_splits_across_days(self) -> None:
        start = datetime(2026, 7, 10, 22, 0, tzinfo=PRAGUE)
        end = datetime(2026, 7, 11, 3, 0, tzinfo=PRAGUE)
        result = _bucket_interval_hours_by_local_date([(start, end)])
        self.assertEqual(
            result,
            {date(2026, 7, 10): 2.0, date(2026, 7, 11): 3.0},
        )

    def test_multiple_intervals_same_day_accumulate(self) -> None:
        result = _bucket_interval_hours_by_local_date(
            [
                (
                    datetime(2026, 7, 10, 8, 0, tzinfo=PRAGUE),
                    datetime(2026, 7, 10, 10, 0, tzinfo=PRAGUE),
                ),
                (
                    datetime(2026, 7, 10, 15, 0, tzinfo=PRAGUE),
                    datetime(2026, 7, 10, 16, 30, tzinfo=PRAGUE),
                ),
            ]
        )
        self.assertEqual(result, {date(2026, 7, 10): 3.5})

    def test_spring_forward_dst_day_counts_wall_clock_gap(self) -> None:
        # 2026-03-29: clocks jump 02:00 -> 03:00 local; a 01:00->04:00 local
        # interval is only 2 real hours.
        start = datetime(2026, 3, 29, 1, 0, tzinfo=PRAGUE)
        end = datetime(2026, 3, 29, 4, 0, tzinfo=PRAGUE)
        result = _bucket_interval_hours_by_local_date([(start, end)])
        self.assertEqual(result, {date(2026, 3, 29): 2.0})

    def test_empty(self) -> None:
        self.assertEqual(_bucket_interval_hours_by_local_date([]), {})


if __name__ == "__main__":
    unittest.main()
