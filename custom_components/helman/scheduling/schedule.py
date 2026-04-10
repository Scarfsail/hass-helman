from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal, NotRequired, TypedDict

from homeassistant.util import dt as dt_util

from ..appliances.schedule import (
    ApplianceScheduleActionsDict,
    normalize_appliance_schedule_actions,
    read_appliance_schedule_actions,
)
from ..appliances.state import AppliancesRuntimeRegistry
from ..const import (
    SCHEDULE_ACTION_EMPTY,
    SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_KINDS,
    SCHEDULE_ACTION_NORMAL,
    SCHEDULE_ACTION_STOP_CHARGING,
    SCHEDULE_ACTION_STOP_DISCHARGING,
    SCHEDULE_ACTION_STOP_EXPORT,
    SCHEDULE_HORIZON_HOURS,
    SCHEDULE_SLOT_MINUTES,
)

if TYPE_CHECKING:
    from ..battery_state import BatterySocBounds
    from .runtime_status import ScheduleRuntimeDict

ScheduleActionKind = Literal[
    "empty",
    "normal",
    "charge_to_target_soc",
    "discharge_to_target_soc",
    "stop_charging",
    "stop_discharging",
    "stop_export",
]

TARGET_ACTION_KINDS = {
    SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
}
SCHEDULE_DOMAIN_KEYS = {"inverter", "appliances"}
SCHEDULE_SLOT_KEYS = {"id", "domains"}

if SCHEDULE_SLOT_MINUTES <= 0 or 60 % SCHEDULE_SLOT_MINUTES != 0:
    raise ValueError("SCHEDULE_SLOT_MINUTES must be a positive divisor of 60")

SCHEDULE_SLOT_DURATION = timedelta(minutes=SCHEDULE_SLOT_MINUTES)


class ScheduleActionDict(TypedDict):
    kind: ScheduleActionKind
    targetSoc: NotRequired[int]


class ScheduleDomainsDict(TypedDict):
    inverter: ScheduleActionDict
    appliances: ApplianceScheduleActionsDict


class ScheduleSlotDict(TypedDict):
    id: str
    domains: ScheduleDomainsDict


class ScheduleResponseDict(TypedDict):
    executionEnabled: bool
    slots: list[ScheduleSlotDict]
    runtime: NotRequired["ScheduleRuntimeDict"]


@dataclass(frozen=True)
class ScheduleAction:
    kind: ScheduleActionKind
    target_soc: int | None = None


EMPTY_SCHEDULE_ACTION = ScheduleAction(kind=SCHEDULE_ACTION_EMPTY)
NORMAL_SCHEDULE_ACTION = ScheduleAction(kind=SCHEDULE_ACTION_NORMAL)


@dataclass(frozen=True)
class ScheduleDomains:
    inverter: ScheduleAction = field(default_factory=lambda: EMPTY_SCHEDULE_ACTION)
    appliances: ApplianceScheduleActionsDict = field(default_factory=dict)


@dataclass(frozen=True, init=False)
class ScheduleSlot:
    id: str
    domains: ScheduleDomains

    def __init__(
        self,
        id: str,
        *,
        action: ScheduleAction | Mapping[str, Any] | None = None,
        domains: ScheduleDomains | Mapping[str, Any] | None = None,
    ) -> None:
        if action is not None and domains is not None:
            raise ValueError("ScheduleSlot accepts either action or domains, not both")

        object.__setattr__(self, "id", id)
        object.__setattr__(
            self,
            "domains",
            _coerce_schedule_domains(action if domains is None else domains),
        )

    @property
    def action(self) -> ScheduleAction:
        return self.domains.inverter


@dataclass(init=False)
class ScheduleDocument:
    execution_enabled: bool = False
    slots: dict[str, ScheduleDomains] = field(default_factory=dict)

    def __init__(
        self,
        execution_enabled: bool = False,
        slots: Mapping[str, Any] | None = None,
    ) -> None:
        self.execution_enabled = execution_enabled
        self.slots = (
            {}
            if slots is None
            else {
                slot_id: _coerce_schedule_domains(domains)
                for slot_id, domains in dict(slots).items()
            }
        )


