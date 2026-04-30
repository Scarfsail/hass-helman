import { LitElement, css, html, svg } from "lit";
import { property, state } from "lit/decorators.js";
import { toAveragePower, type ChartEntry } from "./chart-power";
import { getLocalizeFunction, type LocalizeFunction } from "./localize/localize";
import {
  findImpactForSlot,
  findPointForSlot,
  findTrainingSlot,
  resolveSelectedImpactSlot,
  type FactorPoint,
  type ImpactPoint,
  type InspectorPoint,
  type TrainingExplainability,
  type TrainingSlotExplainability,
} from "./bias-correction-inspector-model.js";

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
  };
  totals: {
    rawWh: number | null;
    correctedWh: number | null;
    actualWh: number | null;
  };
  availability: {
    hasRawForecast: boolean;
    hasCorrectedForecast: boolean;
    hasActuals: boolean;
    hasInvalidated: boolean;
    hasProfile: boolean;
  };
  trainingExplainability: TrainingExplainability | null;
};

export class HelmanBiasCorrectionInspector extends LitElement {
  @property({ attribute: false }) hass: any;

  @state() private _expanded = false;
  @state() private _selectedDate = "";
  @state() private _payload: InspectorPayload | null = null;
  @state() private _loading = false;
  @state() private _error = "";
  @state() private _selectedSlot: string | null = null;

  private _fallbackLocalize: LocalizeFunction = getLocalizeFunction();
  private _activeRequestId = 0;
  private _activeRequestDate: string | null = null;
  private static readonly _CHEVRON_PATH = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";

  static styles = css`
    .inspector {
      border: 1px solid var(--divider-color);
      border-radius: 12px;
      background: var(--card-background-color);
    }

    .summary-button {
      width: 100%;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
      padding: 14px 16px;
    }

    .summary-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      color: var(--primary-text-color);
      font-weight: 600;
    }

    .summary-left {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .summary-label {
      min-width: 0;
    }

    .summary-chevron {
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      fill: var(--secondary-text-color);
      transition: transform 0.2s ease;
      transform: rotate(0deg);
    }

    .summary-button[aria-expanded="true"] .summary-chevron {
      transform: rotate(90deg);
    }

    .body {
      display: grid;
      gap: 12px;
      padding: 0 16px 16px;
      border-top: 1px solid var(--divider-color);
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

    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      font-size: 0.85rem;
      color: var(--secondary-text-color);
    }

    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .swatch {
      width: 18px;
      height: 3px;
      border-radius: 2px;
      background: currentColor;
    }

    .swatch.raw { color: #1565c0; }
    .swatch.corrected { color: #2e7d32; }

    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #c62828;
    }

    .dot.invalidated {
      background: #9aa0a6;
    }

    .shade {
      width: 18px;
      height: 10px;
      background: rgba(245, 127, 23, 0.24);
      border: 1px solid rgba(245, 127, 23, 0.35);
    }

    .impact-swatch {
      width: 10px;
      height: 14px;
      border-radius: 2px;
      display: inline-block;
    }

    .impact-swatch.positive { background: rgba(245, 127, 23, 0.85); }
    .impact-swatch.negative { background: rgba(21, 101, 192, 0.75); }

    .chart-wrap {
      border: 1px solid var(--divider-color);
      border-radius: 6px;
      overflow-x: auto;
      overflow-y: hidden;
      background: var(--card-background-color);
    }

    .chart-wrap svg {
      display: block;
      width: 720px;
      min-width: 720px;
      max-width: none;
      height: 260px;
    }

    .totals {
      display: grid;
      gap: 6px;
      font-size: 0.9rem;
    }

    .total-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }

    .slot-details {
      border: 1px solid var(--divider-color);
      border-radius: 6px;
      overflow: hidden;
      background: var(--card-background-color);
    }

    .slot-summary {
      padding: 12px;
      border-bottom: 1px solid var(--divider-color);
    }

    .slot-metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 8px;
      margin-top: 10px;
    }

    .slot-metric {
      border: 1px solid var(--divider-color);
      border-radius: 6px;
      padding: 8px;
      min-width: 0;
    }

    .metric-label {
      color: var(--secondary-text-color);
      font-size: 0.78rem;
    }

    .metric-value {
      color: var(--primary-text-color);
      font-weight: 700;
      overflow-wrap: anywhere;
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
  `;

