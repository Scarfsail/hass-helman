"""Shared tolerant readers for configuration and recorded values."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.util import dt as dt_util


def read_mapping(raw_value: Any) -> dict[str, Any]:
    if isinstance(raw_value, dict):
        return raw_value
    return {}


def read_entity_id(raw_value: Any) -> str | None:
    if isinstance(raw_value, str) and raw_value.strip():
        return raw_value.strip()
    return None


def read_float(raw_value: Any) -> float | None:
    if isinstance(raw_value, bool) or raw_value is None:
        return None

    if isinstance(raw_value, (int, float)):
        return float(raw_value)

    if isinstance(raw_value, str):
        stripped = raw_value.strip()
        if not stripped or stripped.lower() in {"unknown", "unavailable", "none"}:
            return None

        try:
            return float(stripped)
        except ValueError:
            return None

    return None


def parse_timestamp(raw_value: Any) -> datetime | None:
    if not isinstance(raw_value, str):
        return None
    return dt_util.parse_datetime(raw_value)
