import { test, expect, type Page } from "@playwright/test";
import { loadBundle } from "./support/card-page";
import { explanationRows } from "./support/payload-builders";

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
const INVERTER_PAYLOAD = explanationRows({
    controllableId: "inverter",
    date: DATE,
    slotIds: SLOT_IDS,
    runAt: RUN_AT,
    optimizers: [
        {
            optimizerId: "export_price",
            // 15:00 has no row: export_price never looked at it.
            slots: SLOT_IDS.slice(0, 4).map((slotId, slot) => ({
                slotId,
                verdict: slot === 2 ? "execute" : "skip",
                winningOptimizer: slot === 2 ? "export_price" : undefined,
                matchedGroupIndex: slot === 2 ? 0 : undefined,
                groups: [{
                    params: { min_export_price: 1.0 },
                    conditions: [{
                        key: "when_price_below",
                        scope: "slot",
                        state: slot === 2 ? "true" : "false",
                        value: 1.0,
                        actual: [1.2, 1.1, undefined, 0.9][slot],
                    }],
                }],
                gates: [{ key: "stop_export_supported", state: "true" }],
            })),
        },
        {
            optimizerId: "charge_hold",
            slots: SLOT_IDS.map((slotId, slot) => ({
                slotId,
                verdict: slot < 3 ? "execute" : "skip",
                winningOptimizer: ["charge_hold", undefined, "export_price", undefined, undefined][slot],
                matchedGroupIndex: slot < 3 ? 0 : undefined,
                groups: [
                    {
                        label: "Ráno",
                        // Resolved once for the day, so possibly from another group.
                        paramsSource: "day_resolved",
                        params: { min_soc_pct: 40, target_soc_pct: 80 },
                        // Two entries: one plainly false, one that threw.
                        customResults: [slot < 3, null],
                        conditions: [
                            {
                                key: "min_soc_pct",
                                scope: "slot",
                                // Never consulted past the hold window: not false.
                                state: slot < 3 ? "true" : "not_evaluated",
                                value: 40,
                            },
                            {
                                // Fails only at 15:00, and says what it saw there.
                                key: "hold_room",
                                scope: "slot",
                                state: slot < 4 ? "true" : "false",
                                value: 5,
                                actual: slot === 4 ? 0.4 : undefined,
                            },
                            {
                                // One result for the whole expensive band, not five.
                                key: "reserve_floor_soc",
                                scope: "window",
                                state: "true",
                                value: 20,
                            },
                        ],
                    },
                    {
                        label: "Večer",
                        paramsSource: "day_resolved",
                        params: { min_soc_pct: 60 },
                        customResults: [true, null],
                        conditions: [
                            // This group does not configure it at all.
                            { key: "min_soc_pct", scope: "slot", state: "not_applicable" },
                            { key: "reserve_floor_soc", scope: "window", state: "true", value: 20 },
                        ],
                    },
                ],
                gates: [
                    // Unreached past 14:00: absent, never false.
                    ...(slot < 3 ? [{ key: "hold_window", state: "true" as const }] : []),
                    ...(slot === 1 ? [{ key: "blocked_user_owned", state: "false" as const }] : []),
                    ...(slot === 2 ? [{ key: "blocked_user_owned", state: "true" as const }] : []),
                ],
            })),
        },
        {
            optimizerId: "charge_from_grid",
            status: "skipped",
            statusReason: "battery_params_missing",
        },
    ],
});

/** One appliance, one optimizer: the same table, one column narrower. */
const APPLIANCE_PAYLOAD = explanationRows({
    controllableId: "boiler",
    date: DATE,
    slotIds: SLOT_IDS.slice(0, 2),
    runAt: RUN_AT,
    optimizers: [{
        optimizerId: "appliance_runtime:boiler",
        kind: "appliance_runtime",
        phase: 3,
        slots: SLOT_IDS.slice(0, 2).map((slotId, slot) => ({
            slotId,
            verdict: slot === 0 ? "execute" : "skip",
            winningOptimizer: slot === 0 ? "appliance_runtime:boiler" : undefined,
            matchedGroupIndex: slot === 0 ? 0 : undefined,
            groups: [{
                conditions: [{
                    key: "max_run_price",
                    scope: "slot",
                    state: slot === 0 ? "true" : "false",
                    actual: slot === 1 ? 3.4 : undefined,
                }],
            }],
            gates: [{
                key: "cheapest_rank",
                state: slot === 0 ? "true" : "false",
                params: { rank: slot === 0 ? 1 : 9 },
            }],
        })),
    }],
});

