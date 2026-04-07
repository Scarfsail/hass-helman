from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal, TypedDict

_GENERIC_APPLIANCE_KIND = "generic"
_DEFAULT_HISTORY_LOOKBACK_DAYS = 30
_GENERIC_PROJECTION_STRATEGIES = {"fixed", "history_average"}

GenericProjectionStrategy = Literal["fixed", "history_average"]


class GenericApplianceConfigError(ValueError):
    """Raised when a generic appliance config is invalid."""


@dataclass(frozen=True)
class GenericApplianceRuntime:
    id: str
    name: str
    switch_entity_id: str
    projection_strategy: GenericProjectionStrategy
    hourly_energy_kwh: float
    history_energy_entity_id: str | None
    history_lookback_days: int = _DEFAULT_HISTORY_LOOKBACK_DAYS

    @property
    def kind(self) -> str:
        return _GENERIC_APPLIANCE_KIND

    @property
    def uses_history_average(self) -> bool:
        return (
            self.projection_strategy == "history_average"
            and self.history_energy_entity_id is not None
        )


class EntityReferenceDict(TypedDict):
    entityId: str


class GenericApplianceScheduleCapabilitiesDict(TypedDict):
    onOffToggle: bool


class GenericApplianceMetadataDict(TypedDict):
    scheduleCapabilities: GenericApplianceScheduleCapabilitiesDict


class GenericApplianceControlsDict(TypedDict):
    switch: EntityReferenceDict


class GenericApplianceResponseDict(TypedDict):
    id: str
    name: str
    kind: str
    metadata: GenericApplianceMetadataDict
    controls: GenericApplianceControlsDict


def build_generic_appliance_metadata_dict(
    appliance: GenericApplianceRuntime,
) -> GenericApplianceResponseDict:
    return {
        "id": appliance.id,
        "name": appliance.name,
        "kind": appliance.kind,
        "metadata": {
            "scheduleCapabilities": {
                "onOffToggle": True,
            }
        },
        "controls": {
            "switch": {"entityId": appliance.switch_entity_id},
        },
    }


def read_generic_appliance(
    value: object,
    *,
    path: str,
) -> GenericApplianceRuntime:
    if not isinstance(value, Mapping):
        raise GenericApplianceConfigError(f"{path} must be an object")

    kind = _read_required_string(value.get("kind"), path=f"{path}.kind")
    if kind != _GENERIC_APPLIANCE_KIND:
        raise GenericApplianceConfigError(
            f"{path}.kind must be {_GENERIC_APPLIANCE_KIND!r}"
        )

    appliance_id = _read_required_string(value.get("id"), path=f"{path}.id")
    name = _read_required_string(value.get("name"), path=f"{path}.name")

    controls = _read_mapping(value.get("controls"), path=f"{path}.controls")
    switch = _read_mapping(controls.get("switch"), path=f"{path}.controls.switch")
    switch_entity_id = _read_entity_id(
        switch.get("entity_id"),
        path=f"{path}.controls.switch.entity_id",
        allowed_domains=("switch",),
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
            raise GenericApplianceConfigError(
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

    return GenericApplianceRuntime(
        id=appliance_id,
        name=name,
        switch_entity_id=switch_entity_id,
        projection_strategy=projection_strategy,
        hourly_energy_kwh=hourly_energy_kwh,
        history_energy_entity_id=history_energy_entity_id,
        history_lookback_days=history_lookback_days,
    )


def _read_mapping(value: object, *, path: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise GenericApplianceConfigError(f"{path} must be an object")
    return {str(key): item for key, item in value.items()}


def _read_required_string(value: object, *, path: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise GenericApplianceConfigError(f"{path} must be a non-empty string")
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
        raise GenericApplianceConfigError(
            f"{path} must use one of the supported domains: {allowed}"
        )
    return entity_id


def _read_projection_strategy(value: object, *, path: str) -> GenericProjectionStrategy:
    strategy = _read_required_string(value, path=path)
    if strategy not in _GENERIC_PROJECTION_STRATEGIES:
        allowed = ", ".join(sorted(_GENERIC_PROJECTION_STRATEGIES))
        raise GenericApplianceConfigError(f"{path} must be one of {allowed}")
    return strategy


def _read_positive_float(value: object, *, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise GenericApplianceConfigError(f"{path} must be a positive number")
    parsed = float(value)
    if parsed <= 0:
        raise GenericApplianceConfigError(f"{path} must be greater than zero")
    return parsed


def _read_positive_int(value: object, *, path: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise GenericApplianceConfigError(f"{path} must be a positive integer")
    if value <= 0:
        raise GenericApplianceConfigError(f"{path} must be greater than zero")
    return value
