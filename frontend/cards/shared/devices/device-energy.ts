import { css, html, type TemplateResult } from "lit";

import type { DeviceStats } from "../../helman-api";
import { formatPower } from "../../power-format";

/**
 * One device's energy on one power scale, auto-scaled W or kW, wherever it is
 * shown: the Training tab's device table, the device editor and the device
 * detail dialog all render through `renderDeviceEnergyValue`.
 *
 * The headline is chosen by schedulability: a schedulable device headlines its
 * average while switched on, which the scheduler projects with; any other
 * device its power while active. Both fall back to the daily average.
 *
 * The colour says where the number came from: green learned, orange
 * approximated from the daily mean, blue configured.
 */

/**
 * Which learned figure: the average while switched on, the power while
 * active, or the daily mean over 24 h.
 */
export type DeviceEnergySource = "on" | "running" | "day";

/** What `renderDeviceEnergyValue` shows for one device. */
export interface DeviceEnergyInput {
    /** The device's usage record, when it has one. */
    record?: DeviceStats;
    /** Whether the device scheduler projects the device's energy. */
    schedulable: boolean;
    /** The `hourly_energy_kwh` the forecast projects with, when it does. */
    configured?: number;
    /** Why there is no estimate: a failure reason, or not trained yet. */
    note?: string;
}

/** A catalog lookup over the `device_energy.*` key block. */
export type DeviceEnergyText = (key: string) => string;

/** Each learned figure's name in the `device_energy.*` catalog block. */
const SOURCE_KEYS: Record<DeviceEnergySource, string> = {
    on: "while_on",
    running: "running_power",
    day: "average",
};

function watts(kwhPerHour: number | undefined): number | undefined {
    return typeof kwhPerHour === "number" && Number.isFinite(kwhPerHour) ? kwhPerHour * 1000 : undefined;
}

/**
 * The hover's measures, each `undefined` where the history does not answer it:
 * every per-hour figure in watts, the mean day in kWh.
 */
export function deviceEnergyMeasures(record?: DeviceStats): Record<DeviceEnergySource, number | undefined> & {
    perDay?: number;
} {
    const mean = record?.daily_kwh?.mean;
    return {
        on: watts(record?.on_kwh_per_hour),
        running: watts(record?.running_kw),
        day: watts(typeof mean === "number" ? mean / 24 : undefined),
        perDay: mean,
    };
}

/**
 * The headline learned figure in watts: a schedulable device's average while
 * switched on, any other device's power while active, else the daily mean
 * over 24 hours.
 */
export function deviceEnergyFigure(
    record: DeviceStats | undefined,
    schedulable: boolean,
): { watts: number; source: DeviceEnergySource } | undefined {
    const measures = deviceEnergyMeasures(record);
    const source = ([schedulable ? "on" : "running", "day"] as const).find(
        (candidate) => measures[candidate] !== undefined,
    );
    return source ? { watts: measures[source]!, source } : undefined;
}

/** A learned figure's name. */
export function deviceEnergySourceLabel(t: DeviceEnergyText, source: DeviceEnergySource): string {
    return t(SOURCE_KEYS[source]);
}

/**
 * The name of the headline `renderDeviceEnergyValue` shows. A configured
 * figure is energy per hour switched on, so it is named as that.
 */
export function deviceEnergyLabel(
    t: DeviceEnergyText,
    { record, schedulable, configured }: DeviceEnergyInput,
): string {
    const source = configured !== undefined
        ? "on"
        : deviceEnergyFigure(record, schedulable)?.source ?? (schedulable ? "on" : "running");
    return deviceEnergySourceLabel(t, source);
}

/** A power figure auto-scaled to W or kW, or a dash. */
export function formatDeviceEnergyWatts(value: number | undefined): string {
    return value === undefined ? "—" : formatPower(value).display;
}

/**
 * The device's headline figure as coloured power, with every measure in its
 * hover.
 *
 * With a `configured` figure, that blue figure comes first and the learned one
 * follows in parentheses, or a dash when there is none. A schedulable device's
 * hover notes that the scheduler projects with the figure shown first, when
 * that is one it does project with: the configured figure or the average while
 * switched on, never the daily-average fallback.
 */
export function renderDeviceEnergyValue(
    t: DeviceEnergyText,
    { record, schedulable, configured, note }: DeviceEnergyInput,
): TemplateResult {
    const measures = deviceEnergyMeasures(record);
    const figure = deviceEnergyFigure(record, schedulable);
    const configuredWatts = watts(configured);
    const title = [
        ...(["on", "running", "day"] as const).map(
            (source) => `${deviceEnergySourceLabel(t, source)}: ${formatDeviceEnergyWatts(measures[source])}`,
        ),
        `${t("per_day")}: ${typeof measures.perDay === "number" ? `${measures.perDay.toFixed(2)} kWh` : "—"}`,
        ...(configured !== undefined ? [`${t("configured")}: ${formatDeviceEnergyWatts(configuredWatts)}`] : []),
        ...(schedulable && (configured !== undefined || figure?.source === "on") ? [t("scheduler_note")] : []),
        ...(note ? [note] : []),
    ].join("\n");
    const learned = figure
        ? html`<span class="device-energy-value ${figure.source}">${formatDeviceEnergyWatts(figure.watts)}</span>`
        : "—";
    return html`<span class="device-energy" title=${title}>${configured !== undefined
        ? html`<span class="device-energy-value configured">${formatDeviceEnergyWatts(configuredWatts)}</span> (${learned})`
        : learned}</span>`;
}

/** The source colours, which Home Assistant's theme owns. */
export const deviceEnergyStyles = css`
    .device-energy {
        cursor: help;
    }
    .device-energy-value.on,
    .device-energy-value.running {
        color: var(--success-color);
    }
    .device-energy-value.day {
        color: var(--warning-color);
    }
    .device-energy-value.configured {
        color: var(--info-color);
    }
`;
