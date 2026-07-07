import { LitElement, css, html } from "lit-element";
import { customElement, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import type { LovelaceCard } from "../../hass-frontend/src/panels/lovelace/types";
import type { HelmanSolarInspectorCardConfig } from "./HelmanSolarInspectorCardConfig";
import "./helman-solar-inspector";

@customElement("helman-solar-inspector-card")
export class HelmanSolarInspectorCard extends LitElement implements LovelaceCard {
    public static async getStubConfig(_hass: HomeAssistant): Promise<Partial<HelmanSolarInspectorCardConfig>> {
        return { type: "custom:helman-solar-inspector-card" };
    }

    public static getConfigForm() {
        return {
            schema: [
                {
                    name: "transparent_background",
                    selector: { boolean: {} },
                },
            ],
        };
    }

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

    private _config!: HelmanSolarInspectorCardConfig;

    @state() private _hass?: HomeAssistant;

    public set hass(value: HomeAssistant) {
        this._hass = value;
    }

    getCardSize() {
        return 4;
    }

    setConfig(config: HelmanSolarInspectorCardConfig) {
        this._config = {
            transparent_background: false,
            ...config,
        };
    }

    render() {
        if (!this._hass) {
            return html`
                <ha-card class=${this._config?.transparent_background ? "transparent" : ""}></ha-card>
            `;
        }

        return html`
            <ha-card class=${this._config?.transparent_background ? "transparent" : ""}>
                <div class="card-content">
                    <helman-solar-inspector .hass=${this._hass}></helman-solar-inspector>
                </div>
            </ha-card>
        `;
    }
}

(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
    type: "helman-solar-inspector-card",
    name: "Helman Solar Inspector Card",
    description: "Solar forecast bias correction inspector.",
    preview: true,
});
