import type { ScheduleExplanationPayload } from "../../data/helman-commands";
import { getSharedHelmanStore, type HelmanStore } from "../../data/store";
import { DialogHistoryController } from "../../dialog-history-controller";
import { LitElement, css, html } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../../../types/ha";
import type { LocalizeFunction } from "../../../localize/localize";
import "../components/scheduling-action-chip";
import "../components/scheduling-appliance-chip";
import "../components/scheduling-entity-day-band";
import "../components/scheduling-explanation-panel";
import "./scheduling-entity-action-editor";
import type {
    EntityDayBandBlockSelectDetail,
    EntityDayBandDeselectDetail,
    EntityDayBandGapSelectDetail,
    EntityDayBandLane,
    EntityDayBandLaneSelectDetail,
    EntityDayBandRangeChangeDetail,
    EntityDayBandRangePaintDetail,
    EntityDayBandSlotSelectDetail,
    EntityDayBandWindowChangeDetail,
} from "../components/scheduling-entity-day-band";
import type {
    EntityScheduleAction,
    EntityScheduleBlock,
    EntityScheduleBlockSplits,
    EntityScheduleDay,
    EntityScheduleDraft,
    EntityScheduleDrafts,
    EntityScheduleLane,
    EntityScheduleRange,
    EntityScheduleTarget,
} from "../model/entity-day-schedule-model";
import {
    areEntityScheduleActionsEqual,
    areEntityScheduleLanesDirty,
    buildEntityScheduleBlocks,
    buildEntityScheduleBoundaryOptions,
    buildEntityScheduleHorizon,
    buildEntityScheduleLanePatches,
    freeEntityScheduleRange,
    isInverterScheduleTarget,
    isEntityScheduleActionEmpty,
    placeEntityScheduleManualRange,
    readEntityScheduleAction,
    sanitizeEntityScheduleAction,
    selectEntityScheduleDayBlocks,
    selectEntityScheduleReplacedRuns,
} from "../model/entity-day-schedule-model";
import { isScheduleInverterAction } from "../schedule-types";
import {
    buildEntityDayBandLanes,
    formatLaneRunHours,
    resolveLaneRunPresentation,
} from "../model/entity-lane-source";
import {
    parseScheduleExplanation,
    type ScheduleExplanationModel,
} from "../model/schedule-explanation-model";
import {
    EMPTY_SCHEDULE_APPLIANCE_PROJECTION_INDEX,
    type ScheduleApplianceProjectionIndex,
} from "../model/schedule-appliance-projection";
import { getScheduleApplianceActionPresentation } from "../model/schedule-appliance-action-presentation";
import { describeScheduleAppliance, type ScheduleApplianceMetadata } from "../model/schedule-appliance-metadata";
import {
    formatScheduleSpanTime,
    formatScheduleTime,
    formatScheduleWeekdayTime,
    getScheduleNextLocalDayStartMs,
    resolveScheduleSpanClock,
    type ScheduleSpanClock,
} from "../model/schedule-time";
import type { SlotForecastPoint } from "../model/slot-forecast-model";
import type {
    ScheduleApplianceAction,
    ScheduleOwnerError,
    ScheduleSlot,
    ScheduleSlotPatch,
} from "../schedule-types";
import { schedulingSharedStyles } from "../styles/scheduling-shared-styles";
import type { EntityScheduleActionChangeDetail } from "./scheduling-entity-action-editor";

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_NEW_BLOCK_DURATION_MS = HOUR_MS;
/** How much of the horizon the timeline shows at once. */
const WINDOW_MS = 24 * HOUR_MS;

/** The end picks under a manual block, as the node detail's override offers them. */
type EndPick = "plus_1h" | "plus_3h" | "end_of_day" | "next_change";

/** What the dialog is for right now: authoring the day, or accounting for it. */
type EntityDayEditorMode = "edit" | "explain";

/**
 * The manual block being placed: where it came from and where it is now.
 *
 * Every change replays the placement from the draft as it was when the
 * session began, so moving a block across others and back leaves them as
 * they were rather than eaten.
 */
export interface EntityScheduleEditSession {
    /** The block's range when the session began, freed as it moves; null for a new block. */
    origin: EntityScheduleRange | null;
    startMs: number;
    endMs: number;
    action: EntityScheduleAction;
    valid: boolean;
    /** The session had to raise its start to the day's editable boundary. */
    startClamped: boolean;
}

export interface EntityDayEditorDraftSnapshot {
    baselineSlots: readonly ScheduleSlot[];
    drafts: EntityScheduleDrafts;
    blockSplits: EntityScheduleBlockSplits;
    draftBeforeEdit: EntityScheduleDraft;
    splitsBeforeEdit: EntityScheduleBlockSplits;
    editing: EntityScheduleEditSession | null;
    selectedLaneKey: string | null;
}

/** Shared empty set, so a lane with no authored edges allocates nothing. */
const EMPTY_BLOCK_SPLITS: ReadonlySet<number> = new Set<number>();
const EMPTY_DRAFT: EntityScheduleDraft = {};

export interface EntityScheduleSaveDetail {
    patches: ScheduleSlotPatch[];
}

/**
 * The house's schedule, one entity at a time, in a 24-hour window that opens at
 * now and slides as far as the schedule reaches.
 *
 * Nothing elapsed is drawn: the window starts at now, and history is what the
 * node detail and the inspector are for. One span runs across every midnight
 * the schedule does, so a run across midnight is one block, and the window is
 * moved along it rather than switched between days.
 *
 * Every controllable entity gets a track on a shared time axis, because when to
 * run one thing is a question about what everything else is doing. Exactly one
 * of them is selected: the panel below is about that lane alone, so the editing
 * model stays the simple single-entity one and the other lanes are read-only
 * context until they are clicked.
 *
 * **Manual always wins, and automation fills whatever is left.** A manual block
 * replaces whatever it covers, however it got there, and deleting one gives its
 * range back to the automation. Automation blocks are never edited: the only
 * thing they offer is to be overridden.
 *
 * The whole schedule is drafted locally and written as a single batch on Save, so
 * moving three blocks around is one schedule write and one automation re-run
 * rather than three of each -- and edits to several entities still leave as one
 * write. Nothing is applied until Save, so Cancel is a plain close: there is
 * nothing to undo.
 *
 * **The same stack answers "why" as well as "what".** Explain mode keeps the
 * band and replaces everything under it: the lanes are split into the window's
 * slots, pressing one names it, and the explanation for that slot is drawn
 * where the editor would be. It lives here rather than in a dialog of its own
 * because a dialog opened from inside this one does not present (#17), and
 * because the question is asked *of* the hours on screen -- keeping the band
 * above the answer is what lets the next slot be one press away.
 */
