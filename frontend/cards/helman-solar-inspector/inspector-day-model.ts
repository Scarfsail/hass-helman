import { slotMinutes } from "../shared/time/slot-time";
import { toAveragePower, type ChartEntry } from "./chart-power";
import { symmetricPowerAxis } from "./chart-axis";
import {
  SLOT_MINUTES,
  lastStackSlot,
  stackTotals,
  toSlotMap,
  type StackLayer,
  type StackSet,
} from "./chart-stack";
import { buildSocBars, slotToMinutes, type SocBar, type SocBoundsPoint } from "./chart-soc";
import { CHART_COLORS } from "./chart-colors";
import type { MoneyPoint, MoneyTotals } from "./money-model";
import type { NavigationRange } from "./inspector-navigation";
import { EMPTY_SELECTED_MINUTES, type ScheduleStripGeometry } from "./strip-geometry";
import {
  resolveSelectedImpactSlot,
  type BatterySocPoint,
  type FactorPoint,
  type HouseBreakdownPoint,
  type ImpactPoint,
  type InspectorPoint,
  type TrainingExplainability,
} from "./solar-inspector-model";
import {
  actualsCoverUntil,
  aggregateBreakdownSeries,
  aggregateImpactSeries,
  aggregateWhSeries,
  dropPartialBuckets,
  missingMinutesByBucket,
  sampleBounds,
  sampleBucketEndOnGrid,
  sampleOnGrid,
  seriesCoverage,
  splitHouseByDeferrable,
  type CoverageSeries,
} from "./slot-aggregation";

/**
 * The inspector's day model: everything the day view draws, derived from the
 * payload by pure functions.
 *
 * Each step takes what it reads as arguments -- the slot width, which series
 * the legend hides (`hidden`) and the config allows (`enabled`), the chart
 * width, the daylight crop -- and returns its result, so the element can
 * memoise every step on exactly those arguments (`../shared/memo-one.ts`) and
 * no step can read a field another one has not finished writing yet.
 */

export const MINUTES_PER_DAY = 1440;

export type SeriesKey =
  | "raw"
  | "corrected"
  | "actual"
  | "houseForecast"
  | "houseActual"
  | "batterySocForecast"
  | "batterySocActual"
  | "gridForecast"
  | "gridActual"
  | "batteryForecast"
  | "batteryActual";

/**
 * The series that stack. The SoC series and the raw forecast are drawn
 * elsewhere and stack nothing, so they are not in here.
 */
type StackedSeriesKey = Extract<
  SeriesKey,
  | "corrected"
  | "actual"
  | "houseForecast"
  | "houseActual"
  | "gridForecast"
  | "gridActual"
  | "batteryForecast"
  | "batteryActual"
>;

/** One rail's sample as the day payload serves it: an `HH:MM` slot and a rate. */
export interface PriceRailPoint {
  slot: string;
  value: number;
}

/** A single price sample placed on the selected day's timeline. */
export interface PriceColumn {
  startMinutes: number;
  endMinutes: number;
  value: number;
}

