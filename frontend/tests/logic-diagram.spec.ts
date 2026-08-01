import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Level 3: the logic that produced one slot, as AND/OR blocks.
 *
 * The diagram shows two layers at once and the whole point is that they are not
 * the same layer. **State** is what a block evaluated to. **Decisiveness** is
 * whether it changed the outcome. A condition can pass and still be beside the
 * point — because a sibling group had already been chosen, or a gate had
 * already vetoed — and a diagram that highlights everything that passed says
 * nothing at all.
 *
 * What is pinned here:
 *
 * - **A false AND marks only its false inputs.** The inputs that passed a group
 *   that still failed changed nothing.
 * - **A true OR marks only the first satisfied group**, mirroring
 *   `evaluation.py:90-96` (`fully or matching[0]`). A second group that also
 *   passed was never reached, and highlighting it would contradict the
 *   "matched group" label right above the diagram.
 * - **Four terminals, not two.** `candidate` and `not eligible` are different
 *   outcomes with different causes and must not render as one.
 * - **Dimmed, never hidden.** A branch that did not matter stays on screen at
 *   reduced opacity: deleting it would make "checked and irrelevant"
 *   indistinguishable from "never checked".
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
];

/**
 * Four slots of one optimizer over three condition groups.
 *
 * - **13:00** group 0 fails on price, groups 1 *and* 2 both pass; the slot
 *   executes. Only group 1 may be decisive.
 * - **13:30** every group fails, each on a different condition; nothing is
 *   eligible.
 * - **14:00** group 0 passes and its custom condition says no: a candidate.
 * - **14:30** every condition passes and the writer vetoes: blocked.
 */
function conditionColumn(
    key: string,
    states: unknown[],
    actual: Record<string, unknown>,
    value: unknown = 1.0,
) {
    return { key, scope: "slot", state: states, value: [[value, 4]], actual };
}

const PAYLOAD = {
    targetKey: "inverter",
    date: DATE,
    slotIds: SLOT_IDS,
    runAt: RUN_AT,
    optimizers: [{
        optimizerId: "export_price",
        kind: "export_price",
        targetKey: "inverter",
        status: "ok",
        runAt: [[RUN_AT, 4]],
        verdict: [["execute", 1], ["skip", 1], ["candidate", 1], ["execute", 1]],
        winningOptimizer: { "0": "export_price" },
        groups: [
            {
                index: 0,
                label: "Ráno",
                paramsSource: [["slot_matched", 4]],
                params: [[{ min_export_price: 1.0 }, 4]],
                // Only 14:00 configures a custom condition, and it says no.
                customResults: [[[], 2], [[false], 1], [[], 1]],
                conditions: [
                    conditionColumn(
                        "when_price_below",
                        [["false", 1], ["true", 3]],
                        { "0": 1.5 },
                    ),
                    conditionColumn(
                        "min_soc_pct",
                        [["true", 1], ["false", 1], ["true", 2]],
                        { "1": 0.2 },
                    ),
                ],
            },
            {
                index: 1,
                label: "Poledne",
                paramsSource: [["slot_matched", 4]],
                params: [[{ min_export_price: 2.0 }, 4]],
                conditions: [
                    conditionColumn(
                        "when_price_below",
                        [["true", 1], ["false", 1], ["true", 2]],
                        { "1": 3.1 },
                        2.0,
                    ),
                    conditionColumn("min_soc_pct", [["true", 4]], {}),
                ],
            },
            {
                index: 2,
                label: "Večer",
                // Not this slot's own params: `for_day()` resolved them, and
                // the badge is the only thing that says so.
                paramsSource: [["day_resolved", 4]],
                params: [[{ min_export_price: 3.0 }, 4]],
                conditions: [
                    conditionColumn(
                        "when_price_below",
                        [["true", 1], ["false", 1], ["true", 2]],
                        { "1": 4.2 },
                    ),
                    conditionColumn("min_soc_pct", [["true", 4]], {}),
                ],
            },
        ],
        gates: [
            // Only 14:30 reached the writer, and the user owns that slot.
            { key: "blocked_user_owned", state: [[null, 3], ["false", 1]] },
        ],
    }],
};

/**
 * One optimizer, **one** condition group, and the gates that are not vetoes.
 *
 * This is the shape the real screenshots had and the old diagram could not
 * draw honestly:
 *
 * - **13:00** executes while `placement_capacity` is `false`. That gate reports
 *   "the day will under-run", it does not block the slot
 *   (`appliance_runtime.py:124`), so it must never appear as an input of an AND
 *   whose terminal says the slot ran.
 * - **13:30** is rejected by `ensure_self_sustainability`, whose `actual` is a
 *   whole object — the raw JSON that used to paint over the next block.
 *
 * One group also means there is nothing for a `≥1` to choose between.
 */
const SINGLE_GROUP_PAYLOAD = {
    targetKey: "appliance.dryer",
    date: DATE,
    slotIds: SLOT_IDS.slice(0, 2),
    runAt: RUN_AT,
    optimizers: [{
        optimizerId: "appliance_runtime",
        kind: "appliance_runtime",
        targetKey: "appliance.dryer",
        status: "ok",
        runAt: [[RUN_AT, 2]],
        verdict: [["execute", 1], ["skip", 1]],
        winningOptimizer: { "0": "appliance_runtime" },
        groups: [{
            index: 0,
            label: "Den",
            paramsSource: [["slot_matched", 2]],
            params: [[{ max_price: 3.5 }, 2]],
            conditions: [
                {
                    key: "when_price_below",
                    scope: "slot",
                    state: [["true", 2]],
                    value: [[3.5, 2]],
                    actual: { "1": 3.43 },
                },
                {
                    // Set membership, not a comparison: `_run_when_mask` tests
                    // the day's classification against the configured set.
                    key: "run_when",
                    scope: "day",
                    state: [["true", 2]],
                    value: [[["workday", "weekend"], 2]],
                },
                {
                    key: "ensure_self_sustainability",
                    scope: "slot",
                    state: [["true", 1], ["false", 1]],
                    value: [["strict", 2]],
                    // The overflow case, verbatim in shape: an object `actual`
                    // far wider than the 210px block it has to live in.
                    actual: {
                        "1": {
                            code: "not_solar_neutral",
                            deltaSocPct: -3.05,
                            importKwh: 0.42,
                            exportKwh: 0.0,
                        },
                    },
                },
            ],
        }],
        gates: [
            // False, and not a veto: the day under-runs and this slot still ran.
            {
                key: "placement_capacity",
                state: [["false", 2]],
                params: [[{ slotsNeeded: 6, slotsPlaceable: 4, windowSlots: 8 }, 2]],
            },
            { key: "slot_available", state: [["true", 2]] },
            {
                key: "cheapest_rank",
                state: [["true", 2]],
                params: [[{ rank: 2, rankOf: 9 }, 2]],
            },
        ],
    }],
};

/**
 * One slot whose only custom condition *threw*.
 *
 * Fail-closed evaluation gives the group `met=false` whether the template said
 * no or blew up, so the tri-state is the only thing that separates them --
 * and "your template is broken" is the one a person has to act on.
 */
const ERRORED_CUSTOM_PAYLOAD = {
    targetKey: "appliance.pool",
    date: DATE,
    slotIds: SLOT_IDS.slice(0, 1),
    runAt: RUN_AT,
    optimizers: [{
        optimizerId: "appliance_runtime",
        kind: "appliance_runtime",
        targetKey: "appliance.pool",
        status: "ok",
        runAt: [[RUN_AT, 1]],
        verdict: [["candidate", 1]],
        groups: [{
            index: 0,
            label: "Studený bazén",
            paramsSource: [["slot_matched", 1]],
            params: [[{ max_run_price: 2.0 }, 1]],
            customResults: [[[null], 1]],
            conditions: [{
                key: "max_run_price",
                scope: "slot",
                state: [["true", 1]],
                value: [[2.0, 1]],
            }],
        }],
        gates: [{ key: "slot_available", state: [["true", 1]] }],
    }],
};

