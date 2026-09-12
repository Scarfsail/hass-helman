import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

async function mountInspector(page: Page, { money = true }: { money?: boolean } = {}): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-inspector"));

    await page.evaluate(({ money }) => {
        const date = "2026-07-18";
        const corrected: Array<{ timestamp: string; valueWh: number }> = [];
        const impact: Array<Record<string, unknown>> = [];
        const batterySocForecast: Array<{ slot: string; pct: number }> = [];
        const importPrice: Array<{ slot: string; value: number }> = [];
        const exportPrice: Array<{ slot: string; value: number }> = [];
        const moneyForecast: Array<{ slot: string; cost: number; gain: number }> = [];
        for (let minutes = 0; minutes < 1440; minutes += 15) {
            const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
            const minute = String(minutes % 60).padStart(2, "0");
            const slot = `${hour}:${minute}`;
            corrected.push({ timestamp: `${date}T${slot}:00`, valueWh: 100 });
            impact.push({ slot, rawWh: 0, correctedWh: 0, impactWh: 0, factor: 1 });
            batterySocForecast.push({ slot, pct: 50 });
            importPrice.push({ slot, value: 4 });
            exportPrice.push({ slot, value: 1 });
            if (money) moneyForecast.push({ slot, cost: 0.4, gain: 0.1 });
        }
        const payload = {
            date,
            timezone: "UTC",
            status: "ok",
            effectiveVariant: null,
            trainedAt: null,
            range: { minDate: date, maxDate: date, canGoPrevious: false, canGoNext: false, isToday: false, isFuture: true },
            series: {
                raw: [], corrected, actual: [], invalidated: [], factors: [], impact,
                houseForecast: [], houseActual: [], batterySocForecast, batterySocActual: [],
                gridForecast: [], gridActual: [], batteryForecast: [], batteryActual: [],
                importPrice, exportPrice, moneyActual: [], moneyForecast,
            },
            totals: {
                rawWh: null, correctedWh: null, actualWh: null, houseForecastWh: null,
                houseActualWh: null, gridForecastWh: null, gridActualWh: null,
                batteryForecastWh: null, batteryActualWh: null, moneyActual: null, moneyForecast: null,
            },
            availability: {
                hasRawForecast: false, hasCorrectedForecast: true, hasActuals: false,
                hasInvalidated: false, hasProfile: true, hasHouseForecast: false,
                hasHouseActual: false, hasBatterySocForecast: true, hasBatterySocActual: false,
                hasGridForecast: false, hasGridActual: false, hasBatteryForecast: false,
                hasBatteryActual: false, hasImportPrice: true, hasExportPrice: true,
            },
            priceUnit: "CZK/kWh",
            batterySocBounds: [],
            trainingExplainability: null,
        };
        const inspector = document.createElement("helman-solar-inspector") as any;
        inspector.daylightOnlyDefault = false;
        inspector.hass = {
            language: "en",
            config: { time_zone: "UTC" },
            connection: {},
            callWS: async (message: { date: string }) => ({ ...payload, date: message.date }),
        };
        document.body.appendChild(inspector);
    }, { money });

    await page.waitForFunction(() => {
        const root = (document.querySelector("helman-solar-inspector") as any)?.shadowRoot;
        return !!root?.querySelector(".soc-strip-wrap svg")
            && !!root.querySelector("helman-solar-price-strip")
            && !!root.querySelector("helman-solar-money-strip")
            && !!root.querySelector("helman-solar-schedule-band-strip");
    });
}

