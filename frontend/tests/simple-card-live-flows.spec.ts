import { installMockHass } from "./support/mock-hass";
import { cardTree } from "./support/payload-builders";
import { test, expect, type Page } from "@playwright/test";
import { IDLE_W, liveFlows } from "../cards/node-detail/live-flows";
import { HA_DIALOG_STUB } from "./support/ha-dialog-stub";
import { installFixedClock } from "./support/fixed-clock";
import { CARD_BUNDLE } from "./support/card-page";

/**
 * The live power split between solar, grid, battery and house.
 *
 * The simple card draws it and every node detail's Now flow reads it, so it
 * is one pure function both take. The first half pins the function to the
 * arithmetic the card has always drawn: one idle threshold, solar to the house
 * before the battery, a discharging battery to the house before the grid, and
 * export inferred from the balance when the grid meter reads ≈ 0. The second
 * half mounts the card and pins what it draws from it, so lifting the split
 * out changed nothing on screen.
 */

const flows = (solarPower: number, housePower: number, batteryPower: number, gridPower: number) =>
    liveFlows({ solarPower, housePower, batteryPower, gridPower });

test.describe("the live split", () => {
    test("solar covers the house first, then the battery, and exports the rest", () => {
        expect(flows(6500, 900, 3200, -2400)).toEqual({
            solarToHouse: 900,
            solarToBattery: 3200,
            solarToGrid: 2400,
            batteryToHouse: 0,
            batteryToGrid: 0,
            gridToHouse: 0,
            gridToBattery: 0,
            gridPower: -2400,
        });
    });

    test("solar short of the house leaves nothing for the battery, which the grid charges", () => {
        expect(flows(600, 1000, 2000, 2400)).toEqual({
            solarToHouse: 600,
            solarToBattery: 0,
            solarToGrid: 0,
            batteryToHouse: 0,
            batteryToGrid: 0,
            gridToHouse: 400,
            gridToBattery: 2000,
            gridPower: 2400,
        });
    });

    test("a discharging battery covers the rest of the house before it exports", () => {
        expect(flows(0, 1800, -1500, 300)).toMatchObject({ batteryToHouse: 1500, batteryToGrid: 0, gridToHouse: 300 });
        expect(flows(200, 500, -2000, -1700)).toMatchObject({ solarToHouse: 200, batteryToHouse: 300, batteryToGrid: 1700, gridToHouse: 0 });
    });

    test(`at or below ${IDLE_W} W a flow counts as none`, () => {
        // 50 W of solar is idle: the house takes it all from the grid.
        expect(flows(IDLE_W, 400, 0, 400)).toMatchObject({ solarToHouse: 0, gridToHouse: 400 });
        // 50 W into the battery is not charging; 40 W of surplus is not export.
        expect(flows(1000, 910, IDLE_W, 0)).toMatchObject({ solarToBattery: 0, gridToBattery: 0, solarToGrid: 0, solarToHouse: 910 });
        // A 50 W discharge is idle too.
        expect(flows(0, 300, -IDLE_W, 300)).toMatchObject({ batteryToHouse: 0, gridToHouse: 300 });
        // So is every edge derived from an active flow: 60 W out of the battery
        // to a 10 W house is neither 10 W to the house nor 50 W of export.
        expect(flows(0, 10, -60, 0)).toMatchObject({ batteryToHouse: 0, batteryToGrid: 0, gridToHouse: 0 });
    });

    test("a grid meter at ≈ 0 while the battery or solar clearly exports reads the export the balance implies", () => {
        expect(flows(0, 500, -2000, 10).gridPower).toBe(-1500);
        expect(flows(3000, 500, 0, -5).gridPower).toBe(-2500);
        // A reading of 20 W or more is the meter's own.
        expect(flows(0, 500, -2000, 25).gridPower).toBe(25);
    });
});

// ── What the card draws ──────────────────────────────────────────────────────

interface Line {
    x1: string;
    y1: string;
    x2: string;
    y2: string;
    stroke: string;
    width: number;
}

