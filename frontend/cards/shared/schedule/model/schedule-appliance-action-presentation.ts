import type { ScheduleActionTone } from "../action-tones";
import type { LocalizeFunction } from "../../../localize/localize";
import type { ScheduleApplianceDescriptor } from "./schedule-appliance-metadata";
import type { ScheduleApplianceAction } from "../schedule-types";
import {
    isScheduleClimateApplianceAction,
    isScheduleEvChargerAction,
    isScheduleGenericApplianceAction,
} from "../schedule-types";

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

    if (appliance.kind === "ev_charger" && isScheduleEvChargerAction(action)) {
        return _getEvChargerActionPresentation(appliance.icon, action, localize);
    }

    if (appliance.kind === "generic" && isScheduleGenericApplianceAction(action)) {
        return action.on
            ? {
                icon: appliance.icon,
                label: localize("scheduling.appliance.generic.action.on"),
                tone: "charge",
            }
            : {
                icon: appliance.icon,
                label: localize("scheduling.appliance.generic.action.off"),
                tone: "stop",
            };
    }

    if (appliance.kind === "climate" && isScheduleClimateApplianceAction(action)) {
        return {
            icon: appliance.icon,
            label: formatScheduleClimateModeLabel(action.mode, localize),
            tone: action.mode === "off" ? "stop" : "charge",
        };
    }

    return {
        icon: appliance.icon,
        label: localize("scheduling.appliance.action.generic"),
        tone: "neutral",
    };
}

export function formatScheduleClimateModeLabel(
    mode: string,
    localize: LocalizeFunction,
): string {
    switch (mode) {
        case "heat":
            return localize("scheduling.appliance.climate.mode.heat");
        case "cool":
            return localize("scheduling.appliance.climate.mode.cool");
        case "off":
            return localize("scheduling.appliance.climate.mode.off");
        default:
            return mode;
    }
}

function _getEvChargerActionPresentation(
    icon: string,
    action: Extract<ScheduleApplianceAction, { charge: boolean }>,
    localize: LocalizeFunction,
): Omit<ScheduleApplianceActionPresentation, "isCandidate" | "toneClass"> {
    const modeLabel = _buildEvModeLabel(action, localize);
    return {
        icon,
        label: action.charge ? modeLabel : localize("scheduling.appliance.ev.action.no_charge"),
        tone: action.charge ? "charge" : "stop",
    };
}

function _buildEvModeLabel(
    action: Extract<ScheduleApplianceAction, { charge: boolean }>,
    localize: LocalizeFunction,
): string {
    if (!action.charge) {
        return localize("scheduling.appliance.ev.action.no_charge");
    }

    const useMode = action.useMode ?? "Fast";
    if (useMode === "ECO") {
        const ecoLabel = localize("scheduling.appliance.ev.mode.eco");
        return action.ecoGear ? `${ecoLabel} ${action.ecoGear}` : ecoLabel;
    }

    return localize("scheduling.appliance.ev.mode.fast");
}
