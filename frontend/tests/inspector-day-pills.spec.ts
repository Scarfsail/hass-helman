import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

import { FIXED_NOW_ISO, FIXED_TODAY, installFixedClock } from "./support/fixed-clock";

/**
 * The solar inspector's day pills.
 *
 * The row is the card's day picker *and* its comparison: one pill per day from
 * today to the end of the forecast, each drawing that whole day with the
 * schedule card's own gauges. What is worth pinning is exactly what makes it
 * usable — that every offered day gets a pill whether or not the schedule
 * reaches it, that the selected day is the highlighted one, that a click
 * actually loads the day, and that each of its two bars writes the figures it
 * draws: solar's total, and the SoC band's two ends.
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
    // The fixture is dated from the page's clock and the expectations below are
    // built from the same one. See `fixed-clock`.
    await installFixedClock(page);
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-inspector"));
}

/**
 * Mount the inspector against a fake backend: an empty-ish inspector day, a
 * two-day hourly schedule, and a forecast whose solar total falls day by day so
 * the pills' shared scale is visible in the bar widths.
 */
async function mountInspector(
    page: Page,
    minDaysBack = 30,
    firstWeekday = "language",
    // Off by default: the fixture deliberately answers the day-aggregate read
    // with past days only, so today's pill is pure forecast and every
    // expectation written against that still holds. On, the meters have the
    // part of today that has already happened -- which is what the real backend
    // answers mid-day, and what makes today a mixed day.
    measureToday = false,
): Promise<void> {
    await page.evaluate(({ pillDays, forecastDays, scheduledDays, minDaysBack, firstWeekday, measureToday }) => {
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
                controllables: {},
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
            locale: { language: "en", first_weekday: firstWeekday },
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
                        if (day === isoDay(0) && measureToday) {
                            // Today so far: a morning's production and a
                            // battery that has been round part of a cycle.
                            days.push({
                                date: day,
                                solarWh: 1400,
                                gridImportKwh: 0.9,
                                gridExportKwh: 0.4,
                                batteryMinSocPct: 44,
                                batteryMaxSocPct: 71,
                            });
                            continue;
                        }
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
        firstWeekday,
        measureToday,
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
    title: string;
    selected: boolean;
    /** "measured" / "mixed" / "forecast", as the pill labels its own day. */
    dayState: string;
    /** Gauge kind → the figure it wrote, or "" when it wrote none. */
    gauges: Array<{
        kind: string;
        text: string;
        unavailable: boolean;
        fillWidth: string;
        forecast: boolean;
        /** Every fill the bar drew, in paint order, and which is the measured one. */
        fills: Array<{ width: string; measured: boolean }>;
    }>;
};

async function readPills(page: Page): Promise<PillReadout[]> {
    return page.evaluate(() => {
        const root = document.querySelector("helman-solar-inspector")
            ?.shadowRoot?.querySelector("helman-solar-day-pills")?.shadowRoot;
        return Array.from(root?.querySelectorAll(".pill") ?? []).map((pill) => ({
            day: pill.getAttribute("data-day") ?? "",
            label: pill.querySelector(".pill-label")?.textContent?.trim() ?? "",
            title: pill.getAttribute("title") ?? "",
            selected: pill.getAttribute("aria-pressed") === "true",
            dayState: pill.getAttribute("data-day-state") ?? "",
            gauges: Array.from(pill.querySelectorAll(".day-aggregate-gauge")).map((gauge) => ({
                kind: ["solar", "battery", "grid"].find((k) => gauge.classList.contains(k)) ?? "",
                text: gauge.textContent?.trim() ?? "",
                unavailable: gauge.classList.contains("unavailable"),
                fillWidth: (gauge.querySelector(".day-aggregate-gauge-fill") as HTMLElement | null)?.style.width ?? "",
                forecast: gauge.classList.contains("forecast"),
                fills: Array.from(gauge.querySelectorAll(".day-aggregate-gauge-fill")).map((fill) => ({
                    width: (fill as HTMLElement).style.width,
                    measured: fill.classList.contains("measured"),
                })),
            })),
        }));
    });
}

/** Open or close the picker with its own toggle. */
async function pressMore(page: Page): Promise<void> {
    await page.evaluate(() => {
        const root = document.querySelector("helman-solar-inspector")?.shadowRoot;
        (root?.querySelector(".nav-more") as HTMLButtonElement | undefined)?.click();
    });
}

/** Every day of the calendar month `today` falls in, in order. */
function daysOfThisMonth(): string[] {
    const today = new Date(FIXED_NOW_ISO);
    const year = today.getUTCFullYear();
    const month = today.getUTCMonth();
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return Array.from({ length: last }, (_, i) =>
        new Date(Date.UTC(year, month, i + 1)).toISOString().slice(0, 10));
}

/** The day `offset` days from today, as the fixture writes its dates. */
function dayAt(offset: number): string {
    const todayMs = Date.parse(`${FIXED_TODAY}T00:00:00Z`);
    return new Date(todayMs + offset * 86_400_000).toISOString().slice(0, 10);
}

/** Wait until this many pills are drawn from measurements rather than forecast. */
async function waitForHistoryPills(page: Page, count: number): Promise<void> {
    await page.waitForFunction((expected) => {
        const root = document.querySelector("helman-solar-inspector")
            ?.shadowRoot?.querySelector("helman-solar-day-pills")?.shadowRoot;
        return [...root!.querySelectorAll('.pill[data-day-state="measured"]')].filter((pill) =>
            !root!.querySelector(".continuous") || pill.getAttribute("data-day")!.slice(0, 7) === new Date().toISOString().slice(0, 7)).length === expected;
    }, count);
}

async function readMonthPills(page: Page): Promise<PillReadout[]> {
    return (await readPills(page)).filter((pill) => pill.day.slice(0, 7) === FIXED_TODAY.slice(0, 7));
}

async function expectFirstColumn(page: Page, weekday: number): Promise<void> {
    const column = await page.locator(`helman-solar-day-pills [data-day="${FIXED_TODAY.slice(0, 7)}-01"]`).evaluate((pill) => {
        const row = pill.parentElement!;
        const gap = parseFloat(getComputedStyle(row).columnGap);
        return Math.round((pill.getBoundingClientRect().left - row.getBoundingClientRect().left) / (pill.getBoundingClientRect().width + gap));
    });
    expect(column).toBe((new Date(`${FIXED_TODAY.slice(0, 7)}-01T00:00:00Z`).getUTCDay() - weekday + 7) % 7);
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
        if (root?.querySelector(".continuous")) {
            const box = root.querySelector(".pill-row")!.getBoundingClientRect();
            return expected.every((day) => {
                const pill = root.querySelector(`[data-day="${day}"]`);
                if (!pill) return false;
                const rect = pill.getBoundingClientRect();
                return rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;
            });
        }
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

    test("a pill draws solar and SoC only, each with its figures", async ({ page }) => {
        const [today] = await readPills(page);
        const byKind = new Map(today.gauges.map((gauge) => [gauge.kind, gauge]));

        // Grid is the schedule card's third bar and deliberately not here.
        expect(today.gauges.map((gauge) => gauge.kind)).toEqual(["solar", "battery"]);
        expect(byKind.get("solar")!.text).not.toBe("");
        // The two ends of the SoC band the bar draws, in that order.
        expect(byKind.get("battery")!.text).toMatch(/^\d+\s*:\s*\d+$/);
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

/**
 * Today, the one day with both halves.
 *
 * The meters have the part of it that has happened and the schedule has the
 * part that has not, and a pill drawn from either one alone says something
 * false about the day the reader is standing in: the morning's harvest read as
 * the whole day, or the whole day read as if none of it had happened yet.
 */
test.describe("solar inspector today, half measured", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
    });

    test("today's pill adds the measured half to the expected rest", async ({ page }) => {
        await mountInspector(page, 30, "language", true);
        await waitForMixedToday(page);

        const [today] = await readPills(page);
        expect(today.dayState).toBe("mixed");
        const byKind = new Map(today.gauges.map((gauge) => [gauge.kind, gauge]));
        // 1.4 kWh measured so far, against a fixture day whose forecast is
        // 8 kWh of daylight -- so the day is expected to reach 9.4.
        expect(byKind.get("solar")!.text).toBe("1.4 / 9.4");
        // The band spans both halves: the floor is where the forecast takes the
        // battery, the ceiling is where the morning already took it.
        expect(byKind.get("battery")!.text).toBe("40 : 71");
    });

    test("the mixed solar bar draws the measured part inside the expected one", async ({ page }) => {
        await mountInspector(page, 30, "language", true);
        await waitForMixedToday(page);

        const solar = (await readPills(page))[0].gauges.find((gauge) => gauge.kind === "solar")!;
        expect(solar.fills).toHaveLength(2);
        expect(solar.fills[0].measured).toBe(false);
        expect(solar.fills[1].measured).toBe(true);
        // Today is the brightest day of the row once its two halves are added,
        // so it pins the shared scale and its expected fill is the full bar.
        expect(Number.parseFloat(solar.fills[0].width)).toBeCloseTo(100, 1);
        expect(Number.parseFloat(solar.fills[1].width))
            .toBeLessThan(Number.parseFloat(solar.fills[0].width));
    });

    test("a predicted bar is hatched and a measured one is not", async ({ page }) => {
        await mountInspector(page, 30, "language", true);
        await waitForMixedToday(page);
        const month = daysOfThisMonth();
        const pastDays = month.filter((day) => day < dayAt(0)).length;
        await pressMore(page);
        await waitForDays(page, month);
        await waitForHistoryPills(page, pastDays);

        // A bar with nothing to draw carries no treatment either -- an
        // unavailable gauge is a blank strip, not a claim about a day -- so the
        // hatch is only asked about the bars that drew something.
        const drawn = (pill: PillReadout) => pill.gauges.filter((gauge) => !gauge.unavailable);
        const pills = await readMonthPills(page);
        for (const pill of pills.filter((candidate) => candidate.dayState === "measured")) {
            expect(drawn(pill).some((gauge) => gauge.forecast)).toBe(false);
        }
        const ahead = pills.filter((candidate) =>
            candidate.dayState === "forecast" && candidate.day > dayAt(0) && drawn(candidate).length > 0);
        expect(ahead.length).toBeGreaterThan(0);
        for (const pill of ahead) {
            expect(drawn(pill).every((gauge) => gauge.forecast)).toBe(true);
        }
        // Today's own gauges are predicted too: half of what they draw has not
        // happened, which is not a measured claim.
        const today = pills.find((pill) => pill.day === dayAt(0))!;
        expect(drawn(today).every((gauge) => gauge.forecast)).toBe(true);
    });

    test("today's frame is dashed but solid on the edge it has crossed", async ({ page }) => {
        await mountInspector(page, 30, "language", true);
        await waitForMixedToday(page);
        // `border: 1px solid var(--divider-color)` computes to `none` while the
        // token is unset, so the bare test page has to supply it before any
        // border style can be read.
        await page.evaluate(() => {
            (document.querySelector("helman-solar-inspector") as HTMLElement)
                .style.setProperty("--divider-color", "#d4d4d8");
        });

        expect(await pillBorder(page, dayAt(0))).toEqual({ top: "dashed", left: "solid" });
        expect(await pillBorder(page, dayAt(1))).toEqual({ top: "dashed", left: "dashed" });
    });

    test("with nothing measured for today, today is a forecast like any other", async ({ page }) => {
        await mountInspector(page);
        await page.evaluate(() => {
            (document.querySelector("helman-solar-inspector") as HTMLElement)
                .style.setProperty("--divider-color", "#d4d4d8");
        });

        const [today] = await readPills(page);
        expect(today.dayState).toBe("forecast");
        expect(today.gauges.find((gauge) => gauge.kind === "solar")!.text).not.toContain("/");
        expect(await pillBorder(page, dayAt(0))).toEqual({ top: "dashed", left: "dashed" });
    });
});

/** Wait until today's pill has both halves of the day in it. */
async function waitForMixedToday(page: Page): Promise<void> {
    await page.waitForFunction(() => {
        const root = document.querySelector("helman-solar-inspector")
            ?.shadowRoot?.querySelector("helman-solar-day-pills")?.shadowRoot;
        return !!root?.querySelector('.pill[data-day-state="mixed"]');
    });
}

/** The resolved border styles of one day's pill. */
async function pillBorder(page: Page, day: string): Promise<{ top: string; left: string }> {
    return page.evaluate((target) => {
        const root = document.querySelector("helman-solar-inspector")
            ?.shadowRoot?.querySelector("helman-solar-day-pills")?.shadowRoot;
        const style = getComputedStyle(root!.querySelector(`.pill[data-day="${target}"]`)!);
        return { top: style.borderTopStyle, left: style.borderLeftStyle };
    }, day);
}

test.describe("solar inspector past days", () => {
    test.beforeEach(async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page);
    });

    test("no past day is offered until the picker is opened", async ({ page }) => {
        const pills = await readPills(page);
        expect(pills.some((pill) => pill.dayState === "measured")).toBe(false);
    });

    /**
     * What the toggle is for. Closed, the row is today and the days ahead;
     * opened, it is the whole calendar month, which is what makes every day of
     * it one click away instead of a week's paging apiece.
     */
    test("opening the picker widens the row to the whole month", async ({ page }) => {
        const month = daysOfThisMonth();
        await pressMore(page);
        await waitForDays(page, month);

        const pills = await readMonthPills(page);
        expect(pills.map((pill) => pill.day)).toEqual(month);
        // Today is still the day on screen: widening the row is not a move.
        expect(pills.filter((pill) => pill.selected).map((pill) => pill.day)).toEqual([dayAt(0)]);
    });

    test("closing the picker puts the rolling row back", async ({ page }) => {
        await pressMore(page);
        await waitForDays(page, daysOfThisMonth());

        await pressMore(page);
        await waitForDays(page, Array.from({ length: PILL_DAYS }, (_, i) => dayAt(i)));
    });

    /**
     * The whole point of opening the month: travel to the day, then pick it out
     * of the row. If picking a day re-derived a different window the row would
     * slide out from under the click.
     */
    test("picking a day inside the month leaves the month where it is", async ({ page }) => {
        const month = daysOfThisMonth();
        const pastDays = month.filter((day) => day < dayAt(0)).length;
        test.skip(pastDays === 0, "the 1st has no past day in its own month");
        await pressMore(page);
        await waitForDays(page, month);
        await waitForHistoryPills(page, pastDays);

        const target = (await readMonthPills(page)).find((pill) => pill.dayState === "measured")!.day;
        await page.locator(`helman-solar-day-pills [data-day="${target}"]`).click();
        await page.waitForFunction(
            (day) => ((window as any).__requestedDates as string[]).includes(day),
            target,
        );

        const pills = await readMonthPills(page);
        expect(pills.map((pill) => pill.day)).toEqual(month);
        expect(pills.filter((pill) => pill.selected).map((pill) => pill.day)).toEqual([target]);
    });

    /**
     * A month has to be a comparison, not just a picker: every day already
     * lived through draws what was measured, so the sunny one is visible before
     * it is picked.
     */
    test("every past day of the month carries its measured bars", async ({ page }) => {
        await pressMore(page);
        const month = daysOfThisMonth();
        await waitForDays(page, month);
        const pastDays = month.filter((day) => day < dayAt(0)).length;
        test.skip(pastDays === 0, "the 1st has no past day in its own month");
        await waitForHistoryPills(page, pastDays);

        const pills = await readMonthPills(page);
        expect(pills.filter((pill) => pill.dayState === "measured")).toHaveLength(pastDays);
        for (const pill of pills.filter((candidate) => candidate.dayState === "measured")) {
            const gauges = new Map(pill.gauges.map((gauge) => [gauge.kind, gauge]));
            expect(gauges.get("solar")!.text).not.toBe("");
            expect(gauges.get("battery")!.unavailable).toBe(false);
        }
    });

    test("the month's figures are one read, and picking a day inside it is none", async ({ page }) => {
        const month = daysOfThisMonth();
        const pastDays = month.filter((day) => day < dayAt(0)).length;
        test.skip(pastDays === 0, "the 1st has no past day in its own month");
        await pressMore(page);
        await waitForDays(page, month);
        await waitForHistoryPills(page, pastDays);

        // Two reads, and only one of them is the month's: the closed row asks
        // for today, the only day it holds that can have been measured, and the
        // month asks for its own days up to today. Neither reaches past today,
        // because nothing there has happened yet.
        const afterOpening = await readRequestedRanges(page);
        expect(afterOpening).toEqual([
            `${dayAt(0)}..${dayAt(0)}`,
            `${dayAt(-30)}..${dayAt(0)}`,
        ]);

        const target = (await readMonthPills(page)).find((pill) => pill.dayState === "measured")!.day;
        await page.locator(`helman-solar-day-pills [data-day="${target}"]`).click();
        await page.waitForFunction(
            (day) => ((window as any).__requestedDates as string[]).includes(day),
            target,
        );
        expect(await readRequestedRanges(page)).toEqual(afterOpening);
    });

    /**
     * Yesterday is the one past day that still names itself, and inside a month
     * it is just another pill — so the label has to come from today, not from
     * where the row happens to start.
     */
    test("the pill for yesterday still names itself inside the month", async ({ page }) => {
        test.skip(dayAt(-1) < daysOfThisMonth()[0], "yesterday is in the previous month");
        await pressMore(page);
        await waitForDays(page, daysOfThisMonth());

        const pills = await readMonthPills(page);
        const yesterday = pills.find((pill) => pill.day === dayAt(-1))!;
        expect(yesterday.title).not.toMatch(/\d/);
        // A day further back does carry its date, so the word is the exception.
        const older = pills.find((pill) => pill.day < dayAt(-1));
        if (older !== undefined) {
            expect(older.title).toMatch(/\d/);
        }
    });

    test("the header no longer repeats the day in words", async ({ page }) => {
        const hasDayMeta = await page.evaluate(() =>
            !!document.querySelector("helman-solar-inspector")?.shadowRoot?.querySelector(".nav .day-meta"));
        expect(hasDayMeta).toBe(false);
    });
});