export type InspectorPayload = {
  date: string;
  timezone: string;
  /**
   * How wide one point of every measured series is: 15 for a day still held in
   * raw recorder states, 60 for one read back from hourly long-term statistics
   * after the recorder purged those states.
   *
   * Optional only for an older backend that predates the field; absent reads as
   * 15, which is what every day was before the statistics source existed.
   */
  dataGranularityMinutes?: number;
  status: string;
  effectiveVariant: string | null;
  trainedAt: string | null;
  range: NavigationRange & {
    canGoPrevious: boolean;
    canGoNext: boolean;
    isToday: boolean;
    isFuture: boolean;
  };
  series: {
    raw: InspectorPoint[];
    corrected: InspectorPoint[];
    actual: InspectorPoint[];
    invalidated: InspectorPoint[];
    factors: FactorPoint[];
    impact: ImpactPoint[];
    houseForecast: InspectorPoint[];
    houseActual: InspectorPoint[];
    houseActualBreakdown: HouseBreakdownPoint[];
    /** The same shape ahead of the clock: the base load plus each scheduled appliance. */
    houseForecastBreakdown: HouseBreakdownPoint[];
    batterySocForecast: BatterySocPoint[];
    batterySocActual: BatterySocPoint[];
    gridForecast: InspectorPoint[];
    gridActual: InspectorPoint[];
    batteryForecast: InspectorPoint[];
    batteryActual: InspectorPoint[];
    /**
     * What the grid charged and paid per slot. Unlike the forecast/actual pairs
     * above, each rail already spans the whole day: the backend joins recorder
     * history behind the clock with the live feed ahead of it.
     */
    importPrice: PriceRailPoint[];
    exportPrice: PriceRailPoint[];
    /**
     * What each slot cost and earned, priced in Python from the two grid
     * directions and the rails above. Drawn series: the actual one stops at the
     * slot in progress, like every other actual, while `totals` below counts it.
     */
    moneyActual: MoneyPoint[];
    moneyForecast: MoneyPoint[];
  };
  totals: {
    rawWh: number | null;
    correctedWh: number | null;
    actualWh: number | null;
    houseForecastWh: number | null;
    houseActualWh: number | null;
    gridForecastWh: number | null;
    gridActualWh: number | null;
    batteryForecastWh: number | null;
    batteryActualWh: number | null;
    /** Null where the day priced nothing for that vintage. */
    moneyActual: MoneyTotals | null;
    moneyForecast: MoneyTotals | null;
  };
  availability: {
    hasProfile: boolean;
  };
  /** Per-slot SoC window the battery is driven within; empty when unconfigured. */
  batterySocBounds: SocBoundsPoint[];
  /** The currency-per-energy unit both price rails are quoted in. */
  priceUnit: string | null;
  trainingExplainability: TrainingExplainability | null;
};

/**
 * The payload at the active slot width, plus both price rails laid out on that
 * grid. Still an {@link InspectorPayload}, so everything that draws a day draws
 * a view.
 */
export type DayView = InspectorPayload & {
  importPriceColumns: readonly PriceColumn[];
  exportPriceColumns: readonly PriceColumn[];
};

/** The two stacks, and the first slot the forecast has to speak for alone. */
export type ChartStacks = { forecast: StackSet; actual: StackSet; fillFromMinutes: number };

export type ChartLayout = {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  plotWidth: number;
  plotHeight: number;
  minKw: number;
  maxKw: number;
  yTicks: number[];
  /** Minute-of-day at the left edge of the plot; 0 unless the day is cropped. */
  dayStartMinutes: number;
  /** Minute-of-day at the right edge of the plot; 1440 unless the day is cropped. */
  dayEndMinutes: number;
  /** Pixel width of one 15-minute slot under the current x scale. */
  slotWidth: number;
  xForMinutes: (m: number) => number;
  yForW: (w: number) => number;
  /** Inverse of `yForW`: the watts a plot-space y coordinate reads as. */
  wForY: (y: number) => number;
};

/**
 * Which native slots the day is short of, and where.
 *
 * `buckets` maps the wider-bucket starts the view draws over a hole in one of
 * its Wh series to how many native slots each short series is missing there --
 * the breakdown, not just a count, because the mark has to name what is
 * missing and not only how much of it. The chart's scrim and the selected-slot
 * panel's caveat both read it, off one computation rather than two that could
 * drift apart.
 *
 * `series` holds the totals series with at least one interior hole anywhere in
 * the day, each with how many readings it is short of the span it covers --
 * independent of the slot width, since a day total is one number for the whole
 * day and cannot be more or less complete depending on how the chart above
 * happens to be drawn.
 */
export type DayCoverage = {
  buckets: Map<number, Map<SeriesKey, number>>;
  series: Map<SeriesKey, { missing: number; expected: number }>;
  /** The native sample width the bucket counts were computed at. */
  granularityMinutes: number;
};