@customElement("scheduling-entity-day-editor")
export class SchedulingEntityDayEditor extends LitElement {
    static styles = [
        schedulingSharedStyles,
        css`
            /* A day of blocks next to a full-width band: the band is the
               control surface here, and it only reads well when an hour is
               wide enough to point at. So it takes every pixel the dialog is
               given -- which is every pixel the screen has, see the dialog's
               own width preset below -- rather than stopping at a width of its
               own. The band's hours and the logic diagram beside it both read
               better the wider they get, and neither has anything to gain from
               a margin. (No backticks in here: this is a tagged template, and
               one would end it mid-comment.) */
            .dialog-content {
                position: relative;
                display: flex;
                flex-direction: column;
                gap: 14px;
                width: 100%;
                padding-top: 4px;
            }

            /* Nothing selected: the stack is still readable as the day's plan,
               and this says how to get an editor back. */
            .select-hint {
                padding: 6px 2px;
            }

            /* Now and Tomorrow on the left; the window's span and the mode
               switch on the right. */
            .window-row {
                display: flex;
                align-items: center;
                gap: 6px 10px;
                flex-wrap: wrap;
            }

            .window-span {
                margin-left: auto;
                color: var(--secondary-text-color);
                font-size: 0.78rem;
                font-variant-numeric: tabular-nums;
                white-space: nowrap;
            }

            /* The far end of the window row: choosing what the dialog is *for*
               is a different kind of choice from choosing which hours it is
               about, and putting it among the jump buttons would read as one
               more of them. */
            .mode-switch {
                display: flex;
                gap: 0;
            }

            .mode-button {
                padding: 4px 10px;
                border: 1px solid var(--divider-color);
                background: var(--card-background-color);
                color: inherit;
                font: inherit;
                font-size: 0.8rem;
                cursor: pointer;
            }

            .mode-button:first-child {
                border-radius: 999px 0 0 999px;
            }

            .mode-button:last-child {
                border-radius: 0 999px 999px 0;
                border-left-width: 0;
            }

            .mode-button.selected {
                border-color: color-mix(in srgb, var(--primary-color) 44%, var(--divider-color));
                background: color-mix(in srgb, var(--primary-color) 12%, var(--card-background-color));
                color: var(--primary-color);
            }

            /* Nothing pressed yet: the band above is the thing to press, and
               this is where the answer will appear. */
            .explain-hint {
                padding: 6px 2px;
            }

            .window-jump {
                padding: 4px 12px;
                border: 1px solid var(--divider-color);
                border-radius: 999px;
                background: var(--card-background-color);
                color: inherit;
                font: inherit;
                font-size: 0.8rem;
                cursor: pointer;
            }

            .window-jump[aria-pressed="true"] {
                border-color: color-mix(in srgb, var(--primary-color) 44%, var(--divider-color));
                background: color-mix(in srgb, var(--primary-color) 12%, var(--card-background-color));
                color: var(--primary-color);
            }

            .window-jump:disabled {
                cursor: default;
                opacity: 0.5;
            }

            .stale-banner {
                display: flex;
                gap: 8px;
                padding: 8px 10px;
                border: 1px solid color-mix(in srgb, var(--warning-color, #c27c0e) 40%, var(--divider-color));
                border-radius: 10px;
                background: color-mix(in srgb, var(--warning-color, #c27c0e) 10%, var(--card-background-color));
                font-size: 0.82rem;
            }

            .save-error {
                display: flex;
                gap: 8px;
                padding: 8px 10px;
                border: 1px solid color-mix(in srgb, var(--error-color, #db4437) 40%, var(--divider-color));
                border-radius: 10px;
                background: color-mix(in srgb, var(--error-color, #db4437) 10%, var(--card-background-color));
                font-size: 0.82rem;
            }

            /* Fixed whatever the device: where the block is on top, what it
               does under a divider. The placement controls are the same for
               every lane, so they stay right under the timeline. */
            .edit-panel {
                gap: 0;
                padding: 0;
            }

            .placement,
            .details {
                display: flex;
                flex-direction: column;
                gap: 10px;
                padding: 14px;
            }

            .details {
                border-top: 1px solid var(--divider-color);
            }

            .placement-row {
                display: flex;
                flex-wrap: wrap;
                align-items: flex-end;
                gap: 10px 14px;
            }

            /* Badge, read-only range and duration line up with the selects'
               boxes rather than with their labels above them. */
            .placement-row > .authorship-badge,
            .placement-row > .placement-range,
            .placement-row > .placement-duration,
            .placement-row > .lane-name {
                align-self: center;
            }

            .placement-row.read-only {
                align-items: center;
            }

            .placement-row .field {
                gap: 4px;
            }

            .placement-actions {
                margin-left: auto;
                align-self: center;
            }

            .authorship-badge {
                padding: 3px 8px;
                border: 1px solid color-mix(in srgb, var(--schedule-authorship-color) 45%, transparent);
                border-radius: 6px;
                background: color-mix(in srgb, var(--schedule-authorship-color) 16%, transparent);
                color: var(--schedule-authorship-color);
                font-size: 0.7rem;
                font-weight: 700;
                letter-spacing: 0.06em;
                text-transform: uppercase;
            }

            .authorship-badge.user {
                --schedule-authorship-color: var(--schedule-authorship-user-color, #c49012);
            }

            .authorship-badge.automation {
                --schedule-authorship-color: var(--schedule-authorship-automation-color, #2563eb);
            }

            .placement-range {
                font-weight: 600;
                font-variant-numeric: tabular-nums;
            }

            .placement-duration {
                color: var(--secondary-text-color);
                font-size: 0.85rem;
                font-variant-numeric: tabular-nums;
            }

            .lane-name {
                font-weight: 600;
            }

            .picks {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 8px;
            }

            .pick {
                min-height: 30px;
                padding: 2px 12px;
                border: 1px solid var(--divider-color);
                border-radius: 999px;
                background: var(--card-background-color);
                color: var(--primary-text-color);
                font: inherit;
                font-size: 0.85rem;
                font-weight: 600;
                cursor: pointer;
            }

            .pick[aria-pressed="true"] {
                border-color: var(--primary-color);
                color: var(--primary-color);
            }

            .pill-button {
                min-height: 34px;
                padding: 4px 14px;
                border-radius: 999px;
                font: inherit;
                font-size: 0.85rem;
                font-weight: 600;
                cursor: pointer;
            }

            .pill-button.delete {
                border: 1px solid color-mix(in srgb, var(--error-color, #db4437) 60%, var(--divider-color));
                background: none;
                color: var(--error-color, #db4437);
            }

            .pill-button.override {
                border: none;
                background: var(--primary-color);
                color: var(--text-primary-color, #fff);
            }

            .replaces {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 6px 12px;
                font-size: 0.82rem;
            }

            .replaced-run {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                color: var(--secondary-text-color);
                font-variant-numeric: tabular-nums;
            }

            .replaced-run .replaced-action {
                text-decoration: line-through;
                opacity: 0.75;
            }

            .details-title {
                font-weight: 700;
            }

            /* The footer's left side: what the band's marks mean, so the
               placement controls can sit right under the timeline. */
            .legend {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 4px 14px;
                margin-inline-end: auto;
                color: var(--secondary-text-color);
                font-size: 0.78rem;
            }

            .legend-item {
                display: inline-flex;
                align-items: center;
                gap: 6px;
            }

            .legend-swatch {
                box-sizing: border-box;
                width: 18px;
                height: 10px;
                border-radius: 2px;
                background: color-mix(in srgb, var(--primary-text-color) 22%, transparent);
            }

            .legend-swatch.user {
                box-shadow: inset 0 -3px 0 var(--schedule-authorship-user-color, #c49012);
            }

            .legend-swatch.automation {
                box-shadow: inset 0 -3px 0 var(--schedule-authorship-automation-color, #2563eb);
            }

            .legend-swatch.freed {
                border: 1px dashed var(--schedule-authorship-automation-color, #2563eb);
                background: color-mix(in srgb, var(--schedule-authorship-automation-color, #2563eb) 8%, transparent);
            }
        `,
    ];

    /** Passed straight to the band, whose lane labels show live entity state. */
    @property({ attribute: false }) public hass?: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    /** The lane selected when the dialog opens: the row the user pressed. */
    @property({ attribute: false }) public target: EntityScheduleTarget | null = null;
    @property({ attribute: false }) public appliance: ScheduleApplianceMetadata | null = null;
    /** Every controllable entity with an authorable lane, in display order. */
    @property({ attribute: false }) public lanes: readonly EntityScheduleLane[] = [];
    @property({ attribute: false }) public slots: readonly ScheduleSlot[] = [];
    /** The schedule's slot length, from the payload: the grid every edit snaps to. */
    @property({ type: Number }) public slotMinutes!: number;
    @property({ attribute: false }) public forecastPoints: ReadonlyMap<string, SlotForecastPoint> = new Map();
    /** Projected consumption and vehicle SoC, for the band's own figures. */
    @property({ attribute: false }) public projectionIndex: ScheduleApplianceProjectionIndex =
        EMPTY_SCHEDULE_APPLIANCE_PROJECTION_INDEX;
    /** How the price is denominated, for the forecast rows' tooltips. */
    @property({ type: String }) public priceUnit: string | null = null;
    @property({ type: String }) public locale = "cs";
    @property({ type: String }) public timeZone = "UTC";
    @property({ type: Number }) public nowMs = Date.now();
    @property({ type: Boolean }) public open = false;
    @property({ type: Boolean }) public busy = false;
    /** The schedule changed under the draft; Save will overwrite what arrived. */
    @property({ type: Boolean }) public scheduleChanged = false;
    /**
     * Why the last Save did not land, as the backend put it.
     *
     * A rejected write leaves the dialog open over the draft that caused it,
     * which without this reads as a dead button: nothing closes, nothing
     * changes, and the reason is only in the console.
     */
    @property({ attribute: false }) public saveError: ScheduleOwnerError | null = null;

    /**
     * The slots as they were when the dialog opened.
     *
     * The draft is diffed against this, not against whatever the card is holding
     * now: a refresh mid-edit must not silently rewrite what the user is
     * editing. Patches carry explicit per-slot domains, so a stale baseline can
     * only overwrite this entity's own lane.
     */
    @state() private _baselineSlots: ScheduleSlot[] = [];
    /** Pending edits per lane; every lane keeps its own until Save. */
    @state() private _drafts: EntityScheduleDrafts = {};
    /**
     * Block edges authored in this dialog, per lane.
     *
     * A block is derived from the slots, so one the user creates next to a run
     * carrying the same action would otherwise fold into it and the edit would
     * silently become an extension of the neighbour. These edges keep the two
     * apart for as long as the dialog is open -- long enough to give the new
     * block different parameters, which is the whole reason it was created --
     * and are deliberately not saved: reopening reads the stored schedule the
     * way the config editor does, contiguous identical runs as one series.
     */
    @state() private _blockSplits: EntityScheduleBlockSplits = {};
    /** The lane being edited, or null when the user clicked away from all of them. */
    @state() private _selectedLaneKey: string | null = null;
    /**
     * Where the window starts, or null to start at now and move with it.
     *
     * Not remembered across openings: every opening starts at now. Read
     * through `_window`, which keeps it inside the horizon as the clock moves.
     */
    @state() private _viewStartMs: number | null = null;
    /** The manual block being placed, when one is selected. */
    @state() private _editing: EntityScheduleEditSession | null = null;
    /** The automation run selected instead, read only: all it offers is "override". */
    @state() private _selectedAutomation: EntityScheduleBlock | null = null;
    /**
     * The action each lane last placed in this opening, so painting the next
     * block starts from it rather than from the lane's default every time.
     */
    private _lastActions: Record<string, EntityScheduleAction> = {};
    @state() private _mode: EntityDayEditorMode = "edit";
    /**
     * The press found nothing left to write: every drafted slot had elapsed.
     *
     * Rare, and cleared by the next edit or the next press, but it is the one
     * other way Save can decline to do anything -- and a Save that declines
     * silently is what made this dialog look broken in the first place.
     */
    @state() private _elapsedDraftNotice = false;
    /** The slot Explain mode is accounting for, and the lane it belongs to. */
    @state() private _explainSelection: { laneKey: string; slotId: string } | null = null;
    /**
     * The condition record per lane and day, raw as the backend served it.
     *
     * The store fetches and shares each lane/day record across openings. The
     * editor keeps this map for the current opening's rendering and errors.
     */
    @state() private _explanations: ReadonlyMap<string, ScheduleExplanationPayload | null> = new Map();
    /** The window's days last asked about, so only a change of days asks again. */
    private _explainedDayKeys = "";
    /** Lanes whose record could not be fetched, which is not the same as none. */
    @state() private _explanationFailures: ReadonlySet<string> = new Set();
    /** The parsed form of `_explanations`, rebuilt only when that map changes. */
    private _explanationModels: ReadonlyMap<string, ScheduleExplanationModel> = new Map();
    /**
     * Lanes already asked about in this opening, so re-entering Explain mode
     * does not ask again. The store keeps successful records across openings.
     */
    private _explanationsRequested = new Set<string>();
    private _explanationGeneration = 0;
    private _explanationStore: HelmanStore | null = null;
    private _unsubscribeExplanationInvalidation: (() => void) | null = null;
    private _horizonFor: {
        slots: readonly ScheduleSlot[]; nowMs: number; slotMinutes: number; timeZone: string;
    } | null = null;
    private _cachedHorizon: EntityScheduleDay | null = null;
    /** How the horizon's boundaries are named, settled with the horizon. */
    private _horizonClock: ScheduleSpanClock | null = null;
    /**
     * The draft as it stood when the current press began, for a second finger
     * to put back: a pan must not leave behind the paint the first finger
     * started.
     */
    private _pressSnapshot: (EntityDayEditorDraftSnapshot & { selectedAutomation: EntityScheduleBlock | null }) | null = null;
    /** The pointers down in the gesture the snapshot belongs to. */
    private readonly _bandPointers = new Set<number>();
    private _blocksFor = new Map<string, {
        day: EntityScheduleDay; slots: readonly ScheduleSlot[]; target: EntityScheduleTarget;
        draft: EntityScheduleDraft; splits: ReadonlySet<number>; editing: EntityScheduleEditSession | null;
        nowMs: number; blocks: EntityScheduleBlock[];
    }>();
    /** The lane's saved runs, which change only with the baseline. */
    private _baselineBlocksFor = new Map<string, {
        slots: readonly ScheduleSlot[]; target: EntityScheduleTarget; nowMs: number;
        blocks: EntityScheduleBlock[];
    }>();
    private _bandLanesFor: {
        day: EntityScheduleDay; lanes: readonly EntityScheduleLane[];
        slots: readonly ScheduleSlot[]; drafts: EntityScheduleDrafts;
        splits: EntityScheduleBlockSplits; editing: EntityScheduleEditSession | null;
        nowMs: number; projectionIndex: ScheduleApplianceProjectionIndex;
        result: EntityDayBandLane[];
    } | null = null;
    private _draftBeforeEdit: EntityScheduleDraft = {};
    /** The edges as they stood when the session began, replayed with the draft. */
    private _splitsBeforeEdit: EntityScheduleBlockSplits = {};
    private _restoredDraft = false;
    /** Bumped per edit session, so the action editor knows a new one began. */
    private _editSessionId = 0;
    private readonly _history = new DialogHistoryController(this, "__helmanEntityScheduleDialogId", { close: () => this._close() });

