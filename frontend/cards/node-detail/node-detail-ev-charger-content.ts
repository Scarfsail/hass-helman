import { formatKwh, formatPower } from "../shared/format";
import { SLOT_MS } from "../shared/time/slot-time";
import { css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { fillTemplate } from "../localize/localize";
import type {
    ApplianceProjectionsPayload,
    ApplianceRuntimeDTO,
    ApplianceVehicleDTO,
    EvChargerApplianceMetadataDTO,
    EvChargerDetailPayload,
    EvChargerSegmentSectionPayload,
    EvChargerTodaySectionPayload,
    GetNodeDetailRequest,
    ScheduleEvChargerActionDTO,
} from "../helman-api";
import { helmanColorVars } from "../color-vars";
import { currencyFromPriceUnit } from "../helman-solar-inspector/money-model";
import { getSharedHelmanStore } from "../shared/data/store";

import { loadHaEntityToggle } from "../shared/load-ha-elements";
import "../shared/mode-strip";
import { modeStripWindow, type ModeChange, type ModeSegment } from "../shared/mode-strip";
import type { FlowItem } from "../shared/node-flow";
import "../shared/soc-glyph";
import { scheduleActionToneStyles, type ScheduleActionTone } from "../shared/schedule/action-tones";
import { getScheduleApplianceActionPresentation } from "../shared/schedule/model/schedule-appliance-action-presentation";
import { resolveScheduleSlotBoundaries, type ScheduleSlotBoundary } from "../shared/schedule/model/schedule-time";
import { IDLE_W, NodeDetailContentBase, type FlowNode, type NodeFlow } from "./node-detail-base";
import { staleToday } from "./section-resource";
import { readEnergyKWh, readingNumber } from "./node-detail-readings";
import { dispatchWatchedEntities } from "../shared/hass-change";
import { powerUnitFactor } from "../shared/power-reading";
import { mergeRuns, runtimeFor, withinTodayTomorrow } from "./node-detail-schedule";
import { nodeDetailPictureStyles, nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";
import type { DeviceDetailParams } from "./node-detail-types";

type QuestionId = "progress" | "plan" | "waiting" | "today" | "trust";

/** The schedule's canonical slot: the plan's slot in progress moves on at each. */

/**
 * A session duration counter beyond a week is not read as a duration: it is
 * shown as read in the evidence, never turned into a time or an average.
 */
const MAX_SESSION_MINUTES = 7 * 24 * 60;

/** Duration units the session counter converts from, to minutes. */
const MINUTES: Record<string, number> = { s: 1 / 60, min: 1, h: 60, d: 1440 };

/** Two readings further apart than this were not taken together. */
const COMPARABLE_MS = 30_000;

/** A charge window: consecutive slots with the same charging action. */
interface ChargeWindow {
    startMs: number;
    endMs: number | null;
    /** Placed by an optimizer whose condition is not met: not executed. */
    candidate: boolean;
    useMode: string | null;
    ecoGear: string | null;
    vehicleId: string | null;
}

/** Whether two charging actions are one window: the same car, mode, gear and condition. */
function sameWindow(left: ScheduleEvChargerActionDTO, right: ScheduleEvChargerActionDTO): boolean {
    return (left.conditionMet === false) === (right.conditionMet === false)
        && left.useMode === right.useMode && left.ecoGear === right.ecoGear && left.vehicleId === right.vehicleId;
}

/** The car the answers are about, and what its readings say. */
interface Vehicle {
    vehicle: ApplianceVehicleDTO;
    /** The only configured car, or the one the slot in progress names. */
    selectedBy: "only" | "plan";
    soc: number | null;
    limit: number | null;
    capacityKwh: number | null;
    /** `max(0, limit − SoC) / 100 × capacity`; `null` without all three. */
    neededKwh: number | null;
}

type VehicleSelection =
    | { kind: "selected"; car: Vehicle }
    /** Several cars and nothing names one: no car's figures are shown. */
    | { kind: "ambiguous"; count: number }
    | { kind: "none" };

/** What the plan's projection says for the selected car, or why it says nothing. */
type Completion =
    | { kind: "estimate"; endSoc: number; endMs: number | null; reachMs: number | null; suppliedKwh: number; shortfallKwh: number }
    | { kind: "unsupported"; reason: string };

/**
 * The EV charger detail: how the charge is progressing, when charging is
 * planned and whether it reaches the target, why it is not charging, what
 * powered it today and whether its readings can be trusted.
 *
 * It opens on a status pill, the charge switch the charger configures with
 * the plan's word on it, the charging strip (charging so far today and the
 * planned windows to noon tomorrow, with the projected completion under it)
 * and the Now/Today flow around the car. The pictures absorb three
 * questions: the car opens the progress, the strip the plan, the flow today's
 * sources. The other two are tiles beside the session's; one answer is open
 * at a time, full width under the tiles.
 *
 * Live readings come from `hass` and the house's live split from the card;
 * the backend overview supplies the entity ids and the charger's reported
 * status, its `segment` section today's recorded charging and the start of
 * the charging segment, read on opening for the strip. The cars come from the
 * appliance roster (the charger's own appliance metadata), the plan from the
 * shared schedule owner, the plan's projected energy from
 * `helman/get_appliance_projections` on opening for the completion line, and
 * today's attribution from the node detail's `today` section once Today or
 * its question is chosen.
 *
 * The hardware's session counters are the session; a transition into charging
 * only starts a segment. Today's attribution is a separate, whole-day figure.
 * With several cars and none named by the plan, no car's charge is shown. A
 * time at current power is not a ready-by time, and a projected completion is
 * an estimate under the current plan, never a guarantee.
 */
@customElement("node-detail-ev-charger-content")
export class NodeDetailEvChargerContent extends NodeDetailContentBase<EvChargerDetailPayload, QuestionId> {
    static styles = [helmanColorVars, nodeDetailSharedStyles, nodeDetailQuestionStyles, nodeDetailPictureStyles, scheduleActionToneStyles, css`
        .muted {
            color: var(--secondary-text-color);
        }
        .switch {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }
        .switch-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            min-height: 40px;
        }
        .switch-row .reading {
            text-align: left;
            min-width: 0;
            overflow-wrap: anywhere;
        }
        .estimate {
            margin: 0;
            font-size: 0.85rem;
            color: var(--secondary-text-color);
        }
        ul {
            margin: 0;
            padding-left: 18px;
            font-size: 0.9rem;
        }
    `];

    protected readonly _node = "ev_charger" as const;

    /** The charger's consumer id: its appliance id and its `device_id` here. */
    @property({ attribute: false }) public deviceId!: string;
    /** The device as opened: the card's live split and the flow's scale. */
    @property({ attribute: false }) public params!: DeviceDetailParams;

    /** This charger's charging windows in progress, today and tomorrow. */
    private readonly _plan = this._useSchedule((schedule, now): ChargeWindow[] => {
        const slotsById = new Map(schedule.slots.map((slot) => [slot.id, slot]));
        const runs = mergeRuns<ScheduleEvChargerActionDTO>(this._boundaries(), slotsById, this.deviceId, (action) => action.charge, sameWindow)
            .map(({ startMs, endMs, action }) => ({
                startMs,
                endMs,
                candidate: action.conditionMet === false,
                useMode: action.useMode ?? null,
                ecoGear: action.ecoGear ?? null,
                vehicleId: action.vehicleId ?? null,
            }));
        return withinTodayTomorrow(runs, now, this._timeZone);
    });
    /** This charger's appliance metadata; `null` in the payload when the roster has no such charger. */
    private readonly _appliance = this._section<EvChargerApplianceMetadataDTO | null>("appliance", {
        fetch: async () => {
            const roster = await getSharedHelmanStore(this.hass).getAppliances();
            const appliance = (roster?.appliances ?? []).find((item) => item.id === this.deviceId && item.kind === "ev_charger");
            return (appliance as EvChargerApplianceMetadataDTO | undefined) ?? null;
        },
        shown: () => true,
        staleness: () => false,
    });
    /**
     * The plan's projection, for the completion line. A projection from an
     * earlier slot counts energy already delivered: re-read once per slot. A
     * refresh follows a plan change or a new slot: what was shown may be the
     * old plan's, so a failure replaces it.
     */
    private readonly _projection = this._section<ApplianceProjectionsPayload>("projection", {
        // Never shared: a projection is a function of the schedule, re-read because it changed.
        fetch: () => getSharedHelmanStore(this.hass).getApplianceProjections(),
        shown: () => true,
        staleness: (_payload, requestedAt) => requestedAt < Math.floor(Date.now() / SLOT_MS) * SLOT_MS,
        keepOnError: false,
    });
    /** Today's attribution, while Today or its question is chosen. */
    private readonly _today = this._section<EvChargerTodaySectionPayload>("today", {
        fetch: () => this._readSection("today"),
        shown: () => this._open === "today" || this._flowScope === "today",
    });
    /** The appliance answer the cars' entities were last announced for. */
    private _announcedAppliance: unknown = null;
    /** The run mode today's charging was read under; a new one re-reads it. */
    private _segmentRunMode = "";
    /** Today's recorded charging and the segment's start, for the strip, once the overview landed. */
    private readonly _segment = this._section<EvChargerSegmentSectionPayload>("segment", {
        fetch: () => this._readSection("segment"),
        shown: () => this._overview.status === "ready",
        staleness: (payload, requestedAt) => staleToday(payload, requestedAt, this.hass)
            || (this._overview.status === "ready" && this._runModeState(this._overview.payload) !== this._segmentRunMode),
        onRequest: () => {
            this._segmentRunMode = this._overview.status === "ready" ? this._runModeState(this._overview.payload) : "";
        },
    });
    /** HA's entity toggle is defined; until then, or if it fails to load, the switch's state is text. */
    @state() private _toggleReady = !!customElements.get("ha-entity-toggle");

    /** The slot boundaries, read several times a render; cleared before each update. */
    private _boundariesCache?: ScheduleSlotBoundary[];

    willUpdate(changed: Map<string, unknown>): void {
        this._boundariesCache = undefined;
        // Another charger in the same element: nothing shown is its.
        if (changed.has("deviceId") && changed.get("deviceId") !== undefined && this._started) {
            this._overview = { status: "loading" };
            this._setOpen(null);
            // Every opening starts on Now.
            this._flowScope = "now";
            // The sections shown are read again in the update.
            for (const section of this._sections) section.drop();
            void this._loadOverview(true);
        }
        super.willUpdate(changed);
    }

    protected _start(): void {
        super._start();
        loadHaEntityToggle()
            .then(() => { this._toggleReady = true; })
            .catch((error) => console.error("node-detail-ev_charger: failed to load HA's entity toggle", error));
    }

    protected updated(changed: Map<string, unknown>): void {
        super.updated(changed);
        // The cars' entities are watched from the read that resolved them, once it answered.
        const appliance = this._appliance.state;
        if (appliance?.status === "ready" && appliance !== this._announcedAppliance) {
            this._announcedAppliance = appliance;
            if (this._overview.status === "ready") dispatchWatchedEntities(this, "node-detail", this._watchedEntities(this._overview.payload));
        }
    }

    /** The run mode's state now, `""` without one. */
    private _runModeState(payload: EvChargerDetailPayload): string {
        const entityId = payload.entities.run_mode;
        return entityId ? this.hass.states[entityId]?.state ?? "" : "";
    }

    protected _detailRequest(section?: string): GetNodeDetailRequest {
        return { ...super._detailRequest(section), device_id: this.deviceId };
    }

    /** The overview's entities, and every car's SoC and charge limit. */
    protected *_watchedEntities(payload: EvChargerDetailPayload): Iterable<string | null | undefined> {
        yield* Object.values(payload.entities);
        for (const vehicle of this._appliance.payload?.vehicles ?? []) {
            yield vehicle.telemetry.socEntityId;
            yield vehicle.telemetry.chargeLimitEntityId;
        }
    }

    /** The slot in progress names the car and dates the projection; the windows, which the base follows, start and end. */
    protected *_clockBoundaries(): Iterable<number> {
        yield Math.ceil((Date.now() + 1) / SLOT_MS) * SLOT_MS;
    }

    /** Today is the charger's `today` section: its sources, without the phases. */
    protected _todayResource() {
        return this._today;
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    render() {
        const notReady = this._renderNotReady();
        if (notReady || this._overview.status !== "ready") return notReady;
        const overview = this._overview.payload;
        const selection = this._selection();
        const eta = this._flowScope === "now" ? this._eta(overview, selection) : null;
        return html`
            <div class="content">
                ${this._renderSummary(overview)}
                ${this._renderSwitch(overview)}
                ${this._renderStrip(selection)}
                ${this._renderCarFlow(overview, selection)}
                ${eta ? html`<p class="estimate" data-estimate>${eta}</p>` : nothing}
                <div class="tiles">
                    ${this._renderSessionTile(overview)}
                    ${this._renderWaitingTile(overview, selection)}
                    ${this._renderReadingsTile(overview)}
                </div>
                ${this._renderOpen(overview, selection)}
            </div>
        `;
    }

    /** The open question's answer and evidence, full width under the tiles. */
    private _renderOpen(overview: EvChargerDetailPayload, selection: VehicleSelection) {
        switch (this._open) {
            case "progress":
                return this._question("progress", this._progressPreview(overview, selection), () => this._renderProgress(overview, selection), () => this._renderProgressEvidence(overview, selection), "evidence");
            case "plan":
                return this._question("plan", this._planPreview(), () => this._renderPlan(selection), () => this._renderPlanEvidence(overview, selection), "evidence");
            case "waiting":
                return this._question("waiting", this._waitingPreview(overview, selection), () => this._renderWaiting(overview, selection), () => this._renderWaitingEvidence(overview), "evidence");
            case "today":
                return this._question("today", this._todayPreview(), () => this._renderToday(), () => this._renderTodayEvidence(), "evidence");
            case "trust":
                return this._question("trust", this._trustPreview(overview), () => this._renderTrust(overview), () => this._renderTrustEvidence(overview), "technical");
            default:
                return nothing;
        }
    }

    private _renderSummary(overview: EvChargerDetailPayload) {
        const power = this._powerW(overview);
        const kind = overview.status?.kind;
        const tone: ScheduleActionTone = this._charging(overview) ? "charge" : kind === "fault" ? "stop" : "neutral";
        // At most one exception: a fault the charger reports, linked to the readings answer.
        const fault = this._fault(overview);
        return html`
            <div class="summary" data-overview>
                <p class="status pill action-tone-${tone}" data-tone=${tone}>${this._statusText(overview, power)}</p>
                ${fault ? this._exceptionBanner(fillTemplate(this._t("exception.fault"), { fault }), "trust") : nothing}
            </div>
        `;
    }

    /** The status as the charger reports it; a Custom charger's from its power. */
    private _statusText(overview: EvChargerDetailPayload, power: number | null): string {
        const status = overview.status;
        const values = { power: power === null ? "?" : formatPower(power).display, state: status?.runMode ?? "" };
        if (status) return fillTemplate(this._t(`status.${status.kind}`), values);
        const runMode = this._reading(overview, "run_mode");
        if (runMode !== null) return fillTemplate(this._t("status.reported"), { state: runMode });
        if (power === null) return this._t("status.unavailable");
        return fillTemplate(this._t(power > IDLE_W ? "status.drawing" : "status.not_drawing"), values);
    }

    // Switch ------------------------------------------------------------------

    /**
     * The charge switch the charger configures, HA's own toggle for it, with
     * its name opening more-info. The line under it says whether its state is
     * what the plan has now and when the plan next changes it; it never says
     * who switched it. None without a configured switch.
     */
    private _renderSwitch(overview: EvChargerDetailPayload) {
        const entityId = overview.entities.charge_switch;
        if (!entityId) return nothing;
        const line = this._switchLine(entityId);
        return html`
            <div class="switch" data-switch>
                <div class="switch-row">
                    <button class="reading" data-entity=${entityId} @click=${() => this._moreInfo(entityId)}>${this._name(entityId)}</button>
                    ${this._toggleReady
                        ? html`<ha-entity-toggle .hass=${this.hass} .stateObj=${this.hass.states[entityId]}></ha-entity-toggle>`
                        : html`<span class="value" data-switch-state>${this._reading(overview, "charge_switch") ?? this._t("unavailable")}</span>`}
                </div>
                ${line ? html`<p class="note" data-switch-line data-plan-state=${line.state}>${line.text}</p>` : nothing}
            </div>
        `;
    }

    /** The switch against the plan's window now and its next change; `null` until the plan is read. */
    private _switchLine(entityId: string): { state: string; text: string } | null {
        const schedule = this._plan.schedule;
        if (!schedule) return null;
        if (!schedule.executionEnabled) return { state: "execution_off", text: this._t("switch.execution_off") };
        const reading = this.hass.states[entityId]?.state;
        const on = reading === "on" ? true : reading === "off" ? false : null;
        const planned = this._effectiveWindowNow() !== null;
        const state = `${on === null ? "unknown" : on ? "on" : "off"}_${planned ? "planned" : "unplanned"}`;
        const change = this._planChange();
        const next = change
            ? fillTemplate(this._t(change.charge ? "switch.next_on" : "switch.next_off"), { time: this._time(change.at) })
            : this._t("switch.no_next");
        return { state, text: (on === null ? "" : this._t(`switch.${state}`) + " ") + next };
    }

    /** The effective window in progress: execution on and its condition met. */
    private _effectiveWindowNow(): ChargeWindow | null {
        if (!this._plan.schedule?.executionEnabled) return null;
        const now = Date.now();
        return this._plan.runs.find((window) => !window.candidate && window.startMs <= now) ?? null;
    }

    /**
     * When the plan next switches charging: off where the effective windows
     * in progress end, or on where the next one starts. Adjacent windows are
     * one stretch of charging; a candidate is not executed and changes nothing.
     */
    private _planChange(): { at: number; charge: boolean } | null {
        if (!this._plan.schedule?.executionEnabled) return null;
        const effective = this._plan.runs.filter((window) => !window.candidate);
        const current = this._effectiveWindowNow();
        if (!current) return effective[0] ? { at: effective[0].startMs, charge: true } : null;
        let end = current.endMs;
        for (const window of effective) if (end !== null && window.startMs === end) end = window.endMs;
        return end === null ? null : { at: end, charge: false };
    }

    // Strip -------------------------------------------------------------------

    /**
     * Charging so far today, as recorded, and the planned windows to noon
     * tomorrow, with the plan's next change flagged; the projected completion
     * is the line under it. The strip opens the plan.
     */
    private _renderStrip(selection: VehicleSelection) {
        const now = Date.now();
        const { start, end } = modeStripWindow(now, this._timeZone);
        const change = this._planChange();
        const next: ModeChange | null = change ? {
            at: change.at,
            tone: this._evTone(change.charge),
            label: this._time(change.at) + " · " + this._t(change.charge ? "strip.starts" : "strip.stops"),
        } : null;
        return html`
            <button class="picture strip" data-strip title=${this._t("q.plan")} aria-expanded=${this._open === "plan" ? "true" : "false"}
                @click=${() => this._setOpen(this._open === "plan" ? null : "plan")}>
                <span class="picture-scope">${this._t("strip.scope")}</span>
                <helman-mode-strip
                    .start=${start}
                    .end=${end}
                    .now=${now}
                    .segments=${this._stripSegments(now)}
                    .next=${next}
                    .timeZone=${this._timeZone}
                    .locale=${this._locale}
                ></helman-mode-strip>
            </button>
            ${this._segment.state?.status === "error" ? html`<p class="note" data-strip-failed>${this._t("strip.history_failed")}</p>` : nothing}
            <p class="note" data-completion-line>${this._completionLine(selection)}</p>
        `;
    }

    /**
     * Today's recorded charging, the stretch still going drawn to now, and
     * each planned window from now: an effective one in the charge tone, one
     * that is not executed neutral.
     */
    private _stripSegments(now: number): ModeSegment[] {
        const segments: ModeSegment[] = [];
        const section = this._segment.payload;
        const overview = this._overview.status === "ready" ? this._overview.payload : null;
        for (const stretch of section?.charging ?? []) {
            const open = stretch.open && overview !== null && this._charging(overview);
            segments.push({
                start: Date.parse(stretch.start),
                end: open ? now : Date.parse(stretch.end),
                tone: this._evTone(true),
                label: this._t("strip.charged"),
            });
        }
        const executing = this._plan.schedule?.executionEnabled === true;
        for (const window of this._plan.runs) {
            const effective = executing && !window.candidate;
            segments.push({
                start: Math.max(window.startMs, now),
                end: window.endMs ?? Infinity,
                tone: effective ? this._evTone(true) : "neutral",
                label: this._t(window.candidate ? "plan.candidate" : effective ? "plan.effective" : "plan.not_executed"),
            });
        }
        return segments;
    }

    /** The scheduler's tone for an EV action that charges or stops charging. */
    private _evTone(charge: boolean): ScheduleActionTone {
        return getScheduleApplianceActionPresentation({
            appliance: { kind: "ev_charger", icon: "" },
            action: { charge },
            localize: this.localize,
        }).tone;
    }

    /** The existing completion, as one line: the limit's time, or the charge at the plan's end and the shortfall. */
    private _completionLine(selection: VehicleSelection): string {
        const projection = this._projection.state;
        if (projection === null || projection.status === "loading") return this._t("plan.projection_loading");
        if (projection.status === "error") return this._t("plan.projection_failed");
        const completion = this._completion(selection, projection.payload);
        if (completion.kind === "unsupported") return this._t(`plan.unsupported.${completion.reason}`);
        const car = (selection as { kind: "selected"; car: Vehicle }).car;
        return completion.reachMs !== null
            ? fillTemplate(this._t("strip.completion_reach"), { limit: this._percent(car.limit!), time: this._time(completion.reachMs) })
            : fillTemplate(this._t("strip.completion_short"), {
                // Short of the limit is never rounded up onto it.
                soc: this._percent(Math.floor(completion.endSoc)),
                limit: this._percent(car.limit!),
                time: completion.endMs === null ? "?" : this._time(completion.endMs),
                kwh: (formatKwh(Math.abs(completion.shortfallKwh)) + " kWh"),
            });
    }

    // Flow --------------------------------------------------------------------

    /**
     * The car's flow around its charge: the sources in, the house's live mix
     * applied to the charger's power, an estimate said as one; the charger's
     * phases out in the phase colours, on Now only. Today is the `today`
     * section's sources alone: per-phase energy is not recorded. The car
     * opens the progress, the flow today's sources.
     */
    private _renderCarFlow(overview: EvChargerDetailPayload, selection: VehicleSelection) {
        const flow = this._flowScope === "now" ? this._nowFlow(overview) : this._todayFlow();
        const car = selection.kind === "selected" ? selection.car : null;
        // A device opened without the card's live split (the solar inspector's) has no scale: minimum widths.
        return this._renderFlow(flow, this.params?.flowScaleW ?? null, "today", html`
            <button
                slot="centre"
                class="glyph"
                data-glyph
                aria-label=${this._t("q.progress")}
                aria-expanded=${this._open === "progress" ? "true" : "false"}
                @click=${() => this._setOpen(this._open === "progress" ? null : "progress")}
            >
                <helman-soc-glyph
                    hide-min
                    .soc=${car?.soc ?? null}
                    .max=${car?.limit ?? null}
                    .maxLabel=${car?.limit != null ? fillTemplate(this._t("glyph.limit"), { soc: this._percent(car.limit) }) : null}
                    .roomLabel=${car?.neededKwh != null && car.neededKwh > 0 ? (formatKwh(Math.abs(car.neededKwh)) + " kWh") : null}
                    .direction=${this._charging(overview) ? "charge" : "idle"}
                ></helman-soc-glyph>
            </button>
        `);
    }

    /** The house's live mix applied to the charger's power, W, and its phases; unknown without either, never 0. */
    private _nowFlow(overview: EvChargerDetailPayload): NodeFlow {
        const flows = this.params?.flows ?? null;
        const power = this._powerW(overview);
        const format = this._fmt("now");
        const mix: Array<[FlowNode, number]> = flows
            ? [["solar", flows.solarToHouse], ["battery", flows.batteryToHouse], ["grid", flows.gridToHouse]]
            : [];
        const house = mix.reduce((sum, [, watts]) => sum + watts, 0);
        const inputs = (["solar", "battery", "grid"] as const).map((node) => {
            const share = mix.find(([key]) => key === node)?.[1];
            return this._flowItem(node, power === null || share === undefined || house <= 0 ? null : power * share / house, format);
        });
        const outputs: FlowItem[] = [1, 2, 3]
            .filter((phase) => overview.entities[`charge_power_l${phase}`])
            .map((phase) => {
                const watts = this._power(overview.entities[`charge_power_l${phase}`]);
                return { id: `phase-${phase}`, label: `L${phase}`, value: watts, display: format(watts), color: `var(--helman-phase-l${phase})` };
            });
        const flow = this._flowShell("now", inputs, outputs, {
            centre: () => format(power),
            active: this._isActive(power),
            notes: power !== null && power > IDLE_W ? [this._t("flow.mix_estimate")] : [],
        });
        // Without phase readings nothing is drawn out, which is not 0 W out.
        return outputs.length ? flow : { ...flow, totalOut: null };
    }

    /** Today's sources from the `today` section, kWh; energy of no known source is a footnote, never a source. */
    private _todayFlow(): NodeFlow {
        const payload = this._today.payload;
        const charger = payload?.charger ?? null;
        const energy = this._fmt("today");
        const paid = charger?.money.paid ?? null;
        const inputs = (["solar", "battery", "grid"] as const).map((node) => this._flowItem(node, charger ? charger.sources[node] : null, energy));
        if (paid !== null && (charger?.sources.grid ?? 0) > 0) {
            inputs[2] = { ...inputs[2], note: fillTemplate(this.localize("node_detail.flow.paid_estimate"), { value: this._formatMoney(paid, currencyFromPriceUnit(payload!.priceUnit)) }) };
        }
        const notes: string[] = [];
        const status = this._todayStatus();
        if (status) notes.push(status);
        if (charger && charger.sources.unattributed > 0) {
            notes.push(fillTemplate(this._t("flow.unattributed"), { kwh: energy(charger.sources.unattributed) }));
        }
        const flow = this._flowShell("today", inputs, [], {
            // Charged: every source and the unattributed rest.
            centre: (sumIn) => energy(sumIn),
            notes,
            unresolvedIn: charger?.sources.unattributed ?? 0,
        });
        // Per-phase energy is not recorded: nothing goes out.
        return { ...flow, totalOut: null };
    }

    /** Why Today has no sources to draw: loading, failed or unavailable; `null` once it has them. */
    private _todayStatus(): string | null {
        const today = this._today.state;
        if (today === null || today.status === "loading") return this._t("today.loading");
        if (today.status === "error") return this._t("today.failed");
        if (!today.payload.charger) {
            return this._t(["no_charger_node", "no_house_node", "no_house_meter"].includes(today.payload.unavailable ?? "")
                ? `today.unavailable_${today.payload.unavailable}` : "today.unavailable_not_loaded");
        }
        return null;
    }

    // Tiles -------------------------------------------------------------------

    /** The hardware's session energy and duration. */
    private _renderSessionTile(overview: EvChargerDetailPayload) {
        if (this._pluggedIn(overview) === false) return this._tile("progress", this._t("progress.no_car"), null);
        const session = this._sessionKWh(overview);
        const minutes = this._sessionMinutes(overview);
        return this._tile("progress", session === null ? "–" : (formatKwh(Math.abs(session)) + " kWh"),
            minutes === null ? this._t("tile.session") : fillTemplate(this._t("tile.session_for"), { duration: this._duration(minutes) }));
    }

    /** Charging and since when, or what the readings support as why not. */
    private _renderWaitingTile(overview: EvChargerDetailPayload, selection: VehicleSelection) {
        const waiting = this._waiting(overview, selection);
        if (waiting.kind === "charging") {
            const since = this._segment.payload?.chargingSince ?? null;
            return this._tile("waiting", this._t("tile.charging"), since ? fillTemplate(this._t("tile.charging_since"), { time: this._time(Date.parse(since)) }) : null, nothing, "charge");
        }
        if (waiting.kind === "fault") return this._tile("waiting", this._t("tile.fault"), waiting.text, nothing, "stop");
        if (waiting.kind === "no_car") return this._tile("waiting", this._t("progress.no_car"), null);
        return this._tile("waiting", this._t("tile.not_charging"), waiting.reasons.length === 1 ? waiting.reasons[0] : this._t("waiting.unknown_short"));
    }

    /** The total power against the sum of its phases, when they compare. */
    private _renderReadingsTile(overview: EvChargerDetailPayload) {
        const fault = this._fault(overview);
        if (fault) return this._tile("trust", this._t("tile.fault"), fault, nothing, "stop");
        const comparison = this._comparison(overview);
        if (comparison.kind === "compared") {
            return this._tile("trust", formatPower(comparison.totalW).display, fillTemplate(this._t("tile.phase_sum"), { power: formatPower(comparison.phaseSumW).display }));
        }
        const power = this._powerW(overview);
        return this._tile("trust", power === null ? "–" : formatPower(power).display, this._t("tile.not_compared"));
    }

    // Progress ------------------------------------------------------------------

    private _progressPreview(overview: EvChargerDetailPayload, selection: VehicleSelection): string {
        if (this._pluggedIn(overview) === false) return this._t("progress.no_car");
        const parts: string[] = [];
        const session = this._sessionKWh(overview);
        if (session !== null) parts.push(fillTemplate(this._t("progress.session_short"), { kwh: (formatKwh(Math.abs(session)) + " kWh") }));
        if (selection.kind === "selected" && selection.car.neededKwh !== null) {
            parts.push(selection.car.neededKwh <= 0
                ? this._t("progress.reached_short")
                : fillTemplate(this._t("progress.needed_short"), { kwh: (formatKwh(Math.abs(selection.car.neededKwh)) + " kWh") }));
        }
        return parts.length ? parts.join(" · ") : this._t("progress.no_figures");
    }

    private _renderProgress(overview: EvChargerDetailPayload, selection: VehicleSelection) {
        const unavailable = this._t("unavailable");
        const session = this._sessionKWh(overview);
        const minutes = this._sessionMinutes(overview);
        const pluggedIn = this._pluggedIn(overview);
        const eta = this._eta(overview, selection);
        return html`
            ${pluggedIn === false ? html`<p class="note" data-no-session>${this._t("progress.no_session")}</p>` : nothing}
            <div class="section-title">${this._t(pluggedIn === false ? "progress.last_session" : "progress.session")}</div>
            ${this._row(this._t("progress.session_energy"), session === null ? unavailable : (formatKwh(Math.abs(session)) + " kWh"), "session-energy", this._t("progress.hardware_scope"))}
            ${this._row(this._t("progress.session_duration"), minutes === null ? unavailable : this._duration(minutes), "session-duration", this._t("progress.hardware_scope"))}
            ${this._renderSegment()}
            ${!overview.profile ? html`<p class="note">${this._t("progress.no_profile")}</p>` : nothing}
            <div class="section-title">${this._t("progress.car")}</div>
            ${this._renderCar(selection)}
            ${pluggedIn !== false ? this._row(this._t("progress.eta"), eta ?? this._etaMissing(overview, selection), "eta") : nothing}
            <p class="note">${this._t("progress.explain")}</p>
        `;
    }

    /** The recorded start of the charging segment; nothing while not charging or unknown. */
    private _renderSegment() {
        const segment = this._segment.state;
        if (segment?.status === "error") {
            return html`
                <p class="note">${this._t("progress.segment_failed")}</p>
                <button class="link-button" @click=${() => this._segment.load()}>${this._t("retry")}</button>
            `;
        }
        const since = segment?.status === "ready" ? segment.payload.chargingSince : null;
        return since
            ? this._row(this._t("progress.segment"), fillTemplate(this._t("progress.segment_value"), { time: this._time(Date.parse(since)) }), "segment")
            : nothing;
    }

    /** The selected car's charge and what it still needs; never another car's. */
    private _renderCar(selection: VehicleSelection) {
        if (selection.kind === "none") return html`<p class="note" data-no-vehicle>${this._t("car.none")}</p>`;
        if (selection.kind === "ambiguous") {
            return html`<p class="note" data-ambiguous>${fillTemplate(this._t("car.ambiguous"), { count: String(selection.count) })}</p>`;
        }
        const car = selection.car;
        const unavailable = this._t("unavailable");
        return html`
            ${this._row(this._t("car.name"), car.vehicle.name, "car-name", this._t(`car.selected_${car.selectedBy}`))}
            ${this._row(this._t("car.soc"), car.soc === null ? unavailable : this._percent(car.soc), "car-soc", undefined, car.vehicle.telemetry.socEntityId)}
            ${this._row(this._t("car.limit"), car.limit === null ? this._t("car.no_limit") : this._percent(car.limit), "car-limit", undefined, car.vehicle.telemetry.chargeLimitEntityId)}
            ${this._row(this._t("car.needed"), car.neededKwh === null
                ? this._t("car.needed_unknown")
                : car.neededKwh <= 0 ? this._t("car.reached") : (formatKwh(Math.abs(car.neededKwh)) + " kWh"), "car-needed")}
        `;
    }

    private _renderProgressEvidence(overview: EvChargerDetailPayload, selection: VehicleSelection) {
        const session = this._sessionKWh(overview);
        const minutes = this._sessionMinutes(overview);
        const phases = this._phases(overview);
        const active = phases.filter((watts) => watts !== null && watts > IDLE_W).length;
        const known = phases.every((watts) => watts !== null);
        return html`
            ${session !== null && minutes !== null && minutes > 0 ? this._row(this._t("progress.average"),
                formatPower(session / (minutes / 60) * 1000).display, "average", this._t("progress.average_scope")) : nothing}
            ${minutes === null && this._reading(overview, "session_duration") !== null ? html`
                ${this._row(this._t("progress.duration_raw"), this._reading(overview, "session_duration")!, "duration-raw", undefined, overview.entities.session_duration)}
                <p class="note" data-duration-implausible>${this._t("progress.duration_unusable")}</p>
            ` : nothing}
            ${phases.map((watts, index) => watts === null ? nothing
                : this._row(fillTemplate(this._t("progress.phase"), { phase: String(index + 1) }), formatPower(watts).display, `phase-${index + 1}`))}
            ${known ? this._row(this._t("progress.active_phases"), String(active), "active-phases") : nothing}
            ${this._optionalRow(overview, "active_phase", "progress.active_phase")}
            ${known && active === 1 ? html`<p class="note" data-single-phase>${this._t("progress.single_phase")}</p>` : nothing}
            ${selection.kind === "selected" ? html`
                ${selection.car.capacityKwh !== null ? this._row(this._t("car.capacity"), (formatKwh(Math.abs(selection.car.capacityKwh)) + " kWh"), "car-capacity", this._t("car.capacity_scope")) : nothing}
                ${this._row(this._t("car.soc_source"), this._name(selection.car.vehicle.telemetry.socEntityId), "car-soc-source")}
                ${selection.car.vehicle.telemetry.chargeLimitEntityId
                    ? this._row(this._t("car.limit_source"), this._name(selection.car.vehicle.telemetry.chargeLimitEntityId), "car-limit-source") : nothing}
            ` : nothing}
            <p class="note">${this._t("progress.calculation")}</p>
        `;
    }

    /**
     * The time to the car's limit at the charger's power now: constant power,
     * no pauses, taper or losses. `null` while not charging or without a need.
     */
    private _eta(overview: EvChargerDetailPayload, selection: VehicleSelection): string | null {
        const power = this._powerW(overview);
        if (!this._charging(overview) || power === null || power <= IDLE_W) return null;
        if (selection.kind !== "selected" || selection.car.neededKwh === null || selection.car.neededKwh <= 0) return null;
        const minutes = selection.car.neededKwh / (power / 1000) * 60;
        if (!Number.isFinite(minutes)) return null;
        // Coarse on purpose: the assumption behind it is coarse.
        const step = minutes < 60 ? 5 : 15;
        const rounded = Math.max(step, Math.round(minutes / step) * step);
        return fillTemplate(this._t("eta"), { duration: this._duration(rounded), limit: this._percent(selection.car.limit!) });
    }

    /** Why there is no time at current power. */
    private _etaMissing(overview: EvChargerDetailPayload, selection: VehicleSelection): string {
        const power = this._powerW(overview);
        if (!this._charging(overview) || power === null || power <= IDLE_W) return this._t("progress.eta_not_charging");
        if (selection.kind === "selected" && selection.car.neededKwh !== null && selection.car.neededKwh <= 0) return this._t("car.reached");
        return this._t("progress.eta_no_target");
    }

    // Plan --------------------------------------------------------------------

    private _planPreview(): string {
        if (this._plan.failed) return this._t("plan.failed");
        const window = this._nextEffectiveWindow();
        if (window) return fillTemplate(this._t("next_window"), { window: this._windowTime(window) });
        if (this._plan.schedule && !this._plan.schedule.executionEnabled && this._plan.runs.length) return this._t("plan.execution_off_short");
        return this._plan.runs.length ? this._t("plan.candidates_only_short") : this._t("plan.none");
    }

    private _renderPlan(selection: VehicleSelection) {
        if (this._plan.failed) {
            return html`
                <p class="note">${this._t("plan.failed")}</p>
                <button class="link-button" @click=${() => this._plan.refresh()}>${this._t("retry")}</button>
            `;
        }
        if (!this._plan.schedule) return html`<p class="note">${this._t("plan.loading")}</p>`;
        const windows = this._plan.runs;
        return html`
            ${!this._plan.schedule.executionEnabled ? html`<p class="note" data-execution-off>${this._t("plan.execution_off")}</p>` : nothing}
            ${windows.length ? windows.map((window) => this._renderWindow(window)) : html`<p class="note" data-no-windows>${this._t("plan.none")}</p>`}
            <div class="section-title">${this._t("plan.completion")}</div>
            ${this._renderCompletion(selection)}
        `;
    }

    private _renderWindow(window: ChargeWindow) {
        const appliance = this._appliance.payload;
        const vehicle = appliance?.vehicles.find((item) => item.id === window.vehicleId);
        const details = [
            [window.useMode, window.ecoGear].filter(Boolean).join(" "),
            vehicle?.name ?? null,
        ].filter(Boolean).join(" · ");
        const effective = !window.candidate && this._plan.schedule?.executionEnabled === true;
        return html`
            <div class="row" data-window data-effective=${effective ? "true" : "false"}>
                <span class="label">${this._windowTime(window)}${details ? html`<br><span class="note">${details}</span>` : nothing}</span>
                <span class="value ${effective ? "" : "muted"}">${this._t(window.candidate ? "plan.candidate" : effective ? "plan.effective" : "plan.not_executed")}</span>
            </div>
        `;
    }

    private _renderCompletion(selection: VehicleSelection) {
        const projection = this._projection.state;
        if (projection === null || projection.status === "loading") return html`<p class="note" data-projection-loading>${this._t("plan.projection_loading")}</p>`;
        if (projection.status === "error") {
            return html`
                <p class="note">${this._t("plan.projection_failed")}</p>
                <button class="link-button" @click=${() => this._projection.load()}>${this._t("retry")}</button>
            `;
        }
        const completion = this._completion(selection, projection.payload);
        if (completion.kind === "unsupported") {
            return html`<p class="note" data-completion=${completion.reason}>${this._t(`plan.unsupported.${completion.reason}`)}</p>`;
        }
        const car = (selection as { kind: "selected"; car: Vehicle }).car;
        return html`
            ${this._row(this._t("plan.end_soc"), fillTemplate(this._t("plan.end_soc_value"), {
                // Short of the limit is never rounded up onto it.
                soc: this._percent(completion.reachMs === null ? Math.floor(completion.endSoc) : completion.endSoc),
                limit: this._percent(car.limit!),
                time: completion.endMs === null ? "?" : this._time(completion.endMs),
            }), "end-soc", this._t("plan.estimate_scope"))}
            ${this._row(this._t("plan.reach"), completion.reachMs !== null
                ? fillTemplate(this._t("plan.reach_value"), { time: this._time(completion.reachMs) })
                : fillTemplate(this._t("plan.shortfall"), { kwh: (formatKwh(Math.abs(completion.shortfallKwh)) + " kWh") }), "reach", this._t("plan.estimate_scope"))}
            <p class="note">${this._t("plan.explain")}</p>
        `;
    }

    /**
     * The selected car's charge at the end of the plan, and the end of the first
     * slot that reaches its limit, under the current plan.
     *
     * Only effective slots count: execution on, the slot's action charging this
     * car, its condition met. The threshold is crossed in the cumulative
     * projected energy against what the car needs from its live SoC, never on
     * the projection's rounded SoC. A projection from before the slot in
     * progress, or one whose points the plan no longer holds, is stale.
     *
     * The projection fills the car through candidate slots too, so a candidate
     * before an effective slot caps what that slot is projected to deliver:
     * past such a candidate the cumulative energy no longer says what the
     * effective slots alone would do, and short of the limit there is no estimate.
     */
    private _completion(selection: VehicleSelection, payload: ApplianceProjectionsPayload): Completion {
        const unsupported = (reason: string): Completion => ({ kind: "unsupported", reason });
        if (selection.kind !== "selected") return unsupported("no_vehicle");
        const car = selection.car;
        if (car.soc === null || car.limit === null || car.capacityKwh === null || car.neededKwh === null) return unsupported("no_target");
        if (car.neededKwh <= 0) return unsupported("reached");
        const schedule = this._plan.schedule;
        if (!schedule) return unsupported("no_plan");
        if (!schedule.executionEnabled) return unsupported("execution_off");
        const now = Date.now();
        const windows = this._plan.runs;
        if (!windows.some((window) => !window.candidate && window.vehicleId === car.vehicle.id)) {
            return unsupported(windows.some((window) => window.vehicleId === car.vehicle.id) ? "candidates_only" : "no_windows");
        }
        const generatedAt = Date.parse(payload.generatedAt);
        if (!Number.isFinite(generatedAt) || generatedAt < Math.floor(now / SLOT_MS) * SLOT_MS) return unsupported("stale");
        const series = payload.appliances?.[this.deviceId]?.series;
        if (!series?.length) return unsupported("no_projection");

        const boundaries = new Map(this._boundaries().map((slot) => [slot.id, slot]));
        const actions = new Map(schedule.slots.map((slot) => [slot.id, slot.controllables[this.deviceId] as ScheduleEvChargerActionDTO | undefined]));
        const firstCandidateMs = Math.min(...schedule.slots.map((slot) => {
            const action = actions.get(slot.id);
            const bounds = boundaries.get(slot.id);
            return action?.charge && action.conditionMet === false && action.vehicleId === car.vehicle.id
                && bounds && (bounds.endMs === null || bounds.endMs > now) ? bounds.startMs : Infinity;
        }));
        let suppliedKwh = 0;
        let reachMs: number | null = null;
        let endMs: number | null = null;
        let counted = 0;
        const points = [...series].sort((a, b) => (boundaries.get(a.slotId)?.startMs ?? 0) - (boundaries.get(b.slotId)?.startMs ?? 0));
        for (const point of points) {
            if (point.vehicleId !== car.vehicle.id) continue;
            const slot = boundaries.get(point.slotId);
            // A point for a slot the plan no longer holds: computed for another plan.
            if (!slot) return unsupported("stale");
            const action = actions.get(point.slotId);
            if (!action?.charge || action.conditionMet === false || action.vehicleId !== car.vehicle.id) continue;
            if (slot.endMs !== null && slot.endMs <= now) continue;
            if (slot.startMs > firstCandidateMs) {
                if (reachMs !== null) break;
                return unsupported("candidate_first");
            }
            if (!Number.isFinite(point.energyKwh) || point.energyKwh < 0) return unsupported("no_projection");
            suppliedKwh += point.energyKwh;
            counted += 1;
            endMs = slot.endMs;
            if (reachMs === null && suppliedKwh >= car.neededKwh - 1e-9) reachMs = slot.endMs;
        }
        if (counted === 0) return unsupported("no_projection");
        return {
            kind: "estimate",
            endSoc: Math.min(100, car.soc + suppliedKwh / car.capacityKwh * 100),
            endMs,
            reachMs,
            suppliedKwh,
            shortfallKwh: Math.max(0, car.neededKwh - suppliedKwh),
        };
    }

    private _renderPlanEvidence(overview: EvChargerDetailPayload, selection: VehicleSelection) {
        const runtime = runtimeFor<ApplianceRuntimeDTO>(this._plan.schedule, this.deviceId, Date.now());
        const projection = this._projection.payload;
        const supplied = projection ? this._completion(selection, projection) : null;
        return html`
            ${this._plan.schedule ? this._row(this._t("plan.execution"), this._t(this._plan.schedule.executionEnabled ? "plan.execution_on_value" : "plan.execution_off_value"), "execution") : nothing}
            ${this._optionalRow(overview, "use_mode", "plan.use_mode")}
            ${this._optionalRow(overview, "eco_gear", "plan.eco_gear")}
            ${this._optionalRow(overview, "charge_mode", "plan.charge_mode")}
            ${this._row(this._t("plan.runtime"), runtime ? this._runtimeText(runtime) : this._t("plan.no_runtime"), "runtime")}
            ${supplied?.kind === "estimate" ? this._row(this._t("plan.supplied"), (formatKwh(Math.abs(supplied.suppliedKwh)) + " kWh"), "supplied") : nothing}
            ${projection ? this._row(this._t("plan.generated"), this._time(Date.parse(projection.generatedAt)), "generated") : nothing}
            <p class="note">${this._t("plan.evidence_note")}</p>
        `;
    }

    private _runtimeText(runtime: ApplianceRuntimeDTO): string {
        const parts = [this.localize(`node_detail.inverter.runtime.action.${runtime.actionKind}`), this.localize(`node_detail.inverter.runtime.outcome.${runtime.outcome}`)];
        if (runtime.outcome === "failed" && runtime.message) parts.push(runtime.message);
        return parts.join(" · ");
    }

    // Waiting -----------------------------------------------------------------

    /**
     * What the readings support as the reason it is not charging. A fault the
     * charger reports comes first; a reported status next; then the plan's own
     * facts. ECO surplus is context, never the established cause.
     */
    private _waiting(overview: EvChargerDetailPayload, selection: VehicleSelection):
        | { kind: "fault"; text: string }
        | { kind: "charging" }
        | { kind: "no_car" }
        | { kind: "reasons"; reasons: string[]; eco: boolean } {
        const fault = this._fault(overview);
        if (fault) return { kind: "fault", text: fault };
        if (this._charging(overview)) return { kind: "charging" };
        if (overview.status?.kind === "no_car") return { kind: "no_car" };
        const reasons: string[] = [];
        if (selection.kind === "selected" && selection.car.neededKwh !== null && selection.car.neededKwh <= 0) {
            reasons.push(fillTemplate(this._t("waiting.reached"), {
                name: selection.car.vehicle.name, soc: this._percent(selection.car.soc!), limit: this._percent(selection.car.limit!),
            }));
        }
        const schedule = this._plan.schedule;
        const now = Date.now();
        const current = this._plan.runs.find((window) => window.startMs <= now);
        let eco = false;
        if (schedule && !schedule.executionEnabled) {
            reasons.push(this._t("waiting.execution_off"));
        } else if (schedule && !current) {
            const next = this._nextEffectiveWindow();
            reasons.push(next ? fillTemplate(this._t("waiting.next_window"), { window: this._windowTime(next) }) : this._t("waiting.no_window"));
        } else if (current?.candidate) {
            reasons.push(this._t("waiting.candidate"));
        } else if (current) {
            const runtime = runtimeFor<ApplianceRuntimeDTO>(this._plan.schedule, this.deviceId, Date.now());
            if (runtime?.outcome === "failed") {
                reasons.push(fillTemplate(this._t("waiting.runtime_failed"), { message: runtime.message ?? runtime.errorCode ?? this._t("unknown") }));
            }
            eco = (current.useMode ?? this._reading(overview, "use_mode")) === "ECO";
        }
        return { kind: "reasons", reasons, eco };
    }

    private _waitingPreview(overview: EvChargerDetailPayload, selection: VehicleSelection): string {
        const waiting = this._waiting(overview, selection);
        if (waiting.kind === "fault") return this._t("waiting.fault_short");
        if (waiting.kind === "charging") return this._t("waiting.charging");
        if (waiting.kind === "no_car") return this._t("waiting.no_car_short");
        if (waiting.reasons.length === 1) return waiting.reasons[0];
        return this._t("waiting.unknown_short");
    }

    private _renderWaiting(overview: EvChargerDetailPayload, selection: VehicleSelection) {
        const waiting = this._waiting(overview, selection);
        if (waiting.kind === "fault") return html`<p data-waiting="fault">${fillTemplate(this._t("waiting.fault"), { fault: waiting.text })}</p>`;
        if (waiting.kind === "charging") return html`<p data-waiting="charging">${this._t("waiting.charging_long")}</p>`;
        if (waiting.kind === "no_car") return html`<p data-waiting="no_car">${fillTemplate(this._t("waiting.no_car"), { state: overview.status!.runMode })}</p>`;
        const { reasons, eco } = waiting;
        return html`
            ${reasons.length === 1
                ? html`<p data-waiting="reason">${reasons[0]}</p>`
                : html`
                    <p data-waiting="unknown">${this._t(reasons.length ? "waiting.several" : "waiting.unknown")}</p>
                    ${reasons.length ? html`<ul>${reasons.map((reason) => html`<li>${reason}</li>`)}</ul>` : nothing}
                `}
            ${eco ? html`<p class="note" data-eco>${fillTemplate(this._t("waiting.eco"), {
                start: this._reading(overview, "green_start_power") ?? this._t("unknown"),
                grid: this._reading(overview, "grid_power") ?? this._t("unknown"),
            })}</p>` : nothing}
            ${overview.status === null ? html`<p class="note">${this._t(overview.profile ? "waiting.no_status" : "waiting.no_profile")}</p>` : nothing}
        `;
    }

    private _renderWaitingEvidence(overview: EvChargerDetailPayload) {
        const current = this._plan.runs.find((window) => window.startMs <= Date.now());
        return html`
            ${this._optionalRow(overview, "run_mode", "waiting.run_mode")}
            ${this._optionalRow(overview, "charge_switch", "waiting.charge_switch")}
            ${this._optionalRow(overview, "use_mode", "plan.use_mode")}
            ${this._optionalRow(overview, "eco_gear", "plan.eco_gear")}
            ${this._optionalRow(overview, "green_start_power", "waiting.green_start_power")}
            ${this._optionalRow(overview, "grid_power", "waiting.grid_power")}
            ${this._plan.schedule ? this._row(this._t("plan.execution"), this._t(this._plan.schedule.executionEnabled ? "plan.execution_on_value" : "plan.execution_off_value"), "execution") : nothing}
            ${this._row(this._t("waiting.scheduled_now"), current
                ? this._windowTime(current) + (current.candidate ? " – " + this._t("plan.candidate") : "")
                : this._t("waiting.nothing_scheduled"), "scheduled-now")}
            <p class="note">${this._t("waiting.evidence_note")}</p>
        `;
    }

    // Today -------------------------------------------------------------------

    private _todayPreview(): string | null {
        const payload = this._today.payload;
        const charger = payload?.charger;
        if (!charger) return null;
        const parts = [fillTemplate(this._t("today.kwh_short"), { kwh: (formatKwh(Math.abs(charger.kwh)) + " kWh") })];
        if (charger.money.paid !== null) {
            parts.push(fillTemplate(this._t("today.paid_short"), { value: this._formatMoney(charger.money.paid, currencyFromPriceUnit(payload!.priceUnit)) }));
        }
        return parts.join(" · ");
    }

    private _renderToday() {
        const today = this._today.state;
        if (today === null || today.status === "loading") return html`<p class="note" data-today-loading>${this._t("today.loading")}</p>`;
        if (today.status === "error") {
            return html`
                <p class="note">${this._t("today.failed")}</p>
                <button class="link-button" @click=${() => this._today.load()}>${this._t("retry")}</button>
            `;
        }
        const payload = today.payload;
        const period = this._row(this._t("today.period_label"), fillTemplate(this._t("today.period"), { time: this._time(Date.parse(payload.asOf)) }), "period");
        const charger = payload.charger;
        if (!charger) {
            const reason = ["no_charger_node", "no_house_node", "no_house_meter"].includes(payload.unavailable ?? "")
                ? `today.unavailable_${payload.unavailable}` : "today.unavailable_not_loaded";
            return html`${period}<p class="note" data-today-unavailable>${this._t(reason)}</p>`;
        }
        const currency = currencyFromPriceUnit(payload.priceUnit);
        const share = (kwh: number) => charger.kwh > 0
            ? fillTemplate(this._t("today.share"), { kwh: (formatKwh(Math.abs(kwh)) + " kWh"), share: this._share(kwh / charger.kwh) })
            : (formatKwh(Math.abs(kwh)) + " kWh");
        return html`
            ${period}
            ${this._row(this._t("today.kwh"), (formatKwh(Math.abs(charger.kwh)) + " kWh"), "today-kwh")}
            ${charger.kwh > 0 ? html`
                ${this._row(this._t("today.solar"), share(charger.sources.solar), "today-solar")}
                ${this._row(this._t("today.battery"), share(charger.sources.battery), "today-battery")}
                ${this._row(this._t("today.grid"), share(charger.sources.grid), "today-grid")}
                ${charger.sources.unattributed > 0 ? this._row(this._t("today.unattributed"), share(charger.sources.unattributed), "today-unattributed") : nothing}
                ${this._row(this._t("today.paid"), charger.money.paid === null ? this._t("unknown") : this._formatMoney(charger.money.paid, currency), "today-paid", this._t("today.paid_scope"))}
            ` : nothing}
            <p class="note" data-not-session>${this._t("today.not_session")}</p>
        `;
    }

    private _renderTodayEvidence() {
        const payload = this._today.payload;
        if (!payload) return html`<p class="note">${this._t("today.attribution_note")}</p>`;
        const charger = payload.charger;
        const currency = currencyFromPriceUnit(payload.priceUnit);
        return html`
            ${this._row(this._t("today.period_bounds"), this._time(Date.parse(payload.period.start)) + " – " + this._time(Math.min(Date.parse(payload.asOf), Date.parse(payload.period.end))), "period-bounds")}
            ${charger ? html`
                ${this._row(this._t("today.coverage"), this._share(charger.coverage), "coverage")}
                ${this._row(this._t("today.priced"), fillTemplate(this._t("today.priced_value"), {
                    priced: (formatKwh(Math.abs(charger.money.paidPricedKwh)) + " kWh"),
                    unpriced: (formatKwh(Math.abs(charger.money.paidUnpricedKwh)) + " kWh"),
                }), "priced")}
                ${charger.money.forgone !== null ? this._row(this._t("today.forgone"), this._formatMoney(charger.money.forgone, currency), "forgone", this._t("today.forgone_scope")) : nothing}
                ${charger.estimated ? html`<p class="note">${this._t("today.estimated")}</p>` : nothing}
            ` : nothing}
            <p class="note">${this._t("today.attribution_note")}</p>
        `;
    }

    // Trust -------------------------------------------------------------------

    private _trustPreview(overview: EvChargerDetailPayload): string {
        const fault = this._fault(overview);
        if (fault) return fillTemplate(this._t("trust.fault_short"), { fault });
        const parts: string[] = [];
        const network = this._reading(overview, "network_status");
        if (network !== null) parts.push(fillTemplate(this._t("trust.network_short"), { state: network }));
        const comparison = this._comparison(overview);
        if (comparison.kind === "compared") parts.push(fillTemplate(this._t("trust.difference_short"), { watts: formatPower(Math.abs(comparison.differenceW)).display }));
        return parts.length ? parts.join(" · ") : this._t("trust.none");
    }

    private _renderTrust(overview: EvChargerDetailPayload) {
        const fault = this._fault(overview);
        const comparison = this._comparison(overview);
        return html`
            ${this._row(this._t("trust.fault"), fault ?? (this._faultKnown(overview) ? this._t("trust.no_fault") : this._t("unavailable")), "fault")}
            ${this._optionalRow(overview, "network_status", "trust.network")}
            ${this._optionalRow(overview, "link_success_rate", "trust.link")}
            <div class="section-title">${this._t("trust.comparison")}</div>
            ${comparison.kind === "compared" ? html`
                ${this._row(this._t("trust.total"), formatPower(comparison.totalW).display + " · " + this._time(comparison.totalAt), "total")}
                ${this._row(this._t("trust.phase_sum"), formatPower(comparison.phaseSumW).display + " · " + this._time(comparison.phasesAt), "phase-sum")}
                ${this._row(this._t("trust.difference"), formatPower(Math.abs(comparison.differenceW)).display, "difference")}
            ` : html`<p class="note" data-incomparable>${this._t(`trust.incomparable.${comparison.kind}`)}</p>`}
            <p class="note">${this._t("trust.explain")}</p>
        `;
    }

    private _renderTrustEvidence(overview: EvChargerDetailPayload) {
        const rows = [
            this._optionalRow(overview, "fault_code", "trust.fault_code"),
            this._optionalRow(overview, "fault_description", "trust.fault_description"),
            this._optionalRow(overview, "temperature", "trust.temperature"),
            this._optionalRow(overview, "firmware", "trust.firmware"),
            this._optionalRow(overview, "auth_priority", "trust.auth_priority"),
            this._optionalRow(overview, "main_breaker_limit", "trust.main_breaker_limit"),
            this._optionalRow(overview, "lock", "trust.lock"),
            this._optionalRow(overview, "grid_power", "waiting.grid_power"),
        ];
        return html`
            ${rows.every((row) => row === nothing) ? html`<p class="note">${this._t("trust.no_readings")}</p>` : rows}
            <p class="note">${this._t("trust.evidence_note")}</p>
        `;
    }

    /**
     * The charger's total power against the sum of its phase powers: both its
     * own, in W, positive while charging. Compared only when every reading is
     * there and they were taken within {@link COMPARABLE_MS} of each other; a
     * difference is shown, never judged.
     */
    private _comparison(overview: EvChargerDetailPayload):
        | { kind: "compared"; totalW: number; phaseSumW: number; differenceW: number; totalAt: number; phasesAt: number }
        | { kind: "missing" | "not_together" } {
        const total = this._powerW(overview);
        const phases = this._phases(overview);
        if (total === null || phases.some((watts) => watts === null)) return { kind: "missing" };
        // When each was last read: an unchanged value moves `last_reported`, not `last_updated`.
        const times = ["power", "charge_power_l1", "charge_power_l2", "charge_power_l3"].map((key) => {
            const state = this.hass.states[overview.entities[key]!] as { last_reported?: string; last_updated?: string } | undefined;
            return Date.parse(state?.last_reported ?? state?.last_updated ?? "");
        });
        if (times.some((at) => !Number.isFinite(at))) return { kind: "missing" };
        if (Math.max(...times) - Math.min(...times) > COMPARABLE_MS) return { kind: "not_together" };
        const phaseSumW = phases.reduce((sum, watts) => sum! + watts!, 0)!;
        return {
            kind: "compared",
            totalW: total,
            phaseSumW,
            differenceW: total - phaseSumW,
            totalAt: times[0],
            phasesAt: Math.max(...times.slice(1)),
        };
    }

    // ── Readings ────────────────────────────────────────────────────────────

    /** A non-negative power reading in W, by its unit; `null` without one. */
    private _power(entityId: string | null | undefined): number | null {
        const value = readingNumber(this.hass, entityId);
        const factor = powerUnitFactor(this.hass, entityId);
        return value === null || factor === null || value * factor < 0 ? null : value * factor;
    }

    private _powerW(overview: EvChargerDetailPayload): number | null {
        return this._power(overview.entities.power);
    }

    private _phases(overview: EvChargerDetailPayload): Array<number | null> {
        return [1, 2, 3].map((phase) => this._power(overview.entities[`charge_power_l${phase}`]));
    }

    /** The hardware's session energy in kWh; a reading without a known unit is none. */
    private _sessionKWh(overview: EvChargerDetailPayload): number | null {
        const kwh = readEnergyKWh(this.hass, overview.entities.session_energy, false);
        return kwh === null || kwh < 0 ? null : kwh;
    }

    /** The hardware's session duration in minutes; `null` unreadable or beyond a plausible session. */
    private _sessionMinutes(overview: EvChargerDetailPayload): number | null {
        const entityId = overview.entities.session_duration;
        const value = readingNumber(this.hass, entityId);
        const unit = entityId ? this.hass.states[entityId]?.attributes.unit_of_measurement as string | undefined : undefined;
        const factor = unit ? MINUTES[unit] : undefined;
        if (value === null || factor === undefined) return null;
        const minutes = value * factor;
        return minutes >= 0 && minutes <= MAX_SESSION_MINUTES ? minutes : null;
    }

    /** Charging as reported; a Custom charger without a status, by its power. */
    private _charging(overview: EvChargerDetailPayload): boolean {
        if (overview.status) return overview.status.kind === "charging";
        if (overview.entities.run_mode) return false;
        const power = this._powerW(overview);
        return power !== null && power > IDLE_W;
    }

    /** Whether a car is plugged in, as reported; `null` when the charger does not say. */
    private _pluggedIn(overview: EvChargerDetailPayload): boolean | null {
        const kind = overview.status?.kind;
        if (kind === "charging" || kind === "waiting") return true;
        if (kind === "no_car") return false;
        return null;
    }

    private _faultKnown(overview: EvChargerDetailPayload): boolean {
        return overview.status !== null || readingNumber(this.hass, overview.entities.fault_code) !== null;
    }

    /**
     * A fault the charger reports: a faulted run mode, or a non-zero fault code
     * while it is not charging (a code can outlive a recovered fault); `null` otherwise.
     */
    private _fault(overview: EvChargerDetailPayload): string | null {
        const code = readingNumber(this.hass, overview.entities.fault_code);
        const description = this._reading(overview, "fault_description");
        if (overview.status?.kind !== "fault" && (code === null || code === 0 || this._charging(overview))) return null;
        const parts = [overview.status?.kind === "fault" ? overview.status.runMode : null, description, code ? fillTemplate(this._t("trust.code"), { code: String(code) }) : null];
        return parts.filter(Boolean).join(" · ");
    }

    // ── Vehicle and plan ────────────────────────────────────────────────────

    /**
     * The car the answers are about: the only configured one, or the one the
     * slot in progress names. Several cars and nothing naming one is ambiguous:
     * no car's SoC is shown rather than possibly the wrong one's.
     */
    private _selection(): VehicleSelection {
        const appliance = this._appliance.payload;
        const vehicles = appliance?.vehicles ?? [];
        if (!vehicles.length) return { kind: "none" };
        if (vehicles.length === 1) return { kind: "selected", car: this._car(vehicles[0], "only") };
        const named = this._currentAction()?.vehicleId;
        const vehicle = vehicles.find((item) => item.id === named);
        return vehicle ? { kind: "selected", car: this._car(vehicle, "plan") } : { kind: "ambiguous", count: vehicles.length };
    }

    private _car(vehicle: ApplianceVehicleDTO, selectedBy: Vehicle["selectedBy"]): Vehicle {
        const percent = (entityId: string | undefined, allowZero: boolean) => {
            const value = readingNumber(this.hass, entityId);
            return value !== null && value <= 100 && (allowZero ? value >= 0 : value > 0) ? value : null;
        };
        const soc = percent(vehicle.telemetry.socEntityId, true);
        const limit = percent(vehicle.telemetry.chargeLimitEntityId, false);
        const capacity = vehicle.metadata.batteryCapacityKwh;
        const capacityKwh = Number.isFinite(capacity) && capacity > 0 ? capacity : null;
        return {
            vehicle,
            selectedBy,
            soc,
            limit,
            capacityKwh,
            neededKwh: soc !== null && limit !== null && capacityKwh !== null ? Math.max(0, limit - soc) / 100 * capacityKwh : null,
        };
    }

    /** This charger's action in the slot in progress. */
    private _currentAction(): ScheduleEvChargerActionDTO | null {
        const slot = this._currentSlot();
        return slot ? (this._plan.schedule!.slots.find((item) => item.id === slot.id)?.controllables[this.deviceId] as ScheduleEvChargerActionDTO | undefined) ?? null : null;
    }

    private _currentSlot() {
        const now = Date.now();
        return this._boundaries().find((slot) => slot.startMs <= now && (slot.endMs === null || now < slot.endMs)) ?? null;
    }

    private _boundaries(): ScheduleSlotBoundary[] {
        if (this._boundariesCache) return this._boundariesCache;
        const schedule = this._plan.schedule;
        return this._boundariesCache = resolveScheduleSlotBoundaries((schedule?.slots ?? []).map((slot) => slot.id))
            .map((slot) => ({ ...slot, endMs: slot.startMs + SLOT_MS }));
    }

    /** The first window that will run: execution on and its condition met. */
    private _nextEffectiveWindow(): ChargeWindow | null {
        if (!this._plan.schedule?.executionEnabled) return null;
        return this._plan.runs.find((window) => !window.candidate) ?? null;
    }

    private _windowTime(window: ChargeWindow): string {
        const start = window.startMs <= Date.now() ? this._t("now") : this._time(window.startMs);
        return start + "–" + (window.endMs === null ? "?" : this._time(window.endMs));
    }

    private _percent(value: number): string {
        return Math.round(value) + " %";
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "node-detail-ev-charger-content": NodeDetailEvChargerContent;
    }
}
