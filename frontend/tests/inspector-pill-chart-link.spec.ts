import { test, expect, type Page } from "@playwright/test";
import {
    STOP_MONTH_VIEW,
    STOP_SLOT_60,
    STOP_YEAR_VIEW,
    clickStop,
    columns,
    clickColumn,
    columnsWithClass,
    dayPillDates,
    dayPillsWithClass,
    hoverColumn,
    hoverDayPill,
    hoverSpanPill,
    clickSpanPill,
    loadCardBundle,
    spanPillsWithClass,
    unreachableDayPills,
    mountInspector,
    toggleMore,
    waitForAggregateChart,
    waitForDayChart,
} from "./support/inspector-aggregate-harness";

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
 * is the one it already draws: blue `--primary-color` is the day the card has
 * loaded, amber `--helman-selection` is the column the reader clicked to read
 * its numbers. They mean different things and can land on one pill.
 */

const THIS_YEAR = new Date().getUTCFullYear();

/** `SELECTION_COLOR` as the browser resolves it: the card's one highlight amber. */
const AMBER = "rgb(245, 158, 11)";

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

    test("the clicked column's day wears the chart's amber in the row", async ({ page }) => {
        await openDayColumnsWithPills(page);

        const keys = await columns(page);
        const index = Math.floor(keys.length / 2);
        await clickColumn(page, index);
        expect(await dayPillsWithClass(page, "bucket-selected")).toEqual([keys[index]]);
        // The column it came from is still the selected one, so the two sides
        // are saying the same thing rather than the row having its own idea.
        expect(await columnsWithClass(page, "selected")).toEqual([keys[index]]);

        // Clicking it again clears the selection, on both sides.
        await clickColumn(page, index);
        expect(await dayPillsWithClass(page, "bucket-selected")).toEqual([]);
        expect(await columnsWithClass(page, "selected")).toEqual([]);
    });

    test("the browsed day and the selected column can be one pill", async ({ page }) => {
        await openDayColumnsWithPills(page);

        // A theme background, because both fills are a `color-mix` against it
        // and a page without one computes them transparent -- which would make
        // "the amber took the fill" vacuously true.
        await page.evaluate(() => {
            (document.querySelector("helman-solar-inspector") as HTMLElement)
                .style.setProperty("--card-background-color", "#ffffff");
        });

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

        // Amber takes the border and the fill on the chart's selected day.
        await expect.poll(() => look(wanted).then((seen) => seen.borderColor))
            .toBe(AMBER);
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
        // The amber is unchanged -- it still says "this is the column being
        // read" exactly as it did before the other state arrived.
        expect(both.borderColor).toBe(AMBER);
        expect(both.background).toBe(bucketOnly.background);
        // And the blue ring survives underneath it, which is the whole reason
        // the two can coexist: neither claim is lost.
        expect(both.boxShadow).toContain("inset");
        expect(both.boxShadow).toContain("37, 99, 235");
    });

    test("a month column lights no pill", async ({ page }) => {
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-01-01`);
        await waitForDayChart(page);
        await clickStop(page, STOP_YEAR_VIEW);
        await waitForAggregateChart(page);
        await toggleMore(page);

        // The row is on screen and full of days, so "nothing lit" is a real
        // answer rather than an empty row's.
        expect((await dayPillDates(page)).length).toBeGreaterThan(20);

        await hoverColumn(page, 3);
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

    test("a day the row cannot open is still lit when the chart names it", async ({ page }) => {
        // The aggregates reach two years back; the raw states a day view needs
        // stop at the 10th of the month two months ago.
        const floorMonth = monthsBack(2);
        await mountInspector(page, false, "", `${THIS_YEAR - 2}-01-01`, `${floorMonth}-10`);
        await waitForDayChart(page);
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);
        await toggleMore(page);

        const unreachable = await unreachableDayPills(page);
        expect(unreachable.length).toBeGreaterThan(0);

        // Following the pointer is what the highlight is for, so a day the row
        // cannot open is highlighted like any other -- the column is real and
        // the reader is looking at it. What says it cannot be opened is the
        // dimming, which the highlight must not undo.
        const index = (await columns(page)).indexOf(unreachable[0]);
        expect(index).toBeGreaterThanOrEqual(0);
        await hoverColumn(page, index);
        expect(await dayPillsWithClass(page, "hovered")).toContain(unreachable[0]);

        // Polled, not read once: .pill transitions border-color over 120ms, so
        // a single read lands on whatever frame the animation is on.
        await expect
            .poll(() => pillBorderColor(page, unreachable[0]))
            .toBe(AMBER);
        // And the dimming, which is what says it cannot be opened, survives it.
        expect(await pillOpacity(page, unreachable[0])).toBe("0.4");
    });
});

/** One pill's resolved opacity. */
async function pillOpacity(page: Page, day: string): Promise<string> {
    return page.evaluate((wanted) => {
        const pill = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-day-pills")
            ?.shadowRoot?.querySelector(`.pill[data-day="${wanted}"]`);
        return pill ? getComputedStyle(pill).opacity : "";
    }, day);
}

/** One pill's resolved top border colour. */
async function pillBorderColor(page: Page, day: string): Promise<string> {
    return page.evaluate((wanted) => {
        const pill = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-day-pills")
            ?.shadowRoot?.querySelector(`.pill[data-day="${wanted}"]`);
        return pill ? getComputedStyle(pill).borderTopColor : "";
    }, day);
}

/** `YYYY-MM` for the month `count` months before this one. */
function monthsBack(count: number): string {
    const now = new Date();
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

    test("the clicked column's month wears the chart's amber in the row", async ({ page }) => {
        await openMonthColumns(page);
        const wanted = (await columns(page))[4];

        await clickColumn(page, 4);
        expect(await spanPillsWithClass(page, "months", "bucket-selected")).toEqual([wanted]);
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

        // The closed row runs from today to the end of the forecast, so it is
        // the window that reliably holds days that have not happened yet.
        const forward = await pillBorderStyles(page);
        expect(forward.length).toBeGreaterThan(0);
        expect(forward.some((pill) => !pill.history)).toBe(true);
        for (const pill of forward) {
            expect(pill.border).toBe(pill.history ? "solid" : "dashed");
        }

        // And a month that is entirely behind, for the other half of the rule.
        // March of this year: one press, since the year row does not move.
        await toggleMore(page);
        await clickSpanPill(page, "months", `${THIS_YEAR}-03-01`);
        await waitForDayChart(page);

        const past = await pillBorderStyles(page);
        expect(past.length).toBeGreaterThan(0);
        expect(past.some((pill) => pill.history)).toBe(true);
        for (const pill of past) {
            expect(pill.border).toBe(pill.history ? "solid" : "dashed");
        }
    });
});

/** Every day pill's measured-ness and its resolved border style. */
async function pillBorderStyles(
    page: Page,
): Promise<Array<{ history: boolean; border: string }>> {
    return page.evaluate(() => {
        const root = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-day-pills")?.shadowRoot;
        if (!root) return [];
        return [...root.querySelectorAll(".pill")].map((pill: Element) => ({
            history: pill.getAttribute("data-history") === "true",
            border: getComputedStyle(pill).borderTopStyle,
        }));
    });
}
