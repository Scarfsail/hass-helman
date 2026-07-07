import { LitElement, css, html } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { LocalizeFunction } from "../../localize/localize";
import "../components/scheduling-action-option-card";
import "../components/scheduling-action-chip";
import "../components/scheduling-appliance-chip";
import "../components/scheduling-two-choice-row";
import "./scheduling-ev-charger-editor";
import "./scheduling-generic-appliance-editor";
import "./scheduling-climate-appliance-editor";
import {
    buildScheduleRangeEditAuthorshipSummary,
    buildScheduleRangeEditSelectionSummary,
} from "../model/schedule-range-edit-selection-summary";
import { getScheduleActionPresentation } from "../model/schedule-action-presentation";
import { getScheduleApplianceActionPresentation } from "../model/schedule-appliance-action-presentation";
import type { ScheduleActionOptionSelectDetail } from "../components/scheduling-action-option-card";
import type { ScheduleTwoChoiceRowSelectDetail } from "../components/scheduling-two-choice-row";
import type { ScheduleApplianceActionChangeDetail } from "./schedule-appliance-editor-types";
import {
    formatScheduleSlotCount,
} from "../model/schedule-labels";
import type {
    ScheduleApplianceAction,
    ScheduleActionAuthorshipSummary,
    ScheduleDialogState,
    ScheduleRangeEditIntent,
    ScheduleSelectionValueSummary,
    ScheduleApplianceEditIntent,
    ScheduleInverterEditIntent,
} from "../schedule-types";
import {
    areScheduleActionsEqual,
    areScheduleApplianceActionsEqual,
    cloneScheduleApplianceAction,
    cloneScheduleInverterAction,
    isScheduleClimateApplianceAction,
    isScheduleEvChargerAction,
    isScheduleGenericApplianceAction,
    isTargetScheduleAction,
    type ScheduleAction,
} from "../schedule-types";
import type {
    ScheduleApplianceMetadata,
    ScheduleClimateApplianceMetadata,
    ScheduleEvChargerApplianceMetadata,
    ScheduleGenericApplianceMetadata,
} from "../model/schedule-appliance-metadata";
import { schedulingSharedStyles } from "../styles/scheduling-shared-styles";

const DIALOG_HISTORY_STATE_KEY = "__helmanSchedulingDialogId";
const DEFAULT_CHARGE_TARGET_SOC = 100;
const DEFAULT_DISCHARGE_TARGET_SOC = 15;
const USER_DIALOG_AUTHORSHIP: ScheduleActionAuthorshipSummary = {
    state: "user",
    counts: {
        user: 1,
        automation: 0,
    },
};
const NO_AUTHOR_DIALOG_AUTHORSHIP: ScheduleActionAuthorshipSummary = {
    state: "none",
    counts: {
        user: 0,
        automation: 0,
    },
};
let nextDialogHistoryEntryId = 0;

