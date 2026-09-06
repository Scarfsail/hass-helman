import { LitElement, css, html, type PropertyValues } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import { repeat } from "lit/directives/repeat.js";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import type { ForecastPayload } from "../helman-api";
import { ForecastLoader } from "../helman/forecast-loader";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import { getSharedScheduleOwner, type SharedScheduleOwner } from "../shared/schedule/schedule-owner";
import {
    EMPTY_NORMALIZED_SCHEDULE,
    NormalizedScheduleCache,
} from "../shared/schedule/model/schedule-normalizer";
import { buildScheduleTimelineModel } from "../shared/schedule/model/schedule-timeline-builder";
import {
    buildSlotForecastMap,
    EMPTY_SLOT_FORECAST_MAP,
    type SlotForecastMap,
} from "../shared/schedule/model/slot-forecast-model";
import type {
    NormalizedScheduleModel,
    ScheduleOwnerSnapshot,
} from "../shared/schedule/schedule-types";
import { buildDaySolarPairTitle, dayAggregateGaugeStyles, renderDayAggregateGauge } from "../shared/day-aggregate-gauge";
import {
    buildDayPillCalendarCells,
    calendarWindow,
    MAX_CALENDAR_DAYS,
    buildDayPillKeys,
    buildSolarInspectorDayPills,
    resolveFirstWeekdayIndex,
    EMPTY_DAY_PILL_MODEL,
    type SolarInspectorDayPill,
    type SolarInspectorDayPillModel,
    type SolarInspectorHistoryDay,
} from "./day-pill-model";
import { helmanColorVars } from "../color-vars";

/**
 * The inspector's day picker: one pill per day from today to the end of the
 * forecast, each showing that whole day at a glance.
 *
 * Stepping through days with the arrows told you nothing about where you were
 * going. The two strips — solar and SoC — are the schedule card's day gauges,
 * so a day looks the same in both cards, and each carries its own figures:
 * solar's total, and the two ends of the SoC band the bar draws. The grid bar
 * the schedule card also shows is left off: at pill width three bars was one
 * more than the row could be read at a glance, and the day's import and export
 * are what the chart below spells out anyway.
 */

const EMPTY_OWNER_SNAPSHOT: ScheduleOwnerSnapshot = {
    schedule: null,
    loading: false,
    refreshing: false,
    writing: false,
    togglingExecution: false,
    error: null,
    updatedAt: null,
    stale: false,
};

/** The day a pill was clicked for; the inspector loads it. */
export interface DayPillSelectDetail {
    date: string;
}

/**
 * The day a pill was double-clicked for: the reader is asking to open it.
 *
 * Only raised at D, where these pills are the aggregate chart's columns and
 * there is a day view below them to open. In the day view the pill's single
 * press already opens the day, so a second one would mean nothing.
 */
export interface DayPillOpenDetail {
    date: string;
}

/**
 * The day under the pointer, or null as it leaves.
 *
 * Raised rather than acted on, because the row is not the only thing drawing
 * this day: at D the aggregate chart's columns are these same days, and the
 * card is what holds the one answer both of them highlight from.
 */
export interface DayPillHoverDetail {
    date: string | null;
}

/**
 * The forecast payload's health, handed up to the inspector.
 *
 * The pills are the only always-mounted part of the inspector that fetches the
 * forecast, so they are where its health becomes known — but the warning is
 * about the card, not about the pill row, so it is raised rather than drawn
 * here.
 */
export interface DayPillForecastHealthDetail {
    forecast: ForecastPayload;
}

