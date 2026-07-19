import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Coverage for the solar-inspector's house-composition panel.
 *
 * When a slot is selected the inspector splits that slot's measured house demand
 * into each individually metered consumer plus whatever no meter accounted for —
 * the `houseActualBreakdown` series the backend serves. This pins that the panel
 * appears on selection, ranks every row heaviest first, drops rows that drew
 * nothing, reuses the power card's configured title for the remainder, and stays
 * hidden when the backend supplied no breakdown.
 *
 * Note the unmeasured remainder is NOT the forecast's non-deferrable base load;
 * it is the analogue of the power card's "unmeasured" node.
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

type Appliance = {
    entityId: string;
    label: string;
    wh: number;
    switchEntityId?: string | null;
};

/**
 * Mount the inspector on a full-day, hour-wide fixture. When `withBreakdown` is
 * set every 15-minute slot carries the same consumer + remainder split, so the hour
 * bucket the card aggregates to has four times each value.
 */
async function mountInspector(
    page: Page,
    options: {
        withBreakdown: boolean;
        appliances: Appliance[];
        unmeasuredWh: number;
        /** The power card's configured title; null falls back to the translation. */
        unmeasuredLabel?: string | null;
    },
): Promise<void> {
    await page.evaluate((opts) => {
        const date = "2026-07-18";
        const corrected: Array<{ timestamp: string; valueWh: number }> = [];
        const houseActual: Array<{ timestamp: string; valueWh: number }> = [];
        const houseActualBreakdown: Array<{
            slot: string;
            unmeasuredWh: number;
            appliances: Array<{
                entityId: string;
                label: string;
                wh: number;
                switchEntityId: string | null;
            }>;
        }> = [];
        const impact: Array<{
            slot: string;
            rawWh: number | null;
            correctedWh: number | null;
            impactWh: number | null;
            factor: number | null;
        }> = [];
        const slotTotal =
            opts.unmeasuredWh + opts.appliances.reduce((sum, a) => sum + a.wh, 0);
        for (let m = 0; m < 1440; m += 15) {
            const hh = String(Math.floor(m / 60)).padStart(2, "0");
            const mm = String(m % 60).padStart(2, "0");
            const v = Math.max(0, 400 - Math.abs(m - 720) / 2);
            corrected.push({ timestamp: `${date}T${hh}:${mm}:00`, valueWh: v });
            houseActual.push({ timestamp: `${date}T${hh}:${mm}:00`, valueWh: slotTotal });
            if (opts.withBreakdown) {
                houseActualBreakdown.push({
                    slot: `${hh}:${mm}`,
                    unmeasuredWh: opts.unmeasuredWh,
                    appliances: opts.appliances.map((a) => ({
                        ...a,
                        switchEntityId: a.switchEntityId ?? null,
                    })),
                });
            }
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
                houseActual,
                houseActualBreakdown,
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
                hasHouseActual: true,
                hasHouseActualBreakdown: opts.withBreakdown,
                hasBatterySocForecast: false,
                hasBatterySocActual: false,
                hasGridForecast: false,
                hasGridActual: false,
                hasBatteryForecast: false,
                hasBatteryActual: false,
            },
            houseUnmeasuredLabel: opts.unmeasuredLabel ?? null,
            batterySocBounds: [],
            trainingExplainability: null,
        };

        // A state per configured switch so the shared badge has something to show.
        const states: Record<string, unknown> = {};
        for (const appliance of opts.appliances) {
            if (!appliance.switchEntityId) continue;
            states[appliance.switchEntityId] = {
                entity_id: appliance.switchEntityId,
                state: "on",
                attributes: { friendly_name: appliance.label },
            };
        }

        // Capture more-info requests so tests can assert what a click asked for.
        (window as any).__moreInfo = [];
        window.addEventListener("hass-more-info", (event: Event) => {
            (window as any).__moreInfo.push((event as CustomEvent).detail?.entityId);
        });

        const el = document.createElement("helman-solar-inspector") as any;
        el.daylightOnlyDefault = false;
        el.slotMinutesDefault = 60;
        el.hass = {
            language: "en",
            config: { time_zone: "UTC" },
            connection: {},
            states,
            callWS: async (msg: { date: string }) => ({ ...payload, date: msg.date }),
        };
        document.body.appendChild(el);
    }, options);

    await page.waitForFunction(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        return !!el?.shadowRoot?.querySelector(".chart-wrap svg");
    });
}

type ChartGeom = {
    rect: { left: number; top: number; width: number; height: number };
    viewWidth: number;
    marginLeft: number;
    plotWidth: number;
    dayStartMinutes: number;
    dayEndMinutes: number;
};

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

