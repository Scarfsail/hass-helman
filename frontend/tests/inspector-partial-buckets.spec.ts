import { test, expect, type Page } from "@playwright/test";

import { loadCardBundle, mountInspector, clickStop, STOP_SLOT_60 } from "./support/inspector-aggregate-harness";

/**
 * #202: an hour that is only partly measured must not read the same as an hour
 * the forecast genuinely called low.
 *
 * The harness's day fixture (`inspector-aggregate-harness.ts`) fills the house
 * actual series across the whole day with no holes; this punches a two-slot
 * hole into it at 10:15-10:45 after mount, the same way `slot-selection.spec.ts`
 * edits `el._payload` in place, and checks the three places the mark can show:
 * the chart's scrim at 60 minutes, the same hole marked slot by slot at the
 * native 15, and the totals chip.
 */

/** Drop the given "HH:MM" slots from `houseActual`, leaving a hole in the day. */
async function punchHouseActualHole(page: Page, slots: string[]): Promise<void> {
    await page.evaluate((wanted) => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const payload = JSON.parse(JSON.stringify(el._payload));
        payload.series.houseActual = payload.series.houseActual.filter(
            (p: { timestamp: string }) => !wanted.includes(p.timestamp.slice(11, 16)),
        );
        // The harness's day fixture carries no day totals (they are a backend
        // figure, not derived from the series here); the totals chip renders
        // nothing at all -- incomplete mark included -- for a metric with no
        // value, so this stands one up to test the mark against.
        payload.totals.houseActualWh = -18000;
        el._payload = payload;
        el.requestUpdate();
    }, slots);
    await page.waitForFunction(() => !!(document.querySelector("helman-solar-inspector") as any)
        .updateComplete);
}

/** The chart's partial-bucket scrim rects, by the bucket-start minute they carry. */
async function partialBucketMarks(page: Page): Promise<number[]> {
    return page.evaluate(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        return [...el.shadowRoot.querySelectorAll(".chart-wrap svg rect.partial-bucket-mark")]
            .map((rect: Element) => Number(rect.getAttribute("data-bucket-start")));
    });
}

/** Whether the daily-totals "house" chip carries the incomplete marker. */
async function houseChipIncomplete(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const sections = [...el.shadowRoot.querySelectorAll(".metrics-section")];
        const totals = sections.find((section: Element) =>
            section.querySelector("strong")?.textContent?.includes("Daily totals"));
        for (const card of totals?.querySelectorAll(".metric-card.merged") ?? []) {
            if (card.querySelector(".metric-label")?.textContent?.includes("House")) {
                return !!card.querySelector(".incomplete-mark");
            }
        }
        return false;
    });
}

test.describe("a day with a hole inside one hour", () => {
    test("marks the 10:00 column at 60 minutes and its own slots at 15", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page);
        await punchHouseActualHole(page, ["10:15", "10:30"]);

        // Native 15-minute width: the missing slots mark themselves. The other
        // series still draw in those columns, so leaving them unmarked would
        // make the day read as clean here and broken one width later. The
        // harness opens at 30, so this width has to be asked for explicitly.
        await clickStop(page, 0);
        expect(await partialBucketMarks(page)).toEqual([615, 630]); // 10:15, 10:30

        await clickStop(page, STOP_SLOT_60);
        expect(await partialBucketMarks(page)).toEqual([600]); // 10:00
    });

    test("says how many readings are missing out of how many the column holds", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page);
        await punchHouseActualHole(page, ["10:15", "10:30"]);
        await clickStop(page, STOP_SLOT_60);

        // The denominator is the point: "2" alone cannot be read as half an
        // hour lost out of an hour rather than a rounding error.
        const title = await page.evaluate(() => {
            const el = document.querySelector("helman-solar-inspector") as any;
            return el.shadowRoot.querySelector(".chart-wrap svg rect.partial-bucket-mark title")
                ?.textContent ?? "";
        });
        expect(title).toContain("2 of 4");
        expect(title).toContain("50%");
    });

    test("marks the daily-totals house chip, and no other chip", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page);
        await punchHouseActualHole(page, ["10:15", "10:30"]);
        await clickStop(page, STOP_SLOT_60);

        expect(await houseChipIncomplete(page)).toBe(true);

        // The solar chip's series is untouched, so it must not pick up a mark
        // just because some other series on the same card did.
        const solarIncomplete = await page.evaluate(() => {
            const el = document.querySelector("helman-solar-inspector") as any;
            const sections = [...el.shadowRoot.querySelectorAll(".metrics-section")];
            const totals = sections.find((section: Element) =>
                section.querySelector("strong")?.textContent?.includes("Daily totals"));
            for (const card of totals?.querySelectorAll(".metric-card.merged") ?? []) {
                if (card.querySelector(".metric-label")?.textContent?.includes("Solar")) {
                    return !!card.querySelector(".incomplete-mark");
                }
            }
            return null;
        });
        expect(solarIncomplete).toBe(false);
    });
});

test.describe("a complete day", () => {
    test("is unmarked at every width, and the totals carry no marker", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page);

        for (const stop of [0, 1, STOP_SLOT_60]) {
            await clickStop(page, stop);
            expect(await partialBucketMarks(page)).toEqual([]);
        }
        expect(await houseChipIncomplete(page)).toBe(false);
    });
});
