import { LitElement, css, html, nothing } from "lit";
import type { PropertyValues, TemplateResult } from "lit";
import { cache } from "lit/directives/cache.js";

import {
  appendListItem,
  asJsonArray,
  asJsonObject,
  cloneJson,
  createApplianceDraft,
  createClimateApplianceDraft,
  createExportPriceOptimizerDraft,
  createGenericApplianceDraft,
  createCategoryKey,
  createDailyEnergyEntityDraft,
  createDeferrableConsumerDraft,
  createEcoGearEntry,
  createGearKey,
  createImportPriceWindowDraft,
  createLabelKey,
  createModeKey,
  type RenameObjectKeyResult,
  createSurplusApplianceOptimizerDraft,
  createUseModeEntry,
  createVehicleDraft,
  getValueAtPath,
  moveListItem,
  objectEntries,
  removeListItem,
  renameObjectKey,
  setValueAtPath,
  unsetValueAtPath,
} from "./config-document";
import {
  buildSurplusApplianceSelectionState,
  buildSurplusClimateModeFieldState,
  type SurplusApplianceOption,
  type SurplusApplianceSelectionState,
  type SurplusClimateModeFieldState,
} from "./surplus-appliance-ui";
import {
  DOCUMENT_SCOPE_ID,
  SECTION_ICONS,
  SECTION_SCOPE_IDS,
  TAB_ICONS,
  TAB_SCOPE_IDS,
  TAB_SECTIONS,
  TABS,
  type EditorMode,
  getDescendantScopeIds,
  getScope,
  type ScopeId,
  type TabId,
} from "./config-editor-scopes";
import { getLocalizeFunction, type LocalizeFunction } from "./localize/localize";
import { loadHaForm, loadHaYamlEditor } from "./load-ha-elements";
import type {
  HomeAssistantLike,
  JsonObject,
  JsonValue,
  PathSegment,
  ApplianceMetadataResponse,
  SaveConfigResponse,
  StatusMessage,
  ValidationIssue,
  ValidationReport,
} from "./types";
import type { ScopeAdapterValidationError } from "./config-scope-adapters";
import { normalizeYamlValue } from "./yaml-codec";

const USE_MODE_BEHAVIORS = [
  { value: "fixed_max_power", labelKey: "editor.values.fixed_max_power" },
  { value: "surplus_aware", labelKey: "editor.values.surplus_aware" },
];

const GENERIC_PROJECTION_STRATEGIES = [
  { value: "fixed", labelKey: "editor.values.fixed" },
  { value: "history_average", labelKey: "editor.values.history_average" },
];

const EXPORT_PRICE_OPTIMIZER_KIND = "export_price";
const EXPORT_PRICE_OPTIMIZER_ACTION = "stop_export";
const SURPLUS_APPLIANCE_OPTIMIZER_KIND = "surplus_appliance";
const SURPLUS_APPLIANCE_OPTIMIZER_ACTION = "on";

const APPLIANCE_ICON_SELECTOR = {
  icon: {},
} as const;

interface YamlEditorValueChangedDetail {
  value: unknown;
  isValid: boolean;
  errorMsg?: string;
}

export class HelmanConfigEditorPanel extends LitElement {
  static properties = {
    hass: { attribute: false },
    narrow: { type: Boolean },
    route: { attribute: false },
    panel: { attribute: false },
    _activeTab: { state: true },
    _config: { state: true },
    _dirty: { state: true },
    _loading: { state: true },
    _saving: { state: true },
    _validating: { state: true },
    _validation: { state: true },
    _message: { state: true },
    _hasLoadedOnce: { state: true },
    _scopeModes: { state: true },
    _scopeYamlValues: { state: true },
    _scopeYamlErrors: { state: true },
    _applianceModes: { state: true },
    _applianceYamlValues: { state: true },
    _applianceYamlErrors: { state: true },
    _liveApplianceMetadata: { state: true },
    _helpDialog: { state: true },
  };

  static styles = css`
    :host {
      display: block;
      min-height: 100%;
      background: var(--primary-background-color);
      color: var(--primary-text-color);
    }

    * {
      box-sizing: border-box;
    }

    .page {
      max-width: 1240px;
      margin: 0 auto;
      padding: 24px 20px 48px;
    }

    .header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 24px;
    }

    .title-block h1 {
      margin: 0 0 8px;
      font-size: 1.9rem;
      line-height: 1.2;
    }

    .title-block p {
      margin: 0;
      color: var(--secondary-text-color);
      max-width: 780px;
      line-height: 1.5;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      justify-content: flex-end;
    }

    .mode-toggle {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 2px;
      border: 1px solid var(--divider-color);
      border-radius: 999px;
      background: var(--card-background-color);
    }

    .mode-toggle button {
      border: none;
      background: transparent;
      color: var(--secondary-text-color);
      padding: 4px 10px;
      border-radius: 999px;
      cursor: pointer;
      font: inherit;
      font-size: 0.76rem;
      font-weight: 600;
    }

    .mode-toggle button:hover {
      background: rgba(127, 127, 127, 0.08);
    }

    .mode-toggle button.active {
      background: rgba(3, 169, 244, 0.12);
      color: var(--primary-color);
    }

    .mode-toggle button.active:hover {
      background: rgba(3, 169, 244, 0.16);
    }

    .actions button,
    .inline-actions button,
    .list-actions button,
    .add-button {
      border: 1px solid var(--divider-color);
      background: var(--card-background-color);
      color: var(--primary-text-color);
      padding: 10px 14px;
      border-radius: 999px;
      cursor: pointer;
      font: inherit;
      transition: background 0.2s ease, border-color 0.2s ease;
    }

    .actions button:hover,
    .inline-actions button:hover,
    .list-actions button:hover,
    .add-button:hover {
      background: rgba(127, 127, 127, 0.08);
    }

    .actions button.primary,
    .add-button.primary {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: var(--text-primary-color, white);
    }

    .actions button.primary:hover,
    .add-button.primary:hover {
      filter: brightness(1.03);
    }

    .actions button.danger,
    .inline-actions button.danger,
    .list-actions button.danger {
      border-color: var(--error-color);
      color: var(--error-color);
    }

    .actions button:disabled,
    .inline-actions button:disabled,
    .list-actions button:disabled,
    .add-button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .status-row {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      margin-bottom: 16px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 6px 12px;
      font-size: 0.88rem;
      border: 1px solid var(--divider-color);
      background: var(--card-background-color);
    }

    .badge.info {
      color: var(--secondary-text-color);
    }

    .message {
      border: 1px solid var(--divider-color);
      border-radius: 16px;
      padding: 14px 16px;
      margin-bottom: 16px;
      background: var(--card-background-color);
    }

    .message.success {
      border-color: #2e7d32;
      background: rgba(46, 125, 50, 0.08);
    }

    .message.error {
      border-color: var(--error-color);
      background: rgba(244, 67, 54, 0.08);
    }

    .message.info {
      border-color: var(--primary-color);
      background: rgba(3, 169, 244, 0.08);
    }

    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 20px;
    }

    .tabs button {
      border: 1px solid var(--divider-color);
      background: var(--card-background-color);
      color: var(--primary-text-color);
      border-radius: 999px;
      padding: 10px 16px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font: inherit;
    }

    .tabs button.active {
      border-color: var(--primary-color);
      color: var(--primary-color);
      background: rgba(3, 169, 244, 0.08);
    }

    .tab-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 22px;
      height: 22px;
      border-radius: 999px;
      padding: 0 6px;
      font-size: 0.78rem;
      background: rgba(127, 127, 127, 0.18);
      color: inherit;
    }

    .tab-count.errors {
      background: rgba(244, 67, 54, 0.12);
      color: var(--error-color);
    }

    .tab-count.warnings {
      background: rgba(255, 152, 0, 0.12);
      color: #ef6c00;
    }

    .issue-board {
      display: grid;
      gap: 14px;
      margin-bottom: 20px;
    }

    .issue-group {
      border: 1px solid var(--divider-color);
      border-radius: 16px;
      padding: 16px;
      background: var(--card-background-color);
    }

    .issue-group h3 {
      margin: 0 0 10px;
      font-size: 1rem;
    }

    .issue-group ul {
      margin: 0;
      padding-left: 18px;
      display: grid;
      gap: 8px;
    }

    .issue-path {
      font-family: var(--code-font-family, monospace);
      font-size: 0.9rem;
    }

    .tab-body {
      display: grid;
      gap: 16px;
    }

    .tab-scope {
      display: grid;
      gap: 16px;
    }

    .scope-toolbar {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 12px;
    }

    details.section-card,
    .list-card,
    .nested-card {
      border: 1px solid var(--divider-color);
      border-radius: 18px;
      background: var(--card-background-color);
    }

    details.section-card {
      padding: 0 18px 18px;
    }

    details.section-card > summary {
      list-style: none;
      cursor: pointer;
      padding: 14px 0;
      font-size: 1.06rem;
      font-weight: 700;
      border-bottom: 1px solid transparent;
      transition: border-color 0.15s ease;
      user-select: none;
    }

    details.section-card[open] > summary {
      border-bottom-color: var(--divider-color);
      margin-bottom: 14px;
    }

    .section-summary-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .section-summary-left {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .section-icon {
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      fill: var(--primary-color);
      opacity: 0.85;
    }

    .section-summary-label {
      min-width: 0;
    }

    .section-chevron {
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      fill: var(--secondary-text-color);
      transition: transform 0.2s ease;
      transform: rotate(0deg);
    }

    details.section-card[open] > summary .section-chevron {
      transform: rotate(90deg);
    }

    details.section-card > summary::-webkit-details-marker {
      display: none;
    }

    .section-content {
      display: grid;
      gap: 18px;
    }

    /* Collapsible appliance cards */
    details.list-card {
      padding: 0;
    }

    details.list-card > summary {
      list-style: none;
      cursor: pointer;
      padding: 14px 16px;
      border-radius: 18px;
      transition: border-radius 0.15s ease;
      user-select: none;
    }

    details.list-card[open] > summary {
      border-radius: 18px 18px 0 0;
      border-bottom: 1px solid var(--divider-color);
    }

    details.list-card > summary::-webkit-details-marker {
      display: none;
    }

    details.optimizer-card > summary {
      border: 1px solid transparent;
    }

    details.optimizer-card.optimizer-card--enabled > summary {
      background: rgba(46, 125, 50, 0.1);
      border-color: rgba(46, 125, 50, 0.28);
    }

    details.optimizer-card.optimizer-card--disabled > summary {
      background: rgba(127, 127, 127, 0.08);
      border-color: rgba(127, 127, 127, 0.22);
    }

    .appliance-summary-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .appliance-summary-left {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .appliance-chevron {
      flex-shrink: 0;
      width: 16px;
      height: 16px;
      fill: var(--secondary-text-color);
      transition: transform 0.2s ease;
      transform: rotate(0deg);
      margin-left: 4px;
    }

    details.list-card[open] > summary .appliance-chevron {
      transform: rotate(90deg);
    }

    .appliance-body {
      padding: 16px;
      display: grid;
      gap: 14px;
    }

    .tab-icon {
      flex-shrink: 0;
      width: 16px;
      height: 16px;
      fill: currentColor;
    }

    .field-grid {
      display: grid;
      gap: 16px;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    }

    .field-grid > * {
      min-width: 0;
    }

    .field-grid--roomy {
      grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr));
    }

    .field {
      display: grid;
      gap: 8px;
      align-content: start;
      min-width: 0;
    }

    .toggle-field {
      display: block;
    }

    .toggle-field ha-formfield {
      display: block;
      width: 100%;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid var(--divider-color);
      background: var(--secondary-background-color);
      color: var(--primary-text-color);
    }

    .field label {
      font-weight: 600;
      font-size: 0.93rem;
    }

    .field input,
    .field select,
    .field textarea {
      width: 100%;
      border-radius: 12px;
      border: 1px solid var(--divider-color);
      background: var(--secondary-background-color);
      color: var(--primary-text-color);
      padding: 12px 14px;
      font: inherit;
    }

    .field textarea {
      min-height: 120px;
      resize: vertical;
    }

    .yaml-surface {
      display: grid;
      gap: 12px;
    }

    .yaml-field ha-yaml-editor {
      display: block;
      --code-mirror-height: clamp(320px, 58vh, 720px);
      --code-mirror-max-height: clamp(320px, 58vh, 720px);
    }

    .yaml-field--document ha-yaml-editor {
      --code-mirror-height: clamp(420px, 72vh, 980px);
      --code-mirror-max-height: clamp(420px, 72vh, 980px);
    }

    .yaml-error {
      margin: 0;
    }

    .field ha-entity-picker,
    .field ha-selector {
      display: block;
      width: 100%;
      min-width: 0;
      max-width: 100%;
    }

    .helper {
      color: var(--secondary-text-color);
      font-size: 0.86rem;
      line-height: 1.4;
    }

    .list-stack {
      display: grid;
      gap: 14px;
    }

    .list-card,
    .nested-card {
      padding: 16px;
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      margin-bottom: 14px;
    }

    .card-title {
      display: grid;
      gap: 4px;
    }

    .card-title strong {
      font-size: 1rem;
    }

    .card-subtitle {
      color: var(--secondary-text-color);
      font-size: 0.88rem;
    }

    .inline-actions,
    .list-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    .summary-toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid var(--divider-color);
      background: var(--card-background-color);
      color: var(--primary-text-color);
      font-size: 0.82rem;
      font-weight: 600;
      white-space: nowrap;
    }

    .summary-toggle ha-switch {
      --mdc-theme-secondary: var(--primary-color);
    }

    .inline-note {
      color: var(--secondary-text-color);
      font-size: 0.9rem;
    }

    pre.raw-preview {
      margin: 0;
      padding: 14px;
      border-radius: 14px;
      background: var(--secondary-background-color);
      overflow: auto;
      white-space: pre-wrap;
      font-size: 0.84rem;
      line-height: 1.45;
    }

    .section-footer {
      display: flex;
      justify-content: flex-start;
      margin-top: 4px;
    }

    @media (max-width: 900px) {
      .header {
        flex-direction: column;
      }

      .actions,
      .scope-toolbar {
        justify-content: flex-start;
      }
    }

    .field-label-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .field-label-row label {
      flex: 1;
      min-width: 0;
    }

    .help-btn {
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 1px solid var(--secondary-text-color);
      background: transparent;
      color: var(--secondary-text-color);
      cursor: pointer;
      font: inherit;
      font-size: 0.72rem;
      font-weight: 700;
      line-height: 1;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .help-btn:hover {
      border-color: var(--primary-color);
      color: var(--primary-color);
      background: rgba(3, 169, 244, 0.08);
    }

    .help-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .help-dialog {
      background: var(--card-background-color);
      border-radius: 18px;
      padding: 22px 24px;
      max-width: 480px;
      width: 100%;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.24);
    }

    .help-dialog-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 14px;
    }

    .help-dialog-header strong {
      font-size: 1.05rem;
      line-height: 1.3;
    }

    .help-dialog-close {
      flex-shrink: 0;
      border: 1px solid var(--divider-color);
      background: var(--card-background-color);
      color: var(--primary-text-color);
      width: 28px;
      height: 28px;
      border-radius: 50%;
      cursor: pointer;
      font: inherit;
      font-size: 0.9rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }

    .help-dialog-close:hover {
      background: rgba(127, 127, 127, 0.08);
    }

    .help-dialog-body {
      color: var(--secondary-text-color);
      line-height: 1.55;
      margin: 0;
      font-size: 0.93rem;
    }
  `;

