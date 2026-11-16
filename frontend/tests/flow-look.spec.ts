import { test, expect, type Page } from "@playwright/test";
import { CARD_BUNDLE, loadBundle } from "./support/card-page";
import { installMockHass } from "./support/mock-hass";
import { cardTree, treeNode, treePayload } from "./support/payload-builders";
import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { flowBeam, flowEase, flowGlow, flowGlowPeriodMs, flowGlowSize, flowLevel, flowRatio, flowScaleW, flowSpeed, flowSurgeCount, flowSurgeGradient, flowSurgeLead, flowSurgeLength, flowSurgeRate, flowSurges, flowSurgeTravel, flowThickness } from "../cards/shared/flow-style";

/**
 * The look of a flow (#770, #776, #778): one ratio per flow and per node,
 * `r = clamp((power − 200) / (max − 200), 0, 1)` (the 200 W floor,
 * `FLOW_FLOOR_W`) against one shared scale, drives through one easing
 * `t = sqrt(r)` the cues that agree with each other -- beam thickness and
 * brightness, surge width and speed, glow brightness, size and rate -- as
 * continuous curves. Each edge and each glow runs its own tempo; a
 * surge's speed is a velocity on screen, px/s, from its power alone, and its
 * blob and the spacing between surges are fixed lengths on screen, so a flow
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

    test("beam thickness runs from 1.5 px at r = 0 to 21 px at the maximum, along the square root", () => {
        expect(RATIOS.map(flowThickness)).toEqual(RATIOS.map((r) => expect.closeTo(1.5 + 19.5 * Math.sqrt(r), 10)));
        expect(flowThickness(0)).toBe(1.5);
        expect(flowThickness(1)).toBe(21);
        // A quarter of the scale is already half way up: 1.5 + 19.5 / 2.
        expect(flowThickness(0.25)).toBeCloseTo(11.25, 10);
    });

    test("the level runs from 0.2 to 1 along the square root", () => {
        expect(RATIOS.map(flowLevel)).toEqual(RATIOS.map((r) => expect.closeTo(0.2 + 0.8 * Math.sqrt(r), 10)));
        expect(flowLevel(0.25)).toBeCloseTo(0.6, 10);
    });

    test("a surge moves at 3 px/s at r = 0 and 120 px/s at the maximum, along the square root", () => {
        const speeds = RATIOS.map(flowSpeed);
        expect(speeds).toEqual(RATIOS.map((r) => expect.closeTo(3 + 117 * Math.sqrt(r), 10)));
        expect(speeds[0]).toBe(3);
        expect(speeds.at(-1)).toBe(120);
        expect(strictlyRising(speeds)).toBe(true);
        // 500 W of 17.25 kW moves at about 18.5 px/s; a quarter of the scale at 61.5.
        expect(flowSpeed(flowRatio(500, 17_250))).toBeCloseTo(18.52, 2);
        expect(flowSpeed(0.25)).toBeCloseTo(61.5, 10);
    });

    test("one curve: thickness, surge width and halo, level, glow size and speed all rise with r, each a fixed function of flowEase", () => {
        const fine = Array.from({ length: 1001 }, (_, index) => index / 1000);
        const cues = {
            thickness: fine.map(flowThickness),
            surge: fine.map((r) => flowBeam(r, "red").surgeThickness),
            halo: fine.map((r) => { const beam = flowBeam(r, "red"); return beam.surgeWidth - beam.surgeThickness; }),
            level: fine.map(flowLevel),
            glow: fine.map(flowGlowSize),
            speed: fine.map(flowSpeed),
        };
        for (const values of Object.values(cues)) expect(strictlyRising(values)).toBe(true);
        // Each cue is the same affine map of t = flowEase(r) at every r: none reads r directly.
        for (const [index, r] of fine.entries()) {
            const t = flowEase(r);
            expect(cues.thickness[index]).toBeCloseTo(1.5 + 19.5 * t, 10);
            expect(cues.surge[index]).toBeCloseTo(1.5 + 19.5 * t + 4 + 8 * t, 10);
            expect(cues.halo[index]).toBeCloseTo(2 * (2 + 6 * t), 10);
            expect(cues.level[index]).toBeCloseTo(0.2 + 0.8 * t, 10);
            expect(cues.glow[index]).toBeCloseTo(t, 10);
            expect(cues.speed[index]).toBeCloseTo(3 + 117 * t, 10);
        }
    });

    test("on one scale, 103 W draws thinner, dimmer, with a narrower surge and slower than 2.3 kW", () => {
        const scale = 17_250;
        const [small, large] = [103, 2300].map((power) => flowRatio(power, scale)).map((r) => ({ ...flowBeam(r, "red"), speed: flowSpeed(r), level: flowLevel(r) }));
        expect(small.width).toBeLessThan(large.width);
        expect(small.level).toBeLessThan(large.level);
        expect(small.surgeThickness).toBeLessThan(large.surgeThickness);
        expect(small.speed).toBeLessThan(large.speed);
        // A bubble around the pipe: 5.5 px around 103 W's 1.5 px floor, about 15.2 around 2.3 kW's 8.3, inside a halo that grows too.
        expect(small.surgeThickness).toBeCloseTo(5.5, 10);
        expect(large.surgeThickness).toBeCloseTo(15.154, 2);
        expect(small.surgeWidth - small.surgeThickness).toBeLessThan(large.surgeWidth - large.surgeThickness);
        expect(flowBeam(1, "red")).toMatchObject({ surgeThickness: 33, surgeWidth: 49 });
    });

    test("a surge's gradient stops step in 0.05 of its width, so close powers paint the same gradient while the widths stay exact", () => {
        const [a, b] = [2300, 2310].map((power) => flowBeam(flowRatio(power, 17_250), "red"));
        expect(a.surgeWidth).not.toBe(b.surgeWidth);
        expect(flowSurgeGradient("red", a)).toBe(flowSurgeGradient("red", b));
        expect(flowSurgeGradient("red", flowBeam(0, "red"))).not.toBe(flowSurgeGradient("red", flowBeam(1, "red")));
    });

    test("a flow at or under the 200 W floor draws at r = 0, and the ratio runs from the floor to the scale, clamped", () => {
        for (const power of [-500, 0, 103, 130, 200]) expect(flowRatio(power, 17_250)).toBe(0);
        expect(flowRatio(17_250, 17_250)).toBe(1);
        expect(flowRatio(40_000, 17_250)).toBe(1);
        expect(flowRatio(8725, 17_250)).toBeCloseTo(0.5, 10);
        // A scale at or under the floor, or none, draws everything at the lowest ratio.
        for (const max of [null, undefined, 0, 150, 200]) expect(flowRatio(5000, max)).toBe(0);
        // On the local 17.25 kW scale: 130 W on the floor, 500 W about 4.1 px, 2.3 kW about 8.3, 10 kW about 16.3.
        expect([130, 500, 2300, 10_000].map((power) => flowThickness(flowRatio(power, 17_250))))
            .toEqual([1.5, 4.087, 8.344, 16.284].map((width) => expect.closeTo(width, 2)));
    });

    test("the shared scale is the largest positive maximum, nulls ignored, else 0", () => {
        expect(flowScaleW([5000, 11500, 5000])).toBe(11500);
        expect(flowScaleW([null, 17250, undefined, 5000])).toBe(17250);
        expect(flowScaleW([0, -10, null])).toBe(0);
        expect(flowScaleW([])).toBe(0);
    });

    test("a surge's blob is 12 px long, and no more than 0.9 of a tiny beam", () => {
        expect([5, 10, 13.3, 22, 28, 60, 107, 400].map(flowSurgeLength)).toEqual([4.5, 9, 11.97, 12, 12, 12, 12, 12].map((l) => expect.closeTo(l, 10)));
    });

    test("a beam's crossing is its length and a surge's length, short of the hand-off overlap at each end, and the rate runs it once per crossing", () => {
        // From 1.5 px of the blob over the start to 1.5 px of it over the end: half a 12 px blob less 1.5 px each side.
        expect(flowSurgeLead(60)).toBe(4.5);
        expect(flowSurgeTravel(60)).toBe(69);
        // 60 px at 120 px/s: (60 + 12 - 3) / 120 = 575 ms, 1.74 loops a second.
        expect(flowSurgeRate(120, 60)).toBe(1.74);
        // 28 px at 3 px/s: (28 + 12 - 3) / 3 = 12.3 s.
        expect(flowSurgeRate(3, 28)).toBe(0.0811);
    });

    test("on a beam too short for the hand-off, a crossing is never shorter than the beam and the rate stays finite and forward", () => {
        // 1 px: a 0.9 px blob, no room for a 1.5 px hand-off, so its centre runs from the start to the end.
        expect(flowSurgeLead(1)).toBe(0);
        expect(flowSurgeTravel(1)).toBe(1);
        expect(flowSurgeRate(120, 1)).toBe(120);
        // 3 px: a 2.7 px blob, still no room.
        expect(flowSurgeLead(3)).toBe(0);
        expect(flowSurgeTravel(3)).toBe(3);
        expect(flowSurgeRate(120, 3)).toBe(40);
        for (let length = 0.01; length < 20; length += 0.01) {
            expect(flowSurgeLead(length)).toBeGreaterThanOrEqual(0);
            expect(flowSurgeTravel(length)).toBeGreaterThanOrEqual(length);
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

    test("a beam carries one surge per ~40 px of its length and a blob, at least one, whatever its power", () => {
        const lengths = [5, 22, 28, 47, 60, 87, 107, 200];
        expect(lengths.map((length) => flowSurgeCount(length))).toEqual([1, 1, 1, 1, 2, 2, 3, 5]);
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
 * In the page, `(root, key, steps) => [...]`: every surge of the beam marked
 * `data-flow-beam=key` under `root` held at `steps` evenly spaced points of
 * one loop of animation time, and at each the most any blob, `half` px either
 * side of its centre (its box's), overlaps the
 * beam, px along it on screen: the beam, ends square, shows over its own length.
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

for (const [name, powers] of [
    // r = 0: 60 W of solar and of battery, 120 W of grid, all to the house, under the 200 W floor of the shared 11.5 kW scale.
    ["just above idle", { solar: 60, house: 240, battery: -60, grid: 120 }],
    // r = 1: each at the shared scale, the grid's 11.5 kW.
    ["at the maximum", { solar: 11500, house: 34500, battery: -11500, grid: 11500 }],
] as const) {
    test(`${name}, a beam always has a blob overlapping it by more than 1 px, through a whole loop`, async ({ page }) => {
        await mountSimpleCard(page, powers);
        await settled(page);
        // Every beam here is long enough for a whole 12 px blob.
        const half = flowSurgeLength(100) / 2;
        for (const key of NEVER_EMPTY_BEAMS) {
            const { length, count, overlaps } = await page.evaluate(({ key, lookup, half }) =>
                eval(lookup)(document.querySelector("helman-simple-card")!.shadowRoot!, key, 200, half), { key, lookup: LOOP_OVERLAPS, half });
            expect(flowSurgeLength(length), key).toBe(2 * half);
            expect(count, key).toBe(flowSurgeCount(length));
            expect(overlaps, key).toHaveLength(200);
            // At the hand-off the blob leaving and the one entering each still overlap by 1.5 px; elsewhere by more.
            expect(Math.min(...overlaps), `${key}, ${count} surges on ${length} px`).toBeGreaterThan(1.4);
        }
    });
}

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
        // A surge passes any point once per loop over the count: about every 40 px of travel.
        const spacing = beam.speed * beam.loopMs / 1000 / beam.count;
        expect(spacing).toBeGreaterThan(30);
        expect(spacing).toBeLessThan(50);
    }
    expect(battery.count).toBeGreaterThan(solar.count);
    const interval = (beam: typeof solar) => beam.loopMs / beam.count;
    expect(interval(battery) / interval(solar)).toBeGreaterThan(0.75);
    expect(interval(battery) / interval(solar)).toBeLessThan(1.33);
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

// ── The blob on screen ───────────────────────────────────────────────────────

/**
 * In the page, `(root, key, time) => ...`: the first surge of the beam marked
 * `data-flow-beam=key` under `root`, held at `time` ms of its animation, and
 * its blob on screen: its centre's place along the beam, px from its start,
 * the beam's length, its axes (the blob's own x and y, its half length and
 * half thickness, as vectors on screen), the beam's angle on screen, and its
 * mask's half thickness and line cap.
 */
