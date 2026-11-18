import { type Page } from "@playwright/test";

import { FIXED_TODAY, installFixedClock } from "./fixed-clock";
import { loadBundle } from "./card-page";

/**
 * The harness the day-view pan specs mount against: three days -- yesterday,
 * today and tomorrow -- each told apart by its numbers. Its solar hours, its
 * solar level, its prices and its totals all move with the day, so what is
 * drawn where says which day it came from.
 *
 * A support module rather than a spec export, for the reason
 * `inspector-aggregate-harness` gives: importing a spec re-runs its tests.
 */

export const DAY_MS = 86_400_000;

export function dayAt(offset: number): string {
    return new Date(Date.parse(`${FIXED_TODAY}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);
}

export const YESTERDAY = dayAt(-1);
export const TODAY = FIXED_TODAY;
export const TOMORROW = dayAt(1);

/** Today's solar hours are 08-16, tomorrow's 06-18, yesterday's 10-14. */
export function solarHours(offset: number): { start: number; end: number } {
    return { start: 8 - 2 * offset, end: 16 + 2 * offset };
}

export async function mountInspector(
    page: Page,
    options: {
        daylightOnly: boolean;
        nowIso?: string;
        slotMinutes?: number;
        hourlyDates?: string[];
        /** The last day navigation reaches; tomorrow unless given. */
        lastDay?: string;
    },
): Promise<void> {
    await page.setViewportSize({ width: 1200, height: 1000 });
    await installFixedClock(page);
    if (options.nowIso !== undefined) await page.clock.setFixedTime(new Date(options.nowIso));
    await loadBundle(page, "helman-solar-inspector");
    await page.evaluate(({ daylightOnly, slotMinutes, hourlyDates, today, yesterday, lastDay }) => {
        const dayMs = 86_400_000;
        const todayMs = Date.parse(`${today}T00:00:00Z`);
        const offsetOf = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - todayMs) / dayMs);
        const slotsOf = (minutes: number) => Array.from({ length: 1440 / minutes }, (_, index) =>
            `${String(Math.floor((index * minutes) / 60)).padStart(2, "0")}:${String((index * minutes) % 60).padStart(2, "0")}`);
        const payload = (date: string) => {
            const offset = offsetOf(date);
            // A day only the recorder's hourly statistics still hold: the same
            // power, in a quarter as many buckets of four times the energy.
            const granularity = hourlyDates.includes(date) ? 60 : 15;
            const perBucket = granularity / 15;
            const slots = slotsOf(granularity);
            const firstHour = 8 - 2 * offset;
            const lastHour = 16 + 2 * offset;
            const sunny = (slot: string) => {
                const hour = Number(slot.slice(0, 2));
                return hour >= firstHour && hour < lastHour;
            };
            return window.__inspectorDay({
                date,
                timezone: "UTC",
                status: "ok",
                effectiveVariant: null,
                trainedAt: null,
                range: {
                    minDate: yesterday,
                    maxDate: lastDay,
                    canGoPrevious: date > yesterday,
                    canGoNext: date < lastDay,
                    isToday: date === today,
                    isFuture: date > today,
                },
                series: {
                    raw: [], actual: [], invalidated: [], factors: [], impact: [],
                    corrected: slots.map((slot) => ({ slot, valueWh: sunny(slot) ? 100 * (offset + 3) * perBucket : 0 })),
                    houseForecast: [], houseActual: [], houseActualBreakdown: [],
                    batterySocForecast: slots.map((slot) => ({ slot, pct: 50 + 10 * offset })),
                    batterySocActual: [],
                    gridForecast: [], gridActual: [], batteryForecast: [], batteryActual: [],
                    importPrice: slots.map((slot) => ({ slot, value: 3 + offset })),
                    exportPrice: slots.map((slot) => ({ slot, value: 1 })),
                    moneyActual: [],
                    moneyForecast: slots.map((slot) => ({ slot, cost: 0.2 * (offset + 2) * perBucket, gain: 0.1 * perBucket })),
                },
                totals: {
                    rawWh: null, correctedWh: 1000 * (offset + 5), actualWh: null,
                    houseForecastWh: null, houseActualWh: null, gridForecastWh: null, gridActualWh: null,
                    batteryForecastWh: null, batteryActualWh: null, moneyActual: null, moneyForecast: null,
                },
                availability: { hasProfile: true },
                ...(granularity === 15 ? {} : { dataGranularityMinutes: granularity }),
                priceUnit: "CZK/kWh",
                batterySocBounds: [],
            });
        };

        // Two days of schedule with the boiler on in the evening today and in
        // the small hours tomorrow, so the band has a run on each side of the
        // midnight a drag carries into view.
        const scheduleSlots = Array.from({ length: 2 * 96 }, (_, index) => {
            const at = todayMs + index * 900_000;
            const hour = Math.floor(index / 4);
            const on = hour === 20 || hour === 27;
            return { id: new Date(at).toISOString(), controllables: on ? { boiler: { on: true, setBy: "user" } } : {} };
        });

        const requestedDates: string[] = [];
        (window as unknown as Record<string, unknown>).__requestedDates = requestedDates;
        const inspector = document.createElement("helman-solar-inspector") as unknown as HTMLElement & Record<string, unknown>;
        inspector.daylightOnlyDefault = daylightOnly;
        inspector.slotMinutesDefault = slotMinutes;
        inspector.hass = {
            language: "en",
            locale: { language: "en" },
            config: { time_zone: "UTC" },
            states: {
                "switch.boiler": {
                    entity_id: "switch.boiler", state: "off",
                    attributes: { friendly_name: "Boiler" }, last_changed: new Date().toISOString(),
                },
            },
            ...window.__mockHass({
                "helman/solar_bias/inspector": async (message: { date?: string }) => {
                    requestedDates.push(message.date ?? "");
                    return payload(message.date ?? "");
                },
                "helman/get_schedule": { executionEnabled: true, slotMinutes: 15, slots: scheduleSlots },
                "helman/get_appliances": { appliances: [{
                    id: "boiler", name: "Boiler", kind: "generic", primaryEntityId: "switch.boiler",
                    supportsAuthoring: true, normalState: "off",
                    metadata: { icon: "mdi:water-boiler", scheduleCapabilities: { onOffToggle: true } },
                    controls: { switch: { entityId: "switch.boiler" } },
                }] },
                "helman/get_entity_actual_history": { entities: {} },
                "helman/get_appliance_projections": { appliances: [] },
            }),
        };
        document.body.appendChild(inspector);
    }, {
        daylightOnly: options.daylightOnly, slotMinutes: options.slotMinutes ?? 30, hourlyDates: options.hourlyDates ?? [],
        today: TODAY, yesterday: YESTERDAY, lastDay: options.lastDay ?? TOMORROW,
    });

    await page.waitForFunction(() => {
        const root = document.querySelector("helman-solar-inspector")?.shadowRoot;
        return !!root?.querySelector("helman-solar-day-chart")?.shadowRoot?.querySelector(".main-chart-wrap svg")
            && !!root.querySelector("helman-solar-day-pills")?.shadowRoot?.querySelector(".pill.selected")
            && !!root.querySelector("helman-solar-schedule-band-strip")?.shadowRoot
                ?.querySelector("scheduling-entity-day-band");
    });
}

export type ViewState = {
    selected: string | null;
    start: number;
    end: number;
    overlayDate: string | null;
    overlayStart: number | null;
    selection: string[];
    loading: boolean;
};

/** What the day view is showing: the lit pill, the window and the neighbour overlay. */
export function readView(page: Page): Promise<ViewState> {
    return page.evaluate(() => {
        const root = document.querySelector("helman-solar-inspector")!.shadowRoot!;
        const chart = root.querySelector("helman-solar-day-chart:not([overlay])") as any;
        const overlay = root.querySelector("helman-solar-day-chart[overlay]") as any;
        const pill = root.querySelector("helman-solar-day-pills")!.shadowRoot!.querySelector(".pill.selected");
        return {
            selected: pill?.getAttribute("data-day") ?? null,
            start: chart.layout.dayStartMinutes,
            end: chart.layout.dayEndMinutes,
            overlayDate: overlay?.date ?? null,
            overlayStart: overlay?.layout?.dayStartMinutes ?? null,
            selection: [...chart.selection.selectedSlots],
            loading: !!root.querySelector(".loading-overlay"),
        };
    });
}

/** The selected day's plot, in client pixels. */
export function plotBox(page: Page): Promise<{ left: number; width: number; top: number }> {
    return page.evaluate(() => {
        const chart = document.querySelector("helman-solar-inspector")!.shadowRoot!
            .querySelector("helman-solar-day-chart:not([overlay])") as any;
        const svg = chart.shadowRoot.querySelector(".main-chart-wrap svg") as SVGSVGElement;
        const rect = svg.getBoundingClientRect();
        const scale = rect.width / chart.layout.width;
        return {
            left: rect.left + chart.layout.margin.left * scale,
            width: chart.layout.plotWidth * scale,
            top: rect.top + chart.layout.margin.top * scale,
        };
    });
}

/**
 * A left-button drag across the chart by `fraction` of the plot's width:
 * negative drags leftwards, which moves the window later.
 */
export async function mouseDrag(page: Page, fraction: number): Promise<void> {
    const plot = await plotBox(page);
    const y = plot.top + 40;
    const startX = fraction < 0 ? plot.left + plot.width - 4 : plot.left + 4;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX + fraction * plot.width, y, { steps: 12 });
    await page.mouse.up();
}

/** A one-finger drag on the chart, as the pointer events a touch screen sends. */
export async function touchDrag(page: Page, dx: number, dy: number): Promise<void> {
    await page.evaluate(({ dx, dy }) => {
        const chart = document.querySelector("helman-solar-inspector")!.shadowRoot!
            .querySelector("helman-solar-day-chart:not([overlay])") as any;
        const svg = chart.shadowRoot.querySelector(".main-chart-wrap svg") as SVGSVGElement;
        const rect = svg.getBoundingClientRect();
        const x0 = rect.left + rect.width * 0.8;
        const y0 = rect.top + 60;
        const send = (type: string, x: number, y: number) => svg.dispatchEvent(new PointerEvent(type, {
            pointerId: 7, pointerType: "touch", isPrimary: true, button: 0,
            clientX: x, clientY: y, bubbles: true, composed: true, cancelable: true,
        }));
        send("pointerdown", x0, y0);
        for (let step = 1; step <= 10; step += 1) send("pointermove", x0 + (dx * step) / 10, y0 + (dy * step) / 10);
        send("pointerup", x0 + dx, y0 + dy);
    }, { dx, dy });
}

/** Press a day's pill. */
export async function pressPill(page: Page, day: string): Promise<void> {
    await page.evaluate((day) => {
        const pill = document.querySelector("helman-solar-inspector")!.shadowRoot!
            .querySelector("helman-solar-day-pills")!.shadowRoot!
            .querySelector(`.pill[data-day="${day}"]`) as HTMLButtonElement;
        pill.click();
    }, day);
}

/** The two panels under the strips: the selected slot's detail, and the day's totals. */
export function readPanels(page: Page): Promise<string[]> {
    return page.evaluate(() => [...document.querySelector("helman-solar-inspector")!.shadowRoot!
        .querySelectorAll(".metrics-section")].map((section) => section.textContent?.replace(/\s+/g, " ").trim() ?? ""));
}

/** Remember whether the loading overlay ever appears from here on. */
export async function watchForLoading(page: Page): Promise<void> {
    await page.evaluate(() => {
        const root = document.querySelector("helman-solar-inspector")!.shadowRoot!;
        const w = window as unknown as Record<string, unknown>;
        w.__sawLoading = false;
        new MutationObserver(() => {
            if (root.querySelector(".loading-overlay")) w.__sawLoading = true;
        }).observe(root, { childList: true, subtree: true });
    });
}
