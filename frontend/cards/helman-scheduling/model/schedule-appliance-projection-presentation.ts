import type { ApplianceProjectionMethod } from "../../helman-api";
import type { LocalizeFunction } from "../../localize/localize";
import type { ScheduleApplianceProjectionBadge } from "./schedule-appliance-projection";
import { formatScheduleClimateModeLabel } from "./schedule-appliance-action-presentation";

export function getScheduleApplianceProjectionBadgeLabel(
    projectionBadge: ScheduleApplianceProjectionBadge,
    localize: LocalizeFunction,
): string {
    if (projectionBadge.kind === "vehicle_soc") {
        return `${localize("scheduling.appliance.ev.expected_soc")} ${projectionBadge.expectedVehicleSocPct}%`;
    }

    const parts = [
        `${_getProjectedEnergyLabel(projectionBadge, localize)} ${_formatEnergyKwh(projectionBadge.energyKwh)}`,
    ];
    if (projectionBadge.applianceKind === "climate" && projectionBadge.mode !== null) {
        parts.push(`${localize("scheduling.dialog.appliance.mode")} ${formatScheduleClimateModeLabel(projectionBadge.mode, localize)}`);
    }
    const projectionMethod = _getProjectionMethodLabel(projectionBadge.projectionMethod, localize);
    if (projectionMethod !== null) {
        parts.push(projectionMethod);
    }

    return parts.join(" · ");
}

function _getProjectedEnergyLabel(
    projectionBadge: Extract<ScheduleApplianceProjectionBadge, { kind: "energy" }>,
    localize: LocalizeFunction,
): string {
    return projectionBadge.applianceKind === "climate"
        ? localize("scheduling.appliance.climate.projected_energy")
        : localize("scheduling.appliance.generic.projected_energy");
}

function _getProjectionMethodLabel(
    projectionMethod: ApplianceProjectionMethod | null | undefined,
    localize: LocalizeFunction,
): string | null {
    switch (projectionMethod) {
        case "fixed":
            return localize("scheduling.appliance.generic.projection_method.fixed");
        case "history_average":
            return localize("scheduling.appliance.generic.projection_method.history_average");
        case "fixed_fallback":
            return localize("scheduling.appliance.generic.projection_method.fixed_fallback");
        default:
            return null;
    }
}

function _formatEnergyKwh(value: number): string {
    return `${Number(value.toFixed(2))} kWh`;
}
