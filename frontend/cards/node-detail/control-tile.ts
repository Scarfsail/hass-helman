import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import { fillTemplate, type LocalizeFunction } from "../localize/localize";
import { showToast } from "../shared/fire-event";
import { currentManualRun, LaneOwnershipController } from "./lane-ownership";
import type { ControlStatus } from "./lane-ownership";
import { formatScheduleInstantLabel } from "../shared/schedule/model/schedule-time";
import { openScheduleEditorOnLane } from "../shared/schedule/dialogs/scheduling-day-editor-host";
import { buildEntityScheduleLanePatches } from "../shared/schedule/model/entity-day-schedule-model";
import { getSharedScheduleOwner } from "../shared/schedule/schedule-owner";
import { laneDoingNow, laneRuns, nextLaneChange, scheduleReason } from "./node-detail-schedule";
import "./help-tip";
import { nodeDetailSharedStyles } from "./node-detail-shared-styles";

export function ownershipText(status: ControlStatus, localize: LocalizeFunction, locale: string, timeZone: string, currentDayKey: string | null): string {
    if (status.kind === "automatic") return localize("node_detail.shared.helman_schedule");
    if (status.kind === "manual") return fillTemplate(localize("node_detail.shared.you_until"), {
        time: formatScheduleInstantLabel(status.untilMs, {
            currentDayKey,
            locale,
            timeZone,
            todayLabel: localize("scheduling.day.today"),
            tomorrowLabel: localize("scheduling.day.tomorrow"),
        }),
    });
    return localize(`node_detail.control.status.${status.kind}`);
}

/**
 * One lane's control on a node's Overview: who decides it, what the plan has
 * it doing now, the node's own control (slotted, e.g. a mode picker), and
 * Override, which asks the card hosting the detail to open its day editor on
 * this lane alone. While the user's run is in progress, Return to plan
 * releases it to the automation. Rows the node adds go in the `leading` slot.
 */
@customElement("helman-control-tile")
export class HelmanControlTile extends LitElement {
    static styles = [nodeDetailSharedStyles, css`
        .tile { gap: 4px; }
        .row, ::slotted(.row) { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; min-height: 24px; font-size: 14px; }
        .row > :last-child { text-align: end; }
        .label { flex: none; display: inline-flex; align-items: center; font-size: inherit; }
        .section-title { margin-bottom: 4px; }
        ::slotted(:not([slot])) { margin-top: 4px; }
        .actions { display: flex; align-items: center; gap: 4px; margin-top: 8px; }
        .tile .outline-button:hover:not(:disabled) { background: var(--card-background-color); }
        .return { margin-left: auto; min-height: 44px; padding: 4px 0; border: 0; background: none; color: var(--primary-color);
            font: inherit; font-size: 14px; cursor: pointer; }
        .return:disabled { cursor: default; opacity: 0.5; }
    `];
    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property() public controllableId = "";
    /** Headed by the lane's name, for a node with several lanes. */
    @property({ attribute: false }) public titled = false;
    /** The node has a switch tile in its headline, so the help says how to tap and hold it. */
    @property({ attribute: false }) public switchHelp = false;
    @state() private _error: string | null = null;
    private readonly _lanes = new LaneOwnershipController(this, () => this.hass);

    render() {
        const lanes = this._lanes;
        const now = Date.now();
        const schedule = lanes.snapshot.schedule;
        const runs = schedule ? laneRuns(schedule, this.controllableId, now, { byAuthor: true }) : [];
        const next = nextLaneChange(runs, now, lanes.timeZone);
        const time = next ? new Date(next.startMs).toLocaleTimeString(lanes.locale, { hour: "2-digit", minute: "2-digit", timeZone: lanes.timeZone }) : null;
        const doing = schedule
            ? laneDoingNow(schedule, this.controllableId, now, this.localize, lanes.locale, lanes.timeZone, { byAuthor: true })
            : { text: this.localize("node_detail.shared.schedule.none"), run: null };
        const planned = doing.run ? `${doing.text} · ${scheduleReason(doing.run.action, this.localize)}` : doing.text;
        const who = ownershipText(lanes.status(this.controllableId), this.localize, lanes.locale, lanes.timeZone, lanes.normalized.currentDayKey);
        const controllable = lanes.roster?.find((entry) => entry.id === this.controllableId);
        const manual = schedule ? currentManualRun(lanes.normalized.slots, this.controllableId) : null;
        const writing = lanes.snapshot.writing;
        return html`<div class="tile" data-control-tile=${this.controllableId}>
            ${this.titled ? html`<div class="section-title" data-lane-name>${controllable?.name ?? this.controllableId}</div>` : nothing}
            <slot name="leading"></slot>
            <div class="row" data-who><span class="label">${this.localize("node_detail.shared.who")}<helman-help-tip
                .explanation=${!this.switchHelp ? this.localize("node_detail.shared.who_help")
                    : time === null ? this.localize("node_detail.shared.switch_help_no_time") : fillTemplate(this.localize("node_detail.shared.switch_help"), { time })}></helman-help-tip></span><span role="status">${who}</span></div>
            <div class="row" data-planned><span class="label">${this.localize("node_detail.shared.planned_now")}</span><span>${planned}</span></div>
            <slot></slot>
            <div class="actions">
                <button type="button" class="outline-button" data-override ?disabled=${!controllable?.supportsAuthoring || writing} @click=${this._override}>${this.localize("node_detail.shared.override")}</button>
                <helman-help-tip .explanation=${this.localize("node_detail.shared.schedule.buttons_help")}></helman-help-tip>
                ${manual !== null ? html`<button type="button" class="return" data-return ?disabled=${writing} @click=${this._returnToPlan}>${this._t("return_to_plan")}</button>` : nothing}
            </div>
            ${this._error ? html`<p class="error" role="alert" data-error>${this._error}</p>` : nothing}
        </div>`;
    }

    /** Ask the card hosting the detail to open its day editor on this lane alone. */
    private _override = (): void => {
        this._error = null;
        openScheduleEditorOnLane(this, this.controllableId);
    };

    /**
     * Release the user's run in progress back to the automation: its slots
     * from the one in progress lose this lane's user action, and whatever
     * the automation decides fills them. Read at the press, so a slot that
     * elapsed meanwhile is left alone; later separate runs stay.
     */
    private _returnToPlan = async (): Promise<void> => {
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

    private _t(key: string): string {
        return this.localize(`node_detail.control.${key}`);
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-control-tile": HelmanControlTile;
    }
}
