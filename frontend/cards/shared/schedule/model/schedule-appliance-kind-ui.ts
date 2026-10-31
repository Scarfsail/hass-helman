import { html, nothing, type TemplateResult } from "lit";
import type { LocalizeFunction } from "../../../localize/localize";
import type { ScheduleApplianceDescriptor, ScheduleApplianceMetadata } from "./schedule-appliance-metadata";
import type { ScheduleApplianceAction } from "../schedule-types";
import {
    isScheduleClimateApplianceAction,
    isScheduleEvChargerAction,
    isScheduleGenericApplianceAction,
} from "../schedule-types";
import { isSwitchOn } from "../../config/devices";

export type ApplianceOption = {
    mode: string;
    icon: string;
    label: string;
    tone: "neutral" | "charge" | "stop";
};

export interface ApplianceEditorDetail {
    vehicleId: string;
    useMode: string;
    ecoGear: string;
    onVehicleChange: (event: Event) => void;
    onUseModeChange: (event: Event) => void;
    onEcoGearChange: (event: Event) => void;
}

type KindUi = {
    describe: (appliance: ScheduleApplianceMetadata) => ScheduleApplianceDescriptor;
    options: (appliance: ScheduleApplianceMetadata, localize: LocalizeFunction) => ApplianceOption[];
    mode: (action: ScheduleApplianceAction | null, appliance: ScheduleApplianceMetadata) => string;
    action: (mode: string, appliance: ScheduleApplianceMetadata, detail: ApplianceEditorDetail) => {
        action: ScheduleApplianceAction | null; valid: boolean;
    };
    stateFromAction: (action: ScheduleApplianceAction) => string;
    actionFromState: (state: string) => ScheduleApplianceAction;
    presentation: (action: ScheduleApplianceAction, icon: string, localize: LocalizeFunction) => {
        icon: string; label: string; tone: "neutral" | "charge" | "stop";
    };
    renderDetail?: (appliance: ScheduleApplianceMetadata, mode: string, detail: ApplianceEditorDetail,
        localize: LocalizeFunction) => TemplateResult | typeof nothing;
};

const describe = (appliance: ScheduleApplianceMetadata): ScheduleApplianceDescriptor => ({
    id: appliance.id, name: appliance.name, kind: appliance.kind, icon: appliance.metadata.icon,
});

export function formatScheduleClimateModeLabel(mode: string, localize: LocalizeFunction): string {
    switch (mode) {
        case "heat": return localize("scheduling.appliance.climate.mode.heat");
        case "cool": return localize("scheduling.appliance.climate.mode.cool");
        case "off": return localize("scheduling.appliance.climate.mode.off");
        default: return mode;
    }
}

