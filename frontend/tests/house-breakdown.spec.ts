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
    /** null for a scheduled appliance with no meter configured. */
    entityId: string | null;
    label: string;
    wh: number;
    switchEntityId?: string | null;
    powerEntityId?: string | null;
    /** A shiftable appliance — a configured deferrable controllable. */
    deferrable?: boolean;
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
        /** Daily solar-production total, in Wh. */
        actualTotalWh?: number;
        /**
         * The forecast half: a base load per 15-min slot plus the appliances the
         * planner scheduled into it, mirroring `houseForecastBreakdown`. Left out
         * entirely the forecast series stays empty, as it is on a past day whose
         * composition nothing recorded.
         */
        forecast?: {
            baseWh: number;
            appliances: Appliance[];
            /**
             * Minute of the day the *composition* starts at, the live pipeline
             * covering only slots ahead of now. The forecast series itself still
             * spans the whole day, read back from the recorder — so before this
             * point there is a house forecast with nothing to itemise it by.
             */
            breakdownFromMinutes?: number;
        };
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
                entityId: string | null;
                label: string;
                wh: number;
                switchEntityId: string | null;
                powerEntityId: string | null;
                deferrable: boolean;
            }>;
        }> = [];
        const houseForecast: Array<{ timestamp: string; valueWh: number }> = [];
        const houseForecastBreakdown: typeof houseActualBreakdown = [];
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
                        powerEntityId: a.powerEntityId ?? null,
                        deferrable: a.deferrable ?? false,
                    })),
                });
            }
            if (opts.forecast) {
                const fc = opts.forecast;
                houseForecast.push({
                    timestamp: `${date}T${hh}:${mm}:00`,
                    valueWh: fc.baseWh + fc.appliances.reduce((sum, a) => sum + a.wh, 0),
                });
                if (m >= (fc.breakdownFromMinutes ?? 0)) {
                    houseForecastBreakdown.push({
                        slot: `${hh}:${mm}`,
                        // The forecast's remainder is the base load, not an unmetered
                        // rest — the same field, a different quantity.
                        unmeasuredWh: fc.baseWh,
                        appliances: fc.appliances.map((a) => ({
                            ...a,
                            entityId: a.entityId ?? null,
                            switchEntityId: a.switchEntityId ?? null,
                            powerEntityId: a.powerEntityId ?? null,
                            // Everything the planner schedules is shiftable by definition.
                            deferrable: a.deferrable ?? true,
                        })),
                    });
                }
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
                houseForecast,
                houseActual,
                houseActualBreakdown,
                houseForecastBreakdown,
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
                actualWh: opts.actualTotalWh ?? null,
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
                hasHouseForecast: !!opts.forecast,
                hasHouseActual: true,
                hasHouseActualBreakdown: opts.withBreakdown,
                hasHouseForecastBreakdown: !!opts.forecast,
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
    await selectSlotAtMinutes(page, 720, "12:00");
}

/** Click the middle of the hour slot starting at `minutes`. */
async function selectSlotAtMinutes(
    page: Page,
    minutes: number,
    expected: string,
): Promise<void> {
    const geom = await chartGeom(page);
    const { x, y } = pagePoint(geom, xForMinutes(geom, minutes + 30));
    await page.mouse.click(x, y);
    await page.waitForFunction(
        (slot) => {
            const el = document.querySelector("helman-solar-inspector") as any;
            return el._selectedSlot === slot;
        },
        expected,
    );
}

/**
 * Read the rendered composition boxes in order.
 *
 * The panel renders the power card's own `power-device` boxes, so everything is
 * reached through their shadow roots exactly as it is on the card itself.
 */
