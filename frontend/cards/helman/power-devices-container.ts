import { LitElement, TemplateResult, css, html } from "lit-element";
import { customElement, property } from "lit/decorators.js";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import { DeviceNode, isNodeVisible } from "./DeviceNode";

/**
 * The rows in the order they are drawn, ranked by history total then by name.
 *
 * Each history is summed once and the comparator reads the sum, rather than
 * re-reducing both operands at every comparison — the same ordering for
 * O(devices x history) instead of O(devices x log(devices) x history).
 */
function sortedIdsByHistoryAndName(devices: DeviceNode[]): string[] {
    const totals = new Map<string, number>();
    for (const device of devices) {
        let total = 0;
        for (const value of device.powerHistory) total += value;
        totals.set(device.id, total);
    }
    return [...devices]
        .sort((a, b) => (totals.get(b.id)! - totals.get(a.id)!) || a.name.localeCompare(b.name))
        .map(device => device.id);
}
import "./power-device";

@customElement("power-devices-container")
export class PowerDevicesContainer extends LitElement {
    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public devices!: DeviceNode[];
    
    // Sorting cache: the sorted ORDER (ids), not the array itself.
    private _sortedIds?: string[];
    private _sortKey?: string;
    /** `Math.max` over `parentPowerHistory`, scanned once for all the rows below. */
    private _parentMaxPower?: number;
    @property({ type: Number }) public currentParentPower?: number;
    @property({ attribute: false }) public parentPowerHistory?: number[];
    @property({ type: Number }) public historyBuckets!: number;
    @property({ type: Number }) public historyBucketDuration!: number;
    /** Bumped by the card once per history tick; see `helman-card._historyRevision`. */
    @property({ type: Number }) public historyRevision?: number;
    @property({ type: Boolean }) public devices_full_width?: boolean;
    @property({ type: Boolean }) public sortChildrenByPower?: boolean;
    @property({ type: Number }) public show_only_top_children?: number;
    @property({ type: Boolean }) public openNodeDetailOnIcon = false;

    willUpdate(changedProperties: Map<string, unknown>): void {
        super.willUpdate(changedProperties);

        // The scale every row below shares. The buffer is mutated in place, so its
        // identity says which array to scan and `historyRevision` says the numbers
        // in it moved; a feeder that builds a fresh array each time (the solar
        // inspector) carries no revision and is caught by the identity alone.
        if (changedProperties.has('parentPowerHistory') || changedProperties.has('historyRevision')) {
            this._parentMaxPower = this.parentPowerHistory ? Math.max(...this.parentPowerHistory) : undefined;
        }

        // Only recalculate sort order if sortChildrenByPower is enabled
        if (this.sortChildrenByPower && this.devices) {
            // The order is a function of the histories, so the key names the roster
            // and the revision that moved them — never the current power, which
            // churns without reordering anything and stands still while a rolling
            // bucket reverses the totals.
            const key = `${this.historyRevision ?? 0}|${this.devices.map(d => `${d.id}:${d.name}`).join(',')}`;
            if (key !== this._sortKey || changedProperties.has('devices')) {
                this._sortedIds = sortedIdsByHistoryAndName(this.devices);
                this._sortKey = key;
            }
        } else {
            // Clear cache if sorting is disabled
            this._sortedIds = undefined;
            this._sortKey = undefined;
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
        if (this.sortChildrenByPower && this._sortedIds) {
            // Create map for O(1) lookup
            const deviceMap = new Map(this.devices.map(d => [d.id, d]));
            // Return NEW array using cached order - Lit will detect the change
            devicesToRender = this._sortedIds.map(id => deviceMap.get(id)!).filter(d => d);
        } else {
            devicesToRender = this.devices;
        }
        
        // Drop the nodes that would render nothing before taking the top N, so the
        // cut spends its slots on rows the user actually sees. Sorting ranks by
        // history sum while visibility asks about the current value, so a node can
        // win a slot and then paint nothing — that is the gap this closes.
        devicesToRender = devicesToRender.filter(isNodeVisible);
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
                        .parentMaxPower=${this._parentMaxPower}
                        .historyBuckets=${this.historyBuckets}
                        .historyBucketDuration=${this.historyBucketDuration}
                        .historyRevision=${this.historyRevision}
                        .openNodeDetailOnIcon=${this.openNodeDetailOnIcon}
                    ></power-device>
                `)}
            </div>
        `;
    }
}
