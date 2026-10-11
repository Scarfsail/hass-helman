import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { assignPhase, consumerPhases } from "../cards/shared/config/devices";

/**
 * The House phases card that opens the Devices tab's groupings section (#459).
 *
 * One bucket per house phase lists the consumers whose own `phase` names it
 * -- only a direct assignment counts, as in a grouping -- and "Unassigned"
 * lists the rest, a child with no phase of its own and an unknown value
 * included. A chip dropped into another bucket sets or unsets that device's
 * `phase`, and only its own; the phase picker in its editor follows. Phases
 * are fixed, so the card offers no way to add, remove, rename or reorder them.
 *
 * `ha-sortable` is HA's own element and undefined in a bare page, so a drop is
 * played the way SortableJS plays it, as in device-group-membership.spec.ts.
 *
 * The fixture: an AC breaker on L1 with one climate child on no phase and one
 * on L2, a three-phase boiler, and a lamp with an unknown phase and a bulb
 * child on none.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

const BREAKERS = {
    id: "breakers",
    name: "Jističe",
    groups: [{ id: "garage", name: "Garáž", short_name: "G" }],
};

const klima = (id: string, phase?: string) => ({
    id,
    kind: "climate",
    schedulable: true,
    controls: { climate: { entity_id: `climate.${id}` } },
    consumption: { projection: { strategy: "fixed", hourly_energy_kwh: 0.5 } },
    ...(phase ? { phase } : {}),
});

const AC = {
    id: "ac",
    name: "AC breaker",
    phase: "L1",
    consumption: { energy_entity_id: "sensor.ac_energy" },
    children: [klima("klima_obyvak"), klima("klima_loznice", "L2")],
};
const BOILER = {
    id: "boiler",
    name: "Boiler",
    phase: "3ph",
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
    phase: "L4",
    consumption: { energy_entity_id: "sensor.lamp_energy" },
    children: [{ id: "bulb", name: "Bulb", consumption: { energy_entity_id: "sensor.bulb_energy" } }],
};

type Device = Record<string, any>;

declare global {
    interface Window {
        __editorConfig: () => { devices: { groupings?: any[]; consumers: Device[] } };
    }
}

async function mountEditor(page: Page, groupings: unknown[] = [BREAKERS]): Promise<void> {
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
                    return {};
                },
            };
            document.body.appendChild(element);
        },
        {
            config: {
                config_version: 26,
                devices: { ...(groupings.length > 0 ? { groupings } : {}), consumers: [AC, BOILER, LAMP] },
            },
        },
    );

    const panel = page.locator("helman-config-editor-panel");
    await panel.locator(".tabs").getByRole("button", { name: "Devices", exact: true }).click();
    for (const label of ["Groupings and phases", "Consumers"]) {
        await panel
            .locator("details.section-card", {
                has: page.locator(":scope > summary .section-summary-label", { hasText: label }),
            })
            .evaluate((details) => ((details as HTMLDetailsElement).open = true));
    }
    await phaseCard(page).evaluate((card) => ((card as HTMLDetailsElement).open = true));
}

const section = (page: Page) =>
    page.locator("helman-config-editor-panel").locator("details.section-card", {
        has: page.locator(":scope > summary .section-summary-label", { hasText: "Groupings and phases" }),
    });

const phaseCard = (page: Page) => section(page).locator("details.phase-card");

/** Each bucket -- the phases, then "Unassigned" (`""`) -- with its chips' ids. */
const buckets = (page: Page) =>
    phaseCard(page)
        .locator(".group-members")
        .evaluateAll((found) =>
            Object.fromEntries(
                found.map((list) => [
                    (list as HTMLElement).dataset.groupId,
                    Array.from(list.querySelectorAll<HTMLElement>(".member-chip")).map((chip) => chip.dataset.deviceId),
                ]),
            ),
        );