@customElement("scheduling-range-edit-dialog")
export class SchedulingRangeEditDialog extends LitElement {
    static styles = [
        schedulingSharedStyles,
        css`
            .dialog-content {
                display: flex;
                flex-direction: column;
                gap: 16px;
                min-width: min(560px, calc(100vw - 48px));
                padding-top: 4px;
            }

            .dialog-summary {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
                gap: 10px 12px;
            }

            .dialog-summary-value {
                font-size: 0.95rem;
                font-weight: 500;
                line-height: 1.35;
            }

            .action-options {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
            }

            .appliance-sections {
                display: flex;
                flex-direction: column;
                gap: 12px;
            }

            .inverter-action-detail {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }

            .inverter-action-detail .target-field {
                width: min(180px, 100%);
            }

            .panel.inverter-panel-highlight {
                border-color: var(--schedule-action-tone-border, var(--divider-color));
                background: color-mix(in srgb, var(--schedule-action-tone-accent, var(--primary-color)) 14%, var(--secondary-background-color));
                box-shadow:
                    inset 0 0 0 1px color-mix(in srgb, var(--schedule-action-tone-accent, var(--primary-color)) 14%, transparent),
                    0 0 0 1px color-mix(in srgb, var(--schedule-action-tone-accent, var(--primary-color)) 6%, transparent);
            }

            .dialog-panel {
                display: flex;
                flex-direction: column;
                gap: 12px;
            }

            .unsupported-appliance {
                display: flex;
                flex-direction: column;
                gap: 6px;
                padding: 12px;
                border: 1px solid var(--divider-color);
                border-radius: 12px;
                background: var(--secondary-background-color);
            }

            @media (max-width: 600px) {
                .dialog-content {
                    min-width: 0;
                }
            }
        `,
    ];

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
        this._closeDialogElement();
    };

    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public dialogState: ScheduleDialogState | null = null;
    @property({ attribute: false }) public appliances: ScheduleApplianceMetadata[] = [];
    @property({ type: Boolean }) public open = false;

    @state() private _actionKind: ScheduleAction["kind"] | null = null;
    @state() private _targetSocInput = "";
    @state() private _selectionSummary: ScheduleDialogState["selectionSummary"] | null = null;
    @state() private _inverterEdited = false;
    @state() private _draftApplianceActions: Record<string, ScheduleApplianceAction | null> = {};
    @state() private _applianceValidity: Record<string, boolean> = {};
    @state() private _editedApplianceIds: string[] = [];
    @state() private _authorshipSummary: ScheduleDialogState["authorshipSummary"] | null = null;
    @state() private _overwriteMixedInverter = false;
    @state() private _overwriteMixedAppliances: Record<string, boolean> = {};
    @state() private _manualTakeoverInverter = false;
    @state() private _manualTakeoverAppliances: Record<string, boolean> = {};

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
        if (changedProperties.has("dialogState") && this.dialogState !== null) {
            this._applyDialogState(this.dialogState);
        }
        if (
            changedProperties.has("appliances")
            && !changedProperties.has("dialogState")
            && this.dialogState !== null
        ) {
            this._syncApplianceStateFromMetadata();
        }
    }

    updated(changedProperties: Map<string, unknown>): void {
        super.updated(changedProperties);
        if (!this.open || !this.dialogState || this._historyEntryActive) {
            return;
        }

        if (changedProperties.has("open") || changedProperties.has("dialogState")) {
            this._pushHistoryEntry();
        }
    }

    render() {
        if (this.dialogState === null) {
            return nothing;
        }

        return html`
            <ha-dialog
                .open=${this.open}
                @closed=${this._onClosed}
                .heading=${this._title()}
                .headerTitle=${this._title()}
            >
                <div class="dialog-content">
                    <div class="dialog-summary">
                        <div class="field">
                            <div class="field-label">${this.localize("scheduling.dialog.selection")}</div>
                            <div class="dialog-summary-value">${this._selectedSlotSummaryLabel()}</div>
                        </div>
                    </div>

                    <div class="dialog-panel">
                        ${this._renderInverterPanel()}
                        ${this._renderAppliancesPanel()}
                    </div>

                    <div class="field-help">
                        ${this.localize("scheduling.dialog.affects_prefix")} ${formatScheduleSlotCount(this._selectedSlotCount(), this.localize)}
                    </div>
                </div>

                <ha-dialog-footer slot="footer">
                    <ha-button slot="secondaryAction" .appearance=${"plain"} @click=${this._handleCancel}>
                        ${this.localize("scheduling.dialog.cancel")}
                    </ha-button>
                    <ha-button slot="primaryAction" ?disabled=${!this._canSubmit()} @click=${this._handleSubmit}>
                        ${this._submitLabel()}
                    </ha-button>
                </ha-dialog-footer>
            </ha-dialog>
        `;
    }

    private _applyDialogState(dialogState: ScheduleDialogState): void {
        const selectionSummary = dialogState.selectionSummary;
        const authorshipSummary = dialogState.authorshipSummary;
        const draftApplianceActions = Object.fromEntries(
            Object.entries(selectionSummary.appliances).map(([applianceId, summary]) => [
                applianceId,
                this._cloneDraftApplianceAction(summary.seedValue),
            ]),
        );
        this._selectionSummary = selectionSummary;
        this._authorshipSummary = authorshipSummary;
        this._inverterEdited = false;
        this._overwriteMixedInverter = selectionSummary.inverter.state === "uniform";
        this._manualTakeoverInverter = false;
        this._actionKind = selectionSummary.inverter.seedValue.kind;
        this._targetSocInput = selectionSummary.inverter.seedValue.targetSoc?.toString() ?? "";
        this._draftApplianceActions = draftApplianceActions;
        this._applianceValidity = Object.fromEntries(
            Object.keys(this._draftApplianceActions).map((applianceId) => [applianceId, true]),
        );
        this._overwriteMixedAppliances = Object.fromEntries(
            Object.entries(selectionSummary.appliances).map(([applianceId, summary]) => [
                applianceId,
                summary.state === "uniform",
            ]),
        );
        this._manualTakeoverAppliances = Object.fromEntries(
            Object.keys(selectionSummary.appliances).map((applianceId) => [applianceId, false]),
        );
        this._editedApplianceIds = [];
    }

    private _syncApplianceStateFromMetadata(): void {
        if (
            this.dialogState === null
            || this._selectionSummary === null
            || this._authorshipSummary === null
        ) {
            return;
        }

        const nextSelectionSummary = buildScheduleRangeEditSelectionSummary({
            selectedSlots: this.dialogState.selectedSlots,
            appliances: this.appliances,
        });
        const nextAuthorshipSummary = buildScheduleRangeEditAuthorshipSummary({
            selectedSlots: this.dialogState.selectedSlots,
            appliances: this.appliances,
        });
        const missingApplianceIds = Object.keys(nextSelectionSummary.appliances).filter(
            (applianceId) => this._selectionSummary?.appliances[applianceId] === undefined,
        );
        if (missingApplianceIds.length === 0) {
            return;
        }

        const nextSelectionAppliances = {
            ...this._selectionSummary.appliances,
            ...Object.fromEntries(
                missingApplianceIds.map((applianceId) => [
                    applianceId,
                    nextSelectionSummary.appliances[applianceId],
                ]),
            ),
        };
        const nextDraftApplianceActions = {
            ...this._draftApplianceActions,
            ...Object.fromEntries(
                missingApplianceIds.map((applianceId) => [
                    applianceId,
                    this._cloneDraftApplianceAction(nextSelectionSummary.appliances[applianceId].seedValue),
                ]),
            ),
        };
        const nextOverwriteMixedAppliances = {
            ...this._overwriteMixedAppliances,
            ...Object.fromEntries(
                missingApplianceIds.map((applianceId) => [
                    applianceId,
                    nextSelectionSummary.appliances[applianceId].state === "uniform",
                ]),
            ),
        };
        const nextManualTakeoverAppliances = {
            ...this._manualTakeoverAppliances,
            ...Object.fromEntries(missingApplianceIds.map((applianceId) => [applianceId, false])),
        };

        this._selectionSummary = {
            ...this._selectionSummary,
            appliances: nextSelectionAppliances,
        };
        this._authorshipSummary = {
            ...this._authorshipSummary,
            appliances: {
                ...this._authorshipSummary.appliances,
                ...Object.fromEntries(
                    missingApplianceIds.map((applianceId) => [
                        applianceId,
                        nextAuthorshipSummary.appliances[applianceId],
                    ]),
                ),
            },
        };
        this._draftApplianceActions = nextDraftApplianceActions;
        this._applianceValidity = {
            ...this._applianceValidity,
            ...Object.fromEntries(missingApplianceIds.map((applianceId) => [applianceId, true])),
        };
        this._overwriteMixedAppliances = nextOverwriteMixedAppliances;
        this._manualTakeoverAppliances = nextManualTakeoverAppliances;
        this._editedApplianceIds = this._buildEditedApplianceIds(
            nextDraftApplianceActions,
            nextOverwriteMixedAppliances,
            nextManualTakeoverAppliances,
            nextSelectionAppliances,
        );
    }

    private _title(): string {
        return this.localize("scheduling.dialog.title.edit_selection");
    }

    private _submitLabel(): string {
        return this.localize("scheduling.dialog.apply");
    }

    private _selectedSlotCount(): number {
        return this.dialogState?.selectedSlots.length ?? 0;
    }

    private _selectedSlotSummaryLabel(): string {
        const selectedSlots = this.dialogState?.selectedSlots ?? [];
        if (selectedSlots.length === 0) {
            return "";
        }

        const labels: string[] = [];
        let rangeStart = selectedSlots[0];
        let previousSlot = selectedSlots[0];
        const pushRangeLabel = (): void => {
            labels.push(
                rangeStart.id === previousSlot.id
                    ? rangeStart.rangeLabel
                    : previousSlot.endLabel !== null
                    ? `${rangeStart.timeLabel}–${previousSlot.endLabel}`
                    : `${rangeStart.timeLabel}–${previousSlot.timeLabel}+`,
            );
        };

        for (const slot of selectedSlots.slice(1)) {
            if (previousSlot.endMs !== null && previousSlot.endMs === slot.startMs) {
                previousSlot = slot;
                continue;
            }

            pushRangeLabel();
            rangeStart = slot;
            previousSlot = slot;
        }

        pushRangeLabel();
        const visibleLabels = labels.slice(0, 3);
        return labels.length <= 3
            ? visibleLabels.join(", ")
            : `${visibleLabels.join(", ")}, ...`;
    }

    private _renderActionOption(actionKind: ScheduleAction["kind"]) {
        const previewAction = this._buildActionOptionPreview(actionKind);
        const checked = this._actionKind === actionKind;
        return html`
            <scheduling-action-option-card
                .action=${previewAction}
                .authorship=${checked ? this._getEffectiveInverterAuthorship() : null}
                .checked=${checked}
                .localize=${this.localize}
                radioName="schedule-action-kind"
                @schedule-action-option-select=${this._handleActionOptionSelect}
            ></scheduling-action-option-card>
        `;
    }

    private _renderInverterPanel() {
        const panelClasses = this._inverterPanelClasses();
        const selectionSummary = this._selectionSummary?.inverter ?? null;
        const authorshipSummary = this._authorshipSummary?.inverter ?? null;
        const showTakeoverDecision = this._shouldShowInverterTakeoverDecision();
        const showEditor = this._isInverterEditorActive();
        const isMixed = selectionSummary?.state === "mixed";
        return html`
            <div class=${panelClasses}>
                <div class="panel-header-inline">
                    <div class="panel-title">${this.localize("scheduling.dialog.inverter")}</div>
                </div>
                ${showTakeoverDecision
                    ? this._renderInverterAuthorshipSummary(selectionSummary, authorshipSummary)
                    : nothing}
                ${isMixed ? this._renderMixedInverterSummary(selectionSummary, this._overwriteMixedInverter) : nothing}
                ${(showTakeoverDecision || isMixed) && showEditor ? html`<div class="mixed-editor-divider"></div>` : nothing}
                ${showEditor ? html`
                    <div class="action-options" role="radiogroup" aria-label=${this.localize("scheduling.dialog.inverter")}>
                        ${this._renderActionOption("empty")}
                        ${this._renderActionOption("normal")}
                        ${this._renderActionOption("charge_to_target_soc")}
                        ${this._renderActionOption("discharge_to_target_soc")}
                        ${this._renderActionOption("stop_charging")}
                        ${this._renderActionOption("stop_discharging")}
                        ${this._renderActionOption("stop_export")}
                    </div>
                    ${this._renderInverterActionDetail()}
                ` : nothing}
                ${showEditor && this._actionKind === null ? html`
                    <div class="field-help">${this.localize("scheduling.dialog.choose_action")}</div>
                ` : nothing}
            </div>
        `;
    }

    private _renderAppliancesPanel() {
        const missingMixedAppliances = this._buildMissingMixedApplianceIds();
        if (this.appliances.length === 0 && missingMixedAppliances.length === 0) {
            return nothing;
        }

        return html`
            <div class="appliance-sections">
                ${this.appliances.map((appliance) => this._renderApplianceSection(appliance))}
                ${missingMixedAppliances.map((applianceId) => this._renderMissingApplianceSummary(applianceId))}
            </div>
        `;
    }

    private _renderApplianceSection(appliance: ScheduleApplianceMetadata) {
        if (!appliance.supportsAuthoring) {
            return this._renderUnsupportedApplianceSection(appliance);
        }

        const selectionSummary = this._selectionSummary?.appliances[appliance.id] ?? null;
        const isMixed = selectionSummary?.state === "mixed";
        const showTakeoverDecision = this._shouldShowApplianceTakeoverDecision(appliance.id);
        const overwriteEnabled = this._isApplianceEditorActive(appliance.id);
        return this._renderApplianceEditor(
            appliance,
            html`
                ${showTakeoverDecision
                    ? this._renderApplianceAuthorshipSummary(appliance, selectionSummary)
                    : nothing}
                ${isMixed ? this._renderMixedApplianceSummary(appliance, selectionSummary, overwriteEnabled) : nothing}
            `,
            isMixed || showTakeoverDecision,
            (!showTakeoverDecision && !isMixed) || overwriteEnabled,
        );
    }

    private _renderApplianceEditor(
        appliance: ScheduleApplianceMetadata,
        summaryContent: unknown,
        showSummary: boolean,
        showControls: boolean,
    ) {
        switch (appliance.kind) {
            case "ev_charger":
                return this._renderEvChargerSection(
                    appliance,
                    summaryContent,
                    showSummary,
                    showControls,
                );
            case "climate":
                return this._renderClimateSection(
                    appliance,
                    summaryContent,
                    showSummary,
                    showControls,
                );
            case "generic":
                return this._renderGenericSection(
                    appliance,
                    summaryContent,
                    showSummary,
                    showControls,
                );
            default:
                return this._renderUnsupportedApplianceSection(appliance);
        }
    }

    private _renderEvChargerSection(
        appliance: ScheduleEvChargerApplianceMetadata,
        summaryContent: unknown,
        showSummary: boolean,
        showControls: boolean,
    ) {
        return html`
            <scheduling-ev-charger-editor
                .appliance=${appliance}
                .localize=${this.localize}
                .action=${this._draftApplianceActions[appliance.id] ?? null}
                .selectedAuthorship=${this._getEffectiveApplianceAuthorship(appliance.id)}
                .summaryContent=${summaryContent}
                .showSummary=${showSummary}
                .showControls=${showControls}
                @schedule-appliance-action-change=${this._handleApplianceActionChange}
            ></scheduling-ev-charger-editor>
        `;
    }

    private _renderGenericSection(
        appliance: ScheduleGenericApplianceMetadata,
        summaryContent: unknown,
        showSummary: boolean,
        showControls: boolean,
    ) {
        return html`
            <scheduling-generic-appliance-editor
                .appliance=${appliance}
                .localize=${this.localize}
                .action=${this._draftApplianceActions[appliance.id] ?? null}
                .selectedAuthorship=${this._getEffectiveApplianceAuthorship(appliance.id)}
                .summaryContent=${summaryContent}
                .showSummary=${showSummary}
                .showControls=${showControls}
                @schedule-appliance-action-change=${this._handleApplianceActionChange}
            ></scheduling-generic-appliance-editor>
        `;
    }

    private _renderClimateSection(
        appliance: ScheduleClimateApplianceMetadata,
        summaryContent: unknown,
        showSummary: boolean,
        showControls: boolean,
    ) {
        return html`
            <scheduling-climate-appliance-editor
                .appliance=${appliance}
                .localize=${this.localize}
                .action=${this._draftApplianceActions[appliance.id] ?? null}
                .selectedAuthorship=${this._getEffectiveApplianceAuthorship(appliance.id)}
                .summaryContent=${summaryContent}
                .showSummary=${showSummary}
                .showControls=${showControls}
                @schedule-appliance-action-change=${this._handleApplianceActionChange}
            ></scheduling-climate-appliance-editor>
        `;
    }

    private _renderUnsupportedApplianceSection(appliance: ScheduleApplianceMetadata) {
        return html`
            <div class="unsupported-appliance">
                <div class="panel-title">${appliance.name}</div>
                <div class="field-help">${this.localize("scheduling.dialog.appliance.unsupported_authoring")}</div>
            </div>
        `;
    }

    private _renderMissingApplianceSummary(applianceId: string) {
        const summary = this._selectionSummary?.appliances[applianceId];
        if (!summary || summary.state !== "mixed") {
            return nothing;
        }

        const appliance = this._buildFallbackApplianceChipMetadata(applianceId, summary);
        return html`
            <div class="panel">
                <div class="mixed-summary-copy">
                    <div class="panel-title">${appliance.name}</div>
                    <div class="field-help">${this.localize("scheduling.dialog.appliance.missing_metadata")}</div>
                    <div class="field-label">${this.localize("scheduling.dialog.existing_actions")}</div>
                </div>
                <div class="mixed-summary-chips">
                    ${summary.distinctValues.map((option) => html`
                        <scheduling-appliance-chip
                            .appliance=${appliance}
                            .action=${option.value}
                            .authorship=${option.authorship}
                            .localize=${this.localize}
                            .titleText=${this._buildDialogApplianceOptionTitle(appliance, option)}
                            size="compact"
                        ></scheduling-appliance-chip>
                    `)}
                </div>
            </div>
        `;
    }

    private _renderInverterAuthorshipSummary(
        selectionSummary: ScheduleSelectionValueSummary<ScheduleAction> | null,
        authorshipSummary: ScheduleActionAuthorshipSummary | null,
    ) {
        if (selectionSummary === null || authorshipSummary === null) {
            return nothing;
        }

        return html`
            <div class="mixed-summary">
                ${this._renderDecisionRow(
                    this._buildAuthorshipDecisionCopy(authorshipSummary),
                    this._manualTakeoverInverter,
                    "schedule-inverter-takeover",
                    this.localize("scheduling.dialog.replace_with_manual_action"),
                    this.localize("scheduling.dialog.replace_with_manual_action"),
                    this._handleInverterTakeoverSelect,
                )}
                ${selectionSummary.state === "uniform" ? html`
                    <div class="mixed-summary-chips">
                        <scheduling-action-chip
                            .action=${selectionSummary.seedValue}
                            .authorship=${authorshipSummary}
                            .localize=${this.localize}
                            .titleText=${this._buildDialogInverterOptionTitle(selectionSummary.seedValue, authorshipSummary)}
                            size="compact"
                        ></scheduling-action-chip>
                    </div>
                ` : nothing}
            </div>
        `;
    }

    private _renderMixedInverterSummary(
        summary: ScheduleSelectionValueSummary<ScheduleAction>,
        overwriteEnabled: boolean,
    ) {
        return html`
            <div class="mixed-summary">
                ${this._renderDecisionRow(
                    this.localize("scheduling.dialog.multiple_actions_defined"),
                    overwriteEnabled,
                    "schedule-inverter-overwrite",
                    this.localize("scheduling.dialog.overwrite_existing_actions"),
                    this.localize("scheduling.dialog.overwrite_existing_actions"),
                    this._handleInverterOverwriteSelect,
                )}
                <div class="mixed-summary-chips">
                    ${summary.distinctValues.map((option) => html`
                        <scheduling-action-chip
                            .action=${option.value}
                            .authorship=${option.authorship}
                            .localize=${this.localize}
                            .titleText=${this._buildDialogInverterOptionTitle(option.value, option.authorship)}
                            size="compact"
                        ></scheduling-action-chip>
                    `)}
                </div>
            </div>
        `;
    }

    private _renderApplianceAuthorshipSummary(
        appliance: ScheduleApplianceMetadata,
        summary: ScheduleSelectionValueSummary<ScheduleApplianceAction | null> | null,
    ) {
        const authorshipSummary = this._authorshipSummary?.appliances[appliance.id] ?? null;
        if (summary === null || authorshipSummary === null) {
            return nothing;
        }

        return html`
            <div class="mixed-summary">
                ${this._renderDecisionRow(
                    this._buildAuthorshipDecisionCopy(authorshipSummary),
                    this._manualTakeoverAppliances[appliance.id] ?? false,
                    `schedule-appliance-takeover-${appliance.id}`,
                    this.localize("scheduling.dialog.replace_with_manual_action"),
                    this.localize("scheduling.dialog.replace_with_manual_action"),
                    (event: CustomEvent<ScheduleTwoChoiceRowSelectDetail>) =>
                        this._handleApplianceTakeoverSelect(appliance.id, event),
                )}
                ${summary.state === "uniform" ? html`
                    <div class="mixed-summary-chips">
                        <scheduling-appliance-chip
                            .appliance=${appliance}
                            .action=${summary.seedValue}
                            .authorship=${authorshipSummary}
                            .localize=${this.localize}
                            .titleText=${this._buildDialogApplianceOptionTitle(appliance, {
                                key: "__seed__",
                                value: summary.seedValue,
                                authorship: authorshipSummary,
                            })}
                            size="compact"
                        ></scheduling-appliance-chip>
                    </div>
                ` : nothing}
            </div>
        `;
    }

    private _renderMixedApplianceSummary(
        appliance: ScheduleApplianceMetadata,
        summary: ScheduleSelectionValueSummary<ScheduleApplianceAction | null>,
        overwriteEnabled: boolean,
    ) {
        return html`
            <div class="mixed-summary">
                ${this._renderDecisionRow(
                    this.localize("scheduling.dialog.multiple_actions_defined"),
                    overwriteEnabled,
                    `schedule-appliance-overwrite-${appliance.id}`,
                    this.localize("scheduling.dialog.overwrite_existing_actions"),
                    this.localize("scheduling.dialog.overwrite_existing_actions"),
                    (event: CustomEvent<ScheduleTwoChoiceRowSelectDetail>) =>
                        this._handleApplianceOverwriteSelect(appliance.id, event),
                )}
                <div class="mixed-summary-chips">
                    ${summary.distinctValues.map((option) => html`
                        <scheduling-appliance-chip
                            .appliance=${appliance}
                            .action=${option.value}
                            .authorship=${option.authorship}
                            .localize=${this.localize}
                            .titleText=${this._buildDialogApplianceOptionTitle(appliance, option)}
                            size="compact"
                        ></scheduling-appliance-chip>
                    `)}
                </div>
            </div>
        `;
    }

    private _renderDecisionRow(
        description: string,
        value: boolean,
        groupName: string,
        trueLabel: string,
        ariaLabel: string,
        onSelect: (event: CustomEvent<ScheduleTwoChoiceRowSelectDetail>) => void,
    ) {
        return html`
            <scheduling-two-choice-row
                .description=${description}
                .falseLabel=${this.localize("scheduling.dialog.keep_existing")}
                .trueLabel=${trueLabel}
                .value=${value}
                .groupName=${groupName}
                .ariaLabel=${ariaLabel}
                @schedule-two-choice-row-select=${onSelect}
            ></scheduling-two-choice-row>
        `;
    }

    private _renderInverterActionDetail() {
        if (this._actionKind === null || !this._isTargetActionKind(this._actionKind)) {
            return nothing;
        }

        return html`
            <div class="inverter-action-detail">
                <ha-textfield
                    class="target-field"
                    id="schedule-target-soc"
                    type="number"
                    min="0"
                    max="100"
                    step="1"
                    no-spinner
                    .label=${this.localize("scheduling.dialog.target_soc")}
                    .suffix=${"%"}
                    .value=${this._targetSocInput}
                    @input=${this._handleTargetSocInput}
                ></ha-textfield>
            </div>
        `;
    }

    private _canSubmit(): boolean {
        if (this._selectedSlotCount() === 0) {
            return false;
        }

        if (Object.entries(this._applianceValidity).some(([applianceId, valid]) => !valid && this._isApplianceEditorActive(applianceId))) {
            return false;
        }

        if (!this._isInverterEditorActive()) {
            return true;
        }

        if (this._actionKind === null) {
            return false;
        }

        if (!this._isTargetActionKind(this._actionKind)) {
            return true;
        }

        return /^\d+$/.test(this._targetSocInput)
            && Number(this._targetSocInput) >= 0
            && Number(this._targetSocInput) <= 100;
    }

    private _setActionKind(actionKind: ScheduleAction["kind"]): void {
        if (this._actionKind === actionKind) {
            return;
        }

        this._actionKind = actionKind;
        if (!this._isTargetActionKind(actionKind)) {
            this._updateInverterEditedState();
            return;
        }

        if (this._targetSocInput.trim().length > 0) {
            this._updateInverterEditedState();
            return;
        }

        this._targetSocInput = actionKind === "charge_to_target_soc"
            ? String(DEFAULT_CHARGE_TARGET_SOC)
            : String(DEFAULT_DISCHARGE_TARGET_SOC);
        this._updateInverterEditedState();
    }

    private _handleTargetSocInput(event: Event): void {
        this._targetSocInput = (event.currentTarget as HTMLInputElement).value;
        this._updateInverterEditedState();
    }

    private _handleInverterOverwriteDecision(enabled: boolean): void {
        this._overwriteMixedInverter = enabled;
        this._resetInverterDraft();
        this._updateInverterEditedState();
    }

    private _handleInverterOverwriteSelect = (
        event: CustomEvent<ScheduleTwoChoiceRowSelectDetail>,
    ): void => {
        event.stopPropagation();
        this._handleInverterOverwriteDecision(event.detail.value);
    };

    private _handleInverterTakeoverDecision = (enabled: boolean): void => {
        this._manualTakeoverInverter = enabled;
        this._updateInverterEditedState();
    };

    private _handleInverterTakeoverSelect = (
        event: CustomEvent<ScheduleTwoChoiceRowSelectDetail>,
    ): void => {
        event.stopPropagation();
        this._handleInverterTakeoverDecision(event.detail.value);
    };

    private _handleApplianceOverwriteDecision(applianceId: string, enabled: boolean): void {
        const nextOverwriteMixedAppliances = {
            ...this._overwriteMixedAppliances,
            [applianceId]: enabled,
        };
        const nextDraftApplianceActions = {
            ...this._draftApplianceActions,
            [applianceId]: this._buildApplianceSeedDraft(applianceId),
        };
        this._overwriteMixedAppliances = nextOverwriteMixedAppliances;
        this._draftApplianceActions = nextDraftApplianceActions;
        this._applianceValidity = {
            ...this._applianceValidity,
            [applianceId]: true,
        };
        this._editedApplianceIds = this._buildEditedApplianceIds(
            nextDraftApplianceActions,
            nextOverwriteMixedAppliances,
        );
    }

    private _handleApplianceOverwriteSelect(
        applianceId: string,
        event: CustomEvent<ScheduleTwoChoiceRowSelectDetail>,
    ): void {
        event.stopPropagation();
        this._handleApplianceOverwriteDecision(applianceId, event.detail.value);
    }

    private _handleApplianceTakeoverDecision(applianceId: string, enabled: boolean): void {
        this._manualTakeoverAppliances = {
            ...this._manualTakeoverAppliances,
            [applianceId]: enabled,
        };
        this._editedApplianceIds = this._buildEditedApplianceIds(
            this._draftApplianceActions,
            this._overwriteMixedAppliances,
            {
                ...this._manualTakeoverAppliances,
                [applianceId]: enabled,
            },
        );
    }

    private _handleApplianceTakeoverSelect(
        applianceId: string,
        event: CustomEvent<ScheduleTwoChoiceRowSelectDetail>,
    ): void {
        event.stopPropagation();
        this._handleApplianceTakeoverDecision(applianceId, event.detail.value);
    }

    private _handleCancel(): void {
        this.open = false;
    }

    private _handleActionOptionSelect(event: CustomEvent<ScheduleActionOptionSelectDetail>): void {
        this._setActionKind(event.detail.actionKind);
    }

    private _handleApplianceActionChange(
        event: CustomEvent<ScheduleApplianceActionChangeDetail>,
    ): void {
        const { applianceId, action, valid } = event.detail;
        this._applianceValidity = {
            ...this._applianceValidity,
            [applianceId]: valid,
        };
        const nextDraftApplianceActions = {
            ...this._draftApplianceActions,
            [applianceId]: this._cloneDraftApplianceAction(action),
        };
        this._draftApplianceActions = nextDraftApplianceActions;
        this._editedApplianceIds = this._buildEditedApplianceIds(
            nextDraftApplianceActions,
            this._overwriteMixedAppliances,
        );
    }

    private _handleSubmit(): void {
        const result = this._buildResult();
        if (result === null) {
            return;
        }

        this.dispatchEvent(new CustomEvent("schedule-dialog-submit", {
            bubbles: true,
            composed: true,
            detail: result,
        }));
    }

    private _buildResult(): ScheduleRangeEditIntent | null {
        if (this.dialogState === null || this.dialogState.selectedSlots.length === 0) {
            return null;
        }

        const inverter = this._buildInverterEditIntent();
        if (inverter === null) {
            return null;
        }

        return {
            inverter,
            appliances: this._buildApplianceEditIntents(),
        };
    }

    private _buildInverterEditIntent(): ScheduleInverterEditIntent | null {
        if (!this._inverterEdited) {
            return { kind: "keep" };
        }

        const action = this._buildCurrentInverterAction();
        if (action === null) {
            return null;
        }

        return { kind: "set_user", action: cloneScheduleInverterAction(action) };
    }

    private _buildApplianceEditIntents(): Record<string, ScheduleApplianceEditIntent> {
        return Object.fromEntries(
            this._getTrackedApplianceIds().map((applianceId) => [
                applianceId,
                this._buildApplianceEditIntent(applianceId),
            ]),
        );
    }

    private _buildApplianceEditIntent(applianceId: string): ScheduleApplianceEditIntent {
        if (!this._editedApplianceIds.includes(applianceId)) {
            return { kind: "keep" };
        }

        const action = this._draftApplianceActions[applianceId] ?? null;
        return action === null
            ? { kind: "unset_user" }
            : { kind: "set_user", action: cloneScheduleApplianceAction(action) };
    }

    private _buildCurrentInverterAction(): ScheduleAction | null {
        if (this._actionKind === null) {
            return null;
        }

        if (!this._isTargetActionKind(this._actionKind)) {
            return { kind: this._actionKind };
        }

        if (!/^\d+$/.test(this._targetSocInput)) {
            return null;
        }

        const targetSoc = Number(this._targetSocInput);
        if (!Number.isInteger(targetSoc) || targetSoc < 0 || targetSoc > 100) {
            return null;
        }

        return {
            kind: this._actionKind,
            targetSoc,
        };
    }

    private _buildActionOptionPreview(actionKind: ScheduleAction["kind"]): ScheduleAction {
        if (!this._isTargetActionKind(actionKind)) {
            return { kind: actionKind };
        }

        const targetSoc = this._resolvePreviewTargetSoc(actionKind);
        return targetSoc === null
            ? { kind: actionKind }
            : { kind: actionKind, targetSoc };
    }

    private _resolvePreviewTargetSoc(actionKind: "charge_to_target_soc" | "discharge_to_target_soc"): number | null {
        if (/^\d+$/.test(this._targetSocInput)) {
            return Number(this._targetSocInput);
        }

        if (this._actionKind !== null && this._isTargetActionKind(this._actionKind) && this._targetSocInput.trim().length === 0) {
            return null;
        }

        if (this._targetSocInput.trim().length > 0) {
            return null;
        }

        return actionKind === "charge_to_target_soc"
            ? DEFAULT_CHARGE_TARGET_SOC
            : DEFAULT_DISCHARGE_TARGET_SOC;
    }

    private _getEffectiveInverterAuthorship(): ScheduleActionAuthorshipSummary | null {
        const currentAction = this._buildCurrentInverterAction();
        if (currentAction?.kind === "empty") {
            return NO_AUTHOR_DIALOG_AUTHORSHIP;
        }

        if (currentAction !== null && this._inverterEdited) {
            return USER_DIALOG_AUTHORSHIP;
        }

        return this._authorshipSummary?.inverter ?? null;
    }

    private _getEffectiveApplianceAuthorship(applianceId: string): ScheduleActionAuthorshipSummary | null {
        if (this._draftApplianceActions[applianceId] === null) {
            return NO_AUTHOR_DIALOG_AUTHORSHIP;
        }

        if (this._editedApplianceIds.includes(applianceId)) {
            return USER_DIALOG_AUTHORSHIP;
        }

        return this._authorshipSummary?.appliances[applianceId] ?? null;
    }

    private _isTargetActionKind(
        actionKind: ScheduleAction["kind"],
    ): actionKind is "charge_to_target_soc" | "discharge_to_target_soc" {
        return isTargetScheduleAction({ kind: actionKind });
    }

    private _updateInverterEditedState(): void {
        const selectionSummary = this._selectionSummary?.inverter;
        if (!selectionSummary) {
            this._inverterEdited = false;
            return;
        }

        if (this._shouldShowInverterTakeoverDecision() && !this._manualTakeoverInverter) {
            this._inverterEdited = false;
            return;
        }

        if (selectionSummary.state === "mixed") {
            this._inverterEdited = this._overwriteMixedInverter;
            return;
        }

        if (this._shouldShowInverterTakeoverDecision()) {
            this._inverterEdited = true;
            return;
        }

        const currentAction = this._buildCurrentInverterAction();
        this._inverterEdited = currentAction === null
            ? false
            : !areScheduleActionsEqual(currentAction, selectionSummary.seedValue);
    }

    private _isApplianceActionEdited(
        applianceId: string,
        nextAction: ScheduleApplianceAction | null,
        overwriteMixedAppliances: Record<string, boolean> = this._overwriteMixedAppliances,
        manualTakeoverAppliances: Record<string, boolean> = this._manualTakeoverAppliances,
    ): boolean {
        const summary = this._selectionSummary?.appliances[applianceId];
        if (!summary) {
            return false;
        }

        if (this._shouldShowApplianceTakeoverDecision(applianceId) && !(manualTakeoverAppliances[applianceId] ?? false)) {
            return false;
        }

        if (summary.state === "mixed") {
            return overwriteMixedAppliances[applianceId] ?? false;
        }

        if (this._shouldShowApplianceTakeoverDecision(applianceId)) {
            return true;
        }

        const normalizedInitialAction = this._cloneDraftApplianceAction(summary.seedValue);
        const normalizedNextAction = this._cloneDraftApplianceAction(nextAction);
        return normalizedNextAction === null || normalizedInitialAction === null
            ? normalizedNextAction !== normalizedInitialAction
            : !areScheduleApplianceActionsEqual(normalizedNextAction, normalizedInitialAction);
    }

    private _buildEditedApplianceIds(
        draftApplianceActions: Record<string, ScheduleApplianceAction | null>,
        overwriteMixedAppliances: Record<string, boolean> = this._overwriteMixedAppliances,
        manualTakeoverAppliances: Record<string, boolean> = this._manualTakeoverAppliances,
        selectionAppliances: ScheduleDialogState["selectionSummary"]["appliances"] = this._selectionSummary?.appliances ?? {},
    ): string[] {
        return this._getTrackedApplianceIds(selectionAppliances, draftApplianceActions).flatMap((applianceId) =>
            this._isApplianceActionEdited(
                applianceId,
                draftApplianceActions[applianceId] ?? null,
                overwriteMixedAppliances,
                manualTakeoverAppliances,
            )
                ? [applianceId]
                : [],
        );
    }

    private _getTrackedApplianceIds(
        selectionAppliances: ScheduleDialogState["selectionSummary"]["appliances"] = this._selectionSummary?.appliances ?? {},
        draftApplianceActions: Record<string, ScheduleApplianceAction | null> = this._draftApplianceActions,
    ): string[] {
        return [...new Set([
            ...Object.keys(selectionAppliances),
            ...this.appliances.map((appliance) => appliance.id),
            ...Object.keys(draftApplianceActions),
        ])];
    }

    private _cloneDraftApplianceAction(
        action: ScheduleApplianceAction | null,
    ): ScheduleApplianceAction | null {
        return action === null ? null : cloneScheduleApplianceAction(action);
    }

    private _inverterPanelClasses(): string {
        if (!this._isInverterEditorActive() || this._actionKind === null || this._actionKind === "empty") {
            return "panel";
        }

        const action = this._buildActionOptionPreview(this._actionKind);
        const presentation = getScheduleActionPresentation(action, this.localize);
        return `panel inverter-panel-highlight ${presentation.toneClass}`;
    }

    private _closeDialogElement(): void {
        this.open = false;
    }

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

    private _isInverterEditorActive(): boolean {
        if (this._selectionSummary === null) {
            return false;
        }

        if (this._shouldShowInverterTakeoverDecision() && !this._manualTakeoverInverter) {
            return false;
        }

        return this._selectionSummary.inverter.state === "uniform"
            || this._overwriteMixedInverter;
    }

    private _isApplianceEditorActive(applianceId: string): boolean {
        const summary = this._selectionSummary?.appliances[applianceId];
        if (summary === undefined) {
            return true;
        }

        if (this._shouldShowApplianceTakeoverDecision(applianceId) && !(this._manualTakeoverAppliances[applianceId] ?? false)) {
            return false;
        }

        return summary.state === "uniform" || (this._overwriteMixedAppliances[applianceId] ?? false);
    }

    private _resetInverterDraft(): void {
        const seedValue = this._selectionSummary?.inverter.seedValue;
        if (!seedValue) {
            return;
        }

        this._actionKind = seedValue.kind;
        this._targetSocInput = seedValue.targetSoc?.toString() ?? "";
    }

    private _buildApplianceSeedDraft(applianceId: string): ScheduleApplianceAction | null {
        return this._cloneDraftApplianceAction(
            this._selectionSummary?.appliances[applianceId]?.seedValue ?? null,
        );
    }

    private _shouldShowInverterTakeoverDecision(): boolean {
        const authorship = this._authorshipSummary?.inverter;
        return authorship?.state === "automation" || authorship?.state === "mixed";
    }

    private _shouldShowApplianceTakeoverDecision(applianceId: string): boolean {
        const authorship = this._authorshipSummary?.appliances[applianceId];
        return authorship?.state === "automation" || authorship?.state === "mixed";
    }

    private _buildAuthorshipDecisionCopy(authorship: ScheduleActionAuthorshipSummary): string {
        return authorship.state === "automation"
            ? this.localize("scheduling.dialog.automation_owns_action")
            : this.localize("scheduling.dialog.mixed_authorship_summary");
    }

    private _buildDialogInverterOptionTitle(
        action: ScheduleAction,
        authorship: ScheduleActionAuthorshipSummary | null,
    ): string {
        return [
            getScheduleActionPresentation(action, this.localize).label,
            action.kind === "empty" ? "" : this._buildDialogAuthorshipLabel(authorship),
        ].filter((part) => part.length > 0).join(" · ");
    }

    private _buildDialogApplianceOptionTitle(
        appliance: Pick<ScheduleApplianceMetadata, "name" | "kind" | "icon">,
        option: { value: ScheduleApplianceAction | null; authorship: ScheduleActionAuthorshipSummary | null },
    ): string {
        const actionLabel = getScheduleApplianceActionPresentation({
            appliance,
            action: option.value,
            localize: this.localize,
        }).label;
        return [
            appliance.name,
            actionLabel,
            this._buildDialogAuthorshipLabel(option.authorship),
        ].filter((part) => part.length > 0).join(" · ");
    }

    private _buildDialogAuthorshipLabel(authorship: ScheduleActionAuthorshipSummary | null): string {
        if (authorship === null || authorship.state === "none") {
            return "";
        }

        if (authorship.state === "user") {
            return this.localize("scheduling.authorship.set_by_user");
        }
        if (authorship.state === "automation") {
            return this.localize("scheduling.authorship.set_by_automation");
        }

        return [
            this.localize("scheduling.authorship.mixed"),
            `${this.localize("scheduling.authorship.user")}: ${authorship.counts.user}`,
            `${this.localize("scheduling.authorship.automation")}: ${authorship.counts.automation}`,
        ].join(", ");
    }

    private _buildMissingMixedApplianceIds(): string[] {
        const knownApplianceIds = new Set(this.appliances.map((appliance) => appliance.id));
        return Object.entries(this._selectionSummary?.appliances ?? {})
            .flatMap(([applianceId, summary]) =>
                !knownApplianceIds.has(applianceId) && summary.state === "mixed"
                    ? [applianceId]
                    : [],
            );
    }

    private _buildFallbackApplianceChipMetadata(
        applianceId: string,
        summary: ScheduleSelectionValueSummary<ScheduleApplianceAction | null>,
    ): Pick<ScheduleApplianceMetadata, "id" | "name" | "kind" | "icon"> {
        const firstAction = summary.distinctValues.find((option) => option.value !== null)?.value ?? null;
        if (firstAction !== null && isScheduleEvChargerAction(firstAction)) {
            return { id: applianceId, name: applianceId, kind: "ev_charger", icon: "mdi:car-electric" };
        }
        if (firstAction !== null && isScheduleClimateApplianceAction(firstAction)) {
            return { id: applianceId, name: applianceId, kind: "climate", icon: "mdi:air-conditioner" };
        }
        if (firstAction !== null && isScheduleGenericApplianceAction(firstAction)) {
            return { id: applianceId, name: applianceId, kind: "generic", icon: "mdi:power-plug" };
        }

        return { id: applianceId, name: applianceId, kind: "generic", icon: "mdi:flash-outline" };
    }
}
