import { slotMinutes } from "../shared/time/slot-time";
import { LitElement, css, html, nothing, svg } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { HomeAssistant } from "../../types/ha";
import { getLocalizeFunction } from "../localize/localize";
import { helmanColorVars } from "../color-vars";
import { toAveragePower, type ChartEntry } from "./chart-power";
import { renderSlotGridlines, slotGridTicks, type SlotGridTick } from "../shared/slot-gridlines";
import { hourAnchorOffset, selectLabelledColumns, stripValueLabel } from "../shared/strip-value-labels";
import { accumulateBands, bandRuns, stackSlots, type StackBand, type StackSet } from "./chart-stack";
import { slotToMinutes, type SocBar } from "./chart-soc";
import { SOC_COLUMN_OPACITY, SOC_DIRECTION_COLOR } from "../shared/soc-columns";
import { ACTUAL_FILL_OPACITY, CHART_COLORS } from "./chart-colors";
import type { TooltipBody, TooltipRow } from "../shared/hover-tooltip";
import { breakdownCoversSlots, minutesToSlot, splitHouseByDeferrable, sumWhOverSlots } from "./slot-aggregation.js";
import {
  EMPTY_SLOT_SELECTION,
  slotSelectionModeForEvent,
  type SlotPickDetail,
  type SlotSelectionState,
} from "./slot-selection.js";
import { resolveSelectedImpactSlot } from "./solar-inspector-model.js";
import { renderNowMarkerOnDay } from "./now-marker.js";
import { renderSlotBand, svgXFromEvent } from "./strip-geometry";
import {
  EMPTY_DAY_COVERAGE,
  MINUTES_PER_DAY,
  isSeriesEnabled,
  isSeriesVisible,
  socForecastBars,
  type ChartLayout,
  type ChartStacks,
  type DayCoverage,
  type DayView,
  type InspectorPayload,
  type SeriesKey,
} from "./inspector-day-model";
import {
  FAMILIES,
  formatPartialBucketNote,
  formatPct,
  formatSignedWh,
  formatSlotRange,
  formatWh,
  negateWh,
  type Translate,
} from "./inspector-format";
import { chartFrameStyles } from "./inspector-styles";

/** Stroke opacity for forecast the actuals have already superseded. */
const MUTED_FORECAST_OPACITY = 0.35;

type StrokeStyle = { width: number; opacity: number };

const POWER_STROKE: StrokeStyle = { width: 2, opacity: 1 };

/** The SoC strip's own geometry; it borrows only the x scale from the chart. */
const SOC_STRIP = { height: 65, padTop: 8, padBottom: 8 } as const;

const SOC_UNUSABLE_HATCH_ID = "soc-unusable-hatch";

/**
 * The forecast's own fill, past the last actual. Its muting comes from the
 * hatch pattern being mostly transparent, so the paint itself stays near solid.
 */
const FORECAST_BAND_FILL_OPACITY = 0.9;
const FORECAST_OUTLINE: StrokeStyle = { width: 1.4, opacity: 0.55 };

/**
 * Band colours needing a hatch pattern; solar's forecast reuses the solar hue.
 *
 * Every colour a forecast band can be drawn in must be here: the fill is
 * `url(#hatchId(colour))`, and an unregistered pattern is not a fallback to the
 * flat colour — it paints the band black.
 */
const STACK_HATCH_COLORS = [
  CHART_COLORS.corrected,
  CHART_COLORS.house,
  CHART_COLORS.houseDeferrable,
  CHART_COLORS.battery,
  CHART_COLORS.grid,
] as const;

/** Patterns are referenced by url(#id), so each colour needs a stable id. */
function hatchId(color: string): string {
  return `stack-hatch-${color.replace("#", "")}`;
}

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

/**
 * The time grid for a layout: a line per slot, hours labelled as densely as
 * the plot's width allows. Every row under the chart draws the same ticks --
 * the inspector's schedule header included -- so the whole inspector is ruled
 * by one grid.
 */
export function chartGridTicks(layout: ChartLayout, slotMinutes: number): SlotGridTick[] {
  return slotGridTicks({
    startMinutes: layout.dayStartMinutes,
    endMinutes: layout.dayEndMinutes,
    slotMinutes,
    plotWidth: layout.plotWidth,
  });
}

/** The four things the combined chart stacks; one popup section per family. */
type TooltipFamily = "solar" | "house" | "battery" | "grid";

/** The slot a pointer is over on a row with a popup, and what the popup says. */
type ChartHit = { minutes: number; body: TooltipBody };

/**
 * The chart's popup, for the inspector to show on its shared controller: what
 * it says, and the pointer event it follows -- the controller anchors the popup
 * on that event's target and tells a hover from a tap by it. `tap` is a press,
 * which toggles the popup rather than showing it.
 */
