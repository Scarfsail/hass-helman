import { LitElement, TemplateResult, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { HomeAssistant } from "../hass-frontend/src/types";

/**
 * The state badge for a device's controlling switch.
 *
 * Shared by the power card's device rows and the solar inspector's house
 * composition panel so a device is controlled the same way wherever it appears:
 * the badge shows live switch state and opens that entity's more-info dialog,
 * which is where the actual toggle lives.
 *
 * Emits `show-more-info` rather than HA's `hass-more-info` so hosts can decide
 * what to do with it — the power card already funnels that event through its own
 * handler, and re-emitting the HA event directly would bypass it.
 */
@customElement("helman-appliance-switch-badge")
export class ApplianceSwitchBadge extends LitElement {
    static get styles() {
        return css`
            state-badge {
                cursor: pointer;
                flex-shrink: 0;
                position: relative;
                z-index: 2;
            }
        `;
    }

    @property({ attribute: false }) public hass?: HomeAssistant;
    /** The switch entity to show and control; nothing renders without one. */
    @property({ attribute: false }) public entityId: string | null = null;

    render(): TemplateResult | typeof nothing {
        const stateObj = this.entityId ? this.hass?.states?.[this.entityId] : undefined;
        if (!stateObj) return nothing;
        return html`
            <state-badge
                .hass=${this.hass}
                .stateObj=${stateObj}
                .stateColor=${true}
                @click=${this._fireShowMoreInfo}
            ></state-badge>
        `;
    }

    private _fireShowMoreInfo() {
        if (!this.entityId) return;
        this.dispatchEvent(
            new CustomEvent("show-more-info", {
                bubbles: true,
                composed: true,
                detail: { entityId: this.entityId },
            }),
        );
    }
}
