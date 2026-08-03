import { test, expect, type Page, type Locator } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The config editor hearing that the stored config moved.
 *
 * This is the one surface where reloading on an announcement would be actively
 * harmful: the editor holds an editable draft. Its reload *button* already
 * knows this and refuses a dirty reload without a `window.confirm` — and an
 * announcement has no user gesture to hang a confirm on, so it has to be
 * strictly more conservative than the button.
 *
 * Three cases, and the middle one is the reason the phase exists:
 *
 * - **Clean editor: reload.** Someone saved from another machine; there is
 *   nothing to lose, so pick it up.
 * - **Dirty editor: do not reload, and say so.** Never discard a draft — but
 *   never leave it silently sitting on a superseded document either, which is
 *   the failure this feature could otherwise create.
 * - **The machine that saved: neither.** It already refreshed everything its
 *   own write touched; re-reading and warning would both be noise.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

const SCHEMA = { version: 2, kinds: [] };

/** What the fake backend has stored. Swapped to stand in for another machine. */
const STORED_CONFIG = { config_version: 6, forecast_days: 3 };
const CHANGED_CONFIG = { config_version: 6, forecast_days: 5 };

declare global {
    interface Window {
        /** Replace what `helman/get_config` returns from now on. */
        __setStoredConfig: (config: unknown) => void;
        __getConfigCalls: () => number;
        __saveCalls: () => number;
        __fireDataChanged: (kind: string) => void;
        /** Whether `helman/save_config` should report a successful reload. */
        __saveSucceeds: boolean;
    }
}

async function mountEditor(page: Page): Promise<Locator> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(
        () => !!customElements.get("helman-config-editor-panel"),
    );

    await page.evaluate(
        ({ schema, config }) => {
            let stored: unknown = config;
            let getConfigCalls = 0;
            window.__setStoredConfig = (next: unknown) => {
                stored = next;
            };
            window.__getConfigCalls = () => getConfigCalls;
            let saveCalls = 0;
            window.__saveCalls = () => saveCalls;
            window.__saveSucceeds = true;

            const listeners: Array<(event: unknown) => void> = [];
            window.__fireDataChanged = (kind: string) => {
                for (const listener of listeners) {
                    listener({ event_type: "helman_data_changed", data: { kind } });
                }
            };

            const element = document.createElement(
                "helman-config-editor-panel",
            ) as HTMLElement & Record<string, unknown>;
            element.hass = {
                language: "en",
                locale: { language: "en" },
                user: { is_admin: true },
                connection: {
                    subscribeEvents: async (
                        listener: (event: unknown) => void,
                        eventType: string,
                    ) => {
                        if (eventType !== "helman_data_changed") {
                            return () => undefined;
                        }
                        listeners.push(listener);
                        return () => {
                            listeners.splice(listeners.indexOf(listener), 1);
                        };
                    },
                },
                callWS: async (request: { type: string; config?: unknown }) => {
                    if (request.type === "helman/get_config") {
                        getConfigCalls += 1;
                        return JSON.parse(JSON.stringify(stored));
                    }
                    if (request.type === "helman/get_optimizer_schema") return schema;
                    if (request.type === "helman/get_appliances") return { appliances: [] };
                    if (request.type === "helman/save_config") {
                        saveCalls += 1;
                        const succeeded = window.__saveSucceeds;
                        if (succeeded) {
                            stored = request.config;
                        }
                        // As the backend does: a successful save reloads the
                        // entry and announces it, so the saver hears its own
                        // write come back.
                        queueMicrotask(() => {
                            if (succeeded) {
                                window.__fireDataChanged("config");
                            }
                        });
                        return {
                            success: succeeded,
                            validation: { valid: true, errors: [], warnings: [] },
                            reloadStarted: true,
                            reloadSucceeded: succeeded,
                            reloadError: null,
                        };
                    }
                    return {};
                },
            };
            document.body.appendChild(element);
        },
        { schema: SCHEMA, config: STORED_CONFIG },
    );

    const panel = page.locator("helman-config-editor-panel");
    await expect.poll(() => page.evaluate(() => window.__getConfigCalls())).toBe(1);
    return panel;
}

/** The status badges the editor is currently showing. */
function readBadges(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const editor = document
            .querySelector("helman-config-editor-panel")
            ?.shadowRoot?.querySelector(".status-row");
        return Array.from(editor?.querySelectorAll(".badge") ?? []).map(
            (badge) => badge.textContent?.trim() ?? "",
        );
    });
}

/** Type into the General tab's forecast-days field, making the editor dirty. */
async function makeDirty(page: Page): Promise<void> {
    await page.evaluate(() => {
        const editor = document.querySelector("helman-config-editor-panel") as
            | (HTMLElement & { _dirty?: boolean; requestUpdate?: () => void })
            | null;
        // The dirty flag is what every guard in the editor reads; setting it
        // directly is the same state a keystroke in any field produces, without
        // depending on which fields this schema happens to render.
        if (editor) {
            editor._dirty = true;
            editor.requestUpdate?.();
        }
    });
    await expect.poll(() => readBadges(page)).toContain("Unsaved changes");
}

test("a clean editor picks up a config saved elsewhere", async ({ page }) => {
    await mountEditor(page);
    expect(await readBadges(page)).toContain("Stored config loaded");

    await page.evaluate((config) => window.__setStoredConfig(config), CHANGED_CONFIG);
    await page.evaluate(() => window.__fireDataChanged("config"));

    await expect.poll(() => page.evaluate(() => window.__getConfigCalls())).toBe(2);
    expect(await readBadges(page)).not.toContain(
        "The stored config changed elsewhere — reload to see it",
    );
});

test("a dirty editor keeps its draft and says the config moved", async ({ page }) => {
    await mountEditor(page);
    await makeDirty(page);

    await page.evaluate((config) => window.__setStoredConfig(config), CHANGED_CONFIG);
    await page.evaluate(() => window.__fireDataChanged("config"));

    await expect
        .poll(() => readBadges(page))
        .toContain("The stored config changed elsewhere — reload to see it");

    // The draft is untouched: nothing was re-read over it.
    expect(await page.evaluate(() => window.__getConfigCalls())).toBe(1);
    expect(await readBadges(page)).toContain("Unsaved changes");
});

test("the machine that saved hears its own write and ignores it", async ({ page }) => {
    await mountEditor(page);
    await makeDirty(page);

    await page.evaluate(() => {
        const button = Array.from(
            document
                .querySelector("helman-config-editor-panel")
                ?.shadowRoot?.querySelectorAll("button") ?? [],
        ).find((candidate) => /save/i.test(candidate.textContent ?? ""));
        (button as HTMLButtonElement | undefined)?.click();
    });

    // The save really happened — otherwise the rest of this proves nothing.
    await expect.poll(() => page.evaluate(() => window.__saveCalls())).toBe(1);
    await expect.poll(() => readBadges(page)).toContain("Stored config loaded");

    // The save's own announcement caused neither a re-read nor a warning.
    expect(await page.evaluate(() => window.__getConfigCalls())).toBe(1);
    expect(await readBadges(page)).not.toContain(
        "The stored config changed elsewhere — reload to see it",
    );
});
