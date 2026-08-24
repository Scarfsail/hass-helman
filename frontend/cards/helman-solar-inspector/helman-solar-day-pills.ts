import { LitElement, css, html, type PropertyValues } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
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
import { dayAggregateGaugeStyles, renderDayAggregateGauge } from "../shared/day-aggregate-gauge";
import {
    buildDayPillCalendarCells,
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
 * going. The three strips — solar with its figure, then SoC and grid as bars —
 * are the schedule card's day gauges, so a day looks the same in both cards.
 * SoC and grid drop their numbers here: at pill width they would crowd out the
 * one figure worth reading, and both still answer on hover.
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

        .pill.selected .pill-label {
            color: var(--primary-color, #2563eb);
        }

        /* Thin strips: a pill is read as a shape, not as a table of numbers. */
        .day-aggregate-gauge {
            min-height: 11px;
            padding: 0 3px;
            font-size: 0.58rem;
        }

        .day-aggregate-gauge.solar {
            min-height: 13px;
        }
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
    } | null = null;
    /** The day the row was last scrolled to, so a re-render does not re-scroll. */
    private _scrolledTo: string | null = null;

    protected willUpdate(_changed: PropertyValues<this>): void {
        if (this.hass) {
            this._localizeFn = getLocalizeFunction(this.hass);
            this._syncOwner();
        }
        this._rebuildNormalizedIfNeeded();
        this._rebuildModelIfNeeded();
    }

    protected updated(): void {
        this._revealSelectedPill();
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this._unsubscribeOwner?.();
        this._unsubscribeOwner = undefined;
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
                class=${`pill-row${calendar ? " calendar" : ""}${this.selectsSlot ? " selects-slot" : ""}`}
                role="group"
                aria-label=${this._localize("bias_correction.inspector.day_pills")}
            >
                ${cells.map((cell) => (cell === null
                    ? html`<span class="pill-blank" aria-hidden="true"></span>`
                    : this._renderPill(cell)))}
            </div>
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
        return html`
            <button
                class=${`pill${selected ? " selected" : ""}${pill.isHistory ? " history" : ""}`
                    + `${hovered ? " hovered" : ""}${bucketSelected ? " bucket-selected" : ""}`}
                type="button"
                data-day=${pill.dayKey}
                data-history=${pill.isHistory ? "true" : "false"}
                ?disabled=${unreachable}
                aria-pressed=${selected ? "true" : "false"}
                @click=${() => this._select(pill.dayKey)}
                @mouseenter=${() => this._hover(pill.dayKey)}
                @mouseleave=${() => this._hover(null)}
            >
                <span class="pill-label">${pill.label}</span>
                ${renderDayAggregateGauge({
                    kind: "solar",
                    aggregate: pill.aggregate,
                    scale: this._model.scale,
                    available: pill.availability.solar,
                    localize: this._localize,
                })}
                ${renderDayAggregateGauge({
                    kind: "battery",
                    aggregate: pill.aggregate,
                    scale: this._model.scale,
                    available: pill.availability.battery,
                    showValue: false,
                    localize: this._localize,
                })}
                ${renderDayAggregateGauge({
                    kind: "grid",
                    aggregate: pill.aggregate,
                    scale: this._model.scale,
                    available: pill.availability.grid,
                    showValue: false,
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
        };

        const dayKeys = buildDayPillKeys(this.startDate, this.endDate);
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