  declare narrow?: boolean;
  declare route?: unknown;
  declare panel?: unknown;

  private _hass?: HomeAssistantLike;
  private _localize?: LocalizeFunction;
  private readonly _fallbackLocalize = getLocalizeFunction();
  private _activeTab: TabId = "general";
  private _config: JsonObject | null = null;
  private _dirty = false;
  private _loading = false;
  private _saving = false;
  private _validating = false;
  private _validation: ValidationReport | null = null;
  private _message: StatusMessage | null = null;
  private _hasLoadedOnce = false;
  private _scopeModes: Partial<Record<ScopeId, EditorMode>> = {};
  private _scopeYamlValues: Partial<Record<ScopeId, JsonValue>> = {};
  private _scopeYamlErrors: Partial<Record<ScopeId, string>> = {};
  private _applianceModes: Partial<Record<number, EditorMode>> = {};
  private _applianceYamlValues: Partial<Record<number, JsonValue>> = {};
  private _applianceYamlErrors: Partial<Record<number, string>> = {};
  private _liveApplianceMetadata: ApplianceMetadataResponse | null = null;
  private _helpDialog: { labelKey: string; contentKey: string } | null = null;

  get hass(): HomeAssistantLike | undefined {
    return this._hass;
  }

  set hass(hass: HomeAssistantLike | undefined) {
    const oldValue = this._hass;
    this._hass = hass;
    if (hass && !this._localize) {
      this._localize = getLocalizeFunction(hass);
    }
    this.requestUpdate("hass", oldValue);
  }

  connectedCallback(): void {
    super.connectedCallback();
    void loadHaForm()
      .then(() => {
        this.requestUpdate();
      })
      .catch((error) => {
        this._message = {
          kind: "error",
          text: this._formatError(
            error,
            this._t("editor.messages.load_ha_form_failed"),
          ),
        };
      });
  }

  protected updated(changedProperties: PropertyValues<this>): void {
    super.updated(changedProperties);
    if (!this._hasLoadedOnce && this.hass) {
      this._hasLoadedOnce = true;
      void this._loadConfig({ showMessage: false });
    }
  }

  render(): TemplateResult {
    const issueCounts = this._buildTabIssueCounts();
    const hasBlockingYamlErrors = this._hasBlockingYamlErrors();

    return html`
      <div class="page">
        <div class="header">
          <div class="title-block">
            <h1>${this._t("editor.title")}</h1>
            <p>
              ${this._t("editor.description")}
            </p>
          </div>
          <div class="actions">
            ${this._renderModeToggle(DOCUMENT_SCOPE_ID)}
            <button
              type="button"
              ?disabled=${this._loading || this._saving || this._validating}
              @click=${this._handleReloadClick}
            >
              ${this._t("editor.actions.reload_config")}
            </button>
            <button
              type="button"
              ?disabled=${
                this._loading ||
                this._saving ||
                this._validating ||
                !this._config ||
                hasBlockingYamlErrors
              }
              @click=${this._handleValidateClick}
            >
              ${this._validating
                ? this._t("editor.actions.validating")
                : this._t("editor.actions.validate")}
            </button>
            <button
              type="button"
              class="primary"
              ?disabled=${
                this._loading ||
                this._saving ||
                this._validating ||
                !this._config ||
                hasBlockingYamlErrors
              }
              @click=${this._handleSaveClick}
            >
              ${this._saving
                ? this._t("editor.actions.saving")
                : this._t("editor.actions.save_and_reload")}
            </button>
          </div>
        </div>

        <div class="status-row">
          ${this._loading
            ? html`<span class="badge info">${this._t("editor.status.loading_config")}</span>`
            : nothing}
          ${this._dirty
            ? html`<span class="badge info">${this._t("editor.status.unsaved_changes")}</span>`
            : html`<span class="badge info">${this._t("editor.status.stored_config_loaded")}</span>`}
          ${!this._dirty && this._validation?.valid
            ? html`<span class="badge info">${this._t("editor.status.last_validation_passed")}</span>`
            : nothing}
          ${this._dirty
            ? html`<span class="badge info">${this._t("editor.status.validation_stale")}</span>`
            : nothing}
          ${hasBlockingYamlErrors
            ? html`<span class="badge info">${this._t("editor.status.fix_yaml_errors")}</span>`
            : nothing}
        </div>

        ${this._message
          ? html`<div class="message ${this._message.kind}">${this._message.text}</div>`
          : nothing}

        ${this._renderIssueBoard()}

        ${this._config ? this._renderDocumentBody(issueCounts) : nothing}
      </div>
      ${this._renderHelpDialog()}
    `;
  }

  private _renderDocumentBody(
    issueCounts: Record<TabId, { errors: number; warnings: number }>,
  ): TemplateResult {
    if (this._isScopeYaml(DOCUMENT_SCOPE_ID)) {
      return html`<div class="list-card">${this._renderYamlEditor(DOCUMENT_SCOPE_ID)}</div>`;
    }

    return html`
      <div class="tabs">
        ${TABS.map((tab) => {
          const counts = issueCounts[tab.id];
          return html`
            <button
              type="button"
              class=${this._activeTab === tab.id ? "active" : ""}
              @click=${() => {
                this._activeTab = tab.id;
              }}
            >
              ${this._renderSvgIcon(TAB_ICONS[tab.id], "tab-icon")}
              <span>${this._t(tab.labelKey)}</span>
              ${counts.errors > 0
                ? html`<span class="tab-count errors">${counts.errors}</span>`
                : counts.warnings > 0
                  ? html`<span class="tab-count warnings">${counts.warnings}</span>`
                  : nothing}
            </button>
          `;
        })}
      </div>

      ${cache(this._renderActiveTab())}
    `;
  }

  private _renderActiveTab(): TemplateResult {
    switch (this._activeTab) {
      case "general":
        return this._renderTabScope(TAB_SCOPE_IDS.general, this._renderGeneralTab());
      case "power_devices":
        return this._renderTabScope(
          TAB_SCOPE_IDS.power_devices,
          this._renderPowerDevicesTab(),
        );
      case "scheduler":
        return this._renderTabScope(TAB_SCOPE_IDS.scheduler, this._renderSchedulerTab());
      case "automation":
        return this._renderTabScope(
          TAB_SCOPE_IDS.automation,
          this._renderAutomationTab(),
        );
      case "appliances":
        return this._renderTabScope(
          TAB_SCOPE_IDS.appliances,
          this._renderAppliancesTab(),
        );
      default:
        return html``;
    }
  }

  private _renderTabScope(scopeId: ScopeId, content: TemplateResult): TemplateResult {
    return html`
      <div class="tab-scope">
        <div class="scope-toolbar">
          ${this._renderModeToggle(scopeId)}
        </div>
        ${this._isScopeYaml(scopeId)
          ? html`<div class="list-card">${this._renderYamlEditor(scopeId)}</div>`
          : html`<div class="tab-body">${content}</div>`}
      </div>
    `;
  }

  private _renderSectionScope(
    scopeId: ScopeId,
    content: TemplateResult,
    options: { initialOpen?: boolean } = {},
  ): TemplateResult {
    const scope = getScope(scopeId);
    const { initialOpen = true } = options;
    const sectionIcon = SECTION_ICONS[scopeId];
    const chevronPath = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";

    return html`
      <details class="section-card" ?open=${initialOpen}>
        <summary>
          <div class="section-summary-row">
            <div class="section-summary-left">
              ${sectionIcon ? this._renderSvgIcon(sectionIcon, "section-icon") : nothing}
              <span class="section-summary-label">${this._t(scope.labelKey)}</span>
            </div>
            <div style="display:flex;align-items:center;gap:8px;" @click=${this._preventSummaryToggle}>
              ${this._renderModeToggle(scopeId, { inSummary: false })}
            </div>
            ${this._renderSvgIcon(chevronPath, "section-chevron")}
          </div>
        </summary>
        <div class="section-content">
          ${this._isScopeYaml(scopeId)
            ? this._renderYamlEditor(scopeId)
            : content}
        </div>
      </details>
    `;
  }

  private _renderSvgIcon(path: string, className: string): TemplateResult {
    return html`<svg class=${className} viewBox="0 0 24 24" aria-hidden="true"><path d=${path}/></svg>`;
  }

  private _renderSimpleSection(
    label: string,
    content: TemplateResult,
    options: { open?: boolean } = {},
  ): TemplateResult {
    const { open = true } = options;
    const chevronPath = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";
    return html`
      <details class="section-card" ?open=${open}>
        <summary>
          <div class="section-summary-row">
            <div class="section-summary-left">
              <span class="section-summary-label">${label}</span>
            </div>
            ${this._renderSvgIcon(chevronPath, "section-chevron")}
          </div>
        </summary>
        <div class="section-content">${content}</div>
      </details>
    `;
  }

  private _getApplianceMode(index: number): EditorMode {
    return this._applianceModes[index] ?? "visual";
  }

  private _renderApplianceModeToggle(index: number): TemplateResult {
    const mode = this._getApplianceMode(index);
    return html`
      <div class="mode-toggle">
        <button
          type="button"
          class=${mode === "visual" ? "active" : ""}
          aria-pressed=${mode === "visual"}
          @click=${(event: Event) => this._handleApplianceModeChange(index, "visual", event)}
        >
          ${this._t("editor.mode.visual")}
        </button>
        <button
          type="button"
          class=${mode === "yaml" ? "active" : ""}
          aria-pressed=${mode === "yaml"}
          @click=${(event: Event) => this._handleApplianceModeChange(index, "yaml", event)}
        >
          ${this._t("editor.mode.yaml")}
        </button>
      </div>
    `;
  }

  private _handleApplianceModeChange(index: number, mode: EditorMode, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (mode === "yaml") {
      void this._enterApplianceYamlMode(index);
    } else {
      this._exitApplianceYamlMode(index);
    }
  }

  private async _enterApplianceYamlMode(index: number): Promise<void> {
    if (this._getApplianceMode(index) === "yaml") return;
    try {
      await loadHaYamlEditor();
      if (!this._config) return;
      const value = this._getValue(["appliances", index]) as JsonValue;
      this._applianceModes = { ...this._applianceModes, [index]: "yaml" };
      this._applianceYamlValues = { ...this._applianceYamlValues, [index]: value };
      const nextErrors = { ...this._applianceYamlErrors };
      delete nextErrors[index];
      this._applianceYamlErrors = nextErrors;
      this._message = null;
    } catch (error) {
      this._message = {
        kind: "error",
        text: this._formatError(error, this._t("editor.messages.load_ha_yaml_editor_failed")),
      };
    }
  }

  private _exitApplianceYamlMode(index: number): void {
    if (this._getApplianceMode(index) !== "yaml" || this._applianceYamlErrors[index]) return;
    const nextModes = { ...this._applianceModes };
    delete nextModes[index];
    const nextValues = { ...this._applianceYamlValues };
    delete nextValues[index];
    const nextErrors = { ...this._applianceYamlErrors };
    delete nextErrors[index];
    this._applianceModes = nextModes;
    this._applianceYamlValues = nextValues;
    this._applianceYamlErrors = nextErrors;
  }

  private _handleApplianceYamlChanged(
    index: number,
    event: CustomEvent<YamlEditorValueChangedDetail>,
  ): void {
    event.stopPropagation();
    if (!event.detail.isValid) {
      this._applianceYamlErrors = {
        ...this._applianceYamlErrors,
        [index]: event.detail.errorMsg ?? this._t("editor.yaml.errors.parse_failed"),
      };
      return;
    }
    const normalizedValue = normalizeYamlValue(event.detail.value);
    if (!normalizedValue.ok) {
      this._applianceYamlErrors = {
        ...this._applianceYamlErrors,
        [index]: this._t("editor.yaml.errors.non_json_value"),
      };
      return;
    }
    if (!Array.isArray(normalizedValue.value) && typeof normalizedValue.value !== "object") {
      this._applianceYamlErrors = {
        ...this._applianceYamlErrors,
        [index]: this._t("editor.yaml.errors.non_json_value"),
      };
      return;
    }
    try {
      const nextConfig = cloneJson(this._config ?? {});
      setValueAtPath(nextConfig, ["appliances", index], cloneJson(normalizedValue.value));
      this._config = nextConfig as JsonObject;
      this._dirty = true;
      this._validation = null;
      this._message = null;
      this._applianceYamlValues = { ...this._applianceYamlValues, [index]: normalizedValue.value };
      const nextErrors = { ...this._applianceYamlErrors };
      delete nextErrors[index];
      this._applianceYamlErrors = nextErrors;
    } catch (error) {
      this._applianceYamlErrors = {
        ...this._applianceYamlErrors,
        [index]: this._formatError(error, this._t("editor.yaml.errors.apply_failed")),
      };
    }
  }

  private _renderApplianceYamlEditor(index: number): TemplateResult {
    const error = this._applianceYamlErrors[index];
    const editorId = `appliance-${index}`;
    const helperId = `${editorId}-yaml-helper`;
    const errorId = `${editorId}-yaml-error`;
    const describedBy = error ? `${helperId} ${errorId}` : helperId;
    const editorValue = this._applianceYamlValues[index] ?? this._getValue(["appliances", index]);
    return html`
      <div class="yaml-surface">
        <div class="field yaml-field">
          <label>${this._t("editor.yaml.field_label")}</label>
          <div id=${helperId} class="helper">${this._t("editor.yaml.helpers.section")}</div>
          <ha-yaml-editor
            .hass=${this.hass}
            .defaultValue=${editorValue}
            .showErrors=${false}
            aria-describedby=${describedBy}
            @value-changed=${(event: CustomEvent<YamlEditorValueChangedDetail>) =>
              this._handleApplianceYamlChanged(index, event)}
          ></ha-yaml-editor>
        </div>
        ${error ? html`<div id=${errorId} class="message error">${error}</div>` : nothing}
      </div>
    `;
  }

  private _renderModeToggle(
    scopeId: ScopeId,
    options: { inSummary?: boolean } = {},
  ): TemplateResult {
    const mode = this._getScopeMode(scopeId);

    return html`
      <div
        class="mode-toggle"
        @click=${options.inSummary ? this._preventSummaryToggle : undefined}
      >
        <button
          type="button"
          class=${mode === "visual" ? "active" : ""}
          aria-pressed=${mode === "visual"}
          @click=${(event: Event) =>
            this._handleScopeModeSelection(scopeId, "visual", event)}
        >
          ${this._t("editor.mode.visual")}
        </button>
        <button
          type="button"
          class=${mode === "yaml" ? "active" : ""}
          aria-pressed=${mode === "yaml"}
          @click=${(event: Event) =>
            this._handleScopeModeSelection(scopeId, "yaml", event)}
        >
          ${this._t("editor.mode.yaml")}
        </button>
      </div>
    `;
  }