/**
 * The opened row is a calendar, and a calendar is only readable if the 1st sits
 * under its own weekday. That is the whole job of the leading blanks, and it is
 * locale-dependent: the same month starts a column further along in a week that
 * begins on Sunday than in one that begins on Monday.
 */
test.describe("solar inspector calendar layout", () => {
    /** The cells before the first pill, and the column the 1st lands in. */
    async function readGrid(page: Page): Promise<{ blanks: number; columns: string }> {
        return page.evaluate(() => {
            const root = document.querySelector("helman-solar-inspector")
                ?.shadowRoot?.querySelector("helman-solar-day-pills")?.shadowRoot;
            const row = root?.querySelector(".pill-row") as HTMLElement;
            return {
                blanks: root?.querySelectorAll(".pill-blank").length ?? 0,
                columns: getComputedStyle(row).gridTemplateColumns,
            };
        });
    }

    test("a Monday-first locale offsets the month to its Monday column", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, 30, "monday");
        await pressMore(page);
        await waitForDays(page, daysOfThisMonth());

        const grid = await readGrid(page);
        expect(grid.blanks).toBe(0);
        await expectFirstColumn(page, 1);
        expect(grid.columns.split(" ")).toHaveLength(7);
    });

    test("a Sunday-first locale offsets it one column further", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, 30, "sunday");
        await pressMore(page);
        await waitForDays(page, daysOfThisMonth());

        expect((await readGrid(page)).blanks).toBe(0);
        await expectFirstColumn(page, 0);
    });

    test("the closed row is not a grid", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, 30, "monday");

        const closed = await page.evaluate(() => {
            const root = document.querySelector("helman-solar-inspector")
                ?.shadowRoot?.querySelector("helman-solar-day-pills")?.shadowRoot;
            const row = root?.querySelector(".pill-row") as HTMLElement;
            return {
                blanks: root?.querySelectorAll(".pill-blank").length ?? 0,
                display: getComputedStyle(row).display,
            };
        });
        expect(closed).toEqual({ blanks: 0, display: "flex" });
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
            return { dayNav: top(".day-nav"), actions: top(".nav-actions"), more: top(".nav-more") };
        });

        expect(rows.actions).toBeGreaterThan(rows.dayNav);
        // Everything that is not a day goes with the toolbar, so the narrow
        // header is one line of days and one line of controls.
        expect(rows.more).toBe(rows.actions);
    });

    /**
     * The toggle leads the toolbar and is the same height as the controls
     * beside it — it is read as part of that row, not as an appendage of the
     * pills.
     */
    test("the more toggle leads the toolbar", async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 900 });
        await mountInspector(page);

        const geometry = await page.evaluate(() => {
            const root = document.querySelector("helman-solar-inspector")!.shadowRoot!;
            const box = (selector: string) =>
                (root.querySelector(selector) as HTMLElement).getBoundingClientRect();
            return { more: box(".nav-more"), slotToggle: box(".slot-size-toggle") };
        });

        // Ahead of the rest of the toolbar, and the same height as it.
        expect(geometry.more.right).toBeLessThanOrEqual(geometry.slotToggle.left);
        expect(Math.round(geometry.more.height)).toBe(Math.round(geometry.slotToggle.height));
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
     * with the more toggle first among them.
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
                more: box(".nav-more"),
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
        // The toggle follows the last pill rather than the card's far edge — it
        // opens the row, so it belongs where the hand already is.
        expect(layout.more.left).toBeGreaterThanOrEqual(layout.dayNav.right - 1);
        expect(layout.more.left - layout.dayNav.right).toBeLessThanOrEqual(12);
        // The settings take the other end.
        expect(layout.slotToggle.left).toBeGreaterThan(layout.more.right);
        expect(layout.nav.right - layout.refresh.right).toBeLessThanOrEqual(2);
    });
});

