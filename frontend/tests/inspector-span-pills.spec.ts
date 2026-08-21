import { test, expect, type Page } from "@playwright/test";
import {
    buildSpanPills,
    type SpanPill,
} from "../cards/helman-solar-inspector/span-pill-model";
import {
    STOP_MONTH_VIEW,
    STOP_YEAR_VIEW,
    clickStop,
    loadCardBundle,
    mountInspector,
    spanStarts,
    waitForAggregateChart,
} from "./support/inspector-aggregate-harness";

/**
 * The aggregate views' span picker.
 *
 * The day view has always had a pill row; the month and year views had a label,
 * and once the floor became the recorder's own answer, reaching two years back
 * meant twenty-four clicks of the arrow. This file holds the row that replaced
 * the label, and the one property that separates it from the day row it must
 * not become: a span pill is its label. No gauge, no forecast, no schedule —
 * every one of those describes something that only exists inside a day.
 */

/** The row's pills, in order, as label plus whether it is the lit one. */
async function pills(page: Page): Promise<Array<{ key: string; label: string; selected: boolean }>> {
    return page.evaluate(() => {
        const row = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-span-pills");
        if (!row?.shadowRoot) return [];
        return [...row.shadowRoot.querySelectorAll(".pill")].map((pill: Element) => ({
            key: pill.getAttribute("data-span") ?? "",
            label: pill.textContent?.trim() ?? "",
            selected: pill.classList.contains("selected"),
        }));
    });
}

/** Click the pill carrying the given span key. */
async function clickPill(page: Page, key: string): Promise<void> {
    await page.evaluate((wanted) => {
        const row = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-span-pills");
        const pill = row.shadowRoot.querySelector(`.pill[data-span="${wanted}"]`) as HTMLElement;
        pill.click();
    }, key);
}

const iso = (year: number, month: number) =>
    `${year}-${String(month).padStart(2, "0")}-01`;

test.describe("span pill model", () => {
    // The model imports only types, so it is exercised directly rather than
    // through the card bundle -- the same treatment `money-model.spec.ts` gives
    // the other arithmetic-only module in this folder.

    const keys = (list: SpanPill[]) => list.map((pill) => pill.key);

    test("the month row runs from the floor's month to the one holding today", () => {
        const built = buildSpanPills({
            viewMode: "month",
            minDate: "2024-11-14",
            todayKey: "2025-02-08",
            selectedDate: "2025-01-01",
            locale: "en-GB",
        });

        expect(keys(built)).toEqual([
            "2024-11-01", "2024-12-01", "2025-01-01", "2025-02-01",
        ]);
        // The floor's own month is included whole: the row is a picker, and a
        // month the data starts halfway through is still a month to look at.
        expect(built[0].key).toBe("2024-11-01");
    });

    test("the year row runs from the floor's year to this one", () => {
        const built = buildSpanPills({
            viewMode: "year",
            minDate: "2023-06-15",
            todayKey: "2025-02-08",
            selectedDate: "2024-01-01",
            locale: "en-GB",
        });

        expect(keys(built)).toEqual(["2023-01-01", "2024-01-01", "2025-01-01"]);
        expect(built.map((pill) => pill.label)).toEqual(["2023", "2024", "2025"]);
    });

    test("the pill holding the browsed date is the lit one, and it is the only one", () => {
        const built = buildSpanPills({
            viewMode: "month",
            minDate: "2024-11-01",
            todayKey: "2025-02-08",
            // Mid-month: the selection is a date, not a span start, whenever the
            // reader arrived by drilling rather than by paging.
            selectedDate: "2024-12-19",
            locale: "en-GB",
        });

        expect(built.filter((pill) => pill.selected).map((pill) => pill.key))
            .toEqual(["2024-12-01"]);
    });

    test("January carries its year, and so does the first pill whatever month it is", () => {
        const built = buildSpanPills({
            viewMode: "month",
            minDate: "2024-11-01",
            todayKey: "2025-02-08",
            selectedDate: "2025-02-01",
            locale: "en-GB",
        });

        // A row scrolled to its middle must never leave the reader working out
        // which year they are looking at.
        expect(built.map((pill) => pill.label))
            .toEqual(["Nov 2024", "Dec", "Jan 2025", "Feb"]);
    });

    test("a floor the card has not learned yet collapses to today's span", () => {
        // Rather than to nothing: a row that vanished while the first load was in
        // flight would take the only span control with it.
        const built = buildSpanPills({
            viewMode: "month",
            minDate: "",
            todayKey: "2025-02-08",
            selectedDate: "2025-02-08",
            locale: "en-GB",
        });

        expect(keys(built)).toEqual(["2025-02-01"]);
        expect(built[0].selected).toBe(true);
    });

    test("a floor later than today does not invert the row", () => {
        // A clock that moved, or a floor from a payload that outlived it. The
        // row must not run backwards or come back empty.
        const built = buildSpanPills({
            viewMode: "year",
            minDate: "2030-01-01",
            todayKey: "2025-02-08",
            selectedDate: "2025-02-08",
            locale: "en-GB",
        });

        expect(keys(built)).toEqual(["2025-01-01"]);
    });
});

