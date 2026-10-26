import { test, expect, type Page } from "@playwright/test";
import { prepareNodeDetailPage, mountSimpleCard, treeNode } from "./support/node-detail-harness";
import { treePayload } from "./support/payload-builders";
import type { SchedulePayload, TreeItemDTO } from "../cards/helman-api";

/**
 * The Schedule tab of a device's detail, opened from the device's name on the
 * power card, against a fake backend.
 *
 * What is pinned: a schedulable device gets one shared control block per
 * controllable it is, each writing its own lane and keeping every other
 * lane's user action; a lane whose actions cannot be authored is shown with
 * why and offers no override; a device Helman does not schedule gets Home
 * Assistant's own switch toggle and climate more-info instead, never a plan;
 * and a passive meter has no tabs at all.
 */

declare global {
    interface Window {
        __deepAll: (root: ParentNode, selector: string, out?: Element[]) => Element[];
        __serviceCalls: Array<[string, string, Record<string, unknown>]>;
        __moreInfo: string[];
    }
}

const DAY = "2026-10-21";
const auto = (action: object) => ({ ...action, setBy: "automation" });
const user = (action: object) => ({ ...action, setBy: "user" });

/** 15-minute slots from 12:00 for six hours, the inverter "normal" by the automation and `lanes` added from `from` to `to` (HH:MM, UTC). */
function plan(stretches: Array<[from: string, to: string, lanes: Record<string, object>]> = []): SchedulePayload {
    const slots = [];
    for (let ms = Date.parse(`${DAY}T12:00:00Z`); ms < Date.parse(`${DAY}T18:00:00Z`); ms += 900_000) {
        const id = new Date(ms).toISOString().replace(".000Z", "+00:00");
        const controllables: Record<string, object> = { inverter: auto({ kind: "normal" }) };
        for (const [from, to, lanes] of stretches) {
            if (ms >= Date.parse(`${DAY}T${from}:00Z`) && ms < Date.parse(`${DAY}T${to}:00Z`)) Object.assign(controllables, lanes);
        }
        slots.push({ id, controllables });
    }
    return { executionEnabled: true, slotMinutes: 15, slots } as unknown as SchedulePayload;
}

const device = (name: string, overrides: Partial<TreeItemDTO>) => {
    const meter = `sensor.${name.toLowerCase().replace(/ /g, "_")}_energy`;
    return treeNode({ id: meter, displayName: name, energyEntityId: meter, powerSensorId: `sensor.${name.toLowerCase().replace(/ /g, "_")}_power`, ...overrides });
};

/** A meterless child's row: its share of its parent's meter, as the tree builder emits it for a schedulable one. */
const share = (id: string, name: string) => treeNode({
    id, displayName: name, isEstimated: true, powerSensorId: `sensor.helman_share_power_${id.replace(/-/g, "_")}`,
    switchEntityId: `switch.${id}`, controllableIds: [id], applianceKind: "generic", deferrable: true,
});

const TREE = treePayload({
    sources: [treeNode({ id: "solar", displayName: "Solar", powerSensorId: "sensor.solar", isSource: true, sourceType: "solar" })],
    consumers: [treeNode({
        id: "house", displayName: "House", powerSensorId: "sensor.house", childrenFullWidth: true,
        children: [
            device("Boiler", { icon: "mdi:water-boiler", controllableIds: ["boiler"], ownControllableIds: ["boiler"], applianceKind: "generic", switchEntityId: "switch.boiler" }),
            device("Klima", { controllableIds: ["klima"], ownControllableIds: ["klima"], applianceKind: "climate", climateEntityId: "climate.klima" }),
            // A breaker Helman does not schedule, carved for its two schedulable
            // meterless pumps: the lanes are its meter's own, not its.
            device("Pumps", {
                deferrable: true, ownDeferrable: true, ownControllableIds: ["pump-a", "pump-b"], switchEntityId: "switch.pumps_breaker",
                children: [share("pump-a", "Pump A"), share("pump-b", "Pump B")],
            }),
            device("Legacy", { controllableIds: ["legacy"], ownControllableIds: ["legacy"], applianceKind: "generic" }),
            device("Lamp", { switchEntityId: "switch.lamp" }),
            device("Living Light", { switchEntityId: "light.living_room" }),
            device("Bedroom AC", { climateEntityId: "climate.bedroom" }),
            device("Heater", { switchEntityId: "switch.heater_breaker", climateEntityId: "climate.heater" }),
            // A meterless air conditioner: its running signal is its climate entity.
            treeNode({ id: "office-ac", displayName: "Office AC", isEstimated: true, switchEntityId: "climate.office", climateEntityId: "climate.office" }),
            device("Meter", {}),
        ],
    })],
    consumptionTotalSensorId: null,
    productionTotalSensorId: null,
    uiConfig: { show_others_group: false, device_groupings: [], history_buckets: 3, history_bucket_duration: 5 },
});