/**
 * A lane whose first slot is *placed but not running*.
 *
 * A candidate has every mandatory condition satisfied and a custom condition
 * that is not (yet) true; it is displayed and re-checked at start time. Nothing
 * landed the write, so the row has no winner -- and reporting the optimizer's
 * action there would promise a run that will not happen.
 */
const CANDIDATE_PAYLOAD = explanationRows({
    controllableId: "pool",
    date: DATE,
    slotIds: SLOT_IDS.slice(0, 2),
    runAt: RUN_AT,
    optimizers: [
        {
            optimizerId: "appliance_runtime:pool",
            kind: "appliance_runtime",
            slots: SLOT_IDS.slice(0, 2).map((slotId, slot) => ({
                slotId,
                verdict: slot === 0 ? "candidate" : "execute",
                winningOptimizer: slot === 1 ? "appliance_runtime:pool" : undefined,
                matchedGroupIndex: 0,
                groups: [{
                    label: "Studený bazén",
                    customResults: [slot === 1],
                    conditions: [{ key: "max_run_price", scope: "slot", state: "true", value: 2.0 }],
                }],
                gates: [{ key: "slot_available", state: "true" }],
            })),
        },
        {
            optimizerId: "charge_hold",
            slots: SLOT_IDS.slice(0, 2).map((slotId, slot) => ({
                slotId,
                verdict: "skip",
                groups: [{
                    conditions: [{
                        key: "min_soc_pct",
                        scope: "slot",
                        state: "false",
                        value: 40,
                        actual: [21, 22][slot],
                    }],
                }],
            })),
        },
    ],
});
async function mountPanel(page: Page, payload: unknown, slotIndex: number | null): Promise<void> {
    await loadBundle(page, "scheduling-explanation-panel");

    await page.evaluate(({ fixture, slotId }) => {
        const panel = document.createElement("scheduling-explanation-panel") as unknown as HTMLElement
            & Record<string, unknown>;
        panel.localize = Object.assign((key: string) => key, { has: () => false });
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
    test("shows all pipeline phases and marks the traced phase without a phase-1 tab", async ({ page }) => {
        await mountPanel(page, INVERTER_PAYLOAD, 2);

        await expect(panel(page).locator(".pipeline-stage")).toHaveCount(3);
        await expect(panel(page).locator('.pipeline-stage[data-phase="1"]'))
            .toContainText("scheduling.explanation.pipeline.unavailable");
        await expect(panel(page).locator('.pipeline-stage[data-phase="2"]'))
            .toHaveAttribute("aria-current", "step");
        await expect(panel(page).locator('.pipeline-stage[data-phase="3"]'))
            .not.toHaveAttribute("aria-current", "step");
        await expect(panel(page).locator('.pipeline-stage[data-phase="1"] button'))
            .toHaveCount(0);
    });

    test("marks an appliance account as the final phase", async ({ page }) => {
        await mountPanel(page, APPLIANCE_PAYLOAD, 0);

        await expect(panel(page).locator('.pipeline-stage[data-phase="1"]'))
            .toContainText("scheduling.explanation.pipeline.unavailable");
        await expect(panel(page).locator('.pipeline-stage[data-phase="2"]'))
            .not.toHaveAttribute("aria-current", "step");
        await expect(panel(page).locator('.pipeline-stage[data-phase="3"]'))
            .toHaveAttribute("aria-current", "step");
    });

    test("a tab per optimizer that had an account of the slot, in traced-phase order", async ({ page }) => {
        // 14:00: charge_hold and export_price both decided execute;
        // charge_from_grid never ran, so it is on the strip but not openable.
        await mountPanel(page, INVERTER_PAYLOAD, 2);

        const optimizers = await panel(page).locator(".tab").evaluateAll(
            (nodes) => nodes.map((node) => node.getAttribute("data-optimizer")),
        );
        // Traced-phase order is the payload's order, never re-sorted.
        expect(optimizers).toEqual(["export_price", "charge_hold", "charge_from_grid"]);
        await expect(panel(page).locator("scheduling-logic-diagram")).toHaveCount(1);
    });

    test("the winner's tab opens, not the first to decide execute", async ({ page }) => {
        await mountPanel(page, INVERTER_PAYLOAD, 2);

        // charge_hold decided execute first; export_price came later in the
        // traced phase and took the slot, so its account is the one that matches
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
