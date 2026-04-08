from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Literal, TypedDict

from .icon import read_optional_appliance_icon, resolve_appliance_icon

_CLIMATE_APPLIANCE_KIND = "climate"
_DEFAULT_HISTORY_LOOKBACK_DAYS = 30
_CLIMATE_PROJECTION_STRATEGIES = {"fixed", "history_average"}
_DEFAULT_CLIMATE_STOP_HVAC_MODE = "off"

ClimateApplianceMode = Literal["heat", "cool"]
ClimateProjectionStrategy = Literal["fixed", "history_average"]
SUPPORTED_CLIMATE_MODES: tuple[ClimateApplianceMode, ...] = ("heat", "cool")


class ClimateApplianceConfigError(ValueError):
    """Raised when a climate appliance config is invalid."""


@dataclass(frozen=True)
class ClimateApplianceRuntime:
    id: str
    name: str
    climate_entity_id: str
    projection_strategy: ClimateProjectionStrategy
    hourly_energy_kwh: float
    history_energy_entity_id: str | None
    history_lookback_days: int = _DEFAULT_HISTORY_LOOKBACK_DAYS
    icon: str | None = None
    supported_modes: tuple[ClimateApplianceMode, ...] = SUPPORTED_CLIMATE_MODES
    stop_hvac_mode: str | None = _DEFAULT_CLIMATE_STOP_HVAC_MODE

    @property
    def kind(self) -> str:
        return _CLIMATE_APPLIANCE_KIND

    @property
    def uses_history_average(self) -> bool:
        return (
            self.projection_strategy == "history_average"
            and self.history_energy_entity_id is not None
        )

    @property
    def authorable_modes(self) -> tuple[ClimateApplianceMode, ...]:
        if self.stop_hvac_mode is None:
            return ()
        return self.supported_modes


class EntityReferenceDict(TypedDict):
    entityId: str


class ClimateApplianceScheduleCapabilitiesDict(TypedDict):
    modes: list[ClimateApplianceMode]


class ClimateApplianceMetadataDict(TypedDict):
    icon: str
    scheduleCapabilities: ClimateApplianceScheduleCapabilitiesDict


class ClimateApplianceControlsDict(TypedDict):
    climate: EntityReferenceDict


class ClimateApplianceResponseDict(TypedDict):
    id: str
    name: str
    kind: str
    metadata: ClimateApplianceMetadataDict
    controls: ClimateApplianceControlsDict


def build_climate_appliance_metadata_dict(
    appliance: ClimateApplianceRuntime,
) -> ClimateApplianceResponseDict:
    return {
        "id": appliance.id,
        "name": appliance.name,
        "kind": appliance.kind,
        "metadata": {
            "icon": resolve_appliance_icon(appliance.icon),
            "scheduleCapabilities": {
                "modes": list(appliance.authorable_modes),
            },
        },
        "controls": {
            "climate": {"entityId": appliance.climate_entity_id},
        },
    }


def read_climate_appliance(
    value: object,
    *,
    path: str,
) -> ClimateApplianceRuntime:
    if not isinstance(value, Mapping):
        raise ClimateApplianceConfigError(f"{path} must be an object")

    kind = _read_required_string(value.get("kind"), path=f"{path}.kind")
    if kind != _CLIMATE_APPLIANCE_KIND:
        raise ClimateApplianceConfigError(
            f"{path}.kind must be {_CLIMATE_APPLIANCE_KIND!r}"
        )

    appliance_id = _read_required_string(value.get("id"), path=f"{path}.id")
    name = _read_required_string(value.get("name"), path=f"{path}.name")

    controls = _read_mapping(value.get("controls"), path=f"{path}.controls")
    climate = _read_mapping(controls.get("climate"), path=f"{path}.controls.climate")
    climate_entity_id = _read_entity_id(
        climate.get("entity_id"),
        path=f"{path}.controls.climate.entity_id",
        allowed_domains=("climate",),
    )

    projection = _read_mapping(value.get("projection"), path=f"{path}.projection")
    projection_strategy = _read_projection_strategy(
        projection.get("strategy"),
        path=f"{path}.projection.strategy",
    )
    hourly_energy_kwh = _read_positive_float(
        projection.get("hourly_energy_kwh"),
        path=f"{path}.projection.hourly_energy_kwh",
    )

    history_energy_entity_id = None
    history_lookback_days = _DEFAULT_HISTORY_LOOKBACK_DAYS
    raw_history_average = projection.get("history_average")
    if projection_strategy == "history_average":
        if raw_history_average is None:
            raise ClimateApplianceConfigError(
                f"{path}.projection.history_average is required when strategy is "
                "'history_average'"
            )
        history_average = _read_mapping(
            raw_history_average,
            path=f"{path}.projection.history_average",
        )
        history_energy_entity_id = _read_entity_id(
            history_average.get("energy_entity_id"),
            path=f"{path}.projection.history_average.energy_entity_id",
            allowed_domains=("sensor",),
        )
        history_lookback_days = _read_positive_int(
            history_average.get("lookback_days", _DEFAULT_HISTORY_LOOKBACK_DAYS),
            path=f"{path}.projection.history_average.lookback_days",
        )

    return ClimateApplianceRuntime(
        id=appliance_id,
        name=name,
        climate_entity_id=climate_entity_id,
        projection_strategy=projection_strategy,
        hourly_energy_kwh=hourly_energy_kwh,
        history_energy_entity_id=history_energy_entity_id,
        history_lookback_days=history_lookback_days,
        icon=read_optional_appliance_icon(
            value.get("icon"),
            path=f"{path}.icon",
            error_type=ClimateApplianceConfigError,
        ),
    )


def _read_mapping(value: object, *, path: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ClimateApplianceConfigError(f"{path} must be an object")
    return {str(key): item for key, item in value.items()}


def _read_required_string(value: object, *, path: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ClimateApplianceConfigError(f"{path} must be a non-empty string")
    return value.strip()


def _read_entity_id(
    value: object,
    *,
    path: str,
    allowed_domains: tuple[str, ...],
) -> str:
    entity_id = _read_required_string(value, path=path)
    domain, separator, object_id = entity_id.partition(".")
    if not separator or not object_id or domain not in allowed_domains:
        allowed = ", ".join(sorted(allowed_domains))
        raise ClimateApplianceConfigError(
            f"{path} must use one of the supported domains: {allowed}"
        )
    return entity_id


def _read_projection_strategy(value: object, *, path: str) -> ClimateProjectionStrategy:
    strategy = _read_required_string(value, path=path)
    if strategy not in _CLIMATE_PROJECTION_STRATEGIES:
        allowed = ", ".join(sorted(_CLIMATE_PROJECTION_STRATEGIES))
        raise ClimateApplianceConfigError(f"{path} must be one of {allowed}")
    return strategy


def _read_positive_float(value: object, *, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ClimateApplianceConfigError(f"{path} must be a positive number")
    parsed = float(value)
    if parsed <= 0:
        raise ClimateApplianceConfigError(f"{path} must be greater than zero")
    return parsed


def _read_positive_int(value: object, *, path: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ClimateApplianceConfigError(f"{path} must be a positive integer")
    if value <= 0:
        raise ClimateApplianceConfigError(f"{path} must be greater than zero")
    return value


def resolve_supported_climate_modes(
    available_hvac_modes: Iterable[str],
) -> tuple[ClimateApplianceMode, ...]:
    available_modes = set()
    for raw_mode in available_hvac_modes:
        stripped = raw_mode.strip()
        if stripped:
            available_modes.add(stripped)
    return tuple(mode for mode in SUPPORTED_CLIMATE_MODES if mode in available_modes)
