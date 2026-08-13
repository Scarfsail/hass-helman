from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal, NotRequired, TypedDict

from homeassistant.util import dt as dt_util

from ..appliances.schedule import (
    ApplianceScheduleActionDict,
    ApplianceScheduleActionsDict,
    normalize_appliance_schedule_actions,
    read_appliance_schedule_actions,
    with_appliance_schedule_actions_set_by,
)
from ..schedule_action_metadata import (
    ScheduleActionSetBy,
    read_optional_schedule_action_set_by,
)
from ..appliances.state import AppliancesRuntimeRegistry
from ..controllables.config import (
    CONTROLLABLE_ID_INVERTER,
    find_inverter_controllable,
)
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
#: The two members of the pre-version-8 ``domains`` object, kept only so a
#: stored document in that shape can still be recognised and converted.
LEGACY_SCHEDULE_DOMAIN_KEYS = {"inverter", "appliances"}
#: How the inverter's control block is named when reporting a config problem.
#: Not an index: the inverter is a singleton found by kind, so its position in
#: the list is not stable and would only mislead.
_INVERTER_CONTROL_PATH = (
    f"controllables[{CONTROLLABLE_ID_INVERTER}].controls.mode"
)
SCHEDULE_SLOT_KEYS = {"id", "controllables"}

SCHEDULE_SLOT_DURATION = timedelta(minutes=SCHEDULE_SLOT_MINUTES)


class ScheduleActionDict(TypedDict):
    kind: ScheduleActionKind
    targetSoc: NotRequired[int]
    setBy: NotRequired[ScheduleActionSetBy]
    conditionMet: NotRequired[bool]


#: One controllable's action as it travels on the wire and in storage.
#:
#: Deliberately a union rather than one shape: the inverter's action is a
#: ``kind``/``targetSoc`` pair, a generic appliance's is ``{"on": bool}``, a
#: climate's a mode and an EV charger's a charge flag. The map they live in is
#: keyed by controllable id and discriminated by that controllable's configured
#: kind, exactly as the appliance map already was before the inverter joined it.
ControllableScheduleActionDict = ScheduleActionDict | ApplianceScheduleActionDict
ControllableScheduleActionsDict = dict[str, ControllableScheduleActionDict]


class ScheduleSlotDict(TypedDict):
    id: str
    controllables: ControllableScheduleActionsDict


class ScheduleResponseDict(TypedDict):
    executionEnabled: bool
    slots: list[ScheduleSlotDict]
    runtime: NotRequired["ScheduleRuntimeDict"]


@dataclass(frozen=True)
class ScheduleAction:
    kind: ScheduleActionKind
    target_soc: int | None = None
    set_by: ScheduleActionSetBy | None = None
    # False marks a "candidate" action: placed by an optimizer whose execution
    # condition is currently not met. Candidates are excluded from resource
    # accounting (demand/battery forecast) and are not executed, but remain in
    # the schedule for display and promotion. Default True == committed.
    condition_met: bool = True


EMPTY_SCHEDULE_ACTION = ScheduleAction(kind=SCHEDULE_ACTION_EMPTY)
NORMAL_SCHEDULE_ACTION = ScheduleAction(kind=SCHEDULE_ACTION_NORMAL)


#: One controllable's action, in memory.
#:
#: The inverter's stays the validated :class:`ScheduleAction` it has always
#: been — its ``kind``/``target_soc`` pair drives the battery simulation and is
#: read attribute-wise by the forecast, the executor and three optimizers —
#: while an appliance's stays the plain dict its own per-kind normalizer owns.
#: The map is what unified; the shapes inside it never were the same.
ControllableScheduleAction = ScheduleAction | ApplianceScheduleActionDict
#: Every controllable's action for one slot, keyed by controllable id.
#:
#: The inverter sits under its reserved ``inverter`` id as a peer, which is what
#: replaced the old two-member ``ScheduleDomains``. An action that means
#: "nothing scheduled" is never stored: an appliance says that by being absent,
#: and since version 8 so does the inverter, so ``not actions`` is the whole of
#: "this slot is empty".
ControllableScheduleActions = dict[str, ControllableScheduleAction]


