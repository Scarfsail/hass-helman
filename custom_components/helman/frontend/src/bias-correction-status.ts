import { LitElement, css, html } from "lit";
import { property, state } from "lit/decorators.js";

export class HelmanBiasCorrectionStatus extends LitElement {
  @property({ attribute: false }) hass: any;

  @state() private _status: any = null;
  @state() private _profile: any = null;
  @state() private _loading = false;
  @state() private _trainInProgress = false;
  @state() private _message: string = "";

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
      this._message = "Home Assistant not available";
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
      this._message = e?.message ?? "Failed to load status";
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
      this._message = "Training completed successfully";
      if (result?.status === "profile_trained") {
        await this._loadProfile();
      }
    } catch (e: any) {
      this._message = `Training failed: ${e?.message ?? "Unknown error"}`;
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
        return { text: status, class: "badge-success" };
      case "insufficient_history":
      case "config_changed_pending_retrain":
      case "training_failed":
        return { text: status, class: "badge-warning" };
      case "not_configured":
      case "no_training_yet":
        return { text: status, class: "badge-info" };
      default:
        return { text: status || "Unknown", class: "badge-info" };
    }
  }

  private _formatDate(dateStr: string | null): string {
    if (!dateStr) return "N/A";
    try {
      return new Date(dateStr).toLocaleString();
    } catch {
      return dateStr;
    }
  }

  render() {
    if (this._loading) {
      return html`<div class="container"><p>Loading status…</p></div>`;
    }

    if (!this._status) {
      return html`<div class="container"><div class="info-box">Unable to load bias correction status</div></div>`;
    }

    try {
      const statusBadge = this._getStatusBadge();

      return html`
        <div class="container">
          <div class="section">
            <div class="section-title">Status</div>
            <div class="status-grid">
              <div class="status-row">
                <span class="status-label">Enabled</span>
                <span class="status-value">${this._status.enabled ? "Yes" : "No"}</span>
              </div>
              <div class="status-row">
                <span class="status-label">Current Status</span>
                <span class="badge ${statusBadge.class}">${statusBadge.text}</span>
              </div>
              ${this._status.trainedAt
                ? html`
                    <div class="status-row">
                      <span class="status-label">Trained At</span>
                      <span class="status-value">${this._formatDate(this._status.trainedAt)}</span>
                    </div>
                  `
                : ""}
              ${this._status.nextScheduledTrainingAt
                ? html`
                    <div class="status-row">
                      <span class="status-label">Next Training</span>
                      <span class="status-value">${this._formatDate(this._status.nextScheduledTrainingAt)}</span>
                    </div>
                  `
                : ""}
              <div class="status-row">
                <span class="status-label">Effective Variant</span>
                <span class="status-value">${this._status.effectiveVariant}</span>
              </div>
              <div class="status-row">
                <span class="status-label">Data Available</span>
                <span class="status-value">${this._status.usableDays} days</span>
              </div>
              ${this._status.status === "insufficient_history"
                ? html`
                    <div class="info-box" style="margin-top: 8px;">
                      Not enough historical data yet. Have ${this._status.usableDays} days, need at least ${this._status.minHistoryDays} days for training.
                    </div>
                  `
                : ""}
              ${this._status.errorReason
                ? html`
                    <div class="status-row" style="background: rgba(198, 40, 40, 0.1);">
                      <span class="status-label">Error</span>
                      <span class="status-value" style="color: #c62828;">${this._status.errorReason}</span>
                    </div>
                  `
                : ""}
            </div>
          </div>

          ${this._status.droppedDays && this._status.droppedDays.length > 0
            ? html`
                <div class="section">
                  <div class="section-title">Dropped Days</div>
                  <div style="font-size: 0.9rem; color: var(--secondary-text-color);">
                    ${this._status.droppedDays.map((day: any) => html`
                      <div style="padding: 4px 0;">
                        <strong>${day.date}:</strong> ${day.reason}
                      </div>
                    `)}
                  </div>
                </div>
              `
            : ""}

          <div class="section">
            <div class="section-title">Actions</div>
            <div class="controls">
              <button
                class="primary"
                @click=${this._trainNow}
                ?disabled=${this._trainInProgress || this._status?.enabled === false}
              >
                ${this._trainInProgress ? html`<span class="spinner"></span> Training…` : "Train Now"}
              </button>
              <button
                @click=${this._loadStatus}
                ?disabled=${this._loading}
              >
                Refresh Status
              </button>
            </div>
          </div>

          ${this._message
            ? html`
                <div class="message ${this._message.startsWith("Training failed") ? "error" : "success"}">
                  ${this._message}
                </div>
              `
            : ""}

          <div class="info-box">
            Solar bias correction helps adjust solar forecast accuracy based on your system's characteristics.
            Enable training to automatically improve predictions over time.
          </div>
        </div>
      `;
    } catch (e: any) {
      console.error("Render error:", e);
      return html`<div class="container"><div class="info-box" style="color: red;">Render error: ${e?.message}</div></div>`;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "helman-bias-correction-status": HelmanBiasCorrectionStatus;
  }
}

customElements.define("helman-bias-correction-status", HelmanBiasCorrectionStatus);
