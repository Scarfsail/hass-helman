import { test, expect } from "@playwright/test";
import {
    hourAnchorOffset,
    selectLabelledColumns,
    MIN_LABELLED_COLUMN_PX,
    type LabelCandidate,
} from "../cards/shared/strip-value-labels";

/**
 * The rule every labelled column in the inspector and the day band goes through.
 *
 * The property that matters most is the one the old boolean gate broke: a row
 * of numbers never empties, however narrow the columns get. The rest is what
 * makes the surviving set readable — no two labels closer than the width they
 * need, the peaks kept where a series has peaks, an evenly spaced set where it
 * does not, and no repeat written twice.
 *
 * The module is pure and imports nothing from lit but `svg`, so it is exercised
 * directly rather than through the card bundle.
 */

const kept = (flags: readonly boolean[]) =>
    flags.flatMap((flag, index) => flag ? [index] : []);

const series = (values: readonly (number | null)[]): LabelCandidate[] =>
    values.map((value) => value === null
        ? { value: null, text: null }
        : { value, text: value.toFixed(1) });

/** A run of values with no two adjacent alike, so nothing is dropped as a repeat. */
const ramp = (count: number) => series(Array.from({ length: count }, (_, i) => i));

test.describe("selectLabelledColumns", () => {
    test("labels every column when they are wide enough", () => {
        const flags = selectLabelledColumns(ramp(8), { columnWidthPx: 40 });
        expect(kept(flags)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    test("never empties a row, however narrow the columns", () => {
        for (const width of [8, 4, 2, 1, 0.5]) {
            const flags = selectLabelledColumns(ramp(96), { columnWidthPx: width });
            expect(kept(flags).length, `width ${width}`).toBeGreaterThan(0);
        }
    });

    test("more width means at least as many labels", () => {
        const counts = [2, 3, 4, 6, 8, 12, 20, 40].map((width) =>
            kept(selectLabelledColumns(ramp(48), { columnWidthPx: width })).length);
        for (let i = 1; i < counts.length; i += 1) {
            expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
        }
        expect(counts[counts.length - 1]).toBe(48);
    });

    test("kept labels are never closer than the width they need", () => {
        const width = 4;
        const stride = Math.ceil(MIN_LABELLED_COLUMN_PX / width);
        const indices = kept(selectLabelledColumns(
            series([0, 9, 1, 2, 3, 8, 2, 1, 0, 7, 3, 2, 1, 6, 2, 0]),
            { columnWidthPx: width },
        ));
        for (let i = 1; i < indices.length; i += 1) {
            expect(indices[i] - indices[i - 1]).toBeGreaterThanOrEqual(stride);
        }
    });

    test("a peaky series keeps its peak", () => {
        const flags = selectLabelledColumns(
            series([1, 1.1, 1.2, 1.3, 9, 1.4, 1.5, 1.6, 1.7]),
            { columnWidthPx: 4 },
        );
        expect(kept(flags)).toContain(4);
    });

    test("the two ends always survive", () => {
        const indices = kept(selectLabelledColumns(
            series([1, 2, 3, 9, 3, 2, 1, 2, 3]),
            { columnWidthPx: 4 },
        ));
        expect(indices[0]).toBe(0);
        expect(indices[indices.length - 1]).toBe(8);
    });

    test("a sawtooth falls back to an evenly spaced set", () => {
        const sawtooth = series(Array.from({ length: 24 }, (_, i) => i % 2 === 0 ? 0 : 5));
        const indices = kept(selectLabelledColumns(sawtooth, { columnWidthPx: 4 }));
        const stride = Math.ceil(MIN_LABELLED_COLUMN_PX / 4);
        expect(indices).toEqual(indices.map((_, i) => indices[0] + i * stride));
    });

    test("anchorOffset lands the evenly spaced set where the caller wants it", () => {
        const sawtooth = series(Array.from({ length: 24 }, (_, i) => i % 2 === 0 ? 0 : 5));
        const stride = Math.ceil(MIN_LABELLED_COLUMN_PX / 4);
        const indices = kept(selectLabelledColumns(
            sawtooth,
            { columnWidthPx: 4, anchorOffset: 2 },
        ));
        expect(indices[0]).toBe(2 % stride);
    });

    test("a repeated value is written once, even at full width", () => {
        const flags = selectLabelledColumns(series([3, 3, 3, 4, 4, 3]), { columnWidthPx: 40 });
        expect(kept(flags)).toEqual([0, 3, 5]);
    });

    test("a column with nothing to say takes no slot from its neighbours", () => {
        const withGaps = series([0, null, null, null, 1, null, null, null, 2]);
        const flags = selectLabelledColumns(withGaps, { columnWidthPx: 4 });
        expect(kept(flags)).toEqual([0, 4, 8]);
    });

    test("an unmeasured column width labels everything", () => {
        expect(kept(selectLabelledColumns(ramp(40), { columnWidthPx: 0 })).length).toBe(40);
    });

    test("minLabelWidthPx lets a caller with shorter labels stay denser", () => {
        const narrow = kept(selectLabelledColumns(ramp(48), { columnWidthPx: 8 })).length;
        const denser = kept(selectLabelledColumns(
            ramp(48),
            { columnWidthPx: 8, minLabelWidthPx: 8 },
        )).length;
        expect(denser).toBeGreaterThan(narrow);
    });

    // The evenly spaced branch used to sieve `index % stride === offset` over
    // column indices, which the candidates -- only the columns with something
    // to say -- can miss entirely or hit far more sparsely than the width asks.
    test("a sparse busy series still gets labels, wherever its candidates fall", () => {
        // Three adjacent readings in a 96-column day, shaped so the row counts
        // as busy: the old lattice landed on none of them.
        const sparse: LabelCandidate[] = Array.from({ length: 96 }, () => ({ value: null, text: null }));
        [9, 10, 11].forEach((index, i) => {
            sparse[index] = { value: [1, 9, 2][i], text: `${[1, 9, 2][i]}` };
        });
        expect(kept(selectLabelledColumns(sparse, { columnWidthPx: 4 })).length).toBeGreaterThan(0);
    });

    test("candidates on their own lattice thin by the stride, not by its multiple", () => {
        // A sawtooth on every fourth column: with stride 5 a modulo sieve keeps
        // one in twenty, where one in five is what the width allows.
        const columns: LabelCandidate[] = Array.from({ length: 80 }, (_, index) =>
            index % 4 === 0
                ? { value: (index / 4) % 2 === 0 ? 0 : 5, text: `${(index / 4) % 2}` }
                : { value: null, text: null });
        const indices = kept(selectLabelledColumns(columns, { columnWidthPx: 3.2 }));
        expect(indices.length).toBeGreaterThan(80 / 20);
        for (let i = 1; i < indices.length; i += 1) {
            expect(indices[i] - indices[i - 1]).toBeGreaterThanOrEqual(5);
        }
    });

    test("an anchor past every candidate does not empty the row", () => {
        const columns = series([0, 5, 0, 5, 0, 5]);
        expect(kept(selectLabelledColumns(columns, { columnWidthPx: 4, anchorOffset: 99 })).length)
            .toBeGreaterThan(0);
    });

    test("a blank between two equal values breaks the repeat", () => {
        const flags = selectLabelledColumns(
            [
                { value: 1, text: "1.0" },
                { value: null, text: null },
                { value: 1, text: "1.0" },
            ],
            { columnWidthPx: 40 },
        );
        expect(kept(flags)).toEqual([0, 2]);
    });

    test("an empty column list selects nothing and does not throw", () => {
        expect(selectLabelledColumns([], { columnWidthPx: 4 })).toEqual([]);
    });
});

test.describe("hourAnchorOffset", () => {
    test("finds the first column landing on a whole hour", () => {
        expect(hourAnchorOffset([15, 30, 45, 60, 75])).toBe(3);
        expect(hourAnchorOffset([0, 15, 30])).toBe(0);
    });

    test("falls back to the first column when no whole hour is in the window", () => {
        expect(hourAnchorOffset([15, 30, 45])).toBe(0);
        expect(hourAnchorOffset([])).toBe(0);
    });
});
