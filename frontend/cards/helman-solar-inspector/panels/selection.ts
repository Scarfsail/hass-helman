import { html } from "lit";
import { CHART_COLORS } from "../chart-colors";
import { buildSocBars, slotToMinutes, type SocBar } from "../chart-soc";
import { socForecastBars, type DayCoverage, type DayView, type InspectorPayload, type PriceColumn, type SeriesKey } from "../inspector-day-model";
import {
  formatFactor,
  formatPartialBucketNote,
  formatPrice,
  formatSignedWh,
  formatSlotRange,
  formatWh,
} from "../inspector-format";
import {
  aggregateBreakdownOverSlots,
  aggregateImpactOverSlots,
  socBarAtSelectionEnd,
  sumWhOverSlots,
} from "../slot-aggregation.js";
import {
  findTrainingSlot,
  resolveSelectedImpactSlot,
  type InspectorPoint,
} from "../solar-inspector-model.js";
import { renderHouseBreakdown, type BreakdownGroups } from "./breakdown";
import { renderContributionTable, type ContributionState } from "./contribution";
import {
  renderFamilyRow,
  renderHouseForecastErrorMetric,
  renderMetric,
  renderMoneyMetrics,
  type PanelContext,
} from "./metrics";

/**
 * The metrics for the whole selection, not just the focus slot: every energy
 * figure is the sum across the selected slots, aggregated by the same rules the
 * slot-width buttons use. The training diagnostics below stay on the focus slot
 * — a correction factor is fitted per slot, so there is nothing to sum.
 */
export function renderSelectedSlotDetails(
  ctx: PanelContext,
  payload: DayView,
  options: {
    /** The selection, narrowed to slots of the day's grid, in order. */
    slots: string[];
    focusSlot: string | null;
    slotMinutes: number;
    coverage: DayCoverage;
    /** The payload as served, for the composition panels' native bars. */
    native: InspectorPayload["series"];
    houseFocus: boolean;
    hidePriceStrip: boolean;
    hideMoneyStrip: boolean;
    groups: BreakdownGroups;
    contribution: ContributionState;
  },
) {
  const t = ctx.t;
  const { slots, focusSlot, slotMinutes, coverage } = options;
  const selectedSlot = resolveSelectedImpactSlot(payload.series.impact, focusSlot)
    ?? focusSlot
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
  const houseForecastBreakdown = aggregateBreakdownOverSlots(
    payload.series.houseForecastBreakdown,
    slots,
  );
  // Both SoC readings come off the strip's own columns, so the panel states
  // the level the selection ends at exactly as the last column drawn under it
  // does — rather than the level it opened on, which for a multi-slot
  // selection is a reading from somewhere in its middle.
  const batterySocFc = socBarAtSelectionEnd(socSelectionBars(payload, "forecast"), slots);
  const batterySocAc = socBarAtSelectionEnd(socSelectionBars(payload, "actual"), slots);
  const interpolated = trainingSlot?.interpolated === true;
  const anchors = trainingSlot?.interpolationAnchors ?? null;
  // Summed across every selected bucket rather than read off just the focus
  // slot: a multi-slot selection can straddle more than one marked column,
  // and the panel's job is to say what the sums above are short by, not just
  // whether the first bucket happens to be short. Kept per series through the
  // sum so the note can still name what is short.
  const missingInSelection = new Map<SeriesKey, number>();
  for (const slot of slots) {
    const minutes = slotToMinutes(slot);
    if (minutes === null) continue;
    for (const [key, count] of coverage.buckets.get(minutes) ?? []) {
      missingInSelection.set(key, (missingInSelection.get(key) ?? 0) + count);
    }
  }
  const impactColor = (impact?.impactWh ?? null) === null
    ? undefined
    : (impact!.impactWh! >= 0 ? CHART_COLORS.impactPositive : CHART_COLORS.impactNegative);
  // The bias-correction internals (impact, factor, interpolation, training
  // contributions) ride along with the raw forecast: hidden by default, they
  // surface only once the raw diagnostic is turned on.
  const showDiagnostics = ctx.isSeriesVisible("raw");
  return html`
    <div class="metrics-section">
      <strong>
        ${t("bias_correction.inspector.selected_slot", {
          slot: formatSlotRange(slots, slotMinutes),
        })}
        ${interpolated && showDiagnostics
          ? html`<span class="interpolation-note" title=${t("bias_correction.inspector.interpolated_explanation")}>
              ${t("bias_correction.inspector.interpolated_from", {
                left: anchors?.left ?? t("bias_correction.inspector.interpolated_anchor_zero"),
                right: anchors?.right ?? t("bias_correction.inspector.interpolated_anchor_zero"),
              })}
            </span>`
          : ""}
      </strong>
      ${interpolated && showDiagnostics
        ? html`<div class="day-state">${t("bias_correction.inspector.interpolated_explanation")}</div>`
        : ""}
      ${missingInSelection.size
        ? html`<div class="day-state">${formatPartialBucketNote(
          t, missingInSelection, slots.length, slotMinutes, coverage.granularityMinutes,
        )}</div>`
        : ""}
      <div class="metric-grid">
        ${ctx.isSeriesVisible("raw")
          ? renderMetric(ctx, t("bias_correction.inspector.raw_forecast"), formatWh(t, rawWh ?? impact?.rawWh ?? null), CHART_COLORS.raw, true, "raw")
          : ""}
        ${renderFamilyRow(ctx, "solar", correctedWh ?? impact?.correctedWh ?? null, actualWh)}
        ${renderFamilyRow(ctx, "house", houseFcWh, houseAcWh)}
        ${options.houseFocus
          && everySlotHasActual(payload.series.houseActual, slots)
          && !missingInSelection.has("houseActual")
          && !missingInSelection.has("houseForecast")
          ? renderHouseForecastErrorMetric(ctx, houseFcWh, houseAcWh)
          : ""}
        ${showDiagnostics
          ? renderMetric(ctx, t("bias_correction.inspector.correction_impact"), formatSignedWh(t, impact?.impactWh ?? null), impactColor)
          : ""}
        ${showDiagnostics
          ? renderMetric(ctx, t("bias_correction.inspector.factor"), formatFactor(impact?.factor ?? trainingSlot?.factor ?? null), impactColor)
          : ""}
        ${renderFamilyRow(ctx, "batterySoc", batterySocFc?.pct ?? null, batterySocAc?.pct ?? null)}
        ${renderFamilyRow(
          ctx,
          "grid",
          sumWhOverSlots(payload.series.gridForecast, slots),
          sumWhOverSlots(payload.series.gridActual, slots),
        )}
        ${renderFamilyRow(
          ctx,
          "battery",
          sumWhOverSlots(payload.series.batteryForecast, slots),
          sumWhOverSlots(payload.series.batteryActual, slots),
        )}
        ${!options.hidePriceStrip && payload.importPriceColumns.length
          ? renderMetric(
              ctx,
              t("bias_correction.inspector.merged.import_price"),
              formatPrice(t, priceAtSelectionStart(payload.importPriceColumns, slots), payload.priceUnit),
            )
          : ""}
        ${!options.hidePriceStrip && payload.exportPriceColumns.length
          ? renderMetric(
              ctx,
              t("bias_correction.inspector.merged.export_price"),
              formatPrice(t, priceAtSelectionStart(payload.exportPriceColumns, slots), payload.priceUnit),
            )
          : ""}
        ${options.hideMoneyStrip ? "" : renderMoneyMetrics(ctx, payload, { slots, slotMinutes })}
      </div>
    </div>
    ${ctx.isSeriesEnabled("houseActual")
      ? renderHouseBreakdown(ctx, options.groups, houseBreakdown, slots, "actual", options.native, slotMinutes)
      : ""}
    ${ctx.isSeriesEnabled("houseForecast")
      ? renderHouseBreakdown(ctx, options.groups, houseForecastBreakdown, slots, "forecast", options.native, slotMinutes)
      : ""}
    ${showDiagnostics
      ? renderContributionTable(ctx, payload, selectedSlot, trainingSlot, options.contribution)
      : ""}
  `;
}

