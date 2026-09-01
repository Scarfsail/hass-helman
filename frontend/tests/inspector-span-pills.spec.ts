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
    clickDayPill,
    clickSpanPill,
    dayPillDates,
    spanPillRow,
    spanStarts,
    unreachableDayPills,
    toggleMore,
    waitForAggregateChart,
    waitForDayChart,
} from "./support/inspector-aggregate-harness";
import { FIXED_NOW_ISO } from "./support/fixed-clock";

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

const NOW = new Date(FIXED_NOW_ISO);
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

    test("picking a month from the year view picks its column, not its days", async ({ page }) => {
        // The year view's columns *are* months, so pressing a month pill is
        // pressing that column: it selects, it does not open. A press that
        // changed granularity would make the picker the one control on the card
        // that moves the reader somewhere they did not ask to go.
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-06-15`);
        await clickStop(page, STOP_YEAR_VIEW);
        await waitForAggregateChart(page);

        const before = await spanStarts(page, "month");
        await clickPill(page, "months", iso(THIS_YEAR, 3));
        await page.waitForTimeout(150);

        // No new span was asked for: nothing about what is drawn has changed.
        expect(await spanStarts(page, "month")).toEqual(before);
        const columns = await page.evaluate(() => {
            const chart = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-aggregate-chart");
            return chart.shadowRoot.querySelectorAll(".bucket-column").length;
        });
        // Still a year of months.
        expect(columns).toBe(12);
        // And the column it named is the selected one.
        expect(await page.evaluate(() => [...(document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-aggregate-chart")
            .shadowRoot.querySelectorAll(".bucket-column.selected")]
            .map((rect: Element) => rect.getAttribute("data-bucket"))))
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

        // And a minutes stop opens the column that is selected, which is what
        // the reader pointed at -- not the date span navigation happens to have
        // parked `_selectedDate` on.
        const column = await page.evaluate(() => (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-aggregate-chart")
            .shadowRoot.querySelector(".bucket-column.selected")?.getAttribute("data-bucket"));
        await clickStop(page, STOP_SLOT_60);
        await waitForDayChart(page);
        const landed = await page.evaluate(() => {
            const requests = (window as any).__dayRequests as string[];
            return requests[requests.length - 1];
        });
        expect(landed).toBe(column);
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

        // The row scrolls smoothly, so the claim has to be polled rather than
        // read once. Polling the scroll offset itself, not the lit pill's
        // position: the pill it scrolls to sits near the end of the row and its
        // centre is already inside the viewport at rest, so a test that waited
        // on the centre was satisfied before the scroll had begun and then read
        // the offset mid-animation.
        await expect.poll(() => page.evaluate(() => {
            const host = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-span-pills");
            return (host?.shadowRoot?.querySelector(".pill-row.months") as HTMLElement | null)
                ?.scrollLeft ?? 0;
        }), { timeout: 3000 }).toBeGreaterThan(0);

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

    /**
     * Collapsed, each view shows only the rows it navigates by: the day view its
     * days, the aggregate views their spans. The rows no longer replace each
     * other — the toggle decides how many are up — so what is pinned here is
     * that the *closed* picker is still the minimal one.
     */
    test("the closed picker shows only the row its view navigates by", async ({ page }) => {
        await mountInspector(page, false, "", `${THIS_YEAR - 1}-06-15`);
        await waitForDayChart(page);
        expect(await visibleRows(page)).toEqual({ day: true, span: false });

        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);
        expect(await visibleRows(page)).toEqual({ day: false, span: true });
    });

    /**
     * The point of the unification: one control, and past it both rows are on
     * screen together whichever view is showing. Before, zooming out lost the
     * day pills outright.
     */
    test("the toggle puts both rows on screen in either view", async ({ page }) => {
        await mountInspector(page, false, "", `${THIS_YEAR - 1}-06-15`);
        await waitForDayChart(page);

        await toggleMore(page);
        expect(await visibleRows(page)).toEqual({ day: true, span: true });

        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);
        expect(await visibleRows(page)).toEqual({ day: true, span: true });

        await toggleMore(page);
        expect(await visibleRows(page)).toEqual({ day: false, span: true });
    });
});

/**
 * The day pills at an aggregate granularity.
 *
 * Once the toggle puts them there, they are a way *back* rather than a
 * selection: the view is showing a whole month or year, so no single day is on
 * screen and none is lit. Clicking one is a change of granularity as well as of
 * day, and it lands on the slot width the reader last used rather than on a
 * default -- coming back to the day view has always restored it, and now the
 * pills are one of the ways back.
 */
test.describe("day pills inside an aggregate view", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    test("no day is lit while an aggregate view is on screen", async ({ page }) => {
        await mountInspector(page, false, "", `${THIS_YEAR - 1}-06-15`);
        await waitForDayChart(page);
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);
        await toggleMore(page);

        const lit = await page.evaluate(() => (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-day-pills")
            ?.shadowRoot?.querySelectorAll(".pill.selected").length ?? -1);
        expect(lit).toBe(0);
    });

    test("a day pill picks the column, and a minutes stop opens it at the width last used", async ({ page }) => {
        await mountInspector(page, false, "", `${THIS_YEAR - 1}-06-15`);
        await waitForDayChart(page);

        // 60 rather than the default, so "the width last used" is a real answer
        // and not the one a fresh card would have chosen anyway.
        await clickStop(page, STOP_SLOT_60);
        await waitForDayChart(page);

        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);
        await toggleMore(page);

        const days = await dayPillDates(page);
        expect(days.length).toBeGreaterThan(0);
        const wanted = days[Math.floor(days.length / 2)];

        // The press picks the column and stays where it is: at D these pills
        // *are* the columns, so pressing one is pressing the column.
        await clickDayPill(page, wanted);
        expect(await page.evaluate(() => (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-aggregate-chart")
            .shadowRoot.querySelector(".bucket-column.selected")?.getAttribute("data-bucket")))
            .toBe(wanted);
        expect(await activeStops(page)).toEqual(["D"]);

        // The minutes stop is what opens it, at the width last used.
        await clickStop(page, STOP_SLOT_60);
        await waitForDayChart(page);
        expect(await activeStops(page)).toEqual(["60"]);
        const lit = await page.evaluate(() => (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-day-pills")
            .shadowRoot.querySelector(".pill.selected")?.getAttribute("data-day"));
        expect(lit).toBe(wanted);
    });
});

/** Which of the two pill rows the card currently has mounted. */
async function visibleRows(page: Page): Promise<{ day: boolean; span: boolean }> {
    return page.evaluate(() => {
        const root = (document.querySelector("helman-solar-inspector") as any).shadowRoot;
        return {
            day: !!root.querySelector("helman-solar-day-pills"),
            span: !!root.querySelector("helman-solar-span-pills"),
        };
    });
}

/**
 * The expanded picker inside the day view.
 *
 * This is the case the unification created and the one with no precedent: the
 * span rows were built for views that browse a span, and here they are heading
 * a calendar in a view that browses a day. Two things follow, and neither is
 * true of the aggregate views.
 *
 * The first is where the rows' floor comes from. `_spanRange` is the aggregate
 * views' own answer and it is only ever assigned by their load, so a card that
 * has never left the day view does not have one -- and a floor of nothing
 * collapses both rows to today. Since the arrows went, that is not a cosmetic
 * loss: the picker is the only way out of the current window.
 *
 * The second is what a press means. The element cannot tell these views apart
 * -- it emits the mode an aggregate view would want -- so the card has to read
 * a month press here as "slide the calendar", not as "switch to the month
 * view". Carrying the day of the month across is what makes it a slide.
 */
test.describe("the expanded picker in the day view", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    test("the rows reach back to the floor before any aggregate view loads", async ({ page }) => {
        // Two years of history and a card that opens, as always, in the day
        // view. Nothing has asked for a span, so `_spanRange` is null.
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-01-01`);
        await waitForDayChart(page);
        await toggleMore(page);

        const years = await spanPillRow(page, "years");
        expect(years.map((pill) => pill.key)).toEqual([
            `${THIS_YEAR - 2}-01-01`,
            `${THIS_YEAR - 1}-01-01`,
            `${THIS_YEAR}-01-01`,
        ]);
        // And the months of a year fully inside the history are all takeable,
        // which a floor of today would have left disabled to a one.
        await clickSpanPill(page, "years", `${THIS_YEAR - 1}-01-01`);
        const months = await spanPillRow(page, "months");
        expect(months.filter((pill) => pill.disabled)).toEqual([]);
    });

    test("picking a month slides the calendar instead of leaving the day view", async ({ page }) => {
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-01-01`);
        await waitForDayChart(page);
        await toggleMore(page);

        const from = await selectedDayPill(page);
        const dayOfMonth = from.slice(8);
        const target = `${THIS_YEAR - 1}-03-01`;
        await clickSpanPill(page, "years", `${THIS_YEAR - 1}-01-01`);
        await clickSpanPill(page, "months", target);
        await waitForDayChart(page);

        // Still the day view -- the width toggle is the tell, since only the
        // day view lights a minutes stop.
        expect(await activeStops(page)).not.toEqual(["D"]);
        // The same day of the month, in the month that was picked.
        expect(await selectedDayPill(page)).toBe(`${THIS_YEAR - 1}-03-${dayOfMonth}`);
        // And the calendar moved with it.
        expect(await dayPillDates(page)).toContain(`${THIS_YEAR - 1}-03-01`);
    });

    test("a day of the month the target month does not have is clamped into it", async ({ page }) => {
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-01-01`);
        await waitForDayChart(page);
        await toggleMore(page);

        // The 31st of a long month, then February, which has no 31st.
        await clickSpanPill(page, "years", `${THIS_YEAR - 1}-01-01`);
        await clickSpanPill(page, "months", `${THIS_YEAR - 1}-01-01`);
        await waitForDayChart(page);
        await clickDayPill(page, `${THIS_YEAR - 1}-01-31`);
        await waitForDayChart(page);

        await clickSpanPill(page, "months", `${THIS_YEAR - 1}-02-01`);
        await waitForDayChart(page);
        const landed = await selectedDayPill(page);
        expect(landed.startsWith(`${THIS_YEAR - 1}-02-2`)).toBe(true);
        expect(await dayPillDates(page)).not.toContain(`${THIS_YEAR - 1}-02-30`);
    });
});

