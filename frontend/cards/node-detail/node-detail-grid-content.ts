import { formatKwh, formatMoney, formatPower } from "../shared/format";
import { phaseSign } from "../shared/power-reading";
import { css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { fillTemplate } from "../localize/localize";
import {
    type GridMoneySectionPayload,
    type GridDetailPayload,
    type GridForecastSlotDTO,
    type GridVoltageSectionPayload,
} from "../helman-api";
import { currencyFromPriceUnit } from "../helman-solar-inspector/money-model";
import { GRID_EXPORT_COLOR, GRID_IMPORT_COLOR, PHASE_COLORS } from "../color-utils";
import { helmanColorVars } from "../color-vars";

import "../shared/day-line-chart";
import type { DayLineBand, DayLineReference, DayLineSeries } from "../shared/day-line-chart";
import { IDLE_W, NodeDetailContentBase } from "./node-detail-base";
import { gridMix } from "./live-flows";
import { boldTemplate } from "./detail-section";
import { nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";
import type { GridDetailParams } from "./node-detail-types";
import "../helman-simple/simple-card-grid";
import "./detail-headline";
import "./flow-gauge";
import "./help-tip";
import { forecastWhen, holdAtSlots, remainingShare, renderForecastChart, type ForecastChartContext } from "./node-detail-forecast";
import { historyRow, historySummary, kwhText, sectionNotReady, subTitle } from "./node-detail-history";
import { modeStripWindow } from "../shared/mode-strip";
import { scheduleReason } from "./node-detail-schedule";
import { SLOT_MS } from "../shared/time/slot-time";

const PHASES = [1, 2, 3] as const;
type Phase = (typeof PHASES)[number];

/** The nominal low-voltage supply and the ±10 % band around it, as references only. */
const NOMINAL_VOLTAGE = 230;
const REFERENCE_BAND = { from: 207, to: 253 };

/** The phase picture's voltage axis: the reference band with room either side, widened to fit any reading. */
const VOLTAGE_AXIS = { from: 200, to: 260 };

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
    /** What the grid earned less what it cost; negative when it cost more. */
    net: number | null;
    currency: string;
    importKwh: number | null;
    exportKwh: number | null;
}

/**
 * The grid detail.
 *
 * The Overview opens on the exchange headline (its direction in the import or
 * export colour), then the gauge of where the power goes or comes from, the
 * price tile and the phase picture.
 *
 * Live readings come from `hass` and the live flow from the card; the backend
 * overview supplies the entity ids. Today's voltages are read on opening, for
 * the picture's ranges and the History chart; today's money on opening too,
 * for the History header; the rates and the plan come from the forecast.
 */
@customElement("node-detail-grid-content")
export class NodeDetailGridContent extends NodeDetailContentBase<GridDetailPayload> {
    static styles = [helmanColorVars, nodeDetailSharedStyles, nodeDetailQuestionStyles, css`
        /* A price moves whole to the next line; only a price wider than the line wraps inside. */
        .price-part { display: inline-block; }
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

    /** Today's measured grid money, for the History header; a failure leaves the money figures out, nothing else. */
    private readonly _money = this._section<GridMoneySectionPayload>("money", {
        fetch: () => this._readSection("money"),
        shown: () => true,
    });
    /** Today's voltages, which the picture's ranges draw, once the overview says there are sensors to read. */
    private readonly _voltage = this._section<GridVoltageSectionPayload>("voltage", {
        fetch: () => this._readSection("voltage"),
        shown: () => this._offers("voltage"),
    });
    private _voltageChart?: {
        payload: GridVoltageSectionPayload;
        series: DayLineSeries[];
        references: DayLineReference[];
        bands: DayLineBand[];
    };

    protected _start(): void {
        super._start();
        void this._loadForecast();
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    protected _renderOverview(overview: GridDetailPayload) {
        const power = this.params.gridPower;
        const importing = power !== null && power >= 0;
        const idle = power !== null && Math.abs(power) <= IDLE_W;
        const flows = this.params.flows;
        const grid = this._forecast?.grid;
        const buy = this._priceNow("import");
        const sell = this._priceNow("export");
        const next = this._nextPriceChange("import");
        const breaker = this._number(overview, "main_breaker_limit");
        return html`
            <div class="content" data-overview>
                ${this._renderException(overview)}
                <helman-detail-headline style=${idle || power === null ? "" : `--detail-headline-color: ${importing ? GRID_IMPORT_COLOR : GRID_EXPORT_COLOR}`}
                    .value=${power === null ? "—" : idle ? formatPower(Math.abs(power)).display : `${importing ? "←" : "→"} ${formatPower(Math.abs(power)).display}`}
                    .entityId=${this.params.powerEntityId}
                    .caption=${[power === null ? this.localize("node_detail.grid.unavailable") : this.localize(`node_detail.shared.grid_${idle ? "idle" : importing ? "importing" : "exporting"}`)]}>
                    <simple-card-grid slot="icon" .compact=${true} .power=${power ?? 0}></simple-card-grid>
                </helman-detail-headline>
                <helman-flow-gauge .direction=${idle || power === null ? "flow" : importing ? "to" : "from"} .localize=${this.localize}
                    .items=${gridMix(flows, power)}></helman-flow-gauge>
                ${grid && (buy !== null || sell !== null) ? html`<div class="tile" data-price>
                    <div class="row"><span class="label">${this.localize("node_detail.shared.grid_price_now")}</span>
                        <span class="value">${[
                            buy !== null ? boldTemplate(this.localize("node_detail.shared.grid_price_buy"), { buy: this._price(buy, grid.importPriceUnit) }) : null,
                            sell !== null ? boldTemplate(this.localize("node_detail.shared.grid_price_sell"), { sell: this._price(sell, grid.exportPriceUnit) }) : null,
                        ].filter((part) => part !== null).map((part, index) => html`${index ? "\u00a0· " : ""}<span class="price-part">${part}</span>`)}</span></div>
                    ${next ? html`<div class="row"><span class="label">${fillTemplate(this.localize("node_detail.shared.grid_next_price"), { time: this._time(next.at) })}</span>
                        <span class="value">${fillTemplate(this.localize("node_detail.shared.grid_price_buy"), { buy: this._price(next.value, grid.importPriceUnit) })}</span></div>` : nothing}
                </div>` : nothing}
                <div class="section-title">${breaker !== null
                    ? fillTemplate(this.localize("node_detail.shared.grid_phases"), { amps: breaker })
                    : this.localize("node_detail.shared.grid_phases_no_breaker")}
                    <helman-help-tip .explanation=${fillTemplate(this.localize("node_detail.shared.grid_phase_help"), { amps: breaker ?? "?" })}></helman-help-tip></div>
                <div class="tile">${this._renderPhasePicture(overview)}</div>
            </div>
        `;
    }

    // Forecast ----------------------------------------------------------------

    /** The buy price to tomorrow noon, its cheapest and dearest stretch, and the grid use the plan expects. */
    protected _renderForecast() {
        const pending = this._forecastPending();
        if (pending !== null) return pending;
        const grid = this._forecast!.grid;
        const context = this._chartContext;
        const end = modeStripWindow(context.now, context.timeZone).end;
        const from = Math.floor(context.now / SLOT_MS) * SLOT_MS;
        // A price holds until the next one, and the last for as long as the one before it did.
        const points = grid.importPricePoints.map((point) => ({ t: Date.parse(point.timestamp), v: point.value }));
        const last = points[points.length - 1];
        const until = last ? last.t + (points.length > 1 ? last.t - points[points.length - 2].t : SLOT_MS) : from;
        const prices = holdAtSlots(points, from, Math.min(until, end) - SLOT_MS);
        if (!prices.length) return nothing;
        const cheapest = extremeStretch(prices, (a, b) => a < b);
        const dearest = extremeStretch(prices, (a, b) => a > b);
        const text = (key: string) => this.localize(`node_detail.shared.forecast.${key}`);
        const stretch = (run: Stretch) => ({ range: forecastWhen(run.start, context, run.end), price: this._price(run.value, grid.importPriceUnit) });
        const summary = boldTemplate(text("grid_summary"), stretch(cheapest));
        return this._forecastSection(summary, () => html`
            ${renderForecastChart(context, {
                title: text("grid_chart"),
                help: text("grid_help"),
                series: [{ key: "buy", label: text("grid_buy"), color: "var(--primary-text-color)", points: prices }],
                spans: [{ start: cheapest.start, end: cheapest.end, color: CHEAPEST_COLOR }],
                step: true,
                formatValue: (value) => this._price(value, grid.importPriceUnit),
            })}
            <div class="rows">
                <div class="row" data-row="dearest"><span class="label">${text("grid_dearest")}</span><span class="value">${fillTemplate(text("grid_stretch"), stretch(dearest))}</span></div>
                <div class="row" data-row="cheapest"><span class="label"><span style="color: ${CHEAPEST_COLOR}">▬</span> ${text("grid_cheapest")}</span><span class="value">${fillTemplate(text("grid_stretch"), stretch(cheapest))}</span></div>
            </div>
            ${this._renderPlannedGridUse(context, end)}
        `);
    }

    /** The plan's grid import and export to tomorrow noon, one row per stretch of one direction. */
    private _renderPlannedGridUse(context: ForecastChartContext, end: number) {
        const text = (key: string) => this.localize(`node_detail.shared.forecast.${key}`);
        const runs: Array<{ start: number; end: number; direction: "import" | "export"; reason: string | null; kwh: number }> = [];
        for (const slot of this._forecast!.grid.series) {
            const start = Date.parse(slot.timestamp);
            const slotEnd = start + slot.durationHours * 3_600_000;
            if (slotEnd <= context.now || start >= end) continue;
            const direction = flowDirection(slot.importedFromGridKwh, slot.exportedToGridKwh);
            if (direction === "balanced") continue;
            // The slot in progress counts only what is still ahead of it.
            const kwh = (direction === "import" ? slot.importedFromGridKwh : slot.exportedToGridKwh) * remainingShare(start, context.now, slot.durationHours * 3_600_000);
            const reason = this._plannedGridReason(slot, direction, text);
            const last = runs[runs.length - 1];
            if (last && last.direction === direction && last.reason === reason && last.end === start) {
                last.end = slotEnd;
                last.kwh += kwh;
            } else {
                runs.push({ start, end: slotEnd, direction, reason, kwh });
            }
        }
        if (!runs.length) return nothing;
        return html`
            <div class="section-title">${text("grid_planned")}</div>
            <div class="rows" data-planned>${runs.map((run) => html`
                <div class="row" data-run=${run.direction}><span><b>${forecastWhen(run.start, context, run.end)}</b></span>
                    <span class="value">${fillTemplate(text(`grid_${run.direction}`), { kwh: `≈ ${formatKwh(run.kwh)} kWh` })}${run.reason ? ` · ${run.reason}` : ""}</span></div>`)}
            </div>
        `;
    }

    /**
     * Why a slot imports or exports: who scheduled it, else the battery limit
     * that forces the flow; `null` when neither does.
     */
    private _plannedGridReason(slot: GridForecastSlotDTO, direction: "import" | "export", text: (key: string) => string): string | null {
        if (slot.setBy || slot.optimizer) return scheduleReason(slot, this.localize);
        if (direction === "import") return slot.hitMinSoc ? text("grid_battery_empty") : null;
        if (slot.hitMaxSoc) return text("grid_battery_full");
        return slot.limitedByChargePower ? text("grid_charge_limit") : null;
    }

    // History & statistics -----------------------------------------------------

    /** Today's bought and sold energy with its money, then today's voltage per phase. */
    protected _renderHistory(_overview: GridDetailPayload) {
        const money = this._moneyFigures();
        const summary = historySummary(this._money, this.localize, money?.importKwh != null ? boldTemplate(this._h("grid_summary"), { kwh: kwhText(money.importKwh) }) : null);
        return this._historySection(summary, () => html`
            ${subTitle(this._h("today"))}
            ${this._renderMoney()}
            ${this._offers("voltage") ? html`
                ${subTitle(this._h("voltage_today"))}
                ${this._renderVoltage()}
            ` : nothing}
        `);
    }

    /** Bought and sold, each with its money, and the net: an estimate from the prices Helman knows. */
    private _renderMoney() {
        const notReady = sectionNotReady(this._money, this.localize);
        if (notReady) return notReady;
        const money = this._moneyFigures()!;
        const side = (kwh: number | null, value: number | null) => [kwh === null ? "—" : kwhText(kwh), value === null ? null : this._formatMoney(value, money.currency)]
            .filter(Boolean).join(" · ");
        return html`<div class="rows" data-money>
            ${historyRow(this._h("bought"), side(money.importKwh, money.cost), "bought")}
            ${historyRow(this._h("sold"), side(money.exportKwh, money.gain), "sold")}
            ${historyRow(html`${this._h("net")}<helman-help-tip .explanation=${this._h("net_help")}></helman-help-tip>`,
                html`<b>${money.net === null ? "—" : (money.net < 0 ? "−" : "") + this._formatMoney(Math.abs(money.net), money.currency)}</b>`, "net")}
        </div>`;
    }

    /** Today's voltage per phase against the nominal and the normal band, and its lowest and highest. */
    private _renderVoltage() {
        const notReady = sectionNotReady(this._voltage, this.localize);
        if (notReady) return notReady;
        const payload = this._voltage.payload!;
        const drawn = PHASES.map((phase) => ({ phase, stats: payload.phases[String(phase) as "1" | "2" | "3"] }))
            .filter(({ stats }) => stats && stats.points.length > 0 && stats.min !== null && stats.max !== null);
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
                references: [{ value: NOMINAL_VOLTAGE, label: `${NOMINAL_VOLTAGE} V` }],
                bands: [{ ...REFERENCE_BAND, label: this._t("voltage.band_label") }],
            };
        }
        const chart = this._voltageChart;
        const low = Math.min(...drawn.map(({ stats }) => stats!.min!));
        const high = Math.max(...drawn.map(({ stats }) => stats!.max!));
        return html`
            <helman-day-line-chart
                data-voltage-chart
                .series=${chart.series}
                .references=${chart.references}
                .bands=${chart.bands}
                .start=${Date.parse(payload.period.start)}
                .end=${Date.parse(payload.period.end)}
                .bucketMs=${drawn[0].stats!.bucketMinutes * 60_000}
                .now=${Date.now()}
                .nowLabel=${this.localize("node_detail.shared.now")}
                .timeZone=${this._timeZone}
                .locale=${this._locale}
                .formatValue=${this._formatVolts}
            ></helman-day-line-chart>
            <div class="rows">${historyRow(this._h("voltage_range"), `${Math.floor(low)}–${Math.ceil(high)} V`, "voltage-range")}</div>
        `;
    }

    // Technical details ---------------------------------------------------------

    /** The export limit and cap now, whether the inverter runs on the grid, and each phase's current against the breaker. */
    protected _renderTechnical(overview: GridDetailPayload) {
        const exportLimit = this._number(overview, "export_limit");
        const runMode = this._reading(overview, "run_mode");
        const state = overview.condition
            ? fillTemplate(this._t(`outage.state_${overview.condition.kind}`), { state: overview.condition.runMode })
            : runMode ? fillTemplate(this._t("outage.state_on_grid"), { state: runMode }) : this._t("outage.state_unknown");
        const limit = this._number(overview, "main_breaker_limit");
        return html`
            <div class="rows">
                ${exportLimit !== null ? this._row(this._t("outage.export_limit"), formatPower(exportLimit).display, "export-limit", this._t("outage.scope_inverter"), overview.entities.export_limit) : nothing}
                ${overview.maxAllowedExportPower !== null ? this._row(this._t("outage.export_cap"), formatPower(overview.maxAllowedExportPower).display, "export-cap", this._t("outage.scope_helman")) : nothing}
                ${this._row(this._t("outage.state"), state, "grid-state")}
            </div>
            ${this._hasPhaseTelemetry(overview, "grid_power") ? html`
                ${subTitle(this.localize("node_detail.shared.technical.phase_currents"))}
                <div class="rows">${this._phaseReadings(overview).map((reading) => this._row(`L${reading.phase}`, this._currentText(reading, limit), `current-l${reading.phase}`))}</div>
            ` : nothing}
        `;
    }

    /** An off-grid or fault run mode the inverter reports. */
    private _renderException(overview: GridDetailPayload) {
        return overview.condition ? this._exceptionBanner(fillTemplate(this._t(`exception.${overview.condition.kind}`), { state: overview.condition.runMode })) : nothing;
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
            return html`<div class="picture" data-phase-picture-none><span class="note">${this._t("phases.no_profile")}</span></div>`;
        }
        const readings = this._phaseReadings(overview);
        const scaleW = this._phaseScaleW(overview, readings);
        const ranges = this._voltage.payload?.phases ?? null;
        const known = [
            ...readings.map((reading) => reading.voltage).filter((value): value is number => value !== null && value > 0),
            ...PHASES.flatMap((phase) => {
                const stats = ranges?.[String(phase) as "1" | "2" | "3"];
                return stats?.min != null && stats.max != null ? [stats.min, stats.max] : [];
            }),
        ];
        const axis = { from: Math.min(VOLTAGE_AXIS.from, ...known), to: Math.max(VOLTAGE_AXIS.to, ...known) };
        return html`
            <div class="picture" data-phase-picture>
                <span class="phases">
                    <span class="phases-head" aria-hidden="true">
                        <span></span>
                        <span class="head-power"><span>${this._t("phases.export_side")}</span><span>${this._t("phases.import_side")}</span></span>
                        <span>${this._t("picture.voltage")}</span>
                    </span>
                    ${readings.map((reading) => this._phaseRow(reading, scaleW, axis, ranges))}
                </span>
            </div>
            ${this._renderRangeStatus(overview)}
        `;
    }

    /** Whether today's voltage ranges are still loading or failed; nothing once they are in. */
    private _renderRangeStatus(overview: GridDetailPayload) {
        if (!overview.sections.includes("voltage")) return nothing;
        const section = this._voltage.state;
        if (section === null || section.status === "loading") {
            return html`<p class="note" data-range-loading>${this._t("picture.range_loading")}</p>`;
        }
        if (section.status === "error") {
            return html`
                <p class="note" data-range-failed>${this._t("picture.range_failed")}</p>
                <button class="link-button" @click=${() => this._voltage.load()}>${this._t("retry")}</button>
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

    // Phases ------------------------------------------------------------------

    private _phaseReadings(overview: GridDetailPayload): PhaseReading[] {
        const sign = phaseSign(overview.phasePowerPolarity);
        return PHASES.map((phase) => {
            const raw = this._number(overview, `grid_power_l${phase}`);
            const voltage = this._number(overview, `ac_voltage_l${phase}`);
            const power = raw === null ? null : raw * sign;
            const current = power !== null && voltage !== null && voltage > 0 ? Math.abs(power) / voltage : null;
            return { phase, power, voltage, current };
        });
    }

    private _currentText(reading: PhaseReading, limit: number | null): string {
        if (reading.power === null) return this._t("unavailable");
        if (reading.current === null) return this._t("phases.current_unknown");
        if (limit !== null && limit > 0) return fillTemplate(this._t("phases.current_of_limit"), { current: this._amps(reading.current), limit: this._amps(limit) });
        return fillTemplate(this._t("phases.current_only"), { current: this._amps(reading.current) });
    }

    // Money -------------------------------------------------------------------

    /** Today's money from the node detail section, `null` while unknown. */
    private _moneyFigures(): MoneyFigures | null {
        const payload = this._money.payload;
        if (!payload) return null;
        const cost = payload.importCost;
        const gain = payload.exportRevenue;
        return {
            cost,
            gain,
            net: cost === null || gain === null ? null : gain - cost,
            currency: currencyFromPriceUnit(payload.priceUnit),
            importKwh: payload.importKwh,
            exportKwh: payload.exportKwh,
        };
    }

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

    private _price(value: number, unit: string | null): string {
        return formatMoney(value, unit);
    }

}

/** The cheapest stretch on the Forecast chart. */
const CHEAPEST_COLOR = "var(--success-color, #43a047)";

/** A stretch of equal prices. */
interface Stretch { start: number; end: number; value: number }

/** The first stretch of consecutive slots at the price `better` than every other, slot by slot. */
function extremeStretch(points: ReadonlyArray<{ t: number; v: number }>, better: (a: number, b: number) => boolean): Stretch {
    const best = points.reduce((winner, point) => better(point.v, winner.v) ? point : winner, points[0]);
    let end = best.t + SLOT_MS;
    for (const point of points) {
        if (point.t === end && point.v === best.v) end += SLOT_MS;
    }
    return { start: best.t, end, value: best.v };
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
