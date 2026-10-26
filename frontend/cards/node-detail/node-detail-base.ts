import { formatMinutes, formatMoney } from "../shared/format";
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import type { LocalizeFunction } from "../localize/localize";
import type { ForecastPayload, GetNodeDetailRequest, NodeDetailNode, ScheduleActionDTO, SchedulePayload } from "../helman-api";
import { getScheduleActionLabel } from "../shared/schedule/model/schedule-labels";
import { DataChangedController } from "../shared/data/data-changed";
import { ForecastLoader } from "../shared/data/forecast-loader";
import { startNowClock } from "../shared/now-clock";
import { getSharedHelmanStore } from "../shared/data/store";
import { SectionResource, TODAY_REFRESH_MS, hassLocale, timeZone, type SectionOptions, type SectionState } from "./section-resource";
import { ScheduleController, type PlanSpan } from "./schedule-controller";
import { formatScheduleTime } from "../shared/schedule/model/schedule-time";
import { entityName, openMoreInfo, readingNumber, readingText } from "./node-detail-readings";
import { dispatchWatchedEntities } from "../shared/hass-change";

import { IDLE_W } from "./live-flows";
import { LANE_HISTORY_EVENT, type LaneHistory } from "./node-detail-types";
import { forecastChartContext, renderForecastSection, type ForecastChartContext } from "./node-detail-forecast";
import { renderHistorySection, renderTechnicalSection } from "./node-detail-history";

export { IDLE_W };

/** What every node detail overview carries: the entity ids the card reads live. */
export interface NodeDetailOverview {
    /** Metric key → entity id; `null` where the key is known but has no entity. */
    entities: Record<string, string | null>;
    /** The sections the node can be asked for. */
    sections: string[];
}

/**
 * What every energy node's detail shares: the overview read from
 * `helman/get_node_detail` and kept current, the Forecast, History &
 * statistics and Technical details sections around a subclass's content, and
 * the rows and formatting their bodies use.
 *
 * The overview is re-read when the states `_signatureEntities` names change,
 * and with `fresh` on every shared data change, whose contract is to reload
 * everything shown. A request counter keeps an older response from
 * overwriting a newer one, and a refresh that fails keeps what was shown.
 *
 * Everything else is a section a subclass declares with `_section`: each is
 * read while its `shown()` holds, kept current while the page is visible,
 * re-read after the overview on every shared data change and dropped once
 * hidden. A section a header summary needs is shown from the opening; one
 * only a body needs, once that body is open.
 *
 * What is read off the clock (the slot in progress, the next change, "today
 * so far") stays current with the shared now-clock, which pauses while the
 * page is hidden: the detail renders again once the next of
 * `_clockBoundaries` passes, and at least every {@link TODAY_REFRESH_MS}.
 * The forecast, once a subclass asks for it, is reloaded on every shared
 * data change; a load that fails with nothing to show sets `_forecastFailed`.
 * The plan, once a subclass asks for it with `_useSchedule`, is followed while
 * started, its runs read once per update, and the detail renders again as a
 * run starts or ends.
 */
export abstract class NodeDetailContentBase<O extends NodeDetailOverview> extends LitElement {
    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;

    @state() protected _overview: SectionState<O> = { status: "loading" };
    @state() protected _forecast: ForecastPayload | null = null;
    /** The forecast could not be loaded and nothing earlier is shown. */
    @state() protected _forecastFailed = false;
    /** Whether each section is open; every opening starts closed. */
    @state() protected _forecastOpen = false;
    @state() protected _historyOpen = false;
    @state() protected _technicalOpen = false;

    /** The node the detail asks `helman/get_node_detail` for, and its localize namespace. */
    protected abstract readonly _node: NodeDetailNode;

    protected _started = false;
    private _overviewRequest = 0;
    /** The signature of the states the current overview was computed from. */
    private _overviewStates = "";
    private readonly _forecastLoader = new ForecastLoader();
    private _forecastRequest = 0;
    private _forecastRequested = false;
    /** When the clock next moves something shown; the now-clock re-renders then. */
    private _nextBoundary = Infinity;
    private _stopClock?: () => void;
    /** The lane history last reported, as its key: reported again only once it changes. */
    private _laneHistoryKey = "";
    /** The plan, for a detail that reads it. */
    private _scheduleController: ScheduleController<PlanSpan> | null = null;
    /** Every section the detail reads, in the order they are read; the base reads, refreshes and drops them. */
    protected readonly _sections: SectionResource<unknown>[] = [];

