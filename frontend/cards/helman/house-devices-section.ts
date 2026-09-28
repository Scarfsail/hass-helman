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
        const key = `${cat}|${devices.length}|${ui?.show_others_group ?? true}|${ui?.show_empty_groups ?? false}|${this.historyRevision ?? 0}`;

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
        // Members still to file, with the group each is filed under: its own,
        // else it stays nested with its parent. A lifted descendant joins the
        // queue and is filed, with its own subtree, like a top-level device.
        const queue = devices
            .filter((dev) => !dev.isUnmeasured)
            .map((dev) => ({ item: dev, group: dev.groups?.[groupingId] || null }));
        for (let index = 0; index < queue.length; index++) {
            const next = queue[index];
            const member = this._withoutLifted(next.item, next.group, groupingId, queue).item;
            const group = groups.get(next.group ?? '');
            if (group) group.children.push(member);
            else unmatched.push(member);
        }
        // Aggregate power for groups
        const aggregateGroup = (group: TreeItem) => {
            const children = group.children || [];
            group.powerValue = children.reduce((sum, c) => sum + (c.powerValue || 0), 0);
            // History aggregation, over the longest member series. Every series
            // ends at the newest bucket, so a shorter one is aligned from the end.
            const len = Math.max(0, ...children.map((c) => c.powerHistory?.length ?? 0));
            if (len > 0) {
                group.powerHistory = Array(len).fill(0);
                group.sourcePowerHistory = Array.from({ length: len }, () => ({}));
                for (const c of children) {
                    const offset = len - (c.powerHistory?.length ?? 0);
                    c.powerHistory?.forEach((power, i) => {
                        group.powerHistory[i + offset] += power || 0;
                    });
                    const sourceOffset = len - (c.sourcePowerHistory?.length ?? 0);
                    c.sourcePowerHistory?.forEach((src, i) => {
                        const bucket = group.sourcePowerHistory![i + sourceOffset];
                        if (!src || !bucket) return;
                        for (const sName in src) {
                            if (!bucket[sName]) {
                                bucket[sName] = { power: 0, color: src[sName].color };
                            }
                            bucket[sName].power += src[sName].power;
                        }
                    });
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
            const others = new TreeItem(`others:${groupingId}`, this._localize?.('house_section.others') ?? 'Others', null, null, this.historyBuckets);
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

    /**
     * The item as filed under `group`, and the descendants lifted out of it.
     * A descendant is filed under its own group, else it stays nested with its
     * parent; one filed under a different group than its parent's is queued to
     * be filed on its own, with its subtree; every ancestor up to `item` is then
     * a copy without it and without its power, so no watt is counted twice. The
     * shared items are never mutated: the plain view and the history engine hold
     * them. The unmeasured remainder is never lifted.
     */
    private _withoutLifted(
        item: TreeItem,
        group: string | null,
        groupingId: string,
        queue: { item: TreeItem; group: string | null }[],
    ): { item: TreeItem; lifted: TreeItem[] } {
        const lifted: TreeItem[] = [];
        const children: TreeItem[] = [];
        for (const child of item.children ?? []) {
            const childGroup = child.isUnmeasured ? group : child.groups?.[groupingId] || group;
            if (childGroup !== group) {
                lifted.push(child);
                queue.push({ item: child, group: childGroup });
                continue;
            }
            const kept = this._withoutLifted(child, group, groupingId, queue);
            children.push(kept.item);
            lifted.push(...kept.lifted);
        }
        if (lifted.length === 0) return { item, lifted };
        // Summed once per copy. Histories are aligned from their newest end, as
        // history-engine does: a series that started later is shorter.
        const history = item.powerHistory ?? [];
        const sources = item.sourcePowerHistory;
        const takenPower = lifted.reduce((sum, l) => sum + (l.powerValue ?? 0), 0);
        const takenHistory = history.map(() => 0);
        const takenSources = (sources ?? []).map((): { [sourceName: string]: number } => ({}));
        for (const l of lifted) {
            const offset = (l.powerHistory?.length ?? 0) - history.length;
            history.forEach((_, i) => {
                takenHistory[i] += l.powerHistory?.[i + offset] ?? 0;
            });
            const sourceOffset = (l.sourcePowerHistory?.length ?? 0) - takenSources.length;
            takenSources.forEach((taken, i) => {
                const bucket = l.sourcePowerHistory?.[i + sourceOffset];
                for (const name in bucket) taken[name] = (taken[name] ?? 0) + bucket[name].power;
            });
        }
        const copy: TreeItem = Object.assign(Object.create(TreeItem.prototype), item);
        copy.children = children;
        // The copy is rebuilt every tick; expanding it must stick to the shared item.
        Object.defineProperty(copy, 'childrenCollapsed', {
            get: () => item.childrenCollapsed,
            set: (collapsed: boolean) => { item.childrenCollapsed = collapsed; },
        });
        copy.powerValue = Math.max(0, (item.powerValue ?? 0) - takenPower);
        copy.powerHistory = history.map((power, i) => Math.max(0, power - takenHistory[i]));
        copy.sourcePowerHistory = sources?.map((bucket, i) => {
            const rest: { [sourceName: string]: { power: number; color: string } } = {};
            for (const name in bucket) {
                rest[name] = {
                    power: Math.max(0, bucket[name].power - (takenSources[i][name] ?? 0)),
                    color: bucket[name].color,
                };
            }
            return rest;
        });
        return { item: copy, lifted };
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
                            <div class="categories-title">${this._localize?.('house_section.group_by') ?? 'Group by'}</div>
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
