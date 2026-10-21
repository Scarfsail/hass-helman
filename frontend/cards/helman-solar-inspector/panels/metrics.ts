import { html, type TemplateResult } from "lit";
import type { HomeAssistant } from "../../../types/ha";
import { GRID_EXPORT_COLOR, GRID_IMPORT_COLOR, NEUTRAL_COLOR } from "../../color-utils";
import { CHART_COLORS } from "../chart-colors";
import type { InspectorPayload, SeriesKey } from "../inspector-day-model";
import {
  FAMILIES,
  formatPct,
  formatSignedWh,
  formatWh,
  negateWh,
  seriesLabel,
  type FamilyKey,
  type Translate,
} from "../inspector-format";
import { currencyFromPriceUnit, sumMoney, UNPRICED_MONEY, type MoneyPoint, type MoneyTotals } from "../money-model";
import { expandSlotsToNative } from "../slot-aggregation.js";
import { formatHouseForecastErrorPct, houseForecastError } from "../solar-inspector-model.js";

/**
 * The tiles every metrics panel is built from.
 *
 * The panels are render helpers rather than elements: they draw into the
 * inspector's own shadow root and are styled by its stylesheet
 * (`../inspector-styles.ts`), so a selector that finds a tile finds it in any
 * panel. What each needs from the card comes in as a `PanelContext`.
 */

/** What a panel reads off the card it is drawn into. */
export interface PanelContext {
  hass?: HomeAssistant;
  t: Translate;
  /** Whether the config allows this series at all. */
  isSeriesEnabled(series: SeriesKey): boolean;
  /** Whether the series is drawn: allowed, and not hidden by the legend. */
  isSeriesVisible(series: SeriesKey): boolean;
  toggleSeries(series: SeriesKey): void;
  /** Hide or show a merged tile's series together, driven off its shown state. */
  toggleSeriesGroup(series: SeriesKey[], visible: boolean): void;
}

type MergedPart = { value: string; present: boolean; title: string; incomplete: string | null };

/**
 * One family's forecast/actual pair as a single legend tile.
 *
 * `incomplete` names what the series behind a value is short by, or null when
 * it is whole -- the day totals pass one, a selection does not.
 */
export function renderFamilyRow(
  ctx: PanelContext,
  key: FamilyKey,
  forecast: number | null,
  actual: number | null,
  incomplete: (series: SeriesKey) => string | null = () => null,
) {
  const family = FAMILIES[key];
  const part = (value: number | null, series: SeriesKey): MergedPart => {
    const signed = family.sign < 0 ? negateWh(value) : value;
    return mergedPart(
      signed,
      family.unit === "pct" ? formatPct(ctx.t, signed) : formatWh(ctx.t, signed),
      seriesLabel(ctx.t, series),
      incomplete(series),
    );
  };
  return renderMergedMetric(
    ctx,
    ctx.t(`bias_correction.inspector.${family.label}`),
    family.color,
    part(forecast, family.forecast),
    part(actual, family.actual),
    family.forecast,
    family.actual,
  );
}

/**
 * One value inside a merged card, tagged with whether it is present so the
 * caller can drop the empty half. `title` names the underlying series for the
 * hover tooltip the merged label no longer spells out. `incomplete` is the
 * day-total counterpart of the chart's partial-bucket marks: the sentence
 * naming what the series behind this value is short by, or null when it is
 * whole. The sum is real either way, so the chip keeps it and says how much of
 * the day stands behind it rather than presenting it as the day's finished
 * figure.
 */
function mergedPart(value: number | null, formatted: string, title: string, incomplete: string | null): MergedPart {
  return {
    value: formatted,
    present: value !== null && Number.isFinite(value),
    title,
    incomplete,
  };
}

/**
 * The tinted fill that marks a value as forecast (hatched) or actual (flat).
 * Returns the bare CSS value so it can back either a whole card or a single
 * value chip inside a merged card.
 */
function seriesFill(color: string, forecast: boolean): string {
  return forecast
    ? `repeating-linear-gradient(-45deg, color-mix(in srgb, ${color} 18%, transparent) 0px, color-mix(in srgb, ${color} 18%, transparent) 3px, transparent 3px, transparent 8px)`
    : `color-mix(in srgb, ${color} 15%, transparent)`;
}

/**
 * The actual/forecast chips a metric card carries.
 *
 * Shared by the merged metric and the money tile, which differ only in their
 * wrapper — one is a legend toggle, the other is not — and would otherwise
 * drift apart in the fill rules that make a chip stand out against the card's
 * own colour wash: the forecast keeps the hatch, the actual a flat tint one
 * step darker again.
 */
