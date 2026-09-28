import { LitElement, css, html, nothing, unsafeCSS } from "lit-element";
import { nodeAccentColor } from "../color-utils";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import { TreeItem } from "./tree-item";
import "./tree-item-list";
import type { DeviceGrouping, HelmanUiConfig } from "../helman-api";
import { getLocalizeFunction, LocalizeFunction } from "../localize/localize";

@customElement("helman-house-devices-section")
export class HelmanHouseDevicesSection extends LitElement {
    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public devices: TreeItem[] = [];
    @property({ type: Number }) public historyBuckets!: number;
    @property({ type: Number }) public historyBucketDuration!: number;
    /** Bumped by the card once per history tick; see `helman-card._historyRevision`. */
    @property({ type: Number }) public historyRevision?: number;
    @property({ type: Number }) public currentParentPower?: number;
    @property({ attribute: false }) public parentPowerHistory?: number[];
    @property({ attribute: false }) public uiConfig?: HelmanUiConfig;

    // Display options passthrough
    @property({ type: Boolean }) public devices_full_width: boolean = true;
    @property({ type: Boolean }) public sortChildrenByPower: boolean = true;
    @property({ type: Number }) public initial_show_only_top_children: number = 3;

    /** The id of the grouping the devices are grouped by, if any. */
    @state() private _activeCategory?: string;
    @state() private _showAll: boolean = false;
    @state() private _groupedDevices?: TreeItem[];
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
        // The revision is part of the key because the group items hold *copies* of
        // their children's histories: a tick mutates the children in place and the
        // aggregate would otherwise keep painting the bucket it was built from.
        const key = `${cat}|${devices.length}|${ui?.show_others_group ?? true}|${ui?.show_empty_groups ?? false}|${ui?.others_group_label ?? ''}|${this.historyRevision ?? 0}`;

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
                /* Everything in this section is a breakdown of the house box, so
                   it carries the house tint. The rows are untyped items and set
                   no --device-tint of their own, so helman-tree-item's fallback
                   inherits this one — custom properties cross shadow boundaries.
                   Tint only: the glow stays on the top-level boxes. */
                --device-tint: ${unsafeCSS(nodeAccentColor('house'))};
                border: 1px solid var(--ha-card-border-color, var(--divider-color, #444));
                border-radius: 10px;
                padding-left: 6px;
                padding-right: 6px;
                padding-bottom: 6px;
                margin-top: 0px;
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
            button.chip.show-toggle {
                /* Sits on the left of the row; the grouping chips stay right. */
                margin-right: auto;
            }
            button.chip.active {
                background: var(--primary-color);
                color: var(--text-primary-color, #fff);
                border-color: var(--primary-color);
            }
        `;
    }

    private _getGroupings(): DeviceGrouping[] {
        return this.uiConfig?.device_groupings ?? [];
    }

    private _groupByCategory(devices: TreeItem[], groupingId: string): TreeItem[] {
        const grouping = this._getGroupings().find((g) => g.id === groupingId);
        if (!grouping) return devices;
        const groups = new Map<string, TreeItem>();
        for (const { id, name, short_name } of grouping.groups) {
            const group = new TreeItem(`group:${groupingId}:${id}`, `${name} (${short_name})`, null, null, this.historyBuckets);
            group.virtualType = 'group';
            group.groupingId = groupingId;
            group.groupId = id;
            group.children_full_width = true;
            group.sortChildrenByPower = true;
            group.childrenCollapsed = true; // default collapsed
            groups.set(id, group);
        }
        const unmatched: TreeItem[] = [];
        for (const dev of devices) {
            if (dev.isUnmeasured) continue;
            const group = groups.get(dev.groups?.[groupingId] ?? '');
            if (group) group.children.push(dev);
            else unmatched.push(dev);
        }
        // Aggregate power for groups
        const aggregateGroup = (group: TreeItem) => {
            const children = group.children || [];
            group.powerValue = children.reduce((sum, c) => sum + (c.powerValue || 0), 0);
            // History aggregation
            const childWithHist = children.find(c => c.powerHistory && c.powerHistory.length > 0);
            if (childWithHist) {
                const len = childWithHist.powerHistory.length;
                group.powerHistory = Array(len).fill(0);
                for (let i = 0; i < len; i++) {
                    for (const c of children) {
                        group.powerHistory[i] += (c.powerHistory?.[i] || 0);
                    }
                }
                // Aggregate sourcePowerHistory
                group.sourcePowerHistory = [];
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
                    group.sourcePowerHistory.push(bucket);
                }
            } else {
                group.powerHistory = [];
            }
        };
        const result: TreeItem[] = [];
        for (const group of groups.values()) {
            if (group.children.length > 0 || this.uiConfig?.show_empty_groups) {
                aggregateGroup(group);
                result.push(group);
            }
        }
        if ((this.uiConfig?.show_others_group ?? true) && unmatched.length > 0) {
            const others = new TreeItem(`others:${groupingId}`, this.uiConfig?.others_group_label || this._localize?.('house_section.others') || 'Ostatní', null, null, this.historyBuckets);
            others.virtualType = 'others';
            others.groupingId = groupingId;
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
        const groupings = this._getGroupings();
        const activeCat = this._activeCategory;
        const devicesToShow = activeCat ? (this._groupedDevices ?? filtered) : filtered;
    const showTop = activeCat ? 0 : (this._showAll ? 0 : this.initial_show_only_top_children);

        const canToggleShowAll = !activeCat
            && this.initial_show_only_top_children > 0
            && filtered.length > this.initial_show_only_top_children;

        return html`
            <div class="house-section">
                ${canToggleShowAll || groupings.length > 0 ? html`
                    <div class="categories-row">
                        ${canToggleShowAll ? html`
                            <button class="chip show-toggle"
                                @click=${() => { this._showAll = !this._showAll; }}>
                                ${this._showAll
                                    ? (this._localize?.('house_section.show_less') ?? 'Méně')
                                    : (this._localize?.('house_section.show_more') ?? 'Více')}
                            </button>
                        ` : nothing}
                        ${groupings.length > 0 ? html`
                            <div class="categories-title">${this.uiConfig?.groups_title ?? this._localize?.('house_section.group_by') ?? 'Seskupit podle'}</div>
                            <div>
                                ${groupings.map((g) => {
                                    const active = this._activeCategory === g.id;
                                    return html`<button class="chip ${active ? 'active' : ''}"
                                        @click=${() => { this._activeCategory = active ? undefined : g.id; }}>${g.name}</button>`;
                                })}
                            </div>
                        ` : nothing}
                    </div>
                ` : nothing}

                <helman-tree-item-list
                    .hass=${this.hass}
                    .devices=${devicesToShow}
                    .historyBuckets=${this.historyBuckets}
                    .historyBucketDuration=${this.historyBucketDuration}
                    .historyRevision=${this.historyRevision}
                    .currentParentPower=${this.currentParentPower}
                    .parentPowerHistory=${this.parentPowerHistory}
                    .devices_full_width=${this.devices_full_width}
                    .sortChildrenByPower=${this.sortChildrenByPower}
                    .show_only_top_children=${showTop}
                ></helman-tree-item-list>
            </div>
        `;
    }
}
