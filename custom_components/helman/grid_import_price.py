"""Grid import price fixed windows and rate lookup."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import time
from typing import Any

from .config_read import read_float, read_mapping
from .const import FORECAST_CANONICAL_GRANULARITY_MINUTES


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


def _parse_window_time(raw_value: Any, *, field_name: str) -> int:
    if not isinstance(raw_value, str):
        raise GridImportPriceConfigError(
            f"energy_nodes.grid.forecast.{field_name} must be an HH:MM string"
        )

    try:
        parsed = time.fromisoformat(raw_value)
    except ValueError as err:
        raise GridImportPriceConfigError(
            f"energy_nodes.grid.forecast.{field_name} must be an HH:MM string"
        ) from err

    if parsed.tzinfo is not None:
        raise GridImportPriceConfigError(
            f"energy_nodes.grid.forecast.{field_name} must not include a timezone offset"
        )
    if parsed.second or parsed.microsecond:
        raise GridImportPriceConfigError(
            f"energy_nodes.grid.forecast.{field_name} must not include seconds"
        )
    if parsed.minute % FORECAST_CANONICAL_GRANULARITY_MINUTES != 0:
        raise GridImportPriceConfigError(
            f"energy_nodes.grid.forecast.{field_name} must align to {FORECAST_CANONICAL_GRANULARITY_MINUTES}-minute boundaries"
        )

    return parsed.hour * 60 + parsed.minute


def _format_minute_of_day(minute_of_day: int) -> str:
    hours, minutes = divmod(minute_of_day, 60)
    return f"{hours:02d}:{minutes:02d}"


def read_grid_import_price_config(
    config: dict[str, Any] | Any,
) -> FixedGridImportPriceConfig | None:
    energy_nodes = read_mapping(config.get("energy_nodes"))
    grid_config = read_mapping(energy_nodes.get("grid"))
    grid_forecast = read_mapping(grid_config.get("forecast"))

    raw_unit = grid_forecast.get("import_price_unit")
    raw_windows = grid_forecast.get("import_price_windows")

    if raw_unit is None and raw_windows is None:
        return None

    if not isinstance(raw_unit, str) or not raw_unit.strip():
        raise GridImportPriceConfigError(
            "energy_nodes.grid.forecast.import_price_unit must be a non-empty string"
        )
    if not isinstance(raw_windows, list) or not raw_windows:
        raise GridImportPriceConfigError(
            "energy_nodes.grid.forecast.import_price_windows must be a non-empty list"
        )

    windows = tuple(
        _read_grid_import_price_window(index, item)
        for index, item in enumerate(raw_windows)
    )
    _validate_grid_import_price_window_coverage(windows)
    return FixedGridImportPriceConfig(unit=raw_unit.strip(), windows=windows)


def lookup_grid_import_price(
    *,
    windows: tuple[FixedGridImportPriceWindow, ...],
    minute_of_day: int,
) -> float:
    """The configured import rate in force at ``minute_of_day``, any date."""
    for window in windows:
        if _grid_import_window_contains_minute(window, minute_of_day):
            return window.price

    raise GridImportPriceConfigError(
        "No import-price window matches the requested local time"
    )


def _read_grid_import_price_window(
    index: int,
    raw_value: Any,
) -> FixedGridImportPriceWindow:
    if not isinstance(raw_value, dict):
        raise GridImportPriceConfigError(
            f"energy_nodes.grid.forecast.import_price_windows[{index}] must be an object"
        )

    start_minutes = _parse_window_time(
        raw_value.get("start"),
        field_name=f"import_price_windows[{index}].start",
    )
    end_minutes = _parse_window_time(
        raw_value.get("end"),
        field_name=f"import_price_windows[{index}].end",
    )
    if start_minutes == end_minutes:
        raise GridImportPriceConfigError(
            f"energy_nodes.grid.forecast.import_price_windows[{index}] must not have the same start and end"
        )

    price = read_float(raw_value.get("price"))
    if price is None:
        raise GridImportPriceConfigError(
            f"energy_nodes.grid.forecast.import_price_windows[{index}].price must be numeric"
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
        formatted_time = _format_minute_of_day(minute_of_day)
        if not matching_windows:
            raise GridImportPriceConfigError(
                f"energy_nodes.grid.forecast.import_price_windows leave a gap at {formatted_time}"
            )
        if len(matching_windows) > 1:
            raise GridImportPriceConfigError(
                f"energy_nodes.grid.forecast.import_price_windows overlap at {formatted_time}"
            )


def _grid_import_window_contains_minute(
    window: FixedGridImportPriceWindow,
    minute_of_day: int,
) -> bool:
    if window.start_minutes < window.end_minutes:
        return window.start_minutes <= minute_of_day < window.end_minutes
    return minute_of_day >= window.start_minutes or minute_of_day < window.end_minutes
