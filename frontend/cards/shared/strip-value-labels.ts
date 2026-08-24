import { svg } from "lit";

/**
 * The value written on a column, wherever the inspector writes one.
 *
 * The SoC strip's percentages, the price strip's two rates and the money
 * strip's cost and gain are the same thing drawn three times: a number centred
 * on a column, small enough to sit inside the chart, dropped when its column
 * gets too narrow to hold the digits without running into its neighbour.
 *
 * They had drifted to three different width thresholds — 18, 16 and 22 — which
 * is only visible on a narrow screen, where the columns shrink past one limit
 * at a time and the strips stop agreeing about whether a day is labelled. One
 * rule here means they cross that line together.
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

/** Whether a column of this width has room for its value. */
export function columnFitsLabel(width: number): boolean {
    return width >= MIN_LABELLED_COLUMN_PX;
}

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
