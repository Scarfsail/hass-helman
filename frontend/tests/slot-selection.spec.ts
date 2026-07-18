import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Regression guard for the solar-inspector chart's click-to-select alignment.
 *
 * Hovering a slot highlights the slot the cursor sits *inside* (the chart floors
 * the pointer minute to its slot start). Clicking, however, resolved the pointer
 * to the slot whose *start* minute was numerically nearest — so a click on the
 * right half of a slot landed closer to the next slot's start and selected the
 * NEXT slot. The symptom the user reported: hover is fine, but you have to click
 * the left half of a slot to select it; clicking the right half jumps forward one.
 *
 * This pins the contract that a click anywhere inside a slot's pixel span selects
 * that slot — matching hover — so selection and hover never disagree.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

/** Load a bare page with the card bundle so its custom elements are registered. */
async function loadCardBundle(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-inspector"));
}

/** A "HH:MM" slot label for a minute-of-day. */
function slotLabel(minutes: number): string {
    const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
    const mm = String(minutes % 60).padStart(2, "0");
    return `${hh}:${mm}`;
}

/**
 * Mount the inspector with a full-day fixture: 15-minute solar + impact series
 * across the whole day, viewed at the hour-wide (60-min) slot grid so each slot
 * is a comfortably clickable ~27px band. Daylight cropping is off so the x axis
 * spans the whole day (0..1440) and the geometry below is exact.
 */
async function mountInspector(page: Page): Promise<void> {
    await page.evaluate(() => {
        const date = "2026-07-18";
        const corrected: Array<{ timestamp: string; valueWh: number }> = [];
        const impact: Array<{
            slot: string;
            rawWh: number | null;
            correctedWh: number | null;
            impactWh: number | null;
            factor: number | null;
        }> = [];
        for (let m = 0; m < 1440; m += 15) {
            const hh = String(Math.floor(m / 60)).padStart(2, "0");
            const mm = String(m % 60).padStart(2, "0");
            // A gentle midday bump so the chart has something to draw.
            const v = Math.max(0, 400 - Math.abs(m - 720) / 2);
            corrected.push({ timestamp: `${date}T${hh}:${mm}:00`, valueWh: v });
            impact.push({
                slot: `${hh}:${mm}`,
                rawWh: v,
                correctedWh: v,
                impactWh: 0,
                factor: 1,
            });
        }
        const payload = {
            date,
            timezone: "UTC",
            status: "ok",
            effectiveVariant: null,
            trainedAt: null,
            range: {
                minDate: date,
                maxDate: date,
                canGoPrevious: false,
                canGoNext: false,
                isToday: true,
                isFuture: false,
            },
            series: {
                raw: [],
                corrected,
                actual: [],
                invalidated: [],
                factors: [],
                impact,
                houseForecast: [],
                houseActual: [],
                batterySocForecast: [],
                batterySocActual: [],
                gridForecast: [],
                gridActual: [],
                batteryForecast: [],
                batteryActual: [],
            },
            totals: {
                rawWh: null,
                correctedWh: null,
                actualWh: null,
                houseForecastWh: null,
                houseActualWh: null,
                gridForecastWh: null,
                gridActualWh: null,
                batteryForecastWh: null,
                batteryActualWh: null,
            },
            availability: {
                hasRawForecast: false,
                hasCorrectedForecast: true,
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
            batterySocBounds: [],
            trainingExplainability: null,
        };

        const el = document.createElement("helman-solar-inspector") as any;
        // Full-day axis + hour-wide slots so the click geometry is exact and wide.
        el.daylightOnlyDefault = false;
        el.slotMinutesDefault = 60;
        el.hass = {
            language: "en",
            config: { time_zone: "UTC" },
            connection: {},
            // Echo the requested date back so the payload matches _selectedDate.
            callWS: async (msg: { date: string }) => ({ ...payload, date: msg.date }),
        };
        document.body.appendChild(el);
    });

    // Wait for the chart to render (data loads async via the stubbed callWS).
    await page.waitForFunction(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        return !!el?.shadowRoot?.querySelector(".chart-wrap svg");
    });
}

