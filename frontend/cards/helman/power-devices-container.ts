import { LitElement, TemplateResult, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import { DeviceNode } from "./DeviceNode";

function sortDevicesByPowerAndName(devices: DeviceNode[]): DeviceNode[] {
    return [...devices].sort((a, b) => {
        const powerA = a.powerHistory.reduce((acc, val) => acc + val, 0);
        const powerB = b.powerHistory.reduce((acc, val) => acc + val, 0);
        if (powerB !== powerA) return powerB - powerA;
        return a.name.localeCompare(b.name);
    });
}
import "./power-device";

@customElement("power-devices-container")
export class PowerDevicesContainer extends LitElement {
    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public devices!: DeviceNode[];
    
    // Sorting cache: Store sorted ORDER (IDs), not the array itself
    private _lastSortedIds?: string[];
    private _lastDevicesPowerSnapshot?: string;
    @property({ type: Number }) public currentParentPower?: number;
    @property({ attribute: false }) public parentPowerHistory?: number[];
    @property({ type: Number }) public historyBuckets!: number;
    @property({ type: Number }) public historyBucketDuration!: number;
    @property({ type: Boolean }) public devices_full_width?: boolean;
    @property({ type: Boolean }) public sortChildrenByPower?: boolean;
    @property({ type: Number }) public show_only_top_children?: number;
    @property({ type: Boolean }) public openNodeDetailOnIcon = false;

    willUpdate(changedProperties: Map<string, unknown>): void {
        super.willUpdate(changedProperties);
        
        // Only recalculate sort order if sortChildrenByPower is enabled
        if (this.sortChildrenByPower && this.devices) {
            // Create snapshot of device IDs and their power values
            const powerSnapshot = this.devices.map(d => `${d.id}:${d.powerValue}`).join(',');
            
            // Only re-sort if power values changed
            if (powerSnapshot !== this._lastDevicesPowerSnapshot) {
                const sorted = sortDevicesByPowerAndName(this.devices);
                // Cache the SORTED ORDER (just IDs)
                this._lastSortedIds = sorted.map(d => d.id);
                this._lastDevicesPowerSnapshot = powerSnapshot;
            }
        } else {
            // Clear cache if sorting is disabled
            this._lastSortedIds = undefined;
            this._lastDevicesPowerSnapshot = undefined;
        }
    }

    static get styles() {
        return css`
            .container {
                flex-basis: 100%;
                gap: 5px; /* Optional: adds some space between children */
                display: flex;
                align-items: stretch
            }
            .container.full-width {
                display: flex;
                flex-wrap: wrap;
                flex-direction:column;
                gap: 5px;
            }
            .container.full-width > power-device {
                flex-grow: 1;
                flex-basis: 0;
                min-width: 150px; /* Optional: prevent children from becoming too small */
            }
        `;
    }

    render(): TemplateResult {
        let devicesToRender: DeviceNode[];
        
        // Use cached sort order if available, but create FRESH array reference
        if (this.sortChildrenByPower && this._lastSortedIds) {
            // Create map for O(1) lookup
            const deviceMap = new Map(this.devices.map(d => [d.id, d]));
            // Return NEW array using cached order - Lit will detect the change
            devicesToRender = this._lastSortedIds.map(id => deviceMap.get(id)!).filter(d => d);
        } else {
            devicesToRender = this.devices;
        }
        
        if (this.show_only_top_children && this.show_only_top_children > 0) {
            devicesToRender = devicesToRender.slice(0, this.show_only_top_children);
        }
        return html`
            <div class="container ${this.devices_full_width ? 'full-width' : ''}">
                ${devicesToRender.map((device) => html`
                    <power-device
                        .hass=${this.hass}
                        .device=${device}
                        .currentParentPower=${this.currentParentPower}
                        .parentPowerHistory=${this.parentPowerHistory}
                        .historyBuckets=${this.historyBuckets}
                        .historyBucketDuration=${this.historyBucketDuration}
                        .openNodeDetailOnIcon=${this.openNodeDetailOnIcon}
                    ></power-device>
                `)}
            </div>
        `;
    }
}