/**
 * A slot that will run, whose custom condition held **at planning time**.
 *
 * The case the two-stage picture exists for. Every state on this diagram was
 * taken when the plan was built; the custom condition is taken again before the
 * action starts (`coordinator.py:3575-3620`), so "spustit" here is a conditional
 * claim about the future, not a settled fact — and the drawing has to say so
 * without downgrading it to a candidate.
 */
const MET_CUSTOM_PAYLOAD = {
    targetKey: "appliance.pool",
    date: DATE,
    slotIds: SLOT_IDS.slice(0, 1),
    runAt: RUN_AT,
    optimizers: [{
        optimizerId: "appliance_runtime",
        kind: "appliance_runtime",
        targetKey: "appliance.pool",
        status: "ok",
        runAt: [[RUN_AT, 1]],
        verdict: [["execute", 1]],
        winningOptimizer: { "0": "appliance_runtime" },
        groups: [{
            index: 0,
            label: "Studený bazén",
            paramsSource: [["slot_matched", 1]],
            params: [[{ max_run_price: 2.0 }, 1]],
            customResults: [[[true], 1]],
            conditions: [{
                key: "max_run_price",
                scope: "slot",
                state: [["true", 1]],
                value: [[2.0, 1]],
            }],
        }],
        gates: [{ key: "slot_available", state: [["true", 1]] }],
    }],
};

/**
 * Two groups match, and only the second one's custom conditions held.
 *
 * `Eligibility.__init__` settles on `fully or matching[0]` — the first group
 * that matched *and* whose custom conditions held, falling back to the first
 * that matched at all. Reading `matching[0]` instead gives a false custom stage
 * over a `spustit` terminal, which the diagram then has to suppress as a
 * contradiction: a slot that ran with no re-check stage at all, next to a
 * candidate that has one. That was the reported inconsistency.
 */
const SECOND_GROUP_CUSTOM_PAYLOAD = {
    targetKey: "appliance.pool",
    date: DATE,
    slotIds: SLOT_IDS.slice(0, 1),
    runAt: RUN_AT,
    optimizers: [{
        optimizerId: "appliance_runtime",
        kind: "appliance_runtime",
        targetKey: "appliance.pool",
        status: "ok",
        runAt: [[RUN_AT, 1]],
        verdict: [["execute", 1]],
        winningOptimizer: { "0": "appliance_runtime" },
        groups: [
            {
                index: 0,
                label: "Ráno",
                paramsSource: [["slot_matched", 1]],
                params: [[{ max_run_price: 2.0 }, 1]],
                // Matched on the mask, and its template said no.
                customResults: [[[false], 1]],
                conditions: [{
                    key: "max_run_price",
                    scope: "slot",
                    state: [["true", 1]],
                    value: [[2.0, 1]],
                }],
            },
            {
                index: 1,
                label: "Poledne",
                paramsSource: [["slot_matched", 1]],
                params: [[{ max_run_price: 3.0 }, 1]],
                customResults: [[[true], 1]],
                conditions: [{
                    key: "max_run_price",
                    scope: "slot",
                    state: [["true", 1]],
                    value: [[3.0, 1]],
                }],
            },
        ],
        gates: [{ key: "slot_available", state: [["true", 1]] }],
    }],
};

/**
 * Both groups match, and the slot runs under the one with no template.
 *
 * Taken from a real record (`pool-heatpump`, two groups: "Záporná cena" with no
 * custom conditions, "Studený bazén" with a pool-temperature one that is false
 * all day). On the cheap slots both groups' masks match, so `fully or
 * matching[0]` settles on the group whose custom conditions held — the one that
 * has none — and the slot runs. On every other slot only the second group
 * matches, and its false template makes a candidate.
 *
 * Which is correct, and unreadable if the empty stage does not say *whose*
 * conditions are missing: the reader wrote that template and is looking right
 * at a diagram that appears to deny it exists.
 */
const GROUP_WITHOUT_CUSTOM_WINS_PAYLOAD = {
    targetKey: "appliance.pool",
    date: DATE,
    slotIds: SLOT_IDS.slice(0, 1),
    runAt: RUN_AT,
    optimizers: [{
        optimizerId: "appliance_runtime",
        kind: "appliance_runtime",
        targetKey: "appliance.pool",
        status: "ok",
        runAt: [[RUN_AT, 1]],
        verdict: [["execute", 1]],
        winningOptimizer: { "0": "appliance_runtime" },
        groups: [
            {
                index: 0,
                label: "Záporná cena",
                paramsSource: [["slot_matched", 1]],
                params: [[{ max_run_price: 2.0 }, 1]],
                // No custom conditions at all: the column is absent, not false.
                conditions: [{
                    key: "max_run_price",
                    scope: "slot",
                    state: [["true", 1]],
                    value: [[2.0, 1]],
                }],
            },
            {
                index: 1,
                label: "Studený bazén",
                paramsSource: [["slot_matched", 1]],
                params: [[{ min_soc_pct: 40 }, 1]],
                customResults: [[[false], 1]],
                conditions: [{
                    key: "min_soc_pct",
                    scope: "slot",
                    state: [["true", 1]],
                    value: [[40, 1]],
                }],
            },
        ],
        gates: [{ key: "slot_available", state: [["true", 1]] }],
    }],
};

/**
 * One group, with a custom condition, and a slot no group matched.
 *
 * The slot has no matched group at all, so the re-check stage has nothing to
 * report on — and every group in the cell is "not the matched one", which is
 * enough to claim that *another* group carries the template. There is no other
 * group: the note would point at nothing.
 */
const LONE_GROUP_UNMATCHED_PAYLOAD = {
    targetKey: "appliance.pool",
    date: DATE,
    slotIds: SLOT_IDS.slice(0, 1),
    runAt: RUN_AT,
    optimizers: [{
        optimizerId: "appliance_runtime",
        kind: "appliance_runtime",
        targetKey: "appliance.pool",
        status: "ok",
        runAt: [[RUN_AT, 1]],
        verdict: [["skip", 1]],
        groups: [{
            index: 0,
            label: "Den",
            paramsSource: [["slot_matched", 1]],
            params: [[{ max_run_price: 2.0 }, 1]],
            customResults: [[[true], 1]],
            conditions: [{
                key: "max_run_price",
                scope: "slot",
                state: [["false", 1]],
                value: [[2.0, 1]],
                actual: { "0": 4.1 },
            }],
        }],
        gates: [{ key: "slot_available", state: [["true", 1]] }],
    }],
};

/**
 * A **forced** day: every condition failed and the appliance ran anyway.
 *
 * `max_consecutive_skips` is the one construct that defeats the whole OR chain
 * (`appliance_runtime.py:30-35`) — after that many consecutive short days the
 * optimizer runs "past every group's `custom` conditions and past every slot
 * condition, over the full window, carrying its own `consecutive_skip_override`
 * gate so a forced run never reads as an unexplained one".
 *
 * Drawn as an AND input it would claim a forced run *required* it, and the
 * failed conditions would be demoted to context by `isPlanInput`'s second rule —
 * a run with no visible cause, which is the exact opposite of what the gate is
 * for. It ORs with the conditions instead.
 *
 * The group also carries the other two shapes this fixture exists to pin: a
 * condition it does not configure (`min_soc_pct`, `not_applicable`) and one that
 * was deliberately never consulted (`min_solar_coverage_pct`), so all three
 * non-passing readings can be told apart in one picture.
 */
