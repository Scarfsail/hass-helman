from __future__ import annotations

import sys
import types
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
PRAGUE = ZoneInfo("Europe/Prague")


def _install_import_stubs() -> None:
    custom_components_pkg = sys.modules.get("custom_components")
    if custom_components_pkg is None:
        custom_components_pkg = types.ModuleType("custom_components")
        sys.modules["custom_components"] = custom_components_pkg
    custom_components_pkg.__path__ = [str(ROOT / "custom_components")]

    helman_pkg = sys.modules.get("custom_components.helman")
    if helman_pkg is None:
        helman_pkg = types.ModuleType("custom_components.helman")
        sys.modules["custom_components.helman"] = helman_pkg
    helman_pkg.__path__ = [str(ROOT / "custom_components" / "helman")]

    def _ensure(name: str) -> types.ModuleType:
        mod = sys.modules.get(name)
        if mod is None:
            mod = types.ModuleType(name)
            sys.modules[name] = mod
        return mod

    homeassistant_pkg = _ensure("homeassistant")
    components_pkg = _ensure("homeassistant.components")
    recorder_pkg = _ensure("homeassistant.components.recorder")
    recorder_pkg.get_instance = lambda hass: None
    history_mod = _ensure("homeassistant.components.recorder.history")
    history_mod.state_changes_during_period = lambda *args, **kwargs: {}
    components_pkg.recorder = recorder_pkg
    core_mod = _ensure("homeassistant.core")
    core_mod.HomeAssistant = object
    homeassistant_pkg.components = components_pkg

    util_pkg = _ensure("homeassistant.util")
    dt_mod = _ensure("homeassistant.util.dt")

    def _as_local(value: datetime) -> datetime:
        if value.tzinfo is None:
            return value.replace(tzinfo=PRAGUE)
        return value.astimezone(PRAGUE)

    def _as_utc(value: datetime) -> datetime:
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    dt_mod.as_local = _as_local
    dt_mod.as_utc = _as_utc
    dt_mod.parse_datetime = datetime.fromisoformat
    util_pkg.dt = dt_mod


_install_import_stubs()

from custom_components.helman.recorder_hourly_series import (  # noqa: E402
    _bucket_interval_hours_by_local_date,
)


class BucketIntervalHoursByLocalDateTests(unittest.TestCase):
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
