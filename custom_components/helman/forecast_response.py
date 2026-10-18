"""Shared response envelope and slicing helpers across forecast responses."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime
from typing import Any

from homeassistant.util import dt as dt_util

from .const import FORECAST_CANONICAL_GRANULARITY_MINUTES


def envelope(
    snapshot: dict[str, Any],
    *,
    drop: set[str] | frozenset[str] = frozenset(),
) -> dict[str, Any]:
    """Copy top-level fields minus private or replaced fields."""
    return {
        key: deepcopy(value)
        for key, value in snapshot.items()
        if key not in drop
    }


def parse_ts(raw_value: Any) -> datetime | None:
    """Tolerantly parse an ISO timestamp string using Home Assistant's dt util."""
    if not isinstance(raw_value, str):
        return None
    return dt_util.parse_datetime(raw_value)


def target_count(forecast_days: int) -> int:
    """Number of canonical slots spanning the given forecast horizon in days."""
    return forecast_days * 24 * 60 // FORECAST_CANONICAL_GRANULARITY_MINUTES


def slice_to_horizon(entries: list[Any], *, forecast_days: int) -> list[Any]:
    """Clip a canonical sequence to the forecast horizon."""
    count = target_count(forecast_days)
    if count <= 0:
        return []
    return entries[:count]


def read_entries(raw_value: Any) -> list[dict[str, Any]]:
    """Tolerantly read a list of entry dictionaries with deep-copied entries."""
    if not isinstance(raw_value, list):
        return []
    return [deepcopy(entry) for entry in raw_value if isinstance(entry, dict)]