@dataclass(frozen=True)
class ScheduleControlConfig:
    mode_entity_id: str
    normal_option: str
    stop_charging_option: str
    stop_discharging_option: str
    charge_to_target_soc_option: str | None = None
    discharge_to_target_soc_option: str | None = None
    stop_export_option: str | None = None


class ScheduleError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class ScheduleSlotsError(ScheduleError):
    def __init__(self, message: str) -> None:
        super().__init__("invalid_slots", message)


class ScheduleStorageCompatibilityError(ScheduleSlotsError):
    """Persisted schedule data does not match the active slot configuration."""


class ScheduleActionError(ScheduleError):
    def __init__(self, message: str) -> None:
        super().__init__("invalid_action", message)


class ScheduleNotConfiguredError(ScheduleError):
    def __init__(self, message: str) -> None:
        super().__init__("not_configured", message)


class ScheduleExecutionUnavailableError(ScheduleError):
    def __init__(self, message: str) -> None:
        super().__init__("execution_unavailable", message)


def action_from_dict(data: Mapping[str, Any]) -> ScheduleAction:
    kind = _read_non_empty_string(data.get("kind"))
    if kind not in SCHEDULE_ACTION_KINDS:
        raise ScheduleActionError("Unknown schedule action kind")

    has_target_soc, target_soc = _read_target_soc(data)
    action = ScheduleAction(kind=kind, target_soc=target_soc)
    _validate_action(
        action=action,
        has_target_soc=has_target_soc,
        battery_soc_bounds=None,
        require_target_soc_bounds=False,
    )
    return action


def action_to_dict(action: ScheduleAction) -> ScheduleActionDict:
    payload: ScheduleActionDict = {"kind": action.kind}
    if action.target_soc is not None:
        payload["targetSoc"] = action.target_soc
    return payload


def domains_from_dict(data: Any, *, context: str) -> ScheduleDomains:
    if not isinstance(data, Mapping):
        raise ScheduleActionError(f"{context} domains must be an object")

    unsupported_keys = sorted(
        str(key) for key in data.keys() if key not in SCHEDULE_DOMAIN_KEYS
    )
    if unsupported_keys:
        raise ScheduleActionError(
            f"{context} domains contain unsupported keys: {', '.join(unsupported_keys)}"
        )

    raw_inverter = data.get("inverter")
    if not isinstance(raw_inverter, Mapping):
        raise ScheduleActionError(f"{context} domains.inverter must be an object")

    raw_appliances = data.get("appliances", {})
    if not isinstance(raw_appliances, Mapping):
        raise ScheduleActionError(f"{context} domains.appliances must be an object")

    try:
        appliances = read_appliance_schedule_actions(
            raw_appliances,
            context=f"{context} domains.appliances",
        )
    except ValueError as err:
        raise ScheduleActionError(str(err)) from err

    return ScheduleDomains(
        inverter=action_from_dict(raw_inverter),
        appliances=appliances,
    )


def domains_to_dict(domains: ScheduleDomains) -> ScheduleDomainsDict:
    return {
        "inverter": action_to_dict(domains.inverter),
        "appliances": {
            appliance_id: dict(action)
            for appliance_id, action in domains.appliances.items()
        },
    }


def slot_from_dict(data: Mapping[str, Any]) -> ScheduleSlot:
    if not isinstance(data, Mapping):
        raise ScheduleSlotsError("Schedule slot must be an object")

    slot_id = _read_non_empty_string(data.get("id"))
    if slot_id is None:
        raise ScheduleSlotsError("Schedule slot id must be a non-empty string")

    if "action" in data:
        raise ScheduleActionError(
            "Legacy schedule payload uses top-level 'action'; use "
            "'domains.inverter' and 'domains.appliances' instead"
        )
    if "runtime" in data:
        raise ScheduleActionError("Schedule slot runtime is read-only and cannot be set")

    unsupported_keys = sorted(str(key) for key in data.keys() if key not in SCHEDULE_SLOT_KEYS)
    if unsupported_keys:
        raise ScheduleSlotsError(
            f"Schedule slot contains unsupported fields: {', '.join(unsupported_keys)}"
        )

    return ScheduleSlot(
        id=format_slot_id(parse_slot_id(slot_id)),
        domains=domains_from_dict(data.get("domains"), context="Schedule slot"),
    )


