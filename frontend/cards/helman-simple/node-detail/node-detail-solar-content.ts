import { LitElement, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../../hass-frontend/src/types";
import type { SolarDetailParams } from "./node-detail-types";
import { nodeDetailSharedStyles } from "./node-detail-shared-styles";
import "../../helman/power-device";

@customElement("node-detail-solar-content")
export class NodeDetailSolarContent extends LitElement {

    static styles = [nodeDetailSharedStyles];

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public params!: SolarDetailParams;

    render() {
        const p = this.params;

        return html`
            <div class="content">
                ${p.solarNode ? html`
                    <div class="power-device-wrapper">
                        <power-device
                            .hass=${this.hass}
                            .device=${p.solarNode}
                            .currentParentPower=${p.productionNode?.powerValue}
                            .parentPowerHistory=${p.productionNode?.powerHistory}
                            .historyBuckets=${p.historyBuckets}
                            .historyBucketDuration=${p.historyBucketDuration}
                        ></power-device>
                    </div>
                ` : nothing}
            </div>
        `;
    }
}
