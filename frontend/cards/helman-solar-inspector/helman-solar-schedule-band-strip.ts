import { LitElement, css, html, type PropertyValues } from "lit-element";
import { resolveLocale } from "../shared/resolve-locale";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../types/ha";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import "../shared/schedule/components/scheduling-entity-day-band";
import {
    SCHEDULE_DAY_MODEL_CHANGED_EVENT,
    type SchedulingDayEditorHost,
} from "../shared/schedule/dialogs/scheduling-day-editor-host";
import type {
    EntityDayBandBlockSelectDetail,
    EntityDayBandGridTick,
    EntityDayBandHighlight,
    EntityDayBandLaneSelectDetail,
    EntityDayBandPointerMoveDetail,
    EntityDayBandTimeHoverDetail,
} from "../shared/schedule/components/scheduling-entity-day-band";
import type { EntityScheduleDay } from "../shared/schedule/model/entity-day-schedule-model";
import {
    buildEntityDayBandLanes,
    formatLaneRunRange,
    resolveLaneRunPresentation,
    type EntityDayBandLane,
} from "../shared/schedule/model/entity-lane-source";
import { formatScheduleTime } from "../shared/schedule/model/schedule-time";
import {
    EMPTY_SELECTED_MINUTES,
    minutesOfDayOrNull,
    stripWindow,
    windowGridTicks,
    type ScheduleStripGeometry,
} from "./strip-geometry";
import { SLOT_MINUTES } from "./chart-stack";
import { overhangSide } from "./pan-window";
import { addDays } from "../shared/time/day-key";
import { helmanColorVars } from "../color-vars";

/** One lane's action at the hovered moment, for the fast hover popup. */
export interface ScheduleHoverTooltipRow {
    label: string;
    value: string;
    toneClass: string;
}

/** The popup content emitted for the inspector's shared floating tooltip to render. */
export interface ScheduleHoverTooltipContent {
    x: number;
    y: number;
    title: string;
    rows: ScheduleHoverTooltipRow[];
}

const MINUTES_PER_DAY = 1440;
const MINUTE_MS = 60_000;
/** Slim: the strip sits between charts, where a row is a glance and not a grip. */
const TRACK_HEIGHT_PX = 16;

/**
 * The house's schedule as a stack of per-entity timelines, on the solar
 * inspector's own time axis.
 *
 * The same band the day editor is built around, read-only and
 * cropped to whatever window the charts above are drawing. That is the point of
 * putting it here: a run is only interesting next to the solar it was placed to
 * catch, and two surfaces drawing the same day two different ways would be two
 * things to learn instead of one.
 *
 * Only lanes with something on them get a row. The inspector has charts to fit
 * between, and an entity that did nothing today and has nothing planned has
 * nothing to say about the day being inspected -- it is still one click away in
 * the editor, which lists every lane precisely because that is where entities
 * get scheduled.
 *
 * The day itself -- the schedule, the rosters, the recorder's morning, the
 * clock -- and the editor a press opens belong to `scheduling-day-editor-host`,
 * which the card above owns and hands down. This element is the drawing: the
 * geometry, the highlights, the hover, and the band.
 *
 * A window a drag carried past either midnight draws the neighbouring day's
 * runs into that overhang. Unlike the charts, which stack a second instance
 * for the neighbour, the band is one: its lanes are keyed by entity rather
 * than by slot of a day, and it already draws a span across midnights -- so
 * the span is widened to take the neighbour in, and its lanes stay one row
 * per entity across the seam.
 */
@customElement("helman-solar-schedule-band-strip")
export class HelmanSolarScheduleBandStrip extends LitElement {
    static styles = [helmanColorVars, css`
        :host {
            display: block;
            width: 100%;
        }

        /* The tracks are inset to the chart's plot area, so an hour here is the
           same column of pixels as that hour on every chart above; the wrap
           itself keeps the card's full width, which is where the names start. */
        .band-wrap {
            --entity-day-band-track-height: ${TRACK_HEIGHT_PX}px;
        }
    `];