@customElement("helman-solar-day-pills")
export class HelmanSolarDayPills extends LitElement {
    static styles = [helmanColorVars, dayAggregateGaugeStyles, css`
        :host {
            display: block;
            min-width: 0;
        }

        .pill-row {
            display: flex;
            align-items: stretch;
            gap: 6px;
            overflow-x: auto;
            scrollbar-width: thin;
        }

        /* A whole month reads as a month only in seven fixed columns, so the
           row stops being a row: the columns are equal fractions rather than
           the pills' own width, which is what keeps the 1st under the same
           weekday heading as the 8th. The horizontal scroll goes with the flex
           layout — a grid this wide wraps by construction and has nothing to
           scroll past. */
        .pill-row.calendar {
            display: grid;
            grid-template-columns: repeat(7, minmax(0, 1fr));
            overflow-x: visible;
        }

        .pill-row.calendar.continuous {
            height: 426px;
            grid-auto-rows: 66px;
            align-content: start;
            overflow-y: auto;
            overflow-x: hidden;
            overflow-anchor: none;
            overscroll-behavior-y: contain;
            touch-action: pan-y;
        }
        .continuous .pill { min-width: 0; padding: 3px; position: relative; }
        .continuous .pill-label { overflow: hidden; text-overflow: ellipsis; }
        .continuous .month-start { border-top-width: 2px; border-top-color: var(--primary-color, #2563eb); }
        .return-row { height: 30px; display: flex; align-items: center; }
        .return-selected { font: inherit; font-size: 0.75rem; color: var(--primary-text-color); background: var(--card-background-color); border: 1px solid var(--divider-color); border-radius: 6px; cursor: pointer; }

        /* The fixed width is what a scrolling row needs and what a grid column
           must not have: 74px in a seven-column grid overflows every card
           narrower than about 560px. */
        .pill-row.calendar .pill {
            width: auto;
        }

        /* The days before the 1st. Inert and invisible, present only so the
           grid's auto-placement puts the first pill in the right column. */
        .pill-blank {
            visibility: hidden;
        }

        /* 74px is the comfortable width, not a floor: when the row runs out of
           room the pills give it back until they are as wide as their own label
           and no wider. Only past that does the row scroll. */
        .pill {
            display: grid;
            gap: 2px;
            flex: 0 1 auto;
            width: 74px;
            box-sizing: border-box;
            padding: 4px 6px 5px;
            border: 1px solid var(--divider-color);
            border-radius: 8px;
            background: var(--card-background-color);
            color: var(--primary-text-color);
            font: inherit;
            text-align: start;
            cursor: pointer;
            transition: border-color 120ms ease, background-color 120ms ease;
        }

        /* Dimmed, not dropped: a calendar that hid the days it cannot open
           would change shape as the reader moved between months, and the gap
           at the far end of the history is worth seeing as a gap. Same
           treatment the month row gives a month outside the data. */
        .pill:disabled {
            cursor: not-allowed;
            opacity: 0.4;
        }

        /* The fallback matches the card's other active controls, so a theme
           without --primary-color still shows which day is being shown. */
        .pill.selected {
            border-color: var(--primary-color, #2563eb);
            background: color-mix(in srgb, var(--primary-color, #2563eb) 14%, var(--card-background-color));
            box-shadow: inset 0 0 0 1px var(--primary-color, #2563eb);
        }

        /* A column the reader picked in the aggregate chart, in the same blue
           that column is filled with -- --helman-grid-import, the day view's
           selection token, because it is the same fact drawn twice and the two
           halves of the card must not disagree about what picked looks like.
           Amber stays with hover here as it does there.

           After the .selected rule on purpose. The two can land on one pill:
           the day the card has loaded and a column being read. When they
           coincide the picked column takes the fill while the loaded day keeps
           its inner ring, so neither claim is lost. */
        .pill.bucket-selected {
            border-color: var(--helman-grid-import);
            background: color-mix(in srgb, var(--helman-grid-import) 18%, var(--card-background-color));
        }

        /* One rule for both directions, and last so it reads over either
           selected state -- the pointer is about the pill under it, whatever is
           already picked. The .hovered class is set from the card, so a hover
           that started on a chart column looks exactly like one that started
           here.

           The amber is the chart's, not the card's blue: the hover overlay over
           a column is --helman-selection at 14 % with an amber edge, and this
           is the same hover drawn on the same day a few pixels away. Blue here
           made one gesture wear two colours depending on which half of the card
           the pointer was over. */
        /* Blue where the press chooses the day being browsed, which is what it
           does everywhere the chart is not drawing these days as columns. */
        .pill:hover {
            border-color: var(--primary-color, #2563eb);
            background: color-mix(in srgb, var(--primary-color, #2563eb) 14%, var(--card-background-color));
        }

        /* Amber where the press picks a column instead, and always for a hover
           the chart drove. Same token and weight as the chart's own overlay. */
        .selects-slot .pill:hover,
        .pill.hovered {
            border-color: var(--helman-selection);
            background: color-mix(in srgb, var(--helman-selection) 14%, var(--card-background-color));
        }

        /* The pointer's own hover, undone for a pill that cannot be pressed.
           :hover still matches a disabled button, so without this the blue fill
           lands on a dimmed pill and invites the press it will ignore. Last,
           and with a pseudo-class more than the rules above, so it outranks
           both the plain and the selects-slot hover.

           .hovered is deliberately not undone: that one comes from the chart,
           and following what the reader is pointing at is worth doing whether
           or not the day can be opened -- the dimming is what says it cannot. */
        .pill:disabled:hover {
            border-color: var(--divider-color);
            background: var(--card-background-color);
        }


        /* The label sets the pill's floor, so it is never clipped: a day nobody
           can read is not worth a pill. */
        .pill-label {
            font-size: 0.72rem;
            font-weight: 600;
            line-height: 1.2;
            white-space: nowrap;
        }

        /* Dashed is what the whole card draws a forecast with -- every series
           in the chart above sets stroke-dasharray on its forecast half and
           leaves the measured half solid. A pill is the same claim about a
           whole day, so a day that has already happened is solid and a day
           still being predicted is dashed. It read the other way round until
           the pills and the chart were put side by side. */
        .pill:not(.history) {
            border-style: dashed;
        }

        .pill.selected:not(.history) { box-shadow: none; }

        .pill.selected .pill-label {
            color: var(--primary-color, #2563eb);
        }

        /* Thin strips, but tall enough for the figure written on them: the
           shape is what a pill is read by, and the number is what settles the
           comparison the shape started. 13px is the line box at this size --
           any less and the digits are clipped rather than small. */
        .day-aggregate-gauge {
            min-height: 13px;
            padding: 0 3px;
            font-size: 0.58rem;
        }

        .pill-row:not(.calendar) .pill:has(.solar-paired) { min-width: 60px; }
        .solar-paired .day-aggregate-gauge-value { overflow: visible; white-space: normal; }
        .solar-pair-unit { display: block; font-size: 0.5rem; }
        .calendar .solar-paired { padding: 0 1px; }
        .calendar .solar-paired .day-aggregate-gauge-value { font-size: 0.5rem; }
    `];

