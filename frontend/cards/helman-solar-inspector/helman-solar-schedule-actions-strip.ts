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
import { getScheduleLocalTimeParts, getScheduleTimeRangeLabels } from "../helman-scheduling/model/schedule-time";
import { SLOT_MINUTES } from "./chart-stack";
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
    /** Minute-of-day at the plot's left edge; defaults to 0 (whole day). */
    startMinutes?: number;
    /** Minute-of-day at the plot's right edge; defaults to 1440 (whole day). */
    endMinutes?: number;
}

/** The minute-of-day window the plot spans, defaulting to the whole day. */
export function stripWindow(geometry: ScheduleStripGeometry): { start: number; end: number } {
    const start = geometry.startMinutes ?? 0;
    const end = geometry.endMinutes ?? MINUTES_PER_DAY;
    return end > start ? { start, end } : { start: 0, end: MINUTES_PER_DAY };
}

/** Invert a strip's x mapping: a viewBox x back to its minute-of-day, or null in the gutter. */
export function stripMinutesForSvgX(geometry: ScheduleStripGeometry, svgX: number): number | null {
    const plotRight = geometry.marginLeft + geometry.plotWidth;
    if (svgX < geometry.marginLeft || svgX > plotRight) {
        return null;
    }
    const { start, end } = stripWindow(geometry);
    return start + ((svgX - geometry.marginLeft) / geometry.plotWidth) * (end - start);
}

/**
 * One or more schedule slots placed on the selected day's timeline. When the
 * inspector collapses its slots (30/60 min), contiguous schedule slots that fall
 * in the same wider bucket merge into one column whose action chips are the
 * deduped union across them — the same collapsing the scheduling card applies to
 * its hour rows. A single-slot column carries exactly one slot.
 */
interface StripColumn {
    slots: ScheduleSlot[];
    startMinutes: number;
    endMinutes: number;
    rangeLabel: string;
}

/** One schedule slot resolved onto the day's minute timeline, before collapsing. */
interface PlacedSlot {
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

        /* The multi-select for bulk editing (shift/ctrl-click): a solid outline so
           it stays legible over the selection/hover bands drawn behind it. */
        .slot-col.selected {
            box-shadow: inset 0 0 0 1px rgba(37, 99, 235, 0.9);
            border-radius: 4px;
        }

        /* The selected/hover slot bands, aligned to the chart's time axis and coloured
           to match the highlights the inspector draws on every chart: blue for the
           selected slot, orange for the hovered one. Drawn behind the action chips. */
        .range-band {
            position: absolute;
            top: 0;
            bottom: 0;
            pointer-events: none;
            border-radius: 4px;
            box-sizing: border-box;
        }

        .range-band.selected {
            background: rgba(37, 99, 235, 0.13);
            box-shadow: inset 0 0 0 1px rgba(37, 99, 235, 0.5);
        }

        .range-band.hover {
            background: rgba(245, 158, 11, 0.14);
            box-shadow: inset 0 0 0 1px rgba(245, 158, 11, 0.55);
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
    /** Inspector slot width, in minutes; wider than 15 collapses action columns. */
    @property({ attribute: false }) public slotMinutes = SLOT_MINUTES;
    /** Minute-of-day of the inspector's selected slot; its column reads as selected (blue). */
    @property({ attribute: false }) public selectedMinutes: number | null = null;
    /** Minute-of-day under the pointer; its column reads as hovered (orange). */
    @property({ attribute: false }) public hoverMinutes: number | null = null;

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
        this._emitHover(null);
        this._unsubscribeOwner?.();
        this._unsubscribeOwner = undefined;
        this._scheduleOwner = undefined;
    }

