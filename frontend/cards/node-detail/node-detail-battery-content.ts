import { formatKwh, formatMoney, formatPower } from "../shared/format";
import { css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { fillTemplate } from "../localize/localize";
import type {
    BatteryChargeDTO,
    BatteryChargeSectionPayload,
    BatteryDetailPayload,
    InverterDetailPayload,
    InverterRuntimeDTO,
} from "../helman-api";
import { getSharedHelmanStore } from "../shared/data/store";
import { dispatchWatchedEntities } from "../shared/hass-change";
import { SectionResource } from "./section-resource";
import { currencyFromPriceUnit } from "../helman-solar-inspector/money-model";

import "../shared/soc-glyph";
import type { SocDirection } from "../shared/soc-glyph";
import { getScheduleActionTone, scheduleActionToneStyles } from "../shared/schedule/action-tones";
import { INVERTER_CONTROLLABLE_ID } from "../shared/schedule/schedule-types";
import { IDLE_W, NodeDetailContentBase, type NodeFlow } from "./node-detail-base";
import { INVERTER_PLAN_INSPECTOR_CONFIG, inverterModeLabel } from "./node-detail-inverter-content";
import { readEnergyKWh, readingNumber } from "./node-detail-readings";
import { readReserve, type Reserve } from "./battery-reserve";
import {
    currentRun,
    inverterRuns,
    nextChange,
    renderCurrentSlot,
    runtimeFor,
    runtimeText,
} from "./node-detail-schedule";
import { nodeDetailPictureStyles, nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";
import { helmanColorVars } from "../color-vars";
import type { BatteryDetailParams } from "./node-detail-types";
import { NODE_DETAIL_REQUEST_EVENT } from "./node-detail-types";
import "../helman-simple/simple-card-battery";
import "./detail-headline";
import "./flow-gauge";
import "./help-tip";

type QuestionId = "reserve" | "next" | "limits" | "charge" | "diagnostics";

/** Within this share of the lowest known ceiling, the power is "at" it. */
const AT_CEILING = 0.95;

/** A battery colder than this gets an observation, never a verdict. */
const COLD_C = 10;

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
 * the diagnostics tell.
 *
 * The Overview opens on the SoC headline (the battery glyph with its reserve
 * range when known, the charge or discharge power and the range as caption),
 * then the time at the recent rate, the flow gauge, a notice when a ceiling
 * binds, and the tile naming the inverter and the mode it runs now.
 *
 * Live readings come from `hass` and the live flow from the card; the backend
 * overview supplies the entity ids, the configured ceilings and the throughput
 * cycles. The plan comes from the shared schedule owner, the planned SoC from
 * the forecast once its question opens, today's flows from the `flows`
 * section once Today is chosen, and today's charge origin from the `charge`
 * section, requested only while its question is open. Nothing here is a
 * health verdict: the hardware's state-of-health reading is not used.
 */
@customElement("node-detail-battery-content")
export class NodeDetailBatteryContent extends NodeDetailContentBase<BatteryDetailPayload, QuestionId> {
    static styles = [helmanColorVars, nodeDetailSharedStyles, nodeDetailQuestionStyles, nodeDetailPictureStyles, scheduleActionToneStyles, css`
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
    /** Today's charge, while its answer is open. */
    private readonly _charge = this._section<BatteryChargeSectionPayload>("charge", {
        fetch: () => this._readSection("charge"),
        shown: () => this._open === "charge",
    });

    /** The mode the inverter reports, read from its own overview and re-read when its mode registers change. */
    private _inverterStates = "";
    private readonly _inverter: SectionResource<InverterDetailPayload> = this._section("inverter", {
        fetch: async () => {
            const payload = await getSharedHelmanStore(this.hass).getNodeDetail<InverterDetailPayload>({ node: "inverter" }, { fresh: true });
            this._inverterStates = this._inverterSignature(payload);
            dispatchWatchedEntities(this, "node-detail", this._inverterEntities(payload));
            return payload;
        },
        shown: () => true,
        keepOnError: true,
        staleness: (payload) => payload === null || this._inverterSignature(payload) !== this._inverterStates,
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

    // ── Disclosure ──────────────────────────────────────────────────────────

    protected _setOpen(id: QuestionId | null): void {
        super._setOpen(id);
        if (id === "next") void this._loadForecast();
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    render() {
        const notReady = this._renderNotReady();
        if (notReady || this._overview.status !== "ready") return notReady;
        const overview = this._overview.payload;
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
                <helman-flow-gauge .direction=${direction === "charge" ? "from" : "to"} .localize=${this.localize}
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

    /** The open question's answer and evidence, full width under the tiles. */
    protected _renderOpen(overview: BatteryDetailPayload, reserve: Reserve | null) {
        switch (this._open) {
            case "reserve":
                return this._question("reserve", this._reservePreview(reserve), () => this._renderReserve(overview, reserve), () => this._renderReserveEvidence(overview, reserve), "evidence");
            case "next":
                return this._question("next", this._nextPreview(), () => this._renderNext(overview), () => this._renderNextEvidence(), "evidence");
            case "limits":
                return this._question("limits", this._limitsPreview(overview), () => this._renderLimits(overview), () => this._renderLimitsEvidence(overview), "technical");
            case "charge":
                return this._question("charge", this._chargePreview(overview), () => this._renderCharge(), () => this._renderChargeEvidence(overview), "evidence");
            case "diagnostics":
                return this._question("diagnostics", this._diagnosticsPreview(overview), () => this._renderDiagnostics(overview), () => this._renderDiagnosticsEvidence(overview), "technical");
            default:
                return nothing;
        }
    }

    /** At most one exception: a BMS state or run mode the hardware reports. */
    private _renderException(overview: BatteryDetailPayload) {
        const condition = overview.condition;
        return condition ? this._exceptionBanner(fillTemplate(this._t(`exception.${condition.kind}`), { state: condition.state })) : nothing;
    }

    /** Which way the battery's power moves now; idle without a reading. */
    private _direction(): SocDirection {
        const power = this.params.power;
        if (power === null || Math.abs(power) <= IDLE_W) return "idle";
        return power > 0 ? "charge" : "discharge";
    }

    // Flow --------------------------------------------------------------------

    /**
     * Solar and grid in, house and grid out, around the SoC glyph: live from
     * the card on Now, today's kWh from the `flows` section on Today. The
     * glyph opens the reserve; the flow opens today's charge.
     */
    protected _renderBatteryFlow(overview: BatteryDetailPayload, reserve: Reserve | null) {
        const flow = this._flowScope === "now" ? this._nowFlow() : this._todayFlow(overview);
        const soc = this._number(overview, "soc");
        return this._renderFlow(flow, this.params.flowScaleW, "charge", html`
            <button
                slot="centre"
                class="glyph"
                data-glyph
                aria-label=${this._t("q.reserve")}
                aria-expanded=${this._open === "reserve" ? "true" : "false"}
                @click=${() => this._setOpen(this._open === "reserve" ? null : "reserve")}
            >
                <helman-soc-glyph
                    .soc=${soc !== null && soc >= 0 && soc <= 100 ? soc : null}
                    .min=${reserve?.minSoc ?? null}
                    .max=${reserve?.maxSoc ?? null}
                    .usableLabel=${reserve?.usableKwh != null ? (formatKwh(Math.abs(reserve.usableKwh)) + " kWh") : null}
                    .roomLabel=${reserve?.roomKwh != null ? (formatKwh(Math.abs(reserve.roomKwh)) + " kWh") : null}
                    .minLabel=${reserve?.minSoc != null ? fillTemplate(this._t("glyph.min"), { soc: this._percent(reserve.minSoc) }) : null}
                    .maxLabel=${reserve?.maxSoc != null ? fillTemplate(this._t("glyph.max"), { soc: this._percent(reserve.maxSoc) }) : null}
                    .direction=${this._direction()}
                ></helman-soc-glyph>
            </button>
        `);
    }

    /** The card's live split, W; unknown without the solar or battery reading, never 0. */
    private _nowFlow(): NodeFlow {
        const flows = this.params.flows;
        const power = this._fmt("now");
        const inputs = this._edgeItems(flows, [["solar", "solarToBattery"], ["grid", "gridToBattery"]], power);
        const outputs = this._edgeItems(flows, [["house", "batteryToHouse"], ["grid", "batteryToGrid"]], power);
        return this._flowShell("now", inputs, outputs, {
            centre: () => this._directedPower(),
            active: this._isActive(this.params.power),
        });
    }

    /** The battery's power now, ↑ charging and ↓ discharging, as the card's battery shows it; `null` without a reading. */
    private _directedPower(): string | null {
        const power = this.params.power;
        if (power === null) return null;
        const display = formatPower(Math.abs(power)).display;
        const direction = this._direction();
        return direction === "charge" ? `↑ ${display}` : direction === "discharge" ? `↓ ${display}` : display;
    }

    /**
     * Today's kWh from the `flows` section: the grid charge carries its paid
     * cost, an estimate, and the footnote the net change by the battery's own
     * meters and any charge of unknown origin, never forced into a source.
     */
    private _todayFlow(overview: BatteryDetailPayload): NodeFlow {
        const payload = this._flows.payload;
        const flows = payload?.flows ?? null;
        const energy = this._fmt("today");
        const cost = flows?.gridToBatteryCost;
        const [solar, grid] = this._edgeItems(flows, [["solar", "solarToBattery"], ["grid", "gridToBattery"]], energy);
        const inputs = [
            solar,
            {
                ...grid,
                note: cost != null && (flows?.gridToBattery ?? 0) > 0
                    ? fillTemplate(this.localize("node_detail.flow.paid_estimate"), { value: this._formatMoney(cost, currencyFromPriceUnit(payload!.priceUnit)) })
                    : null,
            },
        ];
        const outputs = this._edgeItems(flows, [["house", "batteryToHouse"], ["grid", "batteryToGrid"]], energy);
        const status = this._todayFlowsNote();
        const notes: string[] = status ? [status] : [];
        if (flows) {
            if ((flows.unknownToBattery ?? 0) > 0) {
                notes.push(fillTemplate(this._t("flow.unknown_charge"), { kwh: energy(flows.unknownToBattery!) }));
            }
            const charged = readEnergyKWh(this.hass, overview.entities.today_charge);
            const discharged = readEnergyKWh(this.hass, overview.entities.today_discharge);
            if (charged !== null && discharged !== null) {
                const net = charged - discharged;
                notes.push(fillTemplate(this._t("flow.net"), { kwh: (net > 0 ? "+" : net < 0 ? "−" : "") + energy(net) }));
            }
        }
        return this._flowShell("today", inputs, outputs, {
            centre: (sumIn, sumOut) => this._centrePair(sumIn, sumOut, energy),
            notes,
            // The charge of unknown origin is part of what went in.
            unresolvedIn: flows?.unknownToBattery ?? 0,
        });
    }

    // Tiles -------------------------------------------------------------------

    /** The plan's next change, in its action's tone. */
    protected _renderNextTile() {
        const change = nextChange(this._plan.runs, Date.now(), this._timeZone);
        if (!change) return this._tile("next", this._t("tile.no_change"), null, nothing, "neutral");
        return this._tile("next", this._time(change.startMs), this._actionLabel(change.action), nothing, getScheduleActionTone(change.action.kind));
    }

    /**
     * The lowest known ceiling in the direction the battery moves, charge at
     * idle, with the power now against it while it moves.
     */
    protected _renderLimitsTile(overview: BatteryDetailPayload) {
        const direction = this._direction();
        const side = direction === "discharge" ? "discharge" : "charge";
        const lowest = this._lowest(this._ceilings(overview, side));
        if (!lowest) return this._tile("limits", "–", this._t("limits.none"));
        const power = this.params.power;
        const graphic = direction !== "idle" && power !== null ? html`
            <span class="meter action-tone-${direction}" data-limits-meter>
                <span class="meter-fill" style="width: ${Math.min(100, Math.abs(power) / lowest.watts * 100).toFixed(1)}%"></span>
            </span>
        ` : nothing;
        return this._tile("limits", "≤ " + formatPower(lowest.watts).display, this._t(`tile.limits_${side}`), graphic);
    }

    /** Temperature, the cell voltage gap from the highest and lowest cell, and cycles. */
    protected _renderDiagnosticsTile(overview: BatteryDetailPayload) {
        const parts: string[] = [];
        const high = this._volts(overview, "cell_voltage_high");
        const low = this._volts(overview, "cell_voltage_low");
        if (high !== null && low !== null && high >= low) {
            parts.push(fillTemplate(this._t("diagnostics.gap_short"), { gap: Math.round((high - low) * 1000) + " mV" }));
        }
        const cycles = overview.cycles.cycles;
        if (cycles !== null) parts.push(fillTemplate(this._t("diagnostics.cycles_short"), { cycles: cycles.toFixed(0) }));
        const temperature = this._reading(overview, "battery_temperature");
        if (temperature === null && !parts.length) return this._tile("diagnostics", "–", this._t("diagnostics.none"));
        return this._tile("diagnostics", temperature ?? "–", parts.join(" · ") || null);
    }

    // Reserve -----------------------------------------------------------------

    private _reservePreview(reserve: Reserve | null): string {
        if (!reserve) return this._t("reserve.unavailable");
        const parts: string[] = [];
        if (reserve.usableKwh !== null) parts.push(fillTemplate(this._t("reserve.usable_short"), { kwh: (formatKwh(Math.abs(reserve.usableKwh)) + " kWh"), floor: this._percent(reserve.minSoc!) }));
        if (reserve.roomKwh !== null) parts.push(fillTemplate(this._t("reserve.room_short"), { kwh: (formatKwh(Math.abs(reserve.roomKwh)) + " kWh"), ceiling: this._percent(reserve.maxSoc!) }));
        return parts.length ? parts.join(" · ") : this._t("reserve.no_range");
    }

    private _renderReserve(overview: BatteryDetailPayload, reserve: Reserve | null) {
        if (!reserve) return html`<p class="note">${this._t("reserve.unavailable_long")}</p>`;
        const unknown = this._t("unknown");
        const estimate = this._estimate(overview);
        return html`
            ${this._row(fillTemplate(this._t("reserve.usable"), { floor: reserve.minSoc === null ? "?" : this._percent(reserve.minSoc) }),
                reserve.usableKwh === null ? unknown : (formatKwh(Math.abs(reserve.usableKwh)) + " kWh"), "usable")}
            ${this._row(fillTemplate(this._t("reserve.room"), { ceiling: reserve.maxSoc === null ? "?" : this._percent(reserve.maxSoc) }),
                reserve.roomKwh === null ? unknown : (formatKwh(Math.abs(reserve.roomKwh)) + " kWh"), "room")}
            ${this._row(this._t("reserve.range"), (reserve.minSoc === null ? "?" : this._percent(reserve.minSoc)) + " – " + (reserve.maxSoc === null ? "?" : this._percent(reserve.maxSoc)), "soc-range", this._t("reserve.range_scope"))}
            ${this._row(this._t("reserve.time"), estimate ? estimate.text : this._t("reserve.no_estimate"), "time")}
            <p class="note">${this._t("reserve.explain")}</p>
        `;
    }

    private _renderReserveEvidence(overview: BatteryDetailPayload, reserve: Reserve | null) {
        const minutes = Math.round(this.params.historyBuckets * this.params.historyBucketDuration / 60);
        return html`
            ${reserve ? this._row(this._t("reserve.capacity"), fillTemplate(this._t("reserve.capacity_value"), {
                capacity: (formatKwh(Math.abs(reserve.capacityKwh)) + " kWh"),
                remaining: (formatKwh(Math.abs(reserve.remainingKwh)) + " kWh"),
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
        const change = nextChange(this._plan.runs, Date.now(), this._timeZone);
        return change
            ? fillTemplate(this._t("next_change"), { time: this._time(change.startMs), action: this._actionLabel(change.action) })
            : this._t("next.no_change");
    }

    private _renderNext(overview: BatteryDetailPayload) {
        const soc = this._number(overview, "soc");
        const run = currentRun(this._plan.runs, Date.now());
        const change = nextChange(this._plan.runs, Date.now(), this._timeZone);
        const planned = this._plannedSlot();
        return html`
            ${this._row(this._t("next.soc_now"), soc === null ? this._t("unavailable") : this._percent(soc), "soc-now", undefined, overview.entities.soc)}
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
        const runtime = runtimeFor<InverterRuntimeDTO>(this._plan.schedule, INVERTER_CONTROLLABLE_ID, Date.now());
        return html`
            ${renderCurrentSlot(currentRun(this._plan.runs, Date.now()), runtime, this.localize, (label, value) => this._row(label, value))}
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
        const section = this._charge.payload;
        const charge = section?.charge;
        if (charge) {
            if (charge.chargedKwh <= 0) return this._t("charge.none_today");
            const parts = [fillTemplate(this._t("charge.charged_short"), { kwh: (formatKwh(Math.abs(charge.chargedKwh)) + " kWh") })];
            const cost = charge.paidCost;
            if (cost !== null) parts.push(fillTemplate(this._t("charge.paid_short"), { value: this._formatMoney(cost, currencyFromPriceUnit(section!.priceUnit)) }));
            return parts.join(" · ");
        }
        // Before the answer opens: today's charge from the battery's own meter.
        const kwh = readEnergyKWh(this.hass, overview.entities.today_charge);
        if (kwh === null) return null;
        return kwh <= 0 ? this._t("charge.none_today") : fillTemplate(this._t("charge.charged_short"), { kwh: (formatKwh(Math.abs(kwh)) + " kWh") });
    }

    private _renderCharge() {
        const section = this._charge.state;
        if (section === null || section.status === "loading") {
            return html`<p class="note" data-charge-loading>${this._t("charge.loading")}</p>`;
        }
        if (section.status === "error") {
            return html`
                <p class="note">${this._t("charge.failed")}</p>
                <button class="link-button" @click=${() => this._charge.load()}>${this._t("retry")}</button>
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
            kwh: (formatKwh(Math.abs(kwh)) + " kWh"),
            share: this._percent(kwh / charge.chargedKwh * 100),
        });
        return html`
            ${period}
            ${this._row(this._t("charge.charged"), (formatKwh(Math.abs(charge.chargedKwh)) + " kWh"), "charged")}
            ${this._row(this._t("charge.from_solar"), share(charge.solarKwh), "solar")}
            ${this._row(this._t("charge.from_grid"), share(charge.gridKwh), "grid")}
            ${charge.unknownKwh > 0 ? this._row(this._t("charge.from_unknown"), share(charge.unknownKwh), "unknown") : nothing}
            ${this._row(this._t("charge.paid"), charge.paidCost === null ? this._t("unknown") : this._formatMoney(charge.paidCost, currencyFromPriceUnit(payload.priceUnit)), "paid", this._t("charge.paid_scope"))}
            ${this._row(this._t("charge.coverage"), this._coverageText(charge), "coverage")}
            <p class="note">${this._t("charge.explain")}</p>
        `;
    }

    /** The grid charge's priced share; solar charge costs nothing to pay. */
    private _coverageText(charge: BatteryChargeDTO): string {
        if (charge.gridKwh <= 0) return this._t("charge.coverage_no_grid");
        return fillTemplate(this._t("charge.coverage_grid"), {
            share: this._percent(Math.min(1, charge.gridPricedKwh / charge.gridKwh) * 100),
            kwh: (formatKwh(Math.abs(charge.gridKwh)) + " kWh"),
        });
    }

    private _renderChargeEvidence(overview: BatteryDetailPayload) {
        const payload = this._charge.payload;
        const charge = payload?.charge;
        const input = readEnergyKWh(this.hass, overview.entities.today_charge);
        const output = readEnergyKWh(this.hass, overview.entities.today_discharge);
        const unit = payload?.priceUnit ?? null;
        return html`
            ${charge && charge.chargedKwh > 0 ? html`
                ${this._row(this._t("charge.paid_rate"), charge.paidRate === null ? this._t("unknown") : formatMoney(charge.paidRate, unit), "paid-rate")}
                ${charge.gridUnpricedKwh > 0 ? this._row(this._t("charge.grid_unpriced"), (formatKwh(Math.abs(charge.gridUnpricedKwh)) + " kWh"), "grid-unpriced") : nothing}
                ${charge.solarKwh > 0 ? this._row(this._t("charge.forgone"), charge.forgoneValue === null ? this._t("unknown") : this._formatMoney(charge.forgoneValue, currencyFromPriceUnit(unit)), "forgone", this._t("charge.forgone_scope")) : nothing}
                ${charge.forgoneRate !== null ? this._row(this._t("charge.forgone_rate"), formatMoney(charge.forgoneRate, unit), "forgone-rate") : nothing}
                <p class="note">${this._t("charge.attribution_note")}</p>
            ` : nothing}
            <div class="section-title">${this._t("charge.meters")}</div>
            ${this._row(this._t("charge.input_today"), input === null ? this._t("unavailable") : (formatKwh(Math.abs(input)) + " kWh"), "input-today", undefined, overview.entities.today_charge)}
            ${this._row(this._t("charge.output_today"), output === null ? this._t("unavailable") : (formatKwh(Math.abs(output)) + " kWh"), "output-today", undefined, overview.entities.today_discharge)}
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
                ? fillTemplate(this._t("diagnostics.cycles_note"), { capacity: (formatKwh(Math.abs(cycles.capacityKwh)) + " kWh") })
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
            ${cycles.inputKwh !== null ? this._row(this._t("diagnostics.lifetime_in"), (formatKwh(Math.abs(cycles.inputKwh)) + " kWh"), "lifetime-in") : nothing}
            ${cycles.outputKwh !== null ? this._row(this._t("diagnostics.lifetime_out"), (formatKwh(Math.abs(cycles.outputKwh)) + " kWh"), "lifetime-out") : nothing}
            ${cycles.capacityKwh !== null ? this._row(this._t("diagnostics.capacity"), (formatKwh(Math.abs(cycles.capacityKwh)) + " kWh"), "capacity") : nothing}
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
