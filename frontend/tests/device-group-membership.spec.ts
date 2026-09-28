import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { consumerGroups, effectiveGroup } from "../cards/shared/config/devices";

/**
 * Group membership in the Devices tab's groupings section (#372).
 *
 * Every group row lists its consumers -- the ones whose effective group it is
 * -- as chips, and "Unassigned" lists the rest. A chip dropped into another
 * list of the same grouping sets or unsets its `groups.<grouping>`. A child
 * whose parent has a group carries an "inherit from parent" toggle: while on,
 * it follows its parent and is not draggable; off pins it to the parent's
 * group. A pinned child under an assigned parent cannot be unassigned.
 *
 * `ha-sortable` is HA's own element and undefined in a bare page, so a drop is
 * played the way SortableJS plays it: the chip moves into the target list,
 * the target fires `item-added`, and the source's rollback puts the chip back
 * before Lit redraws.
 *
 * The fixture: an AC breaker in "Technická FV" with one climate child that
 * inherits it and one pinned elsewhere, a schedulable boiler in no group, and
 * a lamp grouped only in the other grouping, whose bulb inherits it there.
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
    children: [{ id: "bulb", name: "Bulb", consumption: { energy_entity_id: "sensor.bulb_energy" } }],
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

async function mountEditor(page: Page): Promise<void> {
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
                devices: { groupings: [BREAKERS, MODES], system: [INVERTER], consumers: [AC, BOILER, LAMP] },
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
    // Removals ask first; the tests answer yes.
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

const groupingCard = (page: Page, index: number) =>
    page.locator("helman-config-editor-panel").locator(".grouping-card").nth(index);

const chip = (page: Page, grouping: number, id: string) =>
    groupingCard(page, grouping).locator(`.member-chip[data-device-id="${id}"]`);

/** Each list of one grouping -- its groups, then "Unassigned" (`""`) -- with its chips' ids. */
const lists = (page: Page, grouping: number) =>
    groupingCard(page, grouping)
        .locator(".group-members")
        .evaluateAll((found) =>
            Object.fromEntries(
                found.map((list) => [
                    (list as HTMLElement).dataset.groupId,
                    Array.from(list.querySelectorAll<HTMLElement>(".member-chip")).map((chip) => chip.dataset.deviceId),
                ]),
            ),
        );

/** Drop a chip into another list of its grouping, as SortableJS and `ha-sortable` play it. */
async function drop(page: Page, grouping: number, deviceId: string, groupId: string): Promise<void> {
    await groupingCard(page, grouping).evaluate(
        (card, { deviceId: id, groupId: target }) => {
            const dragged = card.querySelector(`.member-chip[data-device-id="${id}"]`) as HTMLElement & {
                sortableData?: unknown;
            };
            const list = card.querySelector(`.group-members[data-group-id="${target}"]`) as HTMLElement;
            const placeholder = document.createComment("sort-placeholder");
            dragged.after(placeholder);
            list.append(dragged);
            list.parentElement!.dispatchEvent(
                new CustomEvent("item-added", {
                    detail: { index: list.children.length - 1, data: dragged.sortableData, item: dragged },
                    bubbles: true,
                    composed: true,
                }),
            );
            // The source's rollback, still inside the same drop.
            placeholder.replaceWith(dragged);
        },
        { deviceId, groupId },
    );
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
        walk(window.__editorConfig().devices.consumers);
        return found;
    });

const INITIAL = {
    ac: { breakers: "technicka_fv" },
    klima_obyvak: undefined,
    klima_loznice: { breakers: "technicka_sit" },
    boiler: undefined,
    lamp: { modes: "night_off" },
    bulb: undefined,
};

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
    expect(
        consumerGroups(config, "g").map(({ device, group, parentGroup }) => [device.id, group, parentGroup]),
    ).toEqual([
        ["top", "x", null],
        ["child", "x", "x"],
        ["grandchild", "x", "x"],
        ["other", "y", "x"],
        ["loose", null, null],
    ]);
});

