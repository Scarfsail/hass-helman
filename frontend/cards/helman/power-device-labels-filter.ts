import { LitElement, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";

@customElement("power-device-labels-filter")
export class PowerDeviceLabelsFilter extends LitElement {
    @property({ type: Array }) labels: string[] = [];
    @property({ type: Array }) active: string[] = [];

    static get styles() {
        return css`
            .bar {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                padding: 6px 6px 0 6px;
            }
            button.chip {
                appearance: none;
                border: 1px solid var(--ha-card-border-color, var(--divider-color, #444));
                background: var(--card-background-color, #1c1c1c);
                color: var(--secondary-text-color);
                border-radius: 999px;
                padding: 4px 10px;
                font-size: 0.75rem;
                cursor: pointer;
                transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
            }
            button.chip:hover {
                border-color: var(--primary-color);
                color: var(--primary-text-color);
            }
            button.chip.active {
                background: var(--primary-color);
                color: var(--text-primary-color, #fff);
                border-color: var(--primary-color);
            }
        `;
    }

    private _toggle(label: string) {
        this.dispatchEvent(new CustomEvent("label-filter-toggle", {
            detail: { label },
            bubbles: true,
            composed: true,
        }));
    }

    render() {
        if (!this.labels || this.labels.length === 0) {
            return html``;
        }
        return html`
            <div class="bar">
                ${this.labels.map((label) => {
                    const isActive = this.active?.includes(label);
                    return html`<button class="chip ${isActive ? 'active' : ''}" @click=${() => this._toggle(label)}>${label}</button>`;
                })}
            </div>
        `;
    }
}
