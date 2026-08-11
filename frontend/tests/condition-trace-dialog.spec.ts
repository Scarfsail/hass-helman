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
    controllableId: "appliance.pool",
    date: DATE,
    slotIds: [SLOT_ID],
    runAt: CELL_RUN_AT,
    optimizers: [{
        optimizerId: OPTIMIZER_ID,
        kind: OPTIMIZER_ID,
        controllableId: "appliance.pool",
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

/** The same slot with the matched group renamed -- or left unnamed. */
const withGroupLabel = (payload: typeof CANDIDATE_PAYLOAD, label: string) => ({
    ...payload,
    optimizers: [{
        ...payload.optimizers[0],
        groups: [{ ...payload.optimizers[0].groups[0], label }],
    }],
});

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
            // The backend hangs the entry's readings here; HA's pane dumps
            // every step key it does not recognise into its top block.
            params: { "sensor.pool_temp (Teplota bazénu)": "26.5 °C" },
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
            // An entity that no longer exists is kept, valued null -- that a
            // condition reads something absent is the reader's answer.
            params: { "binary_sensor.cover": "on", "sensor.gone": null },
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
        const loaded: string[] = [];
        (globalThis as Record<string, unknown>).__helmanTranslationsLoaded = loaded;
        const record = (kind: string, name: string) => loaded.push(`${kind}:${name}`);

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
            // Not decoration: `ha-trace-path-details` writes its tab names, its
            // step heading and its "executed at" line through the `config`
            // translation fragment, and the condition's own name through the
            // `conditions` backend category. A dashboard loads neither, and
            // omitting them from the stub is what let a pane rendering nothing
            // but a raw `result:` block pass every spec here.
            loadFragmentTranslation: async (fragment: string) => {
                record("fragment", fragment);
            },
            loadBackendTranslation: async (category: string) => {
                record("backend", category);
                return (key: string) => key;
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

    /*
     * A stub cannot prove what HA's real pane *looks* like, so this pins the
     * inputs it needs instead. Measured in a live dashboard: before these load,
     * `trace.tabs.step_config` is `""` and `describeCondition` answers "unknown
     * condition", leaving a pane whose only visible text is the raw `result:`
     * block; after, the tabs, the heading, the executed-at line and the
     * condition's name all render. The chunk walk brings neither.
     */
    test("opening the trace loads the translations its renderer writes through", async ({ page }) => {
        await mountPanel(page, { trace: TRACE_PAYLOAD });
        await customBlock(page).click();
        await expect(dialog(page).locator("hat-script-graph")).toHaveCount(1);

        const loaded = await page.evaluate(
            () => (globalThis as Record<string, unknown>).__helmanTranslationsLoaded ?? [],
        );
        expect(loaded).toContain("fragment:config");
        expect(loaded).toContain("backend:conditions");
    });

    /*
     * Loading translations replaces the `hass` on `<home-assistant>`, so the
     * reference a card is holding keeps a localize that answers "" forever.
     * The pane must get the refreshed one, not the element's own property.
     */
    test("the pane is given the localize that saw the translations land", async ({ page }) => {
        await mountPanel(page, { trace: TRACE_PAYLOAD });
        await customBlock(page).click();

        const usesRefreshed = await page.evaluate(() => {
            const dlg = document
                .querySelector("scheduling-explanation-panel")!
                .shadowRoot!.querySelector("scheduling-condition-trace-dialog")!;
            const details = dlg.shadowRoot!.querySelector("ha-trace-path-details") as
                HTMLElement & { hass?: { localize?: unknown } };
            const own = (dlg as HTMLElement & { hass?: { localize?: unknown } }).hass;
            return details?.hass?.localize !== undefined
                && details?.hass?.localize !== own?.localize;
        });
        expect(usesRefreshed).toBe(true);
    });

    // The evaluation is dated and never compared against the row's own run: the
    // reality check re-evaluates on every execution cycle, so a "newer than the
    // row" warning fired on every slot and said nothing.
    test("the evaluation is dated, whichever run it came from", async ({ page }) => {
        await mountPanel(page, { trace: { ...TRACE_PAYLOAD, runAt: LATER_RUN_AT } });
        await customBlock(page).click();

        await expect(dialog(page).locator(".run-at")).toHaveCount(1);
    });

    // The heading goes to `ha-dialog` as a property, so it is read off the
    // element rather than off the rendered text: the stub draws no chrome.
    const heading = (page: Page) => page.evaluate(() => document
        .querySelector("scheduling-explanation-panel")!
        .shadowRoot!.querySelector("scheduling-condition-trace-dialog")!
        .shadowRoot!.querySelector<HTMLElement & { heading: string }>("ha-dialog")!
        .heading);

    test("the title leads with the group the reader pressed", async ({ page }) => {
        await mountPanel(page, { trace: TRACE_PAYLOAD });
        await customBlock(page).click();

        expect(await heading(page)).toBe("Studený bazén – scheduling.explanation.diagram.trace.title");
    });

    test("an unnamed group still leads with something", async ({ page }) => {
        await mountPanel(page, {
            trace: TRACE_PAYLOAD,
            fixture: withGroupLabel(CANDIDATE_PAYLOAD, ""),
        });
        await customBlock(page).click();

        // `_groupLabel` falls back to "Skupina N"; localize is the identity here.
        expect(await heading(page)).toContain("scheduling.explanation.matrix.group 1");
    });

    // This dialog is mounted inside the day editor's own `ha-dialog`, and both
    // use the name `closed`. Left to travel, one press shut both of them.
    test.describe("closing it leaves the editor behind it open", () => {
        const countAncestorClosed = async (page: Page) => page.evaluate(() => {
            const panel = document.querySelector("scheduling-explanation-panel")!;
            const outer = panel.parentElement as HTMLElement & { seen?: number };
            return outer.seen ?? 0;
        });

        const watchAncestor = async (page: Page) => page.evaluate(() => {
            const panel = document.querySelector("scheduling-explanation-panel")!;
            const outer = panel.parentElement as HTMLElement & { seen?: number };
            outer.seen = 0;
            outer.addEventListener("closed", () => { outer.seen! += 1; });
        });

        test("the footer button's notification does not travel", async ({ page }) => {
            await mountPanel(page, { trace: TRACE_PAYLOAD });
            await customBlock(page).click();
            await watchAncestor(page);

            await dialog(page).locator("ha-dialog-footer ha-button").click();

            await expect(dialog(page)).toHaveCount(0);
            expect(await countAncestorClosed(page)).toBe(0);
        });

        test("the inner dialog's own closed event stops here", async ({ page }) => {
            await mountPanel(page, { trace: TRACE_PAYLOAD });
            await customBlock(page).click();
            await watchAncestor(page);

            // What a scrim click or Esc does in the real component. The dialog
            // sits in the panel's shadow root, so getting to it is a walk.
            await page.evaluate(() => {
                document
                    .querySelector("scheduling-explanation-panel")!
                    .shadowRoot!.querySelector("scheduling-condition-trace-dialog")!
                    .shadowRoot!.querySelector<HTMLElement & { close: () => void }>("ha-dialog")!
                    .close();
            });

            expect(await countAncestorClosed(page)).toBe(0);
        });
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

/**
 * The readings an entity platform condition leaves out of the trace.
 *
 * HA records `state` beside `wanted_state_above` only for its legacy function
 * conditions; the entity-condition base classes make no trace calls at all, so a
 * `temperature.is_value` step carries its verdict and nothing else. These pin
 * the block that fills that gap -- and, more importantly, that it is keyed by
 * *entry* rather than by node, so a nested selection still finds it.
 */
test.describe("the readings behind the selected condition", () => {
    /**
     * Move the detail pane onto a node the stub graph does not draw itself.
     *
     * Announced through the graph, as the real one would, so the dialog's own
     * listener is what moves the selection. The dialog sits in the panel's
     * shadow root, which `document.querySelector` does not reach.
     */
    async function selectPath(page: Page, path: string): Promise<void> {
        await expect(dialog(page).locator("hat-script-graph")).toHaveCount(1);
        await page.evaluate((target) => {
            const graph = document
                .querySelector("scheduling-explanation-panel")!
                .shadowRoot!.querySelector("scheduling-condition-trace-dialog")!
                .shadowRoot!.querySelector("hat-script-graph")!;
            graph.dispatchEvent(new CustomEvent("graph-node-selected", {
                detail: { path: target, config: {}, type: "condition" },
                bubbles: true,
                composed: true,
            }));
        }, path);
    }

    /** What the pane was handed for the selected node, beyond HA's own keys. */
    function restDump(page: Page) {
        return dialog(page).locator("ha-trace-path-details pre.rest");
    }

    test("the selected entry's readings reach the detail pane", async ({ page }) => {
        await mountPanel(page, { trace: TRACE_PAYLOAD });
        await customBlock(page).click();

        // Not drawn by us: `params` is an unrecognised step key, and that is
        // exactly why HA's pane renders it in the block above the tabs.
        await expect(restDump(page)).toHaveCount(1);
        await expect(restDump(page)).toContainText("sensor.pool_temp (Teplota bazénu)");
        await expect(restDump(page)).toContainText("26.5 °C");
    });

    test("an entity that no longer exists still reaches it, valued null", async ({ page }) => {
        await mountPanel(page, { trace: TRACE_PAYLOAD });
        await customBlock(page).click();
        await selectPath(page, "condition/1");

        await expect(restDump(page)).toContainText("binary_sensor.cover");
        await expect(restDump(page)).toContainText('"sensor.gone":null');
    });

    test("a node whose step carries no readings adds nothing", async ({ page }) => {
        await mountPanel(page, { trace: TRACE_PAYLOAD });
        await customBlock(page).click();
        await selectPath(page, "condition/1/conditions/0");

        await expect(restDump(page)).toHaveCount(0);
    });
});
