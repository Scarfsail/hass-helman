import { svg } from "lit";

/**
 * The value written on a column, wherever the inspector writes one.
 *
 * The SoC strip's percentages, the price strip's two rates and the money
 * strip's cost and gain are the same thing drawn three times: a number centred
 * on a column, small enough to sit inside the chart, thinned out when the
 * columns get too narrow to hold every one of them side by side.
 *
 * They had drifted to three different width thresholds — 18, 16 and 22 — which
 * is only visible on a narrow screen, where the columns shrink past one limit
 * at a time and the strips stop agreeing about whether a day is labelled. One
 * rule here — {@link selectLabelledColumns} — means they thin together.
 */

/**
 * Narrowest column, in viewBox units, that still gets its number.
 *
 * Sized for the longest label any of these strips writes — four characters,
 * "100%" or a two-decimal rate — at {@link STRIP_LABEL_FONT_SIZE}. Below it the
 * digits would overrun the column and collide with the neighbouring value.
 */
export const MIN_LABELLED_COLUMN_PX = 16;

export const STRIP_LABEL_FONT_SIZE = 9;


/**
 * One column's value label.
 *
 * `ink` names the colour to draw in, for a label that sits on a filled bar and
 * has to contrast with it; the default is the ordinary secondary text colour,
 * for a label written on the plot itself. `weight` goes bold for the on-fill
 * case, where the digits need to hold their own against a saturated colour.
 */
export function stripValueLabel(options: {
    x: number;
    y: number;
    text: string;
    ink?: string;
    bold?: boolean;
}) {
    const { x, y, text, ink = "var(--secondary-text-color)", bold = false } = options;
    return svg`
        <text
            x=${x} y=${y}
            text-anchor="middle"
            font-size=${STRIP_LABEL_FONT_SIZE}
            font-weight=${bold ? "600" : "normal"}
            fill=${ink}
            pointer-events="none"
        >${text}</text>
    `;
}

/** One column offered to {@link selectLabelledColumns}. */
export interface LabelCandidate {
    /** What the label says; null when there is nothing to write on this column. */
    text: string | null;
    /** The number behind the text, which decides how interesting the column is. */
    value: number | null;
}

/**
 * Which columns get their number, when not all of them can.
 *
 * A row of values that vanishes wholesale on a narrow screen tells the reader
 * less than a thinned row does, so this never answers "none": it picks the
 * widest-spaced subset that still fits, and only the spacing changes with the
 * width. Returns one flag per column, so each caller keeps its own positioning,
 * colouring and formatting and only asks whether to draw.
 *
 * Repeats are dropped at every width, narrow or not. A run of identical numbers
 * is noise the bars already carry, and writing it out three times says nothing
 * the first one did not.
 *
 * Which columns survive the thinning is decided by prominence -- a peak or a
 * trough is the reading worth keeping -- except on a series with more turning
 * points than label slots, where "the interesting ones" is every column and
 * choosing among them is arbitrary. There the labels fall back to an evenly
 * spaced set, which at least reads as a grid; `anchorOffset` is how a caller on
 * a time axis lands that set on whole hours rather than wherever index 0 fell.
 */
