import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { HA_PANEL_RESOLVER_FAILING_STUB, HA_TRACE_STUB } from "./support/ha-trace-stub";

/**
 * The custom-conditions block, opened into its last evaluation.
 *
 * The diagram's custom block reports one tri-state — held, did not hold, blew
 * up — which says a slot is a candidate and never says why. This is the rest of
 * the answer, and what is pinned here is the seam between the two halves:
 *
 * - **The block is a control exactly when there is something behind it.** A
 *   matched group with no custom conditions has nothing recorded, so the block
 *   must not offer to open anything — an empty dialog is worse than an inert
 *   block with a hint under it saying why it is empty.
 * - **The synthetic trace indexes onto the real paths.** HA's renderer walks
 *   `config.conditions` and looks each entry up at `condition/<i>`, which is
 *   the shape the backend re-roots every entry to. Getting that wrong draws a
 *   tree of untracked nodes and no error at all.
 * - **Missing nodes are normal.** Conditions short-circuit, so a configured
 *   condition with no trace entry is a condition that was never reached, not a
 *   bug — it renders, untracked.
 * - **Nothing is claimed about which run it was.** Only the newest evaluation
 *   is kept while the explanation record accumulates, so a trace newer than the
 *   row that opened it has to say so.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const DATE = "2026-07-31";
const SLOT_ID = `${DATE}T14:00:00+02:00`;
/** When the run that wrote this row happened. */
const CELL_RUN_AT = `${DATE}T13:45:00+02:00`;
/** A later run, whose evaluation is the only one the backend still holds. */
const LATER_RUN_AT = `${DATE}T18:30:00+02:00`;

const OPTIMIZER_ID = "appliance_runtime";

/**
 * One slot whose group matched and whose custom conditions said no: a candidate.
 *
 * The case the dialog exists for — the slot is planned and will not run, and
 * the block alone cannot say which condition refused.
 */