const FORCED_DAY_PAYLOAD = {
    targetKey: "appliance.pool",
    date: DATE,
    slotIds: SLOT_IDS.slice(0, 1),
    runAt: RUN_AT,
    optimizers: [{
        optimizerId: "appliance_runtime",
        kind: "appliance_runtime",
        targetKey: "appliance.pool",
        status: "ok",
        runAt: [[RUN_AT, 1]],
        verdict: [["execute", 1]],
        winningOptimizer: { "0": "appliance_runtime" },
        groups: [{
            index: 0,
            label: "Teplý den",
            // One group, and its params still came from the day rather than
            // from this slot: the badge has to show up without a caption.
            paramsSource: [["day_resolved", 1]],
            params: [[{ max_run_price: 2.0 }, 1]],
            conditions: [
                {
                    key: "run_when",
                    scope: "day",
                    state: [["false", 1]],
                    value: [[["weekend"], 1]],
                    actual: { "0": "workday" },
                },
                { key: "min_soc_pct", scope: "slot", state: [["not_applicable", 1]] },
                {
                    key: "min_solar_coverage_pct",
                    scope: "slot",
                    state: [["not_evaluated", 1]],
                    value: [[40, 1]],
                },
            ],
        }],
        gates: [
            {
                key: "run_window",
                state: [["true", 1]],
                params: [[{ start: "08:00", end: "18:00" }, 1]],
            },
            {
                key: "daily_minimum_remaining",
                state: [["true", 1]],
                params: [[{
                    minHours: 4,
                    doneHours: 1.5,
                    remainingHours: 2.5,
                    slotsNeeded: 5,
                }, 1]],
            },
            {
                key: "consecutive_skip_override",
                state: [["true", 1]],
                params: [[{ consecutiveSkips: 2, maxConsecutiveSkips: 2 }, 1]],
            },
            {
                key: "placement_capacity",
                state: [["false", 1]],
                params: [[{ slotsNeeded: 5, slotsPlaceable: 4, windowSlots: 8 }, 1]],
            },
            {
                key: "cheapest_rank",
                state: [["true", 1]],
                params: [[{ rank: 1, rankOf: 16, cost: 2.1, worstChosenCost: 3.4 }, 1]],
            },
            { key: "slot_available", state: [["true", 1]] },
        ],
    }],
};

/**
 * A group that configures only some of the optimizer's conditions.
 *
 * The unconfigured one is `not_applicable` (`evaluation.py:285-296`) — not
 * false, not unevaluated, and *not absent*: leaving it out made the group look
 * like it checked fewer things than it did. It must be drawn and must take no
 * part in the AND, which is what lets this slot run.
 */
const NOT_APPLICABLE_PAYLOAD = {
    targetKey: "appliance.dryer",
    date: DATE,
    slotIds: SLOT_IDS.slice(0, 1),
    runAt: RUN_AT,
    optimizers: [{
        optimizerId: "appliance_runtime",
        kind: "appliance_runtime",
        targetKey: "appliance.dryer",
        status: "ok",
        runAt: [[RUN_AT, 1]],
        verdict: [["execute", 1]],
        winningOptimizer: { "0": "appliance_runtime" },
        groups: [{
            index: 0,
            label: "Den",
            paramsSource: [["slot_matched", 1]],
            params: [[{ max_price: 3.5 }, 1]],
            conditions: [
                {
                    key: "when_price_below",
                    scope: "slot",
                    state: [["true", 1]],
                    value: [[3.5, 1]],
                },
                { key: "min_soc_pct", scope: "slot", state: [["not_applicable", 1]] },
            ],
        }],
        gates: [{ key: "slot_available", state: [["true", 1]] }],
    }],
};

async function mountPanel(page: Page, fixture: unknown = PAYLOAD): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("scheduling-explanation-panel"));

    await page.evaluate((fixture) => {
        const panel = document.createElement("scheduling-explanation-panel") as HTMLElement
            & Record<string, unknown>;
        panel.localize = (key: string) => key;
        panel.payload = fixture;
        panel.locale = "cs";
        panel.timeZone = "Europe/Prague";
        document.body.appendChild(panel);
    }, fixture);

    // Nothing pressed yet: the panel is mounted and waiting for a slot.
    await expect(page.locator("scheduling-explanation-panel").locator(".placeholder.no-slot"))
        .toHaveCount(1);
}

/** An SVG `<text>`'s content: `innerText` is an HTML-only property. */
async function svgText(locator: ReturnType<Page["locator"]>): Promise<string> {
    return (await locator.evaluate((node) => node.textContent ?? ""))
        .replace(/\s+/g, " ")
        .trim();
}

function diagram(page: Page) {
    return page.locator("scheduling-explanation-panel scheduling-logic-diagram");
}

/**
 * Open a slot's diagram.
 *
 * One press, not two: the day-sized grid and the level-2 matrix that used to
 * sit between a slot and its diagram are both gone, so pressing the slot on
 * the band *is* the drill.
 */
async function openDiagram(page: Page, rowIndex: number): Promise<void> {
    await selectSlot(page, rowIndex, "export_price");
}

/**
 * Ask about one slot, and about one optimizer's account of it.
 *
 * The slot is what the band hands the panel; the optimizer is the tab, which a
 * lane with a single one does not draw at all.
 */
async function selectSlot(page: Page, rowIndex: number, optimizerId: string): Promise<void> {
    await page.evaluate((slotId) => {
        (document.querySelector("scheduling-explanation-panel") as HTMLElement
            & Record<string, unknown>).slotId = slotId;
    }, SLOT_IDS[rowIndex]);

    const tab = page.locator("scheduling-explanation-panel")
        .locator(`button.tab[data-optimizer="${optimizerId}"]`);
    if (await tab.count() > 0) {
        await tab.click();
    }
    await expect(diagram(page).locator("svg.logic")).toHaveCount(1);
}

/**
 * Recompute both drawn ANDs and compare each with what it claims to have
 * decided.
 *
 * The invariants the whole picture rests on, one per stage: whatever is wired
 * into the planning `&` must resolve to the verdict it produces, and that
 * verdict is `true` exactly when the slot got planned — `execute` *or*
 * `candidate`, since a candidate is a planned slot waiting on its custom
 * conditions. The execution `&` over [verdict, custom] must then resolve to
 * `true` exactly when the terminal says the slot ran.
 *
 * A `✗` input above a `✓ spustit` terminal is the diagram calling itself a
 * liar, and it is the failure a real reader hit first.
 */
async function andInvariant(page: Page): Promise<{
    inputs: string[];
    computed: string;
    final: string;
    /** The execution AND over the verdict and the custom stage, where drawn. */
    execComputed: string | null;
    exec: string | null;
    terminal: string;
}> {
    return diagram(page).locator("svg.logic").evaluate((svg) => {
        const stateOf = (id: string): string =>
            svg.querySelector(`g.block[data-id="${id}"]`)?.getAttribute("data-state") ?? "";
        const and = (states: string[]): string => {
            const considered = states.filter(
                (state) => state !== "not_applicable" && state !== "n/a",
            );
            if (considered.length === 0) return "true";
            if (considered.includes("false") || considered.includes("errored")) return "false";
            return considered.includes("not_evaluated") ? "not_evaluated" : "true";
        };
        const inputIds = Array.from(svg.querySelectorAll('path.edge[data-to="final"]'))
            .map((edge) => edge.getAttribute("data-from") ?? "");
        const execIds = Array.from(svg.querySelectorAll('path.edge[data-to="exec"]'))
            .map((edge) => edge.getAttribute("data-from") ?? "");
        return {
            inputs: inputIds,
            computed: and(inputIds.map(stateOf)),
            final: stateOf("final"),
            execComputed: execIds.length === 0 ? null : and(execIds.map(stateOf)),
            exec: svg.querySelector('g.block[data-id="exec"]') === null ? null : stateOf("exec"),
            terminal: svg.getAttribute("data-terminal") ?? "",
        };
    });
}

