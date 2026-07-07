import { LitElement, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { DeviceNode } from "./DeviceNode";
import { nothing } from "lit-html";

const STRIPS = html`
    ${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(i => html`<div class="strip" style="--index: ${i}"></div>`)}
`;

@customElement("power-flow-arrows")
export class PowerFlowArrows extends LitElement {
    @property({ type: Array }) devices: (DeviceNode | undefined)[] = [];
    @property({ type: Number }) maxPower?: number; // Default max power for 3-phase system and 25A per phase

    static get styles() {
        return css`
            .container {
                display: flex;
                flex-direction: row;
                gap: 5px;
                justify-content: space-evenly;
            }
            .item-container {
                flex: 1;
                min-width: 0;
                text-align: center;
            }
            .animated-arrow {
                position: relative;
                width: 100%;
                height: 22px;
                margin: 0 auto;
                border-radius: 0px;
                overflow: hidden;
            }
            .strip {
                position: absolute;
                left: 0;
                right: 0;
                height: 10%;
                background-color: transparent;
                animation: flow 1.0s linear infinite;
                top: calc(var(--index) * 10%);
                animation-delay: calc(var(--index) * 0.15s);
                transform: translateY(-10px);
            }

            @keyframes flow {
                0% {
                    background-color: rgba(192, 192, 192, 0.2);
                    box-shadow: none;
                    opacity: 0;
                    transform: translateY(-10px);
                }
                50% {
                    background-color: rgba(220, 220, 220, 1);
                    box-shadow: 0 0 5px rgba(220, 220, 220, 0.8);
                    opacity: 1;
                }
                100% {
                    background-color: rgba(192, 192, 192, 0.2);
                    box-shadow: none;
                    opacity: 0;
                    transform: translateY(10px);
                }
            }
        `;
    }

    render() {
        if (!this.devices || this.devices.length === 0) {
            return nothing;
        }
        const maxPower = this.maxPower || (25 * 230 * 3); // Default to 3-phase system with 25A per phase
        return html`
            <div class="container">
                ${this.devices.map((device) => {
                    if (!device?.powerValue || device.powerValue <= 0.4) {
                        return html`<div class="item-container"></div>`;
                    }
                    const widthPercentage = Math.min((device.powerValue / maxPower) * 100, 100);
                    return html`
                        <div class="item-container">
                            <div class="animated-arrow" style="width: ${widthPercentage}%">
                                ${STRIPS}
                            </div>
                        </div>
                    `;
                })}
            </div>
        `;
    }
}
