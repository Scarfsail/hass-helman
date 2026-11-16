import { test, expect, type Page } from "@playwright/test";
import { CARD_BUNDLE, loadBundle } from "./support/card-page";
import { installMockHass } from "./support/mock-hass";
import { cardTree, treeNode, treePayload } from "./support/payload-builders";
import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { flowGlow, flowGlowPeriodMs, flowLevel, flowSurgeCount, flowSurges, flowThickness, flowTravelMs } from "../cards/shared/flow-style";

/**
 * The look of a flow (#770, #776): one ratio per flow and per node,
 * `r = power / max`, drives the cues that agree with each other -- beam
 * thickness and brightness, surge count and speed, glow brightness, size and
 * rate -- as continuous curves. Each edge and each glow runs its own tempo.
 *
 * The animated elements only ever move their transform, or their opacity
 * between a fixed floor and 1, on one keyframe set; what scales with power
 * sits on static wrappers, and the speed is the animation's `playbackRate`.
 * So a power tick retunes the rate in place and restarts nothing.
 */

const RATIOS = [0, 0.19, 0.2, 0.49, 0.5, 1];

/** Whether each value is smaller than the one before it. */
const strictlyFalling = (values: number[]) => values.every((value, index) => index === 0 || value < values[index - 1]);

test.describe("the tables, unit-checked", () => {
    test("beam thickness is 2.5 px at least and 14 px at the maximum", () => {
        expect(RATIOS.map(flowThickness)).toEqual([2.5, 2.66, 2.8, 6.86, 7, 14].map((w) => expect.closeTo(w, 5)));
    });

    test("the level runs from 0.2 to 1 along r^0.7", () => {
        expect(RATIOS.map(flowLevel)).toEqual([0.2, 0.2 + 0.8 * 0.19 ** 0.7, 0.2 + 0.8 * 0.2 ** 0.7, 0.2 + 0.8 * 0.49 ** 0.7, 0.2 + 0.8 * 0.5 ** 0.7, 1]
            .map((k) => expect.closeTo(k, 10)));
        expect(flowLevel(0.5)).toBeCloseTo(0.6925, 4);
    });

    test("a surge crosses a long edge in 3900 -> 1300 ms and a short one in 1300 -> 650 ms, quicker with every step of r", () => {
        for (const [short, [slowest, quickest]] of [[false, [3900, 1300]], [true, [1300, 650]]] as const) {
            const travel = RATIOS.map((r) => flowTravelMs(r, short));
            expect(travel[0]).toBe(slowest);
            expect(travel.at(-1)).toBe(quickest);
            expect(strictlyFalling(travel)).toBe(true);
        }
        // Along the same easing as the level: half-way on e is half-way between the ends.
        expect(flowTravelMs(0.5, false)).toBeCloseTo(3900 - 2600 * 0.5 ** 0.7, 10);
    });

    test("an edge carries two surges at the faintest flow, and three on a long edge or two on a short one at the maximum", () => {
        expect(RATIOS.map((r) => flowSurgeCount(r, false))).toEqual([2, 2, 2, 3, 3, 3]);
        expect(RATIOS.map((r) => flowSurgeCount(r, true))).toEqual([2, 2, 2, 2, 2, 2]);
    });

    test("a glow breathes once per 3900 ms at the faintest and never quicker than once per 1300 ms", () => {
        const periods = RATIOS.map(flowGlowPeriodMs);
        expect(periods[0]).toBe(3900);
        expect(periods.at(-1)).toBe(1300);
        expect(strictlyFalling(periods)).toBe(true);
        expect(Math.min(...periods)).toBeGreaterThanOrEqual(1300);
        // The rate the page runs it at: one 1000 ms keyframe set per period, rounded down so it never runs quicker.
        expect(RATIOS.map((r) => flowGlow(r).rate)).toEqual(periods.map((period) => Math.floor(100_000 / period) / 100));
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

/** Every `data-beat` element on the page, through every shadow root. */
const BEAT_ELEMENTS = `(() => {
    const roots = [document];
    for (let i = 0; i < roots.length; i++) {
        for (const el of roots[i].querySelectorAll("*")) if (el.shadowRoot) roots.push(el.shadowRoot);
    }
    return roots.flatMap((root) => [...root.querySelectorAll("[data-beat]")]);
})()`;

/** Every animation of every `data-beat` element on the page. */
const BEAT_ANIMATIONS = `${BEAT_ELEMENTS}.flatMap((el) => el.getAnimations({ subtree: true }))`;

/** How many beat animations run, and how many of them run at a rate other than their element's `data-rate`, once applied. */
function rates(page: Page): Promise<{ count: number; off: number; rates: number[] }> {
    return page.evaluate(async (expression) => {
        const animations = (eval(expression) as Element[]).flatMap((el) =>
            el.getAnimations({ subtree: true }).map((animation) => ({ animation, rate: Number(el.getAttribute("data-rate")) })));
        await Promise.all(animations.map(({ animation }) => animation.ready));
        return {
            count: animations.length,
            off: animations.filter(({ animation, rate }) => animation.playbackRate !== rate).length,
            rates: [...new Set(animations.map(({ rate }) => rate))],
        };
    }, BEAT_ELEMENTS);
}

// ── The simple card: strong against weak ─────────────────────────────────────

/**
 * 4 kW from the grid into the battery next to 0.9 kW from the grid to the
 * house, scaled by 1.6 to this tree's maxima (grid 11.5 kW, battery 5 kW):
 * the battery's flow runs at r ≈ 0.56 on a short edge, the house's at
 * r ≈ 0.13 on a long one.
 */
const NIGHT_CHARGE = { solar: 0, house: 1440, battery: 6400, grid: 7840 };

test.describe("a strong flow next to a weak one", () => {
    test.beforeEach(async ({ page }) => {
        await mountSimpleCard(page, NIGHT_CHARGE);
    });

    test("the strong flow is thicker, brighter, quicker and more frequent", async ({ page }) => {
        const beams = await page.evaluate(async () => {
            const root = document.querySelector("helman-simple-card")!.shadowRoot!;
            return Object.fromEntries(await Promise.all(["grid-battery", "grid-house"].map(async (flow) => {
                const body = root.querySelector(`line[data-flow="${flow}"]`)!;
                const surges = [...body.parentElement!.querySelectorAll(`[data-beat="surge"]`)]
                    .filter((surge) => surge.closest("g[mask]")!.getAttribute("mask")!.includes(flow));
                const animations = surges.map((surge) => surge.getAnimations()[0]);
                await Promise.all(animations.map((animation) => animation.ready));
                return [flow, {
                    width: Number(body.getAttribute("stroke-width")),
                    opacity: Number(getComputedStyle(body).opacity),
                    surges: surges.length,
                    rates: animations.map((animation) => animation.playbackRate),
                    delays: animations.map((animation) => animation.effect!.getTiming().delay),
                    duration: animations[0].effect!.getTiming().duration as number,
                }] as const;
            })));
        });
        const strong = beams["grid-battery"];
        const weak = beams["grid-house"];
        const expected = { strong: flowSurges(6400 / 11500, true), weak: flowSurges(1440 / 11500, false) };
        expect(strong.width).toBeGreaterThan(weak.width);
        expect(strong.opacity).toBeGreaterThan(weak.opacity);
        expect([strong.surges, weak.surges]).toEqual([expected.strong.count, expected.weak.count]);
        expect(strong.rates).toEqual(strong.rates.map(() => expected.strong.rate));
        expect(weak.rates).toEqual(weak.rates.map(() => expected.weak.rate));
        // One crossing per loop, the surges spread evenly over it.
        expect(strong.delays).toEqual(expected.strong.surges.map((surge) => parseFloat(surge.delay)));
        // A surge leaves every crossing / count: more often on the strong flow.
        const interval = (beam: typeof strong) => beam.duration / beam.rates[0] / beam.surges;
        expect(interval(strong)).toBeLessThan(interval(weak));
        expect(strong.rates[0]).toBeGreaterThan(weak.rates[0]);
    });

    test("the battery glows larger, brighter and quicker than the house, and neither glow goes dark", async ({ page }) => {
        const halos = await page.evaluate(async () => {
            const root = document.querySelector("helman-simple-card")!.shadowRoot!;
            const halo = async (node: string) => {
                const halo = root.querySelector(`simple-card-${node}`)!.parentElement!.querySelector<HTMLElement>(".halo")!;
                const animation = halo.getAnimations()[0];
                await animation.ready;
                return {
                    size: halo.getBoundingClientRect().width,
                    level: Number(getComputedStyle(halo.parentElement!).opacity),
                    period: (animation.effect!.getTiming().duration as number) / animation.playbackRate,
                    floor: Math.min(...(animation.effect as KeyframeEffect).getKeyframes().map((frame) => Number(frame.opacity))),
                };
            };
            return { battery: await halo("battery"), house: await halo("house") };
        });
        expect(halos.battery.size).toBeGreaterThan(halos.house.size);
        expect(halos.battery.level).toBeGreaterThan(halos.house.level);
        expect(halos.battery.period).toBeLessThan(halos.house.period);
        // The battery is at its maximum: the 1300 ms cap, and no quicker.
        expect(halos.battery.period).toBeCloseTo(1000 / flowGlow(1).rate, 5);
        expect(halos.battery.period).toBeGreaterThanOrEqual(1300);
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

// ── Never silent ─────────────────────────────────────────────────────────────

test("a flow just above idle always has a surge on its beam, on a long edge and a short one", async ({ page }) => {
    // r ≈ 0.01: 60 W of solar (max 5 kW) down the short edge to the house, 120 W of grid (max 11.5 kW) along the long diagonal.
    await mountSimpleCard(page, { solar: 60, house: 180, battery: 0, grid: 120 });
    const crossing = Math.max(flowTravelMs(60 / 5000, true), flowTravelMs(120 / 11500, false));
    const samples = await page.evaluate(async (duration) => {
        const root = document.querySelector("helman-simple-card")!.shadowRoot!;
        const beams = ["solar-house", "grid-house"].map((flow) => {
            const line = root.querySelector<SVGLineElement>(`line[data-flow="${flow}"]`)!;
            const blobs = [...line.parentElement!.querySelectorAll<SVGGElement>('[data-beat="surge"]')]
                .filter((surge) => surge.closest("g[mask]")!.getAttribute("mask")!.includes(flow))
                .map((surge) => surge.firstElementChild as SVGGraphicsElement);
            return { flow, line, blobs };
        });
        const seen: Record<string, boolean[]> = Object.fromEntries(beams.map(({ flow }) => [flow, []]));
        const until = performance.now() + duration;
        while (performance.now() < until) {
            for (const { flow, line, blobs } of beams) {
                // The beam's ends on screen, and each surge centre's place between them: 0 at the start, 1 at the end.
                const ctm = line.getScreenCTM()!;
                const start = new DOMPoint(line.x1.baseVal.value, line.y1.baseVal.value).matrixTransform(ctm);
                const end = new DOMPoint(line.x2.baseVal.value, line.y2.baseVal.value).matrixTransform(ctm);
                const [dx, dy] = [end.x - start.x, end.y - start.y];
                seen[flow].push(blobs.some((blob) => {
                    const box = blob.getBoundingClientRect();
                    const t = ((box.x + box.width / 2 - start.x) * dx + (box.y + box.height / 2 - start.y) * dy) / (dx * dx + dy * dy);
                    return t >= 0 && t <= 1;
                }));
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return seen;
    }, 2 * crossing);
    for (const flow of ["solar-house", "grid-house"]) {
        expect(samples[flow].length).toBeGreaterThan(2 * crossing / 100 * 0.8);
        expect(samples[flow].every(Boolean), flow).toBe(true);
    }
});

// ── Rates ────────────────────────────────────────────────────────────────────

test("animations the browser recreates on a remount, on being shown or after a pause run at their element's rate", async ({ page }) => {
    await mountSimpleCard(page, NIGHT_CHARGE);
    await addArrows(page, [8000, 2000], 25 * 230 * 3);
    // A recreated animation starts at rate 1 and takes its element's rate on its `animationstart`, a frame or two later.
    await expect.poll(async () => (await rates(page)).off).toBe(0);
    const mounted = await rates(page);
    expect(mounted.count).toBeGreaterThan(4);
    expect(mounted.rates.some((rate) => rate !== 1)).toBe(true);

    await page.evaluate(async () => {
        const stage = document.getElementById("stage")!;
        const card = stage.querySelector("helman-simple-card")!;
        card.remove();
        await new Promise((resolve) => setTimeout(resolve, 700));
        stage.prepend(card);
    });
    await expect.poll(() => rates(page)).toEqual(mounted);

    await page.evaluate(async () => {
        const stage = document.getElementById("stage")!;
        stage.style.display = "none";
        await new Promise((resolve) => setTimeout(resolve, 700));
        stage.style.display = "";
    });
    await expect.poll(() => rates(page)).toEqual(mounted);

    // The arrows scrolled out pause where they are; a power change while paused
    // retunes them there, and they resume running at the new rate.
    const arrowRates = () => page.evaluate(() => [...document.querySelector("power-flow-arrows")!.shadowRoot!.querySelectorAll("[data-rate]")]
        .map((el) => el.getAttribute("data-rate")));
    const arrowRatesBefore = await arrowRates();
    await page.evaluate(() => window.scrollTo(0, 3000));
    await expect.poll(() => page.evaluate((expression) =>
        (eval(expression) as Animation[]).some((animation) => animation.playState === "paused"), BEAT_ANIMATIONS)).toBe(true);
    await page.evaluate(async () => {
        const arrows = document.querySelector("power-flow-arrows") as any;
        arrows.devices[0].powerValue = 3000;
        arrows.historyRevision = 1;
        await arrows.updateComplete;
    });
    expect(await arrowRates()).not.toEqual(arrowRatesBefore);
    await page.waitForTimeout(700);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate((expression) =>
        (eval(expression) as Animation[]).every((animation) => animation.playState === "running"), BEAT_ANIMATIONS)).toBe(true);
    const resumed = await rates(page);
    expect(resumed.off).toBe(0);
    expect(resumed.count).toBe(mounted.count);
    expect(resumed.rates).not.toEqual(mounted.rates);
});

test("a power change retunes the rate in place: no animation restarts and no surge moves", async ({ page }) => {
    await mountSimpleCard(page, NIGHT_CHARGE);
    await addArrows(page, [0.6 * 25 * 230 * 3], 25 * 230 * 3);
    await expect.poll(async () => (await rates(page)).off).toBe(0);

    // Every flow and node a little stronger, no edge's surge count changing.
    const tick = await page.evaluate(async (expression) => {
        const surges = () => (eval(expression) as Element[])
            .filter((el) => el.getAttribute("data-beat") === "surge")
            .map((el) => el.getAnimations()[0]);
        const progress = (animation: Animation) => animation.effect!.getComputedTiming().progress as number;
        const before = (eval(expression) as Element[]).flatMap((el) => el.getAnimations({ subtree: true }));
        const surgesBefore = surges();
        const at = { time: Number(document.timeline.currentTime), progress: surgesBefore.map(progress), rates: surgesBefore.map((animation) => animation.playbackRate) };

        const hass = (window as any).__hass;
        const watts = (value: number) => ({ state: String(value), attributes: { unit_of_measurement: "W" } });
        const card = document.querySelector("helman-simple-card") as any;
        card.hass = { ...hass, states: { ...hass.states, "sensor.house": watts(1600), "sensor.grid": watts(8100) } };
        await card.updateComplete;
        const arrows = document.querySelector("power-flow-arrows") as any;
        arrows.devices[0].powerValue = 0.8 * 25 * 230 * 3;
        arrows.historyRevision = 1;
        await arrows.updateComplete;

        const now = (eval(expression) as Element[]).flatMap((el) => el.getAnimations({ subtree: true }));
        await Promise.all(now.map((animation) => animation.ready));
        const surgesAfter = surges();
        const elapsed = Number(document.timeline.currentTime) - at.time;
        return {
            before: before.length,
            now: now.length,
            same: now.every((animation) => before.includes(animation)),
            sameSurges: surgesAfter.every((animation, index) => animation === surgesBefore[index]),
            ratesBefore: at.rates,
            ratesAfter: surgesAfter.map((animation) => animation.playbackRate),
            // How far each surge got, in loops, beyond what its quicker rate would carry it in the time that passed.
            jumps: surgesAfter.map((animation, index) => {
                const moved = Math.abs(progress(animation) - at.progress[index]);
                return Math.min(moved, 1 - moved) - elapsed * Math.max(at.rates[index], animation.playbackRate) / 1000;
            }),
        };
    }, BEAT_ELEMENTS);
    expect(tick.now).toBe(tick.before);
    expect(tick.same).toBe(true);
    expect(tick.sameSurges).toBe(true);
    // The rates did change: the weak grid → house flow and the arrow run quicker.
    expect(tick.ratesAfter).not.toEqual(tick.ratesBefore);
    // No surge moved by more than one frame's travel (~17 ms at the quicker rate).
    for (const jump of tick.jumps) expect(jump).toBeLessThan(17 * 1.6 / 1000);
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
            return glow && { border: getComputedStyle(glow).borderTopColor, shadow: getComputedStyle(glow).boxShadow };
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
        ], { role: "emit", maxPower: MAX });
        expect(glows[0]!.border).toBe(SOLAR_RGB);
        expect(glows[0]!.shadow).toContain("inset");
        expect(glows[1]).toBeNull();
    });

    test("a receiving row glows in its dominant source's colour, at full strength like an emitting one", async ({ page }) => {
        const glows = await rowGlows(page, [
            row("battery", 4000, { sourceType: "battery", sourcePowerHistory: [{ solar: { power: 3000, color: SOLAR_ACCENT }, grid: { power: 1000, color: GRID_ACCENT } }] }),
            row("house", 900, { sourcePowerHistory: [{ solar: { power: 100, color: SOLAR_ACCENT }, grid: { power: 800, color: GRID_ACCENT } }] }),
        ], { role: "receive", maxPower: MAX });
        expect(glows.map((glow) => glow!.border)).toEqual([SOLAR_RGB, GRID_RGB]);
    });

    test("the distribution row glows by its outline only, nothing inside it", async ({ page }) => {
        const glows = await rowGlows(page, [
            row("consumers", 6400, { sourcePowerHistory: [{ solar: { power: 6400, color: SOLAR_ACCENT } }] }),
        ], { role: "receive", maxPower: MAX }, "inverter");
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
        ], { role: "receive", maxPower: MAX });
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

test("an edge's surges are spread evenly over one crossing, at that crossing's rate", () => {
    // The faintest flow on a long edge: two surges, half a loop apart, crossing in 3900 ms.
    expect(flowSurges(0, false)).toEqual({
        count: 2,
        rate: 0.25,
        surges: [{ delay: "0ms", rest: 1 / 3 }, { delay: "-500ms", rest: 2 / 3 }],
    });
    // The strongest on a long edge: three, a third of the loop apart, crossing in 1300 ms.
    expect(flowSurges(1, false)).toEqual({
        count: 3,
        rate: 0.76,
        surges: [{ delay: "0ms", rest: 0.25 }, { delay: "-333ms", rest: 0.5 }, { delay: "-667ms", rest: 0.75 }],
    });
    // The strongest on a short edge: two, crossing in 650 ms.
    expect(flowSurges(1, true)).toMatchObject({ count: 2, rate: 1.53 });
});
