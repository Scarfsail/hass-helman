import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

import { FIXED_NOW_ISO, installFixedClock } from "./support/fixed-clock";

/**
 * `helman-device-reports-card` against a fake backend.
 *
 * `helman/device_report` is answered from a fixture generated in the page, so
 * what the card asked for -- and how often -- is what these tests assert on.
 * The shell owns the period, the granularity, the fetching and the
 * freshness; the Ranking and Over time reports only render. Specs that are about the clock fake the page's timers
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
        __reportRequests: Array<{ report: string; start: string; end: string; granularity?: string }>;
        __releaseReport: (index: number) => void;
        __shellRoot: () => ShadowRoot | null | undefined;
        __rankingRoot: () => ShadowRoot | null | undefined;
        __overTimeRoot: () => ShadowRoot | null | undefined;
        __fakeHass: Record<string, unknown>;
        __updates: Record<string, number>;
        __emitDataChanged: (kind: string) => void;
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
        const common = (start: string, end: string) => ({
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
        });
        // Seven devices ranked a..g by their period total. In the second column
        // b outdoes a, and the devices measure 5 kWh more than the house meter.
        const series = ["a", "b", "c", "d", "e", "f", "g"].map((letter) => ({
            id: "sensor." + letter, label: "Device " + letter.toUpperCase(), icon: null,
            estimated: false, first_hour: null,
        }));
        const values = (...kwh: number[]) => Object.fromEntries(
            series.map((item, index) => [item.id, kwh[index]]),
        );
        const overTime = (start: string, end: string, granularity: string) => ({
            ...common(start, end),
            report: "over_time",
            granularity,
            series,
            buckets: [
                {
                    start, end: "2026-10-04", partial: true, house: 40,
                    values: values(10, 8, 6, 4, 3, 2, 1), unmeasured: 6, overallocated: 0,
                },
                {
                    start: "2026-10-05", end: "2026-10-11", partial: false, house: 25,
                    values: values(5, 9, 6, 4, 3, 2, 1), unmeasured: 0, overallocated: 5,
                },
                {
                    start: "2026-10-12", end, partial: true, house: 5,
                    values: values(1, 1, 1, 0, 0, 0, 0), unmeasured: 2, overallocated: 0,
                },
            ],
        });
        const ranking = (start: string, end: string) => ({
            ...common(start, end),
            report: "ranking",
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
            connection: {
                subscribeMessage: async (callback: (message: { kind: string }) => void) => {
                    window.__emitDataChanged = (kind: string) => callback({ kind });
                    return () => undefined;
                },
            },
            states: {},
            callWS: async (msg: {
                type: string; report: string; start_date: string; end_date: string; granularity?: string;
            }) => {
                if (msg.type !== "helman/device_report") return {};
                window.__reportRequests.push({
                    report: msg.report, start: msg.start_date, end: msg.end_date,
                    ...(msg.granularity ? { granularity: msg.granularity } : {}),
                });
                if (opts.fail) throw new Error("boom");
                const answer = () => opts.unavailable
                    ? { unavailable: opts.unavailable }
                    : msg.report === "over_time"
                        ? overTime(msg.start_date, msg.end_date, msg.granularity ?? "day")
                        : ranking(msg.start_date, msg.end_date);
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
        window.__overTimeRoot = () => window.__shellRoot()
            ?.querySelector("helman-device-report-over-time")?.shadowRoot;

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

    test("a saved config drops even a complete payload; a replan does not", async ({ page }) => {
        await mountCard(page, { complete: true, fakeTimersAt: FIXED_NOW_ISO });
        await expect.poll(() => requestCount(page)).toBe(1);
        await page.evaluate(() => window.__emitDataChanged("plan"));
        await page.clock.runFor(1_000);
        expect(await requestCount(page)).toBe(1);
        await page.evaluate(() => window.__emitDataChanged("config"));
        await page.clock.runFor(1_000);
        await expect.poll(() => requestCount(page)).toBe(2);
    });

    test("a report in flight when a config is saved is neither kept nor blocking", async ({ page }) => {
        await mountCard(page, { complete: true, hold: true });
        await expect.poll(() => requestCount(page)).toBe(1);
        await page.evaluate(() => window.__emitDataChanged("config"));
        await expect.poll(() => requestCount(page)).toBe(2);
        await page.evaluate(() => window.__releaseReport(0));
        await page.evaluate(() => window.__releaseReport(1));
        await rendered(page);
        // Back and forth: the old answer was not memoised, the new one was.
        await clickPreset(page, "last_7");
        await expect.poll(() => requestCount(page)).toBe(3);
        await page.evaluate(() => window.__releaseReport(2));
        await clickPreset(page, "last_30");
        await rendered(page);
        expect(await requestCount(page)).toBe(3);
    });

    test("a new connection drops even a complete payload and rebinds the feed", async ({ page }) => {
        await mountCard(page, { complete: true, fakeTimersAt: FIXED_NOW_ISO });
        await expect.poll(() => requestCount(page)).toBe(1);
        await page.evaluate(() => {
            const card = document.querySelector("helman-device-reports-card") as HTMLElement & Record<string, unknown>;
            const previous = window.__fakeHass;
            const connection = {
                subscribeMessage: async (callback: (message: { kind: string }) => void) => {
                    window.__emitDataChanged = (kind: string) => callback({ kind });
                    return () => undefined;
                },
            };
            window.__emitDataChanged = () => undefined;
            window.__fakeHass = { ...previous, connection };
            card.hass = window.__fakeHass;
        });
        await expect.poll(() => requestCount(page)).toBe(2);
        await page.evaluate(() => window.__emitDataChanged("config"));
        await page.clock.runFor(1_000);
        await expect.poll(() => requestCount(page)).toBe(3);
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

async function clickShell(page: Page, selector: string): Promise<void> {
    await page.evaluate((sel: string) => {
        (window.__shellRoot()?.querySelector(sel) as HTMLButtonElement).click();
    }, selector);
}

async function openOverTime(page: Page): Promise<void> {
    await rendered(page);
    await clickShell(page, "button[data-report='over_time']");
    await expect.poll(() => page.evaluate(
        () => !!window.__overTimeRoot()?.querySelector(".column"),
    )).toBe(true);
}

function hasGranularityBar(page: Page) {
    return page.evaluate(() => !!window.__shellRoot()?.querySelector(".bar.granularity"));
}

/** Each column's segments, bottom up, as `[series, background]`. */
function columnSegments(page: Page) {
    return page.evaluate(() => [...(window.__overTimeRoot()?.querySelectorAll(".column") ?? [])]
        .map((column) => [...column.querySelectorAll(".seg")].map((seg) => [
            (seg as HTMLElement).dataset.series,
            (seg as HTMLElement).style.background,
        ])));
}

