import { LitElement, css, html } from "lit";
import { property, state } from "lit/decorators.js";
import "./bias-correction-inspector";
import { getLocalizeFunction, type LocalizeFunction } from "./localize/localize";

export class HelmanBiasCorrectionStatus extends LitElement {
  @property({ attribute: false }) hass: any;

  @state() private _status: any = null;
  @state() private _profile: any = null;
  @state() private _loading = false;
  @state() private _trainInProgress = false;
  @state() private _message: string = "";
  @state() private _messageKind: "success" | "error" = "success";

  private _fallbackLocalize: LocalizeFunction = getLocalizeFunction();

  static styles = css`
    .container {
      padding: 16px;
      display: grid;
      gap: 20px;
    }

    .section {
      display: grid;
      gap: 12px;
    }

    .section-title {
      font-weight: 600;
      font-size: 0.95rem;
      color: var(--primary-text-color);
      border-bottom: 1px solid var(--divider-color);
      padding-bottom: 8px;
    }

    .status-grid {
      display: grid;
      gap: 8px;
    }

    .status-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px;
      background: var(--secondary-background-color);
      border-radius: 6px;
      border: 1px solid var(--divider-color);
    }

    .status-label {
      font-weight: 500;
      color: var(--primary-text-color);
    }

    .status-value {
      color: var(--secondary-text-color);
      font-size: 0.9rem;
    }

    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 0.85rem;
      font-weight: 600;
    }

    .badge-success {
      background: rgba(46, 125, 50, 0.2);
      color: #2e7d32;
    }

    .badge-warning {
      background: rgba(245, 127, 23, 0.2);
      color: #f57f17;
    }

    .badge-error {
      background: rgba(198, 40, 40, 0.2);
      color: #c62828;
    }

    .badge-info {
      background: rgba(33, 150, 243, 0.2);
      color: #1976d2;
    }

    .controls {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }

    button {
      padding: 8px 16px;
      border: 1px solid var(--divider-color);
      border-radius: 6px;
      background: var(--card-background-color);
      color: var(--primary-text-color);
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }

    button:hover:not(:disabled) {
      background: var(--secondary-background-color);
    }

    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    button.primary {
      background: var(--primary-color);
      color: white;
      border-color: var(--primary-color);
    }

    button.primary:hover:not(:disabled) {
      opacity: 0.9;
    }

    .info-box {
      padding: 12px;
      background: rgba(33, 150, 243, 0.1);
      border-left: 3px solid var(--primary-color);
      border-radius: 4px;
      font-size: 0.9rem;
      color: var(--primary-text-color);
    }

    .message {
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 0.9rem;
    }

    .message.success {
      background: rgba(46, 125, 50, 0.2);
      color: #2e7d32;
    }

    .message.error {
      background: rgba(198, 40, 40, 0.2);
      color: #c62828;
    }

    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: currentColor;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .profile-section {
      background: var(--secondary-background-color);
      padding: 12px;
      border-radius: 6px;
      border: 1px solid var(--divider-color);
    }

    .profile-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    .profile-list li {
      padding: 4px 0;
      font-size: 0.9rem;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this._loadStatus();
  }

  private async _loadStatus() {
    if (!this.hass) {
      this._message = this._t("bias_correction.status_panel.home_assistant_not_available");
      this._messageKind = "error";
      this._loading = false;
      return;
    }
    this._loading = true;
    try {
      const result = await this.hass.callWS({ type: "helman/solar_bias/status" });
      this._status = result;
      if (result?.status === "profile_trained") {
        await this._loadProfile();
      }
    } catch (e: any) {
      this._message = this._formatError(e, "bias_correction.status_panel.failed_to_load_status");
      this._messageKind = "error";
      console.error("Error loading bias correction status:", e);
    } finally {
      this._loading = false;
      this.requestUpdate();
    }
  }

  private async _loadProfile() {
    if (!this.hass) return;
    try {
      const result = await this.hass.callWS({ type: "helman/solar_bias/profile" });
      this._profile = result;
    } catch (e: any) {
      // Silently ignore profile fetch errors
      console.debug("No profile available:", e?.message);
    } finally {
      this.requestUpdate();
    }
  }

  private async _trainNow() {
    if (this._trainInProgress || !this.hass) return;
    this._trainInProgress = true;
    this._message = "";
    try {
      const result = await this.hass.callWS({ type: "helman/solar_bias/train_now" });
      this._status = result;
      this._message = this._t("bias_correction.status_panel.training_completed");
      this._messageKind = "success";
      if (result?.status === "profile_trained") {
        await this._loadProfile();
      }
    } catch (e: any) {
      this._message = this._tFormat("bias_correction.status_panel.training_failed", {
        error: this._formatError(e, "bias_correction.status_panel.unknown_error"),
      });
      this._messageKind = "error";
      console.error("Training failed:", e);
    } finally {
      this._trainInProgress = false;
      this.requestUpdate();
    }
  }

  private _getStatusBadge() {
    const status = this._status?.status;
    switch (status) {
      case "profile_trained":
      case "applied":
        return { text: this._formatStatus(status), class: "badge-success" };
      case "insufficient_history":
      case "config_changed_pending_retrain":
      case "training_failed":
        return { text: this._formatStatus(status), class: "badge-warning" };
      case "not_configured":
      case "no_training_yet":
        return { text: this._formatStatus(status), class: "badge-info" };
      default:
        return { text: this._formatStatus(status), class: "badge-info" };
    }
  }

  private _formatDate(dateStr: string | null): string {
    if (!dateStr) return this._t("common.not_available");
    try {
      return new Date(dateStr).toLocaleString();
    } catch {
      return dateStr;
    }
  }

  private _formatStatus(status: string | undefined): string {
    if (!status) return this._t("common.unknown");
    return this._tValue(`bias_correction.statuses.${status}`, status);
  }

  private _formatEffectiveVariant(variant: string | undefined): string {
    if (!variant) return this._t("common.unknown");
    return this._tValue(`bias_correction.effective_variants.${variant}`, variant);
  }

  private _formatDroppedReason(reason: string | undefined): string {
    if (!reason) return this._t("common.unknown");
    return this._tValue(`bias_correction.dropped_reasons.${reason}`, reason);
  }

  private _formatError(error: any, fallbackKey: string): string {
    const code = typeof error?.code === "string" ? error.code : undefined;
    if (code) {
      const translated = this._tValue(`bias_correction.error_codes.${code}`, "");
      if (translated) return translated;
    }
    return typeof error?.message === "string" && error.message
      ? error.message
      : this._t(fallbackKey);
  }

  render() {
    if (this._loading) {
      return html`<div class="container"><p>${this._t("bias_correction.status_panel.loading_status")}</p></div>`;
    }

    if (!this._status) {
      return html`<div class="container"><div class="info-box">${this._t("bias_correction.status_panel.unable_to_load_status")}</div></div>`;
    }

    try {
      const statusBadge = this._getStatusBadge();

      return html`
        <div class="container">
          <div class="section">
            <div class="section-title">${this._t("bias_correction.status_panel.section_status")}</div>
            <div class="status-grid">
              <div class="status-row">
                <span class="status-label">${this._t("bias_correction.status_panel.enabled")}</span>
                <span class="status-value">${this._status.enabled ? this._t("common.yes") : this._t("common.no")}</span>
              </div>
              <div class="status-row">
                <span class="status-label">${this._t("bias_correction.status_panel.current_status")}</span>
                <span class="badge ${statusBadge.class}">${statusBadge.text}</span>
              </div>
              ${this._status.trainedAt
                ? html`
                    <div class="status-row">
                      <span class="status-label">${this._t("bias_correction.status_panel.trained_at")}</span>
                      <span class="status-value">${this._formatDate(this._status.trainedAt)}</span>
                    </div>
                  `
                : ""}
              ${this._status.nextScheduledTrainingAt
                ? html`
                    <div class="status-row">
                      <span class="status-label">${this._t("bias_correction.status_panel.next_training")}</span>
                      <span class="status-value">${this._formatDate(this._status.nextScheduledTrainingAt)}</span>
                    </div>
                  `
                : ""}
              <div class="status-row">
                <span class="status-label">${this._t("bias_correction.status_panel.effective_variant")}</span>
                <span class="status-value">${this._formatEffectiveVariant(this._status.effectiveVariant)}</span>
              </div>
              <div class="status-row">
                <span class="status-label">${this._t("bias_correction.status_panel.training_days_used")}</span>
                <span class="status-value">${this._tFormat("bias_correction.status_panel.training_days_required", {
                  used: this._status.usableDays,
                  required: this._status.minHistoryDays,
                })}</span>
              </div>
              ${this._status.slotInvalidationEnabled || this._status.invalidatedSlotCount > 0
                ? html`
                    <div class="status-row">
                      <span class="status-label">${this._t("bias_correction.status_panel.invalidated_training_slots")}</span>
                      <span class="status-value">${this._tFormat("bias_correction.status_panel.invalidated_training_slots_value", {
                        count: this._status.invalidatedSlotCount ?? 0,
                        trainedAt: this._formatDate(this._status.trainedAt),
                      })}</span>
                    </div>
                  `
                : ""}
              ${this._status.status === "insufficient_history"
                ? html`
                    <div class="info-box" style="margin-top: 8px;">
                      ${this._tFormat("bias_correction.status_panel.insufficient_history_text", {
                        used: this._status.usableDays,
                        required: this._status.minHistoryDays,
                      })}
                    </div>
                  `
                : ""}
              ${this._status.errorReason
                ? html`
                    <div class="status-row" style="background: rgba(198, 40, 40, 0.1);">
                      <span class="status-label">${this._t("bias_correction.status_panel.error")}</span>
                      <span class="status-value" style="color: #c62828;">${this._status.errorReason}</span>
                    </div>
                  `
                : ""}
            </div>
          </div>

