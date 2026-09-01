import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The dashed SoC forecast line across a stretch the forecast never covered.
 *
 * Since the history readers stopped holding across an `unavailable` (#191), a
 * day where the battery forecast sensor was down has slots simply missing from
 * `batterySocForecast`. The line traced over the measured columns joined every
 * bar it had, so those missing slots came out as a smooth diagonal ramp between
 * the last level before the outage and the first one after it -- a trajectory
 * nothing ever forecast, drawn in the one place the change was meant to make
 * the card honest. The pen must lift instead.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const DAY = "2026-07-18";

/** The forecast is missing from 10:00 up to (not including) 12:00. */
const GAP_FROM = 600;
const GAP_UNTIL = 720;

async function mountInspector(page: Page, gap: boolean): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-inspector"));

    await page.evaluate(({ date, withGap, gapFrom, gapUntil }) => {
        const socForecast: Array<{ slot: string; pct: number }> = [];
        const socActual: Array<{ slot: string; pct: number }> = [];
        const corrected: Array<{ timestamp: string; valueWh: number }> = [];
        const actual: Array<{ timestamp: string; valueWh: number }> = [];
        const impact: Array<Record<string, unknown>> = [];
        for (let m = 0; m < 1440; m += 15) {
            const hh = String(Math.floor(m / 60)).padStart(2, "0");
            const mm = String(m % 60).padStart(2, "0");
            const slot = `${hh}:${mm}`;
            impact.push({ slot, rawWh: 0, correctedWh: 0, impactWh: 0, factor: 1 });
            // A forecast and an actual across the whole day: the card needs a
            // chart to draw a body at all, and the strip's measured/forecast
            // seam -- which is what the dashed line is traced over -- follows
            // how far the actuals reach.
            corrected.push({ timestamp: `${date}T${slot}:00`, valueWh: 100 });
            actual.push({ timestamp: `${date}T${slot}:00`, valueWh: 90 });
            // Measured across the whole day, so the dashed forecast line is
            // drawn over every slot -- it only traces the measured part.
            socActual.push({ slot, pct: 50 });
            // The forecast climbs either side of the outage, so a ramp across
            // it would be visibly smooth rather than a step.
            if (withGap && m >= gapFrom && m < gapUntil) continue;
            socForecast.push({ slot, pct: m < gapFrom ? 40 : 80 });
        }
        const payload = {
            date,
            timezone: "UTC",
            status: "ok",
            effectiveVariant: null,
            trainedAt: null,
            range: {
                minDate: date, maxDate: date, canGoPrevious: false, canGoNext: false,
                isToday: false, isFuture: false,
            },
            series: {
                raw: [], corrected, actual, invalidated: [], factors: [], impact,
                houseForecast: [], houseActual: [],
                batterySocForecast: socForecast, batterySocActual: socActual,
                gridForecast: [], gridActual: [], batteryForecast: [], batteryActual: [],
            },
            totals: {
                rawWh: null, correctedWh: null, actualWh: null,
                houseForecastWh: null, houseActualWh: null,
                gridForecastWh: null, gridActualWh: null,
                batteryForecastWh: null, batteryActualWh: null,
            },
            availability: {
                hasRawForecast: false, hasCorrectedForecast: true, hasActuals: true,
                hasInvalidated: false, hasProfile: true, hasHouseForecast: false,
                hasHouseActual: false, hasBatterySocForecast: true, hasBatterySocActual: true,
                hasGridForecast: false, hasGridActual: false, hasBatteryForecast: false,
                hasBatteryActual: false,
            },
            batterySocBounds: [],
            trainingExplainability: null,
        };

        document.body.innerHTML = "";
        const el = document.createElement("helman-solar-inspector") as any;
        el.daylightOnlyDefault = false;
        el.slotMinutesDefault = 15;
        el.hass = {
            language: "en",
            config: { time_zone: "UTC" },
            connection: {},
            callWS: async (msg: { date: string }) => ({ ...payload, date: msg.date }),
        };
        document.body.appendChild(el);
    }, { date: DAY, withGap: gap, gapFrom: GAP_FROM, gapUntil: GAP_UNTIL });

    await page.waitForFunction(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        return !!el?.shadowRoot?.querySelector(".soc-strip-wrap svg");
    });
}

/** The dashed forecast trace's `d`, or "" when it is not drawn. */
async function forecastLinePath(page: Page): Promise<string> {
    return page.evaluate(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const svg = el.shadowRoot.querySelector(".soc-strip-wrap svg") as SVGSVGElement;
        const dashed = [...svg.querySelectorAll("path")].find(
            (path) => path.getAttribute("stroke-dasharray") === "4 3",
        );
        return dashed?.getAttribute("d") ?? "";
    });
}

test.describe("solar inspector SoC forecast line", () => {
    test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 1100, height: 900 });
    });

    test("an unbroken forecast is one continuous trace", async ({ page }) => {
        await mountInspector(page, false);
        const path = await forecastLinePath(page);
        expect(path).not.toBe("");
        expect(path.match(/M/g) ?? []).toHaveLength(1);
    });

    test("a missing stretch breaks the trace rather than ramping across it", async ({ page }) => {
        await mountInspector(page, true);
        const path = await forecastLinePath(page);
        // One subpath either side of the outage: the pen lifts at 10:00 and
        // comes back down at 12:00 instead of drawing a line between them.
        expect(path.match(/M/g) ?? []).toHaveLength(2);
    });
});