  protected updated(changed: Map<string, unknown>) {
    if (changed.has("hass") && this.hass && !this._selectedDate) {
      this._selectedDate = this._todayIso();
    }
  }

  render() {
    return html`
      <div class="inspector">
        <button
          class="summary-button"
          type="button"
          aria-expanded=${this._expanded ? "true" : "false"}
          @click=${this._toggleExpanded}
        >
          <div class="summary-row">
            <div class="summary-left">
              <span class="summary-label">${this._t("bias_correction.inspector.title")}</span>
            </div>
            ${this._renderChevron()}
          </div>
        </button>
        ${this._expanded ? this._renderBody() : ""}
      </div>
    `;
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
      ${payload.range.isToday
        ? html`<div class="note">${this._t("bias_correction.inspector.today_training_note")}</div>`
        : ""}
      ${hasAnySeries
        ? html`
            ${this._renderLegend(payload)}
            <div class="chart-wrap">${this._renderChart(payload)}</div>
            ${this._renderTotals(payload)}
            ${this._renderSelectedSlotDetails(payload)}
          `
        : html`<div class="note">${this._tFormat("bias_correction.inspector.no_data", { date: this._formatDay(payload.date) })}</div>`}
    `;
  }

  private _renderLegend(payload: InspectorPayload) {
    return html`
      <div class="legend">
        ${payload.availability.hasRawForecast ? html`<span class="legend-item"><span class="swatch raw"></span>${this._t("bias_correction.inspector.raw_forecast")}</span>` : ""}
        ${payload.availability.hasCorrectedForecast ? html`<span class="legend-item"><span class="swatch corrected"></span>${this._t("bias_correction.inspector.corrected_forecast")}</span>` : ""}
        ${payload.availability.hasActuals ? html`<span class="legend-item"><span class="dot"></span>${this._t("bias_correction.inspector.actual_production")}</span>` : ""}
        ${payload.availability.hasInvalidated ? html`<span class="legend-item"><span class="dot invalidated"></span>${this._t("bias_correction.inspector.invalidated_production")}</span>` : ""}
        ${payload.series.impact.length
          ? html`
              <span class="legend-item">
                <span class="impact-swatch positive"></span>
                ${this._t("bias_correction.inspector.positive_impact")}
              </span>
              <span class="legend-item">
                <span class="impact-swatch negative"></span>
                ${this._t("bias_correction.inspector.negative_impact")}
              </span>
            `
          : ""}
      </div>
    `;
  }

  private _renderChart(payload: InspectorPayload) {
    const width = 720;
    const height = 260;
    const margin = { top: 18, right: 24, bottom: 34, left: 48 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;

    const rawPoints = toAveragePower(payload.series.raw);
    const correctedPoints = toAveragePower(payload.series.corrected);
    const actualPoints = toAveragePower(payload.series.actual, { bucketMinutes: 15 });
    const invalidatedPoints = toAveragePower(payload.series.invalidated, { bucketMinutes: 15 });
    const allPower = [
      ...rawPoints.map((entry) => entry.powerW),
      ...correctedPoints.map((entry) => entry.powerW),
      ...actualPoints.map((entry) => entry.powerW),
      ...invalidatedPoints.map((entry) => entry.powerW),
    ];
    const maxW = Math.max(1000, ...allPower);
    const maxKw = Math.ceil(maxW / 1000);
    const yTicks = this._buildYTicks(maxKw);

    const xForMinutes = (minutes: number) => margin.left + (minutes / 1440) * plotWidth;
    const yForW = (powerW: number) =>
      margin.top + plotHeight - (powerW / (maxKw * 1000)) * plotHeight;

    const linePath = (points: ChartEntry[]) =>
      points
        .map((entry, index) => {
          const command = index === 0 ? "M" : "L";
          return `${command}${xForMinutes(entry.minutes).toFixed(1)},${yForW(entry.powerW).toFixed(1)}`;
        })
        .join(" ");

    return svg`
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label=${this._t("bias_correction.inspector.title")}>
        <rect x="0" y="0" width=${width} height=${height} fill="var(--card-background-color)"></rect>
        ${yTicks.map((tick) => {
          const y = yForW(tick * 1000);
          return svg`
            <line x1=${margin.left} y1=${y} x2=${width - margin.right} y2=${y} stroke="var(--divider-color)" stroke-width="1"></line>
            <text x=${margin.left - 8} y=${y + 4} text-anchor="end" fill="var(--secondary-text-color)" font-size="11">${tick.toFixed(1)}</text>
          `;
        })}
        ${[0, 3, 6, 9, 12, 15, 18, 21, 24].map((hour) => {
          const x = margin.left + (hour / 24) * plotWidth;
          return svg`
            <line x1=${x} y1=${margin.top} x2=${x} y2=${height - margin.bottom} stroke="var(--divider-color)" stroke-width="1" opacity="0.55"></line>
            <text x=${x} y=${height - 10} text-anchor="middle" fill="var(--secondary-text-color)" font-size="11">${String(hour).padStart(2, "0")}</text>
          `;
        })}
        <text x="12" y="16" fill="var(--secondary-text-color)" font-size="11">${this._t("bias_correction.inspector.power_axis_label")}</text>
        ${this._renderImpactColumns(payload.series.impact, margin.left, margin.top, plotWidth, plotHeight)}
        ${rawPoints.length > 1
          ? svg`<path d=${linePath(rawPoints)} fill="none" stroke="#1565c0" stroke-width="2.4"></path>`
          : rawPoints.length === 1
            ? svg`<circle cx=${xForMinutes(rawPoints[0].minutes)} cy=${yForW(rawPoints[0].powerW)} r="3.5" fill="#1565c0"></circle>`
            : ""}
        ${correctedPoints.length > 1
          ? svg`<path d=${linePath(correctedPoints)} fill="none" stroke="#2e7d32" stroke-width="2.4"></path>`
          : correctedPoints.length === 1
            ? svg`<circle cx=${xForMinutes(correctedPoints[0].minutes)} cy=${yForW(correctedPoints[0].powerW)} r="3.5" fill="#2e7d32"></circle>`
          : ""}
        ${actualPoints.map((entry) => svg`
          <circle cx=${xForMinutes(entry.minutes)} cy=${yForW(entry.powerW)} r="3.5" fill="#c62828"></circle>
        `)}
        ${invalidatedPoints.map((entry) => svg`
          <circle cx=${xForMinutes(entry.minutes)} cy=${yForW(entry.powerW)} r="3.5" fill="#9aa0a6">
            <title>${this._t("bias_correction.inspector.invalidated_production")}</title>
          </circle>
        `)}
      </svg>
    `;
  }

  private _renderImpactColumns(
    impacts: ImpactPoint[],
    plotLeft: number,
    plotTop: number,
    plotWidth: number,
    plotHeight: number,
  ) {
    const values = impacts
      .map((point) => Math.abs(point.impactWh ?? 0))
      .filter((value) => Number.isFinite(value));
    const maxImpact = Math.max(1, ...values);
    const selectedSlot = resolveSelectedImpactSlot(impacts, this._selectedSlot);
    return impacts.map((point) => {
      if (point.impactWh === null || !Number.isFinite(point.impactWh)) return "";
      const match = point.slot.match(/^(\d{2}):(\d{2})$/);
      if (!match) return "";
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      const startMinutes = hour * 60 + minute;
      const x = plotLeft + (startMinutes / 1440) * plotWidth;
      const width = Math.max(3, plotWidth / 96);
      const columnHeight = Math.max(2, (Math.abs(point.impactWh) / maxImpact) * plotHeight);
      const y = plotTop + plotHeight - columnHeight;
      const selected = selectedSlot === point.slot;
      const fill = point.impactWh >= 0 ? "rgba(245, 127, 23, 0.72)" : "rgba(21, 101, 192, 0.62)";
      return svg`
        <rect
          x=${x}
          y=${y}
          width=${width}
          height=${columnHeight}
          fill=${fill}
          stroke=${selected ? "var(--primary-text-color)" : "transparent"}
          stroke-width=${selected ? "2" : "0"}
          style="cursor: pointer;"
          @click=${() => this._selectSlot(point.slot)}
        >
          <title>${point.slot} ${this._formatSignedWh(point.impactWh)}</title>
        </rect>
      `;
    });
  }

  private _selectSlot(slot: string) {
    const previous = this._selectedSlot;
    this._selectedSlot = slot;
    this.requestUpdate("_selectedSlot", previous);
  }

  private _buildYTicks(maxKwh: number) {
    const step = maxKwh <= 4 ? 1 : Math.ceil(maxKwh / 4);
    const ticks: number[] = [];
    for (let value = 0; value <= maxKwh; value += step) {
      ticks.push(value);
    }
    if (ticks[ticks.length - 1] !== maxKwh) {
      ticks.push(maxKwh);
    }
    return ticks;
  }

  private _renderTotals(payload: InspectorPayload) {
    return html`
      <div class="totals">
        <strong>${this._t("bias_correction.inspector.daily_totals")}</strong>
        <div class="total-row"><span>${this._t("bias_correction.inspector.raw_forecast")}</span><span>${this._formatWh(payload.totals.rawWh)}</span></div>
        <div class="total-row"><span>${this._t("bias_correction.inspector.corrected_forecast")}</span><span>${this._formatWh(payload.totals.correctedWh)}</span></div>
        <div class="total-row"><span>${this._t("bias_correction.inspector.actual_production")}</span><span>${this._formatWh(payload.totals.actualWh)}</span></div>
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
    return html`
      <div class="slot-details">
        <div class="slot-summary">
          <strong>${this._tFormat("bias_correction.inspector.selected_slot", { slot: selectedSlot })}</strong>
          <div class="slot-metrics">
            ${this._renderMetric(this._t("bias_correction.inspector.raw_forecast"), this._formatWh(raw?.valueWh ?? impact?.rawWh ?? null))}
            ${this._renderMetric(this._t("bias_correction.inspector.corrected_forecast"), this._formatWh(corrected?.valueWh ?? impact?.correctedWh ?? null))}
            ${this._renderMetric(this._t("bias_correction.inspector.actual_production"), this._formatWh(actual?.valueWh ?? null))}
            ${this._renderMetric(this._t("bias_correction.inspector.correction_impact"), this._formatSignedWh(impact?.impactWh ?? null))}
            ${this._renderMetric(this._t("bias_correction.inspector.factor"), this._formatFactor(impact?.factor ?? trainingSlot?.factor ?? null))}
          </div>
        </div>
        ${this._renderContributionTable(payload, selectedSlot, trainingSlot)}
      </div>
    `;
  }

