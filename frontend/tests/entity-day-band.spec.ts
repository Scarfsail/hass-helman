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
     * Labels in their own column. The default here is `"track"`, which is what
     * the day editor -- the production host that matters -- uses.
     */
    columnLabels?: boolean;
    /** Draw the day's slots, as both of the editor's modes do. */
    slotGrid?: boolean;
    /** And let a press on one name it, as the editor's Explain mode does. */
    slotPicks?: boolean;
    /** A second lane, for the marks that are meant to be per lane. */
    twoLanes?: boolean;
    /**
     * A host's own time grid, as hours-of-day; whole multiples of three are the
     * ones it numbers, so they come through as the stronger lines.
     */
    gridTicks?: number[];
    /** The hour whose slot the host is showing an answer for. */
    selectedSlot?: number;
    /**
     * Half-hour slots with a solar forecast, and the forecast rows on.
     *
     * The one shape that tells a per-slot figure apart from a per-hour one:
     * on an hourly day the two are the same number.
     */
    halfHourly?: boolean;
    /** The band's own hour axis, which the editing hosts keep and a stacked host drops. */
    axis?: boolean;
    /** How much room the tracks get, which is what decides how dense the grid can be. */
    widthPx?: number;
}

async function mountBand(page: Page, options: MountOptions = {}): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("scheduling-entity-day-band"));

    await page.evaluate(({ dayStartMs, nowMs, hourMs, windowStartMs, windowEndMs, windowed, highlight, live, columnLabels, slotGrid, slotPicks, twoLanes, selectedSlot, halfHourly, gridTicks, axis, widthPx }) => {
        const at = (hour: number) => dayStartMs + hour * hourMs;
        const stepMs = halfHourly ? hourMs / 2 : hourMs;
        const slots = Array.from({ length: halfHourly ? 48 : 24 }, (_, index) => ({
            id: new Date(dayStartMs + index * stepMs).toISOString(),
            index,
            startMs: dayStartMs + index * stepMs,
            endMs: dayStartMs + (index + 1) * stepMs,
            dayKey: "2026-07-24",
            timeLabel: "",
            endLabel: "",
            rangeLabel: "",
            assignments: { inverter: { action: { kind: "empty" }, setBy: null }, appliances: {} },
            runtime: null,
            isCurrent: false,
        }));

        const band = document.createElement("scheduling-entity-day-band") as HTMLElement & Record<string, unknown>;
        band.style.width = `${widthPx}px`;
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
        const boilerLane = {
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
        };
        band.lanes = twoLanes
            ? [boilerLane, { ...boilerLane, key: "appliance:pump", name: "Pump", blocks: [] }]
            : [boilerLane];
        band.nowMs = nowMs;
        band.readonly = true;
        band.laneLabels = columnLabels ? "column" : "track";
        band.slotGrid = slotGrid;
        band.slotPicks = slotPicks;
        band.selectedSlot = selectedSlot === undefined
            ? null
            : { laneKey: "appliance:boiler", slotId: new Date(at(selectedSlot)).toISOString() };
        band.showForecastRows = halfHourly;
        band.showAxis = axis;
        if (halfHourly) {
            // 600 Wh in a half hour is 1.2 kWh over the hour it sits in.
            band.forecastPoints = new Map(slots.map((slot) => [
                slot.id,
                { socPct: 50, solarWh: 600, price: 1.5 },
            ]));
        }
        band.timeGridTicks = gridTicks.map((hour) => ({
            atMs: dayStartMs + hour * hourMs,
            major: hour % 3 === 0,
        }));
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
            "entity-day-band-slot-select",
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
        slotGrid: options.slotGrid ?? false,
        slotPicks: options.slotPicks ?? false,
        twoLanes: options.twoLanes ?? false,
        selectedSlot: options.selectedSlot,
        halfHourly: options.halfHourly ?? false,
        gridTicks: options.gridTicks ?? [],
        axis: options.axis ?? false,
        widthPx: options.widthPx ?? 1000,
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
 * The slot grid: the day's own slots, as something to point at.
 *
 * The unit the schedule stores is a slot, and the explanation record is keyed
 * by slot id -- so what the grid draws has to be `day.slots` rather than a
 * hardcoded half hour, and a press has to name the slot's id, not a time the
 * host would then have to match back to a row.
 *
 * Hover is per time, and every lane marks it. The question a hovered hour asks
 * is what else the house is doing then, and the answer is in the other tracks
 * -- so the lane under the pointer is marked harder, and the rest go along.
 */
test.describe("entity day band, slot grid", () => {
    test("off by default, so the editing hosts are untouched", async ({ page }) => {
        await mountBand(page);
        await expect(page.locator("scheduling-entity-day-band").locator(".slot-pick")).toHaveCount(0);
    });

    test("one target per slot of the day", async ({ page }) => {
        await mountBand(page, { slotGrid: true });

        // 24 slots in the fixture: the grid comes from the day, not from a
        // fixed half hour -- a band showing hourly slots draws 24 hairlines.
        const picks = page.locator("scheduling-entity-day-band").locator(".slot-pick");
        await expect(picks).toHaveCount(24);
        const geometry = await readGeometry(page, '.slot-pick[data-slot="' + new Date(DAY_START_MS + 12 * HOUR_MS).toISOString() + '"]');
        expect(geometry.left).toBeCloseTo(50, 1);
        expect(geometry.width).toBeCloseTo(100 / 24, 1);
    });

    test("hovering marks that hour in every lane, and the pointed one hardest", async ({ page }) => {
        await mountBand(page, { slotGrid: true, twoLanes: true });

        const band = page.locator("scheduling-entity-day-band");
        const slotId = new Date(DAY_START_MS + 12 * HOUR_MS).toISOString();
        const cell = (lane: string) =>
            band.locator(`.lane[data-lane="${lane}"] .slot-pick[data-slot="${slotId}"]`);
        // Through the run drawn there: the grid takes no pointer events here,
        // and hovering an hour the boiler is busy is exactly the case worth
        // pinning -- that is when the other rows are worth reading.
        await cell("appliance:boiler").hover({ force: true });

        // One lane is being pointed at, and the other is the context that makes
        // the first one worth pointing at.
        await expect(band.locator(".slot-pick.hovered")).toHaveCount(1);
        await expect(cell("appliance:boiler")).toHaveClass(/hovered/);
        await expect(band.locator(".slot-pick.co-hovered")).toHaveCount(1);
        await expect(cell("appliance:pump")).toHaveClass(/co-hovered/);
    });

    test("the grid is inert until a host asks for presses", async ({ page }) => {
        // Drawn in both of the editor's modes, but only pressable in Explain:
        // while a day is being authored the track is a drag surface, and a
        // layer of slot targets over every run would swallow the grabs.
        await mountBand(page, { slotGrid: true });

        await expect(page.locator("scheduling-entity-day-band").locator(".slot-pick.pickable"))
            .toHaveCount(0);
        const slotId = new Date(DAY_START_MS + 12 * HOUR_MS).toISOString();
        await page
            .locator("scheduling-entity-day-band")
            .locator('.slot-pick[data-slot="' + slotId + '"]')
            .click({ force: true });
        const events = await readEvents(page);
        expect(events.filter((event) => event.type === "entity-day-band-slot-select")).toHaveLength(0);
    });

    test("pressing a slot names it and its lane, and nothing else", async ({ page }) => {
        await mountBand(page, { slotGrid: true, slotPicks: true });

        const slotId = new Date(DAY_START_MS + 12 * HOUR_MS).toISOString();
        await page
            .locator("scheduling-entity-day-band")
            .locator('.slot-pick[data-slot="' + slotId + '"]')
            .click();

        const events = await readEvents(page);
        const picks = events.filter((event) => event.type === "entity-day-band-slot-select");
        expect(picks).toHaveLength(1);
        expect(picks[0].detail).toEqual({ laneKey: "appliance:boiler", slotId });
        // The slot already says which lane it is in; the track's own press
        // would answer the same question a second time.
        expect(events.filter((event) => event.type === "entity-day-band-lane-select")).toHaveLength(0);
        // A slot over a run is still a slot: the block underneath is what is
        // being asked about, not what is being picked.
        expect(events.filter((event) => event.type === "entity-day-band-block-select")).toHaveLength(0);
    });

    test("the answered slot stays marked, in its own lane alone", async ({ page }) => {
        // Once the pointer moves to the diagram below, the only thing saying
        // which slot it is about is the mark left behind on the band -- and the
        // question was about one appliance, so one lane carries the mark.
        await mountBand(page, { slotGrid: true, twoLanes: true, selectedSlot: 12 });

        const band = page.locator("scheduling-entity-day-band");
        await expect(band.locator(".slot-pick.selected")).toHaveCount(1);
        await expect(
            band.locator('.lane[data-lane="appliance:boiler"] .slot-pick.selected'),
        ).toHaveCount(1);
    });
});

/**
 * Where the band's lines come from.
 *
 * Stacked under somebody's charts it takes theirs, because that is the only way
 * the lanes and the charts can be read as one diagram: the host has already
 * decided which lines are drawn and which of them carry an hour, and a band
 * that decided again would rule the same day twice, differently. Standing on
 * its own -- the day editor -- it is that host, and derives the same ticks from
 * the same module the inspector's charts do.
 */
test.describe("entity day band, host time grid", () => {
    test("nothing is ruled until somebody asks for it", async ({ page }) => {
        await mountBand(page);
        await expect(page.locator("scheduling-entity-day-band")).toBeAttached();
        const band = page.locator("scheduling-entity-day-band");
        await expect(band.locator(".time-grid-line")).toHaveCount(0);
    });

    test("the host's grid wins over the day's own", async ({ page }) => {
        // Both on: the band is drawing its slots *and* is being handed a grid.
        // Ruling the day twice is the one outcome that cannot be allowed.
        await mountBand(page, { slotGrid: true, gridTicks: [6, 8, 12] });

        await expect(page.locator("scheduling-entity-day-band").locator(".time-grid-line"))
            .toHaveCount(3);
    });

    test("the host's lines are drawn on every lane, at the host's own weights", async ({ page }) => {
        await mountBand(page, { twoLanes: true, gridTicks: [6, 8, 12] });

        const band = page.locator("scheduling-entity-day-band");
        // Three lines per track, on both tracks.
        await expect(band.locator(".time-grid-line")).toHaveCount(6);
        // 06:00 and 12:00 are the numbered hours the host chose; 08:00 is not.
        await expect(band.locator(".time-grid-line.major")).toHaveCount(4);

        const first = await readGeometry(page, ".time-grid-line");
        expect(first.left).toBeCloseTo(25, 1);
    });

    test("a line outside the host's crop is dropped, not stacked on the edge", async ({ page }) => {
        // The crop is 06:00-18:00, so 03:00 and 21:00 have nowhere to go -- and
        // 06:00 is the crop's own edge, where a line would be drawn on the
        // track's border rather than inside it. 12:00 is the only one left.
        await mountBand(page, { windowed: true, gridTicks: [3, 6, 12, 21] });

        const band = page.locator("scheduling-entity-day-band");
        await expect(band.locator(".time-grid-line")).toHaveCount(1);
        const only = await readGeometry(page, ".time-grid-line");
        expect(only.left).toBeCloseTo(50, 1);
    });
});

/**
 * The forecast rows read as one chart with the tracks under them, so what they
 * say per slot has to be comparable slot to slot -- and comparable to the yield
 * the user knows their roof gets, which is a per-hour figure.
 */
test.describe("entity day band, forecast rows", () => {
    test("solar reads as kWh over a whole hour, whatever the slot is", async ({ page }) => {
        await mountBand(page, { halfHourly: true, slotGrid: true });

        const band = page.locator("scheduling-entity-day-band");
        const solarRow = band.locator(".context-row").first();
        // 600 Wh in a half-hour slot: the slot holds 0.6 kWh, and the hour it
        // sits in is on course for 1.2.
        await expect(solarRow.locator(".slot-value").first()).toHaveText("1.2");
        await expect(solarRow.locator(".slot-hit").first())
            .toHaveAttribute("title", /1\.2 kWh\/h/);
    });

    test("the grid runs through the charts too", async ({ page }) => {
        await mountBand(page, { halfHourly: true, slotGrid: true });

        // Three rows ruled by the day's own half hours -- the charts are ruled
        // in the same unit the tracks under them are, or a column is at "about
        // noon" rather than at a slot. 47 lines, not 48: the one on midnight
        // would be drawn over the row's own left edge.
        await expect(page.locator("scheduling-entity-day-band").locator(".context-row .time-grid-line"))
            .toHaveCount(3 * 48);
    });
});

/**
 * The day editor's grid, which the band rules for itself.
 *
 * The same answer the inspector's charts give, because it is the same module
 * giving it: a line per slot, and the hours numbered as densely as the width
 * allows -- every hour where there is room, thinning as the dialog narrows,
 * with the numbered lines drawn stronger so the coarse scale survives a line
 * every half hour.
 */
test.describe("entity day band, its own slot grid", () => {
    test("a line per slot of the day, and the hours drawn stronger", async ({ page }) => {
        await mountBand(page, { halfHourly: true, slotGrid: true, axis: true });

        const band = page.locator("scheduling-entity-day-band");
        const track = band.locator(".track");
        // 48 half-hour slots, less the one on the track's own edge.
        await expect(track.locator(".time-grid-line")).toHaveCount(48);
        // 1000px of day leaves room to number every hour: 24 of those lines.
        await expect(track.locator(".time-grid-line.major")).toHaveCount(24);
    });

    test("every hour is numbered when there is room for it", async ({ page }) => {
        await mountBand(page, { slotGrid: true, axis: true });

        // 00 through 24 inclusive: the axis is a scale, and the day's last
        // boundary is as much a part of it as its first.
        await expect(page.locator("scheduling-entity-day-band").locator(".axis-tick"))
            .toHaveCount(25);
    });

    test("the numbers thin out rather than collide as the band narrows", async ({ page }) => {
        await mountBand(page, { slotGrid: true, axis: true, widthPx: 300 });

        const band = page.locator("scheduling-entity-day-band");
        // 300px cannot hold 25 two-digit numbers, so the stride widens to three
        // hours -- and the lines that carry them are still one per slot.
        await expect(band.locator(".axis-tick")).toHaveCount(9);
        await expect(band.locator(".axis-tick").first()).toHaveText("00");
        await expect(band.locator(".axis-tick").nth(1)).toHaveText("03");
        await expect(band.locator(".track .time-grid-line")).toHaveCount(24);
        await expect(band.locator(".track .time-grid-line.major")).toHaveCount(8);
    });

    test("a cropped day is ruled and numbered inside its crop", async ({ page }) => {
        await mountBand(page, { slotGrid: true, axis: true, windowed: true });

        const band = page.locator("scheduling-entity-day-band");
        // 06:00-18:00, so 07 through 18 carry numbers and 06 is the edge the
        // track starts on.
        await expect(band.locator(".axis-tick")).toHaveCount(13);
        await expect(band.locator(".axis-tick").first()).toHaveText("06");
        await expect(band.locator(".axis-tick").last()).toHaveText("18");
        await expect(band.locator(".track .time-grid-line")).toHaveCount(12);
    });
});
