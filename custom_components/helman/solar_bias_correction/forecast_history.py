from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .forecast_slot_history import (
    load_forecast_slots_for_day,
    load_forecast_slots_for_window,
)
from .models import BiasConfig, TrainerSample


async def load_archived_forecast_points(
    hass: HomeAssistant,
    target_date: date,
    timezone: ZoneInfo,
) -> list[dict[str, Any]]:
    """The recorded forecast curve for a day, at each slot's own horizon.

    Today and every earlier day come from here: this is what the fit was
    computed from, and drawing the source entity's present-day revision instead
    would show a curve the trainer never saw -- for today it would redraw a
    slot that has already elapsed against a forecast issued after it ran.

    The whole day is returned, today's not-yet-started slots included; the
    caller decides how much of it to take. The days ahead are not served from
    here -- the canonical snapshot already carries them.
    """
    slots = await load_forecast_slots_for_day(hass, target_date)
    return _points_from_slot_map(slots, target_date, timezone)


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


async def load_trainer_samples(
    hass: HomeAssistant, cfg: BiasConfig, now: datetime
) -> list[TrainerSample]:
    """The training window's days, as Home Assistant recorded them.

    Every slot comes from the last forecast published before that slot began,
    so no slot is scored against a later revision of itself and none is scored
    at a different horizon from its neighbours. A slot the recorder never saw --
    Home Assistant was down, or started mid-day -- is simply absent, which the
    trainer already treats as "no forecast for this slot".

    The whole window is one recorder read rather than one per day, and the day
    total is the sum of that day's slots rather than a second read of the
    source entity, so both sides of the day-ratio gate describe the same
    measurement.

    How far back this reaches is ``purge_keep_days``, not a Helman constant.
    Days beyond it are absent until #173 teaches the trainer to splice the
    statistics tail; the training page reports both depths so the limit is
    visible rather than inferred.
    """
    local_now = dt_util.as_local(now)
    today = local_now.date()
    days = await load_forecast_slots_for_window(
        hass,
        first_date=today - timedelta(days=cfg.max_training_window_days),
        last_date=today - timedelta(days=1),
    )

    samples: list[TrainerSample] = []
    for offset in range(cfg.max_training_window_days, 0, -1):
        target_date = today - timedelta(days=offset)
        slot_forecast_wh = days.get(target_date.isoformat())
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
