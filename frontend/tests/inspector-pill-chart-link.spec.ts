import { test, expect, type Page } from "@playwright/test";
import {
    STOP_MONTH_VIEW,
    STOP_SLOT_60,
    STOP_YEAR_VIEW,
    clickStop,
    columns,
    clickColumn,
    clickGutter,
    columnsWithClass,
    dayPillDates,
    dayPillsWithClass,
    hoverColumn,
    hoverDayPill,
    hoverSpanPill,
    clickDayPill,
    clickSpanPill,
    loadCardBundle,
    spanPillsWithClass,
    unreachableDayPills,
    mountInspector,
    toggleMore,
    waitForAggregateChart,
    waitForDayChart,
} from "./support/inspector-aggregate-harness";
import { FIXED_NOW_ISO, FIXED_TODAY, FIXED_YEAR } from "./support/fixed-clock";

/**
 * The day pills and the aggregate chart, as one surface.
 *
 * At D a column *is* a day, and once the picker puts the day pills on screen
 * the same day is drawn twice, a few pixels apart. Two elements each working
 * out its own highlight would be two answers to one question — so the card
 * holds the hovered day and both are handed it back, which is what lets a
 * hover on either light the other.
 *
 * The colours are the ones already in the card, and the distinction they draw
 * is the one it already draws: `--primary-color` is the day the card has
 * loaded, `--helman-grid-import` is a column the reader picked to read its
 * numbers -- the same blue the chart fills that column with, because picked
 * has to look the same on both sides. Amber `--helman-selection` is hover,
 * here as in the chart. The two selections mean different things and can land
 * on one pill.
 */

const THIS_YEAR = FIXED_YEAR;

/** `SELECTION_COLOR` as the browser resolves it: the card's one highlight amber. */
const AMBER = "rgb(245, 158, 11)";

/** The card's navigation blue: the --primary-color fallback, resolved. */
const BLUE = "rgb(37, 99, 235)";

/** `GRID_IMPORT_COLOR`, the selection blue the chart fills a picked column with. */
const SELECTED_BLUE = "rgb(37, 99, 235)";

/**
 * A `--primary-color` the harness sets to something that is not the selection
 * blue.
 *
 * Both default to `#2563eb`, so on a bare page the "loaded day" border and the
 * "picked column" border resolve to one string, and an assertion about either
 * would pass with the other rule deleted. A theme colour separates them.
 */
const THEME_PRIMARY = "#7c3aed";
const THEME_PRIMARY_RGB = "rgb(124, 58, 237)";

/** The D view with the picker open: columns and pills showing the same month. */
async function openDayColumnsWithPills(page: Page): Promise<void> {
    await mountInspector(page, false, "", `${THIS_YEAR - 2}-01-01`);
    await waitForDayChart(page);
    await clickStop(page, STOP_MONTH_VIEW);
    await waitForAggregateChart(page);
    await toggleMore(page);
}