  private _renderYamlEditor(scopeId: ScopeId): TemplateResult {
    const scope = getScope(scopeId);
    const scopeLabel = this._t(scope.labelKey);
    const helperKey =
      scope.kind === "document"
        ? "editor.yaml.helpers.document"
        : scope.kind === "tab"
          ? "editor.yaml.helpers.tab"
          : "editor.yaml.helpers.section";
    const error = this._scopeYamlErrors[scopeId];
    const scopeDomId = this._scopeDomId(scopeId);
    const helperId = `${scopeDomId}-yaml-helper`;
    const errorId = `${scopeDomId}-yaml-error`;
    const describedBy = error ? `${helperId} ${errorId}` : helperId;
    const editorValue =
      this._scopeYamlValues[scopeId] ??
      scope.adapter.read(this._config ?? ({} as JsonObject));

    return html`
      <div class="yaml-surface">
        <div
          class=${[
            "field",
            "yaml-field",
            scope.kind === "document" ? "yaml-field--document" : "",
          ]
            .filter((className) => className.length > 0)
            .join(" ")}
        >
          <label>${this._t("editor.yaml.field_label")}</label>
          <div id=${helperId} class="helper">${this._t(helperKey)}</div>
          <ha-yaml-editor
            .hass=${this.hass}
            .defaultValue=${editorValue}
            .showErrors=${false}
            aria-label=${this._tFormat("editor.yaml.aria_label", { scope: scopeLabel })}
            aria-describedby=${describedBy}
            dir="ltr"
            @value-changed=${(event: CustomEvent<YamlEditorValueChangedDetail>) =>
              this._handleYamlValueChanged(scopeId, event)}
          ></ha-yaml-editor>
        </div>
        ${error
          ? html`
              <div id=${errorId} class="message error yaml-error">
                <div>${error}</div>
                <div class="helper">${this._t("editor.yaml.errors.fix_before_leaving")}</div>
              </div>
            `
          : nothing}
      </div>
    `;
  }

  private _preventSummaryToggle = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  private _stopSummaryToggle = (event: Event): void => {
    event.stopPropagation();
  };

  private _renderGeneralTab(): TemplateResult {
    return html`
      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.general.core_labels_and_history,
        html`
          <div class="field-grid">
            ${this._renderOptionalNumberField(
              ["history_buckets"],
              "editor.fields.history_buckets",
              "editor.helpers.history_buckets",
              "editor.help.history_buckets",
            )}
            ${this._renderOptionalNumberField(
              ["history_bucket_duration"],
              "editor.fields.history_bucket_duration",
              "editor.helpers.history_bucket_duration",
              "editor.help.history_bucket_duration",
            )}
            ${this._renderOptionalTextField(["sources_title"], "editor.fields.sources_title")}
            ${this._renderOptionalTextField(["consumers_title"], "editor.fields.consumers_title")}
            ${this._renderOptionalTextField(["groups_title"], "editor.fields.groups_title")}
            ${this._renderOptionalTextField(["others_group_label"], "editor.fields.others_group_label")}
            ${this._renderOptionalTextField(
              ["power_sensor_name_cleaner_regex"],
              "editor.fields.power_sensor_name_cleaner_regex",
              "editor.helpers.power_sensor_name_cleaner_regex",
              "editor.help.power_sensor_name_cleaner_regex",
            )}
            ${this._renderBooleanField(
              ["show_empty_groups"],
              "editor.fields.show_empty_groups",
              false,
            )}
            ${this._renderBooleanField(
              ["show_others_group"],
              "editor.fields.show_others_group",
              true,
            )}
          </div>
        `,
      )}

      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.general.device_label_text,
        html`
          <p class="inline-note">
            ${this._t("editor.notes.device_label_text")}
          </p>
          <div class="list-stack">
            ${this._renderDeviceLabelCategories()}
          </div>
          <div class="section-footer">
            <button type="button" class="add-button" @click=${this._handleAddDeviceLabelCategory}>
              ${this._t("editor.actions.add_category")}
            </button>
          </div>
        `,
      )}
    `;
  }

  private _renderPowerDevicesTab(): TemplateResult {
    const dailyEnergyEntityIds =
      asJsonArray(this._getValue(["power_devices", "solar", "forecast", "daily_energy_entity_ids"])) ?? [];
    const deferrableConsumers =
      asJsonArray(
        this._getValue(["power_devices", "house", "forecast", "deferrable_consumers"]),
      ) ?? [];
    const importPriceWindows =
      asJsonArray(this._getValue(["power_devices", "grid", "forecast", "import_price_windows"])) ?? [];

    return html`
      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.power_devices.house,
        html`
          <div class="field-grid">
            ${this._renderRequiredEntityField(
              ["power_devices", "house", "entities", "power"],
              "editor.fields.house_power_entity",
              ["sensor"],
              undefined,
              undefined,
              "editor.help.house_power_entity",
            )}
            ${this._renderOptionalTextField(
              ["power_devices", "house", "power_sensor_label"],
              "editor.fields.power_sensor_label",
            )}
            ${this._renderOptionalTextField(
              ["power_devices", "house", "power_switch_label"],
              "editor.fields.power_switch_label",
            )}
            ${this._renderOptionalTextField(
              ["power_devices", "house", "unmeasured_power_title"],
              "editor.fields.unmeasured_power_title",
            )}
            ${this._renderOptionalEntityField(
              ["power_devices", "house", "forecast", "total_energy_entity_id"],
              "editor.fields.forecast_total_energy_entity",
              ["sensor"],
              undefined,
              "editor.help.house_forecast_total_energy_entity",
            )}
            ${this._renderOptionalNumberField(
              ["power_devices", "house", "forecast", "min_history_days"],
              "editor.fields.min_history_days",
              undefined,
              "editor.help.house_min_history_days",
            )}
            ${this._renderOptionalNumberField(
              ["power_devices", "house", "forecast", "training_window_days"],
              "editor.fields.training_window_days",
              undefined,
              "editor.help.house_training_window_days",
            )}
          </div>

          <div class="list-stack">
            ${deferrableConsumers.map((consumer, index) =>
              this._renderDeferrableConsumer(consumer, index, deferrableConsumers.length),
            )}
          </div>
          <div class="section-footer">
            <button type="button" class="add-button" @click=${this._handleAddDeferrableConsumer}>
              ${this._t("editor.actions.add_deferrable_consumer")}
            </button>
          </div>
        `,
        { initialOpen: false },
      )}

      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.power_devices.solar,
        html`
          <div class="field-grid field-grid--roomy">
            ${this._renderOptionalEntityField(
              ["power_devices", "solar", "entities", "power"],
              "editor.fields.power_entity",
              ["sensor"],
              undefined,
              "editor.help.solar_power_entity",
            )}
            ${this._renderOptionalEntityField(
              ["power_devices", "solar", "entities", "today_energy"],
              "editor.fields.today_energy_entity",
              ["sensor"],
              undefined,
              "editor.help.solar_today_energy_entity",
            )}
            ${this._renderOptionalEntityField(
              [
                "power_devices",
                "solar",
                "entities",
                "remaining_today_energy_forecast",
              ],
              "editor.fields.remaining_today_energy_forecast",
              ["sensor"],
              undefined,
              "editor.help.solar_remaining_today_energy_forecast",
            )}
            ${this._renderOptionalEntityField(
              ["power_devices", "solar", "forecast", "total_energy_entity_id"],
              "editor.fields.forecast_total_energy_entity",
              ["sensor"],
              undefined,
              "editor.help.solar_forecast_total_energy_entity",
            )}
          </div>

          <div class="list-stack">
            ${dailyEnergyEntityIds.map((value, index) =>
              this._renderDailyEnergyEntity(value, index, dailyEnergyEntityIds.length),
            )}
          </div>
          <div class="section-footer">
            <button type="button" class="add-button" @click=${this._handleAddDailyEnergyEntity}>
              ${this._t("editor.actions.add_daily_energy_entity")}
            </button>
          </div>
        `,
        { initialOpen: false },
      )}

      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.power_devices.battery,
        html`
          <p class="inline-note">
            ${this._t("editor.notes.battery_entities")}
          </p>
          <div class="field-grid field-grid--roomy">
            ${this._renderOptionalEntityField(
              ["power_devices", "battery", "entities", "power"],
              "editor.fields.power_entity",
              ["sensor"],
              undefined,
              "editor.help.battery_power_entity",
            )}
            ${this._renderOptionalEntityField(
              ["power_devices", "battery", "entities", "remaining_energy"],
              "editor.fields.remaining_energy_entity",
              ["sensor"],
              undefined,
              "editor.help.battery_remaining_energy_entity",
            )}
            ${this._renderOptionalEntityField(
              ["power_devices", "battery", "entities", "capacity"],
              "editor.fields.capacity_entity",
              ["sensor"],
              undefined,
              "editor.help.battery_capacity_entity",
            )}
            ${this._renderOptionalEntityField(
              ["power_devices", "battery", "entities", "min_soc"],
              "editor.fields.min_soc_entity",
              ["sensor"],
              undefined,
              "editor.help.battery_min_soc_entity",
            )}
            ${this._renderOptionalEntityField(
              ["power_devices", "battery", "entities", "max_soc"],
              "editor.fields.max_soc_entity",
              ["sensor"],
              undefined,
              "editor.help.battery_max_soc_entity",
            )}
          </div>
          <div class="field-grid">
            ${this._renderOptionalNumberField(
              ["power_devices", "battery", "forecast", "charge_efficiency"],
              "editor.fields.charge_efficiency",
              undefined,
              "editor.help.battery_charge_efficiency",
            )}
            ${this._renderOptionalNumberField(
              ["power_devices", "battery", "forecast", "discharge_efficiency"],
              "editor.fields.discharge_efficiency",
              undefined,
              "editor.help.battery_discharge_efficiency",
            )}
            ${this._renderOptionalNumberField(
              ["power_devices", "battery", "forecast", "max_charge_power_w"],
              "editor.fields.max_charge_power_w",
              undefined,
              "editor.help.battery_max_charge_power_w",
            )}
            ${this._renderOptionalNumberField(
              ["power_devices", "battery", "forecast", "max_discharge_power_w"],
              "editor.fields.max_discharge_power_w",
              undefined,
              "editor.help.battery_max_discharge_power_w",
            )}
          </div>
        `,
        { initialOpen: false },
      )}

      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.power_devices.grid,
        html`
          <div class="field-grid">
            ${this._renderOptionalEntityField(
              ["power_devices", "grid", "entities", "power"],
              "editor.fields.power_entity",
              ["sensor"],
              undefined,
              "editor.help.grid_power_entity",
            )}
            ${this._renderOptionalEntityField(
              ["power_devices", "grid", "forecast", "sell_price_entity_id"],
              "editor.fields.sell_price_entity",
              ["sensor"],
              undefined,
              "editor.help.grid_sell_price_entity",
            )}
            ${this._renderOptionalTextField(
              ["power_devices", "grid", "forecast", "import_price_unit"],
              "editor.fields.import_price_unit",
              "editor.helpers.import_price_unit",
              "editor.help.grid_import_price_unit",
            )}
          </div>

          <p class="inline-note">
            ${this._t("editor.notes.grid_import_windows")}
          </p>
          <div class="list-stack">
            ${importPriceWindows.map((windowConfig, index) =>
              this._renderImportPriceWindow(windowConfig, index, importPriceWindows.length),
            )}
          </div>
          <div class="section-footer">
            <button type="button" class="add-button" @click=${this._handleAddImportPriceWindow}>
              ${this._t("editor.actions.add_import_price_window")}
            </button>
          </div>
        `,
        { initialOpen: false },
      )}
    `;
  }

  private _renderSchedulerTab(): TemplateResult {
    return html`
      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.scheduler.schedule_control_mapping,
        html`
          <div class="field-grid">
            ${this._renderRequiredEntityField(
              ["scheduler", "control", "mode_entity_id"],
              "editor.fields.mode_entity",
              ["input_select", "select"],
              "editor.helpers.mode_entity",
              undefined,
              "editor.help.scheduler_mode_entity",
            )}
            ${this._renderOptionalTextField(
              ["scheduler", "control", "action_option_map", "normal"],
              "editor.fields.normal_option",
              undefined,
              "editor.help.scheduler_action_option",
            )}
            ${this._renderOptionalTextField(
              ["scheduler", "control", "action_option_map", "charge_to_target_soc"],
              "editor.fields.charge_to_target_soc_option",
              undefined,
              "editor.help.scheduler_action_option",
            )}
            ${this._renderOptionalTextField(
              ["scheduler", "control", "action_option_map", "discharge_to_target_soc"],
              "editor.fields.discharge_to_target_soc_option",
              undefined,
              "editor.help.scheduler_action_option",
            )}
            ${this._renderOptionalTextField(
              ["scheduler", "control", "action_option_map", "stop_charging"],
              "editor.fields.stop_charging_option",
              undefined,
              "editor.help.scheduler_action_option",
            )}
            ${this._renderOptionalTextField(
              ["scheduler", "control", "action_option_map", "stop_discharging"],
              "editor.fields.stop_discharging_option",
              undefined,
              "editor.help.scheduler_action_option",
            )}
            ${this._renderOptionalTextField(
              ["scheduler", "control", "action_option_map", "stop_export"],
              "editor.fields.stop_export_option",
              undefined,
              "editor.help.scheduler_action_option",
            )}
          </div>
        `,
      )}
    `;
  }

  private _renderAutomationTab(): TemplateResult {
    const optimizers = asJsonArray(this._getValue(["automation", "optimizers"])) ?? [];

    return html`
      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.automation.settings,
        html`
          <p class="inline-note">
            ${this._t("editor.notes.automation")}
          </p>
          <div class="field-grid">
            ${this._renderAutomationEnabledField()}
          </div>
        `,
      )}

      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.automation.optimizer_pipeline,
        html`
          <p class="inline-note">
            ${this._t("editor.notes.optimizer_pipeline")}
          </p>
          <div class="list-stack">
            ${optimizers.map((optimizer, index) =>
              this._renderAutomationOptimizerCard(optimizer, index, optimizers.length),
            )}
          </div>
          ${optimizers.length === 0
            ? html`
                <div class="message info">
                  ${this._t("editor.empty.no_automation_optimizers")}
                </div>
              `
            : nothing}
          <div class="section-footer">
            <button type="button" class="add-button" @click=${this._handleAddExportPriceOptimizer}>
              ${this._t("editor.actions.add_export_price_optimizer")}
            </button>
            <button
              type="button"
              class="add-button"
              @click=${this._handleAddSurplusApplianceOptimizer}
            >
              ${this._t("editor.actions.add_surplus_appliance_optimizer")}
            </button>
          </div>
        `,
      )}
    `;
  }

  private _renderAutomationOptimizerCard(
    optimizer: unknown,
    index: number,
    total: number,
  ): TemplateResult {
    const optimizerObject = asJsonObject(optimizer) ?? {};
    const kind = this._stringValue(optimizerObject.kind);
    if (kind === EXPORT_PRICE_OPTIMIZER_KIND) {
      return this._renderExportPriceOptimizerCard(optimizerObject, index, total);
    }
    if (kind === SURPLUS_APPLIANCE_OPTIMIZER_KIND) {
      return this._renderSurplusApplianceOptimizerCard(optimizerObject, index, total);
    }
    return this._renderUnsupportedAutomationOptimizerCard(optimizerObject, index, total);
  }

  private _renderAutomationEnabledField(): TemplateResult {
    const checked = this._getAutomationEnabled();

    return html`
      <div class="field toggle-field">
        <ha-formfield .label=${this._t("editor.fields.automation_enabled")}>
          <ha-switch
            .checked=${checked}
            @change=${(event: Event) =>
              this._setAutomationEnabled(
                (event.currentTarget as HTMLElement & { checked: boolean }).checked,
              )}
          ></ha-switch>
        </ha-formfield>
        <div class="helper">${this._t("editor.helpers.automation_enabled")}</div>
      </div>
    `;
  }

