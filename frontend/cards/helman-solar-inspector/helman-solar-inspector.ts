import { LitElement, css, html, svg } from "lit";
import { property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../../hass-frontend/src/types";
import { toAveragePower, type ChartEntry } from "./chart-power";
import { symmetricPowerAxis } from "./chart-axis";
import {
  SLOT_MINUTES,
  accumulateBands,
  bandRuns,
  lastStackSlot,
  stackSlots,
  stackTotals,
  toSlotMap,
  type StackBand,
  type StackLayer,
  type StackSet,
} from "./chart-stack";
import { BATT_COLOR, GRID_COLOR, SOLAR_COLOR } from "../color-utils";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import {
  findImpactForSlot,
  findPointForSlot,
  findTrainingSlot,
  resolveSelectedTrainingDate,
  resolveSelectedImpactSlot,
  findHouseForecastForSlot,
  findHouseActualForSlot,
  findBatterySocForecastForSlot,
  findBatterySocActualForSlot,
  type BatterySocPoint,
  type FactorPoint,
  type ImpactPoint,
  type InspectorPoint,
  type TrainingExplainability,
  type TrainingSlotExplainability,
  type ContributionRow,
} from "./solar-inspector-model.js";

const CHART_COLORS = {
  raw:            '#64748b',
  corrected:      SOLAR_COLOR,
  actual:         SOLAR_COLOR,
  house:          '#a855f7',
  battery:        BATT_COLOR,
  grid:           GRID_COLOR,
  impactPositive: '#16a34a',
  impactNegative: '#dc2626',
} as const;

type SeriesKey =
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

const DEFAULT_HIDDEN_SERIES: readonly SeriesKey[] = ["raw"];

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

function negateWh(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? value : -value;
}

/** Stroke opacity for forecast the actuals have already superseded. */
const MUTED_FORECAST_OPACITY = 0.35;

type StrokeStyle = { width: number; opacity: number };

/** Power series own the plot; SoC recedes behind them. */
const POWER_STROKE: StrokeStyle = { width: 2, opacity: 1 };
const SOC_STROKE: StrokeStyle = { width: 1.2, opacity: 0.5 };

const MINUTES_PER_DAY = 1440;

/** Fill of the measured stack; low enough that the forecast outline reads through it. */
const ACTUAL_BAND_FILL_OPACITY = 0.45;
/**
 * The forecast's own fill, past the last actual. Its muting comes from the
 * hatch pattern being mostly transparent, so the paint itself stays near solid.
 */
const FORECAST_BAND_FILL_OPACITY = 0.9;
const FORECAST_OUTLINE: StrokeStyle = { width: 1.4, opacity: 0.55 };

/** Band colours needing a hatch pattern; solar's forecast reuses the solar hue. */
const STACK_HATCH_COLORS = [
  CHART_COLORS.corrected,
  CHART_COLORS.house,
  CHART_COLORS.battery,
  CHART_COLORS.grid,
] as const;

/** Patterns are referenced by url(#id), so each colour needs a stable id. */
function hatchId(color: string): string {
  return `stack-hatch-${color.replace("#", "")}`;
}

type ChartStacks = { forecast: StackSet; actual: StackSet };

/**
 * Close an interval series with a vertex at the end of its last slot.
 *
 * Each entry is the average power over the slot *starting* at it, so the final
 * slot has only one vertex and no segment gets drawn across it. Battery SoC
 * needs no such closing: it is an instantaneous reading, not an interval.
 */
function closeIntervalSeries(points: ChartEntry[]): ChartEntry[] {
  if (!points.length) return points;
  const last = points[points.length - 1];
  const slotEnd = last.minutes + SLOT_MINUTES;
  if (slotEnd > MINUTES_PER_DAY) return points;
  return [...points, { ...last, minutes: slotEnd }];
}

/** Minutes past midnight of the last actual sample, or null when there are none. */
function lastActualMinutes<T>(
  actual: readonly T[],
  minutesOf: (point: T) => number | null,
): number | null {
  for (let index = actual.length - 1; index >= 0; index--) {
    const minutes = minutesOf(actual[index]);
    if (minutes !== null) return minutes;
  }
  return null;
}

/**
 * Split a forecast into the part the actuals already cover and the part still
 * ahead of them. The boundary point belongs to both so the two paths join with
 * no visible seam.
 */
function splitForecastAtActuals<T>(
  forecast: readonly T[],
  cutoff: number | null,
  minutesOf: (point: T) => number | null,
): { covered: T[]; ahead: T[] } {
  if (cutoff === null) return { covered: [], ahead: [...forecast] };
  let split = 0;
  while (split < forecast.length) {
    const minutes = minutesOf(forecast[split]);
    if (minutes === null || minutes > cutoff) break;
    split++;
  }
  if (split === 0) return { covered: [], ahead: [...forecast] };
  if (split >= forecast.length) return { covered: [...forecast], ahead: [] };
  return { covered: forecast.slice(0, split), ahead: forecast.slice(split - 1) };
}

type RatioBounds = { min: number; max: number; maxAbsDeviation: number };

type ChartLayout = {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  plotWidth: number;
  plotHeight: number;
  minKw: number;
  maxKw: number;
  yTicks: number[];
  xForMinutes: (m: number) => number;
  yForW: (w: number) => number;
  hasSocAxis: boolean;
  yForPct: (pct: number) => number;
};

type InspectorPayload = {
  date: string;
  timezone: string;
  status: string;
  effectiveVariant: string | null;
  trainedAt: string | null;
  range: {
    minDate: string;
    maxDate: string;
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
    batterySocForecast: BatterySocPoint[];
    batterySocActual: BatterySocPoint[];
    gridForecast: InspectorPoint[];
    gridActual: InspectorPoint[];
    batteryForecast: InspectorPoint[];
    batteryActual: InspectorPoint[];
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
  };
  availability: {
    hasRawForecast: boolean;
    hasCorrectedForecast: boolean;
    hasActuals: boolean;
    hasInvalidated: boolean;
    hasProfile: boolean;
    hasHouseForecast: boolean;
    hasHouseActual: boolean;
    hasBatterySocForecast: boolean;
    hasBatterySocActual: boolean;
    hasGridForecast: boolean;
    hasGridActual: boolean;
    hasBatteryForecast: boolean;
    hasBatteryActual: boolean;
  };
  trainingExplainability: TrainingExplainability | null;
};

export class HelmanSolarInspector extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;

  @state() private _selectedDate = "";
  @state() private _payload: InspectorPayload | null = null;
  @state() private _loading = false;
  @state() private _error = "";
  @state() private _selectedSlot: string | null = null;
  @state() private _selectedTrainingDate: string | null = null;
  @state() private _trainingTableCollapsed = true;
  @state() private _chartWidth = 720;
  @state() private _hiddenSeries: ReadonlySet<SeriesKey> = new Set(DEFAULT_HIDDEN_SERIES);

  private _fallbackLocalize: LocalizeFunction = (key: string) => key;
  private _lastLayoutForStrip: ChartLayout | null = null;
  private _activeRequestId = 0;
  private _activeRequestDate: string | null = null;
  private _loadedConnection: unknown = null;
  private _chartResizeObserver: ResizeObserver | null = null;
  private _observedChartWrap: HTMLElement | null = null;

  static styles = css`
    :host {
      display: block;
      width: 100%;
    }

    .body {
      display: grid;
      gap: 12px;
      min-width: 0;
      width: 100%;
    }

    .nav {
      display: grid;
      grid-template-columns: 40px minmax(0, 1fr) 40px;
      align-items: center;
      gap: 8px;
    }

    .icon-button {
      min-width: 40px;
      min-height: 36px;
      border: 1px solid var(--divider-color);
      border-radius: 6px;
      background: var(--card-background-color);
      color: var(--primary-text-color);
      cursor: pointer;
    }

    .icon-button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .day-label {
      min-width: 0;
      color: var(--primary-text-color);
      font-weight: 600;
      overflow-wrap: anywhere;
    }

    .day-meta {
      min-width: 0;
      display: grid;
      gap: 2px;
    }

    .day-state {
      color: var(--secondary-text-color);
      font-size: 0.9rem;
    }

    .note {
      padding: 12px;
      border-radius: 6px;
      border: 1px solid var(--divider-color);
      color: var(--secondary-text-color);
      background: var(--secondary-background-color);
      line-height: 1.35;
    }

    .interpolation-note {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-left: 8px;
      padding: 1px 6px;
      border: 1px dashed var(--primary-text-color);
      border-radius: 999px;
      font-size: 0.75rem;
      color: var(--secondary-text-color);
      background: var(--secondary-background-color);
    }

    .contribution-row.synthetic {
      cursor: default;
      font-style: italic;
      color: var(--secondary-text-color);
    }

    .contribution-row.synthetic:hover td,
    .contribution-row.synthetic:focus-within td {
      background: transparent;
    }

    .contribution-row.muted td {
      color: color-mix(in srgb, var(--secondary-text-color) 70%, transparent);
    }

    .contribution-row.selected.muted td {
      color: color-mix(in srgb, var(--secondary-text-color) 90%, var(--primary-text-color));
    }

    .contribution-table td.ratio {
      padding: 4px 6px;
      width: 1%;
      min-width: 140px;
    }

    .contribution-row.muted td.ratio {
      padding: 8px 10px;
      text-align: right;
    }

    .ratio-gauge {
      box-sizing: border-box;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      width: 100%;
      min-height: 18px;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 0.78rem;
      font-weight: 600;
      line-height: 1.2;
      white-space: nowrap;
      background: linear-gradient(
        90deg,
        color-mix(in srgb, #ef4444 8%, transparent),
        color-mix(in srgb, var(--card-background-color) 90%, transparent),
        color-mix(in srgb, #22c55e 8%, transparent)
      );
      box-shadow: inset 0 0 0 1px var(--divider-color);
      font-variant-numeric: tabular-nums;
    }

    .ratio-gauge-center {
      position: absolute;
      top: 3px;
      bottom: 3px;
      left: 50%;
      width: 1px;
      z-index: 1;
      background: color-mix(in srgb, var(--primary-text-color) 26%, transparent);
      transform: translateX(-50%);
    }

    .ratio-gauge-fill {
      position: absolute;
      top: 0;
      bottom: 0;
      z-index: 0;
      pointer-events: none;
    }

    .ratio-gauge-fill.positive {
      left: 50%;
      background: linear-gradient(
        90deg,
        color-mix(in srgb, #22c55e 60%, transparent),
        color-mix(in srgb, #22c55e 25%, transparent)
      );
      border-radius: 0 4px 4px 0;
    }

    .ratio-gauge-fill.negative {
      right: 50%;
      background: linear-gradient(
        270deg,
        color-mix(in srgb, #ef4444 60%, transparent),
        color-mix(in srgb, #ef4444 25%, transparent)
      );
      border-radius: 4px 0 0 4px;
    }

    .ratio-gauge-text {
      position: relative;
      z-index: 2;
      color: var(--primary-text-color);
    }

    .contribution-row.muted .ratio-gauge-text {
      color: color-mix(in srgb, var(--secondary-text-color) 70%, transparent);
    }

    .chart-wrap {
      border: 1px solid var(--divider-color);
      border-radius: 6px;
      overflow-x: auto;
      overflow-y: hidden;
      background: var(--card-background-color);
    }

    .chart-wrap svg {
      display: block;
      width: 100%;
      min-width: 360px;
      max-width: none;
      height: 260px;
    }

    .impact-strip-wrap {
      margin-top: 4px;
      width: 100%;
    }

    .impact-strip-wrap svg {
      display: block;
      width: 100%;
      min-width: 360px;
      height: 24px;
    }

    .metrics-section {
      display: grid;
      gap: 6px;
    }

    .metric-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
      gap: 6px;
      min-width: 0;
    }

    .metric-card {
      border: 1px solid var(--divider-color);
      border-radius: 6px;
      padding: 6px 7px;
      min-width: 0;
    }

    .metric-card.legend-toggle {
      font: inherit;
      text-align: left;
      cursor: pointer;
      display: block;
      width: 100%;
    }

    .metric-card.legend-toggle:focus-visible {
      outline: 2px solid var(--primary-color, #2563eb);
      outline-offset: 1px;
    }

    .metric-card.hidden-series {
      background: none !important;
      opacity: 0.5;
    }

    .metric-card.hidden-series .metric-label {
      text-decoration: line-through;
    }

    .metric-label {
      color: var(--secondary-text-color);
      font-size: 0.72rem;
      line-height: 1.15;
      min-height: 1.7em;
    }

    .metric-value {
      color: var(--primary-text-color);
      font-weight: 700;
      font-size: 0.92rem;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }

    .contribution-summary {
      display: grid;
      gap: 2px;
    }

    .contribution-toggle {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--primary-text-color);
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 0;
      font: inherit;
      font-weight: bold;
      text-align: left;
    }

    .contribution-toggle-icon {
      display: inline-block;
      font-style: normal;
      transition: transform 0.2s;
      font-size: 0.7em;
      opacity: 0.7;
    }

    .contribution-toggle-icon.expanded {
      transform: rotate(90deg);
    }

    .contribution-table-wrap {
      overflow-x: auto;
    }

    .contribution-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.86rem;
    }

    .contribution-table th,
    .contribution-table td {
      padding: 8px 10px;
      border-bottom: 1px solid var(--divider-color);
      text-align: left;
      white-space: nowrap;
    }

    .contribution-table th.numeric,
    .contribution-table td.numeric {
      text-align: right;
    }

    .contribution-row {
      cursor: pointer;
    }

    .contribution-row:hover td,
    .contribution-row:focus-within td {
      background: var(--secondary-background-color);
    }

    .contribution-row.selected td {
      background: rgba(21, 101, 192, 0.12);
    }
  `;

  protected disconnectedCallback() {
    super.disconnectedCallback();
    this._disconnectChartResizeObserver();
  }

  protected updated(changed: Map<string, unknown>) {
    if (changed.has("hass") && this.hass) {
      if (!this._selectedDate) {
        this._selectedDate = this._todayIso();
      }
      if (this._loadedConnection !== this.hass.connection) {
        this._loadedConnection = this.hass.connection;
        this._load();
      }
    }
    this._syncChartResizeObserver();
  }

  render() {
    return this._renderBody();
  }

  private _renderBody() {
    const payload = this._payload?.date === this._selectedDate ? this._payload : null;
    return html`
      <div class="body">
        ${this._renderNavigation(payload)}
        ${this._loading ? html`<div class="note">${this._t("bias_correction.inspector.loading")}</div>` : ""}
        ${this._error ? html`<div class="note">${this._error}</div>` : ""}
        ${payload ? this._renderContent(payload) : ""}
      </div>
    `;
  }

  private _renderNavigation(payload: InspectorPayload | null) {
    const canGoPrevious = payload?.range.canGoPrevious ?? true;
    const canGoNext = payload?.range.canGoNext ?? true;
    const dayState = [
      this._formatRelativeDayOffset(this._selectedDate),
      payload?.range.isToday ? this._t("bias_correction.inspector.today") : "",
      payload?.range.isFuture ? this._t("bias_correction.inspector.forecast_only") : "",
    ].filter(Boolean).join(" · ");
    return html`
      <div class="nav">
        <button class="icon-button" title=${this._t("bias_correction.inspector.previous_day")} ?disabled=${!canGoPrevious || this._loading} @click=${() => this._moveDay(-1)}>&lt;</button>
        <div class="day-meta">
          <div class="day-label">${this._formatDay(this._selectedDate)}</div>
          <div class="day-state">${dayState}</div>
        </div>
        <button class="icon-button" title=${this._t("bias_correction.inspector.next_day")} ?disabled=${!canGoNext || this._loading} @click=${() => this._moveDay(1)}>&gt;</button>
      </div>
    `;
  }

  private _renderContent(payload: InspectorPayload) {
    const hasAnySeries =
      payload.availability.hasRawForecast ||
      payload.availability.hasCorrectedForecast ||
      payload.availability.hasActuals ||
      payload.availability.hasInvalidated;

    return html`
      ${!payload.availability.hasProfile
        ? html`<div class="note">${this._t("bias_correction.inspector.no_profile")}</div>`
        : ""}
      ${hasAnySeries
        ? html`
            <div class="chart-wrap">${this._renderChart(payload)}</div>
            <div class="impact-strip-wrap">${this._lastLayoutForStrip ? this._renderImpactStrip(payload, this._lastLayoutForStrip) : ""}</div>
            ${this._renderTotals(payload)}
            ${this._renderSelectedSlotDetails(payload)}
          `
        : html`<div class="note">${this._tFormat("bias_correction.inspector.no_data", { date: this._formatDay(payload.date) })}</div>`}
    `;
  }

  private _isSeriesVisible(series: SeriesKey) {
    return !this._hiddenSeries.has(series);
  }

  private _toggleSeries(series: SeriesKey) {
    const next = new Set(this._hiddenSeries);
    if (!next.delete(series)) {
      next.add(series);
    }
    this._hiddenSeries = next;
  }

  private _computeChartLayout(payload: InspectorPayload, stacks: ChartStacks): ChartLayout {
    const width = this._chartWidth;
    const height = 260;
    const hasSocAxis =
      (payload.availability.hasBatterySocForecast && this._isSeriesVisible("batterySocForecast")) ||
      (payload.availability.hasBatterySocActual && this._isSeriesVisible("batterySocActual"));
    const margin = { top: 18, right: hasSocAxis ? 40 : 24, bottom: 34, left: 48 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;

    const powerFor = (series: SeriesKey, entries: ChartEntry[]) =>
      this._isSeriesVisible(series) ? entries.map((e) => e.powerW) : [];
    const invalidatedPoints = toAveragePower(payload.series.invalidated, { bucketMinutes: SLOT_MINUTES });
    // The stacks decide the axis: a band's outer edge is the sum beneath it, so
    // the tallest slot total is what has to fit, not the tallest single series.
    const allPower = [
      ...powerFor("raw", toAveragePower(payload.series.raw)),
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
    const xForMinutes = (minutes: number) => margin.left + (minutes / 1440) * plotWidth;
    const yForW = (powerW: number) =>
      margin.top + plotHeight - ((powerW - minKw * 1000) / spanW) * plotHeight;
    // Anchor 0% SoC to the 0 kW baseline rather than the plot floor, so the SoC
    // curve never dips into the negative (consumption) band below it.
    const zeroY = yForW(0);
    const yForPct = (pct: number) =>
      zeroY - (Math.max(0, Math.min(100, pct)) / 100) * (zeroY - margin.top);

    return { width, height, margin, plotWidth, plotHeight, minKw, maxKw, yTicks, xForMinutes, yForW, hasSocAxis, yForPct };
  }

  private _renderChart(payload: InspectorPayload) {
    const stacks = this._buildStacks(payload);
    const layout = this._computeChartLayout(payload, stacks);
    this._lastLayoutForStrip = layout;
    const selectedSlot = resolveSelectedImpactSlot(payload.series.impact, this._selectedSlot);
    return svg`
      <svg
        viewBox="0 0 ${layout.width} ${layout.height}"
        role="img"
        aria-label=${this._t("bias_correction.inspector.title")}
        style="cursor: pointer;"
        @click=${(e: MouseEvent) => this._handleChartClick(e, payload)}
      >
        ${this._renderChartBackground(layout)}
        ${this._renderSlotHighlight(layout, layout.margin.top, layout.plotHeight, selectedSlot)}
        ${this._renderLeftAxis(layout)}
        ${this._renderXAxis(layout)}
        ${this._renderStackSet(layout, stacks.actual, "actual", Number.NEGATIVE_INFINITY)}
        ${this._renderStackSet(layout, stacks.forecast, "forecast", this._forecastFillFrom(stacks))}
        ${this._renderSolarLayer(payload, layout)}
        ${this._renderRightAxis(layout)}
        ${this._renderBatterySocLayer(payload, layout)}
      </svg>
    `;
  }

  /**
   * The two stacks, in the order they build outwards from the zero baseline:
   * solar, battery discharge and grid import above; house, battery charge and
   * grid export below.
   */
  private _buildStacks(payload: InspectorPayload): ChartStacks {
    const series = payload.series;
    const solarForecast = this._stackLayer("corrected", CHART_COLORS.corrected, series.corrected, false);
    const solarActual = this._stackLayer("actual", CHART_COLORS.actual, series.actual, false);
    const houseForecast = this._stackLayer("houseForecast", CHART_COLORS.house, series.houseForecast, true);
    const houseActual = this._stackLayer("houseActual", CHART_COLORS.house, series.houseActual, true);
    const batteryForecast = this._stackLayer("batteryForecast", CHART_COLORS.battery, series.batteryForecast, true);
    const batteryActual = this._stackLayer("batteryActual", CHART_COLORS.battery, series.batteryActual, true);
    const gridForecast = this._stackLayer("gridForecast", CHART_COLORS.grid, series.gridForecast, true);
    const gridActual = this._stackLayer("gridActual", CHART_COLORS.grid, series.gridActual, true);
    return {
      forecast: {
        positive: [solarForecast, batteryForecast, gridForecast],
        negative: [houseForecast, batteryForecast, gridForecast],
      },
      actual: {
        positive: [solarActual, batteryActual, gridActual],
        negative: [houseActual, batteryActual, gridActual],
      },
    };
  }

  /**
   * The first slot the forecast has to speak for alone: one past the last
   * measured slot. With no actuals at all the forecast fills the whole day.
   */
  private _forecastFillFrom(stacks: ChartStacks): number {
    const lastActual = lastStackSlot(stacks.actual);
    return lastActual === null ? Number.NEGATIVE_INFINITY : lastActual + SLOT_MINUTES;
  }

  /** A hidden series yields an empty layer, so toggling it collapses its band. */
  private _stackLayer(
    key: SeriesKey,
    color: string,
    points: InspectorPoint[],
    consumptionPositive: boolean,
  ): StackLayer {
    if (!this._isSeriesVisible(key)) return { color, values: new Map() };
    const oriented = consumptionPositive ? asSupplyPositive(points) : points;
    return { color, values: toSlotMap(toAveragePower(oriented, { bucketMinutes: SLOT_MINUTES })) };
  }

  /**
   * A stacked area. Slots from `fillFrom` onwards are drawn as filled bands;
   * everything before it is drawn as dashed band edges only.
   *
   * The measured stack fills throughout. The forecast stack fills only the part
   * of the day the actuals never reached, and recedes to bare edges over the
   * measured hours, where it is a claim to compare against rather than the
   * account of what happened.
   */
  private _renderStackSet(
    layout: ChartLayout,
    set: StackSet,
    variant: "actual" | "forecast",
    fillFrom: number,
  ) {
    const slots = stackSlots(set);
    if (!slots.length) return "";
    const { xForMinutes, yForW } = layout;
    // Each slot's power is an average over the interval that starts at it, so a
    // band is a run of rectangles, not a sloped ribbon between sample points.
    const stepEdge = (slot: number, level: Map<number, number>) => [
      [xForMinutes(slot), yForW(level.get(slot)!)] as const,
      [xForMinutes(slot + SLOT_MINUTES), yForW(level.get(slot)!)] as const,
    ];
    const toPath = (points: readonly (readonly [number, number])[]) =>
      points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const forecast = variant === "forecast";
    const dash = forecast ? "4 3" : "";

    const outline = (run: number[], band: StackBand) => svg`
      <path d=${toPath(run.flatMap((slot) => stepEdge(slot, band.top)))} fill="none"
            stroke=${band.layer.color} stroke-width=${FORECAST_OUTLINE.width}
            stroke-dasharray=${dash} stroke-opacity=${FORECAST_OUTLINE.opacity}></path>
    `;
    const area = (run: number[], band: StackBand) => {
      const outer = run.flatMap((slot) => stepEdge(slot, band.top));
      const inner = [...run].reverse().flatMap((slot) => [...stepEdge(slot, band.base)].reverse());
      // Measured hours read as solid colour; the forecast is hatched, so it is
      // legible as a projection even where no actual line sits beside it.
      const fill = forecast ? `url(#${hatchId(band.layer.color)})` : band.layer.color;
      const fillOpacity = forecast ? FORECAST_BAND_FILL_OPACITY : ACTUAL_BAND_FILL_OPACITY;
      return svg`
        <path d=${`${toPath([...outer, ...inner])} Z`} fill=${fill}
              fill-opacity=${fillOpacity} stroke=${band.layer.color} stroke-width="0.75"
              stroke-dasharray=${dash} stroke-opacity="0.6"></path>
      `;
    };

    return [1, -1].flatMap((sign) => {
      const layers = sign > 0 ? set.positive : set.negative;
      return accumulateBands(layers, slots, sign as 1 | -1).flatMap((band) =>
        // Slots where the band is flat carry no information and would stroke
        // over the band beneath them, so each run of real height stands alone.
        bandRuns(band, slots).flatMap((run) => {
          // `fillFrom` is monotonic across a sorted run, so each side stays
          // contiguous and the two pieces abut at the boundary with no seam.
          const outlined = run.filter((slot) => slot < fillFrom);
          const filled = run.filter((slot) => slot >= fillFrom);
          return [
            outlined.length ? outline(outlined, band) : "",
            filled.length ? area(filled, band) : "",
          ].filter(Boolean);
        }),
      );
    });
  }

  private _renderChartBackground(layout: ChartLayout) {
    return svg`
      <rect x="0" y="0" width=${layout.width} height=${layout.height} fill="var(--card-background-color)"></rect>
      <defs>
        ${STACK_HATCH_COLORS.map((color) => svg`
          <pattern id=${hatchId(color)} patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
            <rect width="5" height="5" fill=${color} fill-opacity="0.12"></rect>
            <line x1="0" y1="0" x2="0" y2="5" stroke=${color} stroke-width="1.5" stroke-opacity="0.7"></line>
          </pattern>
        `)}
        <pattern id="impact-interpolated-positive" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)">
          <rect width="4" height="4" fill=${CHART_COLORS.impactPositive} fill-opacity="0.12"></rect>
          <line x1="0" y1="0" x2="0" y2="4" stroke=${CHART_COLORS.impactPositive} stroke-width="1.6" stroke-opacity="0.85"></line>
        </pattern>
        <pattern id="impact-interpolated-negative" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)">
          <rect width="4" height="4" fill=${CHART_COLORS.impactNegative} fill-opacity="0.12"></rect>
          <line x1="0" y1="0" x2="0" y2="4" stroke=${CHART_COLORS.impactNegative} stroke-width="1.6" stroke-opacity="0.85"></line>
        </pattern>
      </defs>
    `;
  }

  private _renderLeftAxis(layout: ChartLayout) {
    const { margin, width, yTicks, yForW } = layout;
    return svg`
      <text x="12" y="16" fill="var(--secondary-text-color)" font-size="11">${this._t("bias_correction.inspector.power_axis_label")}</text>
      ${yTicks.map((tick) => {
        const y = yForW(tick * 1000);
        const isZeroBaseline = tick === 0 && layout.minKw < 0;
        return svg`
          <line x1=${margin.left} y1=${y} x2=${width - margin.right} y2=${y}
                stroke=${isZeroBaseline ? "var(--secondary-text-color)" : "var(--divider-color)"}
                stroke-width="1"
                opacity=${isZeroBaseline ? "0.6" : "1"}></line>
          <text x=${margin.left - 8} y=${y + 4} text-anchor="end" fill="var(--secondary-text-color)" font-size="11">${tick.toFixed(1)}</text>
        `;
      })}
    `;
  }

  private _renderXAxis(layout: ChartLayout) {
    const { margin, height, xForMinutes } = layout;
    return [0, 3, 6, 9, 12, 15, 18, 21, 24].map((hour) => {
      const x = xForMinutes(hour * 60);
      return svg`
        <line x1=${x} y1=${margin.top} x2=${x} y2=${height - margin.bottom} stroke="var(--divider-color)" stroke-width="1" opacity="0.55"></line>
        <text x=${x} y=${height - 10} text-anchor="middle" fill="var(--secondary-text-color)" font-size="11">${String(hour).padStart(2, "0")}</text>
      `;
    });
  }

  /**
   * The solar diagnostics that sit outside the stacks: the uncorrected forecast,
   * and the slots whose measurement was thrown away. Corrected forecast and
   * actual production are the bottom band of their respective stack.
   */
  private _renderSolarLayer(payload: InspectorPayload, layout: ChartLayout) {
    const { xForMinutes, yForW } = layout;
    const visible = (series: SeriesKey, points: ChartEntry[]) =>
      this._isSeriesVisible(series) ? points : [];
    const rawPoints = visible("raw", toAveragePower(payload.series.raw));
    const actualPoints = visible("actual", toAveragePower(payload.series.actual, { bucketMinutes: SLOT_MINUTES }));
    const invalidatedPoints = visible("actual", toAveragePower(payload.series.invalidated, { bucketMinutes: SLOT_MINUTES }));

    const linePath = (points: ChartEntry[]) =>
      points
        .map((entry, index) => {
          const command = index === 0 ? "M" : "L";
          return `${command}${xForMinutes(entry.minutes).toFixed(1)},${yForW(entry.powerW).toFixed(1)}`;
        })
        .join(" ");

    // Invalidated slots are measurements too, so they extend how far the
    // actuals reach and therefore how much of the forecast reads as history.
    const measured = closeIntervalSeries(
      [...actualPoints, ...invalidatedPoints].sort((a, b) => a.minutes - b.minutes),
    );

    return svg`
      ${rawPoints.length > 1
        ? this._renderForecastSplit(rawPoints, measured, (entry) => entry.minutes, linePath, CHART_COLORS.raw)
        : rawPoints.length === 1
          ? svg`<circle cx=${xForMinutes(rawPoints[0].minutes)} cy=${yForW(rawPoints[0].powerW)} r="3.5" fill=${CHART_COLORS.raw}></circle>`
          : ""}
      ${invalidatedPoints.map((entry) => svg`
        <circle cx=${xForMinutes(entry.minutes)} cy=${yForW(entry.powerW)} r="3.5" fill="#9ca3af" opacity="0.55">
          <title>${this._t("bias_correction.inspector.invalidated_production")}</title>
        </circle>
      `)}
    `;
  }

  private _renderRightAxis(layout: ChartLayout) {
    if (!layout.hasSocAxis) return "";
    const ticks = [0, 25, 50, 75, 100];
    const xRight = layout.width - layout.margin.right;
    return ticks.map((pct) => {
      const y = layout.yForPct(pct);
      return svg`
        <text x=${xRight + 6} y=${y + 4} text-anchor="start"
              fill="var(--secondary-text-color)" font-size="11"
              opacity="0.75">${pct}%</text>
      `;
    });
  }

  /**
   * Battery state of charge, on its own right-hand % axis.
   *
   * It shares the battery's colour with the battery power line but is drawn
   * thin and faint: SoC is background context for the power flow, not a fourth
   * competing power series.
   */
  private _renderBatterySocLayer(payload: InspectorPayload, layout: ChartLayout) {
    if (!layout.hasSocAxis) return "";
    const { xForMinutes, yForPct } = layout;
    const fc = this._isSeriesVisible("batterySocForecast") ? payload.series.batterySocForecast : [];
    const ac = this._isSeriesVisible("batterySocActual") ? payload.series.batterySocActual : [];
    const slotToMinutes = (slot: string) => {
      const m = /^(\d{2}):(\d{2})$/.exec(slot);
      if (!m) return null;
      return Number(m[1]) * 60 + Number(m[2]);
    };
    const minutesOf = (p: BatterySocPoint) => slotToMinutes(p.slot);
    const path = (pts: BatterySocPoint[]) => {
      const valid = pts
        .map((p) => ({ m: slotToMinutes(p.slot), pct: p.pct }))
        .filter((p): p is { m: number; pct: number } => p.m !== null);
      return valid
        .map((p, i) =>
          `${i === 0 ? "M" : "L"}${xForMinutes(p.m).toFixed(1)},${yForPct(p.pct).toFixed(1)}`,
        )
        .join(" ");
    };
    return svg`
      ${this._renderForecastSplit(fc, ac, minutesOf, path, CHART_COLORS.battery, SOC_STROKE)}
      ${ac.length > 1
        ? svg`<path d=${path(ac)} fill="none" stroke=${CHART_COLORS.battery}
                    stroke-width=${SOC_STROKE.width} stroke-opacity=${SOC_STROKE.opacity}></path>`
        : ""}
    `;
  }

  /**
   * A dashed forecast line, dimmed where the actuals have overtaken it. Both
   * segments keep the colour and dash pattern of the series they belong to.
   */
  private _renderForecastLine(d: string, color: string, muted: boolean, stroke: StrokeStyle) {
    const opacity = muted ? MUTED_FORECAST_OPACITY * stroke.opacity : stroke.opacity;
    return svg`
      <path d=${d} fill="none" stroke=${color} stroke-width=${stroke.width} stroke-dasharray="4 3"
            stroke-opacity=${opacity}></path>
    `;
  }

  private _renderForecastSplit<T>(
    forecast: readonly T[],
    actual: readonly T[],
    minutesOf: (point: T) => number | null,
    path: (points: T[]) => string,
    color: string,
    stroke: StrokeStyle = POWER_STROKE,
  ) {
    const cutoff = lastActualMinutes(actual, minutesOf);
    const { covered, ahead } = splitForecastAtActuals(forecast, cutoff, minutesOf);
    return svg`
      ${covered.length > 1 ? this._renderForecastLine(path(covered), color, true, stroke) : ""}
      ${ahead.length > 1 ? this._renderForecastLine(path(ahead), color, false, stroke) : ""}
    `;
  }

  private _renderImpactStrip(payload: InspectorPayload, layout: ChartLayout) {
    if (!payload.series.impact.length) return "";
    const stripHeight = 24;
    const stripWidth = layout.width;
    const xLeft = layout.margin.left;
    const xRight = layout.width - layout.margin.right;
    const plotWidth = xRight - xLeft;
    const values = payload.series.impact
      .map((p) => Math.abs(p.impactWh ?? 0))
      .filter((v) => Number.isFinite(v));
    const maxImpact = Math.max(1, ...values);
    const selectedSlot = resolveSelectedImpactSlot(payload.series.impact, this._selectedSlot);
    const explainability = payload.trainingExplainability;
    return svg`
      <svg
        viewBox="0 0 ${stripWidth} ${stripHeight}"
        role="img"
        aria-label=${this._t("bias_correction.inspector.correction_impact")}
        style="cursor: pointer;"
        @click=${(e: MouseEvent) => this._handleChartClick(e, payload)}
      >
        ${this._renderSlotHighlight(layout, 0, stripHeight, selectedSlot)}
        ${payload.series.impact.map((point) => {
          if (point.impactWh === null || !Number.isFinite(point.impactWh)) return "";
          const m = /^(\d{2}):(\d{2})$/.exec(point.slot);
          if (!m) return "";
          const minutes = Number(m[1]) * 60 + Number(m[2]);
          const x = xLeft + (minutes / 1440) * plotWidth;
          const w = Math.max(3, plotWidth / 96);
          const h = Math.max(2, (Math.abs(point.impactWh) / maxImpact) * (stripHeight - 4));
          const y = stripHeight - h - 2;
          const trainingSlot = explainability?.slots[point.slot] ?? null;
          const interpolated = trainingSlot?.interpolated === true;
          const untrained = !interpolated && (trainingSlot === null || trainingSlot.factor === null);
          const positive = point.impactWh >= 0;
          const selected = selectedSlot === point.slot;
          const fill = untrained
            ? "#9ca3af"
            : interpolated
              ? positive ? "url(#impact-interpolated-positive)" : "url(#impact-interpolated-negative)"
              : positive ? CHART_COLORS.impactPositive : CHART_COLORS.impactNegative;
          const fillOpacity = untrained ? "0.45" : interpolated ? "1" : "0.55";
          const strokeColor = selected ? "var(--primary-text-color)" : "transparent";
          const strokeWidth = selected ? "1.5" : "0";
          return svg`
            <rect x=${x} y=${y} width=${w} height=${h}
                  fill=${fill} fill-opacity=${fillOpacity}
                  stroke=${strokeColor} stroke-width=${strokeWidth}
                  style="pointer-events: none;">
              <title>${point.slot} ${this._formatSignedWh(point.impactWh)}</title>
            </rect>
          `;
        })}
        <defs>
          <pattern id="impact-interpolated-positive" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)">
            <rect width="4" height="4" fill=${CHART_COLORS.impactPositive} fill-opacity="0.12"></rect>
            <line x1="0" y1="0" x2="0" y2="4" stroke=${CHART_COLORS.impactPositive} stroke-width="1.6" stroke-opacity="0.85"></line>
          </pattern>
          <pattern id="impact-interpolated-negative" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)">
            <rect width="4" height="4" fill=${CHART_COLORS.impactNegative} fill-opacity="0.12"></rect>
            <line x1="0" y1="0" x2="0" y2="4" stroke=${CHART_COLORS.impactNegative} stroke-width="1.6" stroke-opacity="0.85"></line>
          </pattern>
        </defs>
      </svg>
    `;
  }

  private _selectSlot(slot: string, event?: Event) {
    event?.stopPropagation();
    const previous = this._selectedSlot;
    this._selectedSlot = slot;
    this._selectedTrainingDate = this._resolveSelectedTrainingDate(slot);
    this._trainingTableCollapsed = true;
    this.requestUpdate("_selectedSlot", previous);
  }

  private _deselectSlot() {
    if (this._selectedSlot === null) {
      return;
    }
    const previous = this._selectedSlot;
    this._selectedSlot = null;
    this._selectedTrainingDate = null;
    this.requestUpdate("_selectedSlot", previous);
  }

  private _renderTotals(payload: InspectorPayload) {
    return html`
      <div class="metrics-section">
        <strong>${this._t("bias_correction.inspector.daily_totals")}</strong>
        <div class="metric-grid">
          ${this._renderMetric(this._t("bias_correction.inspector.raw_forecast"), this._formatWh(payload.totals.rawWh), CHART_COLORS.raw, true, "raw")}
          ${this._renderMetric(this._t("bias_correction.inspector.corrected_forecast"), this._formatWh(payload.totals.correctedWh), CHART_COLORS.corrected, true, "corrected")}
          ${this._renderMetric(this._t("bias_correction.inspector.actual_production"), this._formatWh(payload.totals.actualWh), CHART_COLORS.actual, false, "actual")}
          ${this._renderMetric(this._t("bias_correction.inspector.house_forecast"), this._formatWh(negateWh(payload.totals.houseForecastWh)), CHART_COLORS.house, true, "houseForecast")}
          ${this._renderMetric(this._t("bias_correction.inspector.house_actual"), this._formatWh(negateWh(payload.totals.houseActualWh)), CHART_COLORS.house, false, "houseActual")}
          ${this._renderMetric(this._t("bias_correction.inspector.grid_forecast"), this._formatWh(negateWh(payload.totals.gridForecastWh)), CHART_COLORS.grid, true, "gridForecast")}
          ${this._renderMetric(this._t("bias_correction.inspector.grid_actual"), this._formatWh(negateWh(payload.totals.gridActualWh)), CHART_COLORS.grid, false, "gridActual")}
          ${this._renderMetric(this._t("bias_correction.inspector.battery_forecast"), this._formatWh(negateWh(payload.totals.batteryForecastWh)), CHART_COLORS.battery, true, "batteryForecast")}
          ${this._renderMetric(this._t("bias_correction.inspector.battery_actual"), this._formatWh(negateWh(payload.totals.batteryActualWh)), CHART_COLORS.battery, false, "batteryActual")}
        </div>
      </div>
    `;
  }

  private _renderSelectedSlotDetails(payload: InspectorPayload) {
    const selectedSlot = resolveSelectedImpactSlot(payload.series.impact, this._selectedSlot);
    if (!selectedSlot) return "";
    const impact = findImpactForSlot(payload.series.impact, selectedSlot);
    const raw = findPointForSlot(payload.series.raw, selectedSlot);
    const corrected = findPointForSlot(payload.series.corrected, selectedSlot);
    const actual = findPointForSlot(payload.series.actual, selectedSlot);
    const trainingSlot = findTrainingSlot(payload.trainingExplainability, selectedSlot);
    const houseFc = findHouseForecastForSlot(payload.series.houseForecast, selectedSlot);
    const houseAc = findHouseActualForSlot(payload.series.houseActual, selectedSlot);
    const batterySocFc = findBatterySocForecastForSlot(payload.series.batterySocForecast, selectedSlot);
    const batterySocAc = findBatterySocActualForSlot(payload.series.batterySocActual, selectedSlot);
    const gridFc = findPointForSlot(payload.series.gridForecast, selectedSlot);
    const gridAc = findPointForSlot(payload.series.gridActual, selectedSlot);
    const batteryFc = findPointForSlot(payload.series.batteryForecast, selectedSlot);
    const batteryAc = findPointForSlot(payload.series.batteryActual, selectedSlot);
    const interpolated = trainingSlot?.interpolated === true;
    const anchors = trainingSlot?.interpolationAnchors ?? null;
    const impactColor = (impact?.impactWh ?? null) === null
      ? undefined
      : (impact!.impactWh! >= 0 ? CHART_COLORS.impactPositive : CHART_COLORS.impactNegative);
    return html`
      <div class="metrics-section">
        <strong>
          ${this._tFormat("bias_correction.inspector.selected_slot", { slot: selectedSlot })}
          ${interpolated
            ? html`<span class="interpolation-note" title=${this._t("bias_correction.inspector.interpolated_explanation")}>
                ${this._tFormat("bias_correction.inspector.interpolated_from", {
                  left: anchors?.left ?? this._t("bias_correction.inspector.interpolated_anchor_zero"),
                  right: anchors?.right ?? this._t("bias_correction.inspector.interpolated_anchor_zero"),
                })}
              </span>`
            : ""}
        </strong>
        ${interpolated
          ? html`<div class="day-state">${this._t("bias_correction.inspector.interpolated_explanation")}</div>`
          : ""}
        <div class="metric-grid">
          ${this._renderMetric(this._t("bias_correction.inspector.raw_forecast"), this._formatWh(raw?.valueWh ?? impact?.rawWh ?? null), CHART_COLORS.raw, true, "raw")}
          ${this._renderMetric(this._t("bias_correction.inspector.corrected_forecast"), this._formatWh(corrected?.valueWh ?? impact?.correctedWh ?? null), CHART_COLORS.corrected, true, "corrected")}
          ${this._renderMetric(this._t("bias_correction.inspector.actual_production"), this._formatWh(actual?.valueWh ?? null), CHART_COLORS.actual, false, "actual")}
          ${this._renderMetric(this._t("bias_correction.inspector.house_forecast"), this._formatWh(negateWh(houseFc?.valueWh ?? null)), CHART_COLORS.house, true, "houseForecast")}
          ${this._renderMetric(this._t("bias_correction.inspector.house_actual"), this._formatWh(negateWh(houseAc?.valueWh ?? null)), CHART_COLORS.house, false, "houseActual")}
          ${this._renderMetric(this._t("bias_correction.inspector.correction_impact"), this._formatSignedWh(impact?.impactWh ?? null), impactColor)}
          ${this._renderMetric(this._t("bias_correction.inspector.factor"), this._formatFactor(impact?.factor ?? trainingSlot?.factor ?? null), impactColor)}
          ${this._renderMetric(this._t("bias_correction.inspector.battery_soc_forecast"), this._formatPct(batterySocFc?.pct ?? null), CHART_COLORS.battery, true, "batterySocForecast")}
          ${this._renderMetric(this._t("bias_correction.inspector.battery_soc_actual"), this._formatPct(batterySocAc?.pct ?? null), CHART_COLORS.battery, false, "batterySocActual")}
          ${this._renderMetric(this._t("bias_correction.inspector.grid_forecast"), this._formatWh(negateWh(gridFc?.valueWh ?? null)), CHART_COLORS.grid, true, "gridForecast")}
          ${this._renderMetric(this._t("bias_correction.inspector.grid_actual"), this._formatWh(negateWh(gridAc?.valueWh ?? null)), CHART_COLORS.grid, false, "gridActual")}
          ${this._renderMetric(this._t("bias_correction.inspector.battery_forecast"), this._formatWh(negateWh(batteryFc?.valueWh ?? null)), CHART_COLORS.battery, true, "batteryForecast")}
          ${this._renderMetric(this._t("bias_correction.inspector.battery_actual"), this._formatWh(negateWh(batteryAc?.valueWh ?? null)), CHART_COLORS.battery, false, "batteryActual")}
        </div>
      </div>
      ${this._renderContributionTable(payload, selectedSlot, trainingSlot)}
    `;
  }

  private _renderMetric(
    label: string,
    value: string,
    color?: string,
    dashed?: boolean,
    series?: SeriesKey,
  ) {
    let background = "";
    if (color && dashed) {
      background = `background: repeating-linear-gradient(-45deg, color-mix(in srgb, ${color} 18%, transparent) 0px, color-mix(in srgb, ${color} 18%, transparent) 3px, transparent 3px, transparent 8px);`;
    } else if (color) {
      background = `background: color-mix(in srgb, ${color} 15%, transparent);`;
    }
    if (!series) {
      return html`
        <div class="metric-card" style=${background}>
          <div class="metric-label">${label}</div>
          <div class="metric-value">${value}</div>
        </div>
      `;
    }
    const visible = this._isSeriesVisible(series);
    return html`
      <button
        class="metric-card legend-toggle ${visible ? "" : "hidden-series"}"
        style=${background}
        type="button"
        aria-pressed=${visible ? "true" : "false"}
        title=${this._t(
          visible
            ? "bias_correction.inspector.legend_hide_series"
            : "bias_correction.inspector.legend_show_series",
        )}
        @click=${() => this._toggleSeries(series)}
      >
        <div class="metric-label">${label}</div>
        <div class="metric-value">${value}</div>
      </button>
    `;
  }

  private _renderContributionTable(
    payload: InspectorPayload,
    selectedSlot: string,
    trainingSlot: TrainingSlotExplainability | null,
  ) {
    if (!payload.availability.hasProfile) {
      return html`<div class="note">${this._t("bias_correction.inspector.no_profile")}</div>`;
    }
    if (!payload.trainingExplainability) {
      return html`<div class="note">${this._t("bias_correction.inspector.no_explainability")}</div>`;
    }
    if (!trainingSlot) {
      return html`<div class="note">${this._tFormat("bias_correction.inspector.no_slot_explainability", { slot: selectedSlot })}</div>`;
    }
    const selectedTrainingDate = this._resolveSelectedTrainingDate(selectedSlot);
    const interpolated = trainingSlot.interpolated === true;
    const anchors = trainingSlot.interpolationAnchors ?? null;
    const ratioBounds = this._computeRatioBounds(trainingSlot.rows);
    return html`
      <div class="contribution-summary">
        <button
          class="contribution-toggle"
          aria-expanded=${!this._trainingTableCollapsed}
          @click=${() => { this._trainingTableCollapsed = !this._trainingTableCollapsed; }}
        >
          <span class="contribution-toggle-icon ${this._trainingTableCollapsed ? "" : "expanded"}">▶</span>
          ${this._t("bias_correction.inspector.training_contribution")}
        </button>
      </div>
      ${this._trainingTableCollapsed ? "" : html`
        <div class="contribution-summary">
          <div class="day-state">
            ${this._tFormat("bias_correction.inspector.training_contribution_meta", {
              ratio: this._formatFactor(trainingSlot.rawRatio),
              factor: this._formatFactor(trainingSlot.factor),
            })}
          </div>
          ${interpolated
            ? html`<div class="day-state">
                ${this._tFormat("bias_correction.inspector.interpolated_meta", {
                  left: anchors?.left ?? this._t("bias_correction.inspector.interpolated_anchor_zero"),
                  right: anchors?.right ?? this._t("bias_correction.inspector.interpolated_anchor_zero"),
                })}
              </div>`
            : ""}
          ${payload.range.isToday
            ? html`<div class="day-state">${this._t("bias_correction.inspector.today_training_note")}</div>`
            : ""}
        </div>
        <div class="contribution-table-wrap">
          <table class="contribution-table">
            <thead>
              <tr>
                <th>${this._t("bias_correction.inspector.date")}</th>
                <th class="numeric">${this._t("bias_correction.inspector.forecast_wh")}</th>
                <th class="numeric">${this._t("bias_correction.inspector.actual_wh")}</th>
                <th class="numeric">${this._t("bias_correction.inspector.ratio")}</th>
                <th>${this._t("bias_correction.inspector.status")}</th>
              </tr>
            </thead>
            <tbody>
              ${this._sortContributionRows(trainingSlot.rows).map((row) => {
                if (row.status === "interpolated") {
                  return html`
                    <tr class="contribution-row synthetic" aria-disabled="true">
                      <td>—</td>
                      <td class="numeric">—</td>
                      <td class="numeric">—</td>
                      <td class="ratio">—</td>
                      <td>${this._formatContributionStatus(row.status, row.reason)}</td>
                    </tr>
                  `;
                }
                const selected = row.date === selectedTrainingDate;
                const muted = row.status === "invalidated";
                const classes = [
                  "contribution-row",
                  selected ? "selected" : "",
                  muted ? "muted" : "",
                ].filter(Boolean).join(" ");
                return html`
                <tr
                  class=${classes}
                  aria-selected=${selected ? "true" : "false"}
                  tabindex="0"
                  @click=${() => this._selectTrainingDate(row.date)}
                  @keydown=${(event: KeyboardEvent) => this._handleContributionRowKeydown(event, row.date)}
                >
                  <td>${row.date || "-"}</td>
                  <td class="numeric">${this._formatWh(row.forecastWh)}</td>
                  <td class="numeric">${this._formatWh(row.actualWh)}</td>
                  <td class="ratio">${muted ? this._formatFactor(row.ratio) : this._renderRatioGauge(row.ratio, ratioBounds)}</td>
                  <td>${this._formatContributionStatus(row.status, row.reason)}</td>
                </tr>
              `;})}
            </tbody>
          </table>
        </div>
      `}
    `;
  }

  private async _load() {
    if (!this.hass) return;
    if (!this._selectedDate) {
      this._selectedDate = this._todayIso();
    }
    const requestedDate = this._selectedDate;
    if (this._loading && this._activeRequestDate === requestedDate) return;
    const requestId = ++this._activeRequestId;
    this._activeRequestDate = requestedDate;
    this._loading = true;
    this._error = "";
    this._payload = null;
    try {
      const payload = await this.hass.callWS<InspectorPayload>({
        type: "helman/solar_bias/inspector",
        date: requestedDate,
      });
      payload.series.houseForecast ??= [];
      payload.series.houseActual ??= [];
      payload.series.batterySocForecast ??= [];
      payload.series.batterySocActual ??= [];
      payload.series.gridForecast ??= [];
      payload.series.gridActual ??= [];
      payload.series.batteryForecast ??= [];
      payload.series.batteryActual ??= [];
      payload.totals.houseForecastWh ??= null;
      payload.totals.houseActualWh ??= null;
      payload.totals.gridForecastWh ??= null;
      payload.totals.gridActualWh ??= null;
      payload.totals.batteryForecastWh ??= null;
      payload.totals.batteryActualWh ??= null;
      payload.availability.hasHouseForecast ??= false;
      payload.availability.hasHouseActual ??= false;
      payload.availability.hasBatterySocForecast ??= false;
      payload.availability.hasBatterySocActual ??= false;
      payload.availability.hasGridForecast ??= false;
      payload.availability.hasGridActual ??= false;
      payload.availability.hasBatteryForecast ??= false;
      payload.availability.hasBatteryActual ??= false;
      if (requestId === this._activeRequestId && requestedDate === this._selectedDate) {
        this._payload = payload;
        const resolvedSlot = resolveSelectedImpactSlot(
          payload.series.impact,
          this._selectedSlot,
        );
        this._selectedSlot = resolvedSlot;
        this._selectedTrainingDate = this._resolveSelectedTrainingDate(
          resolvedSlot,
          payload,
          requestedDate,
        );
      }
    } catch (err: any) {
      if (requestId === this._activeRequestId && requestedDate === this._selectedDate) {
        this._error = err?.message || this._t("bias_correction.inspector.load_failed");
      }
    } finally {
      if (requestId === this._activeRequestId && requestedDate === this._selectedDate) {
        this._loading = false;
        this._activeRequestDate = null;
      }
      this.requestUpdate();
    }
  }

  private _moveDay(delta: number) {
    const current = this._parseIsoDate(this._selectedDate || this._todayIso());
    const next = new Date(Date.UTC(current.year, current.month - 1, current.day + delta));
    this._selectedDate = this._formatDateParts(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
    );
    this._load();
  }

  private _selectTrainingDate(date: string) {
    this._selectedTrainingDate = date;
    if (date === this._selectedDate) {
      this.requestUpdate();
      return;
    }
    this._selectedDate = date;
    this._load();
  }

  private _handleContributionRowKeydown(event: KeyboardEvent, date: string) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    this._selectTrainingDate(date);
  }

  private _syncChartResizeObserver() {
    const chartWrap = this.renderRoot.querySelector<HTMLElement>(".chart-wrap");
    if (!chartWrap) {
      this._disconnectChartResizeObserver();
      return;
    }
    if (chartWrap === this._observedChartWrap) {
      return;
    }
    this._disconnectChartResizeObserver();
    this._observedChartWrap = chartWrap;
    this._chartResizeObserver = new ResizeObserver(() => this._updateChartWidth(chartWrap));
    this._chartResizeObserver.observe(chartWrap);
    this._updateChartWidth(chartWrap);
  }

  private _disconnectChartResizeObserver() {
    this._chartResizeObserver?.disconnect();
    this._chartResizeObserver = null;
    this._observedChartWrap = null;
  }

  private _updateChartWidth(chartWrap: HTMLElement) {
    const width = Math.max(360, Math.round(chartWrap.clientWidth || chartWrap.getBoundingClientRect().width));
    if (Math.abs(width - this._chartWidth) > 1) {
      this._chartWidth = width;
    }
  }

  private _resolveSelectedTrainingDate(
    slot: string | null,
    payload: InspectorPayload | null = this._payload,
    preferredDate: string | null = this._selectedDate,
  ) {
    const trainingSlot = findTrainingSlot(payload?.trainingExplainability ?? null, slot);
    return resolveSelectedTrainingDate(
      trainingSlot?.rows ?? [],
      preferredDate,
      this._selectedTrainingDate,
    );
  }

  private _todayIso() {
    return this._formatDateInTimeZone(new Date(), this._haTimeZone());
  }

  private _formatDateInTimeZone(value: Date, timeZone: string | undefined) {
    if (!timeZone) {
      return this._formatDateParts(
        value.getFullYear(),
        value.getMonth() + 1,
        value.getDate(),
      );
    }

    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(value);
    const year = Number(parts.find((part) => part.type === "year")?.value);
    const month = Number(parts.find((part) => part.type === "month")?.value);
    const day = Number(parts.find((part) => part.type === "day")?.value);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      return this._formatDateParts(
        value.getFullYear(),
        value.getMonth() + 1,
        value.getDate(),
      );
    }
    return this._formatDateParts(year, month, day);
  }

  private _formatDateParts(year: number, month: number, day: number) {
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  private _parseIsoDate(value: string): { year: number; month: number; day: number } {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) {
      const today = this._todayIso();
      return this._parseIsoDate(today);
    }
    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
    };
  }

  private _formatDay(value: string) {
    const parsed = this._parseIsoDate(value);
    return new Date(
      Date.UTC(parsed.year, parsed.month - 1, parsed.day, 12),
    ).toLocaleDateString(undefined, {
      timeZone: "UTC",
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  private _formatRelativeDayOffset(value: string) {
    const selected = this._parseIsoDate(value);
    const today = this._parseIsoDate(this._todayIso());
    const selectedTime = Date.UTC(selected.year, selected.month - 1, selected.day);
    const todayTime = Date.UTC(today.year, today.month - 1, today.day);
    const offset = Math.round((selectedTime - todayTime) / 86400000);
    return offset > 0 ? `+${offset}` : String(offset);
  }

  private _haTimeZone(): string | undefined {
    return this._payload?.timezone ?? this.hass?.config?.time_zone;
  }

  private _formatWh(value: number | null) {
    if (value === null) return this._t("bias_correction.inspector.actual_not_available");
    return `${(value / 1000).toFixed(1)} kWh`;
  }

  private _formatSignedWh(value: number | null) {
    if (value === null || !Number.isFinite(value)) return this._t("bias_correction.inspector.actual_not_available");
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(0)} Wh`;
  }

  private _formatFactor(value: number | null) {
    if (value === null || !Number.isFinite(value)) return "-";
    return value.toFixed(3);
  }

  private _formatPct(value: number | null): string {
    if (value === null || !Number.isFinite(value)) {
      return this._t("bias_correction.inspector.actual_not_available");
    }
    return `${value.toFixed(1)} %`;
  }

  private _sortContributionRows(rows: ContributionRow[]): ContributionRow[] {
    const dated: ContributionRow[] = [];
    const synthetic: ContributionRow[] = [];
    for (const row of rows) {
      if (row.status === "interpolated" || !row.date) {
        synthetic.push(row);
      } else {
        dated.push(row);
      }
    }
    dated.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    return [...dated, ...synthetic];
  }

  private _findClosestImpactSlot(minutes: number, impacts: ImpactPoint[]): string | null {
    let best: string | null = null;
    let bestDist = Infinity;
    for (const point of impacts) {
      const m = /^(\d{2}):(\d{2})$/.exec(point.slot);
      if (!m) continue;
      const slotMinutes = Number(m[1]) * 60 + Number(m[2]);
      const dist = Math.abs(slotMinutes - minutes);
      if (dist < bestDist) {
        bestDist = dist;
        best = point.slot;
      }
    }
    return best;
  }

  private _handleChartClick(event: MouseEvent, payload: InspectorPayload) {
    const layout = this._lastLayoutForStrip;
    if (!layout) return;
    const svgEl = event.currentTarget as SVGSVGElement;
    const rect = svgEl.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) / rect.width) * layout.width;
    if (svgX < layout.margin.left || svgX > layout.width - layout.margin.right) {
      this._deselectSlot();
      return;
    }
    const minutes = ((svgX - layout.margin.left) / layout.plotWidth) * 1440;
    const slot = this._findClosestImpactSlot(minutes, payload.series.impact);
    if (slot) {
      this._selectSlot(slot);
    } else {
      this._deselectSlot();
    }
  }

  private _renderSlotHighlight(
    layout: ChartLayout,
    y: number,
    height: number,
    selectedSlot: string | null,
  ) {
    if (!selectedSlot) return "";
    const m = /^(\d{2}):(\d{2})$/.exec(selectedSlot);
    if (!m) return "";
    const minutes = Number(m[1]) * 60 + Number(m[2]);
    const x = layout.xForMinutes(minutes);
    const w = Math.max(3, layout.plotWidth / 96);
    return svg`
      <rect
        x=${x} y=${y} width=${w} height=${height}
        fill="rgba(37,99,235,0.13)"
        stroke="#2563eb" stroke-width="1" stroke-opacity="0.5"
        rx="1"
        pointer-events="none"
      ></rect>
    `;
  }

  private _computeRatioBounds(rows: ContributionRow[]): RatioBounds {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const row of rows) {
      if (row.status === "interpolated") continue;
      const r = row.ratio;
      if (r === null || !Number.isFinite(r)) continue;
      if (r < min) min = r;
      if (r > max) max = r;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return { min: 1, max: 1, maxAbsDeviation: 0 };
    }
    const maxAbsDeviation = Math.max(Math.abs(max - 1), Math.abs(1 - min));
    return { min, max, maxAbsDeviation };
  }

  private _renderRatioGauge(ratio: number | null, bounds: RatioBounds) {
    const text = this._formatFactor(ratio);
    if (ratio === null || !Number.isFinite(ratio) || bounds.maxAbsDeviation <= 0) {
      return html`
        <div class="ratio-gauge" role="img" aria-label=${text}>
          <span class="ratio-gauge-center" aria-hidden="true"></span>
          <span class="ratio-gauge-text">${text}</span>
        </div>
      `;
    }
    const deviation = ratio - 1;
    const widthPct = Math.min((Math.abs(deviation) / bounds.maxAbsDeviation) * 50, 50);
    const direction = deviation >= 0 ? "positive" : "negative";
    return html`
      <div class="ratio-gauge" role="img" aria-label=${text}>
        <span class="ratio-gauge-center" aria-hidden="true"></span>
        ${widthPct > 0
          ? html`<span
              class=${`ratio-gauge-fill ${direction}`}
              style=${`width:${widthPct}%;`}
              aria-hidden="true"
            ></span>`
          : ""}
        <span class="ratio-gauge-text">${text}</span>
      </div>
    `;
  }

  private _formatContributionStatus(status: string, reason: string | null) {
    const translated = this._t(`bias_correction.inspector.contribution_status.${status}`);
    if (!reason) return translated;
    return `${translated} (${reason})`;
  }

  private _t(key: string): string {
    return this.hass ? getLocalizeFunction(this.hass)(key) : this._fallbackLocalize(key);
  }

  private _tFormat(key: string, values: Record<string, string | number>): string {
    let text = this._t(key);
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "helman-solar-inspector": HelmanSolarInspector;
  }
}

if (!customElements.get("helman-solar-inspector")) {
  customElements.define("helman-solar-inspector", HelmanSolarInspector);
}
