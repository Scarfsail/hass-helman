import type {
    ScheduleControllableActions,
    ScheduleEditIntent,
    ScheduleRangeEditIntent,
    ScheduleSlot,
    ScheduleSlotPatch,
} from "../schedule-types";
import {
    areScheduleControllableActionsEqual,
    cloneScheduleControllableAction,
    cloneScheduleControllableActions,
} from "../schedule-types";

/**
 * One batch of slot patches from one edit intent.
 *
 * A patch carries the slot's whole set of *user* actions, so the builder starts
 * from what the user already owns and applies the intent on top: the
 * automation's own placements are deliberately not echoed back, which is what
 * lets the backend tell "the user left this alone" from "the user cleared it".
 *
 * One loop over one map, where there used to be an inverter arm beside an
 * appliance one -- the two now differ in nothing at all, including how they
 * spell "nothing here" (`unset_user`).
 */
export function buildScheduleSlotPatches({
    selectedSlots,
    result,
}: {
    selectedSlots: readonly ScheduleSlot[];
    result: ScheduleRangeEditIntent;
}): ScheduleSlotPatch[] {
    const patches: ScheduleSlotPatch[] = [];
    for (const slot of selectedSlots) {
        const current = _buildCurrentUserActions(slot);
        const next = _buildNextActions(current, result);
        if (
            !_requiresForcedPatch(slot, result)
            && areScheduleControllableActionsEqual(current, next)
        ) {
            continue;
        }

        patches.push({
            id: slot.id,
            controllables: next,
        });
    }

    return patches;
}

function _buildCurrentUserActions(slot: ScheduleSlot): ScheduleControllableActions {
    return Object.fromEntries(
        Object.entries(slot.assignments).flatMap(([controllableId, assignment]) =>
            assignment.setBy === "user"
                ? [[controllableId, cloneScheduleControllableAction(assignment.action)]]
                : []
        ),
    );
}

function _buildNextActions(
    current: ScheduleControllableActions,
    result: ScheduleRangeEditIntent,
): ScheduleControllableActions {
    const next = cloneScheduleControllableActions(current);
    for (const [controllableId, intent] of Object.entries(result)) {
        _applyIntent(next, controllableId, intent);
    }

    return next;
}

function _applyIntent(
    next: ScheduleControllableActions,
    controllableId: string,
    intent: ScheduleEditIntent,
): void {
    if (intent.kind === "keep") {
        return;
    }

    if (intent.kind === "unset_user") {
        delete next[controllableId];
        return;
    }

    next[controllableId] = cloneScheduleControllableAction(intent.action);
}

/**
 * A patch is still sent when the intent takes a lane over from the automation,
 * even though the resulting user actions look unchanged: the point of that
 * write is the takeover itself.
 */
function _requiresForcedPatch(slot: ScheduleSlot, result: ScheduleRangeEditIntent): boolean {
    return Object.entries(result).some(([controllableId, intent]) =>
        intent.kind !== "keep" && slot.assignments[controllableId]?.setBy !== "user"
    );
}
