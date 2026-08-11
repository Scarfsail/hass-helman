from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from ..const import (
    DAY_CONTEXT_DEFAULT_DEFICIT_BELOW_RATIO,
    DAY_CONTEXT_DEFAULT_SURPLUS_ABOVE_RATIO,
)
from .fields import (
    MISSING,
    AutomationConfigError,
    OptimizerConfigError,
    merge_params,
    read_fields,
)
from .spec import KNOWN_OPTIMIZER_KINDS, OPTIMIZER_SPECS, OptimizerSpec

__all__ = [
    "AutomationConfig",
    "AutomationConfigError",
    "ConditionGroup",
    "DayContextConfig",
    "OptimizerConfigError",
    "OptimizerInstanceConfig",
    "read_automation_config",
]

#: Keys that moved in the conditions unification. Reintroducing one by hand must
#: fail loudly naming where the value lives now, rather than being silently
#: discarded — see `validate_config_document`, which enforces the same rules on
#: the save path.
RELOCATED_OPTIMIZER_KEYS: dict[str, str] = {
    "condition": "conditions[0].custom",
    "only_on_days": "conditions[].run_when",
    "when_price_below": "conditions[].when_price_below",
    "min_surplus_buffer_pct": "nothing — the surplus buffer condition was retired",
    "reserve_floor_soc": "conditions[].reserve_floor_soc",
    "min_hours_per_day": "params.daily_minimum.min_hours_per_day",
    "max_consecutive_skips": "params.daily_minimum.max_consecutive_skips",
    "appliance_id": "target.controllable_id",
    "climate_mode": "target.climate_mode",
    "skip": "params.daily_minimum.max_consecutive_skips and conditions[].run_when",
    "action": "nothing — the optimizer kind implies its action",
    "hold_action": "nothing — the optimizer kind implies its action",
    "release": "nothing — the release slot is computed per day, never configured",
}

#: Kinds the merge retired, and what to write instead. The loader migrates these
#: automatically; a hand-edited document reaches the reader unmigrated, so name
#: the replacement rather than listing every supported kind and leaving the user
#: to guess which one absorbed theirs.
RETIRED_OPTIMIZER_KINDS: dict[str, str] = {
    "daily_runtime": "appliance_runtime",
    "surplus_appliance": (
        "appliance_runtime without params.daily_minimum, and a condition "
        "(min_soc_pct) or a window in place of the retired surplus buffer"
    ),
}

_OPTIMIZER_KEYS = frozenset({"id", "kind", "enabled", "target", "params", "conditions"})
_GROUP_RESERVED_KEYS = frozenset({"name", "params", "custom"})


@dataclass(frozen=True)
class ConditionGroup:
    """One ORed group: system conditions AND ``custom``, over overridden params."""

    index: int
    #: Optional label, shown by the inspector in place of the index.
    name: str | None
    #: Declared system condition values, keyed by condition type.
    condition_values: dict[str, Any]
    #: Master params merged with this group's override, fully validated.
    params: dict[str, Any]
    #: The override as authored, so the editor can tell "set" from "inherited".
    params_override: dict[str, Any]
    #: Home Assistant conditions, ANDed. Validated by HA at evaluation time.
    custom: tuple[dict[str, Any], ...]


@dataclass(frozen=True)
class OptimizerInstanceConfig:
    id: str
    kind: str
    enabled: bool = True
    #: Identity — what the optimizer acts on. Never overridable by a group, so
    #: the inspector can say what it acts on without knowing which group matched.
    target: dict[str, Any] = field(default_factory=dict)
    #: Master defaults; a group may override any key, merged one level deep.
    params: dict[str, Any] = field(default_factory=dict)
    #: ORed, evaluated first to last. Always at least one.
    conditions: tuple[ConditionGroup, ...] = ()

    @property
    def spec(self) -> OptimizerSpec:
        return OPTIMIZER_SPECS[self.kind]

    @property
    def controllable_id(self) -> str:
        """What this optimizer acts on, as a plain controllable id.

        Every kind names it the same way now: ``target.controllable_id``, with
        the reserved ``inverter`` id defaulted in by the spec for the kinds that
        used to imply their target from their own ``kind``. This is the identity
        validation resolves and the editor picks — one lookup, no by-kind
        fallback.

        It is also the identity of the *schedule lane* this optimizer writes,
        which is why the trace, the explanation book and the frontend's lane key
        are all the same string. They were not, until the schedule flattened to
        one id-keyed map: a separate ``target_key`` derived ``"appliance:<id>"``
        from this id, because the schedule had two domains to tell apart. With
        one map there is nothing left to disambiguate, so the derived key is
        gone and the id is the whole identity.
        """
        return str(self.target.get("controllable_id", ""))


