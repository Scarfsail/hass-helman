import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The lane explanation, as one slot at a time.
 *
 * The day-sized grid this replaced is gone: the question is now asked by
 * pressing a slot on the day editor's band, and this panel answers that one
 * slot. What the grid encoded still has to survive the move, because those are
 * the distinctions the record exists to make and that a naive view flattens:
 *
 * - **A verdict is not an outcome.** Writing is last-writer-wins among
 *   optimizers, so `execute` in a column that lost the slot has to read
 *   `overwritten`, and the tab that opens has to be the winner's.
 * - **A skipped step is not "every slot false".** It cannot be opened, and it
 *   says why it never ran rather than vanishing from the strip -- which would
 *   make it indistinguishable from an optimizer that was never configured.
 * - **`not_evaluated`, `false` and absent are three states, not two.** A node
 *   that was never consulted is not a node that failed, and neither is a slot
 *   the optimizer never looked at.
 * - **A candidate is not a run.** A slot that is merely placed must never read
 *   as the optimizer's action.
 * - **One optimizer gets no tab strip**, where a lone chip could only restate
 *   what the diagram under it is already about.
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
async function mountPanel(page: Page, payload: unknown, slotIndex: number | null): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("scheduling-explanation-panel"));

    await page.evaluate(({ fixture, slotId }) => {
        const panel = document.createElement("scheduling-explanation-panel") as HTMLElement
            & Record<string, unknown>;
        panel.localize = (key: string) => key;
        panel.payload = fixture;
        panel.slotId = slotId;
        panel.locale = "cs";
        panel.timeZone = "Europe/Prague";
        document.body.appendChild(panel);
    }, { fixture: payload, slotId: slotIndex === null ? null : SLOT_IDS[slotIndex] });

    await expect(panel(page).locator(".explanation-panel, .placeholder")).toHaveCount(1);
}

function panel(page: Page) {
    return page.locator("scheduling-explanation-panel");
}

/** One optimizer's tab for the slot on screen. */
function tab(page: Page, optimizerId: string) {
    return panel(page).locator(`.tab[data-optimizer="${optimizerId}"]`);
}

/** Which optimizer's diagram is open, read off the terminal the diagram drew. */
async function openTab(page: Page): Promise<string | null> {
    return panel(page).locator(".tab.selected").getAttribute("data-optimizer");
}

