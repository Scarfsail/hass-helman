import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The single-entity day editor, end to end through its own DOM.
 *
 * The contract worth pinning is the translation between the two vocabularies:
 * the user edits *blocks* ("run the boiler 17:00-21:00") while the schedule
 * stores *slots*. These tests drive the dialog the way a person does -- pick a
 * block, move its edge, save -- and assert on the slot patches that come out,
 * which is the only place a mistranslation would be visible.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const DAY_ONE = "2026-07-24";
const DAY_TWO = "2026-07-25";
/** Mid-morning on day one: 05:00-07:00 is behind it, 17:00-19:00 ahead. */
const NOW_MS = Date.parse(`${DAY_ONE}T10:30:00Z`);

async function loadCardBundle(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("scheduling-entity-day-editor"));
}

/**
 * Two days of hourly slots with the boiler already scheduled twice: a past run
 * the automation owns and an evening run the user owns.
 */
async function mountEditor(
    page: Page,
    options: {
        neighbour?: boolean;
        straddling?: boolean;
        multiLane?: boolean;
        /** Today as the backend serves it: elapsed slots pruned, then padded
         *  back to midnight by the card, with forecast for those hours. */
        pruned?: boolean;
    } = {},
): Promise<void> {
    await page.evaluate(({ dayOne, dayTwo, nowMs, neighbour, straddling, multiLane, pruned }) => {
        const buildSlot = (dayKey: string, hour: number) => {
            const startMs = Date.parse(`${dayKey}T${String(hour).padStart(2, "0")}:00:00Z`);
            const endMs = startMs + 3_600_000;
            const label = (ms: number) => new Date(ms).toISOString().slice(11, 16);
            return {
                id: new Date(startMs).toISOString(),
                index: hour,
                startMs,
                endMs,
                dayKey,
                timeLabel: label(startMs),
                endLabel: label(endMs),
                rangeLabel: `${label(startMs)}–${label(endMs)}`,
                assignments: {
                    inverter: { action: { kind: "empty" }, setBy: null },
                    appliances: {} as Record<string, unknown>,
                },
                runtime: null,
                isCurrent: startMs <= nowMs && endMs > nowMs,
            };
        };

        const slots = [
            ...Array.from({ length: 24 }, (_unused, hour) => buildSlot(dayOne, hour)),
            ...Array.from({ length: 24 }, (_unused, hour) => buildSlot(dayTwo, hour)),
        ];
        for (const slot of slots) {
            if (slot.dayKey !== dayOne) {
                continue;
            }
            const hour = slot.index;
            if (hour === 5 || hour === 6) {
                slot.assignments.appliances.boiler = { action: { on: true }, setBy: "automation" };
            }
            if (hour === 17 || hour === 18) {
                slot.assignments.appliances.boiler = { action: { on: true }, setBy: "user" };
            }
            if (straddling && hour >= 8 && hour <= 11) {
                slot.assignments.appliances.boiler = { action: { on: true }, setBy: "user" };
            }
            if (multiLane && hour === 20) {
                slot.assignments.inverter = { action: { kind: "stop_charging" }, setBy: "automation" };
            }
            if (multiLane && hour === 21) {
                // Same tone as the run before it, different action: only the
                // icon says they are not one run.
                slot.assignments.inverter = { action: { kind: "stop_export" }, setBy: "automation" };
            }
            if (neighbour && hour === 21) {
                slot.assignments.appliances.boiler = { action: { on: true }, setBy: "user" };
            }
        }

        const saved: unknown[] = [];
        (window as unknown as { savedPatches: unknown[] }).savedPatches = saved;
        document.addEventListener("entity-schedule-save", (event) => {
            saved.push((event as CustomEvent).detail.patches);
        });

        const boiler = {
            id: "boiler",
            name: "Boiler",
            kind: "generic",
            icon: "mdi:water-boiler",
            order: 0,
            supportsAuthoring: true,
            controlEntityIds: { primary: "switch.boiler" },
            scheduleCapabilities: { onOffToggle: true },
        };
        const pump = { ...boiler, id: "pump", name: "Pump", icon: "mdi:pump", order: 1 };

        const el = document.createElement("scheduling-entity-day-editor") as any;
        el.localize = (key: string) => key;
        el.target = { kind: "appliance", applianceId: "boiler" };
        el.appliance = boiler;
        if (multiLane) {
            el.lanes = [
                {
                    key: "inverter",
                    target: { kind: "inverter" },
                    name: "Inverter",
                    icon: "mdi:solar-power",
                    appliance: null,
                    isAvailable: true,
                    actualSlots: [],
                },
                {
                    key: "appliance:boiler",
                    target: { kind: "appliance", applianceId: "boiler" },
                    name: "Boiler",
                    icon: "mdi:water-boiler",
                    appliance: boiler,
                    isAvailable: true,
                    actualSlots: [],
                },
                {
                    key: "appliance:pump",
                    target: { kind: "appliance", applianceId: "pump" },
                    name: "Pump",
                    icon: "mdi:pump",
                    appliance: pump,
                    isAvailable: false,
                    actualSlots: [],
                },
            ];
            // The boiler really ran 07:00-09:00, and the inverter charged for
            // half of 09:00 before stopping.
            el.lanes[1].actualSlots = [7, 8].map((hour) => ({
                startMs: Date.parse(`${dayOne}T0${hour}:00:00Z`),
                endMs: Date.parse(`${dayOne}T0${hour + 1}:00:00Z`),
                action: { on: true },
                ratio: 1,
            }));
            el.lanes[0].actualSlots = [{
                startMs: Date.parse(`${dayOne}T09:00:00Z`),
                endMs: Date.parse(`${dayOne}T10:00:00Z`),
                action: { kind: "charge_to_target_soc" },
                ratio: 0.5,
            }];
        }
        if (pruned) {
            const elapsed = slots.filter((slot) => slot.dayKey === dayOne && slot.endMs <= nowMs);
            for (const slot of elapsed) {
                slot.id = `elapsed:${new Date(slot.startMs).toISOString()}`;
                slot.assignments = {
                    inverter: { action: { kind: "empty" }, setBy: null },
                    appliances: {},
                };
            }
            el.forecastPoints = new Map(slots.map((slot) => [
                slot.id,
                { socPct: 40 + (slot.index % 12) * 4, solarWh: slot.index * 90, price: 2 },
            ]));
        }

        el.slots = slots;
        el.entityName = "Boiler";
        el.currentDayKey = dayOne;
        el.locale = "cs";
        el.timeZone = "UTC";
        el.nowMs = nowMs;
        el.open = true;
        document.body.appendChild(el);
    }, {
        dayOne: DAY_ONE,
        dayTwo: DAY_TWO,
        nowMs: NOW_MS,
        neighbour: options.neighbour ?? false,
        straddling: options.straddling ?? false,
        multiLane: options.multiLane ?? false,
        pruned: options.pruned ?? false,
    });

    await page.waitForFunction(() => {
        const el = document.querySelector("scheduling-entity-day-editor") as any;
        return !!el?.shadowRoot?.querySelector(".block-list");
    });
}

