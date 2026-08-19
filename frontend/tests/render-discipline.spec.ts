import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { installFakeHass } from "./support/fake-hass";

/**
 * The regression guard for `frontend/cards/README.md`, "Card rendering
 * discipline".
 *
 * Home Assistant replaces the `hass` object on every state change anywhere in
 * the house — measured on this installation at 17-24 times a second. Lit
 * re-renders on identity. A card that treats a new `hass` as a change signal,
 * or that hands a child a freshly-allocated value whose meaning did not change,
 * re-renders its whole subtree at that rate forever. That was 60-69 % of all
 * browser CPU (#56).
 *
 * ## Why these are hard assertions and not thresholds
 *
 * Both tests state the rule with an exact expected value — `0` renders, the
 * *same object* — rather than a measured constant. A "renders ≤ N" gate is a
 * measurement dressed up as a rule: it drifts with unrelated feature work, it
 * goes red when the machine is busy, and the cheapest way to make it green
 * again is to raise N, which silently retires the guard.
 *
 * `0` and `same object` cannot be satisfied by a busy machine or broken by an
 * unrelated feature. **If either of these fails, the rule was violated — the
 * fix is in the card, never in this file.** Do not turn a value here into a
 * range, a ratio or a tolerance.
 *
 * ## Why the bare page rather than `frontend/perf/`
 *
 * `frontend/perf/` drives a real Home Assistant and stays a measuring
 * instrument, not a gate. The guard needs total control over what differs
 * between two `hass` objects, which a real HA by definition cannot give — it
 * replaces `states` underneath. The counters are still the real ones:
 * `perf/perf-init.js` and `perf/perf-instrument.js` are loaded verbatim, so the
 * guard and the #56 measurements agree by construction.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);
const PERF_INIT = resolve(__dirname, "../perf/perf-init.js");
const PERF_INSTRUMENT = resolve(__dirname, "../perf/perf-instrument.js");

/** Days the inspector offers, counting today as day 0. */
const PILL_DAYS = 4;

/** The tags whose re-renders assertion A pins to zero. */
const WATCHED_TAGS = [
    "helman-solar-inspector-card",
    "helman-solar-inspector",
    "helman-solar-day-pills",
    "helman-solar-schedule-band-strip",
    "helman-solar-price-strip",
] as const;

declare global {
    interface Window {
        /** From `perf/perf-instrument.js`. */
        __perfReset: () => void;
        __perfSnapshot: () => {
            el: Record<string, { updates: number; renders: number }>;
        };
        __perfCountInstances: () => Record<string, number>;
        /** The inspector's shadow root, two shadow roots deep inside the card. */
        __inspectorRoot: () => ShadowRoot | null | undefined;
    }
}

/**
 * Mount `helman-solar-inspector-card` — the card, not the inspector element,
 * because the `hass` filter lives in the card's setter — with the real perf
 * counters wrapped around it.
 *
 * Order matters: `perf-init.js` installs `window.__perf` before any page script
 * runs, and `perf-instrument.js` must run *after* the bundle, because it wraps
 * the prototypes it finds through `customElements.get`.
 */
async function mountCard(page: Page): Promise<void> {
    await page.addInitScript({ path: PERF_INIT });
    // `setContent` rewrites the current document rather than navigating, and an
    // init script only runs on a navigation — so make one, or `window.__perf`
    // never exists and the instrument has nothing to fill in.
    await page.goto("about:blank");
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-inspector-card"));
    await page.addScriptTag({ path: PERF_INSTRUMENT });
    await installFakeHass(page, { pillDays: PILL_DAYS });

    await page.evaluate(() => {
        window.__inspectorRoot = () =>
            document.querySelector("helman-solar-inspector-card")
                ?.shadowRoot?.querySelector("helman-solar-inspector")?.shadowRoot;

        const card = document.createElement("helman-solar-inspector-card") as HTMLElement &
            Record<string, unknown> & { setConfig: (config: unknown) => void };
        card.setConfig({ type: "custom:helman-solar-inspector-card" });
        card.hass = window.__fakeHass;
        document.body.appendChild(card);
    });

    await page.waitForFunction(() => window.__pendingInspector() === 1);
    await page.evaluate(() => window.__releaseInspector());
    await expect.poll(() => hasChart(page)).toBe(true);
    await settle(page);
}

function hasChart(page: Page): Promise<boolean> {
    return page.evaluate(
        () => !!window.__inspectorRoot()?.querySelector(".chart-wrap"),
    );
}

/**
 * Let every load the mount kicked off land and every scheduled update flush.
 *
 * The band strip's entity roster, the day aggregates and the forecast all
 * arrive after the first chart, and each is a legitimate render. The guard is
 * about what happens *afterwards*, so it must not start counting in the middle
 * of the opening sequence.
 */
async function settle(page: Page): Promise<void> {
    await page.waitForTimeout(500);
    await page.evaluate(
        () => new Promise<void>((done) => requestAnimationFrame(() => done())),
    );
}

