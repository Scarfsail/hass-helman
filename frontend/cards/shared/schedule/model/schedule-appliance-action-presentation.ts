import type { ScheduleActionTone } from "../action-tones";
import type { LocalizeFunction } from "../../../localize/localize";
import type { ScheduleApplianceDescriptor } from "./schedule-appliance-metadata";
import type { ScheduleApplianceAction } from "../schedule-types";
import {
    isScheduleClimateApplianceAction,
    isScheduleEvChargerAction,
    isScheduleGenericApplianceAction,
} from "../schedule-types";
import { APPLIANCE_KIND_UI } from "./schedule-appliance-kind-ui";
export { formatScheduleClimateModeLabel } from "./schedule-appliance-kind-ui";

export type ScheduleApplianceActionTone = Extract<ScheduleActionTone, "neutral" | "charge" | "stop">;
export type ScheduleApplianceActionToneClass = `action-tone-${ScheduleApplianceActionTone}`;

export interface ScheduleApplianceActionPresentation {
    icon: string;
    label: string;
    /** The scheduler tone it takes, and its class. */
    tone: ScheduleApplianceActionTone;
    toneClass: ScheduleApplianceActionToneClass;
    // Candidate = placed by an optimizer whose execution condition is not met.
    isCandidate: boolean;
}

export function getScheduleApplianceActionPresentation(args: {
    appliance: Pick<ScheduleApplianceDescriptor, "kind" | "icon">;
    action: ScheduleApplianceAction | null;
    localize: LocalizeFunction;
}): ScheduleApplianceActionPresentation {
    const base = _getBaseApplianceActionPresentation(args);
    return {
        ...base,
        toneClass: `action-tone-${base.tone}`,
        isCandidate: args.action !== null && args.action.conditionMet === false,
    };
}

function _getBaseApplianceActionPresentation({
    appliance,
    action,
    localize,
}: {
    appliance: Pick<ScheduleApplianceDescriptor, "kind" | "icon">;
    action: ScheduleApplianceAction | null;
    localize: LocalizeFunction;
}): Omit<ScheduleApplianceActionPresentation, "isCandidate" | "toneClass"> {
    if (action === null) {
        return {
            icon: appliance.icon,
            label: localize("scheduling.dialog.appliance.no_action"),
            tone: "neutral",
        };
    }

    if ((appliance.kind === "ev_charger" && isScheduleEvChargerAction(action))
        || (appliance.kind === "generic" && isScheduleGenericApplianceAction(action))
        || (appliance.kind === "climate" && isScheduleClimateApplianceAction(action))) {
        return APPLIANCE_KIND_UI[appliance.kind].presentation(action, appliance.icon, localize);
    }

    return {
        icon: appliance.icon,
        label: localize("scheduling.appliance.action.generic"),
        tone: "neutral",
    };
}
