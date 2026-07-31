import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";

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
 * - **A candidate is not a run.** Result reports the winning cell's *verdict*,
 *   so a slot that is merely placed never reads as the optimizer's action.
 * - **Result is dropped for a single-optimizer lane**, where it could only ever
 *   restate the one column beside it. That is the only way the layout adapts.
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
            groups: [
                {
                    index: 0,
                    label: "Ráno",
                    // Resolved once for the day, so possibly from another group.
                    paramsSource: [["day_resolved", 5]],
                    params: [[{ min_soc_pct: 40, target_soc_pct: 80 }, 5]],
                    // Two entries: one plainly false, one that threw.
                    customResults: [[[true, null], 3], [[false, null], 2]],
                    conditions: [
                        {
                            key: "min_soc_pct",
                            scope: "slot",
                            // Never consulted past the hold window: not false.
                            state: [["true", 3], ["not_evaluated", 2]],
                            value: [[40, 5]],
                        },
                        {
                            // Fails only at 15:00, and says what it saw there.
                            key: "hold_room",
                            scope: "slot",
                            state: [["true", 4], ["false", 1]],
                            value: [[5, 5]],
                            actual: { "4": 0.4 },
                        },
                        {
                            // One result for the whole expensive band, not five.
                            key: "reserve_floor_soc",
                            scope: "window",
                            state: [["true", 5]],
                            value: [[20, 5]],
                        },
                    ],
                },
                {
                    index: 1,
                    label: "Večer",
                    paramsSource: [["day_resolved", 5]],
                    params: [[{ min_soc_pct: 60 }, 5]],
                    customResults: [[[true, null], 5]],
                    conditions: [
                        {
                            // This group does not configure it at all.
                            key: "min_soc_pct",
                            scope: "slot",
                            state: [["not_applicable", 5]],
                        },
                        {
                            key: "reserve_floor_soc",
                            scope: "window",
                            state: [["true", 5]],
                            value: [[20, 5]],
                        },
                    ],
                },
            ],
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

/**
 * A lane whose first slot is *placed but not running*.
 *
 * A candidate has every mandatory condition satisfied and a custom condition
 * that is not (yet) true; it is displayed and re-checked at start time. Nothing
 * landed the write, so the row has no winner -- and reporting the optimizer's
 * action there would promise a run that will not happen.
 */
const CANDIDATE_PAYLOAD = {
    targetKey: "appliance:pool",
    date: DATE,
    slotIds: SLOT_IDS.slice(0, 2),
    runAt: RUN_AT,
    optimizers: [
        {
            optimizerId: "appliance_runtime:pool",
            kind: "appliance_runtime",
            targetKey: "appliance:pool",
            status: "ok",
            runAt: [[RUN_AT, 2]],
            verdict: [["candidate", 1], ["execute", 1]],
            winningOptimizer: { "1": "appliance_runtime:pool" },
            groups: [{
                index: 0,
                label: "Studený bazén",
                paramsSource: [["slot_matched", 2]],
                customResults: [[[false], 1], [[true], 1]],
                conditions: [{
                    key: "max_run_price",
                    scope: "slot",
                    state: [["true", 2]],
                    value: [[2.0, 2]],
                }],
            }],
            gates: [{ key: "slot_available", state: [["true", 2]] }],
        },
        {
            optimizerId: "charge_hold",
            kind: "charge_hold",
            targetKey: "appliance:pool",
            status: "ok",
            runAt: [[RUN_AT, 2]],
            verdict: [["skip", 2]],
            groups: [{
                index: 0,
                label: "",
                paramsSource: [["slot_matched", 2]],
                conditions: [{
                    key: "min_soc_pct",
                    scope: "slot",
                    state: [["false", 2]],
                    value: [[40, 2]],
                    actual: { "0": 21, "1": 22 },
                }],
            }],
        },
    ],
};

