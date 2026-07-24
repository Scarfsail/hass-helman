import type { LocalizeFunction } from "../../localize/localize";
import type { ScheduleOwnerSnapshot } from "../schedule-types";

export interface ScheduleHeaderModel {
    runningLabel: string;
    runningExpanded: boolean;
    runningToggleDisabled: boolean;
    executionEnabled: boolean;
    refreshDisabled: boolean;
    toggleDisabled: boolean;
    refreshLabel: string;
    toggleLabel: string;
}

export const EMPTY_SCHEDULE_HEADER_MODEL: ScheduleHeaderModel = {
    runningLabel: "",
    runningExpanded: false,
    runningToggleDisabled: true,
    executionEnabled: false,
    refreshDisabled: true,
    toggleDisabled: true,
    refreshLabel: "",
    toggleLabel: "",
};

export function buildScheduleHeaderModel({
    snapshot,
    runningCount,
    controllableCount,
    runningExpanded,
    localize,
}: {
    snapshot: ScheduleOwnerSnapshot;
    runningCount: number;
    controllableCount: number;
    runningExpanded: boolean;
    localize: LocalizeFunction;
}): ScheduleHeaderModel {
    return {
        // The header doubles as the disclosure for the entity list, so it
        // states counts rather than a static caption: what is on, against how
        // much there is to be on, which is what the expanded list shows.
        runningLabel: `${localize("scheduling.running.label")}: ${runningCount} / ${controllableCount}`,
        runningExpanded,
        // The list is worth opening even with nothing running: it is also the
        // roster of what Helman can drive, and what each one will do next.
        runningToggleDisabled: controllableCount === 0,
        executionEnabled: snapshot.schedule?.executionEnabled ?? false,
        refreshDisabled: snapshot.loading || snapshot.refreshing || snapshot.togglingExecution,
        toggleDisabled: snapshot.schedule === null || snapshot.loading || snapshot.togglingExecution,
        refreshLabel: localize("scheduling.actions.refresh"),
        toggleLabel: localize("scheduling.execution.toggle"),
    };
}
