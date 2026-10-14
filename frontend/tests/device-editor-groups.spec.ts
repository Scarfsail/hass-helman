import { configDoc } from "./support/payload-builders";
import { test, expect, type Page } from "@playwright/test";
import { EDITOR_BUNDLE, loadBundle } from "./support/card-page";

/**
 * A device's groups and house phase in its own editor (#376, #424).
 *
 * Every consumer card has a "Groups and phase" section, collapsed, whose
 * summary shows a badge per assigned phase and group, and whose body holds the
 * phase picker and one picker per grouping: "None", then the grouping's
 * groups. Picking writes the device's own `groups.<grouping>`, "None" removes
 * the key and a `groups` map left empty. A config without groupings has no
 * group to pick, so the section holds the phase picker alone. A device whose
 * phase is not its own to choose -- a child under a single-phase or
 * unassigned device (#464) -- gets no picker but a read-only line naming the
 * phase it inherits and the device it comes from.
 *
 * The fixture: an AC breaker in "Technická FV" with an ungrouped climate
 * child holding a stale phase, a boiler in a group of each grouping, and a
 * lamp naming a group the grouping does not have.
 */

const BREAKERS = {
    id: "breakers",
    name: "Jističe",
    groups: [
        { id: "technicka_fv", name: "Technická FV", short_name: "🔋T" },
        { id: "technicka_sit", name: "Technická síť", short_name: "⚡T" },
    ],
};
const MODES = {
    id: "modes",
    name: "Režimy",
    groups: [{ id: "night_off", name: "Vypnout na noc", short_name: "😴" }],
};

const AC = {
    id: "ac",
    name: "AC breaker",
    consumption: { energy_entity_id: "sensor.ac_energy" },
    groups: { breakers: "technicka_fv" },
    children: [
        {
            id: "klima",
            name: "Klima",
            kind: "climate",
            schedulable: true,
            controls: { climate: { entity_id: "climate.klima" } },
            consumption: { projection: { strategy: "fixed", hourly_energy_kwh: 0.5 } },
            phase: "L3",
        },
    ],
};
const BOILER = {
    id: "boiler",
    name: "Boiler",
    consumption: { energy_entity_id: "sensor.boiler_energy" },
    groups: { breakers: "technicka_sit", modes: "night_off" },
};
const LAMP = {
    id: "lamp",
    name: "Lamp",
    consumption: { energy_entity_id: "sensor.lamp_energy" },
    groups: { breakers: "gone" },
};

type Device = Record<string, any>;

declare global {
    interface Window {
        __groupsEditorConfig: () => { devices: { consumers: Device[] } };
    }
}

async function mountEditor(page: Page, groupings: Array<typeof BREAKERS> = [BREAKERS, MODES]): Promise<void> {
    await loadBundle(page, "helman-config-editor-panel", EDITOR_BUNDLE);

    await page.evaluate(
        ({ config }) => {
            const element = document.createElement(
                "helman-config-editor-panel",
            ) as HTMLElement & Record<string, unknown>;
            window.__groupsEditorConfig = () => (element as unknown as { _config: any })._config;
            element.hass = {
                language: "en",
                locale: { language: "en" },
                user: { is_admin: true },
                connection: window.__mockHass().connection,
                callWS: window.__mockHass({
                    "helman/get_config": async (request: any) => {
                        return JSON.parse(JSON.stringify(config));
                    },
                    "helman/validate_config": async (request: any) => {
                        return { valid: true, errors: [], warnings: [] };
                    },
                    "helman/inspect_entities": async (request: any) => {
                        return {
                            results: (request.targets ?? []).map((target: any) => ({
                                key: target.key,
                                draft: { entityId: null, status: "ok", facts: [] },
                                saved: null,
                            })),
                        };
                    }
                }).callWS,
            };
            document.body.appendChild(element);
        },
        {
            config: JSON.parse(JSON.stringify(configDoc({

                devices: {
                    ...(groupings.length ? { groupings } : {}),
                    consumers: [AC, BOILER, LAMP],
                },
            }))),
        },
    );

    const panel = page.locator("helman-config-editor-panel");
    await panel.locator(".tabs").getByRole("button", { name: "Devices", exact: true }).click();
    for (const label of ["Consumers"]) {
        await panel
            .locator("details.section-card", {
                has: page.locator(":scope > summary .section-summary-label", { hasText: label }),
            })
            .evaluate((details) => ((details as HTMLDetailsElement).open = true));
    }
    await expect(panel.locator("details.device-card")).toHaveCount(4);
}

