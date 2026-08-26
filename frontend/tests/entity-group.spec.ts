import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The entity group: a picker, the settings that qualify it, and a reading.
 *
 * **Every status string asserted here traces to a token the stub below
 * supplied.** Nothing in this file sets up a state, a sign or a polarity and
 * then expects the editor to work out what it means -- that is the whole point
 * of the group. The backend decides what a path means and answers in tokens;
 * the element localizes them and renders them in order. If a test here ever
 * needs to arrange a *reading* rather than a *fact*, the contract has moved
 * back into the frontend and the fix is in `entity-group.ts`, not here.
 *
 * So the fixture answers `helman/inspect_entities` with facts of its own
 * choosing -- including one whose token no locale knows, because a backend
 * that learns to say something new must not spray key names across an editor
 * bundle that has not caught up.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

/** The group under test, and the key the editor derives for it from its path. */
const GRID_PATH = ["power_devices", "grid", "entities", "power"];
const GRID_KEY = GRID_PATH.join(".");

const STORED_CONFIG = {
    config_version: 6,
    power_devices: {
        grid: {
            entities: {
                power: "sensor.grid_power",
                power_polarity: "positive_is_import",
            },
        },
    },
};

/** A token no translation file has a string for, in either locale. */
const UNKNOWN_TOKEN = "a_token_this_bundle_has_never_heard_of";

const VALUE_FACT = {
    id: "value",
    token: "value",
    params: { value: "1400", unit: "W" },
    severity: "neutral",
};

/** What the fixture says the draft reads. The middle fact is unrenderable. */
const DRAFT_FACTS = [
    VALUE_FACT,
    { id: "mystery", token: UNKNOWN_TOKEN, params: {}, severity: "info" },
    { id: "reading", token: "power_reading.importing", params: {}, severity: "info" },
];

/** What the fixture says the *stored* document reads. */
const SAVED_FACTS = [
    VALUE_FACT,
    { id: "reading", token: "power_reading.exporting", params: {}, severity: "info" },
];

interface MountOptions {
    /** Whether the stubbed answer carries a saved reading and thus a revert. */
    withSaved?: boolean;
    config?: unknown;
}

async function mountEditor(page: Page, options: MountOptions = {}): Promise<void> {
    const { withSaved = false, config = STORED_CONFIG } = options;

    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-config-editor-panel"));

    await page.evaluate(
        ({ config, withSaved, gridKey, draftFacts, savedFacts }) => {
            const element = document.createElement(
                "helman-config-editor-panel",
            ) as HTMLElement & Record<string, unknown>;
            const requests: unknown[] = [];
            (window as any).__inspectRequests = requests;
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
                        requests.push(JSON.parse(JSON.stringify(request)));
                        // A spec can hold one answer back to reproduce a slow
                        // round trip: the ordering bugs only show when an
                        // earlier request resolves after a later one.
                        const delay = (window as any).__inspectDelayMs ?? 0;
                        if (delay > 0) {
                            (window as any).__inspectDelayMs = 0;
                            await new Promise((resolve) => setTimeout(resolve, delay));
                        }
                        // The *backend* decides what a reading says, so the
                        // stub reads the polarity out of the document it was
                        // sent and picks the token. Nothing on the editor side
                        // knows that a polarity has anything to do with this.
                        const polarity =
                            request.config?.power_devices?.grid?.entities?.power_polarity;
                        const gridFacts = draftFacts.map((fact: any) =>
                            fact.id === "reading"
                                ? {
                                      ...fact,
                                      token:
                                          polarity === "positive_is_export"
                                              ? "power_reading.exporting"
                                              : "power_reading.importing",
                                  }
                                : fact,
                        );
                        return {
                            results: (request.targets ?? []).map((target: any) => ({
                                key: target.key,
                                draft:
                                    target.key === gridKey
                                        ? { entityId: "sensor.grid_power", status: "ok", facts: gridFacts }
                                        : { entityId: null, status: "unsupported", facts: [] },
                                saved:
                                    withSaved && target.key === gridKey
                                        ? { entityId: "sensor.grid_power", status: "ok", facts: savedFacts }
                                        : null,
                            })),
                        };
                    }
                    return {};
                },
            };
            document.body.appendChild(element);
        },
        {
            config,
            withSaved,
            gridKey: GRID_KEY,
            draftFacts: DRAFT_FACTS,
            savedFacts: SAVED_FACTS,
        },
    );

    // The power devices live behind their own tab, and every section ships
    // collapsed; a collapsed <details> renders no group at all.
    await expect
        .poll(async () =>
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

    await expect
        .poll(async () =>
            page.evaluate(() => {
                const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
                Array.from(root?.querySelectorAll("details") ?? []).forEach((section) =>
                    section.setAttribute("open", ""),
                );
                return root?.querySelectorAll("helman-entity-group").length ?? 0;
            }),
        )
        .toBeGreaterThan(0);
}

