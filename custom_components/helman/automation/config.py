from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from ..appliances.climate_appliance import SUPPORTED_CLIMATE_MODES
from .optimizer import KNOWN_OPTIMIZER_KINDS

_MISSING = object()
_EXPORT_PRICE_OPTIMIZER_KIND = "export_price"
_SURPLUS_APPLIANCE_OPTIMIZER_KIND = "surplus_appliance"


class AutomationConfigError(ValueError):
    """Raised when the automation config block is invalid."""

    def __init__(self, *, path: str, code: str, message: str) -> None:
        super().__init__(message)
        self.path = path
        self.code = code


@dataclass(frozen=True)
class OptimizerInstanceConfig:
    id: str
    kind: str
    enabled: bool = True
    params: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AutomationConfig:
    enabled: bool = True
    optimizers: tuple[OptimizerInstanceConfig, ...] = ()
    execution_optimizers: tuple[OptimizerInstanceConfig, ...] = ()

    @classmethod
    def from_dict(
        cls,
        value: object,
        *,
        path: str = "automation",
    ) -> AutomationConfig:
        data = _read_mapping(value, path=path)
        enabled = _read_bool(
            data.get("enabled", True),
            path=f"{path}.enabled",
        )
        optimizers = _read_optimizers(
            data.get("optimizers", _MISSING),
            path=f"{path}.optimizers",
        )
        execution_optimizers = (
            ()
            if not enabled
            else tuple(optimizer for optimizer in optimizers if optimizer.enabled)
        )
        return cls(
            enabled=enabled,
            optimizers=optimizers,
            execution_optimizers=execution_optimizers,
        )


def read_automation_config(
    config: Mapping[str, Any] | None,
) -> AutomationConfig | None:
    if config is None or not isinstance(config, Mapping):
        return None
    if "automation" not in config:
        return None
    return AutomationConfig.from_dict(config["automation"])


def _read_optimizers(
    value: object,
    *,
    path: str,
) -> tuple[OptimizerInstanceConfig, ...]:
    if value is _MISSING:
        return ()
    if not isinstance(value, list):
        _raise_config_error(
            path=path,
            code="invalid_type",
            message=f"{path} must be a list",
        )

    seen_ids: set[str] = set()
    optimizers: list[OptimizerInstanceConfig] = []
    for index, raw_optimizer in enumerate(value):
        optimizer = _read_optimizer(
            raw_optimizer,
            path=f"{path}[{index}]",
        )
        if optimizer.id in seen_ids:
            _raise_config_error(
                path=f"{path}[{index}].id",
                code="duplicate_optimizer_id",
                message=f"duplicate optimizer id {optimizer.id!r}",
            )
        seen_ids.add(optimizer.id)
        optimizers.append(optimizer)
    return tuple(optimizers)


def _read_optimizer(
    value: object,
    *,
    path: str,
) -> OptimizerInstanceConfig:
    data = _read_mapping(value, path=path)
    optimizer_id = _read_non_empty_string(
        data.get("id", _MISSING),
        path=f"{path}.id",
    )
    kind = _read_non_empty_string(
        data.get("kind", _MISSING),
        path=f"{path}.kind",
    )
    if kind not in KNOWN_OPTIMIZER_KINDS:
        if not KNOWN_OPTIMIZER_KINDS:
            message = (
                f"{path}.kind {kind!r} is unknown; no optimizer kinds are supported "
                "in this phase"
            )
        else:
            supported_kinds = ", ".join(sorted(KNOWN_OPTIMIZER_KINDS))
            message = (
                f"{path}.kind {kind!r} is unknown; supported optimizer kinds are: "
                f"{supported_kinds}"
            )
        _raise_config_error(
            path=f"{path}.kind",
            code="unknown_optimizer_kind",
            message=message,
        )
    enabled = _read_bool(
        data.get("enabled", True),
        path=f"{path}.enabled",
    )
    params = _read_optimizer_params(
        data.get("params", _MISSING),
        kind=kind,
        path=f"{path}.params",
    )
    return OptimizerInstanceConfig(
        id=optimizer_id,
        kind=kind,
        enabled=enabled,
        params=params,
    )


