from __future__ import annotations

from dataclasses import dataclass
from functools import partial
from typing import Literal, NotRequired, TypedDict

from ..controllables.kinds import CONTROLLABLE_KIND_EV_CHARGER
from ._read import (
    read_entity_id,
    read_kind,
    read_mapping,
    read_optional_icon,
    read_positive_float,
    read_required_string,
)
from .errors import ApplianceConfigError
from .icon import resolve_appliance_icon
from .roster import ControllableRosterFieldsDict, EntityReferenceDict

_FIXED_MAX_POWER_BEHAVIOR = "fixed_max_power"
_SURPLUS_AWARE_BEHAVIOR = "surplus_aware"
EvChargerUseModeBehavior = Literal["fixed_max_power", "surplus_aware"]

#: The charger's findings have always called a non-positive figure this.
_read_positive_float = partial(
    read_positive_float, not_positive_detail="must be a positive number"
)


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
        return CONTROLLABLE_KIND_EV_CHARGER

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


class EvChargerApplianceResponseDict(ControllableRosterFieldsDict):
    id: str
    name: str
    kind: str
    supportsAuthoring: bool
    metadata: EvChargerMetadataDict
    controls: ApplianceControlsDict
    vehicles: list[EvVehicleResponseDict]


def read_ev_charger_appliance(
    value: object,
    *,
    path: str,
) -> EvChargerApplianceRuntime:
    appliance = read_mapping(value, path=path)
    read_kind(appliance, path=path, kind=CONTROLLABLE_KIND_EV_CHARGER)

    vehicles = _read_vehicles(appliance.get("vehicles"), path=f"{path}.vehicles")
    controls = read_mapping(appliance.get("controls"), path=f"{path}.controls")
    use_mode_entity_id, use_mode_configs = _read_use_mode_control(
        controls.get("use_mode"),
        path=f"{path}.controls.use_mode",
    )
    eco_gear_entity_id, eco_gear_configs = _read_eco_gear_control(
        controls.get("eco_gear"),
        path=f"{path}.controls.eco_gear",
    )

    return EvChargerApplianceRuntime(
        id=read_required_string(appliance.get("id"), path=f"{path}.id"),
        name=read_required_string(appliance.get("name"), path=f"{path}.name"),
        max_charging_power_kw=_read_limits(
            appliance.get("limits"),
            path=f"{path}.limits",
        ),
        charge_entity_id=_read_control_entity_id(
            controls.get("charge"),
            allowed_domains=("switch",),
            path=f"{path}.controls.charge",
        ),
        use_mode_entity_id=use_mode_entity_id,
        eco_gear_entity_id=eco_gear_entity_id,
        use_mode_configs=use_mode_configs,
        eco_gear_configs=eco_gear_configs,
        vehicles=vehicles,
        icon=read_optional_icon(appliance.get("icon"), path=f"{path}.icon"),
    )


def build_ev_charger_metadata_dict(
    appliance: EvChargerApplianceRuntime,
    roster: ControllableRosterFieldsDict,
) -> EvChargerApplianceResponseDict:
    return {
        "id": appliance.id,
        "name": appliance.name,
        "kind": appliance.kind,
        **roster,
        "supportsAuthoring": True,
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
    limits = read_mapping(value, path=path)
    return _read_positive_float(
        limits.get("max_charging_power_kw"),
        path=f"{path}.max_charging_power_kw",
    )


def _read_control_entity_id(
    value: object,
    *,
    allowed_domains: tuple[str, ...],
    path: str,
) -> str:
    control = read_mapping(value, path=path)
    return _read_entity_id(
        control.get("entity_id"),
        allowed_domains=allowed_domains,
        path=f"{path}.entity_id",
    )


def _read_entity_id(
    value: object,
    *,
    allowed_domains: tuple[str, ...],
    path: str,
) -> str:
    """The charger's findings quote the domains, as they always have."""
    domains = ", ".join(repr(domain) for domain in allowed_domains)
    return read_entity_id(
        value,
        path=path,
        allowed_domains=allowed_domains,
        detail=(
            f"must use {domains} domain"
            if len(allowed_domains) == 1
            else f"must use one of {domains} domains"
        ),
    )


def _read_use_mode_control(
    value: object,
    *,
    path: str,
) -> tuple[str, tuple[EvChargerUseModeRuntime, ...]]:
    control = read_mapping(value, path=path)
    values = read_mapping(control.get("values"), path=f"{path}.values")
    if not values:
        raise ApplianceConfigError(f"{path}.values", "must not be empty")

    use_modes: list[EvChargerUseModeRuntime] = []
    for raw_mode_id, raw_mode_config in values.items():
        if not isinstance(raw_mode_id, str) or not raw_mode_id.strip():
            raise ApplianceConfigError(
                f"{path}.values", "keys must be a non-empty string"
            )
        mode_id = raw_mode_id.strip()
        mode_config = read_mapping(raw_mode_config, path=f"{path}.values.{mode_id}")
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
            allowed_domains=("input_select", "select"),
            path=path,
        ),
        tuple(use_modes),
    )