async function breakdownBoxes(
    page: Page,
    /** Which composition panel: 0 is the actual one, 1 the forecast beside it. */
    panel = 0,
): Promise<Array<{ label: string; power: string; share: string; hasSensor: boolean; switchEntityId: string | null; tag: string; tint: string }>> {
    // The consumers live one level down, inside the two groups the panel files
    // them under, and a collapsed group renders no children at all.
    await expandBreakdownGroups(page, panel);
    return page.evaluate((index) => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const container = el.shadowRoot
            .querySelectorAll(".house-breakdown")
            [index]?.querySelector("power-devices-container");
        const groups = [...(container?.shadowRoot?.querySelectorAll("power-device") ?? [])];
        const devices = groups.flatMap((group: any) => [
            ...(group.shadowRoot
                ?.querySelector("power-devices-container")
                ?.shadowRoot?.querySelectorAll("power-device") ?? []),
        ]);
        return [...devices].map((device: any) => {
            const content = device.shadowRoot.querySelector(".deviceContent");
            const display = content.querySelector("power-device-power-display");
            const badge = content
                .querySelector("power-device-icon")
                ?.shadowRoot?.querySelector("helman-appliance-switch-badge") as any;
            return {
                label: (content.querySelector(".deviceName")?.textContent ?? "").trim(),
                // The badge channel the card already uses for label texts, and the
                // per-box tint that overrides the panel's house colour.
                tag: (content
                    .querySelector("power-device-info")
                    ?.shadowRoot?.querySelector(".custom-labels")?.textContent ?? "").trim(),
                tint: content.style.getPropertyValue("--device-tint").trim(),
                power: (display?.shadowRoot?.querySelector(".powerValue")?.textContent ?? "")
                    .replace(/\s+/g, " ")
                    .trim(),
                share: (display?.shadowRoot?.querySelector(".powerValue + div")?.textContent ?? "").trim(),
                hasSensor: !!display?.shadowRoot?.querySelector(".powerDisplay.has-sensor"),
                switchEntityId: badge ? badge.entityId : null,
            };
        });
    }, panel);
}

/**
 * The panel's group rows: what it lists before anything is expanded.
 *
 * `collapsed` reads the card's own indicator rather than any internal state —
 * ► for shut, ▼ for open — since that is what the user is looking at.
 */
async function breakdownGroups(
    page: Page,
    panel = 0,
): Promise<Array<{ label: string; power: string; collapsed: boolean; tag: string }>> {
    return page.evaluate((index) => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const container = el.shadowRoot
            .querySelectorAll(".house-breakdown")
            [index]?.querySelector("power-devices-container");
        const groups = [...(container?.shadowRoot?.querySelectorAll("power-device") ?? [])];
        return groups.map((group: any) => {
            const content = group.shadowRoot.querySelector(".deviceContent");
            const name = (content.querySelector(".deviceName")?.textContent ?? "").trim();
            const display = content.querySelector("power-device-power-display");
            return {
                label: name.replace(/[►▼]\s*$/, "").trim(),
                tag: (content
                    .querySelector("power-device-info")
                    ?.shadowRoot?.querySelector(".custom-labels")?.textContent ?? "").trim(),
                power: (display?.shadowRoot?.querySelector(".powerValue")?.textContent ?? "")
                    .replace(/\s+/g, " ")
                    .trim(),
                collapsed: name.endsWith("►"),
            };
        });
    }, panel);
}

/** Open every group in a panel that is not open already. */
async function expandBreakdownGroups(page: Page, panel = 0): Promise<void> {
    const groups = await breakdownGroups(page, panel);
    for (const [index, group] of groups.entries()) {
        if (group.collapsed) await toggleBreakdownGroup(page, index, panel);
    }
}

/** Click a group's name, the affordance the power card gives its own groups. */
async function toggleBreakdownGroup(page: Page, index: number, panel = 0): Promise<void> {
    await page.evaluate(
        (o) => {
            const el = document.querySelector("helman-solar-inspector") as any;
            const container = el.shadowRoot
                .querySelectorAll(".house-breakdown")
                [o.panel]?.querySelector("power-devices-container");
            const group = container.shadowRoot.querySelectorAll("power-device")[o.index] as any;
            (group.shadowRoot.querySelector(".deviceName") as HTMLElement).click();
        },
        { index, panel },
    );
    await page.evaluate(async () => {
        const el = document.querySelector("helman-solar-inspector") as any;
        await el.updateComplete;
    });
}

