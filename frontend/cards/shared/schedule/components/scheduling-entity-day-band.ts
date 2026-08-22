import { LitElement, css, html, type PropertyValues } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../../../hass-frontend/src/types";
import { helmanColorVars } from "../../../color-vars";
import {
    resolveSocDirection,
    socColumnBackground,
    type SocDirection,
} from "../../../shared/soc-columns";
import type { LocalizeFunction } from "../../../localize/localize";
import type {
    EntityActualSegment,
    EntityScheduleAction,
    EntityScheduleBlock,
    EntityScheduleDay,
} from "../model/entity-day-schedule-model";
import {
    formatLaneRunRange,
    resolveLaneRunPresentation,
    type EntityDayBandLane,
} from "../model/entity-lane-source";
import type { ScheduleApplianceProjectionBadge } from "../model/schedule-appliance-projection";
import { getScheduleApplianceProjectionBadgeLabel } from "../model/schedule-appliance-projection-presentation";
import {
    areEntityScheduleActionsEqual,
    resolveEntityScheduleRangeLimits,
} from "../model/entity-day-schedule-model";
import { formatScheduleTime } from "../model/schedule-time";
import type { SlotForecastPoint } from "../model/slot-forecast-model";
import { schedulingSharedStyles } from "../styles/scheduling-shared-styles";
import { SLOT_GRID_LINE_OPACITY, slotGridTicks, type SlotGridTick } from "../../slot-gridlines";
import "../../optimizer/helman-optimizer-edit-dialog";
import {
    getLaneAutomationCoverage,
    getSharedAutomationCoverage,
    type AutomationCoverageIndex,
} from "../../optimizer/automation-coverage";
import type { HomeAssistantLike } from "../../config/types";

const MINUTE_MS = 60_000;
/** An hour label this close to an edge is pulled inside it rather than centred. */
const AXIS_EDGE_PERCENT = 0.5;
/** Half the room the drag readout needs, so it can be kept inside the track. */
const DRAG_READOUT_HALF_WIDTH_PX = 58;
/** A bar this short still has to be visible, or a small value reads as none. */
const MIN_BAR_PCT = 8;
/** Segments narrower than this are move-only: two edge handles would not fit. */
const MIN_RESIZABLE_WIDTH_PX = 34;
/** Wide enough for the projected energy to carry its unit as well as its value. */
const MIN_UNIT_LABEL_WIDTH_PX = 62;
/** Below this a run is icon-only: a clipped number is worse than no number. */
const MIN_FIGURE_WIDTH_PX = 38;
/** A charging run this wide can say where it leaves the vehicle. */
const MIN_SOC_END_WIDTH_PX = 44;
/** And this wide, where it found it as well. */
const MIN_SOC_BOTH_WIDTH_PX = 96;
/** Room the two levels take at a run's edges, which the centre figure gives up. */
const SOC_ENDPOINT_ALLOWANCE_PX = 52;
/**
 * A forecast slot narrower than this keeps its number to its tooltip.
 *
 * Half a day of slots on a phone leaves single digits of room each, and a
 * clipped "12" that reads as "1" is worse than a column with nothing written on
 * it -- the hovered slot gets its number back regardless, which is the case
 * where the user is actually asking.
 */
const MIN_SLOT_VALUE_WIDTH_PX = 17;

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

/** Which slot of which lane was pressed, on a band drawing the slot grid. */
export interface EntityDayBandSlotSelectDetail {
    laneKey: string;
    slotId: string;
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

/** One line of a host-supplied time grid; `major` lines are the labelled ones. */
export interface EntityDayBandGridTick {
    atMs: number;
    major: boolean;
}

export interface EntityDayBandTimeHoverDetail {
    /** Where the pointer is on the time axis, or null when it has left. */
    atMs: number | null;
}

/**
 * Every genuine pointer move over the band, with its viewport position --
 * unlike `entity-day-band-time-hover`, which a host uses to move a shared
 * highlight and so only fires when the time itself changes, a host drawing
 * something that follows the cursor (a popup) needs every move, even a purely
 * vertical one where the time under the pointer stayed the same.
 */
export interface EntityDayBandPointerMoveDetail {
    atMs: number | null;
    clientX: number;
    clientY: number;
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

            /* A host aligning the tracks to its own chart inset them to that
               chart's plot area, leaving the axis gutters bare on both sides.
               The tracks take the insets; the lane does not, so the name inside
               it can start at the host's own left edge -- a name is not a time,
               and on a narrow screen the gutter is the only room it has. */
            .band.labels-in-track .track,
            .band.labels-in-track .context-row {
                margin-left: var(--entity-day-band-track-inset-start, 0px);
                margin-right: var(--entity-day-band-track-inset-end, 0px);
            }

