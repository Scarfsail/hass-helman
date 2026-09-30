import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import {
    expandBreakdownGroups,
    loadCardBundle as loadInspectorBundle,
    mountInspector,
    selectDaySlots,
    waitForDayChart,
} from "./support/inspector-aggregate-harness";

/**
 * A device box's name opens that device's detail.
 *
 * The name used to toggle the box's children; that job moved to a chevron in
 * front of it, so the name is free to open one dialog per config device: its
 * live power and switch, the energy its own meter counted today and in the last
 * hour, and HA's history graph. Rows that are not devices -- virtual label
 * groups, the unmeasured remainder -- keep toggling and open nothing.
 *
 * Home Assistant's own pieces are stubbed at the edge: `callWS` answers the
 * recorder's statistics, `window.loadCardHelpers` hands back an element that
 * records the history-graph config it was built with, and `ha-dialog` only
 * shows its content while open.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const TODAY_KWH = 1.25;
const LAST_HOUR_KWH = 0.3;

/** Install the HA stubs every host needs: the dialog and the card helpers. */
async function installHaStubs(page: Page): Promise<void> {
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.evaluate(() => {
        (window as any).__chartConfigs = [];
        (window as any).loadCardHelpers = async () => ({
            createCardElement: (config: unknown) => {
                (window as any).__chartConfigs.push(config);
                const element = document.createElement("div");
                element.className = "history-graph-stub";
                return element;
            },
        });
        (window as any).__moreInfo = [];
        document.addEventListener("hass-more-info", (event: Event) => {
            (window as any).__moreInfo.push((event as CustomEvent).detail?.entityId);
        });
        // Every element matching a selector, through every shadow root below `root`.
        (window as any).__deepAll = function deepAll(root: ParentNode, selector: string, out: Element[] = []) {
            for (const element of Array.from(root.querySelectorAll("*"))) {
                if (element.matches(selector)) out.push(element);
                if (element.shadowRoot) deepAll(element.shadowRoot, selector, out);
            }
            return out;
        };
    });
}

/** A house child DTO with the defaults the backend fills in. */
function dto(overrides: Record<string, unknown>) {
    return {
        powerSensorId: null,
        switchEntityId: null,
        sourceType: null,
        sourceConfig: null,
        valueType: "default",
        isSource: false,
        isUnmeasured: false,
        isEstimated: false,
        groups: {},
        groupBadgeTexts: [],
        icon: null,
        compact: false,
        showAdditionalInfo: false,
        childrenFullWidth: true,
        hideChildren: false,
        hideChildrenIndicator: false,
        sortChildrenByPower: false,
        deferrable: false,
        controllableIds: [],
        energyEntityId: null,
        ratioSensorId: null,
        children: [],
        ...overrides,
    };
}

/**
 * The power card on a house with a metered boiler, whose meter a meterless pump
 * shares, and an unmeasured remainder. The boiler carries a label the card can
 * group by, so a virtual group is one chip away.
 *
 * `stats` is what `helman/get_device_stats` answers per device key; a key it
 * lacks has no record.
 */
