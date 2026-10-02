import { NEUTRAL_COLOR, NEUTRAL_LIGHT_COLOR } from "../color-utils";

/**
 * The device reports' one ordered device palette.
 *
 * A device takes the colour at its rank in the period's ranking, so it keeps
 * one colour in every column of a report and in every report that colours
 * devices. The hues stay clear of the source colours (solar, grid, battery)
 * the Ranking report paints energy with, so a device is never read as a
 * source. What is not a device takes the neutrals from color-utils.
 */
export const DEVICE_PALETTE: readonly string[] = Object.freeze([
    "#6366f1", // indigo-500
    "#f97316", // orange-500
    "#14b8a6", // teal-500
    "#ec4899", // pink-500
    "#a855f7", // purple-500
    "#b91c1c", // red-700
    "#84cc16", // lime-500
    "#0e7490", // cyan-700
    "#a16207", // yellow-700
    "#fdba74", // orange-300
]);

/** The devices folded together beyond the ones shown. */
export const OTHER_DEVICES_COLOR = NEUTRAL_COLOR;

/** Energy the house meter measured that no device did. */
export const UNMEASURED_COLOR = NEUTRAL_LIGHT_COLOR;

/** The colour of the device at `rank` (0-based) in the period's ranking. */
export function deviceColor(rank: number): string {
    return DEVICE_PALETTE[rank % DEVICE_PALETTE.length];
}
