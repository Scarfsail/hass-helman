import { LitElement, TemplateResult, css, html, nothing } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import { DeviceNode } from "./DeviceNode";
import { BatteryDeviceConfig } from "./DeviceConfig";
import { sharedStyles } from "./shared-styles";
import { computeDominantSourceColorCached } from "../color-utils";
import type { NodeType } from "../node-detail/node-detail-types";
import "../helman-simple/simple-card-solar";
import "../helman-simple/simple-card-battery";
import "../helman-simple/simple-card-grid";
import "../helman-simple/simple-card-house";

@customElement("power-device-icon")
export class PowerDeviceIcon extends LitElement {
    // Static styles
    static get styles() {
        return [sharedStyles, css`
            .switchIconPlaceholder {
                width: 40px;
                height: 40px;
                flex-shrink: 0;
                display:flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                color: var(--secondary-text-color);
                font-size:0.7em;
            }
            .disabled-icon {
                color: var(--disabled-text-color);
            }
            state-badge {
                cursor: pointer;
                flex-shrink: 0;
                position: relative;
                z-index: 2;
            }
            .node-icon {
                flex-shrink: 0;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
            }
        `];
    }

    // Public properties
    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public device!: DeviceNode;
    @property({ type: Boolean }) public openNodeDetailOnClick = false;

    // Render method
    render(): TemplateResult | typeof nothing {
        const device = this.device;
        if (device.switchEntityId) {
            return html`
                <state-badge
                    .hass=${this.hass}
                    .stateObj=${this.hass!.states[device.switchEntityId]}
                    .stateColor=${true}
                    @click=${() => this._fireShowMoreInfo(device.switchEntityId!)}
                ></state-badge>
            `;
        }

        // Check for the 4 known animated node types
        const animated = this._renderAnimatedNode();
        if (animated !== nothing) return animated;

        if (device.icon) {
            return this._renderDeviceIcon();
        }
        return html`<div class="switchIconPlaceholder"><ha-icon class="disabled-icon" icon="mdi:border-none-variant"></ha-icon></div>`;
    }

    // Private helpers
    private _fireToggleChildren() {
        this.dispatchEvent(new CustomEvent('toggle-children', { bubbles: true, composed: true }));
    }

    private _fireShowMoreInfo(entityId: string) {
        this.dispatchEvent(new CustomEvent('show-more-info', {
            bubbles: true,
            composed: true,
            detail: { entityId }
        }));
    }

    private _fireShowNodeDetail(nodeType: NodeType) {
        this.dispatchEvent(new CustomEvent("show-node-detail", {
            bubbles: true,
            composed: true,
            detail: { nodeType },
        }));
    }

    private _renderAnimatedNode(): TemplateResult | typeof nothing {
        const device = this.device;
        const power = device.powerValue ?? 0;

        if (device.sourceType === 'solar') {
            const clickHandler = this.openNodeDetailOnClick
                ? () => this._fireShowNodeDetail("solar")
                : this._fireToggleChildren;
            return html`
                <div class="node-icon" @click=${clickHandler}>
                    <simple-card-solar
                        .power=${power}
                        ?compact=${true}
                    ></simple-card-solar>
                </div>
            `;
        }

        if (device.sourceType === 'grid') {
            // isSource=true → importing (positive); isSource=false → exporting (negative)
            const signedPower = device.isSource ? power : -power;
            const sourceColor = device.isSource ? undefined : computeDominantSourceColorCached(this.device);
            const clickHandler = this.openNodeDetailOnClick
                ? () => this._fireShowNodeDetail("grid")
                : this._fireToggleChildren;
            return html`
                <div class="node-icon" @click=${clickHandler}>
                    <simple-card-grid
                        .power=${signedPower}
                        .sourceColor=${sourceColor}
                        ?compact=${true}
                    ></simple-card-grid>
                </div>
            `;
        }

        if (device.sourceType === 'battery') {
            // isSource=true → discharging (negative in simple-card convention); isSource=false → charging (positive)
            const signedPower = device.isSource ? -power : power;
            const sourceColor = device.isSource ? undefined : computeDominantSourceColorCached(this.device);
            const battConfig = device.deviceConfig as BatteryDeviceConfig;
            const soc = battConfig?.entities?.capacity
                ? parseFloat(this.hass.states[battConfig.entities.capacity]?.state ?? '0') || 0
                : 0;
            const minSoc = battConfig?.entities?.min_soc
                ? parseFloat(this.hass.states[battConfig.entities.min_soc]?.state ?? '10') || 10
                : 10;
            const clickHandler = this.openNodeDetailOnClick
                ? () => this._fireShowNodeDetail("battery")
                : battConfig?.entities?.capacity
                ? () => this._fireShowMoreInfo(battConfig.entities.capacity!)
                : this._fireToggleChildren;
            return html`
                <div class="node-icon" @click=${clickHandler}>
                    <simple-card-battery
                        .power=${signedPower}
                        .soc=${soc}
                        .minSoc=${minSoc}
                        .sourceColor=${sourceColor}
                        ?compact=${true}
                    ></simple-card-battery>
                </div>
            `;
        }

        if (device.sourceType === 'house') {
            const sourceColor = computeDominantSourceColorCached(this.device);
            const clickHandler = this.openNodeDetailOnClick
                ? () => this._fireShowNodeDetail("house")
                : this._fireToggleChildren;
            return html`
                <div class="node-icon" @click=${clickHandler}>
                    <simple-card-house
                        .power=${power}
                        .sourceColor=${sourceColor}
                        ?compact=${true}
                    ></simple-card-house>
                </div>
            `;
        }

        return nothing;
    }

    private _renderDeviceIcon(): TemplateResult {
        return html`
            <div class="switchIconPlaceholder" @click=${this._fireToggleChildren}>
                <ha-icon .icon=${this.device.icon}></ha-icon>
            </div>
        `;
    }
}
