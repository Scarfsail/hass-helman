import { LitElement, css, html } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import { helmanColorVars } from "../../color-vars";
import type { LocalizeFunction } from "../../localize/localize";
import type {
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

export interface EntityDayBandBlockSelectDetail {
    blockKey: string;
}

export interface EntityDayBandGapSelectDetail {
    startMs: number;
}

export interface EntityDayBandBlockHoverDetail {
    blockKey: string | null;
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
 * One day of one entity's schedule as a clock-time band.
 *
 * The point of the band over a list of rows is that a whole day fits at once,
 * and that battery, solar and price sit directly under the blocks -- for a
 * single appliance the only real question is *when*, and that question is
 * answered by the forecast, not by the schedule.
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
            .band {
                display: flex;
                flex-direction: column;
                gap: 2px;
                touch-action: pan-y;
            }

            .context-row {
                position: relative;
                height: 18px;
                border-radius: 4px;
                background: var(--secondary-background-color);
                overflow: hidden;
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

            .context-label {
                position: absolute;
                top: 1px;
                left: 4px;
                color: var(--secondary-text-color);
                font-size: 0.6rem;
                letter-spacing: 0.04em;
                text-transform: uppercase;
                pointer-events: none;
            }

            .track {
                position: relative;
                height: 40px;
                border: 1px solid var(--divider-color);
                border-radius: 6px;
                background: var(--card-background-color);
                overflow: hidden;
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

            .segment.automation {
                /* Owned by the optimizer: striped, so "I did not put this here"
                   is visible without reading the block list. */
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
                box-shadow: 0 0 0 1px color-mix(in srgb, var(--primary-color) 40%, transparent);
            }

            /* Mirrors the hover on this block's list row. */
            .segment.hovered:not(.editing) {
                outline: 2px solid color-mix(in srgb, var(--primary-color) 55%, transparent);
                outline-offset: -2px;
            }

            .segment.past {
                opacity: 0.45;
                cursor: default;
            }

            .segment ha-icon {
                --mdc-icon-size: 16px;
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
    @property({ attribute: false }) public blocks: readonly EntityScheduleBlock[] = [];
    @property({ attribute: false }) public target!: EntityScheduleTarget;
    @property({ attribute: false }) public appliance: ScheduleApplianceMetadata | null = null;
    @property({ attribute: false }) public forecastPoints: ReadonlyMap<string, SlotForecastPoint> = new Map();
    /** The range being edited, highlighted here and moved by dragging. */
    @property({ attribute: false }) public editingRange: EntityScheduleRange | null = null;
    @property({ type: Number }) public nowMs = Date.now();
    /** The block the pointer is over, wherever it was pointed at. */
    @property({ type: String }) public hoveredBlockKey: string | null = null;
    @property({ type: String }) public locale = "cs";
    @property({ type: String }) public timeZone = "UTC";

    @state() private _drag: DragSession | null = null;

    private readonly _handlePointerMove = (event: PointerEvent): void => {
        const drag = this._drag;
        if (drag === null || event.pointerId !== drag.pointerId) {
            return;
        }

        event.preventDefault();
        const pointerMs = this._snapMs(this._readPointerMs(event, drag.trackRect));
        const range = this._resolveDragRange(drag, pointerMs);
        this.dispatchEvent(new CustomEvent<EntityDayBandRangeChangeDetail>("entity-day-band-range-change", {
            bubbles: true,
            composed: true,
            detail: range,
        }));
    };

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

    render() {
        if (!this.day) {
            return nothing;
        }

        return html`
            <div class="band">
                ${this._renderSocRow()}
                ${this._renderSolarRow()}
                ${this._renderPriceRow()}
                <div class="track">
                    ${this._renderGaps()}
                    ${this.blocks.map((block) => this._renderSegment(block))}
                    ${this._renderPastOverlay()}
                    ${this._renderNowMarker()}
                </div>
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
            <div class="context-row">
                <svg class="soc-chart" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <polygon class="soc-fill" points=${area}></polygon>
                    <polyline class="soc-line" points=${line}></polyline>
                </svg>
                <span class="context-label">${this.localize("scheduling.forecast.battery_label")}</span>
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
            <div class="context-row">
                ${values.map(({ slot, value }) => value === 0 ? nothing : html`
                    <span
                        class="context-bar solar"
                        style=${`left: ${this._toPercent(slot.startMs)}%; width: ${this._toSlotWidthPercent(slot)}%; height: ${this._toBarPct(value, maxWh)}%`}
                    ></span>
                `)}
                <span class="context-label">${this.localize("scheduling.forecast.solar_label")}</span>
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
            <div class="context-row price">
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
                <span class="context-label">${this.localize("scheduling.forecast.price_label")}</span>
            </div>
        `;
    }

    /**
     * The stretches with nothing scheduled, as buttons that start a new block
     * there -- pointing at an empty evening is the fastest way to say "run it
     * then".
     */
    private _renderGaps() {
        const gaps: { startMs: number; endMs: number }[] = [];
        let cursorMs = Math.max(this.day.startMs, this.day.editableFromMs);
        for (const block of this.blocks) {
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
                @click=${() => this._emitGapSelect(gap.startMs)}
            ></button>
        `);
    }

    private _renderSegment(block: EntityScheduleBlock) {
        const presentation = this._getPresentation(block);
        const editing = this._isEditing(block);
        const widthPct = this._toSpanPercent(block.startMs, block.endMs);
        const resizable = !block.isPast && this._isWideEnoughToResize(widthPct);
        const classes = [
            "segment",
            presentation.toneClass,
            block.authorship === "user" ? "" : "automation",
            block.isDirty ? "dirty" : "",
            block.isPast ? "past" : "",
            editing ? "editing" : "",
            this.hoveredBlockKey === block.key ? "hovered" : "",
            this._drag !== null && editing ? "dragging" : "",
        ].filter((value) => value.length > 0).join(" ");
        const title = `${presentation.label} · ${this._formatRange(block)}`;

        return html`
            <button
                class=${classes}
                type="button"
                ?disabled=${block.isPast}
                title=${title}
                aria-label=${title}
                aria-pressed=${editing}
                style=${`left: ${this._toPercent(block.startMs)}%; width: ${widthPct}%`}
                @pointerdown=${(event: PointerEvent) => this._handleSegmentPointerDown(event, block, "move")}
                @click=${() => this._emitBlockSelect(block)}
                @mouseenter=${() => this._emitBlockHover(block.key)}
                @mouseleave=${() => this._emitBlockHover(null)}
            >
                ${resizable ? html`
                    <span
                        class="handle start"
                        @pointerdown=${(event: PointerEvent) => this._handleSegmentPointerDown(event, block, "start")}
                    ></span>
                ` : nothing}
                <ha-icon .icon=${presentation.icon}></ha-icon>
                ${resizable ? html`
                    <span
                        class="handle end"
                        @pointerdown=${(event: PointerEvent) => this._handleSegmentPointerDown(event, block, "end")}
                    ></span>
                ` : nothing}
            </button>
        `;
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
     * The block is selected first, so a drag on a block that was not being
     * edited edits it, and the travel limits are frozen here: they come from
     * where the neighbours are *now*, and the block being dragged changes
     * identity as it moves.
     */
    private _handleSegmentPointerDown(
        event: PointerEvent,
        block: EntityScheduleBlock,
        mode: DragMode,
    ): void {
        if (block.isPast || event.button !== 0) {
            return;
        }

        event.stopPropagation();
        event.preventDefault();
        this._emitBlockSelect(block);

        const trackRect = this._readTrackRect();
        if (trackRect === null) {
            return;
        }

        this._drag = {
            mode,
            originStartMs: block.startMs,
            originEndMs: block.endMs,
            grabMs: this._snapMs(this._readPointerMs(event, trackRect)),
            ...resolveEntityScheduleRangeLimits({
                blocks: this.blocks,
                day: this.day,
                startMs: block.startMs,
                endMs: block.endMs,
            }),
            trackRect,
            pointerId: event.pointerId,
        };
        window.addEventListener("pointermove", this._handlePointerMove);
        window.addEventListener("pointerup", this._handlePointerUp);
        window.addEventListener("pointercancel", this._handlePointerUp);
    }

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
        window.removeEventListener("pointermove", this._handlePointerMove);
        window.removeEventListener("pointerup", this._handlePointerUp);
        window.removeEventListener("pointercancel", this._handlePointerUp);
    }

    private _readTrackRect(): DOMRect | null {
        const track = this.renderRoot.querySelector(".track");
        return track === null ? null : track.getBoundingClientRect();
    }

    private _readPointerMs(event: PointerEvent, trackRect: DOMRect): number {
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
        const trackWidth = this._readTrackRect()?.width ?? 0;
        return trackWidth === 0 || (widthPct / 100) * trackWidth >= MIN_RESIZABLE_WIDTH_PX;
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

    private _getPresentation(block: EntityScheduleBlock) {
        if (this.target.kind === "inverter" && isEntityInverterAction(block.action)) {
            return getScheduleActionPresentation(block.action, this.localize);
        }

        return getScheduleApplianceActionPresentation({
            appliance: this.appliance ?? { kind: "generic", icon: "mdi:flash-outline" },
            action: block.action === null || isEntityInverterAction(block.action) ? null : block.action,
            localize: this.localize,
        });
    }

    private _formatRange(block: EntityScheduleBlock): string {
        const format = (atMs: number): string => formatScheduleTime(atMs, this.locale, this.timeZone);
        return `${format(block.startMs)}–${format(block.endMs)}`;
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

    private _emitBlockSelect(block: EntityScheduleBlock): void {
        if (block.isPast) {
            return;
        }

        this.dispatchEvent(new CustomEvent<EntityDayBandBlockSelectDetail>("entity-day-band-block-select", {
            bubbles: true,
            composed: true,
            detail: { blockKey: block.key },
        }));
    }

    private _emitBlockHover(blockKey: string | null): void {
        this.dispatchEvent(new CustomEvent<EntityDayBandBlockHoverDetail>("entity-day-band-block-hover", {
            bubbles: true,
            composed: true,
            detail: { blockKey },
        }));
    }

    private _emitGapSelect(startMs: number): void {
        this.dispatchEvent(new CustomEvent<EntityDayBandGapSelectDetail>("entity-day-band-gap-select", {
            bubbles: true,
            composed: true,
            detail: { startMs },
        }));
    }
}
