import { LitElement, css, html, svg } from "lit";
import { property, state } from "lit/decorators.js";
import { getLocalizeFunction, type LocalizeFunction } from "./localize/localize";

type InspectorPoint = { timestamp: string; valueWh: number };
type FactorPoint = { slot: string; factor: number };
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
    factors: FactorPoint[];
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
    hasProfile: boolean;
  };
};

export class HelmanBiasCorrectionInspector extends LitElement {
  @property({ attribute: false }) hass: any;

  @state() private _expanded = false;
  @state() private _selectedDate = "";
  @state() private _payload: InspectorPayload | null = null;
  @state() private _loading = false;
  @state() private _error = "";

  private _fallbackLocalize: LocalizeFunction = getLocalizeFunction();
  private _activeRequestId = 0;
  private _activeRequestDate: string | null = null;
  private static readonly _CHEVRON_PATH = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";

  static styles = css`
    .inspector {
      border: 1px solid var(--divider-color);
      border-radius: 12px;
      background: var(--card-background-color);
      overflow: hidden;
    }

    .inspector > summary {
      list-style: none;
      cursor: pointer;
      padding: 14px 16px;
      user-select: none;
    }

    .inspector > summary::-webkit-details-marker {
      display: none;
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

    .inspector[open] .summary-chevron {
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

    .shade {
      width: 18px;
      height: 10px;
      background: rgba(245, 127, 23, 0.24);
      border: 1px solid rgba(245, 127, 23, 0.35);
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
  `;

  protected updated(changed: Map<string, unknown>) {
    if (changed.has("hass") && this.hass && !this._selectedDate) {
      this._selectedDate = this._todayIso();
    }
  }

