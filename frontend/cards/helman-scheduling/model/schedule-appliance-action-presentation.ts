import type { LocalizeFunction } from "../../localize/localize";
import type { ScheduleApplianceMetadata } from "./schedule-appliance-metadata";
import type { ScheduleApplianceAction } from "../schedule-types";
import {
    isScheduleClimateApplianceAction,
    isScheduleEvChargerAction,
    isScheduleGenericApplianceAction,
} from "../schedule-types";

type ScheduleApplianceActionTone = "neutral" | "charge" | "stop";
export type ScheduleApplianceActionToneClass = `action-tone-${ScheduleApplianceActionTone}`;

export interface ScheduleApplianceActionPresentation {
    icon: string;
    label: string;
    toneClass: ScheduleApplianceActionToneClass;
}

export function getScheduleApplianceActionPresentation({
    appliance,
    action,
    localize,
}: {
    appliance: Pick<ScheduleApplianceMetadata, "kind" | "icon">;
    action: ScheduleApplianceAction | null;
    localize: LocalizeFunction;
}): ScheduleApplianceActionPresentation {
    if (action === null) {
        return {
            icon: appliance.icon,
            label: localize("scheduling.dialog.appliance.no_action"),
            toneClass: "action-tone-neutral",
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
                toneClass: "action-tone-charge",
            }
            : {
                icon: appliance.icon,
                label: localize("scheduling.appliance.generic.action.off"),
                toneClass: "action-tone-stop",
            };
    }

    if (appliance.kind === "climate" && isScheduleClimateApplianceAction(action)) {
        return {
            icon: appliance.icon,
            label: formatScheduleClimateModeLabel(action.mode, localize),
            toneClass: action.mode === "off" ? "action-tone-stop" : "action-tone-charge",
        };
    }

    return {
        icon: appliance.icon,
        label: localize("scheduling.appliance.action.generic"),
        toneClass: "action-tone-neutral",
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
): ScheduleApplianceActionPresentation {
    const modeLabel = _buildEvModeLabel(action, localize);
    return {
        icon,
        label: action.charge ? modeLabel : localize("scheduling.appliance.ev.action.no_charge"),
        toneClass: action.charge ? "action-tone-charge" : "action-tone-stop",
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
