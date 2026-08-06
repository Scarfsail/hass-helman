import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The inspector's vertical time grid.
 *
 * The grid used to be three-hourly, which put the lines nowhere near the slots
 * the charts are actually drawn and selected in. It is now a line per slot,
 * with hour numbers on as many of them as the width allows, and every row --
 * chart, SoC, price, schedule lanes -- ruled by the same lines. What is worth
 * pinning is that the lines follow the slot picker, that the labels thin out
 * rather than collide, and that the labelled lines stay stronger than the rest:
 * the muted/labelled split is the only thing keeping the coarse scale readable
 * once there is a line every quarter hour.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const DAY = "2026-07-18";

async function loadCardBundle(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-inspector"));
}

/**
 * The inspector on a full-day axis with solar and a battery SoC forecast, so
 * both the main chart and the SoC strip are drawn and can be compared.
 */
async function mountInspector(page: Page, slotMinutes: number): Promise<void> {
    await page.evaluate(({ date, slot }) => {
        const corrected: Array<{ timestamp: string; valueWh: number }> = [];
        const impact: Array<Record<string, unknown>> = [];
        const soc: Array<{ slot: string; pct: number }> = [];
        for (let m = 0; m < 1440; m += 15) {
            const hh = String(Math.floor(m / 60)).padStart(2, "0");
            const mm = String(m % 60).padStart(2, "0");
            const v = Math.max(0, 400 - Math.abs(m - 720) / 2);
            corrected.push({ timestamp: `${date}T${hh}:${mm}:00`, valueWh: v });
            soc.push({ slot: `${hh}:${mm}`, pct: 40 });
            impact.push({ slot: `${hh}:${mm}`, rawWh: v, correctedWh: v, impactWh: 0, factor: 1 });
        }
        const payload = {
            date,
            timezone: "UTC",
            status: "ok",
            effectiveVariant: null,
            trainedAt: null,
            range: {
                minDate: date, maxDate: date, canGoPrevious: false, canGoNext: false,
                isToday: true, isFuture: false,
            },
            series: {
                raw: [], corrected, actual: [], invalidated: [], factors: [], impact,
                houseForecast: [], houseActual: [],
                batterySocForecast: soc, batterySocActual: [],
                gridForecast: [], gridActual: [], batteryForecast: [], batteryActual: [],
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
                hasHouseActual: false, hasBatterySocForecast: true, hasBatterySocActual: false,
                hasGridForecast: false, hasGridActual: false, hasBatteryForecast: false,
                hasBatteryActual: false,
            },
            batterySocBounds: [],
            trainingExplainability: null,
        };

        document.body.innerHTML = "";
        const el = document.createElement("helman-solar-inspector") as any;
        el.daylightOnlyDefault = false;
        el.slotMinutesDefault = slot;
        el.hass = {
            language: "en",
            config: { time_zone: "UTC" },
            connection: {},
            callWS: async (msg: { date: string }) => ({ ...payload, date: msg.date }),
        };
        document.body.appendChild(el);
    }, { date: DAY, slot: slotMinutes });

    await page.waitForFunction(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        return !!el?.shadowRoot?.querySelector(".chart-wrap svg");
    });
}

/**
 * Every vertical gridline of a row: its x, and the weight it is drawn at --
 * 0.55 for the lines that carry an hour on the chart's axis, 0.22 for the rest.
 */
async function gridLines(
    page: Page,
    selector: string,
): Promise<Array<{ x: number; opacity: number }>> {
    return page.evaluate((sel) => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const svg = el.shadowRoot.querySelector(sel) as SVGSVGElement;
        return [...svg.querySelectorAll("line")]
            .filter((line) => line.getAttribute("x1") === line.getAttribute("x2"))
            .map((line) => ({
                x: Math.round(Number(line.getAttribute("x1"))),
                opacity: Number(line.getAttribute("opacity")),
            }))
            // The now marker is a vertical line too, and it is not part of the grid.
            .filter((line) => line.opacity === 0.55 || line.opacity === 0.22);
    }, selector);
}

/** The hour numbers printed under the main chart, in the order they are drawn. */
async function hourLabels(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        return [...el.shadowRoot.querySelectorAll(".chart-wrap svg text")]
            .map((text) => text.textContent ?? "")
            .filter((text) => /^\d{2}$/.test(text));
    });
}

/** The chart's x scale, read off the layout the card is actually drawing at. */
async function chartXForMinutes(page: Page, minutes: number): Promise<number> {
    return page.evaluate((m) => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const layout = el._lastLayoutForStrip;
        const span = layout.dayEndMinutes - layout.dayStartMinutes;
        return layout.margin.left + ((m - layout.dayStartMinutes) / span) * layout.plotWidth;
    }, minutes);
}

test.describe("solar inspector slot grid", () => {
    test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 1100, height: 900 });
        await loadCardBundle(page);
    });

    for (const slotMinutes of [15, 30, 60]) {
        test(`a line per ${slotMinutes}-minute slot, on the slot boundaries`, async ({ page }) => {
            await mountInspector(page, slotMinutes);
            const lines = await gridLines(page, ".chart-wrap svg");
            // Every slot boundary of the day, both edges included.
            const expected: number[] = [];
            for (let m = 0; m <= 1440; m += slotMinutes) {
                expected.push(Math.round(await chartXForMinutes(page, m)));
            }
            expect(lines.map((line) => line.x)).toEqual(expected);
        });
    }

    test("every hour is numbered when the width allows it", async ({ page }) => {
        await mountInspector(page, 15);
        // Both edges of the day are drawn, so 00 and 24 are both numbered.
        expect(await hourLabels(page)).toEqual(
            Array.from({ length: 25 }, (_, hour) => String(hour).padStart(2, "0")),
        );
        // 96 quarter hours plus the day's closing edge.
        expect(await gridLines(page, ".chart-wrap svg")).toHaveLength(97);
    });

    test("a narrow card drops to every third hour rather than colliding", async ({ page }) => {
        await page.setViewportSize({ width: 380, height: 900 });
        await loadCardBundle(page);
        await mountInspector(page, 15);
        expect(await hourLabels(page)).toEqual(
            ["00", "03", "06", "09", "12", "15", "18", "21", "24"],
        );
    });

    test("the numbered lines are stronger than the rest", async ({ page }) => {
        await mountInspector(page, 15);
        const lines = await gridLines(page, ".chart-wrap svg");
        const strong = lines.filter((line) => line.opacity === 0.55).map((line) => line.x);
        const muted = lines.filter((line) => line.opacity === 0.22).map((line) => line.x);
        // One strong line per numbered hour, and the quarter hours between them muted.
        expect(strong).toHaveLength(25);
        expect(muted).toHaveLength(72);
        const labelXs = await page.evaluate(() => {
            const el = document.querySelector("helman-solar-inspector") as any;
            return [...el.shadowRoot.querySelectorAll(".chart-wrap svg text")]
                .filter((text) => /^\d{2}$/.test(text.textContent ?? ""))
                .map((text) => Math.round(Number(text.getAttribute("x"))));
        });
        expect(strong).toEqual(labelXs);
    });

    test("the SoC strip is ruled by the same lines as the chart", async ({ page }) => {
        await mountInspector(page, 30);
        const chart = await gridLines(page, ".chart-wrap svg");
        const soc = await gridLines(page, ".soc-strip-wrap svg");
        expect(soc).toEqual(chart);
    });
});
