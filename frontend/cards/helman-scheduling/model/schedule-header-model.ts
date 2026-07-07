import type { LocalizeFunction } from "../../localize/localize";
import type { ScheduleOwnerSnapshot } from "../schedule-types";

export interface ScheduleHeaderModel {
    statusText: string | null;
    executionEnabled: boolean;
    refreshDisabled: boolean;
    toggleDisabled: boolean;
    refreshLabel: string;
    toggleLabel: string;
}

export const EMPTY_SCHEDULE_HEADER_MODEL: ScheduleHeaderModel = {
    statusText: null,
    executionEnabled: false,
    refreshDisabled: true,
    toggleDisabled: true,
    refreshLabel: "",
    toggleLabel: "",
};

export function buildScheduleHeaderModel({
    snapshot,
    localize,
    locale,
    timeZone,
}: {
    snapshot: ScheduleOwnerSnapshot;
    localize: LocalizeFunction;
    locale: string;
    timeZone: string;
}): ScheduleHeaderModel {
    return {
        statusText: _buildScheduleHeaderStatusText({ snapshot, localize, locale, timeZone }),
        executionEnabled: snapshot.schedule?.executionEnabled ?? false,
        refreshDisabled: snapshot.loading || snapshot.refreshing || snapshot.togglingExecution,
        toggleDisabled: snapshot.schedule === null || snapshot.loading || snapshot.togglingExecution,
        refreshLabel: localize("scheduling.actions.refresh"),
        toggleLabel: localize("scheduling.execution.toggle"),
    };
}

function _buildScheduleHeaderStatusText({
    snapshot,
    localize,
    locale,
    timeZone,
}: {
    snapshot: ScheduleOwnerSnapshot;
    localize: LocalizeFunction;
    locale: string;
    timeZone: string;
}): string | null {
    if (snapshot.loading || snapshot.refreshing) {
        return localize("scheduling.status.refreshing");
    }

    if (snapshot.updatedAt !== null) {
        return `${localize("scheduling.status.updated")} ${_formatScheduleHeaderTime(snapshot.updatedAt, locale, timeZone)}`;
    }

    return null;
}

function _formatScheduleHeaderTime(timestamp: number, locale: string, timeZone: string): string {
    return new Intl.DateTimeFormat(locale, {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
    }).format(new Date(timestamp));
}