/** Click one of the editor's top-level tabs by its English label. */
async function openTab(page: Page, label: string): Promise<void> {
    await expect
        .poll(async () =>
            page.evaluate((tabLabel) => {
                const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
                const tab = Array.from(root?.querySelectorAll("button") ?? []).find(
                    (button) => button.textContent?.trim() === tabLabel,
                );
                if (!tab) return false;
                tab.click();
                return true;
            }, label),
        )
        .toBe(true);
}

/** How many `helman/inspect_entities` calls the stub has answered so far. */
function requestCount(page: Page): Promise<number> {
    return page.evaluate(() => (window as any).__inspectRequests.length);
}

/** Everything one group currently shows, read out of its shadow root. */
function readGroup(page: Page, key: string) {
    return page.evaluate((groupKey) => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const group = Array.from(root?.querySelectorAll("helman-entity-group") ?? []).find(
            (element) => (element as any).key === groupKey,
        ) as (HTMLElement & { shadowRoot: ShadowRoot }) | undefined;
        if (!group) return null;
        const shadow = group.shadowRoot;
        const savedRow = shadow.querySelector(".saved-reading");
        return {
            label: shadow.querySelector("label")?.textContent?.trim() ?? "",
            hasPicker: !!shadow.querySelector("ha-entity-picker"),
            // The polarity select is slotted in from the panel, so it lives in
            // the group's light DOM rather than in its shadow root.
            slottedOptions: Array.from(group.querySelectorAll("select"))
                .flatMap((select) => Array.from(select.options).map((option) => option.value)),
            facts: Array.from(shadow.querySelectorAll(".entity-group > .facts .badge")).map(
                (badge) => badge.textContent?.trim() ?? "",
            ),
            savedFacts: Array.from(savedRow?.querySelectorAll(".badge") ?? []).map(
                (badge) => badge.textContent?.trim() ?? "",
            ),
            savedLabel: savedRow?.querySelector(".saved-label")?.textContent?.trim() ?? null,
            hasRevert: !!savedRow?.querySelector(".revert"),
        };
    }, key);
}

/** Block until the idle timer fires, so the next assertion owns a whole interval. */
async function waitForTick(page: Page): Promise<void> {
    const before = await requestCount(page);
    await expect.poll(() => requestCount(page), { timeout: 4000 }).toBeGreaterThan(before);
}

async function waitForFacts(page: Page) {
    await expect
        .poll(async () => (await readGroup(page, GRID_KEY))?.facts.length ?? 0)
        .toBeGreaterThan(0);
    return (await readGroup(page, GRID_KEY))!;
}

test("the group holds the picker, the slotted setting and the facts", async ({ page }) => {
    await mountEditor(page);
    const group = await waitForFacts(page);

    expect(group.hasPicker).toBe(true);
    expect(group.label).toBe("Power entity");
    // The polarity select moved *into* the group rather than being
    // reimplemented there: same options, same order, passed through the slot.
    expect(group.slottedOptions).toEqual(["positive_is_export", "positive_is_import"]);
});

test("an unknown token renders nothing while its siblings still render", async ({ page }) => {
    await mountEditor(page);
    const group = await waitForFacts(page);

    // Three facts went out, two have strings in this bundle, and the one that
    // does not leaves no trace -- not a raw key, not a warning marker.
    expect(group.facts).toEqual(["1400 W", "Importing from the grid"]);
    expect(group.facts.join(" ")).not.toContain(UNKNOWN_TOKEN);
    expect(group.facts.join(" ")).not.toContain("entity_status");
});

test("no saved reading means no second list and no revert", async ({ page }) => {
    await mountEditor(page);
    const group = await waitForFacts(page);

    expect(group.savedFacts).toEqual([]);
    expect(group.hasRevert).toBe(false);
});

test("a saved reading shows a second list and a revert control", async ({ page }) => {
    await mountEditor(page, { withSaved: true });
    const group = await waitForFacts(page);

    expect(group.savedLabel).toBe("Saved config reads");
    expect(group.savedFacts).toEqual(["1400 W", "Exporting to the grid"]);
    expect(group.hasRevert).toBe(true);
});