/**
 * One series' columns across the whole day, for the selected-slot panel.
 *
 * The panel reports the two series side by side, so neither may yield to the
 * other at the seam the way the strip's columns do: each is built as if it
 * were the only one there. The forecast still rides along when the measured
 * columns are built, since a measured column at the edge of the recording
 * borrows the forecast's step across its own slot -- exactly as the strip
 * does. With nothing measured there is no measured column to speak of; the
 * empty list keeps `buildSocBars` from handing the forecast the whole day.
 */
function socSelectionBars(payload: InspectorPayload, series: "actual" | "forecast"): SocBar[] {
  if (series === "forecast") {
    return socForecastBars(payload);
  }
  if (!payload.series.batterySocActual.length) return [];
  return buildSocBars(
    payload.series.batterySocActual,
    payload.series.batterySocForecast,
    Number.POSITIVE_INFINITY,
  );
}

/**
 * Whether the actual covers the whole selection. A selection running past now
 * sums the forecast over every slot and the actual only over the elapsed
 * ones, which would read as a miss the forecast never made. A wider bucket
 * with native holes still has a point, so the caller also checks the
 * coverage marks.
 */
function everySlotHasActual(points: readonly InspectorPoint[], slots: readonly string[]): boolean {
  const measured = new Set(points.map((point) => point.slot));
  return slots.every((slot) => measured.has(slot));
}

/**
 * The price the selection opens on -- a rate, not an energy, so it is read at
 * the first slot rather than summed, the same rule the SoC box follows.
 */
function priceAtSelectionStart(
  columns: readonly PriceColumn[],
  slots: readonly string[],
): number | null {
  for (const slot of slots) {
    const minutes = slotToMinutes(slot);
    if (minutes === null) continue;
    const column = columns.find(
      (c) => minutes >= c.startMinutes && minutes < c.endMinutes,
    );
    if (column) return column.value;
  }
  return null;
}
