from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant

from ..recorder_states import numeric_timeline, read_states
from ..slot_grid import SLOT_MINUTES, day_slots
from .forecast_slot_sampling import resolve_forecast_slot_values

#: The five entities Helman now publishes in place of ``BatteryForecastHistoryStore``.
#:
#: The battery forecast snapshot only ever spans from the current slot forward,
#: and nothing else records these series, so once a slot has elapsed there was
#: no record of what was predicted for it. Each entity is written on the
#: slot-aligned refresh and carries ``force_update``, so its recorder history is
#: that record -- the same move ``sensor.helman_solar_forecast_current`` makes,
#: and the reason the four Wh entities carry no device class is set out on
#: :class:`~..sensor._HelmanBatteryForecastCurrentSensorBase`.
#:
#: ``force_update`` is what makes "is that record" literal rather than nearly
#: true. Home Assistant writes no state row for an unchanged value, so without
#: it a series sitting flat -- the grid net forecast at ``0.0`` through an
#: evening with no expected flow -- leaves no row for any slot in the stretch,
#: and every one of those slots would have to be reconstructed by
#: :func:`~.forecast_slot_sampling.resolve_forecast_slot_values` from a held
#: value that any dropout clears.
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
    sensor, batched into a single recorder read because these
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

    day_start_local = datetime.combine(target_date, time(0, 0), tzinfo=timezone)
    day_end_local = day_start_local + timedelta(days=1)
    entity_ids = [BATTERY_SOC_FORECAST_CURRENT_ENTITY, *_WH_ENTITIES]

    states_by_entity = await read_states(
        hass,
        entity_ids,
        day_start_local,
        day_end_local,
        include_start_state=True,
        no_attributes=True,
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
    late, and for why non-numeric rows are kept here as hold-breakers.
    """
    timeline = numeric_timeline(states, keep_non_numeric=True)
    if not timeline:
        return {}

    slot_starts = day_slots(day_start_local.date(), tzinfo=day_start_local.tzinfo, wall_clock=True)

    return resolve_forecast_slot_values(
        timeline, slot_starts, slot_minutes=SLOT_MINUTES
    )
