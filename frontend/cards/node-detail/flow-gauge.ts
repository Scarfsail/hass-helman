import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { formatPower } from "../shared/format";
import { fillTemplate } from "../localize/localize";
import { NODE_DETAIL_REQUEST_EVENT } from "./node-detail-types";
import { helmanColorVars } from "../color-vars";
import "./help-tip";

export interface FlowGaugeItem { node: "solar" | "battery" | "grid" | "house"; powerW: number }

@customElement("helman-flow-gauge")
export class HelmanFlowGauge extends LitElement {
    static styles = [helmanColorVars, css`
        :host { display: flex; flex-direction: column; gap: 14px; }
        .title { display: flex; align-items: center; font-size: 11px; font-weight: 600; text-transform: uppercase;
            letter-spacing: 0.08em; color: var(--secondary-text-color); }
        .bar { display: flex; gap: 2px; width: 100%; }
        .placeholder { box-sizing: border-box; display: flex; align-items: center; justify-content: center; width: 100%; height: 30px;
            border-radius: 6px; background: var(--secondary-background-color); color: var(--secondary-text-color); font-size: 13px; }
        button { box-sizing: border-box; position: relative; min-width: 32px; height: 30px; flex-basis: 0; display: flex; align-items: center;
            justify-content: center; gap: 6px; overflow: visible; padding: 0 8px; border: 0; border-radius: 6px; color: #111316;
            background: var(--segment); font: inherit; font-size: 13px; font-weight: 500; white-space: nowrap; cursor: pointer; }
        button:hover { filter: brightness(1.1); }
        button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        ha-icon { flex: none; --mdc-icon-size: 15px; }
        .figure { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        .percent { opacity: 0.7; }
        .popup { position: absolute; z-index: 5; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
            display: none; width: max-content; max-width: min(260px, 80vw); padding: 8px 10px; border-radius: 8px;
            background: var(--secondary-background-color); color: var(--primary-text-color); box-shadow: 0 6px 20px #0006;
            font-size: 12px; font-weight: 400; line-height: 1.45; text-align: start; white-space: normal; }
        .popup .hint { color: var(--secondary-text-color); }
        button:first-child .popup { left: 0; transform: none; }
        button:last-child .popup { left: auto; right: 0; transform: none; }
        button:hover .popup, button:focus-visible .popup { display: block; }
    `];
    /** `flow` names neither way, for a node whose way depends on the flow while nothing flows. */
    @property({ reflect: true }) public direction: "from" | "to" | "flow" = "from";
    @property({ attribute: false }) public items: FlowGaugeItem[] = [];
    @property({ type: Boolean }) public estimated = false;
    @property({ attribute: false }) public localize!: (key: string) => string;
    /**
     * Every part that rounds to a watt: its caller decides what is idle, so
     * the parts add up to the figure the detail headlines (a device's small
     * solar share is part of its power, not noise).
     */
    private get _shown(): FlowGaugeItem[] { return this.items.filter((item) => Math.round(item.powerW) > 0); }
    /** With nothing flowing the bar is an empty track of the same height, so the overview never jumps. */
    render() {
        const items = this._shown;
        const total = items.reduce((sum, item) => sum + item.powerW, 0);
        return html`<div class="title">${this.localize(`node_detail.shared.gauge.${this.direction}`)} · ${this.localize("node_detail.shared.now")}${this.estimated ? ` · ${this.localize("node_detail.shared.estimated")}` : ""}
            ${this.estimated ? html`<helman-help-tip .explanation=${this.localize("node_detail.shared.gauge.estimate_help")}></helman-help-tip>` : nothing}</div>
            ${items.length === 0 ? html`<div class="placeholder" data-idle>${this.localize("node_detail.shared.gauge.idle")}</div>` : html`<div class="bar">${items.map((item) => {
                const pct = Math.round(item.powerW / total * 100);
                return html`<button type="button" style=${`--segment: var(--helman-${item.node}); flex-grow: ${pct}`}
                    @click=${() => this.dispatchEvent(new CustomEvent(NODE_DETAIL_REQUEST_EVENT, { detail: { target: item.node }, bubbles: true, composed: true }))}>
                    <ha-icon icon=${`mdi:${item.node === "solar" ? "white-balance-sunny" : item.node === "battery" ? "battery" : item.node === "house" ? "home" : "transmission-tower"}`}></ha-icon>
                    <span class="figure">${formatPower(item.powerW).display} <span class="percent">${pct} %</span></span>
                    <span class="popup"><b>${this.localize(`node_detail.title.${item.node}`)}</b> · ${formatPower(item.powerW).display} · ${pct} %<br><span class="hint">${fillTemplate(this.localize("node_detail.shared.gauge.tap"), { node: this.localize(`node_detail.title.${item.node}`).toLowerCase() })}</span></span>
                </button>`;
            })}</div>`}`;
    }
}
