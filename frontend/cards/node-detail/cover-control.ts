import { LitElement, css, html, type PropertyValues, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import type { LocalizeFunction } from "../localize/localize";
import { dispatchWatchedEntities } from "../shared/hass-change";

export const COVER_FEATURE_OPEN = 1;
export const COVER_FEATURE_CLOSE = 2;
export const COVER_FEATURE_STOP = 8;

@customElement("helman-cover-control")
export class HelmanCoverControl extends LitElement {
    static styles = css`
        :host {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .status-row {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 13px;
            color: var(--secondary-text-color);
        }
        .status-badge {
            font-weight: var(--ha-font-weight-medium, 500);
            color: var(--primary-text-color);
        }
        .status-badge::first-letter {
            text-transform: uppercase;
        }
        .actions-row {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
        }
        button.action {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 8px 14px;
            border: 1px solid var(--divider-color);
            border-radius: 8px;
            background: var(--secondary-background-color);
            color: var(--primary-text-color);
            font: inherit;
            font-size: 13px;
            font-weight: var(--ha-font-weight-medium, 500);
            cursor: pointer;
            touch-action: manipulation;
            user-select: none;
            transition: background 0.2s, border-color 0.2s;
        }
        button.action:hover:not(:disabled) {
            background: color-mix(in srgb, var(--primary-color) 12%, var(--secondary-background-color));
            border-color: var(--primary-color);
        }
        button.action:focus-visible {
            outline: 2px solid var(--primary-color);
            outline-offset: 2px;
        }
        button.action:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        ha-icon {
            --mdc-icon-size: 18px;
        }
        .error {
            margin: 4px 0 0;
            color: var(--error-color, #c62828);
            font-size: 12px;
            line-height: 1.4;
        }
    `;

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property() public entityId = "";
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @state() private _actionError: string | null = null;

    protected updated(changed: PropertyValues<this>): void {
        if (changed.has("entityId")) {
            dispatchWatchedEntities(this, "node-detail:cover-control", [this.entityId]);
        }
    }

    private async _callAction(service: "open_cover" | "close_cover" | "stop_cover"): Promise<void> {
        this._actionError = null;
        try {
            await this.hass.callWS({
                type: "call_service",
                domain: "cover",
                service,
                service_data: { entity_id: this.entityId },
            });
        } catch (error) {
            this._actionError =
                error instanceof Error
                    ? error.message
                    : typeof error === "object" && error && "message" in error
                    ? String((error as any).message)
                    : String(error);
        }
    }

    render() {
        const stateObj = this.hass?.states[this.entityId];
        const rawState = stateObj?.state;
        const isUnavailable = !stateObj || rawState === "unavailable";
        const supportedFeatures = (stateObj?.attributes?.supported_features as number | undefined) ?? 0;

        const supportsOpen = (supportedFeatures & COVER_FEATURE_OPEN) !== 0;
        const supportsClose = (supportedFeatures & COVER_FEATURE_CLOSE) !== 0;
        const supportsStop = (supportedFeatures & COVER_FEATURE_STOP) !== 0;

        const statusKey = isUnavailable
            ? "state_unavailable"
            : rawState === "unknown"
            ? "state_unknown"
            : rawState === "open"
            ? "state_open"
            : rawState === "closed"
            ? "state_closed"
            : rawState === "opening"
            ? "state_opening"
            : rawState === "closing"
            ? "state_closing"
            : null;

        const statusLabel = statusKey
            ? this.localize(`node_detail.cover.${statusKey}`) || rawState
            : rawState ?? "—";

        return html`
            <div class="status-row" data-cover-status>
                <span>${this.localize("node_detail.cover.status_title")}:</span>
                <span class="status-badge" data-cover-state=${rawState ?? "unavailable"}>${statusLabel}</span>
            </div>
            <div class="actions-row">
                ${supportsOpen
                    ? html`<button
                          type="button"
                          class="action"
                          data-action="open"
                          ?disabled=${isUnavailable}
                          @click=${() => this._callAction("open_cover")}
                      >
                          <ha-icon icon="mdi:arrow-up"></ha-icon>
                          <span>${this.localize("node_detail.cover.open")}</span>
                      </button>`
                    : nothing}
                ${supportsStop
                    ? html`<button
                          type="button"
                          class="action"
                          data-action="stop"
                          ?disabled=${isUnavailable}
                          @click=${() => this._callAction("stop_cover")}
                      >
                          <ha-icon icon="mdi:stop"></ha-icon>
                          <span>${this.localize("node_detail.cover.stop")}</span>
                      </button>`
                    : nothing}
                ${supportsClose
                    ? html`<button
                          type="button"
                          class="action"
                          data-action="close"
                          ?disabled=${isUnavailable}
                          @click=${() => this._callAction("close_cover")}
                      >
                          <ha-icon icon="mdi:arrow-down"></ha-icon>
                          <span>${this.localize("node_detail.cover.close")}</span>
                      </button>`
                    : nothing}
            </div>
            ${this._actionError
                ? html`<p class="error" role="alert" data-error>${this._actionError}</p>`
                : nothing}
        `;
    }
}
