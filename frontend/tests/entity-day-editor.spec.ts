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
async function mountEditor(page: Page, options: { neighbour?: boolean } = {}): Promise<void> {
    await page.evaluate(({ dayOne, dayTwo, nowMs, neighbour }) => {
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
            if (neighbour && hour === 21) {
                slot.assignments.appliances.boiler = { action: { on: true }, setBy: "user" };
            }
        }

        const saved: unknown[] = [];
        (window as unknown as { savedPatches: unknown[] }).savedPatches = saved;
        document.addEventListener("entity-schedule-save", (event) => {
            saved.push((event as CustomEvent).detail.patches);
        });

        const el = document.createElement("scheduling-entity-day-editor") as any;
        el.localize = (key: string) => key;
        el.target = { kind: "appliance", applianceId: "boiler" };
        el.appliance = {
            id: "boiler",
            name: "Boiler",
            kind: "generic",
            icon: "mdi:water-boiler",
            order: 0,
            supportsAuthoring: true,
            controlEntityIds: { primary: "switch.boiler" },
            scheduleCapabilities: { onOffToggle: true },
        };
        el.slots = slots;
        el.entityName = "Boiler";
        el.currentDayKey = dayOne;
        el.locale = "cs";
        el.timeZone = "UTC";
        el.nowMs = nowMs;
        el.open = true;
        document.body.appendChild(el);
    }, { dayOne: DAY_ONE, dayTwo: DAY_TWO, nowMs: NOW_MS, neighbour: options.neighbour ?? false });

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

/** Page x for a moment on the band's track. */
async function trackPoint(page: Page, atMs: number): Promise<{ x: number; y: number }> {
    return page.evaluate((ms) => {
        const el = document.querySelector("scheduling-entity-day-editor") as any;
        const band = el.shadowRoot.querySelector("scheduling-entity-day-band") as any;
        const track = band.shadowRoot.querySelector(".track") as HTMLElement;
        const rect = track.getBoundingClientRect();
        const day = band.day;
        const ratio = (ms - day.startMs) / (day.endMs - day.startMs);
        return { x: rect.left + ratio * rect.width, y: rect.top + rect.height / 2 };
    }, atMs);
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

    test("a past block cannot be edited from the band either", async ({ page }) => {
        await loadCardBundle(page);
        await mountEditor(page);

        const pastSegment = page.locator("scheduling-entity-day-band .segment").first();
        await expect(pastSegment).toBeDisabled();
    });
});