def slot_to_dict(
    slot: ScheduleSlot,
) -> ScheduleSlotDict:
    return {"id": slot.id, "domains": domains_to_dict(slot.domains)}


def schedule_document_from_dict(data: Mapping[str, Any] | None) -> ScheduleDocument:
    if data is None:
        return ScheduleDocument()
    if not isinstance(data, Mapping):
        raise ScheduleSlotsError("Persisted schedule document must be an object")

    raw_slot_minutes = data.get("slotMinutes")
    if raw_slot_minutes is None:
        # Older schedule documents were always written with a 15-minute grid.
        persisted_slot_minutes = 15
    else:
        if isinstance(raw_slot_minutes, bool) or not isinstance(raw_slot_minutes, int):
            raise ScheduleSlotsError("Persisted schedule slotMinutes must be an integer")
        persisted_slot_minutes = raw_slot_minutes

    if persisted_slot_minutes != SCHEDULE_SLOT_MINUTES:
        raise ScheduleStorageCompatibilityError(
            "Persisted schedule slotMinutes does not match the configured "
            f"{SCHEDULE_SLOT_MINUTES}-minute slot duration"
        )

    execution_enabled = data.get("executionEnabled", False)
    if not isinstance(execution_enabled, bool):
        raise ScheduleSlotsError("Persisted schedule executionEnabled must be boolean")

    raw_slots = data.get("slots", {})
    if not isinstance(raw_slots, Mapping):
        raise ScheduleSlotsError("Persisted schedule slots must be an object")

    slots: dict[str, ScheduleDomains] = {}
    for raw_slot_id, raw_domains in raw_slots.items():
        slot_id = _read_non_empty_string(raw_slot_id)
        if slot_id is None:
            raise ScheduleSlotsError(
                "Persisted schedule slot ids must be non-empty strings"
            )
        if not isinstance(raw_domains, Mapping):
            raise ScheduleActionError("Persisted schedule slot domains must be an object")
        if any(key in raw_domains for key in ("kind", "targetSoc", "target_soc")):
            raise ScheduleStorageCompatibilityError(
                "Persisted schedule uses legacy flat action shape and must be reset"
            )

        slot_start = parse_slot_id(slot_id)
        if not _is_slot_aligned(slot_start):
            raise ScheduleStorageCompatibilityError(
                "Persisted schedule slot ids must align to "
                f"{SCHEDULE_SLOT_MINUTES}-minute boundaries"
            )

        canonical_slot_id = format_slot_id(slot_start)
        if canonical_slot_id in slots:
            raise ScheduleSlotsError("Persisted schedule contains duplicate slot ids")

        domains = domains_from_dict(raw_domains, context="Persisted schedule slot")
        if is_default_domains(domains):
            continue

        slots[canonical_slot_id] = domains

    return ScheduleDocument(execution_enabled=execution_enabled, slots=slots)


def schedule_document_to_dict(doc: ScheduleDocument) -> dict[str, Any]:
    return {
        "executionEnabled": doc.execution_enabled,
        "slotMinutes": SCHEDULE_SLOT_MINUTES,
        "slots": {
            slot_id: domains_to_dict(domains)
            for slot_id, domains in sorted(doc.slots.items())
            if not is_default_domains(domains)
        },
    }


