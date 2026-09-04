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
        // Nothing priced at all is three unknowns, not three zeros — the tile
        // above reads an em dash rather than claiming the hour cost nothing.
        expect(sumMoney(MONEY, ["03:00"])).toEqual({ cost: null, gain: null, net: null });
    });

    test("an unpriced direction stays unknown, and takes the net with it", () => {
        // The day the sell-price entity did not yet exist: every slot priced on
        // the import side, none on the export side. The cost stands; calling
        // the gain 0.00 would be a claim the data does not support, and a net
        // built on it would be the import bill wearing the net's name.
        const unpriced = [
            { slot: "10:00", cost: 4, gain: null },
            { slot: "10:15", cost: 9, gain: null },
        ];

        expect(sumMoney(unpriced, ["10:00", "10:15"])).toEqual({
            cost: 13,
            gain: null,
            net: null,
        });
    });

    test("a direction priced in part sums the slots that priced it", () => {
        // Only a direction with no priced slot in the selection goes unknown;
        // one that lost its rate for part of the span still reports what it
        // could price, the same approximation the span aggregates make.
        const partial = [
            { slot: "10:00", cost: 4, gain: 2 },
            { slot: "10:15", cost: 9, gain: null },
        ];

        expect(sumMoney(partial, ["10:00", "10:15"])).toEqual({
            cost: 13,
            gain: 2,
            net: 11,
        });
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
