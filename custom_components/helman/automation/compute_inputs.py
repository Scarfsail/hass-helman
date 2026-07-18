"""Run-invariant, hass-free inputs for the forecast/automation compute path.

The automation pipeline reads a handful of live values (battery SoC, recorder
actual history, EV remaining capacity) that are fixed for the duration of one
run — only the schedule document mutates between optimizer iterations. Gathering
them once on the event loop into this immutable container lets the compute path
(forecast rebuild + optimizer loop) run pure and off-loop.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..battery_state import BatteryLiveState


@dataclass(frozen=True)
class ComputeInputs:
    """Immutable snapshot of the I/O-derived inputs a forecast rebuild needs.

    Contains only plain data / read-only values — no ``hass`` reference — so it
    is safe to pass across the executor boundary.
    """

    battery_live_state: "BatteryLiveState | None" = None
    battery_actual_history: list[dict[str, Any]] = field(default_factory=list)
    vehicle_remaining_capacity_kwh_by_vehicle_id: dict[str, float | None] = field(
        default_factory=dict
    )
