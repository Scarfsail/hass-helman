import { LitElement, html, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../../hass-frontend/src/types";
import type { LocalizeFunction } from "../../localize/localize";
import type { ForecastPayload, GetNodeDetailRequest, NodeDetailNode, ScheduleActionDTO } from "../../helman-api";
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
import { announceWatchedEntities, readingNumber, readingText } from "./node-detail-readings";

/** How stale a "today so far" answer may get before it is re-read, while visible. */
export const TODAY_REFRESH_MS = 5 * 60_000;

/** Below this many watts either way a flow counts as idle, as on the card. */
export const IDLE_W = 50;

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

    connectedCallback(): void {
        super.connectedCallback();
        this.addEventListener(QUESTION_TOGGLE_EVENT, this._onQuestionToggle as EventListener);
        this.addEventListener(EVIDENCE_TOGGLE_EVENT, this._onEvidenceToggle as EventListener);
        if (this.hass) this._start();
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this.removeEventListener(QUESTION_TOGGLE_EVENT, this._onQuestionToggle as EventListener);
        this.removeEventListener(EVIDENCE_TOGGLE_EVENT, this._onEvidenceToggle as EventListener);
        this._started = false;
        this._unsubscribeDataChanged?.();
        this._unsubscribeDataChanged = undefined;
        this._stopClock?.();
        this._stopClock = undefined;
        // Whatever is still in flight answers nobody.
        this._overviewRequest += 1;
        this._forecastRequest += 1;
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
    }

    /** Undo what a subclass's `_start` began; requests in flight are dropped. */
    protected _stop(): void {}

    /** Reload everything shown; a subclass adds its own data. */
    protected _onDataChanged(): void {
        void this._loadOverview(true);
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

    protected _row(label: string, value: string, key?: string, scope?: string) {
        return html`
            <div class="row" data-row=${key ?? nothing}>
                <span class="label">${label}${scope ? html`<br><span class="note">${scope}</span>` : nothing}</span>
                <span class="value">${value}</span>
            </div>
        `;
    }

    /** A technical row, hidden when its reading is unavailable. */
    protected _optionalRow(overview: O, key: string, labelKey: string) {
        const value = this._reading(overview, key);
        return value === null ? nothing : this._row(this._t(labelKey), value, key);
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