    @property({ attribute: false }) public hass?: HomeAssistant;
    /** The inspector's selected day, `YYYY-MM-DD`; empty until it settles. */
    @property({ type: String }) public selectedDate = "";
    /** First day to offer. Today, or the start of a past week being paged to. */
    @property({ type: String }) public startDate = "";
    /** Last day of the window: the forecast's end, or the week's last day. */
    @property({ type: String }) public endDate = "";
    /**
     * The reachable range, which is not the same thing as the window.
     *
     * A calendar month is drawn whole so the grid keeps its shape, but a month
     * can easily run past both ends of what the card can actually open: below
     * `reachableFrom` the recorder has purged the raw states a day view needs,
     * and above `reachableTo` the forecast has not reached yet. Those days keep
     * their cell and lose their click, the same bargain the month row already
     * makes with months outside the data. Empty means no limit on that side.
     */
    @property({ type: String }) public reachableFrom = "";
    @property({ type: String }) public reachableTo = "";
    /**
     * The day the card says is hovered, from this row's pointer or the chart's.
     *
     * Not derived from `:hover` even for this row's own pointer: the highlight
     * has to look the same whichever side it came from, and one class driven
     * from one place is what guarantees that.
     */
    @property({ type: String }) public hoveredDate: string | null = null;
    /**
     * The buckets selected in the aggregate chart, when a bucket is a day.
     *
     * A different thing from `selectedDate` and drawn differently: these are the
     * columns the reader clicked to read their numbers, `selectedDate` is the day
     * the card has loaded. Both can land on one pill. A list rather than one key
     * because the chart's selection is a set -- every column the reader picked
     * has to light here too, or the row contradicts the chart it sits under.
     */
    @property({ attribute: false }) public selectedBuckets: readonly string[] = [];
    /**
     * Today, in the house's time zone. Named separately from `startDate`
     * because the window can sit entirely in the past, and it is today that
     * decides which pill reads "Today" and which "Yesterday".
     */
    @property({ type: String }) public currentDate = "";
    @property({ type: String }) public timeZone = "UTC";
    /**
     * The past days of this window, rebuilt from what was measured for them.
     * Empty while the row looks forward, which is why it carries no history
     * until the week buttons are used.
     */
    @property({ attribute: false }) public historyDays: readonly SolarInspectorHistoryDay[] = [];
    /**
     * How the pills are arranged. `"row"` is the scrolling strip the card shows
     * while its window is a rolling week; `"calendar"` is the seven-column grid
     * a whole month is read in. The window itself is the card's decision — this
     * only says how to lay out whatever days arrive.
     */
    @property({ type: String }) public layout: "row" | "calendar" = "row";
    /**
     * Whether pressing a pill picks a chart column rather than choosing the day
     * being browsed. It decides the hover colour and nothing else -- see the
     * matching property on the span row, which makes the same promise.
     */
    @property({ type: Boolean }) public selectsSlot = false;
    @property({ type: Boolean }) public continuous = false;
    @property({ type: String }) public browsedMonth = "";
    @property({ type: String }) public revealMonth = "";
    @property({ type: Number }) public revealVersion = 0;
    @state() private _selectedDirection: "" | "above" | "below" = "";
    private _frame = 0;
    private _resize?: ResizeObserver;
    private _observedRow?: HTMLElement;
    private _restore?: { day: string; offset: number };
    private _revealed = -1;

