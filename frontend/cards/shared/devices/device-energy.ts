import { css, html, type TemplateResult } from "lit";

import type { DeviceStats } from "../../helman-api";

/**
 * One device's energy on one scale, kWh per hour while on, wherever it is
 * shown: the Training tab's device table, the device editor and the device
 * detail dialog all render through `renderDeviceEnergyValue`.
 *
 * The colour says where the number came from: green learned while on, orange
 * approximated from the daily mean, blue configured.
 */

/** Where a learned figure came from: while on, or the daily mean over 24 h. */
export type DeviceEnergySource = "on" | "day";

/** What `renderDeviceEnergyValue` shows for one device. */
export interface DeviceEnergyInput {
    /** The device's usage record, when it has one. */
    record?: DeviceStats;
    /** The `hourly_energy_kwh` the forecast projects with, when it does. */
    configured?: number;
    /** Why there is no estimate: a failure reason, or not trained yet. */
    note?: string;
}

/** A catalog lookup over the `device_energy.*` key block. */
export type DeviceEnergyText = (key: string) => string;

/**
 * The learned figure in kWh/h: while on when the device has a running signal,
 * else its daily mean over 24 hours.
 */
export function deviceEnergyFigure(
    record?: DeviceStats,
): { kwh: number; source: DeviceEnergySource } | undefined {
    if (typeof record?.on_kwh_per_hour === "number") {
        return { kwh: record.on_kwh_per_hour, source: "on" };
    }
    const mean = record?.daily_kwh?.mean;
    return typeof mean === "number" ? { kwh: mean / 24, source: "day" } : undefined;
}

/** The hover's measures, each `undefined` where the history does not answer it. */
export function deviceEnergyMeasures(record?: DeviceStats): {
    whileOn?: number;
    average?: number;
    perDay?: number;
    runningKw?: number;
} {
    const mean = record?.daily_kwh?.mean;
    return {
        whileOn: record?.on_kwh_per_hour,
        average: typeof mean === "number" ? mean / 24 : undefined,
        perDay: mean,
        runningKw: record?.running_kw,
    };
}

function format(value: number | undefined, unit: string): string {
    return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)} ${unit}` : "—";
}

/**
 * The device's energy as a coloured `kWh/h`, with every measure in its hover.
 *
 * With a `configured` figure, that blue figure comes first and the learned one
 * follows in parentheses, or a dash when there is none.
 */
export function renderDeviceEnergyValue(
    t: DeviceEnergyText,
    { record, configured, note }: DeviceEnergyInput = {},
): TemplateResult {
    const measures = deviceEnergyMeasures(record);
    const title = [
        `${t("while_on")}: ${format(measures.whileOn, "kWh/h")}`,
        `${t("average")}: ${format(measures.average, "kWh/h")}`,
        `${t("per_day")}: ${format(measures.perDay, "kWh")}`,
        `${t("running_power")}: ${format(measures.runningKw, "kW")}`,
        ...(configured !== undefined ? [`${t("configured")}: ${format(configured, "kWh/h")}`] : []),
        ...(note ? [note] : []),
    ].join("\n");
    const figure = deviceEnergyFigure(record);
    const learned = figure
        ? html`<span class="device-energy-value ${figure.source}">${format(figure.kwh, "kWh/h")}</span>`
        : "—";
    return html`<span class="device-energy" title=${title}>${configured !== undefined
        ? html`<span class="device-energy-value configured">${format(configured, "kWh/h")}</span> (${learned})`
        : learned}</span>`;
}

/** The source colours, which Home Assistant's theme owns. */
export const deviceEnergyStyles = css`
    .device-energy {
        cursor: help;
    }
    .device-energy-value.on {
        color: var(--success-color);
    }
    .device-energy-value.day {
        color: var(--warning-color);
    }
    .device-energy-value.configured {
        color: var(--info-color);
    }
`;
