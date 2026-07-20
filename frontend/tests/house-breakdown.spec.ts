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
        /** Net grid energy per 15-min slot: positive exports, negative imports. */
        gridWh?: number;
        /** Net battery energy per 15-min slot: positive charges, negative discharges. */
        batteryWh?: number;
    },
): Promise<void> {
    await page.evaluate((opts) => {
        const date = "2026-07-18";
        const corrected: Array<{ timestamp: string; valueWh: number }> = [];
        const houseActual: Array<{ timestamp: string; valueWh: number }> = [];
        const gridActual: Array<{ timestamp: string; valueWh: number }> = [];
        const batteryActual: Array<{ timestamp: string; valueWh: number }> = [];
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
            if (opts.gridWh !== undefined) {
                gridActual.push({ timestamp: `${date}T${hh}:${mm}:00`, valueWh: opts.gridWh });
            }
            if (opts.batteryWh !== undefined) {
                batteryActual.push({ timestamp: `${date}T${hh}:${mm}:00`, valueWh: opts.batteryWh });
            }
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
                gridActual,
                batteryForecast: [],
                batteryActual,
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

/**
 * Read the rendered composition boxes in order.
 *
 * The panel renders the power card's own `power-device` boxes, so everything is
 * reached through their shadow roots exactly as it is on the card itself.
 */
async function breakdownBoxes(
    page: Page,
): Promise<Array<{ label: string; power: string; share: string; hasSensor: boolean; switchEntityId: string | null }>> {
    return page.evaluate(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const container = el.shadowRoot
            .querySelector(".house-breakdown")
            ?.querySelector("power-devices-container");
        const devices = container?.shadowRoot?.querySelectorAll("power-device") ?? [];
        return [...devices].map((device: any) => {
            const content = device.shadowRoot.querySelector(".deviceContent");
            const display = content.querySelector("power-device-power-display");
            const badge = content
                .querySelector("power-device-icon")
                ?.shadowRoot?.querySelector("helman-appliance-switch-badge") as any;
            return {
                label: (content.querySelector(".deviceName")?.textContent ?? "").trim(),
                power: (display?.shadowRoot?.querySelector(".powerValue")?.textContent ?? "")
                    .replace(/\s+/g, " ")
                    .trim(),
                share: (display?.shadowRoot?.querySelector(".powerValue + div")?.textContent ?? "").trim(),
                hasSensor: !!display?.shadowRoot?.querySelector(".powerDisplay.has-sensor"),
                switchEntityId: badge ? badge.entityId : null,
            };
        });
    });
}

/** Click a composition box's power figure — the card's own more-info affordance. */
async function clickBoxPower(page: Page, index: number): Promise<void> {
    await page.evaluate((i) => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const container = el.shadowRoot
            .querySelector(".house-breakdown")
            .querySelector("power-devices-container");
        const device = container.shadowRoot.querySelectorAll("power-device")[i] as any;
        const display = device.shadowRoot
            .querySelector(".deviceContent")
            .querySelector("power-device-power-display");
        (display.shadowRoot.querySelector(".powerDisplay") as HTMLElement).click();
    }, index);
}

// The bars are painted with nodeAccentColor — the palette value at the alpha the
// power card draws its own backgrounds at, not the full-strength hue.
const SOLAR_RGB = "rgba(250, 204, 21, 0.376)"; // nodeAccentColor("solar")
const GRID_RGB = "rgba(56, 189, 248, 0.376)"; // nodeAccentColor("grid")
const BATTERY_RGB = "rgba(34, 197, 94, 0.376)"; // nodeAccentColor("battery")

/** The distinct segment colours painted across the first composition box's bars. */
async function barSegmentColours(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const container = el.shadowRoot
            .querySelector(".house-breakdown")
            .querySelector("power-devices-container");
        const device = container.shadowRoot.querySelector("power-device") as any;
        const bars = device.shadowRoot
            .querySelector(".deviceContent")
            .querySelector("helman-power-history-bars");
        const segments = bars?.shadowRoot?.querySelectorAll(".historyBarSegment") ?? [];
        const seen: string[] = [];
        for (const s of segments) {
            const colour = getComputedStyle(s as HTMLElement).backgroundColor;
            if (!seen.includes(colour)) seen.push(colour);
        }
        return seen;
    });
}

const APPLIANCES: Appliance[] = [
    { entityId: "sensor.dishwasher", label: "Dishwasher", wh: 50 },
    { entityId: "sensor.ev", label: "EV charger", wh: 30 },
];