/**
 * Whether the config allows this series at all. The one gate every other
 * visibility question goes through, so a disabled series cannot be reached by
 * the legend, a stack, an axis range or a tile.
 */
export function isSeriesEnabled(enabled: readonly SeriesKey[] | undefined, series: SeriesKey): boolean {
  // An empty list reads as "unset": the multi-select emits `[]` when the last
  // option is unchecked, and a card with no series at all and nothing to say
  // why is worse than the full one.
  if (enabled === undefined || enabled.length === 0) {
    return true;
  }
  return enabled.includes(series);
}

export function isSeriesVisible(
  hidden: ReadonlySet<SeriesKey>,
  enabled: readonly SeriesKey[] | undefined,
  series: SeriesKey,
): boolean {
  return isSeriesEnabled(enabled, series) && !hidden.has(series);
}

/**
 * The narrowest width a payload's data can honestly be drawn at.
 *
 * 15 for anything a backend does not say otherwise about, including one that
 * predates the field: every day was fifteen minutes before the statistics
 * source existed, and reading an absent field as "coarse" would lock a whole
 * card to hourly against an older Helman.
 */
export function payloadGranularity(payload: InspectorPayload | null): number {
  return payload?.dataGranularityMinutes ?? 15;
}

/**
 * Flip a consumption-positive payload series into the chart's sign convention.
 *
 * The payload counts energy leaving the house's demand as positive: the house
 * consuming, the grid taking an export, the battery charging. The chart instead
 * draws whatever *supplies* the house upwards and whatever *draws from it*
 * downwards, so grid import, battery discharge and solar all rise above zero.
 * Solar is production-positive already and needs no flip.
 */
function asSupplyPositive(points: InspectorPoint[]): InspectorPoint[] {
  return points.map((point) => ({ ...point, valueWh: -point.valueWh }));
}

/**
 * One rail's samples bucketed onto the inspector's current slot grid.
 *
 * Both rails use this same grid, which is the point: a cell is split in half
 * to hold one bar per rail, so the two must agree on where cells begin or
 * the halves belong to different spans. Coalescing equal neighbours into
 * natural cells — an hourly export price into one column, a fixed import
 * window into a morning-long one — was tried first and gives each rail its
 * own grid, which draws as a wide backdrop with unrelated bars across it
 * rather than a pair per slot.
 *
 * Density is therefore the slot-size control's business, not the strip's:
 * at 15 minutes the day is 96 narrow pairs, at 60 it is 24 wide ones.
 * Several samples landing in one cell average, a price being a rate rather
 * than a quantity to accumulate.
 */
export function priceColumns(points: readonly PriceRailPoint[], slot: number): PriceColumn[] {
  const cells = new Map<number, { total: number; count: number }>();
  for (const point of points) {
    const value = Number(point.value);
    if (!Number.isFinite(value)) {
      continue;
    }
    const minutes = slotMinutes(point.slot);
    if (minutes === null) {
      continue;
    }
    const start = Math.floor(minutes / slot) * slot;
    const cell = cells.get(start);
    if (cell) {
      cell.total += value;
      cell.count += 1;
    } else {
      cells.set(start, { total: value, count: 1 });
    }
  }
  return [...cells.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([startMinutes, { total, count }]) => ({
      startMinutes,
      endMinutes: Math.min(startMinutes + slot, MINUTES_PER_DAY),
      value: total / count,
    }));
}

/**
 * The payload re-bucketed to the active slot width. Daily totals, availability
 * and the 15-minute training explainability are slot-width independent and
 * carry through untouched; only the time series are collapsed.
 */
