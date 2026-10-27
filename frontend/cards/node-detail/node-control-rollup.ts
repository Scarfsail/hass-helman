import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import type { HomeAssistant } from "../../types/ha";
import type { LocalizeFunction } from "../localize/localize";
import { TreeItem } from "../shared/data/tree-item";
import { fireEvent } from "../shared/fire-event";
import { getValueAtPath, setValueAtPath } from "../shared/config/config-document";
import { booleanValue } from "../shared/config/form-fields";
import type { ScheduleControllable } from "../shared/schedule/model/schedule-appliance-metadata";
import { getSharedScheduleOwner } from "../shared/schedule/schedule-owner";
import { INVERTER_CONTROLLABLE_ID } from "../shared/schedule/schedule-types";
import { schedulingSharedStyles } from "../shared/schedule/styles/scheduling-shared-styles";
import { AdminConfigController } from "./admin-config-controller";
import { LaneOwnershipController } from "./lane-ownership";
import { laneDoingNow } from "./node-detail-schedule";
import "./help-tip";
import { nodeDetailQuestionStyles, nodeDetailSharedStyles } from "./node-detail-shared-styles";
import { NODE_DETAIL_REQUEST_EVENT, type NodeDetailRequestDetail, type NodeDetailTarget } from "./node-detail-types";
import { deviceControllableIds } from "./node-detail-utils";

/** One lane of the house roll-up and the detail whose Schedule section drives it. */
export interface ControlLane {
    controllableId: string;
    target: NodeDetailTarget;
}

/**
 * The house roll-up's lanes: the inverter first when it is configured, then
 * every schedulable controllable of the house tree once, in tree order, each
 * to the first device whose Schedule section drives it. A meter shared by several
 * controllables is one destination for each of its lanes. A device is listed
 * by its configuration, whatever its meter reads now.
 */
export function houseControlLanes(houseNode: TreeItem | null, inverterConfigured: boolean): ControlLane[] {
    const lanes: ControlLane[] = inverterConfigured ? [{ controllableId: INVERTER_CONTROLLABLE_ID, target: "inverter" }] : [];
    const seen = new Set(lanes.map((lane) => lane.controllableId));
    const visit = (items: readonly TreeItem[]) => {
        for (const item of items) {
            for (const controllableId of deviceControllableIds(item)) {
                if (seen.has(controllableId)) continue;
                seen.add(controllableId);
                lanes.push({ controllableId, target: item });
            }
            visit(item.children);
        }
    };
    visit(houseNode?.children ?? []);
    return lanes;
}

/**
 * Resolves the NodeDetailTarget ("inverter" for the inverter lane, or the
 * first TreeItem in the house tree that drives the controllable) for a
 * schedulable controllable, reusing the house roll-up's assignment rule.
 * Returns null for an unmatched controllable.
 */
export function deviceForControllable(houseNode: TreeItem | null | undefined, controllableId: string): NodeDetailTarget | null {
    const lane = houseControlLanes(houseNode ?? null, true).find((lane) => lane.controllableId === controllableId);
    return lane?.target ?? null;
}

/** Ask the power card for a node's detail with its Schedule section expanded. */
function requestControl(node: HTMLElement, target: NodeDetailTarget): void {
    fireEvent<NodeDetailRequestDetail>(node, NODE_DETAIL_REQUEST_EVENT, { target, section: "schedule" });
}

const rollupStyles = css`
    /* The Schedule section's body keeps its own tighter rhythm. */
    .content { gap: 8px; }
    .switch-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        min-height: 40px;
    }
    .lane {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        width: 100%;
        box-sizing: border-box;
        min-height: 44px;
        padding: 6px 8px;
        font: inherit;
        font-size: 0.9rem;
        text-align: left;
        color: var(--primary-text-color);
        background: none;
        border: none;
        border-radius: 8px;
        cursor: pointer;
    }
    .lane:hover {
        background: var(--secondary-background-color);
    }
    .lane:focus-visible {
        outline: 2px solid var(--primary-color);
        outline-offset: -2px;
    }
    .lane-name {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 0;
        overflow-wrap: anywhere;
    }
    .explain {
        color: var(--secondary-text-color);
    }
    .switch-row .label {
        font-size: 14px;
        color: var(--primary-text-color);
    }
    /* A small filled chip, muted; a manual lane tinted in the user's authorship colour. */
    .lane .chip.status {
        flex: none;
        min-height: 0;
        padding: 3px 10px;
        font-size: 12px;
        border: none;
        box-shadow: none;
        background: var(--secondary-background-color);
        color: var(--secondary-text-color);
    }
    .lane .chip.status.authorship-user {
        background: color-mix(in srgb, var(--schedule-authorship-color) 22%, transparent);
        color: var(--schedule-authorship-color);
    }
    .lane-device {
        font-size: 0.8rem;
        color: var(--secondary-text-color);
    }
`;

/**
 * The house's Schedule section: who controls each lane of the house now and
 * what it is doing, one row per lane so that lanes owned differently are
 * never summed into one status, then the system switches. A row opens its
 * device's detail with the Schedule section expanded.
 *
 * Schedule execution is the shared schedule owner's switch, for everyone the
 * schedule endpoint lets write it. The automation master switch is an
 * admin's: only then is the config read, and the switch saves its one flag
 * against the revision read at the press. Either shows the stored state, so
 * a failed write never leaves the switch flipped.
 */
@customElement("helman-house-control")
export class HelmanHouseControl extends LitElement {
    static styles = [nodeDetailSharedStyles, nodeDetailQuestionStyles, schedulingSharedStyles, rollupStyles];