async function mountCard(page: Page, stats: Record<string, unknown> = {}): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-card"));
    await installHaStubs(page);

    const tree = {
        sources: [dto({ id: "solar", displayName: "Solar", powerSensorId: "sensor.solar", isSource: true, sourceType: "solar" })],
        consumers: [
            dto({
                id: "house",
                displayName: "House",
                powerSensorId: "sensor.house",
                children: [
                    dto({
                        id: "sensor.boiler_energy",
                        displayName: "Boiler",
                        powerSensorId: "sensor.boiler_power",
                        switchEntityId: "switch.boiler",
                        energyEntityId: "sensor.boiler_energy",
                        icon: "mdi:water-boiler",
                        groups: { room: "kitchen" },
                        children: [
                            dto({
                                id: "pump",
                                displayName: "Pump",
                                powerSensorId: "sensor.pump_share",
                                isEstimated: true,
                                controllableIds: ["pump"],
                            }),
                        ],
                    }),
                    dto({
                        id: "house_unmeasured",
                        displayName: "",
                        powerSensorId: "sensor.house_unmeasured",
                        isUnmeasured: true,
                    }),
                ],
            }),
        ],
        consumptionTotalSensorId: null,
        productionTotalSensorId: null,
        uiConfig: {
            show_others_group: true,
            device_groupings: [{ id: "room", name: "Room", groups: [{ id: "kitchen", name: "Kitchen", short_name: "K" }] }],
            history_buckets: 3,
            history_bucket_duration: 5,
        },
    };

    await page.evaluate(
        async ({ tree, today, lastHour, stats }) => {
            const state = (value: string, attributes: Record<string, unknown> = {}) => ({ state: value, attributes });
            (window as any).__statRequests = [];
            (window as any).__deviceStatsRequests = [];
            const hass = {
                language: "en",
                locale: { language: "en" },
                config: { time_zone: "UTC" },
                connection: {
                    sendMessagePromise: async () => ({}),
                    subscribeMessage: async () => () => undefined,
                },
                states: {
                    "sensor.solar": state("0"),
                    "sensor.house": state("2000"),
                    "sensor.boiler_power": state("1200", { unit_of_measurement: "W" }),
                    "sensor.boiler_energy": state("10", { unit_of_measurement: "kWh" }),
                    "sensor.pump_share": state("300"),
                    "sensor.house_unmeasured": state("500"),
                    "switch.boiler": { entity_id: "switch.boiler", state: "on", attributes: {} },
                },
                callWS: async (msg: any) => {
                    if (msg.type === "helman/get_device_tree") return tree;
                    if (msg.type === "helman/get_history") {
                        return { buckets: 3, bucket_duration: 5, entity_history: {} };
                    }
                    if (msg.type === "helman/get_schedule") return { executionEnabled: true, slots: [] };
                    if (msg.type === "helman/get_device_stats") {
                        (window as any).__deviceStatsRequests.push(msg.device_key);
                        return (stats as Record<string, unknown>)[msg.device_key] ?? null;
                    }
                    if (msg.type === "recorder/statistic_during_period") {
                        (window as any).__statRequests.push(msg);
                        return { change: msg.calendar ? today : lastHour };
                    }
                    return {};
                },
            };
            const card = document.createElement("helman-card") as any;
            await card.setConfig({ type: "custom:helman-card" });
            card.hass = hass;
            document.body.appendChild(card);
        },
        { tree, today: TODAY_KWH, lastHour: LAST_HOUR_KWH, stats },
    );

    await expect.poll(() => rowNames(page)).toContain("Boiler");
}

/** Names of every device row on the page, through every shadow root. */
function rowNames(page: Page): Promise<string[]> {
    return page.evaluate(() =>
        (window as any).__deepAll(document, "helman-tree-item").map((row: any) =>
            (row.shadowRoot?.querySelector(".deviceName")?.textContent ?? "").trim()));
}

/** Click a part of the named row: its name, its chevron, or any selector inside. */
async function clickInRow(page: Page, name: string, selector: string): Promise<void> {
    await page.evaluate(({ name, selector }) => {
        const row = (window as any).__deepAll(document, "helman-tree-item").find((candidate: any) =>
            (candidate.shadowRoot?.querySelector(".deviceName")?.textContent ?? "").trim() === name);
        if (!row) throw new Error(`no row named ${name}`);
        (row.shadowRoot.querySelector(selector) as HTMLElement).click();
    }, { name, selector });
}

/** What the open device dialog shows, or null when no dialog is open. */
function openDialog(page: Page): Promise<null | { title: string; tiles: string[]; hasChart: boolean }> {
    return page.evaluate(() => {
        const dialog = (window as any).__deepAll(document, "node-detail-dialog")[0] as any;
        const haDialog = dialog?.shadowRoot?.querySelector("ha-dialog") as any;
        if (!haDialog?.open) return null;
        const content = haDialog.querySelector("node-detail-device-content") as any;
        return {
            title: haDialog.heading,
            tiles: Array.from(content?.shadowRoot?.querySelectorAll(".tile") ?? []).map((tile: any) =>
                tile.textContent.replace(/\s+/g, " ").trim()),
            hasChart: !!content?.shadowRoot?.querySelector(".history-graph-stub"),
        };
    });
}