export interface DayChartTooltipDetail {
  event: MouseEvent;
  body: TooltipBody;
  tap: boolean;
}

/**
 * The day view's combined chart, with the correction-impact strip and the
 * battery SoC strip under it: everything the inspector draws from its own
 * stacks and layout, as opposed to the strips that bucket their own series.
 *
 * Drawing only. The day model is derived by the inspector and handed down, and
 * what the pointer does is reported back up the way the strips report it: the
 * minute under it as `slot-hover`, a press as `slot-pick`, and the popup as
 * `slot-tooltip` (`DayChartTooltipDetail`, or null to hide it).
 */
@customElement("helman-solar-day-chart")
export class HelmanSolarDayChart extends LitElement {
  static styles = [helmanColorVars, chartFrameStyles, css`
    :host {
      display: block;
      width: 100%;
    }

    .chart-wrap svg {
      display: block;
      width: 100%;
      max-width: none;
      height: 260px;
    }

    .main-chart-wrap {
      position: relative;
      outline: none;
      border-radius: 0;
    }

    .soc-strip-wrap {
      margin-top: 0;
      width: 100%;
    }

    .soc-strip-wrap svg {
      display: block;
      width: 100%;
      height: 65px;
    }

    .impact-strip-wrap {
      margin-top: 4px;
      width: 100%;
    }

    .impact-strip-wrap svg {
      display: block;
      width: 100%;
      height: 24px;
    }
  `];

  @property({ attribute: false }) public hass?: HomeAssistant;
  /** The day at the active slot width. */
  @property({ attribute: false }) public view: DayView | null = null;
  @property({ attribute: false }) public stacks: ChartStacks | null = null;
  @property({ attribute: false }) public layout: ChartLayout | null = null;
  /** The SoC strip's columns; an empty list draws no strip. */
  @property({ attribute: false }) public socBars: readonly SocBar[] = [];
  @property({ type: Number }) public slotMinutes = 30;
  @property({ attribute: false }) public hiddenSeries: ReadonlySet<SeriesKey> = new Set();
  /** The series the card is allowed to draw, or undefined for all of them. */
  @property({ attribute: false }) public chartSeries?: readonly SeriesKey[];
  @property({ attribute: false }) public selection: SlotSelectionState = EMPTY_SLOT_SELECTION;
  @property({ attribute: false }) public hoverMinutes: number | null = null;
  /** Where the day is short of readings, for the partial-bucket marks. */
  @property({ attribute: false }) public coverage: DayCoverage = EMPTY_DAY_COVERAGE;
  @property({ type: Boolean }) public dimIncompleteSlots = true;
  @property({ type: Boolean }) public impactVisible = false;
  @property({ type: Boolean }) public houseFocus = false;
  /** The selected day, the zone it is read in and the clock, for the "now" line. */
  @property({ type: String }) public date = "";
  @property({ type: String }) public timeZone = "UTC";
  @property({ type: Number }) public nowMs = Date.now();

  /** The combined chart's popup, one build per hovered slot. */
  private _chartTooltip: { rows: TooltipRow[]; title: string } | null = null;
  private _chartTooltipFor:
    | {
      payload: InspectorPayload;
      slot: string;
      enabled: readonly SeriesKey[] | undefined;
      houseFocus: boolean;
      language: string | undefined;
    }
    | null = null;

  render() {
    const { view, stacks, layout } = this;
    if (!view || !stacks || !layout) return nothing;
    return html`
      <div class="chart-wrap main-chart-wrap">
        <span class="compact-strip-label">${this._t("bias_correction.inspector.energy_strip_compact")}</span>
        ${this._renderChart(view, stacks, layout)}
      </div>
      ${this.impactVisible
        ? html`<div class="impact-strip-wrap">${this._renderImpactStrip(view, layout)}</div>`
        : ""}
      ${this.socBars.length ? this._renderSocSection(view, layout) : ""}
    `;
  }

  private get _language(): string | undefined {
    return this.hass?.language || this.hass?.locale?.language;
  }

  private _t: Translate = (key, values) =>
    (this.hass ? getLocalizeFunction(this.hass) : (raw: string) => raw)(key, values);

  private _isSeriesEnabled(series: SeriesKey) {
    return isSeriesEnabled(this.chartSeries, series);
  }

  private _isSeriesVisible(series: SeriesKey) {
    return isSeriesVisible(this.hiddenSeries, this.chartSeries, series);
  }

  private _emitHover(minutes: number | null): void {
    this.dispatchEvent(new CustomEvent<{ minutes: number | null }>("slot-hover", {
      detail: { minutes },
      bubbles: true,
      composed: true,
    }));
  }