type ChartGeom = {
    /** The chart svg's on-page bounding rect. */
    rect: { left: number; top: number; width: number; height: number };
    /** viewBox width the svg maps its px rect to. */
    viewWidth: number;
    marginLeft: number;
    plotWidth: number;
    dayStartMinutes: number;
    dayEndMinutes: number;
};

/**
 * Read the chart's real layout off the element. `_chartWidth` is driven by a
 * ResizeObserver at runtime, so the viewBox width is whatever the container
 * settled at — the test must map through the actual layout, not assume 720.
 */
async function chartGeom(page: Page): Promise<ChartGeom> {
    return page.evaluate(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const svg = el.shadowRoot.querySelector(".chart-wrap svg") as SVGSVGElement;
        const r = svg.getBoundingClientRect();
        const layout = el._lastLayoutForStrip;
        return {
            rect: { left: r.left, top: r.top, width: r.width, height: r.height },
            viewWidth: layout.width,
            marginLeft: layout.margin.left,
            plotWidth: layout.plotWidth,
            dayStartMinutes: layout.dayStartMinutes,
            dayEndMinutes: layout.dayEndMinutes,
        };
    });
}

/** viewBox x of a minute-of-day under the chart's real axis. */
function xForMinutes(geom: ChartGeom, minutes: number): number {
    const span = geom.dayEndMinutes - geom.dayStartMinutes;
    return geom.marginLeft + ((minutes - geom.dayStartMinutes) / span) * geom.plotWidth;
}

/** On-page px coordinates for a viewBox x at the chart's vertical middle. */
function pagePoint(geom: ChartGeom, viewBoxX: number): { x: number; y: number } {
    return {
        x: geom.rect.left + (viewBoxX / geom.viewWidth) * geom.rect.width,
        y: geom.rect.top + geom.rect.height / 2,
    };
}

/** Currently-selected slot label on the inspector, or null. */
async function selectedSlot(page: Page): Promise<string | null> {
    return page.evaluate(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        return el._selectedSlot ?? null;
    });
}

test.describe("solar inspector slot selection alignment", () => {
    // Hour-wide slots on the full-day axis: slot start minute → its pixel span.
    const SLOT_MINUTES = 60;
    const targetSlotStart = 720; // 12:00

    test("clicking the LEFT half of a slot selects that slot", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page);
        const geom = await chartGeom(page);

        // A viewBox x just inside the left edge of the 12:00 slot.
        const { x, y } = pagePoint(geom, xForMinutes(geom, targetSlotStart) + 2);
        await page.mouse.click(x, y);

        expect(await selectedSlot(page)).toBe(slotLabel(targetSlotStart)); // "12:00"
    });

    test("clicking the RIGHT half of a slot selects that same slot, not the next one", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page);
        const geom = await chartGeom(page);

        // A viewBox x near the right edge of the 12:00 slot. Its pointer minute
        // sits closer to the 13:00 start than to 12:00 — the exact case the old
        // nearest-start logic mis-resolved to the next slot.
        const { x, y } = pagePoint(geom, xForMinutes(geom, targetSlotStart + SLOT_MINUTES) - 2);
        await page.mouse.click(x, y);

        expect(await selectedSlot(page)).toBe(slotLabel(targetSlotStart)); // "12:00", NOT "13:00"
    });

    test("click selection agrees with hover across the whole slot span", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page);
        const geom = await chartGeom(page);

        // Sweep several points across one slot; every one must resolve to it.
        for (const frac of [0.1, 0.35, 0.6, 0.85, 0.95]) {
            const vx = xForMinutes(geom, targetSlotStart + SLOT_MINUTES * frac);
            const { x, y } = pagePoint(geom, vx);

            // Hover first (the reference the user says already works)...
            await page.mouse.move(x, y);
            const hoveredSlotStart = await page.evaluate((slot) => {
                const el = document.querySelector("helman-solar-inspector") as any;
                const min = el._hoveredMinutes as number | null;
                return min === null ? null : Math.floor(min / slot) * slot;
            }, SLOT_MINUTES);
            expect(hoveredSlotStart).toBe(targetSlotStart);

            // ...then click and require the selection to match the hover.
            await page.mouse.click(x, y);
            expect(await selectedSlot(page)).toBe(slotLabel(targetSlotStart));
        }
    });
});