test.describe("solar inspector span pills", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    test("the month view offers every month from the floor to this one", async ({ page }) => {
        const now = new Date();
        const floor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));
        const floorIso = floor.toISOString().slice(0, 10);
        await mountInspector(page, false, "", floorIso);
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const row = await pills(page);
        expect(row).toHaveLength(6);
        expect(row[0].key).toBe(floorIso);
        expect(row[row.length - 1].key)
            .toBe(iso(now.getUTCFullYear(), now.getUTCMonth() + 1));
        // The month on screen is the month lit, and nothing else is.
        expect(row.filter((pill) => pill.selected)).toHaveLength(1);
        expect(row[row.length - 1].selected).toBe(true);
    });

    test("the year view offers one pill per year over the same range", async ({ page }) => {
        const thisYear = new Date().getUTCFullYear();
        await mountInspector(page, false, "", `${thisYear - 2}-06-15`);
        await clickStop(page, STOP_YEAR_VIEW);
        await waitForAggregateChart(page);

        const row = await pills(page);
        expect(row.map((pill) => pill.key)).toEqual([
            `${thisYear - 2}-01-01`,
            `${thisYear - 1}-01-01`,
            `${thisYear}-01-01`,
        ]);
        expect(row.map((pill) => pill.label))
            .toEqual([String(thisYear - 2), String(thisYear - 1), String(thisYear)]);
    });

    test("clicking a pill loads that span and moves the selection to it", async ({ page }) => {
        const thisYear = new Date().getUTCFullYear();
        await mountInspector(page, false, "", `${thisYear - 3}-06-15`);
        await clickStop(page, STOP_YEAR_VIEW);
        await waitForAggregateChart(page);

        const wanted = `${thisYear - 2}-01-01`;
        await clickPill(page, wanted);
        await page.waitForFunction((key) =>
            ((window as any).__spanRequests as Array<{ start_date: string; bucket: string }>)
                .some((msg) => msg.bucket === "month" && msg.start_date === key), wanted);

        // One click, one span: the row is a picker, not a walk through the years
        // between here and there.
        expect(await spanStarts(page, "month")).toEqual([`${thisYear}-01-01`, wanted]);
        const row = await pills(page);
        expect(row.filter((pill) => pill.selected).map((pill) => pill.key)).toEqual([wanted]);
    });

    test("clicking the span already on screen asks for nothing", async ({ page }) => {
        const thisYear = new Date().getUTCFullYear();
        await mountInspector(page, false, "", `${thisYear - 2}-06-15`);
        await clickStop(page, STOP_YEAR_VIEW);
        await waitForAggregateChart(page);

        const before = await spanStarts(page, "month");
        await clickPill(page, `${thisYear}-01-01`);
        await page.waitForTimeout(150);

        expect(await spanStarts(page, "month")).toEqual(before);
    });

    test("a span pill is its label and carries no day gauge", async ({ page }) => {
        // The row this replaced the label with must not drift into being the day
        // row: a forecast strip, an SoC bar or a grid bar inside a month pill
        // would each be describing something that only exists inside a day.
        const thisYear = new Date().getUTCFullYear();
        await mountInspector(page, false, "", `${thisYear - 1}-06-15`);
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const innards = await page.evaluate(() => {
            const row = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-span-pills");
            const pill = row.shadowRoot.querySelector(".pill") as HTMLElement;
            return {
                gauges: pill.querySelectorAll(".day-aggregate-gauge").length,
                svgs: pill.querySelectorAll("svg").length,
                children: pill.children.length,
                dayRows: row.shadowRoot.querySelectorAll("helman-solar-day-pills").length,
            };
        });

        expect(innards).toEqual({ gauges: 0, svgs: 0, children: 0, dayRows: 0 });
    });

    test("the day view keeps its own row and never grows a span one", async ({ page }) => {
        await mountInspector(page);

        const rows = await page.evaluate(() => {
            const root = (document.querySelector("helman-solar-inspector") as any).shadowRoot;
            return {
                dayPills: root.querySelectorAll("helman-solar-day-pills").length,
                spanPills: root.querySelectorAll("helman-solar-span-pills").length,
            };
        });

        expect(rows).toEqual({ dayPills: 1, spanPills: 0 });
    });

    test("switching to an aggregate view swaps one row for the other", async ({ page }) => {
        await mountInspector(page);
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const rows = await page.evaluate(() => {
            const root = (document.querySelector("helman-solar-inspector") as any).shadowRoot;
            return {
                dayPills: root.querySelectorAll("helman-solar-day-pills").length,
                spanPills: root.querySelectorAll("helman-solar-span-pills").length,
                // The words the row replaced.
                label: root.querySelectorAll(".span-label").length,
            };
        });

        expect(rows).toEqual({ dayPills: 0, spanPills: 1, label: 0 });
    });
});
