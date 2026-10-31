import { callHelman } from "../cards/shared/data/helman-commands";
import { ConfigSession } from "../cards/shared/config/config-session";
import { LitElement, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { PropertyValues, TemplateResult } from "lit";
import { cache } from "lit/directives/cache.js";

import {
  canonicalJson,
  cloneJson,
  getValueAtPath,
  moveListItem,
  removeListItem,
  setValueAtPath,
  unsetValueAtPath,
} from "../cards/shared/config/config-document";
import {
  pruneUnassignablePhases,
} from "../cards/shared/config/devices";
import {
  configDefaultHint,
  fetchConfigDefaults,
  type ConfigDefaults,
} from "../cards/shared/config/config-defaults";
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
import { DataChangedController } from "../cards/shared/data/data-changed";
import { getLocalizeFunction, type LocalizeFunction } from "../cards/localize/localize";
import {
  fetchOptimizerSchema,
} from "../cards/shared/optimizer/optimizer-schema";
import { loadHaForm, loadHaSortable, loadHaYamlEditor } from "./load-ha-elements";
import {
  renderHelpDialog,
  renderSvgIcon,
  formatError,
  setRequiredString,
} from "../cards/shared/config/form-fields";
import {
  parseItemYaml,
  type YamlEditorValueChangedDetail,
} from "../cards/shared/config/item-yaml";
import {
  VendorsController,
  type HardwareProfileHost,
  renderProvidedField,
  vendorProvision,
} from "../cards/shared/devices/hardware-profile";
import { resolvedDraft } from "../cards/shared/config/resolved-draft";
import {
  renderEntityGroup,
  type EntityGroupOptions,
} from "../cards/shared/config/entity-group";
import { EntityInspectionController } from "../cards/shared/config/entity-inspection-controller";
import type {
  JsonObject,
  JsonValue,
  PathSegment,
  StatusMessage,
  ValidationIssue,
  ValidationReport,
  VendorsResponse,
} from "../cards/shared/config/types";
import type { ScopeAdapterValidationError } from "./config-scope-adapters";
import type { HomeAssistant } from "../types/ha";
import { configEditorStyles } from "./styles";
import {
  VisualizationTabController,
  renderVisualizationTab,
} from "./tabs/visualization";
import {
  EnergyNodesTabController,
  renderEnergyNodesTab,
} from "./tabs/energy-nodes";
import {
  TrainingTabController,
  renderTrainingTab,
  renderTrainingBadge,
  renderDeviceDetailDialog,
} from "./tabs/training";
import {
  AutomationTabController,
  renderAutomationTab,
  replaceObjectContents,
} from "./tabs/automation";
import {
  DevicesTabController,
  renderDevicesTab,
} from "./tabs/devices";

export class HelmanConfigEditorPanel
  extends LitElement
  implements HardwareProfileHost
{
  static styles = configEditorStyles;

  private _hass?: HomeAssistant;

  @property({ attribute: false })
  public get hass(): HomeAssistant | undefined {
    return this._hass;
  }

  public set hass(hass: HomeAssistant | undefined) {
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
  @property({ type: Boolean }) public narrow = false;
  @property({ attribute: false }) public route?: unknown;
  /**
   * The panel registration Home Assistant renders us from.
   *
   * `config` is the backend-controlled blob `async_register_panel` passed, and
   * the only thing read out of it is the version-stamped card bundle URL the
   * solar Diagnostics embed imports.
   */
  @property({ attribute: false })
  public panel?: { config?: { card_module_url?: string } | null };

  private _localize?: LocalizeFunction;
  private readonly _fallbackLocalize = getLocalizeFunction();

  @state() private _activeTab: TabId = "energy_nodes";
  /**
   * Reduce every tab to nothing but its entity groups.
   *
   * Session-only on purpose: it lives for as long as the panel is mounted and
   * comes back off on the next visit.
   */
  @state() private _entitiesOnly = false;
  private _sectionOpenBeforeEntitiesOnly = new WeakMap<HTMLDetailsElement, boolean>();
  @state() private _config: JsonObject | null = null;
  @state() private _dirty = false;
  @state() private _loading = false;
  @state() private _saving = false;
  private _configRevisionDuringSave: string | undefined;
  @state() private _validating = false;
  @state() private _validation: ValidationReport | null = null;
  private _validationGeneration = 0;
  @state() private _message: StatusMessage | null = null;
  /**
   * The stored config moved while a draft was open, and we refused to reload.
   */
  @state() private _staleConfigNotice = false;
  /** The stored document revision agreed with by this editor. */
  private _configSession = new ConfigSession(() => this.hass);
  @state() private _hasLoadedOnce = false;
  @state() private _scopeModes: Partial<Record<ScopeId, EditorMode>> = {};
  @state() private _scopeYamlValues: Partial<Record<ScopeId, JsonValue>> = {};
  @state() private _scopeYamlErrors: Partial<Record<ScopeId, string>> = {};

  // What the backend applies where a field is left unset, by dotted path.
  @state() private _configDefaults: ConfigDefaults | null = null;
  @state() private _helpDialog: { labelKey: string; contentKey: string } | null = null;
  private _configFragmentRequested = false;

  // --- Tab controllers -----------------------------------------------------

  public readonly _visualizationTab = new VisualizationTabController(this);
  public readonly _energyNodesTab = new EnergyNodesTabController(this);
  public readonly _trainingTab = new TrainingTabController(this);
  public readonly _automationTab = new AutomationTabController(this);
  public readonly _devicesTab = new DevicesTabController(this);

  // --- Entity inspection & hardware profiles --------------------------------

  /** The stored document, as read. What a revert restores from. */
  private _savedConfig: JsonObject | null = null;
  public readonly _inspections = new EntityInspectionController(this, {
    hass: () => this.hass,
    config: () => this._config,
    saved: () => this._savedConfig,
    // The training tab's depth tables and the devices tab's names and icons
    // (both empty outside their tab) ride the same poll and cache.
    extraTargets: () => [
      ...this._trainingTab.extraTargets(),
      ...this._devicesTab.extraTargets(),
    ],
    mutate: (mutator) => this._applyMutation(mutator),
  });

  /** The hardware profiles, and what each draft device's profile owns. */
  public readonly _vendors = new VendorsController(this, {
    hass: () => this.hass,
    config: () => this._config,
  });

  // --- Host accessors for tabs & specs -------------------------------------

  get config(): JsonObject | null {
    return this._config;
  }

  get savedConfig(): JsonObject | null {
    return this._savedConfig;
  }

  get dirty(): boolean {
    return this._dirty;
  }

  get validation(): ValidationReport | null {
    return this._validation;
  }

  get configDefaults(): ConfigDefaults | null {
    return this._configDefaults;
  }

  get inspections(): EntityInspectionController {
    return this._inspections;
  }

  get vendors(): VendorsResponse | null {
    return this._vendors.vendors;
  }

  get activeTab(): TabId {
    return this._activeTab;
  }

  get localizeFunction(): LocalizeFunction {
    return this._localize ?? this._fallbackLocalize;
  }

  get trainingTab(): TrainingTabController {
    return this._trainingTab;
  }

  get devicesTab(): DevicesTabController {
    return this._devicesTab;
  }

  public setMessage(message: StatusMessage | null): void {
    this._message = message;
  }

  public resolvedConfig(): JsonObject | null {
    return resolvedDraft(this._config, this._vendors.vendors);
  }

  // Compatible accessors for specs reaching into private fields:
  get _trainingStatus() {
    return this._trainingTab.status;
  }
  set _trainingStatus(value) {
    this._trainingTab.status = value;
  }

  // --- FormFieldHost & HardwareProfileHost methods -------------------------

  t(key: string, values?: Record<string, string | number>): string {
    return this._t(key, values);
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
    this._openHelp(labelKey, contentKey);
  }

  mutateDraft(mutator: (draft: JsonObject) => void): void {
    this._applyMutation(mutator);
  }

  configDefaultHint(path: PathSegment[]): string {
    return configDefaultHint(this._configDefaults, path);
  }

  // --- Lifecycle -----------------------------------------------------------

  constructor() {
    super();
    new DataChangedController(this, () => this.hass, {}, (kinds, { configRevision }) => {
      if (kinds.has("training") || kinds.has("config")) void this._trainingTab.loadTrainingStatus();
      this._handleDataChanged(configRevision);
    });
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("beforeunload", this._guardCloseWhileSaving);
    // Not awaited with the form elements: a list that cannot be dragged is a
    // far smaller loss than a panel whose every form stays unrendered.
    void loadHaSortable().then(() => {
      this.requestUpdate();
    });
    void loadHaForm()
      .then(() => {
        this.requestUpdate();
      })
      .catch((error) => {
        this._message = {
          kind: "error",
          text: formatError(
            error,
            this._t("editor.messages.load_ha_form_failed"),
          ),
        };
      });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("beforeunload", this._guardCloseWhileSaving);
  }

  protected willUpdate(changedProperties: PropertyValues): void {
    super.willUpdate(changedProperties);
    if (this.hass && !this._localize) {
      this._localize = getLocalizeFunction(this.hass);
    }
    if (
      this.hass &&
      !this._configFragmentRequested &&
      typeof this.hass.loadFragmentTranslation === "function"
    ) {
      this._configFragmentRequested = true;
      void this.hass.loadFragmentTranslation("config").then(() => this.requestUpdate());
    }
  }

  protected updated(changedProperties: PropertyValues): void {
    super.updated(changedProperties);
    if (!this._hasLoadedOnce && this.hass) {
      this._hasLoadedOnce = true;
      void this._loadConfig({ showMessage: false });
      void this._trainingTab.loadTrainingStatus();
    }
    // Every update while the toggle is on, and once more on the update that
    // turns it off -- see `_applyEntitiesOnlyOpenState` for why "every".
    if (this._entitiesOnly || changedProperties.has("_entitiesOnly")) {
      this._applyEntitiesOnlyOpenState();
    }
    // Device cards are elements that render in their own update, after this
    // one, so their sections reach the DOM only once they have settled.
    if (this._entitiesOnly) {
      void this._deviceCardsRendered().then(() => {
        if (this._entitiesOnly) this._applyEntitiesOnlyOpenState();
      });
    }
  }

  /** Resolves once no mounted device card, nested ones included, has an update pending. */
  private async _deviceCardsRendered(): Promise<void> {
    await this._devicesTab.list.deviceCardsRendered();
  }

  /**
   * The stored config moved somewhere else. Whether we act on it depends
   * entirely on whether there is a draft to lose.
   */
  private _handleDataChanged(configRevision?: string): void {
    if (this._saving) {
      if (configRevision !== undefined) this._configRevisionDuringSave = configRevision;
      return;
    }
    void this._reactToDataChanged(configRevision);
  }

  /** Reload a clean draft on a newer config revision; warn over a dirty one. */
  private async _reactToDataChanged(configRevision?: string): Promise<void> {
    if (this._saving || this._loading || !this._configSession.isStale(configRevision)) return;
    if (this._dirty || this._hasBlockingYamlErrors()) {
      this._staleConfigNotice = true;
      return;
    }
    await this._loadConfig({ showMessage: false });
  }

  // --- Rendering -----------------------------------------------------------

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
      ${renderHelpDialog(this, this._helpDialog, this._closeHelp)}
      ${renderDeviceDetailDialog(this, this._trainingTab)}
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
                // No event announces a run starting elsewhere, so the tab
                // asks once on opening rather than showing a stale state.
                if (tab.id === "training") void this._trainingTab.loadTrainingStatus();
                // The training tab's depth table and the devices tab's
                // name and icon placeholders ask about paths no mounted
                // `helman-entity-group` announces -- nothing else triggers a
                // poll on a plain tab switch, so this one does.
                if (tab.id === "training" || tab.id === "devices") {
                  this._inspections.request();
                }
              }}
            >
              ${renderSvgIcon(TAB_ICONS[tab.id], "tab-icon")}
              <span>${this._t(tab.labelKey)}</span>
              ${tab.id === "training" ? renderTrainingBadge(this, this._trainingTab) : nothing}
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
      case "visualization":
        return this._renderTabScope(
          TAB_SCOPE_IDS.visualization,
          renderVisualizationTab(this, this._visualizationTab),
        );
      case "energy_nodes":
        return this._renderTabScope(
          TAB_SCOPE_IDS.energy_nodes,
          renderEnergyNodesTab(this, this._energyNodesTab),
        );
      case "training":
        return this._renderTabScope(
          TAB_SCOPE_IDS.training,
          renderTrainingTab(this, this._trainingTab),
        );
      case "automation":
        return this._renderTabScope(
          TAB_SCOPE_IDS.automation,
          renderAutomationTab(this, this._automationTab),
        );
      case "devices":
        return this._renderTabScope(
          TAB_SCOPE_IDS.devices,
          renderDevicesTab(this, this._devicesTab),
        );
      default:
        return html``;
    }
  }

  private _renderTabScope(scopeId: ScopeId, content: TemplateResult): TemplateResult {
    return html`
      <div class="tab-scope">
        <div class="scope-toolbar">
          ${this._renderEntitiesOnlyToggle()}
          ${this._renderModeToggle(scopeId)}
        </div>
        ${this._isScopeYaml(scopeId)
          ? html`<div class="list-card">${this._renderYamlEditor(scopeId)}</div>`
          : html`<div class="tab-body ${this._entitiesOnly ? "entities-only" : ""}">
              ${content}
              ${this._entitiesOnly
                ? html`<div class="message info entities-only-empty">
                    ${this._t("editor.empty.no_entities_on_tab")}
                  </div>`
                : nothing}
            </div>`}
      </div>
    `;
  }

  private _renderEntitiesOnlyToggle(): TemplateResult {
    return html`
      <ha-formfield
        class="entities-only-toggle"
        .label=${this._t("editor.toggles.entities_only")}
      >
        <ha-switch
          .checked=${this._entitiesOnly}
          @change=${(event: Event) =>
            this._setEntitiesOnly(
              (event.currentTarget as HTMLElement & { checked: boolean }).checked,
            )}
        ></ha-switch>
      </ha-formfield>
    `;
  }

  private _tabBodyDetails(): HTMLDetailsElement[] {
    return Array.from(this.renderRoot.querySelectorAll<HTMLDetailsElement>(".tab-body details"));
  }

  private _setEntitiesOnly(next: boolean): void {
    if (next === this._entitiesOnly) return;
    this._entitiesOnly = next;
  }

  private _applyEntitiesOnlyOpenState(): void {
    const sections = this._tabBodyDetails();
    if (this._entitiesOnly) {
      for (const section of sections) {
        if (this._sectionOpenBeforeEntitiesOnly.has(section)) continue;
        this._sectionOpenBeforeEntitiesOnly.set(section, section.open);
        section.open = true;
      }
      return;
    }
    for (const section of sections) {
      const previous = this._sectionOpenBeforeEntitiesOnly.get(section);
      if (previous !== undefined) {
        section.open = previous;
      }
    }
    this._sectionOpenBeforeEntitiesOnly = new WeakMap();
  }

  public _renderSectionScope(
    scopeId: ScopeId,
    content: TemplateResult,
    options: { initialOpen?: boolean; badge?: TemplateResult | typeof nothing } = {},
  ): TemplateResult {
    const scope = getScope(scopeId);
    const { initialOpen = true } = options;
    const sectionIcon = SECTION_ICONS[scopeId];
    const chevronPath = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";
    const sectionClasses = this._isScopeYaml(scopeId)
      ? "section-card scope-yaml"
      : "section-card";

    return html`
      <details class=${sectionClasses} ?open=${initialOpen}>
        <summary>
          <div class="section-summary-row">
            <div class="section-summary-left">
              ${sectionIcon ? renderSvgIcon(sectionIcon, "section-icon") : nothing}
              <span class="section-summary-label">${this._t(scope.labelKey)}</span>
            </div>
            ${options.badge ? html`<div class="device-badges">${options.badge}</div>` : nothing}
            <div style="display:flex;align-items:center;gap:8px;" @click=${this._preventSummaryToggle}>
              ${this._renderModeToggle(scopeId, { inSummary: false })}
            </div>
            ${renderSvgIcon(chevronPath, "section-chevron")}
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

  // --- Scope YAML ----------------------------------------------------------

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

  private _scopeAriaLabel(scopeId: ScopeId): string {
    const scope = getScope(scopeId);
    const parentId = scope.parentId;
    const parent = parentId ? getScope(parentId) : undefined;
    if (scope.kind !== "section" || parent?.kind !== "section") {
      return this._t(scope.labelKey);
    }
    return `${this._t(parent.labelKey)} / ${this._t(scope.labelKey)}`;
  }

  private _renderYamlEditor(scopeId: ScopeId): TemplateResult {
    const scope = getScope(scopeId);
    const scopeLabel = this._scopeAriaLabel(scopeId);
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
            aria-label=${this._t("editor.yaml.aria_label", { scope: scopeLabel })}
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
        text: formatError(
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

    const parsed = parseItemYaml(event.detail, { allowArray: true });
    if (!parsed.ok) {
      this._scopeYamlErrors = {
        ...this._scopeYamlErrors,
        [scopeId]: event.detail.errorMsg ?? this._t(parsed.errorKey),
      };
      return;
    }

    const adapter = getScope(scopeId).adapter;
    const validationError = adapter.validate(parsed.value);
    if (validationError) {
      this._scopeYamlErrors = {
        ...this._scopeYamlErrors,
        [scopeId]: this._formatScopeYamlValidationError(validationError),
      };
      return;
    }

    try {
      const nextValue = cloneJson(parsed.value);
      this._applyMutation((draft) => {
        replaceObjectContents(draft, adapter.apply(draft, nextValue));
      });
      if (
        scopeId === DOCUMENT_SCOPE_ID ||
        scopeId === TAB_SCOPE_IDS.devices ||
        scopeId === SECTION_SCOPE_IDS.devices.consumers
      ) {
        this._devicesTab.list.resetDeviceModes();
      }
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
        [scopeId]: formatError(error, this._t("editor.yaml.errors.apply_failed")),
      };
    }
  }

  private _hasBlockingYamlErrors(): boolean {
    return (
      Object.values(this._scopeYamlErrors).some(
        (error) => typeof error === "string" && error.length > 0,
      ) ||
      this._devicesTab.list.hasYamlErrors()
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
    this._devicesTab.list.resetDeviceModes();
  }

  public _omitScopeIds<T>(
    values: Partial<Record<ScopeId, T>>,
    scopeIds: ScopeId[],
  ): Partial<Record<ScopeId, T>> {
    const nextValues = { ...values };
    for (const scopeIdToDelete of scopeIds) {
      delete nextValues[scopeIdToDelete];
    }
    return nextValues;
  }

  public _omitScopeIdsFromYaml(scopeIds: ScopeId[]): void {
    this._scopeModes = this._omitScopeIds(this._scopeModes, scopeIds);
    this._scopeYamlValues = this._omitScopeIds(this._scopeYamlValues, scopeIds);
    this._scopeYamlErrors = this._omitScopeIds(this._scopeYamlErrors, scopeIds);
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

  private _formatScopeYamlValidationError(
    error: ScopeAdapterValidationError,
  ): string {
    switch (error.code) {
      case "expected_object":
        return this._t("editor.yaml.errors.expected_object");
      case "expected_array":
        return this._t("editor.yaml.errors.expected_array");
      case "unexpected_key":
        return this._t("editor.yaml.errors.unexpected_key", {
          key: error.key ?? "",
        });
    }
  }

  // --- Entity group helper (shared across tabs) ----------------------------

  public _renderEntityGroup(
    path: PathSegment[],
    labelKey: string,
    options: EntityGroupOptions = {},
    slotted: TemplateResult | typeof nothing = nothing,
  ): TemplateResult {
    const provision = vendorProvision(this._vendors.vendors, path);
    if (provision) return renderProvidedField(this, path, labelKey, provision, slotted);
    return renderEntityGroup(this, this._inspections.results, path, labelKey, options, slotted);
  }

  public _optionLabel(key: string, fallback: string): string {
    const t = getLocalizeFunction(this.hass);
    return t.has(key) ? t(key) : fallback;
  }

  // --- Issues & Validation -------------------------------------------------

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
      energy_nodes: { errors: 0, warnings: 0 },
      training: { errors: 0, warnings: 0 },
      automation: { errors: 0, warnings: 0 },
      devices: { errors: 0, warnings: 0 },
      visualization: { errors: 0, warnings: 0 },
    };

    if (this._validation) {
      for (const issue of this._validation.errors) {
        counts[this._issueTab(issue)].errors += 1;
      }
      for (const issue of this._validation.warnings) {
        counts[this._issueTab(issue)].warnings += 1;
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

  /** The tab an issue is shown on. */
  private _issueTab(issue: ValidationIssue): TabId {
    return TAB_SECTIONS[issue.section] ?? "energy_nodes";
  }

  // --- Config load / save / validate ---------------------------------------

  private async _loadConfig(options: { showMessage: boolean }): Promise<void> {
    if (!this.hass) {
      return;
    }
    this._loading = true;
    try {
      const [
        loadedResult,
        liveApplianceMetadataResult,
        schemaResult,
        defaultsResult,
      ] = await Promise.allSettled([
        this._configSession.load(),
        this._automationTab.loadLiveApplianceMetadata(),
        fetchOptimizerSchema(this.hass),
        fetchConfigDefaults(this.hass),
      ]);
      if (loadedResult.status !== "fulfilled") {
        throw loadedResult.reason;
      }
      const loadedConfig = loadedResult.value.doc;
      this._config = loadedConfig ? cloneJson(loadedConfig) : {};
      this._savedConfig = loadedConfig ? cloneJson(loadedConfig) : {};
      if (this._trainingTab.deviceTreeRequested) void this._trainingTab.loadDeviceTree();
      this._staleConfigNotice = false;
      this._automationTab.liveApplianceMetadata =
        liveApplianceMetadataResult.status === "fulfilled"
          ? liveApplianceMetadataResult.value
          : null;
      this._automationTab.schema =
        schemaResult.status === "fulfilled" ? schemaResult.value : null;
      this._configDefaults =
        defaultsResult.status === "fulfilled" ? defaultsResult.value : null;
      this._validation = null;
      this._dirty = this._config
        ? this._automationTab.normalizeApplianceOptimizerTargets(this._config)
        : false;
      this._resetScopeYamlState();
      void this._validateLoadedConfig(this._config);
      if (options.showMessage) {
        this._message = {
          kind: "info",
          text: this._t("editor.messages.reloaded_config"),
        };
      }
    } catch (error) {
      this._automationTab.liveApplianceMetadata = null;
      this._message = {
        kind: "error",
        text: formatError(error, this._t("editor.messages.load_config_failed")),
      };
    } finally {
      this._loading = false;
    }
  }

  private async _validateLoadedConfig(draft: JsonObject | null): Promise<void> {
    if (!this.hass || !draft) return;
    const generation = ++this._validationGeneration;
    try {
      const validation = await callHelman(this.hass, "helman/validate_config", {
        config: cloneJson(draft),
      });
      if (this._config === draft && this._validationGeneration === generation) {
        this._validation = validation;
      }
    } catch {
      // A failed background check must not replace the loaded document.
    }
  }

  /**
   * The draft as it is sent: a phase on a device that cannot carry one is
   * wiring that cannot exist, so it is dropped from what is validated and
   * saved. Never from the draft while editing, so a parent switched back to
   * `3ph` before saving keeps its children's phases.
   */
  private _prunedConfig(): { config: JsonObject; pruned: boolean } {
    const config = cloneJson(this._config!);
    return { config, pruned: pruneUnassignablePhases(config) };
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
    ++this._validationGeneration;
    this._validating = true;
    try {
      const validation = await callHelman(this.hass, "helman/validate_config", {
        config: this._prunedConfig().config,
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
        text: formatError(error, this._t("editor.messages.validate_config_failed")),
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
    const { config } = this._prunedConfig();
    const draftAtSave = canonicalJson(this._config);
    ++this._validationGeneration;
    this._saving = true;
    try {
      const outcome = await this._configSession.save(config);
      if (outcome.kind === "conflict") {
        this._staleConfigNotice = true;
        this._message = { kind: "error", text: this._t("editor.status.changed_elsewhere") };
        return;
      }
      if (outcome.kind === "error" && outcome.error) throw outcome.error;
      const response = outcome.response;
      this._validation = response?.validation ?? null;
      if (outcome.kind === "saved") {
        this._savedConfig = cloneJson(outcome.doc);
        if (canonicalJson(this._config) === draftAtSave) {
          this._config = cloneJson(outcome.doc);
          this._scopeYamlValues = {};
          this._devicesTab.list.deviceYamlValues = {};
        }
        this._staleConfigNotice = false;
        const normalized = this._config
          ? this._automationTab.normalizeApplianceOptimizerTargets(this._config)
          : false;
        this._dirty = normalized || canonicalJson(this._config) !== canonicalJson(outcome.doc);
      }
      if (response?.success) {
        this._automationTab.liveApplianceMetadata = await this._automationTab.loadLiveApplianceMetadata();
        if (this._trainingTab.deviceTreeRequested) void this._trainingTab.loadDeviceTree();
        const normalized = this._config
          ? this._automationTab.normalizeApplianceOptimizerTargets(this._config)
          : false;
        this._dirty = this._dirty || normalized;
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
          response?.reloadError ??
          (response?.validation?.valid
            ? this._t("editor.messages.config_saved_reload_failed")
            : this._t("editor.messages.save_rejected")),
      };
    } catch (error) {
      this._message = {
        kind: "error",
        text: formatError(error, this._t("editor.messages.save_failed")),
      };
    } finally {
      this._saving = false;
      const revision = this._configRevisionDuringSave;
      this._configRevisionDuringSave = undefined;
      if (revision !== undefined) void this._reactToDataChanged(revision);
    }
  }

  private _handleReloadClick = async (): Promise<void> => {
    if (this._saving) return;
    if (
      (this._dirty || this._hasBlockingYamlErrors()) &&
      !window.confirm(this._t("editor.confirm.discard_changes"))
    ) {
      return;
    }
    await this._loadConfig({ showMessage: true });
  };

  private _guardCloseWhileSaving = (event: BeforeUnloadEvent): void => {
    if (!this._saving) return;
    event.preventDefault();
    event.returnValue = "";
  };

  private _handleValidateClick = async (): Promise<void> => {
    await this._validateConfig();
  };

  private _handleSaveClick = async (): Promise<void> => {
    await this._saveConfig();
  };

  // --- Mutating & Session helpers ------------------------------------------

  public _applyMutation(mutator: (draft: JsonObject) => void | boolean): void {
    const draft = cloneJson(this._config ?? {});
    if (mutator(draft) === false) return;
    this._config = draft;
    this._markDraftChanged();
  }

  public _markDraftChanged(): void {
    this._devicesTab.energyImport = null;
    this._dirty = true;
    this._validation = null;
    this._message = null;
    this._inspections.request();
  }

  public _getValue(path: PathSegment[]): unknown {
    if (!this._config) {
      return undefined;
    }
    return getValueAtPath(this._config, path);
  }

  public _moveListItem(path: PathSegment[], fromIndex: number, toIndex: number): void {
    this._applyMutation((draft) => {
      moveListItem(draft, path, fromIndex, toIndex);
    });
  }

  public _removeListItem(path: PathSegment[], index: number): void {
    this._applyMutation((draft) => {
      removeListItem(draft, path, index);
    });
  }

  public _setRequiredString(path: PathSegment[], rawValue: string): void {
    setRequiredString(this, path, rawValue);
  }

  public _openHelp = (labelKey: string, contentKey: string): void => {
    this._helpDialog = { labelKey, contentKey };
  };

  private _closeHelp = (): void => {
    this._helpDialog = null;
  };

  public _t(key: string, values?: Record<string, string | number>): string {
    return (this._localize ?? this._fallbackLocalize)(key, values);
  }
}
