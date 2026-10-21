import { test, expect, type Page } from "@playwright/test";

import { installFakeHass } from "./support/mock-hass";
import { FIXED_NOW_ISO } from "./support/fixed-clock";
import { CARD_BUNDLE, loadBundle } from "./support/card-page";
import { scheduleSlots } from "./support/payload-builders";

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

/** Days the inspector offers, counting today as day 0. */
const PILL_DAYS = 4;

/** Comfortably more than one tick of the coarse clock, and well inside a slot. */
const TICK_SPAN_MS = 90_000;

async function mountInspector(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await installFakeHass(page, { pillDays: PILL_DAYS, fakeTimers: true });
    await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
    await expect.poll(() => page.evaluate(
        () => !!customElements.get("helman-solar-inspector"),
    )).toBe(true);

    await page.evaluate(() => {
        const el = document.createElement("helman-solar-inspector") as unknown as HTMLElement &
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
        // The shared schedule owner ticks too. Its snapshot did not move, nor did
        // the slot it normalizes on, so neither object the card holds in a
        // `@state` -- nor the one it hands the pills -- may either.
        await page.evaluate(() => {
            const inspector = document.querySelector("helman-solar-inspector") as any;
            const pills = inspector.shadowRoot.querySelector("helman-solar-day-pills");
            (window as any).__snapshotsBefore = [inspector._scheduleSnapshot, pills.normalizedSchedule];
        });

        await page.clock.runFor(TICK_SPAN_MS);

        // Nothing on screen reads it: there is no "now" line on a day that has
        // finished, and the day has not rolled over.
        expect(await cardNowMs(page)).toBe(before);
        expect(await page.evaluate(() => {
            const inspector = document.querySelector("helman-solar-inspector") as any;
            const pills = inspector.shadowRoot.querySelector("helman-solar-day-pills");
            const [inspectorBefore, pillsBefore] = (window as any).__snapshotsBefore;
            return inspector._scheduleSnapshot === inspectorBefore && pills.normalizedSchedule === pillsBefore;
        })).toBe(true);
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
    async function mountHost(page: Page, nowIso = FIXED_NOW_ISO): Promise<void> {
        await page.clock.install({ time: new Date(nowIso) });
        await loadBundle(page, "scheduling-day-editor-host");

        const nowMs = Date.parse(nowIso);
        const dayStartMs = Date.parse(`${nowIso.slice(0, 10)}T00:00:00Z`);
        const schedule = scheduleSlots({ slotMinutes: 60, start: new Date(dayStartMs).toISOString(), count: 24 });
        const running = schedule.slots.find((slot) => Date.parse(slot.id) <= nowMs && nowMs < Date.parse(slot.id) + 3_600_000);
        if (running) running.controllables = { boiler: { on: true, setBy: "user" } };
        await page.evaluate((schedule) => {
            const nowMs = Date.now();

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
                callWS: window.__mockHass({
                    "helman/get_schedule": async (msg: {
                        type: string;
                    }) => {
                        return schedule;
                    },
                    "helman/get_appliances": async (msg: {
                        type: string;
                    }) => {
                        return {
                            appliances: [{
                                    id: "boiler",
                                    name: "Boiler",
                                    kind: "generic",
                                    primaryEntityId: "switch.boiler",
                                    supportsAuthoring: true,
                                    normalState: "off",
                                    metadata: { icon: "mdi:flash", scheduleCapabilities: { onOffToggle: true } },
                                    controls: { switch: { entityId: "switch.boiler" } },
                                }],
                        };
                    },
                    "helman/get_entity_actual_history": async (msg: {
                        type: string;
                    }) => {
                        return { entities: {} };
                    },
                    "helman/get_appliance_projections": async (msg: {
                        type: string;
                    }) => {
                        return { appliances: [] };
                    }
                }).callWS,
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
        }, schedule);

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

    test("a boundary refresh uses the new slot before the next coarse tick", async ({ page }) => {
        await mountHost(page, "2026-10-21T12:59:45.000Z");
        const nextSlotId = "2026-10-21T13:00:00.000Z";
        expect(await page.evaluate(() => (window as any).__host._normalized.currentSlotId))
            .toBe("2026-10-21T12:00:00.000Z");

        // The owner's boundary timer fires at 13:00:00.050; its 30 s clock
        // will not tick until 13:00:15.
        await page.clock.runFor(15_100);

        await expect.poll(() => page.evaluate(
            () => (window as any).__host._normalized.currentSlotId,
        )).toBe(nextSlotId);
        expect(await page.evaluate(() => (window as any).__host.nowMs as number))
            .toBeLessThan(Date.parse("2026-10-21T13:00:15.000Z"));
    });

    test("a consumer mounted after a boundary starts in the current slot", async ({ page }) => {
        await mountHost(page, "2026-10-21T12:59:45.000Z");

        // Mount before the boundary refresh and the next 30 s tick.
        await page.clock.runFor(15_010);
        await page.evaluate(() => {
            const first = (window as any).__host;
            const second = document.createElement("scheduling-day-editor-host") as any;
            second.hass = first.hass;
            second.timeZone = "UTC";
            second.preload = true;
            document.body.appendChild(second);
            (window as any).__secondHost = second;
        });

        await expect.poll(() => page.evaluate(
            () => (window as any).__secondHost._normalized.currentSlotId,
        )).toBe("2026-10-21T13:00:00.000Z");
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