    @state() private _ownerSnapshot: ScheduleOwnerSnapshot = EMPTY_OWNER_SNAPSHOT;
    @state() private _forecast: ForecastPayload | null = null;

    private _localizeFn?: LocalizeFunction;
    private _scheduleOwner?: SharedScheduleOwner;
    private _unsubscribeOwner?: () => void;
    private _forecastLoader: ForecastLoader | null = null;

    private _normalizedCache = new NormalizedScheduleCache();
    private _normalized: NormalizedScheduleModel = EMPTY_NORMALIZED_SCHEDULE;
    private _model: SolarInspectorDayPillModel = EMPTY_DAY_PILL_MODEL;
    private _modelFor: {
        normalized: unknown;
        forecast: unknown;
        historyDays: unknown;
        startDate: string;
        endDate: string;
        currentDate: string;
        timeZone: string;
        continuous: boolean;
    } | null = null;
    /** The day the row was last scrolled to, so a re-render does not re-scroll. */
    private _scrolledTo: string | null = null;

    protected willUpdate(_changed: PropertyValues<this>): void {
        if (this.continuous && (_changed.has("startDate") || _changed.has("endDate"))) {
            const row = this.renderRoot.querySelector<HTMLElement>(".pill-row");
            if (row) {
                const top = row.getBoundingClientRect().top;
                const first = [...row.querySelectorAll<HTMLElement>("[data-day]")]
                    .find((pill) => pill.getBoundingClientRect().bottom > top);
                if (first) this._restore = { day: first.dataset.day!, offset: first.getBoundingClientRect().top - top };
            }
        }
        if (this.hass) {
            this._localizeFn = getLocalizeFunction(this.hass);
            this._syncOwner();
        }
        this._rebuildNormalizedIfNeeded();
        this._rebuildModelIfNeeded();
    }