/** Click a composition box's power figure — the card's own more-info affordance. */
async function clickBoxPower(page: Page, index: number): Promise<void> {
    await expandBreakdownGroups(page, 0);
    await page.evaluate((i) => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const container = el.shadowRoot
            .querySelector(".house-breakdown")
            .querySelector("power-devices-container");
        const groups = [...container.shadowRoot.querySelectorAll("power-device")];
        const device = groups.flatMap((group: any) => [
            ...(group.shadowRoot
                ?.querySelector("power-devices-container")
                ?.shadowRoot?.querySelectorAll("power-device") ?? []),
        ])[i] as any;
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
    await expandBreakdownGroups(page, 0);
    return page.evaluate(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const container = el.shadowRoot
            .querySelector(".house-breakdown")
            .querySelector("power-devices-container");
        const device = (container.shadowRoot.querySelector("power-device") as any).shadowRoot
            ?.querySelector("power-devices-container")
            ?.shadowRoot?.querySelector("power-device") as any;
        const bars = device.shadowRoot
            .querySelector(".deviceContent")
            .querySelector("helman-power-history-bars");
        // One path per distinct colour, one rectangle subpath per segment. Walk the
        // subpaths in document order — columns left to right, then bottom to top —
        // so the colours come out in the order they are first painted, as before.
        const segments: Array<{ x: number; y: number; colour: string }> = [];
        for (const path of bars?.shadowRoot?.querySelectorAll("path") ?? []) {
            const colour = getComputedStyle(path as SVGPathElement).fill;
            const d = path.getAttribute("d") ?? "";
            for (const m of d.matchAll(/M(-?[\d.]+) (-?[\d.]+)/g)) {
                segments.push({ x: parseFloat(m[1]), y: parseFloat(m[2]), colour });
            }
        }
        segments.sort((a, b) => a.x - b.x || b.y - a.y);
        const seen: string[] = [];
        for (const s of segments) {
            if (!seen.includes(s.colour)) seen.push(s.colour);
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

    test("clicking a consumer box opens its power sensor — the one the card reads", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, {
            withBreakdown: true,
            appliances: [
                {
                    entityId: "sensor.dishwasher",
                    label: "Dishwasher",
                    wh: 50,
                    powerEntityId: "sensor.dishwasher_power",
                },
                { entityId: "sensor.ev", label: "EV charger", wh: 30 },
            ],
            unmeasuredWh: 100,
        });
        await selectNoonSlot(page);

        // Boxes are ranked heaviest first: unmeasured, dishwasher, ev.
        await clickBoxPower(page, 1);

        expect(await page.evaluate(() => (window as any).__moreInfo)).toEqual([
            "sensor.dishwasher_power",
        ]);
    });

    test("clicking a consumer box falls back to its energy sensor when the tree knows no power sensor", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, {
            withBreakdown: true,
            appliances: APPLIANCES,
            unmeasuredWh: 100,
        });
        await selectNoonSlot(page);

        // The EV carries no power sensor, so its box opens the energy stat behind it.
        await clickBoxPower(page, 2);

        expect(await page.evaluate(() => (window as any).__moreInfo)).toEqual([
            "sensor.ev",
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

        await expandBreakdownGroups(page);
        await page.evaluate(() => {
            const el = document.querySelector("helman-solar-inspector") as any;
            const groups = [
                ...el.shadowRoot
                    .querySelector(".house-breakdown")
                    .querySelector("power-devices-container")
                    .shadowRoot.querySelectorAll("power-device"),
            ];
            const devices = groups.flatMap((group: any) => [
                ...(group.shadowRoot
                    ?.querySelector("power-devices-container")
                    ?.shadowRoot?.querySelectorAll("power-device") ?? []),
            ]);
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

    /**
     * Every energy figure on the card goes through the one `formatEnergy`, so a
     * quantity reads the same in the daily totals as it does on a composition
     * box. The unit switches at 1 kWh, which is what keeps small consumers
     * legible rather than rounding them all away to "0.0 kWh".
     */
    test("energy figures are formatted the same everywhere", async ({ page }) => {
        await loadCardBundle(page);
        const dailySolarTotal = () =>
            page.evaluate(() => {
                const el = document.querySelector("helman-solar-inspector") as any;
                const sections = el.shadowRoot.querySelectorAll(".metrics-section");
                const cards = [...sections[sections.length - 1].querySelectorAll(".metric-card")];
                const solar = cards.find((c) => /Solar production/.test(c.textContent ?? ""));
                return (solar?.querySelector(".metric-value")?.textContent ?? "").trim();
            });

        await mountInspector(page, {
            withBreakdown: true,
            appliances: APPLIANCES,
            unmeasuredWh: 100,
            actualTotalWh: 24500,
        });
        await selectNoonSlot(page);

        // Above the threshold a total reads in kWh...
        expect(await dailySolarTotal()).toBe("24.5 kWh");

        // ...and below it in Wh. This is the case that regressed: the card used to
        // force kWh on every figure, rendering this same total as "0.6 kWh".
        await page.evaluate(() => document.querySelector("helman-solar-inspector")!.remove());
        await mountInspector(page, {
            withBreakdown: true,
            appliances: APPLIANCES,
            unmeasuredWh: 100,
            actualTotalWh: 640,
        });
        await selectNoonSlot(page);

        expect(await dailySolarTotal()).toBe("640 Wh");
        // The composition boxes agree, being fed by the same formatter.
        expect((await breakdownBoxes(page)).map((r) => r.power)).toEqual([
            "400 Wh",
            "200 Wh",
            "120 Wh",
        ]);
    });
});

/**
 * Deferrable load as its own quantity.
 *
 * A consumer the payload marks `deferrable` is shiftable, so the card draws it
 * apart from the rest of the house: its own band stacked on top of the
 * non-deferrable one, its own hover row, and a tinted, tagged row in the
 * composition panel. Everything here is presentation over the same totals — the
 * two bands sum to the house figure that was drawn as one band before.
 */

const HOUSE_FILL = "#a855f7"; // HOUSE_COLOR
const DEFERRABLE_FILL = "#e2c6fc"; // DEFERRABLE_HOUSE_COLOR, blended from it
// nodeAccentColor's alpha, applied to the deferrable shade.
const DEFERRABLE_TINT = "#e2c6fc60";

const MIXED_APPLIANCES: Appliance[] = [
    { entityId: "sensor.dishwasher", label: "Dishwasher", wh: 50, deferrable: true },
    { entityId: "sensor.fridge", label: "Fridge", wh: 30 },
];

/** The vertical extent of every band painted in one colour, plus the zero baseline. */
async function bandExtent(
    page: Page,
    fill: string,
): Promise<{ top: number; bottom: number; baseline: number } | null> {
    return page.evaluate((wanted) => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const svg = el.shadowRoot.querySelector(".chart-wrap svg") as SVGSVGElement;
        const ys: number[] = [];
        for (const path of svg.querySelectorAll("path")) {
            if (path.getAttribute("fill") !== wanted) continue;
            for (const m of (path.getAttribute("d") ?? "").matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)) {
                ys.push(parseFloat(m[2]));
            }
        }
        if (!ys.length) return null;
        return {
            top: Math.min(...ys),
            bottom: Math.max(...ys),
            baseline: el._lastLayoutForStrip.yForW(0),
        };
    }, fill);
}

/**
 * The forecast band's outer edge, plus the zero baseline.
 *
 * Over measured hours the forecast stack recedes to dashed outlines, so a
 * forecast band is found by its stroke colour and dash rather than by a fill —
 * and it is the band's outer edge that is drawn, which is all the ordering of the
 * two bands needs.
 */
async function forecastBandOutline(
    page: Page,
    stroke: string,
): Promise<{ y: number; baseline: number } | null> {
    return page.evaluate((wanted) => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const svg = el.shadowRoot.querySelector(".chart-wrap svg") as SVGSVGElement;
        const ys: number[] = [];
        for (const path of svg.querySelectorAll("path")) {
            if (path.getAttribute("stroke") !== wanted) continue;
            if (path.getAttribute("stroke-dasharray") !== "4 3") continue;
            for (const m of (path.getAttribute("d") ?? "").matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)) {
                ys.push(parseFloat(m[2]));
            }
        }
        if (!ys.length) return null;
        return { y: Math.max(...ys), baseline: el._lastLayoutForStrip.yForW(0) };
    }, stroke);
}

