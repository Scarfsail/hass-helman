import type {
    ScheduleActionDTO,
    ScheduleApplianceActionDTO,
    ScheduleControllableActionsDTO,
} from "../../../helman-api";
import type {
    ScheduleAction,
    ScheduleActionAuthorshipSummary,
    ScheduleApplianceAction,
    ScheduleAssignments,
    ScheduleSetBy,
} from "../schedule-types";

export class InvalidScheduleAuthorshipError extends Error {}

/**
 * The slot's stored actions as authored assignments, one entry per lane.
 *
 * `setBy` is required on every action that is present -- an entry with no
 * author is a payload bug, and always was; what changed is that the inverter
 * can now simply be absent instead of present-but-empty, so it needs no
 * "empty actions may have no author" exemption any more.
 */
export function extractScheduleSlotAssignments(
    controllables: ScheduleControllableActionsDTO,
    slotId: string,
): ScheduleAssignments {
    return Object.fromEntries(
        Object.entries(controllables).map(([controllableId, action]) => [
            controllableId,
            {
                action: "kind" in action
                    ? stripScheduleInverterSetBy(action)
                    : stripScheduleApplianceSetBy(action),
                setBy: _readSetBy(
                    action.setBy,
                    `slot "${slotId}" controllable "${controllableId}" action`,
                ),
            },
        ]),
    );
}

export function stripScheduleInverterSetBy(action: ScheduleActionDTO): ScheduleAction {
    // Strip only setBy; keep kind/targetSoc/conditionMet so candidate actions
    // still render muted in the plan.
    const { setBy: _ignoredSetBy, ...valueAction } = action;
    return valueAction;
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
): ScheduleSetBy | null {
    if (value === "user" || value === "automation") {
        return value;
    }

    throw new InvalidScheduleAuthorshipError(
        `schedule: invalid schedule payload, missing setBy for ${context}`,
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
