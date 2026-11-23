import { html } from "lit";
import { CHART_COLORS } from "../chart-colors";
import type { DayCoverage, InspectorPayload, SeriesKey } from "../inspector-day-model";
import { formatIncompleteNote, formatWh } from "../inspector-format";
import "../../shared/solar-day-gauge";
import {
  renderFamilyRow,
  renderHouseForecastErrorMetric,
  renderMetric,
  renderMoneyMetrics,
  type PanelContext,
} from "./metrics";

/**
 * The day's totals.
 *
 * Read off `payload.totals`, never summed from the series: the backend counts
 * the slot in progress in them, deliberately, and a sum of the drawn series
 * would not.
 *
 * Today, while the bias correction applies, the solar day gauge closes the
 * grid as a tile three columns wide and two rows tall on the right; the
 * regular tiles keep their order and fill the columns to its left.
 */
export function renderTotals(
  ctx: PanelContext,
  payload: InspectorPayload,
  options: {
    coverage: DayCoverage;
    /** Whether the day is over, so its house forecast can be judged. */
    past: boolean;
    houseFocus: boolean;
    hideMoneyStrip: boolean;
  },
) {
  const t = ctx.t;
  const totals = payload.totals;
  // The sentence naming what a series' day total is short by, or null for a
  // series with no hole.
  const incomplete = (series: SeriesKey): string | null => {
    const coverage = options.coverage.series.get(series);
    return coverage
      ? formatIncompleteNote(t, "bias_correction.inspector.partial_total", coverage.missing, coverage.expected)
      : null;
  };
  return html`
    <div class="metrics-section totals-section">
      <strong>${t("bias_correction.inspector.daily_totals")}</strong>
      <div class="metric-grid ${payload.todayGauge ? "with-gauge" : ""}">
        ${ctx.isSeriesVisible("raw")
          ? renderMetric(ctx, t("bias_correction.inspector.raw_forecast"), formatWh(t, totals.rawWh), CHART_COLORS.raw, true, "raw", incomplete("raw"))
          : ""}
        ${renderFamilyRow(ctx, "solar", totals.correctedWh, totals.actualWh, incomplete)}
        ${renderFamilyRow(ctx, "house", totals.houseForecastWh, totals.houseActualWh, incomplete)}
        ${options.houseFocus && options.past
          ? renderHouseForecastErrorMetric(
            ctx,
            totals.houseForecastWh,
            totals.houseActualWh,
            [incomplete("houseForecast"), incomplete("houseActual")]
              .filter((note) => note !== null).join(" · ") || null,
          )
          : ""}
        ${renderFamilyRow(ctx, "grid", totals.gridForecastWh, totals.gridActualWh, incomplete)}
        ${renderFamilyRow(ctx, "battery", totals.batteryForecastWh, totals.batteryActualWh, incomplete)}
        ${options.hideMoneyStrip ? "" : renderMoneyMetrics(ctx, payload, null)}
        ${payload.todayGauge
          ? html`<div class="metric-card today-gauge" data-today-gauge>
            <div class="metric-label">${t("node_detail.shared.solar_day_gauge.title")}</div>
            <helman-solar-day-gauge .gauge=${payload.todayGauge} .hass=${ctx.hass} .localize=${t}></helman-solar-day-gauge>
          </div>`
          : ""}
      </div>
    </div>
  `;
}