  private _renderExportPriceOptimizerCard(
    optimizer: JsonObject,
    index: number,
    total: number,
  ): TemplateResult {
    const basePath: PathSegment[] = ["automation", "optimizers", index];
    const paramsPath: PathSegment[] = [...basePath, "params"];
    const enabled = this._booleanValue(this._getValue([...basePath, "enabled"]), true);
    const optimizerId =
      this._stringValue(optimizer.id) ||
      this._tFormat("editor.dynamic.optimizer", { index: index + 1 });
    const chevronPath = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";
    const action =
      this._stringValue(this._getValue([...paramsPath, "action"])) ||
      EXPORT_PRICE_OPTIMIZER_ACTION;
    const thresholdValue = this._getValue([...paramsPath, "when_price_below"]) ?? 0;

    return html`
      <details class=${`list-card optimizer-card optimizer-card--${enabled ? "enabled" : "disabled"}`}>
        <summary>
          <div class="appliance-summary-row">
            <div class="appliance-summary-left">
              ${this._renderSvgIcon(chevronPath, "appliance-chevron")}
              <div class="card-title">
                <strong>${optimizerId}</strong>
                <span class="card-subtitle">${this._t("editor.values.export_price")}</span>
              </div>
            </div>
            <div class="list-actions" @click=${this._preventSummaryToggle}>
              ${this._renderOptimizerEnabledToggle([...basePath, "enabled"], enabled)}
              <button
                type="button"
                ?disabled=${index === 0}
                @click=${() => this._moveListItem(["automation", "optimizers"], index, index - 1)}
              >${this._t("editor.actions.up")}</button>
              <button
                type="button"
                ?disabled=${index === total - 1}
                @click=${() => this._moveListItem(["automation", "optimizers"], index, index + 1)}
              >${this._t("editor.actions.down")}</button>
              <button
                type="button"
                class="danger"
                @click=${() => this._removeListItem(["automation", "optimizers"], index)}
              >${this._t("editor.actions.remove")}</button>
            </div>
          </div>
        </summary>
        <div class="appliance-body">
          <div class="field-grid">
            ${this._renderRequiredTextField(
              [...basePath, "id"],
              "editor.fields.optimizer_id",
              undefined,
              "editor.help.automation_optimizer_id",
            )}
            <div class="field">
              <label>${this._t("editor.fields.kind")}</label>
              <input .value=${EXPORT_PRICE_OPTIMIZER_KIND} disabled />
            </div>
            ${this._renderRequiredNumberField(
              [...paramsPath, "when_price_below"],
              "editor.fields.when_price_below",
              thresholdValue,
              "any",
              "editor.help.export_price_when_price_below",
            )}
            <div class="field">
              <div class="field-label-row">
                <label>${this._t("editor.fields.optimizer_action")}</label>
                ${this._renderHelpIcon(
                  "editor.fields.optimizer_action",
                  "editor.help.export_price_action",
                )}
              </div>
              <input .value=${action} disabled />
              <div class="helper">${this._t("editor.helpers.export_price_action")}</div>
            </div>
          </div>
        </div>
      </details>
    `;
  }

  private _renderSurplusApplianceOptimizerCard(
    optimizer: JsonObject,
    index: number,
    total: number,
  ): TemplateResult {
    const basePath: PathSegment[] = ["automation", "optimizers", index];
    const paramsPath: PathSegment[] = [...basePath, "params"];
    const enabled = this._booleanValue(this._getValue([...basePath, "enabled"]), true);
    const optimizerId =
      this._stringValue(optimizer.id) ||
      this._tFormat("editor.dynamic.optimizer", { index: index + 1 });
    const chevronPath = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";
    const applianceId = this._stringValue(this._getValue([...paramsPath, "appliance_id"]));
    const action =
      this._stringValue(this._getValue([...paramsPath, "action"])) ||
      SURPLUS_APPLIANCE_OPTIMIZER_ACTION;
    const minSurplusBufferPct = this._getValue([...paramsPath, "min_surplus_buffer_pct"]) ?? 5;
    const selectionState = buildSurplusApplianceSelectionState(
      this._config,
      this._liveApplianceMetadata,
      applianceId,
    );
    const climateModeFieldState = buildSurplusClimateModeFieldState(
      selectionState,
      this._stringValue(this._getValue([...paramsPath, "climate_mode"])),
    );

    return html`
      <details class=${`list-card optimizer-card optimizer-card--${enabled ? "enabled" : "disabled"}`}>
        <summary>
          <div class="appliance-summary-row">
            <div class="appliance-summary-left">
              ${this._renderSvgIcon(chevronPath, "appliance-chevron")}
              <div class="card-title">
                <strong>${optimizerId}</strong>
                <span class="card-subtitle">${this._t("editor.values.surplus_appliance")}</span>
              </div>
            </div>
            <div class="list-actions" @click=${this._preventSummaryToggle}>
              ${this._renderOptimizerEnabledToggle([...basePath, "enabled"], enabled)}
              <button
                type="button"
                ?disabled=${index === 0}
                @click=${() => this._moveListItem(["automation", "optimizers"], index, index - 1)}
              >${this._t("editor.actions.up")}</button>
              <button
                type="button"
                ?disabled=${index === total - 1}
                @click=${() => this._moveListItem(["automation", "optimizers"], index, index + 1)}
              >${this._t("editor.actions.down")}</button>
              <button
                type="button"
                class="danger"
                @click=${() => this._removeListItem(["automation", "optimizers"], index)}
              >${this._t("editor.actions.remove")}</button>
            </div>
          </div>
        </summary>
        <div class="appliance-body">
          <div class="field-grid">
            ${this._renderRequiredTextField(
              [...basePath, "id"],
              "editor.fields.optimizer_id",
              undefined,
              "editor.help.automation_optimizer_id",
            )}
            <div class="field">
              <label>${this._t("editor.fields.kind")}</label>
              <input .value=${SURPLUS_APPLIANCE_OPTIMIZER_KIND} disabled />
            </div>
            <div class="field">
              <div class="field-label-row">
                <label>${this._t("editor.fields.appliance_id")}</label>
                ${this._renderHelpIcon("editor.fields.appliance_id", "editor.help.surplus_appliance_id")}
              </div>
              <select
                .value=${selectionState.selectedId}
                @change=${(event: Event) =>
                  this._handleSurplusApplianceIdChange(
                    index,
                    (event.currentTarget as HTMLSelectElement).value,
                  )}
              >
                <option value="">${this._t("editor.values.select_appliance")}</option>
                ${selectionState.selectedMissingFromDraft && selectionState.selectedId.length > 0
                  ? html`
                      <option value=${selectionState.selectedId}>
                        ${this._tFormat("editor.dynamic.stale_appliance", {
                          id: selectionState.selectedId,
                        })}
                      </option>
                    `
                  : nothing}
                ${selectionState.options.map(
                  (option) => html`
                    <option value=${option.id} ?disabled=${option.selectionDisabled}>
                      ${this._formatSurplusApplianceOptionLabel(option)}
                    </option>
                  `,
                )}
              </select>
              <div class="helper">
                ${this._renderSurplusApplianceIdHelper(selectionState)}
              </div>
            </div>
            ${this._renderRequiredNumberField(
              [...paramsPath, "min_surplus_buffer_pct"],
              "editor.fields.min_surplus_buffer_pct",
              minSurplusBufferPct,
              "1",
              "editor.help.surplus_appliance_min_surplus_buffer_pct",
            )}
            ${climateModeFieldState.visible
              ? this._renderSurplusClimateModeField(paramsPath, climateModeFieldState)
              : this._renderSurplusApplianceActionField(action)}
          </div>
        </div>
      </details>
    `;
  }

  private _renderUnsupportedAutomationOptimizerCard(
    optimizer: JsonObject,
    index: number,
    total: number,
  ): TemplateResult {
    const basePath: PathSegment[] = ["automation", "optimizers", index];
    const enabled = this._booleanValue(this._getValue([...basePath, "enabled"]), true);
    const chevronPath = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";
    const optimizerId =
      this._stringValue(optimizer.id) ||
      this._tFormat("editor.dynamic.optimizer", { index: index + 1 });
    const subtitle = this._tFormat("editor.dynamic.unsupported_optimizer_kind", {
      kind: this._stringValue(optimizer.kind) || this._t("editor.values.unknown"),
    });

    return html`
      <details class=${`list-card optimizer-card optimizer-card--${enabled ? "enabled" : "disabled"}`}>
        <summary>
          <div class="appliance-summary-row">
            <div class="appliance-summary-left">
              ${this._renderSvgIcon(chevronPath, "appliance-chevron")}
              <div class="card-title">
                <strong>${optimizerId}</strong>
                <span class="card-subtitle">${subtitle}</span>
              </div>
            </div>
            <div class="list-actions" @click=${this._preventSummaryToggle}>
              ${this._renderOptimizerEnabledToggle([...basePath, "enabled"], enabled)}
              <button
                type="button"
                ?disabled=${index === 0}
                @click=${() => this._moveListItem(["automation", "optimizers"], index, index - 1)}
              >${this._t("editor.actions.up")}</button>
              <button
                type="button"
                ?disabled=${index === total - 1}
                @click=${() => this._moveListItem(["automation", "optimizers"], index, index + 1)}
              >${this._t("editor.actions.down")}</button>
              <button
                type="button"
                class="danger"
                @click=${() => this._removeListItem(["automation", "optimizers"], index)}
              >${this._t("editor.actions.remove")}</button>
            </div>
          </div>
        </summary>
        <div class="appliance-body">
          <pre class="raw-preview">${JSON.stringify(optimizer, null, 2)}</pre>
        </div>
      </details>
    `;
  }

  private _renderOptimizerEnabledToggle(
    path: PathSegment[],
    enabled: boolean,
  ): TemplateResult {
    return html`
      <div class="summary-toggle" @click=${this._stopSummaryToggle}>
        <span>${this._t("editor.fields.optimizer_enabled")}</span>
        <ha-switch
          .checked=${enabled}
          @change=${(event: Event) =>
            this._setBoolean(
              path,
              (event.currentTarget as HTMLElement & { checked: boolean }).checked,
            )}
        ></ha-switch>
      </div>
    `;
  }

  private _renderAppliancesTab(): TemplateResult {
    const appliances = asJsonArray(this._getValue(["appliances"])) ?? [];

    return html`
      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.appliances.configured_appliances,
        html`
          <p class="inline-note">
            ${this._t("editor.notes.appliances")}
          </p>
          <div class="list-stack">
            ${appliances.length === 0
              ? html`<div class="message info">${this._t("editor.empty.no_appliances")}</div>`
              : appliances.map((appliance, index) =>
                  this._renderApplianceCard(appliance, index, appliances.length),
                )}
          </div>
          <div class="section-footer">
            <button type="button" class="add-button primary" @click=${this._handleAddEvCharger}>
              ${this._t("editor.actions.add_ev_charger")}
            </button>
            <button
              type="button"
              class="add-button"
              @click=${this._handleAddClimateAppliance}
            >
              ${this._t("editor.actions.add_climate_appliance")}
            </button>
            <button
              type="button"
              class="add-button"
              @click=${this._handleAddGenericAppliance}
            >
              ${this._t("editor.actions.add_generic_appliance")}
            </button>
          </div>
        `,
      )}
    `;
  }

  private _renderDeviceLabelCategories(): TemplateResult[] {
    const categories = objectEntries(this._getValue(["device_label_text"]));
    if (categories.length === 0) {
      return [html`<div class="message info">${this._t("editor.empty.no_device_label_categories")}</div>`];
    }

    return categories.map(([categoryKey, labels]) => {
      const labelEntries = objectEntries(labels);
      return html`
        <div class="list-card">
          <div class="card-header">
            <div class="card-title">
              <strong>${categoryKey}</strong>
              <span class="card-subtitle">${this._t("editor.card.category")}</span>
            </div>
            <div class="inline-actions">
              <button
                type="button"
                class="danger"
                @click=${() => this._removePath(["device_label_text", categoryKey])}
              >
                ${this._t("editor.actions.remove_category")}
              </button>
            </div>
          </div>
          <div class="field-grid">
            <div class="field">
              <label>${this._t("editor.fields.category_key")}</label>
              <input
                .value=${categoryKey}
                @change=${(event: Event) => {
                  this._handleRenameObjectKey(
                    ["device_label_text"],
                    categoryKey,
                    (event.currentTarget as HTMLInputElement).value,
                  );
                }}
              />
            </div>
          </div>
          <div class="list-stack">
            ${labelEntries.map(([labelKey, badgeText]) => html`
              <div class="nested-card">
                <div class="card-header">
                  <div class="card-title">
                    <strong>${labelKey}</strong>
                    <span class="card-subtitle">${this._t("editor.card.badge_text_entry")}</span>
                  </div>
                  <div class="inline-actions">
                    <button
                      type="button"
                      class="danger"
                      @click=${() =>
                        this._removePath(["device_label_text", categoryKey, labelKey])}
                    >
                      ${this._t("editor.actions.remove")}
                    </button>
                  </div>
                </div>
                <div class="field-grid">
                  <div class="field">
                    <label>${this._t("editor.fields.label_key")}</label>
                    <input
                      .value=${labelKey}
                      @change=${(event: Event) => {
                        this._handleRenameObjectKey(
                          ["device_label_text", categoryKey],
                          labelKey,
                          (event.currentTarget as HTMLInputElement).value,
                        );
                      }}
                    />
                  </div>
                  <div class="field">
                    <label>${this._t("editor.fields.badge_text")}</label>
                    <input
                      .value=${this._stringValue(badgeText)}
                      @change=${(event: Event) => {
                        this._setRequiredString(
                          ["device_label_text", categoryKey, labelKey],
                          (event.currentTarget as HTMLInputElement).value,
                        );
                      }}
                    />
                  </div>
                </div>
              </div>
            `)}
          </div>
          <div class="section-footer">
            <button
              type="button"
              class="add-button"
              @click=${() => this._handleAddDeviceLabel(categoryKey)}
            >
              ${this._t("editor.actions.add_badge_text")}
            </button>
          </div>
        </div>
      `;
    });
  }

  private _renderDeferrableConsumer(
    consumer: unknown,
    index: number,
    total: number,
  ): TemplateResult {
    const consumerObject = asJsonObject(consumer) ?? {};
    const basePath: PathSegment[] = [
      "power_devices",
      "house",
      "forecast",
      "deferrable_consumers",
      index,
    ];

    return html`
      <div class="list-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${this._stringValue(consumerObject.label) || this._tFormat("editor.dynamic.consumer", { index: index + 1 })}</strong>
            <span class="card-subtitle">${this._t("editor.card.house_deferrable_consumer")}</span>
          </div>
          <div class="list-actions">
            <button
              type="button"
              ?disabled=${index === 0}
              @click=${() =>
                this._moveListItem(
                  ["power_devices", "house", "forecast", "deferrable_consumers"],
                  index,
                  index - 1,
                )}
            >
              ${this._t("editor.actions.up")}
            </button>
            <button
              type="button"
              ?disabled=${index === total - 1}
              @click=${() =>
                this._moveListItem(
                  ["power_devices", "house", "forecast", "deferrable_consumers"],
                  index,
                  index + 1,
                )}
            >
              ${this._t("editor.actions.down")}
            </button>
            <button
              type="button"
              class="danger"
              @click=${() =>
                this._removeListItem(
                  ["power_devices", "house", "forecast", "deferrable_consumers"],
                  index,
                )}
            >
              ${this._t("editor.actions.remove")}
            </button>
          </div>
        </div>
        <div class="field-grid">
          ${this._renderRequiredEntityField(
            [...basePath, "energy_entity_id"],
            "editor.fields.energy_entity",
            ["sensor"],
            undefined,
            undefined,
            "editor.help.deferrable_consumer_energy_entity",
          )}
          ${this._renderOptionalTextField([...basePath, "label"], "editor.fields.label")}
        </div>
      </div>
    `;
  }

