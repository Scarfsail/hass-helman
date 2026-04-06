from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .const import FORECAST_CANONICAL_GRANULARITY_MINUTES, MAX_FORECAST_DAYS

_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class FixedGridImportPriceWindow:
    start_minutes: int
    end_minutes: int
    price: float


@dataclass(frozen=True)
class FixedGridImportPriceConfig:
    unit: str
    windows: tuple[FixedGridImportPriceWindow, ...]


class GridImportPriceConfigError(ValueError):
    """Raised when the fixed import-price window config is invalid."""


class GridPriceForecastBuilder:
    def __init__(self, hass: HomeAssistant, config: dict[str, Any]) -> None:
        self._hass = hass
        self._config = config
        self._local_tz = ZoneInfo(str(hass.config.time_zone))

    def build(self, *, reference_time: datetime) -> dict[str, Any]:
        return {
            "export": self._build_export_price_snapshot(),
            "import": self._build_import_price_snapshot(reference_time),
        }

    def _build_export_price_snapshot(self) -> dict[str, Any]:
        power_devices = self._read_dict(self._config.get("power_devices"))
        grid_config = self._read_dict(power_devices.get("grid"))
        grid_forecast = self._read_dict(grid_config.get("forecast"))

        sell_price_entity_id = self._read_entity_id(
            grid_forecast.get("sell_price_entity_id")
        )
        if sell_price_entity_id is None:
            return self._make_price_snapshot(status="not_configured")

        state = self._get_state(sell_price_entity_id)
        current_price = self._read_float(state.state) if state is not None else None
        unit = self._read_unit_from_state(state) if state is not None else None

        points_with_sort_keys: list[tuple[datetime, dict[str, Any]]] = []
        if state is not None:
            for key, raw_value in state.attributes.items():
                parsed_timestamp = self._parse_attribute_timestamp(key)
                if parsed_timestamp is None:
                    continue

                value = self._read_float(raw_value)
                if value is None:
                    continue

                points_with_sort_keys.append(
                    (
                        parsed_timestamp,
                        {
                            "timestamp": parsed_timestamp.isoformat(),
                            "value": value,
                        },
                    )
                )

        points_with_sort_keys.sort(key=lambda item: dt_util.as_utc(item[0]))
        points = [point for _, point in points_with_sort_keys]

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
        )

    def _build_import_price_snapshot(self, reference_time: datetime) -> dict[str, Any]:
        try:
            import_config = self._read_import_price_config()
        except GridImportPriceConfigError as err:
            _LOGGER.warning("Grid import price config invalid: %s", err)
            return self._make_price_snapshot(status="invalid_config")

        if import_config is None:
            return self._make_price_snapshot(status="not_configured")

        local_reference = dt_util.as_local(reference_time)
        current_price = self._lookup_window_price(
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
        current_slot_start = self._get_local_current_slot_start(
            reference_time,
            interval_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
        )
        slot_count = (
            MAX_FORECAST_DAYS * 24 * 60 // FORECAST_CANONICAL_GRANULARITY_MINUTES
        )

        for slot_start in self._build_local_slot_starts_for_horizon(
            start_time=current_slot_start,
            slot_count=slot_count,
            interval_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
        ):
            points.append(
                {
                    "timestamp": slot_start.isoformat(),
                    "value": self._lookup_window_price(
                        windows=windows,
                        minute_of_day=slot_start.hour * 60 + slot_start.minute,
                    ),
                }
            )

        return points

    def _read_import_price_config(self) -> FixedGridImportPriceConfig | None:
        return read_grid_import_price_config(self._config)

    def _read_import_price_window(
        self,
        index: int,
        raw_value: Any,
    ) -> FixedGridImportPriceWindow:
        if not isinstance(raw_value, dict):
            raise GridImportPriceConfigError(
                f"power_devices.grid.forecast.import_price_windows[{index}] must be an object"
            )

        start_minutes = self._parse_window_time(
            raw_value.get("start"),
            field_name=f"import_price_windows[{index}].start",
        )
        end_minutes = self._parse_window_time(
            raw_value.get("end"),
            field_name=f"import_price_windows[{index}].end",
        )
        if start_minutes == end_minutes:
            raise GridImportPriceConfigError(
                f"power_devices.grid.forecast.import_price_windows[{index}] must not have the same start and end"
            )

        price = self._read_float(raw_value.get("price"))
        if price is None:
            raise GridImportPriceConfigError(
                f"power_devices.grid.forecast.import_price_windows[{index}].price must be numeric"
            )

        return FixedGridImportPriceWindow(
            start_minutes=start_minutes,
            end_minutes=end_minutes,
            price=price,
        )

    def _validate_daily_window_coverage(
        self,
        windows: tuple[FixedGridImportPriceWindow, ...],
    ) -> None:
        for minute_of_day in range(0, 24 * 60, FORECAST_CANONICAL_GRANULARITY_MINUTES):
            matching_windows = [
                window
                for window in windows
                if self._window_contains_minute(window, minute_of_day)
            ]
            formatted_time = self._format_minute_of_day(minute_of_day)
            if not matching_windows:
                raise GridImportPriceConfigError(
                    f"power_devices.grid.forecast.import_price_windows leave a gap at {formatted_time}"
                )
            if len(matching_windows) > 1:
                raise GridImportPriceConfigError(
                    f"power_devices.grid.forecast.import_price_windows overlap at {formatted_time}"
                )

    def _lookup_window_price(
        self,
        *,
        windows: tuple[FixedGridImportPriceWindow, ...],
        minute_of_day: int,
    ) -> float:
        for window in windows:
            if self._window_contains_minute(window, minute_of_day):
                return window.price

        raise GridImportPriceConfigError(
            "No import-price window matches the requested local time"
        )

    @staticmethod
    def _window_contains_minute(
        window: FixedGridImportPriceWindow,
        minute_of_day: int,
    ) -> bool:
        if window.start_minutes < window.end_minutes:
            return window.start_minutes <= minute_of_day < window.end_minutes
        return (
            minute_of_day >= window.start_minutes
            or minute_of_day < window.end_minutes
        )

    def _get_local_current_slot_start(
        self,
        reference_time: datetime,
        *,
        interval_minutes: int,
    ) -> datetime:
        local_reference = dt_util.as_local(reference_time)
        local_day_start = datetime.combine(
            local_reference.date(),
            time.min,
            tzinfo=self._local_tz,
        )
        slot_duration_seconds = interval_minutes * 60
        elapsed_seconds = max(
            0.0,
            (
                dt_util.as_utc(local_reference) - dt_util.as_utc(local_day_start)
            ).total_seconds(),
        )
        slot_index = int(elapsed_seconds // slot_duration_seconds)
        slot_start_utc = dt_util.as_utc(local_day_start) + timedelta(
            seconds=slot_index * slot_duration_seconds
        )
        return dt_util.as_local(slot_start_utc)

    def _build_local_slot_starts_for_horizon(
        self,
        *,
        start_time: datetime,
        slot_count: int,
        interval_minutes: int,
    ) -> list[datetime]:
        slots: list[datetime] = []
        cursor_utc = dt_util.as_utc(start_time)
        for _ in range(max(0, slot_count)):
            slots.append(dt_util.as_local(cursor_utc))
            cursor_utc += timedelta(minutes=interval_minutes)

        return slots

    @staticmethod
    def _make_price_snapshot(
        *,
        status: str,
        unit: str | None = None,
        current_price: float | None = None,
        points: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        return {
            "status": status,
            "unit": unit,
            "currentPrice": current_price,
            "points": points or [],
        }

    def _get_state(self, entity_id: str | None):
        if entity_id is None:
            return None
        return self._hass.states.get(entity_id)

    @staticmethod
    def _read_dict(raw_value: Any) -> dict[str, Any]:
        if isinstance(raw_value, dict):
            return raw_value
        return {}

    @staticmethod
    def _read_entity_id(raw_value: Any) -> str | None:
        if isinstance(raw_value, str) and raw_value.strip():
            return raw_value.strip()
        return None

    @staticmethod
    def _read_float(raw_value: Any) -> float | None:
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

    @staticmethod
    def _parse_window_time(raw_value: Any, *, field_name: str) -> int:
        if not isinstance(raw_value, str):
            raise GridImportPriceConfigError(
                f"power_devices.grid.forecast.{field_name} must be an HH:MM string"
            )

        try:
            parsed = time.fromisoformat(raw_value)
        except ValueError as err:
            raise GridImportPriceConfigError(
                f"power_devices.grid.forecast.{field_name} must be an HH:MM string"
            ) from err

        if parsed.tzinfo is not None:
            raise GridImportPriceConfigError(
                f"power_devices.grid.forecast.{field_name} must not include a timezone offset"
            )
        if parsed.second or parsed.microsecond:
            raise GridImportPriceConfigError(
                f"power_devices.grid.forecast.{field_name} must not include seconds"
            )
        if parsed.minute % FORECAST_CANONICAL_GRANULARITY_MINUTES != 0:
            raise GridImportPriceConfigError(
                f"power_devices.grid.forecast.{field_name} must align to {FORECAST_CANONICAL_GRANULARITY_MINUTES}-minute boundaries"
            )

        return parsed.hour * 60 + parsed.minute

    @staticmethod
    def _format_minute_of_day(minute_of_day: int) -> str:
        hours, minutes = divmod(minute_of_day, 60)
        return f"{hours:02d}:{minutes:02d}"


def read_grid_import_price_config(
    config: dict[str, Any] | Any,
) -> FixedGridImportPriceConfig | None:
    power_devices = GridPriceForecastBuilder._read_dict(config.get("power_devices"))
    grid_config = GridPriceForecastBuilder._read_dict(power_devices.get("grid"))
    grid_forecast = GridPriceForecastBuilder._read_dict(grid_config.get("forecast"))

    raw_unit = grid_forecast.get("import_price_unit")
    raw_windows = grid_forecast.get("import_price_windows")

    if raw_unit is None and raw_windows is None:
        return None

    if not isinstance(raw_unit, str) or not raw_unit.strip():
        raise GridImportPriceConfigError(
            "power_devices.grid.forecast.import_price_unit must be a non-empty string"
        )
    if not isinstance(raw_windows, list) or not raw_windows:
        raise GridImportPriceConfigError(
            "power_devices.grid.forecast.import_price_windows must be a non-empty list"
        )

    windows = tuple(
        _read_grid_import_price_window(index, item)
        for index, item in enumerate(raw_windows)
    )
    _validate_grid_import_price_window_coverage(windows)
    return FixedGridImportPriceConfig(unit=raw_unit.strip(), windows=windows)


def _read_grid_import_price_window(
    index: int,
    raw_value: Any,
) -> FixedGridImportPriceWindow:
    if not isinstance(raw_value, dict):
        raise GridImportPriceConfigError(
            f"power_devices.grid.forecast.import_price_windows[{index}] must be an object"
        )

    start_minutes = GridPriceForecastBuilder._parse_window_time(
        raw_value.get("start"),
        field_name=f"import_price_windows[{index}].start",
    )
    end_minutes = GridPriceForecastBuilder._parse_window_time(
        raw_value.get("end"),
        field_name=f"import_price_windows[{index}].end",
    )
    if start_minutes == end_minutes:
        raise GridImportPriceConfigError(
            f"power_devices.grid.forecast.import_price_windows[{index}] must not have the same start and end"
        )

    price = GridPriceForecastBuilder._read_float(raw_value.get("price"))
    if price is None:
        raise GridImportPriceConfigError(
            f"power_devices.grid.forecast.import_price_windows[{index}].price must be numeric"
        )

    return FixedGridImportPriceWindow(
        start_minutes=start_minutes,
        end_minutes=end_minutes,
        price=price,
    )


def _validate_grid_import_price_window_coverage(
    windows: tuple[FixedGridImportPriceWindow, ...],
) -> None:
    for minute_of_day in range(0, 24 * 60, FORECAST_CANONICAL_GRANULARITY_MINUTES):
        matching_windows = [
            window
            for window in windows
            if _grid_import_window_contains_minute(window, minute_of_day)
        ]
        formatted_time = GridPriceForecastBuilder._format_minute_of_day(minute_of_day)
        if not matching_windows:
            raise GridImportPriceConfigError(
                f"power_devices.grid.forecast.import_price_windows leave a gap at {formatted_time}"
            )
        if len(matching_windows) > 1:
            raise GridImportPriceConfigError(
                f"power_devices.grid.forecast.import_price_windows overlap at {formatted_time}"
            )


def _grid_import_window_contains_minute(
    window: FixedGridImportPriceWindow,
    minute_of_day: int,
) -> bool:
    if window.start_minutes < window.end_minutes:
        return window.start_minutes <= minute_of_day < window.end_minutes
    return minute_of_day >= window.start_minutes or minute_of_day < window.end_minutes
