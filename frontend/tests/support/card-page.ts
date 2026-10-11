import { expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The built bundles the specs mount, and the one way to mount them.
 *
 * `global-setup.ts` rebuilds both before the suite runs, so these paths always
 * point at the current source.
 */
const COMPILED = resolve(__dirname, "../../../custom_components/helman/frontend_compiled");

/** The Lovelace card bundle. */
export const CARD_BUNDLE = resolve(COMPILED, "helman-card.js");

/** The config editor panel bundle. */
export const EDITOR_BUNDLE = resolve(COMPILED, "helman-config-editor.js");

/**
 * Load a bundle into a bare page and wait until `element` is defined.
 *
 * Clocks are the caller's: a spec that freezes time does so before this. The
 * wait polls from Node, so it also works under faked page timers.
 */
export async function loadBundle(page: Page, element: string, bundle = CARD_BUNDLE): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: bundle, type: "module" });
    await expect.poll(() => page.evaluate((tag) => !!customElements.get(tag), element)).toBe(true);
}
