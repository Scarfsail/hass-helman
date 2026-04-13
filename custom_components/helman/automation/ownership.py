from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

from ..const import SCHEDULE_ACTION_EMPTY

if TYPE_CHECKING:
    from ..scheduling.schedule import ScheduleAction, ScheduleDocument, ScheduleDomains


def strip_automation_owned_actions(doc: "ScheduleDocument") -> "ScheduleDocument":
    from ..scheduling.schedule import ScheduleAction, ScheduleDocument, ScheduleDomains
    from ..scheduling.schedule import is_default_domains

    stripped_slots: dict[str, ScheduleDomains] = {}

    for slot_id, domains in doc.slots.items():
        stripped_domains = ScheduleDomains(
            inverter=(
                ScheduleAction(kind=SCHEDULE_ACTION_EMPTY)
                if domains.inverter.set_by == "automation"
                else domains.inverter
            ),
            appliances={
                appliance_id: dict(action)
                for appliance_id, action in domains.appliances.items()
                if action.get("setBy") != "automation"
            },
        )
        if is_default_domains(stripped_domains):
            continue
        stripped_slots[slot_id] = stripped_domains

    return ScheduleDocument(
        execution_enabled=doc.execution_enabled,
        slots=stripped_slots,
    )


def merge_automation_result(
    *,
    baseline: "ScheduleDocument",
    automation_result: "ScheduleDocument",
) -> "ScheduleDocument":
    from ..scheduling.schedule import ScheduleDocument, ScheduleDomains
    from ..scheduling.schedule import is_default_domains

    clean_baseline = strip_automation_owned_actions(baseline)
    merged_slots: dict[str, ScheduleDomains] = {}

    for slot_id in sorted(set(clean_baseline.slots) | set(automation_result.slots)):
        baseline_domains = clean_baseline.slots.get(slot_id, ScheduleDomains())
        result_domains = automation_result.slots.get(slot_id, ScheduleDomains())
        merged_domains = _merge_slot_domains(
            slot_id=slot_id,
            baseline=baseline_domains,
            automation_result=result_domains,
        )
        if is_default_domains(merged_domains):
            continue
        merged_slots[slot_id] = merged_domains

    return ScheduleDocument(
        execution_enabled=baseline.execution_enabled,
        slots=merged_slots,
    )


def _merge_slot_domains(
    *,
    slot_id: str,
    baseline: "ScheduleDomains",
    automation_result: "ScheduleDomains",
) -> "ScheduleDomains":
    from ..scheduling.schedule import ScheduleDomains

    return ScheduleDomains(
        inverter=_merge_inverter_action(
            slot_id=slot_id,
            baseline=baseline.inverter,
            automation_result=automation_result.inverter,
        ),
        appliances=_merge_appliance_actions(
            slot_id=slot_id,
            baseline=baseline.appliances,
            automation_result=automation_result.appliances,
        ),
    )


def _merge_inverter_action(
    *,
    slot_id: str,
    baseline: "ScheduleAction",
    automation_result: "ScheduleAction",
) -> "ScheduleAction":
    from ..scheduling.schedule import ScheduleAction, ScheduleActionError

    if is_user_owned_inverter_action(baseline):
        if not _schedule_actions_match(automation_result, baseline):
            raise ScheduleActionError(
                f"Automation cannot overwrite user-owned inverter action in slot {slot_id}"
            )
        return baseline

    if automation_result.kind == SCHEDULE_ACTION_EMPTY:
        return ScheduleAction(kind=SCHEDULE_ACTION_EMPTY)

    return ScheduleAction(
        kind=automation_result.kind,
        target_soc=automation_result.target_soc,
        set_by="automation",
    )


def _merge_appliance_actions(
    *,
    slot_id: str,
    baseline: Mapping[str, dict[str, object]],
    automation_result: Mapping[str, dict[str, object]],
) -> dict[str, dict[str, object]]:
    from ..scheduling.schedule import ScheduleActionError

    merged: dict[str, dict[str, object]] = {}

    for appliance_id in sorted(set(baseline) | set(automation_result)):
        baseline_action = baseline.get(appliance_id)
        result_action = automation_result.get(appliance_id)

        if baseline_action is not None:
            if result_action != baseline_action:
                raise ScheduleActionError(
                    "Automation cannot overwrite user-owned appliance action "
                    f"{appliance_id!r} in slot {slot_id}"
                )
            merged[appliance_id] = dict(baseline_action)
            continue

        if result_action is not None:
            merged[appliance_id] = _stamp_automation_appliance_action(result_action)

    return merged

def is_user_owned_inverter_action(action: "ScheduleAction") -> bool:
    return action.kind != SCHEDULE_ACTION_EMPTY and action.set_by != "automation"


def _schedule_actions_match(
    left: "ScheduleAction",
    right: "ScheduleAction",
) -> bool:
    return (
        left.kind == right.kind
        and left.target_soc == right.target_soc
        and left.set_by == right.set_by
    )


def _stamp_automation_appliance_action(
    action: Mapping[str, object],
) -> dict[str, object]:
    stamped = {str(key): value for key, value in action.items()}
    stamped["setBy"] = "automation"
    return stamped
