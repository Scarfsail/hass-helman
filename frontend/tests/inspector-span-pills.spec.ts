import { test, expect, type Page } from "@playwright/test";
import {
    buildSpanPillRows,
    spanKeyForYear,
    type SpanPillOptions,
} from "../cards/helman-solar-inspector/span-pill-model";
import {
    STOP_MONTH_VIEW,
    STOP_SLOT_60,
    STOP_YEAR_VIEW,
    clickStop,
    loadCardBundle,
    mountInspector,
    selectColumn,
    spanStarts,
    waitForAggregateChart,
    waitForDayChart,
} from "./support/inspector-aggregate-harness";

/**
 * The aggregate views' span picker: a row of years over a row of months.
 *
 * The day view has always had a pill row; the month and year views had a label,
 * and once the floor became the recorder's own answer, reaching two years back
 * meant twenty-four clicks of the arrow.
 *
 * Two rows because a span is two independent choices, and the properties that
 * follow from that are what most of this file pins. The month row is always
 * twelve pills — the ones outside the data disabled rather than dropped, so the
 * row never changes shape and a month stays under the same pointer while the
 * year moves beneath it. The year row is lit in both views; the month row only
 * in the one whose columns are days, because a year view is showing all of
 * them. And picking a month is also a change of granularity, since the year
 * view's columns *are* months: clicking one opens it.
 *
 * The other property here is the one that separates this row from the day row
 * it must not become: a span pill is its label. No gauge, no forecast, no
 * schedule — every one of those describes something that only exists inside a
 * day.
 */

type PillRow = "years" | "months";

interface ProbedPill {
    key: string;
    label: string;
    selected: boolean;
    disabled: boolean;
}

/** One row's pills, in order. */
async function pills(page: Page, row: PillRow): Promise<ProbedPill[]> {
    return page.evaluate((which) => {
        const host = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-span-pills");
        if (!host?.shadowRoot) return [];
        return [...host.shadowRoot.querySelectorAll(`.pill-row.${which} .pill`)]
            .map((pill: Element) => ({
                key: pill.getAttribute("data-span") ?? "",
                label: pill.textContent?.trim() ?? "",
                selected: pill.classList.contains("selected"),
                disabled: (pill as HTMLButtonElement).disabled,
            }));
    }, row);
}

/** Click the pill carrying the given span key, in the given row. */
async function clickPill(page: Page, row: PillRow, key: string): Promise<void> {
    await page.evaluate(([which, wanted]) => {
        const host = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-span-pills");
        const pill = host.shadowRoot
            .querySelector(`.pill-row.${which} .pill[data-span="${wanted}"]`) as HTMLElement;
        pill.click();
    }, [row, key] as [PillRow, string]);
}

/** Wait for a span request the card has not made before. */
async function waitForSpanRequest(
    page: Page,
    bucket: "day" | "month",
    startDate: string,
): Promise<void> {
    await page.waitForFunction(([wantedBucket, wantedStart]) =>
        ((window as any).__spanRequests as Array<{ start_date: string; bucket: string }>)
            .some((msg) => msg.bucket === wantedBucket && msg.start_date === wantedStart),
    [bucket, startDate] as [string, string]);
}

const iso = (year: number, month: number) =>
    `${year}-${String(month).padStart(2, "0")}-01`;

const NOW = new Date();
const THIS_YEAR = NOW.getUTCFullYear();
const THIS_MONTH = NOW.getUTCMonth() + 1;
const TODAY = NOW.toISOString().slice(0, 10);

