import { LitElement, css, html } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import { helmanColorVars } from "../../color-vars";
import type { LocalizeFunction } from "../../localize/localize";
import type {
    EntityActualSegment,
    EntityScheduleAction,
    EntityScheduleBlock,
    EntityScheduleDay,
} from "../model/entity-day-schedule-model";
import type { EntityDayBandLane } from "../model/entity-lane-source";
import {
    areEntityScheduleActionsEqual,
    isEntityInverterAction,
    resolveEntityScheduleRangeLimits,
} from "../model/entity-day-schedule-model";
import { getScheduleActionPresentation } from "../model/schedule-action-presentation";
import { getScheduleApplianceActionPresentation } from "../model/schedule-appliance-action-presentation";
import { formatScheduleTime } from "../model/schedule-time";
import type { SlotForecastPoint } from "../model/slot-forecast-model";
import { schedulingSharedStyles } from "../styles/scheduling-shared-styles";

const AXIS_HOURS = [0, 3, 6, 9, 12, 15, 18, 21];
/** A bar this short still has to be visible, or a small value reads as none. */
const MIN_BAR_PCT = 8;
/** Segments narrower than this are move-only: two edge handles would not fit. */
const MIN_RESIZABLE_WIDTH_PX = 34;

export type { EntityDayBandLane };

export interface EntityDayBandBlockSelectDetail {
    laneKey: string;
    blockKey: string;
}

export interface EntityDayBandGapSelectDetail {
    laneKey: string;
    startMs: number;
    /** Where the free stretch ends, so the new block stops short of it. */
    limitMs: number;
}

export interface EntityDayBandBlockHoverDetail {
    blockKey: string | null;
}

export interface EntityDayBandLaneSelectDetail {
    laneKey: string;
}

export interface EntityDayBandRangeChangeDetail {
    startMs: number;
    endMs: number;
}

export interface EntityScheduleRange {
    startMs: number;
    endMs: number;
}

/** A stretch of the day the host wants marked, and why. */
export interface EntityDayBandHighlight {
    startMs: number;
    endMs: number;
    kind: "selected" | "hover";
}

export interface EntityDayBandTimeHoverDetail {
    /** Where the pointer is on the time axis, or null when it has left. */
    atMs: number | null;
}

type DragMode = "start" | "end" | "move";

interface DragSession {
    laneKey: string;
    mode: DragMode;
    /** The block's range when the drag began; every update derives from it. */
    originStartMs: number;
    originEndMs: number;
    grabMs: number;
    /** How far the range may travel before it would hit a neighbour or the day edge. */
    minMs: number;
    maxMs: number;
    trackRect: DOMRect;
    pointerId: number;
}

/**
 * One day of every controllable entity's schedule, as a stack of clock-time
 * tracks over a shared battery/solar/price chart.
 *
 * All the entities share one time axis on purpose: the question this editor
 * answers is *when*, and "when" is only answerable against the forecast and
 * against what everything else in the house is already doing. One lane is the
 * selected one -- it is the only one the block list and the editor below are
 * about -- and the rest are muted so the stack still reads as context rather
 * than as seven equal things.
 *
 * Blocks are draggable: the edges resize, the middle moves. A drag stops at a
 * neighbouring block rather than eating it, so nothing the user was not
 * touching can disappear.
 *
 * It also serves as a read-only readout wherever else the day is worth showing.
 * In that mode it authors nothing and answers nothing: it reports which run was
 * pressed and where the pointer is, and the host decides what those mean. The
 * geometry bends to fit -- the tracks can span a slice of the day rather than
 * all of it, drop the forecast rows and the axis, and carry their names inside
 * themselves -- because a band next to somebody else's chart has to share that
 * chart's axis to be worth putting there.
 */
