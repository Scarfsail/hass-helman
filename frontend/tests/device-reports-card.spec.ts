import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

import { FIXED_NOW_ISO, installFixedClock } from "./support/fixed-clock";

/**
 * `helman-device-reports-card` against a fake backend.
 *
 * `helman/device_report` is answered from a fixture generated in the page, so
 * what the card asked for -- and how often -- is what these tests assert on.
 * The shell owns the period, the fetching and the freshness; the Ranking
 * report only renders. Specs that are about the clock fake the page's timers
 * and poll from Node, since `page.waitForFunction` would poll on the very
 * timers it took away.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const FIVE_MINUTES = 5 * 60_000;

interface FakeOptions {
    timeZone?: string;
    complete?: boolean;
    unavailable?: string | null;
    /** Hold every report request until the test releases it. */
    hold?: boolean;
    /** Fake the page's timers from this instant rather than freezing the date. */
    fakeTimersAt?: string;
    meters?: { grid: boolean; solar: boolean; battery: boolean; house: boolean };
    ambiguousKwh?: number;
    /** Every report request fails. */
    fail?: boolean;
    /** How far the backend's clock runs behind the browser's. */
    serverLagMs?: number;
}

declare global {
    interface Window {
        __reportRequests: Array<{ report: string; start: string; end: string }>;
        __releaseReport: (index: number) => void;
        __shellRoot: () => ShadowRoot | null | undefined;
        __rankingRoot: () => ShadowRoot | null | undefined;
        __fakeHass: Record<string, unknown>;
        __updates: Record<string, number>;
    }
}

async function mountCard(page: Page, options: FakeOptions = {}): Promise<void> {
    if (options.fakeTimersAt) {
        await page.clock.install({ time: new Date(options.fakeTimersAt) });
    } else {
        await installFixedClock(page);
    }
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await expect.poll(() => page.evaluate(
        () => !!customElements.get("helman-device-reports-card"),
    )).toBe(true);

    await page.evaluate((opts: FakeOptions) => {
        const node = (fields: Record<string, unknown>) => ({
            parent_id: "house",
            depth: 1,
            icon: null,
            estimated: false,
            unmeasured: false,
            children: [],
            coverage: 1,
            first_hour: "2026-09-01T00:00:00+00:00",
            overallocated_kwh: 0,
            sources: { solar: 0, battery: 0, grid: 0, unattributed: 0 },
            ...fields,
        });
        const money = (
            paid: number | null,
            forgone: number | null,
            kwh: number,
            unpriced = 0,
            tariff = 0,
        ) => ({
            paid: { amount: paid, priced_kwh: kwh - unpriced, unpriced_kwh: unpriced, tariff_kwh: tariff },
            forgone: { amount: forgone, priced_kwh: kwh, unpriced_kwh: 0 },
        });
        const payload = (start: string, end: string) => ({
            report: "ranking",
            start_date: start,
            end_date: end,
            currency: "CZK",
            charge_origin: {
                charged_kwh: 10, grid: 0.5, grid_recorded: 0.5, grid_tariff: 0, grid_unpriced: 0,
                solar: 0.5, solar_priced: 0.5, solar_unpriced: 0, unknown: 0,
                paid_rate: 3, forgone_rate: 1,
            },
            house_kwh: 100,
            ambiguous_kwh: opts.ambiguousKwh ?? 0,
            unattributed_kwh: 0,
            mismatch_kwh: 0,
            meters: opts.meters ?? { grid: true, solar: true, battery: true, house: true },
            as_of: new Date(Date.now() - (opts.serverLagMs ?? 0)).toISOString(),
            complete: opts.complete ?? false,
            range: { minDate: "2026-01-01", maxDate: end },
            nodes: [
                node({
                    id: "house", parent_id: null, depth: 0, label: "", kwh: 100,
                    children: ["sensor.washer", "sensor.breaker", "sensor.fridge", "house_unmeasured"],
                    sources: { solar: 40, battery: 20, grid: 35, unattributed: 5 },
                    money: money(30, 8, 100),
                }),
                node({
                    id: "sensor.washer", label: "Washer " + start + ".." + end, kwh: 30,
                    sources: { solar: 10, battery: 5, grid: 15, unattributed: 0 },
                    money: money(12, 3, 30),
                }),
                node({
                    id: "sensor.breaker", label: "Breaker", kwh: 20, overallocated_kwh: 2,
                    children: ["heater", "sensor_breaker_unmeasured"],
                    sources: { solar: 10, battery: 0, grid: 10, unattributed: 0 },
                    money: money(2, -1.5, 20),
                }),
                node({
                    id: "heater", parent_id: "sensor.breaker", depth: 2, label: "Heater",
                    estimated: true, kwh: 5, money: money(1, 0, 5),
                }),
                node({
                    id: "sensor_breaker_unmeasured", parent_id: "sensor.breaker", depth: 2,
                    label: "", unmeasured: true, kwh: 17, money: money(1, 0, 17),
                }),
                node({
                    id: "sensor.fridge", label: "Fridge", kwh: 10, coverage: 0.5,
                    first_hour: "2026-10-07T00:00:00+00:00",
                    sources: { solar: 0, battery: 0, grid: 10, unattributed: 0 },
                    money: money(15, 0, 10, 2, 1),
                }),
                node({
                    id: "house_unmeasured", label: "", unmeasured: true, kwh: 40,
                    money: money(1, 0, 40),
                }),
            ],
        });

        const pending: Array<(() => void) | null> = [];
        window.__reportRequests = [];
        window.__releaseReport = (index: number) => {
            pending[index]?.();
            pending[index] = null;
        };
        window.__fakeHass = {
            language: "en",
            locale: { language: "en" },
            config: { time_zone: opts.timeZone ?? "UTC" },
            connection: {},
            states: {},
            callWS: async (msg: { type: string; report: string; start_date: string; end_date: string }) => {
                if (msg.type !== "helman/device_report") return {};
                window.__reportRequests.push({
                    report: msg.report, start: msg.start_date, end: msg.end_date,
                });
                if (opts.fail) throw new Error("boom");
                const answer = () => opts.unavailable
                    ? { unavailable: opts.unavailable }
                    : payload(msg.start_date, msg.end_date);
                if (!opts.hold) return answer();
                return new Promise((resolveAnswer) => {
                    pending.push(() => resolveAnswer(answer()));
                });
            },
        };

        window.__shellRoot = () => document.querySelector("helman-device-reports-card")
            ?.shadowRoot?.querySelector("helman-device-report-shell")?.shadowRoot;
        window.__rankingRoot = () => window.__shellRoot()
            ?.querySelector("helman-device-report-ranking")?.shadowRoot;

        const card = document.createElement("helman-device-reports-card") as HTMLElement &
            Record<string, unknown> & { setConfig: (config: unknown) => void };
        card.setConfig({ type: "custom:helman-device-reports-card" });
        card.hass = window.__fakeHass;
        document.body.appendChild(card);
    }, options);
}

