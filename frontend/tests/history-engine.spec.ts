import { test, expect } from "@playwright/test";
import { HistoryEngine } from "../cards/helman/history-engine";
import { DeviceNode } from "../cards/helman/DeviceNode";
import { nodeAccentColor } from "../cards/color-utils";

/**
 * The pairing between a consumer's power buckets and its source attribution.
 *
 * Every consumer bar is drawn from two arrays read at the same index: how much
 * the device drew in that bucket, and which sources fed it. The two are filled
 * from separate backend series and then advanced live, so nothing about them is
 * paired by construction — the pairing is this engine's job, and #227 is what it
 * looks like when it slips: bars painted with the fallback colour, or with a
 * neighbouring bucket's mix, while the house ran on uninterrupted solar.
 *
 * The engine touches no DOM, so it runs here directly rather than through the
 * bundle. `advanceBuckets` coalesces its notification onto an animation frame,
 * which Node has none of — the stub below is only there to receive it.
 */

const RATIO_SOLAR = "sensor.helman_source_ratio_solar";
const RATIO_GRID = "sensor.helman_source_ratio_grid";
const LOAD = "sensor.washer_power";

type States = Record<string, { state: string }>;

/** A hass double carrying only what the engine reads: `states`. */
function hass(values: Record<string, number>): any {
    const states: States = {};
    for (const [id, v] of Object.entries(values)) states[id] = { state: String(v) };
    return { states };
}

/** The two source nodes every fixture below attributes to. */
function sourceNodes(): DeviceNode[] {
    const solar = new DeviceNode("solar", "Solar", "sensor.solar_power", null, 5);
    solar.isSource = true;
    solar.sourceType = "solar";
    solar.ratioSensorId = RATIO_SOLAR;
    const grid = new DeviceNode("grid", "Grid", "sensor.grid_power", null, 5);
    grid.isSource = true;
    grid.sourceType = "grid";
    grid.ratioSensorId = RATIO_GRID;
    return [solar, grid];
}

/** One measured consumer, the node whose bars the issue is about. */
function consumerNode(): DeviceNode {
    return new DeviceNode("washer", "Washer", LOAD, null, 5);
}

/** An engine over a fixed hass, with the frame callback stubbed out. */
function engine(states: any, maxBuckets = 5): HistoryEngine {
    (globalThis as any).requestAnimationFrame ??= (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
    };
    return new HistoryEngine(() => states, maxBuckets, () => {});
}

/** Which source id each bucket was attributed to, or `null` where none was. */
function attribution(node: DeviceNode): (string | null)[] {
    return (node.sourcePowerHistory ?? []).map((bucket) => {
        const ids = Object.keys(bucket);
        return ids.length === 0 ? null : ids.join("+");
    });
}

