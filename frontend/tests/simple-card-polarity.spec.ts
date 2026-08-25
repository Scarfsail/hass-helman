import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * The simple card reading power sensors that are not on the house convention.
 *
 * Both readings here bypass the tree node's `valueType`, for different reasons,
 * and both were wrong when `power_polarity` shipped:
 *
 * - **Battery** is needed *signed* — the card derives charging/discharging from
 *   its sign — where `applyValueType` yields an unsigned magnitude. So it takes
 *   a flip rather than a `ValueType`, and an inverted sensor used to draw
 *   charging as discharging.
 * - **House** was hard-coded `Math.max(0, raw)`, which reads a
 *   negative-is-consumption sensor as a flat zero — and that zero propagates
 *   into `solarToGrid`, so solar appears to export everything it makes.
 *
 * `_readEnergyValues` is exercised directly: it is where both live, and driving
 * the whole card would test the renderer instead of the arithmetic.
 */

const BUNDLE = resolve(
    __dirname,
    "../../custom_components/helman/frontend_compiled/helman-card.js",
);

const BATTERY = "sensor.battery_power";
const HOUSE = "sensor.house_power";

interface Reading {
    batteryPower: number;
    housePower: number;
}

/** Run `_readEnergyValues` against one entity map and one set of sensor states. */
async function readEnergy(
    page: Page,
    states: Record<string, string>,
    map: Record<string, unknown>,
): Promise<Reading> {
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: BUNDLE, type: "module" });
    await page.waitForFunction(() => !!customElements.get("helman-simple-card"));

    return page.evaluate(({ states, map }) => {
        const card = document.createElement("helman-simple-card") as HTMLElement &
            Record<string, any>;
        const hass = {
            states: Object.fromEntries(
                Object.entries(states).map(([id, state]) => [id, { state }]),
            ),
        };
        const values = card._readEnergyValues(hass, map);
        return { batteryPower: values.batteryPower, housePower: values.housePower };
    }, { states, map });
}

function entityMap(overrides: Record<string, unknown> = {}) {
    return {
        solarPowerEntityId: null,
        solarValueType: "default",
        gridPowerEntityId: null,
        gridValueType: "default",
        batteryPowerEntityId: BATTERY,
        batteryInverted: false,
        batterySocEntityId: null,
        batteryMinSocEntityId: null,
        housePowerEntityId: HOUSE,
        houseValueType: "default",
        solarMaxPower: 5000,
        gridMaxPower: 11500,
        batteryMaxPower: 5000,
        ...overrides,
    };
}

test("the default convention reads through unchanged", async ({ page }) => {
    const values = await readEnergy(
        page,
        { [BATTERY]: "2000", [HOUSE]: "450" },
        entityMap(),
    );
    expect(values).toEqual({ batteryPower: 2000, housePower: 450 });
});

test("a negative house reading is still clamped to zero", async ({ page }) => {
    // The clamp predates power_polarity and has to survive it: applyValueType
    // passes "default" through untouched, so the clamp lives outside it.
    const values = await readEnergy(
        page,
        { [BATTERY]: "0", [HOUSE]: "-120" },
        entityMap(),
    );
    expect(values.housePower).toBe(0);
});

test("an inverted battery sensor keeps charging positive", async ({ page }) => {
    const charging = await readEnergy(
        page,
        { [BATTERY]: "-2000", [HOUSE]: "450" },
        entityMap({ batteryInverted: true }),
    );
    expect(charging.batteryPower).toBe(2000);

    const discharging = await readEnergy(
        page,
        { [BATTERY]: "1500", [HOUSE]: "450" },
        entityMap({ batteryInverted: true }),
    );
    expect(discharging.batteryPower).toBe(-1500);
});

test("an inverted house sensor reports its magnitude, not zero", async ({ page }) => {
    const values = await readEnergy(
        page,
        { [BATTERY]: "0", [HOUSE]: "-450" },
        entityMap({ houseValueType: "negative" }),
    );
    expect(values.housePower).toBe(450);
});

test("a missing sensor still reads zero on either convention", async ({ page }) => {
    const values = await readEnergy(page, {}, entityMap({
        batteryInverted: true,
        houseValueType: "negative",
    }));
    expect(values).toEqual({ batteryPower: -0, housePower: 0 });
});
