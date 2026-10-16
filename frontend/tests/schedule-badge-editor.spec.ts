import { test, expect, type Page } from "@playwright/test";
import { scheduleSlots } from "./support/payload-builders";
import { loadBundle } from "./support/card-page";
import { mockRequests } from "./support/mock-hass";

/**
 * Pressing a scheduling badge opens the shared day editor.
 *
 * The badge only asks — it dispatches `helman-open-schedule-editor` and lets
 * whoever hosts it decide — and the answer both cards give is the same one
 * element, `scheduling-day-editor-host`, which owns the schedule, the rosters,
 * the clock and the dialog. This mounts real house consumer boxes beside a real
 * host, wired the way the power card and the inspector wire them, and asserts
 * where the dialog lands: on the pressed controllable's lane for a device row,
 * and on no lane at all for a group row, which is the editor's "pick an entity"
 * state rather than a guess between the group's children.
 */

interface FakeNode {
    id: string;
    name: string;
    deferrable?: boolean;
    controllableIds?: string[];
    children?: FakeNode[];
}

/**
 * A house with two shiftable appliances, both scheduled in the slot running now.
 *
 * The lanes the editor offers are built from live entity states, so the states
 * matter as much as the schedule: an entity Home Assistant does not know is not
 * a lane, and a press on it would land nowhere.
 */
