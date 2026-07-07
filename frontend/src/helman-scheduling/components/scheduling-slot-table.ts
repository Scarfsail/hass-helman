import { LitElement, css, html, type PropertyValues } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { LocalizeFunction } from "../../localize/localize";
import "./scheduling-action-chip";
import "./scheduling-appliance-chip";
import type { ScheduleApplianceMetadata } from "../model/schedule-appliance-metadata";
import { getScheduleApplianceActionPresentation } from "../model/schedule-appliance-action-presentation";
import type { ScheduleApplianceProjectionBadge } from "../model/schedule-appliance-projection";
import { getScheduleApplianceProjectionBadgeLabel } from "../model/schedule-appliance-projection-presentation";
import { getScheduleActionLabel } from "../model/schedule-labels";
import {
    GRID_SURPLUS_DISPLAY_ZERO_THRESHOLD_KWH,
    getScheduleGridPositiveDisplay,
} from "../model/grid-surplus-display";
import {
    type ScheduleRuntimeComplianceModel,
    type ScheduleRuntimeComplianceSeverity,
} from "../model/schedule-runtime-compliance";
import type { SlotForecastPoint } from "../model/slot-forecast-model";
import {
    type ScheduleActionViewToggleDetail,
    EMPTY_SCHEDULE_TABLE_MODEL,
    type ScheduleDayToggleDetail,
    type ScheduleTableDayAggregateModel,
    type ScheduleHourToggleDetail,
    type ScheduleTableActionCellModel,
    type ScheduleTableActionItemModel,
    type ScheduleTableColumnKey,
    type ScheduleTableDetailRowModel,
    type ScheduleTableHourRowModel,
    type ScheduleTableModel,
    type ScheduleTableRowModel,
    type ScheduleTableSectionModel,
    type ScheduleTableSlotRowModel,
} from "../schedule-table-types";
import type {
    ScheduleDialogOpenDetail,
    ScheduleActionAuthorshipSummary,
    ScheduleSlotToggleDetail,
} from "../schedule-types";
import { schedulingSharedStyles } from "../styles/scheduling-shared-styles";

const ZERO_KWH_DISPLAY_THRESHOLD = GRID_SURPLUS_DISPLAY_ZERO_THRESHOLD_KWH;

function _formatSolarGaugeValue(wh: number): string {
    const kwh = wh / 1000;
    return kwh >= 10 ? `${Math.round(kwh)}` : `${kwh.toFixed(1)}`;
}

function _formatSolarGaugeTitle(wh: number): string {
    return `${_formatSolarGaugeValue(wh)} kWh`;
}

function _isZeroKwhDisplayValue(kwh: number): boolean {
    return Math.abs(kwh) < ZERO_KWH_DISPLAY_THRESHOLD;
}

function _isZeroSolarDisplayValue(wh: number): boolean {
    return _isZeroKwhDisplayValue(wh / 1000);
}

function _isZeroPriceDisplayValue(value: number): boolean {
    return Math.abs(value) < ZERO_KWH_DISPLAY_THRESHOLD;
}

function _formatKwhValue(kwh: number): string {
    const absKwh = Math.abs(kwh);
    if (absKwh >= 10) {
        return absKwh.toFixed(0);
    }

    if (absKwh >= 1) {
        return absKwh.toFixed(1);
    }

    return absKwh.toFixed(2);
}

function _formatVisiblePriceValue(value: number): string {
    return value.toFixed(1);
}

function _getCenterOriginDirection(value: number): "negative" | "positive" | null {
    if (value < 0) {
        return "negative";
    }
    if (value > 0) {
        return "positive";
    }
    return null;
}

