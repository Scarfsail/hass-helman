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
                {
                    name: "daylight_threshold_w",
                    selector: { number: { min: 0, step: 10, mode: "box", unit_of_measurement: "W" } },
                },
                {
                    name: "daylight_only_default",
                    selector: { boolean: {} },
                },
                {
                    name: "slot_minutes",
                    selector: {
                        select: {
                            mode: "dropdown",
                            options: [
                                { value: "15", label: "15" },
                                { value: "30", label: "30" },
                                { value: "60", label: "60" },
                            ],
                        },
                    },
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
            daylight_threshold_w: 100,
            daylight_only_default: true,
            slot_minutes: 30,
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
                    <helman-solar-inspector
                        .hass=${this._hass}
                        .daylightThresholdW=${this._config?.daylight_threshold_w ?? 100}
                        .daylightOnlyDefault=${this._config?.daylight_only_default ?? true}
                        .slotMinutesDefault=${Number(this._config?.slot_minutes ?? 30)}
                    ></helman-solar-inspector>
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
