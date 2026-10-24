import type { HomeAssistant } from "../../../types/ha";
import type { SchedulePayload } from "../../helman-api";
import { getSharedDataChangedFeed } from "../data/data-changed";
import { getSharedHelmanStore, type HelmanStore } from "../data/store";
import { startNowClock } from "../now-clock";
import { NormalizedScheduleCache } from "./model/schedule-normalizer";
import { getNextScheduleBoundaryDelayMs } from "./model/schedule-time";
import type {
    ScheduleOwnerError,
    ScheduleOwnerSnapshot,
    ScheduleSlotPatch,
    NormalizedScheduleModel,
} from "./schedule-types";

const BOUNDARY_BUFFER_MS = 50;

type ScheduleConnection = HomeAssistant["connection"];
type ScheduleOwnerListener = (snapshot: ScheduleOwnerSnapshot) => void;

const scheduleOwners = new WeakMap<ScheduleConnection, ScheduleOwnerImpl>();

/**
 * Frozen because it is shared: it is the starting snapshot of every owner, and
 * the object every pre-first-emit `getSnapshot()` hands out.
 */
export const EMPTY_SCHEDULE_OWNER_SNAPSHOT: ScheduleOwnerSnapshot = Object.freeze({
    schedule: null,
    loading: false,
    refreshing: false,
    writing: false,
    togglingExecution: false,
    error: null,
    updatedAt: null,
    stale: false,
});

export interface SharedScheduleOwner {
    getSnapshot(): ScheduleOwnerSnapshot;
    getNowMs(): number;
    getNormalized(timeZone: string, locale: string): NormalizedScheduleModel;
    subscribe(listener: ScheduleOwnerListener): () => void;
    refresh(): Promise<void>;
    /** Write the batch and commit the schedule it returns. Resolves with the write's error, or null. */
    applySchedulePatches(
        patches: readonly ScheduleSlotPatch[],
    ): Promise<ScheduleOwnerError | null>;
    /** Switch execution and commit the schedule it returns. Resolves with the write's error, or null. */
    setExecutionEnabled(enabled: boolean): Promise<ScheduleOwnerError | null>;
}

export function getSharedScheduleOwner(hass: HomeAssistant): SharedScheduleOwner {
    let owner = scheduleOwners.get(hass.connection);
    if (!owner) {
        owner = new ScheduleOwnerImpl(hass);
        scheduleOwners.set(hass.connection, owner);
    } else {
        owner.updateHass(hass);
    }

    return owner;
}

class ScheduleOwnerImpl implements SharedScheduleOwner {
    private _hass: HomeAssistant;
    private _helmanStore: HelmanStore;
    private _schedule: SchedulePayload | null = EMPTY_SCHEDULE_OWNER_SNAPSHOT.schedule;
    private _loading = EMPTY_SCHEDULE_OWNER_SNAPSHOT.loading;
    private _refreshing = EMPTY_SCHEDULE_OWNER_SNAPSHOT.refreshing;
    private _writing = EMPTY_SCHEDULE_OWNER_SNAPSHOT.writing;
    private _togglingExecution = EMPTY_SCHEDULE_OWNER_SNAPSHOT.togglingExecution;
    private _error = EMPTY_SCHEDULE_OWNER_SNAPSHOT.error;
    private _updatedAt = EMPTY_SCHEDULE_OWNER_SNAPSHOT.updatedAt;
    private _stale = EMPTY_SCHEDULE_OWNER_SNAPSHOT.stale;
    private _snapshot: ScheduleOwnerSnapshot = EMPTY_SCHEDULE_OWNER_SNAPSHOT;
    private _request: Promise<void> | null = null;
    private _mutationRequest: Promise<void> | null = null;
    /** A refresh was asked for while a mutation was in flight. */
    private _refreshAfterMutation = false;
    private _boundaryTimer: number | null = null;
    private _stopNowClock: (() => void) | null = null;
    private _nowMs = Date.now();
    private readonly _normalizedCache = new NormalizedScheduleCache();
    private _unsubscribeDataChanged: (() => void) | null = null;
    private readonly _listeners = new Set<ScheduleOwnerListener>();

    constructor(hass: HomeAssistant) {
        this._hass = hass;
        this._helmanStore = getSharedHelmanStore(hass);
    }

    public updateHass(hass: HomeAssistant): void {
        const previousTimeZone = _normalizeTimeZone(this._hass.config.time_zone);
        const nextTimeZone = _normalizeTimeZone(hass.config.time_zone);
        this._hass = hass;
        this._helmanStore = getSharedHelmanStore(hass);

        if (this._listeners.size > 0 && previousTimeZone !== nextTimeZone) {
            this._scheduleNextBoundaryRefresh();
            void this.refresh();
        }
    }

