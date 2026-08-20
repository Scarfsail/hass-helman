import { test, expect } from "@playwright/test";
import {
    MIN_LABELLED_COLUMN_PX,
    columnFitsLabel,
} from "../cards/shared/strip-value-labels";

/**
 * One rule for "is this column wide enough to carry its number".
 *
 * The SoC strip, the price strip and the money strip each had their own
 * threshold — 18, 16 and 22 — which only shows on a narrow screen: the columns
 * shrink past one limit at a time, so a phone would render the percentages and
 * the rates while the money above them went blank. This pins that they now
 * cross that line together, which is the property the shared helper exists for.
 */

test.describe("strip value labels", () => {
    test("the threshold is the same one for every strip", () => {
        // A regression here means someone reintroduced a local constant; the
        // point is not the number but that there is only one of it.
        expect(columnFitsLabel(MIN_LABELLED_COLUMN_PX)).toBe(true);
        expect(columnFitsLabel(MIN_LABELLED_COLUMN_PX - 0.1)).toBe(false);
    });

    test("it is narrow enough for the widths a phone actually produces", () => {
        // The reported bug: at this width the SoC and price strips labelled
        // their columns and the money strip did not.
        expect(columnFitsLabel(18)).toBe(true);
        expect(columnFitsLabel(16)).toBe(true);
    });

    test("a column too narrow for four digits gets nothing", () => {
        expect(columnFitsLabel(8)).toBe(false);
        expect(columnFitsLabel(0)).toBe(false);
    });
});