def build_controllable_actions(
    *,
    inverter: ScheduleAction | None = None,
    appliances: Mapping[str, ApplianceScheduleActionDict] | None = None,
) -> ControllableScheduleActions:
    """One slot's action map, assembled from the two halves that produce it.

    Optimizers, the merge and the executor each still author *either* an
    inverter action *or* appliance actions — that is a fact about what they
    drive, not a leftover of the old split — so this is the one place that knows
    the inverter's reserved id and that an empty inverter action is stored as
    absence.
    """
    actions: ControllableScheduleActions = {}
    if inverter is not None and inverter.kind != SCHEDULE_ACTION_EMPTY:
        actions[CONTROLLABLE_ID_INVERTER] = inverter
    if appliances:
        actions.update(
            {
                appliance_id: dict(action)
                for appliance_id, action in appliances.items()
            }
        )
    return actions


def inverter_action(actions: Mapping[str, Any]) -> ScheduleAction:
    """The inverter's action for a slot, empty when it has none."""
    action = actions.get(CONTROLLABLE_ID_INVERTER)
    return EMPTY_SCHEDULE_ACTION if action is None else action


def appliance_actions(actions: Mapping[str, Any]) -> ApplianceScheduleActionsDict:
    """Everything in the map that is not the inverter."""
    return {
        controllable_id: action
        for controllable_id, action in actions.items()
        if controllable_id != CONTROLLABLE_ID_INVERTER
    }


@dataclass(frozen=True, init=False)
class ScheduleSlot:
    id: str
    controllables: ControllableScheduleActions

    def __init__(
        self,
        id: str,
        *,
        action: ScheduleAction | Mapping[str, Any] | None = None,
        controllables: Mapping[str, Any] | None = None,
    ) -> None:
        if action is not None and controllables is not None:
            raise ValueError(
                "ScheduleSlot accepts either action or controllables, not both"
            )

        object.__setattr__(self, "id", id)
        object.__setattr__(
            self,
            "controllables",
            build_controllable_actions(inverter=_coerce_schedule_action(action))
            if controllables is None
            else _coerce_controllable_actions(controllables),
        )

    @property
    def action(self) -> ScheduleAction:
        return inverter_action(self.controllables)


@dataclass(init=False)
class ScheduleDocument:
    execution_enabled: bool = False
    slots: dict[str, ControllableScheduleActions] = field(default_factory=dict)

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
                slot_id: _coerce_controllable_actions(actions)
                for slot_id, actions in dict(slots).items()
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
    try:
        set_by = _read_action_set_by(data)
    except ValueError as err:
        raise ScheduleActionError(str(err)) from err

    action = ScheduleAction(
        kind=kind,
        target_soc=target_soc,
        set_by=set_by,
        condition_met=_read_condition_met(data),
    )
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
    if action.set_by is not None:
        payload["setBy"] = action.set_by
    if not action.condition_met:
        payload["conditionMet"] = False
    return payload


def controllable_actions_from_dict(
    data: Any, *, context: str
) -> ControllableScheduleActions:
    """One slot's flat, id-keyed action map, as read off the wire or storage.

    Only the inverter's entry is parsed into a :class:`ScheduleAction`; every
    other id keeps the raw dict its own kind's normalizer validates later, since
    which kind an id names is a fact about the *config*, which this layer does
    not have. An inverter action of kind ``empty`` is dropped rather than kept,
    so "nothing scheduled" is spelled the same way for every controllable.
    """
    if not isinstance(data, Mapping):
        raise ScheduleActionError(f"{context} controllables must be an object")

    raw_inverter = data.get(CONTROLLABLE_ID_INVERTER)
    if raw_inverter is not None and not isinstance(raw_inverter, Mapping):
        raise ScheduleActionError(
            f"{context} controllables.{CONTROLLABLE_ID_INVERTER} must be an object"
        )

    try:
        appliances = read_appliance_schedule_actions(
            {
                controllable_id: action
                for controllable_id, action in data.items()
                if controllable_id != CONTROLLABLE_ID_INVERTER
            },
            context=f"{context} controllables",
        )
    except ValueError as err:
        raise ScheduleActionError(str(err)) from err

    return build_controllable_actions(
        inverter=None if raw_inverter is None else action_from_dict(raw_inverter),
        appliances=appliances,
    )


def controllable_actions_to_dict(
    actions: Mapping[str, Any],
) -> ControllableScheduleActionsDict:
    payload: ControllableScheduleActionsDict = {}
    for controllable_id, action in actions.items():
        payload[controllable_id] = (
            dict(action) if isinstance(action, Mapping) else action_to_dict(action)
        )
    return payload


