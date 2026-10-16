"""The one validator set every appliance config reader uses.

The generic, climate and EV charger readers each carried a private copy of
these, differing only in the error subclass they raised — and nothing ever
caught those subclasses apart. They now share one set raising
:class:`.errors.ApplianceConfigError`. Every message is the text the per-kind
copy produced, so a finding reads exactly as it did.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

from ..const import DEFAULT_HISTORY_LOOKBACK_DAYS
from .errors import ApplianceConfigError

ProjectionStrategy = Literal["fixed", "history_average"]
_PROJECTION_STRATEGIES = {"fixed", "history_average"}


@dataclass(frozen=True)
class ProjectionConfig:
    """How a constant-rate appliance's demand is projected while it runs.

    Read once from ``consumption`` by :func:`read_projection_config`, and
    carried by the generic and climate runtimes alike.
    """

    strategy: ProjectionStrategy
    hourly_energy_kwh: float
    history_energy_entity_id: str | None = None
    history_lookback_days: int = DEFAULT_HISTORY_LOOKBACK_DAYS

    @property
    def uses_history_average(self) -> bool:
        return (
            self.strategy == "history_average"
            and self.history_energy_entity_id is not None
        )


def read_mapping(value: object, *, path: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ApplianceConfigError(path, "must be an object")
    return value


def read_required_string(value: object, *, path: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ApplianceConfigError(path, "must be a non-empty string")
    return value.strip()


def read_optional_icon(value: object, *, path: str) -> str | None:
    if value is None:
        return None
    return read_required_string(value, path=path)


def read_entity_id(
    value: object,
    *,
    path: str,
    allowed_domains: tuple[str, ...],
    detail: str | None = None,
) -> str:
    """A non-empty ``domain.object_id`` in one of ``allowed_domains``.

    ``detail`` replaces the default refusal for a reader whose findings have
    always been worded differently.
    """
    entity_id = read_required_string(value, path=path)
    domain, separator, object_id = entity_id.partition(".")
    if not separator or not object_id or domain not in allowed_domains:
        allowed = ", ".join(sorted(allowed_domains))
        raise ApplianceConfigError(
            path,
            detail or f"must use one of the supported domains: {allowed}",
        )
    return entity_id


def read_positive_float(
    value: object,
    *,
    path: str,
    not_positive_detail: str = "must be greater than zero",
) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ApplianceConfigError(path, "must be a positive number")
    parsed = float(value)
    if parsed <= 0:
        raise ApplianceConfigError(path, not_positive_detail)
    return parsed


def read_positive_int(value: object, *, path: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ApplianceConfigError(path, "must be a positive integer")
    if value <= 0:
        raise ApplianceConfigError(path, "must be greater than zero")
    return value


def read_kind(value: Mapping[str, Any], *, path: str, kind: str) -> None:
    """Refuse a config entry handed to the reader of another kind."""
    if read_required_string(value.get("kind"), path=f"{path}.kind") != kind:
        raise ApplianceConfigError(f"{path}.kind", f"must be {kind!r}")


def read_projection_config(
    value: Mapping[str, Any],
    *,
    path: str,
) -> ProjectionConfig:
    """``consumption.projection`` of the appliance config at ``path``."""
    consumption = read_mapping(value.get("consumption"), path=f"{path}.consumption")
    projection = read_mapping(
        consumption.get("projection"), path=f"{path}.consumption.projection"
    )
    strategy = read_required_string(
        projection.get("strategy"),
        path=f"{path}.consumption.projection.strategy",
    )
    if strategy not in _PROJECTION_STRATEGIES:
        allowed = ", ".join(sorted(_PROJECTION_STRATEGIES))
        raise ApplianceConfigError(
            f"{path}.consumption.projection.strategy", f"must be one of {allowed}"
        )
    hourly_energy_kwh = read_positive_float(
        projection.get("hourly_energy_kwh"),
        path=f"{path}.consumption.projection.hourly_energy_kwh",
    )
    if strategy != "history_average":
        return ProjectionConfig(strategy=strategy, hourly_energy_kwh=hourly_energy_kwh)
    return ProjectionConfig(
        strategy=strategy,
        hourly_energy_kwh=hourly_energy_kwh,
        history_energy_entity_id=read_entity_id(
            consumption.get("energy_entity_id"),
            path=f"{path}.consumption.energy_entity_id",
            allowed_domains=("sensor",),
        ),
        history_lookback_days=read_positive_int(
            projection.get("lookback_days", DEFAULT_HISTORY_LOOKBACK_DAYS),
            path=f"{path}.consumption.projection.lookback_days",
        ),
    )