    render() {
        if (!this.hass || this.geometry === null) {
            return nothing;
        }

        // Drop columns cropped out of the plot's window, so daylight-only view
        // doesn't pile every night-time action's chips up at the axis edge.
        const { start, end } = stripWindow(this.geometry);
        const columns = this._buildColumns().filter(
            (column) => column.endMinutes > start && column.startMinutes < end,
        );
        if (columns.length === 0) {
            return nothing;
        }

        const rowCount = Math.max(
            1,
            ...columns.map((column) => this._visibleActionItems(column.slots).length),
        );
        // Each stacked icon-only chip is ~20px tall with a 2px gap, plus 4px padding.
        const innerHeight = rowCount * 20 + (rowCount - 1) * 2 + 4;

        const toggleLabel = this._t("bias_correction.inspector.scheduled_actions");
        return html`
            <div class="strip-wrap">
                <div
                    class="strip-inner"
                    style=${`height:${innerHeight}px;`}
                    @mousemove=${(event: MouseEvent) => this._handleHover(event)}
                    @mouseleave=${() => this._emitHover(null)}
                >
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
                    ${this._renderRangeBand(columns, this.selectedMinutes, "selected")}
                    ${this._renderRangeBand(columns, this.hoverMinutes, "hover")}
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

    /**
     * The blue selection or orange hover band. A minute lands inside at most one
     * action column, and the band covers that whole column — so the highlight reads
     * as the action's true width, not the finer slot the minute came from.
     */
    private _renderRangeBand(columns: StripColumn[], minutes: number | null, kind: "selected" | "hover") {
        if (minutes === null || this.geometry === null) {
            return nothing;
        }
        const column = columns.find((c) => minutes >= c.startMinutes && minutes < c.endMinutes);
        if (!column) {
            return nothing;
        }
        const leftPct = this._fraction(column.startMinutes, this.geometry) * 100;
        const rightPct = this._fraction(column.endMinutes, this.geometry) * 100;
        const widthPct = Math.max(0, rightPct - leftPct);
        return html`
            <div class=${`range-band ${kind}`} style=${`left:${leftPct}%;width:${widthPct}%;`}></div>
        `;
    }

    private _renderColumn(column: StripColumn) {
        const geometry = this.geometry!;
        const leftPct = this._fraction(column.startMinutes, geometry) * 100;
        const rightPct = this._fraction(column.endMinutes, geometry) * 100;
        const widthPct = Math.max(0, rightPct - leftPct);
        const selected = column.slots.some((slot) => this._selectedSlotIds.includes(slot.id));
        const items = this._visibleActionItems(column.slots);
        return html`
            <button
                class=${`slot-col${selected ? " selected" : ""}`}
                type="button"
                style=${`left:${leftPct}%;width:${widthPct}%;`}
                title=${column.rangeLabel}
                aria-label=${column.rangeLabel}
                @click=${(event: MouseEvent) => this._handleColumnClick(event, column)}
            >
                ${items.map((item) => this._renderActionItem(item))}
            </button>
        `;
    }

    /**
     * Publish the pointer's minute-of-day so the inspector can light this row's
     * column and every chart's own slot at that time. A position in the axis gutter
     * carries `null`.
     */
    private _handleHover(event: MouseEvent): void {
        const geometry = this.geometry;
        if (geometry === null) {
            return;
        }
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        const svgX = ((event.clientX - rect.left) / rect.width) * geometry.width;
        this._emitHover(stripMinutesForSvgX(geometry, svgX));
    }

    private _emitHover(minutes: number | null): void {
        this.dispatchEvent(new CustomEvent<{ minutes: number | null }>("slot-hover", {
            detail: { minutes },
            bubbles: true,
            composed: true,
        }));
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

    /**
     * Grouped action items across a column's slots — the deduped union when the
     * column collapses several slots — flattened when the expanded view is on.
     */
    private _visibleActionItems(slots: readonly ScheduleSlot[]): ScheduleTableActionItemModel[] {
        const displaySlots = slots.map((slot) => this._toDisplaySlot(slot));
        const cell = buildScheduleActionCell(displaySlots, this._appliances, this._projectionIndex);
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
        const placed: PlacedSlot[] = [];
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
            placed.push({ slot, startMinutes, endMinutes });
        }
        placed.sort((left, right) => left.startMinutes - right.startMinutes);
        return this._collapseColumns(placed);
    }

    /**
     * Merge contiguous slots that share a wider bucket into one column, mirroring
     * the scheduling card's hour collapsing generalised to the inspector's slot
     * width. A slot only joins a bucket when it abuts the previous one and stays
     * inside the bucket's span, so gaps and slots wider than the bucket keep their
     * own column. At the native width no slot shares a bucket, so nothing merges.
     */
    private _collapseColumns(placed: PlacedSlot[]): StripColumn[] {
        const width = this.slotMinutes;
        const columns: StripColumn[] = [];
        let index = 0;
        while (index < placed.length) {
            const group = [placed[index]];
            if (width > SLOT_MINUTES) {
                const bucket = Math.floor(placed[index].startMinutes / width);
                let next = index + 1;
                while (next < placed.length) {
                    const candidate = placed[next];
                    const previous = group[group.length - 1];
                    const sameBucket = Math.floor(candidate.startMinutes / width) === bucket;
                    const contiguous = candidate.startMinutes === previous.endMinutes;
                    const withinBucket = candidate.endMinutes <= (bucket + 1) * width;
                    if (!sameBucket || !contiguous || !withinBucket) {
                        break;
                    }
                    group.push(candidate);
                    next += 1;
                }
                index = next;
            } else {
                index += 1;
            }
            columns.push(this._mergeGroup(group));
        }
        return columns;
    }

    private _mergeGroup(group: PlacedSlot[]): StripColumn {
        const slots = group.map((entry) => entry.slot);
        const first = group[0];
        const last = group[group.length - 1];
        const rangeLabel = slots.length === 1
            ? first.slot.rangeLabel
            : getScheduleTimeRangeLabels({
                startMs: first.slot.startMs,
                endMs: last.slot.endMs,
                locale: this._locale,
                timeZone: this.timeZone,
            }).rangeLabel;
        return {
            slots,
            startMinutes: first.startMinutes,
            endMinutes: last.endMinutes,
            rangeLabel,
        };
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
        const { start, end } = stripWindow(geometry);
        const clamped = Math.max(start, Math.min(end, minutes));
        return (geometry.marginLeft + ((clamped - start) / (end - start)) * geometry.plotWidth) / geometry.width;
    }

    private _handleColumnClick(event: MouseEvent, column: StripColumn): void {
        const slotIds = column.slots.map((slot) => slot.id);
        if (slotIds.length === 0) {
            return;
        }
        if (event.shiftKey || event.ctrlKey || event.metaKey) {
            const next = applyScheduleSlotSelection({
                orderedSlotIds: this._orderedSlotIds,
                selectedSlotIds: this._selectedSlotIds,
                anchorSlotIds: this._selectionAnchorSlotIds,
                detail: { slotId: slotIds[0], slotIds, shiftKey: event.shiftKey },
            });
            this._selectedSlotIds = next.selectedSlotIds;
            this._selectionAnchorSlotIds = next.anchorSlotIds;
            return;
        }
        // A collapsed column edits every slot it merges, so a wide-slot edit lands
        // on the whole bucket at once — the scheduling card's collapsed-hour click.
        this._openDialog(slotIds);
    }

    private _openDialog(targetSlotIds: string[]): void {
        const selectionIds = resolveScheduleDialogSelectionIds({
            orderedSlotIds: this._orderedSlotIds,
            selectedSlotIds: this._selectedSlotIds,
            targetSlotIds,
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
