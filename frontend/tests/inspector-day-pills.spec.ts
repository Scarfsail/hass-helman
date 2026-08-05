import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The solar inspector's day pills.
 *
 * The row is the card's day picker *and* its comparison: one pill per day from
 * today to the end of the forecast, each drawing that whole day with the
 * schedule card's own gauges. What is worth pinning is exactly what makes it
 * usable — that every offered day gets a pill whether or not the schedule
 * reaches it, that the selected day is the highlighted one, that a click
 * actually loads the day, and that only solar writes its figure (the bars are
 * read as shapes; three numbers at pill width would be noise).
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

/** Days the inspector offers, counting today as day 0 — one pill each. As many
 * as a real horizon, since how the row copes with them is half of its design. */
const PILL_DAYS = 8;
/** Days the forecast reaches: short of the pills, so the last ones have no data. */
const FORECAST_DAYS = 6;
/** Days the schedule covers. It stops well before the forecast does, as in the
 * real house — the days between the two still have to fill their pills. */
const SCHEDULED_DAYS = 2;

async function loadCardBundle(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-inspector"));
}

/**
 * Mount the inspector against a fake backend: an empty-ish inspector day, a
 * two-day hourly schedule, and a forecast whose solar total falls day by day so
 * the pills' shared scale is visible in the bar widths.
 */
