import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

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

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

interface FakeNode {
    id: string;
    name: string;
    deferrable?: boolean;
    controllableId?: string | null;
    children?: FakeNode[];
}

async function loadCardBundle(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("scheduling-day-editor-host"));
}

/**
 * A house with two shiftable appliances, both scheduled in the slot running now.
 *
 * The lanes the editor offers are built from live entity states, so the states
 * matter as much as the schedule: an entity Home Assistant does not know is not
 * a lane, and a press on it would land nowhere.
 */
async function installFakeBackend(page: Page): Promise<void> {
    await page.evaluate(() => {
        const nowMs = Date.now();
        const dayStartMs = new Date(new Date(nowMs).toISOString().slice(0, 10) + "T00:00:00Z").getTime();
        const slots = Array.from({ length: 24 }, (_unused, hour) => {
            const startMs = dayStartMs + hour * 3_600_000;
            const running = startMs <= nowMs && nowMs < startMs + 3_600_000;
            return {
                id: new Date(startMs).toISOString(),
                controllables: running
                    ? {
                        dishwasher: { on: true, setBy: "automation" },
                        boiler: { on: true, setBy: "user" },
                    }
                    : {},
            };
        });
        const appliance = (id: string, name: string) => ({
            id,
            name,
            kind: "generic",
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
            callWS: async (msg: { type: string }) => {
                if (msg.type === "helman/get_schedule") {
                    return { executionEnabled: true, slots };
                }
                if (msg.type === "helman/get_appliances") {
                    return {
                        appliances: [
                            appliance("dishwasher", "Dishwasher"),
                            appliance("boiler", "Boiler"),
                        ],
                    };
                }
                if (msg.type === "helman/get_controllable_entities") {
                    return {
                        entities: [
                            { kind: "generic", name: "Dishwasher", entityId: "switch.dishwasher", normalState: "off" },
                            { kind: "generic", name: "Boiler", entityId: "switch.boiler", normalState: "off" },
                        ],
                    };
                }
                if (msg.type === "helman/get_entity_actual_history") {
                    return { entities: {} };
                }
                if (msg.type === "helman/get_appliance_projections") {
                    return { appliances: [] };
                }
                return {};
            },
        };
    });
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

        const boxes = document.createElement("power-devices-container") as any;
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

    // The host needs its schedule and both rosters before it has lanes to open
    // on; until then a press is correctly a no-op.
    await page.waitForFunction(() => {
        const host = document.querySelector("scheduling-day-editor-host") as any;
        return (host?.lanes?.length ?? 0) >= 2;
    });
}

/** Press the badge on the row with this label. */
async function pressBadge(page: Page, label: string): Promise<void> {
    await page.evaluate(async (wanted) => {
        const boxes = document.querySelector("power-devices-container") as any;
        for (const row of [...boxes.shadowRoot.querySelectorAll("power-device")] as any[]) {
            await row.updateComplete;
            const content = row.shadowRoot.querySelector(".deviceContent");
            // A row with children appends an expand indicator to its name.
            const name = (content.querySelector(".deviceName")?.textContent ?? "").trim();
            if (!name.startsWith(wanted)) continue;
            const info = content.querySelector("power-device-info");
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
        await loadCardBundle(page);
        await installFakeBackend(page);
    });

    test("a device row opens the editor on that controllable's lane", async ({ page }) => {
        await mount(page, [
            { id: "s1", name: "Dishwasher", deferrable: true, controllableId: "dishwasher" },
            { id: "s2", name: "Boiler", deferrable: true, controllableId: "boiler" },
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
                    { id: "s1", name: "Dishwasher", deferrable: true, controllableId: "dishwasher" },
                    { id: "s2", name: "Boiler", deferrable: true, controllableId: "boiler" },
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

    test("nothing is open until a badge is pressed", async ({ page }) => {
        await mount(page, [
            { id: "s1", name: "Dishwasher", deferrable: true, controllableId: "dishwasher" },
            { id: "s2", name: "Boiler", deferrable: true, controllableId: "boiler" },
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
