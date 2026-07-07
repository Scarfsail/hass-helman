import type { ScheduleApplianceMetadata } from "./schedule-appliance-metadata";
import { summarizeScheduleAuthorship } from "./schedule-authorship";
import type {
    ScheduleAction,
    ScheduleApplianceAction,
    ScheduleRangeEditAuthorshipSummary,
    ScheduleDialogState,
    ScheduleSelectionValueSummary,
    ScheduleSetBy,
    ScheduleSlot,
} from "../schedule-types";
import {
    cloneScheduleApplianceAction,
    cloneScheduleInverterAction,
    getScheduleActionIdentityKey,
    getScheduleApplianceActionIdentityKey,
} from "../schedule-types";

const NO_APPLIANCE_ACTION_KEY = "__no_action__";

export function buildScheduleRangeEditSelectionSummary({
    selectedSlots,
    appliances,
}: {
    selectedSlots: readonly ScheduleSlot[];
    appliances: readonly Pick<ScheduleApplianceMetadata, "id">[];
}): ScheduleDialogState["selectionSummary"] {
    return {
        inverter: _buildInverterSummary(selectedSlots),
        appliances: _buildApplianceSummaries(selectedSlots, appliances),
    };
}

export function buildScheduleRangeEditAuthorshipSummary({
    selectedSlots,
    appliances,
}: {
    selectedSlots: readonly ScheduleSlot[];
    appliances: readonly Pick<ScheduleApplianceMetadata, "id">[];
}): ScheduleDialogState["authorshipSummary"] {
    return {
        inverter: summarizeScheduleAuthorship(selectedSlots.map((slot) => slot.assignments.inverter.setBy)),
        appliances: _buildApplianceAuthorshipSummaries(selectedSlots, appliances),
    };
}

function _buildInverterSummary(
    selectedSlots: readonly ScheduleSlot[],
): ScheduleSelectionValueSummary<ScheduleAction> {
    const firstSlot = selectedSlots[0];
    if (!firstSlot) {
        return {
            state: "uniform",
            seedValue: { kind: "empty" },
            distinctValues: [{
                key: getScheduleActionIdentityKey({ kind: "empty" }),
                value: { kind: "empty" },
                authorship: summarizeScheduleAuthorship([]),
            }],
        };
    }

    return _buildSelectionSummary({
        values: selectedSlots.map((slot) => slot.assignments.inverter.action),
        authorships: selectedSlots.map((slot) => slot.assignments.inverter.setBy),
        cloneValue: (action) => cloneScheduleInverterAction(action),
        getKey: (action) => getScheduleActionIdentityKey(action),
    });
}

function _buildApplianceSummaries(
    selectedSlots: readonly ScheduleSlot[],
    appliances: readonly Pick<ScheduleApplianceMetadata, "id">[],
): Record<string, ScheduleSelectionValueSummary<ScheduleApplianceAction | null>> {
    const orderedApplianceIds = [
        ...appliances.map((appliance) => appliance.id),
        ...[...new Set(selectedSlots.flatMap((slot) => Object.keys(slot.assignments.appliances)))]
            .filter((applianceId) => !appliances.some((appliance) => appliance.id === applianceId))
            .sort((left, right) => left.localeCompare(right)),
    ];

    return Object.fromEntries(orderedApplianceIds.map((applianceId) => [
        applianceId,
        _buildSelectionSummary({
            values: selectedSlots.map((slot) => slot.assignments.appliances[applianceId]?.action ?? null),
            authorships: selectedSlots.map((slot) => slot.assignments.appliances[applianceId]?.setBy ?? null),
            cloneValue: (action) => action === null ? null : cloneScheduleApplianceAction(action),
            getKey: (action) => action === null ? NO_APPLIANCE_ACTION_KEY : getScheduleApplianceActionIdentityKey(action),
        }),
    ]));
}

function _buildApplianceAuthorshipSummaries(
    selectedSlots: readonly ScheduleSlot[],
    appliances: readonly Pick<ScheduleApplianceMetadata, "id">[],
): ScheduleRangeEditAuthorshipSummary["appliances"] {
    const orderedApplianceIds = [
        ...appliances.map((appliance) => appliance.id),
        ...[...new Set(selectedSlots.flatMap((slot) => Object.keys(slot.assignments.appliances)))]
            .filter((applianceId) => !appliances.some((appliance) => appliance.id === applianceId))
            .sort((left, right) => left.localeCompare(right)),
    ];

    return Object.fromEntries(orderedApplianceIds.map((applianceId) => [
        applianceId,
        summarizeScheduleAuthorship(selectedSlots.map((slot) => slot.assignments.appliances[applianceId]?.setBy ?? null)),
    ]));
}

function _buildSelectionSummary<TValue>({
    values,
    authorships,
    cloneValue,
    getKey,
}: {
    values: readonly TValue[];
    authorships: readonly (ScheduleSetBy | null)[];
    cloneValue: (value: TValue) => TValue;
    getKey: (value: TValue) => string;
}): ScheduleSelectionValueSummary<TValue> {
    const firstValue = values[0];
    if (firstValue === undefined) {
        throw new Error("Cannot build selection summary without at least one value");
    }

    const distinctValues: ScheduleSelectionValueSummary<TValue>["distinctValues"] = [];
    const seenKeys = new Set<string>();
    const authorshipsByKey = new Map<string, Array<ScheduleSetBy | null>>();

    for (const [index, value] of values.entries()) {
        const key = getKey(value);
        const optionAuthorships = authorshipsByKey.get(key) ?? [];
        optionAuthorships.push(authorships[index] ?? null);
        authorshipsByKey.set(key, optionAuthorships);
        if (seenKeys.has(key)) {
            continue;
        }

        seenKeys.add(key);
        distinctValues.push({
            key,
            value: cloneValue(value),
            authorship: null,
        });
    }

    for (const option of distinctValues) {
        option.authorship = summarizeScheduleAuthorship(authorshipsByKey.get(option.key) ?? []);
    }

    return {
        state: distinctValues.length > 1 ? "mixed" : "uniform",
        seedValue: cloneValue(firstValue),
        distinctValues,
    };
}
