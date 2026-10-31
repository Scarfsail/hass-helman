import { formatKwh, formatPower } from "../shared/format";
import { css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { fillTemplate } from "../localize/localize";
import type {
    BatteryChargeSectionPayload,
    BatteryDetailPayload,
    InverterDetailPayload,
    InverterRuntimeDTO,
} from "../helman-api";
import { getSharedHelmanStore } from "../shared/data/store";
import { dispatchWatchedEntities } from "../shared/hass-change";
import { NEW_DAY_RETRY_MS, SectionResource } from "./section-resource";
import { currencyFromPriceUnit } from "../helman-solar-inspector/money-model";

import { INVERTER_CONTROLLABLE_ID } from "../shared/schedule/schedule-types";
import { IDLE_W, NodeDetailContentBase } from "./node-detail-base";
import { readEnergyKWh, readingNumber } from "./node-detail-readings";
import { readReserve } from "./battery-reserve";
import { currentRun, inverterModeLabel, inverterRuns, renderCurrentSlot, runtimeFor, runtimeText } from "./node-detail-schedule";
import { nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";
import { helmanColorVars } from "../color-vars";
import type { BatteryDetailParams } from "./node-detail-types";
import { NODE_DETAIL_REQUEST_EVENT } from "./node-detail-types";
import "../helman-simple/simple-card-battery";
import "./detail-headline";
import "./flow-gauge";
import "./help-tip";
import { boldTemplate, unbrokenUnits } from "./detail-section";
import { forecastWhen, renderForecastChart } from "./node-detail-forecast";
import { historyRow, kwhText, sectionNotReady, statTile, subTitle } from "./node-detail-history";
import { modeStripWindow } from "../shared/mode-strip";
import type { DayLinePoint } from "../shared/day-line-chart";
import { SLOT_MS } from "../shared/time/slot-time";

type Direction = "charge" | "discharge" | "idle";

/** Within this share of the lowest known ceiling, the power is "at" it. */
const AT_CEILING = 0.95;

/** The Forecast chart's key moments: full, and the lowest charge. */
const FULL_COLOR = "var(--success-color, #43a047)";
const LOWEST_COLOR = "var(--error-color, #db4437)";

/** A battery colder than this gets an observation, never a verdict. */
const COLD_C = 10;

/** The gap between the highest and the lowest cell, mV, below which the cells are balanced. */
export const CELL_GAP_FINE_MV = 50;

/** One direction's power ceilings, W; `null` where not known. */
interface Ceilings {
    bms: number | null;
    bmsCurrent: number | null;
    inverter: number | null;
    inverterCurrent: number | null;
    planning: number | null;
}

/** Today's lowest and highest battery temperature, from the recorder's statistics. */
interface TemperatureToday {
    min: number | null;
    max: number | null;
}

/**
 * The battery detail.
 *
 * The Overview opens on the SoC headline (the battery glyph with its reserve
 * range when known, the charge or discharge power and the range as caption),
 * then the time at the recent rate, the flow gauge, a notice when a ceiling
 * binds, and the tile naming the inverter and the mode it runs now.
 *
 * History & statistics says what was charged and discharged today, by the
 * battery's own meters (its header), where the charge came from (the
 * `charge` section, read once the section is open) and the battery's health:
 * throughput cycles, the temperature now and today's range (HA's recorder
 * statistics) and the cell gap against {@link CELL_GAP_FINE_MV}. Nothing
 * here is a health verdict: the hardware's state-of-health reading is not used.
 */
@customElement("node-detail-battery-content")
export class NodeDetailBatteryContent extends NodeDetailContentBase<BatteryDetailPayload> {
    static styles = [helmanColorVars, nodeDetailSharedStyles, nodeDetailQuestionStyles, css`
        .muted {
            color: var(--secondary-text-color);
        }
        .estimate {
            margin: 0;
        }
        .notice { background: color-mix(in srgb, var(--warning-color, #ffa600) 16%, var(--card-background-color)); }
        .notice-title { color: var(--warning-color, #ffa600); }
        .inverter-link { min-height: 0; padding: 0; font-weight: inherit; text-decoration: underline; }
        .notice-cause { font-size: 12px; line-height: 1.45; }
    `];

    protected readonly _node = "battery" as const;

    @property({ attribute: false }) public params!: BatteryDetailParams;

    /** The inverter's plan, which the battery follows. */
    private readonly _plan = this._useSchedule(inverterRuns);
    /** Where today's charge came from, once History & statistics is open. */
    private readonly _charge = this._section<BatteryChargeSectionPayload>("charge", {
        fetch: () => this._readSection("charge"),
        shown: () => this._historyOpen && this._offers("charge"),
    });
    /** Today's temperature range, once History & statistics is open; read again with the day's figures. */
    private readonly _temperatureToday = this._section<TemperatureToday>("temperature-today", {
        fetch: () => this._readTemperatureToday(),
        shown: () => this._historyOpen && this._overview.status === "ready" && !!this._overview.payload.entities.battery_temperature,
    });

    /** The mode the inverter reports, read from its own overview and re-read when its mode registers change. */
    private _inverterStates = "";
    private readonly _inverter: SectionResource<InverterDetailPayload> = this._section("inverter", {
        // A refresh compares the states as they are when it is sent: a change while it is in flight re-reads.
        onRequest: () => { const shown = this._inverter.payload; if (shown) this._inverterStates = this._inverterSignature(shown); },
        fetch: async () => {
            const previous = this._inverter.payload;
            const payload = await getSharedHelmanStore(this.hass).getNodeDetail<InverterDetailPayload>({ node: "inverter" }, { fresh: true });
            if (!previous) this._inverterStates = this._inverterSignature(payload);
            dispatchWatchedEntities(this, "node-detail:inverter", this._inverterEntities(payload));
            return payload;
        },
        shown: () => true,
        keepOnError: true,
        // A failed read is retried at the interval a stale day is, not on every render.
        staleness: (payload, requestedAt) => payload === null ? Date.now() - requestedAt > NEW_DAY_RETRY_MS : this._inverterSignature(payload) !== this._inverterStates,
    });

    private _inverterEntities(payload: InverterDetailPayload): string[] {
        return [payload.mode?.entityId, ...payload.agreement.observedFrom].filter((id): id is string => !!id);
    }

    private _inverterSignature(payload: InverterDetailPayload): string {
        return this._inverterEntities(payload).map((id) => this.hass.states[id]?.state ?? "").join("|");
    }

    /**
     * The BMS state and run mode the overview's condition was computed from,
     * and the lifetime counters behind its cycle count. The counters step every
     * few minutes; SoC and remaining energy, which move far more often, only
     * refine the capacity and are left out.
     */
    protected _signatureEntities(payload: BatteryDetailPayload) {
        return [payload.entities.bms_connect_state, payload.entities.run_mode, payload.entities.input_energy_total, payload.entities.output_energy_total];
    }

    /**
     * The forecast slot in progress is read off the clock, as are the plan's
     * runs, which the base follows: the now-clock renders again once the next
     * of them passes, and at least every few minutes for the day's rollover.
     */
    protected *_clockBoundaries(): Iterable<number> {
        for (const slot of this._forecast?.battery_capacity.series ?? []) {
            yield Date.parse(slot.timestamp) + slot.durationHours * 3_600_000;
        }
    }

    protected _start(): void {
        super._start();
        // The Forecast header names the key moments while it is closed.
        void this._loadForecast();
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    protected _renderOverview(overview: BatteryDetailPayload) {
        const reserve = readReserve(this.hass, overview);
        const estimate = this._estimate(overview);
        const power = this.params.power;
        const soc = this._number(overview, "soc");
        const direction = this._direction();
        const flow = this.params.flows;
        const lowest = direction === "idle" ? null : this._lowest(this._ceilings(overview, direction === "charge" ? "charge" : "discharge"));
        const binding = lowest && power !== null && Math.abs(power) >= AT_CEILING * lowest.watts;
        const observed = this._inverter.payload?.agreement.observedOption ?? null;
        return html`
            <div class="content" data-overview>
                ${this._renderException(overview)}
                <helman-detail-headline .value=${soc === null ? "—" : `${Math.round(soc)} %`}
                    .entityId=${overview.entities.soc ?? null}
                    .caption=${[power === null ? "—" : html`<span data-direction style=${direction === "idle" ? "" : `color: var(--helman-${direction})`}>${direction === "charge" ? this.localize("node_detail.shared.charging") : direction === "discharge" ? this.localize("node_detail.shared.discharging") : this.localize("node_detail.shared.idle")} ${formatPower(Math.abs(power)).display}</span>`,
                        fillTemplate(this.localize("node_detail.shared.battery_range"), { floor: reserve?.minSoc ?? "?", ceiling: reserve?.maxSoc ?? "?" })]}>
                    <simple-card-battery slot="icon" .compact=${true} .rangeMarks=${reserve != null} .power=${power ?? 0} .soc=${soc ?? 0}
                        .minSoc=${reserve?.minSoc ?? 0} .maxSoc=${reserve?.maxSoc ?? 100}></simple-card-battery>
                </helman-detail-headline>
                ${estimate?.kind === "time" ? html`
                    <p class="estimate" data-estimate>${estimate.text} <span class="muted">${this.localize("node_detail.shared.battery_recent_rate")}</span><helman-help-tip .explanation=${this.localize("node_detail.shared.battery_rate_help")}></helman-help-tip></p>
                ` : nothing}
                <helman-flow-gauge of="battery" .direction=${direction === "charge" ? "from" : direction === "discharge" ? "to" : "flow"} .localize=${this.localize}
                    .items=${flow ? direction === "charge" ? [
                        { node: "solar", powerW: flow.solarToBattery }, { node: "grid", powerW: flow.gridToBattery },
                    ] : direction === "discharge" ? [
                        { node: "house", powerW: flow.batteryToHouse }, { node: "grid", powerW: flow.batteryToGrid },
                    ] : [] : []}></helman-flow-gauge>
                ${binding ? html`<div class="tile notice" data-binding>
                    <span class="notice-title">${fillTemplate(this.localize(`node_detail.shared.battery_capped_${direction}`), { power: formatPower(lowest.watts).display })}</span>
                    <span class="notice-cause">${lowest.source === "bms" && this._celsius(overview, "battery_temperature") !== null && this._celsius(overview, "battery_temperature")! < COLD_C
                        ? fillTemplate(this.localize("node_detail.shared.battery_cold_cause"), { temperature: this._reading(overview, "battery_temperature") ?? "?" })
                        : this._t(`limits.source_${lowest.source}`)}</span></div>` : nothing}
                <div class="tile" data-inverter-control>
                    <div class="row"><span class="label">${this.localize("node_detail.shared.controlled_through")}</span>
                        <button type="button" class="link-button inverter-link" aria-label=${this.localize("node_detail.shared.battery_inverter")}
                            @click=${() => this.dispatchEvent(new CustomEvent(NODE_DETAIL_REQUEST_EVENT, { detail: { target: "inverter" }, bubbles: true, composed: true }))}>${this.localize("node_detail.shared.the_inverter")}</button></div>
                    <div class="row"><span class="label">${this.localize("node_detail.shared.mode_now_label")}</span>
                        <span class="value">${observed ? inverterModeLabel(this.localize, observed) : "—"}</span></div>
                </div>
            </div>
        `;
    }

    // Forecast ----------------------------------------------------------------

    /**
     * The planned SoC until tomorrow noon and its key moments: when the
     * battery is full, and when it reaches the floor, else its lowest charge.
     */
    protected _renderForecast(overview: BatteryDetailPayload) {
        const pending = this._forecastPending();
        if (pending !== null) return pending;
        const context = this._chartContext;
        const soc = this._socForecast(context.now, this._number(overview, "soc"));
        if (!soc) return nothing;
        const nowText = this.localize("node_detail.shared.now");
        // A limit the battery is at already reads "now", not the next slot's end.
        const time = (ms: number) => ms === context.now ? nowText : forecastWhen(ms, context);
        const about = (ms: number) => ms === context.now ? nowText : `≈ ${time(ms)}`;
        const parts: Array<[string, Record<string, string>]> = [
            ...(soc.full ? [["battery_full", { time: about(soc.full.t) }] as [string, Record<string, string>]] : []),
            soc.floorAt === context.now
                ? ["battery_floor_now", {}]
                : soc.floorAt !== null
                ? ["battery_lasts", { time: time(soc.floorAt) }]
                : soc.lowest.t === context.now
                ? ["battery_lowest_now", { soc: this._percent(soc.lowest.v) }]
                : ["battery_lowest", { soc: this._percent(soc.lowest.v), time: time(soc.lowest.t) }],
        ];
        const template = (key: string) => this.localize(`node_detail.shared.forecast.${key}`);
        const none = template("not_within");
        // The parts join as one phrase, whichever comes first starting it; a narrow header wraps only between them.
        const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
        return this._forecastSection(unbrokenUnits(parts.map(([key, values], index) => boldTemplate(index ? template(key) : capital(template(key)), values))), () => html`
            ${renderForecastChart(context, {
                title: this.localize("node_detail.shared.forecast.battery_chart"),
                help: this.localize("node_detail.shared.forecast.battery_help"),
                series: [
                    { key: "actual", label: this.localize("node_detail.shared.forecast.actual"), color: "var(--helman-battery)", points: soc.actual },
                    ...(soc.history.length ? [{ key: "forecast-history", label: this.localize("node_detail.shared.forecast.forecast"), color: "var(--helman-battery)", points: soc.history, dashed: true }] : []),
                    { key: "planned", label: this.localize("node_detail.shared.forecast.planned"), color: "var(--helman-battery)", points: soc.planned, dashed: true },
                ],
                references: [
                    { value: soc.ceiling, label: this._percent(soc.ceiling) },
                    { value: soc.floor, label: this._percent(soc.floor) },
                ],
                // The floor and the ceiling are the SoC's scale: no ticks of their own.
                ticks: [],
                markers: [
                    ...(soc.full ? [{ ...soc.full, color: FULL_COLOR }] : []),
                    { ...soc.lowest, color: LOWEST_COLOR },
                ],
                formatValue: (value) => this._percent(value),
                entities: overview.entities.soc ? [overview.entities.soc] : [],
            })}
            <div class="rows">
                <div class="row" data-row="full"><span class="label"><span style="color: ${FULL_COLOR}">●</span> ${fillTemplate(this.localize("node_detail.shared.forecast.battery_full_row"), { ceiling: this._percent(soc.ceiling) })}</span>
                    <span class="value">${soc.full ? about(soc.full.t) : none}</span></div>
                <div class="row" data-row="lowest"><span class="label"><span style="color: ${LOWEST_COLOR}">●</span> ${this.localize("node_detail.shared.forecast.battery_lowest_row")}</span>
                    <span class="value">${soc.lowest.t === context.now ? `${this._percent(soc.lowest.v)} ${nowText}` : fillTemplate(this.localize("node_detail.shared.forecast.at"), { value: this._percent(soc.lowest.v), time: time(soc.lowest.t) })}</span></div>
                <div class="row" data-row="floor"><span class="label">${fillTemplate(this.localize("node_detail.shared.forecast.battery_floor_row"), { floor: this._percent(soc.floor) })}</span>
                    <span class="value">${soc.floorAt !== null ? time(soc.floorAt) : none}</span></div>
            </div>
        `);
    }

    /**
     * The forecast's SoC: what it was today (its actual history, joined to the
     * SoC now) and what the plan expects to tomorrow noon, each slot at its
     * end, with the moments the header and the chart name: `now` for a limit
     * the battery is at already. `null` without a planned slot. The SoC now is the
     * live reading, the forecast's own only when that is unavailable.
     */
    private _socForecast(now: number, liveSoc: number | null): {
        actual: DayLinePoint[]; history: DayLinePoint[]; planned: DayLinePoint[]; floor: number; ceiling: number;
        full: DayLinePoint | null; floorAt: number | null; lowest: DayLinePoint;
    } | null {
        const battery = this._forecast?.battery_capacity;
        if (!battery || (battery.status !== "available" && battery.status !== "partial") || (liveSoc ?? battery.currentSoc) === null) return null;
        const end = modeStripWindow(now, this._timeZone).end;
        const current = { t: now, v: (liveSoc ?? battery.currentSoc)! };
        const planned = [current, ...battery.series
            .map((slot) => ({ t: Date.parse(slot.timestamp) + slot.durationHours * 3_600_000, v: slot.socPct, slot }))
            .filter((point) => point.t > now && point.t <= end)];
        if (planned.length < 2) return null;
        const actual: DayLinePoint[] = [];
        for (const slot of battery.actualHistory) {
            const start = Date.parse(slot.timestamp);
            if (!actual.length) actual.push({ t: start, v: slot.startSocPct });
            actual.push({ t: start + SLOT_MS, v: slot.socPct });
        }
        if (actual.length) actual.push(current);
        const floor = battery.minSoc ?? 0;
        const ceiling = battery.maxSoc ?? 100;
        const ahead = planned.slice(1) as Array<DayLinePoint & { slot: (typeof battery.series)[number] }>;
        const atCeiling = (v: number) => v >= ceiling - 0.5;
        const atFloor = (v: number) => v <= floor + 0.5;
        const full = atCeiling(current.v) ? current : ahead.find((point) => point.slot.hitMaxSoc || atCeiling(point.v)) ?? null;
        const empty = atFloor(current.v) ? current : ahead.find((point) => point.slot.hitMinSoc || atFloor(point.v)) ?? null;
        const lowest = ahead.reduce((low, point) => point.v < low.v ? point : low, current);
        return {
            actual,
            // Keep recorded predictions separate so the live anchor cannot join across missing history.
            history: (battery.forecastHistory ?? []).map((slot) => ({ t: Date.parse(slot.timestamp) + SLOT_MS, v: slot.value })),
            planned: planned.map(({ t, v }) => ({ t, v })), floor, ceiling,
            full: full && { t: full.t, v: full.v }, floorAt: empty?.t ?? null, lowest: { t: lowest.t, v: lowest.v },
        };
    }

    // History & statistics -----------------------------------------------------

    /** Today's charge and discharge by the battery's own meters, then where the charge came from and the battery's health. */
    protected _renderHistory(overview: BatteryDetailPayload) {
        const charged = readEnergyKWh(this.hass, overview.entities.today_charge);
        const discharged = readEnergyKWh(this.hass, overview.entities.today_discharge);
        const summary = boldTemplate(this._h("battery_summary"), {
            charged: charged === null ? "—" : `+${formatKwh(charged)}`,
            discharged: discharged === null ? "—" : `−${formatKwh(discharged)} kWh`,
        });
        return this._historySection(summary, () => html`
            ${this._socForecast(Date.now(), this._number(overview, "soc")) ? this._forecastPointer() : nothing}
            ${subTitle(this._h("today"))}
            <div class="rows" data-charge>
                ${historyRow(this._h("charged"), charged === null ? "—" : kwhText(charged), "charged")}
                ${this._renderChargeOrigin()}
                ${historyRow(this._h("discharged"), discharged === null ? "—" : kwhText(discharged), "discharged")}
            </div>
            ${this._renderHealth(overview)}
        `);
    }

    /** Where today's charge came from, indented under it: solar, the grid with what it cost, and any source not known. */
    private _renderChargeOrigin() {
        const notReady = sectionNotReady(this._charge, this.localize);
        if (notReady) return notReady;
        const payload = this._charge.payload!;
        const charge = payload.charge;
        if (!charge) return html`<p class="note" data-charge-unavailable>${this._h("battery_origin_unavailable")}</p>`;
        const paid = charge.paidCost === null ? null : `≈ ${this._formatMoney(charge.paidCost, currencyFromPriceUnit(payload.priceUnit))}`;
        return html`
            ${historyRow(this._h("from_solar"), kwhText(charge.solarKwh), "from-solar", true)}
            ${historyRow(this._h("from_grid"), paid && charge.gridKwh > 0 ? fillTemplate(this._h("kwh_paid"), { kwh: kwhText(charge.gridKwh), money: paid }) : kwhText(charge.gridKwh), "from-grid", true)}
            ${charge.unknownKwh > 0 ? historyRow(this._h("from_unknown"), kwhText(charge.unknownKwh), "from-unknown", true) : nothing}
        `;
    }

    /** Throughput cycles, the temperature now with today's range, and the cell gap against its reference; a figure not known is left out. */
    private _renderHealth(overview: BatteryDetailPayload) {
        const cycles = overview.cycles.cycles;
        const temperature = this._reading(overview, "battery_temperature");
        const today = this._temperatureToday.payload;
        const range = today && today.min !== null && today.max !== null ? `${Math.round(today.min)}–${Math.round(today.max)}` : null;
        const gap = this._cellGapMv(overview);
        if (cycles === null && temperature === null && gap === null) return nothing;
        return html`
            ${subTitle(this._h("health"))}
            <div class="stat-tiles">
                ${cycles !== null ? statTile(String(Math.round(cycles)), this._h("cycles"), "cycles") : nothing}
                ${temperature !== null ? statTile(temperature, range ? fillTemplate(this._h("cells_now_range"), { range }) : this._h("cells_now"), "temperature") : nothing}
                ${gap !== null ? statTile(`${Math.round(gap)} mV`, fillTemplate(this._h("cell_gap"), { fine: CELL_GAP_FINE_MV }), "cell-gap") : nothing}
            </div>
        `;
    }

    /** The gap between the highest and the lowest cell, mV: the BMS's own figure, else high − low. */
    private _cellGapMv(overview: BatteryDetailPayload): number | null {
        const difference = this._volts(overview, "cell_voltage_difference");
        if (difference !== null) return difference * 1000;
        const high = this._volts(overview, "cell_voltage_high");
        const low = this._volts(overview, "cell_voltage_low");
        return high !== null && low !== null && high >= low ? (high - low) * 1000 : null;
    }

    /** Today's lowest and highest battery temperature from HA's long-term statistics; none where it keeps none. */
    private async _readTemperatureToday(): Promise<TemperatureToday> {
        const entityId = this._overview.status === "ready" ? this._overview.payload.entities.battery_temperature : null;
        if (!entityId) return { min: null, max: null };
        const result = await this.hass.callWS<{ min?: number | null; max?: number | null }>({
            type: "recorder/statistic_during_period", statistic_id: entityId, types: ["min", "max"], calendar: { period: "day" },
        });
        return { min: typeof result?.min === "number" ? result.min : null, max: typeof result?.max === "number" ? result.max : null };
    }

    // Technical details ---------------------------------------------------------

    /** The slot in progress and what the executor did. */
    protected _renderTechnical(_overview: BatteryDetailPayload) {
        const now = Date.now();
        const runtime = runtimeFor<InverterRuntimeDTO>(this._plan.schedule, INVERTER_CONTROLLABLE_ID, now);
        return html`
            <div class="rows">
                ${renderCurrentSlot(currentRun(this._plan.runs, now), runtime, this.localize, (label, value) => this._row(label, value))}
                ${this._row(this.localize("node_detail.shared.technical.executor"), runtime ? runtimeText(runtime, this.localize) : this.localize("node_detail.shared.technical.no_runtime"), "executor")}
            </div>
        `;
    }

    /** At most one exception: a BMS state or run mode the hardware reports. */
    private _renderException(overview: BatteryDetailPayload) {
        const condition = overview.condition;
        return condition ? this._exceptionBanner(fillTemplate(this._t(`exception.${condition.kind}`), { state: condition.state })) : nothing;
    }

    /** Which way the battery's power moves now; idle without a reading. */
    private _direction(): Direction {
        const power = this.params.power;
        if (power === null || Math.abs(power) <= IDLE_W) return "idle";
        return power > 0 ? "charge" : "discharge";
    }

    /**
     * Helman's time-to-full or time-to-empty sensor for the direction the
     * battery is moving in: a finish time while active, none while idle.
     */
    private _estimate(overview: BatteryDetailPayload): { kind: "time" | "idle" | "none"; text: string } | null {
        const power = this.params.power;
        if (power === null) return null;
        if (Math.abs(power) <= IDLE_W) return { kind: "idle", text: this._t("reserve.idle_no_time") };
        const entityId = overview.entities[power > 0 ? "time_to_full" : "time_to_empty"];
        const minutes = readingNumber(this.hass, entityId);
        if (minutes === null || minutes <= 0) return { kind: "none", text: this._t("reserve.no_estimate") };
        const attributes = entityId ? this.hass.states[entityId]?.attributes ?? {} : {};
        const target = Number(attributes.target_soc);
        const at = Date.parse(String(attributes.target_time ?? ""));
        const duration = this._duration(minutes);
        const text = fillTemplate(this._t(power > 0 ? "reserve.to_full" : "reserve.to_empty"), {
            duration,
            soc: Number.isFinite(target) ? this._percent(target) : "?",
            time: Number.isFinite(at) ? this._time(at) : "?",
        });
        return { kind: "time", text };
    }

    // Limits ------------------------------------------------------------------

    /**
     * One direction's ceilings. The BMS ceiling is the BMS's allowed current ×
     * the battery voltage now; the inverter's current setting converts at the
     * same voltage, so the two compare; Helman's planning limit is config, W.
     */
    private _ceilings(overview: BatteryDetailPayload, direction: "charge" | "discharge"): Ceilings {
        const volts = this._volts(overview, "battery_voltage");
        const bmsCurrent = this._amps(overview, `bms_${direction}_max_current`);
        const inverterCurrent = this._amps(overview, `battery_${direction}_max_current`);
        const toWatts = (amps: number | null) => amps === null || volts === null || volts <= 0 ? null : amps * volts;
        return {
            bms: toWatts(bmsCurrent),
            bmsCurrent,
            inverter: toWatts(inverterCurrent),
            inverterCurrent,
            planning: direction === "charge" ? overview.configured.maxChargePowerW : overview.configured.maxDischargePowerW,
        };
    }

    /** The lowest known ceiling and which one it is. */
    private _lowest(ceilings: Ceilings): { watts: number; source: "bms" | "inverter" | "planning" } | null {
        let lowest: { watts: number; source: "bms" | "inverter" | "planning" } | null = null;
        for (const source of ["bms", "inverter", "planning"] as const) {
            const watts = ceilings[source];
            if (watts !== null && watts > 0 && (lowest === null || watts < lowest.watts)) lowest = { watts, source };
        }
        return lowest;
    }

    /** A temperature reading in °C, converted from °F; `null` without a reading. */
    private _celsius(overview: BatteryDetailPayload, key: string): number | null {
        const value = this._number(overview, key);
        if (value === null) return null;
        const entityId = overview.entities[key];
        const unit = entityId ? this.hass.states[entityId]?.attributes.unit_of_measurement : undefined;
        return unit === "°F" ? (value - 32) * 5 / 9 : value;
    }

    // ── Readings and formatting ─────────────────────────────────────────────

    /** A current in A, `null` when missing, not numeric or in another unit. */
    private _amps(overview: BatteryDetailPayload, key: string): number | null {
        return this._scaled(overview, key, { A: 1, mA: 0.001 });
    }

    /** A voltage in V, `null` when missing, not numeric or in another unit. */
    private _volts(overview: BatteryDetailPayload, key: string): number | null {
        return this._scaled(overview, key, { V: 1, mV: 0.001 });
    }

    private _percent(value: number): string {
        return Math.round(value) + " %";
    }

}

declare global {
    interface HTMLElementTagNameMap {
        "node-detail-battery-content": NodeDetailBatteryContent;
    }
}
