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
function conditionColumn(key: string, states: unknown[], actual: Record<string, unknown>) {
    return { key, scope: "slot", state: states, value: [[1.0, 4]], actual };
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

async function mountDialog(page: Page): Promise<void> {
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
    }, PAYLOAD);

    await page.waitForFunction(
        () => !!document.querySelector("scheduling-explanation-dialog")?.shadowRoot
            ?.querySelector("table.grid"),
    );
}

function diagram(page: Page) {
    return page.locator("scheduling-explanation-dialog scheduling-logic-diagram");
}

/** Drill to a slot's matrix, then press a node to open its diagram. */
async function openDiagram(page: Page, rowIndex: number, group = 0): Promise<void> {
    await page
        .locator("scheduling-explanation-dialog")
        .locator(`tbody tr[data-row="${rowIndex}"] td[data-optimizer="export_price"] .cell-body`)
        .click();
    await page
        .locator("scheduling-explanation-dialog scheduling-condition-matrix")
        .locator(`tbody tr[data-group="${group}"] td[data-condition="when_price_below"] .node`)
        .click();
    await expect(diagram(page).locator("svg.logic")).toHaveCount(1);
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
    test("a matrix node opens the diagram for that slot", async ({ page }) => {
        await mountDialog(page);
        await expect(diagram(page)).toHaveCount(0);

        await openDiagram(page, 1);
        // The matrix stays: the diagram is a drill, not a replacement.
        await expect(page.locator("scheduling-explanation-dialog scheduling-condition-matrix"))
            .toHaveCount(1);
        // The pressed condition is ringed so the diagram answers the question
        // that was actually asked.
        await expect(diagram(page).locator('g.block[data-focus="true"]').first())
            .toHaveAttribute("data-key", "when_price_below");
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
        await openDiagram(page, 0, 1);
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
        await openDiagram(page, 0, 1);

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
