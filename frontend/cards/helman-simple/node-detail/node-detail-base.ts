import { LitElement, html, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../../types/ha";
import { fillTemplate, type LocalizeFunction } from "../../localize/localize";
import type { FlowsSectionPayload, ForecastPayload, GetNodeDetailRequest, NodeDetailNode, ScheduleActionDTO } from "../../helman-api";
import { getScheduleActionLabel } from "../../shared/schedule/model/schedule-labels";
import type { HelmanSolarInspectorCardConfig } from "../../helman-solar-inspector/HelmanSolarInspectorCardConfig";
import { getSharedDataChangedFeed } from "../../helman/data-changed";
import { ForecastLoader } from "../../helman/forecast-loader";
import { startNowClock } from "../../shared/now-clock";
import { isoDateInTimeZone, todayIso } from "../../shared/today-iso";
import { getSharedHelmanStore } from "../../helman/store";
import { formatScheduleTime } from "../../shared/schedule/model/schedule-time";
import {
    EVIDENCE_TOGGLE_EVENT,
    QUESTION_TOGGLE_EVENT,
    type QuestionToggleDetail,
} from "../../shared/node-question";
import "../../shared/node-question";
import "../../shared/node-tile";
import "../../shared/node-flow";
import { FLOW_SCOPE_EVENT, type FlowItem, type FlowScope, type FlowScopeDetail } from "../../shared/node-flow";
import type { ScheduleActionTone } from "../../shared/schedule/action-tones";
import { announceWatchedEntities, readingNumber, readingText } from "./node-detail-readings";

import { IDLE_W } from "../live-flows";

export { IDLE_W };

/** How stale a "today so far" answer may get before it is re-read, while visible. */
export const TODAY_REFRESH_MS = 5 * 60_000;

/** Retry an answer from the previous day without issuing a read on every power tick. */
export const NEW_DAY_RETRY_MS = 30_000;

/** The Today flow is drawn at the Now scale × this many hours, kWh. */
export const TODAY_SCALE_HOURS = 4;

/** What a node's flow draws in one scope. */
export interface NodeFlow {
    scopeLabel: string;
    inputs: FlowItem[];
    outputs: FlowItem[];
    totalIn: string | null;
    totalOut: string | null;
    notes: string[];
    /** The node's own figure under its glyph: its power on Now, its kWh on Today; `null` is "–". */
    centreValue: string | null;
    /** Whether the node is working now: its power is above {@link IDLE_W}; never on Today. */
    active: boolean;
}

/** An energy node a flow's ribbon can lead to; its colour is `--helman-<node>`. */
export type FlowNode = "solar" | "grid" | "battery" | "house";

export type SectionState<T> =
    | { status: "loading" }
    | { status: "ready"; payload: T }
    | { status: "error" };

/** What every node detail overview carries: the entity ids the card reads live. */
export interface NodeDetailOverview {
    /** Metric key → entity id; `null` where the key is known but has no entity. */
    entities: Record<string, string | null>;
}

type InspectorCardElement = HTMLElement & {
    setConfig(config: HelmanSolarInspectorCardConfig): void;
    hass: unknown;
};

/**
 * What the inverter, grid and battery details share: the overview read from
 * `helman/get_node_detail` and kept current, the question disclosure, the
 * focused inspector embeds and the rows and formatting their answers use.
 *
 * The overview is re-read when the states `_overviewSignature` names change,
 * and with `fresh` on every shared data change, whose contract is to reload
 * everything shown: a subclass adds its own data in `_onDataChanged`. A
 * request counter keeps an older response from overwriting a newer one, and a
 * refresh that fails keeps what was shown.
 *
 * One question is open at a time; `_setOpen` is the hook a subclass extends to
 * request what the opened answer needs. Embeds are created once per question
 * and handed `hass` only while they are in the page.
 *
 * What is read off the clock (the slot in progress, the next change, "today
 * so far") stays current with the shared now-clock, which pauses while the
 * page is hidden: the detail renders again once the next of
 * `_clockBoundaries` passes, and at least every {@link TODAY_REFRESH_MS}.
 * The forecast, once a subclass asks for it, is reloaded on every shared
 * data change; a load that fails with nothing to show sets `_forecastFailed`.
 *
 * The node's flow opens on Now, from the card's live split. Today's flows are
 * the node's `flows` section, requested only once Today is chosen and kept
 * current like any "today so far" answer while it is shown.
 */
export abstract class NodeDetailContentBase<O extends NodeDetailOverview, Q extends string> extends LitElement {
    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;

    @state() protected _overview: SectionState<O> = { status: "loading" };
    @state() protected _open: Q | null = null;
    @state() protected _evidenceOpen = false;
    @state() protected _forecast: ForecastPayload | null = null;
    /** The forecast could not be loaded and nothing earlier is shown. */
    @state() protected _forecastFailed = false;
    /** Which scope the node's flow shows; every opening starts on Now. */
    @state() protected _flowScope: FlowScope = "now";
    /** Today's flows; `null` until Today is first chosen. */
    @state() protected _todayFlows: SectionState<FlowsSectionPayload> | null = null;

    /** The node the detail asks `helman/get_node_detail` for, and its localize namespace. */
    protected abstract readonly _node: NodeDetailNode;

    protected _started = false;
    private _overviewRequest = 0;
    /** The signature of the states the current overview was computed from. */
    private _overviewStates = "";
    private _unsubscribeDataChanged?: () => void;
    private readonly _inspectors = new Map<string, InspectorCardElement>();
    private readonly _forecastLoader = new ForecastLoader();
    private _forecastRequest = 0;
    private _forecastRequested = false;
    /** When the clock next moves something shown; the now-clock re-renders then. */
    private _nextBoundary = Infinity;
    private _stopClock?: () => void;
    private _todayFlowsRequest = 0;
    private _todayFlowsRequestedAt = 0;

    connectedCallback(): void {
        super.connectedCallback();
        this.addEventListener(QUESTION_TOGGLE_EVENT, this._onQuestionToggle as EventListener);
        this.addEventListener(EVIDENCE_TOGGLE_EVENT, this._onEvidenceToggle as EventListener);
        this.addEventListener(FLOW_SCOPE_EVENT, this._onFlowScope as EventListener);
        if (this.hass) this._start();
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this.removeEventListener(QUESTION_TOGGLE_EVENT, this._onQuestionToggle as EventListener);
        this.removeEventListener(EVIDENCE_TOGGLE_EVENT, this._onEvidenceToggle as EventListener);
        this.removeEventListener(FLOW_SCOPE_EVENT, this._onFlowScope as EventListener);
        this._started = false;
        this._unsubscribeDataChanged?.();
        this._unsubscribeDataChanged = undefined;
        this._stopClock?.();
        this._stopClock = undefined;
        // Whatever is still in flight answers nobody.
        this._overviewRequest += 1;
        this._forecastRequest += 1;
        this._todayFlowsRequest += 1;
        // A dropped load would otherwise stay "loading" after a reconnect.
        if (this._todayFlows?.status === "loading") this._todayFlows = null;
        this._stop();
    }

    willUpdate(changed: Map<string, unknown>): void {
        if (changed.has("hass") && this.hass) {
            if (!this._started) this._start();
            else if (this._overview.status === "ready" && this._overviewSignature(this._overview.payload) !== this._overviewStates) {
                void this._loadOverview();
            }
            // Only the open evidence's embed is in the page; a closed one waits.
            for (const card of this._inspectors.values()) if (card.isConnected) card.hass = this.hass;
        }
        // Today's flows are "today so far": re-read on a new day, and otherwise
        // at most every few minutes, only while shown and the page is visible.
        if (this._flowScope === "today" && this._todaySection().state?.status === "ready" && !document.hidden && this._todayStale()) {
            void this._loadTodayFlows();
        }
    }

    protected _start(): void {
        this._started = true;
        // Paused while the page is hidden; a returning reader catches up at once.
        this._stopClock = startNowClock(() => {
            if (Date.now() >= this._nextBoundary) this.requestUpdate();
        });
        // A new plan or config (an optimizer run, another client) can change
        // everything shown: the feed's contract is to reload it all.
        this._unsubscribeDataChanged = getSharedDataChangedFeed(this.hass).subscribe(() => this._onDataChanged());
        void this._loadOverview();
        if (this._flowScope === "today" && this._todayStale()) void this._loadTodayFlows();
    }

    /** Undo what a subclass's `_start` began; requests in flight are dropped. */
    protected _stop(): void {}

    /** Reload everything shown; a subclass adds its own data. */
    protected _onDataChanged(): void {
        void this._loadOverview(true);
        if (this._flowScope === "today") void this._loadTodayFlows();
        if (this._forecastRequested) {
            this._forecastLoader.invalidate();
            void this._loadForecast();
        }
    }

    /** The future instants at which something shown changes; none by default. */
    protected _clockBoundaries(): Iterable<number> {
        return [];
    }

    protected updated(changed: Map<string, unknown>): void {
        super.updated(changed);
        const now = Date.now();
        let next = now + TODAY_REFRESH_MS;
        for (const at of this._clockBoundaries()) if (at > now && at < next) next = at;
        this._nextBoundary = next;
    }

    /** Whether a period that starts at `start` is today in HA's time zone. */
    protected _isToday(start: string): boolean {
        return isoDateInTimeZone(new Date(start), this._timeZone) === todayIso(this._timeZone);
    }

    /**
     * The live states the backend computed the overview from: when they change,
     * the overview is read again. Nothing by default.
     */
    protected _overviewSignature(_payload: O): string {
        return "";
    }

    /** Every entity id the detail reads live; the card watches them while it is open. */
    protected _watchedEntities(payload: O): Iterable<string | null | undefined> {
        return Object.values(payload.entities);
    }

    /** Called with each overview that lands. */
    protected _overviewLoaded(_payload: O): void {}

    // ── Data ────────────────────────────────────────────────────────────────

    /** `fresh`: never join a request sent before a change was announced. */
    protected async _loadOverview(fresh = false): Promise<void> {
        const request = ++this._overviewRequest;
        const previous = this._overview.status === "ready" ? this._overview.payload : undefined;
        // A refresh compares the states as they are now, when it is sent: a
        // change while it is in flight re-reads, a failure does not.
        if (previous) this._overviewStates = this._overviewSignature(previous);
        else this._overview = { status: "loading" };
        try {
            const payload = await getSharedHelmanStore(this.hass)
                .getNodeDetail<O>(this._detailRequest(), { fresh: fresh || previous !== undefined });
            if (request !== this._overviewRequest) return;
            if (!previous) this._overviewStates = this._overviewSignature(payload);
            this._overview = { status: "ready", payload };
            announceWatchedEntities(this, this._watchedEntities(payload));
            this._overviewLoaded(payload);
        } catch (error) {
            if (request !== this._overviewRequest) return;
            console.error(`node-detail-${this._node}: failed to load the overview`, error);
            // A refresh that fails keeps what was shown, with its own as-of.
            if (this._overview.status !== "ready") this._overview = { status: "error" };
        }
    }

    /** The `helman/get_node_detail` request for the overview, or for `section`. */
    protected _detailRequest(section?: string): Omit<GetNodeDetailRequest, "type"> {
        return section ? { node: this._node, section } : { node: this._node };
    }

    /**
     * The section the Today flow draws, as loaded, and when it was last
     * requested: the node's `flows` section by default. A node whose Today is
     * another section returns that one, with `_loadTodayFlows` loading it, so
     * the refresh, the retry and the scope label all read the one it shows.
     */
    protected _todaySection(): { state: SectionState<{ period: { start: string }; asOf: string }> | null; requestedAt: number } {
        return { state: this._todayFlows, requestedAt: this._todayFlowsRequestedAt };
    }

    /** Whether today's section needs a read: none yet, from another day, or older than the refresh period. */
    protected _todayStale(): boolean {
        const { state, requestedAt } = this._todaySection();
        if (state?.status !== "ready") return true;
        const age = Date.now() - requestedAt;
        return age > TODAY_REFRESH_MS
            || (!this._isToday(state.payload.period.start) && age > NEW_DAY_RETRY_MS);
    }

    /** Today's flows, the node's `flows` section; a refresh keeps the day's figures on screen. */
    protected async _loadTodayFlows(): Promise<void> {
        const request = ++this._todayFlowsRequest;
        if (this._todayFlows?.status !== "ready" || !this._isToday(this._todayFlows.payload.period.start)) {
            this._todayFlows = { status: "loading" };
        }
        this._todayFlowsRequestedAt = Date.now();
        try {
            const payload = await getSharedHelmanStore(this.hass)
                .getNodeDetail<FlowsSectionPayload>(this._detailRequest("flows"), { fresh: true });
            if (request !== this._todayFlowsRequest) return;
            this._todayFlows = { status: "ready", payload };
        } catch (error) {
            if (request !== this._todayFlowsRequest) return;
            console.error(`node-detail-${this._node}: failed to load today's flows`, error);
            if (this._todayFlows?.status !== "ready") this._todayFlows = { status: "error" };
        }
    }

    /** The forecast, kept on a failed refresh; reloaded on shared changes once asked for. */
    protected async _loadForecast(): Promise<void> {
        this._forecastRequested = true;
        const request = ++this._forecastRequest;
        if (this._forecast === null) this._forecastFailed = false;
        const forecast = await this._forecastLoader.refresh(this.hass);
        if (!this._started || request !== this._forecastRequest) return;
        if (forecast) {
            this._forecast = forecast;
            this._forecastFailed = false;
        } else if (this._forecast === null) {
            this._forecastFailed = true;
        }
    }

    // ── Disclosure ──────────────────────────────────────────────────────────

    private _onQuestionToggle = (event: CustomEvent<QuestionToggleDetail>): void => {
        event.stopPropagation();
        const id = event.detail.id as Q;
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

    private _onFlowScope = (event: CustomEvent<FlowScopeDetail>): void => {
        event.stopPropagation();
        this._flowScope = event.detail.scope;
        // Requested only once Today is chosen; Now needs nothing but the card.
        if (this._flowScope === "today") {
            if (this._todayStale()) void this._loadTodayFlows();
        } else {
            this._todayFlowsRequest += 1;
            // A dropped load would otherwise leave Today "loading" when chosen again.
            if (this._todayFlows?.status === "loading") this._todayFlows = null;
        }
    };

    /** Open `id`, closing the open one and its evidence. */
    protected _setOpen(id: Q | null): void {
        this._open = id;
        this._evidenceOpen = false;
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    /** The overview while it is loading or failed; `null` once it is ready. */
    protected _renderNotReady(): TemplateResult | null {
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
        return null;
    }

    /** One question; its answer and evidence are rendered only while open. */
    protected _question(
        id: Q,
        preview: string | null,
        answer: () => TemplateResult,
        evidence: () => TemplateResult | typeof nothing,
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

    /**
     * One question as a tile: its answer's value, an optional mini graphic and
     * the question as the caption. Its answer opens through `_question`, which
     * a tiled detail renders only for the open question, under the tiles. A
     * tile names an action in its `tone`, or a flow in its `accent` colour.
     */
    protected _tile(id: Q, value: string, detail: string | null, graphic: TemplateResult | typeof nothing = nothing, tone: ScheduleActionTone | null = null, accent: string | null = null) {
        return html`
            <helman-node-tile
                data-question=${id}
                question-id=${id}
                .question=${this._t(`q.${id}`)}
                .value=${value}
                .detail=${detail}
                .tone=${tone}
                .accent=${accent}
                ?open=${this._open === id}
            >${graphic}</helman-node-tile>
        `;
    }

    // ── Flow ────────────────────────────────────────────────────────────────

    /**
     * The node's flow in the scope shown, on the fixed scale: the Now scale
     * is the card's, W; Today's is that × {@link TODAY_SCALE_HOURS}, kWh. A
     * tap on either side opens `questionId`, or on the destinations
     * `outputQuestionId` when given; `centre` is the node's glyph.
     */
    protected _renderFlow(flow: NodeFlow, scaleW: number, questionId: Q, centre: TemplateResult, outputQuestionId: Q | null = null) {
        const now = this._flowScope === "now";
        return html`
            <helman-node-flow
                data-flow-scope=${this._flowScope}
                .scope=${this._flowScope}
                .scopeLabel=${flow.scopeLabel}
                .nowLabel=${this.localize("node_detail.flow.now")}
                .todayLabel=${this.localize("node_detail.flow.today")}
                .inputs=${flow.inputs}
                .outputs=${flow.outputs}
                .scale=${now ? scaleW : scaleW * TODAY_SCALE_HOURS / 1000}
                .totalIn=${flow.totalIn}
                .totalOut=${flow.totalOut}
                .notes=${flow.notes}
                .centreValue=${flow.centreValue}
                ?active=${now && flow.active}
                ?animated=${now}
                question-id=${questionId}
                .questionLabel=${this._t(`q.${questionId}`)}
                output-question-id=${outputQuestionId ?? nothing}
                .outputQuestionLabel=${outputQuestionId ? this._t(`q.${outputQuestionId}`) : ""}
            >${centre}</helman-node-flow>
            ${!now && this._todaySection().state?.status === "error" ? html`
                <button class="link-button" @click=${() => this._loadTodayFlows()}>${this._t("retry")}</button>
            ` : nothing}
        `;
    }

    /** "Now · 21:08". */
    protected _nowScopeLabel(): string {
        return fillTemplate(this.localize("node_detail.flow.scope_now"), { time: this._time(Date.now()) });
    }

    /** "Today · 00:00–21:08", to the as-of of today's section once it landed. */
    protected _todayScopeLabel(): string {
        const state = this._todaySection().state;
        return fillTemplate(this.localize("node_detail.flow.scope_today"), {
            time: this._time(state?.status === "ready" ? Date.parse(state.payload.asOf) : Date.now()),
        });
    }

    /** Why Today has no flows to draw: loading, failed or unavailable; `null` once it has them. */
    protected _todayFlowsNote(): string | null {
        const section = this._todayFlows;
        if (section === null || section.status === "loading") return this.localize("node_detail.flow.loading");
        if (section.status === "error") return this.localize("node_detail.flow.failed");
        if (!section.payload.flows) return this.localize(`node_detail.flow.unavailable_${section.payload.unavailable ?? "not_loaded"}`);
        return null;
    }

    /** A source or destination, in the colour of the node at its other end. */
    protected _flowItem(node: FlowNode, value: number | null, format: (value: number | null) => string): FlowItem {
        return {
            id: node,
            label: this.localize(`node_detail.title.${node}`),
            value,
            display: format(value),
            color: `var(--helman-${node})`,
        };
    }

    /** Whether a power, W, of either sign is above {@link IDLE_W}: the node is working. */
    protected _isActive(power: number | null): boolean {
        return power !== null && Math.abs(power) > IDLE_W;
    }

    /** Both sides' sums as one centre value, in · out; `null` when neither is known. */
    protected _centrePair(sumIn: number | null, sumOut: number | null, format: (value: number | null) => string): string | null {
        return sumIn === null && sumOut === null ? null : `${format(sumIn)} · ${format(sumOut)}`;
    }

    /**
     * Each side's sum, with energy that went in or out by no known route
     * added to its side, as a number (`sumIn`, `sumOut`) and as shown; a side
     * is unknown when any of its items is.
     */
    protected _flowTotals(inputs: FlowItem[], outputs: FlowItem[], format: (value: number | null) => string, unresolvedIn = 0, unresolvedOut = 0) {
        const sum = (items: FlowItem[]) => items.some((item) => item.value === null) ? null : items.reduce((total, item) => total + item.value!, 0);
        const total = (key: "total_in" | "total_out", value: number | null) =>
            value === null ? null : fillTemplate(this.localize(`node_detail.flow.${key}`), { value: format(value) });
        const sumIn = sum(inputs);
        const sumOut = sum(outputs);
        const withIn = sumIn === null ? null : sumIn + unresolvedIn;
        const withOut = sumOut === null ? null : sumOut + unresolvedOut;
        return { totalIn: total("total_in", withIn), totalOut: total("total_out", withOut), sumIn: withIn, sumOut: withOut };
    }

    /** The focused inspector embed of `id` (a question, or its evidence), created once and kept. */
    protected _inspector(id: string, config: HelmanSolarInspectorCardConfig): HTMLElement {
        let card = this._inspectors.get(id);
        if (!card) {
            card = document.createElement("helman-solar-inspector-card") as InspectorCardElement;
            card.setConfig(config);
            this._inspectors.set(id, card);
        }
        card.hass = this.hass;
        return card;
    }

    /** Why a forecast-based answer has nothing to show, with a retry. */
    protected _renderForecastFailed() {
        return html`
            <p class="note" data-forecast-failed>${this.localize("node_detail.forecast_failed")}</p>
            <button class="link-button" @click=${() => this._loadForecast()}>${this._t("retry")}</button>
        `;
    }

    // ── Rows and readings ───────────────────────────────────────────────────

    /**
     * A labelled value. With `entityId` the value is that entity's reading,
     * and a button that opens its more-info; a calculated figure has none and
     * stays plain.
     */
    protected _row(label: string, value: string, key?: string, scope?: string, entityId?: string | null) {
        return html`
            <div class="row" data-row=${key ?? nothing}>
                <span class="label">${label}${scope ? html`<br><span class="note">${scope}</span>` : nothing}</span>
                ${entityId ? html`
                    <button class="value reading" data-entity=${entityId} title=${this._name(entityId)} @click=${() => this._moreInfo(entityId)}>${value}</button>
                ` : html`<span class="value">${value}</span>`}
            </div>
        `;
    }

    /** A technical row, hidden when its reading is unavailable; its value opens the entity's more-info. */
    protected _optionalRow(overview: O, key: string, labelKey: string) {
        const value = this._reading(overview, key);
        return value === null ? nothing : this._row(this._t(labelKey), value, key, undefined, overview.entities[key]);
    }

    /** HA's own more-info dialog for `entityId`, as the card's device rows open it. */
    protected _moreInfo(entityId: string): void {
        this.dispatchEvent(new CustomEvent("hass-more-info", {
            bubbles: true,
            composed: true,
            detail: { entityId },
        }));
    }

    /** A reading as shown: its state and unit, `null` when missing or unavailable. */
    protected _reading(overview: O, key: string): string | null {
        return readingText(this.hass, overview.entities[key], (on) => this._t(on ? "on" : "off"));
    }

    protected _number(overview: O, key: string): number | null {
        return readingNumber(this.hass, overview.entities[key]);
    }

    /**
     * A non-negative reading in a base unit, through `scale` (unit → factor);
     * `null` when missing, negative or in a unit `scale` does not know.
     */
    protected _scaled(overview: O, key: string, scale: Record<string, number>): number | null {
        const value = this._number(overview, key);
        const entityId = overview.entities[key];
        const unit = entityId ? this.hass.states[entityId]?.attributes.unit_of_measurement as string | undefined : undefined;
        const factor = unit ? scale[unit] : undefined;
        return value === null || factor === undefined || value < 0 ? null : value * factor;
    }

    protected _actionLabel(action: ScheduleActionDTO): string {
        return getScheduleActionLabel(action, this.localize);
    }

    protected _name(entityId: string): string {
        return (this.hass.states[entityId]?.attributes.friendly_name as string | undefined) ?? entityId;
    }

    // ── Formatting ──────────────────────────────────────────────────────────

    protected get _timeZone(): string {
        return this.hass.config?.time_zone || "UTC";
    }

    protected get _locale(): string {
        return this.hass.locale?.language ?? this.hass.language ?? "cs";
    }

    protected _time(ms: number): string {
        return formatScheduleTime(ms, this._locale, this._timeZone);
    }

    protected _share(share: number): string {
        return Math.round(share * 100) + " %";
    }

    /** Minutes as "1 h 5 min", rounded once, so 119.7 reads 2 h 0 min, never 1 h 60 min. */
    protected _duration(minutes: number): string {
        const total = Math.round(minutes);
        const hours = Math.floor(total / 60);
        return hours > 0 ? `${hours} h ${total % 60} min` : `${total} min`;
    }

    protected _formatMoney(value: number, currency: string): string {
        return (value.toFixed(2) + " " + currency).trim();
    }

    protected _t(key: string): string {
        return this.localize(`node_detail.${this._node}.${key}`);
    }
}
