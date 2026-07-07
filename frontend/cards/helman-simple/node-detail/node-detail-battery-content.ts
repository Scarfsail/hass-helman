import { LitElement, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../../hass-frontend/src/types";
import type { LocalizeFunction } from "../../localize/localize";
import { getDisplayEnergyUnit } from "../../helman/energy-unit-converter";
import type { BatteryDetailParams } from "./node-detail-types";
import { nodeDetailSharedStyles } from "./node-detail-shared-styles";
import { readKWh } from "./node-detail-utils";
import "../../helman/power-device";
import "./node-detail-forecast-section";

const batteryDetailStyles = css`
    .battery-summary {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 12px;
        border: 1px solid var(--divider-color);
        border-radius: 12px;
        background: var(--secondary-background-color);
    }

    .battery-summary-primary {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 4px;
        padding: 0;
        border: none;
        background: none;
        color: inherit;
        font: inherit;
        text-align: left;
    }

    .battery-summary-primary.clickable {
        cursor: pointer;
    }

    .battery-summary-primary.clickable:hover {
        opacity: 0.92;
    }

    .battery-summary-primary.clickable:focus-visible {
        outline: 2px solid var(--primary-color);
        outline-offset: 2px;
        border-radius: 8px;
    }

    .battery-summary-label {
        color: var(--secondary-text-color);
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    .battery-summary-value {
        font-size: 1.75rem;
        font-weight: 700;
        line-height: 1;
    }

    .battery-summary-unit {
        margin-inline-start: 0.2rem;
        color: var(--secondary-text-color);
        font-size: 0.95rem;
        font-weight: 600;
    }

    .battery-summary-secondary {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
`;

@customElement("node-detail-battery-content")
export class NodeDetailBatteryContent extends LitElement {

    static styles = [nodeDetailSharedStyles, batteryDetailStyles];

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public params!: BatteryDetailParams;

    render() {
        const p = this.params;
        const mode = p.power > 50 ? "charging" : p.power < -50 ? "discharging" : "idle";
        const remainingKwh = readKWh(this.hass, p.remainingEnergyEntityId);
        const remainingDisplay = remainingKwh !== null ? getDisplayEnergyUnit(remainingKwh) : null;
        const socDisplay = p.socEntityId !== null && Number.isFinite(p.soc)
            ? Math.max(0, Math.min(100, p.soc))
            : null;

        return html`
            <div class="content">
                ${p.batteryProducerNode || p.batteryConsumerNode ? html`
                    <div class="power-devices-dual">
                        ${p.batteryProducerNode ? html`
                            <div class="power-device-section">
                                <div class="section-title">${this.localize("node_detail.battery.section_producer")}</div>
                                <power-device
                                    .hass=${this.hass}
                                    .device=${p.batteryProducerNode}
                                    .currentParentPower=${p.productionNode?.powerValue}
                                    .parentPowerHistory=${p.productionNode?.powerHistory}
                                    .historyBuckets=${p.historyBuckets}
                                    .historyBucketDuration=${p.historyBucketDuration}
                                ></power-device>
                            </div>
                        ` : nothing}
                        ${p.batteryConsumerNode ? html`
                            <div class="power-device-section">
                                <div class="section-title">${this.localize("node_detail.battery.section_consumer")}</div>
                                <power-device
                                    .hass=${this.hass}
                                    .device=${p.batteryConsumerNode}
                                    .currentParentPower=${p.consumptionNode?.powerValue}
                                    .parentPowerHistory=${p.consumptionNode?.powerHistory}
                                    .historyBuckets=${p.historyBuckets}
                                    .historyBucketDuration=${p.historyBucketDuration}
                                ></power-device>
                            </div>
                        ` : nothing}
                    </div>
                ` : nothing}
                <div class="battery-summary">
                    ${socDisplay !== null ? this._renderSocSummary(socDisplay, p.socEntityId) : nothing}
                    <div class="battery-summary-secondary">
                        ${remainingDisplay ? html`
                            <div class="detail-row clickable" @click=${() => this._showMoreInfo(p.remainingEnergyEntityId)}>
                                <span class="label">${this.localize("node_detail.battery.remaining_energy")}</span>
                                <span class="value">${remainingDisplay.value.toFixed(1)} ${remainingDisplay.unit}</span>
                            </div>
                        ` : nothing}
                        <div class="detail-row">
                            <span class="label">${this.localize("node_detail.battery.mode")}</span>
                            <span class="value">${this.localize(`node_detail.battery.mode_${mode}`)}</span>
                        </div>
                    </div>
                </div>
                <node-detail-forecast-section
                    .hass=${this.hass}
                    .localize=${this.localize}
                    .nodeType=${p.nodeType}
                ></node-detail-forecast-section>
            </div>
        `;
    }

    private _renderSocSummary(socDisplay: number, entityId: string | null) {
        const content = html`
            <span class="battery-summary-label">${this.localize("node_detail.battery.soc")}</span>
            <span class="battery-summary-value">
                ${socDisplay.toFixed(0)}<span class="battery-summary-unit">%</span>
            </span>
        `;

        if (!entityId) {
            return html`<div class="battery-summary-primary">${content}</div>`;
        }

        return html`
            <button
                type="button"
                class="battery-summary-primary clickable"
                @click=${() => this._showMoreInfo(entityId)}
            >
                ${content}
            </button>
        `;
    }

    private _showMoreInfo(entityId: string | null) {
        if (!entityId) return;

        this.dispatchEvent(new CustomEvent("hass-more-info", {
            bubbles: true,
            composed: true,
            detail: { entityId },
        }));
    }
}
