import { LitElement, css, html, nothing } from "lit";
import type { PropertyValues, TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import {
  MISSING_TRANSLATION_PREFIX,
  getLocalizeFunction,
} from "../cards/shared/config/localize/localize";

/**
 * The Training tab's status surface, read from `helman/training/status`.
 *
 * Every visual state here is driven by the job's normalized `health`, which
 * each job derives from its own outcomes on the backend. The raw outcome is
 * only ever looked up as a label -- never matched -- because the same string
 * means different things per job.
 */

export type TrainingHealth = "ok" | "degraded" | "failed" | "idle";

export interface TrainingJobStatus {
  id: string;
  enabled: boolean;
  health: TrainingHealth;
  lastOutcome: string | null;
  errorReason: string | null;
  trainedAt: string | null;
  /** `null` means not recorded (a pre-upgrade document), never "never attempted". */
  lastAttemptAt: string | null;
  artifactInUse: boolean;
  usingOlderArtifact: boolean;
  /** `null` means unknown: the live fingerprint could not be read. */
  isStale: boolean | null;
  issues: { subject: string; reason: string }[];
}

export interface TrainingStatus {
  trainingTime: string;
  nextScheduledTrainingAt: string | null;
  isRunning: boolean;
  /** May be `null` while `isRunning` -- the batch is still starting. */
  currentJob: string | null;
  anyFailed: boolean;
  jobs: TrainingJobStatus[];
}

/**
 * Fired after a Train now request. `status` is the payload the command
 * returned, or `null` when it returned none and the owner should poll.
 */
export const TRAINING_STATUS_CHANGED = "helman-training-status-changed";

export interface TrainingStatusChangedDetail {
  status: TrainingStatus | null;
}

/** A websocket answer that is a status payload, or `null`. */
export function asTrainingStatus(value: unknown): TrainingStatus | null {
  const candidate = value as TrainingStatus | null | undefined;
  return candidate && Array.isArray(candidate.jobs) ? candidate : null;
}

const trainingStatusStyles = css`
  :host {
    display: block;
  }

  .container {
    display: grid;
    gap: 12px;
    margin-bottom: 16px;
  }

  .status-grid {
    display: grid;
    gap: 8px;
  }

  .status-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
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
    text-align: right;
    overflow-wrap: anywhere;
  }

  .section-title {
    font-weight: 600;
    font-size: 0.95rem;
    color: var(--primary-text-color);
    border-bottom: 1px solid var(--divider-color);
    padding-bottom: 8px;
  }

  .badge {
    display: inline-block;
    padding: 4px 12px;
    border-radius: 12px;
    font-size: 0.85rem;
    font-weight: 600;
  }

  .health-ok {
    background: rgba(46, 125, 50, 0.2);
    color: #2e7d32;
  }

  .health-degraded {
    background: rgba(245, 127, 23, 0.2);
    color: #f57f17;
  }

  .health-failed {
    background: rgba(198, 40, 40, 0.2);
    color: #c62828;
  }

  .health-idle {
    background: rgba(33, 150, 243, 0.2);
    color: #1976d2;
  }

  .notice {
    padding: 12px;
    border-radius: 4px;
    font-size: 0.9rem;
    color: var(--primary-text-color);
  }

  .notice.warning {
    background: rgba(245, 127, 23, 0.1);
    border-left: 3px solid #f57f17;
  }

  .notice.error {
    background: rgba(198, 40, 40, 0.15);
    border-left: 6px solid #c62828;
    font-weight: 600;
  }

  .issues {
    margin: 0;
    padding-left: 20px;
    font-size: 0.9rem;
    color: var(--secondary-text-color);
  }

  .issues li {
    padding: 2px 0;
  }

  .stale {
    color: #f57f17;
    font-weight: 500;
  }

  .quiet {
    color: var(--secondary-text-color);
    font-size: 0.85rem;
  }

  .controls {
    display: flex;
    gap: 8px;
  }

  button {
    padding: 8px 16px;
    border: 1px solid var(--primary-color);
    border-radius: 6px;
    background: var(--primary-color);
    color: white;
    font-weight: 500;
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    opacity: 0.9;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
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

  .message.warning {
    background: rgba(245, 127, 23, 0.2);
    color: #b45309;
  }

  .message.error {
    background: rgba(198, 40, 40, 0.2);
    color: #c62828;
  }
`;

type MessageKind = "success" | "warning" | "error";

/** What the overview and the job panels share: localizing, dates, Train now. */
class TrainingStatusBase extends LitElement {
  @property({ attribute: false }) hass: any;
  /** The editor has a draft the backend training command cannot see. */
  @property({ type: Boolean }) disabled = false;

  @state() protected _requesting = false;
  @state() protected _message = "";
  @state() protected _messageKind: MessageKind = "success";

  static styles = trainingStatusStyles;

  /**
   * Run `job`, or the whole batch when it is omitted.
   *
   * The backend rejects a request while a run is in flight rather than
   * joining it, and reports a job it skipped as `skipped_*` -- both are
   * "did not run", never success.
   */
  protected async _trainNow(job?: string): Promise<void> {
    if (this.disabled || this._requesting || !this.hass) return;
    this._requesting = true;
    this._message = "";
    let status: TrainingStatus | null = null;
    try {
      const result = await this.hass.callWS({
        type: "helman/training/train_now",
        ...(job ? { job } : {}),
      });
      status = asTrainingStatus(result?.status);
      const outcomes = Object.entries(result?.outcomes ?? {});
      const failed = outcomes.filter(
        ([failedJob, outcome]) =>
          outcome === "training_failed" ||
          outcome === "entity_missing" ||
          status?.jobs.find((candidate) => candidate.id === failedJob)?.health === "failed",
      );
      const skipped = outcomes.filter(
        ([, outcome]) => typeof outcome === "string" && outcome.startsWith("skipped_"),
      );
      if (failed.length > 0) {
        this._setMessage(
          "error",
          failed
            .map(([failedJob, outcome]) =>
              this._tFormat("training.outcome_failed", {
                job: this._jobLabel(failedJob),
                reason: this._tValue(
                  `training.outcomes.${failedJob}.${String(outcome)}`,
                  String(outcome),
                ),
              }),
            )
            .join(" "),
        );
      } else if (skipped.length > 0) {
        this._setMessage(
          "warning",
          skipped
            .map(([skippedJob, outcome]) => this._didNotRun(skippedJob, outcome as string))
            .join(" "),
        );
      } else {
        this._setMessage("success", this._t("training.completed"));
      }
    } catch (error: any) {
      const code = typeof error?.code === "string" ? error.code : "";
      if (code === "training_in_progress" || code === "job_disabled") {
        this._setMessage("warning", this._didNotRun(job, code));
      } else {
        this._setMessage(
          "error",
          this._tFormat("training.request_failed", {
            error: error?.message || this._t("common.unknown"),
          }),
        );
      }
    } finally {
      this._requesting = false;
    }
    this.dispatchEvent(
      new CustomEvent<TrainingStatusChangedDetail>(TRAINING_STATUS_CHANGED, {
        detail: { status },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _didNotRun(job: string | undefined, reason: string): string {
    return this._tFormat("training.did_not_run", {
      job: job ? this._jobLabel(job) : this._t("training.all_jobs"),
      reason: this._tValue(`training.did_not_run_reasons.${reason}`, reason),
    });
  }

  private _setMessage(kind: MessageKind, text: string): void {
    this._messageKind = kind;
    this._message = text;
  }

  protected _renderMessage(): TemplateResult | typeof nothing {
    return this._message
      ? html`<div class="message ${this._messageKind}">${this._message}</div>`
      : nothing;
  }

  protected _renderRow(label: string, value: unknown): TemplateResult {
    return html`
      <div class="status-row">
        <span class="status-label">${label}</span>
        <span class="status-value">${value}</span>
      </div>
    `;
  }

  protected _jobLabel(job: string): string {
    return this._tValue(`training.jobs.${job}`, job);
  }

  private get _language(): string | undefined {
    return this.hass?.locale?.language ?? this.hass?.language;
  }

  protected _formatDate(value: string | null): string {
    if (!value) return this._t("common.not_available");
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(this._language);
  }

  /** The absolute time, then how long ago it was. */
  protected _formatDateWithAge(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const minutes = Math.round((date.getTime() - Date.now()) / 60000);
    const format = new Intl.RelativeTimeFormat(this._language, { numeric: "auto" });
    const age =
      Math.abs(minutes) < 60
        ? format.format(minutes, "minute")
        : Math.abs(minutes) < 48 * 60
          ? format.format(Math.round(minutes / 60), "hour")
          : format.format(Math.round(minutes / 1440), "day");
    return `${this._formatDate(value)} (${age})`;
  }

  protected _t(key: string): string {
    return getLocalizeFunction(this.hass ?? undefined)(key);
  }

  protected _tValue(key: string, fallback: string): string {
    const translated = this._t(key);
    return translated.startsWith(MISSING_TRANSLATION_PREFIX) ? fallback : translated;
  }

  protected _tFormat(key: string, values: Record<string, string | number>): string {
    let text = this._t(key);
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  }
}

/** The batch: when it runs, whether it is running now, and Train all now. */
export class HelmanTrainingStatus extends TrainingStatusBase {
  @property({ attribute: false }) status: TrainingStatus | null = null;

  render(): TemplateResult {
    const status = this.status;
    if (!status) {
      return html`<div class="container">
        <p class="quiet">${this._t("training.status_unavailable")}</p>
      </div>`;
    }
    return html`
      <div class="container">
        <div class="status-grid">
          ${this._renderRow(this._t("training.training_time"), status.trainingTime)}
          ${this._renderRow(
            this._t("training.next_training"),
            this._formatDate(status.nextScheduledTrainingAt),
          )}
          ${this._renderRow(
            this._t("training.running"),
            status.isRunning
              ? html`<span class="running-job">
                  ${status.currentJob
                    ? this._jobLabel(status.currentJob)
                    : this._t("training.starting")}
                </span>`
              : this._t("training.not_running"),
          )}
        </div>
        <div class="controls">
          <button
            type="button"
            class="train-all"
            ?disabled=${this.disabled || status.isRunning || this._requesting}
            @click=${() => this._trainNow()}
          >
            ${this._requesting ? this._t("training.training") : this._t("training.train_all_now")}
          </button>
        </div>
        ${this._renderMessage()}
      </div>
    `;
  }
}

/**
 * One `jobs[]` entry, with its own Train now. Its health sits in the panel
 * header and its issues under Diagnostics -- see the two elements below.
 */
export class HelmanTrainingJobStatus extends TrainingStatusBase {
  @property({ attribute: false }) job: TrainingJobStatus | null = null;
  /** The batch's `isRunning`: every run button waits while anything runs. */
  @property({ attribute: false }) running = false;

  render(): TemplateResult {
    const job = this.job;
    if (!job) {
      return html`<div class="container">
        <p class="quiet">${this._t("training.status_unavailable")}</p>
      </div>`;
    }
    const outcome = job.lastOutcome
      ? this._tValue(`training.outcomes.${job.id}.${job.lastOutcome}`, job.lastOutcome)
      : "";
    const lastAttempt = [
      job.lastAttemptAt
        ? this._formatDateWithAge(job.lastAttemptAt)
        : this._t("training.not_recorded"),
      ...(outcome ? [outcome] : []),
    ].join(" · ");
    return html`
      <div class="container">
        ${job.usingOlderArtifact
          ? html`<div class="notice warning">${this._t("training.using_older_artifact")}</div>`
          : job.health === "failed" && !job.artifactInUse
            ? html`<div class="notice error">${this._t("training.failed_nothing_served")}</div>`
            : nothing}
        <div class="status-grid">
          ${job.artifactInUse
            ? html`<div class="result-in-use">
                ${this._renderRow(
                  this._t("training.result_in_use"),
                  job.trainedAt ? this._formatDateWithAge(job.trainedAt) : this._t("common.not_available"),
                )}
              </div>`
            : nothing}
          <div class="last-attempt">
            ${this._renderRow(
              this._t("training.last_attempt"),
              lastAttempt,
            )}
          </div>
          ${job.errorReason
            ? html`<div class="error-reason">
                ${this._renderRow(this._t("training.reason"), job.errorReason)}
              </div>`
            : nothing}
          ${job.isStale === true
            ? html`<div class="stale">${this._t("training.stale")}</div>`
            : job.isStale === null
              ? html`<div class="quiet staleness-unknown">${this._t("training.staleness_unknown")}</div>`
              : nothing}
        </div>
        <div class="controls">
          <button
            type="button"
            class="train-job"
            ?disabled=${this.disabled || this.running || this._requesting}
            @click=${() => this._trainNow(job.id)}
          >
            ${this._requesting ? this._t("training.training") : this._t("training.train_now")}
          </button>
        </div>
        ${this._renderMessage()}
      </div>
    `;
  }
}

/** A job's health chip, for the editor to place in its panel header. */
export class HelmanTrainingHealthBadge extends TrainingStatusBase {
  @property({ attribute: false }) job: TrainingJobStatus | null = null;

  render(): TemplateResult | typeof nothing {
    const job = this.job;
    if (!job) return nothing;
    const health = [
      this._tValue(`training.health.${job.health}`, job.health),
      ...(job.enabled ? [] : [this._t("training.disabled")]),
    ].join(" · ");
    return html`<span class="badge health-${job.health}">${health}</span>`;
  }
}

/** A job's issues from its last attempt, or nothing when it had none. */
export class HelmanTrainingIssues extends TrainingStatusBase {
  @property({ attribute: false }) job: TrainingJobStatus | null = null;

  render(): TemplateResult | typeof nothing {
    const issues = this.job?.issues ?? [];
    if (issues.length === 0) return nothing;
    return html`
      <div class="container">
        <div class="section-title">${this._t("training.issues")}</div>
        <ul class="issues">
          ${issues.map(
            (issue) => html`<li><strong>${issue.subject}</strong>: ${issue.reason}</li>`,
          )}
        </ul>
      </div>
    `;
  }
}

/**
 * The figures only the solar bias payload has.
 *
 * Headed neutrally, not "result in use": under `insufficient_history` the raw
 * forecast is what is served and these describe the latest attempt. The
 * attempt's dropped days already arrive as the job's `issues`, so they are not
 * repeated here.
 */
export class HelmanSolarBiasDiagnostics extends TrainingStatusBase {
  /**
   * The solar job's entry; a new attempt or result refetches the figures, and
   * so does a config save or toggle, which changes the effective variant and
   * fallback reason without any attempt.
   */
  @property({ attribute: false }) job: TrainingJobStatus | null = null;
  /** Canonical saved-config revision; diagnostics are computed from that config. */
  @property({ attribute: false }) configRevision: string | null = null;

  @state() private _diagnostics: any = null;
  private _loadedFor: string | null = null;
  private _loadingFor: string | null = null;

  protected updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    const job = this.job;
    const key = [
      job?.trainedAt,
      job?.lastAttemptAt,
      job?.enabled,
      job?.isStale,
      job?.artifactInUse,
      this.configRevision,
    ].join("|");
    if (
      this.hass &&
      this.configRevision !== null &&
      key !== this._loadedFor &&
      key !== this._loadingFor
    ) {
      this._loadingFor = key;
      void this._load(key);
    }
  }

  private async _load(key: string): Promise<void> {
    try {
      const diagnostics = await this.hass.callWS({ type: "helman/solar_bias/status" });
      if (this._loadingFor === key) {
        this._diagnostics = diagnostics;
        this._loadedFor = key;
      }
    } catch {
      // Diagnostics are secondary to the shared status above; keep the last.
    } finally {
      if (this._loadingFor === key) this._loadingFor = null;
    }
  }

  render(): TemplateResult | typeof nothing {
    const diagnostics = this._diagnostics;
    if (!diagnostics || typeof diagnostics !== "object") return nothing;
    const factors = diagnostics.factorSummary ?? {};
    const hasFactors = [factors.min, factors.median, factors.max].every(
      (value) => typeof value === "number",
    );
    return html`
      <div class="container">
        <div class="section-title">${this._t("training.diagnostics.title")}</div>
        <div class="status-grid">
          ${this._renderRow(
            this._t("bias_correction.status_panel.training_days_used"),
            this._tFormat("bias_correction.status_panel.training_days_required", {
              used: diagnostics.usableDays ?? 0,
              required: diagnostics.minHistoryDays ?? 0,
            }),
          )}
          ${this._renderRow(this._t("training.diagnostics.omitted_slots"), diagnostics.omittedSlotCount ?? 0)}
          ${this._renderRow(
            this._t("bias_correction.status_panel.invalidated_training_slots"),
            diagnostics.invalidatedSlotCount ?? 0,
          )}
          ${hasFactors
            ? this._renderRow(
                this._t("training.diagnostics.factor_summary"),
                this._tFormat("training.diagnostics.factor_summary_value", {
                  min: factors.min.toFixed(2),
                  median: factors.median.toFixed(2),
                  max: factors.max.toFixed(2),
                }),
              )
            : nothing}
          ${this._renderRow(
            this._t("bias_correction.status_panel.effective_variant"),
            this._tValue(
              `bias_correction.effective_variants.${diagnostics.effectiveVariant}`,
              String(diagnostics.effectiveVariant ?? ""),
            ),
          )}
          ${diagnostics.fallbackReason
            ? this._renderRow(
                this._t("training.diagnostics.fallback_reason"),
                this._tValue(
                  `bias_correction.statuses.${diagnostics.fallbackReason}`,
                  diagnostics.fallbackReason,
                ),
              )
            : nothing}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "helman-training-status": HelmanTrainingStatus;
    "helman-training-job-status": HelmanTrainingJobStatus;
    "helman-training-health-badge": HelmanTrainingHealthBadge;
    "helman-training-issues": HelmanTrainingIssues;
    "helman-solar-bias-diagnostics": HelmanSolarBiasDiagnostics;
  }
}

for (const [tag, element] of [
  ["helman-training-status", HelmanTrainingStatus],
  ["helman-training-job-status", HelmanTrainingJobStatus],
  ["helman-training-health-badge", HelmanTrainingHealthBadge],
  ["helman-training-issues", HelmanTrainingIssues],
  ["helman-solar-bias-diagnostics", HelmanSolarBiasDiagnostics],
] as const) {
  if (!customElements.get(tag)) customElements.define(tag, element);
}