const generic = (id: string, name: string, supportsAuthoring = true) => ({
    id, name, kind: "generic", primaryEntityId: `switch.${id}`, supportsAuthoring, normalState: "off",
    metadata: { icon: "mdi:power-plug", scheduleCapabilities: { onOffToggle: true } }, controls: { switch: { entityId: `switch.${id}` } },
});

const ROSTER = [
    { id: "inverter", name: "Inverter", kind: "inverter", primaryEntityId: "select.inverter_mode", supportsAuthoring: true, normalState: "normal", actionOptions: { normal: "normal" } },
    generic("boiler", "Boiler"),
    {
        id: "klima", name: "Klima", kind: "climate", primaryEntityId: "climate.klima", supportsAuthoring: true, normalState: "off",
        metadata: { icon: "mdi:air-conditioner", scheduleCapabilities: { modes: ["heat", "cool"] } }, controls: { climate: { entityId: "climate.klima" } },
    },
    generic("pump-a", "Pump A"),
    generic("pump-b", "Pump B"),
    generic("legacy", "Legacy", false),
];

async function mount(page: Page, schedule: SchedulePayload = plan()): Promise<void> {
    await prepareNodeDetailPage(page);
    await page.evaluate(({ tree, schedule, roster }) => {
        window.__deepAll = function deepAll(root: ParentNode, selector: string, out: Element[] = []) {
            for (const element of Array.from(root.querySelectorAll("*"))) {
                if (element.matches(selector)) out.push(element);
                if (element.shadowRoot) deepAll(element.shadowRoot, selector, out);
            }
            return out;
        };
        // HA's entity toggle: reflects the state handed to it, and a click asks for the other one.
        customElements.define("ha-entity-toggle", class extends HTMLElement {
            hass: any;
            private _stateObj: any;
            set stateObj(value: any) {
                this._stateObj = value;
                this.setAttribute("data-state", value?.state ?? "");
                this.setAttribute("data-entity", value?.entity_id ?? "");
            }
            get stateObj() { return this._stateObj; }
            connectedCallback() {
                this.textContent = "toggle";
                this.addEventListener("click", () => {
                    const on = this._stateObj?.state === "on";
                    this.hass.callService("homeassistant", on ? "turn_off" : "turn_on", { entity_id: this._stateObj.entity_id });
                });
            }
        });
        customElements.define("ha-state-icon", class extends HTMLElement {
            set stateObj(value: any) {
                this.setAttribute("data-entity", value?.entity_id ?? "");
                this.setAttribute("data-icon", value?.attributes?.icon ?? "");
                this.setAttribute("data-state", value?.state ?? "");
            }
        });
        window.__serviceCalls = [];
        window.__moreInfo = [];
        document.addEventListener("hass-more-info", (event) => window.__moreInfo.push((event as CustomEvent).detail.entityId));
        const s = window.__nodeDetailState;
        const states: Record<string, any> = {
            "sensor.solar": s("4200", "W"), "sensor.house": s("1200", "W"),
            "sensor.lamp_power": s("75", "W"), "sensor.boiler_power": s("100", "W"),
            "switch.boiler": s("off", undefined, { icon: "mdi:radiator" }), "climate.klima": s("off", undefined, { friendly_name: "Klima thermostat" }), "switch.pumps_breaker": s("on"), "switch.pump-a": s("off"), "switch.pump-b": s("off"),
            "switch.lamp": s("on", undefined, { friendly_name: "Lamp switch", icon: "mdi:lightbulb" }),
            "light.living_room": s("off", undefined, { friendly_name: "Living room light" }),
            "climate.bedroom": s("cool", undefined, { friendly_name: "Bedroom thermostat" }),
            "switch.heater_breaker": s("off", undefined, { friendly_name: "Heater breaker" }),
            "climate.heater": s("heat", undefined, { friendly_name: "Heater thermostat" }),
            "climate.office": s("off", undefined, { friendly_name: "Office thermostat" }),
        };
        for (const [id, state] of Object.entries(states)) state.entity_id = id;
        (window as any).__schedule = schedule;
        window.__configureNodeDetail({
            tree, states, schedule,
            hass: { user: { is_admin: false }, callService: async (domain: string, service: string, data: Record<string, unknown>) => {
                window.__serviceCalls.push([domain, service, data]);
            } },
            replies: {
                "helman/get_appliances": { appliances: roster },
                "helman/get_automation_coverage": { masterEnabled: true, controllables: { boiler: { state: "active", optimizerIds: ["surplus"] } } },
                "helman/set_schedule": () => (window as any).__schedule,
                "helman/get_device_stats": null,
                "recorder/statistic_during_period": { change: 1 },
            },
        });
    }, { tree: TREE, schedule, roster: ROSTER });
    await mountSimpleCard(page, undefined, "helman-card");
    // Every device's row, not only the top three.
    await page.locator("helman-house-devices-section button.show-toggle").click();
    await expect.poll(() => page.evaluate(() => window.__deepAll(document, "helman-tree-item").length)).toBeGreaterThan(9);
}

