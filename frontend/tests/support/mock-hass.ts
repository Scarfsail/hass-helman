import type { Page } from "@playwright/test";

import { FIXED_TODAY, installFixedClock } from "./fixed-clock";
import { configDoc, forecastPayload, inspectorDay, scheduleSlots, treePayload } from "./payload-builders";
import type { ConfigDocument, InspectorPayload } from "../../cards/helman-api";

export type MockRequest = { type: string; [key: string]: unknown };
export type MockReply = unknown | Error | ((request: MockRequest) => unknown | Promise<unknown>);
export type MockReplies = Record<string, MockReply>;

declare global {
    interface Window {
        __inspectorDayBase: InspectorPayload;
        __inspectorDay: typeof inspectorDay;
        __configDocBase: ConfigDocument;
        __mockRequests: MockRequest[];
        __setMockReply: (hass: { callWS: (request: MockRequest) => Promise<unknown> }, command: string, response: MockReply) => void;
        __clearMockReply: (hass: { callWS: (request: MockRequest) => Promise<unknown> }, command: string) => void;
        __mockHass: (overrides?: MockReplies, onRequest?: (request: MockRequest) => void) => {
            callWS: (request: MockRequest) => Promise<unknown>;
            setReply: (command: string, response: MockReply) => void;
            connection: {
                sendMessagePromise: (request: MockRequest) => Promise<unknown>;
                subscribeMessage: (listener: (message: unknown) => void, request: MockRequest) => Promise<() => void>;
            };
        };
    }
}