/** The titles of the composition panels currently rendered, in document order. */
async function panelTitles(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        return [...el.shadowRoot.querySelectorAll(".house-breakdown-title")].map((node) =>
            (node.textContent ?? "").trim(),
        );
    });
}

/** The hovered slot's house rows, as label/actual/forecast triples in render order. */
async function houseTooltipRows(
    page: Page,
): Promise<Array<{ label: string; actual: string; forecast: string }>> {
    const geom = await chartGeom(page);
    const { x, y } = pagePoint(geom, xForMinutes(geom, 720 + 30));
    await page.mouse.move(x, y);
    await page.waitForFunction(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        return !!el.shadowRoot.querySelector(".hover-tooltip");
    });
    return page.evaluate(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        const table = el.shadowRoot.querySelector(".hover-tooltip-table") as HTMLElement;
        const rows: Array<{ label: string; actual: string; forecast: string }> = [];
        // label / actual / forecast per row, after the three header cells.
        const cells = [...table.children].slice(3);
        for (let i = 0; i < cells.length; i += 3) {
            rows.push({
                label: (cells[i].textContent ?? "").trim(),
                actual: (cells[i + 1].textContent ?? "").replace(/\s+/g, " ").trim(),
                forecast: (cells[i + 2].textContent ?? "").replace(/\s+/g, " ").trim(),
            });
        }
        return rows.filter((row) => row.label.startsWith("House"));
    });
}

