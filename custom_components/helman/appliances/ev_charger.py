from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, NotRequired, TypedDict

_EV_CHARGER_KIND = "ev_charger"
_FAST_MODE = "Fast"
_ECO_MODE = "ECO"
_FAST_BEHAVIOR = "fixed_power"
_ECO_BEHAVIOR = "surplus_aware"
_SUPPORTED_USE_MODES = (_FAST_MODE, _ECO_MODE)


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
class EvChargerApplianceRuntime:
    id: str
    name: str
    max_charging_power_kw: float
    charge_entity_id: str
    use_mode_entity_id: str
    eco_gear_entity_id: str
    eco_gear_min_power_kw: tuple[tuple[str, float], ...]
    vehicles: tuple[EvVehicleRuntime, ...]

    @property
    def kind(self) -> str:
        return _EV_CHARGER_KIND

    @property
    def use_modes(self) -> tuple[str, ...]:
        return _SUPPORTED_USE_MODES

    @property
    def eco_gears(self) -> tuple[str, ...]:
        return tuple(gear_name for gear_name, _ in self.eco_gear_min_power_kw)

    @property
    def vehicles_by_id(self) -> dict[str, EvVehicleRuntime]:
        return {vehicle.id: vehicle for vehicle in self.vehicles}

    @property
    def eco_gear_min_power_kw_by_id(self) -> dict[str, float]:
        return dict(self.eco_gear_min_power_kw)

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
    projection = _require_mapping(appliance.get("projection"), f"{path}.projection")

    return EvChargerApplianceRuntime(
        id=_require_non_empty_string(appliance.get("id"), f"{path}.id"),
        name=_require_non_empty_string(appliance.get("name"), f"{path}.name"),
        max_charging_power_kw=_read_appliance_metadata(
            appliance.get("metadata"),
            path=f"{path}.metadata",
        ),
        charge_entity_id=_read_control_entity_id(
            appliance.get("control"),
            field_name="charge_entity_id",
            expected_domain="switch",
            path=f"{path}.control",
        ),
        use_mode_entity_id=_read_control_entity_id(
            appliance.get("control"),
            field_name="use_mode_entity_id",
            expected_domain="select",
            path=f"{path}.control",
        ),
        eco_gear_entity_id=_read_control_entity_id(
            appliance.get("control"),
            field_name="eco_gear_entity_id",
            expected_domain="select",
            path=f"{path}.control",
        ),
        eco_gear_min_power_kw=_read_projection_modes(
            projection.get("modes"),
            path=f"{path}.projection.modes",
        ),
        vehicles=vehicles,
    )


def build_ev_charger_metadata_dict(
    appliance: EvChargerApplianceRuntime,
) -> EvChargerApplianceResponseDict:
    return {
        "id": appliance.id,
        "name": appliance.name,
        "kind": appliance.kind,
        "metadata": {
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


def _read_appliance_metadata(value: object, *, path: str) -> float:
    metadata = _require_mapping(value, path)
    return _require_positive_float(
        metadata.get("max_charging_power_kw"),
        f"{path}.max_charging_power_kw",
    )


def _read_control_entity_id(
    value: object,
    *,
    field_name: str,
    expected_domain: str,
    path: str,
) -> str:
    control = _require_mapping(value, path)
    return _require_entity_id(
        control.get(field_name),
        expected_domain=expected_domain,
        path=f"{path}.{field_name}",
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
    metadata = _require_mapping(vehicle.get("metadata"), f"{path}.metadata")

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
            metadata.get("battery_capacity_kwh"),
            f"{path}.metadata.battery_capacity_kwh",
        ),
        max_charging_power_kw=_require_positive_float(
            metadata.get("max_charging_power_kw"),
            f"{path}.metadata.max_charging_power_kw",
        ),
    )


def _read_projection_modes(
    value: object,
    *,
    path: str,
) -> tuple[tuple[str, float], ...]:
    modes = _require_mapping(value, path)

    fast = _require_mapping(modes.get(_FAST_MODE), f"{path}.{_FAST_MODE}")
    if fast.get("behavior") != _FAST_BEHAVIOR:
        raise EvChargerConfigError(
            f"{path}.{_FAST_MODE}.behavior must be {_FAST_BEHAVIOR!r}"
        )

    eco = _require_mapping(modes.get(_ECO_MODE), f"{path}.{_ECO_MODE}")
    if eco.get("behavior") != _ECO_BEHAVIOR:
        raise EvChargerConfigError(
            f"{path}.{_ECO_MODE}.behavior must be {_ECO_BEHAVIOR!r}"
        )

    eco_gear_map = _require_mapping(
        eco.get("eco_gear_min_power_kw"),
        f"{path}.{_ECO_MODE}.eco_gear_min_power_kw",
    )
    if not eco_gear_map:
        raise EvChargerConfigError(
            f"{path}.{_ECO_MODE}.eco_gear_min_power_kw must not be empty"
        )

    eco_gears: list[tuple[str, float]] = []
    for gear_name, gear_power in eco_gear_map.items():
        if not isinstance(gear_name, str) or not gear_name.strip():
            raise EvChargerConfigError(
                f"{path}.{_ECO_MODE}.eco_gear_min_power_kw keys must be non-empty strings"
            )
        eco_gears.append(
            (
                gear_name,
                _require_positive_float(
                    gear_power,
                    f"{path}.{_ECO_MODE}.eco_gear_min_power_kw.{gear_name}",
                ),
            )
        )

    return tuple(eco_gears)


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
