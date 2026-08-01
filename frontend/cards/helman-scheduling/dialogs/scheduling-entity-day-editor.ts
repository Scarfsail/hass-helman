import { LitElement, css, html } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../../hass-frontend/src/types";
import type { LocalizeFunction } from "../../localize/localize";
import "../components/scheduling-action-chip";
import "../components/scheduling-appliance-chip";
import "../components/scheduling-entity-day-band";
import "../components/scheduling-explanation-panel";
import "./scheduling-entity-action-editor";
import type {
    EntityDayBandBlockSelectDetail,
    EntityDayBandGapSelectDetail,
    EntityDayBandLane,
    EntityDayBandLaneSelectDetail,
    EntityDayBandRangeChangeDetail,
    EntityDayBandSlotSelectDetail,
} from "../components/scheduling-entity-day-band";
import type {
    EntityScheduleAction,
    EntityScheduleBlock,
    EntityScheduleDay,
    EntityScheduleDraft,
    EntityScheduleDrafts,
    EntityScheduleLane,
    EntityScheduleTarget,
} from "../model/entity-day-schedule-model";
import {
    areEntityScheduleLanesDirty,
    buildEntityScheduleBlocks,
    buildEntityScheduleBoundaryOptions,
    buildEntityScheduleDays,
    buildEntityScheduleLanePatches,
    getEmptyEntityScheduleAction,
    getEntityScheduleTargetKey,
    isEntityInverterAction,
    isEntityScheduleActionEmpty,
    resolveEntityScheduleRangeLimits,
    sanitizeEntityScheduleAction,
    selectEntityScheduleDayBlocks,
    selectEntityScheduleSlotsInRange,
} from "../model/entity-day-schedule-model";
import { buildEntityDayBandLanes } from "../model/entity-lane-source";
import {
    parseScheduleExplanation,
    type ScheduleExplanationModel,
} from "../model/schedule-explanation-model";
import {
    EMPTY_SCHEDULE_APPLIANCE_PROJECTION_INDEX,
    type ScheduleApplianceProjectionIndex,
} from "../model/schedule-appliance-projection";
import { getScheduleApplianceActionPresentation } from "../model/schedule-appliance-action-presentation";
import type { ScheduleApplianceMetadata } from "../model/schedule-appliance-metadata";
import { formatScheduleTime } from "../model/schedule-time";
import type { SlotForecastPoint } from "../model/slot-forecast-model";
import type { ScheduleApplianceAction, ScheduleSlot, ScheduleSlotPatch } from "../schedule-types";
import { schedulingSharedStyles } from "../styles/scheduling-shared-styles";
import type { EntityScheduleActionChangeDetail } from "./scheduling-entity-action-editor";

const DIALOG_HISTORY_STATE_KEY = "__helmanEntityScheduleDialogId";
const DEFAULT_NEW_BLOCK_DURATION_MS = 60 * 60 * 1000;
let nextDialogHistoryEntryId = 0;

/** What the dialog is for right now: authoring the day, or accounting for it. */
type EntityDayEditorMode = "edit" | "explain";

interface EntityScheduleEditSession {
    /** Slots the block held when the edit began, so moving it can free them. */
    originalSlotIds: string[];
    startMs: number;
    endMs: number;
    action: EntityScheduleAction;
    valid: boolean;
}

export interface EntityScheduleSaveDetail {
    patches: ScheduleSlotPatch[];
}