    @property({ attribute: false }) public hass?: HomeAssistant;
    /** Selected inspector day, `YYYY-MM-DD`. */
    @property({ type: String }) public date = "";
    @property({ type: String }) public timeZone = "UTC";
    @property({ attribute: false }) public geometry: ScheduleStripGeometry | null = null;
    /** Inspector slot width, in minutes; how wide a highlighted slot reads. */
    @property({ attribute: false }) public slotMinutes = SLOT_MINUTES;
    /** Minute-of-day of every slot in the inspector's selection. */
    @property({ attribute: false }) public selectedMinutes: readonly number[] = EMPTY_SELECTED_MINUTES;
    /** Minute-of-day under the pointer, wherever in the inspector it is. */
    @property({ attribute: false }) public hoverMinutes: number | null = null;
    /**
     * The day editor's host, owned by the card above.
     *
     * The strip draws the day; the host owns it — the schedule, the rosters, the
     * recorder's morning and the clock, plus the dialog itself. Passed in rather
     * than created here so pressing a lane and pressing a badge elsewhere on the
     * page land in one dialog looking at one day.
     */
    @property({ attribute: false }) public editorHost: SchedulingDayEditorHost | null = null;

    private _localizeFn?: LocalizeFunction;
    /**
     * The lanes drawn, and what they were built from.
     *
     * Lanes are a function of the host's day alone -- its roster, its schedule
     * and its coarse clock. The pointer is not one of those inputs, so a sweep
     * across the band re-renders it without rebuilding a lane; and the band
     * below compares `.lanes` by identity, so keeping the array as well as its
     * contents is what stops that re-derivation propagating into it.
     */
    private _bandLanes: EntityDayBandLane[] = [];
    private _bandLanesFor: {
        host: SchedulingDayEditorHost | null;
        lanes: unknown;
        slots: unknown;
        span: EntityScheduleDay | null;
        clockSlotMs: number;
        projectionIndex: unknown;
    } | null = null;
    /** The grid the lanes are ruled by, one array per window it is drawn in. */
    private _gridTicks: EntityDayBandGridTick[] = [];
    private _gridTicksFor: {
        dayStartMs: number;
        startMinutes: number;
        endMinutes: number;
        slotMinutes: number;
        plotWidth: number;
    } | null = null;
    private _observedHost: SchedulingDayEditorHost | null = null;

    protected willUpdate(changed: PropertyValues<this>): void {
        if (changed.has("hass") && this.hass) {
            this._localizeFn = getLocalizeFunction(this.hass);
        }
        if (changed.has("editorHost")) {
            this._observeHost();
        }
        this._rebuildBandLanesIfNeeded();
        this._rebuildGridTicksIfNeeded();
    }

    /**
     * The host's day as lanes, once per change of the day itself.
     *
     * Keyed on the host's own inputs rather than on this element's properties:
     * the day model is read through plain getters and changes behind a
     * `SCHEDULE_DAY_MODEL_CHANGED_EVENT`, so the key names the four things the
     * builder actually reads and the event only has to bring us here.
     */
    private _rebuildBandLanesIfNeeded(): void {
        const host = this.editorHost;
        const span = this._spanDay();
        const previous = this._bandLanesFor;
        if (
            previous !== null
            && previous.host === host
            && previous.lanes === host?.lanes
            && previous.slots === host?.dayView.slots
            && previous.span === span
            // The host's clock snapped to the schedule's grid, not its raw
            // `nowMs`: every lane the builder cuts is bounded by slot edges, so
            // the geometry cannot move between two of them and keying on the
            // 30 s marker clock rebuilt every lane on the page twice a minute.
            && previous.clockSlotMs === (host?.clockSlotMs ?? 0)
            && previous.projectionIndex === host?.projectionIndex
        ) {
            return;
        }
        this._bandLanesFor = {
            host,
            lanes: host?.lanes,
            slots: host?.dayView.slots,
            span,
            clockSlotMs: host?.clockSlotMs ?? 0,
            projectionIndex: host?.projectionIndex,
        };
        this._bandLanes = host === null || span === null ? [] : this._buildBandLanes(host, span);
    }