@customElement("scheduling-entity-day-band")
export class SchedulingEntityDayBand extends LitElement {
    static styles = [
        helmanColorVars,
        schedulingSharedStyles,
        css`
            /* A label column beside a single shared time column: every lane and
               every context row is the same span of the same day, so they have
               to line up to the pixel. */
            .band {
                display: grid;
                grid-template-columns: minmax(96px, 156px) 1fr;
                align-items: center;
                gap: 2px 8px;
                touch-action: pan-y;
            }

            /* No gutter at all: the tracks are the whole width, which is what
               lets a host line them up with a chart of its own. */
            .band.labels-in-track {
                grid-template-columns: 1fr;
            }

            .row-label {
                display: flex;
                align-items: center;
                gap: 5px;
                min-width: 0;
                color: var(--secondary-text-color);
                font-size: 0.72rem;
            }

            .row-label.context {
                letter-spacing: 0.04em;
                text-transform: uppercase;
                font-size: 0.6rem;
            }

            .lane-label {
                padding: 0 2px;
                border: none;
                border-radius: 6px;
                background: none;
                color: var(--secondary-text-color);
                font: inherit;
                font-size: 0.72rem;
                text-align: start;
                cursor: pointer;
            }

            .lane-label ha-icon {
                flex: 0 0 auto;
                --mdc-icon-size: 15px;
            }

            .lane-name {
                flex: 1 1 auto;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .lane-total {
                flex: 0 0 auto;
                font-size: 0.66rem;
                font-variant-numeric: tabular-nums;
                opacity: 0.75;
            }

            .lane.selected .lane-label {
                color: var(--primary-text-color);
                font-weight: 600;
            }

            .lane.unavailable .lane-name {
                font-style: italic;
            }

            .context-row {
                position: relative;
                height: 18px;
                border-radius: 4px;
                background: var(--secondary-background-color);
                overflow: hidden;
                cursor: default;
            }

            /* Price gets more room: it is drawn around a zero line, so each
               half only has half the height to work with. */
            .context-row.price {
                height: 26px;
            }

            .context-bar {
                position: absolute;
            }

            .context-bar.solar {
                bottom: 0;
                background: color-mix(in srgb, var(--helman-solar) 65%, transparent);
            }

            /* Positive prices grow up from the zero line, negative ones hang
               below it, each half scaled to its own extreme -- a -0.2 next to a
               +4.6 has to be as visible as the day's worst hour, because it is
               the hour the user is looking for. */
            .zero-line {
                position: absolute;
                left: 0;
                right: 0;
                top: 50%;
                border-top: 1px dashed color-mix(in srgb, var(--primary-text-color) 22%, transparent);
            }

            .context-bar.price-positive {
                bottom: 50%;
                background: color-mix(in srgb, var(--helman-price-positive) 70%, transparent);
            }

            .context-bar.price-negative {
                top: 50%;
                background: color-mix(in srgb, var(--helman-price-negative) 78%, transparent);
            }

            /* Invisible, and only there to be pointed at. */
            .slot-hit {
                position: absolute;
                top: 0;
                bottom: 0;
            }

            .soc-chart {
                position: absolute;
                inset: 0;
                width: 100%;
                height: 100%;
            }

            /* A full battery would otherwise flood the row: the level is the
               line, and the fill is only there to say which side is "charged". */
            .soc-fill {
                fill: color-mix(in srgb, var(--helman-battery) 11%, transparent);
            }

            .soc-line {
                fill: none;
                stroke: var(--helman-battery);
                stroke-width: 1.75;
                vector-effect: non-scaling-stroke;
            }

            /* The lane rows are laid out by the grid, so the row wrapper only
               exists to carry the selected/muted state down to both cells. */
            .lane {
                display: contents;
            }

            /* Slimmer where the host is stacking rows between charts, taller
               where the track is the control surface and has to be grabbable. */
            .track {
                position: relative;
                height: var(--entity-day-band-track-height, 30px);
                border: 1px solid var(--divider-color);
                border-radius: 6px;
                background: var(--card-background-color);
                overflow: hidden;
            }

            /* The lane's name floating at the head of its own track. Inert, so
               the run underneath is still what the pointer finds; the gradient
               is what keeps the name readable when there is one. */
            .track-label {
                position: absolute;
                top: 0;
                bottom: 0;
                left: 0;
                z-index: 3;
                display: flex;
                align-items: center;
                gap: 4px;
                max-width: min(45%, 180px);
                padding: 0 14px 0 5px;
                background: linear-gradient(
                    to right,
                    var(--card-background-color) 0%,
                    color-mix(in srgb, var(--card-background-color) 85%, transparent) 70%,
                    transparent 100%
                );
                color: var(--primary-text-color);
                font-size: 0.68rem;
                pointer-events: none;
            }

            .track-label ha-icon {
                flex: 0 0 auto;
                --mdc-icon-size: 13px;
            }

            /* The lane under edit, said the same way the label column said it. */
            .lane.selected .track-label {
                font-weight: 600;
            }

            .lane.unavailable .track-label .lane-name {
                font-style: italic;
            }

            /* A chart row's name sits on the row's own colour, and reads as a
               caption rather than as a thing on the chart. */
            .context-row .track-label {
                letter-spacing: 0.04em;
                text-transform: uppercase;
                color: var(--secondary-text-color);
                font-size: 0.58rem;
                background: linear-gradient(
                    to right,
                    var(--secondary-background-color) 0%,
                    color-mix(in srgb, var(--secondary-background-color) 85%, transparent) 70%,
                    transparent 100%
                );
            }

            /* A stretch of time the host is asking about, in the colours the
               rest of the surface uses for the same two questions. */
            .time-highlight {
                position: absolute;
                top: 0;
                bottom: 0;
                border-radius: 4px;
                pointer-events: none;
            }

            .time-highlight.selected {
                background: color-mix(in srgb, var(--helman-grid-import) 13%, transparent);
                box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--helman-grid-import) 50%, transparent);
            }

            .time-highlight.hover {
                background: color-mix(in srgb, var(--helman-selection) 14%, transparent);
                box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--helman-selection) 55%, transparent);
            }

            /* Muting the unselected lanes is what makes the selected one a
               foreground: they stay legible as context, but they do not compete
               with the row the editor below is about. With nothing selected
               there is no foreground to protect, so the day reads at full
               strength as the plan for the whole house. */
            .band.has-selection .lane:not(.selected) .track {
                opacity: 0.45;
            }

            .band.has-selection .lane:not(.selected) .track:hover {
                opacity: 0.75;
            }

            .lane.selected .track {
                border-color: color-mix(in srgb, var(--primary-color) 55%, var(--divider-color));
                box-shadow: 0 0 0 1px color-mix(in srgb, var(--primary-color) 30%, transparent);
            }

            .gap,
            .segment {
                position: absolute;
                top: 0;
                bottom: 0;
                padding: 0;
                border: none;
                font: inherit;
            }

            .gap {
                background: none;
                cursor: copy;
            }

            .gap:hover,
            .gap:focus-visible {
                background: color-mix(in srgb, var(--primary-color) 8%, transparent);
            }

            .segment {
                display: flex;
                align-items: center;
                justify-content: center;
                border-left: 1px solid color-mix(in srgb, var(--card-background-color) 60%, transparent);
                border-right: 1px solid color-mix(in srgb, var(--card-background-color) 60%, transparent);
                background: color-mix(in srgb, var(--schedule-action-tone-accent, var(--primary-color)) 38%, transparent);
                color: var(--schedule-action-tone-color, var(--primary-text-color));
                cursor: grab;
                overflow: hidden;
                touch-action: none;
            }

            .segment.dragging {
                cursor: grabbing;
            }

            /* Nothing here can be taken hold of, but everything can be asked
               about: a press hands the run to the host. */
            .band.readonly .segment {
                cursor: pointer;
            }

            /* Who put the run here, in the colours the rest of the card uses
               for it: a bar under the whole segment, so the answer is legible
               on a 30px track without competing with the tone that says what
               the run does. The bar carries authorship alone -- the fill is
               left free to say something else. */
            .segment.authorship-user {
                --schedule-authorship-color: var(--schedule-authorship-user-color, #c49012);
            }

            .segment.authorship-automation {
                --schedule-authorship-color: var(--schedule-authorship-automation-color, #2563eb);
            }

            .segment.authorship-mixed {
                --schedule-authorship-color: var(--schedule-authorship-mixed-color, #ea7a18);
            }

            .segment {
                box-shadow: inset 0 -3px 0 var(--schedule-authorship-color, transparent);
            }

            /* Candidate: planned, but its execution condition is not currently
               met, so nothing will run unless that changes. Hatched rather
               than merely faded -- a 30px track has no room for a dashed
               outline, and "provisional" has to survive being 20px wide. The
               chips in the list use dashed + muted for the same fact. */
            .segment.candidate {
                background:
                    repeating-linear-gradient(
                        135deg,
                        color-mix(in srgb, var(--schedule-action-tone-accent, var(--primary-color)) 34%, transparent) 0 6px,
                        color-mix(in srgb, var(--schedule-action-tone-accent, var(--primary-color)) 16%, transparent) 6px 12px
                    );
            }

            .segment.dirty {
                outline: 2px solid var(--schedule-authorship-user-color, #c49012);
                outline-offset: -2px;
            }

            /* The block under edit, matching the highlight on its list row. */
            .segment.editing {
                z-index: 2;
                outline: 2px solid var(--primary-color);
                outline-offset: -2px;
                box-shadow:
                    inset 0 -3px 0 var(--schedule-authorship-color, transparent),
                    0 0 0 1px color-mix(in srgb, var(--primary-color) 40%, transparent);
            }

            /* Mirrors the hover on this block's list row. */
            .segment.hovered:not(.editing) {
                outline: 2px solid color-mix(in srgb, var(--primary-color) 55%, transparent);
                outline-offset: -2px;
            }

            .segment.past {
                opacity: 0.45;
                cursor: pointer;
            }

            /* What already happened: flat and quiet. No stripes and no
               authorship bar -- nobody "set" the past, it simply is -- and
               nothing to drag. It does keep its hit area, because a run you
               cannot point at cannot tell you what it was; pressing it selects
               its lane, exactly as the bare track does. */
            .segment.actual {
                background: color-mix(in srgb, var(--schedule-action-tone-accent, var(--primary-color)) 22%, transparent);
                box-shadow: none;
                opacity: 0.85;
                cursor: pointer;
            }

            .segment.actual ha-icon {
                opacity: 0.6;
            }

            /* The moment the setting changed, on a seam that would otherwise be
               invisible. Drawn from the text colour so it reads as a cut in
               both themes rather than as a black line that only suits one. */
            .segment.changed::before {
                content: "";
                position: absolute;
                top: 0;
                bottom: 0;
                left: 0;
                width: 2px;
                background: color-mix(in srgb, var(--primary-text-color) 65%, transparent);
            }

            .segment ha-icon {
                --mdc-icon-size: 14px;
                pointer-events: none;
            }

            .handle {
                position: absolute;
                top: 0;
                bottom: 0;
                width: 8px;
                cursor: ew-resize;
                touch-action: none;
            }

            .handle::after {
                content: "";
                position: absolute;
                top: 20%;
                bottom: 20%;
                left: 3px;
                width: 2px;
                border-radius: 1px;
                background: color-mix(in srgb, var(--primary-text-color) 34%, transparent);
            }

            .handle.start {
                left: 0;
            }

            .handle.end {
                right: 0;
            }

            /* The hours already lived through, washed out the same way on every
               row of the day: the forecast behind the now-line is history just
               as much as the runs are, and reading one as live and the other as
               past is what made the two halves of the band feel unrelated. */
            .past-overlay {
                position: absolute;
                top: 0;
                bottom: 0;
                left: 0;
                background: color-mix(in srgb, var(--primary-text-color) 8%, transparent);
                pointer-events: none;
            }

            /* A chart sits on the grey row rather than on the card, so a dark
               wash over it does nothing. It is veiled in the row's own colour
               instead -- the bars fade towards the background they stand on,
               which is the same "this is behind us" the tracks get, said in the
               colour that works here. */
            .context-row .past-overlay {
                border-radius: 4px 0 0 4px;
                background: color-mix(in srgb, var(--secondary-background-color) 62%, transparent);
            }

            .now-marker {
                position: absolute;
                top: -2px;
                bottom: -2px;
                width: 2px;
                background: var(--primary-color);
                pointer-events: none;
            }

            .axis {
                position: relative;
                height: 14px;
            }

            .axis-tick {
                position: absolute;
                top: 0;
                color: var(--secondary-text-color);
                font-size: 0.65rem;
                transform: translateX(-50%);
            }

            .axis-tick:first-child {
                transform: none;
            }
        `,
    ];

    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public day!: EntityScheduleDay;
    @property({ attribute: false }) public lanes: readonly EntityDayBandLane[] = [];
    @property({ attribute: false }) public forecastPoints: ReadonlyMap<string, SlotForecastPoint> = new Map();
    /** The range being edited on the selected lane, highlighted and draggable. */
    @property({ attribute: false }) public editingRange: EntityScheduleRange | null = null;
    /** The lane the block list and the editor below are about. */
    @property({ type: String }) public selectedLaneKey: string | null = null;
    @property({ type: Number }) public nowMs = Date.now();
    /** How the price is denominated, for the chart's own tooltips. */
    @property({ type: String }) public priceUnit: string | null = null;
    /** The block the pointer is over, wherever it was pointed at. */
    @property({ type: String }) public hoveredBlockKey: string | null = null;
    @property({ type: String }) public locale = "cs";
    @property({ type: String }) public timeZone = "UTC";
    /**
     * Nothing here can be authored: no gaps to press, no handles, no drags.
     *
     * The runs stay live targets, though. A read-only band is still the
     * quickest way to say "that one" -- it just hands the question to whoever
     * is hosting it rather than answering it in place.
     */
    @property({ type: Boolean }) public readonly = false;
    /**
     * The slice of the day the tracks span, when the host is aligning them to
     * something else. Defaults to the whole day.
     *
     * A host that crops its charts to daylight has to crop the band the same
     * way or the two stop being the same axis, which is the only reason to put
     * them next to each other.
     */
    @property({ type: Number }) public windowStartMs: number | null = null;
    @property({ type: Number }) public windowEndMs: number | null = null;
    /** Draw the battery/solar/price rows, or leave the context to the host. */
    @property({ type: Boolean }) public showForecastRows = true;
    /** Draw the hour ticks, or leave the axis to the host's own chart. */
    @property({ type: Boolean }) public showAxis = true;
    /**
     * Where a lane says its name: in a column beside the tracks, or inside the
     * track itself.
     *
     * In-track labels are what a host with no room for a label column gets --
     * giving one up is what lets the tracks line up with a chart above.
     */
    @property({ type: String }) public laneLabels: "column" | "track" = "column";
    /**
     * Stretches of the day to wash, whatever it is that makes them special.
     *
     * The band is told which times matter rather than working it out: what
     * counts as selected is the host's question, and the same mark serves a
     * chart's selected slot, a hovered hour, and -- eventually -- the block
     * under the pointer in the list beside it.
     */
    @property({ attribute: false }) public highlightRanges: readonly EntityDayBandHighlight[] = [];

