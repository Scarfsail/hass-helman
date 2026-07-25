import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The day band as a read-only readout, which is how surfaces other than the
 * editor use it.
 *
 * What is worth pinning here is the geometry, because that is the whole reason
 * the band is reusable at all: a host puts it under its own charts and the
 * tracks have to land on the same hours those charts drew. The rest -- that
 * nothing can be authored, that a press still reports which run it was -- is
 * the contract that lets the host own the decisions.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const DAY = "2026-07-24";
const DAY_START_MS = Date.parse(`${DAY}T00:00:00Z`);
const NOW_MS = Date.parse(`${DAY}T10:30:00Z`);
const HOUR_MS = 3_600_000;
/** The daylight crop a host applies to its own charts: 06:00-18:00. */
const WINDOW_START_MS = DAY_START_MS + 6 * HOUR_MS;
const WINDOW_END_MS = DAY_START_MS + 18 * HOUR_MS;

interface MountOptions {
    windowed?: boolean;
    highlight?: boolean;
}

async function mountBand(page: Page, options: MountOptions = {}): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("scheduling-entity-day-band"));

    await page.evaluate(({ dayStartMs, nowMs, hourMs, windowStartMs, windowEndMs, windowed, highlight }) => {
        const at = (hour: number) => dayStartMs + hour * hourMs;
        const slots = Array.from({ length: 24 }, (_, hour) => ({
            id: new Date(at(hour)).toISOString(),
            index: hour,
            startMs: at(hour),
            endMs: at(hour + 1),
            dayKey: "2026-07-24",
            timeLabel: "",
            endLabel: "",
            rangeLabel: "",
            assignments: { inverter: { action: { kind: "empty" }, setBy: null }, appliances: {} },
            runtime: null,
            isCurrent: false,
        }));

        const band = document.createElement("scheduling-entity-day-band") as HTMLElement & Record<string, unknown>;
        band.style.width = "1000px";
        band.localize = (key: string) => key;
        band.day = {
            dayKey: "2026-07-24",
            label: "today",
            slots,
            startMs: dayStartMs,
            endMs: at(24),
            editableFromMs: nowMs,
        };
        band.lanes = [{
            key: "appliance:boiler",
            name: "Boiler",
            icon: "mdi:water-boiler",
            target: { kind: "appliance", applianceId: "boiler" },
            appliance: { id: "boiler", kind: "generic", name: "Boiler", icon: "mdi:water-boiler" },
            isAvailable: true,
            // 08:00-10:00 behind the now-line, 12:00-14:00 ahead of it.
            actualSegments: [{
                key: "actual:boiler:08",
                startMs: at(8),
                endMs: at(10),
                action: { kind: "on" },
                activeMs: 2 * hourMs,
            }],
            blocks: [{
                key: "block:boiler:12",
                startMs: at(12),
                endMs: at(14),
                slotIds: [new Date(at(12)).toISOString(), new Date(at(13)).toISOString()],
                action: { kind: "on" },
                authorship: "user",
                isDirty: false,
                isPast: false,
                continuesBefore: false,
                continuesAfter: false,
            }],
        }];
        band.nowMs = nowMs;
        band.readonly = true;
        band.laneLabels = "track";
        band.showForecastRows = false;
        band.showAxis = false;
        if (windowed) {
            band.windowStartMs = windowStartMs;
            band.windowEndMs = windowEndMs;
        }
        if (highlight) {
            band.highlightRanges = [
                { startMs: at(12), endMs: at(13), kind: "selected" },
                { startMs: at(15), endMs: at(16), kind: "hover" },
            ];
        }

        (window as unknown as Record<string, unknown>).__events = [];
        for (const type of [
            "entity-day-band-block-select",
            "entity-day-band-lane-select",
            "entity-day-band-time-hover",
            "entity-day-band-gap-select",
        ]) {
            band.addEventListener(type, (event: Event) => {
                ((window as unknown as Record<string, unknown>).__events as unknown[]).push({
                    type,
                    detail: (event as CustomEvent).detail,
                });
            });
        }
        document.body.appendChild(band);
    }, {
        dayStartMs: DAY_START_MS,
        nowMs: NOW_MS,
        hourMs: HOUR_MS,
        windowStartMs: WINDOW_START_MS,
        windowEndMs: WINDOW_END_MS,
        windowed: options.windowed ?? false,
        highlight: options.highlight ?? false,
    });
    await page.waitForFunction(
        () => !!document.querySelector("scheduling-entity-day-band")?.shadowRoot?.querySelector(".track"),
    );
}

/** A styled percentage off an element in the band's shadow root. */
async function readGeometry(page: Page, selector: string): Promise<{ left: number; width: number }> {
    return page.evaluate((sel) => {
        const element = document
            .querySelector("scheduling-entity-day-band")!
            .shadowRoot!.querySelector(sel) as HTMLElement;
        const style = element.getAttribute("style") ?? "";
        const read = (name: string): number =>
            Number.parseFloat(new RegExp(`${name}:\\s*([\\d.]+)%`).exec(style)?.[1] ?? "NaN");
        return { left: read("left"), width: read("width") };
    }, selector);
}

async function readEvents(page: Page): Promise<{ type: string; detail: Record<string, unknown> }[]> {
    return page.evaluate(() => (window as unknown as Record<string, unknown>).__events as never);
}