    /**
     * The visible days the schedule reaches, as one span: the selected day,
     * widened over the neighbour the window reaches into.
     *
     * The schedule only ever reaches today and the horizon ahead: the backend
     * prunes what has gone, and the recorder read behind the band is today's.
     * Either visible day having a schedule day is enough -- the other draws
     * empty -- so dragging yesterday into the majority keeps today's runs in
     * the overhang. With neither, there is nothing to draw, and the strip
     * renders nothing rather than a row of empty tracks that would read as
     * "nothing was scheduled".
     *
     * Kept as one object for as long as the days it joins are, because the
     * band compares `.day` by identity and the lanes are rebuilt off it.
     */
    private _span: EntityScheduleDay | null = null;
    /** The selected day's midnight, which the strip's minutes count from. */
    private _originMs = 0;
    private _spanFor: { day: EntityScheduleDay | undefined; neighbour: EntityScheduleDay | undefined } | null = null;

    private _spanDay(): EntityScheduleDay | null {
        if (this.geometry === null) {
            return null;
        }
        const { start, end } = stripWindow(this.geometry);
        const side = overhangSide({ startMinutes: start, endMinutes: end });
        const days = this.editorHost?.days ?? [];
        const day = days.find((candidate) => candidate.dayKey === this.date);
        const neighbourKey = side === 0 ? null : addDays(this.date, side);
        const neighbour = days.find((candidate) => candidate.dayKey === neighbourKey);
        if (day === undefined && neighbour === undefined) {
            return null;
        }
        if (this._spanFor === null || this._spanFor.day !== day || this._spanFor.neighbour !== neighbour) {
            this._spanFor = { day, neighbour };
            // A day counts as 1440 minutes across the inspector, so the
            // selected day's midnight follows from its neighbour's.
            this._originMs = day?.startMs ?? neighbour!.startMs - side * MINUTES_PER_DAY * MINUTE_MS;
            if (neighbour === undefined) {
                this._span = day!;
            } else if (day === undefined) {
                // The selected day's part draws empty, and the neighbour's own
                // boundary is where now falls: today's is now, a day ahead's
                // its first slot, so a past selected day washes up to it.
                this._span = {
                    ...neighbour,
                    startMs: Math.min(this._originMs, neighbour.startMs),
                    endMs: Math.max(this._originMs + MINUTES_PER_DAY * MINUTE_MS, neighbour.endMs),
                };
            } else {
                const [first, last] = side < 0 ? [neighbour, day] : [day, neighbour];
                this._span = {
                    ...day,
                    startMs: first.startMs,
                    endMs: last.endMs,
                    // The earlier of the two days' own: a day ahead reports its
                    // first slot and one gone by reports now, so the earlier is
                    // where now falls -- the selected day's alone would wash a
                    // future overhang as past.
                    editableFromMs: Math.min(first.editableFromMs, last.editableFromMs),
                    slots: [...first.slots, ...last.slots],
                };
            }
        }
        return this._span;
    }

    private _buildBandLanes(host: SchedulingDayEditorHost, day: EntityScheduleDay): EntityDayBandLane[] {
        return buildEntityDayBandLanes({
            lanes: host.lanes,
            slots: host.dayView.slots,
            day,
            nowMs: host.nowMs,
            activeOnly: true,
            projectionIndex: host.projectionIndex,
        });
    }

    connectedCallback(): void {
        super.connectedCallback();
        this._observeHost();
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this._emitHover(null);
        this._observedHost?.removeEventListener(
            SCHEDULE_DAY_MODEL_CHANGED_EVENT,
            this._handleHostModelChanged,
        );
        this._observedHost = null;
    }

    /**
     * Re-render when the host's day moves.
     *
     * Everything the band draws is read off the host through plain getters, and
     * a getter is not a reactive property: without this the strip would keep
     * drawing the day it last derived while the schedule, the roster or the
     * clock moved on underneath it.
     */
    private _observeHost(): void {
        const host = this.editorHost;
        if (this._observedHost === host) {
            return;
        }

        this._observedHost?.removeEventListener(
            SCHEDULE_DAY_MODEL_CHANGED_EVENT,
            this._handleHostModelChanged,
        );
        this._observedHost = host;
        host?.addEventListener(SCHEDULE_DAY_MODEL_CHANGED_EVENT, this._handleHostModelChanged);
        this.requestUpdate();
    }

    private _handleHostModelChanged = (): void => {
        this.requestUpdate();
    };

