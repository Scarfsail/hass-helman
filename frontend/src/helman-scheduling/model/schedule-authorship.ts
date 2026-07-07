import type { ScheduleActionDTO, ScheduleApplianceActionDTO, ScheduleDomainsDTO } from "../../helman-api";
import type {
    ScheduleAction,
    ScheduleActionAuthorshipSummary,
    ScheduleApplianceAction,
    ScheduleAssignments,
    ScheduleSetBy,
} from "../schedule-types";

export class InvalidScheduleAuthorshipError extends Error {}

export function extractScheduleSlotAssignments(
    domains: ScheduleDomainsDTO,
    slotId: string,
): ScheduleAssignments {
    return {
        inverter: {
            action: stripScheduleInverterSetBy(domains.inverter),
            setBy: _readSetBy(
                domains.inverter.setBy,
                `slot "${slotId}" inverter action`,
                domains.inverter.kind === "empty",
            ),
        },
        appliances: Object.fromEntries(
            Object.entries(domains.appliances).map(([applianceId, action]) => [
                applianceId,
                {
                    action: stripScheduleApplianceSetBy(action),
                    setBy: _readSetBy(
                        action.setBy,
                        `slot "${slotId}" appliance "${applianceId}" action`,
                    ),
                },
            ]),
        ),
    };
}

export function stripScheduleInverterSetBy(action: ScheduleActionDTO): ScheduleAction {
    return action.targetSoc === undefined
        ? { kind: action.kind }
        : { kind: action.kind, targetSoc: action.targetSoc };
}

export function stripScheduleApplianceSetBy(
    action: ScheduleApplianceActionDTO,
): ScheduleApplianceAction {
    const { setBy: _ignoredSetBy, ...valueAction } = action;
    return valueAction;
}

export function summarizeScheduleAuthorship(
    values: readonly (ScheduleSetBy | null | undefined)[],
): ScheduleActionAuthorshipSummary {
    const counts = values.reduce(
        (summary, value) => {
            if (value === "user" || value === "automation") {
                summary[value] += 1;
            }
            return summary;
        },
        { user: 0, automation: 0 },
    );

    return {
        state: _resolveAuthorshipState(counts),
        counts,
    };
}

export function mergeScheduleAuthorshipSummaries(
    summaries: readonly (ScheduleActionAuthorshipSummary | null | undefined)[],
): ScheduleActionAuthorshipSummary {
    const counts = summaries.reduce(
        (merged, summary) => ({
            user: merged.user + (summary?.counts.user ?? 0),
            automation: merged.automation + (summary?.counts.automation ?? 0),
        }),
        { user: 0, automation: 0 },
    );

    return {
        state: _resolveAuthorshipState(counts),
        counts,
    };
}

function _readSetBy(
    value: unknown,
    context: string,
    allowMissing = false,
): ScheduleSetBy | null {
    if (allowMissing) {
        return null;
    }

    if (value === "user" || value === "automation") {
        return value;
    }

    throw new InvalidScheduleAuthorshipError(
        `helman-scheduling: invalid schedule payload, missing setBy for ${context}`,
    );
}

function _resolveAuthorshipState(
    counts: ScheduleActionAuthorshipSummary["counts"],
): ScheduleActionAuthorshipSummary["state"] {
    if (counts.user > 0 && counts.automation > 0) {
        return "mixed";
    }
    if (counts.automation > 0) {
        return "automation";
    }
    if (counts.user > 0) {
        return "user";
    }
    return "none";
}
