import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import type { LocalizeFunction } from "../localize/localize";
import { dispatchWatchedEntities } from "../shared/hass-change";
import { loadHaEntityToggle } from "../shared/load-ha-elements";
import { entityName, openMoreInfo, readingText } from "./node-detail-readings";
import { nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";

/**
 * Home Assistant's own controls at the top of a device's Overview: its
 * switch as HA's entity toggle, and its climate entity's more-info. Each
 * label opens its entity's more-info. Nothing here is a plan: no ownership,
 * no automation, no bounded hold.
 */
@customElement("helman-device-direct-control")
export class HelmanDeviceDirectControl extends LitElement {
    static styles = [nodeDetailSharedStyles, nodeDetailQuestionStyles, css`
        .control {
            display: flex;
            align-items: center;
            gap: 12px;
            min-height: 40px;
        }
        .summary-slot {
            min-width: 0;
        }
        .summary-slot::slotted(*) {
            max-width: 100%;
        }
        .control .reading {
            text-align: left;
            min-width: 0;
            overflow-wrap: anywhere;
        }
        .entity {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            margin-inline-start: auto;
        }
        .control-label {
            color: var(--secondary-text-color);
            white-space: nowrap;
            border: 0;
            background: none;
            padding: 0;
            font: inherit;
            cursor: pointer;
        }
        .control-label:focus-visible {
            outline: 2px solid var(--primary-color);
            outline-offset: 2px;
        }
        @media (max-width: 400px) {
            .control { gap: 6px; }
            .entity { gap: 4px; }
        }
    `];

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    /** The switch HA's toggle drives; `null` for none. */
    @property({ attribute: false }) public switchEntityId: string | null = null;
    /** The climate entity whose more-info is offered; `null` for none. */
    @property({ attribute: false }) public climateEntityId: string | null = null;
    /** Show the schedule reminder when Helman can plan this device. */
    @property({ attribute: false }) public scheduled = false;

    /** HA's entity elements are defined; until then, the switch's state is text. */
    @state() private _toggleReady = !!customElements.get("ha-entity-toggle") && !!customElements.get("ha-state-icon");

    connectedCallback(): void {
        super.connectedCallback();
        loadHaEntityToggle()
            .then(() => { this._toggleReady = true; })
            .catch((error) => console.error("device-direct-control: failed to load HA's entity toggle", error));
    }

    protected updated(changed: Map<string, unknown>): void {
        super.updated(changed);
        if (changed.has("switchEntityId") || changed.has("climateEntityId")) {
            dispatchWatchedEntities(this, "node-detail:direct-control", [this.switchEntityId, this.climateEntityId]);
        }
    }

    render() {
        const switchId = this.switchEntityId;
        const climateId = this.climateEntityId;
        return html`
            <div data-direct-control>
                ${switchId ? html`
                    <div class="control" data-switch>
                        <slot class="summary-slot"></slot>
                        <div class="entity">
                            <button class="control-label" data-entity=${switchId} @click=${() => openMoreInfo(this, switchId)}>${this.localize("node_detail.control.direct_label")}</button>
                            ${this._toggleReady
                                ? html`<ha-entity-toggle .hass=${this.hass} .stateObj=${this.hass.states[switchId]}></ha-entity-toggle>`
                                : html`<span class="value" data-switch-state>${this._reading(switchId)}</span>`}
                        </div>
                    </div>
                ` : nothing}
                ${climateId ? html`
                    <div class="control" data-climate>
                        ${switchId ? nothing : html`<slot class="summary-slot"></slot>`}
                        <div class="entity">
                            ${this._toggleReady ? html`<ha-state-icon .hass=${this.hass} .stateObj=${this.hass.states[climateId]}></ha-state-icon>` : nothing}
                            <button class="reading" data-entity=${climateId} @click=${() => openMoreInfo(this, climateId)}>${entityName(this.hass, climateId)}</button>
                        </div>
                        <span class="value">${this._reading(climateId)}</span>
                    </div>
                ` : nothing}
                ${this.scheduled ? html`<p class="note" data-scheduled-note>${this.localize("node_detail.control.scheduled_note")}</p>` : nothing}
            </div>
        `;
    }

    /** The entity's state as a node detail reads it. */
    private _reading(entityId: string): string {
        return readingText(this.hass, entityId, (on) => this.localize(`node_detail.control.${on ? "on" : "off"}`))
            ?? this.localize("node_detail.control.unavailable");
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-device-direct-control": HelmanDeviceDirectControl;
    }
}