/** The block rows as `range | authorship | past?` triples. */
async function readBlockRows(page: Page) {
    return page.evaluate(() => {
        const el = document.querySelector("scheduling-entity-day-editor") as any;
        return [...el.shadowRoot.querySelectorAll(".block-row")].map((row: Element) => ({
            range: row.querySelector(".block-range")?.textContent?.trim() ?? "",
            authorship: row.querySelector(".block-authorship")?.textContent?.trim() ?? "",
            past: row.classList.contains("past"),
            hasButtons: row.querySelectorAll(".block-buttons button").length > 0,
        }));
    });
}

/** The range the edit panel currently shows, as `from|to` ms. */
async function editingRange(page: Page): Promise<string | null> {
    return page.evaluate(() => {
        const el = document.querySelector("scheduling-entity-day-editor") as any;
        const selects = el.shadowRoot.querySelectorAll(".edit-panel select");
        return selects.length === 2 ? `${selects[0].value}|${selects[1].value}` : null;
    });
}

/** Page x for a moment on a lane's track, defaulting to the first lane. */
async function trackPoint(
    page: Page,
    atMs: number,
    laneKey?: string,
): Promise<{ x: number; y: number }> {
    return page.evaluate(({ ms, lane }) => {
        const el = document.querySelector("scheduling-entity-day-editor") as any;
        const band = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
        const selector = lane === undefined ? ".track" : `.lane[data-lane="${lane}"] .track`;
        const track = band.shadowRoot.querySelector(selector) as HTMLElement;
        const rect = track.getBoundingClientRect();
        const day = band.day;
        const ratio = (ms - day.startMs) / (day.endMs - day.startMs);
        return { x: rect.left + ratio * rect.width, y: rect.top + rect.height / 2 };
    }, { ms: atMs, lane: laneKey });
}