test.describe("the day pills and the chart highlight together", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    test("hovering a column lights its pill", async ({ page }) => {
        await openDayColumnsWithPills(page);

        const keys = await columns(page);
        const index = Math.floor(keys.length / 2);
        const wanted = keys[index];
        // The pill has to exist for the assertion to mean anything: the row is
        // the whole month, the columns are the month's days.
        expect(await dayPillDates(page)).toContain(wanted);

        await hoverColumn(page, index);
        expect(await dayPillsWithClass(page, "hovered")).toEqual([wanted]);
    });

    test("hovering a pill lights its column", async ({ page }) => {
        await openDayColumnsWithPills(page);

        const keys = await columns(page);
        const wanted = keys[Math.floor(keys.length / 2)];

        await hoverDayPill(page, wanted);
        expect(await columnsWithClass(page, "hovered")).toEqual([wanted]);
        // And the pill wears the same class it would have from a chart hover:
        // one rule, so the two directions are indistinguishable.
        expect(await dayPillsWithClass(page, "hovered")).toEqual([wanted]);
    });

    test("leaving a pill clears both", async ({ page }) => {
        await openDayColumnsWithPills(page);

        const wanted = (await columns(page))[2];
        await hoverDayPill(page, wanted);
        expect(await columnsWithClass(page, "hovered")).toEqual([wanted]);

        await hoverDayPill(page, null);
        expect(await columnsWithClass(page, "hovered")).toEqual([]);
        expect(await dayPillsWithClass(page, "hovered")).toEqual([]);
    });

    test("the clicked column's day wears the chart's selection blue in the row", async ({ page }) => {
        await openDayColumnsWithPills(page);

        const keys = await columns(page);
        const index = Math.floor(keys.length / 2);
        await clickColumn(page, index);
        expect(await dayPillsWithClass(page, "bucket-selected")).toEqual([keys[index]]);
        // The column it came from is still the selected one, so the two sides
        // are saying the same thing rather than the row having its own idea.
        expect(await columnsWithClass(page, "selected")).toEqual([keys[index]]);

        // A plain click replaces rather than toggles -- the day view's own
        // semantics -- so pressing the same column again leaves it picked, and
        // it is a press in the gutter that clears both sides.
        await clickColumn(page, index);
        expect(await columnsWithClass(page, "selected")).toEqual([keys[index]]);

        await clickGutter(page);
        expect(await dayPillsWithClass(page, "bucket-selected")).toEqual([]);
        expect(await columnsWithClass(page, "selected")).toEqual([]);
    });

    test("every column of a multi-column selection lights its pill", async ({ page }) => {
        await openDayColumnsWithPills(page);

        // Three columns picked with ctrl, the day view's own add-to-selection
        // gesture. The row has to light all three: one pill lit under a chart
        // showing three would be the two halves disagreeing about what is
        // picked, which is the whole thing this phase is closing.
        const keys = await columns(page);
        await clickColumn(page, 2);
        await clickColumn(page, 4, { ctrlKey: true });
        await clickColumn(page, 6, { ctrlKey: true });

        const wanted = [keys[2], keys[4], keys[6]];
        expect(await columnsWithClass(page, "selected")).toEqual(wanted);
        expect(await dayPillsWithClass(page, "bucket-selected")).toEqual(wanted);

        // And a shift-extend, whose run has to reach the row the same way.
        await clickColumn(page, 2);
        await clickColumn(page, 5, { shiftKey: true });
        const run = keys.slice(2, 6);
        expect(await dayPillsWithClass(page, "bucket-selected")).toEqual(run);

        await clickGutter(page);
        expect(await dayPillsWithClass(page, "bucket-selected")).toEqual([]);
    });

    test("the browsed day and the selected column can be one pill", async ({ page }) => {
        await openDayColumnsWithPills(page);

        // A theme background, because both fills are a `color-mix` against it
        // and a page without one computes them transparent -- which would make
        // "the picked column took the fill" vacuously true.
        //
        // And a theme --primary-color, because its fallback is the very colour
        // the selection blue is: unset, the loaded day and the picked column
        // resolve to one string and every assertion below would pass with the
        // .bucket-selected rule deleted.
        await page.evaluate((primary) => {
            const card = document.querySelector("helman-solar-inspector") as HTMLElement;
            card.style.setProperty("--card-background-color", "#ffffff");
            card.style.setProperty("--primary-color", primary);
        }, THEME_PRIMARY);

        const keys = await columns(page);
        const wanted = keys[Math.floor(keys.length / 2)];
        await clickColumn(page, keys.indexOf(wanted));

        // The card never lights both itself -- it clears the bucket on the way
        // into the day view -- so the coincidence is staged on the element.
        // What is under test is the styling contract, not that route.
        //
        // Read through a poll rather than once: the pill transitions its border
        // and background over 120ms, so a single read lands mid-animation and
        // compares against a colour that is on its way somewhere.
        const look = (day: string) => page.evaluate((wanted) => {
            const pill = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-day-pills")
                .shadowRoot.querySelector(`.pill[data-day="${wanted}"]`) as HTMLElement;
            const style = getComputedStyle(pill);
            return {
                classes: [...pill.classList].sort().join(" "),
                background: style.backgroundColor,
                borderColor: style.borderTopColor,
                boxShadow: style.boxShadow,
            };
        }, day);

        // The selection blue takes the border and the fill on the picked day.
        await expect.poll(() => look(wanted).then((seen) => seen.borderColor))
            .toBe(SELECTED_BLUE);
        const bucketOnly = await look(wanted);
        expect(bucketOnly.classes.split(" ")).toContain("bucket-selected");
        expect(bucketOnly.classes.split(" ")).not.toContain("selected");
        expect(bucketOnly.background).not.toBe("rgba(0, 0, 0, 0)");
        // Nothing else is claiming this pill yet, so there is no ring.
        expect(bucketOnly.boxShadow).toBe("none");

        // Now let the card's browsed day land on the same pill.
        await page.evaluate((day) => {
            const pills = (document.querySelector("helman-solar-inspector") as any)
                .shadowRoot.querySelector("helman-solar-day-pills") as any;
            pills.selectedDate = day;
            return pills.updateComplete;
        }, wanted);

        await expect.poll(() => look(wanted).then((seen) => seen.classes))
            .toBe("bucket-selected history pill selected");
        const both = await look(wanted);
        // The selection fill is unchanged -- it still says "this is a column
        // being read" exactly as it did before the other state arrived.
        expect(both.borderColor).toBe(SELECTED_BLUE);
        expect(both.background).toBe(bucketOnly.background);
        // And the blue ring survives underneath it, which is the whole reason
        // the two can coexist: neither claim is lost.
        expect(both.boxShadow).toContain("inset");
        expect(both.boxShadow).toContain(THEME_PRIMARY_RGB.slice(4, -1));
        // The two are separable, which is the whole point: the ring is the
        // theme's colour and the fill is the chart's, and neither has taken
        // the other's.
        expect(THEME_PRIMARY_RGB).not.toBe(SELECTED_BLUE);
        expect(both.borderColor).not.toBe(THEME_PRIMARY_RGB);
    });

    test("a month column lights no pill", async ({ page }) => {
        // Opened expanded, so "no day row at M" is the view's doing rather than
        // the picker merely being shut.
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-01-01`);
        await waitForDayChart(page);
        await toggleMore(page);
        await clickStop(page, STOP_YEAR_VIEW);
        await waitForAggregateChart(page);

        // At M there is no day row at all -- the chart is drawing a year a
        // month at a time, so there is no one month a calendar would be about
        // -- and no toggle either, there being nothing for it to open.
        expect(await dayPillDates(page)).toEqual([]);
        expect(await hasMoreToggle(page)).toBe(false);
        await clickColumn(page, 3);
        expect(await dayPillDates(page)).toEqual([]);

        // Hovering a month column therefore lights no day pill, there being
        // none -- the month row is what lights instead.
        await hoverColumn(page, 5);
        expect(await dayPillsWithClass(page, "hovered")).toEqual([]);
        // The chart still highlights its own column — only the correspondence
        // to a day is missing at M, not the hover.
        expect((await columnsWithClass(page, "hovered")).length).toBe(1);
    });
});

/**
 * The three edges of the correlation, each of which was drawing something the
 * card could not back up.
 *
 * The link exists only where a column is a day, which is the month view alone:
 * the day view has the row on screen with no bucket chart beside it, and the
 * year view has a chart whose columns are months. And it is hover state with no
 * `mouseleave` to depend on, because a node taken out from under the pointer
 * never fires one.
 */
test.describe("where the correlation does and does not reach", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    test("a pill hover in the day view never reaches the card", async ({ page }) => {
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-01-01`);
        await waitForDayChart(page);
        await toggleMore(page);

        const days = await dayPillDates(page);
        const wanted = days[Math.floor(days.length / 2)];
        await hoverDayPill(page, wanted);

        // `.hovered` is the card's answer coming back down. In the day view
        // there is nothing to correlate with, so the card must not have one --
        // the pointer's own `:hover` is already drawing the border.
        expect(await dayPillsWithClass(page, "hovered")).toEqual([]);
    });

    test("a hover does not survive the view it was made in", async ({ page }) => {
        await openDayColumnsWithPills(page);
        await hoverColumn(page, 0);
        expect((await dayPillsWithClass(page, "hovered")).length).toBe(1);

        // Leaving by a control rather than by the pointer: the row and the
        // chart are unmounted under it, so no `mouseleave` is coming.
        await clickStop(page, STOP_YEAR_VIEW);
        await waitForAggregateChart(page);
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);
        await toggleMore(page);

        expect(await dayPillsWithClass(page, "hovered")).toEqual([]);
        expect(await columnsWithClass(page, "hovered")).toEqual([]);
    });

    test("at D every day is takeable, because pressing one only picks a column", async ({ page }) => {
        // The aggregates reach two years back; the raw states a day view needs
        // stop at the 10th of the month two months ago. In the day view that
        // floor disables pills, because a press there opens the day. At D a
        // press picks a column instead, and the column exists either way -- so
        // the floor has nothing to say about it.
        const floorMonth = monthsBack(2);
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-01-01`, `${floorMonth}-10`);
        await waitForDayChart(page);
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);
        await toggleMore(page);
        await clickSpanPill(page, "months", `${floorMonth}-01`);
        await waitForAggregateChart(page);

        // The month straddles the floor, so this is the case that would have
        // disabled pills under the old rule.
        const days = await dayPillDates(page);
        expect(days).toContain(`${floorMonth}-09`);
        expect(await unreachableDayPills(page)).toEqual([]);

        // And pressing the one below the floor picks its column rather than
        // trying to open a day the recorder cannot answer for.
        await clickDayPill(page, `${floorMonth}-09`);
        expect(await page.evaluate(() => (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-aggregate-chart")
            .shadowRoot.querySelector(".bucket-column.selected")?.getAttribute("data-bucket")))
            .toBe(`${floorMonth}-09`);
    });
});

/** `YYYY-MM` for the month `count` months before this one. */
function monthsBack(count: number): string {
    const now = new Date(FIXED_NOW_ISO);
    const moved = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - count, 1));
    return moved.toISOString().slice(0, 7);
}

/**
 * The same correlation one granularity up.
 *
 * At M a column is a month and the picker's month row is showing months, so
 * the pair is exactly the pair the day pills and the day columns make at D --
 * and it has to behave identically, because a reader moving between the two
 * granularities is doing one thing, not two. The year row never joins in: a
 * year is not a bucket in either view.
 */
test.describe("the month row and the month columns", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    /** The M view, whose columns are months and whose month row matches them. */
    async function openMonthColumns(page: Page): Promise<void> {
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-01-01`);
        await waitForDayChart(page);
        await clickStop(page, STOP_YEAR_VIEW);
        await waitForAggregateChart(page);
    }

    test("hovering a month column lights its pill", async ({ page }) => {
        await openMonthColumns(page);
        const all = await columns(page);
        const wanted = all[2];

        await hoverColumn(page, 2);
        expect(await spanPillsWithClass(page, "months", "hovered")).toEqual([wanted]);
        // And never the year row, which has no column behind it.
        expect(await spanPillsWithClass(page, "years", "hovered")).toEqual([]);
    });

    test("hovering a month pill lights its column", async ({ page }) => {
        await openMonthColumns(page);
        const wanted = (await columns(page))[3];

        await hoverSpanPill(page, "months", wanted);
        expect(await columnsWithClass(page, "hovered")).toEqual([wanted]);

        await hoverSpanPill(page, "months", null);
        expect(await columnsWithClass(page, "hovered")).toEqual([]);
    });

    test("the clicked column's month wears the chart's selection blue in the row", async ({ page }) => {
        await openMonthColumns(page);
        const wanted = (await columns(page))[4];

        await clickColumn(page, 4);
        expect(await spanPillsWithClass(page, "months", "bucket-selected")).toEqual([wanted]);
    });

    test("every month of a multi-column selection lights its pill", async ({ page }) => {
        await openMonthColumns(page);
        const all = await columns(page);

        await clickColumn(page, 1);
        await clickColumn(page, 3, { ctrlKey: true });
        const wanted = [all[1], all[3]];
        expect(await columnsWithClass(page, "selected")).toEqual(wanted);
        expect(await spanPillsWithClass(page, "months", "bucket-selected")).toEqual(wanted);
        // The year row is never a bucket, so it stays out of it however many
        // months are picked.
        expect(await spanPillsWithClass(page, "years", "bucket-selected")).toEqual([]);

        await clickGutter(page);
        expect(await spanPillsWithClass(page, "months", "bucket-selected")).toEqual([]);
    });

    test("a day column never lights a month pill", async ({ page }) => {
        // The mirror of "a month column lights no pill": at D the columns are
        // days, so the month row is a navigation control and nothing else.
        await openDayColumnsWithPills(page);
        await hoverColumn(page, 0);
        expect(await spanPillsWithClass(page, "months", "hovered")).toEqual([]);
    });
});

