"""What counts as a counter reset, and what is only the meter wobbling.

The unwrap that lifts a resetting cumulative meter into a monotonic series is
shared by every energy reader in the integration -- the inspector's 15-minute
day, the hourly long-term statistics behind the month and year views, today's
consumption forecast and the house-consumption training -- so a
misclassification here is not a drawing bug, it is a wrong number everywhere at
once.

Both directions are load-bearing and both are tested here:

* A drop too shallow to be a reset must be treated as a dip. A lifetime meter
  reporting 9143.2 kWh to one decimal ticks back to 9143.1 and never returns,
  so no rebound window of any length suppresses it; called a reset, it lifts
  every later reading by the whole 9143.2 and hands the slot it falls in the
  meter's entire lifetime reading as a quarter-hour's energy. That is the real
  ``sensor.solax_ev_charger_charge_added_total`` on 2026-08-21, which drew a
  9143.2 kWh bar for an EV charger that did not charge at all that day.
* A counter that really restarts must still be a reset, or a daily meter's
  midnight restart would swallow the whole next day.
"""

from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
TZ = ZoneInfo("Europe/Prague")
UTC = timezone.utc
DAY = datetime(2026, 8, 21, 0, 0, tzinfo=TZ)


def _install_import_stubs() -> None:
    """Enough of Home Assistant to import the module under test.

    The functions exercised here are pure, so the recorder is never called and
    the stubs never have to do anything -- they only have to exist for the
    import to succeed.
    """
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
    if not hasattr(history_mod, "get_significant_states"):
        history_mod.get_significant_states = lambda *args, **kwargs: {}

    util_pkg = sys.modules.get("homeassistant.util")
    if util_pkg is None:
        util_pkg = types.ModuleType("homeassistant.util")
        sys.modules["homeassistant.util"] = util_pkg

    dt_mod = sys.modules.get("homeassistant.util.dt")
    if dt_mod is None:
        dt_mod = types.ModuleType("homeassistant.util.dt")
        sys.modules["homeassistant.util.dt"] = dt_mod
    if not hasattr(dt_mod, "as_local"):
        dt_mod.as_local = lambda value: value.astimezone(TZ)
    if not hasattr(dt_mod, "as_utc"):
        dt_mod.as_utc = lambda value: value.astimezone(UTC)
    util_pkg.dt = dt_mod


_install_import_stubs()

from custom_components.helman import recorder_hourly_series  # noqa: E402


def _state(local_time: datetime, value_kwh: float) -> SimpleNamespace:
    return SimpleNamespace(
        state=str(round(value_kwh, 6)),
        attributes={"unit_of_measurement": "kWh"},
        last_updated=local_time.astimezone(UTC),
    )


def _quarter_hour_boundaries() -> list[datetime]:
    """The day's 15-minute boundaries, as the inspector's day read builds them."""
    return [(DAY + timedelta(minutes=15 * index)).astimezone(UTC) for index in range(97)]


def _slot_energy(states: list[SimpleNamespace]) -> dict[datetime, float]:
    # These fixtures compress a day into blips every 15-60 minutes as a
    # readable stand-in for a real device's much denser reporting; they are
    # not simulating a recorder gap. Staleness is exercised on its own in
    # test_recorder_carry_staleness.py, so it is switched off here to keep
    # this file about reset/dip detection only.
    return recorder_hourly_series._slot_energy_changes_from_states(
        states,
        default_unit="kWh",
        utc_boundaries=_quarter_hour_boundaries(),
        staleness_limit=None,
    )


def _repeated(
    *, start: datetime, end: datetime, step: timedelta, value: float
) -> list[SimpleNamespace]:
    """A meter that reports the same reading over and over, as an idle one does."""
    states: list[SimpleNamespace] = []
    cursor = start
    while cursor < end:
        states.append(_state(cursor, value))
        cursor += step
    return states


