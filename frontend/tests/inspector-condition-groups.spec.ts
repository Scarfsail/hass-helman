import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Regression guard for the inspector's derived cells under ORed condition groups.
 *
 * `export_price` declares its rejected slots *derivable*: rather than emitting a
 * decision per slot, it leaves the frontend to explain "price not below
 * threshold" from the exportPrice rail. That worked while there was exactly one
 * threshold per step, which the model scraped off an emitted decision.
 *
 * With OR groups there is no single threshold. A slot is eligible when *any*
 * group accepts it, so the model must test against the loosest group — and the
 * backend now ships every group's value on the step, including groups that
 * placed nothing. Get this wrong and a derived cell claims "rejected: price not
 * below threshold" for a slot a looser group would have taken, contradicting the
 * emitted decisions. The coverage validator cannot catch it, because those slots
 * are explicitly declared derivable.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const SLOTS = [
    "2026-07-20T10:00:00+02:00",
    "2026-07-20T10:30:00+02:00",
    "2026-07-20T11:00:00+02:00",
];

/** Load a bare page with the card bundle so its custom elements are registered. */
async function loadCardBundle(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-automation-inspector"));
}

/**
 * Mount the inspector over a two-group `export_price` step.
 *
 * Prices are -1.0 / 0.5 / 5.0 against thresholds 0.0 (group #1) and 1.0
 * ("Cheap hours"). Slot 0 clears both and is applied by group #1; slot 1 clears
 * only the looser group; slot 2 clears neither. Only slot 0 carries an emitted
 * decision — the other two are derived.
 */
async function mountInspector(page: Page, conditionGroups: unknown): Promise<void> {
    await page.evaluate(
        ({ slots, groups }) => {
            const trace = {
                slotIds: slots,
                staticRails: { exportPrice: [-1.0, 0.5, 5.0], importPrice: [3, 3, 3] },
                railsFinal: {},
                steps: [
                    {
                        optimizerId: "avoid-negative-export",
                        kind: "export_price",
                        status: "ok",
                        complete: true,
                        railsIn: {},
                        writes: [],
                        notes: [],
                        decisions: [
                            {
                                slotIds: [slots[0]],
                                outcome: "applied",
                                action: { domain: "inverter", kind: "stop_export" },
                                reason: {
                                    code: "price_below_threshold",
                                    params: { threshold: 0.0, matchedGroup: "#1" },
                                },
                            },
                        ],
                        ...(groups ? { conditionGroups: groups } : {}),
                    },
                ],
            };
            const element = document.createElement("helman-automation-inspector") as any;
            element.hass = {
                language: "en",
                locale: { language: "en" },
                callWS: async () => ({
                    ranAutomation: true,
                    snapshot: null,
                    dayContexts: [],
                    optimizers: [],
                    durationMs: 12,
                    trace,
                }),
            };
            document.body.appendChild(element);
        },
        { slots: SLOTS, groups: conditionGroups },
    );
    // Show every slot, not just the ones with activity — the derived cells are
    // out_of_scope and hidden by the default filter.
    const filter = page.locator("helman-automation-inspector .filter input");
    await filter.waitFor();
    await filter.uncheck();
}

/** The reason code the popover shows for one step column of a slot row. */
async function reasonCodeAt(page: Page, slotIndex: number): Promise<string> {
    // An open popover covers the matrix with a backdrop, so close it first —
    // otherwise the second call in a test clicks the backdrop, not a cell.
    const backdrop = page.locator("helman-automation-inspector .popover-backdrop");
    if (await backdrop.count()) await backdrop.click({ position: { x: 4, y: 4 } });
    const row = page.locator("helman-automation-inspector tbody tr:not(.day-header)");
    await row.nth(slotIndex).locator("td.cell").first().click();
    return page.locator("helman-automation-inspector .reason-code").innerText();
}

const TWO_GROUPS = [
    { index: 0, label: "#1", values: { when_price_below: 0.0 }, customMet: true },
    {
        index: 1,
        label: "Cheap hours",
        values: { when_price_below: 1.0 },
        customMet: true,
    },
];

test.describe("inspector derivation under ORed condition groups", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    test("a slot only the looser group accepts is not called rejected", async ({
        page,
    }) => {
        await mountInspector(page, TWO_GROUPS);

        // 0.5 clears "Cheap hours" (< 1.0) even though it fails group #1.
        expect(await reasonCodeAt(page, 1)).not.toBe("price_not_below_threshold");
    });

    test("a slot no group accepts is still rejected, against the loosest threshold", async ({
        page,
    }) => {
        await mountInspector(page, TWO_GROUPS);

        expect(await reasonCodeAt(page, 2)).toBe("price_not_below_threshold");
        await expect(
            page.locator("helman-automation-inspector .reason-detail"),
        ).toContainText("1");
    });

    test("the emitted decision still wins over any derivation", async ({ page }) => {
        await mountInspector(page, TWO_GROUPS);

        expect(await reasonCodeAt(page, 0)).toBe("price_below_threshold");
    });

    test("a trace without conditionGroups falls back to scraping the emitted threshold", async ({
        page,
    }) => {
        // Traces recorded before groups existed carry no `conditionGroups`; the
        // single emitted threshold must still explain the rejected slots.
        await mountInspector(page, null);

        expect(await reasonCodeAt(page, 1)).toBe("price_not_below_threshold");
        expect(await reasonCodeAt(page, 2)).toBe("price_not_below_threshold");
    });
});
