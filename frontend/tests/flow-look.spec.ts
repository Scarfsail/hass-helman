import { test, expect, type Page } from "@playwright/test";
import { CARD_BUNDLE, loadBundle } from "./support/card-page";
import { installMockHass } from "./support/mock-hass";
import { cardTree, treeNode, treePayload } from "./support/payload-builders";
import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { BEAT_MS, flowLevel, flowSurges, flowTempo, flowThickness, flowTier } from "../cards/shared/flow-style";

/**
 * The look of a flow (#770): one ratio per flow and per node, `r = power / max`,
 * drives five cues that agree with each other -- beam thickness and brightness,
 * surge rate and speed, glow brightness and size -- and every pulse and glow
 * on the page sits on one shared half-beat grid.
 *
 * The animated elements only ever move their transform, or their opacity
 * between their tier's floor and 1; what scales with power sits on static
 * wrappers. So a power tick inside a tier restarts nothing, and the alignment
 * is a matter of every animation's start time being the document's origin.
 */

const RATIOS = [0, 0.19, 0.2, 0.49, 0.5, 1];

test.describe("the tables, unit-checked", () => {
    test("beam thickness is 2.5 px at least and 14 px at the maximum", () => {
        expect(RATIOS.map(flowThickness)).toEqual([2.5, 2.66, 2.8, 6.86, 7, 14].map((w) => expect.closeTo(w, 5)));
    });

    test("the level runs from 0.2 to 1 along r^0.7", () => {
        expect(RATIOS.map(flowLevel)).toEqual([0.2, 0.2 + 0.8 * 0.19 ** 0.7, 0.2 + 0.8 * 0.2 ** 0.7, 0.2 + 0.8 * 0.49 ** 0.7, 0.2 + 0.8 * 0.5 ** 0.7, 1]
            .map((k) => expect.closeTo(k, 10)));
        expect(flowLevel(0.5)).toBeCloseTo(0.6925, 4);
    });

    test("the tiers split at 0.2 and 0.5", () => {
        expect(RATIOS.map(flowTier)).toEqual([0, 0, 1, 1, 2, 2]);
    });

    test("each tier's interval and travel, long edge and short, in beats", () => {
        expect(RATIOS.map((r) => [flowTempo(flowTier(r), false), flowTempo(flowTier(r), true)])).toEqual([
            [{ interval: 4, travel: 3 }, { interval: 4, travel: 1 }],
            [{ interval: 4, travel: 3 }, { interval: 4, travel: 1 }],
            [{ interval: 1, travel: 1.5 }, { interval: 1, travel: 0.5 }],
            [{ interval: 1, travel: 1.5 }, { interval: 1, travel: 0.5 }],
            [{ interval: 0.5, travel: 1 }, { interval: 0.5, travel: 0.5 }],
            [{ interval: 0.5, travel: 1 }, { interval: 0.5, travel: 0.5 }],
        ]);
    });
});

// ── Mounting ─────────────────────────────────────────────────────────────────

/** A page tall enough to scroll everything on it out of the viewport. */
const PAGE = `<!doctype html><html><body style="margin:0;background:#111">
<div id="stage" style="width:600px"></div>
<div id="spacer" style="height:4000px"></div>
</body></html>`;

/** The simple card on a fake backend, its four meters reading `powers` (W). */
async function mountSimpleCard(page: Page, powers: { solar: number; house: number; battery: number; grid: number }, darkMode = true): Promise<void> {
    await page.setContent(PAGE);
    await installMockHass(page);
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.evaluate(({ p, tree, darkMode }) => {
        const watts = (value: number) => ({ state: String(value), attributes: { unit_of_measurement: "W" } });
        (window as any).__hass = {
            language: "en",
            locale: { language: "en-GB" },
            config: { time_zone: "UTC" },
            themes: { darkMode },
            connection: { sendMessagePromise: async () => ({}), subscribeMessage: window.__mockHass().connection.subscribeMessage },
            states: {
                "sensor.solar": watts(p.solar), "sensor.house": watts(p.house),
                "sensor.battery": watts(p.battery), "sensor.grid": watts(p.grid),
            },
            callWS: window.__mockHass({
                "helman/get_device_tree": async () => tree,
                "helman/get_history": async () => ({ entity_history: {} }),
                "helman/get_node_detail": async () => { throw new Error("no inverter"); },
            }).callWS,
        };
    }, { p: powers, tree: cardTree(), darkMode });
    await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-simple-card"));
    await page.evaluate(() => {
        const card = document.createElement("helman-simple-card") as any;
        card.setConfig({ type: "custom:helman-simple-card" });
        card.hass = (window as any).__hass;
        document.getElementById("stage")!.appendChild(card);
    });
    await expect(page.locator("helman-simple-card .energy-grid")).toBeVisible();
}

