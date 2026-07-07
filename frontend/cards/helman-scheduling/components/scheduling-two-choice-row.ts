import { LitElement, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import { schedulingSharedStyles } from "../styles/scheduling-shared-styles";

export interface ScheduleTwoChoiceRowSelectDetail {
    value: boolean;
}

@customElement("scheduling-two-choice-row")
export class SchedulingTwoChoiceRow extends LitElement {
    static styles = [schedulingSharedStyles];

    @property({ type: String }) public description = "";
    @property({ type: String }) public falseLabel = "";
    @property({ type: String }) public trueLabel = "";
    @property({ type: Boolean }) public value = false;
    @property({ type: String }) public groupName = "";
    @property({ type: String }) public ariaLabel = "";

    render() {
        if (!this.falseLabel || !this.trueLabel || !this.groupName) {
            return nothing;
        }

        return html`
            <div class="decision-inline">
                ${this.description
                    ? html`<div class="decision-copy field-help">${this.description}</div>`
                    : nothing}
                <div class="decision-row" role="radiogroup" aria-label=${this.ariaLabel || this.description}>
                    <label class="compact-action-option">
                        <input
                            class="sr-only"
                            type="radio"
                            name=${this.groupName}
                            .checked=${!this.value}
                            @change=${(event: Event) => this._handleSelect(false, event)}
                        />
                        <span class=${`decision-button${this.value ? "" : " selected"}`}>
                            ${this.falseLabel}
                        </span>
                    </label>
                    <label class="compact-action-option">
                        <input
                            class="sr-only"
                            type="radio"
                            name=${this.groupName}
                            .checked=${this.value}
                            @change=${(event: Event) => this._handleSelect(true, event)}
                        />
                        <span class=${`decision-button${this.value ? " selected" : ""}`}>
                            ${this.trueLabel}
                        </span>
                    </label>
                </div>
            </div>
        `;
    }

    private _handleSelect(value: boolean, event: Event): void {
        event.stopPropagation();
        this.dispatchEvent(new CustomEvent("schedule-two-choice-row-select", {
            bubbles: true,
            composed: true,
            detail: { value } satisfies ScheduleTwoChoiceRowSelectDetail,
        }));
    }
}
