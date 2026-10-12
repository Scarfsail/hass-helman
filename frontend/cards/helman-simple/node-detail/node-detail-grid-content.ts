import { css, html, nothing, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { fillTemplate } from "../../localize/localize";
import {
    fetchGridDayAggregates,
    type DayStatsDTO,
    type GridDayAggregatesPayload,
    type GridDetailPayload,
    type GridVoltageSectionPayload,
} from "../../helman-api";
import type { HelmanSolarInspectorCardConfig } from "../../helman-solar-inspector/HelmanSolarInspectorCardConfig";
import { currencyFromPriceUnit } from "../../helman-solar-inspector/money-model";
import { PHASE_COLORS } from "../../color-utils";
import { helmanColorVars } from "../../color-vars";
import { getSharedHelmanStore } from "../../helman/store";
import { formatPower } from "../../power-format";
import { formatGridEnergy, formatPriceValue } from "../../shared/forecast-value-format";
import { todayIso } from "../../shared/today-iso";
import { pylonGlyph } from "../../shared/node-glyphs";
import { scheduleActionToneStyles } from "../../shared/schedule/action-tones";
import "../../shared/day-line-chart";
import type { DayLineBand, DayLineReference, DayLineSeries } from "../../shared/day-line-chart";
import { IDLE_W, NodeDetailContentBase, TODAY_REFRESH_MS, type NodeFlow, type SectionState } from "./node-detail-base";
import { nodeDetailPictureStyles, nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";
import type { GridDetailParams } from "./node-detail-types";

type QuestionId = "voltage" | "phases" | "money" | "next" | "outage";

const PHASES = [1, 2, 3] as const;
type Phase = (typeof PHASES)[number];

/** The nominal low-voltage supply and the ±10 % band around it, as references only. */
const NOMINAL_VOLTAGE = 230;
const REFERENCE_BAND = { from: 207, to: 253 };

/** The phase picture's voltage axis: the reference band with room either side, widened to fit any reading. */
const VOLTAGE_AXIS = { from: 200, to: 260 };

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
 * without the grid.
 *
 * It opens on a status pill, the phase picture and the grid's Now/Today flow
 * around the pylon. The pictures absorb two questions: the phase picture opens
 * the phases, the flow opens the money. The other three are tiles; one answer
 * is open at a time, full width under the tiles.
 *
 * Live readings come from `hass` and the live flow from the card; the backend
 * overview supplies the entity ids. Today's voltages are read on opening, for
 * the picture's ranges; today's money comes from the inspector's own span
 * read, also on opening, the rates and the plan from the forecast, today's
 * flows from the `flows` section once Today is chosen, and the focused
 * inspector embeds are mounted only behind their answers' second disclosure.
 */
@customElement("node-detail-grid-content")
export class NodeDetailGridContent extends NodeDetailContentBase<GridDetailPayload, QuestionId> {
    static styles = [helmanColorVars, nodeDetailSharedStyles, nodeDetailQuestionStyles, nodeDetailPictureStyles, scheduleActionToneStyles, css`
        .swatch {
            display: inline-block;
            width: 10px;
            height: 3px;
            margin-right: 4px;
            vertical-align: middle;
            border-radius: 2px;
        }
        .phases {
            display: grid;
            grid-template-columns: 22px minmax(0, 1fr) minmax(0, 1fr);
            gap: 2px 10px;
            align-items: center;
        }
        .phases-head {
            display: contents;
            font-size: 0.72rem;
            color: var(--secondary-text-color);
        }
        .head-power {
            display: flex;
            justify-content: space-between;
            gap: 4px;
        }
        .phase-row {
            display: contents;
        }
        .phase-name {
            font-weight: 600;
            font-size: 0.85rem;
            grid-row: span 2;
        }
        .track {
            position: relative;
            height: 10px;
            margin-top: 6px;
            border-radius: 5px;
            background: var(--secondary-background-color, rgba(0, 0, 0, 0.06));
        }
        .power-track::after {
            content: "";
            position: absolute;
            left: 50%;
            top: -2px;
            bottom: -2px;
            width: 1px;
            background: var(--secondary-text-color, #727272);
        }
        .power-fill {
            position: absolute;
            top: 0;
            bottom: 0;
            border-radius: 5px;
        }
        .band {
            position: absolute;
            top: 0;
            bottom: 0;
            background: color-mix(in srgb, var(--secondary-text-color, #727272) 18%, transparent);
        }
        .nominal {
            position: absolute;
            top: -2px;
            bottom: -2px;
            width: 1px;
            background: var(--secondary-text-color, #727272);
            opacity: 0.6;
        }
        .whisker {
            position: absolute;
            top: 4px;
            height: 2px;
            min-width: 2px;
            border-radius: 1px;
        }
        .dot {
            position: absolute;
            top: 50%;
            width: 10px;
            height: 10px;
            margin: -5px 0 0 -5px;
            border-radius: 50%;
            border: 2px solid var(--card-background-color, #fff);
            box-sizing: border-box;
        }
        .phase-text {
            font-size: 0.78rem;
            line-height: 1.25;
            overflow-wrap: anywhere;
            min-height: 1.25em;
        }
        .phase-text .muted {
            display: block;
        }
        .sparkline {
            display: block;
            width: 100%;
            height: 28px;
            margin-top: 4px;
        }
        .sparkline path {
            fill: none;
            stroke-width: 1.5;
            vector-effect: non-scaling-stroke;
        }
        .muted {
            color: var(--secondary-text-color);
        }
    `];

    protected readonly _node = "grid" as const;

    @property({ attribute: false }) public params!: GridDetailParams;

    @state() private _money: SectionState<GridDayAggregatesPayload> | null = null;
    @state() private _voltage: SectionState<GridVoltageSectionPayload> | null = null;
    private _voltageChart?: {
        payload: GridVoltageSectionPayload;
        series: DayLineSeries[];
        references: DayLineReference[];
        bands: DayLineBand[];
    };

    private _moneyRequest = 0;
    /** The local date `_money` was requested for; a new day re-reads it. */
    private _moneyDate = "";
    private _moneyRequestedAt = 0;
    private _voltageRequestedAt = 0;
    private _voltageRequest = 0;

    willUpdate(changed: Map<string, unknown>): void {
        super.willUpdate(changed);
        // Today's statistics grow while the dialog is open: re-read them on a new
        // day, and otherwise at most every few minutes, only while the page is
        // visible. The now-clock brings an idle or returning dialog back here.
        if (this._started && !document.hidden && (this._moneyDate !== todayIso(this._timeZone) || Date.now() - this._moneyRequestedAt > TODAY_REFRESH_MS)) {
            void this._loadMoney();
        }
        // Today's voltages, which the picture's ranges draw, follow the day the same way.
        if (this._voltage?.status === "ready" && !document.hidden
            && (!this._isToday(this._voltage.payload.period.start) || Date.now() - this._voltageRequestedAt > TODAY_REFRESH_MS)) {
            void this._loadVoltage();
        }
    }

    protected _start(): void {
        super._start();
        void this._loadMoney();
        void this._loadForecast();
    }

    protected _stop(): void {
        this._moneyRequest += 1;
        this._voltageRequest += 1;
        // A dropped load would otherwise stay "loading" after a reconnect.
        if (this._voltage?.status === "loading") this._voltage = null;
    }

    protected _onDataChanged(): void {
        super._onDataChanged();
        void this._loadMoney();
        if (this._voltage !== null) void this._loadVoltage();
    }

    /** The run mode the overview's condition was computed from. */
    protected _overviewSignature(payload: GridDetailPayload): string {
        const entityId = payload.entities.run_mode;
        return entityId ? this.hass.states[entityId]?.state ?? "" : "";
    }

    protected _overviewLoaded(payload: GridDetailPayload): void {
        // The picture's voltage ranges are read on opening, once the overview
        // says there are sensors to read.
        if (this._voltage === null && payload.sections.includes("voltage")) void this._loadVoltage();
    }

    // ── Data ────────────────────────────────────────────────────────────────

    /** Today's measured grid money; a failure leaves the money figures out, nothing else. */
    private async _loadMoney(): Promise<void> {
        const request = ++this._moneyRequest;
        if (this._money?.status !== "ready") this._money = { status: "loading" };
        const date = todayIso(this._timeZone);
        this._moneyDate = date;
        this._moneyRequestedAt = Date.now();
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

    private async _loadVoltage(): Promise<void> {
        const request = ++this._voltageRequest;
        // A refresh keeps the chart on screen until the new day's figures land.
        if (this._voltage?.status !== "ready" || !this._isToday(this._voltage.payload.period.start)) {
            this._voltage = { status: "loading" };
        }
        this._voltageRequestedAt = Date.now();
        try {
            const payload = await getSharedHelmanStore(this.hass)
                .getNodeDetail<GridVoltageSectionPayload>({ node: "grid", section: "voltage" }, { fresh: true });
            if (request !== this._voltageRequest) return;
            this._voltage = { status: "ready", payload };
        } catch (error) {
            if (request !== this._voltageRequest) return;
            console.error("node-detail-grid: failed to load today's voltages", error);
            if (this._voltage?.status !== "ready") this._voltage = { status: "error" };
        }
    }

    // ── Disclosure ──────────────────────────────────────────────────────────

    protected _setOpen(id: QuestionId | null): void {
        super._setOpen(id);
        // An opened answer shows today's figures as they are now.
        if (id === "money") void this._loadMoney();
        if (id === "next") void this._loadForecast();
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    render() {
        const notReady = this._renderNotReady();
        if (notReady || this._overview.status !== "ready") return notReady;
        const overview = this._overview.payload;
        return html`
            <div class="content">
                ${this._renderSummary(overview)}
                ${this._renderPhasePicture(overview)}
                ${this._renderGridFlow()}
                <div class="tiles">
                    ${this._renderNextTile()}
                    ${overview.profile ? this._renderOutageTile(overview) : nothing}
                    ${this._renderVoltageTile(overview)}
                </div>
                ${this._renderOpen(overview)}
            </div>
        `;
    }

    /** The open question's answer and evidence, full width under the tiles. */
    private _renderOpen(overview: GridDetailPayload) {
        switch (this._open) {
            case "voltage":
                return this._question("voltage", this._voltagePreview(overview), () => this._renderVoltage(overview), () => this._renderVoltageEvidence(overview), "evidence");
            case "phases":
                return this._question("phases", this._phasesPreview(overview), () => this._renderPhases(overview), () => this._renderPhasesEvidence(overview), "evidence");
            case "money":
                return this._question("money", this._moneyPreview(), () => this._renderMoney(), () => this._renderMoneyEvidence(), "evidence");
            case "next":
                return this._question("next", this._nextPreview(), () => this._renderNext(), () => this._renderNextEvidence(), "evidence");
            case "outage":
                return overview.profile
                    ? this._question("outage", this._outagePreview(overview), () => this._renderOutage(overview), () => this._renderOutageEvidence(overview), "technical")
                    : nothing;
            default:
                return nothing;
        }
    }

    private _renderSummary(overview: GridDetailPayload) {
        const power = this.params.gridPower;
        const status = power === null
            ? this._t("status.unavailable")
            : Math.abs(power) <= IDLE_W
            ? fillTemplate(this._t("status.idle"), { power: formatPower(Math.abs(power)).display })
            : fillTemplate(this._t(power > 0 ? "status.importing" : "status.exporting"), { power: formatPower(Math.abs(power)).display });
        return html`
            <div class="summary" data-overview>
                <p class="status pill action-tone-neutral" data-tone="neutral">${status}</p>
                ${this._renderException(overview)}
            </div>
        `;
    }

    // Phase picture -----------------------------------------------------------

    /**
     * Each phase's power and voltage, always visible: the power in the
     * phase's colour, export to the left and import to the right, on the
     * configured main breaker setting at the nominal voltage (the phases
     * answer's own comparison); the voltage as a dot inside the reference
     * band, with today's min–max whisker from the `voltage` section. A phase
     * or a range without a reading is said, never drawn as zero. A tap opens
     * the phases answer.
     */
    private _renderPhasePicture(overview: GridDetailPayload) {
        if (!this._hasPhaseTelemetry(overview, "grid_power") && !this._hasPhaseTelemetry(overview, "ac_voltage")) {
            // No picture to draw, but the answer (its evidence and what it needs) stays one tap away.
            return html`
                <button
                    class="picture"
                    data-phase-picture-none
                    title=${this._t("q.phases")}
                    aria-expanded=${this._open === "phases" ? "true" : "false"}
                    @click=${() => this._setOpen(this._open === "phases" ? null : "phases")}
                ><span class="note">${this._t("phases.no_profile")}</span></button>
            `;
        }
        const readings = this._phaseReadings(overview);
        const scaleW = this._phaseScaleW(overview, readings);
        const ranges = this._voltage?.status === "ready" ? this._voltage.payload.phases : null;
        const known = [
            ...readings.map((reading) => reading.voltage).filter((value): value is number => value !== null && value > 0),
            ...PHASES.flatMap((phase) => {
                const stats = ranges?.[String(phase) as "1" | "2" | "3"];
                return stats?.min != null && stats.max != null ? [stats.min, stats.max] : [];
            }),
        ];
        const axis = { from: Math.min(VOLTAGE_AXIS.from, ...known), to: Math.max(VOLTAGE_AXIS.to, ...known) };
        return html`
            <button
                class="picture"
                data-phase-picture
                title=${this._t("q.phases")}
                aria-expanded=${this._open === "phases" ? "true" : "false"}
                @click=${() => this._setOpen(this._open === "phases" ? null : "phases")}
            >
                <span class="phases">
                    <span class="phases-head" aria-hidden="true">
                        <span></span>
                        <span class="head-power"><span>${this._t("phases.export_side")}</span><span>${this._t("phases.import_side")}</span></span>
                        <span>${this._t("picture.voltage")}</span>
                    </span>
                    ${readings.map((reading) => this._phaseRow(reading, scaleW, axis, ranges))}
                </span>
            </button>
            ${this._renderRangeStatus(overview)}
        `;
    }

    /** Whether today's voltage ranges are still loading or failed; nothing once they are in. */
    private _renderRangeStatus(overview: GridDetailPayload) {
        if (!overview.sections.includes("voltage")) return nothing;
        const section = this._voltage;
        if (section === null || section.status === "loading") {
            return html`<p class="note" data-range-loading>${this._t("picture.range_loading")}</p>`;
        }
        if (section.status === "error") {
            return html`
                <p class="note" data-range-failed>${this._t("picture.range_failed")}</p>
                <button class="link-button" @click=${() => this._loadVoltage()}>${this._t("retry")}</button>
            `;
        }
        return nothing;
    }

    /**
     * What a full power bar is, W: the main breaker setting at the nominal
     * voltage, so every phase is drawn against the same configured current;
     * without a setting, the largest phase power, at least 1 kW.
     */
    private _phaseScaleW(overview: GridDetailPayload, readings: PhaseReading[]): number {
        const limit = this._number(overview, "main_breaker_limit");
        if (limit !== null && limit > 0) return limit * NOMINAL_VOLTAGE;
        return Math.max(1000, ...readings.map((reading) => Math.abs(reading.power ?? 0)));
    }

    private _phaseRow(reading: PhaseReading, scaleW: number, axis: { from: number; to: number }, ranges: GridVoltageSectionPayload["phases"] | null) {
        const color = `var(--helman-phase-l${reading.phase})`;
        const power = reading.power;
        const half = power === null ? 0 : Math.min(50, Math.abs(power) / scaleW * 50);
        const fill = power === null || Math.abs(power) <= 0
            ? nothing
            : html`<span class="power-fill" data-power-fill=${power > 0 ? "import" : "export"}
                style="${power > 0 ? "left" : "right"}: 50%; width: ${half.toFixed(2)}%; background: ${color}"></span>`;
        const at = (volts: number) => ((volts - axis.from) / (axis.to - axis.from) * 100).toFixed(2) + "%";
        const voltage = reading.voltage !== null && reading.voltage > 0 ? reading.voltage : null;
        const stats = ranges?.[String(reading.phase) as "1" | "2" | "3"];
        const range = stats?.min != null && stats.max != null ? { min: stats.min, max: stats.max } : null;
        let rangeText: string | null = null;
        if (range) rangeText = fillTemplate(this._t("picture.range"), { min: this._volts(range.min), max: this._volts(range.max) });
        else if (ranges) rangeText = this._t(stats ? "voltage.not_recorded" : "voltage.no_sensor");
        return html`
            <span class="phase-row" data-phase-bar=${reading.phase}>
                <span class="phase-name">L${reading.phase}</span>
                <span class="track power-track">${fill}</span>
                <span class="track voltage-track" data-voltage=${reading.phase}>
                    <span class="band" style="left: ${at(REFERENCE_BAND.from)}; width: calc(${at(REFERENCE_BAND.to)} - ${at(REFERENCE_BAND.from)})"></span>
                    <span class="nominal" style="left: ${at(NOMINAL_VOLTAGE)}"></span>
                    ${range ? html`<span class="whisker" data-whisker data-min=${range.min} data-max=${range.max}
                        style="left: ${at(range.min)}; width: calc(${at(range.max)} - ${at(range.min)}); background: ${color}"></span>` : nothing}
                    ${voltage !== null ? html`<span class="dot" data-dot data-v=${voltage} style="left: ${at(voltage)}; background: ${color}"></span>` : nothing}
                </span>
                <span class="phase-text" data-power>${power === null ? this._t("unavailable") : this._directedPower(power)}</span>
                <span class="phase-text">
                    <span data-volts>${voltage === null ? this._t("unavailable") : this._volts(voltage)}</span>
                    ${rangeText ? html`<span class="muted" data-range>${rangeText}</span>` : nothing}
                </span>
            </span>
        `;
    }

    // Flow --------------------------------------------------------------------

    /**
     * Solar and battery export in, house and battery import out, around the
     * pylon: live from the card on Now with the rates now as the footnote,
     * today's kWh from the `flows` section on Today with today's export
     * income and import cost on their sides. A tap opens the money.
     */
    private _renderGridFlow() {
        const flow = this._flowScope === "now" ? this._nowFlow() : this._todayFlow();
        return this._renderFlow(flow, this.params.flowScaleW, "money", html`<span slot="centre">${pylonGlyph()}</span>`);
    }

    /** The card's live split, W; unknown without the solar, battery or house reading, never 0. */
    private _nowFlow(): NodeFlow {
        const flows = this.params.flows;
        const power = (value: number | null) => value === null ? "–" : formatPower(value).display;
        const inputs = [
            this._flowItem("solar", flows?.solarToGrid ?? null, power),
            this._flowItem("battery", flows?.batteryToGrid ?? null, power),
        ];
        const outputs = [
            this._flowItem("house", flows?.gridToHouse ?? null, power),
            this._flowItem("battery", flows?.gridToBattery ?? null, power),
        ];
        const prices = this._pricesNow();
        return {
            scopeLabel: this._nowScopeLabel(),
            inputs,
            outputs,
            ...this._flowTotals(inputs, outputs, power),
            notes: prices.length ? [fillTemplate(this._t("flow.price_now"), { prices: prices.join(" · ") })] : [],
        };
    }

    /**
     * Today's kWh from the `flows` section, with today's export income on the
     * export side and import cost on the import side, from the money read on
     * opening; a side whose money is not known says so, never zero.
     */
    private _todayFlow(): NodeFlow {
        const flows = this._todayFlows?.status === "ready" ? this._todayFlows.payload.flows : null;
        const energy = (value: number | null) => value === null ? "–" : formatGridEnergy(value);
        const inputs = [
            this._flowItem("solar", flows?.solarToGrid ?? null, energy),
            this._flowItem("battery", flows?.batteryToGrid ?? null, energy),
        ];
        const outputs = [
            this._flowItem("house", flows?.gridToHouse ?? null, energy),
            this._flowItem("battery", flows?.gridToBattery ?? null, energy),
        ];
        const status = this._todayFlowsNote();
        const notes: string[] = status ? [status] : [];
        const totals = this._flowTotals(inputs, outputs, energy);
        const money = this._moneyFigures();
        const unknown = this._t("money.unknown");
        const withMoney = (total: string | null, key: string, value: number | null) => money
            ? [total, fillTemplate(this._t(key), { value: value === null ? unknown : this._formatMoney(value, money.currency) })].filter(Boolean).join(" · ")
            : total;
        if (this._money?.status === "error") notes.push(this._t("money.failed"));
        return {
            scopeLabel: this._todayScopeLabel(),
            inputs,
            outputs,
            totalIn: withMoney(totals.totalIn, "money.income_short", money?.gain ?? null),
            totalOut: withMoney(totals.totalOut, "money.cost_short", money?.cost ?? null),
            notes,
        };
    }

    // Tiles -------------------------------------------------------------------

    /** The next import price change, in the import colour. */
    private _renderNextTile() {
        const accent = "var(--helman-grid-import)";
        const grid = this._forecast?.grid;
        if (!grid) {
            return this._tile("next", "–", this._forecastFailed ? this.localize("node_detail.forecast_failed") : this._t("tile.loading_prices"));
        }
        const next = this._nextPriceChange("import");
        if (next) {
            return this._tile("next", this._time(next.at), fillTemplate(this._t("next.import_short"), { price: this._price(next.value, grid.importPriceUnit) }), nothing, null, accent);
        }
        const now = this._priceNow("import");
        return this._tile("next", this._t("tile.no_price_change"), now === null ? null : fillTemplate(this._t("next.import_short"), { price: this._price(now, grid.importPriceUnit) }), nothing, null, accent);
    }

    /** Whether the inverter runs on the grid now, by its own run mode. */
    private _renderOutageTile(overview: GridDetailPayload) {
        const condition = overview.condition;
        const runMode = this._reading(overview, "run_mode");
        if (condition) return this._tile("outage", this._t(`tile.${condition.kind}`), condition.runMode);
        return runMode
            ? this._tile("outage", this._t("tile.on_grid"), runMode)
            : this._tile("outage", "–", this._t("outage.unknown_short"));
    }

    /** Today's voltage range over every phase, with each phase's day as a sparkline. */
    private _renderVoltageTile(overview: GridDetailPayload) {
        if (!overview.sections.includes("voltage")) {
            return this._tile("voltage", "–", this._t(this._hasPhaseTelemetry(overview, "ac_voltage") ? "tile.no_voltage_sensors" : "voltage.no_profile"));
        }
        const section = this._voltage;
        if (section === null || section.status === "loading") return this._tile("voltage", "–", this._t("loading_history"));
        if (section.status === "error") return this._tile("voltage", "–", this._t("history_failed"));
        const drawn = PHASES.flatMap((phase) => {
            const stats = section.payload.phases[String(phase) as "1" | "2" | "3"];
            return stats && stats.points.length && stats.min !== null && stats.max !== null ? [{ phase, stats }] : [];
        });
        if (!drawn.length) return this._tile("voltage", "–", this._t("voltage.none_today"));
        const low = Math.min(...drawn.map(({ stats }) => stats.min!));
        const high = Math.max(...drawn.map(({ stats }) => stats.max!));
        const start = Date.parse(section.payload.period.start);
        const span = Math.max(1, Date.parse(section.payload.period.end) - start);
        const means = drawn.flatMap(({ stats }) => stats.points.map((point) => point.mean));
        const bottom = Math.min(...means);
        const top = Math.max(bottom + 1, ...means);
        const bucketMs = drawn[0].stats.bucketMinutes * 60_000;
        // A gap in the day stays a gap in the line.
        const path = (points: Array<{ start: string; mean: number }>) => {
            let d = "";
            let previous: number | null = null;
            for (const point of points) {
                const t = Date.parse(point.start);
                const x = (t - start) / span * 100;
                const y = 2 + (1 - (point.mean - bottom) / (top - bottom)) * 24;
                d += `${previous === null || t - previous > bucketMs * 1.5 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
                previous = t;
            }
            return d;
        };
        const graphic = html`
            <svg class="sparkline" data-sparkline viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
                ${drawn.map(({ phase, stats }) => svg`<path data-spark=${phase} d=${path(stats.points)} stroke=${PHASE_COLORS[phase]}></path>`)}
            </svg>
        `;
        return this._tile("voltage", `${Math.floor(low)}–${Math.ceil(high)} V`, this._t("tile.voltage_range"), graphic);
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

    /**
     * The picture above draws each phase; the answer adds each phase's
     * estimated current against the configured setting, and what a full bar is.
     */
    private _renderPhases(overview: GridDetailPayload) {
        if (!this._hasPhaseTelemetry(overview, "grid_power")) {
            return html`<p class="note">${this._t("phases.no_profile_long")}</p>`;
        }
        const readings = this._phaseReadings(overview);
        const limit = this._number(overview, "main_breaker_limit");
        return html`
            ${readings.map((reading) => html`
                <div class="row" data-phase-current=${reading.phase}>
                    <span class="label"><span class="swatch" style="background: ${PHASE_COLORS[reading.phase]}"></span>L${reading.phase}
                        <span data-power>${reading.power === null ? this._t("unavailable") : this._directedPower(reading.power)}</span></span>
                    <span class="value" data-current>${this._currentText(reading, limit)}</span>
                </div>
            `)}
            <p class="note" data-phase-scale>${limit !== null && limit > 0
                ? fillTemplate(this._t("phases.scale_limit"), { limit: this._amps(limit), voltage: NOMINAL_VOLTAGE + " V" })
                : fillTemplate(this._t("phases.scale_power"), { power: formatPower(this._phaseScaleW(overview, readings)).display })}</p>
            <p class="note">${this._t("phases.explain")}</p>
        `;
    }

    private _currentText(reading: PhaseReading, limit: number | null): string {
        if (reading.power === null) return this._t("unavailable");
        if (reading.current === null) return this._t("phases.current_unknown");
        if (limit !== null && limit > 0) return fillTemplate(this._t("phases.current_of_limit"), { current: this._amps(reading.current), limit: this._amps(limit) });
        return fillTemplate(this._t("phases.current_only"), { current: this._amps(reading.current) });
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
            <div class="plan" data-money-inspector>${this._inspector("money", GRID_MONEY_INSPECTOR_CONFIG)}</div>
            <p class="note">${this._t("money.valuation")}</p>
        `;
    }

    // Next --------------------------------------------------------------------

    /** The import and export rates now, each as its short phrase; none without the forecast or a rate. */
    private _pricesNow(): string[] {
        const grid = this._forecast?.grid;
        if (!grid) return [];
        const parts: string[] = [];
        const importNow = this._priceNow("import");
        const exportNow = this._priceNow("export");
        if (importNow !== null) parts.push(fillTemplate(this._t("next.import_short"), { price: this._price(importNow, grid.importPriceUnit) }));
        if (exportNow !== null) parts.push(fillTemplate(this._t("next.export_short"), { price: this._price(exportNow, grid.exportPriceUnit) }));
        return parts;
    }

    private _nextPreview(): string | null {
        if (!this._forecast?.grid) return null;
        const parts = this._pricesNow();
        return parts.length ? parts.join(" · ") : this._t("next.no_prices");
    }

    private _renderNext() {
        const grid = this._forecast?.grid;
        if (!grid) return this._forecastFailed ? this._renderForecastFailed() : html`<p class="note">${this._t("next.unavailable")}</p>`;
        const importNext = this._nextPriceChange("import");
        const exportNext = this._nextPriceChange("export");
        const planned = this._plannedNow();
        const change = this._plannedChange();
        const priceRow = (label: string, value: number | null, unit: string | null, key: string) =>
            this._row(label, value === null ? this._t("next.no_rate") : this._price(value, unit), key);
        const changeRow = (label: string, next: { at: number; value: number } | null, unit: string | null, key: string) =>
            this._row(label, next ? fillTemplate(this._t("next.change_value"), { price: this._price(next.value, unit), time: this._time(next.at) }) : this._t("next.no_change"), key);
        return html`
            ${priceRow(this._t("next.import_now"), this._priceNow("import"), grid.importPriceUnit, "import-now")}
            ${changeRow(this._t("next.import_next"), importNext, grid.importPriceUnit, "import-next")}
            ${priceRow(this._t("next.export_now"), this._priceNow("export"), grid.exportPriceUnit, "export-now")}
            ${changeRow(this._t("next.export_next"), exportNext, grid.exportPriceUnit, "export-next")}
            ${this._row(this._t("next.planned_now"), planned ?? this._t("next.no_plan"), "planned-now")}
            ${change ? this._row(this._t("next.planned_change"), change, "planned-change") : nothing}
            <p class="note">${this._t(grid.scheduleAdjusted ? "next.explain_adjusted" : "next.explain")}</p>
        `;
    }

    private _renderNextEvidence() {
        return html`
            <div class="plan" data-plan-inspector>${this._inspector("next", GRID_PLAN_INSPECTOR_CONFIG)}</div>
            <p class="note">${this._t("next.evidence_note")}</p>
        `;
    }

    /** The first future price point that differs from the current rate. */
    /**
     * The rate in force now, from the timestamped points so it advances at a
     * tariff boundary while the dialog stays open; the payload's current
     * price only before the first point.
     */
    private _priceNow(side: "import" | "export"): number | null {
        const grid = this._forecast?.grid;
        if (!grid) return null;
        const points = side === "import" ? grid.importPricePoints : grid.exportPricePoints;
        const now = Date.now();
        let current = side === "import" ? grid.currentImportPrice : grid.currentExportPrice;
        for (const point of points) {
            if (Date.parse(point.timestamp) > now) break;
            current = point.value;
        }
        return current;
    }

    private _nextPriceChange(side: "import" | "export"): { at: number; value: number } | null {
        const grid = this._forecast?.grid;
        if (!grid) return null;
        const current = this._priceNow(side);
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

    /**
     * The rate now, the next change and the planned flow are read off the
     * clock: the now-clock renders again once the next price point or plan slot
     * boundary passes, and at least every few minutes for the day's rollover
     * and money.
     */
    protected *_clockBoundaries(): Iterable<number> {
        const grid = this._forecast?.grid;
        for (const point of [...(grid?.importPricePoints ?? []), ...(grid?.exportPricePoints ?? [])]) {
            yield Date.parse(point.timestamp);
        }
        for (const slot of grid?.series ?? []) {
            yield Date.parse(slot.timestamp) + slot.durationHours * 3_600_000;
        }
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
            ${exportLimit !== null ? this._row(this._t("outage.export_limit"), formatPower(exportLimit).display, "export-limit", this._t("outage.scope_inverter"), overview.entities.export_limit) : nothing}
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

    /** Whether the profile maps any phase of `prefix` (`grid_power`, `ac_voltage`). */
    private _hasPhaseTelemetry(overview: GridDetailPayload, prefix: string): boolean {
        return PHASES.some((phase) => `${prefix}_l${phase}` in overview.entities);
    }

    // ── Formatting ──────────────────────────────────────────────────────────

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
