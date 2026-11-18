import { test, expect, type Page } from "@playwright/test";

import { FIXED_NOW_ISO } from "./support/fixed-clock";
import {
    STOP_MONTH_VIEW,
    STOP_SLOT_60,
    clickColumn,
    clickStop,
    columns,
    clickSpanPill,
    loadCardBundle,
    mountInspector as mountAggregateInspector,
    pageBackAndWait,
    waitForAggregateChart,
} from "./support/inspector-aggregate-harness";
import {
    DAY_MS,
    TODAY,
    TOMORROW,
    YESTERDAY,
    mountInspector,
    mouseDrag,
    plotBox,
    pressPill,
    readPanels,
    readView,
    solarHours,
    touchDrag,
    watchForLoading,
    type ViewState,
} from "./support/pan-inspector";

/**
 * Dragging the solar inspector's day view freely through time.
 *
 * A left-button or one-finger drag on the chart and the strips under it moves
 * the window continuously, across midnight, and leaves it where it is dropped.
 * The part past midnight draws the neighbouring day, aligned with the selected
 * one, and whichever day covers most of the window becomes the selected day --
 * the pills, the totals and the slot detail follow it, with no load.
 *
 * The three-day fixture lives in `support/pan-inspector`.
 */

/** Which view the card is in: "day", or "month" and "year" for D and M. */
function viewMode(page: Page): Promise<string> {
    return page.evaluate(() => (document.querySelector("helman-solar-inspector") as any)._viewMode);
}