function metricChips(
  color: string,
  actual: { value: string; present: boolean; title: string; incomplete?: string | null },
  forecast: { value: string; present: boolean; title: string; incomplete?: string | null },
  /**
   * Which half the "neither reported" placeholder speaks for. The forecast by
   * default, as it always did; the actual when the config left the forecast
   * out, so the placeholder cannot name a series that is never drawn.
   */
  placeholder: "forecast" | "actual" = "forecast",
): TemplateResult[] {
  const chipFill = (isForecast: boolean): string =>
    isForecast
      ? `repeating-linear-gradient(-45deg, color-mix(in srgb, ${color} 42%, transparent) 0px, color-mix(in srgb, ${color} 42%, transparent) 3px, transparent 3px, transparent 7px)`
      : `color-mix(in srgb, ${color} 34%, transparent)`;
  const chip = (
    part: { value: string; title: string; incomplete?: string | null },
    isForecast: boolean,
  ): TemplateResult => html`
    <span
      class="metric-value metric-chip"
      style=${`background: ${chipFill(isForecast)};`}
      title=${part.incomplete ? `${part.title} — ${part.incomplete}` : part.title}
    >${part.value}${part.incomplete ? html`<sup class="incomplete-mark">*</sup>` : ""}</span>
  `;
  const chips: TemplateResult[] = [];
  if (actual.present) chips.push(chip(actual, false));
  if (forecast.present) chips.push(chip(forecast, true));
  // Neither side reported: keep a single placeholder so the card still reads.
  if (chips.length === 0) {
    chips.push(placeholder === "forecast" ? chip(forecast, true) : chip(actual, false));
  }
  return chips;
}

/**
 * A forecast/actual pair drawn as a single card: the forecast value carries
 * the hatched fill and the actual value the flat fill, so the two read as one
 * quantity seen twice. When only one side has data the card shows just that
 * one. The whole card toggles both series at once.
 */
function renderMergedMetric(
  ctx: PanelContext,
  label: string,
  color: string,
  forecast: MergedPart,
  actual: MergedPart,
  forecastSeries: SeriesKey,
  actualSeries: SeriesKey,
) {
  // A series the config left out has no tile at all: a dimmed legend button
  // that cannot be un-dimmed would read as toggled off rather than absent.
  if (!ctx.isSeriesEnabled(forecastSeries) && !ctx.isSeriesEnabled(actualSeries)) {
    return "";
  }
  // Half a pair can be dropped on its own, and then its chip would report a
  // number for a band that is never drawn.
  const forecastEnabled = ctx.isSeriesEnabled(forecastSeries);
  const actualEnabled = ctx.isSeriesEnabled(actualSeries);
  const chips = metricChips(
    color,
    actualEnabled ? actual : { ...actual, present: false },
    forecastEnabled ? forecast : { ...forecast, present: false },
    forecastEnabled ? "forecast" : "actual",
  );
  const toggled = [forecastSeries, actualSeries].filter((key) => ctx.isSeriesEnabled(key));
  const visible = ctx.isSeriesVisible(forecastSeries) || ctx.isSeriesVisible(actualSeries);
  // Faint full-card wash plus a solid left rail, both in the series colour, so
  // the box is identifiable at a glance without drowning the chips.
  const cardStyle = `background: color-mix(in srgb, ${color} 12%, transparent); border-left: 3px solid ${color};`;
  return html`
    <button
      class="metric-card legend-toggle merged ${visible ? "" : "hidden-series"}"
      style=${cardStyle}
      type="button"
      aria-pressed=${visible ? "true" : "false"}
      title=${ctx.t(
        visible
          ? "bias_correction.inspector.legend_hide_series"
          : "bias_correction.inspector.legend_show_series",
      )}
      @click=${() => ctx.toggleSeriesGroup(toggled, visible)}
    >
      <div class="metric-label">${label}</div>
      <div class="metric-chips">${chips}</div>
    </button>
  `;
}

/**
 * A money tile: the merged metric's shape without its legend toggle, since
 * money is derived from the series rather than being one, and there is
 * nothing on the chart for a click to hide.
 */
function renderMoneyMetric(
  label: string,
  color: string,
  actual: { value: string; present: boolean; title: string },
  forecast: { value: string; present: boolean; title: string },
) {
  const chips = metricChips(color, actual, forecast);
  const cardStyle = `background: color-mix(in srgb, ${color} 12%, transparent); border-left: 3px solid ${color};`;
  return html`
    <div class="metric-card merged" style=${cardStyle}>
      <div class="metric-label">${label}</div>
      <div class="metric-chips">${chips}</div>
    </div>
  `;
}

/**
 * The three money tiles, over the whole day or a selection.
 *
 * The day reads the payload's own totals, which count the slot in progress
 * exactly as every energy total does. A selection sums the drawn series
 * instead, so it excludes that slot exactly as the energy figures beside it
 * in the selection panel do. Two rules, but each tile follows the same one as
 * the energy it sits next to — which is the whole point.
 *
 * An unpriced direction shows nothing rather than a zero: a day past the
 * recorder's reach has real exported kWh at an unknown rate, and "earned 0"
 * would be a claim the data does not support. Per *direction* and per tile,
 * not per vintage -- a day whose import rail is filled from the configured
 * windows and whose export rail predates the sell-price entity prices one
 * side and not the other, and the gain tile is the one that has to admit it.
 * The net tile then admits it too: with a direction unknown there is no
 * honest balance, only the priced side wearing the other's name.
 */
