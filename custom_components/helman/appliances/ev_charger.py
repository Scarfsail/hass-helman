from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal, NotRequired, TypedDict

from .icon import read_optional_appliance_icon, resolve_appliance_icon

_EV_CHARGER_KIND = "ev_charger"
_FIXED_MAX_POWER_BEHAVIOR = "fixed_max_power"
_SURPLUS_AWARE_BEHAVIOR = "surplus_aware"
EvChargerUseModeBehavior = Literal["fixed_max_power", "surplus_aware"]


class EvChargerConfigError(ValueError):
    """Raised when one EV charger appliance config entry is invalid."""


@dataclass(frozen=True)
class EvVehicleRuntime:
    id: str
    name: str
    soc_entity_id: str
    charge_limit_entity_id: str | None
    battery_capacity_kwh: float
    max_charging_power_kw: float


@dataclass(frozen=True)
class EvChargerUseModeRuntime:
    id: str
    behavior: EvChargerUseModeBehavior


@dataclass(frozen=True)
class EvChargerEcoGearRuntime:
    id: str
    min_power_kw: float


@dataclass(frozen=True)
class EvChargerApplianceRuntime:
    id: str
    name: str
    max_charging_power_kw: float
    charge_entity_id: str
    use_mode_entity_id: str
    eco_gear_entity_id: str
    use_mode_configs: tuple[EvChargerUseModeRuntime, ...]
    eco_gear_configs: tuple[EvChargerEcoGearRuntime, ...]
    vehicles: tuple[EvVehicleRuntime, ...]
    icon: str | None = None

    @property
    def kind(self) -> str:
        return _EV_CHARGER_KIND

    @property
    def use_modes(self) -> tuple[str, ...]:
        return tuple(use_mode.id for use_mode in self.use_mode_configs)

    @property
    def use_modes_by_id(self) -> dict[str, EvChargerUseModeRuntime]:
        return {use_mode.id: use_mode for use_mode in self.use_mode_configs}

    @property
    def eco_gears(self) -> tuple[str, ...]:
        return tuple(gear.id for gear in self.eco_gear_configs)

    @property
    def vehicles_by_id(self) -> dict[str, EvVehicleRuntime]:
        return {vehicle.id: vehicle for vehicle in self.vehicles}

    @property
    def eco_gear_min_power_kw_by_id(self) -> dict[str, float]:
        return {gear.id: gear.min_power_kw for gear in self.eco_gear_configs}

    def get_use_mode(self, use_mode_id: str) -> EvChargerUseModeRuntime | None:
        return self.use_modes_by_id.get(use_mode_id)

    def get_vehicle(self, vehicle_id: str) -> EvVehicleRuntime | None:
        return self.vehicles_by_id.get(vehicle_id)


class EntityReferenceDict(TypedDict):
    entityId: str


class ApplianceScheduleCapabilitiesDict(TypedDict):
    chargeToggle: bool
    useModes: list[str]
    ecoGears: list[str]
    requiresVehicleSelection: bool


class ApplianceControlsDict(TypedDict):
    charge: EntityReferenceDict
    useMode: EntityReferenceDict
    ecoGear: EntityReferenceDict


class EvVehicleTelemetryDict(TypedDict):
    socEntityId: str
    chargeLimitEntityId: NotRequired[str]


class EvVehicleMetadataDict(TypedDict):
    batteryCapacityKwh: float
    maxChargingPowerKw: float


class EvVehicleResponseDict(TypedDict):
    id: str
    name: str
    telemetry: EvVehicleTelemetryDict
    metadata: EvVehicleMetadataDict


class EvChargerMetadataDict(TypedDict):
    icon: str
    maxChargingPowerKw: float
    scheduleCapabilities: ApplianceScheduleCapabilitiesDict


class EvChargerApplianceResponseDict(TypedDict):
    id: str
    name: str
    kind: str
    metadata: EvChargerMetadataDict
    controls: ApplianceControlsDict
    vehicles: list[EvVehicleResponseDict]