async function installFakeBackend(page: Page): Promise<void> {
    const nowMs = await page.evaluate(() => Date.now());
    const dayStartMs = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`);
    const schedule = scheduleSlots({ slotMinutes: 60, start: new Date(dayStartMs).toISOString(), count: 24 });
    const running = schedule.slots.find((slot) => Date.parse(slot.id) <= nowMs && nowMs < Date.parse(slot.id) + 3_600_000);
    if (running) running.controllables = {
        dishwasher: { on: true, setBy: "automation" },
        boiler: { on: true, setBy: "user" },
    };
    await page.evaluate((schedule) => {
        const nowMs = Date.now();
        const appliance = (id: string, name: string) => ({
            id,
            name,
            kind: "generic",
            primaryEntityId: `switch.${id}`,
            supportsAuthoring: true,
            normalState: "off",
            metadata: { icon: "mdi:flash", scheduleCapabilities: { onOffToggle: true } },
            controls: { switch: { entityId: `switch.${id}` } },
        });

        window.__fakeHass = {
            language: "en",
            locale: { language: "en" },
            config: { time_zone: "UTC" },
            connection: {
                // The editor asks for the forecast when it opens. There is none
                // here: the dialog draws the day perfectly well without prices,
                // and the load's own failure path is what a house with no
                // forecast configured hits anyway.
                sendMessagePromise: async () => {
                    throw new Error("no forecast in this fixture");
                },
            },
            states: {
                "switch.dishwasher": {
                    entity_id: "switch.dishwasher",
                    state: "on",
                    attributes: { friendly_name: "Dishwasher" },
                    last_changed: new Date(nowMs).toISOString(),
                },
                "switch.boiler": {
                    entity_id: "switch.boiler",
                    state: "on",
                    attributes: { friendly_name: "Boiler" },
                    last_changed: new Date(nowMs).toISOString(),
                },
            },
            callWS: window.__mockHass({
                "helman/get_schedule": async (msg: {
                    type: string;
                }) => {
                    return schedule;
                },
                "helman/get_appliances": async (msg: {
                    type: string;
                }) => {
                    return {
                        appliances: [
                            appliance("dishwasher", "Dishwasher"),
                            appliance("boiler", "Boiler"),
                        ],
                    };
                },
                "helman/get_entity_actual_history": async (msg: {
                    type: string;
                }) => {
                    return { entities: {} };
                },
                "helman/get_appliance_projections": async (msg: {
                    type: string;
                }) => {
                    return { appliances: [] };
                }
            }).callWS,
        };
    }, schedule);
}

/**
 * Mount the boxes and the host side by side, with the card's own wiring between
 * them: the request bubbles to the wrapper, and the wrapper opens the host.
 */
async function mount(page: Page, nodes: FakeNode[]): Promise<void> {
    await page.evaluate(async (fakeNodes) => {
        const hydrate = (node: any): any => ({
            children: [],
            valueType: "default",
            isSource: false,
            isUnmeasured: false,
            powerValue: 100,
            powerHistory: [100],
            historyBuckets: 1,
            ...node,
            ...(node.children ? { children: node.children.map(hydrate) } : {}),
        });

        const wrapper = document.createElement("div");
        const host = document.createElement("scheduling-day-editor-host") as any;
        host.hass = window.__fakeHass;
        host.timeZone = "UTC";
        wrapper.addEventListener("helman-open-schedule-editor", (event: any) => {
            host.openFor(event.detail.target);
        });

        const boxes = document.createElement("helman-tree-item-list") as any;
        boxes.hass = window.__fakeHass;
        boxes.devices = fakeNodes.map(hydrate);
        boxes.historyBuckets = 1;
        boxes.historyBucketDuration = 1;
        boxes.devices_full_width = true;

        wrapper.append(host, boxes);
        document.body.appendChild(wrapper);
        await host.updateComplete;
        await boxes.updateComplete;
    }, nodes);

    // The host needs its schedule and the roster before it has lanes to open
    // on; until then a press is correctly a no-op.
    await page.waitForFunction(() => {
        const host = document.querySelector("scheduling-day-editor-host") as any;
        return (host?.lanes?.length ?? 0) >= 2;
    });
}

/** The badge on the row with this label, as the colour its authorship tints it. */
async function badgeColor(page: Page, label: string): Promise<string> {
    return page.evaluate(async (wanted) => {
        const boxes = document.querySelector("helman-tree-item-list") as any;
        for (const row of [...boxes.shadowRoot.querySelectorAll("helman-tree-item")] as any[]) {
            await row.updateComplete;
            const content = row.shadowRoot.querySelector(".deviceContent");
            const name = (content.querySelector(".deviceName")?.textContent ?? "").trim();
            if (!name.startsWith(wanted)) continue;
            const info = content.querySelector("helman-tree-item-info");
            await info.updateComplete;
            const badge = info.shadowRoot.querySelector("helman-schedule-badge") as any;
            await badge.updateComplete;
            return (badge.shadowRoot.querySelector("ha-icon") as HTMLElement).style.color;
        }
        throw new Error(`no row labelled "${wanted}"`);
    }, label);
}

/** Press the badge on the row with this label. */
async function pressBadge(page: Page, label: string): Promise<void> {
    await page.evaluate(async (wanted) => {
        const boxes = document.querySelector("helman-tree-item-list") as any;
        for (const row of [...boxes.shadowRoot.querySelectorAll("helman-tree-item")] as any[]) {
            await row.updateComplete;
            const content = row.shadowRoot.querySelector(".deviceContent");
            // A row with children appends an expand indicator to its name.
            const name = (content.querySelector(".deviceName")?.textContent ?? "").trim();
            if (!name.startsWith(wanted)) continue;
            const info = content.querySelector("helman-tree-item-info");
            await info.updateComplete;
            const badge = info.shadowRoot.querySelector("helman-schedule-badge") as any;
            await badge.updateComplete;
            (badge.shadowRoot.querySelector("ha-icon") as HTMLElement).click();
            return;
        }
        throw new Error(`no row labelled "${wanted}"`);
    }, label);
}

/**
 * The dialog's landing state.
 *
 * `selected` is what the dialog actually armed for editing, which is the part
 * worth pinning: a null `target` that quietly selects the first lane of the
 * roster would open an editor on the inverter, an appliance nobody pressed.
 */
async function editorState(page: Page): Promise<{
    open: boolean;
    target: string | null;
    selected: string | null;
    hasHint: boolean;
}> {
    return page.evaluate(async () => {
        const host = document.querySelector("scheduling-day-editor-host") as any;
        await host.updateComplete;
        const editor = host.shadowRoot.querySelector("scheduling-entity-day-editor") as any;
        if (!editor) return { open: false, target: null, selected: null, hasHint: false };
        await editor.updateComplete;
        return {
            open: editor.open === true,
            target: editor.target ?? null,
            selected: editor._selectedLaneKey ?? null,
            hasHint: !!editor.shadowRoot.querySelector(".select-hint"),
        };
    });
}

test.describe("opening the day editor from a scheduling badge", () => {
    test.beforeEach(async ({ page }) => {
        await loadBundle(page, "scheduling-day-editor-host");
        await installFakeBackend(page);
    });

    test("a device row opens the editor on that controllable's lane", async ({ page }) => {
        await mount(page, [
            { id: "s1", name: "Dishwasher", deferrable: true, controllableIds: ["dishwasher"] },
            { id: "s2", name: "Boiler", deferrable: true, controllableIds: ["boiler"] },
        ]);

        await pressBadge(page, "Boiler");

        expect(await editorState(page)).toEqual({
            open: true,
            target: "boiler",
            selected: "boiler",
            hasHint: false,
        });
    });

    test("a group row opens the editor on no lane at all", async ({ page }) => {
        await mount(page, [
            {
                id: "group:deferrable",
                name: "Deferrable consumption",
                deferrable: true,
                children: [
                    { id: "s1", name: "Dishwasher", deferrable: true, controllableIds: ["dishwasher"] },
                    { id: "s2", name: "Boiler", deferrable: true, controllableIds: ["boiler"] },
                ],
            },
        ]);

        await pressBadge(page, "Deferrable consumption");

        // No lane armed, and the hint naming what to press instead.
        expect(await editorState(page)).toEqual({
            open: true,
            target: null,
            selected: null,
            hasHint: true,
        });
    });

    /**
     * The band strip lost its own copy of this pipeline in the same change, so
     * this pins the other half of the contract: the strip draws its day off the
     * host's getters, and a lane press opens the host's dialog rather than one
     * of its own.
     */
    test("a band lane press opens the same host's editor", async ({ page }) => {
        await mount(page, []);
        const opened = await page.evaluate(async () => {
            const host = document.querySelector("scheduling-day-editor-host") as any;
            const strip = document.createElement("helman-solar-schedule-band-strip") as any;
            strip.hass = window.__fakeHass;
            strip.editorHost = host;
            strip.timeZone = "UTC";
            strip.date = new Date().toISOString().slice(0, 10);
            strip.geometry = {
                width: 800,
                marginLeft: 40,
                plotWidth: 720,
                startMinutes: 0,
                endMinutes: 1440,
            };
            document.body.appendChild(strip);
            await strip.updateComplete;

            const band = strip.shadowRoot.querySelector("scheduling-entity-day-band");
            if (!band) return { lanes: 0, target: null };
            await band.updateComplete;
            // The strip must be drawing the host's lanes, or there is nothing to
            // press and nothing this test would notice.
            const lanes = band.lanes.length;
            band.dispatchEvent(new CustomEvent("entity-day-band-lane-select", {
                detail: {
                    laneKey: host.lanes.find((lane: any) => lane.target === "boiler").key,
                },
                bubbles: true,
                composed: true,
            }));
            await host.updateComplete;
            const editor = host.shadowRoot.querySelector("scheduling-entity-day-editor") as any;
            return { lanes, target: editor?.target ?? null };
        });

        expect(opened.lanes).toBeGreaterThan(0);
        expect(opened.target).toBe("boiler");
    });

    /**
     * A refused write keeps the day on screen -- correctly, since the draft is
     * the only copy of it. Without the reason on screen too that reads as a
     * dead Save: nothing closes, nothing is written, and why is in the console.
     */
    test("a refused save says why and keeps the draft on screen", async ({ page }) => {
        await mount(page, [
            { id: "s1", name: "Dishwasher", deferrable: true, controllableIds: ["dishwasher"] },
            { id: "s2", name: "Boiler", deferrable: true, controllableIds: ["boiler"] },
        ]);
        await pressBadge(page, "Boiler");

        // The backend refuses the batch the way its slot validator does.
        await page.evaluate(() => {
            const hass = window.__fakeHass as any;
            window.__setMockReply(hass, "helman/set_schedule", () => {
                throw {
                        code: "invalid_slots",
                        message: "Schedule slot must be within the rolling 48-hour horizon",
                };
            });
        });

        // Clear the boiler's run, so there is a draft worth writing.
        await page.locator(".block-row").first().locator("button").nth(1).click();
        await page.locator("ha-button[slot=primaryAction]").click();

        await expect(page.locator(".save-error")).toContainText(
            "Schedule slot must be within the rolling 48-hour horizon",
        );
        expect((await editorState(page)).open).toBe(true);
    });

    /**
     * A write answers with the schedule it produced, so the card commits that
     * answer instead of asking again -- a second read would only race it.
     */
    test("a save commits the write's answer without re-reading the schedule", async ({ page }) => {
        await mount(page, [
            { id: "s1", name: "Dishwasher", deferrable: true, controllableIds: ["dishwasher"] },
            { id: "s2", name: "Boiler", deferrable: true, controllableIds: ["boiler"] },
        ]);
        await pressBadge(page, "Boiler");
        const before = (await mockRequests(page)).length;

        await page.locator(".block-row").first().locator("button").nth(1).click();
        await page.locator("ha-button[slot=primaryAction]").click();
        await expect.poll(async () => (await editorState(page)).open).toBe(false);

        const types = (await mockRequests(page)).slice(before).map((request) => request.type);
        expect(types).toContain("helman/set_schedule");
        expect(types).not.toContain("helman/get_schedule");
    });

    /**
     * A refresh asked for while the write is in flight -- a data-changed event
     * from some other writer -- is owed once the write's answer lands, since
     * that answer may predate whatever the event announced.
     */
    test("a refresh during a save re-reads the schedule once the write commits", async ({ page }) => {
        await mount(page, [
            { id: "s1", name: "Dishwasher", deferrable: true, controllableIds: ["dishwasher"] },
            { id: "s2", name: "Boiler", deferrable: true, controllableIds: ["boiler"] },
        ]);
        await pressBadge(page, "Boiler");
        await page.evaluate(() => {
            const hass = window.__fakeHass as any;
            const host = document.querySelector("scheduling-day-editor-host") as any;
            window.__setMockReply(hass, "helman/set_schedule", () => new Promise((resolve) => {
                (window as any).__releaseWrite = () => resolve(host._scheduleOwner.getSnapshot().schedule);
            }));
        });
        const before = (await mockRequests(page)).length;

        await page.locator(".block-row").first().locator("button").nth(1).click();
        await page.locator("ha-button[slot=primaryAction]").click();
        await page.waitForFunction(() => typeof (window as any).__releaseWrite === "function");
        await page.evaluate(() => {
            const host = document.querySelector("scheduling-day-editor-host") as any;
            void host._scheduleOwner.refresh();
        });
        const types = async () => (await mockRequests(page)).slice(before).map((request) => request.type);
        expect(await types()).not.toContain("helman/get_schedule");

        await page.evaluate(() => (window as any).__releaseWrite());
        await expect.poll(types).toEqual(["helman/set_schedule", "helman/get_schedule"]);
    });

    /**
     * The roster carries each controllable's resting state, so the badges and
     * the editor need nothing but `helman/get_appliances` to tell a scheduled
     * run from a scheduled stop.
     */
    test("the badges and the editor draw from the appliance roster alone", async ({ page }) => {
        await mount(page, [
            { id: "s1", name: "Dishwasher", deferrable: true, controllableIds: ["dishwasher"] },
            { id: "s2", name: "Boiler", deferrable: true, controllableIds: ["boiler"] },
        ]);

        await expect.poll(() => badgeColor(page, "Boiler")).toContain("--schedule-authorship-user-color");
        expect(await badgeColor(page, "Dishwasher")).toContain("--schedule-authorship-automation-color");

        const types = (await mockRequests(page)).map((request) => request.type);
        expect(types).not.toContain("helman/get_controllable_entities");
        // The host and the badge source ask together, and the shared store
        // answers both with one read.
        expect(types.filter((type) => type === "helman/get_appliances")).toHaveLength(1);
    });

    test("nothing is open until a badge is pressed", async ({ page }) => {
        await mount(page, [
            { id: "s1", name: "Dishwasher", deferrable: true, controllableIds: ["dishwasher"] },
            { id: "s2", name: "Boiler", deferrable: true, controllableIds: ["boiler"] },
        ]);

        expect(await editorState(page)).toEqual({
            open: false,
            target: null,
            selected: null,
            hasHint: false,
        });
    });
});

declare global {
    interface Window {
        __fakeHass: Record<string, unknown>;
    }
}
