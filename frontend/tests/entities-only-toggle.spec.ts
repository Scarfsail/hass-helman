import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The entities-only view: every entity group, and nothing else.
 *
 * The Power devices tab spreads its pickers across sections nested four deep,
 * every one of them collapsed by default. This toggle is the answer to "show me
 * the entity configuration and nothing else" -- so its whole promise is that
 * *nothing is missed*. Every assertion below is a way of holding that promise:
 * a group that stays hidden inside a collapsed section, a group whose own
 * settings get swept up with the noise, or a section that survives with no
 * entity in it are all failures of the same claim.
 *
 * The count is asserted exactly rather than as "at least one". A later entity
 * added as a bare field, or a group added and then hidden by one of these
 * rules, would pass every "some groups are visible" test while under-reporting
 * the configuration -- which is worse than no view at all, because it looks
 * like it worked. The expected set is written out as config paths and the count
 * derived from it, so adding an entity to the tab is a deliberate one-line edit
 * here rather than a number nobody can check.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

/** A document with something picked at every Power devices entity path. */
const CONFIG = {
    config_version: 7,
    power_devices: {
        house: {
            entities: { power: "sensor.house_power" },
            forecast: {
                total_energy_entity_id: "sensor.house_energy",
                min_history_days: 30,
                training_window_days: 60,
            },
        },
        solar: {
            entities: {
                power: "sensor.solar_power",
                today_energy: "sensor.solar_today_energy",
                remaining_today_energy_forecast: "sensor.solar_remaining_today",
            },
            forecast: {
                total_energy_entity_id: "sensor.solar_energy",
                daily_energy_entity_ids: ["sensor.solar_day_0", "sensor.solar_day_1"],
                bias_correction: {
                    enabled: true,
                    total_energy_entity_id: "sensor.solar_bias_energy",
                    min_history_days: 14,
                    slot_invalidation: { max_battery_soc_percent: 95 },
                },
            },
        },
        battery: {
            entities: {
                power: "sensor.battery_power",
                remaining_energy: "sensor.battery_remaining_energy",
                capacity: "sensor.battery_capacity",
                min_soc: "sensor.battery_min_soc",
                max_soc: "sensor.battery_max_soc",
            },
            forecast: { charge_efficiency: 0.95 },
        },
        grid: {
            entities: { power: "sensor.grid_power" },
            forecast: { sell_price_entity_id: "sensor.sell_price", import_price_unit: "CZK" },
        },
    },
    controllables: [],
};

const DAILY_ENERGY_ENTITIES =
    CONFIG.power_devices.solar.forecast.daily_energy_entity_ids;

/**
 * Every entity the Power devices tab configures, as the path its group carries.
 *
 * The daily-energy entries are expanded from the fixture rather than written
 * out, because they are a list: the tab renders one group per configured id,
 * so the expected count has to follow the document that is actually mounted.
 */
const POWER_DEVICE_ENTITY_PATHS = [
    "power_devices.house.entities.power",
    "power_devices.house.forecast.total_energy_entity_id",
    "power_devices.solar.entities.power",
    "power_devices.solar.entities.today_energy",
    "power_devices.solar.entities.remaining_today_energy_forecast",
    "power_devices.solar.forecast.total_energy_entity_id",
    ...DAILY_ENERGY_ENTITIES.map(
        (_value, index) => `power_devices.solar.forecast.daily_energy_entity_ids.${index}`,
    ),
    "power_devices.solar.forecast.bias_correction.total_energy_entity_id",
    "power_devices.battery.entities.power",
    "power_devices.battery.entities.remaining_energy",
    "power_devices.battery.entities.capacity",
    "power_devices.battery.entities.min_soc",
    "power_devices.battery.entities.max_soc",
    "power_devices.grid.entities.power",
    "power_devices.grid.forecast.sell_price_entity_id",
].sort();