function requests(page: Page) {
    return page.evaluate(() => window.__reportRequests);
}

function requestCount(page: Page) {
    return page.evaluate(() => window.__reportRequests.length);
}

async function clickPreset(page: Page, preset: string): Promise<void> {
    await page.evaluate((name: string) => {
        (window.__shellRoot()?.querySelector("button[data-preset='" + name + "']") as HTMLButtonElement).click();
    }, preset);
}

function rowIds(page: Page) {
    return page.evaluate(() => [...(window.__rankingRoot()?.querySelectorAll(".row") ?? [])]
        .map((row) => (row as HTMLElement).dataset.id));
}

function rankingText(page: Page, selector: string) {
    return page.evaluate((sel: string) => window.__rankingRoot()?.querySelector(sel)?.textContent ?? null, selector);
}

async function rendered(page: Page): Promise<void> {
    await expect.poll(() => page.evaluate(() => !!window.__rankingRoot()?.querySelector(".row"))).toBe(true);
}

async function setHidden(page: Page, hidden: boolean): Promise<void> {
    await page.evaluate((value: boolean) => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
        document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
}

test.describe("the period and fetching", () => {
    test("the default is the last 30 days in Home Assistant's time zone", async ({ page }) => {
        // 12:00 UTC is already the next day at UTC+14.
        await mountCard(page, { timeZone: "Pacific/Kiritimati" });
        await expect.poll(() => requests(page)).toEqual([
            { report: "ranking", start: "2026-09-23", end: "2026-10-22" },
        ]);
    });

    test("switching a preset refetches with its dates", async ({ page }) => {
        await mountCard(page);
        await rendered(page);
        await clickPreset(page, "last_7");
        await expect.poll(() => requests(page)).toEqual([
            { report: "ranking", start: "2026-09-22", end: "2026-10-21" },
            { report: "ranking", start: "2026-10-15", end: "2026-10-21" },
        ]);
        await clickPreset(page, "last_month");
        await expect.poll(() => requestCount(page)).toBe(3);
        expect((await requests(page))[2]).toEqual(
            { report: "ranking", start: "2026-09-01", end: "2026-09-30" },
        );
    });

    test("a complete payload is served from the memo", async ({ page }) => {
        await mountCard(page, { complete: true, fakeTimersAt: FIXED_NOW_ISO });
        await expect.poll(() => requestCount(page)).toBe(1);
        await clickPreset(page, "last_7");
        await expect.poll(() => requestCount(page)).toBe(2);
        await clickPreset(page, "last_30");
        await page.clock.runFor(2 * FIVE_MINUTES);
        expect(await requestCount(page)).toBe(2);
    });

    test("an incomplete payload is refetched once five minutes old", async ({ page }) => {
        await mountCard(page, { fakeTimersAt: FIXED_NOW_ISO });
        await expect.poll(() => requestCount(page)).toBe(1);
        await page.clock.runFor(FIVE_MINUTES - 60_000);
        expect(await requestCount(page)).toBe(1);
        await page.clock.runFor(2 * 60_000);
        await expect.poll(() => requestCount(page)).toBe(2);
        const [first, second] = await requests(page);
        expect(second).toEqual(first);
    });

    test("an expired payload is not refetched while the page is hidden", async ({ page }) => {
        await mountCard(page, { fakeTimersAt: FIXED_NOW_ISO });
        await expect.poll(() => requestCount(page)).toBe(1);
        await setHidden(page, true);
        await page.clock.runFor(3 * FIVE_MINUTES);
        expect(await requestCount(page)).toBe(1);
        await setHidden(page, false);
        await expect.poll(() => requestCount(page)).toBe(2);
    });

    test("a payload fetched at 23:58 is refetched after midnight though its period has closed", async ({ page }) => {
        await mountCard(page, { fakeTimersAt: "2026-10-21T23:58:00.000Z" });
        await expect.poll(() => requestCount(page)).toBe(1);
        // A custom range with the same dates: it does not roll at midnight, so
        // the only thing that can refetch it is its expiry.
        await clickPreset(page, "custom");
        await page.clock.runFor(60_000);
        expect(await requestCount(page)).toBe(1);
        await page.clock.runFor(FIVE_MINUTES);
        await expect.poll(() => requestCount(page)).toBe(2);
        expect((await requests(page))[1]).toEqual(
            { report: "ranking", start: "2026-09-22", end: "2026-10-21" },
        );
    });

    test("the rolling preset moves at midnight", async ({ page }) => {
        await mountCard(page, { complete: true, fakeTimersAt: "2026-10-21T23:58:00.000Z" });
        await expect.poll(() => requestCount(page)).toBe(1);
        await page.clock.runFor(3 * 60_000);
        await expect.poll(() => requestCount(page)).toBe(2);
        expect((await requests(page))[1]).toEqual(
            { report: "ranking", start: "2026-09-23", end: "2026-10-22" },
        );
    });

    test("a stale response is discarded", async ({ page }) => {
        await mountCard(page, { hold: true });
        await expect.poll(() => requestCount(page)).toBe(1);
        expect(await page.evaluate(() => !!window.__shellRoot()?.querySelector(".loading"))).toBe(true);
        await clickPreset(page, "last_7");
        await expect.poll(() => requestCount(page)).toBe(2);

        await page.evaluate(() => window.__releaseReport(1));
        await expect.poll(() => rankingText(page, ".row[data-id='sensor.washer'] .label"))
            .toContain("2026-10-15..2026-10-21");
        await page.evaluate(() => window.__releaseReport(0));
        await page.waitForTimeout(100);
        expect(await rankingText(page, ".row[data-id='sensor.washer'] .label"))
            .toContain("2026-10-15..2026-10-21");

        // Not shown, but kept for its own query: going back does not refetch it.
        await clickPreset(page, "last_30");
        await expect.poll(() => rankingText(page, ".row[data-id='sensor.washer'] .label"))
            .toContain("2026-09-22..2026-10-21");
        expect(await requestCount(page)).toBe(2);
    });

    test("a failed fetch is retried once five minutes old, not on every tick", async ({ page }) => {
        await mountCard(page, { fail: true, fakeTimersAt: FIXED_NOW_ISO });
        await expect.poll(() => requestCount(page)).toBe(1);
        await page.clock.runFor(FIVE_MINUTES - 60_000);
        expect(await requestCount(page)).toBe(1);
        await page.clock.runFor(2 * 60_000);
        await expect.poll(() => requestCount(page)).toBe(2);
    });

    test("a backend clock behind the browser's does not expire a fresh payload", async ({ page }) => {
        await mountCard(page, { serverLagMs: 2 * FIVE_MINUTES, fakeTimersAt: FIXED_NOW_ISO });
        await expect.poll(() => requestCount(page)).toBe(1);
        await page.clock.runFor(2 * 60_000);
        expect(await requestCount(page)).toBe(1);
    });

    test("as of is shown", async ({ page }) => {
        await mountCard(page);
        await rendered(page);
        expect(await page.evaluate(() => window.__shellRoot()?.querySelector(".as-of")?.textContent))
            .toBe("as of 12:00");
    });
});

test.describe("states and notes", () => {
    test("an unavailable report explains the missing setting", async ({ page }) => {
        await mountCard(page, { unavailable: "no_house_node" });
        await expect.poll(() => page.evaluate(
            () => window.__shellRoot()?.querySelector(".unavailable")?.textContent ?? "",
        )).toContain("house power sensor");
        expect(await page.evaluate(() => !!window.__shellRoot()?.querySelector("helman-device-report-ranking")))
            .toBe(false);
    });

    test("a missing meter warns and a data-quality figure is noted", async ({ page }) => {
        await mountCard(page, {
            meters: { grid: true, solar: false, battery: true, house: true },
            ambiguousKwh: 5,
        });
        await rendered(page);
        const notes = await page.evaluate(() => ({
            warning: window.__shellRoot()?.querySelector(".warning")?.textContent ?? "",
            ambiguous: window.__shellRoot()?.querySelector("[data-quality='ambiguous']")?.textContent ?? "",
            unattributed: !!window.__shellRoot()?.querySelector("[data-quality='unattributed']"),
        }));
        expect(notes.warning).toContain("solar meter");
        expect(notes.warning).not.toContain("battery");
        expect(notes.ambiguous).toContain("solar-first rule");
        expect(notes.unattributed).toBe(false);
    });
});

test.describe("the ranking", () => {
    test("rows are sorted with the house remainder last", async ({ page }) => {
        await mountCard(page);
        await rendered(page);
        expect(await rowIds(page)).toEqual([
            "house", "sensor.washer", "sensor.breaker", "sensor.fridge", "house_unmeasured",
        ]);
        expect(await rankingText(page, ".row[data-id='house_unmeasured'] .label"))
            .toContain("Untracked consumption");
    });

    test("the tree expands and collapses", async ({ page }) => {
        await mountCard(page);
        await rendered(page);
        const toggle = () => page.evaluate(() => (window.__rankingRoot()
            ?.querySelector(".row[data-id='sensor.breaker'] .toggle") as HTMLButtonElement).click());
        await toggle();
        await expect.poll(() => rowIds(page)).toEqual([
            "house", "sensor.washer", "sensor.breaker", "heater", "sensor_breaker_unmeasured",
            "sensor.fridge", "house_unmeasured",
        ]);
        expect(await rankingText(page, ".row[data-id='heater'] .label")).toContain("≈");
        await toggle();
        await expect.poll(() => rowIds(page)).toEqual([
            "house", "sensor.washer", "sensor.breaker", "sensor.fridge", "house_unmeasured",
        ]);
    });

    test("sort and show reorder and hide without a refetch", async ({ page }) => {
        await mountCard(page);
        await rendered(page);
        await page.evaluate(() => {
            const select = window.__rankingRoot()?.querySelector("select.sort") as HTMLSelectElement;
            select.value = "paid";
            select.dispatchEvent(new Event("change"));
        });
        await expect.poll(() => rowIds(page)).toEqual([
            "house", "sensor.fridge", "sensor.washer", "sensor.breaker", "house_unmeasured",
        ]);
        await page.evaluate(() => (window.__rankingRoot()
            ?.querySelector("button[data-show='money']") as HTMLButtonElement).click());
        await expect.poll(() => page.evaluate(() => ({
            energy: window.__rankingRoot()?.querySelectorAll(".track.energy").length,
            money: window.__rankingRoot()?.querySelectorAll(".track.money").length,
        }))).toEqual({ energy: 0, money: 5 });
        await page.evaluate(() => (window.__rankingRoot()
            ?.querySelector("button[data-show='energy']") as HTMLButtonElement).click());
        await expect.poll(() => page.evaluate(() => ({
            energy: window.__rankingRoot()?.querySelectorAll(".track.energy").length,
            money: window.__rankingRoot()?.querySelectorAll(".track.money").length,
        }))).toEqual({ energy: 5, money: 0 });
        expect(await requestCount(page)).toBe(1);
    });

    test("the over-allocation and coverage marks", async ({ page }) => {
        await mountCard(page);
        await rendered(page);
        expect(await rankingText(page, ".row[data-id='sensor.breaker'] .marks"))
            .toContain("children measure 2.0 kWh more than this meter");
        expect(await rankingText(page, ".row[data-id='sensor.fridge'] .marks"))
            .toContain("data for 50 % of the period (from 2026-10-07)");
        expect(await rankingText(page, ".row[data-id='sensor.washer'] .marks")).toBeNull();
    });

    test("a partial money figure is marked partial, without a bound", async ({ page }) => {
        await mountCard(page);
        await rendered(page);
        const fridge = await page.evaluate(() => {
            const row = window.__rankingRoot()?.querySelector(".row[data-id='sensor.fridge']");
            const paid = row?.querySelector(".money-figure.paid");
            return {
                text: row?.querySelector(".money-label")?.textContent ?? "",
                partialMark: !!paid?.querySelector(".partial-mark"),
                title: paid?.getAttribute("title") ?? "",
                hatched: !!row?.querySelector(".money-seg.paid.partial"),
                forgonePartial: !!row?.querySelector(".money-figure.forgone .partial-mark"),
            };
        });
        expect(fridge.partialMark).toBe(true);
        expect(fridge.hatched).toBe(true);
        expect(fridge.forgonePartial).toBe(false);
        expect(fridge.text).not.toMatch(/[≥≤]/);
        expect(fridge.title).toContain("priced 8.0 of 10 kWh");
        expect(fridge.title).toContain("1.0 kWh at today's configured tariff");
    });

    test("a negative forgone figure is drawn left of zero", async ({ page }) => {
        await mountCard(page);
        await rendered(page);
        const style = await page.evaluate(() => window.__rankingRoot()
            ?.querySelector(".row[data-id='sensor.breaker'] .money-seg.forgone.negative")
            ?.getAttribute("style") ?? null);
        expect(style).toContain("right:50%");
    });

    test("a tap shows the exact split", async ({ page }) => {
        await mountCard(page);
        await rendered(page);
        await page.evaluate(() => (window.__rankingRoot()
            ?.querySelector(".row[data-id='sensor.washer'] .head") as HTMLElement).click());
        await expect.poll(() => rankingText(page, ".row[data-id='sensor.washer'] .detail"))
            .toContain("Solar");
        expect(await rankingText(page, ".row[data-id='sensor.washer'] .detail")).toContain("33 %");
    });
});

test("a state-only hass update renders nothing", async ({ page }) => {
    await mountCard(page);
    await rendered(page);
    await page.waitForTimeout(200);
    await page.evaluate(() => {
        window.__updates = {};
        for (const tag of [
            "helman-device-reports-card",
            "helman-device-report-shell",
            "helman-device-report-ranking",
        ]) {
            const proto = customElements.get(tag)!.prototype as { update: (changed: unknown) => void };
            const original = proto.update;
            window.__updates[tag] = 0;
            proto.update = function (changed: unknown) {
                window.__updates[tag] += 1;
                return original.call(this, changed);
            };
        }
    });
    await page.evaluate(async () => {
        const card = document.querySelector("helman-device-reports-card") as HTMLElement & Record<string, unknown>;
        for (let i = 0; i < 20; i += 1) {
            card.hass = {
                ...window.__fakeHass,
                states: { "sensor.anything": { state: String(i) } },
            };
            await new Promise((frame) => requestAnimationFrame(frame));
        }
    });
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__updates)).toEqual({
        "helman-device-reports-card": 0,
        "helman-device-report-shell": 0,
        "helman-device-report-ranking": 0,
    });
    expect(await requestCount(page)).toBe(1);
});
