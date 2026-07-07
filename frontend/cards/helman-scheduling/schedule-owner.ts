import type { HomeAssistant } from "../../hass-frontend/src/types";
import type { SchedulePayload } from "../helman-api";
import { getSharedHelmanStore, type HelmanStore } from "../helman/store";
import { getNextScheduleBoundaryDelayMs } from "./model/schedule-time";
import type {
    ScheduleOwnerError,
    ScheduleOwnerSnapshot,
    ScheduleSlotPatch,
} from "./schedule-types";

const BOUNDARY_BUFFER_MS = 50;

type ScheduleConnection = HomeAssistant["connection"];
type ScheduleOwnerListener = (snapshot: ScheduleOwnerSnapshot) => void;

const scheduleOwners = new WeakMap<ScheduleConnection, ScheduleOwnerImpl>();

const EMPTY_SCHEDULE_OWNER_SNAPSHOT: ScheduleOwnerSnapshot = {
    schedule: null,
    loading: false,
    refreshing: false,
    writing: false,
    togglingExecution: false,
    error: null,
    updatedAt: null,
    stale: false,
};

export interface SharedScheduleOwner {
    getSnapshot(): ScheduleOwnerSnapshot;
    subscribe(listener: ScheduleOwnerListener): () => void;
    refresh(): Promise<void>;
    applySchedulePatches(patches: readonly ScheduleSlotPatch[]): Promise<void>;
    setExecutionEnabled(enabled: boolean): Promise<void>;
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
    private _request: Promise<void> | null = null;
    private _mutationRequest: Promise<void> | null = null;
    private _boundaryTimer: number | null = null;
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

    public getSnapshot(): ScheduleOwnerSnapshot {
        return {
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

    public subscribe(listener: ScheduleOwnerListener): () => void {
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
            await this._mutationRequest;
            return;
        }

        await this._refreshSchedule();
    }

    public async applySchedulePatches(patches: readonly ScheduleSlotPatch[]): Promise<void> {
        if (patches.length === 0) {
            return;
        }

        if (this._mutationRequest !== null) {
            await this._mutationRequest;
        }

        if (this._request !== null) {
            await this._request;
        }

        const hass = this._hass;
        const connection = hass.connection;

        this._writing = true;
        this._error = null;
        this._emit();

        const mutation = (async () => {
            try {
                await this._helmanStore.applySchedulePatches(patches);
                if (this._hass.connection !== connection) {
                    return;
                }

                await this._refreshSchedule();
            } catch (error) {
                if (this._hass.connection === connection) {
                    this._error = _normalizeOwnerError(error);
                    console.error("helman-scheduling: failed to update schedule", error);
                }
            } finally {
                if (this._hass.connection === connection) {
                    this._writing = false;
                    this._emit();
                }
            }
        })();

        const trackedMutation = mutation.finally(() => {
            if (this._mutationRequest === trackedMutation) {
                this._mutationRequest = null;
            }
        });
        this._mutationRequest = trackedMutation;

        await trackedMutation;
    }

    public async setExecutionEnabled(enabled: boolean): Promise<void> {
        if (this._mutationRequest !== null) {
            await this._mutationRequest;
        }

        if (this._request !== null) {
            await this._request;
        }

        const hass = this._hass;
        const connection = hass.connection;

        this._togglingExecution = true;
        this._error = null;
        this._emit();

        const mutation = (async () => {
            try {
                await this._helmanStore.setScheduleExecution(enabled);
                if (this._hass.connection !== connection) {
                    return;
                }

                await this._refreshSchedule();
            } catch (error) {
                if (this._hass.connection === connection) {
                    this._error = _normalizeOwnerError(error);
                    console.error("helman-scheduling: failed to update schedule execution", error);
                }
            } finally {
                if (this._hass.connection === connection) {
                    this._togglingExecution = false;
                    this._emit();
                }
            }
        })();

        const trackedMutation = mutation.finally(() => {
            if (this._mutationRequest === trackedMutation) {
                this._mutationRequest = null;
            }
        });
        this._mutationRequest = trackedMutation;

        await trackedMutation;
    }

    private _ensureLifecycle(): void {
        if (this._listeners.size === 0) {
            return;
        }

        this._scheduleNextBoundaryRefresh();
        if (this._schedule === null && !this._loading && !this._refreshing) {
            void this._refreshSchedule();
        }
    }

    private _emit(): void {
        if (this._listeners.size === 0) {
            return;
        }

        const snapshot = this.getSnapshot();
        for (const listener of this._listeners) {
            listener(snapshot);
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

                this._schedule = schedule;
                this._error = null;
                this._updatedAt = Date.now();
                this._stale = false;
            } catch (error) {
                if (this._hass.connection === connection) {
                    this._error = _normalizeOwnerError(error);
                    this._stale = hadSchedule;
                    console.error("helman-scheduling: failed to load schedule", error);
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

    private _scheduleNextBoundaryRefresh(): void {
        this._clearBoundaryTimer();
        if (this._listeners.size === 0 || typeof window === "undefined") {
            return;
        }

        const delay = getNextScheduleBoundaryDelayMs(
            this._schedule?.slots.map((slot) => slot.id) ?? [],
            new Date(),
        );
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
        this._clearBoundaryTimer();
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