function xForMinutes(geom: ChartGeom, minutes: number): number {
    const span = geom.dayEndMinutes - geom.dayStartMinutes;
    return geom.marginLeft + ((minutes - geom.dayStartMinutes) / span) * geom.plotWidth;
}

function pagePoint(geom: ChartGeom, viewBoxX: number): { x: number; y: number } {
    return {
        x: geom.rect.left + (viewBoxX / geom.viewWidth) * geom.rect.width,
        y: geom.rect.top + geom.rect.height / 2,
    };
}

/** Click the middle of the 12:00 hour slot to select it. */
async function selectNoonSlot(page: Page): Promise<void> {
    const geom = await chartGeom(page);
    const { x, y } = pagePoint(geom, xForMinutes(geom, 720 + 30));
    await page.mouse.click(x, y);
    await page.waitForFunction(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        return el._selectedSlot === "12:00";
    });
}

/** Read the rendered breakdown rows in order. */
async function breakdownRows(
    page: Page,
): Promise<Array<{ label: string; value: string; share: string; isUnmeasured: boolean }>> {
    return page.evaluate(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const rows = el.shadowRoot.querySelectorAll(".house-breakdown-row");
        return [...rows].map((row) => ({
            label: (row.querySelector(".house-breakdown-label")?.textContent ?? "").trim(),
            value: (row.querySelector(".house-breakdown-value")?.textContent ?? "").trim(),
            share: (row.querySelector(".house-breakdown-share")?.textContent ?? "").trim(),
            isUnmeasured: row.classList.contains("unmeasured"),
        }));
    });
}

const APPLIANCES: Appliance[] = [
    { entityId: "sensor.dishwasher", label: "Dishwasher", wh: 50 },
    { entityId: "sensor.ev", label: "EV charger", wh: 30 },
];

