from __future__ import annotations

import inspect
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .models import BiasConfig, SolarActualsWindow
from ..recorder_hourly_series import get_local_current_slot_start

try:
    from homeassistant.components.recorder.history import get_significant_states
except Exception:  # pragma: no cover - Home Assistant API compatibility
    get_significant_states = None  # type: ignore[assignment]

try:
    from homeassistant.components.recorder.history import state_changes_during_period
except Exception:  # pragma: no cover - Home Assistant API compatibility
    state_changes_during_period = None  # type: ignore[assignment]


async def load_actuals_window(
    hass: HomeAssistant, cfg: BiasConfig, days: int
) -> SolarActualsWindow:
    entity_id = _read_entity_id(cfg.total_energy_entity_id)
    if entity_id is None or days <= 0:
        return SolarActualsWindow(slot_actuals_by_date={})

    local_now = dt_util.as_local(datetime.now(timezone.utc))
    slot_actuals_by_date: dict[str, dict[str, float]] = {}

    for offset in range(days, 0, -1):
        target_date = local_now.date() - timedelta(days=offset)
        slot_actuals_by_date[str(target_date)] = await _read_day_slot_actuals(
            hass,
            entity_id,
            target_date,
            local_now=local_now,
        )

    return SolarActualsWindow(slot_actuals_by_date=slot_actuals_by_date)


async def _read_day_slot_actuals(
    hass: HomeAssistant,
    entity_id: str,
    target_date: date,
    *,
    local_now: datetime,
) -> dict[str, float]:
    local_start = datetime.combine(target_date, time.min, tzinfo=local_now.tzinfo)
    local_end = local_start + timedelta(days=1)
    states = await _read_history_for_entity(hass, entity_id, local_start, local_end)
    if not states:
        return {}

    readings: list[tuple[datetime, float]] = []
    for state in sorted(states, key=_state_sort_key):
        timestamp = _state_timestamp(state)
        value_kwh = _parse_cumulative_kwh(getattr(state, "state", None))
        if timestamp is None or value_kwh is None:
            continue
        readings.append((dt_util.as_utc(timestamp), value_kwh))

    if len(readings) < 2:
        return {}

    slot_actuals: dict[str, float] = {}
    previous_value = readings[0][1]
    for timestamp, value_kwh in readings[1:]:
        delta_wh = max(0.0, (value_kwh - previous_value) * 1000.0)
        slot_start = get_local_current_slot_start(
            dt_util.as_local(timestamp),
            interval_minutes=15,
        )
        slot_key = slot_start.strftime("%H:%M")
        slot_actuals[slot_key] = slot_actuals.get(slot_key, 0.0) + delta_wh
        previous_value = value_kwh

    return slot_actuals


async def _read_history_for_entity(
    hass: HomeAssistant,
    entity_id: str,
    local_start: datetime,
    local_end: datetime,
) -> list[Any]:
    utc_start = dt_util.as_utc(local_start)
    utc_end = dt_util.as_utc(local_end)

    if get_significant_states is not None:
        try:
            history = get_significant_states(
                hass,
                utc_start,
                utc_end,
                entity_ids=[entity_id],
                include_start_time_state=True,
                minimal_response=False,
                no_attributes=True,
                significant_changes_only=False,
            )
            if inspect.isawaitable(history):
                history = await history
            if isinstance(history, dict):
                return history.get(entity_id) or history.get(entity_id.lower()) or []
        except TypeError:
            pass

    if state_changes_during_period is None:
        return []

    from homeassistant.components.recorder import get_instance

    recorder = get_instance(hass)
    history = await recorder.async_add_executor_job(
        lambda: state_changes_during_period(
            hass,
            utc_start,
            utc_end,
            entity_id,
            False,
            False,
            None,
            True,
        )
    )
    return history.get(entity_id) or history.get(entity_id.lower()) or []


def _state_sort_key(state: Any) -> datetime:
    timestamp = _state_timestamp(state)
    if timestamp is None:
        return datetime.min.replace(tzinfo=timezone.utc)
    return dt_util.as_utc(timestamp)


def _state_timestamp(state: Any) -> datetime | None:
    return getattr(state, "last_updated", None) or getattr(state, "last_changed", None)


def _parse_cumulative_kwh(raw_value: Any) -> float | None:
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


def _read_entity_id(raw_value: Any) -> str | None:
    if isinstance(raw_value, str):
        entity_id = raw_value.strip()
        if entity_id:
            return entity_id
    return None