    constructor() {
        super();
        new DataChangedController(this, () => this.hass, {}, () => void this._onDataChanged());
    }

    connectedCallback(): void {
        super.connectedCallback();
        if (this.hass) this._start();
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this._started = false;

        this._stopClock?.();
        this._stopClock = undefined;
        // Whatever is still in flight answers nobody.
        this._overviewRequest += 1;
        this._forecastRequest += 1;
        for (const section of this._sections) section.cancel();
        this._scheduleController?.stop();
        this._stop();
    }

    willUpdate(changed: Map<string, unknown>): void {
        this._scheduleController?.reset();
        if (changed.has("hass") && this.hass) {
            if (!this._started) this._start();
            else if (this._overview.status === "ready" && this._overviewSignature(this._overview.payload) !== this._overviewStates) {
                void this._loadOverview();
            }
        }
        if (this._started) for (const section of this._sections) section.sync();
    }

    protected _start(): void {
        this._started = true;
        this._scheduleController?.start(this.hass);
        // Paused while the page is hidden; a returning reader catches up at once.
        this._stopClock = startNowClock(() => {
            if (Date.now() >= this._nextBoundary) this.requestUpdate();
        });
        void this._loadOverview();
        // The sections shown follow in the update.
        this.requestUpdate();
    }

    /** Undo what a subclass's `_start` began. */
    protected _stop(): void {}

    /**
     * A new plan or config (an optimizer run, another client) can change
     * everything shown: the feed's contract is to reload it all. The sections
     * follow the overview, which says which of them are offered.
     */
    protected async _onDataChanged(): Promise<void> {
        const overview = this._loadOverview(true);
        if (this._forecastRequested) {
            this._forecastLoader.invalidate();
            void this._loadForecast();
        }
        await overview;
        if (!this._started) return;
        for (const section of this._sections) section.reload();
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
        for (const at of this._scheduleController?.boundaries() ?? []) if (at > now && at < next) next = at;
        this._nextBoundary = next;
    }

    /**
     * The entities whose live states the backend computed the overview from:
     * when one changes, the overview is read again. The run mode by default.
     */
    protected _signatureEntities(payload: O): Array<string | null | undefined> {
        return [payload.entities.run_mode];
    }

    private _overviewSignature(payload: O): string {
        return this._signatureEntities(payload).map((id) => (id ? this.hass.states[id]?.state ?? "" : "")).join("|");
    }