/** The device card's own Groups and phase section, not a nested child card's. */
const groupsSection = (page: Page, id: string) =>
    page
        .locator("helman-config-editor-panel")
        .locator(`details.device-card[data-device-id="${id}"] > .appliance-body > details.section-card`, {
            has: page.locator(":scope > summary .section-summary-label", { hasText: /^Groups and phase$/ }),
        });

const picker = (page: Page, id: string, groupingId: string) =>
    groupsSection(page, id).locator(`select.device-group[data-grouping-id="${groupingId}"]`);

/** The badges in a Groups and phase section's summary. */
const badges = (page: Page, id: string) =>
    groupsSection(page, id).locator(":scope > summary .device-badge").allTextContents();

/** Pick a value, as a user would; the section may stay collapsed. */
async function pick(page: Page, id: string, groupingId: string, value: string): Promise<void> {
    await picker(page, id, groupingId).evaluate((select, next) => {
        (select as HTMLSelectElement).value = next;
        select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }, value);
}

/** Every consumer's `groups`, by id, children included. */
const memberships = (page: Page) =>
    page.evaluate(() => {
        const found: Record<string, unknown> = {};
        const walk = (devices: any[]) =>
            devices.forEach((device) => {
                found[device.id] = device.groups;
                walk(device.children ?? []);
            });
        walk(window.__groupsEditorConfig().devices.consumers);
        return found;
    });

const INITIAL = {
    ac: AC.groups,
    klima: undefined,
    boiler: BOILER.groups,
    lamp: LAMP.groups,
};

test("the Groups and phase section is collapsed and its badges name the assigned groups", async ({ page }) => {
    await mountEditor(page);

    await expect(groupsSection(page, "boiler")).toHaveCount(1);
    await expect(groupsSection(page, "boiler")).not.toHaveAttribute("open", "");
    expect((await badges(page, "boiler")).map((text) => text.trim())).toEqual(["Technická síť", "Vypnout na noc"]);
    expect((await badges(page, "ac")).map((text) => text.trim())).toEqual(["Technická FV"]);
    // An ungrouped child shows the section, with no badge: its stale phase is none either.
    await expect(groupsSection(page, "klima")).toHaveCount(1);
    await expect(groupsSection(page, "klima").locator(":scope > summary .section-summary-badge")).toHaveCount(0);

    // The phase picker, then one per grouping, labelled with its name: "None", then its groups.
    await expect(groupsSection(page, "boiler").locator(".field > label")).toHaveText(["House phase", "Jističe", "Režimy"]);
    await expect(picker(page, "boiler", "breakers").locator("option")).toHaveText([
        "None",
        "Technická FV",
        "Technická síť",
    ]);
    await expect(picker(page, "boiler", "breakers")).toHaveValue("technicka_sit");
    await expect(picker(page, "klima", "breakers")).toHaveValue("");
});

