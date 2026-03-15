from __future__ import annotations

from typing import Any


def normalize_energy_to_kwh(
    raw_value: float,
    raw_unit: Any,
    *,
    default_unit: str | None = "wh",
) -> float | None:
    normalized_unit = default_unit
    if isinstance(raw_unit, str) and raw_unit.strip():
        normalized_unit = raw_unit.strip().lower().replace(" ", "")

    if normalized_unit is None:
        return None

    if normalized_unit == "wh":
        return raw_value / 1000
    if normalized_unit == "kwh":
        return raw_value
    if normalized_unit == "mwh":
        return raw_value * 1000
    if normalized_unit == "gwh":
        return raw_value * 1000000

    return None