  private _renderMetric(label: string, value: string) {
    return html`
      <div class="slot-metric">
        <div class="metric-label">${label}</div>
        <div class="metric-value">${value}</div>
      </div>
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
    return html`
      <div class="slot-summary">
        <strong>${this._t("bias_correction.inspector.training_contribution")}</strong>
        <div class="day-state">
          ${this._tFormat("bias_correction.inspector.training_contribution_meta", {
            ratio: this._formatFactor(trainingSlot.rawRatio),
            factor: this._formatFactor(trainingSlot.factor),
          })}
        </div>
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
            ${trainingSlot.rows.map((row) => html`
              <tr>
                <td>${row.date || "-"}</td>
                <td class="numeric">${this._formatWh(row.forecastWh)}</td>
                <td class="numeric">${this._formatWh(row.actualWh)}</td>
                <td class="numeric">${this._formatFactor(row.ratio)}</td>
                <td>${this._formatContributionStatus(row.status, row.reason)}</td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>
    `;
  }

  private _toggleExpanded() {
    this._expanded = !this._expanded;
    this.requestUpdate();
    if (!this._expanded) {
      return;
    }
    if (!this._selectedDate) {
      this._selectedDate = this._todayIso();
    }
    if (!this._payload) {
      this._load();
    }
  }

  private _renderChevron() {
    return svg`<svg class="summary-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d=${HelmanBiasCorrectionInspector._CHEVRON_PATH}></path></svg>`;
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
      const payload = await this.hass.callWS({
        type: "helman/solar_bias/inspector",
        date: requestedDate,
      });
      if (requestId === this._activeRequestId && requestedDate === this._selectedDate) {
        this._payload = payload;
        this._selectedSlot = resolveSelectedImpactSlot(
          payload.series.impact,
          this._selectedSlot,
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

  private _parseIsoDate(value: string) {
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

  private _formatContributionStatus(status: string, reason: string | null) {
    const translated = this._t(`bias_correction.inspector.contribution_status.${status}`);
    if (!reason) return translated;
    return `${translated} (${reason})`;
  }

  private _t(key: string): string {
    return getLocalizeFunction(this.hass ?? undefined)(key) ?? this._fallbackLocalize(key);
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
    "helman-bias-correction-inspector": HelmanBiasCorrectionInspector;
  }
}

if (!customElements.get("helman-bias-correction-inspector")) {
  customElements.define("helman-bias-correction-inspector", HelmanBiasCorrectionInspector);
}
