import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";

@customElement("helman-help-tip")
export class HelmanHelpTip extends LitElement {
    static styles = css`
        :host { display: inline-block; position: relative; vertical-align: middle; margin: -4px 0 -4px 4px;
            font-size: 12px; font-weight: 400; letter-spacing: 0; text-transform: none; line-height: 1.45; }
        button { width: 24px; height: 24px; display: grid; place-items: center; border: 0; background: none;
            color: var(--secondary-text-color); cursor: pointer; padding: 0; }
        .mark { box-sizing: border-box; width: 16px; height: 16px; border: 1.5px solid var(--secondary-text-color); border-radius: 50%;
            display: grid; place-items: center; color: var(--primary-text-color); font-size: 10px; font-weight: 700; }
        button:hover .mark, button:focus-visible .mark { border-color: var(--primary-color); color: var(--primary-color); }
        button:focus-visible { outline: none; }
        .popup.flip { inset-inline-start: auto; inset-inline-end: -6px; }
        .popup { position: absolute; z-index: 5; inset-inline-start: -6px; top: 26px; width: max-content; max-width: min(280px, calc(100vw - 32px));
            padding: 10px 12px; border-radius: 10px; background: var(--card-background-color); border: 1px solid var(--divider-color);
            color: var(--primary-text-color); box-shadow: 0 6px 20px #0006; text-align: start; white-space: normal; }
    `;
    @property() public explanation = "";
    @state() private _open = false;
    @state() private _flip = false;
    private _pinned = false;
    private readonly _id = `help-${Math.random().toString(36).slice(2)}`;
    connectedCallback(): void { super.connectedCallback(); window.addEventListener("keydown", this._escape); window.addEventListener("helman-help-open", this._other); }
    disconnectedCallback(): void { super.disconnectedCallback(); window.removeEventListener("keydown", this._escape); window.removeEventListener("helman-help-open", this._other); }
    private _escape = (event: KeyboardEvent) => { if (event.key === "Escape") { this._open = false; this._pinned = false; } };
    private _other = (event: Event) => { if ((event as CustomEvent).detail === this) return; this._open = false; this._pinned = false; };
    private _show(): void { window.dispatchEvent(new CustomEvent("helman-help-open", { detail: this })); this._open = true; void this._fit(); }
    /** Pin the popup to the "?" end instead when its start-aligned box would leave the viewport. */
    private async _fit(): Promise<void> {
        this._flip = false;
        await this.updateComplete;
        const box = this.renderRoot.querySelector(".popup")?.getBoundingClientRect();
        if (box && (box.right > window.innerWidth - 8 || box.left < 8)) this._flip = true;
    }
    private _click(): void { this._pinned = !this._pinned; if (this._pinned) this._show(); else this._open = false; }
    render() { return html`<button type="button" aria-label=${this.explanation} aria-describedby=${this._id}
        @mouseenter=${this._show} @focus=${this._show} @mouseleave=${() => { if (!this._pinned) this._open = false; }}
        @click=${this._click}><span class="mark">?</span></button>
        <span id=${this._id} class="popup ${this._flip ? "flip" : ""}" role="tooltip" ?hidden=${!this._open}>${this.explanation}</span>`; }
}