const calendarRow = (page: Page) => page.locator("helman-solar-day-pills .continuous");

async function calendarState(page: Page) {
    return page.evaluate(() => {
        const inspector = document.querySelector("helman-solar-inspector") as any;
        const picker = inspector.shadowRoot.querySelector("helman-solar-day-pills");
        const row = picker.shadowRoot.querySelector(".continuous") as HTMLElement;
        const box = row.getBoundingClientRect();
        const cells = [...row.querySelectorAll<HTMLElement>("[data-day]")].map((pill) => {
            const rect = pill.getBoundingClientRect();
            return { day: pill.dataset.day!, top: rect.top - box.top, bottom: rect.bottom - box.top };
        });
        return {
            cells, visible: cells.filter((cell) => (cell.top + cell.bottom) / 2 >= 0 && (cell.top + cell.bottom) / 2 < box.height),
            selected: inspector._selectedDate, month: inspector._browsedMonth,
            requests: [...(window as any).__requestedDates], summaries: [...(window as any).__requestedRanges],
            stored: inspector._historyDays.map((day: any) => day.dayKey),
            top: row.scrollTop, height: box.height, width: row.clientWidth, scrollWidth: row.scrollWidth,
        };
    });
}

async function browseMonth(page: Page, month: string) {
    // Use the real year/month controls, including their reachable-range logic.
    await page.locator(`helman-solar-span-pills .pill[data-span="${month.slice(0, 4)}-01-01"]`).first().click();
    await page.locator(`helman-solar-span-pills .months .pill[data-span="${month}-01"]`).click();
    await expect.poll(async () => (await calendarState(page)).month).toBe(`${month}-01`);
}

