import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";

/**
 * A section summary from a translated template, its values in bold (rule R4).
 * Each " · " part is one unbreakable unit: a narrow header wraps only between them.
 */
export function boldTemplate(template: string, values: Record<string, string | number>): TemplateResult {
    const bold = (text: string) => text.split(/(\{\w+\})/).map((part) => {
        const key = /^\{(\w+)\}$/.exec(part)?.[1];
        return key !== undefined && key in values ? html`<b>${values[key]}</b>` : part;
    });
    const units = template.split(" · ");
    return units.length === 1 ? html`${bold(template)}` : unbrokenUnits(units.map(bold));
}

/** Parts joined with " · ", each one unbreakable unit: a narrow header wraps only between them. */
export function unbrokenUnits(units: readonly unknown[]): TemplateResult {
    return html`${units.map((unit, index) => html`${index ? " · " : ""}<span style="white-space: nowrap">${unit}</span>`)}`;
}

/**
 * A section with a summary in its header, `data-<kind>` on it and on its
 * body; the body is rendered only while it is open.
 */
export function renderSummarySection(
    kind: "history" | "forecast",
    icon: string,
    title: string,
    summary: TemplateResult | string,
    open: boolean,
    toggle: (open: boolean) => void,
    body: () => TemplateResult,
): TemplateResult {
    const history = kind === "history";
    return html`
        <helman-detail-section ?data-history=${history} ?data-forecast=${!history} .icon=${icon} .title=${title}
            .expanded=${open} @expanded-changed=${(event: CustomEvent<boolean>) => toggle(event.detail)}>
            <span slot="summary">${summary}</span>
            ${open ? html`<div class="content" ?data-history-body=${history} ?data-forecast-body=${!history}>${body()}</div>` : nothing}
        </helman-detail-section>
    `;
}

@customElement("helman-detail-section")
export class HelmanDetailSection extends LitElement {
    static styles = css`
        :host { display: block; border-top: 1px solid var(--divider-color); }
        :host([hidden]) { display: none; }
        button { box-sizing: border-box; display: flex; align-items: center; gap: 12px; width: 100%; min-height: 52px;
            padding: 14px var(--ha-space-6, 24px); border: 0; background: none; color: var(--primary-text-color);
            font: inherit; text-align: start; cursor: pointer; }
        button:hover { background: var(--secondary-background-color); }
        button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: -2px; }
        ha-icon { flex: none; --mdc-icon-size: 20px; color: var(--primary-text-color); }
        .title { font-size: 15px; font-weight: var(--ha-font-weight-medium, 500); white-space: nowrap; }
        .summary { flex: 1; min-width: 0; text-align: end; font-size: 13px; color: var(--primary-text-color); }
        .chevron { --mdc-icon-size: 16px; color: var(--secondary-text-color); transition: transform 0.2s; }
        .chevron.open { transform: rotate(90deg); }
        .body { padding: 0 var(--ha-space-6, 24px) var(--ha-space-5, 20px); }
    `;

    @property() public icon = "mdi:calendar-month-outline";
    @property() public title = "";
    @property({ type: Boolean, reflect: true }) public expanded = false;
    @property({ type: Boolean, attribute: "admin-only" }) public adminOnly = false;
    @property({ type: Boolean, attribute: false }) public isAdmin = false;
    private readonly _bodyId = `detail-section-${Math.random().toString(36).slice(2)}`;

    /** An admin-only section is not there at all for anyone else, its divider included. */
    willUpdate(): void {
        this.hidden = this.adminOnly && !this.isAdmin;
    }

    render() {
        if (this.hidden) return nothing;
        return html`
            <button type="button" aria-expanded=${this.expanded ? "true" : "false"} aria-controls=${this._bodyId}
                @click=${() => { this.expanded = !this.expanded; this.dispatchEvent(new CustomEvent("expanded-changed", { detail: this.expanded })); }}>
                <ha-icon .icon=${this.icon}></ha-icon><span class="title">${this.title}</span>
                <span class="summary"><slot name="summary"></slot></span>
                <ha-icon class="chevron ${this.expanded ? "open" : ""}" icon="mdi:chevron-right"></ha-icon>
            </button>
            <div id=${this._bodyId} class="body" ?hidden=${!this.expanded}><slot></slot></div>
        `;
    }
}
