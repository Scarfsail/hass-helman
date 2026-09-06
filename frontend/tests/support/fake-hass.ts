import type { Page } from "@playwright/test";

import { installFixedClock } from "./fixed-clock";

/**
 * The fake Home Assistant the inspector specs mount against.
 *
 * Every payload the solar inspector's subtree asks for, with none of a running
 * Home Assistant's timing: inspector requests are held open until the test
 * releases them, so "what is on screen while the request is in flight" is an
 * assertion rather than a race, and nothing is replaced under the card unless a
 * test replaces it.
 *
 * That control is the point. `render-discipline.spec.ts` has to know that
 * *nothing whatsoever* changed between two `hass` objects, which a real Home
 * Assistant cannot promise — it replaces `hass` 17-24 times a second with a new
 * `states` map underneath. Here the test owns every field.
 *
 * The builder runs inside the page: `installFakeHass` hands it to
 * `page.evaluate`, so it must stay self-contained — no references to anything
 * in this module's scope, everything it needs arrives through its argument.
 */

declare global {
    interface Window {
        /** The `hass` object to hand a card. Set by `installFakeHass`. */
        __fakeHass: Record<string, unknown>;
        /** Every date `helman/solar_bias/inspector` was asked for, in order. */
        __requestedDates: string[];
        /** How many `helman/get_forecast` calls the subtree has made. */
        __forecastCalls: number;
        /** Let the oldest still-pending inspector request return. */
        __releaseInspector: () => void;
        /** How many inspector requests are waiting to be released. */
        __pendingInspector: () => number;
        /** Change the solar total the next payload carries. */
        __setActualWh: (value: number) => void;
        __fireDataChanged: (kind: string) => void;
    }
}

export interface FakeHassOptions {
    /** Days the inspector offers, counting today as day 0. */
    pillDays: number;
}

/**
 * Build the fake backend in the page and leave it on `window.__fakeHass`.
 *
 * Mounting is left to the caller: the specs mount different elements against
 * the same backend — the inspector element on its own, or
 * `helman-solar-inspector-card` when the card's `hass` filter is what is under
 * test.
 */