@dataclass(frozen=True)
class DayContextConfig:
    deficit_below_ratio: float = DAY_CONTEXT_DEFAULT_DEFICIT_BELOW_RATIO
    surplus_above_ratio: float = DAY_CONTEXT_DEFAULT_SURPLUS_ABOVE_RATIO


@dataclass(frozen=True)
class AutomationConfig:
    enabled: bool = True
    optimizers: tuple[OptimizerInstanceConfig, ...] = ()
    execution_optimizers: tuple[OptimizerInstanceConfig, ...] = ()
    day_context: DayContextConfig = field(default_factory=DayContextConfig)

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
            data.get("optimizers", MISSING),
            path=f"{path}.optimizers",
        )
        day_context = _read_day_context(
            data.get("day_context", MISSING),
            path=f"{path}.day_context",
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
            day_context=day_context,
        )


def read_automation_config(
    config: Mapping[str, Any] | None,
) -> AutomationConfig | None:
    if config is None or not isinstance(config, Mapping):
        return None
    if "automation" not in config:
        return None
    return AutomationConfig.from_dict(config["automation"])


def _read_day_context(
    value: object,
    *,
    path: str,
) -> DayContextConfig:
    if value is MISSING:
        return DayContextConfig()
    data = _read_mapping(value, path=path)
    deficit_below_ratio = _read_float(
        data.get("deficit_below_ratio", DAY_CONTEXT_DEFAULT_DEFICIT_BELOW_RATIO),
        path=f"{path}.deficit_below_ratio",
    )
    surplus_above_ratio = _read_float(
        data.get("surplus_above_ratio", DAY_CONTEXT_DEFAULT_SURPLUS_ABOVE_RATIO),
        path=f"{path}.surplus_above_ratio",
    )
    if deficit_below_ratio >= surplus_above_ratio:
        raise AutomationConfigError(
            path=path,
            code="invalid_value",
            message=(
                f"{path}.deficit_below_ratio must be less than "
                f"{path}.surplus_above_ratio"
            ),
        )
    return DayContextConfig(
        deficit_below_ratio=deficit_below_ratio,
        surplus_above_ratio=surplus_above_ratio,
    )


