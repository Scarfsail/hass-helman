import { test, expect, type Page } from "@playwright/test";
import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { loadBundle } from "./support/card-page";
import { installFixedClock } from "./support/fixed-clock";

/** Full-card mount with the Custom inverter overview contract used by the simple-card specs. */
async function mount(page: Page, width = 800, language = "en", housePower = "1200"): Promise<void> {
    await installFixedClock(page);
    await loadBundle(page, "helman-card");
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.evaluate(async ({ width, language, housePower }) => {
        const node = (id: string, sensor: string, sourceType: string | null) => ({
            id, displayName: id, powerSensorId: sensor, ratioSensorId: null, switchEntityId: null,
            valueType: "default", sourceConfig: null, sourceType, isSource: sourceType !== null,
            isUnmeasured: false, groups: {}, groupBadgeTexts: [], icon: null, compact: false,
            showAdditionalInfo: false, childrenFullWidth: false, hideChildren: false,
            hideChildrenIndicator: false, sortChildrenByPower: false, deferrable: false,
            controllableIds: [], children: [],
        });
        const tree = {
            sources: [node("solar", "sensor.solar", "solar"), node("grid", "sensor.grid", "grid"), node("battery", "sensor.battery", "battery")],
            consumers: [node("house", "sensor.house", null)],
            consumptionTotalSensorId: "sensor.house", productionTotalSensorId: null,
            uiConfig: { show_others_group: false, device_groupings: [], history_buckets: 3, history_bucket_duration: 60 },
        };
        const overview = {
            node: "inverter", asOf: "2026-10-21T12:00:00+00:00", configured: true,
            profile: null,
            mode: { entityId: "select.helman_inverter_mode", actionOptions: { normal: "normal" } },
            entities: { battery_min_soc: "number.min_soc", battery_max_soc: "number.max_soc" },
            maxAllowedExportPower: 9900,
            agreement: { status: "unknown", reason: "no_profile", commanded: "normal", observedOption: null, observedFrom: [], registers: [] },
            condition: null, sections: [],
        };
        const s = (state: string, unit?: string) => ({ state, attributes: unit ? { unit_of_measurement: unit } : {} });
        (window as any).__inverterRequests = [];
        (window as any).__inverterMoreInfo = [];
        document.addEventListener("hass-more-info", (event: Event) => {
            (window as any).__inverterMoreInfo.push((event as CustomEvent).detail);
        });
        const hass = {
            language, locale: { language: "en-GB" }, config: { time_zone: "UTC" },
            connection: { sendMessagePromise: async () => ({}), subscribeMessage: async () => () => undefined },
            states: {
                "sensor.solar": s("4200", "W"), "sensor.grid": s("-300", "W"),
                "sensor.battery": s("-500", "W"), "sensor.house": s(housePower, "W"),
                "number.min_soc": s("10", "%"), "number.max_soc": s("100", "%"),
                "select.helman_inverter_mode": s("normal"),
            },
            callWS: async (msg: any) => {
                (window as any).__inverterRequests.push(msg);
                if (msg.type === "helman/get_device_tree") return tree;
                if (msg.type === "helman/get_history") return { buckets: 3, bucket_duration: 60, entity_history: {} };
                if (msg.type === "helman/get_schedule") return { executionEnabled: true, slots: [] };
                if (msg.type === "helman/get_node_detail" && msg.node === "inverter") return overview;
                return {};
            },
        };
        const card = document.createElement("helman-card") as any;
        card.style.display = "block";
        card.style.width = `${width}px`;
        await card.setConfig({ type: "custom:helman-card" });
        card.hass = hass;
        document.body.appendChild(card);
    }, { width, language, housePower });
    await expect(page.locator("helman-card button.inverterButton")).toBeVisible();
}

const button = (page: Page) => page.locator("helman-card button.inverterButton");
const content = (page: Page) => page.locator("node-detail-inverter-content");