def read_ev_charger_appliance(
    value: object,
    *,
    path: str,
) -> EvChargerApplianceRuntime:
    appliance = _require_mapping(value, path)

    kind = _require_non_empty_string(appliance.get("kind"), f"{path}.kind")
    if kind != _EV_CHARGER_KIND:
        raise EvChargerConfigError(f"{path}.kind must be {_EV_CHARGER_KIND!r}")

    vehicles = _read_vehicles(appliance.get("vehicles"), path=f"{path}.vehicles")
    controls = _require_mapping(appliance.get("controls"), f"{path}.controls")
    use_mode_entity_id, use_mode_configs = _read_use_mode_control(
        controls.get("use_mode"),
        path=f"{path}.controls.use_mode",
    )
    eco_gear_entity_id, eco_gear_configs = _read_eco_gear_control(
        controls.get("eco_gear"),
        path=f"{path}.controls.eco_gear",
    )

    return EvChargerApplianceRuntime(
        id=_require_non_empty_string(appliance.get("id"), f"{path}.id"),
        name=_require_non_empty_string(appliance.get("name"), f"{path}.name"),
        max_charging_power_kw=_read_limits(
            appliance.get("limits"),
            path=f"{path}.limits",
        ),
        charge_entity_id=_read_control_entity_id(
            controls.get("charge"),
            expected_domain="switch",
            path=f"{path}.controls.charge",
        ),
        use_mode_entity_id=use_mode_entity_id,
        eco_gear_entity_id=eco_gear_entity_id,
        use_mode_configs=use_mode_configs,
        eco_gear_configs=eco_gear_configs,
        vehicles=vehicles,
        icon=read_optional_appliance_icon(
            appliance.get("icon"),
            path=f"{path}.icon",
            error_type=EvChargerConfigError,
        ),
    )


def build_ev_charger_metadata_dict(
    appliance: EvChargerApplianceRuntime,
) -> EvChargerApplianceResponseDict:
    return {
        "id": appliance.id,
        "name": appliance.name,
        "kind": appliance.kind,
        "metadata": {
            "icon": resolve_appliance_icon(appliance.icon),
            "maxChargingPowerKw": appliance.max_charging_power_kw,
            "scheduleCapabilities": {
                "chargeToggle": True,
                "useModes": list(appliance.use_modes),
                "ecoGears": list(appliance.eco_gears),
                "requiresVehicleSelection": True,
            },
        },
        "controls": {
            "charge": {"entityId": appliance.charge_entity_id},
            "useMode": {"entityId": appliance.use_mode_entity_id},
            "ecoGear": {"entityId": appliance.eco_gear_entity_id},
        },
        "vehicles": [
            _build_vehicle_metadata_dict(vehicle) for vehicle in appliance.vehicles
        ],
    }


def _build_vehicle_metadata_dict(vehicle: EvVehicleRuntime) -> EvVehicleResponseDict:
    telemetry: EvVehicleTelemetryDict = {
        "socEntityId": vehicle.soc_entity_id,
    }
    if vehicle.charge_limit_entity_id is not None:
        telemetry["chargeLimitEntityId"] = vehicle.charge_limit_entity_id

    return {
        "id": vehicle.id,
        "name": vehicle.name,
        "telemetry": telemetry,
        "metadata": {
            "batteryCapacityKwh": vehicle.battery_capacity_kwh,
            "maxChargingPowerKw": vehicle.max_charging_power_kw,
        },
    }


def _read_limits(value: object, *, path: str) -> float:
    limits = _require_mapping(value, path)
    return _require_positive_float(
        limits.get("max_charging_power_kw"),
        f"{path}.max_charging_power_kw",
    )


def _read_control_entity_id(
    value: object,
    *,
    expected_domain: str | None = None,
    expected_domains: tuple[str, ...] | None = None,
    path: str,
) -> str:
    control = _require_mapping(value, path)
    if expected_domains is not None:
        return _require_entity_id_in_domains(
            control.get("entity_id"),
            expected_domains=expected_domains,
            path=f"{path}.entity_id",
        )
    if expected_domain is None:
        raise ValueError("expected_domain or expected_domains must be provided")
    return _require_entity_id(
        control.get("entity_id"),
        expected_domain=expected_domain,
        path=f"{path}.entity_id",
    )


def _read_use_mode_control(
    value: object,
    *,
    path: str,
) -> tuple[str, tuple[EvChargerUseModeRuntime, ...]]:
    control = _require_mapping(value, path)
    values = _require_mapping(control.get("values"), f"{path}.values")
    if not values:
        raise EvChargerConfigError(f"{path}.values must not be empty")

    use_modes: list[EvChargerUseModeRuntime] = []
    for raw_mode_id, raw_mode_config in values.items():
        mode_id = _require_non_empty_string(raw_mode_id, f"{path}.values keys")
        mode_config = _require_mapping(raw_mode_config, f"{path}.values.{mode_id}")
        use_modes.append(
            EvChargerUseModeRuntime(
                id=mode_id,
                behavior=_read_use_mode_behavior(
                    mode_config.get("behavior"),
                    path=f"{path}.values.{mode_id}.behavior",
                ),
            )
        )

    return (
        _read_control_entity_id(
            control,
            expected_domains=("input_select", "select"),
            path=path,
        ),
        tuple(use_modes),
    )


