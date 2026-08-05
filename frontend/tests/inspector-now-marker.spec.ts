import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The vertical "now" line across the solar inspector's charts.
 *
 * The schedule band at the bottom of the card has always drawn one; the charts
 * above it -- power, SoC, price -- are hand-drawn SVG and had none, so the eye
 * had to carry the moment up the page. These pin the two things that make the
 * mark trustworthy: it lands on the right minute of the axis, and it only
 * appears on the day that is actually running.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

async function loadCardBundle(page: Page): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-inspector"));
}

/** Today in UTC, which is the timezone the fixture pins the card to. */
function todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
}

/**
 * Mount the inspector on `date` with a full day of solar and battery SoC, at the
 * hour-wide grid with daylight cropping off -- so the axis spans 0..1440 and a
 * marker's x can be checked against the layout exactly.
 */
async function mountInspector(page: Page, date: string): Promise<void> {
    await page.evaluate((day: string) => {
        const corrected: Array<{ timestamp: string; valueWh: number }> = [];
        const socForecast: Array<{ slot: string; pct: number }> = [];
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
            const v = Math.max(0, 400 - Math.abs(m - 720) / 2);
            corrected.push({ timestamp: `${day}T${hh}:${mm}:00`, valueWh: v });
            socForecast.push({ slot: `${hh}:${mm}`, pct: 40 + (m / 1440) * 30 });
            impact.push({ slot: `${hh}:${mm}`, rawWh: v, correctedWh: v, impactWh: 0, factor: 1 });
        }
        const payload = {
            date: day,
            timezone: "UTC",
            status: "ok",
            effectiveVariant: null,
            trainedAt: null,
            range: {
                minDate: day,
                maxDate: day,
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
                batterySocForecast: socForecast,
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
                hasBatterySocForecast: true,
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
        el.daylightOnlyDefault = false;
        el.slotMinutesDefault = 60;
        el.hass = {
            language: "en",
            config: { time_zone: "UTC" },
            connection: {},
            // Echo the requested date back so the payload matches whatever day
            // the card is looking at.
            callWS: async (msg: { date?: string }) => ({ ...payload, date: msg.date ?? day }),
        };
        document.body.appendChild(el);
        // Drive the card onto the day under test; the pills would otherwise
        // leave it on today.
        el._selectedDate = day;
    }, date);

    await page.waitForFunction(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        return !!el?.shadowRoot?.querySelector(".chart-wrap svg");
    });
}

/**
 * Mount the schedule band the way `helman-solar-schedule-band-strip` mounts it
 * -- same wrapper, same track insets read off the chart's settled layout -- so
 * the marker the inspector's charts draw can be compared against the one the
 * band draws through the real composition path.
 */
async function mountBand(page: Page, date: string): Promise<void> {
    await page.evaluate((day: string) => {
        const dayStartMs = Date.parse(`${day}T00:00:00Z`);
        const hourMs = 3_600_000;
        const slots = Array.from({ length: 24 }, (_, index) => ({
            id: new Date(dayStartMs + index * hourMs).toISOString(),
            index,
            startMs: dayStartMs + index * hourMs,
            endMs: dayStartMs + (index + 1) * hourMs,
            dayKey: day, timeLabel: "", endLabel: "", rangeLabel: "",
            assignments: { inverter: { action: { kind: "empty" }, setBy: null }, appliances: {} },
            runtime: null, isCurrent: false,
        }));
        const wrap = document.createElement("div");
        // The strip sits inside the card, so it is exactly as wide as the chart
        // above it; anything else would compare two different time axes.
        const chartWrap = (document.querySelector("helman-solar-inspector") as any)
            .shadowRoot.querySelector(".chart-wrap") as HTMLElement;
        wrap.style.width = `${chartWrap.getBoundingClientRect().width}px`;
        const band = document.createElement("scheduling-entity-day-band") as any;
        band.localize = (key: string) => key;
        band.day = {
            dayKey: day, label: "today", slots,
            startMs: dayStartMs, endMs: dayStartMs + 24 * hourMs, editableFromMs: dayStartMs,
        };
        band.lanes = [{
            key: "appliance:boiler", entityId: "switch.boiler", name: "Boiler", icon: "mdi:water-boiler",
            target: { kind: "appliance", applianceId: "boiler" },
            appliance: { id: "boiler", kind: "generic", name: "Boiler", icon: "mdi:water-boiler" },
            isAvailable: true, actualSegments: [], blocks: [],
            blockProjections: new Map(), blockVehicleSoc: new Map(),
        }];
        band.readonly = true;
        band.laneLabels = "track";
        band.showForecastRows = false;
        band.showAxis = false;
        band.windowStartMs = dayStartMs;
        band.windowEndMs = dayStartMs + 24 * hourMs;
        wrap.appendChild(band);
        document.body.appendChild(wrap);

        const layout = (document.querySelector("helman-solar-inspector") as any)._lastLayoutForStrip;
        const startPct = (layout.margin.left / layout.width) * 100;
        const endPct = Math.max(0, 100 - startPct - (layout.plotWidth / layout.width) * 100);
        wrap.style.setProperty("--entity-day-band-track-inset-start", `${startPct}%`);
        wrap.style.setProperty("--entity-day-band-track-inset-end", `${endPct}%`);
        (window as any).__band = band;
    }, date);
    await page.waitForFunction(
        () => !!(window as any).__band?.shadowRoot?.querySelector(".now-marker"),
    );
}

