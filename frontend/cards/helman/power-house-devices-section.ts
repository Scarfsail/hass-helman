import { LitElement, css, html, nothing } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import { DeviceNode } from "./DeviceNode";
import "./power-devices-container";
import type { HelmanUiConfig } from "../helman-api";
import { getLocalizeFunction, LocalizeFunction } from "../localize/localize";

@customElement("power-house-devices-section")
export class PowerHouseDevicesSection extends LitElement {
    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public devices: DeviceNode[] = [];
    @property({ type: Number }) public historyBuckets!: number;
    @property({ type: Number }) public historyBucketDuration!: number;
    @property({ type: Number }) public currentParentPower?: number;
    @property({ attribute: false }) public parentPowerHistory?: number[];
    @property({ attribute: false }) public uiConfig?: HelmanUiConfig;

    // Display options passthrough
    @property({ type: Boolean }) public devices_full_width: boolean = true;
    @property({ type: Boolean }) public sortChildrenByPower: boolean = true;
    @property({ type: Number }) public initial_show_only_top_children: number = 3;

    @state() private _activeCategory?: string;
    @state() private _showAll: boolean = false;
    @state() private _groupedDevices?: DeviceNode[];
    private _localize?: LocalizeFunction;
    private _groupedKey?: string;

    willUpdate(changedProperties: Map<string, unknown>): void {
        if (!this._localize && changedProperties.has('hass') && this.hass) {
            this._localize = getLocalizeFunction(this.hass);
        }

        const cat = this._activeCategory;
        if (!cat) {
            if (this._groupedDevices !== undefined) {
                this._groupedDevices = undefined;
                this._groupedKey = undefined;
            }
            return;
        }

        const devices = this.devices || [];
        const ui = this.uiConfig;
        const key = `${cat}|${devices.length}|${ui?.show_others_group ?? true}|${ui?.show_empty_groups ?? false}|${ui?.others_group_label ?? ''}`;

        const inputsChanged =
            changedProperties.has('devices') ||
            changedProperties.has('_activeCategory') ||
            changedProperties.has('uiConfig') ||
            this._groupedKey !== key;

        if (!inputsChanged) return;

        this._groupedDevices = this._groupByCategory(devices, cat);
        this._groupedKey = key;
    }

    static get styles() {
        return css`
            .house-section {
                border: 1px solid var(--ha-card-border-color, var(--divider-color, #444));
                border-radius: 10px;
                padding-left: 6px;
                padding-right: 6px;
                padding-bottom: 6px;
                margin-top: 0px;
            }
            .toggle-row {
                text-align: center;
                cursor: pointer;
            }
            .categories-row {
                display: flex;
                align-items: center;
                flex-wrap: wrap;
                gap: 6px;
                padding-top: 6px;
                padding-bottom: 6px;
                margin: 0;
                justify-content: flex-end;
            }
            .categories-title {
                font-size: 0.8rem;
                color: var(--secondary-text-color);
                opacity: 0.9;
            }
            button.chip {
                appearance: none;
                border: 1px solid var(--ha-card-border-color, var(--divider-color, #444));
                background: var(--card-background-color, #1c1c1c);
                color: var(--secondary-text-color);
                border-radius: 999px;
                padding: 4px 10px;
                font-size: 0.75rem;
                cursor: pointer;
                transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
            }
            button.chip:hover {
                border-color: var(--primary-color);
                color: var(--primary-text-color);
            }
            button.chip.active {
                background: var(--primary-color);
                color: var(--text-primary-color, #fff);
                border-color: var(--primary-color);
            }
        `;
    }

    // No label filtering anymore – grouping replaces it

    private _getCategories(): string[] {
        const mapping = this.uiConfig?.device_label_text || {};
        return Object.keys(mapping);
    }