            .band.labels-in-track .lane {
                display: block;
                position: relative;
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

            /* The name and the "why" button are two intents, so they are two
               controls -- a button inside a button is not a thing, and
               overloading the name's click would make "which entity" and "why
               this plan" the same press. */
            .lane-label {
                display: flex;
                align-items: center;
                gap: 5px;
                flex: 1 1 auto;
                min-width: 0;
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

            /* The icon and the coverage badge sit beside the name button,
               not inside it, so the sizing hangs off the row rather than off
               the button it used to live in. */
            /* A direct child: the coverage badge beside it carries an icon
               element of its own, and a descendant selector would set this
               size on that one too, over the size the badge sets on itself. */
            .lane-label-row > ha-icon {
                flex: 0 0 auto;
                --mdc-icon-size: 15px;
                cursor: pointer;
            }

            /* The live badge stands in for that icon, so it has to be boxed to
               the same size -- left to itself it sizes for an entity row and
               would set the lane's height. */
            .lane-label-row state-badge,
            .track-label state-badge {
                flex: 0 0 auto;
                width: 18px;
                height: 18px;
                line-height: 18px;
                cursor: pointer;
            }

            .lane-label-row state-badge {
                --mdc-icon-size: 15px;
            }

            .lane.unavailable state-badge {
                opacity: 0.6;
            }

            /* Whether a lane is on autopilot, next to the icon that says which
               lane it is. Boxed to the entity icon's size for the same reason
               the live badge is: a lane's height is set by its label row.

               The palette is the authorship palette the action chips already
               use, because it is the same distinction -- automation against the
               user's own hand -- and two colour vocabularies for one question
               would be one to unlearn. */
            .automation-badge {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                flex: 0 0 auto;
                width: 18px;
                height: 18px;
                padding: 0;
                border: none;
                border-radius: 4px;
                background: none;
                color: var(--automation-badge-color);
                --mdc-icon-size: 14px;
            }

            .automation-badge.active {
                --automation-badge-color: var(--schedule-authorship-automation-color, #2563eb);
            }

            .automation-badge.disabled_only {
                --automation-badge-color: var(--schedule-authorship-mixed-color, #ea7a18);
            }

            .automation-badge.none {
                --automation-badge-color: var(--schedule-authorship-user-color, #c49012);
            }

            /* Only the pressable one takes the pointer: on a manual lane the
               badge says something and does nothing, and the run underneath
               must stay what a press in the track finds. */
            button.automation-badge {
                cursor: pointer;
                pointer-events: auto;
            }

            button.automation-badge:hover {
                background: color-mix(in srgb, var(--automation-badge-color) 18%, transparent);
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

            /* Tall enough for a row of numbers above the bars: the columns are
               read for what they say as often as for their shape, and a value
               nobody can read is a tooltip nobody hovers. */
            .context-row {
                position: relative;
                height: 30px;
                border-radius: 4px;
                background: var(--secondary-background-color);
                overflow: hidden;
                cursor: default;
            }

            /* Price gets more room: it is drawn around a zero line, so each
               half only has half the height to work with -- and both halves
               carry numbers, at the top and at the bottom. */
            .context-row.price {
                height: 38px;
            }

            /* The bars live below the strip the numbers take, rather than under
               it: a column scaled to the whole row would grow up through its own
               label, and a number written over a solid bar is a number read
               twice as slowly as one written on the row's own background. */
            .context-row .plot {
                position: absolute;
                left: 0;
                right: 0;
                top: 11px;
                bottom: 0;
            }

            .context-bar {
                position: absolute;
            }

            /* One slot's reading, over the slot it belongs to. Centred on the
               column and clipped to it, so a number never claims a neighbour's
               minutes. Inert: the hit layer above it is what answers the
               pointer, and the whole strip is a readout. */
            .slot-value {
                position: absolute;
                top: 0;
                height: 11px;
                display: flex;
                align-items: center;
                justify-content: center;
                overflow: hidden;
                color: var(--secondary-text-color);
                font-size: 8.5px;
                line-height: 11px;
                font-variant-numeric: tabular-nums;
                white-space: nowrap;
                pointer-events: none;
            }

            /* The slot being asked about says its number in the row's own ink,
               which is also what makes a number that did not fit legible when it
               is drawn anyway. */
            .slot-value.hovered {
                z-index: 2;
                overflow: visible;
                color: var(--primary-text-color);
                font-weight: 600;
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

            /* One slot of the chart, as a target and nothing else: the hairlines
               that tie a column to the run under it are the time grid, drawn on
               this row and on every other by the same ticks. */
            .slot-hit {
                position: absolute;
                top: 0;
                bottom: 0;
                z-index: 1;
            }

            /* Same wash as the lanes give the slot under the pointer: one slice
               of time lights up everywhere it is drawn, which is the whole
               reason the rows share an axis. */
            .slot-hit.co-hovered {
                background: color-mix(in srgb, var(--primary-color) 12%, transparent);
            }

            .slot-hit.hovered {
                background: color-mix(in srgb, var(--primary-color) 22%, transparent);
            }

            /* One slot of the day, as a target. The hairline that says where it
               begins belongs to the time grid, which rules every row alike;
               what is left here is the hit area and the marks on it. Over the
               runs, because where the slot is what a press means, the run is
               what is being asked about. */
            .slot-pick {
                position: absolute;
                top: 0;
                bottom: 0;
                /* Above the runs and the ramp, below the in-track lane name --
                   which is the one thing here that is still worth pressing for
                   its own sake. */
                z-index: 1;
                /* Held open for the selected slot, which does draw its own edge:
                   a border appearing only when a slot is picked would shift the
                   wash beside it by a pixel. */
                border-left: 1px solid transparent;
                /* Nothing to press while the band is being authored: the track
                   is a drag surface there, and a layer of targets over every run
                   would swallow the grabs the blocks are drawn to invite. */
                pointer-events: none;
            }

            .slot-pick.pickable {
                pointer-events: auto;
                cursor: pointer;
            }

            /* The slot under the pointer, and the same slot in every other lane.
               The row being pointed at is the darker of the two: the pointer is
               on one appliance's hour, and the rest are what that hour costs
               everywhere else. */
            .slot-pick.hovered {
                background: color-mix(in srgb, var(--primary-color) 22%, transparent);
            }

            .slot-pick.co-hovered {
                background: color-mix(in srgb, var(--primary-color) 12%, transparent);
            }

            /* The answered slot stays marked once the pointer has moved on --
               otherwise the diagram below is about a slot nothing points to. */
            .slot-pick.selected {
                background: color-mix(in srgb, var(--primary-color) 22%, transparent);
                border-left-color: var(--primary-color);
                box-shadow: inset -1px 0 0 0 var(--primary-color);
            }

            /* Columns stand on the floor of the row; their colour is set
               per column, from the shared SoC palette. */
            .context-bar.soc {
                bottom: 0;
            }

            /* The lane rows are laid out by the grid, so the row wrapper only
               exists to carry the selected/muted state down to both cells. */
            .lane {
                display: contents;
            }

            /* Slimmer where the host is stacking rows between charts, taller
               where the track is the control surface and has to be grabbable. */
            /* Framed with an outline rather than a border, because everything
               on the track is placed as a percentage of it: a border would take
               its pixel out of that span on each side, so a run -- and the now
               marker -- would drift from the same minute on a host's chart by
               up to a pixel and a half towards the end of the day. */
            .track {
                position: relative;
                height: var(--entity-day-band-track-height, 30px);
                outline: 1px solid var(--divider-color);
                outline-offset: -1px;
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
                max-width: calc(min(45%, 180px) + var(--entity-day-band-track-inset-start, 0px));
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

            /* The label itself takes no pointer events so the runs under it stay
               the thing being pointed at; the badge is the one exception, because
               it is a control of its own. */
            .track-label state-badge {
                --mdc-icon-size: 13px;
                pointer-events: auto;
            }

            .track-label .automation-badge {
                width: 16px;
                height: 16px;
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

            /* One line of the time grid, ruled across every row alike: the
               lanes, the forecast charts, and -- when a host is stacking the
               band under charts of its own -- those. The lines that carry an
               hour are drawn stronger, which is what keeps the coarse scale
               readable once there is a line every quarter hour; the weights
               come from the shared grid module, so a line means the same thing
               here as on the inspector's charts. */
            .time-grid-line {
                position: absolute;
                top: 0;
                bottom: 0;
                width: 0;
                border-left: 1px solid var(--divider-color);
                pointer-events: none;
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

            /* What the run still has left to draw, beside its own icon. It is
               dropped rather than shrunk when the run is too narrow to hold it
               -- the hover title carries the figure either way, and a clipped
               "1." is a worse answer than none. */
            .segment-figure {
                flex: 0 1 auto;
                margin-left: 3px;
                overflow: hidden;
                font-size: 0.62rem;
                font-variant-numeric: tabular-nums;
                line-height: 1;
                white-space: nowrap;
                opacity: 0.9;
            }

            /* The vehicle's projected charge, under everything the lane plans.
               Bottom-anchored columns rather than a line: the track is 16px in
               the inspector, and a 1px path across it is not a shape anybody
               can read. Inert -- the runs above it are what gets pointed at. */
            .soc-ramp {
                position: absolute;
                bottom: 0;
                z-index: 0;
                background: color-mix(in srgb, var(--helman-charge) 22%, transparent);
                pointer-events: none;
            }

            /* The levels either side of a charging run, on the run's own edges.
               Inert, so the run underneath is still what gets pressed. */
            .soc-endpoint {
                position: absolute;
                top: 50%;
                transform: translateY(-50%);
                font-size: 0.58rem;
                font-variant-numeric: tabular-nums;
                line-height: 1;
                white-space: nowrap;
                opacity: 0.85;
                pointer-events: none;
            }

            .soc-endpoint.start {
                left: 3px;
            }

            .soc-endpoint.end {
                right: 3px;
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

            /* What the drag is currently set to, over the edge being pulled.
               Above everything the track draws, including the block under it:
               it is the answer to the question the drag is asking, and it lasts
               only as long as the button is held. */
            .drag-readout {
                position: absolute;
                top: 50%;
                z-index: 4;
                display: flex;
                align-items: baseline;
                gap: 4px;
                padding: 1px 6px;
                border-radius: 5px;
                background: var(--card-background-color);
                box-shadow:
                    0 0 0 1px color-mix(in srgb, var(--primary-color) 45%, transparent),
                    0 2px 6px rgba(0, 0, 0, 0.28);
                color: var(--primary-text-color);
                font-size: 0.66rem;
                font-variant-numeric: tabular-nums;
                line-height: 1.35;
                white-space: nowrap;
                transform: translate(-50%, -50%);
                pointer-events: none;
            }

            /* The two times are what is being set; how long that leaves the run
               is a consequence, and reads as one. */
            .drag-readout-duration {
                color: var(--secondary-text-color);
                font-size: 0.6rem;
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

            /* Centred on the moment, not started at it: left alone put the
               whole 2px body to the right of the time it marks, which is a
               visible drift against a host's charts drawing the same minute. */
            .now-marker {
                position: absolute;
                top: -2px;
                bottom: -2px;
                width: 2px;
                transform: translateX(-50%);
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

            /* An hour sitting on an edge of the window is pulled inside it: a
               label centred on the day's first minute would hang half off the
               card, and one on its last would push the row wider than the
               tracks it belongs to. */
            .axis-tick.edge-start {
                transform: none;
            }

            .axis-tick.edge-end {
                transform: translateX(-100%);
            }
        `,
    ];

    /**
     * Only the lane labels need it: with `hass` the icon beside a lane's name is
     * that entity's live state badge instead of a flat glyph. Without it the
     * band still draws in full, on the static icon the lane carries.
     */
    @property({ attribute: false }) public hass?: HomeAssistant;
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
     * Draw the day's own slots on every lane and every forecast row.
     *
     * The unit the schedule stores, made visible: a hairline where a slot
     * begins, and the slot under the pointer washed everywhere it is drawn.
     * Reading a plan means asking what a run costs, and the answer is in a row
     * three tracks away -- so the whole stack lights the same slice of time,
     * which is the only reason it shares one axis.
     *
     * The lines come from `day.slots` rather than from a fixed half hour, and
     * thin out where a slot is too narrow to rule -- the same grid, and the same
     * rules for it, that the inspector's charts are drawn on. The cells stay one
     * per slot regardless: the slot ids are what an answer is keyed by, so a
     * cell that is not a slot is a cell nothing can be looked up for.
     */
    @property({ type: Boolean }) public slotGrid = false;
    /**
     * Let a press on the grid name the slot it landed on.
     *
     * Separate from drawing the grid, because a band being authored draws it
     * too: there the track is a drag surface, and a layer of slot targets over
     * every run would take the grabs the blocks exist to invite. A host asking
     * "why this slot" turns this on and gets the targets the runs cannot offer
     * -- the gap between two runs is not a time you can press, and a run spans
     * thirty of them.
     */
    @property({ type: Boolean }) public slotPicks = false;
    /**
     * The slot the host is showing an answer for, marked where it was pressed.
     *
     * A lane and a slot, unlike hover: hovering asks what the whole house is
     * doing at an hour, but the answer below is about one appliance at one
     * hour, and marking those minutes in every lane would say it was about all
     * of them.
     */
    @property({ attribute: false }) public selectedSlot: EntityDayBandSlotSelectDetail | null = null;
    /**
     * Stretches of the day to wash, whatever it is that makes them special.
     *
     * The band is told which times matter rather than working it out: what
     * counts as selected is the host's question, and the same mark serves a
     * chart's selected slot, a hovered hour, and -- eventually -- the block
     * under the pointer in the list beside it.
     */
    @property({ attribute: false }) public highlightRanges: readonly EntityDayBandHighlight[] = [];
    /**
     * The host's time grid, as instants to rule the tracks at.
     *
     * A host stacking the band under charts of its own passes its grid down,
     * because the grid belongs to whatever the band sits beneath: that host has
     * already chosen which lines carry an hour, and a band that picked its own
     * would rule the same day twice, differently. Empty is the standalone case,
     * where the band is that host and derives the very same ticks from
     * `day.slots` -- see `slotGrid`.
     */
    @property({ attribute: false }) public timeGridTicks: readonly EntityDayBandGridTick[] = [];

    @state() private _drag: DragSession | null = null;
    /**
     * The slot the pointer is over, taken from where it is on the time axis
     * rather than from what it is on top of.
     *
     * A slice of time, not a cell: the pointer is over one row, but the question
     * a hovered slot asks -- what else is happening then -- is answered by the
     * other rows, so all of them mark it.
     */
    @state() private _hoveredSlotId: string | null = null;
    /**
     * Which lane the pointer is actually in, when it is in one at all.
     *
     * The marked slot is the same everywhere; this is what makes one of them
     * the one being pointed at, and it is null over the forecast rows and over
     * the gaps between tracks.
     */
    @state() private _hoveredLaneKey: string | null = null;
    /**
     * Which lanes an automation drives, read from the config once per
     * connection.
     *
     * `null` until the first read lands, which the badge draws as nothing at
     * all: an unanswered question must not be shown as "no automation here".
     */
    @state() private _automationCoverage: AutomationCoverageIndex | null = null;
    /**
     * The automations a badge press asked to open, or null.
     *
     * The dialog is mounted from the band rather than from each host because
     * the badge is the band's control: the inspector's strip and the day
     * editor both draw this element, and a dialog per host would be the same
     * wiring written twice.
     */
    @state() private _automationEditIds: readonly string[] | null = null;
    /**
     * The track's width, measured after each update rather than while
     * rendering: reading it per segment forces a synchronous layout for every
     * block of every lane, and during a drag that happens at pointer rate.
     */
    @state() private _trackWidthPx = 0;
    /**
     * The day's own grid, and the grid every row is actually ruled by --
     * settled once at the head of each render and read from there by the rows,
     * the axis and the tracks.
     */
    private _ownTicks: readonly SlotGridTick[] = [];
    private _gridTicks: readonly EntityDayBandGridTick[] = [];

    private readonly _handlePointerMove = (event: PointerEvent): void => {
        const drag = this._drag;
        if (drag === null || event.pointerId !== drag.pointerId) {
            return;
        }

        event.preventDefault();
        const pointerMs = this._snapMs(this._readPointerMs(event, drag.trackRect));
        const range = this._resolveDragRange(drag, pointerMs);
        // Ranges are snapped to whole slots, so most pointer moves land where
        // the last one did. Announcing those rebuilds the draft for nothing --
        // and the readout says the same two times either way.
        if (range.startMs === this._dragRange?.startMs && range.endMs === this._dragRange.endMs) {
            return;
        }

        this._dragRange = range;
        this.dispatchEvent(new CustomEvent<EntityDayBandRangeChangeDetail>("entity-day-band-range-change", {
            bubbles: true,
            composed: true,
            detail: range,
        }));
    };

    /**
     * Where the drag has got to, held here rather than read back off the block.
     *
     * The block being dragged is redrawn from the draft the host rebuilds, which
     * is a round trip; the readout has to say what the pointer is doing now.
     * It doubles as the "did anything change" guard, so the two can never
     * disagree about which range is current.
     */
    @state() private _dragRange: EntityScheduleRange | null = null;
    /** The last hover announced, so a pointer crossing rows says it once. */
    private _lastHoverMs: number | null = null;

    private readonly _handlePointerUp = (event: PointerEvent): void => {
        if (this._drag !== null && event.pointerId !== this._drag.pointerId) {
            return;
        }

        this._endDrag();
    };

    /** The track currently under observation, kept for identity comparison. */
    private _observedTrack: Element | null = null;
    private _trackResizeObserver: ResizeObserver | null = null;

    /** Dropped on detach and re-taken on the next `hass`; see `_syncAutomationCoverage`. */
    private _unsubscribeAutomationCoverage: (() => void) | null = null;
    private _coverageHass: HomeAssistant | null = null;

    connectedCallback(): void {
        super.connectedCallback();
        // Re-attaching does not schedule an update, so the observer the
        // detach dropped has to be put back by hand.
        if (this.hasUpdated) {
            this._syncTrackResizeObserver();
        }
        this._syncAutomationCoverage();
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this._endDrag();
        this._disconnectTrackResizeObserver();
        this._unsubscribeAutomationCoverage?.();
        this._unsubscribeAutomationCoverage = null;
        this._coverageHass = null;
    }

    protected willUpdate(changed: PropertyValues<this>): void {
        if (changed.has("hass")) {
            this._syncAutomationCoverage();
        }
    }

    /**
     * Follow the shared coverage source, and re-follow it when `hass` changes.
     *
     * Re-followed rather than left alone because `hass` is replaced wholesale
     * on every state update in Home Assistant, and only the connection behind
     * it is stable -- which is exactly what the shared source is keyed by, so
     * a resubscribe on a live connection costs nothing but the closure.
     */
    private _syncAutomationCoverage(): void {
        const hass = this.hass;
        if (!hass || !this.isConnected) {
            return;
        }
        if (this._coverageHass?.connection === hass.connection && this._unsubscribeAutomationCoverage) {
            return;
        }

        this._unsubscribeAutomationCoverage?.();
        this._coverageHass = hass;
        const source = getSharedAutomationCoverage(hass as unknown as HomeAssistantLike);
        this._automationCoverage = source.get();
        this._unsubscribeAutomationCoverage = source.subscribe((index) => {
            this._automationCoverage = index;
        });
    }

    updated(): void {
        // Only ever a tree walk. Measuring the track here instead -- straight
        // after Lit has written the DOM -- is a read-after-write, and the band
        // updates often enough that the forced reflow was the card's single
        // largest layout cost. The width now arrives from the observer, which
        // is delivered after layout has happened anyway.
        this._syncTrackResizeObserver();
    }

    private _syncTrackResizeObserver(): void {
        const laneKey = this.lanes[0]?.key ?? "";
        const track = this.renderRoot.querySelector(`.lane[data-lane="${laneKey}"] .track`);
        if (track === null) {
            this._disconnectTrackResizeObserver();
            this._trackWidthPx = 0;
            return;
        }

        if (track === this._observedTrack) {
            return;
        }

        this._disconnectTrackResizeObserver();
        this._observedTrack = track;
        this._trackResizeObserver = new ResizeObserver((entries) => {
            const entry = entries[entries.length - 1];
            if (entry === undefined) {
                return;
            }

            // `borderBoxSize` rather than `contentRect`: the track has an
            // outline today and so the two agree, but a border added later
            // would silently shrink the content box under every segment.
            const width = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
            this._trackWidthPx = width;
        });
        this._trackResizeObserver.observe(track);
    }

    private _disconnectTrackResizeObserver(): void {
        this._trackResizeObserver?.disconnect();
        this._trackResizeObserver = null;
        this._observedTrack = null;
    }

    render() {
        if (!this.day) {
            return nothing;
        }

        // Once per render, not once per row: every row is ruled by the same
        // ticks, and deriving them per lane would be the same walk of the day
        // repeated seven times on every pointer move.
        const needsOwnTicks = this.showAxis || (this.slotGrid && this.timeGridTicks.length === 0);
        this._ownTicks = needsOwnTicks ? this._ownGridTicks() : [];
        this._gridTicks = this._resolveGridTicks();
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
                @mouseleave=${() => { this._clearHoveredSlot(); this._emitTimeHover(null); }}
            >
                ${this.showForecastRows ? html`
                    ${this._renderSolarRow()}
                    ${this._renderSocRow()}
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
            <!-- Outside the band, which is a grid: a dialog is not a row of it. -->
            ${this._renderAutomationEditDialog()}
        `;
    }

    /**
     * The day's own grid: a line per slot, hours labelled as densely as the
     * width allows.
     *
     * The slot length comes from the day rather than from a constant, because
     * the slots are what the schedule is kept in -- a grid on a fixed half hour
     * would rule a quarter-hourly day between its slots. Empty until the track
     * has been measured: how many lines and how many numbers fit is the one
     * thing that cannot be answered without a width.
     */
    private _ownGridTicks(): SlotGridTick[] {
        const slots = this.day?.slots ?? [];
        if (slots.length === 0 || this._trackWidthPx <= 0) {
            return [];
        }

        const first = slots[0];
        const slotMinutes = Math.round(((first.endMs ?? first.startMs) - first.startMs) / MINUTE_MS);
        return slotGridTicks({
            startMinutes: (this._windowStartMs - this.day.startMs) / MINUTE_MS,
            endMinutes: (this._windowEndMs - this.day.startMs) / MINUTE_MS,
            slotMinutes,
            plotWidth: this._trackWidthPx,
        });
    }

    /**
     * Which lines this band is ruled by: the host's, when it is stacked under
     * charts that already ruled the same day, and otherwise its own.
     *
     * A host's grid wins because a band under a chart has to be ruled by that
     * chart -- two grids over one day is two answers to where a slot begins.
     * Standing alone the band is the host, and derives the very same ticks.
     */
    private _resolveGridTicks(): readonly EntityDayBandGridTick[] {
        if (this.timeGridTicks.length > 0) {
            return this.timeGridTicks;
        }

        if (!this.slotGrid) {
            return [];
        }

        return this._ownTicks.map((tick) => ({
            atMs: this.day.startMs + tick.minutes * MINUTE_MS,
            major: tick.hour !== null,
        }));
    }

    /**
     * The hour labels, on the lines that carry them.
     *
     * The same ticks the grid is drawn from, so every number sits on a line
     * that is there -- and as many of them as the width has room for, which on
     * a wide dialog is every hour and on a phone is every sixth. Cropping to
     * daylight drops the hours that scrolled off rather than squeezing them
     * into what is left: a "00" at the left edge of a band that starts at 04:00
     * is worse than no tick at all.
     */
    private _renderAxisTicks() {
        return this._ownTicks.flatMap((tick) => {
            if (tick.hour === null) {
                return [];
            }

            const percent = this._toPercent(this.day.startMs + tick.minutes * MINUTE_MS);
            const edge = percent <= AXIS_EDGE_PERCENT
                ? " edge-start"
                : percent >= 100 - AXIS_EDGE_PERCENT ? " edge-end" : "";
            return [html`
                <span class=${`axis-tick${edge}`} style=${`left: ${percent}%`}>
                    ${String(tick.hour).padStart(2, "0")}
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
     * Battery state of charge as a column per slot, coloured by what the
     * battery does over that slot.
     *
     * The same reading the solar inspector's SoC strip gives, in the same
     * colours -- the direction and the palette come from the shared module, so
     * a green column means the same thing on both surfaces. A percentage is a
     * level, so the columns stand on a fixed 0-100 scale rather than one scaled
     * to the day. Every column here is plan, with no measured half to be
     * lighter than, so all of them are painted solid.
     */
    private _renderSocRow() {
        const columns = this._readSocColumns();
        if (columns.length === 0) {
            return nothing;
        }

        return html`
            ${this._renderContextHeading("scheduling.forecast.battery_label")}
            <div class="context-row" @pointerdown=${this._handleContextPointerDown}>
                <div class="plot">
                    ${columns.map(({ slot, socPct, direction }) => html`
                        <span
                            class="context-bar soc"
                            style=${`left: ${this._toPercent(slot.startMs)}%; width: ${this._toSlotWidthPercent(slot)}%; height: ${socPct}%; background: ${socColumnBackground(direction)}`}
                        ></span>
                    `)}
                </div>
                ${this._renderSlotValues("battery")}
                ${this._renderSlotHits("battery")}
                ${this._renderRowOverlays()}
                ${this._renderContextTrackLabel("scheduling.forecast.battery_label")}
            </div>
        `;
    }

    /**
     * The day's SoC readings as columns, each carrying the move it leads into.
     *
     * A reading is instantaneous but a column covers the slot that starts at
     * it, so the movement it stands for is the step to the next reading -- the
     * next one that exists, since a gap in the forecast must not read as the
     * battery holding. The last column of the day has nothing to move towards
     * and reads as idle.
     */
    private _readSocColumns(): {
        slot: EntityScheduleDay["slots"][number];
        socPct: number;
        direction: SocDirection;
    }[] {
        const readings = this.day.slots.flatMap((slot) => {
            const socPct = this.forecastPoints.get(slot.id)?.socPct;
            return socPct === undefined || socPct === null
                ? []
                : [{ slot, socPct: Math.max(0, Math.min(socPct, 100)) }];
        });

        return readings.map((reading, index) => ({
            ...reading,
            direction: index + 1 < readings.length
                ? resolveSocDirection(readings[index + 1].socPct - reading.socPct)
                : "idle",
        }));
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
                <div class="plot">
                    ${values.map(({ slot, value }) => value === 0 ? nothing : html`
                        <span
                            class="context-bar solar"
                            style=${`left: ${this._toPercent(slot.startMs)}%; width: ${this._toSlotWidthPercent(slot)}%; height: ${this._toBarPct(value, maxWh)}%`}
                        ></span>
                    `)}
                </div>
                ${this._renderSlotValues("solar")}
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
                <div class="plot">
                    <span class="zero-line"></span>
                    ${values.map(({ slot, value }) => {
                        if (value === 0) {
                            return nothing;
                        }

                        const positive = value > 0;
                        // Each half owns 50% of the plot, so a bar's own
                        // percentage is halved to stay inside it.
                        const heightPct = this._toBarPct(Math.abs(value), positive ? maxPositive : maxNegative) / 2;
                        return html`
                            <span
                                class=${`context-bar ${positive ? "price-positive" : "price-negative"}`}
                                style=${`left: ${this._toPercent(slot.startMs)}%; width: ${this._toSlotWidthPercent(slot)}%; height: ${heightPct}%`}
                            ></span>
                        `;
                    })}
                </div>
                ${this._renderSlotValues("price")}
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
                    <div class="row-label lane-label-row">
                        ${this._renderLaneIcon(lane)}
                        <!--
                            Beside the name button rather than inside it: the
                            coverage badge is a control, and a button inside a
                            button is not a thing -- the same rule the "why"
                            button next door already lives by.
                        -->
                        ${this._renderAutomationBadge(lane)}
                        <button
                            class="lane-label"
                            type="button"
                            aria-pressed=${selected}
                            title=${lane.name}
                            @click=${() => this._emitLaneSelect(lane.key)}
                        >
                            <span class="lane-name">${lane.name}</span>
                            ${this._renderLaneTotal(lane)}
                        </button>
                    </div>
                `}
                <!--
                    Bare track: the elapsed stretch carries no gap button, so a
                    press there would otherwise do nothing. Pressing a lane
                    anywhere means "this entity", exactly as its name does.
                -->
                <div
                    class="track"
                    title=${inTrackLabels && !this.readonly ? lane.name : nothing}
                    @click=${(event: Event) => this._handleTrackClick(event, lane.key)}
                >
                    ${this._renderVehicleSocRamp(lane)}
                    ${lane.actualSegments.map((segment) => this._renderActualSegment(lane, segment, changeBoundaries))}
                    ${this._renderGaps(lane)}
                    ${lane.blocks.map((block) => this._renderSegment(lane, block, selected, changeBoundaries))}
                    ${this._renderRowOverlays()}
                    ${this._renderSlotPicks(lane)}
                    ${this._renderDragReadout(lane)}
                </div>
                <!--
                    Outside the track, which clips: the name has to be free to
                    reach back into whatever gutter the host inset the track by.
                -->
                ${inTrackLabels ? this._renderTrackLabel(lane) : nothing}
            </div>
        `;
    }

    /**
     * The day's slots, drawn on one lane.
     *
     * A cell per slot, whatever the grid over it chose to rule: on a narrow
     * dialog the lines thin out to stay readable, but the slot is still what a
     * press means and what a hover is about, so every one of them keeps its
     * target. Above the runs, because where the slot is what a press means, the
     * run is what is being asked about.
     *
     * Every lane marks the same slot, and the lane the pointer is in marks it
     * harder. The question a hovered hour asks is what else is going on then,
     * and one washed cell in one track cannot answer it.
     */
    private _renderSlotPicks(lane: EntityDayBandLane) {
        if (!this.slotGrid) {
            return nothing;
        }

        return this.day.slots.map((slot) => {
            const hovered = this._hoveredSlotId === slot.id;
            const classes = [
                "slot-pick",
                this.slotPicks ? "pickable" : "",
                hovered ? (this._hoveredLaneKey === lane.key ? "hovered" : "co-hovered") : "",
                this.selectedSlot?.laneKey === lane.key && this.selectedSlot.slotId === slot.id
                    ? "selected"
                    : "",
            ].filter((value) => value.length > 0).join(" ");
            return html`
                <span
                    class=${classes}
                    data-slot=${slot.id}
                    style=${`left: ${this._toPercent(slot.startMs)}%; width: ${this._toSlotWidthPercent(slot)}%`}
                    @click=${(event: Event) => this._handleSlotPickClick(event, lane, slot.id)}
                ></span>
            `;
        });
    }

    /**
     * The hours the drag is on right now, over the run being dragged.
     *
     * A drag is the one edit made with the pointer rather than with the fields
     * below, and a bar sliding along a track says "about eight" at best -- the
     * step is a whole slot, so the answer is exact and worth printing. Both
     * ends of it, whichever end is being pulled: moving a run changes both, and
     * resizing one changes where it now stops as much as how long it lasts.
     *
     * It rides the edge under the pointer, which is where the user is looking,
     * and is held inside the track so a run dragged to midnight still has its
     * hours legible. Inert -- the pointer is captured by the drag anyway.
     */
    private _renderDragReadout(lane: EntityDayBandLane) {
        const drag = this._drag;
        const range = this._dragRange;
        if (drag === null || range === null || drag.laneKey !== lane.key) {
            return nothing;
        }

        const anchorMs = drag.mode === "start"
            ? range.startMs
            : drag.mode === "end"
                ? range.endMs
                : (range.startMs + range.endMs) / 2;
        const halfPct = this._trackWidthPx > 0
            ? Math.min((DRAG_READOUT_HALF_WIDTH_PX / this._trackWidthPx) * 100, 50)
            : 0;
        const leftPct = Math.min(Math.max(this._toPercent(anchorMs), halfPct), 100 - halfPct);
        return html`
            <span class="drag-readout" style=${`left: ${leftPct}%`}>
                <span class="drag-readout-range">${
                    formatScheduleTime(range.startMs, this.locale, this.timeZone)
                }–${
                    formatScheduleTime(range.endMs, this.locale, this.timeZone)
                }</span>
                <span class="drag-readout-duration">${this._formatHours(range.endMs - range.startMs)}</span>
            </span>
        `;
    }

    /**
     * Which slot -- and which lane's copy of it -- the pointer is on.
     *
     * Read off the time axis rather than off the element under the cursor,
     * because the mark has to appear in rows the pointer is nowhere near. The
     * lane comes from the DOM, since that is the one part of it that really is
     * about what is being pointed at; over a forecast row there is no lane, and
     * the slot is marked in every track equally.
     *
     * Both are held still unless they change: this runs at pointer rate, and
     * re-rendering forty slots across seven lanes for a cursor that moved two
     * pixels inside the same half hour is forty slots redrawn for nothing.
     */
    private _trackHoveredSlot(atMs: number | null, event: MouseEvent): void {
        if (!this.slotGrid) {
            return;
        }

        const slotId = atMs === null ? null : this._resolveSlotIdAt(atMs);
        const target = event.target;
        const laneKey = slotId === null || !(target instanceof Element)
            ? null
            : target.closest(".lane[data-lane]")?.getAttribute("data-lane") ?? null;
        if (this._hoveredSlotId !== slotId) {
            this._hoveredSlotId = slotId;
        }

        if (this._hoveredLaneKey !== laneKey) {
            this._hoveredLaneKey = laneKey;
        }
    }

    private _clearHoveredSlot(): void {
        this._hoveredSlotId = null;
        this._hoveredLaneKey = null;
    }

    private _resolveSlotIdAt(atMs: number): string | null {
        for (const slot of this.day.slots) {
            if (atMs >= slot.startMs && atMs < (slot.endMs ?? slot.startMs)) {
                return slot.id;
            }
        }

        return null;
    }

    private _handleSlotPickClick(event: Event, lane: EntityDayBandLane, slotId: string): void {
        // The track's own press means "this lane"; a slot press already says
        // which lane it is in, so letting both fire would answer twice.
        event.stopPropagation();
        this.dispatchEvent(new CustomEvent<EntityDayBandSlotSelectDetail>("entity-day-band-slot-select", {
            bubbles: true,
            composed: true,
            detail: { laneKey: lane.key, slotId },
        }));
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
     *
     * It starts at the lane's left edge, not the track's: where the host inset
     * the track to clear a chart's axis gutter, the name gets that gutter to
     * itself and covers that much less of the day.
     */
    private _renderTrackLabel(lane: EntityDayBandLane) {
        return html`
            <span class="track-label">
                ${this._renderLaneIcon(lane)}
                ${this._renderAutomationBadge(lane)}
                <span class="lane-name">${lane.name}</span>
                ${this._renderLaneTotal(lane)}
            </span>
        `;
    }

    /**
     * The lane's icon, live where it can be: with the entity's state to hand it
     * is that entity's own badge, coloured by what the entity is doing right
     * now, and pressing it opens more-info -- the same identity target the
     * card's running list gives its rows. An entity the state machine cannot
     * answer for falls back to the flat icon the lane carries, so no lane ever
     * loses its icon.
     */
    private _renderLaneIcon(lane: EntityDayBandLane) {
        const stateObj = this.hass?.states?.[lane.entityId];
        if (stateObj === undefined) {
            // The flat icon has no entity to ask about, so it keeps the meaning
            // the label around it has: pressing it names the lane. It used to
            // get that for free by sitting inside the name button, which it no
            // longer does -- and a dead icon in the label row is a target that
            // looks pressable and is not.
            return html`
                <ha-icon
                    .icon=${lane.icon}
                    @click=${() => this._emitLaneSelect(lane.key)}
                ></ha-icon>
            `;
        }

        return html`
            <!--
                stateColor must be a property binding: state-badge declares it
                with attribute: false, so a bare attribute is ignored and the
                icon stays uncoloured.
            -->
            <state-badge
                .hass=${this.hass}
                .stateObj=${stateObj}
                .stateColor=${true}
                title=${lane.name}
                @click=${(event: Event) => this._handleLaneIconClick(event, lane)}
            ></state-badge>
        `;
    }

    /**
     * Whether an automation is driving this lane, right of the lane's own icon.
     *
     * One glyph in three colours rather than three glyphs: the question is
     * "who is driving this", and a colour is the fastest possible answer to it
     * across a stack of lanes. The `title` carries the same answer in words, so
     * the distinction is never colour alone.
     *
     * Nothing at all until the config has been read: a lane whose coverage is
     * simply not known yet must not be drawn as a lane nothing automates.
     *
     * `disabled_only` says the automation is not running and offers to show it,
     * rather than offering to switch it on: the state is also what the
     * automation's *master* switch produces, and that switch lives in the
     * config panel, not in the dialog this opens. Promising a fix the
     * destination cannot perform would be worse than saying less.
     */
    private _renderAutomationBadge(lane: EntityDayBandLane) {
        if (this._automationCoverage === null) {
            return nothing;
        }

        const coverage = getLaneAutomationCoverage(this._automationCoverage, lane.target);
        const title = this.localize(`scheduling.automation_coverage.${coverage.state}`);
        const icon = html`<ha-icon icon="mdi:robot"></ha-icon>`;
        if (coverage.optimizerIds.length === 0) {
            // Nothing to open. An inert span rather than a disabled button:
            // there is no action here to be temporarily unavailable.
            return html`
                <span class=${`automation-badge ${coverage.state}`} title=${title}>${icon}</span>
            `;
        }

        return html`
            <button
                class=${`automation-badge ${coverage.state}`}
                type="button"
                title=${title}
                @click=${(event: Event) => this._handleAutomationBadgeClick(event, coverage.optimizerIds)}
            >${icon}</button>
        `;
    }

    /**
     * The badge means "show me what drives this lane", not "select this lane",
     * so it swallows the press the row around it would otherwise act on.
     */
    private _handleAutomationBadgeClick(event: Event, optimizerIds: readonly string[]): void {
        event.preventDefault();
        event.stopPropagation();
        this._automationEditIds = optimizerIds;
    }

    /**
     * The optimizer editor, mounted only once a badge has asked for it.
     *
     * Remounted per request, as the explanation panel's copy is: the dialog
     * reads the config when it connects, and a fresh element per press is what
     * keeps that a load rather than a reload path nobody exercises.
     */
    private _renderAutomationEditDialog() {
        const optimizerIds = this._automationEditIds;
        if (optimizerIds === null) {
            return nothing;
        }

        return html`
            <helman-optimizer-edit-dialog
                .hass=${this.hass as unknown as HomeAssistantLike}
                .localize=${this.localize}
                .open=${true}
                .optimizerIds=${optimizerIds}
                @closed=${() => { this._automationEditIds = null; }}
            ></helman-optimizer-edit-dialog>
        `;
    }

    /**
     * The icon means "tell me about this entity", not "select this lane" -- so
     * it swallows the press that the label around it would otherwise turn into
     * a lane selection.
     */
    private _handleLaneIconClick(event: Event, lane: EntityDayBandLane): void {
        event.preventDefault();
        event.stopPropagation();
        this.dispatchEvent(new CustomEvent("hass-more-info", {
            bubbles: true,
            composed: true,
            detail: { entityId: lane.entityId },
        }));
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
        const title = `${lane.name} · ${presentation.label} · ${formatLaneRunRange(segment, this.locale, this.timeZone, segment.activeMs)}`;
        return html`
            <span
                class=${`segment actual ${presentation.toneClass}${changeBoundaries.has(segment.startMs) ? " changed" : ""}`}
                title=${this.readonly ? nothing : title}
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
        const projection = lane.blockProjections.get(block.key) ?? null;
        const blockSoc = lane.blockVehicleSoc.get(block.key);
        // The hover answers in full whatever the run was too narrow to show.
        const title = [
            `${lane.name} · ${presentation.label} · ${formatLaneRunRange(block, this.locale, this.timeZone)}`,
            projection === null
                ? ""
                : getScheduleApplianceProjectionBadgeLabel(projection, this.localize),
            blockSoc === undefined
                ? ""
                : `${this.localize("scheduling.appliance.ev.expected_soc")} ${
                    blockSoc.startPct === null ? "" : `${blockSoc.startPct} → `}${blockSoc.endPct} %`,
        ].filter((part) => part.length > 0).join(" · ");

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
                title=${this.readonly ? nothing : title}
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
                ${this._renderVehicleSocEndpoints(lane, block, widthPct)}
                <ha-icon .icon=${presentation.icon}></ha-icon>
                ${this._renderSegmentFigure(
                    projection,
                    widthPct,
                    lane.blockVehicleSoc.has(block.key) ? SOC_ENDPOINT_ALLOWANCE_PX : 0,
                )}
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
     * The run's projected consumption, as much of it as the run is wide enough
     * to say.
     *
     * Three answers rather than two, because the unit is the first thing worth
     * giving up: on a narrow run "1.4" next to a boiler's icon is already
     * unambiguous, and holding out for "1.4 kWh" would mean saying nothing at
     * all on most of the runs in a day.
     */
    private _renderSegmentFigure(
        projection: ScheduleApplianceProjectionBadge | null,
        widthPct: number,
        reservedPx: number,
    ) {
        if (projection === null || projection.kind !== "energy") {
            return nothing;
        }

        // What is left after the run's edges have taken theirs, so a charging
        // run's kilowatt-hours and its two levels are not competing for the
        // same pixels.
        const widthPx = (widthPct / 100) * this._trackWidthPx - reservedPx;
        // Unmeasured: assume there is room, and let the next update settle it.
        // Guessing narrow would blank every figure on the first paint.
        if (this._trackWidthPx > 0 && widthPx < MIN_FIGURE_WIDTH_PX) {
            return nothing;
        }

        const withUnit = this._trackWidthPx === 0 || widthPx >= MIN_UNIT_LABEL_WIDTH_PX;
        return html`<span class="segment-figure">${
            withUnit ? `${projection.text} kWh` : projection.text
        }</span>`;
    }

    /**
     * The vehicle's charge climbing across the run that causes it.
     *
     * Drawn inside the run and nowhere else. The charge is what this block of
     * time is for, and carrying the level on past the run would say the plan is
     * still doing something during hours where it has stopped.
     */
    private _renderVehicleSocRamp(lane: EntityDayBandLane) {
        if (lane.blockVehicleSoc.size === 0) {
            return nothing;
        }

        // Drawn on the track rather than inside the runs, because the track is
        // what the day's percentages are measured against -- and the runs it
        // shows through are translucent, so a column still reads as belonging
        // to the one above it. Blocks never share a slot, so the runs' own maps
        // simply add up.
        const endPctBySlotId = new Map<string, number>();
        for (const blockSoc of lane.blockVehicleSoc.values()) {
            for (const [slotId, endPct] of blockSoc.endPctBySlotId) {
                endPctBySlotId.set(slotId, endPct);
            }
        }

        return this.day.slots.map((slot) => {
            const endPct = endPctBySlotId.get(slot.id);
            if (endPct === undefined) {
                return nothing;
            }

            return html`
                <span
                    class="soc-ramp"
                    style=${`left: ${this._toPercent(slot.startMs)}%; width: ${this._toSlotWidthPercent(slot)}%; height: ${Math.max(0, Math.min(endPct, 100))}%`}
                ></span>
            `;
        });
    }

    /**
     * Where the run finds the vehicle and where it leaves it, pinned to its own
     * two edges.
     *
     * The edges are the point: a level at the left edge of a run reads as the
     * level going in, which is what makes the pair legible without an arrow
     * between them to say so. The ending level is the one worth protecting, so
     * a run too narrow for both keeps that one and drops the start.
     */
    private _renderVehicleSocEndpoints(lane: EntityDayBandLane, block: EntityScheduleBlock, widthPct: number) {
        const blockSoc = lane.blockVehicleSoc.get(block.key);
        if (blockSoc === undefined) {
            return nothing;
        }

        const widthPx = (widthPct / 100) * this._trackWidthPx;
        if (this._trackWidthPx > 0 && widthPx < MIN_SOC_END_WIDTH_PX) {
            return nothing;
        }

        const showStart = blockSoc.startPct !== null
            && (this._trackWidthPx === 0 || widthPx >= MIN_SOC_BOTH_WIDTH_PX);
        return html`
            ${showStart
                ? html`<span class="soc-endpoint start">${blockSoc.startPct}</span>`
                : nothing}
            <span class="soc-endpoint end">${blockSoc.endPct} %</span>
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
     * One cell per slot on a forecast row: the hover mark, and the tooltip that
     * says what the column is worth in full.
     *
     * A layer of its own rather than titles on the bars: a slot with no solar
     * draws no bar, and a slot with no reading at all draws nothing anywhere,
     * so there is nothing per-hour to hang a tooltip on. Inert beyond that --
     * pressing still falls through to the row, which clears the lane selection.
     *
     * Every slot gets a cell even when its reading is missing, because the row
     * is read across: skipping the hours the forecast has nothing to say about
     * would leave stretches that answer nothing when pointed at.
     */
    private _renderSlotHits(kind: "battery" | "solar" | "price") {
        return this.day.slots.map((slot) => {
            const title = this._buildSlotHitTitle(kind, slot);
            const classes = [
                "slot-hit",
                this._hoveredSlotId === slot.id
                    ? (this._hoveredLaneKey === null ? "hovered" : "co-hovered")
                    : "",
            ].filter((value) => value.length > 0).join(" ");
            return html`
                <span
                    class=${classes}
                    title=${title ?? nothing}
                    style=${`left: ${this._toPercent(slot.startMs)}%; width: ${this._toSlotWidthPercent(slot)}%`}
                ></span>
            `;
        });
    }

    /**
     * What each slot of a forecast row is worth, written over the row.
     *
     * The strip along the top rather than a label on each bar: the bars are the
     * shape of the day and the numbers are the day itself, and a value pinned to
     * the top of its own column moves as the column does, which makes a row of
     * readings impossible to scan across. Above the plot, so no number is ever
     * written on a bar.
     *
     * A slot too narrow to hold its number goes without one -- except the slot
     * under the pointer, which is the one slot somebody is asking about, and
     * which is allowed to spill over its neighbours to be legible.
     */
    private _renderSlotValues(kind: "battery" | "solar" | "price") {
        return this.day.slots.map((slot) => {
            const text = this._buildSlotValueText(kind, slot);
            if (text === null) {
                return nothing;
            }

            const hovered = this._hoveredSlotId === slot.id;
            const widthPct = this._toSlotWidthPercent(slot);
            if (!hovered && !this._isWideEnoughForValue(widthPct)) {
                return nothing;
            }

            return html`
                <span
                    class=${`slot-value${hovered ? " hovered" : ""}`}
                    style=${`left: ${this._toPercent(slot.startMs)}%; width: ${widthPct}%`}
                >${text}</span>
            `;
        });
    }

    /**
     * The slot's reading, short enough to fit in a slot's worth of room.
     *
     * Shorter than the tooltip on purpose: the tooltip names the series and the
     * hours, which the row and the axis already say to anyone reading the strip
     * -- what is left is the number, and the units are the row's, not the
     * cell's.
     */
    private _buildSlotValueText(
        kind: "battery" | "solar" | "price",
        slot: { id: string; startMs: number; endMs: number | null },
    ): string | null {
        const point = this.forecastPoints.get(slot.id);
        if (point === undefined) {
            return null;
        }

        if (kind === "battery") {
            return point.socPct === null || point.socPct === undefined
                ? null
                : `${Math.round(point.socPct)}`;
        }

        if (kind === "solar") {
            return point.solarWh === 0 ? null : this._formatSolarRate(slot);
        }

        return point.price === null || point.price === undefined
            ? null
            : point.price.toFixed(1);
    }

    /**
     * A slot's sun as kWh over a whole hour, whatever the slot's own length is.
     *
     * The forecast is energy per slot, so on a quarter-hour schedule the same
     * sunshine reads as a quarter of the number it does on an hourly one -- and
     * a row of figures that changes meaning with the slot length is a row nobody
     * can hold against the yield they know their roof gets at noon. Scaling to
     * the hour makes every reading the same reading, and it is the rate the
     * bars already draw.
     */
    private _formatSolarRate(slot: { id: string; startMs: number; endMs: number | null }): string | null {
        const solarWh = this.forecastPoints.get(slot.id)?.solarWh;
        if (solarWh === null || solarWh === undefined) {
            return null;
        }

        const durationMs = (slot.endMs ?? slot.startMs) - slot.startMs;
        const perHour = durationMs <= 0 ? solarWh : solarWh * (3_600_000 / durationMs);
        const kwh = perHour / 1000;
        return kwh >= 10 ? `${Math.round(kwh)}` : kwh.toFixed(1);
    }

    private _isWideEnoughForValue(widthPct: number): boolean {
        return this._trackWidthPx === 0
            || (widthPct / 100) * this._trackWidthPx >= MIN_SLOT_VALUE_WIDTH_PX;
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
            const value = this._formatSolarRate(slot);
            return value === null
                ? null
                : `${this.localize("scheduling.forecast.solar_label")} · ${value} kWh/h · ${range}`;
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
        return html`${this._renderTimeGrid()}${this._renderHighlights()}${this._renderPastOverlay()}${this._renderNowMarker()}`;
    }

    /**
     * The grid, ruled across this row.
     *
     * Under the highlights and the runs: the grid is the ruler the row is read
     * against, not something drawn on top of what it measures. Lines outside
     * the drawn window are dropped rather than clamped, so a cropped day is not
     * ruled by a pile of ticks stacked on its edge -- and a line exactly on the
     * window's start is dropped too, since it would draw over the row's own
     * edge rather than inside it.
     */
    private _renderTimeGrid() {
        return this._gridTicks.map((tick) => {
            if (tick.atMs <= this._windowStartMs || tick.atMs > this._windowEndMs) {
                return nothing;
            }
            const percent = this._toPercent(tick.atMs);
            const opacity = tick.major ? SLOT_GRID_LINE_OPACITY.major : SLOT_GRID_LINE_OPACITY.minor;
            return html`
                <span
                    class=${`time-grid-line ${tick.major ? "major" : ""}`}
                    style=${`left: ${percent}%; opacity: ${opacity}`}
                ></span>
            `;
        });
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
        const atMs = ratio < 0 || ratio > 1
            ? null
            : this._windowStartMs + ratio * (this._windowEndMs - this._windowStartMs);
        this._trackHoveredSlot(atMs, event);
        this._emitTimeHover(atMs);
        this.dispatchEvent(new CustomEvent<EntityDayBandPointerMoveDetail>("entity-day-band-pointer-move", {
            bubbles: true,
            composed: true,
            detail: { atMs, clientX: event.clientX, clientY: event.clientY },
        }));
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
        // The run's own hours, before the pointer has moved anywhere: the
        // readout is what says where the drag started from, so it cannot wait
        // for the first move to have something to show.
        this._dragRange = { startMs: originStartMs, endMs: block.endMs };
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
        this._dragRange = null;
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
        return resolveLaneRunPresentation(lane, run, this.localize);
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
