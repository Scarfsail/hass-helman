import { test, expect, type Page } from "@playwright/test";
import { CARD_BUNDLE, loadBundle } from "./support/card-page";
import { installMockHass } from "./support/mock-hass";
import { cardTree, treeNode, treePayload } from "./support/payload-builders";
import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { FLOW_SURGE_LENGTH, flowBeam, flowEase, flowFadeShare, flowGlow, flowGlowPeriodMs, flowGlowSize, flowLevel, flowRatio, flowScaleW, flowSpeed, flowSurgeCount, flowSurgeRate, flowSurges, flowSurgeTravel, flowTail, flowThickness, flowTrailGradient } from "../cards/shared/flow-style";

/**
 * The look of a flow (#770, #776, #778, #785): one ratio per flow and per node,
 * `r = clamp((power − 200) / (max − 200), 0, 1)` (the 200 W floor,
 * `FLOW_FLOOR_W`) against one shared scale, drives through one easing
 * `t = sqrt(r)` the cues that agree with each other -- beam thickness and
 * brightness, a surge's tail and speed, glow brightness, size and rate -- as
 * continuous curves. Each edge and each glow runs its own tempo; a
 * surge's speed is a velocity on screen, px/s, from its power alone, and its
 * path and the spacing between surges are fixed lengths on screen, so a flow
 * pulses at the same rhythm on every beam.
 *
 * The animated elements only ever move their transform, or their opacity
 * between a fixed floor and 1, on one keyframe set; what scales with power
 * sits on static wrappers, and the speed is the animation's `playbackRate`.
 * So a power tick retunes the rate in place and restarts nothing.
 */

const RATIOS = [0, 0.19, 0.2, 0.49, 0.5, 1];

/** Whether each value is smaller than the one before it. */
const strictlyFalling = (values: number[]) => values.every((value, index) => index === 0 || value < values[index - 1]);

/** Whether each value is larger than the one before it. */
const strictlyRising = (values: number[]) => strictlyFalling([...values].reverse());

