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
  @state() private _selectedDate = this._todayIso();
  @state() private _payload: InspectorPayload | null = null;
  @state() private _loading = false;
  @state() private _error = "";

  private _fallbackLocalize: LocalizeFunction = getLocalizeFunction();
  private _activeRequestId = 0;
  private _activeRequestDate: string | null = null;

  static styles = css`
    .inspector {
      display: grid;
      gap: 12px;
      border-top: 1px solid var(--divider-color);
      padding-top: 12px;
    }

    .summary {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 0;
      border: 0;
      background: transparent;
      color: var(--primary-text-color);
      font-weight: 600;
      cursor: pointer;
    }

    .summary::before {
      content: ">";
      width: 16px;
    }

    .summary[aria-expanded="true"]::before {
      content: "v";
    }

    .body {
      display: grid;
      gap: 12px;
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
      min-height: 260px;
      border: 1px solid var(--divider-color);
      border-radius: 6px;
      overflow: hidden;
      background: var(--card-background-color);
    }

    svg {
      display: block;
      width: 100%;
      height: auto;
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
    if (changed.has("hass") && this.hass && this._expanded && !this._payload) {
      this._load();
    }
  }

  render() {
    return html`
      <div class="inspector">
        <button
          class="summary"
          aria-expanded=${this._expanded ? "true" : "false"}
          @click=${this._toggle}
        >
          <span>${this._t("bias_correction.inspector.title")}</span>
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

  private _renderChart(_payload: InspectorPayload) {
    return svg`
      <svg viewBox="0 0 720 260" role="img" aria-label=${this._t("bias_correction.inspector.title")}>
        <rect x="0" y="0" width="720" height="260" fill="var(--card-background-color)" />
        <line x1="56" y1="206" x2="680" y2="206" stroke="var(--divider-color)" stroke-width="1" />
        <line x1="56" y1="34" x2="56" y2="206" stroke="var(--divider-color)" stroke-width="1" />
        <path d="M80 178 C170 132 250 142 340 96 S520 68 656 120" fill="none" stroke="#1565c0" stroke-width="3" opacity="0.45" />
        <path d="M80 186 C170 118 250 126 340 84 S520 76 656 112" fill="none" stroke="#2e7d32" stroke-width="3" opacity="0.45" />
      </svg>
    `;
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

  private _toggle() {
    this._expanded = !this._expanded;
    if (this._expanded && !this._payload) {
      this._load();
    }
  }

  private async _load() {
    if (!this.hass) return;
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
    const next = new Date(`${this._selectedDate}T12:00:00`);
    next.setDate(next.getDate() + delta);
    this._selectedDate = this._formatLocalDate(next);
    this._load();
  }

  private _todayIso() {
    return this._formatLocalDate(new Date());
  }

  private _formatLocalDate(value: Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  private _formatDay(value: string) {
    return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
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
