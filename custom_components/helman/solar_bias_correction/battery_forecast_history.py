from __future__ import annotations

from datetime import date, datetime, time, timedelta
from functools import partial
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .forecast_slot_sampling import resolve_forecast_slot_values

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
#:
#: The ids name the quantity, not this subsystem: three of the five are grid
#: flows that only fall out of the battery simulation, and a user reading a
#: history card has no way to interpret a ``battery_forecast_`` prefix on them.
#: The module keeps its source-describing name because module names are not a
#: public contract; entity ids are.
BATTERY_SOC_FORECAST_CURRENT_ENTITY = "sensor.helman_battery_soc_forecast_current"
BATTERY_NET_FORECAST_CURRENT_ENTITY = "sensor.helman_battery_net_forecast_current"
GRID_NET_FORECAST_CURRENT_ENTITY = "sensor.helman_grid_net_forecast_current"
GRID_IMPORT_FORECAST_CURRENT_ENTITY = "sensor.helman_grid_import_forecast_current"
GRID_EXPORT_FORECAST_CURRENT_ENTITY = "sensor.helman_grid_export_forecast_current"

#: The Wh entities in the order this module returns their point lists.
_WH_ENTITIES = (
    GRID_NET_FORECAST_CURRENT_ENTITY,
    BATTERY_NET_FORECAST_CURRENT_ENTITY,
    GRID_IMPORT_FORECAST_CURRENT_ENTITY,
    GRID_EXPORT_FORECAST_CURRENT_ENTITY,
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
    entity_ids = [BATTERY_SOC_FORECAST_CURRENT_ENTITY, *_WH_ENTITIES]

    states_by_entity = await get_instance(hass).async_add_executor_job(
        partial(
            get_significant_states,
            hass,
            dt_util.as_utc(day_start_local),
            dt_util.as_utc(day_end_local),
            entity_ids,
            significant_changes_only=False,
            # Only the state and its timestamp are read; these five entities
            # carry no attributes worth materialising across a day of rows --
            # the same flag ``forecast_slot_history._load_timeline`` passes.
            no_attributes=True,
        )
    )
    if not states_by_entity:
        return empty

    soc_points = [
        {"slot": slot_start.strftime("%H:%M"), "pct": value}
        for slot_start, value in _hold_forward(
            states_by_entity.get(BATTERY_SOC_FORECAST_CURRENT_ENTITY), day_start_local
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
    """Sample one entity's states onto the day's slots.

    Keyed by the slot's local ``datetime``; the SoC caller renders that as
    ``"HH:MM"`` and the Wh callers as an ISO timestamp. A slot before the
    entity's first reading is absent rather than zero, exactly as
    :func:`load_house_forecast_points_for_day` leaves it.

    The slot-resolution rule -- first row *inside* the slot, not the last one
    at-or-before its start -- is :func:`resolve_forecast_slot_values`; see its
    docstring for why a ``<= slot_start`` sweep drew the whole curve one slot
    late. Non-numeric rows are dropped here rather than kept as hold-breakers,
    which is today's behaviour for the house reader too.
    """
    timeline: list[tuple[datetime, float | None]] = []
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

    slot_starts = [
        day_start_local + timedelta(minutes=slot_index * _SLOT_MINUTES)
        for slot_index in range(_SLOTS_PER_DAY)
    ]
    return resolve_forecast_slot_values(
        timeline, slot_starts, slot_minutes=_SLOT_MINUTES
    )
