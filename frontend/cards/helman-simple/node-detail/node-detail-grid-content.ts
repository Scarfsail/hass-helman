import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../../hass-frontend/src/types";
import { fillTemplate, type LocalizeFunction } from "../../localize/localize";
import {
    fetchGridDayAggregates,
    type DayStatsDTO,
    type ForecastPayload,
    type GridDayAggregatesPayload,
    type GridDetailPayload,
    type GridVoltageSectionPayload,
} from "../../helman-api";
import type { HelmanSolarInspectorCardConfig } from "../../helman-solar-inspector/HelmanSolarInspectorCardConfig";
import { currencyFromPriceUnit } from "../../helman-solar-inspector/money-model";
import { GRID_EXPORT_COLOR, GRID_IMPORT_COLOR } from "../../color-utils";
import { getSharedHelmanStore } from "../../helman/store";
import { ForecastLoader } from "../../helman/forecast-loader";
import { formatPower } from "../../power-format";
import { formatGridEnergy, formatPriceValue } from "../../shared/forecast-value-format";
import { formatScheduleTime } from "../../shared/schedule/model/schedule-time";
import { todayIso } from "../../shared/today-iso";
import {
    EVIDENCE_TOGGLE_EVENT,
    QUESTION_TOGGLE_EVENT,
    type QuestionToggleDetail,
} from "../../shared/node-question";
import "../../shared/node-question";
import "../../shared/day-line-chart";
import type { DayLineBand, DayLineReference, DayLineSeries } from "../../shared/day-line-chart";
import { nodeDetailSharedStyles } from "./node-detail-shared-styles";
import { announceWatchedEntities, readingNumber, readingText } from "./node-detail-readings";
import type { GridDetailParams } from "./node-detail-types";

type QuestionId = "voltage" | "phases" | "money" | "next" | "outage";

const PHASES = [1, 2, 3] as const;
type Phase = (typeof PHASES)[number];

/** One colour per phase; every chart and table also names the phase in text. */
const PHASE_COLORS: Record<Phase, string> = { 1: "#8e24aa", 2: "#fb8c00", 3: "#00897b" };

/** The nominal low-voltage supply and the ±10 % band around it, as references only. */
const NOMINAL_VOLTAGE = 230;
const REFERENCE_BAND = { from: 207, to: 253 };

/** Below this many watts either way the grid counts as idle, as on the card. */
const IDLE_W = 50;

/**
 * The inspector under "What has the grid cost or earned today?": today's
 * measured grid flow with its price and money rails. The plan, the forecast
 * and the aggregate views answer other questions, so they are hidden.
 */
export const GRID_MONEY_INSPECTOR_CONFIG: HelmanSolarInspectorCardConfig = {
    type: "custom:helman-solar-inspector-card",
    transparent_background: true,
    hide_schedule_strip: true,
    hide_aggregate_views: true,
    show_bias_ratio: false,
    daylight_only_default: false,
    chart_series: ["gridActual"],
};

/**
 * The inspector under "What changes next?": planned against measured grid flow
 * with the price rails and the schedule strip, for today and tomorrow. Money is
 * the other question's.
 */
export const GRID_PLAN_INSPECTOR_CONFIG: HelmanSolarInspectorCardConfig = {
    type: "custom:helman-solar-inspector-card",
    transparent_background: true,
    hide_money_strip: true,
    hide_aggregate_views: true,
    show_bias_ratio: false,
    daylight_only_default: false,
    chart_series: ["gridForecast", "gridActual"],
};

const INSPECTOR_CONFIGS: Partial<Record<QuestionId, HelmanSolarInspectorCardConfig>> = {
    money: GRID_MONEY_INSPECTOR_CONFIG,
    next: GRID_PLAN_INSPECTOR_CONFIG,
};

type InspectorCardElement = HTMLElement & {
    setConfig(config: HelmanSolarInspectorCardConfig): void;
    hass: unknown;
};

type SectionState<T> =
    | { status: "loading" }
    | { status: "ready"; payload: T }
    | { status: "error" };

interface PhaseReading {
    phase: Phase;
    /** Signed: positive imports, W; `null` unavailable. */
    power: number | null;
    voltage: number | null;
    /** `abs(P) / V`, `null` without a valid power and voltage. */
    current: number | null;
}

/** Today's grid money, each side `null` where it is unknown. */
interface MoneyFigures {
    cost: number | null;
    gain: number | null;
    net: number | null;
    currency: string;
    importKwh: number | null;
    exportKwh: number | null;
    costKwh: number | null;
    gainKwh: number | null;
}

/**
 * The grid detail: how stable each phase's voltage is, how each phase uses the
 * grid, what the grid cost or earned today, what changes next and what happens
 * without the grid, as an overview and five questions.
 *
 * Live readings come from `hass`; the backend overview supplies the entity ids.
 * Today's voltages are requested only while their question is open; today's
 * money comes from the inspector's own span read, the rates and the plan from
 * the forecast, and the focused inspector embeds are mounted only behind their
 * answers' second disclosure.
 */