    private _groupByCategory(devices: DeviceNode[], category: string): DeviceNode[] {
        const mapping = this.uiConfig?.device_label_text?.[category];
        if (!mapping) return devices;
        const order = Object.keys(mapping);
        const groups: Record<string, DeviceNode> = {};
        for (const label of order) {
            const id = `group:${category}:${label}`;
            const emoji = mapping[label];
            const node = new DeviceNode(id, `${label} (${emoji})`, null, null, this.historyBuckets);
            node.virtualType = 'labelCategory';
            node.groupCategory = category;
            node.groupLabel = label;
            node.children_full_width = true;
            node.sortChildrenByPower = true;
            node.childrenCollapsed = true; // default collapsed
            groups[label] = node;
        }
        const unmatched: DeviceNode[] = [];
        for (const dev of devices) {
            if (dev.isUnmeasured) continue;
            const labels = new Set(dev.labels || []);
            let assigned = false;
            for (const label of order) {
                if (labels.has(label)) {
                    groups[label].children.push(dev);
                    assigned = true;
                    break;
                }
            }
            if (!assigned) unmatched.push(dev);
        }
        // Aggregate power for groups
        const aggregateGroup = (node: DeviceNode) => {
            const children = node.children || [];
            node.powerValue = children.reduce((sum, c) => sum + (c.powerValue || 0), 0);
            // History aggregation
            const childWithHist = children.find(c => c.powerHistory && c.powerHistory.length > 0);
            if (childWithHist) {
                const len = childWithHist.powerHistory.length;
                node.powerHistory = Array(len).fill(0);
                for (let i = 0; i < len; i++) {
                    for (const c of children) {
                        node.powerHistory[i] += (c.powerHistory?.[i] || 0);
                    }
                }
                // Aggregate sourcePowerHistory
                node.sourcePowerHistory = [];
                for (let i = 0; i < len; i++) {
                    const bucket: { [sourceName: string]: { power: number; color: string } } = {};
                    for (const c of children) {
                        const src = c.sourcePowerHistory?.[i];
                        if (!src) continue;
                        for (const sName in src) {
                            if (!bucket[sName]) {
                                bucket[sName] = { power: 0, color: src[sName].color };
                            }
                            bucket[sName].power += src[sName].power;
                        }
                    }
                    node.sourcePowerHistory.push(bucket);
                }
            } else {
                node.powerHistory = [];
            }
        };
        const result: DeviceNode[] = [];
        for (const label of order) {
            const node = groups[label];
            if (node.children.length > 0 || this.uiConfig?.show_empty_groups) {
                aggregateGroup(node);
                result.push(node);
            }
        }
        if ((this.uiConfig?.show_others_group ?? true) && unmatched.length > 0) {
            const others = new DeviceNode(`group:${category}:others`, this.uiConfig?.others_group_label || this._localize?.('house_section.others') || 'Ostatní', null, null, this.historyBuckets);
            others.virtualType = 'others';
            others.groupCategory = category;
            others.children_full_width = true;
            others.sortChildrenByPower = true;
            others.childrenCollapsed = true; // default collapsed
            others.children = unmatched;
            aggregateGroup(others);
            result.push(others);
        }
        return result;
    }

    render() {
    const filtered = this.devices || [];
        const categories = this._getCategories();
        const activeCat = this._activeCategory;
        const devicesToShow = activeCat ? (this._groupedDevices ?? filtered) : filtered;
    const showTop = activeCat ? 0 : (this._showAll ? 0 : this.initial_show_only_top_children);

        return html`
            <div class="house-section">
                ${categories.length > 0 ? html`
                    <div class="categories-row">
                        <div class="categories-title">${this.uiConfig?.groups_title ?? this._localize?.('house_section.group_by') ?? 'Seskupit podle'}</div>
                        <div>
                            ${categories.map((c) => {
                                const active = this._activeCategory === c;
                                return html`<button class="chip ${active ? 'active' : ''}"
                                    @click=${() => { this._activeCategory = active ? undefined : c; }}>${c}</button>`;
                            })}
                        </div>
                    </div>
                ` : nothing}

                <power-devices-container
                    .hass=${this.hass}
                    .devices=${devicesToShow}
                    .historyBuckets=${this.historyBuckets}
                    .historyBucketDuration=${this.historyBucketDuration}
                    .currentParentPower=${this.currentParentPower}
                    .parentPowerHistory=${this.parentPowerHistory}
                    .devices_full_width=${this.devices_full_width}
                    .sortChildrenByPower=${this.sortChildrenByPower}
                    .show_only_top_children=${showTop}
                ></power-devices-container>

                ${!activeCat ? html`<div class="toggle-row" @click=${() => { this._showAll = !this._showAll; }}>...</div>` : nothing}
            </div>
        `;
    }
}
