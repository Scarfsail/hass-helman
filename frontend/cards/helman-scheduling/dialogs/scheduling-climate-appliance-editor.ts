import { LitElement, css, html, type PropertyValues } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { LocalizeFunction } from "../../localize/localize";
import { schedulingSharedStyles } from "../styles/scheduling-shared-styles";
import type { ScheduleClimateApplianceMetadata } from "../model/schedule-appliance-metadata";
import {
    formatScheduleClimateModeLabel,
    type ScheduleApplianceActionToneClass,
} from "../model/schedule-appliance-action-presentation";
import type { ScheduleApplianceAction } from "../schedule-types";
import {
    isScheduleClimateApplianceAction,
} from "../schedule-types";
import type { ScheduleActionAuthorshipSummary } from "../schedule-types";
import type { ScheduleApplianceActionChangeDetail } from "./schedule-appliance-editor-types";

const CLIMATE_OFF_ACTION_MODE = "off";
const CLIMATE_OFF_EDITOR_MODE = "__off__";

type ClimateApplianceEditorMode = "none" | typeof CLIMATE_OFF_EDITOR_MODE | string;
type ClimateApplianceOptionPresentation = {
    icon: string;
    label: string;
    toneClass: ScheduleApplianceActionToneClass;
};

@customElement("scheduling-climate-appliance-editor")
export class SchedulingClimateApplianceEditor extends LitElement {
    static styles = [
        schedulingSharedStyles,
        css`
            .appliance-panel {
                display: flex;
                flex-direction: column;
                gap: 10px;
                padding: 10px;
                border: 1px solid var(--divider-color);
                border-radius: 12px;
                background: var(--secondary-background-color);
            }

            .action-options {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
            }

            .preview-chip {
                box-sizing: border-box;
                width: 100%;
                min-width: 0;
                max-width: 100%;
                overflow: hidden;
                justify-content: flex-start;
                min-height: 20px;
                padding: 2px 6px;
                font-size: 0.75rem;
                line-height: 1.1;
                gap: 4px;
            }

            .preview-icon {
                flex-shrink: 0;
                color: var(--schedule-action-tone-icon, currentColor);
                --mdc-icon-size: 0.85rem;
            }

            .chip-label {
                flex: 1 1 auto;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
            }
        `,
    ];

    @property({ attribute: false }) public appliance?: ScheduleClimateApplianceMetadata;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public action: ScheduleApplianceAction | null = null;
    @property({ attribute: false }) public summaryContent: unknown = nothing;
    @property({ attribute: false }) public selectedAuthorship: ScheduleActionAuthorshipSummary | null = null;
    @property({ type: Boolean }) public showSummary = false;
    @property({ type: Boolean }) public showControls = true;

    @state() private _mode: ClimateApplianceEditorMode = "none";

    protected willUpdate(changedProperties: PropertyValues<this>): void {
        super.willUpdate(changedProperties);
        if (changedProperties.has("action") || changedProperties.has("appliance")) {
            this._applyAction(this.action);
        }
    }

    render() {
        if (!this.appliance) {
            return nothing;
        }

        return html`
            <div class=${`appliance-panel${this._panelHighlightClass()}`}>
                <div class="panel-header-inline">
                    <div class="panel-title">${this.appliance.name}</div>
                    <div class="field-help">${this.localize("scheduling.dialog.appliance_kind.climate")}</div>
                </div>
                ${this.showSummary ? this.summaryContent : nothing}
                ${this.showSummary && this.showControls ? html`<div class="mixed-editor-divider"></div>` : nothing}
                ${this.showControls ? html`
                    <div class="action-options compact-action-options">
                        ${this._renderModeOption("none")}
                        ${this._renderModeOption(CLIMATE_OFF_EDITOR_MODE)}
                        ${this.appliance.scheduleCapabilities.modes.map((mode) => this._renderModeOption(mode))}
                    </div>
                ` : nothing}
            </div>
        `;
    }

