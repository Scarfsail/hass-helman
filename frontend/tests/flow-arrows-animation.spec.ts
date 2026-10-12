import { test, expect, type Page } from "@playwright/test";
import { CARD_BUNDLE } from "./support/card-page";

/**
 * What the flow arrows are allowed to cost while nobody is looking at them.
 *
 * The light band sweeps forever, so the animation is paused whenever the element
 * is scrolled out of the viewport or the tab is in the background, and picks up
 * where it left off on the way back. Before that, three arrow rows kept the
 * renderer recalculating style and painting on every frame for as long as the
 * card was on the page -- offscreen and backgrounded included.
 *
 * The pause is a host attribute rather than reactive state, so it costs no
 * render; these read the animation's own `playState` rather than the attribute,
 * because that is what actually decides whether frames are produced.
 *
 * The lifecycle half matters just as much: the element adds a document listener
 * and an IntersectionObserver, and a dashboard mounts and unmounts cards freely.
 */

/** A 3-phase 25 A house, so the widths below are a readable fraction of it. */
const MAX_POWER = 25 * 230 * 3;

/** A page tall enough to scroll the arrows completely out of the viewport. */
const PAGE = `<!doctype html><html><body style="margin:0">
<div id="stage"></div>
<div id="spacer" style="height:4000px"></div>
</body></html>`;

async function mountArrows(page: Page, powers: (number | null)[]): Promise<void> {
    await mountDevices(page, powers.map((p) => (p === null ? null : { powerValue: p })));
}

/** The source row every band test shares: solar, battery, grid, left to right. */
const SOURCES = [
    { id: "src-solar", sourceType: "solar", isSource: true },
    { id: "src-battery", sourceType: "battery", isSource: true },
    { id: "src-grid", sourceType: "grid", isSource: true },
];

async function mountDevices(page: Page, devices: (object | null)[], sources: object[] = []): Promise<void> {
    await page.setContent(PAGE);
    await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("power-flow-arrows"));
    await page.evaluate(async (opts) => {
        const el = document.createElement("power-flow-arrows") as any;
        el.devices = opts.devices.map((d) => d ?? undefined);
        el.sources = opts.sources;
        el.maxPower = opts.maxPower;
        document.getElementById("stage")!.appendChild(el);
        await el.updateComplete;
    }, { devices, sources, maxPower: MAX_POWER });
}

/** Each drawn ribbon's bands, left to right: their source and flex-grow. */
function segments(page: Page): Promise<{ source: string | null; grow: string }[][]> {
    return page.evaluate(() => {
        const root = document.querySelector("power-flow-arrows")!.shadowRoot!;
        return [...root.querySelectorAll(".animated-arrow")].map((arrow) =>
            [...arrow.querySelectorAll(".segment")].map((segment) => ({
                source: segment.getAttribute("data-source"),
                grow: getComputedStyle(segment).flexGrow,
            })));
    });
}

/** The play states of every light band animation, deduplicated. */
function playStates(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const root = document.querySelector("power-flow-arrows")!.shadowRoot!;
        const states = [...root.querySelectorAll(".band")]
            .flatMap((band) => band.getAnimations().map((a) => a.playState));
        return [...new Set(states)].sort();
    });
}

/** Report the page as hidden or visible, the way a backgrounded tab does. */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
    await page.evaluate((value: boolean) => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
        document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
}

test("an arrow's width stays proportional to its power, and tiny flows draw nothing", async ({ page }) => {
    await mountArrows(page, [MAX_POWER / 4, 2 * MAX_POWER, 0.2, null]);

    const widths = await page.evaluate(() => {
        const root = document.querySelector("power-flow-arrows")!.shadowRoot!;
        return [...root.querySelectorAll(".item-container")]
            .map((item) => (item.querySelector(".animated-arrow") as HTMLElement | null)?.style.width ?? null);
    });

    expect(widths).toEqual(["25%", "100%", null, null]);
});

test("a source's ribbon is one band in its own colour", async ({ page }) => {
    await mountDevices(page, [{ ...SOURCES[2], powerValue: 1000 }], SOURCES);

    expect(await segments(page)).toEqual([[{ source: "grid", grow: "1" }]]);
});

test("a consumer's ribbon is split by the sources' shares of its latest bucket, and a revision moves it", async ({ page }) => {
    const consumer = {
        powerValue: 400,
        sourcePowerHistory: [
            { "src-battery": { power: 400, color: "#000" } },
            { "src-grid": { power: 100, color: "#000" }, "src-solar": { power: 300, color: "#000" } },
        ],
    };
    await mountDevices(page, [consumer], SOURCES);

    expect(await segments(page)).toEqual([[
        { source: "solar", grow: "0.75" },
        { source: "grid", grow: "0.25" },
    ]]);

    await page.evaluate(async () => {
        const el = document.querySelector("power-flow-arrows") as any;
        el.devices[0].sourcePowerHistory.push({ "src-battery": { power: 200, color: "#000" }, "src-grid": { power: 0, color: "#000" } });
        el.historyRevision = 1;
        await el.updateComplete;
    });

    expect(await segments(page)).toEqual([[{ source: "battery", grow: "1" }]]);
});

