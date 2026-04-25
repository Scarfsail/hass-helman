from __future__ import annotations

import inspect
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

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


def _read_entity_ids(raw_value: Any) -> list[str]:
    if not isinstance(raw_value, list):
        return []

    entity_ids: list[str] = []
    for item in raw_value:
        if isinstance(item, str):
            entity_id = item.strip()
            if entity_id:
                entity_ids.append(entity_id)
    return entity_ids[:1]
