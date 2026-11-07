import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { formatPower } from "../shared/format";
import { fillTemplate } from "../localize/localize";
import { NODE_DETAIL_REQUEST_EVENT } from "./node-detail-types";
import { helmanColorVars } from "../color-vars";
import "./help-tip";

export interface FlowGaugeItem { node: "solar" | "battery" | "grid" | "house"; powerW: number }

/** The house's sources in the gauge's order: what its pills show, live or over a period. */
export const SOURCE_NODES = ["solar", "battery", "grid"] as const;

/** The three counterparts each node's gauge shows, left to right, whatever flows. */
export const FLOW_GAUGE_COUNTERPARTS: Record<FlowGaugeItem["node"], readonly FlowGaugeItem["node"][]> = {
    house: SOURCE_NODES,
    solar: ["house", "battery", "grid"],
    battery: ["house", "solar", "grid"],
    grid: ["house", "battery", "solar"],
};

/** The mdi icon each node's pill shows. */
export function nodeIcon(node: FlowGaugeItem["node"]): string {
    return `mdi:${node === "solar" ? "white-balance-sunny" : node === "battery" ? "battery" : node === "house" ? "home" : "transmission-tower"}`;
}

/**
 * The gauge's pill: tinted in its node's colour (`--node`), filled to its
 * share (`--fill`), glowing while `data-active`, muted while not. Shared by
 * every gauge drawn this way, live or over a period.
 */
export const gaugePillStyles = css`
    .gauge-title { display: flex; align-items: center; font-size: 11px; font-weight: 600; text-transform: uppercase;
        letter-spacing: 0.08em; color: var(--secondary-text-color); }
    .pills { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; width: 100%; }
    .pill { box-sizing: border-box; position: relative; min-width: 0; height: 30px; display: flex; align-items: center;
        justify-content: center; gap: 6px; overflow: visible; padding: 0 8px; border: 0; border-radius: 6px;
        color: var(--primary-text-color); background: color-mix(in srgb, var(--node) 20%, transparent);
        font: inherit; font-size: 13px; font-weight: 500; white-space: nowrap; container-type: inline-size; }
    .pill::before { content: ""; position: absolute; inset: 0 auto 0 0; width: var(--fill); border-radius: inherit;
        background: color-mix(in srgb, var(--node) 55%, transparent); }
    /* Above the fill; a popup keeps its own position. */
    .pill > :not(.popup) { position: relative; }
    .pill[data-active] { animation: glow 2.5s ease-in-out infinite; }
    /* Mute the idle pill's own content, not its popup. */
    .pill:not([data-active]) { background: color-mix(in srgb, var(--node) 8%, transparent); }
    .pill:not([data-active]) > :not(.popup) { opacity: 0.4; }
    @keyframes glow {
        0%, 100% { box-shadow: 0 0 4px var(--node); }
        50% { box-shadow: 0 0 12px var(--node); }
    }
    @media (prefers-reduced-motion: reduce) {
        .pill[data-active] { animation: none; box-shadow: 0 0 8px var(--node); }
    }
    .pill ha-icon { flex: none; --mdc-icon-size: 15px; }
    .pill .percent { opacity: 0.7; }
    .pill .gauge-figure { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    /* Too narrow for both: keep the figure whole; the fill still gives the share. */
    @container (max-width: 90px) { .pill .percent { display: none; } }
`;

@customElement("helman-flow-gauge")
export class HelmanFlowGauge extends LitElement {
    static styles = [helmanColorVars, gaugePillStyles, css`
        :host { display: flex; flex-direction: column; gap: 14px; }
        button { cursor: pointer; }
        button:hover { filter: brightness(1.1); }
        button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        .popup { position: absolute; z-index: 5; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
            display: none; width: max-content; max-width: min(260px, 80vw); padding: 8px 10px; border-radius: 8px;
            background: var(--secondary-background-color); color: var(--primary-text-color); box-shadow: 0 6px 20px #0006;
            font-size: 12px; font-weight: 400; line-height: 1.45; text-align: start; white-space: normal; }
        .popup .hint { color: var(--secondary-text-color); }
        button:first-child .popup { left: 0; transform: none; }
        button:last-child .popup { left: auto; right: 0; transform: none; }
        button:hover .popup, button:focus-visible .popup { display: block; }
    `];
    /** The node whose detail this is; it fixes the three pills and their order. */
    @property() public of!: FlowGaugeItem["node"];
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
    /** Always the same three pills, so the overview never jumps; an idle one is muted but still opens its node. */
    render() {
        const shown = this._shown;
        const total = shown.reduce((sum, item) => sum + item.powerW, 0);
        return html`<div class="title gauge-title">${this.localize(`node_detail.shared.gauge.${this.direction}`)} · ${this.localize("node_detail.shared.now")}${this.estimated ? ` · ${this.localize("node_detail.shared.estimated")}` : ""}
            ${this.estimated ? html`<helman-help-tip .explanation=${this.localize("node_detail.shared.gauge.estimate_help")}></helman-help-tip>` : nothing}</div>
            <div class="pills">${FLOW_GAUGE_COUNTERPARTS[this.of].map((node) => {
                const powerW = shown.find((item) => item.node === node)?.powerW ?? 0;
                const active = powerW > 0;
                const pct = active ? Math.max(1, Math.round(powerW / total * 100)) : 0;
                const figure = html`${formatPower(powerW).display}${active ? html` <span class="percent">${pct} %</span>` : nothing}`;
                return html`<button class="pill" type="button" ?data-active=${active} style=${`--node: var(--helman-${node}); --fill: ${pct}%`}
                    @click=${() => this.dispatchEvent(new CustomEvent(NODE_DETAIL_REQUEST_EVENT, { detail: { target: node }, bubbles: true, composed: true }))}>
                    <ha-icon icon=${nodeIcon(node)}></ha-icon>
                    <span class="figure gauge-figure">${figure}</span>
                    <span class="popup"><b>${this.localize(`node_detail.title.${node}`)}</b> · ${formatPower(powerW).display}${active ? ` · ${pct} %` : ""}<br><span class="hint">${fillTemplate(this.localize("node_detail.shared.gauge.tap"), { node: this.localize(`node_detail.title.${node}`).toLowerCase() })}</span></span>
                </button>`;
            })}</div>`;
    }
}