const CANDIDATE_PAYLOAD = {
    targetKey: "appliance.pool",
    date: DATE,
    slotIds: [SLOT_ID],
    runAt: CELL_RUN_AT,
    optimizers: [{
        optimizerId: OPTIMIZER_ID,
        kind: OPTIMIZER_ID,
        targetKey: "appliance.pool",
        status: "ok",
        runAt: [[CELL_RUN_AT, 1]],
        verdict: [["candidate", 1]],
        groups: [{
            index: 0,
            label: "Studený bazén",
            paramsSource: [["slot_matched", 1]],
            params: [[{ max_run_price: 2.0 }, 1]],
            customResults: [[[false], 1]],
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

/** The same slot, whose matched group configures no custom conditions at all. */
const NO_CUSTOM_PAYLOAD = {
    ...CANDIDATE_PAYLOAD,
    optimizers: [{
        ...CANDIDATE_PAYLOAD.optimizers[0],
        verdict: [["execute", 1]],
        groups: [{
            ...CANDIDATE_PAYLOAD.optimizers[0].groups[0],
            customResults: undefined,
        }],
    }],
};

/**
 * Two configured conditions, one of them a nest that short-circuited.
 *
 * `condition/1/conditions/1` is deliberately absent: the `and`'s first child
 * was false, so its second was never evaluated and HA recorded nothing for it.
 */
const TRACE_PAYLOAD = {
    optimizerId: OPTIMIZER_ID,
    groupIndex: 0,
    runAt: CELL_RUN_AT,
    config: [
        { condition: "numeric_state", entity_id: "sensor.pool_temp", above: 24 },
        {
            condition: "and",
            conditions: [
                { condition: "state", entity_id: "binary_sensor.cover", state: "off" },
                { condition: "time", after: "09:00:00" },
            ],
        },
    ],
    trace: {
        "condition/0": [{
            path: "condition/0",
            timestamp: CELL_RUN_AT,
            result: { result: true },
        }],
        "condition/0/entity_id/0": [{
            path: "condition/0/entity_id/0",
            timestamp: CELL_RUN_AT,
            result: { result: true, state: 26.5, wanted_state_above: 24.0 },
        }],
        "condition/1": [{
            path: "condition/1",
            timestamp: CELL_RUN_AT,
            result: { result: false },
        }],
        "condition/1/conditions/0": [{
            path: "condition/1/conditions/0",
            timestamp: CELL_RUN_AT,
            result: { result: false, state: "on", wanted_state: "off" },
        }],
    },
};

interface MountOptions {
    /** The explanation record the panel is given. */
    fixture?: unknown;
    /** What `helman/get_condition_trace` answers with, or null for nothing. */
    trace?: unknown;
    /** Make the websocket refuse instead of answering. */
    reject?: string;
    /** Leave HA's trace tags undefined, so the chunk walk runs — and fails. */
    withoutTraceElements?: boolean;
}

/**
 * Mount the panel on one slot, with a backend that answers the trace query.
 *
 * The trace elements are stubbed *before* the bundle is asked for anything, so
 * `loadHaTrace()` finds both tags registered and returns without walking HA's
 * panel routers — which is what the real app does the second time round anyway.
 */
async function mountPanel(page: Page, options: MountOptions = {}): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    if (options.withoutTraceElements === true) {
        await page.addScriptTag({ content: HA_PANEL_RESOLVER_FAILING_STUB });
    } else {
        await page.addScriptTag({ content: HA_TRACE_STUB });
    }
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("scheduling-explanation-panel"));

    await page.evaluate(({ fixture, trace, reject, slotId }) => {
        const panel = document.createElement("scheduling-explanation-panel") as HTMLElement
            & Record<string, unknown>;
        panel.localize = (key: string) => key;
        panel.payload = fixture;
        panel.hass = {
            config: { time_zone: "Europe/Prague" },
            states: {},
            localize: (key: string) => key,
            callWS: async () => {
                if (reject !== undefined) {
                    throw new Error(reject);
                }
                return trace ?? null;
            },
        };
        panel.locale = "cs";
        panel.timeZone = "Europe/Prague";
        panel.slotId = slotId;
        document.body.appendChild(panel);
    }, {
        fixture: options.fixture ?? CANDIDATE_PAYLOAD,
        trace: options.trace ?? null,
        reject: options.reject,
        slotId: SLOT_ID,
    });

    await expect(page.locator("scheduling-logic-diagram svg.logic")).toHaveCount(1);
}

function customBlock(page: Page) {
    return page.locator('scheduling-logic-diagram g.block[data-id="custom"]');
}

function dialog(page: Page) {
    return page.locator("scheduling-condition-trace-dialog");
}

test.describe("the custom-conditions trace dialog", () => {
    test("the block opens the trace, with a node per configured condition", async ({ page }) => {
        await mountPanel(page, { trace: TRACE_PAYLOAD });

        await expect(customBlock(page)).toHaveAttribute("data-traceable", "true");
        await customBlock(page).click();

        const nodes = dialog(page).locator("hat-script-graph .node");
        await expect(nodes).toHaveCount(TRACE_PAYLOAD.config.length);
        // The paths the graph looked the conditions up at are the ones the
        // backend records — the whole reason HA's renderer can take this raw.
        await expect(nodes.nth(0)).toHaveAttribute("data-path", "condition/0");
        await expect(nodes.nth(1)).toHaveAttribute("data-path", "condition/1");
    });

    test("a condition the run never reached renders, untracked", async ({ page }) => {
        await mountPanel(page, {
            trace: {
                ...TRACE_PAYLOAD,
                // The first condition failed, so the second was never evaluated.
                trace: { "condition/0": TRACE_PAYLOAD.trace["condition/0"] },
            },
        });
        await customBlock(page).click();

        const nodes = dialog(page).locator("hat-script-graph .node");
        await expect(nodes).toHaveCount(2);
        await expect(nodes.nth(0)).toHaveAttribute("data-tracked", "true");
        await expect(nodes.nth(1)).toHaveAttribute("data-tracked", "false");
    });

    test("the detail pane opens on the first node the run reached", async ({ page }) => {
        await mountPanel(page, { trace: TRACE_PAYLOAD });
        await customBlock(page).click();

        await expect(dialog(page).locator("ha-trace-path-details"))
            .toHaveAttribute("data-selected", "condition/0");
    });

    test("the keyboard opens it too, as the button role promises", async ({ page }) => {
        await mountPanel(page, { trace: TRACE_PAYLOAD });

        await expect(customBlock(page)).toHaveAttribute("role", "button");
        await expect(customBlock(page)).toHaveAttribute("tabindex", "0");
        await customBlock(page).press("Enter");

        await expect(dialog(page).locator("hat-script-graph")).toHaveCount(1);
    });

    test("a group with no custom conditions offers nothing to open", async ({ page }) => {
        await mountPanel(page, { fixture: NO_CUSTOM_PAYLOAD, trace: TRACE_PAYLOAD });

        await expect(customBlock(page)).toHaveAttribute("data-state", "n/a");
        await expect(customBlock(page)).not.toHaveAttribute("data-traceable", "true");
        await expect(customBlock(page)).not.toHaveAttribute("role", "button");

        await customBlock(page).click();
        await expect(dialog(page)).toHaveCount(0);
    });

    test("nothing recorded says so, rather than drawing an empty tree", async ({ page }) => {
        await mountPanel(page, { trace: null });
        await customBlock(page).click();

        await expect(dialog(page).locator(".placeholder.empty")).toHaveCount(1);
        await expect(dialog(page).locator("hat-script-graph")).toHaveCount(0);
    });

    test("a refused query names the refusal, which is not the same as empty", async ({ page }) => {
        await mountPanel(page, { reject: "not_loaded" });
        await customBlock(page).click();

        const error = dialog(page).locator(".placeholder.error");
        await expect(error).toHaveCount(1);
        await expect(error).toContainText("not_loaded");
    });

    test("a trace from a later run than the row says so", async ({ page }) => {
        await mountPanel(page, { trace: { ...TRACE_PAYLOAD, runAt: LATER_RUN_AT } });
        await customBlock(page).click();

        await expect(dialog(page).locator(".stale-banner")).toHaveCount(1);
    });

    test("a trace from the row's own run claims nothing", async ({ page }) => {
        await mountPanel(page, { trace: TRACE_PAYLOAD });
        await customBlock(page).click();

        await expect(dialog(page).locator(".run-at")).toHaveCount(1);
        await expect(dialog(page).locator(".stale-banner")).toHaveCount(0);
    });

    test("HA's renderer missing falls back to the record, not to a blank box", async ({ page }) => {
        await mountPanel(page, { trace: TRACE_PAYLOAD, withoutTraceElements: true });
        await customBlock(page).click();

        const raw = dialog(page).locator("pre.raw");
        await expect(raw).toHaveCount(1);
        // The values are the point of the fallback: a reader who cannot get the
        // tree can still see what each node compared.
        await expect(raw).toContainText("wanted_state_above");
    });
});
