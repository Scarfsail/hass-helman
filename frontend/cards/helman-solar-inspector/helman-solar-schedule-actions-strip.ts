import { LitElement, css, html, type PropertyValues } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import { getSharedHelmanStore } from "../helman/store";
import { getSharedScheduleOwner, type SharedScheduleOwner } from "../helman-scheduling/schedule-owner";
import {
    normalizeScheduleApplianceMetadata,
    type ScheduleApplianceMetadata,
} from "../helman-scheduling/model/schedule-appliance-metadata";
import {
    buildScheduleApplianceProjectionIndex,
    EMPTY_SCHEDULE_APPLIANCE_PROJECTION_INDEX,
    type ScheduleApplianceProjectionIndex,
} from "../helman-scheduling/model/schedule-appliance-projection";
import { buildNormalizedScheduleStructure } from "../helman-scheduling/model/schedule-normalizer";
import { buildScheduleActionCell } from "../helman-scheduling/model/schedule-hour-bucket-builder";
import { getScheduleLocalTimeParts } from "../helman-scheduling/model/schedule-time";
import { getScheduleActionLabel } from "../helman-scheduling/model/schedule-labels";
import { getScheduleApplianceActionPresentation } from "../helman-scheduling/model/schedule-appliance-action-presentation";
import { buildScheduleRangeEditSelectionSummary, buildScheduleRangeEditAuthorshipSummary } from "../helman-scheduling/model/schedule-range-edit-selection-summary";
import { buildScheduleSlotPatches } from "../helman-scheduling/model/schedule-patch-builder";
import {
    applyScheduleSlotSelection,
    resolveScheduleDialogSelectionIds,
} from "../helman-scheduling/model/schedule-selection";
import type {
    ScheduleBackedDisplaySlot,
    ScheduleDialogState,
    ScheduleOwnerSnapshot,
    ScheduleRangeEditIntent,
    ScheduleSlot,
    ScheduleSlotPatch,
} from "../helman-scheduling/schedule-types";
import type {
    ScheduleTableActionItemModel,
} from "../helman-scheduling/schedule-table-types";
import "../helman-scheduling/components/scheduling-action-chip";
import "../helman-scheduling/components/scheduling-appliance-chip";
import "../helman-scheduling/dialogs/scheduling-range-edit-dialog";

const MINUTES_PER_DAY = 1440;

/** How the strip maps a minute-of-day to a horizontal fraction of the chart viewBox. */
export interface ScheduleStripGeometry {
    /** Chart viewBox width (the inspector's captured `_chartWidth`). */
    width: number;
    /** Chart plot-area left margin, in viewBox units. */
    marginLeft: number;
    /** Chart plot-area width, in viewBox units. */
    plotWidth: number;
}

/** A schedule slot placed on the selected day's timeline. */
interface StripColumn {
    slot: ScheduleSlot;
    startMinutes: number;
    endMinutes: number;
}

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

/**
 * A horizontal strip of the manual schedule's actions, aligned to the solar inspector
 * chart's time axis. Each schedule slot on the selected day becomes a column whose
 * action icons stack vertically, so the number of actions never widens the slot.
 *
 * Data, selection semantics, and the edit dialog are all reused from the scheduling
 * card via the shared owner/model layer — a save here writes through the same path and
 * both surfaces stay in sync.
 */
@customElement("helman-solar-schedule-actions-strip")
export class HelmanSolarScheduleActionsStrip extends LitElement {
    static styles = css`
        :host {
            display: block;
            width: 100%;
        }

        .strip-toggle {
            position: absolute;
            left: 0;
            top: 50%;
            transform: translateY(-50%);
            z-index: 1;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 18px;
            height: 18px;
            padding: 0;
            border: none;
            background: none;
            color: var(--secondary-text-color);
            cursor: pointer;
        }

        .strip-toggle-icon {
            display: inline-block;
            font-style: normal;
            font-size: 0.7rem;
            opacity: 0.7;
            transition: transform 0.2s;
        }

        .strip-toggle-icon.expanded {
            transform: rotate(90deg);
        }

        .strip-wrap {
            width: 100%;
            overflow-x: auto;
            overflow-y: hidden;
        }

        .strip-inner {
            position: relative;
            width: 100%;
            min-width: 360px;
        }

        .slot-col {
            position: absolute;
            top: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 2px;
            padding: 2px 0;
            border: none;
            background: none;
            cursor: pointer;
            box-sizing: border-box;
        }

        .slot-col:hover {
            background: color-mix(in srgb, var(--primary-color) 8%, transparent);
            border-radius: 4px;
        }

        .slot-col.selected {
            background: rgba(37, 99, 235, 0.14);
            box-shadow: inset 0 0 0 1px rgba(37, 99, 235, 0.5);
            border-radius: 4px;
        }

        .slot-col scheduling-action-chip,
        .slot-col scheduling-appliance-chip {
            flex: 0 0 auto;
        }
    `;

