import { LitElement, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../../hass-frontend/src/types";
import type { LocalizeFunction } from "../../localize/localize";
import type { GridDetailParams } from "./node-detail-types";
import { nodeDetailSharedStyles } from "./node-detail-shared-styles";
import "../../helman/tree-item-row";

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
                    <div class="tree-items-dual">
                        ${p.gridConsumerNode ? html`
                            <div class="tree-item-section">
                                <div class="section-title">${this.localize("node_detail.grid.section_consumer")}</div>
                                <helman-tree-item
                                    .hass=${this.hass}
                                    .device=${p.gridConsumerNode}
                                    .currentParentPower=${p.consumptionNode?.powerValue}
                                    .parentPowerHistory=${p.consumptionNode?.powerHistory}
                                    .historyBuckets=${p.historyBuckets}
                                    .historyBucketDuration=${p.historyBucketDuration}
                                    .historyRevision=${p.historyRevision}
                                ></helman-tree-item>
                            </div>
                        ` : nothing}
                        ${p.gridProducerNode ? html`
                            <div class="tree-item-section">
                                <div class="section-title">${this.localize("node_detail.grid.section_producer")}</div>
                                <helman-tree-item
                                    .hass=${this.hass}
                                    .device=${p.gridProducerNode}
                                    .currentParentPower=${p.productionNode?.powerValue}
                                    .parentPowerHistory=${p.productionNode?.powerHistory}
                                    .historyBuckets=${p.historyBuckets}
                                    .historyBucketDuration=${p.historyBucketDuration}
                                    .historyRevision=${p.historyRevision}
                                ></helman-tree-item>
                            </div>
                        ` : nothing}
                    </div>
                ` : nothing}
            </div>
        `;
    }
}
