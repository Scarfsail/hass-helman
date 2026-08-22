import { expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The harness the inspector's aggregate-view specs mount against.
 *
 * Shared rather than duplicated, and shared *here* rather than exported from a
 * spec file: importing one spec from another re-registers its `describe` block
 * in the importer, so every test in it would run twice. A support module
 * carries no tests of its own and can be imported freely.
 *
 * The span answer is generated from the requested window rather than fixed, so
 * a test can assert "one column per day of the month" without hard-coding a
 * month -- which month it is depends on when the suite runs.
 */

export const BUNDLE = resolve(
    __dirname,
    "../../../custom_components/helman/frontend_compiled/helman-card.js",
);

/** Toggle stops, narrowest first: three slot widths, then day and month. */
export const STOP_MONTH_VIEW = 3;
export const STOP_YEAR_VIEW = 4;
export const STOP_SLOT_60 = 2;

export async function loadCardBundle(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-inspector"));
}

/**
 * The inspector against a backend that answers both the day read and the span
 * read, recording what each was asked for.
 *
 * The span answer is generated from the requested window rather than fixed, so
 * the test can assert "one column per day of the month" without hard-coding a
 * month — which month it is depends on when the suite runs.
 *
 * `holes` punches two gaps into a day-bucketed span: the fourth bucket keeps
 * only its upper SoC bound, and the fifth has no readings at all. Both are
 * shapes the backend really produces — a battery sensor that started recording
 * mid-day, a day the recorder never saw — and both are drawn by *not* drawing.
 */
export async function mountInspector(
    page: Page,
    holes = false,
    variant: "" | "no-gain" | "over-soc" | "no-energy" = "",
    minDate = "2020-01-01",
    dayMinDate: string | null = null,
): Promise<void> {
    await page.evaluate(([punchHoles, shape, floor, rawDayFloor]: [boolean, string, string, string | null]) => {
        const today = new Date();
        const iso = (date: Date) => date.toISOString().slice(0, 10);
        const date = iso(today);
        // The backend answers the two views with two different floors: the
        // aggregates are bounded by long-term statistics, the day view by the
        // raw states the recorder purges. Same value unless a test says
        // otherwise, so every existing case is unaffected.
        const dayFloor = rawDayFloor ?? floor;

        const corrected: Array<{ timestamp: string; valueWh: number }> = [];
        const price: Array<{ slot: string; value: number }> = [];
        for (let m = 0; m < 1440; m += 15) {
            const hh = String(Math.floor(m / 60)).padStart(2, "0");
            const mm = String(m % 60).padStart(2, "0");
            corrected.push({
                timestamp: `${date}T${hh}:${mm}:00`,
                valueWh: Math.max(0, 400 - Math.abs(m - 720) / 2),
            });
            price.push({ slot: `${hh}:${mm}`, value: 3.5 });
        }

        const dayPayload = {
            date,
            timezone: "UTC",
            status: "ok",
            effectiveVariant: null,
            trainedAt: null,
            priceUnit: "CZK/kWh",
            range: {
                minDate: dayFloor, maxDate: date, canGoPrevious: true, canGoNext: false,
                isToday: true, isFuture: false,
            },
            series: {
                raw: [], corrected, actual: [], invalidated: [], factors: [], impact: [],
                houseForecast: [], houseActual: [],
                batterySocForecast: [], batterySocActual: [],
                gridForecast: [], gridActual: [], batteryForecast: [], batteryActual: [],
                importPrice: price, exportPrice: [],
            },
            totals: {
                rawWh: null, correctedWh: null, actualWh: null,
                houseForecastWh: null, houseActualWh: null,
                gridForecastWh: null, gridActualWh: null,
                batteryForecastWh: null, batteryActualWh: null,
            },
            availability: {
                hasRawForecast: false, hasCorrectedForecast: true, hasActuals: false,
                hasInvalidated: false, hasProfile: true, hasHouseForecast: false,
                hasHouseActual: false, hasBatterySocForecast: false, hasBatterySocActual: false,
                hasGridForecast: false, hasGridActual: false, hasBatteryForecast: false,
                hasBatteryActual: false,
            },
            batterySocBounds: [],
            trainingExplainability: null,
        };

        (window as any).__spanRequests = [];
        (window as any).__dayRequests = [];

        /** Every bucket of the requested window, with plausible numbers. */
        const spanDays = (start: string, end: string, bucket: string) => {
            const rows: Array<Record<string, unknown>> = [];
            const cursor = new Date(`${start}T00:00:00Z`);
            const last = new Date(`${end}T00:00:00Z`);
            let index = 0;
            while (cursor <= last) {
                const halfKnown = punchHoles && bucket !== "month" && index === 3;
                const missing = punchHoles && bucket !== "month" && index === 4;
                // An export price entity with no statistics: every bucket is
                // priced on the import side and on neither other.
                const noGain = shape === "no-gain";
                // A BMS that rounds past the top of its own scale, and the same
                // bucket's neighbour sitting exactly on it.
                const overSoc = shape === "over-soc";
                // Energy meters with no statistics at all, SoC and money intact.
                const noEnergy = shape === "no-energy";
                rows.push({
                    date: iso(cursor),
                    solarWh: missing || noEnergy ? null : 20000 + index * 500,
                    gridImportKwh: missing || noEnergy ? null : 4,
                    gridExportKwh: missing || noEnergy ? null : 6,
                    batteryMinSocPct: halfKnown || missing ? null : 20,
                    batteryMaxSocPct: missing
                        ? null
                        : overSoc ? (index === 0 ? 100.4 : 100) : 90,
                    houseWh: missing || noEnergy ? null : 18000,
                    batteryChargeWh: missing || noEnergy ? null : 7000,
                    batteryDischargeWh: missing || noEnergy ? null : 6000,
                    moneyCost: missing ? null : 40,
                    moneyGain: missing || noGain ? null : 12,
                });
                index += 1;
                if (bucket === "month") {
                    cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
                } else {
                    cursor.setUTCDate(cursor.getUTCDate() + 1);
                }
            }
            return rows;
        };

        document.body.innerHTML = "";
        const el = document.createElement("helman-solar-inspector") as any;
        el.daylightOnlyDefault = false;
        el.slotMinutesDefault = 30;
        el.hass = {
            language: "en",
            config: { time_zone: "UTC" },
            connection: {},
            callWS: async (msg: any) => {
                if (msg.type === "helman/solar_bias/day_aggregates") {
                    (window as any).__spanRequests.push(msg);
                    return {
                        bucket: msg.bucket ?? "day",
                        currency: "CZK",
                        days: spanDays(msg.start_date, msg.end_date, msg.bucket ?? "day"),
                        // The span payload carries its own bounds, which is
                        // what lets the aggregate views navigate without a day
                        // load having happened first -- and what keeps the day
                        // view's shallower floor out of their way.
                        range: { minDate: floor, maxDate: date },
                    };
                }
                if (msg.type === "helman/solar_bias/inspector") {
                    (window as any).__dayRequests.push(msg.date);
                    return { ...dayPayload, date: msg.date };
                }
                return {};
            },
        };
        document.body.appendChild(el);
    }, [holes, variant, minDate, dayMinDate] as [boolean, string, string, string | null]);

    await page.waitForFunction(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        return !!el?.shadowRoot?.querySelector(".chart-wrap svg");
    });
}

