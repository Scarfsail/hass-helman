import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";

@customElement("helman-help-tip")
export class HelmanHelpTip extends LitElement {
    static styles = css`
        :host { display: inline-block; position: relative; vertical-align: middle; }
        button { width: 24px; height: 24px; display: grid; place-items: center; border: 0; background: none;
            color: var(--secondary-text-color); cursor: pointer; padding: 0; }
        .mark { width: 16px; height: 16px; border: 1px solid currentColor; border-radius: 50%;
            display: grid; place-items: center; font-size: 11px; font-weight: 700; }
        .popup { position: absolute; z-index: 5; inset-inline-start: 0; top: 100%; width: max-content; max-width: min(280px, 80vw);
            padding: 8px 10px; border-radius: 6px; background: var(--card-background-color);
            color: var(--primary-text-color); box-shadow: 0 3px 12px #0005; font-size: 0.85rem; }
    `;
    @property() public explanation = "";
    @state() private _open = false;
    private _pinned = false;
    private readonly _id = `help-${Math.random().toString(36).slice(2)}`;
    connectedCallback(): void { super.connectedCallback(); window.addEventListener("keydown", this._escape); window.addEventListener("helman-help-open", this._other); }
    disconnectedCallback(): void { super.disconnectedCallback(); window.removeEventListener("keydown", this._escape); window.removeEventListener("helman-help-open", this._other); }
    private _escape = (event: KeyboardEvent) => { if (event.key === "Escape") { this._open = false; this._pinned = false; } };
    private _other = (event: Event) => { if ((event as CustomEvent).detail === this) return; this._open = false; this._pinned = false; };
    private _show(): void { window.dispatchEvent(new CustomEvent("helman-help-open", { detail: this })); this._open = true; }
    private _click(): void { this._pinned = !this._pinned; if (this._pinned) this._show(); else this._open = false; }
    render() { return html`<button type="button" aria-label=${this.explanation} aria-describedby=${this._id}
        @mouseenter=${this._show} @focus=${this._show} @mouseleave=${() => { if (!this._pinned) this._open = false; }}
        @click=${this._click}><span class="mark">?</span></button>
        <span id=${this._id} class="popup" role="tooltip" ?hidden=${!this._open}>${this.explanation}</span>`; }
}
