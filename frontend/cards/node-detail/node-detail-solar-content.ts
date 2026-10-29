import { formatKwh, formatPower } from "../shared/format";
import { SLOT_MS } from "../shared/time/slot-time";
import { css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { fillTemplate } from "../localize/localize";
import {
    getEffectiveSolarForecastPoints,
    type DayStatsDTO,
    type SolarDestinationsSectionPayload,
    type SolarDetailPayload,
    type SolarPowerSectionPayload,
    type SolarProductionSectionPayload,
} from "../helman-api";
import { NEUTRAL_LIGHT_COLOR } from "../color-utils";
import { currencyFromPriceUnit } from "../helman-solar-inspector/money-model";
import { helmanColorVars } from "../color-vars";

import { addDaysToDayKey } from "../shared/schedule/model/schedule-time";
import "../shared/day-line-chart";
import type { DayLineSeries } from "../shared/day-line-chart";
import { IDLE_W, NodeDetailContentBase } from "./node-detail-base";
import { readEnergyKWh } from "./node-detail-readings";
import { powerUnitFactor } from "../shared/power-reading";
import { dayKey } from "./node-detail-schedule";
import { nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";
import type { SolarDetailParams } from "./node-detail-types";
import "../helman-simple/simple-card-solar";
import "./detail-headline";
import "./flow-gauge";
import { boldTemplate } from "./detail-section";
import { renderForecastChart } from "./node-detail-forecast";
import { historyRow, kwhText, renderShowMore, sectionNotReady, subTitle } from "./node-detail-history";
import { modeStripWindow } from "../shared/mode-strip";

/** How many calendar days the outlook shows, today first. */
const OUTLOOK_DAYS = 7;

/** One colour per string; every chart and row also names the string in text. */
const STRING_COLORS: Record<string, string> = { "1": "#fb8c00", "2": "#3949ab" };

/** A forecast slot: its start and its energy, Wh. */
interface Slot {
    start: number;
    wh: number;
}

/** The forecast as the answers read it, for the slot in progress. */
interface ForecastModel {
    /** Today's elapsed slots that have a measured value, against the forecast for the same slots. */
    comparison: { startMs: number; endMs: number; actualKwh: number; forecastKwh: number } | null;
    /** Forecast energy from now to the end of today, the slot in progress by its remaining part. */
    remainingKwh: number;
    /** When today's forecast production next ends, if it does. */
    endsAt: number | null;
    /** Today and the next days: their forecast total, `null` for a day without one. */
    days: Array<{ key: string; firstMs: number | null; kwh: number | null }>;
    /** Whether the totals are the bias-corrected forecast. */
    corrected: boolean;
    /** Today's raw forecast total, before the bias correction, kWh. */
    rawTodayKwh: number;
    /** The slot boundaries of today that are still ahead. */
    boundaries: number[];
    /** Today's forecast slots, as the curve draws them. */
    todaySlots: Slot[];
}

/**
 * The solar detail.
 *
 * The Overview opens on the power headline (producing or not, and the share
 * of the inverter rating as caption), then the gauge of where the power goes
 * and, with two strings or more, each string's power now.
 *
 * Live readings come from `hass` and the live flow from the card; the backend
 * overview supplies the entity ids, the string mapping and the configured
 * capacity. The forecast is read on opening, for the Forecast header; today's
 * production once Forecast is open; where today's energy went and the
 * strings' day once History & statistics is open. Nothing here is a
 * diagnosis: a cap is a setting rather than lost energy, and unequal strings
 * are not a fault.
 */
@customElement("node-detail-solar-content")
export class NodeDetailSolarContent extends NodeDetailContentBase<SolarDetailPayload> {
    static styles = [helmanColorVars, nodeDetailSharedStyles, nodeDetailQuestionStyles, css`
        .curve-head {
            display: flex;
            justify-content: space-between;
            flex-wrap: wrap;
            gap: 4px 12px;
        }
        .legend {
            display: flex;
            gap: 10px;
            font-size: 0.72rem;
            color: var(--secondary-text-color);
        }
        .legend-swatch {
            display: inline-block;
            width: 12px;
            height: 0;
            margin-right: 4px;
            vertical-align: middle;
            border-top: 3px solid;
        }
        .legend-swatch.forecast {
            border-top: 2px dashed;
        }
        .plot {
            display: block;
            position: relative;
            height: 110px;
            margin-top: 4px;
        }
        .plot svg {
            display: block;
            width: 100%;
            height: 100%;
            overflow: visible;
        }
        .plot .baseline {
            stroke: var(--divider-color, rgba(0, 0, 0, 0.12));
        }
        .plot .rating {
            stroke: var(--secondary-text-color, #727272);
            stroke-dasharray: 4 3;
        }
        .rating-label {
            position: absolute;
            right: 0;
            margin-top: 2px;
            font-size: 0.7rem;
            color: var(--secondary-text-color, #727272);
            white-space: nowrap;
        }
        .hours {
            display: block;
            position: relative;
            height: 1.1em;
            font-size: 0.7rem;
            color: var(--secondary-text-color);
        }
        .hours span {
            position: absolute;
            transform: translateX(-50%);
        }
        .curve-caption {
            display: block;
            margin-top: 2px;
            font-size: 0.82rem;
            color: var(--secondary-text-color);
        }
        .strip {
            display: flex;
            align-items: flex-end;
            gap: 3px;
            height: 26px;
            margin-top: 4px;
        }
        .strip-day {
            flex: 1 1 0;
            min-height: 2px;
            border-radius: 2px 2px 0 0;
            background: color-mix(in srgb, var(--helman-solar) 45%, transparent);
        }
        .strip-day.tomorrow {
            background: var(--helman-solar);
        }
        .strip-day.none {
            height: 0;
            min-height: 0;
            border-bottom: 2px dashed var(--divider-color, rgba(0, 0, 0, 0.2));
        }
        .swatch {
            display: inline-block;
            width: 10px;
            height: 10px;
            margin-right: 6px;
            vertical-align: baseline;
            border-radius: 2px;
        }
        .split {
            display: flex;
            height: 12px;
            border-radius: 6px;
            overflow: hidden;
            background: var(--secondary-background-color, rgba(0, 0, 0, 0.06));
        }
        .split > span {
            height: 100%;
        }
        .days {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
            gap: 6px;
        }
        .day {
            display: flex;
            flex-direction: column;
            gap: 2px;
            padding: 6px;
            border-radius: 6px;
            background: var(--secondary-background-color, rgba(0, 0, 0, 0.04));
            font-size: 0.82rem;
            min-width: 0;
        }
        .day-label {
            color: var(--secondary-text-color);
        }
        .day-value {
            font-weight: 600;
            overflow-wrap: anywhere;
        }
        .muted {
            color: var(--secondary-text-color);
        }
        .day-row .label {
            flex: 0 0 3em;
        }
        .day-bar {
            flex: 1;
            height: 10px;
            border-radius: 3px;
            background: var(--secondary-background-color);
            overflow: hidden;
        }
        .day-bar > span {
            display: block;
            height: 100%;
            background: var(--helman-solar);
        }
    `];

    protected readonly _node = "solar" as const;

    @property({ attribute: false }) public params!: SolarDetailParams;

    /** Today's production, for the Forecast chart, while the section is open and the overview offers it. */
    private readonly _production = this._section<SolarProductionSectionPayload>("production", {
        fetch: () => this._readSection("production"),
        shown: () => this._offers("production") && this._forecastOpen,
    });
    /** The total and the strings' power over the last 24 hours, for the History chart, once History & statistics is open. */
    private readonly _power = this._section<SolarPowerSectionPayload>("power", {
        fetch: () => this._readSection("power"),
        shown: () => this._historyOpen && this._offers("power"),
        rolling: true,
    });
    /** Where today's solar went, once History & statistics is open. */
    private readonly _destinations = this._section<SolarDestinationsSectionPayload>("destinations", {
        fetch: () => this._readSection("destinations"),
        shown: () => this._historyOpen && this._offers("destinations"),
    });

    private _modelCache?: { forecast: unknown; slot: number; model: ForecastModel | null };
    private _powerChart?: { payload: SolarPowerSectionPayload; series: DayLineSeries[] };

    protected _start(): void {
        super._start();
        // The overview compares today's production with the forecast.
        void this._loadForecast();
    }

    /** The comparison and the rest of today's forecast move at each forecast slot boundary. */
    protected *_clockBoundaries(): Iterable<number> {
        yield* this._model()?.boundaries ?? [];
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    protected _renderOverview(overview: SolarDetailPayload) {
        const power = this._powerNow();
        const rated = this._ratedW(overview);
        const flows = this.params.flows;
        const producing = power !== null && power > IDLE_W;
        const caption = [this.localize(producing ? "node_detail.shared.solar_producing" : "node_detail.shared.solar_idle")];
        if (producing && rated !== null && rated > 0) caption.push(fillTemplate(this.localize("node_detail.shared.solar_rating"), {
            pct: Math.round(power / rated * 100), rating: formatPower(rated).display,
        }));
        return html`
            <div class="content" data-overview>
                ${this._renderException(overview)}
                <helman-detail-headline .value=${power === null ? "—" : formatPower(power).display}
                    .entityId=${overview.entities.power ?? null} .caption=${caption}>
                    <simple-card-solar slot="icon" .compact=${true} .power=${power ?? 0}></simple-card-solar>
                </helman-detail-headline>
                <helman-flow-gauge direction="to" .localize=${this.localize}
                    .items=${flows && producing ? [
                        { node: "house", powerW: flows.solarToHouse },
                        { node: "battery", powerW: flows.solarToBattery },
                        { node: "grid", powerW: flows.solarToGrid },
                    ] : []}></helman-flow-gauge>
                ${overview.strings.length >= 2 ? html`<div class="section-title">${this.localize("node_detail.shared.strings_now")}</div>
                    <div class="tile">${overview.strings.map((string) => {
                        const watts = this._watts(overview, `pv_power_${string}`);
                        return html`<div class="row" data-string=${string}><span>${fillTemplate(this._t("strings.string"), { n: String(string) })}</span>
                            <span>${watts === null ? "—" : formatPower(watts).display}</span></div>`;
                    })}</div>` : nothing}
            </div>
        `;
    }

    // Forecast ----------------------------------------------------------------

    /**
     * What is still to come today and tomorrow: today's production against
     * the forecast, its key moments, and the next days' totals.
     */
    protected _renderForecast(overview: SolarDetailPayload) {
        const pending = this._forecastPending();
        if (pending !== null) return pending;
        const model = this._model();
        if (!model) return nothing;
        const tomorrow = model.days[1]?.kwh ?? null;
        const values = { kwh: `≈ ${formatKwh(model.remainingKwh)} kWh`, tomorrow: tomorrow === null ? "?" : `${formatKwh(tomorrow)} kWh` };
        const template = this.localize(`node_detail.shared.forecast.${tomorrow === null ? "solar_summary_today" : "solar_summary"}`);
        return this._forecastSection(boldTemplate(template, values), () => this._renderForecastBody(overview, model));
    }

    private _renderForecastBody(overview: SolarDetailPayload, model: ForecastModel) {
        const context = this._chartContext;
        const forecast = (key: string) => this.localize(`node_detail.shared.forecast.${key}`);
        const end = modeStripWindow(context.now, context.timeZone).end;
        const slotW = (wh: number) => Math.max(0, wh) / (SLOT_MS / 3_600_000);
        const planned = getEffectiveSolarForecastPoints(this._forecast!.solar)
            .map((point) => ({ t: Date.parse(point.timestamp) + SLOT_MS / 2, v: slotW(point.value) / 1000 }))
            .filter((point) => point.t <= end);
        const actual = (this._production.payload?.power?.points ?? []).map((point) => ({ t: Date.parse(point.start), v: Math.max(0, point.mean) / 1000 }));
        const rated = this._ratedW(overview);
        const peak = model.todaySlots.reduce<{ start: number; wh: number } | null>((best, slot) => !best || slot.wh > best.wh ? slot : best, null);
        const soFar = readEnergyKWh(this.hass, overview.entities.today_energy);
        const comparison = model.comparison;
        const days = model.days.slice(1).filter((day) => day.kwh !== null);
        const most = Math.max(0, ...days.map((day) => day.kwh!));
        const bias = this._forecast!.solar.biasCorrection;
        const row = (key: string, label: unknown, value: unknown) => html`<div class="row" data-row=${key}><span class="label">${label}</span><span class="value">${value}</span></div>`;
        return html`
            ${renderForecastChart(context, {
                title: forecast("solar_chart"),
                help: model.corrected && bias ? fillTemplate(forecast("solar_help"), { n: bias.explainability.usableDays }) : forecast("solar_help_raw"),
                series: [
                    { key: "actual", label: forecast("actual"), color: "var(--helman-solar)", points: actual, bucketMs: (this._production.payload?.power?.bucketMinutes ?? 5) * 60_000 },
                    { key: "forecast", label: forecast("forecast"), color: "var(--helman-solar)", points: planned, dashed: true },
                ],
                entities: overview.entities.power ? [overview.entities.power] : [],
                references: rated !== null ? [{ value: rated / 1000, label: fillTemplate(this._t("limits.rating_short"), { power: formatPower(rated).display }) }] : [],
                markers: peak && peak.wh > 0 ? [{ t: peak.start + SLOT_MS / 2, v: slotW(peak.wh) / 1000, color: "var(--helman-solar)" }] : [],
                formatValue: (value) => formatPower(value * 1000).display,
            })}
            <div class="rows">
                ${soFar !== null ? row("total", forecast("solar_total"), html`≈ ${formatKwh(soFar + model.remainingKwh)} kWh <span class="label">${fillTemplate(forecast("solar_total_parts"), {
                    so_far: formatKwh(soFar), to_come: formatKwh(model.remainingKwh) })}</span>`) : nothing}
                ${peak && peak.wh > 0 ? row("peak", html`<span style="color: var(--helman-solar)">●</span> ${forecast("solar_peak")}`, html`${fillTemplate(forecast("at"), {
                    value: formatPower(slotW(peak.wh)).display, time: this._time(peak.start) })}${peak.start + SLOT_MS <= context.now ? html` <span class="label">${forecast("solar_passed")}</span>` : nothing}`) : nothing}
                ${model.endsAt !== null ? row("ends", forecast("solar_ends"), `≈ ${this._time(model.endsAt)}`) : nothing}
                ${comparison && comparison.forecastKwh > 0 ? row("versus", forecast("solar_versus"), fillTemplate(forecast(comparison.actualKwh >= comparison.forecastKwh ? "above" : "below"), {
                    pct: Math.round(Math.abs(comparison.actualKwh / comparison.forecastKwh - 1) * 100) })) : nothing}
            </div>
            ${days.length ? html`
                <div class="section-title">${forecast("solar_days")}</div>
                <div class="rows" data-days>${days.map((day) => html`
                    <div class="row day-row" data-day=${day.key}><span class="label">${this._weekday(day.key, day.firstMs)}</span>
                        <span class="day-bar"><span style="width: ${most > 0 ? (day.kwh! / most * 100).toFixed(1) : 0}%"></span></span>
                        <span class="value">${formatKwh(day.kwh!)} kWh</span></div>`)}
                </div>` : nothing}
        `;
    }

    /** A day of the outlook by its weekday. */
    private _weekday(key: string, firstMs: number | null): string {
        return firstMs !== null
            ? new Intl.DateTimeFormat(this._locale, { weekday: "short", timeZone: this._timeZone }).format(firstMs)
            : new Intl.DateTimeFormat(this._locale, { weekday: "short", timeZone: "UTC" }).format(Date.parse(`${key}T12:00:00Z`));
    }

    // History & statistics -----------------------------------------------------

    /** Today's production by the solar meter, where it went, the last 24 hours' power and the lifetime total. */
    protected _renderHistory(overview: SolarDetailPayload) {
        const today = readEnergyKWh(this.hass, overview.entities.today_energy);
        const summary = today === null ? this._h("no_figures") : boldTemplate(this._h("solar_summary"), { kwh: kwhText(today) });
        const lifetime = readEnergyKWh(this.hass, overview.entities.lifetime_energy);
        return this._historySection(summary, () => html`
            ${this._model() ? this._forecastPointer() : nothing}
            ${subTitle(this._h("solar_went"))}
            ${this._renderDestinations()}
            ${overview.sections.includes("power") ? html`
                ${subTitle(this._h("last_24h"))}
                ${this._renderPower(overview)}
            ` : nothing}
            ${lifetime !== null ? html`<div class="rows">${historyRow(this._h("lifetime"), `${(lifetime / 1000).toFixed(1)} MWh`, "lifetime")}</div>` : nothing}
        `);
    }

    /** Used in the house, stored in the battery and sold to the grid, each marked in its node's colour, and what is not resolved. */
    private _renderDestinations() {
        const notReady = sectionNotReady(this._destinations, this.localize);
        if (notReady) return notReady;
        const payload = this._destinations.payload!;
        const destinations = payload.destinations;
        if (!destinations) return html`<p class="note" data-destinations-unavailable>${this._h("solar_went_unavailable")}</p>`;
        const row = (node: string, key: string, value: string) => historyRow(html`<span class="swatch-mark" style=${`color: var(--helman-${node})`}>■</span>${this._h(key)}`, value, key);
        const sold = destinations.exportMoney === null || !payload.priceUnit ? kwhText(destinations.exportKwh)
            : fillTemplate(this._h("kwh_sold"), { kwh: kwhText(destinations.exportKwh), money: this._formatMoney(destinations.exportMoney, currencyFromPriceUnit(payload.priceUnit)) });
        return html`<div class="rows" data-destinations>
            ${row("house", "used_house", kwhText(destinations.houseKwh))}
            ${row("battery", "stored_battery", kwhText(destinations.batteryKwh))}
            ${row("grid", "sold_grid", sold)}
            ${destinations.unresolvedKwh > 0 ? row("neutral-light", "not_resolved", kwhText(destinations.unresolvedKwh)) : nothing}
        </div>`;
    }

    /** The total solar power over the last 24 hours, with each string's beside it from two strings or without a total. */
    private _renderPower(overview: SolarDetailPayload) {
        const notReady = sectionNotReady(this._power, this.localize);
        if (notReady) return notReady;
        const payload = this._power.payload!;
        const chart = this._powerChartFor(payload);
        const entities = [overview.entities.power, ...overview.strings.map((string) => overview.entities[`pv_power_${string}`])]
            .filter((id): id is string => !!id);
        if (!chart.series.length) return html`<p class="note">${this._h("no_figures")}</p>${renderShowMore(entities, this.localize)}`;
        return html`
            <helman-day-line-chart
                data-power-chart
                .series=${chart.series}
                .start=${Date.parse(payload.period.start)}
                .end=${Date.parse(payload.period.end)}
                .bucketMs=${300_000}
                .now=${Date.parse(payload.period.end)}
                .nowLabel=${this.localize("node_detail.shared.now")}
                .timeZone=${this._timeZone}
                .locale=${this._locale}
                .formatValue=${this._formatWatts}
            ></helman-day-line-chart>
            ${renderShowMore(entities, this.localize)}
        `;
    }

    // Technical details ---------------------------------------------------------

    /** Today's raw forecast against the bias-corrected one, the correction factor and the bias training. */
    protected _renderTechnical(_overview: SolarDetailPayload) {
        const solar = this._forecast?.solar;
        const corrected = this._model()?.days[0]?.kwh ?? null;
        const raw = this._model()?.rawTodayKwh ?? null;
        const bias = solar?.biasCorrection;
        const t = (key: string) => this.localize(`node_detail.shared.technical.${key}`);
        return html`<div class="rows">
            ${this._row(t("solar_raw"), raw === null ? "—" : kwhText(raw), "raw")}
            ${this._row(t("solar_corrected"), corrected === null || !solar?.adjustedPoints ? "—" : kwhText(corrected), "corrected")}
            ${this._row(t("solar_factor"), raw && corrected !== null && solar?.adjustedPoints ? `× ${(corrected / raw).toFixed(2)}` : "—", "correction")}
            ${this._row(t("bias_status"), bias ? t(bias.effectiveVariant === "adjusted" ? "bias_applied" : "bias_not_applied") : "—", "bias-status")}
            ${this._row(t("bias_days"), bias ? String(bias.explainability.usableDays) : "—", "bias-days")}
        </div>`;
    }

    /** An off-grid or fault run mode the inverter reports. */
    private _renderException(overview: SolarDetailPayload) {
        return overview.condition ? this._exceptionBanner(fillTemplate(this._t(`exception.${overview.condition.kind}`), { state: overview.condition.runMode })) : nothing;
    }

    // Limits ------------------------------------------------------------------

    /** The inverter's AC rating, W; `null` without a valid reading. */
    private _ratedW(overview: SolarDetailPayload): number | null {
        const watts = this._watts(overview, "rated_power");
        return watts !== null && watts > 0 ? watts : null;
    }

    // Power -------------------------------------------------------------------

    /**
     * The chart's inputs, kept while the payload is the same one: the total as
     * the main line, and each string's own line once there are two, or
     * whenever there is no total line to draw.
     */
    private _powerChartFor(payload: SolarPowerSectionPayload): { series: DayLineSeries[] } {
        if (this._powerChart?.payload !== payload) {
            const line = (key: string, label: string, color: string, day: DayStatsDTO | null | undefined): DayLineSeries[] => day?.points.length ? [{
                key, label, color,
                points: day.points.map((point) => ({ t: Date.parse(point.start), v: point.mean, min: point.min, max: point.max })),
            }] : [];
            const strings = Object.entries(payload.strings).filter(([, entry]) => entry !== null);
            const total = line("total", this._h("total"), "var(--helman-solar)", payload.power);
            const series = [
                ...total,
                ...(strings.length >= 2 || !total.length ? strings.flatMap(([string, entry]) =>
                    line("pv" + string, fillTemplate(this._t("strings.string"), { n: string }), STRING_COLORS[string] ?? NEUTRAL_LIGHT_COLOR, entry!.day)) : []),
            ];
            this._powerChart = { payload, series };
        }
        return this._powerChart;
    }

    // ── The forecast ────────────────────────────────────────────────────────

    /** The forecast model for the slot in progress, rebuilt only when either changes. */
    private _model(): ForecastModel | null {
        const solar = this._forecast?.solar;
        const now = Date.now();
        const slot = Math.floor(now / SLOT_MS);
        const cache = this._modelCache;
        if (cache && cache.forecast === solar && cache.slot === slot) return cache.model;
        // Only a forecast with data builds a model: a startup or history-short
        // payload has no points, which would read as zero production ahead.
        const model = solar && (solar.status === "available" || solar.status === "partial") ? this._buildModel(now) : null;
        this._modelCache = { forecast: solar, slot, model };
        return model;
    }

    private _buildModel(now: number): ForecastModel {
        const solar = this._forecast!.solar;
        const timeZone = this._timeZone;
        const toSlots = (points: Array<{ timestamp: string; value: number }>): Slot[] =>
            points.map((point) => ({ start: Date.parse(point.timestamp), wh: point.value })).filter((slot) => Number.isFinite(slot.start) && Number.isFinite(slot.wh));
        const effective = toSlots(getEffectiveSolarForecastPoints(solar));
        const corrected = !!solar.adjustedPoints;
        const today = dayKey(now, timeZone);
        const isToday = (ms: number) => dayKey(ms, timeZone) === today;

        // Only the elapsed slots with a measured value, against the forecast for
        // exactly those slots: the in-progress slot and a gap are left out of both.
        const forecastAt = new Map(effective.map((slot) => [slot.start, slot.wh]));
        let comparison: ForecastModel["comparison"] = null;
        for (const actual of toSlots(solar.actualHistory)) {
            const forecast = forecastAt.get(actual.start);
            if (forecast === undefined || !isToday(actual.start) || actual.start + SLOT_MS > now) continue;
            if (comparison === null) comparison = { startMs: actual.start, endMs: actual.start + SLOT_MS, actualKwh: 0, forecastKwh: 0 };
            comparison.startMs = Math.min(comparison.startMs, actual.start);
            comparison.endMs = Math.max(comparison.endMs, actual.start + SLOT_MS);
            comparison.actualKwh += Math.max(0, actual.wh) / 1000;
            comparison.forecastKwh += Math.max(0, forecast) / 1000;
        }

        let remainingKwh = 0;
        let endsAt: number | null = null;
        const boundaries: number[] = [];
        const todaySlots: Slot[] = [];
        let producingBefore = false;
        const byDay = new Map<string, { firstMs: number; kwh: number }>();
        for (const slot of effective) {
            const key = dayKey(slot.start, timeZone);
            if (key === null) continue;
            const day = byDay.get(key) ?? { firstMs: slot.start, kwh: 0 };
            day.kwh += Math.max(0, slot.wh) / 1000;
            byDay.set(key, day);
            if (key !== today) continue;
            todaySlots.push(slot);
            const end = slot.start + SLOT_MS;
            const producing = slot.wh / (SLOT_MS / 3_600_000) > IDLE_W;
            if (end > now) {
                boundaries.push(end);
                remainingKwh += Math.max(0, slot.wh) / 1000 * Math.min(1, (end - Math.max(slot.start, now)) / SLOT_MS);
                // The first slot ahead where forecast production stops.
                if (slot.start >= now && !producing && producingBefore && endsAt === null) endsAt = slot.start;
            }
            producingBefore = producing;
        }
        // Production that runs to the last slot of the day ends there.
        if (endsAt === null && producingBefore && boundaries.length) endsAt = boundaries[boundaries.length - 1];

        const days: ForecastModel["days"] = [];
        for (let offset = 0; today !== null && offset < OUTLOOK_DAYS; offset += 1) {
            const key = addDaysToDayKey(today, offset);
            const day = byDay.get(key);
            days.push({ key, firstMs: day?.firstMs ?? null, kwh: day ? day.kwh : null });
        }
        const todayKwh = (slots: Slot[]) => slots.reduce((sum, slot) => isToday(slot.start) ? sum + Math.max(0, slot.wh) / 1000 : sum, 0);
        const rawTodayKwh = corrected ? todayKwh(toSlots(solar.points)) : byDay.get(today ?? "")?.kwh ?? 0;
        return { comparison, remainingKwh, endsAt, days, corrected, rawTodayKwh, boundaries, todaySlots };
    }

    // ── Readings and formatting ─────────────────────────────────────────────

    /** The card passes its live solar reading in W, or null when unreadable. */
    private _powerNow(): number | null {
        return this.params.power;
    }

    private _watts(overview: SolarDetailPayload, key: string): number | null {
        const value = this._number(overview, key);
        const factor = powerUnitFactor(this.hass, overview.entities[key]);
        return value === null || factor === null || value < 0 ? null : value * factor;
    }

    private readonly _formatWatts = (value: number): string => formatPower(Math.max(0, value)).display;
}

declare global {
    interface HTMLElementTagNameMap {
        "node-detail-solar-content": NodeDetailSolarContent;
    }
}