test.describe("continuous detail calendar", () => {
    test.beforeEach(async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        await loadCardBundle(page);
        await mountInspector(page, 1100, "monday");
        await pressMore(page);
        await waitForDays(page, daysOfThisMonth());
    });

    test("August 1 to July 31 scrolls without loading, then loads exactly once at the click position", async ({ page }) => {
        await browseMonth(page, "2026-08");
        await page.locator('helman-solar-day-pills [data-day="2026-08-01"]').click();
        const before = await calendarState(page);
        await calendarRow(page).hover();
        await page.mouse.wheel(0, -144);
        await expect.poll(async () => (await calendarState(page)).top).toBeLessThan(before.top);
        const scrolled = await calendarState(page);
        expect(scrolled.selected).toBe("2026-08-01");
        expect(scrolled.requests).toEqual(before.requests);
        expect(scrolled.visible.some((cell) => cell.day === "2026-07-31")).toBe(true);
        await page.locator('helman-solar-day-pills [data-day="2026-07-31"]').click();
        await expect.poll(async () => (await calendarState(page)).requests.length).toBe(before.requests.length + 1);
        expect((await calendarState(page)).top).toBe(scrolled.top);
        expect((await calendarState(page)).selected).toBe("2026-07-31");
    });

    test("buffer replacements preserve cell offsets through December/January, and return works by keyboard", async ({ page }) => {
        await browseMonth(page, "2026-02");
        const before = await calendarState(page);
        for (let step = 0; step < 16; step++) {
            const anchor = await calendarRow(page).evaluate((row: HTMLElement) => {
                row.scrollTop -= 144;
                const box = row.getBoundingClientRect();
                const pill = [...row.querySelectorAll<HTMLElement>("[data-day]")].find((pill) => pill.getBoundingClientRect().top >= box.top)!;
                return { day: pill.dataset.day, top: pill.getBoundingClientRect().top - box.top };
            });
            // Let the scroll event, Lit update and offset restoration all settle.
            await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
            const state = await calendarState(page);
            expect(state.cells.find((cell) => cell.day === anchor.day)!.top).toBeCloseTo(anchor.top!, 1);
            expect(state.cells.length).toBeLessThanOrEqual(105);
            expect(new Set(state.cells.map((cell) => cell.day)).size).toBe(state.cells.length);
            for (let i = 1; i < state.cells.length; i++) {
                expect(Date.parse(state.cells[i].day) - Date.parse(state.cells[i - 1].day)).toBe(86400000);
            }
            expect(state.stored.every((day: string) => day >= state.cells[0].day && day <= state.cells.at(-1)!.day)).toBe(true);
        }
        const after = await calendarState(page);
        expect(after.month < "2026-01-01").toBe(true);
        expect(after.cells.some((cell) => cell.day === before.selected)).toBe(false);
        expect(after.requests).toEqual(before.requests);
        for (let step = 0; step < 16; step++) {
            const previous = await calendarState(page);
            const anchor = await calendarRow(page).evaluate((row: HTMLElement) => {
                row.scrollTop += 144;
                const box = row.getBoundingClientRect();
                const pill = [...row.querySelectorAll<HTMLElement>("[data-day]")].find((pill) => pill.getBoundingClientRect().top >= box.top)!;
                return { day: pill.dataset.day, top: pill.getBoundingClientRect().top - box.top };
            });
            await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
            const state = await calendarState(page);
            expect(state.cells.find((cell) => cell.day === anchor.day)!.top).toBeCloseTo(anchor.top!, 1);
            expect(state.cells.length).toBeLessThanOrEqual(105);
            if (state.cells[0].day === previous.cells[0].day) expect(state.summaries).toEqual(previous.summaries);
            expect(state.requests).toEqual(before.requests);
        }
        const button = page.locator("helman-solar-day-pills .return-selected");
        await button.focus();
        await page.keyboard.press("Enter");
        await waitForDays(page, daysOfThisMonth());
        await expect(button).toHaveCount(0);
        expect((await calendarState(page)).requests).toEqual(before.requests);
    });

    test("native touch scrolling browses without selecting a day", async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 900 });
        await browseMonth(page, "2026-08");
        const before = await calendarState(page);
        const box = (await calendarRow(page).boundingBox())!;
        const session = await page.context().newCDPSession(page);
        await session.send("Emulation.setTouchEmulationEnabled", { enabled: true });
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + 100 }] });
        for (let step = 1; step <= 6; step++) {
            await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x + box.width / 2, y: box.y + 100 + step * 20 }] });
        }
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect.poll(async () => (await calendarState(page)).top).toBeLessThan(before.top);
        expect((await calendarState(page)).requests).toEqual(before.requests);
        expect((await calendarState(page)).selected).toBe(before.selected);
        await session.detach();
    });

    test("reopening and external selection reveal the loaded month, while aggregate navigation uses the loaded day", async ({ page }) => {
        await browseMonth(page, "2026-03");
        await pressMore(page);
        await pressMore(page);
        await waitForDays(page, daysOfThisMonth());
        await page.evaluate(() => {
            const inspector = document.querySelector("helman-solar-inspector") as any;
            inspector._selectedDate = "2026-07-14";
            inspector._load();
        });
        await expect.poll(async () => (await calendarState(page)).month).toBe("2026-07-01");
        await browseMonth(page, "2026-02");
        await page.locator(".slot-size-button").filter({ hasText: /^D$/ }).click();
        await expect.poll(() => page.evaluate(() => (document.querySelector("helman-solar-inspector") as any)._selectedDate.slice(0, 7))).toBe("2026-07");
    });

    test("six-row months fit on mobile and repeated month clicks restore the full month", async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 900 });
        await browseMonth(page, "2026-03");
        const state = await calendarState(page);
        expect(state.visible.filter((cell) => cell.day.startsWith("2026-03"))).toHaveLength(31);
        expect(state.scrollWidth).toBe(state.width);
        await calendarRow(page).evaluate((row) => { row.scrollTop += 72; });
        await page.locator('helman-solar-span-pills .months [data-span="2026-03-01"]').click();
        await expect.poll(async () => (await calendarState(page)).visible.filter((cell) => cell.day.startsWith("2026-03")).length).toBe(31);
        await page.addStyleTag({ content: `body { font-family: sans-serif; --divider-color: #ddd;
            --card-background-color: #fff; --primary-text-color: #222; --primary-color: #2563eb; }` });
        await page.screenshot({ path: "/tmp/issue218-mobile.png", fullPage: true });
        await page.setViewportSize({ width: 1100, height: 950 });
        await page.screenshot({ path: "/tmp/issue218-desktop.png", fullPage: true });
    });

    test("visible-day month counts retain a tied month, otherwise choose the earliest", async ({ page }) => {
        await browseMonth(page, "2026-06");
        const alignTie = async () => {
            await calendarRow(page).evaluate((row: HTMLElement) => {
                const pill = row.querySelector('[data-day="2026-05-11"]')!;
                row.scrollTop += pill.getBoundingClientRect().top - row.getBoundingClientRect().top;
                row.dispatchEvent(new Event("scroll"));
            });
            await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        };
        await alignTie();
        let state = await calendarState(page);
        expect(state.visible.filter((cell) => cell.day.startsWith("2026-05"))).toHaveLength(21);
        expect(state.visible.filter((cell) => cell.day.startsWith("2026-06"))).toHaveLength(21);
        expect(state.month).toBe("2026-06-01");
        await page.evaluate(async () => {
            const inspector = document.querySelector("helman-solar-inspector") as any;
            inspector._browsedMonth = "2026-04-01";
            await inspector.updateComplete;
        });
        await alignTie();
        state = await calendarState(page);
        expect(state.month).toBe("2026-05-01");
    });

    test("pending and failed summaries retain overlap and stale replies cannot overwrite a revisited window", async ({ page }) => {
        await page.evaluate(() => {
            const inspector = document.querySelector("helman-solar-inspector") as any;
            const original = inspector.hass.callWS;
            (window as any).__pendingSummaries = [];
            inspector.hass.callWS = (message: any) => message.type !== "helman/solar_bias/day_aggregates"
                ? original(message) : new Promise((resolve, reject) => (window as any).__pendingSummaries.push({ message, resolve, reject }));
        });
        await browseMonth(page, "2026-09");
        expect((await calendarState(page)).stored).toContain("2026-09-15");
        const before = await calendarState(page);
        await page.locator('helman-solar-day-pills [data-day="2026-09-15"]').click();
        expect((await calendarState(page)).requests.length).toBe(before.requests.length + 1);
        await browseMonth(page, "2026-08");
        await browseMonth(page, "2026-09");
        await page.evaluate(async () => {
            const pending = (window as any).__pendingSummaries;
            const row = (solarWh: number) => ({ date: "2026-09-15", solarWh, gridImportKwh: null,
                gridExportKwh: null, batteryMinSocPct: null, batteryMaxSocPct: null });
            pending.at(-1).resolve({ days: [row(7777)] });
            await Promise.resolve();
            pending[0].resolve({ days: [row(1111)] });
            pending[1].reject(new Error("offline"));
        });
        await expect.poll(() => page.evaluate(() => (document.querySelector("helman-solar-inspector") as any)
            ._historyDays.find((day: any) => day.dayKey === "2026-09-15")?.aggregate.solarWh)).toBe(7777);
        await browseMonth(page, "2026-08");
        await page.evaluate(() => (window as any).__pendingSummaries.at(-1).reject(new Error("offline")));
        expect((await calendarState(page)).stored).toContain("2026-09-15");
    });

    test("leap February is continuous and resizing or summary updates preserve browsing", async ({ page }) => {
        await browseMonth(page, "2024-02");
        expect((await calendarState(page)).visible.filter((cell) => cell.day.startsWith("2024-02"))).toHaveLength(29);
        await calendarRow(page).evaluate((row) => { row.scrollTop += 72; });
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const before = await calendarState(page);
        await page.setViewportSize({ width: 420, height: 900 });
        await page.evaluate(async () => {
            const inspector = document.querySelector("helman-solar-inspector") as any;
            inspector._historyDays = [...inspector._historyDays];
            await inspector.updateComplete;
        });
        expect((await calendarState(page)).top).toBe(before.top);
        expect((await calendarState(page)).requests).toEqual(before.requests);
    });
});
