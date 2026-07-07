import { LitElement, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../../hass-frontend/src/types";
import type { LocalizeFunction } from "../../localize/localize";
import type { HouseDetailParams } from "./node-detail-types";
import { nodeDetailSharedStyles } from "./node-detail-shared-styles";
import "../../helman/power-device";
import "../../helman/power-house-devices-section";
import "./node-detail-forecast-section";

@customElement("node-detail-house-content")
export class NodeDetailHouseContent extends LitElement {

    static styles = [nodeDetailSharedStyles];

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public params!: HouseDetailParams;

    render() {
        const p = this.params;

        return html`
            <div class="content">
                ${p.houseNode ? html`
                    <div class="power-device-wrapper">
                        <power-device
                            .hass=${this.hass}
                            .device=${p.houseNode}
                            .currentParentPower=${p.consumptionNode?.powerValue}
                            .parentPowerHistory=${p.consumptionNode?.powerHistory}
                            .historyBuckets=${p.historyBuckets}
                            .historyBucketDuration=${p.historyBucketDuration}
                        ></power-device>
                    </div>
                ` : nothing}
                ${p.devices.length > 0 ? html`
                    <power-house-devices-section
                        .hass=${this.hass}
                        .devices=${p.devices}
                        .historyBuckets=${p.historyBuckets}
                        .historyBucketDuration=${p.historyBucketDuration}
                        .currentParentPower=${p.power}
                        .parentPowerHistory=${p.parentPowerHistory}
                        .devices_full_width=${true}
                        .sortChildrenByPower=${true}
                        .initial_show_only_top_children=${5}
                        .uiConfig=${p.uiConfig}
                    ></power-house-devices-section>
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
