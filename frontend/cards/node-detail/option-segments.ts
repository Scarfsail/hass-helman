import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import type { HomeAssistant } from "../../types/ha";
import { describeError } from "../shared/describe-error";
import { isReadableState } from "../shared/power-reading";

/** Up to this many options fit one segmented bar; more are a dropdown. */
export const MAX_SEGMENTS = 3;

/**
 * One select entity's options on a single line: a segmented bar while they
 * fit, a dropdown named `name` when there are more. The picked option
 * follows the live state; a pick sets the option through the entity's own
 * domain, and a failed pick is said under the line. The picker is disabled
 * while the entity is unreadable, or when the caller says so.
 */
@customElement("helman-option-segments")
export class HelmanOptionSegments extends LitElement {
    static styles = css`
        :host { display: flex; flex-direction: column; gap: 8px; }
        .segments { display: flex; border: 1px solid var(--divider-color); border-radius: 8px; overflow: hidden; }
        .segments button { flex: 1 1 0; min-width: 0; min-height: 36px; padding: 6px 10px; border: 0; border-radius: 0;
            background: none; color: var(--primary-text-color); font: inherit; font-size: 13px; font-weight: var(--ha-font-weight-medium, 500);
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; touch-action: manipulation; }
        .segments button + button { border-left: 1px solid var(--divider-color); }
        .segments button[aria-pressed="true"] { color: var(--primary-color);
            background: color-mix(in srgb, var(--primary-color) 18%, transparent); }
        .segments button:hover:not(:disabled):not([aria-pressed="true"]) { background: color-mix(in srgb, var(--primary-text-color) 6%, transparent); }
        .dropdown { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 38px;
            padding: 0 10px; border: 1px solid var(--divider-color); border-radius: 8px; background: var(--card-background-color); font-size: 14px; }
        .dropdown .name { flex: none; font-weight: 600; }
        .dropdown select { min-width: 0; padding: 8px 0; border: 0; background: none; color: inherit; font: inherit;
            font-weight: 600; text-align: end; cursor: pointer; }
        .dropdown select option { background: var(--card-background-color); color: var(--primary-text-color); }
        button:focus-visible, select:focus-visible { outline: 2px solid var(--primary-color); outline-offset: -2px; }
        button:disabled, select:disabled { opacity: 0.5; cursor: not-allowed; }
        .error { margin: 0; color: var(--error-color, #c62828); font-size: 12px; line-height: 1.4; }
    `;

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public entityId = "";
    @property({ attribute: false }) public options: string[] = [];
    @property({ attribute: false }) public label: (option: string) => string = (option) => option;
    /** What the options set, as the dropdown names it. */
    @property({ attribute: false }) public name = "";
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
        // A refused pick shows the live option again.
        this.requestUpdate();
    }

    render() {
        const current = this.hass.states[this.entityId]?.state;
        const disabled = this.disabled || !isReadableState(current);
        return html`
            ${this.options.length <= MAX_SEGMENTS ? html`<div class="segments" role="group">
                ${this.options.map((option) => html`<button type="button" data-option=${option} aria-pressed=${String(option === current)}
                    ?disabled=${disabled} @click=${() => this._select(option)}>${this.label(option)}</button>`)}
            </div>` : html`<label class="dropdown"><span class="name">${this.name}</span>
                <select data-dropdown .value=${live(current ?? "")} ?disabled=${disabled}
                    @change=${(event: Event) => this._select((event.currentTarget as HTMLSelectElement).value)}>
                    ${current !== undefined && this.options.includes(current) ? nothing : html`<option value=${current ?? ""} disabled selected>—</option>`}
                    ${this.options.map((option) => html`<option value=${option} ?selected=${option === current}>${this.label(option)}</option>`)}
                </select></label>`}
            ${this._actionError ? html`<p class="error" role="alert" data-error>${this._actionError}</p>` : nothing}
        `;
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-option-segments": HelmanOptionSegments;
    }
}