test("reverting restores both the entity and the setting beside it", async ({ page }) => {
    await mountEditor(page, { withSaved: true });
    await waitForFacts(page);

    // Move the draft away from the stored document on both of the group's own
    // paths, so the revert has to restore two values rather than one.
    await page.evaluate((path) => {
        const editor = document.querySelector("helman-config-editor-panel") as any;
        editor.setValue(path, "sensor.some_other_meter");
        editor.setValue(["power_devices", "grid", "entities", "power_polarity"], "positive_is_export");
    }, GRID_PATH);

    await expect
        .poll(async () => (await readGroup(page, GRID_KEY))?.hasRevert ?? false)
        .toBe(true);

    await page.evaluate((groupKey) => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const group = Array.from(root?.querySelectorAll("helman-entity-group") ?? []).find(
            (element) => (element as any).key === groupKey,
        ) as any;
        group.shadowRoot.querySelector(".revert").click();
    }, GRID_KEY);

    await expect
        .poll(async () =>
            page.evaluate(() => {
                const editor = document.querySelector("helman-config-editor-panel") as any;
                return editor.getValue(["power_devices", "grid", "entities"]);
            }),
        )
        .toEqual({ power: "sensor.grid_power", power_polarity: "positive_is_import" });
});

test("one request carries every mounted group, with paths and no entity ids", async ({ page }) => {
    // The contract, as it goes over the wire: config paths and two documents,
    // never an entity id and never a settings value. A request that named the
    // entity would mean the editor had worked out which one to ask about.
    await mountEditor(page);
    await waitForFacts(page);

    const request = await page.evaluate(() => (window as any).__inspectRequests.at(-1));
    expect(Object.keys(request).sort()).toEqual([
        "config",
        "saved_config",
        "targets",
        "type",
    ]);
    expect(request.targets.length).toBeGreaterThan(0);
    for (const target of request.targets) {
        expect(Object.keys(target).sort()).toEqual(["key", "path"]);
        expect(Array.isArray(target.path)).toBe(true);
    }
    expect(request.targets.map((target: any) => target.key)).toContain(GRID_KEY);
});


test("unmounting every group stops the polling", async ({ page }) => {
    // Regression: the group used to announce its own removal from
    // `disconnectedCallback`, which fires after the browser has detached it --
    // so the announcement never reached the panel and the collector kept
    // sending targets for groups that were gone, together with the whole
    // config document, for as long as the editor stayed open.
    await mountEditor(page);
    await waitForFacts(page);

    await openTab(page, "General");
    await expect
        .poll(async () =>
            page.evaluate(() => {
                const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
                return root?.querySelectorAll("helman-entity-group").length ?? 0;
            }),
        )
        .toBe(0);

    // Two full ticks with nothing mounted must produce no further calls.
    const before = await requestCount(page);
    await page.waitForTimeout(2500);
    expect(await requestCount(page)).toBe(before);

    // And coming back brings the readings straight back, so the fix did not
    // simply stop the poll for good.
    await openTab(page, "Power devices");
    await page.evaluate(() => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        Array.from(root?.querySelectorAll("details") ?? []).forEach((section) =>
            section.setAttribute("open", ""),
        );
    });
    const group = await waitForFacts(page);
    expect(group.facts).toEqual(["1400 W", "Importing from the grid"]);
});

test("clearing a configured entity keeps the saved reading and its revert", async ({ page }) => {
    // Regression: targets whose draft value was blank were filtered out of the
    // request, on the grounds that the backend would only answer `unset`. But
    // `unset` is exactly when the saved document reads differently -- so the
    // one edit most likely to want a revert was the one edit that removed it.
    await mountEditor(page, { withSaved: true });
    await waitForFacts(page);

    // Count first: a filtered-out target leaves the *previous* request in
    // place, and asserting on the latest one would then pass on the very bug
    // this test exists to catch. What has to be true is that a request sent
    // *after* the clear still carries the group.
    const before = await requestCount(page);
    await page.evaluate((path) => {
        const editor = document.querySelector("helman-config-editor-panel") as any;
        editor.setValue(path, "");
    }, GRID_PATH);

    await expect.poll(async () => requestCount(page)).toBeGreaterThan(before);
    const request = await page.evaluate(() => (window as any).__inspectRequests.at(-1));
    expect(request.targets.map((target: any) => target.key)).toContain(GRID_KEY);

    await expect
        .poll(async () => (await readGroup(page, GRID_KEY))?.hasRevert ?? false)
        .toBe(true);

    await page.evaluate((groupKey) => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const group = Array.from(root?.querySelectorAll("helman-entity-group") ?? []).find(
            (element) => (element as any).key === groupKey,
        ) as any;
        group.shadowRoot.querySelector(".revert").click();
    }, GRID_KEY);

    await expect
        .poll(async () =>
            page.evaluate(() => {
                const editor = document.querySelector("helman-config-editor-panel") as any;
                return editor.getValue(["power_devices", "grid", "entities", "power"]);
            }),
        )
        .toBe("sensor.grid_power");
});

