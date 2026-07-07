import { html } from "lit-element";
import { nothing, type TemplateResult } from "lit-html";
import type { LocalizeFunction } from "../../localize/localize";
import type {
    BatteryDetailChartModel,
    BatteryDetailColumnModel,
} from "./battery-capacity-forecast-chart-model";

export interface BatteryDetailColumnTitleFormatter {
    localize: LocalizeFunction;
    formatHourRange: (start: string, end: string) => string;
    formatDurationHours: (value: number) => string;
    formatEnergy: (value: number) => string;
    formatSocWithUnit: (value: number) => string;
}

export interface BatteryDetailRowRenderParams extends BatteryDetailColumnTitleFormatter {
    detail: BatteryDetailChartModel;
    rowLabel: string;
}

export type BatterySocToneClass = "soft" | "hit-min" | "hit-max";

export function renderBatteryDetailRow({
    detail,
    rowLabel,
    ...titleFormatter
}: BatteryDetailRowRenderParams): TemplateResult {
    return html`
        <div class="forecast-detail-row primary">
            <div class="forecast-detail-row-label">${rowLabel}</div>
            <div class="forecast-detail-track battery-soc battery-combined">
                ${detail.minSocOffsetPercent !== null ? html`
                    <span
                        class="forecast-detail-reference-line min-soc"
                        style=${`--forecast-reference-offset:${detail.minSocOffsetPercent}%;`}
                    ></span>
                ` : nothing}
                ${detail.maxSocOffsetPercent !== null ? html`
                    <span
                        class="forecast-detail-reference-line max-soc"
                        style=${`--forecast-reference-offset:${detail.maxSocOffsetPercent}%;`}
                    ></span>
                ` : nothing}
                ${detail.columns.map((column) => _renderBatteryDetailColumn(column, titleFormatter))}
            </div>
        </div>
    `;
}

export function getBatterySocToneClass(column: BatteryDetailColumnModel): BatterySocToneClass {
    return column.hitMaxSoc
        ? "hit-max"
        : column.hitMinSoc
            ? "hit-min"
            : "soft";
}

export function buildBatteryDetailColumnTitle(
    column: BatteryDetailColumnModel,
    {
        localize,
        formatHourRange,
        formatDurationHours,
        formatEnergy,
        formatSocWithUnit,
    }: BatteryDetailColumnTitleFormatter,
): string {
    if (column.isGap || column.endSocPct === null) {
        return [
            formatHourRange(column.displayStartAt, column.displayEndAt),
            localize("node_detail.battery_forecast.no_data"),
        ].join(" · ");
    }

    const parts = [
        formatHourRange(column.displayStartAt, column.displayEndAt),
        `${localize("node_detail.battery.soc")}: ${formatSocWithUnit(column.startSocPct ?? column.endSocPct)} → ${formatSocWithUnit(column.endSocPct)}`,
        `${localize("node_detail.battery_forecast.slot_duration")}: ${formatDurationHours(column.durationHours)}`,
    ];

    let hasEnergyBreakdown = false;
    if (column.chargedKwh > 0) {
        parts.push(`${localize("node_detail.battery_forecast.charged")}: ${formatEnergy(column.chargedKwh)}`);
        hasEnergyBreakdown = true;
    }
    if (column.dischargedKwh > 0) {
        parts.push(`${localize("node_detail.battery_forecast.discharged")}: ${formatEnergy(column.dischargedKwh)}`);
        hasEnergyBreakdown = true;
    }
    if (column.importedFromGridKwh > 0) {
        parts.push(`${localize("node_detail.battery_forecast.imported_from_grid")}: ${formatEnergy(column.importedFromGridKwh)}`);
        hasEnergyBreakdown = true;
    }
    if (column.exportedToGridKwh > 0) {
        parts.push(`${localize("node_detail.battery_forecast.exported_to_grid")}: ${formatEnergy(column.exportedToGridKwh)}`);
        hasEnergyBreakdown = true;
    }

    if (!hasEnergyBreakdown) {
        if (column.flowDirection !== "idle" && column.flowMagnitudeKwh === null && column.flowSource === "actual_soc_delta") {
            parts.push(`${localize("node_detail.battery_forecast.charge_discharge")}: ${_formatBatteryFlowMode(column, localize)}`);
        } else {
            parts.push(`${localize("node_detail.battery_forecast.charge_discharge")}: ${formatEnergy(0)}`);
        }
    }

    return parts.join(" · ");
}

function _renderBatteryDetailColumn(
    column: BatteryDetailColumnModel,
    titleFormatter: BatteryDetailColumnTitleFormatter,
): TemplateResult {
    const socToneClass = getBatterySocToneClass(column);

    return html`
        <div
            class="forecast-detail-column ${column.isPast ? "past" : ""} ${column.isGap ? "gap" : ""} ${column.source}"
            title=${buildBatteryDetailColumnTitle(column, titleFormatter)}
        >
            ${column.endSocPct !== null && column.socChangeHeightPercent > 0 ? html`
                <span
                    class="forecast-detail-battery-change ${socToneClass}"
                    style=${`--forecast-change-offset:${column.socChangeOffsetPercent}%; --forecast-change-height:${column.socChangeHeightPercent}%;`}
                ></span>
            ` : nothing}
            ${column.hasRenderableChargeBar ? html`
                <span
                    class="forecast-detail-battery-flow charge"
                    style=${`--forecast-flow-height:${column.chargeHeightPercent}%; --forecast-flow-offset:${column.chargeOffsetPercent}%;`}
                ></span>
            ` : nothing}
            ${column.hasRenderableDischargeBar ? html`
                <span
                    class="forecast-detail-battery-flow discharge"
                    style=${`--forecast-flow-height:${column.dischargeHeightPercent}%; --forecast-flow-offset:${column.dischargeOffsetPercent}%;`}
                ></span>
            ` : nothing}
            ${column.endSocPct !== null ? html`
                <span
                    class="forecast-detail-battery-step ${socToneClass}"
                    style=${`--forecast-step-offset:${column.dashOffsetPercent}%;`}
                ></span>
            ` : nothing}
        </div>
    `;
}

function _formatBatteryFlowMode(
    column: BatteryDetailColumnModel,
    localize: LocalizeFunction,
): string {
    switch (column.flowDirection) {
        case "charge":
            return localize("node_detail.battery.mode_charging");
        case "discharge":
            return localize("node_detail.battery.mode_discharging");
        default:
            return localize("node_detail.battery.mode_idle");
    }
}
