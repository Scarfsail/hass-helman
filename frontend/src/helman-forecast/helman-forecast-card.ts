import { LitElement, css, html } from "lit-element";
import { customElement, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import type { LovelaceCard } from "../../hass-frontend/src/panels/lovelace/types";
import {
    type HelmanForecastCardConfig,
} from "./HelmanForecastCardConfig";
import {
    getUnifiedForecastOverviewConfig,
    normalizeUnifiedForecastOverviewConfig,
    type UnifiedForecastOverviewConfig,
} from "./unified-forecast-visibility";
import "./helman-unified-forecast-detail";

@customElement("helman-forecast-card")
export class HelmanForecastCard extends LitElement implements LovelaceCard {
    // 1. Static HA configuration methods
    public static async getStubConfig(_hass: HomeAssistant): Promise<Partial<HelmanForecastCardConfig>> {
        return { type: "custom:helman-forecast-card" };
    }

    public static getConfigForm() {
        return {
            schema: [
                {
                    name: "transparent_background",
                    selector: { boolean: {} },
                },
                {
                    name: "mobile_density",
                    selector: {
                        select: {
                            mode: "dropdown",
                            options: ["comfortable", "compact"],
                        },
                    },
                },
                {
                    name: "show_solar_gauge",
                    selector: { boolean: {} },
                },
                {
                    name: "show_solar_chart",
                    selector: { boolean: {} },
                },
                {
                    name: "show_grid_gauge",
                    selector: { boolean: {} },
                },
                {
                    name: "show_battery_gauge",
                    selector: { boolean: {} },
                },
                {
                    name: "show_battery_chart",
                    selector: { boolean: {} },
                },
                {
                    name: "show_consumption_gauge",
                    selector: { boolean: {} },
                },
                {
                    name: "show_consumption_chart",
                    selector: { boolean: {} },
                },
                {
                    name: "show_price_chart",
                    selector: { boolean: {} },
                },
            ],
        };
    }

    // 2. Static styles
    static styles = css`
        :host { display: block; }
        ha-card { overflow: hidden; }
        ha-card.transparent {
            background: transparent;
            box-shadow: none;
            border: none;
        }
        .card-content {
            padding: 12px;
        }
    `;

    // 3. Private properties
    private _config!: HelmanForecastCardConfig;

    // 5. State properties
    @state() private _hass?: HomeAssistant;

    // 7. HA-specific property setter
    public set hass(value: HomeAssistant) {
        this._hass = value;
    }

    // 8. HA-specific methods
    getCardSize() { return 4; }

    setConfig(config: HelmanForecastCardConfig) {
        const defaultOverviewConfig = getUnifiedForecastOverviewConfig("forecastCard");
        this._config = {
            transparent_background: false,
            mobile_density: "comfortable",
            show_solar_gauge: defaultOverviewConfig.solarGauge,
            show_solar_chart: defaultOverviewConfig.solarChart,
            show_grid_gauge: defaultOverviewConfig.gridGauge,
            show_battery_gauge: defaultOverviewConfig.batteryGauge,
            show_battery_chart: defaultOverviewConfig.batteryChart,
            show_consumption_gauge: defaultOverviewConfig.consumptionGauge,
            show_consumption_chart: defaultOverviewConfig.consumptionChart,
            show_price_chart: defaultOverviewConfig.priceChart,
            ...config,
        };
    }

    // 10. Render method
    render() {
        if (!this._hass) {
            return html`
                <ha-card class=${this._config?.transparent_background ? "transparent" : ""}></ha-card>
            `;
        }

        return html`
            <ha-card class=${this._config?.transparent_background ? "transparent" : ""}>
                <div class="card-content">
                    <helman-unified-forecast-detail
                        .hass=${this._hass}
                        .overviewConfig=${this._getOverviewConfig()}
                        .mobileDensity=${this._config.mobile_density ?? "comfortable"}
                    ></helman-unified-forecast-detail>
                </div>
            </ha-card>
        `;
    }

    // Private helper methods
    private _getOverviewConfig(): UnifiedForecastOverviewConfig {
        return normalizeUnifiedForecastOverviewConfig({
            solarGauge: this._config.show_solar_gauge !== false,
            solarChart: this._config.show_solar_chart !== false,
            gridGauge: this._config.show_grid_gauge !== false,
            batteryGauge: this._config.show_battery_gauge === true,
            batteryChart: this._config.show_battery_chart !== false,
            consumptionGauge: this._config.show_consumption_gauge === true,
            consumptionChart: this._config.show_consumption_chart === true,
            priceChart: this._config.show_price_chart !== false,
        });
    }
}

// Card registration
(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
    type: "helman-forecast-card",
    name: "Helman Forecast Card",
    description: "Unified solar, grid, battery, house, and price forecast visualization.",
    preview: true,
});
