from __future__ import annotations

from collections.abc import Mapping
from typing import Any, TypedDict

from .climate_appliance import (
    SUPPORTED_CLIMATE_MODES,
    ClimateApplianceMode,
    ClimateApplianceRuntime,
)
from .ev_schedule import ApplianceScheduleNormalizationMode


class ClimateApplianceScheduleActionDict(TypedDict):
    mode: str


def normalize_climate_appliance_schedule_action(
    value: object,
    *,
    appliance: ClimateApplianceRuntime,
    context: str,
    mode: ApplianceScheduleNormalizationMode,
) -> ClimateApplianceScheduleActionDict | None:
    if not isinstance(value, Mapping):
        raise ValueError(f"{context} must be an object")

    unsupported_keys = sorted(str(key) for key in value.keys() if key != "mode")
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
    if normalized_mode != stop_mode and normalized_mode not in supported_modes:
        if mode == "load_prune":
            return None
        allowed_modes = list(supported_modes)
        if stop_mode is not None and stop_mode not in supported_modes:
            allowed_modes.append(stop_mode)
        allowed = ", ".join(allowed_modes)
        raise ValueError(f"{context}.mode must be one of {allowed}")

    return {"mode": normalized_mode}


def is_climate_action_running(action: Mapping[str, Any]) -> bool:
    """A climate appliance runs while its normalized action heats or cools.

    The normalizer above accepts only an authorable mode — always one of
    :data:`SUPPORTED_CLIMATE_MODES` — or the appliance's own stop mode, so
    "one of the supported modes" and "not the stop mode" are the same answer on
    a normalized action, and this one needs no appliance to give it.
    """
    return action.get("mode") in SUPPORTED_CLIMATE_MODES


def climate_action_from_state(runtime: Any, state: str) -> dict[str, Any]:
    """Observed HVAC mode; temperatures were not recorded here."""
    return {"mode": state}