test("the Consumers list is the plain tree, with no view toggle", async ({ page }) => {
    await mountEditor(page);
    const panel = page.locator("helman-config-editor-panel");

    await expect(panel.locator(".device-filter")).toHaveCount(1);
    await expect(panel.locator(".device-view")).toHaveCount(0);
    await expect(panel.locator("helman-device-grouping-view, select.group-select")).toHaveCount(0);
    await expect(panel.locator("details.device-card")).toHaveCount(6);
});

test("each group lists its members, an inheriting child marked, then Unassigned", async ({ page }) => {
    await mountEditor(page);

    await expect.poll(() => lists(page, 0)).toEqual({
        technicka_fv: ["ac", "klima_obyvak"],
        technicka_sit: ["klima_loznice"],
        garage: [],
        "": ["boiler", "lamp", "bulb"],
    });
    await expect(groupingCard(page, 0).locator(".group-unassigned strong")).toHaveText("Unassigned");

    // Names resolve as the device cards resolve them; a child names its parent.
    await expect(chip(page, 0, "ac").locator(".member-name")).toHaveText("AC breaker");
    await expect(chip(page, 0, "klima_obyvak").locator(".member-name")).toHaveText("Obývák");
    await expect(chip(page, 0, "klima_obyvak").locator(".member-parent")).toHaveText("AC breaker");
    await expect(chip(page, 0, "boiler").locator(".member-parent")).toHaveCount(0);

    // The inheriting child is marked, and not draggable; the pinned one is.
    await expect(chip(page, 0, "klima_obyvak")).toHaveClass("member-chip inheriting");
    await expect(chip(page, 0, "klima_obyvak").locator(".member-inherit input")).toBeChecked();
    await expect(chip(page, 0, "klima_loznice")).toHaveClass("member-chip draggable");
    await expect(chip(page, 0, "klima_loznice").locator(".member-inherit input")).not.toBeChecked();
    // Only children of an assigned parent get the toggle.
    await expect(chip(page, 0, "ac").locator(".member-inherit")).toHaveCount(0);
    await expect(chip(page, 0, "bulb").locator(".member-inherit")).toHaveCount(0);

    await expect.poll(() => lists(page, 1)).toEqual({
        night_off: ["lamp", "bulb"],
        "": ["ac", "klima_obyvak", "klima_loznice", "boiler"],
    });
    await expect(chip(page, 1, "bulb")).toHaveClass("member-chip inheriting");
});

test("a drop into another group writes groups, and inheriting children move along", async ({ page }) => {
    await mountEditor(page);

    await drop(page, 0, "boiler", "garage");
    await drop(page, 0, "ac", "technicka_sit");

    await expect.poll(() => lists(page, 0)).toEqual({
        technicka_fv: [],
        technicka_sit: ["ac", "klima_obyvak", "klima_loznice"],
        garage: ["boiler"],
        "": ["lamp", "bulb"],
    });
    expect(await memberships(page)).toEqual({
        ...INITIAL,
        ac: { breakers: "technicka_sit" },
        boiler: { breakers: "garage" },
    });
});

test("a drop into Unassigned removes the key, and an emptied map", async ({ page }) => {
    await mountEditor(page);

    await drop(page, 0, "ac", "");
    await drop(page, 1, "lamp", "");

    await expect.poll(() => lists(page, 0)).toEqual({
        technicka_fv: [],
        technicka_sit: ["klima_loznice"],
        garage: [],
        "": ["ac", "klima_obyvak", "boiler", "lamp", "bulb"],
    });
    expect(await memberships(page)).toEqual({ ...INITIAL, ac: undefined, lamp: undefined });
});

test("an inheriting child is not draggable, and a drop of it is refused", async ({ page }) => {
    await mountEditor(page);
    const sortable = groupingCard(page, 0).locator("ha-sortable:has(> .group-members)").first();
    await expect(sortable).toHaveAttribute("draggable-selector", ".member-chip.draggable");
    await expect(sortable).toHaveAttribute("group", "helman-grouping-breakers");

    await drop(page, 0, "klima_obyvak", "garage");

    await expect.poll(() => lists(page, 0)).toEqual({
        technicka_fv: ["ac", "klima_obyvak"],
        technicka_sit: ["klima_loznice"],
        garage: [],
        "": ["boiler", "lamp", "bulb"],
    });
    expect(await memberships(page)).toEqual(INITIAL);
});

