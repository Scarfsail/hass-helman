import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Level 1 of the lane explanation: slots down, optimizers across, Result last.
 *
 * The distinctions worth pinning are the ones the record exists to make and
 * that a naive table would flatten:
 *
 * - **A verdict is not an outcome.** Writing is last-writer-wins among
 *   optimizers, so `execute` in a column that lost the slot has to read
 *   `overwritten`, and Result has to name who actually landed the write.
 * - **A skipped step is not "every slot false".** It greys its whole column and
 *   says why.
 * - **`not_evaluated`, `false` and absent are three states, not two.** A node
 *   that was never consulted is not a node that failed, and neither is a slot
 *   the optimizer never looked at.
 * - **The layout does not adapt.** An appliance lane with one optimizer is the
 *   same table with one column.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const DATE = "2026-07-31";
const RUN_AT = `${DATE}T20:15:00+02:00`;
const SLOT_IDS = [
    `${DATE}T13:00:00+02:00`,
    `${DATE}T13:30:00+02:00`,
    `${DATE}T14:00:00+02:00`,
    `${DATE}T14:30:00+02:00`,
    `${DATE}T15:00:00+02:00`,
];

/**
 * The inverter lane as three pipeline steps over five half-hour slots.
 *
 * 13:00 charge_hold holds and keeps it. 13:30 charge_hold would write and the
 * user owns the slot. 14:00 both charge_hold and export_price decide execute
 * and export_price, being later in pipeline order, takes it. 14:30 export_price
 * fails on price and charge_hold's SoC node was never consulted. 15:00
 * export_price said nothing at all. charge_from_grid never ran.
 */
const INVERTER_PAYLOAD = {
    targetKey: "inverter",
    date: DATE,
    slotIds: SLOT_IDS,
    runAt: RUN_AT,
    optimizers: [
        {
            optimizerId: "export_price",
            kind: "export_price",
            targetKey: "inverter",
            status: "ok",
            runAt: [[RUN_AT, 5]],
            verdict: [["skip", 2], ["execute", 1], ["skip", 1], [null, 1]],
            winningOptimizer: { "2": "export_price" },
            groups: [{
                index: 0,
                label: "",
                paramsSource: [["slot_matched", 4], [null, 1]],
                params: [[{ min_export_price: 1.0 }, 4], [null, 1]],
                conditions: [{
                    key: "when_price_below",
                    scope: "slot",
                    state: [["false", 2], ["true", 1], ["false", 1], [null, 1]],
                    value: [[1.0, 4], [null, 1]],
                    actual: { "0": 1.2, "1": 1.1, "3": 0.9 },
                }],
            }],
            gates: [{ key: "stop_export_supported", state: [["true", 4], [null, 1]] }],
        },
        {
            optimizerId: "charge_hold",
            kind: "charge_hold",
            targetKey: "inverter",
            status: "ok",
            runAt: [[RUN_AT, 5]],
            verdict: [["execute", 3], ["skip", 2]],
            winningOptimizer: { "0": "charge_hold", "2": "export_price" },
            groups: [{
                index: 0,
                label: "",
                paramsSource: [["slot_matched", 5]],
                conditions: [{
                    key: "min_soc_pct",
                    scope: "slot",
                    // Never consulted past the hold window: not false.
                    state: [["true", 3], ["not_evaluated", 2]],
                    value: [[40, 5]],
                }],
            }],
            gates: [
                // Unreached past 14:00: absent, never false.
                { key: "hold_window", state: [["true", 3], [null, 2]] },
                { key: "blocked_user_owned", state: [[null, 1], ["false", 1], ["true", 1], [null, 2]] },
            ],
        },
        {
            optimizerId: "charge_from_grid",
            kind: "charge_from_grid",
            targetKey: "inverter",
            status: "skipped",
            statusReason: "battery_params_missing",
            runAt: [[RUN_AT, 5]],
            verdict: [[null, 5]],
        },
    ],
};

/** One appliance, one optimizer: the same table, one column narrower. */
const APPLIANCE_PAYLOAD = {
    targetKey: "appliance:boiler",
    date: DATE,
    slotIds: SLOT_IDS.slice(0, 2),
    runAt: RUN_AT,
    optimizers: [{
        optimizerId: "appliance_runtime:boiler",
        kind: "appliance_runtime",
        targetKey: "appliance:boiler",
        status: "ok",
        runAt: [[RUN_AT, 2]],
        verdict: [["execute", 1], ["skip", 1]],
        winningOptimizer: { "0": "appliance_runtime:boiler" },
        groups: [{
            index: 0,
            label: "",
            paramsSource: [["slot_matched", 2]],
            conditions: [{
                key: "max_run_price",
                scope: "slot",
                state: [["true", 1], ["false", 1]],
                actual: { "1": 3.4 },
            }],
        }],
        gates: [{ key: "cheapest_rank", state: [["true", 1], ["false", 1]], params: [[{ rank: 1 }, 1], [{ rank: 9 }, 1]] }],
    }],
};

