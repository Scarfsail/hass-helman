import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The two bundles have to survive being on the same page.
 *
 * Home Assistant loads `helman-card.js` for the dashboard and
 * `helman-config-editor.js` for the panel, and both end up in one document.
 * `cards/shared` is compiled into *both*, so anything there that registers a
 * custom element registers it twice — and the second `customElements.define`
 * throws an uncaught `DOMException`, which aborts the remainder of that
 * bundle's module evaluation. Anything that bundle had not registered yet stays
 * unregistered, and how much that is depends on where in the module graph the
 * shared element happens to sit.
 *
 * So the assertion is not "no error" alone but "every tag is still there", and
 * both load orders are exercised: which bundle throws depends on which one got
 * to the shared tag first.
 */

const CARD_BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);
const EDITOR_BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-config-editor.js",
);

/** Elements each bundle must still register with the other one present. */
const CARD_TAGS = [
    "helman-solar-inspector",
    "scheduling-explanation-panel",
    "helman-optimizer-edit-dialog",
];
const EDITOR_TAGS = [
    "helman-config-editor-panel",
    "helman-bias-correction-status",
    "helman-entity-group",
];
const SHARED_TAGS = ["helman-optimizer-editor"];

async function loadBoth(page: Page, order: readonly string[]): Promise<string[]> {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.setContent("<!doctype html><html><body></body></html>");
    for (const bundle of order) {
        await page.addScriptTag({ path: bundle, type: "module" });
    }
    return errors;
}

async function defined(page: Page, tags: readonly string[]): Promise<string[]> {
    return page.evaluate(
        (names) => names.filter((name) => !!customElements.get(name)),
        tags as string[],
    );
}

for (const [label, order] of [
    ["card first", [CARD_BUNDLE, EDITOR_BUNDLE]],
    ["editor first", [EDITOR_BUNDLE, CARD_BUNDLE]],
] as const) {
    test(`both bundles load together, ${label}`, async ({ page }) => {
        const errors = await loadBoth(page, order);

        // A duplicate `define` surfaces here first, as an uncaught DOMException.
        expect(errors).toEqual([]);

        const all = [...CARD_TAGS, ...EDITOR_TAGS, ...SHARED_TAGS];
        // Every tag, not just the shared one: the point of the guard is that the
        // throw no longer cuts a bundle's registration short partway through.
        expect(await defined(page, all)).toEqual(all);
    });
}
