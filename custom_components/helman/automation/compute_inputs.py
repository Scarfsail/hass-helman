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
    # Per-optimizer execution-condition result, evaluated once per run against
    # current live state (fail-closed on error). Absent id == always met. Frozen
    # here so the pure optimizer loop can read it without touching ``hass``.
    condition_met_by_optimizer_id: dict[str, tuple[bool, ...]] = field(
        default_factory=dict
    )
    # Which appliances are physically running at the moment the run started,
    # by the same definition of "running" the recorder runtime query uses. Read
    # by ``appliance_runtime`` to keep an in-flight run in the plan; see
    # ``OptimizationContext.appliance_active_by_id``.
    appliance_active_by_id: dict[str, bool] = field(default_factory=dict)