    public releaseHistory(): Promise<void> {
        return this._history.release();
    }

    public snapshotDraftState(): EntityDayEditorDraftSnapshot {
        return {
            baselineSlots: this._baselineSlots,
            drafts: this._drafts,
            blockSplits: this._blockSplits,
            draftBeforeEdit: this._draftBeforeEdit,
            splitsBeforeEdit: this._splitsBeforeEdit,
            editing: this._editing,
            selectedLaneKey: this._selectedLaneKey,
        };
    }

    public restoreDraftState(
        snapshot: EntityDayEditorDraftSnapshot,
        target: EntityScheduleTarget | null,
    ): void {
        this._baselineSlots = [...snapshot.baselineSlots];
        this._drafts = snapshot.drafts;
        this._blockSplits = snapshot.blockSplits;
        this._draftBeforeEdit = target === snapshot.selectedLaneKey ? snapshot.draftBeforeEdit : {};
        this._splitsBeforeEdit = snapshot.splitsBeforeEdit;
        this._editing = target === snapshot.selectedLaneKey ? snapshot.editing : null;
        this._selectedAutomation = null;
        this._selectedLaneKey = target;
        this._viewStartMs = null;
        this._restoredDraft = true;
        this.requestUpdate();
    }

    private _syncExplanationStore(): void {
        if (!this.hass) return;
        const store = getSharedHelmanStore(this.hass);
        if (store === this._explanationStore) return;
        this._unsubscribeExplanationInvalidation?.();
        this._explanationStore = store;
        this._unsubscribeExplanationInvalidation = store.subscribeExplanationInvalidation(() => {
            this._explanationGeneration++;
            this._explanations = new Map();
            this._explanationFailures = new Set();
            this._explanationsRequested = new Set();
            if (this.open && this._mode === "explain") this._requestExplanations();
        });
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this._unsubscribeExplanationInvalidation?.();
        this._unsubscribeExplanationInvalidation = null;
        this._explanationStore = null;
        this._endBandGesture();
    }

    willUpdate(changedProperties: Map<string, unknown>): void {
        super.willUpdate(changedProperties);
        this._syncExplanationStore();

        // Seed once per opening: later slot updates are the refresh case, which
        // the stale banner reports instead of applying.
        if (this._restoredDraft) {
            this._restoredDraft = false;
        } else if (this.open && (changedProperties.has("open") || changedProperties.has("target"))) {
            this._seedFromSlots();
        }

        this._followWindowInExplain();

        if (changedProperties.has("_explanations")) {
            const parsed = new Map<string, ScheduleExplanationModel>();
            for (const [key, payload] of this._explanations) {
                const model = parseScheduleExplanation(payload);
                if (model !== null) {
                    parsed.set(key, model);
                }
            }
            this._explanationModels = parsed;
        }
    }

    updated(changedProperties: Map<string, unknown>): void {
        super.updated(changedProperties);
        if (this.open && !this._history.active && changedProperties.has("open")) {
            this._history.push();
        }

        // The banner sits at the end of the scrolling body while Save sits in
        // the pinned footer, so on a tall day it can appear below the fold --
        // leaving the press looking as unanswered as it did before there was a
        // banner at all. `nearest` scrolls only as far as it has to.
        if (changedProperties.has("saveError") || changedProperties.has("_elapsedDraftNotice")) {
            this.shadowRoot?.querySelector(".save-error")?.scrollIntoView({ block: "nearest" });
        }
    }

    render() {
        // The horizon and per-lane blocks are each derived from the whole slot
        // array, so they are built once here and passed down rather than
        // recomputed by every renderer that needs them -- during a drag this
        // runs per frame.
        const day = this._horizon();
        if (this.lanes.length === 0 || day === null) {
            return nothing;
        }

        const view = this._window(day);
        const explaining = this._mode === "explain";
        const bandLanes = explaining
            ? this._explainableBandLanes(this._buildBandLanes(day), view)
            : this._buildBandLanes(day);
        const selectedLane = this._selectedLane;
        const selectedBandLane = bandLanes.find((lane) => lane.key === selectedLane?.key) ?? null;
        // A session that places nothing is not on the band, so the blocks still
        // drawn under its range must not read as the one being edited.
        const selection = this._editing === null
            ? this._selectedAutomation
            : this._sessionPlaces(this._editing) ? this._editing : null;
        const heading = selectedLane?.name ?? this.localize("scheduling.entity_editor.title");
        return html`
            <!--
                The widest preset there is -- min(95vw, safe-width): this
                dialog is a whole day on one time axis with a decision diagram
                under it, and both are read across rather than down.
            -->
            <ha-dialog
                .open=${this.open}
                width="full"
                .heading=${heading}
                .headerTitle=${heading}
                @closed=${this._onClosed}
            >
                <!--
                    Pressing anything that is not the edit panel or the band
                    ends the selection. The block keeps whatever
                    the session did to it: the draft is the only edit buffer,
                    and Save and Cancel are the only places it is committed or
                    thrown away.

                    On pointerdown rather than click: a click is retargeted to
                    the nearest common ancestor when its element is re-rendered
                    between press and release, which selecting or dragging a
                    block does -- so the click for "I picked this block" arrived
                    here looking like "I clicked the dialog background" and
                    closed the panel it had just opened.
                -->
                <div class="dialog-content" @pointerdown=${this._handleContentPointerDown}>
                    ${this._renderWindowRow(day, view)}
                    ${this.scheduleChanged ? html`
                        <div class="stale-banner">
                            <ha-icon icon="mdi:alert-outline"></ha-icon>
                            <span>${this.localize("scheduling.entity_editor.schedule_changed")}</span>
                        </div>
                    ` : nothing}

                    <!--
                        Read-only while explaining: the lanes are a grid of
                        slots to ask about, and a drag that moved a block would
                        be answering a question the mode cannot ask.
                    -->
                    <scheduling-entity-day-band
                        .hass=${this.hass}
                        .localize=${this.localize}
                        .day=${day}
                        .windowStartMs=${view.startMs}
                        .windowEndMs=${view.endMs}
                        .pannable=${true}
                        .windowAtNow=${view.startMs === this.nowMs}
                        .lanes=${bandLanes}
                        .selectedLaneKey=${explaining ? null : this._selectedLaneKey}
                        .forecastPoints=${this.forecastPoints}
                        .priceUnit=${this.priceUnit}
                        .nowMs=${this.nowMs}
                        .locale=${this.locale}
                        .timeZone=${this.timeZone}
                        .readonly=${explaining}
                        .slotGrid=${true}
                        .slotPicks=${explaining}
                        .selectedSlot=${this._explainSelection}
                        .editingRange=${selection === null || explaining ? null : {
                            startMs: selection.startMs,
                            endMs: selection.endMs,
                        }}
                        @entity-day-band-block-select=${this._handleBandBlockSelect}
                        @entity-day-band-deselect=${this._handleBandDeselect}
                        @entity-day-band-range-paint=${this._handleBandRangePaint}
                        @entity-day-band-lane-select=${this._handleBandLaneSelect}
                        @entity-day-band-context-select=${this._handleBandContextSelect}
                        @entity-day-band-gap-select=${this._handleBandGapSelect}
                        @entity-day-band-range-change=${this._handleBandRangeChange}
                        @entity-day-band-slot-select=${this._handleBandSlotSelect}
                        @pointerdown=${{ handleEvent: this._handleBandPressCapture, capture: true }}
                        @entity-day-band-window-change=${this._handleBandWindowChange}
                        @entity-day-band-gesture-cancel=${this._handleBandGestureCancel}
                    ></scheduling-entity-day-band>

                    ${explaining ? this._renderExplanation(day) : selectedLane === null ? html`
                        <div class="field-help select-hint">
                            ${this.localize("scheduling.entity_editor.select_entity")}
                        </div>
                    ` : this._renderEditPanel(day, view, selectedLane, selectedBandLane)}

                    <!--
                        Last in the content, so a refused Save is next to the
                        button that refused rather than scrolled off the top.
                    -->
                    ${this._renderSaveError()}
                </div>

                <ha-dialog-footer slot="footer">
                    ${explaining ? nothing : this._renderLegend()}
                    <ha-button slot="secondaryAction" .appearance=${"plain"} @click=${this._close}>
                        ${this.localize("scheduling.dialog.cancel")}
                    </ha-button>
                    <ha-button slot="primaryAction" ?disabled=${!this._canSave()} @click=${this._handleSave}>
                        ${this.localize("scheduling.entity_editor.save")}
                    </ha-button>
                </ha-dialog-footer>
            </ha-dialog>
        `;
    }

