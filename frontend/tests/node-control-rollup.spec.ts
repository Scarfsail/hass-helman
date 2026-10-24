import { test, expect, type Page } from "@playwright/test";
import { prepareNodeDetailPage, mountSimpleCard, treeNode } from "./support/node-detail-harness";
import { energyFields, treePayload } from "./support/payload-builders";
import type { SchedulePayload, TreeItemDTO } from "../cards/helman-api";

/**
 * The house's Control roll-up, the grid's and solar's pointer to the
 * inverter, and the shared card host's navigation between details, on both
 * power cards against a fake backend.
 *
 * What is pinned: the house's system switches (execution for everyone through
 * the shared schedule owner, the automation master switch an admin's through
 * the revision-checked config save), each disabled while it writes and never
 * left flipped by a failed write; one row per distinct lane, the inverter
 * first and then in tree order, a shared meter's lanes as separate labelled
 * rows and an offline device's lane kept; a row, or the inverter pointer,
 * requesting that node's Control tab through the one host entry point; and
 * that host's tab selection, tree refresh, watched entities and Back.
 */

declare global {
    interface Window {
        __schedule: SchedulePayload;
        __toasts: string[];
        __release: (() => void) | null;
    }
}

const DAY = "2026-10-21";
const auto = (action: object) => ({ ...action, setBy: "automation" });
const user = (action: object) => ({ ...action, setBy: "user" });

/** 15-minute slots from 12:00 for six hours, the inverter "normal" by the automation and `lanes` added from `from` to `to` (HH:MM, UTC). */
function plan(stretches: Array<[from: string, to: string, lanes: Record<string, object>]> = [], executionEnabled = true): SchedulePayload {
    const slots = [];
    for (let ms = Date.parse(`${DAY}T12:00:00Z`); ms < Date.parse(`${DAY}T18:00:00Z`); ms += 900_000) {
        const id = new Date(ms).toISOString().replace(".000Z", "+00:00");
        const controllables: Record<string, object> = { inverter: auto({ kind: "normal" }) };
        for (const [from, to, lanes] of stretches) {
            if (ms >= Date.parse(`${DAY}T${from}:00Z`) && ms < Date.parse(`${DAY}T${to}:00Z`)) Object.assign(controllables, lanes);
        }
        slots.push({ id, controllables });
    }
    return { executionEnabled, slotMinutes: 15, slots } as unknown as SchedulePayload;
}

const device = (name: string, overrides: Partial<TreeItemDTO>) => {
    const key = name.toLowerCase().replace(/ /g, "_");
    return treeNode({ id: `sensor.${key}_energy`, displayName: name, energyEntityId: `sensor.${key}_energy`, powerSensorId: `sensor.${key}_power`, ...overrides });
};

const share = (id: string, name: string) => treeNode({
    id, displayName: name, isEstimated: true, powerSensorId: `sensor.helman_share_power_${id.replace(/-/g, "_")}`,
    controllableIds: [id], applianceKind: "generic", deferrable: true,
});

const energyNode = (id: string, sourceType: string | null) => treeNode({
    id, displayName: id, powerSensorId: `sensor.${id}`, sourceType, isSource: sourceType !== null, ...energyFields(id),
});

/** The power cards' roots, the house carrying the devices the roll-up lists. */
const TREE = treePayload({
    sources: [energyNode("solar", "solar"), energyNode("grid", "grid"), energyNode("battery", "battery")],
    consumers: [{
        ...energyNode("house", null),
        childrenFullWidth: true,
        children: [
            device("Boiler", { controllableIds: ["boiler"], ownControllableIds: ["boiler"], applianceKind: "generic", switchEntityId: "switch.boiler" }),
            // A breaker carved for two meterless pumps: both lanes are its meter's, and each pump's own row repeats its lane.
            device("Pumps", {
                deferrable: true, ownDeferrable: true, ownControllableIds: ["pump-a", "pump-b"], switchEntityId: "switch.pumps_breaker",
                children: [share("pump-a", "Pump A"), share("pump-b", "Pump B")],
            }),
            // Configured, but its meter and its switch report nothing.
            device("Garage", { controllableIds: ["garage"], ownControllableIds: ["garage"], applianceKind: "generic" }),
            device("Lamp", { switchEntityId: "switch.lamp" }),
        ],
    }],
    uiConfig: { show_others_group: false, device_groupings: [], history_buckets: 3, history_bucket_duration: 60 },
});

