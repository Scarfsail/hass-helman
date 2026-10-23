import { installMockHass } from "./support/mock-hass";
import { cardTree } from "./support/payload-builders";
import { test, expect, type Page } from "@playwright/test";
import { formatPower } from "../cards/shared/format";
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

test("power units follow magnitude across the signed kW threshold", () => {
    for (const [watts, display] of [
        [-1000, "-1.0 kW"], [-999, "-999 W"], [0, "0 W"],
        [999, "999 W"], [1000, "1.0 kW"],
    ] as const) {
        expect(formatPower(watts).display).toBe(display);
    }
});

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
        return [...root.querySelectorAll(".energy-grid line.flow-ribbon")].map((line) => ({
            x1: line.getAttribute("x1")!,
            y1: line.getAttribute("y1")!,
            x2: line.getAttribute("x2")!,
            y2: line.getAttribute("y2")!,
            stroke: line.getAttribute("stroke")!.trim(),
            width: Number(line.getAttribute("stroke-width")),
        }));
    });
}

const SOLAR = "var(--helman-solar)";
const GRID = "var(--helman-grid)";
const BATTERY = "var(--helman-battery)";
/** The card's stroke: 12 px at the source's maximum, never thinner than 1.5 px. */
const stroke = (watts: number, max: number) => Math.max(1.5, Math.min(watts / max, 1) * 12);

