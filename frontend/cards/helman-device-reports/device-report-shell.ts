import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { html as staticHtml, unsafeStatic } from "lit/static-html.js";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import {
    DEVICE_REPORT_GRANULARITIES,
    fetchDeviceReport,
    isDeviceReportUnavailable,
    type DeviceReportCommon,
    type DeviceReportGranularity,
    type DeviceReportPayload,
    type DeviceReportQuery,
} from "../helman-api";
import { getSharedDataChangedFeed } from "../helman/data-changed";
import { fillTemplate, getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import { formatKwhValue } from "../shared/forecast-value-format";
import {
    HoverTooltipController,
    hoverTooltipStyles,
    tooltipRow,
    type TooltipBody,
    type TooltipRow,
} from "../shared/hover-tooltip";
import { startNowClock } from "../shared/now-clock";
import { todayIso } from "../shared/today-iso";
import { DEVICE_REPORTS, type DeviceReportEntry } from "./report-registry";
import {
    DEFAULT_PERIOD_PRESET,
    PERIOD_PRESETS,
    presetQuery,
    type PeriodPreset,
} from "./report-period";

/** How long a payload whose period the recorder had not finished compiling is kept. */
const OPEN_PAYLOAD_TTL_MS = 5 * 60_000;
/** How long a custom date edit settles before it is fetched. */
const CUSTOM_DEBOUNCE_MS = 400;
/** Above this share of the house, a data-quality figure is worth a mention. */
const QUALITY_NOTE_SHARE = 0.01;

const SOURCE_METERS = ["grid", "solar", "battery"] as const;

interface MemoEntry {
    payload: DeviceReportPayload;
    fetchedAtMs: number;
}

/**
 * When a memoised payload stops being good.
 *
 * A complete payload never does on its own: the recorder had compiled its
 * whole period, so its hours no longer change. A saved config can still change
 * the tree, the meters or the tariff it was built from, so the shell drops the
 * whole memo when one is announced. Anything else -- a period still open, or one
 * that closed after the fetch -- expires five minutes after it was fetched.
 * Whether the period is in the past is deliberately not the test: a report
 * fetched at 23:58 is incomplete however closed its period is by 00:05.
 *
 * Timed by the browser's clock, not the payload's server-side `as_of`: a
 * browser clock running ahead of the server would otherwise see every fresh
 * payload as already expired and refetch it in a loop.
 */
function expiresAtMs(entry: MemoEntry): number {
    const payload = entry.payload;
    if (!isDeviceReportUnavailable(payload) && payload.complete) {
        return Number.POSITIVE_INFINITY;
    }
    return entry.fetchedAtMs + OPEN_PAYLOAD_TTL_MS;
}

function memoKey(report: string, query: DeviceReportQuery): string {
    return report + "|" + query.start_date + "|" + query.end_date + "|" + (query.granularity ?? "");
}

/**
 * The device reports' shell: the period, the granularity, the tabs, the
 * fetching and the freshness. A report element owns only its rendering, and is
 * handed exactly `payload`, `query` and `localize`.
 *
 * The granularity is offered, sent and memoised only for a report whose
 * registry entry uses it, so changing it never refetches one that does not.
 */
@customElement("helman-device-report-shell")
export class HelmanDeviceReportShell extends LitElement {
    /** Handed down by the card only when its context changes. */
    @property({ attribute: false }) public hass?: HomeAssistant;

    @state() private _preset: PeriodPreset = DEFAULT_PERIOD_PRESET;
    @state() private _customStart: string | null = null;
    @state() private _customEnd: string | null = null;
    @state() private _reportId: string = DEVICE_REPORTS[0].id;
    @state() private _granularity: DeviceReportGranularity = "day";
    /** Today's local day key, moved by the clock: it rolls the presets over. */
    @state() private _today = "";
    /** The memo key of the request in flight, or null. */
    @state() private _inflightKey: string | null = null;
    @state() private _error: string | null = null;
    /** Bumped whenever the memo takes a payload, so the shell re-renders. */
    @state() private _memoVersion = 0;
    /**
     * The memo key whose last fetch failed, and when. Not refetched on every
     * update -- that would retry in a tight loop -- but once it has been failed
     * as long as an open payload is kept, so an error that will not go away
     * (a range the backend rejects) is not resent every tick.
     */
    private _failed: { key: string; atMs: number } | null = null;

    private _memo = new Map<string, MemoEntry>();
    /** The visible query, identity-stable while its fields are unchanged. */
    private _query: DeviceReportQuery | null = null;
    private _range: { minDate: string; maxDate: string } | null = null;
    private _localize: LocalizeFunction = (key: string) => key;
    private _localizeLanguage: string | undefined = undefined;
    private _localizeBuilt = false;
    /** Each request's sequence number: only the latest one's answer is kept. */
    private _requestSeq = 0;
    /**
     * Bumped whenever what a report was built from may have changed (a config
     * announcement, a new connection or time zone): answers to requests made
     * before it are not kept.
     */
    private _generation = 0;
    private _stopClock?: () => void;
    private _unsubscribeDataChanged?: () => void;
    /** The connection and time zone the memo and the subscription belong to. */
    private _context: { connection: unknown; timeZone: string | undefined } | null = null;
    private _debounceTimer?: number;
    /** Custom date edits not yet applied; a key present with null clears that date. */
    private _pendingCustom: { start?: string | null; end?: string | null } = {};
    private _tooltip = new HoverTooltipController(this);

    static styles = [hoverTooltipStyles, css`
        :host { display: block; }
        .bar {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            align-items: center;
            margin-bottom: 8px;
        }
        .bar button {
            font: inherit;
            font-size: 0.8rem;
            padding: 3px 8px;
            border-radius: 12px;
            border: 1px solid var(--divider-color, #ccc);
            background: transparent;
            color: var(--primary-text-color);
            cursor: pointer;
        }
        .bar button.selected {
            background: var(--primary-color);
            border-color: var(--primary-color);
            color: var(--text-primary-color, #fff);
        }
        .custom input {
            font: inherit;
            font-size: 0.8rem;
        }
        .tabs button { border-radius: 4px; }
        .status {
            font-size: 0.75rem;
            color: var(--secondary-text-color);
            margin-bottom: 6px;
        }
        .quality-glyph {
            font: inherit;
            margin-left: 4px;
            padding: 0;
            border: none;
            background: transparent;
            color: var(--secondary-text-color);
            cursor: pointer;
        }
        .quality-glyph.warning { color: var(--warning-color, #f4b400); }
        .error, .unavailable {
            font-size: 0.8rem;
            padding: 6px 8px;
            border-radius: 4px;
            margin-bottom: 8px;
        }
        .error {
            background: color-mix(in srgb, var(--error-color, #db4437) 15%, transparent);
        }
        .unavailable {
            background: color-mix(in srgb, var(--secondary-text-color, #888) 12%, transparent);
        }
    `];

    connectedCallback(): void {
        super.connectedCallback();
        this._stopClock = startNowClock(this._tick);
        this._syncDataChangedSubscription();
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this._stopClock?.();
        this._stopClock = undefined;
        this._unsubscribeDataChanged?.();
        this._unsubscribeDataChanged = undefined;
        window.clearTimeout(this._debounceTimer);
    }

    /**
     * Through the shared feed, like the inspector. Only `config` is acted on,
     * deliberately against the feed's reload-everything advice: a report reads
     * the device tree, the meters and the tariff, and nothing a schedule or
     * plan announcement rewrites, while every refetch is a statistics read
     * over the whole period.
     */
    private _syncDataChangedSubscription(): void {
        if (!this.hass || !this.isConnected || this._unsubscribeDataChanged) return;
        this._unsubscribeDataChanged = getSharedDataChangedFeed(this.hass).subscribe((kinds) => {
            if (kinds.has("config")) this._invalidate();
        });
    }

    /** Drop every memoised report and the request in flight, and refetch. */
    private _invalidate(): void {
        this._memo.clear();
        this._failed = null;
        // A request in flight was built from what has just changed: neither
        // keep its answer nor let it block the refetch.
        this._generation += 1;
        this._requestSeq += 1;
        this._inflightKey = null;
        this._memoVersion += 1;
    }

    /**
     * A new connection or time zone: the subscription is rebound to the new
     * connection, and nothing fetched under the old context is kept -- a
     * custom range in particular means other hours in another zone.
     */
    private _syncContext(): void {
        const context = { connection: this.hass?.connection, timeZone: this._timeZone() };
        const previous = this._context;
        this._context = context;
        if (
            previous === null
            || (previous.connection === context.connection && previous.timeZone === context.timeZone)
        ) {
            return;
        }
        this._unsubscribeDataChanged?.();
        this._unsubscribeDataChanged = undefined;
        this._invalidate();
    }

    private _timeZone(): string | undefined {
        return this.hass?.config?.time_zone;
    }

    /**
     * The clock moved. Two things read it: the rolling presets, which move at
     * local midnight, and the visible payload's expiry. Anything else drops the
     * tick without writing state.
     */
    private _tick = (): void => {
        const today = todayIso(this._timeZone());
        if (today !== this._today) {
            this._today = today;
            return;
        }
        this._ensureFresh();
    };

    protected willUpdate(changed: PropertyValues<this>): void {
        // A refresh or another query reuses the glyph: its popup would keep the old figures.
        if (changed.has("_memoVersion") || changed.has("_inflightKey")) this._tooltip.hide();
        if (changed.has("hass")) {
            const language = this.hass?.language;
            if (!this._localizeBuilt || language !== this._localizeLanguage) {
                this._localizeBuilt = true;
                this._localizeLanguage = language;
                this._localize = this.hass ? getLocalizeFunction(this.hass) : (key: string) => key;
            }
            this._today = todayIso(this._timeZone());
            this._syncContext();
            this._syncDataChangedSubscription();
        }
        const dates = this._preset === "custom"
            ? (this._customStart && this._customEnd
                ? { start_date: this._customStart, end_date: this._customEnd }
                : null)
            : presetQuery(this._preset, this._today);
        const next: DeviceReportQuery | null = dates && this._entry().usesGranularity
            ? { ...dates, granularity: this._granularity }
            : dates;
        if (next === null) {
            this._query = null;
        } else if (
            this._query === null
            || this._query.start_date !== next.start_date
            || this._query.end_date !== next.end_date
            || this._query.granularity !== next.granularity
        ) {
            this._query = Object.freeze(next);
        }
        this._ensureFresh();
    }

    private _entry(): DeviceReportEntry {
        return DEVICE_REPORTS.find((report) => report.id === this._reportId) ?? DEVICE_REPORTS[0];
    }

    /** Fetch the visible report unless the memo holds a payload that is still good. */
    private _ensureFresh(): void {
        const query = this._query;
        if (!this.hass || !query) return;
        const key = memoKey(this._reportId, query);
        const entry = this._memo.get(key);
        if (entry && Date.now() < expiresAtMs(entry)) return;
        if (this._inflightKey === key) return;
        if (this._failed?.key === key && Date.now() < this._failed.atMs + OPEN_PAYLOAD_TTL_MS) return;
        this._fetch(key, this._reportId, query);
    }

    private _fetch(key: string, report: string, query: DeviceReportQuery): void {
        const seq = ++this._requestSeq;
        const generation = this._generation;
        this._inflightKey = key;
        this._error = null;
        fetchDeviceReport(this.hass!, report, query).then(
            (payload) => {
                if (generation !== this._generation) return;
                // Kept even when a newer request was made meanwhile: it is still
                // the right answer for its own key, should that be asked again.
                this._memo.set(key, { payload, fetchedAtMs: Date.now() });
                // But it is not shown: the visible query has moved on.
                if (seq !== this._requestSeq) return;
                if (!isDeviceReportUnavailable(payload)) this._range = payload.range;
                this._inflightKey = null;
                this._memoVersion += 1;
            },
            (error: unknown) => {
                if (seq !== this._requestSeq) return;
                this._inflightKey = null;
                this._failed = { key, atMs: Date.now() };
                const message = (error as { message?: string } | null)?.message;
                this._error = message ?? String(error);
            },
        );
    }

    private _selectPreset(preset: PeriodPreset): void {
        if (preset === "custom" && this._query && !this._customStart) {
            this._customStart = this._query.start_date;
            this._customEnd = this._query.end_date;
        }
        this._preset = preset;
    }

    private _onCustomInput(which: "start" | "end", event: Event): void {
        const value = (event.target as HTMLInputElement).value || null;
        this._pendingCustom = { ...this._pendingCustom, [which]: value };
        window.clearTimeout(this._debounceTimer);
        this._debounceTimer = window.setTimeout(() => {
            const pending = this._pendingCustom;
            if ("start" in pending) this._customStart = pending.start ?? null;
            if ("end" in pending) this._customEnd = pending.end ?? null;
            this._pendingCustom = {};
        }, CUSTOM_DEBOUNCE_MS);
    }

    private _formatAsOf(asOf: string): string {
        const instant = new Date(asOf);
        if (Number.isNaN(instant.getTime())) return asOf;
        try {
            return new Intl.DateTimeFormat(this.hass?.language ?? "en", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
                timeZone: this._timeZone(),
            }).format(instant);
        } catch {
            return asOf;
        }
    }

    private _renderPresets() {
        const t = this._localize;
        return html`
            <div class="bar presets">
                ${PERIOD_PRESETS.map((preset) => html`
                    <button
                        type="button"
                        data-preset=${preset}
                        class=${preset === this._preset ? "selected" : ""}
                        @click=${() => this._selectPreset(preset)}
                    >${t("device_reports.presets." + preset)}</button>
                `)}
            </div>
            ${this._preset === "custom" ? html`
                <div class="bar custom">
                    <label>${t("device_reports.from")}
                        <input
                            type="date"
                            class="custom-start"
                            .value=${this._customStart ?? ""}
                            min=${this._range?.minDate ?? nothing}
                            max=${this._customEnd ?? this._today}
                            @change=${(event: Event) => this._onCustomInput("start", event)}
                        />
                    </label>
                    <label>${t("device_reports.to")}
                        <input
                            type="date"
                            class="custom-end"
                            .value=${this._customEnd ?? ""}
                            min=${this._customStart ?? this._range?.minDate ?? nothing}
                            max=${this._today}
                            @change=${(event: Event) => this._onCustomInput("end", event)}
                        />
                    </label>
                </div>
            ` : nothing}
        `;
    }

    private _renderTabs() {
        return html`
            <div class="bar tabs">
                ${DEVICE_REPORTS.map((entry) => html`
                    <button
                        type="button"
                        data-report=${entry.id}
                        class=${entry.id === this._reportId ? "selected" : ""}
                        @click=${() => { this._reportId = entry.id; }}
                    >${this._localize(entry.labelKey)}</button>
                `)}
            </div>
        `;
    }

    private _renderGranularity() {
        return html`
            <div class="bar granularity">
                ${DEVICE_REPORT_GRANULARITIES.map((granularity) => html`
                    <button
                        type="button"
                        data-granularity=${granularity}
                        class=${granularity === this._granularity ? "selected" : ""}
                        @click=${() => { this._granularity = granularity; }}
                    >${this._localize("device_reports.granularity." + granularity)}</button>
                `)}
            </div>
        `;
    }

    /**
     * The missing meters and the data-quality figures, as a glyph after the
     * as-of time: ⚠ when a meter is missing, ⓘ for quality figures alone, and
     * nothing when there is neither. Its tooltip carries the text.
     */
    private _renderQuality(payload: DeviceReportCommon) {
        const t = this._localize;
        const missing = SOURCE_METERS.filter((meter) => !payload.meters[meter]);
        const house = payload.house_kwh;
        const quality = (["ambiguous", "unattributed", "mismatch"] as const)
            .map((kind) => ({ kind, kwh: payload[(kind + "_kwh") as "ambiguous_kwh"] }))
            .filter(({ kwh }) => house > 0 && kwh > QUALITY_NOTE_SHARE * house);
        if (missing.length === 0 && quality.length === 0) return nothing;
        const rows: TooltipRow[] = missing.length > 0
            ? [tooltipRow("", fillTemplate(t("device_reports.missing_meters"), {
                meters: missing.map((meter) => t("device_reports.meters." + meter)).join(", "),
            }))]
            : [];
        for (const { kind, kwh } of quality) {
            rows.push({
                ...tooltipRow("", fillTemplate(t("device_reports.quality." + kind), {
                    kwh: formatKwhValue(kwh),
                    pct: String(Math.round((kwh / house) * 100)),
                })),
                quality: kind,
            });
        }
        const tooltip: TooltipBody = { title: t("device_reports.quality_title"), hasActual: false, rows };
        return html`
            <button
                type="button"
                class=${"quality-glyph" + (missing.length > 0 ? " warning" : "")}
                aria-label=${tooltip.title ?? ""}
                @mousemove=${(event: MouseEvent) => this._tooltip.show(event, tooltip)}
                @mouseleave=${() => this._tooltip.hide()}
                @click=${(event: MouseEvent) => this._tooltip.toggle(event, tooltip)}
            >${missing.length > 0 ? "⚠" : "ⓘ"}</button>
        `;
    }

    render() {
        const t = this._localize;
        const query = this._query;
        const key = query ? memoKey(this._reportId, query) : null;
        const payload = key ? this._memo.get(key)?.payload ?? null : null;
        const loading = key !== null && this._inflightKey === key;
        const entry = this._entry();
        const tag = unsafeStatic(entry.tag);

        return html`
            ${this._renderPresets()}
            ${this._renderTabs()}
            ${entry.usesGranularity ? this._renderGranularity() : nothing}
            <div class="status">
                ${payload && !isDeviceReportUnavailable(payload)
                    ? html`<span class="as-of">${fillTemplate(t("device_reports.as_of"), { time: this._formatAsOf(payload.as_of) })}</span>${this._renderQuality(payload)}`
                    : nothing}
                ${loading ? html`<span class="loading">${t("device_reports.loading")}</span>` : nothing}
            </div>
            ${this._error && (!payload || this._failed?.key === key) ? html`
                <div class="error">${fillTemplate(t("device_reports.error"), { message: this._error })}</div>
            ` : nothing}
            ${payload && isDeviceReportUnavailable(payload) ? html`
                <div class="unavailable">${t("device_reports.unavailable." + payload.unavailable)}</div>
            ` : nothing}
            ${payload && !isDeviceReportUnavailable(payload) ? html`
                ${staticHtml`<${tag} .payload=${payload} .query=${query} .localize=${this._localize}></${tag}>`}
            ` : nothing}
            ${this._tooltip.render()}
        `;
    }
}
