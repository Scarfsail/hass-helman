import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import type { LovelaceCard } from "../../hass-frontend/src/panels/lovelace/types";
import type { LovelaceCardConfig } from "../../hass-frontend/src/data/lovelace/config/card";
import { hassContextChanged } from "../shared/hass-change";
import "./device-report-shell";

export interface HelmanDeviceReportsCardConfig extends LovelaceCardConfig {
    /** When true, the card background is transparent. Default: false. */
    transparent_background?: boolean;
}

/**
 * Device reports: how the house's devices used energy over a period, where it
 * came from and what it cost.
 *
 * Reads no entity states -- every figure comes from `helman/device_report` --
 * so a new `hass` is passed down only when its context changes. See
 * `frontend/cards/README.md`, "Card rendering discipline".
 */
@customElement("helman-device-reports-card")
export class HelmanDeviceReportsCard extends LitElement implements LovelaceCard {
    public static async getStubConfig(_hass: HomeAssistant): Promise<Partial<HelmanDeviceReportsCardConfig>> {
        return { type: "custom:helman-device-reports-card" };
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

    private _config?: HelmanDeviceReportsCardConfig;

    @state() private _hass?: HomeAssistant;

    /** The last `hass` handed to the card, accepted or not. */
    private _latestHass?: HomeAssistant;

    public set hass(value: HomeAssistant) {
        const previous = this._latestHass;
        this._latestHass = value;
        if (hassContextChanged(previous, value)) {
            this._hass = value;
        }
    }

    getCardSize() {
        return 6;
    }

    setConfig(config: HelmanDeviceReportsCardConfig) {
        this._config = { transparent_background: false, ...config };
    }

    render() {
        const cls = this._config?.transparent_background ? "transparent" : "";
        if (!this._hass) {
            return html`<ha-card class=${cls}></ha-card>`;
        }
        return html`
            <ha-card class=${cls}>
                <div class="card-content">
                    <helman-device-report-shell .hass=${this._hass}></helman-device-report-shell>
                </div>
            </ha-card>
        `;
    }
}

(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
    type: "helman-device-reports-card",
    name: "Helman Device Reports Card",
    description: "Per-device energy, its sources and its cost over a period.",
    preview: true,
});
