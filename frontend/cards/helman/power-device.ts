import { LitElement, TemplateResult, css, html, nothing } from "lit-element";
import { keyed } from 'lit/directives/keyed.js';
import { styleMap } from 'lit/directives/style-map.js';
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import { DEFERRABLE_HOUSE_COLOR, nodeAccentColor, withAlpha } from "../color-utils";
import { DeviceNode, isNodeVisible } from "./DeviceNode";
import "./power-device";
import "./power-devices-container";
import "../shared/power-history-bars";
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
                /* The node color washed over the near-black surface, so a box
                   reads as solar/battery/grid/house at a glance. --device-tint
                   is already translucent (see nodeAccentColor), and color-mix
                   knocks it back further to keep the text legible. */
                background-color: color-mix(in srgb, var(--device-tint, transparent) 35%, #050505);
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
        if (!isNodeVisible(device)) {
            return nothing; // Containers filter these out too; this is the last guard.
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

        // Handed to the bars below as a copy (`[...historyToRender]`), and that copy
        // is load-bearing rather than paranoia: `HistoryEngine._advanceTree` mutates
        // `powerHistory` in place (push / shift / index assignment), and
        // `helman-power-history-bars.willUpdate` early-returns unless one of its four
        // properties is in `changedProperties`. Passed by reference the array's
        // identity would never change and the bars would freeze permanently — the
        // copy is the only change signal that reaches them. Its sibling
        // `.sourceHistory` is passed by reference precisely because it rides on this
        // one. See `frontend/cards/README.md`, "Card rendering discipline".
        const historyToRender = this.device.powerHistory;
        const maxHistoryPower = this.parentPowerHistory ? Math.max(...this.parentPowerHistory) : Math.max(...historyToRender);
        const childrenToRender = device.children;

        // Only the typed top-level nodes carry a domain color of their own.
        // Untyped nodes (house children, unmeasured, virtual groups) get no glow
        // and keep the accent bars, but leaving --device-tint unset lets them
        // inherit their section's tint — that's how the house breakdown picks up
        // the house color.
        const nodeColor = device.sourceType ? nodeAccentColor(device.sourceType) : undefined;
        // A shiftable consumer is still a house child, so it earns no glow of its
        // own — only the lighter house shade, so deferrable load reads as its own
        // quantity against the section tint it would otherwise inherit. This is the
        // single place that decision is made, for every card that draws these boxes.
        const tintColor = nodeColor ?? (device.deferrable ? withAlpha(DEFERRABLE_HOUSE_COLOR, '60') : undefined);
        const historyBarColor = tintColor ?? 'rgba(var(--rgb-accent-color), 0.13)';
        const deviceContent = html`
                <div class="border deviceContent ${isOff ? 'is-off' : ''}" style=${styleMap({
                    ...(nodeColor ? {'--device-shadow-color': nodeColor} : {}),
                    ...(tintColor ? {'--device-tint': tintColor} : {}),
                })}>
                    <helman-power-history-bars
                        .historyToRender=${[...historyToRender]}
                        .maxHistoryPower=${maxHistoryPower}
                        .historyBarColor=${historyBarColor}
                        .sourceHistory=${device.isSource ? undefined : device.sourcePowerHistory}>
                    </helman-power-history-bars>
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
                                .valueKind=${this.device.valueKind ?? "power"}
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
