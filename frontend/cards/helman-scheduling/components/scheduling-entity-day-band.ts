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
    EntityScheduleTarget,
} from "../model/entity-day-schedule-model";
import {
    isEntityInverterAction,
    resolveEntityScheduleRangeLimits,
} from "../model/entity-day-schedule-model";
import { getScheduleActionPresentation } from "../model/schedule-action-presentation";
import { getScheduleApplianceActionPresentation } from "../model/schedule-appliance-action-presentation";
import type { ScheduleApplianceMetadata } from "../model/schedule-appliance-metadata";
import { formatScheduleTime } from "../model/schedule-time";
import type { SlotForecastPoint } from "../model/slot-forecast-model";
import { schedulingSharedStyles } from "../styles/scheduling-shared-styles";

const AXIS_HOURS = [0, 3, 6, 9, 12, 15, 18, 21];
/** A bar this short still has to be visible, or a small value reads as none. */
const MIN_BAR_PCT = 8;
/** Segments narrower than this are move-only: two edge handles would not fit. */
const MIN_RESIZABLE_WIDTH_PX = 34;

/** One entity's row of the band: its schedule for the day, already clipped. */
export interface EntityDayBandLane {
    key: string;
    name: string;
    icon: string;
    target: EntityScheduleTarget;
    appliance: ScheduleApplianceMetadata | null;
    blocks: readonly EntityScheduleBlock[];
    /** What the entity really did earlier today, already merged into runs. */
    actualSegments: readonly EntityActualSegment[];
    isAvailable: boolean;
}

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

            .track {
                position: relative;
                height: 30px;
                border: 1px solid var(--divider-color);
                border-radius: 6px;
                background: var(--card-background-color);
                overflow: hidden;
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

            /* Who put the run here, in the colours the rest of the card uses
               for it: a bar under the whole segment, so the answer is legible
               on a 30px track without competing with the tone that says what
               the run does. The optimizer's runs keep their stripes too --
               reading the same fact twice is what makes it quick. */
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

            .segment.automation {
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

            /* What already happened: flat, quiet and untouchable. No stripes and
               no authorship bar -- nobody "set" the past, it simply is -- and no
               hit area, so pressing it selects the lane like the bare track. */
            .segment.actual {
                background: color-mix(in srgb, var(--schedule-action-tone-accent, var(--primary-color)) 22%, transparent);
                box-shadow: none;
                opacity: 0.85;
                pointer-events: none;
            }

            .segment.actual ha-icon {
                opacity: 0.6;
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

            .past-overlay {
                position: absolute;
                top: 0;
                bottom: 0;
                left: 0;
                background: color-mix(in srgb, var(--primary-text-color) 8%, transparent);
                pointer-events: none;
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
    /** The block the pointer is over, wherever it was pointed at. */
    @property({ type: String }) public hoveredBlockKey: string | null = null;
    @property({ type: String }) public locale = "cs";
    @property({ type: String }) public timeZone = "UTC";

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
        return html`
            <div class=${`band${hasSelection ? " has-selection" : ""}`}>
                ${this._renderSocRow()}
                ${this._renderSolarRow()}
                ${this._renderPriceRow()}
                ${this.lanes.map((lane) => this._renderLane(lane))}
                <span></span>
                <div class="axis">
                    ${AXIS_HOURS.map((hour) => html`
                        <span class="axis-tick" style=${`left: ${(hour / 24) * 100}%`}>
                            ${String(hour).padStart(2, "0")}
                        </span>
                    `)}
                </div>
            </div>
        `;
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
            <span class="row-label context">${this.localize("scheduling.forecast.battery_label")}</span>
            <div class="context-row" @pointerdown=${this._handleContextPointerDown}>
                <svg class="soc-chart" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <polygon class="soc-fill" points=${area}></polygon>
                    <polyline class="soc-line" points=${line}></polyline>
                </svg>
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
            <span class="row-label context">${this.localize("scheduling.forecast.solar_label")}</span>
            <div class="context-row" @pointerdown=${this._handleContextPointerDown}>
                ${values.map(({ slot, value }) => value === 0 ? nothing : html`
                    <span
                        class="context-bar solar"
                        style=${`left: ${this._toPercent(slot.startMs)}%; width: ${this._toSlotWidthPercent(slot)}%; height: ${this._toBarPct(value, maxWh)}%`}
                    ></span>
                `)}
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
            <span class="row-label context">${this.localize("scheduling.forecast.price_label")}</span>
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
            </div>
        `;
    }

    private _renderLane(lane: EntityDayBandLane) {
        const selected = lane.key === this.selectedLaneKey;
        const classes = [
            "lane",
            selected ? "selected" : "",
            lane.isAvailable ? "" : "unavailable",
        ].filter((value) => value.length > 0).join(" ");
        return html`
            <div class=${classes} data-lane=${lane.key}>
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
                <!--
                    Bare track: the elapsed stretch carries no gap button, so a
                    press there would otherwise do nothing. Pressing a lane
                    anywhere means "this entity", exactly as its name does.
                -->
                <div class="track" @click=${(event: Event) => this._handleTrackClick(event, lane.key)}>
                    ${lane.actualSegments.map((segment) => this._renderActualSegment(lane, segment))}
                    ${this._renderGaps(lane)}
                    ${lane.blocks.map((block) => this._renderSegment(lane, block, selected))}
                    ${this._renderPastOverlay()}
                    ${this._renderNowMarker()}
                </div>
            </div>
        `;
    }

    /**
     * The stretches with nothing scheduled, as buttons that start a new block
     * there -- pointing at an empty evening is the fastest way to say "run it
     * then".
     */
    private _renderGaps(lane: EntityDayBandLane) {
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
                style=${`left: ${this._toPercent(gap.startMs)}%; width: ${this._toSpanPercent(gap.startMs, gap.endMs)}%`}
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
    private _renderActualSegment(lane: EntityDayBandLane, segment: EntityActualSegment) {
        const presentation = this._getPresentation(lane, segment);
        const title = `${lane.name} · ${presentation.label} · ${this._formatRange(segment)}`;
        return html`
            <span
                class=${`segment actual ${presentation.toneClass}`}
                title=${title}
                style=${`left: ${this._toPercent(segment.startMs)}%; width: ${this._toSpanPercent(segment.startMs, segment.endMs)}%`}
            >
                <ha-icon .icon=${presentation.icon}></ha-icon>
            </span>
        `;
    }

    private _renderSegment(lane: EntityDayBandLane, block: EntityScheduleBlock, laneSelected: boolean) {
        const presentation = this._getPresentation(lane, block);
        const editing = laneSelected && this._isEditing(block);
        const widthPct = this._toSpanPercent(block.startMs, block.endMs);
        // Handles only on the lane being edited: eight tracks' worth of grips
        // would be noise, and a muted lane is context, not a control.
        const resizable = laneSelected && !block.isPast && this._isWideEnoughToResize(widthPct);
        const classes = [
            "segment",
            presentation.toneClass,
            `authorship-${block.authorship}`,
            block.authorship === "user" ? "" : "automation",
            block.isDirty ? "dirty" : "",
            block.isPast ? "past" : "",
            editing ? "editing" : "",
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

        const format = (ms: number): string =>
            `${(ms / 3_600_000).toLocaleString(this.locale, { maximumFractionDigits: 1 })} h`;
        const title = actualMs > 0 && plannedMs > 0
            ? `${format(actualMs)} + ${format(plannedMs)}`
            : "";
        return html`<span class="lane-total" title=${title}>${format(plannedMs + actualMs)}</span>`;
    }

    private _renderPastOverlay() {
        const boundaryMs = Math.min(Math.max(this.day.editableFromMs, this.day.startMs), this.day.endMs);
        if (boundaryMs <= this.day.startMs) {
            return nothing;
        }

        return html`
            <span
                class="past-overlay"
                style=${`width: ${this._toSpanPercent(this.day.startMs, boundaryMs)}%`}
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
        if (block.isPast || event.button !== 0) {
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
            return this.day.startMs;
        }

        const ratio = (event.clientX - trackRect.left) / trackRect.width;
        return this.day.startMs + ratio * (this.day.endMs - this.day.startMs);
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

    private _formatRange(run: { startMs: number; endMs: number }): string {
        const format = (atMs: number): string => formatScheduleTime(atMs, this.locale, this.timeZone);
        return `${format(run.startMs)}–${format(run.endMs)}`;
    }

    private _toPercent(atMs: number): number {
        return this._toSpanPercent(this.day.startMs, atMs);
    }

    private _toSpanPercent(startMs: number, endMs: number): number {
        const durationMs = this.day.endMs - this.day.startMs;
        if (durationMs <= 0) {
            return 0;
        }

        return Math.max(0, Math.min((endMs - startMs) / durationMs, 1)) * 100;
    }

    private _toSlotWidthPercent(slot: { startMs: number; endMs: number | null }): number {
        const endMs = slot.endMs ?? slot.startMs;
        return endMs <= slot.startMs ? 0 : this._toSpanPercent(slot.startMs, endMs);
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
