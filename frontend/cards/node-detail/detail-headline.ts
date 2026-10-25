import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { openMoreInfo } from "./node-detail-readings";

@customElement("helman-detail-headline")
export class HelmanDetailHeadline extends LitElement {
    static styles = css`
        :host { display: flex; align-items: center; gap: 16px; min-height: 76px; }
        .icon { width: 64px; height: 64px; flex: none; display: grid; place-items: center; }
        .text { min-width: 0; }
        button { border: 0; padding: 0; background: none; color: var(--detail-headline-color, inherit); font: inherit; font-size: 1.7rem;
            font-weight: 650; cursor: pointer; }
        button:hover { text-decoration: underline dotted; text-underline-offset: 4px; }
        .value { font-size: 1.7rem; font-weight: 650; color: var(--detail-headline-color, inherit); }
        .caption { display: flex; flex-wrap: wrap; gap: 0 6px; color: var(--secondary-text-color); }
        .part { white-space: nowrap; }
        .part:not(:last-child)::after { content: " ·"; }
    `;
    @property() public value = "—";
    @property({ attribute: false }) public entityId: string | null = null;
    @property({ attribute: false }) public caption: string[] = [];
    render() {
        return html`<div class="icon"><slot name="icon"></slot></div><div class="text">
            ${this.entityId ? html`<button data-headline @click=${() => openMoreInfo(this, this.entityId!)}>${this.value}</button>`
                : html`<span class="value">${this.value}</span>`}
            <div class="caption">${this.caption.map((part) => html`<span class="part">${part}</span>`)}</div>
        </div>`;
    }
}