def _read_use_mode_behavior(
    value: object,
    *,
    path: str,
) -> EvChargerUseModeBehavior:
    behavior = read_required_string(value, path=path)
    if behavior not in {_FIXED_MAX_POWER_BEHAVIOR, _SURPLUS_AWARE_BEHAVIOR}:
        raise ApplianceConfigError(
            path,
            f"must be one of {_FIXED_MAX_POWER_BEHAVIOR!r}, "
            f"{_SURPLUS_AWARE_BEHAVIOR!r}",
        )
    return behavior


def _read_eco_gear_control(
    value: object,
    *,
    path: str,
) -> tuple[str, tuple[EvChargerEcoGearRuntime, ...]]:
    control = read_mapping(value, path=path)
    values = read_mapping(control.get("values"), path=f"{path}.values")
    if not values:
        raise ApplianceConfigError(f"{path}.values", "must not be empty")

    eco_gears: list[EvChargerEcoGearRuntime] = []
    for raw_gear_id, raw_gear_config in values.items():
        if not isinstance(raw_gear_id, str) or not raw_gear_id.strip():
            raise ApplianceConfigError(
                f"{path}.values", "keys must be a non-empty string"
            )
        gear_id = raw_gear_id.strip()
        gear_config = read_mapping(raw_gear_config, path=f"{path}.values.{gear_id}")
        eco_gears.append(
            EvChargerEcoGearRuntime(
                id=gear_id,
                min_power_kw=_read_positive_float(
                    gear_config.get("min_power_kw"),
                    path=f"{path}.values.{gear_id}.min_power_kw",
                ),
            )
        )

    return (
        _read_control_entity_id(
            control,
            allowed_domains=("input_select", "select"),
            path=path,
        ),
        tuple(eco_gears),
    )


def _read_vehicles(value: object, *, path: str) -> tuple[EvVehicleRuntime, ...]:
    if not isinstance(value, list) or not value:
        raise ApplianceConfigError(path, "must be a non-empty list")

    vehicles: list[EvVehicleRuntime] = []
    seen_vehicle_ids: set[str] = set()
    for index, raw_vehicle in enumerate(value):
        vehicle_path = f"{path}[{index}]"
        vehicle = _read_vehicle(raw_vehicle, path=vehicle_path)
        if vehicle.id in seen_vehicle_ids:
            raise ApplianceConfigError(
                f"{vehicle_path}.id",
                f"duplicates vehicle id {vehicle.id!r}",
            )
        seen_vehicle_ids.add(vehicle.id)
        vehicles.append(vehicle)

    return tuple(vehicles)


def _read_vehicle(value: object, *, path: str) -> EvVehicleRuntime:
    vehicle = read_mapping(value, path=path)
    telemetry = read_mapping(vehicle.get("telemetry"), path=f"{path}.telemetry")
    limits = read_mapping(vehicle.get("limits"), path=f"{path}.limits")

    charge_limit_entity_id = telemetry.get("charge_limit_entity_id")
    return EvVehicleRuntime(
        id=read_required_string(vehicle.get("id"), path=f"{path}.id"),
        name=read_required_string(vehicle.get("name"), path=f"{path}.name"),
        soc_entity_id=_read_entity_id(
            telemetry.get("soc_entity_id"),
            allowed_domains=("sensor",),
            path=f"{path}.telemetry.soc_entity_id",
        ),
        charge_limit_entity_id=(
            None
            if charge_limit_entity_id is None
            else _read_entity_id(
                charge_limit_entity_id,
                allowed_domains=("number",),
                path=f"{path}.telemetry.charge_limit_entity_id",
            )
        ),
        battery_capacity_kwh=_read_positive_float(
            limits.get("battery_capacity_kwh"),
            path=f"{path}.limits.battery_capacity_kwh",
        ),
        max_charging_power_kw=_read_positive_float(
            limits.get("max_charging_power_kw"),
            path=f"{path}.limits.max_charging_power_kw",
        ),
    )