@customElement("node-detail-grid-content")
export class NodeDetailGridContent extends LitElement {
    static styles = [nodeDetailSharedStyles, css`
        .content {
            gap: 8px;
        }
        .summary {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding-bottom: 8px;
        }
        .status {
            margin: 0;
            font-size: 0.95rem;
        }
        .figures {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
            gap: 8px;
        }
        .figure {
            display: flex;
            flex-direction: column;
            gap: 2px;
            min-width: 0;
        }
        .figure-label {
            font-size: 0.75rem;
            color: var(--secondary-text-color);
        }
        .figure-value {
            font-size: 1.05rem;
            font-weight: 600;
            overflow-wrap: anywhere;
        }
        .next {
            margin: 0;
            font-size: 0.9rem;
            color: var(--secondary-text-color);
        }
        .exception {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 4px 8px;
            padding: 8px 10px;
            border-radius: 8px;
            border-left: 3px solid var(--warning-color, #ffa600);
            background: var(--secondary-background-color, rgba(0, 0, 0, 0.04));
            font-size: 0.9rem;
        }
        .link-button {
            font: inherit;
            background: none;
            border: none;
            padding: 4px 0;
            color: var(--primary-color);
            font-weight: 600;
            cursor: pointer;
            min-height: 32px;
        }
        .rows {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }
        .row {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            gap: 12px;
            font-size: 0.9rem;
        }
        .row .label {
            flex: 1 1 auto;
            min-width: 0;
        }
        .row .value {
            text-align: right;
            overflow-wrap: anywhere;
            min-width: 0;
            max-width: 60%;
        }
        .note {
            margin: 0;
            font-size: 0.82rem;
            color: var(--secondary-text-color);
        }
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 0.82rem;
            font-variant-numeric: tabular-nums;
        }
        th, td {
            padding: 3px 4px;
            text-align: right;
            overflow-wrap: anywhere;
        }
        th:first-child, td:first-child {
            text-align: left;
        }
        th {
            color: var(--secondary-text-color);
            font-weight: 600;
        }
        .swatch {
            display: inline-block;
            width: 10px;
            height: 3px;
            margin-right: 4px;
            vertical-align: middle;
            border-radius: 2px;
        }
        .bars {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .bar-row {
            display: grid;
            grid-template-columns: 24px 1fr;
            gap: 4px 8px;
            align-items: center;
            font-size: 0.9rem;
        }
        .bar-phase {
            font-weight: 600;
        }
        .bar-track {
            position: relative;
            height: 10px;
            border-radius: 5px;
            background: var(--secondary-background-color, rgba(0, 0, 0, 0.06));
        }
        .bar-track::after {
            content: "";
            position: absolute;
            left: 50%;
            top: -2px;
            bottom: -2px;
            width: 1px;
            background: var(--secondary-text-color);
        }
        .bar-fill {
            position: absolute;
            top: 0;
            bottom: 0;
            border-radius: 5px;
        }
        .bar-text {
            grid-column: 2;
            display: flex;
            flex-wrap: wrap;
            justify-content: space-between;
            gap: 0 8px;
            font-size: 0.82rem;
        }
        .bar-scale {
            display: flex;
            justify-content: space-between;
            font-size: 0.75rem;
            color: var(--secondary-text-color);
            padding-left: 32px;
        }
        .muted {
            color: var(--secondary-text-color);
        }
        .plan {
            margin: 0 -8px;
        }
    `];

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public params!: GridDetailParams;

    @state() private _overview: SectionState<GridDetailPayload> = { status: "loading" };
    @state() private _money: SectionState<GridDayAggregatesPayload> | null = null;
    @state() private _forecast: ForecastPayload | null = null;
    @state() private _open: QuestionId | null = null;
    @state() private _evidenceOpen = false;
    @state() private _voltage: SectionState<GridVoltageSectionPayload> | null = null;
    private _voltageChart?: {
        payload: GridVoltageSectionPayload;
        series: DayLineSeries[];
        references: DayLineReference[];
        bands: DayLineBand[];
    };

    private _started = false;
    private _overviewRequest = 0;
    private _moneyRequest = 0;
    /** The local date `_money` was requested for; a new day re-reads it. */
    private _moneyDate = "";
    private _voltageRequest = 0;
    /** The run mode the current overview's condition was computed from. */
    private _runModeState = "";
    private readonly _forecastLoader = new ForecastLoader();
    private readonly _inspectors = new Map<QuestionId, InspectorCardElement>();

    connectedCallback(): void {
        super.connectedCallback();
        this.addEventListener(QUESTION_TOGGLE_EVENT, this._onQuestionToggle as EventListener);
        this.addEventListener(EVIDENCE_TOGGLE_EVENT, this._onEvidenceToggle as EventListener);
        if (this.hass) this._start();
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this.removeEventListener(QUESTION_TOGGLE_EVENT, this._onQuestionToggle as EventListener);
        this.removeEventListener(EVIDENCE_TOGGLE_EVENT, this._onEvidenceToggle as EventListener);
        this._started = false;
        // Whatever is still in flight answers nobody.
        this._overviewRequest += 1;
        this._moneyRequest += 1;
        this._voltageRequest += 1;
    }

    willUpdate(changed: Map<string, unknown>): void {
        if (changed.has("hass") && this.hass) {
            if (!this._started) this._start();
            else if (this._overview.status === "ready" && this._runModeOf(this._overview.payload) !== this._runModeState) {
                void this._loadOverview();
            }
            if (this._started && this._moneyDate !== todayIso(this._timeZone)) void this._loadMoney();
            // Only the open evidence's embed is in the page; a closed one waits.
            for (const card of this._inspectors.values()) if (card.isConnected) card.hass = this.hass;
        }
    }

    private _start(): void {
        this._started = true;
        void this._loadOverview();
        void this._loadMoney();
        void this._loadForecast();
    }

    // ── Data ────────────────────────────────────────────────────────────────

