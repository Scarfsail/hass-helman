from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ..controllables.spec import spec_for
from .climate_schedule import ClimateApplianceScheduleActionDict
from .ev_schedule import (
    ApplianceScheduleNormalizationMode,
    EvChargerScheduleActionDict,
)
from .generic_schedule import GenericApplianceScheduleActionDict
from .state import ApplianceRuntime, AppliancesRuntimeRegistry

ApplianceScheduleActionDict = (
    ClimateApplianceScheduleActionDict
    | EvChargerScheduleActionDict
    | GenericApplianceScheduleActionDict
)
ApplianceScheduleActionsDict = dict[str, ApplianceScheduleActionDict]


def read_appliance_schedule_actions(
    value: object,
    *,
    context: str,
) -> dict[str, dict[str, Any]]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{context} must be an object")

    actions: dict[str, dict[str, Any]] = {}
    for raw_appliance_id, raw_action in value.items():
        appliance_id = _read_appliance_id(raw_appliance_id, context=context)
        if appliance_id in actions:
            raise ValueError(f"{context} contains duplicate applianceId {appliance_id!r}")
        if not isinstance(raw_action, Mapping):
            raise ValueError(f"{context}.{appliance_id} must be an object")
        actions[appliance_id] = {str(key): item for key, item in raw_action.items()}

    return actions


def normalize_appliance_schedule_actions(
    actions: Mapping[str, object],
    *,
    registry: AppliancesRuntimeRegistry,
    context: str,
    mode: ApplianceScheduleNormalizationMode,
) -> ApplianceScheduleActionsDict:
    raw_actions = read_appliance_schedule_actions(actions, context=context)
    normalized: ApplianceScheduleActionsDict = {}

    for appliance_id, action in raw_actions.items():
        appliance = registry.get_appliance(appliance_id)
        if appliance is None:
            if mode == "load_prune":
                continue
            raise ValueError(
                f"{context}.{appliance_id} must reference a configured appliance"
            )

        normalized_action = spec_for(appliance.kind).normalize_action(
            action,
            appliance=appliance,
            context=f"{context}.{appliance_id}",
            mode=mode,
        )
        if normalized_action is not None:
            normalized[appliance_id] = normalized_action

    return normalized


def is_appliance_action_active(
    action: Mapping[str, Any],
    *,
    appliance: ApplianceRuntime,
) -> bool:
    """Whether a scheduled action means "this appliance is running".

    The kind's :attr:`..controllables.spec.ControllableSpec.is_running` — the
    one definition of *running* the executor's drivers also use to decide
    whether a slot's end must stop the appliance
    (:meth:`.execution.ApplianceExecutor.async_execute`). Callers that plan
    against another appliance's schedule need exactly that predicate, so they
    ask it rather than keep a copy free to drift.
    """
    return spec_for(appliance.kind).is_running(action)


def _read_appliance_id(value: object, *, context: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{context} keys must be non-empty strings")
    return value.strip()