export function buildDayView(payload: InspectorPayload, slot: number): DayView {
  const s = payload.series;
  const prices = {
    importPriceColumns: priceColumns(s.importPrice ?? [], slot),
    exportPriceColumns: priceColumns(s.exportPrice ?? [], slot),
  };
  if (slot <= SLOT_MINUTES) return { ...payload, ...prices };
  // A wider bucket is only history once the measurements span all of it; the
  // slot we are still inside would otherwise sum a part-hour of actuals into a
  // full-hour column and read as a collapse against the forecast.
  const coverUntil = actualsCoverUntil(
    [s.actual, s.invalidated, s.houseActual, s.gridActual, s.batteryActual],
    payloadGranularity(payload),
  );
  const measured = (points: InspectorPoint[]) =>
    dropPartialBuckets(aggregateWhSeries(points, slot), slot, coverUntil, (p) =>
      slotMinutes(p.slot));
  return {
    ...payload,
    ...prices,
    series: {
      ...s,
      raw: aggregateWhSeries(s.raw, slot),
      corrected: aggregateWhSeries(s.corrected, slot),
      actual: measured(s.actual),
      invalidated: measured(s.invalidated),
      impact: aggregateImpactSeries(s.impact, slot),
      houseForecast: aggregateWhSeries(s.houseForecast, slot),
      // A bucket the composition only partly covers is kept rather than
      // dropped: on today, a wide bucket straddles elapsed slots — which keep a
      // forecast scalar but leave no composition behind — and the slots from the
      // one in progress on, which have both. Dropping it would leave the bucket
      // the user is looking at as the only one with no composition at all. What
      // the composition does not reach lands in the panel's base row, which is
      // drawn as the residual against the forecast total for exactly this reason.
      houseForecastBreakdown: aggregateBreakdownSeries(s.houseForecastBreakdown, slot),
      houseActual: measured(s.houseActual),
      houseActualBreakdown: dropPartialBuckets(
        aggregateBreakdownSeries(s.houseActualBreakdown, slot),
        slot, coverUntil, (p) => slotToMinutes(p.slot),
      ),
      gridForecast: aggregateWhSeries(s.gridForecast, slot),
      gridActual: measured(s.gridActual),
      batteryForecast: aggregateWhSeries(s.batteryForecast, slot),
      batteryActual: measured(s.batteryActual),
      // The forecast reports the level its slot ends at, so a wider bucket
      // takes its last reading; the actual is an instantaneous reading at the
      // slot start, so its bucket takes the first.
      batterySocForecast: sampleBucketEndOnGrid(s.batterySocForecast, slot),
      batterySocActual: sampleOnGrid(s.batterySocActual, slot),
    },
    batterySocBounds: sampleBounds(payload.batterySocBounds, slot),
  };
}

/**
 * Which native slots the day is short of, and where.
 *
 * Its own step rather than a side effect of the re-bucketing above, because
 * its inputs are not the same: the marks follow the legend, which cannot
 * move a single bucketed sum.
 */