const generic = (id: string, name: string) => ({
    id, name, kind: "generic", primaryEntityId: `switch.${id}`, supportsAuthoring: true, normalState: "off",
    metadata: { icon: "mdi:power-plug", scheduleCapabilities: { onOffToggle: true } }, controls: { switch: { entityId: `switch.${id}` } },
});

const INVERTER = {
    id: "inverter", name: "Inverter", kind: "inverter", primaryEntityId: "select.inverter_mode", supportsAuthoring: true,
    normalState: "normal", actionOptions: { normal: "normal", stop_export: "stop_export" },
};

const APPLIANCES = [generic("boiler", "Boiler"), generic("pump-a", "Pump A"), generic("pump-b", "Pump B"), generic("garage", "Garage")];

interface Setup {
    schedule?: SchedulePayload;
    admin?: boolean;
    /** The roster has no inverter: no controllable inverter is configured. */
    noInverter?: boolean;
    /** Hold each execution write and config save until `__release`. */
    hold?: boolean;
    /** Every execution write fails. */
    executionFails?: boolean;
    /** Every config save fails. */
    saveFails?: boolean;
    /** Hold every schedule read after the first until `__release`. */
    holdRefresh?: boolean;
    /** Hold the roster read until `__release`. */
    holdRoster?: boolean;
    /** Every roster read fails. */
    rosterFails?: boolean;
    /** The stored config an admin reads. */
    config?: object;
}

async function mount(page: Page, setup: Setup = {}, card = "helman-simple-card"): Promise<void> {
    await prepareNodeDetailPage(page);
    await page.evaluate(({ o, tree, schedule, roster }) => {
        const s = window.__nodeDetailState;
        window.__toasts = [];
        window.__release = null;
        window.__schedule = schedule;
        window.addEventListener("hass-notification", (event) => window.__toasts.push((event as CustomEvent).detail.message));
        const held = <T>(answer: () => T, hold = o.hold) => hold ? new Promise<T>((resolve) => { window.__release = () => resolve(answer()); }) : answer();
        let scheduleReads = 0;
        window.__configureNodeDetail({
            tree,
            states: {
                "sensor.solar": s("4200", "W"), "sensor.grid": s("-300", "W"), "sensor.battery": s("-500", "W"), "sensor.house": s("1200", "W"),
                "sensor.boiler_power": s("2000", "W"), "sensor.pumps_power": s("300", "W"),
                "select.inverter_mode": s("normal"), "switch.boiler": s("on"), "switch.pump-a": s("off"), "switch.pump-b": s("off"), "switch.lamp": s("on"),
            },
            overviews: { inverter: window.__inverterOverview({ configured: !o.noInverter }) },
            hass: { user: { is_admin: !!o.admin } },
            replies: {
                "helman/get_schedule": () => held(() => window.__schedule, !!o.holdRefresh && scheduleReads++ > 0),
                "helman/set_schedule": () => window.__schedule,
                "helman/set_schedule_execution": (request: { enabled: boolean }) => held(() => {
                    if (o.executionFails) throw new Error("execution refused");
                    window.__schedule = { ...window.__schedule, executionEnabled: request.enabled };
                    return window.__schedule;
                }),
                "helman/get_appliances": () => held(() => {
                    if (o.rosterFails) throw new Error("roster refused");
                    return { appliances: roster };
                }, !!o.holdRoster),
                "helman/get_automation_coverage": { masterEnabled: true, controllables: {
                    inverter: { state: "active", optimizerIds: ["export_price"] },
                    boiler: { state: "active", optimizerIds: ["surplus"] },
                } },
                "helman/get_config": o.config ?? { automation: { enabled: true, system_optimizers: [], appliance_optimizers: [] } },
                ...(o.saveFails ? { "helman/save_config": () => { throw new Error("save exploded"); } } : {}),
                ...(o.hold ? { "helman/save_config": () => held(() => ({ success: true, validation: { valid: true, errors: [], warnings: [] }, reloadStarted: true })) } : {}),
                "helman/get_device_stats": null,
                "recorder/statistic_during_period": { change: 1 },
            },
        });
    }, { o: setup, tree: TREE, schedule: setup.schedule ?? plan(), roster: setup.noInverter ? APPLIANCES : [INVERTER, ...APPLIANCES] });
    await mountSimpleCard(page, undefined, card);
}