def slot_from_dict(data: Mapping[str, Any]) -> ScheduleSlot:
    if not isinstance(data, Mapping):
        raise ScheduleSlotsError("Schedule slot must be an object")

    slot_id = _read_non_empty_string(data.get("id"))
    if slot_id is None:
        raise ScheduleSlotsError("Schedule slot id must be a non-empty string")

    if "action" in data or "domains" in data:
        raise ScheduleActionError(
            "Legacy schedule payload uses top-level 'action' or 'domains'; use "
            "'controllables' keyed by controllable id instead"
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
        controllables=controllable_actions_from_dict(
            data.get("controllables", {}), context="Schedule slot"
        ),
    )


def slot_to_dict(
    slot: ScheduleSlot,
) -> ScheduleSlotDict:
    return {
        "id": slot.id,
        "controllables": controllable_actions_to_dict(slot.controllables),
    }


def with_slot_set_by(
    slot: ScheduleSlot,
    *,
    set_by: ScheduleActionSetBy | None,
) -> ScheduleSlot:
    if set_by is None:
        return slot

    current_inverter = inverter_action(slot.controllables)
    return ScheduleSlot(
        id=slot.id,
        controllables=build_controllable_actions(
            inverter=ScheduleAction(
                kind=current_inverter.kind,
                target_soc=current_inverter.target_soc,
                set_by=current_inverter.set_by or set_by,
                condition_met=current_inverter.condition_met,
            ),
            appliances=with_appliance_schedule_actions_set_by(
                appliance_actions(slot.controllables),
                set_by=set_by,
            ),
        ),
    )


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

    slots: dict[str, ControllableScheduleActions] = {}
    for raw_slot_id, raw_actions in raw_slots.items():
        slot_id = _read_non_empty_string(raw_slot_id)
        if slot_id is None:
            raise ScheduleSlotsError(
                "Persisted schedule slot ids must be non-empty strings"
            )
        if not isinstance(raw_actions, Mapping):
            raise ScheduleActionError("Persisted schedule slot must be an object")
        if any(key in raw_actions for key in ("kind", "targetSoc", "target_soc")):
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

        actions = controllable_actions_from_dict(
            _convert_legacy_slot_domains(raw_actions),
            context="Persisted schedule slot",
        )
        if not actions:
            continue

        slots[canonical_slot_id] = actions

    return ScheduleDocument(execution_enabled=execution_enabled, slots=slots)


def _convert_legacy_slot_domains(raw_slot: Mapping[str, Any]) -> Mapping[str, Any]:
    """Flatten a pre-version-8 ``{inverter, appliances}`` slot, in place on load.

    The reshape is mechanical — the appliance map's entries move up one level
    and the inverter's action takes its reserved id — so a stored schedule
    converts silently on first start instead of being thrown away. Every field
    survives: the inverter's action dict is passed through untouched, so
    ``kind``, ``targetSoc``, ``setBy`` and ``conditionMet`` all arrive at
    :func:`action_from_dict` exactly as they were written.

    Recognising the old shape has to be positive rather than negative, because
    the new shape is also a mapping of ids to action objects. ``appliances``
    present *and* holding a map of maps is the signature no new-shape slot can
    have: a controllable literally named ``appliances`` would carry its own
    kind's action (``{"on": true}``, ``{"mode": "heat"}``), whose values are
    scalars. Anything the conversion cannot make sense of is left alone and
    fails validation below, where the reject-and-reset path already lives —
    the schedule is a rolling 48-hour horizon, so the worst case is two days of
    manual entries.
    """
    raw_appliances = raw_slot.get("appliances")
    if not isinstance(raw_appliances, Mapping):
        return raw_slot
    if not all(isinstance(action, Mapping) for action in raw_appliances.values()):
        return raw_slot
    if any(key not in LEGACY_SCHEDULE_DOMAIN_KEYS for key in raw_slot):
        return raw_slot

    converted: dict[str, Any] = dict(raw_appliances)
    raw_inverter = raw_slot.get(CONTROLLABLE_ID_INVERTER)
    if raw_inverter is not None:
        converted[CONTROLLABLE_ID_INVERTER] = raw_inverter
    return converted


def schedule_document_to_dict(doc: ScheduleDocument) -> dict[str, Any]:
    return {
        "executionEnabled": doc.execution_enabled,
        "slotMinutes": SCHEDULE_SLOT_MINUTES,
        "slots": {
            slot_id: controllable_actions_to_dict(actions)
            for slot_id, actions in sorted(doc.slots.items())
            if actions
        },
    }


