import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import { fillTemplate, type LocalizeFunction } from "../localize/localize";
import { showToast } from "../shared/fire-event";
import { resolveLocale } from "../shared/resolve-locale";
import {
    areEntityScheduleActionsEqual,
    buildEntityScheduleLanePatches,
    isEntityScheduleActionEmpty,
    readEntityScheduleAction,
    sanitizeEntityScheduleAction,
    type EntityScheduleAction,
    type EntityScheduleDraft,
} from "../shared/schedule/model/entity-day-schedule-model";
import { asScheduleAppliance, type ScheduleControllable } from "../shared/schedule/model/schedule-appliance-metadata";
import { formatScheduleInstantLabel, getScheduleLocalDayStartMs } from "../shared/schedule/model/schedule-time";
import { EMPTY_NORMALIZED_SCHEDULE, findCurrentScheduleSlot } from "../shared/schedule/model/schedule-normalizer";
import { getSharedScheduleOwner } from "../shared/schedule/schedule-owner";
import type { NormalizedScheduleModel } from "../shared/schedule/schedule-types";
import { schedulingSharedStyles } from "../shared/schedule/styles/scheduling-shared-styles";
import type { EntityScheduleActionChangeDetail } from "../shared/schedule/dialogs/scheduling-entity-action-editor";
import "../shared/schedule/dialogs/scheduling-entity-action-editor";
import { timeZone } from "./section-resource";

const HOUR_MS = 3_600_000;

type QuickPick = "plus_1h" | "plus_3h" | "end_of_day" | "next_change";

/** Where an override may start and end: the slot in progress and every edge after it the schedule holds. */
interface OverrideEdges {
    fromMs: number;
    /** Each slot end from the slot in progress to the first gap, in order. */
    ends: number[];
    picks: Array<{ key: QuickPick; ms: number }>;
}

/**
 * One bounded manual override of one lane: an action, from the slot in
 * progress to a chosen end.
 *
 * The action editor is the day editor's; the edges are the loaded schedule's
 * own slot ends, never past its horizon or a gap in it. The save is the day
 * editor's lane patch, built from the schedule as it is at the press and
 * claiming every slot of the range, even one whose automation action is the
 * same: an override is the user's. A range whose slots all elapsed, or that
 * changes nothing, says so and stays open.
 */
@customElement("control-override-dialog")
export class ControlOverrideDialog extends LitElement {
    static styles = [schedulingSharedStyles, css`
        .dialog-content {
            display: flex;
            flex-direction: column;
            gap: 14px;
            min-width: min(420px, 80vw);
        }
        .range {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            align-items: flex-end;
        }
        .field {
            display: flex;
            flex-direction: column;
            gap: 4px;
            min-width: 0;
        }
        select {
            font: inherit;
            min-height: 36px;
            max-width: 100%;
        }
        .picks {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }
        .picks button {
            font: inherit;
            font-size: 0.85rem;
            min-height: 32px;
            padding: 2px 12px;
            border-radius: 999px;
            border: 1px solid var(--divider-color);
            background: var(--card-background-color);
            color: var(--primary-text-color);
            cursor: pointer;
        }
        .picks button[aria-pressed="true"] {
            border-color: var(--primary-color);
            font-weight: 600;
        }
        .error {
            margin: 0;
            color: var(--error-color, #c62828);
            font-size: 0.9rem;
        }
    `];

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public controllable!: ScheduleControllable;
    /** The shared plan as its owner normalised it on the shared clock, followed by the host. */
    @property({ attribute: false }) public normalized: NormalizedScheduleModel = EMPTY_NORMALIZED_SCHEDULE;
    @property({ attribute: false }) public executionEnabled = true;
    @property({ type: Boolean }) public open = false;

    @state() private _action: EntityScheduleAction = null;
    @state() private _valid = false;
    @state() private _toMs: number | null = null;
    @state() private _saving = false;
    @state() private _error: string | null = null;
    private _sessionKey = 0;