/** The open dialog's Energy tile: its figure's colour class and its hover. */
function energyTile(page: Page): Promise<{ source?: string; title: string | null }> {
    return page.evaluate(() => {
        const content = (window as any).__deepAll(document, "node-detail-device-content")[0];
        const value = content.shadowRoot.querySelector(".tile.energy .device-energy");
        const figure = value?.querySelector(".device-energy-value");
        return {
            source: ["on", "day", "configured"].find((source) => figure?.classList.contains(source)),
            title: value?.getAttribute("title") ?? null,
        };
    });
}

test.describe("device detail from the power card", () => {
    test.beforeEach(async ({ page }) => {
        await mountCard(page);
    });

    test("a metered device's name opens its detail with energy tiles and a chart", async ({ page }) => {
        await clickInRow(page, "Boiler", ".deviceName");

        await expect.poll(() => openDialog(page)).toEqual({
            title: "Boiler",
            tiles: ["Today 1.25 kWh", "Last hour 0.30 kWh"],
            hasChart: true,
        });
        // Its own meter, over today's calendar day and the last rolling hour.
        const stats = await page.evaluate(() => (window as any).__statRequests);
        expect(stats).toEqual(expect.arrayContaining([
            expect.objectContaining({ statistic_id: "sensor.boiler_energy", types: ["change"], calendar: { period: "day" } }),
            expect.objectContaining({ statistic_id: "sensor.boiler_energy", types: ["change"], rolling_window: { duration: { hours: 1 } } }),
        ]));
        expect(await page.evaluate(() => (window as any).__chartConfigs)).toEqual([{
            type: "history-graph",
            hours_to_show: 24,
            entities: ["sensor.boiler_power", "switch.boiler"],
        }]);
    });

    test("a meterless device opens with no energy tiles", async ({ page }) => {
        await clickInRow(page, "Boiler", ".childrenToggle");
        await expect.poll(() => rowNames(page)).toContain("Pump");

        await clickInRow(page, "Pump", ".deviceName");
        await expect.poll(() => openDialog(page)).toEqual({ title: "Pump", tiles: [], hasChart: true });
        expect(await page.evaluate(() => (window as any).__statRequests)).toEqual([]);
    });

    test("the chevron sits before the name and toggles children without opening anything", async ({ page }) => {
        const order = await page.evaluate(() => {
            const row = (window as any).__deepAll(document, "helman-tree-item").find((candidate: any) =>
                candidate.shadowRoot?.querySelector(".deviceName")?.textContent.trim() === "Boiler");
            const chevron = row.shadowRoot.querySelector(".childrenToggle");
            const name = row.shadowRoot.querySelector(".deviceName");
            return {
                chevron: chevron?.textContent.trim(),
                before: !!(chevron.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING),
            };
        });
        expect(order).toEqual({ chevron: "►", before: true });

        expect(await rowNames(page)).not.toContain("Pump");
        await clickInRow(page, "Boiler", ".childrenToggle");
        await expect.poll(() => rowNames(page)).toContain("Pump");
        expect(await openDialog(page)).toBeNull();

        await clickInRow(page, "Boiler", ".childrenToggle");
        await expect.poll(() => rowNames(page)).not.toContain("Pump");
        expect(await openDialog(page)).toBeNull();
    });

    test("the unmeasured row's name opens nothing", async ({ page }) => {
        const unmeasured = await page.evaluate(() =>
            (window as any).__deepAll(document, "helman-tree-item")
                .find((row: any) => row.device?.isUnmeasured)
                ?.shadowRoot.querySelector(".deviceName").textContent.trim());
        expect(unmeasured).toBeTruthy();
        await clickInRow(page, unmeasured, ".deviceName");
        expect(await openDialog(page)).toBeNull();
    });

    test("a virtual group's name still toggles and opens nothing", async ({ page }) => {
        await page.evaluate(() => {
            const chip = (window as any).__deepAll(document, "button.chip")
                .find((button: HTMLElement) => button.textContent?.trim() === "Room");
            chip.click();
        });
        await expect.poll(() => rowNames(page)).toContain("Kitchen (K)");
        expect(await rowNames(page)).not.toContain("Boiler");

        await clickInRow(page, "Kitchen (K)", ".deviceName");
        await expect.poll(() => rowNames(page)).toContain("Boiler");
        expect(await openDialog(page)).toBeNull();
    });

    test("the switch badge and the watts still open more-info", async ({ page }) => {
        await page.evaluate(() => {
            const row = (window as any).__deepAll(document, "helman-tree-item").find((candidate: any) =>
                candidate.shadowRoot?.querySelector(".deviceName")?.textContent.trim() === "Boiler");
            const badge = row.shadowRoot.querySelector("helman-tree-item-icon")
                .shadowRoot.querySelector("helman-appliance-switch-badge");
            (badge.shadowRoot.querySelector("state-badge") as HTMLElement).click();
            const watts = row.shadowRoot.querySelector("helman-tree-item-power-display");
            (watts.shadowRoot.querySelector(".powerDisplay") as HTMLElement).click();
        });
        expect(await page.evaluate(() => (window as any).__moreInfo))
            .toEqual(["switch.boiler", "sensor.boiler_power"]);
        expect(await openDialog(page)).toBeNull();
    });

    test("a device name inside the house detail swaps the dialog to that device", async ({ page }) => {
        // The house icon opens the house detail, which draws the same rows.
        await page.evaluate(() => {
            const house = (window as any).__deepAll(document, "helman-tree-item").find((candidate: any) =>
                candidate.shadowRoot?.querySelector(".deviceName")?.textContent.trim() === "House");
            (house.shadowRoot.querySelector("helman-tree-item-icon").shadowRoot.querySelector(".node-icon") as HTMLElement).click();
        });
        await expect.poll(() => page.evaluate(() =>
            !!(window as any).__deepAll(document, "node-detail-house-content")[0])).toBe(true);
        const historyBefore = await page.evaluate(() => window.history.length);

        const opened = await page.evaluate(() => {
            const house = (window as any).__deepAll(document, "node-detail-house-content")[0];
            const row = (window as any).__deepAll(house.shadowRoot, "helman-tree-item").find((candidate: any) =>
                candidate.shadowRoot?.querySelector(".deviceName")?.textContent.trim() === "Boiler");
            if (!row) return false;
            (row.shadowRoot.querySelector(".deviceName") as HTMLElement).click();
            return true;
        });
        expect(opened).toBe(true);

        await expect.poll(async () => (await openDialog(page))?.title).toBe("Boiler");
        expect(await page.evaluate(() => (window as any).__deepAll(document, "node-detail-dialog").length)).toBe(1);
        expect(await page.evaluate(() => window.history.length)).toBe(historyBefore);
    });
});