  private _renderDailyEnergyEntity(
    value: unknown,
    index: number,
    total: number,
  ): TemplateResult {
    const path: PathSegment[] = [
      "power_devices",
      "solar",
      "forecast",
      "daily_energy_entity_ids",
      index,
    ];
    return html`
      <div class="list-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${this._tFormat("editor.dynamic.daily_energy_entity", { index: index + 1 })}</strong>
          </div>
          <div class="list-actions">
            <button
              type="button"
              ?disabled=${index === 0}
              @click=${() =>
                this._moveListItem(
                  ["power_devices", "solar", "forecast", "daily_energy_entity_ids"],
                  index,
                  index - 1,
                )}
            >
              ${this._t("editor.actions.up")}
            </button>
            <button
              type="button"
              ?disabled=${index === total - 1}
              @click=${() =>
                this._moveListItem(
                  ["power_devices", "solar", "forecast", "daily_energy_entity_ids"],
                  index,
                  index + 1,
                )}
            >
              ${this._t("editor.actions.down")}
            </button>
            <button
              type="button"
              class="danger"
              @click=${() =>
                this._removeListItem(
                  ["power_devices", "solar", "forecast", "daily_energy_entity_ids"],
                  index,
                )}
            >
              ${this._t("editor.actions.remove")}
            </button>
          </div>
        </div>
        ${this._renderRequiredEntityField(path, "editor.fields.entity_id", ["sensor"], undefined, value, "editor.help.solar_daily_energy_entity")}
      </div>
    `;
  }

  private _renderImportPriceWindow(
    windowConfig: unknown,
    index: number,
    total: number,
  ): TemplateResult {
    const windowObject = asJsonObject(windowConfig) ?? {};
    const basePath: PathSegment[] = [
      "power_devices",
      "grid",
      "forecast",
      "import_price_windows",
      index,
    ];

    return html`
      <div class="list-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${this._tFormat("editor.dynamic.import_window", { index: index + 1 })}</strong>
            <span class="card-subtitle">${this._t("editor.card.local_time_window")}</span>
          </div>
          <div class="list-actions">
            <button
              type="button"
              ?disabled=${index === 0}
              @click=${() =>
                this._moveListItem(
                  ["power_devices", "grid", "forecast", "import_price_windows"],
                  index,
                  index - 1,
                )}
            >
              ${this._t("editor.actions.up")}
            </button>
            <button
              type="button"
              ?disabled=${index === total - 1}
              @click=${() =>
                this._moveListItem(
                  ["power_devices", "grid", "forecast", "import_price_windows"],
                  index,
                  index + 1,
                )}
            >
              ${this._t("editor.actions.down")}
            </button>
            <button
              type="button"
              class="danger"
              @click=${() =>
                this._removeListItem(
                  ["power_devices", "grid", "forecast", "import_price_windows"],
                  index,
                )}
            >
              ${this._t("editor.actions.remove")}
            </button>
          </div>
        </div>
        <div class="field-grid">
          <div class="field">
            <div class="field-label-row">
              <label>${this._t("editor.fields.start")}</label>
              ${this._renderHelpIcon("editor.fields.start", "editor.help.import_window_start")}
            </div>
            <input
              type="time"
              .value=${this._stringValue(windowObject.start)}
              @change=${(event: Event) =>
                this._setRequiredString(
                  [...basePath, "start"],
                  (event.currentTarget as HTMLInputElement).value,
                )}
            />
          </div>
          <div class="field">
            <div class="field-label-row">
              <label>${this._t("editor.fields.end")}</label>
              ${this._renderHelpIcon("editor.fields.end", "editor.help.import_window_end")}
            </div>
            <input
              type="time"
              .value=${this._stringValue(windowObject.end)}
              @change=${(event: Event) =>
                this._setRequiredString(
                  [...basePath, "end"],
                  (event.currentTarget as HTMLInputElement).value,
                )}
            />
          </div>
          ${this._renderRequiredNumberField([...basePath, "price"], "editor.fields.price", undefined, "any", "editor.help.import_window_price")}
        </div>
      </div>
    `;
  }

  private _renderApplianceCard(
    appliance: unknown,
    index: number,
    total: number,
  ): TemplateResult {
    const applianceObject = asJsonObject(appliance) ?? {};
    const kind = this._stringValue(applianceObject.kind);
    if (kind === "ev_charger") {
      return this._renderEvChargerAppliance(applianceObject, index, total);
    }
    if (kind === "climate") {
      return this._renderClimateAppliance(applianceObject, index, total);
    }
    if (kind === "generic") {
      return this._renderGenericAppliance(applianceObject, index, total);
    }
    return this._renderUnsupportedAppliance(applianceObject, index, total);
  }

  private _renderUnsupportedAppliance(
    appliance: JsonObject,
    index: number,
    total: number,
  ): TemplateResult {
    const chevronPath = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";
    const applianceName = this._stringValue(appliance.name) || this._tFormat("editor.dynamic.appliance", { index: index + 1 });
    const subtitle = this._tFormat("editor.dynamic.unsupported_appliance_kind", {
      kind: this._stringValue(appliance.kind) || this._t("editor.values.unknown"),
    });
    return html`
      <details class="list-card">
        <summary>
          <div class="appliance-summary-row">
            <div class="appliance-summary-left">
              ${this._renderSvgIcon(chevronPath, "appliance-chevron")}
              <div class="card-title">
                <strong>${applianceName}</strong>
                <span class="card-subtitle">${subtitle}</span>
              </div>
            </div>
            <div class="list-actions" @click=${this._preventSummaryToggle}>
              <button
                type="button"
                ?disabled=${index === 0}
                @click=${() => this._moveListItem(["appliances"], index, index - 1)}
              >${this._t("editor.actions.up")}</button>
              <button
                type="button"
                ?disabled=${index === total - 1}
                @click=${() => this._moveListItem(["appliances"], index, index + 1)}
              >${this._t("editor.actions.down")}</button>
              <button
                type="button"
                class="danger"
                @click=${() => this._removeListItem(["appliances"], index)}
              >${this._t("editor.actions.remove")}</button>
            </div>
          </div>
        </summary>
        <div class="appliance-body">
          <pre class="raw-preview">${JSON.stringify(appliance, null, 2)}</pre>
        </div>
      </details>
    `;
  }

  private _renderEvChargerAppliance(
    appliance: JsonObject,
    index: number,
    total: number,
  ): TemplateResult {
    const basePath: PathSegment[] = ["appliances", index];
    const useModes = objectEntries(
      this._getValue([...basePath, "controls", "use_mode", "values"]),
    );
    const ecoGears = objectEntries(
      this._getValue([...basePath, "controls", "eco_gear", "values"]),
    );
    const vehicles = asJsonArray(this._getValue([...basePath, "vehicles"])) ?? [];
    const applianceName =
      this._stringValue(appliance.name) || this._tFormat("editor.dynamic.ev_charger", { index: index + 1 });
    const applianceId = this._stringValue(appliance.id) || this._t("editor.values.missing_id");
    const chevronPath = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";
    const isYaml = this._getApplianceMode(index) === "yaml";

    return html`
      <details class="list-card">
        <summary>
          <div class="appliance-summary-row">
            <div class="appliance-summary-left">
              ${this._renderSvgIcon(chevronPath, "appliance-chevron")}
              <div class="card-title">
                <strong>${applianceName}</strong>
                <span class="card-subtitle">${applianceId}</span>
              </div>
            </div>
            <div class="list-actions" @click=${this._preventSummaryToggle}>
              ${this._renderApplianceModeToggle(index)}
              <button type="button" ?disabled=${index === 0}
                @click=${() => this._moveListItem(["appliances"], index, index - 1)}
              >${this._t("editor.actions.up")}</button>
              <button type="button" ?disabled=${index === total - 1}
                @click=${() => this._moveListItem(["appliances"], index, index + 1)}
              >${this._t("editor.actions.down")}</button>
              <button type="button" class="danger"
                @click=${() => this._removeListItem(["appliances"], index)}
              >${this._t("editor.actions.remove")}</button>
            </div>
          </div>
        </summary>
        <div class="appliance-body">
          ${isYaml
            ? this._renderApplianceYamlEditor(index)
            : html`
              ${this._renderSimpleSection(
                this._t("editor.sections.identity_and_limits"),
                html`<div class="field-grid">
                  ${this._renderRequiredTextField([...basePath, "id"], "editor.fields.appliance_id", undefined, "editor.help.appliance_id")}
                  ${this._renderRequiredTextField([...basePath, "name"], "editor.fields.appliance_name", undefined, "editor.help.appliance_name")}
                  ${this._renderOptionalIconField([...basePath, "icon"], "editor.fields.appliance_icon", "editor.helpers.appliance_icon")}
                  <div class="field"><label>${this._t("editor.fields.kind")}</label><input value="ev_charger" disabled /></div>
                  ${this._renderRequiredNumberField([...basePath, "limits", "max_charging_power_kw"], "editor.fields.max_charging_power_kw", undefined, "any", "editor.help.ev_max_charging_power_kw")}
                </div>`,
              )}
              ${this._renderSimpleSection(
                this._t("editor.sections.controls"),
                html`<div class="field-grid">
                  ${this._renderRequiredEntityField([...basePath, "controls", "charge", "entity_id"], "editor.fields.charge_switch_entity", ["switch"], undefined, undefined, "editor.help.ev_charge_switch_entity")}
                  ${this._renderRequiredEntityField([...basePath, "controls", "use_mode", "entity_id"], "editor.fields.use_mode_entity", ["input_select", "select"], undefined, undefined, "editor.help.ev_use_mode_entity")}
                  ${this._renderRequiredEntityField([...basePath, "controls", "eco_gear", "entity_id"], "editor.fields.eco_gear_entity", ["input_select", "select"], undefined, undefined, "editor.help.ev_eco_gear_entity")}
                </div>`,
              )}
              ${this._renderSimpleSection(
                this._t("editor.sections.use_modes"),
                html`<div class="list-stack">
                  ${useModes.map(([modeKey, modeConfig]) => this._renderUseMode(basePath, modeKey, modeConfig))}
                </div>
                <div class="section-footer">
                  <button type="button" class="add-button" @click=${() => this._handleAddUseMode(index)}>${this._t("editor.actions.add_use_mode")}</button>
                </div>`,
              )}
              ${this._renderSimpleSection(
                this._t("editor.sections.eco_gears"),
                html`<div class="list-stack">
                  ${ecoGears.map(([gearKey, gearConfig]) => this._renderEcoGear(basePath, gearKey, gearConfig))}
                </div>
                <div class="section-footer">
                  <button type="button" class="add-button" @click=${() => this._handleAddEcoGear(index)}>${this._t("editor.actions.add_eco_gear")}</button>
                </div>`,
              )}
              ${this._renderSimpleSection(
                this._t("editor.sections.vehicles"),
                html`<div class="list-stack">
                  ${vehicles.map((vehicle, vehicleIndex) => this._renderVehicle(basePath, vehicle, vehicleIndex, vehicles.length))}
                </div>
                <div class="section-footer">
                  <button type="button" class="add-button" @click=${() => this._handleAddVehicle(index)}>${this._t("editor.actions.add_vehicle")}</button>
                </div>`,
              )}
            `}
        </div>
      </details>
    `;
  }

  private _renderGenericAppliance(
    appliance: JsonObject,
    index: number,
    total: number,
  ): TemplateResult {
    const basePath: PathSegment[] = ["appliances", index];
    const historyAveragePath: PathSegment[] = [...basePath, "projection", "history_average"];
    const projectionStrategy =
      this._stringValue(this._getValue([...basePath, "projection", "strategy"])) || "fixed";
    const applianceName =
      this._stringValue(appliance.name) ||
      this._tFormat("editor.dynamic.generic_appliance", { index: index + 1 });
    const applianceId = this._stringValue(appliance.id) || this._t("editor.values.missing_id");
    const chevronPath = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";
    const isYaml = this._getApplianceMode(index) === "yaml";

    return html`
      <details class="list-card">
        <summary>
          <div class="appliance-summary-row">
            <div class="appliance-summary-left">
              ${this._renderSvgIcon(chevronPath, "appliance-chevron")}
              <div class="card-title">
                <strong>${applianceName}</strong>
                <span class="card-subtitle">${applianceId}</span>
              </div>
            </div>
            <div class="list-actions" @click=${this._preventSummaryToggle}>
              ${this._renderApplianceModeToggle(index)}
              <button type="button" ?disabled=${index === 0}
                @click=${() => this._moveListItem(["appliances"], index, index - 1)}
              >${this._t("editor.actions.up")}</button>
              <button type="button" ?disabled=${index === total - 1}
                @click=${() => this._moveListItem(["appliances"], index, index + 1)}
              >${this._t("editor.actions.down")}</button>
              <button type="button" class="danger"
                @click=${() => this._removeListItem(["appliances"], index)}
              >${this._t("editor.actions.remove")}</button>
            </div>
          </div>
        </summary>
        <div class="appliance-body">
          ${isYaml
            ? this._renderApplianceYamlEditor(index)
            : html`
              ${this._renderSimpleSection(
                this._t("editor.sections.identity_and_limits"),
                html`<div class="field-grid">
                  ${this._renderRequiredTextField([...basePath, "id"], "editor.fields.appliance_id", undefined, "editor.help.appliance_id")}
                  ${this._renderRequiredTextField([...basePath, "name"], "editor.fields.appliance_name", undefined, "editor.help.appliance_name")}
                  ${this._renderOptionalIconField([...basePath, "icon"], "editor.fields.appliance_icon", "editor.helpers.appliance_icon")}
                  <div class="field"><label>${this._t("editor.fields.kind")}</label><input value="generic" disabled /></div>
                </div>`,
              )}
              ${this._renderSimpleSection(
                this._t("editor.sections.controls"),
                html`<div class="field-grid">
                  ${this._renderRequiredEntityField([...basePath, "controls", "switch", "entity_id"], "editor.fields.switch_entity", ["switch"], undefined, undefined, "editor.help.appliance_switch_entity")}
                </div>`,
              )}
              ${this._renderSimpleSection(
                this._t("editor.sections.projection"),
                this._renderProjectedApplianceProjectionSection(
                  basePath, projectionStrategy, historyAveragePath,
                  "editor.notes.generic_appliance_projection",
                  (strategy) => this._handleProjectedApplianceProjectionStrategyChange(index, strategy),
                ),
              )}
            `}
        </div>
      </details>
    `;
  }