def _read_optimizers(
    value: object,
    *,
    path: str,
) -> tuple[OptimizerInstanceConfig, ...]:
    if value is MISSING:
        return ()
    if not isinstance(value, list):
        raise AutomationConfigError(
            path=path,
            code="invalid_type",
            message=f"{path} must be a list",
        )

    seen_ids: set[str] = set()
    optimizers: list[OptimizerInstanceConfig] = []
    for index, raw_optimizer in enumerate(value):
        optimizer = _read_optimizer(raw_optimizer, path=f"{path}[{index}]")
        if optimizer.id in seen_ids:
            raise AutomationConfigError(
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
    optimizer_id = _read_non_empty_string(data.get("id", MISSING), path=f"{path}.id")
    kind = _read_non_empty_string(data.get("kind", MISSING), path=f"{path}.kind")
    if kind in RETIRED_OPTIMIZER_KINDS:
        raise AutomationConfigError(
            path=f"{path}.kind",
            code="retired_optimizer_kind",
            message=(
                f"{path}.kind {kind!r} was retired; use "
                f"{RETIRED_OPTIMIZER_KINDS[kind]}"
            ),
        )
    if kind not in KNOWN_OPTIMIZER_KINDS:
        raise AutomationConfigError(
            path=f"{path}.kind",
            code="unknown_optimizer_kind",
            message=(
                f"{path}.kind {kind!r} is unknown; supported optimizer kinds are: "
                f"{', '.join(sorted(KNOWN_OPTIMIZER_KINDS))}"
            ),
        )
    _reject_unknown_keys(data, allowed=_OPTIMIZER_KEYS, path=path)

    spec = OPTIMIZER_SPECS[kind]
    enabled = _read_bool(data.get("enabled", True), path=f"{path}.enabled")
    target = read_fields(spec.target, data.get("target", MISSING), path=f"{path}.target")
    raw_params = data.get("params", MISSING)
    params = read_fields(spec.params, raw_params, path=f"{path}.params")
    if spec.validate is not None:
        spec.validate(params, None, path=f"{path}.params")

    return OptimizerInstanceConfig(
        id=optimizer_id,
        kind=kind,
        enabled=enabled,
        target=target,
        params=params,
        conditions=_read_condition_groups(
            data.get("conditions", MISSING),
            spec=spec,
            raw_master_params=raw_params,
            path=f"{path}.conditions",
        ),
    )


def _read_condition_groups(
    value: object,
    *,
    spec: OptimizerSpec,
    raw_master_params: object,
    path: str,
) -> tuple[ConditionGroup, ...]:
    if value is MISSING or value is None or value == []:
        raise AutomationConfigError(
            path=path,
            code="required",
            message=f"{path} must list at least one condition group",
        )
    if not isinstance(value, list):
        raise AutomationConfigError(
            path=path,
            code="invalid_type",
            message=f"{path} must be a list of condition groups",
        )
    return tuple(
        _read_condition_group(
            raw_group,
            index=index,
            spec=spec,
            raw_master_params=raw_master_params,
            path=f"{path}[{index}]",
        )
        for index, raw_group in enumerate(value)
    )


def _read_condition_group(
    value: object,
    *,
    index: int,
    spec: OptimizerSpec,
    raw_master_params: object,
    path: str,
) -> ConditionGroup:
    data = _read_mapping(value, path=path)
    if "target" in data:
        raise AutomationConfigError(
            path=f"{path}.target",
            code="invalid_value",
            message=f"{path}.target is not allowed; target is never overridable",
        )
    _reject_unknown_keys(
        data,
        allowed=_GROUP_RESERVED_KEYS | set(spec.condition_types),
        path=path,
    )

    condition_values = read_fields(
        tuple(condition.field for condition in spec.condition_type_list),
        {key: data[key] for key in spec.condition_types if key in data},
        path=path,
    )

    # Validate the override on its own so type and unknown-key errors point at
    # the group the user edited, then re-read the merged result so required-ness
    # and cross-field checks run against the params the group actually resolves.
    raw_override = data.get("params", MISSING)
    params_override = read_fields(
        spec.params, raw_override, path=f"{path}.params", partial=True
    )
    resolved = read_fields(
        spec.params,
        merge_params(
            raw_master_params if isinstance(raw_master_params, Mapping) else {},
            raw_override if isinstance(raw_override, Mapping) else {},
        ),
        path=f"{path}.params",
    )
    if spec.validate is not None:
        spec.validate(resolved, condition_values, path=f"{path}.params")

    return ConditionGroup(
        index=index,
        name=(
            None
            if data.get("name") is None
            else _read_non_empty_string(data.get("name"), path=f"{path}.name")
        ),
        condition_values=condition_values,
        params=resolved,
        params_override=params_override,
        custom=_read_custom(data.get("custom", MISSING), path=f"{path}.custom"),
    )


def _read_custom(
    value: object,
    *,
    path: str,
) -> tuple[dict[str, Any], ...]:
    """Read a group's Home Assistant conditions. Only the outer shape is checked;
    HA validates the condition schema itself at evaluation time."""
    if value is MISSING or value is None:
        return ()
    if not isinstance(value, list):
        raise AutomationConfigError(
            path=path,
            code="invalid_type",
            message=f"{path} must be a list of conditions",
        )
    conditions: list[dict[str, Any]] = []
    for index, item in enumerate(value):
        if not isinstance(item, Mapping):
            raise AutomationConfigError(
                path=f"{path}[{index}]",
                code="invalid_type",
                message=f"{path}[{index}] must be an object",
            )
        conditions.append({str(key): entry for key, entry in item.items()})
    return tuple(conditions)


def _reject_unknown_keys(
    data: Mapping[str, Any],
    *,
    allowed: frozenset[str] | set[str],
    path: str,
) -> None:
    for key in data:
        if key in allowed:
            continue
        relocated = RELOCATED_OPTIMIZER_KEYS.get(key)
        raise AutomationConfigError(
            path=f"{path}.{key}",
            code="invalid_value" if relocated else "unknown_key",
            message=(
                f"{path}.{key} moved to {relocated}"
                if relocated
                else f"{path}.{key} is not a valid key"
            ),
        )


def _read_mapping(value: object, *, path: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise AutomationConfigError(
            path=path,
            code="invalid_type",
            message=f"{path} must be an object",
        )
    return {str(key): item for key, item in value.items()}


def _read_non_empty_string(value: object, *, path: str) -> str:
    if value is MISSING:
        raise AutomationConfigError(
            path=path,
            code="required",
            message=f"{path} must be a non-empty string",
        )
    if not isinstance(value, str) or not value.strip():
        raise AutomationConfigError(
            path=path,
            code="invalid_type",
            message=f"{path} must be a non-empty string",
        )
    return value.strip()


def _read_bool(value: object, *, path: str) -> bool:
    if not isinstance(value, bool):
        raise AutomationConfigError(
            path=path,
            code="invalid_type",
            message=f"{path} must be a boolean",
        )
    return value


def _read_float(value: object, *, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AutomationConfigError(
            path=path,
            code="invalid_type",
            message=f"{path} must be a number",
        )
    return float(value)
