import { LitElement, css, html } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { LocalizeFunction } from "../../localize/localize";
import "../components/scheduling-action-chip";
import "../components/scheduling-appliance-chip";
import "../components/scheduling-entity-day-band";
import "./scheduling-entity-action-editor";
import type {
    EntityDayBandBlockSelectDetail,
    EntityDayBandGapSelectDetail,
    EntityDayBandRangeChangeDetail,
} from "../components/scheduling-entity-day-band";
import type {
    EntityScheduleAction,
    EntityScheduleBlock,
    EntityScheduleDay,
    EntityScheduleDraft,
    EntityScheduleTarget,
} from "../model/entity-day-schedule-model";
import {
    buildEntityScheduleBlocks,
    buildEntityScheduleBoundaryOptions,
    buildEntityScheduleDays,
    buildEntitySchedulePatches,
    getEmptyEntityScheduleAction,
    isEntityInverterAction,
    isEntityScheduleActionEmpty,
    isEntityScheduleDraftDirty,
    resolveEntityScheduleRangeLimits,
    sanitizeEntityScheduleAction,
    selectEntityScheduleDayBlocks,
    selectEntityScheduleSlotsInRange,
} from "../model/entity-day-schedule-model";
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
 * One entity's schedule, one day at a time.
 *
 * The whole day is drafted locally and written as a single batch on Save, so
 * moving three blocks around is one schedule write and one automation re-run
 * rather than three of each. Nothing is applied until Save, so Cancel is a
 * plain close -- there is nothing to undo.
 */