export function renderMoneyMetrics(
  ctx: PanelContext,
  payload: InspectorPayload,
  selection: { slots: string[]; slotMinutes: number } | null,
): TemplateResult {
  const currency = currencyFromPriceUnit(payload.priceUnit);
  // The selection is on the inspector's current slot width; money is on the
  // rails' own 15-minute grid. A 60-minute selection therefore has to claim
  // all four quarters it spans, or its sums would count only the first.
  const railSlots = selection === null ? null : expandSlotsToNative(selection.slots, selection.slotMinutes);
  // Presence is asked of the *selection*, not the day. Reading it day-wide
  // would print "0.00" against an hour tonight simply because this morning
  // had actuals -- claiming a future hour has already cost nothing, which is
  // the one thing every other tile in this panel is careful not to do. It
  // needs no flag of its own: an amount is null exactly where it is unknown,
  // and a selection nothing priced sums to three nulls.
  const summed = (
    points: readonly MoneyPoint[],
    dayTotals: MoneyTotals | null,
  ): MoneyTotals =>
    railSlots === null
      ? dayTotals ?? UNPRICED_MONEY
      : sumMoney(points, railSlots);
  const actual = summed(payload.series.moneyActual, payload.totals.moneyActual);
  const forecast = summed(
    payload.series.moneyForecast,
    payload.totals.moneyForecast,
  );
  const part = (totals: MoneyTotals, key: keyof MoneyTotals, title: string) => {
    const amount = totals[key];
    const present = amount !== null && Number.isFinite(amount);
    return {
      value: present ? `${amount.toFixed(2)} ${currency}`.trim() : "—",
      present,
      title,
    };
  };
  const tile = (labelKey: string, color: string, key: keyof MoneyTotals) =>
    renderMoneyMetric(
      ctx.t(`bias_correction.inspector.${labelKey}`),
      color,
      part(actual, key, ctx.t("bias_correction.inspector.column_actual")),
      part(forecast, key, ctx.t("bias_correction.inspector.column_forecast")),
    );
  return html`
    ${tile("import_cost", GRID_IMPORT_COLOR, "cost")}
    ${tile("export_gain", GRID_EXPORT_COLOR, "gain")}
    ${tile("net_cost", NEUTRAL_COLOR, "net")}
  `;
}

/**
 * The house forecast's miss, actual minus predicted, in energy and as a share
 * of the actual. Takes consumption magnitudes (the payload's house series are
 * negative). Absent where either side is missing, so it never claims a miss
 * it cannot measure.
 */
export function renderHouseForecastErrorMetric(
  ctx: PanelContext,
  forecastWh: number | null,
  actualWh: number | null,
  incomplete: string | null = null,
) {
  // Read off both series, so the allowlist has to let both through.
  if (!ctx.isSeriesEnabled("houseForecast") || !ctx.isSeriesEnabled("houseActual")) return "";
  const error = houseForecastError(forecastWh, actualWh);
  if (error === null) return "";
  return renderMetric(
    ctx,
    ctx.t("bias_correction.inspector.house_forecast_error"),
    `${formatSignedWh(ctx.t, error.errorWh)} (${formatHouseForecastErrorPct(error)})`,
    CHART_COLORS.house,
    false,
    undefined,
    incomplete,
  );
}

export function renderMetric(
  ctx: PanelContext,
  label: string,
  value: string,
  color?: string,
  dashed?: boolean,
  series?: SeriesKey,
  // Raw is the one metric on this card that has no actual side to pair with,
  // so it carries the day total's incomplete mark through its own parameter
  // rather than a chip.
  incomplete: string | null = null,
) {
  if (series && !ctx.isSeriesEnabled(series)) return "";
  let background = "";
  if (color) {
    background = `background: ${seriesFill(color, dashed === true)};`;
  }
  const valueContent = incomplete
    ? html`<span title=${incomplete}>${value}<sup class="incomplete-mark">*</sup></span>`
    : value;
  if (!series) {
    return html`
      <div class="metric-card" style=${background}>
        <div class="metric-label">${label}</div>
        <div class="metric-value">${valueContent}</div>
      </div>
    `;
  }
  const visible = ctx.isSeriesVisible(series);
  return html`
    <button
      class="metric-card legend-toggle ${visible ? "" : "hidden-series"}"
      style=${background}
      type="button"
      aria-pressed=${visible ? "true" : "false"}
      title=${ctx.t(
        visible
          ? "bias_correction.inspector.legend_hide_series"
          : "bias_correction.inspector.legend_show_series",
      )}
      @click=${() => ctx.toggleSeries(series)}
    >
      <div class="metric-label">${label}</div>
      <div class="metric-value">${valueContent}</div>
    </button>
  `;
}
