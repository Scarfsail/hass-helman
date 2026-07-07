import { LitElement, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import {
    EMPTY_SCHEDULE_HEADER_MODEL,
    type ScheduleHeaderModel,
} from "../model/schedule-header-model";
import { schedulingSharedStyles } from "../styles/scheduling-shared-styles";

@customElement("scheduling-card-header")
export class SchedulingCardHeader extends LitElement {
    static styles = [
        schedulingSharedStyles,
        css`
            .header-row {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 8px 12px;
            }

            .header-status {
                flex: 1 1 160px;
                min-width: 0;
            }

            .header-controls {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                justify-content: flex-end;
                gap: 8px 12px;
                margin-inline-start: auto;
            }

            .toggle-control {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                color: var(--secondary-text-color);
                font-size: 0.84rem;
                white-space: nowrap;
            }
        `,
    ];

    @property({ attribute: false }) public model: ScheduleHeaderModel = EMPTY_SCHEDULE_HEADER_MODEL;

    render() {
        return html`
            <div class="header-row">
                ${this.model.statusText === null
                    ? nothing
                    : html`<div class="header-status muted">${this.model.statusText}</div>`}
                <div class="header-controls">
                    <button
                        class="icon-button"
                        type="button"
                        @click=${this._handleRefresh}
                        ?disabled=${this.model.refreshDisabled}
                        title=${this.model.refreshLabel}
                        aria-label=${this.model.refreshLabel}
                    >
                        ↻
                    </button>
                    <label class="toggle-control">
                        <span>${this.model.toggleLabel}</span>
                        <ha-switch
                            .checked=${this.model.executionEnabled}
                            ?disabled=${this.model.toggleDisabled}
                            aria-label=${this.model.toggleLabel}
                            @change=${this._handleToggle}
                        ></ha-switch>
                    </label>
                </div>
            </div>
        `;
    }

    private _handleRefresh(): void {
        this.dispatchEvent(new CustomEvent("refresh-schedule", {
            bubbles: true,
            composed: true,
        }));
    }

    private _handleToggle(event: Event): void {
        const target = event.currentTarget as unknown as { checked: boolean };
        this.dispatchEvent(new CustomEvent("toggle-schedule-execution", {
            bubbles: true,
            composed: true,
            detail: { enabled: target.checked },
        }));
    }
}
