import { LitElement, css, html, type PropertyValues } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { LocalizeFunction } from "../../localize/localize";
import "../components/scheduling-action-option-card";
import "./scheduling-climate-appliance-editor";
import "./scheduling-ev-charger-editor";
import "./scheduling-generic-appliance-editor";
import type { ScheduleActionOptionSelectDetail } from "../components/scheduling-action-option-card";
import type {
    EntityScheduleAction,
    EntityScheduleTarget,
} from "../model/entity-day-schedule-model";
import { isEntityInverterAction } from "../model/entity-day-schedule-model";
import type {
    ScheduleApplianceMetadata,
    ScheduleClimateApplianceMetadata,
    ScheduleEvChargerApplianceMetadata,
    ScheduleGenericApplianceMetadata,
} from "../model/schedule-appliance-metadata";
import type { ScheduleAction, ScheduleApplianceAction } from "../schedule-types";
import { schedulingSharedStyles } from "../styles/scheduling-shared-styles";
import type { ScheduleApplianceActionChangeDetail } from "./schedule-appliance-editor-types";

const DEFAULT_CHARGE_TARGET_SOC = 100;
const DEFAULT_DISCHARGE_TARGET_SOC = 15;

/**
 * The inverter kinds a block can hold.
 *
 * "empty" is missing on purpose: in a block editor "nothing scheduled" is not an
 * action to pick, it is removing the block.
 */
const INVERTER_ACTION_KINDS: readonly ScheduleAction["kind"][] = [
    "normal",
    "charge_to_target_soc",
    "discharge_to_target_soc",
    "stop_charging",
    "stop_discharging",
    "stop_export",
];

export interface EntityScheduleActionChangeDetail {
    action: EntityScheduleAction;
    valid: boolean;
}

/**
 * The controls for one entity's action, whichever lane it lives in.
 *
 * Appliances reuse the very editors the range dialog uses, so a block edit and a
 * slot edit offer the same choices in the same words; only the inverter gets a
 * local layout, because the range dialog's version is wired into its mixed and
 * takeover state.
 */
@customElement("scheduling-entity-action-editor")
export class SchedulingEntityActionEditor extends LitElement {
    static styles = [
        schedulingSharedStyles,
        css`
            .inverter-editor {
                display: flex;
                flex-direction: column;
                gap: 10px;
            }

            .action-options {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
            }

            .target-field {
                width: min(180px, 100%);
            }
        `,
    ];

    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public target!: EntityScheduleTarget;
    @property({ attribute: false }) public appliance: ScheduleApplianceMetadata | null = null;
    @property({ attribute: false }) public action: EntityScheduleAction = null;

    @state() private _actionKind: ScheduleAction["kind"] | null = null;
    @state() private _targetSocInput = "";

    protected willUpdate(changedProperties: PropertyValues<this>): void {
        super.willUpdate(changedProperties);
        if (!changedProperties.has("action") && !changedProperties.has("target")) {
            return;
        }

        if (this.target?.kind !== "inverter") {
            return;
        }

        const action = isEntityInverterAction(this.action) ? this.action : null;
        this._actionKind = action === null || action.kind === "empty" ? null : action.kind;
        this._targetSocInput = action?.targetSoc?.toString() ?? "";
    }

    render() {
        if (!this.target) {
            return nothing;
        }

        return this.target.kind === "inverter"
            ? this._renderInverterEditor()
            : this._renderApplianceEditor();
    }

    private _renderInverterEditor() {
        return html`
            <div class="inverter-editor">
                <div class="action-options" role="radiogroup" aria-label=${this.localize("scheduling.dialog.inverter")}>
                    ${INVERTER_ACTION_KINDS.map((actionKind) => html`
                        <scheduling-action-option-card
                            .action=${this._buildOptionPreview(actionKind)}
                            .checked=${this._actionKind === actionKind}
                            .localize=${this.localize}
                            radioName="entity-schedule-action-kind"
                            @schedule-action-option-select=${this._handleActionOptionSelect}
                        ></scheduling-action-option-card>
                    `)}
                </div>
                ${this._isTargetActionKind(this._actionKind) ? html`
                    <ha-textfield
                        class="target-field"
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
                ` : nothing}
            </div>
        `;
    }

