import { LitElement, css, html, type PropertyValues } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../hass-frontend/src/types";
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
import { stripWindow, type ScheduleStripGeometry } from "./strip-geometry";
import { slotGridTicks } from "../shared/slot-gridlines";
import { SLOT_MINUTES } from "./chart-stack";
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
    @property({ attribute: false }) public selectedMinutes: number[] = [];
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
    /** The lanes actually drawn on the last render, for the hover popup to read. */
    private _lastBandLanes: EntityDayBandLane[] = [];
    private _observedHost: SchedulingDayEditorHost | null = null;

    protected willUpdate(changed: PropertyValues<this>): void {
        if (changed.has("hass") && this.hass) {
            this._localizeFn = getLocalizeFunction(this.hass);
        }
        if (changed.has("editorHost")) {
            this._observeHost();
        }
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

        const day = this._selectedDay();
        if (day === null) {
            return nothing;
        }

        const lanes = this._buildBandLanes(day);
        if (lanes.length === 0) {
            return nothing;
        }
        this._lastBandLanes = lanes;

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
                    .day=${day}
                    .lanes=${lanes}
                    .nowMs=${this._nowMs}
                    .locale=${this._locale}
                    .timeZone=${this.timeZone}
                    .windowStartMs=${day.startMs + start * MINUTE_MS}
                    .windowEndMs=${day.startMs + end * MINUTE_MS}
                    .highlightRanges=${this._buildHighlights(day)}
                    .timeGridTicks=${this._buildGridTicks(day, start, end)}
                    .laneLabels=${"track"}
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
     * the inspector, not a diagram that happens to sit under one.
     */
    private _buildGridTicks(
        day: EntityScheduleDay,
        startMinutes: number,
        endMinutes: number,
    ): EntityDayBandGridTick[] {
        const plotWidth = this.geometry?.plotWidth ?? 0;
        return slotGridTicks({ startMinutes, endMinutes, slotMinutes: this.slotMinutes, plotWidth })
            .map((tick) => ({
                atMs: day.startMs + tick.minutes * MINUTE_MS,
                major: tick.hour !== null,
            }));
    }

    /**
     * The inspector's selected and hovered slots, as stretches of the day.
     *
     * The band knows nothing about minutes-of-day or about what the inspector
     * counts as selected; it is handed the times and the reason, which is what
     * keeps the same marks usable by any other host.
     */
    private _buildHighlights(day: EntityScheduleDay): EntityDayBandHighlight[] {
        const toRange = (minutes: number, kind: "selected" | "hover"): EntityDayBandHighlight => {
            // Snap to the inspector's own slot grid, so the mark covers the slot
            // the pointer is in rather than a slot's width starting under it.
            const startMinutes = Math.floor(minutes / this.slotMinutes) * this.slotMinutes;
            return {
                startMs: day.startMs + startMinutes * MINUTE_MS,
                endMs: day.startMs + Math.min(startMinutes + this.slotMinutes, MINUTES_PER_DAY) * MINUTE_MS,
                kind,
            };
        };

        const highlights = this.selectedMinutes.map((minutes) => toRange(minutes, "selected"));
        return this.hoverMinutes === null
            ? highlights
            : [...highlights, toRange(this.hoverMinutes, "hover")];
    }

    /**
     * The day the inspector is showing, if the schedule reaches it.
     *
     * It only ever reaches today and the horizon ahead: the backend prunes what
     * has gone, and the recorder read behind the band is today's. On any other
     * day there is nothing to draw, and the strip renders nothing rather than a
     * row of empty tracks that would read as "nothing was scheduled".
     */
    private _selectedDay(): EntityScheduleDay | null {
        return this.editorHost?.days.find((day) => day.dayKey === this.date) ?? null;
    }

    private _buildBandLanes(day: EntityScheduleDay): EntityDayBandLane[] {
        const host = this.editorHost;
        if (host === null) {
            return [];
        }

        return buildEntityDayBandLanes({
            lanes: host.lanes,
            slots: host.dayView.slots,
            day,
            nowMs: host.nowMs,
            activeOnly: true,
            projectionIndex: host.projectionIndex,
        });
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

        host.openFor(lane.target, this.date);
    }

    private _handleTimeHover = (event: CustomEvent<EntityDayBandTimeHoverDetail>): void => {
        event.stopPropagation();
        const day = this._selectedDay();
        const atMs = event.detail.atMs;
        this._emitHover(
            atMs === null || day === null ? null : (atMs - day.startMs) / MINUTE_MS,
        );
        if (atMs === null) {
            this._emitTooltip(null);
        }
    };

    /**
     * Every lane with something active at the hovered moment, in one fast
     * popup -- the native per-block `title` a lane's own segment carries is
     * still there underneath, but reading eight of them one at a time is not
     * how "what does the house look like at 14:00" gets answered.
     */
    private _handlePointerMove = (event: CustomEvent<EntityDayBandPointerMoveDetail>): void => {
        event.stopPropagation();
        const { atMs, clientX, clientY } = event.detail;
        if (atMs === null) {
            this._emitTooltip(null);
            return;
        }
        const rows: ScheduleHoverTooltipRow[] = [];
        for (const lane of this._lastBandLanes) {
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
        if (this.hass?.locale?.language) {
            return this.hass.locale.language;
        }

        return typeof navigator !== "undefined" ? navigator.language : "cs";
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-solar-schedule-band-strip": HelmanSolarScheduleBandStrip;
    }
}