class ShallowDropTests(unittest.TestCase):
    """A drop that stays near the meter's own value is a dip, not a reset."""

    @staticmethod
    def _lifetime_meter_day() -> list[SimpleNamespace]:
        """2026-08-21 as the recorder really holds it, in miniature.

        The charger sat at 9143.1 kWh all day and charged nothing. Its last
        digit blinked up to 9143.2 in the morning, and at 23:18 it fell back --
        for good: the meter goes on from 9143.1 the next day, so the reading it
        dropped from never returns.
        """
        states = _repeated(
            start=DAY,
            end=DAY + timedelta(hours=8),
            step=timedelta(minutes=20),
            value=9143.1,
        )
        states += _repeated(
            start=DAY + timedelta(hours=8),
            end=DAY + timedelta(hours=23, minutes=18),
            step=timedelta(minutes=20),
            value=9143.2,
        )
        states += _repeated(
            start=DAY + timedelta(hours=23, minutes=18),
            end=DAY + timedelta(hours=24),
            step=timedelta(minutes=20),
            value=9143.1,
        )
        return states

    def test_a_last_digit_dip_on_a_lifetime_meter_is_not_a_reset(self) -> None:
        by_slot = _slot_energy(self._lifetime_meter_day())

        # The whole day is the 0.1 the last digit ticked up by, and nothing in
        # it is anywhere near the meter's own reading.
        self.assertAlmostEqual(sum(by_slot.values()), 0.1, places=6)
        self.assertLess(max(by_slot.values()), 1.0)

    def test_the_dip_ends_the_ratchet_where_it_stood(self) -> None:
        """The reading is dropped, not carried: the segment keeps its maximum.

        Which is what makes the day after the dip right as well -- the meter has
        to climb past 9143.2 again before it books any energy, so the 0.1 it
        never really produced is given back rather than counted twice.
        """
        states = self._lifetime_meter_day()
        states += _repeated(
            start=DAY + timedelta(hours=24),
            end=DAY + timedelta(hours=24, minutes=30),
            step=timedelta(minutes=15),
            value=9143.15,
        )
        boundaries = [
            *_quarter_hour_boundaries(),
            (DAY + timedelta(hours=24, minutes=15)).astimezone(UTC),
            (DAY + timedelta(hours=24, minutes=30)).astimezone(UTC),
        ]

        by_slot = recorder_hourly_series._slot_energy_changes_from_states(
            states, default_unit="kWh", utc_boundaries=boundaries, staleness_limit=None
        )

        self.assertAlmostEqual(sum(by_slot.values()), 0.1, places=6)

    def test_the_hourly_statistics_path_suppresses_the_same_dip(self) -> None:
        """The month and year views read the same day at sixty minutes.

        They come through ``unwrap_cumulative_energy_series`` rather than the
        raw-state door, so the rule has to hold there too -- an hourly series
        carries the dip as one row, with a whole day of rows after it.
        """
        samples = [
            ((DAY + timedelta(hours=hour)).astimezone(UTC), 9143.1)
            for hour in range(8)
        ]
        samples += [
            ((DAY + timedelta(hours=hour)).astimezone(UTC), 9143.2)
            for hour in range(8, 23)
        ]
        samples += [
            ((DAY + timedelta(hours=23)).astimezone(UTC), 9143.1),
            ((DAY + timedelta(hours=24)).astimezone(UTC), 9143.1),
        ]

        unwrapped = recorder_hourly_series.unwrap_cumulative_energy_series(
            samples, rebound_window=timedelta(hours=1)
        )

        values = [value for _instant, value in unwrapped]
        self.assertLessEqual(max(values) - min(values), 0.1 + 1e-6)


class RealResetTests(unittest.TestCase):
    """A counter that restarts must still lift the rest of the series."""

    def test_a_daily_meter_restarting_at_zero_is_still_a_reset(self) -> None:
        states = [
            _state(DAY + timedelta(hours=hour), round(0.5 * hour, 6))
            for hour in range(20)
        ]
        # The device restarted at 20:00 and the counter began again.
        states += [
            _state(DAY + timedelta(hours=20), 0.0),
            _state(DAY + timedelta(hours=22), 1.0),
            _state(DAY + timedelta(hours=23, minutes=45), 1.5),
        ]

        by_slot = _slot_energy(states)

        # Everything before the reset, plus everything the new counter ran up.
        self.assertAlmostEqual(sum(by_slot.values()), 9.5 + 1.5, places=6)

    def test_a_deep_dip_that_comes_back_is_still_suppressed(self) -> None:
        """The rebound window keeps its job: a >10% drop that recovers is a
        glitch, and only the reading is thrown away."""
        states = [
            _state(DAY + timedelta(hours=hour), round(0.5 * hour, 6))
            for hour in range(20)
        ]
        states.append(_state(DAY + timedelta(hours=20), 0.0))
        states.append(_state(DAY + timedelta(hours=20, minutes=10), 9.5))
        states.append(_state(DAY + timedelta(hours=23), 10.0))

        by_slot = _slot_energy(states)

        self.assertAlmostEqual(sum(by_slot.values()), 10.0, places=6)


if __name__ == "__main__":
    unittest.main()