/**
 * Dashed means forecast, everywhere on this card.
 *
 * Every series in the chart sets a dash pattern on its forecast half and
 * leaves the measured half solid. A pill makes the same claim about a whole
 * day, so it has to draw it the same way round.
 */
test.describe("the pill row's border says which days have happened", () => {
    // Both kinds of day have to be on screen at once for this test to say
    // anything, and it reads them off the expanded calendar of the month the
    // page believes it is in. The suite's fixed clock is what supplies that: it
    // sits mid-month, so the month has measured days behind it and forecast
    // days ahead of it. See `fixed-clock`.
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    test("a measured day is solid and a forecast day is dashed", async ({ page }) => {
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-01-01`);
        await waitForDayChart(page);
        // `border: 1px solid var(--divider-color)` is invalid at computed-value
        // time when the variable is unset, which collapses the whole shorthand
        // to `none` -- so the bare test page has to supply the one token the
        // border is built from before a border style can be read at all.
        await page.evaluate(() => {
            (document.querySelector("helman-solar-inspector") as HTMLElement)
                .style.setProperty("--divider-color", "#d4d4d8");
        });

        // The expanded calendar of the current month, which straddles the
        // pinned today and so holds both kinds of day at once.
        await toggleMore(page);
        const styles = await pillBorderStyles(page);
        expect(styles.some((pill) => pill.history)).toBe(true);
        expect(styles.some((pill) => !pill.history)).toBe(true);
        for (const pill of styles) {
            expect(pill.border).toBe(pill.history ? "solid" : "dashed");
        }

        // Today contains forecast values in either layout.
        const today = FIXED_TODAY;
        expect(styles.find((pill) => pill.day === today)?.border).toBe("dashed");
        await toggleMore(page);
        const closed = await pillBorderStyles(page);
        expect(closed.find((pill) => pill.day === today)?.border).toBe("dashed");
    });
});

/** Every day pill's measured-ness and its resolved border style. */
async function pillBorderStyles(
    page: Page,
): Promise<Array<{ day: string; history: boolean; border: string }>> {
    return page.evaluate(() => {
        const root = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-day-pills")?.shadowRoot;
        if (!root) return [];
        return [...root.querySelectorAll(".pill")].map((pill: Element) => ({
            day: pill.getAttribute("data-day") ?? "",
            history: pill.getAttribute("data-history") === "true",
            border: getComputedStyle(pill).borderTopStyle,
        }));
    });
}

/**
 * The hover colour is a promise about what the press will do.
 *
 * Amber is the chart's selection colour, so an amber pill says "this press
 * picks the slot the panel describes". Blue is the card's navigation colour, so
 * a blue pill says "this press changes what is on screen". Every pill is one or
 * the other, and which one depends on the view, because the same pill means
 * different things at different granularities.
 */
test.describe("what the hover colour promises", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    test("a day pill is blue in the day view and amber at D", async ({ page }) => {
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-01-01`);
        await waitForDayChart(page);
        await toggleMore(page);

        // In the day view the press loads the day: navigation, so blue.
        const day = (await dayPillDates(page))[0];
        await expect
            .poll(() => hoverBorderColor(page, `helman-solar-day-pills .pill[data-day="${day}"]`))
            .toBe(BLUE);

        // At D the same pill is a column, and the press picks it: amber.
        // No second toggle: the picker is already open and switching stops does
        // not close it, so pressing again would collapse the row being read.
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);
        const atD = (await dayPillDates(page))[0];
        await expect
            .poll(() => hoverBorderColor(page, `helman-solar-day-pills .pill[data-day="${atD}"]`))
            .toBe(AMBER);
    });

    test("a month pill is blue at D and amber at M", async ({ page }) => {
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-01-01`);
        await waitForDayChart(page);
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const month = `helman-solar-span-pills .pill-row.months .pill[data-span="${THIS_YEAR}-03-01"]`;
        // At D a month press moves the month on screen: navigation, so blue.
        await expect.poll(() => hoverBorderColor(page, month)).toBe(BLUE);

        // At M the months *are* the columns, so the press picks one: amber.
        await clickStop(page, STOP_YEAR_VIEW);
        await waitForAggregateChart(page);
        await expect.poll(() => hoverBorderColor(page, month)).toBe(AMBER);
    });
});

/**
 * Leaving an aggregate view for a minutes stop lands on the day the reader
 * pointed at, and never on a day the day view cannot draw.
 */
test.describe("what a minutes stop opens", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    test("a month picked at M opens that month, clamped to the first day there is", async ({ page }) => {
        // The aggregates reach two years back; the raw states only to the 10th
        // of the month two months ago. So a month picked at M is one the day
        // view cannot open the start of.
        const floorMonth = monthsBack(2);
        const dayFloor = `${floorMonth}-10`;
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-01-01`, dayFloor);
        await waitForDayChart(page);
        await clickStop(page, STOP_YEAR_VIEW);
        await waitForAggregateChart(page);

        const months = await columns(page);
        const index = months.indexOf(`${floorMonth}-01`);
        expect(index).toBeGreaterThanOrEqual(0);
        await clickColumn(page, index);

        await clickStop(page, STOP_SLOT_60);
        await waitForDayChart(page);
        const landed = await page.evaluate(() => {
            const requests = (window as any).__dayRequests as string[];
            return requests[requests.length - 1];
        });
        // The 1st is below the floor, so the first day there is data for wins.
        expect(landed).toBe(dayFloor);
    });
});