const dialog = (page: Page) => page.locator("node-detail-dialog");
const tab = (page: Page, name: "overview" | "control") => page.locator(`node-detail-dialog [data-tab="${name}"]`);
const house = (page: Page) => page.locator("helman-house-control");
const lane = (page: Page, id: string) => house(page).locator(`[data-lane="${id}"]`);
const link = (page: Page) => page.locator("helman-inverter-control-link");
const controls = (page: Page) => page.locator("helman-node-control");
const requests = (page: Page, type: string) => page.evaluate((type) => window.__NodeDetailRequests.filter((r) => r.type === type), type);
const hostState = (page: Page) => page.evaluate(() => {
    const card = document.querySelector("helman-simple-card, helman-card") as any;
    const target = card._host.dialogRequest;
    return { target: typeof target === "string" || target === null ? target : target.id, tab: card._host._dialogTabRequest.tab };
});

/** Open an energy node's detail the ordinary way, from the card. */
async function openNode(page: Page, node: "house" | "grid" | "solar"): Promise<void> {
    await page.locator(`.node-cell:has(simple-card-${node}), .node-icon:has(simple-card-${node})`).first().click();
    await expect(dialog(page)).toHaveCount(1);
}

async function openHouseControl(page: Page): Promise<void> {
    await openNode(page, "house");
    await tab(page, "control").click();
    await expect(house(page)).toBeVisible();
}

test.describe("the house's lanes", () => {
    test("the inverter first, then each distinct lane once in tree order, a shared meter's lanes apart and an offline device kept", async ({ page }) => {
        await mount(page, { schedule: plan([["12:00", "13:00", { "pump-a": user({ on: true }) }]]) });
        await openHouseControl(page);
        const rows = house(page).locator("[data-lane]");
        await expect(rows).toHaveCount(5);
        expect(await rows.evaluateAll((all) => all.map((row) => row.getAttribute("data-lane")))).toEqual(["inverter", "boiler", "pump-a", "pump-b", "garage"]);
        await expect(house(page).locator("[data-lane-name]")).toHaveText(["Inverter", "Boiler", "Pump A", "Pump B", "Garage"]);
        // The shared meter's lanes each name the device they open.
        await expect(lane(page, "pump-a").locator("[data-lane-device]")).toHaveText("Pumps");
        await expect(lane(page, "pump-b").locator("[data-lane-device]")).toHaveText("Pumps");
        await expect(lane(page, "boiler").locator("[data-lane-device]")).toHaveCount(0);
        // Each lane's own owner, never one status for the meter.
        await expect(lane(page, "inverter").locator("[data-status]")).toHaveText("Automatic");
        await expect(lane(page, "pump-a").locator("[data-status]")).toHaveText("Manual until Today 13:00");
        await expect(lane(page, "pump-b").locator("[data-status]")).toHaveText("Not automated");
        await expect(lane(page, "garage").locator("[data-status]")).toHaveText("Not automated");
    });

    test("without a controllable inverter there is no inverter row", async ({ page }) => {
        await mount(page, { noInverter: true });
        await openHouseControl(page);
        await expect(house(page).locator("[data-lane]")).toHaveCount(4);
        await expect(lane(page, "inverter")).toHaveCount(0);
    });

    test("a row requests its device's Control tab, several lanes the same device", async ({ page }) => {
        await mount(page);
        await openHouseControl(page);
        await lane(page, "pump-b").click();
        await expect(page.locator("node-detail-device-content")).toHaveCount(0);
        await expect(tab(page, "control")).toHaveAttribute("aria-selected", "true");
        expect(await hostState(page)).toEqual({ target: "sensor.pumps_energy", tab: "control" });
        await expect(controls(page)).toHaveCount(2);
        expect(await controls(page).locator("[data-control]").evaluateAll((all) => all.map((element) => element.getAttribute("data-control")))).toEqual(["pump-a", "pump-b"]);
    });

    test("the inverter row requests the inverter's Control tab by its type, from the keyboard too", async ({ page }) => {
        await mount(page);
        await openHouseControl(page);
        await lane(page, "inverter").focus();
        await page.keyboard.press("Enter");
        await expect(controls(page).locator("[data-control]")).toHaveAttribute("data-control", "inverter");
        expect(await hostState(page)).toEqual({ target: "inverter", tab: "control" });
    });

    test("a row pressed from the keyboard leaves focus on the Control tab it opened", async ({ page }) => {
        await mount(page);
        await openHouseControl(page);
        await lane(page, "boiler").focus();
        await page.keyboard.press("Enter");
        await expect(controls(page).locator("[data-control]")).toHaveAttribute("data-control", "boiler");
        await expect(tab(page, "control")).toBeFocused();
    });

    test("until the roster is read the lanes are loading, never a list without the inverter", async ({ page }) => {
        await mount(page, { holdRoster: true });
        await openHouseControl(page);
        await expect(house(page).locator("[data-roster-pending]")).toHaveText("Loading…");
        await expect(house(page).locator("[data-lane]")).toHaveCount(0);
        await page.evaluate(() => window.__release!());
        await expect(house(page).locator("[data-roster-pending]")).toHaveCount(0);
        expect(await house(page).locator("[data-lane]").evaluateAll((all) => all.map((row) => row.getAttribute("data-lane")))).toEqual(["inverter", "boiler", "pump-a", "pump-b", "garage"]);
    });

    test("a roster that cannot be read says so, with no lanes", async ({ page }) => {
        await mount(page, { rosterFails: true });
        await openHouseControl(page);
        await expect(house(page).locator("[data-roster-pending]")).toHaveText("Control state unavailable");
        await expect(house(page).locator("[data-lane], [data-no-lanes]")).toHaveCount(0);
    });
});

