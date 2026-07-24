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
    runningExpanded,
    localize,
}: {
    snapshot: ScheduleOwnerSnapshot;
    runningCount: number;
    runningExpanded: boolean;
    localize: LocalizeFunction;
}): ScheduleHeaderModel {
    return {
        // The header doubles as the disclosure for the running-entity list, so
        // it states the count rather than a static caption.
        runningLabel: `${localize("scheduling.running.label")}: ${runningCount}`,
        runningExpanded,
        runningToggleDisabled: runningCount === 0,
        executionEnabled: snapshot.schedule?.executionEnabled ?? false,
        refreshDisabled: snapshot.loading || snapshot.refreshing || snapshot.togglingExecution,
        toggleDisabled: snapshot.schedule === null || snapshot.loading || snapshot.togglingExecution,
        refreshLabel: localize("scheduling.actions.refresh"),
        toggleLabel: localize("scheduling.execution.toggle"),
    };
}