/**
 * Hover one pill for real and read the border colour that results.
 *
 * Playwright's selector engine pierces open shadow roots, so this is a genuine
 * pointer hover rather than a synthetic event -- which matters, because `:hover`
 * is exactly the thing a dispatched MouseEvent cannot produce.
 */
async function hoverBorderColor(page: Page, selector: string): Promise<string> {
    const pill = page.locator(selector).first();
    await pill.hover();
    return pill.evaluate((node) => getComputedStyle(node).borderTopColor);
}

/** Whether the picker's "more" toggle is on screen at all. */
async function hasMoreToggle(page: Page): Promise<boolean> {
    return page.evaluate(() => !!(document.querySelector("helman-solar-inspector") as any)
        .shadowRoot.querySelector(".nav-more"));
}

/**
 * A change of stop is a change of scale, not of subject.
 *
 * Whatever the reader had picked survives the move, reshaped to whatever a
 * column is on the other side. Losing it meant every zoom landed somewhere the
 * reader had to navigate back from.
 */
test.describe("what a change of granularity carries across", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    test("a month picked at M is the month D opens", async ({ page }) => {
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-01-01`);
        await waitForDayChart(page);
        await clickStop(page, STOP_YEAR_VIEW);
        await waitForAggregateChart(page);

        // A month that is not the browsed one, so "it opened the month I picked"
        // is distinguishable from "it opened the month it was already on".
        const wanted = `${THIS_YEAR}-03-01`;
        const index = (await columns(page)).indexOf(wanted);
        expect(index).toBeGreaterThanOrEqual(0);
        await clickColumn(page, index);

        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);
        // D is drawing that month's days.
        expect((await columns(page))[0]).toBe(wanted);
        // And no day inside it is picked, because none was.
        expect(await page.evaluate(() => (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-aggregate-chart")
            .shadowRoot.querySelector(".bucket-column.selected"))).toBeNull();
    });

    test("the day being read at 15/30/60 arrives at D already picked", async ({ page }) => {
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-01-01`);
        await waitForDayChart(page);
        await toggleMore(page);
        // A day that is not today, so the carry is visible.
        const wanted = (await dayPillDates(page))[4];
        await clickDayPill(page, wanted);
        await waitForDayChart(page);

        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);
        expect(await page.evaluate(() => (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-aggregate-chart")
            .shadowRoot.querySelector(".bucket-column.selected")?.getAttribute("data-bucket")))
            .toBe(wanted);

        // And back again lands on the same day rather than on a span start.
        await clickStop(page, STOP_SLOT_60);
        await waitForDayChart(page);
        const landed = await page.evaluate(() => {
            const requests = (window as any).__dayRequests as string[];
            return requests[requests.length - 1];
        });
        expect(landed).toBe(wanted);
    });
});