@customElement("scheduling-slot-table")
export class SchedulingSlotTable extends LitElement {
    static styles = [
        schedulingSharedStyles,
        css`
            :host {
                --schedule-table-disclosure-width: 16px;
                --schedule-table-metric-column-width: 82px;
            }

            .table-shell {
                min-width: 0;
                overflow-x: auto;
            }

            .schedule-table {
                width: 100%;
                min-width: 0;
                border-collapse: separate;
                border-spacing: 0 1px;
                table-layout: auto;
            }

            .schedule-table.expanded-actions {
                --schedule-table-metric-column-width: 68px;
            }

            .schedule-table col.col-time {
                width: 1%;
            }

            .schedule-table col.col-action {
                width: 1%;
            }

            .schedule-table col.col-soc,
            .schedule-table col.col-solar,
            .schedule-table col.col-grid,
            .schedule-table col.col-price {
                width: var(--schedule-table-metric-column-width);
            }

            .schedule-table caption {
                padding: 0;
            }

            .column-header-row th,
            .day-row > *,
            .schedule-row > *,
            .detail-row > * {
                box-sizing: border-box;
            }

            .column-header-row th {
                padding: 6px 4px;
                color: var(--secondary-text-color);
                font-size: 0.78rem;
                font-weight: 700;
                letter-spacing: 0.05em;
                text-transform: uppercase;
                background: var(--card-background-color);
                text-align: left;
                white-space: nowrap;
            }

            .column-header-row th.metric-column {
                padding: 6px 2px;
                text-align: center;
            }

            .column-header-title {
                display: block;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                font-size: 0.72rem;
                font-weight: 600;
                letter-spacing: normal;
                text-transform: none;
            }

            .action-header-button {
                display: inline-flex;
                align-items: center;
                min-width: 0;
                max-width: 100%;
                padding: 0;
                color: inherit;
                font: inherit;
                letter-spacing: inherit;
                text-transform: inherit;
                transition: color 120ms ease;
            }

            .action-header-button:hover,
            .action-header-button:focus-visible,
            .action-header-button.active {
                color: var(--primary-color);
            }

            .column-header-unit {
                display: block;
                font-size: 0.62rem;
                font-weight: 600;
                letter-spacing: normal;
                text-transform: none;
            }

            .day-row > * {
                padding: 8px 4px 4px;
                background: var(--card-background-color);
                vertical-align: middle;
            }

            .day-label-cell {
                color: var(--secondary-text-color);
                font-size: 0.78rem;
                font-weight: 700;
                letter-spacing: 0.05em;
                text-transform: uppercase;
                text-align: left;
                white-space: nowrap;
            }

            .day-toggle-button {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                min-width: 0;
                max-width: 100%;
                color: inherit;
                font: inherit;
                letter-spacing: inherit;
                text-transform: inherit;
                transition: color 120ms ease;
            }

            .day-toggle-button:hover {
                color: var(--primary-color);
            }

            .day-toggle-icon {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                flex: 0 0 var(--schedule-table-disclosure-width);
                width: var(--schedule-table-disclosure-width);
                height: var(--schedule-table-disclosure-width);
                border-radius: 999px;
                color: var(--secondary-text-color);
                font-size: 0.82rem;
                font-weight: 700;
                line-height: 1;
                transition: background-color 120ms ease, color 120ms ease;
            }

            .day-toggle-button:hover .day-toggle-icon {
                background: color-mix(in srgb, var(--primary-color) 10%, transparent);
                color: var(--primary-color);
            }

            .day-toggle-label {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .day-spacer-cell {
                padding-top: 6px;
                padding-bottom: 2px;
            }

            .day-aggregate-cell {
                padding-top: 6px;
                padding-bottom: 2px;
            }

            .day-aggregate-gauge {
                box-sizing: border-box;
                position: relative;
                display: flex;
                align-items: center;
                overflow: hidden;
                width: 100%;
                min-width: 0;
                min-height: 18px;
                padding: 1px 4px;
                border-radius: 4px;
                font-size: 0.62rem;
                font-weight: 700;
                line-height: 1.2;
                white-space: nowrap;
            }

            .day-aggregate-gauge > :not(.day-aggregate-gauge-fill, .day-aggregate-gauge-center) {
                position: relative;
                z-index: 1;
            }

            .day-aggregate-gauge-fill {
                position: absolute;
                inset: 0 auto 0 0;
                z-index: 0;
                border-radius: inherit;
                pointer-events: none;
            }

            .day-aggregate-gauge-center {
                position: absolute;
                top: 3px;
                bottom: 3px;
                left: 50%;
                width: 1px;
                z-index: 1;
                background: color-mix(in srgb, var(--primary-text-color) 18%, transparent);
                transform: translateX(-50%);
            }

            .day-aggregate-gauge-value {
                display: block;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                font-variant-numeric: tabular-nums;
            }

            .day-aggregate-gauge.battery {
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, var(--simple-card-source-battery, #22c55e) 10%, transparent),
                    color-mix(in srgb, var(--simple-card-source-battery, #22c55e) 5%, transparent)
                );
                color: color-mix(in srgb, var(--simple-card-source-battery, #22c55e) 26%, var(--primary-text-color));
                box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--simple-card-source-battery, #22c55e) 14%, var(--divider-color));
                text-shadow: none;
            }

            .day-aggregate-gauge.battery .day-aggregate-gauge-fill {
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, var(--simple-card-source-battery, #22c55e) 34%, white 4%),
                    color-mix(in srgb, var(--simple-card-source-battery, #22c55e) 22%, transparent)
                );
            }

            .day-aggregate-gauge.solar {
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, var(--simple-card-source-solar, #facc15) 8%, #171613),
                    color-mix(in srgb, var(--simple-card-source-solar, #facc15) 4%, #0b0b0a)
                );
                color: color-mix(in srgb, white 72%, var(--simple-card-source-solar, #facc15));
                box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--simple-card-source-solar, #facc15) 10%, #25231f);
                text-shadow: none;
            }

            .day-aggregate-gauge.solar .day-aggregate-gauge-fill {
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, var(--simple-card-source-solar, #facc15) 24%, #2d2500),
                    color-mix(in srgb, var(--simple-card-source-solar, #facc15) 16%, #131000)
                );
            }

            .day-aggregate-gauge.grid {
                direction: ltr;
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, var(--simple-card-source-grid, #38bdf8) 8%, #10151d),
                    color-mix(in srgb, var(--simple-card-source-grid, #38bdf8) 4%, #06090d),
                    color-mix(in srgb, var(--simple-card-source-grid, #38bdf8) 8%, #10151d)
                );
                color: color-mix(in srgb, var(--primary-text-color) 76%, transparent);
                box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--simple-card-source-grid, #38bdf8) 9%, #1c2430);
                text-shadow: none;
            }

            .day-aggregate-gauge.grid.surplus {
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, #5f5f5f 20%, #1b1b1b),
                    color-mix(in srgb, #4c4c4c 11%, #0d0d0d),
                    color-mix(in srgb, #5f5f5f 20%, #1b1b1b)
                );
                box-shadow: inset 0 0 0 1px color-mix(in srgb, #727272 30%, #292929);
            }

            .day-aggregate-gauge.grid .day-aggregate-gauge-fill.import {
                inset: 0 auto 0 auto;
                right: 50%;
                left: auto;
                background: linear-gradient(
                    270deg,
                    color-mix(in srgb, #2563eb 42%, white 2%),
                    color-mix(in srgb, #2563eb 20%, transparent)
                );
                border-radius: 4px 0 0 4px;
            }

            .day-aggregate-gauge.grid .day-aggregate-gauge-fill.export {
                inset: 0 auto 0 50%;
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, var(--simple-card-grid-accent, #7dd3fc) 42%, white 2%),
                    color-mix(in srgb, var(--simple-card-grid-accent, #7dd3fc) 20%, transparent)
                );
                border-radius: 0 4px 4px 0;
            }

            .day-aggregate-gauge.grid .day-aggregate-gauge-fill.surplus {
                inset: 0 auto 0 50%;
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, #595959 76%, var(--primary-text-color)),
                    color-mix(in srgb, #3a3a3a 56%, transparent)
                );
                border-radius: 0 4px 4px 0;
            }

            .day-aggregate-gauge-pair {
                display: flex;
                align-items: center;
                gap: 4px;
                width: 100%;
                min-width: 0;
            }

            .day-aggregate-gauge-pair .day-aggregate-gauge-value {
                flex: 1 1 0;
            }

            .day-aggregate-gauge-pair .day-aggregate-gauge-value.import {
                color: color-mix(in srgb, #2563eb 58%, var(--primary-text-color));
                text-align: left;
            }

            .day-aggregate-gauge-pair .day-aggregate-gauge-value.export {
                color: color-mix(in srgb, var(--simple-card-grid-accent, #7dd3fc) 52%, var(--primary-text-color));
                text-align: right;
            }

            .day-aggregate-gauge-pair .day-aggregate-gauge-value.surplus {
                color: color-mix(in srgb, var(--secondary-text-color) 82%, #5b5b5b);
                text-align: right;
            }

            .day-aggregate-gauge.price {
                direction: ltr;
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, var(--forecast-price-negative, #6d4c41) 8%, transparent),
                    color-mix(in srgb, var(--card-background-color) 94%, transparent),
                    color-mix(in srgb, var(--forecast-price-positive, #8d6e63) 8%, transparent)
                );
                color: color-mix(in srgb, var(--primary-text-color) 76%, transparent);
                box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--forecast-price-positive, #8d6e63) 12%, var(--divider-color));
                text-shadow: none;
            }

            .day-aggregate-gauge.price .day-aggregate-gauge-fill.negative {
                inset: 0 auto 0 auto;
                left: auto;
                background: linear-gradient(
                    270deg,
                    color-mix(in srgb, var(--forecast-price-negative, #6d4c41) 40%, white 2%),
                    color-mix(in srgb, var(--forecast-price-negative, #6d4c41) 18%, transparent)
                );
                border-radius: 4px 0 0 4px;
            }

            .day-aggregate-gauge.price .day-aggregate-gauge-fill.positive {
                inset: 0 auto 0 auto;
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, var(--forecast-price-positive, #8d6e63) 40%, white 2%),
                    color-mix(in srgb, var(--forecast-price-positive, #8d6e63) 18%, transparent)
                );
                border-radius: 0 4px 4px 0;
            }

            .day-aggregate-price-pair {
                display: flex;
                align-items: center;
                gap: 4px;
                width: 100%;
                min-width: 0;
            }

            .day-aggregate-price-pair .day-aggregate-gauge-value {
                flex: 1 1 0;
            }

            .day-aggregate-price-pair .day-aggregate-gauge-value.negative {
                color: color-mix(in srgb, var(--forecast-price-negative, #6d4c41) 62%, var(--primary-text-color));
                text-align: left;
            }

            .day-aggregate-price-pair .day-aggregate-gauge-value.positive {
                color: color-mix(in srgb, var(--forecast-price-positive, #8d6e63) 62%, var(--primary-text-color));
                text-align: right;
            }

            .day-aggregate-gauge.zero {
                color: var(--secondary-text-color);
                background: color-mix(in srgb, var(--secondary-text-color) 12%, transparent);
                box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--secondary-text-color) 14%, transparent);
                text-shadow: none;
            }

            .day-aggregate-gauge.zero .day-aggregate-gauge-center {
                background: color-mix(in srgb, var(--secondary-text-color) 28%, transparent);
            }

            .day-aggregate-gauge.unavailable {
                opacity: 0.4;
            }

            .schedule-row > *,
            .detail-row > * {
                vertical-align: middle;
            }

            .schedule-row > * {
                padding: 0 4px;
                background: transparent;
                transition: background-color 120ms ease, box-shadow 120ms ease;
            }

            .schedule-row:hover > * {
                background: color-mix(in srgb, var(--primary-color) 5%, transparent);
            }

            .schedule-row.selected > * {
                background: color-mix(in srgb, var(--primary-color) 8%, transparent);
                box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-color) 36%, transparent);
            }

            .schedule-row.partially-selected > * {
                background: color-mix(in srgb, var(--primary-color) 5%, transparent);
                box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary-color) 18%, transparent);
            }

            .schedule-row.hour-child > * {
                background: color-mix(in srgb, var(--secondary-text-color) 6%, transparent);
            }

            .schedule-row.hour-child:hover > * {
                background: color-mix(in srgb, var(--primary-color) 6%, var(--card-background-color));
            }

            .schedule-row > *:first-child,
            .detail-row > *:first-child {
                border-top-left-radius: 10px;
                border-bottom-left-radius: 10px;
            }

            .schedule-row > *:last-child,
            .detail-row > *:last-child {
                border-top-right-radius: 10px;
                border-bottom-right-radius: 10px;
            }

            .time-cell {
                width: 1%;
                padding-left: 6px;
                padding-right: 6px;
                font-weight: normal;
                text-align: left;
                white-space: nowrap;
            }

            .time-cell-content {
                display: inline-flex;
                align-items: center;
                gap: 0;
                min-width: 0;
                width: 100%;
            }

            .time-indent {
                flex: 0 0 var(--schedule-table-disclosure-width);
                width: var(--schedule-table-disclosure-width);
            }

            .slot-disclosure-button {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                flex: 0 0 var(--schedule-table-disclosure-width);
                width: var(--schedule-table-disclosure-width);
                height: var(--schedule-table-disclosure-width);
                border-radius: 999px;
                color: var(--secondary-text-color);
                font-size: 0.82rem;
                font-weight: 700;
                line-height: 1;
                transition: background-color 120ms ease, color 120ms ease;
            }

            .slot-disclosure-button:hover {
                background: color-mix(in srgb, var(--primary-color) 10%, transparent);
                color: var(--primary-color);
            }

            .time-button {
                display: inline-flex;
                align-items: center;
                justify-content: flex-start;
                min-width: 0;
                padding: 6px 6px 6px 4px;
                border-radius: 999px;
                font-size: 0.85rem;
                font-weight: 600;
                line-height: 1.1;
                white-space: nowrap;
                overflow: hidden;
                cursor: pointer;
                transition: background-color 120ms ease, color 120ms ease;
            }

            .time-button:hover:not(:disabled) {
                background: color-mix(in srgb, var(--primary-color) 12%, transparent);
            }

            .time-button.selected {
                background: color-mix(in srgb, var(--primary-color) 18%, var(--card-background-color));
                color: var(--primary-color);
            }

            .time-button.current {
                background: color-mix(in srgb, var(--primary-color) 10%, var(--card-background-color));
                color: var(--primary-color);
            }

            .time-button.current.selected {
                background: color-mix(in srgb, var(--primary-color) 24%, var(--card-background-color));
            }

            .time-button:disabled {
                opacity: 0.55;
                cursor: default;
            }

            .time-button.hour-child {
                padding: 4px 6px 4px 4px;
                font-size: 0.78rem;
            }

            .slot-time-label {
                display: inline-flex;
                align-items: baseline;
                min-width: 0;
                overflow: hidden;
                font-variant-numeric: tabular-nums;
            }

            .slot-time-label-leading,
            .slot-time-label-trailing {
                white-space: nowrap;
            }

            .slot-time-label-leading.hidden,
            .slot-time-label-trailing.hidden {
                visibility: hidden;
            }

            .action-cell {
                width: 1%;
                min-width: 0;
                padding: 0 4px;
                white-space: nowrap;
            }

            .action-button {
                display: inline-flex;
                align-items: center;
                width: auto;
                max-width: 100%;
                min-width: 0;
                min-height: 24px;
                padding: 2px 4px;
                border-radius: 10px;
                overflow: hidden;
                cursor: pointer;
            }

            .action-button.expanded-actions {
                max-width: none;
                overflow: visible;
            }

            .action-button:hover:not(:disabled) {
                background: color-mix(in srgb, var(--primary-color) 6%, transparent);
            }

            .action-button:disabled {
                opacity: 0.55;
                cursor: default;
            }

            .action-pill-list {
                display: flex;
                align-items: center;
                gap: 4px;
                min-width: 0;
                width: auto;
                overflow: hidden;
                white-space: nowrap;
            }

            .action-pill-list.expanded-actions {
                width: max-content;
                max-width: none;
            }

            .action-pill-list scheduling-action-chip,
            .action-pill-list scheduling-appliance-chip {
                flex: 0 0 auto;
            }

            .forecast-cell {
                min-width: 0;
                padding: 0 4px;
            }

            .detail-row > * {
                padding: 0 4px;
                background: color-mix(in srgb, var(--primary-color) 4%, transparent);
                vertical-align: top;
            }

            .detail-row.hour-child > * {
                background: color-mix(in srgb, var(--secondary-text-color) 5%, transparent);
            }

            .schedule-row.runtime-success > *,
            .detail-row.runtime-success > * {
                background: color-mix(in srgb, var(--success-color, #2e7d32) 12%, transparent);
            }

            .schedule-row.runtime-warning > *,
            .detail-row.runtime-warning > * {
                background: color-mix(in srgb, var(--warning-color, #c27c0e) 14%, transparent);
            }

            .schedule-row.runtime-error > *,
            .detail-row.runtime-error > * {
                background: color-mix(in srgb, var(--error-color, #c62828) 12%, transparent);
            }

            .schedule-row.runtime-success .time-button.current {
                background: color-mix(in srgb, var(--success-color, #2e7d32) 18%, var(--card-background-color));
                color: color-mix(in srgb, var(--success-color, #2e7d32) 82%, var(--primary-text-color));
            }

            .schedule-row.runtime-warning .time-button.current {
                background: color-mix(in srgb, var(--warning-color, #c27c0e) 18%, var(--card-background-color));
                color: color-mix(in srgb, var(--warning-color, #c27c0e) 82%, var(--primary-text-color));
            }

            .schedule-row.runtime-error .time-button.current {
                background: color-mix(in srgb, var(--error-color, #c62828) 18%, var(--card-background-color));
                color: color-mix(in srgb, var(--error-color, #c62828) 82%, var(--primary-text-color));
            }

            .detail-spacer {
                width: 1%;
            }

            .detail-cell {
                min-width: 0;
            }

            .slot-runtime {
                display: flex;
                flex-direction: column;
                gap: 4px;
                align-items: flex-start;
                min-width: 0;
            }

            .slot-runtime-summary,
            .slot-runtime-details {
                width: 100%;
                min-width: 0;
            }

            .slot-runtime > .chip,
            .slot-runtime > .muted {
                max-width: 100%;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .slot-runtime .chip {
                min-height: 16px;
                padding: 1px 4px;
                font-size: 0.75rem;
                line-height: 1.1;
            }

            .slot-runtime .muted {
                font-size: 0.78rem;
                line-height: 1.1;
            }

            .slot-runtime-summary .chip {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                max-width: 100%;
            }

            .slot-runtime-summary-icon {
                flex: 0 0 auto;
                --mdc-icon-size: 0.9rem;
            }

            .slot-runtime-summary-label {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .slot-runtime-details {
                display: flex;
                flex-direction: column;
                gap: 2px;
            }

            .slot-runtime-line {
                color: var(--secondary-text-color);
                font-size: 0.78rem;
                line-height: 1.2;
                white-space: normal;
            }

            .slot-runtime-line-actor {
                color: var(--primary-text-color);
                font-weight: 600;
            }

            .slot-forecast-gauge {
                box-sizing: border-box;
                position: relative;
                display: flex;
                align-items: center;
                overflow: hidden;
                width: 100%;
                min-width: 0;
                min-height: 20px;
                padding: 1px 4px 1px 5px;
                border-radius: 4px;
                font-size: 0.7rem;
                font-weight: 700;
                line-height: 1.2;
                white-space: nowrap;
            }

            .slot-forecast-gauge > :not(.slot-forecast-gauge-fill, .slot-forecast-gauge-center) {
                position: relative;
                z-index: 1;
            }

            .slot-forecast-gauge-fill {
                position: absolute;
                inset: 0 auto 0 0;
                z-index: 0;
                border-radius: inherit;
                pointer-events: none;
            }

            .slot-forecast-gauge-center {
                position: absolute;
                top: 3px;
                bottom: 3px;
                left: 50%;
                width: 1px;
                z-index: 1;
                background: color-mix(in srgb, var(--primary-text-color) 26%, transparent);
                transform: translateX(-50%);
            }

            .slot-forecast-gauge-text {
                display: block;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .slot-forecast-gauge.battery {
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, var(--simple-card-source-battery, #22c55e) 16%, transparent),
                    color-mix(in srgb, var(--simple-card-source-battery, #22c55e) 8%, transparent)
                );
                color: color-mix(in srgb, var(--simple-card-source-battery, #22c55e) 34%, var(--primary-text-color));
                box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--simple-card-source-battery, #22c55e) 20%, var(--divider-color));
                text-shadow:
                    0 0 1px rgba(255, 255, 255, 0.55),
                    0 1px 1px rgba(24, 44, 28, 0.12);
            }

            .slot-forecast-gauge.battery .slot-forecast-gauge-fill {
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, var(--simple-card-source-battery, #22c55e) 66%, white 8%),
                    color-mix(in srgb, var(--simple-card-source-battery, #22c55e) 44%, transparent)
                );
            }

            .slot-forecast-gauge.solar {
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, var(--simple-card-source-solar, #facc15) 12%, #201f1c),
                    color-mix(in srgb, var(--simple-card-source-solar, #facc15) 6%, #0f0f0e)
                );
                color: color-mix(in srgb, white 90%, var(--simple-card-source-solar, #facc15));
                box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--simple-card-source-solar, #facc15) 14%, #2d2b26);
                text-shadow: none;
            }

            .slot-forecast-gauge.solar .slot-forecast-gauge-fill {
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, var(--simple-card-source-solar, #facc15) 44%, #332c00),
                    color-mix(in srgb, var(--simple-card-source-solar, #facc15) 32%, #1c1800)
                );
            }

            .slot-forecast-gauge.grid {
                direction: ltr;
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, var(--simple-card-source-grid, #38bdf8) 13%, #141b25),
                    color-mix(in srgb, var(--simple-card-source-grid, #38bdf8) 6%, #070b10),
                    color-mix(in srgb, var(--simple-card-source-grid, #38bdf8) 13%, #141b25)
                );
                color: color-mix(in srgb, var(--primary-text-color) 92%, transparent);
                box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--simple-card-source-grid, #38bdf8) 13%, #232d39);
                text-shadow:
                    0 0 1px rgba(255, 255, 255, 0.55),
                    0 1px 1px rgba(24, 32, 52, 0.1);
            }

            .slot-forecast-gauge.grid.surplus {
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, #656565 22%, #1c1c1d),
                    color-mix(in srgb, #525252 13%, #0d0d0e),
                    color-mix(in srgb, #656565 22%, #1c1c1d)
                );
                box-shadow: inset 0 0 0 1px color-mix(in srgb, #787878 28%, #2c2c2d);
                text-shadow: none;
            }

            .slot-forecast-gauge.grid.negative {
                justify-content: flex-start;
            }

            .slot-forecast-gauge.grid.positive {
                justify-content: flex-end;
            }

            .slot-forecast-gauge.grid .slot-forecast-gauge-fill.import {
                inset: 0 auto 0 auto;
                right: 50%;
                left: auto;
                background: linear-gradient(
                    270deg,
                    color-mix(in srgb, #2563eb 74%, white 6%),
                    color-mix(in srgb, #2563eb 46%, transparent)
                );
                border-radius: 4px 0 0 4px;
            }

            .slot-forecast-gauge.grid .slot-forecast-gauge-fill.export {
                inset: 0 auto 0 50%;
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, var(--simple-card-grid-accent, #7dd3fc) 74%, white 6%),
                    color-mix(in srgb, var(--simple-card-grid-accent, #7dd3fc) 46%, transparent)
                );
                border-radius: 0 4px 4px 0;
            }

            .slot-forecast-gauge.grid .slot-forecast-gauge-fill.surplus {
                inset: 0 auto 0 50%;
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, #545454 80%, var(--primary-text-color)),
                    color-mix(in srgb, #363636 62%, transparent)
                );
                border-radius: 0 4px 4px 0;
            }

            .slot-forecast-gauge.grid .slot-forecast-gauge-text {
                flex: 1 1 auto;
                font-variant-numeric: tabular-nums;
            }

            .slot-forecast-gauge.grid .slot-forecast-gauge-text.surplus {
                color: color-mix(in srgb, var(--secondary-text-color) 80%, #606060);
                text-shadow: none;
            }

            .slot-forecast-gauge.price {
                direction: ltr;
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, var(--forecast-price-negative, #6d4c41) 12%, transparent),
                    color-mix(in srgb, var(--card-background-color) 88%, transparent),
                    color-mix(in srgb, var(--forecast-price-positive, #8d6e63) 12%, transparent)
                );
                color: color-mix(in srgb, var(--primary-text-color) 92%, transparent);
                box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--forecast-price-positive, #8d6e63) 18%, var(--divider-color));
                text-shadow:
                    0 0 1px rgba(255, 255, 255, 0.55),
                    0 1px 1px rgba(36, 24, 20, 0.12);
            }

            .slot-forecast-gauge.price.negative {
                justify-content: flex-start;
            }

            .slot-forecast-gauge.price.positive {
                justify-content: flex-end;
            }

            .slot-forecast-gauge.price .slot-forecast-gauge-fill.negative {
                inset: 0 auto 0 auto;
                right: 50%;
                left: auto;
                background: linear-gradient(
                    270deg,
                    color-mix(in srgb, var(--forecast-price-negative, #6d4c41) 84%, white 6%),
                    color-mix(in srgb, var(--forecast-price-negative, #6d4c41) 46%, transparent)
                );
                border-radius: 4px 0 0 4px;
            }

            .slot-forecast-gauge.price .slot-forecast-gauge-fill.positive {
                inset: 0 auto 0 50%;
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, var(--forecast-price-positive, #8d6e63) 84%, white 6%),
                    color-mix(in srgb, var(--forecast-price-positive, #8d6e63) 46%, transparent)
                );
                border-radius: 0 4px 4px 0;
            }

            .slot-forecast-gauge.price .slot-forecast-gauge-text {
                flex: 1 1 auto;
                font-variant-numeric: tabular-nums;
            }

            .slot-forecast-gauge.grid.negative .slot-forecast-gauge-text,
            .slot-forecast-gauge.price.negative .slot-forecast-gauge-text {
                text-align: left;
            }

            .slot-forecast-gauge.grid.positive .slot-forecast-gauge-text,
            .slot-forecast-gauge.price.positive .slot-forecast-gauge-text {
                text-align: right;
            }

            .slot-forecast-gauge.zero {
                color: var(--secondary-text-color);
                background: color-mix(in srgb, var(--secondary-text-color) 14%, transparent);
                text-shadow: none;
                box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--secondary-text-color) 16%, transparent);
            }

            .slot-forecast-gauge.solar.zero,
            .slot-forecast-gauge.price.zero {
                color: var(--secondary-text-color);
            }

            .slot-forecast-gauge.grid.zero,
            .slot-forecast-gauge.price.zero,
            .slot-forecast-gauge.solar.zero {
                background: linear-gradient(
                    90deg,
                    color-mix(in srgb, var(--secondary-text-color) 14%, #0f0f10),
                    color-mix(in srgb, var(--secondary-text-color) 8%, #040404)
                );
                box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--secondary-text-color) 18%, #1b1b1c);
            }

            .slot-forecast-gauge.zero .slot-forecast-gauge-center {
                background: color-mix(in srgb, var(--secondary-text-color) 32%, transparent);
            }

            .slot-forecast-gauge.unavailable {
                opacity: 0.4;
            }

            @media (max-width: 720px) {
                :host {
                    --schedule-table-metric-column-width: 68px;
                }

                .schedule-table.expanded-actions {
                    --schedule-table-metric-column-width: 56px;
                }

                .column-header-row th {
                    padding: 5px 3px;
                    font-size: 0.72rem;
                }

                .day-row > * {
                    padding: 7px 3px 3px;
                }

                .day-label-cell {
                    font-size: 0.74rem;
                }

                .time-button {
                    font-size: 0.8rem;
                }

                .action-pill-list {
                    gap: 2px;
                    flex-wrap: nowrap;
                    white-space: nowrap;
                }

                .slot-forecast-gauge {
                    min-height: 18px;
                    padding: 1px 3px 1px 4px;
                    font-size: 0.64rem;
                }

                .day-aggregate-gauge {
                    min-height: 16px;
                    padding: 1px 3px;
                    font-size: 0.58rem;
                }

                .slot-runtime {
                    gap: 3px;
                }
            }
        `,
    ];

