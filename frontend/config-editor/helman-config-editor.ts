import { LitElement, css, html, nothing } from "lit";
import type { PropertyValues, TemplateResult } from "lit";
import { cache } from "lit/directives/cache.js";

/**
 * Which sign a power sensor uses to carry its quantity, per power device.
 *
 * Mirrors ``POWER_POLARITY_OPTIONS`` in ``custom_components/helman/power_polarity.py``
 * -- that module is the authority, and the backend rejects anything not in its
 * table, so the two must be changed together. First entry of each pair is the
 * default and reproduces the convention Helman hard-coded before the setting
 * existed.
 */
const POWER_POLARITY_OPTIONS = {
  solar: ["positive_is_production", "negative_is_production"],
  house: ["positive_is_consumption", "negative_is_consumption"],
  battery: ["positive_is_charging", "positive_is_discharging"],
  grid: ["positive_is_export", "positive_is_import"],
} as const satisfies Record<string, readonly [string, string]>;

type PowerPolarityDevice = keyof typeof POWER_POLARITY_OPTIONS;

/**
 * Shown when the locale has no string for an option -- never the raw enum value.
 *
 * Each option is a complete statement of the convention, not a bare noun. The
 * field asks which sign convention the sensor follows, so an option has to say
 * *which* sign carries the quantity: "Consumption" alone reads as an assertion
 * that the value is positive, which is exactly what half of these deny.
 */
const POWER_POLARITY_FALLBACK_LABELS: Record<string, string> = {
  positive_is_production: "Positive = production",
  negative_is_production: "Negative = production",
  positive_is_consumption: "Positive = consumption",
  negative_is_consumption: "Negative = consumption",
  positive_is_charging: "Positive = charging",
  positive_is_discharging: "Positive = discharging",
  positive_is_export: "Positive = export (to the grid)",
  positive_is_import: "Positive = import (from the grid)",
};

import {
  appendListItem,
  asJsonArray,
  asJsonObject,
  cloneJson,
  createApplianceDraft,
  createClimateApplianceDraft,
  createInverterControllableDraft,
  createGenericApplianceDraft,
  createCategoryKey,
  createDailyEnergyEntityDraft,
  createOptimizerDraft,
  createEcoGearEntry,
  createGearKey,
  createImportPriceWindowDraft,
  createLabelKey,
  createModeKey,
  type RenameObjectKeyResult,
  createUseModeEntry,
  canonicalJson,
  createVehicleDraft,
  getValueAtPath,
  moveListItem,
  objectEntries,
  removeListItem,
  renameObjectKey,
  setValueAtPath,
  unsetValueAtPath,
} from "../cards/shared/config/config-document";
import {
  buildControllableSelectionState,
  buildClimateModeFieldState,
} from "../cards/shared/optimizer/controllable-target-ui";
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
import { getSharedDataChangedFeed } from "../cards/helman/data-changed";
import { getLocalizeFunction, type LocalizeFunction } from "../cards/shared/config/localize/localize";
import {
  fetchOptimizerSchema,
  type OptimizerSchema,
  type OptimizerSchemaDocument,
} from "../cards/shared/optimizer/optimizer-schema";
import { loadHaForm, loadHaYamlEditor } from "./load-ha-elements";
import { configFormStyles } from "../cards/shared/config/form-styles";
import {
  booleanValue,
  renderHelpDialog,
  renderHelpIcon,
  renderOptionalNumberField,
  renderOptionalSelectField,
  renderSelectFieldWithDefault,
  renderRequiredNumberField,
  renderRequiredTextField,
  renderSvgIcon,
  setOptionalNumber,
  setOptionalString,
  setRequiredNumber,
  setRequiredString,
  stringValue,
  type FormFieldHost,
} from "../cards/shared/config/form-fields";
import { optimizerCardStyles } from "../cards/shared/optimizer/optimizer-styles";
import type { OptimizerConfigChangedDetail } from "../cards/shared/optimizer/helman-optimizer-editor";
import "../cards/shared/optimizer/helman-optimizer-editor";
import "./bias-correction-status";
import "./entity-group";
import {
  ENTITY_GROUP_CONNECTED,
  ENTITY_GROUP_DISCONNECTED,
  ENTITY_GROUP_REVERT,
  entityGroupKey,
  type EntityGroupRegistrationDetail,
  type EntityGroupRevertDetail,
  type EntityInspectionResult,
} from "./entity-group";
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
} from "../cards/shared/config/types";
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

const APPLIANCE_RUNTIME_OPTIMIZER_KIND = "appliance_runtime";
const INVERTER_CONTROLLABLE_KIND = "inverter";

/**
 * The schedule actions an inverter's `controls.mode.options` maps, in the order
 * the card lays them out. Mirrors `CONTROLLABLE_SPECS["inverter"]` in Python:
 * the backend owns the list, this is the editor's copy of it.
 */
const INVERTER_ACTION_OPTIONS = [
  { key: "normal", labelKey: "editor.fields.normal_option" },
  { key: "charge_to_target_soc", labelKey: "editor.fields.charge_to_target_soc_option" },
  {
    key: "discharge_to_target_soc",
    labelKey: "editor.fields.discharge_to_target_soc_option",
  },
  { key: "stop_charging", labelKey: "editor.fields.stop_charging_option" },
  { key: "stop_discharging", labelKey: "editor.fields.stop_discharging_option" },
  { key: "stop_export", labelKey: "editor.fields.stop_export_option" },
] as const;
const DAY_CLASSIFICATIONS = ["surplus", "tight", "deficit"] as const;

/**
 * How often the editor asks what its picked entities currently read.
 *
 * A poll rather than a state subscription: the reading is a hint the reader
 * glances at while configuring, not a live dashboard, and a couple of seconds
 * of lag costs nothing. Subscribing would mean tracking which entities the
 * draft names as it is edited -- and *which* entities a path resolves to is
 * knowledge this editor deliberately does not have.
 */
const ENTITY_INSPECTION_INTERVAL_MS = 2000;

const APPLIANCE_ICON_SELECTOR = {
  icon: {},
} as const;

// DUMMY: reuse Home Assistant's visual condition builder. Value is not persisted
// yet — this only proves the editor renders and round-trips inside our panel.
const OPTIMIZER_CONDITION_SELECTOR = {
  condition: {},
} as const;

interface YamlEditorValueChangedDetail {
  value: unknown;
  isValid: boolean;
  errorMsg?: string;
}