    protected updated(): void {
        if (!this.continuous) {
            this._resize?.disconnect();
            this._observedRow = undefined;
            this._revealed = -1;
            this._restore = undefined;
            this._revealSelectedPill();
            return;
        }
        const row = this.renderRoot.querySelector<HTMLElement>(".pill-row");
        if (!row) return;
        if (this._observedRow !== row) {
            this._resize?.disconnect();
            this._resize = new ResizeObserver(this._queueViewport);
            this._resize.observe(row);
            this._observedRow = row;
        }
        if (this._revealed !== this.revealVersion) {
            const pill = row.querySelector<HTMLElement>(`[data-day="${this.revealMonth.slice(0, 7)}-01"]`);
            if (pill) {
                const top = pill.getBoundingClientRect().top - row.getBoundingClientRect().top + row.scrollTop;
                row.scrollTo({ top, behavior: this._revealed < 0 || this._restore || matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
                this._revealed = this.revealVersion;
            }
        } else if (this._restore) {
            const pill = row.querySelector<HTMLElement>(`[data-day="${this._restore.day}"]`);
            if (pill) row.scrollTop += pill.getBoundingClientRect().top - row.getBoundingClientRect().top - this._restore.offset;
        }
        this._restore = undefined;
        this._queueViewport();
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this._unsubscribeOwner?.();
        this._unsubscribeOwner = undefined;
        cancelAnimationFrame(this._frame);
        this._frame = 0;
        this._resize?.disconnect();
        this._observedRow = undefined;
    }

    private _queueViewport = (): void => {
        if (!this.continuous || this._frame || !this.isConnected) return;
        this._frame = requestAnimationFrame(() => {
            this._frame = 0;
            this._measureViewport();
        });
    };

    private _measureViewport(): void {
        const row = this.renderRoot.querySelector<HTMLElement>(".pill-row");
        if (!row || !this.continuous) return;
        const box = row.getBoundingClientRect();
        const visible = [...row.querySelectorAll<HTMLElement>("[data-day]")].filter((pill) => {
            const rect = pill.getBoundingClientRect();
            const midpoint = (rect.top + rect.bottom) / 2;
            return midpoint >= box.top && midpoint < box.bottom;
        });
        if (!visible.length) return;
        const counts = new Map<string, number>();
        for (const pill of visible) {
            const month = pill.dataset.day!.slice(0, 7) + "-01";
            counts.set(month, (counts.get(month) ?? 0) + 1);
        }
        const maximum = Math.max(...counts.values());
        const month = counts.get(this.browsedMonth) === maximum ? this.browsedMonth
            : [...counts.keys()].filter((key) => counts.get(key) === maximum).sort()[0];
        if (month !== this.browsedMonth) this._emitCalendar("calendar-month", month);
        this._selectedDirection = visible.some((pill) => pill.dataset.day === this.selectedDate) ? ""
            : this.selectedDate < visible[0].dataset.day! ? "above" : "below";
        // Only replace the buffer close to an edge. A visible date's offset is
        // captured before Lit changes the keyed cells and restored afterwards.
        if (row.scrollTop < 144 || row.scrollHeight - row.scrollTop - row.clientHeight < 144) {
            const window = calendarWindow(month, this.reachableFrom, this.reachableTo,
                resolveFirstWeekdayIndex(this.hass?.locale));
            if (window.start !== this.startDate || window.end !== this.endDate) {
                this._emitCalendar("calendar-buffer", month);
            }
        }
    }

    private _emitCalendar(type: string, month: string): void {
        this.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, detail: { month } }));
    }

    /**
     * Bring the shown day into view when the row is too narrow to hold every
     * pill — stepping with the arrows past the edge of a phone-width row would
     * otherwise highlight a pill nobody can see.
     *
     * Only ever on a change of day: re-running it on every render would fight
     * whoever is scrolling the row by hand, and the point is to follow the
     * selection, not to own the scroll position.
     */
    private _revealSelectedPill(): void {
        if (this._scrolledTo === this.selectedDate) {
            return;
        }

        const root = this.renderRoot as unknown as ParentNode;
        const row = root.querySelector(".pill-row") as HTMLElement | null;
        const pill = root.querySelector(".pill.selected") as HTMLElement | null;
        if (row === null || pill === null) {
            return;
        }

        this._scrolledTo = this.selectedDate;
        const rowBox = row.getBoundingClientRect();
        const pillBox = pill.getBoundingClientRect();
        // A pill's own margin of daylight, so a revealed pill does not sit flush
        // against the edge looking like it is the last one.
        const margin = 8;
        const short = pillBox.left - rowBox.left - margin;
        const over = pillBox.right - rowBox.right + margin;
        if (short < 0) {
            row.scrollBy({ left: short, behavior: "smooth" });
        } else if (over > 0) {
            row.scrollBy({ left: over, behavior: "smooth" });
        }
    }

    render() {
        const pills = this._model.pills;
        if (pills.length === 0) {
            return nothing;
        }

        const calendar = this.layout === "calendar";
        const cells = calendar
            ? buildDayPillCalendarCells(pills, resolveFirstWeekdayIndex(this.hass?.locale))
            : pills;

        return html`
            <div
                class=${`pill-row${calendar ? " calendar" : ""}${this.continuous ? " continuous" : ""}${this.selectsSlot ? " selects-slot" : ""}`}
                @scroll=${this._queueViewport}
                role="group"
                aria-label=${this._localize("bias_correction.inspector.day_pills")}
            >
                ${repeat(cells, (cell, index) => cell?.dayKey ?? `blank-${index}`, (cell) => (cell === null
                    ? html`<span class="pill-blank" aria-hidden="true"></span>`
                    : this._renderPill(cell)))}
            </div>
            ${!this.continuous ? nothing : html`<div class="return-row">
                ${!this._selectedDirection ? nothing : html`<button type="button" class="return-selected"
                    @click=${() => this._emitCalendar("calendar-return", this.selectedDate)}>
                    ${this._selectedDirection === "above" ? "↑" : "↓"}
                    ${this._localize("bias_correction.inspector.show_selected_day")}
                    ${new Date(`${this.selectedDate}T00:00:00Z`).toLocaleDateString(this._locale, { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" })}
                    (${this._localize(`bias_correction.inspector.selected_${this._selectedDirection}`)})
                </button>`}
            </div>`}
        `;
    }

    private _renderPill(pill: SolarInspectorDayPill) {
        const selected = pill.dayKey === this.selectedDate;
        // Compared here rather than carried on the pill: it is two string
        // comparisons against props the model does not read, and threading them
        // through `buildSolarInspectorDayPills` would put them in the memo key
        // for no gain -- a range change never changes a pill's contents, only
        // whether it can be clicked.
        const unreachable = (this.reachableFrom !== "" && pill.dayKey < this.reachableFrom)
            || (this.reachableTo !== "" && pill.dayKey > this.reachableTo);
        const hovered = pill.dayKey === this.hoveredDate;
        const bucketSelected = this.selectedBuckets.includes(pill.dayKey);
        const label = pill.solarPair
            ? pill.label + " · " + buildDaySolarPairTitle(this._localize, pill.solarPair)
            : pill.label;
        return html`
            <button
                class=${`pill${selected ? " selected" : ""}${pill.isHistory ? " history" : ""}`
                    + `${this.continuous && pill.dayKey.endsWith("-01") ? " month-start" : ""}`
                    + `${hovered ? " hovered" : ""}${bucketSelected ? " bucket-selected" : ""}`}
                type="button"
                data-day=${pill.dayKey}
                data-history=${pill.isHistory ? "true" : "false"}
                title=${label}
                aria-label=${label}
                ?disabled=${unreachable}
                aria-pressed=${selected ? "true" : "false"}
                @click=${() => this._select(pill.dayKey)}
                @dblclick=${this.selectsSlot
                    ? (event: MouseEvent) => this._open(pill.dayKey, event)
                    : nothing}
                @mouseenter=${() => this._hover(pill.dayKey)}
                @mouseleave=${() => this._hover(null)}
            >
                <span class="pill-label">${pill.label}</span>
                ${renderDayAggregateGauge({
                    kind: "solar",
                    solarPair: pill.solarPair,
                    aggregate: pill.aggregate,
                    scale: this._model.scale,
                    available: pill.availability.solar,
                    localize: this._localize,
                })}
                ${renderDayAggregateGauge({
                    kind: "battery",
                    titlePrefix: pill.solarPair ? this._localize("bias_correction.inspector.battery_forecast") : undefined,
                    aggregate: pill.aggregate,
                    scale: this._model.scale,
                    available: pill.availability.battery,
                    localize: this._localize,
                })}
            </button>
        `;
    }

    /**
     * Report the day under the pointer.
     *
     * No guard on the value being unchanged: `mouseenter` and `mouseleave` fire
     * once per pill crossed, not per pointer move, so there is nothing to
     * debounce -- and the card skips its own redundant writes anyway. A
     * disabled pill sends nothing, because the browser dispatches no mouse
     * events on one; the chart can still light it through `hoveredDate`, which
     * is right, since naming a day the row cannot open is not a claim that it
     * can be.
     */
    private _hover(dayKey: string | null): void {
        this.dispatchEvent(new CustomEvent<DayPillHoverDetail>("day-pill-hover", {
            bubbles: true,
            composed: true,
            detail: { date: dayKey },
        }));
    }

    /**
     * Report a double-click on a column pill as an open.
     *
     * Bound on `selectsSlot`, which is the row saying its pills *are* the
     * chart's columns -- the same condition the span row's month pills open on,
     * so the two rows cannot drift on what a double-click means. Modified
     * double-clicks are dropped: a reader holding shift or ctrl is addressing
     * the chart's selection, not this row.
     */
    private _open(dayKey: string, event: MouseEvent): void {
        if (event.shiftKey || event.ctrlKey || event.metaKey) return;
        this.dispatchEvent(new CustomEvent<DayPillOpenDetail>("day-pill-open", {
            bubbles: true,
            composed: true,
            detail: { date: dayKey },
        }));
    }

    /** Re-selecting the shown day would reload it for nothing. */
    private _select(dayKey: string): void {
        if (dayKey === this.selectedDate) {
            return;
        }

        this.dispatchEvent(new CustomEvent<DayPillSelectDetail>("day-pill-select", {
            bubbles: true,
            composed: true,
            detail: { date: dayKey },
        }));
    }

    private _syncOwner(): void {
        const hass = this.hass;
        if (!hass) {
            return;
        }

        const owner = getSharedScheduleOwner(hass);
        if (this._scheduleOwner === owner) {
            this._applyOwnerSnapshot(owner.getSnapshot());
            return;
        }

        this._unsubscribeOwner?.();
        this._scheduleOwner = owner;
        this._applyOwnerSnapshot(owner.getSnapshot());
        this._unsubscribeOwner = owner.subscribe((snapshot) => this._applyOwnerSnapshot(snapshot));
    }

    private _applyOwnerSnapshot(snapshot: ScheduleOwnerSnapshot): void {
        const scheduleChanged = snapshot.schedule !== this._ownerSnapshot.schedule;
        this._ownerSnapshot = snapshot;
        if (scheduleChanged && snapshot.schedule !== null) {
            // The forecast is what fills the gauges, and there is nothing to
            // draw it against until the schedule has slots.
            void this._loadForecast();
        }
    }

    private async _loadForecast(): Promise<void> {
        const hass = this.hass;
        const schedule = this._ownerSnapshot.schedule;
        if (!hass || schedule === null) {
            return;
        }

        // Nothing to draw a forecast against until the schedule has slots.
        if (schedule.slots.length === 0) {
            return;
        }

        this._forecastLoader ??= new ForecastLoader();

        try {
            const forecast = await this._forecastLoader.load(hass);
            if (this.hass?.connection === hass.connection) {
                this._forecast = forecast;
                this.dispatchEvent(new CustomEvent<DayPillForecastHealthDetail>("forecast-health", {
                    bubbles: true,
                    composed: true,
                    detail: { forecast },
                }));
            }
        } catch (error) {
            console.error("helman-solar-day-pills: failed to load forecast", error);
        }
    }

    /**
     * The pills own no clock of their own, so they read the true wall clock:
     * the row is rebuilt for other reasons often enough that a coarse "now"
     * would only make the current-day pill lag without saving anything.
     */
    private _rebuildNormalizedIfNeeded(): void {
        this._normalized = this._normalizedCache.get(
            this._ownerSnapshot.schedule,
            this.timeZone,
            this._locale,
            new Date(),
        );
    }

    /**
     * The pills survive an empty schedule or a forecast that has not landed:
     * the row is built from the date range alone and the gauges render
     * unavailable, so the header does not reflow when the data arrives.
     */
    private _rebuildModelIfNeeded(): void {
        const previous = this._modelFor;
        if (
            previous !== null
            && previous.normalized === this._normalized
            && previous.forecast === this._forecast
            && previous.historyDays === this.historyDays
            && previous.startDate === this.startDate
            && previous.endDate === this.endDate
            && previous.currentDate === this.currentDate
            && previous.timeZone === this.timeZone
            && previous.continuous === this.continuous
        ) {
            return;
        }

        this._modelFor = {
            normalized: this._normalized,
            forecast: this._forecast,
            historyDays: this.historyDays,
            startDate: this.startDate,
            endDate: this.endDate,
            currentDate: this.currentDate,
            timeZone: this.timeZone,
            continuous: this.continuous,
        };

        const dayKeys = buildDayPillKeys(this.startDate, this.endDate, this.continuous ? MAX_CALENDAR_DAYS : undefined);
        if (dayKeys.length === 0 && this.historyDays.length === 0) {
            this._model = EMPTY_DAY_PILL_MODEL;
            return;
        }

        // The schedule stops well short of the forecast — it only reaches as far
        // as the optimizer has placed actions. The timeline builder pads the rest
        // of the horizon with forecast-only slots, which is how the schedule card
        // fills its later day rows, and is what the later pills need too.
        const slots = buildScheduleTimelineModel({
            normalizedSchedule: this._normalized,
            forecast: this._forecast,
            locale: this._locale,
            timeZone: this.timeZone,
        }).slots;
        const slotForecastMap: SlotForecastMap = this._forecast === null || slots.length === 0
            ? EMPTY_SLOT_FORECAST_MAP
            : buildSlotForecastMap(this._forecast, slots);

        this._model = buildSolarInspectorDayPills({
            dayKeys,
            slots,
            slotForecastMap,
            historyDays: this.historyDays,
            forecastPayload: this._forecast,
            // The card's own "today" leads: `startDate` is only today while the
            // row looks forward, and a past week must not label its first day
            // "Today".
            currentDayKey: this.currentDate || this._normalized.currentDayKey || this.startDate,
            locale: this._locale,
            timeZone: this.timeZone,
            todayLabel: this._localize("scheduling.day.today"),
            tomorrowLabel: this._localize("scheduling.day.tomorrow"),
            yesterdayLabel: this._localize("scheduling.day.yesterday"),
        });
    }

    private get _localize(): LocalizeFunction {
        return this._localizeFn ?? ((key: string) => key);
    }

    private get _locale(): string {
        if (this.hass?.locale?.language) {
            return this.hass.locale.language;
        }

        return typeof navigator !== "undefined" ? navigator.language : "cs";
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-solar-day-pills": HelmanSolarDayPills;
    }
}
