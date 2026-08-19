import { test, expect } from "@playwright/test";
import {
    buildMoneySeries,
    currencyFromPriceUnit,
    sumMoney,
} from "../cards/helman-solar-inspector/money-model";

/**
 * How energy and price become money.
 *
 * The arithmetic lives in one module because the strip, the metric tiles and
 * the tooltip all need the same answer, and because the frontend re-buckets
 * every series when the slot-size control changes — a backend-computed money
 * series would have to be re-derived here anyway. The module imports only
 * types, so it is exercised directly rather than through the card bundle.
 *
 * Two properties carry the whole feature. Each direction is priced at its own
 * rate, so a slot that both imported and exported is not `net x price`. And a
 * day's money is the sum of its slots, never its total energy times an average
 * rate, because the expensive hours are rarely the ones you imported in.
 */

const DAY = "2026-07-18";

/** An energy point on a given slot of the fixed test day. */
function wh(slot: string, valueWh: number) {
    return { timestamp: `${DAY}T${slot}:00+02:00`, valueWh };
}

test.describe("money model", () => {
    test("each direction is priced at its own rate", () => {
        // The case netting destroys: 2 kWh in at 6, 3 kWh out at 1. Net energy
        // is +1 kWh, and no single rate applied to it yields both 12 and 3.
        const money = buildMoneySeries({
            importKwh: [wh("10:00", 2000)],
            exportKwh: [wh("10:00", 3000)],
            importPrice: [{ slot: "10:00", value: 6 }],
            exportPrice: [{ slot: "10:00", value: 1 }],
        });

        expect(money).toEqual([{ slot: "10:00", cost: 12, gain: 3 }]);
    });

    test("a day's money is the sum of its slots, not energy times mean price", () => {
        // 1 kWh at 10 plus 3 kWh at 2 is 16, where 4 kWh at the mean rate of 6
        // would be 24. Mean-rate accounting flatters exactly the days whose
        // consumption avoided the expensive hours.
        const money = buildMoneySeries({
            importKwh: [wh("10:00", 1000), wh("10:15", 3000)],
            exportKwh: [],
            importPrice: [
                { slot: "10:00", value: 10 },
                { slot: "10:15", value: 2 },
            ],
            exportPrice: [],
        });

        expect(sumMoney(money).cost).toBeCloseTo(16, 6);
    });

    test("energy with no price contributes nothing rather than zero", () => {
        // A day past the recorder's reach has real exported kWh at an unknown
        // rate. Calling that "earned 0" is a claim the data cannot support.
        const money = buildMoneySeries({
            importKwh: [],
            exportKwh: [wh("10:00", 3000)],
            importPrice: [],
            exportPrice: [],
        });

        expect(money).toEqual([]);
    });

    test("a negative export rate makes the gain negative", () => {
        // Paying to export is ordinary here: sign carries the direction of the
        // money, and the reader is told by the number rather than by a colour.
        const money = buildMoneySeries({
            importKwh: [],
            exportKwh: [wh("13:00", 4000)],
            importPrice: [],
            exportPrice: [{ slot: "13:00", value: -0.5 }],
        });

        expect(money).toEqual([{ slot: "13:00", cost: 0, gain: -2 }]);
    });

    test("several energy points in one slot accumulate", () => {
        const money = buildMoneySeries({
            importKwh: [wh("10:00", 500), wh("10:00", 1500)],
            exportKwh: [],
            importPrice: [{ slot: "10:00", value: 3 }],
            exportPrice: [],
        });

        expect(money).toEqual([{ slot: "10:00", cost: 6, gain: 0 }]);
    });

    test("net is what the grid came to on balance", () => {
        const money = buildMoneySeries({
            importKwh: [wh("10:00", 2000)],
            exportKwh: [wh("11:00", 5000)],
            importPrice: [{ slot: "10:00", value: 6 }],
            exportPrice: [{ slot: "11:00", value: 1 }],
        });

        const totals = sumMoney(money);
        expect(totals.cost).toBeCloseTo(12, 6);
        expect(totals.gain).toBeCloseTo(5, 6);
        // Positive means the grid took money off you over the span.
        expect(totals.net).toBeCloseTo(7, 6);
    });

    test("a selection totals only the slots it names", () => {
        const money = buildMoneySeries({
            importKwh: [wh("10:00", 1000), wh("10:15", 1000)],
            exportKwh: [],
            importPrice: [
                { slot: "10:00", value: 4 },
                { slot: "10:15", value: 9 },
            ],
            exportPrice: [],
        });

        expect(sumMoney(money, ["10:00"]).cost).toBeCloseTo(4, 6);
        expect(sumMoney(money, ["10:00", "10:15"]).cost).toBeCloseTo(13, 6);
    });

    test("the currency comes off the price unit", () => {
        // Derived rather than configured, so a setup priced in anything else
        // follows its own unit without a second place to keep in step.
        expect(currencyFromPriceUnit("CZK/kWh")).toBe("CZK");
        expect(currencyFromPriceUnit("EUR/MWh")).toBe("EUR");
        expect(currencyFromPriceUnit(null)).toBe("");
    });
});
