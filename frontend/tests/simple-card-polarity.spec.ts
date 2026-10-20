import { test, expect } from "@playwright/test";
import { readEnergyReadings, type EnergyNodes } from "../cards/node-detail/node-detail-readings";
import type { TreeItem } from "../cards/shared/data/tree-item";
import type { ValueType } from "../cards/helman-api";
import type { HomeAssistant } from "../types/ha";

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
 * `readEnergyReadings` is exercised directly: it is where both live, and driving
 * the whole card would test the renderer instead of the arithmetic.
 */

const BATTERY = "sensor.battery_power";
const HOUSE = "sensor.house_power";

interface Polarity {
    batteryInverted?: boolean;
    houseValueType?: ValueType;
    solarPowerEntityId?: string;
    batterySocEntityId?: string;
}

/** The energy nodes the card resolves from its tree, as far as these readings look. */
function energyNodes({ batteryInverted = false, houseValueType = "default", solarPowerEntityId, batterySocEntityId }: Polarity = {}): EnergyNodes {
    const node = (fields: Record<string, unknown>) => fields as unknown as TreeItem;
    return {
        solarNode: solarPowerEntityId ? node({ powerSensorId: solarPowerEntityId, valueType: "default" }) : null,
        // The battery source node is `negative` upright and `positive` when `power_polarity` inverts it.
        batteryProducerNode: node({
            powerSensorId: BATTERY,
            valueType: batteryInverted ? "positive" : "negative",
            nodeConfig: { entities: { capacity: batterySocEntityId } },
        }),
        houseNode: node({ powerSensorId: HOUSE, valueType: houseValueType }),
    };
}

function hassWith(states: Record<string, unknown>): HomeAssistant {
    return { states } as unknown as HomeAssistant;
}

/** Run `readEnergyReadings` against one set of nodes and one set of sensor states. */
function readEnergy(states: Record<string, string>, polarity: Polarity = {}): { batteryPower: number; housePower: number } {
    const values = readEnergyReadings(
        hassWith(Object.fromEntries(Object.entries(states).map(([id, state]) => [id, { state }]))),
        energyNodes(polarity),
    );
    return { batteryPower: values.batteryPower, housePower: values.housePower };
}

test("the default convention reads through unchanged", () => {
    const values = readEnergy({ [BATTERY]: "2000", [HOUSE]: "450" });
    expect(values).toEqual({ batteryPower: 2000, housePower: 450 });
});

test("a negative house reading is still clamped to zero", () => {
    // The clamp predates power_polarity and has to survive it: applyValueType
    // passes "default" through untouched, so the clamp lives outside it.
    const values = readEnergy({ [BATTERY]: "0", [HOUSE]: "-120" });
    expect(values.housePower).toBe(0);
});

test("an inverted battery sensor keeps charging positive", () => {
    const charging = readEnergy({ [BATTERY]: "-2000", [HOUSE]: "450" }, { batteryInverted: true });
    expect(charging.batteryPower).toBe(2000);

    const discharging = readEnergy({ [BATTERY]: "1500", [HOUSE]: "450" }, { batteryInverted: true });
    expect(discharging.batteryPower).toBe(-1500);
});

test("an inverted house sensor reports its magnitude, not zero", () => {
    const values = readEnergy({ [BATTERY]: "0", [HOUSE]: "-450" }, { houseValueType: "negative" });
    expect(values.housePower).toBe(450);
});

test("a missing sensor still reads zero on either convention", () => {
    const values = readEnergy({}, { batteryInverted: true, houseValueType: "negative" });
    expect(values).toEqual({ batteryPower: -0, housePower: 0 });
});

test("power units convert live while SOC remains a percentage", () => {
    const states: Record<string, any> = {
        "sensor.house_power": { state: "2.4", attributes: { unit_of_measurement: "kW" } },
        "sensor.battery_power": { state: "-0.001", attributes: { unit_of_measurement: "MW" } },
        "sensor.solar": { state: "4.2", attributes: { unit_of_measurement: "kW" } },
        "sensor.soc": { state: "75", attributes: { unit_of_measurement: "%" } },
    };
    const nodes = energyNodes({ solarPowerEntityId: "sensor.solar", batterySocEntityId: "sensor.soc" });
    const read = () => readEnergyReadings(hassWith(states), nodes);
    const first = read();
    states["sensor.house_power"].attributes.unit_of_measurement = "W";
    const second = read();
    states["sensor.house_power"].attributes.unit_of_measurement = "VA";
    const unknown = read();
    expect(first).toMatchObject({ housePower: 2400, solarPower: 4200, solarPowerReading: 4200, batteryPower: -1000, batterySoc: 75 });
    expect(second.housePower).toBe(2.4);
    expect(unknown).toMatchObject({ housePower: 0, houseReadable: false });
});