test.describe("solar inspector deferrable house load", () => {
    test("the measured house draws two bands, non-deferrable against the baseline", async ({ page }) => {
        await loadCardBundle(page);
        // 180 Wh a slot: 50 shiftable, 130 not (30 metered fridge + 100 unmeasured).
        await mountInspector(page, {
            withBreakdown: true,
            appliances: MIXED_APPLIANCES,
            unmeasuredWh: 100,
        });

        const nonDeferrable = await bandExtent(page, HOUSE_FILL);
        const deferrable = await bandExtent(page, DEFERRABLE_FILL);
        expect(nonDeferrable).not.toBeNull();
        expect(deferrable).not.toBeNull();

        // Demand is drawn downwards, so the non-deferrable band starts at the zero
        // line and the shiftable part is stacked beyond it — they abut, and their
        // combined depth is the house total that used to be one band.
        expect(nonDeferrable!.top).toBeCloseTo(nonDeferrable!.baseline, 1);
        expect(deferrable!.top).toBeCloseTo(nonDeferrable!.bottom, 1);
        expect(deferrable!.bottom).toBeGreaterThan(deferrable!.top);
    });

    test("a slot with nothing shiftable draws the house as a single band", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, { withBreakdown: true, appliances: APPLIANCES, unmeasuredWh: 100 });

        expect(await bandExtent(page, DEFERRABLE_FILL)).toBeNull();
        const house = await bandExtent(page, HOUSE_FILL);
        expect(house!.top).toBeCloseTo(house!.baseline, 1);
    });

    test("the composition panel tints and tags the deferrable rows, and only those", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, {
            withBreakdown: true,
            appliances: MIXED_APPLIANCES,
            unmeasuredWh: 100,
        });
        await selectNoonSlot(page);

        const rows = await breakdownBoxes(page);
        // Base group first, heaviest first inside it (unmeasured 400, fridge 120),
        // then the deferrable group's dishwasher at 200 — ranking is per group now.
        expect(rows.map((r) => r.label)).toEqual(["Unmeasured consumption", "Fridge", "Dishwasher"]);
        expect(rows.map((r) => r.tag)).toEqual(["", "", "deferrable"]);
        // Only the shiftable box overrides the panel's house tint; the others
        // inherit it by setting none of their own.
        expect(rows.map((r) => r.tint)).toEqual(["", "", DEFERRABLE_TINT]);
    });

    test("the panel files consumers under a base and a deferrable group", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, {
            withBreakdown: true,
            appliances: MIXED_APPLIANCES,
            unmeasuredWh: 100,
        });
        await selectNoonSlot(page);

        // Two rows, each carrying its half of the slot: 400 unmeasured + 120
        // fridge against the dishwasher's 200. The remainder is not shiftable, so
        // it files under the base group like any other unshiftable load.
        // The group takes the shade but no badge: it is already named for the
        // thing the badge would say.
        expect(await breakdownGroups(page)).toEqual([
            { label: "Base consumption", power: "520 Wh", collapsed: true, tag: "" },
            { label: "Deferrable consumption", power: "200 Wh", collapsed: true, tag: "" },
        ]);
    });

    test("a slot with nothing shiftable keeps a single group", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, { withBreakdown: true, appliances: APPLIANCES, unmeasuredWh: 100 });
        await selectNoonSlot(page);

        expect((await breakdownGroups(page)).map((g) => g.label)).toEqual([
            "Base consumption",
        ]);
    });

    test("an opened group stays open when another slot is picked", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, {
            withBreakdown: true,
            appliances: MIXED_APPLIANCES,
            unmeasuredWh: 100,
        });
        await selectNoonSlot(page);
        await toggleBreakdownGroup(page, 1);

        expect((await breakdownGroups(page)).map((g) => g.collapsed)).toEqual([true, false]);

        // The panel is rebuilt for the new selection, but the state the user set
        // belongs to the group, not to the slot they set it in.
        await selectSlotAtMinutes(page, 780, "13:00");

        expect((await breakdownGroups(page)).map((g) => g.collapsed)).toEqual([true, false]);
    });

    test("the hover popup subdivides the house row when the slot had shiftable load", async ({
        page,
    }) => {
        await loadCardBundle(page);
        await mountInspector(page, {
            withBreakdown: true,
            appliances: MIXED_APPLIANCES,
            unmeasuredWh: 100,
        });

        // The hour bucket sums four 15-minute slots: 200 shiftable of 720 total.
        // Demand is negative in the chart's convention, as the single house row
        // always was. No whole-house row: the two parts are the house, and each
        // carries its own comparison. This day has no forecast at all, so both
        // forecast cells are blank rather than a fabricated zero.
        expect(await houseTooltipRows(page)).toEqual([
            { label: "House (non-deferrable)", actual: "-520 Wh", forecast: "—" },
            { label: "House (deferrable)", actual: "-200 Wh", forecast: "—" },
        ]);
    });

    test("the hover popup pairs each half with its own forecast", async ({ page }) => {
        await loadCardBundle(page);
        // 80 Wh of base plus a 40 Wh scheduled run per 15-min slot, against a
        // measured 130 + 50.
        await mountInspector(page, {
            withBreakdown: true,
            appliances: MIXED_APPLIANCES,
            unmeasuredWh: 100,
            forecast: {
                baseWh: 80,
                appliances: [{ entityId: "sensor.dishwasher", label: "Dishwasher", wh: 40 }],
            },
        });

        // Like against like: what was shifted against what was scheduled, and the
        // rest of the house against the rest of the forecast.
        expect(await houseTooltipRows(page)).toEqual([
            { label: "House (non-deferrable)", actual: "-520 Wh", forecast: "-320 Wh" },
            { label: "House (deferrable)", actual: "-200 Wh", forecast: "-160 Wh" },
        ]);
    });

    test("an uncomposed stretch of forecast reports no split at all", async ({ page }) => {
        await loadCardBundle(page);
        // The composition starts at 18:00, as it does on today: everything before
        // is the recorder's archive of the forecast sensor, a scalar whose parts
        // nothing kept.
        await mountInspector(page, {
            withBreakdown: true,
            appliances: MIXED_APPLIANCES,
            unmeasuredWh: 100,
            forecast: {
                baseWh: 80,
                appliances: [{ entityId: "sensor.dishwasher", label: "Dishwasher", wh: 40 }],
                breakdownFromMinutes: 1080,
            },
        });

        // The hovered hour is noon, well inside the uncomposed stretch. Quoting
        // its deferrable forecast as 0 Wh would understate it by exactly what it
        // overstates the row above by, so both cells stay empty — while the
        // actual half, which is composed throughout, still splits.
        expect(await houseTooltipRows(page)).toEqual([
            { label: "House (non-deferrable)", actual: "-520 Wh", forecast: "—" },
            { label: "House (deferrable)", actual: "-200 Wh", forecast: "—" },
        ]);
    });

    test("the hover popup keeps one house row when nothing was shiftable", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, { withBreakdown: true, appliances: APPLIANCES, unmeasuredWh: 100 });

        expect(await houseTooltipRows(page)).toEqual([
            { label: "House", actual: "-720 Wh", forecast: "—" },
        ]);
    });
});

