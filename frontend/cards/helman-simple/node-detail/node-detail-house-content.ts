import { css, html, nothing, unsafeCSS } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { fillTemplate } from "../../localize/localize";
import {
    fetchDeviceReport,
    isDeviceReportUnavailable,
    type DevicePhase,
    type HouseDetailPayload,
    type HouseLoadDTO,
    type HousePatternSectionPayload,
    type HouseTodaySectionPayload,
    type RankingReportPayload,
    type ScheduleApplianceActionDTO,
    type SchedulePayload,
} from "../../helman-api";
import type { HelmanSolarInspectorCardConfig } from "../../helman-solar-inspector/HelmanSolarInspectorCardConfig";
import { currencyFromPriceUnit } from "../../helman-solar-inspector/money-model";
import { BATT_COLOR, GRID_COLOR, HOUSE_COLOR, NEUTRAL_LIGHT_COLOR, SOLAR_COLOR } from "../../color-utils";
import type { TreeItem } from "../../helman/tree-item";
import { getSharedHelmanStore } from "../../helman/store";
import { formatPower } from "../../power-format";
import { formatGridEnergy } from "../../shared/forecast-value-format";
import { resolveScheduleSlotBoundaries } from "../../shared/schedule/model/schedule-time";
import { getSharedScheduleOwner } from "../../shared/schedule/schedule-owner";
import { INVERTER_CONTROLLABLE_ID, isScheduleApplianceActionEnabled } from "../../shared/schedule/schedule-types";
import { todayIso } from "../../shared/today-iso";
import "../../helman-device-reports/device-report-ranking";
import { IDLE_W, NodeDetailContentBase, TODAY_REFRESH_MS, type SectionState } from "./node-detail-base";
import { powerUnitFactor, readingNumber } from "./node-detail-readings";
import { dayKey, todayAndTomorrow } from "./node-detail-schedule";
import { nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";
import type { HouseDetailParams } from "./node-detail-types";

type QuestionId = "sources" | "consumers" | "next" | "pattern" | "phases";

/** How often a stale day's figures are retried after midnight. */
const NEW_DAY_RETRY_MS = 30_000;

/** The forecast's canonical slot. */
const SLOT_MS = 15 * 60_000;

/** The house's sources, in the order every split and row shows them. */
const SOURCES = [
    ["solar", SOLAR_COLOR],
    ["battery", BATT_COLOR],
    ["grid", GRID_COLOR],
] as const;

const PHASES = ["L1", "L2", "L3"] as const;

/**
 * The inspector under "What will use energy next?": the house forecast against
 * what the house measured, with the plan's strip; prices, money and the
 * aggregate views belong to other answers.
 */
export const HOUSE_FORECAST_INSPECTOR_CONFIG: HelmanSolarInspectorCardConfig = {
    type: "custom:helman-solar-inspector-card",
    transparent_background: true,
    hide_price_strip: true,
    hide_money_strip: true,
    hide_aggregate_views: true,
    show_bias_ratio: false,
    daylight_only_default: false,
    chart_series: ["houseForecast", "houseActual"],
};

/** One load of the house tree, counted once, as the phase estimate sees it. */
export interface PhaseLoad {
    label: string;
    /** A metered parent's own share: its remainder. */
    own: boolean;
    /** Its own phase, or the single phase of the device it sits under. */
    phase: DevicePhase | null;
    /** The device whose phase it is on, when not its own. */
    inheritedFrom: string | null;
    /** W now; `null` without a reading. */
    watts: number | null;
}

export interface PhaseEstimate {
    loads: PhaseLoad[];
    /** Estimated W per phase from the mapped loads, a three-phase load in thirds. */
    perPhase: Record<(typeof PHASES)[number], number>;
    mappedW: number;
    /** Loads without a phase, and the house's own unmeasured remainder. */
    unassignedW: number;
    /** The house's own remainder, W: what no device meter explains. */
    houseRemainderW: number | null;
    /** Whether any load is on a phase at all. */
    anyMapped: boolean;
}

/**
 * Each phase's load, estimated from the devices the user mapped to phases.
 *
 * Every load is counted once, the way the card's tree accounts for it: a
 * device with children is its children plus its own remainder, never its
 * meter beside them. A load's own phase counts only where it is the user's
 * choice, as in `phaseAssignableDevices`: at the top level or behind a
 * three-phase device. Anywhere else it is on its parent's phase, a stale own
 * one notwithstanding. Behind a three-phase device a load without its own
 * phase could be on any, so it stays unassigned. A three-phase load splits in thirds, an
 * estimate rather than a measured balance. A load without a reading is
 * unknown, never 0 W, and is in no total.
 */
export function estimatePhaseLoads(house: TreeItem | null, read: (entityId: string | null) => number | null): PhaseEstimate {
    const loads: PhaseLoad[] = [];
    let houseRemainderW: number | null = null;

    // `phaseFrom` is the device whose own phase the parent's is, so a load
    // inheriting through a device without one names where the phase is set.
    const walk = (item: TreeItem, parentPhase: DevicePhase | null, phaseFrom: string | null, assignable: boolean): void => {
        const own = assignable ? item.phase ?? null : null;
        const inherited = own === null && parentPhase !== null && parentPhase !== "3ph";
        const phase = own ?? (inherited ? parentPhase : null);
        const inheritedFrom = inherited ? phaseFrom : null;
        const add = (watts: number | null, isOwn: boolean) =>
            loads.push({ label: item.name, own: isOwn, phase, inheritedFrom, watts });
        if (!item.children.length) {
            add(read(item.powerSensorId), false);
            return;
        }
        const remainder = item.children.find((child) => child.isUnmeasured);
        for (const child of item.children) if (!child.isUnmeasured) walk(child, phase, inherited ? phaseFrom : item.name, own === "3ph");
        // Without a power sensor the parent has no remainder: its own share is unknown.
        add(remainder ? read(remainder.powerSensorId) : null, true);
    };

    for (const child of house?.children ?? []) {
        if (child.isUnmeasured) houseRemainderW = read(child.powerSensorId);
        else walk(child, null, null, true);
    }

    const perPhase = { L1: 0, L2: 0, L3: 0 };
    let mappedW = 0;
    let unassignedW = houseRemainderW ?? 0;
    for (const load of loads) {
        if (load.watts === null) continue;
        if (load.phase === null) unassignedW += load.watts;
        else if (load.phase === "3ph") for (const phase of PHASES) perPhase[phase] += load.watts / 3;
        else perPhase[load.phase] += load.watts;
        if (load.phase !== null) mappedW += load.watts;
    }
    return { loads, perPhase, mappedW, unassignedW, houseRemainderW, anyMapped: loads.some((load) => load.phase !== null) };
}

/** An appliance's planned run: consecutive slots with the same running action. */
interface PlannedRun {
    id: string;
    name: string;
    startMs: number;
    endMs: number | null;
    /** Placed by an optimizer whose condition is not met: the executor will not run it. */
    candidate: boolean;
    setBy: string | null;
}

/**
 * The house detail: what powered the house today, what used the energy, what
 * will use it next, whether today is unusual and how the load spreads over the
 * phases, as an overview and five questions. The card's device tree is not
 * repeated: the card stays the route to individual devices.
 *
 * Live readings come from `hass`; the backend overview supplies the entity
 * ids. Today's report figures are requested with the overview, because the
 * overview shows today's energy and paid cost; the weekday comparison and the
 * overnight minimum are requested only while their question is open, and the
 * forecast embed and today's full ranking only behind their answers. Nothing
 * here is a diagnosis: a low overnight load is an observation, an unusual day
 * a comparison, and a phase's gap to its assigned devices a hint, measured
 * against an estimate from the user's own wiring map.
 */
@customElement("node-detail-house-content")
export class NodeDetailHouseContent extends NodeDetailContentBase<HouseDetailPayload, QuestionId> {
    static styles = [nodeDetailSharedStyles, nodeDetailQuestionStyles, css`
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
        .mix {
            display: flex;
            flex-direction: column;
            gap: 4px;
            font-size: 0.85rem;
            color: var(--secondary-text-color);
        }
        .bars {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .bar-row {
            display: grid;
            grid-template-columns: minmax(64px, auto) 1fr;
            gap: 2px 8px;
            align-items: center;
            font-size: 0.9rem;
        }
        .bar-label {
            font-weight: 600;
        }
        .bar-track {
            position: relative;
            height: 10px;
            border-radius: 5px;
            background: var(--secondary-background-color, rgba(0, 0, 0, 0.06));
            overflow: hidden;
        }
        .bar-fill {
            height: 100%;
            border-radius: 5px;
            background: ${unsafeCSS(HOUSE_COLOR)};
        }
        .bar-text {
            grid-column: 2;
            font-size: 0.82rem;
        }
        .heatmap {
            display: grid;
            grid-template-columns: 28px repeat(24, minmax(0, 1fr));
            gap: 1px;
            font-size: 0.7rem;
        }
        .heatmap .cell {
            height: 14px;
            border-radius: 2px;
        }
        .heatmap .day {
            color: var(--secondary-text-color);
            line-height: 14px;
        }
        .heatmap .hour {
            color: var(--secondary-text-color);
            text-align: center;
        }
        .tag {
            font-size: 0.75rem;
            color: var(--secondary-text-color);
        }
        .phase {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }
        .phase-devices > summary {
            cursor: pointer;
            font-size: 0.82rem;
            color: var(--secondary-text-color);
        }
    `];

    protected readonly _node = "house" as const;

    @property({ attribute: false }) public params!: HouseDetailParams;

    @state() private _schedule: SchedulePayload | null = null;
    /** Today's report figures, shown on the overview; `null` before the first request. */
    @state() private _today: SectionState<HouseTodaySectionPayload> | null = null;
    /** The pattern answer's history, `null` while it is closed. */
    @state() private _pattern: SectionState<HousePatternSectionPayload> | null = null;
    /** Today's full ranking, behind the consumers answer's evidence. */
    @state() private _ranking: SectionState<RankingReportPayload | null> | null = null;

    private _unsubscribeSchedule?: () => void;
    private _todayRequest = 0;
    private _todayRequestedAt = 0;
    private _patternRequest = 0;
    private _patternRequestedAt = 0;
    private _rankingRequest = 0;
    private _rankingRequestedAt = 0;
    /** The day the shown ranking was requested for. */
    private _rankingDate = "";
    /** The planned runs, read several times a render; cleared before each update. */
    private _runsCache?: PlannedRun[];

    willUpdate(changed: Map<string, unknown>): void {
        this._runsCache = undefined;
        super.willUpdate(changed);
        // "Today so far" is re-read on a new day, and otherwise at most every
        // few minutes, only while the page is visible.
        if (document.hidden) return;
        // The house re-renders on every device's power tick: a new day is
        // retried at most every NEW_DAY_RETRY_MS, never once per render while
        // a request is in flight or after one failed.
        const stale = (isToday: boolean, requestedAt: number) => {
            const age = Date.now() - requestedAt;
            return age > TODAY_REFRESH_MS || (!isToday && age > NEW_DAY_RETRY_MS);
        };
        if (this._today?.status === "ready" && stale(this._isToday(this._today.payload.period.start), this._todayRequestedAt)) void this._loadToday();
        if (this._pattern?.status === "ready" && stale(this._isToday(this._pattern.payload.period.start), this._patternRequestedAt)) void this._loadPattern();
        // The full ranking only while its evidence is open.
        if (this._open === "consumers" && this._evidenceOpen && this._ranking?.status === "ready"
            && stale(this._rankingDate === todayIso(this._timeZone), this._rankingRequestedAt)) void this._loadRanking();
    }

    protected updated(changed: Map<string, unknown>): void {
        super.updated(changed);
        // Today's full ranking is fetched only once its evidence is open.
        if (this._open === "consumers" && this._evidenceOpen && this._ranking === null) void this._loadRanking();
    }

    protected _start(): void {
        this._unsubscribeSchedule = getSharedScheduleOwner(this.hass).subscribe((snapshot) => {
            this._schedule = snapshot.schedule;
        });
        super._start();
        // The overview's next line reads the rest of today's forecast.
        void this._loadForecast();
    }

    protected _stop(): void {
        this._unsubscribeSchedule?.();
        this._unsubscribeSchedule = undefined;
        this._todayRequest += 1;
        this._patternRequest += 1;
        this._rankingRequest += 1;
    }

    protected _onDataChanged(): void {
        // The base reloads the overview and the forecast; the schedule owner reloads itself.
        super._onDataChanged();
        if (this._today !== null) void this._loadToday();
        if (this._pattern !== null) void this._loadPattern();
        if (this._ranking !== null) void this._loadRanking();
    }

    /** The run mode the overview's condition was computed from. */
    protected _overviewSignature(payload: HouseDetailPayload): string {
        const entityId = payload.entities.run_mode;
        return entityId ? this.hass.states[entityId]?.state ?? "" : "";
    }

    /** The overview's entities, and every load the phase estimate reads. */
    protected *_watchedEntities(payload: HouseDetailPayload): Iterable<string | null | undefined> {
        yield* Object.values(payload.entities);
        const walk = function* (items: TreeItem[]): Iterable<string | null> {
            for (const item of items) {
                yield item.powerSensorId;
                yield* walk(item.children);
            }
        };
        yield* walk(this.params.houseNode?.children ?? []);
    }

    protected _overviewLoaded(payload: HouseDetailPayload): void {
        if (this._today === null && payload.sections.includes("today")) void this._loadToday();
        // An answer may already be open, waiting for the overview's sections.
        if (this._open === "pattern" && this._pattern === null) void this._loadPattern();
    }

    /** The rest of today's forecast moves at each slot boundary; the next planned load at each run. */
    protected *_clockBoundaries(): Iterable<number> {
        const now = Date.now();
        yield Math.ceil(now / SLOT_MS) * SLOT_MS;
        for (const run of this._plannedRuns()) {
            yield run.startMs;
            if (run.endMs !== null) yield run.endMs;
        }
    }

    // ── Data ────────────────────────────────────────────────────────────────

    private async _loadToday(): Promise<void> {
        const request = ++this._todayRequest;
        if (this._today?.status !== "ready") this._today = { status: "loading" };
        this._todayRequestedAt = Date.now();
        try {
            const payload = await getSharedHelmanStore(this.hass)
                .getNodeDetail<HouseTodaySectionPayload>({ node: "house", section: "today" }, { fresh: true });
            if (request !== this._todayRequest) return;
            this._today = { status: "ready", payload };
        } catch (error) {
            if (request !== this._todayRequest) return;
            console.error("node-detail-house: failed to load today's figures", error);
            if (this._today?.status !== "ready") this._today = { status: "error" };
        }
    }

    private async _loadPattern(): Promise<void> {
        const overview = this._overview.status === "ready" ? this._overview.payload : null;
        if (!overview?.sections.includes("pattern")) return;
        const request = ++this._patternRequest;
        if (this._pattern?.status !== "ready") this._pattern = { status: "loading" };
        this._patternRequestedAt = Date.now();
        try {
            const payload = await getSharedHelmanStore(this.hass)
                .getNodeDetail<HousePatternSectionPayload>({ node: "house", section: "pattern" }, { fresh: true });
            if (request !== this._patternRequest) return;
            this._pattern = { status: "ready", payload };
        } catch (error) {
            if (request !== this._patternRequest) return;
            console.error("node-detail-house: failed to load the pattern section", error);
            if (this._pattern?.status !== "ready") this._pattern = { status: "error" };
        }
    }

    private async _loadRanking(): Promise<void> {
        const request = ++this._rankingRequest;
        if (this._ranking?.status !== "ready") this._ranking = { status: "loading" };
        const today = todayIso(this._timeZone);
        this._rankingRequestedAt = Date.now();
        try {
            const payload = await fetchDeviceReport(this.hass, "ranking", { start_date: today, end_date: today });
            if (request !== this._rankingRequest) return;
            this._rankingDate = today;
            this._ranking = { status: "ready", payload: isDeviceReportUnavailable(payload) ? null : payload as RankingReportPayload };
        } catch (error) {
            if (request !== this._rankingRequest) return;
            console.error("node-detail-house: failed to load today's ranking", error);
            if (this._ranking?.status !== "ready") this._ranking = { status: "error" };
        }
    }

    private _todayPayload(): HouseTodaySectionPayload | null {
        return this._today?.status === "ready" ? this._today.payload : null;
    }

    // ── Disclosure ──────────────────────────────────────────────────────────

    protected _setOpen(id: QuestionId | null): void {
        super._setOpen(id);
        // A closed answer's requests are obsolete; they are re-read on reopen.
        this._patternRequest += 1;
        this._pattern = null;
        this._rankingRequest += 1;
        this._ranking = null;
        if (id === "pattern") void this._loadPattern();
        // An opened forecast answer shows the forecast as it is now.
        if (id === "next") void this._loadForecast();
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    render() {
        const notReady = this._renderNotReady();
        if (notReady || this._overview.status !== "ready") return notReady;
        const overview = this._overview.payload;
        const phases = this._phaseEstimate();
        return html`
            <div class="content">
                ${this._renderSummary(overview)}
                ${this._question("sources", this._sourcesPreview(), () => this._renderSources(), () => this._renderSourcesEvidence(), "evidence")}
                ${this._question("consumers", this._consumersPreview(), () => this._renderConsumers(), () => this._renderConsumersEvidence(), "evidence")}
                ${this._question("next", this._nextPreview(), () => this._renderNext(), () => this._renderNextEvidence(), "evidence")}
                ${this._question("pattern", this._patternPreview(), () => this._renderPattern(), () => this._renderPatternEvidence(), "evidence")}
                ${this._question("phases", this._phasesPreview(overview, phases), () => this._renderPhases(overview, phases), () => this._renderPhasesEvidence(overview), "evidence")}
            </div>
        `;
    }

    private _renderSummary(overview: HouseDetailPayload) {
        const power = this._powerNow();
        const status = power === null
            ? this._t("status.unavailable")
            : fillTemplate(this._t("status.using"), { power: formatPower(Math.max(0, power)).display });

        // The status sentence already says the power now.
        const figures: Array<[string, string, string]> = [];
        const today = this._todayPayload();
        if (today?.house) {
            figures.push([this._t("figure.today"), formatGridEnergy(today.house.kwh), "today"]);
            const paid = today.house.money.paid;
            if (paid !== null) figures.push([this._t("figure.paid"), this._money(paid, today.currency), "paid"]);
        }

        const next = this._nextLine();
        return html`
            <div class="summary" data-overview>
                <p class="status">${status}</p>
                ${this._renderLiveMix(overview)}
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

    /**
     * Where the power in use comes from now: Helman's source-ratio sensors, the
     * mix the card colours its consumers with. One compact line, not cards.
     */
    private _renderLiveMix(overview: HouseDetailPayload) {
        const shares = SOURCES.map(([key, color]) => ({ key, color, pct: readingNumber(this.hass, overview.entities[`${key}_ratio`]) }));
        const total = shares.reduce((sum, share) => sum + Math.max(0, share.pct ?? 0), 0);
        if (shares.some((share) => share.pct === null) || total <= 0) return nothing;
        return html`
            <div class="mix" data-live-mix>
                <div class="split" aria-hidden="true">
                    ${shares.filter((share) => share.pct! > 0).map((share) => html`<span data-split=${share.key} style="width: ${share.pct! / total * 100}%; background: ${share.color}"></span>`)}
                </div>
                <span>${fillTemplate(this._t("mix.now"), {
                    shares: shares.map((share) => fillTemplate(this._t(`mix.${share.key}`), { share: Math.round(share.pct!) + " %" })).join(" · "),
                })}</span>
            </div>
        `;
    }

    /** The next planned appliance run, or the one running now. */
    private _nextLine(): string | null {
        const run = this._plannedRuns()[0];
        if (!run) return null;
        const values = { name: run.name, time: this._time(run.startMs), end: run.endMs === null ? "?" : this._time(run.endMs) };
        const text = fillTemplate(this._t(run.startMs <= Date.now() ? "next.running" : "next.planned"), values);
        return run.candidate ? text + " – " + this._t("next.candidate") : text;
    }

    /** At most one: off-grid operation or a fault the inverter reports, linked to the phase answer. */
    private _renderException(overview: HouseDetailPayload) {
        if (!overview.condition) return nothing;
        return html`
            <div class="exception" role="status" data-exception>
                <span>${fillTemplate(this._t(`exception.${overview.condition.kind}`), { state: overview.condition.runMode })}</span>
                <button class="link-button" @click=${() => this._setOpen("phases")}>${this._t("exception.details")}</button>
            </div>
        `;
    }

    /** Why today's report figures are not shown, or `null` once they are. */
    private _todayNotReady() {
        const today = this._today;
        if (today === null || today.status === "loading") return html`<p class="note" data-today-loading>${this._t("today.loading")}</p>`;
        if (today.status === "error") {
            return html`
                <p class="note">${this._t("today.failed")}</p>
                <button class="link-button" @click=${() => this._loadToday()}>${this._t("retry")}</button>
            `;
        }
        if (!today.payload.house) {
            const reason = ["no_house_node", "no_house_meter"].includes(today.payload.unavailable ?? "")
                ? `today.unavailable_${today.payload.unavailable}`
                : "today.unavailable_not_loaded";
            return html`<p class="note" data-today-unavailable>${this._t(reason)}</p>`;
        }
        return null;
    }

    // Sources -----------------------------------------------------------------

    private _sourcesPreview(): string | null {
        const house = this._todayPayload()?.house;
        if (!house || house.kwh <= 0) return null;
        return SOURCES.map(([key]) => fillTemplate(this._t(`mix.${key}`), { share: this._share(house.sources[key] / house.kwh) })).join(" · ");
    }

    private _renderSources() {
        const notReady = this._todayNotReady();
        if (notReady) return notReady;
        const today = this._todayPayload()!;
        const house = today.house!;
        const period = this._row(this._t("period_label"), this._periodText(today), "period");
        if (house.kwh <= 0) return html`${period}<p class="note" data-no-usage>${this._t("sources.none")}</p>`;
        const parts: Array<[string, number, string]> = [
            ...SOURCES.map(([key, color]) => [key, house.sources[key], color] as [string, number, string]),
            ["unattributed", house.sources.unattributed, NEUTRAL_LIGHT_COLOR],
        ];
        const independence = today.independence;
        const self = today.selfConsumption;
        return html`
            ${period}
            ${this._row(this._t("sources.used"), formatGridEnergy(house.kwh), "used")}
            <div class="split" aria-hidden="true">
                ${parts.filter(([, kwh]) => kwh > 0).map(([key, kwh, color]) => html`<span data-split=${key} style="width: ${Math.min(100, kwh / house.kwh * 100)}%; background: ${color}"></span>`)}
            </div>
            ${parts.map(([key, kwh, color]) => key === "unattributed" && kwh <= 0 ? nothing : html`
                <div class="row" data-row=${key}>
                    <span class="label"><span class="swatch" style="background: ${color}"></span>${this._t(`sources.${key}`)}</span>
                    <span class="value">${fillTemplate(this._t("share_value"), { kwh: formatGridEnergy(kwh), share: this._share(kwh / house.kwh) })}</span>
                </div>
            `)}
            ${this._row(this._t("sources.independence"), independence
                ? fillTemplate(this._t(independence.unknownShare > 0 ? "sources.independence_unknown" : "sources.independence_value"), {
                    share: this._share(independence.share),
                    unknown: this._share(independence.unknownShare),
                })
                : this._t("unknown"), "independence", this._t("sources.independence_scope"))}
            ${this._row(this._t("sources.self_consumption"), self?.share != null
                ? this._share(self.share)
                : this._t(`sources.self_${self?.reason ?? "no_solar_meter"}`), "self-consumption", this._t("sources.self_scope"))}
            <p class="note">${this._t("sources.explain")}</p>
        `;
    }

    private _renderSourcesEvidence() {
        const today = this._todayPayload();
        const house = today?.house;
        if (!today || !house) return html`<p class="note">${this._t("sources.no_evidence")}</p>`;
        const money = house.money;
        const destinations = today.selfConsumption?.destinations ?? null;
        return html`
            <div class="section-title">${this._t("sources.valuation")}</div>
            ${this._row(this._t("sources.paid"), money.paid === null ? this._t("unknown") : this._money(money.paid, today.currency), "paid", this._t("sources.paid_scope"))}
            ${this._row(this._t("sources.priced"), fillTemplate(this._t("sources.priced_value"), {
                kwh: formatGridEnergy(money.paidPricedKwh),
                share: house.kwh > 0 ? this._share(money.paidPricedKwh / house.kwh) : "–",
            }), "priced")}
            ${this._row(this._t("sources.forgone"), money.forgone === null ? this._t("unknown") : this._money(money.forgone, today.currency), "forgone", this._t("sources.forgone_scope"))}
            <div class="section-title">${this._t("sources.unresolved_title")}</div>
            ${this._row(this._t("sources.unattributed"), formatGridEnergy(house.sources.unattributed), "unresolved")}
            ${house.ambiguousKwh > 0 ? this._row(this._t("sources.ambiguous"), formatGridEnergy(house.ambiguousKwh), "ambiguous", this._t("sources.ambiguous_scope")) : nothing}
            ${house.mismatchKwh > 0 ? this._row(this._t("sources.mismatch"), formatGridEnergy(house.mismatchKwh), "mismatch") : nothing}
            ${destinations ? html`
                ${this._row(this._t("sources.matched_solar"), formatGridEnergy(destinations.attributedKwh), "matched-solar")}
                ${this._row(this._t("sources.solar_used"), formatGridEnergy(destinations.houseKwh + destinations.batteryKwh), "solar-used")}
                ${destinations.unattributedKwh > 0 ? this._row(this._t("sources.solar_unmatched"), formatGridEnergy(destinations.unattributedKwh), "solar-unmatched") : nothing}
            ` : nothing}
            ${!today.complete ? html`<p class="note" data-incomplete>${this._t("incomplete")}</p>` : nothing}
            <p class="note">${this._t("sources.evidence_note")}</p>
        `;
    }

    // Consumers ---------------------------------------------------------------

    private _consumersPreview(): string | null {
        const consumers = this._todayPayload()?.consumers;
        const top = consumers?.top[0];
        if (!top) return null;
        return fillTemplate(this._t("consumers.top_short"), { name: this._loadName(top), kwh: formatGridEnergy(top.kwh) });
    }

    private _renderConsumers() {
        const notReady = this._todayNotReady();
        if (notReady) return notReady;
        const today = this._todayPayload()!;
        const consumers = today.consumers;
        const period = this._row(this._t("period_label"), this._periodText(today), "period");
        if (!consumers || !consumers.top.length) return html`${period}<p class="note" data-no-consumers>${this._t("consumers.none")}</p>`;
        return html`
            ${period}
            ${consumers.top.map((load, index) => this._row(
                this._loadName(load),
                this._loadValue(load, today.currency),
                `top-${index + 1}`,
            ))}
            ${consumers.others.count > 0 ? this._row(
                fillTemplate(this._t("consumers.others"), { count: String(consumers.others.count) }),
                formatGridEnergy(consumers.others.kwh),
                "others",
            ) : nothing}
            ${consumers.unmeasuredKwh !== null ? this._row(this._t("consumers.unmeasured"), formatGridEnergy(consumers.unmeasuredKwh), "unmeasured", this._t("consumers.unmeasured_scope")) : nothing}
            <p class="note">${this._t("consumers.explain")}</p>
        `;
    }

    private _loadName(load: HouseLoadDTO): string {
        const name = load.label || load.id;
        const named = load.ownOf ? fillTemplate(this._t("consumers.own"), { name }) : name;
        return load.estimated ? "≈ " + named : named;
    }

    /** kWh first; the attributed paid cost beside it, an estimate. */
    private _loadValue(load: HouseLoadDTO, currency: string | null): string {
        const kwh = formatGridEnergy(load.kwh);
        return load.money.paid === null
            ? kwh
            : fillTemplate(this._t("consumers.value_paid"), { kwh, paid: this._money(load.money.paid, currency) });
    }

    private _renderConsumersEvidence() {
        const today = this._todayPayload();
        const consumers = today?.consumers;
        return html`
            ${consumers?.top.length ? html`
                <div class="section-title">${this._t("consumers.money_title")}</div>
                ${consumers.top.map((load, index) => this._row(
                    this._loadName(load),
                    fillTemplate(this._t("consumers.money_value"), {
                        priced: load.kwh > 0 ? this._share(load.money.paidPricedKwh / load.kwh) : "–",
                        forgone: load.money.forgone === null ? this._t("unknown") : this._money(load.money.forgone, today!.currency),
                    }),
                    `money-${index + 1}`,
                ))}
                <p class="note">${this._t("consumers.money_note")}</p>
                ${consumers.overallocatedKwh > 0 ? this._row(this._t("consumers.overallocated"), formatGridEnergy(consumers.overallocatedKwh), "overallocated", this._t("consumers.overallocated_scope")) : nothing}
            ` : nothing}
            <div class="section-title">${this._t("consumers.ranking_title")}</div>
            ${this._renderRanking()}
        `;
    }

    /** The device reports' own ranking of today: the full list, as the reports card shows it. */
    private _renderRanking() {
        const ranking = this._ranking;
        if (ranking === null || ranking.status === "loading") return html`<p class="note">${this._t("consumers.ranking_loading")}</p>`;
        if (ranking.status === "error") {
            return html`
                <p class="note">${this._t("consumers.ranking_failed")}</p>
                <button class="link-button" @click=${() => this._loadRanking()}>${this._t("retry")}</button>
            `;
        }
        if (!ranking.payload) return html`<p class="note">${this._t("today.unavailable_not_loaded")}</p>`;
        const today = todayIso(this._timeZone);
        return html`
            <helman-device-report-ranking
                data-ranking
                .payload=${ranking.payload}
                .query=${{ start_date: today, end_date: today }}
                .localize=${this.localize}
            ></helman-device-report-ranking>
        `;
    }

    // Next --------------------------------------------------------------------

    private _nextPreview(): string | null {
        const rest = this._restOfDayKwh();
        const run = this._plannedRuns()[0];
        const parts: string[] = [];
        if (rest !== null) parts.push(fillTemplate(this._t("next.rest_short"), { kwh: formatGridEnergy(rest) }));
        if (run) parts.push(fillTemplate(this._t("next.run_short"), { name: run.name, time: this._time(run.startMs) }));
        if (parts.length) return parts.join(" · ");
        return this._forecastFailed ? this.localize("node_detail.forecast_failed") : null;
    }

    private _renderNext() {
        const rest = this._restOfDayKwh();
        const runs = this._plannedRuns();
        const executionOff = this._schedule?.executionEnabled === false;
        return html`
            ${rest !== null
                ? this._row(this._t("next.rest"), formatGridEnergy(rest), "rest", this._t("next.rest_scope"))
                : this._forecastFailed ? this._renderForecastFailed() : html`<p class="note" data-no-forecast>${this._forecastMissing()}</p>`}
            <div class="section-title">${this._t("next.planned_title")}</div>
            ${runs.length ? runs.map((run, index) => html`
                <div class="row" data-row=${`run-${index + 1}`} data-candidate=${run.candidate ? "true" : "false"}>
                    <span class="label">${run.name}${run.candidate ? html`<br><span class="tag">${this._t("next.candidate")}</span>` : nothing}</span>
                    <span class="value">${this._runTime(run)}</span>
                </div>
            `) : html`<p class="note" data-no-runs>${this._t("next.no_runs")}</p>`}
            ${executionOff ? html`<p class="note" data-execution-off>${this._t("next.execution_off")}</p>` : nothing}
            <p class="note">${this._t("next.explain")}</p>
            <div class="plan" data-forecast-inspector>${this._inspector("next", HOUSE_FORECAST_INSPECTOR_CONFIG)}</div>
        `;
    }

    private _renderNextEvidence() {
        const forecast = this._forecast?.house_consumption;
        const slot = forecast?.currentSlot;
        const runs = this._plannedRuns();
        return html`
            <div class="section-title">${this._t("next.forecast_title")}</div>
            ${forecast ? html`
                ${this._row(this._t("next.forecast_status"), this._t(`next.status_${forecast.status}`), "forecast-status")}
                ${this._row(this._t("next.history"), fillTemplate(this._t("next.history_value"), {
                    days: String(forecast.historyDaysAvailable),
                    window: String(forecast.trainingWindowDays),
                }), "history")}
                ${slot ? this._row(this._t("next.slot"), fillTemplate(this._t("next.slot_value"), {
                    kwh: formatGridEnergy(slot.nonDeferrable.value),
                    lower: formatGridEnergy(slot.nonDeferrable.lower),
                    upper: formatGridEnergy(slot.nonDeferrable.upper),
                }), "slot") : nothing}
            ` : html`<p class="note">${this._forecastMissing()}</p>`}
            <p class="note">${this._t("next.forecast_note")}</p>
            ${runs.length ? html`
                <div class="section-title">${this._t("next.plan_title")}</div>
                ${runs.map((run, index) => this._row(
                    run.name,
                    [
                        this._runTime(run),
                        run.setBy ? this.localize(`node_detail.inverter.next.set_by_${run.setBy}`) : null,
                        this.localize(`node_detail.inverter.next.${run.candidate ? "condition_not_met" : "condition_met"}`),
                    ].filter(Boolean).join(" · "),
                    `plan-${index + 1}`,
                ))}
            ` : nothing}
            <p class="note">${this._t("next.plan_note")}</p>
        `;
    }

    private _runTime(run: PlannedRun): string {
        const range = fillTemplate(this._t("period_range"), { start: this._time(run.startMs), end: run.endMs === null ? "…" : this._time(run.endMs) });
        const [, tomorrow] = todayAndTomorrow(Date.now(), this._timeZone);
        return dayKey(run.startMs, this._timeZone) === tomorrow ? fillTemplate(this._t("next.tomorrow"), { range }) : range;
    }

    /**
     * Today's house forecast from now to midnight: the adjusted base load
     * (scheduled appliance runs included), the slot in progress by its
     * remaining part. The deferrable band is never added. `null` without a
     * forecast with data.
     */
    private _restOfDayKwh(): number | null {
        const forecast = this._forecast?.house_consumption;
        if (!forecast || forecast.status !== "available") return null;
        const now = Date.now();
        const today = dayKey(now, this._timeZone);
        let kwh = 0;
        for (const slot of [forecast.currentSlot, ...forecast.series]) {
            if (!slot) continue;
            const start = Date.parse(slot.timestamp);
            const end = start + SLOT_MS;
            if (!Number.isFinite(start) || end <= now || dayKey(start, this._timeZone) !== today) continue;
            kwh += Math.max(0, slot.nonDeferrable.value) * Math.min(1, (end - Math.max(start, now)) / SLOT_MS);
        }
        return kwh;
    }

    /**
     * The appliances' planned runs from now through tomorrow: consecutive
     * slots in which the plan has the appliance running. A candidate, whose
     * condition is not met, is kept and marked: the executor does not run it.
     */
    private _plannedRuns(): PlannedRun[] {
        return this._runsCache ??= this._readPlannedRuns();
    }

    private _readPlannedRuns(): PlannedRun[] {
        const slots = this._schedule?.slots ?? [];
        if (!slots.length) return [];
        const now = Date.now();
        const days = todayAndTomorrow(now, this._timeZone);
        const names = this._applianceNames();
        const byId = new Map(slots.map((slot) => [slot.id, slot]));
        const open = new Map<string, PlannedRun>();
        const runs: PlannedRun[] = [];
        for (const boundary of resolveScheduleSlotBoundaries(slots.map((slot) => slot.id))) {
            const actions = byId.get(boundary.id)?.controllables ?? {};
            for (const [id, run] of open) {
                const action = actions[id] as ScheduleApplianceActionDTO | undefined;
                if (!action || isScheduleApplianceActionEnabled(action) !== true || (action.conditionMet === false) !== run.candidate || run.endMs !== boundary.startMs) {
                    open.delete(id);
                }
            }
            for (const [id, value] of Object.entries(actions)) {
                if (id === INVERTER_CONTROLLABLE_ID) continue;
                const action = value as ScheduleApplianceActionDTO;
                if (isScheduleApplianceActionEnabled(action) !== true) continue;
                const run = open.get(id);
                if (run) {
                    run.endMs = boundary.endMs;
                    continue;
                }
                const next: PlannedRun = {
                    id,
                    name: names.get(id) ?? id,
                    startMs: boundary.startMs,
                    endMs: boundary.endMs,
                    candidate: action.conditionMet === false,
                    setBy: action.setBy ?? null,
                };
                open.set(id, next);
                runs.push(next);
            }
        }
        return runs
            // A run started yesterday and still going is kept: it is running now.
            .filter((run) => (run.endMs === null || run.endMs > now) && (run.startMs <= now || days.includes(dayKey(run.startMs, this._timeZone))))
            .sort((a, b) => a.startMs - b.startMs);
    }

    /** Controllable id → the device's name, from the card's house tree. */
    private _applianceNames(): Map<string, string> {
        const names = new Map<string, string>();
        const walk = (items: TreeItem[]) => {
            for (const item of items) {
                for (const id of item.controllableIds ?? []) names.set(id, item.name);
                walk(item.children);
            }
        };
        walk(this.params.houseNode?.children ?? []);
        return names;
    }

    private _forecastMissing(): string {
        if (this._forecast === null) return this._t("forecast_loading");
        return this._t(this._forecast.house_consumption.status === "not_configured" ? "forecast_not_configured" : "forecast_unavailable");
    }

    // Pattern -----------------------------------------------------------------

    private _patternReady(): HousePatternSectionPayload | null {
        return this._pattern?.status === "ready" ? this._pattern.payload : null;
    }

    private _patternPreview(): string | null {
        const comparison = this._patternReady()?.comparison;
        if (!comparison || comparison.ratio === null) return null;
        return fillTemplate(this._t("pattern.short"), {
            change: this._signedShare(comparison.ratio - 1),
            weekday: this._weekday(Date.parse(comparison.until)),
            time: this._time(Date.parse(comparison.until)),
        });
    }

    private _renderPattern() {
        const overview = this._overview.status === "ready" ? this._overview.payload : null;
        if (!overview?.sections.includes("pattern")) return html`<p class="note" data-pattern-unavailable>${this._t("pattern.no_meters")}</p>`;
        const section = this._pattern;
        if (section === null || section.status === "loading") return html`<p class="note" data-pattern-loading>${this._t("loading_history")}</p>`;
        if (section.status === "error") {
            return html`
                <p class="note">${this._t("history_failed")}</p>
                <button class="link-button" @click=${() => this._loadPattern()}>${this._t("retry")}</button>
            `;
        }
        const payload = section.payload;
        return html`
            <div class="section-title">${this._t("pattern.comparison_title")}</div>
            ${this._renderComparison(payload.comparison)}
            <div class="section-title">${this._t("pattern.overnight_title")}</div>
            ${this._renderOvernight(payload.overnight)}
        `;
    }

    private _renderComparison(comparison: HousePatternSectionPayload["comparison"]) {
        if (comparison.unavailable) return html`<p class="note" data-comparison-unavailable>${this._t(`pattern.${comparison.unavailable}`)}</p>`;
        const until = Date.parse(comparison.until);
        const values = { weekday: this._weekday(until), time: this._time(until) };
        if (comparison.todayKwh === null) return html`<p class="note" data-no-today>${this._t("pattern.no_today")}</p>`;
        const partial = comparison.comparedHours < comparison.elapsedHours;
        const scale = Math.max(comparison.todayKwh, comparison.averageKwh ?? 0, 0.001);
        return html`
            <div class="bars" data-comparison>
                ${this._bar(fillTemplate(this._t("pattern.today"), values), comparison.todayKwh, scale, "today")}
                ${comparison.averageKwh !== null ? this._bar(fillTemplate(this._t("pattern.usual"), values), comparison.averageKwh, scale, "usual") : nothing}
            </div>
            ${partial ? html`<p class="note" data-partial-today>${fillTemplate(this._t("pattern.partial_today"), {
                compared: String(comparison.comparedHours),
                elapsed: String(comparison.elapsedHours),
            })}</p>` : nothing}
            ${comparison.averageKwh === null
                ? html`<p class="note" data-no-comparison>${fillTemplate(this._t("pattern.no_earlier"), values)}</p>`
                : html`
                    ${this._row(this._t("pattern.difference"), comparison.ratio === null ? this._t("unknown") : this._signedShare(comparison.ratio - 1), "difference")}
                    ${this._row(this._t("pattern.samples"), fillTemplate(this._t("pattern.samples_value"), {
                        used: String(comparison.used),
                        total: String(comparison.days.length),
                        weekday: values.weekday,
                    }), "samples")}
                `}
            <p class="note">${fillTemplate(this._t("pattern.comparison_explain"), values)}</p>
        `;
    }

    private _bar(label: string, kwh: number, scale: number, key: string) {
        return html`
            <div class="bar-row" data-bar=${key}>
                <span class="bar-label">${label}</span>
                <div class="bar-track"><div class="bar-fill" style="width: ${Math.min(100, Math.max(0, kwh) / scale * 100)}%"></div></div>
                <span class="bar-text">${formatGridEnergy(kwh)}</span>
            </div>
        `;
    }

    private _renderOvernight(overnight: HousePatternSectionPayload["overnight"]) {
        const window = fillTemplate(this._t("period_range"), {
            start: this._time(Date.parse(overnight.start)),
            end: overnight.complete ? this._time(Date.parse(overnight.end)) : this._t("pattern.now"),
        });
        if (overnight.unavailable) return html`<p class="note" data-overnight-unavailable>${this._t(`pattern.overnight_${overnight.unavailable}`)}</p>`;
        const minimum = overnight.minimum;
        return html`
            ${this._row(this._t("pattern.overnight"), minimum
                ? fillTemplate(this._t("pattern.overnight_value"), { power: formatPower(Math.max(0, minimum.watts)).display, time: this._time(Date.parse(minimum.at)) })
                : this._t("pattern.overnight_none"), "overnight", fillTemplate(this._t(overnight.complete ? "pattern.overnight_scope" : "pattern.overnight_partial"), { window }))}
            <p class="note">${this._t("pattern.overnight_explain")}</p>
        `;
    }

    private _renderPatternEvidence() {
        const payload = this._patternReady();
        if (!payload) return html`<p class="note">${this._t("loading_history")}</p>`;
        const comparison = payload.comparison;
        const until = Date.parse(comparison.until);
        return html`
            ${comparison.days.length ? html`
                <div class="section-title">${this._t("pattern.days_title")}</div>
                ${comparison.days.map((day) => this._row(
                    this._date(day.date),
                    day.kwh === null
                        ? fillTemplate(this._t("pattern.day_incomplete"), { known: String(day.knownHours), compared: String(comparison.comparedHours) })
                        : formatGridEnergy(day.kwh),
                    `day-${day.date}`,
                ))}
                <p class="note">${fillTemplate(this._t("pattern.days_note"), { time: this._time(until) })}</p>
            ` : nothing}
            ${this._row(this._t("pattern.overnight_coverage"), this._share(payload.overnight.coverage), "overnight-coverage")}
            <div class="section-title">${this._t("pattern.profile_title")}</div>
            ${this._renderProfile(payload.profile)}
        `;
    }

    /** The learned weekday/hour profile: an expectation, Monday first, with its extremes in text. */
    private _renderProfile(profile: HousePatternSectionPayload["profile"]) {
        if (!profile) return html`<p class="note" data-no-profile>${this._t("pattern.no_profile")}</p>`;
        const values = profile.kwh.flat();
        const max = Math.max(...values, 0.001);
        let peak = { day: 0, hour: 0, kwh: -Infinity };
        let low = { day: 0, hour: 0, kwh: Infinity };
        profile.kwh.forEach((row, day) => row.forEach((kwh, hour) => {
            if (kwh > peak.kwh) peak = { day, hour, kwh };
            if (kwh < low.kwh) low = { day, hour, kwh };
        }));
        const dayNames = this._weekdayNames();
        const cell = (day: number, hour: number) => fillTemplate(this._t("pattern.cell"), {
            day: dayNames[day],
            hour: String(hour).padStart(2, "0"),
            kwh: formatGridEnergy(profile.kwh[day][hour]),
        });
        return html`
            <div class="heatmap" data-heatmap role="img" aria-label=${fillTemplate(this._t("pattern.heatmap_summary"), {
                peak: cell(peak.day, peak.hour),
                low: cell(low.day, low.hour),
            })}>
                <span></span>
                ${Array.from({ length: 24 }, (_, hour) => html`<span class="hour">${hour % 6 === 0 ? hour : ""}</span>`)}
                ${profile.kwh.map((row, day) => html`
                    <span class="day">${dayNames[day]}</span>
                    ${row.map((kwh, hour) => html`<span class="cell" title=${cell(day, hour)} style="background: color-mix(in srgb, ${HOUSE_COLOR} ${Math.round(10 + Math.max(0, kwh) / max * 90)}%, transparent)"></span>`)}
                `)}
            </div>
            ${this._row(this._t("pattern.profile_peak"), cell(peak.day, peak.hour), "profile-peak")}
            ${this._row(this._t("pattern.profile_low"), cell(low.day, low.hour), "profile-low")}
            ${this._row(this._t("pattern.profile_history"), fillTemplate(this._t("pattern.profile_history_value"), { days: String(profile.historyDays) }), "profile-history")}
            <p class="note" data-profile-label>${this._t("pattern.profile_note")}</p>
        `;
    }

    // Phases ------------------------------------------------------------------

    private _phaseEstimate(): PhaseEstimate {
        return estimatePhaseLoads(this.params.houseNode, (entityId) => {
            const watts = this._watts(entityId);
            return watts === null ? null : Math.max(0, watts);
        });
    }

    /** A power reading in W through its unit, `null` without one. */
    private _watts(entityId: string | null | undefined): number | null {
        const value = readingNumber(this.hass, entityId);
        const factor = powerUnitFactor(this.hass, entityId);
        return value === null || factor === null ? null : value * factor;
    }

    /** Helman's measured house load per phase, W; `null` unless every phase reads. */
    private _measuredPhases(overview: HouseDetailPayload): PhaseEstimate["perPhase"] | null {
        const [L1, L2, L3] = PHASES.map((_, i) => this._watts(overview.entities[`phase_power_l${i + 1}`]));
        return L1 === null || L2 === null || L3 === null ? null : { L1, L2, L3 };
    }

    private _phasesPreview(overview: HouseDetailPayload, estimate: PhaseEstimate): string {
        const measured = this._measuredPhases(overview);
        if (measured) return PHASES.map((phase) => `${phase} ${formatPower(measured[phase]).display}`).join(" · ");
        if (!estimate.anyMapped) return this._t("phases.none_mapped_short");
        return PHASES.map((phase) => `${phase} ${formatPower(estimate.perPhase[phase]).display}`).join(" · ") + " " + this._t("phases.estimated_tag");
    }

    /**
     * Measured load per phase against what the mapped devices explain, or,
     * while the measured sensors are unavailable, the wiring estimate alone.
     * Each phase lists its devices, and the "No phase" group the rest.
     */
    private _renderPhases(overview: HouseDetailPayload, estimate: PhaseEstimate) {
        const offGrid = overview.condition?.kind === "off_grid";
        const measured = this._measuredPhases(overview);
        if (!measured && !estimate.anyMapped) {
            return html`
                ${offGrid ? this._renderEps(overview) : nothing}
                <p class="note" data-none-mapped>${this._t("phases.none_mapped")}</p>
            `;
        }
        const power = this._powerNow();
        const unknown = estimate.loads.filter((load) => load.phase !== null && load.watts === null);
        const bars = measured ?? estimate.perPhase;
        const scale = Math.max(IDLE_W, ...PHASES.map((phase) => bars[phase]));
        return html`
            ${offGrid ? this._renderEps(overview) : nothing}
            <div class="section-title">${this._t(measured ? "phases.measured_title" : "phases.estimate_title")}</div>
            <div class="bars" data-phase-measured=${measured ? "" : nothing} data-phase-estimate=${measured ? nothing : ""}>
                ${PHASES.map((phase) => html`
                    <div class="phase" data-phase=${phase}>
                        <div class="bar-row">
                            <span class="bar-label">${phase}</span>
                            <div class="bar-track"><div class="bar-fill" style="width: ${Math.max(0, Math.min(100, bars[phase] / scale * 100))}%"></div></div>
                            <span class="bar-text">${measured
                                ? this._phaseComparison(measured[phase], estimate.perPhase[phase])
                                : "≈ " + formatPower(estimate.perPhase[phase]).display}</span>
                        </div>
                        ${this._renderPhaseDevices(phase, estimate)}
                    </div>
                `)}
                ${this._renderPhaseDevices(null, estimate)}
            </div>
            ${this._row(this._t("phases.unassigned"), formatPower(estimate.unassignedW).display, "unassigned", this._t("phases.unassigned_scope"))}
            ${this._row(this._t("phases.coverage"), power !== null && power > IDLE_W
                ? fillTemplate(this._t("phases.coverage_value"), { share: this._share(Math.min(1, estimate.mappedW / power)), power: formatPower(estimate.mappedW).display })
                : formatPower(estimate.mappedW).display, "coverage")}
            ${unknown.length ? html`<p class="note" data-unknown-loads>${fillTemplate(this._t("phases.unknown_loads"), {
                names: unknown.map((load) => this._phaseLoadName(load)).join(", "),
            })}</p>` : nothing}
            ${measured && !estimate.anyMapped ? html`<p class="note" data-none-mapped>${this._t("phases.none_mapped")}</p>` : nothing}
            <p class="note">${this._t(measured ? "phases.measured_explain" : "phases.explain")}</p>
        `;
    }

    /**
     * A phase's measured W, its assigned W and the difference. Within
     * `IDLE_W` of the assignment nothing is unexplained; further below it,
     * more is assigned than measured, most likely a device on another phase.
     */
    private _phaseComparison(measuredW: number, assignedW: number) {
        const difference = measuredW - assignedW;
        return html`
            <span data-measured>${formatPower(measuredW).display}</span>
            · <span data-assigned>${fillTemplate(this._t("phases.assigned_value"), { power: formatPower(assignedW).display })}</span>
            · <span data-difference>${difference < -IDLE_W
                ? fillTemplate(this._t("phases.over_assigned_value"), { power: formatPower(-difference).display })
                : fillTemplate(this._t("phases.unexplained_value"), { power: formatPower(Math.max(0, difference)).display })}</span>
        `;
    }

    /**
     * The loads on `phase`, a three-phase load at its third on each, or with
     * `null` the loads without a phase and the house's own remainder.
     */
    private _renderPhaseDevices(phase: (typeof PHASES)[number] | null, estimate: PhaseEstimate) {
        const rows = estimate.loads
            .filter((load) => phase === null ? load.phase === null : load.phase === phase || load.phase === "3ph")
            .map((load) => ({
                name: this._phaseLoadName(load),
                threePhase: load.phase === "3ph",
                via: load.inheritedFrom,
                watts: load.watts === null ? null : load.phase === "3ph" ? load.watts / 3 : load.watts,
            }));
        if (phase === null) {
            if (estimate.houseRemainderW !== null) rows.push({ name: this._t("phases.house_remainder"), threePhase: false, via: null, watts: estimate.houseRemainderW });
            if (!rows.length) return nothing;
        }
        return html`
            <details class="phase-devices" data-phase-devices=${phase ?? "none"}>
                <summary>${phase === null
                    ? fillTemplate(this._t("phases.devices_no_phase"), { count: String(rows.length) })
                    : fillTemplate(this._t("phases.devices_on"), { phase, count: String(rows.length) })}</summary>
                ${rows.length ? html`
                    <table>
                        <tbody>
                            ${rows.map((row) => html`
                                <tr>
                                    <td>${row.name}${row.threePhase ? html` <span class="tag" data-three-phase>${this._t("phases.three_phase_tag")}</span>` : nothing}${row.via
                                        ? html` <span class="tag" data-via>${fillTemplate(this._t("phases.via"), { name: row.via })}</span>`
                                        : nothing}</td>
                                    <td>${row.watts === null ? this._t("phases.no_reading") : formatPower(row.watts).display}</td>
                                </tr>
                            `)}
                        </tbody>
                    </table>
                ` : html`<p class="note">${this._t("phases.devices_empty")}</p>`}
            </details>
        `;
    }

    /**
     * Off-grid, the inverter's EPS output per phase: measured by the inverter,
     * shown apart from the wiring estimate and never mixed into it, with the
     * battery's time-to-empty at its recent discharge.
     */
    private _renderEps(overview: HouseDetailPayload) {
        const rows = [1, 2, 3].map((phase) => {
            const value = this._reading(overview, `eps_power_l${phase}`);
            return value === null ? nothing : this._row(`L${phase}`, value, `eps-l${phase}`);
        });
        const minutes = readingNumber(this.hass, overview.entities.time_to_empty);
        return html`
            <div class="section-title">${this._t("phases.eps_title")}</div>
            ${rows.every((row) => row === nothing) ? html`<p class="note">${this._t("phases.eps_unavailable")}</p>` : rows}
            ${this._row(this._t("phases.runtime"), minutes === null || minutes <= 0
                ? this._t("phases.runtime_none")
                : fillTemplate(this._t("phases.runtime_value"), { duration: this._duration(minutes) }), "runtime", this._t("phases.runtime_scope"))}
        `;
    }

    /** The measured phases' formula inputs per phase, the formula in words, and the estimate's assumptions. */
    private _renderPhasesEvidence(overview: HouseDetailPayload) {
        const hasInputs = [1, 2, 3].some((phase) => `ac_power_l${phase}` in overview.entities);
        // The meter shown import-positive, whichever way the profile reads it.
        const meterSign = overview.phasePowerPolarity === "positive_is_export" ? -1 : 1;
        const cell = (watts: number | null, sign = 1) => watts === null ? "–" : Math.round(watts * sign) + " W";
        return html`
            ${hasInputs ? html`
                <table data-phase-inputs>
                    <thead><tr>
                        <th>${this._t("phases.input_phase")}</th><th>${this._t("phases.input_inverter")}</th>
                        <th>${this._t("phases.input_meter")}</th><th>${this._t("phases.input_eps")}</th>
                    </tr></thead>
                    <tbody>
                        ${[1, 2, 3].map((phase) => html`
                            <tr data-phase-input=${"L" + phase}>
                                <td>L${phase}</td>
                                <td>${cell(this._watts(overview.entities[`ac_power_l${phase}`]))}</td>
                                <td>${cell(this._watts(overview.entities[`grid_power_l${phase}`]), meterSign)}</td>
                                <td>${cell(this._watts(overview.entities[`eps_power_l${phase}`]))}</td>
                            </tr>
                        `)}
                    </tbody>
                </table>
                <p class="note" data-formula>${this._t("phases.formula")}</p>
            ` : html`<p class="note">${this._t("phases.inputs_none")}</p>`}
            <p class="note">${this._t("phases.assumptions")}</p>
        `;
    }

    private _phaseLoadName(load: PhaseLoad): string {
        return load.own ? fillTemplate(this._t("consumers.own"), { name: load.label }) : load.label;
    }

    // ── Readings and formatting ─────────────────────────────────────────────

    /**
     * The card's live house reading in W, `null` while the sensor has no
     * reading. The card passes the value as read, so the sensor's unit
     * converts it; a unit-less sensor is W, as on the card.
     */
    private _powerNow(): number | null {
        const entityId = this._overview.status === "ready" ? this._overview.payload.entities.power : null;
        if (!entityId || readingNumber(this.hass, entityId) === null) return null;
        const factor = powerUnitFactor(this.hass, entityId);
        return factor === null ? null : this.params.power * factor;
    }

    private _periodText(payload: { period: { start: string }; asOf: string }): string {
        return fillTemplate(this._t("period"), { start: this._time(Date.parse(payload.period.start)), end: this._time(Date.parse(payload.asOf)) });
    }

    private _money(value: number, currency: string | null): string {
        return "≈ " + this._formatMoney(value, currencyFromPriceUnit(currency));
    }

    private _signedShare(share: number): string {
        const rounded = Math.round(share * 100);
        return (rounded > 0 ? "+" : rounded < 0 ? "−" : "±") + Math.abs(rounded) + " %";
    }

    private _weekday(ms: number): string {
        return new Intl.DateTimeFormat(this._locale, { weekday: "long", timeZone: this._timeZone }).format(ms);
    }

    /** Short weekday names, Monday first. 2024-01-01 was a Monday. */
    private _weekdayNames(): string[] {
        const format = new Intl.DateTimeFormat(this._locale, { weekday: "short", timeZone: "UTC" });
        return Array.from({ length: 7 }, (_, day) => format.format(Date.UTC(2024, 0, 1 + day, 12)));
    }

    /** A `YYYY-MM-DD` key as a date, formatted in UTC where noon of the key is that date. */
    private _date(key: string): string {
        return new Intl.DateTimeFormat(this._locale, { weekday: "short", day: "numeric", month: "numeric", timeZone: "UTC" }).format(Date.parse(`${key}T12:00:00Z`));
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "node-detail-house-content": NodeDetailHouseContent;
    }
}