    /**
     * Why the day is still on screen after a Save.
     *
     * The backend's own message is carried through rather than folded into one
     * generic line: "slot must be within the rolling 48-hour horizon" and
     * "targetSoc must be between 20 and 90" ask for different fixes, and only
     * the writer of the draft can make either of them.
     */
    private _renderSaveError() {
        // The local notice first: it is set by the press happening now, while
        // `saveError` is the backend's answer to the press before it.
        const message = this._elapsedDraftNotice
            ? this.localize("scheduling.entity_editor.save_elapsed")
            : this.saveError === null
                ? null
                : `${this.localize("scheduling.entity_editor.save_failed")} ${this.saveError.message}`;
        if (message === null) {
            return nothing;
        }

        return html`
            <div class="save-error" role="alert">
                <ha-icon icon="mdi:alert-circle-outline"></ha-icon>
                <span>${message}</span>
            </div>
        `;
    }

    /**
     * Now and Tomorrow, and the span the window shows.
     *
     * Two jumps rather than a day switcher: the window slides, so "which day"
     * is not a question it asks -- these are the two places worth getting back
     * to in one press. Each reads as pressed while the window is exactly there.
     */
    private _renderWindowRow(horizon: EntityScheduleDay, view: EntityScheduleRange) {
        const tomorrowMs = this._clampViewStart(horizon, getScheduleNextLocalDayStartMs(this.nowMs, this.timeZone));
        const atNow = view.startMs === this.nowMs;
        return html`
            <div class="window-row">
                <button
                    class="window-jump"
                    type="button"
                    data-jump="now"
                    aria-pressed=${atNow ? "true" : "false"}
                    @click=${() => this._setViewStart(null)}
                >${this.localize("scheduling.window.now")}</button>
                <button
                    class="window-jump"
                    type="button"
                    data-jump="tomorrow"
                    aria-pressed=${!atNow && view.startMs === tomorrowMs ? "true" : "false"}
                    ?disabled=${tomorrowMs <= this.nowMs}
                    @click=${() => this._setViewStart(tomorrowMs)}
                >${this.localize("scheduling.day.tomorrow")}</button>
                <span class="window-span">
                    ${atNow
                        ? this.localize("scheduling.window.now_mark")
                        : formatScheduleWeekdayTime(view.startMs, this.locale, this.timeZone)}
                    → ${formatScheduleWeekdayTime(view.endMs, this.locale, this.timeZone)}
                </span>
                ${this._renderModeSwitch()}
            </div>
        `;
    }

    /**
     * Edit or Explain, in the corner of the dialog.
     *
     * Two buttons rather than a toggle switch: the modes are named, and a
     * switch would leave the user to work out which end is which. Edit is the
     * one every opening starts on -- the dialog is opened by pressing something
     * a person wants to change far more often than something they want
     * explained.
     */
    private _renderModeSwitch() {
        return html`
            <div class="mode-switch" role="group">
                ${(["edit", "explain"] as const).map((mode) => html`
                    <button
                        class=${`mode-button${this._mode === mode ? " selected" : ""}`}
                        type="button"
                        data-mode=${mode}
                        aria-pressed=${this._mode === mode}
                        @click=${() => this._setMode(mode)}
                    >
                        ${this.localize(`scheduling.entity_editor.mode_${mode}`)}
                    </button>
                `)}
            </div>
        `;
    }

    /**
     * The answer for the slot that was pressed, where the editor would be.
     *
     * Nothing is preselected: the placeholder says what to press, because a
     * diagram that appeared on its own would be about a slot the user never
     * asked about.
     */
    private _renderExplanation(day: EntityScheduleDay) {
        const selection = this._explainSelection;
        if (selection === null) {
            return html`
                <div class="field-help explain-hint">
                    ${this.localize("scheduling.entity_editor.explain_hint")}
                </div>
            `;
        }

        // Records are kept per local day, so the slot's own day says which.
        const dayKey = day.slots.find((slot) => slot.id === selection.slotId)?.dayKey ?? day.dayKey;
        const key = this._explanationKey(selection.laneKey, dayKey);
        // An appliance lane's optimizers are titled by the appliance in the
        // config editor, and the lane already knows its name -- so the
        // explanation can name them the same way without asking the backend
        // for the config it would otherwise need.
        const lane = this.lanes.find((entry) => entry.key === selection.laneKey);
        return html`
            <div class="panel">
                <scheduling-explanation-panel
                    .hass=${this.hass}
                    .localize=${this.localize}
                    .applianceName=${lane?.appliance?.name ?? null}
                    .payload=${this._explanations.get(key) ?? null}
                    .slotId=${selection.slotId}
                    .loading=${!this._explanations.has(key) && !this._explanationFailures.has(key)}
                    .failed=${this._explanationFailures.has(key)}
                    .locale=${this.locale}
                    .timeZone=${this.timeZone}
                ></scheduling-explanation-panel>
            </div>
        `;
    }

    /**
     * The panel under the band: placement on top, the action's details below
     * a divider, in the same layout for every kind of device.
     */
    private _renderEditPanel(
        day: EntityScheduleDay,
        view: EntityScheduleRange,
        lane: EntityScheduleLane,
        bandLane: EntityDayBandLane | null,
    ) {
        const editing = this._editing;
        const automation = this._selectedAutomation;
        return html`
            <div class="panel edit-panel">
                ${editing !== null
                    ? this._renderManualPanel(day, lane, editing)
                    : automation !== null && bandLane !== null
                        ? this._renderAutomationPanel(bandLane, automation)
                        : this._renderNothingPanel(day, view, lane)}
            </div>
        `;
    }

    private _renderManualPanel(day: EntityScheduleDay, lane: EntityScheduleLane, editing: EntityScheduleEditSession) {
        const boundaries = buildEntityScheduleBoundaryOptions({
            day,
            includeMs: [editing.startMs, editing.endMs],
        });
        const ends = boundaries.filter((ms) => ms > editing.startMs);
        const picks = this._endPicks(day, lane, editing.startMs, ends);
        const replaced = selectEntityScheduleReplacedRuns({
            slots: this._baselineSlots,
            baselineBlocks: this._baselineBlocks(lane),
            target: lane.target,
            draft: this._draft,
            range: editing,
        });
        return html`
            <div class="placement">
                <div class="placement-row">
                    <span class="authorship-badge user">${this.localize("scheduling.entity_editor.manual")}</span>
                    <label class="field">
                        <span class="field-label">${this.localize("scheduling.entity_editor.from")}</span>
                        <!--
                            Every boundary but the last is offered, not only the
                            ones before the current end: moving a block later is
                            a start-first gesture, and the end follows it.
                        -->
                        <select class="select-input" data-from @change=${this._handleStartChange}>
                            ${boundaries.slice(0, -1).map((ms) => html`
                                <option value=${ms} ?selected=${ms === editing.startMs}>
                                    ${this._formatBoundary(ms)}
                                </option>
                            `)}
                        </select>
                    </label>
                    <label class="field">
                        <span class="field-label">${this.localize("scheduling.entity_editor.to")}</span>
                        <select class="select-input" data-to @change=${this._handleEndChange}>
                            ${ends.map((ms) => html`
                                <option value=${ms} ?selected=${ms === editing.endMs}>
                                    ${this._formatBoundary(ms)}
                                </option>
                            `)}
                        </select>
                    </label>
                    <span class="placement-duration">${formatLaneRunHours(editing.endMs - editing.startMs, this.locale)}</span>
                    <button class="pill-button delete placement-actions" type="button" data-delete @click=${this._handleDelete}>
                        ${this.localize("scheduling.entity_editor.remove_block")}
                    </button>
                </div>
                ${picks.length === 0 ? nothing : html`
                    <div class="picks">
                        <span class="field-label">${this.localize("scheduling.entity_editor.end")}</span>
                        ${picks.map(({ key, ms }) => html`
                            <button
                                class="pick"
                                type="button"
                                data-pick=${key}
                                aria-pressed=${ms === editing.endMs ? "true" : "false"}
                                @click=${() => this._updateEditSession({ ...editing, endMs: ms })}
                            >${this.localize(`scheduling.entity_editor.pick.${key}`)}</button>
                        `)}
                    </div>
                `}
                ${replaced.length === 0 ? nothing : html`
                    <div class="replaces">
                        <span class="field-label">${this.localize("scheduling.entity_editor.replaces")}</span>
                        ${replaced.map((run) => html`
                            <span class="replaced-run">
                                <span class="replaced-action">${this._renderActionChip(lane, run.action)}</span>
                                <span>${this.localize(run.authorship === "user"
                                    ? "scheduling.authorship.set_by_user"
                                    : "scheduling.authorship.set_by_automation")}</span>
                                <span>${this._formatBoundary(run.startMs)}–${this._formatBoundary(run.endMs)}</span>
                            </span>
                        `)}
                    </div>
                `}
            </div>
            <div class="details">
                <scheduling-entity-action-editor
                    .localize=${this.localize}
                    .target=${lane.target}
                    .appliance=${lane.appliance}
                    .action=${editing.action}
                    .sessionKey=${this._editSessionId}
                    .authorship=${"user"}
                    @entity-action-change=${this._handleActionChange}
                ></scheduling-entity-action-editor>
            </div>
        `;
    }

