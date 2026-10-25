import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import { fillTemplate, type LocalizeFunction } from "../localize/localize";
import { LaneOwnershipController } from "./lane-ownership";
import type { ControlStatus } from "./lane-ownership";
import { formatScheduleTime } from "../shared/schedule/model/schedule-time";
import { DialogHistoryController } from "../shared/dialog-history-controller";
import { effectiveLaneAction, laneActionLabel, laneRuns, nextLaneChange } from "./node-detail-schedule";
import type { ControlOverrideDialog } from "./control-override-dialog";
import "./help-tip";
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
    static styles = css`
        :host { display: block; padding: 12px; border-radius: 8px; background: var(--secondary-background-color); }
        .row { display: flex; justify-content: space-between; gap: 12px; min-height: 28px; }
        .label { color: var(--secondary-text-color); }
        .actions { display: flex; align-items: center; gap: 4px; margin-top: 8px; }
        button { border: 1px solid var(--divider-color); border-radius: 6px; background: var(--card-background-color);
            color: var(--primary-text-color); font: inherit; padding: 6px 10px; cursor: pointer; }
    `;
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
        const runs = schedule ? laneRuns(schedule, this.controllableId, now) : [];
        const current = runs.find((run) => run.startMs <= now && (run.endMs === null || now < run.endMs));
        const next = nextLaneChange(runs, now, this._lanes.timeZone);
        const action = current ? laneActionLabel(effectiveLaneAction(current.action), this.localize) : this.localize("node_detail.control.nothing_scheduled");
        const time = next ? new Date(next.startMs).toLocaleTimeString(this._lanes.locale, { hour: "2-digit", minute: "2-digit", timeZone: this._lanes.timeZone }) : "—";
        const until = current?.endMs === null || current?.endMs === undefined ? null
            : formatScheduleTime(current.endMs, this._lanes.locale, this._lanes.timeZone);
        const reason = current?.action.setBy === "user"
            ? this.localize("node_detail.shared.you") : this.localize("node_detail.shared.helman_schedule");
        const planned = current
            ? `${action}${until ? `, ${fillTemplate(this.localize("node_detail.shared.until"), { time: until })}` : ""} · ${reason}`
            : action;
        const status = this._lanes.status(this.controllableId);
        const who = ownershipText(status, this.localize, this._lanes.locale, this._lanes.timeZone);
        const controllable = this._lanes.roster?.find((entry) => entry.id === this.controllableId);
        return html`<div class="row"><span class="label">${this.localize("node_detail.shared.who")}</span><strong>${who}</strong></div>
            <div class="row"><span class="label">${this.localize("node_detail.shared.planned_now")}</span><span>${planned}</span></div>
            <div class="actions"><button type="button" ?disabled=${!controllable?.supportsAuthoring} @click=${this._openOverride}>${this.localize("node_detail.shared.override")}</button>
                <helman-help-tip .explanation=${fillTemplate(this.localize("node_detail.shared.switch_help"), { time })}></helman-help-tip></div>
            ${this._overrideOpen && controllable ? html`<control-override-dialog .hass=${this.hass} .localize=${this.localize}
                .controllable=${controllable} .normalized=${this._lanes.normalized}
                .executionEnabled=${schedule?.executionEnabled ?? false} .open=${true}
                @closed=${this._onOverrideClosed}></control-override-dialog>` : nothing}`;
    }
}
