import type {
    ScheduleApplianceEditIntent,
    ScheduleDomains,
    ScheduleRangeEditIntent,
    ScheduleSlot,
    ScheduleSlotPatch,
} from "../schedule-types";
import {
    areScheduleDomainsEqual,
    cloneScheduleApplianceAction,
    cloneScheduleDomains,
    cloneScheduleInverterAction,
} from "../schedule-types";

export function buildScheduleSlotPatches({
    selectedSlots,
    result,
}: {
    selectedSlots: readonly ScheduleSlot[];
    result: ScheduleRangeEditIntent;
}): ScheduleSlotPatch[] {
    const patches: ScheduleSlotPatch[] = [];
    for (const slot of selectedSlots) {
        const currentDomains = _buildCurrentUserDomains(slot);
        const nextDomains = _buildNextDomains(currentDomains, result);
        if (!_requiresForcedPatch(slot, result) && areScheduleDomainsEqual(currentDomains, nextDomains)) {
            continue;
        }

        patches.push({
            id: slot.id,
            domains: nextDomains,
        });
    }

    return patches;
}

function _buildCurrentUserDomains(slot: ScheduleSlot): ScheduleDomains {
    return {
        inverter: slot.assignments.inverter.setBy === "user"
            ? cloneScheduleInverterAction(slot.assignments.inverter.action)
            : { kind: "empty" },
        appliances: Object.fromEntries(
            Object.entries(slot.assignments.appliances).flatMap(([applianceId, assignment]) =>
                assignment.setBy === "user"
                    ? [[applianceId, cloneScheduleApplianceAction(assignment.action)]]
                    : []
            ),
        ),
    };
}

function _buildNextDomains(
    currentDomains: ScheduleDomains,
    result: ScheduleRangeEditIntent,
): ScheduleDomains {
    const nextDomains = cloneScheduleDomains(currentDomains);
    if (result.inverter.kind === "set_user") {
        nextDomains.inverter = cloneScheduleInverterAction(result.inverter.action);
    }

    for (const [applianceId, intent] of Object.entries(result.appliances)) {
        _applyApplianceIntent(nextDomains, applianceId, intent);
    }

    return nextDomains;
}

function _applyApplianceIntent(
    nextDomains: ScheduleDomains,
    applianceId: string,
    intent: ScheduleApplianceEditIntent,
): void {
    if (intent.kind === "keep") {
        return;
    }

    if (intent.kind === "unset_user") {
        delete nextDomains.appliances[applianceId];
        return;
    }

    nextDomains.appliances[applianceId] = cloneScheduleApplianceAction(intent.action);
}

function _requiresForcedPatch(slot: ScheduleSlot, result: ScheduleRangeEditIntent): boolean {
    if (result.inverter.kind === "set_user" && slot.assignments.inverter.setBy !== "user") {
        return true;
    }

    return Object.entries(result.appliances).some(([applianceId, intent]) =>
        intent.kind !== "keep" && slot.assignments.appliances[applianceId]?.setBy !== "user"
    );
}