function updateCounts(page: Page): Promise<Record<string, number>> {
    return page.evaluate((tags) => {
        const el = window.__perfSnapshot().el;
        const out: Record<string, number> = {};
        for (const tag of tags) out[tag] = el[tag]?.updates ?? 0;
        return out;
    }, WATCHED_TAGS as unknown as string[]);
}

test("an idle hass replacement re-renders nothing", async ({ page }) => {
    await mountCard(page);

    // Every tag the assertion covers is actually on screen — a zero for an
    // element that was never mounted proves nothing.
    const instances = await page.evaluate(() => window.__perfCountInstances());
    for (const tag of WATCHED_TAGS) {
        expect(instances[tag], `${tag} must be mounted for this test to mean anything`)
            .toBeGreaterThan(0);
    }

    const before = await page.evaluate(() => ({
        requestedDates: window.__requestedDates.length,
        forecastCalls: window.__forecastCalls,
    }));

    await page.evaluate(() => window.__perfReset());

    // Twenty replacements of exactly the kind Home Assistant pushes 17-24 times
    // a second: a new object, every field the cards read identical — the same
    // `connection`, `states`, `config` and `language`/`locale.language`, which
    // is all four fields `hassContextChanged` compares.
    await page.evaluate(async () => {
        const card = document.querySelector("helman-solar-inspector-card") as HTMLElement &
            Record<string, unknown>;
        for (let i = 0; i < 20; i += 1) {
            card.hass = { ...window.__fakeHass };
            // A frame between pushes, so each replacement is its own chance to
            // render. Twenty assignments in one turn would be coalesced by Lit
            // into a single update and would under-report a broken filter by
            // a factor of twenty.
            await new Promise((frame) => requestAnimationFrame(frame));
        }
    });
    await settle(page);

    // Hard zero. See the header: this is the rule, not a budget.
    expect(await updateCounts(page)).toEqual({
        "helman-solar-inspector-card": 0,
        "helman-solar-inspector": 0,
        "helman-solar-day-pills": 0,
        "helman-solar-schedule-band-strip": 0,
        "helman-solar-price-strip": 0,
    });

    // And nothing reloaded either (#61): a filtered `hass` must not re-enter any
    // loader, so neither the inspector day nor the forecast was fetched again.
    expect(await page.evaluate(() => ({
        requestedDates: window.__requestedDates.length,
        forecastCalls: window.__forecastCalls,
    }))).toEqual(before);
});

test("a re-render for an unrelated reason does not hand the pills a new historyDays", async ({ page }) => {
    await mountCard(page);

    // Page back a week, so the pills carry measured days and `historyDays` is a
    // built array rather than the shared empty constant — an identity that
    // could plausibly churn is the only one worth pinning.
    await page.evaluate(() => {
        const arrows = window.__inspectorRoot()?.querySelectorAll(".week-arrow");
        (arrows?.[0] as HTMLButtonElement | undefined)?.click();
    });
    await page.waitForFunction(() => window.__pendingInspector() === 1);
    await page.evaluate(() => window.__releaseInspector());
    await expect.poll(() => hasChart(page)).toBe(true);
    await settle(page);

    const carriesDays = await page.evaluate(() => {
        const pills = window.__inspectorRoot()?.querySelector("helman-solar-day-pills") as
            (HTMLElement & { historyDays: readonly unknown[] }) | null;
        (window as unknown as Record<string, unknown>).__historyDaysBefore = pills?.historyDays;
        return (pills?.historyDays.length ?? 0) > 0;
    });
    expect(carriesDays, "the pills must carry measured days for this test to mean anything")
        .toBe(true);

    await page.evaluate(() => window.__perfReset());

    // One legitimate render, for a reason that has nothing to do with the day
    // window: the daylight-only toggle — the only `.icon-button` that reports a
    // pressed state.
    await page.evaluate(() => {
        const button = window.__inspectorRoot()?.querySelector(".icon-button[aria-pressed]");
        (button as HTMLButtonElement | null)?.click();
    });
    await settle(page);

    const result = await page.evaluate(() => {
        const pills = window.__inspectorRoot()?.querySelector("helman-solar-day-pills") as
            (HTMLElement & { historyDays: readonly unknown[] }) | null;
        const before = (window as unknown as Record<string, unknown>).__historyDaysBefore;
        return {
            inspectorRendered: window.__perfSnapshot().el["helman-solar-inspector"]?.updates ?? 0,
            sameHistoryDays: pills?.historyDays === before,
        };
    });

    // The render really happened — otherwise "unchanged" would be vacuous.
    expect(result.inspectorRendered).toBeGreaterThan(0);
    // Hard identity. `_loadDayAggregates()` assigning `this._historyDays` from
    // inside `render()` is what made the pills' model memo structurally
    // incapable of ever hitting, at 69 % of all browser CPU (#56 finding 1).
    // The fix is that the day window, not the render, decides when this array
    // is rebuilt — so the correct expectation is the same object, forever.
    expect(result.sameHistoryDays).toBe(true);
});
