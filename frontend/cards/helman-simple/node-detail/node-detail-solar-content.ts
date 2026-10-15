import { css, html, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { fillTemplate } from "../../localize/localize";
import {
    getEffectiveSolarForecastPoints,
    type SchedulePayload,
    type SolarDestinationsSectionPayload,
    type SolarDetailPayload,
    type SolarProductionSectionPayload,
    type SolarStringsSectionPayload,
} from "../../helman-api";
import type { HelmanSolarInspectorCardConfig } from "../../helman-solar-inspector/HelmanSolarInspectorCardConfig";
import { currencyFromPriceUnit } from "../../helman-solar-inspector/money-model";
import { BATT_COLOR, GRID_EXPORT_COLOR, HOUSE_COLOR, NEUTRAL_LIGHT_COLOR } from "../../color-utils";
import { helmanColorVars } from "../../color-vars";
import { ACTUAL_FILL_OPACITY, CHART_COLORS } from "../../helman-solar-inspector/chart-colors";
import { getScheduleLocalTimeParts } from "../../shared/schedule/model/schedule-time";
import { renderNowMarker } from "../../helman-solar-inspector/now-marker";
import { panelGlyph } from "../../shared/node-glyphs";
import { scheduleActionToneStyles } from "../../shared/schedule/action-tones";
import { getSharedHelmanStore } from "../../helman/store";
import { formatPower } from "../../power-format";
import { formatGridEnergy, formatPriceValue } from "../../shared/forecast-value-format";
import { addDaysToDayKey } from "../../shared/schedule/model/schedule-time";
import { getSharedScheduleOwner } from "../../shared/schedule/schedule-owner";
import "../../shared/day-line-chart";
import type { DayLineSeries } from "../../shared/day-line-chart";
import type { FlowItem } from "../../shared/node-flow";
import { IDLE_W, NodeDetailContentBase, TODAY_REFRESH_MS, type NodeFlow, type SectionState } from "./node-detail-base";
import { readEnergyKWh } from "./node-detail-readings";
import { WATTS } from "../../shared/power-reading";
import {
    currentRun,
    currentRuntime,
    dayKey,
    renderCurrentSlot,
    runtimeText,
    scheduleRuns,
    type ScheduleRun,
} from "./node-detail-schedule";
import { nodeDetailPictureStyles, nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";
import type { SolarDetailParams } from "./node-detail-types";

type QuestionId = "production" | "destinations" | "limits" | "strings" | "outlook";
type SectionName = "production" | "strings" | "destinations";
type SectionPayload = SolarProductionSectionPayload | SolarStringsSectionPayload | SolarDestinationsSectionPayload;

/** The history sections, in the order they are requested. */
const SECTIONS: SectionName[] = ["production", "strings", "destinations"];

/** The forecast's canonical slot. */
const SLOT_MS = 15 * 60_000;

/** How many calendar days the outlook shows, today first. */
const OUTLOOK_DAYS = 7;

/** One colour per string; every chart and row also names the string in text. */
const STRING_COLORS: Record<string, string> = { "1": "#fb8c00", "2": "#3949ab" };

/**
 * The inspector under "Is today's production meeting expectations?": today's
 * measured production against the corrected forecast, nothing else. The raw
 * forecast and the bias diagnostics are evidence, behind the second disclosure.
 */
export const SOLAR_FORECAST_INSPECTOR_CONFIG: HelmanSolarInspectorCardConfig = {
    type: "custom:helman-solar-inspector-card",
    transparent_background: true,
    hide_schedule_strip: true,
    hide_price_strip: true,
    hide_money_strip: true,
    hide_aggregate_views: true,
    show_bias_ratio: false,
    chart_series: ["actual", "corrected"],
};

/** The same day with the raw forecast and the bias correction revealed: the evidence. */
export const SOLAR_BIAS_INSPECTOR_CONFIG: HelmanSolarInspectorCardConfig = {
    ...SOLAR_FORECAST_INSPECTOR_CONFIG,
    show_bias_ratio: true,
    chart_series: ["actual", "corrected", "raw"],
};

/** A forecast slot: its start and its energy, Wh. */
interface Slot {
    start: number;
    wh: number;
}

/** The forecast as the answers read it, for the slot in progress. */
interface ForecastModel {
    /** Today's elapsed slots that have a measured value, against the forecast for the same slots. */
    comparison: { startMs: number; endMs: number; actualKwh: number; forecastKwh: number; rawKwh: number | null } | null;
    /** Forecast energy from now to the end of today, the slot in progress by its remaining part. */
    remainingKwh: number;
    /** The slot in progress, as an average power, W; `null` without one. */
    slotW: number | null;
    /** When today's forecast production next starts or ends, if it does. */
    startsAt: number | null;
    endsAt: number | null;
    /** Today and the next days: their forecast total, `null` for a day without one. */
    days: Array<{ key: string; firstMs: number | null; kwh: number | null }>;
    /** Whether the totals are the bias-corrected forecast. */
    corrected: boolean;
    /** The slot boundaries of today that are still ahead. */
    boundaries: number[];
    /** Today's forecast slots, as the curve draws them. */
    todaySlots: Slot[];
}

/**
 * The solar detail: whether today's production meets the forecast, where it
 * went, whether anything limits it, how the strings contribute and what to
 * expect.
 *
 * It opens on a status pill, today's production curve against the forecast
 * and the solar Now/Today flow from the strings around the panel. The
 * pictures absorb three questions: the curve opens the production, the flow
 * the destinations and the panel the strings. The other two are tiles; one
 * answer is open at a time, full width under the tiles.
 *
 * Live readings come from `hass` and the live flow from the card; the backend
 * overview supplies the entity ids, the string mapping and the configured
 * capacity. The forecast and today's production are read on opening, for the
 * curve; today's flows once Today is chosen, with the strings' energy; the
 * string history and the destinations while their answer is open, and the
 * inspector embeds are mounted only behind their answers. Nothing here is a
 * diagnosis: power above the AC rating is not measured clipping, a cap is a
 * setting rather than lost energy, and unequal strings are not a fault.
 */
@customElement("node-detail-solar-content")
export class NodeDetailSolarContent extends NodeDetailContentBase<SolarDetailPayload, QuestionId> {
    static styles = [helmanColorVars, nodeDetailSharedStyles, nodeDetailQuestionStyles, nodeDetailPictureStyles, scheduleActionToneStyles, css`
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
    `];

    protected readonly _node = "solar" as const;

    @property({ attribute: false }) public params!: SolarDetailParams;

    @state() private _schedule: SchedulePayload | null = null;
    /** The history sections shown, by name; one that is not shown is absent. */
    @state() private _sections: Partial<Record<SectionName, SectionState<SectionPayload>>> = {};

    private _unsubscribeSchedule?: () => void;
    private readonly _sectionRequests: Record<SectionName, number> = { production: 0, strings: 0, destinations: 0 };
    private readonly _sectionRequestedAt: Record<SectionName, number> = { production: 0, strings: 0, destinations: 0 };
    private _modelCache?: { forecast: unknown; slot: number; model: ForecastModel | null };
    private _stringsChart?: { payload: SolarStringsSectionPayload; series: DayLineSeries[] };

    willUpdate(changed: Map<string, unknown>): void {
        super.willUpdate(changed);
        if (this._started) this._syncSections();
    }

    /**
     * Request the sections shown and drop the rest. What is shown is "today so
     * far": re-read on a new day, and otherwise at most every few minutes,
     * only while the page is visible. A dropped section's request is obsolete;
     * it is read again when shown again.
     */
    private _syncSections(): void {
        for (const name of SECTIONS) {
            const section = this._sections[name];
            if (!this._sectionShown(name)) {
                if (section) {
                    this._sectionRequests[name] += 1;
                    const { [name]: _dropped, ...rest } = this._sections;
                    this._sections = rest;
                }
            } else if (!section) {
                void this._loadSection(name);
            } else if (section.status === "ready" && !document.hidden
                && (!this._isToday(section.payload.period.start) || Date.now() - this._sectionRequestedAt[name] > TODAY_REFRESH_MS)) {
                void this._loadSection(name);
            }
        }
    }

    protected _start(): void {
        this._unsubscribeSchedule = getSharedScheduleOwner(this.hass).subscribe((snapshot) => {
            this._schedule = snapshot.schedule;
        });
        super._start();
        // The overview compares today's production with the forecast.
        void this._loadForecast();
    }

    protected _stop(): void {
        this._unsubscribeSchedule?.();
        this._unsubscribeSchedule = undefined;
        for (const name of SECTIONS) this._sectionRequests[name] += 1;
        // A dropped load would otherwise stay "loading" after a reconnect.
        this._sections = Object.fromEntries(Object.entries(this._sections).filter(([, section]) => section?.status !== "loading"));
    }

    protected _onDataChanged(): void {
        // The base reloads the overview and the forecast; the schedule owner reloads itself.
        super._onDataChanged();
        for (const name of SECTIONS) if (this._sections[name]) void this._loadSection(name);
    }

    /** The run mode the overview's condition was computed from. */
    protected _overviewSignature(payload: SolarDetailPayload): string {
        const entityId = payload.entities.run_mode;
        return entityId ? this.hass.states[entityId]?.state ?? "" : "";
    }

    /**
     * The comparison, the slot in progress and the rest of today's forecast
     * move at each forecast slot boundary; the control intent at each plan run.
     */
    protected *_clockBoundaries(): Iterable<number> {
        yield* this._model()?.boundaries ?? [];
        for (const run of this._runs()) {
            yield run.startMs;
            if (run.endMs !== null) yield run.endMs;
        }
    }

    // ── Data ────────────────────────────────────────────────────────────────

    /**
     * Whether `name` is shown: today's production always, for the curve;
     * the strings while Today's flow or their answer shows them; the
     * destinations while their answer is open. Only a section the overview
     * offers is shown.
     */
    private _sectionShown(name: SectionName): boolean {
        if (this._overview.status !== "ready" || !this._overview.payload.sections.includes(name)) return false;
        if (name === "strings") return this._flowScope === "today" || this._open === "strings";
        if (name === "destinations") return this._open === "destinations";
        return true;
    }

    private async _loadSection(name: SectionName): Promise<void> {
        const request = ++this._sectionRequests[name];
        // A refresh keeps the figures on screen until the new ones land.
        const shown = this._sections[name];
        if (shown?.status !== "ready" || !this._isToday(shown.payload.period.start)) {
            this._sections = { ...this._sections, [name]: { status: "loading" } };
        }
        this._sectionRequestedAt[name] = Date.now();
        try {
            const payload = await getSharedHelmanStore(this.hass)
                .getNodeDetail<SectionPayload>({ node: "solar", section: name }, { fresh: true });
            if (request !== this._sectionRequests[name]) return;
            this._sections = { ...this._sections, [name]: { status: "ready", payload } };
        } catch (error) {
            if (request !== this._sectionRequests[name]) return;
            console.error(`node-detail-solar: failed to load the ${name} section`, error);
            if (this._sections[name]?.status !== "ready") this._sections = { ...this._sections, [name]: { status: "error" } };
        }
    }

    /** A section's payload, when it has landed. */
    private _ready<T extends SectionPayload>(name: T["section"]): T | null {
        const section = this._sections[name];
        return section?.status === "ready" ? section.payload as T : null;
    }

    // ── Disclosure ──────────────────────────────────────────────────────────

    protected _setOpen(id: QuestionId | null): void {
        super._setOpen(id);
        // The sections the answer reads follow in `willUpdate`. An opened forecast answer shows the forecast as it is now.
        if (id === "production" || id === "outlook") void this._loadForecast();
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    render() {
        const notReady = this._renderNotReady();
        if (notReady || this._overview.status !== "ready") return notReady;
        const overview = this._overview.payload;
        const model = this._model();
        return html`
            <div class="content">
                ${this._renderSummary(overview)}
                ${this._renderCurve(overview, model)}
                ${this._renderSolarFlow(overview)}
                <div class="tiles">
                    ${this._renderOutlookTile(model)}
                    ${this._renderLimitsTile(overview)}
                </div>
                ${this._renderOpen(overview, model)}
            </div>
        `;
    }

    /** The open question's answer and evidence, full width under the tiles. */
    private _renderOpen(overview: SolarDetailPayload, model: ForecastModel | null) {
        switch (this._open) {
            case "production":
                return this._question("production", this._productionPreview(model), () => this._renderProduction(overview, model), () => this._renderProductionEvidence(overview, model), "evidence");
            case "destinations":
                return this._question("destinations", this._destinationsPreview(overview), () => this._renderDestinations(), () => this._renderDestinationsEvidence(overview), "evidence");
            case "limits":
                return this._question("limits", this._limitsPreview(overview), () => this._renderLimits(overview), () => this._renderLimitsEvidence(overview), "technical");
            case "strings":
                return overview.strings.length >= 2
                    ? this._question("strings", this._stringsPreview(overview), () => this._renderStrings(overview), () => this._renderStringsEvidence(overview), "technical")
                    : nothing;
            case "outlook":
                return this._question("outlook", this._outlookPreview(model), () => this._renderOutlook(overview, model), () => this._renderOutlookEvidence(overview), "evidence");
            default:
                return nothing;
        }
    }

    private _renderSummary(overview: SolarDetailPayload) {
        const power = this._powerNow();
        const status = power === null
            ? this._t("status.unavailable")
            : power > IDLE_W
            ? fillTemplate(this._t("status.producing"), { power: formatPower(power).display })
            : this._t("status.not_producing");
        return html`
            <div class="summary" data-overview>
                <p class="status pill action-tone-neutral" data-tone="neutral">${status}</p>
                ${this._renderException(overview)}
            </div>
        `;
    }

    // Production curve --------------------------------------------------------

    /**
     * Today's measured production against the forecast, always visible, on
     * the inverter's AC rating (else the flows' scale, the solar maximum), widened
     * only to fit a higher reading, never clipped, and never called clipping.
     * The measured power is the `production` section's five-minute means, its
     * gaps kept as gaps; the forecast is the corrected forecast's slots. A tap
     * opens the production answer.
     */
    private _renderCurve(overview: SolarDetailPayload, model: ForecastModel | null) {
        const section = this._sections.production;
        const offered = overview.sections.includes("production");
        const payload = this._ready<SolarProductionSectionPayload>("production");
        const caption = [this._productionPreview(model), this._nextLine(model)].filter(Boolean).join(" · ");
        let status: unknown = nothing;
        if (!offered) status = html`<p class="note" data-curve-none>${this._t("curve.no_sensor")}</p>`;
        else if (!section || section.status === "loading") status = html`<p class="note" data-curve-loading>${this._t("loading_history")}</p>`;
        else if (section.status === "error") {
            status = html`
                <p class="note" data-curve-failed>${this._t("history_failed")}</p>
                <button class="link-button" @click=${() => this._loadSection("production")}>${this._t("retry")}</button>
            `;
        } else if (payload && payload.power === null) status = html`<p class="note" data-curve-unit>${this._t("curve.unit")}</p>`;
        return html`
            <button
                class="picture"
                data-production-curve
                title=${this._t("q.production")}
                aria-expanded=${this._open === "production" ? "true" : "false"}
                @click=${() => this._setOpen(this._open === "production" ? null : "production")}
            >
                <span class="curve-head">
                    <span class="picture-scope">${this._t("curve.title")}</span>
                    <span class="legend" aria-hidden="true">
                        <span><span class="legend-swatch" style="border-top-color: ${CHART_COLORS.actual}"></span>${this._t("curve.actual")}</span>
                        <span><span class="legend-swatch forecast" style="border-top-color: ${this._forecastColor(model)}"></span>${this._t(model?.corrected === false ? "curve.forecast_raw" : "curve.forecast")}</span>
                    </span>
                </span>
                ${payload ? this._renderPlot(overview, payload, model) : nothing}
                ${caption ? html`<span class="curve-caption" data-curve-caption>${caption}</span>` : nothing}
            </button>
            ${status}
        `;
    }

    /** The forecast's colour: the corrected forecast's, or the raw one's when no correction applies. */
    private _forecastColor(model: ForecastModel | null): string {
        return model?.corrected === false ? CHART_COLORS.raw : CHART_COLORS.corrected;
    }

    private _renderPlot(overview: SolarDetailPayload, payload: SolarProductionSectionPayload, model: ForecastModel | null) {
        const W = 300;
        const H = 100;
        const start = Date.parse(payload.period.start);
        const end = Date.parse(payload.period.end);
        const span = Math.max(1, end - start);
        const points = (payload.power?.points ?? []).map((point) => ({ t: Date.parse(point.start), w: Math.max(0, point.mean) }));
        const forecast = (model?.todaySlots ?? []).map((slot) => ({ t: slot.start + SLOT_MS / 2, w: Math.max(0, slot.wh) / (SLOT_MS / 3_600_000) }));
        const rated = this._ratedW(overview);
        const scale = rated ?? this.params.flowScaleW;
        const top = Math.max(scale, ...points.map((point) => point.w), ...forecast.map((point) => point.w));
        const x = (t: number) => (t - start) / span * W;
        const y = (w: number) => H - w / top * (H - 4);
        // Each run of buckets without a gap is one filled shape; a gap stays a gap.
        const bucketMs = (payload.power?.bucketMinutes ?? 5) * 60_000;
        const runs: Array<typeof points> = [];
        for (const point of points) {
            const run = runs[runs.length - 1];
            if (run && point.t - run[run.length - 1].t <= bucketMs * 1.5) run.push(point);
            else runs.push([point]);
        }
        const actual = runs.map((run) => {
            const line = run.map((point, index) => `${index ? "L" : "M"}${x(point.t).toFixed(1)},${y(point.w).toFixed(1)}`).join("");
            const last = run[run.length - 1];
            return `${line}L${x(last.t + bucketMs).toFixed(1)},${y(last.w).toFixed(1)}L${x(last.t + bucketMs).toFixed(1)},${H}L${x(run[0].t).toFixed(1)},${H}Z`;
        }).join("");
        const forecastPath = forecast.map((point, index) => `${index ? "L" : "M"}${x(point.t).toFixed(1)},${y(point.w).toFixed(1)}`).join("");
        const now = Date.now();
        // Only a rating or a configured maximum is named; the card's default scale is not a figure of the install.
        const ratingLabel = rated !== null
            ? fillTemplate(this._t("limits.rating_short"), { power: formatPower(scale).display })
            : overview.configuredMaxPowerW !== null
            ? fillTemplate(this._t("curve.maximum"), { power: formatPower(scale).display })
            : null;
        // Wall-clock hours in Home Assistant's zone: the day starts at its
        // midnight, so stepping whole hours lands on them, and a daylight-saving
        // day still puts 12 at noon.
        const hours: Array<{ hour: number; t: number }> = [];
        for (let t = start; t < end; t += 3_600_000) {
            const hour = getScheduleLocalTimeParts(t, this._timeZone)?.hour;
            if (hour === 6 || hour === 12 || hour === 18) hours.push({ hour, t });
        }
        return html`
            <span class="plot">
                <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
                    <line class="baseline" x1="0" x2=${W} y1=${H} y2=${H} vector-effect="non-scaling-stroke"></line>
                    <line class="rating" data-rating data-w=${scale} x1="0" x2=${W} y1=${y(scale)} y2=${y(scale)} vector-effect="non-scaling-stroke"></line>
                    ${actual ? svg`<path data-actual d=${actual} fill=${CHART_COLORS.actual} fill-opacity=${ACTUAL_FILL_OPACITY}
                        stroke=${CHART_COLORS.actual} stroke-width="1.5" vector-effect="non-scaling-stroke"></path>` : nothing}
                    ${forecastPath ? svg`<path data-forecast d=${forecastPath} fill="none" stroke=${this._forecastColor(model)}
                        stroke-width="2" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"></path>` : nothing}
                    ${now >= start && now < end ? svg`<g data-now>${renderNowMarker(x(now), 0, H, this._time(now))}</g>` : nothing}
                </svg>
                ${ratingLabel ? html`<span class="rating-label" style="top: ${(y(scale) / H * 100).toFixed(1)}%">${ratingLabel}</span>` : nothing}
            </span>
            <span class="hours" aria-hidden="true">
                ${hours.map(({ hour, t }) => html`<span style="left: ${(x(t) / W * 100).toFixed(2)}%">${String(hour).padStart(2, "0")}</span>`)}
            </span>
        `;
    }

    // Flow --------------------------------------------------------------------

    /**
     * The strings in, the house, the battery and the grid out, around the
     * panel, which lights while producing: live on Now, from the strings'
     * readings and the card's split; today's kWh on Today, from the strings
     * section and the `flows` section. A single string, or none the profile
     * maps, is one input. Unresolved solar is a footnote, never a ribbon. The
     * flow opens the destinations, the panel the strings.
     */
    private _renderSolarFlow(overview: SolarDetailPayload) {
        const flow = this._flowScope === "now" ? this._nowFlow(overview) : this._todayFlow(overview);
        const power = this._powerNow();
        const glyph = panelGlyph(power !== null && power > IDLE_W);
        const centre = overview.strings.length >= 2
            ? html`
                <button
                    slot="centre"
                    class="glyph"
                    data-glyph
                    aria-label=${this._t("q.strings")}
                    aria-expanded=${this._open === "strings" ? "true" : "false"}
                    @click=${() => this._setOpen(this._open === "strings" ? null : "strings")}
                >${glyph}</button>
            `
            : html`<span slot="centre">${glyph}</span>`;
        return this._renderFlow(flow, this.params.flowScaleW, "destinations", centre);
    }

    /** One string's input, in the string's own colour. */
    private _stringItem(string: number, value: number | null, display: string): FlowItem {
        return {
            id: `string-${string}`,
            label: fillTemplate(this._t("strings.string"), { n: String(string) }),
            value,
            display,
            color: STRING_COLORS[String(string)] ?? NEUTRAL_LIGHT_COLOR,
        };
    }

    /** Live, W: each string's reading, or the solar reading as one input; unknown is "–", never 0. */
    private _nowFlow(overview: SolarDetailPayload): NodeFlow {
        const power = (value: number | null) => value === null ? "–" : formatPower(value).display;
        const watts = (value: number | null) => value === null ? null : Math.max(0, value);
        const production = watts(this._powerNow());
        const inputs = overview.strings.length >= 2
            ? overview.strings.map((string) => {
                const value = watts(this._watts(overview, `pv_power_${string}`));
                return this._stringItem(string, value, power(value));
            })
            : [this._flowItem("solar", production, power)];
        const flows = this.params.flows;
        const outputs = [
            this._flowItem("house", flows?.solarToHouse ?? null, power),
            this._flowItem("battery", flows?.solarToBattery ?? null, power),
            this._flowItem("grid", flows?.solarToGrid ?? null, power),
        ];
        return {
            scopeLabel: this._nowScopeLabel(),
            inputs,
            outputs,
            ...this._flowTotals(inputs, outputs, power),
            notes: [],
            centreValue: power(production),
            active: this._isActive(production),
        };
    }

    /**
     * Today, kWh: each string's estimated energy from the strings section, or
     * the day's production as one input; the destinations from the `flows`
     * section, with the solar left unresolved said in the footnote and in the
     * total, never drawn as a destination.
     */
    private _todayFlow(overview: SolarDetailPayload): NodeFlow {
        const flows = this._todayFlows?.status === "ready" ? this._todayFlows.payload.flows : null;
        const energy = (value: number | null) => value === null ? "–" : formatGridEnergy(value);
        const notes: string[] = [];
        const status = this._todayFlowsNote();
        if (status) notes.push(status);
        let inputs: FlowItem[];
        if (overview.strings.length >= 2) {
            const strings = this._ready<SolarStringsSectionPayload>("strings");
            const section = this._sections.strings;
            if (section?.status === "error") notes.push(this._t("flow.strings_failed"));
            inputs = overview.strings.map((string) => {
                const kwh = strings?.energy.strings[String(string)]?.kwh ?? null;
                // Integrated from five-minute means: an estimate, and said so.
                return this._stringItem(string, kwh, kwh === null ? "–" : "≈ " + formatGridEnergy(kwh));
            });
        } else {
            const edges = flows ? [flows.solarToHouse, flows.solarToBattery, flows.solarToGrid, flows.solarUnresolved] : [null];
            const produced = edges.some((edge) => edge === null) ? null : edges.reduce((sum, edge) => sum! + edge!, 0);
            inputs = [this._flowItem("solar", produced, energy)];
        }
        const outputs = [
            this._flowItem("house", flows?.solarToHouse ?? null, energy),
            this._flowItem("battery", flows?.solarToBattery ?? null, energy),
            this._flowItem("grid", flows?.solarToGrid ?? null, energy),
        ];
        const unresolved = flows?.solarUnresolved ?? 0;
        if (unresolved > 0) notes.push(fillTemplate(this._t("flow.unresolved"), { kwh: formatGridEnergy(unresolved) }));
        const { sumIn, sumOut, ...totals } = this._flowTotals(inputs, outputs, energy, 0, unresolved);
        return {
            scopeLabel: this._todayScopeLabel(),
            inputs,
            outputs,
            ...totals,
            notes,
            // Produced: every destination and the unresolved rest.
            centreValue: energy(sumOut),
            active: false,
        };
    }

    // Tiles -------------------------------------------------------------------

    /** Tomorrow's forecast, with the week's days as a strip. */
    private _renderOutlookTile(model: ForecastModel | null) {
        if (!model) {
            return this._tile("outlook", "–", this._forecastFailed ? this.localize("node_detail.forecast_failed") : this._forecastMissing());
        }
        const tomorrow = model.days[1];
        const most = Math.max(0, ...model.days.map((day) => day.kwh ?? 0));
        const graphic = html`
            <span class="strip" data-outlook-strip aria-hidden="true">
                ${model.days.map((day, index) => html`<span
                    class="strip-day ${index === 1 ? "tomorrow" : ""} ${day.kwh === null ? "none" : ""}"
                    data-strip-day=${day.key}
                    style=${day.kwh === null || most <= 0 ? "" : `height: ${Math.max(8, day.kwh / most * 100).toFixed(1)}%`}
                ></span>`)}
            </span>
        `;
        return this._tile("outlook", tomorrow?.kwh != null ? formatGridEnergy(tomorrow.kwh) : "–",
            tomorrow?.kwh != null ? this._t("tile.tomorrow") : this._t("outlook.no_tomorrow"), graphic);
    }

    /**
     * The inverter's AC rating, with the PV input now against it; without
     * one, the export cap. A meter against the rating is not a clipping claim.
     */
    private _renderLimitsTile(overview: SolarDetailPayload) {
        const rated = this._ratedW(overview);
        if (rated !== null) {
            const power = this._powerNow();
            const graphic = power !== null && power > IDLE_W ? html`
                <span class="meter" data-limits-meter style="--meter-accent: var(--helman-solar)">
                    <span class="meter-fill" style="width: ${Math.min(100, power / rated * 100).toFixed(1)}%"></span>
                </span>
            ` : nothing;
            return this._tile("limits", "≤ " + formatPower(rated).display, this._t("tile.rating"), graphic);
        }
        const exportLimit = this._watts(overview, "export_limit") ?? overview.maxAllowedExportPower;
        return exportLimit !== null
            ? this._tile("limits", "≤ " + formatPower(exportLimit).display, this._t("tile.export"))
            : this._tile("limits", "–", this._t("limits.none"));
    }

    /** When forecast production next starts or ends, today or tomorrow. */
    private _nextLine(model: ForecastModel | null): string | null {
        if (!model) return null;
        if (model.endsAt !== null && (model.startsAt === null || model.endsAt < model.startsAt)) {
            return fillTemplate(this._t("next.until"), { time: this._time(model.endsAt) });
        }
        if (model.startsAt !== null) return fillTemplate(this._t("next.from"), { time: this._time(model.startsAt) });
        const tomorrow = model.days[1];
        if (tomorrow?.kwh != null && tomorrow.kwh > 0) {
            return fillTemplate(this._t("next.tomorrow"), { kwh: formatGridEnergy(tomorrow.kwh) });
        }
        return this._t("next.none_today");
    }

    /** At most one: off-grid operation or a fault the inverter reports. */
    private _renderException(overview: SolarDetailPayload) {
        if (!overview.condition) return nothing;
        return html`
            <div class="exception" role="status" data-exception>
                <span>${fillTemplate(this._t(`exception.${overview.condition.kind}`), { state: overview.condition.runMode })}</span>
                <button class="link-button" @click=${() => this._setOpen("limits")}>${this._t("exception.details")}</button>
            </div>
        `;
    }

    // Production --------------------------------------------------------------

    private _productionPreview(model: ForecastModel | null): string | null {
        if (!model) return this._forecastFailed ? this.localize("node_detail.forecast_failed") : this._forecastMissing();
        const comparison = model.comparison;
        if (!comparison) return this._t("production.no_comparison");
        if (comparison.forecastKwh <= 0) {
            return fillTemplate(this._t("production.zero_forecast_short"), { time: this._time(comparison.endMs), actual: formatGridEnergy(comparison.actualKwh) });
        }
        return fillTemplate(this._t("production.share_short"), {
            share: this._share(comparison.actualKwh / comparison.forecastKwh),
            time: this._time(comparison.endMs),
        });
    }

    private _renderProduction(overview: SolarDetailPayload, model: ForecastModel | null) {
        const today = readEnergyKWh(this.hass, overview.entities.today_energy);
        const comparison = model?.comparison ?? null;
        const forecastLabel = this._t(model?.corrected === false ? "production.forecast_raw" : "production.forecast");
        return html`
            ${model ? html`
                ${comparison ? html`
                    ${this._row(this._t("production.period_label"), this._periodText(comparison.startMs, comparison.endMs), "period")}
                    ${this._row(this._t("production.actual"), formatGridEnergy(comparison.actualKwh), "actual")}
                    ${this._row(forecastLabel, formatGridEnergy(comparison.forecastKwh), "forecast")}
                    ${this._row(this._t("production.difference"), comparison.forecastKwh > 0
                        ? fillTemplate(this._t("production.difference_value"), {
                            share: this._share(comparison.actualKwh / comparison.forecastKwh),
                            kwh: this._signedKwh(comparison.actualKwh - comparison.forecastKwh),
                        })
                        : this._t("production.zero_forecast"), "difference")}
                ` : html`<p class="note" data-no-comparison>${this._t("production.no_comparison_long")}</p>`}
                ${this._row(this._t("production.now"), this._slotText(model), "now")}
                ${this._row(this._t("production.remaining"), formatGridEnergy(model.remainingKwh), "remaining", this._t("production.remaining_scope"))}
                ${this._row(this._t("production.projection"), today === null
                    ? this._t("unknown")
                    : formatGridEnergy(today + model.remainingKwh), "projection", this._t("production.projection_scope"))}
            ` : this._forecastFailed ? this._renderForecastFailed() : html`<p class="note">${this._forecastMissing()}</p>`}
            ${this._row(this._t("production.peak"), this._peakText(overview), "peak")}
            ${this._sections.production?.status === "error" ? html`<button class="link-button" @click=${() => this._loadSection("production")}>${this._t("retry")}</button>` : nothing}
            <p class="note">${this._t("production.explain")}</p>
            <div class="plan" data-forecast-inspector>${this._inspector("production", SOLAR_FORECAST_INSPECTOR_CONFIG)}</div>
        `;
    }

    /** This slot's production against its forecast, both as power: like with like. */
    private _slotText(model: ForecastModel): string {
        const power = this._powerNow();
        if (power === null) return this._t("unavailable");
        const now = formatPower(Math.max(0, power)).display;
        if (model.slotW === null || model.slotW <= 0) return fillTemplate(this._t("production.now_no_forecast"), { power: now });
        return fillTemplate(this._t("production.now_value"), {
            power: now,
            share: this._share(Math.max(0, power) / model.slotW),
            forecast: formatPower(model.slotW).display,
        });
    }

    private _peakText(overview: SolarDetailPayload): string {
        if (!overview.sections.includes("production")) return this._t("production.peak_no_sensor");
        const section = this._sections.production ?? null;
        if (section === null || section.status === "loading") return this._t("loading_history");
        if (section.status === "error") return this._t("history_failed");
        const power = this._ready<SolarProductionSectionPayload>("production")?.power;
        if (power === undefined) return this._t("loading_history");
        if (power === null) return this._t("production.peak_unit");
        if (power.max === null || power.maxAt === null || power.max <= 0) return this._t("production.peak_none");
        return fillTemplate(this._t("production.peak_value"), { power: formatPower(power.max).display, time: this._time(Date.parse(power.maxAt)) });
    }

    private _renderProductionEvidence(overview: SolarDetailPayload, model: ForecastModel | null) {
        const comparison = model?.comparison;
        const bias = this._forecast?.solar.biasCorrection;
        const power = this._ready<SolarProductionSectionPayload>("production")?.power;
        return html`
            ${comparison?.rawKwh != null ? html`
                ${this._row(this._t("production.raw"), formatGridEnergy(comparison.rawKwh), "raw")}
                ${comparison.rawKwh > 0 ? this._row(this._t("production.correction"), "× " + (comparison.forecastKwh / comparison.rawKwh).toFixed(2), "correction") : nothing}
            ` : nothing}
            ${bias ? html`
                ${this._row(this._t("production.bias_status"), this._t(bias.effectiveVariant === "adjusted" ? "production.bias_applied" : "production.bias_not_applied"), "bias-status")}
                ${this._row(this._t("production.bias_days"), String(bias.explainability.usableDays), "bias-days")}
                ${bias.explainability.trainedAt ? this._row(this._t("production.bias_trained"), this._dateTime(Date.parse(bias.explainability.trainedAt)), "bias-trained") : nothing}
            ` : nothing}
            ${power ? this._row(this._t("production.peak_source"), fillTemplate(this._t(power.extrema === "recorded" ? "production.peak_recorded" : "production.peak_bucket"), {
                coverage: this._share(power.coverage),
            }), "peak-source") : nothing}
            <p class="note">${this._t("production.evidence_note")}</p>
            ${overview.entities.power ? this._row(this._t("production.power_sensor"), this._name(overview.entities.power), "power-sensor") : nothing}
            <div class="plan" data-bias-inspector>${this._inspector("production-bias", SOLAR_BIAS_INSPECTOR_CONFIG)}</div>
        `;
    }

    // Destinations ------------------------------------------------------------

    private _destinationsPreview(overview: SolarDetailPayload): string | null {
        const destinations = this._ready<SolarDestinationsSectionPayload>("destinations")?.destinations;
        if (destinations) {
            if (destinations.producedKwh <= 0) return this._t("destinations.none_today");
            return fillTemplate(this._t("destinations.short"), {
                house: formatGridEnergy(destinations.houseKwh),
                battery: formatGridEnergy(destinations.batteryKwh),
                export: formatGridEnergy(destinations.exportKwh),
            });
        }
        // Before the answer opens: today's production from the solar meter.
        const today = readEnergyKWh(this.hass, overview.entities.today_energy);
        return today === null ? null : fillTemplate(this._t("destinations.produced_short"), { kwh: formatGridEnergy(today) });
    }

    private _renderDestinations() {
        const section = this._sections.destinations ?? null;
        if (section === null || section.status === "loading") {
            return html`<p class="note" data-destinations-loading>${this._t("destinations.loading")}</p>`;
        }
        if (section.status === "error") {
            return html`
                <p class="note">${this._t("destinations.failed")}</p>
                <button class="link-button" @click=${() => this._loadSection("destinations")}>${this._t("retry")}</button>
            `;
        }
        const payload = this._ready<SolarDestinationsSectionPayload>("destinations");
        if (!payload) return html`<p class="note">${this._t("destinations.loading")}</p>`;
        const period = this._row(this._t("destinations.period_label"), this._periodText(Date.parse(payload.period.start), Date.parse(payload.asOf)), "period");
        const destinations = payload.destinations;
        if (!destinations) {
            const reason = ["no_house_node", "no_house_meter", "no_solar_meter"].includes(payload.unavailable ?? "")
                ? `destinations.unavailable_${payload.unavailable}`
                : "destinations.unavailable_not_loaded";
            return html`${period}<p class="note" data-destinations-unavailable>${this._t(reason)}</p>`;
        }
        if (destinations.producedKwh <= 0) {
            return html`${period}<p class="note" data-no-production>${this._t("destinations.none_long")}</p>`;
        }
        const produced = destinations.producedKwh;
        const parts: Array<[string, number, string]> = [
            ["house", destinations.houseKwh, HOUSE_COLOR],
            ["battery", destinations.batteryKwh, BATT_COLOR],
            ["export", destinations.exportKwh, GRID_EXPORT_COLOR],
            ["unresolved", destinations.unresolvedKwh, NEUTRAL_LIGHT_COLOR],
        ];
        const share = (kwh: number) => fillTemplate(this._t("destinations.share"), { kwh: formatGridEnergy(kwh), share: this._share(kwh / produced) });
        return html`
            ${period}
            ${this._row(this._t("destinations.produced"), formatGridEnergy(produced), "produced")}
            <div class="split" aria-hidden="true">
                ${parts.filter(([, kwh]) => kwh > 0).map(([key, kwh, color]) => html`<span data-split=${key} style="width: ${Math.min(100, kwh / produced * 100)}%; background: ${color}"></span>`)}
            </div>
            ${parts.map(([key, kwh, color]) => key === "unresolved" && kwh <= 0 ? nothing : html`
                <div class="row" data-row=${key}>
                    <span class="label"><span class="swatch" style="background: ${color}"></span>${this._t(`destinations.${key}`)}${key === "export" ? html`<br><span class="note">${this._t("destinations.export_scope")}</span>` : nothing}</span>
                    <span class="value">${share(kwh)}</span>
                </div>
            `)}
            <p class="note">${this._t("destinations.explain")}</p>
        `;
    }

    private _renderDestinationsEvidence(overview: SolarDetailPayload) {
        const payload = this._ready<SolarDestinationsSectionPayload>("destinations");
        const destinations = payload?.destinations;
        const meterToday = readEnergyKWh(this.hass, overview.entities.today_energy);
        const exportToday = readEnergyKWh(this.hass, overview.entities.today_export);
        const charge = payload?.charge;
        return html`
            ${destinations ? html`
                <div class="section-title">${this._t("destinations.coverage")}</div>
                ${this._row(this._t("destinations.attributed"), destinations.producedKwh > 0
                    ? fillTemplate(this._t("destinations.attributed_value"), {
                        share: this._share(destinations.attributedKwh / destinations.producedKwh),
                        kwh: formatGridEnergy(destinations.attributedKwh),
                    })
                    : this._t("unknown"), "attributed")}
                ${destinations.unattributedKwh > 0 ? this._row(this._t("destinations.unattributed"), formatGridEnergy(destinations.unattributedKwh), "unattributed") : nothing}
                ${this._row(this._t("destinations.measured_export"), formatGridEnergy(destinations.measuredExportKwh), "measured-export")}
                ${destinations.otherExportKwh > 0 ? this._row(this._t("destinations.other_export"), formatGridEnergy(destinations.otherExportKwh), "other-export", this._t("destinations.other_export_scope")) : nothing}
                ${!payload!.complete ? html`<p class="note" data-incomplete>${this._t("destinations.incomplete")}</p>` : nothing}
                <div class="section-title">${this._t("destinations.reconcile")}</div>
                ${this._row(this._t("destinations.meter_today"), meterToday === null ? this._t("unavailable") : formatGridEnergy(meterToday), "meter-today", undefined, overview.entities.today_energy)}
                ${this._row(this._t("destinations.export_today"), exportToday === null ? this._t("unavailable") : formatGridEnergy(exportToday), "export-today", undefined, overview.entities.today_export)}
                <p class="note">${this._t("destinations.reconcile_note")}</p>
            ` : nothing}
            <div class="section-title">${this._t("destinations.dc_split")}</div>
            ${this._dcSplit()}
            ${charge && charge.solarKwh > 0 ? html`
                <div class="section-title">${this._t("destinations.value")}</div>
                ${this._row(this._t("destinations.forgone"), charge.forgoneValue === null
                    ? this._t("unknown")
                    : this._formatMoney(charge.forgoneValue, currencyFromPriceUnit(payload!.currency)), "forgone", this._t("destinations.forgone_scope"))}
                ${charge.forgoneRate !== null ? this._row(this._t("destinations.forgone_rate"), formatPriceValue(charge.forgoneRate, payload!.currency), "forgone-rate") : nothing}
                ${charge.solarUnpricedKwh > 0 ? this._row(this._t("destinations.solar_unpriced"), formatGridEnergy(charge.solarUnpricedKwh), "solar-unpriced") : nothing}
            ` : nothing}
            <p class="note">${this._t("destinations.value_note")}</p>
        `;
    }

    /**
     * Where the PV input goes now: into the battery while it charges, the rest
     * through the inverter's AC side. Both are the card's live figures; the
     * AC side is the remainder, so it includes the conversion loss. While the
     * grid imports as the battery charges, the grid may be charging it too, and
     * live figures cannot tell how much of the charge is PV: the split is not
     * given then.
     */
    private _dcSplit() {
        const pv = this._powerNow();
        const battery = this.params.batteryPower;
        const grid = this.params.gridPower;
        if (pv === null) return html`<p class="note">${this._t("destinations.dc_unavailable")}</p>`;
        const input = Math.max(0, pv);
        const charges = battery !== null && battery > IDLE_W;
        if (charges && (grid === null || grid > IDLE_W)) {
            return html`
                ${this._row(this._t("destinations.dc_input"), formatPower(input).display, "dc-input")}
                ${this._row(this._t("destinations.dc_battery"), this._t("destinations.dc_mixed"), "dc-battery")}
            `;
        }
        const charging = charges ? Math.min(battery!, input) : battery === null ? null : 0;
        return html`
            ${this._row(this._t("destinations.dc_input"), formatPower(input).display, "dc-input")}
            ${this._row(this._t("destinations.dc_battery"), charging === null ? this._t("unavailable") : formatPower(charging).display, "dc-battery")}
            ${charging !== null ? this._row(this._t("destinations.dc_ac"), formatPower(Math.max(0, input - charging)).display, "dc-ac", this._t("destinations.dc_ac_scope")) : nothing}
        `;
    }

    // Limits ------------------------------------------------------------------

    /** The inverter's AC rating, W; `null` without a valid reading. */
    private _ratedW(overview: SolarDetailPayload): number | null {
        const watts = this._watts(overview, "rated_power");
        return watts !== null && watts > 0 ? watts : null;
    }

    private _limitsPreview(overview: SolarDetailPayload): string {
        const parts: string[] = [];
        const exportLimit = this._watts(overview, "export_limit");
        if (exportLimit !== null) parts.push(fillTemplate(this._t("limits.export_short"), { power: formatPower(exportLimit).display }));
        const pvLimit = this._watts(overview, "pv_power_limit");
        if (pvLimit !== null) parts.push(fillTemplate(this._t("limits.pv_short"), { power: formatPower(pvLimit).display }));
        const rated = this._ratedW(overview);
        if (rated !== null) parts.push(fillTemplate(this._t("limits.rating_short"), { power: formatPower(rated).display }));
        if (!parts.length && overview.maxAllowedExportPower !== null) {
            parts.push(fillTemplate(this._t("limits.export_short"), { power: formatPower(overview.maxAllowedExportPower).display }));
        }
        return parts.length ? parts.join(" · ") : this._t("limits.none");
    }

    private _renderLimits(overview: SolarDetailPayload) {
        const rated = this._ratedW(overview);
        const power = this._powerNow();
        const input = power === null ? null : Math.max(0, power);
        const exportLimit = this._watts(overview, "export_limit");
        const pvLimit = this._watts(overview, "pv_power_limit");
        const run = this._currentRun();
        const inputText = input === null
            ? this._t("unavailable")
            : rated === null
            ? formatPower(input).display
            : fillTemplate(this._t("limits.input_of_rating"), { power: formatPower(input).display, share: this._share(input / rated) });
        return html`
            ${this._row(this._t("limits.input"), inputText, "input")}
            ${rated !== null ? this._row(this._t("limits.rating"), formatPower(rated).display, "rating", this._t("limits.scope_rating"), overview.entities.rated_power) : nothing}
            ${input !== null && rated !== null && input > rated ? html`
                <p class="note" data-above-rating>${this._t("limits.above_rating")}</p>
            ` : nothing}
            ${pvLimit !== null ? this._row(this._t("limits.pv_limit"), formatPower(pvLimit).display, "pv-limit", this._t("limits.scope_remote"), overview.entities.pv_power_limit) : nothing}
            ${exportLimit !== null ? this._row(this._t("limits.export_limit"), formatPower(exportLimit).display, "export-limit", this._t("limits.scope_inverter"), overview.entities.export_limit) : nothing}
            ${overview.maxAllowedExportPower !== null ? this._row(this._t("limits.export_cap"), formatPower(overview.maxAllowedExportPower).display, "export-cap", this._t("limits.scope_helman")) : nothing}
            ${exportLimit === 0 ? html`<p class="note" data-export-zero>${this._t("limits.export_zero")}</p>` : nothing}
            ${this._row(this._t("limits.intent"), run
                ? this._actionLabel(run.action) + (run.action.conditionMet === false ? " – " + this._t("limits.candidate") : "")
                : this._t("limits.nothing_scheduled"), "intent", this._t("limits.scope_plan"))}
            <p class="note">${this._t(overview.profile ? "limits.explain" : "limits.explain_custom")}</p>
        `;
    }

    private _renderLimitsEvidence(overview: SolarDetailPayload) {
        const runtime = this._currentRuntime();
        const battery = this.params.batteryPower;
        const settings = [
            this._optionalRow(overview, "use_mode", "limits.use_mode"),
            this._optionalRow(overview, "manual_mode", "limits.manual_mode"),
            this._optionalRow(overview, "run_mode", "limits.run_mode"),
            ...overview.strings.map((string) => {
                const value = this._reading(overview, `shade_fix_pv${string}`);
                return value === null ? nothing : this._row(fillTemplate(this._t("limits.shade_fix"), { n: String(string) }), value, `shade_fix_pv${string}`);
            }),
            this._optionalRow(overview, "mppt_count", "limits.mppt_count"),
            this._optionalRow(overview, "rated_power", "limits.rated_power"),
            this._optionalRow(overview, "pv_power_limit", "limits.pv_power_limit"),
        ];
        return html`
            <div class="section-title">${this._t("limits.settings")}</div>
            ${settings.every((row) => row === nothing) ? html`<p class="note">${this._t("limits.no_settings")}</p>` : settings}
            <div class="section-title">${this._t("limits.flows")}</div>
            ${this._row(this._t("limits.input"), this._powerNow() === null ? this._t("unavailable") : formatPower(Math.max(0, this._powerNow()!)).display, "flow-input")}
            ${this._row(this._t("limits.battery"), battery === null
                ? this._t("unavailable")
                : Math.abs(battery) <= IDLE_W
                ? fillTemplate(this._t("limits.battery_idle"), { power: formatPower(Math.abs(battery)).display })
                : fillTemplate(this._t(battery > 0 ? "limits.battery_charging" : "limits.battery_discharging"), { power: formatPower(Math.abs(battery)).display }), "flow-battery")}
            ${renderCurrentSlot(this._currentRun(), runtime, this.localize, (label, value) => this._row(label, value))}
            ${this._row(this._t("limits.executor"), runtime ? runtimeText(runtime, this.localize) : this._t("limits.no_runtime"), "executor")}
            <p class="note">${this._t("limits.evidence_note")}</p>
        `;
    }

    // Strings -----------------------------------------------------------------

    private _stringsPreview(overview: SolarDetailPayload): string {
        const parts = overview.strings.flatMap((string) => {
            const watts = this._watts(overview, `pv_power_${string}`);
            return watts === null ? [] : [fillTemplate(this._t("strings.now_short"), { n: String(string), power: formatPower(Math.max(0, watts)).display })];
        });
        return parts.length ? parts.join(" · ") : this._t("strings.unavailable");
    }

    private _renderStrings(overview: SolarDetailPayload) {
        const live = overview.strings.map((string) => ({ string, watts: this._watts(overview, `pv_power_${string}`) }));
        const total = live.reduce((sum, { watts }) => sum + Math.max(0, watts ?? 0), 0);
        const allKnown = live.every(({ watts }) => watts !== null);
        return html`
            <div class="section-title">${this._t("strings.now")}</div>
            ${live.map(({ string, watts }) => html`
                <div class="row" data-row=${`now-${string}`}>
                    <span class="label"><span class="swatch" style="background: ${STRING_COLORS[String(string)] ?? NEUTRAL_LIGHT_COLOR}"></span>${fillTemplate(this._t("strings.string"), { n: String(string) })}</span>
                    <span class="value">${watts === null
                        ? this._t("unavailable")
                        : allKnown && total > IDLE_W
                        ? fillTemplate(this._t("strings.now_value"), { power: formatPower(Math.max(0, watts)).display, share: this._share(Math.max(0, watts) / total) })
                        : formatPower(Math.max(0, watts)).display}</span>
                </div>
            `)}
            <div class="section-title">${this._t("strings.today")}</div>
            ${this._renderStringsToday()}
            <p class="note">${this._t("strings.explain")}</p>
        `;
    }

    private _renderStringsToday() {
        const section = this._sections.strings ?? null;
        if (section === null || section.status === "loading") {
            return html`<p class="note" data-strings-loading>${this._t("loading_history")}</p>`;
        }
        if (section.status === "error") {
            return html`
                <p class="note">${this._t("history_failed")}</p>
                <button class="link-button" @click=${() => this._loadSection("strings")}>${this._t("retry")}</button>
            `;
        }
        const payload = this._ready<SolarStringsSectionPayload>("strings");
        if (!payload) return html`<p class="note">${this._t("loading_history")}</p>`;
        const common = payload.energy.common;
        const kwh = common.kwh;
        const sum = kwh ? Object.values(kwh).reduce((total, value) => total + value, 0) : 0;
        const chart = this._stringsChartFor(payload);
        return html`
            ${kwh && sum > 0 ? html`
                ${common.strings.map((string) => this._row(
                    fillTemplate(this._t("strings.string"), { n: String(string) }),
                    fillTemplate(this._t("strings.share_value"), { kwh: formatGridEnergy(kwh[String(string)]), share: this._share(kwh[String(string)] / sum) }),
                    `share-${string}`,
                ))}
                ${this._row(this._t("strings.common"), fillTemplate(this._t("strings.common_value"), { coverage: this._share(common.coverage) }), "common")}
            ` : html`<p class="note" data-no-common>${this._t("strings.no_common")}</p>`}
            ${chart.series.length ? html`
                <helman-day-line-chart
                    data-strings-chart
                    .series=${chart.series}
                    .start=${Date.parse(payload.period.start)}
                    .end=${Date.parse(payload.period.end)}
                    .bucketMs=${300_000}
                    .timeZone=${this._timeZone}
                    .locale=${this._locale}
                    .formatValue=${this._formatWatts}
                    .summary=${this._t("strings.chart_summary")}
                ></helman-day-line-chart>
            ` : nothing}
        `;
    }

    /** The chart's inputs, kept while the payload is the same one. */
    private _stringsChartFor(payload: SolarStringsSectionPayload): { series: DayLineSeries[] } {
        if (this._stringsChart?.payload !== payload) {
            const series = Object.entries(payload.strings).flatMap(([string, entry]) => {
                const points = entry?.day?.points ?? [];
                return points.length ? [{
                    key: "pv" + string,
                    label: fillTemplate(this._t("strings.string"), { n: string }),
                    color: STRING_COLORS[string] ?? NEUTRAL_LIGHT_COLOR,
                    points: points.map((point) => ({ t: Date.parse(point.start), v: point.mean, min: point.min, max: point.max })),
                }] : [];
            });
            this._stringsChart = { payload, series };
        }
        return this._stringsChart;
    }

    private _renderStringsEvidence(overview: SolarDetailPayload) {
        const payload = this._ready<SolarStringsSectionPayload>("strings");
        const dash = "–";
        return html`
            <table data-string-table>
                <thead><tr>
                    <th>${this._t("strings.string_column")}</th><th>W</th><th>V</th><th>A</th>
                </tr></thead>
                <tbody>
                    ${overview.strings.map((string) => html`
                        <tr data-string=${string}>
                            <td>${string}</td>
                            <td>${this._reading(overview, `pv_power_${string}`) ?? dash}</td>
                            <td>${this._reading(overview, `pv_voltage_${string}`) ?? dash}</td>
                            <td>${this._reading(overview, `pv_current_${string}`) ?? dash}</td>
                        </tr>
                    `)}
                </tbody>
            </table>
            ${payload ? html`
                <div class="section-title">${this._t("strings.coverage")}</div>
                ${Object.entries(payload.strings).map(([string, entry]) => {
                    const energy = payload.energy.strings[string];
                    if (!entry) return nothing;
                    const value = entry.day === null
                        ? fillTemplate(this._t("strings.unit_unknown"), { unit: entry.unit ?? "?" })
                        : fillTemplate(this._t("strings.coverage_value"), {
                            kwh: energy?.kwh == null ? "?" : formatGridEnergy(energy.kwh),
                            coverage: this._share(energy?.coverage ?? 0),
                        });
                    return this._row(fillTemplate(this._t("strings.string"), { n: string }), value, `coverage-${string}`);
                })}
            ` : nothing}
            <p class="note">${this._t("strings.calculation")}</p>
            <p class="note" data-normalization>${this._t("strings.no_normalization")}</p>
        `;
    }

    // Outlook -----------------------------------------------------------------

    private _outlookPreview(model: ForecastModel | null): string | null {
        if (!model) return this._forecastFailed ? this.localize("node_detail.forecast_failed") : this._forecastMissing();
        const tomorrow = model.days[1];
        return tomorrow?.kwh != null
            ? fillTemplate(this._t("outlook.tomorrow_short"), { kwh: formatGridEnergy(tomorrow.kwh) })
            : this._t("outlook.no_tomorrow");
    }

    private _renderOutlook(overview: SolarDetailPayload, model: ForecastModel | null) {
        const lifetime = readEnergyKWh(this.hass, overview.entities.lifetime_energy);
        return html`
            ${model ? html`
                <div class="days" data-outlook>
                    ${model.days.map((day, index) => html`
                        <div class="day" data-day=${day.key}>
                            <span class="day-label">${index === 0 ? this._t("outlook.today") : this._dayLabel(day.key, day.firstMs)}</span>
                            <span class="day-value">${day.kwh === null ? this._t("outlook.no_forecast") : formatGridEnergy(day.kwh)}</span>
                        </div>
                    `)}
                </div>
                <p class="note">${this._t(model.corrected ? "outlook.explain" : "outlook.explain_raw")}</p>
            ` : this._forecastFailed ? this._renderForecastFailed() : html`<p class="note">${this._forecastMissing()}</p>`}
            ${lifetime !== null ? this._row(this._t("outlook.lifetime"), formatGridEnergy(lifetime), "lifetime", this._t("outlook.lifetime_scope"), overview.entities.lifetime_energy) : nothing}
        `;
    }

    private _renderOutlookEvidence(overview: SolarDetailPayload) {
        const lifetime = readEnergyKWh(this.hass, overview.entities.lifetime_energy);
        const kwp = overview.configuredMaxPowerW === null ? null : overview.configuredMaxPowerW / 1000;
        const bias = this._forecast?.solar.biasCorrection;
        const days = this._model()?.days.filter((day) => day.kwh !== null).length ?? 0;
        return html`
            ${this._row(this._t("outlook.capacity"), kwp === null ? this._t("outlook.capacity_none") : fillTemplate(this._t("outlook.kwp"), { kwp: kwp.toFixed(1) }), "capacity", this._t("outlook.capacity_scope"))}
            ${lifetime !== null && kwp !== null ? html`
                ${this._row(this._t("outlook.per_kwp"), fillTemplate(this._t("outlook.per_kwp_value"), {
                    value: Math.round(lifetime / kwp).toString(),
                    lifetime: formatGridEnergy(lifetime),
                    kwp: kwp.toFixed(1),
                }), "per-kwp")}
                <p class="note" data-per-kwp-note>${this._t("outlook.per_kwp_note")}</p>
            ` : nothing}
            ${this._row(this._t("outlook.horizon"), fillTemplate(this._t("outlook.horizon_value"), { days: String(days) }), "horizon")}
            ${bias ? this._row(this._t("outlook.training"), fillTemplate(this._t("outlook.training_value"), { days: String(bias.explainability.usableDays) }), "training") : nothing}
            <p class="note">${this._t("outlook.evidence_note")}</p>
        `;
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
        const raw = corrected ? new Map(toSlots(solar.points).map((slot) => [slot.start, slot.wh])) : null;
        const today = dayKey(now, timeZone);
        const isToday = (ms: number) => dayKey(ms, timeZone) === today;

        // Only the elapsed slots with a measured value, against the forecast for
        // exactly those slots: the in-progress slot and a gap are left out of both.
        const forecastAt = new Map(effective.map((slot) => [slot.start, slot.wh]));
        let comparison: ForecastModel["comparison"] = null;
        for (const actual of toSlots(solar.actualHistory)) {
            const forecast = forecastAt.get(actual.start);
            if (forecast === undefined || !isToday(actual.start) || actual.start + SLOT_MS > now) continue;
            const rawWh = raw?.get(actual.start);
            if (comparison === null) {
                comparison = { startMs: actual.start, endMs: actual.start + SLOT_MS, actualKwh: 0, forecastKwh: 0, rawKwh: raw ? 0 : null };
            }
            comparison.startMs = Math.min(comparison.startMs, actual.start);
            comparison.endMs = Math.max(comparison.endMs, actual.start + SLOT_MS);
            comparison.actualKwh += Math.max(0, actual.wh) / 1000;
            comparison.forecastKwh += Math.max(0, forecast) / 1000;
            if (comparison.rawKwh !== null) comparison.rawKwh = rawWh === undefined ? null : comparison.rawKwh + Math.max(0, rawWh) / 1000;
        }

        let remainingKwh = 0;
        let slotW: number | null = null;
        let startsAt: number | null = null;
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
                if (slot.start <= now) slotW = Math.max(0, slot.wh) / (SLOT_MS / 3_600_000);
                // The first slot ahead where forecast production starts, or stops.
                if (slot.start > now && producing && !producingBefore && startsAt === null) startsAt = slot.start;
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
        return { comparison, remainingKwh, slotW, startsAt, endsAt, days, corrected, boundaries, todaySlots };
    }

    /** Why there is no forecast model: still loading, or not configured. */
    private _forecastMissing(): string {
        if (this._forecast === null) return this._t("forecast_loading");
        return this._t(this._forecast.solar.status === "not_configured" ? "forecast_not_configured" : "forecast_unavailable");
    }

    // ── Schedule ────────────────────────────────────────────────────────────

    private _runs(): ScheduleRun[] {
        return scheduleRuns(this._schedule, Date.now());
    }

    private _currentRun(): ScheduleRun | null {
        return currentRun(this._runs(), Date.now());
    }

    private _currentRuntime() {
        return currentRuntime(this._schedule, Date.now());
    }

    // ── Readings and formatting ─────────────────────────────────────────────

    /** The card passes its live solar reading in W, or null when unreadable. */
    private _powerNow(): number | null {
        return this.params.power;
    }

    private _watts(overview: SolarDetailPayload, key: string): number | null {
        return this._scaled(overview, key, WATTS);
    }

    private _periodText(startMs: number, endMs: number): string {
        return fillTemplate(this._t("period"), { start: this._time(startMs), end: this._time(endMs) });
    }

    private _dayLabel(key: string, firstMs: number | null): string {
        // A day's first slot is inside it in HA's time zone. Without one, the
        // key is the calendar date itself: format it in UTC, where noon of the
        // key is that date whatever HA's offset.
        const format = { weekday: "short", day: "numeric", month: "numeric" } as const;
        return firstMs !== null
            ? new Intl.DateTimeFormat(this._locale, { ...format, timeZone: this._timeZone }).format(firstMs)
            : new Intl.DateTimeFormat(this._locale, { ...format, timeZone: "UTC" }).format(Date.parse(`${key}T12:00:00Z`));
    }

    private _dateTime(ms: number): string {
        return new Intl.DateTimeFormat(this._locale, { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", timeZone: this._timeZone }).format(ms);
    }

    private _signedKwh(kwh: number): string {
        return (kwh < 0 ? "−" : "+") + formatGridEnergy(kwh);
    }

    private readonly _formatWatts = (value: number): string => formatPower(Math.max(0, value)).display;
}

declare global {
    interface HTMLElementTagNameMap {
        "node-detail-solar-content": NodeDetailSolarContent;
    }
}
