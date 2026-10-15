import { installMockHass } from "./support/mock-hass";
import { treeNode, treePayload } from "./support/payload-builders";
import { test, expect, type Page } from "@playwright/test";
import { CARD_BUNDLE } from "./support/card-page";

/**
 * A load that resolves after its card is gone must commit nothing.
 *
 * `connectedCallback` starts a load and then awaits the device tree and the
 * history. `disconnectedCallback` stops the engine that is installed *at that
 * moment* — which is none, while the load is still in flight. So the response
 * arriving afterwards used to install a fresh `HistoryEngine` on a detached
 * card and start its interval, and nothing was left holding a reference that
 * could ever stop it again. That is finding F3 of #229: the reproduction is a
 * card with `isConnected === false` and a live `_historyEngine._interval`.
 *
 * The guard is a per-card load generation, bumped on disconnect and by every
 * replacement load, and re-checked after each await. These tests hold the two
 * responses open independently, so "resolved after removal" is an assertion
 * rather than a race, and they state hard zeros: not one timer, not one
 * animation frame, not one committed field.
 */

/** Bucket duration of the fixture, in seconds — the discriminator for its interval. */
const BUCKET_SECONDS = 7;

declare global {
    interface Window {
        /** Let the held `helman/get_device_tree` responses return. */
        __resolveTree: () => void;
        __rejectTree: () => void;
        /** Let the held `helman/get_history` responses return. */
        __resolveHistory: () => void;
        __rejectHistory: () => void;
        __resolveInverter: () => void;
        /** How many requests of each kind are still held open. */
        __pending: () => { tree: number; history: number; inverter: number };
        __setTreeBuckets: (count: number) => void;
        __omitHouseHistory: () => void;
        /** Start counting timer and animation-frame installs from now. */
        __mark: () => void;
        /** Timers and frames installed since `__mark`. */
        __sinceMark: () => { intervals: number; frames: number };
        /** Interval ids still running with the fixture's bucket delay. */
        __liveBucketIntervals: () => number[];
        /** The real `requestAnimationFrame`, so the drain below is not itself counted. */
        __rawRaf: (cb: FrameRequestCallback) => number;
        __hass: Record<string, unknown>;
    }
}

/**
 * The page-side fixture: a Home Assistant whose device-tree and history reads
 * are held open until the test releases them, plus counters over `setInterval`
 * and `requestAnimationFrame`.
 */
