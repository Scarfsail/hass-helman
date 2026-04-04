from __future__ import annotations

from collections.abc import Mapping
from typing import Literal, NotRequired, TypedDict

from .ev_charger import EvChargerApplianceRuntime

ApplianceScheduleNormalizationMode = Literal["strict", "load_prune"]


class EvChargerScheduleActionDict(TypedDict):
    charge: bool
    vehicleId: NotRequired[str]
    useMode: NotRequired[str]
    ecoGear: NotRequired[str]


def normalize_ev_charger_schedule_action(
    value: object,
    *,
    appliance: EvChargerApplianceRuntime,
    context: str,
    mode: ApplianceScheduleNormalizationMode,
) -> EvChargerScheduleActionDict | None:
    if not isinstance(value, Mapping):
        raise ValueError(f"{context} must be an object")

    unsupported_keys = sorted(
        str(key)
        for key in value.keys()
        if key not in {"charge", "vehicleId", "useMode", "ecoGear"}
    )
    if unsupported_keys:
        raise ValueError(
            f"{context} contains unsupported fields: {', '.join(unsupported_keys)}"
        )

    if "charge" not in value or not isinstance(value["charge"], bool):
        raise ValueError(f"{context}.charge must be boolean")

    charge = value["charge"]
    vehicle_id = _read_optional_non_empty_string(
        value.get("vehicleId"),
        path=f"{context}.vehicleId",
    )
    use_mode = _read_optional_non_empty_string(
        value.get("useMode"),
        path=f"{context}.useMode",
    )
    eco_gear = _read_optional_non_empty_string(
        value.get("ecoGear"),
        path=f"{context}.ecoGear",
    )

    if not charge:
        if use_mode is not None:
            raise ValueError(f"{context}.useMode must be omitted when charge is false")
        if eco_gear is not None:
            raise ValueError(f"{context}.ecoGear must be omitted when charge is false")
        if vehicle_id is not None and vehicle_id not in appliance.vehicles_by_id:
            if mode == "load_prune":
                return None
            raise ValueError(
                f"{context}.vehicleId must reference a configured vehicle for appliance "
                f"{appliance.id!r}"
            )

        payload: EvChargerScheduleActionDict = {"charge": False}
        if vehicle_id is not None:
            payload["vehicleId"] = vehicle_id
        return payload

    if vehicle_id is None:
        raise ValueError(f"{context}.vehicleId is required when charge is true")
    if vehicle_id not in appliance.vehicles_by_id:
        if mode == "load_prune":
            return None
        raise ValueError(
            f"{context}.vehicleId must reference a configured vehicle for appliance "
            f"{appliance.id!r}"
        )

    if use_mode is None:
        raise ValueError(f"{context}.useMode is required when charge is true")
    use_mode_config = appliance.get_use_mode(use_mode)
    if use_mode_config is None:
        raise ValueError(
            f"{context}.useMode must be one of {', '.join(appliance.use_modes)}"
        )

    if use_mode_config.behavior == "surplus_aware":
        if eco_gear is None:
            raise ValueError(
                f"{context}.ecoGear is required when useMode is {use_mode_config.id}"
            )
        if eco_gear not in appliance.eco_gears:
            if mode == "load_prune":
                return None
            raise ValueError(
                f"{context}.ecoGear must be one of {', '.join(appliance.eco_gears)}"
            )
        return {
            "charge": True,
            "vehicleId": vehicle_id,
            "useMode": use_mode_config.id,
            "ecoGear": eco_gear,
        }

    return {
        "charge": True,
        "vehicleId": vehicle_id,
        "useMode": use_mode_config.id,
    }


def _read_optional_non_empty_string(value: object, *, path: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{path} must be a non-empty string")
    return value.strip()