def read_schedule_control_config(
    config: Mapping[str, Any],
) -> ScheduleControlConfig | None:
    scheduler_config = _read_mapping(config.get("scheduler"))
    control_config = _read_mapping(scheduler_config.get("control"))
    action_option_map = _read_mapping(control_config.get("action_option_map"))

    mode_entity_id = _read_non_empty_string(control_config.get("mode_entity_id"))
    normal_option = _read_non_empty_string(
        action_option_map.get(SCHEDULE_ACTION_NORMAL)
    )
    charge_to_target_soc_option = _read_non_empty_string(
        action_option_map.get(SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC)
    )
    discharge_to_target_soc_option = _read_non_empty_string(
        action_option_map.get(SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC)
    )
    stop_charging_option = _read_non_empty_string(
        action_option_map.get(SCHEDULE_ACTION_STOP_CHARGING)
    )
    stop_discharging_option = _read_non_empty_string(
        action_option_map.get(SCHEDULE_ACTION_STOP_DISCHARGING)
    )
    stop_export_option = _read_non_empty_string(
        action_option_map.get(SCHEDULE_ACTION_STOP_EXPORT)
    )

    if (
        mode_entity_id is None
        or normal_option is None
        or stop_charging_option is None
        or stop_discharging_option is None
    ):
        return None

    return ScheduleControlConfig(
        mode_entity_id=mode_entity_id,
        normal_option=normal_option,
        stop_charging_option=stop_charging_option,
        stop_discharging_option=stop_discharging_option,
        charge_to_target_soc_option=charge_to_target_soc_option,
        discharge_to_target_soc_option=discharge_to_target_soc_option,
        stop_export_option=stop_export_option,
    )


def describe_schedule_control_config_issue(
    config: Mapping[str, Any],
) -> str | None:
    scheduler_config = _read_mapping(config.get("scheduler"))
    control_config = _read_mapping(scheduler_config.get("control"))
    action_option_map = _read_mapping(control_config.get("action_option_map"))

    missing_fields: list[str] = []
    if _read_non_empty_string(control_config.get("mode_entity_id")) is None:
        missing_fields.append("scheduler.control.mode_entity_id")
    if _read_non_empty_string(action_option_map.get(SCHEDULE_ACTION_NORMAL)) is None:
        missing_fields.append("scheduler.control.action_option_map.normal")
    if _read_non_empty_string(action_option_map.get(SCHEDULE_ACTION_STOP_CHARGING)) is None:
        missing_fields.append("scheduler.control.action_option_map.stop_charging")
    if _read_non_empty_string(action_option_map.get(SCHEDULE_ACTION_STOP_DISCHARGING)) is None:
        missing_fields.append(
            "scheduler.control.action_option_map.stop_discharging"
        )

    if not missing_fields:
        return None

    return "missing required scheduler control config values: " + ", ".join(
        missing_fields
    )