test.describe("slot explanation, the tab strip", () => {
    test("a tab per optimizer that had an account of the slot, in pipeline order", async ({ page }) => {
        // 14:00: charge_hold and export_price both decided execute;
        // charge_from_grid never ran, so it is on the strip but not openable.
        await mountPanel(page, INVERTER_PAYLOAD, 2);

        const optimizers = await panel(page).locator(".tab").evaluateAll(
            (nodes) => nodes.map((node) => node.getAttribute("data-optimizer")),
        );
        // Pipeline order is the payload's order, never re-sorted.
        expect(optimizers).toEqual(["export_price", "charge_hold", "charge_from_grid"]);
        await expect(panel(page).locator("scheduling-logic-diagram")).toHaveCount(1);
    });

    test("the winner's tab opens, not the first to decide execute", async ({ page }) => {
        await mountPanel(page, INVERTER_PAYLOAD, 2);

        // charge_hold decided execute first; export_price came later in the
        // pipeline and took the slot, so its account is the one that matches
        // what the schedule shows.
        expect(await openTab(page)).toBe("export_price");
    });

    test("the loser of a slot two optimizers wrote reads overwritten", async ({ page }) => {
        await mountPanel(page, INVERTER_PAYLOAD, 2);

        await expect(tab(page, "charge_hold")).toHaveAttribute("data-outcome", "overwritten");
        await expect(tab(page, "charge_hold")).toContainText("⤫");
        await expect(tab(page, "export_price")).toHaveAttribute("data-outcome", "wrote");
    });

    test("a slot the user owns reads blocked, not rejected", async ({ page }) => {
        // 13:30: charge_hold's conditions all passed and the writer vetoed.
        await mountPanel(page, INVERTER_PAYLOAD, 1);

        const blocked = tab(page, "charge_hold");
        await expect(blocked).toHaveAttribute("data-outcome", "blocked");
        await expect(blocked).toContainText("⛨");
    });

    test("a rejected tab names the condition that rejected it", async ({ page }) => {
        // 14:30: export_price failed on price.
        await mountPanel(page, INVERTER_PAYLOAD, 3);

        const rejected = tab(page, "export_price");
        await expect(rejected).toHaveAttribute("data-outcome", "not_eligible");
        await expect(rejected).toContainText("when_price_below");
    });

    test("a skipped step stays on the strip, says why, and cannot be opened", async ({ page }) => {
        await mountPanel(page, INVERTER_PAYLOAD, 0);

        const skipped = tab(page, "charge_from_grid");
        await expect(skipped).toHaveAttribute("data-status", "skipped");
        await expect(skipped).toHaveClass(/inert/);
        await expect(skipped).toContainText("battery_params_missing");
        expect(await skipped.evaluate((node) => Number(getComputedStyle(node).opacity)))
            .toBeLessThan(1);
        // Not a button: there is no record behind it to draw.
        await expect(panel(page).locator('button[data-optimizer="charge_from_grid"]')).toHaveCount(0);
    });

    test("an optimizer that said nothing about the slot gets no tab at all", async ({ page }) => {
        // 15:00: export_price never looked at it. Absent is not a rejection,
        // and a tab opening on nothing would say it was one.
        await mountPanel(page, INVERTER_PAYLOAD, 4);

        await expect(tab(page, "export_price")).toHaveCount(0);
        await expect(tab(page, "charge_hold")).toHaveCount(1);
    });

    test("pressing another tab moves the diagram to that optimizer", async ({ page }) => {
        await mountPanel(page, INVERTER_PAYLOAD, 2);

        await tab(page, "charge_hold").click();
        expect(await openTab(page)).toBe("charge_hold");
        await expect(panel(page).locator("scheduling-logic-diagram")).toHaveCount(1);
    });

    test("a single-optimizer lane gets no tab strip", async ({ page }) => {
        await mountPanel(page, APPLIANCE_PAYLOAD, 0);

        // One account of the slot and nothing to arbitrate: a lone chip over
        // the diagram would restate the diagram's own heading.
        await expect(panel(page).locator(".tab-strip")).toHaveCount(0);
        await expect(panel(page).locator("scheduling-logic-diagram")).toHaveCount(1);
    });

    test("a candidate reads as a candidate, never as the action", async ({ page }) => {
        await mountPanel(page, CANDIDATE_PAYLOAD, 0);

        // 13:00 was placed and its custom conditions were not met: it is on
        // screen and it will not run, so it must not read "zapnout".
        const candidate = tab(page, "appliance_runtime:pool");
        await expect(candidate).toHaveAttribute("data-outcome", "candidate");
        const candidateLabel = candidate.locator(".tab-outcome-label");
        await expect(candidateLabel).toHaveText(/outcome.candidate/);

        // 13:30 really did run, and the two do not read the same -- which is
        // the whole bug: they used to.
        await mountPanel(page, CANDIDATE_PAYLOAD, 1);
        const wrote = tab(page, "appliance_runtime:pool");
        await expect(wrote).toHaveAttribute("data-outcome", "wrote");
        // The action, because this one is a run: the localize stub falls the
        // label back to the bare backend key.
        await expect(wrote.locator(".tab-outcome-label")).toHaveText("appliance_runtime");
    });

    test("nothing to show says so rather than drawing an empty panel", async ({ page }) => {
        // The backend's own answer for "nothing is recorded for this lane".
        await mountPanel(page, null, 0);

        await expect(panel(page).locator(".placeholder.empty")).toHaveText(/empty/);
        await expect(panel(page).locator("scheduling-logic-diagram")).toHaveCount(0);
    });

    test("no slot picked yet says what to press", async ({ page }) => {
        await mountPanel(page, INVERTER_PAYLOAD, null);

        await expect(panel(page).locator(".placeholder.no-slot")).toHaveText(/no_slot/);
        await expect(panel(page).locator("scheduling-logic-diagram")).toHaveCount(0);
    });
});
