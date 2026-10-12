import { css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { fillTemplate } from "../../localize/localize";
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
    SchedulePayload,
} from "../../helman-api";
import { currencyFromPriceUnit } from "../../helman-solar-inspector/money-model";
import { getSharedHelmanStore } from "../../helman/store";
import { formatPower } from "../../power-format";
import { formatGridEnergy } from "../../shared/forecast-value-format";
import { resolveScheduleSlotBoundaries, type ScheduleSlotBoundary } from "../../shared/schedule/model/schedule-time";
import { getSharedScheduleOwner } from "../../shared/schedule/schedule-owner";
import { IDLE_W, NodeDetailContentBase, TODAY_REFRESH_MS, type SectionState } from "./node-detail-base";
import { announceWatchedEntities, powerUnitFactor, readEnergyKWh, readingNumber } from "./node-detail-readings";
import { dayKey, todayAndTomorrow } from "./node-detail-schedule";
import { nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";

type QuestionId = "progress" | "plan" | "waiting" | "today" | "trust";

/** The schedule's canonical slot: the plan's slot in progress moves on at each. */
const SLOT_MS = 15 * 60_000;

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
 * powered it today and whether its readings can be trusted, as an overview and
 * five questions.
 *
 * Live readings come from `hass`; the backend overview supplies the entity ids
 * and the charger's reported status, its `segment` section the recorded start
 * of the charging segment once the progress question opens. The cars
 * come from the appliance roster (the charger's own appliance metadata), the
 * plan from the shared schedule owner, the plan's projected energy from
 * `helman/get_appliance_projections` once its question opens, and today's
 * attribution from the node detail's `today` section once its question opens.
 *
 * The hardware's session counters are the session; a transition into charging
 * only starts a segment. Today's attribution is a separate, whole-day figure.
 * With several cars and none named by the plan, no car's charge is shown. A
 * time at current power is not a ready-by time, and a projected completion is
 * an estimate under the current plan, never a guarantee.
 */
@customElement("node-detail-ev-charger-content")
export class NodeDetailEvChargerContent extends NodeDetailContentBase<EvChargerDetailPayload, QuestionId> {
    static styles = [nodeDetailSharedStyles, nodeDetailQuestionStyles, css`
        .muted {
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

    @state() private _schedule: SchedulePayload | null = null;
    @state() private _scheduleFailed = false;
    /** This charger's appliance metadata; `null` in the payload when the roster has no such charger. */
    @state() private _appliance: SectionState<EvChargerApplianceMetadataDTO | null> = { status: "loading" };
    /** The plan's projection, `null` until the plan question opens. */
    @state() private _projection: SectionState<ApplianceProjectionsPayload> | null = null;
    /** Today's attribution, `null` until its question opens. */
    @state() private _today: SectionState<EvChargerTodaySectionPayload> | null = null;
    /** The charging segment's start, `null` until the progress question opens. */
    @state() private _segment: SectionState<EvChargerSegmentSectionPayload> | null = null;

    private _unsubscribeSchedule?: () => void;
    private _applianceRequest = 0;
    private _projectionRequest = 0;
    private _projectionRequestedAt = 0;
    private _todayRequest = 0;
    private _todayRequestedAt = 0;
    private _segmentRequest = 0;
    /** The windows and slot boundaries, read several times a render; cleared before each update. */
    private _windowsCache?: ChargeWindow[];
    private _boundariesCache?: ScheduleSlotBoundary[];

    willUpdate(changed: Map<string, unknown>): void {
        this._windowsCache = undefined;
        this._boundariesCache = undefined;
        // Another charger in the same element: nothing shown is its.
        if (changed.has("deviceId") && changed.get("deviceId") !== undefined && this._started) {
            this._overview = { status: "loading" };
            this._appliance = { status: "loading" };
            this._setOpen(null);
            void this._loadOverview(true);
            void this._loadAppliance();
        }
        super.willUpdate(changed);
        if (document.hidden) return;
        // The open today answer is "today so far": re-read on a new day, and
        // otherwise at most every few minutes, only while visible.
        if (this._open === "today" && this._today?.status === "ready"
            && (!this._isToday(this._today.payload.period.start) || Date.now() - this._todayRequestedAt > TODAY_REFRESH_MS)) {
            void this._loadToday();
        }
        // A projection from an earlier slot counts energy already delivered: re-read it once per slot.
        const slotStart = Math.floor(Date.now() / SLOT_MS) * SLOT_MS;
        if (this._open === "plan" && this._projection?.status === "ready" && this._projectionRequestedAt < slotStart) {
            void this._loadProjection();
        }
    }

    protected _start(): void {
        this._unsubscribeSchedule = getSharedScheduleOwner(this.hass).subscribe((snapshot) => {
            this._schedule = snapshot.schedule;
            this._scheduleFailed = snapshot.schedule === null && snapshot.error !== null;
        });
        super._start();
        void this._loadAppliance();
    }

    protected _stop(): void {
        this._unsubscribeSchedule?.();
        this._unsubscribeSchedule = undefined;
        this._applianceRequest += 1;
        this._projectionRequest += 1;
        this._todayRequest += 1;
        this._segmentRequest += 1;
    }

    protected _onDataChanged(): void {
        // The base reloads the overview; the schedule owner reloads itself.
        super._onDataChanged();
        void this._loadAppliance();
        if (this._projection !== null) void this._loadProjection();
        if (this._today !== null) void this._loadToday();
        if (this._segment !== null) void this._loadSegment();
    }

    /** A new run mode moves the segment: re-read it while it is shown. */
    protected _overviewLoaded(): void {
        if (this._segment !== null) void this._loadSegment();
    }

    protected _detailRequest(section?: string): Omit<GetNodeDetailRequest, "type"> {
        return { ...super._detailRequest(section), device_id: this.deviceId };
    }

    /** The run mode the status and the charging segment were computed from. */
    protected _overviewSignature(payload: EvChargerDetailPayload): string {
        const entityId = payload.entities.run_mode;
        return entityId ? this.hass.states[entityId]?.state ?? "" : "";
    }

    /** The overview's entities, and every car's SoC and charge limit. */
    protected *_watchedEntities(payload: EvChargerDetailPayload): Iterable<string | null | undefined> {
        yield* Object.values(payload.entities);
        const appliance = this._appliance.status === "ready" ? this._appliance.payload : null;
        for (const vehicle of appliance?.vehicles ?? []) {
            yield vehicle.telemetry.socEntityId;
            yield vehicle.telemetry.chargeLimitEntityId;
        }
    }

    /** The windows start and end, and the slot in progress names the car and dates the projection. */
    protected *_clockBoundaries(): Iterable<number> {
        yield Math.ceil((Date.now() + 1) / SLOT_MS) * SLOT_MS;
        for (const window of this._windows()) {
            yield window.startMs;
            if (window.endMs !== null) yield window.endMs;
        }
    }

    // ── Data ────────────────────────────────────────────────────────────────

    private async _loadAppliance(): Promise<void> {
        const request = ++this._applianceRequest;
        if (this._appliance.status !== "ready") this._appliance = { status: "loading" };
        try {
            const payload = await getSharedHelmanStore(this.hass).getAppliances();
            if (request !== this._applianceRequest) return;
            const appliance = (payload?.appliances ?? []).find((item) => item.id === this.deviceId && item.kind === "ev_charger");
            this._appliance = { status: "ready", payload: (appliance as EvChargerApplianceMetadataDTO | undefined) ?? null };
            if (this._overview.status === "ready") announceWatchedEntities(this, this._watchedEntities(this._overview.payload));
        } catch (error) {
            if (request !== this._applianceRequest) return;
            console.error("node-detail-ev_charger: failed to load the appliance roster", error);
            if (this._appliance.status !== "ready") this._appliance = { status: "error" };
        }
    }

    private async _loadProjection(): Promise<void> {
        const request = ++this._projectionRequest;
        if (this._projection?.status !== "ready") this._projection = { status: "loading" };
        this._projectionRequestedAt = Date.now();
        try {
            // Never shared: a projection is a function of the schedule, re-read because it changed.
            const payload = await getSharedHelmanStore(this.hass).getApplianceProjections();
            if (request !== this._projectionRequest) return;
            this._projection = { status: "ready", payload };
        } catch (error) {
            if (request !== this._projectionRequest) return;
            console.error("node-detail-ev_charger: failed to load the projection", error);
            // A refresh follows a plan change or a new slot: what was shown may be
            // the old plan's, so the failure and its retry replace it.
            this._projection = { status: "error" };
        }
    }

    private async _loadToday(): Promise<void> {
        const request = ++this._todayRequest;
        if (this._today?.status !== "ready" || !this._isToday(this._today.payload.period.start)) this._today = { status: "loading" };
        this._todayRequestedAt = Date.now();
        try {
            const payload = await getSharedHelmanStore(this.hass)
                .getNodeDetail<EvChargerTodaySectionPayload>(this._detailRequest("today"), { fresh: true });
            if (request !== this._todayRequest) return;
            this._today = { status: "ready", payload };
        } catch (error) {
            if (request !== this._todayRequest) return;
            console.error("node-detail-ev_charger: failed to load today's attribution", error);
            if (this._today?.status !== "ready") this._today = { status: "error" };
        }
    }

    private async _loadSegment(): Promise<void> {
        const request = ++this._segmentRequest;
        if (this._segment?.status !== "ready") this._segment = { status: "loading" };
        try {
            const payload = await getSharedHelmanStore(this.hass)
                .getNodeDetail<EvChargerSegmentSectionPayload>(this._detailRequest("segment"), { fresh: true });
            if (request !== this._segmentRequest) return;
            this._segment = { status: "ready", payload };
        } catch (error) {
            if (request !== this._segmentRequest) return;
            console.error("node-detail-ev_charger: failed to load the charging segment", error);
            if (this._segment?.status !== "ready") this._segment = { status: "error" };
        }
    }

    // ── Disclosure ──────────────────────────────────────────────────────────

    protected _setOpen(id: QuestionId | null): void {
        super._setOpen(id);
        // A closed answer's request is obsolete; it is re-read on reopen.
        this._projectionRequest += 1;
        this._projection = null;
        this._todayRequest += 1;
        this._today = null;
        this._segmentRequest += 1;
        this._segment = null;
        if (id === "progress") void this._loadSegment();
        if (id === "plan") void this._loadProjection();
        if (id === "today") void this._loadToday();
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    render() {
        const notReady = this._renderNotReady();
        if (notReady || this._overview.status !== "ready") return notReady;
        const overview = this._overview.payload;
        const selection = this._selection();
        return html`
            <div class="content">
                ${this._renderSummary(overview, selection)}
                ${this._question("progress", this._progressPreview(overview, selection), () => this._renderProgress(overview, selection), () => this._renderProgressEvidence(overview, selection), "evidence")}
                ${this._question("plan", this._planPreview(), () => this._renderPlan(selection), () => this._renderPlanEvidence(overview, selection), "evidence")}
                ${this._question("waiting", this._waitingPreview(overview, selection), () => this._renderWaiting(overview, selection), () => this._renderWaitingEvidence(overview), "evidence")}
                ${this._question("today", this._todayPreview(), () => this._renderToday(), () => this._renderTodayEvidence(), "evidence")}
                ${this._question("trust", this._trustPreview(overview), () => this._renderTrust(overview), () => this._renderTrustEvidence(overview), "technical")}
            </div>
        `;
    }

    private _renderSummary(overview: EvChargerDetailPayload, selection: VehicleSelection) {
        const power = this._powerW(overview);
        const figures: Array<[string, string, string]> = [];
        if (power !== null) figures.push([this._t("figure.power"), formatPower(power).display, "power"]);
        if (selection.kind === "selected" && selection.car.soc !== null) {
            const car = selection.car;
            figures.push([
                fillTemplate(this._t("figure.car"), { name: car.vehicle.name }),
                car.limit !== null ? this._percent(car.soc!) + " → " + this._percent(car.limit) : this._percent(car.soc!),
                "car",
            ]);
        }
        const session = this._sessionKWh(overview);
        if (session !== null && this._pluggedIn(overview) !== false) figures.push([this._t("figure.session"), formatGridEnergy(session), "session"]);
        const next = this._nextLine(overview, selection);
        return html`
            <div class="summary" data-overview>
                <p class="status">${this._statusText(overview, power)}</p>
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

    /** Charging: the time at current power; otherwise the next effective window. */
    private _nextLine(overview: EvChargerDetailPayload, selection: VehicleSelection): string | null {
        if (this._charging(overview)) {
            const eta = this._eta(overview, selection);
            if (eta) return eta;
        }
        const window = this._nextEffectiveWindow();
        return window ? fillTemplate(this._t("next_window"), { window: this._windowTime(window) }) : null;
    }

    /** At most one: a fault the charger reports, linked to the readings answer. */
    private _renderException(overview: EvChargerDetailPayload) {
        const fault = this._fault(overview);
        if (!fault) return nothing;
        return html`
            <div class="exception" role="status" data-exception>
                <span>${fillTemplate(this._t("exception.fault"), { fault })}</span>
                <button class="link-button" @click=${() => this._setOpen("trust")}>${this._t("exception.details")}</button>
            </div>
        `;
    }

    // Progress ------------------------------------------------------------------

    private _progressPreview(overview: EvChargerDetailPayload, selection: VehicleSelection): string {
        if (this._pluggedIn(overview) === false) return this._t("progress.no_car");
        const parts: string[] = [];
        const session = this._sessionKWh(overview);
        if (session !== null) parts.push(fillTemplate(this._t("progress.session_short"), { kwh: formatGridEnergy(session) }));
        if (selection.kind === "selected" && selection.car.neededKwh !== null) {
            parts.push(selection.car.neededKwh <= 0
                ? this._t("progress.reached_short")
                : fillTemplate(this._t("progress.needed_short"), { kwh: formatGridEnergy(selection.car.neededKwh) }));
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
            ${this._row(this._t("progress.session_energy"), session === null ? unavailable : formatGridEnergy(session), "session-energy", this._t("progress.hardware_scope"))}
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
        const segment = this._segment;
        if (segment?.status === "error") {
            return html`
                <p class="note">${this._t("progress.segment_failed")}</p>
                <button class="link-button" @click=${() => this._loadSegment()}>${this._t("retry")}</button>
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
                : car.neededKwh <= 0 ? this._t("car.reached") : formatGridEnergy(car.neededKwh), "car-needed")}
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
                ${selection.car.capacityKwh !== null ? this._row(this._t("car.capacity"), formatGridEnergy(selection.car.capacityKwh), "car-capacity", this._t("car.capacity_scope")) : nothing}
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
        if (this._scheduleFailed) return this._t("plan.failed");
        const window = this._nextEffectiveWindow();
        if (window) return fillTemplate(this._t("next_window"), { window: this._windowTime(window) });
        if (this._schedule && !this._schedule.executionEnabled && this._windows().length) return this._t("plan.execution_off_short");
        return this._windows().length ? this._t("plan.candidates_only_short") : this._t("plan.none");
    }

    private _renderPlan(selection: VehicleSelection) {
        if (this._scheduleFailed) {
            return html`
                <p class="note">${this._t("plan.failed")}</p>
                <button class="link-button" @click=${() => void getSharedScheduleOwner(this.hass).refresh()}>${this._t("retry")}</button>
            `;
        }
        if (!this._schedule) return html`<p class="note">${this._t("plan.loading")}</p>`;
        const windows = this._windows();
        return html`
            ${!this._schedule.executionEnabled ? html`<p class="note" data-execution-off>${this._t("plan.execution_off")}</p>` : nothing}
            ${windows.length ? windows.map((window) => this._renderWindow(window)) : html`<p class="note" data-no-windows>${this._t("plan.none")}</p>`}
            <div class="section-title">${this._t("plan.completion")}</div>
            ${this._renderCompletion(selection)}
        `;
    }

    private _renderWindow(window: ChargeWindow) {
        const appliance = this._appliance.status === "ready" ? this._appliance.payload : null;
        const vehicle = appliance?.vehicles.find((item) => item.id === window.vehicleId);
        const details = [
            [window.useMode, window.ecoGear].filter(Boolean).join(" "),
            vehicle?.name ?? null,
        ].filter(Boolean).join(" · ");
        const effective = !window.candidate && this._schedule?.executionEnabled === true;
        return html`
            <div class="row" data-window data-effective=${effective ? "true" : "false"}>
                <span class="label">${this._windowTime(window)}${details ? html`<br><span class="note">${details}</span>` : nothing}</span>
                <span class="value ${effective ? "" : "muted"}">${this._t(window.candidate ? "plan.candidate" : effective ? "plan.effective" : "plan.not_executed")}</span>
            </div>
        `;
    }

    private _renderCompletion(selection: VehicleSelection) {
        const projection = this._projection;
        if (projection === null || projection.status === "loading") return html`<p class="note" data-projection-loading>${this._t("plan.projection_loading")}</p>`;
        if (projection.status === "error") {
            return html`
                <p class="note">${this._t("plan.projection_failed")}</p>
                <button class="link-button" @click=${() => this._loadProjection()}>${this._t("retry")}</button>
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
                : fillTemplate(this._t("plan.shortfall"), { kwh: formatGridEnergy(completion.shortfallKwh) }), "reach", this._t("plan.estimate_scope"))}
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
        const schedule = this._schedule;
        if (!schedule) return unsupported("no_plan");
        if (!schedule.executionEnabled) return unsupported("execution_off");
        const now = Date.now();
        const windows = this._windows();
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
        const runtime = this._runtime();
        const projection = this._projection?.status === "ready" ? this._projection.payload : null;
        const supplied = projection ? this._completion(selection, projection) : null;
        return html`
            ${this._schedule ? this._row(this._t("plan.execution"), this._t(this._schedule.executionEnabled ? "plan.execution_on_value" : "plan.execution_off_value"), "execution") : nothing}
            ${this._optionalRow(overview, "use_mode", "plan.use_mode")}
            ${this._optionalRow(overview, "eco_gear", "plan.eco_gear")}
            ${this._optionalRow(overview, "charge_mode", "plan.charge_mode")}
            ${this._row(this._t("plan.runtime"), runtime ? this._runtimeText(runtime) : this._t("plan.no_runtime"), "runtime")}
            ${supplied?.kind === "estimate" ? this._row(this._t("plan.supplied"), formatGridEnergy(supplied.suppliedKwh), "supplied") : nothing}
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
        const schedule = this._schedule;
        const now = Date.now();
        const current = this._windows().find((window) => window.startMs <= now);
        let eco = false;
        if (schedule && !schedule.executionEnabled) {
            reasons.push(this._t("waiting.execution_off"));
        } else if (schedule && !current) {
            const next = this._nextEffectiveWindow();
            reasons.push(next ? fillTemplate(this._t("waiting.next_window"), { window: this._windowTime(next) }) : this._t("waiting.no_window"));
        } else if (current?.candidate) {
            reasons.push(this._t("waiting.candidate"));
        } else if (current) {
            const runtime = this._runtime();
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
        const current = this._windows().find((window) => window.startMs <= Date.now());
        return html`
            ${this._optionalRow(overview, "run_mode", "waiting.run_mode")}
            ${this._optionalRow(overview, "charge_switch", "waiting.charge_switch")}
            ${this._optionalRow(overview, "use_mode", "plan.use_mode")}
            ${this._optionalRow(overview, "eco_gear", "plan.eco_gear")}
            ${this._optionalRow(overview, "green_start_power", "waiting.green_start_power")}
            ${this._optionalRow(overview, "grid_power", "waiting.grid_power")}
            ${this._schedule ? this._row(this._t("plan.execution"), this._t(this._schedule.executionEnabled ? "plan.execution_on_value" : "plan.execution_off_value"), "execution") : nothing}
            ${this._row(this._t("waiting.scheduled_now"), current
                ? this._windowTime(current) + (current.candidate ? " – " + this._t("plan.candidate") : "")
                : this._t("waiting.nothing_scheduled"), "scheduled-now")}
            <p class="note">${this._t("waiting.evidence_note")}</p>
        `;
    }

    // Today -------------------------------------------------------------------

    private _todayPreview(): string | null {
        const payload = this._today?.status === "ready" ? this._today.payload : null;
        const charger = payload?.charger;
        if (!charger) return null;
        const parts = [fillTemplate(this._t("today.kwh_short"), { kwh: formatGridEnergy(charger.kwh) })];
        if (charger.money.paid !== null) {
            parts.push(fillTemplate(this._t("today.paid_short"), { value: this._formatMoney(charger.money.paid, currencyFromPriceUnit(payload!.currency)) }));
        }
        return parts.join(" · ");
    }

    private _renderToday() {
        const today = this._today;
        if (today === null || today.status === "loading") return html`<p class="note" data-today-loading>${this._t("today.loading")}</p>`;
        if (today.status === "error") {
            return html`
                <p class="note">${this._t("today.failed")}</p>
                <button class="link-button" @click=${() => this._loadToday()}>${this._t("retry")}</button>
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
        const currency = currencyFromPriceUnit(payload.currency);
        const share = (kwh: number) => charger.kwh > 0
            ? fillTemplate(this._t("today.share"), { kwh: formatGridEnergy(kwh), share: this._share(kwh / charger.kwh) })
            : formatGridEnergy(kwh);
        return html`
            ${period}
            ${this._row(this._t("today.kwh"), formatGridEnergy(charger.kwh), "today-kwh")}
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
        const payload = this._today?.status === "ready" ? this._today.payload : null;
        if (!payload) return html`<p class="note">${this._t("today.attribution_note")}</p>`;
        const charger = payload.charger;
        const currency = currencyFromPriceUnit(payload.currency);
        return html`
            ${this._row(this._t("today.period_bounds"), this._time(Date.parse(payload.period.start)) + " – " + this._time(Math.min(Date.parse(payload.asOf), Date.parse(payload.period.end))), "period-bounds")}
            ${charger ? html`
                ${this._row(this._t("today.coverage"), this._share(charger.coverage), "coverage")}
                ${this._row(this._t("today.priced"), fillTemplate(this._t("today.priced_value"), {
                    priced: formatGridEnergy(charger.money.paidPricedKwh),
                    unpriced: formatGridEnergy(charger.money.paidUnpricedKwh),
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
        const appliance = this._appliance.status === "ready" ? this._appliance.payload : null;
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
        return slot ? (this._schedule!.slots.find((item) => item.id === slot.id)?.controllables[this.deviceId] as ScheduleEvChargerActionDTO | undefined) ?? null : null;
    }

    private _currentSlot() {
        const now = Date.now();
        return this._boundaries().find((slot) => slot.startMs <= now && (slot.endMs === null || now < slot.endMs)) ?? null;
    }

    private _boundaries(): ScheduleSlotBoundary[] {
        return this._boundariesCache ??= resolveScheduleSlotBoundaries((this._schedule?.slots ?? []).map((slot) => slot.id));
    }

    /** The executor's record for this charger, only when it is for the slot in progress. */
    private _runtime(): ApplianceRuntimeDTO | null {
        const runtime = this._schedule?.runtime;
        const slot = this._currentSlot();
        if (!runtime || !slot || runtime.activeSlotId !== slot.id) return null;
        return (runtime.controllables[this.deviceId] as ApplianceRuntimeDTO | undefined) ?? null;
    }

    private _windows(): ChargeWindow[] {
        return this._windowsCache ??= this._readWindows();
    }

    /** This charger's charging windows in progress, today and tomorrow. */
    private _readWindows(): ChargeWindow[] {
        const slots = this._schedule?.slots ?? [];
        if (!slots.length) return [];
        const now = Date.now();
        const days = todayAndTomorrow(now, this._timeZone);
        const byId = new Map(slots.map((slot) => [slot.id, slot]));
        const windows: ChargeWindow[] = [];
        for (const boundary of this._boundaries()) {
            const action = byId.get(boundary.id)?.controllables[this.deviceId] as ScheduleEvChargerActionDTO | undefined;
            if (!action?.charge) continue;
            const next: ChargeWindow = {
                startMs: boundary.startMs,
                endMs: boundary.endMs,
                candidate: action.conditionMet === false,
                useMode: action.useMode ?? null,
                ecoGear: action.ecoGear ?? null,
                vehicleId: action.vehicleId ?? null,
            };
            const last = windows[windows.length - 1];
            if (last && last.endMs === next.startMs && last.candidate === next.candidate && last.useMode === next.useMode
                && last.ecoGear === next.ecoGear && last.vehicleId === next.vehicleId) {
                last.endMs = next.endMs;
            } else {
                windows.push(next);
            }
        }
        return windows.filter((window) => (window.endMs === null || window.endMs > now)
            && (window.startMs <= now || days.includes(dayKey(window.startMs, this._timeZone))));
    }

    /** The first window that will run: execution on and its condition met. */
    private _nextEffectiveWindow(): ChargeWindow | null {
        if (!this._schedule?.executionEnabled) return null;
        return this._windows().find((window) => !window.candidate) ?? null;
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