  private _renderClimateAppliance(
    appliance: JsonObject,
    index: number,
    total: number,
  ): TemplateResult {
    const basePath: PathSegment[] = ["appliances", index];
    const historyAveragePath: PathSegment[] = [...basePath, "projection", "history_average"];
    const projectionStrategy =
      this._stringValue(this._getValue([...basePath, "projection", "strategy"])) || "fixed";
    const applianceName =
      this._stringValue(appliance.name) ||
      this._tFormat("editor.dynamic.climate_appliance", { index: index + 1 });
    const applianceId = this._stringValue(appliance.id) || this._t("editor.values.missing_id");
    const chevronPath = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";
    const isYaml = this._getApplianceMode(index) === "yaml";

    return html`
      <details class="list-card">
        <summary>
          <div class="appliance-summary-row">
            <div class="appliance-summary-left">
              ${this._renderSvgIcon(chevronPath, "appliance-chevron")}
              <div class="card-title">
                <strong>${applianceName}</strong>
                <span class="card-subtitle">${applianceId}</span>
              </div>
            </div>
            <div class="list-actions" @click=${this._preventSummaryToggle}>
              ${this._renderApplianceModeToggle(index)}
              <button type="button" ?disabled=${index === 0}
                @click=${() => this._moveListItem(["appliances"], index, index - 1)}
              >${this._t("editor.actions.up")}</button>
              <button type="button" ?disabled=${index === total - 1}
                @click=${() => this._moveListItem(["appliances"], index, index + 1)}
              >${this._t("editor.actions.down")}</button>
              <button type="button" class="danger"
                @click=${() => this._removeListItem(["appliances"], index)}
              >${this._t("editor.actions.remove")}</button>
            </div>
          </div>
        </summary>
        <div class="appliance-body">
          ${isYaml
            ? this._renderApplianceYamlEditor(index)
            : html`
              ${this._renderSimpleSection(
                this._t("editor.sections.identity_and_limits"),
                html`<div class="field-grid">
                  ${this._renderRequiredTextField([...basePath, "id"], "editor.fields.appliance_id", undefined, "editor.help.appliance_id")}
                  ${this._renderRequiredTextField([...basePath, "name"], "editor.fields.appliance_name", undefined, "editor.help.appliance_name")}
                  ${this._renderOptionalIconField([...basePath, "icon"], "editor.fields.appliance_icon", "editor.helpers.appliance_icon")}
                  <div class="field"><label>${this._t("editor.fields.kind")}</label><input value="climate" disabled /></div>
                </div>`,
              )}
              ${this._renderSimpleSection(
                this._t("editor.sections.controls"),
                html`<div class="field-grid">
                  ${this._renderRequiredEntityField([...basePath, "controls", "climate", "entity_id"], "editor.fields.climate_entity", ["climate"], undefined, undefined, "editor.help.appliance_climate_entity")}
                </div>`,
              )}
              ${this._renderSimpleSection(
                this._t("editor.sections.projection"),
                this._renderProjectedApplianceProjectionSection(
                  basePath, projectionStrategy, historyAveragePath,
                  "editor.notes.climate_appliance_projection",
                  (strategy) => this._handleProjectedApplianceProjectionStrategyChange(index, strategy),
                ),
              )}
            `}
        </div>
      </details>
    `;
  }

  private _renderProjectedApplianceProjectionSection(
    appliancePath: PathSegment[],
    projectionStrategy: string,
    historyAveragePath: PathSegment[],
    noteKey: string,
    onStrategyChange: (strategy: string) => void,
  ): TemplateResult {
    return html`
      <div class="section-content">
        <p class="inline-note">
          ${this._t(noteKey)}
        </p>
        <div class="field-grid">
          <div class="field">
            <div class="field-label-row">
              <label>${this._t("editor.fields.projection_strategy")}</label>
              ${this._renderHelpIcon("editor.fields.projection_strategy", "editor.help.appliance_projection_strategy")}
            </div>
            <select
              .value=${projectionStrategy}
              @change=${(event: Event) =>
                onStrategyChange((event.currentTarget as HTMLSelectElement).value)}
            >
              ${GENERIC_PROJECTION_STRATEGIES.map(
                (option) => html`
                  <option value=${option.value}>${this._t(option.labelKey)}</option>
                `,
              )}
            </select>
          </div>
          ${this._renderRequiredNumberField(
            [...appliancePath, "projection", "hourly_energy_kwh"],
            "editor.fields.hourly_energy_kwh",
            undefined,
            "any",
            "editor.help.appliance_hourly_energy_kwh",
          )}
        </div>
        ${projectionStrategy === "history_average"
          ? html`
              <div class="field-grid">
                ${this._renderRequiredEntityField(
                  [...historyAveragePath, "energy_entity_id"],
                  "editor.fields.history_energy_entity",
                  ["sensor"],
                  "editor.helpers.history_energy_entity",
                )}
                ${this._renderRequiredNumberField(
                  [...historyAveragePath, "lookback_days"],
                  "editor.fields.history_lookback_days",
                  undefined,
                  "1",
                  "editor.help.appliance_history_lookback_days",
                )}
              </div>
            `
          : nothing}
      </div>
    `;
  }

  private _renderUseMode(
    appliancePath: PathSegment[],
    modeKey: string,
    modeConfig: unknown,
  ): TemplateResult {
    const modeObject = asJsonObject(modeConfig) ?? {};
    const valuesPath: PathSegment[] = [
      ...appliancePath,
      "controls",
      "use_mode",
      "values",
    ];
    return html`
      <div class="nested-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${modeKey}</strong>
            <span class="card-subtitle">${this._t("editor.card.use_mode_mapping")}</span>
          </div>
          <div class="inline-actions">
            <button
              type="button"
              class="danger"
              @click=${() => this._removePath([...valuesPath, modeKey])}
            >
              ${this._t("editor.actions.remove")}
            </button>
          </div>
        </div>
        <div class="field-grid">
          <div class="field">
            <label>${this._t("editor.fields.mode_id")}</label>
            <input
              .value=${modeKey}
              @change=${(event: Event) =>
                this._handleRenameObjectKey(
                  valuesPath,
                  modeKey,
                  (event.currentTarget as HTMLInputElement).value,
                )}
            />
          </div>
          <div class="field">
            <label>${this._t("editor.fields.behavior")}</label>
            <select
              .value=${this._stringValue(modeObject.behavior) || "fixed_max_power"}
              @change=${(event: Event) =>
                this._setRequiredString(
                  [...valuesPath, modeKey, "behavior"],
                  (event.currentTarget as HTMLSelectElement).value,
                )}
            >
              ${USE_MODE_BEHAVIORS.map(
                (option) => html`
                  <option value=${option.value}>${this._t(option.labelKey)}</option>
                `,
              )}
            </select>
          </div>
        </div>
      </div>
    `;
  }

  private _renderEcoGear(
    appliancePath: PathSegment[],
    gearKey: string,
    gearConfig: unknown,
  ): TemplateResult {
    const gearObject = asJsonObject(gearConfig) ?? {};
    const valuesPath: PathSegment[] = [
      ...appliancePath,
      "controls",
      "eco_gear",
      "values",
    ];
    return html`
      <div class="nested-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${gearKey}</strong>
            <span class="card-subtitle">${this._t("editor.card.eco_gear_mapping")}</span>
          </div>
          <div class="inline-actions">
            <button
              type="button"
              class="danger"
              @click=${() => this._removePath([...valuesPath, gearKey])}
            >
              ${this._t("editor.actions.remove")}
            </button>
          </div>
        </div>
        <div class="field-grid">
          <div class="field">
            <label>${this._t("editor.fields.gear_id")}</label>
            <input
              .value=${gearKey}
              @change=${(event: Event) =>
                this._handleRenameObjectKey(
                  valuesPath,
                  gearKey,
                  (event.currentTarget as HTMLInputElement).value,
                )}
            />
          </div>
          ${this._renderRequiredNumberField(
            [...valuesPath, gearKey, "min_power_kw"],
            "editor.fields.min_power_kw",
            gearObject.min_power_kw,
          )}
        </div>
      </div>
    `;
  }

  private _renderVehicle(
    appliancePath: PathSegment[],
    vehicle: unknown,
    index: number,
    total: number,
  ): TemplateResult {
    const vehicleObject = asJsonObject(vehicle) ?? {};
    const basePath: PathSegment[] = [...appliancePath, "vehicles", index];
    return html`
      <div class="nested-card">
        <div class="card-header">
          <div class="card-title">
            <strong>${this._stringValue(vehicleObject.name) || this._tFormat("editor.dynamic.vehicle", { index: index + 1 })}</strong>
            <span class="card-subtitle">${this._stringValue(vehicleObject.id) || this._t("editor.values.missing_id")}</span>
          </div>
          <div class="list-actions">
            <button
              type="button"
              ?disabled=${index === 0}
              @click=${() =>
                this._moveListItem([...appliancePath, "vehicles"], index, index - 1)}
            >
              ${this._t("editor.actions.up")}
            </button>
            <button
              type="button"
              ?disabled=${index === total - 1}
              @click=${() =>
                this._moveListItem([...appliancePath, "vehicles"], index, index + 1)}
            >
              ${this._t("editor.actions.down")}
            </button>
            <button
              type="button"
              class="danger"
              @click=${() => this._removeListItem([...appliancePath, "vehicles"], index)}
            >
              ${this._t("editor.actions.remove")}
            </button>
          </div>
        </div>
        <div class="field-grid">
          ${this._renderRequiredTextField([...basePath, "id"], "editor.fields.vehicle_id", undefined, "editor.help.vehicle_id")}
          ${this._renderRequiredTextField([...basePath, "name"], "editor.fields.vehicle_name")}
          ${this._renderRequiredEntityField(
            [...basePath, "telemetry", "soc_entity_id"],
            "editor.fields.soc_entity",
            ["sensor"],
            undefined,
            undefined,
            "editor.help.vehicle_soc_entity",
          )}
          ${this._renderOptionalEntityField(
            [...basePath, "telemetry", "charge_limit_entity_id"],
            "editor.fields.charge_limit_entity",
            ["number"],
            undefined,
            "editor.help.vehicle_charge_limit_entity",
          )}
          ${this._renderRequiredNumberField(
            [...basePath, "limits", "battery_capacity_kwh"],
            "editor.fields.battery_capacity_kwh",
            undefined,
            "any",
            "editor.help.vehicle_battery_capacity_kwh",
          )}
          ${this._renderRequiredNumberField(
            [...basePath, "limits", "max_charging_power_kw"],
            "editor.fields.max_charging_power_kw",
            undefined,
            "any",
            "editor.help.vehicle_max_charging_power_kw",
          )}
        </div>
      </div>
    `;
  }

  private _renderOptionalTextField(
    path: PathSegment[],
    labelKey: string,
    helperKey?: string,
    helpKey?: string,
  ): TemplateResult {
    return html`
      <div class="field">
        <div class="field-label-row">
          <label>${this._t(labelKey)}</label>
          ${helpKey ? this._renderHelpIcon(labelKey, helpKey) : nothing}
        </div>
        <input
          .value=${this._stringValue(this._getValue(path))}
          @change=${(event: Event) =>
            this._setOptionalString(path, (event.currentTarget as HTMLInputElement).value)}
        />
        ${helperKey ? html`<div class="helper">${this._t(helperKey)}</div>` : nothing}
      </div>
    `;
  }

  private _renderRequiredTextField(
    path: PathSegment[],
    labelKey: string,
    explicitValue?: unknown,
    helpKey?: string,
  ): TemplateResult {
    const value = explicitValue === undefined ? this._getValue(path) : explicitValue;
    return html`
      <div class="field">
        <div class="field-label-row">
          <label>${this._t(labelKey)}</label>
          ${helpKey ? this._renderHelpIcon(labelKey, helpKey) : nothing}
        </div>
        <input
          .value=${this._stringValue(value)}
          @change=${(event: Event) =>
            this._setRequiredString(path, (event.currentTarget as HTMLInputElement).value)}
        />
      </div>
    `;
  }

  private _renderOptionalNumberField(
    path: PathSegment[],
    labelKey: string,
    helperKey?: string,
    helpKey?: string,
  ): TemplateResult {
    return html`
      <div class="field">
        <div class="field-label-row">
          <label>${this._t(labelKey)}</label>
          ${helpKey ? this._renderHelpIcon(labelKey, helpKey) : nothing}
        </div>
        <input
          type="number"
          step="any"
          .value=${this._stringValue(this._getValue(path))}
          @change=${(event: Event) =>
            this._setOptionalNumber(path, (event.currentTarget as HTMLInputElement).value)}
        />
        ${helperKey ? html`<div class="helper">${this._t(helperKey)}</div>` : nothing}
      </div>
    `;
  }

  private _renderRequiredNumberField(
    path: PathSegment[],
    labelKey: string,
    explicitValue?: unknown,
    step = "any",
    helpKey?: string,
  ): TemplateResult {
    const value = explicitValue === undefined ? this._getValue(path) : explicitValue;
    return html`
      <div class="field">
        <div class="field-label-row">
          <label>${this._t(labelKey)}</label>
          ${helpKey ? this._renderHelpIcon(labelKey, helpKey) : nothing}
        </div>
        <input
          type="number"
          .step=${step}
          .value=${this._stringValue(value)}
          @change=${(event: Event) =>
            this._setRequiredNumber(path, (event.currentTarget as HTMLInputElement).value)}
        />
      </div>
    `;
  }

  private _renderOptionalIconField(
    path: PathSegment[],
    labelKey: string,
    helperKey?: string,
  ): TemplateResult {
    return html`
      <div class="field">
        <ha-selector
          .hass=${this.hass}
          .narrow=${this.narrow ?? false}
          .selector=${APPLIANCE_ICON_SELECTOR}
          .label=${this._t(labelKey)}
          .helper=${helperKey ? this._t(helperKey) : undefined}
          .required=${false}
          .value=${this._stringValue(this._getValue(path))}
          @value-changed=${(event: Event) => {
            const nextValue = (event as CustomEvent<{ value?: string }>).detail?.value ?? "";
            this._setOptionalString(path, nextValue);
          }}
        ></ha-selector>
      </div>
    `;
  }

  private _renderBooleanField(
    path: PathSegment[],
    labelKey: string,
    defaultValue: boolean,
  ): TemplateResult {
    const checked = this._booleanValue(this._getValue(path), defaultValue);
    return html`
      <div class="field toggle-field">
        <ha-formfield .label=${this._t(labelKey)}>
          <ha-switch
            .checked=${checked}
            @change=${(event: Event) =>
              this._setBoolean(
                path,
                (event.currentTarget as HTMLElement & { checked: boolean }).checked,
              )}
          ></ha-switch>
        </ha-formfield>
      </div>
    `;
  }

  private _renderOptionalEntityField(
    path: PathSegment[],
    labelKey: string,
    includeDomains?: string[],
    helperKey?: string,
    helpKey?: string,
  ): TemplateResult {
    return this._renderEntityField(
      path,
      labelKey,
      includeDomains,
      helperKey,
      false,
      this._getValue(path),
      helpKey,
    );
  }

  private _renderRequiredEntityField(
    path: PathSegment[],
    labelKey: string,
    includeDomains?: string[],
    helperKey?: string,
    explicitValue?: unknown,
    helpKey?: string,
  ): TemplateResult {
    return this._renderEntityField(
      path,
      labelKey,
      includeDomains,
      helperKey,
      true,
      explicitValue === undefined ? this._getValue(path) : explicitValue,
      helpKey,
    );
  }

  private _renderEntityField(
    path: PathSegment[],
    labelKey: string,
    includeDomains: string[] | undefined,
    helperKey: string | undefined,
    required: boolean,
    value: unknown,
    helpKey?: string,
  ): TemplateResult {
    return html`
      <div class="field">
        <div class="field-label-row">
          <label>${this._t(labelKey)}</label>
          ${helpKey ? this._renderHelpIcon(labelKey, helpKey) : nothing}
        </div>
        <ha-entity-picker
          .hass=${this.hass}
          .value=${this._stringValue(value)}
          .includeDomains=${includeDomains}
          @value-changed=${(event: Event) => {
            const nextValue = (event as CustomEvent<{ value?: string }>).detail?.value ?? "";
            if (required) {
              this._setRequiredString(path, nextValue);
            } else {
              this._setOptionalString(path, nextValue);
            }
          }}
        ></ha-entity-picker>
        ${helperKey ? html`<div class="helper">${this._t(helperKey)}</div>` : nothing}
      </div>
    `;
  }

  private _renderHelpIcon(labelKey: string, contentKey: string): TemplateResult {
    return html`
      <button
        type="button"
        class="help-btn"
        aria-label=${this._t("editor.help.aria_label")}
        @click=${(event: Event) => {
          event.stopPropagation();
          this._helpDialog = { labelKey, contentKey };
        }}
      >?</button>
    `;
  }