async function openDevice(page: Page, name: string): Promise<void> {
    await page.evaluate((name) => {
        const row = window.__deepAll(document, "helman-tree-item").find((candidate) =>
            (candidate.shadowRoot?.querySelector(".deviceName")?.textContent ?? "").trim() === name);
        if (!row) throw new Error(`no row named ${name}`);
        (row.shadowRoot!.querySelector(".deviceName") as HTMLElement).click();
    }, name);
    await expect(page.locator("node-detail-device-content")).toHaveCount(1);
}

const scheduleButton = (page: Page) => page.locator("node-detail-dialog helman-detail-section[data-schedule] button").first();
const controls = (page: Page) => page.locator("helman-node-control");
const switchTile = (page: Page) => page.locator("node-detail-device-content helman-switch-tile");
const overrideDialog = (page: Page) => page.locator("control-override-dialog");
const writes = (page: Page) => page.evaluate(() => window.__NodeDetailRequests.filter((r) => r.type === "helman/set_schedule").map((r) => r.slots));

async function openControl(page: Page, name: string): Promise<void> {
    await openDevice(page, name);
    await scheduleButton(page).click();
}

/** Override a control's lane from now for an hour with the editor option `mode`. */
async function override(page: Page, control: ReturnType<typeof controls>, mode: string): Promise<void> {
    await control.locator("[data-change]").click();
    // The option's radio is visually hidden: a reader presses its chip.
    await overrideDialog(page).locator(`label:has(input[value="${mode}"])`).click();
    await overrideDialog(page).locator('[data-pick="plus_1h"]').click();
    await overrideDialog(page).locator("[data-save]").click();
    await expect(overrideDialog(page)).toHaveCount(0);
}

const hour = (lanes: Record<string, object>) => ["12:00", "12:15", "12:30", "12:45"].map((time) => ({ id: `${DAY}T${time}:00+00:00`, controllables: lanes }));

