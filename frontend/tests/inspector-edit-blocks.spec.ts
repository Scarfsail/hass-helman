import { test, expect, type Page } from "@playwright/test";
import { installFakeHass } from "./support/mock-hass";
import { loadBundle } from "./support/card-page";
import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";

/**
 * "Edit blocks" in a device detail the solar inspector opened.
 *
 * The inspector opens a device's detail from its house breakdown, and hosts
 * one day editor for the whole card. A press on "Edit blocks" in the detail's
 * Schedule section asks the card around it for the editor; the inspector
 * answers by opening that editor on the device's lane, over the detail, and
 * closing it returns to the still-open detail.
 */

async function mountInspector(page: Page): Promise<void> {
    await page.goto("about:blank");
    await loadBundle(page, "helman-solar-inspector-card");
    await installFakeHass(page, { pillDays: 2 });
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.evaluate(() => {
        const w = window as any;
        const hass = w.__fakeHass;
        const dayStart = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
        const slots = Array.from({ length: 96 }, (_, i) => {
            const at = dayStart + i * 900_000;
            const hour = new Date(at).getUTCHours();
            return { id: new Date(at).toISOString(), controllables: hour === 20 ? { boiler: { on: true, setBy: "automation" } } : {} };
        });
        hass.states = {
            "switch.boiler": { entity_id: "switch.boiler", state: "off", attributes: { friendly_name: "Boiler" }, last_changed: new Date().toISOString() },
        };
        const replies: Record<string, unknown> = {
            "helman/get_schedule": { executionEnabled: true, slotMinutes: 15, slots },
            "helman/get_appliances": { appliances: [{
                id: "boiler", name: "Boiler", kind: "generic", primaryEntityId: "switch.boiler", supportsAuthoring: true, normalState: "off",
                metadata: { icon: "mdi:water-boiler", scheduleCapabilities: { onOffToggle: true } },
                controls: { switch: { entityId: "switch.boiler" } },
            }] },
            "helman/get_entity_actual_history": { entities: {} },
            "helman/get_appliance_projections": { appliances: [] },
            "helman/get_device_tree": {
                sources: [],
                consumers: [{
                    id: "house", displayName: "House", powerSensorId: "sensor.house",
                    children: [{
                        id: "boiler", displayName: "Boiler", powerSensorId: "sensor.boiler",
                        switchEntityId: "switch.boiler", controllableIds: ["boiler"], ownControllableIds: ["boiler"],
                        deviceKey: "sensor.boiler_energy", energyEntityId: "sensor.boiler_energy",
                        children: [],
                    }],
                }],
                consumptionTotalSensorId: null,
                productionTotalSensorId: null,
                uiConfig: { history_buckets: 1, history_bucket_duration: 5, device_groupings: [] },
            },
        };
        for (const [command, reply] of Object.entries(replies)) w.__setMockReply(hass, command, reply);
        w.__inspector = () => document.querySelector("helman-solar-inspector-card")
            ?.shadowRoot?.querySelector("helman-solar-inspector") as any;
        const card = document.createElement("helman-solar-inspector-card") as any;
        card.setConfig({ type: "custom:helman-solar-inspector-card" });
        card.hass = hass;
        document.body.appendChild(card);
    });
    await page.waitForFunction(() => (window as any).__pendingInspector() === 1);
    await page.evaluate(() => (window as any).__releaseInspector());
    await page.waitForFunction(() => !!(window as any).__inspector()?.shadowRoot?.querySelector(".body scheduling-day-editor-host"));
}

/** The inspector's day editor: whether it is open and the lane it selected. */
const dayEditor = (page: Page) => page.evaluate(async () => {
    const host = (window as any).__inspector().shadowRoot.querySelector("scheduling-day-editor-host");
    await host.updateComplete;
    const editor = host.shadowRoot.querySelector("scheduling-entity-day-editor");
    return { open: editor?.open === true, selected: editor?._selectedLaneKey ?? null };
});

test("Edit blocks opens the inspector's day editor over the device detail on its lane", async ({ page }) => {
    await mountInspector(page);
    // A device box in the breakdown asks for the device's detail.
    await page.evaluate(() => {
        const body = (window as any).__inspector().shadowRoot.querySelector(".body");
        const item = {
            id: "sensor.boiler_energy", name: "Boiler", displayName: "Boiler", children: [], valueType: "default",
            isSource: false, isUnmeasured: false, powerValue: 0, powerHistory: [0], historyBuckets: 1,
            switchEntityId: "switch.boiler", controllableIds: ["boiler"], ownControllableIds: ["boiler"], applianceKind: "generic",
        };
        body.firstElementChild.dispatchEvent(new CustomEvent("show-device-detail", { detail: { item }, bubbles: true, composed: true }));
    });
    const detail = page.locator("helman-solar-inspector node-detail-dialog");
    await detail.locator("helman-detail-section[data-schedule] button").first().click();
    await detail.locator("helman-node-control [data-edit-blocks]").click();
    await expect.poll(() => dayEditor(page)).toEqual({ open: true, selected: "boiler" });
    await page.evaluate(() => {
        const host = (window as any).__inspector().shadowRoot.querySelector("scheduling-day-editor-host");
        host.shadowRoot.querySelector("scheduling-entity-day-editor").shadowRoot.querySelector("ha-dialog").close();
    });
    await expect.poll(() => dayEditor(page).then((editor) => editor.open)).toBe(false);
    await expect(detail.locator("helman-node-control")).toBeVisible();
});

test("lane icon in the inspector's schedule strip opens the device detail dialog", async ({ page }) => {
    await mountInspector(page);
    await page.evaluate(() => {
        const inspector = (window as any).__inspector();
        const strip = inspector.shadowRoot.querySelector("helman-solar-schedule-band-strip");
        const band = strip.shadowRoot.querySelector("scheduling-entity-day-band");
        const badge = band.shadowRoot.querySelector(".track-label state-badge, .track-label ha-icon");
        if (!badge) throw new Error("no badge in strip");
        badge.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    });
    const detail = page.locator("helman-solar-inspector node-detail-dialog");
    await expect(detail.locator('[slot="headerTitle"]')).toHaveText("Boiler");
});

test("lane icon for inverter in inspector opens the inverter detail dialog", async ({ page }) => {
    await mountInspector(page);
    await page.evaluate(() => {
        const body = (window as any).__inspector().shadowRoot.querySelector(".body");
        body.firstElementChild.dispatchEvent(new CustomEvent("show-controllable-detail", {
            detail: { controllableId: "inverter", entityId: "select.helman_inverter_mode" },
            bubbles: true,
            composed: true,
        }));
    });
    const detail = page.locator("helman-solar-inspector node-detail-dialog");
    await expect(detail.locator('[slot="headerTitle"]')).toHaveText("Inverter");
});