async function mountDialog(page: Page, payload: unknown): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("scheduling-explanation-dialog"));

    await page.evaluate((fixture) => {
        const dialog = document.createElement("scheduling-explanation-dialog") as HTMLElement & Record<string, unknown>;
        dialog.localize = (key: string) => key;
        dialog.payload = fixture;
        dialog.laneName = "Střídač";
        dialog.locale = "cs";
        dialog.timeZone = "Europe/Prague";
        dialog.open = true;
        (window as unknown as Record<string, unknown>).__cellSelects = [];
        dialog.addEventListener("schedule-explanation-cell-select", (event: Event) => {
            ((window as unknown as Record<string, unknown>).__cellSelects as unknown[])
                .push((event as CustomEvent).detail);
        });
        document.body.appendChild(dialog);
    }, payload);

    await page.waitForFunction(
        () => !!document.querySelector("scheduling-explanation-dialog")?.shadowRoot?.querySelector("table.grid"),
    );
}

/** One cell of the grid, addressed the way the model addresses it. */
function cell(page: Page, rowIndex: number, optimizerId: string) {
    return page
        .locator("scheduling-explanation-dialog")
        .locator(`tbody tr[data-row="${rowIndex}"] td[data-optimizer="${optimizerId}"]`);
}

test.describe("lane explanation, level 1", () => {
    test("a row per slot, a column per optimizer, and Result last", async ({ page }) => {
        await mountDialog(page, INVERTER_PAYLOAD);

        const dialog = page.locator("scheduling-explanation-dialog");
        await expect(dialog.locator("tbody tr")).toHaveCount(5);
        // Time + three optimizers + Result.
        await expect(dialog.locator("thead th")).toHaveCount(5);
        await expect(dialog.locator("thead th").nth(4)).toHaveText(/result_column/);

        // Pipeline order is the payload's order, never re-sorted.
        const heads = await dialog.locator("thead th.optimizer-head").evaluateAll(
            (nodes) => nodes.map((node) => node.getAttribute("data-optimizer")),
        );
        expect(heads).toEqual(["export_price", "charge_hold", "charge_from_grid"]);

        // Rows are half-hour slots, in local time.
        await expect(dialog.locator('tbody tr[data-row="0"] .time-cell')).toHaveText(/13:00/);
        await expect(dialog.locator('tbody tr[data-row="1"] .time-cell')).toHaveText(/13:30/);
    });

    test("Result names the optimizer that landed the write", async ({ page }) => {
        await mountDialog(page, INVERTER_PAYLOAD);

        const dialog = page.locator("scheduling-explanation-dialog");
        await expect(dialog.locator('tbody tr[data-row="0"] .result-cell'))
            .toHaveAttribute("data-winner", "charge_hold");
        await expect(dialog.locator('tbody tr[data-row="2"] .result-cell'))
            .toHaveAttribute("data-winner", "export_price");
        // Nothing landed: not the same as "the last optimizer won".
        await expect(dialog.locator('tbody tr[data-row="3"] .result-cell')).toHaveClass(/empty/);
    });

    test("the loser of a slot two optimizers wrote reads overwritten", async ({ page }) => {
        await mountDialog(page, INVERTER_PAYLOAD);

        // 14:00: charge_hold decided execute and wrote, export_price came later.
        await expect(cell(page, 2, "charge_hold")).toHaveAttribute("data-outcome", "overwritten");
        await expect(cell(page, 2, "charge_hold")).toContainText("⤫");
        await expect(cell(page, 2, "export_price")).toHaveAttribute("data-outcome", "wrote");
    });

    test("a slot the user owns reads blocked, not rejected", async ({ page }) => {
        await mountDialog(page, INVERTER_PAYLOAD);

        const blocked = cell(page, 1, "charge_hold");
        await expect(blocked).toHaveAttribute("data-outcome", "blocked");
        await expect(blocked).toContainText("⛨");
    });

    test("a rejected slot names the condition that rejected it", async ({ page }) => {
        await mountDialog(page, INVERTER_PAYLOAD);

        const rejected = cell(page, 3, "export_price");
        await expect(rejected).toHaveAttribute("data-outcome", "not_eligible");
        await expect(rejected).toHaveAttribute("data-condition", "when_price_below");
        await expect(rejected).toContainText("when_price_below");
    });

    test("a skipped step greys its whole column and says why", async ({ page }) => {
        await mountDialog(page, INVERTER_PAYLOAD);

        const head = page
            .locator("scheduling-explanation-dialog")
            .locator('thead th[data-optimizer="charge_from_grid"]');
        await expect(head).toHaveClass(/inactive/);
        await expect(head).toContainText("battery_params_missing");
        expect(await head.evaluate((node) => Number(getComputedStyle(node).opacity)))
            .toBeLessThan(1);

        // Every slot of it reads "the step never ran", not "false".
        const outcomes = await page
            .locator("scheduling-explanation-dialog")
            .locator('td[data-optimizer="charge_from_grid"]')
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-outcome")));
        expect(outcomes).toEqual(Array(5).fill("step_skipped"));
    });

    test("not evaluated, false and absent stay three different things", async ({ page }) => {
        await mountDialog(page, INVERTER_PAYLOAD);

        // 14:30: export_price failed on price; charge_hold never consulted its
        // SoC node because the hold window had already closed.
        const failed = cell(page, 3, "export_price");
        const unevaluated = cell(page, 3, "charge_hold");
        await expect(failed).toHaveAttribute("data-condition-state", "false");
        await expect(unevaluated).toHaveAttribute("data-condition-state", "not_evaluated");
        await expect(unevaluated).toContainText("state.not_evaluated");

        // 15:00: export_price said nothing at all -- neither false nor
        // unevaluated, and not drillable.
        const absent = cell(page, 4, "export_price");
        await expect(absent).toHaveAttribute("data-outcome", "absent");
        await expect(absent.locator(".cell-body")).toHaveCount(0);

        const glyphs = await Promise.all([
            failed.locator(".glyph").innerText(),
            unevaluated.locator(".glyph").innerText(),
            absent.locator(".glyph").innerText(),
        ]);
        const colours = await Promise.all([
            failed.locator(".glyph").evaluate((node) => getComputedStyle(node).color),
            unevaluated.locator(".glyph").evaluate((node) => getComputedStyle(node).color),
        ]);
        // Same rejection, different reason: the marks differ from absent, and
        // the two rejections differ from each other by colour.
        expect(glyphs[0]).not.toBe(glyphs[2]);
        expect(glyphs[1]).not.toBe(glyphs[2]);
        expect(colours[0]).not.toBe(colours[1]);
    });

    test("a cell hands the slot and the optimizer to the level-2 drill", async ({ page }) => {
        await mountDialog(page, INVERTER_PAYLOAD);

        await cell(page, 2, "export_price").locator(".cell-body").click();
        const selects = await page.evaluate(
            () => (window as unknown as Record<string, unknown>).__cellSelects as Record<string, unknown>[],
        );
        expect(selects).toHaveLength(1);
        expect(selects[0]).toMatchObject({
            targetKey: "inverter",
            date: DATE,
            optimizerId: "export_price",
            slotId: SLOT_IDS[2],
            rowIndex: 2,
        });
    });

    test("an appliance lane with one optimizer is the same table", async ({ page }) => {
        await mountDialog(page, APPLIANCE_PAYLOAD);

        const dialog = page.locator("scheduling-explanation-dialog");
        // Time + one optimizer + Result: no adaptive layout, just fewer columns.
        await expect(dialog.locator("thead th")).toHaveCount(3);
        await expect(dialog.locator("thead th").nth(2)).toHaveText(/result_column/);
        await expect(dialog.locator("tbody tr")).toHaveCount(2);
        await expect(dialog.locator('tbody tr[data-row="0"] .result-cell'))
            .toHaveAttribute("data-winner", "appliance_runtime:boiler");
        await expect(cell(page, 1, "appliance_runtime:boiler"))
            .toHaveAttribute("data-outcome", "not_eligible");
    });

    test("nothing recorded says so rather than drawing an empty grid", async ({ page }) => {
        await page.setContent("<!doctype html><html><body></body></html>");
        await page.addScriptTag({ path: BUNDLE, type: "module" });
        await page.waitForFunction(() => !!customElements.get("scheduling-explanation-dialog"));
        await page.evaluate(() => {
            const dialog = document.createElement("scheduling-explanation-dialog") as HTMLElement & Record<string, unknown>;
            dialog.localize = (key: string) => key;
            // The backend's own answer for "nothing is recorded for this lane".
            dialog.payload = null;
            dialog.open = true;
            document.body.appendChild(dialog);
        });

        const dialog = page.locator("scheduling-explanation-dialog");
        await expect(dialog.locator(".placeholder.empty")).toHaveText(/empty/);
        await expect(dialog.locator("table.grid")).toHaveCount(0);
    });
});