test.describe("entity day band, read only", () => {
    test("runs are placed as a fraction of the whole day", async ({ page }) => {
        await mountBand(page);

        // 12:00-14:00 of a 24 hour day: half way across, two hours wide.
        const block = await readGeometry(page, ".segment:not(.actual)");
        expect(block.left).toBeCloseTo(50, 1);
        expect(block.width).toBeCloseTo(100 / 12, 1);

        const actual = await readGeometry(page, ".segment.actual");
        expect(actual.left).toBeCloseTo(100 / 3, 1);
        expect(actual.width).toBeCloseTo(100 / 12, 1);
    });

    test("a cropped window rescales the runs to what is visible", async ({ page }) => {
        await mountBand(page, { windowed: true });

        // The same 12:00-14:00 run, now on a 06:00-18:00 axis: half of the
        // window is behind it, and two of its twelve hours are it.
        const block = await readGeometry(page, ".segment:not(.actual)");
        expect(block.left).toBeCloseTo(50, 1);
        expect(block.width).toBeCloseTo(100 / 6, 1);
    });

    test("a run reaching outside the window is cropped, not overflowed", async ({ page }) => {
        await mountBand(page, { windowed: true });
        // Push the actual run to 04:00-08:00: half of it is before the window.
        await page.evaluate(({ dayStartMs, hourMs }) => {
            const band = document.querySelector("scheduling-entity-day-band") as HTMLElement & Record<string, unknown>;
            const lane = (band.lanes as Record<string, unknown>[])[0];
            band.lanes = [{
                ...lane,
                actualSegments: [{
                    ...(lane.actualSegments as Record<string, unknown>[])[0],
                    startMs: dayStartMs + 4 * hourMs,
                    endMs: dayStartMs + 8 * hourMs,
                }],
            }];
        }, { dayStartMs: DAY_START_MS, hourMs: HOUR_MS });
        await page.waitForTimeout(50);

        // Only 06:00-08:00 is inside the window: it starts at the left edge and
        // is two of the window's twelve hours wide, not four.
        const actual = await readGeometry(page, ".segment.actual");
        expect(actual.left).toBeCloseTo(0, 1);
        expect(actual.width).toBeCloseTo(100 / 6, 1);
    });

    test("nothing can be authored, but a run still reports itself", async ({ page }) => {
        await mountBand(page);

        const shadow = page.locator("scheduling-entity-day-band");
        // No gap buttons to add a block with, and no handles to resize by.
        expect(await shadow.locator(".gap").count()).toBe(0);
        expect(await shadow.locator(".handle").count()).toBe(0);

        await shadow.locator(".segment:not(.actual)").click();
        const selects = (await readEvents(page)).filter(
            (event) => event.type === "entity-day-band-block-select",
        );
        expect(selects).toHaveLength(1);
        expect(selects[0].detail).toMatchObject({
            laneKey: "appliance:boiler",
            blockKey: "block:boiler:12",
        });
    });

    test("pressing a bare stretch of a track reports the lane", async ({ page }) => {
        await mountBand(page);

        // 20:00-ish: past every run on the lane, so the track itself is hit.
        const box = (await page.locator("scheduling-entity-day-band").boundingBox())!;
        await page.mouse.click(box.x + box.width * 0.85, box.y + box.height / 2);

        const selects = (await readEvents(page)).filter(
            (event) => event.type === "entity-day-band-lane-select",
        );
        expect(selects).toHaveLength(1);
        expect(selects[0].detail).toMatchObject({ laneKey: "appliance:boiler" });
    });

    test("the pointer's place on the axis is published as a time", async ({ page }) => {
        await mountBand(page);

        const box = (await page.locator("scheduling-entity-day-band").boundingBox())!;
        await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
        await page.waitForFunction(
            () => ((window as unknown as Record<string, unknown>).__events as unknown[])
                .some((event) => (event as { type: string }).type === "entity-day-band-time-hover"),
        );

        const hovers = (await readEvents(page)).filter(
            (event) => event.type === "entity-day-band-time-hover",
        );
        // A quarter of the way across a whole day is 06:00.
        expect(hovers.at(-1)!.detail.atMs as number).toBeGreaterThan(DAY_START_MS + 5.5 * HOUR_MS);
        expect(hovers.at(-1)!.detail.atMs as number).toBeLessThan(DAY_START_MS + 6.5 * HOUR_MS);
    });

    test("the host's marked stretches are drawn on the same axis", async ({ page }) => {
        await mountBand(page, { highlight: true });

        const selected = await readGeometry(page, ".time-highlight.selected");
        expect(selected.left).toBeCloseTo(50, 1);
        expect(selected.width).toBeCloseTo(100 / 24, 1);

        const hover = await readGeometry(page, ".time-highlight.hover");
        expect(hover.left).toBeCloseTo(62.5, 1);
    });

    test("a lane names itself inside its own track", async ({ page }) => {
        await mountBand(page);

        const label = page.locator("scheduling-entity-day-band").locator(".track-label");
        await expect(label).toHaveText(/Boiler/);
        // Inert: the run underneath is still what a press finds.
        expect(
            await label.evaluate((element) => getComputedStyle(element).pointerEvents),
        ).toBe("none");
    });
});