    private _renderModeOption(mode: ClimateApplianceEditorMode) {
        const checked = this._mode === mode;
        const presentation = this._buildModePresentation(mode);
        return html`
            <label class="compact-action-option">
                <input
                    class="sr-only"
                    type="radio"
                    name=${`climate-schedule-mode-${this.appliance?.id ?? "unknown"}`}
                    value=${mode}
                    .checked=${checked}
                    aria-label=${presentation.label}
                    @change=${() => this._handleModeChange(mode)}
                />
                <span class=${this._buildPreviewChipClasses(presentation.toneClass, checked)}>
                    <ha-icon class="preview-icon" .icon=${presentation.icon} aria-hidden="true"></ha-icon>
                    <span class="chip-label">${presentation.label}</span>
                </span>
            </label>
        `;
    }

    private _applyAction(action: ScheduleApplianceAction | null): void {
        if (!this.appliance || action === null || !isScheduleClimateApplianceAction(action)) {
            this._mode = "none";
            return;
        }

        if (action.mode === CLIMATE_OFF_ACTION_MODE) {
            this._mode = CLIMATE_OFF_EDITOR_MODE;
            return;
        }

        this._mode = this.appliance.scheduleCapabilities.modes.includes(action.mode)
            ? action.mode
            : "none";
    }

    private _handleModeChange(mode: ClimateApplianceEditorMode): void {
        this._mode = mode;
        this._emitChange();
    }

    private _emitChange(): void {
        if (!this.appliance) {
            return;
        }

        this.dispatchEvent(new CustomEvent("schedule-appliance-action-change", {
            bubbles: true,
            composed: true,
            detail: this._buildDetail(),
        }));
    }

    private _buildDetail(): ScheduleApplianceActionChangeDetail {
        if (!this.appliance) {
            return { applianceId: "", action: null, valid: false };
        }

        if (this._mode === "none") {
            return {
                applianceId: this.appliance.id,
                action: null,
                valid: true,
            };
        }

        if (this._mode === CLIMATE_OFF_EDITOR_MODE) {
            return {
                applianceId: this.appliance.id,
                action: { mode: CLIMATE_OFF_ACTION_MODE },
                valid: true,
            };
        }

        const valid = this.appliance.scheduleCapabilities.modes.includes(this._mode);
        return {
            applianceId: this.appliance.id,
            action: valid ? { mode: this._mode } : null,
            valid,
        };
    }

    private _buildModePresentation(mode: ClimateApplianceEditorMode): ClimateApplianceOptionPresentation {
        if (!this.appliance || mode === "none") {
            return {
                icon: this.appliance?.icon ?? "mdi:circle-outline",
                label: this.localize("scheduling.dialog.appliance.no_action"),
                toneClass: "action-tone-neutral",
            };
        }

        if (mode === CLIMATE_OFF_EDITOR_MODE) {
            return {
                icon: this.appliance.icon,
                label: formatScheduleClimateModeLabel(CLIMATE_OFF_ACTION_MODE, this.localize),
                toneClass: "action-tone-stop",
            };
        }

        return {
            icon: this.appliance.icon,
            label: formatScheduleClimateModeLabel(mode, this.localize),
            toneClass: "action-tone-charge",
        };
    }

    private _panelHighlightClass(): string {
        if (!this.showControls) {
            return "";
        }
        if (this._mode === CLIMATE_OFF_EDITOR_MODE) {
            return " panel-highlight-stop";
        }
        if (this._mode !== "none") {
            return " panel-highlight-success";
        }
        return "";
    }

    private _buildPreviewChipClasses(
        toneClass: ClimateApplianceOptionPresentation["toneClass"],
        checked: boolean,
    ): string {
        const classes = ["chip", "action", "preview-chip", "selectable", toneClass];
        if (checked) {
            classes.push("selected");
            if (this.selectedAuthorship) {
                classes.push("authorship-decorated", `authorship-${this.selectedAuthorship.state}`);
            }
        }
        return classes.join(" ");
    }
}