    private _renderAutomationPanel(lane: EntityDayBandLane, block: EntityScheduleBlock) {
        return html`
            <div class="placement">
                <div class="placement-row read-only">
                    <span class="authorship-badge automation">${this.localize("scheduling.entity_editor.automation")}</span>
                    <span class="placement-range">
                        ${this._formatBoundary(block.startMs)} – ${this._formatBoundary(block.endMs)}
                    </span>
                    <span class="placement-duration">${formatLaneRunHours(block.endMs - block.startMs, this.locale)}</span>
                    <button class="pill-button override placement-actions" type="button" data-override @click=${this._handleOverride}>
                        ${this.localize("scheduling.entity_editor.override_range")}
                    </button>
                </div>
            </div>
            <div class="details">
                <div class="details-title">${resolveLaneRunPresentation(lane, block, this.localize).label}</div>
                <div class="field-help">${this.localize("scheduling.entity_editor.automation_hint")}</div>
            </div>
        `;
    }

    /**
     * Nothing selected: a manual block from the window's left edge, one press
     * away, and how to put one anywhere else. The edge is snapped down to its
     * slot and held at the first slot that can still be written, so at now it
     * is the slot running now.
     */
    private _renderNothingPanel(day: EntityScheduleDay, view: EntityScheduleRange, lane: EntityScheduleLane) {
        const stepMs = day.slotMinutes * 60_000;
        const fromMs = Math.max(
            day.startMs + Math.floor((view.startMs - day.startMs) / stepMs) * stepMs,
            day.editableFromMs,
        );
        const ends = buildEntityScheduleBoundaryOptions({ day }).filter((ms) => ms > fromMs);
        const picks = this._endPicks(day, lane, fromMs, ends).filter(({ key }) => key !== "next_change");
        return html`
            <div class="placement">
                <div class="placement-row read-only">
                    ${this.lanes.length > 1 ? html`<span class="lane-name">${lane.name}</span>` : nothing}
                    ${picks.length === 0 ? nothing : html`
                        <div class="picks">
                            <span class="field-label">${this.localize("scheduling.entity_editor.override_from_here")}</span>
                            ${picks.map(({ key, ms }) => html`
                                <button
                                    class="pick"
                                    type="button"
                                    data-start-pick=${key}
                                    @click=${() => this._beginEdit(null, fromMs, ms, this._newBlockAction(lane))}
                                >${this.localize(`scheduling.entity_editor.pick.${key === "end_of_day" ? "until_end_of_day" : key}`)}</button>
                            `)}
                        </div>
                    `}
                </div>
            </div>
            <div class="details">
                <div class="field-help">${this.localize("scheduling.entity_editor.paint_hint")}</div>
            </div>
        `;
    }

    /**
     * Where a manual block starting at `startMs` could end, as the node
     * detail's override offers it: an hour, three, the end of the local day it
     * starts on (its midnight, or the horizon's end when that comes first), and
     * the next slot where the saved plan changes -- each only when it is one of
     * the ends the pickers offer.
     */
    private _endPicks(
        day: EntityScheduleDay,
        lane: EntityScheduleLane,
        startMs: number,
        ends: readonly number[],
    ): { key: EndPick; ms: number }[] {
        const daySlots = day.slots.filter((slot) => slot.startMs >= startMs);
        const startAction = daySlots[0] === undefined ? null : readEntityScheduleAction(daySlots[0], lane.target);
        const nextChange = daySlots.slice(1).find((slot) => !areEntityScheduleActionsEqual(
            readEntityScheduleAction(slot, lane.target),
            startAction,
        ))?.startMs;
        const candidates: [EndPick, number | undefined][] = [
            ["plus_1h", startMs + HOUR_MS],
            ["plus_3h", startMs + 3 * HOUR_MS],
            ["end_of_day", Math.min(getScheduleNextLocalDayStartMs(startMs, this.timeZone), ends[ends.length - 1] ?? startMs)],
            ["next_change", nextChange],
        ];
        return candidates
            .filter((candidate): candidate is [EndPick, number] => candidate[1] !== undefined && ends.includes(candidate[1]))
            .map(([key, ms]) => ({ key, ms }));
    }

    /** What the band's marks mean, in the footer left of Cancel and Save. */
    private _renderLegend() {
        return html`
            <div class="legend" slot="secondaryAction">
                ${(["user", "automation", "freed"] as const).map((kind) => html`
                    <span class="legend-item">
                        <span class=${`legend-swatch ${kind}`}></span>
                        ${this.localize(`scheduling.entity_editor.legend_${kind}`)}
                    </span>
                `)}
            </div>
        `;
    }

    private _renderActionChip(lane: EntityScheduleLane, action: EntityScheduleAction) {
        if (isInverterScheduleTarget(lane.target) && action !== null && isScheduleInverterAction(action)) {
            return html`
                <scheduling-action-chip
                    .action=${action}
                    .localize=${this.localize}
                    size="compact"
                ></scheduling-action-chip>
            `;
        }

        const applianceAction = action === null || isScheduleInverterAction(action)
            ? null
            : action as ScheduleApplianceAction;
        const appliance = lane.appliance === null
            ? { id: "unknown", name: lane.name, kind: "generic", icon: lane.icon }
            : describeScheduleAppliance(lane.appliance);
        return html`
            <scheduling-appliance-chip
                .appliance=${appliance}
                .action=${applianceAction}
                .localize=${this.localize}
                .titleText=${getScheduleApplianceActionPresentation({
                    appliance,
                    action: applianceAction,
                    localize: this.localize,
                }).label}
                size="compact"
            ></scheduling-appliance-chip>
        `;
    }

    private get _selectedLane(): EntityScheduleLane | null {
        return this.lanes.find((lane) => lane.key === this._selectedLaneKey) ?? null;
    }

    /** The selected lane's pending edits. */
    private get _draft(): EntityScheduleDraft {
        return this._selectedLaneKey === null
            ? {}
            : this._drafts[this._selectedLaneKey] ?? {};
    }

    private _setDraft(draft: EntityScheduleDraft): void {
        const laneKey = this._selectedLaneKey;
        if (laneKey === null) {
            return;
        }

        // The draft it was about is being changed, so the answer it gave is
        // no longer about anything on screen.
        this._elapsedDraftNotice = false;
        this._drafts = { ...this._drafts, [laneKey]: draft };
        this._blockSplits = this._pruneBlockSplits(this._blockSplits, laneKey, draft);
    }

    /**
     * Drop the lane's edges that no longer hold anything apart.
     *
     * An edge only does work where a run would otherwise close over it, so an
     * edge that is not strictly inside a merged run is inert -- and staying
     * inert is not the same as staying harmless. Removing a block leaves its
     * two edges behind, and the next block authored across that stretch would
     * be cut in two by them: the gap the user pressed, then the ghost of the
     * block they deleted.
     *
     * Merging the lane with no edges at all is what says which are still
     * load-bearing, so the rule needs no bookkeeping about which block put an
     * edge where. An edge between two touching runs that currently disagree is
     * inert too and goes -- if the user makes them agree, they do it in a
     * session, and committing it authors the edge again.
     */
    private _pruneBlockSplits(
        splits: EntityScheduleBlockSplits,
        laneKey: string,
        draft: EntityScheduleDraft,
    ): EntityScheduleBlockSplits {
        const stored = splits[laneKey];
        const lane = this.lanes.find((candidate) => candidate.key === laneKey);
        if (stored === undefined || stored.size === 0 || lane === undefined) {
            return splits;
        }

        const merged = buildEntityScheduleBlocks({
            slots: this._baselineSlots,
            target: lane.target,
            draft,
            nowMs: this.nowMs,
        });
        const kept = new Set(
            [...stored].filter(
                (ms) => merged.some((block) => block.startMs < ms && block.endMs > ms),
            ),
        );
        return kept.size === stored.size ? splits : { ...splits, [laneKey]: kept };
    }

    private _laneDrafts(): { target: EntityScheduleTarget; draft: EntityScheduleDraft }[] {
        return this.lanes.flatMap((lane) => {
            const draft = this._drafts[lane.key];
            return draft === undefined ? [] : [{ target: lane.target, draft }];
        });
    }

    private _seedFromSlots(): void {
        this._baselineSlots = [...this.slots];
        this._drafts = {};
        this._blockSplits = {};
        this._draftBeforeEdit = {};
        this._editing = null;
        this._selectedAutomation = null;
        this._lastActions = {};
        this._elapsedDraftNotice = false;
        // Every opening is an opening to edit: the dialog is reached by
        // pressing something the user means to change far more often than
        // something they mean to have explained.
        this._mode = "edit";
        this._explainSelection = null;
        // The store keeps answered records across openings and invalidates
        // them when the backend reports a data change. This opening starts with
        // a fresh view of those records.
        this._explanationGeneration++;
        this._explanations = new Map();
        this._explanationFailures = new Set();
        this._explanationsRequested = new Set();
        // No target means the opener pointed at no single lane -- a group row
        // standing for several appliances. Selecting one for them would arm an
        // editor on an appliance nobody pointed at, and since the roster sorts
        // the inverter first, that appliance would usually be the inverter. The
        // dialog stacks the whole day and asks which lane instead.
        this._selectedLaneKey = this.target;
        this._viewStartMs = null;
    }

