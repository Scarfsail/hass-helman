import { LitElement, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { LocalizeFunction } from "../../localize/localize";
import type { ScheduleActionLabelVariant } from "../model/schedule-labels";
import { getScheduleActionPresentation } from "../model/schedule-action-presentation";
import type { ScheduleAction, ScheduleActionAuthorshipSummary } from "../schedule-types";
import "./scheduling-action-chip";

export interface ScheduleActionOptionSelectDetail {
    actionKind: ScheduleAction["kind"];
}

@customElement("scheduling-action-option-card")
export class SchedulingActionOptionCard extends LitElement {
    @property({ attribute: false }) public action?: ScheduleAction;
    @property({ attribute: false }) public localize?: LocalizeFunction;
    @property({ type: Boolean }) public checked = false;
    @property({ type: String }) public radioName = "";
    @property({ type: String }) public labelVariant: ScheduleActionLabelVariant = "default";
    @property({ attribute: false }) public authorship: ScheduleActionAuthorshipSummary | null = null;

    protected createRenderRoot(): Element | ShadowRoot {
        return this;
    }

    render() {
        if (!this.action || !this.localize) {
            return nothing;
        }

        const presentation = getScheduleActionPresentation(this.action, this.localize, this.labelVariant);
        return html`
            <label class="compact-action-option">
                <input
                    class="sr-only"
                    type="radio"
                    name=${this.radioName}
                    .checked=${this.checked}
                    value=${this.action.kind}
                    aria-label=${presentation.label}
                    @change=${this._handleRadioChange}
                />
                <scheduling-action-chip
                    .action=${this.action}
                    .authorship=${this.checked ? this.authorship : null}
                    .localize=${this.localize}
                    .labelVariant=${this.labelVariant}
                    .interactive=${true}
                    .selected=${this.checked}
                    size="compact"
                ></scheduling-action-chip>
            </label>
        `;
    }

    private _handleRadioChange(event: Event): void {
        event.stopPropagation();
        this._emitSelect();
    }

    private _emitSelect(): void {
        if (!this.action) {
            return;
        }

        this.dispatchEvent(new CustomEvent("schedule-action-option-select", {
            bubbles: true,
            composed: true,
            detail: { actionKind: this.action.kind } satisfies ScheduleActionOptionSelectDetail,
        }));
    }
}
