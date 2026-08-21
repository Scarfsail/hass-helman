import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The inspector's month and year views.
 *
 * These are a *separate element* sitting where the day chart normally is, and
 * that is the property most of this file exists to hold. At a month's width a
 * whole day is one column, so the price rail, the planned-actions band, the SoC
 * trajectory, the day pills and the daylight toggle all describe something that
 * only exists inside a day; none of them may appear here, and — the other half
 * of the same claim — none of the day view's behaviour may change because these
 * views exist. The day-view specs assert that half by passing unchanged; this
 * file asserts that switching away and back leaves the day exactly as it was.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

/** Toggle stops, narrowest first: three slot widths, then day and month. */
const STOP_MONTH_VIEW = 3;
const STOP_YEAR_VIEW = 4;
const STOP_SLOT_60 = 2;

async function loadCardBundle(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-inspector"));
}

/**
 * The inspector against a backend that answers both the day read and the span
 * read, recording what each was asked for.
 *
 * The span answer is generated from the requested window rather than fixed, so
 * the test can assert "one column per day of the month" without hard-coding a
 * month — which month it is depends on when the suite runs.
 */
async function mountInspector(page: Page): Promise<void> {
    await page.evaluate(() => {
        const today = new Date();
        const iso = (date: Date) => date.toISOString().slice(0, 10);
        const date = iso(today);

        const corrected: Array<{ timestamp: string; valueWh: number }> = [];
        const price: Array<{ slot: string; value: number }> = [];
        for (let m = 0; m < 1440; m += 15) {
            const hh = String(Math.floor(m / 60)).padStart(2, "0");
            const mm = String(m % 60).padStart(2, "0");
            corrected.push({
                timestamp: `${date}T${hh}:${mm}:00`,
                valueWh: Math.max(0, 400 - Math.abs(m - 720) / 2),
            });
            price.push({ slot: `${hh}:${mm}`, value: 3.5 });
        }

        const dayPayload = {
            date,
            timezone: "UTC",
            status: "ok",
            effectiveVariant: null,
            trainedAt: null,
            priceUnit: "CZK/kWh",
            range: {
                minDate: "2020-01-01", maxDate: date, canGoPrevious: true, canGoNext: false,
                isToday: true, isFuture: false,
            },
            series: {
                raw: [], corrected, actual: [], invalidated: [], factors: [], impact: [],
                houseForecast: [], houseActual: [],
                batterySocForecast: [], batterySocActual: [],
                gridForecast: [], gridActual: [], batteryForecast: [], batteryActual: [],
                importPrice: price, exportPrice: [],
            },
            totals: {
                rawWh: null, correctedWh: null, actualWh: null,
                houseForecastWh: null, houseActualWh: null,
                gridForecastWh: null, gridActualWh: null,
                batteryForecastWh: null, batteryActualWh: null,
            },
            availability: {
                hasRawForecast: false, hasCorrectedForecast: true, hasActuals: false,
                hasInvalidated: false, hasProfile: true, hasHouseForecast: false,
                hasHouseActual: false, hasBatterySocForecast: false, hasBatterySocActual: false,
                hasGridForecast: false, hasGridActual: false, hasBatteryForecast: false,
                hasBatteryActual: false,
            },
            batterySocBounds: [],
            trainingExplainability: null,
        };

        (window as any).__spanRequests = [];
        (window as any).__dayRequests = [];

        /** Every bucket of the requested window, with plausible numbers. */
        const spanDays = (start: string, end: string, bucket: string) => {
            const rows: Array<Record<string, unknown>> = [];
            const cursor = new Date(`${start}T00:00:00Z`);
            const last = new Date(`${end}T00:00:00Z`);
            let index = 0;
            while (cursor <= last) {
                rows.push({
                    date: iso(cursor),
                    solarWh: 20000 + index * 500,
                    gridImportKwh: 4,
                    gridExportKwh: 6,
                    batteryMinSocPct: 20,
                    batteryMaxSocPct: 90,
                    houseWh: 18000,
                    batteryChargeWh: 7000,
                    batteryDischargeWh: 6000,
                    moneyCost: 40,
                    moneyGain: 12,
                });
                index += 1;
                if (bucket === "month") {
                    cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
                } else {
                    cursor.setUTCDate(cursor.getUTCDate() + 1);
                }
            }
            return rows;
        };

        document.body.innerHTML = "";
        const el = document.createElement("helman-solar-inspector") as any;
        el.daylightOnlyDefault = false;
        el.slotMinutesDefault = 30;
        el.hass = {
            language: "en",
            config: { time_zone: "UTC" },
            connection: {},
            callWS: async (msg: any) => {
                if (msg.type === "helman/solar_bias/day_aggregates") {
                    (window as any).__spanRequests.push(msg);
                    return {
                        bucket: msg.bucket ?? "day",
                        currency: "CZK",
                        days: spanDays(msg.start_date, msg.end_date, msg.bucket ?? "day"),
                    };
                }
                if (msg.type === "helman/solar_bias/inspector") {
                    (window as any).__dayRequests.push(msg.date);
                    return { ...dayPayload, date: msg.date };
                }
                return {};
            },
        };
        document.body.appendChild(el);
    });

    await page.waitForFunction(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        return !!el?.shadowRoot?.querySelector(".chart-wrap svg");
    });
}

async function clickStop(page: Page, index: number): Promise<void> {
    await page.evaluate((i) => {
        const buttons = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelectorAll(".slot-size-toggle .slot-size-button");
        (buttons[i] as HTMLElement).click();
    }, index);
}

