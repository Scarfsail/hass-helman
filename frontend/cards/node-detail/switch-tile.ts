import { LitElement, css, html, unsafeCSS, type PropertyValues } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import { loadHaEntityToggle } from "../shared/load-ha-elements";
import { dispatchWatchedEntities } from "../shared/hass-change";
import { openMoreInfo } from "./node-detail-readings";
import { isSwitchOn } from "../shared/config/devices";

/** The colour a switched-on device is shown in: HA's own switch-on colour. */
export const SWITCH_ON_COLOR = unsafeCSS("var(--state-switch-on-color, var(--amber-color, #ffc107))");

@customElement("helman-switch-tile")
export class HelmanSwitchTile extends LitElement {
    static styles = css`
        button { --tile-on: ${SWITCH_ON_COLOR};
            box-sizing: border-box; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
            width: 64px; height: 64px; border: 1.5px solid var(--divider-color); border-radius: 14px; background: var(--secondary-background-color);
            color: var(--secondary-text-color); font: inherit; font-size: 12px; font-weight: var(--ha-font-weight-medium, 500);
            cursor: pointer; touch-action: manipulation; user-select: none; transition: box-shadow 0.2s, background 0.2s; }
        button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        button.on { border: 2px solid var(--tile-on); color: var(--tile-on); box-shadow: 0 0 16px color-mix(in srgb, var(--tile-on) 55%, transparent);
            background: color-mix(in srgb, var(--tile-on) 12%, var(--card-background-color)); }
        button.on ha-state-icon { --state-switch-active-color: var(--tile-on); color: var(--tile-on); }
        ha-icon, ha-state-icon { --mdc-icon-size: 24px; }
        .label { display: block; }
        .label::first-letter { text-transform: uppercase; }
    `;
    @property({ attribute: false }) public hass!: HomeAssistant;
    @property() public entityId = "";
    @property() public fallbackIcon = "mdi:power-plug";
    @property() public kind: "switch" | "climate" = "switch";
    @property({ attribute: false }) public localize!: (key: string) => string;
    private _holdTimer?: ReturnType<typeof setTimeout>;
    private _held = false;
    connectedCallback(): void { super.connectedCallback(); void loadHaEntityToggle().then(() => this.requestUpdate()); }
    disconnectedCallback(): void { super.disconnectedCallback(); this._clearHold(); }
    protected updated(changed: PropertyValues<this>): void {
        if (changed.has("entityId")) dispatchWatchedEntities(this, "node-detail:switch-tile", [this.entityId]);
    }
    private _clearHold(): void { if (this._holdTimer) clearTimeout(this._holdTimer); this._holdTimer = undefined; }
    private _down(): void { this._held = false; this._clearHold(); this._holdTimer = setTimeout(() => { this._held = true; openMoreInfo(this, this.entityId); }, 500); }
    private _up(): void { this._clearHold(); }
    private _activate(): void {
        if (this._held) { this._held = false; return; }
        if (this.kind === "climate") { openMoreInfo(this, this.entityId); return; }
        const state = this.hass.states[this.entityId]?.state;
        const on = isSwitchOn(state);
        if (!on && state !== "off") return;
        void this.hass.callWS({ type: "call_service", domain: this.entityId.split(".", 1)[0], service: on ? "turn_off" : "turn_on", service_data: { entity_id: this.entityId } });
    }
    render() {
        const state = this.hass?.states[this.entityId];
        const on = isSwitchOn(state?.state);
        const label = this.kind === "climate" ? (state?.state ?? "—") : this.localize(`node_detail.control.${on ? "on" : "off"}`);
        return html`<button type="button" class=${on ? "on" : ""} aria-pressed=${this.kind === "switch" ? String(on) : "false"}
            @pointerdown=${this._down} @pointerup=${this._up} @pointercancel=${this._up}
            @contextmenu=${(event: Event) => event.preventDefault()} @click=${this._activate}>
            ${state && customElements.get("ha-state-icon") ? html`<ha-state-icon .hass=${this.hass} .stateObj=${state}></ha-state-icon>`
                : html`<ha-icon .icon=${this.fallbackIcon}></ha-icon>`}<span class="label">${label}</span>
        </button>`;
    }
}