test.describe("span pill model", () => {
    // The model imports only types, so it is exercised directly rather than
    // through the card bundle -- the same treatment `money-model.spec.ts` gives
    // the other arithmetic-only module in this folder.
    const options = (over: Partial<SpanPillOptions> = {}): SpanPillOptions => ({
        viewMode: "month",
        minDate: "2024-03-15",
        todayKey: "2026-08-21",
        selectedDate: "2026-08-21",
        locale: "en-US",
        ...over,
    });

    test("the year row runs from the floor's year to this one", () => {
        const { years } = buildSpanPillRows(options());

        expect(years.map((pill) => pill.key))
            .toEqual(["2024-01-01", "2025-01-01", "2026-01-01"]);
        expect(years.map((pill) => pill.label)).toEqual(["2024", "2025", "2026"]);
        expect(years.some((pill) => pill.disabled)).toBe(false);
    });

    test("the month row is always twelve, whatever the data covers", () => {
        // Disabled rather than dropped: a row that changed length as the year
        // changed would move the months around under the pointer, and the whole
        // reason they sit in their own row is that one stays picked while the
        // year moves.
        const floorYear = buildSpanPillRows(options({ selectedDate: "2024-06-10" }));
        const middleYear = buildSpanPillRows(options({ selectedDate: "2025-06-10" }));
        const thisYear = buildSpanPillRows(options());

        for (const rows of [floorYear, middleYear, thisYear]) {
            expect(rows.months).toHaveLength(12);
            expect(rows.months.map((pill) => pill.label)).toEqual([
                "Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
            ]);
        }

        // Before the floor's month, after today's month, and neither in between.
        expect(floorYear.months.filter((pill) => pill.disabled).map((pill) => pill.key))
            .toEqual(["2024-01-01", "2024-02-01"]);
        expect(middleYear.months.some((pill) => pill.disabled)).toBe(false);
        expect(thisYear.months.filter((pill) => pill.disabled).map((pill) => pill.key))
            .toEqual(["2026-09-01", "2026-10-01", "2026-11-01", "2026-12-01"]);
    });

    test("a month pill never carries its year", () => {
        // The year is the row above; repeating it in twelve pills would be noise
        // and would stop them all being the same width.
        const { months } = buildSpanPillRows(options({ selectedDate: "2025-01-10" }));

        expect(months[0].label).toBe("Jan");
        expect(months.every((pill) => !/\d/.test(pill.label))).toBe(true);
    });

    test("the day-granularity view lights a year and a month", () => {
        const { years, months } = buildSpanPillRows(options({ selectedDate: "2025-04-09" }));

        expect(years.filter((pill) => pill.selected).map((pill) => pill.key))
            .toEqual(["2025-01-01"]);
        expect(months.filter((pill) => pill.selected).map((pill) => pill.key))
            .toEqual(["2025-04-01"]);
    });

    test("the month-granularity view lights the year alone", () => {
        // Its columns *are* the months, so lighting one would claim a narrower
        // span than the view is showing.
        const { years, months } = buildSpanPillRows(
            options({ viewMode: "year", selectedDate: "2025-04-09" }),
        );

        expect(years.filter((pill) => pill.selected).map((pill) => pill.key))
            .toEqual(["2025-01-01"]);
        expect(months.some((pill) => pill.selected)).toBe(false);
        // Still drawn, and still bounded by the data.
        expect(months).toHaveLength(12);
    });

    test("changing year keeps the month, which is what the second row is for", () => {
        const from = options({ selectedDate: "2026-04-09" });

        expect(spanKeyForYear(from, 2025)).toBe("2025-04-01");
        expect(spanKeyForYear(from, 2024)).toBe("2024-04-01");
    });

    test("a month the target year does not have is clamped into it", () => {
        // December of a past year, then jumping to this one: December has not
        // happened, so the newest month that has is the honest landing.
        expect(spanKeyForYear(options({ selectedDate: "2025-12-09" }), 2026))
            .toBe("2026-08-01");
        // And the same at the floor end.
        expect(spanKeyForYear(options({ selectedDate: "2026-01-09" }), 2024))
            .toBe("2024-03-01");
    });

    test("changing year in the month-granularity view is just that year", () => {
        expect(spanKeyForYear(options({ viewMode: "year", selectedDate: "2026-08-21" }), 2024))
            .toBe("2024-01-01");
    });

    test("a floor the card has not learned yet collapses to today", () => {
        // The state on the first render, before the span load has answered. The
        // rows must not vanish out from under the reader.
        const { years, months } = buildSpanPillRows(options({ minDate: "" }));

        expect(years.map((pill) => pill.key)).toEqual(["2026-01-01"]);
        expect(months).toHaveLength(12);
        expect(months.filter((pill) => !pill.disabled).map((pill) => pill.key))
            .toEqual(["2026-08-01"]);
    });

    test("a floor later than today does not invert the rows", () => {
        const { years, months } = buildSpanPillRows(options({ minDate: "2027-01-01" }));

        expect(years.map((pill) => pill.key)).toEqual(["2026-01-01"]);
        expect(months.filter((pill) => !pill.disabled)).toHaveLength(1);
    });
});

