from __future__ import annotations

from collections.abc import Mapping
from typing import NotRequired, TypedDict

from .climate_appliance import (
    ClimateApplianceMode,
    ClimateApplianceRuntime,
)
from .ev_schedule import ApplianceScheduleNormalizationMode
from ..schedule_action_metadata import (
    ScheduleActionSetBy,
    read_optional_schedule_action_set_by,
)


class ClimateApplianceScheduleActionDict(TypedDict):
    mode: str
    setBy: NotRequired[ScheduleActionSetBy]


def normalize_climate_appliance_schedule_action(
    value: object,
    *,
    appliance: ClimateApplianceRuntime,
    context: str,
    mode: ApplianceScheduleNormalizationMode,
) -> ClimateApplianceScheduleActionDict | None:
    if not isinstance(value, Mapping):
        raise ValueError(f"{context} must be an object")

    unsupported_keys = sorted(
        str(key) for key in value.keys() if key not in {"mode", "setBy"}
    )
    if unsupported_keys:
        raise ValueError(
            f"{context} contains unsupported fields: {', '.join(unsupported_keys)}"
        )

    raw_mode = value.get("mode")
    if not isinstance(raw_mode, str) or not raw_mode.strip():
        raise ValueError(f"{context}.mode must be a non-empty string")

    supported_modes = appliance.authorable_modes
    stop_mode = appliance.stop_hvac_mode
    if not supported_modes:
        if mode == "load_prune":
            return None
        raise ValueError(
            f"{context} cannot be scheduled because appliance {appliance.id!r} "
            "does not currently expose any schedulable climate modes"
        )

    normalized_mode = raw_mode.strip()
    set_by = read_optional_schedule_action_set_by(
        value.get("setBy"),
        path=f"{context}.setBy",
    )
    if stop_mode is not None and normalized_mode == stop_mode:
        payload: ClimateApplianceScheduleActionDict = {"mode": normalized_mode}
        if set_by is not None:
            payload["setBy"] = set_by
        return payload

    if normalized_mode not in supported_modes:
        if mode == "load_prune":
            return None
        allowed_modes = list(supported_modes)
        if stop_mode is not None and stop_mode not in supported_modes:
            allowed_modes.append(stop_mode)
        allowed = ", ".join(allowed_modes)
        raise ValueError(f"{context}.mode must be one of {allowed}")

    payload = {"mode": normalized_mode}
    if set_by is not None:
        payload["setBy"] = set_by
    return payload