/** Mount `power-flow-arrows` on the page as it is, under whatever is already there. */
async function addArrows(page: Page, powers: number[], maxPower: number): Promise<void> {
    await page.evaluate(async ({ powers, maxPower }) => {
        const el = document.createElement("power-flow-arrows") as any;
        el.devices = powers.map((powerValue) => ({ powerValue }));
        el.maxPower = maxPower;
        document.getElementById("stage")!.appendChild(el);
        await el.updateComplete;
    }, { powers, maxPower });
}

/** Every animation of every `data-beat` element on the page, through every shadow root. */
const BEAT_ANIMATIONS = `(() => {
    const roots = [document];
    for (let i = 0; i < roots.length; i++) {
        for (const el of roots[i].querySelectorAll("*")) if (el.shadowRoot) roots.push(el.shadowRoot);
    }
    return roots.flatMap((root) => [...root.querySelectorAll("[data-beat]")])
        .flatMap((el) => el.getAnimations({ subtree: true }));
})()`;

// ── The simple card: strong against weak ─────────────────────────────────────

/**
 * 4 kW from the grid into the battery next to 0.9 kW from the grid to the
 * house, scaled by 1.6 to this tree's maxima (grid 11.5 kW, battery 5 kW):
 * the battery's flow lands in tier 2 and the house's in tier 0.
 */
const NIGHT_CHARGE = { solar: 0, house: 1440, battery: 6400, grid: 7840 };

test.describe("a strong flow next to a weak one", () => {
    test.beforeEach(async ({ page }) => {
        await mountSimpleCard(page, NIGHT_CHARGE);
    });

    test("the strong flow is thicker, brighter and more frequent", async ({ page }) => {
        const beams = await page.evaluate(() => {
            const root = document.querySelector("helman-simple-card")!.shadowRoot!;
            return Object.fromEntries(["grid-battery", "grid-house"].map((flow) => {
                const body = root.querySelector(`line[data-flow="${flow}"]`)!;
                const surges = [...body.parentElement!.querySelectorAll(`[data-beat="surge"]`)]
                    .filter((surge) => surge.closest("g[mask]")!.getAttribute("mask")!.includes(flow));
                const loop = surges[0].getAnimations()[0].effect!.getTiming().duration as number;
                return [flow, {
                    width: Number(body.getAttribute("stroke-width")),
                    opacity: Number(getComputedStyle(body).opacity),
                    tier: surges[0].getAttribute("data-tier"),
                    surges: surges.length,
                    // Surges leave one interval apart, each on a loop of as many intervals as there are surges.
                    interval: loop / surges.length,
                    loop,
                }];
            }));
        });
        const strong = beams["grid-battery"];
        const weak = beams["grid-house"];
        expect([strong.tier, weak.tier]).toEqual(["2", "0"]);
        expect(strong.width).toBeGreaterThan(weak.width);
        expect(strong.opacity).toBeGreaterThan(weak.opacity);
        expect(strong.interval).toBeLessThan(weak.interval);
        expect(strong.interval).toBe(BEAT_MS / 2);
        expect(weak.interval).toBe(BEAT_MS * 4);
        // Surges in transit at once, on average: count x travel / loop. A weak flow on a long edge carries fewer.
        const inTransit = (beam: typeof strong, tier: 0 | 2, short: boolean) => beam.surges * flowTempo(tier, short).travel * BEAT_MS / beam.loop;
        expect(inTransit(weak, 0, false)).toBeCloseTo(0.75, 10);
        expect(inTransit(strong, 2, true)).toBeCloseTo(1, 10);
        expect(inTransit(strong, 2, true)).toBeGreaterThan(inTransit(weak, 0, false));
    });

    test("the battery glows larger, brighter and quicker than the house, and neither glow goes dark", async ({ page }) => {
        const halos = await page.evaluate(() => {
            const root = document.querySelector("helman-simple-card")!.shadowRoot!;
            const halo = (node: string) => {
                const halo = root.querySelector(`simple-card-${node}`)!.parentElement!.querySelector<HTMLElement>(".halo")!;
                const animation = halo.getAnimations()[0];
                return {
                    size: halo.getBoundingClientRect().width,
                    level: Number(getComputedStyle(halo.parentElement!).opacity),
                    period: animation.effect!.getTiming().duration as number,
                    floor: Math.min(...(animation.effect as KeyframeEffect).getKeyframes().map((frame) => Number(frame.opacity))),
                };
            };
            return { battery: halo("battery"), house: halo("house") };
        });
        expect(halos.battery.size).toBeGreaterThan(halos.house.size);
        expect(halos.battery.level).toBeGreaterThan(halos.house.level);
        expect(halos.battery.period).toBeLessThan(halos.house.period);
        expect(halos.battery.floor).toBeGreaterThan(0);
        expect(halos.house.floor).toBeGreaterThan(0);

        // Sampled across a slow period: the animated opacity never reaches 0.
        const samples = await page.evaluate(async () => {
            const root = document.querySelector("helman-simple-card")!.shadowRoot!;
            const halos = [...root.querySelectorAll<HTMLElement>(".halo")];
            const seen: number[] = [];
            const until = performance.now() + 2800;
            while (performance.now() < until) {
                await new Promise(requestAnimationFrame);
                for (const halo of halos) seen.push(Number(getComputedStyle(halo).opacity));
            }
            return seen;
        });
        expect(Math.min(...samples)).toBeGreaterThan(0);
    });

    test("a node with no flow has no halo", async ({ page }) => {
        const halos = await page.evaluate(() => {
            const root = document.querySelector("helman-simple-card")!.shadowRoot!;
            return ["solar", "grid", "house", "battery"].map((node) =>
                !!root.querySelector(`simple-card-${node}`)!.parentElement!.querySelector(".halo"));
        });
        expect(halos).toEqual([false, true, true, true]);
    });
});

