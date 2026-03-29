from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from homeassistant.core import HomeAssistant

from .const import (
    BATTERY_CAPACITY_FORECAST_DEFAULT_CHARGE_EFFICIENCY,
    BATTERY_CAPACITY_FORECAST_DEFAULT_DISCHARGE_EFFICIENCY,
)
from .energy_units import normalize_energy_to_kwh


@dataclass(frozen=True)
class BatteryEntityConfig:
    remaining_energy_entity_id: str
    capacity_entity_id: str
    min_soc_entity_id: str
    max_soc_entity_id: str


@dataclass(frozen=True)
class BatterySocBoundsConfig:
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
    soc_bounds_config = read_battery_soc_bounds_config(config)

    if (
        remaining_energy_entity_id is None
        or capacity_entity_id is None
        or soc_bounds_config is None
    ):
        return None

    return BatteryEntityConfig(
        remaining_energy_entity_id=remaining_energy_entity_id,
        capacity_entity_id=capacity_entity_id,
        min_soc_entity_id=soc_bounds_config.min_soc_entity_id,
        max_soc_entity_id=soc_bounds_config.max_soc_entity_id,
    )


def describe_battery_entity_config_issue(config: dict[str, Any]) -> str | None:
    power_devices = _read_dict(config.get("power_devices"))
    battery_config = _read_dict(power_devices.get("battery"))
    entities = _read_dict(battery_config.get("entities"))

    missing_fields: list[str] = []
    if _read_entity_id(entities.get("remaining_energy")) is None:
        missing_fields.append("power_devices.battery.entities.remaining_energy")
    if _read_entity_id(entities.get("capacity")) is None:
        missing_fields.append("power_devices.battery.entities.capacity")
    if _read_entity_id(entities.get("min_soc")) is None:
        missing_fields.append("power_devices.battery.entities.min_soc")
    if _read_entity_id(entities.get("max_soc")) is None:
        missing_fields.append("power_devices.battery.entities.max_soc")

    if not missing_fields:
        return None

    return "missing required battery entity config values: " + ", ".join(
        missing_fields
    )


@dataclass(frozen=True)
class BatterySocBounds:
    min_soc: float
    max_soc: float