    private _renderApplianceEditor() {
        const appliance = this.appliance;
        if (appliance === null || !appliance.supportsAuthoring) {
            return html`
                <div class="field-help">${this.localize("scheduling.dialog.appliance.unsupported_authoring")}</div>
            `;
        }

        const action = this.action === null || isEntityInverterAction(this.action)
            ? null
            : this.action;
        switch (appliance.kind) {
            case "ev_charger":
                return html`
                    <scheduling-ev-charger-editor
                        .appliance=${appliance as ScheduleEvChargerApplianceMetadata}
                        .localize=${this.localize}
                        .action=${action}
                        .showSummary=${false}
                        .showControls=${true}
                        @schedule-appliance-action-change=${this._handleApplianceActionChange}
                    ></scheduling-ev-charger-editor>
                `;
            case "climate":
                return html`
                    <scheduling-climate-appliance-editor
                        .appliance=${appliance as ScheduleClimateApplianceMetadata}
                        .localize=${this.localize}
                        .action=${action}
                        .showSummary=${false}
                        .showControls=${true}
                        @schedule-appliance-action-change=${this._handleApplianceActionChange}
                    ></scheduling-climate-appliance-editor>
                `;
            default:
                return html`
                    <scheduling-generic-appliance-editor
                        .appliance=${appliance as ScheduleGenericApplianceMetadata}
                        .localize=${this.localize}
                        .action=${action}
                        .showSummary=${false}
                        .showControls=${true}
                        @schedule-appliance-action-change=${this._handleApplianceActionChange}
                    ></scheduling-generic-appliance-editor>
                `;
        }
    }

    private _handleApplianceActionChange(
        event: CustomEvent<ScheduleApplianceActionChangeDetail>,
    ): void {
        event.stopPropagation();
        this._emitChange(event.detail.action as ScheduleApplianceAction | null, event.detail.valid);
    }

    private _handleActionOptionSelect(event: CustomEvent<ScheduleActionOptionSelectDetail>): void {
        event.stopPropagation();
        const actionKind = event.detail.actionKind;
        this._actionKind = actionKind;
        if (this._isTargetActionKind(actionKind) && this._targetSocInput.trim().length === 0) {
            this._targetSocInput = actionKind === "charge_to_target_soc"
                ? String(DEFAULT_CHARGE_TARGET_SOC)
                : String(DEFAULT_DISCHARGE_TARGET_SOC);
        }

        this._emitInverterChange();
    }

    private _handleTargetSocInput(event: Event): void {
        this._targetSocInput = (event.currentTarget as HTMLInputElement).value;
        this._emitInverterChange();
    }

    private _emitInverterChange(): void {
        if (this._actionKind === null) {
            this._emitChange(null, false);
            return;
        }

        if (!this._isTargetActionKind(this._actionKind)) {
            this._emitChange({ kind: this._actionKind }, true);
            return;
        }

        const targetSoc = Number(this._targetSocInput);
        const valid = /^\d+$/.test(this._targetSocInput) && targetSoc >= 0 && targetSoc <= 100;
        this._emitChange({ kind: this._actionKind, targetSoc }, valid);
    }

    private _emitChange(action: EntityScheduleAction, valid: boolean): void {
        this.dispatchEvent(new CustomEvent<EntityScheduleActionChangeDetail>("entity-action-change", {
            bubbles: true,
            composed: true,
            detail: { action, valid },
        }));
    }

    private _buildOptionPreview(actionKind: ScheduleAction["kind"]): ScheduleAction {
        if (!this._isTargetActionKind(actionKind)) {
            return { kind: actionKind };
        }

        const targetSoc = this._actionKind === actionKind && /^\d+$/.test(this._targetSocInput)
            ? Number(this._targetSocInput)
            : actionKind === "charge_to_target_soc"
            ? DEFAULT_CHARGE_TARGET_SOC
            : DEFAULT_DISCHARGE_TARGET_SOC;
        return { kind: actionKind, targetSoc };
    }

    private _isTargetActionKind(
        actionKind: ScheduleAction["kind"] | null,
    ): actionKind is "charge_to_target_soc" | "discharge_to_target_soc" {
        return actionKind === "charge_to_target_soc" || actionKind === "discharge_to_target_soc";
    }
}