// ── One rhythm ───────────────────────────────────────────────────────────────

/** Whether every beat animation counts from the document's origin, and how far apart their clocks are. */
function origin(page: Page): Promise<{ count: number; startTimes: number[]; spread: number }> {
    return page.evaluate(async (expression) => {
        await new Promise(requestAnimationFrame);
        const animations = eval(expression) as Animation[];
        const running = animations.filter((animation) => animation.playState === "running");
        const times = running.map((animation) => Number(animation.currentTime));
        return {
            count: running.length,
            startTimes: [...new Set(running.map((animation) => Number(animation.startTime)))],
            spread: Math.max(...times) - Math.min(...times),
        };
    }, BEAT_ANIMATIONS);
}

test("two components mounted a second apart share one origin, also after the arrows scroll out and back", async ({ page }) => {
    await mountSimpleCard(page, NIGHT_CHARGE);
    await page.waitForTimeout(1000);
    await addArrows(page, [8000, 2000], 25 * 230 * 3);

    const mounted = await origin(page);
    expect(mounted.count).toBeGreaterThan(4);
    expect(mounted.startTimes).toEqual([0]);
    // Within one frame: the clocks agree, so each one's phase is its own delay.
    expect(mounted.spread).toBeLessThan(17);

    await page.evaluate(() => window.scrollTo(0, 3000));
    await expect.poll(() => page.evaluate((expression) =>
        (eval(expression) as Animation[]).some((animation) => animation.playState === "paused"), BEAT_ANIMATIONS)).toBe(true);
    await page.waitForTimeout(700);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate((expression) =>
        (eval(expression) as Animation[]).every((animation) => animation.playState === "running"), BEAT_ANIMATIONS)).toBe(true);

    const resumed = await origin(page);
    expect(resumed.count).toBe(mounted.count);
    expect(resumed.startTimes).toEqual([0]);
    expect(resumed.spread).toBeLessThan(17);
});

test("animations the browser recreates on a remount or on being shown rejoin the origin", async ({ page }) => {
    await mountSimpleCard(page, NIGHT_CHARGE);
    await page.evaluate(async () => {
        const stage = document.getElementById("stage")!;
        const card = stage.querySelector("helman-simple-card")!;
        card.remove();
        await new Promise((resolve) => setTimeout(resolve, 700));
        stage.appendChild(card);
    });
    const remounted = await origin(page);
    expect(remounted.count).toBeGreaterThan(4);
    expect(remounted.startTimes).toEqual([0]);

    await page.evaluate(async () => {
        const stage = document.getElementById("stage")!;
        stage.style.display = "none";
        await new Promise((resolve) => setTimeout(resolve, 700));
        stage.style.display = "";
    });
    const shown = await origin(page);
    expect(shown.count).toBe(remounted.count);
    expect(shown.startTimes).toEqual([0]);
});

