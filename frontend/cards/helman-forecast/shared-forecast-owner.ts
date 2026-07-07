import type { HomeAssistant } from "../../hass-frontend/src/types";
import type { ForecastPayload } from "../helman-api";
import { FORECAST_REFRESH_MS, ForecastLoader } from "../helman/forecast-loader";
import { getLocalHourKey } from "./shared/local-day-hour-axis";

const HOUR_MS = 3600000;
const BOUNDARY_BUFFER_MS = 50;

type ForecastConnection = HomeAssistant["connection"];
type SharedForecastListener = (snapshot: SharedForecastSnapshot) => void;

const forecastOwners = new WeakMap<ForecastConnection, ForecastOwnerImpl>();

export interface SharedForecastSnapshot {
    forecast: ForecastPayload | null;
    loading: boolean;
    loadFailed: boolean;
}

export interface SharedForecastOwner {
    getSnapshot(): SharedForecastSnapshot;
    subscribe(listener: SharedForecastListener): () => void;
}

export function getSharedForecastOwner(hass: HomeAssistant): SharedForecastOwner {
    let owner = forecastOwners.get(hass.connection);
    if (!owner) {
        owner = new ForecastOwnerImpl(hass);
        forecastOwners.set(hass.connection, owner);
    } else {
        owner.updateHass(hass);
    }

    return owner;
}

class ForecastOwnerImpl implements SharedForecastOwner {
    private _hass: HomeAssistant;
    private readonly _loader = new ForecastLoader(60, 7);
    private _forecast: ForecastPayload | null = null;
    private _loading = false;
    private _loadFailed = false;
    private _request: Promise<void> | null = null;
    private _refreshTimer: number | null = null;
    private _hourBoundaryTimer: number | null = null;
    private _timeZone: string | null = null;
    private readonly _listeners = new Set<SharedForecastListener>();

    constructor(hass: HomeAssistant) {
        this._hass = hass;
    }

    public updateHass(hass: HomeAssistant): void {
        const nextTimeZone = _normalizeTimeZone(hass.config.time_zone);
        this._hass = hass;

        if (this._listeners.size > 0 && nextTimeZone !== this._timeZone) {
            this._scheduleNextHourBoundary();
        }
    }

    public getSnapshot(): SharedForecastSnapshot {
        return {
            forecast: this._forecast,
            loading: this._loading,
            loadFailed: this._loadFailed,
        };
    }

    public subscribe(listener: SharedForecastListener): () => void {
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
                forecastOwners.delete(this._hass.connection);
            }
        };
    }

    private _ensureLifecycle(): void {
        if (this._listeners.size === 0) {
            return;
        }

        this._startRefreshTimer();
        this._scheduleNextHourBoundary();

        if (this._forecast === null && !this._loading) {
            void this._loadInitialForecast();
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

    private async _loadInitialForecast(): Promise<void> {
        if (this._request !== null) {
            await this._request;
            return;
        }

        const hass = this._hass;
        const connection = hass.connection;

        this._loading = true;
        this._loadFailed = false;
        this._emit();

        const request = (async () => {
            try {
                const forecast = await this._loader.load(hass);
                if (this._hass.connection === connection) {
                    this._forecast = forecast;
                    this._loadFailed = false;
                }
            } catch (err) {
                if (this._hass.connection === connection) {
                    this._loadFailed = true;
                    console.error("helman-forecast: failed to load forecast", err);
                }
            } finally {
                if (this._hass.connection === connection) {
                    this._loading = false;
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

    private async _refreshForecast(): Promise<void> {
        if (this._request !== null) {
            await this._request;
            return;
        }

        const hass = this._hass;
        const connection = hass.connection;

        const request = (async () => {
            const forecast = await this._loader.refresh(hass);
            if (this._hass.connection !== connection) {
                return;
            }

            this._forecast = forecast;
            if (forecast !== null) {
                this._loadFailed = false;
            }
            this._emit();
        })();

        const trackedRequest = request.finally(() => {
            if (this._request === trackedRequest) {
                this._request = null;
            }
        });
        this._request = trackedRequest;

        await trackedRequest;
    }

    private _startRefreshTimer(): void {
        if (this._refreshTimer !== null || typeof window === "undefined") {
            return;
        }

        this._refreshTimer = window.setInterval(() => {
            void this._refreshForecast();
        }, FORECAST_REFRESH_MS);
    }

    private _clearRefreshTimer(): void {
        if (this._refreshTimer !== null && typeof window !== "undefined") {
            window.clearInterval(this._refreshTimer);
            this._refreshTimer = null;
        }
    }

    private _scheduleNextHourBoundary(): void {
        this._clearHourBoundaryTimer();
        if (this._listeners.size === 0) {
            return;
        }

        const timeZone = _normalizeTimeZone(this._hass.config.time_zone);
        this._timeZone = timeZone;
        if (timeZone === null || typeof window === "undefined") {
            return;
        }

        const currentHourKey = getLocalHourKey(new Date(), timeZone);
        if (currentHourKey === null) {
            return;
        }

        const currentHourStartMs = new Date(currentHourKey).getTime();
        if (Number.isNaN(currentHourStartMs)) {
            return;
        }

        const delay = Math.max(currentHourStartMs + HOUR_MS - Date.now(), 0) + BOUNDARY_BUFFER_MS;
        this._hourBoundaryTimer = window.setTimeout(async () => {
            this._hourBoundaryTimer = null;
            await this._refreshForecast();
            if (this._listeners.size === 0) {
                return;
            }
            this._scheduleNextHourBoundary();
        }, delay);
    }

    private _clearHourBoundaryTimer(): void {
        if (this._hourBoundaryTimer !== null && typeof window !== "undefined") {
            window.clearTimeout(this._hourBoundaryTimer);
            this._hourBoundaryTimer = null;
        }
    }

    private _dispose(): void {
        this._clearRefreshTimer();
        this._clearHourBoundaryTimer();
        this._timeZone = null;
    }
}

function _normalizeTimeZone(rawTimeZone: string | null | undefined): string | null {
    return typeof rawTimeZone === "string" && rawTimeZone
        ? rawTimeZone
        : null;
}
