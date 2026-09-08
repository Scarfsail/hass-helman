import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

import { installFakeHass } from "./support/fake-hass";
import { FIXED_NOW_ISO } from "./support/fixed-clock";

/**
 * What the wall clock is allowed to cost.
 *
 * Every surface that marks "now" owns a coarse timer, because `hass` churn is
 * not a clock. That timer used to be the most expensive idle thing on the page:
 * it wrote reactive state unconditionally, so a card sitting on a past day or
 * on a month of totals — neither of which marks a moment anywhere — re-rendered
 * its whole stack twice a minute, and the schedule host rebuilt its forecast
 * map, its day view, its lanes and its days to arrive at exactly what was
 * already there.
 *
 * These pin the three rules that replaced that. The clock only writes state
 * something on screen is reading; the derived model moves on slot boundaries
 * rather than on the marker's resolution; and while the page is hidden the
 * timer does not run at all, with the return catching up in one step.
 *
 * The page's timers are faked here, so every wait polls from Node —
 * `page.waitForFunction` would poll inside the page, on the timers the test
 * just took away.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

/** Days the inspector offers, counting today as day 0. */
const PILL_DAYS = 4;

/** Comfortably more than one tick of the coarse clock, and well inside a slot. */
const TICK_SPAN_MS = 90_000;

async function mountInspector(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await installFakeHass(page, { pillDays: PILL_DAYS, fakeTimers: true });
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await expect.poll(() => page.evaluate(
        () => !!customElements.get("helman-solar-inspector"),
    )).toBe(true);

    await page.evaluate(() => {
        const el = document.createElement("helman-solar-inspector") as HTMLElement &
            Record<string, unknown>;
        el.hass = window.__fakeHass;
        document.body.appendChild(el);
    });

    await expect.poll(() => page.evaluate(() => window.__pendingInspector())).toBe(1);
    await page.evaluate(() => window.__releaseInspector());
    await expect.poll(() => page.evaluate(() => !!document
        .querySelector("helman-solar-inspector")?.shadowRoot?.querySelector(".chart-wrap")))
        .toBe(true);
}

/** The card's own coarse clock, whatever the page's says. */
function cardNowMs(page: Page): Promise<number> {
    return page.evaluate(() =>
        (document.querySelector("helman-solar-inspector") as any)._nowMs as number);
}

/** Open the picker and take the last day before today out of the month. */
async function selectPreviousDay(page: Page): Promise<void> {
    await page.evaluate(() => {
        const root = document.querySelector("helman-solar-inspector")?.shadowRoot;
        (root?.querySelector(".nav-more") as HTMLButtonElement | undefined)?.click();
    });
    await page.evaluate(() => {
        const today = new Date().toISOString().slice(0, 10);
        const pills = document.querySelector("helman-solar-inspector")?.shadowRoot
            ?.querySelector("helman-solar-day-pills")?.shadowRoot;
        const days = [...(pills?.querySelectorAll(".pill") ?? [])];
        const other = days.filter((pill) => (pill.getAttribute("data-day") ?? "") < today).pop();
        (other as HTMLButtonElement | undefined)?.click();
    });
    await expect.poll(() => page.evaluate(() => window.__pendingInspector())).toBe(1);
    await page.evaluate(() => window.__releaseInspector());
    await expect.poll(() => page.evaluate(() =>
        (document.querySelector("helman-solar-inspector") as any)._payload?.date
        !== new Date().toISOString().slice(0, 10))).toBe(true);
}

/** Report the page as hidden or visible, the way a backgrounded tab does. */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
    await page.evaluate((value: boolean) => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
        document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
}

test.describe("the inspector's clock", () => {
    test("today's marker moves with it", async ({ page }) => {
        await mountInspector(page);
        const before = await cardNowMs(page);

        await page.clock.runFor(TICK_SPAN_MS);

        expect(await cardNowMs(page)).toBeGreaterThanOrEqual(before + TICK_SPAN_MS - 30_000);
    });

    test("a past day marks no moment, so the clock writes no state", async ({ page }) => {
        await mountInspector(page);
        await selectPreviousDay(page);
        const before = await cardNowMs(page);

        await page.clock.runFor(TICK_SPAN_MS);

        // Nothing on screen reads it: there is no "now" line on a day that has
        // finished, and the day has not rolled over.
        expect(await cardNowMs(page)).toBe(before);
    });

    test("a hidden page stops the clock, and coming back catches it up in one step", async ({ page }) => {
        await mountInspector(page);
        const before = await cardNowMs(page);

        await setHidden(page, true);
        await page.clock.runFor(5 * 60_000);
        expect(await cardNowMs(page)).toBe(before);

        // Back on screen, and current immediately rather than up to half a
        // minute after the reader looked at it.
        await setHidden(page, false);
        expect(await cardNowMs(page)).toBeGreaterThanOrEqual(before + 5 * 60_000);
    });
});

/**
 * The schedule host's day, and the clock it is allowed to move on.
 *
 * Everything derived here reads the clock as a slot-boundary test, so between
 * two boundaries the answer cannot change — which is what makes the periodic
 * rebuild pure waste. The band beside the dialog derives its lanes off these
 * getters, so the identities below are what a rebuild propagates through.
 */
