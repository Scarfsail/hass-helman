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
            },
        },
        solar: {
            entities: {
                power: "sensor.solar_power",
                today_energy: "sensor.solar_today_energy",
            },
            forecast: {
                total_energy_entity_id: "sensor.solar_energy",
                daily_energy_entity_ids: ["sensor.solar_day_0", "sensor.solar_day_1"],
                bias_correction: {
                    enabled: true,
                    total_energy_entity_id: "sensor.solar_bias_energy",
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
    controllables: [
        {
            kind: "inverter",
            id: "inverter",
            name: "Inverter",
            controls: { mode: { entity_id: "select.inverter_mode", options: {} } },
        },
        {
            kind: "generic",
            id: "boiler",
            name: "Boiler",
            controls: { switch: { entity_id: "switch.boiler" } },
            consumption: {
                energy_entity_id: "sensor.boiler_energy_total",
                projection: { strategy: "fixed", hourly_energy_kwh: 2 },
            },
        },
    ],
};

/** The same, for the tab whose entity groups live inside appliance cards. */
const CONTROLLABLE_ENTITY_PATHS = [
    "controllables.0.controls.mode.entity_id",
    "controllables.1.controls.switch.entity_id",
    "controllables.1.consumption.energy_entity_id",
].sort();

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
        // The editor will not enter YAML mode until `ha-yaml-editor` is
        // defined -- in the real panel it walks HA's developer-tools chunk to
        // get it, which does not exist here. Defining a stub short-circuits
        // that walk, which is all the two YAML-mode tests below need: they
        // assert on what the *editor* does around a scope in YAML mode, never
        // on the code editor itself.
        if (!customElements.get("ha-yaml-editor")) {
            customElements.define("ha-yaml-editor", class extends HTMLElement {});
        }
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

async function openTab(page: Page, label: string): Promise<void> {
    await expect
        .poll(() =>
            page.evaluate((tabLabel) => {
                const root =
                    document.querySelector("helman-config-editor-panel")?.shadowRoot;
                const tab = Array.from(root?.querySelectorAll("button") ?? []).find(
                    (button) => button.textContent?.trim() === tabLabel,
                );
                if (!tab) return false;
                tab.click();
                return true;
            }, label),
        )
        .toBe(true);
    await page.waitForTimeout(80);
}

const openPowerDevicesTab = (page: Page) => openTab(page, "Power devices");

/**
 * Switch a scope between Visual and YAML through the button the user clicks.
 *
 * `container` picks which mode toggle: the tab's own lives in the toolbar
 * outside the tab body, a section's lives in its summary.
 */
async function setScopeMode(
    page: Page,
    container: string,
    mode: "Visual" | "YAML",
): Promise<void> {
    const clicked = await page.evaluate(
        ({ selector, label }) => {
            const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
            const host = root?.querySelector(selector);
            const button = Array.from(
                host?.querySelectorAll(".mode-toggle button") ?? [],
            ).find((candidate) => candidate.textContent?.trim() === label) as
                | HTMLButtonElement
                | undefined;
            if (!button) return false;
            button.click();
            return true;
        },
        { selector: container, label: mode },
    );
    expect(clicked).toBe(true);
    await page.waitForTimeout(120);
}

/** The open/closed state of every appliance card on the current tab. */
function readCardOpenState(page: Page): Promise<[string, boolean][]> {
    return page.evaluate(
        () =>
            Array.from(
                document
                    .querySelector("helman-config-editor-panel")
                    ?.shadowRoot?.querySelectorAll("details.list-card") ?? [],
            ).map((card) => [
                card.querySelector(".card-title strong")?.textContent?.trim() ?? "",
                (card as HTMLDetailsElement).open,
            ]) as [string, boolean][],
    );
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

/** The empty-state message, if the view is showing one. */
function emptyNotice(page: Page): Promise<string | null> {
    return page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const notice = root?.querySelector(".entities-only-empty");
        return notice && (window as any).isShown(notice)
            ? notice.textContent?.trim() ?? ""
            : null;
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
        // Four polarity selects. The house forecast's and the bias-correction
        // meter's day counts used to be slotted here too, but the v14
        // relocation moved them to the Training tab -- see entity-group.spec.ts
        // for the coverage that took over.
        expect(slotted.filter((label: string) => label === "Sign convention")).toHaveLength(4);
        expect(slotted).not.toContain("Min history days");
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

    test("leaves the appliance cards on another tab as it found them", async ({
        page,
    }) => {
        await mountEditor(page);
        await openTab(page, "Controllables");
        // Appliance cards are `details.list-card`, and unlike a section card
        // they carry no `open` binding at all -- nothing in a render would ever
        // put one back, so forcing them open has to be paired with a record of
        // what they were.
        const before = await readCardOpenState(page);
        expect(before.length).toBeGreaterThan(0);
        expect(before.every(([, open]) => !open)).toBe(true);

        // The toggle goes on somewhere else, so this tab is not the one that
        // was on screen when the snapshot would have been taken.
        await openTab(page, "General");
        await setEntitiesOnly(page, true);
        await openTab(page, "Controllables");
        expect((await readCardOpenState(page)).every(([, open]) => open)).toBe(true);

        await setEntitiesOnly(page, false);
        expect(await readCardOpenState(page)).toEqual(before);
    });

    test("shows the entities of a tab rendered after it was switched on", async ({
        page,
    }) => {
        await mountEditor(page);
        await openTab(page, "Controllables");
        // In YAML mode the tab renders a code editor and no tab body at all,
        // so there is nothing on screen for the toggle to have opened.
        await setScopeMode(page, ".scope-toolbar", "YAML");
        await setEntitiesOnly(page, true);
        expect(await visibleGroupPaths(page)).toEqual([]);

        // Coming back to Visual renders a whole fresh tab body. Every card in
        // it arrives collapsed, and a collapsed `details` renders no content --
        // so `:has()` finds no group inside one and the view would hide the
        // lot, coming up empty exactly where it promises completeness.
        await setScopeMode(page, ".scope-toolbar", "Visual");
        expect(await visibleGroupPaths(page)).toEqual(CONTROLLABLE_ENTITY_PATHS);
    });

    test("keeps a section left in YAML mode, and its way back", async ({ page }) => {
        await mountEditor(page);
        await openPowerDevicesTab(page);

        // Put the Battery section in YAML mode *before* turning the view on,
        // which is the order a real user arrives in: the mode is remembered,
        // the audit happens later.
        await page.evaluate(() => {
            const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
            const battery = Array.from(
                root?.querySelectorAll("details.section-card") ?? [],
            ).find(
                (section) =>
                    section.querySelector(".section-summary-label")?.textContent?.trim() ===
                    "Battery",
            ) as HTMLDetailsElement | undefined;
            if (battery) battery.setAttribute("data-test-battery", "");
        });
        await setScopeMode(page, "details.section-card[data-test-battery]", "YAML");
        await setEntitiesOnly(page, true);

        // A code editor holds no group, so every hiding rule here would sweep
        // the section away -- and the rule that hides section mode toggles
        // would remove the only control that could bring it back. The user
        // would be shown a tab with the battery silently missing from it.
        const yamlSection = await page.evaluate(() => {
            const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
            const battery = root?.querySelector(
                "details.section-card[data-test-battery]",
            ) as HTMLElement | null;
            return {
                sectionShown: !!battery && (window as any).isShown(battery),
                editorShown: !!battery?.querySelector(".yaml-field")
                    ? (window as any).isShown(battery.querySelector(".yaml-field"))
                    : false,
                toggleShown: !!battery?.querySelector("summary .mode-toggle")
                    ? (window as any).isShown(battery.querySelector("summary .mode-toggle"))
                    : false,
            };
        });
        expect(yamlSection).toEqual({
            sectionShown: true,
            editorShown: true,
            toggleShown: true,
        });

        // And the way back actually works from inside the view.
        await setScopeMode(page, "details.section-card[data-test-battery]", "Visual");
        expect(await visibleGroupPaths(page)).toEqual(POWER_DEVICE_ENTITY_PATHS);
    });

    test("says so on a tab that configures no entities", async ({ page }) => {
        await mountEditor(page);
        // The Automation tab configures thresholds and an optimizer pipeline
        // and not one entity, so with the view on every section on it is
        // hidden. An empty panel is indistinguishable from a broken one.
        await openTab(page, "Automation");
        expect(await emptyNotice(page)).toBe(null);

        await setEntitiesOnly(page, true);
        expect(await visibleGroupPaths(page)).toEqual([]);
        expect(await emptyNotice(page)).toBe("This tab configures no entities.");

        // And never where there is something to show. This is the assertion
        // that would catch a message keyed off "no readings have arrived yet"
        // rather than off "this tab has no entities".
        await openTab(page, "Power devices");
        expect(await emptyNotice(page)).toBe(null);
        expect(await visibleGroupPaths(page)).toEqual(POWER_DEVICE_ENTITY_PATHS);

        await setEntitiesOnly(page, false);
        await openTab(page, "Automation");
        expect(await emptyNotice(page)).toBe(null);
    });

    test("stays quiet about a scope left in YAML mode", async ({ page }) => {
        await mountEditor(page);
        await openTab(page, "Automation");

        // A *section* in YAML mode is the case that matters: the tab body is
        // still there and still holds no group, so the message would fire --
        // in front of a code editor whose document may well name entities.
        // Saying "this tab configures no entities" there would be a lie.
        await page.evaluate(() => {
            const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
            const first = root?.querySelector("details.section-card");
            first?.setAttribute("data-test-scope", "");
        });
        await setScopeMode(page, "details.section-card[data-test-scope]", "YAML");
        await setEntitiesOnly(page, true);
        expect(await visibleGroupPaths(page)).toEqual([]);
        expect(await emptyNotice(page)).toBe(null);

        // The whole tab in YAML mode renders no tab body at all, so there is
        // nowhere for the message to be either.
        await setScopeMode(page, ".scope-toolbar", "YAML");
        expect(await emptyNotice(page)).toBe(null);
    });
});
