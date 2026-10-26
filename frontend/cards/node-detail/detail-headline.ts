import { LitElement, css, html, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { openMoreInfo } from "./node-detail-readings";

@customElement("helman-detail-headline")
export class HelmanDetailHeadline extends LitElement {
    static styles = css`
        :host { display: flex; align-items: center; gap: 16px; }
        .icon { width: 64px; height: 64px; flex: none; display: grid; place-items: center; }
        ::slotted(simple-card-house), ::slotted(simple-card-solar), ::slotted(simple-card-grid), ::slotted(simple-card-battery) { transform: scale(1.6); }
        ::slotted(ha-icon) { --mdc-icon-size: 48px; }
        .text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        button, .value { align-self: flex-start; color: var(--detail-headline-color, var(--primary-text-color)); font-size: 36px;
            line-height: 1.1; font-weight: var(--ha-font-weight-normal, 400); overflow-wrap: anywhere; }
        button { border: 0; padding: 0; background: none; font-family: inherit; text-align: start; cursor: pointer; border-radius: 6px; }
        button:hover { text-decoration: underline dotted; text-decoration-thickness: 2px; text-underline-offset: 6px; }
        button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        .caption { display: flex; flex-wrap: wrap; column-gap: 0.3em; color: var(--secondary-text-color); font-size: 12px; line-height: 1.45; }
        /* A part moves whole to the next line; only a part wider than the line wraps inside. */
        .part { min-width: 0; }
        .part:not(:last-child)::after { content: "\\00a0·"; }
    `;
    @property() public value = "—";
    @property({ attribute: false }) public entityId: string | null = null;
    @property({ attribute: false }) public caption: Array<string | TemplateResult> = [];
    render() {
        return html`<div class="icon"><slot name="icon"></slot></div><div class="text">
            ${this.entityId ? html`<button data-headline @click=${() => openMoreInfo(this, this.entityId!)}>${this.value}</button>`
                : html`<span class="value">${this.value}</span>`}
            <div class="caption">${this.caption.map((part) => html`<span class="part">${part}</span>`)}</div>
        </div>`;
    }
}
