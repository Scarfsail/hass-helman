import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import type { HomeAssistant } from "../../types/ha";
import type { ScheduleControllableActionDTO } from "../helman-api";
import { fillTemplate, getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import { DialogHistoryController } from "../shared/dialog-history-controller";
import { fireEvent, showToast } from "../shared/fire-event";
import { asJsonObject, getValueAtPath, setValueAtPath } from "../shared/config/config-document";
import { booleanValue, stringValue } from "../shared/config/form-fields";
import "../shared/mode-strip";
import { modeStripWindow, type ModeSegment } from "../shared/mode-strip";
import { getLaneAutomationCoverage } from "../shared/optimizer/automation-coverage";
import { findOptimizerLocations } from "../shared/optimizer/optimizer-locations";
import type { HelmanOptimizerEditDialog } from "../shared/optimizer/helman-optimizer-edit-dialog";
import { getScheduleActionTone, type ScheduleActionTone } from "../shared/schedule/action-tones";
import { OPEN_SCHEDULE_EDITOR_EVENT, type OpenScheduleEditorDetail } from "../shared/schedule/dialogs/scheduling-day-editor-host";
import { buildEntityScheduleLanePatches } from "../shared/schedule/model/entity-day-schedule-model";
import { getScheduleApplianceActionPresentation } from "../shared/schedule/model/schedule-appliance-action-presentation";
import {
    describeScheduleAppliance,
    asScheduleAppliance,
    type ScheduleControllable,
} from "../shared/schedule/model/schedule-appliance-metadata";
import { formatScheduleTime } from "../shared/schedule/model/schedule-time";
import { getSharedScheduleOwner } from "../shared/schedule/schedule-owner";
import { INVERTER_CONTROLLABLE_ID, isScheduleApplianceActionEnabled, isScheduleInverterAction } from "../shared/schedule/schedule-types";
import { schedulingSharedStyles } from "../shared/schedule/styles/scheduling-shared-styles";
import { AdminConfigController } from "./admin-config-controller";
import { currentManualRun, LaneOwnershipController } from "./lane-ownership";
import { effectiveLaneAction, inverterModeLabel, laneActionLabel, laneRuns, upcomingLaneChanges, type LaneChange } from "./node-detail-schedule";
import { NO_LANE_HISTORY, type LaneHistory } from "./node-detail-types";
import { nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";
import "../shared/optimizer/helman-optimizer-edit-dialog";
import type { ControlOverrideDialog } from "./control-override-dialog";
import "./control-override-dialog";
import "./help-tip";

/** One optimizer driving the lane, as its config reads. */
interface OptimizerRow {
    kind: string;
    enabled: boolean;
}

type NestedDialog = { kind: "override" } | { kind: "optimizer"; optimizerId: string };

/**
 * The Schedule section of a lane: the plan from today to noon tomorrow as a
 * strip, the changes coming today and tomorrow, Edit blocks and Override,
 * who owns the lane now and the automations that drive it.
 *
 * The plan, the coverage and the roster are the shared ones, followed while
 * the section is in the page. What happened before now is the host's:
 * `history`, from the detail that reads it. "Edit blocks" asks the card
 * hosting the detail to open its day editor on this lane. An override is a
 * user-authored stretch of the schedule written through the same patches as
 * the day editor, so it never writes to the hardware itself, and with
 * execution off says so.
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
            gap: 8px 12px;
        }
        .status {
            font-weight: 600;
        }
        .changes .row {
            font-size: 14px;
        }
        .changes .when {
            font-weight: 600;
            font-variant-numeric: tabular-nums;
        }
        .changes .what {
            display: inline-block;
        }
        .changes .what::first-letter {
            text-transform: uppercase;
        }
        .changes .why {
            color: var(--secondary-text-color);
            text-align: end;
        }
        .actions {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px;
        }
        .return {
            min-height: 36px;
            padding: 4px 14px;
        }
        .optimizer {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
        }
        .optimizer .link-button {
            min-width: 0;
            min-height: 36px;
            padding: 4px 0;
            border: none;
            background: none;
            font-size: 14px;
            text-align: left;
            overflow-wrap: anywhere;
        }
    `];

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    /** The lane controlled, by its controllable id. */
    @property({ attribute: false }) public controllableId!: string;
    /** The battery's section: the inverter's lane, titled and explained as such. */
    @property({ attribute: false }) public battery = false;
    /** Headed by the lane's name, for a node with several lanes. */
    @property({ attribute: false }) public titled = false;
    /** What the lane did today before now, from the detail that reads it. */
    @property({ attribute: false }) public history: LaneHistory = NO_LANE_HISTORY;

    @state() private _dialog: NestedDialog | null = null;
    @state() private _error: string | null = null;

    /** The plan, the coverage and the roster, followed while the section is in the page. */
    private readonly _lanes = new LaneOwnershipController(this, () => this.hass);
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
        const schedule = lanes.snapshot.schedule;
        const run = schedule ? currentManualRun(lanes.normalized.slots, this.controllableId) : null;
        const writing = lanes.snapshot.writing;
        const canAuthor = schedule !== null && this._controllable?.supportsAuthoring === true;
        return html`
            <div class="content" data-control=${this.controllableId}>
                ${this.titled ? html`<div class="section-title" data-lane-name>${this._controllable?.name ?? this.controllableId}</div>` : nothing}
                ${schedule ? this._renderPlan() : nothing}
                ${this._controllable === null ? html`<p class="note" data-not-on-roster>${this._t("not_on_roster")}</p>` : nothing}
                ${lanes.rosterFailed ? html`<p class="note" data-roster-failed>${this._t("status.unavailable")}</p>` : nothing}
                ${this._controllable?.supportsAuthoring === false ? html`<p class="note" data-unsupported>${this._t("unsupported_authoring")}</p>` : nothing}
                ${canAuthor ? html`
                    <div class="actions">
                        <button type="button" class="outline-button" data-edit-blocks @click=${this._editBlocks}>${this._s("edit_blocks")}</button>
                        <button type="button" class="outline-button" data-change ?disabled=${writing} @click=${() => this._openDialog({ kind: "override" })}>
                            ${this.localize("node_detail.shared.override")}
                        </button>
                        <helman-help-tip .explanation=${this._s("buttons_help")}></helman-help-tip>
                    </div>
                ` : nothing}
                <div class="status-line" role="status">
                    ${lanes.renderStatus(lanes.status(this.controllableId), this.localize)}
                    ${run !== null ? html`
                        <button type="button" class="outline-button return" data-return ?disabled=${writing} @click=${this._returnToAutomatic}>
                            ${this._t("return_to_automatic")}
                        </button>
                    ` : nothing}
                </div>
                ${schedule && !schedule.executionEnabled
                    ? html`<p class="note" data-execution-off>${this._t("execution_off_note")}</p>`
                    : nothing}
                ${this._error ? html`<p class="error" role="alert" data-error>${this._error}</p>` : nothing}
                ${this._config.isAdmin ? this._renderAutomations() : nothing}
            </div>
            ${this._renderDialog()}
        `;
    }

    /**
     * The strip, today to noon tomorrow: what happened, then the plan from
     * now; and the changes coming today and tomorrow. On the inverter's own
     * detail the two are rows of their own.
     */
    private _renderPlan() {
        const schedule = this._lanes.snapshot.schedule!;
        const now = Date.now();
        const zone = this._lanes.timeZone;
        const locale = this._lanes.locale;
        const { start, end } = modeStripWindow(now, zone);
        const inverter = this.controllableId === INVERTER_CONTROLLABLE_ID;
        const title = inverter ? this._s(this.battery ? "strip_battery" : "strip_inverter") : this._s("strip");
        const changes = upcomingLaneChanges(laneRuns(schedule, this.controllableId, now, { byAuthor: true }), now, zone);
        return html`
            <div class="section-title" data-strip-title>${title}${this.battery
                ? html`<helman-help-tip .explanation=${this._s("battery_help")}></helman-help-tip>` : nothing}</div>
            <helman-mode-strip
                .start=${start}
                .end=${end}
                .now=${now}
                .history=${this.history.segments}
                .segments=${this._planSegments(laneRuns(schedule, this.controllableId, now), inverter)}
                .rows=${inverter && !this.battery ? { happened: this._s("happened"), planned: this._s("planned") } : null}
                .nowLabel=${this.localize("node_detail.shared.now")}
                .timeZone=${zone}
                .locale=${locale}
            ></helman-mode-strip>
            ${this.history.note ? html`
                <p class="note" data-history-note>${this.history.note}${this.history.retry ? html`
                    <button type="button" class="link-button" data-history-retry @click=${this.history.retry.load}>${this.history.retry.label}</button>` : nothing}</p>
            ` : nothing}
            <div class="rows changes" data-changes>
                ${changes.length === 0 ? html`<p class="note" data-no-changes>${this._s("no_changes")}</p>` : changes.map((change) => html`
                    <div class="row" data-change-row data-candidate=${change.candidate ? "true" : "false"}>
                        <span><span class="when">${formatScheduleTime(change.startMs, locale, zone)}${change.candidate && change.endMs !== null
                            ? `–${formatScheduleTime(change.endMs, locale, zone)}` : ""}</span>
                            <span class="what">${laneActionLabel(change.action, this.localize, this._applianceKind())}</span></span>
                        <span class="why">${this._why(change)}</span>
                    </div>
                `)}
            </div>
        `;
    }

    /** The lane's appliance kind; `null` for the inverter. */
    private _applianceKind(): string | null {
        return this.controllableId === INVERTER_CONTROLLABLE_ID ? null : this._controllable?.kind ?? null;
    }

    /**
     * Who set a change: you, or Helman's schedule (the plan does not name the
     * optimizer); that it is a candidate; or the default, for the lane at rest.
     */
    private _why(change: LaneChange): string {
        if (change.candidate) return this._s("candidate");
        if (change.action.setBy === "user") return this.localize("node_detail.shared.you");
        return change.atRest ? this._s("default") : this.localize("node_detail.shared.helman_schedule");
    }

    /**
     * The plan's runs from now as the strip draws them: each effective action
     * in its tone, a candidate dashed with the action it would take. An
     * appliance at rest is a gap; the inverter at rest is its normal mode.
     */
    private _planSegments(runs: ReturnType<typeof laneRuns>, inverter: boolean): ModeSegment[] {
        const segments: ModeSegment[] = [];
        for (const run of runs) {
            const candidate = run.action.conditionMet === false;
            const action = candidate ? run.action : effectiveLaneAction(run.action, inverter);
            if (!inverter && (isScheduleInverterAction(action) || isScheduleApplianceActionEnabled(action) !== true)) continue;
            // The inverter's modes by their short names, as the observed modes are.
            const label = isScheduleInverterAction(action) ? inverterModeLabel(this.localize, action.kind) : laneActionLabel(action, this.localize);
            segments.push({
                start: run.startMs,
                end: run.endMs ?? Infinity,
                tone: candidate ? "neutral" : this._tone(action),
                label: candidate ? `${label} · ${this._s("candidate")}` : label,
                candidate,
            });
        }
        return segments;
    }

    /** The scheduler's tone for an action on this lane. */
    private _tone(action: ScheduleControllableActionDTO): ScheduleActionTone {
        if (isScheduleInverterAction(action)) return getScheduleActionTone(action.kind);
        const appliance = this._controllable ? asScheduleAppliance(this._controllable) : null;
        return appliance
            ? getScheduleApplianceActionPresentation({ appliance: describeScheduleAppliance(appliance), action, localize: this.localize }).tone
            : "neutral";
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
                                ${name}
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

    /** Ask the card hosting the detail to open its day editor on this lane. */
    private _editBlocks = (): void => {
        fireEvent<OpenScheduleEditorDetail>(this, OPEN_SCHEDULE_EDITOR_EVENT, { target: this.controllableId });
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

    private _s(key: string): string {
        return this.localize(`node_detail.shared.schedule.${key}`);
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-node-control": HelmanNodeControl;
    }
}