/** Every block's decisiveness, keyed by the block id the model assigns. */
async function decisiveness(page: Page): Promise<Record<string, string>> {
    return diagram(page).locator("g.block").evaluateAll((nodes) => {
        const out: Record<string, string> = {};
        for (const node of nodes) {
            out[node.getAttribute("data-id") ?? ""] = node.getAttribute("data-decisive") ?? "";
        }
        return out;
    });
}

test.describe("the condition logic diagram", () => {
    test("pressing a slot opens the diagram, with nothing in between", async ({ page }) => {
        await mountPanel(page);
        await expect(diagram(page)).toHaveCount(0);

        await openDiagram(page, 1);
        // With nothing pressed the diagram still opens on a branch, rather than
        // on none.
        await expect(diagram(page).locator('g.block[data-focus-group="true"]').first())
            .toHaveCount(1);
    });

    test("a false AND marks only its false inputs decisive", async ({ page }) => {
        await mountPanel(page);
        // 13:30: nothing is eligible, so every group's AND is decisive.
        await openDiagram(page, 1);
        await expect(diagram(page).locator("svg.logic")).toHaveAttribute("data-terminal", "not_eligible");

        const marks = await decisiveness(page);
        expect(marks["and-0"]).toBe("true");
        expect(marks["and-1"]).toBe("true");
        expect(marks["and-2"]).toBe("true");

        // Group 0 failed on its SoC floor, not on price. Only the failing input
        // is decisive; the one that passed changed nothing.
        const states = await diagram(page).locator('g.block[data-kind="input"][data-group="0"]')
            .evaluateAll((nodes) => nodes.map((node) => ({
                key: node.getAttribute("data-key"),
                state: node.getAttribute("data-state"),
                decisive: node.getAttribute("data-decisive"),
            })));
        expect(states).toEqual([
            { key: "when_price_below", state: "true", decisive: "false" },
            { key: "min_soc_pct", state: "false", decisive: "true" },
        ]);
    });

    test("a true OR marks only the first satisfied group", async ({ page }) => {
        await mountPanel(page);
        // 13:00: groups 1 and 2 both pass. `fully or matching[0]` stops at 1.
        await openDiagram(page, 0);
        await expect(diagram(page).locator("svg.logic")).toHaveAttribute("data-terminal", "execute");
        await expect(diagram(page).locator(".matched")).toHaveAttribute("data-group", "1");

        const marks = await decisiveness(page);
        expect(marks.or).toBe("true");
        // The group that lost, and the group that would also have won but was
        // never reached, are both non-decisive.
        expect(marks["and-0"]).toBe("false");
        expect(marks["and-1"]).toBe("true");
        expect(marks["and-2"]).toBe("false");

        // A true AND makes all of its inputs decisive.
        const group1 = await diagram(page).locator('g.block[data-kind="input"][data-group="1"]')
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-decisive")));
        expect(group1).toEqual(["true", "true"]);
    });

    test("candidate and not eligible render as different terminals", async ({ page }) => {
        await mountPanel(page);

        await openDiagram(page, 2);
        await expect(diagram(page).locator("svg.logic")).toHaveAttribute("data-terminal", "candidate");
        // A candidate is decided by the custom condition, not by the mask: the
        // group matched, and the template said no. The mask is decisive too --
        // for the plan verdict, which is a different question and a different
        // stage.
        const candidateMarks = await decisiveness(page);
        expect(candidateMarks.custom).toBe("true");
        expect(candidateMarks.verdict).toBe("true");
        expect(candidateMarks.or).toBe("true");
        const candidateGlyph = await diagram(page)
            .locator('g.block[data-kind="terminal"] text.glyph')
            .evaluate((node) => node.textContent?.trim() ?? "");

        await openDiagram(page, 1);
        await expect(diagram(page).locator("svg.logic")).toHaveAttribute("data-terminal", "not_eligible");
        const rejectedGlyph = await diagram(page)
            .locator('g.block[data-kind="terminal"] text.glyph')
            .evaluate((node) => node.textContent?.trim() ?? "");

        // Not the same claim, so not the same terminal and not the same mark.
        expect(candidateGlyph).not.toBe(rejectedGlyph);
    });

    test("a writer veto is its own terminal, not a failed condition", async ({ page }) => {
        await mountPanel(page);
        await openDiagram(page, 3);

        await expect(diagram(page).locator("svg.logic")).toHaveAttribute("data-terminal", "blocked");
        const marks = await decisiveness(page);
        // Every condition passed; the veto is the only thing that decided it.
        expect(marks["gate-0"]).toBe("true");
        expect(marks.or).toBe("false");
    });

    test("branches that did not matter are dimmed, not removed", async ({ page }) => {
        await mountPanel(page);
        await openDiagram(page, 0);

        // The losing group is still drawn.
        const dimmed = diagram(page).locator('g.block[data-id="and-0"]');
        await expect(dimmed).toHaveCount(1);
        const dimmedOpacity = await dimmed.evaluate((node) => Number(getComputedStyle(node).opacity));
        const liveOpacity = await diagram(page).locator('g.block[data-id="and-1"]')
            .evaluate((node) => Number(getComputedStyle(node).opacity));
        expect(dimmedOpacity).toBeLessThan(1);
        expect(dimmedOpacity).toBeGreaterThan(0);
        expect(liveOpacity).toBe(1);

        // And the edges say it a second way, without colour: dashed vs solid.
        const dashed = await diagram(page).locator('path.edge[data-from="and-0"]')
            .evaluate((node) => getComputedStyle(node).strokeDasharray);
        const solid = await diagram(page).locator('path.edge[data-from="and-1"]')
            .evaluate((node) => getComputedStyle(node).strokeDasharray);
        expect(dashed).not.toBe(solid);
    });
});

/**
 * The picture has to agree with itself, and it has to be readable.
 *
 * These pin the four things a real reader could not get from the first cut: an
 * AND that contradicted its own terminal, raw JSON painted across two blocks,
 * a `≥1` over a single group, and a diagram that only existed after a click
 * nobody knew to make.
 */
