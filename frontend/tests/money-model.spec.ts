import { test, expect } from "@playwright/test";
import { sumMoney, currencyFromPriceUnit } from "../cards/helman-solar-inspector/money-model";

/**
 * What is left of the money model once the pricing moved to Python.
 *
 * Cost and gain per slot arrive on the day payload, computed there from each
 * grid direction's own energy and its own rate — the properties that used to
 * be pinned here (each direction priced at its own rate, a day's money as the
 * sum of its slots, energy with no rate contributing nothing) are now pinned in
 * `tests/test_inspector_money.py`, where the arithmetic lives.
 *
 * This module's remaining job is the selection: summing supplied amounts over
 * the slots the user picked. The module imports only types, so it is exercised
 * directly rather than through the card bundle.
 */

const MONEY = [
    { slot: "10:00", cost: 4, gain: 0 },
    { slot: "10:15", cost: 9, gain: 0 },
    { slot: "11:00", cost: 0, gain: 5 },
];

test.describe("money model", () => {
    test("a selection totals only the slots it names", () => {
        expect(sumMoney(MONEY, ["10:00"]).cost).toBeCloseTo(4, 6);
        expect(sumMoney(MONEY, ["10:00", "10:15"]).cost).toBeCloseTo(13, 6);
    });

    test("a slot the series has no money for contributes nothing", () => {
        // The selection is on the inspector's slot grid and may name slots the
        // day never priced; those must not be read as zeros that drag a total.
        expect(sumMoney(MONEY, ["03:00"])).toEqual({ cost: 0, gain: 0, net: 0 });
    });

    test("net is what the grid came to on balance", () => {
        const totals = sumMoney(MONEY, ["10:00", "11:00"]);
        expect(totals.cost).toBeCloseTo(4, 6);
        expect(totals.gain).toBeCloseTo(5, 6);
        // Negative means the span paid you more than it charged you.
        expect(totals.net).toBeCloseTo(-1, 6);
    });

    test("the currency comes off the price unit", () => {
        // Derived rather than configured, so a setup priced in anything else
        // follows its own unit without a second place to keep in step.
        expect(currencyFromPriceUnit("CZK/kWh")).toBe("CZK");
        expect(currencyFromPriceUnit("EUR/MWh")).toBe("EUR");
        expect(currencyFromPriceUnit(null)).toBe("");
    });
});