/** A metered boiler's record: days, runs, and both power figures. */
const BOILER_STATS = {
    daily_kwh: { mean: 2.4, median: 2.25, min: 0, max: 5.5, days: 29 },
    runs_per_day: 1.5333,
    run_minutes: { median: 42.4, min: 12, max: 180 },
    run_kwh: { median: 1.4, min: 0.35, max: 6 },
    running_kw: 2.1,
    on_kwh_per_hour: 0.8,
};

test.describe("device detail usage statistics", () => {
    test("a metered device shows its learned days under its meter tiles", async ({ page }) => {
        await mountCard(page, { "sensor.boiler_energy": BOILER_STATS });

        await clickInRow(page, "Boiler", ".deviceName");

        await expect.poll(async () => (await openDialog(page))?.tiles).toEqual([
            "Today 1.25 kWh",
            "Last hour 0.30 kWh",
            "Energy 0.80 kWh/h",
            "Typical day 2.25 kWh 0.00–5.50 kWh · mean 2.40 kWh",
            "Runs per day 1.5",
            "Typical run 42 min · 1.40 kWh 12–180 min · 0.35–6.00 kWh",
            "Power while running 2.1 kW",
        ]);
        expect(await page.evaluate(() => (window as any).__deviceStatsRequests))
            .toEqual(["sensor.boiler_energy"]);
        // Learned while on: green, with every measure in its hover.
        expect(await energyTile(page)).toEqual({
            source: "on",
            title: "While on: 0.80 kWh/h\nAverage: 0.10 kWh/h\nPer day: 2.40 kWh\nRunning power: 2.10 kW",
        });
        const title = await page.evaluate(() => {
            const content = (window as any).__deepAll(document, "node-detail-device-content")[0];
            return content.shadowRoot.querySelector(".section-title")?.textContent.trim();
        });
        expect(title).toBe("Last 29 days");
    });

    test("a meterless child shows its statistics on their own", async ({ page }) => {
        await mountCard(page, {
            pump: {
                daily_kwh: { mean: 0.3, median: 0.25, min: 0, max: 1.2, days: 29 },
                runs_per_day: 3,
                run_minutes: { median: 20, min: 5, max: 60 },
                run_kwh: { median: 0.1, min: 0.02, max: 0.3 },
                running_kw: 0.3,
                on_kwh_per_hour: 0.3,
            },
        });
        await clickInRow(page, "Boiler", ".childrenToggle");
        await expect.poll(() => rowNames(page)).toContain("Pump");

        await clickInRow(page, "Pump", ".deviceName");

        await expect.poll(async () => (await openDialog(page))?.tiles).toEqual([
            "Energy 0.30 kWh/h",
            "Typical day 0.25 kWh 0.00–1.20 kWh · mean 0.30 kWh",
            "Runs per day 3.0",
            "Typical run 20 min · 0.10 kWh 5–60 min · 0.02–0.30 kWh",
            "Power while running 300 W",
        ]);
        // Keyed by the device id, the card's deviceKey for a meterless child.
        expect(await page.evaluate(() => (window as any).__deviceStatsRequests)).toEqual(["pump"]);
        expect(await page.evaluate(() => (window as any).__statRequests)).toEqual([]);
    });

    test("a record without runs shows only its typical day, and its mean over the day", async ({ page }) => {
        await mountCard(page, {
            "sensor.boiler_energy": {
                daily_kwh: { mean: 2.4, median: 2.25, min: 0, max: 5.5, days: 29 },
            },
        });

        await clickInRow(page, "Boiler", ".deviceName");

        await expect.poll(async () => (await openDialog(page))?.tiles).toEqual([
            "Today 1.25 kWh",
            "Last hour 0.30 kWh",
            "Energy 0.10 kWh/h",
            "Typical day 2.25 kWh 0.00–5.50 kWh · mean 2.40 kWh",
        ]);
        // No running signal: the daily mean over 24 hours, in orange.
        expect(await energyTile(page)).toEqual({
            source: "day",
            title: "While on: —\nAverage: 0.10 kWh/h\nPer day: 2.40 kWh\nRunning power: —",
        });
    });
});

test.describe("device detail from the solar inspector", () => {
    test("a box in the house breakdown opens the same dialog", async ({ page }) => {
        await loadInspectorBundle(page);
        await installHaStubs(page);
        await mountInspector(page);
        await waitForDayChart(page);
        await selectDaySlots(page, 720, null);
        await expandBreakdownGroups(page);

        await clickInRow(page, "Washer", ".deviceName");

        // Its own meter: both tiles, even with no figure from the recorder.
        await expect.poll(() => openDialog(page)).toEqual({
            title: "Washer",
            tiles: ["Today —", "Last hour —"],
            hasChart: true,
        });
        expect(await page.evaluate(() => (window as any).__chartConfigs)).toEqual([{
            type: "history-graph",
            hours_to_show: 24,
            entities: ["sensor.washer_power", "switch.washer"],
        }]);
        // Asked for by its controllable id, which the backend resolves to its
        // meter; its effective meter is never used, a meterless child's being
        // its parent's.
        expect(await page.evaluate(() => (window as any).__deviceStatsRequests))
            .toEqual(["washer"]);
    });
});