const HELD_BLOB = `(root, key, time) => {
    const { surges, start, end } = (${FLOW_BEAM})(root, key);
    const surge = surges[0];
    const animation = surge.getAnimations()[0];
    animation.pause();
    animation.currentTime = time;
    const blob = surge.firstElementChild;
    const ctm = blob.getScreenCTM();
    const rx = blob.rx.baseVal.value;
    const ry = blob.ry.baseVal.value;
    const cx = blob.cx.baseVal.value;
    const cy = blob.cy.baseVal.value;
    const at = (x, y) => new DOMPoint(cx + x, cy + y).matrixTransform(ctm);
    const centre = at(0, 0);
    const [dx, dy] = [end.x - start.x, end.y - start.y];
    const length = Math.hypot(dx, dy);
    const axis = (point) => [point.x - centre.x, point.y - centre.y];
    const mask = root.querySelector('mask[id$="-' + key + '-mask"] line');
    return {
        along: ((centre.x - start.x) * dx + (centre.y - start.y) * dy) / length,
        length,
        x: axis(at(rx, 0)),
        y: axis(at(0, ry)),
        angle: Math.atan2(dy, dx),
        halfThickness: Number(mask.getAttribute("stroke-width")) / 2,
        linecap: getComputedStyle(mask).strokeLinecap,
    };
}`;