test.describe("solar inspector span pills", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    test("the day-granularity view lights the year and the month in it", async ({ page }) => {
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-06-15`);
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const years = await pills(page, "years");
        const months = await pills(page, "months");

        expect(years.map((pill) => pill.key)).toEqual([
            iso(THIS_YEAR - 2, 1), iso(THIS_YEAR - 1, 1), iso(THIS_YEAR, 1),
        ]);
        expect(months).toHaveLength(12);
        expect(years.filter((pill) => pill.selected).map((pill) => pill.key))
            .toEqual([iso(THIS_YEAR, 1)]);
        expect(months.filter((pill) => pill.selected).map((pill) => pill.key))
            .toEqual([iso(THIS_YEAR, THIS_MONTH)]);
        // Months after this one exist in the row and cannot be picked.
        expect(months.filter((pill) => pill.disabled).map((pill) => pill.key))
            .toEqual(Array.from({ length: 12 - THIS_MONTH }, (_, i) => iso(THIS_YEAR, THIS_MONTH + 1 + i)));
    });

    test("the month-granularity view lights the year and no month", async ({ page }) => {
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-06-15`);
        await clickStop(page, STOP_YEAR_VIEW);
        await waitForAggregateChart(page);

        expect((await pills(page, "years")).filter((pill) => pill.selected).map((pill) => pill.key))
            .toEqual([iso(THIS_YEAR, 1)]);
        expect((await pills(page, "months")).some((pill) => pill.selected)).toBe(false);
    });

    test("picking a year keeps the month and shows it in that year", async ({ page }) => {
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-06-15`);
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        // Move to a month every year in range has, so the jump is not clamped.
        await clickPill(page, "months", iso(THIS_YEAR, 7));
        await waitForSpanRequest(page, "day", iso(THIS_YEAR, 7));

        await clickPill(page, "years", iso(THIS_YEAR - 1, 1));
        await waitForSpanRequest(page, "day", iso(THIS_YEAR - 1, 7));

        const months = await pills(page, "months");
        expect(months.filter((pill) => pill.selected).map((pill) => pill.key))
            .toEqual([iso(THIS_YEAR - 1, 7)]);
        expect((await pills(page, "years")).filter((pill) => pill.selected).map((pill) => pill.key))
            .toEqual([iso(THIS_YEAR - 1, 1)]);
    });

    test("picking a month from the year view drops to day granularity", async ({ page }) => {
        // The year view's columns are months, so clicking one is asking to open
        // it -- the same move drilling into that column makes.
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-06-15`);
        await clickStop(page, STOP_YEAR_VIEW);
        await waitForAggregateChart(page);

        await clickPill(page, "months", iso(THIS_YEAR, 3));
        // A day-bucketed span request *is* the change of granularity: the year
        // view asks for months.
        await waitForSpanRequest(page, "day", iso(THIS_YEAR, 3));
        await waitForAggregateChart(page);

        const columns = await page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            return chart.shadowRoot.querySelectorAll(".bucket-column").length;
        });
        // A month of days, not a year of months.
        expect(columns).toBe(31);
        expect((await pills(page, "months")).filter((pill) => pill.selected).map((pill) => pill.key))
            .toEqual([iso(THIS_YEAR, 3)]);
    });

    test("a month with no data is shown but cannot be picked", async ({ page }) => {
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-06-15`);
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);
        await clickPill(page, "years", iso(THIS_YEAR - 2, 1));
        await waitForSpanRequest(page, "day", iso(THIS_YEAR - 2, THIS_MONTH));

        const months = await pills(page, "months");
        // The floor is June of that year, so the five before it are dead.
        expect(months.filter((pill) => pill.disabled).map((pill) => pill.key))
            .toEqual([1, 2, 3, 4, 5].map((month) => iso(THIS_YEAR - 2, month)));

        const before = await spanStarts(page, "day");
        await clickPill(page, "months", iso(THIS_YEAR - 2, 1));
        await page.waitForTimeout(150);
        expect(await spanStarts(page, "day")).toEqual(before);
    });

    test("clicking the span already on screen asks for nothing", async ({ page }) => {
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-06-15`);
        await clickStop(page, STOP_YEAR_VIEW);
        await waitForAggregateChart(page);

        const before = await spanStarts(page, "month");
        await clickPill(page, "years", iso(THIS_YEAR, 1));
        await page.waitForTimeout(150);

        expect(await spanStarts(page, "month")).toEqual(before);
    });

    test("clicking the lit month pill keeps the day the reader came from", async ({ page }) => {
        // `_selectedDate` is a span start only after span navigation put it
        // there. Arriving from the day view on the 14th leaves it on the 14th,
        // so a no-op guard that compared raw dates would treat a click on the
        // already-lit pill as a move: it would drop the selected column and
        // rewrite the date, and returning to the day view would land on the 1st
        // rather than the day the reader came from.
        await mountInspector(page, false, "", `${THIS_YEAR - 1}-06-15`);
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        // Select a column, so there is something a stray reload would drop.
        await selectColumn(page, 3);

        const before = await spanStarts(page, "day");
        await clickPill(page, "months", iso(THIS_YEAR, THIS_MONTH));
        await page.waitForTimeout(150);

        const stillSelected = await page.evaluate(() => !!(
            document.querySelector("helman-solar-inspector") as any
        ).shadowRoot.querySelector(".metrics-section"));

        expect(await spanStarts(page, "day")).toEqual(before);
        expect(stillSelected).toBe(true);

        // And back in the day view it is still the day the card arrived on.
        await clickStop(page, STOP_SLOT_60);
        await waitForDayChart(page);
        const landed = await page.evaluate(() => {
            const requests = (window as any).__dayRequests as string[];
            return requests[requests.length - 1];
        });
        expect(landed).toBe(TODAY);
    });

    test("a row too narrow for its pills scrolls to the lit one", async ({ page }) => {
        // Two rows rarely overflow a wide card, so the case this guards is a
        // narrow one: twelve months on a phone-width card, with the lit month
        // most of the way along. The card also switches into an aggregate view
        // before the span load has said where history begins, so the first
        // render is the one year an unknown floor collapses to -- if the reveal
        // spends itself there, the rebuild a moment later leaves the row parked
        // at its start with the lit pill off screen.
        await page.setViewportSize({ width: 380, height: 900 });
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-06-15`);
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const overflows = await page.evaluate(() => {
            const host = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-span-pills");
            const row = host.shadowRoot.querySelector(".pill-row.months") as HTMLElement;
            return row.scrollWidth > row.clientWidth;
        });
        // The premise. Without it the assertion below would pass on a row that
        // never needed scrolling at all.
        expect(overflows).toBe(true);

        // The row scrolls smoothly; wait for it to settle rather than racing it.
        // The lit pill comes to rest against an edge when it is near an end, so
        // its centre being in view is the real claim -- it is on screen rather
        // than parked at January.
        await page.waitForFunction(() => {
            const host = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-span-pills");
            const row = host?.shadowRoot?.querySelector(".pill-row.months") as HTMLElement | null;
            const pill = host?.shadowRoot
                ?.querySelector(".pill-row.months .pill.selected") as HTMLElement | null;
            if (!row || !pill) return false;
            const rowBox = row.getBoundingClientRect();
            const pillBox = pill.getBoundingClientRect();
            const centre = pillBox.left + pillBox.width / 2;
            return centre >= rowBox.left && centre <= rowBox.right;
        }, undefined, { timeout: 3000 });

        const scrollLeft = await page.evaluate(() => {
            const host = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-span-pills");
            return (host.shadowRoot.querySelector(".pill-row.months") as HTMLElement).scrollLeft;
        });
        expect(scrollLeft).toBeGreaterThan(0);
    });

    test("a span pill is its label and carries no day gauge", async ({ page }) => {
        // The rows these replaced the label with must not drift into being the
        // day row: a forecast strip, an SoC bar or a grid bar inside a month
        // pill would each be describing something that only exists inside a day.
        await mountInspector(page, false, "", `${THIS_YEAR - 1}-06-15`);
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const innards = await page.evaluate(() => {
            const host = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-span-pills");
            const pill = host.shadowRoot.querySelector(".pill") as HTMLElement;
            return {
                children: pill.children.length,
                svg: host.shadowRoot.querySelectorAll("svg").length,
                gauges: host.shadowRoot.querySelectorAll(
                    ".day-aggregate-gauge, .gauge, .strip, helman-solar-day-pills",
                ).length,
            };
        });

        expect(innards.children).toBe(0);
        expect(innards.svg).toBe(0);
        expect(innards.gauges).toBe(0);
    });

    test("the day view keeps its own row and never grows a span one", async ({ page }) => {
        await mountInspector(page, false, "", `${THIS_YEAR - 1}-06-15`);
        await waitForDayChart(page);

        const rows = await page.evaluate(() => {
            const root = (document.querySelector("helman-solar-inspector") as any).shadowRoot;
            return {
                day: !!root.querySelector("helman-solar-day-pills"),
                span: !!root.querySelector("helman-solar-span-pills"),
            };
        });

        expect(rows.day).toBe(true);
        expect(rows.span).toBe(false);
    });

    test("switching to an aggregate view swaps one row for the other", async ({ page }) => {
        await mountInspector(page, false, "", `${THIS_YEAR - 1}-06-15`);
        await waitForDayChart(page);
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const rows = await page.evaluate(() => {
            const root = (document.querySelector("helman-solar-inspector") as any).shadowRoot;
            return {
                day: !!root.querySelector("helman-solar-day-pills"),
                span: !!root.querySelector("helman-solar-span-pills"),
            };
        });

        expect(rows.day).toBe(false);
        expect(rows.span).toBe(true);
    });
});