  private _emitTooltip(detail: DayChartTooltipDetail | null): void {
    this.dispatchEvent(new CustomEvent<DayChartTooltipDetail | null>("slot-tooltip", {
      detail,
      bubbles: true,
      composed: true,
    }));
  }

  /** The pointer left a row: no minute, no popup. */
  private _clearHover(): void {
    this._emitHover(null);
    this._emitTooltip(null);
  }

  /**
   * Publish the pointer's minute-of-day over any chart so every row can light its
   * own slot around it. The value is shared raw, not snapped to a slot: each row
   * decides how wide its highlight is, so an hour-wide price cell reads as the whole
   * hour while the chart above still tracks the 15-minute slot under the cursor.
   * Positions in the axis gutter clear the hover.
   */
  private _handleChartHover(event: MouseEvent, layout: ChartLayout) {
    const minutes = this._plotMinutesAt(event, layout);
    if (minutes === null) {
      this._clearHover();
      return;
    }
    this._emitHover(minutes);
  }

  /** The minute-of-day under the pointer on one of the chart's rows, or null in the axis gutter. */
  private _plotMinutesAt(event: MouseEvent, layout: ChartLayout): number | null {
    const svgX = svgXFromEvent(event, layout.width);
    if (svgX < layout.margin.left || svgX > layout.width - layout.margin.right) {
      return null;
    }
    const daySpan = layout.dayEndMinutes - layout.dayStartMinutes;
    return layout.dayStartMinutes + ((svgX - layout.margin.left) / layout.plotWidth) * daySpan;
  }

  /** Hover for a row with a popup: the minute and the popup of the hit, or neither off one. */
  private _handleHitHover(event: MouseEvent, hit: ChartHit | null) {
    if (hit === null) {
      this._clearHover();
      return;
    }
    this._emitHover(hit.minutes);
    this._emitTooltip({ event, body: hit.body, tap: false });
  }

  /**
   * A press on a row that has a popup: it selects, as any press on the chart
   * does, and is also a tap that opens or closes the popup -- the only way a
   * touch screen gets one, since a tap's emulated move is not a hover.
   */
  private _handleTap(event: MouseEvent, layout: ChartLayout, hit: ChartHit | null) {
    this._handlePick(event, layout);
    if (hit !== null) this._emitTooltip({ event, body: hit.body, tap: true });
  }

  /**
   * A press selects the slot the pointer sits *inside*, so a click anywhere
   * across a slot's width selects it -- the same slot hover highlights -- or,
   * in the axis gutter, clears the selection.
   */
  private _handlePick(event: MouseEvent, layout: ChartLayout) {
    this.dispatchEvent(new CustomEvent<SlotPickDetail>("slot-pick", {
      detail: { minutes: this._plotMinutesAt(event, layout), mode: slotSelectionModeForEvent(event) },
      bubbles: true,
      composed: true,
    }));
  }

  /**
   * The slot under the pointer on the combined chart, and its popup, or null
   * where there is none: a popup appears only once the cursor sits inside one
   * of the stacked bands actually drawn there -- solar, house, battery or grid
   * -- not merely somewhere in that slot's column, the way the highlight-only
   * hover treats the whole column height as active.
   */
  private _mainChartHit(
    event: MouseEvent,
    payload: InspectorPayload,
    stacks: ChartStacks,
    layout: ChartLayout,
  ): ChartHit | null {
    const minutes = this._plotMinutesAt(event, layout);
    if (minutes === null) return null;
    const slot = Math.floor(minutes / this.slotMinutes) * this.slotMinutes;
    const model = this._chartTooltipModel(payload, minutesToSlot(slot));
    if (!model.rows.length) return null;
    return {
      minutes: slot,
      body: { title: model.title, hasActual: slot < stacks.fillFromMinutes, rows: model.rows },
    };
  }

  /**
   * The popup's contents for one slot of the combined chart, built once per
   * slot rather than once per pointer report: sweeping across a column asks
   * this the same question thirty times over.
   */
  private _chartTooltipModel(payload: InspectorPayload, slot: string): { rows: TooltipRow[]; title: string } {
    if (this._chartTooltipFor === null
      || this._chartTooltipFor.payload !== payload
      || this._chartTooltipFor.slot !== slot
      || this._chartTooltipFor.enabled !== this.chartSeries
      || this._chartTooltipFor.houseFocus !== this.houseFocus
      || this._chartTooltipFor.language !== this._language) {
      this._chartTooltipFor = {
        payload,
        slot,
        enabled: this.chartSeries,
        houseFocus: this.houseFocus,
        language: this._language,
      };
      this._chartTooltip = {
        rows: this._allSeriesTooltipRows(payload, slot),
        title: formatSlotRange([slot], this.slotMinutes),
      };
    }
    return this._chartTooltip!;
  }

