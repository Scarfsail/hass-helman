import { css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { fillTemplate } from "../../localize/localize";
import type {
    BatteryChargeDTO,
    BatteryChargeSectionPayload,
    BatteryDetailPayload,
    ScheduleActionDTO,
    SchedulePayload,
} from "../../helman-api";
import { currencyFromPriceUnit } from "../../helman-solar-inspector/money-model";
import { getSharedHelmanStore } from "../../helman/store";
import { formatPower } from "../../power-format";
import { formatGridEnergy, formatPriceValue } from "../../shared/forecast-value-format";
import { getSharedScheduleOwner } from "../../shared/schedule/schedule-owner";
import { IDLE_W, NodeDetailContentBase, TODAY_REFRESH_MS, type SectionState } from "./node-detail-base";
import { INVERTER_PLAN_INSPECTOR_CONFIG } from "./node-detail-inverter-content";
import { readEnergyKWh, readingNumber } from "./node-detail-readings";
import {
    currentRun,
    currentRuntime,
    nextChange,
    renderCurrentSlot,
    runtimeText,
    scheduleRuns,
    type ScheduleRun,
} from "./node-detail-schedule";
import { nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";
import type { BatteryDetailParams } from "./node-detail-types";

type QuestionId = "reserve" | "next" | "limits" | "charge" | "diagnostics";

/** Within this share of the lowest known ceiling, the power is "at" it. */
const AT_CEILING = 0.95;

/** A battery colder than this gets an observation, never a verdict. */
const COLD_C = 10;

/** The usable reserve, from the same capacity and SoC range as the forecast. */
interface Reserve {
    soc: number;
    remainingKwh: number;
    /** `remaining ÷ SoC`, as `battery_state.read_battery_live_state` computes it. */
    capacityKwh: number;
    minSoc: number | null;
    maxSoc: number | null;
    /** Above the floor, kWh; `null` without a floor. */
    usableKwh: number | null;
    /** Below the ceiling, kWh; `null` without a ceiling. */
    roomKwh: number | null;
}

/** One direction's power ceilings, W; `null` where not known. */
interface Ceilings {
    bms: number | null;
    bmsCurrent: number | null;
    inverter: number | null;
    inverterCurrent: number | null;
    planning: number | null;
}

/**
 * The battery detail: how much energy is left and room to store, what the
 * battery will do next, what limits it, where today's charge came from and what
 * the diagnostics tell, as an overview and five questions.
 *
 * Live readings come from `hass`; the backend overview supplies the entity ids,
 * the configured ceilings and the throughput cycles. The plan comes from the
 * shared schedule owner, the planned SoC from the forecast once its question
 * opens, and today's charge origin from the node detail's `charge` section,
 * requested only while its question is open. Nothing here is a health verdict:
 * the hardware's state-of-health reading is not used.
 */
@customElement("node-detail-battery-content")
export class NodeDetailBatteryContent extends NodeDetailContentBase<BatteryDetailPayload, QuestionId> {
    static styles = [nodeDetailSharedStyles, nodeDetailQuestionStyles, css`
        .muted {
            color: var(--secondary-text-color);
        }
    `];

    protected readonly _node = "battery" as const;

    @property({ attribute: false }) public params!: BatteryDetailParams;

    @state() private _schedule: SchedulePayload | null = null;
    @state() private _charge: SectionState<BatteryChargeSectionPayload> | null = null;

    private _unsubscribeSchedule?: () => void;
    private _chargeRequest = 0;
    private _chargeRequestedAt = 0;
    /** `_runs()` for the update in progress; several answers read it per render. */
    private _runsCache?: ScheduleRun[];

    willUpdate(changed: Map<string, unknown>): void {
        this._runsCache = undefined;
        super.willUpdate(changed);
        // The open charge answer is "today so far": re-read it on a new day, and
        // otherwise at most every few minutes, only while the page is visible.
        if (this._open === "charge" && this._charge?.status === "ready" && !document.hidden
            && (!this._isToday(this._charge.payload.period.start) || Date.now() - this._chargeRequestedAt > TODAY_REFRESH_MS)) {
            void this._loadCharge();
        }
    }

    protected _start(): void {
        this._unsubscribeSchedule = getSharedScheduleOwner(this.hass).subscribe((snapshot) => {
            this._schedule = snapshot.schedule;
        });
        super._start();
    }

    protected _stop(): void {
        this._unsubscribeSchedule?.();
        this._unsubscribeSchedule = undefined;
        this._chargeRequest += 1;
    }

    protected _onDataChanged(): void {
        // The base reloads the overview and a forecast once asked for; the
        // schedule owner reloads itself.
        super._onDataChanged();
        if (this._open === "charge" && this._charge !== null) void this._loadCharge();
    }

    /**
     * The BMS state and run mode the overview's condition was computed from,
     * and the lifetime counters behind its cycle count. The counters step every
     * few minutes; SoC and remaining energy, which move far more often, only
     * refine the capacity and are left out.
     */
    protected _overviewSignature(payload: BatteryDetailPayload): string {
        return [payload.entities.bms_connect_state, payload.entities.run_mode, payload.entities.input_energy_total, payload.entities.output_energy_total]
            .map((id) => (id ? this.hass.states[id]?.state ?? "" : ""))
            .join("|");
    }

    /**
     * The plan's next run, the forecast slot in progress and the open charge
     * answer's refresh are read off the clock: the now-clock renders again once
     * the next of them passes, and at least every few minutes for the day's
     * rollover.
     */
    protected *_clockBoundaries(): Iterable<number> {
        for (const run of this._runs()) {
            yield run.startMs;
            if (run.endMs !== null) yield run.endMs;
        }
        for (const slot of this._forecast?.battery_capacity.series ?? []) {
            yield Date.parse(slot.timestamp) + slot.durationHours * 3_600_000;
        }
    }

    // ── Data ────────────────────────────────────────────────────────────────

    private async _loadCharge(): Promise<void> {
        const request = ++this._chargeRequest;
        // A refresh keeps the answer on screen until the new figures land.
        if (this._charge?.status !== "ready" || !this._isToday(this._charge.payload.period.start)) {
            this._charge = { status: "loading" };
        }
        this._chargeRequestedAt = Date.now();
        try {
            const payload = await getSharedHelmanStore(this.hass)
                .getNodeDetail<BatteryChargeSectionPayload>({ node: "battery", section: "charge" }, { fresh: true });
            if (request !== this._chargeRequest) return;
            this._charge = { status: "ready", payload };
        } catch (error) {
            if (request !== this._chargeRequest) return;
            console.error("node-detail-battery: failed to load today's charge", error);
            if (this._charge?.status !== "ready") this._charge = { status: "error" };
        }
    }

    /** Whether a period that starts at `start` is today in HA's time zone. */

    // ── Disclosure ──────────────────────────────────────────────────────────

    protected _setOpen(id: QuestionId | null): void {
        super._setOpen(id);
        // A closed answer's request is obsolete; it is re-read on reopen.
        this._chargeRequest += 1;
        this._charge = null;
        if (id === "charge") void this._loadCharge();
        if (id === "next") void this._loadForecast();
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    render() {
        const notReady = this._renderNotReady();
        if (notReady || this._overview.status !== "ready") return notReady;
        const overview = this._overview.payload;
        const reserve = this._reserve(overview);
        return html`
            <div class="content">
                ${this._renderSummary(overview, reserve)}
                ${this._question("reserve", this._reservePreview(reserve), () => this._renderReserve(overview, reserve), () => this._renderReserveEvidence(overview, reserve), "evidence")}
                ${this._question("next", this._nextPreview(), () => this._renderNext(overview), () => this._renderNextEvidence(), "evidence")}
                ${this._question("limits", this._limitsPreview(overview), () => this._renderLimits(overview), () => this._renderLimitsEvidence(overview), "technical")}
                ${this._question("charge", this._chargePreview(overview), () => this._renderCharge(), () => this._renderChargeEvidence(overview), "evidence")}
                ${this._question("diagnostics", this._diagnosticsPreview(overview), () => this._renderDiagnostics(overview), () => this._renderDiagnosticsEvidence(overview), "technical")}
            </div>
        `;
    }

    private _renderSummary(overview: BatteryDetailPayload, reserve: Reserve | null) {
        const power = this.params.power;
        const status = power === null
            ? this._t("status.unavailable")
            : Math.abs(power) <= IDLE_W
            ? fillTemplate(this._t("status.idle"), { power: formatPower(Math.abs(power)).display })
            : fillTemplate(this._t(power > 0 ? "status.charging" : "status.discharging"), { power: formatPower(Math.abs(power)).display });

        // The status sentence already says the power and its direction.
        const figures: Array<[string, string, string]> = [];
        const soc = this._number(overview, "soc");
        if (soc !== null) figures.push([this._t("figure.soc"), this._percent(soc), "soc"]);
        if (reserve?.usableKwh != null) {
            figures.push([
                fillTemplate(this._t("figure.usable"), { floor: this._percent(reserve.minSoc!) }),
                formatGridEnergy(reserve.usableKwh),
                "usable",
            ]);
        }

        const next = this._nextLine(overview);
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
                ${next ? html`<p class="next" data-next>${next}</p>` : nothing}
                ${this._renderException(overview)}
            </div>
        `;
    }

    /** The plan's next change; without one, the time estimate while the battery is active. */
    private _nextLine(overview: BatteryDetailPayload): string | null {
        const change = this._nextChange();
        if (change) return fillTemplate(this._t("next_change"), { time: this._time(change.startMs), action: this._actionLabel(change.action) });
        const estimate = this._estimate(overview);
        return estimate && estimate.kind === "time" ? fillTemplate(this._t("next_estimate"), { estimate: estimate.text }) : null;
    }

    /** At most one: a BMS state or run mode the hardware reports. */
    private _renderException(overview: BatteryDetailPayload) {
        const condition = overview.condition;
        if (!condition) return nothing;
        const target: QuestionId = condition.kind === "off_grid" ? "reserve" : "diagnostics";
        return html`
            <div class="exception" role="status" data-exception>
                <span>${fillTemplate(this._t(`exception.${condition.kind}`), { state: condition.state })}</span>
                <button class="link-button" @click=${() => this._setOpen(target)}>${this._t("exception.details")}</button>
            </div>
        `;
    }

    // Reserve -----------------------------------------------------------------

    /**
     * Usable energy above the floor and room below the ceiling, from the live
     * SoC, remaining energy and SoC range with the forecast's own arithmetic:
     * capacity is remaining ÷ SoC, the floor and ceiling are its min and max SoC
     * shares. `null` without a valid SoC and remaining energy.
     */
    private _reserve(overview: BatteryDetailPayload): Reserve | null {
        const soc = this._number(overview, "soc");
        // A remaining energy with no or an unknown unit is not guessed at, as in the forecast.
        const remainingKwh = readEnergyKWh(this.hass, overview.entities.remaining_energy, false);
        if (soc === null || remainingKwh === null || soc <= 0 || soc > 100 || remainingKwh < 0) return null;
        const capacityKwh = remainingKwh / (soc / 100);
        // A zero capacity is a reading that means nothing; the forecast refuses it too.
        if (!(capacityKwh > 0)) return null;
        // Bounds outside 0–100 % or reversed are refused, as by the forecast: no
        // floor or ceiling is shown rather than one that means nothing.
        let minSoc = this._number(overview, "min_soc");
        let maxSoc = this._number(overview, "max_soc");
        const valid = (value: number | null) => value !== null && value >= 0 && value <= 100;
        if (!valid(minSoc)) minSoc = null;
        if (!valid(maxSoc)) maxSoc = null;
        if (minSoc !== null && maxSoc !== null && minSoc > maxSoc) minSoc = maxSoc = null;
        return {
            soc,
            remainingKwh,
            capacityKwh,
            minSoc,
            maxSoc,
            usableKwh: minSoc === null ? null : Math.max(0, remainingKwh - capacityKwh * minSoc / 100),
            roomKwh: maxSoc === null ? null : Math.max(0, capacityKwh * maxSoc / 100 - remainingKwh),
        };
    }

    private _reservePreview(reserve: Reserve | null): string {
        if (!reserve) return this._t("reserve.unavailable");
        const parts: string[] = [];
        if (reserve.usableKwh !== null) parts.push(fillTemplate(this._t("reserve.usable_short"), { kwh: formatGridEnergy(reserve.usableKwh), floor: this._percent(reserve.minSoc!) }));
        if (reserve.roomKwh !== null) parts.push(fillTemplate(this._t("reserve.room_short"), { kwh: formatGridEnergy(reserve.roomKwh), ceiling: this._percent(reserve.maxSoc!) }));
        return parts.length ? parts.join(" · ") : this._t("reserve.no_range");
    }

    private _renderReserve(overview: BatteryDetailPayload, reserve: Reserve | null) {
        if (!reserve) return html`<p class="note">${this._t("reserve.unavailable_long")}</p>`;
        const unknown = this._t("unknown");
        const estimate = this._estimate(overview);
        return html`
            ${this._row(fillTemplate(this._t("reserve.usable"), { floor: reserve.minSoc === null ? "?" : this._percent(reserve.minSoc) }),
                reserve.usableKwh === null ? unknown : formatGridEnergy(reserve.usableKwh), "usable")}
            ${this._row(fillTemplate(this._t("reserve.room"), { ceiling: reserve.maxSoc === null ? "?" : this._percent(reserve.maxSoc) }),
                reserve.roomKwh === null ? unknown : formatGridEnergy(reserve.roomKwh), "room")}
            ${this._row(this._t("reserve.range"), (reserve.minSoc === null ? "?" : this._percent(reserve.minSoc)) + " – " + (reserve.maxSoc === null ? "?" : this._percent(reserve.maxSoc)), "soc-range", this._t("reserve.range_scope"))}
            ${this._row(this._t("reserve.time"), estimate ? estimate.text : this._t("reserve.no_estimate"), "time")}
            <p class="note">${this._t("reserve.explain")}</p>
        `;
    }

    private _renderReserveEvidence(overview: BatteryDetailPayload, reserve: Reserve | null) {
        const minutes = Math.round(this.params.historyBuckets * this.params.historyBucketDuration / 60);
        return html`
            ${reserve ? this._row(this._t("reserve.capacity"), fillTemplate(this._t("reserve.capacity_value"), {
                capacity: formatGridEnergy(reserve.capacityKwh),
                remaining: formatGridEnergy(reserve.remainingKwh),
                soc: this._percent(reserve.soc),
            }), "capacity") : nothing}
            <p class="note">${this._t("reserve.capacity_note")}</p>
            ${this._optionalRow(overview, "chargeable_energy", "reserve.chargeable")}
            ${overview.entities.chargeable_energy && this._reading(overview, "chargeable_energy") !== null
                ? html`<p class="note">${this._t("reserve.chargeable_note")}</p>` : nothing}
            ${this._optionalRow(overview, "use_mode", "reserve.use_mode")}
            <p class="note">${fillTemplate(this._t("reserve.time_note"), { minutes: String(minutes) })}</p>
        `;
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

    // Next --------------------------------------------------------------------

    private _nextPreview(): string {
        const change = this._nextChange();
        return change
            ? fillTemplate(this._t("next_change"), { time: this._time(change.startMs), action: this._actionLabel(change.action) })
            : this._t("next.no_change");
    }

    private _renderNext(overview: BatteryDetailPayload) {
        const soc = this._number(overview, "soc");
        const run = this._currentRun();
        const change = this._nextChange();
        const planned = this._plannedSlot();
        return html`
            ${this._row(this._t("next.soc_now"), soc === null ? this._t("unavailable") : this._percent(soc), "soc-now")}
            ${this._row(this._t("next.planned_soc"), planned
                ? fillTemplate(this._t("next.planned_soc_value"), { soc: this._percent(planned.socPct), time: this._time(planned.endMs) })
                : this._t(this._forecast !== null ? "next.no_plan" : this._forecastFailed ? "next.plan_failed" : "next.loading_plan"), "planned-soc")}
            ${this._forecastFailed ? html`<button class="link-button" @click=${() => this._loadForecast()}>${this._t("retry")}</button>` : nothing}
            ${this._row(this._t("next.scheduled_now"), run
                ? this._actionLabel(run.action) + (run.action.conditionMet === false ? " – " + this._t("next.candidate") : "")
                : this._t("next.nothing_scheduled"), "scheduled")}
            ${this._row(this._t("next.change"), change
                ? fillTemplate(this._t("next.change_value"), { action: this._actionLabel(change.action), time: this._time(change.startMs) })
                : this._t("next.no_change"), "change")}
            <p class="note">${this._t("next.explain")}</p>
            <div class="plan" data-plan>${this._inspector("next", INVERTER_PLAN_INSPECTOR_CONFIG)}</div>
        `;
    }

    private _renderNextEvidence() {
        const runtime = this._currentRuntime();
        return html`
            ${renderCurrentSlot(this._currentRun(), runtime, this.localize, (label, value) => this._row(label, value))}
            ${this._row(this._t("next.executor"), runtime ? runtimeText(runtime, this.localize) : this._t("next.no_runtime"), "executor")}
        `;
    }

    /** The forecast slot in progress: its planned SoC at the slot's end. */
    private _plannedSlot(): { socPct: number; endMs: number } | null {
        const now = Date.now();
        for (const slot of this._forecast?.battery_capacity.series ?? []) {
            const start = Date.parse(slot.timestamp);
            const end = start + slot.durationHours * 3_600_000;
            if (start <= now && now < end) return { socPct: slot.socPct, endMs: end };
        }
        return null;
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

    private _limitsPreview(overview: BatteryDetailPayload): string {
        const charge = this._lowest(this._ceilings(overview, "charge"));
        const discharge = this._lowest(this._ceilings(overview, "discharge"));
        if (!charge && !discharge) return this._t("limits.none");
        const side = (key: string, lowest: { watts: number } | null) =>
            fillTemplate(this._t(key), { power: lowest ? formatPower(lowest.watts).display : "?" });
        return side("limits.charge_short", charge) + " · " + side("limits.discharge_short", discharge);
    }

    /** A temperature reading in °C, converted from °F; `null` without a reading. */
    private _celsius(overview: BatteryDetailPayload, key: string): number | null {
        const value = this._number(overview, key);
        if (value === null) return null;
        const entityId = overview.entities[key];
        const unit = entityId ? this.hass.states[entityId]?.attributes.unit_of_measurement : undefined;
        return unit === "°F" ? (value - 32) * 5 / 9 : value;
    }

    private _renderLimits(overview: BatteryDetailPayload) {
        const temperature = this._celsius(overview, "battery_temperature");
        return html`
            ${this._renderDirection(overview, "charge")}
            ${this._renderDirection(overview, "discharge")}
            ${this._row(this._t("limits.now"), this._bindingText(overview), "binding")}
            ${temperature !== null && temperature < COLD_C ? html`
                <p class="note" data-cold>${fillTemplate(this._t("limits.cold"), { temperature: this._reading(overview, "battery_temperature")! })}</p>
            ` : nothing}
            <p class="note">${this._t(overview.profile ? "limits.explain" : "limits.explain_custom")}</p>
        `;
    }

    private _renderDirection(overview: BatteryDetailPayload, direction: "charge" | "discharge") {
        const ceilings = this._ceilings(overview, direction);
        const volts = this._volts(overview, "battery_voltage");
        const bms = ceilings.bms !== null
            ? fillTemplate(this._t("limits.bms_value"), {
                power: formatPower(ceilings.bms).display,
                current: ceilings.bmsCurrent!.toFixed(1) + " A",
                voltage: volts!.toFixed(1) + " V",
            })
            : this._t(!overview.profile ? "limits.bms_no_profile" : ceilings.bmsCurrent === null ? "limits.bms_not_reported" : "limits.bms_no_voltage");
        return html`
            <div class="section-title">${this._t(`limits.${direction}`)}</div>
            ${this._row(this._t(`limits.bms_${direction}`), bms, `bms-${direction}`)}
            ${ceilings.inverterCurrent !== null ? this._row(this._t("limits.inverter_setting"), ceilings.inverter !== null
                ? fillTemplate(this._t("limits.inverter_value"), { current: ceilings.inverterCurrent.toFixed(1) + " A", power: formatPower(ceilings.inverter).display })
                : ceilings.inverterCurrent.toFixed(1) + " A", `inverter-${direction}`, this._t("limits.scope_inverter")) : nothing}
            ${this._row(this._t("limits.planning"), ceilings.planning !== null ? formatPower(ceilings.planning).display : this._t("limits.not_configured"),
                `planning-${direction}`, this._t("limits.scope_helman"))}
        `;
    }

    /**
     * Whether a ceiling is limiting now: power at the lowest known ceiling is
     * consistent with it, never proof; below every ceiling the actual
     * limiting cause is not known, since the demand or target behind the
     * power is not.
     */
    private _bindingText(overview: BatteryDetailPayload): string {
        const power = this.params.power;
        if (power === null) return this._t("limits.no_power");
        if (Math.abs(power) <= IDLE_W) return this._t("limits.idle");
        const direction = power > 0 ? "charge" : "discharge";
        const lowest = this._lowest(this._ceilings(overview, direction));
        const values = {
            power: formatPower(Math.abs(power)).display,
            ceiling: lowest ? formatPower(lowest.watts).display : "",
            source: lowest ? this._t(`limits.source_${lowest.source}`) : "",
        };
        if (lowest && Math.abs(power) >= AT_CEILING * lowest.watts) {
            return fillTemplate(this._t(`limits.at_ceiling_${direction}`), values);
        }
        return fillTemplate(this._t(`limits.below_${direction}`), values);
    }

    private _renderLimitsEvidence(overview: BatteryDetailPayload) {
        const rows = [
            this._optionalRow(overview, "battery_voltage", "limits.voltage"),
            this._optionalRow(overview, "battery_current", "limits.current"),
            this._optionalRow(overview, "battery_temperature", "limits.temperature"),
            this._optionalRow(overview, "battery_temp_low", "limits.temp_low"),
            this._optionalRow(overview, "battery_temp_high", "limits.temp_high"),
            this._optionalRow(overview, "bms_charge_max_current", "limits.bms_charge_current"),
            this._optionalRow(overview, "bms_discharge_max_current", "limits.bms_discharge_current"),
            this._optionalRow(overview, "bdc_status", "limits.bdc_status"),
            this._optionalRow(overview, "bms_connect_state", "limits.bms_connect"),
            this._optionalRow(overview, "max_charge_rate", "limits.max_charge_rate"),
        ];
        return html`
            ${rows.every((row) => row === nothing) ? html`<p class="note">${this._t("limits.no_readings")}</p>` : rows}
            ${this._reading(overview, "max_charge_rate") !== null ? html`<p class="note">${this._t("limits.max_charge_rate_note")}</p>` : nothing}
            <p class="note">${this._t("limits.calculation")}</p>
        `;
    }

    // Charge ------------------------------------------------------------------

    private _chargePreview(overview: BatteryDetailPayload): string | null {
        const section = this._charge?.status === "ready" ? this._charge.payload : null;
        const charge = section?.charge;
        if (charge) {
            if (charge.chargedKwh <= 0) return this._t("charge.none_today");
            const parts = [fillTemplate(this._t("charge.charged_short"), { kwh: formatGridEnergy(charge.chargedKwh) })];
            const cost = charge.paidCost;
            if (cost !== null) parts.push(fillTemplate(this._t("charge.paid_short"), { value: this._formatMoney(cost, currencyFromPriceUnit(section!.currency)) }));
            return parts.join(" · ");
        }
        // Before the answer opens: today's charge from the battery's own meter.
        const kwh = readEnergyKWh(this.hass, overview.entities.today_charge);
        if (kwh === null) return null;
        return kwh <= 0 ? this._t("charge.none_today") : fillTemplate(this._t("charge.charged_short"), { kwh: formatGridEnergy(kwh) });
    }

    private _renderCharge() {
        const section = this._charge;
        if (section === null || section.status === "loading") {
            return html`<p class="note" data-charge-loading>${this._t("charge.loading")}</p>`;
        }
        if (section.status === "error") {
            return html`
                <p class="note">${this._t("charge.failed")}</p>
                <button class="link-button" @click=${() => this._loadCharge()}>${this._t("retry")}</button>
            `;
        }
        const payload = section.payload;
        const period = this._row(this._t("charge.period_label"), fillTemplate(this._t("charge.period"), { time: this._time(Date.parse(payload.asOf)) }), "period");
        const charge = payload.charge;
        if (!charge) {
            // The house meter is the one thing a user can configure; the rest is
            // said as what it is.
            const reason = payload.unavailable === "no_house_node" ? "charge.unavailable_no_house_node"
                : payload.unavailable === "no_house_meter" ? "charge.unavailable"
                : "charge.unavailable_not_loaded";
            return html`${period}<p class="note" data-charge-unavailable>${this._t(reason)}</p>`;
        }
        if (charge.chargedKwh <= 0) {
            return html`${period}<p class="note" data-no-charge>${this._t("charge.none_long")}</p>`;
        }
        const share = (kwh: number) => fillTemplate(this._t("charge.share"), {
            kwh: formatGridEnergy(kwh),
            share: this._percent(kwh / charge.chargedKwh * 100),
        });
        return html`
            ${period}
            ${this._row(this._t("charge.charged"), formatGridEnergy(charge.chargedKwh), "charged")}
            ${this._row(this._t("charge.from_solar"), share(charge.solarKwh), "solar")}
            ${this._row(this._t("charge.from_grid"), share(charge.gridKwh), "grid")}
            ${charge.unknownKwh > 0 ? this._row(this._t("charge.from_unknown"), share(charge.unknownKwh), "unknown") : nothing}
            ${this._row(this._t("charge.paid"), charge.paidCost === null ? this._t("unknown") : this._formatMoney(charge.paidCost, currencyFromPriceUnit(payload.currency)), "paid", this._t("charge.paid_scope"))}
            ${this._row(this._t("charge.coverage"), this._coverageText(charge), "coverage")}
            <p class="note">${this._t("charge.explain")}</p>
        `;
    }

    /** The grid charge's priced share; solar charge costs nothing to pay. */
    private _coverageText(charge: BatteryChargeDTO): string {
        if (charge.gridKwh <= 0) return this._t("charge.coverage_no_grid");
        return fillTemplate(this._t("charge.coverage_grid"), {
            share: this._percent(Math.min(1, charge.gridPricedKwh / charge.gridKwh) * 100),
            kwh: formatGridEnergy(charge.gridKwh),
        });
    }

    private _renderChargeEvidence(overview: BatteryDetailPayload) {
        const payload = this._charge?.status === "ready" ? this._charge.payload : null;
        const charge = payload?.charge;
        const input = readEnergyKWh(this.hass, overview.entities.today_charge);
        const output = readEnergyKWh(this.hass, overview.entities.today_discharge);
        const unit = payload?.currency ?? null;
        return html`
            ${charge && charge.chargedKwh > 0 ? html`
                ${this._row(this._t("charge.paid_rate"), charge.paidRate === null ? this._t("unknown") : formatPriceValue(charge.paidRate, unit), "paid-rate")}
                ${charge.gridUnpricedKwh > 0 ? this._row(this._t("charge.grid_unpriced"), formatGridEnergy(charge.gridUnpricedKwh), "grid-unpriced") : nothing}
                ${charge.solarKwh > 0 ? this._row(this._t("charge.forgone"), charge.forgoneValue === null ? this._t("unknown") : this._formatMoney(charge.forgoneValue, currencyFromPriceUnit(unit)), "forgone", this._t("charge.forgone_scope")) : nothing}
                ${charge.forgoneRate !== null ? this._row(this._t("charge.forgone_rate"), formatPriceValue(charge.forgoneRate, unit), "forgone-rate") : nothing}
                <p class="note">${this._t("charge.attribution_note")}</p>
            ` : nothing}
            <div class="section-title">${this._t("charge.meters")}</div>
            ${this._row(this._t("charge.input_today"), input === null ? this._t("unavailable") : formatGridEnergy(input), "input-today")}
            ${this._row(this._t("charge.output_today"), output === null ? this._t("unavailable") : formatGridEnergy(output), "output-today")}
            ${input !== null && output !== null && input > 0 ? html`
                ${this._row(this._t("charge.flow_ratio"), (output / input).toFixed(2), "flow-ratio")}
                <p class="note" data-flow-ratio-note>${this._t("charge.flow_ratio_note")}</p>
            ` : nothing}
        `;
    }

    // Diagnostics -------------------------------------------------------------

    private _diagnosticsPreview(overview: BatteryDetailPayload): string {
        const parts: string[] = [];
        const cycles = overview.cycles.cycles;
        if (cycles !== null) parts.push(fillTemplate(this._t("diagnostics.cycles_short"), { cycles: cycles.toFixed(0) }));
        const temperature = this._reading(overview, "battery_temperature");
        if (temperature !== null) parts.push(temperature);
        const gap = this._reading(overview, "cell_voltage_difference");
        if (gap !== null) parts.push(fillTemplate(this._t("diagnostics.gap_short"), { gap }));
        return parts.length ? parts.join(" · ") : this._t("diagnostics.none");
    }

    private _renderDiagnostics(overview: BatteryDetailPayload) {
        const cycles = overview.cycles;
        const low = this._reading(overview, "battery_temp_low");
        const high = this._reading(overview, "battery_temp_high");
        return html`
            ${this._row(this._t("diagnostics.cycles"), cycles.cycles !== null
                ? fillTemplate(this._t("diagnostics.cycles_value"), { cycles: cycles.cycles.toFixed(1) })
                : this._t(`diagnostics.cycles_${cycles.reason ?? "no_counters"}`), "cycles")}
            ${this._optionalRow(overview, "battery_temperature", "diagnostics.temperature")}
            ${low !== null && high !== null ? this._row(this._t("diagnostics.temperature_range"), low + " – " + high, "temperature-range") : nothing}
            ${this._optionalRow(overview, "cell_voltage_difference", "diagnostics.cell_gap")}
            ${this._optionalRow(overview, "bms_connect_state", "diagnostics.bms_connect")}
            <p class="note">${cycles.capacityKwh !== null
                ? fillTemplate(this._t("diagnostics.cycles_note"), { capacity: formatGridEnergy(cycles.capacityKwh) })
                : this._t("diagnostics.cycles_note_no_capacity")}</p>
            <p class="note">${this._t("diagnostics.explain")}</p>
        `;
    }

    private _renderDiagnosticsEvidence(overview: BatteryDetailPayload) {
        const cycles = overview.cycles;
        const period = (n: 1 | 2) => {
            const start = this._reading(overview, `battery_heating_start_${n}`);
            const end = this._reading(overview, `battery_heating_end_${n}`);
            return start !== null && end !== null
                ? this._row(fillTemplate(this._t("diagnostics.heating_period"), { n: String(n) }), start + " – " + end, `heating-${n}`)
                : nothing;
        };
        return html`
            ${cycles.inputKwh !== null ? this._row(this._t("diagnostics.lifetime_in"), formatGridEnergy(cycles.inputKwh), "lifetime-in") : nothing}
            ${cycles.outputKwh !== null ? this._row(this._t("diagnostics.lifetime_out"), formatGridEnergy(cycles.outputKwh), "lifetime-out") : nothing}
            ${cycles.capacityKwh !== null ? this._row(this._t("diagnostics.capacity"), formatGridEnergy(cycles.capacityKwh), "capacity") : nothing}
            ${this._optionalRow(overview, "cell_voltage_high", "diagnostics.cell_high")}
            ${this._optionalRow(overview, "cell_voltage_low", "diagnostics.cell_low")}
            ${this._optionalRow(overview, "battery_type", "diagnostics.type")}
            ${this._optionalRow(overview, "bdc_status", "diagnostics.bdc_status")}
            ${this._optionalRow(overview, "battery_heating", "diagnostics.heating")}
            ${period(1)}
            ${period(2)}
            <p class="note">${this._t("diagnostics.evidence_note")}</p>
        `;
    }

    // ── Schedule ────────────────────────────────────────────────────────────

    private _runs(): ScheduleRun[] {
        return this._runsCache ??= scheduleRuns(this._schedule, Date.now());
    }

    private _currentRun(): ScheduleRun | null {
        return currentRun(this._runs(), Date.now());
    }

    private _currentRuntime() {
        return currentRuntime(this._schedule, Date.now());
    }

    private _nextChange(): ScheduleRun | null {
        return nextChange(this._runs(), Date.now(), this._timeZone);
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