test("a power change within a tier restarts no animation", async ({ page }) => {
    await mountSimpleCard(page, NIGHT_CHARGE);
    await addArrows(page, [0.6 * 25 * 230 * 3], 25 * 230 * 3);
    await page.evaluate((expression) => { (window as any).__before = eval(expression); }, BEAT_ANIMATIONS);

    // Every flow and node a little stronger, each still in its tier.
    await page.evaluate(async () => {
        const hass = (window as any).__hass;
        const watts = (value: number) => ({ state: String(value), attributes: { unit_of_measurement: "W" } });
        const card = document.querySelector("helman-simple-card") as any;
        card.hass = { ...hass, states: { ...hass.states, "sensor.house": watts(1600), "sensor.grid": watts(8100) } };
        await card.updateComplete;
        const arrows = document.querySelector("power-flow-arrows") as any;
        arrows.devices[0].powerValue = 0.8 * 25 * 230 * 3;
        arrows.historyRevision = 1;
        await arrows.updateComplete;
    });

    const after = await page.evaluate((expression) => {
        const before = (window as any).__before as Animation[];
        const now = eval(expression) as Animation[];
        return { before: before.length, now: now.length, same: now.every((animation) => before.includes(animation)) };
    }, BEAT_ANIMATIONS);
    expect(after.now).toBe(after.before);
    expect(after.same).toBe(true);
    // And the change did reach the page: the weak flow is brighter.
    const opacity = await page.evaluate(() =>
        Number(getComputedStyle(document.querySelector("helman-simple-card")!.shadowRoot!.querySelector('line[data-flow="grid-house"]')!).opacity));
    expect(opacity).toBeCloseTo(0.25 + 0.65 * flowLevel(1600 / 11500), 5);
});

test.describe("reduced motion", () => {
    test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
    });

    test("nothing moves, and the beams, surges and glows stay lit where they are", async ({ page }) => {
        await mountSimpleCard(page, NIGHT_CHARGE);
        await addArrows(page, [8000], 25 * 230 * 3);

        expect(await page.evaluate((expression) => (eval(expression) as Animation[]).length, BEAT_ANIMATIONS)).toBe(0);
        const still = await page.evaluate(() => {
            const root = document.querySelector("helman-simple-card")!.shadowRoot!;
            const arrows = document.querySelector("power-flow-arrows")!.shadowRoot!;
            const body = root.querySelector('line[data-flow="grid-battery"]')!;
            const surges = [...root.querySelectorAll('[data-beat="surge"]')].map((surge) => getComputedStyle(surge).transform);
            return {
                body: Number(getComputedStyle(body).opacity),
                halos: [...root.querySelectorAll(".halo")].map((halo) => Number(getComputedStyle(halo).opacity)),
                surges,
                arrowSurges: [...arrows.querySelectorAll(".band")].map((band) => getComputedStyle(band).transform),
            };
        });
        expect(still.body).toBeGreaterThan(0.25);
        expect(still.halos.length).toBeGreaterThan(0);
        for (const opacity of still.halos) expect(opacity).toBeCloseTo(0.6, 5);
        // Spread along the beam: every surge rests somewhere different.
        expect(still.surges.every((transform) => transform !== "none")).toBe(true);
        expect(new Set(still.surges).size).toBe(still.surges.length);
        expect(new Set(still.arrowSurges).size).toBe(still.arrowSurges.length);
    });
});

test("a light theme drops the white from the hot core", async ({ page }) => {
    await mountSimpleCard(page, NIGHT_CHARGE, false);
    const mix = await page.evaluate(() => {
        const card = document.querySelector("helman-simple-card")!;
        return { light: card.hasAttribute("light-theme"), mix: getComputedStyle(card).getPropertyValue("--helman-flow-hot-mix").trim() };
    });
    expect(mix).toEqual({ light: true, mix: "0%" });

    await mountSimpleCard(page, NIGHT_CHARGE, true);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("helman-simple-card")!).getPropertyValue("--helman-flow-hot-mix").trim())).toBe("80%");
});

