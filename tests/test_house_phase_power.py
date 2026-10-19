"""The measured house consumption per phase the tick publishes (#458).

On-grid each phase is the inverter's output minus the meter's export plus the
EPS output; off-grid it is the EPS output alone. A missing inverter or meter
reading leaves the phase unavailable, never 0 W, and the total is unavailable
whenever a phase is.
"""

from __future__ import annotations
from tests._fakes import FakeHass, capture_signal, make_live_tracker

import unittest
from datetime import datetime
from types import SimpleNamespace

from custom_components.helman.const import (
    HOUSE_CONSUMPTION_ENTITY_ID,
    SIGNAL_LIVE_TICK,
    house_consumption_phase_entity_id,
)
from custom_components.helman.vendors import PROFILES, DeviceTelemetry

RUN_MODE = "sensor.solax_run_mode"


def _entity(quantity: str, phase: int) -> str:
    return f"sensor.solax_{quantity}_l{phase}"


def _telemetry():
    profile = PROFILES["solax_inverter"]
    entities = {key: None for key in profile.telemetry}
    entities["run_mode"] = RUN_MODE
    for phase in (1, 2, 3):
        for quantity in ("ac_power", "grid_power", "eps_power"):
            entities[f"{quantity}_l{phase}"] = _entity(quantity, phase)
    return DeviceTelemetry(profile=profile, entry=None, entities=entities)


class _FakeStates:
    def __init__(self, mapping: dict[str, str]) -> None:
        self._mapping = mapping

    def get(self, entity_id: str):
        raw = self._mapping.get(entity_id)
        return None if raw is None else SimpleNamespace(state=raw)


def _make_tracker(states: dict[str, str], *, telemetry=True):
    hass = FakeHass()
    hass.states = _FakeStates(states)
    c = make_live_tracker(hass, {})
    c._inverter_telemetry = _telemetry() if telemetry else None
    return c


def _phases(**readings: str) -> dict[str, str]:
    """``ac1="1000", grid1="200"`` → the entity states they name."""
    names = {"ac": "ac_power", "grid": "grid_power", "eps": "eps_power"}
    return {_entity(names[key[:-1]], int(key[-1])): value for key, value in readings.items()}


class HousePhasePowerTests(unittest.TestCase):
    def test_on_grid_phase_is_inverter_output_minus_export_plus_eps(self):
        # The Solax meter reads positive while exporting.
        c = _make_tracker(
            _phases(
                ac1="1000", grid1="200", eps1="50",
                ac2="300", grid2="-400",
                ac3="0", grid3="-150", eps3="0",
            )
        )

        powers = c._compute_house_phase_powers()

        self.assertEqual(powers[1], 850.0)
        # A missing EPS reading counts as 0 W; an import adds to the inverter's output.
        self.assertEqual(powers[2], 700.0)
        self.assertEqual(powers[3], 150.0)

    def test_a_sampling_skew_below_zero_floors_the_phase_at_zero(self):
        # The meter read a larger export than the inverter's output it was polled beside.
        c = _make_tracker(_phases(ac1="500", grid1="650", ac2="0", grid2="0", ac3="0", grid3="0"))

        self.assertEqual(c._compute_house_phase_powers()[1], 0.0)

    def test_a_missing_inverter_or_meter_reading_leaves_the_phase_unavailable(self):
        c = _make_tracker(
            {
                **_phases(ac1="1000", eps1="50", grid2="100", ac3="200", grid3="0"),
                _entity("ac_power", 2): "unavailable",
            }
        )

        powers = c._compute_house_phase_powers()

        self.assertIsNone(powers[1])
        self.assertIsNone(powers[2])
        self.assertEqual(powers[3], 200.0)

    def test_off_grid_counts_only_the_eps_output(self):
        c = _make_tracker(
            {
                RUN_MODE: "Off-Grid",
                **_phases(ac1="900", grid1="0", eps1="400", ac2="900", eps2="300", ac3="900"),
            }
        )

        powers = c._compute_house_phase_powers()

        self.assertEqual(powers, {1: 400.0, 2: 300.0, 3: None})

    def test_without_an_inverter_profile_every_phase_is_unavailable(self):
        c = _make_tracker(_phases(ac1="1000", grid1="0"), telemetry=False)

        self.assertEqual(c._compute_house_phase_powers(), {1: None, 2: None, 3: None})

    def test_the_tick_publishes_each_phase_and_their_sum(self):
        c = _make_tracker(
            _phases(ac1="500", grid1="0", ac2="600", grid2="-100", ac3="100", grid3="0")
        )
        sent = self._prime_tick(c)

        c._tick(datetime(2026, 10, 11, 12, 0, 0))

        self.assertEqual(self._house_values(sent), [1300.0, 500.0, 700.0, 100.0])

    def test_the_total_is_unavailable_when_any_phase_is(self):
        c = _make_tracker(_phases(ac1="500", grid1="0", ac2="600", grid2="0"))
        sent = self._prime_tick(c)

        c._tick(datetime(2026, 10, 11, 12, 0, 0))

        self.assertEqual(self._house_values(sent), [None, 500.0, 600.0, None])

    @staticmethod
    def _prime_tick(c) -> list:
        """Just enough tracker state for one tick to run; returns what it sends."""
        c._tree = {"sources": [], "consumers": []}
        return capture_signal(c._hass, SIGNAL_LIVE_TICK)

    @staticmethod
    def _house_values(sent: list) -> list:
        """The one tick's total, then phases 1-3."""
        (values,) = sent
        return [values[HOUSE_CONSUMPTION_ENTITY_ID]] + [
            values[house_consumption_phase_entity_id(phase)] for phase in (1, 2, 3)
        ]


if __name__ == "__main__":
    unittest.main()
