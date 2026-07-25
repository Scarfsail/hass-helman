import { LitElement, css, html } from "lit-element";
import { customElement, property, state } from "lit/decorators.js";
import { nothing } from "lit-html";
import type { HomeAssistant } from "../../../hass-frontend/src/types";
import { getSharedHelmanStore } from "../../helman/store";
import type { LocalizeFunction } from "../../localize/localize";
import type {
    ControllableEntityStateView,
    ControllableEntityStatus,
} from "../model/controllable-entity-status";
import type { EntityScheduleTarget } from "../model/entity-day-schedule-model";
import { getScheduleApplianceActionPresentation } from "../model/schedule-appliance-action-presentation";
import { getScheduleActionLabel } from "../model/schedule-labels";
import { formatScheduleTime } from "../model/schedule-time";
import { schedulingSharedStyles } from "../styles/scheduling-shared-styles";
import "./scheduling-action-chip";
import "./scheduling-appliance-chip";

export interface OpenEntityScheduleDetail {
    entityId: string;
    name: string;
    target: EntityScheduleTarget;
}

/**
 * Every entity Helman can drive, with what it is doing and what it will do.
 *
 * Shown whether or not execution is enabled, so the card always answers "what
 * is on right now?" -- and, with execution on, "until when?" for what is
 * running and "from when?" for what is not. Entities at rest are listed too,
 * muted and last, so the list doubles as the roster of controllable hardware.
 * A row has two halves: the icon and name open that entity's more-info dialog,
 * which is where the user turns it off by hand, and the now/next states open
 * that entity's own schedule editor.
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
               list rather than the card's primary content.

               The row is a container rather than a button because it holds two
               separate targets: the identity opens more-info, the status opens
               the schedule editor. Nesting those inside one button would be
               invalid and would leave the inner target unreachable by keyboard. */
            .entity-row {
                display: flex;
                align-items: center;
                gap: 12px;
                width: 100%;
                min-height: 28px;
                border-radius: 4px;
                color: var(--primary-text-color);
                font-size: 0.9rem;
            }

            .row-target {
                display: flex;
                align-items: center;
                gap: 12px;
                min-width: 0;
                padding: 2px 4px;
                background: none;
                border: none;
                border-radius: 4px;
                color: inherit;
                font: inherit;
                text-align: start;
                cursor: pointer;
            }

            .row-target.identity {
                flex: 1 1 auto;
            }

            .row-target.status {
                flex: 0 0 auto;
            }

            .row-target:hover,
            .row-target:focus-visible {
                background: var(--secondary-background-color);
            }

            /* Not every entity has a schedule lane the card can author; those
               rows keep the status as plain text rather than a dead button. */
            .row-static {
                display: flex;
                align-items: center;
                padding: 2px 4px;
            }

            /* At rest: still listed, but it should not compete with whatever is
               actually running. */
            .entity-row.at-rest {
                color: var(--secondary-text-color);
            }

            /* Configured but unreachable: dimmer still, and its state is a word
               rather than a chip -- there is no state to draw. */
            .entity-row.unavailable state-badge,
            .entity-row.unavailable .entity-name {
                opacity: 0.6;
            }

            .unavailable {
                font-style: italic;
            }

            .entity-row.at-rest state-badge {
                opacity: 0.6;
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

            /* One line, read left to right: where the entity is now, and what
               the schedule turns it into next. The states are icons only -- the
               row is a glance, and their colours already carry the meaning.

               Fixed column tracks rather than content-sized ones, so the three
               parts line up down the whole list: a row with nothing scheduled
               fills only the first column and its icon stays under the other
               rows' current states instead of drifting under their end states. */
            .entity-status {
                display: grid;
                grid-template-columns:
                    var(--schedule-status-column)
                    var(--schedule-status-arrow-column)
                    var(--schedule-status-column);
                flex: 0 0 auto;
                align-items: center;
                gap: 4px;
                color: var(--secondary-text-color);
                font-size: 0.74rem;
                line-height: 1.2;
                white-space: nowrap;

                --schedule-status-column: 76px;
                --schedule-status-arrow-column: 10px;
            }

            /* Both cells hug the arrow, icon innermost: the current state ends
               its column and the next state starts its own, so the two icons
               form clean vertical lines and a longer time label grows outwards
               into the slack instead of pushing its icon along. */
            .status-cell {
                display: flex;
                align-items: center;
                gap: 4px;
                min-width: 0;
            }

            .status-cell.current {
                justify-self: end;
            }

            .status-cell.next {
                justify-self: start;
            }

            .status-arrow {
                justify-self: center;
                opacity: 0.7;
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
    @property({ attribute: false }) public entities: readonly ControllableEntityStatus[] = [];
    @property({ type: Boolean }) public executionEnabled = false;
    @property({ type: Number }) public nowMs = Date.now();

    @state() private _restoring = false;

    render() {
        if (this.entities.length === 0) {
            return nothing;
        }

        const hasRunning = this.entities.some((entity) => !entity.isNormal);

        return html`
            ${this.entities.map((entity) => html`
                <div class="entity-row ${entity.isNormal ? "at-rest" : ""} ${entity.isAvailable ? "" : "unavailable"}">
                    <button
                        class="row-target identity"
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
                        <span class="entity-name">${entity.name}</span>
                    </button>
                    ${entity.scheduleTarget === null ? html`
                        <span class="row-static">${this._renderStatus(entity)}</span>
                    ` : html`
                        <button
                            class="row-target status"
                            type="button"
                            title=${this.localize("scheduling.entity_editor.open")}
                            aria-label=${`${entity.name}: ${this.localize("scheduling.entity_editor.open")}`}
                            @click=${() => this._handleOpenEntitySchedule(entity)}
                        >
                            ${this._renderStatus(entity)}
                        </button>
                    `}
                </div>
            `)}
            ${this.executionEnabled || !hasRunning ? nothing : html`
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

    /**
     * `{from} [now] → {when} [next]`, on one line.
     *
     * The leading time is the moment the entity entered its current state, so
     * it only appears for something that is actually running -- "at rest since"
     * is not what the user came here for. The trailing half is whatever the
     * schedule does next, and drops out when the schedule leaves the entity
     * alone for the rest of the horizon.
     *
     * With execution disabled the schedule drives nothing, so neither time
     * means anything and the row falls back to the current state alone.
     */
    private _renderStatus(entity: ControllableEntityStatus) {
        const next = this.executionEnabled ? entity.next : null;
        const since = this.executionEnabled && entity.sinceMs !== null
            ? this._formatMoment(entity.sinceMs)
            : null;

        return html`
            <span class="entity-status">
                <span class="status-cell current">
                    ${entity.current === null ? html`
                        <span class="unavailable">${this.localize("scheduling.running.unavailable")}</span>
                    ` : html`
                        ${since === null ? nothing : html`<span>${since}</span>`}
                        ${this._renderStateChip(entity.current)}
                    `}
                </span>
                ${next === null ? nothing : html`
                    <span class="status-arrow" aria-hidden="true">→</span>
                    <span class="status-cell next">
                        ${this._renderStateChip(next.view)}
                        <span>${this._formatMoment(next.atMs)}</span>
                    </span>
                `}
            </span>
        `;
    }

    /**
     * A state as its slot-editor chip, icon only.
     *
     * The label the chip would have shown moves into the tooltip: with no text
     * on the row at all, hovering has to be able to name what an icon means.
     */
    private _renderStateChip(view: ControllableEntityStateView) {
        if (view.domain === "inverter") {
            return html`
                <scheduling-action-chip
                    .action=${view.action}
                    .localize=${this.localize}
                    .labelVariant=${"table"}
                    .titleText=${getScheduleActionLabel(view.action, this.localize)}
                    size="compact"
                    ?iconOnly=${true}
                ></scheduling-action-chip>
            `;
        }

        return html`
            <scheduling-appliance-chip
                .appliance=${view.appliance}
                .action=${view.action}
                .localize=${this.localize}
                .titleText=${getScheduleApplianceActionPresentation({
                    appliance: view.appliance,
                    action: view.action,
                    localize: this.localize,
                }).label}
                size="compact"
                ?iconOnly=${true}
            ></scheduling-appliance-chip>
        `;
    }

    /**
     * A time of day, dated only when it is not today: "18:00" is unambiguous
     * within the day and reads better than a full timestamp on every row.
     */
    private _formatMoment(atMs: number): string {
        const locale = this.hass?.locale?.language ?? "cs";
        const timeZone = this.hass?.config?.time_zone ?? "UTC";
        const timeLabel = formatScheduleTime(atMs, locale, timeZone);
        if (this._isSameLocalDay(atMs, timeZone)) {
            return timeLabel;
        }

        const dayLabel = new Date(atMs).toLocaleDateString(locale, {
            timeZone,
            weekday: "short",
        });
        return `${dayLabel} ${timeLabel}`;
    }

    private _isSameLocalDay(atMs: number, timeZone: string): boolean {
        // Comparing rendered dates keeps the check in the user's zone without a
        // second date-math path.
        const options: Intl.DateTimeFormatOptions = { timeZone, year: "numeric", month: "2-digit", day: "2-digit" };
        return new Date(atMs).toLocaleDateString("en-CA", options)
            === new Date(this.nowMs).toLocaleDateString("en-CA", options);
    }

    /**
     * The status half of the row opens that one entity's schedule.
     *
     * Splitting the row this way keeps the icon and the name meaning "tell me
     * about this entity" while the now/next states -- which are schedule facts
     * -- lead to where the schedule is edited.
     */
    private _handleOpenEntitySchedule(entity: ControllableEntityStatus): void {
        if (entity.scheduleTarget === null) {
            return;
        }

        this.dispatchEvent(new CustomEvent<OpenEntityScheduleDetail>("open-entity-schedule", {
            bubbles: true,
            composed: true,
            detail: {
                entityId: entity.entityId,
                name: entity.name,
                target: entity.scheduleTarget,
            },
        }));
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
