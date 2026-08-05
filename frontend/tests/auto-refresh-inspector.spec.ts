import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The solar inspector refreshing under the user rather than at them.
 *
 * This is the surface the whole feature is about: watching the inspector at
 * 10:15 when the automation run rewrites the plan. Reusing the refresh button's
 * handler was not enough, because that handler is written for a *navigation* —
 * it nulls the payload and raises the loading note before the request, which
 * would blank the card on every backend re-plan.
 *
 * So there are two loads now, and the distinction is what these tests pin:
 *
 * - **A navigation blanks and says so.** The day being drawn is about to be a
 *   different day; pretending otherwise would show the wrong day's numbers
 *   under the new day's heading.
 * - **A refresh shows nothing at all until it lands.** No loading note, no
 *   vanished chart, and the day and slot the user picked are still picked
 *   afterwards — they never asked for this reload.
 *
 * The fake backend holds each inspector request open until the test releases
 * it, so "what is on screen while the request is in flight" is an assertion
 * rather than a race.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

/** Days the inspector offers, counting today as day 0. */
const PILL_DAYS = 4;

declare global {
    interface Window {
        /** Every date `helman/solar_bias/inspector` was asked for, in order. */
        __requestedDates: string[];
        /** Let the oldest still-pending inspector request return. */
        __releaseInspector: () => void;
        /** How many inspector requests are waiting to be released. */
        __pendingInspector: () => number;
        /** Change the solar total the next payload carries. */
        __setActualWh: (value: number) => void;
        __fireDataChanged: (kind: string) => void;
    }
}