async function installFixture(page: Page, bucketSeconds: number): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await installMockHass(page);
    const node = (id: string, sensor: string, sourceType: string | null) =>
        treeNode({ id, displayName: id, powerSensorId: sensor, sourceType, isSource: sourceType !== null });
    const tree = treePayload({
        sources: [node("solar", "sensor.solar", "solar"), node("grid", "sensor.grid_in", "grid")],
        consumers: [node("house", "sensor.house", null)],
        consumptionTotalSensorId: "sensor.consumption_total",
        productionTotalSensorId: "sensor.production_total",
        uiConfig: { show_others_group: false, device_groupings: [], history_buckets: 3, history_bucket_duration: bucketSeconds },
    });
    await page.evaluate(({ bucket, treePayload }) => {
        let currentTree = treePayload;
        const liveIntervals = new Map<number, number>();
        let markedIntervals = 0;
        let markedFrames = 0;
        let marked = false;

        const realSetInterval = window.setInterval.bind(window);
        const realClearInterval = window.clearInterval.bind(window);
        const realRaf = window.requestAnimationFrame.bind(window);
        (window as any).setInterval = (handler: TimerHandler, delay?: number, ...args: any[]) => {
            const id = realSetInterval(handler as any, delay, ...args);
            liveIntervals.set(id, delay ?? 0);
            if (marked) markedIntervals += 1;
            return id;
        };
        (window as any).clearInterval = (id?: number) => {
            if (id !== undefined) liveIntervals.delete(id);
            return realClearInterval(id as any);
        };
        (window as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
            if (marked) markedFrames += 1;
            return realRaf(cb);
        };

        window.__rawRaf = realRaf;
        window.__mark = () => {
            marked = true;
            markedIntervals = 0;
            markedFrames = 0;
        };
        window.__sinceMark = () => ({ intervals: markedIntervals, frames: markedFrames });
        window.__liveBucketIntervals = () =>
            [...liveIntervals.entries()].filter(([, delay]) => delay === bucket * 1000).map(([id]) => id);

        const historyPayload = {
            entity_history: {
                "sensor.solar": [100, 100, 100],
                "sensor.grid_in": [0, 0, 0],
                "sensor.house": [100, 100, 100],
                "sensor.production_total": [100, 100, 100],
                "sensor.consumption_total": [100, 100, 100],
            },
        };
        window.__setTreeBuckets = (count) => {
            currentTree = { ...currentTree, uiConfig: { ...currentTree.uiConfig, history_buckets: count } };
        };
        window.__omitHouseHistory = () => { delete (historyPayload.entity_history as Record<string, number[]>)["sensor.house"]; };

        const heldTree: Array<{ resolve: () => void; reject: () => void }> = [];
        const heldHistory: Array<{ resolve: () => void; reject: () => void }> = [];
        const heldInverter: Array<() => void> = [];
        window.__resolveTree = () => { heldTree.splice(0).forEach((request) => request.resolve()); };
        window.__rejectTree = () => { heldTree.splice(0).forEach((request) => request.reject()); };
        window.__resolveHistory = () => { heldHistory.splice(0).forEach((request) => request.resolve()); };
        window.__rejectHistory = () => { heldHistory.splice(0).forEach((request) => request.reject()); };
        window.__resolveInverter = () => { heldInverter.splice(0).forEach((resolve) => resolve()); };
        window.__pending = () => ({ tree: heldTree.length, history: heldHistory.length, inverter: heldInverter.length });

        const states: Record<string, unknown> = {};
        for (const id of Object.keys(historyPayload.entity_history)) {
            states[id] = { state: "100", attributes: {} };
        }

        window.__hass = {
            language: "en",
            locale: { language: "en" },
            config: { time_zone: "UTC" },
            // Identity is what the shared store is keyed on, so it stays one object.
            connection: {
                sendMessagePromise: async () => ({}),
                subscribeMessage: window.__mockHass().connection.subscribeMessage,
            },
            states,
            callWS: window.__mockHass({
                "helman/get_device_tree": async (msg: {
                    type: string;
                }) => {
                    return new Promise((resolve, reject) => heldTree.push({
                        resolve: () => resolve(currentTree), reject: () => reject(new Error("tree unavailable")),
                    }));
                },
                "helman/get_history": async (msg: {
                    type: string;
                }) => {
                    return new Promise((resolve, reject) => heldHistory.push({
                        resolve: () => resolve(historyPayload), reject: () => reject(new Error("history unavailable")),
                    }));
                },
                "helman/get_controllable_entities": async (msg: {
                    type: string;
                }) => {
                    return { entities: [] };
                },
                "helman/get_node_detail": async (msg: {
                    type: string;
                    node: string;
                }) => {
                    if (msg.node !== "inverter") return {};
                    return new Promise((resolve) => heldInverter.push(() => resolve({
                        node: "inverter",
                        configured: true,
                        mode: { entityId: "select.inverter_mode", actionOptions: { normal: "normal" } },
                        entities: { link_success_rate: "sensor.inverter_link_success_rate" },
                    })));
                }
            }).callWS,
        };
    }, { bucket: bucketSeconds, treePayload: tree });
    await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-card") && !!customElements.get("helman-simple-card"));
}

