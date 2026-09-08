import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

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

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

/** Bucket duration of the fixture, in seconds — the discriminator for its interval. */
const BUCKET_SECONDS = 7;

declare global {
    interface Window {
        /** Let the held `helman/get_device_tree` responses return. */
        __resolveTree: () => void;
        /** Let the held `helman/get_history` responses return. */
        __resolveHistory: () => void;
        /** How many requests of each kind are still held open. */
        __pending: () => { tree: number; history: number };
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
    await page.evaluate((bucket) => {
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

        const node = (id: string, sensor: string, sourceType: string | null) => ({
            id,
            displayName: id,
            powerSensorId: sensor,
            ratioSensorId: null,
            switchEntityId: null,
            valueType: "default",
            sourceConfig: null,
            sourceType,
            isSource: sourceType !== null,
            isUnmeasured: false,
            labels: [],
            labelBadgeTexts: [],
            icon: null,
            compact: false,
            showAdditionalInfo: false,
            childrenFullWidth: false,
            hideChildren: false,
            hideChildrenIndicator: false,
            sortChildrenByPower: false,
            deferrable: false,
            controllableId: null,
            children: [],
        });

        const treePayload = {
            sources: [node("solar", "sensor.solar", "solar"), node("grid", "sensor.grid_in", "grid")],
            consumers: [node("house", "sensor.house", null)],
            consumptionTotalSensorId: "sensor.consumption_total",
            productionTotalSensorId: "sensor.production_total",
            uiConfig: {
                sources_title: "Sources",
                consumers_title: "Consumers",
                groups_title: "Groups",
                others_group_label: "Others",
                show_others_group: false,
                device_label_text: {},
                history_buckets: 3,
                history_bucket_duration: bucket,
            },
        };

        const historyPayload = {
            buckets: 3,
            bucket_duration: bucket,
            entity_history: {
                "sensor.solar": [100, 100, 100],
                "sensor.grid_in": [0, 0, 0],
                "sensor.house": [100, 100, 100],
                "sensor.production_total": [100, 100, 100],
                "sensor.consumption_total": [100, 100, 100],
            },
        };

        const heldTree: Array<() => void> = [];
        const heldHistory: Array<() => void> = [];
        window.__resolveTree = () => { heldTree.splice(0).forEach((release) => release()); };
        window.__resolveHistory = () => { heldHistory.splice(0).forEach((release) => release()); };
        window.__pending = () => ({ tree: heldTree.length, history: heldHistory.length });

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
                subscribeMessage: async () => () => undefined,
            },
            states,
            callWS: async (msg: { type: string }) => {
                if (msg.type === "helman/get_device_tree") {
                    return new Promise((release) => heldTree.push(() => release(treePayload)));
                }
                if (msg.type === "helman/get_history") {
                    return new Promise((release) => heldHistory.push(() => release(historyPayload)));
                }
                if (msg.type === "helman/get_schedule") return { executionEnabled: true, slots: [] };
                if (msg.type === "helman/get_controllable_entities") return { entities: [] };
                if (msg.type === "helman/get_appliances") return { appliances: [] };
                return {};
            },
        };
    }, bucketSeconds);
    await page.addScriptTag({ path: BUNDLE, type: "module" });
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
