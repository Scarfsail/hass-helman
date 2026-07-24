import { LitElement, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
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

            .running-toggle {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                flex: 1 1 auto;
                min-width: 0;
                padding: 0;
                background: none;
                border: none;
                color: var(--secondary-text-color);
                font: inherit;
                font-size: 0.84rem;
                text-align: start;
                cursor: pointer;
                transition: color 120ms ease;
            }

            .running-toggle[disabled] {
                cursor: default;
            }

            .running-toggle:not([disabled]):hover {
                color: var(--primary-color);
            }

            .running-toggle-icon {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                flex: 0 0 18px;
                width: 18px;
                height: 18px;
                border-radius: 999px;
                font-size: 0.82rem;
                font-weight: 700;
                line-height: 1;
                transition: background-color 120ms ease;
            }

            .running-toggle:not([disabled]):hover .running-toggle-icon {
                background: color-mix(in srgb, var(--primary-color) 10%, transparent);
            }

            .running-toggle-label {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
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
                <button
                    class="running-toggle"
                    type="button"
                    ?disabled=${this.model.runningToggleDisabled}
                    aria-expanded=${this.model.runningExpanded ? "true" : "false"}
                    @click=${this._handleToggleRunning}
                >
                    <span class="running-toggle-icon" aria-hidden="true">
                        ${this.model.runningToggleDisabled
                            ? ""
                            : this.model.runningExpanded ? "−" : "+"}
                    </span>
                    <span class="running-toggle-label">${this.model.runningLabel}</span>
                </button>
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

    private _handleToggleRunning(): void {
        this.dispatchEvent(new CustomEvent("toggle-running-entities", {
            bubbles: true,
            composed: true,
        }));
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
