import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import type { LocalizeFunction } from "../localize/localize";
import { dispatchWatchedEntities } from "../shared/hass-change";
import { loadHaEntityToggle } from "../shared/load-ha-elements";
import { entityName, openMoreInfo, readingText } from "./node-detail-readings";
import { nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";

/**
 * Home Assistant's own controls of a device Helman does not schedule: its
 * switch as HA's entity toggle, and its climate entity's more-info. Each
 * name opens its entity's more-info. Nothing here is a plan: no ownership,
 * no automation, no bounded hold. A device Helman schedules gets only its
 * climate entity's more-info here, beside its lanes.
 */
@customElement("helman-device-direct-control")
export class HelmanDeviceDirectControl extends LitElement {
    static styles = [nodeDetailSharedStyles, nodeDetailQuestionStyles, css`
        .control {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            min-height: 40px;
        }
        .control .reading {
            text-align: left;
            min-width: 0;
            overflow-wrap: anywhere;
        }
    `];

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    /** The switch HA's toggle drives; `null` for none. */
    @property({ attribute: false }) public switchEntityId: string | null = null;
    /** The climate entity whose more-info is offered; `null` for none. */
    @property({ attribute: false }) public climateEntityId: string | null = null;
    /** Beside a scheduled device's lanes: no note that Helman does not schedule it. */
    @property({ attribute: false }) public scheduled = false;

    /** HA's entity toggle is defined; until then, or if it fails to load, the switch's state is text. */
    @state() private _toggleReady = !!customElements.get("ha-entity-toggle");

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
            <div class="content" data-direct-control>
                ${this.scheduled ? nothing : html`<p class="note" data-direct-note>${this.localize("node_detail.control.direct_note")}</p>`}
                ${switchId ? html`
                    <div class="control" data-switch>
                        <button class="reading" data-entity=${switchId} @click=${() => openMoreInfo(this, switchId)}>${entityName(this.hass, switchId)}</button>
                        ${this._toggleReady
                            ? html`<ha-entity-toggle .hass=${this.hass} .stateObj=${this.hass.states[switchId]}></ha-entity-toggle>`
                            : html`<span class="value" data-switch-state>${this._reading(switchId)}</span>`}
                    </div>
                ` : nothing}
                ${climateId ? html`
                    <div class="control" data-climate>
                        <button class="reading" data-entity=${climateId} @click=${() => openMoreInfo(this, climateId)}>${entityName(this.hass, climateId)}</button>
                        <span class="value">${this._reading(climateId)}</span>
                    </div>
                ` : nothing}
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
