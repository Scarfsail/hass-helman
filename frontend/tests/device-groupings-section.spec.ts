import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The Devices tab's groupings section (#363): `devices.groupings` edited in place.
 *
 * A grouping is a card named by its title input, its groups one row each. Ids
 * are slugged from the name when the entry is added and never edited, because
 * a device names its group by id: a rename touches the name only. What would
 * silently break a saved config if it regressed is removal -- a device still
 * naming a removed group fails validation -- so a removal strips every device
 * reference to it in the same mutation.
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
    ],
};
const MODES = {
    id: "modes",
    name: "Režimy",
    groups: [{ id: "night_off", name: "Vypnout na noc", short_name: "😴" }],
};

const BOILER = {
    id: "boiler",
    consumption: { energy_entity_id: "sensor.boiler_energy" },
    groups: { breakers: "technicka_fv", modes: "night_off" },
    children: [
        {
            id: "pump",
            consumption: { energy_entity_id: "sensor.pump_energy" },
            groups: { breakers: "technicka_sit" },
        },
    ],
};
const WASHER = {
    id: "washer",
    consumption: { energy_entity_id: "sensor.washer_energy" },
    groups: { breakers: "technicka_fv" },
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
        ({ config }) => {
            const element = document.createElement(
                "helman-config-editor-panel",
            ) as HTMLElement & Record<string, unknown>;
            window.__editorConfig = () => (element as unknown as { _config: any })._config;
            element.hass = {
                language: "en",
                locale: { language: "en" },
                user: { is_admin: true },
                connection: { subscribeMessage: async () => () => undefined },
                callWS: async (request: { type: string }) => {
                    if (request.type === "helman/get_config") {
                        return JSON.parse(JSON.stringify(config));
                    }
                    if (request.type === "helman/get_optimizer_schema") {
                        return { version: 2, kinds: [] };
                    }
                    if (request.type === "helman/get_appliances") return { appliances: [] };
                    return {};
                },
            };
            document.body.appendChild(element);
        },
        {
            config: {
                config_version: 26,
                devices: { groupings, consumers: [BOILER, WASHER] },
            },
        },
    );

    const panel = page.locator("helman-config-editor-panel");
    await panel.locator(".tabs").getByRole("button", { name: "Devices", exact: true }).click();
    await section(page).evaluate((details) => ((details as HTMLDetailsElement).open = true));
    // Every removal asks first; the tests answer yes.
    await openGroupings(page);
    page.on("dialog", (dialog) => void dialog.accept());
}

/** Grouping cards start collapsed; open them all to work inside. */
async function openGroupings(page: Page): Promise<void> {
    await page
        .locator("helman-config-editor-panel")
        .locator("details.grouping-card")
        .evaluateAll((cards) => cards.forEach((card) => ((card as HTMLDetailsElement).open = true)));
}

function section(page: Page) {
    return page.locator("helman-config-editor-panel").locator("details.section-card", {
        has: page.locator(":scope > summary .section-summary-label", { hasText: "Device groupings" }),
    });
}

function groupingCard(page: Page, index: number) {
    return section(page).locator(".grouping-card").nth(index);
}

const groupings = (page: Page) => page.evaluate(() => window.__editorConfig().devices.groupings);

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

test("each grouping is a card with a row per group, in order", async ({ page }) => {
    await mountEditor(page);

    await expect(section(page).locator(".grouping-card")).toHaveCount(2);
    await expect(groupingCard(page, 0).locator("input.grouping-name-input")).toHaveValue("Jističe");
    const rows = groupingCard(page, 0).locator(".group-rows-list .group-row");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1).locator("input.group-name-input")).toHaveValue("Technická síť");
    await expect(rows.nth(1).locator("input.group-short-name-input")).toHaveValue("⚡T");
    await expect(rows.nth(1).locator(".sortable-handle")).toHaveCount(1);
});

test("a rename changes the name and keeps the id", async ({ page }) => {
    await mountEditor(page);

    const name = groupingCard(page, 0).locator("input.grouping-name-input");
    await name.fill("Breaker boxes");
    await name.dispatchEvent("change");
    const shortName = groupingCard(page, 0).locator("input.group-short-name-input").first();
    await shortName.fill("FV");
    await shortName.dispatchEvent("change");

    expect((await groupings(page))[0]).toEqual({
        ...BREAKERS,
        name: "Breaker boxes",
        groups: [{ ...BREAKERS.groups[0], short_name: "FV" }, BREAKERS.groups[1]],
    });
    expect(await memberships(page)).toEqual({
        boiler: BOILER.groups,
        pump: { breakers: "technicka_sit" },
        washer: WASHER.groups,
    });
});

test("added entries get an id slugged from their name", async ({ page }) => {
    await mountEditor(page, []);

    await expect(section(page).locator(".message.info")).toHaveText("No groupings configured.");
    await section(page).locator(".add-grouping").click();
    await openGroupings(page);
    await groupingCard(page, 0).locator(".add-group").click();
    await groupingCard(page, 0).locator(".add-group").click();

    expect(await groupings(page)).toEqual([
        {
            id: "grouping_1",
            name: "Grouping 1",
            groups: [
                { id: "group_1", name: "Group 1", short_name: "1" },
                { id: "group_2", name: "Group 2", short_name: "2" },
            ],
        },
    ]);
});

test("removing a group strips it from every device that named it", async ({ page }) => {
    await mountEditor(page);

    await groupingCard(page, 0).locator(".group-rows-list .group-row").first().locator("button.remove-group").click();

    expect((await groupings(page))[0].groups).toEqual([BREAKERS.groups[1]]);
    // The washer named only that group, so its emptied map goes too; the
    // pump's other group of the same grouping stays.
    expect(await memberships(page)).toEqual({
        boiler: { modes: "night_off" },
        pump: { breakers: "technicka_sit" },
        washer: undefined,
    });
});

test("removing a grouping strips every device reference to it", async ({ page }) => {
    await mountEditor(page);

    await groupingCard(page, 0).locator("button.remove-grouping").click();

    expect(await groupings(page)).toEqual([MODES]);
    expect(await memberships(page)).toEqual({
        boiler: { modes: "night_off" },
        pump: undefined,
        washer: undefined,
    });
});

test("a grouping card starts collapsed and shows no ids", async ({ page }) => {
    await mountEditor(page);

    await section(page).locator(".add-grouping").click();

    const added = section(page).locator("details.grouping-card").last();
    expect(await added.evaluate((card) => (card as HTMLDetailsElement).open)).toBe(false);
    // Opening the others earlier does not open it, and ids are not shown anywhere.
    await expect(section(page).locator(".group-id-cell")).toHaveCount(0);
    await expect(groupingCard(page, 0).locator("summary")).toContainText("Jističe");
    await expect(groupingCard(page, 0).locator("summary")).not.toContainText("breakers");
});