async function mountDialog(page: Page, payload: unknown): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ content: HA_DIALOG_STUB });
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

    test("a single-optimizer lane drops the Result column", async ({ page }) => {
        await mountDialog(page, APPLIANCE_PAYLOAD);

        const dialog = page.locator("scheduling-explanation-dialog");
        // Time + the one optimizer. With nobody to lose the slot to, Result can
        // only restate the cell beside it, so it is not drawn at all.
        await expect(dialog.locator("thead th")).toHaveCount(2);
        const heads = await dialog.locator("thead th").evaluateAll(
            (nodes) => nodes.map((node) => node.textContent ?? ""),
        );
        expect(heads.join(" ")).not.toContain("result_column");
        await expect(dialog.locator(".result-cell")).toHaveCount(0);
        await expect(dialog.locator("tbody tr")).toHaveCount(2);
        await expect(cell(page, 0, "appliance_runtime:boiler"))
            .toHaveAttribute("data-outcome", "wrote");
        await expect(cell(page, 1, "appliance_runtime:boiler"))
            .toHaveAttribute("data-outcome", "not_eligible");
    });

    test("Result names a candidate as a candidate, not as the action", async ({ page }) => {
        await mountDialog(page, CANDIDATE_PAYLOAD);

        const dialog = page.locator("scheduling-explanation-dialog");
        // 13:00 was placed and its custom conditions were not met: it is on
        // screen and it will not run, so it must not read "zapnout".
        const candidate = dialog.locator('tbody tr[data-row="0"] .result-cell');
        await expect(candidate).toHaveAttribute("data-result", "candidate");
        await expect(candidate).toContainText("outcome.candidate");

        // 13:30 really did run, and still says so -- and the two rows do not
        // read the same, which is the whole bug: they used to.
        const wrote = dialog.locator('tbody tr[data-row="1"] .result-cell');
        await expect(wrote).toHaveAttribute("data-result", "wrote");
        await expect(wrote).toContainText("appliance_runtime");
        await expect(wrote).not.toContainText("outcome.candidate");
        expect((await candidate.innerText()).trim())
            .not.toBe((await wrote.innerText()).trim());
    });

    test("nothing recorded says so rather than drawing an empty grid", async ({ page }) => {
        await page.setContent("<!doctype html><html><body></body></html>");
        await page.addScriptTag({ content: HA_DIALOG_STUB });
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

/** A condition node, spelled out the way the parsed model carries it. */
function node(
    key: string,
    scope: string,
    state: string,
    options: { value?: unknown; actual?: unknown } = {},
) {
    return {
        key,
        scope,
        state,
        value: options.value ?? null,
        actual: options.actual ?? null,
    };
}

/**
 * 15:00 of the inverter lane's `charge_hold`, as the parsed cell.
 *
 * The same slot the level-1 fixture describes, written out rather than decoded:
 * the matrix is mounted on its own now, so it is handed a cell instead of
 * reaching one through the dialog.
 */
const CHARGE_HOLD_CELL = {
    optimizerId: "charge_hold",
    slotId: SLOT_IDS[4],
    rowIndex: 4,
    present: true,
    verdict: "skip",
    runAt: RUN_AT,
    winningOptimizer: null,
    outcome: "not_eligible",
    decisiveKey: "hold_room",
    decisiveState: "false",
    decisiveScope: "slot",
    gates: [],
    groups: [
        {
            index: 0,
            label: "Ráno",
            // Resolved once for the day, so possibly from another group.
            paramsSource: "day_resolved",
            params: { min_soc_pct: 40, target_soc_pct: 80 },
            // Two entries: one plainly false, one that threw.
            customResults: [false, null],
            conditions: [
                // Never consulted past the hold window: not false.
                node("min_soc_pct", "slot", "not_evaluated", { value: 40 }),
                node("hold_room", "slot", "false", { value: 5, actual: 0.4 }),
                // One result for the whole expensive band, not five.
                node("reserve_floor_soc", "window", "true", { value: 20 }),
            ],
        },
        {
            index: 1,
            label: "Večer",
            paramsSource: "day_resolved",
            params: { min_soc_pct: 60 },
            customResults: [true],
            conditions: [
                // This group does not configure it at all.
                node("min_soc_pct", "slot", "not_applicable"),
                node("reserve_floor_soc", "window", "true", { value: 20 }),
            ],
        },
    ],
};

/** 13:30 of the appliance lane: one group, and a gate carrying an ordinal. */
const APPLIANCE_CELL = {
    optimizerId: "appliance_runtime:boiler",
    slotId: SLOT_IDS[1],
    rowIndex: 1,
    present: true,
    verdict: "skip",
    runAt: RUN_AT,
    winningOptimizer: null,
    outcome: "not_eligible",
    decisiveKey: "max_run_price",
    decisiveState: "false",
    decisiveScope: "slot",
    groups: [{
        index: 0,
        label: "",
        paramsSource: "slot_matched",
        params: {},
        customResults: [],
        conditions: [node("max_run_price", "slot", "false", { actual: 3.4 })],
    }],
    gates: [{ key: "cheapest_rank", state: "false", params: { rank: 9 } }],
};

function matrix(page: Page) {
    return page.locator("scheduling-condition-matrix");
}

/**
 * Mount the matrix on its own, with one already-parsed cell.
 *
 * It is no longer mounted by the dialog -- the diagram says everything it said,
 * without the second hop -- so it is exercised directly. The component and this
 * coverage stay because the level-2 view may well come back, and its parse is
 * what the diagram reuses.
 */
async function mountMatrix(
    page: Page,
    cellFixture: unknown,
    conditionKeys: string[],
): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("scheduling-condition-matrix"));

    await page.evaluate(({ cellFixture, conditionKeys }) => {
        const element = document.createElement("scheduling-condition-matrix") as HTMLElement
            & Record<string, unknown>;
        element.localize = (key: string) => key;
        element.cell = cellFixture;
        element.conditionKeys = conditionKeys;
        element.optimizerKind = "charge_hold";
        element.slotLabel = "15:00";
        document.body.appendChild(element);
    }, { cellFixture, conditionKeys });

    await expect(matrix(page).locator(".matrix")).toHaveCount(1);
}

