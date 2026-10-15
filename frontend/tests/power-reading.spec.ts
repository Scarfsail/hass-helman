import { test, expect } from "@playwright/test";
import { powerUnitFactor, readPowerW } from "../cards/shared/power-reading";
import type { HomeAssistant } from "../types/ha";

for (const [unit, factor, reading] of [["mW", null, null], ["MW", 1_000_000, 500_000_000]] as const) {
    test(`power readings preserve the ${unit} symbol`, () => {
        const hass = {
            states: {
                "sensor.power": { state: "500", attributes: { unit_of_measurement: unit } },
            },
        } as unknown as HomeAssistant;
        expect(powerUnitFactor(hass, "sensor.power")).toBe(factor);
        expect(readPowerW(hass, "sensor.power")).toBe(reading);
    });
}
