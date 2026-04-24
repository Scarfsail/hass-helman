from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.util.dt import as_local

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import SolarBiasProfile


def _parse_timestamp(raw: Any) -> datetime | None:
    if not isinstance(raw, str):
        return None
    try:
        # datetime.fromisoformat handles offsets like +00:00
        return datetime.fromisoformat(raw)
    except Exception:
        return None


def _local_slot_key(ts: datetime) -> str:
    # Convert to local timezone-aware datetime
    local = as_local(ts)
    # floor to 15-minute boundary
    minute = (local.minute // 15) * 15
    return f"{local.hour:02d}:{minute:02d}"


def adjust(raw_points: list[dict[str, Any]], profile: SolarBiasProfile) -> list[dict[str, Any]]:
    """Return a new list of adjusted points using the provided profile.

    - Preserves timestamp strings unchanged.
    - Uses as_local() to compute the local slot.
    - Missing factor defaults to 1.0.
    - Adjusted value is clamped to non-negative values.
    - Does not mutate input list or its dicts.
    - If timestamp is unparseable or value missing, returns a copied point unchanged.
    """
    if not raw_points:
        return []

    adjusted: list[dict[str, Any]] = []
    for point in raw_points:
        # copy to avoid mutating original
        p = dict(point)

        ts_raw = p.get("timestamp")
        value = p.get("value")

        ts = _parse_timestamp(ts_raw)
        if ts is None or value is None:
            adjusted.append(p)
            continue

        try:
            slot = _local_slot_key(ts)
        except Exception:
            # If as_local or slot computation fails, preserve as-is
            adjusted.append(p)
            continue

        factor = profile.factors.get(slot, 1.0)

        try:
            raw_val = float(value)
        except Exception:
            adjusted.append(p)
            continue

        adjusted_value = max(0.0, raw_val * float(factor))

        p["value"] = adjusted_value
        adjusted.append(p)

    return adjusted
