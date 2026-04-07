from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .ev_charger import EvChargerApplianceRuntime
from .ev_schedule import (
    ApplianceScheduleNormalizationMode,
    EvChargerScheduleActionDict,
    normalize_ev_charger_schedule_action,
)
from .generic_appliance import GenericApplianceRuntime
from .generic_schedule import (
    GenericApplianceScheduleActionDict,
    normalize_generic_appliance_schedule_action,
)
from .state import AppliancesRuntimeRegistry

ApplianceScheduleActionDict = (
    EvChargerScheduleActionDict | GenericApplianceScheduleActionDict
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

        if isinstance(appliance, EvChargerApplianceRuntime):
            normalized_action = normalize_ev_charger_schedule_action(
                action,
                appliance=appliance,
                context=f"{context}.{appliance_id}",
                mode=mode,
            )
        elif isinstance(appliance, GenericApplianceRuntime):
            normalized_action = normalize_generic_appliance_schedule_action(
                action,
                appliance=appliance,
                context=f"{context}.{appliance_id}",
                mode=mode,
            )
        else:
            if mode == "load_prune":
                continue
            raise ValueError(
                f"{context}.{appliance_id} references unsupported appliance kind "
                f"{appliance.kind!r}"
            )
        if normalized_action is not None:
            normalized[appliance_id] = normalized_action

    return normalized


def _read_appliance_id(value: object, *, context: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{context} keys must be non-empty strings")
    return value.strip()
