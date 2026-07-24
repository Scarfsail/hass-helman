import { LitElement, css, html } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HassEntity } from "home-assistant-js-websocket";
import type { HomeAssistant } from "../../../hass-frontend/src/types";
import type { ControllableEntityDTO } from "../../helman-api";
import { getSharedHelmanStore } from "../../helman/store";
import type { LocalizeFunction } from "../../localize/localize";
import { schedulingSharedStyles } from "../styles/scheduling-shared-styles";

const UNAVAILABLE_STATES = new Set(["unknown", "unavailable", ""]);

interface NonNormalEntity extends ControllableEntityDTO {
    stateObj: HassEntity;
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
                border-top: 1px solid var(--divider-color);
            }

            .section-toggle {
                display: flex;
                align-items: center;
                gap: 8px;
                width: 100%;
                padding: 10px 4px;
                background: none;
                border: none;
                color: var(--secondary-text-color);
                font: inherit;
                font-size: 0.84rem;
                text-align: start;
                cursor: pointer;
            }

            .section-toggle:hover {
                color: var(--primary-color);
            }

            .toggle-icon {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                flex: 0 0 20px;
                width: 20px;
                height: 20px;
                border-radius: 999px;
                font-size: 0.82rem;
                font-weight: 700;
                line-height: 1;
                transition: background-color 120ms ease, color 120ms ease;
            }

            .section-toggle:hover .toggle-icon {
                background: color-mix(in srgb, var(--primary-color) 10%, transparent);
            }

            .toggle-label {
                flex: 1 1 auto;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .toggle-count {
                flex: 0 0 auto;
                font-variant-numeric: tabular-nums;
            }

            /* Mirrors the geometry of a native hui-generic-entity-row. */
            .entity-row {
                display: flex;
                align-items: center;
                gap: 16px;
                width: 100%;
                min-height: 40px;
                padding: 4px 4px;
                background: none;
                border: none;
                border-radius: 4px;
                color: var(--primary-text-color);
                font: inherit;
                text-align: start;
                cursor: pointer;
            }

            .entity-row:hover,
            .entity-row:focus-visible {
                background: var(--secondary-background-color);
            }

            .entity-row state-badge {
                flex: 0 0 40px;
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
                text-align: end;
            }

            .actions {
                display: flex;
                justify-content: flex-end;
                padding: 8px 4px 4px;
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
    @state() private _expanded = true;
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
                <button
                    class="section-toggle"
                    type="button"
                    aria-expanded=${this._expanded ? "true" : "false"}
                    @click=${this._handleToggleExpanded}
                >
                    <span class="toggle-icon" aria-hidden="true">
                        ${this._expanded ? "−" : "+"}
                    </span>
                    <span class="toggle-label">
                        ${this.localize("scheduling.normal_state.title")}
                    </span>
                    <span class="toggle-count">${entities.length}</span>
                </button>
                ${this._expanded ? this._renderEntities(entities) : nothing}
            </div>
        `;
    }

    private _renderEntities(entities: readonly NonNormalEntity[]) {
        return html`
            ${entities.map((entity) => html`
                <button
                    class="entity-row"
                    type="button"
                    @click=${() => this._handleShowMoreInfo(entity.entityId)}
                >
                    <state-badge
                        .hass=${this.hass}
                        .stateObj=${entity.stateObj}
                        stateColor
                    ></state-badge>
                    <span class="entity-name">${this._buildEntityName(entity)}</span>
                    <span class="entity-state">
                        ${this.hass?.formatEntityState(entity.stateObj)
                            ?? entity.stateObj.state}
                    </span>
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
        `;
    }

    private _buildEntityName(entity: NonNormalEntity): string {
        // The Helman-configured name is what the user named the appliance in
        // this integration, so it is the more meaningful label here; the
        // entity's own friendly name is the fallback.
        return entity.name
            || entity.stateObj.attributes.friendly_name
            || entity.entityId;
    }

    private _buildNonNormalEntities(): NonNormalEntity[] {
        const states = this.hass?.states;
        if (!states) {
            return [];
        }

        const entities: NonNormalEntity[] = [];
        for (const entity of this._controllableEntities) {
            const stateObj = states[entity.entityId];
            // An entity we cannot read is not something the user can act on
            // here, so it is left out rather than guessed at.
            if (!stateObj || UNAVAILABLE_STATES.has(stateObj.state)) {
                continue;
            }
            if (stateObj.state === entity.normalState) {
                continue;
            }
            entities.push({ ...entity, stateObj });
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

    private _handleToggleExpanded(): void {
        this._expanded = !this._expanded;
    }

    private _handleShowMoreInfo(entityId: string): void {
        this.dispatchEvent(new CustomEvent("hass-more-info", {
            bubbles: true,
            composed: true,
            detail: { entityId },
        }));
    }

    private async _handleRestoreAll(event: MouseEvent): Promise<void> {
        event.stopPropagation();
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