    @state() private _drag: DragSession | null = null;
    /**
     * The track's width, measured after each update rather than while
     * rendering: reading it per segment forces a synchronous layout for every
     * block of every lane, and during a drag that happens at pointer rate.
     */
    @state() private _trackWidthPx = 0;

    private readonly _handlePointerMove = (event: PointerEvent): void => {
        const drag = this._drag;
        if (drag === null || event.pointerId !== drag.pointerId) {
            return;
        }

        event.preventDefault();
        const pointerMs = this._snapMs(this._readPointerMs(event, drag.trackRect));
        const range = this._resolveDragRange(drag, pointerMs);
        // Ranges are snapped to whole slots, so most pointer moves land where
        // the last one did. Announcing those rebuilds the draft for nothing.
        if (range.startMs === this._lastDragRange?.startMs && range.endMs === this._lastDragRange.endMs) {
            return;
        }

        this._lastDragRange = range;
        this.dispatchEvent(new CustomEvent<EntityDayBandRangeChangeDetail>("entity-day-band-range-change", {
            bubbles: true,
            composed: true,
            detail: range,
        }));
    };

    private _lastDragRange: EntityScheduleRange | null = null;
    /** The last hover announced, so a pointer crossing rows says it once. */
    private _lastHoverMs: number | null = null;

