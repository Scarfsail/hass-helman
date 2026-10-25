import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { formatPower } from "../shared/format";
import { fillTemplate } from "../localize/localize";
import { IDLE_W } from "./live-flows";
import { NODE_DETAIL_REQUEST_EVENT } from "./node-detail-types";
import "./help-tip";

export interface FlowGaugeItem { node: "solar" | "battery" | "grid" | "house"; powerW: number }

@customElement("helman-flow-gauge")
export class HelmanFlowGauge extends LitElement {
    static styles = css`
        :host { display: block; margin: 10px 0 16px; }
        .title { font-size: 0.86rem; color: var(--secondary-text-color); margin-bottom: 6px; }
        .bar { display: flex; gap: 2px; width: 100%; min-height: 30px; }
        button { position: relative; min-width: 32px; height: 30px; flex-basis: 0; display: flex; align-items: center; gap: 3px;
            overflow: visible; padding: 0 5px; border: 0; border-radius: 3px; color: #172026; background: var(--segment);
            font: inherit; font-size: 0.75rem; cursor: pointer; }
        ha-icon { flex: none; --mdc-icon-size: 15px; }
        .figure { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .percent { opacity: 0.7; }
        .popup { position: absolute; z-index: 5; bottom: calc(100% + 4px); left: 50%; transform: translateX(-50%);
            display: none; width: max-content; max-width: min(260px, 80vw); padding: 6px 8px; border-radius: 6px;
            background: var(--card-background-color); color: var(--primary-text-color); box-shadow: 0 2px 8px #0004; }
        button:first-child .popup { left: 0; transform: none; }
        button:last-child .popup { left: auto; right: 0; transform: none; }
        button:hover .popup, button:focus-visible .popup { display: block; }
    `;
    @property({ reflect: true }) public direction: "from" | "to" = "from";
    @property({ attribute: false }) public items: FlowGaugeItem[] = [];
    @property({ type: Boolean }) public estimated = false;
    @property({ attribute: false }) public localize!: (key: string) => string;
    render() {
        const items = this.items.filter((item) => item.powerW >= IDLE_W);
        if (!items.length) return nothing;
        const total = items.reduce((sum, item) => sum + item.powerW, 0);
        return html`<div class="title">${this.localize(`node_detail.shared.gauge.${this.direction}`)} · ${this.localize("node_detail.shared.now")}${this.estimated ? ` · ${this.localize("node_detail.shared.estimated")}` : ""}
            ${this.estimated ? html`<helman-help-tip .explanation=${this.localize("node_detail.shared.gauge.estimate_help")}></helman-help-tip>` : nothing}</div>
            <div class="bar">${items.map((item) => {
                const pct = Math.round(item.powerW / total * 100);
                return html`<button type="button" style=${`--segment: var(--helman-${item.node}); flex-grow: ${pct}`}
                    @click=${() => this.dispatchEvent(new CustomEvent(NODE_DETAIL_REQUEST_EVENT, { detail: { target: item.node }, bubbles: true, composed: true }))}>
                    <ha-icon icon=${`mdi:${item.node === "solar" ? "white-balance-sunny" : item.node === "battery" ? "battery" : item.node === "house" ? "home" : "transmission-tower"}`}></ha-icon>
                    <span class="figure">${formatPower(item.powerW).display} <span class="percent">${pct} %</span></span>
                    <span class="popup">${this.localize(`node_detail.title.${item.node}`)} · ${formatPower(item.powerW).display} · ${pct} %<br>${fillTemplate(this.localize("node_detail.shared.gauge.tap"), { node: this.localize(`node_detail.title.${item.node}`).toLowerCase() })}</span>
                </button>`;
            })}</div>`;
    }
}