test("a tab with no groups at all never asks", async ({ page }) => {
    // The early return has to survive the widened filter: nothing picked and
    // nothing saved means no call, not a call with an empty target list.
    await mountEditor(page, { config: { config_version: 6 } });
    await openTab(page, "General");
    await page.waitForTimeout(2500);
    expect(await requestCount(page)).toBe(0);
});


test("changing a setting re-reads at once, without waiting for the timer", async ({ page }) => {
    // Regression: the timer was the only thing that polled, so flipping a
    // polarity left the old direction on screen for up to two seconds — a
    // control that visibly did nothing.
    await mountEditor(page);
    const before = await waitForFacts(page);
    expect(before.facts).toEqual(["1400 W", "Importing from the grid"]);

    // Sync to a tick before touching anything, so the assertion below owns a
    // window the timer cannot close. Without this the spec passes against a
    // build with no fix in it at all, whenever a tick happens to land inside
    // the assertion's own timeout — which is most of the time.
    await waitForTick(page);
    const requestsBefore = await requestCount(page);

    await page.evaluate((groupKey) => {
        const root = document.querySelector("helman-config-editor-panel")?.shadowRoot;
        const group = Array.from(root?.querySelectorAll("helman-entity-group") ?? []).find(
            (element) => (element as any).key === groupKey,
        ) as any;
        const select = group.querySelector("select") as HTMLSelectElement;
        select.value = "positive_is_export";
        select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    }, GRID_KEY);

    // Well inside the interval the tick above just restarted.
    await expect
        .poll(async () => (await readGroup(page, GRID_KEY))?.facts ?? [], { timeout: 600 })
        .toEqual(["1400 W", "Exporting to the grid"]);
    expect(await requestCount(page)).toBeGreaterThan(requestsBefore);
});

test("typing does not send one request per keystroke", async ({ page }) => {
    // The other half of the trigger: leading edge for the discrete change,
    // coalesced for a burst. Ten writes in a row must not be ten documents on
    // the wire — and must still be more than none.
    await mountEditor(page);
    await waitForFacts(page);

    await waitForTick(page);
    const before = await requestCount(page);

    await page.evaluate(() => {
        const editor = document.querySelector("helman-config-editor-panel") as any;
        for (let index = 0; index < 10; index += 1) {
            editor.setValue(["power_devices", "house", "power_sensor_label"], "x".repeat(index + 1));
        }
    });

    // One leading call plus at most one trailing call for the whole burst,
    // all of it inside the interval the tick above restarted.
    await page.waitForTimeout(600);
    const sent = (await requestCount(page)) - before;
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThanOrEqual(2);
});

test("a slow answer cannot repaint a reading the user has already cleared", async ({ page }) => {
    // Regression: the empty-targets branch cleared the map and returned
    // without taking a sequence number, so it did not count as the newest
    // answer. An in-flight request that resolved after it was therefore still
    // "newer than anything applied", and put the cleared entity's reading back
    // on screen, where it sat until the next tick.
    //
    // Starting from a document with nothing at the path is what makes the
    // clear reach that branch at all: while the *stored* config still names an
    // entity, the poll rightly keeps asking so the saved reading can be shown.
    await mountEditor(page, {
        config: {
            config_version: 6,
            power_devices: { grid: { entities: { power: "", power_polarity: "positive_is_import" } } },
        },
    });
    // No tick sync here: with nothing at the path the poll rightly sends
    // nothing at all, so there is no tick to sync to. Wait for the group to
    // exist instead.
    await expect.poll(async () => !!(await readGroup(page, GRID_KEY))).toBe(true);
    expect((await readGroup(page, GRID_KEY))?.facts ?? []).toEqual([]);

    await page.evaluate(() => {
        (window as any).__inspectDelayMs = 700;
        const editor = document.querySelector("helman-config-editor-panel") as any;
        // The slow request goes out first, carrying the entity...
        editor.setValue(["power_devices", "grid", "entities", "power"], "sensor.grid_power");
    });
    // ...and the clear lands while it is still out, with nothing left to ask
    // about, so it takes the empty-targets path.
    await page.waitForTimeout(450);
    await page.evaluate(() => {
        const editor = document.querySelector("helman-config-editor-panel") as any;
        editor.setValue(["power_devices", "grid", "entities", "power"], "");
    });

    // The slow answer resolves inside this window. It must not come back.
    await page.waitForTimeout(800);
    expect((await readGroup(page, GRID_KEY))?.facts ?? []).toEqual([]);
});
