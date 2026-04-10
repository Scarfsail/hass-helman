from __future__ import annotations

from collections.abc import Mapping
from typing import NotRequired, TypedDict

from .ev_schedule import ApplianceScheduleNormalizationMode
from .generic_appliance import GenericApplianceRuntime
from ..schedule_action_metadata import (
    ScheduleActionSetBy,
    read_optional_schedule_action_set_by,
)


class GenericApplianceScheduleActionDict(TypedDict):
    on: bool
    setBy: NotRequired[ScheduleActionSetBy]


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

    unsupported_keys = sorted(
        str(key) for key in value.keys() if key not in {"on", "setBy"}
    )
    if unsupported_keys:
        raise ValueError(
            f"{context} contains unsupported fields: {', '.join(unsupported_keys)}"
        )

    if "on" not in value or not isinstance(value["on"], bool):
        raise ValueError(f"{context}.on must be boolean")

    payload: GenericApplianceScheduleActionDict = {"on": value["on"]}
    set_by = read_optional_schedule_action_set_by(
        value.get("setBy"),
        path=f"{context}.setBy",
    )
    if set_by is not None:
        payload["setBy"] = set_by
    return payload