test.describe("the house's system switches", () => {
    const executionSwitch = (page: Page) => house(page).locator("[data-execution] ha-switch");
    const automationSwitch = (page: Page) => house(page).locator("[data-automation] ha-switch");
    const flip = (target: ReturnType<typeof executionSwitch>, checked: boolean) => target.evaluate((element: any, checked) => {
        element.checked = checked;
        element.dispatchEvent(new Event("change"));
    }, checked);

    test("a non-admin gets execution but no automation switch, and the config is never read", async ({ page }) => {
        await mount(page);
        await openHouseControl(page);
        await expect(executionSwitch(page)).toHaveAttribute("aria-label", "Schedule execution");
        await expect(executionSwitch(page)).toHaveJSProperty("checked", true);
        await expect(automationSwitch(page)).toHaveCount(0);
        expect(await requests(page, "helman/get_config")).toHaveLength(0);
    });

    test("execution writes through the schedule owner, disabled while it writes", async ({ page }) => {
        await mount(page, { hold: true });
        await openHouseControl(page);
        await expect(executionSwitch(page)).toHaveJSProperty("disabled", false);
        await flip(executionSwitch(page), false);
        await expect.poll(() => requests(page, "helman/set_schedule_execution")).toEqual([expect.objectContaining({ enabled: false })]);
        await expect(executionSwitch(page)).toHaveJSProperty("disabled", true);
        await page.evaluate(() => window.__release!());
        await expect(executionSwitch(page)).toHaveJSProperty("disabled", false);
        await expect(executionSwitch(page)).toHaveJSProperty("checked", false);
        // Every lane now says so.
        await expect(lane(page, "boiler").locator("[data-status]")).toHaveText("Execution off");
    });

    test("execution is disabled from the press while its write waits behind a read, and a second press is ignored", async ({ page }) => {
        await mount(page, { holdRefresh: true });
        await openHouseControl(page);
        await expect(executionSwitch(page)).toHaveJSProperty("disabled", false);
        // A schedule re-read in flight: the write queues behind it.
        await page.evaluate(() => window.__fireDataChanged("schedule"));
        await expect.poll(() => page.evaluate(() => window.__release !== null)).toBe(true);
        await flip(executionSwitch(page), false);
        await expect(executionSwitch(page)).toHaveJSProperty("disabled", true);
        await flip(executionSwitch(page), true);
        await page.evaluate(() => window.__release!());
        await expect(executionSwitch(page)).toHaveJSProperty("disabled", false);
        expect(await requests(page, "helman/set_schedule_execution")).toEqual([expect.objectContaining({ enabled: false })]);
        await expect(executionSwitch(page)).toHaveJSProperty("checked", false);
    });

    test("a refused execution write is shown and leaves the switch as stored", async ({ page }) => {
        await mount(page, { executionFails: true });
        await openHouseControl(page);
        await flip(executionSwitch(page), false);
        await expect(house(page).locator("[data-execution-error]")).toContainText("execution refused");
        await expect(executionSwitch(page)).toHaveJSProperty("checked", true);
    });

    test("an admin's automation switch saves only automation.enabled with the revision read, disabled while saving", async ({ page }) => {
        await mount(page, { admin: true, hold: true });
        await openHouseControl(page);
        await expect(automationSwitch(page)).toHaveAttribute("aria-label", "Automation");
        await expect(automationSwitch(page)).toHaveJSProperty("disabled", false);
        await expect(automationSwitch(page)).toHaveJSProperty("checked", true);
        await flip(automationSwitch(page), false);
        await expect.poll(() => requests(page, "helman/save_config").then((list) => list.length)).toBe(1);
        await expect(automationSwitch(page)).toHaveJSProperty("disabled", true);
        const [saved] = await requests(page, "helman/save_config");
        expect(saved.config).toEqual({ automation: { enabled: false, system_optimizers: [], appliance_optimizers: [] } });
        expect(saved.expected_revision).toBe(await page.evaluate(() => window.__configRevision({
            automation: { enabled: true, system_optimizers: [], appliance_optimizers: [] },
        })));
        await page.evaluate(() => window.__release!());
        await expect(automationSwitch(page)).toHaveJSProperty("disabled", false);
        await expect(automationSwitch(page)).toHaveJSProperty("checked", false);
        expect(await page.evaluate(() => window.__toasts)).toEqual(["Config saved. Helman reload started."]);
    });

    test("the automation switch reads the config as the backend does: no block is off, a block without the flag is on", async ({ page }) => {
        await mount(page, { admin: true, config: {} });
        await openHouseControl(page);
        await expect(automationSwitch(page)).toHaveJSProperty("disabled", false);
        await expect(automationSwitch(page)).toHaveJSProperty("checked", false);

        await mount(page, { admin: true, config: { automation: { system_optimizers: [], appliance_optimizers: [] } } });
        await openHouseControl(page);
        await expect(automationSwitch(page)).toHaveJSProperty("disabled", false);
        await expect(automationSwitch(page)).toHaveJSProperty("checked", true);
    });

    test("a failed automation save says so and never shows the flip", async ({ page }) => {
        await mount(page, { admin: true, saveFails: true });
        await openHouseControl(page);
        await expect(automationSwitch(page)).toHaveJSProperty("disabled", false);
        await flip(automationSwitch(page), false);
        await expect.poll(() => page.evaluate(() => window.__toasts)).toEqual([expect.stringContaining("save exploded")]);
        await expect(automationSwitch(page)).toHaveJSProperty("checked", true);
    });
});

