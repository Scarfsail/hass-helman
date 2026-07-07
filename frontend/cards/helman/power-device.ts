import { LitElement, TemplateResult, css, html, nothing } from "lit-element";
import { keyed } from 'lit/directives/keyed.js';
import { styleMap } from 'lit/directives/style-map.js';
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import { DeviceNode } from "./DeviceNode";
import "./power-device";
import "./power-devices-container";
import "./power-device-history-bars";
import "./power-device-icon";
import "./power-device-power-display";
import "./power-device-info";

@customElement("power-device")
export class PowerDevice extends LitElement {
    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public device!: DeviceNode;
    @property({ type: Number }) public currentParentPower?: number;
    @property({ type: Number }) public historyBuckets!: number;
    @property({ type: Number }) public historyBucketDuration!: number;
    @property({ attribute: false }) public parentPowerHistory?: number[];
    @property({ type: Boolean }) public openNodeDetailOnIcon = false;

    @state() private _childrenCollapsed = true;



    firstUpdated() {
        this._childrenCollapsed = this.device.childrenCollapsed ?? true; // Default to true if not set
    }


    disconnectedCallback(): void {
        super.disconnectedCallback();

    }

    private _showMoreInfo(entityId: string) {
        const event = new CustomEvent("hass-more-info", {
            bubbles: true,
            composed: true,
            detail: { entityId },
        });
        this.dispatchEvent(event);
    }

    private _toggleChildren() {
        if (this.device.children.length > 0) {
            this._childrenCollapsed = !this._childrenCollapsed;
            this.device.childrenCollapsed = this._childrenCollapsed; // Update the device state to reflect the visibility
        }
    }

    static get styles() {
        return css`
            .border{
                box-shadow: 0 0px 12px var(--device-shadow-color, rgba(0,0,0,0.8));
                border-radius: var(--ha-card-border-radius, 12px);
                border-width: var(--ha-card-border-width, 1px);
                border-style: solid;
                border-color: var(--ha-card-border-color, var(--divider-color, #e0e0e0));
            }
            :host([is-expanded]) {
                flex-basis: 100%;
                width: 100%;
                height: 100%;
            }
            :host(:not([is-expanded])) {
                flex-basis: 0;
                flex-grow: 1;
                flex-shrink: 1;
            }
            .device {
                display: flex;
                align-items: center;
                flex-wrap: wrap;
                position: relative;
            }
            .deviceContent {
                background-color: #050505;
                display: flex;
                align-items: center;
                flex-basis: 100%;
                min-width: 0; /* Prevents text overflow issues */
                transition: box-shadow 0.2s ease-in-out, transform 0.2s ease-in-out, opacity 0.3s ease-in-out;
                position: relative;
                overflow: hidden; /* Prevents overflow if children are too wide */
            }
            :host([is-expanded]) .deviceContent {
                height: auto;
                border-bottom-left-radius: 0;
                border-bottom-right-radius: 0;
            }
            /* Increase specificity to override .border's border-radius when expanded */
            :host([is-expanded]) .border .deviceContent {
                border-bottom-left-radius: 0;
                border-bottom-right-radius: 0;
            }
            
            .deviceContent.is-off {
                opacity: 0.4;
            }

            .deviceContent:hover {
                box-shadow: 0 4px 14px var(--device-shadow-color, rgba(0,0,0,0.8));
                transform: scale(1.01);
            }
            .deviceName {
                flex-grow: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                margin-left: 0px;
                position: relative;
                z-index: 2;
                text-shadow: 0px 0px 4px rgba(0,0,0,1);
            }
            .deviceName.has-children {
                cursor: pointer;
            }
            .childrenContainer{
                width:100%;
                padding: 6px 6px 6px 6px; /* extra left indent for children */
                margin-top: 0px;
            }
            :host([is-expanded]) .childrenContainer {
                border-top: none; /* seamless merge with parent */
                border-top-left-radius: 0;
                border-top-right-radius: 0;
            }
            .deviceInfo {
                z-index: 2;
            }
        `;
    }

