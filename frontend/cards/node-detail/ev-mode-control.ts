import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import type { LocalizeFunction } from "../localize/localize";
import { describeError } from "../shared/describe-error";
import { isReadableState } from "../shared/power-reading";
import { nodeDetailActionButtonStyles } from "./node-detail-shared-styles";
import { evModeLabel } from "./node-detail-utils";

/**
 * The EV charger's use mode and, in ECO, its eco gear, as segmented buttons
 * that set the charger's selects. The pressed button follows the live state.
 * While a plan window sets the mode, `lockedCaption` disables both rows and
 * says why: the executor would revert a hand-set mode.
 */
@customElement("helman-ev-mode-control")
export class HelmanEvModeControl extends LitElement {
    static styles = [nodeDetailActionButtonStyles, css`
        :host { display: flex; flex-direction: column; gap: 8px; }
        .title { font-size: 13px; color: var(--secondary-text-color); }
        .segments { display: flex; flex-wrap: wrap; gap: 8px; }
        button.action[aria-pressed="true"] {
            border-color: var(--primary-color); color: var(--primary-color);
            background: color-mix(in srgb, var(--primary-color) 12%, var(--secondary-background-color));
        }
        .caption { margin: 0; font-size: 12px; color: var(--secondary-text-color); }
        .error { margin: 0; color: var(--error-color, #c62828); font-size: 12px; line-height: 1.4; }
    `];

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public useModeEntityId = "";
    @property({ attribute: false }) public ecoGearEntityId: string | null = null;
    @property({ attribute: false }) public useModes: string[] = [];
    @property({ attribute: false }) public ecoGears: string[] = [];
    /** Why the plan holds the mode, which disables both rows; `null` while no window sets it. */
    @property({ attribute: false }) public lockedCaption: string | null = null;
    @state() private _actionError: string | null = null;

    private async _select(entityId: string, option: string): Promise<void> {
        if (this.hass.states[entityId]?.state === option) return;
        this._actionError = null;
        try {
            await this.hass.callWS({ type: "call_service", domain: "select", service: "select_option", service_data: { entity_id: entityId, option } });
        } catch (error) {
            this._actionError = describeError(error);
        }
    }

    private _row(entityId: string, options: string[], label: (option: string) => string, kind: string) {
        const live = this.hass.states[entityId]?.state;
        const disabled = this.lockedCaption !== null || !isReadableState(live);
        return html`<div class="segments" role="group" data-ev-mode-row=${kind}>
            ${options.map((option) => html`<button type="button" class="action" data-option=${option} aria-pressed=${String(option === live)}
                ?disabled=${disabled} @click=${() => this._select(entityId, option)}>${label(option)}</button>`)}
        </div>`;
    }

    render() {
        const useMode = this.hass.states[this.useModeEntityId]?.state;
        const showGears = useMode === "ECO" && !!this.ecoGearEntityId && this.ecoGears.length > 0;
        const offScale = isReadableState(useMode) && !this.useModes.includes(useMode) ? evModeLabel(this.localize, useMode, null) : null;
        return html`
            <div class="title">${this.localize("node_detail.ev_charger.mode.title")}${offScale ? ` · ${offScale}` : nothing}</div>
            ${this._row(this.useModeEntityId, this.useModes, (mode) => evModeLabel(this.localize, mode, null) ?? mode, "use_mode")}
            ${showGears ? this._row(this.ecoGearEntityId!, this.ecoGears, (gear) => gear, "eco_gear") : nothing}
            ${this.lockedCaption === null ? nothing : html`<p class="caption" data-ev-mode-locked>${this.lockedCaption}</p>`}
            ${this._actionError ? html`<p class="error" role="alert" data-error>${this._actionError}</p>` : nothing}
        `;
    }
}
