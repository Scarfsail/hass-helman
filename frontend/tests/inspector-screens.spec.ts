import type { InspectorPayload } from "../cards/helman-api";
import { test, expect, type Page } from "@playwright/test";
import {
    STOP_MONTH_VIEW,
    clickStop,
    loadCardBundle,
    mountInspector as mountAggregateInspector,
    selectColumn,
    selectDaySlots,
    waitForAggregateChart,
} from "./support/inspector-aggregate-harness";

/**
 * Review fixture: the inspector's day and month views, whole, as a reader sees
 * them -- for comparing a change that should leave both looking the same.
 * Opt-in, like the node-detail captures: runs only when `SCREENS` names a
 * directory to write them to.
 */

/** Today, half measured and half forecast, with every row below the chart drawn. */
async function mountDay(page: Page): Promise<void> {
    await page.evaluate(() => {
        const date = new Date().toISOString().slice(0, 10);
        const nowMinutes = 12 * 60;
        const series: Partial<InspectorPayload["series"]> = {
            raw: [], corrected: [], actual: [], invalidated: [], factors: [], impact: [],
            houseForecast: [], houseActual: [], houseActualBreakdown: [], houseForecastBreakdown: [],
            batterySocForecast: [], batterySocActual: [], gridForecast: [], gridActual: [],
            batteryForecast: [], batteryActual: [], importPrice: [], exportPrice: [],
            moneyActual: [], moneyForecast: [],
        };
        for (let minutes = 0; minutes < 1440; minutes += 15) {
            const slot = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
            const sun = Math.max(0, 900 - Math.abs(minutes - 780) * 2);
            const house = -(150 + (minutes > 1080 && minutes < 1320 ? 250 : 0));
            const battery = sun > 400 ? -(sun - 400) / 2 : 120;
            const grid = -(sun + house + battery);
            const soc = Math.min(95, Math.max(15, 30 + (minutes - 480) / 12));
            const measured = minutes < nowMinutes;
            series.corrected!.push({ slot, valueWh: sun });
            series.raw!.push({ slot, valueWh: sun * 0.85 });
            series.impact!.push({ slot, rawWh: sun * 0.85, correctedWh: sun, impactWh: sun * 0.15, factor: 1.15 });
            series.houseForecast!.push({ slot, valueWh: house });
            series.gridForecast!.push({ slot, valueWh: grid });
            series.batteryForecast!.push({ slot, valueWh: battery });
            series.batterySocForecast!.push({ slot, pct: soc });
            series.importPrice!.push({ slot, value: minutes > 1020 && minutes < 1260 ? 6.2 : 3.4 });
            series.exportPrice!.push({ slot, value: 1.1 });
            series.moneyForecast!.push({ slot, cost: grid > 0 ? grid / 1000 * 3.4 : 0, gain: grid < 0 ? -grid / 1000 : 0 });
            series.houseForecastBreakdown!.push({ slot, unmeasuredWh: -house * 0.6, appliances: [
                { entityId: "sensor.washer_energy", label: "Washer", wh: -house * 0.4, switchEntityId: "switch.washer",
                    powerEntityId: "sensor.washer_power", deferrable: true, controllableIds: ["washer"] },
            ] });
            if (!measured) continue;
            series.actual!.push({ slot, valueWh: sun * 0.9 });
            series.houseActual!.push({ slot, valueWh: house * 1.1 });
            series.gridActual!.push({ slot, valueWh: grid * 1.1 });
            series.batteryActual!.push({ slot, valueWh: battery });
            series.batterySocActual!.push({ slot, pct: soc - 3 });
            series.moneyActual!.push({ slot, cost: grid > 0 ? grid / 1000 * 3.4 : 0, gain: grid < 0 ? -grid / 1000 : 0 });
            series.houseActualBreakdown!.push({ slot, unmeasuredWh: -house * 0.7, appliances: [
                { entityId: "sensor.fridge_energy", label: "Fridge", wh: -house * 0.4, switchEntityId: null,
                    powerEntityId: null, deferrable: false, controllableIds: [] },
            ] });
        }
        const payload = window.__inspectorDay({
            date,
            timezone: "UTC",
            status: "ok",
            priceUnit: "CZK/kWh",
            range: { minDate: "2026-01-01", maxDate: date, canGoPrevious: true, canGoNext: false, isToday: true, isFuture: false },
            series: series as InspectorPayload["series"],
            totals: { rawWh: 9000, correctedWh: 10500, actualWh: 5100, houseForecastWh: -4800, houseActualWh: -2300,
                gridForecastWh: -2100, gridActualWh: -900, batteryForecastWh: 600, batteryActualWh: 300,
                moneyActual: { cost: 3.1, gain: 1.2, net: 1.9 }, moneyForecast: { cost: 7.4, gain: 2.6, net: 4.8 } },
            availability: { hasProfile: true },
            batterySocBounds: [],
            trainingExplainability: null,
        });
        document.body.innerHTML = "";
        const el = document.createElement("helman-solar-inspector") as any;
        el.daylightOnlyDefault = false;
        el.slotMinutesDefault = 60;
        el.biasRatioDefault = true;
        el.hass = {
            language: "en",
            config: { time_zone: "UTC" },
            connection: {},
            callWS: window.__mockHass({
                "helman/solar_bias/inspector": async (message: { date: string }) => ({ ...payload, date: message.date }),
            }).callWS,
        };
        document.body.appendChild(el);
    });
    await page.waitForFunction(() => !!(document.querySelector("helman-solar-inspector") as any)
        ?.shadowRoot?.querySelector("helman-solar-price-strip"));
}

test("screenshots of the inspector's day and month views", { tag: "@screens" }, async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 2000 });
    await loadCardBundle(page);
    // A fixed clock, so a capture reads the same whenever it is taken.
    await page.clock.setFixedTime(new Date("2026-06-15T12:00:00Z"));

    await mountDay(page);
    await selectDaySlots(page, 9 * 60, 10 * 60);
    await page.mouse.move(0, 0);
    await expect(page.locator("helman-solar-inspector")).toBeVisible();
    await page.locator("helman-solar-inspector").screenshot({ path: `${process.env.SCREENS}/inspector-day.png` });

    await mountAggregateInspector(page);
    await clickStop(page, STOP_MONTH_VIEW);
    await waitForAggregateChart(page);
    await selectColumn(page, 2);
    await page.mouse.move(0, 0);
    await page.locator("helman-solar-inspector").screenshot({ path: `${process.env.SCREENS}/inspector-month.png` });
});
