from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ..schedule_action_metadata import ScheduleActionSetBy
from .climate_appliance import ClimateApplianceRuntime
from .climate_schedule import (
    ClimateApplianceScheduleActionDict,
    normalize_climate_appliance_schedule_action,
)
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

        if isinstance(appliance, ClimateApplianceRuntime):
            normalized_action = normalize_climate_appliance_schedule_action(
                action,
                appliance=appliance,
                context=f"{context}.{appliance_id}",
                mode=mode,
            )
        elif isinstance(appliance, EvChargerApplianceRuntime):
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


def is_appliance_action_active(
    action: Mapping[str, Any],
    *,
    appliance: ApplianceRuntime,
) -> bool:
    """Whether a scheduled action means "this appliance is running".

    One definition of *running*, per kind, mirroring what each executor already
    treats as a state that must be stopped at the end of its slot
    (``execution.py``'s ``_last_scheduled_action_requires_slot_stop``). Callers
    that plan against another appliance's schedule need exactly that predicate,
    and a second copy of it would be free to drift.

    ``appliance`` is what resolves the climate branch — "running" there means
    "not the appliance's own stop mode" — and is the reason this lives beside
    the action union rather than among the snapshot readers that call it.
    """
    if isinstance(appliance, ClimateApplianceRuntime):
        raw_mode = action.get("mode")
        return isinstance(raw_mode, str) and raw_mode != appliance.stop_hvac_mode
    if isinstance(appliance, EvChargerApplianceRuntime):
        return bool(action.get("charge"))
    if isinstance(appliance, GenericApplianceRuntime):
        return bool(action.get("on"))
    return False


def with_appliance_schedule_actions_set_by(
    actions: Mapping[str, ApplianceScheduleActionDict],
    *,
    set_by: ScheduleActionSetBy | None,
) -> ApplianceScheduleActionsDict:
    normalized_actions = {
        appliance_id: dict(action) for appliance_id, action in actions.items()
    }
    if set_by is None:
        return normalized_actions

    for action in normalized_actions.values():
        action.setdefault("setBy", set_by)
    return normalized_actions


def _read_appliance_id(value: object, *, context: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{context} keys must be non-empty strings")
    return value.strip()