async function mountEditor(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));

    await page.evaluate((config) => {
        const element = document.createElement(
            "helman-config-editor-panel",
        ) as HTMLElement & Record<string, unknown>;
        element.hass = {
            language: "en",
            locale: { language: "en" },
            user: { is_admin: true },
            connection: { subscribeEvents: async () => () => undefined },
            callWS: async (request: any) => {
                if (request.type === "helman/get_config") {
                    return JSON.parse(JSON.stringify(config));
                }
                if (request.type === "helman/get_optimizer_schema") {
                    return { version: 2, kinds: [] };
                }
                if (request.type === "helman/get_appliances") return { appliances: [] };
                if (request.type === "helman/inspect_entities") {
                    return {
                        results: (request.targets ?? []).map((target: any) => ({
                            key: target.key,
                            draft: {
                                entityId: "sensor.stub",
                                status: "ok",
                                facts: [
                                    {
                                        id: "value",
                                        token: "value",
                                        params: { value: "42", unit: "W" },
                                        severity: "neutral",
                                    },
                                ],
                            },
                            saved: null,
                        })),
                    };
                }
                return {};
            },
        };
        document.body.appendChild(element);

        // The panel renders part of itself through elements with their own
        // shadow root, and `querySelectorAll` stops at the first one.
        (window as any).deepQuery = function deepQuery(root: any, selector: string): Element[] {
            if (!root) return [];
            const found: Element[] = [...root.querySelectorAll(selector)];
            for (const child of root.querySelectorAll("*")) {
                if (child.shadowRoot) found.push(...deepQuery(child.shadowRoot, selector));
            }
            return found;
        };
        // Actually painted, not merely present: everything this view hides is
        // hidden by `display: none` on an ancestor, and a collapsed `details`
        // renders no content at all.
        (window as any).isShown = function isShown(element: Element): boolean {
            return (element as HTMLElement).checkVisibility
                ? (element as any).checkVisibility({
                      checkVisibilityCSS: true,
                      checkOpacity: false,
                  })
                : !!(element as HTMLElement).offsetParent;
        };
    }, CONFIG);

    await expect
        .poll(() =>
            page.evaluate(
                () => !!document.querySelector("helman-config-editor-panel")?.shadowRoot,
            ),
        )
        .toBe(true);
}

async function openPowerDevicesTab(page: Page): Promise<void> {
    await expect
        .poll(() =>
            page.evaluate(() => {
                const root =
                    document.querySelector("helman-config-editor-panel")?.shadowRoot;
                const tab = Array.from(root?.querySelectorAll("button") ?? []).find(
                    (button) => button.textContent?.trim() === "Power devices",
                );
                if (!tab) return false;
                tab.click();
                return true;
            }),
        )
        .toBe(true);
    await page.waitForTimeout(50);
}

/** Flip the toolbar switch, through the control the user actually clicks. */
async function setEntitiesOnly(page: Page, on: boolean): Promise<void> {
    const changed = await page.evaluate((wanted) => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const toggle = root?.querySelector(".entities-only-toggle ha-switch") as
            | (HTMLElement & { checked: boolean })
            | null;
        if (!toggle) return false;
        if (toggle.checked === wanted) return true;
        toggle.checked = wanted;
        toggle.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        return true;
    }, on);
    expect(changed).toBe(true);
    await page.waitForTimeout(80);
}

/** The config path of every entity group currently painted. */
function visibleGroupPaths(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        return (window as any)
            .deepQuery(root, "helman-entity-group")
            .filter((group: any) => (window as any).isShown(group))
            .map((group: any) => (group.path ?? []).join("."))
            .sort();
    });
}