/**
 * A calendar month is drawn whole, and a month does not respect either end of
 * what the card can open: the recorder purges raw states mid-month, and the
 * forecast stops mid-month at the other end. Those days keep their cell -- a
 * grid that changed shape month to month would stop reading as a calendar --
 * and lose their click.
 */
test.describe("days the calendar cannot open", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    test("days below the day view's floor are shown but not takeable", async ({ page }) => {
        // The aggregates reach back two years; the raw states only to the 10th
        // of the month two months ago, which is where the day view stops.
        const floorMonth = monthsBack(2);
        const dayFloor = `${floorMonth}-10`;
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-01-01`, dayFloor);
        await waitForDayChart(page);
        await clickDayPill(page, isoDay(0));
        await toggleMore(page);
        await clickSpanPill(page, "months", `${floorMonth}-01`);
        await waitForDayChart(page);

        const unreachable = await unreachableDayPills(page);
        expect(unreachable).toContain(`${floorMonth}-09`);
        expect(unreachable).not.toContain(`${floorMonth}-10`);
        // The cells are still there; only the clicks went.
        expect(await dayPillDates(page)).toContain(`${floorMonth}-01`);
    });
});

/** The lit day pill's date, or "" when the row lights none. */
async function selectedDayPill(page: Page): Promise<string> {
    return page.evaluate(() => (document.querySelector("helman-solar-inspector") as any)
        .shadowRoot.querySelector("helman-solar-day-pills")
        ?.shadowRoot?.querySelector(".pill.selected")?.getAttribute("data-day") ?? "");
}

/** The labels of the width toggle's active stops. */
async function activeStops(page: Page): Promise<string[]> {
    return page.evaluate(() => [...(document.querySelector("helman-solar-inspector") as any)
        .shadowRoot.querySelectorAll(".slot-size-button")]
        .filter((button: Element) => button.classList.contains("active"))
        .map((button: Element) => button.textContent?.trim() ?? ""));
}

/** A date `offset` days from today, as the card keys days. */
function isoDay(offset: number): string {
    return new Date(NOW.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
}

/** `YYYY-MM` for the month `count` months before this one. */
function monthsBack(count: number): string {
    const moved = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - count, 1));
    return moved.toISOString().slice(0, 7);
}
