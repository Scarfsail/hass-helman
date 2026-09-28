import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { consumerGroups, effectiveGroup } from "../cards/shared/config/devices";

/**
 * The Devices tab's grouped view (#364): the consumers listed by one grouping.
 *
 * Every consumer -- children included -- sits flat under its effective group:
 * its own `groups[grouping]`, else its parent's effective group, else
 * "Unassigned". A row's select reassigns it by writing `groups` into the
 * draft; its empty choice ("None", or "Same as parent" for a child) removes
 * the key, and a map left empty with it.
 *
 * The fixture: an AC breaker in "Technická FV" with one climate child that
 * inherits it and one assigned elsewhere, a schedulable boiler in no group,
 * and a lamp grouped only in the other grouping. "Garáž" has no devices.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

const BREAKERS = {
    id: "breakers",
    name: "Jističe",
    groups: [
        { id: "technicka_fv", name: "Technická FV", short_name: "🔋T" },
        { id: "technicka_sit", name: "Technická síť", short_name: "⚡T" },
        { id: "garage", name: "Garáž", short_name: "G" },
    ],
};
const MODES = {
    id: "modes",
    name: "Režimy",
    groups: [{ id: "night_off", name: "Vypnout na noc", short_name: "😴" }],
};

const klima = (id: string, groups?: Record<string, string>) => ({
    id,
    kind: "climate",
    schedulable: true,
    controls: { climate: { entity_id: `climate.${id}` } },
    consumption: { projection: { strategy: "fixed", hourly_energy_kwh: 0.5 } },
    ...(groups ? { groups } : {}),
});

const AC = {
    id: "ac",
    consumption: { energy_entity_id: "sensor.ac_energy" },
    groups: { breakers: "technicka_fv" },
    children: [klima("klima_obyvak"), klima("klima_loznice", { breakers: "technicka_sit" })],
};
const BOILER = {
    id: "boiler",
    name: "Boiler",
    schedulable: true,
    controls: { switch: { entity_id: "switch.boiler" } },
    consumption: {
        energy_entity_id: "sensor.boiler_energy",
        projection: { strategy: "fixed", hourly_energy_kwh: 2 },
    },
};
const LAMP = {
    id: "lamp",
    name: "Lamp",
    consumption: { energy_entity_id: "sensor.lamp_energy" },
    groups: { modes: "night_off" },
};
const INVERTER = { kind: "inverter", id: "inverter", name: "Inverter" };

/** What the backend's name resolution answers, by name path key. */
const PLACEHOLDERS: Record<string, string> = {
    "devices.consumers.0.name": "AC breaker",
    "devices.consumers.0.children.0.name": "Obývák",
    "devices.consumers.0.children.1.name": "Ložnice",
};

type Device = Record<string, any>;

declare global {
    interface Window {
        __editorConfig: () => { devices: { groupings?: any[]; consumers: Device[] } };
    }
}

async function mountEditor(page: Page, groupings: unknown[] = [BREAKERS, MODES]): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));

    await page.evaluate(
        ({ config, placeholders }) => {
            const element = document.createElement(
                "helman-config-editor-panel",
            ) as HTMLElement & Record<string, unknown>;
            window.__editorConfig = () => (element as unknown as { _config: any })._config;
            element.hass = {
                language: "en",
                locale: { language: "en" },
                user: { is_admin: true },
                connection: { subscribeMessage: async () => () => undefined },
                callWS: async (request: any) => {
                    if (request.type === "helman/get_config") {
                        return JSON.parse(JSON.stringify(config));
                    }
                    if (request.type === "helman/get_optimizer_schema") {
                        return { version: 2, kinds: [] };
                    }
                    if (request.type === "helman/get_appliances") return { appliances: [] };
                    if (request.type === "helman/validate_config") {
                        return { valid: true, errors: [], warnings: [] };
                    }
                    if (request.type === "helman/inspect_entities") {
                        return {
                            results: (request.targets ?? []).map((target: any) => ({
                                key: target.key,
                                draft: { entityId: null, status: "ok", facts: [], placeholder: placeholders[target.key] },
                                saved: null,
                            })),
                        };
                    }
                    return {};
                },
            };
            document.body.appendChild(element);
        },
        {
            config: {
                config_version: 26,
                devices: { groupings, system: [INVERTER], consumers: [AC, BOILER, LAMP] },
            },
            placeholders: PLACEHOLDERS,
        },
    );

    const panel = page.locator("helman-config-editor-panel");
    await panel.locator(".tabs").getByRole("button", { name: "Devices", exact: true }).click();
    for (const label of ["Device groupings", "Consumers"]) {
        await panel
            .locator("details.section-card", {
                has: page.locator(":scope > summary .section-summary-label", { hasText: label }),
            })
            .evaluate((details) => ((details as HTMLDetailsElement).open = true));
    }
    // Removing a grouping asks first; the tests answer yes.
    page.on("dialog", (dialog) => void dialog.accept());
}

