import { LitElement, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../../hass-frontend/src/types";
import type { HouseDetailParams } from "./node-detail-types";
import { nodeDetailSharedStyles } from "./node-detail-shared-styles";
import "../../helman/tree-item-row";
import "../../helman/house-devices-section";

@customElement("node-detail-house-content")
export class NodeDetailHouseContent extends LitElement {

    static styles = [nodeDetailSharedStyles];

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public params!: HouseDetailParams;

    render() {
        const p = this.params;

        return html`
            <div class="content">
                ${p.houseNode ? html`
                    <div class="tree-item-wrapper">
                        <helman-tree-item
                            .hass=${this.hass}
                            .device=${p.houseNode}
                            .currentParentPower=${p.consumptionNode?.powerValue}
                            .parentPowerHistory=${p.consumptionNode?.powerHistory}
                            .historyBuckets=${p.historyBuckets}
                            .historyBucketDuration=${p.historyBucketDuration}
                            .historyRevision=${p.historyRevision}
                        ></helman-tree-item>
                    </div>
                ` : nothing}
                ${p.devices.length > 0 ? html`
                    <helman-house-devices-section
                        .hass=${this.hass}
                        .devices=${p.devices}
                        .historyBuckets=${p.historyBuckets}
                        .historyBucketDuration=${p.historyBucketDuration}
                        .historyRevision=${p.historyRevision}
                        .currentParentPower=${p.power}
                        .parentPowerHistory=${p.parentPowerHistory}
                        .devices_full_width=${true}
                        .sortChildrenByPower=${true}
                        .initial_show_only_top_children=${5}
                        .uiConfig=${p.uiConfig}
                    ></helman-house-devices-section>
                ` : nothing}
            </div>
        `;
    }
}