def _read_inverter_mode_control(
    config: Mapping[str, Any],
) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    """``controls.mode`` and its ``options`` for the inverter controllable.

    Since config version 7 the inverter is one entry in ``controllables:``
    rather than a section of its own, so this is where the old
    ``scheduler.control`` / ``action_option_map`` pair is now read from. The
    returned dataclass is unchanged — only its source moved.
    """
    inverter = find_inverter_controllable(config)
    mode_config = _read_mapping(_read_mapping(inverter.get("controls")).get("mode"))
    return (mode_config, _read_mapping(mode_config.get("options")))


def read_schedule_control_config(
    config: Mapping[str, Any],
) -> ScheduleControlConfig | None:
    control_config, action_option_map = _read_inverter_mode_control(config)

    mode_entity_id = _read_non_empty_string(control_config.get("entity_id"))
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
    control_config, action_option_map = _read_inverter_mode_control(config)

    missing_fields: list[str] = []
    if _read_non_empty_string(control_config.get("entity_id")) is None:
        missing_fields.append(f"{_INVERTER_CONTROL_PATH}.entity_id")
    if _read_non_empty_string(action_option_map.get(SCHEDULE_ACTION_NORMAL)) is None:
        missing_fields.append(f"{_INVERTER_CONTROL_PATH}.options.normal")
    if _read_non_empty_string(action_option_map.get(SCHEDULE_ACTION_STOP_CHARGING)) is None:
        missing_fields.append(f"{_INVERTER_CONTROL_PATH}.options.stop_charging")
    if _read_non_empty_string(action_option_map.get(SCHEDULE_ACTION_STOP_DISCHARGING)) is None:
        missing_fields.append(f"{_INVERTER_CONTROL_PATH}.options.stop_discharging")

    if not missing_fields:
        return None

    return "missing required inverter control config values: " + ", ".join(
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
    stored_slots: Mapping[str, ControllableScheduleActions],
    reference_time: datetime,
) -> list[ScheduleSlot]:
    return [
        ScheduleSlot(
            id=slot_id,
            controllables=stored_slots.get(slot_id, {}),
        )
        for slot_id in iter_horizon_slot_ids(reference_time)
    ]


def find_active_slot(
    *,
    stored_slots: Mapping[str, ControllableScheduleActions],
    reference_time: datetime,
) -> ScheduleSlot | None:
    slot_id = format_slot_id(build_horizon_start(reference_time))
    actions = stored_slots.get(slot_id)
    if actions is None:
        return None
    return ScheduleSlot(id=slot_id, controllables=actions)


def apply_slot_patches(
    *,
    stored_slots: Mapping[str, ControllableScheduleActions],
    slot_patches: Sequence[ScheduleSlot],
) -> dict[str, ControllableScheduleActions]:
    updated_slots = dict(stored_slots)

    for slot_patch in slot_patches:
        if slot_patch.controllables:
            updated_slots[slot_patch.id] = slot_patch.controllables
        else:
            updated_slots.pop(slot_patch.id, None)

    return dict(sorted(updated_slots.items()))


def prune_expired_slots(
    *,
    stored_slots: Mapping[str, ControllableScheduleActions],
    reference_time: datetime,
) -> dict[str, ControllableScheduleActions]:
    reference_local = dt_util.as_local(reference_time)
    pruned_slots = {
        slot_id: actions
        for slot_id, actions in stored_slots.items()
        if parse_slot_id(slot_id) + SCHEDULE_SLOT_DURATION > reference_local
    }
    return dict(sorted(pruned_slots.items()))


def normalize_slot_patch(
    *,
    slot_id: str,
    controllables: ControllableScheduleActions,
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
        controllables=normalize_controllable_actions(
            controllables=controllables,
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
                controllables=slot.controllables,
                reference_time=reference_time,
                battery_soc_bounds=battery_soc_bounds,
                appliances_registry=appliances_registry,
            )
        )

    return normalized_slots


