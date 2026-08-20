from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import TYPE_CHECKING, Any

from ..const import SCHEDULE_ACTION_EMPTY

if TYPE_CHECKING:
    from ..scheduling.schedule import (
        ControllableScheduleAction,
        ControllableScheduleActions,
        ScheduleAction,
        ScheduleDocument,
    )


def strip_automation_owned_actions(doc: "ScheduleDocument") -> "ScheduleDocument":
    from ..scheduling.schedule import ControllableScheduleActions, ScheduleDocument

    stripped_slots: dict[str, ControllableScheduleActions] = {}

    for slot_id, actions in doc.slots.items():
        stripped = {
            controllable_id: action
            for controllable_id, action in actions.items()
            if not _is_automation_owned(action)
        }
        if not stripped:
            continue
        stripped_slots[slot_id] = stripped

    return ScheduleDocument(
        execution_enabled=doc.execution_enabled,
        slots=stripped_slots,
    )


def restore_automation_owned_appliance_actions(
    *,
    baseline: "ScheduleDocument",
    current: "ScheduleDocument",
    appliance_ids: "Iterable[str]",
) -> "ScheduleDocument":
    """``current`` with the named appliance lanes taken back from ``baseline``.

    Only lanes ``current`` says nothing about are restored, so a lane an
    optimizer has already re-planned this run keeps its fresh actions.
    """
    from ..scheduling.schedule import ControllableScheduleActions, ScheduleDocument

    wanted = tuple(appliance_ids)
    if not wanted:
        return current

    restored_slots: dict[str, ControllableScheduleActions] = {}
    for slot_id in sorted(set(baseline.slots) | set(current.slots)):
        baseline_actions = baseline.slots.get(slot_id, {})
        restored = dict(current.slots.get(slot_id, {}))
        for appliance_id in wanted:
            baseline_action = baseline_actions.get(appliance_id)
            if appliance_id not in restored and _is_automation_owned(baseline_action):
                restored[appliance_id] = dict(baseline_action)
        if not restored:
            continue
        restored_slots[slot_id] = restored

    return ScheduleDocument(
        execution_enabled=current.execution_enabled,
        slots=restored_slots,
    )


def has_automation_owned_actions(doc: "ScheduleDocument") -> bool:
    return any(
        _is_automation_owned(action)
        for actions in doc.slots.values()
        for action in actions.values()
    )


def count_automation_owned_actions(doc: "ScheduleDocument") -> int:
    return sum(
        1
        for actions in doc.slots.values()
        for action in actions.values()
        if _is_automation_owned(action)
    )


def merge_automation_result(
    *,
    baseline: "ScheduleDocument",
    automation_result: "ScheduleDocument",
) -> "ScheduleDocument":
    from ..scheduling.schedule import ControllableScheduleActions, ScheduleDocument

    clean_baseline = strip_automation_owned_actions(baseline)
    merged_slots: dict[str, ControllableScheduleActions] = {}

    for slot_id in sorted(set(clean_baseline.slots) | set(automation_result.slots)):
        merged = _merge_slot_actions(
            slot_id=slot_id,
            baseline=clean_baseline.slots.get(slot_id, {}),
            automation_result=automation_result.slots.get(slot_id, {}),
        )
        if not merged:
            continue
        merged_slots[slot_id] = merged

    return ScheduleDocument(
        execution_enabled=baseline.execution_enabled,
        slots=merged_slots,
    )


def _merge_slot_actions(
    *,
    slot_id: str,
    baseline: Mapping[str, Any],
    automation_result: Mapping[str, Any],
) -> "ControllableScheduleActions":
    """Fold one slot's automation result onto the user-owned baseline.

    One function over the id-keyed map, where there used to be one per domain.
    The two arms were not the same rule, and collapsing them is a decision
    rather than a merge conflict. Both raised when a user-owned baseline
    position was written differently by the automation, but they disagreed on
    what "differently" means: the inverter arm compared kind, ``target_soc``
    and ``set_by`` only (``_schedule_actions_match``), so a result that differed
    solely in ``condition_met`` passed silently; the appliance arm compared the
    action dicts whole, so any difference at all raised.

    **The appliance's rule wins: any difference raises.** Reaching this
    comparison with a user-owned baseline at all is already the anomaly — every
    optimizer goes through :class:`ScheduleWriter`, which vetoes a user-owned
    slot and records ``blocked_user_owned`` rather than writing it, and the
    result document is a deep copy of the snapshot, so an untouched user action
    arrives byte-identical. A mismatch therefore means either an optimizer wrote
    past the veto or the stored schedule moved under a run in flight, and both
    of those are things to hear about. The inverter's leniency hid exactly one
    case — an automation re-stamping a user's action as a candidate — which is
    the case where silence is least defensible, and bought nothing in exchange:
    the lenient branch discarded the result and kept the baseline anyway.

    Cost of the stricter rule is bounded by that same veto: no optimizer can
    reach here with a user-owned baseline in normal operation, so the raise is a
    diagnostic, not a new failure mode.
    """
    from ..scheduling.schedule import ScheduleActionError

    merged: dict[str, Any] = {}

    for controllable_id in sorted(set(baseline) | set(automation_result)):
        baseline_action = baseline.get(controllable_id)
        result_action = automation_result.get(controllable_id)

        if baseline_action is not None:
            if result_action != baseline_action:
                raise ScheduleActionError(
                    "Automation cannot overwrite user-owned action for "
                    f"controllable {controllable_id!r} in slot {slot_id}"
                )
            merged[controllable_id] = (
                dict(baseline_action)
                if isinstance(baseline_action, Mapping)
                else baseline_action
            )
            continue

        if result_action is None:
            continue

        merged[controllable_id] = _stamp_automation(result_action)

    return merged


def _stamp_automation(action: "ControllableScheduleAction") -> Any:
    """Mark an action as the automation's, in whichever shape it arrived.

    Dispatch is on ``Mapping`` rather than on ``isinstance(..., ScheduleAction)``
    because several test modules install a stub ``scheduling.schedule``, which
    makes the class identity two different objects while the value is still the
    real one. "Is this a plain action dict?" is also the honest question: it is
    the shape that decides, not the class.
    """
    from ..scheduling.schedule import ScheduleAction

    if isinstance(action, Mapping):
        return stamp_automation_appliance_action(action)
    return ScheduleAction(
        kind=action.kind,
        target_soc=action.target_soc,
        set_by="automation",
        condition_met=action.condition_met,
    )


def is_user_owned_appliance_action(
    action: Mapping[str, object] | None,
) -> bool:
    return action is not None and action.get("setBy") != "automation"


def is_user_owned_inverter_action(action: "ScheduleAction") -> bool:
    return action.kind != SCHEDULE_ACTION_EMPTY and action.set_by != "automation"


def _is_automation_owned(action: Any) -> bool:
    """Whether an action in the id-keyed map was placed by the automation.

    Both shapes carry the same fact under the same name; only the accessor
    differs, because the inverter's action is a dataclass and an appliance's is
    the dict its own kind's normalizer owns.
    """
    if action is None:
        return False
    if isinstance(action, Mapping):
        return action.get("setBy") == "automation"
    return action.set_by == "automation"


def stamp_automation_appliance_action(
    action: Mapping[str, object],
    *,
    condition_met: bool = True,
) -> dict[str, object]:
    stamped = {str(key): value for key, value in action.items()}
    stamped["setBy"] = "automation"
    if not condition_met:
        stamped["conditionMet"] = False
    return stamped
