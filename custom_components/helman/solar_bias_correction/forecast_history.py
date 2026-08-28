from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from ..solar_forecast_grid import SUB_SLOT_OFFSETS_MIN, split_hour_by_weights
from .models import BiasConfig, TrainerSample

if TYPE_CHECKING:
    from ..solar_forecast_history import SolarForecastHistoryStore


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
    whole day's forecast -- a curve the inspector would draw as if the rest of
    the day had been predicted at zero.
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
    store: SolarForecastHistoryStore | None = None,
) -> list[dict[str, Any]]:
    """The forecast curve for one day, as the inspector should draw it.

    A past day comes from the archive, because that is what the fit was
    computed from: drawing the source entity's present-day revision instead
    would show a curve the trainer never saw. Today and the days ahead still
    come from the live entities, which are the only place they exist.
    """
    local_tz = ZoneInfo(str(hass.config.time_zone))
    today = dt_util.as_local(local_now).date()
    offset = (target_date - today).days

    if offset < 0:
        # Deliberately ahead of the entity check: the archive owes the entity
        # list nothing, so renaming or clearing it must not blank the days
        # already recorded under the old name.
        if store is None:
            return []
        return _points_from_slot_map(store.slots_for_day(target_date), target_date, local_tz)

    entity_ids = _read_entity_ids(cfg.daily_energy_entity_ids, limit=None)
    if offset >= len(entity_ids):
        return []
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
            for sub_offset in SUB_SLOT_OFFSETS_MIN:
                sub_slot_wh[f"{hour:02d}:{sub_offset:02d}"] = share

    return _points_from_slot_map(sub_slot_wh, target_date, local_tz)


def _points_from_slot_map(
    sub_slot_wh: dict[str, float],
    target_date: date,
    local_tz: ZoneInfo,
) -> list[dict[str, Any]]:
    """An ``HH:MM`` -> Wh map as timestamped points, in chronological order."""
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


def load_trainer_samples(
    store: SolarForecastHistoryStore | None, cfg: BiasConfig, now: datetime
) -> list[TrainerSample]:
    """The training window's days, as archived while each day ran.

    Every slot comes from the last forecast published before that slot began,
    so no slot is scored against a later revision of itself and none is scored
    at a different horizon from its neighbours. A slot the archive never saw --
    Home Assistant was down, or started mid-day -- is simply absent, which the
    trainer already treats as "no forecast for this slot"; there is no recorder
    fallback, because a day half-measured at fifteen minutes and half at eleven
    hours is the very inconsistency this archive exists to remove.

    The day total is the sum of the archived slots rather than a second read of
    the source entity, so both sides of the day-ratio gate describe the same
    measurement.
    """
    if store is None:
        return []

    local_now = dt_util.as_local(now)
    today = local_now.date()
    samples: list[TrainerSample] = []

    for offset in range(cfg.max_training_window_days, 0, -1):
        target_date = today - timedelta(days=offset)
        slot_forecast_wh = store.slots_for_day(target_date)
        if not slot_forecast_wh:
            continue

        samples.append(
            TrainerSample(
                date=str(target_date),
                forecast_wh=sum(slot_forecast_wh.values()),
                slot_forecast_wh=slot_forecast_wh,
            )
        )

    return samples


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