def build_horizon_start(reference_time: datetime) -> datetime:
    local_reference = dt_util.as_local(reference_time)
    return local_reference.replace(
        minute=(local_reference.minute // SCHEDULE_SLOT_MINUTES)
        * SCHEDULE_SLOT_MINUTES,
        second=0,
        microsecond=0,
    )


def build_horizon_end(reference_time: datetime) -> datetime:
    return build_horizon_start(reference_time) + timedelta(hours=SCHEDULE_HORIZON_HOURS)


def parse_slot_id(slot_id: str) -> datetime:
    parsed = dt_util.parse_datetime(slot_id)
    if parsed is None or parsed.tzinfo is None:
        raise ScheduleSlotsError(
            "Schedule slot ids must be timezone-aware ISO timestamps"
        )
    return dt_util.as_local(parsed)


def format_slot_id(slot_start: datetime) -> str:
    return dt_util.as_local(slot_start).isoformat(timespec="seconds")


def iter_horizon_slot_ids(reference_time: datetime) -> list[str]:
    slot_ids: list[str] = []
    current_slot = build_horizon_start(reference_time)
    horizon_end = build_horizon_end(reference_time)

    while current_slot < horizon_end:
        slot_ids.append(format_slot_id(current_slot))
        current_slot += SCHEDULE_SLOT_DURATION

    return slot_ids


def materialize_schedule_slots(
    *,
    stored_slots: Mapping[str, ScheduleDomains],
    reference_time: datetime,
) -> list[ScheduleSlot]:
    return [
        ScheduleSlot(
            id=slot_id,
            domains=stored_slots.get(slot_id, ScheduleDomains()),
        )
        for slot_id in iter_horizon_slot_ids(reference_time)
    ]


def find_active_slot(
    *,
    stored_slots: Mapping[str, ScheduleDomains],
    reference_time: datetime,
) -> ScheduleSlot | None:
    slot_id = format_slot_id(build_horizon_start(reference_time))
    domains = stored_slots.get(slot_id)
    if domains is None:
        return None
    return ScheduleSlot(id=slot_id, domains=domains)


def apply_slot_patches(
    *,
    stored_slots: Mapping[str, ScheduleDomains],
    slot_patches: Sequence[ScheduleSlot],
) -> dict[str, ScheduleDomains]:
    updated_slots = dict(stored_slots)

    for slot_patch in slot_patches:
        if is_default_domains(slot_patch.domains):
            updated_slots.pop(slot_patch.id, None)
        else:
            updated_slots[slot_patch.id] = slot_patch.domains

    return dict(sorted(updated_slots.items()))


def prune_expired_slots(
    *,
    stored_slots: Mapping[str, ScheduleDomains],
    reference_time: datetime,
) -> dict[str, ScheduleDomains]:
    reference_local = dt_util.as_local(reference_time)
    pruned_slots = {
        slot_id: domains
        for slot_id, domains in stored_slots.items()
        if parse_slot_id(slot_id) + SCHEDULE_SLOT_DURATION > reference_local
    }
    return dict(sorted(pruned_slots.items()))


def validate_slot_patch(
    *,
    slot_id: str,
    domains: ScheduleDomains,
    reference_time: datetime,
    battery_soc_bounds: BatterySocBounds | None,
) -> None:
    slot_start = parse_slot_id(slot_id)
    if not _is_slot_aligned(slot_start):
        raise ScheduleSlotsError(
            f"Schedule slot '{slot_id}' must align to {SCHEDULE_SLOT_MINUTES}-minute boundaries"
        )
    if not _is_slot_in_horizon(slot_start, reference_time):
        raise ScheduleSlotsError(
            f"Schedule slot '{slot_id}' must be within the rolling {SCHEDULE_HORIZON_HOURS}-hour horizon"
        )
    validate_schedule_domains(
        domains=domains,
        battery_soc_bounds=battery_soc_bounds,
        require_target_soc_bounds=True,
    )


def normalize_slot_patch(
    *,
    slot_id: str,
    domains: ScheduleDomains,
    reference_time: datetime,
    battery_soc_bounds: BatterySocBounds | None,
    appliances_registry: AppliancesRuntimeRegistry | None,
) -> ScheduleSlot:
    slot_start = parse_slot_id(slot_id)
    if not _is_slot_aligned(slot_start):
        raise ScheduleSlotsError(
            f"Schedule slot '{slot_id}' must align to {SCHEDULE_SLOT_MINUTES}-minute boundaries"
        )
    if not _is_slot_in_horizon(slot_start, reference_time):
        raise ScheduleSlotsError(
            f"Schedule slot '{slot_id}' must be within the rolling {SCHEDULE_HORIZON_HOURS}-hour horizon"
        )
    return ScheduleSlot(
        id=slot_id,
        domains=normalize_schedule_domains(
            domains=domains,
            battery_soc_bounds=battery_soc_bounds,
            require_target_soc_bounds=True,
            appliances_registry=appliances_registry,
            context="Schedule slot",
            appliance_mode="strict",
        ),
    )


def validate_slot_patch_request(
    *,
    slots: Sequence[ScheduleSlot],
    reference_time: datetime,
    battery_soc_bounds: BatterySocBounds | None,
    appliances_registry: AppliancesRuntimeRegistry | None = None,
) -> None:
    normalize_slot_patch_request(
        slots=slots,
        reference_time=reference_time,
        battery_soc_bounds=battery_soc_bounds,
        appliances_registry=appliances_registry,
    )


def normalize_slot_patch_request(
    *,
    slots: Sequence[ScheduleSlot],
    reference_time: datetime,
    battery_soc_bounds: BatterySocBounds | None,
    appliances_registry: AppliancesRuntimeRegistry | None,
) -> list[ScheduleSlot]:
    if not slots:
        raise ScheduleSlotsError("At least one schedule slot must be provided")

    seen_slot_ids: set[str] = set()
    normalized_slots: list[ScheduleSlot] = []
    for slot in slots:
        if slot.id in seen_slot_ids:
            raise ScheduleSlotsError(
                f"Schedule slot '{slot.id}' appears more than once in the same request"
            )
        seen_slot_ids.add(slot.id)
        normalized_slots.append(
            normalize_slot_patch(
                slot_id=slot.id,
                domains=slot.domains,
                reference_time=reference_time,
                battery_soc_bounds=battery_soc_bounds,
                appliances_registry=appliances_registry,
            )
        )

    return normalized_slots


def is_default_domains(domains: ScheduleDomains) -> bool:
    return domains.inverter == EMPTY_SCHEDULE_ACTION and not domains.appliances


def validate_schedule_domains(
    *,
    domains: ScheduleDomains,
    battery_soc_bounds: BatterySocBounds | None,
    require_target_soc_bounds: bool,
    appliances_registry: AppliancesRuntimeRegistry | None = None,
) -> None:
    normalize_schedule_domains(
        domains=domains,
        battery_soc_bounds=battery_soc_bounds,
        require_target_soc_bounds=require_target_soc_bounds,
        appliances_registry=appliances_registry,
        context="Schedule slot",
        appliance_mode="strict",
    )


def normalize_schedule_domains(
    *,
    domains: ScheduleDomains,
    battery_soc_bounds: BatterySocBounds | None,
    require_target_soc_bounds: bool,
    appliances_registry: AppliancesRuntimeRegistry | None,
    context: str,
    appliance_mode: Literal["strict", "load_prune"],
) -> ScheduleDomains:
    registry = (
        AppliancesRuntimeRegistry() if appliances_registry is None else appliances_registry
    )

    _validate_action(
        action=domains.inverter,
        has_target_soc=domains.inverter.target_soc is not None,
        battery_soc_bounds=battery_soc_bounds,
        require_target_soc_bounds=require_target_soc_bounds,
    )

    try:
        appliances = normalize_appliance_schedule_actions(
            domains.appliances,
            registry=registry,
            context=f"{context} domains.appliances",
            mode=appliance_mode,
        )
    except ValueError as err:
        raise ScheduleActionError(str(err)) from err

    return ScheduleDomains(
        inverter=domains.inverter,
        appliances=appliances,
    )


def normalize_schedule_document_for_registry(
    doc: ScheduleDocument,
    *,
    appliances_registry: AppliancesRuntimeRegistry,
) -> ScheduleDocument:
    normalized_slots: dict[str, ScheduleDomains] = {}

    for slot_id, domains in doc.slots.items():
        normalized_domains = normalize_schedule_domains(
            domains=domains,
            battery_soc_bounds=None,
            require_target_soc_bounds=False,
            appliances_registry=appliances_registry,
            context="Persisted schedule slot",
            appliance_mode="load_prune",
        )
        if is_default_domains(normalized_domains):
            continue
        normalized_slots[slot_id] = normalized_domains

    return ScheduleDocument(
        execution_enabled=doc.execution_enabled,
        slots=normalized_slots,
    )


def _coerce_schedule_domains(value: Any) -> ScheduleDomains:
    if value is None:
        return ScheduleDomains()

    if isinstance(value, ScheduleDomains):
        return ScheduleDomains(
            inverter=_coerce_schedule_action(value.inverter),
            appliances=_coerce_appliances_mapping(value.appliances),
        )

    if isinstance(value, Mapping):
        if "inverter" in value or "appliances" in value:
            raw_inverter = value.get("inverter", EMPTY_SCHEDULE_ACTION)
            return ScheduleDomains(
                inverter=_coerce_schedule_action(raw_inverter),
                appliances=_coerce_appliances_mapping(value.get("appliances", {})),
            )
        return ScheduleDomains(
            inverter=_coerce_schedule_action(value),
            appliances={},
        )

    if hasattr(value, "inverter") or hasattr(value, "appliances"):
        raw_inverter = getattr(value, "inverter", EMPTY_SCHEDULE_ACTION)
        raw_appliances = getattr(value, "appliances", {})
        return ScheduleDomains(
            inverter=_coerce_schedule_action(raw_inverter),
            appliances=_coerce_appliances_mapping(raw_appliances),
        )

    return ScheduleDomains(
        inverter=_coerce_schedule_action(value),
        appliances={},
    )


def _coerce_schedule_action(value: Any) -> ScheduleAction:
    if value is None:
        return EMPTY_SCHEDULE_ACTION

    if isinstance(value, ScheduleAction):
        return value

    if isinstance(value, Mapping):
        return action_from_dict(value)

    kind = _read_non_empty_string(getattr(value, "kind", None))
    if kind not in SCHEDULE_ACTION_KINDS:
        raise ScheduleActionError("Unknown schedule action kind")

    raw_target_soc = getattr(value, "target_soc", getattr(value, "targetSoc", None))
    has_target_soc = raw_target_soc is not None
    if has_target_soc and (
        isinstance(raw_target_soc, bool) or not isinstance(raw_target_soc, int)
    ):
        raise ScheduleActionError("targetSoc must be an integer")

    action = ScheduleAction(kind=kind, target_soc=raw_target_soc)
    _validate_action(
        action=action,
        has_target_soc=has_target_soc,
        battery_soc_bounds=None,
        require_target_soc_bounds=False,
    )
    return action


def _coerce_appliances_mapping(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    try:
        return read_appliance_schedule_actions(
            value,
            context="Schedule appliances mapping",
        )
    except ValueError as err:
        raise ScheduleActionError(str(err)) from err


def _read_mapping(value: Any) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return value
    return {}


def _read_non_empty_string(value: Any) -> str | None:
    if isinstance(value, str):
        stripped = value.strip()
        if stripped:
            return stripped
    return None


def _read_target_soc(data: Mapping[str, Any]) -> tuple[bool, int | None]:
    if "targetSoc" in data:
        raw_target_soc = data["targetSoc"]
    elif "target_soc" in data:
        raw_target_soc = data["target_soc"]
    else:
        return False, None

    if isinstance(raw_target_soc, bool) or not isinstance(raw_target_soc, int):
        raise ScheduleActionError("targetSoc must be an integer")

    return True, raw_target_soc


def _is_slot_aligned(slot_start: datetime) -> bool:
    return (
        slot_start.minute % SCHEDULE_SLOT_MINUTES == 0
        and slot_start.second == 0
        and slot_start.microsecond == 0
    )


def _is_slot_in_horizon(slot_start: datetime, reference_time: datetime) -> bool:
    horizon_start = build_horizon_start(reference_time)
    horizon_end = build_horizon_end(reference_time)
    return horizon_start <= slot_start < horizon_end


def _validate_action(
    *,
    action: ScheduleAction,
    has_target_soc: bool,
    battery_soc_bounds: BatterySocBounds | None,
    require_target_soc_bounds: bool,
) -> None:
    if action.kind not in SCHEDULE_ACTION_KINDS:
        raise ScheduleActionError("Unknown schedule action kind")

    if action.kind in TARGET_ACTION_KINDS:
        if not has_target_soc or action.target_soc is None:
            raise ScheduleActionError(f"Action '{action.kind}' requires targetSoc")
        if not 0 <= action.target_soc <= 100:
            raise ScheduleActionError("targetSoc must be between 0 and 100")
        if require_target_soc_bounds and battery_soc_bounds is None:
            raise ScheduleNotConfiguredError(
                "Battery min/max SoC bounds are required for target schedule actions"
            )
        if battery_soc_bounds is None:
            return
        if (
            action.target_soc < battery_soc_bounds.min_soc
            or action.target_soc > battery_soc_bounds.max_soc
        ):
            raise ScheduleActionError(
                "targetSoc must be between "
                f"{battery_soc_bounds.min_soc:g} and {battery_soc_bounds.max_soc:g}"
            )
        return

    if has_target_soc or action.target_soc is not None:
        raise ScheduleActionError(f"Action '{action.kind}' does not allow targetSoc")
