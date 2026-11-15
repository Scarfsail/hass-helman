import { LitElement, css, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import type { LocalizeFunction } from "../localize/localize";
import { isReadableState } from "../shared/power-reading";
import { evModeLabel } from "./node-detail-utils";
import "./option-segments";

/**
 * The EV charger's use mode and, in ECO, its eco gear, as segmented buttons
 * that set the charger's selects. The pressed button follows the live state.
 * While a plan window sets the mode, `lockedCaption` disables both rows and
 * says why: the executor would revert a hand-set mode.
 */
@customElement("helman-ev-mode-control")
export class HelmanEvModeControl extends LitElement {
    static styles = css`
        :host { display: flex; flex-direction: column; gap: 8px; }
        .title { font-size: 13px; color: var(--secondary-text-color); }
        .caption { margin: 0; font-size: 12px; color: var(--secondary-text-color); }
    `;

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public useModeEntityId = "";
    @property({ attribute: false }) public ecoGearEntityId: string | null = null;
    @property({ attribute: false }) public useModes: string[] = [];
    @property({ attribute: false }) public ecoGears: string[] = [];
    /** Why the plan holds the mode, which disables both rows; `null` while no window sets it. */
    @property({ attribute: false }) public lockedCaption: string | null = null;

    private _row(entityId: string, options: string[], label: (option: string) => string, kind: string) {
        return html`<helman-option-segments data-ev-mode-row=${kind} .hass=${this.hass} .entityId=${entityId}
            .options=${options} .label=${label} .disabled=${this.lockedCaption !== null}></helman-option-segments>`;
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
        `;
    }
}
