import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * A day the recorder has purged the raw states of.
 *
 * Such a day is drawn back from hourly long-term statistics, so its measured
 * series are sixty minutes wide and there is no finer view of it to offer. Two
 * things follow, and both are here because either one failing is silent: the
 * width toggle must not offer 15 or 30, and the reader must be told why the
 * chart looks coarser than the one they opened it from. A day inside the purge
 * horizon carries the same payload shape with `dataGranularityMinutes: 15` and
 * must be entirely unaffected.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const DAY = "2025-06-11";

async function loadCardBundle(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-inspector"));
}

/**
 * The inspector on an actuals-only day at the given granularity.
 *
 * Actuals and nothing else, because that is exactly what a statistics-backed
 * day has: the archived forecast lives in a state attribute and is not
 * recoverable, so `hasActuals` alone has to keep the chart drawing.
 */
async function mountInspector(page: Page, granularity: number): Promise<void> {
    await page.evaluate(({ date, granularity }) => {
        const actual: Array<{ timestamp: string; valueWh: number }> = [];
        for (let m = 0; m < 1440; m += granularity) {
            const hh = String(Math.floor(m / 60)).padStart(2, "0");
            const mm = String(m % 60).padStart(2, "0");
            actual.push({
                timestamp: `${date}T${hh}:${mm}:00`,
                valueWh: Math.max(0, 400 - Math.abs(m - 720) / 2),
            });
        }
        const payload = {
            date,
            timezone: "UTC",
            dataGranularityMinutes: granularity,
            status: "ok",
            effectiveVariant: null,
            trainedAt: null,
            range: {
                minDate: "2024-03-01", maxDate: date, canGoPrevious: true, canGoNext: false,
                isToday: false, isFuture: false,
            },
            series: {
                raw: [], corrected: [], actual, invalidated: [], factors: [], impact: [],
                houseForecast: [], houseActual: [],
                batterySocForecast: [], batterySocActual: [],
                gridForecast: [], gridActual: [], batteryForecast: [], batteryActual: [],
            },
            totals: {
                rawWh: null, correctedWh: null, actualWh: 1000,
                houseForecastWh: null, houseActualWh: null,
                gridForecastWh: null, gridActualWh: null,
                batteryForecastWh: null, batteryActualWh: null,
            },
            availability: {
                hasRawForecast: false, hasCorrectedForecast: false, hasActuals: true,
                hasInvalidated: false, hasProfile: true, hasHouseForecast: false,
                hasHouseActual: false, hasBatterySocForecast: false, hasBatterySocActual: false,
                hasGridForecast: false, hasGridActual: false, hasBatteryForecast: false,
                hasBatteryActual: false,
            },
            batterySocBounds: [],
            trainingExplainability: null,
        };

        document.body.innerHTML = "";
        const el = document.createElement("helman-solar-inspector") as any;
        el.daylightOnlyDefault = false;
        // The narrow default, so a clamp to 60 is a change this test can see
        // rather than the value it would have had anyway.
        el.slotMinutesDefault = 15;
        el.hass = {
            language: "en",
            config: { time_zone: "UTC" },
            connection: {},
            callWS: async (msg: { date: string }) => ({ ...payload, date: msg.date }),
        };
        document.body.appendChild(el);
    }, { date: DAY, granularity });

    await page.waitForFunction(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        return !!el?.shadowRoot?.querySelector(".chart-wrap svg");
    });
}

/** Each width stop as the reader sees it: its label and whether it is offered. */
async function widthStops(page: Page): Promise<Array<{ label: string; disabled: boolean }>> {
    return page.evaluate(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        return [...el.shadowRoot.querySelectorAll(".slot-size-button")].map((button: any) => ({
            label: (button.textContent ?? "").trim(),
            disabled: button.disabled === true,
        }));
    });
}

async function notes(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        return [...el.shadowRoot.querySelectorAll(".note")].map(
            (note) => note.textContent?.trim() ?? "",
        );
    });
}

test.describe("a day drawn from hourly statistics", () => {
    test("offers no width finer than the data, and says why", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, 60);

        expect(await widthStops(page)).toEqual([
            { label: "15", disabled: true },
            { label: "30", disabled: true },
            { label: "60", disabled: false },
            // The aggregate stops read their own statistics and are never
            // affected by the day's granularity.
            { label: "D", disabled: false },
            { label: "M", disabled: false },
        ]);

        const hourly = (await notes(page)).find((text) => text.includes("hourly statistics"));
        expect(hourly).toBeTruthy();
    });

    test("clamps the width toggle up to the hour it opened at 15", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, 60);

        const active = await page.evaluate(() => {
            const el = document.querySelector("helman-solar-inspector") as any;
            return el._slotMinutes;
        });
        expect(active).toBe(60);
    });

    test("keeps its last hour, which the 15-minute cover rule would have dropped", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, 60);

        // A wider bucket is only history once the actuals span all of it. That
        // rule measures how far they reach by adding one sample width to the
        // last point, so on an hourly day the 23:00 point covers to midnight --
        // adding the 15-minute default instead would cover only to 23:15 and
        // silently drop the last hour of every measured series, while the daily
        // totals, which are slot-width independent, still counted it.
        const lastSlot = await page.evaluate(() => {
            const el = document.querySelector("helman-solar-inspector") as any;
            const view = el._viewForSlot(el._payload);
            const points = view.series.actual;
            return points[points.length - 1]?.timestamp ?? null;
        });
        expect(lastSlot).toContain("T23:00");
    });

    test("draws its actuals with no forecast at all", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, 60);

        // `hasActuals` alone keeps the chart on screen; a day with a forecast
        // series would prove nothing about the actuals-only case.
        const bars = await page.evaluate(() => {
            const el = document.querySelector("helman-solar-inspector") as any;
            return el.shadowRoot.querySelectorAll(".chart-wrap svg rect").length;
        });
        expect(bars).toBeGreaterThan(0);
        expect((await notes(page)).some((text) => text.includes("No data is available"))).toBe(
            false,
        );
    });
});

test.describe("a day still held in raw states", () => {
    test("keeps every width stop and shows no purge marker", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, 15);

        expect((await widthStops(page)).map((stop) => stop.disabled)).toEqual([
            false, false, false, false, false,
        ]);
        expect((await notes(page)).some((text) => text.includes("hourly statistics"))).toBe(false);

        const active = await page.evaluate(() => {
            const el = document.querySelector("helman-solar-inspector") as any;
            return el._slotMinutes;
        });
        expect(active).toBe(15);
    });
});
