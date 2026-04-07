from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
TZ = ZoneInfo("Europe/Prague")
UTC = timezone.utc


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

    homeassistant_pkg = sys.modules.get("homeassistant")
    if homeassistant_pkg is None:
        homeassistant_pkg = types.ModuleType("homeassistant")
        sys.modules["homeassistant"] = homeassistant_pkg

    core_mod = sys.modules.get("homeassistant.core")
    if core_mod is None:
        core_mod = types.ModuleType("homeassistant.core")
        sys.modules["homeassistant.core"] = core_mod
    if not hasattr(core_mod, "HomeAssistant"):
        core_mod.HomeAssistant = type("HomeAssistant", (), {})

    components_pkg = sys.modules.get("homeassistant.components")
    if components_pkg is None:
        components_pkg = types.ModuleType("homeassistant.components")
        sys.modules["homeassistant.components"] = components_pkg

    recorder_mod = sys.modules.get("homeassistant.components.recorder")
    if recorder_mod is None:
        recorder_mod = types.ModuleType("homeassistant.components.recorder")
        sys.modules["homeassistant.components.recorder"] = recorder_mod
    if not hasattr(recorder_mod, "get_instance"):
        recorder_mod.get_instance = lambda hass: None

    history_mod = sys.modules.get("homeassistant.components.recorder.history")
    if history_mod is None:
        history_mod = types.ModuleType("homeassistant.components.recorder.history")
        sys.modules["homeassistant.components.recorder.history"] = history_mod
    if not hasattr(history_mod, "state_changes_during_period"):
        history_mod.state_changes_during_period = lambda *args, **kwargs: {}

    util_pkg = sys.modules.get("homeassistant.util")
    if util_pkg is None:
        util_pkg = types.ModuleType("homeassistant.util")
        sys.modules["homeassistant.util"] = util_pkg

    dt_mod = sys.modules.get("homeassistant.util.dt")
    if dt_mod is None:
        dt_mod = types.ModuleType("homeassistant.util.dt")
        sys.modules["homeassistant.util.dt"] = dt_mod
    if not hasattr(dt_mod, "as_local"):
        dt_mod.as_local = lambda value: value
    if not hasattr(dt_mod, "as_utc"):
        dt_mod.as_utc = lambda value: value
    util_pkg.dt = dt_mod


class _FakeDtUtil:
    @staticmethod
    def as_local(value: datetime) -> datetime:
        if value.tzinfo == TZ:
            return value
        return value.astimezone(TZ)

    @staticmethod
    def as_utc(value: datetime) -> datetime:
        if value.tzinfo == UTC:
            return value
        return value.astimezone(UTC)


_install_import_stubs()

from custom_components.helman import recorder_hourly_series  # noqa: E402


class ForecastRecorderSlotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._dt_patcher = patch.object(
            recorder_hourly_series,
            "dt_util",
            _FakeDtUtil,
        )
        cls._dt_patcher.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls._dt_patcher.stop()

    def test_get_local_current_slot_start_floors_to_interval(self) -> None:
        self.assertEqual(
            recorder_hourly_series.get_local_current_slot_start(
                datetime(2026, 3, 20, 21, 7, tzinfo=TZ),
                interval_minutes=15,
            ).isoformat(),
            "2026-03-20T21:00:00+01:00",
        )
        self.assertEqual(
            recorder_hourly_series.get_local_current_slot_start(
                datetime(2026, 3, 20, 21, 29, tzinfo=TZ),
                interval_minutes=15,
            ).isoformat(),
            "2026-03-20T21:15:00+01:00",
        )
        self.assertEqual(
            recorder_hourly_series.get_local_current_slot_start(
                datetime(2026, 3, 20, 21, 59, tzinfo=TZ),
                interval_minutes=60,
            ).isoformat(),
            "2026-03-20T21:00:00+01:00",
        )

    def test_get_today_completed_local_slots_excludes_current_slot(self) -> None:
        slots = recorder_hourly_series.get_today_completed_local_slots(
            datetime(2026, 3, 20, 21, 7, tzinfo=TZ),
            interval_minutes=15,
        )

        self.assertEqual(len(slots), 84)
        self.assertEqual(slots[0].isoformat(), "2026-03-20T00:00:00+01:00")
        self.assertEqual(slots[-1].isoformat(), "2026-03-20T20:45:00+01:00")

    def test_get_today_completed_local_slot_boundaries_include_current_slot(self) -> None:
        boundaries = recorder_hourly_series.get_today_completed_local_slot_boundaries(
            datetime(2026, 3, 20, 21, 7, tzinfo=TZ),
            interval_minutes=15,
        )

        self.assertEqual(len(boundaries), 85)
        self.assertEqual(boundaries[-1].isoformat(), "2026-03-20T21:00:00+01:00")

    def test_hourly_helpers_delegate_to_slot_helpers(self) -> None:
        reference_time = datetime(2026, 3, 20, 21, 7, tzinfo=TZ)

        self.assertEqual(
            recorder_hourly_series.get_local_current_hour_start(reference_time),
            recorder_hourly_series.get_local_current_slot_start(
                reference_time,
                interval_minutes=60,
            ),
        )
        self.assertEqual(
            recorder_hourly_series.get_today_completed_local_hours(reference_time),
            recorder_hourly_series.get_today_completed_local_slots(
                reference_time,
                interval_minutes=60,
            ),
        )

    def test_build_local_slot_starts_until_skips_spring_forward_gap(self) -> None:
        slots = recorder_hourly_series._build_local_slot_starts_until(
            datetime(2026, 3, 29, 0, 0, tzinfo=TZ),
            datetime(2026, 3, 30, 0, 0, tzinfo=TZ),
            interval_minutes=15,
        )

        self.assertEqual(len(slots), 92)
        self.assertEqual(slots[7].isoformat(), "2026-03-29T01:45:00+01:00")
        self.assertEqual(slots[8].isoformat(), "2026-03-29T03:00:00+02:00")

    def test_sample_state_values_at_boundaries_uses_latest_value_at_or_before_boundary(self) -> None:
        boundaries = [
            datetime(2026, 3, 20, 10, 15, tzinfo=UTC),
            datetime(2026, 3, 20, 10, 30, tzinfo=UTC),
        ]
        states = [
            SimpleNamespace(
                state="1.5",
                last_updated=datetime(2026, 3, 20, 10, 5, tzinfo=UTC),
            ),
            SimpleNamespace(
                state="2.0",
                last_updated=datetime(2026, 3, 20, 10, 20, tzinfo=UTC),
            ),
        ]

        samples = recorder_hourly_series._sample_state_values_at_boundaries(
            states,
            boundaries,
        )

        self.assertEqual(
            samples,
            {
                boundaries[0]: 1.5,
                boundaries[1]: 2.0,
            },
        )

    def test_build_slot_energy_changes_skips_negative_and_missing_deltas(self) -> None:
        boundaries = [
            datetime(2026, 3, 20, 10, 0, tzinfo=UTC),
            datetime(2026, 3, 20, 10, 15, tzinfo=UTC),
            datetime(2026, 3, 20, 10, 30, tzinfo=UTC),
            datetime(2026, 3, 20, 10, 45, tzinfo=UTC),
        ]
        samples = {
            boundaries[0]: 1.0,
            boundaries[1]: 1.25,
            boundaries[2]: 1.2,
        }

        changes = recorder_hourly_series._build_slot_energy_changes_from_boundaries(
            boundaries,
            samples,
        )

        self.assertEqual(changes, {boundaries[0]: 0.25})

    def test_build_switch_on_intervals_clamps_to_window(self) -> None:
        states = [
            SimpleNamespace(
                state="on",
                last_updated=datetime(2026, 3, 20, 9, 50, tzinfo=UTC),
            ),
            SimpleNamespace(
                state="off",
                last_updated=datetime(2026, 3, 20, 10, 30, tzinfo=UTC),
            ),
            SimpleNamespace(
                state="on",
                last_updated=datetime(2026, 3, 20, 10, 45, tzinfo=UTC),
            ),
            SimpleNamespace(
                state="off",
                last_updated=datetime(2026, 3, 20, 11, 10, tzinfo=UTC),
            ),
        ]

        intervals = recorder_hourly_series._build_switch_on_intervals(
            states=states,
            window_start=datetime(2026, 3, 20, 10, 0, tzinfo=UTC),
            window_end=datetime(2026, 3, 20, 11, 0, tzinfo=UTC),
        )

        self.assertEqual(
            intervals,
            [
                (
                    datetime(2026, 3, 20, 10, 0, tzinfo=UTC),
                    datetime(2026, 3, 20, 10, 30, tzinfo=UTC),
                ),
                (
                    datetime(2026, 3, 20, 10, 45, tzinfo=UTC),
                    datetime(2026, 3, 20, 11, 0, tzinfo=UTC),
                ),
            ],
        )

    def test_estimate_average_hourly_energy_for_on_intervals(self) -> None:
        switch_states = [
            SimpleNamespace(
                state="on",
                last_updated=datetime(2026, 3, 20, 10, 0, tzinfo=UTC),
            ),
            SimpleNamespace(
                state="off",
                last_updated=datetime(2026, 3, 20, 10, 30, tzinfo=UTC),
            ),
            SimpleNamespace(
                state="on",
                last_updated=datetime(2026, 3, 20, 10, 45, tzinfo=UTC),
            ),
            SimpleNamespace(
                state="off",
                last_updated=datetime(2026, 3, 20, 11, 0, tzinfo=UTC),
            ),
        ]
        energy_states = [
            SimpleNamespace(
                state="0.0",
                attributes={"unit_of_measurement": "kWh"},
                last_updated=datetime(2026, 3, 20, 10, 0, tzinfo=UTC),
            ),
            SimpleNamespace(
                state="0.5",
                attributes={"unit_of_measurement": "kWh"},
                last_updated=datetime(2026, 3, 20, 10, 30, tzinfo=UTC),
            ),
            SimpleNamespace(
                state="0.75",
                attributes={"unit_of_measurement": "kWh"},
                last_updated=datetime(2026, 3, 20, 10, 45, tzinfo=UTC),
            ),
            SimpleNamespace(
                state="1.25",
                attributes={"unit_of_measurement": "kWh"},
                last_updated=datetime(2026, 3, 20, 11, 0, tzinfo=UTC),
            ),
        ]

        estimate = recorder_hourly_series._estimate_average_hourly_energy_kwh_for_on_intervals(
            switch_states=switch_states,
            energy_states=energy_states,
            window_start=datetime(2026, 3, 20, 10, 0, tzinfo=UTC),
            window_end=datetime(2026, 3, 20, 11, 0, tzinfo=UTC),
            default_unit="kWh",
        )

        self.assertEqual(estimate, 1.3333)


if __name__ == "__main__":
    unittest.main()