    /**
     * The same object until something actually changes.
     *
     * Consumers assign this straight into a `@state`, so a fresh object literal
     * per call would dirty every card on every update and re-render a picture
     * that did not move. `_emit()` is the only place a new snapshot is built,
     * and every mutation of a snapshot field goes through it.
     */
    public getSnapshot(): ScheduleOwnerSnapshot {
        return this._snapshot;
    }

    public getNowMs(): number {
        return this._nowMs;
    }

    public getNormalized(timeZone: string, locale: string): NormalizedScheduleModel {
        return this._normalizedCache.get(this._schedule, timeZone, locale, new Date(this._nowMs));
    }

    public subscribe(listener: ScheduleOwnerListener): () => void {
        // A new reader can arrive between coarse ticks, including just after a
        // slot boundary. Give its first render the current slot.
        this._nowMs = Date.now();
        this._listeners.add(listener);
        listener(this.getSnapshot());
        this._ensureLifecycle();

        let isSubscribed = true;
        return () => {
            if (!isSubscribed) {
                return;
            }

            isSubscribed = false;
            this._listeners.delete(listener);
            if (this._listeners.size === 0) {
                this._dispose();
                scheduleOwners.delete(this._hass.connection);
            }
        };
    }

    public async refresh(): Promise<void> {
        if (this._mutationRequest !== null) {
            // The write's answer may predate whatever asked for this read, so
            // the read is owed once that answer is committed, not absorbed by it.
            this._refreshAfterMutation = true;
            await this._mutationRequest;
            return;
        }

        await this._refreshSchedule();
    }

    public async applySchedulePatches(
        patches: readonly ScheduleSlotPatch[],
    ): Promise<ScheduleOwnerError | null> {
        if (patches.length === 0) {
            return null;
        }

        return this._trackMutation(
            "_writing",
            () => this._helmanStore.applySchedulePatches(patches),
            "schedule: failed to update schedule",
        );
    }

    public async setExecutionEnabled(enabled: boolean): Promise<ScheduleOwnerError | null> {
        return this._trackMutation(
            "_togglingExecution",
            () => this._helmanStore.setScheduleExecution(enabled),
            "schedule: failed to update schedule execution",
        );
    }

    /**
     * Run one write and commit the schedule it answers with.
     *
     * The backend returns the document the write produced, so there is no
     * reload afterwards. A later re-read is still legitimate -- a user write
     * triggers an automation run -- and arrives through the data-changed feed;
     * one that lands while the write is in flight is run once it commits.
     */
    private async _trackMutation(
        flag: "_writing" | "_togglingExecution",
        write: () => Promise<SchedulePayload>,
        failureMessage: string,
    ): Promise<ScheduleOwnerError | null> {
        if (this._mutationRequest !== null) {
            await this._mutationRequest;
        }

        if (this._request !== null) {
            await this._request;
        }

        const connection = this._hass.connection;

        this[flag] = true;
        this._error = null;
        this._emit();

        let writeError: ScheduleOwnerError | null = null;
        const mutation = (async () => {
            try {
                const schedule = await write();
                if (this._hass.connection === connection) {
                    this._commitSchedule(schedule);
                }
            } catch (error) {
                if (this._hass.connection === connection) {
                    writeError = _normalizeOwnerError(error);
                    this._error = writeError;
                    console.error(failureMessage, error);
                }
            } finally {
                if (this._hass.connection === connection) {
                    this[flag] = false;
                    this._scheduleNextBoundaryRefresh();
                    this._emit();
                }
            }
        })();

        const trackedMutation = mutation.finally(() => {
            if (this._mutationRequest === trackedMutation) {
                this._mutationRequest = null;
            }
            if (this._refreshAfterMutation) {
                this._refreshAfterMutation = false;
                void this._refreshSchedule();
            }
        });
        this._mutationRequest = trackedMutation;

        await trackedMutation;
        return writeError;
    }

    private _ensureLifecycle(): void {
        if (this._listeners.size === 0) {
            return;
        }

        this._stopNowClock ??= startNowClock(() => {
            this._nowMs = Date.now();
            this._emit();
        });
        this._scheduleNextBoundaryRefresh();
        this._ensureDataChangedSubscription();
        if (this._schedule === null && !this._loading && !this._refreshing) {
            void this._refreshSchedule();
        }
    }

    /**
     * Follow the backend's own announcements, not just the slot clock.
     *
     * `refresh()` is the right entry point rather than `_refreshSchedule()`
     * directly: it already stands down while a mutation this client started is
     * in flight, so the event caused by our own write does not race the write's
     * own committed answer.
     */
    private _ensureDataChangedSubscription(): void {
        if (this._unsubscribeDataChanged !== null) {
            return;
        }

        this._unsubscribeDataChanged = getSharedDataChangedFeed(this._hass).subscribe(
            () => {
                void this.refresh();
            },
        );
    }