async function savedPatches(page: Page) {
    return page.evaluate(() => (window as unknown as { savedPatches: any[] }).savedPatches);
}

test.describe("entity day editor", () => {
    test("merges adjacent slots into blocks and locks the past ones", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        const rows = await readBlockRows(page);
        expect(rows).toHaveLength(2);
        expect(rows[0].range).toBe("05:00–07:00");
        expect(rows[0].past).toBe(true);
        expect(rows[0].hasButtons).toBe(false);
        expect(rows[0].authorship).toBe("scheduling.authorship.set_by_automation");
        expect(rows[1].range).toBe("17:00–19:00");
        expect(rows[1].past).toBe(false);
        expect(rows[1].authorship).toBe("scheduling.authorship.set_by_user");
    });

    test("extending a block patches only the slots it gained", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        // Edit the evening block and drag its end from 19:00 to 21:00.
        await page.locator(".block-row").nth(1).locator("button").first().click();
        await page.locator(".edit-panel select").nth(1).selectOption(
            String(Date.parse(`${DAY_ONE}T21:00:00Z`)),
        );

        const rowsWhileEditing = await readBlockRows(page);
        expect(rowsWhileEditing[1].range).toBe("17:00–21:00");
        expect(rowsWhileEditing[1].authorship).toBe("scheduling.entity_editor.unsaved");

        await page.locator("ha-button[slot=primaryAction]").click();

        const [patches] = await savedPatches(page);
        expect(patches.map((patch: { id: string }) => patch.id)).toEqual([
            `${DAY_ONE}T19:00:00.000Z`,
            `${DAY_ONE}T20:00:00.000Z`,
        ]);
        expect(patches[0].domains.appliances.boiler).toEqual({ on: true });
    });

    test("removing a block clears its slots and leaves the rest alone", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        await page.locator(".block-row").nth(1).locator("button").nth(1).click();
        expect(await readBlockRows(page)).toHaveLength(1);

        await page.locator("ha-button[slot=primaryAction]").click();

        const [patches] = await savedPatches(page);
        expect(patches.map((patch: { id: string }) => patch.id)).toEqual([
            `${DAY_ONE}T17:00:00.000Z`,
            `${DAY_ONE}T18:00:00.000Z`,
        ]);
        expect(patches[0].domains.appliances).toEqual({});
    });

    test("adding a block on the next day writes that day's slots", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        await page.locator(".day-chip").nth(1).click();
        expect(await readBlockRows(page)).toHaveLength(0);

        await page.locator(".block-list .link-button").click();
        await page.locator(".edit-panel select").first().selectOption(
            String(Date.parse(`${DAY_TWO}T09:00:00Z`)),
        );
        await page.locator(".edit-panel select").nth(1).selectOption(
            String(Date.parse(`${DAY_TWO}T11:00:00Z`)),
        );

        expect((await readBlockRows(page))[0].range).toBe("09:00–11:00");

        await page.locator("ha-button[slot=primaryAction]").click();

        const [patches] = await savedPatches(page);
        expect(patches.map((patch: { id: string }) => patch.id)).toEqual([
            `${DAY_TWO}T09:00:00.000Z`,
            `${DAY_TWO}T10:00:00.000Z`,
        ]);
        expect(patches[0].domains.appliances.boiler).toEqual({ on: true });
    });

    test("clicking another block switches the edit session straight over", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { neighbour: true });

        await page.locator(".block-row").nth(1).locator("button").first().click();
        expect(await editingRange(page)).toBe(
            `${Date.parse(`${DAY_ONE}T17:00:00Z`)}|${Date.parse(`${DAY_ONE}T19:00:00Z`)}`,
        );

        // No "done" step: picking the next block is the whole gesture.
        await page.locator(".block-row").nth(2).locator("button").first().click();
        expect(await editingRange(page)).toBe(
            `${Date.parse(`${DAY_ONE}T21:00:00Z`)}|${Date.parse(`${DAY_ONE}T22:00:00Z`)}`,
        );
    });

    test("clicking outside closes the panel and keeps the edit in the draft", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        await page.locator(".block-row").nth(1).locator("button").first().click();
        await page.locator(".edit-panel select").nth(1).selectOption(
            String(Date.parse(`${DAY_ONE}T21:00:00Z`)),
        );

        await page.locator(".day-switcher").click();
        expect(await editingRange(page)).toBeNull();

        // The block keeps its new end, and Save still has something to write.
        expect((await readBlockRows(page))[1].range).toBe("17:00–21:00");
        await page.locator("ha-button[slot=primaryAction]").click();
        const [patches] = await savedPatches(page);
        expect(patches.map((patch: { id: string }) => patch.id)).toEqual([
            `${DAY_ONE}T19:00:00.000Z`,
            `${DAY_ONE}T20:00:00.000Z`,
        ]);
    });

    test("editing a block that is already running keeps its running part", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { straddling: true });

        // 08:00-12:00 spans "now" (10:30), so 08:00-10:00 has already elapsed.
        expect((await readBlockRows(page)).map((row) => row.range)).toEqual([
            "05:00–07:00",
            "08:00–12:00",
            "17:00–19:00",
        ]);

        await page.locator(".block-row").nth(1).locator("button").first().click();

        // The session starts at the running slot, and the block stays whole in
        // the list rather than losing the hours it has already run.
        expect(await editingRange(page)).toBe(
            `${Date.parse(`${DAY_ONE}T10:00:00Z`)}|${Date.parse(`${DAY_ONE}T12:00:00Z`)}`,
        );
        expect((await readBlockRows(page)).map((row) => row.range)).toEqual([
            "05:00–07:00",
            "08:00–12:00",
            "17:00–19:00",
        ]);
    });

    test("a new block can start in the slot that is running now", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        await page.locator(".block-list .link-button").click();

        // 10:30 sits inside the 10:00 slot, and "start it now" means 10:00 --
        // the backend's write horizon begins at the same floored boundary.
        expect(await editingRange(page)).toBe(
            `${Date.parse(`${DAY_ONE}T10:00:00Z`)}|${Date.parse(`${DAY_ONE}T11:00:00Z`)}`,
        );

        await page.locator("ha-button[slot=primaryAction]").click();
        const [patches] = await savedPatches(page);
        expect(patches.map((patch: { id: string }) => patch.id)).toEqual([
            `${DAY_ONE}T10:00:00.000Z`,
        ]);
    });

    test("clicking a block on the band opens the panel and keeps it open", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        // The press re-renders the segment, so the release retargets its click
        // to the dialog body. That click must not read as "clicked outside".
        await page.locator("scheduling-entity-day-band .segment").nth(1).click();

        expect(await editingRange(page)).toBe(
            `${Date.parse(`${DAY_ONE}T17:00:00Z`)}|${Date.parse(`${DAY_ONE}T19:00:00Z`)}`,
        );
    });

    test("hovering either the row or its segment highlights both", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        // Which block is highlighted, by index, on each side.
        const highlighted = () => page.evaluate(() => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            const band = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
            const indexOf = (nodes: NodeListOf<Element>, selector: string) =>
                [...nodes].findIndex((node) => node.matches(selector));
            return {
                row: indexOf(el.shadowRoot.querySelectorAll(".block-row"), ".hovered"),
                segment: indexOf(band.shadowRoot.querySelectorAll(".segment"), ".hovered"),
            };
        });

        await page.locator(".block-row").nth(1).hover();
        expect(await highlighted()).toEqual({ row: 1, segment: 1 });

        await page.locator("scheduling-entity-day-band .segment").nth(1).hover();
        expect(await highlighted()).toEqual({ row: 1, segment: 1 });

        await page.locator(".day-switcher").hover();
        expect(await highlighted()).toEqual({ row: -1, segment: -1 });
    });

    test("dragging the middle of a block moves it whole", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        const from = await trackPoint(page, Date.parse(`${DAY_ONE}T18:00:00Z`));
        const to = await trackPoint(page, Date.parse(`${DAY_ONE}T21:00:00Z`));
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 8 });
        await page.mouse.up();

        expect((await readBlockRows(page))[1].range).toBe("20:00–22:00");

        // The click that ends a drag retargets to the dialog body once the
        // segment has re-rendered; it must not read as "clicked outside" and
        // close the editor the drag just opened.
        expect(await editingRange(page)).toBe(
            `${Date.parse(`${DAY_ONE}T20:00:00Z`)}|${Date.parse(`${DAY_ONE}T22:00:00Z`)}`,
        );
    });

    test("dragging an edge stops at the neighbouring block", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { neighbour: true });

        // Grab the 17:00-19:00 block's right edge and pull it well past the
        // 21:00-22:00 block: it must stop where that block starts.
        const edge = await trackPoint(page, Date.parse(`${DAY_ONE}T19:00:00Z`));
        const target = await trackPoint(page, Date.parse(`${DAY_ONE}T23:00:00Z`));
        await page.mouse.move(edge.x - 2, edge.y);
        await page.mouse.down();
        await page.mouse.move(target.x, target.y, { steps: 8 });
        await page.mouse.up();

        // The two runs now touch and read as one block -- which they are -- but
        // the drag stopped at 21:00, so the neighbour's own slot is untouched
        // and never reaches the patch batch.
        const rows = await readBlockRows(page);
        expect(rows).toHaveLength(2);
        expect(rows[1].range).toBe("17:00–22:00");

        await page.locator("ha-button[slot=primaryAction]").click();
        const [patches] = await savedPatches(page);
        expect(patches.map((patch: { id: string }) => patch.id)).toEqual([
            `${DAY_ONE}T19:00:00.000Z`,
            `${DAY_ONE}T20:00:00.000Z`,
        ]);
    });

    /**
     * The "from" picker moves the end along with the start, and that end has to
     * stop at the neighbour exactly as a drag does -- otherwise the picker is
     * the back door that overwrites the block next door.
     */
    test("moving a block's start with the picker still stops at the neighbour", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { neighbour: true });

        await page.locator(".block-row").nth(1).locator(".block-main").click();
        await page.locator(".edit-panel select").first()
            .selectOption(String(Date.parse(`${DAY_ONE}T20:00:00Z`)));

        // 20:00 + the block's two hours would reach 22:00, over the neighbour
        // that starts at 21:00. It is cut to 21:00 instead.
        expect(await editingRange(page)).toBe(
            `${Date.parse(`${DAY_ONE}T20:00:00Z`)}|${Date.parse(`${DAY_ONE}T21:00:00Z`)}`,
        );

        await page.locator("ha-button[slot=primaryAction]").click();
        const [patches] = await savedPatches(page);
        expect(patches.map((patch: { id: string }) => patch.id)).not.toContain(
            `${DAY_ONE}T21:00:00.000Z`,
        );
    });

    /**
     * A running block starts in the past but the session only owns the part
     * still ahead, so a drag has to move that part -- carrying the elapsed hours
     * along would stretch the block by however much of it had already happened.
     */
    test("dragging a running block moves only the part still ahead", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { straddling: true });

        // The block runs 08:00-12:00 and it is 10:30, so the session is
        // 10:00-12:00. One hour to the right must land on 11:00-13:00.
        const from = await trackPoint(page, Date.parse(`${DAY_ONE}T11:00:00Z`));
        const to = await trackPoint(page, Date.parse(`${DAY_ONE}T12:00:00Z`));
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 6 });
        await page.mouse.up();

        expect(await editingRange(page)).toBe(
            `${Date.parse(`${DAY_ONE}T11:00:00Z`)}|${Date.parse(`${DAY_ONE}T13:00:00Z`)}`,
        );
    });

    /**
     * Save must not offer to write a draft that has since elapsed: the patch
     * builder would drop every slot, and the dialog would close over an empty
     * batch as if the day had been saved.
     */
    test("a draft whose slots elapse stops being savable", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        const point = await trackPoint(page, Date.parse(`${DAY_ONE}T11:00:00Z`));
        await page.mouse.click(point.x, point.y);
        // `ha-button` is not a native control here, so ask for the attribute
        // the disabled binding actually sets.
        const saveDisabled = () => page.evaluate(() => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            return el.shadowRoot.querySelector("ha-button[slot=primaryAction]").hasAttribute("disabled");
        });
        expect(await saveDisabled()).toBe(false);

        // Time moves past the drafted block, as the card's clock tick would.
        await page.evaluate((nowMs) => {
            (document.querySelector("scheduling-entity-day-editor") as any).nowMs = nowMs;
        }, Date.parse(`${DAY_ONE}T12:30:00Z`));

        expect(await saveDisabled()).toBe(true);
    });

    test("each run on the strip carries who put it there", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        const authorship = await page.evaluate(() => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            const band = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
            return [...band.shadowRoot.querySelectorAll(".segment")]
                .map((segment: Element) => /authorship-(user|automation|mixed)\b/
                    .exec(segment.className)?.[1] ?? null);
        });

        // 05:00-07:00 is the optimizer's, 17:00-19:00 the user's.
        expect(authorship).toEqual(["automation", "user"]);
    });

    /**
     * The card pads today back to midnight so the forecast rows can show the
     * hours that have gone. Those slots hold no schedule and must stay inert:
     * the day is only wider to look at, not wider to write.
     */
    test("padded elapsed hours are drawn but stay unwritable", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page, { pruned: true });

        const band = await page.evaluate(() => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            const bandEl = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
            const track = bandEl.shadowRoot.querySelector(".track") as HTMLElement;
            const overlay = bandEl.shadowRoot.querySelector(".track .past-overlay") as HTMLElement;
            return {
                contextRows: bandEl.shadowRoot.querySelectorAll(".context-row").length,
                laneCount: bandEl.shadowRoot.querySelectorAll(".lane").length,
                chartOverlays: bandEl.shadowRoot.querySelectorAll(".context-row .past-overlay").length,
                nowMarkers: bandEl.shadowRoot.querySelectorAll(".now-marker").length,
                // The elapsed hours carry forecast bars of their own.
                barsBeforeNow: [...bandEl.shadowRoot.querySelectorAll(".context-bar")]
                    .filter((bar: Element) => parseFloat((bar as HTMLElement).style.left) < 40).length,
                pastWidthPct: (overlay.getBoundingClientRect().width / track.getBoundingClientRect().width) * 100,
            };
        });

        expect(band.contextRows).toBe(3);
        // The charts say "this is behind us" the same way the tracks do, and
        // carry the same now-line, so the band reads as one day.
        expect(band.chartOverlays).toBe(3);
        expect(band.nowMarkers).toBe(band.contextRows + band.laneCount);
        expect(band.barsBeforeNow).toBeGreaterThan(0);
        // Ten of twenty-four hours have gone.
        expect(band.pastWidthPct).toBeGreaterThan(40);
        expect(band.pastWidthPct).toBeLessThan(43);

        // The morning run went with the pruning, so the evening one is the only
        // block left -- and nothing behind the boundary is on offer for it.
        await expect(page.locator(".block-row")).toHaveCount(1);
        await page.locator(".block-row").first().locator(".block-main").click();
        const options = await page.evaluate(() => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            const select = el.shadowRoot.querySelector(".edit-panel select") as HTMLSelectElement;
            return [...select.options].map((option) => Number(option.value));
        });
        expect(Math.min(...options)).toBe(Date.parse(`${DAY_ONE}T10:00:00Z`));
    });

    test("a past block cannot be edited from the band either", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        // Pressing it is allowed -- that is how its lane gets selected -- but it
        // opens no session, because none of its slots can still be written.
        const pastSegment = page.locator("scheduling-entity-day-band .segment").first();
        await expect(pastSegment).toHaveClass(/\bpast\b/);
        await pastSegment.click();
        expect(await editingRange(page)).toBeNull();
    });

    /**
     * With every controllable entity stacked on one axis, the thing that can
     * quietly go wrong is ownership: which lane an edit lands in, and whether
     * two lanes that touched the same slot both survive the save.
     */
    test.describe("with every entity stacked", () => {
        const laneState = (page: Page) => page.evaluate(() => {
            const el = document.querySelector("scheduling-entity-day-editor") as any;
            const band = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
            return {
                lanes: [...band.shadowRoot.querySelectorAll(".lane")].map((lane: Element) => ({
                    key: lane.getAttribute("data-lane"),
                    selected: lane.classList.contains("selected"),
                })),
                blockListLabel: el.shadowRoot.querySelector(".block-list .field-label")
                    ?.textContent?.trim() ?? null,
            };
        });

        test("opens on the entity that was clicked, with the others as context", async ({ page }) => {
            await loadCardBundle(page);
            await mountEditor(page, { multiLane: true });

            const state = await laneState(page);
            expect(state.lanes).toEqual([
                { key: "inverter", selected: false },
                { key: "appliance:boiler", selected: true },
                { key: "appliance:pump", selected: false },
            ]);
            expect(state.blockListLabel).toContain("Boiler");
        });

        test("clicking another lane's track moves the editor to that entity", async ({ page }) => {
            await loadCardBundle(page);
            await mountEditor(page, { multiLane: true });

            // The inverter's whole day is free, so this is a gap: it selects the
            // lane and opens a session on it in one press.
            const point = await trackPoint(page, Date.parse(`${DAY_ONE}T13:00:00Z`), "inverter");
            await page.mouse.click(point.x, point.y);

            const state = await laneState(page);
            expect(state.lanes.find((lane) => lane.selected)?.key).toBe("inverter");
            expect(state.blockListLabel).toContain("Inverter");
            expect(await editingRange(page)).not.toBeNull();
        });

        /**
         * Two lanes writing one slot must arrive as one patch. A patch carries
         * the slot's whole set of user domains, so sending one per lane would
         * make the last one win and drop the other entity's edit.
         */
        test("edits on two entities leave in a single patch per slot", async ({ page }) => {
            await loadCardBundle(page);
            await mountEditor(page, { multiLane: true });

            const inverterPoint = await trackPoint(page, Date.parse(`${DAY_ONE}T13:00:00Z`), "inverter");
            await page.mouse.click(inverterPoint.x, inverterPoint.y);
            const boilerPoint = await trackPoint(page, Date.parse(`${DAY_ONE}T13:00:00Z`), "appliance:boiler");
            await page.mouse.click(boilerPoint.x, boilerPoint.y);

            await page.locator("ha-button[slot=primaryAction]").click();
            const [patches] = await savedPatches(page);
            // Both blocks start where the pointer landed, so both land on the
            // 13:00 slot -- and it is patched once, carrying both lanes.
            expect(patches).toHaveLength(1);
            expect(patches[0].id).toBe(`${DAY_ONE}T13:00:00.000Z`);
            expect(patches[0].domains.inverter.kind).toBe("charge_to_target_soc");
            expect(patches[0].domains.appliances.boiler).toEqual({ on: true });
        });

        test("pressing a lane's elapsed stretch selects it, like its name does", async ({ page }) => {
            await loadCardBundle(page);
            await mountEditor(page, { multiLane: true });

            // 03:00 is behind the editable boundary, so there is no gap button
            // there and the press lands on the bare track.
            const point = await trackPoint(page, Date.parse(`${DAY_ONE}T03:00:00Z`), "inverter");
            await page.mouse.click(point.x, point.y);

            const state = await laneState(page);
            expect(state.lanes.find((lane) => lane.selected)?.key).toBe("inverter");
            expect(await editingRange(page)).toBeNull();
        });

        /**
         * The parent echoes a rebuilt action back after every keystroke, so the
         * SoC field must not re-seed itself from it: it would refill an emptied
         * field with the 0 that "" parses to, and rewrite 05 to 5 mid-entry.
         */
        test("typing a target SoC is not undone by the action echoing back", async ({ page }) => {
            await loadCardBundle(page);
            await mountEditor(page, { multiLane: true });

            const point = await trackPoint(page, Date.parse(`${DAY_ONE}T13:00:00Z`), "inverter");
            await page.mouse.click(point.x, point.y);

            const typeSoc = (value: string) => page.evaluate((next) => {
                const el = document.querySelector("scheduling-entity-day-editor") as any;
                const editor = el.shadowRoot.querySelector("scheduling-entity-action-editor") as any;
                const field = editor.shadowRoot.querySelector("ha-textfield") as any;
                field.value = next;
                field.dispatchEvent(new Event("input", { bubbles: true }));
                return el.updateComplete.then(() => editor.updateComplete).then(() => field.value);
            }, value);

            expect(await typeSoc("8")).toBe("8");
            expect(await typeSoc("")).toBe("");
            expect(await typeSoc("05")).toBe("05");
        });

        /**
         * The past is a different fact from the plan: measured, authorless and
         * finished. It is drawn on the same axis so a run still going meets its
         * scheduled continuation, but it must not become something to edit.
         */
        test("what really ran is drawn behind the now-line, and counts", async ({ page }) => {
            await loadCardBundle(page);
            await mountEditor(page, { multiLane: true });

            const lanes = await page.evaluate(() => {
                const el = document.querySelector("scheduling-entity-day-editor") as any;
                const band = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
                return [...band.shadowRoot.querySelectorAll(".lane")].map((lane: Element) => ({
                    key: lane.getAttribute("data-lane"),
                    // Two elapsed hours merge into one run.
                    actual: [...lane.querySelectorAll(".segment.actual")].map((segment: Element) => ({
                        left: Math.round(parseFloat((segment as HTMLElement).style.left)),
                        width: Math.round(parseFloat((segment as HTMLElement).style.width)),
                        editable: !(getComputedStyle(segment).pointerEvents === "none"),
                    })),
                    total: lane.querySelector(".lane-total")?.textContent?.trim() ?? null,
                    totalTitle: lane.querySelector(".lane-total")?.getAttribute("title") ?? null,
                }));
            });

            const boiler = lanes.find((lane) => lane.key === "appliance:boiler")!;
            // 07:00-09:00 is one run of two hours, starting seven twenty-fourths in.
            expect(boiler.actual).toHaveLength(1);
            expect(boiler.actual[0].left).toBe(29);
            expect(boiler.actual[0].width).toBe(8);
            expect(boiler.actual[0].editable).toBe(false);
            // Two hours really run, plus the four this fixture still holds in
            // the schedule (the morning block as well as the evening one --
            // today's elapsed slots are pruned in production, not here).
            expect(boiler.total).toBe("6 h");
            expect(boiler.totalTitle).toBe("2 h + 4 h");

            // Half an hour of charging is half an hour, however wide it is
            // drawn -- plus the two hours this lane holds in the evening.
            const inverter = lanes.find((lane) => lane.key === "inverter")!;
            expect(inverter.actual).toHaveLength(1);
            expect(inverter.total).toBe("2,5 h");
            expect(inverter.totalTitle).toBe("0,5 h + 2 h");
        });

        /**
         * Runs of the same kind share a colour, so where one becomes another
         * with no gap the change is invisible -- and when it happened is the
         * one thing a strip of time exists to say.
         */
        test("a run becoming a different one is cut where it changes", async ({ page }) => {
            await loadCardBundle(page);
            await mountEditor(page, { multiLane: true });

            const marked = await page.evaluate(() => {
                const el = document.querySelector("scheduling-entity-day-editor") as any;
                const band = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
                const read = (laneKey: string) => [...band.shadowRoot
                    .querySelectorAll(`.lane[data-lane="${laneKey}"] .segment`)]
                    .map((segment: Element) => ({
                        left: Math.round(parseFloat((segment as HTMLElement).style.left)),
                        changed: segment.classList.contains("changed"),
                    }));
                return { inverter: read("inverter"), boiler: read("appliance:boiler") };
            });

            // The 09:00 charge it really ran and the 20:00 block both follow a
            // gap; 21:00 follows a run it differs from.
            expect(marked.inverter).toEqual([
                { left: 38, changed: false },
                { left: 83, changed: false },
                { left: 88, changed: true },
            ]);

            // The boiler's morning run continues into what it really did at
            // 07:00 -- same action, so no cut: that seam has to read as one bar.
            expect(marked.boiler.every((segment) => !segment.changed)).toBe(true);
        });

        test("an entity that cannot be reached is still a lane", async ({ page }) => {
            await loadCardBundle(page);
            await mountEditor(page, { multiLane: true });

            const point = await trackPoint(page, Date.parse(`${DAY_ONE}T13:00:00Z`), "appliance:pump");
            await page.mouse.click(point.x, point.y);

            const state = await laneState(page);
            expect(state.lanes.find((lane) => lane.selected)?.key).toBe("appliance:pump");
            expect(state.blockListLabel).toContain("Pump");
        });
    });
});
