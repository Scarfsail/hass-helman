import { configDoc } from "./support/payload-builders";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { EDITOR_BUNDLE, loadBundle } from "./support/card-page";

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
 *
 * Which of the three it is cannot be read off the announcement: the event says
 * something moved, never what or who moved it, and one `save_config` fires
 * several as the entry reload it starts re-plans. So the editor reads the
 * document and compares it. That comparison read is why the call counts below
 * are one higher than the reloads they describe.
 */

const SCHEMA = { version: 2, kinds: [] };

/** What the fake backend has stored. Swapped to stand in for another machine. */
const STORED_CONFIG = configDoc({  forecast_days: 3 });
const CHANGED_CONFIG = configDoc({  forecast_days: 5 });

declare global {
    interface Window {
        /** Replace what `helman/get_config` returns from now on. */
        __setStoredConfig: (config: unknown) => void;
        __getConfigCalls: () => number;
        __saveCalls: () => number;
        __fireDataChanged: (kind: string, revision?: string) => void;
        /** Whether `helman/save_config` should report a successful reload. */
        __saveSucceeds: boolean;
        __saveValid: boolean;
        __saveConflicts: boolean;
        __holdSave: boolean;
        __releaseSave: () => void;
    }
}

async function mountEditor(page: Page): Promise<Locator> {
    await loadBundle(page, "helman-config-editor-panel", EDITOR_BUNDLE);

    await page.evaluate(
        ({ schema, config }) => {
            let stored: unknown = JSON.parse(config);
            let getConfigCalls = 0;
            window.__setStoredConfig = (next: unknown) => {
                stored = next;
            };
            window.__getConfigCalls = () => getConfigCalls;
            let saveCalls = 0;
            window.__saveCalls = () => saveCalls;
            window.__saveSucceeds = true;
            window.__saveValid = true;
            window.__saveConflicts = false;
            window.__holdSave = false;
            let releaseSave: (() => void) | undefined;
            window.__releaseSave = () => releaseSave?.();

            const listeners: Array<(event: unknown) => void> = [];
            window.__fireDataChanged = (kind: string, revision?: string) => {
                for (const listener of listeners) {
                    listener({ kind, revision });
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
                    subscribeMessage: async (
                        listener: (message: unknown) => void,
                        request: { type: string },
                    ) => {
                        if (request.type !== "helman/subscribe_updates") {
                            return () => undefined;
                        }
                        listeners.push(listener);
                        return () => {
                            listeners.splice(listeners.indexOf(listener), 1);
                        };
                    },
                },
                callWS: window.__mockHass({
                    "helman/get_config": async (request: {
                        type: string;
                        config?: unknown;
                    }) => {
                        getConfigCalls += 1;
                        return JSON.parse(JSON.stringify(stored));
                    },
                    "helman/get_optimizer_schema": async (request: {
                        type: string;
                        config?: unknown;
                    }) => {
                        return schema;
                    },
                    "helman/save_config": async (request: {
                        type: string;
                        config?: unknown;
                    }) => {
                        saveCalls += 1;
                        if (window.__holdSave) await new Promise<void>((resolve) => { releaseSave = resolve; });
                        if (window.__saveConflicts) return {
                            success: false, conflict: true, config: stored,
                            revision: window.__configRevision(stored),
                        };
                        const succeeded = window.__saveSucceeds;
                        const valid = window.__saveValid;
                        if (valid) {
                            stored = { ...(request.config as Record<string, unknown>), config_version: 29 };
                            queueMicrotask(() => {
                                window.__fireDataChanged("config", JSON.stringify(stored));
                            });
                        }
                        return {
                            success: valid && succeeded,
                            validation: { valid, errors: [], warnings: [] },
                            reloadStarted: true,
                            reloadSucceeded: succeeded,
                            reloadError: null,
                        };
                    }
                }).callWS,
            };
            document.body.appendChild(element);
        },
        { schema: SCHEMA, config: JSON.stringify(STORED_CONFIG) },
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

    await page.evaluate((config) => window.__setStoredConfig(JSON.parse(config)), JSON.stringify(CHANGED_CONFIG));
    await page.evaluate((config) => window.__fireDataChanged("config", config), JSON.stringify(CHANGED_CONFIG));

    await expect.poll(() => page.evaluate(() => window.__getConfigCalls())).toBe(2);
    expect(await readBadges(page)).not.toContain(
        "The stored config changed elsewhere — reload to see it",
    );
});

test("an announcement that moved nothing is not acted on at all", async ({ page }) => {
    // A re-plan and a retrained bias profile are announced on the same feed and
    // touch nothing this editor holds. Reloading the page under the user for
    // those would be the auto-refresh making itself felt for no reason.
    await mountEditor(page);

    await page.evaluate(() => window.__fireDataChanged("plan"));

    await expect.poll(() => page.evaluate(() => window.__getConfigCalls())).toBe(1);
    expect(await readBadges(page)).toContain("Stored config loaded");
    expect(await readBadges(page)).not.toContain(
        "The stored config changed elsewhere — reload to see it",
    );
});

