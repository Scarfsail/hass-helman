import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The scheduling card's own "why" popover, after it stopped reading reason codes.
 *
 * It used to print `reason.detail || reason.code` and then the bare code again
 * underneath — a backend identifier the card kept a hand-maintained catalogue
 * for, and which said nothing about *which condition* decided the slot. It now
 * reads the structured condition record: the outcome, the optimizer that landed
 * the action, the condition that decided it, and what that condition saw.
 *
 * What is pinned here:
 *
 * - No raw reason code reaches the popover, at either of the two old sites.
 * - The condition is localized, not printed as its backend key.
 * - The rail-delta badges — the one thing still read off the run trace — keep
 *   rendering, through the relocated helpers and the relocated metric keys.
 * - Pressing "why" asks the card for the lane record it does not have yet.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const DAY = "2026-07-31";
const SLOT_IDS = [`${DAY}T14:00:00+02:00`, `${DAY}T14:30:00+02:00`];

/** Localized strings the popover must show instead of codes. */
const STRINGS: Record<string, string> = {
    "scheduling.explanation.condition.when_price_below": "Cena pod limitem",
    "scheduling.explanation.optimizer.export_price": "Zastavení exportu",
    "scheduling.explanation.outcome.wrote": "zapsáno",
    "scheduling.explanation.outcome.not_eligible": "nesplněné podmínky",
    "scheduling.metric.soc": "SoC baterie",
    "scheduling.why.title": "Proč?",
    "scheduling.why.no_change": "Tento běh hodnotu nezměnil.",
    "scheduling.why.automation_generic": "Podrobné zdůvodnění není k dispozici.",
};

/** The same run as the structured record the popover now reads. */
const EXPLANATION = {
    targetKey: "inverter",
    date: DAY,
    slotIds: SLOT_IDS,
    runAt: `${DAY}T20:15:00+02:00`,
    optimizers: [{
        optimizerId: "export_price",
        kind: "export_price",
        targetKey: "inverter",
        status: "ok",
        verdict: [["execute", 1], ["skip", 1]],
        winningOptimizer: { "0": "export_price" },
        groups: [{
            index: 0,
            label: "",
            paramsSource: [["slot_matched", 2]],
            params: [[{ min_export_price: 1.0 }, 2]],
            conditions: [{
                key: "when_price_below",
                scope: "slot",
                state: [["true", 1], ["false", 1]],
                value: [[1.0, 2]],
                actual: { "1": 3.4 },
            }],
        }],
    }],
};

function actionItem(slotId: string) {
    return {
        kind: "inverter",
        key: `inverter-${slotId}`,
        action: { kind: "stop_export" },
        firstSlotId: slotId,
        authorship: { state: "automation", counts: { automation: 1, user: 0 } },
    };
}

function slotRow(slotId: string, index: number) {
    return {
        kind: "slot",
        rowId: `row-${index}`,
        slot: { id: slotId, dayKey: DAY },
        actionCell: { items: [actionItem(slotId)], interactive: true },
        interactiveSlotId: slotId,
        displayTimeLabel: {
            leading: null,
            primary: index === 0 ? "14:00" : "14:30",
            trailing: null,
            hideLeading: false,
            hideTrailing: false,
        },
        rangeLabel: index === 0 ? "14:00–14:30" : "14:30–15:00",
        forecast: null,
        isCurrent: false,
        runtimeCompliance: null,
        variant: "raw",
        parentHourKey: null,
    };
}

const TABLE_MODEL = {
    columns: ["time", "action", "soc", "solar", "grid", "price"],
    sections: [{
        dayKey: DAY,
        dayLabel: "Pátek",
        dayAggregate: null,
        rows: SLOT_IDS.map((slotId, index) => slotRow(slotId, index)),
    }],
    forecast: {
        batteryAvailable: false,
        solarAvailable: false,
        gridAvailable: false,
        priceAvailable: false,
        priceDisplayUnit: null,
        rowScale: { solarMaxWh: 0, gridMaxAbsKwh: 0, priceMaxAbs: 0 },
        dayAggregateScale: { solarMaxWh: 0, gridMaxKwh: 0, priceMaxAbs: 0 },
    },
};

/**
 * Mount the slot table over the fixtures.
 *
 * `withRecord` decides whether the lane record is already cached, which is the
 * difference between "the popover explains the slot" and "the popover asks for
 * the record and shows its generic note in the meantime".
 */