def _read_use_mode_behavior(
    value: object,
    *,
    path: str,
) -> EvChargerUseModeBehavior:
    behavior = _require_non_empty_string(value, path)
    if behavior not in {_FIXED_MAX_POWER_BEHAVIOR, _SURPLUS_AWARE_BEHAVIOR}:
        raise EvChargerConfigError(
            f"{path} must be one of {_FIXED_MAX_POWER_BEHAVIOR!r}, "
            f"{_SURPLUS_AWARE_BEHAVIOR!r}"
        )
    return behavior


def _read_eco_gear_control(
    value: object,
    *,
    path: str,
) -> tuple[str, tuple[EvChargerEcoGearRuntime, ...]]:
    control = _require_mapping(value, path)
    values = _require_mapping(control.get("values"), f"{path}.values")
    if not values:
        raise EvChargerConfigError(f"{path}.values must not be empty")

    eco_gears: list[EvChargerEcoGearRuntime] = []
    for raw_gear_id, raw_gear_config in values.items():
        gear_id = _require_non_empty_string(raw_gear_id, f"{path}.values keys")
        gear_config = _require_mapping(raw_gear_config, f"{path}.values.{gear_id}")
        eco_gears.append(
            EvChargerEcoGearRuntime(
                id=gear_id,
                min_power_kw=_require_positive_float(
                    gear_config.get("min_power_kw"),
                    f"{path}.values.{gear_id}.min_power_kw",
                ),
            )
        )

    return (
        _read_control_entity_id(
            control,
            expected_domains=("input_select", "select"),
            path=path,
        ),
        tuple(eco_gears),
    )


def _read_vehicles(value: object, *, path: str) -> tuple[EvVehicleRuntime, ...]:
    if not isinstance(value, list) or not value:
        raise EvChargerConfigError(f"{path} must be a non-empty list")

    vehicles: list[EvVehicleRuntime] = []
    seen_vehicle_ids: set[str] = set()
    for index, raw_vehicle in enumerate(value):
        vehicle_path = f"{path}[{index}]"
        vehicle = _read_vehicle(raw_vehicle, path=vehicle_path)
        if vehicle.id in seen_vehicle_ids:
            raise EvChargerConfigError(
                f"{vehicle_path}.id duplicates vehicle id {vehicle.id!r}"
            )
        seen_vehicle_ids.add(vehicle.id)
        vehicles.append(vehicle)

    return tuple(vehicles)


def _read_vehicle(value: object, *, path: str) -> EvVehicleRuntime:
    vehicle = _require_mapping(value, path)
    telemetry = _require_mapping(vehicle.get("telemetry"), f"{path}.telemetry")
    limits = _require_mapping(vehicle.get("limits"), f"{path}.limits")

    charge_limit_entity_id = telemetry.get("charge_limit_entity_id")
    return EvVehicleRuntime(
        id=_require_non_empty_string(vehicle.get("id"), f"{path}.id"),
        name=_require_non_empty_string(vehicle.get("name"), f"{path}.name"),
        soc_entity_id=_require_entity_id(
            telemetry.get("soc_entity_id"),
            expected_domain="sensor",
            path=f"{path}.telemetry.soc_entity_id",
        ),
        charge_limit_entity_id=(
            None
            if charge_limit_entity_id is None
            else _require_entity_id(
                charge_limit_entity_id,
                expected_domain="number",
                path=f"{path}.telemetry.charge_limit_entity_id",
            )
        ),
        battery_capacity_kwh=_require_positive_float(
            limits.get("battery_capacity_kwh"),
            f"{path}.limits.battery_capacity_kwh",
        ),
        max_charging_power_kw=_require_positive_float(
            limits.get("max_charging_power_kw"),
            f"{path}.limits.max_charging_power_kw",
        ),
    )


def _require_mapping(value: object, path: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise EvChargerConfigError(f"{path} must be an object")
    return value


def _require_non_empty_string(value: object, path: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise EvChargerConfigError(f"{path} must be a non-empty string")
    return value.strip()


def _require_positive_float(value: object, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise EvChargerConfigError(f"{path} must be a positive number")

    number = float(value)
    if number <= 0:
        raise EvChargerConfigError(f"{path} must be a positive number")
    return number


def _require_entity_id(value: object, *, expected_domain: str, path: str) -> str:
    entity_id = _require_non_empty_string(value, path)
    if not entity_id.startswith(f"{expected_domain}."):
        raise EvChargerConfigError(
            f"{path} must use {expected_domain!r} domain"
        )
    return entity_id


def _require_entity_id_in_domains(
    value: object,
    *,
    expected_domains: tuple[str, ...],
    path: str,
) -> str:
    entity_id = _require_non_empty_string(value, path)
    for domain in expected_domains:
        if entity_id.startswith(f"{domain}."):
            return entity_id

    formatted_domains = ", ".join(repr(domain) for domain in expected_domains)
    raise EvChargerConfigError(
        f"{path} must use one of {formatted_domains} domains"
    )
