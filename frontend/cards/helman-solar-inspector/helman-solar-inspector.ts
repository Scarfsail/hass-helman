import { LitElement, css, html, svg, unsafeCSS, type TemplateResult } from "lit";
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
import {
  buildSocBars,
  slotToMinutes,
  type SocBar,
  type SocBoundsPoint,
} from "./chart-soc";
import { SOC_COLUMN_OPACITY, SOC_DIRECTION_COLOR } from "../shared/soc-columns";
import {
  BATT_COLOR,
  CHARGE_COLOR,
  DISCHARGE_COLOR,
  FORECAST_RAW_COLOR,
  GRID_COLOR,
  HOUSE_COLOR,
  SOLAR_COLOR,
  nodeAccentColor,
} from "../color-utils";
import { formatEnergy } from "../power-format";
import { getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import "./helman-solar-schedule-band-strip";
import "./helman-solar-export-price-strip";
import "../helman/power-devices-container";
import { DeviceNode } from "../helman/DeviceNode";
import {
  findTrainingSlot,
  resolveSelectedTrainingDate,
  resolveSelectedImpactSlot,
  type BatterySocPoint,
  type FactorPoint,
  type HouseBreakdownPoint,
  type ImpactPoint,
  type InspectorPoint,
  type TrainingExplainability,
  type TrainingSlotExplainability,
  type ContributionRow,
} from "./solar-inspector-model.js";
import {
  actualsCoverUntil,
  aggregateBreakdownOverSlots,
  aggregateBreakdownSeries,
  consumerBarsOverSlots,
  expandSlotsToNative,
  houseSourceMixBySlot,
  dropPartialBuckets,
  timestampMinutes,
  aggregateImpactOverSlots,
  aggregateImpactSeries,
  aggregateWhSeries,
  minutesToSlot,
  sampleBounds,
  socAtSelectionStart,
  sumWhOverSlots,
  sampleOnGrid,
  snapSlotToGrid,
} from "./slot-aggregation.js";
import {
  EMPTY_SLOT_SELECTION,
  applySlotSelection,
  reconcileSlotSelection,
  slotSelectionModeForEvent,
  type SlotPickDetail,
  type SlotSelectionMode,
  type SlotSelectionState,
} from "./slot-selection.js";
import { helmanColorVars } from "../color-vars";

/** Slot widths the header toggle and card config offer, in minutes. */
const SLOT_SIZE_OPTIONS = [15, 30, 60] as const;

/** Below this page width the chart opens at the coarser default. */
const NARROW_VIEWPORT_PX = 768;

/**
 * The slot width to open at when the card configures no explicit default: a
 * phone-width page opens at 60 minutes, anything wider (laptop) at 30. 15 is
 * never auto-chosen — it stays a deliberate pick on the header toggle.
 */
function defaultSlotMinutesForViewport(): number {
  const width = typeof window !== "undefined" ? window.innerWidth : 0;
  return width > 0 && width < NARROW_VIEWPORT_PX ? 60 : 30;
}

const CHART_COLORS = {
  raw:            FORECAST_RAW_COLOR,
  corrected:      SOLAR_COLOR,
  actual:         SOLAR_COLOR,
  house:          HOUSE_COLOR,
  battery:        BATT_COLOR,
  grid:           GRID_COLOR,
  impactPositive: CHARGE_COLOR,
  impactNegative: DISCHARGE_COLOR,
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

const POWER_STROKE: StrokeStyle = { width: 2, opacity: 1 };

const MINUTES_PER_DAY = 1440;

/** The SoC strip's own geometry; it borrows only the x scale from the chart. */
const SOC_STRIP = { height: 65, padTop: 8, padBottom: 8 } as const;

const SOC_UNUSABLE_HATCH_ID = "soc-unusable-hatch";

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
function closeIntervalSeries(points: ChartEntry[], slotMinutes: number): ChartEntry[] {
  if (!points.length) return points;
  const last = points[points.length - 1];
  const slotEnd = last.minutes + slotMinutes;
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
  /** Minute-of-day at the left edge of the plot; 0 unless the day is cropped. */
  dayStartMinutes: number;
  /** Minute-of-day at the right edge of the plot; 1440 unless the day is cropped. */
  dayEndMinutes: number;
  /** Pixel width of one 15-minute slot under the current x scale. */
  slotWidth: number;
  xForMinutes: (m: number) => number;
  yForW: (w: number) => number;
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
    houseActualBreakdown: HouseBreakdownPoint[];
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
  /**
   * The power card's configured title for unmetered load, reused so the
   * breakdown's remainder row reads exactly as the card names it. Null when
   * unconfigured, leaving the card's own localized string.
   */
  houseUnmeasuredLabel: string | null;
  /** Per-slot SoC window the battery is driven within; empty when unconfigured. */
  batterySocBounds: SocBoundsPoint[];
  trainingExplainability: TrainingExplainability | null;
};

export class HelmanSolarInspector extends LitElement {
  @property({ attribute: false }) hass?: HomeAssistant;
  /** Solar power (W) at or above which a slot counts as carrying sun energy. */
  @property({ attribute: false }) daylightThresholdW = 100;
  /** Whether the daylight-only view starts on; the header toggle overrides it. */
  @property({ attribute: false }) daylightOnlyDefault = true;
  /**
   * Slot width the chart opens at, in minutes; the header toggle overrides it.
   * When unset the width is chosen from the page width — a phone opens coarser
   * (60) than a laptop (30) — so this is only for pinning an explicit default.
   */
  @property({ attribute: false }) slotMinutesDefault?: number;

  @state() private _selectedDate = "";
  @state() private _payload: InspectorPayload | null = null;
  @state() private _loading = false;
  @state() private _error = "";
  /**
   * The one slot selection every surface shares: the charts highlight each selected
   * slot, and the schedule-actions strip both renders it and bulk-edits it.
   */
  @state() private _slotSelection: SlotSelectionState = EMPTY_SLOT_SELECTION;
  @state() private _selectedTrainingDate: string | null = null;
  @state() private _trainingTableCollapsed = true;
  @state() private _impactStripVisible = false;
  @state() private _socStripExpanded = true;
  @state() private _exportPriceStripExpanded = true;
  @state() private _scheduleBandExpanded = true;
  @state() private _daylightOnly = true;
  @state() private _slotMinutes = 30;
  @state() private _chartWidth = 720;
  @state() private _hiddenSeries: ReadonlySet<SeriesKey> = new Set(DEFAULT_HIDDEN_SERIES);
  @state() private _hoveredMinutes: number | null = null;

  /** Whether the opening slot width has been seeded from config or page width. */
  private _slotMinutesInitialized = false;
  private _fallbackLocalize: LocalizeFunction = (key: string) => key;
  private _lastLayoutForStrip: ChartLayout | null = null;
  private _lastForecastFillFrom = Number.NEGATIVE_INFINITY;
  private _activeRequestId = 0;
  private _activeRequestDate: string | null = null;
  private _loadedConnection: unknown = null;
  private _chartResizeObserver: ResizeObserver | null = null;
  private _observedChartWrap: HTMLElement | null = null;

  static styles = [helmanColorVars, css`
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
      grid-template-columns: 40px minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
    }

    .nav-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .icon-button.active {
      border-color: var(--primary-color, #2563eb);
      background: color-mix(in srgb, var(--primary-color, #2563eb) 18%, var(--card-background-color));
      color: var(--primary-color, #2563eb);
    }

    .slot-size-toggle {
      display: inline-flex;
      align-items: stretch;
      border: 1px solid var(--divider-color);
      border-radius: 6px;
      overflow: hidden;
    }

    .slot-size-button {
      min-width: 30px;
      min-height: 36px;
      padding: 0 6px;
      border: none;
      border-left: 1px solid var(--divider-color);
      background: var(--card-background-color);
      color: var(--secondary-text-color);
      font: inherit;
      font-size: 0.85rem;
      cursor: pointer;
    }

    .slot-size-button:first-child {
      border-left: none;
    }

    .slot-size-button.active {
      background: color-mix(in srgb, var(--primary-color, #2563eb) 18%, var(--card-background-color));
      color: var(--primary-color, #2563eb);
      font-weight: 600;
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
        color-mix(in srgb, var(--helman-discharge) 8%, transparent),
        color-mix(in srgb, var(--card-background-color) 90%, transparent),
        color-mix(in srgb, var(--helman-charge) 8%, transparent)
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
        color-mix(in srgb, var(--helman-charge) 60%, transparent),
        color-mix(in srgb, var(--helman-charge) 25%, transparent)
      );
      border-radius: 0 4px 4px 0;
    }

    .ratio-gauge-fill.negative {
      right: 50%;
      background: linear-gradient(
        270deg,
        color-mix(in srgb, var(--helman-discharge) 60%, transparent),
        color-mix(in srgb, var(--helman-discharge) 25%, transparent)
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

    .strip-section {
      display: grid;
      gap: 2px;
      width: 100%;
    }

    .strip-collapse-toggle {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--secondary-text-color);
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 0;
      font: inherit;
      font-size: 0.85em;
      text-align: left;
    }

    .strip-collapse-icon {
      display: inline-block;
      font-style: normal;
      transition: transform 0.2s;
      font-size: 0.7em;
      opacity: 0.7;
    }

    .strip-collapse-icon.expanded {
      transform: rotate(90deg);
    }

    .soc-strip-wrap {
      margin-top: 0;
      width: 100%;
    }

    .soc-strip-wrap svg {
      display: block;
      width: 100%;
      min-width: 360px;
      height: 65px;
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

    .metric-card.hidden-series {
      border-left-color: var(--divider-color) !important;
    }

    .metric-card.hidden-series .metric-chip {
      background: none !important;
    }

    .metric-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .metric-chip {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 4px;
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

    .impact-strip-switch {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 4px;
      cursor: pointer;
      color: var(--secondary-text-color);
      font-size: 0.85em;
    }

    .impact-strip-switch input {
      margin: 0;
      cursor: pointer;
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

    .house-breakdown {
      display: grid;
      gap: 6px;
      padding: 8px 10px;
      border: 1px solid var(--divider-color);
      border-left: 3px solid var(--helman-house);
      border-radius: 6px;
      background: color-mix(in srgb, var(--helman-house) 8%, transparent);
      /* Every box here is a breakdown of the house, so it carries the house
         tint — the same declaration the power card's house section makes. The
         boxes set no --device-tint of their own, so power-device's fallback
         inherits this one across the shadow boundary. */
      --device-tint: ${unsafeCSS(nodeAccentColor("house"))};
    }

    .house-breakdown-title {
      color: var(--secondary-text-color);
      font-size: 0.78rem;
      font-weight: 600;
    }
  `];

  protected disconnectedCallback() {
    super.disconnectedCallback();
    this._disconnectChartResizeObserver();
  }

  protected updated(changed: Map<string, unknown>) {
    // Seed the view from the configured default. `changed` only carries this when
    // the config value actually changes, so the runtime toggle — which touches
    // `_daylightOnly`, not this property — is never overridden.
    if (changed.has("daylightOnlyDefault")) {
      this._daylightOnly = this.daylightOnlyDefault;
    }
    // Seed the opening slot width once: an explicit config default wins,
    // otherwise it is chosen from the page width so a phone opens coarser than a
    // laptop. As with the daylight default, the runtime toggle touches
    // `_slotMinutes` alone, so this never overrides a manual pick.
    if (!this._slotMinutesInitialized || changed.has("slotMinutesDefault")) {
      const explicit = this._explicitSlotDefault();
      if (explicit !== null) {
        this._slotMinutes = explicit;
      } else if (!this._slotMinutesInitialized) {
        this._slotMinutes = defaultSlotMinutesForViewport();
      }
      this._slotMinutesInitialized = true;
    }
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
        <div class="nav-actions">
          <div class="slot-size-toggle" role="group" title=${this._t("bias_correction.inspector.slot_size")}>
            ${SLOT_SIZE_OPTIONS.map((minutes) => html`
              <button
                class="slot-size-button ${this._slotMinutes === minutes ? "active" : ""}"
                type="button"
                aria-pressed=${this._slotMinutes === minutes ? "true" : "false"}
                @click=${() => this._setSlotMinutes(minutes)}
              >${minutes}</button>
            `)}
          </div>
          <button
            class="icon-button ${this._daylightOnly ? "active" : ""}"
            title=${this._t("bias_correction.inspector.daylight_only")}
            aria-pressed=${this._daylightOnly ? "true" : "false"}
            @click=${() => { this._daylightOnly = !this._daylightOnly; }}
          >☀</button>
          <button
            class="icon-button"
            title=${this._t("bias_correction.inspector.refresh")}
            ?disabled=${this._loading}
            @click=${() => this._load()}
          >⟳</button>
          <button class="icon-button" title=${this._t("bias_correction.inspector.next_day")} ?disabled=${!canGoNext || this._loading} @click=${() => this._moveDay(1)}>&gt;</button>
        </div>
      </div>
    `;
  }

  private _renderContent(payload: InspectorPayload) {
    // Everything below renders from the slot-collapsed view; only the daily
    // totals it carries through are slot-width independent.
    const view = this._viewForSlot(payload);
    const hasAnySeries =
      view.availability.hasRawForecast ||
      view.availability.hasCorrectedForecast ||
      view.availability.hasActuals ||
      view.availability.hasInvalidated;

    const stacks = hasAnySeries ? this._buildStacks(view) : null;
    const layout = stacks ? this._computeChartLayout(view, stacks) : null;

    return html`
      ${!view.availability.hasProfile
        ? html`<div class="note">${this._t("bias_correction.inspector.no_profile")}</div>`
        : ""}
      ${hasAnySeries && stacks && layout
        ? html`
            <!-- Solar, battery, price, then the schedule read against all
                 three -- the order the day editor stacks the same four things
                 in, so moving between the two is not a re-read. -->
            <div class="chart-wrap">${this._renderChart(view, stacks, layout)}</div>
            ${this._lastLayoutForStrip && this._socBars(view).length
              ? this._renderSocSection(view, this._lastLayoutForStrip)
              : ""}
            ${this._renderExportPriceStrip(view, layout)}
            ${this._renderScheduleActionsStrip(view, layout)}
            ${this._impactStripVisible && this._lastLayoutForStrip
              ? html`<div class="impact-strip-wrap">${this._renderImpactStrip(view, this._lastLayoutForStrip)}</div>`
              : ""}
            ${this._renderSelectedSlotDetails(view)}
            ${this._renderTotals(view)}
          `
        : html`<div class="note">${this._tFormat("bias_correction.inspector.no_data", { date: this._formatDay(view.date) })}</div>`}
    `;
  }

  /** The configured opening slot width, or null when the card leaves it to auto. */
  private _explicitSlotDefault(): number | null {
    const value = this.slotMinutesDefault;
    return value != null && SLOT_SIZE_OPTIONS.includes(value as 15 | 30 | 60) ? value : null;
  }

  /**
   * Switch the chart's slot width, keeping any selection on the new grid so the
   * highlight and detail panel stay put rather than clearing on every toggle.
   */
  private _setSlotMinutes(minutes: number) {
    if (this._slotMinutes === minutes) return;
    this._slotMinutes = minutes;
    // Re-grid the whole selection onto the new width, dropping anything it has no
    // slot for. Distinct slots can snap onto one; reconcile dedupes them.
    this._applySelection(reconcileSlotSelection(
      this._orderedSlots(null),
      this._slotSelection,
      (slot) => snapSlotToGrid(slot, minutes),
    ));
  }

  /**
   * The payload re-bucketed to the active slot width. Daily totals, availability
   * and the 15-minute training explainability are slot-width independent and
   * carry through untouched; only the time series are collapsed.
   */
  private _viewForSlot(payload: InspectorPayload): InspectorPayload {
    const slot = this._slotMinutes;
    if (slot <= SLOT_MINUTES) return payload;
    const s = payload.series;
    // A wider bucket is only history once the measurements span all of it; the
    // slot we are still inside would otherwise sum a part-hour of actuals into a
    // full-hour column and read as a collapse against the forecast.
    const coverUntil = actualsCoverUntil([
      s.actual, s.invalidated, s.houseActual, s.gridActual, s.batteryActual,
    ]);
    const measured = (points: InspectorPoint[]) =>
      dropPartialBuckets(aggregateWhSeries(points, slot), slot, coverUntil, (p) =>
        timestampMinutes(p.timestamp));
    return {
      ...payload,
      series: {
        ...s,
        raw: aggregateWhSeries(s.raw, slot),
        corrected: aggregateWhSeries(s.corrected, slot),
        actual: measured(s.actual),
        invalidated: measured(s.invalidated),
        impact: aggregateImpactSeries(s.impact, slot),
        houseForecast: aggregateWhSeries(s.houseForecast, slot),
        houseActual: measured(s.houseActual),
        houseActualBreakdown: dropPartialBuckets(
          aggregateBreakdownSeries(s.houseActualBreakdown, slot),
          slot, coverUntil, (p) => slotToMinutes(p.slot),
        ),
        gridForecast: aggregateWhSeries(s.gridForecast, slot),
        gridActual: measured(s.gridActual),
        batteryForecast: aggregateWhSeries(s.batteryForecast, slot),
        batteryActual: measured(s.batteryActual),
        batterySocForecast: sampleOnGrid(s.batterySocForecast, slot),
        batterySocActual: sampleOnGrid(s.batterySocActual, slot),
      },
      batterySocBounds: sampleBounds(payload.batterySocBounds, slot),
    };
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

  /** Hide or show a merged card's series together, driven off its shown state. */
  private _toggleSeriesGroup(series: SeriesKey[], visible: boolean) {
    const next = new Set(this._hiddenSeries);
    for (const key of series) {
      if (visible) next.add(key);
      else next.delete(key);
    }
    this._hiddenSeries = next;
  }

  private _computeChartLayout(payload: InspectorPayload, stacks: ChartStacks): ChartLayout {
    const width = this._chartWidth;
    const height = 260;
    const margin = { top: 18, right: 24, bottom: 34, left: 48 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;

    const powerFor = (series: SeriesKey, entries: ChartEntry[]) =>
      this._isSeriesVisible(series) ? entries.map((e) => e.powerW) : [];
    const invalidatedPoints = toAveragePower(payload.series.invalidated, { bucketMinutes: this._slotMinutes });
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
    const { start: dayStartMinutes, end: dayEndMinutes } = this._daylightOnly
      ? this._solarWindow(payload)
      : { start: 0, end: MINUTES_PER_DAY };
    const daySpan = dayEndMinutes - dayStartMinutes;
    const slotWidth = (plotWidth * this._slotMinutes) / daySpan;
    const xForMinutes = (minutes: number) =>
      margin.left + ((minutes - dayStartMinutes) / daySpan) * plotWidth;
    const yForW = (powerW: number) =>
      margin.top + plotHeight - ((powerW - minKw * 1000) / spanW) * plotHeight;

    return {
      width, height, margin, plotWidth, plotHeight, minKw, maxKw, yTicks,
      dayStartMinutes, dayEndMinutes, slotWidth, xForMinutes, yForW,
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
  private _solarWindow(payload: InspectorPayload): { start: number; end: number } {
    const threshold = Number.isFinite(this.daylightThresholdW) ? this.daylightThresholdW : 100;
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    // No fixed bucket: infer each series' own sample spacing so the threshold is
    // read against true average watts, whether the series is 15-minute or hourly.
    for (const series of [payload.series.raw, payload.series.corrected, payload.series.actual]) {
      for (const entry of toAveragePower(series)) {
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

  /**
   * The schedule row under the charts: one track per entity, behind a collapse
   * toggle that starts expanded.
   *
   * `helman-solar-schedule-actions-strip` used to hold this place with a column
   * of action icons per slot. It is left in the tree unmounted -- nothing
   * imports it, so it is not in the bundle -- because it answers a different
   * question well ("what is happening at 14:00", across the whole house, in one
   * row) and may yet come back as a choice.
   */
  private _renderScheduleActionsStrip(payload: InspectorPayload, layout: ChartLayout) {
    return html`
      <div class="strip-section">
        <button
          class="strip-collapse-toggle"
          type="button"
          aria-expanded=${this._scheduleBandExpanded ? "true" : "false"}
          @click=${() => { this._scheduleBandExpanded = !this._scheduleBandExpanded; }}
        >
          <span class="strip-collapse-icon ${this._scheduleBandExpanded ? "expanded" : ""}">▶</span>
          ${this._t("bias_correction.inspector.scheduled_actions")}
        </button>
        ${this._scheduleBandExpanded ? this._renderScheduleBand(payload, layout) : ""}
      </div>
    `;
  }

  private _renderScheduleBand(payload: InspectorPayload, layout: ChartLayout) {
    return html`
      <helman-solar-schedule-band-strip
        .hass=${this.hass}
        .date=${payload.date}
        .timeZone=${this._haTimeZone() ?? "UTC"}
        .slotMinutes=${this._slotMinutes}
        .geometry=${{
          width: layout.width,
          marginLeft: layout.margin.left,
          plotWidth: layout.plotWidth,
          startMinutes: layout.dayStartMinutes,
          endMinutes: layout.dayEndMinutes,
        }}
        .selectedMinutes=${this._selectedMinutes(payload)}
        .hoverMinutes=${this._hoveredMinutes}
        @slot-hover=${(event: CustomEvent<{ minutes: number | null }>) =>
          this._setHoverMinutes(event.detail?.minutes ?? null)}
      ></helman-solar-schedule-band-strip>
    `;
  }


  /** Minute-of-day of every selected slot, for the strips' bands. */
  private _selectedMinutes(payload: InspectorPayload): number[] {
    const minutes: number[] = [];
    for (const slot of this._slotSelection.selectedSlots) {
      const resolved = resolveSelectedImpactSlot(payload.series.impact, slot);
      const value = resolved === null ? null : slotToMinutes(resolved);
      if (value !== null) {
        minutes.push(value);
      }
    }
    return minutes;
  }

  /**
   * Publish the pointer's minute-of-day over any chart so every row can light its
   * own slot around it. The value is shared raw, not snapped to a slot: each row
   * decides how wide its highlight is, so an hour-wide price cell reads as the whole
   * hour while the chart above still tracks the 15-minute slot under the cursor.
   * Positions in the axis gutter clear the hover.
   */
  private _handleChartHover(event: MouseEvent, _payload: InspectorPayload) {
    const layout = this._lastLayoutForStrip;
    if (!layout) return;
    const svgEl = event.currentTarget as SVGSVGElement;
    const rect = svgEl.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) / rect.width) * layout.width;
    if (svgX < layout.margin.left || svgX > layout.width - layout.margin.right) {
      this._clearHover();
      return;
    }
    this._setHoverMinutes(this._minutesForSvgX(layout, svgX));
  }

  /** Invert the plot's x scale: a viewBox x back to its minute-of-day. */
  private _minutesForSvgX(layout: ChartLayout, svgX: number): number {
    const daySpan = layout.dayEndMinutes - layout.dayStartMinutes;
    return layout.dayStartMinutes + ((svgX - layout.margin.left) / layout.plotWidth) * daySpan;
  }

  /** Store the hovered minute at whole-minute resolution, skipping redundant updates. */
  private _setHoverMinutes(minutes: number | null) {
    const next = minutes === null ? null : Math.round(minutes);
    if (this._hoveredMinutes === next) return;
    this._hoveredMinutes = next;
  }

  private _clearHover() {
    this._setHoverMinutes(null);
  }

  /**
   * The hovered slot on a 15-minute chart, drawn from the shared hover minute. The
   * strips below compute their own wider bands from the same minute, so each row
   * highlights the true width of its slot. Orange, distinct from the blue selection.
   */
  private _renderHoverHighlight(layout: ChartLayout, y: number, height: number) {
    if (this._hoveredMinutes === null) return "";
    const start = Math.floor(this._hoveredMinutes / this._slotMinutes) * this._slotMinutes;
    const x = layout.xForMinutes(start);
    const w = Math.max(2, layout.xForMinutes(start + this._slotMinutes) - x);
    return svg`
      <rect
        x=${x} y=${y} width=${w} height=${height}
        style="fill: color-mix(in srgb, var(--helman-selection) 14%, transparent); stroke: var(--helman-selection);"
        stroke-width="1" stroke-opacity="0.55"
        rx="1"
        pointer-events="none"
      ></rect>
    `;
  }

  /** The export-price strip, behind a collapse toggle that starts expanded. */
  private _renderExportPriceStrip(payload: InspectorPayload, layout: ChartLayout) {
    return html`
      <div class="strip-section">
        <button
          class="strip-collapse-toggle"
          type="button"
          aria-expanded=${this._exportPriceStripExpanded ? "true" : "false"}
          @click=${() => { this._exportPriceStripExpanded = !this._exportPriceStripExpanded; }}
        >
          <span class="strip-collapse-icon ${this._exportPriceStripExpanded ? "expanded" : ""}">▶</span>
          ${this._t("bias_correction.inspector.export_price_strip")}
        </button>
        ${this._exportPriceStripExpanded
          ? html`
              <helman-solar-export-price-strip
                .hass=${this.hass}
                .date=${payload.date}
                .timeZone=${this._haTimeZone() ?? "UTC"}
                .selectedMinutes=${this._selectedMinutes(payload)}
                .geometry=${{
                  width: layout.width,
                  marginLeft: layout.margin.left,
                  plotWidth: layout.plotWidth,
                  startMinutes: layout.dayStartMinutes,
                  endMinutes: layout.dayEndMinutes,
                }}
                .hoverMinutes=${this._hoveredMinutes}
                .slotMinutes=${this._slotMinutes}
                @slot-pick=${(event: CustomEvent<SlotPickDetail>) =>
                  this._handleStripSlotPick(event, payload)}
                @slot-hover=${(event: CustomEvent<{ minutes: number | null }>) =>
                  this._setHoverMinutes(event.detail?.minutes ?? null)}
              ></helman-solar-export-price-strip>
            `
          : ""}
      </div>
    `;
  }

  /** Resolve a strip click to the nearest impact slot, or clear the selection. */
  private _handleStripSlotPick(
    event: CustomEvent<SlotPickDetail>,
    payload: InspectorPayload,
  ) {
    const minutes = event.detail?.minutes ?? null;
    if (minutes === null) {
      this._deselectSlot();
      return;
    }
    const slot = this._findClosestImpactSlot(minutes, payload.series.impact);
    if (slot) {
      this._selectSlot(slot, event.detail?.mode ?? "replace", payload);
    } else {
      this._deselectSlot();
    }
  }

  /** The battery SoC strip, behind a collapse toggle that starts expanded. */
  private _renderSocSection(payload: InspectorPayload, layout: ChartLayout) {
    return html`
      <div class="strip-section">
        <button
          class="strip-collapse-toggle"
          type="button"
          aria-expanded=${this._socStripExpanded ? "true" : "false"}
          @click=${() => { this._socStripExpanded = !this._socStripExpanded; }}
        >
          <span class="strip-collapse-icon ${this._socStripExpanded ? "expanded" : ""}">▶</span>
          ${this._t("bias_correction.inspector.battery_soc_strip")}
        </button>
        ${this._socStripExpanded
          ? html`<div class="soc-strip-wrap">${this._renderSocStrip(payload, layout)}</div>`
          : ""}
      </div>
    `;
  }

  private _renderChart(payload: InspectorPayload, stacks: ChartStacks, layout: ChartLayout) {
    const forecastFillFrom = this._forecastFillFrom(stacks);
    this._lastLayoutForStrip = layout;
    // The strip below renders from the same seam, so its columns turn forecast
    // where the stacks above turn hatched.
    this._lastForecastFillFrom = forecastFillFrom;
    return svg`
      <svg
        viewBox="0 0 ${layout.width} ${layout.height}"
        role="img"
        aria-label=${this._t("bias_correction.inspector.title")}
        style="cursor: pointer;"
        @click=${(e: MouseEvent) => this._handleChartClick(e, payload)}
        @mousemove=${(e: MouseEvent) => this._handleChartHover(e, payload)}
        @mouseleave=${() => this._clearHover()}
      >
        ${this._renderChartBackground(layout)}
        ${this._plotClipDef("plot-clip-chart", layout, layout.height)}
        ${this._renderHoverHighlight(layout, layout.margin.top, layout.plotHeight)}
        ${this._renderSlotHighlights(layout, layout.margin.top, layout.plotHeight)}
        ${this._renderLeftAxis(layout)}
        ${this._renderXAxis(layout)}
        <g clip-path="url(#plot-clip-chart)">
          ${this._renderStackSet(layout, stacks.actual, "actual", Number.NEGATIVE_INFINITY)}
          ${this._renderStackSet(layout, stacks.forecast, "forecast", forecastFillFrom)}
          ${this._renderSolarLayer(payload, layout)}
        </g>
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
    return lastActual === null ? Number.NEGATIVE_INFINITY : lastActual + this._slotMinutes;
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
    return { color, values: toSlotMap(toAveragePower(oriented, { bucketMinutes: this._slotMinutes })) };
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
    const slots = stackSlots(set, this._slotMinutes);
    if (!slots.length) return "";
    const { xForMinutes, yForW } = layout;
    // Each slot's power is an average over the interval that starts at it, so a
    // band is a run of rectangles, not a sloped ribbon between sample points.
    const stepEdge = (slot: number, level: Map<number, number>) => [
      [xForMinutes(slot), yForW(level.get(slot)!)] as const,
      [xForMinutes(slot + this._slotMinutes), yForW(level.get(slot)!)] as const,
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

  /**
   * A clip rectangle over the plot area, so series cropped to the daylight window
   * never spill past its edges into the axis gutter. The id must be unique per
   * `<svg>`, since a duplicate would resolve to the wrong strip's rectangle.
   */
  private _plotClipDef(id: string, layout: ChartLayout, height: number) {
    return svg`
      <defs>
        <clipPath id=${id}>
          <rect x=${layout.margin.left} y="0" width=${layout.plotWidth} height=${height}></rect>
        </clipPath>
      </defs>
    `;
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
    return this._xAxisHours(layout).map((hour) => {
      const x = xForMinutes(hour * 60);
      return svg`
        <line x1=${x} y1=${margin.top} x2=${x} y2=${height - margin.bottom} stroke="var(--divider-color)" stroke-width="1" opacity="0.55"></line>
        <text x=${x} y=${height - 10} text-anchor="middle" fill="var(--secondary-text-color)" font-size="11">${String(hour).padStart(2, "0")}</text>
      `;
    });
  }

  /**
   * The whole hours to label on the x axis, spaced so a cropped window still
   * gets a readable handful of ticks. The window edges are always whole hours,
   * so a stride that divides the span lands ticks on them.
   */
  private _xAxisHours(layout: ChartLayout): number[] {
    const startHour = Math.round(layout.dayStartMinutes / 60);
    const endHour = Math.round(layout.dayEndMinutes / 60);
    const span = endHour - startHour;
    const stride = span > 12 ? 3 : span > 6 ? 2 : 1;
    const hours: number[] = [];
    for (let hour = startHour; hour <= endHour; hour += stride) {
      hours.push(hour);
    }
    return hours;
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
    const actualPoints = visible("actual", toAveragePower(payload.series.actual, { bucketMinutes: this._slotMinutes }));
    const invalidatedPoints = visible("actual", toAveragePower(payload.series.invalidated, { bucketMinutes: this._slotMinutes }));

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
      this._slotMinutes,
    );

    return svg`
      ${rawPoints.length > 1
        ? this._renderForecastSplit(rawPoints, measured, (entry) => entry.minutes, linePath, CHART_COLORS.raw)
        : rawPoints.length === 1
          ? svg`<circle cx=${xForMinutes(rawPoints[0].minutes)} cy=${yForW(rawPoints[0].powerW)} r="3.5" fill=${CHART_COLORS.raw}></circle>`
          : ""}
      ${invalidatedPoints.map((entry) => svg`
        <circle cx=${xForMinutes(entry.minutes)} cy=${yForW(entry.powerW)} r="3.5" style="fill: var(--helman-neutral-light);" opacity="0.55">
          <title>${this._t("bias_correction.inspector.invalidated_production")}</title>
        </circle>
      `)}
    `;
  }

  /**
   * Battery state of charge, as a column per slot below the power chart.
   *
   * SoC is a level, not a flow, so it does not belong in a plot whose y axis is
   * watts. Given its own strip it keeps the chart's x scale — a column sits
   * under the power it produced — while its height reads against the battery's
   * own scale: empty, the configured floor and ceiling it is held between, and
   * full.
   */
  private _renderSocStrip(payload: InspectorPayload, layout: ChartLayout) {
    const bars = this._socBars(payload);
    if (!bars.length) return "";
    const { height, padTop, padBottom } = SOC_STRIP;
    const innerHeight = height - padTop - padBottom;
    const yForPct = (pct: number) =>
      padTop + (1 - Math.max(0, Math.min(100, pct)) / 100) * innerHeight;
    const barWidth = Math.max(3, layout.slotWidth);
    return svg`
      <svg
        viewBox="0 0 ${layout.width} ${height}"
        role="img"
        aria-label=${this._t("bias_correction.inspector.battery_soc_strip")}
        style="cursor: pointer;"
        @click=${(e: MouseEvent) => this._handleChartClick(e, payload)}
        @mousemove=${(e: MouseEvent) => this._handleChartHover(e, payload)}
        @mouseleave=${() => this._clearHover()}
      >
        <defs>
          <!-- The scrim darkens whatever it covers, so the strokes are light in
               both themes: dark-on-dark would read as a solid band, not a hatch. -->
          <pattern id=${SOC_UNUSABLE_HATCH_ID} patternUnits="userSpaceOnUse"
                   width="5" height="5" patternTransform="rotate(45)">
            <rect width="5" height="5" fill="#000" fill-opacity="0.45"></rect>
            <line x1="0" y1="0" x2="0" y2="5" stroke="#fff"
                  stroke-width="1.8" stroke-opacity="0.4"></line>
          </pattern>
        </defs>
        ${this._plotClipDef("plot-clip-soc", layout, height)}
        ${this._renderSocGridlines(layout, yForPct)}
        ${this._renderHoverHighlight(layout, 0, height)}
        ${this._renderSlotHighlights(layout, 0, height)}
        <g clip-path="url(#plot-clip-soc)">
        ${bars.map((bar) => {
          const top = yForPct(bar.pct);
          const color = SOC_DIRECTION_COLOR[bar.direction];
          const opacity = bar.forecast
            ? SOC_COLUMN_OPACITY.forecast
            : SOC_COLUMN_OPACITY.measured;
          return svg`
            <rect
              x=${layout.xForMinutes(bar.minutes) + 0.5} y=${top}
              width=${Math.max(2, barWidth - 1)} height=${Math.max(1, yForPct(0) - top)}
              style=${`fill: ${color}; stroke: ${color};`}
              fill-opacity=${opacity}
              stroke-width=${bar.forecast ? 0.9 : 0}
              stroke-dasharray=${bar.forecast ? "2 2" : ""}
            >
              <title>${bar.slot} ${this._formatPct(bar.pct)} · ${this._t(
                `bias_correction.inspector.soc_direction.${bar.direction}`,
              )}</title>
            </rect>
          `;
        })}
        ${this._renderSocUnusableZones(payload, layout, yForPct)}
        </g>
      </svg>
    `;
  }

  /** The columns of the strip: measured where measured, forecast beyond. */
  private _socBars(payload: InspectorPayload): SocBar[] {
    const actual = this._isSeriesVisible("batterySocActual") ? payload.series.batterySocActual : [];
    const forecast = this._isSeriesVisible("batterySocForecast")
      ? payload.series.batterySocForecast
      : [];
    return buildSocBars(actual, forecast, this._lastForecastFillFrom);
  }

  /** The two levels a column is read against: empty and full. */
  private _renderSocGridlines(layout: ChartLayout, yForPct: (pct: number) => number) {
    const xLeft = layout.margin.left;
    const xRight = layout.width - layout.margin.right;
    return [0, 100].map((pct) => svg`
      <line x1=${xLeft} y1=${yForPct(pct)} x2=${xRight} y2=${yForPct(pct)}
            stroke="var(--divider-color)" stroke-width="1"></line>
      <text x=${xLeft - 8} y=${yForPct(pct) + 4} text-anchor="end"
            fill="var(--secondary-text-color)" font-size="11">${pct}%</text>
    `);
  }

  /**
   * The SoC a slot could never reach: below its floor and above its ceiling.
   *
   * Both bounds are entities the day can move, so each slot is hatched against
   * its own window rather than the whole strip against one pair of lines. The
   * hatch lies over the columns, mostly transparent, so a column that strays
   * outside its window — a floor raised above where the battery already sat —
   * still reads through it.
   */
  private _renderSocUnusableZones(
    payload: InspectorPayload,
    layout: ChartLayout,
    yForPct: (pct: number) => number,
  ) {
    const slotWidth = layout.slotWidth;
    /** `edge` is the side facing the SoC the battery may actually reach. */
    const zone = (minutes: number, topPct: number, bottomPct: number, edge: "top" | "bottom") => {
      const y = yForPct(topPct);
      const height = yForPct(bottomPct) - y;
      if (height <= 0) return "";
      const x = layout.xForMinutes(minutes);
      const edgeY = edge === "top" ? y : y + height;
      return svg`
        <rect x=${x} y=${y} width=${slotWidth} height=${height}
              fill=${`url(#${SOC_UNUSABLE_HATCH_ID})`} pointer-events="none"></rect>
        <line x1=${x} y1=${edgeY} x2=${x + slotWidth} y2=${edgeY}
              stroke="var(--primary-text-color)" stroke-width="1" stroke-opacity="0.7"
              pointer-events="none"></line>
      `;
    };
    return payload.batterySocBounds.map((bound) => {
      const minutes = slotToMinutes(bound.slot);
      if (minutes === null) return "";
      return svg`
        ${bound.minPct === null ? "" : zone(minutes, bound.minPct, 0, "top")}
        ${bound.maxPct === null ? "" : zone(minutes, 100, bound.maxPct, "bottom")}
      `;
    });
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
        @mousemove=${(e: MouseEvent) => this._handleChartHover(e, payload)}
        @mouseleave=${() => this._clearHover()}
      >
        ${this._plotClipDef("plot-clip-impact", layout, stripHeight)}
        ${this._renderHoverHighlight(layout, 0, stripHeight)}
        ${this._renderSlotHighlights(layout, 0, stripHeight)}
        <g clip-path="url(#plot-clip-impact)">
        ${payload.series.impact.map((point) => {
          if (point.impactWh === null || !Number.isFinite(point.impactWh)) return "";
          const m = /^(\d{2}):(\d{2})$/.exec(point.slot);
          if (!m) return "";
          const minutes = Number(m[1]) * 60 + Number(m[2]);
          const x = layout.xForMinutes(minutes);
          const w = Math.max(3, layout.slotWidth);
          const h = Math.max(2, (Math.abs(point.impactWh) / maxImpact) * (stripHeight - 4));
          const y = stripHeight - h - 2;
          const trainingSlot = explainability?.slots[point.slot] ?? null;
          const interpolated = trainingSlot?.interpolated === true;
          const untrained = !interpolated && (trainingSlot === null || trainingSlot.factor === null);
          const positive = point.impactWh >= 0;
          const selected = selectedSlot === point.slot;
          const fill = untrained
            ? "var(--helman-neutral-light)"
            : interpolated
              ? positive ? "url(#impact-interpolated-positive)" : "url(#impact-interpolated-negative)"
              : positive ? CHART_COLORS.impactPositive : CHART_COLORS.impactNegative;
          const fillOpacity = untrained ? "0.45" : interpolated ? "1" : "0.55";
          const strokeColor = selected ? "var(--primary-text-color)" : "transparent";
          const strokeWidth = selected ? "1.5" : "0";
          return svg`
            <rect x=${x} y=${y} width=${w} height=${h}
                  fill-opacity=${fillOpacity} stroke-width=${strokeWidth}
                  style="fill: ${fill}; stroke: ${strokeColor}; pointer-events: none;">
              <title>${point.slot} ${this._formatSignedWh(point.impactWh)}</title>
            </rect>
          `;
        })}
        </g>
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

  /** The slot the detail panel and training table follow. */
  private get _selectedSlot(): string | null {
    return this._slotSelection.focusSlot;
  }

  /**
   * The day's impact slots in chronological order — the selection's universe.
   * Always on the active slot width, so a selection can never hold a slot the
   * charts aren't drawing.
   */
  private _orderedSlots(payload: InspectorPayload | null): string[] {
    const source = payload ?? (this._payload ? this._viewForSlot(this._payload) : null);
    return source?.series.impact.map((point) => point.slot) ?? [];
  }

  private _selectSlot(
    slot: string,
    mode: SlotSelectionMode = "replace",
    payload?: InspectorPayload,
  ) {
    this._applySelection(applySlotSelection({
      orderedSlots: this._orderedSlots(payload ?? null),
      selection: this._slotSelection,
      target: slot,
      mode,
    }));
  }

  private _deselectSlot() {
    this._applySelection(EMPTY_SLOT_SELECTION);
  }

  /** Commit a selection and re-derive everything that hangs off the focus slot. */
  private _applySelection(next: SlotSelectionState) {
    if (next === this._slotSelection) {
      return;
    }
    const focusChanged = next.focusSlot !== this._slotSelection.focusSlot;
    this._slotSelection = next;
    if (focusChanged) {
      this._selectedTrainingDate = next.focusSlot === null
        ? null
        : this._resolveSelectedTrainingDate(next.focusSlot);
      if (next.focusSlot !== null) {
        this._trainingTableCollapsed = true;
      }
    }
  }

  private _renderTotals(payload: InspectorPayload) {
    return html`
      <div class="metrics-section">
        <strong>${this._t("bias_correction.inspector.daily_totals")}</strong>
        <div class="metric-grid">
          ${this._isSeriesVisible("raw")
            ? this._renderMetric(this._t("bias_correction.inspector.raw_forecast"), this._formatWh(payload.totals.rawWh), CHART_COLORS.raw, true, "raw")
            : ""}
          ${this._renderMergedMetric(
            this._t("bias_correction.inspector.merged.solar"),
            CHART_COLORS.corrected,
            this._mergedPart(payload.totals.correctedWh, (v) => this._formatWh(v), this._t("bias_correction.inspector.corrected_forecast")),
            this._mergedPart(payload.totals.actualWh, (v) => this._formatWh(v), this._t("bias_correction.inspector.actual_production")),
            "corrected",
            "actual",
          )}
          ${this._renderMergedMetric(
            this._t("bias_correction.inspector.merged.house"),
            CHART_COLORS.house,
            this._mergedPart(negateWh(payload.totals.houseForecastWh), (v) => this._formatWh(v), this._t("bias_correction.inspector.house_forecast")),
            this._mergedPart(negateWh(payload.totals.houseActualWh), (v) => this._formatWh(v), this._t("bias_correction.inspector.house_actual")),
            "houseForecast",
            "houseActual",
          )}
          ${this._renderMergedMetric(
            this._t("bias_correction.inspector.merged.grid"),
            CHART_COLORS.grid,
            this._mergedPart(negateWh(payload.totals.gridForecastWh), (v) => this._formatWh(v), this._t("bias_correction.inspector.grid_forecast")),
            this._mergedPart(negateWh(payload.totals.gridActualWh), (v) => this._formatWh(v), this._t("bias_correction.inspector.grid_actual")),
            "gridForecast",
            "gridActual",
          )}
          ${this._renderMergedMetric(
            this._t("bias_correction.inspector.merged.battery"),
            CHART_COLORS.battery,
            this._mergedPart(negateWh(payload.totals.batteryForecastWh), (v) => this._formatWh(v), this._t("bias_correction.inspector.battery_forecast")),
            this._mergedPart(negateWh(payload.totals.batteryActualWh), (v) => this._formatWh(v), this._t("bias_correction.inspector.battery_actual")),
            "batteryForecast",
            "batteryActual",
          )}
        </div>
      </div>
    `;
  }

  /** The selection, narrowed to slots the day actually has, in chronological order. */
  private _selectedSlotsIn(payload: InspectorPayload): string[] {
    const available = new Set(payload.series.impact.map((point) => point.slot));
    return this._slotSelection.selectedSlots.filter((slot) => available.has(slot));
  }

  /**
   * The selection as the time it actually covers — "13:00 – 14:00" rather than the
   * bare start of one slot, so the heading says what span its sums are for. Each
   * slot runs to the next boundary at the active width; adjacent slots merge into
   * one span, and a selection with gaps lists each run, so the label can never
   * imply time that isn't selected. Midnight at the end of the day reads "24:00".
   */
  private _formatSelectionRange(slots: readonly string[]): string {
    const runs: Array<[number, number]> = [];
    for (const slot of slots) {
      const start = slotToMinutes(slot);
      if (start === null) continue;
      const end = start + this._slotMinutes;
      const last = runs[runs.length - 1];
      if (last && last[1] === start) {
        last[1] = end;
      } else {
        runs.push([start, end]);
      }
    }
    if (runs.length === 0) return slots.join(", ");
    return runs
      .map(([start, end]) => `${minutesToSlot(start)} – ${end >= 24 * 60 ? "24:00" : minutesToSlot(end)}`)
      .join(", ");
  }

  /**
   * The metrics for the whole selection, not just the focus slot: every energy
   * figure is the sum across the selected slots, aggregated by the same rules the
   * slot-width buttons use. The training diagnostics below stay on the focus slot
   * — a correction factor is fitted per slot, so there is nothing to sum.
   */
  private _renderSelectedSlotDetails(payload: InspectorPayload) {
    const slots = this._selectedSlotsIn(payload);
    const selectedSlot = resolveSelectedImpactSlot(payload.series.impact, this._selectedSlot)
      ?? slots[0]
      ?? null;
    if (!selectedSlot || slots.length === 0) return "";
    const impact = aggregateImpactOverSlots(payload.series.impact, slots);
    const rawWh = sumWhOverSlots(payload.series.raw, slots);
    const correctedWh = sumWhOverSlots(payload.series.corrected, slots);
    const actualWh = sumWhOverSlots(payload.series.actual, slots);
    const trainingSlot = findTrainingSlot(payload.trainingExplainability, selectedSlot);
    const houseFcWh = sumWhOverSlots(payload.series.houseForecast, slots);
    const houseAcWh = sumWhOverSlots(payload.series.houseActual, slots);
    const houseBreakdown = aggregateBreakdownOverSlots(
      payload.series.houseActualBreakdown,
      slots,
    );
    const batterySocFc = socAtSelectionStart(payload.series.batterySocForecast, slots);
    const batterySocAc = socAtSelectionStart(payload.series.batterySocActual, slots);
    const gridFcWh = sumWhOverSlots(payload.series.gridForecast, slots);
    const gridAcWh = sumWhOverSlots(payload.series.gridActual, slots);
    const batteryFcWh = sumWhOverSlots(payload.series.batteryForecast, slots);
    const batteryAcWh = sumWhOverSlots(payload.series.batteryActual, slots);
    const interpolated = trainingSlot?.interpolated === true;
    const anchors = trainingSlot?.interpolationAnchors ?? null;
    const impactColor = (impact?.impactWh ?? null) === null
      ? undefined
      : (impact!.impactWh! >= 0 ? CHART_COLORS.impactPositive : CHART_COLORS.impactNegative);
    // The bias-correction internals (impact, factor, interpolation, training
    // contributions) ride along with the raw forecast: hidden by default, they
    // surface only once the raw diagnostic is turned on.
    const showDiagnostics = this._isSeriesVisible("raw");
    return html`
      <div class="metrics-section">
        <strong>
          ${this._tFormat("bias_correction.inspector.selected_slot", {
            slot: this._formatSelectionRange(slots),
          })}
          ${interpolated && showDiagnostics
            ? html`<span class="interpolation-note" title=${this._t("bias_correction.inspector.interpolated_explanation")}>
                ${this._tFormat("bias_correction.inspector.interpolated_from", {
                  left: anchors?.left ?? this._t("bias_correction.inspector.interpolated_anchor_zero"),
                  right: anchors?.right ?? this._t("bias_correction.inspector.interpolated_anchor_zero"),
                })}
              </span>`
            : ""}
        </strong>
        ${interpolated && showDiagnostics
          ? html`<div class="day-state">${this._t("bias_correction.inspector.interpolated_explanation")}</div>`
          : ""}
        <div class="metric-grid">
          ${this._isSeriesVisible("raw")
            ? this._renderMetric(this._t("bias_correction.inspector.raw_forecast"), this._formatWh(rawWh ?? impact?.rawWh ?? null), CHART_COLORS.raw, true, "raw")
            : ""}
          ${this._renderMergedMetric(
            this._t("bias_correction.inspector.merged.solar"),
            CHART_COLORS.corrected,
            this._mergedPart(correctedWh ?? impact?.correctedWh ?? null, (v) => this._formatWh(v), this._t("bias_correction.inspector.corrected_forecast")),
            this._mergedPart(actualWh, (v) => this._formatWh(v), this._t("bias_correction.inspector.actual_production")),
            "corrected",
            "actual",
          )}
          ${this._renderMergedMetric(
            this._t("bias_correction.inspector.merged.house"),
            CHART_COLORS.house,
            this._mergedPart(negateWh(houseFcWh), (v) => this._formatWh(v), this._t("bias_correction.inspector.house_forecast")),
            this._mergedPart(negateWh(houseAcWh), (v) => this._formatWh(v), this._t("bias_correction.inspector.house_actual")),
            "houseForecast",
            "houseActual",
          )}
          ${showDiagnostics
            ? this._renderMetric(this._t("bias_correction.inspector.correction_impact"), this._formatSignedWh(impact?.impactWh ?? null), impactColor)
            : ""}
          ${showDiagnostics
            ? this._renderMetric(this._t("bias_correction.inspector.factor"), this._formatFactor(impact?.factor ?? trainingSlot?.factor ?? null), impactColor)
            : ""}
          ${this._renderMergedMetric(
            this._t("bias_correction.inspector.merged.battery_soc"),
            CHART_COLORS.battery,
            this._mergedPart(batterySocFc?.pct ?? null, (v) => this._formatPct(v), this._t("bias_correction.inspector.battery_soc_forecast")),
            this._mergedPart(batterySocAc?.pct ?? null, (v) => this._formatPct(v), this._t("bias_correction.inspector.battery_soc_actual")),
            "batterySocForecast",
            "batterySocActual",
          )}
          ${this._renderMergedMetric(
            this._t("bias_correction.inspector.merged.grid"),
            CHART_COLORS.grid,
            this._mergedPart(negateWh(gridFcWh), (v) => this._formatWh(v), this._t("bias_correction.inspector.grid_forecast")),
            this._mergedPart(negateWh(gridAcWh), (v) => this._formatWh(v), this._t("bias_correction.inspector.grid_actual")),
            "gridForecast",
            "gridActual",
          )}
          ${this._renderMergedMetric(
            this._t("bias_correction.inspector.merged.battery"),
            CHART_COLORS.battery,
            this._mergedPart(negateWh(batteryFcWh), (v) => this._formatWh(v), this._t("bias_correction.inspector.battery_forecast")),
            this._mergedPart(negateWh(batteryAcWh), (v) => this._formatWh(v), this._t("bias_correction.inspector.battery_actual")),
            "batteryForecast",
            "batteryActual",
          )}
        </div>
      </div>
      ${this._renderHouseBreakdown(
        houseBreakdown,
        payload.houseUnmeasuredLabel,
        slots,
      )}
      ${showDiagnostics ? this._renderContributionTable(payload, selectedSlot, trainingSlot) : ""}
    `;
  }

  /**
   * The measured house demand for the selected slot split into each individually
   * metered consumer plus whatever no meter accounted for, so the single house
   * figure above reads as a sum of named parts. Every row carries a proportion bar
   * sized to its share of the slot total, and the parts reconcile with the
   * house-actual value by construction. Rendered only when the backend supplied a
   * breakdown — consumers configured and the day elapsed — so a bare house figure
   * simply stands alone.
   *
   * `unmeasuredLabel` is the power card's own configured title for unmetered load,
   * so both views name the concept identically; it falls back to this card's
   * localized string when the card leaves it unset.
   */
  private _renderHouseBreakdown(
    breakdown: HouseBreakdownPoint | null,
    unmeasuredLabel: string | null,
    slots: readonly string[],
  ) {
    if (!breakdown) return "";
    // Bars read off the backend's native 15-minute grid rather than the width the
    // chart is drawn at, so selecting one hour shows the four samples inside it —
    // the shape of the consumption, not a single flat block.
    const native = this._payload?.series;
    if (!native) return "";
    const barSlots = expandSlotsToNative(slots, this._slotMinutes);
    // How the house was fed in each of those samples, shared by every consumer:
    // the mix is a house-level property, so it is derived once and then rescaled
    // per consumer rather than recomputed box by box.
    const mixes = houseSourceMixBySlot(native, barSlots);
    // Every box reads the same series over the same samples; only which part it
    // asks for differs.
    const barsFor = (entityId: string | null | undefined) =>
      consumerBarsOverSlots(native.houseActualBreakdown, barSlots, entityId, mixes);

    const consumers = breakdown.appliances.filter(
      (appliance) => Number.isFinite(appliance.wh) && appliance.wh > 0,
    );
    // What no meter claimed. This is deliberately not the forecast's
    // non-deferrable base load — it is the same idea as the power card's
    // "unmeasured" node, so it borrows that node's configured title. Like the
    // consumer boxes it is dropped when it carries nothing, so an empty slot — or
    // one whose whole demand is metered — shows no dead box.
    const unmeasuredWh = Number.isFinite(breakdown.unmeasuredWh) ? breakdown.unmeasuredWh : 0;
    const total = consumers.reduce((sum, c) => sum + c.wh, 0) + Math.max(0, unmeasuredWh);
    if (total <= 0) return "";

    const nodes: DeviceNode[] = consumers.map((appliance) =>
      this._breakdownNode(
        appliance.entityId,
        appliance.label,
        appliance.wh,
        appliance.switchEntityId ?? null,
        appliance.powerEntityId ?? null,
        false,
        barsFor(appliance.entityId),
      ),
    );
    if (unmeasuredWh > 0) {
      nodes.push(
        this._breakdownNode(
          null,
          unmeasuredLabel || this._t("bias_correction.inspector.house_unmeasured"),
          unmeasuredWh,
          null,
          null,
          true,
          barsFor(null),
        ),
      );
    }
    // Ranked heaviest first so the slot's dominant load reads at a glance. The
    // remainder sorts by size like any other box rather than being pinned last,
    // or a large unmetered block would sit below trivial named ones.
    nodes.sort((a, b) => (b.powerValue ?? 0) - (a.powerValue ?? 0));

    // The house's own per-sample energy. Handing it down as the parent scales
    // every box's bars against the house exactly as the power card scales a child
    // against its parent, and gives each box its share-of-parent figure.
    const houseBars = barsFor(undefined);

    return html`
      <!-- No more-info handler here: power-device already turns its children's
           \`show-more-info\` into the \`hass-more-info\` request HA listens for, and
           that bubbles composed straight out of this card. Re-handling it would
           open every dialog twice. -->
      <div class="house-breakdown">
        <div class="house-breakdown-title">${this._t("bias_correction.inspector.house_composition")}</div>
        <power-devices-container
          .hass=${this.hass}
          .devices=${nodes}
          .currentParentPower=${total}
          .parentPowerHistory=${houseBars.values}
          .historyBuckets=${barSlots.length}
          .historyBucketDuration=${SLOT_MINUTES * 60}
          .devices_full_width=${true}
        ></power-devices-container>
      </div>
    `;
  }

  /**
   * One breakdown consumer as a power-card device node.
   *
   * The node carries no `sourceType`, so it draws no glow of its own and inherits
   * the house tint the panel sets — the same way the power card's own house
   * children do. Clicking the box opens the device's live power (W) sensor — the
   * very entity the power card reads — falling back to the energy stat only where
   * the tree resolved no power sensor; the unmetered remainder has neither and so
   * stays inert, exactly as it did before.
   */
  private _breakdownNode(
    entityId: string | null,
    label: string,
    wh: number,
    switchEntityId: string | null,
    powerEntityId: string | null,
    isUnmeasured: boolean,
    bars: ReturnType<typeof consumerBarsOverSlots>,
  ): DeviceNode {
    const node = new DeviceNode(
      entityId ?? "house-unmeasured",
      label,
      powerEntityId ?? entityId,
      switchEntityId,
      bars.values.length,
    );
    node.displayName = label;
    node.isUnmeasured = isUnmeasured;
    // Energy throughout — the selection's total on the box, each sample's own on
    // the bars — so the figures are the Wh the breakdown actually reports and no
    // unit conversion sits between the data and what is drawn.
    node.valueKind = "energy";
    node.powerValue = wh;
    node.powerHistory = bars.values;
    node.sourcePowerHistory = bars.sourceHistory.map((mix) => mix ?? {});
    node.hideChildren = true;
    node.hideChildrenIndicator = true;
    return node;
  }

  /** Ask HA to open an entity's more-info dialog; a no-op without an entity. */
  private _showMoreInfo(entityId: string | null) {
    if (!entityId) return;
    this.dispatchEvent(
      new CustomEvent("hass-more-info", {
        bubbles: true,
        composed: true,
        detail: { entityId },
      }),
    );
  }

  /**
   * The tinted fill that marks a value as forecast (hatched) or actual (flat).
   * Returns the bare CSS value so it can back either a whole card or a single
   * value chip inside a merged card.
   */
  private _seriesFill(color: string, forecast: boolean): string {
    return forecast
      ? `repeating-linear-gradient(-45deg, color-mix(in srgb, ${color} 18%, transparent) 0px, color-mix(in srgb, ${color} 18%, transparent) 3px, transparent 3px, transparent 8px)`
      : `color-mix(in srgb, ${color} 15%, transparent)`;
  }

  /**
   * One value inside a merged card, tagged with whether it is present so the
   * caller can drop the empty half. `title` names the underlying series for the
   * hover tooltip the merged label no longer spells out.
   */
  private _mergedPart(
    value: number | null,
    format: (value: number | null) => string,
    title: string,
  ): { value: string; present: boolean; title: string } {
    return {
      value: format(value),
      present: value !== null && Number.isFinite(value),
      title,
    };
  }

  /**
   * A forecast/actual pair drawn as a single card: the forecast value carries
   * the hatched fill and the actual value the flat fill, so the two read as one
   * quantity seen twice. When only one side has data the card shows just that
   * one. The whole card toggles both series at once.
   */
  private _renderMergedMetric(
    label: string,
    color: string,
    forecast: { value: string; present: boolean; title: string },
    actual: { value: string; present: boolean; title: string },
    forecastSeries: SeriesKey,
    actualSeries: SeriesKey,
  ) {
    // A chip has to stand out against the card's own colour wash, so its fill
    // runs stronger than the wash: the forecast keeps the hatch, the actual a
    // flat tint one step darker again.
    const chipFill = (isForecast: boolean): string =>
      isForecast
        ? `repeating-linear-gradient(-45deg, color-mix(in srgb, ${color} 42%, transparent) 0px, color-mix(in srgb, ${color} 42%, transparent) 3px, transparent 3px, transparent 7px)`
        : `color-mix(in srgb, ${color} 34%, transparent)`;
    const chip = (
      part: { value: string; title: string },
      isForecast: boolean,
    ): TemplateResult => html`
      <span
        class="metric-value metric-chip"
        style=${`background: ${chipFill(isForecast)};`}
        title=${part.title}
      >${part.value}</span>
    `;
    const chips: TemplateResult[] = [];
    if (actual.present) chips.push(chip(actual, false));
    if (forecast.present) chips.push(chip(forecast, true));
    // Neither side reported: keep a single placeholder so the card still reads.
    if (chips.length === 0) chips.push(chip(forecast, true));

    const visible =
      this._isSeriesVisible(forecastSeries) || this._isSeriesVisible(actualSeries);
    // Faint full-card wash plus a solid left rail, both in the series colour, so
    // the box is identifiable at a glance without drowning the chips.
    const cardStyle = `background: color-mix(in srgb, ${color} 12%, transparent); border-left: 3px solid ${color};`;
    return html`
      <button
        class="metric-card legend-toggle merged ${visible ? "" : "hidden-series"}"
        style=${cardStyle}
        type="button"
        aria-pressed=${visible ? "true" : "false"}
        title=${this._t(
          visible
            ? "bias_correction.inspector.legend_hide_series"
            : "bias_correction.inspector.legend_show_series",
        )}
        @click=${() => this._toggleSeriesGroup([forecastSeries, actualSeries], visible)}
      >
        <div class="metric-label">${label}</div>
        <div class="metric-chips">${chips}</div>
      </button>
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
    if (color) {
      background = `background: ${this._seriesFill(color, dashed === true)};`;
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
          <label class="impact-strip-switch">
            <input
              type="checkbox"
              .checked=${this._impactStripVisible}
              @change=${() => { this._impactStripVisible = !this._impactStripVisible; }}
            />
            ${this._t("bias_correction.inspector.show_impact_strip")}
          </label>
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
      payload.series.houseActualBreakdown ??= [];
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
      payload.houseUnmeasuredLabel ??= null;
      payload.batterySocBounds ??= [];
      if (requestId === this._activeRequestId && requestedDate === this._selectedDate) {
        this._payload = payload;
        const reconciled = reconcileSlotSelection(
          this._orderedSlots(null),
          this._slotSelection,
        );
        this._slotSelection = reconciled;
        this._selectedTrainingDate = this._resolveSelectedTrainingDate(
          reconciled.focusSlot,
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

  /**
   * Energy for display. Every figure on this card — summary metrics, the
   * contribution table, the composition boxes — goes through `formatEnergy`, so a
   * quantity reads the same wherever it appears and small values stay legible
   * instead of rounding away to "0.0 kWh".
   *
   * These wrappers own only what `formatEnergy` deliberately does not: what a
   * missing reading looks like, and whether a gain is written with its sign.
   */
  private _formatWh(value: number | null) {
    if (value === null || !Number.isFinite(value)) {
      return this._t("bias_correction.inspector.actual_not_available");
    }
    return formatEnergy(value).display;
  }

  private _formatSignedWh(value: number | null) {
    if (value === null || !Number.isFinite(value)) return this._t("bias_correction.inspector.actual_not_available");
    // formatEnergy carries a minus of its own; only a gain needs marking.
    const sign = value > 0 ? "+" : "";
    return `${sign}${formatEnergy(value).display}`;
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
    // Snap to the slot the pointer sits *inside* before resolving, so a click
    // anywhere across a slot's width selects it — the same slot hover highlights.
    // Resolving the raw pointer minute to the nearest slot *start* instead biased
    // the right half of every slot onto the next slot's start.
    const minutes = this._minutesForSvgX(layout, svgX);
    const slotStart = Math.floor(minutes / this._slotMinutes) * this._slotMinutes;
    const slot = this._findClosestImpactSlot(slotStart, payload.series.impact);
    if (slot) {
      this._selectSlot(slot, slotSelectionModeForEvent(event), payload);
    } else {
      this._deselectSlot();
    }
  }

  /** One highlight band per selected slot. */
  private _renderSlotHighlights(layout: ChartLayout, y: number, height: number) {
    return this._slotSelection.selectedSlots.map(
      (slot) => this._renderSlotHighlight(layout, y, height, slot),
    );
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
    // A slot cropped out of the daylight window has no place on the axis.
    if (minutes < layout.dayStartMinutes || minutes >= layout.dayEndMinutes) return "";
    const x = layout.xForMinutes(minutes);
    const w = Math.max(3, layout.slotWidth);
    return svg`
      <rect
        x=${x} y=${y} width=${w} height=${height}
        style="fill: color-mix(in srgb, var(--helman-grid-import) 13%, transparent); stroke: var(--helman-grid-import);"
        stroke-width="1" stroke-opacity="0.5"
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
