import { html } from "lit-element";
import { nothing, type TemplateResult } from "lit-html";
import type { HouseDetailColumnModel } from "./house-forecast-chart-model";
import type { ConsumerDayTotal } from "./house-forecast-detail-model";

export interface HouseDetailRowRenderParams {
    label: string;
    columns: HouseDetailColumnModel[];
    formatHour: (timestamp: string) => string;
    formatEnergy: (value: number) => string;
    noDataLabel: string;
    isPrimary?: boolean;
    colorMix?: string;
    multilineLabel?: boolean;
}

export interface HouseBreakdownDisclosureRenderParams {
    expanded: boolean;
    controlsId: string;
    onToggle: () => void;
    showLabel: string;
    hideLabel: string;
}

export interface HouseBreakdownSummaryRenderParams {
    items: ConsumerDayTotal[];
    formatEnergy: (value: number) => string;
}

export function renderHouseDetailRow({
    label,
    columns,
    formatHour,
    formatEnergy,
    noDataLabel,
    isPrimary = false,
    colorMix,
    multilineLabel = false,
}: HouseDetailRowRenderParams): TemplateResult {
    const rowClass = ["forecast-detail-row", isPrimary ? "primary" : ""].filter(Boolean).join(" ");
    const labelClass = ["forecast-detail-row-label", multilineLabel ? "multiline" : ""].filter(Boolean).join(" ");
    const trackClass = [
        "forecast-detail-track",
        columns.some((column) => column.valueKwh !== null) ? "" : "empty",
    ].filter(Boolean).join(" ");

    return html`
        <div class=${rowClass}>
            <div class=${labelClass}>${label}</div>
            <div class=${trackClass}>
                ${columns.map((column) => _renderHouseDetailColumn({
                    column,
                    colorMix,
                    formatHour,
                    formatEnergy,
                    noDataLabel,
                }))}
            </div>
        </div>
    `;
}

export function renderHouseBreakdownDisclosureRow({
    expanded,
    controlsId,
    onToggle,
    showLabel,
    hideLabel,
}: HouseBreakdownDisclosureRenderParams): TemplateResult {
    return html`
        <div class="forecast-detail-disclosure">
            <button
                type="button"
                class="forecast-detail-disclosure-button"
                @click=${onToggle}
                aria-expanded=${String(expanded)}
                aria-controls=${controlsId}
            >
                ${expanded ? hideLabel : showLabel}
            </button>
        </div>
    `;
}

export function renderHouseBreakdownSummary({
    items,
    formatEnergy,
}: HouseBreakdownSummaryRenderParams): TemplateResult {
    if (items.length === 0) {
        return nothing;
    }

    return html`
        <div class="forecast-detail-summary">
            ${items.map((item) => html`
                <div class="forecast-detail-summary-item">
                    <span class="forecast-detail-summary-label">${item.label}</span>
                    <span class="forecast-detail-summary-value">${formatEnergy(item.totalKwh)}</span>
                </div>
            `)}
        </div>
    `;
}

function _renderHouseDetailColumn({
    column,
    colorMix,
    formatHour,
    formatEnergy,
    noDataLabel,
}: {
    column: HouseDetailColumnModel;
    colorMix?: string;
    formatHour: (timestamp: string) => string;
    formatEnergy: (value: number) => string;
    noDataLabel: string;
}): TemplateResult {
    const colorStyle = colorMix ? `color:${colorMix};` : "";
    const barClass = colorMix ? "forecast-detail-bar" : "forecast-detail-bar house-consumption";
    const highlightClass = colorMix ? "forecast-detail-highlight" : "forecast-detail-highlight house-consumption";
    const isSharedHighlight = column.isMin && column.isMax;
    const titleValue = column.valueKwh !== null
        ? formatEnergy(column.valueKwh)
        : noDataLabel;

    return html`
        <div
            class="forecast-detail-column ${column.isPast ? "past" : ""} ${column.isGap ? "gap" : ""} ${column.source}"
            title=${`${formatHour(column.timestamp)} · ${titleValue}`}
        >
            ${column.valueKwh !== null && column.valueKwh > 0 && (column.isMax || isSharedHighlight) ? html`
                <span class="${highlightClass} top" style=${colorStyle}>
                    ${isSharedHighlight ? "↕" : "↑"} ${formatEnergy(column.valueKwh)}
                </span>
            ` : nothing}
            ${column.valueKwh !== null && column.valueKwh > 0 && column.isMin && !isSharedHighlight ? html`
                <span class="${highlightClass} bottom" style=${colorStyle}>
                    ↓ ${formatEnergy(column.valueKwh)}
                </span>
            ` : nothing}
            ${column.valueKwh !== null && column.valueKwh > 0 ? html`
                <span
                    class=${barClass}
                    style=${`${colorStyle}--forecast-bar-height:${column.heightPercent}%; --forecast-bar-offset:0%;`}
                ></span>
            ` : nothing}
            ${column.bandLowerPercent !== null && column.bandLowerPercent > 0 ? html`
                <span
                    class="forecast-detail-band lower"
                    style=${`${colorStyle}--forecast-band-offset:${column.bandLowerPercent}%;`}
                ></span>
            ` : nothing}
            ${column.bandUpperPercent !== null && column.bandUpperPercent > 0 ? html`
                <span
                    class="forecast-detail-band upper"
                    style=${`${colorStyle}--forecast-band-offset:${column.bandUpperPercent}%;`}
                ></span>
            ` : nothing}
        </div>
    `;
}