// ── The helman card's rows ───────────────────────────────────────────────────

const SOLAR = "#facc15";
const GRID = "#38bdf8";
/** How the history engine stores each source in a bucket: its translucent accent, `nodeAccentColor`. */
const SOLAR_ACCENT = `${SOLAR}60`;
const GRID_ACCENT = `${GRID}60`;
const SOLAR_RGB = "rgb(250, 204, 21)";
const GRID_RGB = "rgb(56, 189, 248)";

/** A row shaped the way the card's hydrated tree shapes it. */
function row(id: string, powerValue: number, extra: Record<string, unknown> = {}) {
    return {
        id, name: id, groups: {}, children: [], valueType: "default", isSource: false, isUnmeasured: false,
        powerValue, historyBuckets: 3, powerHistory: [powerValue, powerValue], ...extra,
    };
}

/** One list of rows with `beat`, and each row's glow: its outline colour and shadow, or null. */
async function rowGlows(page: Page, devices: object[], beat: object, centreContent?: string) {
    return page.evaluate(async ({ devices, beat, centreContent }) => {
        const el = document.createElement("helman-tree-item-list") as any;
        el.hass = { states: {}, locale: { language: "en" } };
        el.devices = devices;
        el.historyBuckets = 3;
        el.historyBucketDuration = 1;
        el.historyRevision = 0;
        el.beat = beat;
        el.centreContent = centreContent;
        document.body.appendChild(el);
        await el.updateComplete;
        const rows = [...el.shadowRoot.querySelectorAll("helman-tree-item")] as any[];
        await Promise.all(rows.map((item) => item.updateComplete));
        return rows.map((item) => {
            const glow = item.shadowRoot.querySelector(".glow") as HTMLElement | null;
            return glow && { border: getComputedStyle(glow).borderTopColor, shadow: getComputedStyle(glow).boxShadow, tier: glow.dataset.tier };
        });
    }, { devices, beat, centreContent });
}

test.describe("the helman card's row glow", () => {
    const MAX = 25 * 230 * 3;

    test.beforeEach(async ({ page }) => {
        await loadBundle(page, "helman-tree-item-list");
    });

    test("an emitting row glows in its own colour, and a row with no power not at all", async ({ page }) => {
        const glows = await rowGlows(page, [
            row("solar", 6400, { isSource: true, sourceType: "solar" }),
            row("grid", 0, { isSource: true, sourceType: "grid" }),
        ], { role: "emit", leavesAt: 0, maxPower: MAX });
        expect(glows[0]!.border).toBe(SOLAR_RGB);
        expect(glows[0]!.shadow).toContain("inset");
        expect(glows[1]).toBeNull();
    });

    test("a receiving row glows in its dominant source's colour, at full strength like an emitting one", async ({ page }) => {
        const glows = await rowGlows(page, [
            row("battery", 4000, { sourceType: "battery", sourcePowerHistory: [{ solar: { power: 3000, color: SOLAR_ACCENT }, grid: { power: 1000, color: GRID_ACCENT } }] }),
            row("house", 900, { sourcePowerHistory: [{ solar: { power: 100, color: SOLAR_ACCENT }, grid: { power: 800, color: GRID_ACCENT } }] }),
        ], { role: "receive", leavesAt: 0.5, maxPower: MAX });
        expect(glows.map((glow) => glow!.border)).toEqual([SOLAR_RGB, GRID_RGB]);
    });

    test("the distribution row glows by its outline only, nothing inside it", async ({ page }) => {
        const glows = await rowGlows(page, [
            row("consumers", 6400, { sourcePowerHistory: [{ solar: { power: 6400, color: SOLAR_ACCENT } }] }),
        ], { role: "receive", leavesAt: 0, travelPower: 6400, maxPower: MAX }, "inverter");
        expect(glows[0]!.border).toBe(SOLAR_RGB);
        expect(glows[0]!.shadow).not.toBe("none");
        expect(glows[0]!.shadow).not.toContain("inset");
    });

    test("an expanded row glows around its own box, not around its children", async ({ page }) => {
        await rowGlows(page, [
            row("house", 3000, {
                childrenCollapsed: false,
                children: [row("washer", 2000), row("fridge", 1000)],
                sourcePowerHistory: [{ solar: { power: 3000, color: SOLAR_ACCENT } }],
            }),
        ], { role: "receive", leavesAt: 0.5, maxPower: MAX });
        const boxes = await page.evaluate(() => {
            const item = document.querySelector("helman-tree-item-list")!.shadowRoot!.querySelector("helman-tree-item")!;
            const box = (selector: string) => {
                const { top, left, width, height } = item.shadowRoot!.querySelector(selector)!.getBoundingClientRect();
                return { top, left, width, height };
            };
            return { glow: box(".glow"), content: box(".deviceContent"), device: box(".device"), children: !!item.shadowRoot!.querySelector(".childrenContainer") };
        });
        expect(boxes.children).toBe(true);
        expect(boxes.glow).toEqual(boxes.content);
        expect(boxes.device.height).toBeGreaterThan(boxes.content.height);
    });
});

