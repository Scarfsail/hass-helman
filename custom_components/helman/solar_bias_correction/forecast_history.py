from __future__ import annotations

import inspect
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from ..solar_forecast_grid import SUB_SLOT_OFFSETS_MIN, split_hour_by_weights
from .models import BiasConfig, TrainerSample

try:
    from homeassistant.components.recorder.history import get_significant_states
except Exception:  # pragma: no cover - Home Assistant API compatibility
    get_significant_states = None  # type: ignore[assignment]

try:
    from homeassistant.components.recorder.history import state_changes_during_period
except Exception:  # pragma: no cover - Home Assistant API compatibility
    state_changes_during_period = None  # type: ignore[assignment]


def _expand_hourly_to_15min(
    hourly_wh: dict[str, float],
    watts: dict[str, float],
) -> dict[str, float]:
    """Split hourly Wh into 15-minute slots using upstream watts weighting.

    An hour without a full set of watts samples is dropped rather than split
    evenly. This is deliberately stricter than the forecast builder, which
    even-splits the same input: the builder must not lose energy from the plan,
    whereas the trainer must not learn a bias factor from a shape it guessed.
    A dropped hour simply leaves that slot without a forecast, which the trainer
    already skips.
    """
    result: dict[str, float] = {}
    for hour_key, hour_wh in hourly_wh.items():
        hour_text, _, minute_text = hour_key.partition(":")
        try:
            hour = int(hour_text)
            minute = int(minute_text)
        except ValueError:
            continue
        if minute != 0:
            continue

        sub_keys = [f"{hour:02d}:{offset:02d}" for offset in SUB_SLOT_OFFSETS_MIN]
        if not all(key in watts for key in sub_keys):
            continue

        sub_watts = [float(watts[key]) for key in sub_keys]
        for key, value in zip(sub_keys, split_hour_by_weights(hour_wh, sub_watts)):
            result[key] = value

    return result


def _normalize_slot_key(raw_key: Any, local_tz: ZoneInfo) -> str | None:
    """Return ``raw_key`` as a local ``HH:MM`` slot key.

    Accepts a full ISO timestamp, which is what the source integration
    publishes, or an already-normalised ``HH:MM`` key. The expansion this feeds
    used to index ``watts`` by its raw keys, so the bare form has to keep
    working.
    """
    timestamp = _parse_attribute_timestamp(raw_key, local_tz)
    if timestamp is not None:
        local_ts = dt_util.as_local(timestamp)
        return f"{local_ts.hour:02d}:{local_ts.minute:02d}"

    if not isinstance(raw_key, str):
        return None

    hour_text, separator, minute_text = raw_key.partition(":")
    if not separator:
        return None
    try:
        hour = int(hour_text)
        minute = int(minute_text)
    except ValueError:
        return None
    if not (0 <= hour < 24 and 0 <= minute < 60):
        return None

    return f"{hour:02d}:{minute:02d}"


def _read_slot_map(
    attributes: dict[str, Any],
    attribute_name: str,
    local_tz: ZoneInfo,
) -> dict[str, float]:
    """Parse a ``{timestamp: value}`` attribute into a ``HH:MM`` -> value map."""
    raw_series = attributes.get(attribute_name)
    if not isinstance(raw_series, dict):
        return {}

    result: dict[str, float] = {}
    for raw_key, raw_value in raw_series.items():
        value = _parse_attribute_wh(raw_value)
        slot_key = _normalize_slot_key(raw_key, local_tz)
        if value is None or slot_key is None:
            continue
        result[slot_key] = value

    return result


def _read_per_slot_forecast(
    attributes: dict[str, Any],
    local_tz: ZoneInfo,
) -> dict[str, float]:
    """Return the day's ``HH:MM`` -> Wh map on the canonical 15-minute grid.

    Prefers the source's own 15-minute series, which the upstream integration
    started publishing on 2026-08-19. Older recorded states carry only the
    hourly series, so those still go through the watts-weighted expansion.

    The 15-minute series is only taken when it covers every hour the hourly
    series does. ``wh_period`` is structurally a full day; the newer attribute
    carries no such guarantee, and a partial one would otherwise become the
    whole day's forecast. The trainer stretches its last slot to midnight
    (``trainer._aggregate_actuals_into_forecast_slot``), so a short map would
    weigh a full day of actuals against a sliver of forecast and poison the
    slot factor.
    """
    quarter_hourly = _read_slot_map(attributes, "wh_period_15m", local_tz)
    hourly = _read_slot_map(attributes, "wh_period", local_tz)

    if quarter_hourly and _covers_every_hour(quarter_hourly, hourly):
        return quarter_hourly

    if not hourly:
        return {}

    return _expand_hourly_to_15min(
        hourly,
        _read_slot_map(attributes, "watts", local_tz),
    )