/** Install the shared router in the page, where override closures and counters live. */
export async function installMockHass(page: Page): Promise<void> {
    const fixtureDefaults = {
        schedule: scheduleSlots({ slotMinutes: 15 }),
        tree: treePayload(),
        forecast: forecastPayload(),
        config: JSON.stringify(configDoc()),
        inspector: JSON.stringify(inspectorDay()),
    };
    await page.evaluate(({ schedule, tree, forecast, config, inspector }) => {
        if (typeof window.__mockHass === "function") return;
        window.__mockRequests = [];
        window.__inspectorDayBase = JSON.parse(inspector) as InspectorPayload;
        window.__inspectorDay = ({ range, series, totals, availability, ...overrides } = {}) => ({
            ...window.__inspectorDayBase,
            ...overrides,
            range: { ...window.__inspectorDayBase.range, ...range },
            series: { ...window.__inspectorDayBase.series, ...series },
            totals: { ...window.__inspectorDayBase.totals, ...totals },
            availability: { ...window.__inspectorDayBase.availability, ...availability },
        });
        window.__configDocBase = JSON.parse(config) as ConfigDocument;
        const listeners: Array<(message: unknown) => void> = [];
        const controls = new WeakMap<Function, { set: (command: string, response: MockReply) => void; clear: (command: string) => void }>();
        window.__setMockReply = (hass, command, response) => {
            const control = controls.get(hass.callWS);
            if (!control) throw new Error("Home Assistant mock does not use the shared router");
            control.set(command, response);
        };
        window.__clearMockReply = (hass, command) => {
            const control = controls.get(hass.callWS);
            if (!control) throw new Error("Home Assistant mock does not use the shared router");
            control.clear(command);
        };
        window.__fireDataChanged = (kind: string) => {
            for (const listener of [...listeners]) listener({ kind });
        };
        window.__mockHass = (overrides = {}, onRequest) => {
            const reply = async (request: MockRequest): Promise<unknown> => {
                window.__mockRequests.push(structuredClone(request));
                onRequest?.(request);
                const command = request.type;
                const response = Object.prototype.hasOwnProperty.call(overrides, command)
                    ? overrides[command]
                    : Object.prototype.hasOwnProperty.call(defaults, command) ? defaults[command] : {};
                if (response instanceof Error) throw response;
                return typeof response === "function" ? response(request) : response;
            };
            controls.set(reply, {
                set: (command, response) => { overrides[command] = response; },
                clear: (command) => { delete overrides[command]; },
            });
            return {
                callWS: reply,
                setReply: (command, response) => { overrides[command] = response; },
                connection: {
                    sendMessagePromise: reply,
                    subscribeMessage: async (listener: (message: unknown) => void, request: MockRequest) => {
                        if (request.type !== "helman/subscribe_updates") return () => undefined;
                        listeners.push(listener);
                        return () => {
                            const index = listeners.indexOf(listener);
                            if (index !== -1) listeners.splice(index, 1);
                        };
                    },
                },
            };
        };
        const defaults: Record<string, unknown> = {
            "helman/get_appliances": { appliances: [] },
            "helman/get_config": window.__configDocBase,
            "helman/get_optimizer_schema": { version: 29, kinds: [], applianceKinds: ["climate", "ev_charger", "generic"] },
            "helman/save_config": { success: true, validation: { valid: true, errors: [], warnings: [] }, reloadStarted: true },
            "helman/get_node_detail": (request: MockRequest) => {
                const node = request.node;
                const asOf = new Date().toISOString();
                const period = {
                    start: `${asOf.slice(0, 10)}T00:00:00.000Z`,
                    end: new Date(Date.parse(`${asOf.slice(0, 10)}T00:00:00.000Z`) + 86_400_000).toISOString(),
                };
                if (!["inverter", "grid", "battery", "solar", "house", "ev_charger"].includes(String(node))) {
                    throw new Error(`No node detail for '${String(node)}'`);
                }
                if (request.section === "flows") return {
                    node, section: "flows", asOf, period, currency: null, complete: false,
                    unavailable: "not_loaded", flows: null,
                };
                if (request.section) {
                    const section = request.section;
                    const empty = { node, section, asOf, period, currency: null, complete: false, unavailable: "not_loaded" };
                    if (node === "battery" && section === "charge") return { ...empty, charge: null };
                    if (node === "house" && section === "today") return { ...empty, house: null, independence: null, selfConsumption: null, consumers: null };
                    if (node === "solar" && section === "destinations") return { ...empty, destinations: null, charge: null };
                    if (node === "ev_charger" && section === "today") return { ...empty, deviceId: request.device_id, charger: null };
                    if (node === "ev_charger" && section === "segment") return { node, section, deviceId: request.device_id, asOf, period, chargingSince: null, charging: null };
                    throw new Error(`The ${String(node)} detail has no section '${String(section)}'`);
                }
                const base = { node, asOf, profile: null, entities: {}, sections: [] };
                switch (node) {
                    case "inverter": return {
                        ...base, configured: false, mode: null, maxAllowedExportPower: null,
                        agreement: { status: "unknown", reason: "no_profile", commanded: null, observedOption: null, observedFrom: [], registers: [] },
                        condition: null,
                    };
                    case "grid": return { ...base, phasePowerPolarity: null, maxAllowedExportPower: null, condition: null };
                    case "battery": return {
                        ...base, sections: ["charge"], configured: { maxChargePowerW: null, maxDischargePowerW: null },
                        cycles: { cycles: null, inputKwh: null, outputKwh: null, capacityKwh: null, reason: "no_counters" },
                        condition: null,
                    };
                    case "solar": return { ...base, sections: ["destinations"], strings: [], configuredMaxPowerW: null, maxAllowedExportPower: null, condition: null };
                    case "house": return { ...base, sections: ["today"], phasePowerPolarity: null, condition: null };
                    case "ev_charger": return { ...base, sections: ["today", "segment"], deviceId: request.device_id, status: null };
                    default: throw new Error(`No node detail for '${String(node)}'`);
                }
            },
            "helman/inspect_entities": { results: [] },
            "helman/get_schedule": schedule,
            "helman/get_device_tree": tree,
            "helman/get_history": { buckets: 0, bucket_duration: 0, entity_history: {} },
            "helman/validate_config": { valid: true, errors: [], warnings: [] },
            "helman/get_forecast": forecast,
            "helman/solar_bias/inspector": (request: MockRequest) => window.__inspectorDay({ date: String(request.date ?? "") }),
            "helman/solar_bias/day_aggregates": { days: [], bucket: "day", currency: "CZK", range: { minDate: "", maxDate: "" } },
        };
    }, fixtureDefaults);
}

