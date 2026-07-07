import type { LocalizeFunction } from "../../localize/localize";
import type { ScheduleAction } from "../schedule-types";

export type ScheduleActionLabelVariant = "default" | "table";

export function getScheduleActionKindLabel(
    actionKind: ScheduleAction["kind"],
    localize: LocalizeFunction,
): string {
    switch (actionKind) {
        case "empty":
            return localize("scheduling.action_kind.empty");
        case "normal":
            return localize("scheduling.action_kind.normal");
        case "charge_to_target_soc":
            return localize("scheduling.action_kind.charge_to_target_soc");
        case "discharge_to_target_soc":
            return localize("scheduling.action_kind.discharge_to_target_soc");
        case "stop_charging":
            return localize("scheduling.action_kind.stop_charging");
        case "stop_discharging":
            return localize("scheduling.action_kind.stop_discharging");
        case "stop_export":
            return localize("scheduling.action_kind.stop_export");
    }
}

export function getScheduleActionLabel(
    action: ScheduleAction,
    localize: LocalizeFunction,
    variant: ScheduleActionLabelVariant = "default",
): string {
    switch (action.kind) {
        case "empty":
            return localize(variant === "table" ? "scheduling.action_table.empty" : "scheduling.action.empty");
        case "normal":
            return localize(variant === "table" ? "scheduling.action_table.normal" : "scheduling.action.normal");
        case "charge_to_target_soc":
            return variant === "table"
                ? _formatCompactTargetSocLabel(localize("scheduling.action_table.charge_to_target_soc"), action.targetSoc)
                : `${localize("scheduling.action.charge_to_target_soc")} ${action.targetSoc ?? "?"} %`;
        case "discharge_to_target_soc":
            return variant === "table"
                ? _formatCompactTargetSocLabel(localize("scheduling.action_table.discharge_to_target_soc"), action.targetSoc)
                : `${localize("scheduling.action.discharge_to_target_soc")} ${action.targetSoc ?? "?"} %`;
        case "stop_charging":
            return localize(variant === "table" ? "scheduling.action_table.stop_charging" : "scheduling.action.stop_charging");
        case "stop_discharging":
            return localize(variant === "table" ? "scheduling.action_table.stop_discharging" : "scheduling.action.stop_discharging");
        case "stop_export":
            return localize(variant === "table" ? "scheduling.action_table.stop_export" : "scheduling.action.stop_export");
    }
}

function _formatCompactTargetSocLabel(label: string, targetSoc: number | null | undefined): string {
    return `${label} ${targetSoc ?? "?"}%`;
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

export function formatScheduleSlotCount(count: number, localize: LocalizeFunction): string {
    const unit = count === 1
        ? localize("scheduling.copy.slot_one")
        : count >= 2 && count <= 4
        ? localize("scheduling.copy.slot_few")
        : localize("scheduling.copy.slot_many");
    return `${count} ${unit}`;
}

export function getScheduleErrorLabel({
    code,
    localize,
    fallbackMessage,
}: {
    code: string | null | undefined;
    localize: LocalizeFunction;
    fallbackMessage?: string | null;
}): string {
    switch (code) {
        case "invalid_slots":
            return localize("scheduling.error.invalid_slots");
        case "invalid_action":
            return localize("scheduling.error.invalid_action");
        case "not_configured":
            return localize("scheduling.error.not_configured");
        case "execution_unavailable":
            return localize("scheduling.error.execution_unavailable");
        default:
            return fallbackMessage && fallbackMessage.trim().length > 0
                ? fallbackMessage
                : localize("scheduling.error.unknown");
    }
}
