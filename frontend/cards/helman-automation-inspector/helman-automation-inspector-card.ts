import { LitElement, css, html } from "lit-element";
import { customElement, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import type { LovelaceCard } from "../../hass-frontend/src/panels/lovelace/types";
import type { HelmanAutomationInspectorCardConfig } from "./HelmanAutomationInspectorCardConfig";
import { helmanColorVars } from "../color-utils";
import "./helman-automation-inspector";

@customElement("helman-automation-inspector-card")
export class HelmanAutomationInspectorCard extends LitElement implements LovelaceCard {
    public static async getStubConfig(
        _hass: HomeAssistant,
    ): Promise<Partial<HelmanAutomationInspectorCardConfig>> {
        return { type: "custom:helman-automation-inspector-card" };
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

    static styles = [helmanColorVars, css`
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
    `];

    private _config!: HelmanAutomationInspectorCardConfig;

    @state() private _hass?: HomeAssistant;

    public set hass(value: HomeAssistant) {
        this._hass = value;
    }

    getCardSize() {
        return 6;
    }

    setConfig(config: HelmanAutomationInspectorCardConfig) {
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
                    <helman-automation-inspector .hass=${this._hass}></helman-automation-inspector>
                </div>
            </ha-card>
        `;
    }
}

(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
    type: "helman-automation-inspector-card",
    name: "Helman Automation Inspector Card",
    description: "Optimizer decision matrix — what each optimizer saw, did, and why.",
    preview: true,
});