    private _horizon(): EntityScheduleDay | null {
        const previous = this._horizonFor;
        if (previous && previous.slots === this._baselineSlots && previous.nowMs === this.nowMs
            && previous.slotMinutes === this.slotMinutes && previous.timeZone === this.timeZone) {
            return this._cachedHorizon;
        }
        this._horizonFor = {
            slots: this._baselineSlots, nowMs: this.nowMs, slotMinutes: this.slotMinutes, timeZone: this.timeZone,
        };
        const horizon = this._cachedHorizon = buildEntityScheduleHorizon({
            slots: this._baselineSlots,
            slotMinutes: this.slotMinutes,
            nowMs: this.nowMs,
        });
        this._horizonClock = horizon === null
            ? null
            : resolveScheduleSpanClock(horizon.startMs, horizon.endMs, this.timeZone);
        return horizon;
    }

    /**
     * The 24 hours on screen, or what is left of the horizon when that is less.
     *
     * Clamped here, on every read, rather than when the start was set: the
     * clock moves under a window parked at a later hour, and a window that
     * started at now keeps starting at now.
     */
    private _window(horizon: EntityScheduleDay): EntityScheduleRange {
        const startMs = this._clampViewStart(horizon, this._viewStartMs ?? this.nowMs);
        return { startMs, endMs: Math.min(startMs + WINDOW_MS, horizon.endMs) };
    }

    /** Between now and the last start that still shows a whole window. */
    private _clampViewStart(horizon: EntityScheduleDay, startMs: number): number {
        return Math.max(Math.min(startMs, horizon.endMs - WINDOW_MS), this.nowMs);
    }

    /** Move the window; null, or anything at or before now, means now. */
    private _setViewStart(startMs: number | null): void {
        const horizon = this._horizon();
        if (horizon === null) {
            return;
        }

        const clampedMs = startMs === null ? this.nowMs : this._clampViewStart(horizon, startMs);
        this._viewStartMs = clampedMs <= this.nowMs ? null : clampedMs;
    }

    /**
     * Keep Explain mode on the window as it moves, by a pan or by the clock:
     * a pressed slot that has left it is let go of, and a day the window has
     * reached is asked about -- once per change of days, not per move.
     */
    private _followWindowInExplain(): void {
        if (!this.open || this._mode !== "explain") {
            return;
        }

        const horizon = this._horizon();
        if (horizon === null) {
            return;
        }

        const view = this._window(horizon);
        const selection = this._explainSelection;
        if (selection !== null) {
            const slot = horizon.slots.find((candidate) => candidate.id === selection.slotId);
            if (slot === undefined || slot.endMs <= view.startMs || slot.startMs >= view.endMs) {
                this._explainSelection = null;
            }
        }

        const dayKeys = this._windowDayKeys(view).join(",");
        if (dayKeys !== this._explainedDayKeys) {
            this._explainedDayKeys = dayKeys;
            this._requestExplanations();
        }
    }

    private _dayBlocks(day: EntityScheduleDay, lane: EntityScheduleLane): EntityScheduleBlock[] {
        const draft = this._drafts[lane.key] ?? EMPTY_DRAFT;
        const splits = this._blockSplits[lane.key] ?? EMPTY_BLOCK_SPLITS;
        const previous = this._blocksFor.get(lane.key);
        if (previous && previous.day === day && previous.slots === this._baselineSlots
            && previous.target === lane.target && previous.draft === draft
            && previous.splits === splits && previous.editing === this._editing
            && previous.nowMs === this.nowMs) return previous.blocks;
        const blocks = selectEntityScheduleDayBlocks(
            buildEntityScheduleBlocks({
                slots: this._baselineSlots,
                target: lane.target,
                draft,
                nowMs: this.nowMs,
                splitAtMs: this._laneBlockSplits(lane.key),
            }),
            day,
        );
        this._blocksFor.set(lane.key, {
            day, slots: this._baselineSlots, target: lane.target, draft, splits,
            editing: this._editing, nowMs: this.nowMs, blocks,
        });
        return blocks;
    }

    private _baselineBlocks(lane: EntityScheduleLane): EntityScheduleBlock[] {
        const previous = this._baselineBlocksFor.get(lane.key);
        if (previous && previous.slots === this._baselineSlots && previous.target === lane.target
            && previous.nowMs === this.nowMs) return previous.blocks;
        const blocks = buildEntityScheduleBlocks({
            slots: this._baselineSlots,
            target: lane.target,
            draft: EMPTY_DRAFT,
            nowMs: this.nowMs,
        });
        this._baselineBlocksFor.set(lane.key, { slots: this._baselineSlots, target: lane.target, nowMs: this.nowMs, blocks });
        return blocks;
    }

    private _buildBandLanes(day: EntityScheduleDay): EntityDayBandLane[] {
        const previous = this._bandLanesFor;
        if (previous && previous.day === day && previous.lanes === this.lanes
            && previous.slots === this._baselineSlots && previous.drafts === this._drafts
            && previous.splits === this._blockSplits && previous.editing === this._editing
            && previous.nowMs === this.nowMs && previous.projectionIndex === this.projectionIndex) {
            return previous.result;
        }
        const result = buildEntityDayBandLanes({
            lanes: this.lanes,
            slots: this._baselineSlots,
            day,
            drafts: this._drafts,
            splits: this._allBlockSplits(),
            nowMs: this.nowMs,
            projectionIndex: this.projectionIndex,
        });
        this._bandLanesFor = {
            day, lanes: this.lanes, slots: this._baselineSlots, drafts: this._drafts,
            splits: this._blockSplits, editing: this._editing, nowMs: this.nowMs,
            projectionIndex: this.projectionIndex, result,
        };
        return result;
    }

    /**
     * The lane's authored edges, plus the open session's own two.
     *
     * The session contributes while it is open but is only recorded on commit:
     * a drag passes through every position between where it started and where
     * it was let go, and recording each of them would strew edges that later
     * split unrelated runs in half. A session that places nothing has no
     * block, so it contributes no edges.
     */
    private _laneBlockSplits(laneKey: string): ReadonlySet<number> {
        const stored = this._blockSplits[laneKey];
        if (this._editing === null || laneKey !== this._selectedLaneKey || !this._sessionPlaces(this._editing)) {
            return stored ?? EMPTY_BLOCK_SPLITS;
        }

        return new Set([...(stored ?? []), ...this._sessionEdges(this._editing)]);
    }

    /**
     * The edges an open session is authoring.
     *
     * A start the session had to raise is the now-line rather than a decision:
     * editing a block that is already running opens a session over the part
     * still ahead, and splitting there would cut the running block in half on
     * screen. It is the raising that says so, not the value: a block authored
     * at the slot running now is a decision like any other.
     */
    private _sessionEdges(session: EntityScheduleEditSession): number[] {
        const editableFromMs = this._horizon()?.editableFromMs ?? Number.NEGATIVE_INFINITY;
        return session.startClamped && session.startMs <= editableFromMs
            ? [session.endMs]
            : [session.startMs, session.endMs];
    }

    /** The same, for every lane at once, as the band lane builder wants it. */
    private _allBlockSplits(): EntityScheduleBlockSplits {
        const splits: Record<string, ReadonlySet<number>> = {};
        for (const lane of this.lanes) {
            const laneSplits = this._laneBlockSplits(lane.key);
            if (laneSplits.size > 0) {
                splits[lane.key] = laneSplits;
            }
        }

        return splits;
    }

    /**
     * Move the editor to another entity.
     *
     * The open session ends here rather than travelling: it holds a range and an
     * action that only mean anything for the lane they were opened on. What it
     * already wrote stays in that lane's draft, which is what Save reads.
     */
    private _selectLane(laneKey: string | null): void {
        if (this._selectedLaneKey === laneKey) {
            return;
        }

        this._clearSelection();
        this._selectedLaneKey = laneKey;
    }

    /**
     * Switch between authoring the day and accounting for it.
     *
     * The open edit session ends on the way out: it holds a range that only
     * means anything while there are handles to drag it by. What it wrote is
     * already in the draft, which survives the trip in both directions -- and
     * so does the lane selection, so coming back from Explain lands on the lane
     * that was being edited rather than on nothing.
     */
    private _setMode(mode: EntityDayEditorMode): void {
        if (this._mode === mode) {
            return;
        }

        this._clearSelection();
        this._explainSelection = null;
        this._mode = mode;
        if (mode === "explain") {
            this._requestExplanations();
        }
    }

    private _handleBandSlotSelect(event: CustomEvent<EntityDayBandSlotSelectDetail>): void {
        event.stopPropagation();
        this._explainSelection = {
            laneKey: event.detail.laneKey,
            slotId: event.detail.slotId,
        };
    }

    private _explanationKey(laneKey: string, dayKey: string): string {
        return `${laneKey}|${dayKey}`;
    }

    /**
     * Ask for every lane's record for each day the window shows.
     *
     * Up front rather than on the first press, because the lane list itself is
     * an answer: a lane no optimizer touched has nothing to explain and does
     * not belong in this mode, and that cannot be known without the record.
     * One request per lane per day, ever -- the set outlives both the mode and
     * the window, so sliding back and forth is silent.
     */
    private _requestExplanations(): void {
        for (const dayKey of this._windowDayKeys()) {
            for (const lane of this.lanes) {
                void this._loadExplanation(lane.key, dayKey);
            }
        }
    }

    /** The local days the window's slots fall on: the days records are kept by. */
    private _windowDayKeys(view?: EntityScheduleRange): string[] {
        const horizon = this._horizon();
        if (horizon === null) {
            return [];
        }

        const { startMs, endMs } = view ?? this._window(horizon);
        return [...new Set(horizon.slots
            .filter((slot) => slot.endMs > startMs && slot.startMs < endMs)
            .map((slot) => slot.dayKey))];
    }