/** The union column set the dialog would have handed it for that lane. */
const CHARGE_HOLD_KEYS = ["min_soc_pct", "hold_room", "reserve_floor_soc"];

/** Open the matrix for the charge_hold slot the level-2 tests all use. */
async function drill(page: Page): Promise<void> {
    await mountMatrix(page, CHARGE_HOLD_CELL, CHARGE_HOLD_KEYS);
    await expect(matrix(page).locator("table.nodes")).toHaveCount(1);
}

/**
 * Level 2: one optimizer, one slot, every condition it consulted.
 *
 * **Not mounted in the dialog any more.** The user's reading after living with
 * it: the matrix added nothing over the diagram, which draws the same record as
 * a chain instead of a table of marks. The component and these tests are kept
 * standalone rather than deleted -- the seam is worth keeping, and the diagram
 * reuses its parsed data.
 *
 * The distinctions this level exists to preserve are all ones a plain
 * checkbox grid would erase:
 *
 * - `not_evaluated` is neither `false` nor absent. Three claims, three marks.
 * - A condition a group does not configure is `not_applicable`, never `true`.
 * - A window-scoped node is one result, not one per row.
 * - An errored custom entry and a false one both give the group `met=false`;
 *   only the tri-state separates them.
 * - Params without their `paramsSource` are numbers that only look like this
 *   slot's own.
 */
