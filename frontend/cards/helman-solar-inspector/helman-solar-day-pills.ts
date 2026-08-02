import { LitElement, css, html, type PropertyValues } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import type { ForecastPayload } from "../helman-api";
import { ForecastLoader } from "../helman/forecast-loader";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import { getSharedScheduleOwner, type SharedScheduleOwner } from "../helman-scheduling/schedule-owner";
import {
    applyNormalizedScheduleCurrentState,
    buildNormalizedScheduleStructure,
} from "../helman-scheduling/model/schedule-normalizer";
import { buildScheduleTimelineModel } from "../helman-scheduling/model/schedule-timeline-builder";
import {
    buildSlotForecastMap,
    deriveScheduleForecastParams,
    EMPTY_SLOT_FORECAST_MAP,
    type SlotForecastMap,
} from "../helman-scheduling/model/slot-forecast-model";
import type {
    NormalizedScheduleModel,
    ScheduleOwnerSnapshot,
} from "../helman-scheduling/schedule-types";
import { dayAggregateGaugeStyles, renderDayAggregateGauge } from "../shared/day-aggregate-gauge";
import {
    buildDayPillKeys,
    buildSolarInspectorDayPills,
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

const EMPTY_NORMALIZED_SCHEDULE: NormalizedScheduleModel = {
    slots: [],
    currentSlotId: null,
    currentDayKey: null,
    granularityMinutes: null,
};

/** The day a pill was clicked for; the inspector loads it. */
export interface DayPillSelectDetail {
    date: string;
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

        .pill:hover {
            border-color: color-mix(in srgb, var(--primary-color, #2563eb) 45%, var(--divider-color));
        }

        /* The fallback matches the card's other active controls, so a theme
           without --primary-color still shows which day is being shown. */
        .pill.selected {
            border-color: var(--primary-color, #2563eb);
            background: color-mix(in srgb, var(--primary-color, #2563eb) 14%, var(--card-background-color));
            box-shadow: inset 0 0 0 1px var(--primary-color, #2563eb);
        }

        /* The label sets the pill's floor, so it is never clipped: a day nobody
           can read is not worth a pill. */
        .pill-label {
            font-size: 0.72rem;
            font-weight: 600;
            line-height: 1.2;
            white-space: nowrap;
        }

        /* Measured, not planned: the dashed edge says this day is history, and
           it is the one pill whose numbers can never change again. */
        .pill.history {
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
    /** First day to offer — today, in the house's time zone. */
    @property({ type: String }) public startDate = "";
    /** Last day the inspector has a forecast for. */
    @property({ type: String }) public endDate = "";
    @property({ type: String }) public timeZone = "UTC";
    /**
     * The past day the inspector is showing, rebuilt from its measurements.
     * Null whenever the shown day is today or later, which is why the row
     * carries no history until the arrows are used.
     */
    @property({ attribute: false }) public historyDay: SolarInspectorHistoryDay | null = null;

    @state() private _ownerSnapshot: ScheduleOwnerSnapshot = EMPTY_OWNER_SNAPSHOT;
    @state() private _forecast: ForecastPayload | null = null;

    private _localizeFn?: LocalizeFunction;
    private _scheduleOwner?: SharedScheduleOwner;
    private _unsubscribeOwner?: () => void;
    private _forecastLoader: ForecastLoader | null = null;
    private _forecastLoaderKey: string | null = null;

    private _normalized: NormalizedScheduleModel = EMPTY_NORMALIZED_SCHEDULE;
    private _normalizedFor: { schedule: unknown; timeZone: string } | null = null;
    private _model: SolarInspectorDayPillModel = EMPTY_DAY_PILL_MODEL;
    private _modelFor: {
        normalized: unknown;
        forecast: unknown;
        historyDay: unknown;
        startDate: string;
        endDate: string;
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

        return html`
            <div class="pill-row" role="group" aria-label=${this._localize("bias_correction.inspector.day_pills")}>
                ${pills.map((pill) => this._renderPill(pill))}
            </div>
        `;
    }

    private _renderPill(pill: SolarInspectorDayPill) {
        const selected = pill.dayKey === this.selectedDate;
        return html`
            <button
                class=${`pill${selected ? " selected" : ""}${pill.isHistory ? " history" : ""}`}
                type="button"
                data-day=${pill.dayKey}
                data-history=${pill.isHistory ? "true" : "false"}
                aria-pressed=${selected ? "true" : "false"}
                @click=${() => this._select(pill.dayKey)}
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
            // The forecast is what fills the gauges, and it is only requestable
            // once the schedule has told us its granularity and horizon.
            void this._loadForecast();
        }
    }

    private async _loadForecast(): Promise<void> {
        const hass = this.hass;
        const schedule = this._ownerSnapshot.schedule;
        if (!hass || schedule === null) {
            return;
        }

        const params = deriveScheduleForecastParams(schedule.slots);
        if (params === null) {
            return;
        }

        const key = `${params.granularity}:${params.forecastDays ?? ""}`;
        if (this._forecastLoader === null || this._forecastLoaderKey !== key) {
            this._forecastLoader = new ForecastLoader(params.granularity, params.forecastDays ?? null);
            this._forecastLoaderKey = key;
        }

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

    private _rebuildNormalizedIfNeeded(): void {
        const schedule = this._ownerSnapshot.schedule;
        if (
            this._normalizedFor === null
            || this._normalizedFor.schedule !== schedule
            || this._normalizedFor.timeZone !== this.timeZone
        ) {
            this._normalized = buildNormalizedScheduleStructure({
                schedule,
                timeZone: this.timeZone,
                locale: this._locale,
            });
            this._normalizedFor = { schedule, timeZone: this.timeZone };
        }

        this._normalized = applyNormalizedScheduleCurrentState(
            this._normalized,
            this.timeZone,
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
            && previous.historyDay === this.historyDay
            && previous.startDate === this.startDate
            && previous.endDate === this.endDate
            && previous.timeZone === this.timeZone
        ) {
            return;
        }

        this._modelFor = {
            normalized: this._normalized,
            forecast: this._forecast,
            historyDay: this.historyDay,
            startDate: this.startDate,
            endDate: this.endDate,
            timeZone: this.timeZone,
        };

        const dayKeys = buildDayPillKeys(this.startDate, this.endDate);
        if (dayKeys.length === 0 && this.historyDay === null) {
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
            historyDay: this.historyDay,
            currentDayKey: this._normalized.currentDayKey ?? this.startDate,
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
