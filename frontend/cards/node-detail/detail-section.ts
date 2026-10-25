import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("helman-detail-section")
export class HelmanDetailSection extends LitElement {
    static styles = css`
        :host { display: block; border-top: 1px solid var(--divider-color); }
        button { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 52px; padding: 8px 4px;
            border: 0; background: none; color: var(--primary-text-color); font: inherit; text-align: start; cursor: pointer; }
        button:focus-visible { outline: 2px solid var(--primary-color); }
        ha-icon { flex: none; color: var(--secondary-text-color); }
        .title { font-weight: 600; white-space: nowrap; }
        .summary { margin-inline-start: auto; text-align: end; color: var(--secondary-text-color); }
        .chevron { transition: transform 0.2s; }
        .chevron.open { transform: rotate(180deg); }
        .body { padding: 4px 0 16px; }
        ::slotted([slot="summary"]) { font-weight: inherit; }
    `;

    @property() public icon = "mdi:calendar";
    @property() public title = "";
    @property({ type: Boolean, reflect: true }) public expanded = false;
    @property({ type: Boolean, attribute: "admin-only" }) public adminOnly = false;
    @property({ type: Boolean, attribute: false }) public isAdmin = false;
    private readonly _bodyId = `detail-section-${Math.random().toString(36).slice(2)}`;

    render() {
        if (this.adminOnly && !this.isAdmin) return nothing;
        return html`
            <button type="button" aria-expanded=${this.expanded ? "true" : "false"} aria-controls=${this._bodyId}
                @click=${() => { this.expanded = !this.expanded; this.dispatchEvent(new CustomEvent("expanded-changed", { detail: this.expanded })); }}>
                <ha-icon .icon=${this.icon}></ha-icon><span class="title">${this.title}</span>
                <span class="summary"><slot name="summary"></slot></span>
                <ha-icon class="chevron ${this.expanded ? "open" : ""}" icon="mdi:chevron-down"></ha-icon>
            </button>
            <div id=${this._bodyId} class="body" ?hidden=${!this.expanded}><slot></slot></div>
        `;
    }
}