test("on an overlay stretched one way, a diagonal blob lies along its beam and every blob is as thick as its mask", async ({ page }) => {
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
        const blob = await page.evaluate(({ key, lookup }) => {
            return eval(lookup)(document.querySelector("helman-simple-card")!.shadowRoot!, key, 500);
        }, { key, lookup: HELD_BLOB });
        const norm = ([x, y]: number[]) => Math.hypot(x, y);
        // Its long axis runs along the beam on screen, and its short one square to it: not sheared.
        expect(Math.atan2(blob.x[1], blob.x[0]), key).toBeCloseTo(blob.angle, 2);
        expect((blob.x[0] * blob.y[0] + blob.x[1] * blob.y[1]) / norm(blob.x) / norm(blob.y), key).toBeCloseTo(0, 3);
        // As long as a blob, and as thick as the mask it shows through.
        expect(norm(blob.x), key).toBeCloseTo(flowSurgeLength(blob.length) / 2, 1);
        expect(norm(blob.y), key).toBeCloseTo(blob.halfThickness, 1);
    }
});

test("at the strongest flow a blob enters just overlapping its beam's square start and leaves just overlapping its end", async ({ page }) => {
    // Far over solar's 5 kW: to the grid along the top, down the left to the house and across the diagonal to the battery, each at r = 1.
    await mountSimpleCard(page, { solar: 45000, house: 15000, battery: 15000, grid: -15000 });
    await settled(page);
    for (const key of ["solar-grid", "solar-house", "solar-battery"]) {
        const [first, last] = await page.evaluate(({ key, lookup }) => {
            const root = document.querySelector("helman-simple-card")!.shadowRoot!;
            // The first surge starts its loop at once: its animation at 0 ms is the start of a crossing, at 1000 ms its end.
            return [0, 999.99].map((time) => eval(lookup)(root, key, time));
        }, { key, lookup: HELD_BLOB });
        const half = flowSurgeLength(first.length) / 2;
        // The mask ends square at the beam's ends, so the beam shows a surge over its own length and no further.
        expect(first.linecap, key).toBe("butt");
        // It starts with 1.5 px of its blob over the start, and ends with as much over the end: the next one enters as it leaves.
        expect(first.along, key).toBeCloseTo(-flowSurgeLead(first.length), 1);
        expect(first.along + half, key).toBeCloseTo(1.5, 1);
        expect(last.along - half, key).toBeCloseTo(last.length - 1.5, 1);
    }
});