test.describe("grid and solar point to the inverter", () => {
    for (const node of ["grid", "solar"] as const) {
        test(`${node}: the inverter's status and how export is controlled, opening the inverter's Control tab`, async ({ page }) => {
            await mount(page, { schedule: plan([["12:00", "13:00", { inverter: user({ kind: "stop_export" }) }]]) });
            await openNode(page, node);
            await tab(page, "control").click();
            await expect(link(page).locator("[data-status]")).toHaveText("Manual until Today 13:00");
            await expect(link(page).locator("[data-export-note]")).toContainText("Stop export");
            await link(page).locator("[data-open-inverter]").click();
            await expect(controls(page).locator("[data-control]")).toHaveAttribute("data-control", "inverter");
            expect(await hostState(page)).toEqual({ target: "inverter", tab: "control" });
        });

        test(`${node}: without a controllable inverter it says so and offers nothing to press`, async ({ page }) => {
            await mount(page, { noInverter: true });
            await openNode(page, node);
            await tab(page, "control").click();
            await expect(link(page).locator("[data-inverter-unavailable]")).toContainText("No controllable inverter");
            await expect(link(page).locator("button, ha-switch, [data-status]")).toHaveCount(0);
        });
    }
});

for (const card of ["helman-simple-card", "helman-card"]) {
    test.describe(`navigation on ${card}`, () => {
        const sources = (page: Page) => page.evaluate(() => [...(document.querySelector("helman-simple-card, helman-card") as any)._host._watchSources.keys()]
            .filter((source: string) => source.startsWith("node-detail")));

        test("an ordinary open lands on Overview, a request on Control, in place, and Back closes it", async ({ page }) => {
            await mount(page, {}, card);
            const historyLength = () => page.evaluate(() => window.history.length);
            const before = await historyLength();
            await openNode(page, "house");
            await expect(tab(page, "overview")).toHaveAttribute("aria-selected", "true");
            await expect(page.locator("node-detail-house-content")).toHaveCount(1);
            await tab(page, "control").click();
            await lane(page, "boiler").click();
            await expect(controls(page).locator("[data-control]")).toHaveAttribute("data-control", "boiler");
            await expect(tab(page, "control")).toHaveAttribute("aria-selected", "true");
            // Watched entities follow the new target: the house's are forgotten, the boiler's lane is watched.
            await expect.poll(() => sources(page)).toEqual(["node-detail:control:boiler"]);
            // One dialog, one history entry, whatever it swapped to.
            expect(await historyLength()).toBe(before + 1);
            await expect(dialog(page)).toHaveCount(1);

            // HA's dialog closes on its close action, which Back presses.
            await dialog(page).evaluate((detail: any) => {
                const haDialog = detail.shadowRoot.querySelector("ha-dialog");
                detail.shadowRoot.querySelector("[data-dialog='close']").addEventListener("click", () => haDialog.close());
            });
            await page.evaluate(() => window.history.back());
            await expect(dialog(page)).toHaveCount(0);
            expect(await hostState(page).then((state) => state.target)).toBeNull();

            // Opening again the ordinary way is an Overview again.
            await openNode(page, "grid");
            await expect(tab(page, "overview")).toHaveAttribute("aria-selected", "true");
        });

        test("asking for the same node's Control again selects it, and a refreshed tree keeps the target and tab", async ({ page }) => {
            await mount(page, {}, card);
            await openHouseControl(page);
            await lane(page, "boiler").click();
            await expect(controls(page)).toHaveCount(1);
            await tab(page, "overview").click();
            await expect(page.locator("node-detail-device-content")).toHaveCount(1);
            // The same node, asked for again from inside the dialog.
            await dialog(page).evaluate((element) => {
                const card = document.querySelector("helman-simple-card, helman-card") as any;
                element.dispatchEvent(new CustomEvent("helman-node-detail-request", {
                    bubbles: true, composed: true, detail: { target: card._host.dialogRequest, tab: "control" },
                }));
            });
            await expect(tab(page, "control")).toHaveAttribute("aria-selected", "true");
            await expect(controls(page)).toHaveCount(1);

            // A refreshed tree re-resolves the target to its new item and keeps the tab.
            await page.evaluate(() => { (window as any).__before = (document.querySelector("helman-simple-card, helman-card") as any)._host.dialogRequest; });
            const reads = (await requests(page, "helman/get_device_tree")).length;
            await page.evaluate(() => {
                window.__fireDataChanged("config");
                document.dispatchEvent(new Event("visibilitychange"));
            });
            await expect.poll(() => requests(page, "helman/get_device_tree").then((list) => list.length)).toBeGreaterThan(reads);
            await expect.poll(() => page.evaluate(() => {
                const target = (document.querySelector("helman-simple-card, helman-card") as any)._host.dialogRequest;
                return target !== (window as any).__before && target?.id;
            })).toBe("sensor.boiler_energy");
            await expect(tab(page, "control")).toHaveAttribute("aria-selected", "true");
            await expect(controls(page).locator("[data-control]")).toHaveAttribute("data-control", "boiler");
        });
    });
}
