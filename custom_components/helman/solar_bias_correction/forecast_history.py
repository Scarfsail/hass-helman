from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from homeassistant.util import dt as dt_util

from .models import BiasConfig, TrainerSample

if TYPE_CHECKING:
    from ..solar_forecast_history import SolarForecastHistoryStore


def load_archived_forecast_points(
    store: SolarForecastHistoryStore | None,
    target_date: date,
    timezone: ZoneInfo,
) -> list[dict[str, Any]]:
    """The archived forecast curve for a day, at each slot's own horizon.

    Today and every earlier day come from here: this is what the fit was
    computed from, and drawing the source entity's present-day revision instead
    would show a curve the trainer never saw -- for today it would redraw a
    slot that has already elapsed against a forecast issued after it ran.

    The whole day is returned, today's not-yet-started slots included; the
    caller decides how much of it to take. The days ahead have no archive and
    are not served from here -- the canonical snapshot already carries them.
    """
    if store is None:
        return []
    return _points_from_slot_map(store.slots_for_day(target_date), target_date, timezone)


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