async function mountInspector(page: Page, minDaysBack = 30): Promise<void> {
    await page.evaluate(({ pillDays, forecastDays, scheduledDays, minDaysBack }) => {
        const dayMs = 86_400_000;
        const hourMs = 3_600_000;
        const todayMs = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
        const isoDay = (offset: number) => new Date(todayMs + offset * dayMs).toISOString().slice(0, 10);

        const slotIds: string[] = [];
        for (let day = 0; day < scheduledDays; day += 1) {
            for (let hour = 0; hour < 24; hour += 1) {
                slotIds.push(new Date(todayMs + day * dayMs + hour * hourMs).toISOString());
            }
        }

        const schedule = {
            executionEnabled: true,
            slots: slotIds.map((id) => ({
                id,
                domains: { inverter: { kind: "empty" }, appliances: {} },
            })),
        };

        // Solar halves each day; SoC and grid stay flat, so any difference in
        // the solar bars is the scale and not the data.
        const solarPoints: Array<{ timestamp: string; value: number }> = [];
        const batterySeries: Array<{ timestamp: string; durationHours: number; socPct: number }> = [];
        const gridSeries: Array<Record<string, unknown>> = [];
        for (let day = 0; day < forecastDays; day += 1) {
            for (let hour = 0; hour < 24; hour += 1) {
                const timestamp = new Date(todayMs + day * dayMs + hour * hourMs).toISOString();
                const daylight = hour >= 8 && hour < 16;
                solarPoints.push({
                    timestamp,
                    value: daylight ? 1000 / 2 ** day : 0,
                });
                batterySeries.push({ timestamp, durationHours: 1, socPct: 40 + hour });
                gridSeries.push({
                    timestamp,
                    durationHours: 1,
                    importedFromGridKwh: daylight ? 0 : 0.4,
                    exportedToGridKwh: daylight ? 0.6 : 0,
                    availableSurplusKwh: 0,
                });
            }
        }

        const forecast = {
            solar: {
                status: "available",
                unit: "Wh",
                resolution: "hour",
                horizonHours: forecastDays * 24,
                actualHistory: [],
                points: solarPoints,
            },
            grid: {
                status: "available",
                generatedAt: null,
                unit: "kWh",
                resolution: "hour",
                horizonHours: forecastDays * 24,
                startedAt: null,
                partialReason: null,
                coverageUntil: null,
                currentImportPrice: null,
                importPriceUnit: null,
                importPricePoints: [],
                currentExportPrice: null,
                exportPriceUnit: null,
                exportPricePoints: [],
                series: gridSeries,
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
                status: "available",
                generatedAt: null,
                startedAt: null,
                unit: "kWh",
                resolution: "hour",
                horizonHours: forecastDays * 24,
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
                series: batterySeries,
            },
        };

        // A day already lived through carries actuals instead of a schedule:
        // production, a measured SoC range, and grid samples signed the
        // payload's way — positive leaves the house's demand (export).
        const isPast = (date: string) => date < isoDay(0);
        const historySeries = (date: string) => isPast(date)
            ? {
                batterySocActual: [
                    { slot: "00:00", pct: 30 },
                    { slot: "12:00", pct: 84 },
                    { slot: "23:00", pct: 47 },
                ],
                gridActual: Array.from({ length: 24 }, (_, hour) => ({
                    timestamp: `${date}T${String(hour).padStart(2, "0")}:00:00Z`,
                    valueWh: hour >= 8 && hour < 16 ? 500 : -300,
                })),
            }
            : { batterySocActual: [], gridActual: [] };

        const inspectorPayload = (date: string) => ({
            date,
            timezone: "UTC",
            status: "ok",
            effectiveVariant: null,
            trainedAt: null,
            range: {
                minDate: isoDay(-minDaysBack),
                maxDate: isoDay(pillDays - 1),
                canGoPrevious: true,
                canGoNext: date < isoDay(pillDays - 1),
                isToday: date === isoDay(0),
                isFuture: date > isoDay(0),
            },
            series: {
                raw: [],
                corrected: [],
                actual: [],
                invalidated: [],
                factors: [],
                impact: [],
                houseForecast: [],
                houseActual: [],
                houseActualBreakdown: [],
                batterySocForecast: [],
                batterySocActual: historySeries(date).batterySocActual,
                gridForecast: [],
                gridActual: historySeries(date).gridActual,
                batteryForecast: [],
                batteryActual: [],
            },
            totals: {
                rawWh: null,
                correctedWh: null,
                actualWh: isPast(date) ? 6000 : null,
                houseForecastWh: null,
                houseActualWh: null,
                gridForecastWh: null,
                gridActualWh: null,
                batteryForecastWh: null,
                batteryActualWh: null,
            },
            availability: {
                hasRawForecast: false,
                hasCorrectedForecast: false,
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

        const requestedDates: string[] = [];
        (window as unknown as Record<string, unknown>).__requestedDates = requestedDates;
        /** Every `start..end` the day-aggregate read was asked for, in order. */
        const requestedRanges: string[] = [];
        (window as unknown as Record<string, unknown>).__requestedRanges = requestedRanges;

        const el = document.createElement("helman-solar-inspector") as HTMLElement & Record<string, unknown>;
        el.hass = {
            language: "en",
            locale: { language: "en" },
            config: { time_zone: "UTC" },
            connection: {
                sendMessagePromise: async (msg: { type: string }) =>
                    msg.type === "helman/get_forecast" ? forecast : {},
            },
            states: {},
            callWS: async (msg: {
                type: string;
                date?: string;
                start_date?: string;
                end_date?: string;
            }) => {
                if (msg.type === "helman/get_schedule") {
                    return schedule;
                }
                if (msg.type === "helman/solar_bias/inspector") {
                    requestedDates.push(msg.date ?? "");
                    return inspectorPayload(msg.date ?? "");
                }
                // The whole-day figures behind a past week's pills: one read for
                // the window, and the meters have nothing beyond today.
                if (msg.type === "helman/solar_bias/day_aggregates") {
                    const start = msg.start_date ?? "";
                    const end = msg.end_date ?? "";
                    requestedRanges.push(`${start}..${end}`);
                    const days: unknown[] = [];
                    for (
                        let cursor = Date.parse(`${start}T00:00:00Z`);
                        cursor <= Date.parse(`${end}T00:00:00Z`);
                        cursor += dayMs
                    ) {
                        const day = new Date(cursor).toISOString().slice(0, 10);
                        if (!isPast(day)) {
                            continue;
                        }
                        days.push({
                            date: day,
                            solarWh: 6000,
                            gridImportKwh: 3.2,
                            gridExportKwh: 1.4,
                            batteryMinSocPct: 30,
                            batteryMaxSocPct: 84,
                        });
                    }
                    return { days };
                }
                return {};
            },
        };
        document.body.appendChild(el);
    }, {
        pillDays: PILL_DAYS,
        forecastDays: FORECAST_DAYS,
        scheduledDays: SCHEDULED_DAYS,
        minDaysBack,
    });

    await page.waitForFunction((expected) => {
        const el = document.querySelector("helman-solar-inspector");
        const pills = el?.shadowRoot
            ?.querySelector("helman-solar-day-pills")
            ?.shadowRoot?.querySelectorAll(".pill");
        return (pills?.length ?? 0) === expected;
    }, PILL_DAYS);
}

type PillReadout = {
    day: string;
    label: string;
    selected: boolean;
    isHistory: boolean;
    /** Gauge kind → the figure it wrote, or "" when it wrote none. */
    gauges: Array<{ kind: string; text: string; unavailable: boolean; fillWidth: string }>;
};

async function readPills(page: Page): Promise<PillReadout[]> {
    return page.evaluate(() => {
        const root = document.querySelector("helman-solar-inspector")
            ?.shadowRoot?.querySelector("helman-solar-day-pills")?.shadowRoot;
        return Array.from(root?.querySelectorAll(".pill") ?? []).map((pill) => ({
            day: pill.getAttribute("data-day") ?? "",
            label: pill.querySelector(".pill-label")?.textContent?.trim() ?? "",
            selected: pill.getAttribute("aria-pressed") === "true",
            isHistory: pill.getAttribute("data-history") === "true",
            gauges: Array.from(pill.querySelectorAll(".day-aggregate-gauge")).map((gauge) => ({
                kind: ["solar", "battery", "grid"].find((k) => gauge.classList.contains(k)) ?? "",
                text: gauge.textContent?.trim() ?? "",
                unavailable: gauge.classList.contains("unavailable"),
                fillWidth: (gauge.querySelector(".day-aggregate-gauge-fill") as HTMLElement | null)?.style.width ?? "",
            })),
        }));
    });
}

/** Page the row a week with the inspector's own buttons: negative goes back. */
async function stepWeek(page: Page, delta: number): Promise<void> {
    await page.evaluate((step) => {
        const root = document.querySelector("helman-solar-inspector")?.shadowRoot;
        const arrows = Array.from(root?.querySelectorAll(".week-arrow") ?? []);
        (arrows[step < 0 ? 0 : 1] as HTMLElement | undefined)?.click();
    }, delta);
}

/** Whether each week button is takeable, back first. */
async function readWeekArrows(page: Page): Promise<boolean[]> {
    return page.evaluate(() => {
        const root = document.querySelector("helman-solar-inspector")?.shadowRoot;
        return Array.from(root?.querySelectorAll(".week-arrow") ?? [])
            .map((button) => !(button as HTMLButtonElement).disabled);
    });
}

/** The day `offset` days from today, as the fixture writes its dates. */
function dayAt(offset: number): string {
    const todayMs = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    return new Date(todayMs + offset * 86_400_000).toISOString().slice(0, 10);
}

/** Wait until this many pills are drawn from measurements rather than forecast. */
async function waitForHistoryPills(page: Page, count: number): Promise<void> {
    await page.waitForFunction((expected) => {
        const root = document.querySelector("helman-solar-inspector")
            ?.shadowRoot?.querySelector("helman-solar-day-pills")?.shadowRoot;
        return (root?.querySelectorAll('.pill[data-history="true"]').length ?? 0) === expected;
    }, count);
}

async function readRequestedRanges(page: Page): Promise<string[]> {
    return page.evaluate(() => [...((window as any).__requestedRanges as string[])]);
}

/** Wait until the row shows exactly these days, so a click has settled. */
async function waitForDays(page: Page, days: string[]): Promise<void> {
    await page.waitForFunction((expected) => {
        const root = document.querySelector("helman-solar-inspector")
            ?.shadowRoot?.querySelector("helman-solar-day-pills")?.shadowRoot;
        const shown = Array.from(root?.querySelectorAll(".pill") ?? [])
            .map((pill) => pill.getAttribute("data-day"));
        return shown.length === expected.length && shown.every((day, i) => day === expected[i]);
    }, days);
}

async function clickPill(page: Page, index: number): Promise<void> {
    await page.evaluate((i) => {
        const pills = document.querySelector("helman-solar-inspector")
            ?.shadowRoot?.querySelector("helman-solar-day-pills")
            ?.shadowRoot?.querySelectorAll(".pill");
        (pills?.[i] as HTMLElement | undefined)?.click();
    }, index);
}

type NavLayout = {
    twoRows: boolean;
    scrolls: boolean;
    pillWidths: number[];
    pills: Array<{ width: number; labelWidth: number }>;
};

async function readNavLayout(page: Page): Promise<NavLayout> {
    return page.evaluate(() => {
        const root = (document.querySelector("helman-solar-inspector") as HTMLElement).shadowRoot!;
        const dayNav = root.querySelector(".day-nav")!.getBoundingClientRect();
        const actions = root.querySelector(".nav-actions")!.getBoundingClientRect();
        const pillsRoot = (root.querySelector("helman-solar-day-pills") as HTMLElement).shadowRoot!;
        const row = pillsRoot.querySelector(".pill-row") as HTMLElement;
        const pills = Array.from(pillsRoot.querySelectorAll(".pill")) as HTMLElement[];
        return {
            twoRows: Math.round(actions.top) >= Math.round(dayNav.bottom),
            scrolls: row.scrollWidth > row.clientWidth,
            pillWidths: pills.map((pill) => pill.getBoundingClientRect().width),
            pills: pills.map((pill) => ({
                width: pill.getBoundingClientRect().width,
                labelWidth: pill.querySelector(".pill-label")!.getBoundingClientRect().width,
            })),
        };
    });
}

test.describe("solar inspector day pills", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page);
    });

    test("one pill per day from today to the end of the forecast", async ({ page }) => {
        const pills = await readPills(page);
        expect(pills).toHaveLength(PILL_DAYS);

        const days = pills.map((pill) => pill.day);
        expect(days).toEqual([...days].sort());
        expect(new Set(days).size).toBe(PILL_DAYS);
        // Today and tomorrow name themselves; the days after carry a date.
        expect(pills[0].label).not.toMatch(/\d/);
        expect(pills[1].label).not.toMatch(/\d/);
        expect(pills[2].label).toMatch(/\d/);
    });

    test("the shown day is the highlighted one, and it is the only one", async ({ page }) => {
        const pills = await readPills(page);
        expect(pills.filter((pill) => pill.selected).map((pill) => pill.day)).toEqual([pills[0].day]);
    });

    test("clicking a pill loads that day and moves the highlight", async ({ page }) => {
        await clickPill(page, 1);

        const target = (await readPills(page))[1].day;
        await page.waitForFunction(
            (day) => ((window as any).__requestedDates as string[]).includes(day),
            target,
        );

        const pills = await readPills(page);
        expect(pills.filter((pill) => pill.selected).map((pill) => pill.day)).toEqual([target]);
    });

    test("re-clicking the shown day does not reload it", async ({ page }) => {
        const before = await page.evaluate(() => ((window as any).__requestedDates as string[]).length);
        await clickPill(page, 0);
        await page.waitForTimeout(200);
        const after = await page.evaluate(() => ((window as any).__requestedDates as string[]).length);
        expect(after).toBe(before);
    });

    test("only solar writes its figure; SoC and grid are bars alone", async ({ page }) => {
        const [today] = await readPills(page);
        const byKind = new Map(today.gauges.map((gauge) => [gauge.kind, gauge]));

        expect(today.gauges.map((gauge) => gauge.kind)).toEqual(["solar", "battery", "grid"]);
        expect(byKind.get("solar")!.text).not.toBe("");
        expect(byKind.get("battery")!.text).toBe("");
        expect(byKind.get("grid")!.text).toBe("");
    });

    test("the solar bars share one scale across the row", async ({ page }) => {
        const pills = await readPills(page);
        const width = (pill: PillReadout) =>
            Number.parseFloat(pill.gauges.find((gauge) => gauge.kind === "solar")!.fillWidth);

        // The fixture halves solar each day, and the brightest day pins the scale.
        expect(width(pills[0])).toBeCloseTo(100, 1);
        expect(width(pills[1])).toBeCloseTo(50, 1);
    });

    test("a day past the schedule is still filled by the forecast", async ({ page }) => {
        // The schedule ends after SCHEDULED_DAYS, but the forecast runs on — and
        // the schedule card fills its later day rows from exactly that. A pill
        // that greyed out the moment the optimizer stopped placing actions would
        // hide most of the row.
        const pills = await readPills(page);
        for (const pill of pills.slice(SCHEDULED_DAYS, FORECAST_DAYS)) {
            expect(pill.gauges.some((gauge) => gauge.unavailable)).toBe(false);
            expect(pill.gauges.find((gauge) => gauge.kind === "solar")!.text).not.toBe("");
        }
    });

    test("a day past the forecast still gets a usable pill", async ({ page }) => {
        const pills = await readPills(page);
        const unforecast = pills[PILL_DAYS - 1];
        expect(unforecast.gauges.every((gauge) => gauge.unavailable)).toBe(true);

        await clickPill(page, PILL_DAYS - 1);
        await page.waitForFunction(
            (day) => ((window as any).__requestedDates as string[]).includes(day),
            unforecast.day,
        );
    });
});