  /** Every family's rows for the hovered slot, in one popup. */
  private _allSeriesTooltipRows(payload: InspectorPayload, slot: string): TooltipRow[] {
    const families: TooltipFamily[] = ["solar", "house", "battery", "grid"];
    return families
      .flatMap((family) => {
        // A series the config left out is not quoted here either: a popup is as
        // much a reading of the series as the band it is taken from. Whole
        // families drop out, and a half-dropped pair loses that column -- the
        // rows of one family all speak for the same two series, so this is the
        // one place it has to be said.
        const { actual: actualSeries, forecast: forecastSeries } = FAMILIES[family];
        const actualOn = this._isSeriesEnabled(actualSeries);
        const forecastOn = this._isSeriesEnabled(forecastSeries);
        if (!actualOn && !forecastOn) return [];
        const rows = this._seriesTooltipRows(payload, family, slot);
        if (actualOn && forecastOn) return rows;
        return rows.map((row) => ({
          ...row,
          actual: actualOn ? row.actual : null,
          forecast: forecastOn ? row.forecast : null,
        }));
      })
      .filter((row) => row.actual !== null || row.forecast !== null);
  }

  /** One row's actual/forecast pair as Wh, formatted, colour-matched to its series. */
  private _powerRow(
    label: string,
    color: string,
    actualWh: number | null,
    forecastWh: number | null,
  ): TooltipRow {
    return {
      label,
      actual: actualWh === null ? null : { value: formatWh(this._t, actualWh), color },
      forecast: forecastWh === null ? null : { value: formatWh(this._t, forecastWh), color },
    };
  }

  /** A family's row, named, coloured and signed the way its tiles are. */
  private _familyRow(family: TooltipFamily, actualWh: number | null, forecastWh: number | null): TooltipRow {
    const { label, color, sign } = FAMILIES[family];
    const signed = (wh: number | null) => (sign < 0 ? negateWh(wh) : wh);
    return this._powerRow(this._t(`bias_correction.inspector.${label}`), color, signed(actualWh), signed(forecastWh));
  }

  /** The forecast/actual pair for one hovered family, at the single hovered slot. */
  private _seriesTooltipRows(
    payload: InspectorPayload,
    family: TooltipFamily,
    slot: string,
  ): TooltipRow[] {
    const slots = [slot];
    switch (family) {
      case "solar":
        return [
          this._familyRow(
            "solar",
            // An invalidated slot is still a measurement -- the chart draws it
            // -- only one training ignores. The backend moves it out of
            // `actual`, so the two never overlap.
            sumWhOverSlots([...payload.series.actual, ...payload.series.invalidated], slots),
            sumWhOverSlots(payload.series.corrected, slots),
          ),
        ];
      case "house": {
        // Both columns are split the same way the two bands are, so each row
        // compares like with like: what was shifted against what was scheduled,
        // and the rest of the house against the rest of the forecast. With
        // nothing shiftable on either side the pair collapses back to the single
        // house row it always was, rather than growing a permanent zero row.
        //
        // Over elapsed slots the forecast has no composition to split by -- only
        // its scalar survives in the recorder. Splitting the actual there would
        // leave the forecast column empty under a drawn forecast line, and
        // quoting that scalar as the non-deferrable half would understate one
        // row by what it overstates the other; so the pair collapses to the two
        // totals. The house embed always quotes the totals: they are what it
        // judges.
        const actual = splitHouseByDeferrable(
          payload.series.houseActual,
          payload.series.houseActualBreakdown,
        );
        const forecast = splitHouseByDeferrable(
          payload.series.houseForecast,
          payload.series.houseForecastBreakdown,
        );
        const forecastSplit = breakdownCoversSlots(
          payload.series.houseForecastBreakdown,
          slots,
        );
        const actualDeferrableWh = sumWhOverSlots(actual.deferrable, slots);
        const forecastDeferrableWh = forecastSplit
          ? sumWhOverSlots(forecast.deferrable, slots)
          : null;
        const forecastWh = sumWhOverSlots(payload.series.houseForecast, slots);
        if (this.houseFocus
          || (forecastWh !== null && !forecastSplit)
          || (!actualDeferrableWh && !forecastDeferrableWh)) {
          return [
            this._familyRow("house", sumWhOverSlots(payload.series.houseActual, slots), forecastWh),
          ];
        }
        return [
          this._powerRow(
            this._t("bias_correction.inspector.merged.house_non_deferrable"),
            CHART_COLORS.house,
            negateWh(sumWhOverSlots(actual.nonDeferrable, slots)),
            forecastSplit ? negateWh(sumWhOverSlots(forecast.nonDeferrable, slots)) : null,
          ),
          this._powerRow(
            this._t("bias_correction.inspector.merged.house_deferrable"),
            CHART_COLORS.houseDeferrable,
            negateWh(actualDeferrableWh),
            negateWh(forecastDeferrableWh),
          ),
        ];
      }
      case "grid":
        return [
          this._familyRow(
            "grid",
            sumWhOverSlots(payload.series.gridActual, slots),
            sumWhOverSlots(payload.series.gridForecast, slots),
          ),
        ];
      case "battery":
        // SoC has its own strip right below with its own popup; this one is
        // about power, so it stops at the battery's watts like the others.
        return [
          this._familyRow(
            "battery",
            sumWhOverSlots(payload.series.batteryActual, slots),
            sumWhOverSlots(payload.series.batteryForecast, slots),
          ),
        ];
    }
  }