export const APPLIANCE_KIND_UI: Record<ScheduleApplianceMetadata["kind"], KindUi> = {
    generic: {
        describe,
        options: (_appliance, localize) => [
            { mode: "none", icon: "mdi:circle-outline", label: localize("scheduling.dialog.appliance.no_action"), tone: "neutral" },
            { mode: "off", icon: "mdi:power-plug-off", label: localize("scheduling.dialog.appliance.turn_off"), tone: "stop" },
            { mode: "on", icon: "mdi:power-plug", label: localize("scheduling.dialog.appliance.turn_on"), tone: "charge" },
        ],
        mode: (action) => action !== null && isScheduleGenericApplianceAction(action)
            ? (action.on ? "on" : "off") : "none",
        action: (mode) => ({ action: mode === "none" ? null : { on: mode === "on" }, valid: true }),
        stateFromAction: (action) => isScheduleGenericApplianceAction(action) && action.on ? "on" : "off",
        actionFromState: (state) => ({ on: isSwitchOn(state) }),
        presentation: (action, icon, localize) => ({
            icon,
            label: localize(isScheduleGenericApplianceAction(action) && action.on
                ? "scheduling.appliance.generic.action.on" : "scheduling.appliance.generic.action.off"),
            tone: isScheduleGenericApplianceAction(action) && action.on ? "charge" : "stop",
        }),
    },
    climate: {
        describe,
        options: (appliance, localize) => {
            if (appliance.kind !== "climate") return [];
            return [
                { mode: "none", icon: appliance.metadata.icon, label: localize("scheduling.dialog.appliance.no_action"), tone: "neutral" },
                { mode: "__off__", icon: appliance.metadata.icon, label: formatScheduleClimateModeLabel("off", localize), tone: "stop" },
                ...appliance.metadata.scheduleCapabilities.modes.map((mode) => ({
                    mode, icon: appliance.metadata.icon, label: formatScheduleClimateModeLabel(mode, localize),
                    tone: "charge" as const,
                })),
            ];
        },
        mode: (action, appliance) => {
            if (appliance.kind !== "climate" || action === null || !isScheduleClimateApplianceAction(action)) return "none";
            if (action.mode === "off") return "__off__";
            return appliance.metadata.scheduleCapabilities.modes.includes(action.mode) ? action.mode : "none";
        },
        action: (mode, appliance) => ({
            action: mode === "none" ? null : { mode: mode === "__off__" ? "off" : mode },
            valid: mode === "none" || mode === "__off__" || (appliance.kind === "climate"
                && appliance.metadata.scheduleCapabilities.modes.includes(mode)),
        }),
        stateFromAction: (action) => isScheduleClimateApplianceAction(action) ? action.mode : "off",
        actionFromState: (state) => ({ mode: state }),
        presentation: (action, icon, localize) => ({
            icon, label: formatScheduleClimateModeLabel(isScheduleClimateApplianceAction(action) ? action.mode : "off", localize),
            tone: isScheduleClimateApplianceAction(action) && action.mode !== "off" ? "charge" : "stop",
        }),
    },
    ev_charger: {
        describe,
        options: (_appliance, localize) => [
            { mode: "none", icon: "mdi:circle-outline", label: localize("scheduling.dialog.appliance.no_action"), tone: "neutral" },
            { mode: "off", icon: "mdi:car-electric", label: localize("scheduling.dialog.appliance.no_charge"), tone: "stop" },
            { mode: "charge", icon: "mdi:car-electric", label: localize("scheduling.dialog.appliance.charge"), tone: "charge" },
        ],
        mode: (action) => action !== null && isScheduleEvChargerAction(action)
            ? (action.charge ? "charge" : "off") : "none",
        action: (mode, appliance, detail) => {
            if (mode === "none") return { action: null, valid: true };
            if (mode === "off") return { action: { charge: false }, valid: true };
            if (appliance.kind !== "ev_charger") return { action: null, valid: false };
            const capabilities = appliance.metadata.scheduleCapabilities;
            const valid = (!capabilities.requiresVehicleSelection
                || appliance.vehicles.some((vehicle) => vehicle.id === detail.vehicleId))
                && capabilities.useModes.includes(detail.useMode as "Fast" | "ECO")
                && (detail.useMode !== "ECO" || capabilities.ecoGears.includes(detail.ecoGear));
            return {
                action: valid ? {
                    charge: true, vehicleId: detail.vehicleId || undefined,
                    useMode: detail.useMode as "Fast" | "ECO",
                    ecoGear: detail.useMode === "ECO" ? detail.ecoGear : undefined,
                } : null,
                valid,
            };
        },
        stateFromAction: (action) => isScheduleEvChargerAction(action) && action.charge ? "on" : "off",
        actionFromState: (state) => ({ charge: state === "on" }),
        presentation: (action, icon, localize) => {
            if (!isScheduleEvChargerAction(action) || !action.charge) {
                return { icon, label: localize("scheduling.appliance.ev.action.no_charge"), tone: "stop" };
            }
            const label = action.useMode === "ECO"
                ? `${localize("scheduling.appliance.ev.mode.eco")}${action.ecoGear ? ` ${action.ecoGear}` : ""}`
                : localize("scheduling.appliance.ev.mode.fast");
            return { icon, label, tone: "charge" };
        },
        renderDetail: (appliance, mode, detail, localize) => {
            if (appliance.kind !== "ev_charger" || mode !== "charge") return nothing;
            const capabilities = appliance.metadata.scheduleCapabilities;
            return html`
                <div class="compact-action-detail action-detail-fields">
                    <div class="field">
                        <div class="field-label">${localize("scheduling.dialog.appliance.mode")}</div>
                        <select class="select-input" .value=${detail.useMode} @change=${detail.onUseModeChange}>
                            ${capabilities.useModes.map((value) => html`<option value=${value} ?selected=${detail.useMode === value}>${value === "ECO" ? localize("scheduling.appliance.ev.mode.eco") : localize("scheduling.appliance.ev.mode.fast")}</option>`)}
                        </select>
                    </div>
                    ${detail.useMode === "ECO" ? html`
                        <div class="field">
                            <div class="field-label">${localize("scheduling.dialog.appliance.eco_gear")}</div>
                            <select class="select-input" .value=${detail.ecoGear} @change=${detail.onEcoGearChange}>
                                ${capabilities.ecoGears.map((gear) => html`<option value=${gear} ?selected=${detail.ecoGear === gear}>${gear}</option>`)}
                            </select>
                        </div>
                    ` : nothing}
                    <div class="field">
                        <div class="field-label">${localize("scheduling.dialog.appliance.vehicle")}</div>
                        <select class="select-input" .value=${detail.vehicleId} @change=${detail.onVehicleChange}>
                            ${appliance.vehicles.map((vehicle) => html`<option value=${vehicle.id} ?selected=${detail.vehicleId === vehicle.id}>${vehicle.name}</option>`)}
                        </select>
                    </div>
                </div>
            `;
        },
    },
};