test("every beam ends straight and square: butt caps on the simple card, square arrow ends, and nothing added at an end", async ({ page }) => {
    // Solar to the grid along the top, down the left to the house and across the overlay's diagonal to the battery.
    await mountSimpleCard(page, { solar: 6500, house: 900, battery: 3200, grid: -2400 });
    await addArrows(page, [8000, 1000], 25 * 230 * 3);
    await settled(page);
    const ends = await page.evaluate(() => {
        const root = document.querySelector("helman-simple-card")!.shadowRoot!;
        const arrows = document.querySelector("power-flow-arrows")!.shadowRoot!;
        return {
            caps: [...root.querySelectorAll<SVGLineElement>(".flow-bloom, .flow-beam, .flow-core, mask line")].map((line) => getComputedStyle(line).strokeLinecap),
            beams: root.querySelectorAll("line[data-flow-beam]").length,
            // A beam is its bloom, its body and its core, and its surges' mask: nothing more is drawn at its ends.
            lines: root.querySelectorAll("line").length,
            arrows: [...arrows.querySelectorAll<HTMLElement>(".animated-arrow")].map((arrow) =>
                [arrow, ...arrow.querySelectorAll<HTMLElement>("*")].map((el) => getComputedStyle(el).borderTopLeftRadius + " " + getComputedStyle(el).borderBottomRightRadius)),
            arrowChildren: [...arrows.querySelectorAll<HTMLElement>(".animated-arrow .body")].map((body) => [...body.children].map((child) => child.className)),
        };
    });
    expect(ends.caps.length).toBeGreaterThan(10);
    expect(ends.caps.every((cap) => cap === "butt"), ends.caps.join()).toBe(true);
    expect(ends.beams).toBe(3);
    expect(ends.lines).toBe(4 * ends.beams);
    expect(ends.arrows).toHaveLength(2);
    for (const radii of ends.arrows) expect(radii.every((radius) => radius === "0px 0px"), radii.join()).toBe(true);
    for (const children of ends.arrowChildren) expect(children).toEqual(["segments", "core"]);
});

