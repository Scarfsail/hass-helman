from __future__ import annotations

import inspect
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .models import BiasConfig, TrainerSample

try:
    from homeassistant.components.recorder.history import get_significant_states
except Exception:  # pragma: no cover - Home Assistant API compatibility
    get_significant_states = None  # type: ignore[assignment]

try:
    from homeassistant.components.recorder.history import state_changes_during_period
except Exception:  # pragma: no cover - Home Assistant API compatibility
    state_changes_during_period = None  # type: ignore[assignment]


async def load_forecast_points_for_day(
    hass: HomeAssistant,
    cfg: BiasConfig,
    target_date: date,
    *,
    local_now: datetime,
) -> list[dict[str, Any]]:
    entity_ids = _read_entity_ids(cfg.daily_energy_entity_ids, limit=None)
    if not entity_ids:
        return []

    local_tz = ZoneInfo(str(hass.config.time_zone))
    today = dt_util.as_local(local_now).date()
    offset = (target_date - today).days
    if offset < 0 or offset >= len(entity_ids):
        return []

    state = hass.states.get(entity_ids[offset])
    if state is None:
        return []

    attributes = getattr(state, "attributes", {})
    wh_period = attributes.get("wh_period") if isinstance(attributes, dict) else None
    if not isinstance(wh_period, dict):
        return []

    parsed_points: list[tuple[datetime, float]] = []
    for raw_key, raw_value in wh_period.items():
        parsed_value = _parse_attribute_wh(raw_value)
        parsed_timestamp = _parse_attribute_timestamp(raw_key, local_tz)
        if parsed_value is None or parsed_timestamp is None:
            continue
        parsed_points.append((parsed_timestamp, parsed_value))

    parsed_points.sort(key=lambda item: dt_util.as_utc(item[0]))
    expected_slots = _build_local_hour_slots_for_date(target_date, local_tz)
    return [
        {"timestamp": slot_start.isoformat(), "value": value}
        for slot_start, (_, value) in zip(expected_slots, parsed_points)
    ]


async def load_historical_per_slot_forecast(
    hass: HomeAssistant,
    cfg: BiasConfig,
    target_date: date,
    *,
    local_now: datetime,
) -> dict[str, float] | None:
    """Return slot_key -> Wh for the forecast as published at the start of target_date.

    Reads the `wh_period` attribute from the recorder history of
    daily_energy_entity_ids[0] (the "today" entity) as captured at start of
    target_date (local midnight). Returns None if no usable state is available.

    Slot keys are HH:MM in the configured local timezone.

    NOTE: requires recorder to retain attribute history >= min_history_days.
    """
    entity_ids = _read_entity_ids(cfg.daily_energy_entity_ids, limit=1)
    if not entity_ids:
        return None

    local_tz = ZoneInfo(str(hass.config.time_zone))
    local_start = datetime.combine(target_date, time.min, tzinfo=local_tz)
    local_end = local_start + timedelta(days=1)

    states_by_entity = await _read_history_for_entities_with_attributes(
        hass,
        entity_ids,
        local_start,
        local_end,
    )

    states = states_by_entity.get(entity_ids[0]) or states_by_entity.get(
        entity_ids[0].lower()
    )
    if not states:
        return None

    state = _select_first_state_for_window(states, after=dt_util.as_utc(local_start))
    if state is None:
        return None

    attributes = getattr(state, "attributes", {})
    if not isinstance(attributes, dict):
        return None
    wh_period = attributes.get("wh_period")
    if not isinstance(wh_period, dict):
        return None

    result: dict[str, float] = {}
    for raw_key, raw_value in wh_period.items():
        wh = _parse_attribute_wh(raw_value)
        ts = _parse_attribute_timestamp(raw_key, local_tz)
        if wh is None or ts is None:
            continue
        local_ts = dt_util.as_local(ts)
        slot_key = f"{local_ts.hour:02d}:{local_ts.minute:02d}"
        result[slot_key] = wh

    return result if result else None


def _select_first_state_for_window(states: list[Any], *, after: datetime) -> Any | None:
    for state in sorted(states, key=_state_sort_key):
        if _state_sort_key(state) < after:
            continue
        return state
    return None


async def _read_history_for_entities_with_attributes(
    hass: HomeAssistant,
    entity_ids: list[str],
    local_start: datetime,
    local_end: datetime,
) -> dict[str, list[Any]]:
    utc_start = dt_util.as_utc(local_start)
    utc_end = dt_util.as_utc(local_end)

    if get_significant_states is None:
        return {}

    try:
        from homeassistant.components.recorder import get_instance

        recorder = get_instance(hass)
        if recorder is not None:
            history = await recorder.async_add_executor_job(
                lambda: get_significant_states(
                    hass,
                    utc_start,
                    utc_end,
                    entity_ids=entity_ids,
                    include_start_time_state=True,
                    minimal_response=False,
                    no_attributes=False,
                    significant_changes_only=False,
                )
            )
        else:
            history = get_significant_states(
                hass,
                utc_start,
                utc_end,
                entity_ids=entity_ids,
                include_start_time_state=True,
                minimal_response=False,
                no_attributes=False,
                significant_changes_only=False,
            )

        if inspect.isawaitable(history):
            history = await history
        if isinstance(history, dict):
            return history
    except (TypeError, AttributeError):
        pass

    return {}


async def load_trainer_samples(
    hass: HomeAssistant, cfg: BiasConfig, now: datetime
) -> list[TrainerSample]:
    entity_ids = _read_entity_ids(cfg.daily_energy_entity_ids)
    if not entity_ids:
        return []

    local_now = dt_util.as_local(now)
    today = local_now.date()
    samples: list[TrainerSample] = []

    for offset in range(90, 0, -1):
        target_date = today - timedelta(days=offset)
        forecast_wh = await _read_day_forecast_wh(
            hass,
            entity_ids,
            target_date,
            local_now=local_now,
        )
        if forecast_wh is None:
            continue

        samples.append(
            TrainerSample(
                date=str(target_date),
                forecast_wh=forecast_wh,
            )
        )

    return samples