export async function clickStop(page: Page, index: number): Promise<void> {
    await page.evaluate((i) => {
        const buttons = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelectorAll(".slot-size-toggle .slot-size-button");
        (buttons[i] as HTMLElement).click();
    }, index);
}

/** The aggregate chart's per-bucket hit rects, in order. */
export async function columns(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const chart = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-aggregate-chart");
        if (!chart?.shadowRoot) return [];
        return [...chart.shadowRoot.querySelectorAll(".bucket-column")]
            .map((rect: Element) => rect.getAttribute("data-bucket") || "");
    });
}

/** Step the span nav one click back. */
export async function pageBack(page: Page): Promise<void> {
    await page.evaluate(() => {
        const buttons = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelectorAll(".week-nav .week-arrow");
        (buttons[0] as HTMLElement).click();
    });
}

/** Whether the backwards span arrow is offering to go anywhere. */
export async function canPageBack(page: Page): Promise<boolean> {
    return page.evaluate(() => {
        const button = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector(".week-nav .week-arrow") as HTMLButtonElement;
        return !button.disabled;
    });
}

/**
 * The `start_date` of every span asked for with the given bucket, in order.
 *
 * The bucket is the filter because the day pills share this endpoint: they ask
 * for `"day"` over their own seven-day window whatever view is on screen, and
 * those requests are not what a test about span navigation is looking at.
 */