test.describe("the schedule host's clock", () => {
    async function mountHost(page: Page): Promise<void> {
        await page.clock.install({ time: new Date(FIXED_NOW_ISO) });
        await page.setContent("<!doctype html><html><body></body></html>");
        await page.addScriptTag({ path: BUNDLE, type: "module" });
        await expect.poll(() => page.evaluate(
            () => !!customElements.get("scheduling-day-editor-host"),
        )).toBe(true);

        await page.evaluate(() => {
            const nowMs = Date.now();
            const dayStartMs = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`);
            const slots = Array.from({ length: 24 }, (_unused, hour) => {
                const startMs = dayStartMs + hour * 3_600_000;
                const running = startMs <= nowMs && nowMs < startMs + 3_600_000;
                return {
                    id: new Date(startMs).toISOString(),
                    controllables: running ? { boiler: { on: true, setBy: "user" } } : {},
                };
            });

            const hass = {
                language: "en",
                locale: { language: "en" },
                config: { time_zone: "UTC" },
                connection: {
                    sendMessagePromise: async () => {
                        throw new Error("no forecast in this fixture");
                    },
                },
                states: {
                    "switch.boiler": {
                        entity_id: "switch.boiler",
                        state: "on",
                        attributes: { friendly_name: "Boiler" },
                        last_changed: new Date(nowMs).toISOString(),
                    },
                },
                callWS: async (msg: { type: string }) => {
                    if (msg.type === "helman/get_schedule") {
                        return { executionEnabled: true, slots };
                    }
                    if (msg.type === "helman/get_appliances") {
                        return {
                            appliances: [{
                                id: "boiler",
                                name: "Boiler",
                                kind: "generic",
                                metadata: { icon: "mdi:flash", scheduleCapabilities: { onOffToggle: true } },
                                controls: { switch: { entityId: "switch.boiler" } },
                            }],
                        };
                    }
                    if (msg.type === "helman/get_controllable_entities") {
                        return {
                            entities: [{
                                kind: "generic",
                                name: "Boiler",
                                entityId: "switch.boiler",
                                normalState: "off",
                            }],
                        };
                    }
                    if (msg.type === "helman/get_entity_actual_history") {
                        return { entities: {} };
                    }
                    if (msg.type === "helman/get_appliance_projections") {
                        return { appliances: [] };
                    }
                    return {};
                },
            };

            const host = document.createElement("scheduling-day-editor-host") as any;
            host.hass = hass;
            host.timeZone = "UTC";
            host.preload = true;
            document.body.appendChild(host);
            (window as any).__host = host;
            (window as any).__modelChanges = 0;
            host.addEventListener("schedule-day-model-changed", () => {
                (window as any).__modelChanges += 1;
            });
        });

        await expect.poll(() => page.evaluate(
            () => ((window as any).__host.lanes as unknown[]).length,
        )).toBe(1);
    }

    /** Remember what the host derived, so the next call can compare identities. */
    async function markDerived(page: Page): Promise<void> {
        await page.evaluate(() => {
            const host = (window as any).__host;
            (window as any).__derived = {
                lanes: host.lanes,
                dayView: host.dayView,
                days: host.days,
                changes: (window as any).__modelChanges as number,
            };
        });
    }

    function derivedAgain(page: Page): Promise<{ rebuilt: boolean; announcements: number }> {
        return page.evaluate(() => {
            const host = (window as any).__host;
            const previous = (window as any).__derived;
            return {
                rebuilt: host.lanes !== previous.lanes
                    || host.dayView !== previous.dayView
                    || host.days !== previous.days,
                announcements: ((window as any).__modelChanges as number) - previous.changes,
            };
        });
    }

    test("a tick inside the running slot rebuilds nothing", async ({ page }) => {
        await mountHost(page);
        await markDerived(page);
        const clockSlotMs = await page.evaluate(() => (window as any).__host.clockSlotMs as number);

        await page.clock.runFor(TICK_SPAN_MS);

        // The marker's clock moved, so the band's "now" line still travels.
        expect(await page.evaluate(() => (window as any).__host.nowMs as number))
            .toBeGreaterThanOrEqual(Date.parse(FIXED_NOW_ISO) + TICK_SPAN_MS - 30_000);
        // The model's did not, so nothing behind it was rebuilt. The tick is
        // still announced -- the band reads `nowMs` through a getter and re-renders
        // only when this host says so, and its own keys then find nothing to
        // rebuild -- so the marker travels without the day being derived again.
        expect(await page.evaluate(() => (window as any).__host.clockSlotMs as number))
            .toBe(clockSlotMs);
        const after = await derivedAgain(page);
        expect(after.rebuilt).toBe(false);
        expect(after.announcements).toBeGreaterThan(0);
    });

    test("crossing a slot boundary rebuilds the day and says so", async ({ page }) => {
        await mountHost(page);
        await markDerived(page);
        const clockSlotMs = await page.evaluate(() => (window as any).__host.clockSlotMs as number);

        await page.clock.runFor(61 * 60_000);

        expect(await page.evaluate(() => (window as any).__host.clockSlotMs as number))
            .toBe(clockSlotMs + 3_600_000);
        const after = await derivedAgain(page);
        expect(after.rebuilt).toBe(true);
        expect(after.announcements).toBeGreaterThan(0);
    });

    test("a hidden page runs no clock, and returning catches up in one step", async ({ page }) => {
        await mountHost(page);
        await markDerived(page);
        const before = await page.evaluate(() => (window as any).__host.nowMs as number);

        await setHidden(page, true);
        // Ten ticks' worth, inside the running slot: nothing moves and nothing
        // is derived. Longer than a slot would prove less, not more -- the
        // schedule owner refreshes on its own boundary timer, and that is a
        // data refresh rather than clock work.
        await page.clock.runFor(5 * 60_000);
        expect(await page.evaluate(() => (window as any).__host.nowMs as number)).toBe(before);
        // No tick at all while hidden, so not even the marker's announcement.
        expect(await derivedAgain(page)).toEqual({ rebuilt: false, announcements: 0 });

        await setHidden(page, false);
        expect(await page.evaluate(() => (window as any).__host.nowMs as number))
            .toBeGreaterThanOrEqual(before + 5 * 60_000);
    });
});