test.describe("HistoryEngine power/source pairing", () => {
    test("hydrates one source bucket per actual power bucket, not per configured capacity", async () => {
        // The backend serves the live deque contents, which are shorter than the
        // configured capacity until the buffers have filled — right after startup
        // or a subscription rebuild. This is the trigger in #227: sized by
        // capacity, the source series was born longer than the power series.
        const node = consumerNode();
        engine(hass({})).applyHistory(
            {
                buckets: 5,
                bucket_duration: 60,
                entity_history: {
                    [LOAD]: [100, 100],
                    [RATIO_SOLAR]: [100, 100],
                    [RATIO_GRID]: [0, 0],
                },
            } as any,
            [node],
            sourceNodes(),
        );

        expect(node.powerHistory).toEqual([100, 100]);
        expect(node.sourcePowerHistory).toHaveLength(2);
        expect(attribution(node)).toEqual(["solar", "solar"]);
    });

    test("keeps a changing mix on the bucket it belongs to", async () => {
        // Distinct ratios per bucket, so a whole-array offset shows up as the wrong
        // colour rather than as no colour at all.
        const node = consumerNode();
        engine(hass({})).applyHistory(
            {
                buckets: 5,
                bucket_duration: 60,
                entity_history: {
                    [LOAD]: [100, 200, 300],
                    [RATIO_SOLAR]: [100, 0, 50],
                    [RATIO_GRID]: [0, 100, 50],
                },
            } as any,
            [node],
            sourceNodes(),
        );

        expect(attribution(node)).toEqual(["solar", "grid", "solar+grid"]);
        expect(node.sourcePowerHistory![0].solar.power).toBe(100);
        expect(node.sourcePowerHistory![1].grid.power).toBe(200);
        expect(node.sourcePowerHistory![2].solar.color).toBe(nodeAccentColor('solar'));
        expect(node.sourcePowerHistory![2].grid.color).toBe(nodeAccentColor('grid'));
    });

    test("a partial payload advanced past capacity never drifts out of step", async () => {
        // The reproduction from #227: two historical buckets, capacity five,
        // constant 100 W drawn from 100 % solar. Every bar must stay solar, and
        // the two series must stay the same length through every push and trim.
        const node = consumerNode();
        const sources = sourceNodes();
        const states = hass({ [LOAD]: 100, [RATIO_SOLAR]: 100, [RATIO_GRID]: 0 });
        const eng = engine(states);
        eng.applyHistory(
            {
                buckets: 5,
                bucket_duration: 60,
                entity_history: {
                    [LOAD]: [100, 100],
                    [RATIO_SOLAR]: [100, 100],
                    [RATIO_GRID]: [0, 0],
                },
            } as any,
            [node],
            sources,
        );

        for (let tick = 0; tick < 8; tick++) {
            eng.advanceBuckets([node], sources);
            expect(node.sourcePowerHistory).toHaveLength(node.powerHistory.length);
            expect(node.powerHistory.length).toBeLessThanOrEqual(5);
            expect(attribution(node)).not.toContain(null);
        }
        expect(node.powerHistory).toEqual([100, 100, 100, 100, 100]);
        expect(attribution(node)).toEqual(["solar", "solar", "solar", "solar", "solar"]);
    });

    test("live buckets keep the mix that was current when they were filled", async () => {
        // Solar for the first live bucket, grid for the second: after the switch
        // the older bucket must still read solar. A shared offset would move the
        // whole series and repaint history.
        const node = consumerNode();
        const sources = sourceNodes();
        const states = hass({ [LOAD]: 100, [RATIO_SOLAR]: 100, [RATIO_GRID]: 0 });
        const eng = engine(states);
        eng.applyHistory({ buckets: 5, bucket_duration: 60, entity_history: {} } as any, [node], sources);

        eng.advanceBuckets([node], sources);
        states.states[RATIO_SOLAR] = { state: "0" };
        states.states[RATIO_GRID] = { state: "100" };
        eng.advanceBuckets([node], sources);
        states.states[RATIO_SOLAR] = { state: "100" };
        states.states[RATIO_GRID] = { state: "0" };
        eng.advanceBuckets([node], sources);

        expect(attribution(node)).toEqual(["solar", "grid", "solar"]);
    });

    test("a consumer missing from the payload is attributed from its first live sample", async () => {
        // Nothing in `entity_history` for this node — a device added between the
        // buffer rebuild and the card opening. Its attribution has to start with
        // its first live bucket; there is no historical one to grow it from.
        const node = consumerNode();
        const sources = sourceNodes();
        const states = hass({ [LOAD]: 100, [RATIO_SOLAR]: 100, [RATIO_GRID]: 0 });
        const eng = engine(states);
        eng.applyHistory(
            { buckets: 5, bucket_duration: 60, entity_history: { [RATIO_SOLAR]: [100], [RATIO_GRID]: [0] } } as any,
            [node],
            sources,
        );

        eng.advanceBuckets([node], sources);

        expect(node.powerHistory).toEqual([100]);
        expect(attribution(node)).toEqual(["solar"]);
    });

    test("a bucket with no source ratio still falls back to an empty mix", async () => {
        // The fallback colour is the correct answer when attribution is genuinely
        // unavailable — the fix must not manufacture a mix out of nothing.
        const node = consumerNode();
        const sources = sourceNodes();
        const states = hass({ [LOAD]: 100, [RATIO_SOLAR]: 0, [RATIO_GRID]: 0 });
        const eng = engine(states);
        eng.applyHistory({ buckets: 5, bucket_duration: 60, entity_history: {} } as any, [node], sources);

        eng.advanceBuckets([node], sources);

        expect(attribution(node)).toEqual([null]);
    });

    test("attribution follows the tree down to nested consumers", async () => {
        // `_advanceTree` recurses; the house's children are where the reported
        // screenshot's mismatched bands were.
        const house = new DeviceNode("house", "House", "sensor.house_power", null, 5);
        const child = consumerNode();
        house.children = [child];
        const sources = sourceNodes();
        const states = hass({
            "sensor.house_power": 500,
            [LOAD]: 100,
            [RATIO_SOLAR]: 100,
            [RATIO_GRID]: 0,
        });
        const eng = engine(states);
        eng.applyHistory({ buckets: 5, bucket_duration: 60, entity_history: {} } as any, HistoryEngine.walkTree([house]), sources);

        eng.advanceBuckets([house], sources);

        expect(attribution(house)).toEqual(["solar"]);
        expect(attribution(child)).toEqual(["solar"]);
    });
});
