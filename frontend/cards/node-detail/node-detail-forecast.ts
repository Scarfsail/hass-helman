import { html, nothing, type TemplateResult } from "lit";
import type { ApplianceProjectionsPayload } from "../helman-api";
import type { HomeAssistant } from "../../types/ha";
import { fillTemplate, type LocalizeFunction } from "../localize/localize";
import { formatScheduleTime, getScheduleSlotStartMs } from "../shared/schedule/model/schedule-time";
import { modeStripWindow } from "../shared/mode-strip";
import { SLOT_MS } from "../shared/time/slot-time";
import type { DayLineMarker, DayLinePoint, DayLineReference, DayLineSeries, DayLineSpan } from "../shared/day-line-chart";
import { dayKey, todayAndTomorrow } from "./node-detail-schedule";
import { hassLocale, timeZone } from "./section-resource";
import "../shared/day-line-chart";
import "./detail-section";
import "./help-tip";

/**
 * What every node's Forecast section shares: the section around a summary,
 * one chart over today 00:00 → tomorrow noon (the Schedule strip's window)
 * titled with its help, and the appliances' projected energy grouped into runs.
 */

const HOUR_MS = 3_600_000;

/** The Forecast section; its body is rendered only while it is open. */
export function renderForecastSection(
    localize: LocalizeFunction,
    summary: TemplateResult | string,
    open: boolean,
    toggle: (open: boolean) => void,
    body: () => TemplateResult,
): TemplateResult {
    return html`
        <helman-detail-section data-forecast icon="mdi:chart-line" .title=${localize("node_detail.shared.forecast.title")}
            .expanded=${open} @expanded-changed=${(event: CustomEvent<boolean>) => toggle(event.detail)}>
            <span slot="summary">${summary}</span>
            ${open ? html`<div class="content" data-forecast-body>${body()}</div>` : nothing}
        </helman-detail-section>
    `;
}

/** Where and when a forecast chart is drawn. */
export interface ForecastChartContext {
    localize: LocalizeFunction;
    timeZone: string;
    locale: string;
    now: number;
}

/** Where and when a detail's forecast charts draw: HA's time zone and language, now. */
export function forecastChartContext(hass: HomeAssistant, localize: LocalizeFunction): ForecastChartContext {
    return { localize, timeZone: timeZone(hass), locale: hassLocale(hass), now: Date.now() };
}

export interface ForecastChart {
    title: string;
    help: string;
    series: DayLineSeries[];
    formatValue: (value: number) => string;
    references?: DayLineReference[];
    /** The axis labels, when not three spread over the range. */
    ticks?: number[];
    markers?: DayLineMarker[];
    spans?: DayLineSpan[];
    step?: boolean;
}

/** A forecast chart under its title and help, over today → tomorrow noon, with the now marker. */
export function renderForecastChart(context: ForecastChartContext, chart: ForecastChart): TemplateResult {
    const { start, end } = modeStripWindow(context.now, context.timeZone);
    return html`
        <div class="section-title" data-chart-title>${chart.title}<helman-help-tip .explanation=${chart.help}></helman-help-tip></div>
        <helman-day-line-chart
            data-forecast-chart
            .series=${chart.series}
            .references=${chart.references ?? []}
            .ticks=${chart.ticks ?? null}
            .markers=${chart.markers ?? []}
            .spans=${chart.spans ?? []}
            .step=${chart.step ?? false}
            .start=${start}
            .end=${end}
            .bucketMs=${SLOT_MS}
            .now=${context.now}
            .nowLabel=${context.localize("node_detail.shared.now")}
            .timeZone=${context.timeZone}
            .locale=${context.locale}
            .formatValue=${chart.formatValue}
        ></helman-day-line-chart>
    `;
}

/** A time, or a range to `endMs`, as the forecast rows say it: with "tomorrow" once it starts after midnight. */
export function forecastWhen(ms: number, context: ForecastChartContext, endMs?: number): string {
    const format = (at: number) => formatScheduleTime(at, context.locale, context.timeZone);
    const time = endMs === undefined ? format(ms) : `${format(ms)}–${format(endMs)}`;
    const [, tomorrow] = todayAndTomorrow(context.now, context.timeZone);
    return dayKey(ms, context.timeZone) === tomorrow
        ? fillTemplate(context.localize("node_detail.shared.forecast.tomorrow"), { time })
        : time;
}

/**
 * Readings in time order held at each slot boundary from `start` to `end`:
 * the value in force then, `initial` before the first reading; none while
 * nothing is known. A value that changes now and then reads as one line,
 * never as dots the chart's gap rule would break apart.
 */
export function holdAtSlots(readings: readonly DayLinePoint[], start: number, end: number, initial: number | null = null): DayLinePoint[] {
    const points: DayLinePoint[] = [];
    let index = 0;
    let value = initial;
    for (let t = start; t <= end; t += SLOT_MS) {
        while (index < readings.length && readings[index].t <= t) value = readings[index++].v;
        if (value !== null) points.push({ t, v: value });
    }
    return points;
}

/** A slot's energy, kWh, as its average power, kW. */
export function slotKw(kwh: number): number {
    return kwh / (SLOT_MS / HOUR_MS);
}

/** The share of the slot starting at `startMs` still ahead at `at`: 1 for a future slot, less in progress. */
export function remainingShare(startMs: number, at: number): number {
    return Math.max(0, Math.min(1, (startMs + SLOT_MS - Math.max(startMs, at)) / SLOT_MS));
}

export interface ProjectedSlot {
    startMs: number;
    kwh: number;
}

/** A run of consecutive projected slots, and its energy. */
export interface ProjectedRun {
    startMs: number;
    endMs: number;
    kwh: number;
}

/**
 * The energy the projection plans for `ids` (summed per slot) from the slot in
 * progress at `now` to `end`, in time order.
 */
export function projectedSlots(payload: ApplianceProjectionsPayload | null, ids: readonly string[], now: number, end: number): ProjectedSlot[] {
    const bySlot = new Map<number, number>();
    const from = Math.floor(now / SLOT_MS) * SLOT_MS;
    for (const id of ids) {
        for (const point of payload?.appliances?.[id]?.series ?? []) {
            const startMs = getScheduleSlotStartMs(point.slotId);
            if (startMs === null || startMs < from || startMs >= end || !(point.energyKwh > 0)) continue;
            bySlot.set(startMs, (bySlot.get(startMs) ?? 0) + point.energyKwh);
        }
    }
    return [...bySlot].sort(([a], [b]) => a - b).map(([startMs, kwh]) => ({ startMs, kwh }));
}

/** Consecutive slots merged into runs. */
export function projectedRuns(slots: readonly ProjectedSlot[]): ProjectedRun[] {
    const runs: ProjectedRun[] = [];
    for (const slot of slots) {
        const last = runs[runs.length - 1];
        if (last && last.endMs === slot.startMs) {
            last.endMs += SLOT_MS;
            last.kwh += slot.kwh;
        } else {
            runs.push({ startMs: slot.startMs, endMs: slot.startMs + SLOT_MS, kwh: slot.kwh });
        }
    }
    return runs;
}

/** The energy `slots` plan within `[startMs, endMs)`. */
export function projectedKwh(slots: readonly ProjectedSlot[], startMs: number, endMs: number): number {
    return slots.reduce((sum, slot) => slot.startMs >= startMs && slot.startMs < endMs ? sum + slot.kwh : sum, 0);
}