test.describe("solar inspector house composition", () => {
    test("selecting a slot shows one box per consumer plus the unmeasured remainder", async ({ page }) => {
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
        const rows = await breakdownBoxes(page);

        // The hour bucket sums four 15-minute sub-slots: unmeasured 400,
        // dishwasher 200, ev 120 — total 720. Ranked heaviest first, so the
        // remainder leads here rather than being pinned last.
        expect(rows.map((r) => r.label)).toEqual([
            "Unmeasured consumption",
            "Dishwasher",
            "EV charger",
        ]);
        // The remainder leads and carries no energy sensor of its own.
        expect(rows[0].hasSensor).toBe(false);

        // The boxes report the selection's energy, with each one's share of the
        // house beside it.
        expect(rows.map((r) => r.power)).toEqual(["400 Wh", "200 Wh", "120 Wh"]);
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
        const rows = await breakdownBoxes(page);

        // The card's own title wins over this card's localized fallback.
        expect(rows[0].label).toBe("👻 Nesledovaná spotřeba");
        expect(rows[0].hasSensor).toBe(false);
    });

    test("hides the unmeasured box when the slot's whole demand is metered", async ({ page }) => {
        await loadCardBundle(page);
        // The remainder is zero: every watt is metered, so no dead 0% row.
        await mountInspector(page, {
            withBreakdown: true,
            appliances: APPLIANCES,
            unmeasuredWh: 0,
        });

        await selectNoonSlot(page);
        const rows = await breakdownBoxes(page);

        expect(rows.map((r) => r.label)).toEqual(["Dishwasher", "EV charger"]);
        expect(rows.every((r) => r.hasSensor)).toBe(true);
        // Shares are still taken against the house total, not renormalised.
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
        const rows = await breakdownBoxes(page);

        // The idle EV is dropped; the rest stay ranked heaviest first.
        expect(rows.map((r) => r.label)).toEqual(["Unmeasured consumption", "Dishwasher"]);
    });

    test("clicking a consumer box opens its energy sensor", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, {
            withBreakdown: true,
            appliances: APPLIANCES,
            unmeasuredWh: 100,
        });
        await selectNoonSlot(page);

        // Boxes are ranked heaviest first: unmeasured, dishwasher, ev.
        await clickBoxPower(page, 1);

        expect(await page.evaluate(() => (window as any).__moreInfo)).toEqual([
            "sensor.dishwasher",
        ]);
    });

    test("the unmeasured box is inert — it has no entity behind it", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, {
            withBreakdown: true,
            appliances: APPLIANCES,
            unmeasuredWh: 100,
        });
        await selectNoonSlot(page);

        // The remainder sorts first here; clicking its figure must do nothing.
        await clickBoxPower(page, 0);

        expect((await breakdownBoxes(page))[0].hasSensor).toBe(false);
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

        const badges = (await breakdownBoxes(page)).map((row) => row.switchEntityId);

        // Ranked unmeasured (400), dishwasher (200), ev (120); only the dishwasher
        // has a switch, and the remainder never does.
        expect(badges).toEqual([null, "switch.dishwasher", null]);
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
            const devices = el.shadowRoot
                .querySelector(".house-breakdown")
                .querySelector("power-devices-container")
                .shadowRoot.querySelectorAll("power-device");
            // The remainder outranks the dishwasher here, so find the box that
            // actually carries a badge rather than assuming a position.
            const badge = [...devices]
                .map((device: any) =>
                    device.shadowRoot
                        .querySelector("power-device-icon")
                        ?.shadowRoot?.querySelector("helman-appliance-switch-badge"),
                )
                .find(Boolean) as any;
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

    /**
     * Each row carries the power card's bar picture: one bar per slot of the
     * selection, split by the source that fed the house then. Nothing records a
     * per-appliance source split, so the mix is derived from the day's own grid
     * and battery meters and solar takes the remainder — which makes the sign
     * conventions (grid positive = export, battery positive = charge) the part
     * worth pinning.
     */
    test("bars are coloured by the source that fed the house in the slot", async ({ page }) => {
        await loadCardBundle(page);
        // 80 Wh a slot, all of it imported from the grid: grid is negative.
        await mountInspector(page, {
            withBreakdown: true,
            appliances: APPLIANCES,
            unmeasuredWh: 0,
            gridWh: -80,
        });

        await selectNoonSlot(page);

        expect(await barSegmentColours(page)).toEqual([GRID_RGB]);
    });

    test("battery discharge colours the bars", async ({ page }) => {
        await loadCardBundle(page);
        // 80 Wh a slot, half from the battery discharging, the rest unaccounted
        // for by either meter — so it must read as solar.
        await mountInspector(page, {
            withBreakdown: true,
            appliances: APPLIANCES,
            unmeasuredWh: 0,
            batteryWh: -40,
        });

        await selectNoonSlot(page);

        // Solar first, then battery — the order houseSourceMixBySlot builds them in.
        expect(await barSegmentColours(page)).toEqual([SOLAR_RGB, BATTERY_RGB]);
    });

    test("a charging battery is not a source — it consumes, it does not feed", async ({ page }) => {
        await loadCardBundle(page);
        // Positive battery energy is charging. It takes energy off the bus rather
        // than putting any on it, so the house's 80 Wh is left entirely to solar;
        // a flipped sign here would paint the bars battery-green instead.
        await mountInspector(page, {
            withBreakdown: true,
            appliances: APPLIANCES,
            unmeasuredWh: 0,
            batteryWh: 40,
        });

        await selectNoonSlot(page);

        expect(await barSegmentColours(page)).toEqual([SOLAR_RGB]);
    });

    test("solar takes the remainder rather than the raw production series", async ({ page }) => {
        await loadCardBundle(page);
        // Everything the house drew came off the meters, so nothing is left for
        // solar even though the fixture's production series is non-zero: energy
        // that went to export or into the battery never reached the house.
        await mountInspector(page, {
            withBreakdown: true,
            appliances: APPLIANCES,
            unmeasuredWh: 0,
            gridWh: -40,
            batteryWh: -40,
        });

        await selectNoonSlot(page);

        expect(await barSegmentColours(page)).toEqual([BATTERY_RGB, GRID_RGB]);
    });


});