    protected willUpdate(changed: PropertyValues<this>): void {
        if (changed.has("open") && this.open) {
            // Seeded with the lane's action now, so holding it is one choice of an end.
            const slot = findCurrentScheduleSlot(this.normalized.slots);
            const action = slot ? sanitizeEntityScheduleAction(readEntityScheduleAction(slot, this.controllable.id)) : null;
            this._action = action;
            this._valid = !isEntityScheduleActionEmpty(action);
            this._toMs = null;
            this._error = null;
            this._sessionKey += 1;
        }
    }

    render() {
        const edges = this._edges();
        const toMs = this._toMs !== null && edges?.ends.includes(this._toMs) ? this._toMs : null;
        const canSave = edges !== null && toMs !== null && this._valid && !this._saving;
        const title = `${this._t("title")} · ${this.controllable.name}`;
        return html`
            <ha-dialog .open=${this.open} .heading=${title} .headerTitle=${title} @wa-hide=${this._handleHide} @closed=${this._handleClosed}>
                <div class="dialog-content">
                    ${this.executionEnabled ? nothing : html`<p class="field-help" data-execution-off>${this._t("execution_off")}</p>`}
                    <scheduling-entity-action-editor
                        .localize=${this.localize}
                        .target=${this.controllable.id}
                        .appliance=${asScheduleAppliance(this.controllable)}
                        .action=${this._action}
                        .sessionKey=${this._sessionKey}
                        .authorship=${"user"}
                        @entity-action-change=${this._handleActionChange}
                    ></scheduling-entity-action-editor>
                    ${edges === null ? html`<p class="error" data-no-slot>${this._t("no_slot")}</p>` : html`
                        <div class="range">
                            <div class="field">
                                <span class="field-label">${this._t("from")}</span>
                                <span data-from>${this._label(edges.fromMs)}</span>
                            </div>
                            <label class="field">
                                <span class="field-label">${this._t("to")}</span>
                                <select data-to required @change=${this._handleToChange}>
                                    <option value="" ?selected=${toMs === null} disabled>${this._t("choose_to")}</option>
                                    ${edges.ends.map((ms) => html`
                                        <option value=${String(ms)} ?selected=${ms === toMs}>${this._label(ms)}</option>
                                    `)}
                                </select>
                            </label>
                        </div>
                        <div class="picks">
                            ${edges.picks.map(({ key, ms }) => html`
                                <button type="button" data-pick=${key} aria-pressed=${ms === toMs ? "true" : "false"} @click=${() => this._pick(ms)}>
                                    ${this._t(`pick.${key}`)}
                                </button>
                            `)}
                        </div>
                    `}
                    ${this._error ? html`<p class="error" role="alert" data-error>${this._error}</p>` : nothing}
                </div>
                <ha-dialog-footer slot="footer">
                    <ha-button slot="primaryAction" data-save .disabled=${!canSave} @click=${this._save}>
                        ${this._t(this._saving ? "saving" : "save")}
                    </ha-button>
                    <ha-button slot="secondaryAction" data-cancel @click=${this._close}>${this._t("cancel")}</ha-button>
                </ha-dialog-footer>
            </ha-dialog>
        `;
    }

    private get _timeZone(): string {
        return timeZone(this.hass);
    }

    private get _locale(): string {
        return resolveLocale(this.hass);
    }

    /**
     * From the slot in progress's start, every slot end up to the first gap
     * or the horizon, and the quick picks that land on one of them: +1 h,
     * +3 h, the end of the local day and the lane's next plan change.
     */
    private _edges(): OverrideEdges | null {
        const ordered = this.normalized.slots;
        const current = findCurrentScheduleSlot(ordered);
        if (!current) return null;
        const id = this.controllable.id;
        const currentAction = readEntityScheduleAction(current, id);
        const ends: number[] = [];
        let nextChange: number | null = null;
        let previousEnd = current.startMs;
        for (const slot of ordered.slice(ordered.indexOf(current))) {
            if (slot.startMs !== previousEnd) break;
            if (nextChange === null && slot !== current && !areEntityScheduleActionsEqual(readEntityScheduleAction(slot, id), currentAction)) {
                nextChange = slot.startMs;
            }
            ends.push(slot.endMs);
            previousEnd = slot.endMs;
        }
        const fromMs = current.startMs;
        const endOfDay = ends.find((ms) => getScheduleLocalDayStartMs(ms, this._timeZone) === ms) ?? null;
        const candidates: Array<[QuickPick, number | null]> = [
            ["plus_1h", fromMs + HOUR_MS],
            ["plus_3h", fromMs + 3 * HOUR_MS],
            ["end_of_day", endOfDay],
            ["next_change", nextChange],
        ];
        return {
            fromMs,
            ends,
            picks: candidates
                .filter((candidate): candidate is [QuickPick, number] => candidate[1] !== null && ends.includes(candidate[1]))
                .map(([key, ms]) => ({ key, ms })),
        };
    }

