import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Which money the three tiles report, and where each figure comes from.
 *
 * The bug this pins: money used to be derived in the card from the *drawn*
 * series — the ones that stop at the slot in progress — while every energy
 * total beside it was summed in Python from the undropped points. On today,
 * mid-slot, the grid tile therefore reported energy the money tiles had already
 * dropped, and the panel contradicted itself.
 *
 * The rule now is one line: each money tile follows the same rule as the energy
 * it sits next to. The daily-totals tiles read the payload's own totals, which
 * count the running slot. The selection tiles sum the drawn series, which stops
 * before it — exactly as the selection's energy figures do.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const DAY = "2026-07-18";

/** One slot's money as the payload carries it: either side may be unpriced. */
type MoneyPoint = { slot: string; cost: number | null; gain: number | null };
type MoneyTotals = { cost: number | null; gain: number | null; net: number | null };

/**
 * Two elapsed slots and one running slot's worth of money, with the running
 * slot present in the totals and absent from the drawn series — the shape the
 * backend serves on today.
 */
const MONEY_ACTUAL: MoneyPoint[] = [
    { slot: "08:00", cost: 2, gain: 0 },
    { slot: "08:15", cost: 3, gain: 1 },
];
const RUNNING_SLOT_COST = 10;
const TOTALS_ACTUAL = { cost: 2 + 3 + RUNNING_SLOT_COST, gain: 1, net: 2 + 3 + RUNNING_SLOT_COST - 1 };

async function mountInspector(
    page: Page,
    overrides: {
        moneyActual?: MoneyPoint[];
        totalsActual?: MoneyTotals | null;
    } = {},
): Promise<void> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-solar-inspector"));

    await page.evaluate(({ date, money, totals }) => {
        const impact: Array<Record<string, unknown>> = [];
        const corrected: Array<{ timestamp: string; valueWh: number }> = [];
        for (let m = 0; m < 1440; m += 15) {
            const hh = String(Math.floor(m / 60)).padStart(2, "0");
            const mm = String(m % 60).padStart(2, "0");
            // A slot only becomes selectable once the impact series names it.
            impact.push({ slot: `${hh}:${mm}`, rawWh: 0, correctedWh: 0, impactWh: 0, factor: 1 });
            corrected.push({ timestamp: `${date}T${hh}:${mm}:00`, valueWh: 100 });
        }
        const payload = {
            date,
            timezone: "UTC",
            status: "ok",
            effectiveVariant: null,
            trainedAt: null,
            range: {
                minDate: date, maxDate: date, canGoPrevious: false, canGoNext: false,
                isToday: true, isFuture: false,
            },
            series: {
                raw: [], corrected, actual: [], invalidated: [], factors: [], impact,
                houseForecast: [], houseActual: [],
                batterySocForecast: [], batterySocActual: [],
                gridForecast: [], gridActual: [], batteryForecast: [], batteryActual: [],
                importPrice: [], exportPrice: [],
                moneyActual: money,
                moneyForecast: [],
            },
            totals: {
                rawWh: null, correctedWh: null, actualWh: null,
                houseForecastWh: null, houseActualWh: null,
                gridForecastWh: null, gridActualWh: null,
                batteryForecastWh: null, batteryActualWh: null,
                moneyActual: totals,
                moneyForecast: null,
            },
            availability: {
                hasRawForecast: false, hasCorrectedForecast: true, hasActuals: false,
                hasInvalidated: false, hasProfile: true, hasHouseForecast: false,
                hasHouseActual: false, hasBatterySocForecast: false, hasBatterySocActual: false,
                hasGridForecast: false, hasGridActual: false, hasBatteryForecast: false,
                hasBatteryActual: false, hasImportPrice: false, hasExportPrice: false,
            },
            priceUnit: "CZK/kWh",
            batterySocBounds: [],
            trainingExplainability: null,
        };

        document.body.innerHTML = "";
        const el = document.createElement("helman-solar-inspector") as any;
        el.daylightOnlyDefault = false;
        el.slotMinutesDefault = 15;
        el.hass = {
            language: "en",
            config: { time_zone: "UTC" },
            connection: {},
            callWS: async (msg: { date: string }) => ({ ...payload, date: msg.date }),
        };
        document.body.appendChild(el);
    }, { date: DAY, money: overrides.moneyActual ?? MONEY_ACTUAL, totals: overrides.totalsActual === undefined ? TOTALS_ACTUAL : overrides.totalsActual });

    await page.waitForFunction(() => {
        const el = document.querySelector("helman-solar-inspector") as any;
        return !!el?.shadowRoot?.querySelector(".metric-card");
    });
}