    @property({ attribute: false }) public hass!: HomeAssistant;
    @property({ attribute: false }) public localize!: LocalizeFunction;
    @property({ attribute: false }) public houseNode: TreeItem | null = null;

    @state() private _executionError: string | null = null;
    /** An execution write pressed and not yet answered, queued or in flight: no second press until it is. */
    @state() private _executionPending = false;

    private readonly _lanes = new LaneOwnershipController(this, () => this.hass);
    private readonly _config = new AdminConfigController(this, () => this.hass);

    render() {
        const lanes = this._lanes;
        const schedule = lanes.snapshot.schedule;
        const roster = lanes.roster;
        const rows = roster === null ? [] : houseControlLanes(this.houseNode, roster.some((entry) => entry.id === INVERTER_CONTROLLABLE_ID));
        return html`
            <div class="content" data-house-control>
                <div class="rows" data-lanes>
                    <div class="section-title">${this._t("lanes")}<helman-help-tip .explanation=${this._t("lanes_help")}></helman-help-tip></div>
                    ${roster === null
                        ? html`<p class="note" data-roster-pending>${this.localize(`node_detail.control.status.${lanes.rosterFailed ? "unavailable" : "loading"}`)}</p>`
                        : nothing}
                    ${rows.map((row) => this._renderLane(row, roster))}
                    ${rows.length === 0 && roster !== null ? html`<p class="note" data-no-lanes>${this._t("no_lanes")}</p>` : nothing}
                </div>
                <div class="rows" data-system>
                    <div class="section-title">${this._t("system")}</div>
                    ${this._config.isAdmin ? this._renderAutomationSwitch() : nothing}
                    <div class="switch-row" data-execution>
                        <span class="label">${this._t("execution")} <span class="explain">${this._t("execution_explain")}</span></span>
                        <ha-switch
                            .checked=${live(schedule?.executionEnabled ?? false)}
                            .disabled=${schedule === null || lanes.snapshot.togglingExecution || this._executionPending}
                            aria-label=${this._t("execution")}
                            @change=${(event: Event) => void this._setExecution((event.currentTarget as HTMLInputElement).checked)}
                        ></ha-switch>
                    </div>
                    ${this._executionError ? html`<p class="error" role="alert" data-execution-error>${this._executionError}</p>` : nothing}
                </div>
            </div>
        `;
    }

    private _renderAutomationSwitch() {
        const config = this._config.config;
        // As the backend reads it: no automation block is off, a block without the flag is on.
        const enabled = config !== null && getValueAtPath(config, ["automation"]) !== undefined
            && booleanValue(getValueAtPath(config, ["automation", "enabled"]), true);
        return html`
            <div class="switch-row" data-automation>
                <span class="label">${this._t("automation")} <span class="explain">${this._t("automation_explain")}</span></span>
                <ha-switch
                    .checked=${live(enabled)}
                    .disabled=${config === null || this._config.saving !== null}
                    aria-label=${this._t("automation")}
                    @change=${(event: Event) => this._setAutomation((event.currentTarget as HTMLInputElement).checked)}
                ></ha-switch>
            </div>
            ${this._config.error !== null
                ? html`<p class="error" role="alert" data-config-error>${this.localize("node_detail.control.config_failed")} ${this._config.error}</p>`
                : nothing}
        `;
    }

    /**
     * A lane by its roster name and what it is doing now, under the device it
     * belongs to when that is named otherwise, with who owns it.
     */
    private _renderLane(lane: ControlLane, roster: readonly ScheduleControllable[] | null) {
        const name = roster?.find((entry) => entry.id === lane.controllableId)?.name ?? lane.controllableId;
        const device = typeof lane.target === "string" ? null : lane.target.displayName || lane.target.name;
        const doing = this._doing(lane.controllableId);
        return html`
            <button type="button" class="lane" data-lane=${lane.controllableId} @click=${() => requestControl(this, lane.target)}>
                <span class="lane-name">
                    <span><span data-lane-name>${name}</span>${doing ? html` <span class="explain" data-lane-doing>· ${doing}</span>` : nothing}</span>
                    ${device !== null && device !== name ? html`<span class="lane-device" data-lane-device>${device}</span>` : nothing}
                </span>
                ${this._lanes.renderStatus(this._lanes.status(lane.controllableId), this.localize)}
            </button>
        `;
    }

    /** What the lane is doing now by the plan, and until when; `null` before the plan is read. */
    private _doing(controllableId: string): string | null {
        const schedule = this._lanes.snapshot.schedule;
        if (!schedule) return null;
        return laneDoingNow(schedule, controllableId, Date.now(), this.localize, this._lanes.locale, this._lanes.timeZone).text;
    }

    private _setAutomation(enabled: boolean): void {
        void this._config.save("automation", (doc) => {
            setValueAtPath(doc, ["automation", "enabled"], enabled);
            return true;
        });
    }

    private async _setExecution(enabled: boolean): Promise<void> {
        if (this._executionPending) return;
        this._executionPending = true;
        this._executionError = null;
        try {
            const error = await getSharedScheduleOwner(this.hass).setExecutionEnabled(enabled);
            if (error) this._executionError = `${this._t("execution_failed")} ${error.message}`;
        } finally {
            this._executionPending = false;
        }
    }

    private _t(key: string): string {
        return this.localize(`node_detail.control.house.${key}`);
    }
}

declare global {
    interface HTMLElementTagNameMap {
        "helman-house-control": HelmanHouseControl;
    }
}