test.describe("the logic diagram never contradicts its terminal", () => {
    test("every terminal reproduces from the drawn AND inputs", async ({ page }) => {
        const check = (
            result: Awaited<ReturnType<typeof andInvariant>>,
            where: string,
        ): void => {
            // The planning block is what the drawn inputs actually say.
            expect(result.computed, `${where} inputs ${result.inputs.join()}`)
                .toBe(result.final);
            // And that is true exactly when the slot was planned, which covers
            // the candidate: planned, placed, waiting on its own conditions.
            expect(result.final === "true", where)
                .toBe(result.terminal === "execute" || result.terminal === "candidate");
            // The second stage is always drawn, and closes the same way.
            expect(result.execComputed, `${where} exec`).toBe(result.exec);
            expect(result.exec === "true", `${where} exec`)
                .toBe(result.terminal === "execute");
        };

        await mountPanel(page);
        for (const rowIndex of [0, 1, 2, 3]) {
            await selectSlot(page, rowIndex, "export_price");
            check(await andInvariant(page), `row ${rowIndex}`);
        }

        await mountPanel(page, SINGLE_GROUP_PAYLOAD);
        for (const rowIndex of [0, 1]) {
            await selectSlot(page, rowIndex, "appliance_runtime");
            check(await andInvariant(page), `appliance row ${rowIndex}`);
        }
    });

    test("an informational false gate is context, not an AND input", async ({ page }) => {
        await mountPanel(page, SINGLE_GROUP_PAYLOAD);
        await selectSlot(page, 0, "appliance_runtime");
        await expect(diagram(page).locator("svg.logic"))
            .toHaveAttribute("data-terminal", "execute");

        // `placement_capacity` is false and the slot ran. It is not drawn as a
        // block at all, and nothing wires it into the AND.
        await expect(diagram(page).locator('g.block[data-key="placement_capacity"]'))
            .toHaveCount(0);
        const { inputs } = await andInvariant(page);
        expect(inputs.some((id) => id.includes("placement"))).toBe(false);

        // It is still on screen, in the area that says what it is: recorded,
        // and not what decided the slot.
        const annotation = diagram(page).locator('.annotation[data-key="placement_capacity"]');
        await expect(annotation).toHaveCount(1);
        await expect(annotation).toHaveAttribute("data-state", "false");
    });

    test("a single group draws no ≥1", async ({ page }) => {
        await mountPanel(page, SINGLE_GROUP_PAYLOAD);
        await selectSlot(page, 0, "appliance_runtime");

        // Nothing to choose between: the group's own AND wires straight on.
        await expect(diagram(page).locator('g.block[data-kind="or"]')).toHaveCount(0);
        const ops = await diagram(page).locator("text.op")
            .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() ?? ""));
        expect(ops).not.toContain("≥1");
        await expect(diagram(page).locator('path.edge[data-from="and-0"][data-to="final"]'))
            .toHaveCount(1);

        // Three groups still get one.
        await mountPanel(page);
        await selectSlot(page, 0, "export_price");
        await expect(diagram(page).locator('g.block[data-kind="or"]')).toHaveCount(1);
    });

    test("an object actual never escapes its block", async ({ page }) => {
        await mountPanel(page, SINGLE_GROUP_PAYLOAD);
        await selectSlot(page, 1, "appliance_runtime");

        const overflow = await diagram(page).locator("svg.logic").evaluate((svg) => {
            const worst: { id: string; overflow: number }[] = [];
            for (const block of Array.from(svg.querySelectorAll("g.block"))) {
                const rect = block.querySelector("rect.body") as SVGRectElement | null;
                if (rect === null) continue;
                const left = rect.x.baseVal.value;
                const right = left + rect.width.baseVal.value;
                for (const text of Array.from(block.querySelectorAll("text"))) {
                    const box = (text as SVGGraphicsElement).getBBox();
                    const escaped = Math.max(left - box.x, box.x + box.width - right);
                    if (escaped > 0.5) {
                        worst.push({ id: block.getAttribute("data-id") ?? "", overflow: escaped });
                    }
                }
            }
            return worst;
        });
        expect(overflow).toEqual([]);

        // The object is summarised on the face and kept whole in the tooltip.
        const block = diagram(page)
            .locator('g.block[data-key="ensure_self_sustainability"]');
        const face = await block.locator("text.actual").evaluate((node) =>
            node.textContent?.trim() ?? "");
        expect(face).not.toContain("{");
        expect(face.length).toBeLessThanOrEqual(12);
        await expect(block.locator("title")).toContainText("deltaSocPct");
    });

    test("the diagram is there as soon as a slot is open", async ({ page }) => {
        await mountPanel(page, SINGLE_GROUP_PAYLOAD);
        await expect(diagram(page)).toHaveCount(0);

        // Opening the slot is the whole drill.
        await selectSlot(page, 0, "appliance_runtime");
        await expect(diagram(page).locator("svg.logic")).toHaveCount(1);
        await expect(diagram(page).locator('g.block[data-focus="true"]')).toHaveCount(0);
        // And it opens on the group the decision turned on.
        await expect(diagram(page).locator('g.block[data-focus-group="true"]').first())
            .toHaveCount(1);
    });
});

/** Every text box that escapes the block it is drawn in. Must always be empty. */
async function overflowingText(page: Page): Promise<unknown[]> {
    return diagram(page).locator("svg.logic").evaluate((svg) => {
        const worst: { id: string; text: string; overflow: number }[] = [];
        for (const block of Array.from(svg.querySelectorAll("g.block"))) {
            const rect = block.querySelector("rect.body") as SVGRectElement | null;
            if (rect === null) continue;
            const left = rect.x.baseVal.value;
            const right = left + rect.width.baseVal.value;
            for (const text of Array.from(block.querySelectorAll("text"))) {
                const box = (text as SVGGraphicsElement).getBBox();
                const escaped = Math.max(left - box.x, box.x + box.width - right);
                if (escaped > 0.5) {
                    worst.push({
                        id: block.getAttribute("data-id") ?? "",
                        text: text.textContent?.trim() ?? "",
                        overflow: escaped,
                    });
                }
            }
        }
        return worst;
    });
}

/**
 * The override is not a requirement, and a forced run must say why it ran.
 *
 * `consecutive_skip_override` defeats the conditions rather than joining them.
 * Wired into the final AND it would read as something the run *needed*, and
 * `isPlanInput` would then quietly reclassify the failed conditions as context —
 * leaving a run on screen with nothing visible that caused it.
 */
test.describe("an override ORs with the conditions, it does not AND with them", () => {
    test("a forced run is the other input of the ≥1, beside the failed spine", async ({ page }) => {
        await mountPanel(page, FORCED_DAY_PAYLOAD);
        await selectSlot(page, 0, "appliance_runtime");
        await expect(diagram(page).locator("svg.logic"))
            .toHaveAttribute("data-terminal", "execute");

        const override = diagram(page).locator('g.block[data-id="override"]');
        await expect(override).toHaveCount(1);
        await expect(override).toHaveAttribute("data-key", "consecutive_skip_override");

        // It joins the OR, never the AND.
        await expect(diagram(page).locator('path.edge[data-from="override"][data-to="or"]'))
            .toHaveCount(1);
        await expect(diagram(page).locator('path.edge[data-from="override"][data-to="final"]'))
            .toHaveCount(0);
        // A single group, and there is still something to choose between.
        await expect(diagram(page).locator('g.block[data-kind="or"]')).toHaveCount(1);
        await expect(diagram(page).locator('path.edge[data-from="or"][data-to="final"]'))
            .toHaveCount(1);

        // The spine it overrode is still drawn, still false, and is *not*
        // demoted to the context panel.
        const failed = diagram(page).locator('g.block[data-kind="input"][data-key="run_when"]');
        await expect(failed).toHaveCount(1);
        await expect(failed).toHaveAttribute("data-state", "false");
        await expect(diagram(page).locator('g.block[data-id="and-0"]'))
            .toHaveAttribute("data-state", "false");
        await expect(diagram(page).locator('.annotation[data-key="groups"]')).toHaveCount(0);

        // And the picture says, in words, that this is a forced run.
        await expect(diagram(page).locator('text[data-stage="forced_run"]')).toHaveCount(1);
        await expect(diagram(page).locator('.legend-item[data-legend="override"]')).toHaveCount(1);
    });

    test("the forced day still reproduces its own terminal", async ({ page }) => {
        await mountPanel(page, FORCED_DAY_PAYLOAD);
        await selectSlot(page, 0, "appliance_runtime");

        const result = await andInvariant(page);
        expect(result.computed).toBe(result.final);
        expect(result.final).toBe("true");
        expect(result.terminal).toBe("execute");
        // The OR carries the truth into the AND; the override itself is not a
        // term of the conjunction.
        expect(result.inputs).toContain("or");
        expect(result.inputs).not.toContain("override");
    });

    test("the override is what decided it, and the conditions are dimmed", async ({ page }) => {
        await mountPanel(page, FORCED_DAY_PAYLOAD);
        await selectSlot(page, 0, "appliance_runtime");

        const marks = await decisiveness(page);
        expect(marks.override).toBe("true");
        expect(marks.or).toBe("true");
        // Checked, failed, overridden — and therefore not what decided the run.
        expect(marks["and-0"]).toBe("false");

        const dimmed = await diagram(page).locator('g.block[data-id="and-0"]')
            .evaluate((node) => Number(getComputedStyle(node).opacity));
        const live = await diagram(page).locator('g.block[data-id="override"]')
            .evaluate((node) => Number(getComputedStyle(node).opacity));
        expect(dimmed).toBeLessThan(1);
        expect(dimmed).toBeGreaterThan(0);
        expect(live).toBe(1);
    });
});