/**
 * The actual chip of a money tile, in the daily-totals panel or — when `slots`
 * is given — in the selection panel opened on those slots.
 */
async function moneyTile(
    page: Page,
    label: string,
    slots: string[] | null = null,
): Promise<string> {
    return page.evaluate(({ wanted, selected }) => {
        const el = document.querySelector("helman-solar-inspector") as any;
        if (selected !== null) {
            el._slotSelection = {
                selectedSlots: selected,
                focusSlot: selected[0],
                anchorSlot: selected[0],
            };
            el.requestUpdate();
        }
        return el.updateComplete.then(() => {
            const sections = [...el.shadowRoot.querySelectorAll(".metrics-section")];
            // The selection panel is rendered above the daily totals, so the
            // day's tiles are always the last section's.
            const section = selected === null
                ? sections[sections.length - 1]
                : sections[0];
            const card = [...section.querySelectorAll(".metric-card")].find(
                (node: Element) => (node.querySelector(".metric-label")?.textContent ?? "").trim() === wanted,
            );
            // Actual is the first chip; forecast, where present, follows it.
            return (card?.querySelector(".metric-chip")?.textContent ?? "").trim();
        });
    }, { wanted: label, selected: slots });
}

test.describe("solar inspector money tiles", () => {
    test.beforeEach(async ({ page }) => {
        await page.setViewportSize({ width: 1100, height: 900 });
    });

    test("the day's tiles report the payload's totals, running slot included", async ({ page }) => {
        await mountInspector(page);
        // 15 CZK, not the 5 the drawn series adds up to: the slot in progress
        // counts here exactly as it counts in gridActualWh beside it.
        expect(await moneyTile(page, "Import cost")).toBe("15.00 CZK");
        expect(await moneyTile(page, "Export gain")).toBe("1.00 CZK");
        expect(await moneyTile(page, "Net cost")).toBe("14.00 CZK");
    });

    test("a selection sums the drawn series, stopping where its energy does", async ({ page }) => {
        await mountInspector(page);
        expect(await moneyTile(page, "Import cost", ["08:00", "08:15"])).toBe("5.00 CZK");
        expect(await moneyTile(page, "Import cost", ["08:00"])).toBe("2.00 CZK");
    });

    test("a selection over slots the day never priced reads an em dash", async ({ page }) => {
        // Presence is asked of the selection, not the day: an unpriced hour must
        // not inherit the day's total, nor be claimed to have cost nothing.
        await mountInspector(page);
        expect(await moneyTile(page, "Import cost", ["14:00"])).toBe("—");
    });

    test("a day that priced nothing shows an em dash rather than 0.00", async ({ page }) => {
        // A day past the recorder's reach has real kWh at an unknown rate;
        // "cost 0" would be a claim the data cannot support.
        await mountInspector(page, { moneyActual: [], totalsActual: null });
        expect(await moneyTile(page, "Import cost")).toBe("—");
    });

    test("a day priced on one side only dashes that side, and the net", async ({ page }) => {
        // The reachable case: an import rail filled from the configured
        // windows, an export rail from before the sell-price entity existed.
        // The import bill is real and stands; the exported kWh are real too and
        // their rate is unknown, so the gain is an em dash rather than 0.00 —
        // and the net follows it, since a balance missing one direction is the
        // import bill under another name.
        await mountInspector(page, {
            moneyActual: [
                { slot: "08:00", cost: 2, gain: null },
                { slot: "08:15", cost: 3, gain: null },
            ],
            totalsActual: { cost: 5, gain: null, net: null },
        });
        expect(await moneyTile(page, "Import cost")).toBe("5.00 CZK");
        expect(await moneyTile(page, "Export gain")).toBe("—");
        expect(await moneyTile(page, "Net cost")).toBe("—");
    });

    test("a selection over one unpriced direction dashes it too", async ({ page }) => {
        // The selection path asks the same question of its own sum, so the two
        // panels cannot disagree about what is known.
        await mountInspector(page, {
            moneyActual: [
                { slot: "08:00", cost: 2, gain: null },
                { slot: "08:15", cost: 3, gain: null },
            ],
            totalsActual: { cost: 5, gain: null, net: null },
        });
        expect(await moneyTile(page, "Import cost", ["08:00"])).toBe("2.00 CZK");
        expect(await moneyTile(page, "Export gain", ["08:00"])).toBe("—");
        expect(await moneyTile(page, "Net cost", ["08:00"])).toBe("—");
    });
});