          ${this._status.droppedDays && this._status.droppedDays.length > 0
            ? html`
                <div class="section">
                  <div class="section-title">${this._t("bias_correction.status_panel.dropped_days")}</div>
                  <div style="font-size: 0.9rem; color: var(--secondary-text-color);">
                    ${this._status.droppedDays.map((day: any) => html`
                      <div style="padding: 4px 0;">
                        <strong>${day.date}:</strong> ${this._formatDroppedReason(day.reason)}
                      </div>
                    `)}
                  </div>
                </div>
              `
            : ""}

          <div class="section">
            <div class="section-title">${this._t("bias_correction.status_panel.actions")}</div>
            <div class="controls">
              <button
                class="primary"
                @click=${this._trainNow}
                ?disabled=${this._trainInProgress || this._status?.enabled === false}
              >
                ${this._trainInProgress
                  ? html`<span class="spinner"></span> ${this._t("bias_correction.status_panel.training")}`
                  : this._t("bias_correction.status_panel.train_now")}
              </button>
              <button
                @click=${this._loadStatus}
                ?disabled=${this._loading}
              >
                ${this._t("bias_correction.status_panel.refresh_status")}
              </button>
            </div>
          </div>

          ${this._message
            ? html`
                <div class="message ${this._messageKind}">
                  ${this._message}
                </div>
              `
            : ""}

          <helman-bias-correction-inspector .hass=${this.hass}></helman-bias-correction-inspector>

          <div class="info-box">
            ${this._t("bias_correction.status_panel.info")}
          </div>
        </div>
      `;
    } catch (e: any) {
      console.error("Render error:", e);
      return html`<div class="container"><div class="info-box" style="color: red;">${this._tFormat("bias_correction.status_panel.render_error", {
        error: e?.message ?? this._t("common.unknown"),
      })}</div></div>`;
    }
  }

  private _t(key: string): string {
    return (
      getLocalizeFunction(this.hass ?? undefined)(key)
      ?? this._fallbackLocalize(key)
      ?? key
    );
  }

  private _tValue(key: string, fallback: string): string {
    const translated = this._t(key);
    return translated === key ? fallback : translated;
  }

  private _tFormat(key: string, values: Record<string, string | number>): string {
    let text = this._t(key) || key;
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "helman-bias-correction-status": HelmanBiasCorrectionStatus;
  }
}

customElements.define("helman-bias-correction-status", HelmanBiasCorrectionStatus);
