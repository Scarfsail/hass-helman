import { test, expect } from "@playwright/test";
import { getSharedHelmanStore } from "../cards/shared/data/store";
import { forecastPayload } from "./support/payload-builders";
import type { ForecastPayload } from "../cards/helman-api";

/**
 * The forecast is read through the connection's store, one loader for every
 * component that shows it: after an announced change, the inspector, a node
 * detail and the schedule editor join one `helman/get_forecast` between them.
 *
 * The store touches no DOM, so it runs here directly rather than through the
 * bundle. The data-changed feed collects its batch on `window.setTimeout`,
 * which Node has none of -- the stub below is only there to run it.
 */

test.beforeAll(() => {
    (globalThis as Record<string, unknown>).window = globalThis;
});

test.afterAll(() => {
    delete (globalThis as Record<string, unknown>).window;
});

/** A hass double: every `helman/get_forecast` waits for the test to answer it. */
function fakeHass() {
    const forecastReplies: Array<(payload: ForecastPayload) => void> = [];
    let announce: (message: { kind: string }) => void = () => undefined;
    const hass = {
        callWS: (request: { type: string }) => {
            if (request.type !== "helman/get_forecast") return Promise.reject(new Error(`unexpected ${request.type}`));
            return new Promise((resolve) => forecastReplies.push(resolve));
        },
        connection: {
            subscribeMessage: (callback: (message: { kind: string }) => void) => {
                announce = callback;
                return Promise.resolve(() => undefined);
            },
        },
    };
    return {
        store: getSharedHelmanStore(hass as any),
        forecastReplies,
        announce: (kind: string) => announce({ kind }),
    };
}

/** A forecast told apart from another by its generation time. */
const forecast = (generatedAt: string) => forecastPayload({
    grid: { ...forecastPayload().grid, generatedAt },
});

test("three callers after one announced change share one request", async () => {
    const { store, forecastReplies, announce } = fakeHass();
    const before = forecast("before");
    const first = store.getForecast();
    expect(forecastReplies).toHaveLength(1);
    forecastReplies[0](before);
    expect(await first).toBe(before);

    const reads: Promise<ForecastPayload | null>[] = [];
    const invalidated = new Promise<void>((done) => {
        for (let i = 0; i < 3; i += 1) {
            store.subscribeForecastInvalidation(() => {
                reads.push(store.getForecast());
                if (reads.length === 3) done();
            });
        }
    });
    // Inside the loader's burst window: only the invalidation makes these ask again.
    announce("plan");
    await invalidated;

    expect(forecastReplies).toHaveLength(2);
    const after = forecast("after");
    forecastReplies[1](after);
    for (const read of await Promise.all(reads)) expect(read).toBe(after);
});

test("a caller after the change never receives the payload from before it", async () => {
    const { store, forecastReplies, announce } = fakeHass();
    const pending = store.getForecast();
    const invalidated = new Promise<void>((done) => store.subscribeForecastInvalidation(done));
    announce("schedule");
    await invalidated;

    // The request sent before the change is still out; a caller now asks anew.
    const late = store.getForecast();
    expect(forecastReplies).toHaveLength(2);
    const before = forecast("before");
    const after = forecast("after");
    forecastReplies[0](before);
    forecastReplies[1](after);
    expect(await pending).toBe(before);
    expect(await late).toBe(after);
    // Nor does the late answer to the earlier request fill the cache.
    const again = store.getForecast();
    expect(forecastReplies).toHaveLength(2);
    expect(await again).toBe(after);
});

test("an explainability reply is cached under its own trainedAt, not the requested one", async () => {
    let calls = 0;
    const reply = { trainedAt: "Y", aggregationMethod: "median", slots: {} };
    const hass = {
        callWS: () => { calls += 1; return Promise.resolve(reply); },
        connection: { subscribeMessage: () => Promise.resolve(() => undefined) },
    };
    const store = getSharedHelmanStore(hass as any);
    expect(await store.getTrainingExplainability("X")).toBeNull();
    expect(await store.getTrainingExplainability("Y")).toBe(reply);
    expect(calls).toBe(1);
});
