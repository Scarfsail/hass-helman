from __future__ import annotations

from collections.abc import Mapping
from typing import TypedDict

from .ev_schedule import ApplianceScheduleNormalizationMode
from .generic_appliance import GenericApplianceRuntime


class GenericApplianceScheduleActionDict(TypedDict):
    on: bool


def normalize_generic_appliance_schedule_action(
    value: object,
    *,
    appliance: GenericApplianceRuntime,
    context: str,
    mode: ApplianceScheduleNormalizationMode,
) -> GenericApplianceScheduleActionDict | None:
    del appliance, mode
    if not isinstance(value, Mapping):
        raise ValueError(f"{context} must be an object")

    unsupported_keys = sorted(str(key) for key in value.keys() if key != "on")
    if unsupported_keys:
        raise ValueError(
            f"{context} contains unsupported fields: {', '.join(unsupported_keys)}"
        )

    if "on" not in value or not isinstance(value["on"], bool):
        raise ValueError(f"{context}.on must be boolean")

    return {"on": value["on"]}
