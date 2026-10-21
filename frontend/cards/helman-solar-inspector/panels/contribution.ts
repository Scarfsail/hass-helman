import { html } from "lit";
import type { InspectorPayload } from "../inspector-day-model";
import { formatFactor, formatWh } from "../inspector-format";
import {
  resolveSelectedTrainingDate,
  type ContributionRow,
  type TrainingSlotExplainability,
} from "../solar-inspector-model.js";
import type { PanelContext } from "./metrics";

/** The contribution table's own state, which the card keeps. */
export interface ContributionState {
  collapsed: boolean;
  impactStripVisible: boolean;
  /** The day on screen, which the table prefers as its selected row. */
  selectedDate: string;
  selectedTrainingDate: string | null;
  toggleCollapsed(): void;
  toggleImpactStrip(): void;
  selectTrainingDate(date: string): void;
}

type RatioBounds = { min: number; max: number; maxAbsDeviation: number };

/** Which training days the selected slot's correction factor was fitted from. */
export function renderContributionTable(
  ctx: PanelContext,
  payload: InspectorPayload,
  selectedSlot: string,
  trainingSlot: TrainingSlotExplainability | null,
  state: ContributionState,
) {
  const t = ctx.t;
  if (!payload.availability.hasProfile) {
    return html`<div class="note">${t("bias_correction.inspector.no_profile")}</div>`;
  }
  if (!payload.trainingExplainability) {
    return html`<div class="note">${t("bias_correction.inspector.no_explainability")}</div>`;
  }
  if (!trainingSlot) {
    return html`<div class="note">${t("bias_correction.inspector.no_slot_explainability", { slot: selectedSlot })}</div>`;
  }
  const selectedTrainingDate = resolveSelectedTrainingDate(
    trainingSlot.rows,
    state.selectedDate,
    state.selectedTrainingDate,
  );
  const interpolated = trainingSlot.interpolated === true;
  const anchors = trainingSlot.interpolationAnchors ?? null;
  const ratioBounds = computeRatioBounds(trainingSlot.rows);
  return html`
    <div class="contribution-summary">
      <button
        class="contribution-toggle"
        aria-expanded=${!state.collapsed}
        @click=${() => state.toggleCollapsed()}
      >
        <span class="contribution-toggle-icon ${state.collapsed ? "" : "expanded"}">▶</span>
        ${t("bias_correction.inspector.training_contribution")}
      </button>
    </div>
    ${state.collapsed ? "" : html`
      <div class="contribution-summary">
        <div class="day-state">
          ${t("bias_correction.inspector.training_contribution_meta", {
            ratio: formatFactor(trainingSlot.rawRatio),
            factor: formatFactor(trainingSlot.factor),
          })}
        </div>
        ${interpolated
          ? html`<div class="day-state">
              ${t("bias_correction.inspector.interpolated_meta", {
                left: anchors?.left ?? t("bias_correction.inspector.interpolated_anchor_zero"),
                right: anchors?.right ?? t("bias_correction.inspector.interpolated_anchor_zero"),
              })}
            </div>`
          : ""}
        ${payload.range.isToday
          ? html`<div class="day-state">${t("bias_correction.inspector.today_training_note")}</div>`
          : ""}
        <label class="impact-strip-switch">
          <input
            type="checkbox"
            .checked=${state.impactStripVisible}
            @change=${() => state.toggleImpactStrip()}
          />
          ${t("bias_correction.inspector.show_impact_strip")}
        </label>
      </div>
      <div class="contribution-table-wrap">
        <table class="contribution-table">
          <thead>
            <tr>
              <th>${t("bias_correction.inspector.date")}</th>
              <th class="numeric">${t("bias_correction.inspector.forecast_wh")}</th>
              <th class="numeric">${t("bias_correction.inspector.actual_wh")}</th>
              <th class="numeric">${t("bias_correction.inspector.ratio")}</th>
              <th>${t("bias_correction.inspector.status")}</th>
            </tr>
          </thead>
          <tbody>
            ${sortContributionRows(trainingSlot.rows).map((row) => {
              if (row.status === "interpolated") {
                return html`
                  <tr class="contribution-row synthetic" aria-disabled="true">
                    <td>—</td>
                    <td class="numeric">—</td>
                    <td class="numeric">—</td>
                    <td class="ratio">—</td>
                    <td>${formatContributionStatus(ctx, row.status, row.reason)}</td>
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
                @click=${() => state.selectTrainingDate(row.date)}
                @keydown=${(event: KeyboardEvent) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  state.selectTrainingDate(row.date);
                }}
              >
                <td>${row.date || "-"}</td>
                <td class="numeric">${formatWh(t, row.forecastWh)}</td>
                <td class="numeric">${formatWh(t, row.actualWh)}</td>
                <td class="ratio">${muted ? formatFactor(row.ratio) : renderRatioGauge(row.ratio, ratioBounds)}</td>
                <td>${formatContributionStatus(ctx, row.status, row.reason)}</td>
              </tr>
            `;})}
          </tbody>
        </table>
      </div>
    `}
  `;
}

function sortContributionRows(rows: ContributionRow[]): ContributionRow[] {
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

function computeRatioBounds(rows: ContributionRow[]): RatioBounds {
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

function renderRatioGauge(ratio: number | null, bounds: RatioBounds) {
  const text = formatFactor(ratio);
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

function formatContributionStatus(ctx: PanelContext, status: string, reason: string | null) {
  const translated = ctx.t(`bias_correction.inspector.contribution_status.${status}`);
  if (!reason) return translated;
  return `${translated} (${reason})`;
}