for (const tag of ["helman-card", "helman-simple-card"] as const) {
    test.describe(`${tag}: a load that outlives its card`, () => {
        test.beforeEach(async ({ page }) => {
            await installFixture(page, BUCKET_SECONDS);
        });

        test("a device tree resolved after removal starts nothing and commits nothing", async ({ page }) => {
            const result = await page.evaluate(async (name) => {
                const card = document.createElement(name) as any;
                await card.setConfig({ type: `custom:${name}` });
                card.hass = window.__hass;
                document.body.appendChild(card);
                await new Promise<void>((done) => setTimeout(done, 0));

                card.remove();
                window.__mark();
                window.__resolveTree();
                window.__resolveHistory();
                await new Promise<void>((done) => window.__rawRaf(() => setTimeout(done, 0)));

                return {
                    connected: card.isConnected,
                    interval: card._historyEngine?._interval,
                    engine: !!card._historyEngine,
                    committedTree: (card._deviceTree?.length ?? 0) + (card._entityMap ? 1 : 0),
                    ...window.__sinceMark(),
                    liveBucketIntervals: window.__liveBucketIntervals().length,
                };
            }, tag);

            expect(result.connected).toBe(false);
            // The reproduction in #232: a detached card holding a running interval.
            expect(result.interval).toBeUndefined();
            expect(result.engine).toBe(false);
            expect(result.committedTree).toBe(0);
            expect(result.intervals).toBe(0);
            expect(result.frames).toBe(0);
            expect(result.liveBucketIntervals).toEqual(0);
        });

        test("a history resolved after removal starts nothing", async ({ page }) => {
            // The other half: the tree lands while the card is still on screen,
            // so only the second await is outstanding when it is removed.
            const result = await page.evaluate(async (name) => {
                const card = document.createElement(name) as any;
                await card.setConfig({ type: `custom:${name}` });
                card.hass = window.__hass;
                document.body.appendChild(card);
                await new Promise<void>((done) => setTimeout(done, 0));

                window.__resolveTree();
                await new Promise<void>((done) => setTimeout(done, 0));
                const historyWasPending = window.__pending().history > 0;

                card.remove();
                window.__mark();
                window.__resolveHistory();
                await new Promise<void>((done) => window.__rawRaf(() => setTimeout(done, 0)));

                return {
                    historyWasPending,
                    connected: card.isConnected,
                    interval: card._historyEngine?._interval,
                    engine: !!card._historyEngine,
                    ...window.__sinceMark(),
                    liveBucketIntervals: window.__liveBucketIntervals().length,
                };
            }, tag);

            expect(result.historyWasPending).toBe(true);
            expect(result.connected).toBe(false);
            expect(result.interval).toBeUndefined();
            expect(result.engine).toBe(false);
            expect(result.intervals).toBe(0);
            expect(result.frames).toBe(0);
            expect(result.liveBucketIntervals).toEqual(0);
        });

        test("disconnect and reconnect while pending leaves exactly one engine", async ({ page }) => {
            const result = await page.evaluate(async (name) => {
                const card = document.createElement(name) as any;
                await card.setConfig({ type: `custom:${name}` });
                card.hass = window.__hass;
                document.body.appendChild(card);
                await new Promise<void>((done) => setTimeout(done, 0));

                // Removed and re-added with both reads still in flight — the
                // shared store hands the second load the same promises, so one
                // release feeds both the obsolete load and the current one.
                card.remove();
                document.body.appendChild(card);
                await new Promise<void>((done) => setTimeout(done, 0));

                window.__resolveTree();
                await new Promise<void>((done) => setTimeout(done, 0));
                window.__resolveHistory();
                await new Promise<void>((done) => window.__rawRaf(() => setTimeout(done, 0)));

                return {
                    connected: card.isConnected,
                    interval: card._historyEngine?._interval,
                    liveBucketIntervals: window.__liveBucketIntervals(),
                };
            }, tag);

            expect(result.connected).toBe(true);
            // The card is loaded and ticking...
            expect(result.interval).toBeDefined();
            // ...and its engine is the only one left running.
            expect(result.liveBucketIntervals).toEqual([result.interval]);
        });

        test("a normal mount still installs a running engine", async ({ page }) => {
            const result = await page.evaluate(async (name) => {
                const card = document.createElement(name) as any;
                await card.setConfig({ type: `custom:${name}` });
                card.hass = window.__hass;
                document.body.appendChild(card);
                await new Promise<void>((done) => setTimeout(done, 0));

                window.__resolveTree();
                await new Promise<void>((done) => setTimeout(done, 0));
                window.__resolveHistory();
                await new Promise<void>((done) => window.__rawRaf(() => setTimeout(done, 0)));

                return {
                    interval: card._historyEngine?._interval,
                    liveBucketIntervals: window.__liveBucketIntervals().length,
                    committed: (card._deviceTree?.length ?? 0) + (card._entityMap ? 1 : 0),
                    loading: card._loading,
                };
            }, tag);

            expect(result.interval).toBeDefined();
            expect(result.liveBucketIntervals).toBe(1);
            expect(result.committed).toBeGreaterThan(0);
            if (result.loading !== undefined) expect(result.loading).toBe(false);
        });
    });
}