test.describe("the card draws the split as before", () => {
    test("measured export keeps the grid meter value and export connectors", async ({ page }) => {
        await mountCard(page, { solar: 3000, house: 500, battery: 0, grid: -1500 });
        const grid = page.locator("simple-card-grid");
        await expect(grid).toContainText("-1.5 kW");
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

test("the ribbons have a shared-duration sweep in the flow direction", async ({ page }) => {
    await mountCard(page, { solar: 6500, house: 900, battery: 3200, grid: -2400 });
    const bands = await page.evaluate(() => {
        const root = document.querySelector("helman-simple-card")!.shadowRoot!;
        return [...root.querySelectorAll<SVGLineElement>("line.flow-ribbon")].map(line => {
            const band = line.nextElementSibling!.querySelector(".flow-band") as SVGLineElement;
            const id = band.getAttribute("stroke")!.slice(5, -1);
            const gradient = line.ownerSVGElement!.querySelector<SVGLinearGradientElement>(`#${id}`)!;
            return {
                flow: line.dataset.flow,
                width: line.getAttribute("stroke-width"),
                bandWidth: band.getAttribute("stroke-width"),
                opacity: getComputedStyle(line).opacity,
                peak: gradient.querySelectorAll("stop")[1].getAttribute("stop-opacity"),
                duration: band.getAnimations()[0]?.effect?.getTiming().duration,
                travelX: getComputedStyle(band).getPropertyValue("--travel-x"),
                travelY: getComputedStyle(band).getPropertyValue("--travel-y"),
                stops: [...gradient.querySelectorAll("stop")].map(stop => stop.getAttribute("offset")),
            };
        });
    });
    expect(bands.map(band => band.flow)).toEqual(["solar-grid", "solar-house", "solar-battery"]);
    for (const band of bands) {
        expect(band.width).toBe(band.bandWidth);
        expect(band.opacity).toBe("0.5");
        expect(band.peak).toBe("0.5");
        expect(band.duration).toBe(2400);
        expect(band.stops).toEqual(["0", "0.5", "1"]);
    }
    expect(parseFloat(bands[0].travelX)).toBeGreaterThan(0);
    expect(parseFloat(bands[2].travelX)).toBeGreaterThan(0);

    const movement = await page.evaluate(async () => {
        const band = document.querySelector("helman-simple-card")!.shadowRoot!.querySelector(".flow-band")!;
        const before = getComputedStyle(band).transform;
        await new Promise(resolve => setTimeout(resolve, 200));
        return [before, getComputedStyle(band).transform];
    });
    expect(movement[1]).not.toBe(movement[0]);

    await mountCard(page, { solar: 0, house: 500, battery: -2000, grid: 10 });
    const reverse = await page.evaluate(() => {
        const root = [...document.querySelectorAll("helman-simple-card")].at(-1)!.shadowRoot!;
        return [...root.querySelectorAll(".flow-band")].map(band => ({
            travelX: parseFloat(getComputedStyle(band).getPropertyValue("--travel-x")),
            travelY: parseFloat(getComputedStyle(band).getPropertyValue("--travel-y")),
        }));
    });
    expect(reverse[0].travelY).toBeLessThan(0); // battery → grid
    expect(reverse[1].travelX).toBeLessThan(0); // battery → house
});

test("theme overrides reach the card and standalone illustrations without a rerender", async ({ page }) => {
    await mountCard(page, { solar: 6500, house: 900, battery: 3200, grid: -2400 });
    const before = await page.evaluate(async () => {
        const card = document.querySelector("helman-simple-card")!;
        const root = card.shadowRoot!;
        const standalone = ["simple-card-solar", "simple-card-grid", "simple-card-battery", "simple-card-house"].map(tag => {
            const node = document.createElement(tag) as any;
            node.power = tag === "simple-card-grid" ? -1000 : 1000;
            node.sourceColor = "var(--helman-solar)";
            node.soc = 60;
            document.body.appendChild(node);
            return node;
        });
        await Promise.all(standalone.map(node => node.updateComplete));
        const before = getComputedStyle(root.querySelector(".flow-ribbon")!).stroke;
        document.documentElement.style.setProperty("--helman-theme-solar", "#e879f9");
        document.documentElement.style.setProperty("--helman-theme-grid", "#fb923c");
        document.documentElement.style.setProperty("--helman-theme-battery", "#2dd4bf");
        return before;
    });
    expect(before).toBe("rgb(250, 204, 21)");
    // The illustrations transition fill/stroke for 0.6s; poll their final colors.
    await expect.poll(() => page.evaluate(() => {
        const root = document.querySelector("helman-simple-card")!.shadowRoot!;
        const standalone = ["simple-card-solar", "simple-card-grid", "simple-card-battery", "simple-card-house"]
            .map(tag => document.body.querySelector(tag)!.shadowRoot!);
        return {
            ribbon: getComputedStyle(root.querySelector(".flow-ribbon")!).stroke,
            cardSolar: getComputedStyle(root.querySelector("simple-card-solar")!.shadowRoot!.querySelector(".core.active")!).fill,
            solar: getComputedStyle(standalone[0].querySelector(".core.active")!).fill,
            grid: getComputedStyle(standalone[1].querySelector(".wire")!).stroke,
            gridPole: getComputedStyle(standalone[1].querySelector(".pole.export")!).fill,
            battery: getComputedStyle(standalone[2].querySelector(".battery-body.active")!).stroke,
            batteryFill: getComputedStyle(standalone[2].querySelector(".fill-green")!).fill,
            house: getComputedStyle(standalone[3].querySelector(".house-body.active")!).stroke,
        };
    }), { timeout: 5000 }).toEqual({
        ribbon: "rgb(232, 121, 249)", cardSolar: "rgb(232, 121, 249)",
        solar: "rgb(232, 121, 249)", grid: "rgb(232, 121, 249)",
        gridPole: "rgb(125, 211, 252)", battery: "rgb(232, 121, 249)",
        batteryFill: "rgb(45, 212, 191)", house: "rgb(232, 121, 249)",
    });
});

test("an active house without source attribution follows the house theme hook", async ({ page }) => {
    await mountCard(page, { solar: 0, house: 1000, battery: 0, grid: 1000 });
    await page.evaluate(async () => {
        const house = document.createElement("simple-card-house") as any;
        house.power = 1000;
        document.body.appendChild(house);
        await house.updateComplete;
        document.documentElement.style.setProperty("--helman-theme-house", "#a5b4fc");
    });
    await expect.poll(() => page.evaluate(() => {
        const root = document.body.querySelector("simple-card-house")!.shadowRoot!;
        const color = (selector: string, property: "stroke" | "fill") =>
            getComputedStyle(root.querySelector(selector)!).getPropertyValue(property);
        return {
            body: color(".house-body.active", "stroke"),
            roof: color(".roof.active", "stroke"),
            window: color(".window.active", "fill"),
        };
    }), { timeout: 5000 }).toEqual({
        body: "rgb(165, 180, 252)",
        roof: "rgb(165, 180, 252)",
        window: "rgb(165, 180, 252)",
    });
    const accents = await page.evaluate(() => {
        const root = document.body.querySelector("simple-card-house")!.shadowRoot!;
        return {
            door: getComputedStyle(root.querySelector(".door.active")!).stroke,
            cross: getComputedStyle(root.querySelector("line")!).stroke,
            knob: getComputedStyle(root.querySelector("circle")!).fill,
            glow: getComputedStyle(root.querySelector(".house-body.active")!).filter,
        };
    });
    for (const accent of [accents.door, accents.cross, accents.knob]) {
        expect(accent).toContain("0.647059 0.705882 0.988235");
    }
    expect(accents.glow).not.toBe("none");
});

test("grid import and export hooks color their own direction cues", async ({ page }) => {
    await mountCard(page, { solar: 0, house: 1000, battery: 0, grid: 1000 });
    await page.evaluate(async () => {
        for (const [power, sourceColor] of [[1000, undefined], [-1000, "var(--helman-solar)"]] as const) {
            const grid = document.createElement("simple-card-grid") as any;
            grid.power = power;
            grid.sourceColor = sourceColor;
            document.body.appendChild(grid);
            await grid.updateComplete;
        }
        const palette = { grid: "#fb923c", "grid-import": "#f97316", "grid-export": "#fdba74", solar: "#e879f9" };
        for (const [key, value] of Object.entries(palette)) {
            document.documentElement.style.setProperty(`--helman-theme-${key}`, value);
        }
    });
    await expect.poll(() => page.evaluate(() => {
        const [importGrid, exportGrid] = [...document.body.querySelectorAll("simple-card-grid")].map(grid => grid.shadowRoot!);
        const color = (root: ShadowRoot, selector: string, property: "fill" | "stroke" | "color") =>
            getComputedStyle(root.querySelector(selector)!).getPropertyValue(property);
        return {
            importPole: color(importGrid, ".pole.import", "fill"),
            importWire: color(importGrid, ".wire", "stroke"),
            importDot: color(importGrid, ".dot-import", "fill"),
            importLabel: color(importGrid, ".power-label.import", "color"),
            exportPole: color(exportGrid, ".pole.export", "fill"),
            exportWire: color(exportGrid, ".wire", "stroke"),
            exportDot: color(exportGrid, ".dot-export", "fill"),
            exportLabel: color(exportGrid, ".power-label.export", "color"),
        };
    }), { timeout: 5000 }).toEqual({
        importPole: "rgb(251, 146, 60)", importWire: "rgb(251, 146, 60)",
        importDot: "rgb(249, 115, 22)", importLabel: "rgb(251, 146, 60)",
        exportPole: "rgb(253, 186, 116)", exportWire: "rgb(232, 121, 249)",
        exportDot: "rgb(232, 121, 249)", exportLabel: "rgb(253, 186, 116)",
    });
});

test("multiple cards keep their gradient IDs inside their own shadow roots", async ({ page }) => {
    await mountCard(page, { solar: 6500, house: 900, battery: 3200, grid: -2400 });
    const ids = await page.evaluate(async () => {
        const second = document.createElement("helman-simple-card") as any;
        second.setConfig({ type: "custom:helman-simple-card" });
        second.hass = (window as any).__hass;
        document.body.appendChild(second);
        await second.updateComplete;
        await new Promise(resolve => {
            const timer = setInterval(() => {
                if (second.shadowRoot?.querySelector("linearGradient")) {
                    clearInterval(timer);
                    resolve(undefined);
                }
            }, 10);
        });
        const cards = [...document.querySelectorAll("helman-simple-card")];
        return cards.map(card => {
            const root = card.shadowRoot!;
            return [...root.querySelectorAll("linearGradient, mask")].map(definition => ({
                id: definition.id,
                present: !!root.querySelector(`#${definition.id}`),
            }));
        });
    });
    expect(ids[0].length).toBeGreaterThan(0);
    expect(ids[1].length).toBeGreaterThan(0);
    expect(ids.flat().every(entry => entry.present)).toBe(true);
    expect(new Set(ids.flat().map(entry => entry.id)).size).toBe(ids.flat().length);
});

test.describe("simple card visual evidence", { tag: "@screens" }, () => {
    const screens = process.env.SCREENS;
    for (const [name, powers, dark, override] of [
        ["light-export", { solar: 6500, house: 900, battery: 3200, grid: -2400 }, false, false],
        ["dark-export-themed", { solar: 6500, house: 900, battery: 3200, grid: -2400 }, true, true],
        ["light-grid-charge", { solar: 600, house: 1000, battery: 2000, grid: 2400 }, false, false],
        ["dark-grid-charge-themed", { solar: 600, house: 1000, battery: 2000, grid: 2400 }, true, true],
        ["light-battery-discharge", { solar: 0, house: 500, battery: -2000, grid: 10 }, false, false],
        ["dark-mixed-themed", { solar: 1200, house: 1800, battery: -500, grid: 100 }, true, true],
    ] as const) {
        test(name, async ({ page }) => {
            await mountCard(page, powers);
            await page.evaluate(({ dark, override }) => {
                document.body.style.cssText = `background:${dark ? "#101827" : "#f7fafc"}; color:${dark ? "#f8fafc" : "#111827"}; padding:24px; zoom:2;`;
                if (override) {
                    const palette = {
                        solar: "#e879f9", grid: "#fb923c", battery: "#2dd4bf",
                        house: "#a5b4fc", "grid-import": "#f97316", "grid-export": "#fdba74",
                    };
                    for (const [key, value] of Object.entries(palette)) {
                        document.documentElement.style.setProperty(`--helman-theme-${key}`, value);
                    }
                }
            }, { dark, override });
            await page.waitForTimeout(750);
            await page.screenshot({ path: `${screens}/${name}.png` });
        });
    }

    test("standalone illustrations and two card instances", async ({ page }) => {
        await mountCard(page, { solar: 6500, house: 900, battery: 3200, grid: -2400 });
        await page.evaluate(async () => {
            document.body.style.cssText = "background:#101827;color:#f8fafc;padding:20px;zoom:1.5";
            document.documentElement.style.setProperty("--helman-theme-solar", "#e879f9");
            document.documentElement.style.setProperty("--helman-theme-grid", "#fb923c");
            document.documentElement.style.setProperty("--helman-theme-battery", "#2dd4bf");
            document.documentElement.style.setProperty("--helman-theme-house", "#a5b4fc");
            document.documentElement.style.setProperty("--helman-theme-grid-export", "#fdba74");
            const row = document.createElement("div");
            row.style.cssText = "display:flex;gap:32px;margin:30px 0";
            document.body.appendChild(row);
            for (const tag of ["simple-card-solar", "simple-card-grid", "simple-card-battery", "simple-card-house"]) {
                const node = document.createElement(tag) as any;
                node.power = tag === "simple-card-grid" ? -1000 : 1000;
                node.soc = 60;
                if (tag !== "simple-card-house") node.sourceColor = "var(--helman-solar)";
                row.appendChild(node);
                await node.updateComplete;
            }
            const second = document.createElement("helman-simple-card") as any;
            second.setConfig({ type: "custom:helman-simple-card" });
            second.hass = (window as any).__hass;
            document.body.appendChild(second);
        });
        await expect.poll(() => page.locator("helman-simple-card").count()).toBe(2);
        await page.waitForTimeout(750);
        await page.screenshot({ path: `${screens}/standalone-and-two-cards.png`, fullPage: true });
    });
});
