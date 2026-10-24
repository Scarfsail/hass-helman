import { html, type ReactiveController, type ReactiveControllerHost, type TemplateResult } from "lit";
import type { HomeAssistant } from "../../types/ha";
import { fillTemplate, type LocalizeFunction } from "../localize/localize";
import { getSharedHelmanStore } from "../shared/data/store";
import { resolveLocale } from "../shared/resolve-locale";
import {
    getLaneAutomationCoverage,
    getSharedAutomationCoverage,
    type AutomationCoverageIndex,
} from "../shared/optimizer/automation-coverage";
import type { ScheduleControllable } from "../shared/schedule/model/schedule-appliance-metadata";
import { EMPTY_NORMALIZED_SCHEDULE, findCurrentScheduleSlot } from "../shared/schedule/model/schedule-normalizer";
import { formatScheduleInstantLabel } from "../shared/schedule/model/schedule-time";
import { EMPTY_SCHEDULE_OWNER_SNAPSHOT, getSharedScheduleOwner } from "../shared/schedule/schedule-owner";
import type { NormalizedScheduleModel, ScheduleOwnerSnapshot, ScheduleSlot } from "../shared/schedule/schedule-types";
import { timeZone } from "./section-resource";

/** Who owns a lane right now, as the Schedule tab names it. */
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

/**
 * The shared plan, automation coverage and roster a Control view reads who
 * owns a lane from, followed while its host is in the page. Each answer
 * re-renders the host.
 */
export class LaneOwnershipController implements ReactiveController {
    public snapshot: ScheduleOwnerSnapshot = EMPTY_SCHEDULE_OWNER_SNAPSHOT;
    public normalized: NormalizedScheduleModel = EMPTY_NORMALIZED_SCHEDULE;
    public nowMs = Date.now();
    public coverage: AutomationCoverageIndex | null = null;
    /** The coverage's last read failed: with no index, its answers are unavailable, not loading. */
    public coverageFailed = false;
    /** The roster; `null` until read. A later failed read keeps the last one. */
    public roster: readonly ScheduleControllable[] | null = null;
    /** The roster could not be read before any read landed: unknown, not absent. */
    public rosterFailed = false;

    private _stopFollowing: Array<() => void> = [];

    constructor(
        private readonly _host: ReactiveControllerHost,
        private readonly _hass: () => HomeAssistant | undefined,
        /** Called after each roster read lands. */
        private readonly _onRoster?: (roster: readonly ScheduleControllable[]) => void,
    ) {
        _host.addController(this);
    }

    hostConnected(): void {
        this._start();
    }

    hostUpdate(): void {
        this._start();
    }

    hostDisconnected(): void {
        for (const stop of this._stopFollowing) stop();
        this._stopFollowing = [];
    }

    public get timeZone(): string {
        return timeZone(this._hass()!);
    }

    public get locale(): string {
        return resolveLocale(this._hass());
    }

    /** Who owns `controllableId` now, from what has been read so far. */
    public status(controllableId: string): ControlStatus {
        const schedule = this.snapshot.schedule;
        return controlStatus({
            schedule: schedule ? { executionEnabled: schedule.executionEnabled, slots: this.normalized.slots } : null,
            scheduleFailed: this.snapshot.error !== null,
            coverage: this.coverage,
            coverageFailed: this.coverageFailed,
            controllableId,
        });
    }

    /** The status in the authorship tone of who owns the lane. */
    public renderStatus(status: ControlStatus, localize: LocalizeFunction): TemplateResult {
        const authorship = status.kind === "manual" ? " authorship-decorated authorship-user"
            : status.kind === "automatic" ? " authorship-decorated authorship-automation"
            : "";
        const text = status.kind === "manual"
            ? fillTemplate(localize("node_detail.control.status.manual"), { time: formatScheduleInstantLabel(status.untilMs, {
                currentDayKey: this.normalized.currentDayKey,
                locale: this.locale,
                timeZone: this.timeZone,
                todayLabel: localize("scheduling.day.today"),
                tomorrowLabel: localize("scheduling.day.tomorrow"),
            }) })
            : localize(`node_detail.control.status.${status.kind}`);
        return html`<span class=${`chip action action-tone-neutral status${authorship}`} data-status=${status.kind}>${text}</span>`;
    }

    private _start(): void {
        const hass = this._hass();
        if (!hass || this._stopFollowing.length > 0) return;
        const owner = getSharedScheduleOwner(hass);
        const coverage = getSharedAutomationCoverage(hass);
        const store = getSharedHelmanStore(hass);
        this.coverage = coverage.get();
        this.coverageFailed = coverage.failed();
        this._stopFollowing = [
            owner.subscribe((snapshot) => {
                this.snapshot = snapshot;
                this.normalized = owner.getNormalized(this.timeZone, this.locale);
                this.nowMs = owner.getNowMs();
                this._host.requestUpdate();
            }),
            coverage.subscribe(
                (index) => { this.coverage = index; this.coverageFailed = false; this._host.requestUpdate(); },
                () => { this.coverageFailed = true; this._host.requestUpdate(); },
            ),
            store.subscribeRosterInvalidation(() => void this._loadRoster()),
        ];
        void this._loadRoster();
    }

    private async _loadRoster(): Promise<void> {
        const hass = this._hass();
        if (!hass) return;
        try {
            this.roster = await getSharedHelmanStore(hass).getControllableRoster();
            this.rosterFailed = false;
            this._onRoster?.(this.roster);
        } catch (error) {
            console.error("lane-ownership: failed to load the controllable roster", error);
            if (this.roster === null) this.rosterFailed = true;
        }
        this._host.requestUpdate();
    }
}