test.describe("entities-only toggle", () => {
    test("shows every Power devices entity group without expanding anything", async ({
        page,
    }) => {
        await mountEditor(page);
        await openPowerDevicesTab(page);

        // Every section on this tab is collapsed by default, so before the
        // toggle there is nothing on screen at all. That is the state the view
        // has to work from -- no manual expansion anywhere in this test.
        expect(await visibleGroupPaths(page)).toEqual([]);

        await setEntitiesOnly(page, true);

        const visible = await visibleGroupPaths(page);
        expect(visible).toEqual(POWER_DEVICE_ENTITY_PATHS);
        // Stated separately from the set comparison because the count is the
        // claim: an entity added later that is not a group, or a group these
        // rules hide, must fail here rather than quietly shrink the audit.
        expect(visible).toHaveLength(POWER_DEVICE_ENTITY_PATHS.length);
    });

    test("hides every field that is not part of a group", async ({ page }) => {
        await mountEditor(page);
        await openPowerDevicesTab(page);
        await setEntitiesOnly(page, true);

        const loose = await page.evaluate(() => {
            const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
            return (window as any)
                .deepQuery(root, ".field")
                .filter((field: Element) => (window as any).isShown(field))
                .filter((field: Element) => !field.closest("helman-entity-group"))
                .map(
                    (field: Element) =>
                        field.querySelector("label")?.textContent?.trim() ?? "(unlabelled)",
                );
        });
        expect(loose).toEqual([]);
    });

    test("keeps the settings that qualify an entity inside its group", async ({ page }) => {
        await mountEditor(page);
        await openPowerDevicesTab(page);
        await setEntitiesOnly(page, true);

        // A group's slotted settings are children of `helman-entity-group` in
        // the panel's own tree, not in the group's shadow root -- so the rule
        // that hides loose fields reaches them unless it is guarded. A polarity
        // hidden from the view that exists to audit polarities is the failure
        // this asserts against.
        const slotted = await page.evaluate(() => {
            const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
            return (window as any)
                .deepQuery(root, "helman-entity-group .field")
                .filter((field: Element) => (window as any).isShown(field))
                .map(
                    (field: Element) =>
                        field.querySelector("label")?.textContent?.trim() ?? "(unlabelled)",
                );
        });
        // Four polarity selects, and the day counts on the house forecast and
        // the bias-correction meter.
        expect(slotted.filter((label: string) => label === "Sign convention")).toHaveLength(4);
        expect(slotted).toContain("Min history days");
    });

    test("drops the sections that hold no entity", async ({ page }) => {
        await mountEditor(page);
        await openPowerDevicesTab(page);
        await setEntitiesOnly(page, true);

        const sections = await page.evaluate(() => {
            const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
            return (window as any)
                .deepQuery(root, "details.section-card")
                .filter((section: Element) => (window as any).isShown(section))
                .map(
                    (section: Element) =>
                        section
                            .querySelector(".section-summary-label")
                            ?.textContent?.trim() ?? "",
                );
        });
        // Slot invalidation configures six thresholds and no entity at all.
        expect(sections).not.toContain("Invalidate training slot data");
        // The sections that do hold one are still there, including the two
        // that only hold one further down: `:has()` has to look all the way
        // through the nesting, not one level.
        expect(sections).toEqual(
            expect.arrayContaining(["House", "Solar", "Forecast", "Configuration", "Battery", "Grid"]),
        );
    });

    test("restores the sections' open state when it is switched off", async ({ page }) => {
        await mountEditor(page);
        await openPowerDevicesTab(page);

        // One section deliberately opened by hand first, so "restore" means
        // something other than "close everything again".
        await page.evaluate(() => {
            const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
            const battery = Array.from(
                root?.querySelectorAll("details.section-card") ?? [],
            ).find(
                (section) =>
                    section.querySelector(".section-summary-label")?.textContent?.trim() ===
                    "Battery",
            ) as HTMLDetailsElement | undefined;
            if (battery) battery.open = true;
        });
        await page.waitForTimeout(50);

        const readOpenState = () =>
            page.evaluate(() => {
                const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
                return Array.from(
                    root?.querySelectorAll("details.section-card") ?? [],
                ).map((section) => [
                    section.querySelector(".section-summary-label")?.textContent?.trim() ?? "",
                    (section as HTMLDetailsElement).open,
                ]) as [string, boolean][];
            });

        const before = await readOpenState();
        expect(before).toContainEqual(["Battery", true]);
        expect(before).toContainEqual(["House", false]);

        await setEntitiesOnly(page, true);
        const during = await readOpenState();
        expect(during.every(([, open]) => open)).toBe(true);

        await setEntitiesOnly(page, false);
        expect(await readOpenState()).toEqual(before);
    });
});
