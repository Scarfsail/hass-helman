from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import replace
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..scheduling.schedule import (
        ControllableScheduleActions,
        ScheduleDocument,
        SlotAction,
    )


def strip_automation_owned_actions(
    doc: "ScheduleDocument",
    *,
    controllable_ids: "Iterable[str] | None" = None,
) -> "ScheduleDocument":
    """Drop automation-owned actions from ``doc``.

    With ``controllable_ids`` omitted, every automation-owned action in the
    document is dropped (the whole-run strip at the top of each automation
    run). Passing ``controllable_ids`` narrows the strip to just those lanes —
    used by phase 3 (#272) to clear the appliance lanes it is about to
    re-plan while leaving the phase-2 inverter/system lanes untouched, rather
    than adding a second stripper.
    """
    from ..scheduling.schedule import ScheduleDocument

    wanted = None if controllable_ids is None else frozenset(controllable_ids)

    stripped_slots: dict[str, ControllableScheduleActions] = {}

    for slot_id, actions in doc.slots.items():
        stripped = {
            controllable_id: action
            for controllable_id, action in actions.items()
            if not (
                (wanted is None or controllable_id in wanted)
                and not is_user_owned(action)
            )
        }
        if not stripped:
            continue
        stripped_slots[slot_id] = stripped

    return ScheduleDocument(
        execution_enabled=doc.execution_enabled,
        slots=stripped_slots,
    )


def has_automation_owned_actions(doc: "ScheduleDocument") -> bool:
    return any(
        not is_user_owned(action)
        for actions in doc.slots.values()
        for action in actions.values()
    )


def count_automation_owned_actions(doc: "ScheduleDocument") -> int:
    return sum(
        1
        for actions in doc.slots.values()
        for action in actions.values()
        if not is_user_owned(action)
    )


def merge_automation_result(
    *,
    baseline: "ScheduleDocument",
    automation_result: "ScheduleDocument",
) -> "ScheduleDocument":
    from ..scheduling.schedule import ScheduleDocument

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
    baseline: Mapping[str, "SlotAction"],
    automation_result: Mapping[str, "SlotAction"],
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

    merged: ControllableScheduleActions = {}

    for controllable_id in sorted(set(baseline) | set(automation_result)):
        baseline_action = baseline.get(controllable_id)
        result_action = automation_result.get(controllable_id)

        if baseline_action is not None:
            if result_action != baseline_action:
                raise ScheduleActionError(
                    "Automation cannot overwrite user-owned action for "
                    f"controllable {controllable_id!r} in slot {slot_id}"
                )
            merged[controllable_id] = baseline_action
            continue

        if result_action is None:
            continue

        merged[controllable_id] = replace(result_action, set_by="automation")

    return merged


def stamp_automation(
    action: "SlotAction", *, optimizer: str | None
) -> "SlotAction":
    """Mark an action as placed by the ``optimizer`` kind; its payload and
    candidacy are kept."""
    return replace(action, set_by="automation", optimizer=optimizer)


def is_user_owned(action: "SlotAction | None") -> bool:
    """Whether a position in a slot's action map is the user's.

    Anything the automation did not stamp is the user's, including a legacy
    action with no ``setBy`` at all; an absent entry means "nothing scheduled",
    which is nobody's.
    """
    return action is not None and action.set_by != "automation"
