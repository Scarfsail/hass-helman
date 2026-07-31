import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";

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
                paramsSource: [["slot_matched", 4]],
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

async function mountDialog(page: Page, fixture: unknown = PAYLOAD): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("scheduling-explanation-dialog"));

    await page.evaluate((fixture) => {
        const dialog = document.createElement("scheduling-explanation-dialog") as HTMLElement
            & Record<string, unknown>;
        dialog.localize = (key: string) => key;
        dialog.payload = fixture;
        dialog.laneName = "Střídač";
        dialog.locale = "cs";
        dialog.timeZone = "Europe/Prague";
        dialog.open = true;
        document.body.appendChild(dialog);
    }, fixture);

    await page.waitForFunction(
        () => !!document.querySelector("scheduling-explanation-dialog")?.shadowRoot
            ?.querySelector("table.grid"),
    );
}

/** An SVG `<text>`'s content: `innerText` is an HTML-only property. */
async function svgText(locator: ReturnType<Page["locator"]>): Promise<string> {
    return (await locator.evaluate((node) => node.textContent ?? ""))
        .replace(/\s+/g, " ")
        .trim();
}

function diagram(page: Page) {
    return page.locator("scheduling-explanation-dialog scheduling-logic-diagram");
}

/**
 * Open a slot's diagram.
 *
 * One click, not two: the level-2 matrix that used to sit between the grid and
 * the diagram is no longer mounted, so the grid cell *is* the drill.
 */
async function openDiagram(page: Page, rowIndex: number): Promise<void> {
    await selectSlot(page, rowIndex, "export_price");
}

/** Open a slot's diagram the way a reader does: by pressing the level-1 cell. */
async function selectSlot(page: Page, rowIndex: number, optimizerId: string): Promise<void> {
    await page
        .locator("scheduling-explanation-dialog")
        .locator(`tbody tr[data-row="${rowIndex}"] td[data-optimizer="${optimizerId}"] .cell-body`)
        .click();
    await expect(diagram(page).locator("svg.logic")).toHaveCount(1);
}

/**
 * Recompute the drawn AND and compare it with the drawn terminal.
 *
 * The single invariant the whole picture rests on: whatever is wired into the
 * final `&` must resolve to the terminal's own truth value. A `✗` input above
 * a `✓ spustit` terminal is the diagram calling itself a liar, and it is the
 * failure a real reader hit first.
 */