    @property({ attribute: false }) public hass?: HomeAssistant;
    /** Selected inspector day, `YYYY-MM-DD`. */
    @property({ type: String }) public date = "";
    @property({ type: String }) public timeZone = "UTC";
    @property({ attribute: false }) public geometry: ScheduleStripGeometry | null = null;

    @state() private _ownerSnapshot: ScheduleOwnerSnapshot = EMPTY_OWNER_SNAPSHOT;
    @state() private _appliances: ScheduleApplianceMetadata[] = [];
    @state() private _projectionIndex: ScheduleApplianceProjectionIndex = EMPTY_SCHEDULE_APPLIANCE_PROJECTION_INDEX;
    @state() private _selectedSlotIds: string[] = [];
    @state() private _dialogState: ScheduleDialogState | null = null;
    @state() private _dialogOpen = false;
    @state() private _expandedActions = false;

    private _localizeFn?: LocalizeFunction;
    private _scheduleOwner?: SharedScheduleOwner;
    private _unsubscribeOwner?: () => void;
    private _loadedConnection: unknown = null;
    private _appliancesRequested = false;
    private _projectionLoadGeneration = 0;
    private _pendingDialogPatches: ScheduleSlotPatch[] | null = null;
    private _selectionAnchorSlotIds: string[] | null = null;

    private _normalizedSlots: ScheduleSlot[] = [];
    private _normalizedFor: { schedule: unknown; timeZone: string } | null = null;

    protected willUpdate(changed: PropertyValues<this>): void {
        if (changed.has("hass") && this.hass) {
            this._localizeFn = getLocalizeFunction(this.hass);
            if (this._loadedConnection !== this.hass.connection) {
                this._loadedConnection = this.hass.connection;
                this._appliancesRequested = false;
                this._syncOwner();
                void this._loadAppliances();
            } else {
                this._syncOwner();
            }
        }
        this._rebuildNormalizedIfNeeded();
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this._unsubscribeOwner?.();
        this._unsubscribeOwner = undefined;
        this._scheduleOwner = undefined;
    }

    render() {
        if (!this.hass || this.geometry === null) {
            return nothing;
        }

        const columns = this._buildColumns();
        if (columns.length === 0) {
            return nothing;
        }

        const rowCount = Math.max(
            1,
            ...columns.map((column) => this._visibleActionItems(column.slot).length),
        );
        // Each stacked icon-only chip is ~20px tall with a 2px gap, plus 4px padding.
        const innerHeight = rowCount * 20 + (rowCount - 1) * 2 + 4;

        const toggleLabel = this._t("bias_correction.inspector.scheduled_actions");
        return html`
            <div class="strip-wrap">
                <div class="strip-inner" style=${`height:${innerHeight}px;`}>
                    <button
                        class="strip-toggle"
                        type="button"
                        aria-label=${toggleLabel}
                        title=${toggleLabel}
                        aria-expanded=${this._expandedActions ? "true" : "false"}
                        @click=${() => { this._expandedActions = !this._expandedActions; }}
                    >
                        <span class="strip-toggle-icon ${this._expandedActions ? "expanded" : ""}">▶</span>
                    </button>
                    ${columns.map((column) => this._renderColumn(column))}
                </div>
            </div>
            ${this._dialogState ? html`
                <scheduling-range-edit-dialog
                    .open=${this._dialogOpen}
                    .localize=${this._localize}
                    .dialogState=${this._dialogState}
                    .appliances=${this._appliances}
                    @closed=${this._handleDialogClosed}
                    @schedule-dialog-submit=${this._handleDialogSubmit}
                ></scheduling-range-edit-dialog>
            ` : nothing}
        `;
    }

    private _renderColumn(column: StripColumn) {
        const geometry = this.geometry!;
        const leftPct = this._fraction(column.startMinutes, geometry) * 100;
        const rightPct = this._fraction(column.endMinutes, geometry) * 100;
        const widthPct = Math.max(0, rightPct - leftPct);
        const selected = this._selectedSlotIds.includes(column.slot.id);
        const items = this._visibleActionItems(column.slot);
        return html`
            <button
                class=${`slot-col${selected ? " selected" : ""}`}
                type="button"
                style=${`left:${leftPct}%;width:${widthPct}%;`}
                title=${column.slot.rangeLabel}
                aria-label=${column.slot.rangeLabel}
                @click=${(event: MouseEvent) => this._handleColumnClick(event, column.slot.id)}
            >
                ${items.map((item) => this._renderActionItem(item))}
            </button>
        `;
    }

