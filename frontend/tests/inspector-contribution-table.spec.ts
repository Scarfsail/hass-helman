import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The training-contribution table on a past day whose forecast curve is gone.
 *
 * A few days back the recorded forecast entity is purged, so a past day's
 * payload carries no `raw` or `impact` series — only `actual` (and here a
 * `corrected` curve the chart can still draw) and the per-slot
 * `trainingExplainability`, which is keyed by slot-of-day and is there for
 * every date. The selected-slot detail used to narrow the selection against
 * `series.impact`; on these days that set is empty, so the whole detail panel —
 * the "Training contribution" table included — rendered nothing on exactly the
 * days a reader opens to see what a slot contributed to the fit.
 *
 * The table rides with the raw diagnostic, so it shows only when that is on
 * (`show_bias_ratio` / the legend), and then on any date the slot has an
 * explainability entry.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const PAST_DAY = "2026-07-10";

async function mountPurgedPastDay(
    page: Page,
    { biasRatioDefault }: { biasRatioDefault: boolean },
): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-inspector"));

    await page.evaluate(({ date, biasRatioDefault }) => {
        const corrected: Array<{ timestamp: string; valueWh: number }> = [];
        const actual: Array<{ timestamp: string; valueWh: number }> = [];
        for (let m = 0; m < 1440; m += 15) {
            const hh = String(Math.floor(m / 60)).padStart(2, "0");
            const mm = String(m % 60).padStart(2, "0");
            const v = Math.max(0, 400 - Math.abs(m - 720) / 2);
            corrected.push({ timestamp: `${date}T${hh}:${mm}:00`, valueWh: v });
            actual.push({ timestamp: `${date}T${hh}:${mm}:00`, valueWh: v * 1.05 });
        }
        const payload = {
            date,
            timezone: "UTC",
            status: "ok",
            effectiveVariant: "adjusted",
            trainedAt: "2026-07-11T03:00:00+00:00",
            range: {
                minDate: "2026-06-01", maxDate: date,
                canGoPrevious: true, canGoNext: true,
                isToday: false, isFuture: false,
            },
            // Past the forecast entity's purge horizon: no raw curve, and with
            // it no impact — only what the meter measured and the corrected
            // curve rebuilt from the profile.
            series: {
                raw: [], corrected, actual, invalidated: [], factors: [], impact: [],
                houseForecast: [], houseActual: [],
                batterySocForecast: [], batterySocActual: [],
                gridForecast: [], gridActual: [], batteryForecast: [], batteryActual: [],
            },
            totals: {
                rawWh: null, correctedWh: 3000, actualWh: 3150,
                houseForecastWh: null, houseActualWh: null,
                gridForecastWh: null, gridActualWh: null,
                batteryForecastWh: null, batteryActualWh: null,
            },
            availability: {
                hasRawForecast: false, hasCorrectedForecast: true, hasActuals: true,
                hasInvalidated: false, hasProfile: true, hasHouseForecast: false,
                hasHouseActual: false, hasBatterySocForecast: false, hasBatterySocActual: false,
                hasGridForecast: false, hasGridActual: false, hasBatteryForecast: false,
                hasBatteryActual: false,
            },
            batterySocBounds: [],
            trainingExplainability: {
                trainedAt: "2026-07-11T03:00:00+00:00",
                aggregationMethod: "trimmed_mean",
                slots: {
                    "12:00": {
                        factor: 1.08,
                        rawRatio: 1.08,
                        clamped: false,
                        forecastSumWh: 12000,
                        actualSumWh: 12960,
                        rows: [
                            { date: "2026-07-03", forecastWh: 2000, actualWh: 2200, ratio: 1.1, status: "included", reason: null },
                            { date: "2026-07-04", forecastWh: 1900, actualWh: 2010, ratio: 1.058, status: "included", reason: null },
                        ],
                        interpolated: false,
                        interpolationAnchors: null,
                    },
                },
            },
        };

        document.body.innerHTML = "";
        const el = document.createElement("helman-solar-inspector") as any;
        el.daylightOnlyDefault = false;
        el.slotMinutesDefault = 15;
        el.biasRatioDefault = biasRatioDefault;
        el.hass = {
            language: "en",
            config: { time_zone: "UTC" },
            connection: {},
            callWS: async (msg: { date: string }) => ({ ...payload, date: msg.date }),
        };
        document.body.appendChild(el);
    }, { date: PAST_DAY, biasRatioDefault });

    await page.waitForFunction(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        return !!el?.shadowRoot?.querySelector(".chart-wrap svg");
    });
}

/** Select a slot the way a chart click would, then let the card re-render. */
async function selectSlot(page: Page, slot: string): Promise<void> {
    await page.evaluate(async (slot) => {
        const el = document.querySelector("helman-solar-inspector") as any;
        el._selectSlot(slot, "replace");
        await el.updateComplete;
    }, slot);
}

function contributionToggleText(page: Page): Promise<string | null> {
    return page.evaluate(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const btn = el.shadowRoot?.querySelector(".contribution-toggle");
        return btn ? (btn.textContent ?? "").trim() : null;
    });
}

test("a purged past day still shows a slot's training contribution", async ({ page }) => {
    await mountPurgedPastDay(page, { biasRatioDefault: true });
    await selectSlot(page, "12:00");

    expect(await contributionToggleText(page)).toContain("Training contribution");

    // The rows come through and the table expands.
    await page.evaluate(async () => {
        const el = document.querySelector("helman-solar-inspector") as any;
        el.shadowRoot.querySelector(".contribution-toggle").click();
        await el.updateComplete;
    });
    const rowDates = await page.evaluate(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        return [...el.shadowRoot.querySelectorAll(".contribution-table tbody tr td:first-child")]
            .map((td) => td.textContent?.trim());
    });
    expect([...rowDates].sort()).toEqual(["2026-07-03", "2026-07-04"]);
});

test("the contribution table stays behind the raw diagnostic", async ({ page }) => {
    await mountPurgedPastDay(page, { biasRatioDefault: false });
    await selectSlot(page, "12:00");

    expect(await contributionToggleText(page)).toBeNull();
});
