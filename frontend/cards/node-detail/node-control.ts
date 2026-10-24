import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import type { HomeAssistant } from "../../types/ha";
import { fillTemplate, getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import { DialogHistoryController } from "../shared/dialog-history-controller";
import { dispatchWatchedEntities } from "../shared/hass-change";
import { showToast } from "../shared/fire-event";
import { asJsonObject, getValueAtPath, setValueAtPath } from "../shared/config/config-document";
import { booleanValue, stringValue } from "../shared/config/form-fields";
import { getLaneAutomationCoverage } from "../shared/optimizer/automation-coverage";
import { findOptimizerLocations } from "../shared/optimizer/optimizer-locations";
import type { HelmanOptimizerEditDialog } from "../shared/optimizer/helman-optimizer-edit-dialog";
import { buildControllableEntityStatuses } from "../shared/schedule/model/controllable-entity-status";
import {
    buildEntityScheduleLanePatches,
    readEntityScheduleAction,
    type EntityScheduleAction,
} from "../shared/schedule/model/entity-day-schedule-model";
import {
    describeScheduleAppliance,
    asScheduleAppliance,
    type ScheduleControllable,
} from "../shared/schedule/model/schedule-appliance-metadata";
import { summarizeScheduleAuthorship } from "../shared/schedule/model/schedule-authorship";
import { findCurrentScheduleSlot } from "../shared/schedule/model/schedule-normalizer";
import { getSharedScheduleOwner } from "../shared/schedule/schedule-owner";
import {
    isScheduleInverterAction,
    type ScheduleSetBy,
    type ScheduleSlot,
} from "../shared/schedule/schedule-types";
import { schedulingSharedStyles } from "../shared/schedule/styles/scheduling-shared-styles";
import { AdminConfigController } from "./admin-config-controller";
import { currentManualRun, LaneOwnershipController } from "./lane-ownership";
import { nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";
import "../shared/optimizer/helman-optimizer-edit-dialog";
import "../shared/schedule/components/scheduling-action-chip";
import "../shared/schedule/components/scheduling-appliance-chip";
import type { ControlOverrideDialog } from "./control-override-dialog";
import "./control-override-dialog";

/** One optimizer driving the lane, as its config reads. */
interface OptimizerRow {
    kind: string;
    enabled: boolean;
}

type NestedDialog = { kind: "override" } | { kind: "optimizer"; optimizerId: string };

/**
 * The Control tab: who owns a lane now, what the hardware does, the bounded
 * override and the automations that drive the lane.
 *
 * The plan, the coverage and the roster are the shared ones, followed while
 * the tab is in the page. An override is a user-authored stretch of the
 * schedule written through the same patches as the day editor, so it never
 * writes to the hardware itself, and with execution off says so.
 *
 * The automation rows are an admin's: only then is the config read, and each
 * switch reads the current document again before it saves its one flag with
 * the revision it read.
 */
@customElement("helman-node-control")
export class HelmanNodeControl extends LitElement {
    static styles = [nodeDetailSharedStyles, nodeDetailQuestionStyles, schedulingSharedStyles, css`
        .status-line {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px;
        }
        .status {
            font-weight: 600;
        }
        .row {
            align-items: center;
            flex-wrap: wrap;
        }
        .actions {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }
        .actions button {
            font: inherit;
            font-size: 0.9rem;
            min-height: 36px;
            padding: 4px 14px;
            border-radius: 999px;
            border: 1px solid var(--divider-color);
            background: var(--card-background-color);
            color: var(--primary-text-color);
            cursor: pointer;
        }
        .actions button:disabled {
            cursor: default;
            opacity: 0.5;
        }
        .optimizer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
        }
        .optimizer .link-button {
            text-align: left;
            min-width: 0;
            overflow-wrap: anywhere;
        }
        .optimizer-id {
            font-weight: 400;
            color: var(--secondary-text-color);
        }
    `];

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    /** The lane controlled, by its controllable id. */
    @property({ attribute: false }) public controllableId!: string;
    /** Why this lane controls the node, for a node that does not own its lane. */
    @property({ attribute: false }) public note: string | null = null;
    /** Headed by the lane's name, for a node with several lanes. */
    @property({ attribute: false }) public titled = false;

    @state() private _dialog: NestedDialog | null = null;
    @state() private _error: string | null = null;

    /** The plan, the coverage and the roster, followed while the tab is in the page. */
    private readonly _lanes = new LaneOwnershipController(this, () => this.hass, (roster) => {
        // The live state the Now row reads is the lane's primary entity.
        const controllable = roster.find((entry) => entry.id === this.controllableId);
        if (controllable) dispatchWatchedEntities(this, `node-detail:control:${this.controllableId}`, [controllable.primaryEntityId]);
    });
    private readonly _config = new AdminConfigController(this, () => this.hass);
    /** Back goes through the nested dialog's own close, so a draft or a write in flight keeps it open. */
    private readonly _history = new DialogHistoryController(this, "__helmanNodeControlDialogId", {
        onBack: () => {
            const dialog = this.renderRoot.querySelector<HelmanOptimizerEditDialog | ControlOverrideDialog>(
                "helman-optimizer-edit-dialog, control-override-dialog",
            );
            if (dialog === null) return false;
            // Once the entry is back, so a close that goes ahead consumes it.
            queueMicrotask(() => dialog.requestClose());
            return true;
        },
        close: () => { this._dialog = null; },
    });

    /** The lane's roster entry, found once per render; `undefined` until read, `null` when the roster has none. */
    private _controllable: ScheduleControllable | null | undefined = undefined;

    willUpdate(changedProperties: Map<string, unknown>): void {
        super.willUpdate(changedProperties);
        const roster = this._lanes.roster;
        this._controllable = roster === null ? undefined : roster.find((entry) => entry.id === this.controllableId) ?? null;
    }

    /** One optimizer as the configuration read holds it; `undefined` until read or when it has none. */
    private _optimizerRow(optimizerId: string): OptimizerRow | undefined {
        const config = this._config.config;
        const location = config ? findOptimizerLocations(config, [optimizerId])[0] : undefined;
        const entry = location ? asJsonObject(getValueAtPath(config!, ["automation", location.bucket, location.index])) : undefined;
        return entry ? { kind: stringValue(entry.kind), enabled: booleanValue(entry.enabled, true) } : undefined;
    }

    private _optimizerIds(): readonly string[] {
        return getLaneAutomationCoverage(this._lanes.coverage, this.controllableId).optimizerIds;
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    render() {
        const lanes = this._lanes;
        const nowMs = lanes.nowMs;
        const schedule = lanes.snapshot.schedule;
        const slots = lanes.normalized.slots;
        const run = schedule ? currentManualRun(slots, this.controllableId) : null;
        const writing = lanes.snapshot.writing;
        const canAuthor = schedule !== null && this._controllable?.supportsAuthoring === true;
        return html`
            <div class="content" data-control=${this.controllableId}>
                ${this.titled ? html`<div class="section-title" data-lane-name>${this._controllable?.name ?? this.controllableId}</div>` : nothing}
                <div class="summary">
                    <div class="status-line" role="status">${lanes.renderStatus(lanes.status(this.controllableId), this.localize)}</div>
                    ${this.note ? html`<p class="note" data-lane-note>${this.note}</p>` : nothing}
                    ${schedule && !schedule.executionEnabled
                        ? html`<p class="note" data-execution-off>${this._t("execution_off_note")}</p>`
                        : nothing}
                </div>
                ${schedule ? html`
                    <div class="rows">
                        <div class="row" data-now>
                            <span class="label">${this._t("hardware_now")}</span>
                            ${this._renderLive(slots, nowMs, schedule.executionEnabled)}
                        </div>
                        <div class="row" data-scheduled>
                            <span class="label">${this._t("scheduled_now")}</span>
                            ${this._renderScheduled(slots)}
                        </div>
                    </div>
                ` : nothing}
                ${this._controllable === null ? html`<p class="note" data-not-on-roster>${this._t("not_on_roster")}</p>` : nothing}
                ${lanes.rosterFailed ? html`<p class="note" data-roster-failed>${this._t("status.unavailable")}</p>` : nothing}
                ${this._controllable?.supportsAuthoring === false ? html`<p class="note" data-unsupported>${this._t("unsupported_authoring")}</p>` : nothing}
                <div class="actions">
                    ${canAuthor ? html`
                        <button type="button" data-change ?disabled=${writing} @click=${() => this._openDialog({ kind: "override" })}>
                            ${this._t("change")}
                        </button>
                    ` : nothing}
                    ${run !== null ? html`
                        <button type="button" data-return ?disabled=${writing} @click=${this._returnToAutomatic}>
                            ${this._t("return_to_automatic")}
                        </button>
                    ` : nothing}
                </div>
                ${this._error ? html`<p class="error" role="alert" data-error>${this._error}</p>` : nothing}
                ${this._config.isAdmin ? this._renderAutomations() : nothing}
            </div>
            ${this._renderDialog()}
        `;
    }

    /** What the hardware does now, from its live state, not from the plan. */
    private _renderLive(slots: readonly ScheduleSlot[], nowMs: number, executionEnabled: boolean) {
        const controllable = this._controllable;
        const view = controllable
            ? buildControllableEntityStatuses({ controllables: [controllable], states: this.hass.states, slots, nowMs, executionEnabled })[0]?.current ?? null
            : null;
        if (view === null) return html`<span class="value">${this._t("unavailable")}</span>`;
        return view.domain === "inverter"
            ? this._chip(view.action, view.setBy)
            : html`
                <scheduling-appliance-chip
                    .appliance=${view.appliance}
                    .action=${view.action}
                    .localize=${this.localize}
                    .authorship=${view.setBy ? summarizeScheduleAuthorship([view.setBy]) : null}
                ></scheduling-appliance-chip>
            `;
    }

    /** The slot in progress's action for the lane, decorated by who set it. */
    private _renderScheduled(slots: readonly ScheduleSlot[]) {
        const slot = findCurrentScheduleSlot(slots);
        const action = slot ? readEntityScheduleAction(slot, this.controllableId) : null;
        if (!slot || action === null) return html`<span class="value">${this._t("nothing_scheduled")}</span>`;
        return this._chip(action, slot.assignments[this.controllableId]?.setBy ?? null);
    }

    private _chip(action: EntityScheduleAction, setBy: ScheduleSetBy | null): TemplateResult {
        const authorship = setBy ? summarizeScheduleAuthorship([setBy]) : null;
        if (action !== null && isScheduleInverterAction(action)) {
            return html`<scheduling-action-chip .action=${action} .localize=${this.localize} .authorship=${authorship}></scheduling-action-chip>`;
        }
        const appliance = this._controllable ? asScheduleAppliance(this._controllable) : null;
        return appliance ? html`
            <scheduling-appliance-chip
                .appliance=${describeScheduleAppliance(appliance)}
                .action=${action}
                .localize=${this.localize}
                .authorship=${authorship}
            ></scheduling-appliance-chip>
        ` : html`<span class="value">${this._t("nothing_scheduled")}</span>`;
    }

    /** The lane's automations, each named by its kind, with its switch and its editor. */
    private _renderAutomations() {
        const coverage = this._lanes.coverage;
        const configError = this._config.error;
        if (coverage === null && configError === null) return nothing;
        const ids = this._optimizerIds();
        const editor = getLocalizeFunction(this.hass);
        return html`
            <div class="rows" data-automations>
                <div class="section-title">${this._t("automations")}</div>
                ${configError !== null
                    ? html`<p class="error" role="alert" data-config-error>${this._t("config_failed")} ${configError}</p>`
                    : nothing}
                ${coverage === null ? nothing : ids.length === 0 ? html`<p class="note">${this._t("no_automations")}</p>` : ids.map((id) => {
                    const row = this._optimizerRow(id);
                    const name = row?.kind ? `${editor(`editor.values.${row.kind}`)}` : id;
                    return html`
                        <div class="optimizer" data-optimizer=${id}>
                            <button type="button" class="link-button" data-edit @click=${() => this._openDialog({ kind: "optimizer", optimizerId: id })}>
                                ${name} ${row?.kind ? html`<span class="optimizer-id">${id}</span>` : nothing}
                            </button>
                            <ha-switch
                                .checked=${live(row?.enabled ?? false)}
                                .disabled=${row === undefined || this._config.saving !== null}
                                aria-label=${fillTemplate(this._t("automation_toggle"), { name })}
                                @change=${(event: Event) => this._setOptimizerEnabled(id, (event.currentTarget as HTMLInputElement).checked)}
                            ></ha-switch>
                        </div>
                    `;
                })}
            </div>
        `;
    }

    private _renderDialog() {
        const dialog = this._dialog;
        if (dialog === null) return nothing;
        if (dialog.kind === "optimizer") {
            return html`
                <helman-optimizer-edit-dialog
                    .hass=${this.hass}
                    .localize=${this.localize}
                    .open=${true}
                    .optimizerIds=${[dialog.optimizerId]}
                    @closed=${this._onDialogClosed}
                ></helman-optimizer-edit-dialog>
            `;
        }
        return this._controllable ? html`
            <control-override-dialog
                .hass=${this.hass}
                .localize=${this.localize}
                .controllable=${this._controllable}
                .normalized=${this._lanes.normalized}
                .executionEnabled=${this._lanes.snapshot.schedule?.executionEnabled ?? false}
                .open=${true}
                @closed=${this._onDialogClosed}
            ></control-override-dialog>
        ` : nothing;
    }

    // ── Actions ─────────────────────────────────────────────────────────────

    /** A nested dialog owns one history entry, so Back closes only it. */
    private _openDialog(dialog: NestedDialog): void {
        this._error = null;
        this._dialog = dialog;
        this._history.push();
    }

    private _onDialogClosed = (): void => {
        this._history.closed();
        this._dialog = null;
    };

    /**
     * Release the user's run in progress back to the automation: its slots
     * from the one in progress lose this lane's user action, and whatever
     * the automation decides fills them. Read at the press, so a slot that
     * elapsed meanwhile is left alone; later separate runs stay.
     */
    private _returnToAutomatic = async (): Promise<void> => {
        const owner = getSharedScheduleOwner(this.hass);
        const nowMs = Date.now();
        const slots = owner.getNormalized(this._lanes.timeZone, this._lanes.locale).slots;
        const run = currentManualRun(slots, this.controllableId);
        if (run === null) return;
        this._error = null;
        const patches = buildEntityScheduleLanePatches({
            slots,
            lanes: [{ target: this.controllableId, draft: Object.fromEntries(run.slots.map((slot) => [slot.id, null])) }],
            nowMs,
        });
        const error = await owner.applySchedulePatches(patches);
        if (error) {
            this._error = `${this._t("return_failed")} ${error.message}`;
            return;
        }
        showToast(this, this._t("returned"));
    };

    /** Switch one optimizer on or off: only its `enabled` changes, against the document read at the press. */
    private _setOptimizerEnabled(optimizerId: string, enabled: boolean): void {
        void this._config.save(optimizerId, (doc) => {
            const location = findOptimizerLocations(doc, [optimizerId])[0];
            if (!location) return false;
            setValueAtPath(doc, ["automation", location.bucket, location.index, "enabled"], enabled);
            return true;
        });
    }

    private _t(key: string): string {
        return this.localize(`node_detail.control.${key}`);
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-node-control": HelmanNodeControl;
    }
}
