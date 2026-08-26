import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * A reading is a way into the entity it came from.
 *
 * Clicking what a sensor says should open Home Assistant's own more-info
 * dialog for it, which is HA's `hass-more-info` event and not something this
 * bundle implements. Two things can go wrong and neither is visible from
 * inside the element: the event can fail to escape the shadow roots it is
 * dispatched inside -- the group's, then the panel's -- and it can be fired
 * for an entity that does not exist, which opens a dialog on nothing.
 *
 * So the assertions here are about the event as seen from `document`, which is
 * where HA's dialog manager listens, and about which badges are controls at
 * all.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

/** The group whose reading is clicked, and the id the editor derives for it. */
const GRID_PATH = ["power_devices", "grid", "entities", "power"];
const GRID_KEY = GRID_PATH.join(".");
/** A configured picker the stub answers about with no entity behind it. */
const HOUSE_KEY = ["power_devices", "house", "entities", "power"].join(".");

const CONFIG = {
    config_version: 7,
    power_devices: {
        grid: { entities: { power: "sensor.grid_power" } },
        house: { entities: { power: "sensor.house_power" } },
    },
    controllables: [],
};

/** What the draft reads, what the *stored* document read: different entities. */
const DRAFT_ENTITY = "sensor.grid_power";
const SAVED_ENTITY = "sensor.the_meter_this_used_to_be";

const VALUE_FACT = {
    id: "value",
    token: "value",
    params: { value: "1400", unit: "W" },
    severity: "neutral",
};

/**
 * A fact that is a statement *about* the entity rather than its value.
 *
 * The backend gives it an id of its own -- readings are `reading`, history is
 * `history`, problems are `state` -- and only the one it calls `value` is a way
 * into the entity.
 */
const READING_FACT = {
    id: "reading",
    token: "power_reading.importing",
    params: {},
    severity: "info",
};

async function mountEditor(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));

    await page.evaluate(
        ({ config, gridKey, houseKey, draftEntity, savedEntity, valueFact, readingFact }) => {
            // Recorded at `document`, which is as far as the event has to
            // travel: HA's dialog manager listens on the root element, several
            // shadow boundaries above the group that fires it.
            (window as any).__moreInfo = [];
            document.addEventListener("hass-more-info", (event: Event) => {
                (window as any).__moreInfo.push(
                    (event as CustomEvent<{ entityId?: string }>).detail?.entityId ?? null,
                );
            });

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
                            results: (request.targets ?? []).map((target: any) => {
                                if (target.key === gridKey) {
                                    return {
                                        key: target.key,
                                        draft: {
                                            entityId: draftEntity,
                                            status: "ok",
                                            facts: [valueFact, readingFact],
                                        },
                                        // The stored document named a different
                                        // sensor, which is exactly the edit that
                                        // makes the two rows disagree.
                                        saved: {
                                            entityId: savedEntity,
                                            status: "ok",
                                            facts: [valueFact, readingFact],
                                        },
                                    };
                                }
                                if (target.key === houseKey) {
                                    // A path no evaluator claims still gets a
                                    // renderable fact, so the badge exists --
                                    // it just has no entity behind it.
                                    return {
                                        key: target.key,
                                        draft: {
                                            entityId: null,
                                            status: "unsupported",
                                            facts: [valueFact],
                                        },
                                        saved: null,
                                    };
                                }
                                return {
                                    key: target.key,
                                    draft: { entityId: null, status: "unset", facts: [] },
                                    saved: null,
                                };
                            }),
                        };
                    }
                    return {};
                },
            };
            document.body.appendChild(element);

            (window as any).badgesOf = function badgesOf(key: string, row: string) {
                const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
                const group = Array.from(
                    root?.querySelectorAll("helman-entity-group") ?? [],
                ).find((candidate: any) => candidate.key === key) as any;
                const scope =
                    row === "saved"
                        ? group?.shadowRoot?.querySelector(".saved-reading")
                        : group?.shadowRoot?.querySelector(".entity-group > .facts");
                return Array.from(scope?.querySelectorAll(".badge") ?? []);
            };
        },
        {
            config: CONFIG,
            gridKey: GRID_KEY,
            houseKey: HOUSE_KEY,
            draftEntity: DRAFT_ENTITY,
            savedEntity: SAVED_ENTITY,
            valueFact: VALUE_FACT,
            readingFact: READING_FACT,
        },
    );

    await expect
        .poll(() =>
            page.evaluate(() => {
                const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
                const tab = Array.from(root?.querySelectorAll("button") ?? []).find(
                    (button) => button.textContent?.trim() === "Power devices",
                );
                if (!tab) return false;
                tab.click();
                return true;
            }),
        )
        .toBe(true);

    // Every section ships collapsed and a collapsed `details` renders no group.
    await expect
        .poll(() =>
            page.evaluate(() => {
                const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
                Array.from(root?.querySelectorAll("details") ?? []).forEach((section) =>
                    section.setAttribute("open", ""),
                );
                return root?.querySelectorAll("helman-entity-group").length ?? 0;
            }),
        )
        .toBeGreaterThan(0);

    // The badges only exist once the first inspection has landed.
    await expect
        .poll(
            () =>
                page.evaluate(
                    (key) => (window as any).badgesOf(key, "draft").length,
                    GRID_KEY,
                ),
            { timeout: 5000 },
        )
        .toBeGreaterThan(0);
}