async def _read_day_forecast_wh(
    hass: HomeAssistant,
    entity_ids: list[str],
    target_date: date,
    *,
    local_now: datetime,
) -> float | None:
    local_start = datetime.combine(target_date, time.min, tzinfo=local_now.tzinfo)
    local_end = local_start + timedelta(days=1)
    states_by_entity = await _read_history_for_entities(
        hass,
        entity_ids,
        local_start,
        local_end,
    )

    total_wh = 0.0
    for entity_id in entity_ids:
        states = states_by_entity.get(entity_id) or states_by_entity.get(
            entity_id.lower()
        )
        if not states:
            return None

        state_wh = _parse_first_state_wh(states, after=dt_util.as_utc(local_start))
        if state_wh is None:
            return None

        total_wh += state_wh

    return total_wh


async def _read_history_for_entities(
    hass: HomeAssistant,
    entity_ids: list[str],
    local_start: datetime,
    local_end: datetime,
) -> dict[str, list[Any]]:
    utc_start = dt_util.as_utc(local_start)
    utc_end = dt_util.as_utc(local_end)

    if get_significant_states is not None:
        try:
            from homeassistant.components.recorder import get_instance
            
            recorder = get_instance(hass)
            if recorder is not None:
                # Use executor to prevent blocking event loop during DB access
                history = await recorder.async_add_executor_job(
                    lambda: get_significant_states(
                        hass,
                        utc_start,
                        utc_end,
                        entity_ids=entity_ids,
                        include_start_time_state=True,
                        minimal_response=False,
                        no_attributes=True,
                        significant_changes_only=False,
                    )
                )
            else:
                # In tests/early setup when recorder is not available
                history = get_significant_states(
                    hass,
                    utc_start,
                    utc_end,
                    entity_ids=entity_ids,
                    include_start_time_state=True,
                    minimal_response=False,
                    no_attributes=True,
                    significant_changes_only=False,
                )
            
            if inspect.isawaitable(history):
                history = await history
            if isinstance(history, dict):
                return history
        except (TypeError, AttributeError):
            pass

    if state_changes_during_period is None:
        return {}

    history = await _run_recorder_query(
        hass,
        utc_start,
        utc_end,
        entity_ids,
    )
    return history


async def _run_recorder_query(
    hass: HomeAssistant,
    utc_start: datetime,
    utc_end: datetime,
    entity_ids: list[str],
) -> dict[str, list[Any]]:
    if state_changes_during_period is None:
        return {}

    from homeassistant.components.recorder import get_instance

    recorder = get_instance(hass)
    history_by_entity: dict[str, list[Any]] = {}
    for entity_id in entity_ids:
        history = await recorder.async_add_executor_job(
            lambda entity_id=entity_id: state_changes_during_period(
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
        entity_states = history.get(entity_id) or history.get(entity_id.lower()) or []
        history_by_entity[entity_id] = entity_states

    return history_by_entity


def _parse_first_state_wh(states: list[Any], *, after: datetime) -> float | None:
    for state in sorted(states, key=_state_sort_key):
        if _state_sort_key(state) <= after:
            continue
        parsed = _parse_state_wh(getattr(state, "state", None))
        if parsed is not None:
            return parsed
    return None


def _state_sort_key(state: Any) -> datetime:
    timestamp = getattr(state, "last_updated", None) or getattr(
        state, "last_changed", None
    )
    if timestamp is None:
        return datetime.min.replace(tzinfo=timezone.utc)
    return dt_util.as_utc(timestamp)


def _parse_state_wh(raw_value: Any) -> float | None:
    if isinstance(raw_value, bool) or raw_value is None:
        return None

    if isinstance(raw_value, (int, float)):
        return float(raw_value) * 1000.0

    if isinstance(raw_value, str):
        stripped = raw_value.strip()
        if not stripped or stripped.lower() in {"unknown", "unavailable", "none"}:
            return None
        try:
            return float(stripped) * 1000.0
        except ValueError:
            return None

    return None


def _read_entity_ids(raw_value: Any, *, limit: int | None = 1) -> list[str]:
    if not isinstance(raw_value, list):
        return []

    entity_ids: list[str] = []
    for item in raw_value:
        if isinstance(item, str):
            entity_id = item.strip()
            if entity_id:
                entity_ids.append(entity_id)
    if limit is None:
        return entity_ids
    return entity_ids[:limit]


def _parse_attribute_wh(raw_value: Any) -> float | None:
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


def _build_local_hour_slots_for_date(
    target_date: date,
    local_tz: ZoneInfo,
) -> list[datetime]:
    local_start = datetime.combine(target_date, time.min, tzinfo=local_tz)
    local_end = datetime.combine(
        target_date + timedelta(days=1),
        time.min,
        tzinfo=local_tz,
    )

    slots: list[datetime] = []
    cursor_utc = dt_util.as_utc(local_start)
    end_utc = dt_util.as_utc(local_end)
    while cursor_utc < end_utc:
        slots.append(cursor_utc.astimezone(local_tz))
        cursor_utc += timedelta(hours=1)
    return slots


def _parse_attribute_timestamp(raw_key: Any, local_tz: ZoneInfo) -> datetime | None:
    if not isinstance(raw_key, str):
        return None

    try:
        parsed = datetime.fromisoformat(raw_key.replace("Z", "+00:00"))
    except ValueError:
        return None

    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=local_tz)
    return parsed