export async function mockRequests(page: Page): Promise<MockRequest[]> {
    return page.evaluate(() => window.__mockRequests);
}

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
        /**
         * Every `helman/solar_bias/day_aggregates` read, in order.
         *
         * The pills and the aggregate views share the command, so `bucket` is
         * how a spec tells a span read from a pill window: only the views ask
         * for a bucket.
         */
        __aggregateRequests: Array<{ start: string; end: string; bucket: string | null }>;
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
    /** Put the page's timers under the test's control too. See `fixed-clock`. */
    fakeTimers?: boolean;
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
    await installFixedClock(page, { timers: options.fakeTimers === true });
    await installMockHass(page);
    const schedule = scheduleSlots({ slotMinutes: 60 });
    const fixtureTodayMs = Date.parse(`${FIXED_TODAY}T00:00:00Z`);
    const forecastBase = forecastPayload();
    const forecast = forecastPayload({
        solar: {
            ...forecastBase.solar,
            status: "available",
            points: Array.from({ length: options.pillDays * 24 }, (_, index) => ({
                timestamp: new Date(fixtureTodayMs + index * 3_600_000).toISOString(),
                value: index % 24 >= 8 && index % 24 < 16 ? 800 : 0,
            })),
        },
        battery_capacity: {
            ...forecastBase.battery_capacity,
            nominalCapacityKwh: 10,
            currentRemainingEnergyKwh: 5,
            currentSoc: 50,
            minSoc: 10,
            maxSoc: 100,
            chargeEfficiency: 1,
            dischargeEfficiency: 1,
            maxChargePowerW: 5000,
            maxDischargePowerW: 5000,
        },
    });
    await page.evaluate(({ pillDays, schedule, forecast }) => {
        const dayMs = 86_400_000;
        const todayMs = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
        const isoDay = (offset: number) =>
            new Date(todayMs + offset * dayMs).toISOString().slice(0, 10);

        let actualWh = 6000;
        window.__setActualWh = (value: number) => {
            actualWh = value;
        };

        // A day with real series, so the card draws its chart and totals rather
        // than the "no data" note — the note is indistinguishable from a blank.
        const inspectorPayload = (date: string) => (window.__inspectorDay({
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
                corrected: Array.from({ length: 96 }, (_, index) => ({
                    timestamp: `${date}T${String(Math.floor(index / 4)).padStart(2, "0")}:${String(index % 4 * 15).padStart(2, "0")}:00`,
                    valueWh: index >= 8 * 4 && index < 16 * 4 ? 125 : 0,
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
            batterySocBounds: [],
            trainingExplainability: null,
        }));

        // Measured days for every past day in reach of the pill row. A past
        // week's pills then carry real aggregates, which is what gives
        // `historyDays` an identity worth asserting on. `houseForecastWh` only
        // where the read asked for it, as the backend does.
        const dayAggregates = (start: string, end: string, houseForecast: boolean) => ({
            days: Array.from({ length: 31 }, (_, index) => isoDay(index - 30))
                .filter((date) => date >= start && date <= end && date < isoDay(0))
                .map((date) => ({
                    date,
                    solarWh: 5200,
                    gridImportKwh: 4,
                    gridExportKwh: 2,
                    batteryMinSocPct: 20,
                    batteryMaxSocPct: 90,
                    houseWh: 7680,
                    ...(houseForecast ? { houseForecastWh: 7200 } : {}),
                })),
        });

        window.__requestedDates = [];
        window.__aggregateRequests = [];
        window.__forecastCalls = 0;
        const pending: Array<() => void> = [];
        window.__pendingInspector = () => pending.length;
        window.__releaseInspector = () => {
            pending.shift()?.();
        };

        window.__fakeHass = {
            language: "en",
            locale: { language: "en" },
            config: { time_zone: "UTC" },
            states: {},
            ...window.__mockHass({
                "helman/get_forecast": () => {
                    window.__forecastCalls += 1;
                    return forecast;
                },
                "helman/get_schedule": schedule,
                "helman/solar_bias/day_aggregates": (msg: MockRequest) => {
                    const start = msg.start_date ?? "";
                    const end = msg.end_date ?? "";
                    window.__aggregateRequests.push({ start: String(start), end: String(end), bucket: typeof msg.bucket === "string" ? msg.bucket : null });
                    return {
                        ...dayAggregates(String(start), String(end), msg.house_forecast === true),
                        bucket: msg.bucket ?? "day",
                        currency: "CZK",
                        // The span views navigate off the payload's own bounds,
                        // so a card taken to D or M without a day load first
                        // still knows how far back it may go.
                        range: { minDate: isoDay(-30), maxDate: isoDay(pillDays - 1) },
                    };
                },
                "helman/solar_bias/inspector": (msg: MockRequest) => {
                    const date = String(msg.date ?? "");
                    window.__requestedDates.push(date);
                    return new Promise((resolvePayload) => {
                        pending.push(() => resolvePayload(inspectorPayload(date)));
                    });
                },
            }),
        };
    }, { pillDays: options.pillDays, schedule, forecast });
}