test("a consumer with nothing to attribute is one neutral band", async ({ page }) => {
    await mountDevices(page, [{ powerValue: 400 }], SOURCES);

    expect(await segments(page)).toEqual([[{ source: "none", grow: "1" }]]);
    const color = await page.evaluate(() => {
        const segment = document.querySelector("power-flow-arrows")!.shadowRoot!.querySelector(".segment")!;
        return getComputedStyle(segment).backgroundColor;
    });
    expect(color).toBe("rgb(156, 163, 175)");
});

test("a visible arrow animates", async ({ page }) => {
    await mountArrows(page, [MAX_POWER / 2]);

    expect(await playStates(page)).toEqual(["running"]);
});

test("scrolling the arrows out of the viewport pauses them, and scrolling back resumes", async ({ page }) => {
    await mountArrows(page, [MAX_POWER / 2]);

    await page.evaluate(() => window.scrollTo(0, 3000));
    await expect.poll(() => playStates(page)).toEqual(["paused"]);

    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => playStates(page)).toEqual(["running"]);
});

test("a hidden page pauses the arrows, and coming back resumes them", async ({ page }) => {
    await mountArrows(page, [MAX_POWER / 2]);

    await setHidden(page, true);
    await expect.poll(() => playStates(page)).toEqual(["paused"]);

    await setHidden(page, false);
    await expect.poll(() => playStates(page)).toEqual(["running"]);
});

test("an element remounted after being scrolled away starts running", async ({ page }) => {
    await mountArrows(page, [MAX_POWER / 2]);

    // Off screen, so this mount ends on a paused verdict.
    await page.evaluate(() => window.scrollTo(0, 3000));
    await expect.poll(() => playStates(page)).toEqual(["paused"]);

    // The dashboard moves the card: same element, back at the top of the page.
    // The fresh observer has reported nothing yet, so the verdict it starts from
    // is the one the element carries.
    const pausedOnRemount = await page.evaluate(() => {
        const el = document.querySelector("power-flow-arrows") as any;
        el.remove();
        window.scrollTo(0, 0);
        document.getElementById("stage")!.appendChild(el);
        // Read before yielding: the observer's first callback is a task away, and
        // what is drawn until it lands is this verdict -- a still frame of
        // a half-swept light band if the element kept the one it was removed on.
        return el.hasAttribute("paused");
    });

    expect(pausedOnRemount).toBe(false);
    expect(await playStates(page)).toEqual(["running"]);
});

/**
 * `powerValue` is written in place on the nodes the array holds, so the array
 * never changes identity and the widths would stand still. The card used to say
 * so by spreading the array on every render -- at `hass` churn rate, which is
 * not the rate the value moves at. The revision is the rate it moves at.
 */
test("a bumped revision moves the widths, and nothing else does", async ({ page }) => {
    await mountArrows(page, [MAX_POWER / 4]);

    const widths = await page.evaluate(async (maxPower: number) => {
        const el = document.querySelector("power-flow-arrows") as any;
        const width = () => (el.shadowRoot.querySelector(".animated-arrow") as HTMLElement).style.width;
        const before = width();

        // The same node object, twice the power: exactly what a tick does.
        el.devices[0].powerValue = maxPower / 2;
        await el.updateComplete;
        const untold = width();

        el.historyRevision = 1;
        await el.updateComplete;
        return { before, untold, told: width() };
    }, MAX_POWER);

    expect(widths.untold).toBe(widths.before);
    expect(widths.told).not.toBe(widths.before);
});

test("repeated mount and unmount leaves no listener or observer behind", async ({ page }) => {
    await mountArrows(page, [MAX_POWER / 2]);

    const leftovers = await page.evaluate(async () => {
        const counters = { listeners: 0, observers: 0 };
        const add = document.addEventListener.bind(document);
        const remove = document.removeEventListener.bind(document);
        document.addEventListener = (type: string, ...rest: any[]) => {
            if (type === "visibilitychange") counters.listeners += 1;
            return (add as any)(type, ...rest);
        };
        document.removeEventListener = (type: string, ...rest: any[]) => {
            if (type === "visibilitychange") counters.listeners -= 1;
            return (remove as any)(type, ...rest);
        };
        const NativeObserver = window.IntersectionObserver;
        class CountingObserver extends NativeObserver {
            constructor(...args: ConstructorParameters<typeof IntersectionObserver>) {
                super(...args);
                counters.observers += 1;
            }
            disconnect() {
                counters.observers -= 1;
                super.disconnect();
            }
        }
        (window as any).IntersectionObserver = CountingObserver;

        // A fresh element, so the counters see its whole life from its first mount.
        const stage = document.getElementById("stage")!;
        const arrows = document.createElement("power-flow-arrows") as any;
        arrows.devices = [{ powerValue: 1000 }];
        for (let i = 0; i < 5; i++) {
            stage.appendChild(arrows);
            await arrows.updateComplete;
            arrows.remove();
        }
        return counters;
    });

    expect(leftovers).toEqual({ listeners: 0, observers: 0 });
});