export function dayCoverage(
  payload: InspectorPayload,
  slot: number,
  hidden: ReadonlySet<SeriesKey>,
  enabled: readonly SeriesKey[] | undefined,
): DayCoverage {
  const s = payload.series;
  // Coverage is read off the series as the backend actually served them, not
  // the re-bucketed sums — a hole is a fact about the 15-minute data, and
  // bucketing it first would let a run of present-but-hole-adjacent buckets
  // blur which native slot was actually missing. Every Wh series the day can
  // draw is included so one rule marks forecast and actual columns alike; SoC
  // and impact are levels and ratios, not sums, so a hole in them does not
  // misstate an energy total and is left out. So is `invalidated`, which is not
  // a series that covers the day but a set of annotations on the slots that
  // were thrown out — the slots between two of them are absent because nothing
  // was invalidated there, and reading that as a hole would mark the whole
  // stretch.
  const granularity = payloadGranularity(payload);
  const whSeries: CoverageSeries[] = [
    { key: "raw", points: s.raw },
    { key: "corrected", points: s.corrected },
    { key: "actual", points: s.actual },
    { key: "houseForecast", points: s.houseForecast },
    { key: "houseActual", points: s.houseActual },
    { key: "gridForecast", points: s.gridForecast },
    { key: "gridActual", points: s.gridActual },
    { key: "batteryForecast", points: s.batteryForecast },
    { key: "batteryActual", points: s.batteryActual },
  ];
  return {
    // The scrim marks what the chart is drawing, so a series the legend has
    // switched off cannot mark a column: nothing of it is on screen to be
    // short, and a wash over a column for an invisible reason is worse than no
    // wash at all.
    buckets: missingMinutesByBucket(
      whSeries.filter(({ key }) => isSeriesVisible(hidden, enabled, key as SeriesKey)),
      slot,
      granularity,
    ) as Map<number, Map<SeriesKey, number>>,
    // Independent of `slot` — and of visibility, unlike the scrim above. A
    // hidden series still prints its daily total, and a number on screen has
    // to carry its own caveat whether or not its curve is drawn.
    series: new Map(
      whSeries
        .map(({ key, points }) => [key as SeriesKey, seriesCoverage(points, granularity)] as const)
        .filter(([, coverage]) => coverage.missing.length > 0)
        .map(([key, coverage]) => [key, { missing: coverage.missing.length, expected: coverage.expected }]),
    ),
    granularityMinutes: granularity,
  };
}

/**
 * Whether the day has anything to chart at all. A fact about the payload as
 * served, not the re-bucketed view: a wide bucket can drop the only actuals a
 * day has so far, and that still leaves a day worth drawing.
 */
export function dayHasSeries(payload: InspectorPayload, houseFocus: boolean): boolean {
  const series = payload.series;
  return (series.raw?.length ?? 0) > 0
    || (series.corrected?.length ?? 0) > 0
    || (series.actual?.length ?? 0) > 0
    || (series.invalidated?.length ?? 0) > 0
    || (houseFocus && ((series.houseForecast?.length ?? 0) > 0 || (series.houseActual?.length ?? 0) > 0));
}

/**
 * The two stacks, in the order they build outwards from the zero baseline:
 * solar, battery discharge and grid import above; house, battery charge and
 * grid export below.
 *
 * House is drawn as two bands rather than one, on both sides of now —
 * non-deferrable against the baseline, the shiftable part stacked on top of it
 * in the lighter house shade. Each pair sums to the same house total, so every
 * band above them keeps its place and the day's shape is unchanged; only its
 * subdivision appears.
 *
 * The fill boundary comes with them: the first slot the forecast has to speak
 * for alone, one past the last measured slot. With no actuals at all the
 * forecast fills the whole day. The SoC columns and the popup's
 * actual/forecast split read it, so it is derived here with the stacks rather
 * than by whichever render got there first.
 */
