"""Supported power units converted to watts."""

from __future__ import annotations

from typing import Any

from .power_polarity import watts_for_value_type

WATTS = {"w": 1.0, "kw": 1000.0, "mw": 1_000_000.0}


def power_unit_factor(unit: str | None) -> float | None:
    """Convert supported unit spellings to a factor; a missing unit means W."""
    if unit == "mW":
        return None
    return WATTS.get((unit or "W").lower())


def state_watts(state: Any, value_type: str) -> float | None:
    """A power sensor state as the watts a node of ``value_type`` carries.

    Two explicit steps: the state's unit to W, then the sign the node keeps.
    ``None`` when there is no state, or it is not a number in a supported unit.
    """
    if state is None or state.state in ("unavailable", "unknown", "none"):
        return None
    try:
        raw = float(state.state)
    except ValueError:
        return None
    factor = power_unit_factor(getattr(state, "attributes", {}).get("unit_of_measurement"))
    return None if factor is None else watts_for_value_type(raw * factor, value_type)