    render() {
        if (!this.hass || this.geometry === null) {
            return nothing;
        }

        const span = this._spanDay();
        if (span === null) {
            return nothing;
        }

        // Built in `willUpdate`; nothing is derived here.
        const lanes = this._bandLanes;
        if (lanes.length === 0) {
            return nothing;
        }

        const { start, end } = stripWindow(this.geometry);
        // The wrap spans the card, and only the tracks are inset to the plot
        // area -- so the lane names get the axis gutter to start in instead of
        // eating into the day on a narrow screen.
        const startInsetPct = (this.geometry.marginLeft / this.geometry.width) * 100;
        const endInsetPct = Math.max(
            0,
            100 - startInsetPct - (this.geometry.plotWidth / this.geometry.width) * 100,
        );
        return html`
            <div
                class="band-wrap"
                style=${`--entity-day-band-track-inset-start:${startInsetPct}%;--entity-day-band-track-inset-end:${endInsetPct}%;`}
            >
                <scheduling-entity-day-band
                    .hass=${this.hass}
                    .localize=${this._localize}
                    .day=${span}
                    .lanes=${lanes}
                    .nowMs=${this._nowMs}
                    .locale=${this._locale}
                    .timeZone=${this.timeZone}
                    .windowStartMs=${this._originMs + start * MINUTE_MS}
                    .windowEndMs=${this._originMs + end * MINUTE_MS}
                    .highlightRanges=${this._buildHighlights(this._originMs)}
                    .timeGridTicks=${this._gridTicks}
                    .readonly=${true}
                    .showForecastRows=${false}
                    .showAxis=${false}
                    @entity-day-band-lane-select=${this._handleLaneSelect}
                    @entity-day-band-block-select=${this._handleBlockSelect}
                    @entity-day-band-time-hover=${this._handleTimeHover}
                    @entity-day-band-pointer-move=${this._handlePointerMove}
                ></scheduling-entity-day-band>
            </div>
        `;
    }

    /**
     * The inspector's time grid, handed down as instants.
     *
     * Computed from the same geometry and slot size the charts above use, so
     * the lanes are ruled by the very lines the chart is: the band is a row of
     * the inspector, not a diagram that happens to sit under one. Built in
     * `willUpdate` behind its own key, because the band compares the array by
     * identity and the pointer is not one of its inputs.
     */
    private _rebuildGridTicksIfNeeded(): void {
        const geometry = this.geometry;
        if (this._spanDay() === null || geometry === null) {
            this._gridTicks = [];
            this._gridTicksFor = null;
            return;
        }
        const { start, end } = stripWindow(geometry);
        const previous = this._gridTicksFor;
        if (
            previous !== null
            && previous.dayStartMs === this._originMs
            && previous.startMinutes === start
            && previous.endMinutes === end
            && previous.slotMinutes === this.slotMinutes
            && previous.plotWidth === geometry.plotWidth
        ) {
            return;
        }
        this._gridTicksFor = {
            dayStartMs: this._originMs,
            startMinutes: start,
            endMinutes: end,
            slotMinutes: this.slotMinutes,
            plotWidth: geometry.plotWidth,
        };
        this._gridTicks = windowGridTicks(start, end, this.slotMinutes, geometry.plotWidth).map((tick) => ({
            atMs: this._originMs + tick.minutes * MINUTE_MS,
            major: tick.hour !== null,
            ...(tick.midnight ? { midnight: true } : {}),
        }));
    }

    /**
     * The inspector's selected and hovered slots, as stretches of the day.
     *
     * The band knows nothing about minutes-of-day or about what the inspector
     * counts as selected; it is handed the times and the reason, which is what
     * keeps the same marks usable by any other host.
     */
    private _buildHighlights(dayStartMs: number): EntityDayBandHighlight[] {
        const toRange = (minutes: number, kind: "selected" | "hover"): EntityDayBandHighlight => {
            // Snap to the inspector's own slot grid, so the mark covers the slot
            // the pointer is in rather than a slot's width starting under it.
            const startMinutes = Math.floor(minutes / this.slotMinutes) * this.slotMinutes;
            return {
                startMs: dayStartMs + startMinutes * MINUTE_MS,
                endMs: dayStartMs + Math.min(startMinutes + this.slotMinutes, MINUTES_PER_DAY) * MINUTE_MS,
                kind,
            };
        };

        const highlights = this.selectedMinutes.map((minutes) => toRange(minutes, "selected"));
        return this.hoverMinutes === null
            ? highlights
            : [...highlights, toRange(this.hoverMinutes, "hover")];
    }