export function buildStacks(
  view: InspectorPayload,
  slot: number,
  hidden: ReadonlySet<SeriesKey>,
  enabled: readonly SeriesKey[] | undefined,
): ChartStacks {
  const series = view.series;
  /** A hidden series yields an empty layer, so toggling it collapses its band. */
  const layer = (
    key: StackedSeriesKey,
    color: string,
    points: InspectorPoint[],
    consumptionPositive: boolean,
  ): StackLayer => {
    if (!isSeriesVisible(hidden, enabled, key)) return { color, values: new Map() };
    const oriented = consumptionPositive ? asSupplyPositive(points) : points;
    return {
      color,
      values: toSlotMap(toAveragePower(oriented, { bucketMinutes: slot })),
    };
  };
  // One helper, one shape, both sides of now: measured demand splits by what
  // the meters say ran, forecast demand by what the planner scheduled.
  const actualSplit = splitHouseByDeferrable(series.houseActual, series.houseActualBreakdown);
  const forecastSplit = splitHouseByDeferrable(series.houseForecast, series.houseForecastBreakdown);
  const solarForecast = layer("corrected", CHART_COLORS.corrected, series.corrected, false);
  const solarActual = layer("actual", CHART_COLORS.actual, series.actual, false);
  // Each family's two bands share one `SeriesKey` and its single legend entry,
  // so hiding house still collapses the pair.
  const houseForecastNonDeferrable = layer("houseForecast", CHART_COLORS.house, forecastSplit.nonDeferrable, true);
  const houseForecastDeferrable = layer("houseForecast", CHART_COLORS.houseDeferrable, forecastSplit.deferrable, true);
  const houseActualNonDeferrable = layer("houseActual", CHART_COLORS.house, actualSplit.nonDeferrable, true);
  const houseActualDeferrable = layer("houseActual", CHART_COLORS.houseDeferrable, actualSplit.deferrable, true);
  const batteryForecast = layer("batteryForecast", CHART_COLORS.battery, series.batteryForecast, true);
  const batteryActual = layer("batteryActual", CHART_COLORS.battery, series.batteryActual, true);
  const gridForecast = layer("gridForecast", CHART_COLORS.grid, series.gridForecast, true);
  const gridActual = layer("gridActual", CHART_COLORS.grid, series.gridActual, true);
  const actual: StackSet = {
    positive: [solarActual, batteryActual, gridActual],
    negative: [houseActualNonDeferrable, houseActualDeferrable, batteryActual, gridActual],
  };
  const lastActual = lastStackSlot(actual);
  return {
    forecast: {
      positive: [solarForecast, batteryForecast, gridForecast],
      negative: [houseForecastNonDeferrable, houseForecastDeferrable, batteryForecast, gridForecast],
    },
    actual,
    fillFromMinutes: lastActual === null ? Number.NEGATIVE_INFINITY : lastActual + slot,
  };
}

/**
 * The hour-aligned span of the day that carries solar production — the first
 * hour any of the raw, corrected or actual solar series reaches the daylight
 * threshold to the hour past the last. Cropping to this window fills the plot
 * with the daylight curve instead of squeezing it between empty night hours on
 * either side. With no solar above the threshold anywhere (a fully clouded
 * winter day, or no forecast yet) it falls back to the whole day so the other
 * series still have somewhere to sit.
 */
function solarWindow(
  payload: InspectorPayload,
  thresholdW: number,
  hidden: ReadonlySet<SeriesKey>,
  enabled: readonly SeriesKey[] | undefined,
): { start: number; end: number } {
  const threshold = Number.isFinite(thresholdW) ? thresholdW : 100;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  // No fixed bucket: infer each series' own sample spacing so the threshold is
  // read against true average watts, whether the series is 15-minute or hourly.
  // Only the solar series actually drawn may crop the day -- drawn, not merely
  // allowed: `raw` is hidden by default, so a card that allowed it and nothing
  // else solar would otherwise crop to solar hours while showing none of them,
  // hiding the hours its visible series live in. The `!isFinite` fallback below
  // already means "show the whole day", which is what no visible solar wants.
  for (const key of ["raw", "corrected", "actual"] as const) {
    if (!isSeriesVisible(hidden, enabled, key)) continue;
    for (const entry of toAveragePower(payload.series[key])) {
      if (entry.powerW < threshold) continue;
      if (entry.minutes < first) first = entry.minutes;
      if (entry.minutes > last) last = entry.minutes;
    }
  }
  if (!Number.isFinite(first) || !Number.isFinite(last)) {
    return { start: 0, end: MINUTES_PER_DAY };
  }
  const start = Math.max(0, Math.floor(first / 60) * 60);
  // `last` is the start of a slot, so include the hour it falls in.
  const end = Math.min(MINUTES_PER_DAY, (Math.floor(last / 60) + 1) * 60);
  return end > start ? { start, end } : { start: 0, end: MINUTES_PER_DAY };
}

