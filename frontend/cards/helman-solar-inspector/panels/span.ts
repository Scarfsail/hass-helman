import { html } from "lit";
import { NEUTRAL_COLOR, nodeAccentColor } from "../../color-utils";
import type { BucketSourceMix } from "../../shared/power-history-bars";
import { CHART_COLORS } from "../chart-colors";
import type { SpanAggregateRow } from "../helman-solar-aggregate-chart";
import { MINUTES_PER_DAY } from "../inspector-day-model";
import { formatWh } from "../inspector-format";
import { sumMoney, type MoneyPoint, type MoneyTotals } from "../money-model";
import { aggregateBreakdownOverSlots } from "../slot-aggregation.js";
import type { HouseBreakdownPoint } from "../solar-inspector-model.js";
import { renderBreakdownPanel, type BreakdownGroups } from "./breakdown";
import { renderMetric, type PanelContext } from "./metrics";

/**
 * The aggregate views' two panels: the selected buckets, and the whole span.
 *
 * Both list the same meters in the same order -- the chart's own order and
 * colours -- and differ in one row: the selection says how low the battery got
 * and how high it came back, the span does not.
 */

/**
 * What the selected buckets came to, headed by the buckets themselves.
 *
 * The day view's panel over a coarser grid: every figure is summed across the
 * selection, exactly as the day view's selection panel sums its series, and
 * the heading names the whole selection rather than one column. There is no
 * control to open a bucket -- the width toggle carries the focus bucket into
 * the finer view in both directions, so a second path to the same place would
 * be a second thing to keep in step.
 */
export function renderSelectedBucket(
  ctx: PanelContext,
  groups: BreakdownGroups,
  selected: readonly SpanAggregateRow[],
  options: { heading: string; currency: string; bucket: "day" | "month" },
) {
  if (selected.length === 0) return "";
  return html`
    <div class="metrics-section selection-section">
      <strong>${options.heading}</strong>
      <div class="metric-grid">${renderSpanMetrics(ctx, selected, options.currency, { socRange: true })}</div>
    </div>
    ${renderBucketHouseBreakdown(ctx, groups, selected, options.bucket)}
  `;
}

/** What the whole span came to, summed from the buckets already on screen. */
export function renderSpanTotals(ctx: PanelContext, rows: readonly SpanAggregateRow[], currency: string) {
  return html`
    <div class="metrics-section">
      <strong>${ctx.t("bias_correction.inspector.span_totals")}</strong>
      <div class="metric-grid">${renderSpanMetrics(ctx, rows, currency, { socRange: false })}</div>
    </div>
  `;
}

/**
 * The span pair's meters, in the chart's own order and colours. `socRange`
 * adds the battery's range after its two flows; a bucket the battery reported
 * no bounds for drops the row rather than claiming one.
 */
function renderSpanMetrics(
  ctx: PanelContext,
  rows: readonly SpanAggregateRow[],
  currency: string,
  options: { socRange: boolean },
) {
  const t = ctx.t;
  const sum = (read: (row: SpanAggregateRow) => number | null) => formatWh(t, sumBuckets(rows, read));
  const kwhSum = (read: (row: SpanAggregateRow) => number | null) => {
    const total = sumBuckets(rows, read);
    return formatWh(t, total === null ? null : total * 1000);
  };
  // Summed through `sumMoney` over every bucket handed in, so the span's money
  // and a single bucket's follow one rule -- the same one the day view's
  // selection follows.
  const money = spanMoney(rows, rows.map((row) => row.date));
  const socRange = options.socRange ? formatSocRange(rows) : null;
  return html`
    ${renderMetric(ctx, t("bias_correction.inspector.merged.solar"), sum((row) => row.solarWh), CHART_COLORS.corrected)}
    ${renderMetric(ctx, t("bias_correction.inspector.merged.house"), sum((row) => row.houseWh), CHART_COLORS.house)}
    ${renderMetric(ctx, t("bias_correction.inspector.grid_import"), kwhSum((row) => row.gridImportKwh), CHART_COLORS.gridImport)}
    ${renderMetric(ctx, t("bias_correction.inspector.grid_export"), kwhSum((row) => row.gridExportKwh), CHART_COLORS.gridExport)}
    ${renderMetric(ctx, t("bias_correction.inspector.battery_charge"), sum((row) => row.batteryChargeWh), CHART_COLORS.battery)}
    ${renderMetric(ctx, t("bias_correction.inspector.battery_discharge"), sum((row) => row.batteryDischargeWh), CHART_COLORS.battery)}
    ${socRange === null
      ? ""
      : renderMetric(ctx, t("bias_correction.inspector.soc_range"), socRange, CHART_COLORS.battery)}
    ${renderMetric(ctx, t("bias_correction.inspector.import_cost"), formatSpanMoney(money?.cost ?? null, currency), CHART_COLORS.gridImport)}
    ${renderMetric(ctx, t("bias_correction.inspector.export_gain"), formatSpanMoney(money?.gain ?? null, currency), CHART_COLORS.gridExport)}
    ${renderMetric(ctx, t("bias_correction.inspector.net_cost"), formatSpanMoney(money?.net ?? null, currency), NEUTRAL_COLOR)}
  `;
}

