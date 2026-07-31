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
    /** Hand the band a state machine, so the lane label's icon goes live. */
    live?: boolean;
    /**
     * Labels in their own column, the way the day editor hosts the band. The
     * default here is `"track"`, which is the label-less host.
     */
    columnLabels?: boolean;
}

async function mountBand(page: Page, options: MountOptions = {}): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("scheduling-entity-day-band"));

    await page.evaluate(({ dayStartMs, nowMs, hourMs, windowStartMs, windowEndMs, windowed, highlight, live, columnLabels }) => {
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
        if (live) {
            band.hass = {
                locale: { language: "en" },
                states: {
                    "switch.boiler": {
                        entity_id: "switch.boiler",
                        state: "on",
                        attributes: { friendly_name: "Boiler" },
                    },
                },
            };
        }
        band.lanes = [{
            key: "appliance:boiler",
            entityId: "switch.boiler",
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
            // No projection loaded: the runs draw as bare bars, which is what
            // every one of these geometry assertions is about.
            blockProjections: new Map(),
            blockVehicleSoc: new Map(),
        }];
        band.nowMs = nowMs;
        band.readonly = true;
        band.laneLabels = columnLabels ? "column" : "track";
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
            "entity-day-band-lane-explain",
            "entity-day-band-time-hover",
            "entity-day-band-gap-select",
            "hass-more-info",
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
        live: options.live ?? false,
        columnLabels: options.columnLabels ?? false,
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

    /**
     * The label's icon is the entity's own live badge wherever the host handed
     * the band a state machine. `state-badge` is an HA element that is not in
     * this bundle, so it renders as an inert unknown element -- what is worth
     * pinning is that it is there, bound to the right state, and that it is a
     * control of its own rather than part of the label.
     */
    test("a lane's icon is the entity's live state badge", async ({ page }) => {
        await mountBand(page, { live: true });

        const bound = await page.evaluate(() => {
            const badge = document
                .querySelector("scheduling-entity-day-band")!
                .shadowRoot!.querySelector(".track-label state-badge") as HTMLElement & Record<string, unknown>;
            return {
                state: (badge.stateObj as { state: string }).state,
                stateColor: badge.stateColor,
                pointerEvents: getComputedStyle(badge).pointerEvents,
                staticIcons: document
                    .querySelector("scheduling-entity-day-band")!
                    .shadowRoot!.querySelectorAll(".track-label ha-icon").length,
            };
        });

        expect(bound.state).toBe("on");
        expect(bound.stateColor).toBe(true);
        expect(bound.pointerEvents).toBe("auto");
        expect(bound.staticIcons).toBe(0);
    });

    test("an entity the state machine cannot answer for keeps its flat icon", async ({ page }) => {
        // No `hass` at all is the same case as an entity that is simply missing
        // from it: there is no state to draw, and the lane still needs an icon.
        await mountBand(page);

        const shadow = page.locator("scheduling-entity-day-band");
        expect(await shadow.locator(".track-label ha-icon").count()).toBe(1);
        expect(await shadow.locator(".track-label state-badge").count()).toBe(0);
    });

    test("pressing the icon asks about the entity, not about the lane", async ({ page }) => {
        await mountBand(page, { live: true });

        // The badge has no box of its own here (it is an undefined element), so
        // the press is driven on the element rather than through the mouse.
        await page.evaluate(() => {
            document
                .querySelector("scheduling-entity-day-band")!
                .shadowRoot!.querySelector(".track-label state-badge")!
                .dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
        });

        const events = await readEvents(page);
        expect(events.filter((event) => event.type === "hass-more-info")).toHaveLength(1);
        expect(events.find((event) => event.type === "hass-more-info")!.detail)
            .toMatchObject({ entityId: "switch.boiler" });
        expect(events.filter((event) => event.type === "entity-day-band-lane-select")).toHaveLength(0);
    });
});

/**
 * "Why is it planned like this?" as a control of its own.
 *
 * The lane's name already means "this entity"; the explanation is a second
 * intent and gets a second button rather than a modifier on the first, so
 * neither press can be discovered by accident or lost by habit.
 */
test.describe("entity day band, explain affordance", () => {
    test("the info button asks about this lane on this day", async ({ page }) => {
        await mountBand(page, { columnLabels: true });

        const band = page.locator("scheduling-entity-day-band");
        await expect(band.locator(".lane-explain")).toHaveCount(1);
        await band.locator(".lane-explain").click();

        const events = await readEvents(page);
        const explains = events.filter((event) => event.type === "entity-day-band-lane-explain");
        expect(explains).toHaveLength(1);
        expect(explains[0].detail).toMatchObject({
            laneKey: "appliance:boiler",
            dayKey: DAY,
            laneName: "Boiler",
        });
        // Two intents, two presses: asking why must not also select the lane.
        expect(events.filter((event) => event.type === "entity-day-band-lane-select")).toHaveLength(0);
    });

    test("the name still selects the lane", async ({ page }) => {
        await mountBand(page, { columnLabels: true });

        await page.locator("scheduling-entity-day-band").locator(".lane-label").click();

        const events = await readEvents(page);
        expect(events.filter((event) => event.type === "entity-day-band-lane-select")).toHaveLength(1);
        expect(events.filter((event) => event.type === "entity-day-band-lane-explain")).toHaveLength(0);
    });

    test("a host with no label column gets no info button", async ({ page }) => {
        // `laneLabels === "track"`: there is no label element to hang it on,
        // and the bare track's press already means "this lane".
        await mountBand(page);

        const band = page.locator("scheduling-entity-day-band");
        await expect(band.locator(".lane-explain")).toHaveCount(0);
        await expect(band.locator(".lane-label")).toHaveCount(0);
    });
});