/**
 * What the calendar may offer depends on what a press does there.
 *
 * In the day view a press opens a day, so the bound is what the day view can
 * draw. At D a press picks a column, so the bound is which columns exist -- a
 * different question, and the backend answers it by clamping a span to today.
 * The back half of the current month therefore has no bucket at all.
 */
test.describe("the days the calendar may offer", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    test("at D the takeable days are exactly the days with a column", async ({ page }) => {
        // Stated as an equivalence rather than by naming a day past the end,
        // because whether the month on screen *has* such a day depends on the
        // backend: the real service clamps a span's end to today, so the back
        // half of the current month has no bucket, while the test double
        // answers for the whole month. The rule holds either way -- a pill is
        // takeable exactly when there is a column for it to pick, which is what
        // stops a press lighting a pill whose panel does not exist.
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-01-01`);
        await waitForDayChart(page);
        await toggleMore(page);
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);

        const drawn = await columns(page);
        const offered = await dayPillDates(page);
        const unreachable = await unreachableDayPills(page);
        expect(offered.length).toBeGreaterThan(0);
        expect(drawn.length).toBeGreaterThan(0);

        const takeable = offered.filter((day) => !unreachable.includes(day));
        expect(takeable).toEqual(offered.filter((day) => drawn.includes(day)));
    });

    test("the pointer's hover is withheld from a pill that cannot be pressed", async ({ page }) => {
        // The day view, where the recorder's floor disables pills.
        const floorMonth = monthsBack(2);
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-01-01`, `${floorMonth}-10`);
        await waitForDayChart(page);
        await page.evaluate(() => {
            (document.querySelector("helman-solar-inspector") as HTMLElement)
                .style.setProperty("--divider-color", "#d4d4d8");
        });
        await toggleMore(page);
        await clickSpanPill(page, "months", `${floorMonth}-01`);
        await waitForDayChart(page);

        const unreachable = await unreachableDayPills(page);
        expect(unreachable.length).toBeGreaterThan(0);
        // :hover matches a disabled button, so without the guard the blue fill
        // would land on a dimmed pill and invite a press it will ignore.
        await expect
            .poll(() => hoverBorderColor(page, `helman-solar-day-pills .pill[data-day="${unreachable[0]}"]`))
            .toBe("rgb(212, 212, 216)");
    });
});
