import { LitElement, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../../hass-frontend/src/types";
import type { LocalizeFunction } from "../../localize/localize";
import {
    getUnifiedForecastOverviewConfig,
    type UnifiedForecastOverviewConfig,
    type UnifiedForecastOverviewPreset,
} from "../../helman-forecast/unified-forecast-visibility";
import { nodeDetailSharedStyles } from "./node-detail-shared-styles";
import type { NodeType } from "./node-detail-types";
import "../../helman-forecast/helman-unified-forecast-detail";

const OVERVIEW_PRESET_BY_NODE_TYPE: Record<NodeType, UnifiedForecastOverviewPreset> = {
    battery: "battery",
    house: "house",
    solar: "solar",
    grid: "grid",
};

@customElement("node-detail-forecast-section")
export class NodeDetailForecastSection extends LitElement {
    static styles = [nodeDetailSharedStyles];

    @property({ attribute: false }) public hass?: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ type: String }) public nodeType!: NodeType;

    render() {
        if (!this.hass || !this.localize || !this.nodeType) {
            return nothing;
        }

        return html`
            <div class="forecast-section">
                <div class="section-title">${this._getSectionTitle()}</div>
                <helman-unified-forecast-detail
                    .hass=${this.hass}
                    .overviewConfig=${this._getOverviewConfig()}
                    .mobileDensity=${"comfortable"}
                    .showSectionTitle=${false}
                ></helman-unified-forecast-detail>
            </div>
        `;
    }

    private _getOverviewConfig(): UnifiedForecastOverviewConfig {
        return getUnifiedForecastOverviewConfig(OVERVIEW_PRESET_BY_NODE_TYPE[this.nodeType]);
    }

    private _getSectionTitle(): string {
        switch (this.nodeType) {
        case "solar":
            return this.localize("node_detail.solar.forecast_section");
        case "grid":
            return this.localize("node_detail.grid.forecast_section");
        case "battery":
            return this.localize("node_detail.battery_forecast.title");
        case "house":
            return this.localize("node_detail.house_forecast.title");
        }
    }
}