/**
 * The forecast half of the same story.
 *
 * `houseForecastBreakdown` says what a future slot's demand is made of — the base
 * load the model predicts, plus each appliance the planner scheduled into it — in
 * the very shape the measured breakdown uses, so the band splits, the popup pairs
 * and the composition panel are all the same code serving both sides of now.
 */
test.describe("solar inspector forecast composition", () => {
    const FORECAST = {
        baseWh: 80,
        appliances: [{ entityId: "sensor.dishwasher", label: "Dishwasher", wh: 40 }],
    };

    test("the forecast stack draws two house bands, non-deferrable against the baseline", async ({
        page,
    }) => {
        await loadCardBundle(page);
        await mountInspector(page, {
            withBreakdown: true,
            appliances: MIXED_APPLIANCES,
            unmeasuredWh: 100,
            forecast: FORECAST,
        });

        // The forecast bands over measured hours are drawn as dashed outlines, so
        // they are found by their stroke rather than by a fill.
        const nonDeferrable = await forecastBandOutline(page, HOUSE_FILL);
        const deferrable = await forecastBandOutline(page, DEFERRABLE_FILL);
        expect(nonDeferrable).not.toBeNull();
        expect(deferrable).not.toBeNull();
        // Demand is drawn downwards: the non-deferrable outline sits between the
        // zero line and the deferrable one stacked beyond it.
        expect(nonDeferrable!.y).toBeGreaterThan(nonDeferrable!.baseline);
        expect(deferrable!.y).toBeGreaterThan(nonDeferrable!.y);
    });

    test("a forecast with nothing scheduled draws one house band", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, {
            withBreakdown: true,
            appliances: MIXED_APPLIANCES,
            unmeasuredWh: 100,
            forecast: { baseWh: 120, appliances: [] },
        });

        expect(await forecastBandOutline(page, DEFERRABLE_FILL)).toBeNull();
        expect(await forecastBandOutline(page, HOUSE_FILL)).not.toBeNull();
    });

    test("selecting a slot itemises the forecast beside the actual composition", async ({
        page,
    }) => {
        await loadCardBundle(page);
        await mountInspector(page, {
            withBreakdown: true,
            appliances: MIXED_APPLIANCES,
            unmeasuredWh: 100,
            forecast: FORECAST,
        });
        await selectNoonSlot(page);

        expect(await panelTitles(page)).toEqual([
            "House composition (actual)",
            "House composition (forecast)",
        ]);
        // The measured panel is unchanged; the forecast one names the base load
        // and each scheduled appliance, tagged and tinted like any shiftable row.
        expect((await breakdownBoxes(page, 0)).map((r) => r.label)).toEqual([
            "Unmeasured consumption",
            "Fridge",
            "Dishwasher",
        ]);
        const forecastRows = await breakdownBoxes(page, 1);
        expect(forecastRows.map((r) => [r.label, r.power, r.tag])).toEqual([
            ["Base load", "320 Wh", ""],
            ["Dishwasher", "160 Wh", "deferrable"],
        ]);
        expect(forecastRows.map((r) => r.tint)).toEqual(["", DEFERRABLE_TINT]);
    });

    test("a bucket the composition only partly covers still itemises", async ({ page }) => {
        await loadCardBundle(page);
        // The composition starts at 12:30, halfway through the selected hour —
        // the shape of the slot in progress, whose earlier samples predate the
        // live pipeline's horizon.
        await mountInspector(page, {
            withBreakdown: true,
            appliances: MIXED_APPLIANCES,
            unmeasuredWh: 100,
            forecast: {
                baseWh: 80,
                appliances: [{ entityId: "sensor.dishwasher", label: "Dishwasher", wh: 40 }],
                breakdownFromMinutes: 750,
            },
        });
        await selectNoonSlot(page);

        // The hour's forecast is 4 × 120 = 480 Wh, of which the composition
        // accounts for two samples: 80 of dishwasher and 160 of base. The base
        // row is the residual against the whole hour, not the composed part, so
        // the panel still sums to the figure printed above it.
        expect((await breakdownBoxes(page, 1)).map((r) => [r.label, r.power])).toEqual([
            ["Base load", "400 Wh"],
            ["Dishwasher", "80 Wh"],
        ]);
    });

    test("a scheduled appliance with no meter is named but opens nothing", async ({ page }) => {
        await loadCardBundle(page);
        await mountInspector(page, {
            withBreakdown: true,
            appliances: MIXED_APPLIANCES,
            unmeasuredWh: 100,
            forecast: {
                baseWh: 80,
                appliances: [{ entityId: null, label: "EV charger", wh: 40 }],
            },
        });
        await selectNoonSlot(page);

        const forecastRows = await breakdownBoxes(page, 1);
        // It keeps its row and its name — the demand is real — but there is no
        // sensor behind the box, so it is not dressed up as one.
        expect(forecastRows.map((r) => [r.label, r.power, r.hasSensor])).toEqual([
            ["Base load", "320 Wh", false],
            ["EV charger", "160 Wh", false],
        ]);
    });

    test("a day whose forecast composition was never recorded shows only the actual panel", async ({
        page,
    }) => {
        await loadCardBundle(page);
        await mountInspector(page, {
            withBreakdown: true,
            appliances: MIXED_APPLIANCES,
            unmeasuredWh: 100,
        });
        await selectNoonSlot(page);

        expect(await panelTitles(page)).toEqual(["House composition (actual)"]);
    });
});