    private async _loadOverview(): Promise<void> {
        const request = ++this._overviewRequest;
        const previous = this._overview.status === "ready" ? this._overview.payload : undefined;
        if (previous) this._runModeState = this._runModeOf(previous);
        else this._overview = { status: "loading" };
        try {
            const payload = await getSharedHelmanStore(this.hass)
                .getNodeDetail<GridDetailPayload>({ node: "grid" }, { fresh: previous !== undefined });
            if (request !== this._overviewRequest) return;
            if (!previous) this._runModeState = this._runModeOf(payload);
            this._overview = { status: "ready", payload };
            announceWatchedEntities(this, Object.values(payload.entities));
            // The voltage answer may already be open, waiting for its sensors.
            if (this._open === "voltage" && this._voltage === null && payload.sections.includes("voltage")) {
                void this._loadVoltage();
            }
        } catch (error) {
            if (request !== this._overviewRequest) return;
            console.error("node-detail-grid: failed to load the overview", error);
            if (this._overview.status !== "ready") this._overview = { status: "error" };
        }
    }

    /** Today's measured grid money; a failure leaves the money figures out, nothing else. */
    private async _loadMoney(): Promise<void> {
        const request = ++this._moneyRequest;
        if (this._money?.status !== "ready") this._money = { status: "loading" };
        const date = todayIso(this._timeZone);
        this._moneyDate = date;
        try {
            const payload = await fetchGridDayAggregates(this.hass, date);
            if (request !== this._moneyRequest) return;
            this._money = { status: "ready", payload };
        } catch (error) {
            if (request !== this._moneyRequest) return;
            console.error("node-detail-grid: failed to load today's money", error);
            if (this._money?.status !== "ready") this._money = { status: "error" };
        }
    }

    private async _loadForecast(): Promise<void> {
        const forecast = await this._forecastLoader.refresh(this.hass);
        if (this._started) this._forecast = forecast;
    }

    private async _loadVoltage(): Promise<void> {
        const request = ++this._voltageRequest;
        this._voltage = { status: "loading" };
        try {
            const payload = await getSharedHelmanStore(this.hass)
                .getNodeDetail<GridVoltageSectionPayload>({ node: "grid", section: "voltage" });
            if (request !== this._voltageRequest) return;
            this._voltage = { status: "ready", payload };
        } catch (error) {
            if (request !== this._voltageRequest) return;
            console.error("node-detail-grid: failed to load today's voltages", error);
            this._voltage = { status: "error" };
        }
    }

    private _runModeOf(payload: GridDetailPayload): string {
        const entityId = payload.entities.run_mode;
        return entityId ? this.hass.states[entityId]?.state ?? "" : "";
    }

    // ── Disclosure ──────────────────────────────────────────────────────────

    private _onQuestionToggle = (event: CustomEvent<QuestionToggleDetail>): void => {
        event.stopPropagation();
        const id = event.detail.id as QuestionId;
        const header = event.composedPath()[0] as HTMLElement | undefined;
        this._setOpen(this._open === id ? null : id);
        // Opening one closes the one above it, which would move this header
        // out from under the pointer: keep it where it is in view.
        void this.updateComplete.then(() => header?.scrollIntoView?.({ block: "nearest" }));
    };

    private _onEvidenceToggle = (event: CustomEvent<QuestionToggleDetail>): void => {
        event.stopPropagation();
        this._evidenceOpen = !this._evidenceOpen;
    };