test("inherit off pins the child to its parent's group, and on removes the key", async ({ page }) => {
    await mountEditor(page);

    await chip(page, 0, "klima_obyvak").locator(".member-inherit input").uncheck();
    await expect(chip(page, 0, "klima_obyvak")).toHaveClass("member-chip draggable");
    expect((await memberships(page)).klima_obyvak).toEqual({ breakers: "technicka_fv" });

    // Pinned, it stays behind when its parent moves, and it can be dragged.
    await drop(page, 0, "ac", "garage");
    await drop(page, 0, "klima_obyvak", "technicka_sit");
    await expect.poll(() => lists(page, 0)).toEqual({
        technicka_fv: [],
        technicka_sit: ["klima_obyvak", "klima_loznice"],
        garage: ["ac"],
        "": ["boiler", "lamp", "bulb"],
    });

    await chip(page, 0, "klima_obyvak").locator(".member-inherit input").check();
    await chip(page, 0, "klima_loznice").locator(".member-inherit input").check();
    await expect.poll(() => lists(page, 0)).toEqual({
        technicka_fv: [],
        technicka_sit: [],
        garage: ["ac", "klima_obyvak", "klima_loznice"],
        "": ["boiler", "lamp", "bulb"],
    });
    expect(await memberships(page)).toEqual({ ...INITIAL, ac: { breakers: "garage" }, klima_loznice: undefined });
});

test("a pinned child under an assigned parent cannot be unassigned", async ({ page }) => {
    await mountEditor(page);

    await drop(page, 0, "klima_loznice", "");

    await expect.poll(() => lists(page, 0)).toEqual({
        technicka_fv: ["ac", "klima_obyvak"],
        technicka_sit: ["klima_loznice"],
        garage: [],
        "": ["boiler", "lamp", "bulb"],
    });
    // The refused chip is back in its own list, once.
    await expect(chip(page, 0, "klima_loznice")).toHaveCount(1);
    expect(await memberships(page)).toEqual(INITIAL);
});

test("a child of an unassigned parent drags like a top-level device", async ({ page }) => {
    await mountEditor(page);
    await expect(chip(page, 0, "bulb")).toHaveClass("member-chip draggable");

    await drop(page, 0, "bulb", "technicka_fv");
    await expect.poll(() => lists(page, 0)).toEqual({
        technicka_fv: ["ac", "klima_obyvak", "bulb"],
        technicka_sit: ["klima_loznice"],
        garage: [],
        "": ["boiler", "lamp"],
    });
    expect((await memberships(page)).bulb).toEqual({ breakers: "technicka_fv" });

    await drop(page, 0, "bulb", "");
    await expect.poll(() => memberships(page)).toEqual(INITIAL);
});

test("removing a group moves its members to Unassigned", async ({ page }) => {
    await mountEditor(page);

    await groupingCard(page, 0).locator(".group-rows-list .group-row").first().locator("button.remove-group").click();

    await expect.poll(() => lists(page, 0)).toEqual({
        technicka_sit: ["klima_loznice"],
        garage: [],
        "": ["ac", "klima_obyvak", "boiler", "lamp", "bulb"],
    });
    // Its parent has no group now, so the pinned child has nothing to inherit.
    await expect(chip(page, 0, "klima_loznice").locator(".member-inherit")).toHaveCount(0);
    expect(await memberships(page)).toEqual({ ...INITIAL, ac: undefined });
});

test("a grouping card never reuses another grouping's drag lists", async ({ page }) => {
    await mountEditor(page);
    // ha-sortable reads its drag group once, when created: after the breakers
    // grouping goes, the modes card must not sit on the breakers card's lists.
    await groupingCard(page, 0).locator("ha-sortable[group]").first().evaluate((el) => ((el as any).__marker = "breakers"));

    await groupingCard(page, 0).locator("button.remove-grouping").click();

    const first = groupingCard(page, 0).locator("ha-sortable[group]").first();
    await expect(first).toHaveAttribute("group", "helman-grouping-modes");
    expect(await first.evaluate((el) => (el as any).__marker)).toBeUndefined();
});