for (const width of [800, 320, 280, 240]) {
    test(`distribution inverter is centered and unobstructed at ${width}px`, async ({ page }) => {
        await mount(page, width, "en", width < 320 ? "123456" : "1200");
        await expect(button(page)).toHaveCount(1);
        await expect(button(page)).toHaveAccessibleName("Inverter");
        await expect(button(page)).toHaveAttribute("title", "Inverter");
        const layout = await button(page).evaluate((element) => {
            const root = element.getRootNode() as ShadowRoot;
            const row = root.host as any;
            const box = (selector: string) => root.querySelector(selector)!.getBoundingClientRect();
            const b = element.getBoundingClientRect();
            const rowBox = box(".deviceContent");
            const name = box(".deviceName");
            const power = root.querySelector("helman-tree-item-power-display")!.shadowRoot!.querySelector(".powerDisplay")!.getBoundingClientRect();
            const clear = (rect: DOMRect) => rect.right <= b.left || rect.left >= b.right || rect.bottom <= b.top || rect.top >= b.bottom;
            return {
                id: row.device.id, sourceType: row.device.sourceType ?? null,
                centerOffset: Math.abs(b.x + b.width / 2 - rowBox.x - rowBox.width / 2),
                labelClear: clear(name), powerClear: clear(power),
                labelPowerClear: name.right <= power.left,
                bars: !!root.querySelector("helman-power-history-bars"),
                title: root.querySelector(".deviceName")!.textContent!.trim(),
                power: root.querySelector("helman-tree-item-power-display")!.shadowRoot!.querySelector(".powerValue")!.textContent!.trim(),
                hit: root.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest("button") === element,
            };
        });
        expect(layout).toMatchObject({ id: "consumers", sourceType: null, labelClear: true, powerClear: true, labelPowerClear: true, bars: true, title: "Energy Consumers", power: width < 320 ? "123.5 kW" : "1.2 kW", hit: true });
        expect(layout.centerOffset).toBeLessThan(1);
        const houseLayout = await page.locator("helman-tree-item").evaluateAll((rows) => {
            const house = rows.find((row: any) => row.device.id === "house")!;
            const name = house.shadowRoot!.querySelector(".deviceName")!.getBoundingClientRect();
            const power = house.shadowRoot!.querySelector("helman-tree-item-power-display")!.getBoundingClientRect();
            return { labelVisible: name.width > 0, clear: name.right <= power.left };
        });
        expect(houseLayout).toEqual({ labelVisible: true, clear: true });
        await expect(page.locator("power-flow-arrows")).toHaveCount(3);
        expect(await page.evaluate(() => (window as any).__inverterRequests.filter((r: any) => r.type === "helman/get_node_detail"))).toEqual([]);
    });
}

for (const activation of ["mouse", "Enter", "Space"]) {
    test(`${activation} opens shared inverter detail and supports close/reopen`, async ({ page }) => {
        await mount(page);
        if (activation === "mouse") await button(page).click();
        else {
            await button(page).focus();
            await expect(button(page)).toBeFocused();
            expect(await button(page).evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
            await button(page).press(activation);
        }
        await expect(content(page)).toBeVisible();
        await expect(content(page).locator(".status")).toHaveText("Helman last commanded: Normal.");
        await expect(content(page).locator("helman-node-flow")).toBeVisible();
        await page.locator("node-detail-dialog ha-dialog").evaluate((dialog: any) => dialog.close());
        await expect(content(page)).toHaveCount(0);
        await button(page).click();
        await expect(content(page)).toBeVisible();
        expect(await page.evaluate(() => (window as any).__inverterMoreInfo)).toEqual([]);
        expect(await page.evaluate(() => (window as any).__inverterRequests.filter((r: any) => r.type === "helman/get_node_detail").map((r: any) => r.node))).toEqual(["inverter", "inverter"]);
    });
}

test("the inverter button label and tooltip use the card language", async ({ page }) => {
    await mount(page, 800, "cs");
    await expect(button(page)).toHaveAccessibleName("Střídač");
    await expect(button(page)).toHaveAttribute("title", "Střídač");
});
