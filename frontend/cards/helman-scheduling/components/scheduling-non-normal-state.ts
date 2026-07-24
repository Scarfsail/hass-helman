import { LitElement, css, html } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../../hass-frontend/src/types";
import type { ControllableEntityDTO } from "../../helman-api";
import { getSharedHelmanStore } from "../../helman/store";
import type { LocalizeFunction } from "../../localize/localize";
import { schedulingSharedStyles } from "../styles/scheduling-shared-styles";

const UNAVAILABLE_STATES = new Set(["unknown", "unavailable", ""]);

interface NonNormalEntity extends ControllableEntityDTO {
    state: string;
}

/**
 * Lists what Helman left running while execution is disabled.
 *
 * Disabling execution is passive -- the inverter and the appliances stay
 * exactly as they were -- so this section is how the user sees what is still
 * on and decides what to do about it: open any row for the entity's more-info
 * dialog and act on it individually, or use the bulk action to put everything
 * back to rest at once.
 *
 * The controllable-entity list comes from the backend once; which of those are
 * non-normal is derived from live `hass.states` on every update, so the list
 * reacts to state changes without polling. It renders nothing at all when
 * execution is enabled or when everything is already at rest.
 */
@customElement("scheduling-non-normal-state")
export class SchedulingNonNormalState extends LitElement {
    static styles = [
        schedulingSharedStyles,
        css`
            .section {
                margin-top: 12px;
                padding: 8px 0 4px;
                border-top: 1px solid var(--divider-color);
            }

            .section-title {
                color: var(--secondary-text-color);
                font-size: 0.84rem;
                margin-bottom: 6px;
            }

            .entity-row {
                display: flex;
                align-items: center;
                gap: 8px;
                width: 100%;
                padding: 6px 4px;
                background: none;
                border: none;
                border-radius: 4px;
                color: inherit;
                font: inherit;
                text-align: start;
                cursor: pointer;
            }

            .entity-row:hover,
            .entity-row:focus-visible {
                background: var(--secondary-background-color);
            }

            .entity-name {
                flex: 1 1 auto;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .entity-state {
                flex: 0 0 auto;
                color: var(--secondary-text-color);
                font-size: 0.84rem;
            }

            .actions {
                display: flex;
                justify-content: flex-end;
                margin-top: 6px;
            }

            .restore-button {
                padding: 6px 12px;
                border: 1px solid var(--divider-color);
                border-radius: 4px;
                background: none;
                color: var(--primary-color);
                font: inherit;
                cursor: pointer;
            }

            .restore-button[disabled] {
                color: var(--disabled-text-color);
                cursor: default;
            }
        `,
    ];

    @property({ attribute: false }) public hass?: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ type: Boolean }) public executionEnabled = false;

    @state() private _controllableEntities: ControllableEntityDTO[] = [];
    @state() private _restoring = false;

    private _loadedForConnection: unknown = null;

    protected willUpdate(): void {
        // The controllable set only changes when the config does, so fetch it
        // once per connection rather than on every hass update.
        if (!this.hass || this._loadedForConnection === this.hass.connection) {
            return;
        }
        this._loadedForConnection = this.hass.connection;
        void this._loadControllableEntities();
    }

    render() {
        if (this.executionEnabled) {
            return nothing;
        }

        const entities = this._buildNonNormalEntities();
        if (entities.length === 0) {
            return nothing;
        }

        return html`
            <div class="section">
                <div class="section-title">
                    ${this.localize("scheduling.normal_state.title")}
                </div>
                ${entities.map((entity) => html`
                    <button
                        class="entity-row"
                        type="button"
                        @click=${() => this._handleShowMoreInfo(entity.entityId)}
                    >
                        <span class="entity-name">${entity.name}</span>
                        <span class="entity-state">${entity.state}</span>
                    </button>
                `)}
                <div class="actions">
                    <button
                        class="restore-button"
                        type="button"
                        ?disabled=${this._restoring}
                        @click=${this._handleRestoreAll}
                    >
                        ${this._restoring
                            ? this.localize("scheduling.normal_state.restoring")
                            : this.localize("scheduling.normal_state.restore_all")}
                    </button>
                </div>
            </div>
        `;
    }

    private _buildNonNormalEntities(): NonNormalEntity[] {
        const states = this.hass?.states;
        if (!states) {
            return [];
        }

        const entities: NonNormalEntity[] = [];
        for (const entity of this._controllableEntities) {
            const state = states[entity.entityId]?.state;
            // An entity we cannot read is not something the user can act on
            // here, so it is left out rather than guessed at.
            if (typeof state !== "string" || UNAVAILABLE_STATES.has(state)) {
                continue;
            }
            if (state === entity.normalState) {
                continue;
            }
            entities.push({ ...entity, state });
        }
        return entities;
    }

    private async _loadControllableEntities(): Promise<void> {
        if (!this.hass) {
            return;
        }
        try {
            const payload = await getSharedHelmanStore(this.hass).getControllableEntities();
            this._controllableEntities = payload.entities;
        } catch {
            // Nothing to show is the safe outcome: the section simply stays
            // hidden rather than reporting an error the user cannot act on.
            this._controllableEntities = [];
        }
    }

    private _handleShowMoreInfo(entityId: string): void {
        this.dispatchEvent(new CustomEvent("hass-more-info", {
            bubbles: true,
            composed: true,
            detail: { entityId },
        }));
    }

    private async _handleRestoreAll(): Promise<void> {
        if (!this.hass || this._restoring) {
            return;
        }
        this._restoring = true;
        try {
            // Best effort: whatever fails to settle stays listed, because the
            // rows are rendered from live entity state.
            await getSharedHelmanStore(this.hass).restoreNormalState();
        } catch {
            // Same reasoning -- the rows show what actually happened.
        } finally {
            this._restoring = false;
        }
    }
}