function legendIds(page: Page) {
    return page.evaluate(() => [...(window.__overTimeRoot()?.querySelectorAll(".legend-item") ?? [])]
        .map((item) => (item as HTMLElement).dataset.series));
}

test.describe("over time", () => {
    test("the granularity selector is shown only for it, and refetches", async ({ page }) => {
        await mountCard(page);
        await rendered(page);
        expect(await hasGranularityBar(page)).toBe(false);

        await openOverTime(page);
        expect(await hasGranularityBar(page)).toBe(true);
        await clickShell(page, "button[data-granularity='week']");
        await expect.poll(() => requests(page)).toEqual([
            { report: "ranking", start: "2026-09-22", end: "2026-10-21" },
            { report: "over_time", start: "2026-09-22", end: "2026-10-21", granularity: "day" },
            { report: "over_time", start: "2026-09-22", end: "2026-10-21", granularity: "week" },
        ]);

        // The Ranking ignores granularity: it is neither offered nor refetched.
        await clickShell(page, "button[data-report='ranking']");
        await rendered(page);
        expect(await hasGranularityBar(page)).toBe(false);
        expect(await requestCount(page)).toBe(3);
        // And the day payload is still memoised.
        await clickShell(page, "button[data-report='over_time']");
        await clickShell(page, "button[data-granularity='day']");
        await page.waitForTimeout(100);
        expect(await requestCount(page)).toBe(3);
    });

    test("top X refolds the columns without a refetch", async ({ page }) => {
        await mountCard(page);
        await openOverTime(page);
        expect(await legendIds(page)).toEqual([
            "sensor.a", "sensor.b", "sensor.c", "sensor.d", "sensor.e", "other", "unmeasured",
        ]);
        await page.evaluate(() => (window.__overTimeRoot()
            ?.querySelector("button[data-top='3']") as HTMLButtonElement).click());
        await expect.poll(() => legendIds(page)).toEqual([
            "sensor.a", "sensor.b", "sensor.c", "other", "unmeasured",
        ]);
        const columns = await columnSegments(page);
        expect(columns.map((segments) => segments.map(([id]) => id))).toEqual(
            Array(3).fill(["sensor.a", "sensor.b", "sensor.c", "other", "unmeasured"]),
        );
        expect(await page.evaluate(() => window.__overTimeRoot()
            ?.querySelector(".column")?.getAttribute("title") ?? "")).toContain("Other devices: 10 kWh");

        await page.evaluate(() => (window.__overTimeRoot()
            ?.querySelector("button[data-top='10']") as HTMLButtonElement).click());
        await expect.poll(() => legendIds(page)).toEqual([
            "sensor.a", "sensor.b", "sensor.c", "sensor.d", "sensor.e", "sensor.f", "sensor.g",
            "unmeasured",
        ]);
        expect(await requestCount(page)).toBe(2);
    });

    test("top X survives a refetch for another granularity", async ({ page }) => {
        await mountCard(page);
        await openOverTime(page);
        await page.evaluate(() => (window.__overTimeRoot()
            ?.querySelector("button[data-top='3']") as HTMLButtonElement).click());
        await expect.poll(() => legendIds(page)).toEqual([
            "sensor.a", "sensor.b", "sensor.c", "other", "unmeasured",
        ]);
        await clickShell(page, "button[data-granularity='week']");
        await expect.poll(() => requestCount(page)).toBe(3);
        await expect.poll(() => legendIds(page)).toEqual([
            "sensor.a", "sensor.b", "sensor.c", "other", "unmeasured",
        ]);
    });

    test("a series keeps its colour and its rank in every column", async ({ page }) => {
        await mountCard(page);
        await openOverTime(page);
        const columns = await columnSegments(page);
        const legend = await page.evaluate(() => Object.fromEntries(
            [...(window.__overTimeRoot()?.querySelectorAll(".legend-item") ?? [])].map((item) => [
                (item as HTMLElement).dataset.series,
                (item.querySelector(".swatch") as HTMLElement).style.background,
            ]),
        ));
        // In the second column b outdoes a, yet a is still drawn first.
        expect(columns[1].map(([id]) => id)).toEqual([
            "sensor.a", "sensor.b", "sensor.c", "sensor.d", "sensor.e", "other", "unmeasured",
        ]);
        for (const segments of columns) {
            for (const [id, background] of segments) {
                expect(background).toBe(legend[id!]);
            }
        }
        expect(new Set(Object.values(legend)).size).toBe(Object.keys(legend).length);
    });

    test("partial buckets are dimmed and labelled", async ({ page }) => {
        await mountCard(page);
        await openOverTime(page);
        const columns = await page.evaluate(() => [...(window.__overTimeRoot()?.querySelectorAll(".column") ?? [])]
            .map((column) => ({
                partial: column.classList.contains("partial"),
                opacity: getComputedStyle(column).opacity,
                title: column.getAttribute("title") ?? "",
            })));
        expect(columns.map((column) => column.partial)).toEqual([true, false, true]);
        expect(columns[0].opacity).toBe("0.45");
        expect(columns[1].opacity).toBe("1");
        expect(columns[0].title.split("\n")[0]).toBe("2026-09-22 – 2026-10-04 (partial)");
        expect(columns[1].title).not.toContain("partial");
        expect(await page.evaluate(() => window.__overTimeRoot()?.querySelector(".partial-note")?.textContent ?? ""))
            .toContain("partial");
    });

    test("an over-allocated column shows the house tick below its top", async ({ page }) => {
        await mountCard(page);
        await openOverTime(page);
        const columns = await page.evaluate(() => [...(window.__overTimeRoot()?.querySelectorAll(".column") ?? [])]
            .map((column) => ({
                over: column.classList.contains("overallocated"),
                stackTop: column.querySelector(".stack")!.getBoundingClientRect().top,
                tickTop: column.querySelector(".tick")!.getBoundingClientRect().top,
                excess: !!column.querySelector(".excess"),
                title: column.getAttribute("title") ?? "",
            })));
        expect(columns.map((column) => column.over)).toEqual([false, true, false]);
        expect(columns[1].excess).toBe(true);
        expect(columns[0].excess).toBe(false);
        // Screen y grows downwards: the tick sits below the stack's top.
        expect(columns[1].tickTop).toBeGreaterThan(columns[1].stackTop + 1);
        expect(Math.abs(columns[0].tickTop - columns[0].stackTop)).toBeLessThanOrEqual(2);
        expect(columns[1].title).toContain("devices measure 5.0 kWh more than the house meter");
        expect(columns[1].title).toContain("Total: 30 kWh");
        expect(columns[0].title).not.toContain("devices measure");
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