test.describe("lane explanation, level 2", () => {
    test("the dialog no longer mounts the matrix at all", async ({ page }) => {
        await mountDialog(page, INVERTER_PAYLOAD);
        await cell(page, 4, "charge_hold").locator(".cell-body").click();

        // The drill is grid -> diagram now; nothing sits between them.
        await expect(page.locator("scheduling-explanation-dialog scheduling-logic-diagram"))
            .toHaveCount(1);
        await expect(page.locator("scheduling-explanation-dialog scheduling-condition-matrix"))
            .toHaveCount(0);
    });

    test("one row per group, one column per condition", async ({ page }) => {
        await drill(page);

        await expect(matrix(page).locator(".verdict-badge")).toHaveAttribute("data-verdict", "skip");
        // One row per group, one column per condition the optimizer ever used.
        await expect(matrix(page).locator("tbody tr")).toHaveCount(2);
        const heads = await matrix(page).locator("thead th.condition-head").evaluateAll(
            (nodes) => nodes.map((node) => node.getAttribute("data-condition")),
        );
        expect(heads).toEqual(["min_soc_pct", "hold_room", "reserve_floor_soc", "custom"]);
    });

    test("the resolved params carry the marker for how they were resolved", async ({ page }) => {
        await drill(page);

        // charge_hold resolves through `for_day`, which can pick another group.
        const source = matrix(page).locator('.params-row[data-group="0"] .params-source');
        await expect(source).toHaveAttribute("data-source", "day_resolved");
        await expect(source).toHaveText(/day_resolved/);
        await expect(matrix(page).locator('.params-row[data-group="0"] .param[data-param="min_soc_pct"]'))
            .toContainText("40");
    });

    test("a condition column does not expand, because nodes are flat", async ({ page }) => {
        await drill(page);

        // The backend emits one node per configured condition and nothing below
        // it, so there is nothing to open. The header is a plain label with no
        // expander, rather than a control that opens an empty row.
        const head = matrix(page).locator('th.condition-head[data-condition="min_soc_pct"]');
        await expect(head).toHaveCount(1);
        await expect(head.locator(".expander")).toHaveCount(0);
        await expect(head).toHaveAttribute("data-expanded", "false");
        // Every column contributes a spacer to the second header row; what must
        // not exist is a real sub-column under a condition.
        await expect(matrix(page).locator('th.sub-head[data-condition="min_soc_pct"]'))
            .toHaveCount(0);
    });

    test("the custom column expands into one sub-column per entry", async ({ page }) => {
        await drill(page);

        await matrix(page).locator('th.condition-head[data-condition="custom"] .expander').click();
        await expect(matrix(page).locator('th.sub-head[data-condition="custom"]')).toHaveCount(2);

        // Group 0's two entries: one plainly false, one that threw. Fail-closed
        // evaluation calls both "not met"; only these read differently.
        const failed = matrix(page).locator('tbody tr[data-group="0"] td[data-condition="custom"][data-sub="0"]');
        const errored = matrix(page).locator('tbody tr[data-group="0"] td[data-condition="custom"][data-sub="1"]');
        await expect(failed).toHaveAttribute("data-custom", "false");
        await expect(errored).toHaveAttribute("data-custom", "errored");
        expect(await failed.locator(".glyph").innerText())
            .not.toBe(await errored.locator(".glyph").innerText());
        await expect(errored.locator(".custom-entry")).toHaveAttribute("title", /custom_state.errored/);
    });

    test("not evaluated, false, not applicable and absent are four cells", async ({ page }) => {
        await drill(page);

        const unevaluated = matrix(page).locator('tbody tr[data-group="0"] td[data-condition="min_soc_pct"]');
        const failed = matrix(page).locator('tbody tr[data-group="0"] td[data-condition="hold_room"]');
        const inapplicable = matrix(page).locator('tbody tr[data-group="1"] td[data-condition="min_soc_pct"]');
        const absent = matrix(page).locator('tbody tr[data-group="1"] td[data-condition="hold_room"]');

        await expect(unevaluated).toHaveAttribute("data-state", "not_evaluated");
        await expect(failed).toHaveAttribute("data-state", "false");
        // A condition the group does not configure is never an unearned true.
        await expect(inapplicable).toHaveAttribute("data-state", "not_applicable");
        // Nothing recorded at all: no state to read, and nothing to press.
        await expect(absent).toHaveClass(/node-absent/);
        await expect(absent.locator(".node")).toHaveCount(0);

        const glyphs = await Promise.all([
            unevaluated.locator(".glyph").innerText(),
            failed.locator(".glyph").innerText(),
            inapplicable.locator(".glyph").innerText(),
        ]);
        expect(new Set(glyphs).size).toBe(3);
        // And they do not lean on the glyph alone.
        const colours = await Promise.all([
            unevaluated.locator(".glyph").evaluate((node) => getComputedStyle(node).color),
            failed.locator(".glyph").evaluate((node) => getComputedStyle(node).color),
        ]);
        expect(colours[0]).not.toBe(colours[1]);

        // The failing node says what the slot actually presented.
        await expect(failed).toContainText("0.40");
    });

    test("a window-scoped node is drawn once, spanning the groups", async ({ page }) => {
        await drill(page);

        const spanning = matrix(page).locator('td[data-condition="reserve_floor_soc"]');
        // One cell for two groups, not two identical checkmarks.
        await expect(spanning).toHaveCount(1);
        await expect(spanning).toHaveAttribute("rowspan", "2");
        await expect(spanning).toHaveAttribute("data-scope", "window");
        await expect(spanning.locator(".scope-badge")).toHaveText(/scope.window/);

        // A slot-scoped node stays one cell per group.
        await expect(matrix(page).locator('td[data-condition="min_soc_pct"]')).toHaveCount(2);
    });

    test("the gates that are not conditions are shown with their ordinals", async ({ page }) => {
        await mountMatrix(page, APPLIANCE_CELL, ["max_run_price"]);

        const gate = matrix(page).locator('.gate[data-gate="cheapest_rank"]');
        await expect(gate).toHaveAttribute("data-state", "false");
        // Ranking is an ordinal: "you lost to eight cheaper slots" is a number,
        // not a truth value.
        await expect(gate).toContainText("9");
    });

    test("a node hands its coordinates to the level-3 seam", async ({ page }) => {
        await drill(page);

        await page.evaluate(() => {
            (window as unknown as Record<string, unknown>).__nodeSelects = [];
            document.body.addEventListener(
                "condition-matrix-node-select",
                (event: Event) => {
                    ((window as unknown as Record<string, unknown>).__nodeSelects as unknown[])
                        .push((event as CustomEvent).detail);
                },
            );
        });
        await matrix(page)
            .locator('tbody tr[data-group="0"] td[data-condition="hold_room"] .node')
            .click();

        const selects = await page.evaluate(
            () => (window as unknown as Record<string, unknown>).__nodeSelects as Record<string, unknown>[],
        );
        expect(selects).toHaveLength(1);
        expect(selects[0]).toMatchObject({
            optimizerId: "charge_hold",
            slotId: SLOT_IDS[4],
            rowIndex: 4,
            groupIndex: 0,
            conditionKey: "hold_room",
            subKey: null,
        });
    });
});