    /**
     * Rebuild the snapshot if a field moved, then hand it to whoever is listening.
     *
     * The rebuild does not wait for listeners on purpose. Dropping the last
     * listener while a refresh is in flight is possible -- that request's
     * `finally` still writes the fields and emits -- and a no-listener early
     * return here would leave the cached snapshot stale for good, for the next
     * reader to pick up.
     *
     * Listeners are told even when nothing in the snapshot moved: a clock tick
     * changes only `getNowMs()` and `getNormalized()`, and whoever reads those
     * needs the cue. Handing them the same object keeps a `@state` assignment
     * from re-rendering a card that reads neither.
     */
    private _emit(): void {
        const current = this._snapshot;
        if (
            current.schedule !== this._schedule
            || current.loading !== this._loading
            || current.refreshing !== this._refreshing
            || current.writing !== this._writing
            || current.togglingExecution !== this._togglingExecution
            || current.error !== this._error
            || current.updatedAt !== this._updatedAt
            || current.stale !== this._stale
        ) {
            this._snapshot = {
                schedule: this._schedule,
                loading: this._loading,
                refreshing: this._refreshing,
                writing: this._writing,
                togglingExecution: this._togglingExecution,
                error: this._error,
                updatedAt: this._updatedAt,
                stale: this._stale,
            };
        }

        for (const listener of this._listeners) {
            listener(this._snapshot);
        }
    }

    private async _refreshSchedule(): Promise<void> {
        if (this._request !== null) {
            await this._request;
            return;
        }

        const hass = this._hass;
        const connection = hass.connection;
        const hadSchedule = this._schedule !== null;

        if (hadSchedule) {
            this._refreshing = true;
        } else {
            this._loading = true;
        }
        this._emit();

        const request = (async () => {
            try {
                const schedule = await this._helmanStore.getSchedule();
                if (this._hass.connection !== connection) {
                    return;
                }

                this._commitSchedule(schedule);
            } catch (error) {
                if (this._hass.connection === connection) {
                    this._error = _normalizeOwnerError(error);
                    this._stale = hadSchedule;
                    console.error("schedule: failed to load schedule", error);
                }
            } finally {
                if (this._hass.connection === connection) {
                    this._loading = false;
                    this._refreshing = false;
                    this._scheduleNextBoundaryRefresh();
                    this._emit();
                }
            }
        })();

        const trackedRequest = request.finally(() => {
            if (this._request === trackedRequest) {
                this._request = null;
            }
        });
        this._request = trackedRequest;

        await trackedRequest;
    }

    private _commitSchedule(schedule: SchedulePayload): void {
        this._schedule = schedule;
        // A boundary refresh may finish before the next coarse clock tick.
        this._nowMs = Date.now();
        this._error = null;
        this._updatedAt = Date.now();
        this._stale = false;
    }

    private _scheduleNextBoundaryRefresh(): void {
        this._clearBoundaryTimer();
        if (this._listeners.size === 0 || typeof window === "undefined") {
            return;
        }

        // `slots` is optional and not only `_schedule`: this runs inside a
        // subscriber's `willUpdate`, so a payload that arrives without one
        // throws there and leaves that element unrendered for good.
        const schedule = this._schedule;
        const delay = schedule?.slots
            ? getNextScheduleBoundaryDelayMs(
                schedule.slots.map((slot) => slot.id),
                schedule.slotMinutes,
                new Date(),
            )
            : null;
        if (delay === null) {
            return;
        }

        this._boundaryTimer = window.setTimeout(async () => {
            this._boundaryTimer = null;
            await this.refresh();
        }, delay + BOUNDARY_BUFFER_MS);
    }

    private _clearBoundaryTimer(): void {
        if (this._boundaryTimer !== null && typeof window !== "undefined") {
            window.clearTimeout(this._boundaryTimer);
            this._boundaryTimer = null;
        }
    }

    private _dispose(): void {
        this._stopNowClock?.();
        this._stopNowClock = null;
        this._clearBoundaryTimer();
        this._unsubscribeDataChanged?.();
        this._unsubscribeDataChanged = null;
    }
}

function _normalizeTimeZone(rawTimeZone: string | null | undefined): string | null {
    return typeof rawTimeZone === "string" && rawTimeZone
        ? rawTimeZone
        : null;
}

function _normalizeOwnerError(error: unknown): ScheduleOwnerError {
    if (error && typeof error === "object") {
        const record = error as Record<string, unknown>;
        const code = typeof record.code === "string" ? record.code : null;
        const message = typeof record.message === "string"
            ? record.message
            : "Unknown schedule error";
        return { code, message };
    }

    return {
        code: null,
        message: typeof error === "string" ? error : "Unknown schedule error",
    };
}
