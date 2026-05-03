from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from ..solar_forecast_source import async_load_upstream_solar_forecast, slice_wh_hours_by_local_date
from .models import BiasConfig, TrainerSample


async def load_forecast_points_for_day(
    hass: HomeAssistant,
    cfg: BiasConfig,
    target_date: date,
    *,
    local_now: datetime,
) -> list[dict[str, Any]]:
    upstream = await async_load_upstream_solar_forecast(hass, cfg.source_config_entry_id)
    if upstream is None:
        return []
    local_tz = ZoneInfo(str(hass.config.time_zone))
    return slice_wh_hours_by_local_date(
        upstream.get("wh_hours"),
        local_tz=local_tz,
        target_date=target_date,
    )


async def load_trainer_samples(
    hass: HomeAssistant, cfg: BiasConfig, now: datetime
) -> list[TrainerSample]:
    upstream = await async_load_upstream_solar_forecast(hass, cfg.source_config_entry_id)
    if upstream is None:
        return []

    wh_hours = upstream.get("wh_hours") or {}
    local_tz = ZoneInfo(str(hass.config.time_zone))
    local_now = dt_util.as_local(now)
    today = local_now.date()
    samples: list[TrainerSample] = []

    for offset in range(cfg.max_training_window_days, 0, -1):
        target_date = today - timedelta(days=offset)
        day_points = slice_wh_hours_by_local_date(
            wh_hours,
            local_tz=local_tz,
            target_date=target_date,
        )
        if not day_points:
            continue

        forecast_wh = sum(float(p.get("value", 0)) for p in day_points)
        slot_forecast_wh = _points_to_slot_map(day_points, local_tz)

        samples.append(
            TrainerSample(
                date=str(target_date),
                forecast_wh=forecast_wh,
                slot_forecast_wh=slot_forecast_wh,
            )
        )

    return samples


def _points_to_slot_map(
    points: list[dict[str, Any]],
    local_tz: ZoneInfo,
) -> dict[str, float]:
    result: dict[str, float] = {}
    for point in points:
        raw_ts = point.get("timestamp")
        if not isinstance(raw_ts, str):
            continue
        try:
            ts = datetime.fromisoformat(raw_ts)
        except ValueError:
            continue
        local_ts = ts.astimezone(local_tz)
        key = f"{local_ts.hour:02d}:{local_ts.minute:02d}"
        result[key] = float(point.get("value", 0))
    return result