async function mountCard(page: Page, powers: { solar: number; house: number; battery: number; grid: number }): Promise<void> {
    await installFixedClock(page);
    await page.setContent("<!doctype html><html><body style='margin:0'></body></html>");
    await installMockHass(page);
    await page.addScriptTag({ content: HA_DIALOG_STUB });
    await page.evaluate(({ p, tree }) => {
        const watts = (value: number) => ({ state: String(value), attributes: { unit_of_measurement: "W" } });
        (window as any).__hass = {
            language: "en",
            locale: { language: "en-GB" },
            config: { time_zone: "UTC" },
            connection: { sendMessagePromise: async () => ({}), subscribeMessage: window.__mockHass().connection.subscribeMessage },
            states: {
                "sensor.solar": watts(p.solar), "sensor.house": watts(p.house),
                "sensor.battery": watts(p.battery), "sensor.grid": watts(p.grid),
            },
            callWS: window.__mockHass({
                "helman/get_device_tree": async (msg: {
                    type: string;
                }) => {
                    return tree;
                },
                "helman/get_history": async (msg: {
                    type: string;
                }) => {
                    return { entity_history: {} };
                },
                "helman/get_node_detail": async (msg: {
                    type: string;
                }) => {
                    throw new Error("no inverter");
                }
            }).callWS,
        };
    }, { p: powers, tree: cardTree() });
    await page.addScriptTag({ path: CARD_BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-simple-card"));
    await page.evaluate(() => {
        const card = document.createElement("helman-simple-card") as any;
        card.setConfig({ type: "custom:helman-simple-card" });
        card.hass = (window as any).__hass;
        document.body.appendChild(card);
    });
    await expect(page.locator("helman-simple-card .energy-grid")).toBeVisible();
}

/** Every flow line the card draws, in document order. */
function lines(page: Page): Promise<Line[]> {
    return page.evaluate(() => {
        const root = document.querySelector("helman-simple-card")!.shadowRoot!;
        return [...root.querySelectorAll(".energy-grid line")].map((line) => ({
            x1: line.getAttribute("x1")!,
            y1: line.getAttribute("y1")!,
            x2: line.getAttribute("x2")!,
            y2: line.getAttribute("y2")!,
            stroke: line.getAttribute("stroke")!.trim(),
            width: Number(line.getAttribute("stroke-width")),
        }));
    });
}

const SOLAR = "#facc15";
const GRID = "#38bdf8";
const BATTERY = "#22c55e";
/** The card's stroke: 12 px at the source's maximum, never thinner than 1.5 px. */
const stroke = (watts: number, max: number) => Math.max(1.5, Math.min(watts / max, 1) * 12);

test.describe("the card draws the split as before", () => {
    test("measured export keeps the grid meter value and export connectors", async ({ page }) => {
        await mountCard(page, { solar: 3000, house: 500, battery: 0, grid: -1500 });
        const grid = page.locator("simple-card-grid");
        await expect(grid).toContainText("-1500 W");
        const drawn = await lines(page);
        expect(drawn.map(line => line.stroke)).toEqual([SOLAR, SOLAR]);
        expect(drawn[0]).toMatchObject({ x1: "-22.5", x2: "53" });
        expect(await grid.evaluate((node: any) => node.power)).toBe(-1500);
    });

    test("midday: solar to the house, into the battery and out to the grid", async ({ page }) => {
        await mountCard(page, { solar: 6500, house: 900, battery: 3200, grid: -2400 });
        const drawn = await lines(page);
        expect(drawn).toHaveLength(3);
        // Solar → grid along the top, solar → house down the left, solar → battery across.
        expect(drawn[0]).toMatchObject({ stroke: SOLAR, x1: "-22.5", x2: "53" });
        expect(drawn[0].width).toBeCloseTo(stroke(2400, 5000));
        expect(drawn[1]).toMatchObject({ stroke: SOLAR, x1: "50%", y1: "0%", y2: "100%" });
        expect(drawn[1].width).toBeCloseTo(stroke(900, 5000));
        expect(drawn[2]).toMatchObject({ stroke: SOLAR, x1: "62", y1: "48", x2: "138", y2: "120" });
        expect(drawn[2].width).toBeCloseTo(stroke(3200, 5000));
    });

    test("evening: the battery and the grid supply the house", async ({ page }) => {
        await mountCard(page, { solar: 0, house: 1800, battery: -1500, grid: 300 });
        const drawn = await lines(page);
        expect(drawn).toHaveLength(2);
        expect(drawn[0]).toMatchObject({ stroke: GRID, x1: "138", y1: "48", x2: "62", y2: "120" });
        expect(drawn[0].width).toBeCloseTo(stroke(300, 11500));
        expect(drawn[1]).toMatchObject({ stroke: BATTERY, x1: "130", y1: "133", x2: "70", y2: "133" });
        expect(drawn[1].width).toBeCloseTo(stroke(1500, 5000));
    });

    test("a battery exporting past a grid meter at ≈ 0 shows the export the balance implies", async ({ page }) => {
        await mountCard(page, { solar: 0, house: 500, battery: -2000, grid: 10 });
        const drawn = await lines(page);
        expect(drawn).toHaveLength(2);
        // Battery → grid up the right, battery → house along the bottom.
        expect(drawn[0]).toMatchObject({ stroke: BATTERY, x1: "50%", y1: "100%", y2: "0%" });
        expect(drawn[0].width).toBeCloseTo(stroke(1500, 5000));
        expect(drawn[1]).toMatchObject({ stroke: BATTERY, x1: "130", x2: "70" });
        expect(drawn[1].width).toBeCloseTo(stroke(500, 5000));
        const gridPower = await page.evaluate(() =>
            (document.querySelector("helman-simple-card")!.shadowRoot!.querySelector("simple-card-grid") as any).power);
        expect(gridPower).toBe(-1500);
    });

    test("the grid charges the battery while solar is short of the house", async ({ page }) => {
        await mountCard(page, { solar: 600, house: 1000, battery: 2000, grid: 2400 });
        const drawn = await lines(page);
        // Solar → house, grid → battery down the right, grid → house across.
        expect(drawn.map((line) => line.stroke)).toEqual([SOLAR, GRID, GRID]);
        expect(drawn[1]).toMatchObject({ x1: "50%", y1: "0%", y2: "100%" });
        expect(drawn[1].width).toBeCloseTo(stroke(2000, 11500));
        expect(drawn[2]).toMatchObject({ x1: "138", y1: "48", x2: "62", y2: "120" });
        expect(drawn[2].width).toBeCloseTo(stroke(400, 11500));
    });

    test("solar over the idle threshold draws no path to a house taking none of it", async ({ page }) => {
        await mountCard(page, { solar: 1000, house: 0, battery: 0, grid: -1000 });
        expect(flows(1000, 0, 0, -1000).solarToHouse).toBe(0);
        const drawn = await lines(page);
        expect(drawn).toHaveLength(1);
        expect(drawn[0]).toMatchObject({ stroke: SOLAR, x1: "-22.5", x2: "53" });
    });

    test("grid import draws no path to the battery when solar covers its charge", async ({ page }) => {
        await mountCard(page, { solar: 1500, house: 1000, battery: 500, grid: 100 });
        expect(flows(1500, 1000, 500, 100).gridToBattery).toBe(0);
        const drawn = await lines(page);
        expect(drawn.map((line) => line.stroke)).toEqual([SOLAR, SOLAR]);
        expect(drawn.some((line) => line.stroke === GRID)).toBe(false);
    });
});