/** The aggregate chart's per-bucket hit rects, in order. */
async function columns(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const chart = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-aggregate-chart");
        if (!chart?.shadowRoot) return [];
        return [...chart.shadowRoot.querySelectorAll(".bucket-column")]
            .map((rect: Element) => rect.getAttribute("data-bucket") || "");
    });
}

async function waitForAggregateChart(page: Page): Promise<void> {
    await page.waitForFunction(() => {
        const chart = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-aggregate-chart");
        return !!chart?.shadowRoot?.querySelector(".bucket-column");
    });
}

test.describe("solar inspector aggregate views", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page);
    });

    test("the month view draws one column per day of the month", async ({ page }) => {
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const keys = await columns(page);
        const now = new Date();
        const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
            .getUTCDate();
        expect(keys).toHaveLength(daysInMonth);
        expect(keys).toEqual([...keys].sort());

        // And it draws them: six stacked bands, supply above the zero line and
        // demand below it, so the columns are not just hit targets.
        const bars = await page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            const rects = [...chart.shadowRoot.querySelectorAll("rect")]
                .filter((rect: Element) => !rect.classList.contains("bucket-column"));
            return rects.length;
        });
        expect(bars).toBe(daysInMonth * 6);

        // The span is one read, for whole months, at day resolution.
        const requests = await page.evaluate(() => (window as any).__spanRequests);
        expect(requests).toHaveLength(1);
        expect(requests[0].bucket).toBe("day");
        expect(requests[0].start_date.slice(-2)).toBe("01");
    });

    test("the year view draws one column per month", async ({ page }) => {
        await clickStop(page, STOP_YEAR_VIEW);
        await waitForAggregateChart(page);

        expect(await columns(page)).toHaveLength(12);
        const requests = await page.evaluate(() => (window as any).__spanRequests);
        expect(requests[0].bucket).toBe("month");
    });

    /**
     * Everything a span cannot say anything about. These are absent rather than
     * hidden: they live past the branch at the top of `_renderContent` and are
     * never rendered at all.
     */
    test("the day-only furniture is gone", async ({ page }) => {
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const present = await page.evaluate(() => {
            const root = (document.querySelector("helman-solar-inspector") as any).shadowRoot;
            const has = (selector: string) => !!root.querySelector(selector);
            return {
                pills: has("helman-solar-day-pills"),
                price: has("helman-solar-price-strip"),
                actions: has("helman-solar-schedule-band-strip"),
                money: has("helman-solar-money-strip"),
                daylight: [...root.querySelectorAll(".nav-actions .icon-button")]
                    .some((button: Element) => button.textContent?.includes("☀")),
                aggregate: has("helman-solar-aggregate-chart"),
            };
        });

        expect(present.aggregate).toBe(true);
        expect(present.pills).toBe(false);
        expect(present.price).toBe(false);
        expect(present.actions).toBe(false);
        expect(present.money).toBe(false);
        expect(present.daylight).toBe(false);
    });

    test("clicking a column selects it, and clicking it again clears it", async ({ page }) => {
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const clickColumn = (index: number) => page.evaluate((i) => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            (chart.shadowRoot.querySelectorAll(".bucket-column")[i] as SVGElement)
                .dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
        }, index);
        const selected = () => page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            return [...chart.shadowRoot.querySelectorAll(".bucket-column.selected")]
                .map((rect: Element) => rect.getAttribute("data-bucket"));
        });

        const keys = await columns(page);
        await clickColumn(2);
        await page.waitForFunction(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            return !!chart.shadowRoot.querySelector(".bucket-column.selected");
        });
        expect(await selected()).toEqual([keys[2]]);

        await clickColumn(2);
        await page.waitForFunction(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            return !chart.shadowRoot.querySelector(".bucket-column.selected");
        });
        expect(await selected()).toEqual([]);
    });

    test("the drill control opens the selected day in the day view", async ({ page }) => {
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const keys = await columns(page);
        await page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            (chart.shadowRoot.querySelectorAll(".bucket-column")[1] as SVGElement)
                .dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
        });
        await page.waitForFunction(() => !!(document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector(".drill-button"));

        await page.evaluate(() => {
            ((document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector(".drill-button") as HTMLElement).click();
        });

        await page.waitForFunction((day) => ((window as any).__dayRequests as string[]).includes(day), keys[1]);
        // Back in the day view, on the day that was pointed at.
        await page.waitForFunction(() => !!(document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-day-pills"));
        expect(await columns(page)).toEqual([]);
    });

    test("switching back to a minutes stop restores the day view intact", async ({ page }) => {
        const before = await page.evaluate(() => {
            const root = (document.querySelector("helman-solar-inspector") as any).shadowRoot;
            return {
                paths: root.querySelectorAll(".chart-wrap svg path").length,
                requests: ((window as any).__dayRequests as string[]).length,
            };
        });

        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);
        await clickStop(page, STOP_SLOT_60);
        await page.waitForFunction(() => !!(document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-day-pills"));

        const after = await page.evaluate(() => {
            const root = (document.querySelector("helman-solar-inspector") as any).shadowRoot;
            return {
                hasChart: !!root.querySelector(".chart-wrap svg"),
                hasAggregate: !!root.querySelector("helman-solar-aggregate-chart"),
                hasPrice: !!root.querySelector("helman-solar-price-strip"),
                requests: ((window as any).__dayRequests as string[]).length,
            };
        });

        expect(after.hasChart).toBe(true);
        expect(after.hasAggregate).toBe(false);
        expect(after.hasPrice).toBe(true);
        // The day payload was never dropped, so coming back costs no re-read.
        expect(after.requests).toBe(before.requests);
        expect(before.paths).toBeGreaterThan(0);
    });
});
