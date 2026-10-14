import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { mdiCurrentAc } from "@mdi/js";
import type { HomeAssistant } from "../../types/ha";
import { fillTemplate, type LocalizeFunction } from "../localize/localize";
import { type InverterDetailPayload, commandedModeKind } from "../helman-api";

const LINK_ENTITY_KEYS = ["link_success_rate", "link_quarantined_registers"];

/** The entities the cell reads, for a card that filters `hass` down to what it watches. */
export function inverterCellEntityIds(inverter: InverterDetailPayload | null): string[] {
    if (!inverter) return [];
    const ids = LINK_ENTITY_KEYS.map((key) => inverter.entities[key]).filter((id): id is string => !!id);
    if (inverter.mode) ids.push(inverter.mode.entityId);
    return ids;
}

/**
 * The inverter's entry point, drawn where the flows meet: its commanded mode
 * and, when the link is short of perfect, a neutral communication cue with its
 * value. Not a fault verdict: the detail's trust question explains it.
 * Activating it fires `show-node-detail` for the inverter; the host positions it.
 */
@customElement("helman-inverter-cell")
export class HelmanInverterCell extends LitElement {
    @property({ attribute: false }) public hass?: HomeAssistant;
    @property({ attribute: false }) public localize?: LocalizeFunction;
    @property({ attribute: false }) public inverter: InverterDetailPayload | null = null;

    static styles = css`
        :host {
            display: block;
        }
        .inverter-cell {
            display: flex;
            align-items: center;
            gap: 3px;
            min-height: 26px;
            padding: 2px 7px 2px 5px;
            border: 1px solid var(--divider-color, rgba(0, 0, 0, 0.12));
            border-radius: 13px;
            background: var(--card-background-color, #fff);
            color: var(--primary-text-color);
            font: inherit;
            font-size: 0.68rem;
            font-weight: 600;
            white-space: nowrap;
            cursor: pointer;
        }
        .inverter-cell:focus-visible {
            outline: 2px solid var(--primary-color);
            outline-offset: 1px;
        }
        .inverter-cell svg {
            width: 16px;
            height: 16px;
            fill: var(--secondary-text-color);
            flex: none;
        }
        .inverter-link {
            font-weight: 400;
            color: var(--secondary-text-color);
        }
    `;

    render() {
        const inverter = this.inverter;
        if (!inverter?.configured || !this.localize) return "";
        const states = this.hass?.states ?? {};
        const live = inverter.mode ? states[inverter.mode.entityId]?.state : undefined;
        const kind = commandedModeKind(inverter.mode, states);
        const label = kind
            ? this.localize(`node_detail.inverter.mode_short.${kind}`)
            : live && live !== "unavailable" && live !== "unknown" ? live : "–";
        const number = (key: string): number | null => {
            const entityId = inverter.entities[key];
            const value = entityId ? parseFloat(states[entityId]?.state ?? "") : NaN;
            return Number.isFinite(value) ? value : null;
        };
        const rate = number("link_success_rate");
        const quarantined = number("link_quarantined_registers");
        const cue = rate !== null && rate < 100
            // Rounded down to one decimal, so 99.97 never reads as 100.
            ? String(Math.floor(rate * 10) / 10) + " %"
            : quarantined !== null && quarantined > 0 ? String(quarantined) : null;
        const ariaLabel = fillTemplate(this.localize("node_detail.inverter.cell_label"), { mode: label })
            + (cue ? ". " + fillTemplate(this.localize("node_detail.inverter.link_cue"), { value: cue }) : "");
        return html`
            <button
                class="inverter-cell"
                aria-label=${ariaLabel}
                title=${ariaLabel}
                @click=${this._onClick}
            >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d=${mdiCurrentAc}></path></svg>
                <span class="inverter-mode">${label}</span>
                ${cue ? html`<span class="inverter-link">${cue}</span>` : ""}
            </button>
        `;
    }

    private _onClick(event: Event): void {
        event.stopPropagation();
        this.dispatchEvent(new CustomEvent("show-node-detail", {
            bubbles: true,
            composed: true,
            detail: { nodeType: "inverter" },
        }));
    }
}