for (const tag of ["helman-card", "helman-simple-card"] as const) {
    for (const failedRead of ["tree", "history"] as const) {
        for (const detach of [false, true]) {
            test(`${tag}: pending inverter ${detach ? "stays obsolete after detach" : "recovers"} when ${failedRead} refresh fails`, async ({ page }) => {
                await installFixture(page, BUCKET_SECONDS);
                const result = await page.evaluate(async ({ tag, failedRead, detach }) => {
                    const card = document.createElement(tag) as any;
                    await card.setConfig({ type: `custom:${tag}` });
                    card.hass = window.__hass;
                    document.body.appendChild(card);
                    await new Promise<void>((done) => setTimeout(done, 0));
                    window.__resolveTree();
                    await new Promise<void>((done) => setTimeout(done, 0));
                    window.__resolveHistory();
                    await new Promise<void>((done) => setTimeout(done, 0));
                    const oldEngine = card._historyEngine;
                    const pendingBeforeRefresh = window.__pending().inverter;

                    const refresh = tag === "helman-card"
                        ? card._loadBackendData(true)
                        : card._loadFromBackend(true);
                    await new Promise<void>((done) => setTimeout(done, 0));
                    if (failedRead === "tree") window.__rejectTree();
                    else {
                        window.__resolveTree();
                        await new Promise<void>((done) => setTimeout(done, 0));
                        window.__rejectHistory();
                    }
                    await refresh;
                    const retained = card._historyEngine === oldEngine && card._inverter === null;
                    if (detach) card.remove();
                    window.__resolveInverter();
                    await new Promise<void>((done) => setTimeout(done, 0));
                    const result = {
                        pendingBeforeRefresh,
                        retained,
                        inverterLoaded: card._inverter?.node === "inverter",
                        watching: card._watchedEntityIds.has("select.inverter_mode")
                            && card._watchedEntityIds.has("sensor.inverter_link_success_rate"),
                    };
                    if (!detach) card.remove();
                    return result;
                }, { tag, failedRead, detach });

                expect(result).toEqual({
                    pendingBeforeRefresh: 1,
                    retained: true,
                    inverterLoaded: !detach,
                    watching: !detach,
                });
            });
        }
        test(`${tag}: a failed ${failedRead} refresh keeps history live until replacement`, async ({ page }) => {
            await installFixture(page, BUCKET_SECONDS);
            const result = await page.evaluate(async ({ tag, failedRead }) => {
                const card = document.createElement(tag) as any;
                await card.setConfig({ type: `custom:${tag}` });
                card.hass = window.__hass;
                document.body.appendChild(card);
                await new Promise<void>((done) => setTimeout(done, 0));
                window.__resolveTree();
                await new Promise<void>((done) => setTimeout(done, 0));
                window.__resolveHistory();
                await new Promise<void>((done) => setTimeout(done, 0));

                const oldEngine = card._historyEngine;
                const oldNode = tag === "helman-card"
                    ? card._deviceTree[1].children[0]
                    : card._houseNode;
                const refresh = () => tag === "helman-card"
                    ? card._loadBackendData(true)
                    : card._loadFromBackend(true);
                const first = refresh();
                await new Promise<void>((done) => setTimeout(done, 0));
                const duringTree = card._historyEngine === oldEngine
                    && window.__liveBucketIntervals().includes(oldEngine._interval);
                if (failedRead === "tree") window.__rejectTree();
                else {
                    window.__resolveTree();
                    await new Promise<void>((done) => setTimeout(done, 0));
                    if (window.__pending().history !== 1) throw new Error("history was not requested");
                    window.__rejectHistory();
                }
                await first;
                const afterFailure = card._historyEngine === oldEngine
                    && window.__liveBucketIntervals().length === 1
                    && window.__liveBucketIntervals()[0] === oldEngine._interval
                    && (tag === "helman-card" ? card._deviceTree[1].children[0] : card._houseNode) === oldNode;

                (window.__hass as any).states["sensor.house"] = { state: "250", attributes: {} };
                oldEngine.advanceBuckets(
                    tag === "helman-card" ? card._deviceTree : card._topLevelNodes(),
                    card._sourceNodes,
                );
                const updatedPower = oldNode.powerValue;

                const second = refresh();
                await new Promise<void>((done) => setTimeout(done, 0));
                window.__resolveTree();
                await new Promise<void>((done) => setTimeout(done, 0));
                window.__resolveHistory();
                await second;
                const newEngine = card._historyEngine;
                const replaced = newEngine !== oldEngine
                    && oldEngine._interval === undefined
                    && window.__liveBucketIntervals().length === 1
                    && window.__liveBucketIntervals()[0] === newEngine._interval;
                card.remove();
                return { duringTree, afterFailure, updatedPower, replaced, remaining: window.__liveBucketIntervals().length };
            }, { tag, failedRead });

            expect(result).toEqual({
                duringTree: true,
                afterFailure: true,
                updatedPower: 250,
                replaced: true,
                remaining: 0,
            });
        });
    }
}