export async function spanStarts(page: Page, bucket: "day" | "month"): Promise<string[]> {
    return page.evaluate((want) =>
        ((window as any).__spanRequests as Array<{ start_date: string; bucket: string }>)
            .filter((msg) => msg.bucket === want)
            .map((msg) => msg.start_date), bucket);
}

/**
 * The span on screen, as the lit pill's key: "2026-08-01" or "2024-01-01".
 *
 * The words that used to head the aggregate views are gone — the pill row names
 * the span and every neighbour with it — so this reads the selection rather
 * than a label. The key is what the card navigates by anyway, and unlike a
 * localized month name it says the same thing under every locale.
 */
export async function selectedSpan(page: Page): Promise<string> {
    return page.evaluate(() => {
        const root = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-span-pills")?.shadowRoot;
        // Both rows light up in the month view -- the year *and* the month
        // inside it -- so the month is the narrower answer and the one that
        // says which span is really on screen. The year view lights no month,
        // and there the year is the whole answer.
        const pill = root?.querySelector(".pill-row.months .pill.selected")
            ?? root?.querySelector(".pill-row.years .pill.selected");
        return pill?.getAttribute("data-span") ?? "";
    });
}

/** Step back, and wait for the row to say the view really moved. */
export async function pageBackAndWait(page: Page): Promise<void> {
    const before = await selectedSpan(page);
    await pageBack(page);
    await page.waitForFunction((previous) => {
        const pills = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-span-pills");
        const key = pills?.shadowRoot?.querySelector(".pill.selected")
            ?.getAttribute("data-span") ?? "";
        return key !== previous;
    }, before);
}

export async function waitForDayChart(page: Page): Promise<void> {
    await page.waitForFunction(() => !!(document.querySelector("helman-solar-inspector") as any)
        .shadowRoot.querySelector(".chart-wrap svg"));
}

export async function waitForAggregateChart(page: Page): Promise<void> {
    await page.waitForFunction(() => {
        const chart = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-aggregate-chart");
        return !!chart?.shadowRoot?.querySelector(".bucket-column");
    });
}

/** The vertex count of each path matching `selector`, in document order. */
export async function bandRuns(page: Page, selector: string): Promise<number[]> {
    return page.evaluate((sel) => {
        const chart = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-aggregate-chart");
        return [...chart.shadowRoot.querySelectorAll(sel)]
            .map((path: Element) => (path.getAttribute("d") || "").match(/[ML]/g)?.length ?? 0);
    }, selector);
}

/** One metrics panel's tiles, as label to value. */
export async function sectionMetrics(page: Page, index: number): Promise<Record<string, string>> {
    return page.evaluate((i) => {
        const root = (document.querySelector("helman-solar-inspector") as any).shadowRoot;
        const section = root.querySelectorAll(".metrics-section")[i];
        const out: Record<string, string> = {};
        for (const card of section.querySelectorAll(".metric-card")) {
            const label = card.querySelector(".metric-label")?.textContent?.trim() ?? "";
            out[label] = card.querySelector(".metric-value")?.textContent?.trim() ?? "";
        }
        return out;
    }, index);
}

/** Click a column, and wait for the selected-bucket panel it opens. */
export async function selectColumn(page: Page, index: number): Promise<void> {
    await page.evaluate((i) => {
        const chart = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector("helman-solar-aggregate-chart");
        (chart.shadowRoot.querySelectorAll(".bucket-column")[i] as SVGElement)
            .dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    }, index);
    await page.waitForFunction(() => !!(document.querySelector("helman-solar-inspector") as any)
        .shadowRoot.querySelector(".drill-button"));
}

