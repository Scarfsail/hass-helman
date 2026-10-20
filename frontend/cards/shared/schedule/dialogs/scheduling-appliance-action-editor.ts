import { LitElement, css, html, type PropertyValues } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { LocalizeFunction } from "../../../localize/localize";
import type { ScheduleApplianceMetadata } from "../model/schedule-appliance-metadata";
import { APPLIANCE_KIND_UI, type ApplianceEditorDetail, type ApplianceOption } from "../model/schedule-appliance-kind-ui";
import type { ScheduleActionAuthorshipSummary, ScheduleApplianceAction } from "../schedule-types";
import type { ScheduleApplianceActionChangeDetail } from "./schedule-appliance-editor-types";
import { schedulingSharedStyles } from "../styles/scheduling-shared-styles";

@customElement("scheduling-appliance-action-editor")
export class SchedulingApplianceActionEditor extends LitElement {
    static styles = [schedulingSharedStyles, css`
        .appliance-panel { display: flex; flex-direction: column; gap: 10px; padding: 10px;
            border: 1px solid var(--divider-color); border-radius: 12px;
            background: var(--secondary-background-color); }
        .action-options { display: flex; flex-wrap: wrap; gap: 8px; }
        .action-detail-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px 12px; }
        .action-detail-fields .field { min-width: 0; }
        .preview-chip { box-sizing: border-box; width: 100%; min-width: 0; max-width: 100%;
            overflow: hidden; justify-content: flex-start; min-height: 20px; padding: 2px 6px;
            font-size: 0.75rem; line-height: 1.1; gap: 4px; }
        .preview-icon { flex-shrink: 0; color: var(--schedule-action-tone-icon, currentColor); --mdc-icon-size: 0.85rem; }
        .chip-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    `];

    @property({ attribute: false }) public appliance?: ScheduleApplianceMetadata;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public action: ScheduleApplianceAction | null = null;
    @property({ attribute: false }) public selectedAuthorship: ScheduleActionAuthorshipSummary | null = null;
    @property({ type: Boolean }) public showControls = true;

    @state() private _mode = "none";
    @state() private _vehicleId = "";
    @state() private _useMode = "";
    @state() private _ecoGear = "";

    protected willUpdate(changedProperties: PropertyValues<this>): void {
        super.willUpdate(changedProperties);
        if (changedProperties.has("action") || changedProperties.has("appliance")) this._applyAction();
    }

    render() {
        const appliance = this.appliance;
        if (!appliance) return nothing;
        const descriptor = APPLIANCE_KIND_UI[appliance.kind];
        return html`
            <div class=${`appliance-panel${this._panelHighlightClass()}`}>
                <div class="panel-header-inline">
                    <div class="panel-title">${appliance.name}</div>
                    <div class="field-help">${this.localize(`scheduling.dialog.appliance_kind.${appliance.kind}`)}</div>
                </div>
                ${this.showControls ? html`
                    <div class="action-options compact-action-options">
                        ${descriptor.options(appliance, this.localize).map((option) => this._renderOption(option))}
                    </div>
                    ${descriptor.renderDetail?.(appliance, this._mode, this._detail(), this.localize) ?? nothing}
                ` : nothing}
            </div>
        `;
    }

    private _renderOption(option: ApplianceOption) {
        const checked = this._mode === option.mode;
        const classes = ["chip", "action", "preview-chip", "selectable", `action-tone-${option.tone}`];
        if (checked) {
            classes.push("selected");
            if (this.selectedAuthorship) classes.push("authorship-decorated", `authorship-${this.selectedAuthorship.state}`);
        }
        return html`
            <label class="compact-action-option">
                <input class="sr-only" type="radio" name=${`${this.appliance?.kind}-schedule-mode-${this.appliance?.id ?? "unknown"}`}
                    value=${option.mode} .checked=${checked} aria-label=${option.label}
                    @change=${() => this._handleModeChange(option.mode)} />
                <span class=${classes.join(" ")}>
                    <ha-icon class="preview-icon" .icon=${option.icon} aria-hidden="true"></ha-icon>
                    <span class="chip-label">${option.label}</span>
                </span>
            </label>
        `;
    }

    private _applyAction(): void {
        const appliance = this.appliance;
        if (!appliance) {
            this._mode = "none";
            this._vehicleId = this._useMode = this._ecoGear = "";
            return;
        }
        this._mode = APPLIANCE_KIND_UI[appliance.kind].mode(this.action, appliance);
        if (appliance.kind === "ev_charger") {
            const action = this.action !== null && "charge" in this.action ? this.action : null;
            this._vehicleId = action?.vehicleId ?? appliance.vehicles[0]?.id ?? "";
            this._useMode = action?.useMode ?? appliance.metadata.scheduleCapabilities.useModes[0] ?? "Fast";
            this._ecoGear = action?.ecoGear ?? appliance.metadata.scheduleCapabilities.ecoGears[0] ?? "";
        }
    }

    private _handleModeChange(mode: string): void {
        this._mode = mode;
        this._emitChange();
    }

    private _detail(): ApplianceEditorDetail {
        return {
            vehicleId: this._vehicleId, useMode: this._useMode, ecoGear: this._ecoGear,
            onVehicleChange: (event) => {
                this._vehicleId = (event.currentTarget as HTMLSelectElement).value;
                this._emitChange();
            },
            onUseModeChange: (event) => {
                this._useMode = (event.currentTarget as HTMLSelectElement).value;
                if (this._useMode === "ECO" && !this._ecoGear && this.appliance?.kind === "ev_charger") {
                    this._ecoGear = this.appliance.metadata.scheduleCapabilities.ecoGears[0] ?? "";
                }
                this._emitChange();
            },
            onEcoGearChange: (event) => {
                this._ecoGear = (event.currentTarget as HTMLSelectElement).value;
                this._emitChange();
            },
        };
    }

    private _emitChange(): void {
        const appliance = this.appliance;
        if (!appliance) return;
        const result = APPLIANCE_KIND_UI[appliance.kind].action(this._mode, appliance, this._detail());
        this.dispatchEvent(new CustomEvent<ScheduleApplianceActionChangeDetail>("schedule-appliance-action-change", {
            bubbles: true, composed: true,
            detail: { applianceId: appliance.id, ...result },
        }));
    }

    private _panelHighlightClass(): string {
        if (!this.showControls) return "";
        if (this._mode === "off" || this._mode === "__off__") return " panel-highlight-stop";
        return this._mode !== "none" ? " panel-highlight-success" : "";
    }
}