    /** Every entity id the detail reads live; the card watches them while it is open. */
    protected _watchedEntities(payload: O): Iterable<string | null | undefined> {
        return Object.values(payload.entities);
    }

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
            dispatchWatchedEntities(this, "node-detail", this._watchedEntities(payload));
        } catch (error) {
            if (request !== this._overviewRequest) return;
            console.error(`node-detail-${this._node}: failed to load the overview`, error);
            // A refresh that fails keeps what was shown, with its own as-of.
            if (this._overview.status !== "ready") this._overview = { status: "error" };
        }
    }

    /** The `helman/get_node_detail` request for the overview, or for `section`. */
    protected _detailRequest(section?: string): GetNodeDetailRequest {
        return section ? { node: this._node, section } : { node: this._node };
    }

    /** Read the plan, with `read` making its runs; the base follows it and renders again at their boundaries. */
    protected _useSchedule<R extends PlanSpan>(read: (schedule: SchedulePayload, now: number) => R[]): ScheduleController<R> {
        const controller = new ScheduleController(this, read);
        this._scheduleController = controller;
        return controller;
    }

    /** Report what the node's lane did today to the Schedule section, once it changed. */
    protected _reportLaneHistory(history: LaneHistory): void {
        const key = JSON.stringify(history);
        if (key === this._laneHistoryKey) return;
        this._laneHistoryKey = key;
        this.dispatchEvent(new CustomEvent<LaneHistory>(LANE_HISTORY_EVENT, { detail: history, bubbles: true }));
    }

    /** Declare a section the detail reads; the base reads, refreshes and drops it. */
    protected _section<T>(name: string, options: SectionOptions<T>): SectionResource<T> {
        const section = new SectionResource(this, name, options);
        this._sections.push(section);
        return section;
    }

    /** Whether the overview has landed and offers `section`. */
    protected _offers(section: string): boolean {
        return this._overview.status === "ready" && this._overview.payload.sections.includes(section);
    }

    /** A fresh read of the node's `section` from `helman/get_node_detail`. */
    protected _readSection<T>(section: string): Promise<T> {
        return getSharedHelmanStore(this.hass).getNodeDetail<T>(this._detailRequest(section), { fresh: true });
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

    // ── Rendering ───────────────────────────────────────────────────────────

    /**
     * The detail's body: the Overview, then the Schedule section the dialog
     * slots in, then the node's own Forecast, History & statistics and
     * Technical details sections.
     */
    render() {
        const overview = this._overview.status === "ready" ? this._overview.payload : null;
        return html`
            <div class="overview">${this._renderNotReady() ?? this._renderOverview(overview!)}</div>
            <slot name="schedule"></slot>
            ${overview ? this._renderForecast(overview) : nothing}
            ${overview ? this._renderHistory(overview) : nothing}
            ${overview ? renderTechnicalSection(this.hass, this.localize, this._technicalOpen, (open) => { this._technicalOpen = open; },
                () => this._renderTechnical(overview)) : nothing}
        `;
    }

    /** The Overview, once the overview landed. */
    protected abstract _renderOverview(overview: O): TemplateResult;

    /** The Forecast section; none by default, and none while there is nothing to show. */
    protected _renderForecast(_overview: O): TemplateResult | typeof nothing {
        return nothing;
    }

    /** The History & statistics section; none while there is nothing to show. */
    protected abstract _renderHistory(overview: O): TemplateResult | typeof nothing;

    /** The Technical details body, shown to admins only. */
    protected abstract _renderTechnical(overview: O): TemplateResult;

    /** The Forecast section around `summary`, its body rendered only while open. */
    protected _forecastSection(summary: TemplateResult | string, body: () => TemplateResult): TemplateResult {
        return renderForecastSection(this.localize, summary, this._forecastOpen, (open) => { this._forecastOpen = open; }, body);
    }

    /** The History & statistics section around `summary`, its body rendered only while open. */
    protected _historySection(summary: TemplateResult | string, body: () => TemplateResult): TemplateResult {
        return renderHistorySection(this.localize, summary, this._historyOpen, (open) => { this._historyOpen = open; }, body);
    }

    /**
     * The forecast-based Forecast section: `null` while the forecast loads,
     * the failure with its retry when none could be loaded, else `ready`.
     */
    protected _forecastPending(): TemplateResult | typeof nothing | null {
        if (this._forecast) return null;
        return this._forecastFailed ? this._forecastSection(this.localize("node_detail.forecast_failed"), () => this._renderForecastFailed()) : nothing;
    }

    /** Where and when the forecast charts draw. */
    protected get _chartContext(): ForecastChartContext {
        return forecastChartContext(this.hass, this.localize);
    }

    /** The one exception a detail shows. */
    protected _exceptionBanner(text: string) {
        return html`
            <div class="exception" role="status" data-exception>
                <span>${text}</span>
            </div>
        `;
    }

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
        openMoreInfo(this, entityId);
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
        return entityName(this.hass, entityId);
    }

    // ── Formatting ──────────────────────────────────────────────────────────

    protected get _timeZone(): string {
        return timeZone(this.hass);
    }

    protected get _locale(): string {
        return hassLocale(this.hass);
    }

    protected _time(ms: number): string {
        return formatScheduleTime(ms, this._locale, this._timeZone);
    }

    protected _share(share: number): string {
        return Math.round(share * 100) + " %";
    }

    protected _duration(minutes: number): string {
        return formatMinutes(minutes);
    }

    protected _formatMoney(value: number, currency: string): string {
        return formatMoney(value, currency);
    }

    protected _t(key: string): string {
        return this.localize(`node_detail.${this._node}.${key}`);
    }

    /** A History & statistics or Technical details string. */
    protected _h(key: string): string {
        return this.localize(`node_detail.shared.history.${key}`);
    }
}
