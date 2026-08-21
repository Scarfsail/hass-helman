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
 *
 * `holes` punches two gaps into a day-bucketed span: the fourth bucket keeps
 * only its upper SoC bound, and the fifth has no readings at all. Both are
 * shapes the backend really produces — a battery sensor that started recording
 * mid-day, a day the recorder never saw — and both are drawn by *not* drawing.
 */
async function mountInspector(page: Page, holes = false): Promise<void> {
    await page.evaluate((punchHoles: boolean) => {
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
                const halfKnown = punchHoles && bucket !== "month" && index === 3;
                const missing = punchHoles && bucket !== "month" && index === 4;
                rows.push({
                    date: iso(cursor),
                    solarWh: missing ? null : 20000 + index * 500,
                    gridImportKwh: missing ? null : 4,
                    gridExportKwh: missing ? null : 6,
                    batteryMinSocPct: halfKnown || missing ? null : 20,
                    batteryMaxSocPct: missing ? null : 90,
                    houseWh: missing ? null : 18000,
                    batteryChargeWh: missing ? null : 7000,
                    batteryDischargeWh: missing ? null : 6000,
                    moneyCost: missing ? null : 40,
                    moneyGain: missing ? null : 12,
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
    }, holes);

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

/** Step the span nav one click back. */
async function pageBack(page: Page): Promise<void> {
    await page.evaluate(() => {
        const buttons = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelectorAll(".week-nav .week-arrow");
        (buttons[0] as HTMLElement).click();
    });
}

async function waitForDayChart(page: Page): Promise<void> {
    await page.waitForFunction(() => !!(document.querySelector("helman-solar-inspector") as any)
        .shadowRoot.querySelector(".chart-wrap svg"));
}

async function waitForAggregateChart(page: Page): Promise<void> {
    await page.waitForFunction(() => {
        const chart = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-aggregate-chart");
        return !!chart?.shadowRoot?.querySelector(".bucket-column");
    });
}

/** The vertex count of each path matching `selector`, in document order. */
async function bandRuns(page: Page, selector: string): Promise<number[]> {
    return page.evaluate((sel) => {
        const chart = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-aggregate-chart");
        return [...chart.shadowRoot.querySelectorAll(sel)]
            .map((path: Element) => (path.getAttribute("d") || "").match(/[ML]/g)?.length ?? 0);
    }, selector);
}

/** One metrics panel's tiles, as label to value. */
async function sectionMetrics(page: Page, index: number): Promise<Record<string, string>> {
    return page.evaluate((i) => {
        const root = (document.querySelector("helman-solar-inspector") as any).shadowRoot;
        const section = root.querySelectorAll(".metrics-section")[i];
        const out: Record<string, string> = {};
        for (const card of section.querySelectorAll(".metric-card")) {
            const label = card.querySelector(".metric-label")?.textContent?.trim() ?? "";
            out[label] = card.querySelector(".metric-value")?.textContent?.trim() ?? "";
        }
        return out;
    }, index);
}

/** Click a column, and wait for the selected-bucket panel it opens. */
async function selectColumn(page: Page, index: number): Promise<void> {
    await page.evaluate((i) => {
        const chart = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-aggregate-chart");
        (chart.shadowRoot.querySelectorAll(".bucket-column")[i] as SVGElement)
            .dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    }, index);
    await page.waitForFunction(() => !!(document.querySelector("helman-solar-inspector") as any)
        .shadowRoot.querySelector(".drill-button"));
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
        // demand below it, so the columns are not just hit targets. One path per
        // band per contiguous run, as the day chart draws them -- with data in
        // every bucket that is one run each, so six. Counted by class rather
        // than as every path in the element, because the SoC and money rows
        // below draw their own.
        const bands = await page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            return chart.shadowRoot.querySelectorAll("svg path.energy-band").length;
        });
        expect(bands).toBe(6);

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

    test("returning to the day view after paging a span loads the day it landed on", async ({ page }) => {
        // Span navigation moves the selection to a span start, so the payload on
        // hand is for some other day. Coming back has to notice that and fetch;
        // guarding the fetch on the selection rather than on the payload's own
        // date leaves the card drawing a header over nothing at all, with no
        // request in flight to fix it and no error to explain it.
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);
        await pageBack(page);
        await waitForAggregateChart(page);

        await clickStop(page, STOP_SLOT_60);
        await waitForDayChart(page);

        const state = await page.evaluate(() => {
            const root = (document.querySelector("helman-solar-inspector") as any).shadowRoot;
            const requests = (window as any).__dayRequests as string[];
            return {
                hasChart: !!root.querySelector(".chart-wrap svg"),
                lastRequest: requests[requests.length - 1],
            };
        });

        expect(state.hasChart).toBe(true);
        // The day it landed on, not the day that happened to be loaded before.
        expect(state.lastRequest.endsWith("-01")).toBe(true);
    });

    test("drilling into the span's first day loads it even though it is already selected", async ({ page }) => {
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);
        await pageBack(page);
        await waitForAggregateChart(page);

        // The 1st -- the very day span navigation parked the selection on.
        await page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            (chart.shadowRoot.querySelectorAll(".bucket-column")[0] as SVGElement)
                .dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
        });
        await page.waitForFunction(() => !!(document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector(".drill-button"));
        await page.evaluate(() => {
            ((document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector(".drill-button") as HTMLElement).click();
        });
        await waitForDayChart(page);

        expect(await page.evaluate(() => !!(document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector(".chart-wrap svg"))).toBe(true);
    });

    test("a real click on the coloured stack selects the column under it", async ({ page }) => {
        // The bands cover most of a column and are painted after the hit rects,
        // so without pointer-events they swallow the click that matters most --
        // the one aimed at the band the reader is asking about. Dispatching
        // straight at the hit rect cannot see this; a real click can.
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const box = await page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            // The thickest band, so the click lands well inside painted colour.
            const thickest = [...chart.shadowRoot.querySelectorAll("svg path.energy-band")]
                .map((path: Element) => path.getBoundingClientRect())
                .filter((rect: DOMRect) => rect.height > 0)
                .sort((a: DOMRect, b: DOMRect) => b.height - a.height)[0];
            return thickest
                ? { x: thickest.x + thickest.width / 2, y: thickest.y + thickest.height / 2 }
                : null;
        });
        expect(box).not.toBeNull();

        await page.mouse.click(box!.x, box!.y);

        expect(await page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            return !!chart.shadowRoot.querySelector(".bucket-column.selected");
        })).toBe(true);
    });

    test("a year view's selected bucket is headed as a month, not as its first day", async ({ page }) => {
        await clickStop(page, STOP_YEAR_VIEW);
        await waitForAggregateChart(page);

        await page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            (chart.shadowRoot.querySelectorAll(".bucket-column")[0] as SVGElement)
                .dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
        });
        await page.waitForFunction(() => !!(document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector(".metrics-section strong"));

        const heading = await page.evaluate(() => (
            document.querySelector("helman-solar-inspector") as any
        ).shadowRoot.querySelector(".metrics-section strong").textContent.trim());

        // A month's totals must not be labelled with the 1st of that month.
        expect(heading).toMatch(/January/i);
        expect(heading).not.toMatch(/\b1\b/);
    });

    test("bands meet edge to edge, as the day chart's do", async ({ page }) => {
        // A bucket is an interval, not a sample, so its band spans the whole
        // width it stands for. Inset bars leave a gap that reads as a bar chart
        // of discrete things -- and stops the month view looking like the day
        // view the reader just came from.
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const gap = await page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            const columns = [...chart.shadowRoot.querySelectorAll(".bucket-column")];
            const columnWidth = columns[1].getBoundingClientRect().x
                - columns[0].getBoundingClientRect().x;
            // The widest band path: its box should fill whole columns, not 80%.
            const boxes = [...chart.shadowRoot.querySelectorAll("svg path.energy-band")]
                .map((path: Element) => path.getBoundingClientRect())
                .filter((box: DOMRect) => box.width > 0)
                .sort((a: DOMRect, b: DOMRect) => b.width - a.width);
            const spanned = Math.round(boxes[0].width / columnWidth);
            return { ratio: boxes[0].width / (spanned * columnWidth), spanned };
        });

        expect(gap.spanned).toBeGreaterThan(0);
        // Whole columns, edge to edge; the 0.8-of-a-column bars scored ~0.8.
        expect(gap.ratio).toBeGreaterThan(0.97);
    });

    test("hovering a column shows the same popup the day view uses", async ({ page }) => {
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const point = await page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            const box = (chart.shadowRoot.querySelectorAll(".bucket-column")[2] as SVGElement)
                .getBoundingClientRect();
            return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        });

        await page.mouse.move(point.x, point.y);
        await page.waitForFunction(() => !!(document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector(".hover-tooltip"));

        const popup = await page.evaluate(() => {
            const root = (document.querySelector("helman-solar-inspector") as any).shadowRoot;
            const chart = root.querySelector("helman-solar-aggregate-chart");
            return {
                title: root.querySelector(".hover-tooltip-title")?.textContent?.trim(),
                labels: [...root.querySelectorAll(".hover-tooltip-label")].length,
                highlighted: !!chart.shadowRoot.querySelector(".bucket-hover"),
            };
        });

        expect(popup.labels).toBeGreaterThan(0);
        expect(popup.title).toBeTruthy();
        // The hovered column is marked, exactly as a hovered slot is.
        expect(popup.highlighted).toBe(true);

        // Leaving the chart clears both.
        await page.mouse.move(5, 5);
        await page.waitForFunction(() => !(document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector(".hover-tooltip"));
    });
    /**
     * The SoC row draws a *range* per bucket, in the step-area language the
     * energy bands above it use: one path per unbroken stretch of buckets, four
     * vertices apiece — across the top edge and back along the bottom — so a
     * whole month with bounds everywhere is one path of `4 × days` points, one
     * range per day.
     */
    test("the month view draws a min/max SoC range for every day", async ({ page }) => {
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const runs = await bandRuns(page, "path.soc-band");
        const days = (await columns(page)).length;
        expect(runs).toEqual([4 * days]);
    });

    test("a bucket with one SoC bound draws nothing, and one with neither leaves a gap", async ({ page }) => {
        // Half a range is not a range: drawing the known end alone would read as
        // a battery that never moved, which is the zero P1's null-not-0.0 rule
        // exists to keep off the screen.
        await mountInspector(page, true);
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const days = (await columns(page)).length;
        // Buckets 3 (upper bound only) and 4 (nothing at all) both break the run,
        // leaving the first three days and everything from the sixth on.
        expect(await bandRuns(page, "path.soc-band")).toEqual([4 * 3, 4 * (days - 5)]);
        // The energy bands see only the empty bucket, so they break once.
        expect(await bandRuns(page, "path.energy-band")).toHaveLength(12);
    });

    test("the money row draws a cell per bucket, cost above the line and gain below", async ({ page }) => {
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const days = (await columns(page)).length;
        expect(await bandRuns(page, "path.money-band.cost")).toEqual([4 * days]);
        expect(await bandRuns(page, "path.money-band.gain")).toEqual([4 * days]);

        // Cost is drawn upward from the zero line and gain downward, so the two
        // are never told apart by colour alone.
        const sides = await page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            const box = (selector: string) =>
                chart.shadowRoot.querySelector(selector).getBoundingClientRect();
            return { cost: box("path.money-band.cost"), gain: box("path.money-band.gain") };
        });
        expect(sides.cost.bottom).toBeLessThanOrEqual(sides.gain.top + 1);
    });

    test("an unpriced bucket breaks the money row rather than costing nothing", async ({ page }) => {
        await mountInspector(page, true);
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const days = (await columns(page)).length;
        expect(await bandRuns(page, "path.money-band.cost")).toEqual([4 * 4, 4 * (days - 5)]);
    });

    /**
     * The money in the panels is summed through `sumMoney` — the day view's own
     * function, matching a point's key against a selection and never parsing it,
     * so bucket keys pass through it unchanged.
     */
    test("the selected bucket's money is its own, and the span's is the sum", async ({ page }) => {
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const days = (await columns(page)).length;
        const totals = await sectionMetrics(page, 0);
        expect(totals["Import cost"]).toBe(`${(40 * days).toFixed(2)} CZK`);
        expect(totals["Export gain"]).toBe(`${(12 * days).toFixed(2)} CZK`);
        expect(totals["Net cost"]).toBe(`${(28 * days).toFixed(2)} CZK`);

        await selectColumn(page, 2);
        const bucket = await sectionMetrics(page, 0);
        expect(bucket["Import cost"]).toBe("40.00 CZK");
        expect(bucket["Export gain"]).toBe("12.00 CZK");
        expect(bucket["Net cost"]).toBe("28.00 CZK");
        expect(bucket["SoC range"]).toBe("20–90 %");
    });

    test("a bucket with no price and no SoC bounds says so rather than showing zero", async ({ page }) => {
        await mountInspector(page, true);
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        await selectColumn(page, 4);
        const bucket = await sectionMetrics(page, 0);
        // The panel drops the SoC range entirely and dashes the money, because
        // "unpriced" and "cost nothing" are different statements.
        expect(bucket["SoC range"]).toBeUndefined();
        expect(bucket["Import cost"]).not.toMatch(/0\.00/);
    });

    test("the hover popup carries the SoC range and the money too", async ({ page }) => {
        // A reader who hovers a column must get everything the panels below say;
        // otherwise the popup answers half the question and hides the rest
        // behind a click.
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const point = await page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            const box = (chart.shadowRoot.querySelectorAll(".bucket-column")[2] as SVGElement)
                .getBoundingClientRect();
            return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        });
        await page.mouse.move(point.x, point.y);
        await page.waitForFunction(() => !!(document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector(".hover-tooltip"));

        const labels = await page.evaluate(() => [...(
            document.querySelector("helman-solar-inspector") as any
        ).shadowRoot.querySelectorAll(".hover-tooltip-label")]
            .map((node: Element) => node.textContent?.trim()));

        expect(labels).toContain("SoC range");
        expect(labels).toContain("Import cost");
        expect(labels).toContain("Export gain");
    });

    test("the hovered column is marked in the SoC and money rows as well", async ({ page }) => {
        // Three panels on one axis: pointing at a day in the chart must not
        // leave the reader hunting for the same day by eye in the rows below.
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const point = await page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            const box = (chart.shadowRoot.querySelectorAll(".bucket-column")[2] as SVGElement)
                .getBoundingClientRect();
            return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        });
        await page.mouse.move(point.x, point.y);
        await page.waitForFunction(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            return chart.shadowRoot.querySelectorAll(".bucket-tint.hovered").length === 2;
        });

        const aligned = await page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            const hover = chart.shadowRoot.querySelector(".bucket-hover").getBoundingClientRect();
            return [...chart.shadowRoot.querySelectorAll(".bucket-tint.hovered")]
                .every((rect: Element) =>
                    Math.abs(rect.getBoundingClientRect().x - hover.x) < 1);
        });
        expect(aligned).toBe(true);
    });
});