    private async _loadExplanation(laneKey: string, dayKey: string): Promise<void> {
        const hass = this.hass;
        const key = this._explanationKey(laneKey, dayKey);
        if (!hass || this._explanationsRequested.has(key)) {
            return;
        }

        this._explanationsRequested.add(key);
        const generation = this._explanationGeneration;
        try {
            const payload = await getSharedHelmanStore(hass).getScheduleExplanation(laneKey, dayKey);
            if (generation !== this._explanationGeneration) return;
            // A null answer is not a failure: it means nothing was recorded for
            // this lane on this date, which is exactly what drops the lane out
            // of Explain mode.
            this._explanations = new Map(this._explanations).set(key, payload ?? null);
        } catch {
            if (generation !== this._explanationGeneration) return;
            // Asked and unanswered, which is not the same as "nothing recorded"
            // -- the panel says so rather than reading as an empty day.
            this._explanationsRequested.delete(key);
            this._explanationFailures = new Set(this._explanationFailures).add(key);
        }
    }

    /**
     * The lanes worth showing in Explain mode: the ones an optimizer touched.
     *
     * A lane whose record has arrived and holds no account of the day is
     * dropped -- there is nothing to press it for. A lane still waiting for its
     * record stays, so lanes settle into place rather than appearing and then
     * vanishing under the pointer.
     */
    private _explainableBandLanes(
        lanes: readonly EntityDayBandLane[],
        view: EntityScheduleRange,
    ): EntityDayBandLane[] {
        const dayKeys = this._windowDayKeys(view);
        return lanes.filter((lane) => dayKeys.some((dayKey) => {
            const key = this._explanationKey(lane.key, dayKey);
            const model = this._explanationModels.get(key);
            if (model === undefined) {
                return !this._explanations.has(key);
            }

            return model.columns.some((column) => column.cells.some((cell) => cell.present));
        }));
    }

    /** The band asks for the window somewhere else; snapped to a slot unless that is now. */
    private _handleBandWindowChange(event: CustomEvent<EntityDayBandWindowChangeDetail>): void {
        event.stopPropagation();
        const horizon = this._horizon();
        if (horizon === null) {
            return;
        }

        const stepMs = horizon.slotMinutes * 60_000;
        this._setViewStart(
            horizon.startMs + Math.round((event.detail.startMs - horizon.startMs) / stepMs) * stepMs,
        );
    }

    /**
     * Remember the draft at the press that starts a gesture, in case a second
     * finger turns it into a pan. Kept until every pointer of that gesture is
     * up, so a cancel can only ever put back the gesture it belongs to.
     */
    private readonly _handleBandPressCapture = (event: PointerEvent): void => {
        if (this._pressSnapshot === null) {
            this._pressSnapshot = { ...this.snapshotDraftState(), selectedAutomation: this._selectedAutomation };
        }
        if (this._bandPointers.size === 0) {
            window.addEventListener("pointerup", this._handleBandPressEnd, true);
            window.addEventListener("pointercancel", this._handleBandPressEnd, true);
        }
        this._bandPointers.add(event.pointerId);
    };

    /** The last pointer of the gesture is up: its snapshot goes with it. */
    private readonly _handleBandPressEnd = (event: PointerEvent): void => {
        if (!this._bandPointers.delete(event.pointerId) || this._bandPointers.size > 0) {
            return;
        }

        this._endBandGesture();
    };

    private _endBandGesture(): void {
        this._bandPointers.clear();
        this._pressSnapshot = null;
        window.removeEventListener("pointerup", this._handleBandPressEnd, true);
        window.removeEventListener("pointercancel", this._handleBandPressEnd, true);
    }

    /** A second finger turned the press into a pan: whatever it had started is undone. */
    private _handleBandGestureCancel(event: Event): void {
        event.stopPropagation();
        const snapshot = this._pressSnapshot;
        if (snapshot === null) {
            return;
        }

        // Used once: the pan that follows belongs to the same gesture, but
        // nothing it does is to be undone.
        this._pressSnapshot = null;
        this._drafts = snapshot.drafts;
        this._blockSplits = snapshot.blockSplits;
        this._draftBeforeEdit = snapshot.draftBeforeEdit;
        this._splitsBeforeEdit = snapshot.splitsBeforeEdit;
        this._editing = snapshot.editing;
        this._selectedLaneKey = snapshot.selectedLaneKey;
        this._selectedAutomation = snapshot.selectedAutomation;
    }

    /**
     * A block was pressed: a manual one opens for placing, an automation run
     * is selected read only, since all it offers is to be overridden.
     */
    private _handleBandBlockSelect(event: CustomEvent<EntityDayBandBlockSelectDetail>): void {
        event.stopPropagation();
        this._selectLane(event.detail.laneKey);
        const day = this._horizon();
        const lane = this._selectedLane;
        if (day === null || lane === null) {
            return;
        }

        const block = this._dayBlocks(day, lane).find((candidate) => candidate.key === event.detail.blockKey);
        if (block === undefined || block.isPast) {
            return;
        }

        if (block.authorship === "automation") {
            this._clearSelection();
            this._selectedAutomation = block;
            return;
        }

        const editing = this._editing;
        if (editing === null || !this._sessionPlaces(editing)
            || block.startMs >= editing.endMs || block.endMs <= editing.startMs) {
            this._beginEdit(block, block.startMs, block.endMs, block.action, block.continuesBefore);
        }
    }

    /** The selected block was pressed again. */
    private _handleBandDeselect(event: CustomEvent<EntityDayBandDeselectDetail>): void {
        event.stopPropagation();
        this._clearSelection();
    }

    private _handleBandLaneSelect(event: CustomEvent<EntityDayBandLaneSelectDetail>): void {
        event.stopPropagation();
        this._selectLane(event.detail.laneKey);
    }

    /** The forecast rows are about the day, not about any one entity. */
    private _handleBandContextSelect(event: Event): void {
        event.stopPropagation();
        this._selectLane(null);
    }

    /** A drag on the band moves or resizes the block being edited. */
    private _handleBandRangeChange(event: CustomEvent<EntityDayBandRangeChangeDetail>): void {
        event.stopPropagation();
        const editing = this._editing;
        if (editing === null || event.detail.endMs <= event.detail.startMs) {
            return;
        }

        this._updateEditSession({
            ...editing,
            startMs: event.detail.startMs,
            endMs: event.detail.endMs,
        });
    }

    /**
     * A paint across the selected lane: its opening paint starts a new manual
     * block, every later one reshapes that block as the pointer moves.
     */
    private _handleBandRangePaint(event: CustomEvent<EntityDayBandRangePaintDetail>): void {
        event.stopPropagation();
        const { startMs, endMs, first } = event.detail;
        const editing = this._editing;
        const lane = this._selectedLane;
        if (lane === null) {
            return;
        }

        if (first || editing === null) {
            // Let go first: when the opening paint lies wholly in the past no
            // session begins, and the follow-ups must not reshape the old one.
            this._clearSelection();
            this._beginEdit(null, startMs, endMs, this._newBlockAction(lane));
            return;
        }

        this._updateEditSession({ ...editing, startMs, endMs });
    }

    /**
     * Anything outside the edit panel and the band lets go of the selection.
     * What the session already wrote into the draft stays there.
     */
    private _handleContentPointerDown(event: PointerEvent): void {
        if (this._editing === null && this._selectedAutomation === null) {
            return;
        }

        // The panel counts as inside: its buttons open sessions, and this
        // handler runs after theirs -- treating them as outside would close
        // the session they just opened.
        const keepsSelection = event.composedPath().some((node) => node instanceof HTMLElement && (
            node.classList.contains("edit-panel")
            || node.localName === "scheduling-entity-day-band"
        ));
        if (!keepsSelection) {
            this._clearSelection();
        }
    }

    private _handleBandGapSelect(event: CustomEvent<EntityDayBandGapSelectDetail>): void {
        event.stopPropagation();
        this._selectLane(event.detail.laneKey);
        const day = this._horizon();
        const lane = this._selectedLane;
        if (day !== null && lane !== null) {
            // The default hour is cut short by the end of the free stretch: a
            // new block must not be born overlapping the next one.
            this._beginEdit(
                null,
                event.detail.startMs,
                Math.min(this._resolveDefaultEndMs(day, event.detail.startMs), event.detail.limitMs),
                this._newBlockAction(lane),
            );
        }
    }

    /** Give the selected block's range back to the automation and let go of it. */
    private _handleDelete(): void {
        const editing = this._editing;
        const lane = this._selectedLane;
        if (editing === null || lane === null) {
            return;
        }

        // Back to the pre-edit draft minus the block: whatever the session did
        // to the range goes away with it.
        this._blockSplits = this._splitsBeforeEdit;
        this._setDraft(editing.origin === null
            ? { ...this._draftBeforeEdit }
            : freeEntityScheduleRange({
                slots: this._baselineSlots,
                target: lane.target,
                draft: this._draftBeforeEdit,
                range: editing.origin,
                nowMs: this.nowMs,
            }));
        this._editing = null;
        this._draftBeforeEdit = {};
    }

    /** Put a manual block with the run's own action over it, and select that. */
    private _handleOverride(): void {
        const block = this._selectedAutomation;
        if (block !== null) {
            this._beginEdit(null, block.startMs, block.endMs, block.action, block.continuesBefore);
        }
    }

    /**
     * Move the block's start, dragging the end with it when it would overtake
     * it, so the block keeps its length instead of collapsing -- as far as the
     * horizon's last boundary. Whatever it lands on is replaced, as a drag does.
     */
    private _handleStartChange(event: Event): void {
        const editing = this._editing;
        const day = this._horizon();
        if (editing === null || day === null) {
            return;
        }

        const boundaries = buildEntityScheduleBoundaryOptions({ day });
        const lastMs = boundaries[boundaries.length - 1] ?? day.endMs;
        const startMs = Number((event.currentTarget as HTMLSelectElement).value);
        const endMs = startMs < editing.endMs
            ? editing.endMs
            : Math.min(startMs + (editing.endMs - editing.startMs), lastMs);
        this._updateEditSession({ ...editing, startMs, endMs });
    }

    private _handleEndChange(event: Event): void {
        const editing = this._editing;
        if (editing === null) {
            return;
        }

        this._updateEditSession({
            ...editing,
            endMs: Number((event.currentTarget as HTMLSelectElement).value),
        });
    }