test("helman-card: children use the incoming bucket count on mount and refresh", async ({ page }) => {
    await installFixture(page, BUCKET_SECONDS);
    const counts = await page.evaluate(async () => {
        window.__omitHouseHistory();
        const card = document.createElement("helman-card") as any;
        await card.setConfig({ type: "custom:helman-card" });
        card.hass = window.__hass;
        document.body.appendChild(card);
        await new Promise<void>((done) => setTimeout(done, 0));
        window.__resolveTree();
        await new Promise<void>((done) => setTimeout(done, 0));
        window.__resolveHistory();
        await new Promise<void>((done) => setTimeout(done, 0));

        const initial = {
            root: card._deviceTree[1].historyBuckets,
            child: card._deviceTree[1].children[0].historyBuckets,
        };
        window.__setTreeBuckets(5);
        const refresh = card._loadBackendData(true);
        await new Promise<void>((done) => setTimeout(done, 0));
        window.__resolveTree();
        await new Promise<void>((done) => setTimeout(done, 0));
        const visibleDuringRefresh = card._deviceTree[1].children[0].historyBuckets;
        window.__resolveHistory();
        await refresh;
        const updated = {
            root: card._deviceTree[1].historyBuckets,
            child: card._deviceTree[1].children[0].historyBuckets,
        };
        card.remove();
        return { initial, visibleDuringRefresh, updated };
    });

    expect(counts).toEqual({
        initial: { root: 3, child: 3 },
        visibleDuringRefresh: 3,
        updated: { root: 5, child: 5 },
    });
});

test.describe("helman-card: root titles", () => {
    test.beforeEach(async ({ page }) => {
        await installFixture(page, BUCKET_SECONDS);
    });

    for (const [language, sources, consumers] of [
        ["en", "Energy Sources", "Distribution"],
        ["cs", "Zdroje energie", "Distribuce"],
    ] as const) {
        test(`the roots are titled in the HA language (${language})`, async ({ page }) => {
            const names = await page.evaluate(async (lang) => {
                window.__hass.language = lang;
                window.__hass.locale = { language: lang };
                const card = document.createElement("helman-card") as any;
                await card.setConfig({ type: "custom:helman-card" });
                card.hass = window.__hass;
                document.body.appendChild(card);
                await new Promise<void>((done) => setTimeout(done, 0));

                window.__resolveTree();
                await new Promise<void>((done) => setTimeout(done, 0));
                window.__resolveHistory();
                await new Promise<void>((done) => window.__rawRaf(() => setTimeout(done, 0)));

                return (card._deviceTree ?? []).map((item: { name: string }) => item.name);
            }, language);

            expect(names).toEqual([sources, consumers]);
        });
    }
});