export function selectLabelledColumns(
    columns: readonly LabelCandidate[],
    options: { columnWidthPx: number; minLabelWidthPx?: number; anchorOffset?: number },
): boolean[] {
    const minWidth = options.minLabelWidthPx ?? MIN_LABELLED_COLUMN_PX;
    const flags = columns.map(() => false);

    // A column with nothing to say is not a candidate, and must not consume a
    // slot either -- a gap in the data would otherwise thin its neighbours.
    const candidates: number[] = [];
    let lastText: string | null = null;
    columns.forEach((column, index) => {
        if (column.text === null || column.value === null) {
            // A blank breaks the run: two equal numbers with unlabelled columns
            // between them are not a repeat, because nothing carried the value
            // across the gap for the reader to still have it.
            lastText = null;
            return;
        }
        if (column.text === lastText) {
            return;
        }
        lastText = column.text;
        candidates.push(index);
    });

    const stride = options.columnWidthPx > 0
        ? Math.max(1, Math.ceil(minWidth / options.columnWidthPx))
        : 1;
    if (stride === 1) {
        for (const index of candidates) flags[index] = true;
        return flags;
    }

    if (candidates.length === 0) {
        return flags;
    }

    if (_tooBusyForProminence(columns, candidates, stride)) {
        for (const index of _evenlySpaced(candidates, stride, options.anchorOffset ?? 0)) {
            flags[index] = true;
        }
        return flags;
    }

    // Highest prominence first, each taken label blocking the columns within a
    // stride of it. Ties break on the lower index so the same data always
    // labels the same columns.
    const taken: number[] = [];
    const ranked = candidates
        .map((index, rank) => ({ index, score: _prominence(columns, candidates, rank) }))
        .sort((a, b) => (b.score - a.score) || (a.index - b.index));
    for (const { index } of ranked) {
        if (taken.some((other) => Math.abs(other - index) < stride)) {
            continue;
        }
        taken.push(index);
        flags[index] = true;
    }
    return flags;
}

/**
 * An evenly spaced set of candidates, anchored where the caller asked.
 *
 * Stepped from the anchor rather than sieved with `index % stride === offset`:
 * the candidates are not every column -- a strip labels only the columns that
 * have something to say -- so a lattice over *column* indices can miss them
 * altogether and come back empty, and where it does hit them it hits every
 * `lcm(gap, stride)` rather than every `stride`, leaving a row far emptier than
 * its width called for. Stepping keeps it as dense as the columns allow however
 * the gaps happen to fall.
 */
function _evenlySpaced(candidates: readonly number[], stride: number, anchor: number): number[] {
    // The first anchored position at or after the first candidate, so the set
    // lands on whole hours when the caller named one and the columns reach it.
    const start = candidates[0] + (((anchor - candidates[0]) % stride) + stride) % stride;
    const taken: number[] = [];
    for (const index of candidates) {
        const previous = taken[taken.length - 1];
        if (taken.length === 0 ? index < start : index - previous < stride) {
            continue;
        }
        taken.push(index);
    }
    // The anchor can sit past every candidate. A row is never emptied for it.
    return taken.length > 0 ? taken : [candidates[0]];
}

/**
 * How far a candidate stands out from the line drawn between its neighbours.
 *
 * The two ends score infinite: whatever the shape of the series, a row of
 * numbers that starts and stops short of its own edges reads as truncated.
 */
function _prominence(
    columns: readonly LabelCandidate[],
    candidates: readonly number[],
    rank: number,
): number {
    if (rank === 0 || rank === candidates.length - 1) {
        return Number.POSITIVE_INFINITY;
    }
    const value = columns[candidates[rank]].value!;
    const previous = columns[candidates[rank - 1]].value!;
    const next = columns[candidates[rank + 1]].value!;
    return Math.abs(value - (previous + next) / 2);
}

/** More turning points than the row has room for labels: prominence means nothing. */
function _tooBusyForProminence(
    columns: readonly LabelCandidate[],
    candidates: readonly number[],
    stride: number,
): boolean {
    let extrema = 0;
    for (let rank = 1; rank < candidates.length - 1; rank += 1) {
        const previous = columns[candidates[rank - 1]].value!;
        const value = columns[candidates[rank]].value!;
        const next = columns[candidates[rank + 1]].value!;
        if ((value - previous) * (next - value) < 0) {
            extrema += 1;
        }
    }
    return extrema > Math.floor(candidates.length / stride);
}

/**
 * Where the evenly spaced set should start, for a strip whose columns are times.
 *
 * Labels landing on whole hours read as a clock; the same labels landing on
 * :07 and :22 read as an accident.
 */
export function hourAnchorOffset(minutesOfDay: readonly number[]): number {
    const index = minutesOfDay.findIndex((minutes) => minutes % 60 === 0);
    return index < 0 ? 0 : index;
}
