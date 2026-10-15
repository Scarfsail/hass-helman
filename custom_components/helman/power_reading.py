"""Supported power units converted to watts."""

WATTS = {"w": 1.0, "kw": 1000.0, "mw": 1_000_000.0}


def power_unit_factor(unit: str | None) -> float | None:
    """Convert supported unit spellings to a factor; a missing unit means W."""
    return WATTS.get((unit or "W").lower())
