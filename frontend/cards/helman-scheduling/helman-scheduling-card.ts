import { LitElement, css, html } from "lit-element";
import { customElement, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import type { LovelaceCard } from "../../hass-frontend/src/panels/lovelace/types";
import type { ForecastPayload, SchedulePayload } from "../helman-api";
import { ForecastLoader } from "../helman/forecast-loader";
import { getSharedHelmanStore } from "../helman/store";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import type { HelmanSchedulingCardConfig } from "./HelmanSchedulingCardConfig";
import "./components/scheduling-card-header";
import "./components/scheduling-slot-table";
import "./dialogs/scheduling-range-edit-dialog";
import {
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

        return html`
            <ha-card
                class=${this._config?.transparent_background ? "transparent" : ""}
                @refresh-schedule=${this._handleRefresh}
                @toggle-schedule-execution=${this._handleToggleExecution}
                @toggle-schedule-slot-selection=${this._handleToggleSlotSelection}
                @toggle-schedule-day-expansion=${this._handleToggleDayExpansion}
                @toggle-schedule-hour-expansion=${this._handleToggleHourExpansion}
                @toggle-schedule-action-view=${this._handleToggleActionView}
                @open-schedule-dialog=${this._handleOpenDialog}
            >
                <div class="card-content">
                    ${this._config.show_header ? html`
                        <scheduling-card-header
                            .model=${this._buildHeaderModel()}
                        ></scheduling-card-header>
                    ` : nothing}

                    ${this._renderInlineError()}
                    ${this._renderApplianceError()}

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
        `;
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
        const { slotId, slotIds, shiftKey } = event.detail;
        const targetSlotIds = this._resolveTargetSlotIds(slotId, slotIds);
        if (targetSlotIds.length === 0) {
            return;
        }

        if (shiftKey && this._selectionAnchorSlotIds !== null) {
            const rangeSelection = this._selectTargetRange(this._selectionAnchorSlotIds, targetSlotIds);
            if (rangeSelection !== null) {
                this._selectedSlotIds = rangeSelection.selectedSlotIds;
                this._selectionAnchorSlotIds = rangeSelection.nextAnchorSlotIds;
                return;
            }
        }

        if (targetSlotIds.length > 1) {
            const selectedIdSet = new Set(this._selectedSlotIds);
            const allSelected = targetSlotIds.every((id) => selectedIdSet.has(id));
            if (allSelected) {
                for (const id of targetSlotIds) {
                    selectedIdSet.delete(id);
                }
                const nextSelectedSlotIds = this._buildSelectedSlotIdsInScheduleOrder(selectedIdSet);
                this._selectedSlotIds = nextSelectedSlotIds;
                this._selectionAnchorSlotIds = nextSelectedSlotIds.length > 0
                    ? [...targetSlotIds]
                    : null;
                return;
            }

            for (const id of targetSlotIds) {
                selectedIdSet.add(id);
            }
            this._selectedSlotIds = this._buildSelectedSlotIdsInScheduleOrder(selectedIdSet);
            this._selectionAnchorSlotIds = [...targetSlotIds];
            return;
        }

        const [targetSlotId] = targetSlotIds;
        if (!targetSlotId) {
            return;
        }

        if (this._selectedSlotIds.includes(targetSlotId)) {
            const nextSelectedSlotIds = this._selectedSlotIds.filter((id) => id !== targetSlotId);
            this._selectedSlotIds = nextSelectedSlotIds;
            this._selectionAnchorSlotIds = nextSelectedSlotIds.length > 0
                ? [...targetSlotIds]
                : null;
            return;
        }

        this._selectedSlotIds = this._buildSelectedSlotIdsInScheduleOrder(
            new Set([...this._selectedSlotIds, targetSlotId]),
        );
        this._selectionAnchorSlotIds = [...targetSlotIds];
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

    private _buildSelectedSlotIdsInScheduleOrder(selectedIdSet: ReadonlySet<string>): string[] {
        return this._normalizedSchedule.slots
            .filter((slot) => selectedIdSet.has(slot.id))
            .map((slot) => slot.id);
    }

    private _resolveTargetSlotIds(slotId: string, slotIds?: readonly string[]): string[] {
        const candidateSlotIds = slotIds?.length ? slotIds : [slotId];
        return this._buildSelectedSlotIdsInScheduleOrder(new Set(candidateSlotIds));
    }

    private _selectTargetRange(
        anchorSlotIds: readonly string[],
        targetSlotIds: readonly string[],
    ): { selectedSlotIds: string[]; nextAnchorSlotIds: string[] } | null {
        const anchorBounds = this._resolveTargetBounds(anchorSlotIds);
        const targetBounds = this._resolveTargetBounds(targetSlotIds);
        if (anchorBounds === null || targetBounds === null) {
            return null;
        }

        const selectedIdSet = new Set(this._selectedSlotIds);
        const startIndex = Math.min(anchorBounds.startIndex, targetBounds.startIndex);
        const endIndex = Math.max(anchorBounds.endIndex, targetBounds.endIndex);
        for (const slot of this._normalizedSchedule.slots.slice(startIndex, endIndex + 1)) {
            selectedIdSet.add(slot.id);
        }

        return {
            selectedSlotIds: this._buildSelectedSlotIdsInScheduleOrder(selectedIdSet),
            nextAnchorSlotIds: [...targetBounds.slotIds],
        };
    }

    private _resolveTargetBounds(
        slotIds: readonly string[],
    ): { startIndex: number; endIndex: number; slotIds: string[] } | null {
        const orderedSlotIds = this._buildSelectedSlotIdsInScheduleOrder(new Set(slotIds));
        const firstSlotId = orderedSlotIds[0];
        const lastSlotId = orderedSlotIds[orderedSlotIds.length - 1];
        if (!firstSlotId || !lastSlotId) {
            return null;
        }

        const startIndex = this._normalizedSchedule.slots.findIndex((slot) => slot.id === firstSlotId);
        const endIndex = this._normalizedSchedule.slots.findIndex((slot) => slot.id === lastSlotId);
        if (startIndex === -1 || endIndex === -1) {
            return null;
        }

        return {
            startIndex,
            endIndex,
            slotIds: orderedSlotIds,
        };
    }

    private _resolveDialogSelectionIds(targetSlotIds: readonly string[]): string[] {
        const selectedSlots = this._getSelectedSlots(this._selectedSlotIds);
        if (targetSlotIds.length === 0) {
            return selectedSlots.map((slot) => slot.id);
        }

        if (selectedSlots.length > 0 && targetSlotIds.some((slotId) => this._selectedSlotIds.includes(slotId))) {
            return selectedSlots.map((slot) => slot.id);
        }

        return this._buildSelectedSlotIdsInScheduleOrder(new Set(targetSlotIds));
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

    private _buildHeaderModel(): ScheduleHeaderModel {
        return buildScheduleHeaderModel({
            snapshot: this._ownerSnapshot,
            localize: this._localize,
            locale: this._locale,
            timeZone: this._hass?.config.time_zone ?? "UTC",
        });
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
