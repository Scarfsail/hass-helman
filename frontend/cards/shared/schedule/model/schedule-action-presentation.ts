import type { LocalizeFunction } from "../../../localize/localize";
import type { ScheduleAction } from "../schedule-types";
import { getScheduleActionTone, type ScheduleActionToneClass } from "../action-tones";
import { getScheduleActionLabel } from "./schedule-labels";

export interface ScheduleActionPresentation {
    icon: string;
    label: string;
    toneClass: ScheduleActionToneClass;
    // Candidate = placed by an optimizer whose execution condition is not met.
    // Rendered muted; excluded from resource accounting and not executed.
    isCandidate: boolean;
}

export function getScheduleActionPresentation(
    action: ScheduleAction,
    localize: LocalizeFunction,
): ScheduleActionPresentation {
    const tone = getScheduleActionTone(action.kind);
    return {
        icon: _getScheduleActionIcon(action.kind),
        label: getScheduleActionLabel(action, localize),
        toneClass: `action-tone-${tone}`,
        isCandidate: action.conditionMet === false,
    };
}

function _getScheduleActionIcon(actionKind: ScheduleAction["kind"]): string {
    switch (actionKind) {
        case "empty":
            return "mdi:minus-circle-outline";
        case "normal":
            return "mdi:circle-outline";
        case "charge_to_target_soc":
            return "mdi:arrow-up-bold-circle-outline";
        case "discharge_to_target_soc":
            return "mdi:arrow-down-bold-circle-outline";
        case "stop_charging":
            return "mdi:arrow-up-bold-circle";
        case "stop_discharging":
            return "mdi:arrow-down-bold-circle";
        case "stop_export":
            return "mdi:transmission-tower-off";
    }
}
