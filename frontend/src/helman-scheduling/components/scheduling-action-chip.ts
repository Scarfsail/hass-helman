import { LitElement, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { LocalizeFunction } from "../../localize/localize";
import { getScheduleActionPresentation } from "../model/schedule-action-presentation";
import type { ScheduleActionLabelVariant } from "../model/schedule-labels";
import type { ScheduleAction, ScheduleActionAuthorshipSummary } from "../schedule-types";
import { schedulingSharedStyles } from "../styles/scheduling-shared-styles";

@customElement("scheduling-action-chip")
export class SchedulingActionChip extends LitElement {
    static styles = [
        schedulingSharedStyles,
        css`
            :host {
                display: inline-flex;
                min-width: 0;
                max-width: 100%;
            }

            .chip {
                box-sizing: border-box;
                width: 100%;
                min-width: 0;
                max-width: 100%;
                overflow: hidden;
                justify-content: flex-start;
            }

            .chip.compact {
                min-height: 20px;
                padding: 2px 6px;
                font-size: 0.75rem;
                line-height: 1.1;
                gap: 4px;
            }

            .chip-icon {
                flex-shrink: 0;
                color: var(--schedule-action-tone-icon, currentColor);
                --mdc-icon-size: 1rem;
            }

            .chip.compact .chip-icon {
                --mdc-icon-size: 0.85rem;
            }

            .chip.runtime-surface {
                box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--runtime-chip-state-color, transparent) 12%, transparent);
            }

            .chip.runtime-surface.runtime-following {
                --runtime-chip-state-color: var(--success-color, #2e7d32);
                --schedule-action-tone-border: color-mix(in srgb, var(--runtime-chip-state-color) 40%, var(--divider-color));
                --schedule-action-tone-bg: color-mix(in srgb, var(--runtime-chip-state-color) 12%, transparent);
                --schedule-action-tone-color: color-mix(in srgb, var(--runtime-chip-state-color) 82%, var(--primary-text-color));
                --schedule-action-tone-icon: var(--schedule-action-tone-color);
            }

            .chip.runtime-surface.runtime-diverged {
                --runtime-chip-state-color: var(--warning-color, #c27c0e);
                --schedule-action-tone-border: color-mix(in srgb, var(--runtime-chip-state-color) 42%, var(--divider-color));
                --schedule-action-tone-bg: color-mix(in srgb, var(--runtime-chip-state-color) 12%, transparent);
                --schedule-action-tone-color: color-mix(in srgb, var(--runtime-chip-state-color) 82%, var(--primary-text-color));
                --schedule-action-tone-icon: var(--schedule-action-tone-color);
            }

            .chip.runtime-surface.runtime-error {
                --runtime-chip-state-color: var(--error-color, #c62828);
                --schedule-action-tone-border: color-mix(in srgb, var(--runtime-chip-state-color) 44%, var(--divider-color));
                --schedule-action-tone-bg: color-mix(in srgb, var(--runtime-chip-state-color) 13%, transparent);
                --schedule-action-tone-color: color-mix(in srgb, var(--runtime-chip-state-color) 82%, var(--primary-text-color));
                --schedule-action-tone-icon: var(--schedule-action-tone-color);
            }

            .chip-label {
                flex: 1 1 auto;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            :host([icononly]) .chip {
                justify-content: center;
                padding-left: 4px;
                padding-right: 4px;
            }
        `,
    ];

    @property({ attribute: false }) public action?: ScheduleAction;
    @property({ attribute: false }) public localize?: LocalizeFunction;
    @property({ type: String }) public labelVariant: ScheduleActionLabelVariant = "default";
    @property({ type: String }) public size: "compact" | "regular" = "regular";
    @property({ type: String }) public surface: "scheduled" | "runtime" = "scheduled";
    @property({ type: String }) public runtimeState: "neutral" | "following" | "diverged" | "error" = "neutral";
    @property({ type: Boolean }) public iconOnly = false;
    @property({ type: Boolean }) public interactive = false;
    @property({ type: Boolean }) public selected = false;
    @property({ attribute: false }) public authorship: ScheduleActionAuthorshipSummary | null = null;
    @property({ type: String }) public titleText = "";

    render() {
        if (!this.action || !this.localize) {
            return nothing;
        }

        const presentation = getScheduleActionPresentation(this.action, this.localize, this.labelVariant);
        const runtimeStateClass = this.surface === "runtime" ? ` runtime-${this.runtimeState}` : "";
        const authorshipClass = this._buildAuthorshipClass();
        const classes = `chip action ${presentation.toneClass}${this.size === "compact" ? " compact" : ""}${this.interactive ? " selectable" : ""}${this.selected ? " selected" : ""}${this.surface === "runtime" ? " runtime-surface" : ""}${runtimeStateClass}${authorshipClass}`;
        return html`
            <span class=${classes} title=${this.titleText}>
                <ha-icon class="chip-icon" .icon=${presentation.icon} aria-hidden="true"></ha-icon>
                ${this.iconOnly ? nothing : html`<span class="chip-label">${presentation.label}</span>`}
            </span>
        `;
    }

    private _buildAuthorshipClass(): string {
        if (this.authorship === null) {
            return "";
        }

        if (this.authorship.state === "none") {
            return this.selected ? " authorship-decorated authorship-none" : "";
        }

        if (this.action?.kind === "empty") {
            return "";
        }

        return ` authorship-decorated authorship-${this.authorship.state}`;
    }
}
