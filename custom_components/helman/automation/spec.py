"""What each optimizer kind accepts — one declaration per kind, read by everyone.

The config reader, the config validator and the schema served to the visual
editor all walk this registry, so "what the editor lets you build" and "what the
reader accepts" cannot drift. Adding a sixth kind is an entry here plus its
decision logic; it is a *declaration*, not five parallel implementations.

The registry exists because five concrete kinds were duplicating the same ten
helpers — it is extracted from real duplication. No plugin loading, no dynamic
registration, no user-defined condition types.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from ..appliances.climate_appliance import SUPPORTED_CLIMATE_MODES
from . import fields as F
from .conditions.types import CONDITION_TYPES, ConditionType, Scope
from .fields import Field, OptimizerConfigError

WRITE_MODE_APPEND = "append"
WRITE_MODE_REPAINT = "repaint"


@dataclass(frozen=True)
class OptimizerSpec:
    """The config surface and write behaviour of one optimizer kind."""

    kind: str
    #: Identity — what this optimizer acts on. Never overridable by a group.
    target: tuple[Field, ...] = ()
    #: Master defaults. Every key is overridable per condition group.
    params: tuple[Field, ...] = ()
    #: Condition types this kind accepts, in the order the editor offers them.
    condition_types: tuple[str, ...] = ()
    #: Whether the optimizer adds to its domain or fully repaints it each run.
    write_mode: str = WRITE_MODE_APPEND
    #: The granularity at which this kind resolves params — see R2 below.
    param_scope: Scope = Scope.SLOT
    #: Cross-field checks over *resolved* params (master merged with a group's
    #: override), so a group cannot produce a combination no single pass sees.
    validate: Callable[..., None] | None = None
    #: What "Add <kind>" seeds in the editor. Lives beside the schema so adding
    #: a kind stays one Python declaration — required fields have no schema
    #: default to fall back on, and a blank window helps nobody.
    new_draft: dict[str, Any] = field(default_factory=dict)
    condition_type_list: tuple[ConditionType, ...] = field(init=False)

    def __post_init__(self) -> None:
        types = tuple(CONDITION_TYPES[key] for key in self.condition_types)
        object.__setattr__(self, "condition_type_list", types)
        # R2 — a kind may not combine SLOT-scope conditions with day- or
        # band-scoped params. Group resolution is per slot, but charge_hold
        # resolves one release slot per *day* and charge_from_grid sizes one
        # target per *band*; that is only coherent while every slot in a day
        # resolves to the same group. Violating it is a chicken-and-egg that is
        # cheap to check here and expensive to discover at runtime.
        if self.param_scope is not Scope.SLOT and any(
            condition.scope is Scope.SLOT and not condition.self_gating
            for condition in types
        ):
            raise AssertionError(
                f"optimizer kind {self.kind!r} resolves params per "
                f"{self.param_scope.value} but accepts a slot-scoped condition"
            )

    def field_paths(self) -> tuple[str, ...]:
        """Every declared key, for the old-shape rejection rules on save."""
        return tuple(f.key for f in self.target + self.params) + self.condition_types

    def to_dict(self) -> dict[str, Any]:
        """Serialise for ``helman/get_optimizer_schema``."""
        return {
            "kind": self.kind,
            "target": [f.to_dict() for f in self.target],
            "params": [f.to_dict() for f in self.params],
            "conditionTypes": [
                {
                    "key": condition.key,
                    "scope": condition.scope.value,
                    "field": condition.field.to_dict(),
                }
                for condition in self.condition_type_list
            ],
            "newDraft": self.new_draft,
        }


def _validate_window(params: Mapping[str, Any], *, path: str) -> None:
    window = params.get("window") or {}
    if _minutes(window.get("end")) <= _minutes(window.get("start")):
        raise OptimizerConfigError(
            path=f"{path}.window.end",
            code="invalid_value",
            message=f"{path}.window.end must be after {path}.window.start",
        )


def _validate_daily_runtime(params: Mapping[str, Any], *, path: str) -> None:
    _validate_window(params, path=path)
    window = params.get("window") or {}
    window_hours = (_minutes(window.get("end")) - _minutes(window.get("start"))) / 60
    min_hours_per_day = params.get("min_hours_per_day", 0)
    if window_hours < min_hours_per_day:
        raise OptimizerConfigError(
            path=f"{path}.window",
            code="invalid_value",
            message=(
                f"{path}.window must be at least {path}.min_hours_per_day wide "
                f"({window_hours:g}h < {min_hours_per_day:g}h)"
            ),
        )


def _minutes(hhmm: object) -> int:
    hour, _, minute = str(hhmm).partition(":")
    return int(hour) * 60 + int(minute)


_APPLIANCE_TARGET = (
    F.string("appliance_id"),
    F.string("climate_mode", required=False, choices=SUPPORTED_CLIMATE_MODES),
)


OPTIMIZER_SPECS: dict[str, OptimizerSpec] = {
    spec.kind: spec
    for spec in (
        OptimizerSpec(
            kind="charge_hold",
            params=(
                F.obj("window", F.time_hhmm("start"), F.time_hhmm("end")),
                F.obj(
                    "battery_first",
                    F.soc("target_soc"),
                    F.margin_pct("margin_pct"),
                ),
            ),
            condition_types=("run_when",),
            param_scope=Scope.DAY,
            validate=_validate_window,
            new_draft={
                "params": {
                    "window": {"start": "06:00", "end": "14:00"},
                    "battery_first": {"target_soc": 100, "margin_pct": 20},
                },
                "conditions": [{"run_when": ["surplus"]}],
            },
        ),
        OptimizerSpec(
            kind="export_price",
            condition_types=("when_price_below",),
            new_draft={"conditions": [{"when_price_below": 0}]},
        ),
        OptimizerSpec(
            kind="surplus_appliance",
            target=_APPLIANCE_TARGET,
            condition_types=("min_surplus_buffer_pct",),
            write_mode=WRITE_MODE_REPAINT,
            new_draft={
                "target": {"appliance_id": ""},
                "conditions": [{"min_surplus_buffer_pct": 5}],
            },
        ),
        OptimizerSpec(
            kind="daily_runtime",
            target=_APPLIANCE_TARGET,
            params=(
                F.positive_number("min_hours_per_day"),
                F.obj("window", F.time_hhmm("start"), F.time_hhmm("end")),
                F.non_negative_int("max_consecutive_skips", default=0),
            ),
            condition_types=("run_when",),
            param_scope=Scope.DAY,
            validate=_validate_daily_runtime,
            new_draft={
                "target": {"appliance_id": ""},
                "params": {
                    "min_hours_per_day": 8,
                    "window": {"start": "08:00", "end": "18:00"},
                    "max_consecutive_skips": 1,
                },
                "conditions": [{"run_when": ["surplus", "tight"]}],
            },
        ),
        OptimizerSpec(
            kind="charge_from_grid",
            params=(
                F.margin_pct("margin_pct"),
                F.soc("max_target_soc", default=100.0),
            ),
            condition_types=("reserve_floor_soc",),
            param_scope=Scope.RUN,
            new_draft={
                "params": {"margin_pct": 10, "max_target_soc": 100},
                "conditions": [{"reserve_floor_soc": 30}],
            },
        ),
    )
}

KNOWN_OPTIMIZER_KINDS: frozenset[str] = frozenset(OPTIMIZER_SPECS)