async function mountInspector(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-inspector"));

    await page.evaluate(({ pillDays }) => {
        const dayMs = 86_400_000;
        const hourMs = 3_600_000;
        const todayMs = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
        const isoDay = (offset: number) =>
            new Date(todayMs + offset * dayMs).toISOString().slice(0, 10);

        const schedule = { executionEnabled: true, slots: [] };

        const forecast = {
            solar: {
                status: "available",
                unit: "Wh",
                resolution: "hour",
                horizonHours: pillDays * 24,
                actualHistory: [],
                points: Array.from({ length: pillDays * 24 }, (_, index) => ({
                    timestamp: new Date(todayMs + index * hourMs).toISOString(),
                    value: index % 24 >= 8 && index % 24 < 16 ? 800 : 0,
                })),
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

        let actualWh = 6000;
        window.__setActualWh = (value: number) => {
            actualWh = value;
        };

        // A day with real series, so the card draws its chart and totals rather
        // than the "no data" note — the note is indistinguishable from a blank.
        const inspectorPayload = (date: string) => ({
            date,
            timezone: "UTC",
            status: "ok",
            effectiveVariant: "adjusted",
            trainedAt: null,
            range: {
                minDate: isoDay(-7),
                maxDate: isoDay(pillDays - 1),
                canGoPrevious: true,
                canGoNext: date < isoDay(pillDays - 1),
                isToday: date === isoDay(0),
                isFuture: date > isoDay(0),
            },
            series: {
                raw: [],
                corrected: Array.from({ length: 24 }, (_, hour) => ({
                    slot: `${String(hour).padStart(2, "0")}:00`,
                    valueWh: hour >= 8 && hour < 16 ? 500 : 0,
                })),
                actual: [],
                invalidated: [],
                factors: [],
                impact: [],
                houseForecast: [],
                houseActual: [],
                houseActualBreakdown: [],
                batterySocForecast: [],
                batterySocActual: [],
                gridForecast: [],
                gridActual: [],
                batteryForecast: [],
                batteryActual: [],
            },
            totals: {
                rawWh: null,
                correctedWh: 4000,
                actualWh,
                houseForecastWh: null,
                houseActualWh: null,
                gridForecastWh: null,
                gridActualWh: null,
                batteryForecastWh: null,
                batteryActualWh: null,
            },
            availability: {
                hasRawForecast: false,
                hasCorrectedForecast: true,
                hasActuals: false,
                hasInvalidated: false,
                hasProfile: true,
                hasHouseForecast: false,
                hasHouseActual: false,
                hasBatterySocForecast: false,
                hasBatterySocActual: false,
                hasGridForecast: false,
                hasGridActual: false,
                hasBatteryForecast: false,
                hasBatteryActual: false,
            },
            houseUnmeasuredLabel: null,
            batterySocBounds: [],
            trainingExplainability: null,
        });

        window.__requestedDates = [];
        const pending: Array<() => void> = [];
        window.__pendingInspector = () => pending.length;
        window.__releaseInspector = () => {
            pending.shift()?.();
        };

        const listeners: Array<(event: unknown) => void> = [];
        window.__fireDataChanged = (kind: string) => {
            for (const listener of listeners) {
                listener({ event_type: "helman_data_changed", data: { kind } });
            }
        };

        const el = document.createElement("helman-solar-inspector") as HTMLElement &
            Record<string, unknown>;
        el.hass = {
            language: "en",
            locale: { language: "en" },
            config: { time_zone: "UTC" },
            connection: {
                sendMessagePromise: async (msg: { type: string }) =>
                    msg.type === "helman/get_forecast" ? forecast : {},
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
            callWS: async (msg: { type: string; date?: string }) => {
                if (msg.type === "helman/get_schedule") {
                    return schedule;
                }
                if (msg.type === "helman/solar_bias/inspector") {
                    const date = msg.date ?? "";
                    window.__requestedDates.push(date);
                    return new Promise((resolvePayload) => {
                        pending.push(() => resolvePayload(inspectorPayload(date)));
                    });
                }
                return {};
            },
        };
        document.body.appendChild(el);
    }, { pillDays: PILL_DAYS });

    // The first load is a navigation like any other: release it, then wait for
    // the chart it draws.
    await page.waitForFunction(() => window.__pendingInspector() === 1);
    await page.evaluate(() => window.__releaseInspector());
    await expect.poll(() => readCard(page)).toMatchObject({ hasChart: true });
}

type CardReadout = {
    hasChart: boolean;
    /** The `.note` blocks — the loading note is one of these. */
    notes: string[];
    /** The day pill currently pressed. */
    selectedDay: string;
    totals: string;
};

function readCard(page: Page): Promise<CardReadout> {
    return page.evaluate(() => {
        const root = document.querySelector("helman-solar-inspector")?.shadowRoot;
        const pills = root?.querySelector("helman-solar-day-pills")?.shadowRoot;
        const pressed = pills?.querySelector('.pill[aria-pressed="true"]');
        return {
            hasChart: !!root?.querySelector(".chart-wrap"),
            notes: Array.from(root?.querySelectorAll(".body > .note") ?? []).map(
                (note) => note.textContent?.trim() ?? "",
            ),
            selectedDay: pressed?.getAttribute("data-day") ?? "",
            totals: root?.querySelector(".metrics-section")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        };
    });
}

/** Leave today via the header's back-a-week button, as a user would. */
async function pressPreviousWeek(page: Page): Promise<void> {
    await page.evaluate(() => {
        const root = document.querySelector("helman-solar-inspector")?.shadowRoot;
        const arrows = root?.querySelectorAll(".week-arrow");
        (arrows?.[0] as HTMLButtonElement | undefined)?.click();
    });
}

test("a navigation blanks the card and says it is loading", async ({ page }) => {
    await mountInspector(page);
    const startingDay = (await readCard(page)).selectedDay;

    await pressPreviousWeek(page);
    await page.waitForFunction(() => window.__pendingInspector() === 1);

    // Mid-flight: the old day is gone rather than mislabelled as the new one.
    const inFlight = await readCard(page);
    expect(inFlight.hasChart).toBe(false);
    expect(inFlight.notes.length).toBe(1);

    await page.evaluate(() => window.__releaseInspector());
    await expect.poll(() => readCard(page)).toMatchObject({ hasChart: true });
    expect((await readCard(page)).selectedDay).not.toBe(startingDay);
});

test("an announced change refreshes the drawn day without disturbing it", async ({ page }) => {
    await mountInspector(page);

    // Leave today, so a refresh that quietly fell back to today would show up.
    await pressPreviousWeek(page);
    await page.waitForFunction(() => window.__pendingInspector() === 1);
    await page.evaluate(() => window.__releaseInspector());
    await expect.poll(() => readCard(page)).toMatchObject({ hasChart: true });

    const before = await readCard(page);
    const requestsBefore = await page.evaluate(() => window.__requestedDates.length);

    // The backend re-planned. Nothing the user did.
    // 9 kWh against the 6 kWh already drawn — far enough apart to survive the
    // card's rounding to one decimal.
    await page.evaluate(() => window.__setActualWh(9000));
    await page.evaluate(() => window.__fireDataChanged("plan"));
    await page.waitForFunction(
        (count) => window.__requestedDates.length === count + 1,
        requestsBefore,
    );

    // In flight, and the user cannot tell: same chart, same day, no note.
    const inFlight = await readCard(page);
    expect(inFlight.hasChart).toBe(true);
    expect(inFlight.notes).toEqual([]);
    expect(inFlight.selectedDay).toBe(before.selectedDay);

    // And it asked for the day being drawn, not for today.
    const requested = await page.evaluate(() => window.__requestedDates);
    expect(requested[requested.length - 1]).toBe(before.selectedDay);

    await page.evaluate(() => window.__releaseInspector());

    // The new numbers land, still on the day the user had picked.
    await expect.poll(async () => (await readCard(page)).totals).toContain("9.0 kWh");
    const after = await readCard(page);
    expect(after.totals).not.toBe(before.totals);
    expect(after.selectedDay).toBe(before.selectedDay);
    expect(after.hasChart).toBe(true);
});