test.describe("dragging the inspector's day view", () => {
    test("a left drag moves the window later and draws the next day in the overhang, aligned", async ({ page }) => {
        await mountInspector(page, { daylightOnly: false });
        expect(await readView(page)).toMatchObject({ selected: TODAY, start: 0, end: 1440, overlayDate: null });
        await page.evaluate(() => {
            const chart = document.querySelector("helman-solar-inspector")!.shadowRoot!
                .querySelector("helman-solar-day-chart") as any;
            (window as any).__modelBefore = { view: chart.view, stacks: chart.stacks };
        });

        // A third of the plot is a third of the 24 h window: eight hours later.
        await mouseDrag(page, -1 / 3);
        await expect.poll(() => readView(page)).toMatchObject({
            selected: TODAY, start: 480, end: 1920, overlayDate: TOMORROW, overlayStart: 480 - 1440,
        });
        // A drag moves the scales only: the day's view and stacks are the very
        // objects they were before it.
        expect(await page.evaluate(() => {
            const chart = document.querySelector("helman-solar-inspector")!.shadowRoot!
                .querySelector("helman-solar-day-chart") as any;
            const before = (window as any).__modelBefore;
            return chart.view === before.view && chart.stacks === before.stacks;
        })).toBe(true);

        const drawn = await page.evaluate(() => {
            const root = document.querySelector("helman-solar-inspector")!.shadowRoot!;
            const base = root.querySelector("helman-solar-day-chart:not([overlay])") as any;
            const overlay = root.querySelector("helman-solar-day-chart[overlay]") as any;
            const priceBase = root.querySelector("helman-solar-price-strip:not([overlay])") as any;
            const priceOverlay = root.querySelector("helman-solar-price-strip[overlay]") as any;
            const moneyBase = root.querySelector("helman-solar-money-strip:not([overlay])") as any;
            const moneyOverlay = root.querySelector("helman-solar-money-strip[overlay]") as any;
            const midnightX = base.layout.xForMinutes(1440);
            const band = root.querySelector("helman-solar-schedule-band-strip")!.shadowRoot!
                .querySelector("scheduling-entity-day-band") as any;
            const tomorrowStartMs = Date.parse(`${overlay.date}T00:00:00Z`);
            const rects = (element: any) => [...element.shadowRoot.querySelectorAll("svg rect[fill-opacity]")]
                .map((rect: Element) => Number(rect.getAttribute("x")));
            return {
                // The same instant has one x on both instances: tomorrow 06:00 is
                // the selected day's 30:00.
                aligned: Math.abs(base.layout.xForMinutes(1440 + 360) - overlay.layout.xForMinutes(360)) < 0.01,
                overlayPlotPaths: overlay.shadowRoot.querySelectorAll(".main-chart-wrap svg g[clip-path] path").length,
                overlayAxisText: overlay.shadowRoot.querySelectorAll(".main-chart-wrap svg text").length,
                priceGeometry: [priceOverlay.geometry.startMinutes, priceOverlay.geometry.endMinutes],
                priceDate: priceOverlay.date,
                priceShared: priceBase.valueScale === priceOverlay.valueScale && priceBase.valueScale !== null,
                priceOverlayBars: rects(priceOverlay),
                moneyGeometry: [moneyOverlay.geometry.startMinutes, moneyOverlay.geometry.endMinutes],
                moneyShared: moneyBase.valueScale === moneyOverlay.valueScale && moneyBase.valueScale !== null,
                moneyOverlayBars: rects(moneyOverlay),
                midnightX,
                powerAxisShared: base.layout.maxKw === overlay.layout.maxKw,
                bandWindowEnd: band.windowEndMs,
                bandSpanEnd: band.day.endMs,
                tomorrowStartMs,
                tomorrowRun: band.lanes.some((lane: any) => lane.blocks.some((block: any) => block.startMs >= tomorrowStartMs)),
                midnightLines: base.shadowRoot.querySelectorAll(".main-chart-wrap svg line.midnight-line").length,
                axisHours: [...base.shadowRoot.querySelectorAll(".main-chart-wrap svg text")]
                    .map((text: Element) => text.textContent?.trim() ?? "")
                    .filter((text: string) => /^\d{2}$/.test(text)),
            };
        });
        expect(drawn.aligned).toBe(true);
        expect(drawn.overlayPlotPaths).toBeGreaterThan(0);
        // The overlay is plot content only: no axis of its own.
        expect(drawn.overlayAxisText).toBe(0);
        expect(drawn.priceGeometry).toEqual([480 - 1440, 1920 - 1440]);
        expect(drawn.priceDate).toBe(TOMORROW);
        expect(drawn.priceShared).toBe(true);
        expect(drawn.moneyGeometry).toEqual([480 - 1440, 1920 - 1440]);
        expect(drawn.moneyShared).toBe(true);
        expect(drawn.powerAxisShared).toBe(true);
        // Every bar the neighbour draws lies right of the selected day's midnight.
        expect(drawn.priceOverlayBars.length).toBeGreaterThan(0);
        expect(drawn.priceOverlayBars.every((x) => x >= drawn.midnightX - 0.5)).toBe(true);
        expect(drawn.moneyOverlayBars.length).toBeGreaterThan(0);
        expect(drawn.moneyOverlayBars.every((x) => x >= drawn.midnightX - 0.5)).toBe(true);
        // The schedule band reaches into tomorrow and draws tomorrow's run there.
        expect(drawn.bandWindowEnd).toBe(drawn.tomorrowStartMs + 480 * 60_000);
        expect(drawn.bandSpanEnd).toBe(drawn.tomorrowStartMs + 86_400_000);
        expect(drawn.tomorrowRun).toBe(true);
        // Midnight is marked, and the hours past it read as the clock.
        expect(drawn.midnightLines).toBe(1);
        expect(drawn.axisHours).toContain("00");
        expect(drawn.axisHours.every((hour) => Number(hour) < 24)).toBe(true);

        // No value label reaches over midnight into the other day's half, so
        // the two instances' figures cannot run together at the seam. Read on
        // a phone's width, where the columns are narrower than the figures.
        await page.setViewportSize({ width: 400, height: 1000 });
        await expect.poll(() => page.evaluate(() => (document.querySelector("helman-solar-inspector")!.shadowRoot!
            .querySelector("helman-solar-day-chart:not([overlay])") as any).layout.width)).toBeLessThan(450);
        const seamCrossings = await page.evaluate(() => {
            const root = document.querySelector("helman-solar-inspector")!.shadowRoot!;
            const base = root.querySelector("helman-solar-day-chart:not([overlay])") as any;
            // Every row's viewBox is the layout's width, so one x serves them all.
            const midnight = base.layout.xForMinutes(1440);
            const labels = (selector: string, overlay: boolean) => {
                const host = root.querySelector(`${selector}${overlay ? "[overlay]" : ":not([overlay])"}`) as any;
                return [...host.shadowRoot.querySelectorAll("svg text[font-size='9']")].map((text: any) => {
                    const box = text.getBBox();
                    return { overlay, left: box.x, right: box.x + box.width, text: text.textContent.trim() };
                });
            };
            const all = ["helman-solar-day-chart", "helman-solar-price-strip", "helman-solar-money-strip"]
                .flatMap((selector) => [...labels(selector, false), ...labels(selector, true)]);
            return {
                count: all.length,
                crossing: all.filter((label) => label.overlay ? label.left < midnight : label.right > midnight),
            };
        });
        expect(seamCrossings.count).toBeGreaterThan(0);
        expect(seamCrossings.crossing).toEqual([]);

        // Dropped is where it stays.
        await page.waitForTimeout(300);
        expect(await readView(page)).toMatchObject({ selected: TODAY, start: 480, end: 1920 });

        // A pill press restores the whole day.
        await pressPill(page, TODAY);
        await expect.poll(() => readView(page)).toMatchObject({ selected: TODAY, start: 0, end: 1440, overlayDate: null });
    });

    test("dragging past halfway hands the selection to the next day without a load", async ({ page }) => {
        await mountInspector(page, { daylightOnly: false });
        // A slot picked by a plain press, so the slot detail has something to say.
        const plot = await plotBox(page);
        await page.mouse.click(plot.left + plot.width * (14.25 / 24), plot.top + 40);
        await expect.poll(() => readView(page).then((view) => view.selection)).toEqual(["14:00"]);

        // What the panels say about each day, read the ordinary way.
        await pressPill(page, TOMORROW);
        await expect.poll(() => readView(page).then((view) => view.selected)).toBe(TOMORROW);
        await expect.poll(() => readPanels(page)).not.toEqual([]);
        const tomorrowPanels = await readPanels(page);
        await pressPill(page, TODAY);
        await expect.poll(() => readPanels(page)).not.toEqual(tomorrowPanels);
        const requestsBefore = await page.evaluate(() => (window as any).__requestedDates.length);

        await watchForLoading(page);
        await mouseDrag(page, -0.6);
        await expect.poll(() => readView(page)).toMatchObject({ selected: TOMORROW, overlayDate: TODAY });
        const view = await readView(page);
        // The window keeps its 24 h and its place: 0.6 of a day later, now
        // counted from tomorrow's midnight.
        expect(view.end - view.start).toBe(1440);
        // 864 minutes later is 14:24 tomorrow less a day, snapped to the slot grid.
        expect(view.start).toBe(Math.round((864 - 1440) / 30) * 30);
        expect(view.selection).toEqual(["14:00"]);
        // Today, now in the overhang, is washed as past only up to now: the
        // band's span takes the earlier day's editable start, not tomorrow's.
        expect(await page.evaluate(() => (document.querySelector("helman-solar-inspector")!.shadowRoot!
            .querySelector("helman-solar-schedule-band-strip")!.shadowRoot!
            .querySelector("scheduling-entity-day-band") as any).day.editableFromMs))
            .toBe(Date.parse(FIXED_NOW_ISO));
        expect(await readPanels(page)).toEqual(tomorrowPanels);
        expect(await page.evaluate(() => (window as any).__sawLoading)).toBe(false);
        // Both days were already at hand: nothing was fetched.
        expect(await page.evaluate(() => (window as any).__requestedDates.length)).toBe(requestsBefore);
    });

    test("with today in yesterday's overhang, the clock keeps moving today's now marker", async ({ page }) => {
        // Early enough that a window held mostly in yesterday still shows now.
        await mountInspector(page, { daylightOnly: false, nowIso: `${TODAY}T06:00:00.000Z` });
        // 0.6 of a day earlier: yesterday 09:36 to today 09:36.
        await mouseDrag(page, 0.6);
        await expect.poll(() => readView(page)).toMatchObject({ selected: YESTERDAY, overlayDate: TODAY });

        const nowMarkerX = () => page.evaluate(() => {
            const overlay = document.querySelector("helman-solar-inspector")!.shadowRoot!
                .querySelector("helman-solar-day-chart[overlay]") as any;
            const line = overlay.shadowRoot.querySelector(".main-chart-wrap svg line[vector-effect='non-scaling-stroke']");
            return line === null ? null : Number(line.getAttribute("x1"));
        });
        const before = await nowMarkerX();
        expect(before).not.toBeNull();

        // An hour on, and the clock's catch-up tick on returning to the tab.
        await page.clock.setFixedTime(new Date(`${TODAY}T07:00:00.000Z`));
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await expect.poll(nowMarkerX).toBeGreaterThan(before!);
    });

    test("with yesterday selected, the band still draws today's runs in the overhang", async ({ page }) => {
        await mountInspector(page, { daylightOnly: false, nowIso: `${TODAY}T06:00:00.000Z` });
        await mouseDrag(page, 0.6);
        await expect.poll(() => readView(page)).toMatchObject({ selected: YESTERDAY, overlayDate: TODAY });

        const band = await page.evaluate(() => {
            const band = document.querySelector("helman-solar-inspector")!.shadowRoot!
                .querySelector("helman-solar-schedule-band-strip")!.shadowRoot!
                .querySelector("scheduling-entity-day-band") as any;
            return band === null ? null : {
                windowStartMs: band.windowStartMs,
                windowEndMs: band.windowEndMs,
                spanStartMs: band.day.startMs,
                spanEndMs: band.day.endMs,
                editableFromMs: band.day.editableFromMs,
                runStarts: band.lanes.flatMap((lane: any) => lane.blocks.map((block: any) => block.startMs)),
            };
        });
        expect(band).not.toBeNull();
        const todayStartMs = Date.parse(`${TODAY}T00:00:00Z`);
        const yesterdayStartMs = todayStartMs - DAY_MS;
        // The window counts from yesterday's midnight, which has no schedule day.
        const view = await readView(page);
        expect(band!.windowStartMs).toBe(yesterdayStartMs + view.start * 60_000);
        expect(band!.windowEndMs).toBe(yesterdayStartMs + view.end * 60_000);
        expect(band!.spanStartMs).toBe(yesterdayStartMs);
        expect(band!.spanEndMs).toBe(todayStartMs + DAY_MS);
        // Yesterday washes as past up to now, today's own boundary.
        expect(band!.editableFromMs).toBe(Date.parse(`${TODAY}T06:00:00.000Z`));
        expect(band!.runStarts).toContain(todayStartMs + 20 * 3_600_000);
    });

    test("an hourly neighbour beside a 15-minute day keeps its own buckets and its true power", async ({ page }) => {
        await mountInspector(page, { daylightOnly: false, slotMinutes: 15, hourlyDates: [YESTERDAY] });
        const readAxes = () => page.evaluate(() => {
            const root = document.querySelector("helman-solar-inspector")!.shadowRoot!;
            const chart = root.querySelector("helman-solar-day-chart:not([overlay])") as any;
            const overlay = root.querySelector("helman-solar-day-chart[overlay]") as any;
            const strip = root.querySelector("helman-solar-price-strip[overlay]") as any;
            return {
                maxKw: chart.layout.maxKw,
                slotWidth: chart.layout.slotWidth,
                overlay: overlay === null ? null : {
                    slotMinutes: overlay.slotMinutes,
                    stripSlotMinutes: strip.slotMinutes,
                    maxKw: overlay.layout.maxKw,
                    slotWidth: overlay.layout.slotWidth,
                    corrected: overlay.view.series.corrected
                        .filter((point: { valueWh: number }) => point.valueWh > 0)
                        .map((point: { slot: string }) => point.slot),
                },
            };
        });
        const before = await readAxes();

        // Today keeps the majority, so yesterday stays a neighbour in the overhang.
        await mouseDrag(page, 0.3);
        await expect.poll(() => readView(page)).toMatchObject({ selected: TODAY, overlayDate: YESTERDAY });
        const after = await readAxes();
        // Yesterday's 800 Wh an hour is 800 W, under today's 1.2 kW: the shared
        // axis is today's alone, not a 3.2 kW peak read off 15-minute buckets.
        expect(after.maxKw).toBe(before.maxKw);
        expect(after.overlay).toMatchObject({ slotMinutes: 60, stripSlotMinutes: 60, maxKw: before.maxKw });
        // Its columns are whole hours, on the same x scale as today's quarters.
        expect(after.overlay!.slotWidth).toBeCloseTo(4 * after.slotWidth, 6);
        expect(after.overlay!.corrected).toEqual(["10:00", "11:00", "12:00", "13:00"]);
    });

    test("daylight-only: the window takes each day's solar width around the same centre", async ({ page }) => {
        // Before sunrise, so today opens at its own solar hours rather than following now.
        await mountInspector(page, { daylightOnly: true, nowIso: `${TODAY}T06:00:00.000Z` });
        const today = solarHours(0);
        const tomorrow = solarHours(1);
        expect(await readView(page)).toMatchObject({ selected: TODAY, start: today.start * 60, end: today.end * 60 });

        // Two drags, each most of a plot: the first stays on today, the second
        // carries most of the window past midnight.
        await mouseDrag(page, -0.9);
        await expect.poll(() => readView(page).then((view) => view.end > today.end * 60)).toBe(true);
        const first = await readView(page);
        expect(first.selected).toBe(TODAY);
        expect(first.end - first.start).toBe((today.end - today.start) * 60);

        // The second drag is walked in steps, to catch the handover mid-drag.
        const plot = await plotBox(page);
        const centreOf = (view: ViewState) => (view.start + view.end) / 2;
        const step = 20;
        const y = plot.top + 40;
        let x = plot.left + plot.width - 4;
        await page.mouse.move(x, y);
        await page.mouse.down();
        let before = first;
        let after = first;
        while (after.selected === TODAY && x > plot.left + step) {
            before = after;
            x -= step;
            await page.mouse.move(x, y);
            await page.waitForTimeout(50);
            after = await readView(page);
        }
        expect(after.selected).toBe(TOMORROW);
        // The new day's own width...
        expect(after.end - after.start).toBe((tomorrow.end - tomorrow.start) * 60);
        // ...around the centre the drag put there, now in tomorrow's frame.
        const oldMinutesPerPx = (today.end - today.start) * 60 / plot.width;
        expect(Math.abs(centreOf(after) + 1440 - (centreOf(before) + step * oldMinutesPerPx))).toBeLessThan(1);
        // The rest of the drag moves the content with the pointer at the new width's scale.
        x -= 100;
        await page.mouse.move(x, y);
        await page.waitForTimeout(50);
        const moved = await readView(page);
        const newMinutesPerPx = (tomorrow.end - tomorrow.start) * 60 / plot.width;
        expect(Math.abs(centreOf(moved) - centreOf(after) - 100 * newMinutesPerPx)).toBeLessThan(1);
        await page.mouse.up();

        // A pill press snaps back to that day's solar window.
        await pressPill(page, TOMORROW);
        await expect.poll(() => readView(page)).toMatchObject({
            selected: TOMORROW, start: tomorrow.start * 60, end: tomorrow.end * 60, overlayDate: null,
        });
    });

    test("daylight off: the window stays 24 h through a drag and a pill restores 00:00-24:00", async ({ page }) => {
        await mountInspector(page, { daylightOnly: false });
        await mouseDrag(page, 0.25);
        await expect.poll(() => readView(page)).toMatchObject({ selected: TODAY, start: -360, end: 1080, overlayDate: YESTERDAY });
        await pressPill(page, TODAY);
        await expect.poll(() => readView(page)).toMatchObject({ selected: TODAY, start: 0, end: 1440, overlayDate: null });
    });

    test("a press without movement selects a slot, a drag does not", async ({ page }) => {
        await mountInspector(page, { daylightOnly: false });
        const plot = await plotBox(page);
        await page.mouse.click(plot.left + plot.width * (10.25 / 24), plot.top + 40);
        await expect.poll(() => readView(page).then((view) => view.selection)).toEqual(["10:00"]);

        // Clear it with a press in the axis gutter, then drag across the plot.
        await page.mouse.click(plot.left - 20, plot.top + 40);
        await expect.poll(() => readView(page).then((view) => view.selection)).toEqual([]);
        await mouseDrag(page, -0.2);
        await expect.poll(() => readView(page).then((view) => view.start)).toBeGreaterThan(0);
        expect((await readView(page)).selection).toEqual([]);
    });

    test("a press over the neighbour's overhang leaves the selection alone", async ({ page }) => {
        await mountInspector(page, { daylightOnly: false });
        const plot = await plotBox(page);
        await page.mouse.click(plot.left + plot.width * (10.25 / 24), plot.top + 40);
        await expect.poll(() => readView(page).then((view) => view.selection)).toEqual(["10:00"]);

        await mouseDrag(page, -1 / 3);
        await expect.poll(() => readView(page)).toMatchObject({ start: 480, overlayDate: TOMORROW });
        // 0.9 of the plot is 21:36 past 08:00 -- tomorrow 05:36.
        await page.mouse.click(plot.left + plot.width * 0.9, plot.top + 40);
        // And on a strip under the chart, which resolves its own clicks.
        const priceY = await page.evaluate(() => {
            const rect = (document.querySelector("helman-solar-inspector")!.shadowRoot!
                .querySelector("helman-solar-price-strip:not([overlay])") as HTMLElement).getBoundingClientRect();
            return rect.top + rect.height / 2;
        });
        await page.mouse.click(plot.left + plot.width * 0.9, priceY);
        await page.waitForTimeout(100);
        expect((await readView(page)).selection).toEqual(["10:00"]);
    });

    test("a drag swallows only the click its own release makes", async ({ page }) => {
        await mountInspector(page, { daylightOnly: false });
        const plot = await plotBox(page);
        // A touch drag sends no click, so the next click -- here one with no
        // press before it, as a keyboard activation makes -- is a click.
        await touchDrag(page, -plot.width / 4, 4);
        await expect.poll(() => readView(page)).toMatchObject({ start: 360, end: 1800 });
        await page.waitForTimeout(50);
        await page.evaluate(({ x, y }) => {
            const chart = document.querySelector("helman-solar-inspector")!.shadowRoot!
                .querySelector("helman-solar-day-chart:not([overlay])") as any;
            chart.shadowRoot.querySelector(".main-chart-wrap svg").dispatchEvent(new MouseEvent("click", {
                clientX: x, clientY: y, bubbles: true, composed: true, cancelable: true,
            }));
        }, { x: plot.left + plot.width * ((615 - 360) / 1440), y: plot.top + 40 });
        await expect.poll(() => readView(page).then((view) => view.selection)).toEqual(["10:00"]);
    });

    test("a mouse moving with no button held ends a press its release never reached", async ({ page }) => {
        await mountInspector(page, { daylightOnly: false });
        await page.evaluate(() => {
            const chart = document.querySelector("helman-solar-inspector")!.shadowRoot!
                .querySelector("helman-solar-day-chart:not([overlay])") as any;
            const svg = chart.shadowRoot.querySelector(".main-chart-wrap svg") as SVGSVGElement;
            const rect = svg.getBoundingClientRect();
            const x0 = rect.left + rect.width / 2;
            const y0 = rect.top + 60;
            const send = (type: string, x: number, buttons: number) => svg.dispatchEvent(new PointerEvent(type, {
                pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons,
                clientX: x, clientY: y0, bubbles: true, composed: true, cancelable: true,
            }));
            send("pointerdown", x0, 1);
            // The release is lost; the mouse then hovers on, no button down.
            for (let step = 1; step <= 10; step += 1) send("pointermove", x0 - 20 * step, 0);
        });
        await page.waitForTimeout(100);
        expect(await readView(page)).toMatchObject({ start: 0, end: 1440, overlayDate: null });
    });

    test("with the impact row on and empty, the neighbour's SoC row stays level", async ({ page }) => {
        await mountInspector(page, { daylightOnly: false });
        await page.evaluate(() => {
            (document.querySelector("helman-solar-inspector") as any)._impactStripVisible = true;
        });
        await mouseDrag(page, -1 / 3);
        await expect.poll(() => readView(page)).toMatchObject({ overlayDate: TOMORROW });
        const tops = await page.evaluate(() => {
            const root = document.querySelector("helman-solar-inspector")!.shadowRoot!;
            const socTop = (selector: string) => (root.querySelector(selector) as any).shadowRoot
                .querySelector(".soc-strip-wrap svg").getBoundingClientRect().top;
            return [socTop("helman-solar-day-chart:not([overlay])"), socTop("helman-solar-day-chart[overlay]")];
        });
        expect(Math.abs(tops[0] - tops[1])).toBeLessThan(0.5);
    });

    test("a sideways touch drag pans and an upright one does not", async ({ page }) => {
        await mountInspector(page, { daylightOnly: false });
        const plot = await plotBox(page);

        // Synthetic pointer events skip touch-action, so check it directly: a
        // scroll container between the chart and the pan surface stops the
        // surface's pan-y reaching the chart, unless it declares its own, and
        // the browser then cancels a sideways drag that starts on the chart.
        expect(await page.evaluate(() => {
            const chart = document.querySelector("helman-solar-inspector")!.shadowRoot!
                .querySelector("helman-solar-day-chart:not([overlay])") as any;
            let element: Element | null = chart.shadowRoot.querySelector(".main-chart-wrap");
            const unpanned: string[] = [];
            while (element && !element.classList.contains("pan-surface")) {
                const style = getComputedStyle(element);
                const scrolls = style.overflowX !== "visible" || style.overflowY !== "visible";
                if (scrolls && style.touchAction !== "pan-y") unpanned.push(element.className.toString() || element.tagName);
                element = element.parentElement ?? ((element.getRootNode() as ShadowRoot).host ?? null);
            }
            return unpanned;
        })).toEqual([]);

        await touchDrag(page, 8, 200);
        await page.waitForTimeout(100);
        expect(await readView(page)).toMatchObject({ start: 0, end: 1440 });

        await touchDrag(page, -plot.width / 4, 4);
        await expect.poll(() => readView(page)).toMatchObject({ selected: TODAY, start: 360, end: 1800 });
    });

    test("the window cannot be dragged before the first day or past the last", async ({ page }) => {
        await mountInspector(page, { daylightOnly: false });
        for (let drag = 0; drag < 3; drag += 1) {
            await mouseDrag(page, -0.9);
            await page.waitForTimeout(100);
        }
        await expect.poll(() => readView(page)).toMatchObject({ selected: TOMORROW, start: 0, end: 1440 });

        for (let drag = 0; drag < 5; drag += 1) {
            await mouseDrag(page, 0.9);
            await page.waitForTimeout(100);
        }
        await expect.poll(() => readView(page)).toMatchObject({ selected: YESTERDAY, start: 0, end: 1440 });
    });
    test("a dragged window keeps its place, snapped, across a change of slot width", async ({ page }) => {
        await mountInspector(page, { daylightOnly: false, slotMinutes: 30 });
        // A tenth of the day earlier, which a 30-minute grid leaves off the hour.
        await mouseDrag(page, 0.1);
        await expect.poll(() => readView(page).then((view) => view.start)).toBeLessThan(0);
        const dragged = await readView(page);
        expect(Math.abs(dragged.start % 30)).toBe(0);

        await clickStop(page, STOP_SLOT_60);
        const snapped = Math.round(dragged.start / 60) * 60;
        await expect.poll(() => readView(page)).toMatchObject({
            selected: TODAY, start: snapped, end: snapped + 1440, overlayDate: YESTERDAY,
        });
    });

    test("a dragged window survives a trip through D and back to the same day", async ({ page }) => {
        await mountInspector(page, { daylightOnly: false, slotMinutes: 60 });
        await mouseDrag(page, -0.25);
        await expect.poll(() => readView(page)).toMatchObject({ selected: TODAY, start: 360, end: 1800 });

        await clickStop(page, STOP_MONTH_VIEW);
        await expect.poll(() => viewMode(page)).toBe("month");
        await clickStop(page, STOP_SLOT_60);
        await expect.poll(() => readView(page)).toMatchObject({
            selected: TODAY, start: 360, end: 1800, overlayDate: TOMORROW,
        });
    });

    test("a dragged window stays on its day when D pages away and back", async ({ page }) => {
        await page.setViewportSize({ width: 1200, height: 1000 });
        await loadCardBundle(page);
        await mountAggregateInspector(page);
        await page.waitForFunction(() => !!document.querySelector("helman-solar-inspector")!.shadowRoot!
            .querySelector("helman-solar-day-pills")?.shadowRoot?.querySelector(".pill.selected"));
        await mouseDrag(page, 0.25);
        await expect.poll(() => readView(page)).toMatchObject({ selected: TODAY, start: -360, end: 1080 });

        // Paging parks the date on a span start, the 1st of this month once back:
        // with no column picked, that is the day a slot width opens.
        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);
        await pageBackAndWait(page);
        await clickSpanPill(page, "months", `${TODAY.slice(0, 7)}-01`);
        await waitForAggregateChart(page);
        await clickStop(page, STOP_SLOT_60);
        await expect.poll(() => readView(page)).toMatchObject({
            selected: `${TODAY.slice(0, 7)}-01`, start: 0, end: 1440, overlayDate: null,
        });
    });

    test("a slot width opening another day lands on that day's own window", async ({ page }) => {
        // The aggregate harness, whose backend serves D its columns to press.
        await page.setViewportSize({ width: 1200, height: 1000 });
        await loadCardBundle(page);
        await mountAggregateInspector(page);
        await page.waitForFunction(() => !!document.querySelector("helman-solar-inspector")!.shadowRoot!
            .querySelector("helman-solar-day-pills")?.shadowRoot?.querySelector(".pill.selected"));
        await mouseDrag(page, 0.25);
        await expect.poll(() => readView(page)).toMatchObject({ selected: TODAY, start: -360, end: 1080 });

        await clickStop(page, STOP_MONTH_VIEW);
        await waitForAggregateChart(page);
        await clickColumn(page, (await columns(page)).indexOf(YESTERDAY));
        await clickStop(page, STOP_SLOT_60);
        await expect.poll(() => readView(page)).toMatchObject({
            selected: YESTERDAY, start: 0, end: 1440, overlayDate: null,
        });
    });
});