  private _renderHelpDialog(): TemplateResult | typeof nothing {
    if (!this._helpDialog) {
      return nothing;
    }
    const { labelKey, contentKey } = this._helpDialog;
    return html`
      <div class="help-overlay" @click=${this._closeHelp}>
        <div class="help-dialog" @click=${(e: Event) => e.stopPropagation()}>
          <div class="help-dialog-header">
            <strong>${this._t(labelKey)}</strong>
            <button
              type="button"
              class="help-dialog-close"
              aria-label=${this._t("editor.help.close")}
              @click=${this._closeHelp}
            >✕</button>
          </div>
          <p class="help-dialog-body">${this._t(contentKey)}</p>
        </div>
      </div>
    `;
  }

  private _closeHelp = (): void => {
    this._helpDialog = null;
  };

  private _renderIssueBoard(): TemplateResult | typeof nothing {
    if (!this._validation) {
      return nothing;
    }

    const groups = [
      { title: this._t("editor.issues.errors"), items: this._validation.errors },
      { title: this._t("editor.issues.warnings"), items: this._validation.warnings },
    ].filter((group) => group.items.length > 0);

    if (groups.length === 0) {
      return nothing;
    }

    return html`
      <div class="issue-board">
        ${groups.map(
          (group) => html`
            <div class="issue-group">
              <h3>${group.title}</h3>
              <ul>
                ${group.items.map(
                  (issue) => html`
                    <li>
                      <div class="issue-path">${issue.path}</div>
                      <div>${issue.message}</div>
                    </li>
                  `,
                )}
              </ul>
            </div>
          `,
        )}
      </div>
    `;
  }

  private _buildTabIssueCounts(): Record<TabId, { errors: number; warnings: number }> {
    const counts: Record<TabId, { errors: number; warnings: number }> = {
      general: { errors: 0, warnings: 0 },
      power_devices: { errors: 0, warnings: 0 },
      scheduler: { errors: 0, warnings: 0 },
      automation: { errors: 0, warnings: 0 },
      appliances: { errors: 0, warnings: 0 },
    };

    if (this._validation) {
      for (const issue of this._validation.errors) {
        const tabId = TAB_SECTIONS[issue.section] ?? "general";
        counts[tabId].errors += 1;
      }
      for (const issue of this._validation.warnings) {
        const tabId = TAB_SECTIONS[issue.section] ?? "general";
        counts[tabId].warnings += 1;
      }
    }

    for (const scopeId of Object.keys(this._scopeYamlErrors) as ScopeId[]) {
      if (!this._scopeYamlErrors[scopeId]) {
        continue;
      }

      const tabId = getScope(scopeId).tabId;
      if (tabId) {
        counts[tabId].warnings += 1;
      }
    }

    return counts;
  }

  private async _loadConfig(options: { showMessage: boolean }): Promise<void> {
    if (!this.hass) {
      return;
    }
    this._loading = true;
    try {
      const [loadedResult, liveApplianceMetadataResult] = await Promise.allSettled([
        this.hass.callWS<unknown>({ type: "helman/get_config" }),
        this._loadLiveApplianceMetadata(),
      ]);
      if (loadedResult.status !== "fulfilled") {
        throw loadedResult.reason;
      }
      this._config = asJsonObject(loadedResult.value) ? cloneJson(loadedResult.value) : {};
      this._liveApplianceMetadata =
        liveApplianceMetadataResult.status === "fulfilled"
          ? liveApplianceMetadataResult.value
          : null;
      this._validation = null;
      this._dirty = this._config
        ? this._normalizeSurplusApplianceOptimizerParams(this._config)
        : false;
      this._resetScopeYamlState();
      if (options.showMessage) {
        this._message = {
          kind: "info",
          text: this._t("editor.messages.reloaded_config"),
        };
      }
    } catch (error) {
      this._liveApplianceMetadata = null;
      this._message = {
        kind: "error",
        text: this._formatError(error, this._t("editor.messages.load_config_failed")),
      };
    } finally {
      this._loading = false;
    }
  }

  private async _validateConfig(): Promise<void> {
    if (!this.hass || !this._config) {
      return;
    }
    if (this._hasBlockingYamlErrors()) {
      this._message = {
        kind: "error",
        text: this._t("editor.messages.fix_yaml_errors_first"),
      };
      return;
    }
    this._validating = true;
    try {
      const validation = await this.hass.callWS<ValidationReport>({
        type: "helman/validate_config",
        config: this._config,
      });
      this._validation = validation;
      this._message = validation.valid
        ? { kind: "success", text: this._t("editor.messages.validation_passed") }
        : {
            kind: "error",
            text: this._t("editor.messages.validation_failed"),
          };
    } catch (error) {
      this._message = {
        kind: "error",
        text: this._formatError(error, this._t("editor.messages.validate_config_failed")),
      };
    } finally {
      this._validating = false;
    }
  }

  private async _saveConfig(): Promise<void> {
    if (!this.hass || !this._config) {
      return;
    }
    if (this._hasBlockingYamlErrors()) {
      this._message = {
        kind: "error",
        text: this._t("editor.messages.fix_yaml_errors_first"),
      };
      return;
    }
    this._saving = true;
    try {
      const response = await this.hass.callWS<SaveConfigResponse>({
        type: "helman/save_config",
        config: this._config,
      });
      this._validation = response.validation;
      if (response.success) {
        this._liveApplianceMetadata = await this._loadLiveApplianceMetadata();
        this._dirty = this._config
          ? this._normalizeSurplusApplianceOptimizerParams(this._config)
          : false;
        this._message = {
          kind: "success",
          text: response.reloadStarted
            ? this._t("editor.messages.config_saved_reload_started")
            : this._t("editor.messages.config_saved"),
        };
        return;
      }

      this._message = {
        kind: "error",
        text:
          response.reloadError ??
          (response.validation.valid
            ? this._t("editor.messages.config_saved_reload_failed")
            : this._t("editor.messages.save_rejected")),
      };
    } catch (error) {
      this._message = {
        kind: "error",
        text: this._formatError(error, this._t("editor.messages.save_failed")),
      };
    } finally {
      this._saving = false;
    }
  }

  private _handleReloadClick = async (): Promise<void> => {
    if (
      (this._dirty || this._hasBlockingYamlErrors()) &&
      !window.confirm(this._t("editor.confirm.discard_changes"))
    ) {
      return;
    }
    await this._loadConfig({ showMessage: true });
  };

  private _handleValidateClick = async (): Promise<void> => {
    await this._validateConfig();
  };

  private _handleSaveClick = async (): Promise<void> => {
    await this._saveConfig();
  };

  private _handleScopeModeSelection(
    scopeId: ScopeId,
    nextMode: EditorMode,
    event: Event,
  ): void {
    event.preventDefault();
    event.stopPropagation();

    if (nextMode === "yaml") {
      void this._enterYamlMode(scopeId);
      return;
    }

    this._exitYamlMode(scopeId);
  }

  private async _enterYamlMode(scopeId: ScopeId): Promise<void> {
    if (!this._config || this._isScopeYaml(scopeId)) {
      return;
    }
    if (this._hasBlockingDescendantYamlErrors(scopeId)) {
      this._message = {
        kind: "error",
        text: this._t("editor.messages.fix_descendant_yaml_errors"),
      };
      return;
    }

    const descendantScopeIds = getDescendantScopeIds(scopeId);

    try {
      await loadHaYamlEditor();
      if (!this._config || this._isScopeYaml(scopeId)) {
        return;
      }

      const nextModes = this._omitScopeIds(this._scopeModes, descendantScopeIds);
      nextModes[scopeId] = "yaml";

      const nextValues = this._omitScopeIds(
        this._scopeYamlValues,
        descendantScopeIds,
      );
      nextValues[scopeId] = getScope(scopeId).adapter.read(this._config);

      const nextErrors = this._omitScopeIds(
        this._scopeYamlErrors,
        descendantScopeIds,
      );
      delete nextErrors[scopeId];

      this._scopeModes = nextModes;
      this._scopeYamlValues = nextValues;
      this._scopeYamlErrors = nextErrors;
      this._message = null;
    } catch (error) {
      this._message = {
        kind: "error",
        text: this._formatError(
          error,
          this._t("editor.messages.load_ha_yaml_editor_failed"),
        ),
      };
    }
  }

  private _exitYamlMode(scopeId: ScopeId): void {
    if (!this._isScopeYaml(scopeId) || this._scopeYamlErrors[scopeId]) {
      return;
    }

    const nextModes = { ...this._scopeModes };
    delete nextModes[scopeId];

    const nextValues = { ...this._scopeYamlValues };
    delete nextValues[scopeId];

    const nextErrors = { ...this._scopeYamlErrors };
    delete nextErrors[scopeId];

    this._scopeModes = nextModes;
    this._scopeYamlValues = nextValues;
    this._scopeYamlErrors = nextErrors;
  }

  private _handleYamlValueChanged(
    scopeId: ScopeId,
    event: CustomEvent<YamlEditorValueChangedDetail>,
  ): void {
    event.stopPropagation();

    if (!event.detail.isValid) {
      this._scopeYamlErrors = {
        ...this._scopeYamlErrors,
        [scopeId]: event.detail.errorMsg ?? this._t("editor.yaml.errors.parse_failed"),
      };
      return;
    }

    const normalizedValue = normalizeYamlValue(event.detail.value);
    if (!normalizedValue.ok) {
      this._scopeYamlErrors = {
        ...this._scopeYamlErrors,
        [scopeId]: this._t("editor.yaml.errors.non_json_value"),
      };
      return;
    }

    const adapter = getScope(scopeId).adapter;
    const validationError = adapter.validate(normalizedValue.value);
    if (validationError) {
      this._scopeYamlErrors = {
        ...this._scopeYamlErrors,
        [scopeId]: this._formatScopeYamlValidationError(validationError),
      };
      return;
    }

    try {
      const nextValue = cloneJson(normalizedValue.value);
      this._config = adapter.apply(this._config ?? {}, nextValue);
      this._dirty = true;
      this._validation = null;
      this._message = null;
      this._scopeYamlValues = {
        ...this._scopeYamlValues,
        [scopeId]: nextValue,
      };
      const nextErrors = { ...this._scopeYamlErrors };
      delete nextErrors[scopeId];
      this._scopeYamlErrors = nextErrors;
    } catch (error) {
      this._scopeYamlErrors = {
        ...this._scopeYamlErrors,
        [scopeId]: this._formatError(error, this._t("editor.yaml.errors.apply_failed")),
      };
    }
  }

  private _hasBlockingYamlErrors(): boolean {
    return (
      Object.values(this._scopeYamlErrors).some(
        (error) => typeof error === "string" && error.length > 0,
      ) ||
      Object.values(this._applianceYamlErrors).some(
        (error) => typeof error === "string" && error.length > 0,
      )
    );
  }

  private _hasBlockingDescendantYamlErrors(scopeId: ScopeId): boolean {
    return getDescendantScopeIds(scopeId).some(
      (descendantScopeId) => {
        const error = this._scopeYamlErrors[descendantScopeId];
        return typeof error === "string" && error.length > 0;
      },
    );
  }

  private _resetScopeYamlState(): void {
    this._scopeModes = {};
    this._scopeYamlValues = {};
    this._scopeYamlErrors = {};
    this._applianceModes = {};
    this._applianceYamlValues = {};
    this._applianceYamlErrors = {};
  }

  private _omitScopeIds<T>(
    values: Partial<Record<ScopeId, T>>,
    scopeIds: ScopeId[],
  ): Partial<Record<ScopeId, T>> {
    const nextValues = { ...values };
    for (const scopeIdToDelete of scopeIds) {
      delete nextValues[scopeIdToDelete];
    }
    return nextValues;
  }

  private _getScopeMode(scopeId: ScopeId): EditorMode {
    return this._scopeModes[scopeId] ?? "visual";
  }

  private _isScopeYaml(scopeId: ScopeId): boolean {
    return this._getScopeMode(scopeId) === "yaml";
  }

  private _scopeDomId(scopeId: ScopeId): string {
    return scopeId.replaceAll(":", "-").replaceAll(".", "-");
  }

  private _handleAddDeviceLabelCategory = (): void => {
    const existingKeys = objectEntries(this._getValue(["device_label_text"])).map(
      ([key]) => key,
    );
    const categoryKey = createCategoryKey(existingKeys);
    this._applyMutation((draft) => {
      setValueAtPath(draft, ["device_label_text", categoryKey], {});
    });
  };

  private _handleAddDeviceLabel(categoryKey: string): void {
    const existingKeys = objectEntries(this._getValue(["device_label_text", categoryKey])).map(
      ([key]) => key,
    );
    const labelKey = createLabelKey(existingKeys);
    this._applyMutation((draft) => {
      setValueAtPath(draft, ["device_label_text", categoryKey, labelKey], "");
    });
  }

  private _handleAddDeferrableConsumer = (): void => {
    const count =
      asJsonArray(
        this._getValue(["power_devices", "house", "forecast", "deferrable_consumers"]),
      )?.length ?? 0;
    this._applyMutation((draft) => {
      appendListItem(
        draft,
        ["power_devices", "house", "forecast", "deferrable_consumers"],
        createDeferrableConsumerDraft(
          this._tFormat("editor.dynamic.consumer", { index: count + 1 }),
        ),
      );
    });
  };

  private _handleAddDailyEnergyEntity = (): void => {
    this._applyMutation((draft) => {
      appendListItem(
        draft,
        ["power_devices", "solar", "forecast", "daily_energy_entity_ids"],
        createDailyEnergyEntityDraft(),
      );
    });
  };

  private _handleAddImportPriceWindow = (): void => {
    this._applyMutation((draft) => {
      appendListItem(
        draft,
        ["power_devices", "grid", "forecast", "import_price_windows"],
        createImportPriceWindowDraft(),
      );
    });
  };

  private _handleAddExportPriceOptimizer = (): void => {
    const existingIds = (asJsonArray(this._getValue(["automation", "optimizers"])) ?? [])
      .map((optimizer) => this._stringValue(asJsonObject(optimizer)?.id))
      .filter((value) => value.length > 0);
    this._applyMutation((draft) => {
      const automation = asJsonObject(getValueAtPath(draft, ["automation"]));
      if (!automation) {
        setValueAtPath(draft, ["automation"], {
          enabled: true,
          optimizers: [createExportPriceOptimizerDraft(existingIds)],
        });
        return;
      }

      appendListItem(
        draft,
        ["automation", "optimizers"],
        createExportPriceOptimizerDraft(existingIds),
      );
    });
  };

  private _handleAddSurplusApplianceOptimizer = (): void => {
    const existingIds = (asJsonArray(this._getValue(["automation", "optimizers"])) ?? [])
      .map((optimizer) => this._stringValue(asJsonObject(optimizer)?.id))
      .filter((value) => value.length > 0);
    this._applyMutation((draft) => {
      const automation = asJsonObject(getValueAtPath(draft, ["automation"]));
      if (!automation) {
        setValueAtPath(draft, ["automation"], {
          enabled: true,
          optimizers: [createSurplusApplianceOptimizerDraft(existingIds)],
        });
        return;
      }

      appendListItem(
        draft,
        ["automation", "optimizers"],
        createSurplusApplianceOptimizerDraft(existingIds),
      );
    });
  };