    private _renderActionItem(item: ScheduleTableActionItemModel) {
        const titleText = this._actionItemLabel(item);
        if (item.kind === "inverter") {
            return html`
                <scheduling-action-chip
                    .action=${item.action}
                    .authorship=${item.authorship}
                    .localize=${this._localize}
                    .labelVariant=${"table"}
                    .titleText=${titleText}
                    size="compact"
                    ?iconOnly=${true}
                ></scheduling-action-chip>
            `;
        }
        if (item.kind === "appliance_summary") {
            return html`
                <scheduling-appliance-chip
                    .authorship=${item.authorship}
                    .projectionBadge=${item.projectionBadge}
                    .localize=${this._localize}
                    .titleText=${titleText}
                    size="compact"
                    ?iconOnly=${true}
                    ?summary=${true}
                ></scheduling-appliance-chip>
            `;
        }
        return html`
            <scheduling-appliance-chip
                .appliance=${item.appliance}
                .action=${item.action}
                .authorship=${item.authorship}
                .projectionBadge=${item.projectionBadge}
                .localize=${this._localize}
                .titleText=${titleText}
                size="compact"
                ?iconOnly=${true}
            ></scheduling-appliance-chip>
        `;
    }

    /** Grouped action items for a slot, flattened when the expanded view is on. */
    private _visibleActionItems(slot: ScheduleSlot): ScheduleTableActionItemModel[] {
        const displaySlot = this._toDisplaySlot(slot);
        const cell = buildScheduleActionCell([displaySlot], this._appliances, this._projectionIndex);
        if (!this._expandedActions) {
            return cell.items;
        }
        return cell.items.flatMap((item) => (item.kind === "appliance_summary" ? item.items : [item]));
    }

    private _actionItemLabel(item: ScheduleTableActionItemModel): string {
        if (item.kind === "inverter") {
            return getScheduleActionLabel(item.action, this._localize);
        }
        if (item.kind === "appliance_summary") {
            return item.items.map((member) => this._actionItemLabel(member)).join(", ");
        }
        const presentation = getScheduleApplianceActionPresentation({
            appliance: item.appliance,
            action: item.action,
            localize: this._localize,
        });
        return `${item.appliance.name} · ${presentation.label}`;
    }

    private _toDisplaySlot(slot: ScheduleSlot): ScheduleBackedDisplaySlot {
        return {
            id: slot.id,
            startMs: slot.startMs,
            endMs: slot.endMs,
            dayKey: slot.dayKey,
            timeLabel: slot.timeLabel,
            endLabel: slot.endLabel,
            rangeLabel: slot.rangeLabel,
            isCurrent: slot.isCurrent,
            source: "schedule",
            scheduleSlot: slot,
        };
    }

    /** Schedule slots that start on the selected day, placed on its 0..1440 timeline. */
    private _buildColumns(): StripColumn[] {
        const columns: StripColumn[] = [];
        for (const slot of this._normalizedSlots) {
            if (slot.dayKey !== this.date) {
                continue;
            }
            const startParts = getScheduleLocalTimeParts(slot.startMs, this.timeZone);
            if (startParts === null) {
                continue;
            }
            const startMinutes = startParts.hour * 60 + startParts.minute;
            const endMinutes = this._resolveEndMinutes(slot, startMinutes);
            columns.push({ slot, startMinutes, endMinutes });
        }
        return columns;
    }

    /** End minute-of-day, clamped to midnight when the slot runs into the next day. */
    private _resolveEndMinutes(slot: ScheduleSlot, startMinutes: number): number {
        if (slot.endMs === null) {
            return MINUTES_PER_DAY;
        }
        const endParts = getScheduleLocalTimeParts(slot.endMs, this.timeZone);
        if (endParts === null || endParts.dayKey !== this.date) {
            return MINUTES_PER_DAY;
        }
        const endMinutes = endParts.hour * 60 + endParts.minute;
        return endMinutes > startMinutes ? endMinutes : MINUTES_PER_DAY;
    }

    private _fraction(minutes: number, geometry: ScheduleStripGeometry): number {
        const clamped = Math.max(0, Math.min(MINUTES_PER_DAY, minutes));
        return (geometry.marginLeft + (clamped / MINUTES_PER_DAY) * geometry.plotWidth) / geometry.width;
    }

    private _handleColumnClick(event: MouseEvent, slotId: string): void {
        if (event.shiftKey || event.ctrlKey || event.metaKey) {
            const next = applyScheduleSlotSelection({
                orderedSlotIds: this._orderedSlotIds,
                selectedSlotIds: this._selectedSlotIds,
                anchorSlotIds: this._selectionAnchorSlotIds,
                detail: { slotId, shiftKey: event.shiftKey },
            });
            this._selectedSlotIds = next.selectedSlotIds;
            this._selectionAnchorSlotIds = next.anchorSlotIds;
            return;
        }
        this._openDialog(slotId);
    }