test.describe("solar inspector house composition", () => {
    test("selecting a slot shows one row per consumer plus the unmeasured remainder", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, { withBreakdown: true, appliances: APPLIANCES, unmeasuredWh: 100 });

        // No panel until a slot is selected.
        expect(
            await page.evaluate(() => {
                const el = document.querySelector("helman-solar-inspector") as any;
                return !!el.shadowRoot.querySelector(".house-breakdown");
            }),
        ).toBe(false);

        await selectNoonSlot(page);
        const rows = await breakdownRows(page);

        // The hour bucket sums four 15-minute sub-slots: unmeasured 400,
        // dishwasher 200, ev 120 — total 720. Ranked heaviest first, so the
        // remainder leads here rather than being pinned last.
        expect(rows.map((r) => r.label)).toEqual([
            "Unmeasured consumption",
            "Dishwasher",
            "EV charger",
        ]);
        expect(rows[0].isUnmeasured).toBe(true);

        expect(rows.map((r) => r.value)).toEqual(["0.4 kWh", "0.2 kWh", "0.1 kWh"]);
        expect(rows.map((r) => r.share)).toEqual(["56%", "28%", "17%"]);
    });

    test("uses the power card's configured unmeasured title when set", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, {
            withBreakdown: true,
            appliances: APPLIANCES,
            unmeasuredWh: 100,
            unmeasuredLabel: "👻 Nesledovaná spotřeba",
        });

        await selectNoonSlot(page);
        const rows = await breakdownRows(page);

        // The card's own title wins over this card's localized fallback.
        expect(rows[0].label).toBe("👻 Nesledovaná spotřeba");
        expect(rows[0].isUnmeasured).toBe(true);
    });

    test("hides the unmeasured row when the slot's whole demand is metered", async ({ page }) => {
        await loadCardBundle(page);
        // The remainder is zero: every watt is metered, so no dead 0% row.
        await mountInspector(page, {
            withBreakdown: true,
            appliances: APPLIANCES,
            unmeasuredWh: 0,
        });

        await selectNoonSlot(page);
        const rows = await breakdownRows(page);

        expect(rows.map((r) => r.label)).toEqual(["Dishwasher", "EV charger"]);
        expect(rows.some((r) => r.isUnmeasured)).toBe(false);
        // Shares are still taken against the slot total, not renormalised.
        expect(rows.map((r) => r.share)).toEqual(["63%", "38%"]);
    });

    test("hides appliances that drew nothing in the slot", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, {
            withBreakdown: true,
            appliances: [
                { entityId: "sensor.dishwasher", label: "Dishwasher", wh: 50 },
                { entityId: "sensor.ev", label: "EV charger", wh: 0 },
            ],
            unmeasuredWh: 100,
        });

        await selectNoonSlot(page);
        const rows = await breakdownRows(page);

        // The idle EV is dropped; the rest stay ranked heaviest first.
        expect(rows.map((r) => r.label)).toEqual(["Unmeasured consumption", "Dishwasher"]);
    });

    test("clicking a consumer row opens its energy sensor", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, {
            withBreakdown: true,
            appliances: APPLIANCES,
            unmeasuredWh: 100,
        });
        await selectNoonSlot(page);

        // Rows are ranked heaviest first: unmeasured, dishwasher, ev.
        await page.evaluate(() => {
            const el = document.querySelector("helman-solar-inspector") as any;
            const rows = el.shadowRoot.querySelectorAll(".house-breakdown-row");
            (rows[1] as HTMLElement).click();
        });

        expect(await page.evaluate(() => (window as any).__moreInfo)).toEqual([
            "sensor.dishwasher",
        ]);
    });

    test("the unmeasured row is inert — it has no entity behind it", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, {
            withBreakdown: true,
            appliances: APPLIANCES,
            unmeasuredWh: 100,
        });
        await selectNoonSlot(page);

        const unmeasuredIsClickable = await page.evaluate(() => {
            const el = document.querySelector("helman-solar-inspector") as any;
            const row = el.shadowRoot.querySelector(".house-breakdown-row.unmeasured");
            (row as HTMLElement).click();
            return row.classList.contains("clickable");
        });

        expect(unmeasuredIsClickable).toBe(false);
        expect(await page.evaluate(() => (window as any).__moreInfo)).toEqual([]);
    });

    test("a consumer with a switch gets the card's control badge", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, {
            withBreakdown: true,
            appliances: [
                {
                    entityId: "sensor.dishwasher",
                    label: "Dishwasher",
                    wh: 50,
                    switchEntityId: "switch.dishwasher",
                },
                { entityId: "sensor.ev", label: "EV charger", wh: 30 },
            ],
            unmeasuredWh: 100,
        });
        await selectNoonSlot(page);

        const badges = await page.evaluate(() => {
            const el = document.querySelector("helman-solar-inspector") as any;
            const rows = [...el.shadowRoot.querySelectorAll(".house-breakdown-row")];
            return rows.map((row) => {
                const badge = row.querySelector("helman-appliance-switch-badge") as any;
                return badge ? badge.entityId : null;
            });
        });

        // Ranked unmeasured (400), dishwasher (200), ev (120); only the dishwasher
        // has a switch, and the remainder never does.
        expect(badges).toEqual([null, "switch.dishwasher", null]);
    });

    test("the control cell is not a dead zone when the consumer has no switch", async ({ page }) => {
        // Regression: the cell used to swallow clicks unconditionally, so the
        // leftmost strip of every switch-less row did nothing at all.
        await loadCardBundle(page);
        await mountInspector(page, {
            withBreakdown: true,
            appliances: [{ entityId: "sensor.dishwasher", label: "Dishwasher", wh: 50 }],
            unmeasuredWh: 0,
        });
        await selectNoonSlot(page);

        await page.evaluate(() => {
            const el = document.querySelector("helman-solar-inspector") as any;
            const cell = el.shadowRoot.querySelector(".house-breakdown-control");
            (cell as HTMLElement).click();
        });

        expect(await page.evaluate(() => (window as any).__moreInfo)).toEqual([
            "sensor.dishwasher",
        ]);
    });

    test("clicking the control badge opens the switch, not the energy sensor", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, {
            withBreakdown: true,
            appliances: [
                {
                    entityId: "sensor.dishwasher",
                    label: "Dishwasher",
                    wh: 50,
                    switchEntityId: "switch.dishwasher",
                },
            ],
            unmeasuredWh: 100,
        });
        await selectNoonSlot(page);

        await page.evaluate(() => {
            const el = document.querySelector("helman-solar-inspector") as any;
            const badge = el.shadowRoot.querySelector("helman-appliance-switch-badge") as any;
            // Drive the badge's own event: <state-badge> is an HA element that is
            // not registered in this bare page, so it cannot be clicked directly.
            badge.dispatchEvent(
                new CustomEvent("show-more-info", {
                    bubbles: true,
                    composed: true,
                    detail: { entityId: "switch.dishwasher" },
                }),
            );
        });

        // The switch opened, and the row's own energy sensor did not.
        expect(await page.evaluate(() => (window as any).__moreInfo)).toEqual([
            "switch.dishwasher",
        ]);
    });

    test("no composition panel when the backend supplied no breakdown", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, { withBreakdown: false, appliances: [], unmeasuredWh: 180 });

        await selectNoonSlot(page);

        expect(
            await page.evaluate(() => {
                const el = document.querySelector("helman-solar-inspector") as any;
                return !!el.shadowRoot.querySelector(".house-breakdown");
            }),
        ).toBe(false);
    });
});
