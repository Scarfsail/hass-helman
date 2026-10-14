import type { LocalizeFunction } from "../../../localize/localize";
import type { ScheduleAction } from "../schedule-types";

export function getScheduleActionLabel(
    action: ScheduleAction,
    localize: LocalizeFunction,
): string {
    switch (action.kind) {
        case "empty":
            return localize("scheduling.action.empty");
        case "normal":
            return localize("scheduling.action.normal");
        case "charge_to_target_soc":
            return `${localize("scheduling.action.charge_to_target_soc")} ${action.targetSoc ?? "?"} %`;
        case "discharge_to_target_soc":
            return `${localize("scheduling.action.discharge_to_target_soc")} ${action.targetSoc ?? "?"} %`;
        case "stop_charging":
            return localize("scheduling.action.stop_charging");
        case "stop_discharging":
            return localize("scheduling.action.stop_discharging");
        case "stop_export":
            return localize("scheduling.action.stop_export");
    }
}

export function getScheduleReasonLabel(
    reason: "scheduled" | "target_soc_reached" | null | undefined,
    localize: LocalizeFunction,
): string | null {
    if (reason === undefined || reason === null) {
        return null;
    }

    switch (reason) {
        case "scheduled":
            return localize("scheduling.reason.scheduled");
        case "target_soc_reached":
            return localize("scheduling.reason.target_soc_reached");
    }
}