/** viewBox x of every now-marker line drawn in the given container. */
async function markerXs(page: Page, selector: string): Promise<number[]> {
    return page.evaluate((sel: string) => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const root = el.shadowRoot.querySelector(sel) as Element | null;
        if (root === null) return [];
        return Array.from(root.querySelectorAll("line"))
            .filter((line) => line.getAttribute("stroke") === "var(--primary-color)")
            .map((line) => Number(line.getAttribute("x1")));
    }, selector);
}

/** Where the axis puts the current minute, straight off the chart's own layout. */
async function expectedNowX(page: Page): Promise<number> {
    return page.evaluate(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const now = new Date();
        const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
        return Math.round(el._lastLayoutForStrip.xForMinutes(minutes));
    });
}

/** On-page geometry of each marker, with both clocks pinned to one whole hour. */
async function markerRects(page: Page, hour: number) {
    return page.evaluate(async (h: number) => {
        const inspector = document.querySelector("helman-solar-inspector") as any;
        const band = (window as any).__band;
        const fixed = Date.parse(
            `${new Date().toISOString().slice(0, 10)}T${String(h).padStart(2, "0")}:00:00Z`,
        );
        inspector._nowMs = fixed;
        band.nowMs = fixed;
        await inspector.updateComplete;
        await band.updateComplete;

        const line = (sel: string) => {
            const found = Array.from(
                (inspector.shadowRoot as ShadowRoot).querySelectorAll(`${sel} line`),
            ).find((l) => l.getAttribute("stroke") === "var(--primary-color)");
            const rect = (found as SVGLineElement).getBoundingClientRect();
            return { center: rect.left + rect.width / 2 };
        };
        const marker = band.shadowRoot.querySelector(".now-marker") as HTMLElement;
        const mr = marker.getBoundingClientRect();
        return {
            chart: line(".chart-wrap"),
            soc: line(".soc-strip-wrap"),
            band: { center: mr.left + mr.width / 2, width: mr.width },
        };
    }, hour);
}

test.describe("solar inspector now marker", () => {
    test("today's chart and SoC strip both mark the current minute", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, todayUtc());

        const expected = await expectedNowX(page);
        const chart = await markerXs(page, ".chart-wrap");
        const soc = await markerXs(page, ".soc-strip-wrap");

        expect(chart).toHaveLength(1);
        expect(chart[0]).toBeCloseTo(expected, 1);
        // The strip borrows the chart's x scale, so the two lines are one stroke.
        expect(soc).toHaveLength(1);
        expect(soc[0]).toBeCloseTo(expected, 1);
    });

    test("the charts and the schedule band mark the same pixel, all day", async ({ page }) => {
        await page.setViewportSize({ width: 1000, height: 900 });
        await loadCardBundle(page);
        await mountInspector(page, todayUtc());
        await mountBand(page, todayUtc());

        // Morning through late evening: a scale mismatch between the two
        // surfaces shows up as a drift that grows across the day, which one
        // sample in the middle would miss.
        for (const hour of [3, 9, 15, 23]) {
            const { chart, soc, band } = await markerRects(page, hour);
            expect(chart.center).toBeCloseTo(soc.center, 1);
            // Within a pixel: the chart snaps its line to a whole pixel so the
            // stroke stays crisp, which is as close as it can sit to the band's
            // own fractional placement.
            expect(Math.abs(chart.center - band.center)).toBeLessThanOrEqual(0.75);
            // And it is the band's own weight, not a scaled-up version of it.
            expect(band.width).toBe(2);
        }
    });

    test("the marker keeps the band's weight and stays behind the figures", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, todayUtc());

        const drawn = await page.evaluate(() => {
            const el = document.querySelector("helman-solar-inspector") as any;
            const root = el.shadowRoot as ShadowRoot;
            const line = Array.from(root.querySelectorAll(".chart-wrap line"))
                .find((l) => l.getAttribute("stroke") === "var(--primary-color)")!;
            // In the SoC strip, paint order is DOM order: every percentage has
            // to come after the marker for the line to pass behind the digits.
            const soc = root.querySelector(".soc-strip-wrap svg") as SVGSVGElement;
            const painted = Array.from(soc.querySelectorAll("line, text"));
            const markerIndex = painted.findIndex(
                (node) => node.getAttribute("stroke") === "var(--primary-color)",
            );
            // The column percentages only -- the strip's axis labels sit outside
            // the plot, where the marker never reaches them.
            const labels = painted
                .map((node, index) => ({ index, node }))
                .filter((entry) => entry.node.tagName === "text"
                    && entry.node.closest("g[clip-path]") !== null)
                .map((entry) => entry.index);
            return {
                strokeWidth: line.getAttribute("stroke-width"),
                vectorEffect: line.getAttribute("vector-effect"),
                x: line.getAttribute("x1"),
                markerIndex,
                labelsAfterMarker: labels.every((index) => index > markerIndex),
                labelCount: labels.length,
            };
        });

        // The band's 2px, in CSS pixels rather than viewBox units, so a chart
        // drawn wider than its viewBox never fattens the line.
        expect(drawn.strokeWidth).toBe("2");
        expect(drawn.vectorEffect).toBe("non-scaling-stroke");
        // Snapped to a whole pixel, so those two pixels stay two pixels.
        expect(Number(drawn.x)).toBe(Math.round(Number(drawn.x)));
        expect(drawn.labelCount).toBeGreaterThan(0);
        expect(drawn.labelsAfterMarker).toBe(true);
    });

    test("a past day gets no marker", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, "2020-05-17");

        expect(await markerXs(page, ".chart-wrap")).toHaveLength(0);
        expect(await markerXs(page, ".soc-strip-wrap")).toHaveLength(0);
    });
});
