import { LitElement, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../../hass-frontend/src/types";
import type { LocalizeFunction } from "../../localize/localize";
import type { GridDetailParams } from "./node-detail-types";
import { nodeDetailSharedStyles } from "./node-detail-shared-styles";
import "../../helman/power-device";
import "./node-detail-forecast-section";

@customElement("node-detail-grid-content")
export class NodeDetailGridContent extends LitElement {

    static styles = [nodeDetailSharedStyles];

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public params!: GridDetailParams;

    render() {
        const p = this.params;

        return html`
            <div class="content">
                ${p.gridProducerNode || p.gridConsumerNode ? html`
                    <div class="power-devices-dual">
                        ${p.gridConsumerNode ? html`
                            <div class="power-device-section">
                                <div class="section-title">${this.localize("node_detail.grid.section_consumer")}</div>
                                <power-device
                                    .hass=${this.hass}
                                    .device=${p.gridConsumerNode}
                                    .currentParentPower=${p.consumptionNode?.powerValue}
                                    .parentPowerHistory=${p.consumptionNode?.powerHistory}
                                    .historyBuckets=${p.historyBuckets}
                                    .historyBucketDuration=${p.historyBucketDuration}
                                ></power-device>
                            </div>
                        ` : nothing}
                        ${p.gridProducerNode ? html`
                            <div class="power-device-section">
                                <div class="section-title">${this.localize("node_detail.grid.section_producer")}</div>
                                <power-device
                                    .hass=${this.hass}
                                    .device=${p.gridProducerNode}
                                    .currentParentPower=${p.productionNode?.powerValue}
                                    .parentPowerHistory=${p.productionNode?.powerHistory}
                                    .historyBuckets=${p.historyBuckets}
                                    .historyBucketDuration=${p.historyBucketDuration}
                                ></power-device>
                            </div>
                        ` : nothing}
                    </div>
                ` : nothing}
                <node-detail-forecast-section
                    .hass=${this.hass}
                    .localize=${this.localize}
                    .nodeType=${p.nodeType}
                ></node-detail-forecast-section>
            </div>
        `;
    }
}