test.describe("solar inspector history pill", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page);
    });

    test("no past day is offered until one is asked for", async ({ page }) => {
        const pills = await readPills(page);
        expect(pills.some((pill) => pill.isHistory)).toBe(false);
    });

    test("paging back shows that whole week, landing on its first day", async ({ page }) => {
        await stepWeek(page, -1);

        const week = Array.from({ length: 7 }, (_, i) => dayAt(-7 + i));
        await waitForDays(page, week);

        const pills = await readPills(page);
        expect(pills.map((pill) => pill.day)).toEqual(week);
        // The landing day is the one the button stepped to, a week back.
        expect(pills.filter((pill) => pill.selected).map((pill) => pill.day)).toEqual([dayAt(-7)]);
    });

    test("a second page back moves a whole week, not a day", async ({ page }) => {
        await stepWeek(page, -1);
        await waitForDays(page, Array.from({ length: 7 }, (_, i) => dayAt(-7 + i)));

        await stepWeek(page, -1);
        await waitForDays(page, Array.from({ length: 7 }, (_, i) => dayAt(-14 + i)));

        const pills = await readPills(page);
        expect(pills.filter((pill) => pill.selected).map((pill) => pill.day)).toEqual([dayAt(-14)]);
    });

    /**
     * The whole point of paging by weeks: travel to the week, then pick the day
     * out of it. If picking a day re-derived a different week the row would slide
     * out from under the click.
     */
    test("picking a day inside the week leaves the week where it is", async ({ page }) => {
        await stepWeek(page, -1);
        const week = Array.from({ length: 7 }, (_, i) => dayAt(-7 + i));
        await waitForDays(page, week);

        await clickPill(page, 4);
        await page.waitForFunction(
            (day) => ((window as any).__requestedDates as string[]).includes(day),
            week[4],
        );

        const pills = await readPills(page);
        expect(pills.map((pill) => pill.day)).toEqual(week);
        expect(pills.filter((pill) => pill.selected).map((pill) => pill.day)).toEqual([week[4]]);
    });

    test("paging forward from a past week comes back to today", async ({ page }) => {
        await stepWeek(page, -1);
        await waitForDays(page, Array.from({ length: 7 }, (_, i) => dayAt(-7 + i)));

        await stepWeek(page, 1);
        await waitForDays(page, Array.from({ length: PILL_DAYS }, (_, i) => dayAt(i)));

        const pills = await readPills(page);
        expect(pills.filter((pill) => pill.selected).map((pill) => pill.day)).toEqual([dayAt(0)]);
        expect(pills.some((pill) => pill.isHistory)).toBe(false);
    });

    test("forward is closed on today, and back closes where the data stops", async ({ page }) => {
        expect(await readWeekArrows(page)).toEqual([true, false]);

        // minDate is four weeks back, so the fifth page lands on it exactly.
        for (let week = 1; week <= 5; week += 1) {
            await stepWeek(page, -1);
            await waitForDays(page, Array.from({ length: 7 }, (_, i) => dayAt(-7 * week + i)));
        }

        const pills = await readPills(page);
        expect(pills.filter((pill) => pill.selected).map((pill) => pill.day)).toEqual([dayAt(-30)]);
        expect(await readWeekArrows(page)).toEqual([false, true]);
    });

    /**
     * A past week has to be a comparison, not just a picker: every day of it
     * draws what was measured, so the sunny one is visible before it is picked.
     */
    test("every day of a past week carries its measured bars", async ({ page }) => {
        await stepWeek(page, -1);
        await waitForHistoryPills(page, 7);

        const pills = await readPills(page);
        expect(pills.filter((pill) => pill.isHistory)).toHaveLength(7);
        for (const pill of pills) {
            const gauges = new Map(pill.gauges.map((gauge) => [gauge.kind, gauge]));
            expect(gauges.get("solar")!.text).not.toBe("");
            expect(gauges.get("battery")!.unavailable).toBe(false);
            expect(gauges.get("grid")!.unavailable).toBe(false);
        }
        // A week back is far enough that the landing day carries its date.
        expect(pills[0].day).toBe(dayAt(-7));
        expect(pills[0].selected).toBe(true);
        expect(pills[0].label).toMatch(/\d/);
    });

    test("the week's figures are one read, and picking a day inside it is none", async ({ page }) => {
        await stepWeek(page, -1);
        await waitForHistoryPills(page, 7);

        const afterPaging = await readRequestedRanges(page);
        expect(afterPaging).toEqual([`${dayAt(-7)}..${dayAt(-1)}`]);

        await clickPill(page, 3);
        await page.waitForFunction(
            (day) => ((window as any).__requestedDates as string[]).includes(day),
            dayAt(-4),
        );
        expect(await readRequestedRanges(page)).toEqual(afterPaging);

        await stepWeek(page, -1);
        await waitForDays(page, Array.from({ length: 7 }, (_, i) => dayAt(-14 + i)));
        await waitForHistoryPills(page, 7);
        expect(await readRequestedRanges(page)).toEqual([
            `${dayAt(-7)}..${dayAt(-1)}`,
            `${dayAt(-14)}..${dayAt(-8)}`,
        ]);
    });

    /**
     * Yesterday is the one past day that still names itself, and it is reached
     * by paging back a week and clicking the last pill — so the label has to
     * come from today, not from where the row happens to start.
     */
    test("the pill for yesterday still names itself inside a past week", async ({ page }) => {
        await stepWeek(page, -1);
        const week = Array.from({ length: 7 }, (_, i) => dayAt(-7 + i));
        await waitForDays(page, week);

        const pills = await readPills(page);
        expect(pills[0].label).toMatch(/\d/);
        expect(pills[6].day).toBe(dayAt(-1));
        expect(pills[6].label).not.toMatch(/\d/);
    });

    test("the header no longer repeats the day in words", async ({ page }) => {
        const hasDayMeta = await page.evaluate(() =>
            !!document.querySelector("helman-solar-inspector")?.shadowRoot?.querySelector(".nav .day-meta"));
        expect(hasDayMeta).toBe(false);
    });
});

