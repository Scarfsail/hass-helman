from __future__ import annotations

import logging
from datetime import datetime
from math import isfinite
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .config_read import read_entity_id, read_float, read_mapping
from .const import FORECAST_CANONICAL_GRANULARITY_MINUTES, MAX_FORECAST_DAYS
from .grid_import_price import (
    FixedGridImportPriceConfig,
    FixedGridImportPriceWindow,
    GridImportPriceConfigError,
    lookup_grid_import_price,
    read_grid_import_price_config,
    _format_minute_of_day,
    _parse_window_time,
)
from .slot_grid import advance, expand_points_to_grid, floor_to_slot, slot_starts

_LOGGER = logging.getLogger(__name__)


class GridPriceForecastBuilder:
    _parse_window_time = staticmethod(_parse_window_time)
    _format_minute_of_day = staticmethod(_format_minute_of_day)

    def __init__(self, hass: HomeAssistant, config: dict[str, Any]) -> None:
        self._hass = hass
        self._config = config
        tz_name = getattr(getattr(hass, "config", None), "time_zone", None) or "UTC"
        self._local_tz = ZoneInfo(str(tz_name))

    def build(
        self,
        *,
        reference_time: datetime,
        export_snapshot: dict[str, Any],
    ) -> dict[str, Any]:
        """Both price channels, the export one supplied rather than read."""
        return {
            "export": export_snapshot,
            "import": self._build_import_price_snapshot(reference_time),
        }

    def build_export_price_snapshot(self) -> dict[str, Any]:
        """Read the configured sell-price entity. The one external boundary.

        Emits both shapes of the same reading: ``points``, normalized onto
        the canonical 15-minute grid via repeat expansion, and ``schedule``,
        the source's own attribute keys kept verbatim so Helman's published
        sensor can be compared key for key against the entity it ingests.
        """
        energy_nodes = read_mapping(self._config.get("energy_nodes"))
        grid_config = read_mapping(energy_nodes.get("grid"))
        grid_forecast = read_mapping(grid_config.get("forecast"))

        sell_price_entity_id = read_entity_id(
            grid_forecast.get("sell_price_entity_id")
        )
        if sell_price_entity_id is None:
            return self._make_price_snapshot(status="not_configured")

        state = self._get_state(sell_price_entity_id)
        current_price = read_float(state.state) if state is not None else None
        if current_price is not None and not isfinite(current_price):
            current_price = None
        unit = self._read_unit_from_state(state) if state is not None else None

        entries: list[tuple[datetime, str, float]] = []
        if state is not None:
            for key, raw_value in state.attributes.items():
                parsed_timestamp = self._parse_attribute_timestamp(key)
                if parsed_timestamp is None:
                    continue

                value = read_float(raw_value)
                if value is None or not isfinite(value):
                    continue

                entries.append((parsed_timestamp, key, value))

        entries.sort(key=lambda item: dt_util.as_utc(item[0]))
        schedule = {key: value for _parsed_timestamp, key, value in entries}
        points = expand_points_to_grid(
            [(parsed_timestamp, value) for parsed_timestamp, _key, value in entries],
            expansion_mode="repeat",
        )

        if current_price is not None and points:
            status = "available"
        elif current_price is not None or points:
            status = "partial"
            _LOGGER.warning(
                "Grid export price forecast partial: current_price=%s, points_count=%d",
                current_price,
                len(points),
            )
        else:
            status = "unavailable"
            _LOGGER.warning(
                "Grid export price forecast unavailable: no current price and no "
                "forecast points for %s",
                sell_price_entity_id,
            )

        return self._make_price_snapshot(
            status=status,
            unit=unit,
            current_price=current_price,
            points=points,
            schedule=schedule,
        )

    def _build_import_price_snapshot(self, reference_time: datetime) -> dict[str, Any]:
        try:
            import_config = read_grid_import_price_config(self._config)
        except GridImportPriceConfigError as err:
            _LOGGER.warning("Grid import price config invalid: %s", err)
            return self._make_price_snapshot(status="invalid_config")

        if import_config is None:
            return self._make_price_snapshot(status="not_configured")

        local_reference = dt_util.as_local(reference_time)
        current_price = lookup_grid_import_price(
            windows=import_config.windows,
            minute_of_day=local_reference.hour * 60 + local_reference.minute,
        )

        return self._make_price_snapshot(
            status="available",
            unit=import_config.unit,
            current_price=current_price,
            points=self._build_import_price_points(
                reference_time=reference_time,
                windows=import_config.windows,
            ),
        )

    def _build_import_price_points(
        self,
        *,
        reference_time: datetime,
        windows: tuple[FixedGridImportPriceWindow, ...],
    ) -> list[dict[str, Any]]:
        points: list[dict[str, Any]] = []
        current_slot_start = floor_to_slot(
            reference_time,
            interval_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
        )
        slot_count = (
            MAX_FORECAST_DAYS * 24 * 60 // FORECAST_CANONICAL_GRANULARITY_MINUTES
        )

        for slot_start in slot_starts(
            current_slot_start,
            advance(current_slot_start, slot_count=max(0, slot_count)),
        ):
            points.append(
                {
                    "timestamp": slot_start.isoformat(),
                    "value": lookup_grid_import_price(
                        windows=windows,
                        minute_of_day=slot_start.hour * 60 + slot_start.minute,
                    ),
                }
            )

        return points

    @staticmethod
    def _make_price_snapshot(
        *,
        status: str,
        unit: str | None = None,
        current_price: float | None = None,
        points: list[dict[str, Any]] | None = None,
        schedule: dict[str, float] | None = None,
    ) -> dict[str, Any]:
        return {
            "status": status,
            "unit": unit,
            "currentPrice": current_price,
            "points": points or [],
            "schedule": dict(schedule or {}),
        }

    def _get_state(self, entity_id: str | None):
        if entity_id is None:
            return None
        states = getattr(self._hass, "states", None)
        if states is None:
            return None
        return states.get(entity_id)

    @staticmethod
    def _read_unit_from_state(state) -> str | None:
        if state is None:
            return None

        unit = state.attributes.get("unit_of_measurement")
        if isinstance(unit, str) and unit:
            return unit
        return None

    def _parse_attribute_timestamp(self, raw_key: Any) -> datetime | None:
        if not isinstance(raw_key, str):
            return None

        try:
            parsed = datetime.fromisoformat(raw_key.replace("Z", "+00:00"))
        except ValueError:
            return None

        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=self._local_tz)

        return parsed


def read_grid_entities(config: dict[str, Any]) -> dict[str, str | None]:
    """The grid's configured entity ids, normalized once for all consumers."""
    energy_nodes = read_mapping(config.get("energy_nodes"))
    grid = read_mapping(energy_nodes.get("grid"))
    entities = read_mapping(grid.get("entities"))
    return {key: read_entity_id(value) for key, value in entities.items()}


def read_grid_sell_price_entity_id(config: dict[str, Any]) -> str | None:
    energy_nodes = read_mapping(config.get("energy_nodes"))
    grid = read_mapping(energy_nodes.get("grid"))
    forecast = read_mapping(grid.get("forecast"))
    return read_entity_id(forecast.get("sell_price_entity_id"))