test("picking adds, changes and removes the device's own group", async ({ page }) => {
    await mountEditor(page);

    await pick(page, "klima", "breakers", "technicka_sit");
    await expect.poll(() => memberships(page)).toEqual({ ...INITIAL, klima: { breakers: "technicka_sit" } });
    expect((await badges(page, "klima")).map((text) => text.trim())).toEqual(["Technická síť"]);

    await pick(page, "klima", "breakers", "technicka_fv");
    await expect.poll(() => memberships(page)).toEqual({ ...INITIAL, klima: { breakers: "technicka_fv" } });

    // "None" removes the key, and the `groups` map once it is empty.
    await pick(page, "klima", "breakers", "");
    await expect.poll(() => memberships(page)).toEqual(INITIAL);
    await expect.poll(() => page.evaluate(() => "groups" in window.__groupsEditorConfig().devices.consumers[0].children[0]))
        .toBe(false);

    // A device in two groupings keeps the other one.
    await pick(page, "boiler", "modes", "");
    await expect.poll(() => memberships(page)).toEqual({ ...INITIAL, boiler: { breakers: "technicka_sit" } });
});

test("a config without groupings shows the phase picker alone", async ({ page }) => {
    await mountEditor(page);
    const panel = page.locator("helman-config-editor-panel");
    await expect(panel.locator("select.device-group")).toHaveCount(8);

    await mountEditor(page, []);
    await expect(page.locator("helman-config-editor-panel").locator("details.device-card")).toHaveCount(4);
    await expect(page.locator("helman-config-editor-panel").locator("select.device-group")).toHaveCount(0);
    await expect(groupsSection(page, "boiler").locator(".field > label")).toHaveText(["House phase"]);
});

/** Pick a phase in a device's own phase picker. */
async function choosePhase(page: Page, id: string, value: string): Promise<void> {
    await groupsSection(page, id)
        .locator("select.device-phase")
        .evaluate((select, next) => {
            (select as HTMLSelectElement).value = next;
            select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        }, value);
}

test("the phase picker sets, badges and clears the device's own phase", async ({ page }) => {
    await mountEditor(page);
    const phase = groupsSection(page, "ac").locator("select.device-phase");
    await expect(phase.locator("option")).toHaveText(["Unassigned", "L1", "L2", "L3", "Three-phase"]);
    await expect(phase).toHaveValue("");

    const stored = () => page.evaluate(() => window.__groupsEditorConfig().devices.consumers[0].phase);

    await choosePhase(page, "ac", "L2");
    await expect.poll(stored).toBe("L2");
    expect((await badges(page, "ac")).map((text) => text.trim())).toEqual(["L2", "Technická FV"]);

    await choosePhase(page, "ac", "");
    await expect.poll(() => page.evaluate(() => "phase" in window.__groupsEditorConfig().devices.consumers[0])).toBe(false);
    // Groups are untouched.
    await expect.poll(() => memberships(page)).toEqual(INITIAL);
});

test("a child under a single-phase or unassigned device shows its inherited phase, not a picker", async ({
    page,
}) => {
    await mountEditor(page);
    const klima = groupsSection(page, "klima");
    const inherited = klima.locator("input.device-phase-inherited");

    await expect(klima.locator("select.device-phase")).toHaveCount(0);
    await expect(klima.locator(".field > label").first()).toHaveText("House phase");
    await expect(inherited).toHaveValue("Inherited from AC breaker: Unassigned");

    await choosePhase(page, "ac", "L1");
    await expect(inherited).toHaveValue("Inherited from AC breaker: L1");
    await expect(klima.locator("select.device-phase")).toHaveCount(0);

    // Under a three-phase device the child picks its own, its stored phase intact.
    await choosePhase(page, "ac", "3ph");
    await expect(inherited).toHaveCount(0);
    await expect(klima.locator("select.device-phase")).toHaveValue("L3");
    expect((await badges(page, "klima")).map((text) => text.trim())).toEqual(["L3"]);
});

test("a group id the grouping does not have shows as selected", async ({ page }) => {
    await mountEditor(page);

    await expect(picker(page, "lamp", "breakers")).toHaveValue("gone");
    await expect(picker(page, "lamp", "breakers").locator("option")).toHaveText([
        "None",
        "Technická FV",
        "Technická síť",
        "gone",
    ]);
    expect((await badges(page, "lamp")).map((text) => text.trim())).toEqual(["gone"]);
});