def read_battery_soc_bounds_config(
    config: dict[str, Any],
) -> BatterySocBoundsConfig | None:
    power_devices = _read_dict(config.get("power_devices"))
    battery_config = _read_dict(power_devices.get("battery"))
    entities = _read_dict(battery_config.get("entities"))

    min_soc_entity_id = _read_entity_id(entities.get("min_soc"))
    max_soc_entity_id = _read_entity_id(entities.get("max_soc"))

    if min_soc_entity_id is None or max_soc_entity_id is None:
        return None

    return BatterySocBoundsConfig(
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
    live_state, _issue = _read_battery_live_state_result(hass, entity_config)
    return live_state


def describe_battery_live_state_issue(
    hass: HomeAssistant,
    entity_config: BatteryEntityConfig,
) -> str | None:
    live_state, issue = _read_battery_live_state_result(hass, entity_config)
    if live_state is not None:
        return None
    return issue


def _read_battery_live_state_result(
    hass: HomeAssistant,
    entity_config: BatteryEntityConfig,
) -> tuple[BatteryLiveState | None, str | None]:
    remaining_energy_state = hass.states.get(entity_config.remaining_energy_entity_id)
    capacity_state = hass.states.get(entity_config.capacity_entity_id)

    remaining_energy = _read_state_float(remaining_energy_state)
    current_soc = _read_state_float(capacity_state)
    soc_bounds, soc_bounds_issue = _read_battery_soc_bounds_result(
        hass,
        BatterySocBoundsConfig(
            min_soc_entity_id=entity_config.min_soc_entity_id,
            max_soc_entity_id=entity_config.max_soc_entity_id,
        ),
    )

    if remaining_energy is None:
        return None, _describe_numeric_state_issue(
            entity_id=entity_config.remaining_energy_entity_id,
            state=remaining_energy_state,
            label="battery remaining energy",
        )
    if current_soc is None:
        return None, _describe_numeric_state_issue(
            entity_id=entity_config.capacity_entity_id,
            state=capacity_state,
            label="battery SoC",
        )
    if soc_bounds is None:
        return None, soc_bounds_issue

    remaining_energy_kwh = normalize_energy_to_kwh(
        remaining_energy,
        remaining_energy_state.attributes.get("unit_of_measurement")
        if remaining_energy_state is not None
        else None,
        default_unit=None,
    )
    if remaining_energy_kwh is None:
        raw_unit = (
            remaining_energy_state.attributes.get("unit_of_measurement")
            if remaining_energy_state is not None
            else None
        )
        return None, (
            "battery remaining energy entity "
            f"'{entity_config.remaining_energy_entity_id}' has unsupported unit "
            f"{raw_unit!r} for value {getattr(remaining_energy_state, 'state', None)!r}"
        )
    if remaining_energy_kwh < 0:
        return None, (
            "battery remaining energy entity "
            f"'{entity_config.remaining_energy_entity_id}' resolved to a negative "
            f"value {remaining_energy_kwh}"
        )

    if current_soc <= 0 or current_soc > 100:
        return None, (
            f"battery SoC entity '{entity_config.capacity_entity_id}' has "
            f"out-of-range value {current_soc}"
        )
    if current_soc < soc_bounds.min_soc or current_soc > soc_bounds.max_soc:
        return None, (
            f"battery SoC {current_soc} from entity "
            f"'{entity_config.capacity_entity_id}' is outside configured bounds "
            f"{soc_bounds.min_soc}-{soc_bounds.max_soc}"
        )

    nominal_capacity_kwh = remaining_energy_kwh / (current_soc / 100)
    if nominal_capacity_kwh <= 0:
        return None, (
            "battery nominal capacity computed from remaining energy "
            f"{remaining_energy_kwh} kWh and SoC {current_soc}% is invalid"
        )

    min_energy_kwh = nominal_capacity_kwh * (soc_bounds.min_soc / 100)
    max_energy_kwh = nominal_capacity_kwh * (soc_bounds.max_soc / 100)

    return (
        BatteryLiveState(
            current_remaining_energy_kwh=remaining_energy_kwh,
            current_soc=current_soc,
            min_soc=soc_bounds.min_soc,
            max_soc=soc_bounds.max_soc,
            nominal_capacity_kwh=nominal_capacity_kwh,
            min_energy_kwh=min_energy_kwh,
            max_energy_kwh=max_energy_kwh,
        ),
        None,
    )


def read_battery_soc_bounds(
    hass: HomeAssistant, config: BatterySocBoundsConfig
) -> BatterySocBounds | None:
    bounds, _issue = _read_battery_soc_bounds_result(hass, config)
    return bounds


def _read_battery_soc_bounds_result(
    hass: HomeAssistant,
    config: BatterySocBoundsConfig,
) -> tuple[BatterySocBounds | None, str]:
    min_soc_state = hass.states.get(config.min_soc_entity_id)
    max_soc_state = hass.states.get(config.max_soc_entity_id)

    min_soc = _read_state_float(min_soc_state)
    max_soc = _read_state_float(max_soc_state)
    if min_soc is None:
        return None, _describe_numeric_state_issue(
            entity_id=config.min_soc_entity_id,
            state=min_soc_state,
            label="battery min SoC",
        )
    if max_soc is None:
        return None, _describe_numeric_state_issue(
            entity_id=config.max_soc_entity_id,
            state=max_soc_state,
            label="battery max SoC",
        )
    if min_soc < 0 or min_soc > 100 or max_soc < 0 or max_soc > 100:
        return None, (
            "battery SoC bounds are out of range: "
            f"min={min_soc} from '{config.min_soc_entity_id}', "
            f"max={max_soc} from '{config.max_soc_entity_id}'"
        )
    if min_soc > max_soc:
        return None, (
            "battery SoC bounds are invalid: "
            f"min={min_soc} from '{config.min_soc_entity_id}' is greater than "
            f"max={max_soc} from '{config.max_soc_entity_id}'"
        )

    return BatterySocBounds(min_soc=min_soc, max_soc=max_soc), ""


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


def _describe_numeric_state_issue(*, entity_id: str, state: Any, label: str) -> str:
    if state is None:
        return f"{label} entity '{entity_id}' is not available"

    raw_state = getattr(state, "state", None)
    if isinstance(raw_state, str):
        stripped = raw_state.strip()
        if not stripped:
            return f"{label} entity '{entity_id}' has an empty state"
        if stripped.lower() in {"unknown", "unavailable", "none"}:
            return f"{label} entity '{entity_id}' has unavailable state {stripped!r}"

    return f"{label} entity '{entity_id}' has non-numeric state {raw_state!r}"