test.describe("solar inspector header layout", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    /**
     * A phone-width card. The pills are the widest thing in the header and the
     * one part that cannot get much narrower, so if anything about them is
     * allowed to set the card's width, every chart below inherits it and the
     * card runs off the screen. The row has to scroll inside itself instead.
     */
    test("the day row never widens the card", async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 900 });
        await mountInspector(page);

        const layout = await page.evaluate(() => {
            const root = document.querySelector("helman-solar-inspector")!.shadowRoot!;
            const body = root.querySelector(".body") as HTMLElement;
            const row = (root.querySelector("helman-solar-day-pills") as HTMLElement)
                .shadowRoot!.querySelector(".pill-row") as HTMLElement;
            return {
                bodyScroll: body.scrollWidth,
                bodyClient: body.clientWidth,
                rowScroll: row.scrollWidth,
                rowClient: row.clientWidth,
            };
        });

        expect(layout.bodyScroll).toBe(layout.bodyClient);
        expect(layout.rowScroll).toBeGreaterThan(layout.rowClient);
    });

    test("the toolbar drops below the day row when they cannot share a line", async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 900 });
        await mountInspector(page);

        const rows = await page.evaluate(() => {
            const root = document.querySelector("helman-solar-inspector")!.shadowRoot!;
            const top = (selector: string) =>
                Math.round((root.querySelector(selector) as HTMLElement).getBoundingClientRect().top);
            return { dayNav: top(".day-nav"), actions: top(".nav-actions"), arrow: top(".week-nav") };
        });

        expect(rows.actions).toBeGreaterThan(rows.dayNav);
        // Everything that is not a day goes with the toolbar, so the narrow
        // header is one line of days and one line of controls.
        expect(rows.arrow).toBe(rows.actions);
    });

    /**
     * The week buttons lead the toolbar, back then forward, and are the same
     * height as the controls beside them — they are read as part of that row,
     * not as an appendage of the pills.
     */
    test("the week buttons sit side by side at the head of the toolbar", async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 900 });
        await mountInspector(page);

        const geometry = await page.evaluate(() => {
            const root = document.querySelector("helman-solar-inspector")!.shadowRoot!;
            const box = (element: Element) => element.getBoundingClientRect();
            const buttons = Array.from(root.querySelectorAll(".week-arrow"));
            return {
                count: buttons.length,
                boxes: buttons.map(box),
                slotToggle: box(root.querySelector(".slot-size-toggle")!),
            };
        });

        expect(geometry.count).toBe(2);
        // Side by side on one line, back to the left of forward.
        expect(Math.round(geometry.boxes[0].top)).toBe(Math.round(geometry.boxes[1].top));
        expect(geometry.boxes[0].right).toBeLessThanOrEqual(geometry.boxes[1].left);
        // And ahead of the rest of the toolbar.
        expect(geometry.boxes[1].right).toBeLessThanOrEqual(geometry.slotToggle.left);
        expect(Math.round(geometry.boxes[0].height)).toBe(Math.round(geometry.slotToggle.height));
    });

    /**
     * On a phone the row holds two or three pills and scrolls for the rest.
     * Selecting one that is off to the right — with the arrows, or from a
     * hand-scrolled row — has to bring it into view, or the highlight lands
     * somewhere nobody can see.
     */
    test("selecting a day off the edge scrolls it into view", async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 900 });
        await mountInspector(page);

        const offscreen = await page.evaluate(() => {
            const root = (document.querySelector("helman-solar-inspector") as HTMLElement)
                .shadowRoot!.querySelector("helman-solar-day-pills")!.shadowRoot!;
            const row = root.querySelector(".pill-row")!.getBoundingClientRect();
            const pills = Array.from(root.querySelectorAll(".pill"));
            const last = pills[pills.length - 1].getBoundingClientRect();
            return { hidden: last.right > row.right, count: pills.length };
        });
        expect(offscreen.hidden).toBe(true);

        await clickPill(page, offscreen.count - 1);
        await page.waitForFunction(() => {
            const root = (document.querySelector("helman-solar-inspector") as HTMLElement)
                .shadowRoot!.querySelector("helman-solar-day-pills")!.shadowRoot!;
            const row = root.querySelector(".pill-row")!.getBoundingClientRect();
            const selected = root.querySelector(".pill.selected")?.getBoundingClientRect();
            return !!selected && selected.left >= row.left - 1 && selected.right <= row.right + 1;
        });
    });

    /**
     * What has to give, and in what order, as the card narrows: the toolbar
     * leaves the line first, then the pills give up their slack down to their
     * own labels, and only a row that still does not fit scrolls. Losing that
     * order means scrolling for days that would have fitted.
     */
    test("the toolbar leaves the line before the pills give up any width", async ({ page }) => {
        await page.setViewportSize({ width: 820, height: 900 });
        await mountInspector(page);

        const layout = await readNavLayout(page);
        expect(layout.twoRows).toBe(true);
        expect(layout.pillWidths.every((width) => width === layout.pillWidths[0])).toBe(true);
        expect(layout.scrolls).toBe(false);
    });

    test("pills shrink to their labels before the row scrolls", async ({ page }) => {
        await page.setViewportSize({ width: 560, height: 900 });
        await mountInspector(page);

        const layout = await readNavLayout(page);
        // Narrower than the comfortable width they hold when there is room...
        expect(Math.max(...layout.pillWidths)).toBeLessThan(74);
        // ...but never narrower than what they have to say.
        for (const pill of layout.pills) {
            expect(pill.width).toBeGreaterThanOrEqual(pill.labelWidth);
        }
        expect(layout.scrolls).toBe(false);
    });

    test("a row that cannot fit even at label width scrolls", async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 900 });
        await mountInspector(page);

        const layout = await readNavLayout(page);
        expect(layout.scrolls).toBe(true);
        for (const pill of layout.pills) {
            expect(pill.width).toBeGreaterThanOrEqual(pill.labelWidth);
        }
    });

    /**
     * Wide enough for one line: the days lead it and every control follows,
     * with the week buttons first among them.
     */
    test("a header that fits keeps the days and the controls on one line", async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await mountInspector(page);

        const layout = await page.evaluate(() => {
            const root = document.querySelector("helman-solar-inspector")!.shadowRoot!;
            const box = (selector: string) =>
                (root.querySelector(selector) as HTMLElement).getBoundingClientRect();
            return {
                dayNav: box(".day-nav"),
                weekNav: box(".week-nav"),
                actions: box(".nav-actions"),
                slotToggle: box(".slot-size-toggle"),
                // Direct child: `››` is the last `.icon-button` of its own
                // group, so a descendant match would find it instead.
                refresh: box(".nav-actions > .icon-button:last-child"),
                nav: box(".nav"),
            };
        });

        // One line: the toolbar is centred against the taller day row rather
        // than sitting below it.
        expect(layout.actions.top).toBeLessThan(layout.dayNav.bottom);
        // The week buttons follow the last pill rather than the card's far
        // edge — they page the row, so they belong where the hand already is.
        expect(layout.weekNav.left).toBeGreaterThanOrEqual(layout.dayNav.right - 1);
        expect(layout.weekNav.left - layout.dayNav.right).toBeLessThanOrEqual(12);
        // The settings take the other end.
        expect(layout.slotToggle.left).toBeGreaterThan(layout.weekNav.right);
        expect(layout.nav.right - layout.refresh.right).toBeLessThanOrEqual(2);
    });
});