    private _setOpen(id: QuestionId | null): void {
        this._open = id;
        this._evidenceOpen = false;
        // A closed answer's history request is obsolete; it is re-read on reopen.
        this._voltageRequest += 1;
        this._voltage = null;
        if (id === "voltage" && this._overview.status === "ready" && this._overview.payload.sections.includes("voltage")) {
            void this._loadVoltage();
        }
        // An opened answer shows today's figures as they are now.
        if (id === "money") void this._loadMoney();
        if (id === "next") void this._loadForecast();
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    render() {
        if (this._overview.status === "loading") {
            return html`<div class="content"><p class="note">${this._t("loading")}</p></div>`;
        }
        if (this._overview.status === "error") {
            return html`
                <div class="content">
                    <p class="note">${this._t("load_failed")}</p>
                    <button class="link-button" @click=${() => this._loadOverview()}>${this._t("retry")}</button>
                </div>
            `;
        }
        const overview = this._overview.payload;
        return html`
            <div class="content">
                ${this._renderSummary(overview)}
                ${this._question("voltage", this._voltagePreview(overview), () => this._renderVoltage(overview), () => this._renderVoltageEvidence(overview), "evidence")}
                ${this._question("phases", this._phasesPreview(overview), () => this._renderPhases(overview), () => this._renderPhasesEvidence(overview), "evidence")}
                ${this._question("money", this._moneyPreview(), () => this._renderMoney(), () => this._renderMoneyEvidence(), "evidence")}
                ${this._question("next", this._nextPreview(), () => this._renderNext(), () => this._renderNextEvidence(), "evidence")}
                ${overview.profile ? this._question("outage", this._outagePreview(overview), () => this._renderOutage(overview), () => this._renderOutageEvidence(overview), "technical") : nothing}
            </div>
        `;
    }

    private _question(
        id: QuestionId,
        preview: string | null,
        answer: () => TemplateResult,
        evidence: () => TemplateResult,
        evidenceKind: "evidence" | "technical",
    ) {
        const open = this._open === id;
        return html`
            <helman-node-question
                data-question=${id}
                question-id=${id}
                .question=${this._t(`q.${id}`)}
                .preview=${preview}
                ?open=${open}
                ?evidence-open=${open && this._evidenceOpen}
                .evidenceLabel=${this._t(evidenceKind)}
            >
                ${open ? html`<div slot="answer" class="rows">${answer()}</div>` : nothing}
                ${open && this._evidenceOpen ? html`<div slot="evidence" class="rows">${evidence()}</div>` : nothing}
            </helman-node-question>
        `;
    }

    private _renderSummary(overview: GridDetailPayload) {
        const power = this.params.gridPower;
        const status = Math.abs(power) <= IDLE_W
            ? fillTemplate(this._t("status.idle"), { power: formatPower(Math.abs(power)).display })
            : fillTemplate(this._t(power > 0 ? "status.importing" : "status.exporting"), { power: formatPower(Math.abs(power)).display });

        // The status sentence already says the power and its direction.
        const figures: Array<[string, string, string]> = [];
        const net = this._netEnergyToday(overview);
        if (net !== null) {
            figures.push([this._t(net >= 0 ? "figure.net_import" : "figure.net_export"), formatGridEnergy(net), "net-energy"]);
        }
        const money = this._moneyFigures();
        if (money && money.net !== null) {
            figures.push([this._t(money.net >= 0 ? "figure.net_cost" : "figure.net_income"), this._formatMoney(Math.abs(money.net), money.currency), "net-money"]);
        }

        const next = this._nextPriceChange("import");
        return html`
            <div class="summary" data-overview>
                <p class="status">${status}</p>
                ${figures.length ? html`
                    <div class="figures">
                        ${figures.map(([label, value, key]) => html`
                            <div class="figure" data-figure=${key}><span class="figure-label">${label}</span><span class="figure-value">${value}</span></div>
                        `)}
                    </div>
                ` : nothing}
                ${next ? html`
                    <p class="next" data-next>${fillTemplate(this._t("next_price"), { time: this._time(next.at), price: this._price(next.value, this._forecast!.grid.importPriceUnit) })}</p>
                ` : nothing}
                ${this._renderException(overview)}
            </div>
        `;
    }

    /** At most one: off-grid operation or a fault the inverter reports. */
    private _renderException(overview: GridDetailPayload) {
        if (!overview.condition) return nothing;
        return html`
            <div class="exception" role="status" data-exception>
                <span>${fillTemplate(this._t(`exception.${overview.condition.kind}`), { state: overview.condition.runMode })}</span>
                <button class="link-button" @click=${() => this._setOpen("outage")}>${this._t("exception.details")}</button>
            </div>
        `;
    }

    // Voltage -----------------------------------------------------------------

    private _voltagePreview(overview: GridDetailPayload): string {
        if (!this._hasPhaseTelemetry(overview, "ac_voltage")) return this._t("voltage.no_profile");
        const known = PHASES.map((phase) => ({ phase, value: this._number(overview, `ac_voltage_l${phase}`) }));
        const values = known.filter((reading) => reading.value !== null).map((reading) => reading.value!);
        if (!values.length) return this._t("voltage.unavailable_now");
        const range = values.length > 1
            ? this._volts(Math.min(...values)) + "–" + this._volts(Math.max(...values))
            : this._volts(values[0]);
        let text = fillTemplate(this._t("voltage.now_short"), { range });
        const missing = known.filter((reading) => reading.value === null).map((reading) => "L" + reading.phase);
        if (missing.length) text += " · " + fillTemplate(this._t("voltage.missing_short"), { phases: missing.join(", ") });
        return text;
    }

    private _renderVoltage(overview: GridDetailPayload) {
        if (!overview.sections.includes("voltage")) {
            return html`<p class="note">${this._t(this._hasPhaseTelemetry(overview, "ac_voltage") ? "voltage.no_sensors" : "voltage.no_profile_long")}</p>`;
        }
        const section = this._voltage;
        if (section === null || section.status === "loading") {
            return html`<p class="note" data-voltage-loading>${this._t("loading_history")}</p>`;
        }
        if (section.status === "error") {
            return html`
                <p class="note">${this._t("history_failed")}</p>
                <button class="link-button" @click=${() => this._loadVoltage()}>${this._t("retry")}</button>
            `;
        }
        const payload = section.payload;
        const phases = PHASES.map((phase) => ({ phase, stats: payload.phases[String(phase) as "1" | "2" | "3"] }));
        const drawn = phases.filter(({ stats }) => stats && stats.points.length > 0);
        if (!drawn.length) return html`<p class="note">${this._t("voltage.none_today")}</p>`;

        // The chart's inputs keep their identity until the payload changes.
        if (this._voltageChart?.payload !== payload) {
            this._voltageChart = {
                payload,
                series: drawn.map(({ phase, stats }) => ({
                    key: "l" + phase,
                    label: "L" + phase,
                    color: PHASE_COLORS[phase],
                    points: stats!.points.map((point) => ({ t: Date.parse(point.start), v: point.mean, min: point.min, max: point.max })),
                })),
                references: [{ value: NOMINAL_VOLTAGE, label: this._t("voltage.nominal_label") }],
                bands: [{ ...REFERENCE_BAND, label: this._t("voltage.band_label") }],
            };
        }
        const chart = this._voltageChart;
        const summary = drawn
            .map(({ phase, stats }) => fillTemplate(this._t("voltage.chart_summary"), {
                phase: "L" + phase,
                min: this._volts(stats!.min!),
                max: this._volts(stats!.max!),
            }))
            .join(" ");
        const spread = payload.spread;
        return html`
            <helman-day-line-chart
                data-voltage-chart
                .series=${chart.series}
                .references=${chart.references}
                .bands=${chart.bands}
                .start=${Date.parse(payload.period.start)}
                .end=${Date.parse(payload.period.end)}
                .bucketMs=${drawn[0].stats!.bucketMinutes * 60_000}
                .timeZone=${this._timeZone}
                .locale=${this._locale}
                .formatValue=${this._formatVolts}
                .summary=${summary}
            ></helman-day-line-chart>
            <table data-voltage-table>
                <thead><tr>
                    <th>${this._t("phase")}</th><th>${this._t("voltage.min")}</th><th>${this._t("voltage.mean")}</th><th>${this._t("voltage.max")}</th>
                </tr></thead>
                <tbody>
                    ${phases.map(({ phase, stats }) => this._voltageRow(phase, stats))}
                </tbody>
            </table>
            ${this._row(this._t("voltage.spread"), spread.max !== null
                ? fillTemplate(this._t("voltage.spread_value"), {
                    value: this._volts(spread.max),
                    time: spread.maxAt ? this._time(Date.parse(spread.maxAt)) : "?",
                    coverage: this._percent(spread.coverage),
                })
                : this._t("voltage.spread_none"), "spread")}
            <p class="note">${this._t("voltage.explain")}</p>
        `;
    }

    private _voltageRow(phase: Phase, stats: DayStatsDTO | null) {
        const label = html`<span class="swatch" style="background: ${PHASE_COLORS[phase]}"></span>L${phase}`;
        if (!stats || stats.mean === null) {
            return html`<tr data-phase=${phase}><td>${label}</td><td colspan="3" class="muted">${this._t(stats ? "voltage.not_recorded" : "voltage.no_sensor")}</td></tr>`;
        }
        return html`
            <tr data-phase=${phase}>
                <td>${label}</td>
                <td>${this._volts(stats.min!)}</td>
                <td>${this._volts(stats.mean)}</td>
                <td>${this._volts(stats.max!)}</td>
            </tr>
        `;
    }

    private _renderVoltageEvidence(overview: GridDetailPayload) {
        const section = this._voltage?.status === "ready" ? this._voltage.payload : null;
        const stats = section
            ? PHASES.flatMap((phase) => {
                const day = section.phases[String(phase) as "1" | "2" | "3"];
                return day ? [{ phase, day }] : [];
            })
            : [];
        return html`
            <div class="section-title">${this._t("voltage.sampling")}</div>
            ${stats.map(({ phase, day }) => this._row("L" + phase, fillTemplate(this._t("voltage.recorded"), {
                coverage: this._percent(day.coverage),
            }), "sampling-l" + phase))}
            ${[...new Set(stats.map(({ day }) => day.source))].map((source) => html`
                <p class="note" data-source=${source}>${this._t(source === "statistics" ? "voltage.source_statistics" : "voltage.source_history")}</p>
            `)}
            <p class="note">${this._t("voltage.weighting")}</p>
            <div class="section-title">${this._t("voltage.location")}</div>
            ${PHASES.map((phase) => {
                const entityId = overview.entities[`ac_voltage_l${phase}`];
                return entityId ? this._row("L" + phase, this._name(entityId), "voltage-source-l" + phase) : nothing;
            })}
            <p class="note">${this._t("voltage.location_note")}</p>
            <div class="section-title">${this._t("voltage.references")}</div>
            <p class="note" data-reference-meaning>${this._t("voltage.references_note")}</p>
        `;
    }

    // Phases ------------------------------------------------------------------

    private _phaseReadings(overview: GridDetailPayload): PhaseReading[] {
        const sign = overview.phasePowerPolarity === "positive_is_export" ? -1 : 1;
        return PHASES.map((phase) => {
            const raw = this._number(overview, `grid_power_l${phase}`);
            const voltage = this._number(overview, `ac_voltage_l${phase}`);
            const power = raw === null ? null : raw * sign;
            const current = power !== null && voltage !== null && voltage > 0 ? Math.abs(power) / voltage : null;
            return { phase, power, voltage, current };
        });
    }

    private _phasesPreview(overview: GridDetailPayload): string {
        if (!this._hasPhaseTelemetry(overview, "grid_power")) return this._t("phases.no_profile");
        const readings = this._phaseReadings(overview).filter((reading) => reading.power !== null);
        if (!readings.length) return this._t("phases.unavailable");
        const top = readings.reduce((best, reading) => Math.abs(reading.power!) > Math.abs(best.power!) ? reading : best);
        let text = fillTemplate(this._t("phases.highest_short"), { phase: "L" + top.phase, power: this._directedPower(top.power!) });
        if (top.current !== null) text += " " + fillTemplate(this._t("phases.current_short"), { current: this._amps(top.current) });
        return text;
    }

    private _renderPhases(overview: GridDetailPayload) {
        if (!this._hasPhaseTelemetry(overview, "grid_power")) {
            return html`<p class="note">${this._t("phases.no_profile_long")}</p>`;
        }
        const readings = this._phaseReadings(overview);
        const limit = this._number(overview, "main_breaker_limit");
        const scale = Math.max(1000, ...readings.map((reading) => Math.abs(reading.power ?? 0)));
        return html`
            <div class="bar-scale" aria-hidden="true"><span>${this._t("phases.export_side")}</span><span>${this._t("phases.import_side")}</span></div>
            <div class="bars">
                ${readings.map((reading) => this._phaseBar(reading, scale, limit))}
            </div>
            <p class="note">${this._t("phases.explain")}</p>
        `;
    }

    private _phaseBar(reading: PhaseReading, scale: number, limit: number | null) {
        const power = reading.power;
        const half = power === null ? 0 : Math.min(50, (Math.abs(power) / scale) * 50);
        const style = power === null || power === 0
            ? "display: none"
            : power > 0
                ? `left: 50%; width: ${half}%; background: ${GRID_IMPORT_COLOR}`
                : `right: 50%; width: ${half}%; background: ${GRID_EXPORT_COLOR}`;
        let current: string;
        if (power === null) current = "";
        else if (reading.current === null) current = this._t("phases.current_unknown");
        else if (limit !== null && limit > 0) current = fillTemplate(this._t("phases.current_of_limit"), { current: this._amps(reading.current), limit: this._amps(limit) });
        else current = fillTemplate(this._t("phases.current_only"), { current: this._amps(reading.current) });
        return html`
            <div class="bar-row" data-phase-bar=${reading.phase}>
                <span class="bar-phase">L${reading.phase}</span>
                <div class="bar-track"><div class="bar-fill" style=${style}></div></div>
                <div class="bar-text">
                    <span data-power>${power === null ? this._t("unavailable") : this._directedPower(power)}</span>
                    <span data-current class="muted">${current}</span>
                </div>
            </div>
        `;
    }

    private _renderPhasesEvidence(overview: GridDetailPayload) {
        const readings = this._phaseReadings(overview);
        const dash = "–";
        return html`
            ${this._hasPhaseTelemetry(overview, "grid_power") ? html`
                <table data-phase-table>
                    <thead><tr>
                        <th>${this._t("phase")}</th><th>W</th><th>V</th><th>${this._t("phases.est_current")}</th>
                    </tr></thead>
                    <tbody>
                        ${readings.map((reading) => html`
                            <tr>
                                <td>L${reading.phase}</td>
                                <td>${reading.power === null ? dash : Math.round(reading.power) + " W"}</td>
                                <td>${reading.voltage === null ? dash : this._volts(reading.voltage)}</td>
                                <td>${reading.current === null ? dash : this._amps(reading.current)}</td>
                            </tr>
                        `)}
                    </tbody>
                </table>
                <p class="note">${this._t("phases.sign_note")}</p>
            ` : nothing}
            ${this._optionalRow(overview, "main_breaker_limit", "phases.limit")}
            ${this._optionalRow(overview, "grid_import", "phases.meter_import")}
            ${this._optionalRow(overview, "grid_export", "phases.meter_export")}
            <p class="note">${this._t("phases.calculation")}</p>
            <p class="note">${this._t("phases.limitations")}</p>
        `;
    }

    // Money -------------------------------------------------------------------

    /** Today's money from the span read, `null` while unknown. */
    private _moneyFigures(): MoneyFigures | null {
        if (this._money?.status !== "ready") return null;
        const day = this._money.payload.days.find((row) => row.date === this._moneyDate);
        if (!day) return null;
        // A direction measured at zero cost or earned nothing; one with kWh
        // but no rate, or with nothing measured, is unknown, never zero.
        const side = (amount: number | null, kwh: number | null) => amount !== null ? amount : kwh === 0 ? 0 : null;
        const cost = side(day.moneyCost, day.gridImportKwh);
        const gain = side(day.moneyGain, day.gridExportKwh);
        if (day.moneyCost === null && day.moneyGain === null) {
            return { cost: null, gain: null, net: null, currency: "", importKwh: day.gridImportKwh, exportKwh: day.gridExportKwh, costKwh: null, gainKwh: null };
        }
        return {
            cost,
            gain,
            net: cost === null || gain === null ? null : cost - gain,
            currency: currencyFromPriceUnit(this._money.payload.currency),
            importKwh: day.gridImportKwh,
            exportKwh: day.gridExportKwh,
            costKwh: day.moneyCostKwh,
            gainKwh: day.moneyGainKwh,
        };
    }

    private _moneyPreview(): string | null {
        if (this._money?.status === "error") return this._t("money.failed");
        if (this._money?.status !== "ready") return null;
        const money = this._moneyFigures();
        if (!money || (money.cost === null && money.gain === null)) return this._t("money.unpriced");
        const parts: string[] = [];
        if (money.cost !== null) parts.push(fillTemplate(this._t("money.cost_short"), { value: this._formatMoney(money.cost, money.currency) }));
        if (money.gain !== null) parts.push(fillTemplate(this._t("money.income_short"), { value: this._formatMoney(money.gain, money.currency) }));
        return parts.join(" · ");
    }

    private _renderMoney() {
        if (this._money === null || this._money.status === "loading") {
            return html`<p class="note">${this._t("money.loading")}</p>`;
        }
        if (this._money.status === "error") {
            return html`
                <p class="note">${this._t("money.failed")}</p>
                <button class="link-button" @click=${() => this._loadMoney()}>${this._t("retry")}</button>
            `;
        }
        const money = this._moneyFigures();
        const period = fillTemplate(this._t("money.period"), { time: this._time(Date.now()) });
        if (!money || (money.cost === null && money.gain === null)) {
            return html`
                ${this._row(this._t("money.period_label"), period, "period")}
                <p class="note" data-unpriced>${this._t("money.unpriced_long")}</p>
            `;
        }
        const unknown = this._t("money.unknown");
        return html`
            ${this._row(this._t("money.period_label"), period, "period")}
            ${this._row(this._t("money.import_cost"), money.cost === null ? unknown : this._formatMoney(money.cost, money.currency), "import-cost")}
            ${this._row(this._t("money.export_income"), money.gain === null ? unknown : this._formatMoney(money.gain, money.currency), "export-income")}
            ${this._row(
                this._t(money.net !== null && money.net < 0 ? "money.net_income" : "money.net_cost"),
                money.net === null ? unknown : this._formatMoney(Math.abs(money.net), money.currency),
                "net",
            )}
            ${this._row(this._t("money.coverage"), this._coverageText(money), "coverage")}
            <p class="note">${this._t("money.explain")}</p>
        `;
    }

    /** Each direction's priced share of its measured kWh. */
    private _coverageText(money: MoneyFigures): string {
        const side = (key: string, kwh: number | null, priced: number | null) => {
            if (!kwh) return fillTemplate(this._t(`money.coverage_${key}_none`), {});
            const share = Math.min(1, (priced ?? 0) / kwh);
            return fillTemplate(this._t(`money.coverage_${key}`), { share: this._percent(share), kwh: formatGridEnergy(kwh) });
        };
        return side("import", money.importKwh, money.costKwh) + " · " + side("export", money.exportKwh, money.gainKwh);
    }

    private _renderMoneyEvidence() {
        return html`
            <div class="plan" data-money-inspector>${this._inspector("money")}</div>
            <p class="note">${this._t("money.valuation")}</p>
        `;
    }

    // Next --------------------------------------------------------------------

    private _nextPreview(): string | null {
        const grid = this._forecast?.grid;
        if (!grid) return null;
        const parts: string[] = [];
        if (grid.currentImportPrice !== null) parts.push(fillTemplate(this._t("next.import_short"), { price: this._price(grid.currentImportPrice, grid.importPriceUnit) }));
        if (grid.currentExportPrice !== null) parts.push(fillTemplate(this._t("next.export_short"), { price: this._price(grid.currentExportPrice, grid.exportPriceUnit) }));
        return parts.length ? parts.join(" · ") : this._t("next.no_prices");
    }

    private _renderNext() {
        const grid = this._forecast?.grid;
        if (!grid) return html`<p class="note">${this._t("next.unavailable")}</p>`;
        const importNext = this._nextPriceChange("import");
        const exportNext = this._nextPriceChange("export");
        const planned = this._plannedNow();
        const change = this._plannedChange();
        const priceRow = (label: string, value: number | null, unit: string | null, key: string) =>
            this._row(label, value === null ? this._t("next.no_rate") : this._price(value, unit), key);
        const changeRow = (label: string, next: { at: number; value: number } | null, unit: string | null, key: string) =>
            this._row(label, next ? fillTemplate(this._t("next.change_value"), { price: this._price(next.value, unit), time: this._time(next.at) }) : this._t("next.no_change"), key);
        return html`
            ${priceRow(this._t("next.import_now"), grid.currentImportPrice, grid.importPriceUnit, "import-now")}
            ${changeRow(this._t("next.import_next"), importNext, grid.importPriceUnit, "import-next")}
            ${priceRow(this._t("next.export_now"), grid.currentExportPrice, grid.exportPriceUnit, "export-now")}
            ${changeRow(this._t("next.export_next"), exportNext, grid.exportPriceUnit, "export-next")}
            ${this._row(this._t("next.planned_now"), planned ?? this._t("next.no_plan"), "planned-now")}
            ${change ? this._row(this._t("next.planned_change"), change, "planned-change") : nothing}
            <p class="note">${this._t(grid.scheduleAdjusted ? "next.explain_adjusted" : "next.explain")}</p>
        `;
    }

    private _renderNextEvidence() {
        return html`
            <div class="plan" data-plan-inspector>${this._inspector("next")}</div>
            <p class="note">${this._t("next.evidence_note")}</p>
        `;
    }

    /** The first future price point that differs from the current rate. */
    private _nextPriceChange(side: "import" | "export"): { at: number; value: number } | null {
        const grid = this._forecast?.grid;
        if (!grid) return null;
        const current = side === "import" ? grid.currentImportPrice : grid.currentExportPrice;
        const points = side === "import" ? grid.importPricePoints : grid.exportPricePoints;
        if (current === null) return null;
        const now = Date.now();
        for (const point of points) {
            const at = Date.parse(point.timestamp);
            if (at > now && point.value !== current) return { at, value: point.value };
        }
        return null;
    }

    /** The plan's grid flow for the slot in progress, in words. */
    private _plannedNow(): string | null {
        const slot = this._currentPlanSlot();
        return slot ? this._flowText(slot.importedFromGridKwh, slot.exportedToGridKwh) : null;
    }

    /** When the plan's grid direction next changes from the current slot's. */
    private _plannedChange(): string | null {
        const series = this._forecast?.grid.series ?? [];
        const current = this._currentPlanSlot();
        if (!current) return null;
        const direction = flowDirection(current.importedFromGridKwh, current.exportedToGridKwh);
        const now = Date.now();
        for (const slot of series) {
            const at = Date.parse(slot.timestamp);
            if (at <= now) continue;
            const next = flowDirection(slot.importedFromGridKwh, slot.exportedToGridKwh);
            if (next !== direction) {
                return fillTemplate(this._t("next.planned_change_value"), { time: this._time(at), flow: this._t(`next.flow_${next}`) });
            }
        }
        return null;
    }

    private _currentPlanSlot() {
        const now = Date.now();
        return (this._forecast?.grid.series ?? []).find((slot) => {
            const at = Date.parse(slot.timestamp);
            return at <= now && now < at + slot.durationHours * 3_600_000;
        }) ?? null;
    }

    private _flowText(imported: number, exported: number): string {
        const direction = flowDirection(imported, exported);
        if (direction === "import") return fillTemplate(this._t("next.flow_import_kwh"), { kwh: formatGridEnergy(imported) });
        if (direction === "export") return fillTemplate(this._t("next.flow_export_kwh"), { kwh: formatGridEnergy(exported) });
        return this._t("next.flow_balanced");
    }

    // Outage ------------------------------------------------------------------

    private _outagePreview(overview: GridDetailPayload): string {
        if (overview.condition) return fillTemplate(this._t(`outage.${overview.condition.kind}_short`), { state: overview.condition.runMode });
        const runMode = this._reading(overview, "run_mode");
        return runMode ? fillTemplate(this._t("outage.on_grid_short"), { state: runMode }) : this._t("outage.unknown_short");
    }

    private _renderOutage(overview: GridDetailPayload) {
        const runMode = this._reading(overview, "run_mode");
        const state = overview.condition
            ? fillTemplate(this._t(`outage.state_${overview.condition.kind}`), { state: overview.condition.runMode })
            : runMode ? fillTemplate(this._t("outage.state_on_grid"), { state: runMode }) : this._t("outage.state_unknown");
        const exportLimit = this._number(overview, "export_limit");
        return html`
            ${this._row(this._t("outage.state"), state, "grid-state")}
            ${exportLimit !== null ? this._row(this._t("outage.export_limit"), formatPower(exportLimit).display, "export-limit", this._t("outage.scope_inverter")) : nothing}
            ${overview.maxAllowedExportPower !== null ? this._row(this._t("outage.export_cap"), formatPower(overview.maxAllowedExportPower).display, "export-cap", this._t("outage.scope_helman")) : nothing}
            ${this._optionalRow(overview, "grid_mode_runtime", "outage.grid_runtime")}
            ${this._optionalRow(overview, "eps_mode_runtime", "outage.eps_runtime")}
            <p class="note">${this._t("outage.explain")}</p>
        `;
    }

    private _renderOutageEvidence(overview: GridDetailPayload) {
        const rows = [
            this._optionalRow(overview, "grid_frequency", "outage.frequency"),
            this._optionalRow(overview, "run_mode", "outage.run_mode"),
        ];
        return html`
            ${rows.every((row) => row === nothing) ? html`<p class="note">${this._t("outage.no_readings")}</p>` : rows}
            <p class="note">${this._t("outage.evidence_note")}</p>
        `;
    }

    // ── Rows and readings ───────────────────────────────────────────────────

    private _inspector(id: QuestionId): HTMLElement {
        let card = this._inspectors.get(id);
        if (!card) {
            card = document.createElement("helman-solar-inspector-card") as InspectorCardElement;
            card.setConfig(INSPECTOR_CONFIGS[id]!);
            this._inspectors.set(id, card);
        }
        card.hass = this.hass;
        return card;
    }

    private _row(label: string, value: string, key?: string, scope?: string) {
        return html`
            <div class="row" data-row=${key ?? nothing}>
                <span class="label">${label}${scope ? html`<br><span class="note">${scope}</span>` : nothing}</span>
                <span class="value">${value}</span>
            </div>
        `;
    }

    /** A technical row, hidden when its reading is unavailable. */
    private _optionalRow(overview: GridDetailPayload, key: string, labelKey: string) {
        const value = this._reading(overview, key);
        return value === null ? nothing : this._row(this._t(labelKey), value, key);
    }

    private _reading(overview: GridDetailPayload, key: string): string | null {
        return readingText(this.hass, overview.entities[key], (on) => this._t(on ? "on" : "off"));
    }

    private _number(overview: GridDetailPayload, key: string): number | null {
        return readingNumber(this.hass, overview.entities[key]);
    }

    /** Whether the profile maps any phase of `prefix` (`grid_power`, `ac_voltage`). */
    private _hasPhaseTelemetry(overview: GridDetailPayload, prefix: string): boolean {
        return PHASES.some((phase) => `${prefix}_l${phase}` in overview.entities);
    }

    /** Today's import minus export from the grid's own meters, kWh; `null` unless both read. */
    private _netEnergyToday(overview: GridDetailPayload): number | null {
        const imported = this._kwh(overview.entities.today_import);
        const exported = this._kwh(overview.entities.today_export);
        return imported === null || exported === null ? null : imported - exported;
    }

    private _kwh(entityId: string | null | undefined): number | null {
        const value = readingNumber(this.hass, entityId);
        if (value === null) return null;
        const unit = this.hass.states[entityId!]?.attributes.unit_of_measurement;
        return unit === "Wh" ? value / 1000 : unit === "MWh" ? value * 1000 : value;
    }

    private _name(entityId: string): string {
        return (this.hass.states[entityId]?.attributes.friendly_name as string | undefined) ?? entityId;
    }

    // ── Formatting ──────────────────────────────────────────────────────────

    private get _timeZone(): string {
        return this.hass.config?.time_zone || "UTC";
    }

    private get _locale(): string {
        return this.hass.locale?.language ?? this.hass.language ?? "cs";
    }

    private _time(ms: number): string {
        return formatScheduleTime(ms, this._locale, this._timeZone);
    }

    /** Power with its direction in words, never by colour or sign alone. */
    private _directedPower(power: number): string {
        if (Math.abs(power) <= IDLE_W) return fillTemplate(this._t("power.idle"), { power: formatPower(Math.abs(power)).display });
        return fillTemplate(this._t(power > 0 ? "power.import" : "power.export"), { power: formatPower(Math.abs(power)).display });
    }

    private readonly _formatVolts = (value: number): string => this._volts(value);

    private _volts(value: number): string {
        return value.toFixed(1) + " V";
    }

    private _amps(value: number): string {
        return value.toFixed(1) + " A";
    }

    private _percent(share: number): string {
        return Math.round(share * 100) + " %";
    }

    private _price(value: number, unit: string | null): string {
        return formatPriceValue(value, unit);
    }

    private _formatMoney(value: number, currency: string): string {
        return (value.toFixed(2) + " " + currency).trim();
    }

    private _t(key: string): string {
        return this.localize(`node_detail.grid.${key}`);
    }
}

/** Which way a slot's planned grid flow mostly goes; a few Wh either way is balanced. */
function flowDirection(imported: number, exported: number): "import" | "export" | "balanced" {
    if (imported - exported > 0.01) return "import";
    if (exported - imported > 0.01) return "export";
    return "balanced";
}

declare global {
    interface HTMLElementTagNameMap {
        "node-detail-grid-content": NodeDetailGridContent;
    }
}