@customElement("scheduling-entity-day-editor")
export class SchedulingEntityDayEditor extends LitElement {
    static styles = [
        schedulingSharedStyles,
        css`
            /* A day of blocks next to a full-width band: the band is the
               control surface here, and it only reads well when an hour is
               wide enough to point at. */
            .dialog-content {
                display: flex;
                flex-direction: column;
                gap: 14px;
                width: min(880px, calc(100vw - 48px));
                max-width: 100%;
                padding-top: 4px;
            }

            .day-switcher {
                display: flex;
                align-items: center;
                gap: 6px;
                flex-wrap: wrap;
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
                gap: 10px;
                padding: 4px 6px;
                border: 1px solid transparent;
                border-radius: 8px;
            }

            .block-row.editing {
                border-color: color-mix(in srgb, var(--primary-color) 44%, var(--divider-color));
                background: color-mix(in srgb, var(--primary-color) 8%, transparent);
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

    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public target: EntityScheduleTarget | null = null;
    @property({ attribute: false }) public appliance: ScheduleApplianceMetadata | null = null;
    @property({ attribute: false }) public slots: readonly ScheduleSlot[] = [];
    @property({ attribute: false }) public forecastPoints: ReadonlyMap<string, SlotForecastPoint> = new Map();
    @property({ type: String }) public entityName = "";
    @property({ type: String }) public entityIcon = "mdi:flash-outline";
    @property({ type: String }) public currentDayKey: string | null = null;
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
    @state() private _draft: EntityScheduleDraft = {};
    @state() private _dayIndex = 0;
    @state() private _editing: EntityScheduleEditSession | null = null;

    private _draftBeforeEdit: EntityScheduleDraft = {};
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
        if (changedProperties.has("open") && this.open) {
            this._seedFromSlots();
        }
        if (changedProperties.has("target") && this.open) {
            this._seedFromSlots();
        }
    }

    updated(changedProperties: Map<string, unknown>): void {
        super.updated(changedProperties);
        if (this.open && !this._historyEntryActive && changedProperties.has("open")) {
            this._pushHistoryEntry();
        }
    }

    render() {
        const day = this._selectedDay();
        if (this.target === null || day === null) {
            return nothing;
        }

        const blocks = this._dayBlocks(day);
        const editingBlockKey = this._resolveEditingBlockKey(blocks);
        return html`
            <ha-dialog
                .open=${this.open}
                width="large"
                .heading=${this.entityName}
                .headerTitle=${this.entityName}
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
                    ${this._renderDaySwitcher(day)}
                    ${this.scheduleChanged ? html`
                        <div class="stale-banner">
                            <ha-icon icon="mdi:alert-outline"></ha-icon>
                            <span>${this.localize("scheduling.entity_editor.schedule_changed")}</span>
                        </div>
                    ` : nothing}

                    <scheduling-entity-day-band
                        .localize=${this.localize}
                        .day=${day}
                        .blocks=${blocks}
                        .target=${this.target}
                        .appliance=${this.appliance}
                        .forecastPoints=${this.forecastPoints}
                        .nowMs=${this.nowMs}
                        .locale=${this.locale}
                        .timeZone=${this.timeZone}
                        .editingRange=${this._editing === null ? null : {
                            startMs: this._editing.startMs,
                            endMs: this._editing.endMs,
                        }}
                        @entity-day-band-block-select=${this._handleBandBlockSelect}
                        @entity-day-band-gap-select=${this._handleBandGapSelect}
                        @entity-day-band-range-change=${this._handleBandRangeChange}
                    ></scheduling-entity-day-band>

                    ${this._renderBlockList(day, blocks, editingBlockKey)}
                    ${this._renderEditPanel(day, blocks)}
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

    private _renderDaySwitcher(day: EntityScheduleDay) {
        const days = this._days();
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

    private _renderBlockList(
        day: EntityScheduleDay,
        blocks: readonly EntityScheduleBlock[],
        editingBlockKey: string | null,
    ) {
        return html`
            <div class="block-list">
                <div class="field-label">${this.localize("scheduling.entity_editor.blocks")}</div>
                ${blocks.length === 0 ? html`
                    <div class="field-help">${this.localize("scheduling.entity_editor.no_blocks")}</div>
                ` : blocks.map((block) => this._renderBlockRow(day, block, editingBlockKey))}
                <div>
                    <button
                        class="link-button"
                        type="button"
                        ?disabled=${this._findFreeStartMs(day) === null}
                        @click=${() => this._handleAddBlock(day)}
                    >
                        ${this.localize("scheduling.entity_editor.add_block")}
                    </button>
                </div>
            </div>
        `;
    }

    private _renderBlockRow(
        day: EntityScheduleDay,
        block: EntityScheduleBlock,
        editingBlockKey: string | null,
    ) {
        const editing = editingBlockKey === block.key;
        const classes = `block-row${editing ? " editing" : ""}${block.isPast ? " past" : ""}`;
        return html`
            <div class=${classes}>
                <span class="block-range">${this._formatBlockRange(day, block)}</span>
                <span class="block-action">${this._renderActionChip(block.action)}</span>
                <span class="block-authorship">${this._authorshipLabel(block)}</span>
                <span class="block-buttons">
                    ${block.isPast ? nothing : html`
                        <button
                            class="icon-button"
                            type="button"
                            aria-label=${this.localize("scheduling.entity_editor.edit_block")}
                            @click=${() => this._handleEditBlock(block)}
                        >
                            <ha-icon icon="mdi:pencil-outline"></ha-icon>
                        </button>
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

    private _renderEditPanel(day: EntityScheduleDay, blocks: readonly EntityScheduleBlock[]) {
        const editing = this._editing;
        if (editing === null || this.target === null) {
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
                    .target=${this.target}
                    .appliance=${this.appliance}
                    .action=${editing.action}
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

    private _renderActionChip(action: EntityScheduleAction) {
        if (this.target?.kind === "inverter" && isEntityInverterAction(action)) {
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
        const appliance = this.appliance ?? {
            id: "unknown",
            name: this.entityName,
            kind: "generic",
            icon: this.entityIcon,
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

    private _seedFromSlots(): void {
        this._baselineSlots = [...this.slots];
        this._draft = {};
        this._draftBeforeEdit = {};
        this._editing = null;
        this._dayIndex = this._resolveInitialDayIndex();
    }

    /**
     * The day worth opening on: the one holding the entity's next scheduled
     * change, which is what the user tapped on to get here.
     */
    private _resolveInitialDayIndex(): number {
        const days = this._days();
        if (days.length === 0) {
            return 0;
        }

        const blocks = buildEntityScheduleBlocks({
            slots: this._baselineSlots,
            target: this.target ?? { kind: "inverter" },
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

    private _selectedDay(): EntityScheduleDay | null {
        const days = this._days();
        if (days.length === 0) {
            return null;
        }

        return days[Math.min(Math.max(this._dayIndex, 0), days.length - 1)];
    }

    private _dayBlocks(day: EntityScheduleDay): EntityScheduleBlock[] {
        if (this.target === null) {
            return [];
        }

        return selectEntityScheduleDayBlocks(
            buildEntityScheduleBlocks({
                slots: this._baselineSlots,
                target: this.target,
                draft: this._draft,
                nowMs: this.nowMs,
            }),
            day,
        );
    }

    /** The block the edit session currently covers, for highlighting. */
    private _resolveEditingBlockKey(blocks: readonly EntityScheduleBlock[]): string | null {
        const editing = this._editing;
        if (editing === null) {
            return null;
        }

        const block = blocks.find(
            (candidate) => candidate.startMs < editing.endMs && candidate.endMs > editing.startMs,
        );
        return block?.key ?? null;
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
    }

    private _handleBandBlockSelect(event: CustomEvent<EntityDayBandBlockSelectDetail>): void {
        event.stopPropagation();
        const day = this._selectedDay();
        if (day === null) {
            return;
        }

        const block = this._dayBlocks(day).find((candidate) => candidate.key === event.detail.blockKey);
        if (block !== undefined) {
            this._handleEditBlock(block);
        }
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
        const day = this._selectedDay();
        if (day !== null) {
            this._beginEdit([], event.detail.startMs, this._resolveDefaultEndMs(day, event.detail.startMs), this._buildDefaultAction());
        }
    }

    private _handleAddBlock(day: EntityScheduleDay): void {
        const startMs = this._findFreeStartMs(day);
        if (startMs === null) {
            return;
        }

        this._beginEdit([], startMs, this._resolveDefaultEndMs(day, startMs), this._buildDefaultAction());
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

        this._draft = this._clearSlots(this._draft, block.slotIds);
    }

    private _handleRemoveEditedBlock(): void {
        const editing = this._editing;
        if (editing === null) {
            return;
        }

        // Back to the pre-edit draft minus the block: whatever the session did
        // to the range goes away with it.
        this._draft = this._clearSlots(this._draftBeforeEdit, editing.originalSlotIds);
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
     */
    private _handleStartChange(event: Event): void {
        const editing = this._editing;
        const day = this._selectedDay();
        if (editing === null || day === null) {
            return;
        }

        const startMs = Number((event.currentTarget as HTMLSelectElement).value);
        const endMs = startMs < editing.endMs
            ? editing.endMs
            : Math.min(startMs + (editing.endMs - editing.startMs), day.endMs);
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
        this._draft = this._applyRange({
            base: this._draftBeforeEdit,
            clearSlotIds: session.originalSlotIds,
            startMs: session.startMs,
            endMs: session.endMs,
            action: session.valid ? session.action : null,
        });
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
        if (day === null || this.target === null) {
            return base;
        }

        const emptyAction = getEmptyEntityScheduleAction(this.target);
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
        if (this.target === null || day === null) {
            return base;
        }

        const emptyAction = getEmptyEntityScheduleAction(this.target);
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
    private _findFreeStartMs(day: EntityScheduleDay): number | null {
        const blocks = this._dayBlocks(day);
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
    private _buildDefaultAction(): EntityScheduleAction {
        if (this.target?.kind === "inverter") {
            return { kind: "charge_to_target_soc", targetSoc: 100 };
        }

        const appliance = this.appliance;
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
        return this.target !== null
            && isEntityScheduleDraftDirty(this._baselineSlots, this.target, this._draft);
    }

    private _canSave(): boolean {
        return !this.busy
            && this._isDirty()
            && (this._editing === null || this._editing.valid);
    }

    private _handleSave(): void {
        if (this.target === null || !this._canSave()) {
            return;
        }

        this._commitEditSession();
        const patches = buildEntitySchedulePatches({
            slots: this._baselineSlots,
            target: this.target,
            draft: this._draft,
            nowMs: this.nowMs,
        });
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