test.describe("a schedulable device", () => {
    test("Overview shows an unmet candidate as off and Back closes its override first", async ({ page }) => {
        await mount(page, plan([["12:00", "13:00", { boiler: auto({ on: true, conditionMet: false }) }]]));
        await openDevice(page, "Boiler");
        const overview = page.locator("node-detail-device-content helman-who-decides");
        await expect(overview.locator(".row").nth(1).locator("span").last()).toContainText("off until");
        await overview.locator("button").first().click();
        await expect(overrideDialog(page)).toBeVisible();
        await expect.poll(() => page.evaluate(() => window.history.state?.__helmanWhoDecidesOverrideId)).toBeTruthy();
        await page.evaluate(() => window.history.back());
        await expect(overrideDialog(page)).toHaveCount(0);
        await expect(page.locator("node-detail-device-content")).toBeVisible();

        await overview.locator("button").first().click();
        await overrideDialog(page).evaluate((dialog: any) => { dialog._saving = true; });
        await page.evaluate(() => new Promise<void>((resolve) => {
            window.addEventListener("popstate", () => resolve(), { once: true });
            window.history.back();
        }));
        await expect.poll(() => page.evaluate(() => window.history.state?.__helmanWhoDecidesOverrideId)).toBeTruthy();
        await expect(overrideDialog(page)).toBeVisible();
        await expect(page.locator("node-detail-device-content")).toBeVisible();
        await overrideDialog(page).evaluate((dialog: any) => { dialog._saving = false; });
        await page.evaluate(() => window.history.back());
        await expect(overrideDialog(page)).toHaveCount(0);
    });

    test("Planned now ends where the author changes and the summary skips that boundary", async ({ page }) => {
        await mount(page, plan([
            ["12:00", "14:00", { boiler: user({ on: true }) }],
            ["14:00", "17:00", { boiler: auto({ on: true }) }],
            ["17:00", "18:00", { boiler: auto({ on: false }) }],
        ]));
        await openDevice(page, "Boiler");
        const overview = page.locator("node-detail-device-content helman-who-decides");
        await expect(overview.locator(".row").nth(1).locator("span").last()).toHaveText("on until 14:00 · You");
        await expect(page.locator("node-detail-dialog helman-detail-section[data-schedule] [slot=summary]")).toContainText("Next: off at 17:00");
    });

    test("a climate lane's changes name its modes in words", async ({ page }) => {
        await mount(page, plan([["13:00", "14:00", { klima: auto({ mode: "heat" }) }]]));
        await openControl(page, "Klima");
        expect(await controls(page).locator("[data-change-row]").allInnerTexts()).toEqual(["13:00 Heat\nHelman's schedule", "14:00 Off\ndefault"]);
    });

    test("Planned now says nothing is planned in the house roll-up's words", async ({ page }) => {
        await mount(page, plan());
        await openDevice(page, "Boiler");
        await expect(page.locator("node-detail-device-content helman-who-decides .row").nth(1).locator("span").last()).toHaveText("Nothing planned");
    });

    test("the switch help names the next planned change", async ({ page }) => {
        await mount(page, plan([["12:00", "13:00", { boiler: auto({ on: true }) }]]));
        await openDevice(page, "Boiler");
        const tip = page.locator("node-detail-device-content helman-who-decides helman-help-tip");
        await expect.poll(() => tip.evaluate((el: any) => el.explanation)).toMatch(/next planned change at \d{1,2}[:.]\d{2}/);
        expect(await tip.evaluate((el: any) => el.explanation)).not.toContain("—");
    });

    test("the switch help omits the time when no change is planned", async ({ page }) => {
        await mount(page, plan());
        await openDevice(page, "Boiler");
        const tip = page.locator("node-detail-device-content helman-who-decides helman-help-tip");
        await expect.poll(() => tip.evaluate((el: any) => el.explanation)).toContain("next planned change, then");
        expect(await tip.evaluate((el: any) => el.explanation)).not.toContain("—");
    });

    test("the dialog is named by its visible slotted title", async ({ page }) => {
        await mount(page);
        await openDevice(page, "Boiler");
        const title = page.locator('node-detail-dialog [slot="headerTitle"]');
        await expect(title).toHaveAttribute("id", "node-detail-dialog-title");
        await expect(title).toContainText("Boiler");
        await expect.poll(() => page.locator("node-detail-dialog ha-dialog").evaluate((dialog: any) => dialog.ariaLabelledBy)).toBe("node-detail-dialog-title");
    });

    test("a generic device's override writes its own lane and keeps another lane's user action", async ({ page }) => {
        await mount(page, plan([["12:00", "13:00", { klima: user({ mode: "cool" }) }]]));
        await openDevice(page, "Boiler");
        await expect(switchTile(page)).toHaveCount(1);
        await scheduleButton(page).click();
        await expect(controls(page)).toHaveCount(1);
        await expect(controls(page).locator("[data-control]")).toHaveAttribute("data-control", "boiler");
        await expect(controls(page).locator("[data-status]")).toHaveText("Automatic");

        await override(page, controls(page), "on");
        expect(await writes(page)).toEqual([hour({ boiler: { on: true }, klima: { mode: "cool" } })]);
    });

    test("a climate device's override writes the climate lane through the climate editor", async ({ page }) => {
        await mount(page, plan([["12:00", "12:30", { boiler: user({ on: true }) }]]));
        await openControl(page, "Klima");
        await expect(controls(page).locator("[data-control]")).toHaveAttribute("data-control", "klima");
        await override(page, controls(page), "heat");
        expect(await writes(page)).toEqual([[
            ...hour({ boiler: { on: true }, klima: { mode: "heat" } }).slice(0, 2),
            ...hour({ klima: { mode: "heat" } }).slice(2),
        ]]);
    });

    test("a schedulable climate device offers climate more-info on Overview, with no toggle", async ({ page }) => {
        await mount(page);
        await openDevice(page, "Klima");
        await expect(switchTile(page)).toHaveCount(1);
        await expect(switchTile(page).locator("button")).toContainText("off");
        await switchTile(page).locator("button").click();
        expect(await page.evaluate(() => window.__moreInfo)).toEqual(["climate.klima"]);
    });

    test("a meter shared by two controllables has two independent controls in tree order", async ({ page }) => {
        await mount(page, plan([["12:00", "13:00", { "pump-a": user({ on: true }) }]]));
        await openControl(page, "Pumps");
        await expect(controls(page)).toHaveCount(2);
        // The breaker's switch is on Overview, separate from its lanes.
        await expect(controls(page).locator("[data-lane-name]")).toHaveText(["Pump A", "Pump B"]);
        await expect(controls(page).nth(0).locator("[data-status]")).toHaveText("Manual until Today 13:00");
        await expect(controls(page).nth(1).locator("[data-status]")).toHaveText("Not automated");
        await expect(controls(page).nth(1).locator("[data-return]")).toHaveCount(0);

        await override(page, controls(page).nth(1), "off");
        expect(await writes(page)).toEqual([hour({ "pump-a": { on: true }, "pump-b": { on: false } })]);
    });

    test("a lane whose actions cannot be authored is shown with why, and cannot be overridden", async ({ page }) => {
        await mount(page);
        await openControl(page, "Legacy");
        await expect(controls(page).locator("[data-control]")).toHaveAttribute("data-control", "legacy");
        await expect(controls(page).locator("[data-status]")).toHaveText("Not automated");
        await expect(controls(page).locator("[data-unsupported]")).toBeVisible();
        await expect(controls(page).locator("[data-change]")).toHaveCount(0);
        await expect(overrideDialog(page)).toHaveCount(0);
    });
});