test.describe("the tables, unit-checked", () => {
    test("every cue takes r through one easing, the square root", () => {
        expect(RATIOS.map(flowEase)).toEqual(RATIOS.map((r) => expect.closeTo(Math.sqrt(r), 12)));
    });

    test("beam thickness runs from 1 px at r = 0 to 8 px at the maximum, along the square root", () => {
        expect(RATIOS.map(flowThickness)).toEqual(RATIOS.map((r) => expect.closeTo(1 + 7 * Math.sqrt(r), 10)));
        expect(flowThickness(0)).toBe(1);
        expect(flowThickness(1)).toBe(8);
        // A quarter of the scale is already half way up: 1 + 7 / 2.
        expect(flowThickness(0.25)).toBeCloseTo(4.5, 10);
    });

    test("a surge's tail runs from 14 px at r = 0 to 38 px at the maximum, along the square root", () => {
        expect(RATIOS.map(flowTail)).toEqual(RATIOS.map((r) => expect.closeTo(14 + 24 * Math.sqrt(r), 10)));
        expect(flowTail(0)).toBe(14);
        expect(flowTail(1)).toBe(38);
        expect(strictlyRising(RATIOS.map(flowTail))).toBe(true);
    });

    test("the level runs from 0.2 to 1 along the square root", () => {
        expect(RATIOS.map(flowLevel)).toEqual(RATIOS.map((r) => expect.closeTo(0.2 + 0.8 * Math.sqrt(r), 10)));
        expect(flowLevel(0.25)).toBeCloseTo(0.6, 10);
    });

    test("a surge moves at 3 px/s at r = 0 and 60 px/s at the maximum, along the square root", () => {
        const speeds = RATIOS.map(flowSpeed);
        expect(speeds).toEqual(RATIOS.map((r) => expect.closeTo(3 + 57 * Math.sqrt(r), 10)));
        expect(speeds[0]).toBe(3);
        expect(speeds.at(-1)).toBe(60);
        expect(strictlyRising(speeds)).toBe(true);
        // 500 W of 17.25 kW moves at about 10.6 px/s; a quarter of the scale at 31.5.
        expect(flowSpeed(flowRatio(500, 17_250))).toBeCloseTo(10.56, 2);
        expect(flowSpeed(0.25)).toBeCloseTo(31.5, 10);
    });

    test("one curve: thickness, surge width and tail, level, glow size and speed all rise with r, each a fixed function of flowEase", () => {
        const fine = Array.from({ length: 1001 }, (_, index) => index / 1000);
        const cues = {
            thickness: fine.map(flowThickness),
            surge: fine.map((r) => flowBeam(r, "red").surgeWidth),
            tail: fine.map((r) => flowBeam(r, "red").tail),
            level: fine.map(flowLevel),
            glow: fine.map(flowGlowSize),
            speed: fine.map(flowSpeed),
        };
        for (const values of Object.values(cues)) expect(strictlyRising(values)).toBe(true);
        // Each cue is the same affine map of t = flowEase(r) at every r: none reads r directly.
        for (const [index, r] of fine.entries()) {
            const t = flowEase(r);
            expect(cues.thickness[index]).toBeCloseTo(1 + 7 * t, 10);
            expect(cues.surge[index]).toBeCloseTo(1 + 7 * t + 1, 10);
            expect(cues.tail[index]).toBeCloseTo(14 + 24 * t, 10);
            expect(cues.level[index]).toBeCloseTo(0.2 + 0.8 * t, 10);
            expect(cues.glow[index]).toBeCloseTo(t, 10);
            expect(cues.speed[index]).toBeCloseTo(3 + 57 * t, 10);
        }
    });

    test("on one scale, 103 W draws thinner, dimmer, with a narrower surge, a shorter tail and slower than 2.3 kW", () => {
        const scale = 17_250;
        const [small, large] = [103, 2300].map((power) => flowRatio(power, scale)).map((r) => ({ ...flowBeam(r, "red"), speed: flowSpeed(r), level: flowLevel(r) }));
        expect(small.width).toBeLessThan(large.width);
        expect(small.level).toBeLessThan(large.level);
        expect(small.bodyOpacity).toBeLessThan(large.bodyOpacity);
        expect(small.surgeWidth).toBeLessThan(large.surgeWidth);
        expect(small.tail).toBeLessThan(large.tail);
        expect(small.speed).toBeLessThan(large.speed);
        // A pulse a pixel wider than its pipe: 2 px on 103 W's 1 px floor with a 14 px tail, about 4.5 on 2.3 kW's 3.5 with a 22.4 px one.
        expect(small).toMatchObject({ surgeWidth: 2, tail: 14 });
        expect(large.surgeWidth).toBeCloseTo(4.457, 2);
        expect(large.tail).toBeCloseTo(22.423, 2);
        expect(flowBeam(1, "red")).toMatchObject({ width: 8, surgeWidth: 9, tail: 38 });
    });

    test("the body is dim and the pulse bright: body at 0.14 + 0.3 k, pulse at 0.55 + 0.45 k, bloom at 0.27 k", () => {
        for (const r of RATIOS) {
            const k = flowLevel(r);
            const beam = flowBeam(r, "red");
            expect(beam.bodyOpacity).toBeCloseTo(0.14 + 0.3 * k, 10);
            expect(beam.surgeOpacity).toBeCloseTo(0.55 + 0.45 * k, 10);
            expect(beam.surgeOpacity).toBeGreaterThan(beam.bodyOpacity);
            expect(beam.bloomBlur).toBeCloseTo(0.6 * (beam.width + 2 + 8 * k), 2);
            expect(beam.bloomColor).toBe(`color-mix(in srgb, red ${+(27 * k).toFixed(1)}%, transparent)`);
        }
    });

    test("a surge's gradient runs clear, the tail in its colour, the hot head, clear at the tip, its tail's share in steps of 0.05", () => {
        // The longest tail fills the whole path: clear at the tail's end, 0.35 at 55 %, 0.9 at 86 %, hot at 94 %, clear at the tip.
        expect(flowTrailGradient("red", flowBeam(1, "red"), "to bottom")).toBe("linear-gradient(to bottom, "
            + "color-mix(in srgb, red 0%, transparent) 0%, color-mix(in srgb, red 35%, transparent) 55%, color-mix(in srgb, red 90%, transparent) 86%, "
            + "color-mix(in srgb, color-mix(in srgb, white var(--helman-flow-hot-mix), red) 100%, transparent) 94%, "
            + "color-mix(in srgb, color-mix(in srgb, white var(--helman-flow-hot-mix), red) 0%, transparent) 100%)");
        // A shorter tail leaves the back of the path clear: the faintest's 3 + 14 px of 41 rounds to 0.4 of it.
        expect(flowTrailGradient("red", flowBeam(0, "red"), "to bottom")).toMatch(/^linear-gradient\(to bottom, color-mix\(in srgb, red 0%, transparent\) 60%, /);
        // Close powers paint the same gradient, while the tails stay exact.
        const [a, b] = [2300, 2310].map((power) => flowBeam(flowRatio(power, 17_250), "red"));
        expect(a.tail).not.toBe(b.tail);
        expect(flowTrailGradient("red", a, "to bottom")).toBe(flowTrailGradient("red", b, "to bottom"));
    });

    test("a simple-card beam fades out over 10 px at each end, or 0.3 of a short one", () => {
        expect([10, 20, 33, 34, 50, 100, 400].map(flowFadeShare)).toEqual([0.3, 0.3, 0.3, 0.2941, 0.2, 0.1, 0.025]);
        // Not measured yet, or not laid out: the most a beam fades.
        expect(flowFadeShare(0)).toBe(0.3);
    });

    test("a flow at or under the 200 W floor draws at r = 0, and the ratio runs from the floor to the scale, clamped", () => {
        for (const power of [-500, 0, 103, 130, 200]) expect(flowRatio(power, 17_250)).toBe(0);
        expect(flowRatio(17_250, 17_250)).toBe(1);
        expect(flowRatio(40_000, 17_250)).toBe(1);
        expect(flowRatio(8725, 17_250)).toBeCloseTo(0.5, 10);
        // A scale at or under the floor, or none, draws everything at the lowest ratio.
        for (const max of [null, undefined, 0, 150, 200]) expect(flowRatio(5000, max)).toBe(0);
        // On the local 17.25 kW scale: 130 W on the floor, 500 W about 1.9 px, 2.3 kW about 3.5, 10 kW about 6.3.
        expect([130, 500, 2300, 10_000].map((power) => flowThickness(flowRatio(power, 17_250))))
            .toEqual([1, 1.928, 3.457, 6.307].map((width) => expect.closeTo(width, 2)));
    });

    test("the shared scale is the largest positive maximum, nulls ignored, else 0", () => {
        expect(flowScaleW([5000, 11500, 5000])).toBe(11500);
        expect(flowScaleW([null, 17250, undefined, 5000])).toBe(17250);
        expect(flowScaleW([0, -10, null])).toBe(0);
        expect(flowScaleW([])).toBe(0);
    });

    test("a surge is drawn 41 px long, its 3 px head and its longest tail, whatever its power or its beam", () => {
        expect(FLOW_SURGE_LENGTH).toBe(41);
    });

    test("a beam's crossing is its length and a surge's, from wholly before its start to wholly past its end, and the rate runs it once per crossing", () => {
        expect(flowSurgeTravel(60)).toBe(101);
        // 60 px at 120 px/s: (60 + 41) / 120 = 842 ms, 1.19 loops a second.
        expect(flowSurgeRate(120, 60)).toBe(1.19);
        // 28 px at 3 px/s: (28 + 41) / 3 = 23 s.
        expect(flowSurgeRate(3, 28)).toBe(0.0435);
    });

    test("on a tiny beam, a crossing is never shorter than the beam and the rate stays finite and forward", () => {
        expect(flowSurgeTravel(1)).toBe(42);
        expect(flowSurgeRate(120, 1)).toBe(2.86);
        for (let length = 0.01; length < 20; length += 0.01) {
            expect(flowSurgeTravel(length)).toBeGreaterThan(length);
            const rate = flowSurgeRate(3, length);
            expect(Number.isFinite(rate) && rate > 0).toBe(true);
        }
    });

    test("a slow surge on a long beam never stops, and runs within 0.5 % of its speed", () => {
        for (const speed of [3, 3.1, 7.68, 10, 61.5, 120]) {
            for (const length of [10, 22, 28, 60, 107, 300, 964, 2000, 5000]) {
                const exact = speed / flowSurgeTravel(length);
                const rate = flowSurgeRate(speed, length);
                expect(rate).toBeGreaterThan(0);
                expect(Math.abs(rate - exact) / exact).toBeLessThanOrEqual(0.005);
            }
        }
    });

    test("a beam carries one surge per ~42 px of its length and a surge's, at least one, whatever its power", () => {
        const lengths = [5, 22, 28, 47, 60, 87, 107, 200];
        expect(lengths.map((length) => flowSurgeCount(length))).toEqual([1, 2, 2, 2, 2, 3, 4, 6]);
        // The power has no say: the same beam carries the same count at any r.
        for (const r of RATIOS) expect(flowSurges(r, 60).count).toBe(2);
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

/**
 * Every beam marked `data-flow-beam` on the page, its length on screen, px,
 * and how many surges it carries.
 */
function beamSurges(page: Page): Promise<{ length: number; count: number }[]> {
    return page.evaluate((lookup) => [...document.querySelectorAll("helman-simple-card, power-flow-arrows")].flatMap((host) => {
        const root = host.shadowRoot!;
        return [...root.querySelectorAll("[data-flow-beam]")].map((beam) => {
            const { surges, start, end } = eval(lookup)(root, beam.getAttribute("data-flow-beam"));
            return { length: Math.hypot(end.x - start.x, end.y - start.y), count: surges.length };
        });
    }), FLOW_BEAM);
}

/**
 * Wait until the cards have measured their beams and drawn their surges:
 * every beam on the page carries as many as its length holds.
 */
async function surgesDrawn(page: Page): Promise<void> {
    await expect.poll(async () => {
        const beams = await beamSurges(page);
        return beams.length > 0 && beams.every(({ length, count }) => count === flowSurgeCount(length));
    }).toBe(true);
}

/** Wait until every surge is drawn and every beat animation runs at its element's rate. */
async function settled(page: Page): Promise<void> {
    await surgesDrawn(page);
    await expect.poll(async () => (await rates(page)).off).toBe(0);
}

/**
 * Whether `rate` is `expected`, within 1 %: the card's rate comes from its
 * own measurement of the beam, so it may sit one rounding step off this one.
 */
function expectRate(rate: number, expected: number): void {
    expect(Math.abs(rate - expected) / expected).toBeLessThanOrEqual(0.01);
}

// ── The simple card: strong against weak ─────────────────────────────────────

/**
 * 4 kW from the grid into the battery next to 0.9 kW from the grid to the
 * house, scaled by 1.6 to this tree's shared scale (the largest maximum,
 * the grid's 11.5 kW): the battery's flow runs at r ≈ 0.56 on a short edge,
 * the house's at r ≈ 0.13 on a long one.
 */
const NIGHT_CHARGE = { solar: 0, house: 1440, battery: 6400, grid: 7840 };

test.describe("a strong flow next to a weak one", () => {
    test.beforeEach(async ({ page }) => {
        await mountSimpleCard(page, NIGHT_CHARGE);
    });

    test("the strong flow is thicker, brighter, quicker and more frequent", async ({ page }) => {
        await settled(page);
        const beams = await page.evaluate(async () => {
            const root = document.querySelector("helman-simple-card")!.shadowRoot!;
            return Object.fromEntries(await Promise.all(["grid-battery", "grid-house"].map(async (flow) => {
                const body = root.querySelector<SVGLineElement>(`line[data-flow="${flow}"]`)!;
                const ctm = body.getScreenCTM()!;
                const start = new DOMPoint(body.x1.baseVal.value, body.y1.baseVal.value).matrixTransform(ctm);
                const end = new DOMPoint(body.x2.baseVal.value, body.y2.baseVal.value).matrixTransform(ctm);
                const surges = [...body.ownerSVGElement!.querySelectorAll(`[data-beat="surge"]`)]
                    .filter((surge) => surge.closest("g[mask]")!.getAttribute("mask")!.includes(flow));
                const animations = surges.map((surge) => surge.getAnimations()[0]);
                await Promise.all(animations.map((animation) => animation.ready));
                return [flow, {
                    width: Number(body.getAttribute("stroke-width")),
                    length: Math.hypot(end.x - start.x, end.y - start.y),
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
        const expected = { strong: flowSurges(flowRatio(6400, 11500), strong.length), weak: flowSurges(flowRatio(1440, 11500), weak.length) };
        expect(strong.width).toBeGreaterThan(weak.width);
        expect(strong.opacity).toBeGreaterThan(weak.opacity);
        // As many as each beam's length holds.
        expect([strong.surges, weak.surges]).toEqual([expected.strong.count, expected.weak.count]);
        // Each at its own speed over its own beam's measured length.
        for (const rate of strong.rates) expectRate(rate, expected.strong.rate);
        for (const rate of weak.rates) expectRate(rate, expected.weak.rate);
        // One crossing per loop, the surges spread evenly over it.
        expect(strong.delays).toEqual(expected.strong.surges.map((surge) => parseFloat(surge.delay)));
        // A surge leaves every crossing / count: more often on the strong flow, though its beam is the shorter.
        expect(strong.length).toBeLessThan(weak.length);
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
        // Both against the shared scale, the grid's 11.5 kW, and never quicker than the 1300 ms cap.
        expect(halos.battery.period).toBeCloseTo(1000 / flowGlow(flowRatio(6400, 11500)).rate, 5);
        expect(halos.house.period).toBeCloseTo(1000 / flowGlow(flowRatio(1440, 11500)).rate, 5);
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

/**
 * In the page, `(root, key) => ({ beam, surges, start, end })`: the beam
 * marked `data-flow-beam=key` under `root`, its surges, and its ends on
 * screen. A `<line>` runs between its ends; an arrow's beam runs down its box.
 */
const FLOW_BEAM = `(root, key) => {
    const beam = root.querySelector('[data-flow-beam="' + key + '"]');
    if (beam instanceof SVGLineElement) {
        const ctm = beam.getScreenCTM();
        return {
            beam,
            surges: [...root.querySelectorAll('g[mask*="-' + key + '-mask"] [data-beat="surge"]')],
            start: new DOMPoint(beam.x1.baseVal.value, beam.y1.baseVal.value).matrixTransform(ctm),
            end: new DOMPoint(beam.x2.baseVal.value, beam.y2.baseVal.value).matrixTransform(ctm),
        };
    }
    const box = beam.getBoundingClientRect();
    return {
        beam,
        surges: [...beam.querySelectorAll('[data-beat="surge"]')],
        start: new DOMPoint(box.x + box.width / 2, box.top),
        end: new DOMPoint(box.x + box.width / 2, box.bottom),
    };
}`;

/**
 * In the page, `(root, key, steps, half) => [...]`: every surge of the beam marked
 * `data-flow-beam=key` under `root` held at `steps` evenly spaced points of
 * one loop of animation time, and at each the most any surge, `half` px either
 * side of its centre (its box's), overlaps the beam, px along it on screen.
 */
const LOOP_OVERLAPS = `(root, key, steps, half) => {
    const { surges, start, end } = (${FLOW_BEAM})(root, key);
    const animations = surges.map((surge) => surge.getAnimations()[0]);
    for (const animation of animations) animation.pause();
    const [dx, dy] = [end.x - start.x, end.y - start.y];
    const length = Math.hypot(dx, dy);
    const overlaps = [];
    for (let step = 0; step < steps; step++) {
        for (const animation of animations) animation.currentTime = 1000 * step / steps;
        overlaps.push(Math.max(...surges.map((surge) => {
            const box = surge.getBoundingClientRect();
            const along = ((box.x + box.width / 2 - start.x) * dx + (box.y + box.height / 2 - start.y) * dy) / length;
            return Math.min(along + half, length) - Math.max(along - half, 0);
        })));
    }
    return { length, count: surges.length, overlaps };
}`;

/** The beams it checks: the short left vertical, the long bottom horizontal and the grid's diagonal. */
const NEVER_EMPTY_BEAMS = ["solar-house", "battery-house", "grid-house"];

test("at the maximum, a beam always shows part of a surge's head or tail, through a whole loop", async ({ page }) => {
    // r = 1: each at the shared scale, the grid's 11.5 kW, so every tail is the longest and fills a surge's whole path.
    // A weaker flow's shorter tail leaves the beam between its surges dim, as the look means it to.
    await mountSimpleCard(page, { solar: 11500, house: 34500, battery: -11500, grid: 11500 });
    await settled(page);
    const half = FLOW_SURGE_LENGTH / 2;
    for (const key of NEVER_EMPTY_BEAMS) {
        const { length, count, overlaps } = await page.evaluate(({ key, lookup, half }) =>
            eval(lookup)(document.querySelector("helman-simple-card")!.shadowRoot!, key, 200, half), { key, lookup: LOOP_OVERLAPS, half });
        expect(count, key).toBe(flowSurgeCount(length));
        expect(overlaps, key).toHaveLength(200);
        expect(Math.min(...overlaps), `${key}, ${count} surges on ${length} px`).toBeGreaterThan(1);
    }
});

// ── Speed on screen ──────────────────────────────────────────────────────────

/**
 * How fast, px/s on screen, the first surge on each beam moves, how long the
 * beam is, how many surges it carries and how long one loop of them takes,
 * ms: the surge's animation is held and sought to two points of one crossing,
 * and its centre's travel between them taken over the clock time that much
 * of the animation takes at its rate.
 */
function surgeSpeeds(page: Page, beams: { host: string; beam: string }[]): Promise<{ speed: number; length: number; count: number; loopMs: number }[]> {
    return page.evaluate(async ({ beams, lookup }) => Promise.all(beams.map(async ({ host, beam }) => {
        const { surges, start, end } = eval(lookup)(document.querySelector(host)!.shadowRoot!, beam);
        const surge = surges[0] as Element;
        const animation = surge.getAnimations()[0];
        await animation.ready;
        animation.pause();
        const centre = (time: number) => {
            animation.currentTime = time;
            const box = surge.getBoundingClientRect();
            return new DOMPoint(box.x + box.width / 2, box.y + box.height / 2);
        };
        const [from, to] = [centre(200), centre(600)];
        return {
            speed: Math.hypot(to.x - from.x, to.y - from.y) / (400 / animation.playbackRate) * 1000,
            length: Math.hypot(end.x - start.x, end.y - start.y),
            count: surges.length,
            loopMs: (animation.effect!.getTiming().duration as number) / animation.playbackRate,
        };
    })), { beams, lookup: FLOW_BEAM });
}

/** Whether `speed` is `expected` px/s, off by no more than the rate's rounding to three digits and the measuring. */
function expectSpeed(speed: number, expected: number): void {
    expect(Math.abs(speed - expected)).toBeLessThanOrEqual(0.006 * expected + 0.05);
}

test("at the same r, a short beam and a long one move their surges at the same px/s", async ({ page }) => {
    // 1440 W from the grid to the house along the long diagonal, and the same 1440 W of 11.5 kW down a 22 px arrow.
    await mountSimpleCard(page, NIGHT_CHARGE);
    await addArrows(page, [1440], 11500);
    await settled(page);
    const [diagonal, arrow] = await surgeSpeeds(page, [
        { host: "helman-simple-card", beam: "grid-house" },
        { host: "power-flow-arrows", beam: "0" },
    ]);
    expect(diagonal.length).toBeGreaterThan(3 * arrow.length);
    const expected = flowSpeed(flowRatio(1440, 11500));
    for (const { speed } of [diagonal, arrow]) {
        expectSpeed(speed, expected);
    }
    expect(Math.abs(diagonal.speed - arrow.speed)).toBeLessThan(0.02 * expected);
});

test("at the same power, a short beam and a long one pulse at the same rhythm", async ({ page }) => {
    // The look that read wrong: about 400 W of solar down the short left edge pulsed twice as often as as much battery along the bottom.
    await mountSimpleCard(page, { solar: 400, house: 800, battery: -400, grid: 0 });
    await settled(page);
    const [solar, battery] = await surgeSpeeds(page, [
        { host: "helman-simple-card", beam: "solar-house" },
        { host: "helman-simple-card", beam: "battery-house" },
    ]);
    expect(battery.length).toBeGreaterThan(1.5 * solar.length);
    const expected = flowSpeed(flowRatio(400, 11500));
    for (const beam of [solar, battery]) {
        expectSpeed(beam.speed, expected);
        expect(beam.count).toBe(flowSurgeCount(beam.length));
        // A surge passes any point once per loop over the count: about every 42 px of travel, within a
        // whole count's rounding, 31.5 – 52.5 px on a beam that carries two or more.
        const spacing = beam.speed * beam.loopMs / 1000 / beam.count;
        expect(spacing).toBeGreaterThan(31);
        expect(spacing).toBeLessThan(53);
    }
    // Not twice as often on the short beam: the intervals differ by no more than that rounding.
    const interval = (beam: typeof solar) => beam.loopMs / beam.count;
    expect(interval(battery) / interval(solar)).toBeGreaterThan(0.6);
    expect(interval(battery) / interval(solar)).toBeLessThan(1.67);
});

test("a stronger flow moves quicker on screen than a weaker one, even when the weaker one's beam is shorter", async ({ page }) => {
    // 274 W of solar down the short left edge against 585 W of battery along the long bottom one.
    await mountSimpleCard(page, { solar: 274, house: 859, battery: -585, grid: 0 });
    await settled(page);
    const [solar, battery] = await surgeSpeeds(page, [
        { host: "helman-simple-card", beam: "solar-house" },
        { host: "helman-simple-card", beam: "battery-house" },
    ]);
    expect(solar.length).toBeLessThan(battery.length);
    expect(battery.speed).toBeGreaterThan(solar.speed);
    expectSpeed(solar.speed, flowSpeed(flowRatio(274, 11500)));
    expectSpeed(battery.speed, flowSpeed(flowRatio(585, 11500)));
});

test("a beam the layout resizes is measured again, and its surges keep their px/s", async ({ page }) => {
    await mountSimpleCard(page, NIGHT_CHARGE);
    await settled(page);
    const beam = { host: "helman-simple-card", beam: "grid-house" };
    const [before] = await surgeSpeeds(page, [beam]);
    // A larger card stretches the overlay, and the diagonal from the grid to the house on it.
    await page.evaluate(async () => {
        const card = document.querySelector("helman-simple-card") as any;
        card.setConfig({ type: "custom:helman-simple-card", width: 320, height: 300 });
        card.requestUpdate();
        await card.updateComplete;
    });
    const expected = flowSpeed(flowRatio(1440, 11500));
    await expect.poll(async () => (await surgeSpeeds(page, [beam]))[0].length).toBeGreaterThan(before.length + 20);
    await settled(page);
    // Once measured again, it carries as many surges as its new length holds, each at the same px/s.
    await expect.poll(async () => {
        const [after] = await surgeSpeeds(page, [beam]);
        return after.count === flowSurgeCount(after.length);
    }).toBe(true);
    const [after] = await surgeSpeeds(page, [beam]);
    for (const { speed } of [before, after]) {
        expectSpeed(speed, expected);
    }
});

// ── The surge on screen ──────────────────────────────────────────────────────

/**
 * In the page, `(root, key, time) => ...`: the first surge of the beam marked
 * `data-flow-beam=key` under `root`, held at `time` ms of its animation, and
 * its pulse on screen: its centre's place along the beam, px from its start,
 * the beam's length, its axes (the pulse's own x and y, its half length and
 * half thickness, as vectors on screen), the beam's angle on screen and its
 * width.
 */
const HELD_PULSE = `(root, key, time) => {
    const { beam, surges, start, end } = (${FLOW_BEAM})(root, key);
    const surge = surges[0];
    const animation = surge.getAnimations()[0];
    animation.pause();
    animation.currentTime = time;
    const pulse = surge.firstElementChild;
    const ctm = pulse.getScreenCTM();
    const box = pulse.getBBox();
    const at = (x, y) => new DOMPoint(box.x + box.width / 2 + x, box.y + box.height / 2 + y).matrixTransform(ctm);
    const centre = at(0, 0);
    const [dx, dy] = [end.x - start.x, end.y - start.y];
    const length = Math.hypot(dx, dy);
    const axis = (point) => [point.x - centre.x, point.y - centre.y];
    return {
        along: ((centre.x - start.x) * dx + (centre.y - start.y) * dy) / length,
        length,
        x: axis(at(box.width / 2, 0)),
        y: axis(at(0, box.height / 2)),
        angle: Math.atan2(dy, dx),
        width: Number(beam.getAttribute("stroke-width")),
    };
}`;

test("on an overlay stretched one way, a diagonal pulse lies along its beam, a pixel wider than it", async ({ page }) => {
    // Battery to the house along the bottom, and the grid to the house down the diagonal.
    await mountSimpleCard(page, { solar: 0, house: 3000, battery: -1500, grid: 1500 });
    await page.evaluate(async () => {
        const card = document.querySelector("helman-simple-card") as any;
        card.setConfig({ type: "custom:helman-simple-card", width: 300 });
        card.requestUpdate();
        await card.updateComplete;
    });
    // The overlay stretches 1.5 times across, and down only as far as the nodes grow.
    await expect.poll(() => page.evaluate(() => {
        const ctm = document.querySelector("helman-simple-card")!.shadowRoot!.querySelector<SVGSVGElement>(".diagonal-overlay")!.getScreenCTM()!;
        return ctm.a / ctm.d;
    })).toBeGreaterThan(1.3);
    await settled(page);
    for (const key of ["battery-house", "grid-house"]) {
        // Held half-way through its crossing, its centre on the beam.
        const pulse = await page.evaluate(({ key, lookup }) => {
            return eval(lookup)(document.querySelector("helman-simple-card")!.shadowRoot!, key, 500);
        }, { key, lookup: HELD_PULSE });
        const norm = ([x, y]: number[]) => Math.hypot(x, y);
        // Its long axis runs along the beam on screen, and its short one square to it: not sheared.
        expect(Math.atan2(pulse.x[1], pulse.x[0]), key).toBeCloseTo(pulse.angle, 2);
        expect((pulse.x[0] * pulse.y[0] + pulse.x[1] * pulse.y[1]) / norm(pulse.x) / norm(pulse.y), key).toBeCloseTo(0, 3);
        // As long as a surge's path, and a pixel wider than its beam.
        expect(norm(pulse.x), key).toBeCloseTo(FLOW_SURGE_LENGTH / 2, 1);
        expect(norm(pulse.y), key).toBeCloseTo((pulse.width + 1) / 2, 1);
    }
});

test("a pulse enters wholly before its beam's start and leaves wholly past its end", async ({ page }) => {
    // Far over solar's 5 kW: to the grid along the top, down the left to the house and across the diagonal to the battery, each at r = 1.
    await mountSimpleCard(page, { solar: 45000, house: 15000, battery: 15000, grid: -15000 });
    await settled(page);
    for (const key of ["solar-grid", "solar-house", "solar-battery"]) {
        const [first, last] = await page.evaluate(({ key, lookup }) => {
            const root = document.querySelector("helman-simple-card")!.shadowRoot!;
            // The first surge starts its loop at once: its animation at 0 ms is the start of a crossing, at 1000 ms its end.
            return [0, 999.99].map((time) => eval(lookup)(root, key, time));
        }, { key, lookup: HELD_PULSE });
        const half = FLOW_SURGE_LENGTH / 2;
        // Its head's tip touches the start as it enters, and its longest tail's end leaves the end: the beam shows all of it.
        expect(first.along + half, key).toBeCloseTo(0, 1);
        expect(last.along - half, key).toBeCloseTo(last.length, 1);
    }
});

test("on the simple card every beam, its bloom, body and surges, fades out at both ends under one mask, the surges in a group of their own", async ({ page }) => {
    // Solar to the grid along the top, down the left to the house and across the overlay's diagonal to the battery.
    await mountSimpleCard(page, { solar: 6500, house: 900, battery: 3200, grid: -2400 });
    await settled(page);
    const beams = await page.evaluate((lookup) => {
        const root = document.querySelector("helman-simple-card")!.shadowRoot!;
        return [...root.querySelectorAll<SVGLineElement>("line[data-flow-beam]")].map((body) => {
            const key = body.dataset.flowBeam!;
            const { start, end } = eval(lookup)(root, key);
            const group = body.closest("g[mask]")!;
            // The static group and, after it, the animated one, both under the beam's mask.
            const groups = [group, group.nextElementSibling!].filter((each) => each.getAttribute("mask") === group.getAttribute("mask"));
            const mask = root.querySelector(`#${CSS.escape(group.getAttribute("mask")!.slice(5, -1))} line`)!;
            const fade = root.querySelector(`#${CSS.escape(mask.getAttribute("stroke")!.slice(5, -1))}`)!;
            const coordinates = (line: Element) => ["x1", "y1", "x2", "y2"].map((name) => line.getAttribute(name));
            return {
                key,
                length: Math.hypot(end.x - start.x, end.y - start.y),
                masked: groups.map((each) => [...new Set([...each.children].map((child) => child.getAttribute("class") ?? child.localName))]),
                surges: groups[1]?.querySelectorAll('[data-beat="surge"]').length,
                lines: [...group.querySelectorAll("line"), mask].map((line) => getComputedStyle(line).strokeLinecap),
                // The fade runs from the beam's start to its end, as the mask's line does.
                runs: [coordinates(fade), coordinates(mask)].map((each) => each.join()),
                body: coordinates(body).join(),
                units: fade.getAttribute("gradientUnits"),
                stops: [...fade.children].map((stop) => [Number(stop.getAttribute("offset")), Number(stop.getAttribute("stop-opacity"))]),
            };
        });
    }, FLOW_BEAM);
    expect(beams.map(({ key }) => key)).toEqual(["solar-grid", "solar-house", "solar-battery"]);
    for (const beam of beams) {
        // The bloom and the body, and beside them the surges alone, under the one mask.
        expect(beam.masked, beam.key).toEqual([["flow-bloom", "flow-beam"], ["flow-surge"]]);
        expect(beam.surges, beam.key).toBe(flowSurgeCount(beam.length));
        expect(beam.runs, beam.key).toEqual([beam.body, beam.body]);
        expect(beam.units, beam.key).toBe("userSpaceOnUse");
        // Clear at both ends, whole across the middle, over 10 px or 0.3 of a short beam: the card measured it on its own.
        const fade = flowFadeShare(beam.length);
        expect(beam.stops.map(([, opacity]) => opacity), beam.key).toEqual([0, 1, 1, 0]);
        expect(beam.stops.map(([offset]) => offset), beam.key).toEqual([0, fade, 1 - fade, 1].map((offset) => expect.closeTo(offset, 2)));
        // Full width to the end: no cap, round or square, past it.
        expect(beam.lines.every((cap) => cap === "butt"), beam.key).toBe(true);
    }
});

test("on the helman card every arrow ends square, its pulses clipped to its ends", async ({ page }) => {
    await page.setContent(PAGE);
    await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("power-flow-arrows"));
    await addArrows(page, [8000, 1000], 25 * 230 * 3);
    await settled(page);
    const ends = await page.evaluate(() => {
        const arrows = document.querySelector("power-flow-arrows")!.shadowRoot!;
        return [...arrows.querySelectorAll<HTMLElement>(".animated-arrow")].map((arrow) => {
            const box = arrow.getBoundingClientRect();
            const clip = arrow.querySelector<HTMLElement>(".surges")!;
            return {
                radii: [arrow, ...arrow.querySelectorAll<HTMLElement>(".body, .body *")].map((el) => getComputedStyle(el).borderTopLeftRadius + " " + getComputedStyle(el).borderBottomRightRadius),
                children: [...arrow.querySelector(".body")!.children].map((child) => child.className),
                clip: { overflow: getComputedStyle(clip).overflow, top: clip.getBoundingClientRect().top - box.top, bottom: clip.getBoundingClientRect().bottom - box.bottom },
            };
        });
    });
    expect(ends).toHaveLength(2);
    for (const { radii, children, clip } of ends) {
        expect(radii.every((radius) => radius === "0px 0px"), radii.join()).toBe(true);
        expect(children).toEqual(["segments"]);
        expect(clip).toEqual({ overflow: "hidden", top: 0, bottom: 0 });
    }
});

test("a surge stays inside its own column, however narrow the columns are", async ({ page }) => {
    // Eight consumers at the maximum in a very narrow row: each column narrower than a full surge's 9 px.
    await page.setContent(PAGE);
    await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("power-flow-arrows"));
    await page.evaluate(() => { document.getElementById("stage")!.style.width = "100px"; });
    await addArrows(page, Array(8).fill(11_500), 11_500);
    const boxes = await page.evaluate(() => {
        const root = document.querySelector("power-flow-arrows")!.shadowRoot!;
        return [...root.querySelectorAll<HTMLElement>(".item-container")].map((column) => {
            const outer = column.getBoundingClientRect();
            const inner = column.querySelector(".surges")!.getBoundingClientRect();
            return { column: outer.width, left: inner.left - outer.left, right: outer.right - inner.right };
        });
    });
    expect(boxes).toHaveLength(8);
    for (const { column, left, right } of boxes) {
        expect(column).toBeLessThan(flowBeam(1, "red").surgeWidth);
        expect(left).toBeGreaterThanOrEqual(-0.01);
        expect(right).toBeGreaterThanOrEqual(-0.01);
    }
});

// ── Rates ────────────────────────────────────────────────────────────────────

test("animations the browser recreates on a remount, on being shown or after a pause run at their element's rate", async ({ page }) => {
    await mountSimpleCard(page, NIGHT_CHARGE);
    await addArrows(page, [8000, 2000], 25 * 230 * 3);
    // A recreated animation starts at rate 1 and takes its element's rate on its `animationstart`, a frame or two later.
    await settled(page);
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
    await settled(page);

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
    expect(opacity).toBeCloseTo(0.14 + 0.3 * flowLevel(flowRatio(1600, 11500)), 5);
});

test.describe("reduced motion", () => {
    test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
    });

    test("nothing moves, and the beams, surges and glows stay lit where they are", async ({ page }) => {
        await mountSimpleCard(page, NIGHT_CHARGE);
        await addArrows(page, [8000], 25 * 230 * 3);
        await surgesDrawn(page);

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
        expect(still.body).toBeGreaterThan(0.14);
        expect(still.halos.length).toBeGreaterThan(0);
        for (const opacity of still.halos) expect(opacity).toBeCloseTo(0.6, 5);
        // Spread along the beam: every surge rests somewhere different.
        expect(still.surges.length).toBeGreaterThan(0);
        expect(still.arrowSurges.length).toBeGreaterThan(0);
        expect(still.surges.every((transform) => transform !== "none")).toBe(true);
        expect(new Set(still.surges).size).toBe(still.surges.length);
        expect(new Set(still.arrowSurges).size).toBe(still.arrowSurges.length);

        // Every resting surge's head, half a surge ahead of its centre, lies on its beam.
        const heads = await page.evaluate(({ lookup, half }) => {
            const root = document.querySelector("helman-simple-card")!.shadowRoot!;
            const arrows = document.querySelector("power-flow-arrows")!.shadowRoot!;
            return [root, arrows].flatMap((each) => [...each.querySelectorAll<HTMLElement | SVGElement>("[data-flow-beam]")].flatMap((beam) => {
                const key = beam.dataset.flowBeam!;
                const { surges, start, end } = eval(lookup)(each, key);
                const [dx, dy] = [end.x - start.x, end.y - start.y];
                const length = Math.hypot(dx, dy);
                return surges.map((surge: Element) => {
                    const box = surge.getBoundingClientRect();
                    const along = ((box.x + box.width / 2 - start.x) * dx + (box.y + box.height / 2 - start.y) * dy) / length;
                    return { key, length, head: along + half };
                });
            }));
        }, { lookup: FLOW_BEAM, half: FLOW_SURGE_LENGTH / 2 });
        expect(heads.length).toBe(still.surges.length + still.arrowSurges.length);
        for (const { key, length, head } of heads) {
            expect(head, key).toBeGreaterThan(0);
            expect(head, key).toBeLessThan(length);
        }
    });
});

test("a light theme drops the white from the pulse head", async ({ page }) => {
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

test("the helman card draws its arrows against the largest node maximum, and ignores a max_power left in its config", async ({ page }) => {
    // 103 W of solar next to 2.3 kW imported from the grid, on the tree's shared scale: the grid's 11.5 kW.
    await page.setContent("<!doctype html><html><body></body></html>");
    await installMockHass(page);
    await page.evaluate((payload) => {
        const watts = (value: number) => ({ state: String(value), attributes: { unit_of_measurement: "W" } });
        (window as any).__hass = {
            ...window.__mockHass({
                "helman/get_device_tree": payload,
                "helman/get_history": { entity_history: {} },
                "helman/get_node_detail": { entities: {} },
            }),
            language: "en", locale: { language: "en" }, config: { time_zone: "UTC" },
            states: { "sensor.solar": watts(103), "sensor.battery": watts(0), "sensor.grid": watts(2300), "sensor.house": watts(2403) },
        };
    }, cardTree());
    await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
    await page.evaluate(() => {
        const card = document.createElement("helman-card") as any;
        // A dashboard saved before the option was removed still carries it; it scales nothing.
        card.setConfig({ type: "custom:helman-card", max_power: 1000 });
        card.hass = (window as any).__hass;
        document.body.appendChild(card);
    });

    const arrows = () => page.evaluate(() => {
        const card = document.querySelector("helman-card")!.shadowRoot!;
        const root = card.querySelector("power-flow-arrows")!.shadowRoot!;
        return Object.fromEntries([...root.querySelectorAll<HTMLElement>("[data-flow-beam]")].map((beam) => [beam.dataset.flowBeam, {
            width: parseFloat(beam.style.width),
            surge: parseFloat(beam.querySelector<HTMLElement>(".surges")!.style.width),
            opacity: Number(beam.querySelector<HTMLElement>(".body")!.style.opacity),
            rate: Number(beam.querySelector("[data-beat]")?.getAttribute("data-rate") ?? 0),
        }]));
    });
    // The source row: solar, grid, battery (idle, no beam).
    await expect.poll(async () => { const drawn = await arrows(); return [0, 1].every((index) => drawn[index]?.rate > 0); }).toBe(true);
    const { 0: solar, 1: grid } = await arrows();
    expect(solar.width).toBeCloseTo(flowThickness(flowRatio(103, 11500)), 3);
    expect(grid.width).toBeCloseTo(flowThickness(flowRatio(2300, 11500)), 3);
    expect(solar.width).toBeLessThan(grid.width);
    // Each surge is drawn a pixel wider than its beam, the 103 W one the narrower.
    expect(solar.surge).toBeCloseTo(flowBeam(flowRatio(103, 11500), "red").surgeWidth, 3);
    expect(grid.surge).toBeCloseTo(flowBeam(flowRatio(2300, 11500), "red").surgeWidth, 3);
    expect(solar.surge).toBeLessThan(grid.surge);
    expect(solar.opacity).toBeLessThan(grid.opacity);
    expect(solar.rate).toBeLessThan(grid.rate);
});

test("the simple card draws a 103 W flow thinner, with a narrower surge, than a 2.3 kW one on the same scale", async ({ page }) => {
    // 103 W of solar and 2.3 kW from the grid into the house, on the tree's shared scale: the grid's 11.5 kW.
    await mountSimpleCard(page, { solar: 103, house: 2403, battery: 0, grid: 2300 });
    await settled(page);
    const beams = await page.evaluate(() => {
        const root = document.querySelector("helman-simple-card")!.shadowRoot!;
        return Object.fromEntries(["solar-house", "grid-house"].map((flow) => [flow, {
            width: Number(root.querySelector(`line[data-flow="${flow}"]`)!.getAttribute("stroke-width")),
            // A pulse is drawn along its beam: its smaller side is across it.
            surge: Math.min(...(({ width, height }) => [width, height])(root.querySelector<SVGRectElement>(`g[mask*="-${flow}-mask"] [data-beat="surge"] rect`)!.getBBox())),
        }]));
    });
    const { "solar-house": solar, "grid-house": grid } = beams;
    expect(solar.width).toBeCloseTo(flowThickness(flowRatio(103, 11500)), 3);
    expect(grid.width).toBeCloseTo(flowThickness(flowRatio(2300, 11500)), 3);
    expect(solar.width).toBeLessThan(grid.width);
    // Each surge is a pixel wider than its beam, the 103 W one the narrower.
    expect(solar.surge).toBeCloseTo(flowBeam(flowRatio(103, 11500), "red").surgeWidth, 3);
    expect(grid.surge).toBeCloseTo(flowBeam(flowRatio(2300, 11500), "red").surgeWidth, 3);
    expect(solar.surge).toBeLessThan(grid.surge);
});

test("an edge's surges are spread evenly over one crossing, at their flow's speed over their beam's length", () => {
    // Resting, each one's head sits at its even share of the beam: its head covers one crossing over its path.
    const rest = (share: number, length: number) => expect.closeTo(share * length / (length + 41), 6);
    // The faintest flow on a 5 px beam: one surge, at 3 px/s over 5 + 41 px, its head resting mid-beam.
    expect(flowSurges(0, 5)).toEqual({
        count: 1,
        rate: 0.0652,
        surges: [{ delay: "0ms", rest: rest(0.5, 5) }],
    });
    // The strongest on a 85 px beam: three, a third of the loop apart, at 60 px/s over 85 + 41 px.
    expect(flowSurges(1, 85)).toEqual({
        count: 3,
        rate: 0.476,
        surges: [{ delay: "0ms", rest: rest(0.25, 85) }, { delay: "-333ms", rest: rest(0.5, 85) }, { delay: "-667ms", rest: rest(0.75, 85) }],
    });
    // A beam not measured yet, or not laid out, carries none.
    expect(flowSurges(1, undefined)).toEqual({ count: 0, rate: 0, surges: [] });
    expect(flowSurges(1, 0)).toMatchObject({ count: 0 });
});