/**
 * What the house was doing over the selected buckets.
 *
 * The same panel the day view opens for a slot selection, over the same boxes
 * and the same base/shiftable groups -- a day column at D itemises the
 * appliances that day's slots itemise at 60, and to the same total. Only the
 * bars are coarser: one per selected bucket rather than one per native sample,
 * because hourly statistics are the finest grain the span read has and a bar
 * per hour of a day column would be a far heavier read for a shape the next
 * stop of the toggle already draws.
 *
 * Actual only. The panel's forecast variant compares scheduled appliances
 * against a house forecast, and a span payload is measured history end to end.
 */
function renderBucketHouseBreakdown(
  ctx: PanelContext,
  groups: BreakdownGroups,
  rows: readonly SpanAggregateRow[],
  bucket: "day" | "month",
) {
  // The selection in draw order, which is the order the bars are read in.
  const keys = rows.map((row) => row.date);
  // Bucket-keyed breakdown points, in the shape the day view's own helpers
  // parse: `slot` is an opaque key to all of them, so a bucket date does the
  // job a "HH:MM" does there.
  const series: HouseBreakdownPoint[] = [];
  const mixes = new Map<string, BucketSourceMix>();
  for (const row of rows) {
    const breakdown = row.houseBreakdown;
    if (!breakdown) continue;
    series.push({
      slot: row.date,
      unmeasuredWh: breakdown.unmeasuredWh,
      appliances: breakdown.appliances,
    });
    if (row.houseSourceMix) {
      const sm = row.houseSourceMix;
      const mix: BucketSourceMix = {};
      if (sm.solar > 0) mix.solar = { power: sm.solar, color: nodeAccentColor("solar") };
      if (sm.battery > 0) mix.battery = { power: sm.battery, color: nodeAccentColor("battery") };
      if (sm.grid > 0) mix.grid = { power: sm.grid, color: nodeAccentColor("grid") };
      if (sm.unattributed > 0) {
        mix.unattributed = { power: sm.unattributed, color: nodeAccentColor("unattributed") };
      }
      if (Object.keys(mix).length > 0) mixes.set(row.date, mix);
    }
  }
  const breakdown = aggregateBreakdownOverSlots(series, keys);
  if (!breakdown) return "";
  return renderBreakdownPanel(ctx, groups, {
    breakdown,
    barSlots: keys,
    breakdownSeries: series,
    mixes,
    variant: "actual",
    // A bar is a whole bucket wide. A month is not a fixed number of days, so
    // this is the nominal width the power card labels its bars with rather
    // than a claim about any particular month.
    barSeconds: (bucket === "month" ? 30 : 1) * MINUTES_PER_DAY * 60,
    unmeasuredFor: null,
  });
}

/**
 * One meter summed over a set of buckets.
 *
 * Null unless some bucket in the set actually measured it: a set of buckets
 * the meter has no reading for totals to "nothing known", not to zero. The
 * same rule both panels follow, which is why they sum through this rather than
 * through a local copy each.
 */