  private _handleSurplusApplianceIdChange(index: number, rawValue: string): void {
    const applianceId = rawValue.trim();
    const paramsPath: PathSegment[] = ["automation", "optimizers", index, "params"];
    this._applyMutation((draft) => {
      setValueAtPath(draft, [...paramsPath, "appliance_id"], applianceId);
      const selectionState = buildSurplusApplianceSelectionState(
        draft,
        this._liveApplianceMetadata,
        applianceId,
      );
      const climateModeFieldState = buildSurplusClimateModeFieldState(
        selectionState,
        this._stringValue(getValueAtPath(draft, [...paramsPath, "climate_mode"])),
      );
      if (!climateModeFieldState.visible || climateModeFieldState.unavailable) {
        unsetValueAtPath(draft, [...paramsPath, "climate_mode"]);
        return;
      }
      setValueAtPath(draft, [...paramsPath, "climate_mode"], climateModeFieldState.value);
    });
  }

  private _handleAddEvCharger = (): void => {
    const existingIds = (asJsonArray(this._getValue(["appliances"])) ?? [])
      .map((appliance) => this._stringValue(asJsonObject(appliance)?.id))
      .filter((value) => value.length > 0);
    this._applyMutation((draft) => {
      appendListItem(
        draft,
        ["appliances"],
        createApplianceDraft(
          existingIds,
          this._tFormat("editor.dynamic.ev_charger", { index: existingIds.length + 1 }),
          this._tFormat("editor.dynamic.vehicle", { index: 1 }),
        ),
      );
    });
  };

  private _handleAddClimateAppliance = (): void => {
    const existingIds = (asJsonArray(this._getValue(["appliances"])) ?? [])
      .map((appliance) => this._stringValue(asJsonObject(appliance)?.id))
      .filter((value) => value.length > 0);
    this._applyMutation((draft) => {
      appendListItem(
        draft,
        ["appliances"],
        createClimateApplianceDraft(
          existingIds,
          this._tFormat("editor.dynamic.climate_appliance", {
            index: existingIds.length + 1,
          }),
        ),
      );
    });
  };

  private _handleAddGenericAppliance = (): void => {
    const existingIds = (asJsonArray(this._getValue(["appliances"])) ?? [])
      .map((appliance) => this._stringValue(asJsonObject(appliance)?.id))
      .filter((value) => value.length > 0);
    this._applyMutation((draft) => {
      appendListItem(
        draft,
        ["appliances"],
        createGenericApplianceDraft(
          existingIds,
          this._tFormat("editor.dynamic.generic_appliance", {
            index: existingIds.length + 1,
          }),
        ),
      );
    });
  };

  private _handleAddVehicle(applianceIndex: number): void {
    const vehiclePath: PathSegment[] = ["appliances", applianceIndex, "vehicles"];
    const existingIds = (asJsonArray(this._getValue(vehiclePath)) ?? [])
      .map((vehicle) => this._stringValue(asJsonObject(vehicle)?.id))
      .filter((value) => value.length > 0);
    this._applyMutation((draft) => {
      appendListItem(
        draft,
        vehiclePath,
        createVehicleDraft(
          existingIds,
          this._tFormat("editor.dynamic.vehicle", { index: existingIds.length + 1 }),
        ),
      );
    });
  }

  private _handleAddUseMode(applianceIndex: number): void {
    const path: PathSegment[] = [
      "appliances",
      applianceIndex,
      "controls",
      "use_mode",
      "values",
    ];
    const modeKey = createModeKey(objectEntries(this._getValue(path)).map(([key]) => key));
    this._applyMutation((draft) => {
      setValueAtPath(draft, [...path, modeKey], createUseModeEntry());
    });
  }

  private _handleAddEcoGear(applianceIndex: number): void {
    const path: PathSegment[] = [
      "appliances",
      applianceIndex,
      "controls",
      "eco_gear",
      "values",
    ];
    const gearKey = createGearKey(objectEntries(this._getValue(path)).map(([key]) => key));
    this._applyMutation((draft) => {
      setValueAtPath(draft, [...path, gearKey], createEcoGearEntry());
    });
  }

  private _handleProjectedApplianceProjectionStrategyChange(
    applianceIndex: number,
    strategy: string,
  ): void {
    if (!["fixed", "history_average"].includes(strategy)) {
      return;
    }

    this._applyMutation((draft) => {
      const basePath: PathSegment[] = ["appliances", applianceIndex, "projection"];
      setValueAtPath(draft, [...basePath, "strategy"], strategy);
      if (strategy !== "history_average") {
        return;
      }

      const existingHistoryAverage = asJsonObject(
        getValueAtPath(draft, [...basePath, "history_average"]),
      );
      const existingLookbackDays = existingHistoryAverage?.lookback_days;
      setValueAtPath(draft, [...basePath, "history_average"], {
        energy_entity_id: this._stringValue(existingHistoryAverage?.energy_entity_id),
        lookback_days:
          typeof existingLookbackDays === "number" && Number.isFinite(existingLookbackDays)
            ? existingLookbackDays
            : 30,
      });
    });
  }

  private _handleRenameObjectKey(
    path: PathSegment[],
    currentKey: string,
    nextKeyRaw: string,
  ): void {
    const nextKey = nextKeyRaw.trim();
    if (!nextKey || nextKey === currentKey || !this._config) {
      return;
    }

    const draft = cloneJson(this._config);
    const result = renameObjectKey(draft, path, currentKey, nextKey);
    if (!result.ok) {
      this._message = { kind: "error", text: this._formatRenameObjectKeyError(result) };
      return;
    }

    this._config = draft;
    this._dirty = true;
    this._validation = null;
    this._message = null;
  }

  private _moveListItem(path: PathSegment[], fromIndex: number, toIndex: number): void {
    this._applyMutation((draft) => {
      moveListItem(draft, path, fromIndex, toIndex);
    });
  }

  private _removeListItem(path: PathSegment[], index: number): void {
    this._applyMutation((draft) => {
      removeListItem(draft, path, index);
    });
  }

  private _removePath(path: PathSegment[]): void {
    this._applyMutation((draft) => {
      unsetValueAtPath(draft, path);
    });
  }

  private _setOptionalString(path: PathSegment[], rawValue: string): void {
    const nextValue = rawValue.trim();
    this._applyMutation((draft) => {
      if (!nextValue) {
        unsetValueAtPath(draft, path);
        return;
      }
      setValueAtPath(draft, path, nextValue);
    });
  }

  private _setRequiredString(path: PathSegment[], rawValue: string): void {
    this._applyMutation((draft) => {
      setValueAtPath(draft, path, rawValue.trim());
    });
  }

  private _setOptionalNumber(path: PathSegment[], rawValue: string): void {
    const normalized = rawValue.trim();
    this._applyMutation((draft) => {
      if (!normalized) {
        unsetValueAtPath(draft, path);
        return;
      }
      const numericValue = Number(normalized);
      setValueAtPath(draft, path, Number.isFinite(numericValue) ? numericValue : normalized);
    });
  }

  private _setRequiredNumber(path: PathSegment[], rawValue: string): void {
    const normalized = rawValue.trim();
    this._applyMutation((draft) => {
      if (!normalized) {
        setValueAtPath(draft, path, null);
        return;
      }
      const numericValue = Number(normalized);
      setValueAtPath(draft, path, Number.isFinite(numericValue) ? numericValue : normalized);
    });
  }

  private _getAutomationEnabled(): boolean {
    const automation = asJsonObject(this._getValue(["automation"]));
    if (!automation) {
      return false;
    }

    return this._booleanValue(automation["enabled"], true);
  }

  private _setAutomationEnabled(enabled: boolean): void {
    if (!enabled && this._getValue(["automation"]) === undefined) {
      return;
    }

    this._applyMutation((draft) => {
      const automation = getValueAtPath(draft, ["automation"]);
      const automationObject = asJsonObject(automation);

      if (automationObject) {
        setValueAtPath(draft, ["automation", "enabled"], enabled);
        if (!Array.isArray(automationObject["optimizers"])) {
          setValueAtPath(draft, ["automation", "optimizers"], []);
        }
        return;
      }

      setValueAtPath(draft, ["automation"], {
        enabled,
        optimizers: [],
      });
    });
  }

  private _setBoolean(path: PathSegment[], value: boolean): void {
    this._applyMutation((draft) => {
      setValueAtPath(draft, path, value);
    });
  }

  private _normalizeSurplusApplianceOptimizerParams(config: JsonObject): boolean {
    const optimizers = asJsonArray(getValueAtPath(config, ["automation", "optimizers"])) ?? [];
    let changed = false;
    optimizers.forEach((optimizer, index) => {
      const optimizerObject = asJsonObject(optimizer);
      if (!optimizerObject || this._stringValue(optimizerObject.kind) !== SURPLUS_APPLIANCE_OPTIMIZER_KIND) {
        return;
      }

      const paramsPath: PathSegment[] = ["automation", "optimizers", index, "params"];
      const applianceId = this._stringValue(getValueAtPath(config, [...paramsPath, "appliance_id"]));
      const currentClimateMode = this._stringValue(
        getValueAtPath(config, [...paramsPath, "climate_mode"]),
      );
      const selectionState = buildSurplusApplianceSelectionState(
        config,
        this._liveApplianceMetadata,
        applianceId,
      );
      const climateModeFieldState = buildSurplusClimateModeFieldState(
        selectionState,
        currentClimateMode,
      );

      if (selectionState.selectedOption?.kind === "generic" && currentClimateMode.length > 0) {
        unsetValueAtPath(config, [...paramsPath, "climate_mode"]);
        changed = true;
        return;
      }
      if (
        climateModeFieldState.visible &&
        !climateModeFieldState.unavailable &&
        currentClimateMode.length === 0 &&
        climateModeFieldState.value.length > 0
      ) {
        setValueAtPath(config, [...paramsPath, "climate_mode"], climateModeFieldState.value);
        changed = true;
      }
    });
    return changed;
  }

  private _applyMutation(mutator: (draft: JsonObject) => void): void {
    const draft = cloneJson(this._config ?? {});
    mutator(draft);
    this._config = draft;
    this._dirty = true;
    this._validation = null;
    this._message = null;
  }

  private _getValue(path: PathSegment[]): unknown {
    if (!this._config) {
      return undefined;
    }
    return getValueAtPath(this._config, path);
  }

  private _stringValue(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number") {
      return String(value);
    }
    return "";
  }

  private _renderSurplusApplianceActionField(action: string): TemplateResult {
    return html`
      <div class="field">
        <div class="field-label-row">
          <label>${this._t("editor.fields.optimizer_action")}</label>
          ${this._renderHelpIcon(
            "editor.fields.optimizer_action",
            "editor.help.surplus_appliance_action",
          )}
        </div>
        <input .value=${action} disabled />
        <div class="helper">${this._t("editor.helpers.surplus_appliance_action")}</div>
      </div>
    `;
  }

  private _renderSurplusClimateModeField(
    paramsPath: PathSegment[],
    climateModeFieldState: SurplusClimateModeFieldState,
  ): TemplateResult {
    const selectedValue =
      climateModeFieldState.value.length > 0
        ? climateModeFieldState.value
        : "__live_modes_unavailable__";
    return html`
      <div class="field">
        <div class="field-label-row">
          <label>${this._t("editor.fields.climate_mode")}</label>
          ${this._renderHelpIcon(
            "editor.fields.climate_mode",
            "editor.help.surplus_appliance_climate_mode",
          )}
        </div>
        <select
          .value=${selectedValue}
          ?disabled=${climateModeFieldState.disabled}
          @change=${(event: Event) =>
            this._setRequiredString(
              [...paramsPath, "climate_mode"],
              (event.currentTarget as HTMLSelectElement).value,
            )}
        >
          ${climateModeFieldState.options.length > 0
            ? climateModeFieldState.options.map(
                (option) => html`
                  <option value=${option.value}>
                    ${this._formatSurplusClimateModeLabel(option.value, option.isUnknown)}
                  </option>
                `,
              )
            : html`
                <option value="__live_modes_unavailable__">
                  ${this._t("editor.values.live_modes_unavailable")}
                </option>
              `}
        </select>
        <div class="helper">
          ${this._renderSurplusClimateModeHelper(climateModeFieldState)}
        </div>
      </div>
    `;
  }

  private _renderSurplusApplianceIdHelper(
    selectionState: SurplusApplianceSelectionState,
  ): string {
    if (selectionState.selectedMissingFromDraft && selectionState.selectedId.length > 0) {
      return this._t("editor.helpers.surplus_appliance_id_missing_from_draft");
    }
    if (selectionState.options.some((option) => option.selectionDisabled)) {
      return this._t("editor.helpers.surplus_appliance_id_pending_reload");
    }
    return this._t("editor.helpers.surplus_appliance_id");
  }

  private _renderSurplusClimateModeHelper(
    climateModeFieldState: SurplusClimateModeFieldState,
  ): string {
    if (climateModeFieldState.unavailable) {
      return this._t("editor.helpers.surplus_appliance_climate_mode_unavailable");
    }
    if (climateModeFieldState.options.some((option) => option.isUnknown)) {
      return this._t("editor.helpers.surplus_appliance_climate_mode_unknown");
    }
    if (climateModeFieldState.disabled) {
      return this._t("editor.helpers.surplus_appliance_climate_mode_single");
    }
    return this._t("editor.helpers.surplus_appliance_climate_mode");
  }

  private _formatSurplusApplianceOptionLabel(option: SurplusApplianceOption): string {
    const baseLabel =
      option.name === option.id
        ? option.id
        : this._tFormat("editor.dynamic.appliance_option", {
            name: option.name,
            id: option.id,
          });
    if (!option.selectionDisabled) {
      return baseLabel;
    }
    return this._tFormat("editor.dynamic.appliance_option_pending_reload", {
      label: baseLabel,
    });
  }

  private _formatSurplusClimateModeLabel(mode: string, isUnknown: boolean): string {
    if (isUnknown) {
      return this._tFormat("editor.dynamic.stale_climate_mode", { mode });
    }
    return this._t(`editor.values.${mode}`);
  }

  private async _loadLiveApplianceMetadata(): Promise<ApplianceMetadataResponse | null> {
    if (!this.hass) {
      return null;
    }
    try {
      const response = await this.hass.callWS<ApplianceMetadataResponse>({
        type: "helman/get_appliances",
      });
      return Array.isArray(response?.appliances) ? response : { appliances: [] };
    } catch {
      return null;
    }
  }

  private _booleanValue(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
  }

  private _t(key: string): string {
    return (this._localize ?? this._fallbackLocalize)(key);
  }

  private _tFormat(key: string, values: Record<string, string | number>): string {
    let text = this._t(key);
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  }

  private _formatScopeYamlValidationError(
    error: ScopeAdapterValidationError,
  ): string {
    switch (error.code) {
      case "expected_object":
        return this._t("editor.yaml.errors.expected_object");
      case "expected_array":
        return this._t("editor.yaml.errors.expected_array");
      case "unexpected_key":
        return this._tFormat("editor.yaml.errors.unexpected_key", {
          key: error.key ?? "",
        });
    }
  }

  private _formatRenameObjectKeyError(
    result: Exclude<RenameObjectKeyResult, { ok: true }>,
  ): string {
    switch (result.reason) {
      case "target_not_available":
        return this._t("editor.rename.target_not_available");
      case "empty_key":
        return this._t("editor.rename.key_empty");
      case "duplicate_key":
        return this._tFormat("editor.rename.key_exists", {
          key: result.key ?? "",
        });
      case "missing_key":
        return this._tFormat("editor.rename.key_missing", {
          key: result.key ?? "",
        });
    }
  }

  private _formatError(error: unknown, fallback: string): string {
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message) {
        return message;
      }
    }
    return fallback;
  }
}