/**
 * Each block carries its own numbers.
 *
 * The record already holds them; showing only a ✓ threw away the one thing that
 * makes a gate readable — *which* window, *which* rank, *how far* short. A
 * separate params strip above the diagram was rejected: the numbers belong to
 * the blocks that own them.
 */
test.describe("a block shows the numbers it was decided by", () => {
    test("gates render their decisive numbers inline", async ({ page }) => {
        await mountPanel(page, FORCED_DAY_PAYLOAD);
        await selectSlot(page, 0, "appliance_runtime");

        const detail = async (key: string) => svgText(
            diagram(page).locator(`g.block[data-key="${key}"] text.detail`),
        );
        // A window is a range, not a threshold.
        expect(await detail("run_window")).toBe("08:00–18:00");
        // An ordinal is not a truth value: position out of total, no operator.
        expect(await detail("cheapest_rank")).toBe("1/16");
        // have / need, which is what the gate actually tested.
        expect(await detail("daily_minimum_remaining")).toBe("1.5/4 h");
        expect(await detail("consecutive_skip_override")).toBe("2/2");

        // No operator was invented for any of them.
        const invented = await diagram(page).locator("text.detail")
            .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? "")
                .filter((text) => /[<>≥≤=]/.test(text)));
        expect(invented).toEqual([]);
    });

    test("the full params are one hover away", async ({ page }) => {
        await mountPanel(page, FORCED_DAY_PAYLOAD);
        await selectSlot(page, 0, "appliance_runtime");

        // The face shows two of the four; the tooltip shows all of them.
        const rank = diagram(page).locator('g.block[data-key="cheapest_rank"] title');
        await expect(rank).toContainText("rankOf: 16");
        await expect(rank).toContainText("cost: 2.1");
        await expect(rank).toContainText("worstChosenCost: 3.4");

        const minimum = diagram(page)
            .locator('g.block[data-key="daily_minimum_remaining"] title');
        await expect(minimum).toContainText("remainingHours: 2.5");
        await expect(minimum).toContainText("slotsNeeded: 5");

        // The override says what it is in prose, not only as a pair of numbers.
        await expect(diagram(page).locator('g.block[data-id="override"] title'))
            .toContainText("diagram.override_detail");
    });

    test("a self-gating condition shows the level the group configured", async ({ page }) => {
        await mountPanel(page, SINGLE_GROUP_PAYLOAD);
        // 13:00: the node passed, so the record carries no actual at all. The
        // configured level is what there is to show.
        await selectSlot(page, 0, "appliance_runtime");
        expect(await svgText(diagram(page)
            .locator('g.block[data-key="ensure_self_sustainability"] text.actual')))
            .toBe("strict");
    });

    test("nothing a block shows escapes the block", async ({ page }) => {
        for (const fixture of [FORCED_DAY_PAYLOAD, NOT_APPLICABLE_PAYLOAD]) {
            await mountPanel(page, fixture);
            await selectSlot(page, 0, "appliance_runtime");
            expect(await overflowingText(page)).toEqual([]);
        }
        await mountPanel(page);
        for (const rowIndex of [0, 1, 2, 3]) {
            await selectSlot(page, rowIndex, "export_price");
            expect(await overflowingText(page)).toEqual([]);
        }
    });
});

/**
 * Where a group's params came from.
 *
 * `day_resolved` and `master_fallback` params can be a *different* group's
 * entirely, so without the marker the numbers silently read as this slot's own.
 */
test.describe("the params source is on screen", () => {
    test("every chain is badged, next to its caption", async ({ page }) => {
        await mountPanel(page);
        await openDiagram(page, 0);

        const badges = await diagram(page).locator("text.params-source")
            .evaluateAll((nodes) => nodes.map((node) => ({
                group: node.getAttribute("data-group"),
                source: node.getAttribute("data-source"),
                text: (node.querySelector("tspan")?.textContent ?? "").trim(),
            })));
        expect(badges.map((badge) => badge.source))
            .toEqual(["slot_matched", "slot_matched", "day_resolved"]);
        expect(badges.map((badge) => badge.group)).toEqual(["0", "1", "2"]);
        // Never colour alone: the loud sources carry a mark as well.
        expect(badges[2].text.startsWith("!")).toBe(true);
        expect(badges[0].text.startsWith("!")).toBe(false);

        const fills = await diagram(page).locator("text.params-source")
            .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).fill));
        expect(fills[2]).not.toBe(fills[0]);
    });

    test("a single group gets the badge even with no caption", async ({ page }) => {
        await mountPanel(page, FORCED_DAY_PAYLOAD);
        await selectSlot(page, 0, "appliance_runtime");

        // The label is still noise with one chain; the marker is not.
        await expect(diagram(page).locator("text.group-label")).toHaveCount(0);
        const badge = diagram(page).locator("text.params-source");
        await expect(badge).toHaveCount(1);
        await expect(badge).toHaveAttribute("data-source", "day_resolved");
        // The whole explanation is on hover.
        await expect(badge.locator("title"))
            .toHaveText("scheduling.explanation.params_source_detail.day_resolved");
    });
});

/**
 * A condition the group does not configure is a fourth reading, not a missing
 * one: `not_applicable` (`evaluation.py:285-296`), drawn dotted and greyed,
 * taking no part in the AND.
 */
test.describe("unconfigured conditions are drawn, and change nothing", () => {
    test("a not_applicable input is on screen and out of the AND", async ({ page }) => {
        await mountPanel(page, NOT_APPLICABLE_PAYLOAD);
        await selectSlot(page, 0, "appliance_runtime");

        const unused = diagram(page).locator('g.block[data-key="min_soc_pct"]');
        await expect(unused).toHaveCount(1);
        await expect(unused).toHaveAttribute("data-state", "not_applicable");
        expect(await svgText(unused.locator("text.glyph"))).toBe("–");
        // It never decided anything, so it is never marked as having done so.
        await expect(unused).toHaveAttribute("data-decisive", "false");

        // And it does not hold the AND back: the group passed on the one
        // condition it does configure.
        await expect(diagram(page).locator('g.block[data-id="and-0"]'))
            .toHaveAttribute("data-state", "true");
        const result = await andInvariant(page);
        expect(result.computed).toBe(result.final);
        expect(result.final).toBe("true");
        expect(result.terminal).toBe("execute");
    });

    test("unconfigured, failed and never-consulted read differently", async ({ page }) => {
        await mountPanel(page, FORCED_DAY_PAYLOAD);
        await selectSlot(page, 0, "appliance_runtime");

        const face = async (key: string) => diagram(page)
            .locator(`g.block[data-key="${key}"]`)
            .evaluate((node) => {
                const rect = node.querySelector("rect.body")!;
                return {
                    glyph: node.querySelector("text.glyph")?.textContent?.trim() ?? "",
                    dash: getComputedStyle(rect).strokeDasharray,
                    stroke: getComputedStyle(rect).stroke,
                };
            });
        const unused = await face("min_soc_pct");
        const failed = await face("run_when");
        const untested = await face("min_solar_coverage_pct");

        // Three glyphs, three dash patterns: readable with no colour at all.
        expect([unused.glyph, failed.glyph, untested.glyph]).toEqual(["–", "✗", "?"]);
        expect(unused.dash).not.toBe(failed.dash);
        expect(unused.dash).not.toBe(untested.dash);
        expect(unused.stroke).not.toBe(failed.stroke);
        await expect(diagram(page).locator('.legend-item[data-legend="not_applicable"]'))
            .toHaveCount(1);
    });
});