function sumBuckets(
  rows: readonly SpanAggregateRow[],
  read: (row: SpanAggregateRow) => number | null,
): number | null {
  let total: number | null = null;
  for (const row of rows) {
    const value = read(row);
    if (value === null || !Number.isFinite(value)) continue;
    total = (total ?? 0) + value;
  }
  return total;
}

/**
 * The span's money as `MoneyPoint`s keyed by bucket.
 *
 * `sumMoney` matches a point's `slot` against a set of keys and never parses
 * it, so a `YYYY-MM-DD` bucket key stands in for an `HH:MM` slot label with no
 * change to the model -- which is why the aggregate views sum money through
 * the same function the day view's selection does rather than growing a second
 * one that could disagree with it.
 *
 * A bucket the backend could price neither side of is left out entirely, so
 * "no priced bucket in the selection" stays distinguishable from "priced, and
 * it came to nothing". A bucket priced on only one side carries its null
 * through unchanged: `sumMoney` skips the unpriced direction and reports it
 * as unknown, which is the same rule the day view's slots follow.
 */
function spanMoneyPoints(rows: readonly SpanAggregateRow[]): MoneyPoint[] {
  const points: MoneyPoint[] = [];
  for (const row of rows) {
    const cost = Number.isFinite(row.moneyCost as number) ? (row.moneyCost as number) : null;
    const gain = Number.isFinite(row.moneyGain as number) ? (row.moneyGain as number) : null;
    if (cost === null && gain === null) continue;
    points.push({ slot: row.date, cost, gain });
  }
  return points;
}

/**
 * The three money figures over a set of buckets, each independently nullable.
 *
 * The backend reserves `null` for "this side could not be priced" and says so
 * in as many words -- an export entity with no statistics earns `moneyGain:
 * null`, because "earned nothing" is a claim the data does not support. A
 * side is a figure here only if some bucket in the selection actually priced
 * it; otherwise it stays null and renders as an em dash.
 *
 * The net follows both: subtracting an unknown gain from a known cost would
 * restate the whole import bill as what the grid came to, which is the same
 * unsupported claim wearing a different label. In a healthy setup neither side
 * is ever null -- a working export meter on a day that exported nothing prices
 * a real 0.00 -- so this costs the ordinary reader nothing.
 *
 * All of which `sumMoney` now does, for the day view's slots and these buckets
 * alike; the only thing left here is the difference between a selection with
 * no priced bucket in it and a bucket that priced nothing, which the span
 * views render as no panel rather than as three em dashes.
 */
export function spanMoney(
  rows: readonly SpanAggregateRow[],
  keys: readonly string[],
): MoneyTotals | null {
  const points = spanMoneyPoints(rows);
  const wanted = new Set(keys);
  if (!points.some((point) => wanted.has(point.slot))) return null;
  return sumMoney(points, keys);
}

/** Missing money is an em dash, matching the day view's own money rail. */
export function formatSpanMoney(value: number | null, currency: string): string {
  if (value === null || !Number.isFinite(value)) {
    return "—";
  }
  return `${value.toFixed(2)} ${currency}`.trim();
}

/**
 * How low the battery got and how high it came back, over a set of buckets.
 *
 * Both bounds or nothing, per bucket: half a range is not a range, and writing
 * the known end alone would read as a battery that sat still. Same rule the
 * chart's SoC row draws by.
 */
export function formatSocRange(rows: readonly SpanAggregateRow[]): string | null {
  let low: number | null = null;
  let high: number | null = null;
  for (const row of rows) {
    const min = row.batteryMinSocPct;
    const max = row.batteryMaxSocPct;
    if (min === null || max === null) continue;
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
    // The lowest low and the highest high, which is what a range over several
    // buckets is: how low the battery got at all, and how high it came back.
    // Averaging the bounds would invent a range no day actually had.
    const bottom = Math.min(min, max);
    const top = Math.max(min, max);
    low = low === null ? bottom : Math.min(low, bottom);
    high = high === null ? top : Math.max(high, top);
  }
  if (low === null || high === null) return null;
  return `${low.toFixed(0)}–${high.toFixed(0)} %`;
}
