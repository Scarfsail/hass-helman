import type { HomeAssistant } from "../../hass-frontend/src/types";
import type { ForecastGranularity, ForecastPayload, GetForecastRequest } from "../helman-api";

export const FORECAST_REFRESH_MS = 5 * 60 * 1000;

const FORECAST_REQUEST_CACHE_MS = 2000;

function getLocalHourRequestKey(now: Date): string {
    return [
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        now.getHours(),
        now.getTimezoneOffset(),
    ].join(":");
}

export class ForecastLoader {
    private _inFlight: Promise<ForecastPayload> | null = null;
    private _inFlightHourKey: string | null = null;
    private _payload: ForecastPayload | null = null;
    private _payloadHourKey: string | null = null;
    private _fetchedAt = 0;

    constructor(
        private readonly _granularity: ForecastGranularity,
        private readonly _forecastDays?: number | null,
    ) {}

    load(hass: HomeAssistant): Promise<ForecastPayload> {
        const now = new Date();
        const requestHourKey = getLocalHourRequestKey(now);

        if (
            this._payload !== null
            && this._payloadHourKey === requestHourKey
            && now.getTime() - this._fetchedAt <= FORECAST_REQUEST_CACHE_MS
        ) {
            return Promise.resolve(this._payload);
        }

        if (this._inFlight !== null && this._inFlightHourKey === requestHourKey) {
            return this._inFlight;
        }

        const requestMessage: GetForecastRequest = {
            type: "helman/get_forecast",
            granularity: this._granularity,
        };
        if (this._forecastDays !== null && this._forecastDays !== undefined) {
            requestMessage.forecast_days = this._forecastDays;
        }
        const request = hass.connection.sendMessagePromise<ForecastPayload>(requestMessage).then((payload) => {
            this._payload = payload;
            this._payloadHourKey = requestHourKey;
            this._fetchedAt = Date.now();
            return payload;
        }).finally(() => {
            if (this._inFlight === request) {
                this._inFlight = null;
                this._inFlightHourKey = null;
            }
        });

        this._inFlight = request;
        this._inFlightHourKey = requestHourKey;
        return request;
    }

    async refresh(hass: HomeAssistant): Promise<ForecastPayload | null> {
        try {
            return await this.load(hass);
        } catch (err) {
            console.error("helman: failed to refresh forecast", err);
            return this._payload;
        }
    }
}