def strip_candidate_actions(doc: "ScheduleDocument") -> "ScheduleDocument":
    """Return a copy with candidate (condition-not-met) actions removed.

    Candidates are placed by optimizers whose execution condition is currently
    not met. They stay in the stored schedule for display and promotion, but
    must not consume resources (forecast rebuild) nor be executed — callers use
    this "committed" view for both.
    """
    stripped_slots: dict[str, ControllableScheduleActions] = {}
    for slot_id, actions in doc.slots.items():
        stripped: ControllableScheduleActions = {}
        for controllable_id, action in actions.items():
            if not isinstance(action, Mapping):
                if action.condition_met:
                    stripped[controllable_id] = action
                continue
            if action.get("conditionMet") is not False:
                stripped[controllable_id] = dict(action)
        if not stripped:
            continue
        stripped_slots[slot_id] = stripped

    return ScheduleDocument(
        execution_enabled=doc.execution_enabled,
        slots=stripped_slots,
    )


def normalize_controllable_actions(
    *,
    controllables: Mapping[str, Any],
    battery_soc_bounds: BatterySocBounds | None,
    require_target_soc_bounds: bool,
    appliances_registry: AppliancesRuntimeRegistry | None,
    context: str,
    appliance_mode: Literal["strict", "load_prune"],
) -> ControllableScheduleActions:
    registry = (
        AppliancesRuntimeRegistry() if appliances_registry is None else appliances_registry
    )

    inverter = inverter_action(controllables)
    _validate_action(
        action=inverter,
        has_target_soc=inverter.target_soc is not None,
        battery_soc_bounds=battery_soc_bounds,
        require_target_soc_bounds=require_target_soc_bounds,
    )

    try:
        appliances = normalize_appliance_schedule_actions(
            appliance_actions(controllables),
            registry=registry,
            context=f"{context} controllables",
            mode=appliance_mode,
        )
    except ValueError as err:
        raise ScheduleActionError(str(err)) from err

    return build_controllable_actions(inverter=inverter, appliances=appliances)


def normalize_schedule_document_for_registry(
    doc: ScheduleDocument,
    *,
    appliances_registry: AppliancesRuntimeRegistry,
) -> ScheduleDocument:
    normalized_slots: dict[str, ControllableScheduleActions] = {}

    for slot_id, actions in doc.slots.items():
        normalized = normalize_controllable_actions(
            controllables=actions,
            battery_soc_bounds=None,
            require_target_soc_bounds=False,
            appliances_registry=appliances_registry,
            context="Persisted schedule slot",
            appliance_mode="load_prune",
        )
        if not normalized:
            continue
        normalized_slots[slot_id] = normalized

    return ScheduleDocument(
        execution_enabled=doc.execution_enabled,
        slots=normalized_slots,
    )


def _coerce_controllable_actions(value: Any) -> ControllableScheduleActions:
    """Accept whatever a caller has and return the canonical id-keyed map.

    Callers hand in already-built maps (the common case), raw wire mappings, or
    — in tests — a bare inverter action. The inverter's entry is coerced to a
    validated :class:`ScheduleAction` whichever way it arrived; every other
    entry stays the dict its own kind owns.
    """
    if value is None:
        return {}

    if not isinstance(value, Mapping):
        return build_controllable_actions(inverter=_coerce_schedule_action(value))

    raw_inverter = value.get(CONTROLLABLE_ID_INVERTER)
    return build_controllable_actions(
        inverter=(
            None if raw_inverter is None else _coerce_schedule_action(raw_inverter)
        ),
        appliances=_coerce_appliances_mapping(
            {
                controllable_id: action
                for controllable_id, action in value.items()
                if controllable_id != CONTROLLABLE_ID_INVERTER
            }
        ),
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

    try:
        set_by = read_optional_schedule_action_set_by(
            getattr(value, "set_by", getattr(value, "setBy", None)),
            path="Schedule action setBy",
        )
    except ValueError as err:
        raise ScheduleActionError(str(err)) from err

    action = ScheduleAction(
        kind=kind,
        target_soc=raw_target_soc,
        set_by=set_by,
        condition_met=bool(
            getattr(value, "condition_met", getattr(value, "conditionMet", True))
        ),
    )
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


def _read_condition_met(data: Mapping[str, Any]) -> bool:
    if "conditionMet" in data:
        raw = data["conditionMet"]
    elif "condition_met" in data:
        raw = data["condition_met"]
    else:
        return True
    return raw if isinstance(raw, bool) else True


def _read_action_set_by(data: Mapping[str, Any]) -> ScheduleActionSetBy | None:
    if "setBy" in data:
        raw_set_by = data["setBy"]
    elif "set_by" in data:
        raw_set_by = data["set_by"]
    else:
        return None

    return read_optional_schedule_action_set_by(
        raw_set_by,
        path="Schedule action setBy",
    )


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