    /** An edge as its day and local time, with its UTC offset on the hour the clock repeats. */
    private _label(ms: number): string {
        return formatScheduleInstantLabel(ms, {
            currentDayKey: this.normalized.currentDayKey,
            locale: this._locale,
            timeZone: this._timeZone,
            todayLabel: this.localize("scheduling.day.today"),
            tomorrowLabel: this.localize("scheduling.day.tomorrow"),
        });
    }

    private _handleActionChange(event: CustomEvent<EntityScheduleActionChangeDetail>): void {
        event.stopPropagation();
        this._action = event.detail.action;
        this._valid = event.detail.valid && !isEntityScheduleActionEmpty(event.detail.action);
        this._error = null;
    }

    private _handleToChange(event: Event): void {
        const value = (event.currentTarget as HTMLSelectElement).value;
        this._pick(value === "" ? null : Number(value));
    }

    private _pick(ms: number | null): void {
        this._toMs = ms;
        this._error = null;
    }

    /**
     * Write the range against the schedule as it is now: the owner's current
     * snapshot and the wall clock at the press, so a slot that elapsed is
     * left out and an unrelated lane's user action written since is kept.
     */
    private _save = async (): Promise<void> => {
        const toMs = this._toMs;
        const edges = this._edges();
        if (this._saving || !this._valid || this._action === null || toMs === null || edges === null) return;
        const owner = getSharedScheduleOwner(this.hass);
        const nowMs = Date.now();
        const slots = owner.getNormalized(this._timeZone, this._locale).slots;
        const action = sanitizeEntityScheduleAction(this._action);
        const draft: EntityScheduleDraft = {};
        for (const slot of slots) {
            if (slot.startMs >= edges.fromMs && slot.endMs <= toMs) draft[slot.id] = action;
        }
        const patches = buildEntityScheduleLanePatches({
            slots,
            lanes: [{ target: this.controllable.id, draft, claim: true }],
            nowMs,
        });
        if (patches.length === 0) {
            this._error = this._t("nothing_to_save");
            return;
        }
        this._saving = true;
        this._error = null;
        const error = await owner.applySchedulePatches(patches);
        this._saving = false;
        if (error) {
            this._error = `${this._t("save_failed")} ${error.message}`;
            return;
        }
        showToast(this, fillTemplate(this._t(this.executionEnabled ? "saved" : "saved_execution_off"), { time: this._label(toMs) }));
        this._close();
    };


    /** Close as Cancel does: refused while the write is in flight. Back comes through here. */
    public requestClose(): void {
        this._close();
    }

    private _close = (): void => {
        if (this._saving) return;
        this.open = false;
        this.dispatchEvent(new CustomEvent("closed"));
    };

    /**
     * Ours, so it stops here: its path crosses the node detail's own dialog,
     * as the optimizer dialog's does.
     */
    private _handleHide = (event: Event): void => {
        event.stopPropagation();
        // Kept open while writing, so a refused write is still shown.
        if (this._saving && event.target === this.renderRoot.querySelector("ha-dialog")) event.preventDefault();
    };

    /**
     * The dialog's own close (scrim, Escape, the header's close). Stopped
     * here: the node detail's dialog closes on the same event name.
     */
    private _handleClosed = (event: Event): void => {
        event.stopPropagation();
        if (!this.open || this._saving) return;
        this.open = false;
        this.dispatchEvent(new CustomEvent("closed"));
    };

    private _t(key: string): string {
        return this.localize(`node_detail.control.override.${key}`);
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "control-override-dialog": ControlOverrideDialog;
    }
}