  render() {
    return html`
      <details class="inspector" ?open=${this._expanded}>
        <summary @click=${this._handleSummaryClick}>
          <div class="summary-row">
            <div class="summary-left">
              <span class="summary-label">${this._t("bias_correction.inspector.title")}</span>
            </div>
            ${this._renderChevron()}
          </div>
        </summary>
        ${this._expanded ? this._renderBody() : ""}
      </details>
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
    return html`
      <div class="nav">
        <button class="icon-button" title=${this._t("bias_correction.inspector.previous_day")} ?disabled=${!canGoPrevious || this._loading} @click=${() => this._moveDay(-1)}>&lt;</button>
        <div class="day-meta">
          <div class="day-label">${this._formatDay(this._selectedDate)}</div>
          <div class="day-state">${payload?.range.isToday ? this._t("bias_correction.inspector.today") : payload?.range.isFuture ? this._t("bias_correction.inspector.forecast_only") : ""}</div>
        </div>
        <button class="icon-button" title=${this._t("bias_correction.inspector.next_day")} ?disabled=${!canGoNext || this._loading} @click=${() => this._moveDay(1)}>&gt;</button>
      </div>
    `;
  }

  private _renderContent(payload: InspectorPayload) {
    const hasAnySeries =
      payload.availability.hasRawForecast ||
      payload.availability.hasCorrectedForecast ||
      payload.availability.hasActuals;

    return html`
      ${!payload.availability.hasProfile
        ? html`<div class="note">${this._t("bias_correction.inspector.no_profile")}</div>`
        : ""}
      ${hasAnySeries
        ? html`
            ${this._renderLegend(payload)}
            <div class="chart-wrap">${this._renderChart(payload)}</div>
            ${this._renderTotals(payload)}
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
        ${payload.availability.hasProfile ? html`<span class="legend-item"><span class="shade"></span>${this._t("bias_correction.inspector.correction_factor")}</span>` : ""}
      </div>
    `;
  }

  private _renderChart(payload: InspectorPayload) {
    const width = 720;
    const height = 260;
    const margin = { top: 18, right: 24, bottom: 34, left: 48 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const pointMinutes = (timestamp: string) => {
      const match = timestamp.match(/T(\d{2}):(\d{2})/);
      if (!match) return null;
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (
        !Number.isFinite(hour) ||
        !Number.isFinite(minute) ||
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59
      ) {
        return null;
      }
      return hour * 60 + minute;
    };
    const chartPoints = (points: InspectorPoint[]) =>
      points
        .map((point) => ({ point, minutes: pointMinutes(point.timestamp) }))
        .filter(
          (entry): entry is { point: InspectorPoint; minutes: number } =>
            entry.minutes !== null && Number.isFinite(entry.point.valueWh),
        );
    const rawPoints = chartPoints(payload.series.raw);
    const correctedPoints = chartPoints(payload.series.corrected);
    const actualPoints = chartPoints(payload.series.actual);
    const allEnergy = [
      ...rawPoints.map((entry) => entry.point.valueWh),
      ...correctedPoints.map((entry) => entry.point.valueWh),
      ...actualPoints.map((entry) => entry.point.valueWh),
    ];
    const maxWh = Math.max(1000, ...allEnergy);
    const maxKwh = Math.ceil(maxWh / 1000);
    const yTicks = this._buildYTicks(maxKwh);

    const xForMinutes = (minutes: number) => margin.left + (minutes / 1440) * plotWidth;
    const yForWh = (valueWh: number) =>
      margin.top + plotHeight - (valueWh / (maxKwh * 1000)) * plotHeight;

    const linePath = (points: { point: InspectorPoint; minutes: number }[]) =>
      points
        .map((entry, index) => {
          const command = index === 0 ? "M" : "L";
          return `${command}${xForMinutes(entry.minutes).toFixed(1)},${yForWh(entry.point.valueWh).toFixed(1)}`;
        })
        .join(" ");

    return svg`
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label=${this._t("bias_correction.inspector.title")}>
        <rect x="0" y="0" width=${width} height=${height} fill="var(--card-background-color)"></rect>
        ${this._renderFactorBands(payload.series.factors, margin.left, margin.top, plotWidth, plotHeight)}
        ${yTicks.map((tick) => {
          const y = yForWh(tick * 1000);
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
        <text x="12" y="16" fill="var(--secondary-text-color)" font-size="11">kWh</text>
        ${rawPoints.length > 1
          ? svg`<path d=${linePath(rawPoints)} fill="none" stroke="#1565c0" stroke-width="2.4"></path>`
          : rawPoints.length === 1
            ? svg`<circle cx=${xForMinutes(rawPoints[0].minutes)} cy=${yForWh(rawPoints[0].point.valueWh)} r="3.5" fill="#1565c0"></circle>`
            : ""}
        ${correctedPoints.length > 1
          ? svg`<path d=${linePath(correctedPoints)} fill="none" stroke="#2e7d32" stroke-width="2.4"></path>`
          : correctedPoints.length === 1
            ? svg`<circle cx=${xForMinutes(correctedPoints[0].minutes)} cy=${yForWh(correctedPoints[0].point.valueWh)} r="3.5" fill="#2e7d32"></circle>`
          : ""}
        ${actualPoints.map((entry) => svg`
          <circle cx=${xForMinutes(entry.minutes)} cy=${yForWh(entry.point.valueWh)} r="3.5" fill="#c62828"></circle>
        `)}
      </svg>
    `;
  }

  private _renderFactorBands(
    factors: FactorPoint[],
    plotLeft: number,
    plotTop: number,
    plotWidth: number,
    plotHeight: number,
  ) {
    if (!factors.length) return "";
    const values = factors.map((point) => point.factor).filter((value) => Number.isFinite(value));
    if (!values.length) return "";
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(max - min, 0.01);
    return factors.map((point) => {
      if (!Number.isFinite(point.factor)) return "";
      const match = point.slot.match(/^(\d{2}):(\d{2})$/);
      if (!match) return "";
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (
        !Number.isFinite(hour) ||
        !Number.isFinite(minute) ||
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59
      ) {
        return "";
      }
      const startMinutes = hour * 60 + minute;
      const x = plotLeft + (startMinutes / 1440) * plotWidth;
      const bandWidth = Math.max(2, plotWidth / 96);
      const intensity = Math.abs(point.factor - 1) / Math.max(Math.abs(max - 1), Math.abs(min - 1), span);
      const opacity = Math.min(0.34, 0.06 + intensity * 0.28);
      const fill = point.factor >= 1 ? "245, 127, 23" : "21, 101, 192";
      return svg`<rect x=${x} y=${plotTop} width=${bandWidth} height=${plotHeight} fill="rgba(${fill}, ${opacity})"></rect>`;
    });
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

  private _handleSummaryClick(event: Event) {
    event.preventDefault();
    this._expanded = !this._expanded;
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

  private _haTimeZone(): string | undefined {
    return this._payload?.timezone ?? this.hass?.config?.time_zone;
  }

  private _formatWh(value: number | null) {
    if (value === null) return this._t("bias_correction.inspector.actual_not_available");
    return `${(value / 1000).toFixed(1)} kWh`;
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
