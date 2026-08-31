from __future__ import annotations

from datetime import date, datetime, time, timedelta
from functools import partial
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

try:
    from homeassistant.components.recorder import get_instance
    from homeassistant.components.recorder.history import get_significant_states
except Exception:  # pragma: no cover - Home Assistant API compatibility
    get_instance = None  # type: ignore[assignment]
    get_significant_states = None  # type: ignore[assignment]

#: The five entities Helman now publishes in place of ``BatteryForecastHistoryStore``.
#:
#: The battery forecast snapshot only ever spans from the current slot forward,
#: and nothing else records these series, so once a slot has elapsed there was
#: no record of what was predicted for it. Each entity is written on the
#: slot-aligned refresh, so its recorder history is that record -- the same move
#: ``sensor.helman_solar_forecast_current`` makes, and the reason the four Wh
#: entities carry no device class is set out on
#: :class:`~..sensor._HelmanBatteryForecastCurrentSensorBase`.
BATTERY_FORECAST_SOC_CURRENT_ENTITY = "sensor.helman_battery_forecast_soc_current"
BATTERY_FORECAST_GRID_NET_CURRENT_ENTITY = (
    "sensor.helman_battery_forecast_grid_net_current"
)
BATTERY_FORECAST_GRID_IMPORT_CURRENT_ENTITY = (
    "sensor.helman_battery_forecast_grid_import_current"
)
BATTERY_FORECAST_GRID_EXPORT_CURRENT_ENTITY = (
    "sensor.helman_battery_forecast_grid_export_current"
)
BATTERY_FORECAST_BATTERY_NET_CURRENT_ENTITY = (
    "sensor.helman_battery_forecast_battery_net_current"
)

#: The Wh entities in the order this module returns their point lists.
_WH_ENTITIES = (
    BATTERY_FORECAST_GRID_NET_CURRENT_ENTITY,
    BATTERY_FORECAST_BATTERY_NET_CURRENT_ENTITY,
    BATTERY_FORECAST_GRID_IMPORT_CURRENT_ENTITY,
    BATTERY_FORECAST_GRID_EXPORT_CURRENT_ENTITY,
)

_SLOT_MINUTES = 15
_SLOTS_PER_DAY = 24 * 60 // _SLOT_MINUTES  # 96

_BatteryForecastPoints = tuple[
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[dict[str, Any]],
]


async def load_battery_forecast_points_for_day(
    hass: HomeAssistant,
    target_date: date,
    timezone: ZoneInfo,
) -> _BatteryForecastPoints:
    """The recorded battery forecast curves for a day, at each slot's own horizon.

    Reads the recorder history of the five battery-forecast entities and holds
    each value forward across the slot it covers -- the same hold-forward the
    house forecast's :func:`load_house_forecast_points_for_day` does for its one
    sensor, batched into a single ``get_significant_states`` read because these
    five ride one another's beat. The four Wh entities publish a slot's own Wh,
    so unlike the house forecast (which publishes power) there is nothing to
    scale.

    Returns ``(soc, grid_net, battery_net, grid_import, grid_export)`` for the
    whole day; the caller trims to the slot in progress. ``soc`` is
    ``[{"slot": "HH:MM", "pct": float}]`` and the rest are
    ``[{"timestamp": iso_local, "wh": float}]`` -- the shapes the retired
    :meth:`SolarBiasCorrectionService._recorded_battery_forecast_points`
    produced, unchanged so nothing downstream can tell the store is gone. Every
    list is empty when the recorder has no states for the day.
    """
    empty: _BatteryForecastPoints = ([], [], [], [], [])
    if get_significant_states is None or get_instance is None:
        return empty

    day_start_local = datetime.combine(target_date, time(0, 0), tzinfo=timezone)
    day_end_local = day_start_local + timedelta(days=1)
    entity_ids = [BATTERY_FORECAST_SOC_CURRENT_ENTITY, *_WH_ENTITIES]

    states_by_entity = await get_instance(hass).async_add_executor_job(
        partial(
            get_significant_states,
            hass,
            dt_util.as_utc(day_start_local),
            dt_util.as_utc(day_end_local),
            entity_ids,
            significant_changes_only=False,
        )
    )
    if not states_by_entity:
        return empty

    soc_points = [
        {"slot": slot_start.strftime("%H:%M"), "pct": value}
        for slot_start, value in _hold_forward(
            states_by_entity.get(BATTERY_FORECAST_SOC_CURRENT_ENTITY), day_start_local
        ).items()
    ]

    wh_point_lists = [
        [
            {"timestamp": slot_start.isoformat(), "wh": value}
            for slot_start, value in _hold_forward(
                states_by_entity.get(entity_id), day_start_local
            ).items()
        ]
        for entity_id in _WH_ENTITIES
    ]
    return (soc_points, *wh_point_lists)


def _hold_forward(
    states: list[Any] | None, day_start_local: datetime
) -> dict[datetime, float]:
    """Sample one entity's states onto the day's slots, last value at-or-before wins.

    Keyed by the slot's local ``datetime``; the SoC caller renders that as
    ``"HH:MM"`` and the Wh callers as an ISO timestamp. A slot before the
    entity's first reading is absent rather than zero, exactly as
    :func:`load_house_forecast_points_for_day` leaves it.
    """
    timeline: list[tuple[datetime, float]] = []
    for state in states or []:
        raw = getattr(state, "state", None)
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        when = getattr(state, "last_changed", None) or getattr(
            state, "last_updated", None
        )
        if when is None:
            continue
        timeline.append((dt_util.as_local(when), value))
    if not timeline:
        return {}
    timeline.sort(key=lambda pair: pair[0])

    sampled: dict[datetime, float] = {}
    cursor = 0
    current: float | None = None
    for slot_index in range(_SLOTS_PER_DAY):
        slot_start = day_start_local + timedelta(minutes=slot_index * _SLOT_MINUTES)
        while cursor < len(timeline) and timeline[cursor][0] <= slot_start:
            current = timeline[cursor][1]
            cursor += 1
        if current is None:
            continue
        sampled[slot_start] = current
    return sampled
