import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * What the flow arrows are allowed to cost while nobody is looking at them.
 *
 * The strips animate forever, so the animation is paused whenever the element
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

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

/** A 3-phase 25 A house, so the widths below are a readable fraction of it. */
const MAX_POWER = 25 * 230 * 3;

/** A page tall enough to scroll the arrows completely out of the viewport. */
const PAGE = `<!doctype html><html><body style="margin:0">
<div id="stage"></div>
<div id="spacer" style="height:4000px"></div>
</body></html>`;

async function mountArrows(page: Page, powers: (number | null)[]): Promise<void> {
    await page.setContent(PAGE);
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("power-flow-arrows"));
    await page.evaluate(async (opts) => {
        const el = document.createElement("power-flow-arrows") as any;
        el.devices = opts.powers.map((p) => (p === null ? undefined : { powerValue: p }));
        el.maxPower = opts.maxPower;
        document.getElementById("stage")!.appendChild(el);
        await el.updateComplete;
    }, { powers, maxPower: MAX_POWER });
}

/** The play states of every strip animation, deduplicated. */
function playStates(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const root = document.querySelector("power-flow-arrows")!.shadowRoot!;
        const states = [...root.querySelectorAll(".strip")]
            .flatMap((strip) => strip.getAnimations().map((a) => a.playState));
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
