import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import type { HomeAssistant } from "../../types/ha";
import { fillTemplate, getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import { DialogHistoryController } from "../shared/dialog-history-controller";
import { DataChangedController } from "../shared/data/data-changed";
import { getSharedHelmanStore } from "../shared/data/store";
import { dispatchWatchedEntities } from "../shared/hass-change";
import { describeError } from "../shared/describe-error";
import { resolveLocale } from "../shared/resolve-locale";
import { showToast } from "../shared/fire-event";
import { asJsonObject, cloneJson, getValueAtPath, setValueAtPath } from "../shared/config/config-document";
import { ConfigSession } from "../shared/config/config-session";
import { booleanValue, stringValue } from "../shared/config/form-fields";
import type { JsonObject } from "../shared/config/types";
import {
    getLaneAutomationCoverage,
    getSharedAutomationCoverage,
    type AutomationCoverageIndex,
} from "../shared/optimizer/automation-coverage";
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
import { EMPTY_NORMALIZED_SCHEDULE, findCurrentScheduleSlot } from "../shared/schedule/model/schedule-normalizer";
import { formatScheduleInstantLabel } from "../shared/schedule/model/schedule-time";
import { EMPTY_SCHEDULE_OWNER_SNAPSHOT, getSharedScheduleOwner } from "../shared/schedule/schedule-owner";
import {
    isScheduleInverterAction,
    type NormalizedScheduleModel,
    type ScheduleOwnerSnapshot,
    type ScheduleSetBy,
    type ScheduleSlot,
} from "../shared/schedule/schedule-types";
import { schedulingSharedStyles } from "../shared/schedule/styles/scheduling-shared-styles";
import { nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";
import { timeZone } from "./section-resource";
import "../shared/optimizer/helman-optimizer-edit-dialog";
import "../shared/schedule/components/scheduling-action-chip";
import "../shared/schedule/components/scheduling-appliance-chip";
import type { ControlOverrideDialog } from "./control-override-dialog";
import "./control-override-dialog";

/** Who owns a lane right now, as the Control tab names it. */
export type ControlStatus =
    | { kind: "loading" }
    | { kind: "unavailable" }
    | { kind: "execution_off" }
    | { kind: "manual"; untilMs: number }
    | { kind: "automatic" }
    | { kind: "automation_off" }
    | { kind: "not_automated" };

/** A contiguous stretch of user-owned slots on one lane. */
export interface ManualRun {
    startMs: number;
    endMs: number;
    slots: ScheduleSlot[];
}

/**
 * The user-owned run of `controllableId` that the slot in progress belongs
 * to, from that slot on; `null` when the slot in progress is not the user's.
 * The slots are the normalised schedule's, in time order with the slot in
 * progress marked by the shared clock.
 *
 * Adjacent user actions may differ and still be one run: the run is about who
 * owns the lane, not what it does. It stops at the first slot that is not the
 * user's, and at a gap in the schedule.
 */
export function currentManualRun(
    slots: readonly ScheduleSlot[],
    controllableId: string,
): ManualRun | null {
    const current = findCurrentScheduleSlot(slots);
    if (!current) return null;
    const run: ScheduleSlot[] = [];
    for (const slot of slots.slice(slots.indexOf(current))) {
        if (run.length > 0 && slot.startMs !== run[run.length - 1].endMs) break;
        if (slot.assignments[controllableId]?.setBy !== "user") break;
        run.push(slot);
    }
    return run.length === 0 ? null : { startMs: run[0].startMs, endMs: run[run.length - 1].endMs, slots: run };
}

/**
 * Who owns `controllableId` now, in precedence order: execution off, the
 * user's run in progress, an active automation, a disabled one, none.
 *
 * Unknown is never read as "no automation": until the schedule has loaded
 * the answer is loading (unavailable once its read failed), and until the
 * coverage has loaded every answer that needs it is loading too (unavailable
 * once its read failed). The slot in progress is the one the shared clock
 * marked in the normalised slots.
 */
export function controlStatus({
    schedule,
    scheduleFailed,
    coverage,
    coverageFailed,
    controllableId,
}: {
    schedule: { executionEnabled: boolean; slots: readonly ScheduleSlot[] } | null;
    scheduleFailed: boolean;
    coverage: AutomationCoverageIndex | null;
    coverageFailed: boolean;
    controllableId: string;
}): ControlStatus {
    if (schedule === null) return { kind: scheduleFailed ? "unavailable" : "loading" };
    if (!schedule.executionEnabled) return { kind: "execution_off" };
    const run = currentManualRun(schedule.slots, controllableId);
    if (run !== null) return { kind: "manual", untilMs: run.endMs };
    if (coverage === null) return { kind: coverageFailed ? "unavailable" : "loading" };
    const state = getLaneAutomationCoverage(coverage, controllableId).state;
    return { kind: state === "active" ? "automatic" : state === "disabled_only" ? "automation_off" : "not_automated" };
}

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
        .error {
            margin: 0;
            font-size: 0.85rem;
            color: var(--error-color, #c62828);
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

    @state() private _snapshot: ScheduleOwnerSnapshot = EMPTY_SCHEDULE_OWNER_SNAPSHOT;
    @state() private _normalized: NormalizedScheduleModel = EMPTY_NORMALIZED_SCHEDULE;
    @state() private _nowMs = Date.now();
    @state() private _coverage: AutomationCoverageIndex | null = null;
    /** The coverage's last read failed: with no index, its answers are unavailable, not loading. */
    @state() private _coverageFailed = false;
    /** The lane's roster entry; `undefined` until read, `null` when the roster has none. */
    @state() private _controllable: ScheduleControllable | null | undefined = undefined;
    /** The roster could not be read before any read landed: unknown, not absent. */
    @state() private _rosterFailed = false;
    /** The configuration an admin read: what the automation rows show. */
    @state() private _config: JsonObject | null = null;
    /** Why the admin's configuration read failed; the next data change reads again. */
    @state() private _configError: string | null = null;
    /** The optimizer whose switch is being saved. */
    @state() private _savingOptimizer: string | null = null;
    @state() private _dialog: NestedDialog | null = null;
    @state() private _error: string | null = null;

    private _stopFollowing: Array<() => void> = [];
    private readonly _session = new ConfigSession(() => this.hass);
    /** The configuration read that owns its answer: a newer read or a save supersedes an older one. */
    private _configLoad = 0;
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

    constructor() {
        super();
        new DataChangedController(this, () => this.hass, { kinds: ["config"] }, (_kinds, { configRevision }) => {
            if (this._savingOptimizer !== null) return;
            if (this._configError !== null || this._session.isStale(configRevision)) void this._loadOptimizers();
        });
    }

    connectedCallback(): void {
        super.connectedCallback();
        if (this.hass) this._start();
    }

    disconnectedCallback(): void {
        super.disconnectedCallback();
        for (const stop of this._stopFollowing) stop();
        this._stopFollowing = [];
    }

    willUpdate(changed: Map<string, unknown>): void {
        if (changed.has("hass") && this.hass && this.isConnected && this._stopFollowing.length === 0) this._start();
    }

    private get _isAdmin(): boolean {
        return this.hass?.user?.is_admin === true;
    }

    private get _timeZone(): string {
        return timeZone(this.hass);
    }

    private get _locale(): string {
        return resolveLocale(this.hass);
    }

    private _start(): void {
        const owner = getSharedScheduleOwner(this.hass);
        const coverage = getSharedAutomationCoverage(this.hass);
        const store = getSharedHelmanStore(this.hass);
        this._coverage = coverage.get();
        this._coverageFailed = coverage.failed();
        this._stopFollowing = [
            owner.subscribe((snapshot) => {
                this._snapshot = snapshot;
                this._normalized = owner.getNormalized(this._timeZone, this._locale);
                this._nowMs = owner.getNowMs();
            }),
            coverage.subscribe(
                (index) => { this._coverage = index; this._coverageFailed = false; },
                () => { this._coverageFailed = true; },
            ),
            store.subscribeRosterInvalidation(() => void this._loadRoster()),
        ];
        void this._loadRoster();
        if (this._isAdmin) void this._loadOptimizers();
    }

    private async _loadRoster(): Promise<void> {
        try {
            const roster = await getSharedHelmanStore(this.hass).getControllableRoster();
            this._controllable = roster.find((entry) => entry.id === this.controllableId) ?? null;
            this._rosterFailed = false;
            // The live state the Now row reads is the lane's primary entity.
            if (this._controllable) dispatchWatchedEntities(this, `node-detail:control:${this.controllableId}`, [this._controllable.primaryEntityId]);
        } catch (error) {
            console.error("node-control: failed to load the controllable roster", error);
            // A roster read before keeps its answer; with none, the entry is unknown.
            if (this._controllable === undefined) this._rosterFailed = true;
        }
    }

    private async _loadOptimizers(): Promise<void> {
        const load = ++this._configLoad;
        try {
            const { doc } = await this._session.load();
            if (load !== this._configLoad) return;
            this._config = doc ?? null;
            this._configError = null;
        } catch (error) {
            if (load !== this._configLoad) return;
            console.error("node-control: failed to load the configuration", error);
            this._configError = describeError(error);
        }
    }

    /** One optimizer as the configuration read holds it; `undefined` until read or when it has none. */
    private _optimizerRow(optimizerId: string): OptimizerRow | undefined {
        const config = this._config;
        const location = config ? findOptimizerLocations(config, [optimizerId])[0] : undefined;
        const entry = location ? asJsonObject(getValueAtPath(config!, ["automation", location.bucket, location.index])) : undefined;
        return entry ? { kind: stringValue(entry.kind), enabled: booleanValue(entry.enabled, true) } : undefined;
    }

    private _optimizerIds(): readonly string[] {
        return getLaneAutomationCoverage(this._coverage, this.controllableId).optimizerIds;
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    render() {
        const nowMs = this._nowMs;
        const schedule = this._snapshot.schedule;
        const slots = this._normalized.slots;
        const status = controlStatus({
            schedule: schedule ? { executionEnabled: schedule.executionEnabled, slots } : null,
            scheduleFailed: this._snapshot.error !== null,
            coverage: this._coverage,
            coverageFailed: this._coverageFailed,
            controllableId: this.controllableId,
        });
        const run = schedule ? currentManualRun(slots, this.controllableId) : null;
        const writing = this._snapshot.writing;
        const canAuthor = schedule !== null && this._controllable?.supportsAuthoring === true;
        return html`
            <div class="content" data-control=${this.controllableId}>
                ${this.titled ? html`<div class="section-title" data-lane-name>${this._controllable?.name ?? this.controllableId}</div>` : nothing}
                <div class="summary">
                    <div class="status-line">${this._renderStatus(status)}</div>
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
                ${this._rosterFailed ? html`<p class="note" data-roster-failed>${this._t("status.unavailable")}</p>` : nothing}
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
                ${this._isAdmin ? this._renderAutomations() : nothing}
            </div>
            ${this._renderDialog()}
        `;
    }

    /** The status in the authorship tone of who owns the lane. */
    private _renderStatus(status: ControlStatus) {
        const authorship = status.kind === "manual" ? " authorship-decorated authorship-user"
            : status.kind === "automatic" ? " authorship-decorated authorship-automation"
            : "";
        const text = status.kind === "manual"
            ? fillTemplate(this._t("status.manual"), { time: formatScheduleInstantLabel(status.untilMs, {
                currentDayKey: this._normalized.currentDayKey,
                locale: this._locale,
                timeZone: this._timeZone,
                todayLabel: this.localize("scheduling.day.today"),
                tomorrowLabel: this.localize("scheduling.day.tomorrow"),
            }) })
            : this._t(`status.${status.kind}`);
        return html`
            <span class=${`chip action action-tone-neutral status${authorship}`} role="status" data-status=${status.kind}>${text}</span>
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
        const coverage = this._coverage;
        if (coverage === null && this._configError === null) return nothing;
        const ids = this._optimizerIds();
        const editor = getLocalizeFunction(this.hass);
        return html`
            <div class="rows" data-automations>
                <div class="section-title">${this._t("automations")}</div>
                ${this._configError !== null
                    ? html`<p class="error" role="alert" data-config-error>${this._t("config_failed")} ${this._configError}</p>`
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
                                .disabled=${row === undefined || this._savingOptimizer !== null}
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
                .normalized=${this._normalized}
                .executionEnabled=${this._snapshot.schedule?.executionEnabled ?? false}
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
        const slots = owner.getNormalized(this._timeZone, this._locale).slots;
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

    /**
     * Switch one optimizer on or off: read the current document, change only
     * its `enabled` and save with the revision read. A conflict keeps the
     * newer document on screen and saves nothing: the switch is pressed
     * again, deliberately, against what is there now.
     */
    private async _setOptimizerEnabled(optimizerId: string, enabled: boolean): Promise<void> {
        if (this._savingOptimizer !== null) return;
        this._savingOptimizer = optimizerId;
        // A configuration read still in flight is older than this one.
        this._configLoad += 1;
        const editor = getLocalizeFunction(this.hass);
        try {
            const { doc } = await this._session.load();
            const location = doc ? findOptimizerLocations(doc, [optimizerId])[0] : undefined;
            if (!doc || !location) {
                this._config = doc ?? null;
                showToast(this, editor("editor.status.changed_elsewhere"));
                return;
            }
            const next = cloneJson(doc);
            setValueAtPath(next, ["automation", location.bucket, location.index, "enabled"], enabled);
            const outcome = await this._session.save(next);
            switch (outcome.kind) {
                case "saved":
                    this._config = outcome.doc;
                    // Saved, but the integration's reload may still have failed.
                    showToast(this, outcome.response.success
                        ? editor(outcome.response.reloadStarted
                            ? "editor.messages.config_saved_reload_started"
                            : "editor.messages.config_saved")
                        : outcome.response.reloadError ?? editor("editor.messages.config_saved_reload_failed"));
                    break;
                case "conflict":
                    this._config = outcome.doc;
                    showToast(this, editor("editor.status.changed_elsewhere"));
                    break;
                case "invalid":
                    this._config = doc;
                    showToast(this, editor("editor.messages.save_rejected"));
                    break;
                case "error":
                    this._config = doc;
                    showToast(this, `${editor("editor.messages.save_failed")} ${describeError(outcome.error ?? outcome.response?.reloadError ?? "")}`);
                    break;
            }
        } catch (error) {
            showToast(this, `${editor("editor.messages.save_failed")} ${describeError(error)}`);
        } finally {
            this._savingOptimizer = null;
        }
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