test("a wide surge stays inside its own column, however narrow the columns are", async ({ page }) => {
    // Eight consumers at the maximum in a phone-width row: each column narrower than a full surge's 49 px.
    await page.setContent(PAGE);
    await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("power-flow-arrows"));
    await page.evaluate(() => { document.getElementById("stage")!.style.width = "320px"; });
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
    expect(opacity).toBeCloseTo(0.25 + 0.65 * flowLevel(flowRatio(1600, 11500)), 5);
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
        expect(still.body).toBeGreaterThan(0.25);
        expect(still.halos.length).toBeGreaterThan(0);
        for (const opacity of still.halos) expect(opacity).toBeCloseTo(0.6, 5);
        // Spread along the beam: every surge rests somewhere different.
        expect(still.surges.length).toBeGreaterThan(0);
        expect(still.arrowSurges.length).toBeGreaterThan(0);
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
    // Each surge is drawn as wide as its bubble and halo, the 103 W one the narrower.
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
            surge: Number(root.querySelector(`mask[id$="-${flow}-mask"] line`)!.getAttribute("stroke-width")),
        }]));
    });
    const { "solar-house": solar, "grid-house": grid } = beams;
    expect(solar.width).toBeCloseTo(flowThickness(flowRatio(103, 11500)), 3);
    expect(grid.width).toBeCloseTo(flowThickness(flowRatio(2300, 11500)), 3);
    expect(solar.width).toBeLessThan(grid.width);
    // Each surge's mask is as wide as its bubble and halo, the 103 W one the narrower.
    expect(solar.surge).toBeCloseTo(flowBeam(flowRatio(103, 11500), "red").surgeWidth, 3);
    expect(grid.surge).toBeCloseTo(flowBeam(flowRatio(2300, 11500), "red").surgeWidth, 3);
    expect(solar.surge).toBeLessThan(grid.surge);
});

test("an edge's surges are spread evenly over one crossing, at their flow's speed over their beam's length", () => {
    // The faintest flow on a 28 px beam: one surge, at 3 px/s over 28 + 12 - 3 px.
    expect(flowSurges(0, 28)).toEqual({
        count: 1,
        rate: 0.0811,
        surges: [{ delay: "0ms", rest: 0.5 }],
    });
    // The strongest on a 107 px beam: three, a third of the loop apart, at 120 px/s over 107 + 12 - 3 px.
    expect(flowSurges(1, 107)).toEqual({
        count: 3,
        rate: 1.03,
        surges: [{ delay: "0ms", rest: 0.25 }, { delay: "-333ms", rest: 0.5 }, { delay: "-667ms", rest: 0.75 }],
    });
    // A beam not measured yet, or not laid out, carries none.
    expect(flowSurges(1, undefined)).toEqual({ count: 0, rate: 0, surges: [] });
    expect(flowSurges(1, 0)).toMatchObject({ count: 0 });
});
