import { LitElement, css, html } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../../hass-frontend/src/types";
import { getSharedHelmanStore } from "../../helman/store";
import type { LocalizeFunction } from "../../localize/localize";
import type { RunningEntity } from "../model/running-entities";
import { schedulingSharedStyles } from "../styles/scheduling-shared-styles";

/**
 * The list of entities Helman can drive that are currently running.
 *
 * Shown whether or not execution is enabled, so the card always answers "what
 * is on right now?". Each row opens that entity's more-info dialog, which is
 * where the user turns it off by hand.
 *
 * The bulk "turn everything to normal" action appears only while execution is
 * disabled: with execution enabled the schedule owns these entities and would
 * simply put them back, so offering the action there would be misleading.
 */
@customElement("scheduling-running-entities")
export class SchedulingRunningEntities extends LitElement {
    static styles = [
        schedulingSharedStyles,
        css`
            /* Mirrors a native entity row, tightened: this is a compact status
               list rather than the card's primary content. */
            .entity-row {
                display: flex;
                align-items: center;
                gap: 12px;
                width: 100%;
                min-height: 28px;
                padding: 1px 4px;
                background: none;
                border: none;
                border-radius: 4px;
                color: var(--primary-text-color);
                font: inherit;
                font-size: 0.9rem;
                text-align: start;
                cursor: pointer;
            }

            .entity-row:hover,
            .entity-row:focus-visible {
                background: var(--secondary-background-color);
            }

            .entity-row state-badge {
                flex: 0 0 28px;
                width: 28px;
                height: 28px;
                line-height: 28px;
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
                padding: 6px 4px 2px;
            }

            .restore-button {
                padding: 4px 10px;
                border: 1px solid var(--divider-color);
                border-radius: 4px;
                background: none;
                color: var(--primary-color);
                font: inherit;
                font-size: 0.84rem;
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
    @property({ attribute: false }) public entities: readonly RunningEntity[] = [];
    @property({ type: Boolean }) public executionEnabled = false;

    @state() private _restoring = false;

    render() {
        if (this.entities.length === 0) {
            return nothing;
        }

        return html`
            ${this.entities.map((entity) => html`
                <button
                    class="entity-row"
                    type="button"
                    @click=${() => this._handleShowMoreInfo(entity.entityId)}
                >
                    <!--
                        stateColor must be a property binding: state-badge
                        declares it with attribute: false, so a bare attribute
                        is ignored and the icon stays uncoloured.
                    -->
                    <state-badge
                        .hass=${this.hass}
                        .stateObj=${entity.stateObj}
                        .stateColor=${true}
                    ></state-badge>
                    <span class="entity-name">${this._buildEntityName(entity)}</span>
                    <span class="entity-state">
                        ${this.hass?.formatEntityState(entity.stateObj)
                            ?? entity.stateObj.state}
                    </span>
                </button>
            `)}
            ${this.executionEnabled ? nothing : html`
                <div class="actions">
                    <button
                        class="restore-button"
                        type="button"
                        ?disabled=${this._restoring}
                        @click=${this._handleRestoreAll}
                    >
                        ${this._restoring
                            ? this.localize("scheduling.running.restoring")
                            : this.localize("scheduling.running.restore_all")}
                    </button>
                </div>
            `}
        `;
    }

    private _buildEntityName(entity: RunningEntity): string {
        // The Helman-configured name is what the user named the appliance in
        // this integration, so it is the more meaningful label here; the
        // entity's own friendly name is the fallback.
        return entity.name
            || entity.stateObj.attributes.friendly_name
            || entity.entityId;
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