    private _renderChildren(children: DeviceNode[], currentPower: number, historyToRender: number[]): TemplateResult {
        const device = this.device;
        return html`
            <div class="border childrenContainer">
                <power-devices-container
                    .hass=${this.hass}
                    .devices=${children}
                    .currentParentPower=${currentPower}
                    .parentPowerHistory=${historyToRender}
                    .historyBuckets=${this.historyBuckets}
                    .historyBucketDuration=${this.historyBucketDuration}
                    .devices_full_width=${device.children_full_width}
                    .sortChildrenByPower=${device.sortChildrenByPower}
                ></power-devices-container>
            </div>
        `;
    }

    render() {
        const device = this.device;
        if (device.isUnmeasured && (device.powerValue == undefined || device.powerValue < 1)) {
            return nothing; // Do not render unmeasured devices with power < 1W
        }

        const isExpanded = !this._childrenCollapsed && device.children.length > 0;
        if (!this.device.hideChildren) {
            if (isExpanded) {
                this.setAttribute('is-expanded', '');
            } else {
                this.removeAttribute('is-expanded');
            }
        }

        const hasChildren = device.children.length > 0 && !device.hideChildrenIndicator;
        const indicator = hasChildren ? (this._childrenCollapsed ? '►' : '▼') : '';

        const currentPower = this.device.powerValue ?? 0;
        const isOff = currentPower === 0;

        const historyToRender = this.device.powerHistory;
        const maxHistoryPower = this.parentPowerHistory ? Math.max(...this.parentPowerHistory) : Math.max(...historyToRender);
        const childrenToRender = device.children;

        // Determine the color for history bars
        const historyBarColor = device.color ?? 'rgba(var(--rgb-accent-color), 0.13)';
        const deviceContent = html`
                <div class="border deviceContent ${isOff ? 'is-off' : ''}" style=${styleMap(this.device.color ? {'--device-shadow-color': this.device.color} : {})}>
                    <power-device-history-bars 
                        .device=${this.device}
                        .historyToRender=${[...historyToRender]}
                        .maxHistoryPower=${maxHistoryPower}
                        .historyBarColor=${historyBarColor}>
                    </power-device-history-bars>
                    <div class="deviceInfo" style="display: flex; flex-direction: column;flex-basis: 100%;">
                        <div style="display: flex; flex-direction: row;flex-basis: 100%;align-items: center; ">
                            <power-device-icon 
                                .hass=${this.hass} 
                                .device=${this.device}
                                .openNodeDetailOnClick=${this.openNodeDetailOnIcon}
                                @toggle-children=${this._toggleChildren}
                                @show-more-info=${(e: CustomEvent) => this._showMoreInfo(e.detail.entityId)}
                            ></power-device-icon>
                            <div class="deviceName ${hasChildren ? 'has-children' : ''}" @click=${this._toggleChildren}>${device.displayName || device.name} ${indicator}</div>
                            <power-device-power-display
                                .powerValue=${this.device.powerValue ?? 0}
                                .powerSensorId=${this.device.powerSensorId ?? undefined}
                                .compact=${this.device.compact ?? false}
                                .currentParentPower=${this.currentParentPower}
                                @show-more-info=${(e: CustomEvent) => this._showMoreInfo(e.detail.entityId)}
                            ></power-device-power-display>
                        </div>
                        <power-device-info
                            .device=${this.device} 
                            .hass=${this.hass}
                            @show-more-info=${(e: CustomEvent) => this._showMoreInfo(e.detail.entityId)}
                        ></power-device-info>

                    </div>
                </div>
                
        `
        return html`
            <div class="device">
                ${deviceContent}
                ${isExpanded && !this.device.hideChildren ? this._renderChildren(childrenToRender, currentPower, historyToRender) : nothing}
            </div>
        `;
    }
}
