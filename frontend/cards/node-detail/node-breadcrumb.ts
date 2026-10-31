import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import type { LocalizeFunction } from "../localize/localize";
import type { TreeItem } from "../shared/data/tree-item";
import { fireEvent } from "../shared/fire-event";
import { dispatchWatchedEntities } from "../shared/hass-change";
import { loadHaEntityToggle } from "../shared/load-ha-elements";
import { SWITCH_ON_COLOR } from "./switch-tile";
import { NODE_DETAIL_REQUEST_EVENT, type NodeDetailRequestDetail, type NodeDetailTarget } from "./node-detail-types";

/**
 * Where a device sits in the house tree: House, then each config device above
 * it, down to its direct parent, as a strip of chevrons. Each segment opens
 * its node's detail. A switched segment's icon carries the switch's state, in
 * the colour the switch tile uses; the fill never does. Any state but on or off
 * stays untinted, never read as either. The strip keeps a gap to the content
 * below, so a switch tile's edge and glow never reach it.
 */
@customElement("helman-node-breadcrumb")
export class HelmanNodeBreadcrumb extends LitElement {
    static styles = css`
        :host { display: block; margin-bottom: var(--ha-space-4, 16px); --arrow: 10px; --icon: 16px; }
        nav { display: flex; height: 26px; overflow: hidden; }
        button {
            box-sizing: border-box; display: flex; align-items: center; gap: 4px;
            flex: 0 1 auto; min-width: calc(var(--icon) + 2 * var(--arrow) + 10px);
            margin: 0; margin-inline-start: calc(2px - var(--arrow)); border: 0;
            padding: 0 calc(var(--arrow) + 4px) 0 calc(var(--arrow) + 6px);
            background: var(--secondary-background-color); color: var(--primary-text-color);
            font: inherit; font-size: 12px; cursor: pointer;
            clip-path: polygon(0 0, calc(100% - var(--arrow)) 0, 100% 50%, calc(100% - var(--arrow)) 100%, 0 100%, var(--arrow) 50%);
        }
        button:first-child { margin-inline-start: 0; padding-left: 12px; min-width: calc(var(--icon) + var(--arrow) + 16px);
            clip-path: polygon(0 0, calc(100% - var(--arrow)) 0, 100% 50%, calc(100% - var(--arrow)) 100%, 0 100%); }
        button:last-child { flex-shrink: 0.2; }
        button:hover { background: color-mix(in srgb, var(--primary-text-color) 8%, var(--secondary-background-color)); }
        button:focus-visible { outline: none; background: color-mix(in srgb, var(--primary-color) 24%, var(--secondary-background-color)); }
        .icon { flex: none; display: block; width: var(--icon); height: var(--icon); --mdc-icon-size: var(--icon); color: var(--primary-text-color); }
        .on .icon { --tile-on: ${SWITCH_ON_COLOR}; --state-switch-active-color: var(--tile-on); color: var(--tile-on); }
        .off .icon { color: var(--secondary-text-color); }
        .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    `;

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public ancestors: readonly TreeItem[] = [];

    connectedCallback(): void {
        super.connectedCallback();
        void loadHaEntityToggle().then(() => this.requestUpdate());
    }

    protected updated(changed: PropertyValues<this>): void {
        if (changed.has("ancestors")) {
            dispatchWatchedEntities(this, "node-detail:breadcrumb", this.ancestors.map((item) => item.switchEntityId));
        }
    }

    render() {
        return html`<nav>
            ${this._segment("house", this.localize("node_detail.title.house"), html`<ha-icon class="icon" .icon=${"mdi:home"}></ha-icon>`)}
            ${this.ancestors.map((item) => this._ancestor(item))}
        </nav>`;
    }

    private _ancestor(item: TreeItem) {
        const label = item.displayName || item.name;
        const icon = html`<ha-icon class="icon" .icon=${item.icon ?? "mdi:power-plug"}></ha-icon>`;
        const state = item.switchEntityId ? this.hass.states[item.switchEntityId] : undefined;
        if (!state) return this._segment(item, label, icon);
        return this._segment(item, label,
            customElements.get("ha-state-icon") ? html`<ha-state-icon class="icon" .hass=${this.hass} .stateObj=${state}></ha-state-icon>` : icon,
            state.state === "on" || state.state === "off" ? state.state : undefined);
    }

    private _segment(target: NodeDetailTarget, label: string, icon: unknown, tone?: "on" | "off") {
        const name = tone ? `${label}, ${this.localize(`node_detail.control.${tone}`)}` : label;
        return html`<button type="button" class=${tone ?? nothing} aria-label=${name} title=${name}
            @click=${() => fireEvent<NodeDetailRequestDetail>(this, NODE_DETAIL_REQUEST_EVENT, { target })}>
            ${icon}<span class="label">${label}</span>
        </button>`;
    }
}
