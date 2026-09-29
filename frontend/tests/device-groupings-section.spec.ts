import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The Devices tab's groupings section (#363): `devices.groupings` edited in place.
 *
 * A grouping is a card named by its title input, its groups one row each. Ids
 * are slugged from the name when the entry is added and editable beside it
 * (#379): a typed id is slugged on commit and a rename touches the name only.
 * What would silently break a saved config if it regressed is a device still
 * naming a group that is gone -- it fails validation -- so a removal strips,
 * and an id change rewrites, every device reference in the same mutation.
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

test("a grouping card starts collapsed and each row shows its id", async ({ page }) => {
    await mountEditor(page);

    await section(page).locator(".add-grouping").click();

    const added = section(page).locator("details.grouping-card").last();
    expect(await added.evaluate((card) => (card as HTMLDetailsElement).open)).toBe(false);
    // Opening the others earlier does not open it.
    await expect(groupingCard(page, 0).locator("input.grouping-id-input")).toHaveValue("breakers");
    const rows = groupingCard(page, 0).locator(".group-rows-list .group-row");
    await expect(rows.nth(0).locator("input.group-id-input")).toHaveValue("technicka_fv");
    await expect(rows.nth(1).locator("input.group-id-input")).toHaveValue("technicka_sit");
    await expect(added.locator("input.grouping-id-input")).toHaveValue("grouping_3");
});

/** Types `value` into an id input and commits it, as leaving the field does. */
async function commit(input: ReturnType<Page["locator"]>, value: string): Promise<void> {
    await input.fill(value);
    await input.dispatchEvent("change");
}

test("renaming a grouping id rewrites every device's key and keeps the card open", async ({ page }) => {
    await mountEditor(page);

    await commit(groupingCard(page, 0).locator("input.grouping-id-input"), "jistice");

    expect((await groupings(page))[0]).toEqual({ ...BREAKERS, id: "jistice" });
    expect(await memberships(page)).toEqual({
        boiler: { jistice: "technicka_fv", modes: "night_off" },
        pump: { jistice: "technicka_sit" },
        washer: { jistice: "technicka_fv" },
    });
    const card = groupingCard(page, 0);
    await expect(card).toHaveAttribute("data-grouping-id", "jistice");
    await expect.poll(() => card.evaluate((details) => (details as HTMLDetailsElement).open)).toBe(true);
    // A new card, so its lists drag under the new id.
    await expect(card.locator("ha-sortable[group]").first()).toHaveAttribute("group", "helman-grouping-jistice");
});

test("renaming a group id rewrites only that grouping's matching members", async ({ page }) => {
    await mountEditor(page);

    await commit(
        groupingCard(page, 0).locator(".group-rows-list .group-row").first().locator("input.group-id-input"),
        "fv",
    );

    expect((await groupings(page))[0].groups).toEqual([{ ...BREAKERS.groups[0], id: "fv" }, BREAKERS.groups[1]]);
    expect(await memberships(page)).toEqual({
        boiler: { breakers: "fv", modes: "night_off" },
        pump: { breakers: "technicka_sit" },
        washer: { breakers: "fv" },
    });
});

test("a typed id is slugged, and a clash with a sibling gets a suffix", async ({ page }) => {
    await mountEditor(page);

    const rows = groupingCard(page, 0).locator(".group-rows-list .group-row");
    await commit(rows.nth(0).locator("input.group-id-input"), "Night Off!");
    await expect(rows.nth(0).locator("input.group-id-input")).toHaveValue("night_off");
    await commit(rows.nth(1).locator("input.group-id-input"), "night_off");
    await expect(rows.nth(1).locator("input.group-id-input")).toHaveValue("night_off_2");

    expect((await groupings(page))[0].groups.map((group: { id: string }) => group.id)).toEqual([
        "night_off",
        "night_off_2",
    ]);
    // Only the breakers grouping's references move; the modes group of the same id stays.
    expect(await memberships(page)).toEqual({
        boiler: { breakers: "night_off", modes: "night_off" },
        pump: { breakers: "night_off_2" },
        washer: { breakers: "night_off" },
    });
});

test("clearing an id reverts it and leaves the config unchanged", async ({ page }) => {
    await mountEditor(page);
    const before = await page.evaluate(() => JSON.stringify(window.__editorConfig()));

    const groupingInput = groupingCard(page, 0).locator("input.grouping-id-input");
    await commit(groupingInput, "  ");
    await expect(groupingInput).toHaveValue("breakers");
    const groupInput = groupingCard(page, 0).locator("input.group-id-input").first();
    await commit(groupInput, "");
    await expect(groupInput).toHaveValue("technicka_fv");

    expect(await page.evaluate(() => JSON.stringify(window.__editorConfig()))).toBe(before);
});

test("an id being typed survives a re-render, and a slug equal to the stored id reverts the text", async ({ page }) => {
    await mountEditor(page);
    // A hass update re-renders the panel while the user is still typing.
    const rerender = () =>
        page.locator("helman-config-editor-panel").evaluate(async (element) => {
            const panel = element as HTMLElement & { hass: object; updateComplete: Promise<unknown> };
            panel.hass = { ...panel.hass };
            await panel.updateComplete;
        });

    const groupInput = groupingCard(page, 0).locator("input.group-id-input").first();
    await groupInput.fill("technicka_fvx");
    await rerender();
    await expect(groupInput).toHaveValue("technicka_fvx");
    await commit(groupInput, "Technicka FV");
    await expect(groupInput).toHaveValue("technicka_fv");

    const groupingInput = groupingCard(page, 0).locator("input.grouping-id-input");
    await groupingInput.fill("breakersx");
    await rerender();
    await expect(groupingInput).toHaveValue("breakersx");
    await commit(groupingInput, "Breakers");
    await expect(groupingInput).toHaveValue("breakers");
});
