import { LitElement, css, html, nothing } from "lit";
import type { TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { mdiInformationOutline } from "@mdi/js";
import { getLocalizeFunction } from "../cards/shared/config/localize/localize";
import { renderSvgIcon } from "../cards/shared/config/form-fields";

/**
 * An explanation clamped to two lines, with Show more when it is longer.
 *
 * Whether the text overflows is only known once it is laid out, and changes
 * with the panel's width, so it is measured on every resize of the text while
 * clamped. Expanded, the last measurement stands: Show less is still needed.
 */
export class HelmanInfoCallout extends LitElement {
  @property({ attribute: false }) hass: any;
  @property() text = "";

  @state() private _expanded = false;
  @state() private _overflows = false;

  private get _textElement(): HTMLElement | null {
    return this.renderRoot?.querySelector<HTMLElement>(".text") ?? null;
  }

  private _resizeObserver = new ResizeObserver(() => this._measure());

  static styles = css`
    :host {
      display: block;
    }

    .callout {
      display: flex;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 6px;
      border-left: 3px solid rgb(var(--rgb-info-color, 3, 155, 229));
      background: rgba(var(--rgb-info-color, 3, 155, 229), 0.1);
      color: var(--primary-text-color);
      font-size: 0.9rem;
    }

    .icon {
      flex-shrink: 0;
      width: 20px;
      height: 20px;
      fill: rgb(var(--rgb-info-color, 3, 155, 229));
    }

    .body {
      min-width: 0;
    }

    .text {
      margin: 0;
    }

    .text.clamped {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      overflow: hidden;
    }

    .toggle {
      margin-top: 4px;
      padding: 0;
      border: none;
      background: none;
      color: var(--primary-color);
      font: inherit;
      font-weight: 500;
      cursor: pointer;
    }
  `;

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._resizeObserver.disconnect();
  }

  protected firstUpdated(): void {
    if (this._textElement) this._resizeObserver.observe(this._textElement);
  }

  connectedCallback(): void {
    super.connectedCallback();
    // Reattached after a disconnect: observe the same text element again.
    if (this._textElement) this._resizeObserver.observe(this._textElement);
  }

  protected updated(): void {
    this._measure();
  }

  private _measure(): void {
    const element = this._textElement;
    if (!element || this._expanded) return;
    const overflows = element.scrollHeight > element.clientHeight + 1;
    if (overflows !== this._overflows) this._overflows = overflows;
  }

  render(): TemplateResult {
    const t = getLocalizeFunction(this.hass ?? undefined);
    return html`
      <div class="callout">
        ${renderSvgIcon(mdiInformationOutline, "icon")}
        <div class="body">
          <p class=${this._expanded ? "text" : "text clamped"}>${this.text}</p>
          ${this._overflows
            ? html`<button
                type="button"
                class="toggle"
                aria-expanded=${this._expanded}
                @click=${() => (this._expanded = !this._expanded)}
              >
                ${t(this._expanded ? "editor.actions.show_less" : "editor.actions.show_more")}
              </button>`
            : nothing}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "helman-info-callout": HelmanInfoCallout;
  }
}

if (!customElements.get("helman-info-callout")) {
  customElements.define("helman-info-callout", HelmanInfoCallout);
}
