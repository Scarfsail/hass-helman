import { test, expect, type Page } from "@playwright/test";
import {
    STOP_MONTH_VIEW,
    STOP_SLOT_60,
    STOP_YEAR_VIEW,
    bandRuns,
    canPageBack,
    clickColumn,
    clickStop,
    columns,
    loadCardBundle,
    mountInspector,
    pageBack,
    pageBackAndWait,
    sectionMetrics,
    selectColumn,
    selectedSpan,
    spanStarts,
    waitForAggregateChart,
    waitForDayChart,
} from "./support/inspector-aggregate-harness";

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

        // The span is one read, for whole months, at day resolution. Filtered to
        // the bucketed reads: the day pills share this endpoint and ask for
        // their own window without a bucket, which is not what this is about.
        const requests = await spanReads(page);
        expect(requests).toHaveLength(1);
        expect(requests[0].bucket).toBe("day");
        expect(requests[0].start_date.slice(-2)).toBe("01");
    });

    /**
     * The bug these two tests were written for.
     *
     * The floor used to be the solar-bias trainer's window -- a couple of
     * months -- so a backwards step in the year view clamped onto the year it
     * was already showing: nothing moved, and the control then read as dead.
     * The rows replaced that control, and both halves still hold of them: that
     * a step really travels, and that the picker runs out of years exactly
     * once, on the span the data actually stops in.
     */
    test("the year view steps back a year at a time to the oldest data", async ({ page }) => {
        const thisYear = new Date().getUTCFullYear();
        await mountInspector(page, false, "", `${thisYear - 3}-06-15`);
        await clickStop(page, STOP_YEAR_VIEW);
        await waitForAggregateChart(page);

        for (let step = 0; step < 3; step += 1) {
            expect(await canPageBack(page)).toBe(true);
            await pageBackAndWait(page);
        }

        expect(await spanStarts(page, "month")).toEqual([
            `${thisYear}-01-01`,
            `${thisYear - 1}-01-01`,
            `${thisYear - 2}-01-01`,
            `${thisYear - 3}-01-01`,
        ]);
        expect(await selectedSpan(page)).toBe(`${thisYear - 3}-01-01`);
        // The floor's own year is reachable and is where travel stops.
        expect(await canPageBack(page)).toBe(false);
    });

    test("a floor inside the current year leaves no earlier year to offer", async ({ page }) => {
        // The reported symptom, in its own right. The floor sits inside this
        // year, so there is no earlier year with data and the year row holds a
        // single pill -- the one already lit. The arrow this was written against
        // compared today's *date* against the floor, said yes, and then moved
        // nothing; a row that only draws the years it has cannot make that
        // claim in the first place.
        const thisYear = new Date().getUTCFullYear();
        await mountInspector(page, false, "", `${thisYear}-02-01`);
        await clickStop(page, STOP_YEAR_VIEW);
        await waitForAggregateChart(page);

        expect(await selectedSpan(page)).toBe(`${thisYear}-01-01`);
        expect(await canPageBack(page)).toBe(false);
    });

    test("the month view reaches every month back to the oldest data", async ({ page }) => {
        const floor = new Date();
        floor.setUTCDate(1);
        floor.setUTCMonth(floor.getUTCMonth() - 14);
        const floorIso = floor.toISOString().slice(0, 10);
        await mountInspector(page, false, "", floorIso);
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        for (let step = 0; step < 14; step += 1) {
            expect(await canPageBack(page)).toBe(true);
            await pageBackAndWait(page);
        }

        // The selection, not the request log: the day pills share the span
        // endpoint and ask for day buckets of their own, and what this test is
        // about is that fourteen clicks really travel fourteen months.
        expect(await selectedSpan(page)).toBe(floorIso);
        expect(await canPageBack(page)).toBe(false);
    });

    /**
     * The two views are bounded by two different stores, so the card keeps two
     * floors rather than one field whichever view loaded last overwrote.
     *
     * The day view used to catch this with its back arrow, which clamped to the
     * day floor; there is no arrow now, and the day view's pills do not clamp --
     * they offer the month they are showing. What still separates the two
     * floors is the drill control below, which reads the day floor while the
     * month view's own floor is what put the column on screen.
     */
    test("a day the recorder has purged is named but not drillable", async ({ page }) => {
        // The month view reaches further back than the day view can, because the
        // two read two different stores. Opening such a day would draw an empty
        // chart under a back arrow already dead on arrival -- the day being
        // older than the day view's own floor -- so the control says so instead.
        const iso = (daysBack: number) => {
            const day = new Date();
            day.setUTCDate(day.getUTCDate() - daysBack);
            return day.toISOString().slice(0, 10);
        };
        const thisYear = new Date().getUTCFullYear();
        await mountInspector(page, false, "", `${thisYear - 3}-06-15`, iso(3));

        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);
        // Two months back is comfortably beyond a three-day day-view floor.
        await pageBackAndWait(page);
        await pageBackAndWait(page);

        const keys = await columns(page);
        await selectColumn(page, 0);

        const drill = await page.evaluate(() => {
            const button = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector(".drill-button") as HTMLButtonElement;
            return { disabled: button.disabled, title: button.getAttribute("title") };
        });
        expect(drill.disabled).toBe(true);
        expect(drill.title).toBeTruthy();

        // And no day was asked for behind the reader's back.
        const requests = await page.evaluate(() => (window as any).__dayRequests as string[]);
        expect(requests).not.toContain(keys[0]);
    });

    test("the year view draws one column per month", async ({ page }) => {
        await clickStop(page, STOP_YEAR_VIEW);
        await waitForAggregateChart(page);

        expect(await columns(page)).toHaveLength(12);
        const requests = await spanReads(page);
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
     * The SoC row draws two grounded bars per bucket, the way the day view's SoC
     * strip draws its one: a column standing on the baseline, not a ribbon
     * floating at the level. The high-water mark gives the column its height and
     * the low-water mark is a second, darker bar nested inside it, so the pair
     * reads as "never below this, up to that" rather than as an abstract band.
     *
     * Both are step areas, one path per unbroken stretch, four vertices per
     * bucket — across the top edge and back along the baseline.
     */
    test("the month view draws grounded min and max SoC bars for every day", async ({ page }) => {
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const days = (await columns(page)).length;
        expect(await bandRuns(page, "path.soc-band.max")).toEqual([4 * days]);
        // The min bar is the piece that was missing: same run, its own fill.
        expect(await bandRuns(page, "path.soc-band.min")).toEqual([4 * days]);

        // Both stand on the row's baseline, and the min bar never rises above
        // the max bar it sits inside.
        const geometry = await page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            const box = (selector: string) =>
                chart.shadowRoot.querySelector(selector).getBoundingClientRect();
            const max = box("path.soc-band.max");
            const min = box("path.soc-band.min");
            return { sameFloor: Math.abs(max.bottom - min.bottom) < 1, minLower: min.top >= max.top };
        });
        expect(geometry.sameFloor).toBe(true);
        expect(geometry.minLower).toBe(true);
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
        expect(await bandRuns(page, "path.soc-band.max")).toEqual([4 * 3, 4 * (days - 5)]);
        expect(await bandRuns(page, "path.soc-band.min")).toEqual([4 * 3, 4 * (days - 5)]);
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

        // Arriving from the day view carries that day across as the selected
        // column, so the span's own totals are what shows once it is dropped.
        // Pressing the selected column again is what drops it.
        const carried = await page.evaluate(() => (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-aggregate-chart")
            .shadowRoot.querySelector(".bucket-column.selected")?.getAttribute("data-bucket"));
        expect(carried).not.toBeNull();
        await clickColumn(page, (await columns(page)).indexOf(carried as string));

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

    test("an unpriceable export side stays an em dash, and takes the net with it", async ({ page }) => {
        // The backend reserves null for "this side could not be priced" and says
        // so: an export entity with no statistics earns moneyGain: null, because
        // "earned nothing" is a claim the data does not support. Zero-filling it
        // here would print `0.00` and a net equal to the whole import bill --
        // the unsupported claim, restated by the card.
        await mountInspector(page, false, "no-gain");
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        await page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            (chart.shadowRoot.querySelectorAll(".bucket-column")[1] as SVGElement)
                .dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
        });
        await page.waitForFunction(() => !!(document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector(".metrics-section"));

        const text = await page.evaluate(() => ((
            document.querySelector("helman-solar-inspector") as any
        ).shadowRoot.querySelector(".metrics-section").textContent as string)
            .replace(/\s+/g, " "));

        // The cost is known; the gain and the net it feeds are not, and say so.
        expect(text).toMatch(/Import cost 40\.00 CZK/);
        expect(text).toMatch(/Export gain \u2014/);
        expect(text).toMatch(/Net cost \u2014/);
        expect(text).not.toMatch(/Export gain 0\.00/);
    });

    test("an out-of-range SoC reading is clamped to the row's own scale", async ({ page }) => {
        // Some BMS feeds round past 100 %. Unclamped, the range's top edge
        // leaves the plot and crosses the caption drawn in the margin above it.
        await mountInspector(page, false, "over-soc");
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const tops = await page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            const path = chart.shadowRoot.querySelector(".soc-row path");
            const numbers = (path.getAttribute("d") as string)
                .match(/-?\d+(\.\d+)?/g)!.map(Number);
            // The top edge is walked first, two vertices per bucket: y of the
            // 100.4 % bucket, then y of the 100 % one beside it.
            return { first: numbers[1], second: numbers[5] };
        });

        // Clamped, the two draw at the same height; unclamped the first is above.
        expect(tops.first).toBe(tops.second);
    });

    test("a span with no energy statistics still draws its SoC and money rows", async ({ page }) => {
        // Those rows have their own data and their own null handling; bailing on
        // an empty energy stack would discard two panels that had something to
        // say. The energy chart stays too, because the hit rects live in it.
        await mountInspector(page, false, "no-energy");
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const present = await page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            return {
                energyBands: chart.shadowRoot.querySelectorAll("path.energy-band").length,
                soc: !!chart.shadowRoot.querySelector(".soc-row path"),
                money: !!chart.shadowRoot.querySelector(".money-row path"),
                columns: chart.shadowRoot.querySelectorAll(".bucket-column").length,
            };
        });

        expect(present.energyBands).toBe(0);
        expect(present.soc).toBe(true);
        expect(present.money).toBe(true);
        expect(present.columns).toBeGreaterThan(0);
    });

    test("both rows write each bucket's value on its column, as the day strips do", async ({ page }) => {
        // The day view's SoC strip writes a percentage on every column and its
        // money strip writes both amounts; a month view that draws the same
        // shapes without the numbers makes the reader hover for what the day
        // view simply says. Both go through the shared strip label, so both
        // vanish at the same column width the day view's do.
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const labels = await page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            // Left-gutter tick labels sit left of the plot; value labels are
            // centred on their column, so x alone separates the two.
            const onPlot = (root: Element) => [...root.querySelectorAll("text")]
                .filter((node: Element) => Number(node.getAttribute("x")) > 44)
                .map((node: Element) => (node.textContent || "").trim())
                .filter((text: string) => text.length > 0);
            return {
                soc: onPlot(chart.shadowRoot.querySelector(".soc-row")),
                money: onPlot(chart.shadowRoot.querySelector(".money-row")),
            };
        });

        // A percentage for each end of every bucket's range.
        expect(labels.soc.filter((text) => text === "90%").length).toBeGreaterThan(0);
        expect(labels.soc.filter((text) => text === "20%").length).toBeGreaterThan(0);
        // And both money amounts, cost and gain.
        expect(labels.money.filter((text) => text === "40.0").length).toBeGreaterThan(0);
        expect(labels.money.filter((text) => text === "12.0").length).toBeGreaterThan(0);
    });

    test("hovering the SoC or money row works exactly as hovering the chart does", async ({ page }) => {
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        for (const row of [".soc-row", ".money-row"]) {
            const point = await page.evaluate((selector: string) => {
                const chart = (document.querySelector("helman-solar-inspector") as any)
                    .shadowRoot.querySelector("helman-solar-aggregate-chart");
                const box = (chart.shadowRoot
                    .querySelectorAll(`${selector} .bucket-tint`)[2] as SVGElement)
                    .getBoundingClientRect();
                return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
            }, row);

            await page.mouse.move(point.x, point.y);
            await page.waitForFunction(() => !!(document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector(".hover-tooltip"));

            // The popup, and the column marked in every panel including the
            // chart above -- the same answer whichever row was pointed at.
            const state = await page.evaluate(() => {
                const root = (document.querySelector("helman-solar-inspector") as any).shadowRoot;
                const chart = root.querySelector("helman-solar-aggregate-chart");
                return {
                    title: root.querySelector(".hover-tooltip-title")?.textContent?.trim(),
                    chartMarked: !!chart.shadowRoot.querySelector(".bucket-hover"),
                    rowsMarked: chart.shadowRoot.querySelectorAll(".bucket-tint.hovered").length,
                };
            });
            expect(state.title).toBeTruthy();
            expect(state.chartMarked).toBe(true);
            expect(state.rowsMarked).toBe(2);

            await page.mouse.move(5, 5);
            await page.waitForFunction(() => !(document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector(".hover-tooltip"));
        }
    });

    test("clicking a column in a row selects it, as clicking the chart does", async ({ page }) => {
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        await page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            (chart.shadowRoot.querySelectorAll(".money-row .bucket-tint")[4] as SVGElement)
                .dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
        });
        await page.waitForFunction(() => !!(document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector(".metrics-section"));

        const selected = await page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            return chart.shadowRoot.querySelector(".bucket-column.selected")
                ?.getAttribute("data-bucket");
        });
        const keys = await columns(page);
        expect(selected).toBe(keys[4]);
    });
});

/** The bucketed span reads, without the day pills' own unbucketed window read. */
async function spanReads(page: Page): Promise<Array<Record<string, string>>> {
    return page.evaluate(() => ((window as any).__spanRequests as Array<Record<string, string>>)
        .filter((request) => request.bucket !== undefined));
}