test.describe("more-info from a reading", () => {
    test("a draft reading opens the entity the draft names", async ({ page }) => {
        await mountEditor(page);

        const kind = await page.evaluate(
            (key) => (window as any).badgesOf(key, "draft")[0]?.tagName,
            GRID_KEY,
        );
        // A real control, not a span with a click handler: it opens a dialog,
        // so it has to be reachable and announceable as something that does.
        expect(kind).toBe("BUTTON");

        await page.evaluate(
            (key) => (window as any).badgesOf(key, "draft")[0].click(),
            GRID_KEY,
        );
        expect(await page.evaluate(() => (window as any).__moreInfo)).toEqual([DRAFT_ENTITY]);
    });

    test("a saved reading opens the entity the saved document names", async ({ page }) => {
        await mountEditor(page);
        await page.evaluate(
            (key) => (window as any).badgesOf(key, "saved")[0].click(),
            GRID_KEY,
        );
        // Not the draft's entity: the two rows exist precisely because the
        // stored document says something the draft no longer does.
        expect(await page.evaluate(() => (window as any).__moreInfo)).toEqual([SAVED_ENTITY]);
    });

    test("it is reachable and fired from the keyboard", async ({ page }) => {
        await mountEditor(page);
        const focused = await page.evaluate((key) => {
            const badge = (window as any).badgesOf(key, "draft")[0] as HTMLElement;
            badge.focus();
            const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
            const group = Array.from(
                root?.querySelectorAll("helman-entity-group") ?? [],
            ).find((candidate: any) => candidate.key === key) as any;
            return {
                isActive: group?.shadowRoot?.activeElement === badge,
                label: badge.getAttribute("aria-label"),
            };
        }, GRID_KEY);
        expect(focused.isActive).toBe(true);
        // The id belongs in the accessible name: "the value badge" says
        // nothing about which of a tab's twenty entities is about to open.
        expect(focused.label).toContain(DRAFT_ENTITY);

        await page.keyboard.press("Enter");
        expect(await page.evaluate(() => (window as any).__moreInfo)).toEqual([DRAFT_ENTITY]);
    });

    test("a value with no entity behind it is not a control", async ({ page }) => {
        await mountEditor(page);
        const kind = await page.evaluate(
            (key) => (window as any).badgesOf(key, "draft")[0]?.tagName,
            HOUSE_KEY,
        );
        // The picker is configured and the badge renders, but the backend
        // named no entity for it. A dialog opened on nothing is worse than no
        // dialog, and a control that does nothing when pressed is worse still.
        expect(kind).toBe("SPAN");
        expect(await page.evaluate(() => (window as any).__moreInfo)).toEqual([]);
    });

    test("a reading beside the value is not a control", async ({ page }) => {
        await mountEditor(page);
        // Both rows, because the saved row builds its badges the same way and
        // a rule applied in one place and not the other is the easy mistake.
        for (const row of ["draft", "saved"]) {
            const kinds = await page.evaluate(
                ({ key, which }) =>
                    (window as any)
                        .badgesOf(key, which)
                        .map((badge: Element) => badge.tagName),
                { key: GRID_KEY, which: row },
            );
            // The value opens the entity; "importing" is a statement *about*
            // the entity and opening a dialog from it put a second tab stop on
            // the row that did exactly what the first one did.
            expect(kinds).toEqual(["BUTTON", "SPAN"]);
        }

        await page.evaluate((key) => {
            const badge = (window as any).badgesOf(key, "draft")[1] as HTMLElement;
            badge.click();
        }, GRID_KEY);
        expect(await page.evaluate(() => (window as any).__moreInfo)).toEqual([]);
    });
});
