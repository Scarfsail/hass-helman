import type { ReactiveControllerHost } from "lit";
import type { HomeAssistant } from "../../types/ha";
import type { SchedulePayload } from "../helman-api";
import { getSharedScheduleOwner, type SharedScheduleOwner } from "../shared/schedule/schedule-owner";

/** A stretch of the plan, from its start to its end; `null` while open. */
export interface PlanSpan {
    startMs: number;
    endMs: number | null;
}

/**
 * The shared plan as a node detail reads it, and the runs `read` makes of it.
 *
 * A detail opts in through the base's `_useSchedule`: the base subscribes
 * while the detail is started, drops the runs before each update, as they
 * are read off the clock, and renders again once a run starts or ends.
 */
export class ScheduleController<R extends PlanSpan> {
    schedule: SchedulePayload | null = null;
    /** The plan could not be read and none is held. */
    failed = false;

    private _runs?: R[];
    private _owner?: SharedScheduleOwner;
    private _unsubscribe?: () => void;

    constructor(
        private readonly _host: ReactiveControllerHost,
        private readonly _read: (schedule: SchedulePayload, now: number) => R[],
    ) {}

    /** The plan's runs as `read` makes them, once per update. */
    get runs(): R[] {
        return this._runs ??= this.schedule ? this._read(this.schedule, Date.now()) : [];
    }

    start(hass: HomeAssistant): void {
        this._owner = getSharedScheduleOwner(hass);
        this._unsubscribe = this._owner.subscribe((snapshot) => {
            const failed = snapshot.schedule === null && snapshot.error !== null;
            if (snapshot.schedule === this.schedule && failed === this.failed) return;
            this.schedule = snapshot.schedule;
            this.failed = failed;
            this._host.requestUpdate();
        });
    }

    stop(): void {
        this._unsubscribe?.();
        this._unsubscribe = undefined;
    }

    /** Read the plan again, as a retry. */
    refresh(): void {
        void this._owner?.refresh();
    }

    /** Before each update: the runs are read off the clock. */
    reset(): void {
        this._runs = undefined;
    }

    /** Every run's start and end. */
    *boundaries(): Iterable<number> {
        for (const run of this.runs) {
            yield run.startMs;
            if (run.endMs !== null) yield run.endMs;
        }
    }
}