    private _openDialog(slotId: string): void {
        const selectionIds = resolveScheduleDialogSelectionIds({
            orderedSlotIds: this._orderedSlotIds,
            selectedSlotIds: this._selectedSlotIds,
            targetSlotIds: [slotId],
        });
        const selectedIdSet = new Set(selectionIds);
        const selectedSlots = this._normalizedSlots.filter((slot) => selectedIdSet.has(slot.id));
        if (selectedSlots.length === 0) {
            return;
        }
        this._dialogState = {
            selectedSlots,
            selectionSummary: buildScheduleRangeEditSelectionSummary({
                selectedSlots,
                appliances: this._appliances,
            }),
            authorshipSummary: buildScheduleRangeEditAuthorshipSummary({
                selectedSlots,
                appliances: this._appliances,
            }),
        };
        this._dialogOpen = true;
    }

    private _handleDialogSubmit(event: CustomEvent<ScheduleRangeEditIntent>): void {
        event.stopPropagation();
        if (!this._dialogState) {
            return;
        }
        try {
            this._pendingDialogPatches = buildScheduleSlotPatches({
                selectedSlots: this._dialogState.selectedSlots,
                result: event.detail,
            });
        } catch (error) {
            console.error("helman-solar-inspector: failed to build schedule patches", error);
            return;
        }
        this._dialogOpen = false;
    }

    private async _handleDialogClosed(event: Event): Promise<void> {
        event.stopPropagation();
        const pending = this._pendingDialogPatches;
        this._dialogOpen = false;
        this._dialogState = null;
        this._pendingDialogPatches = null;
        if (!pending || pending.length === 0) {
            return;
        }
        await this._scheduleOwner?.applySchedulePatches(pending);
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
        if (scheduleChanged) {
            this._projectionLoadGeneration += 1;
            this._projectionIndex = EMPTY_SCHEDULE_APPLIANCE_PROJECTION_INDEX;
            if (snapshot.schedule !== null) {
                void this._loadProjections();
            }
        }
    }

    private async _loadAppliances(): Promise<void> {
        const hass = this.hass;
        if (!hass || this._appliancesRequested) {
            return;
        }
        this._appliancesRequested = true;
        try {
            const payload = await getSharedHelmanStore(hass).getAppliances();
            if (this.hass?.connection !== hass.connection) {
                return;
            }
            this._appliances = normalizeScheduleApplianceMetadata(payload);
        } catch (error) {
            if (this.hass?.connection !== hass.connection) {
                return;
            }
            this._appliancesRequested = false;
            this._appliances = [];
            console.error("helman-solar-inspector: failed to load appliance metadata", error);
        }
    }

    private async _loadProjections(): Promise<void> {
        const hass = this.hass;
        if (!hass) {
            return;
        }
        const generation = this._projectionLoadGeneration;
        try {
            const payload = await getSharedHelmanStore(hass).getApplianceProjections();
            if (generation !== this._projectionLoadGeneration || this.hass?.connection !== hass.connection) {
                return;
            }
            this._projectionIndex = buildScheduleApplianceProjectionIndex(payload);
        } catch (error) {
            if (generation !== this._projectionLoadGeneration || this.hass?.connection !== hass.connection) {
                return;
            }
            this._projectionIndex = EMPTY_SCHEDULE_APPLIANCE_PROJECTION_INDEX;
            console.error("helman-solar-inspector: failed to load appliance projections", error);
        }
    }

    private _rebuildNormalizedIfNeeded(): void {
        const schedule = this._ownerSnapshot.schedule;
        if (
            this._normalizedFor !== null
            && this._normalizedFor.schedule === schedule
            && this._normalizedFor.timeZone === this.timeZone
        ) {
            return;
        }
        this._normalizedSlots = buildNormalizedScheduleStructure({
            schedule,
            timeZone: this.timeZone,
            locale: this._locale,
        }).slots;
        this._normalizedFor = { schedule, timeZone: this.timeZone };
        // Drop selection ids no longer present in the schedule.
        const validIds = new Set(this._normalizedSlots.map((slot) => slot.id));
        const prunedSelected = this._selectedSlotIds.filter((id) => validIds.has(id));
        if (prunedSelected.length !== this._selectedSlotIds.length) {
            this._selectedSlotIds = prunedSelected;
        }
        this._selectionAnchorSlotIds = this._selectionAnchorSlotIds?.filter((id) => validIds.has(id)) ?? null;
        if (this._selectionAnchorSlotIds && this._selectionAnchorSlotIds.length === 0) {
            this._selectionAnchorSlotIds = null;
        }
    }

    private get _orderedSlotIds(): string[] {
        return this._normalizedSlots.map((slot) => slot.id);
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

    private _t(key: string): string {
        return this._localize(key);
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-solar-schedule-actions-strip": HelmanSolarScheduleActionsStrip;
    }
}