export class HelmanConfigEditorPanel
  extends LitElement
  implements FormFieldHost
{
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
    _staleConfigNotice: { state: true },
    _hasLoadedOnce: { state: true },
    _scopeModes: { state: true },
    _scopeYamlValues: { state: true },
    _scopeYamlErrors: { state: true },
    _controllableModes: { state: true },
    _controllableYamlValues: { state: true },
    _controllableYamlErrors: { state: true },
    _liveApplianceMetadata: { state: true },
    _optimizerSchema: { state: true },
    _helpDialog: { state: true },
    _entityInspections: { state: true },
  };

  static styles = [
    configFormStyles,
    optimizerCardStyles,
    css`
    :host {
      display: block;
      min-height: 100%;
      background: var(--primary-background-color);
      color: var(--primary-text-color);
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

    .tab-icon {
      flex-shrink: 0;
      width: 16px;
      height: 16px;
      fill: currentColor;
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

    .list-stack {
      display: grid;
      gap: 14px;
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      margin-bottom: 14px;
    }

    .inline-note {
      color: var(--secondary-text-color);
      font-size: 0.9rem;
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
  `,
  ];

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
  /**
   * The stored config moved while a draft was open, and we refused to reload.
   *
   * A dirty editor sitting silently on a superseded document is the failure
   * this whole feature could easily create, so the refusal has to be visible.
   */
  private _staleConfigNotice = false;
  private _unsubscribeDataChanged?: () => void;
  /**
   * Swallow the announcement our own save caused.
   *
   * A successful save reloads the config entry, which fires the event — so the
   * machine that just saved hears about its own write. It has already refreshed
   * everything that write touched, and re-reading would be pure noise.
   */
  /**
   * The stored document as it was when this editor last agreed with it, as one
   * canonical string.
   *
   * `helman_data_changed` says something moved; it never says what or who. One
   * `save_config` fires several of them -- the entry reload it starts re-plans,
   * and those announcements land well after the feed's collapse window closes
   * on the first -- so a flag that skipped "the next one" recognised its own
   * write once and read the rest as somebody else's. This is what the question
   * actually needs: the document itself, to compare against.
   */
  private _configBaseline: string | null = null;

  /** A comparison in flight, so an announcement burst costs one read. */
  private _baselineCheck: Promise<void> | null = null;
  private _hasLoadedOnce = false;
  private _scopeModes: Partial<Record<ScopeId, EditorMode>> = {};
  private _scopeYamlValues: Partial<Record<ScopeId, JsonValue>> = {};
  private _scopeYamlErrors: Partial<Record<ScopeId, string>> = {};
  private _controllableModes: Partial<Record<number, EditorMode>> = {};
  private _controllableYamlValues: Partial<Record<number, JsonValue>> = {};
  private _controllableYamlErrors: Partial<Record<number, string>> = {};
  private _liveApplianceMetadata: ApplianceMetadataResponse | null = null;
  // Optimizer schema, served by the backend. Fetched alongside the config
  // the editor already awaits on open, so it costs no extra latency.
  private _optimizerSchema: OptimizerSchemaDocument | null = null;
  // The condition group whose name is being renamed inline. One slot, not a
  // per-group flag: only one name can be under edit at a time.
  private _helpDialog: { labelKey: string; contentKey: string } | null = null;
  private _configFragmentRequested = false;

  // --- Entity inspection ---------------------------------------------------
  //
  // One owner for the whole editor. Every mounted `helman-entity-group`
  // announces its config path here, and one `helman/inspect_entities` call per
  // tick answers for all of them; the appliances tab alone will hold twenty
  // groups, and a call per group would be twenty round trips every two seconds
  // for readings that all come out of the same document.
  //
  // The draft document is sent whole on every tick. It is a few KB over a local
  // socket, and any scheme for sending only what changed would be more code
  // than it saves.

  /** The stored document, as read. What a revert restores from. */
  private _savedConfig: JsonObject | null = null;
  /** The last answer, keyed by group. Groups read their own row from here. */
  private _entityInspections: Record<string, EntityInspectionResult> = {};
  /** Which groups are on screen right now — a collapsed section renders none. */
  private readonly _mountedGroups = new Map<string, PathSegment[]>();
  private _inspectionTimer?: ReturnType<typeof setInterval>;
  private _inspectionPending?: ReturnType<typeof setTimeout>;
  /** One request at a time: a slow tick must not queue behind itself. */
  private _inspectionInFlight = false;

  get hass(): HomeAssistantLike | undefined {
    return this._hass;
  }

  set hass(hass: HomeAssistantLike | undefined) {
    const oldValue = this._hass;
    this._hass = hass;
    if (hass && !this._localize) {
      this._localize = getLocalizeFunction(hass);
    }
    // Reused HA components (e.g. the condition builder) localize via
    // hass.localize, but the "config" fragment is only lazy-loaded on the
    // config panel. Request it once so their labels aren't blank here.
    if (
      hass &&
      !this._configFragmentRequested &&
      typeof hass.loadFragmentTranslation === "function"
    ) {
      this._configFragmentRequested = true;
      void hass.loadFragmentTranslation("config").then(() => this.requestUpdate());
    }
    this.requestUpdate("hass", oldValue);
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener(ENTITY_GROUP_CONNECTED, this._handleEntityGroupConnected);
    this.addEventListener(ENTITY_GROUP_DISCONNECTED, this._handleEntityGroupDisconnected);
    this.addEventListener(ENTITY_GROUP_REVERT, this._handleEntityGroupRevert);
    this._inspectionTimer = setInterval(
      () => void this._pollEntityInspections(),
      ENTITY_INSPECTION_INTERVAL_MS,
    );
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

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsubscribeDataChanged?.();
    this._unsubscribeDataChanged = undefined;
    this.removeEventListener(ENTITY_GROUP_CONNECTED, this._handleEntityGroupConnected);
    this.removeEventListener(ENTITY_GROUP_DISCONNECTED, this._handleEntityGroupDisconnected);
    this.removeEventListener(ENTITY_GROUP_REVERT, this._handleEntityGroupRevert);
    if (this._inspectionTimer !== undefined) {
      clearInterval(this._inspectionTimer);
      this._inspectionTimer = undefined;
    }
    if (this._inspectionPending !== undefined) {
      clearTimeout(this._inspectionPending);
      this._inspectionPending = undefined;
    }
    this._mountedGroups.clear();
  }

  protected updated(changedProperties: PropertyValues<this>): void {
    super.updated(changedProperties);
    if (!this._hasLoadedOnce && this.hass) {
      this._hasLoadedOnce = true;
      void this._loadConfig({ showMessage: false });
    }
    if (this.hass && !this._unsubscribeDataChanged) {
      this._unsubscribeDataChanged = getSharedDataChangedFeed(this.hass).subscribe(
        () => this._handleDataChanged(),
      );
    }
  }

  /**
   * The stored config moved somewhere else. Whether we act on it depends
   * entirely on whether there is a draft to lose.
   *
   * The reload button already refuses a dirty reload without a `window.confirm`
   * (see `_handleReloadClick`). This has no user gesture to hang a confirm on,
   * so it is strictly more conservative: it never prompts and never discards.
   */
  private _handleDataChanged(): void {
    void this._reactToDataChanged();
  }

  /**
   * Look before acting: an announcement is a hint, the document is the answer.
   *
   * A re-read that comes back equal to the baseline means nothing this editor
   * cares about moved -- our own save, or a re-plan, or a retrained bias
   * profile -- and the right response is to do nothing at all rather than
   * reload the page under the user or accuse them of a collision with
   * themselves. A failed re-read is also nothing: a dropped frame is not
   * evidence that anybody wrote.
   */
  private async _reactToDataChanged(): Promise<void> {
    if (this._saving || this._loading || this._baselineCheck !== null) {
      return this._baselineCheck ?? undefined;
    }

    this._baselineCheck = (async () => {
      try {
        if (!(await this._configMovedFromBaseline())) {
          return;
        }
        if (this._dirty || this._hasBlockingYamlErrors()) {
          this._staleConfigNotice = true;
          return;
        }
        await this._loadConfig({ showMessage: false });
      } finally {
        this._baselineCheck = null;
      }
    })();

    return this._baselineCheck;
  }

  /** Whether the stored document differs from the one this editor agreed with. */
  private async _configMovedFromBaseline(): Promise<boolean> {
    if (!this.hass || this._configBaseline === null) {
      return false;
    }
    try {
      const current = asJsonObject(
        await this.hass.callWS<unknown>({ type: "helman/get_config" }),
      );
      return current !== undefined && canonicalJson(current) !== this._configBaseline;
    } catch {
      return false;
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
          ${this._staleConfigNotice
            ? html`<span class="badge info">${this._t("editor.status.changed_elsewhere")}</span>`
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
      case "automation":
        return this._renderTabScope(
          TAB_SCOPE_IDS.automation,
          this._renderAutomationTab(),
        );
      case "controllables":
        return this._renderTabScope(
          TAB_SCOPE_IDS.controllables,
          this._renderControllablesTab(),
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
    return renderSvgIcon(path, className);
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

  private _getControllableMode(index: number): EditorMode {
    return this._controllableModes[index] ?? "visual";
  }

  private _renderControllableModeToggle(index: number): TemplateResult {
    const mode = this._getControllableMode(index);
    return html`
      <div class="mode-toggle">
        <button
          type="button"
          class=${mode === "visual" ? "active" : ""}
          aria-pressed=${mode === "visual"}
          @click=${(event: Event) => this._handleControllableModeChange(index, "visual", event)}
        >
          ${this._t("editor.mode.visual")}
        </button>
        <button
          type="button"
          class=${mode === "yaml" ? "active" : ""}
          aria-pressed=${mode === "yaml"}
          @click=${(event: Event) => this._handleControllableModeChange(index, "yaml", event)}
        >
          ${this._t("editor.mode.yaml")}
        </button>
      </div>
    `;
  }

  private _handleControllableModeChange(index: number, mode: EditorMode, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (mode === "yaml") {
      void this._enterControllableYamlMode(index);
    } else {
      this._exitControllableYamlMode(index);
    }
  }

  private async _enterControllableYamlMode(index: number): Promise<void> {
    if (this._getControllableMode(index) === "yaml") return;
    try {
      await loadHaYamlEditor();
      if (!this._config) return;
      const value = this._getValue(["controllables", index]) as JsonValue;
      this._controllableModes = { ...this._controllableModes, [index]: "yaml" };
      this._controllableYamlValues = { ...this._controllableYamlValues, [index]: value };
      const nextErrors = { ...this._controllableYamlErrors };
      delete nextErrors[index];
      this._controllableYamlErrors = nextErrors;
      this._message = null;
    } catch (error) {
      this._message = {
        kind: "error",
        text: this._formatError(error, this._t("editor.messages.load_ha_yaml_editor_failed")),
      };
    }
  }

  private _exitControllableYamlMode(index: number): void {
    if (this._getControllableMode(index) !== "yaml" || this._controllableYamlErrors[index]) return;
    const nextModes = { ...this._controllableModes };
    delete nextModes[index];
    const nextValues = { ...this._controllableYamlValues };
    delete nextValues[index];
    const nextErrors = { ...this._controllableYamlErrors };
    delete nextErrors[index];
    this._controllableModes = nextModes;
    this._controllableYamlValues = nextValues;
    this._controllableYamlErrors = nextErrors;
  }

  private _handleControllableYamlChanged(
    index: number,
    event: CustomEvent<YamlEditorValueChangedDetail>,
  ): void {
    event.stopPropagation();
    if (!event.detail.isValid) {
      this._controllableYamlErrors = {
        ...this._controllableYamlErrors,
        [index]: event.detail.errorMsg ?? this._t("editor.yaml.errors.parse_failed"),
      };
      return;
    }
    const normalizedValue = normalizeYamlValue(event.detail.value);
    if (!normalizedValue.ok) {
      this._controllableYamlErrors = {
        ...this._controllableYamlErrors,
        [index]: this._t("editor.yaml.errors.non_json_value"),
      };
      return;
    }
    if (!Array.isArray(normalizedValue.value) && typeof normalizedValue.value !== "object") {
      this._controllableYamlErrors = {
        ...this._controllableYamlErrors,
        [index]: this._t("editor.yaml.errors.non_json_value"),
      };
      return;
    }
    try {
      const nextConfig = cloneJson(this._config ?? {});
      setValueAtPath(nextConfig, ["controllables", index], cloneJson(normalizedValue.value));
      this._config = nextConfig as JsonObject;
      this._dirty = true;
      this._validation = null;
      this._message = null;
      this._controllableYamlValues = { ...this._controllableYamlValues, [index]: normalizedValue.value };
      const nextErrors = { ...this._controllableYamlErrors };
      delete nextErrors[index];
      this._controllableYamlErrors = nextErrors;
    } catch (error) {
      this._controllableYamlErrors = {
        ...this._controllableYamlErrors,
        [index]: this._formatError(error, this._t("editor.yaml.errors.apply_failed")),
      };
    }
  }

  private _renderControllableYamlEditor(index: number): TemplateResult {
    const error = this._controllableYamlErrors[index];
    const editorId = `controllable-${index}`;
    const helperId = `${editorId}-yaml-helper`;
    const errorId = `${editorId}-yaml-error`;
    const describedBy = error ? `${helperId} ${errorId}` : helperId;
    const editorValue = this._controllableYamlValues[index] ?? this._getValue(["controllables", index]);
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
              this._handleControllableYamlChanged(index, event)}
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
            ${this._renderOptionalTextField(
              ["training_time"],
              "editor.fields.training_time",
              "editor.helpers.training_time",
              "editor.help.training_time",
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
    const importPriceWindows =
      asJsonArray(this._getValue(["power_devices", "grid", "forecast", "import_price_windows"])) ?? [];

    return html`
      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.power_devices.house,
        html`
          <div class="field-grid">
            ${this._renderPowerEntityGroup(
              "house",
              "editor.fields.house_power_entity",
              "editor.help.house_power_entity",
              true,
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
        `,
        { initialOpen: false },
      )}

      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.power_devices.solar,
        html`
          ${this._renderSectionScope(
            SECTION_SCOPE_IDS.power_devices.solar_general,
            html`
              <div class="field-grid field-grid--roomy">
                ${this._renderPowerEntityGroup(
                  "solar",
                  "editor.fields.power_entity",
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
              </div>
            `,
            { initialOpen: false },
          )}

          ${this._renderSectionScope(
            SECTION_SCOPE_IDS.power_devices.solar_forecast,
            html`
              ${this._renderSectionScope(
                SECTION_SCOPE_IDS.power_devices.solar_forecast_general,
                html`
                  <div class="field-grid field-grid--roomy">
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
                SECTION_SCOPE_IDS.power_devices.solar_bias_correction,
                html`
                  ${this._renderSectionScope(
                    SECTION_SCOPE_IDS.power_devices.solar_bias_correction_config,
                    html`
                      <div class="field-grid">
                        ${this._renderBooleanField(
                          ["power_devices", "solar", "forecast", "bias_correction", "enabled"],
                          "editor.fields.bias_correction_enabled",
                          false,
                        )}
                        ${this._renderOptionalNumberField(
                          ["power_devices", "solar", "forecast", "bias_correction", "min_history_days"],
                          "editor.fields.bias_correction_min_history_days",
                          "editor.helpers.bias_correction_min_history_days",
                          "editor.help.bias_correction_min_history_days",
                        )}
                        ${this._renderOptionalNumberField(
                          ["power_devices", "solar", "forecast", "bias_correction", "max_training_window_days"],
                          "editor.fields.max_training_window_days",
                          "editor.helpers.bias_correction_max_training_window_days",
                          "editor.help.bias_correction_max_training_window_days",
                        )}
                        ${this._renderOptionalNumberField(
                          ["power_devices", "solar", "forecast", "bias_correction", "min_valid_slot_days"],
                          "editor.fields.bias_correction_min_valid_slot_days",
                          "editor.helpers.bias_correction_min_valid_slot_days",
                          "editor.help.bias_correction_min_valid_slot_days",
                        )}
                        ${this._renderOptionalNumberField(
                          ["power_devices", "solar", "forecast", "bias_correction", "clamp_min"],
                          "editor.fields.bias_correction_clamp_min",
                          undefined,
                          "editor.help.bias_correction_clamp_min",
                        )}
                        ${this._renderOptionalNumberField(
                          ["power_devices", "solar", "forecast", "bias_correction", "clamp_max"],
                          "editor.fields.bias_correction_clamp_max",
                          undefined,
                          "editor.help.bias_correction_clamp_max",
                        )}
                        ${this._renderOptionalSelectField(
                          ["power_devices", "solar", "forecast", "bias_correction", "aggregation_method"],
                          "editor.fields.bias_correction_aggregation_method",
                          [
                            { value: "ratio_of_sums", label: this._optionLabel("editor.fields.bias_correction_aggregation_method_ratio_of_sums", "Ratio of Sums") },
                            { value: "trimmed_mean", label: this._optionLabel("editor.fields.bias_correction_aggregation_method_trimmed_mean", "Trimmed Mean") }
                          ],
                          "editor.help.bias_correction_aggregation_method",
                        )}
                        ${this._renderOptionalNumberField(
                          ["power_devices", "solar", "forecast", "bias_correction", "max_interpolated_consecutive_slots"],
                          "editor.fields.bias_correction_max_interpolated_consecutive_slots",
                          "editor.helpers.bias_correction_max_interpolated_consecutive_slots",
                          "editor.help.bias_correction_max_interpolated_consecutive_slots",
                        )}
                        ${this._renderOptionalEntityField(
                          ["power_devices", "solar", "forecast", "bias_correction", "total_energy_entity_id"],
                          "editor.fields.bias_correction_total_energy_entity",
                          ["sensor"],
                          undefined,
                          "editor.help.bias_correction_total_energy_entity",
                        )}
                      </div>

                      ${this._renderSectionScope(
                        SECTION_SCOPE_IDS.power_devices.slot_invalidation,
                        html`
                          <div class="field-grid">
                            ${this._renderOptionalNumberField(
                              [
                                "power_devices",
                                "solar",
                                "forecast",
                                "bias_correction",
                                "slot_invalidation",
                                "max_battery_soc_percent",
                              ],
                              "editor.fields.bias_correction_slot_invalidation_max_battery_soc_percent",
                              "editor.helpers.bias_correction_slot_invalidation_max_battery_soc_percent",
                              "editor.help.bias_correction_slot_invalidation_max_battery_soc_percent",
                              { min: 0, max: 100, suffix: "%" },
                            )}
                            ${this._renderOptionalNumberField(
                              [
                                "power_devices",
                                "solar",
                                "forecast",
                                "bias_correction",
                                "slot_invalidation",
                                "curtailment_max_export_w",
                              ],
                              "editor.fields.bias_correction_slot_invalidation_curtailment_max_export_w",
                              "editor.helpers.bias_correction_slot_invalidation_curtailment_max_export_w",
                              "editor.help.bias_correction_slot_invalidation_curtailment_max_export_w",
                              { min: 0, suffix: "W" },
                            )}
                            ${this._renderOptionalNumberField(
                              [
                                "power_devices",
                                "solar",
                                "forecast",
                                "bias_correction",
                                "slot_invalidation",
                                "curtailment_max_actual_forecast_ratio",
                              ],
                              "editor.fields.bias_correction_slot_invalidation_curtailment_max_actual_forecast_ratio",
                              "editor.helpers.bias_correction_slot_invalidation_curtailment_max_actual_forecast_ratio",
                              "editor.help.bias_correction_slot_invalidation_curtailment_max_actual_forecast_ratio",
                              { min: 0, max: 1 },
                            )}
                            ${this._renderOptionalNumberField(
                              [
                                "power_devices",
                                "solar",
                                "forecast",
                                "bias_correction",
                                "slot_invalidation",
                                "data_glitch_max_slot_wh",
                              ],
                              "editor.fields.bias_correction_slot_invalidation_data_glitch_max_slot_wh",
                              "editor.helpers.bias_correction_slot_invalidation_data_glitch_max_slot_wh",
                              "editor.help.bias_correction_slot_invalidation_data_glitch_max_slot_wh",
                              { min: 0, suffix: "Wh" },
                            )}
                            ${this._renderOptionalNumberField(
                              [
                                "power_devices",
                                "solar",
                                "forecast",
                                "bias_correction",
                                "slot_invalidation",
                                "data_glitch_min_neighbour_forecast_wh",
                              ],
                              "editor.fields.bias_correction_slot_invalidation_data_glitch_min_neighbour_forecast_wh",
                              "editor.helpers.bias_correction_slot_invalidation_data_glitch_min_neighbour_forecast_wh",
                              "editor.help.bias_correction_slot_invalidation_data_glitch_min_neighbour_forecast_wh",
                              { min: 0, suffix: "Wh" },
                            )}
                            ${this._renderOptionalNumberField(
                              [
                                "power_devices",
                                "solar",
                                "forecast",
                                "bias_correction",
                                "slot_invalidation",
                                "data_glitch_backfill_max_minutes",
                              ],
                              "editor.fields.bias_correction_slot_invalidation_data_glitch_backfill_max_minutes",
                              "editor.helpers.bias_correction_slot_invalidation_data_glitch_backfill_max_minutes",
                              "editor.help.bias_correction_slot_invalidation_data_glitch_backfill_max_minutes",
                              { min: 0, suffix: "min" },
                            )}
                          </div>
                        `,
                        { initialOpen: false },
                      )}
                    `,
                    { initialOpen: false },
                  )}

                  <div class="list-card">
                    <div class="card-title" style="margin-bottom: 16px;">
                      <strong>${this._t("editor.sections.bias_correction_status")}</strong>
                      <span class="card-subtitle">${this._t("bias_correction.status_panel.subtitle")}</span>
                    </div>
                    <helman-bias-correction-status .hass=${this.hass}></helman-bias-correction-status>
                  </div>
                `,
                { initialOpen: false },
              )}
            `,
            { initialOpen: false },
          )}
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
            ${this._renderPowerEntityGroup(
              "battery",
              "editor.fields.power_entity",
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
            ${this._renderPowerEntityGroup(
              "grid",
              "editor.fields.power_entity",
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
            ${this._renderOptionalNumberField(
              ["automation", "day_context", "deficit_below_ratio"],
              "editor.fields.day_context_deficit_ratio",
              "editor.helpers.day_context_deficit_ratio",
              "editor.help.day_context_deficit_ratio",
              { min: 0 },
            )}
            ${this._renderOptionalNumberField(
              ["automation", "day_context", "surplus_above_ratio"],
              "editor.fields.day_context_surplus_ratio",
              "editor.helpers.day_context_surplus_ratio",
              "editor.help.day_context_surplus_ratio",
              { min: 0 },
            )}
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
            ${optimizers.map((_optimizer, index) =>
              this._renderOptimizerEditor(index, optimizers.length),
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
            ${(this._optimizerSchema?.kinds ?? []).map(
              (schema) => html`
                <button
                  type="button"
                  class="add-button"
                  data-add-kind=${schema.kind}
                  @click=${() => this._addOptimizer(schema)}
                >
                  ${this._t(`editor.actions.add_${schema.kind}_optimizer`)}
                </button>
              `,
            )}
          </div>
        `,
      )}
    `;
  }

  /**
   * One optimizer, drawn by the element the solar inspector also mounts.
   *
   * The panel keeps the pipeline: the list actions in the card's summary are
   * *its* buttons, passed down, because moving and deleting change which
   * optimizers exist and that is a document-level edit. Everything inside the
   * card belongs to the element.
   */
  private _renderOptimizerEditor(index: number, total: number): TemplateResult {
    return html`
      <helman-optimizer-editor
        .config=${this._config}
        .index=${index}
        .total=${total}
        .schema=${this._optimizerSchema}
        .applianceMetadata=${this._liveApplianceMetadata}
        .hass=${this.hass}
        .narrow=${this.narrow ?? false}
        .localize=${(key: string) => this._t(key)}
        .listActions=${(basePath: PathSegment[], enabled: boolean) =>
          this._renderOptimizerListActions(basePath, index, total, enabled)}
        @optimizer-config-changed=${this._handleOptimizerConfigChanged}
      ></helman-optimizer-editor>
    `;
  }

  private _handleOptimizerConfigChanged = (event: Event): void => {
    const detail = (event as CustomEvent<OptimizerConfigChangedDetail>).detail;
    if (!detail?.config) {
      return;
    }
    // The same bookkeeping `_applyMutation` does for the panel's own fields —
    // the edit came from a child element, but it is still an edit of this
    // draft, and the validation report it invalidates is still ours.
    this._config = detail.config;
    this._dirty = true;
    this._validation = null;
    this._message = null;
  };

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

  private _renderOptimizerListActions(
    basePath: PathSegment[],
    index: number,
    total: number,
    enabled: boolean,
  ): TemplateResult {
    return html`
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

  private _renderControllablesTab(): TemplateResult {
    const controllables = asJsonArray(this._getValue(["controllables"])) ?? [];
    // The inverter is a singleton: config validation rejects a second one, so
    // the button that would author it is not offered once one exists.
    const hasInverter = controllables.some(
      (controllable) =>
        this._stringValue(asJsonObject(controllable)?.kind) === INVERTER_CONTROLLABLE_KIND,
    );

    return html`
      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.controllables.configured_controllables,
        html`
          <p class="inline-note">
            ${this._t("editor.notes.controllables")}
          </p>
          <div class="list-stack">
            ${controllables.length === 0
              ? html`<div class="message info">${this._t("editor.empty.no_controllables")}</div>`
              : controllables.map((controllable, index) =>
                  this._renderControllableCard(controllable, index, controllables.length),
                )}
          </div>
          <div class="section-footer">
            ${hasInverter
              ? nothing
              : html`
                  <button
                    type="button"
                    class="add-button"
                    @click=${this._handleAddInverter}
                  >
                    ${this._t("editor.actions.add_inverter")}
                  </button>
                `}
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

  private _renderControllableCard(
    controllable: unknown,
    index: number,
    total: number,
  ): TemplateResult {
    const applianceObject = asJsonObject(controllable) ?? {};
    const kind = this._stringValue(applianceObject.kind);
    if (kind === INVERTER_CONTROLLABLE_KIND) {
      return this._renderInverterControllable(applianceObject, index, total);
    }
    if (kind === "ev_charger") {
      return this._renderEvChargerAppliance(applianceObject, index, total);
    }
    if (kind === "climate") {
      return this._renderClimateAppliance(applianceObject, index, total);
    }
    if (kind === "generic") {
      return this._renderGenericAppliance(applianceObject, index, total);
    }
    return this._renderUnsupportedControllable(applianceObject, index, total);
  }

  /**
   * The inverter, as a card in the same list as the appliances.
   *
   * These are the six fields the retired Scheduler tab held, moved verbatim
   * apart from where they are written: `controls.mode.entity_id` and
   * `controls.mode.options.*` instead of `scheduler.control.mode_entity_id`
   * and `scheduler.control.action_option_map.*`. Nothing about the inverter
   * asked to be edited on a tab of its own — the tab existed because the
   * config did.
   *
   * No projection section: the inverter has no demand of its own, which is the
   * one capability that genuinely separates it from the appliance kinds.
   */
  private _renderInverterControllable(
    controllable: JsonObject,
    index: number,
    total: number,
  ): TemplateResult {
    const basePath: PathSegment[] = ["controllables", index];
    const modePath: PathSegment[] = [...basePath, "controls", "mode"];
    const controllableName =
      this._stringValue(controllable.name) || this._t("editor.dynamic.inverter");
    const controllableId =
      this._stringValue(controllable.id) || this._t("editor.values.missing_id");
    const chevronPath = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";
    const isYaml = this._getControllableMode(index) === "yaml";

    return html`
      <details class="list-card">
        <summary>
          <div class="appliance-summary-row">
            <div class="appliance-summary-left">
              ${this._renderSvgIcon(chevronPath, "appliance-chevron")}
              <div class="card-title">
                <strong>${controllableName}</strong>
                <span class="card-subtitle">${controllableId}</span>
              </div>
            </div>
            <div class="list-actions" @click=${this._preventSummaryToggle}>
              ${this._renderControllableModeToggle(index)}
              <button type="button" ?disabled=${index === 0}
                @click=${() => this._moveListItem(["controllables"], index, index - 1)}
              >${this._t("editor.actions.up")}</button>
              <button type="button" ?disabled=${index === total - 1}
                @click=${() => this._moveListItem(["controllables"], index, index + 1)}
              >${this._t("editor.actions.down")}</button>
              <button type="button" class="danger"
                @click=${() => this._removeListItem(["controllables"], index)}
              >${this._t("editor.actions.remove")}</button>
            </div>
          </div>
        </summary>
        <div class="appliance-body">
          ${isYaml
            ? this._renderControllableYamlEditor(index)
            : html`
              ${this._renderSimpleSection(
                this._t("editor.sections.identity"),
                html`<div class="field-grid">
                  ${this._renderRequiredTextField([...basePath, "id"], "editor.fields.controllable_id", undefined, "editor.help.controllable_id")}
                  ${this._renderRequiredTextField([...basePath, "name"], "editor.fields.controllable_name", undefined, "editor.help.controllable_name")}
                  <div class="field"><label>${this._t("editor.fields.kind")}</label><input value="inverter" disabled /></div>
                </div>`,
              )}
              ${this._renderSimpleSection(
                this._t("editor.sections.controls"),
                html`<div class="field-grid">
                  ${this._renderRequiredEntityField(
                    [...modePath, "entity_id"],
                    "editor.fields.mode_entity",
                    ["input_select", "select"],
                    "editor.helpers.mode_entity",
                    undefined,
                    "editor.help.inverter_mode_entity",
                  )}
                </div>`,
              )}
              ${this._renderSimpleSection(
                this._t("editor.sections.action_options"),
                html`<div class="field-grid">
                  ${INVERTER_ACTION_OPTIONS.map((option) =>
                    this._renderOptionalTextField(
                      [...modePath, "options", option.key],
                      option.labelKey,
                      undefined,
                      "editor.help.inverter_action_option",
                    ),
                  )}
                </div>`,
              )}
            `}
        </div>
      </details>
    `;
  }

  private _renderUnsupportedControllable(
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
                @click=${() => this._moveListItem(["controllables"], index, index - 1)}
              >${this._t("editor.actions.up")}</button>
              <button
                type="button"
                ?disabled=${index === total - 1}
                @click=${() => this._moveListItem(["controllables"], index, index + 1)}
              >${this._t("editor.actions.down")}</button>
              <button
                type="button"
                class="danger"
                @click=${() => this._removeListItem(["controllables"], index)}
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
    const basePath: PathSegment[] = ["controllables", index];
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
    const isYaml = this._getControllableMode(index) === "yaml";

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
              ${this._renderControllableModeToggle(index)}
              <button type="button" ?disabled=${index === 0}
                @click=${() => this._moveListItem(["controllables"], index, index - 1)}
              >${this._t("editor.actions.up")}</button>
              <button type="button" ?disabled=${index === total - 1}
                @click=${() => this._moveListItem(["controllables"], index, index + 1)}
              >${this._t("editor.actions.down")}</button>
              <button type="button" class="danger"
                @click=${() => this._removeListItem(["controllables"], index)}
              >${this._t("editor.actions.remove")}</button>
            </div>
          </div>
        </summary>
        <div class="appliance-body">
          ${isYaml
            ? this._renderControllableYamlEditor(index)
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
                this._t("editor.sections.consumption"),
                this._renderConsumptionSection([...basePath, "consumption"], {
                  noteKey: "editor.notes.ev_charger_consumption",
                }),
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
    const basePath: PathSegment[] = ["controllables", index];
    const consumptionPath: PathSegment[] = [...basePath, "consumption"];
    const projectionStrategy =
      this._stringValue(this._getValue([...consumptionPath, "projection", "strategy"])) || "fixed";
    const applianceName =
      this._stringValue(appliance.name) ||
      this._tFormat("editor.dynamic.generic_appliance", { index: index + 1 });
    const applianceId = this._stringValue(appliance.id) || this._t("editor.values.missing_id");
    const chevronPath = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";
    const isYaml = this._getControllableMode(index) === "yaml";

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
              ${this._renderControllableModeToggle(index)}
              <button type="button" ?disabled=${index === 0}
                @click=${() => this._moveListItem(["controllables"], index, index - 1)}
              >${this._t("editor.actions.up")}</button>
              <button type="button" ?disabled=${index === total - 1}
                @click=${() => this._moveListItem(["controllables"], index, index + 1)}
              >${this._t("editor.actions.down")}</button>
              <button type="button" class="danger"
                @click=${() => this._removeListItem(["controllables"], index)}
              >${this._t("editor.actions.remove")}</button>
            </div>
          </div>
        </summary>
        <div class="appliance-body">
          ${isYaml
            ? this._renderControllableYamlEditor(index)
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
                this._t("editor.sections.consumption"),
                this._renderConsumptionSection(consumptionPath, {
                  noteKey: "editor.notes.generic_appliance_projection",
                  projectionStrategy,
                  onStrategyChange: (strategy) =>
                    this._handleProjectedApplianceProjectionStrategyChange(index, strategy),
                }),
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
    const basePath: PathSegment[] = ["controllables", index];
    const consumptionPath: PathSegment[] = [...basePath, "consumption"];
    const projectionStrategy =
      this._stringValue(this._getValue([...consumptionPath, "projection", "strategy"])) || "fixed";
    const applianceName =
      this._stringValue(appliance.name) ||
      this._tFormat("editor.dynamic.climate_appliance", { index: index + 1 });
    const applianceId = this._stringValue(appliance.id) || this._t("editor.values.missing_id");
    const chevronPath = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";
    const isYaml = this._getControllableMode(index) === "yaml";

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
              ${this._renderControllableModeToggle(index)}
              <button type="button" ?disabled=${index === 0}
                @click=${() => this._moveListItem(["controllables"], index, index - 1)}
              >${this._t("editor.actions.up")}</button>
              <button type="button" ?disabled=${index === total - 1}
                @click=${() => this._moveListItem(["controllables"], index, index + 1)}
              >${this._t("editor.actions.down")}</button>
              <button type="button" class="danger"
                @click=${() => this._removeListItem(["controllables"], index)}
              >${this._t("editor.actions.remove")}</button>
            </div>
          </div>
        </summary>
        <div class="appliance-body">
          ${isYaml
            ? this._renderControllableYamlEditor(index)
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
                this._t("editor.sections.consumption"),
                this._renderConsumptionSection(consumptionPath, {
                  noteKey: "editor.notes.climate_appliance_projection",
                  projectionStrategy,
                  onStrategyChange: (strategy) =>
                    this._handleProjectedApplianceProjectionStrategyChange(index, strategy),
                }),
              )}
            `}
        </div>
      </details>
    `;
  }

  /**
   * The energy meter and what it is used for — the sibling of the Controls
   * section. `projection` is nested inside because a demand estimate is a
   * statement about consumption, not about how the device is driven.
   *
   * The usage options only appear once a meter is picked: with no meter there
   * is nothing to defer against and no history to average, so the choices
   * would configure nothing.
   */
  private _renderConsumptionSection(
    consumptionPath: PathSegment[],
    options: {
      noteKey?: string;
      projectionStrategy?: string;
      onStrategyChange?: (strategy: string) => void;
    } = {},
  ): TemplateResult {
    const { noteKey, projectionStrategy, onStrategyChange } = options;
    const hasMeter = Boolean(
      this._stringValue(this._getValue([...consumptionPath, "energy_entity_id"])),
    );
    const projectionPath: PathSegment[] = [...consumptionPath, "projection"];

    return html`
      <div class="section-content">
        ${noteKey ? html`<p class="inline-note">${this._t(noteKey)}</p>` : nothing}
        <div class="field-grid">
          ${this._renderOptionalEntityField(
            [...consumptionPath, "energy_entity_id"],
            "editor.fields.consumption_energy_entity",
            ["sensor"],
            "editor.helpers.consumption_energy_entity",
            "editor.help.consumption_energy_entity",
          )}
        </div>
        ${hasMeter
          ? html`
              <div class="field-grid">
                ${this._renderBooleanField(
                  [...consumptionPath, "deferrable"],
                  "editor.fields.consumption_deferrable",
                  true,
                )}
              </div>
            `
          : nothing}
        ${onStrategyChange
          ? html`
              <div class="field-grid">
                <div class="field">
                  <div class="field-label-row">
                    <label>${this._t("editor.fields.projection_strategy")}</label>
                    ${this._renderHelpIcon("editor.fields.projection_strategy", "editor.help.appliance_projection_strategy")}
                  </div>
                  <select
                    .value=${projectionStrategy ?? "fixed"}
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
                  [...projectionPath, "hourly_energy_kwh"],
                  "editor.fields.hourly_energy_kwh",
                  undefined,
                  "any",
                  "editor.help.appliance_hourly_energy_kwh",
                )}
                ${projectionStrategy === "history_average"
                  ? this._renderRequiredNumberField(
                      [...projectionPath, "lookback_days"],
                      "editor.fields.history_lookback_days",
                      undefined,
                      "1",
                      "editor.help.appliance_history_lookback_days",
                    )
                  : nothing}
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
    return renderRequiredTextField(this, path, labelKey, explicitValue, helpKey);
  }

  private _renderOptionalNumberField(
    path: PathSegment[],
    labelKey: string,
    helperKey?: string,
    helpKey?: string,
    options: { min?: number; max?: number; suffix?: string } = {},
  ): TemplateResult {
    return renderOptionalNumberField(this, path, labelKey, helperKey, helpKey, options);
  }

  private _renderRequiredNumberField(
    path: PathSegment[],
    labelKey: string,
    explicitValue?: unknown,
    step = "any",
    helpKey?: string,
  ): TemplateResult {
    return renderRequiredNumberField(this, path, labelKey, explicitValue, step, helpKey);
  }

  /**
   * The polarity select shown under a power device's power-entity picker.
   *
   * One control across all four devices, but the wording is looked up per
   * device: "positive is import or export?" is a question a user can answer by
   * looking at their inverter, where "is it inverted?" is not. Grid and
   * battery name two directions of the same axis; house and solar have only
   * one quantity each, so theirs name which *sign* carries it. Either way the
   * option states the whole convention, so it reads as a statement rather than
   * as a value the field's label has already contradicted.
   *
   * The first option of each pair is the default, and it is exactly the
   * convention Helman hard-coded before the setting existed, so leaving the
   * field unset must keep an existing dashboard byte-identical. An unset field
   * therefore renders showing that default rather than blank: something is in
   * force either way, and a blank select would hide which.
   */
  private _renderPolarityField(device: PowerPolarityDevice): TemplateResult {
    const options = POWER_POLARITY_OPTIONS[device].map((value) => ({
      value,
      label: this._optionLabel(`editor.fields.power_polarity_${value}`, POWER_POLARITY_FALLBACK_LABELS[value]),
    }));
    return renderSelectFieldWithDefault(
      this,
      ["power_devices", device, "entities", "power_polarity"],
      "editor.fields.power_polarity",
      options,
      POWER_POLARITY_OPTIONS[device][0],
      `editor.help.power_polarity_${device}`,
    );
  }

  /**
   * A select option's label, from the editor's own translation files.
   *
   * ``_t`` is what reads those; ``hass.localize`` resolves against the
   * integration's *backend* strings, which carry no editor keys at all, so a
   * label looked up that way is the English fallback in every locale --
   * however carefully the editor's own locale files were translated. A missing
   * key comes back as the key itself, which is why the fallback is compared
   * rather than ``||``-ed.
   */
  private _optionLabel(key: string, fallback: string): string {
    const translated = this._t(key);
    return translated === key ? fallback : translated;
  }

  private _renderOptionalSelectField(
    path: PathSegment[],
    labelKey: string,
    options: { value: string; label: string }[],
    helpKey?: string,
  ): TemplateResult {
    return renderOptionalSelectField(this, path, labelKey, options, helpKey);
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

  /**
   * An entity picker, the settings that qualify it, and what it reads — as one.
   *
   * The group is the same markup `_renderEntityField` emits, in a bordered
   * block, plus a slot: the settings that belong to this entity are passed
   * *into* it rather than rendered as siblings in the same field grid, which is
   * what makes a polarity read as part of its sensor instead of as a loose
   * select that happens to sit next to one.
   *
   * `ownedPaths` is the group's own declaration of what it covers — the entity
   * path plus whatever was slotted in — and it is deliberately a call-site
   * concern. The backend decides what a path *means*; this is the place that
   * already writes those fields' labels, types and help keys, so it is the
   * cheapest place to say they belong together. It is what a revert restores.
   *
   * Nothing about the reading is decided here. The group is handed a row of
   * facts and renders them; if this method ever grows a branch on what an
   * entity is, the contract in `entity-group.ts` has been broken.
   */
  private _renderEntityGroup(
    path: PathSegment[],
    labelKey: string,
    options: {
      includeDomains?: string[];
      helperKey?: string;
      helpKey?: string;
      required?: boolean;
      ownedPaths?: PathSegment[][];
    } = {},
    slotted: TemplateResult | typeof nothing = nothing,
  ): TemplateResult {
    return html`
      <helman-entity-group
        .hass=${this.hass}
        .fieldHost=${this}
        .path=${path}
        .ownedPaths=${[path, ...(options.ownedPaths ?? [])]}
        .labelKey=${labelKey}
        .helpKey=${options.helpKey}
        .helperKey=${options.helperKey}
        .includeDomains=${options.includeDomains}
        ?required=${options.required ?? false}
        .inspection=${this._entityInspections[entityGroupKey(path)] ?? null}
      >${slotted}</helman-entity-group>
    `;
  }

  /**
   * A power device's power sensor: the picker, its polarity, and its reading.
   *
   * The polarity select is unchanged — same options, same path, same wording —
   * it has only moved from beside the picker to inside it.
   */
  private _renderPowerEntityGroup(
    device: PowerPolarityDevice,
    labelKey: string,
    helpKey: string,
    required = false,
  ): TemplateResult {
    const entityPath: PathSegment[] = ["power_devices", device, "entities", "power"];
    return this._renderEntityGroup(
      entityPath,
      labelKey,
      {
        includeDomains: ["sensor"],
        helpKey,
        required,
        ownedPaths: [["power_devices", device, "entities", "power_polarity"]],
      },
      this._renderPolarityField(device),
    );
  }

  private _handleEntityGroupConnected = (event: Event): void => {
    const detail = (event as CustomEvent<EntityGroupRegistrationDetail>).detail;
    if (!detail?.key) return;
    this._mountedGroups.set(detail.key, detail.path);
    // A section that was just expanded should not wait a whole tick for its
    // first reading. The pending one-shot collapses the burst of registrations
    // one expansion produces into a single call.
    this._scheduleEntityInspection();
  };

  private _handleEntityGroupDisconnected = (event: Event): void => {
    const detail = (event as CustomEvent<EntityGroupRegistrationDetail>).detail;
    if (!detail?.key) return;
    this._mountedGroups.delete(detail.key);
  };

  /**
   * Put this group's owned paths back to what the stored document says.
   *
   * The editor does the write because it is what holds both documents; the
   * group only knows which paths are its own. A path the saved document does
   * not have is removed rather than blanked, so reverting an entity that was
   * never saved leaves the same document as never having picked one.
   */
  private _handleEntityGroupRevert = (event: Event): void => {
    const detail = (event as CustomEvent<EntityGroupRevertDetail>).detail;
    const saved = this._savedConfig;
    if (!saved || !detail?.paths?.length) return;
    this._applyMutation((draft) => {
      for (const path of detail.paths) {
        const value = getValueAtPath(saved, path);
        if (value === undefined) {
          unsetValueAtPath(draft, path);
        } else {
          setValueAtPath(draft, path, cloneJson(value as JsonValue));
        }
      }
    });
    void this._pollEntityInspections();
  };

  private _scheduleEntityInspection(): void {
    if (this._inspectionPending !== undefined) return;
    this._inspectionPending = setTimeout(() => {
      this._inspectionPending = undefined;
      void this._pollEntityInspections();
    }, 0);
  }

  /**
   * One call for every mounted group, or none at all.
   *
   * Groups whose entity is not picked yet are left out: there is nothing to
   * read, and the backend would only answer `unset`. A failed tick is
   * swallowed — the last reading stays on screen rather than the panel growing
   * an error banner that reappears every two seconds.
   */
  private async _pollEntityInspections(): Promise<void> {
    if (!this.hass || !this._config || this._inspectionInFlight) return;
    const targets = [...this._mountedGroups.entries()]
      .filter(([, path]) => stringValue(this._getValue(path)) !== "")
      .map(([key, path]) => ({ key, path }));
    if (targets.length === 0) {
      if (Object.keys(this._entityInspections).length > 0) {
        this._entityInspections = {};
      }
      return;
    }
    this._inspectionInFlight = true;
    try {
      const response = await this.hass.callWS<{ results?: EntityInspectionResult[] }>({
        type: "helman/inspect_entities",
        config: this._config,
        ...(this._savedConfig ? { saved_config: this._savedConfig } : {}),
        targets,
      });
      const next: Record<string, EntityInspectionResult> = {};
      for (const row of response?.results ?? []) {
        next[row.key] = row;
      }
      this._entityInspections = next;
    } catch {
      // Polled: a dropped tick costs a stale badge, not a message.
    } finally {
      this._inspectionInFlight = false;
    }
  }

  private _renderHelpIcon(labelKey: string, contentKey: string): TemplateResult {
    return renderHelpIcon(this, labelKey, contentKey);
  }

  private _renderHelpDialog(): TemplateResult | typeof nothing {
    return renderHelpDialog(this, this._helpDialog, this._closeHelp);
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
      automation: { errors: 0, warnings: 0 },
      controllables: { errors: 0, warnings: 0 },
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

  /** Adopt the stored document as the baseline, without touching the draft. */
  private async _rebaselineConfig(): Promise<void> {
    if (!this.hass) {
      return;
    }
    try {
      const current = asJsonObject(
        await this.hass.callWS<unknown>({ type: "helman/get_config" }),
      );
      if (current !== undefined) {
        this._configBaseline = canonicalJson(current);
        this._savedConfig = cloneJson(current);
      }
    } catch {
      // Leaving the old baseline costs at most one spurious notice, which the
      // reload button clears. Failing the save over it would cost the write.
    }
  }

  private async _loadConfig(options: { showMessage: boolean }): Promise<void> {
    if (!this.hass) {
      return;
    }
    this._loading = true;
    try {
      const [loadedResult, liveApplianceMetadataResult, schemaResult] =
        await Promise.allSettled([
          this.hass.callWS<unknown>({ type: "helman/get_config" }),
          this._loadLiveApplianceMetadata(),
          fetchOptimizerSchema(this.hass),
        ]);
      if (loadedResult.status !== "fulfilled") {
        throw loadedResult.reason;
      }
      const loadedConfig = asJsonObject(loadedResult.value);
      this._config = loadedConfig ? cloneJson(loadedConfig) : {};
      // What was read is what this editor now agrees with, so it is what a
      // later announcement has to be compared against.
      this._configBaseline = canonicalJson(loadedConfig ?? {});
      // The same document the baseline is taken from, kept whole: it is what a
      // group's revert restores, and what the backend compares a draft against.
      this._savedConfig = loadedConfig ? cloneJson(loadedConfig) : {};
      // Whatever changed elsewhere is now in hand, however the reload was asked
      // for -- the button, the announcement, or the first load.
      this._staleConfigNotice = false;
      this._liveApplianceMetadata =
        liveApplianceMetadataResult.status === "fulfilled"
          ? liveApplianceMetadataResult.value
          : null;
      this._optimizerSchema =
        schemaResult.status === "fulfilled" ? schemaResult.value : null;
      this._validation = null;
      this._dirty = this._config
        ? this._normalizeApplianceOptimizerTargets(this._config)
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
        // The document this save wrote is what the editor now agrees with, so
        // the reload's own announcements compare equal and say nothing. Re-read
        // rather than reuse the draft: the backend stamps `config_version` on
        // write, and the baseline has to be what a later read will return.
        await this._rebaselineConfig();
        this._staleConfigNotice = false;
        this._liveApplianceMetadata = await this._loadLiveApplianceMetadata();
        this._dirty = this._config
          ? this._normalizeApplianceOptimizerTargets(this._config)
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
      Object.values(this._controllableYamlErrors).some(
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
    this._controllableModes = {};
    this._controllableYamlValues = {};
    this._controllableYamlErrors = {};
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

  private _addOptimizer(schema: OptimizerSchema): void {
    const existingIds = (asJsonArray(this._getValue(["automation", "optimizers"])) ?? [])
      .map((optimizer) => this._stringValue(asJsonObject(optimizer)?.id))
      .filter((value) => value.length > 0);
    const draftOptimizer = createOptimizerDraft(existingIds, schema.kind, schema.newDraft);
    this._applyMutation((draft) => {
      if (!asJsonObject(getValueAtPath(draft, ["automation"]))) {
        setValueAtPath(draft, ["automation"], {
          enabled: true,
          optimizers: [draftOptimizer],
        });
        return;
      }
      appendListItem(draft, ["automation", "optimizers"], draftOptimizer);
    });
  }

  /** A new group starts from the kind's seed, so it is valid the moment it appears. */
  private _addConditionGroup(index: number, schema: OptimizerSchema): void {
    const seed = asJsonArray(schema.newDraft.conditions)?.[0];
    this._applyMutation((draft) => {
      appendListItem(
        draft,
        ["automation", "optimizers", index, "conditions"],
        (asJsonObject(seed) ?? {}) as JsonObject,
      );
    });
  }

  /**
   * Remove a group — never the last one.
   *
   * Zero groups is an unsavable automation, so the UI must not be able to reach
   * that state. The button is disabled too; this is the second lock.
   */
  private _removeConditionGroup(index: number, groupIndex: number): void {
    const path: PathSegment[] = ["automation", "optimizers", index, "conditions"];
    if ((asJsonArray(this._getValue(path)) ?? []).length <= 1) return;
    this._removeListItem(path, groupIndex);
  }




  private _handleAddInverter = (): void => {
    this._applyMutation((draft) => {
      appendListItem(
        draft,
        ["controllables"],
        createInverterControllableDraft(this._t("editor.dynamic.inverter")),
      );
    });
  };

  private _handleAddEvCharger = (): void => {
    const existingIds = (asJsonArray(this._getValue(["controllables"])) ?? [])
      .map((appliance) => this._stringValue(asJsonObject(appliance)?.id))
      .filter((value) => value.length > 0);
    this._applyMutation((draft) => {
      appendListItem(
        draft,
        ["controllables"],
        createApplianceDraft(
          existingIds,
          this._tFormat("editor.dynamic.ev_charger", { index: existingIds.length + 1 }),
          this._tFormat("editor.dynamic.vehicle", { index: 1 }),
        ),
      );
    });
  };

  private _handleAddClimateAppliance = (): void => {
    const existingIds = (asJsonArray(this._getValue(["controllables"])) ?? [])
      .map((appliance) => this._stringValue(asJsonObject(appliance)?.id))
      .filter((value) => value.length > 0);
    this._applyMutation((draft) => {
      appendListItem(
        draft,
        ["controllables"],
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
    const existingIds = (asJsonArray(this._getValue(["controllables"])) ?? [])
      .map((appliance) => this._stringValue(asJsonObject(appliance)?.id))
      .filter((value) => value.length > 0);
    this._applyMutation((draft) => {
      appendListItem(
        draft,
        ["controllables"],
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
    const vehiclePath: PathSegment[] = ["controllables", applianceIndex, "vehicles"];
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
      const basePath: PathSegment[] = [
        "controllables",
        applianceIndex,
        "consumption",
        "projection",
      ];
      setValueAtPath(draft, [...basePath, "strategy"], strategy);
      if (strategy !== "history_average") {
        return;
      }

      // Only the window is seeded. The meter lives on the consumption block
      // now, where it may already have been picked for the deferrable split
      // alone — writing it from here would either clobber that or invent an
      // empty one.
      const existingLookbackDays = getValueAtPath(draft, [...basePath, "lookback_days"]);
      if (
        typeof existingLookbackDays !== "number" ||
        !Number.isFinite(existingLookbackDays)
      ) {
        setValueAtPath(draft, [...basePath, "lookback_days"], 30);
      }
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
    setOptionalString(this, path, rawValue);
  }

  private _setRequiredString(path: PathSegment[], rawValue: string): void {
    setRequiredString(this, path, rawValue);
  }

  private _setOptionalNumber(path: PathSegment[], rawValue: string): void {
    setOptionalNumber(this, path, rawValue);
  }

  private _setRequiredNumber(path: PathSegment[], rawValue: string): void {
    setRequiredNumber(this, path, rawValue);
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

  /**
   * Keep `target.climate_mode` consistent with the controllable it names.
   *
   * Only `appliance_runtime` has a climate mode to keep, so only it is walked —
   * the other kinds drive the inverter, which has no modes of this sort.
   */
  private _normalizeApplianceOptimizerTargets(config: JsonObject): boolean {
    const optimizers = asJsonArray(getValueAtPath(config, ["automation", "optimizers"])) ?? [];
    let changed = false;
    optimizers.forEach((optimizer, index) => {
      const optimizerObject = asJsonObject(optimizer);
      const optimizerKind = this._stringValue(optimizerObject?.kind);
      if (!optimizerObject || optimizerKind !== APPLIANCE_RUNTIME_OPTIMIZER_KIND) {
        return;
      }

      const targetPath: PathSegment[] = ["automation", "optimizers", index, "target"];
      const applianceId = this._stringValue(
        getValueAtPath(config, [...targetPath, "controllable_id"]),
      );
      const currentClimateMode = this._stringValue(
        getValueAtPath(config, [...targetPath, "climate_mode"]),
      );
      const selectionState = buildControllableSelectionState(
        config,
        this._liveApplianceMetadata,
        applianceId,
        this._optimizerSchema?.kinds.find(
          (entry) => entry.kind === APPLIANCE_RUNTIME_OPTIMIZER_KIND,
        )?.controllableKinds ?? [],
      );
      const climateModeFieldState = buildClimateModeFieldState(
        selectionState,
        currentClimateMode,
      );

      if (selectionState.selectedOption?.kind === "generic" && currentClimateMode.length > 0) {
        unsetValueAtPath(config, [...targetPath, "climate_mode"]);
        changed = true;
        return;
      }
      if (
        climateModeFieldState.visible &&
        !climateModeFieldState.unavailable &&
        currentClimateMode.length === 0 &&
        climateModeFieldState.value.length > 0
      ) {
        setValueAtPath(config, [...targetPath, "climate_mode"], climateModeFieldState.value);
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

  // --- FormFieldHost -------------------------------------------------------
  //
  // What the shared form primitives in `cards/shared/config/form-fields` need.
  // Public because they are the interface, not because anything else calls
  // them: the private `_t` / `_getValue` remain the panel's own vocabulary.

  t(key: string): string {
    return this._t(key);
  }

  getValue(path: PathSegment[]): unknown {
    return this._getValue(path);
  }

  setValue(path: PathSegment[], value: JsonValue | undefined): void {
    this._applyMutation((draft) => {
      if (value === undefined) unsetValueAtPath(draft, path);
      else setValueAtPath(draft, path, value);
    });
  }

  openHelp(labelKey: string, contentKey: string): void {
    this._helpDialog = { labelKey, contentKey };
  }

  private _getValue(path: PathSegment[]): unknown {
    if (!this._config) {
      return undefined;
    }
    return getValueAtPath(this._config, path);
  }

  private _stringValue(value: unknown): string {
    return stringValue(value);
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
    return booleanValue(value, fallback);
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
