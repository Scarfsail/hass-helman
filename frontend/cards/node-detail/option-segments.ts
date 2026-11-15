import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import { describeError } from "../shared/describe-error";
import { isReadableState } from "../shared/power-reading";
import { nodeDetailActionButtonStyles } from "./node-detail-shared-styles";

/**
 * One select entity's options as a single row of segmented buttons. The
 * pressed button follows the live state; a click picks the option through the
 * entity's own domain, and a failed pick is said under the row. The row is
 * disabled while the entity is unreadable, or when the caller says so.
 */
@customElement("helman-option-segments")
export class HelmanOptionSegments extends LitElement {
    static styles = [nodeDetailActionButtonStyles, css`
        :host { display: flex; flex-direction: column; gap: 8px; }
        .segments { display: flex; flex-wrap: wrap; gap: 8px; }
        button.action[aria-pressed="true"] {
            border-color: var(--primary-color); color: var(--primary-color);
            background: color-mix(in srgb, var(--primary-color) 12%, var(--secondary-background-color));
        }
        .error { margin: 0; color: var(--error-color, #c62828); font-size: 12px; line-height: 1.4; }
    `];

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public entityId = "";
    @property({ attribute: false }) public options: string[] = [];
    @property({ attribute: false }) public label: (option: string) => string = (option) => option;
    @property({ attribute: false }) public disabled = false;
    @state() private _actionError: string | null = null;

    private async _select(option: string): Promise<void> {
        if (this.hass.states[this.entityId]?.state === option) return;
        this._actionError = null;
        try {
            await this.hass.callWS({ type: "call_service", domain: this.entityId.split(".")[0], service: "select_option", service_data: { entity_id: this.entityId, option } });
        } catch (error) {
            this._actionError = describeError(error);
        }
    }

    render() {
        const live = this.hass.states[this.entityId]?.state;
        const disabled = this.disabled || !isReadableState(live);
        return html`
            <div class="segments" role="group">
                ${this.options.map((option) => html`<button type="button" class="action" data-option=${option} aria-pressed=${String(option === live)}
                    ?disabled=${disabled} @click=${() => this._select(option)}>${this.label(option)}</button>`)}
            </div>
            ${this._actionError ? html`<p class="error" role="alert" data-error>${this._actionError}</p>` : nothing}
        `;
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-option-segments": HelmanOptionSegments;
    }
}
