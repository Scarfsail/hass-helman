from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from homeassistant.core import HomeAssistant

from .const import (
    BATTERY_CAPACITY_FORECAST_DEFAULT_CHARGE_EFFICIENCY,
    BATTERY_CAPACITY_FORECAST_DEFAULT_DISCHARGE_EFFICIENCY,
)


@dataclass(frozen=True)
class BatteryEntityConfig:
    remaining_energy_entity_id: str
    capacity_entity_id: str
    min_soc_entity_id: str
    max_soc_entity_id: str


@dataclass(frozen=True)
class BatteryForecastSettings:
    charge_efficiency: float
    discharge_efficiency: float
    max_charge_power_w: float | None
    max_discharge_power_w: float | None

    @property
    def is_configured(self) -> bool:
        return (
            self.max_charge_power_w is not None
            and self.max_discharge_power_w is not None
        )


@dataclass(frozen=True)
class BatteryLiveState:
    current_remaining_energy_kwh: float
    current_soc: float
    min_soc: float
    max_soc: float
    nominal_capacity_kwh: float
    min_energy_kwh: float
    max_energy_kwh: float


def read_battery_entity_config(config: dict[str, Any]) -> BatteryEntityConfig | None:
    power_devices = _read_dict(config.get("power_devices"))
    battery_config = _read_dict(power_devices.get("battery"))
    entities = _read_dict(battery_config.get("entities"))

    remaining_energy_entity_id = _read_entity_id(entities.get("remaining_energy"))
    capacity_entity_id = _read_entity_id(entities.get("capacity"))
    min_soc_entity_id = _read_entity_id(entities.get("min_soc"))
    max_soc_entity_id = _read_entity_id(entities.get("max_soc"))

    if (
        remaining_energy_entity_id is None
        or capacity_entity_id is None
        or min_soc_entity_id is None
        or max_soc_entity_id is None
    ):
        return None

    return BatteryEntityConfig(
        remaining_energy_entity_id=remaining_energy_entity_id,
        capacity_entity_id=capacity_entity_id,
        min_soc_entity_id=min_soc_entity_id,
        max_soc_entity_id=max_soc_entity_id,
    )


def read_battery_forecast_settings(config: dict[str, Any]) -> BatteryForecastSettings:
    power_devices = _read_dict(config.get("power_devices"))
    battery_config = _read_dict(power_devices.get("battery"))
    forecast_config = _read_dict(battery_config.get("forecast"))

    return BatteryForecastSettings(
        charge_efficiency=_read_probability(
            forecast_config.get("charge_efficiency"),
            BATTERY_CAPACITY_FORECAST_DEFAULT_CHARGE_EFFICIENCY,
        ),
        discharge_efficiency=_read_probability(
            forecast_config.get("discharge_efficiency"),
            BATTERY_CAPACITY_FORECAST_DEFAULT_DISCHARGE_EFFICIENCY,
        ),
        max_charge_power_w=_read_positive_float(
            forecast_config.get("max_charge_power_w")
        ),
        max_discharge_power_w=_read_positive_float(
            forecast_config.get("max_discharge_power_w")
        ),
    )


def read_battery_live_state(
    hass: HomeAssistant, entity_config: BatteryEntityConfig
) -> BatteryLiveState | None:
    remaining_energy_state = hass.states.get(entity_config.remaining_energy_entity_id)
    capacity_state = hass.states.get(entity_config.capacity_entity_id)
    min_soc_state = hass.states.get(entity_config.min_soc_entity_id)
    max_soc_state = hass.states.get(entity_config.max_soc_entity_id)

    remaining_energy = _read_state_float(remaining_energy_state)
    current_soc = _read_state_float(capacity_state)
    min_soc = _read_state_float(min_soc_state)
    max_soc = _read_state_float(max_soc_state)

    if (
        remaining_energy is None
        or current_soc is None
        or min_soc is None
        or max_soc is None
    ):
        return None

    remaining_energy_kwh = _normalize_energy_to_kwh(
        remaining_energy,
        remaining_energy_state.attributes.get("unit_of_measurement")
        if remaining_energy_state is not None
        else None,
    )
    if remaining_energy_kwh is None or remaining_energy_kwh < 0:
        return None

    if current_soc <= 0 or current_soc > 100:
        return None
    if min_soc < 0 or min_soc > 100 or max_soc < 0 or max_soc > 100:
        return None
    if min_soc > max_soc:
        return None
    if current_soc < min_soc or current_soc > max_soc:
        return None

    nominal_capacity_kwh = remaining_energy_kwh / (current_soc / 100)
    if nominal_capacity_kwh <= 0:
        return None

    min_energy_kwh = nominal_capacity_kwh * (min_soc / 100)
    max_energy_kwh = nominal_capacity_kwh * (max_soc / 100)

    return BatteryLiveState(
        current_remaining_energy_kwh=remaining_energy_kwh,
        current_soc=current_soc,
        min_soc=min_soc,
        max_soc=max_soc,
        nominal_capacity_kwh=nominal_capacity_kwh,
        min_energy_kwh=min_energy_kwh,
        max_energy_kwh=max_energy_kwh,
    )


def _normalize_energy_to_kwh(raw_value: float, raw_unit: Any) -> float | None:
    normalized_unit = "wh"
    if isinstance(raw_unit, str) and raw_unit.strip():
        normalized_unit = raw_unit.strip().lower().replace(" ", "")

    if normalized_unit == "wh":
        return raw_value / 1000
    if normalized_unit == "kwh":
        return raw_value
    if normalized_unit == "mwh":
        return raw_value * 1000

    return None


def _read_state_float(state) -> float | None:
    if state is None:
        return None
    return _read_float(state.state)


def _read_dict(raw_value: Any) -> dict[str, Any]:
    if isinstance(raw_value, dict):
        return raw_value
    return {}


def _read_entity_id(raw_value: Any) -> str | None:
    if isinstance(raw_value, str) and raw_value.strip():
        return raw_value.strip()
    return None


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


def _read_positive_float(raw_value: Any) -> float | None:
    parsed = _read_float(raw_value)
    if parsed is None or parsed <= 0:
        return None
    return parsed


def _read_probability(raw_value: Any, default: float) -> float:
    parsed = _read_float(raw_value)
    if parsed is None or parsed <= 0 or parsed > 1:
        return default
    return parsed
