import { LitElement, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { LocalizeFunction } from "../../../localize/localize";
import { getScheduleApplianceActionPresentation } from "../model/schedule-appliance-action-presentation";
import type { ScheduleApplianceDescriptor } from "../model/schedule-appliance-metadata";
import type { ScheduleActionAuthorshipSummary, ScheduleApplianceAction } from "../schedule-types";
import { schedulingSharedStyles } from "../styles/scheduling-shared-styles";

@customElement("scheduling-appliance-chip")
export class SchedulingApplianceChip extends LitElement {
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
                --mdc-icon-size: 0.85rem;
            }

            .chip-label {
                flex: 1 1 auto;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
        `,
    ];

    @property({ attribute: false }) public appliance?: ScheduleApplianceDescriptor;
    @property({ attribute: false }) public action: ScheduleApplianceAction | null = null;
    @property({ attribute: false }) public localize?: LocalizeFunction;
    @property({ type: String }) public size: "compact" | "regular" = "regular";
    @property({ attribute: false }) public authorship: ScheduleActionAuthorshipSummary | null = null;
    @property({ type: String }) public titleText = "";

    render() {
        if (!this.appliance || this.action === undefined || !this.localize) {
            return nothing;
        }

        const presentation = this._resolvePresentation();
        const classes = [
            "chip",
            "action",
            presentation.toneClass,
            ...this._buildAuthorshipClasses(),
            this.size === "compact" ? "compact" : "",
            presentation.isCandidate ? "candidate" : "",
        ].filter((className) => className.length > 0).join(" ");
        return html`
            <span class=${classes} title=${this.titleText}>
                <ha-icon class="chip-icon" .icon=${presentation.icon} aria-hidden="true"></ha-icon>
                <span class="chip-label">${presentation.label}</span>
            </span>
        `;
    }

    private _resolvePresentation() {
        return getScheduleApplianceActionPresentation({
            appliance: this.appliance!,
            action: this.action!,
            localize: this.localize!,
        });
    }

    private _buildAuthorshipClasses(): string[] {
        if (this.authorship === null || this.authorship.state === "none") {
            return [];
        }

        return ["authorship-decorated", `authorship-${this.authorship.state}`];
    }
}