test.describe("solar inspector strip layout", () => {
    test("keeps every strip persistent while ordinary labels stay vertical", async ({ page }) => {
        await mountInspector(page);
        const layout = await page.evaluate(() => {
            const root = (document.querySelector("helman-solar-inspector") as any).shadowRoot;
            const labels = [...root.querySelectorAll(".compact-strip-label")].map((label: Element) => ({
                text: label.textContent?.trim(),
                writingMode: getComputedStyle(label).writingMode,
                transform: getComputedStyle(label).transform,
            }));
            const scheduleHeader = root.querySelector(".strip-header-row") as HTMLElement;
            const scheduleHours = [...scheduleHeader.querySelectorAll(".schedule-header-hour")]
                .map((hour: Element) => hour.textContent?.trim());
            const chartHours = [...root.querySelectorAll(".chart-wrap svg text")]
                .map((text: Element) => text.textContent?.trim())
                .filter((text): text is string => /^\d{2}$/.test(text ?? ""));
            return {
                bodies: {
                    soc: !!root.querySelector(".soc-strip-wrap svg"),
                    prices: !!root.querySelector("helman-solar-price-strip"),
                    money: !!root.querySelector("helman-solar-money-strip"),
                    schedule: !!root.querySelector("helman-solar-schedule-band-strip"),
                },
                collapseControls: root.querySelectorAll(
                    ".strip-collapse-toggle, .strip-section [aria-expanded], .compact-strip-section [aria-expanded]",
                ).length,
                labels,
                scheduleTitle: scheduleHeader.querySelector(".schedule-header-title")?.textContent?.trim(),
                scheduleTitleTag: scheduleHeader.querySelector(".schedule-header-title")?.tagName,
                executionSwitch: !!scheduleHeader.querySelector("ha-switch"),
                scheduleHours,
                chartHours,
                scheduleHourFontSizes: [...scheduleHeader.querySelectorAll(".schedule-header-hour")]
                    .map((hour: Element) => getComputedStyle(hour).fontSize),
                mainChartOutline: getComputedStyle(root.querySelector(".main-chart-wrap") as HTMLElement).outlineStyle,
                separators: [...root.querySelectorAll(".chart-separator")]
                    .map((separator: Element) => getComputedStyle(separator).borderTopWidth),
                separatorWidths: [...root.querySelectorAll(".chart-separator")]
                    .map((separator: Element) => (separator as HTMLElement).getBoundingClientRect().width),
                widths: {
                    chart: (root.querySelector(".chart-wrap svg") as SVGSVGElement).getBoundingClientRect().width,
                    soc: (root.querySelector(".soc-strip-wrap svg") as SVGSVGElement).getBoundingClientRect().width,
                    prices: (root.querySelector("helman-solar-price-strip") as HTMLElement).getBoundingClientRect().width,
                    money: (root.querySelector("helman-solar-money-strip") as HTMLElement).getBoundingClientRect().width,
                },
                heights: {
                    soc: (root.querySelector(".soc-strip-wrap svg") as SVGSVGElement).getBoundingClientRect().height,
                    prices: (root.querySelector("helman-solar-price-strip") as HTMLElement).getBoundingClientRect().height,
                    money: (root.querySelector("helman-solar-money-strip") as HTMLElement).getBoundingClientRect().height,
                },
            };
        });

        expect(layout.bodies).toEqual({ soc: true, prices: true, money: true, schedule: true });
        expect(layout.collapseControls).toBe(0);
        expect(layout.labels).toEqual([
            expect.objectContaining({ text: "Energy", writingMode: "vertical-rl" }),
            expect.objectContaining({ text: "Battery", writingMode: "vertical-rl" }),
            expect.objectContaining({ text: "Prices", writingMode: "vertical-rl" }),
            expect.objectContaining({ text: "Money", writingMode: "vertical-rl" }),
        ]);
        expect(layout.labels.every((label) => label.transform !== "none")).toBe(true);
        expect(layout.scheduleTitle).toBe("Scheduled actions");
        expect(layout.scheduleTitleTag).toBe("SPAN");
        expect(layout.executionSwitch).toBe(true);
        expect(layout.scheduleHours).toEqual(layout.chartHours);
        expect(layout.scheduleHourFontSizes).toEqual(
            Array(layout.scheduleHours.length).fill("11px"),
        );
        expect(layout.mainChartOutline).toBe("none");
        expect(layout.separators).toEqual(["1px", "1px", "1px", "1px"]);
        expect(layout.separatorWidths).toEqual([
            layout.widths.chart,
            layout.widths.chart,
            layout.widths.chart,
            layout.widths.chart,
        ]);
        expect(layout.widths.soc).toBe(layout.widths.chart);
        expect(layout.widths.prices).toBe(layout.widths.chart);
        expect(layout.widths.money).toBe(layout.widths.chart);
        expect(layout.heights).toEqual({ soc: 65, prices: 65, money: 65 });
    });

    test("hides empty money and scheduled-action sections with their headers", async ({ page }) => {
        await mountInspector(page, { money: false });
        const visibility = await page.evaluate(() => {
            const root = (document.querySelector("helman-solar-inspector") as any).shadowRoot;
            const money = root.querySelector("helman-solar-money-strip") as HTMLElement;
            const schedule = root.querySelector("helman-solar-schedule-band-strip") as HTMLElement;
            return {
                moneyHidden: money.parentElement?.hidden,
                scheduleHidden: schedule.parentElement?.hidden,
            };
        });

        expect(visibility.moneyHidden).toBe(true);
        expect(visibility.scheduleHidden).toBe(true);
    });
});