    /**
     * The host's coarse clock, so the band, the highlights and the dialog all
     * read the same "now" and move in one step.
     */
    private get _nowMs(): number {
        return this.editorHost?.nowMs ?? Date.now();
    }

    private _handleLaneSelect = (event: CustomEvent<EntityDayBandLaneSelectDetail>): void => {
        event.stopPropagation();
        this._openEditor(event.detail.laneKey);
    };

    private _handleBlockSelect = (event: CustomEvent<EntityDayBandBlockSelectDetail>): void => {
        event.stopPropagation();
        this._openEditor(event.detail.laneKey);
    };

    private _openEditor(laneKey: string): void {
        const host = this.editorHost;
        const lane = host?.lanes.find((candidate) => candidate.key === laneKey);
        if (host === null || host === undefined || lane === undefined) {
            return;
        }

        host.openFor(lane.target);
    }

    private _handleTimeHover = (event: CustomEvent<EntityDayBandTimeHoverDetail>): void => {
        event.stopPropagation();
        const minutes = this._minutesOfDay(event.detail.atMs);
        this._emitHover(minutes);
        if (minutes === null) {
            this._emitTooltip(null);
        }
    };

    /**
     * An instant as a minute of the selected day, or null -- off the band, and
     * over a neighbouring day a drag brought into view, whose slots are not
     * this day's to hover.
     */
    private _minutesOfDay(atMs: number | null): number | null {
        return atMs === null || this._spanDay() === null
            ? null
            : minutesOfDayOrNull((atMs - this._originMs) / MINUTE_MS);
    }

    /**
     * Every lane with something active at the hovered moment, in one fast
     * popup -- the native per-block `title` a lane's own segment carries is
     * still there underneath, but reading eight of them one at a time is not
     * how "what does the house look like at 14:00" gets answered.
     */
    private _handlePointerMove = (event: CustomEvent<EntityDayBandPointerMoveDetail>): void => {
        event.stopPropagation();
        const { atMs, clientX, clientY } = event.detail;
        if (atMs === null || this._minutesOfDay(atMs) === null) {
            this._emitTooltip(null);
            return;
        }
        const rows: ScheduleHoverTooltipRow[] = [];
        for (const lane of this._bandLanes) {
            const run =
                lane.actualSegments.find((segment) => atMs >= segment.startMs && atMs < segment.endMs)
                ?? lane.blocks.find((block) => atMs >= block.startMs && atMs < block.endMs);
            if (run === undefined) continue;
            const presentation = resolveLaneRunPresentation(lane, run, this._localize);
            // An actual segment's real running time can be shorter than its
            // slot, the same distinction the segment's own native title draws.
            const totalMs = "activeMs" in run ? run.activeMs : undefined;
            const range = formatLaneRunRange(run, this._locale, this.timeZone, totalMs);
            rows.push({
                label: lane.name,
                value: `${presentation.label} · ${range}`,
                toneClass: presentation.toneClass,
            });
        }
        if (rows.length === 0) {
            this._emitTooltip(null);
            return;
        }
        this._emitTooltip({
            x: clientX,
            y: clientY,
            title: formatScheduleTime(atMs, this._locale, this.timeZone),
            rows,
        });
    };

    private _emitTooltip(content: ScheduleHoverTooltipContent | null): void {
        this.dispatchEvent(new CustomEvent<ScheduleHoverTooltipContent | null>("slot-tooltip", {
            detail: content,
            bubbles: true,
            composed: true,
        }));
    }

    private _emitHover(minutes: number | null): void {
        this.dispatchEvent(new CustomEvent<{ minutes: number | null }>("slot-hover", {
            detail: { minutes },
            bubbles: true,
            composed: true,
        }));
    }

    private get _localize(): LocalizeFunction {
        return this._localizeFn ?? ((key: string) => key);
    }

    private get _locale(): string {
        return resolveLocale(this.hass);
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-solar-schedule-band-strip": HelmanSolarScheduleBandStrip;
    }
}