async function andInvariant(page: Page): Promise<{
    inputs: string[];
    computed: string;
    final: string;
    terminal: string;
}> {
    return diagram(page).locator("svg.logic").evaluate((svg) => {
        const inputIds = Array.from(svg.querySelectorAll('path.edge[data-to="final"]'))
            .map((edge) => edge.getAttribute("data-from") ?? "");
        const states = inputIds.map((id) =>
            svg.querySelector(`g.block[data-id="${id}"]`)?.getAttribute("data-state") ?? "");
        const considered = states.filter((state) => state !== "not_applicable" && state !== "n/a");
        const computed = considered.length === 0
            ? "true"
            : considered.includes("false") || considered.includes("errored")
                ? "false"
                : considered.includes("not_evaluated")
                    ? "not_evaluated"
                    : "true";
        return {
            inputs: inputIds,
            computed,
            final: svg.querySelector('g.block[data-id="final"]')?.getAttribute("data-state") ?? "",
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
    test("a grid cell opens the diagram, with no matrix in between", async ({ page }) => {
        await mountDialog(page);
        await expect(diagram(page)).toHaveCount(0);

        await openDiagram(page, 1);
        // The level-2 matrix is gone: it restated as a table of marks what the
        // diagram draws as a chain, and readers had to walk through it.
        await expect(page.locator("scheduling-explanation-dialog scheduling-condition-matrix"))
            .toHaveCount(0);
        // With nothing pressed the diagram still opens on a branch, rather than
        // on none.
        await expect(diagram(page).locator('g.block[data-focus-group="true"]').first())
            .toHaveCount(1);
    });

    test("a false AND marks only its false inputs decisive", async ({ page }) => {
        await mountDialog(page);
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
        await mountDialog(page);
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
        await mountDialog(page);

        await openDiagram(page, 2);
        await expect(diagram(page).locator("svg.logic")).toHaveAttribute("data-terminal", "candidate");
        // A candidate is decided by the custom condition, not by the mask: the
        // group matched, and the template said no.
        const candidateMarks = await decisiveness(page);
        expect(candidateMarks.custom).toBe("true");
        expect(candidateMarks.or).toBe("false");
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
        await mountDialog(page);
        await openDiagram(page, 3);

        await expect(diagram(page).locator("svg.logic")).toHaveAttribute("data-terminal", "blocked");
        const marks = await decisiveness(page);
        // Every condition passed; the veto is the only thing that decided it.
        expect(marks["gate-0"]).toBe("true");
        expect(marks.or).toBe("false");
    });

    test("branches that did not matter are dimmed, not removed", async ({ page }) => {
        await mountDialog(page);
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
        await mountDialog(page);
        for (const rowIndex of [0, 1, 2, 3]) {
            await selectSlot(page, rowIndex, "export_price");
            const result = await andInvariant(page);
            // The final block is what the drawn inputs actually say.
            expect(result.computed, `row ${rowIndex} inputs ${result.inputs.join()}`)
                .toBe(result.final);
            // And that is true exactly when the terminal says the slot ran.
            expect(result.final === "true", `row ${rowIndex}`)
                .toBe(result.terminal === "execute");
        }

        await mountDialog(page, SINGLE_GROUP_PAYLOAD);
        for (const rowIndex of [0, 1]) {
            await selectSlot(page, rowIndex, "appliance_runtime");
            const result = await andInvariant(page);
            expect(result.computed, `appliance row ${rowIndex}`).toBe(result.final);
            expect(result.final === "true", `appliance row ${rowIndex}`)
                .toBe(result.terminal === "execute");
        }
    });

    test("an informational false gate is context, not an AND input", async ({ page }) => {
        await mountDialog(page, SINGLE_GROUP_PAYLOAD);
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
        await mountDialog(page, SINGLE_GROUP_PAYLOAD);
        await selectSlot(page, 0, "appliance_runtime");

        // Nothing to choose between: the group's own AND wires straight on.
        await expect(diagram(page).locator('g.block[data-kind="or"]')).toHaveCount(0);
        const ops = await diagram(page).locator("text.op")
            .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() ?? ""));
        expect(ops).not.toContain("≥1");
        await expect(diagram(page).locator('path.edge[data-from="and-0"][data-to="final"]'))
            .toHaveCount(1);

        // Three groups still get one.
        await mountDialog(page);
        await selectSlot(page, 0, "export_price");
        await expect(diagram(page).locator('g.block[data-kind="or"]')).toHaveCount(1);
    });

    test("an object actual never escapes its block", async ({ page }) => {
        await mountDialog(page, SINGLE_GROUP_PAYLOAD);
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
        await mountDialog(page, SINGLE_GROUP_PAYLOAD);
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
        await mountDialog(page);
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
        await mountDialog(page);
        await openDiagram(page, 0);

        // Group 1 passed, so the record carries no `actual` for it at all --
        // the backend omits it by design. The threshold is what can be shown.
        const block = diagram(page)
            .locator('g.block[data-group="1"][data-key="when_price_below"]');
        await expect(block).toHaveAttribute("data-state", "true");
        expect(await svgText(block.locator("text.comparison"))).toBe("< 2");
    });

    test("the two sides read differently, and not by colour alone", async ({ page }) => {
        await mountDialog(page);
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
        await mountDialog(page, SINGLE_GROUP_PAYLOAD);
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
        await mountDialog(page);
        await openDiagram(page, 0);

        const labels = await diagram(page).locator("text.group-label")
            .evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() ?? ""));
        expect(labels).toEqual(["Ráno", "Poledne", "Večer"]);

        // One group has nothing to be told apart from, so it gets no caption.
        await mountDialog(page, SINGLE_GROUP_PAYLOAD);
        await selectSlot(page, 0, "appliance_runtime");
        await expect(diagram(page).locator("text.group-label")).toHaveCount(0);
    });

    test("the custom conditions are their own stage before the result", async ({ page }) => {
        await mountDialog(page);
        // 14:00: every mandatory condition passed and the template said no.
        await openDiagram(page, 2);
        await expect(diagram(page).locator("svg.logic"))
            .toHaveAttribute("data-terminal", "candidate");

        // Its own captioned column, saying when it is checked.
        await expect(diagram(page).locator('text.stage[data-stage="custom"]')).toHaveCount(1);
        await expect(diagram(page).locator('text[data-stage="custom_when"]')).toHaveCount(1);

        // Last before the `&`, and after every gate.
        const geometry = await diagram(page).locator("svg.logic").evaluate((svg) => {
            const x = (selector: string) => {
                const rect = svg.querySelector(`${selector} rect.body`) as SVGRectElement | null;
                return rect === null ? null : rect.x.baseVal.value;
            };
            return {
                custom: x('g.block[data-id="custom"]'),
                final: x('g.block[data-id="final"]'),
                gate: x('g.block[data-kind="gate"]'),
                or: x('g.block[data-id="or"]'),
            };
        });
        expect(geometry.custom).not.toBeNull();
        expect(geometry.custom!).toBeGreaterThan(geometry.or!);
        expect(geometry.custom!).toBeLessThan(geometry.final!);
        if (geometry.gate !== null) {
            expect(geometry.custom!).toBeGreaterThan(geometry.gate);
        }
    });

    test("a candidate's falsehood is the custom stage, and the AND says so", async ({ page }) => {
        await mountDialog(page);
        await openDiagram(page, 2);

        // The invariant, for the terminal that is neither a run nor a
        // rejection: the drawn AND resolves false, and the input that makes it
        // false is the custom stage.
        const result = await andInvariant(page);
        expect(result.inputs).toContain("custom");
        expect(result.computed).toBe(result.final);
        expect(result.final).toBe("false");
        expect(result.terminal).toBe("candidate");

        const custom = diagram(page).locator('g.block[data-id="custom"]');
        await expect(custom).toHaveAttribute("data-state", "false");
        await expect(custom).toHaveAttribute("data-decisive", "true");
        expect(await svgText(custom.locator("text.glyph"))).toBe("✗");
    });

    test("an errored custom entry is not a failed one", async ({ page }) => {
        await mountDialog(page, ERRORED_CUSTOM_PAYLOAD);
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

        await mountDialog(page);
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
