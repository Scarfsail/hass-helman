import { html, type TemplateResult } from "lit";
import type { ApplianceProjectionsPayload } from "../helman-api";
import type { HomeAssistant } from "../../types/ha";
import { fillTemplate, type LocalizeFunction } from "../localize/localize";
import { formatKwh, formatPower } from "../shared/format";
import { powerUnitFactor } from "../shared/power-reading";
import { formatScheduleTime, getScheduleSlotStartMs } from "../shared/schedule/model/schedule-time";
import { modeStripWindow } from "../shared/mode-strip";
import { SLOT_MS } from "../shared/time/slot-time";
import type { DayLineMarker, DayLinePoint, DayLineReference, DayLineSeries, DayLineSpan } from "../shared/day-line-chart";
import { dayKey, todayAndTomorrow } from "./node-detail-schedule";
import { hassLocale, timeZone, type SectionHost, type SectionOptions } from "./section-resource";
import "../shared/day-line-chart";
import { boldTemplate, renderSummarySection } from "./detail-section";
import { renderShowMore } from "./node-detail-history";
import "./help-tip";

/**
 * What every node's Forecast section shares: the section around a summary,
 * one chart over today 00:00 → tomorrow noon (the Schedule strip's window)
 * titled with its help, an entity's recorded readings and their slot means,
 * a consumer's actual and planned power, and the appliances' projected energy
 * grouped into runs.
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
    return renderSummarySection("forecast", "mdi:chart-line", localize("node_detail.shared.forecast.title"), summary, open, toggle, body);
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
    /** The entities behind the actual series, for the Show more link; none without one. */
    entities?: string[];
}

/** A forecast chart under its title and help, over today → tomorrow noon, with the now marker and a Show more link to its entities. */
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
        ${renderShowMore(chart.entities ?? [], context.localize)}
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

/** An entity's readings in HA's history from `start` to `end`, in time order; a state that is not a number reads `NaN`. */
export async function readEntityReadings(hass: HomeAssistant, entityId: string, start: number, end: number): Promise<DayLinePoint[]> {
    const result = await hass.callWS<Record<string, Array<{ s: string; lu: number }>>>({
        type: "history/history_during_period", start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString(),
        entity_ids: [entityId], minimal_response: true, no_attributes: true, significant_changes_only: false,
    });
    return (result?.[entityId] ?? [])
        .map((state) => ({ t: state.lu * 1000, v: Number(state.s) }));
}

/**
 * Readings in time order as the time-weighted mean of each slot from `start`
 * to the slot in progress at `end`, each reading held until the next: a short
 * run counts for its share of the slot, where a value held at the boundary
 * would miss it. A reading that is not a number ends the one before it: a
 * slot with no reading in force has none, one partly covered the mean of
 * what is.
 */
export function slotMeans(readings: readonly DayLinePoint[], start: number, end: number): DayLinePoint[] {
    const points: DayLinePoint[] = [];
    let index = 0;
    let value: number | null = null;
    for (let t = start; t < end; t += SLOT_MS) {
        const slotEnd = Math.min(t + SLOT_MS, end);
        let at = t;
        let area = 0;
        let known = 0;
        while (at < slotEnd) {
            while (index < readings.length && readings[index].t <= at) {
                const reading = readings[index++].v;
                value = Number.isFinite(reading) ? reading : null;
            }
            const until = index < readings.length ? Math.min(readings[index].t, slotEnd) : slotEnd;
            if (value !== null) {
                area += value * (until - at);
                known += until - at;
            }
            at = until;
        }
        if (known > 0) points.push({ t, v: area / known });
    }
    return points;
}

/**
 * A power entity's mean power in each slot since midnight, kW, read while
 * `shown` and the entity is there; re-read once per slot. A unit not known
 * draws nothing.
 */
export function powerHistorySection(host: SectionHost, entityId: () => string | null | undefined, shown: () => boolean): SectionOptions<DayLinePoint[]> {
    return {
        fetch: async () => {
            const id = entityId()!;
            const factor = powerUnitFactor(host.hass, id);
            if (factor === null) return [];
            const now = Date.now();
            const { start } = modeStripWindow(now, timeZone(host.hass));
            return slotMeans(await readEntityReadings(host.hass, id, start, now), start, now)
                .map((point) => ({ t: point.t, v: point.v * factor / 1000 }));
        },
        shown: () => shown() && !!entityId(),
        key: () => entityId() ?? "",
        staleness: (_payload, requestedAt) => requestedAt < Math.floor(Date.now() / SLOT_MS) * SLOT_MS,
    };
}