def _read_optimizer_params(
    value: object,
    *,
    kind: str,
    path: str,
) -> dict[str, Any]:
    if kind == _EXPORT_PRICE_OPTIMIZER_KIND:
        return _read_export_price_params(value, path=path)
    if kind == _SURPLUS_APPLIANCE_OPTIMIZER_KIND:
        return _read_surplus_appliance_params(value, path=path)
    return _read_params(value, path=path)


def _read_export_price_params(
    value: object,
    *,
    path: str,
) -> dict[str, Any]:
    data = _read_mapping({} if value is _MISSING else value, path=path)
    return {
        "when_price_below": _read_float(
            data.get("when_price_below", 0.0),
            path=f"{path}.when_price_below",
        ),
        "action": _read_export_price_action(
            data.get("action", "stop_export"),
            path=f"{path}.action",
        ),
    }


def _read_surplus_appliance_params(
    value: object,
    *,
    path: str,
) -> dict[str, Any]:
    data = _read_mapping({} if value is _MISSING else value, path=path)
    return {
        "appliance_id": _read_non_empty_string(
            data.get("appliance_id", _MISSING),
            path=f"{path}.appliance_id",
        ),
        "action": _read_surplus_appliance_action(
            data.get("action", "on"),
            path=f"{path}.action",
        ),
        "climate_mode": _read_optional_surplus_climate_mode(
            data.get("climate_mode"),
            path=f"{path}.climate_mode",
        ),
        "min_surplus_buffer_pct": _read_non_negative_int(
            data.get("min_surplus_buffer_pct", 5),
            path=f"{path}.min_surplus_buffer_pct",
        ),
    }


def _read_mapping(
    value: object,
    *,
    path: str,
) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        _raise_config_error(
            path=path,
            code="invalid_type",
            message=f"{path} must be an object",
        )
    return {str(key): item for key, item in value.items()}


def _read_non_empty_string(
    value: object,
    *,
    path: str,
) -> str:
    if value is _MISSING:
        _raise_config_error(
            path=path,
            code="required",
            message=f"{path} must be a non-empty string",
        )
    if not isinstance(value, str) or not value.strip():
        _raise_config_error(
            path=path,
            code="invalid_type",
            message=f"{path} must be a non-empty string",
        )
    return value.strip()


def _read_bool(
    value: object,
    *,
    path: str,
) -> bool:
    if not isinstance(value, bool):
        _raise_config_error(
            path=path,
            code="invalid_type",
            message=f"{path} must be a boolean",
        )
    return value


def _read_params(
    value: object,
    *,
    path: str,
) -> dict[str, Any]:
    if value is _MISSING:
        return {}
    if not isinstance(value, Mapping):
        _raise_config_error(
            path=path,
            code="invalid_type",
            message=f"{path} must be an object",
        )
    return {str(key): item for key, item in value.items()}


def _read_float(
    value: object,
    *,
    path: str,
) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _raise_config_error(
            path=path,
            code="invalid_type",
            message=f"{path} must be a number",
        )
    return float(value)


def _read_export_price_action(
    value: object,
    *,
    path: str,
) -> str:
    action = _read_non_empty_string(value, path=path)
    if action != "stop_export":
        _raise_config_error(
            path=path,
            code="invalid_value",
            message=f"{path} must be 'stop_export'",
        )
    return action


def _read_surplus_appliance_action(
    value: object,
    *,
    path: str,
) -> str:
    action = _read_non_empty_string(value, path=path)
    if action != "on":
        _raise_config_error(
            path=path,
            code="invalid_value",
            message=f"{path} must be 'on'",
        )
    return action


def _read_optional_surplus_climate_mode(
    value: object,
    *,
    path: str,
) -> str | None:
    if value is None:
        return None
    climate_mode = _read_non_empty_string(value, path=path)
    if climate_mode not in SUPPORTED_CLIMATE_MODES:
        _raise_config_error(
            path=path,
            code="invalid_value",
            message=(
                f"{path} must be one of {', '.join(SUPPORTED_CLIMATE_MODES)}"
            ),
        )
    return climate_mode


def _read_non_negative_int(
    value: object,
    *,
    path: str,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        _raise_config_error(
            path=path,
            code="invalid_type",
            message=f"{path} must be an integer",
        )
    if value < 0:
        _raise_config_error(
            path=path,
            code="invalid_value",
            message=f"{path} must be >= 0",
        )
    return value


def _raise_config_error(
    *,
    path: str,
    code: str,
    message: str,
) -> None:
    raise AutomationConfigError(path=path, code=code, message=message)