  /**
   * The hovered slot on a 15-minute chart, drawn from the shared hover minute. The
   * strips below compute their own wider bands from the same minute, so each row
   * highlights the true width of its slot. Orange, distinct from the blue selection.
   */
  private _renderHoverHighlight(layout: ChartLayout, y: number, height: number) {
    if (this.hoverMinutes === null) return "";
    const start = Math.floor(this.hoverMinutes / this.slotMinutes) * this.slotMinutes;
    const x = layout.xForMinutes(start);
    return renderSlotBand(x, Math.max(2, layout.xForMinutes(start + this.slotMinutes) - x), y, height, "hover");
  }

  /** The battery SoC strip. */
  private _renderSocSection(payload: InspectorPayload, layout: ChartLayout) {
    return html`
      <div class="compact-strip-section chart-separator">
        <span class="compact-strip-label">${this._t("bias_correction.inspector.battery_soc_strip_compact")}</span>
        <div class="soc-strip-wrap">${this._renderSocStrip(payload, layout)}</div>
      </div>
    `;
  }

  private _renderChart(payload: InspectorPayload, stacks: ChartStacks, layout: ChartLayout) {
    // The seam is derived with the stacks; the SoC columns below are built off
    // the same one, so they turn forecast where the stacks above turn hatched.
    const forecastFillFrom = stacks.fillFromMinutes;
    return svg`
      <svg
        viewBox="0 0 ${layout.width} ${layout.height}"
        role="img"
        aria-label=${this._t("bias_correction.inspector.title")}
        style="cursor: pointer;"
        @click=${(e: MouseEvent) => this._handleTap(e, layout, this._mainChartHit(e, payload, stacks, layout))}
        @mousemove=${(e: MouseEvent) => this._handleHitHover(e, this._mainChartHit(e, payload, stacks, layout))}
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
        <!-- Over the bands, not under them: the mark has to take colour out of
             the column it covers, and a wash painted underneath only lightens
             the empty background around the bars, which reads as a highlight --
             the opposite of what a short column should look like. -->
        ${this._renderPartialBuckets(layout, layout.margin.top, layout.plotHeight)}
        ${this._renderNowMarker(layout, layout.margin.top, layout.plotHeight)}
      </svg>
    `;
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
    const slots = stackSlots(set, this.slotMinutes);
    if (!slots.length) return "";
    const { xForMinutes, yForW } = layout;
    // Each slot's power is an average over the interval that starts at it, so a
    // band is a run of rectangles, not a sloped ribbon between sample points.
    const stepEdge = (slot: number, level: Map<number, number>) => [
      [xForMinutes(slot), yForW(level.get(slot)!)] as const,
      [xForMinutes(slot + this.slotMinutes), yForW(level.get(slot)!)] as const,
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
      const fillOpacity = forecast ? FORECAST_BAND_FILL_OPACITY : ACTUAL_FILL_OPACITY;
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
    return renderSlotGridlines({
      ticks: chartGridTicks(layout, this.slotMinutes),
      xForMinutes,
      top: margin.top,
      bottom: height - margin.bottom,
      labelY: height - 10,
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
    const actualPoints = visible("actual", toAveragePower(payload.series.actual, { bucketMinutes: this.slotMinutes }));
    const invalidatedPoints = visible("actual", toAveragePower(payload.series.invalidated, { bucketMinutes: this.slotMinutes }));

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
      this.slotMinutes,
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
    const bars = this.socBars;
    if (!bars.length) return "";
    const { height } = SOC_STRIP;
    const yForPct = (pct: number) => this._yForSocPct(pct);
    const barWidth = Math.max(3, layout.slotWidth);
    return svg`
      <svg
        viewBox="0 0 ${layout.width} ${height}"
        role="img"
        aria-label=${this._t("bias_correction.inspector.battery_soc_strip")}
        style="cursor: pointer;"
        @click=${(e: MouseEvent) => this._handleTap(e, layout, this._socHit(e, payload, layout, bars))}
        @mousemove=${(e: MouseEvent) => this._handleHitHover(e, this._socHit(e, payload, layout, bars))}
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
        ${renderSlotGridlines({
          ticks: chartGridTicks(layout, this.slotMinutes),
          xForMinutes: layout.xForMinutes,
          top: 0,
          bottom: height,
        })}
        ${this._renderHoverHighlight(layout, 0, height)}
        ${this._renderSlotHighlights(layout, 0, height)}
        <g clip-path="url(#plot-clip-soc)">
        ${bars.map((bar) => {
          const top = yForPct(bar.pct);
          const color = SOC_DIRECTION_COLOR[bar.direction];
          const opacity = bar.forecast
            ? SOC_COLUMN_OPACITY.forecast
            : SOC_COLUMN_OPACITY.measured;
          const x = layout.xForMinutes(bar.minutes) + 0.5;
          return svg`
            <rect
              x=${x} y=${top}
              width=${Math.max(2, barWidth - 1)} height=${Math.max(1, yForPct(0) - top)}
              style=${`fill: ${color}; stroke: ${color};`}
              fill-opacity=${opacity}
              stroke-width=${bar.forecast ? 0.9 : 0}
              stroke-dasharray=${bar.forecast ? "2 2" : ""}
            ></rect>
          `;
        })}
        ${this._renderSocForecastLine(payload, bars, layout, yForPct)}
        ${this._renderSocUnusableZones(payload, layout, yForPct)}
        </g>
        ${this._renderNowMarker(layout, 0, height)}
        <!-- The percentages come after the marker so the line runs behind the
             two digits it crosses rather than through them. -->
        <g clip-path="url(#plot-clip-soc)">
        ${(() => {
          // Scoped to the window the plot draws, not the whole day: the columns
          // beyond it are clipped away, and letting them into the selection
          // spends the "keep the two ends" rule on midnight and 23:45 -- ends
          // nobody can see -- and judges the series on hours nobody is reading.
          const labels = bars.map((bar) => bar.minutes < layout.dayStartMinutes
            || bar.minutes >= layout.dayEndMinutes
            ? { value: null, text: null }
            : { value: bar.pct, text: `${Math.round(bar.pct)}%` });
          const labelled = selectLabelledColumns(labels, {
            // The pitch the labels are laid out on, which is the slot width --
            // `barWidth` is floored at 3 so a hairline column still draws, and
            // striding on that floor would space the numbers closer than they
            // actually sit.
            columnWidthPx: layout.slotWidth,
            anchorOffset: hourAnchorOffset(bars.map((bar) => bar.minutes)),
          });
          return bars.map((bar, index) => labelled[index] ? stripValueLabel({
            x: layout.xForMinutes(bar.minutes) + 0.5 + Math.max(2, barWidth - 1) / 2,
            y: Math.max(yForPct(bar.pct) - 3, 9),
            text: labels[index].text!,
          }) : "");
        })()}
        </g>
      </svg>
    `;
  }

  /**
   * The forecast's own level at every slot of the day, not just the ones it
   * speaks for alone -- so it can be traced as a dashed line over the measured
   * columns too, the same way the chart above keeps drawing the forecast's
   * outline over the hours the actuals have already filled in.
   */
  private _socForecastBars(payload: InspectorPayload): SocBar[] {
    if (!this._isSeriesVisible("batterySocForecast")) return [];
    return socForecastBars(payload);
  }

  /**
   * A dashed step-line tracing the forecast's SoC across the measured part of
   * the day -- the part its own column no longer represents, since that column
   * now shows the actual reading instead.
   *
   * Keyed off the strip's own measured/forecast split (`socBars`), not the
   * power chart's seam: the SoC actuals can lag or lead the power actuals, so
   * the two do not necessarily turn forecast at the same slot.
   */
  private _renderSocForecastLine(
    payload: InspectorPayload,
    socBars: readonly SocBar[],
    layout: ChartLayout,
    yForPct: (pct: number) => number,
  ) {
    const measuredMinutes = new Set(
      socBars.filter((bar) => !bar.forecast).map((bar) => bar.minutes),
    );
    if (!measuredMinutes.size) return "";
    const bars = this._socForecastBars(payload)
      .filter((bar) => measuredMinutes.has(bar.minutes))
      .sort((a, b) => a.minutes - b.minutes);
    if (!bars.length) return "";
    // Each bar is its own flat tread, joined to the previous one by a vertical
    // step. A bar that does not butt up against its predecessor is on the far
    // side of a stretch nothing was forecast for -- since the history readers
    // stopped holding across an `unavailable`, those slots are simply absent --
    // so the pen lifts there rather than ramping across the hole and drawing a
    // trajectory the forecast never held.
    const path = bars
      .map((bar, index) => {
        const previous = bars[index - 1];
        const contiguous =
          previous !== undefined && previous.minutes + this.slotMinutes === bar.minutes;
        const y = yForPct(bar.pct).toFixed(1);
        const start = layout.xForMinutes(bar.minutes).toFixed(1);
        const end = layout.xForMinutes(bar.minutes + this.slotMinutes).toFixed(1);
        return `${contiguous ? "L" : "M"}${start},${y} L${end},${y}`;
      })
      .join(" ");
    // A fixed battery hue would sit almost on top of the "charging" column
    // colour (both greens), so the line reads against the theme's own text
    // colour instead -- contrast that holds regardless of a bar's direction.
    // Width and dash match the chart above's own forecast outline exactly.
    return svg`
      <path d=${path} fill="none" stroke="var(--primary-text-color, #fff)"
            stroke-width=${FORECAST_OUTLINE.width} stroke-dasharray="4 3"
            stroke-opacity=${FORECAST_OUTLINE.opacity}></path>
    `;
  }

  /** The SoC strip's own y scale: 0% at the baseline, 100% at the top. */
  private _yForSocPct(pct: number): number {
    const { padTop, padBottom, height } = SOC_STRIP;
    const innerHeight = height - padTop - padBottom;
    return padTop + (1 - Math.max(0, Math.min(100, pct)) / 100) * innerHeight;
  }

  /**
   * The SoC column under the pointer, and its popup, or null where there is
   * none. The whole slot-wide column counts as "on" it, not just the sliver its
   * own reading fills -- a single-series bar (unlike the combined chart's
   * stacked bands) has nothing else there to disambiguate, so a value near 0%
   * would otherwise be nearly impossible to point at.
   */
  private _socHit(
    event: MouseEvent,
    payload: InspectorPayload,
    layout: ChartLayout,
    bars: readonly SocBar[],
  ): ChartHit | null {
    const minutes = this._plotMinutesAt(event, layout);
    if (minutes === null) return null;
    const bar = bars.find(
      (candidate) => minutes >= candidate.minutes && minutes < candidate.minutes + this.slotMinutes,
    );
    if (!bar) return null;
    // The bar itself is either the actual reading or, ahead of it, the
    // forecast standing in alone -- never both -- so only a measured bar has
    // a real actual column to show.
    const hasActual = !bar.forecast;
    // Each column already carries both ends of its own slot, so the levels it
    // moved between read straight off it -- no neighbour to consult.
    const forecastBar =
      this._socForecastBars(payload).find((fc) => fc.minutes === bar.minutes) ?? null;
    const rows: TooltipRow[] = [
      {
        label: this._t("bias_correction.inspector.soc_direction_label"),
        actual: hasActual
          ? { value: this._t(`bias_correction.inspector.soc_direction.${bar.direction}`), color: SOC_DIRECTION_COLOR[bar.direction] }
          : null,
        forecast: forecastBar
          ? { value: this._t(`bias_correction.inspector.soc_direction.${forecastBar.direction}`), color: SOC_DIRECTION_COLOR[forecastBar.direction] }
          : null,
      },
      {
        label: this._t("bias_correction.inspector.soc_from"),
        actual: hasActual ? { value: formatPct(this._t, bar.fromPct) } : null,
        forecast: forecastBar ? { value: formatPct(this._t, forecastBar.fromPct) } : null,
      },
      {
        label: this._t("bias_correction.inspector.soc_to"),
        actual: hasActual ? { value: formatPct(this._t, bar.pct) } : null,
        forecast: forecastBar ? { value: formatPct(this._t, forecastBar.pct) } : null,
      },
    ];
    return { minutes: bar.minutes, body: { title: bar.slot, hasActual, rows } };
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
    const selectedSlot = resolveSelectedImpactSlot(payload.series.impact, this.selection.focusSlot);
    const explainability = payload.trainingExplainability;
    return svg`
      <svg
        viewBox="0 0 ${stripWidth} ${stripHeight}"
        role="img"
        aria-label=${this._t("bias_correction.inspector.correction_impact")}
        style="cursor: pointer;"
        @click=${(e: MouseEvent) => this._handlePick(e, layout)}
        @mousemove=${(e: MouseEvent) => this._handleChartHover(e, layout)}
        @mouseleave=${() => this._clearHover()}
      >
        ${this._plotClipDef("plot-clip-impact", layout, stripHeight)}
        ${this._renderHoverHighlight(layout, 0, stripHeight)}
        ${this._renderSlotHighlights(layout, 0, stripHeight)}
        <g clip-path="url(#plot-clip-impact)">
        ${payload.series.impact.map((point) => {
          if (point.impactWh === null || !Number.isFinite(point.impactWh)) return "";
          const minutes = slotMinutes(point.slot);
          if (minutes === null) return "";
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
              <title>${point.slot} ${formatSignedWh(this._t, point.impactWh)}</title>
            </rect>
          `;
        })}
        </g>
        ${this._renderNowMarker(layout, 0, stripHeight)}
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

  /**
   * The vertical "now" line, on whichever chart of the stack asks for it.
   *
   * Only today gets one, and only while the moment falls inside the drawn
   * window — the daylight crop can put it off the axis entirely, and a line
   * pinned to the edge would claim a time the chart is not showing.
   */
  private _renderNowMarker(layout: ChartLayout, y: number, height: number) {
    return renderNowMarkerOnDay(
      this,
      { start: layout.dayStartMinutes, end: layout.dayEndMinutes },
      layout.xForMinutes,
      y,
      y + height,
      this._t("scheduling.badge.now"),
    );
  }

  /** One highlight band per selected slot. */
  private _renderSlotHighlights(layout: ChartLayout, y: number, height: number) {
    return this.selection.selectedSlots.map(
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
    const minutes = slotMinutes(selectedSlot);
    if (minutes === null) return "";
    // A slot cropped out of the daylight window has no place on the axis.
    if (minutes < layout.dayStartMinutes || minutes >= layout.dayEndMinutes) return "";
    return renderSlotBand(layout.xForMinutes(minutes), Math.max(3, layout.slotWidth), y, height, "selected");
  }

  /**
   * A wash over every column the coverage `buckets` flagged, so one drawn short
   * because a slot inside it went `unavailable` cannot be mistaken for one the
   * forecast genuinely called low.
   *
   * The fill is the card's own background rather than a tint of the foreground:
   * painted over the bands it takes colour *out* of the column, which is what a
   * reader already reads as "less than the rest". A tint added on top — or the
   * same tint painted underneath, where it only lights up the empty background
   * around the bars — reads as a highlight instead, and a highlight says "look
   * here, there is something", the opposite of what is being said.
   *
   * A rect over the whole column rather than surgery on the stack paths: the
   * stack is built from contiguous runs per band (`_renderStackSet`) and `raw`
   * is a line on top of it (`_renderSolarLayer`), so marking one bucket inside
   * those would mean splitting every run at that bucket, per band, per series
   * — and would still leave the line unmarked. `_renderSlotHighlight` already
   * draws this exact column geometry for the selection, so this reuses it with
   * a different, unmistakably non-selection fill.
   */
  private _renderPartialBuckets(layout: ChartLayout, y: number, height: number) {
    if (!this.dimIncompleteSlots) return "";
    return [...this.coverage.buckets.entries()].map(([start, perSeries]) =>
      this._renderPartialBucket(layout, y, height, start, perSeries));
  }

  private _renderPartialBucket(
    layout: ChartLayout,
    y: number,
    height: number,
    bucketStartMinutes: number,
    perSeries: ReadonlyMap<SeriesKey, number>,
  ) {
    // Cropped out of the daylight window, exactly as a selected slot would be.
    if (bucketStartMinutes < layout.dayStartMinutes || bucketStartMinutes >= layout.dayEndMinutes) {
      return "";
    }
    const x = layout.xForMinutes(bucketStartMinutes);
    const w = Math.max(3, layout.slotWidth);
    const note = formatPartialBucketNote(
      this._t, perSeries, 1, this.slotMinutes, this.coverage.granularityMinutes,
    );
    // The wash carries the meaning; the rule under it is only there to say the
    // dimming is deliberate. It sits inside the column's edges so a run of
    // marked columns reads as separate ticks rather than one long line, and it
    // is the one thing here drawn in a foreground colour -- a border around the
    // column, however faint, competes with the selection outline and reads as
    // "look at this" rather than "there is less here than there looks".
    return svg`
      <g class="partial-bucket-mark" data-bucket-start=${bucketStartMinutes}>
        <rect
          x=${x} y=${y} width=${w} height=${height}
          style="fill: color-mix(in srgb, var(--card-background-color) 62%, transparent);"
        ><title>${note}</title></rect>
        <rect
          x=${x + 1.5} y=${y + height - 2} width=${Math.max(1, w - 3)} height="2"
          style="fill: var(--secondary-text-color);" fill-opacity="0.4"
          pointer-events="none"
        ></rect>
      </g>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "helman-solar-day-chart": HelmanSolarDayChart;
  }
}