/**
 * A consumer's power today → tomorrow noon: the `actual` slot means since
 * midnight solid, and the power the plan's `slots` draw dashed, off between
 * its runs; no actual line without a power entity, no planned line without a
 * plan. Its Show more opens `entities`.
 */
export function renderDevicePowerChart(context: ForecastChartContext, actual: DayLinePoint[] | null, slots: readonly ProjectedSlot[], entities: string[]): TemplateResult {
    const forecast = (key: string) => context.localize(`node_detail.shared.forecast.${key}`);
    const first = Math.floor(context.now / SLOT_MS) * SLOT_MS;
    const end = modeStripWindow(context.now, context.timeZone).end;
    const bySlot = new Map(slots.map((slot) => [slot.startMs, slot.kwh]));
    // The slots hold only what is still ahead of the slot in progress.
    const power = (startMs: number, kwh: number) => {
        const share = remainingShare(startMs, context.now);
        return share > 0 ? slotKw(kwh / share) : 0;
    };
    const series: DayLineSeries[] = [];
    const help: string[] = [];
    if (actual) {
        series.push({ key: "actual", label: forecast("actual"), color: "var(--helman-house)", points: actual });
        help.push(forecast("device_help_actual"));
    }
    if (slots.length) {
        const planned: DayLinePoint[] = [];
        // Off between the runs is planned too: zero, not a gap.
        for (let t = first; t < end; t += SLOT_MS) planned.push({ t, v: power(t, bySlot.get(t) ?? 0) });
        const kw = Math.max(...slots.map((slot) => power(slot.startMs, slot.kwh)));
        series.push({ key: "planned", label: forecast("planned"), color: "var(--helman-house)", points: planned, dashed: true });
        help.push(fillTemplate(forecast("device_help"), { kw: formatPower(kw * 1000).display }));
    }
    return renderForecastChart(context, {
        title: forecast("device_chart"),
        help: help.join(" "),
        series,
        step: true,
        formatValue: (value) => formatPower(value * 1000).display,
        entities,
    });
}

/**
 * A consumer's Forecast summary: what its plan's `slots` still draw to
 * tomorrow noon, or, once the plan is `read`, that nothing is planned; none
 * while it is still read.
 */
export function deviceForecastSummary(slots: readonly ProjectedSlot[], read: boolean, localize: LocalizeFunction): TemplateResult | string {
    if (!slots.length) return read ? localize("node_detail.shared.forecast.nothing_planned") : "";
    const total = slots.reduce((sum, slot) => sum + slot.kwh, 0);
    return boldTemplate(localize("node_detail.shared.forecast.device_summary"), { kwh: `≈ ${formatKwh(total)} kWh` });
}

/** A slot's energy, kWh, as its average power, kW: over a standard slot unless the backend gives its `hours`. */
export function slotKw(kwh: number, hours: number = SLOT_MS / HOUR_MS): number {
    return kwh / hours;
}

/**
 * The share of the slot starting at `startMs` (of `durationMs`, a standard slot
 * unless the backend supplies a partial one) still ahead at `at`: 1 for a
 * future slot, less in progress, 0 once over.
 */
export function remainingShare(startMs: number, at: number, durationMs: number = SLOT_MS): number {
    return durationMs > 0 ? Math.max(0, Math.min(1, (startMs + durationMs - Math.max(startMs, at)) / durationMs)) : 0;
}

/** What of a projected slot's energy, cut at generation, is still ahead at `now`. */
export function stillAhead(startMs: number, generated: number, now: number): number {
    const then = Number.isFinite(generated) ? remainingShare(startMs, generated) : 1;
    return then > 0 ? Math.min(1, remainingShare(startMs, now) / then) : 1;
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
 * progress at `now` to `end`, in time order. The backend already cut the slot
 * in progress to what was left of it when the projection was generated; what
 * has run since is taken off too, so the slot counts only what is still ahead.
 */
export function projectedSlots(payload: ApplianceProjectionsPayload | null, ids: readonly string[], now: number, end: number): ProjectedSlot[] {
    const bySlot = new Map<number, number>();
    const from = Math.floor(now / SLOT_MS) * SLOT_MS;
    const generated = Date.parse(payload?.generatedAt ?? "");
    for (const id of ids) {
        for (const point of payload?.appliances?.[id]?.series ?? []) {
            const startMs = getScheduleSlotStartMs(point.slotId);
            if (startMs === null || startMs < from || startMs >= end || !(point.energyKwh > 0)) continue;
            bySlot.set(startMs, (bySlot.get(startMs) ?? 0) + point.energyKwh * stillAhead(startMs, generated, now));
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
