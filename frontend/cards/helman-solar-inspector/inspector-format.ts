import { formatEnergyWh, formatMoney, orNa } from "../shared/format";
import { formatClock } from "../shared/time/slot-time";
import { slotToMinutes } from "./chart-soc";
import { CHART_COLORS } from "./chart-colors";
import type { SeriesKey } from "./inspector-day-model";

/**
 * How the inspector words a number: the formatters its chart, its popups and
 * its panels share, so one reading is written the same way wherever it shows.
 */

/** The card's localizer, as everything below takes it. */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * What each series is called, as the localisation key under
 * `bias_correction.inspector`. These are the names the daily totals already
 * use, so a series named anywhere else on the card is named the same way.
 */
const SERIES_LABEL_KEYS: Record<SeriesKey, string> = {
  raw: "raw_forecast",
  corrected: "corrected_forecast",
  actual: "actual_production",
  houseForecast: "house_forecast",
  houseActual: "house_actual",
  batterySocForecast: "battery_soc_forecast",
  batterySocActual: "battery_soc_actual",
  gridForecast: "grid_forecast",
  gridActual: "grid_actual",
  batteryForecast: "battery_forecast",
  batteryActual: "battery_actual",
};

/** Every series name, in one list, for the card's `chart_series` selector. */
export const SERIES_KEYS = Object.keys(SERIES_LABEL_KEYS) as SeriesKey[];

/**
 * The name a series goes by in the totals grid, reused wherever else it has
 * to be named. One lookup rather than a label per call site, so a series
 * cannot end up called two different things in two places.
 */
export function seriesLabel(t: Translate, series: SeriesKey): string {
  return t(`bias_correction.inspector.${SERIES_LABEL_KEYS[series]}`);
}

export function negateWh(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? value : -value;
}

export function formatWh(t: Translate, value: number | null): string {
  return orNa(value, v => formatEnergyWh(v).display, t("bias_correction.inspector.actual_not_available"));
}

export function formatSignedWh(t: Translate, value: number | null): string {
  return orNa(value, v => formatEnergyWh(v, { signed: true }).display, t("bias_correction.inspector.actual_not_available"));
}

export function formatFactor(value: number | null): string {
  return orNa(value, v => v.toFixed(3), "-");
}

export function formatPct(t: Translate, value: number | null): string {
  return orNa(value, v => `${v.toFixed(1)} %`, t("bias_correction.inspector.actual_not_available"));
}

export function formatPrice(t: Translate, value: number | null, unit: string | null): string {
  return orNa(value, v => formatMoney(v, unit ?? ""), t("bias_correction.inspector.actual_not_available"));
}

/**
 * The selection as the time it actually covers — "13:00 – 14:00" rather than the
 * bare start of one slot, so the heading says what span its sums are for. Each
 * slot runs to the next boundary at the active width; adjacent slots merge into
 * one span, and a selection with gaps lists each run, so the label can never
 * imply time that isn't selected. Midnight at the end of the day reads "24:00".
 */
export function formatSlotRange(slots: readonly string[], slotMinutes: number): string {
  const runs: Array<[number, number]> = [];
  for (const slot of slots) {
    const start = slotToMinutes(slot);
    if (start === null) continue;
    const end = start + slotMinutes;
    const last = runs[runs.length - 1];
    if (last && last[1] === start) {
      last[1] = end;
    } else {
      runs.push([start, end]);
    }
  }
  if (runs.length === 0) return slots.join(", ");
  return runs
    .map(([start, end]) => `${formatClock(start)} – ${formatClock(end)}`)
    .join(", ");
}

/**
 * Missing out of expected, with the share it works out to.
 *
 * The percentage is the point of the sentence — a count alone cannot tell a
 * day that lost one reading from one that lost two thirds of them — so a
 * share that rounds to zero is written as "<1" rather than as "0%", which
 * would read as nothing being missing at all on a mark that only exists
 * because something is.
 */
export function formatIncompleteNote(t: Translate, key: string, missing: number, expected: number): string {
  const share = expected > 0 ? (missing / expected) * 100 : 0;
  return t(key, {
    count: missing,
    total: expected,
    percent: share > 0 && share < 1 ? "<1" : String(Math.round(share)),
  });
}

/**
 * "House consumption: missing 2 of 4 readings (50%)", one line per series
 * that is short — shared by the chart's scrim title and the selected-slot
 * panel, so the two ways a reader can find out why a column is marked say the
 * same thing. Which series it is matters as much as how many readings: the
 * same two missing readings are a hole in the bar itself or in the SoC line
 * above it, and the column looks identical either way.
 *
 * `bucketCount` is how many columns the counts cover: one for the scrim,
 * however many the reader has selected for the panel. Without the "of N"
 * the number is unreadable — two missing readings is nearly nothing across
 * a selected afternoon and most of an hour on its own.
 */
export function formatPartialBucketNote(
  t: Translate,
  perSeries: ReadonlyMap<SeriesKey, number>,
  bucketCount: number,
  slotMinutes: number,
  granularityMinutes: number,
): string {
  const perBucket = Math.max(1, Math.round(slotMinutes / granularityMinutes));
  return [...perSeries.entries()]
    .map(([key, missing]) => `${seriesLabel(t, key)}: ${formatIncompleteNote(
      t,
      "bias_correction.inspector.partial_bucket",
      missing,
      bucketCount * perBucket,
    )}`)
    .join("\n");
}

export type FamilyKey = "solar" | "house" | "battery" | "grid" | "batterySoc";

/**
 * Each forecast/actual pair the day view reports, once: what it is called, its
 * colour, the two series it speaks for, which way it is signed on screen (the
 * payload's house, grid and battery series are signed against the chart's
 * stacking, so their tiles negate) and the unit it is read in.
 *
 * The chart's popup and the panels both read it; each lists the families it
 * shows in its own order, which is why this is a table and not a list.
 */
export const FAMILIES: Record<FamilyKey, {
  label: string;
  color: string;
  actual: SeriesKey;
  forecast: SeriesKey;
  sign: 1 | -1;
  unit: "wh" | "pct";
}> = {
  solar: { label: "merged.solar", color: CHART_COLORS.corrected, actual: "actual", forecast: "corrected", sign: 1, unit: "wh" },
  house: { label: "merged.house", color: CHART_COLORS.house, actual: "houseActual", forecast: "houseForecast", sign: -1, unit: "wh" },
  battery: { label: "merged.battery", color: CHART_COLORS.battery, actual: "batteryActual", forecast: "batteryForecast", sign: -1, unit: "wh" },
  grid: { label: "merged.grid", color: CHART_COLORS.grid, actual: "gridActual", forecast: "gridForecast", sign: -1, unit: "wh" },
  batterySoc: {
    label: "merged.battery_soc",
    color: CHART_COLORS.battery,
    actual: "batterySocActual",
    forecast: "batterySocForecast",
    sign: 1,
    unit: "pct",
  },
};