const viewButtons = (page: Page) => page.locator("helman-config-editor-panel").locator(".device-view button");

const groupedView = (page: Page) => page.locator("helman-config-editor-panel").locator("helman-device-grouping-view");

const row = (page: Page, id: string) => groupedView(page).locator(`.grouping-row[data-device-id="${id}"]`);

/** Each section's title and the ids of its rows, in order. */
const sections = (page: Page) =>
    groupedView(page)
        .locator(".grouping-section")
        .evaluateAll((found) =>
            found.map((section) => ({
                title: section.querySelector(".card-title strong")?.textContent?.trim(),
                devices: Array.from(section.querySelectorAll<HTMLElement>(".grouping-row")).map(
                    (row) => row.dataset.deviceId,
                ),
            })),
        );

/** Every consumer's `groups`, by id, children included. */
const memberships = (page: Page) =>
    page.evaluate(() => {
        const found: Record<string, unknown> = {};
        const walk = (devices: any[]) =>
            devices.forEach((device) => {
                found[device.id] = device.groups;
                walk(device.children ?? []);
            });
        walk(window.__editorConfig().devices.consumers);
        return found;
    });

test("effectiveGroup: own group first, else the parent's, else none", () => {
    expect(effectiveGroup("a", null)).toBe("a");
    expect(effectiveGroup("a", "b")).toBe("a");
    expect(effectiveGroup(undefined, "b")).toBe("b");
    expect(effectiveGroup(undefined, null)).toBeNull();

    const config = {
        devices: {
            system: [{ id: "inverter", kind: "inverter" }],
            consumers: [
                {
                    id: "top",
                    groups: { g: "x" },
                    children: [{ id: "child", children: [{ id: "grandchild" }] }, { id: "other", groups: { g: "y" } }],
                },
                { id: "loose", groups: { h: "z" } },
            ],
        },
    };
    expect(consumerGroups(config, "g").map(({ device, group }) => [device.id, group])).toEqual([
        ["top", "x"],
        ["child", "x"],
        ["grandchild", "x"],
        ["other", "y"],
        ["loose", null],
    ]);
});

test("the view toggle appears only when groupings exist", async ({ page }) => {
    await mountEditor(page, []);
    await expect(page.locator("helman-config-editor-panel").locator(".device-filter")).toHaveCount(1);
    await expect(viewButtons(page)).toHaveCount(0);

    await mountEditor(page);
    await expect(viewButtons(page)).toHaveText(["List", "Jističe", "Režimy"]);
    await expect(viewButtons(page).first()).toHaveClass("active");
    await expect(groupedView(page)).toHaveCount(0);
});

test("every consumer sits under its effective group, children included", async ({ page }) => {
    await mountEditor(page);
    await viewButtons(page).filter({ hasText: "Jističe" }).click();

    await expect(page.locator("helman-config-editor-panel").locator("details.device-card")).toHaveCount(0);
    await expect.poll(() => sections(page)).toEqual([
        { title: "Technická FV (🔋T)", devices: ["ac", "klima_obyvak"] },
        { title: "Technická síť (⚡T)", devices: ["klima_loznice"] },
        { title: "Garáž (G)", devices: [] },
        { title: "Unassigned", devices: ["boiler", "lamp"] },
    ]);

    // Names resolve as the cards resolve them; a child names its parent.
    await expect(row(page, "ac").locator("strong")).toHaveText("AC breaker");
    await expect(row(page, "klima_obyvak").locator("strong")).toHaveText("Obývák");
    await expect(row(page, "klima_obyvak").locator(".card-subtitle")).toHaveText("AC breaker");
    await expect(row(page, "boiler").locator(".card-subtitle")).toHaveCount(0);

    // Only the device's own assignment is selected; the empty choice reads
    // as what it means at that level.
    await expect(row(page, "klima_obyvak").locator("select")).toHaveValue("");
    await expect(row(page, "klima_obyvak").locator("option").first()).toHaveText("Same as parent");
    await expect(row(page, "ac").locator("select")).toHaveValue("technicka_fv");
    await expect(row(page, "ac").locator("option")).toHaveText(["None", "Technická FV", "Technická síť", "Garáž"]);

    await viewButtons(page).filter({ hasText: "Režimy" }).click();
    await expect.poll(() => sections(page)).toEqual([
        { title: "Vypnout na noc (😴)", devices: ["lamp"] },
        { title: "Unassigned", devices: ["ac", "klima_obyvak", "klima_loznice", "boiler"] },
    ]);
});

