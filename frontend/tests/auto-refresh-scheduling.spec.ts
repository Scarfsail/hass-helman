import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The scheduling card following the backend's announcements.
 *
 * The card used to load once and sit: a plan re-optimized at 10:15, or edited
 * from another machine, stayed invisible until someone pressed refresh. It now
 * subscribes to `helman_data_changed` and reloads on it.
 *
 * Two things are worth pinning, and they pull against each other:
 *
 * - **An announcement has to actually reach the card.** Not the shared owner's
 *   internals — the rendered header, which is what the user is looking at.
 * - **A burst has to arrive as one reload.** A single automation run fires more
 *   than one event (the schedule write and the run-result record are separate),
 *   and horizon pruning during the reload can add another. Reloading per event
 *   would triple the traffic for one re-plan.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

/** Comfortably past the feed's collect window, so a flush has certainly run. */
const AFTER_COLLECT_WINDOW_MS = 700;

declare global {
    interface Window {
        __scheduleCalls: string[];
        /** Push an event through the card's own subscription, as HA would. */
        __fireDataChanged: (kind: string) => void;
        /** Swap what the next `helman/get_schedule` returns. */
        __setExecutionEnabled: (enabled: boolean) => void;
    }
}

/**
 * Mount the card against a fake backend whose schedule can be changed
 * underneath it, and whose connection delivers events the way HA's does.
 */
async function mountCard(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-scheduling-card"));

    await page.evaluate(() => {
        const slotStart = new Date();
        slotStart.setMinutes(slotStart.getMinutes() < 30 ? 0 : 30, 0, 0);
        const slots = Array.from({ length: 6 }, (_, index) => ({
            id: new Date(slotStart.getTime() + index * 1_800_000).toISOString(),
            domains: { inverter: { kind: "empty" }, appliances: {} },
        }));

        const schedule = { executionEnabled: true, slots };

        // The card reloads its forecast whenever the schedule object changes,
        // and draws straight off these blocks — an empty stub would throw in
        // render and mask the very re-render this spec is about.
        const emptyForecast = {
            solar: {
                status: "unavailable",
                unit: "Wh",
                resolution: "hour",
                horizonHours: 0,
                actualHistory: [],
                points: [],
            },
            grid: {
                status: "unavailable",
                generatedAt: null,
                unit: "kWh",
                resolution: "hour",
                horizonHours: 0,
                startedAt: null,
                partialReason: null,
                coverageUntil: null,
                currentImportPrice: null,
                importPriceUnit: null,
                importPricePoints: [],
                currentExportPrice: null,
                exportPriceUnit: null,
                exportPricePoints: [],
                series: [],
            },
            house_consumption: {
                status: "unavailable",
                generatedAt: null,
                unit: "Wh",
                resolution: "hour",
                horizonHours: 0,
                trainingWindowDays: 0,
                historyDaysAvailable: 0,
                requiredHistoryDays: 0,
                model: null,
                actualHistory: [],
                series: [],
            },
            battery_capacity: {
                status: "unavailable",
                generatedAt: null,
                startedAt: null,
                unit: "kWh",
                resolution: "hour",
                horizonHours: 0,
                model: null,
                nominalCapacityKwh: 10,
                currentRemainingEnergyKwh: 5,
                currentSoc: 50,
                minSoc: 10,
                maxSoc: 100,
                chargeEfficiency: 1,
                dischargeEfficiency: 1,
                maxChargePowerW: 5000,
                maxDischargePowerW: 5000,
                partialReason: null,
                coverageUntil: null,
                actualHistory: [],
                series: [],
            },
        };
        window.__setExecutionEnabled = (enabled: boolean) => {
            schedule.executionEnabled = enabled;
        };

        window.__scheduleCalls = [];
        const listeners: Array<(event: unknown) => void> = [];
        window.__fireDataChanged = (kind: string) => {
            for (const listener of listeners) {
                listener({ event_type: "helman_data_changed", data: { kind } });
            }
        };

        const el = document.createElement("helman-scheduling-card") as HTMLElement &
            Record<string, unknown>;
        (el as unknown as { setConfig: (c: unknown) => void }).setConfig({
            type: "custom:helman-scheduling-card",
        });
        el.hass = {
            language: "en",
            locale: { language: "en" },
            config: { time_zone: "UTC" },
            connection: {
                sendMessagePromise: async (msg: { type: string }) =>
                    msg.type === "helman/get_forecast" ? emptyForecast : {},
                subscribeEvents: async (
                    listener: (event: unknown) => void,
                    eventType: string,
                ) => {
                    if (eventType !== "helman_data_changed") {
                        return () => undefined;
                    }
                    listeners.push(listener);
                    return () => {
                        listeners.splice(listeners.indexOf(listener), 1);
                    };
                },
            },
            states: {},
            callWS: async (msg: { type: string }) => {
                if (msg.type === "helman/get_schedule") {
                    window.__scheduleCalls.push(msg.type);
                    return JSON.parse(JSON.stringify(schedule));
                }
                if (msg.type === "helman/get_appliances") return { appliances: [] };
                if (msg.type === "helman/get_controllable_entities") return { entities: [] };
                if (msg.type === "helman/get_last_automation_run") return { result: null };
                return {};
            },
        };
        document.body.appendChild(el);
    });

    // The card is up once it has drawn a header off its first schedule read.
    await page.waitForFunction(() => window.__scheduleCalls.length === 1);
    await expect.poll(() => readExecutionSwitch(page)).toBe(true);
}

/** What the header's execution switch is currently showing. */
function readExecutionSwitch(page: Page): Promise<boolean | null> {
    return page.evaluate(() => {
        const header = document
            .querySelector("helman-scheduling-card")
            ?.shadowRoot?.querySelector("scheduling-card-header");
        const control = header?.shadowRoot?.querySelector("ha-switch") as
            | (Element & { checked?: boolean })
            | null;
        return control ? control.checked === true : null;
    });
}

test("an announced change reaches the rendered header", async ({ page }) => {
    await mountCard(page);

    // Somebody else turned execution off — on another tab, or the backend did
    // it. The card has no idea yet.
    await page.evaluate(() => window.__setExecutionEnabled(false));
    expect(await readExecutionSwitch(page)).toBe(true);

    await page.evaluate(() => window.__fireDataChanged("schedule"));

    await expect.poll(() => readExecutionSwitch(page)).toBe(false);
    expect(await page.evaluate(() => window.__scheduleCalls.length)).toBe(2);
});

test("a burst of announcements costs one reload", async ({ page }) => {
    await mountCard(page);

    // What one automation run looks like on the bus: the schedule write and the
    // run-result record, back to back.
    await page.evaluate(() => window.__fireDataChanged("schedule"));
    await page.waitForTimeout(50);
    await page.evaluate(() => window.__fireDataChanged("plan"));

    await page.waitForTimeout(AFTER_COLLECT_WINDOW_MS);

    expect(await page.evaluate(() => window.__scheduleCalls.length)).toBe(2);
});
