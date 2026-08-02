import { LitElement, css, html } from "lit-element";
import { customElement, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import type { LovelaceCard } from "../../hass-frontend/src/panels/lovelace/types";
import type { AutomationRunPayload, ForecastPayload, SchedulePayload } from "../helman-api";
import { AutomationRunModel } from "./model/automation-run-model";
import { ForecastLoader } from "../helman/forecast-loader";
import { getSharedHelmanStore } from "../helman/store";
import type { ControllableEntityDTO, EntityActualHistorySlotDTO } from "../helman-api";
import {
    buildControllableEntityStatuses,
    type ControllableEntityStatus,
} from "./model/controllable-entity-status";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import type { HelmanSchedulingCardConfig } from "./HelmanSchedulingCardConfig";
import "./components/scheduling-card-header";
import "./components/scheduling-running-entities";
import "./components/scheduling-slot-table";
import "./dialogs/scheduling-entity-day-editor";
import "./dialogs/scheduling-range-edit-dialog";
import "../shared/forecast-health-banner";
import { buildForecastHealthItems } from "../shared/forecast-health-banner";
import {
    explanationCacheKey,
    type ScheduleExplanationRequestDetail,
} from "./components/scheduling-slot-table";

import type { OpenEntityScheduleDetail } from "./components/scheduling-running-entities";
import type { EntityScheduleSaveDetail } from "./dialogs/scheduling-entity-day-editor";
import type {
    EntityScheduleLane,
    EntityScheduleTarget,
} from "./model/entity-day-schedule-model";
import {
    buildEntityScheduleDayView,
    buildEntityScheduleLanes,
} from "./model/entity-lane-source";
import {
    getScheduleApplianceById,
    normalizeScheduleApplianceMetadata,
    type ScheduleApplianceMetadata,
} from "./model/schedule-appliance-metadata";
import {
    buildScheduleApplianceProjectionIndex,
    EMPTY_SCHEDULE_APPLIANCE_PROJECTION_INDEX,
    type ScheduleApplianceProjectionIndex,
} from "./model/schedule-appliance-projection";
import {
    buildScheduleHeaderModel,
    type ScheduleHeaderModel,
} from "./model/schedule-header-model";
import { getScheduleErrorLabel } from "./model/schedule-labels";
import {
    buildScheduleRangeEditAuthorshipSummary,
    buildScheduleRangeEditSelectionSummary,
} from "./model/schedule-range-edit-selection-summary";
import { InvalidScheduleAuthorshipError } from "./model/schedule-authorship";
import {
    applyNormalizedScheduleCurrentState,
    buildNormalizedScheduleStructure,
} from "./model/schedule-normalizer";
import { buildScheduleSlotPatches } from "./model/schedule-patch-builder";
import {
    applyScheduleSlotSelection,
    buildSelectedSlotIdsInScheduleOrder,
    resolveScheduleDialogSelectionIds,
    resolveTargetSlotIds,
} from "./model/schedule-selection";
import { buildScheduleTableModel } from "./model/schedule-table-builder";
import {
    applyScheduleTimelineCurrentState,
    buildScheduleTimelineStructure,
} from "./model/schedule-timeline-builder";
import {
    buildSlotForecastProjection,
    deriveScheduleForecastParams,
    EMPTY_SLOT_FORECAST_MAP,
    EMPTY_SLOT_FORECAST_PROJECTION,
    getSlotForecastProjectionKey,
    materializeSlotForecastMap,
    type SlotForecastMap,
    type SlotForecastPoint,
    type SlotForecastProjection,
} from "./model/slot-forecast-model";
import { getSharedScheduleOwner, type SharedScheduleOwner } from "./schedule-owner";
import {
    type ScheduleActionViewToggleDetail,
    EMPTY_SCHEDULE_TABLE_MODEL,
    type ScheduleDayToggleDetail,
    type ScheduleHourToggleDetail,
    type ScheduleTableModel,
} from "./schedule-table-types";
import type {
    NormalizedScheduleModel,
    ScheduleDialogOpenDetail,
    ScheduleDialogState,
    ScheduleOwnerSnapshot,
    ScheduleRangeEditIntent,
    ScheduleSlot,
    ScheduleSlotPatch,
    ScheduleSlotToggleDetail,
    ScheduleTimelineModel,
} from "./schedule-types";
import { schedulingSharedStyles } from "./styles/scheduling-shared-styles";

const EMPTY_SCHEDULE_OWNER_SNAPSHOT: ScheduleOwnerSnapshot = {
    schedule: null,
    loading: false,
    refreshing: false,
    writing: false,
    togglingExecution: false,
    error: null,
    updatedAt: null,
    stale: false,
};

const EMPTY_NORMALIZED_SCHEDULE: NormalizedScheduleModel = {
    slots: [],
    currentSlotId: null,
    currentDayKey: null,
    granularityMinutes: null,
};

const EMPTY_SCHEDULE_TIMELINE: ScheduleTimelineModel = {
    slots: [],
    currentSlotId: null,
};

@customElement("helman-scheduling-card")
export class HelmanSchedulingCard extends LitElement implements LovelaceCard {
    public static async getStubConfig(_hass: HomeAssistant): Promise<Partial<HelmanSchedulingCardConfig>> {
        return { type: "custom:helman-scheduling-card" };
    }

    static styles = [
        schedulingSharedStyles,
        css`
            :host {
                display: block;
            }

            ha-card {
                overflow: hidden;
            }

            ha-card.transparent {
                background: transparent;
                box-shadow: none;
                border: none;
            }

            .card-content {
                display: flex;
                flex-direction: column;
                gap: 12px;
                padding: 12px;
            }
        `,
    ];

    private _config!: HelmanSchedulingCardConfig;
    private _localizeFn?: LocalizeFunction;
    private _scheduleOwner?: SharedScheduleOwner;
    private _unsubscribeScheduleOwner?: () => void;
    private _timelineBoundaryTimer: number | null = null;
    private _normalizedSchedule: NormalizedScheduleModel = EMPTY_NORMALIZED_SCHEDULE;
    private _timelineModel: ScheduleTimelineModel = EMPTY_SCHEDULE_TIMELINE;
    private _tableModel: ScheduleTableModel = EMPTY_SCHEDULE_TABLE_MODEL;
    private _forecastLoader: ForecastLoader | null = null;
    private _forecastLoaderGranularity: number | null = null;
    private _forecastLoaderDays: number | null = null;
    private _forecastLoadGeneration = 0;
    private _applianceProjectionLoadGeneration = 0;
    private _slotForecastProjection: SlotForecastProjection = EMPTY_SLOT_FORECAST_PROJECTION;
    private _slotForecastProjectionKey = "";
    private _slotForecastMap: SlotForecastMap = EMPTY_SLOT_FORECAST_MAP;
    private _pendingDialogPatches: ScheduleSlotPatch[] | null = null;
    private _selectionAnchorSlotIds: string[] | null = null;
    private _appliancesRequested = false;
    private _controllableEntitiesRequested = false;

    @state() private _hass?: HomeAssistant;
    @state() private _ownerSnapshot: ScheduleOwnerSnapshot = EMPTY_SCHEDULE_OWNER_SNAPSHOT;
    @state() private _forecast: ForecastPayload | null = null;
    @state() private _appliances: ScheduleApplianceMetadata[] = [];
    @state() private _applianceProjectionIndex: ScheduleApplianceProjectionIndex = EMPTY_SCHEDULE_APPLIANCE_PROJECTION_INDEX;
    @state() private _appliancesError: string | null = null;
    @state() private _selectedSlotIds: string[] = [];
    @state() private _dialogState: ScheduleDialogState | null = null;
    @state() private _dialogOpen = false;
    @state() private _dayExpansionOverrides: Record<string, boolean> = {};
    @state() private _expandedHourKeys: string[] = [];
    @state() private _expandedApplianceActions = false;
    @state() private _nowMs = Date.now();
    @state() private _invalidScheduleAuthorship = false;
    @state() private _automationModel: AutomationRunModel | null = null;
    @state() private _controllableEntities: ControllableEntityDTO[] = [];
    @state() private _runningExpanded = false;
    @state() private _entityEditorTarget: EntityScheduleTarget | null = null;
    @state() private _entityEditorName = "";
    @state() private _entityEditorOpen = false;
    @state() private _entityEditorScheduleChanged = false;
    /**
     * The editor's own view of the schedule: today padded back to midnight, and
     * the forecast points that go with it.
     *
     * Snapshotted when the dialog opens, like the editor's own baseline, and
     * kept out of the card's shared slot array so the table and the timeline
     * keep showing the horizon alone.
     */
    @state() private _entityEditorSlots: ScheduleSlot[] = [];
    @state() private _entityEditorForecastPoints: ReadonlyMap<string, SlotForecastPoint> = new Map();
    /** What each controllable entity really did earlier today, by entity id. */
    @state() private _entityActualHistory: Record<string, EntityActualHistorySlotDTO[]> = {};
    /**
     * Lane records for the slot table's "why" popover, by lane and day.
     *
     * These accumulate because the popover is asked the same question about
     * neighbouring rows over and over, and one record answers a whole day of
     * one lane. The day editor's Explain mode fetches its own, because it wants
     * every lane of one day rather than one lane of whatever is on screen.
     */
    @state() private _explanationCache: ReadonlyMap<string, unknown> = new Map();
    /** Lanes already asked for, so a re-press does not refetch. */
    private readonly _explanationRequested = new Set<string>();

    private _automationRequested = false;

    public set hass(value: HomeAssistant) {
        const previous = this._hass;
        const shouldReloadSchedule = previous?.connection !== value?.connection;
        this._hass = value;
        this._localizeFn = value ? getLocalizeFunction(value) : undefined;

        if (shouldReloadSchedule) {
            this._detachScheduleOwner();
            this._resetScheduleState();
        }

        if (this.isConnected) {
            this._syncScheduleOwner();
            void this._loadAppliances();
            void this._loadAutomationTrace();
            void this._loadControllableEntities();
        }

        this.requestUpdate("hass", previous);
    }

    getCardSize() {
        return 4;
    }

    setConfig(config: HelmanSchedulingCardConfig) {
        this._config = {
            transparent_background: false,
            default_expanded_days: 1,
            show_header: true,
            ...config,
            default_expanded_days: this._normalizeDefaultExpandedDays(config.default_expanded_days),
        };
    }

    connectedCallback(): void {
        super.connectedCallback();
        this._syncScheduleOwner();
        void this._loadAppliances();
        void this._loadAutomationTrace();
        void this._loadControllableEntities();
    }

    private async _loadAutomationTrace(): Promise<void> {
        const hass = this._hass;
        if (!hass || this._automationRequested) return;
        this._automationRequested = true;
        try {
            const payload = await hass.callWS<AutomationRunPayload>({
                type: "helman/get_last_automation_run",
            });
            this._automationModel = payload
                ? AutomationRunModel.fromPayload(payload)
                : null;
        } catch {
            // The "why" popover is a best-effort enhancement; a failed load just
            // means no badges appear.
            this._automationModel = null;
        }
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        this._clearTimelineBoundaryTick();
        this._detachScheduleOwner();
    }

    willUpdate(changedProperties: Map<string, unknown>): void {
        super.willUpdate(changedProperties);
        if (!this._hass) {
            this._normalizedSchedule = EMPTY_NORMALIZED_SCHEDULE;
            this._timelineModel = EMPTY_SCHEDULE_TIMELINE;
            this._slotForecastProjection = EMPTY_SLOT_FORECAST_PROJECTION;
            this._slotForecastProjectionKey = "";
            this._tableModel = EMPTY_SCHEDULE_TABLE_MODEL;
            this._slotForecastMap = EMPTY_SLOT_FORECAST_MAP;
            return;
        }

        const previousOwnerSnapshot = changedProperties.get("_ownerSnapshot") as ScheduleOwnerSnapshot | undefined;
        const scheduleChanged = changedProperties.has("_ownerSnapshot")
            && previousOwnerSnapshot?.schedule !== this._ownerSnapshot.schedule;
        const forecastChanged = changedProperties.has("_forecast")
            && changedProperties.get("_forecast") !== this._forecast;
        const nowChanged = changedProperties.has("_nowMs");

        if (scheduleChanged) {
            try {
                this._normalizedSchedule = buildNormalizedScheduleStructure({
                    schedule: this._ownerSnapshot.schedule,
                    timeZone: this._hass.config.time_zone ?? "UTC",
                    locale: this._locale,
                });
                this._invalidScheduleAuthorship = false;
            } catch (error) {
                if (!(error instanceof InvalidScheduleAuthorshipError)) {
                    throw error;
                }

                console.error(error.message, error);
                this._invalidScheduleAuthorship = true;
                this._normalizedSchedule = EMPTY_NORMALIZED_SCHEDULE;
                this._timelineModel = EMPTY_SCHEDULE_TIMELINE;
                this._slotForecastProjection = EMPTY_SLOT_FORECAST_PROJECTION;
                this._slotForecastProjectionKey = "";
                this._tableModel = EMPTY_SCHEDULE_TABLE_MODEL;
                this._slotForecastMap = EMPTY_SLOT_FORECAST_MAP;
                this._selectedSlotIds = [];
                this._selectionAnchorSlotIds = null;
                this._dialogState = null;
                this._dialogOpen = false;
                this._pendingDialogPatches = null;
            }

            const validSlotIds = new Set(this._normalizedSchedule.slots.map((slot) => slot.id));
            const nextSelectedSlotIds = this._selectedSlotIds.filter((id) => validSlotIds.has(id));
            if (nextSelectedSlotIds.length !== this._selectedSlotIds.length) {
                this._selectedSlotIds = nextSelectedSlotIds;
            }
            const nextSelectionAnchorSlotIds = this._selectionAnchorSlotIds?.filter((id) => validSlotIds.has(id)) ?? null;
            if (!this._areSlotIdListsEqual(this._selectionAnchorSlotIds, nextSelectionAnchorSlotIds)) {
                this._selectionAnchorSlotIds = nextSelectionAnchorSlotIds && nextSelectionAnchorSlotIds.length > 0
                    ? nextSelectionAnchorSlotIds
                    : null;
            }

            if (this._dialogState && scheduleChanged) {
                this._dialogOpen = false;
                this._pendingDialogPatches = null;
            }

            // The entity editor holds a whole day of unsaved work, so a refresh
            // underneath it is reported rather than acted on: closing would
            // throw the draft away, and re-seeding would rewrite it.
            if (this._entityEditorOpen) {
                this._entityEditorScheduleChanged = true;
            }
        }

        if (!this._invalidScheduleAuthorship && (scheduleChanged || nowChanged)) {
            this._normalizedSchedule = applyNormalizedScheduleCurrentState(
                this._normalizedSchedule,
                this._hass.config.time_zone ?? "UTC",
                new Date(this._nowMs),
            );
        }

        let slotTopologyChanged = false;
        if (!this._invalidScheduleAuthorship && (scheduleChanged || forecastChanged)) {
            this._timelineModel = buildScheduleTimelineStructure({
                normalizedSchedule: this._normalizedSchedule,
                forecast: this._forecast,
                locale: this._locale,
                timeZone: this._hass.config.time_zone ?? "UTC",
            });
            const nextProjectionKey = getSlotForecastProjectionKey(this._timelineModel.slots);
            slotTopologyChanged = nextProjectionKey !== this._slotForecastProjectionKey;
            this._slotForecastProjectionKey = nextProjectionKey;
        }

        if (!this._invalidScheduleAuthorship && (scheduleChanged || forecastChanged || nowChanged)) {
            this._timelineModel = applyScheduleTimelineCurrentState(
                this._timelineModel,
                new Date(this._nowMs),
            );
        }

        if (scheduleChanged || forecastChanged) {
            this._pruneDayExpansionOverrides(this._collectTimelineDayKeys());
        }

        if (!this._invalidScheduleAuthorship && (forecastChanged || slotTopologyChanged)) {
            this._slotForecastProjection = buildSlotForecastProjection(this._forecast, this._timelineModel.slots);
        }

        if (!this._invalidScheduleAuthorship && (forecastChanged || slotTopologyChanged || nowChanged)) {
            this._slotForecastMap = materializeSlotForecastMap(this._slotForecastProjection, this._timelineModel.slots);
        }

        if (
            !this._invalidScheduleAuthorship
            && (
                scheduleChanged
                || forecastChanged
                || changedProperties.has("_appliances")
                || changedProperties.has("_applianceProjectionIndex")
                || changedProperties.has("_expandedHourKeys")
                || nowChanged
            )
        ) {
            this._tableModel = buildScheduleTableModel({
                slots: this._timelineModel.slots,
                appliances: this._appliances,
                applianceProjectionIndex: this._applianceProjectionIndex,
                slotForecastMap: this._slotForecastMap,
                expandedHourKeys: this._expandedHourKeys,
                locale: this._locale,
                timeZone: this._hass.config.time_zone ?? "UTC",
                currentDayKey: this._normalizedSchedule.currentDayKey,
                todayLabel: this._localize("scheduling.day.today"),
                tomorrowLabel: this._localize("scheduling.day.tomorrow"),
                executionEnabled: this._ownerSnapshot.schedule?.executionEnabled ?? false,
                localize: this._localize,
            });
            this._pruneExpandedHourKeys();
        }
    }

    updated(): void {
        super.updated();
        this._scheduleTimelineBoundaryTick();
    }

    render() {
        if (!this._hass) {
            return html`<ha-card class=${this._config?.transparent_background ? "transparent" : ""}></ha-card>`;
        }

        const controllableEntityStatuses = this._controllableEntityStatuses;

        return html`
            <ha-card
                class=${this._config?.transparent_background ? "transparent" : ""}
                @refresh-schedule=${this._handleRefresh}
                @toggle-schedule-execution=${this._handleToggleExecution}
                @toggle-running-entities=${this._handleToggleRunningEntities}
                @toggle-schedule-slot-selection=${this._handleToggleSlotSelection}
                @toggle-schedule-day-expansion=${this._handleToggleDayExpansion}
                @toggle-schedule-hour-expansion=${this._handleToggleHourExpansion}
                @toggle-schedule-action-view=${this._handleToggleActionView}
                @open-schedule-dialog=${this._handleOpenDialog}
                @open-entity-schedule=${this._handleOpenEntityEditor}
            >
                <div class="card-content">
                    ${this._config.show_header ? html`
                        <scheduling-card-header
                            .model=${this._buildHeaderModel(controllableEntityStatuses)}
                        ></scheduling-card-header>
                    ` : nothing}

                    ${this._runningExpanded ? html`
                        <scheduling-running-entities
                            .hass=${this._hass}
                            .localize=${this._localize}
                            .entities=${controllableEntityStatuses}
                            .executionEnabled=${this._ownerSnapshot.schedule?.executionEnabled ?? false}
                            .nowMs=${this._nowMs}
                        ></scheduling-running-entities>
                    ` : nothing}

                    ${this._renderInlineError()}
                    ${this._renderApplianceError()}

                    <!-- One per card, above the table it qualifies: the whole
                         table is drawn off this forecast, so the warning belongs
                         to all of it rather than to any one row. -->
                    <helman-forecast-health-banner
                        .items=${buildForecastHealthItems(this._forecast, this._localize)}
                        .localize=${this._localize}
                    ></helman-forecast-health-banner>

                    ${this._ownerSnapshot.schedule === null
                        ? this._renderEmptyState()
                        : this._invalidScheduleAuthorship
                        ? nothing
                        : html`
                            <scheduling-slot-table
                                .tableModel=${this._tableModel}
                                .expandedDayKeys=${this._buildExpandedDayKeys()}
                                .appliances=${this._appliances}
                                .selectedSlotIds=${this._selectedSlotIds}
                                .localize=${this._localize}
                                .busy=${this._ownerSnapshot.writing || this._ownerSnapshot.togglingExecution}
                                .executionEnabled=${this._ownerSnapshot.schedule?.executionEnabled ?? false}
                                .expandedApplianceActions=${this._expandedApplianceActions}
                                .automationModel=${this._automationModel}
                                .explanations=${this._explanationCache}
                                @schedule-explanation-request=${this._handleExplanationRequest}
                            ></scheduling-slot-table>
                        `}
                </div>
            </ha-card>

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

            ${this._entityEditorTarget ? html`
                <scheduling-entity-day-editor
                    .hass=${this._hass}
                    .open=${this._entityEditorOpen}
                    .localize=${this._localize}
                    .target=${this._entityEditorTarget}
                    .appliance=${this._entityEditorAppliance}
                    .lanes=${this._buildEntityEditorLanes(controllableEntityStatuses)}
                    .slots=${this._entityEditorSlots}
                    .forecastPoints=${this._entityEditorForecastPoints}
                    .projectionIndex=${this._applianceProjectionIndex}
                    .priceUnit=${this._slotForecastMap.priceDisplayUnit}
                    .entityName=${this._entityEditorName}
                    .entityIcon=${this._entityEditorAppliance?.icon ?? "mdi:flash-outline"}
                    .currentDayKey=${this._normalizedSchedule.currentDayKey}
                    .locale=${this._locale}
                    .timeZone=${this._hass.config.time_zone ?? "UTC"}
                    .nowMs=${this._nowMs}
                    .busy=${this._ownerSnapshot.writing}
                    .scheduleChanged=${this._entityEditorScheduleChanged}
                    @closed=${this._handleEntityEditorClosed}
                    @entity-schedule-save=${this._handleEntityEditorSave}
                ></scheduling-entity-day-editor>
            ` : nothing}
        `;
    }

    /**
     * Fetch the lane record the slot table asked for, once.
     *
     * Failures are silent: the popover falls back to its generic note, which is
     * the same thing it says when the backend recorded nothing for the lane.
     */
    private async _handleExplanationRequest(
        event: CustomEvent<ScheduleExplanationRequestDetail>,
    ): Promise<void> {
        const { targetKey, date } = event.detail;
        const key = explanationCacheKey(targetKey, date);
        const hass = this._hass;
        if (!hass || this._explanationRequested.has(key)) {
            return;
        }
        this._explanationRequested.add(key);
        try {
            const payload = await hass.callWS<unknown>({
                type: "helman/get_schedule_explanation",
                target_key: targetKey,
                date,
            });
            if (payload === null || payload === undefined) {
                return;
            }
            const next = new Map(this._explanationCache);
            next.set(key, payload);
            this._explanationCache = next;
        } catch {
            // Best-effort enhancement: no record just means the generic note.
        }
    }

    private _renderInlineError() {
        if (this._ownerSnapshot.error === null) {
            return nothing;
        }

        const errorLabel = getScheduleErrorLabel({
            code: this._ownerSnapshot.error.code,
            localize: this._localize,
            fallbackMessage: this._ownerSnapshot.error.message,
        });
        const showRawMessage = this._ownerSnapshot.error.message
            && this._ownerSnapshot.error.message !== errorLabel;

        return html`
            <div class="inline-error">
                <div class="inline-error-title">${errorLabel}</div>
                ${this._ownerSnapshot.stale
                    ? html`<div class="muted">${this._localize("scheduling.error.showing_last_good")}</div>`
                    : nothing}
                ${showRawMessage ? html`<div class="muted">${this._ownerSnapshot.error.message}</div>` : nothing}
            </div>
        `;
    }

    private _renderApplianceError() {
        if (this._appliancesError === null) {
            return nothing;
        }

        return html`
            <div class="inline-error">
                <div class="inline-error-title">${this._localize("scheduling.error.appliances_unavailable")}</div>
                <div class="muted">${this._appliancesError}</div>
            </div>
        `;
    }

    private _renderEmptyState() {
        if (this._ownerSnapshot.loading) {
            return html`
                <div class="panel">
                    <div class="muted">${this._localize("card.loading")}</div>
                </div>
            `;
        }

        return html`
            <div class="panel">
                <div class="muted">${this._localize("scheduling.empty")}</div>
            </div>
        `;
    }

    private async _handleRefresh(event: Event): Promise<void> {
        event.stopPropagation();
        this._expandedApplianceActions = false;
        await this._scheduleOwner?.refresh();
    }

    private async _handleToggleExecution(event: CustomEvent<{ enabled: boolean }>): Promise<void> {
        event.stopPropagation();
        await this._scheduleOwner?.setExecutionEnabled(event.detail.enabled);
    }

    private _handleToggleSlotSelection(event: CustomEvent<ScheduleSlotToggleDetail>): void {
        event.stopPropagation();
        const nextSelection = applyScheduleSlotSelection({
            orderedSlotIds: this._orderedSlotIds,
            selectedSlotIds: this._selectedSlotIds,
            anchorSlotIds: this._selectionAnchorSlotIds,
            detail: event.detail,
        });
        this._selectedSlotIds = nextSelection.selectedSlotIds;
        this._selectionAnchorSlotIds = nextSelection.anchorSlotIds;
    }

    private _handleToggleHourExpansion(event: CustomEvent<ScheduleHourToggleDetail>): void {
        event.stopPropagation();
        const { hourKey } = event.detail;
        this._expandedHourKeys = this._expandedHourKeys.includes(hourKey)
            ? this._expandedHourKeys.filter((value) => value !== hourKey)
            : [...this._expandedHourKeys, hourKey];
    }

    private _handleToggleActionView(event: CustomEvent<ScheduleActionViewToggleDetail>): void {
        event.stopPropagation();
        this._expandedApplianceActions = event.detail.expanded;
    }

    private _handleToggleDayExpansion(event: CustomEvent<ScheduleDayToggleDetail>): void {
        event.stopPropagation();
        const dayKeys = this._collectTimelineDayKeys();
        if (!dayKeys.includes(event.detail.dayKey)) {
            return;
        }

        const defaultExpandedDayKeys = this._resolveDefaultExpandedDayKeys(dayKeys);
        const isExpanded = this._isDayExpanded(event.detail.dayKey, defaultExpandedDayKeys);
        this._dayExpansionOverrides = {
            ...this._dayExpansionOverrides,
            [event.detail.dayKey]: !isExpanded,
        };
    }

    private _handleOpenDialog(event: CustomEvent<ScheduleDialogOpenDetail>): void {
        event.stopPropagation();

        const nextSelectedSlotIds = this._resolveDialogSelectionIds(
            this._resolveTargetSlotIds(event.detail.slotId, event.detail.slotIds),
        );
        const selectedSlots = this._getSelectedSlots(nextSelectedSlotIds);
        if (selectedSlots.length === 0) {
            if (nextSelectedSlotIds.length === 0) {
                this._selectedSlotIds = [];
            }
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

    private _handleOpenEntityEditor(event: CustomEvent<OpenEntityScheduleDetail>): void {
        event.stopPropagation();
        if (this._normalizedSchedule.slots.length === 0) {
            return;
        }

        this._seedEntityEditorSlots();
        void this._loadEntityActualHistory();
        this._entityEditorTarget = event.detail.target;
        this._entityEditorName = event.detail.name;
        this._entityEditorScheduleChanged = false;
        this._entityEditorOpen = true;
    }

    private _handleEntityEditorClosed(event: Event): void {
        event.stopPropagation();
        this._entityEditorOpen = false;
        this._entityEditorTarget = null;
        this._entityEditorScheduleChanged = false;
        this._entityEditorSlots = [];
        this._entityEditorForecastPoints = new Map();
    }

    /**
     * The day's draft, as one write.
     *
     * The dialog stays open until the write settles so a failure lands on the
     * card's error banner with the draft still on screen, rather than closing
     * over a change that never happened.
     */
    private async _handleEntityEditorSave(event: CustomEvent<EntityScheduleSaveDetail>): Promise<void> {
        event.stopPropagation();
        const patches = event.detail.patches;
        if (patches.length > 0) {
            await this._scheduleOwner?.applySchedulePatches(patches);
            if (this._ownerSnapshot.error !== null) {
                return;
            }
        }

        // Close the way Cancel does and let `closed` tear the rest down:
        // dropping the target here too would remove the dialog from the DOM in
        // the same update, so `closed` would never fire and the history entry it
        // pushed would go unconsumed -- swallowing the user's next Back press.
        this._entityEditorOpen = false;
    }

    /**
     * What the entities really did earlier today, fetched when the editor opens.
     *
     * Read from the recorder rather than from the schedule, which keeps no
     * record of elapsed slots -- and which would answer a different question
     * anyway: the past is what ran, not what was planned to.
     *
     * Failure is silent on purpose: the editor is perfectly usable with the
     * morning blank, and an error banner over a schedule the user came to edit
     * would be louder than the loss.
     */
    private async _loadEntityActualHistory(): Promise<void> {
        const hass = this._hass;
        this._entityActualHistory = {};
        if (!hass) {
            return;
        }

        try {
            const payload = await getSharedHelmanStore(hass).getEntityActualHistory();
            if (this._hass?.connection === hass.connection) {
                this._entityActualHistory = payload.entities;
            }
        } catch (error) {
            console.warn("helman-scheduling: failed to load entity history", error);
        }
    }

    private _seedEntityEditorSlots(): void {
        const view = buildEntityScheduleDayView({
            scheduleSlots: this._normalizedSchedule.slots,
            timeZone: this._hass?.config.time_zone ?? "UTC",
            locale: this._locale,
            forecast: this._forecast,
            baseForecastPoints: this._slotForecastMap.points,
        });
        this._entityEditorSlots = view.slots;
        this._entityEditorForecastPoints = view.forecastPoints;
    }

    private _buildEntityEditorLanes(
        statuses: readonly ControllableEntityStatus[],
    ): EntityScheduleLane[] {
        return buildEntityScheduleLanes({
            statuses,
            controllableEntities: this._controllableEntities,
            appliances: this._appliances,
            actualHistory: this._entityActualHistory,
            slotDurationMs: (this._normalizedSchedule.granularityMinutes ?? 60) * 60_000,
            locale: this._locale,
        });
    }

    private get _entityEditorAppliance(): ScheduleApplianceMetadata | null {
        const target = this._entityEditorTarget;
        return target === null || target.kind === "inverter"
            ? null
            : getScheduleApplianceById(this._appliances, target.applianceId);
    }

    private async _handleDialogClosed(event: Event): Promise<void> {
        event.stopPropagation();
        const pendingPatches = this._pendingDialogPatches;
        this._dialogOpen = false;
        this._dialogState = null;
        this._pendingDialogPatches = null;
        if (!pendingPatches || pendingPatches.length === 0) {
            return;
        }

        await this._scheduleOwner?.applySchedulePatches(pendingPatches);
    }

    private _handleDialogSubmit(event: CustomEvent<ScheduleRangeEditIntent>): void {
        event.stopPropagation();
        if (!this._dialogState) {
            return;
        }

        let patches;
        try {
            patches = buildScheduleSlotPatches({
                selectedSlots: this._dialogState.selectedSlots,
                result: event.detail,
            });
        } catch (error) {
            console.error("helman-scheduling: failed to build schedule patches", error);
            return;
        }

        this._pendingDialogPatches = patches;
        this._dialogOpen = false;
    }

    private _resetScheduleState(): void {
        this._ownerSnapshot = EMPTY_SCHEDULE_OWNER_SNAPSHOT;
        this._normalizedSchedule = EMPTY_NORMALIZED_SCHEDULE;
        this._timelineModel = EMPTY_SCHEDULE_TIMELINE;
        this._tableModel = EMPTY_SCHEDULE_TABLE_MODEL;
        this._selectedSlotIds = [];
        this._dialogState = null;
        this._dialogOpen = false;
        this._entityEditorTarget = null;
        this._entityEditorName = "";
        this._entityEditorOpen = false;
        this._entityEditorScheduleChanged = false;
        this._forecast = null;
        this._appliances = [];
        this._appliancesError = null;
        this._forecastLoader = null;
        this._forecastLoaderGranularity = null;
        this._forecastLoaderDays = null;
        this._forecastLoadGeneration = 0;
        this._applianceProjectionLoadGeneration += 1;
        this._slotForecastProjection = EMPTY_SLOT_FORECAST_PROJECTION;
        this._slotForecastProjectionKey = "";
        this._slotForecastMap = EMPTY_SLOT_FORECAST_MAP;
        this._applianceProjectionIndex = EMPTY_SCHEDULE_APPLIANCE_PROJECTION_INDEX;
        this._pendingDialogPatches = null;
        this._selectionAnchorSlotIds = null;
        this._dayExpansionOverrides = {};
        this._expandedHourKeys = [];
        this._expandedApplianceActions = false;
        this._appliancesRequested = false;
        this._controllableEntitiesRequested = false;
        this._controllableEntities = [];
        this._automationRequested = false;
        this._automationModel = null;
        this._nowMs = Date.now();
        this._clearTimelineBoundaryTick();
    }

    private _syncScheduleOwner(): void {
        const hass = this._hass;
        if (!this.isConnected || !hass) {
            return;
        }

        const owner = getSharedScheduleOwner(hass);
        if (this._scheduleOwner === owner) {
            this._applyOwnerSnapshot(owner.getSnapshot());
            return;
        }

        this._detachScheduleOwner();
        this._scheduleOwner = owner;
        this._applyOwnerSnapshot(owner.getSnapshot());
        this._unsubscribeScheduleOwner = owner.subscribe((snapshot) => {
            this._applyOwnerSnapshot(snapshot);
        });
    }

    private _detachScheduleOwner(): void {
        this._unsubscribeScheduleOwner?.();
        this._unsubscribeScheduleOwner = undefined;
        this._scheduleOwner = undefined;
    }

    private _applyOwnerSnapshot(snapshot: ScheduleOwnerSnapshot): void {
        const scheduleChanged = snapshot.schedule !== this._ownerSnapshot.schedule;
        this._ownerSnapshot = snapshot;

        if (scheduleChanged) {
            this._applianceProjectionLoadGeneration += 1;
            this._applianceProjectionIndex = EMPTY_SCHEDULE_APPLIANCE_PROJECTION_INDEX;
        }

        if (scheduleChanged && snapshot.schedule !== null) {
            void this._loadForecastForSchedule(snapshot.schedule, {
                resetExistingForecast: snapshot.writing || snapshot.togglingExecution,
            });
            void this._loadApplianceProjections();
        }
    }

    private async _loadAppliances(): Promise<void> {
        const hass = this._hass;
        if (!hass || this._appliancesRequested) {
            return;
        }

        this._appliancesRequested = true;
        try {
            const payload = await getSharedHelmanStore(hass).getAppliances();
            if (this._hass?.connection !== hass.connection) {
                return;
            }

            this._appliances = normalizeScheduleApplianceMetadata(payload);
            this._appliancesError = null;
        } catch (error) {
            if (this._hass?.connection !== hass.connection) {
                return;
            }

            this._appliancesRequested = false;
            this._appliances = [];
            this._appliancesError = error instanceof Error
                ? error.message
                : "Failed to load appliance metadata";
            console.error("helman-scheduling: failed to load appliance metadata", error);
        }
    }

    private async _loadApplianceProjections(): Promise<void> {
        const hass = this._hass;
        if (!hass) {
            return;
        }

        const generation = this._applianceProjectionLoadGeneration;
        try {
            const payload = await getSharedHelmanStore(hass).getApplianceProjections();
            if (generation !== this._applianceProjectionLoadGeneration || this._hass?.connection !== hass.connection) {
                return;
            }

            this._applianceProjectionIndex = buildScheduleApplianceProjectionIndex(payload);
        } catch (error) {
            if (generation !== this._applianceProjectionLoadGeneration || this._hass?.connection !== hass.connection) {
                return;
            }

            this._applianceProjectionIndex = EMPTY_SCHEDULE_APPLIANCE_PROJECTION_INDEX;
            console.error("helman-scheduling: failed to load appliance projections", error);
        }
    }

    private async _loadForecastForSchedule(
        schedule: SchedulePayload,
        options: { resetExistingForecast?: boolean } = {},
    ): Promise<void> {
        const hass = this._hass;
        if (!hass) {
            return;
        }

        const generation = ++this._forecastLoadGeneration;
        const params = deriveScheduleForecastParams(schedule.slots);
        if (params === null) {
            this._forecast = null;
            this._forecastLoader = null;
            this._forecastLoaderGranularity = null;
            this._forecastLoaderDays = null;
            return;
        }

        const paramsChanged = (
            this._forecastLoader === null
            || this._forecastLoaderGranularity !== params.granularity
            || this._forecastLoaderDays !== (params.forecastDays ?? null)
        );
        if (options.resetExistingForecast || paramsChanged) {
            this._forecast = null;
        }
        if (this._forecastLoader === null || paramsChanged) {
            this._forecastLoader = new ForecastLoader(params.granularity, params.forecastDays ?? null);
        }
        this._forecastLoaderGranularity = params.granularity;
        this._forecastLoaderDays = params.forecastDays ?? null;

        try {
            const forecast = await this._forecastLoader.load(hass);
            if (generation === this._forecastLoadGeneration && this._hass?.connection === hass.connection) {
                this._forecast = forecast;
            }
        } catch (err) {
            console.error("helman-scheduling: failed to load forecast", err);
        }
    }

    private _getSelectedSlots(selectedSlotIds: readonly string[]): ScheduleDialogState["selectedSlots"] {
        const selectedIdSet = new Set(selectedSlotIds);
        return this._normalizedSchedule.slots.filter((slot) => selectedIdSet.has(slot.id));
    }

    private get _orderedSlotIds(): string[] {
        return this._normalizedSchedule.slots.map((slot) => slot.id);
    }

    private _buildSelectedSlotIdsInScheduleOrder(selectedIdSet: ReadonlySet<string>): string[] {
        return buildSelectedSlotIdsInScheduleOrder(this._orderedSlotIds, selectedIdSet);
    }

    private _resolveTargetSlotIds(slotId: string, slotIds?: readonly string[]): string[] {
        return resolveTargetSlotIds(this._orderedSlotIds, slotId, slotIds);
    }

    private _resolveDialogSelectionIds(targetSlotIds: readonly string[]): string[] {
        return resolveScheduleDialogSelectionIds({
            orderedSlotIds: this._orderedSlotIds,
            selectedSlotIds: this._selectedSlotIds,
            targetSlotIds,
        });
    }

    private _areSlotIdListsEqual(left: readonly string[] | null, right: readonly string[] | null): boolean {
        if (left === right) {
            return true;
        }
        if (left === null || right === null || left.length !== right.length) {
            return false;
        }

        return left.every((slotId, index) => slotId === right[index]);
    }

    private _collectTimelineDayKeys(): string[] {
        const dayKeys: string[] = [];
        const seenDayKeys = new Set<string>();
        for (const slot of this._timelineModel.slots) {
            if (seenDayKeys.has(slot.dayKey)) {
                continue;
            }

            seenDayKeys.add(slot.dayKey);
            dayKeys.push(slot.dayKey);
        }

        return dayKeys;
    }

    private _buildExpandedDayKeys(): string[] {
        const dayKeys = this._collectTimelineDayKeys();
        const defaultExpandedDayKeys = this._resolveDefaultExpandedDayKeys(dayKeys);
        return dayKeys.filter((dayKey) => this._isDayExpanded(dayKey, defaultExpandedDayKeys));
    }

    private _resolveDefaultExpandedDayKeys(dayKeys: readonly string[]): ReadonlySet<string> {
        const expandedDayCount = Math.min(this._config.default_expanded_days ?? 1, dayKeys.length);
        return new Set(dayKeys.slice(0, expandedDayCount));
    }

    private _isDayExpanded(dayKey: string, defaultExpandedDayKeys: ReadonlySet<string>): boolean {
        return this._dayExpansionOverrides[dayKey] ?? defaultExpandedDayKeys.has(dayKey);
    }

    private _pruneDayExpansionOverrides(dayKeys: readonly string[]): void {
        if (Object.keys(this._dayExpansionOverrides).length === 0) {
            return;
        }

        const validDayKeys = new Set(dayKeys);
        const nextOverrides = Object.fromEntries(
            Object.entries(this._dayExpansionOverrides).filter(([dayKey]) => validDayKeys.has(dayKey)),
        );
        if (Object.keys(nextOverrides).length !== Object.keys(this._dayExpansionOverrides).length) {
            this._dayExpansionOverrides = nextOverrides;
        }
    }

    private _pruneExpandedHourKeys(): void {
        if (this._expandedHourKeys.length === 0) {
            return;
        }

        const validHourKeys = new Set(
            this._tableModel.sections
                .flatMap((section) => section.rows)
                .flatMap((row) => row.kind === "hour" ? [row.hourKey] : []),
        );
        const nextExpandedHourKeys = this._expandedHourKeys.filter((hourKey) => validHourKeys.has(hourKey));
        if (nextExpandedHourKeys.length !== this._expandedHourKeys.length) {
            this._expandedHourKeys = nextExpandedHourKeys;
        }
    }

    private _scheduleTimelineBoundaryTick(): void {
        this._clearTimelineBoundaryTick();
        const delay = this._resolveNextTimelineBoundaryDelayMs();
        if (delay === null || typeof window === "undefined") {
            return;
        }

        this._timelineBoundaryTimer = window.setTimeout(() => {
            this._nowMs = Date.now();
        }, delay);
    }

    private _clearTimelineBoundaryTick(): void {
        if (this._timelineBoundaryTimer === null || typeof window === "undefined") {
            return;
        }

        window.clearTimeout(this._timelineBoundaryTimer);
        this._timelineBoundaryTimer = null;
    }

    private _resolveNextTimelineBoundaryDelayMs(): number | null {
        const boundaryMs = [...new Set(this._timelineModel.slots.flatMap((slot) =>
            slot.endMs === null ? [slot.startMs] : [slot.startMs, slot.endMs]
        ))].sort((left, right) => left - right);
        const nextBoundaryMs = boundaryMs.find((value) => value > this._nowMs);
        if (nextBoundaryMs === undefined) {
            return null;
        }

        return Math.max(nextBoundaryMs - this._nowMs, 50);
    }

    private _normalizeDefaultExpandedDays(value: unknown): number {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return 1;
        }

        return Math.max(0, Math.floor(value));
    }

    private _buildHeaderModel(
        controllableEntityStatuses: readonly ControllableEntityStatus[],
    ): ScheduleHeaderModel {
        return buildScheduleHeaderModel({
            snapshot: this._ownerSnapshot,
            runningCount: controllableEntityStatuses.filter((status) => !status.isNormal).length,
            controllableCount: controllableEntityStatuses.length,
            runningExpanded: this._runningExpanded,
            localize: this._localize,
        });
    }

    /**
     * Every entity Helman can drive, with its live state and next change.
     *
     * The controllable set is fetched once per connection; this recomputes the
     * statuses from live `hass.states` on every render, so the header count and
     * the list stay current without polling.
     */
    private get _controllableEntityStatuses(): ControllableEntityStatus[] {
        return buildControllableEntityStatuses({
            controllableEntities: this._controllableEntities,
            appliances: this._appliances,
            states: this._hass?.states,
            slots: this._normalizedSchedule.slots,
            nowMs: this._nowMs,
            executionEnabled: this._ownerSnapshot.schedule?.executionEnabled ?? false,
        });
    }

    private async _loadControllableEntities(): Promise<void> {
        const hass = this._hass;
        // The controllable set only changes with the config, so fetch it once
        // per connection rather than on every hass update.
        if (!hass || this._controllableEntitiesRequested) {
            return;
        }

        this._controllableEntitiesRequested = true;
        try {
            const payload = await getSharedHelmanStore(hass).getControllableEntities();
            if (this._hass?.connection !== hass.connection) {
                return;
            }
            this._controllableEntities = payload.entities;
        } catch {
            // An empty list is the safe outcome: the header simply reports zero
            // rather than surfacing an error the user cannot act on.
            if (this._hass?.connection !== hass.connection) {
                return;
            }
            this._controllableEntitiesRequested = false;
            this._controllableEntities = [];
        }
    }

    private _handleToggleRunningEntities(event: CustomEvent): void {
        event.stopPropagation();
        this._runningExpanded = !this._runningExpanded;
    }

    private get _localize(): LocalizeFunction {
        return this._localizeFn ?? getLocalizeFunction(this._hass!);
    }

    private get _locale(): string {
        if (this._hass?.locale?.language) {
            return this._hass.locale.language;
        }

        return typeof navigator !== "undefined" ? navigator.language : "cs";
    }
}

(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
    type: "helman-scheduling-card",
    name: "Helman Scheduling Card",
    description: "Manual schedule overview and editing card for Helman.",
    preview: true,
});