    private readonly _handlePointerUp = (event: PointerEvent): void => {
        if (this._drag !== null && event.pointerId !== this._drag.pointerId) {
            return;
        }

        this._endDrag();
    };

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this._endDrag();
    }

    updated(): void {
        this._trackWidthPx = this._readTrackRect(this.lanes[0]?.key ?? "")?.width ?? 0;
    }

    render() {
        if (!this.day) {
            return nothing;
        }

        const hasSelection = this.lanes.some((lane) => lane.key === this.selectedLaneKey);
        const inTrackLabels = this.laneLabels === "track";
        const classes = [
            "band",
            hasSelection ? "has-selection" : "",
            inTrackLabels ? "labels-in-track" : "",
            this.readonly ? "readonly" : "",
        ].filter((value) => value.length > 0).join(" ");
        return html`
            <div
                class=${classes}
                @mousemove=${this._handleTimeHover}
                @mouseleave=${() => this._emitTimeHover(null)}
            >
                ${this.showForecastRows ? html`
                    ${this._renderSocRow()}
                    ${this._renderSolarRow()}
                    ${this._renderPriceRow()}
                ` : nothing}
                ${this.lanes.map((lane) => this._renderLane(lane))}
                ${this.showAxis ? html`
                    ${inTrackLabels ? nothing : html`<span></span>`}
                    <div class="axis">
                        ${this._renderAxisTicks()}
                    </div>
                ` : nothing}
            </div>
        `;
    }

    /**
     * The hour ticks that fall inside the window.
     *
     * Cropping to daylight drops the ones that scrolled off rather than
     * squeezing all eight into what is left -- a "00" at the left edge of a
     * band that starts at 04:00 is worse than no tick at all.
     */
    private _renderAxisTicks() {
        return AXIS_HOURS.flatMap((hour) => {
            const atMs = this.day.startMs + hour * 3_600_000;
            if (atMs < this._windowStartMs || atMs > this._windowEndMs) {
                return [];
            }

            return [html`
                <span class="axis-tick" style=${`left: ${this._toPercent(atMs)}%`}>
                    ${String(hour).padStart(2, "0")}
                </span>
            `];
        });
    }

    /**
     * A forecast row's name, wherever this band puts names.
     *
     * The context rows follow the lanes rather than keeping a column of their
     * own: a gutter that exists only for three chart names is a gutter, and the
     * stack reads as one thing when every row is labelled the same way.
     */
    private _renderContextHeading(labelKey: string) {
        return this.laneLabels === "track"
            ? nothing
            : html`<span class="row-label context">${this.localize(labelKey)}</span>`;
    }

    private _renderContextTrackLabel(labelKey: string) {
        return this.laneLabels === "track"
            ? html`<span class="track-label context">${this.localize(labelKey)}</span>`
            : nothing;
    }

    /**
     * Battery state of charge as a line across the day.
     *
     * A percentage is a level, not a quantity, so it gets a line on a fixed
     * 0-100 scale rather than bars scaled to the day -- the shape is only
     * meaningful against the full range.
     */
    private _renderSocRow() {
        const points = this.day.slots.flatMap((slot) => {
            const socPct = this.forecastPoints.get(slot.id)?.socPct;
            return socPct === undefined || socPct === null
                ? []
                : [{ x: this._toPercent(slot.startMs), y: 100 - Math.max(0, Math.min(socPct, 100)) }];
        });
        if (points.length < 2) {
            return nothing;
        }

        const line = points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
        const area = `${points[0].x.toFixed(2)},100 ${line} ${points[points.length - 1].x.toFixed(2)},100`;
        return html`
            ${this._renderContextHeading("scheduling.forecast.battery_label")}
            <div class="context-row" @pointerdown=${this._handleContextPointerDown}>
                <svg class="soc-chart" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <polygon class="soc-fill" points=${area}></polygon>
                    <polyline class="soc-line" points=${line}></polyline>
                </svg>
                ${this._renderSlotHits("battery")}
                ${this._renderRowOverlays()}
                ${this._renderContextTrackLabel("scheduling.forecast.battery_label")}
            </div>
        `;
    }

    private _renderSolarRow() {
        const values = this._readSeries("solar");
        const maxWh = values.reduce((max, entry) => Math.max(max, entry.value), 0);
        if (maxWh === 0) {
            return nothing;
        }

        return html`
            ${this._renderContextHeading("scheduling.forecast.solar_label")}
            <div class="context-row" @pointerdown=${this._handleContextPointerDown}>
                ${values.map(({ slot, value }) => value === 0 ? nothing : html`
                    <span
                        class="context-bar solar"
                        style=${`left: ${this._toPercent(slot.startMs)}%; width: ${this._toSlotWidthPercent(slot)}%; height: ${this._toBarPct(value, maxWh)}%`}
                    ></span>
                `)}
                ${this._renderSlotHits("solar")}
                ${this._renderRowOverlays()}
                ${this._renderContextTrackLabel("scheduling.forecast.solar_label")}
            </div>
        `;
    }

    private _renderPriceRow() {
        const values = this._readSeries("price");
        const maxPositive = values.reduce((max, entry) => Math.max(max, entry.value), 0);
        const maxNegative = values.reduce((max, entry) => Math.max(max, -entry.value), 0);
        if (maxPositive === 0 && maxNegative === 0) {
            return nothing;
        }

        return html`
            ${this._renderContextHeading("scheduling.forecast.price_label")}
            <div class="context-row price" @pointerdown=${this._handleContextPointerDown}>
                <span class="zero-line"></span>
                ${values.map(({ slot, value }) => {
                    if (value === 0) {
                        return nothing;
                    }

                    const positive = value > 0;
                    // Each half owns 50% of the row, so a bar's own percentage
                    // is halved to stay inside it.
                    const heightPct = this._toBarPct(Math.abs(value), positive ? maxPositive : maxNegative) / 2;
                    return html`
                        <span
                            class=${`context-bar ${positive ? "price-positive" : "price-negative"}`}
                            style=${`left: ${this._toPercent(slot.startMs)}%; width: ${this._toSlotWidthPercent(slot)}%; height: ${heightPct}%`}
                        ></span>
                    `;
                })}
                ${this._renderSlotHits("price")}
                ${this._renderRowOverlays()}
                ${this._renderContextTrackLabel("scheduling.forecast.price_label")}
            </div>
        `;
    }

    /**
     * Where one run becomes a different one with no gap between them.
     *
     * Two runs that touch are only distinguishable by their icon, and actions
     * of the same kind share a colour -- stopping the export looks exactly like
     * stopping the charge. Without a mark, the moment the setting changed is
     * invisible, which is the one thing a strip of time is there to show.
     *
     * Runs that touch and agree are deliberately left unmarked: that is the
     * still-running case, where the past meeting its scheduled continuation has
     * to read as one bar.
     */
    private _resolveChangeBoundaries(lane: EntityDayBandLane): Set<number> {
        const runs = [...lane.actualSegments, ...lane.blocks]
            .sort((left, right) => left.startMs - right.startMs);
        const boundaries = new Set<number>();
        for (let index = 1; index < runs.length; index += 1) {
            const previous = runs[index - 1];
            const run = runs[index];
            if (
                previous.endMs === run.startMs
                && !areEntityScheduleActionsEqual(previous.action, run.action)
            ) {
                boundaries.add(run.startMs);
            }
        }

        return boundaries;
    }

    private _renderLane(lane: EntityDayBandLane) {
        const selected = lane.key === this.selectedLaneKey;
        const changeBoundaries = this._resolveChangeBoundaries(lane);
        const classes = [
            "lane",
            selected ? "selected" : "",
            lane.isAvailable ? "" : "unavailable",
        ].filter((value) => value.length > 0).join(" ");
        const inTrackLabels = this.laneLabels === "track";
        return html`
            <div class=${classes} data-lane=${lane.key}>
                ${inTrackLabels ? nothing : html`
                    <button
                        class="row-label lane-label"
                        type="button"
                        aria-pressed=${selected}
                        title=${lane.name}
                        @click=${() => this._emitLaneSelect(lane.key)}
                    >
                        <ha-icon .icon=${lane.icon}></ha-icon>
                        <span class="lane-name">${lane.name}</span>
                        ${this._renderLaneTotal(lane)}
                    </button>
                `}
                <!--
                    Bare track: the elapsed stretch carries no gap button, so a
                    press there would otherwise do nothing. Pressing a lane
                    anywhere means "this entity", exactly as its name does.
                -->
                <div
                    class="track"
                    title=${inTrackLabels ? lane.name : nothing}
                    @click=${(event: Event) => this._handleTrackClick(event, lane.key)}
                >
                    ${lane.actualSegments.map((segment) => this._renderActualSegment(lane, segment, changeBoundaries))}
                    ${this._renderGaps(lane)}
                    ${lane.blocks.map((block) => this._renderSegment(lane, block, selected, changeBoundaries))}
                    ${this._renderRowOverlays()}
                    ${inTrackLabels ? this._renderTrackLabel(lane) : nothing}
                </div>
            </div>
        `;
    }

    /**
     * The lane's name inside its own track, for hosts with no label column.
     *
     * It floats over whatever is there rather than pushing the track's start to
     * the right, because the track's start is a time and moving it would put the
     * whole band out of step with the chart it is aligned to. The gradient
     * behind it is what keeps it readable when an early run happens to sit
     * underneath, and it takes no pointer events, so the run it covers is still
     * the thing being pointed at.
     */
    private _renderTrackLabel(lane: EntityDayBandLane) {
        return html`
            <span class="track-label">
                <ha-icon .icon=${lane.icon}></ha-icon>
                <span class="lane-name">${lane.name}</span>
                ${this._renderLaneTotal(lane)}
            </span>
        `;
    }

    /**
     * The stretches with nothing scheduled, as buttons that start a new block
     * there -- pointing at an empty evening is the fastest way to say "run it
     * then".
     */
    private _renderGaps(lane: EntityDayBandLane) {
        if (this.readonly) {
            return nothing;
        }

        const gaps: { startMs: number; endMs: number }[] = [];
        let cursorMs = Math.max(this.day.startMs, this.day.editableFromMs);
        for (const block of lane.blocks) {
            if (block.startMs > cursorMs) {
                gaps.push({ startMs: cursorMs, endMs: block.startMs });
            }
            cursorMs = Math.max(cursorMs, block.endMs);
        }
        if (cursorMs < this.day.endMs) {
            gaps.push({ startMs: cursorMs, endMs: this.day.endMs });
        }

        return gaps.map((gap) => html`
            <button
                class="gap"
                type="button"
                title=${this.localize("scheduling.entity_editor.add_block")}
                aria-label=${this.localize("scheduling.entity_editor.add_block")}
                style=${`left: ${this._toPercent(gap.startMs)}%; width: ${this._toWidthPercent(gap.startMs, gap.endMs)}%`}
                @click=${(event: MouseEvent) => this._handleGapClick(event, lane.key, gap)}
            ></button>
        `);
    }

    /**
     * A new block starts where the pointer landed, not where the free stretch
     * began -- on a day with one block in it the gap is most of the day, and
     * "add a block" has to mean "here".
     */
    private _handleGapClick(
        event: MouseEvent,
        laneKey: string,
        gap: { startMs: number; endMs: number },
    ): void {
        const trackRect = this._readTrackRect(laneKey);
        const stepMs = this._resolveStepMs();
        const startMs = trackRect === null
            ? gap.startMs
            : Math.min(
                Math.max(this._snapMs(this._readPointerMs(event, trackRect)), gap.startMs),
                Math.max(gap.endMs - stepMs, gap.startMs),
            );
        this._emitGapSelect(laneKey, startMs, gap.endMs);
    }

    /**
     * A run that already happened.
     *
     * Drawn flat and inert: it is measured rather than planned, so it carries no
     * authorship bar, no handles and no hit area -- pressing it falls through to
     * the track, which selects the lane. It sits in the same tone as the action
     * it was, so a run that is still going reads as one bar across the now-line.
     */
    private _renderActualSegment(
        lane: EntityDayBandLane,
        segment: EntityActualSegment,
        changeBoundaries: ReadonlySet<number>,
    ) {
        const presentation = this._getPresentation(lane, segment);
        // The hours it really ran, which is not the width when it spent only
        // part of a slot doing it.
        const title = `${lane.name} · ${presentation.label} · ${this._formatRange(segment, segment.activeMs)}`;
        return html`
            <span
                class=${`segment actual ${presentation.toneClass}${changeBoundaries.has(segment.startMs) ? " changed" : ""}`}
                title=${title}
                style=${`left: ${this._toPercent(segment.startMs)}%; width: ${this._toWidthPercent(segment.startMs, segment.endMs)}%`}
                @click=${() => this._emitLaneSelect(lane.key)}
            >
                <ha-icon .icon=${presentation.icon}></ha-icon>
            </span>
        `;
    }

    private _renderSegment(
        lane: EntityDayBandLane,
        block: EntityScheduleBlock,
        laneSelected: boolean,
        changeBoundaries: ReadonlySet<number>,
    ) {
        const presentation = this._getPresentation(lane, block);
        const editing = laneSelected && this._isEditing(block);
        const widthPct = this._toWidthPercent(block.startMs, block.endMs);
        // Handles only on the lane being edited: eight tracks' worth of grips
        // would be noise, and a muted lane is context, not a control.
        const resizable = laneSelected
            && !this.readonly
            && !block.isPast
            && this._isWideEnoughToResize(widthPct);
        const classes = [
            "segment",
            presentation.toneClass,
            `authorship-${block.authorship}`,
            presentation.isCandidate ? "candidate" : "",
            block.isDirty ? "dirty" : "",
            block.isPast ? "past" : "",
            editing ? "editing" : "",
            changeBoundaries.has(block.startMs) ? "changed" : "",
            laneSelected && this.hoveredBlockKey === block.key ? "hovered" : "",
            this._drag !== null && editing ? "dragging" : "",
        ].filter((value) => value.length > 0).join(" ");
        const title = `${lane.name} · ${presentation.label} · ${this._formatRange(block)}`;

        return html`
            <!--
                An elapsed block is a live button, not a disabled one: pressing
                it selects its lane, the same as pressing the lane's name or its
                empty track, and simply opens no edit session. Marking it
                disabled would make the oldest part of the day a dead zone --
                and would lie, since the press does do something.
            -->
            <button
                class=${classes}
                type="button"
                title=${title}
                aria-label=${title}
                aria-pressed=${editing}
                style=${`left: ${this._toPercent(block.startMs)}%; width: ${widthPct}%`}
                @pointerdown=${(event: PointerEvent) => this._handleSegmentPointerDown(event, lane, block, "move")}
                @click=${() => this._emitBlockSelect(lane.key, block)}
                @mouseenter=${() => this._emitBlockHover(laneSelected ? block.key : null)}
                @mouseleave=${() => this._emitBlockHover(null)}
            >
                ${resizable ? html`
                    <span
                        class="handle start"
                        @pointerdown=${(event: PointerEvent) => this._handleSegmentPointerDown(event, lane, block, "start")}
                    ></span>
                ` : nothing}
                <ha-icon .icon=${presentation.icon}></ha-icon>
                ${resizable ? html`
                    <span
                        class="handle end"
                        @pointerdown=${(event: PointerEvent) => this._handleSegmentPointerDown(event, lane, block, "end")}
                    ></span>
                ` : nothing}
            </button>
        `;
    }

    /**
     * How long this entity runs today, the whole day through.
     *
     * The blocks say when; this says how much, which is the number a person
     * actually holds an opinion about ("the boiler only needs three hours").
     * It counts the hours already run as well as the ones still scheduled --
     * a day is not two days -- with the split in the tooltip, because adding a
     * measured past to a planned future hides which half is which.
     */
    private _renderLaneTotal(lane: EntityDayBandLane) {
        const plannedMs = lane.blocks.reduce((total, block) => total + (block.endMs - block.startMs), 0);
        const actualMs = lane.actualSegments.reduce((total, segment) => total + segment.activeMs, 0);
        if (plannedMs + actualMs <= 0) {
            return nothing;
        }

        const format = (ms: number): string => this._formatHours(ms);
        const title = actualMs > 0 && plannedMs > 0
            ? `${format(actualMs)} + ${format(plannedMs)}`
            : "";
        return html`<span class="lane-total" title=${title}>${format(plannedMs + actualMs)}</span>`;
    }

    /**
     * One hover target per slot, so a chart can say what it is showing.
     *
     * A layer of its own rather than titles on the bars: a slot with no solar
     * draws no bar, and the battery line is one path for the whole day, so
     * there is nothing per-hour to hang a tooltip on. Invisible and inert
     * beyond the tooltip -- pressing still falls through to the row, which
     * clears the lane selection.
     */
    private _renderSlotHits(kind: "battery" | "solar" | "price") {
        return this.day.slots.map((slot) => {
            const title = this._buildSlotHitTitle(kind, slot);
            return title === null ? nothing : html`
                <span
                    class="slot-hit"
                    title=${title}
                    style=${`left: ${this._toPercent(slot.startMs)}%; width: ${this._toSlotWidthPercent(slot)}%`}
                ></span>
            `;
        });
    }

    private _buildSlotHitTitle(
        kind: "battery" | "solar" | "price",
        slot: { id: string; startMs: number; endMs: number | null },
    ): string | null {
        const point = this.forecastPoints.get(slot.id);
        if (point === undefined) {
            return null;
        }

        const range = `${formatScheduleTime(slot.startMs, this.locale, this.timeZone)}–${
            formatScheduleTime(slot.endMs ?? slot.startMs, this.locale, this.timeZone)}`;
        if (kind === "battery") {
            return point.socPct === null || point.socPct === undefined
                ? null
                : `${this.localize("scheduling.forecast.battery_label")} · ${Math.round(point.socPct)} % · ${range}`;
        }

        if (kind === "solar") {
            if (point.solarWh === null || point.solarWh === undefined) {
                return null;
            }

            const kwh = point.solarWh / 1000;
            const value = kwh >= 10 ? `${Math.round(kwh)}` : kwh.toFixed(1);
            return `${this.localize("scheduling.forecast.solar_label")} · ${value} kWh · ${range}`;
        }

        if (point.price === null || point.price === undefined) {
            return null;
        }

        const price = this.priceUnit === null
            ? point.price.toFixed(1)
            : `${point.price.toFixed(1)} ${this.priceUnit}`;
        return `${this.localize("scheduling.forecast.price_label")} · ${price} · ${range}`;
    }

    /**
     * The two marks every row of the day carries: where the past ends and where
     * now is.
     *
     * Drawn per row rather than once over the band because the rows are laid
     * out by the grid and are only two pixels apart -- close enough to read as
     * one line -- and because pinning a single overlay to the time column would
     * mean fixing the label column's width, which the longest appliance name
     * gets to decide.
     */
    private _renderRowOverlays() {
        return html`${this._renderHighlights()}${this._renderPastOverlay()}${this._renderNowMarker()}`;
    }

    /**
     * The stretches the host asked to have marked.
     *
     * Behind the runs rather than over them: a highlight says which slice of
     * time is in question, and burying the answer under it would defeat the
     * asking. Inert, so pointing at a marked hour still reaches whatever is
     * drawn there.
     */
    private _renderHighlights() {
        return this.highlightRanges.map((range) => {
            const widthPct = this._toWidthPercent(range.startMs, range.endMs);
            return widthPct <= 0 ? nothing : html`
                <span
                    class=${`time-highlight ${range.kind}`}
                    style=${`left: ${this._toPercent(range.startMs)}%; width: ${widthPct}%`}
                ></span>
            `;
        });
    }

    /**
     * Where the pointer is on the time axis, for whoever is drawing the same
     * hours elsewhere.
     *
     * Measured against a track rather than the band, because a label column is
     * not part of the axis: a pointer over an entity's name is not over a time.
     * Any track will do -- they all span the same window -- so the first one
     * answers for the stack, including for the gaps between rows.
     */
    private readonly _handleTimeHover = (event: MouseEvent): void => {
        const rect = this._readTrackRect(this.lanes[0]?.key ?? "");
        if (rect === null || rect.width <= 0) {
            return;
        }

        const ratio = (event.clientX - rect.left) / rect.width;
        this._emitTimeHover(
            ratio < 0 || ratio > 1
                ? null
                : this._windowStartMs + ratio * (this._windowEndMs - this._windowStartMs),
        );
    };

    private _renderPastOverlay() {
        const boundaryMs = Math.min(Math.max(this.day.editableFromMs, this.day.startMs), this.day.endMs);
        if (boundaryMs <= this.day.startMs) {
            return nothing;
        }

        return html`
            <span
                class="past-overlay"
                style=${`width: ${this._toWidthPercent(this.day.startMs, boundaryMs)}%`}
            ></span>
        `;
    }

    private _renderNowMarker() {
        if (this.nowMs < this.day.startMs || this.nowMs > this.day.endMs) {
            return nothing;
        }

        return html`
            <span
                class="now-marker"
                title=${this.localize("scheduling.badge.now")}
                style=${`left: ${this._toPercent(this.nowMs)}%`}
            ></span>
        `;
    }

    /**
     * Begin a drag.
     *
     * The block is selected first -- which also selects its lane -- so a drag on
     * a block that was not being edited edits it. The travel limits are frozen
     * here: they come from where that lane's neighbours are *now*, and the block
     * being dragged changes identity as it moves.
     */
    private _handleSegmentPointerDown(
        event: PointerEvent,
        lane: EntityDayBandLane,
        block: EntityScheduleBlock,
        mode: DragMode,
    ): void {
        if (this.readonly || block.isPast || event.button !== 0) {
            return;
        }

        event.stopPropagation();
        event.preventDefault();
        this._emitBlockSelect(lane.key, block);

        const trackRect = this._readTrackRect(lane.key);
        if (trackRect === null) {
            return;
        }

        // A block that is already running starts in the past, but the session
        // the editor opened only owns the part still ahead. Dragging has to move
        // that part: taking the block's own start as the origin would carry the
        // elapsed hours along, and the clamp to the editable boundary would then
        // stretch the block by however much of it had already happened.
        const originStartMs = Math.max(block.startMs, this.day.editableFromMs);
        this._drag = {
            laneKey: lane.key,
            mode,
            originStartMs,
            originEndMs: block.endMs,
            grabMs: this._snapMs(this._readPointerMs(event, trackRect)),
            ...resolveEntityScheduleRangeLimits({
                blocks: lane.blocks,
                day: this.day,
                startMs: originStartMs,
                endMs: block.endMs,
            }),
            trackRect,
            pointerId: event.pointerId,
        };
        window.addEventListener("pointermove", this._handlePointerMove);
        window.addEventListener("pointerup", this._handlePointerUp);
        window.addEventListener("pointercancel", this._handlePointerUp);
    }

    /** Only presses that missed a gap or a segment; those speak for themselves. */
    private _handleTrackClick(event: Event, laneKey: string): void {
        if (event.target === event.currentTarget) {
            this._emitLaneSelect(laneKey);
        }
    }

    /** Pressing the forecast rows is how the user says "none of them". */
    private _handleContextPointerDown = (event: PointerEvent): void => {
        event.stopPropagation();
        this.dispatchEvent(new CustomEvent("entity-day-band-context-select", {
            bubbles: true,
            composed: true,
        }));
    };

    private _resolveDragRange(drag: DragSession, pointerMs: number): EntityDayBandRangeChangeDetail {
        const stepMs = this._resolveStepMs();
        if (drag.mode === "start") {
            const startMs = Math.min(
                Math.max(pointerMs, drag.minMs),
                drag.originEndMs - stepMs,
            );
            return { startMs, endMs: drag.originEndMs };
        }

        if (drag.mode === "end") {
            const endMs = Math.max(
                Math.min(pointerMs, drag.maxMs),
                drag.originStartMs + stepMs,
            );
            return { startMs: drag.originStartMs, endMs };
        }

        const durationMs = drag.originEndMs - drag.originStartMs;
        const startMs = Math.min(
            Math.max(drag.originStartMs + (pointerMs - drag.grabMs), drag.minMs),
            drag.maxMs - durationMs,
        );
        return { startMs, endMs: startMs + durationMs };
    }

    private _endDrag(): void {
        if (this._drag === null) {
            return;
        }

        this._drag = null;
        this._lastDragRange = null;
        window.removeEventListener("pointermove", this._handlePointerMove);
        window.removeEventListener("pointerup", this._handlePointerUp);
        window.removeEventListener("pointercancel", this._handlePointerUp);
    }

    private _readTrackRect(laneKey: string): DOMRect | null {
        const track = this.renderRoot.querySelector(`.lane[data-lane="${laneKey}"] .track`);
        return track === null ? null : track.getBoundingClientRect();
    }

    private _readPointerMs(event: { clientX: number }, trackRect: DOMRect): number {
        if (trackRect.width <= 0) {
            return this._windowStartMs;
        }

        const ratio = (event.clientX - trackRect.left) / trackRect.width;
        return this._windowStartMs + ratio * (this._windowEndMs - this._windowStartMs);
    }

    /** The nearest slot boundary: a block never starts mid-slot. */
    private _snapMs(atMs: number): number {
        const stepMs = this._resolveStepMs();
        const steps = Math.round((atMs - this.day.startMs) / stepMs);
        return Math.min(
            Math.max(this.day.startMs + steps * stepMs, this.day.startMs),
            this.day.endMs,
        );
    }

    private _resolveStepMs(): number {
        for (const slot of this.day.slots) {
            if (slot.endMs !== null && slot.endMs > slot.startMs) {
                return slot.endMs - slot.startMs;
            }
        }

        return 60 * 60 * 1000;
    }

    private _isWideEnoughToResize(widthPct: number): boolean {
        return this._trackWidthPx === 0
            || (widthPct / 100) * this._trackWidthPx >= MIN_RESIZABLE_WIDTH_PX;
    }

    private _isEditing(block: EntityScheduleBlock): boolean {
        const range = this.editingRange;
        return range !== null && block.startMs < range.endMs && block.endMs > range.startMs;
    }

    private _readSeries(kind: "solar" | "price") {
        return this.day.slots.map((slot) => {
            const point = this.forecastPoints.get(slot.id);
            const value = point === undefined
                ? null
                : kind === "solar" ? point.solarWh : point.price;
            return { slot, value: value ?? 0 };
        });
    }

    private _toBarPct(value: number, max: number): number {
        if (max <= 0) {
            return 0;
        }

        return Math.max(Math.min(Math.abs(value) / max, 1) * 100, MIN_BAR_PCT);
    }

    private _getPresentation(lane: EntityDayBandLane, run: { action: EntityScheduleAction }) {
        if (lane.target.kind === "inverter" && isEntityInverterAction(run.action)) {
            return getScheduleActionPresentation(run.action, this.localize);
        }

        return getScheduleApplianceActionPresentation({
            appliance: lane.appliance ?? { kind: "generic", icon: lane.icon },
            action: run.action === null || isEntityInverterAction(run.action) ? null : run.action,
            localize: this.localize,
        });
    }

    /**
     * "08:00-12:00 (4 h)".
     *
     * The span answers when, the total answers how much -- and for a run that
     * really happened those are different questions, since it can have spent
     * only part of a slot running.
     */
    private _formatRange(run: { startMs: number; endMs: number }, totalMs?: number): string {
        const format = (atMs: number): string => formatScheduleTime(atMs, this.locale, this.timeZone);
        return `${format(run.startMs)}–${format(run.endMs)} (${this._formatHours(totalMs ?? run.endMs - run.startMs)})`;
    }

    private _formatHours(durationMs: number): string {
        const hours = durationMs / 3_600_000;
        return `${hours.toLocaleString(this.locale, { maximumFractionDigits: 1 })} h`;
    }

    /** The span the tracks are drawn across: the whole day, or the host's crop. */
    private get _windowStartMs(): number {
        return this.windowStartMs ?? this.day.startMs;
    }

    private get _windowEndMs(): number {
        return this.windowEndMs ?? this.day.endMs;
    }

    /**
     * A moment's place along the track, clamped to the window's own edges.
     *
     * Widths are the difference between two of these rather than a duration
     * scaled on its own, so a run that starts before the window or ends after
     * it is cropped to what is visible instead of overflowing by however much
     * of it fell outside.
     */
    private _toPercent(atMs: number): number {
        const durationMs = this._windowEndMs - this._windowStartMs;
        if (durationMs <= 0) {
            return 0;
        }

        return Math.max(0, Math.min((atMs - this._windowStartMs) / durationMs, 1)) * 100;
    }

    private _toWidthPercent(startMs: number, endMs: number): number {
        return Math.max(0, this._toPercent(endMs) - this._toPercent(startMs));
    }

    private _toSlotWidthPercent(slot: { startMs: number; endMs: number | null }): number {
        const endMs = slot.endMs ?? slot.startMs;
        return endMs <= slot.startMs ? 0 : this._toWidthPercent(slot.startMs, endMs);
    }

    private _emitBlockSelect(laneKey: string, block: EntityScheduleBlock): void {
        if (block.isPast) {
            this._emitLaneSelect(laneKey);
            return;
        }

        this.dispatchEvent(new CustomEvent<EntityDayBandBlockSelectDetail>("entity-day-band-block-select", {
            bubbles: true,
            composed: true,
            detail: { laneKey, blockKey: block.key },
        }));
    }

    private _emitLaneSelect(laneKey: string): void {
        this.dispatchEvent(new CustomEvent<EntityDayBandLaneSelectDetail>("entity-day-band-lane-select", {
            bubbles: true,
            composed: true,
            detail: { laneKey },
        }));
    }

    private _emitTimeHover(atMs: number | null): void {
        if (atMs === this._lastHoverMs) {
            return;
        }

        this._lastHoverMs = atMs;
        this.dispatchEvent(new CustomEvent<EntityDayBandTimeHoverDetail>("entity-day-band-time-hover", {
            bubbles: true,
            composed: true,
            detail: { atMs },
        }));
    }

    private _emitBlockHover(blockKey: string | null): void {
        this.dispatchEvent(new CustomEvent<EntityDayBandBlockHoverDetail>("entity-day-band-block-hover", {
            bubbles: true,
            composed: true,
            detail: { blockKey },
        }));
    }

    private _emitGapSelect(laneKey: string, startMs: number, limitMs: number): void {
        this.dispatchEvent(new CustomEvent<EntityDayBandGapSelectDetail>("entity-day-band-gap-select", {
            bubbles: true,
            composed: true,
            detail: { laneKey, startMs, limitMs },
        }));
    }
}