    private _selectedSet: ReadonlySet<string> = new Set();
    private _expandedDaySet: ReadonlySet<string> = new Set();

    @property({ attribute: false }) public tableModel: ScheduleTableModel = EMPTY_SCHEDULE_TABLE_MODEL;
    @property({ attribute: false }) public expandedDayKeys: readonly string[] = [];
    @property({ attribute: false }) public appliances: ScheduleApplianceMetadata[] = [];
    @property({ attribute: false }) public selectedSlotIds: string[] = [];
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ type: Boolean }) public busy = false;
    @property({ type: Boolean }) public executionEnabled = false;
    @property({ type: Boolean }) public expandedApplianceActions = false;

    protected willUpdate(changedProperties: PropertyValues<this>): void {
        super.willUpdate(changedProperties);
        if (changedProperties.has("expandedDayKeys")) {
            this._expandedDaySet = new Set(this.expandedDayKeys);
        }
        if (changedProperties.has("selectedSlotIds")) {
            this._selectedSet = new Set(this.selectedSlotIds);
        }
    }

    render() {
        const tableClasses = `schedule-table${this.expandedApplianceActions ? " expanded-actions" : ""}`;
        return html`
            <div class="table-shell">
                <table class=${tableClasses}>
                    <caption class="sr-only">${this.localize("scheduling.table.caption")}</caption>
                    <colgroup>
                        ${this.tableModel.columns.map((column) => html`
                            <col class=${`col-${column}`}></col>
                        `)}
                    </colgroup>
                    ${this._renderTableHeader()}
                    ${this.tableModel.sections.map((section) => this._renderSection(section))}
                </table>
            </div>
        `;
    }

    private _renderTableHeader() {
        return html`
            <thead>
                <tr class="column-header-row">
                    ${this.tableModel.columns.map((column) => this._renderColumnHeader(column))}
                </tr>
            </thead>
        `;
    }

    private _renderColumnHeader(column: ScheduleTableColumnKey) {
        switch (column) {
            case "time":
                return html`
                    <th scope="col">${this.localize("scheduling.table.time_label")}</th>
                `;
            case "action":
                return html`
                    <th scope="col">
                        <button
                            class=${`button-reset action-header-button${this.expandedApplianceActions ? " active" : ""}`}
                            type="button"
                            aria-pressed=${this.expandedApplianceActions ? "true" : "false"}
                            aria-label=${this._buildActionHeaderToggleLabel()}
                            title=${this._buildActionHeaderToggleLabel()}
                            @click=${this._handleActionViewToggle}
                        >
                            <span class="column-header-title">${this.localize("scheduling.table.action_label")}</span>
                        </button>
                    </th>
                `;
            case "soc":
                return this._renderMetricHeader(column, this.localize("scheduling.table.soc_label"), "%");
            case "solar":
                return this._renderMetricHeader(column, this.localize("scheduling.table.solar_label"), "kWh");
            case "grid":
                return this._renderMetricHeader(column, this.localize("scheduling.table.grid_label"), "kWh");
            case "price":
                return this._renderMetricHeader(
                    column,
                    this.localize("scheduling.table.price_label"),
                    this.tableModel.forecast.priceDisplayUnit ?? "",
                );
        }
    }

    private _renderMetricHeader(column: "soc" | "solar" | "grid" | "price", title: string, unit: string) {
        return html`
            <th scope="col" class=${`metric-column ${column}`}>
                <span class="column-header-title">${title}</span>
                <span class="column-header-unit">${unit}</span>
            </th>
        `;
    }

    private _renderSection(section: ScheduleTableSectionModel) {
        const headerId = this._buildDayHeaderId(section.dayKey);
        const expanded = this._expandedDaySet.has(section.dayKey);
        return html`
            <tbody aria-labelledby=${headerId}>
                <tr class="day-row">
                    <th id=${headerId} scope="rowgroup" class="day-label-cell">
                        <button
                            class="button-reset day-toggle-button"
                            type="button"
                            aria-expanded=${expanded ? "true" : "false"}
                            aria-label=${this._buildDayToggleAriaLabel(section, expanded)}
                            @click=${(event: MouseEvent) => this._handleDayExpansionClick(section.dayKey, event)}
                        >
                            <span class="day-toggle-icon" aria-hidden="true">${expanded ? "−" : "+"}</span>
                            <span class="day-toggle-label">${section.dayLabel}</span>
                        </button>
                    </th>
                    <td class="day-spacer-cell action" aria-hidden="true"></td>
                    <td class="day-aggregate-cell soc">
                        ${this._renderDayBatteryAggregate(section.dayAggregate)}
                    </td>
                    <td class="day-aggregate-cell solar">
                        ${this._renderDaySolarAggregate(section.dayAggregate)}
                    </td>
                    <td class="day-aggregate-cell grid">
                        ${this._renderDayGridAggregate(section.dayAggregate)}
                    </td>
                    <td class="day-aggregate-cell price">
                        ${this._renderDayPriceAggregate(section.dayAggregate)}
                    </td>
                </tr>
                ${expanded ? section.rows.map((row) => this._renderTableRow(row)) : nothing}
            </tbody>
        `;
    }

    private _renderDayBatteryAggregate(aggregate: ScheduleTableDayAggregateModel | null) {
        const forecast = this.tableModel.forecast;
        if (
            !forecast.batteryAvailable
            || aggregate?.batteryMinSocPct === null
            || aggregate.batteryMaxSocPct === null
        ) {
            return html`
                <div class="day-aggregate-gauge battery unavailable" aria-hidden="true"></div>
            `;
        }

        const startPct = Math.max(Math.min(aggregate.batteryMinSocPct, 100), 0);
        const widthPct = Math.max(Math.min(aggregate.batteryMaxSocPct, 100) - startPct, 0);

        return html`
            <div
                class="day-aggregate-gauge battery"
                role="img"
                aria-label=${this._buildDayBatteryAggregateTitle(aggregate.batteryMinSocPct, aggregate.batteryMaxSocPct)}
                title=${this._buildDayBatteryAggregateTitle(aggregate.batteryMinSocPct, aggregate.batteryMaxSocPct)}
            >
                ${widthPct > 0 ? html`
                    <span
                        class="day-aggregate-gauge-fill"
                        style=${`left:${startPct}%;width:${widthPct}%;`}
                        aria-hidden="true"
                    ></span>
                ` : nothing}
                <span class="day-aggregate-gauge-value">
                    ${Math.round(aggregate.batteryMinSocPct)} : ${Math.round(aggregate.batteryMaxSocPct)}
                </span>
            </div>
        `;
    }

    private _renderDaySolarAggregate(aggregate: ScheduleTableDayAggregateModel | null) {
        const forecast = this.tableModel.forecast;
        if (!forecast.solarAvailable || aggregate?.solarWh === null) {
            return html`
                <div class="day-aggregate-gauge solar unavailable" aria-hidden="true"></div>
            `;
        }

        const widthPct = forecast.dayAggregateScale.solarMaxWh > 0
            ? Math.min((aggregate.solarWh / forecast.dayAggregateScale.solarMaxWh) * 100, 100)
            : 0;

        return html`
            <div
                class="day-aggregate-gauge solar"
                role="img"
                aria-label=${this._buildDaySolarAggregateTitle(aggregate.solarWh)}
                title=${this._buildDaySolarAggregateTitle(aggregate.solarWh)}
            >
                ${widthPct > 0 ? html`
                    <span
                        class="day-aggregate-gauge-fill"
                        style=${`width:${widthPct}%;`}
                        aria-hidden="true"
                    ></span>
                ` : nothing}
                <span class="day-aggregate-gauge-value">${_formatSolarGaugeValue(aggregate.solarWh)}</span>
            </div>
        `;
    }

    private _renderDayGridAggregate(aggregate: ScheduleTableDayAggregateModel | null) {
        const forecast = this.tableModel.forecast;
        if (
            !forecast.gridAvailable
            || aggregate?.gridImportKwh === null
            || aggregate.gridExportKwh === null
        ) {
            return html`
                <div class="day-aggregate-gauge grid unavailable" aria-hidden="true"></div>
            `;
        }

        const positiveDisplay = getScheduleGridPositiveDisplay({
            exportKwh: aggregate.gridExportKwh,
            availableSurplusKwh: aggregate.availableSurplusKwh,
        });
        const hasImport = !_isZeroKwhDisplayValue(aggregate.gridImportKwh);
        const hasPositiveDisplay = positiveDisplay.kind !== null;
        const importWidthPct = forecast.dayAggregateScale.gridMaxKwh > 0
            && hasImport
            ? Math.min((aggregate.gridImportKwh / forecast.dayAggregateScale.gridMaxKwh) * 50, 50)
            : 0;
        const positiveWidthPct = forecast.dayAggregateScale.gridMaxKwh > 0
            && hasPositiveDisplay
            ? Math.min((positiveDisplay.valueKwh / forecast.dayAggregateScale.gridMaxKwh) * 50, 50)
            : 0;

        return html`
            <div
                class=${`day-aggregate-gauge grid${positiveDisplay.kind === "surplus" ? " surplus" : ""}${!hasImport && !hasPositiveDisplay ? " zero" : ""}`}
                role="img"
                aria-label=${this._buildDayGridAggregateTitle(aggregate)}
                title=${this._buildDayGridAggregateTitle(aggregate)}
            >
                <span class="day-aggregate-gauge-center" aria-hidden="true"></span>
                ${importWidthPct > 0 ? html`
                    <span
                        class="day-aggregate-gauge-fill import"
                        style=${`width:${importWidthPct}%;`}
                        aria-hidden="true"
                    ></span>
                ` : nothing}
                ${positiveWidthPct > 0 && positiveDisplay.kind !== null ? html`
                    <span
                        class=${`day-aggregate-gauge-fill ${positiveDisplay.kind}`}
                        style=${`width:${positiveWidthPct}%;`}
                        aria-hidden="true"
                    ></span>
                ` : nothing}
                <span class="day-aggregate-gauge-pair">
                    ${hasImport ? html`
                        <span class="day-aggregate-gauge-value import">
                            ${_formatKwhValue(aggregate.gridImportKwh)}
                        </span>
                    ` : nothing}
                    ${hasPositiveDisplay && positiveDisplay.kind !== null ? html`
                        <span class=${`day-aggregate-gauge-value ${positiveDisplay.kind}`}>
                            ${this._formatPositiveGridDisplayValue(positiveDisplay.valueKwh)}
                        </span>
                    ` : nothing}
                </span>
            </div>
        `;
    }

    private _renderDayPriceAggregate(aggregate: ScheduleTableDayAggregateModel | null) {
        const forecast = this.tableModel.forecast;
        if (!forecast.priceAvailable || !aggregate?.priceHasData) {
            return html`
                <div class="day-aggregate-gauge price unavailable" aria-hidden="true"></div>
            `;
        }

        const hasNegative = aggregate.priceNegativeMin !== null && aggregate.priceNegativeMax !== null;
        const hasPositive = aggregate.pricePositiveMin !== null && aggregate.pricePositiveMax !== null;
        const isZero = !hasNegative && !hasPositive;
        const negativeStartPct = forecast.dayAggregateScale.priceMaxAbs > 0 && hasNegative
            ? Math.min((Math.abs(aggregate.priceNegativeMax) / forecast.dayAggregateScale.priceMaxAbs) * 50, 50)
            : 0;
        const negativeWidthPct = forecast.dayAggregateScale.priceMaxAbs > 0 && hasNegative
            ? Math.min(
                ((Math.abs(aggregate.priceNegativeMin) - Math.abs(aggregate.priceNegativeMax))
                    / forecast.dayAggregateScale.priceMaxAbs) * 50,
                50,
            )
            : 0;
        const positiveStartPct = forecast.dayAggregateScale.priceMaxAbs > 0 && hasPositive
            ? Math.min((aggregate.pricePositiveMin / forecast.dayAggregateScale.priceMaxAbs) * 50, 50)
            : 0;
        const positiveWidthPct = forecast.dayAggregateScale.priceMaxAbs > 0 && hasPositive
            ? Math.min(
                ((aggregate.pricePositiveMax - aggregate.pricePositiveMin) / forecast.dayAggregateScale.priceMaxAbs) * 50,
                50,
            )
            : 0;

        return html`
            <div
                class=${`day-aggregate-gauge price${isZero ? " zero" : ""}`}
                role="img"
                aria-label=${this._buildDayPriceAggregateTitle(aggregate, forecast.priceDisplayUnit)}
                title=${this._buildDayPriceAggregateTitle(aggregate, forecast.priceDisplayUnit)}
            >
                <span class="day-aggregate-gauge-center" aria-hidden="true"></span>
                ${hasNegative && negativeWidthPct > 0 ? html`
                    <span
                        class="day-aggregate-gauge-fill negative"
                        style=${`right:calc(50% + ${negativeStartPct}%);width:${negativeWidthPct}%;`}
                        aria-hidden="true"
                    ></span>
                ` : nothing}
                ${hasPositive && positiveWidthPct > 0 ? html`
                    <span
                        class="day-aggregate-gauge-fill positive"
                        style=${`left:calc(50% + ${positiveStartPct}%);width:${positiveWidthPct}%;`}
                        aria-hidden="true"
                    ></span>
                ` : nothing}
                <span class="day-aggregate-price-pair">
                    ${hasNegative ? html`
                        <span class="day-aggregate-gauge-value negative">
                            ${_formatVisiblePriceValue(aggregate.priceNegativeMin)}
                        </span>
                    ` : nothing}
                    ${hasPositive ? html`
                        <span class="day-aggregate-gauge-value positive">
                            ${_formatVisiblePriceValue(aggregate.pricePositiveMin)} : ${_formatVisiblePriceValue(aggregate.pricePositiveMax)}
                        </span>
                    ` : nothing}
                </span>
            </div>
        `;
    }

    private _renderTableRow(row: ScheduleTableRowModel) {
        switch (row.kind) {
            case "detail":
                return this._renderDetailRow(row);
            case "hour":
                return this._renderHourRow(row);
            case "slot":
                return this._renderSlotRow(row);
        }
    }

    private _renderSlotRow(row: ScheduleTableSlotRowModel) {
        const selected = row.interactiveSlotId !== null && this._selectedSet.has(row.interactiveSlotId);
        const classes = `schedule-row slot-row${row.isCurrent ? " current" : ""}${selected ? " selected" : ""}${row.variant === "hour-child" ? " hour-child" : ""}${this._getRuntimeRowClass(row.runtimeCompliance)}`;
        const timeButtonClasses = `button-reset time-button${selected ? " selected" : ""}${row.isCurrent ? " current" : ""}${row.variant === "hour-child" ? " hour-child" : ""}`;

        return html`
            <tr class=${classes}>
                <th scope="row" class="time-cell">
                    <div class="time-cell-content">
                        ${row.variant === "hour-child"
                            ? html`<span class="time-indent" aria-hidden="true"></span>`
                            : nothing}
                        <button
                            class=${timeButtonClasses}
                            type="button"
                            ?disabled=${this.busy || row.interactiveSlotId === null}
                            aria-label=${`${this.localize("scheduling.actions.select_slot")} ${row.rangeLabel}`}
                            aria-pressed=${selected ? "true" : "false"}
                            @click=${(event: MouseEvent) => this._handleTimeClick(row.interactiveSlotId!, event)}
                        >
                            ${this._renderTimeLabel(row.displayTimeLabel)}
                        </button>
                    </div>
                </th>
                ${this._renderActionCell(row.actionCell, row.rangeLabel, row.interactiveSlotId)}
                ${this._renderForecastCells(row.forecast)}
            </tr>
        `;
    }

    private _renderHourRow(row: ScheduleTableHourRowModel) {
        const selectedCount = row.slotIds.filter((slotId) => this._selectedSet.has(slotId)).length;
        const fullySelected = selectedCount === row.slotIds.length && row.slotIds.length > 0;
        const partiallySelected = selectedCount > 0 && !fullySelected;
        const classes = `schedule-row hour-row${row.isCurrent ? " current" : ""}${fullySelected ? " selected" : ""}${partiallySelected ? " partially-selected" : ""}${this._getRuntimeRowClass(row.runtimeCompliance)}`;
        const timeButtonClasses = `button-reset time-button${fullySelected ? " selected" : ""}${row.isCurrent ? " current" : ""}`;

        return html`
            <tr class=${classes}>
                <th scope="row" class="time-cell">
                    <div class="time-cell-content">
                        <button
                            class="button-reset slot-disclosure-button"
                            type="button"
                            aria-expanded=${row.expanded ? "true" : "false"}
                            aria-label=${this._buildHourToggleAriaLabel(row)}
                            @click=${(event: MouseEvent) => this._handleHourExpansionClick(row.hourKey, event)}
                        >
                            ${row.expanded ? "−" : "+"}
                        </button>
                        <button
                            class=${timeButtonClasses}
                            type="button"
                            ?disabled=${this.busy || row.slotIds.length === 0}
                            aria-label=${`${this.localize("scheduling.actions.select_hour")} ${row.rangeLabel}`}
                            aria-pressed=${fullySelected ? "true" : "false"}
                            @click=${(event: MouseEvent) => this._handleTimeClick(row.slotIds[0], event, row.slotIds)}
                        >
                            ${this._renderTimeLabel(row.displayTimeLabel)}
                        </button>
                    </div>
                </th>
                ${this._renderActionCell(row.actionCell, row.rangeLabel, row.slotIds[0] ?? null, row.slotIds)}
                ${this._renderForecastCells(row.forecast)}
            </tr>
        `;
    }

    private _renderDetailRow(row: ScheduleTableDetailRowModel) {
        if (row.runtimeCompliance === null) {
            return nothing;
        }

        return html`
            <tr class=${`detail-row ${row.variant}${this._getRuntimeRowClass(row.runtimeCompliance)}`}>
                <td class="detail-spacer" aria-hidden="true"></td>
                <td class="detail-cell" colspan=${this.tableModel.columns.length - 1}>
                    <div class="slot-runtime">${this._renderSlotRuntime(row.runtimeCompliance)}</div>
                </td>
            </tr>
        `;
    }

    private _renderActionCell(
        actionCell: ScheduleTableActionCellModel,
        rangeLabel: string,
        slotId: string | null,
        slotIds?: readonly string[],
    ) {
        const visibleItems = this._getVisibleActionItems(actionCell.items);
        const actionLabel = this._buildActionCellLabel({ ...actionCell, items: visibleItems });
        const ariaLabel = actionLabel.length > 0
            ? `${this.localize("scheduling.table.action_label")} ${rangeLabel}. ${actionLabel}`
            : `${this.localize("scheduling.table.action_label")} ${rangeLabel}`;
        const actionButtonClasses = `button-reset action-button${this.expandedApplianceActions ? " expanded-actions" : ""}`;
        const actionPillListClasses = `action-pill-list${this.expandedApplianceActions ? " expanded-actions" : ""}`;

        return html`
            <td class="action-cell">
                <button
                    class=${actionButtonClasses}
                    type="button"
                    ?disabled=${this.busy || !actionCell.interactive || slotId === null}
                    aria-label=${ariaLabel}
                    @click=${() => this._handleActionClick(slotId, slotIds)}
                >
                    <span class=${actionPillListClasses}>
                        ${visibleItems.map((item) => this._renderActionItem(item))}
                    </span>
                </button>
            </td>
        `;
    }

    private _renderActionItem(item: ScheduleTableActionItemModel) {
        const titleText = this._buildActionItemLabel(item, item.kind === "appliance_summary");
        if (item.kind === "inverter") {
            return html`
                <scheduling-action-chip
                    .action=${item.action}
                    .authorship=${item.authorship}
                    .localize=${this.localize}
                    .labelVariant=${"table"}
                    .titleText=${titleText}
                    size="compact"
                    ?iconOnly=${true}
                ></scheduling-action-chip>
            `;
        }

        if (item.kind === "appliance_summary") {
            return html`
                <scheduling-appliance-chip
                    .authorship=${item.authorship}
                    .projectionBadge=${item.projectionBadge}
                    .localize=${this.localize}
                    .titleText=${titleText}
                    size="compact"
                    ?iconOnly=${true}
                    ?summary=${true}
                ></scheduling-appliance-chip>
            `;
        }

        return html`
            <scheduling-appliance-chip
                .appliance=${item.appliance}
                .action=${item.action}
                .authorship=${item.authorship}
                .projectionBadge=${item.projectionBadge}
                .localize=${this.localize}
                .titleText=${titleText}
                size="compact"
                ?iconOnly=${true}
            ></scheduling-appliance-chip>
        `;
    }

    private _buildActionHeaderToggleLabel(): string {
        return this.expandedApplianceActions
            ? this.localize("scheduling.actions.collapse_appliance_actions")
            : this.localize("scheduling.actions.expand_appliance_actions");
    }

    private _getVisibleActionItems(items: readonly ScheduleTableActionItemModel[]): ScheduleTableActionItemModel[] {
        if (!this.expandedApplianceActions) {
            return [...items];
        }

        return items.flatMap((item) => item.kind === "appliance_summary" ? item.items : [item]);
    }

    private _renderTimeLabel(label: ScheduleTableSlotRowModel["displayTimeLabel"]) {
        return html`
            <span class="slot-time-label">
                ${label.leading
                    ? html`
                        <span class=${`slot-time-label-leading${label.hideLeading ? " hidden" : ""}`}>
                            ${label.leading}
                        </span>
                    `
                    : nothing}
                <span>${label.primary}</span>
                ${label.trailing
                    ? html`
                        <span class=${`slot-time-label-trailing${label.hideTrailing ? " hidden" : ""}`}>
                            ${label.trailing}
                        </span>
                    `
                    : nothing}
            </span>
        `;
    }

    private _renderForecastCells(point: SlotForecastPoint | null) {
        const forecast = this.tableModel.forecast;
        return [
            html`
                <td class="forecast-cell battery-cell">
                    ${this._renderGauge("battery", forecast.batteryAvailable, point?.socPct ?? null, 100)}
                </td>
            `,
            html`
                <td class="forecast-cell solar-cell">
                    ${this._renderGauge("solar", forecast.solarAvailable, point?.solarWh ?? null, forecast.rowScale.solarMaxWh)}
                </td>
            `,
            html`
                <td class="forecast-cell grid-cell">
                    ${this._renderGridGauge(point, forecast)}
                </td>
            `,
            html`
                <td class="forecast-cell price-cell">
                    ${this._renderPriceGauge(point, forecast)}
                </td>
            `,
        ];
    }

    private _renderGauge(
        type: "battery" | "solar",
        available: boolean,
        value: number | null,
        maxValue: number,
    ) {
        if (!available || value === null) {
            return html`
                <div class="slot-forecast-gauge ${type} unavailable" aria-hidden="true">
                </div>
            `;
        }

        const hideLabel = type === "battery"
            ? value <= 0
            : _isZeroSolarDisplayValue(value);
        const isZero = type === "solar" && hideLabel;
        const widthPct = maxValue > 0 && !hideLabel
            ? Math.min((value / maxValue) * 100, 100)
            : 0;
        const label = type === "battery"
            ? `${Math.round(value)}`
            : _formatSolarGaugeValue(value);
        const classes = `slot-forecast-gauge ${type}${isZero ? " zero" : ""}`;

        return html`
            <div
                class=${classes}
                role="img"
                aria-label=${this._buildGaugeTitle(type, value)}
                title=${this._buildGaugeTitle(type, value)}
            >
                ${widthPct > 0 ? html`
                    <span
                        class="slot-forecast-gauge-fill"
                        style=${`width:${widthPct}%;`}
                        aria-hidden="true"
                    ></span>
                ` : nothing}
                ${!hideLabel && label !== null ? html`<span class="slot-forecast-gauge-text">${label}</span>` : nothing}
            </div>
        `;
    }

    private _renderGridGauge(
        point: SlotForecastPoint | null,
        forecast: ScheduleTableModel["forecast"],
    ) {
        if (
            !forecast.gridAvailable
            || !point
            || (
                point.gridNetKwh === null
                && point.gridImportKwh === null
                && point.gridExportKwh === null
                && point.availableSurplusKwh === null
            )
        ) {
            return html`
                <div class="slot-forecast-gauge grid unavailable" aria-hidden="true">
                </div>
            `;
        }

        const importValue = point.gridImportKwh ?? 0;
        const positiveDisplay = getScheduleGridPositiveDisplay({
            exportKwh: point.gridExportKwh,
            availableSurplusKwh: point.availableSurplusKwh,
        });
        const hasImport = !_isZeroKwhDisplayValue(importValue);
        const hasPositiveDisplay = positiveDisplay.kind !== null;
        const netValue = point.gridNetKwh ?? 0;
        const displayValue = positiveDisplay.kind === "surplus"
            ? positiveDisplay.valueKwh
            : _isZeroKwhDisplayValue(netValue)
            ? 0
            : netValue;
        const isZero = !hasImport && !hasPositiveDisplay && _isZeroKwhDisplayValue(netValue);
        const direction = positiveDisplay.kind === "surplus"
            ? "positive"
            : _getCenterOriginDirection(displayValue);
        const importWidthPct = forecast.rowScale.gridMaxAbsKwh > 0 && hasImport
            ? Math.min((importValue / forecast.rowScale.gridMaxAbsKwh) * 50, 50)
            : 0;
        const positiveWidthPct = forecast.rowScale.gridMaxAbsKwh > 0 && hasPositiveDisplay
            ? Math.min((positiveDisplay.valueKwh / forecast.rowScale.gridMaxAbsKwh) * 50, 50)
            : 0;
        const classes = `slot-forecast-gauge grid${direction ? ` ${direction}` : ""}${positiveDisplay.kind === "surplus" ? " surplus" : ""}${isZero ? " zero" : ""}`;

        return html`
            <div
                class=${classes}
                role="img"
                aria-label=${this._buildGridGaugeTitle(point)}
                title=${this._buildGridGaugeTitle(point)}
            >
                <span class="slot-forecast-gauge-center" aria-hidden="true"></span>
                ${importWidthPct > 0 ? html`
                    <span
                        class="slot-forecast-gauge-fill import"
                        style=${`width:${importWidthPct}%;`}
                        aria-hidden="true"
                    ></span>
                ` : nothing}
                ${positiveWidthPct > 0 && positiveDisplay.kind !== null ? html`
                    <span
                        class=${`slot-forecast-gauge-fill ${positiveDisplay.kind}`}
                        style=${`width:${positiveWidthPct}%;`}
                        aria-hidden="true"
                    ></span>
                ` : nothing}
                ${!isZero ? html`
                    <span class=${`slot-forecast-gauge-text${positiveDisplay.kind === "surplus" ? " surplus" : ""}`}>
                        ${positiveDisplay.kind === "surplus"
                            ? this._formatPositiveGridDisplayValue(displayValue)
                            : this._formatVisibleGridNet(displayValue)}
                    </span>
                ` : nothing}
            </div>
        `;
    }

    private _renderPriceGauge(
        point: SlotForecastPoint | null,
        forecast: ScheduleTableModel["forecast"],
    ) {
        if (!forecast.priceAvailable || !point || point.price === null) {
            return html`
                <div class="slot-forecast-gauge price zero" aria-hidden="true">
                </div>
            `;
        }

        const isZero = _isZeroPriceDisplayValue(point.price);
        const displayValue = isZero ? 0 : point.price;
        const direction = _getCenterOriginDirection(displayValue);
        const widthPct = forecast.rowScale.priceMaxAbs > 0 && direction !== null
            ? Math.min((Math.abs(displayValue) / forecast.rowScale.priceMaxAbs) * 50, 50)
            : 0;

        return html`
            <div
                class=${`slot-forecast-gauge price${direction ? ` ${direction}` : ""}${isZero ? " zero" : ""}`}
                role="img"
                aria-label=${this._buildPriceGaugeTitle(displayValue, forecast.priceDisplayUnit)}
                title=${this._buildPriceGaugeTitle(displayValue, forecast.priceDisplayUnit)}
            >
                <span class="slot-forecast-gauge-center" aria-hidden="true"></span>
                ${direction !== null && widthPct > 0 ? html`
                    <span
                        class=${`slot-forecast-gauge-fill ${direction}`}
                        style=${`width:${widthPct}%;`}
                        aria-hidden="true"
                    ></span>
                ` : nothing}
                ${!isZero ? html`
                    <span class="slot-forecast-gauge-text">${_formatVisiblePriceValue(displayValue)}</span>
                ` : nothing}
            </div>
        `;
    }

    private _renderSlotRuntime(compliance: ScheduleRuntimeComplianceModel) {
        const summaryChipClass = this._getRuntimeSummaryChipClass(compliance.severity);
        return html`
            <div class="slot-runtime-summary">
                <div class=${summaryChipClass}>
                    <ha-icon
                        class="slot-runtime-summary-icon"
                        .icon=${compliance.icon}
                        aria-hidden="true"
                    ></ha-icon>
                    <span class="slot-runtime-summary-label">${compliance.summaryLabel}</span>
                </div>
            </div>
            ${compliance.issues.length > 0 ? html`
                <div class="slot-runtime-details">
                    ${compliance.issues.map((issue) => html`
                        <div class="slot-runtime-line">
                            <span class="slot-runtime-line-actor">${issue.actorLabel}:</span>
                            ${issue.actualLabel}
                            ${issue.reasonLabel ? html` &mdash; ${issue.reasonLabel}` : nothing}
                        </div>
                    `)}
                </div>
            ` : nothing}
        `;
    }

    private _getRuntimeSummaryChipClass(severity: ScheduleRuntimeComplianceSeverity): string {
        switch (severity) {
            case "success":
                return "chip success";
            case "warning":
                return "chip warning";
            case "error":
                return "chip error";
        }
    }

    private _getRuntimeRowClass(runtimeCompliance: ScheduleRuntimeComplianceModel | null): string {
        if (runtimeCompliance === null) {
            return "";
        }

        return ` runtime-${runtimeCompliance.severity}`;
    }

    private _buildActionCellLabel(actionCell: ScheduleTableActionCellModel): string {
        return actionCell.items.map((item) => this._buildActionItemLabel(item, item.kind === "appliance_summary")).join(", ");
    }

    private _buildActionItemLabel(item: ScheduleTableActionItemModel, includeAuthorshipCounts = false): string {
        if (item.kind === "inverter") {
            return [
                getScheduleActionLabel(item.action, this.localize),
                this._buildAuthorshipLabel(item.authorship, includeAuthorshipCounts),
            ].filter((part) => part.length > 0).join(", ");
        }

        if (item.kind === "appliance_summary") {
            const parts = [
                this.localize("scheduling.dialog.appliances"),
                this._buildAuthorshipLabel(item.authorship, includeAuthorshipCounts),
            ];
            if (item.projectionBadge !== null) {
                parts.push(this._buildProjectionBadgeLabel(item.projectionBadge));
            }
            return parts.filter((part) => part.length > 0).join(", ");
        }

        const presentation = getScheduleApplianceActionPresentation({
            appliance: item.appliance,
            action: item.action,
            localize: this.localize,
        });
        const authorshipLabel = this._buildAuthorshipLabel(item.authorship, includeAuthorshipCounts);
        if (item.projectionBadge === null) {
            return [item.appliance.name, presentation.label, authorshipLabel]
                .filter((part) => part.length > 0)
                .join(" · ");
        }

        return [
            item.appliance.name,
            presentation.label,
            this._buildProjectionBadgeLabel(item.projectionBadge),
            authorshipLabel,
        ].filter((part) => part.length > 0).join(" · ");
    }

    private _buildProjectionBadgeLabel(
        projectionBadge: ScheduleApplianceProjectionBadge | null,
    ): string {
        return projectionBadge === null
            ? ""
            : getScheduleApplianceProjectionBadgeLabel(projectionBadge, this.localize);
    }

    private _buildAuthorshipLabel(
        authorship: ScheduleActionAuthorshipSummary | null,
        includeCounts: boolean,
    ): string {
        if (authorship === null || authorship.state === "none") {
            return "";
        }

        const baseLabel = authorship.state === "user"
            ? this.localize("scheduling.authorship.set_by_user")
            : authorship.state === "automation"
            ? this.localize("scheduling.authorship.set_by_automation")
            : this.localize("scheduling.authorship.mixed");
        if (!includeCounts || authorship.state !== "mixed") {
            return baseLabel;
        }

        return [
            baseLabel,
            `${this.localize("scheduling.authorship.user")}: ${authorship.counts.user}`,
            `${this.localize("scheduling.authorship.automation")}: ${authorship.counts.automation}`,
        ].join(", ");
    }

    private _buildGridGaugeTitle(point: SlotForecastPoint): string {
        const titleParts = [
            this.localize("scheduling.forecast.grid_label"),
            `${this.localize("scheduling.forecast.net")}: ${this._formatSignedGridEnergy(point.gridNetKwh ?? 0)}`,
            `${this.localize("scheduling.forecast.import")}: ${this._formatGridEnergy(point.gridImportKwh ?? 0)}`,
            `${this.localize("scheduling.forecast.export")}: ${this._formatGridEnergy(point.gridExportKwh ?? 0)}`,
        ];
        if (
            point.availableSurplusKwh !== null
            && !_isZeroKwhDisplayValue(point.availableSurplusKwh)
        ) {
            titleParts.push(
                `${this.localize("scheduling.forecast.surplus")}: ${this._formatGridEnergy(point.availableSurplusKwh)}`,
            );
        }
        return titleParts.join(" · ");
    }

    private _buildPriceGaugeTitle(price: number, unit: string | null): string {
        return `${this.localize("scheduling.forecast.price_label")}: ${this._formatPriceValue(price, unit)}`;
    }

    private _buildGaugeTitle(type: "battery" | "solar", value: number): string {
        const gaugeLabel = type === "battery"
            ? this.localize("scheduling.forecast.battery_label")
            : this.localize("scheduling.forecast.solar_label");
        const label = type === "battery"
            ? `${Math.round(value)}%`
            : _formatSolarGaugeTitle(value);
        return `${gaugeLabel}: ${label}`;
    }

    private _buildDayBatteryAggregateTitle(minSocPct: number, maxSocPct: number): string {
        return `${this.localize("scheduling.forecast.battery_label")}: ${Math.round(minSocPct)}% : ${Math.round(maxSocPct)}%`;
    }

    private _buildDaySolarAggregateTitle(wh: number): string {
        return `${this.localize("scheduling.forecast.solar_label")}: ${_formatSolarGaugeTitle(wh)}`;
    }

    private _buildDayGridAggregateTitle(aggregate: ScheduleTableDayAggregateModel): string {
        const titleParts = [
            this.localize("scheduling.forecast.grid_label"),
            `${this.localize("scheduling.forecast.import")}: ${this._formatGridEnergy(aggregate.gridImportKwh ?? 0)}`,
            `${this.localize("scheduling.forecast.export")}: ${this._formatGridEnergy(aggregate.gridExportKwh ?? 0)}`,
        ];
        if (
            aggregate.availableSurplusKwh !== null
            && !_isZeroKwhDisplayValue(aggregate.availableSurplusKwh)
        ) {
            titleParts.push(
                `${this.localize("scheduling.forecast.surplus")}: ${this._formatGridEnergy(aggregate.availableSurplusKwh)}`,
            );
        }
        return titleParts.join(" · ");
    }

    private _buildDayPriceAggregateTitle(
        aggregate: ScheduleTableDayAggregateModel,
        unit: string | null,
    ): string {
        const ranges: string[] = [];
        if (aggregate.priceNegativeMin !== null && aggregate.priceNegativeMax !== null) {
            ranges.push(
                `${this._formatPriceValue(aggregate.priceNegativeMin, unit)} to ${this._formatPriceValue(aggregate.priceNegativeMax, unit)}`,
            );
        }
        if (aggregate.pricePositiveMin !== null && aggregate.pricePositiveMax !== null) {
            ranges.push(
                `${this._formatPriceValue(aggregate.pricePositiveMin, unit)} to ${this._formatPriceValue(aggregate.pricePositiveMax, unit)}`,
            );
        }

        const title = ranges.length > 0
            ? ranges.join(" · ")
            : this._formatPriceValue(0, unit);
        return `${this.localize("scheduling.forecast.price_label")}: ${title}`;
    }

    private _formatVisibleGridNet(kwh: number): string {
        const prefix = kwh > 0 ? "+" : kwh < 0 ? "−" : "";
        return `${prefix}${Math.abs(kwh).toFixed(1)}`;
    }

    private _formatCompactGridNet(kwh: number): string {
        const prefix = kwh > 0 ? "+" : kwh < 0 ? "−" : "";
        return `${prefix}${_formatKwhValue(kwh)}`;
    }

    private _formatPositiveGridDisplayValue(kwh: number): string {
        return `+${_formatKwhValue(kwh)}`;
    }

    private _formatSignedGridEnergy(kwh: number): string {
        return `${this._formatCompactGridNet(kwh)} kWh`;
    }

    private _formatGridEnergy(kwh: number): string {
        return `${_formatKwhValue(kwh)} kWh`;
    }

    private _formatPriceValue(value: number, unit: string | null): string {
        const formattedValue = _formatVisiblePriceValue(value);
        return unit ? `${formattedValue} ${unit}` : formattedValue;
    }

    private _buildHourToggleAriaLabel(row: ScheduleTableHourRowModel): string {
        return `${this.localize(
            row.expanded ? "scheduling.actions.collapse_hour" : "scheduling.actions.expand_hour",
        )} ${row.rangeLabel}`;
    }

    private _buildDayToggleAriaLabel(section: ScheduleTableSectionModel, expanded: boolean): string {
        return `${this.localize(
            expanded ? "scheduling.actions.collapse_day" : "scheduling.actions.expand_day",
        )} ${section.dayLabel}`;
    }

    private _buildDayHeaderId(dayKey: string): string {
        return `schedule-day-${dayKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    }

    private _handleTimeClick(slotId: string, event: MouseEvent, slotIds?: readonly string[]): void {
        if (this.busy) {
            return;
        }

        this.dispatchEvent(new CustomEvent("toggle-schedule-slot-selection", {
            bubbles: true,
            composed: true,
            detail: {
                slotId,
                slotIds: slotIds ? [...slotIds] : undefined,
                shiftKey: event.shiftKey,
            } satisfies ScheduleSlotToggleDetail,
        }));
    }

    private _handleActionClick(slotId: string | null, slotIds?: readonly string[]): void {
        if (this.busy || slotId === null) {
            return;
        }

        this.dispatchEvent(new CustomEvent("open-schedule-dialog", {
            bubbles: true,
            composed: true,
            detail: {
                slotId,
                slotIds: slotIds ? [...slotIds] : undefined,
            } satisfies ScheduleDialogOpenDetail,
        }));
    }

    private _handleHourExpansionClick(hourKey: string, event: MouseEvent): void {
        event.stopPropagation();
        this.dispatchEvent(new CustomEvent("toggle-schedule-hour-expansion", {
            bubbles: true,
            composed: true,
            detail: { hourKey } satisfies ScheduleHourToggleDetail,
        }));
    }

    private _handleActionViewToggle(event: MouseEvent): void {
        event.stopPropagation();
        this.dispatchEvent(new CustomEvent("toggle-schedule-action-view", {
            bubbles: true,
            composed: true,
            detail: { expanded: !this.expandedApplianceActions } satisfies ScheduleActionViewToggleDetail,
        }));
    }

    private _handleDayExpansionClick(dayKey: string, event: MouseEvent): void {
        event.stopPropagation();
        this.dispatchEvent(new CustomEvent("toggle-schedule-day-expansion", {
            bubbles: true,
            composed: true,
            detail: { dayKey } satisfies ScheduleDayToggleDetail,
        }));
    }
}