test.describe("direct control tiles", () => {
    test("switch tile toggles and opens more-info on hold", async ({ page }) => {
        await mount(page);
        await openDevice(page, "Lamp");
        const tile = switchTile(page).locator("button");
        await expect(tile).toHaveAttribute("aria-pressed", "true");
        await tile.click();
        await expect.poll(() => page.evaluate(() => window.__NodeDetailRequests.filter((r) => r.type === "call_service").length)).toBe(1);
        await tile.hover();
        await page.mouse.down();
        await page.waitForTimeout(550);
        await page.mouse.up();
        expect(await page.evaluate(() => window.__moreInfo)).toContain("switch.lamp");
    });

    test("switch-only state updates reach the open tile and change its next toggle", async ({ page }) => {
        await mount(page);
        await openDevice(page, "Lamp");
        const tile = switchTile(page).locator("button");
        await expect(tile).toHaveAttribute("aria-pressed", "true");
        await page.evaluate(() => {
            const card = document.querySelector("helman-card") as any;
            card.hass = { ...window.__NodeDetailHass, states: {
                ...window.__NodeDetailHass.states,
                "switch.lamp": { ...window.__NodeDetailHass.states["switch.lamp"], state: "off" },
            } };
        });
        await expect(tile).toHaveAttribute("aria-pressed", "false");
        await tile.click();
        await expect.poll(() => page.evaluate(() => window.__NodeDetailRequests.find((r) => r.type === "call_service")?.service)).toBe("turn_on");
    });

    test("light control uses the light domain for both toggle directions", async ({ page }) => {
        await mount(page);
        await openDevice(page, "Living Light");
        const tile = switchTile(page).locator("button");
        await tile.click();
        await expect.poll(() => page.evaluate(() => window.__NodeDetailRequests.filter((r) => r.type === "call_service"))).toEqual([
            { type: "call_service", domain: "light", service: "turn_on", service_data: { entity_id: "light.living_room" } },
        ]);
        await page.evaluate(() => {
            const card = document.querySelector("helman-card") as any;
            card.hass = { ...window.__NodeDetailHass, states: {
                ...window.__NodeDetailHass.states,
                "light.living_room": { ...window.__NodeDetailHass.states["light.living_room"], state: "on" },
            } };
        });
        await expect(tile).toHaveAttribute("aria-pressed", "true");
        await tile.click();
        await expect.poll(() => page.evaluate(() => window.__NodeDetailRequests.filter((r) => r.type === "call_service").map((r) => [r.domain, r.service]))).toEqual([
            ["light", "turn_on"], ["light", "turn_off"],
        ]);
    });

    test("climate tile opens more-info and a passive meter has no Schedule", async ({ page }) => {
        await mount(page);
        await openDevice(page, "Bedroom AC");
        await switchTile(page).locator("button").click();
        expect(await page.evaluate(() => window.__moreInfo)).toContain("climate.bedroom");
        await openDevice(page, "Meter");
        await expect(scheduleButton(page)).toHaveCount(0);
    });

    test("climate-only state updates reach the tile", async ({ page }) => {
        await mount(page);
        await openDevice(page, "Bedroom AC");
        const tile = switchTile(page).locator("button");
        await expect(tile).toContainText("cool");
        await page.evaluate(() => {
            const card = document.querySelector("helman-card") as any;
            card.hass = { ...window.__NodeDetailHass, states: {
                ...window.__NodeDetailHass.states,
                "climate.bedroom": { ...window.__NodeDetailHass.states["climate.bedroom"], state: "heat" },
            } };
        });
        await expect(tile).toContainText("heat");
    });

    test("a device with switch and climate controls opens the thermostat separately", async ({ page }) => {
        await mount(page);
        await openDevice(page, "Heater");
        await expect(switchTile(page)).toHaveCount(1);
        expect(await switchTile(page).evaluate((tile: any) => tile.entityId)).toBe("switch.heater_breaker");
        await expect.poll(() => page.evaluate(() => {
            const watched = (document.querySelector("helman-card") as any)._host.watchedEntityIds;
            return watched.has("switch.heater_breaker") && watched.has("climate.heater");
        })).toBe(true);
        await page.locator("node-detail-device-content button.climate-control").click();
        expect(await page.evaluate(() => window.__moreInfo)).toEqual(["climate.heater"]);
    });
});
