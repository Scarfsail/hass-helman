import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The SoC strip at 30- and 60-minute widths.
 *
 * The forecast reports the level its slot *ends* at, so collapsing it onto a
 * wider grid has to keep each bucket's last reading rather than the one at its
 * start. Keeping the start reading dragged the whole trajectory a native slot
 * late, which painted columns as charging for up to a bucket's width after the
 * charging had stopped -- a strip that disagreed with the power chart above it
 * at 30 and 60 minutes while matching it exactly at 15.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const DAY = "2026-07-18";

/** The battery charges from 10:00 to 12:00 and holds for the rest of the day. */
const CHARGE_FROM = 600;
const CHARGE_UNTIL = 720;

async function mountInspector(page: Page, slotMinutes: number): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-inspector"));

    await page.evaluate(({ date, slot, chargeFrom, chargeUntil }) => {
        const socForecast: Array<{ slot: string; pct: number }> = [];
        const batteryForecast: Array<{ timestamp: string; valueWh: number }> = [];
        const corrected: Array<{ timestamp: string; valueWh: number }> = [];
        const impact: Array<Record<string, unknown>> = [];
        let pct = 40;
        for (let m = 0; m < 1440; m += 15) {
            const hh = String(Math.floor(m / 60)).padStart(2, "0");
            const mm = String(m % 60).padStart(2, "0");
            const charging = m >= chargeFrom && m < chargeUntil;
            corrected.push({
                timestamp: `${date}T${hh}:${mm}:00`,
                valueWh: Math.max(0, 400 - Math.abs(m - 720) / 2),
            });
            // A slot only counts as selectable once the impact series names it.
            impact.push({ slot: `${hh}:${mm}`, rawWh: 0, correctedWh: 0, impactWh: 0, factor: 1 });
            // 5 points of SoC per charging quarter hour; the point stamped with
            // the slot carries the level that slot *ends* at.
            if (charging) pct += 5;
            socForecast.push({ slot: `${hh}:${mm}`, pct });
            batteryForecast.push({
                timestamp: `${date}T${hh}:${mm}:00`,
                valueWh: charging ? 500 : 0,
            });
        }
        const payload = {
            date,
            timezone: "UTC",
            status: "ok",
            effectiveVariant: null,
            trainedAt: null,
            range: {
                minDate: date, maxDate: date, canGoPrevious: false, canGoNext: false,
                isToday: false, isFuture: true,
            },
            series: {
                raw: [], corrected, actual: [], invalidated: [], factors: [], impact,
                houseForecast: [], houseActual: [],
                batterySocForecast: socForecast, batterySocActual: [],
                gridForecast: [], gridActual: [], batteryForecast, batteryActual: [],
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
                hasGridForecast: false, hasGridActual: false, hasBatteryForecast: true,
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
    }, { date: DAY, slot: slotMinutes, chargeFrom: CHARGE_FROM, chargeUntil: CHARGE_UNTIL });

    await page.waitForFunction(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        return !!el?.shadowRoot?.querySelector(".soc-strip-wrap svg");
    });
}

/** Every SoC column drawn as charging, as the minute-of-day it starts at. */
async function chargingColumnMinutes(page: Page): Promise<number[]> {
    return page.evaluate(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const layout = el._lastLayoutForStrip;
        const span = layout.dayEndMinutes - layout.dayStartMinutes;
        const minutesForX = (x: number) =>
            layout.dayStartMinutes + ((x - 0.5 - layout.margin.left) / layout.plotWidth) * span;
        const svg = el.shadowRoot.querySelector(".soc-strip-wrap svg") as SVGSVGElement;
        return [...svg.querySelectorAll("rect")]
            .filter((rect) => (rect.getAttribute("style") ?? "").includes("--helman-charge"))
            .map((rect) => Math.round(minutesForX(Number(rect.getAttribute("x")))))
            .sort((a, b) => a - b);
    });
}

test.describe("solar inspector SoC strip grouping", () => {
    test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 1100, height: 900 });
    });

    for (const slotMinutes of [15, 30, 60]) {
        test(`at ${slotMinutes} minutes only the charging slots read as charging`, async ({ page }) => {
            await mountInspector(page, slotMinutes);
            const expected: number[] = [];
            for (let m = CHARGE_FROM; m < CHARGE_UNTIL; m += slotMinutes) expected.push(m);
            expect(await chargingColumnMinutes(page)).toEqual(expected);
        });
    }

    test("a 60-minute column is labelled with the level its hour ends at", async ({ page }) => {
        await mountInspector(page, 60);
        const labels = await page.evaluate(() => {
            const el = document.querySelector("helman-solar-inspector") as any;
            const svg = el.shadowRoot.querySelector(".soc-strip-wrap svg") as SVGSVGElement;
            // A column's own label is the centred one; the strip's percentage
            // axis is drawn with the same element on the left margin.
            return [...svg.querySelectorAll('text[text-anchor="middle"]')]
                .map((text) => ({ x: Number(text.getAttribute("x")), label: text.textContent ?? "" }))
                .sort((a, b) => a.x - b.x)
                .map((entry) => entry.label);
        });
        // 40% held until 10:00, then 5% per quarter hour: 60% by 11:00, 80% by
        // 12:00, and held there after.
        expect(labels.slice(9, 14)).toEqual(["40%", "60%", "80%", "80%", "80%"]);
    });

    /**
     * The panel states a level, not a sum, so a selection reports the one it
     * ends on -- the same level the last column drawn under it shows. It used to
     * report the selection's opening reading, which for a multi-slot selection
     * is a level from somewhere in its middle.
     */
    test("a multi-slot selection reports the level it ends at", async ({ page }) => {
        await mountInspector(page, 15);
        const socMetric = async (slots: string[]) =>
            page.evaluate((selected) => {
                const el = document.querySelector("helman-solar-inspector") as any;
                el._slotSelection = {
                    selectedSlots: selected,
                    focusSlot: selected[0],
                    anchorSlot: selected[0],
                };
                el.requestUpdate();
                return el.updateComplete.then(() => {
                    const cards = [...el.shadowRoot.querySelectorAll(".metric-card")];
                    const soc = cards.find((card: Element) => /SoC/.test(card.textContent ?? ""));
                    return (soc?.querySelector(".metric-value")?.textContent ?? "").trim();
                });
            }, slots);

        // 10:00–11:00 charges 40% to 60%, four quarter hours at 5% each.
        expect(await socMetric(["10:00"])).toBe("45.0 %");
        expect(await socMetric(["10:00", "10:15", "10:30", "10:45"])).toBe("60.0 %");
    });
});