def _covers_every_hour(
    quarter_hourly: dict[str, float],
    hourly: dict[str, float],
) -> bool:
    """Whether ``quarter_hourly`` has every sub-slot of every hour in ``hourly``.

    With no hourly series to check against there is nothing better to fall back
    to, so the 15-minute map is taken as-is.
    """
    if not hourly:
        return True

    for hour_key in hourly:
        hour_text, _, minute_text = hour_key.partition(":")
        try:
            hour = int(hour_text)
            minute = int(minute_text)
        except ValueError:
            continue
        if minute != 0:
            continue
        for offset in SUB_SLOT_OFFSETS_MIN:
            if f"{hour:02d}:{offset:02d}" not in quarter_hourly:
                return False

    return True


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

    if offset < 0:
        state = await _read_historical_forecast_state(hass, cfg, target_date, local_tz)
        if state is None:
            return []
    elif offset >= len(entity_ids):
        return []
    else:
        state = hass.states.get(entity_ids[offset])
        if state is None:
            return []

    attributes = getattr(state, "attributes", {})
    if not isinstance(attributes, dict):
        return []
    sub_slot_wh = _read_per_slot_forecast(attributes, local_tz)
    if not sub_slot_wh:
        # Fallback: split each hour evenly when upstream watts is unavailable.
        for hour_key, hour_wh in _read_slot_map(
            attributes, "wh_period", local_tz
        ).items():
            hour_text, _, minute_text = hour_key.partition(":")
            try:
                hour = int(hour_text)
                minute = int(minute_text)
            except ValueError:
                continue
            if minute != 0:
                continue
            share = hour_wh / len(SUB_SLOT_OFFSETS_MIN)
            for offset in SUB_SLOT_OFFSETS_MIN:
                sub_slot_wh[f"{hour:02d}:{offset:02d}"] = share

    points: list[tuple[datetime, dict[str, Any]]] = []
    for slot_key, value in sub_slot_wh.items():
        try:
            hour_text, minute_text = slot_key.split(":", 1)
            hour = int(hour_text)
            minute = int(minute_text)
        except (ValueError, AttributeError):
            continue
        slot_start = datetime.combine(
            target_date,
            time(hour=hour, minute=minute),
            tzinfo=local_tz,
        )
        points.append(
            (slot_start, {"timestamp": slot_start.isoformat(), "value": float(value)})
        )
    points.sort(key=lambda item: item[0])
    return [point for _, point in points]


async def _read_historical_forecast_state(
    hass: HomeAssistant,
    cfg: BiasConfig,
    target_date: date,
    local_tz: ZoneInfo,
) -> Any:
    entity_ids = _read_entity_ids(cfg.daily_energy_entity_ids, limit=1)
    if not entity_ids:
        return None

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

    return _select_first_state_for_window(states, after=dt_util.as_utc(local_start))


async def load_historical_per_slot_forecast(
    hass: HomeAssistant,
    cfg: BiasConfig,
    target_date: date,
    *,
    local_now: datetime,
) -> dict[str, float] | None:
    """Return slot_key -> Wh for the forecast as published at the start of target_date.

    Reads the `wh_period_15m` attribute -- or `wh_period` plus `watts` on states
    recorded before the source integration published it -- from the recorder
    history of daily_energy_entity_ids[0] (the "today" entity) as captured at
    start of target_date (local midnight). Returns None if no usable state is
    available.

    Slot keys are HH:MM in the configured local timezone.

    NOTE: requires recorder to retain attribute history >= min_history_days.
    """
    local_tz = ZoneInfo(str(hass.config.time_zone))
    state = await _read_historical_forecast_state(hass, cfg, target_date, local_tz)
    if state is None:
        return None
    attributes = getattr(state, "attributes", {})
    if not isinstance(attributes, dict):
        return None

    result = _read_per_slot_forecast(attributes, local_tz)
    return result if result else None


def _select_first_state_for_window(states: list[Any], *, after: datetime) -> Any | None:
    boundary: Any | None = None
    for state in sorted(states, key=_state_sort_key):
        key = _state_sort_key(state)
        if key <= after:
            boundary = state
            continue
        return boundary if boundary is not None else state
    return boundary


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

    for offset in range(cfg.max_training_window_days, 0, -1):
        target_date = today - timedelta(days=offset)
        forecast_wh = await _read_day_forecast_wh(
            hass,
            entity_ids,
            target_date,
            local_now=local_now,
        )
        if forecast_wh is None:
            continue

        slot_forecast_wh = await load_historical_per_slot_forecast(
            hass,
            cfg,
            target_date,
            local_now=local_now,
        )
        if not slot_forecast_wh:
            # Recorder retention exhausted or attribute missing — cannot train this day.
            continue

        samples.append(
            TrainerSample(
                date=str(target_date),
                forecast_wh=forecast_wh,
                slot_forecast_wh=slot_forecast_wh,
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