async function mountTable(page: Page, withRecord: boolean): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("scheduling-slot-table"));

    await page.evaluate(
        ({ tableModel, explanation, strings, day, cached }) => {
            const table = document.createElement("scheduling-slot-table") as HTMLElement
                & Record<string, unknown>;
            table.localize = (key: string) => (strings as Record<string, string>)[key] ?? key;
            table.tableModel = tableModel;
            table.expandedDayKeys = [day];
            table.appliances = [];
            table.selectedSlotIds = [];
            table.automationModel = null;
            table.explanations = cached
                ? new Map([[`inverter|${day}`, explanation]])
                : new Map();
            (window as unknown as Record<string, unknown>).__requests = [];
            table.addEventListener("schedule-explanation-request", (event: Event) => {
                ((window as unknown as Record<string, unknown>).__requests as unknown[])
                    .push((event as CustomEvent).detail);
            });
            document.body.appendChild(table);
        },
        {
            tableModel: TABLE_MODEL,
            explanation: EXPLANATION,
            strings: STRINGS,
            day: DAY,
            cached: withRecord,
        },
    );

    await page.waitForFunction(
        () => !!document.querySelector("scheduling-slot-table")?.shadowRoot
            ?.querySelector(".why-badge"),
    );
}

/** Open the "why" popover on one row. */
async function openWhy(page: Page, rowIndex: number): Promise<void> {
    await page.locator("scheduling-slot-table .why-badge").nth(rowIndex).click();
    await expect(page.locator("scheduling-slot-table .why-popover")).toHaveCount(1);
}

test.describe("the scheduling card's why popover", () => {
    test("names the condition that decided the slot, localized", async ({ page }) => {
        await mountTable(page, true);
        await openWhy(page, 1);

        const detail = page.locator("scheduling-slot-table .why-detail");
        await expect(detail).toHaveAttribute("data-outcome", "not_eligible");
        await expect(detail.locator(".why-outcome")).toHaveText(/nesplněné podmínky/);
        // Localized, not the backend key.
        await expect(detail.locator(".why-condition")).toHaveText(/Cena pod limitem/);
        await expect(detail.locator(".why-condition"))
            .toHaveAttribute("data-condition", "when_price_below");
        // And what that condition actually saw.
        await expect(detail.locator(".why-actual")).toHaveText(/3\.40/);
    });

    test("renders no raw reason code at either old site", async ({ page }) => {
        await mountTable(page, true);
        await openWhy(page, 0);

        const popover = page.locator("scheduling-slot-table .why-popover");
        // The bare-code line is gone outright.
        await expect(popover.locator(".why-code")).toHaveCount(0);
        // And the detail line no longer falls back to the code either.
        const text = await popover.innerText();
        expect(text).not.toContain("price_below_threshold");
        expect(text).not.toContain("unexplained");
        expect(text).not.toContain("out_of_scope_default");

        // A written slot still says who wrote it, in words.
        await expect(popover.locator(".why-outcome")).toHaveText(/zapsáno/);
        await expect(popover.locator(".why-optimizer")).toHaveText(/Zastavení exportu/);
    });

    test("asks the card for a lane record it does not have", async ({ page }) => {
        await mountTable(page, false);
        await openWhy(page, 0);

        const requests = await page.evaluate(
            () => (window as unknown as Record<string, unknown>).__requests as Record<string, unknown>[],
        );
        expect(requests).toEqual([{ targetKey: "inverter", date: DAY }]);
        // Until it lands, the generic note — never a code.
        await expect(page.locator("scheduling-slot-table .why-note"))
            .toHaveText(/Podrobné zdůvodnění není k dispozici\./);
    });

    test("the rail-delta badges still render from the relocated helpers", async ({ page }) => {
        await mountTable(page, true);
        // Stands in for the run model the card builds from
        // `helman/get_last_automation_run` -- which now lives in the scheduling
        // card's own `model/automation-run-model`. What is pinned here is that
        // the delta path survived the move, keys and all.
        await page.evaluate(() => {
            const table = document.querySelector("scheduling-slot-table") as HTMLElement
                & Record<string, unknown>;
            table.automationModel = {
                explainAction: () => ({
                    attribution: "write",
                    deltas: [{
                        metric: { id: "soc", key: "batterySocPct", unit: "%", precision: 0, epsilon: 0.5 },
                        before: 60,
                        after: 72,
                    }],
                }),
            };
        });
        await openWhy(page, 0);

        const effect = page.locator("scheduling-slot-table .why-effect");
        await expect(effect).toHaveCount(1);
        // Relocated metric key: `scheduling.metric.*`, not `automation.inspector.*`.
        await expect(effect.locator(".why-effect-name")).toHaveText(/SoC baterie/);
        await expect(effect.locator(".why-effect-val")).toContainText("60");
        await expect(effect.locator(".why-effect-val")).toContainText("72");
    });
});
