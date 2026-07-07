import { LitElement, TemplateResult, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { sharedStyles } from "./shared-styles";
import { formatPower } from "../power-format";

@customElement("power-device-power-display")
export class PowerDevicePowerDisplay extends LitElement {
    @property({ type: Number }) public powerValue = 0;
    @property({ type: String }) public powerSensorId?: string;
    @property({ type: Boolean }) public compact = false;
    @property({ type: Number }) public currentParentPower?: number;

    private _showMoreInfo(entityId: string) {
        const event = new CustomEvent("show-more-info", {
            bubbles: true,
            composed: true,
            detail: { entityId },
        });
        this.dispatchEvent(event);
    }

    static get styles() {
        return [sharedStyles, css`
            .powerDisplay {
                margin-left: auto; /* Aligns to the right */
                padding-left: 8px; /* Adds space between name and power */
                padding-right: 8px; /* Adds space between power and right edge */
                position: relative;
                display: flex;
                flex-wrap: nowrap;
                justify-content: flex-end;
                align-items: center;
                z-index: 2;
                text-shadow: 0px 0px 4px rgba(0,0,0,1);
                gap: 6px;

            }
            .powerDisplay.has-sensor{
                cursor: pointer;
            }
            .powerValue {
                white-space: nowrap;
            }
            .powerPercentages{
                font-size: 0.7em;
                color: var(--secondary-text-color);                
            }
        `];
    }

    render(): TemplateResult {
        const currentPower = this.powerValue ?? 0;
        let parentPower = this.currentParentPower;

        if (!parentPower || parentPower === 0) {
            parentPower = currentPower; // If no parent power, use current power as reference
        }

        const currentPercentage = (parentPower > 0) ? (currentPower / parentPower) * 100 : 0;
        const percentageDisplay = html`<span class=powerPercentages>${Math.round(currentPercentage).toFixed(0)}%</span>`;

        const onPowerClick = this.powerSensorId
            ? () => this._showMoreInfo(this.powerSensorId!)
            : () => { }; // No-op if no sensor

        const { value: powerValue, unit: powerUnit } = formatPower(currentPower);

        return html`<div class="powerDisplay ${this.powerSensorId ? 'has-sensor' : ''}" @click=${onPowerClick}>
                        <div class="powerValue">${powerValue} <span class="units">${powerUnit}</span></div>
                        <div>${percentageDisplay}</div>
                    </div>`;
    }
}