/**
 * The house's schedule, one day at a time, one entity at a time.
 *
 * Every controllable entity gets a track on a shared time axis, because when to
 * run one thing is a question about what everything else is doing. Exactly one
 * of them is selected: the block list and the action editor below are about that
 * lane alone, so the editing model stays the simple single-entity one and the
 * other lanes are read-only context until they are clicked.
 *
 * The whole day is drafted locally and written as a single batch on Save, so
 * moving three blocks around is one schedule write and one automation re-run
 * rather than three of each -- and edits to several entities still leave as one
 * write. Nothing is applied until Save, so Cancel is a plain close: there is
 * nothing to undo.
 *
 * **The same stack answers "why" as well as "what".** Explain mode keeps the
 * band and replaces everything under it: the lanes are split into the day's own
 * slots, pressing one names it, and the explanation for that slot is drawn
 * where the editor would be. It lives here rather than in a dialog of its own
 * because a dialog opened from inside this one does not present (#17), and
 * because the question is asked *of* the day on screen -- keeping the band
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

            .day-switcher {
                display: flex;
                align-items: center;
                gap: 6px;
                flex-wrap: wrap;
                /* Room kept clear for the mode switch in the corner above it,
                   which is out of the flow. */
                padding-right: 180px;
            }

            /* The corner of the dialog, over the day switcher's own row:
               choosing what the dialog is *for* is a different kind of choice
               from choosing which day it is about, and putting it in the row of
               day chips would read as one more chip. */
            .mode-switch {
                position: absolute;
                top: 4px;
                right: 0;
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

            .day-chips {
                display: flex;
                gap: 6px;
                flex-wrap: wrap;
            }

            .day-chip {
                padding: 4px 10px;
                border: 1px solid var(--divider-color);
                border-radius: 999px;
                background: var(--card-background-color);
                color: inherit;
                font: inherit;
                font-size: 0.8rem;
                cursor: pointer;
            }

            .day-chip.selected {
                border-color: color-mix(in srgb, var(--primary-color) 44%, var(--divider-color));
                background: color-mix(in srgb, var(--primary-color) 12%, var(--card-background-color));
                color: var(--primary-color);
            }

            .day-step {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 30px;
                height: 30px;
                padding: 0;
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

            .block-list {
                display: flex;
                flex-direction: column;
                gap: 4px;
            }

            .block-row {
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 0 4px;
                border: 1px solid transparent;
                border-radius: 8px;
            }

            .block-main {
                display: flex;
                flex: 1 1 auto;
                align-items: center;
                gap: 10px;
                min-width: 0;
                padding: 5px 4px;
                border: none;
                border-radius: 6px;
                background: none;
                color: inherit;
                font: inherit;
                text-align: start;
                cursor: pointer;
            }

            .block-main:disabled {
                cursor: default;
            }

            .block-row.editing {
                border-color: color-mix(in srgb, var(--primary-color) 44%, var(--divider-color));
                background: color-mix(in srgb, var(--primary-color) 8%, transparent);
            }

            /* Hover is mirrored between this row and its segment on the band, so
               pointing at either one says which run the other means. */
            .block-row.hovered:not(.editing) {
                background: var(--secondary-background-color);
            }

            .block-row.past {
                color: var(--secondary-text-color);
                opacity: 0.7;
            }

            .block-range {
                flex: 0 0 auto;
                min-width: 96px;
                font-size: 0.85rem;
                font-variant-numeric: tabular-nums;
            }

            .block-action {
                flex: 1 1 auto;
                min-width: 0;
            }

            .block-authorship {
                flex: 0 0 auto;
                color: var(--secondary-text-color);
                font-size: 0.74rem;
            }

            .block-buttons {
                display: flex;
                flex: 0 0 auto;
                gap: 4px;
            }

            .block-buttons .icon-button {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 4px;
                --mdc-icon-size: 18px;
            }

            .edit-panel {
                display: flex;
                flex-direction: column;
                gap: 12px;
            }

            .range-fields {
                display: flex;
                flex-wrap: wrap;
                gap: 10px;
            }

            .range-fields .field {
                flex: 1 1 140px;
                min-width: 0;
            }

            .edit-panel-buttons {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
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
    @property({ attribute: false }) public forecastPoints: ReadonlyMap<string, SlotForecastPoint> = new Map();
    /** Projected consumption and vehicle SoC, for the band's own figures. */
    @property({ attribute: false }) public projectionIndex: ScheduleApplianceProjectionIndex =
        EMPTY_SCHEDULE_APPLIANCE_PROJECTION_INDEX;
    @property({ type: String }) public entityName = "";
    @property({ type: String }) public entityIcon = "mdi:flash-outline";
    /** How the price is denominated, for the forecast rows' tooltips. */
    @property({ type: String }) public priceUnit: string | null = null;
    @property({ type: String }) public currentDayKey: string | null = null;
    /**
     * The day to open on, when the host is already looking at one.
     *
     * A host showing tomorrow has answered the question this dialog would
     * otherwise guess at, and guessing over the answer lands the user on today
     * after they pressed something on tomorrow. Unset -- or naming a day the
     * schedule does not reach -- leaves the choice to the usual heuristic.
     */
    @property({ type: String }) public initialDayKey: string | null = null;
    @property({ type: String }) public locale = "cs";
    @property({ type: String }) public timeZone = "UTC";
    @property({ type: Number }) public nowMs = Date.now();
    @property({ type: Boolean }) public open = false;
    @property({ type: Boolean }) public busy = false;
    /** The schedule changed under the draft; Save will overwrite what arrived. */
    @property({ type: Boolean }) public scheduleChanged = false;

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
    /** The lane being edited, or null when the user clicked away from all of them. */
    @state() private _selectedLaneKey: string | null = null;
    @state() private _dayIndex = 0;
    @state() private _editing: EntityScheduleEditSession | null = null;
    /** The block the pointer is over, in either the list or the band. */
    @state() private _hoveredBlockKey: string | null = null;
    @state() private _mode: EntityDayEditorMode = "edit";
    /** The slot Explain mode is accounting for, and the lane it belongs to. */
    @state() private _explainSelection: { laneKey: string; slotId: string } | null = null;
    /**
     * The condition record per lane and day, raw as the backend served it.
     *
     * Fetched here rather than by the host: both hosts of this dialog would
     * otherwise need the same websocket wiring for a mode that only exists
     * inside it. A record is a whole day of per-slot condition trees for one
     * lane, so they are asked for once per lane per day and kept for as long as
     * the dialog is open.
     */
    @state() private _explanations: ReadonlyMap<string, unknown> = new Map();
    /** Lanes whose record could not be fetched, which is not the same as none. */
    @state() private _explanationFailures: ReadonlySet<string> = new Set();
    /** The parsed form of `_explanations`, rebuilt only when that map changes. */
    private _explanationModels: ReadonlyMap<string, ScheduleExplanationModel> = new Map();
    /**
     * Lanes already asked about, so re-entering Explain mode does not refetch.
     * Reset per opening along with the records themselves.
     */
    private _explanationsRequested = new Set<string>();

    private _draftBeforeEdit: EntityScheduleDraft = {};
    /** Bumped per edit session, so the action editor knows a new one began. */
    private _editSessionId = 0;
    private _historyEntryActive = false;
    private _historyEntryId: number | null = null;
    private _ignoreNextPopstate = false;
    private readonly _handlePopState = (event: PopStateEvent): void => {
        if (!this._historyEntryActive) {
            return;
        }

        if (this._ignoreNextPopstate) {
            this._ignoreNextPopstate = false;
            return;
        }

        if (this._isCurrentHistoryEntry(event.state)) {
            return;
        }

        this._clearHistoryEntry();
        this._close();
    };

    connectedCallback(): void {
        super.connectedCallback();
        if (typeof window !== "undefined") {
            window.addEventListener("popstate", this._handlePopState);
        }
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        if (typeof window !== "undefined") {
            window.removeEventListener("popstate", this._handlePopState);
        }
        this._clearHistoryEntry();
        this._ignoreNextPopstate = false;
    }

    willUpdate(changedProperties: Map<string, unknown>): void {
        super.willUpdate(changedProperties);
        // Seed once per opening: later slot updates are the refresh case, which
        // the stale banner reports instead of applying.
        if (this.open && (changedProperties.has("open") || changedProperties.has("target"))) {
            this._seedFromSlots();
        }

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
        if (this.open && !this._historyEntryActive && changedProperties.has("open")) {
            this._pushHistoryEntry();
        }
    }

    render() {
        // Days and per-lane blocks are each derived from the whole slot array,
        // so they are built once here and passed down rather than recomputed by
        // every renderer that needs them -- during a drag this runs per frame.
        const days = this._days();
        const day = this._selectedDay(days);
        if (this._lanes.length === 0 || day === null) {
            return nothing;
        }

        const explaining = this._mode === "explain";
        const bandLanes = explaining
            ? this._explainableBandLanes(this._buildBandLanes(day), day)
            : this._buildBandLanes(day);
        const selectedLane = this._selectedLane;
        const blocks = bandLanes.find((lane) => lane.key === selectedLane?.key)?.blocks ?? [];
        const editingBlock = this._resolveEditingBlock(blocks);
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
                    Pressing anything that is not the edit panel, the block list
                    or the band ends the edit session. The block keeps whatever
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
                    ${this._renderModeSwitch()}
                    ${this._renderDaySwitcher(day, days)}
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
                        .lanes=${bandLanes}
                        .selectedLaneKey=${explaining ? null : this._selectedLaneKey}
                        .laneLabels=${"track"}
                        .forecastPoints=${this.forecastPoints}
                        .priceUnit=${this.priceUnit}
                        .nowMs=${this.nowMs}
                        .locale=${this.locale}
                        .timeZone=${this.timeZone}
                        .readonly=${explaining}
                        .slotGrid=${true}
                        .slotPicks=${explaining}
                        .selectedSlot=${this._explainSelection}
                        .editingRange=${this._editing === null || explaining ? null : {
                            startMs: this._editing.startMs,
                            endMs: this._editing.endMs,
                        }}
                        .hoveredBlockKey=${explaining ? null : this._hoveredBlockKey}
                        @entity-day-band-block-hover=${this._handleBandBlockHover}
                        @entity-day-band-block-select=${this._handleBandBlockSelect}
                        @entity-day-band-lane-select=${this._handleBandLaneSelect}
                        @entity-day-band-context-select=${this._handleBandContextSelect}
                        @entity-day-band-gap-select=${this._handleBandGapSelect}
                        @entity-day-band-range-change=${this._handleBandRangeChange}
                        @entity-day-band-slot-select=${this._handleBandSlotSelect}
                    ></scheduling-entity-day-band>

                    ${explaining ? this._renderExplanation(day) : selectedLane === null ? html`
                        <div class="field-help select-hint">
                            ${this.localize("scheduling.entity_editor.select_entity")}
                        </div>
                    ` : html`
                        ${this._renderBlockList(day, selectedLane, blocks, editingBlock?.key ?? null)}
                        ${this._renderEditPanel(day, selectedLane, blocks, editingBlock)}
                    `}
                </div>

                <ha-dialog-footer slot="footer">
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

    private _renderDaySwitcher(day: EntityScheduleDay, days: readonly EntityScheduleDay[]) {
        return html`
            <div class="day-switcher">
                <button
                    class="icon-button day-step"
                    type="button"
                    ?disabled=${this._dayIndex <= 0}
                    aria-label=${this.localize("scheduling.entity_editor.previous_day")}
                    @click=${() => this._selectDayIndex(this._dayIndex - 1)}
                >
                    <ha-icon icon="mdi:chevron-left"></ha-icon>
                </button>
                <div class="day-chips">
                    ${days.map((candidate, index) => html`
                        <button
                            class=${`day-chip${candidate.dayKey === day.dayKey ? " selected" : ""}`}
                            type="button"
                            @click=${() => this._selectDayIndex(index)}
                        >
                            ${candidate.label}
                        </button>
                    `)}
                </div>
                <button
                    class="icon-button day-step"
                    type="button"
                    ?disabled=${this._dayIndex >= days.length - 1}
                    aria-label=${this.localize("scheduling.entity_editor.next_day")}
                    @click=${() => this._selectDayIndex(this._dayIndex + 1)}
                >
                    <ha-icon icon="mdi:chevron-right"></ha-icon>
                </button>
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

        const key = this._explanationKey(selection.laneKey, day.dayKey);
        return html`
            <div class="panel">
                <scheduling-explanation-panel
                    .localize=${this.localize}
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

    private _renderBlockList(
        day: EntityScheduleDay,
        lane: EntityScheduleLane,
        blocks: readonly EntityScheduleBlock[],
        editingBlockKey: string | null,
    ) {
        return html`
            <div class="block-list">
                <div class="field-label">
                    ${this.localize("scheduling.entity_editor.blocks")} · ${lane.name}
                </div>
                ${blocks.length === 0 ? html`
                    <div class="field-help">${this.localize("scheduling.entity_editor.no_blocks")}</div>
                ` : blocks.map((block) => this._renderBlockRow(day, lane, block, editingBlockKey))}
                <div>
                    <button
                        class="link-button"
                        type="button"
                        ?disabled=${this._findFreeStartMs(day, blocks) === null}
                        @click=${() => this._handleAddBlock(day, lane)}
                    >
                        ${this.localize("scheduling.entity_editor.add_block")}
                    </button>
                </div>
            </div>
        `;
    }

    private _renderBlockRow(
        day: EntityScheduleDay,
        lane: EntityScheduleLane,
        block: EntityScheduleBlock,
        editingBlockKey: string | null,
    ) {
        const editing = editingBlockKey === block.key;
        const classes = [
            "block-row",
            editing ? "editing" : "",
            block.isPast ? "past" : "",
            this._hoveredBlockKey === block.key ? "hovered" : "",
        ].filter((value) => value.length > 0).join(" ");
        // The row itself selects the block -- a pencil next to something that is
        // already one click away is a button that only says "yes, really".
        // Remove stays its own button because it is the destructive one.
        return html`
            <div
                class=${classes}
                @mouseenter=${() => this._setHoveredBlock(block.key)}
                @mouseleave=${() => this._setHoveredBlock(null)}
            >
                <button
                    class="block-main"
                    type="button"
                    ?disabled=${block.isPast}
                    aria-pressed=${editing}
                    @click=${() => this._handleEditBlock(block)}
                >
                    <span class="block-range">${this._formatBlockRange(day, block)}</span>
                    <span class="block-action">${this._renderActionChip(lane, block.action)}</span>
                    <span class="block-authorship">${this._authorshipLabel(block)}</span>
                </button>
                <span class="block-buttons">
                    ${block.isPast ? nothing : html`
                        <button
                            class="icon-button"
                            type="button"
                            aria-label=${this.localize("scheduling.entity_editor.remove_block")}
                            @click=${() => this._handleRemoveBlock(block)}
                        >
                            <ha-icon icon="mdi:close"></ha-icon>
                        </button>
                    `}
                </span>
            </div>
        `;
    }

    private _renderEditPanel(
        day: EntityScheduleDay,
        lane: EntityScheduleLane,
        blocks: readonly EntityScheduleBlock[],
        editingBlock: EntityScheduleBlock | null,
    ) {
        const editing = this._editing;
        if (editing === null) {
            return nothing;
        }

        // Bounded by the neighbours exactly as a drag is: the pickers must not
        // be the back door that overwrites the block next door.
        const limits = resolveEntityScheduleRangeLimits({
            blocks,
            day,
            startMs: editing.startMs,
            endMs: editing.endMs,
        });
        const boundaries = buildEntityScheduleBoundaryOptions({
            day,
            includeMs: [editing.startMs, editing.endMs],
        }).filter((ms) => ms >= limits.minMs && ms <= limits.maxMs);
        return html`
            <div class="panel edit-panel">
                <div class="range-fields">
                    <label class="field">
                        <span class="field-label">${this.localize("scheduling.entity_editor.from")}</span>
                        <!--
                            Every boundary but the last is offered, not only the
                            ones before the current end: moving a block later is
                            a start-first gesture, and the end follows it.
                        -->
                        <select class="select-input" @change=${this._handleStartChange}>
                            ${boundaries.slice(0, -1).map((ms) => html`
                                <option value=${ms} ?selected=${ms === editing.startMs}>
                                    ${this._formatBoundary(day, ms)}
                                </option>
                            `)}
                        </select>
                    </label>
                    <label class="field">
                        <span class="field-label">${this.localize("scheduling.entity_editor.to")}</span>
                        <select class="select-input" @change=${this._handleEndChange}>
                            ${boundaries.filter((ms) => ms > editing.startMs).map((ms) => html`
                                <option value=${ms} ?selected=${ms === editing.endMs}>
                                    ${this._formatBoundary(day, ms)}
                                </option>
                            `)}
                        </select>
                    </label>
                </div>

                <scheduling-entity-action-editor
                    .localize=${this.localize}
                    .target=${lane.target}
                    .appliance=${lane.appliance}
                    .action=${editing.action}
                    .sessionKey=${this._editSessionId}
                    .authorship=${editingBlock?.authorship ?? "user"}
                    @entity-action-change=${this._handleActionChange}
                ></scheduling-entity-action-editor>

                <div class="edit-panel-buttons">
                    <button class="secondary-button" type="button" @click=${this._handleRemoveEditedBlock}>
                        ${this.localize("scheduling.entity_editor.remove_block")}
                    </button>
                    <span class="field-help">${this.localize("scheduling.entity_editor.edit_hint")}</span>
                </div>
            </div>
        `;
    }

    private _renderActionChip(lane: EntityScheduleLane, action: EntityScheduleAction) {
        if (lane.target.kind === "inverter" && isEntityInverterAction(action)) {
            return html`
                <scheduling-action-chip
                    .action=${action}
                    .localize=${this.localize}
                    size="compact"
                ></scheduling-action-chip>
            `;
        }

        const applianceAction = action === null || isEntityInverterAction(action)
            ? null
            : action as ScheduleApplianceAction;
        const appliance = lane.appliance ?? {
            id: "unknown",
            name: lane.name,
            kind: "generic",
            icon: lane.icon,
        };
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

    /**
     * Every lane to stack, falling back to the single target the dialog was
     * opened with when the card has not supplied a roster.
     */
    private get _lanes(): EntityScheduleLane[] {
        if (this.lanes.length > 0) {
            return [...this.lanes];
        }

        if (this.target === null) {
            return [];
        }

        return [{
            key: getEntityScheduleTargetKey(this.target),
            target: this.target,
            // The roster is where the entity ids come from; without it there is
            // nothing to resolve, so the lane's label keeps its static icon.
            entityId: "",
            name: this.entityName,
            icon: this.appliance?.icon ?? this.entityIcon,
            appliance: this.appliance,
            isAvailable: true,
            actualSlots: [],
        }];
    }

    private get _selectedLane(): EntityScheduleLane | null {
        return this._lanes.find((lane) => lane.key === this._selectedLaneKey) ?? null;
    }

    /** The selected lane's pending edits. */
    private get _draft(): EntityScheduleDraft {
        return this._selectedLaneKey === null
            ? {}
            : this._drafts[this._selectedLaneKey] ?? {};
    }

    private _setDraft(draft: EntityScheduleDraft): void {
        if (this._selectedLaneKey === null) {
            return;
        }

        this._drafts = { ...this._drafts, [this._selectedLaneKey]: draft };
    }

    private _laneDrafts(): { target: EntityScheduleTarget; draft: EntityScheduleDraft }[] {
        return this._lanes.flatMap((lane) => {
            const draft = this._drafts[lane.key];
            return draft === undefined ? [] : [{ target: lane.target, draft }];
        });
    }

    private _seedFromSlots(): void {
        this._baselineSlots = [...this.slots];
        this._drafts = {};
        this._draftBeforeEdit = {};
        this._editing = null;
        // Every opening is an opening to edit: the dialog is reached by
        // pressing something the user means to change far more often than
        // something they mean to have explained.
        this._mode = "edit";
        this._explainSelection = null;
        // The records are only as good as the run that produced them, and a
        // save between two openings re-runs the automation: the answer this
        // dialog gave last time is not the answer to give now.
        this._explanations = new Map();
        this._explanationFailures = new Set();
        this._explanationsRequested = new Set();
        this._selectedLaneKey = this.target === null
            ? this._lanes[0]?.key ?? null
            : getEntityScheduleTargetKey(this.target);
        this._dayIndex = this._resolveInitialDayIndex();
    }

    /**
     * The day worth opening on: whichever day the host was showing, or -- when
     * it did not say -- the one holding the selected entity's next scheduled
     * change, which is what the user tapped on to get here.
     */
    private _resolveInitialDayIndex(): number {
        const days = this._days();
        const lane = this._selectedLane;
        if (days.length === 0 || lane === null) {
            return 0;
        }

        const hostDayIndex = this.initialDayKey === null
            ? -1
            : days.findIndex((day) => day.dayKey === this.initialDayKey);
        if (hostDayIndex >= 0) {
            return hostDayIndex;
        }

        const blocks = buildEntityScheduleBlocks({
            slots: this._baselineSlots,
            target: lane.target,
            draft: {},
            nowMs: this.nowMs,
        });
        const nextBlock = blocks.find((block) => block.endMs > this.nowMs);
        const dayIndex = nextBlock === undefined
            ? -1
            : days.findIndex((day) => nextBlock.startMs < day.endMs && nextBlock.endMs > day.startMs);
        if (dayIndex >= 0) {
            return dayIndex;
        }

        const todayIndex = days.findIndex((day) => this.nowMs < day.endMs);
        return todayIndex >= 0 ? todayIndex : 0;
    }

    private _days(): EntityScheduleDay[] {
        return buildEntityScheduleDays({
            slots: this._baselineSlots,
            timeZone: this.timeZone,
            locale: this.locale,
            currentDayKey: this.currentDayKey,
            todayLabel: this.localize("scheduling.day.today"),
            tomorrowLabel: this.localize("scheduling.day.tomorrow"),
            nowMs: this.nowMs,
        });
    }

    private _selectedDay(days: readonly EntityScheduleDay[] = this._days()): EntityScheduleDay | null {
        if (days.length === 0) {
            return null;
        }

        return days[Math.min(Math.max(this._dayIndex, 0), days.length - 1)];
    }

    private _dayBlocks(day: EntityScheduleDay, lane: EntityScheduleLane): EntityScheduleBlock[] {
        return selectEntityScheduleDayBlocks(
            buildEntityScheduleBlocks({
                slots: this._baselineSlots,
                target: lane.target,
                draft: this._drafts[lane.key] ?? {},
                nowMs: this.nowMs,
            }),
            day,
        );
    }

    private _buildBandLanes(day: EntityScheduleDay): EntityDayBandLane[] {
        return buildEntityDayBandLanes({
            lanes: this._lanes,
            slots: this._baselineSlots,
            day,
            drafts: this._drafts,
            nowMs: this.nowMs,
            projectionIndex: this.projectionIndex,
        });
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

        this._commitEditSession();
        this._hoveredBlockKey = null;
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

        this._commitEditSession();
        this._hoveredBlockKey = null;
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
     * Ask for every lane's record for the day on screen.
     *
     * Up front rather than on the first press, because the lane list itself is
     * an answer: a lane no optimizer touched has nothing to explain and does
     * not belong in this mode, and that cannot be known without the record.
     * One request per lane per day, ever -- the set outlives both the mode and
     * the day, so walking back and forth across them is silent.
     */
    private _requestExplanations(): void {
        const day = this._selectedDay();
        if (day === null) {
            return;
        }

        for (const lane of this._lanes) {
            void this._loadExplanation(lane.key, day.dayKey);
        }
    }

    private async _loadExplanation(laneKey: string, dayKey: string): Promise<void> {
        const hass = this.hass;
        const key = this._explanationKey(laneKey, dayKey);
        if (!hass || this._explanationsRequested.has(key)) {
            return;
        }

        this._explanationsRequested.add(key);
        try {
            const payload = await hass.callWS<unknown>({
                type: "helman/get_schedule_explanation",
                target_key: laneKey,
                date: dayKey,
            });
            // A null answer is not a failure: it means nothing was recorded for
            // this lane on this date, which is exactly what drops the lane out
            // of Explain mode.
            this._explanations = new Map(this._explanations).set(key, payload ?? null);
        } catch {
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
        day: EntityScheduleDay,
    ): EntityDayBandLane[] {
        return lanes.filter((lane) => {
            const key = this._explanationKey(lane.key, day.dayKey);
            const model = this._explanationModels.get(key);
            if (model === undefined) {
                return !this._explanations.has(key);
            }

            return model.columns.some((column) => column.cells.some((cell) => cell.present));
        });
    }

    /** The block the edit session currently covers, for highlighting. */
    private _resolveEditingBlock(
        blocks: readonly EntityScheduleBlock[],
    ): EntityScheduleBlock | null {
        const editing = this._editing;
        if (editing === null) {
            return null;
        }

        return blocks.find(
            (candidate) => candidate.startMs < editing.endMs && candidate.endMs > editing.startMs,
        ) ?? null;
    }

    private _selectDayIndex(index: number): void {
        const days = this._days();
        if (index < 0 || index >= days.length) {
            return;
        }

        // The draft is keyed by slot id and spans every day, so switching days
        // keeps unsaved work; only the open edit session is day-local.
        this._commitEditSession();
        this._dayIndex = index;
        // The selected slot belongs to the day it was pressed on, and so does
        // every record: a new day is a new set of questions.
        this._explainSelection = null;
        if (this._mode === "explain") {
            this._requestExplanations();
        }
    }

    private _handleBandBlockSelect(event: CustomEvent<EntityDayBandBlockSelectDetail>): void {
        event.stopPropagation();
        this._selectLane(event.detail.laneKey);
        const day = this._selectedDay();
        const lane = this._selectedLane;
        if (day === null || lane === null) {
            return;
        }

        const block = this._dayBlocks(day, lane).find((candidate) => candidate.key === event.detail.blockKey);
        if (block !== undefined) {
            this._handleEditBlock(block);
        }
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

    private _handleBandBlockHover(event: CustomEvent<{ blockKey: string | null }>): void {
        event.stopPropagation();
        this._setHoveredBlock(event.detail.blockKey);
    }

    private _setHoveredBlock(blockKey: string | null): void {
        this._hoveredBlockKey = blockKey;
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
     * Anything outside the edit panel, the block list and the band ends the
     * session. What the session already wrote into the draft stays there.
     */
    private _handleContentPointerDown(event: PointerEvent): void {
        if (this._editing === null) {
            return;
        }

        // The block list counts as inside: its rows and its "add block" button
        // open sessions, and this handler runs after theirs -- treating them as
        // outside would close the session they just opened.
        const keepsSession = event.composedPath().some((node) => node instanceof HTMLElement && (
            node.classList.contains("edit-panel")
            || node.classList.contains("block-list")
            || node.localName === "scheduling-entity-day-band"
        ));
        if (!keepsSession) {
            this._commitEditSession();
        }
    }

    private _handleBandGapSelect(event: CustomEvent<EntityDayBandGapSelectDetail>): void {
        event.stopPropagation();
        this._selectLane(event.detail.laneKey);
        const day = this._selectedDay();
        const lane = this._selectedLane;
        if (day !== null && lane !== null) {
            // The default hour is cut short by the end of the free stretch: a
            // new block must not be born overlapping the next one.
            this._beginEdit(
                [],
                event.detail.startMs,
                Math.min(this._resolveDefaultEndMs(day, event.detail.startMs), event.detail.limitMs),
                this._buildDefaultAction(lane),
            );
        }
    }

    private _handleAddBlock(day: EntityScheduleDay, lane: EntityScheduleLane): void {
        const startMs = this._findFreeStartMs(day, this._dayBlocks(day, lane));
        if (startMs === null) {
            return;
        }

        this._beginEdit([], startMs, this._resolveDefaultEndMs(day, startMs), this._buildDefaultAction(lane));
    }

    /**
     * Start editing a block, switching straight from another one if a session
     * is already open -- the previous block's edits are already in the draft,
     * so there is nothing to confirm on the way out.
     */
    private _handleEditBlock(block: EntityScheduleBlock): void {
        if (block.isPast || this._isEditingBlock(block)) {
            return;
        }

        this._beginEdit(block.slotIds, block.startMs, block.endMs, block.action);
    }

    private _handleRemoveBlock(block: EntityScheduleBlock): void {
        if (block.isPast) {
            return;
        }

        this._setDraft(this._clearSlots(this._draft, block.slotIds));
    }

    private _handleRemoveEditedBlock(): void {
        const editing = this._editing;
        if (editing === null) {
            return;
        }

        // Back to the pre-edit draft minus the block: whatever the session did
        // to the range goes away with it.
        this._setDraft(this._clearSlots(this._draftBeforeEdit, editing.originalSlotIds));
        this._editing = null;
        this._draftBeforeEdit = {};
    }

    private _isEditingBlock(block: EntityScheduleBlock): boolean {
        const editing = this._editing;
        return editing !== null && block.startMs < editing.endMs && block.endMs > editing.startMs;
    }

    /**
     * Move the block's start, dragging the end with it when it would overtake
     * it, so the block keeps its length instead of collapsing.
     *
     * The end it drags along stops at the neighbour, exactly as a drag on the
     * band does. Bounding only by the end of the day would make this picker the
     * back door that eats the next block.
     */
    private _handleStartChange(event: Event): void {
        const editing = this._editing;
        const day = this._selectedDay();
        const lane = this._selectedLane;
        if (editing === null || day === null || lane === null) {
            return;
        }

        const limits = resolveEntityScheduleRangeLimits({
            blocks: this._dayBlocks(day, lane),
            day,
            startMs: editing.startMs,
            endMs: editing.endMs,
        });
        const startMs = Number((event.currentTarget as HTMLSelectElement).value);
        const endMs = startMs < editing.endMs
            ? editing.endMs
            : Math.min(startMs + (editing.endMs - editing.startMs), limits.maxMs);
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

        this._updateEditSession({
            ...editing,
            action: sanitizeEntityScheduleAction(event.detail.action),
            valid: event.detail.valid,
        });
    }

    /**
     * Open a session over the part of a block the user may still change.
     *
     * A block that is already running starts in the past; the session begins at
     * the first editable slot instead, so the pickers have that start to offer
     * and the running part stays exactly as scheduled.
     */
    private _beginEdit(
        originalSlotIds: readonly string[],
        startMs: number,
        endMs: number,
        action: EntityScheduleAction,
    ): void {
        const day = this._selectedDay();
        if (day === null) {
            return;
        }

        const editableStartMs = Math.max(startMs, day.editableFromMs);
        if (editableStartMs >= endMs) {
            return;
        }

        this._draftBeforeEdit = { ...this._draft };
        this._editSessionId += 1;
        this._updateEditSession({
            originalSlotIds: [...originalSlotIds],
            startMs: editableStartMs,
            endMs,
            action: sanitizeEntityScheduleAction(action),
            valid: true,
        });
    }

    /**
     * Rewrite the draft for the session's range, live.
     *
     * Every change replays from the pre-edit draft rather than patching the last
     * one, so dragging a block back and forth cannot leave a trail of slots
     * behind it.
     */
    private _updateEditSession(session: EntityScheduleEditSession): void {
        this._editing = session;
        this._setDraft(this._applyRange({
            base: this._draftBeforeEdit,
            clearSlotIds: session.originalSlotIds,
            startMs: session.startMs,
            endMs: session.endMs,
            action: session.valid ? session.action : null,
        }));
    }

    private _commitEditSession(): void {
        if (this._editing === null) {
            return;
        }

        this._editing = null;
        this._draftBeforeEdit = {};
    }

    private _applyRange({
        base,
        clearSlotIds,
        startMs,
        endMs,
        action,
    }: {
        base: EntityScheduleDraft;
        clearSlotIds: readonly string[];
        startMs: number;
        endMs: number;
        action: EntityScheduleAction;
    }): EntityScheduleDraft {
        const day = this._selectedDay();
        const lane = this._selectedLane;
        if (day === null || lane === null) {
            return base;
        }

        const emptyAction = getEmptyEntityScheduleAction(lane.target);
        const next = this._clearSlots(base, clearSlotIds);
        const rangeAction = isEntityScheduleActionEmpty(action) ? emptyAction : action;
        for (const slot of selectEntityScheduleSlotsInRange({ day, startMs, endMs })) {
            if (slot.startMs < day.editableFromMs) {
                continue;
            }

            next[slot.id] = rangeAction;
        }

        return next;
    }

    /** Drop the entity's action from these slots, keeping the rest of the draft. */
    private _clearSlots(
        base: EntityScheduleDraft,
        slotIds: readonly string[],
    ): EntityScheduleDraft {
        const day = this._selectedDay();
        const lane = this._selectedLane;
        if (lane === null || day === null) {
            return base;
        }

        const emptyAction = getEmptyEntityScheduleAction(lane.target);
        const editableSlotIds = new Set(this._editableSlotIds(day));
        const next: EntityScheduleDraft = { ...base };
        for (const slotId of slotIds) {
            // A slot that is already running or past cannot be rewritten, so
            // clearing it would only make the block vanish from the view while
            // the schedule kept it.
            if (editableSlotIds.has(slotId)) {
                next[slotId] = emptyAction;
            }
        }

        return next;
    }

    private _editableSlotIds(day: EntityScheduleDay): string[] {
        return day.slots
            .filter((slot) => slot.startMs >= day.editableFromMs)
            .map((slot) => slot.id);
    }

    /** The first slot start of the day with nothing scheduled on it. */
    private _findFreeStartMs(
        day: EntityScheduleDay,
        blocks: readonly EntityScheduleBlock[],
    ): number | null {
        const candidates = buildEntityScheduleBoundaryOptions({ day })
            .filter((ms) => ms >= day.editableFromMs && ms < day.endMs);
        return candidates.find(
            (ms) => !blocks.some((block) => block.startMs <= ms && block.endMs > ms),
        ) ?? null;
    }

    private _resolveDefaultEndMs(day: EntityScheduleDay, startMs: number): number {
        const boundaries = buildEntityScheduleBoundaryOptions({ day }).filter((ms) => ms > startMs);
        const preferred = startMs + DEFAULT_NEW_BLOCK_DURATION_MS;
        return boundaries.find((ms) => ms >= preferred)
            ?? boundaries[boundaries.length - 1]
            ?? day.endMs;
    }

    /**
     * What a freshly added block does before the user says otherwise: the
     * obvious "run it" for each lane, so adding a block and pressing Done is a
     * complete action rather than an empty one.
     */
    private _buildDefaultAction(lane: EntityScheduleLane): EntityScheduleAction {
        if (lane.target.kind === "inverter") {
            return { kind: "charge_to_target_soc", targetSoc: 100 };
        }

        const appliance = lane.appliance;
        if (appliance?.kind === "ev_charger") {
            return { charge: true };
        }
        if (appliance !== null && appliance.supportsAuthoring && appliance.kind === "climate") {
            const modes: readonly string[] = appliance.scheduleCapabilities.modes;
            const mode = modes.find((candidate) => candidate !== "off");
            return mode === undefined ? null : { mode };
        }

        return { on: true };
    }

    private _formatBlockRange(day: EntityScheduleDay, block: EntityScheduleBlock): string {
        const start = block.continuesBefore
            ? `←${this._formatBoundary(day, block.startMs)}`
            : this._formatBoundary(day, block.startMs);
        const end = block.continuesAfter
            ? `${this._formatBoundary(day, block.endMs)}→`
            : this._formatBoundary(day, block.endMs);
        return `${start}–${end}`;
    }

    /** Midnight at the end of a day reads as 24:00, not as the next 00:00. */
    private _formatBoundary(day: EntityScheduleDay, atMs: number): string {
        return atMs === day.endMs && atMs !== day.startMs
            ? "24:00"
            : formatScheduleTime(atMs, this.locale, this.timeZone);
    }

    private _authorshipLabel(block: EntityScheduleBlock): string {
        if (block.isDirty) {
            return this.localize("scheduling.entity_editor.unsaved");
        }

        if (block.authorship === "automation") {
            return this.localize("scheduling.authorship.set_by_automation");
        }

        return block.authorship === "user"
            ? this.localize("scheduling.authorship.set_by_user")
            : this.localize("scheduling.authorship.mixed");
    }

    private _isDirty(): boolean {
        return areEntityScheduleLanesDirty(this._baselineSlots, this._laneDrafts(), this.nowMs);
    }

    private _canSave(): boolean {
        return !this.busy
            && this._isDirty()
            && (this._editing === null || this._editing.valid);
    }

    private _handleSave(): void {
        if (!this._canSave()) {
            return;
        }

        this._commitEditSession();
        // Every lane's draft in one batch: a slot two entities both changed has
        // to leave as a single patch, or one of the two edits is lost.
        const patches = buildEntityScheduleLanePatches({
            slots: this._baselineSlots,
            lanes: this._laneDrafts(),
            nowMs: this.nowMs,
        });
        // Nothing writable left -- the drafted slots elapsed between the press
        // and here. Stay open rather than close as if the day had been saved;
        // Save disables itself as soon as the next tick re-reads the drafts.
        if (patches.length === 0) {
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

    private _onClosed(): void {
        if (this._canConsumeCurrentHistoryEntry()) {
            this._ignoreNextPopstate = true;
            this._clearHistoryEntry();
            window.history.back();
        } else {
            this._clearHistoryEntry();
        }

        this.dispatchEvent(new CustomEvent("closed", { bubbles: true, composed: true }));
    }

    private _pushHistoryEntry(): void {
        if (typeof window === "undefined" || typeof window.history.pushState !== "function") {
            return;
        }

        const nextEntryId = ++nextDialogHistoryEntryId;
        const nextState = this._getHistoryStateRecord(window.history.state);
        nextState[DIALOG_HISTORY_STATE_KEY] = nextEntryId;
        window.history.pushState(nextState, "");
        this._historyEntryId = nextEntryId;
        this._historyEntryActive = true;
        this._ignoreNextPopstate = false;
    }

    private _canConsumeCurrentHistoryEntry(): boolean {
        return typeof window !== "undefined"
            && typeof window.history.back === "function"
            && this._historyEntryActive
            && this._isCurrentHistoryEntry(window.history.state);
    }

    private _isCurrentHistoryEntry(state: unknown): boolean {
        return this._historyEntryId !== null && this._readHistoryEntryId(state) === this._historyEntryId;
    }

    private _readHistoryEntryId(state: unknown): number | null {
        if (state === null || typeof state !== "object") {
            return null;
        }

        const entryId = (state as Record<string, unknown>)[DIALOG_HISTORY_STATE_KEY];
        return typeof entryId === "number" ? entryId : null;
    }

    private _getHistoryStateRecord(state: unknown): Record<string, unknown> {
        if (state === null || typeof state !== "object") {
            return {};
        }

        return { ...(state as Record<string, unknown>) };
    }

    private _clearHistoryEntry(): void {
        this._historyEntryActive = false;
        this._historyEntryId = null;
    }
}