export function chartLayout(
  view: InspectorPayload,
  stacks: ChartStacks,
  slot: number,
  width: number,
  daylightOnly: boolean,
  thresholdW: number,
  hidden: ReadonlySet<SeriesKey>,
  enabled: readonly SeriesKey[] | undefined,
): ChartLayout {
  const height = 260;
  const margin = { top: 18, right: 24, bottom: 34, left: 48 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  const powerFor = (series: SeriesKey, entries: ChartEntry[]) =>
    isSeriesVisible(hidden, enabled, series) ? entries.map((e) => e.powerW) : [];
  const invalidatedPoints = toAveragePower(view.series.invalidated, { bucketMinutes: slot });
  // The stacks decide the axis: a band's outer edge is the sum beneath it, so
  // the tallest slot total is what has to fit, not the tallest single series.
  const allPower = [
    ...powerFor("raw", toAveragePower(view.series.raw)),
    ...powerFor("actual", invalidatedPoints),
    ...stackTotals(stacks.forecast),
    ...stackTotals(stacks.actual),
  ];
  // Every watt supplied is a watt consumed, so the two stacks are mirror
  // images and the axis has to be too: a slot that reaches 3 kW of production
  // reaches 3 kW of consumption. One bound serves both directions.
  const peakW = Math.max(1000, ...allPower.map((w) => Math.abs(w)));
  const { maxKw, yTicks } = symmetricPowerAxis(peakW);
  const minKw = -maxKw;
  const spanW = (maxKw - minKw) * 1000;
  const { start: dayStartMinutes, end: dayEndMinutes } = daylightOnly
    ? solarWindow(view, thresholdW, hidden, enabled)
    : { start: 0, end: MINUTES_PER_DAY };
  const daySpan = dayEndMinutes - dayStartMinutes;
  const slotWidth = (plotWidth * slot) / daySpan;
  const xForMinutes = (minutes: number) =>
    margin.left + ((minutes - dayStartMinutes) / daySpan) * plotWidth;
  const yForW = (powerW: number) =>
    margin.top + plotHeight - ((powerW - minKw * 1000) / spanW) * plotHeight;
  const wForY = (y: number) =>
    minKw * 1000 + ((margin.top + plotHeight - y) / plotHeight) * spanW;

  return {
    width, height, margin, plotWidth, plotHeight, minKw, maxKw, yTicks,
    dayStartMinutes, dayEndMinutes, slotWidth, xForMinutes, yForW, wForY,
  };
}

/** The x scale the strips under the chart share, off one layout. */
export function stripGeometry(layout: ChartLayout): ScheduleStripGeometry {
  return {
    width: layout.width,
    marginLeft: layout.margin.left,
    plotWidth: layout.plotWidth,
    startMinutes: layout.dayStartMinutes,
    endMinutes: layout.dayEndMinutes,
  };
}

/** The columns of the SoC strip: measured where measured, forecast beyond. */
export function socBars(
  view: InspectorPayload,
  hidden: ReadonlySet<SeriesKey>,
  enabled: readonly SeriesKey[] | undefined,
  fillFromMinutes: number,
): SocBar[] {
  const actual = isSeriesVisible(hidden, enabled, "batterySocActual") ? view.series.batterySocActual : [];
  const forecast = isSeriesVisible(hidden, enabled, "batterySocForecast")
    ? view.series.batterySocForecast
    : [];
  return buildSocBars(actual, forecast, fillFromMinutes);
}

/** Minute-of-day of every selected slot, for the strips' bands. */
export function selectedMinutes(view: InspectorPayload, selectedSlots: readonly string[]): readonly number[] {
  const minutes: number[] = [];
  for (const slot of selectedSlots) {
    const resolved = resolveSelectedImpactSlot(view.series.impact, slot);
    const value = resolved === null ? null : slotToMinutes(resolved);
    if (value !== null) {
      minutes.push(value);
    }
  }
  return minutes.length === 0 ? EMPTY_SELECTED_MINUTES : minutes;
}
