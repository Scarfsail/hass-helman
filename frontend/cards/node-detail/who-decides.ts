import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import { fillTemplate, type LocalizeFunction } from "../localize/localize";
import { LaneOwnershipController } from "./lane-ownership";
import type { ControlStatus } from "./lane-ownership";
import { formatScheduleTime } from "../shared/schedule/model/schedule-time";
import { DialogHistoryController } from "../shared/dialog-history-controller";
import { laneDoingNow, laneRuns, nextLaneChange, scheduleReason } from "./node-detail-schedule";
import type { ControlOverrideDialog } from "./control-override-dialog";
import "./help-tip";
import { nodeDetailSharedStyles } from "./node-detail-shared-styles";
import "./control-override-dialog";

export function ownershipText(status: ControlStatus, localize: LocalizeFunction, locale: string, timeZone: string): string {
    if (status.kind === "automatic") return localize("node_detail.shared.helman_schedule");
    if (status.kind === "manual") return fillTemplate(localize("node_detail.shared.you_until"), {
        time: formatScheduleTime(status.untilMs, locale, timeZone),
    });
    return localize(`node_detail.control.status.${status.kind}`);
}

@customElement("helman-who-decides")
export class HelmanWhoDecides extends LitElement {
    static styles = [nodeDetailSharedStyles, css`
        .tile { gap: 4px; }
        .row { display: flex; justify-content: space-between; gap: 12px; min-height: 24px; }
        .row > :last-child { text-align: end; }
        .label { flex: none; display: inline-flex; align-items: center; }
        .outline-button { margin-top: 8px; }
        .tile .outline-button:hover:not(:disabled) { background: var(--card-background-color); }
    `];
    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property() public controllableId = "";
    @state() private _overrideOpen = false;
    private readonly _lanes = new LaneOwnershipController(this, () => this.hass);
    private readonly _history = new DialogHistoryController(this, "__helmanWhoDecidesOverrideId", {
        onBack: () => {
            const dialog = this.renderRoot.querySelector<ControlOverrideDialog>("control-override-dialog");
            if (dialog === null) return false;
            queueMicrotask(() => dialog.requestClose());
            return true;
        },
        close: () => { this._overrideOpen = false; },
    });
    private _openOverride(): void {
        this._overrideOpen = true;
        this._history.push();
    }
    private _onOverrideClosed = (): void => {
        this._history.closed();
        this._overrideOpen = false;
    };
    render() {
        const now = Date.now();
        const schedule = this._lanes.snapshot.schedule;
        const runs = schedule ? laneRuns(schedule, this.controllableId, now, { byAuthor: true }) : [];
        const next = nextLaneChange(runs, now, this._lanes.timeZone);
        const time = next ? new Date(next.startMs).toLocaleTimeString(this._lanes.locale, { hour: "2-digit", minute: "2-digit", timeZone: this._lanes.timeZone }) : null;
        const doing = schedule
            ? laneDoingNow(schedule, this.controllableId, now, this.localize, this._lanes.locale, this._lanes.timeZone, { byAuthor: true })
            : { text: this.localize("node_detail.shared.schedule.none"), run: null };
        const planned = doing.run ? `${doing.text} · ${scheduleReason(doing.run.action, this.localize)}` : doing.text;
        const status = this._lanes.status(this.controllableId);
        const who = ownershipText(status, this.localize, this._lanes.locale, this._lanes.timeZone);
        const controllable = this._lanes.roster?.find((entry) => entry.id === this.controllableId);
        return html`<div class="tile">
            <div class="row"><span class="label">${this.localize("node_detail.shared.who")}<helman-help-tip
                .explanation=${time === null ? this.localize("node_detail.shared.switch_help_no_time") : fillTemplate(this.localize("node_detail.shared.switch_help"), { time })}></helman-help-tip></span><span>${who}</span></div>
            <div class="row"><span class="label">${this.localize("node_detail.shared.planned_now")}</span><span>${planned}</span></div>
            <button type="button" class="outline-button" ?disabled=${!controllable?.supportsAuthoring} @click=${this._openOverride}>${this.localize("node_detail.shared.override")}</button>
            </div>
            ${this._overrideOpen && controllable ? html`<control-override-dialog .hass=${this.hass} .localize=${this.localize}
                .controllable=${controllable} .normalized=${this._lanes.normalized}
                .executionEnabled=${schedule?.executionEnabled ?? false} .open=${true}
                @closed=${this._onOverrideClosed}></control-override-dialog>` : nothing}`;
    }
}