    private _handleActionChange(event: CustomEvent<EntityScheduleActionChangeDetail>): void {
        event.stopPropagation();
        const editing = this._editing;
        if (editing === null) {
            return;
        }

        const action = sanitizeEntityScheduleAction(event.detail.action);
        this._updateEditSession({ ...editing, action, valid: event.detail.valid });
        // Only an action the user chose seeds the next paint; selecting a
        // block or overriding a run does not.
        if (this._selectedLane !== null && event.detail.valid && !isEntityScheduleActionEmpty(action)) {
            this._lastActions = { ...this._lastActions, [this._selectedLane.key]: action };
        }
    }

    /**
     * Open a session over the part of a block the user may still change.
     *
     * A block that is already running starts in the past; the session begins at
     * the first editable slot instead, so the pickers have that start to offer
     * and the running part stays exactly as scheduled. The horizon already
     * cuts such a block at that slot, so a block that continues before it says
     * the same as a start that had to be raised.
     */
    private _beginEdit(
        origin: EntityScheduleRange | null,
        startMs: number,
        endMs: number,
        action: EntityScheduleAction,
        continuesBefore = false,
    ): void {
        const day = this._horizon();
        if (day === null) {
            return;
        }

        const editableStartMs = Math.max(startMs, day.editableFromMs);
        if (editableStartMs >= endMs) {
            return;
        }

        // Switching straight to another block ends the previous session rather
        // than dropping it, so the edges it authored are kept: the block the
        // user just placed must stay its own series once they move on.
        this._clearSelection();
        this._draftBeforeEdit = { ...this._draft };
        this._splitsBeforeEdit = this._blockSplits;
        this._editSessionId += 1;
        this._updateEditSession({
            origin: origin === null ? null : { startMs: editableStartMs, endMs: origin.endMs },
            startMs: editableStartMs,
            endMs,
            action: sanitizeEntityScheduleAction(action),
            valid: true,
            startClamped: editableStartMs > startMs || continuesBefore,
        });
    }

    /**
     * Rewrite the draft for the session's range, live.
     *
     * Every change replays from the pre-edit draft rather than patching the last
     * one, so dragging a block back and forth cannot leave a trail of slots
     * behind it, and a block it passed over comes back once it has moved on --
     * with the edges it had, which pruning an intermediate placement would
     * otherwise have worn away.
     * An action that is not one yet -- a target still being typed, or none --
     * places nothing: the range shows what it would be without the block.
     */
    private _updateEditSession(session: EntityScheduleEditSession): void {
        const lane = this._selectedLane;
        if (lane === null) {
            return;
        }

        this._editing = session;
        const places = this._sessionPlaces(session);
        this._blockSplits = places
            ? this._splitsOutside(this._splitsBeforeEdit, lane.key, session)
            : this._splitsBeforeEdit;
        this._setDraft(places
            ? placeEntityScheduleManualRange({
                slots: this._baselineSlots,
                target: lane.target,
                draft: this._draftBeforeEdit,
                previous: session.origin,
                range: session,
                action: session.action,
                nowMs: this.nowMs,
            })
            : session.origin === null
                ? { ...this._draftBeforeEdit }
                : freeEntityScheduleRange({
                    slots: this._baselineSlots,
                    target: lane.target,
                    draft: this._draftBeforeEdit,
                    range: session.origin,
                    nowMs: this.nowMs,
                }));
    }

    /**
     * The lane's edges with those strictly inside the range dropped.
     *
     * A placed block replaces what it covers, edges included: one left inside
     * it would cut it in two wherever it spans equal-action blocks. Only the
     * replay drops them -- the snapshot keeps them, so they come back once the
     * block moves off.
     */
    private _splitsOutside(
        splits: EntityScheduleBlockSplits,
        laneKey: string,
        range: EntityScheduleRange,
    ): EntityScheduleBlockSplits {
        const stored = splits[laneKey];
        if (stored === undefined || ![...stored].some((ms) => ms > range.startMs && ms < range.endMs)) {
            return splits;
        }

        return {
            ...splits,
            [laneKey]: new Set([...stored].filter((ms) => ms <= range.startMs || ms >= range.endMs)),
        };
    }

    /** Whether the session's action is one yet, so it places a block. */
    private _sessionPlaces(session: EntityScheduleEditSession): boolean {
        return session.valid && !isEntityScheduleActionEmpty(session.action);
    }

    /** Let go of whatever is selected; a manual block keeps what it placed. */
    private _clearSelection(): void {
        this._commitEditSession();
        this._selectedAutomation = null;
    }

    private _commitEditSession(): void {
        if (this._editing === null) {
            return;
        }

        // Where the block finally landed is what the user authored, so that is
        // what outlives the session. It stays for the life of the dialog: a
        // block created at 11:00 remains its own series after the session is
        // committed, and only rejoins its neighbour after Save and reopen.
        // Pruned on the way in, because a session can outlive its block: the
        // remove button on the block's row leaves the session open, so the
        // press that ends it is landing edges for a block that is already
        // gone. Whether they survive is the same question as always -- is
        // there still a run for them to hold apart. A session that places
        // nothing has no block, so it leaves no edges.
        if (this._selectedLaneKey !== null) {
            const laneKey = this._selectedLaneKey;
            this._blockSplits = this._pruneBlockSplits(
                {
                    ...this._blockSplits,
                    [laneKey]: new Set([
                        ...(this._blockSplits[laneKey] ?? []),
                        ...(this._sessionPlaces(this._editing) ? this._sessionEdges(this._editing) : []),
                    ]),
                },
                laneKey,
                this._drafts[laneKey] ?? {},
            );
        }

        this._editing = null;
        this._draftBeforeEdit = {};
    }

    private _resolveDefaultEndMs(day: EntityScheduleDay, startMs: number): number {
        const boundaries = buildEntityScheduleBoundaryOptions({ day }).filter((ms) => ms > startMs);
        const preferred = startMs + DEFAULT_NEW_BLOCK_DURATION_MS;
        return boundaries.find((ms) => ms >= preferred)
            ?? boundaries[boundaries.length - 1]
            ?? day.endMs;
    }

    /** What a new block starts with: the lane's last placed action, or its default. */
    private _newBlockAction(lane: EntityScheduleLane): EntityScheduleAction {
        return this._lastActions[lane.key] ?? this._buildDefaultAction(lane);
    }

    /**
     * What a freshly added block does before the user says otherwise: the
     * obvious "run it" for each lane, so adding a block and pressing Done is a
     * complete action rather than an empty one.
     */
    private _buildDefaultAction(lane: EntityScheduleLane): EntityScheduleAction {
        if (isInverterScheduleTarget(lane.target)) {
            return { kind: "charge_to_target_soc", targetSoc: 100 };
        }

        const appliance = lane.appliance;
        if (appliance?.kind === "ev_charger") {
            return { charge: true };
        }
        if (appliance !== null && appliance.supportsAuthoring && appliance.kind === "climate") {
            const modes: readonly string[] = appliance.metadata.scheduleCapabilities.modes;
            const mode = modes.find((candidate) => candidate !== "off");
            return mode === undefined ? null : { mode };
        }

        return { on: true };
    }

    /**
     * A boundary as the pickers and range labels say it: with its weekday when
     * the horizon runs past a midnight, since the same hour then occurs twice,
     * and the midnight closing its last day as 24:00.
     */
    private _formatBoundary(atMs: number): string {
        this._horizon();
        const clock = this._horizonClock;
        return clock === null
            ? formatScheduleTime(atMs, this.locale, this.timeZone)
            : formatScheduleSpanTime(atMs, clock, this.locale, this.timeZone);
    }

    private _isDirty(nowMs: number = this.nowMs): boolean {
        return areEntityScheduleLanesDirty(this._baselineSlots, this._laneDrafts(), nowMs);
    }

    private _canSave(nowMs: number = this.nowMs): boolean {
        return !this.busy
            && this._isDirty(nowMs)
            && (this._editing === null || this._editing.valid);
    }

    private _handleSave(): void {
        // The render clock, not the write clock: `nowMs` is sampled every 30s,
        // so for up to that long after a slot boundary it still reports the
        // elapsed slot as writable. Sending it takes the *whole* batch down --
        // the backend validates the request up front and rejects a patch that
        // starts before its own current slot -- so the day's edit is lost over
        // one slot that was never savable. Read the clock here instead, and
        // let the elapsed slot drop out the same way the UI will on its next
        // tick.
        const nowMs = Date.now();
        this._elapsedDraftNotice = false;
        if (!this._canSave(nowMs)) {
            // Enabled against the render clock, declined against this one: the
            // whole draft elapsed in the last tick.
            this._elapsedDraftNotice = this._canSave();
            return;
        }

        this._commitEditSession();
        // Every lane's draft in one batch: a slot two entities both changed has
        // to leave as a single patch, or one of the two edits is lost.
        const patches = buildEntityScheduleLanePatches({
            slots: this._baselineSlots,
            lanes: this._laneDrafts(),
            nowMs,
        });
        // Nothing writable left -- the drafted slots elapsed between the press
        // and here. Stay open rather than close as if the day had been saved;
        // Save disables itself as soon as the next tick re-reads the drafts.
        if (patches.length === 0) {
            this._elapsedDraftNotice = true;
            return;
        }

        this.dispatchEvent(new CustomEvent<EntityScheduleSaveDetail>("entity-schedule-save", {
            bubbles: true,
            composed: true,
            detail: { patches },
        }));
    }

    /**
     * Cancel and Save are the only ways out, and Cancel just closes.
     *
     * The draft lives and dies with the dialog, so leaving without saving
     * changes nothing -- which is what every other dialog does, and what makes
     * a confirmation prompt here pointless friction.
     */
    private _close = (): void => {
        this.open = false;
    };

    private _onClosed(event?: Event): void {
        event?.stopPropagation();
        if (!this.isConnected) return;
        this._history.closed();

        this.dispatchEvent(new CustomEvent("closed", { bubbles: true, composed: true }));
    }
}