export async function installFakeHass(page: Page, options: FakeHassOptions): Promise<void> {
    // The payloads below are dated from the page's clock, so it is fixed first.
    // See `fixed-clock`.
    await installFixedClock(page);
    await page.evaluate(({ pillDays }) => {
        const dayMs = 86_400_000;
        const hourMs = 3_600_000;
        const todayMs = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
        const isoDay = (offset: number) =>
            new Date(todayMs + offset * dayMs).toISOString().slice(0, 10);

        const schedule = { executionEnabled: true, slots: [] };

        const forecast = {
            solar: {
                status: "available",
                unit: "Wh",
                resolution: "hour",
                horizonHours: pillDays * 24,
                actualHistory: [],
                points: Array.from({ length: pillDays * 24 }, (_, index) => ({
                    timestamp: new Date(todayMs + index * hourMs).toISOString(),
                    value: index % 24 >= 8 && index % 24 < 16 ? 800 : 0,
                })),
            },
            grid: {
                status: "unavailable",
                generatedAt: null,
                unit: "kWh",
                resolution: "hour",
                horizonHours: 0,
                startedAt: null,
                partialReason: null,
                coverageUntil: null,
                currentImportPrice: null,
                importPriceUnit: null,
                importPricePoints: [],
                currentExportPrice: null,
                exportPriceUnit: null,
                exportPricePoints: [],
                series: [],
            },
            house_consumption: {
                status: "unavailable",
                generatedAt: null,
                unit: "Wh",
                resolution: "hour",
                horizonHours: 0,
                trainingWindowDays: 0,
                historyDaysAvailable: 0,
                requiredHistoryDays: 0,
                model: null,
                actualHistory: [],
                series: [],
            },
            battery_capacity: {
                status: "unavailable",
                generatedAt: null,
                startedAt: null,
                unit: "kWh",
                resolution: "hour",
                horizonHours: 0,
                model: null,
                nominalCapacityKwh: 10,
                currentRemainingEnergyKwh: 5,
                currentSoc: 50,
                minSoc: 10,
                maxSoc: 100,
                chargeEfficiency: 1,
                dischargeEfficiency: 1,
                maxChargePowerW: 5000,
                maxDischargePowerW: 5000,
                partialReason: null,
                coverageUntil: null,
                actualHistory: [],
                series: [],
            },
        };

        let actualWh = 6000;
        window.__setActualWh = (value: number) => {
            actualWh = value;
        };

        // A day with real series, so the card draws its chart and totals rather
        // than the "no data" note — the note is indistinguishable from a blank.
        const inspectorPayload = (date: string) => ({
            date,
            timezone: "UTC",
            status: "ok",
            effectiveVariant: "adjusted",
            trainedAt: null,
            range: {
                minDate: isoDay(-30),
                maxDate: isoDay(pillDays - 1),
                canGoPrevious: true,
                canGoNext: date < isoDay(pillDays - 1),
                isToday: date === isoDay(0),
                isFuture: date > isoDay(0),
            },
            series: {
                raw: [],
                corrected: Array.from({ length: 24 }, (_, hour) => ({
                    slot: `${String(hour).padStart(2, "0")}:00`,
                    valueWh: hour >= 8 && hour < 16 ? 500 : 0,
                })),
                actual: [],
                invalidated: [],
                factors: [],
                impact: [],
                houseForecast: [],
                houseActual: [],
                houseActualBreakdown: [],
                batterySocForecast: [],
                batterySocActual: [],
                gridForecast: [],
                gridActual: [],
                batteryForecast: [],
                batteryActual: [],
            },
            totals: {
                rawWh: null,
                correctedWh: 4000,
                actualWh,
                houseForecastWh: null,
                houseActualWh: null,
                gridForecastWh: null,
                gridActualWh: null,
                batteryForecastWh: null,
                batteryActualWh: null,
            },
            availability: {
                hasRawForecast: false,
                hasCorrectedForecast: true,
                hasActuals: false,
                hasInvalidated: false,
                hasProfile: true,
                hasHouseForecast: false,
                hasHouseActual: false,
                hasBatterySocForecast: false,
                hasBatterySocActual: false,
                hasGridForecast: false,
                hasGridActual: false,
                hasBatteryForecast: false,
                hasBatteryActual: false,
            },
            houseUnmeasuredLabel: null,
            batterySocBounds: [],
            trainingExplainability: null,
        });

        // Measured days for every past day in reach of the pill row. A past
        // week's pills then carry real aggregates, which is what gives
        // `historyDays` an identity worth asserting on.
        const dayAggregates = (start: string, end: string) => ({
            days: Array.from({ length: 31 }, (_, index) => isoDay(index - 30))
                .filter((date) => date >= start && date <= end && date < isoDay(0))
                .map((date) => ({
                    date,
                    solarWh: 5200,
                    gridImportKwh: 4,
                    gridExportKwh: 2,
                    batteryMinSocPct: 20,
                    batteryMaxSocPct: 90,
                })),
        });

        window.__requestedDates = [];
        window.__forecastCalls = 0;
        const pending: Array<() => void> = [];
        window.__pendingInspector = () => pending.length;
        window.__releaseInspector = () => {
            pending.shift()?.();
        };

        const listeners: Array<(event: unknown) => void> = [];
        window.__fireDataChanged = (kind: string) => {
            for (const listener of listeners) {
                listener({ kind });
            }
        };

        window.__fakeHass = {
            language: "en",
            locale: { language: "en" },
            config: { time_zone: "UTC" },
            connection: {
                sendMessagePromise: async (msg: { type: string }) => {
                    if (msg.type === "helman/get_forecast") {
                        window.__forecastCalls += 1;
                        return forecast;
                    }
                    return {};
                },
                subscribeMessage: async (
                    listener: (message: unknown) => void,
                    request: { type: string },
                ) => {
                    if (request.type !== "helman/subscribe_updates") {
                        return () => undefined;
                    }
                    listeners.push(listener);
                    return () => {
                        listeners.splice(listeners.indexOf(listener), 1);
                    };
                },
            },
            states: {},
            callWS: async (msg: { type: string; date?: string; start_date?: string; end_date?: string }) => {
                if (msg.type === "helman/get_schedule") {
                    return schedule;
                }
                if (msg.type === "helman/solar_bias/day_aggregates") {
                    return dayAggregates(msg.start_date ?? "", msg.end_date ?? "");
                }
                if (msg.type === "helman/solar_bias/inspector") {
                    const date = msg.date ?? "";
                    window.__requestedDates.push(date);
                    return new Promise((resolvePayload) => {
                        pending.push(() => resolvePayload(inspectorPayload(date)));
                    });
                }
                return {};
            },
        };
    }, { pillDays: options.pillDays });
}
