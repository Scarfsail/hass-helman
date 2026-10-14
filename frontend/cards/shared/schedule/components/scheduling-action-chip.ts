import { LitElement, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { LocalizeFunction } from "../../../localize/localize";
import { getScheduleActionPresentation } from "../model/schedule-action-presentation";
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

            .chip-label {
                flex: 1 1 auto;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
            }

        `,
    ];

    @property({ attribute: false }) public action?: ScheduleAction;
    @property({ attribute: false }) public localize?: LocalizeFunction;
    @property({ type: String }) public size: "compact" | "regular" = "regular";
    @property({ type: Boolean }) public interactive = false;
    @property({ type: Boolean }) public selected = false;
    @property({ attribute: false }) public authorship: ScheduleActionAuthorshipSummary | null = null;
    @property({ type: String }) public titleText = "";

    render() {
        if (!this.action || !this.localize) {
            return nothing;
        }

        const presentation = getScheduleActionPresentation(this.action, this.localize);
        const authorshipClass = this._buildAuthorshipClass();
        const candidateClass = presentation.isCandidate ? " candidate" : "";
        const classes = `chip action ${presentation.toneClass}${this.size === "compact" ? " compact" : ""}${this.interactive ? " selectable" : ""}${this.selected ? " selected" : ""}${authorshipClass}${candidateClass}`;
        return html`
            <span class=${classes} title=${this.titleText}>
                <ha-icon class="chip-icon" .icon=${presentation.icon} aria-hidden="true"></ha-icon>
                <span class="chip-label">${presentation.label}</span>
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