test("on the helman card the top-level rows glow and the house's devices never do", async ({ page }) => {
    await page.setContent("<!doctype html><html><body></body></html>");
    await installMockHass(page);
    const tree = treePayload({
        sources: [
            treeNode({ id: "solar", displayName: "solar", powerSensorId: "sensor.solar", sourceType: "solar", isSource: true }),
        ],
        consumers: [
            treeNode({
                id: "house",
                displayName: "house",
                powerSensorId: "sensor.house",
                children: [
                    treeNode({ id: "washer", displayName: "washer", powerSensorId: "sensor.washer" }),
                    treeNode({ id: "fridge", displayName: "fridge", powerSensorId: "sensor.fridge" }),
                ],
            }),
        ],
        uiConfig: { device_groupings: [], history_buckets: 3, history_bucket_duration: 60 },
    });
    await page.evaluate((payload) => {
        const watts = (value: number) => ({ state: String(value), attributes: { unit_of_measurement: "W" } });
        (window as any).__hass = {
            ...window.__mockHass({
                "helman/get_device_tree": payload,
                "helman/get_history": { entity_history: {} },
                "helman/get_node_detail": { entities: {} },
            }),
            language: "en", locale: { language: "en" }, config: { time_zone: "UTC" },
            states: { "sensor.solar": watts(3000), "sensor.house": watts(3000), "sensor.washer": watts(2000), "sensor.fridge": watts(1000) },
        };
    }, tree);
    await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
    await page.evaluate(() => {
        const card = document.createElement("helman-card") as any;
        card.setConfig({ type: "custom:helman-card" });
        card.hass = (window as any).__hass;
        document.body.appendChild(card);
    });

    const glows = () => page.evaluate(() => {
        const card = document.querySelector("helman-card")!.shadowRoot!;
        const glowing = (rows: Element[]) => rows.map((item) => [(item as any).device.id, !!item.shadowRoot!.querySelector(".glow")]);
        const lists = [...card.querySelectorAll(".card-content > helman-tree-item-list")];
        const section = card.querySelector("helman-house-devices-section")!.shadowRoot!;
        const deviceRows: Element[] = [];
        const roots: ShadowRoot[] = [section];
        for (const root of roots) {
            for (const el of root.querySelectorAll("*")) {
                if (el.localName === "helman-tree-item") deviceRows.push(el);
                if (el.shadowRoot) roots.push(el.shadowRoot);
            }
        }
        return {
            top: lists.flatMap((list) => glowing([...list.shadowRoot!.querySelectorAll("helman-tree-item")])),
            devices: glowing(deviceRows),
        };
    });
    await expect.poll(async () => (await glows()).top).toEqual(expect.arrayContaining([["solar", true], ["house", true]]));
    const { devices } = await glows();
    expect(devices.map(([id]) => id)).toEqual(expect.arrayContaining(["washer", "fridge"]));
    expect(devices.every(([, glowing]) => !glowing)).toBe(true);
});

test("an edge carries floor(travel / interval) + 1 surges, staggered by one interval", () => {
    // Tier 0 on a long edge: a surge every 4 beats, 3 beats in transit -> 1 surge on a 4-beat loop.
    const { reach, surges } = flowSurges(0, false, 0);
    expect(surges.map((surge) => surge.delay)).toEqual([`${-4 * BEAT_MS}ms`]);
    expect(reach).toBeCloseTo(4 / 3, 10);
    // Tier 2 on a short edge leaving half a beat in: 2 surges on a 1-beat loop.
    expect(flowSurges(2, true, 0.5).surges.map((surge) => surge.delay)).toEqual([`${-0.5 * BEAT_MS}ms`, `${-1 * BEAT_MS}ms`]);
});