/**
 * What the block *compared*, which chain it belongs to, and when the custom
 * conditions run.
 *
 * All three are the same complaint from a reader looking at live data: the
 * picture showed results without showing the test, three unnamed chains, and a
 * `candidate` that looked like a rejection with an odd label.
 */
test.describe("the diagram shows the test, not only the result", () => {
    test("a failing condition reads actual, operator, threshold", async ({ page }) => {
        await mountPanel(page);
        // 13:00, group 0: the price was 1.50 and the group wanted below 1.
        await openDiagram(page, 0);

        const block = diagram(page)
            .locator('g.block[data-group="0"][data-key="when_price_below"]');
        await expect(block).toHaveAttribute("data-state", "false");
        expect(await svgText(block.locator("text.comparison"))).toBe("1.50 < 1");
        // Both sides of the record are one hover away, in full.
        await expect(block.locator("title")).toContainText("matrix.configured");
        await expect(block.locator("title")).toContainText("matrix.actual");
    });

    test("a passing condition shows the threshold, never an invented actual", async ({ page }) => {
        await mountPanel(page);
        await openDiagram(page, 0);

        // Group 1 passed, so the record carries no `actual` for it at all --
        // the backend omits it by design. The threshold is what can be shown.
        const block = diagram(page)
            .locator('g.block[data-group="1"][data-key="when_price_below"]');
        await expect(block).toHaveAttribute("data-state", "true");
        expect(await svgText(block.locator("text.comparison"))).toBe("< 2");
    });

    test("the two sides read differently, and not by colour alone", async ({ page }) => {
        await mountPanel(page);
        await openDiagram(page, 0);

        const failing = diagram(page)
            .locator('g.block[data-group="0"][data-key="when_price_below"]');
        const passing = diagram(page)
            .locator('g.block[data-group="1"][data-key="when_price_below"]');
        const colours = await Promise.all([
            failing.locator("text.comparison").evaluate((node) => getComputedStyle(node).fill),
            passing.locator("text.comparison").evaluate((node) => getComputedStyle(node).fill),
        ]);
        expect(colours[0]).not.toBe(colours[1]);
        // The glyph says it a second time, with no colour involved.
        const glyphs = await Promise.all([
            svgText(failing.locator("text.glyph")),
            svgText(passing.locator("text.glyph")),
        ]);
        expect(glyphs[0]).toBe("✗");
        expect(glyphs[1]).toBe("✓");
    });

    test("membership and self-gating conditions get no </> invented", async ({ page }) => {
        await mountPanel(page, SINGLE_GROUP_PAYLOAD);
        await selectSlot(page, 1, "appliance_runtime");

        // `run_when` is a set test (`_run_when_mask`), so it reads as one.
        const membership = await svgText(diagram(page)
            .locator('g.block[data-key="run_when"] text.comparison'));
        expect(membership).toContain("∈");
        expect(membership).not.toMatch(/[<>≥≤]/);

        // The self-gating pair has no numeric form the record could carry, and
        // "strict" is not something to put an operator in front of.
        await expect(diagram(page)
            .locator('g.block[data-key="ensure_self_sustainability"] text.comparison'))
            .toHaveCount(0);

        // And a plain comparison still is one.
        expect(await svgText(diagram(page)
            .locator('g.block[data-key="when_price_below"] text.comparison')))
            .toBe("3.43 < 3.50");
    });

    test("each chain is named where there is more than one", async ({ page }) => {
        await mountPanel(page);
        await openDiagram(page, 0);

        const labels = await diagram(page).locator("text.group-label")
            .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() ?? ""));
        expect(labels).toEqual(["Ráno", "Poledne", "Večer"]);

        // One group has nothing to be told apart from, so it gets no caption.
        await mountPanel(page, SINGLE_GROUP_PAYLOAD);
        await selectSlot(page, 0, "appliance_runtime");
        await expect(diagram(page).locator("text.group-label")).toHaveCount(0);
    });

    test("the custom conditions are a stage of their own, past the plan", async ({ page }) => {
        await mountPanel(page);
        // 14:00: every mandatory condition passed and the template said no.
        await openDiagram(page, 2);
        await expect(diagram(page).locator("svg.logic"))
            .toHaveAttribute("data-terminal", "candidate");

        // Its own captioned stage, on the far side of the seam.
        await expect(diagram(page).locator('text.stage[data-stage="recheck"]')).toHaveCount(1);
        await expect(diagram(page).locator("line.stage-divider")).toHaveCount(1);

        // Past the plan verdict, and past every gate: the whole point is that
        // it is decided after the question of "is this planned at all".
        const geometry = await diagram(page).locator("svg.logic").evaluate((svg) => {
            const x = (selector: string) => {
                const rect = svg.querySelector(`${selector} rect.body`) as SVGRectElement | null;
                return rect === null ? null : rect.x.baseVal.value;
            };
            const divider = svg.querySelector("line.stage-divider") as SVGLineElement | null;
            return {
                custom: x('g.block[data-id="custom"]'),
                verdict: x('g.block[data-id="verdict"]'),
                exec: x('g.block[data-id="exec"]'),
                terminal: x('g.block[data-kind="terminal"]'),
                gate: x('g.block[data-kind="gate"]'),
                divider: divider === null ? null : divider.x1.baseVal.value,
            };
        });
        expect(geometry.custom).not.toBeNull();
        expect(geometry.custom!).toBeGreaterThan(geometry.verdict!);
        expect(geometry.custom!).toBeLessThan(geometry.exec!);
        expect(geometry.exec!).toBeLessThan(geometry.terminal!);
        if (geometry.gate !== null) {
            expect(geometry.custom!).toBeGreaterThan(geometry.gate);
        }
        // The seam falls between the two stages, not through one of them.
        expect(geometry.divider!).toBeGreaterThan(geometry.verdict!);
        expect(geometry.divider!).toBeLessThan(geometry.custom!);
    });

    test("both time notes are drawn whatever the custom conditions said", async ({ page }) => {
        // A candidate has to say the same two things a run does: when this was
        // decided, and that it is taken again before the action starts. Saying
        // it only for the run made "kandidát" read as a refusal, and saying it
        // only for the candidate would make "spustit" read as settled.
        // The wording, without the clock time: the two fixtures are different
        // slots of different runs, so the times differ and the *claim* is what
        // has to be identical.
        const notes = async (): Promise<string[]> => diagram(page)
            .locator('text[data-stage="custom_evaluated"], text[data-stage="custom_when"]')
            .evaluateAll((nodes) => nodes.map(
                (node) => (node.textContent?.trim() ?? "").split(" · ")[0],
            ));

        await mountPanel(page);
        await openDiagram(page, 2);
        await expect(diagram(page).locator("svg.logic"))
            .toHaveAttribute("data-terminal", "candidate");
        const onCandidate = await notes();
        expect(onCandidate).toHaveLength(2);

        await mountPanel(page, MET_CUSTOM_PAYLOAD);
        await selectSlot(page, 0, "appliance_runtime");
        await expect(diagram(page).locator("svg.logic"))
            .toHaveAttribute("data-terminal", "execute");
        // The same two notes, word for word: a run and a candidate are the same
        // claim about the future, differing only in what is true today.
        expect(await notes()).toEqual(onCandidate);

        // The notes are only worth anything with the two times in them: when
        // the plan was built, and when the slot starts.
        const labels = await page.evaluate(() => {
            const panel = document.querySelector("scheduling-explanation-panel") as any;
            const el = panel.shadowRoot.querySelector("scheduling-logic-diagram") as any;
            return { plan: el.planLabel as string, slot: el.slotLabel as string };
        });
        expect(labels.plan).toMatch(/\d{1,2}[:.]\d{2}/);
        expect(labels.slot).toMatch(/\d{1,2}[:.]\d{2}/);

        // And the stage is still drawn, true and decisive -- it is half of why
        // the slot runs, not a formality.
        const custom = diagram(page).locator('g.block[data-id="custom"]');
        await expect(custom).toHaveAttribute("data-state", "true");
        await expect(custom).toHaveAttribute("data-decisive", "true");
    });

    test("the matched group is the one whose custom conditions held", async ({ page }) => {
        // Two groups match; the first one's template said no and the second
        // one's did not, so the slot ran under the second. Reading the first
        // would put a false re-check over a run, which the diagram suppresses
        // -- and the stage would vanish on exactly the slots that ran, while
        // the candidate beside them kept theirs.
        await mountPanel(page, SECOND_GROUP_CUSTOM_PAYLOAD);
        await selectSlot(page, 0, "appliance_runtime");
        await expect(diagram(page).locator("svg.logic"))
            .toHaveAttribute("data-terminal", "execute");

        const custom = diagram(page).locator('g.block[data-id="custom"]');
        await expect(custom).toHaveCount(1);
        await expect(custom).toHaveAttribute("data-state", "true");
        // Which is to say: the second group's, not the first's.
        await expect(custom).toHaveAttribute("data-group", "1");
        // Nothing gets pushed into the context panel to hide a contradiction.
        await expect(diagram(page).locator('.annotation[data-key="custom"]')).toHaveCount(0);
    });

    test("an empty stage says whose conditions are missing", async ({ page }) => {
        // Both groups match; the slot runs under the one with no template, so
        // the stage is empty -- while the group beside it has a template the
        // reader wrote and can see failing on the very next slot. Unqualified,
        // "none configured" reads as "this automation has none" and is simply
        // disbelieved.
        await mountPanel(page, GROUP_WITHOUT_CUSTOM_WINS_PAYLOAD);
        await selectSlot(page, 0, "appliance_runtime");
        await expect(diagram(page).locator("svg.logic"))
            .toHaveAttribute("data-terminal", "execute");

        const custom = diagram(page).locator('g.block[data-id="custom"]');
        await expect(custom).toHaveAttribute("data-state", "n/a");
        // The group it ran under, named on the note itself.
        expect(await svgText(diagram(page).locator('text[data-stage="custom_none"]')))
            .toContain("Záporná cena");
        // And the fact that resolves the disbelief: another group does have
        // them, and this slot did not run under it.
        await expect(diagram(page).locator('text[data-stage="custom_other_group"]'))
            .toHaveCount(1);
    });

    test("no other group, no claim that another group has them", async ({ page }) => {
        // Nothing matched, so every group counts as "not the matched one" --
        // which on a lone group is enough to promise a second group that does
        // not exist.
        await mountPanel(page, LONE_GROUP_UNMATCHED_PAYLOAD);
        await selectSlot(page, 0, "appliance_runtime");
        await expect(diagram(page).locator("svg.logic"))
            .toHaveAttribute("data-terminal", "not_eligible");

        await expect(diagram(page).locator('g.block[data-id="custom"]'))
            .toHaveAttribute("data-state", "n/a");
        await expect(diagram(page).locator('text[data-stage="custom_none"]')).toHaveCount(1);
        await expect(diagram(page).locator('text[data-stage="custom_other_group"]'))
            .toHaveCount(0);
    });

    test("with no custom conditions the stage is still drawn, saying so", async ({ page }) => {
        // A stage that appears only when it has something to complain about is
        // a stage nobody can read: two slots of one automation, one with a
        // re-check column and one without, look like two different pipelines.
        await mountPanel(page, SINGLE_GROUP_PAYLOAD);
        await selectSlot(page, 0, "appliance_runtime");
        await expect(diagram(page).locator("svg.logic"))
            .toHaveAttribute("data-terminal", "execute");

        await expect(diagram(page).locator("line.stage-divider")).toHaveCount(1);
        await expect(diagram(page).locator('text.stage[data-stage="recheck"]')).toHaveCount(1);
        const custom = diagram(page).locator('g.block[data-id="custom"]');
        await expect(custom).toHaveCount(1);
        // None configured: the same reading a condition a group does not set
        // gets everywhere else on this drawing, and it takes no part in the AND.
        await expect(custom).toHaveAttribute("data-state", "n/a");
        await expect(custom).toHaveAttribute("data-decisive", "false");

        // Nothing is timed and nothing is retaken, so the two time notes give
        // way to the one line that is true.
        await expect(diagram(page).locator('text[data-stage="custom_none"]')).toHaveCount(1);
        await expect(diagram(page).locator('text[data-stage="custom_when"]')).toHaveCount(0);
        // Only one group here, so there is no other group to point at.
        await expect(diagram(page).locator('text[data-stage="custom_other_group"]'))
            .toHaveCount(0);
        await expect(diagram(page).locator('.legend-item[data-legend="no_custom"]')).toHaveCount(1);

        // And the result still hangs off the second stage, which resolves true
        // because an unconfigured stage vetoes nothing.
        await expect(diagram(page).locator('g.block[data-id="exec"]'))
            .toHaveAttribute("data-state", "true");
    });

    test("a candidate is planned, and its falsehood is the second stage", async ({ page }) => {
        await mountPanel(page);
        await openDiagram(page, 2);

        // The terminal that is neither a run nor a rejection: the planning
        // stage resolves *true* -- it was planned and placed -- and the
        // execution stage is what resolves false.
        const result = await andInvariant(page);
        expect(result.computed).toBe(result.final);
        expect(result.final).toBe("true");
        expect(result.exec).toBe("false");
        expect(result.terminal).toBe("candidate");

        await expect(diagram(page).locator('g.block[data-id="verdict"]'))
            .toHaveAttribute("data-state", "true");
        const custom = diagram(page).locator('g.block[data-id="custom"]');
        await expect(custom).toHaveAttribute("data-state", "false");
        await expect(custom).toHaveAttribute("data-decisive", "true");
        expect(await svgText(custom.locator("text.glyph"))).toBe("✗");

        // And the conditions that got it planned stay lit: "why is this
        // planned" is a separate question from "why is it only a candidate",
        // and it is answered on the same picture.
        const marks = await decisiveness(page);
        expect(marks.or).toBe("true");
    });

    test("an errored custom entry is not a failed one", async ({ page }) => {
        await mountPanel(page, ERRORED_CUSTOM_PAYLOAD);
        await selectSlot(page, 0, "appliance_runtime");

        // Fail-closed evaluation reports "threw" and "said no" identically. The
        // diagram keeps them apart: its own glyph, its own colour, its own
        // dash pattern.
        const custom = diagram(page).locator('g.block[data-id="custom"]');
        await expect(custom).toHaveAttribute("data-state", "errored");
        expect(await svgText(custom.locator("text.glyph"))).toBe("!");

        const errored = await custom.locator("rect.body").evaluate((node) => ({
            stroke: getComputedStyle(node).stroke,
            dash: getComputedStyle(node).strokeDasharray,
        }));

        await mountPanel(page);
        await openDiagram(page, 2);
        const failed = await diagram(page).locator('g.block[data-id="custom"] rect.body')
            .evaluate((node) => ({
                stroke: getComputedStyle(node).stroke,
                dash: getComputedStyle(node).strokeDasharray,
            }));
        expect(errored.stroke).not.toBe(failed.stroke);
        expect(errored.dash).not.toBe(failed.dash);
    });
});