/** Drop a chip into another bucket, as SortableJS and `ha-sortable` play it. */
async function drop(page: Page, deviceId: string, phase: string): Promise<void> {
    await phaseCard(page).evaluate(
        (card, { deviceId: id, phase: target }) => {
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
        { deviceId, phase },
    );
}

/** Every consumer's `phase`, by id, children included. */
const phases = (page: Page) =>
    page.evaluate(() => {
        const found: Record<string, unknown> = {};
        const walk = (devices: any[]) =>
            devices.forEach((device) => {
                found[device.id] = device.phase;
                walk(device.children ?? []);
            });
        walk(window.__editorConfig().devices.consumers);
        return found;
    });

const INITIAL = {
    ac: "L1",
    klima_obyvak: undefined,
    klima_loznice: "L2",
    boiler: "3ph",
    lamp: "L4",
    bulb: undefined,
};

const INITIAL_BUCKETS = {
    L1: ["ac"],
    L2: ["klima_loznice"],
    L3: [],
    "3ph": ["boiler"],
    "": ["klima_obyvak", "lamp", "bulb"],
};

test("consumerPhases: each consumer with its own phase only", () => {
    const config = {
        devices: {
            consumers: [
                { id: "top", phase: "L1", children: [{ id: "child" }, { id: "other", phase: "L3" }] },
                { id: "blank", phase: "" },
            ],
        },
    };
    expect(consumerPhases(config).map(({ device, group }) => [device.id, group])).toEqual([
        ["top", "L1"],
        ["child", null],
        ["other", "L3"],
        ["blank", null],
    ]);
});

test("assignPhase: sets or deletes the device's own phase, false for a no-op or a non-consumer", () => {
    const config: Record<string, any> = {
        energy_nodes: { inverter: { id: "inverter" } },
        devices: { consumers: [{ id: "top", phase: "L1", children: [{ id: "child" }] }] },
    };
    const child = ["devices", "consumers", 0, "children", 0];

    expect(assignPhase(config, child, "L2")).toBe(true);
    expect(config.devices.consumers[0].children[0].phase).toBe("L2");
    expect(config.devices.consumers[0].phase).toBe("L1");

    expect(assignPhase(config, child, "L2")).toBe(false);
    expect(assignPhase(config, child, null)).toBe(true);
    expect("phase" in config.devices.consumers[0].children[0]).toBe(false);
    expect(assignPhase(config, child, null)).toBe(false);

    // Neither the inverter nor a path below a device is a consumer.
    expect(assignPhase(config, ["energy_nodes", "inverter"], "L1")).toBe(false);
    expect(assignPhase(config, ["devices", "consumers", 0, "children"], "L1")).toBe(false);
    expect(config.energy_nodes.inverter).toEqual({ id: "inverter" });
});

test("assignPhase: unassigning deletes an invalid phase that reads as unassigned", () => {
    for (const invalid of ["", 3]) {
        const config: Record<string, any> = { devices: { consumers: [{ id: "lamp", phase: invalid }] } };
        expect(assignPhase(config, ["devices", "consumers", 0], null)).toBe(true);
        expect("phase" in config.devices.consumers[0]).toBe(false);
    }
});

test("the House phases card opens the section, even with no groupings", async ({ page }) => {
    await mountEditor(page, []);

    const cards = section(page).locator(".phase-card, .grouping-card, .message");
    await expect(cards.first()).toHaveClass(/phase-card/);
    await expect(cards.nth(1)).toHaveText("No groupings configured.");
    await expect(phaseCard(page).locator(":scope > summary .card-title strong")).toHaveText("House phases");
    await expect(phaseCard(page).locator(":scope > summary .card-subtitle")).toHaveText("Phases");
    await expect(phaseCard(page).locator(".group-row .phase-name")).toHaveText(["L1", "L2", "L3", "Three-phase"]);
    await expect(phaseCard(page).locator(".group-unassigned strong")).toHaveText("Unassigned");
    await expect.poll(() => buckets(page)).toEqual(INITIAL_BUCKETS);
});

test("each bucket lists its own devices; a child without a phase and an unknown one sit in Unassigned", async ({
    page,
}) => {
    await mountEditor(page);

    await expect(section(page).locator(".phase-card, .grouping-card").first()).toHaveClass(/phase-card/);
    await expect.poll(() => buckets(page)).toEqual(INITIAL_BUCKETS);
    await expect(phaseCard(page).locator('.member-chip[data-device-id="klima_obyvak"] .member-parent')).toHaveText(
        "AC breaker",
    );
});

test("a drop into a phase writes that device's phase only, and Unassigned deletes it", async ({ page }) => {
    await mountEditor(page);

    // A parent moves alone, and a child takes a phase of its own.
    await drop(page, "ac", "L3");
    await drop(page, "klima_obyvak", "L1");
    await drop(page, "boiler", "");

    await expect.poll(() => buckets(page)).toEqual({
        L1: ["klima_obyvak"],
        L2: ["klima_loznice"],
        L3: ["ac"],
        "3ph": [],
        "": ["boiler", "lamp", "bulb"],
    });
    expect(await phases(page)).toEqual({ ...INITIAL, ac: "L3", klima_obyvak: "L1", boiler: undefined });
    expect(await page.evaluate(() => "phase" in window.__editorConfig().devices.consumers[1])).toBe(false);

    // The device editor's picker shows what the board set.
    const picker = (id: string) =>
        page
            .locator("helman-config-editor-panel")
            .locator(`details.device-card[data-device-id="${id}"] > .appliance-body select.device-phase`)
            .first();
    await expect(picker("ac")).toHaveValue("L3");
    await expect(picker("boiler")).toHaveValue("");

    // An unknown phase is fixed by a drop like any other.
    await drop(page, "lamp", "L2");
    await expect.poll(() => phases(page)).toEqual({
        ...INITIAL,
        ac: "L3",
        klima_obyvak: "L1",
        boiler: undefined,
        lamp: "L2",
    });
});

test("the card offers no way to add, remove, rename or reorder phases", async ({ page }) => {
    await mountEditor(page);
    const card = phaseCard(page);

    await expect(card.locator("button")).toHaveCount(0);
    await expect(card.locator("input")).toHaveCount(0);
    await expect(card.locator(".sortable-handle")).toHaveCount(0);
});

test("the phase buckets share a drag group no grouping uses", async ({ page }) => {
    await mountEditor(page);

    const groups = await phaseCard(page)
        .locator("ha-sortable")
        .evaluateAll((found) => found.map((sortable) => sortable.getAttribute("group")));
    expect(groups).toEqual(Array(5).fill("helman-phases"));
    await expect(section(page).locator(".grouping-card ha-sortable[group]").first()).toHaveAttribute(
        "group",
        "helman-grouping-breakers",
    );
});