test("picking a group moves the row and writes groups into the draft", async ({ page }) => {
    await mountEditor(page);
    await viewButtons(page).filter({ hasText: "Jističe" }).click();

    await row(page, "boiler").locator("select").selectOption("garage");
    // The lamp moves up into the boiler's old place; it must not inherit the boiler's pick.
    await expect(row(page, "lamp").locator("select")).toHaveValue("");
    await row(page, "lamp").locator("select").selectOption("technicka_sit");

    await expect.poll(() => sections(page)).toEqual([
        { title: "Technická FV (🔋T)", devices: ["ac", "klima_obyvak"] },
        { title: "Technická síť (⚡T)", devices: ["klima_loznice", "lamp"] },
        { title: "Garáž (G)", devices: ["boiler"] },
        { title: "Unassigned", devices: [] },
    ]);
    // Rows re-rendered in other places still show their own choice.
    await expect(row(page, "klima_loznice").locator("select")).toHaveValue("technicka_sit");
    await expect(row(page, "lamp").locator("select")).toHaveValue("technicka_sit");
    await expect(row(page, "boiler").locator("select")).toHaveValue("garage");
    await expect(row(page, "klima_obyvak").locator("select")).toHaveValue("");
    expect(await memberships(page)).toEqual({
        ac: { breakers: "technicka_fv" },
        klima_obyvak: undefined,
        klima_loznice: { breakers: "technicka_sit" },
        boiler: { breakers: "garage" },
        lamp: { modes: "night_off", breakers: "technicka_sit" },
    });
});

test("None and Same as parent remove the key, and an emptied map", async ({ page }) => {
    await mountEditor(page);
    await viewButtons(page).filter({ hasText: "Jističe" }).click();

    // The child follows its parent again.
    await row(page, "klima_loznice").locator("select").selectOption("");
    await expect.poll(() => sections(page)).toEqual([
        { title: "Technická FV (🔋T)", devices: ["ac", "klima_obyvak", "klima_loznice"] },
        { title: "Technická síť (⚡T)", devices: [] },
        { title: "Garáž (G)", devices: [] },
        { title: "Unassigned", devices: ["boiler", "lamp"] },
    ]);

    // The parent leaves, and its inheriting children with it.
    await row(page, "ac").locator("select").selectOption("");
    await expect.poll(() => sections(page)).toEqual([
        { title: "Technická FV (🔋T)", devices: [] },
        { title: "Technická síť (⚡T)", devices: [] },
        { title: "Garáž (G)", devices: [] },
        { title: "Unassigned", devices: ["ac", "klima_obyvak", "klima_loznice", "boiler", "lamp"] },
    ]);

    await viewButtons(page).filter({ hasText: "Režimy" }).click();
    await row(page, "lamp").locator("select").selectOption("");

    expect(await memberships(page)).toEqual({
        ac: undefined,
        klima_obyvak: undefined,
        klima_loznice: undefined,
        boiler: undefined,
        lamp: undefined,
    });
});

test("the device filter composes with the grouped view", async ({ page }) => {
    await mountEditor(page);
    await viewButtons(page).filter({ hasText: "Jističe" }).click();
    const filter = page.locator("helman-config-editor-panel").locator(".device-filter button");

    // A row stands on its own: a passive parent is not kept for its children.
    await filter.filter({ hasText: "Schedulable" }).click();
    await expect.poll(() => sections(page)).toEqual([
        { title: "Technická FV (🔋T)", devices: ["klima_obyvak"] },
        { title: "Technická síť (⚡T)", devices: ["klima_loznice"] },
        { title: "Garáž (G)", devices: [] },
        { title: "Unassigned", devices: ["boiler"] },
    ]);

    await filter.filter({ hasText: "Passive" }).click();
    await expect.poll(() => sections(page)).toEqual([
        { title: "Technická FV (🔋T)", devices: ["ac"] },
        { title: "Technická síť (⚡T)", devices: [] },
        { title: "Garáž (G)", devices: [] },
        { title: "Unassigned", devices: ["lamp"] },
    ]);
});

test("removing the chosen grouping falls back to the list", async ({ page }) => {
    await mountEditor(page);
    await viewButtons(page).filter({ hasText: "Režimy" }).click();
    await expect(groupedView(page)).toHaveCount(1);

    await page
        .locator("helman-config-editor-panel")
        .locator(".grouping-card")
        .nth(1)
        .locator("button.remove-grouping")
        .click();

    await expect(groupedView(page)).toHaveCount(0);
    await expect(viewButtons(page)).toHaveText(["List", "Jističe"]);
    await expect(viewButtons(page).first()).toHaveClass("active");
    await expect(page.locator("helman-config-editor-panel").locator("details.device-card")).toHaveCount(5);
});