test("a dirty editor keeps its draft and says the config moved", async ({ page }) => {
    await mountEditor(page);
    await makeDirty(page);

    await page.evaluate((config) => window.__setStoredConfig(JSON.parse(config)), JSON.stringify(CHANGED_CONFIG));
    await page.evaluate((config) => window.__fireDataChanged("config", config), JSON.stringify(CHANGED_CONFIG));

    await expect
        .poll(() => readBadges(page))
        .toContain("The stored config changed elsewhere — reload to see it");

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

    // Past the feed's collapse window, so the announcement has definitely been
    // delivered rather than merely fired.
    await page.waitForTimeout(600);

    expect(await page.evaluate(() => window.__getConfigCalls())).toBe(1);
    expect(await readBadges(page)).not.toContain(
        "The stored config changed elsewhere — reload to see it",
    );
    expect(await readBadges(page)).not.toContain("Unsaved changes");
});

test("a landed save whose reload failed does not report its own write as an external change", async ({ page }) => {
    await mountEditor(page);
    await makeDirty(page);
    await page.evaluate(() => { window.__saveSucceeds = false; });
    await page.evaluate(() => {
        const button = Array.from(document.querySelector("helman-config-editor-panel")?.shadowRoot?.querySelectorAll("button") ?? [])
            .find((candidate) => /save/i.test(candidate.textContent ?? ""));
        (button as HTMLButtonElement | undefined)?.click();
    });
    await expect.poll(() => page.evaluate(() => window.__saveCalls())).toBe(1);
    await page.waitForTimeout(600);
    expect(await readBadges(page)).not.toContain("The stored config changed elsewhere — reload to see it");
    expect(await readBadges(page)).not.toContain("Unsaved changes");
    const prompts: string[] = [];
    page.on("dialog", (dialog) => {
        prompts.push(dialog.message());
        void dialog.dismiss();
    });
    await page.locator("helman-config-editor-panel").getByRole("button", { name: "Reload stored config" }).click();
    await expect.poll(() => page.evaluate(() => window.__getConfigCalls())).toBe(2);
    expect(prompts).toEqual([]);
});

test("a rejected save keeps the unsaved draft dirty", async ({ page }) => {
    await mountEditor(page);
    await makeDirty(page);
    await page.evaluate(() => { window.__saveValid = false; });
    await page.evaluate(() => {
        const button = Array.from(document.querySelector("helman-config-editor-panel")?.shadowRoot?.querySelectorAll("button") ?? [])
            .find((candidate) => /save/i.test(candidate.textContent ?? ""));
        (button as HTMLButtonElement | undefined)?.click();
    });
    await expect.poll(() => page.evaluate(() => window.__saveCalls())).toBe(1);
    await expect.poll(() => readBadges(page)).toContain("Unsaved changes");
});

test("the editor reports an atomic save conflict and keeps the draft", async ({ page }) => {
    await mountEditor(page);
    await makeDirty(page);
    await page.evaluate(() => { window.__saveConflicts = true; });
    await page.locator("helman-config-editor-panel").getByRole("button", { name: "Save and reload" }).click();
    await expect.poll(() => readBadges(page)).toContain("The stored config changed elsewhere — reload to see it");
    expect(await readBadges(page)).toContain("Unsaved changes");
    expect(await page.evaluate(() => window.__getConfigCalls())).toBe(1);
});

test("the editor refuses tab close while a save is pending", async ({ page }) => {
    await mountEditor(page);
    await page.evaluate(() => { window.__holdSave = true; });
    await page.locator("helman-config-editor-panel").getByRole("button", { name: "Save and reload" }).click();
    await expect.poll(() => page.evaluate(() => window.__saveCalls())).toBe(1);
    const blocked = await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
    });
    expect(blocked).toBe(true);
    await page.evaluate(() => window.__releaseSave());
});

for (const reloadSucceeds of [true, false]) for (const editDuringSave of [true, false]) {
    test(`a newer revision during a ${reloadSucceeds ? "successful" : "failed reload"} save ${editDuringSave ? "warns over a new draft" : "reloads the clean editor"}`, async ({ page }) => {
        await mountEditor(page);
        await makeDirty(page);
        await page.evaluate(({ newer, success }) => {
            const host = document.querySelector("helman-config-editor-panel") as any;
            const callWS = host.hass.callWS;
            host.hass = { ...host.hass, callWS: async (request: any) => {
                if (request.type !== "helman/save_config") return callWS(request);
                const config = { ...request.config, config_version: 29 };
                const response = { success, config, revision: window.__configRevision(config), validation: { valid: true, errors: [], warnings: [] } };
                await new Promise<void>((resolve) => { window.__releaseSave = resolve; });
                return response;
            } };
            window.__setStoredConfig(JSON.parse(newer));
        }, { newer: JSON.stringify(CHANGED_CONFIG), success: reloadSucceeds });
        await page.locator("helman-config-editor-panel").getByRole("button", { name: "Save and reload" }).click();
        if (editDuringSave) await page.evaluate(() => {
            const host = document.querySelector("helman-config-editor-panel") as any;
            host._config = { ...host._config, forecast_days: 99 };
            host._dirty = true;
            host.requestUpdate();
        });
        await page.evaluate(() => window.__fireDataChanged("config", "newer-revision"));
        await page.waitForTimeout(600);
        expect(await page.evaluate(() => window.__getConfigCalls())).toBe(1);
        await page.evaluate(() => window.__releaseSave());
        if (editDuringSave) {
            await expect.poll(() => readBadges(page)).toContain("The stored config changed elsewhere — reload to see it");
            expect(await readBadges(page)).toContain("Unsaved changes");
            expect(await page.evaluate(() => window.__getConfigCalls())).toBe(1);
        } else {
            await expect.poll(() => page.evaluate(() => window.__getConfigCalls())).toBe(2);
            expect(await readBadges(page)).not.toContain("Unsaved changes");
        }
    });
}
