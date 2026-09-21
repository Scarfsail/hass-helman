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
  configDefaultHint,
  configDefaultValue,
  fetchConfigDefaults,
  type ConfigDefaults,
} from "../cards/shared/config/config-defaults";
import {
  buildControllableSelectionState,
  buildClimateModeFieldState,
} from "../cards/shared/optimizer/controllable-target-ui";
import {
  DOCUMENT_SCOPE_ID,
  SECTION_ICONS,
  SECTION_SCOPE_IDS,
  DIAGNOSTICS_ICON,
  TAB_ICONS,
  TAB_SCOPE_IDS,
  TAB_SECTIONS,
  TABS,
  TRAINING_JOB_ICONS,
  type EditorMode,
  getDescendantScopeIds,
  getScope,
  type ScopeId,
  type TabId,
} from "./config-editor-scopes";
import { getSharedDataChangedFeed } from "../cards/helman/data-changed";
import { getLocalizeFunction, type LocalizeFunction } from "../cards/shared/config/localize/localize";
import { mdiAlertOutline } from "@mdi/js";
import {
  fetchOptimizerSchema,
  type OptimizerConfigBucket,
  type OptimizerSchema,
  type OptimizerSchemaDocument,
} from "../cards/shared/optimizer/optimizer-schema";
import { loadHaForm, loadHaSortable, loadHaYamlEditor } from "./load-ha-elements";
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
import {
  parseItemYaml,
  renderItemModeToggle,
  renderItemYamlEditor,
  type YamlEditorValueChangedDetail,
} from "../cards/shared/config/item-yaml";
import {
  renderDragHandle,
  renderRemoveButton,
  renderSortableList,
} from "../cards/shared/config/sortable-list";
import { optimizerCardStyles } from "../cards/shared/optimizer/optimizer-styles";
import type { OptimizerConfigChangedDetail } from "../cards/shared/optimizer/helman-optimizer-editor";
import "../cards/shared/optimizer/helman-optimizer-editor";
import {
  TRAINING_STATUS_CHANGED,
  asTrainingStatus,
  type TrainingStatus,
  type TrainingStatusChangedDetail,
} from "./training-status";
import {
  INSPECTOR_CARD_TAG,
  SOLAR_INSPECTOR_EMBED_CONFIG,
  inspectorCardLoader,
  type SolarInspectorCardElement,
} from "./solar-inspector-embed";
import "./info-callout";
import "./entity-group";
import {
  ENTITY_GROUP_CONNECTED,
  ENTITY_GROUP_REVERT,
  entityGroupKey,
  type EntityFact,
  type EntityGroupRevertDetail,
  type EntityInspectionResult,
  type HelmanEntityGroup,
} from "./entity-group";
import type {
  HomeAssistantLike,
  JsonObject,
  JsonValue,
  PathSegment,
  ApplianceMetadataResponse,
  SaveConfigResponse,
  StatusMessage,
  ValidationReport,
} from "../cards/shared/config/types";
import type { ScopeAdapterValidationError } from "./config-scope-adapters";
import { normalizeYamlValue } from "../cards/shared/config/yaml-codec";

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

/** The two config buckets `automation` splits its optimizers into (#271, P1). */
type OptimizerBucket = OptimizerConfigBucket;

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

/**
 * How often the editor asks `helman/training/status`, for the Training tab's
 * panels and its tab-bar badge alike. Slower than the entity poll: a training
 * run takes minutes, and the answer is read from memory on every tick.
 */
const TRAINING_STATUS_INTERVAL_MS = 5000;

/**
 * Every match under `root`, including the ones inside nested shadow roots.
 *
 * `querySelectorAll` does not cross a shadow boundary, and the editor renders
 * part of itself through child elements that have one. Anything looking for
 * "all the groups on screen" has to walk.
 */
function queryDeep<T extends Element>(root: ParentNode | null | undefined, selector: string): T[] {
  if (!root) return [];
  const found: T[] = [...root.querySelectorAll<T>(selector)];
  for (const element of root.querySelectorAll("*")) {
    if (element.shadowRoot) {
      found.push(...queryDeep<T>(element.shadowRoot, selector));
    }
  }
  return found;
}

/**
 * How long an immediate re-read waits before it can fire again.
 *
 * Every write into the draft asks for a fresh reading, because a reading the
 * user just invalidated is worse than no reading -- flipping a polarity and
 * watching the old direction sit there for two seconds reads as a control that
 * did nothing. But text fields write on every keystroke, and one whole config
 * document per character is not a poll, it is a flood.
 *
 * So the trigger is leading-edge: the *first* change of a burst goes out at
 * once -- which is every discrete change, a select or a picker -- and anything
 * that arrives inside the window is collapsed into a single trailing call once
 * it closes. A click costs no delay at all.
 *
 * The window has to outlast a keystroke to be worth anything. Ordinary typing
 * runs 150-300 ms per character, so a shorter window would put every character
 * on its own leading edge and send exactly the flood it was meant to stop --
 * a synthetic burst of writes with no gaps is the only case a short window
 * actually covers, and no user types that way.
 */
const ENTITY_INSPECTION_DEBOUNCE_MS = 400;

const APPLIANCE_ICON_SELECTOR = {
  icon: {},
} as const;

// DUMMY: reuse Home Assistant's visual condition builder. Value is not persisted
// yet — this only proves the editor renders and round-trips inside our panel.
const OPTIMIZER_CONDITION_SELECTOR = {
  condition: {},
} as const;

/** One row of a training tab depth table -- see `_renderTrainingDepthTable`. */
interface TrainingDepthRow {
  /** Already localized, or (for a controllable) the reader's own name. */
  label: string;
  /** Where the entity id lives -- also the key `_entityInspections` is read by. */
  path: PathSegment[];
  /** i18n key for what the trainer takes from this entity. */
  roleKey: string;
  /** Substituted into the role text, e.g. an appliance's own lookback. */
  roleParams?: Record<string, string | number>;
  /** Override shared inspection severity with this consumer's own minimum. */
  requiredDays?: number;
  /**
   * True for an entity Helman publishes rather than one the config points at.
   *
   * Its `path` names nothing in the document, so the "is this picker actually
   * set" filter on the poll would drop it -- correctly for every other row, and
   * wrongly for this one, whose entity exists whatever the draft says.
   */
  ownEntity?: boolean;
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
    _haLabelNames: { state: true },
    _optimizerSchema: { state: true },
    _configDefaults: { state: true },
    _helpDialog: { state: true },
    _entityInspections: { state: true },
    _entitiesOnly: { state: true },
    _trainingStatus: { state: true },
    _inspectorCardError: { state: true },
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

    /* One badge text, one line: label, text, remove -- wrapping only when the
       card is too narrow to hold them. The two columns are named once, in a
       head row, rather than labelled on every row. */
    .label-entry-rows {
      display: grid;
      gap: 8px;
      padding: 0 16px 8px;
    }

    .label-entry-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }

    .label-entry-row > .label-key-cell {
      flex: 2 1 220px;
      min-width: 150px;
    }

    /* The badge text is usually a single emoji, so it takes what is left over
       rather than half the row. */
    .label-entry-row > .badge-text-cell {
      flex: 1 1 120px;
      min-width: 100px;
      max-width: 240px;
    }

    .label-entry-row > .list-actions {
      margin-left: auto;
      flex: 0 0 auto;
    }

    .label-entry-head label {
      font-weight: 600;
      font-size: 0.93rem;
      color: var(--secondary-text-color);
    }

    /* Holds the head row's columns over the ones below it, where the remove
       button sits. Its width is the button's: 18px glyph plus its padding. */
    .label-entry-actions-spacer {
      flex: 0 0 auto;
      width: 32px;
    }

    /* The category name is the card's title, so it is edited where it is read
       rather than in a field below the header. */
    .category-key-input {
      font-size: 1rem;
      font-weight: var(--ha-font-weight-medium, 500);
      border-radius: 12px;
      border: 1px solid var(--divider-color);
      background: var(--secondary-background-color);
      color: var(--primary-text-color);
      padding: 8px 12px;
      max-width: 320px;
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

    .tab-warning-dot {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--error-color, #db4437);
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

    .section-summary-badge {
      display: flex;
      align-items: center;
      margin-left: auto;
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

    .toggle-field .field-label-row ha-formfield {
      flex: 1;
      min-width: 0;
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

    /*
     * The training tab's per-entity depth tables.
     *
     * A horizontal scroller of its own -- a long entity id plus six numeric
     * columns does not fit a narrow panel, and the page itself must never
     * gain a horizontal scrollbar because of one table inside it.
     */
    .training-depth-table-wrap {
      overflow-x: auto;
      margin-top: 4px;
    }

    .training-depth-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.86rem;
    }

    .training-depth-table th,
    .training-depth-table td {
      padding: 6px 10px;
      text-align: left;
      vertical-align: top;
      border-bottom: 1px solid var(--divider-color);
    }

    /* Nested two panels deep since #313 (job panel, then Diagnostics), so a
       phone has less width to give; tighter cells keep it from scrolling. */
    @media (max-width: 600px) {
      .training-depth-table th,
      .training-depth-table td {
        padding: 6px 5px;
      }
    }

    /* Only the digits hold a line. Everything else -- the prose, the entity
       ids, and these columns' own two-word headings -- wraps, so a narrow
       screen makes the table taller instead of pushing it sideways. */
    .training-depth-table th.training-depth-number,
    .training-depth-table td.training-depth-number {
      text-align: right;
    }

    .training-depth-table td.training-depth-number {
      white-space: nowrap;
    }

    .training-depth-table th {
      color: var(--secondary-text-color);
      font-weight: 600;
    }

    .training-depth-label {
      font-weight: 600;
    }

    .training-depth-entity-id {
      color: var(--secondary-text-color);
      font-size: 0.82rem;
      /* Entity ids are long and have no spaces to break at. */
      overflow-wrap: anywhere;
    }

    /* The name and id, as one target for HA's more-info dialog. A button so
       it is reachable by keyboard and announced as an action; styled back
       down to the plain two-line cell it replaces. */
    .training-depth-entity-button {
      display: block;
      width: 100%;
      padding: 0;
      border: none;
      background: none;
      font: inherit;
      color: inherit;
      text-align: left;
      cursor: pointer;
    }

    /* The id is as much the target as the name -- it is the part a reader
       recognises -- so both take the hover treatment, not just the heading. */
    .training-depth-entity-button:hover .training-depth-label,
    .training-depth-entity-button:hover .training-depth-entity-id,
    .training-depth-entity-button:focus-visible .training-depth-label,
    .training-depth-entity-button:focus-visible .training-depth-entity-id {
      color: var(--primary-color);
      text-decoration: underline;
    }

    .training-depth-entity-button:focus-visible {
      outline: 2px solid var(--primary-color);
      outline-offset: 2px;
    }

    .training-depth-unset {
      font-style: italic;
    }

    /* Entity names and ids. A share of the table rather than a width in ch,
       because the overflow-wrap: anywhere below drops the column's intrinsic
       width to a single character -- auto layout would otherwise hand the
       whole table to the prose column and break every id across four lines. */
    .training-depth-table td:first-child,
    .training-depth-table th:first-child {
      width: 26%;
    }

    /* The one column that is prose: it takes what the rest leaves and wraps
       inside it, so the table never needs horizontal scrolling. */
    .training-depth-role {
      color: var(--secondary-text-color);
    }

    /* Same hue the entity-group badge uses when a row's spliced depth falls
       short of its requirement. On the row rather than one cell since #186:
       it is the pair of columns that is short, not either one of them. The
       two cells that declare their own colour need it unset explicitly -- a
       declared value beats an inherited one whatever the selector's
       specificity, so without this the role and the entity id stay grey and
       the row reads as half-marked. */
    tr.training-depth-warn {
      color: var(--warning-color, #ffa600);
      font-weight: 600;
    }

    tr.training-depth-warn .training-depth-role,
    tr.training-depth-warn .training-depth-entity-id {
      color: inherit;
    }

    /* A collapsed Diagnostics panel's header: something inside is short or
       reported an issue. An icon, not a count -- the two sources overlap. */
    .training-attention {
      display: flex;
    }

    .training-attention-icon {
      width: 20px;
      height: 20px;
      fill: var(--warning-color, #ffa600);
    }

    .section-footer {
      display: flex;
      justify-content: flex-start;
      margin-top: 4px;
    }

    .entities-only-toggle {
      /* The toolbar packs to the right; this one control belongs on the left,
         away from the tab's YAML toggle it must not be mistaken for. */
      margin-right: auto;
    }

    /*
     * The entities-only view.
     *
     * Everything that is not an entity group goes away, and every container
     * left holding no group goes with it -- otherwise the view is a column of
     * empty section headings, which is the noise this exists to remove.
     *
     * :has() is what makes that possible without threading a "contains a
     * group" flag down every render path, and it is why the sections are forced
     * open by an attribute rather than by CSS: a closed details renders no
     * content at all, so :has() could not find a group inside one and every
     * collapsed section would hide itself.
     *
     * The guard against a group's *own* fields is the pair of rules at the end.
     * A group's slotted settings -- a polarity, a history-day count -- are not
     * in its shadow root; they are children of <helman-entity-group> in this
     * element's tree, which is exactly where .entities-only .field reaches.
     * Hiding them would leave every group showing a picker and a reading with
     * the settings that qualify it gone, which is the opposite of the point.
     */
    .entities-only .field,
    .entities-only .field-grid:not(:has(helman-entity-group)),
    .entities-only .list-stack:not(:has(helman-entity-group, .scope-yaml)),
    .entities-only .list-card:not(.scope-yaml):not(:has(helman-entity-group, .scope-yaml)),
    .entities-only details.section-card:not(.scope-yaml):not(:has(helman-entity-group, .scope-yaml)),
    .entities-only .inline-note,
    .entities-only helman-info-callout,
    .entities-only .section-footer,
    .entities-only .mode-toggle {
      display: none;
    }

    .entities-only helman-entity-group .field,
    .entities-only helman-entity-group .field-grid {
      display: grid;
    }

    .entities-only helman-entity-group .toggle-field {
      display: block;
    }

    /*
     * A scope left in YAML mode is kept, editor and all.
     *
     * It renders a code editor instead of fields, so it holds no group and
     * every rule above would sweep it away -- and the rule that hides the
     * per-section mode toggles would take away the only control that could
     * switch it back. A user who left the Battery section in YAML mode and
     * later turns this view on to audit their entities would be shown a tab
     * with the battery silently missing from it and no way to find out.
     *
     * The promise is "nothing missed", not "nothing I can introspect". The
     * entity ids are right there in the YAML, so the honest answer is to show
     * the scope as it is and leave its toggle working.
     */
    .entities-only details.scope-yaml {
      display: block;
    }

    .entities-only .scope-yaml .yaml-surface,
    .entities-only .scope-yaml .yaml-field {
      display: grid;
    }

    .entities-only .scope-yaml > summary .mode-toggle {
      display: inline-flex;
    }

    /*
     * "There are no entities here", said only when it is true.
     *
     * The same :has() that hides the empty sections decides this, which is
     * what keeps the two from ever disagreeing: the message appears exactly
     * when every section on the tab has been hidden. Being a CSS question
     * rather than a piece of state also means it cannot flash before the first
     * inspection poll -- it is about whether the tab *configures* an entity,
     * not about whether a reading has arrived for one -- and a scope left in
     * YAML mode counts as content, because its entity ids are on screen even
     * though no group is.
     */
    .entities-only-empty {
      display: none;
    }

    .entities-only:not(:has(helman-entity-group, .scope-yaml)) > .entities-only-empty {
      display: block;
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
  /**
   * The panel registration Home Assistant renders us from.
   *
   * `config` is the backend-controlled blob `async_register_panel` passed, and
   * the only thing read out of it is the version-stamped card bundle URL the
   * solar Diagnostics embed imports.
   */
  declare panel?: { config?: { card_module_url?: string } | null };

  private _hass?: HomeAssistantLike;
  private _localize?: LocalizeFunction;
  private readonly _fallbackLocalize = getLocalizeFunction();
  private _activeTab: TabId = "power_devices";
  /**
   * Reduce every tab to nothing but its entity groups.
   *
   * Session-only on purpose: it lives for as long as the panel is mounted and
   * comes back off on the next visit. This is an auditing mode, not a way to
   * configure Helman -- persisting it in localStorage or in the stored
   * document would make "half the editor is missing" a state a user could
   * arrive in without having asked for it, and nothing here forecloses adding
   * that later if the view turns out to be where they live.
   */
  private _entitiesOnly = false;
  /**
   * What each section looked like just before the toggle forced it open, so
   * turning the toggle off puts it back.
   *
   * Keyed by the element itself, and a `WeakMap` on purpose: a tab switch
   * detaches a whole tab's worth of `details` and renders new ones, and every
   * one of them wants an entry of its own. A `Map` would hold the detached
   * nodes alive for the life of the panel to answer a question nobody will ask
   * again; restoring only ever looks a *currently rendered* section up, so
   * weak references are exactly the right strength.
   */
  private _sectionOpenBeforeEntitiesOnly = new WeakMap<HTMLDetailsElement, boolean>();
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
  // The names of the labels configured in Home Assistant, for the badge-text
  // picker. `null` means "not loaded" -- a registry that could not be read
  // leaves the stored keys editable as free text rather than hiding them.
  private _haLabelNames: string[] | null = null;
  // Optimizer schema, served by the backend. Fetched alongside the config
  // the editor already awaits on open, so it costs no extra latency.
  private _optimizerSchema: OptimizerSchemaDocument | null = null;
  // What the backend applies where a field is left unset, by dotted path.
  // Drawn as placeholder text, never written: `null` just means no hints.
  private _configDefaults: ConfigDefaults | null = null;
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
  private _inspectionTimer?: ReturnType<typeof setInterval>;
  /** Open while a burst is being coalesced; see the debounce constant. */
  private _inspectionDebounce?: ReturnType<typeof setTimeout>;
  /** Something changed while the window was open, so send once more at its end. */
  private _inspectionTrailing = false;
  /**
   * Request ids, so a slow answer cannot overwrite a newer one.
   *
   * Requests are allowed to overlap rather than being serialised behind an
   * in-flight flag: dropping a request because an older one is still out would
   * drop exactly the state the user just typed, which is the bug this whole
   * mechanism exists to prevent. Instead every request takes the next id and
   * only an id newer than the last one applied may reach the screen -- a
   * response that arrives out of order is discarded, not rendered.
   */
  private _inspectionSequence = 0;
  private _inspectionApplied = 0;
  /**
   * How many requests are out.
   *
   * Ordering is the sequence numbers' job; this is the separate concern of not
   * piling up. The interval restarts when a request *starts*, so a websocket
   * that has stalled -- HA reconnecting, a slow handler -- would otherwise put
   * another whole config document on the wire every two seconds with nothing
   * capping the pile. The idle tick yields while one is out; a poll the user
   * caused never does, because dropping that one drops the state they just
   * typed.
   */
  private _inspectionInFlight = 0;

  // --- Training status -------------------------------------------------------
  //
  // One poll feeds both the Training tab's panels and its tab-bar badge, so the
  // badge shows a failure without the tab being open. `null` until the first
  // answer, and kept on a failed tick like the entity poll's last reading.
  private _trainingStatus: TrainingStatus | null = null;
  /**
   * The one-shot loader for the card artifact, and the one card built from it.
   *
   * Both survive the section being collapsed and reopened: the loader so the
   * artifact is fetched and evaluated once, the element so reopening shows the
   * day the reader had paged to rather than refetching it. Created on the first
   * open of the solar Diagnostics panel and never on a `hass` tick -- see
   * `_handleSolarDiagnosticsToggle`.
   */
  private _inspectorCardLoad?: () => Promise<void>;
  /**
   * Whether the reader has opened the panel at all.
   *
   * Separate from the loader, because the loader can be a no-op: Home Assistant
   * loads every Lovelace resource the first time any dashboard renders, so on the
   * ordinary path into this page -- Overview, then Helman in the sidebar -- the
   * card tag is already registered and there is nothing to load. Mounting on
   * "the tag exists" would then mount the card inside the closed panel, with its
   * clock, its listeners and a day fetch, which is the whole thing this is lazy
   * to avoid. The open is the signal; loading is only what may follow it.
   */
  private _inspectorRequested = false;
  private _inspectorCard?: SolarInspectorCardElement;
  private _inspectorCardError: string | null = null;
  private _trainingStatusTimer?: ReturnType<typeof setInterval>;
  private _trainingStatusSequence = 0;
  private _trainingStatusApplied = 0;

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
    this.addEventListener(ENTITY_GROUP_REVERT, this._handleEntityGroupRevert);
    this._restartEntityInspectionTimer();
    this._trainingStatusTimer = setInterval(
      () => void this._pollTrainingStatus(),
      TRAINING_STATUS_INTERVAL_MS,
    );
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
    this.removeEventListener(ENTITY_GROUP_REVERT, this._handleEntityGroupRevert);
    if (this._inspectionTimer !== undefined) {
      clearInterval(this._inspectionTimer);
      this._inspectionTimer = undefined;
    }
    if (this._inspectionDebounce !== undefined) {
      clearTimeout(this._inspectionDebounce);
      this._inspectionDebounce = undefined;
    }
    this._inspectionTrailing = false;
    if (this._trainingStatusTimer !== undefined) {
      clearInterval(this._trainingStatusTimer);
      this._trainingStatusTimer = undefined;
    }
  }

  protected updated(changedProperties: PropertyValues<this>): void {
    super.updated(changedProperties);
    if (!this._hasLoadedOnce && this.hass) {
      this._hasLoadedOnce = true;
      void this._loadConfig({ showMessage: false });
      void this._pollTrainingStatus();
    }
    if (this.hass && !this._unsubscribeDataChanged) {
      this._unsubscribeDataChanged = getSharedDataChangedFeed(this.hass).subscribe(
        () => this._handleDataChanged(),
      );
    }
    // Every update while the toggle is on, and once more on the update that
    // turns it off -- see `_applyEntitiesOnlyOpenState` for why "every".
    if (this._entitiesOnly || changedProperties.has("_entitiesOnly")) {
      this._applyEntitiesOnlyOpenState();
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
                // The training tab's depth table asks about entities no
                // mounted `helman-entity-group` announces -- nothing else
                // triggers a poll on a plain tab switch, so this one does.
                if (tab.id === "training") {
                  this._requestEntityInspection();
                }
              }}
            >
              ${this._renderSvgIcon(TAB_ICONS[tab.id], "tab-icon")}
              <span>${this._t(tab.labelKey)}</span>
              ${tab.id === "training" ? this._renderTrainingBadge() : nothing}
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

  /**
   * A dot on the Training tab while any job's health is `failed`.
   *
   * Not for `degraded`: `insufficient_history` is the normal state of a fresh
   * install for weeks, and a badge that is always on says nothing.
   */
  private _renderTrainingBadge(): TemplateResult | typeof nothing {
    if (!this._trainingStatus?.anyFailed) return nothing;
    const failed = this._trainingStatus.jobs.filter((job) => job.health === "failed").length;
    return html`<span
      class="tab-warning-dot"
      role="img"
      aria-label=${this._tFormat("training.badge_failed", { count: failed })}
    ></span>`;
  }

  private async _pollTrainingStatus(): Promise<void> {
    if (!this.hass) return;
    const sequence = ++this._trainingStatusSequence;
    try {
      const status = asTrainingStatus(
        await this.hass.callWS<unknown>({ type: "helman/training/status" }),
      );
      // A slower earlier answer must not repaint over a newer one.
      if (sequence < this._trainingStatusApplied) return;
      this._trainingStatusApplied = sequence;
      if (status) this._trainingStatus = status;
    } catch {
      // Polled: a dropped tick keeps the last status on screen.
    }
  }

  /** A Train now finished: take the status it returned, or ask for one. */
  private _handleTrainingStatusChanged = (
    event: CustomEvent<TrainingStatusChangedDetail>,
  ): void => {
    const status = event.detail.status;
    if (status) {
      this._trainingStatusApplied = ++this._trainingStatusSequence;
      this._trainingStatus = status;
    } else {
      void this._pollTrainingStatus();
    }
  };

  private _renderActiveTab(): TemplateResult {
    switch (this._activeTab) {
      case "visualization":
        return this._renderTabScope(
          TAB_SCOPE_IDS.visualization,
          this._renderVisualizationTab(),
        );
      case "power_devices":
        return this._renderTabScope(
          TAB_SCOPE_IDS.power_devices,
          this._renderPowerDevicesTab(),
        );
      case "training":
        return this._renderTabScope(TAB_SCOPE_IDS.training, this._renderTrainingTab());
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

  /**
   * The entities-only switch, in every tab's toolbar.
   *
   * On every tab rather than only on Power devices, which is where the noise
   * complaint came from: the mechanism is a CSS class and a `:has()` selector
   * that know nothing about which tab they are on, and gating it to one tab
   * would be more code than leaving it general. A tab whose sections hold no
   * group simply empties, which is an honest answer to "show me the entities
   * here".
   *
   * It sits *outside* `.tab-body`, so the rules it turns on cannot hide the
   * control that turned them on -- and beside the tab's own YAML toggle, which
   * is the other control that changes what this whole tab renders.
   */
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

  /**
   * Every `details` the current tab body renders.
   *
   * Deliberately *not* a shadow-crossing walk, unlike `_mountedEntityGroups`.
   * These are the editor's own section cards; a `details` inside a child
   * element's shadow root belongs to that element and is not this panel's to
   * force open. See `_applyEntitiesOnlyOpenState` for what that costs.
   */
  private _tabBodyDetails(): HTMLDetailsElement[] {
    const body = this.shadowRoot?.querySelector(".tab-body");
    return body ? [...body.querySelectorAll<HTMLDetailsElement>("details")] : [];
  }

  private _setEntitiesOnly(next: boolean): void {
    if (next === this._entitiesOnly) return;
    this._entitiesOnly = next;
  }

  /**
   * Open every section while the toggle is on; put them back when it goes off.
   *
   * This is done to the DOM rather than through an `?open` binding, and the
   * reason is that a binding cannot answer the question the restore needs.
   * Lit writes an attribute only when the bound value changes, so a section the
   * user has collapsed by hand would be left collapsed by a binding on the
   * toggle -- and the `details.list-card` a controllable renders has no `open`
   * binding at all, so nothing would open it and nothing would close it again.
   *
   * It runs on **every** update, not only when the toggle or the tab changes,
   * because content appears while the toggle is on for reasons neither of those
   * covers: switching a scope out of YAML mode renders a whole fresh tab body,
   * and adding an appliance renders one more card. A section that arrives
   * collapsed is not merely inconvenient here -- a closed `details` renders no
   * content, so `:has()` finds no group inside it and the view hides it
   * outright. Coming up empty is the one failure this feature cannot have.
   *
   * Running every time is safe because the map is also the record of what has
   * already been dealt with: a section already in it is left exactly as it is,
   * so collapsing one by hand while the toggle is on sticks, and the 2 s
   * inspection poll does not reopen it.
   */
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

  private _renderSectionScope(
    scopeId: ScopeId,
    content: TemplateResult,
    options: { initialOpen?: boolean } = {},
  ): TemplateResult {
    const scope = getScope(scopeId);
    const { initialOpen = true } = options;
    const sectionIcon = SECTION_ICONS[scopeId];
    const chevronPath = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";
    // A scope in YAML mode renders a code editor holding entity ids as text,
    // which no `:has()` can see. Marked so the entities-only view keeps it --
    // see `.scope-yaml` in the styles for why hiding it would be a lie.
    const sectionClasses = this._isScopeYaml(scopeId)
      ? "section-card scope-yaml"
      : "section-card";

    return html`
      <details class=${sectionClasses} ?open=${initialOpen}>
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

  /**
   * A plain panel: no YAML scope behind it, so no visual/YAML toggle. `icon`
   * is an SVG path shown before the label; `badge` sits in the summary row
   * just before the chevron.
   *
   * `onToggle` hears the panel being opened and closed. A collapsed `details`
   * renders its content all the same, so anything that must not run until a
   * reader asks for it -- a fetch, a lazily loaded bundle -- has to hang off
   * this rather than off the template.
   */
  private _renderSimpleSection(
    label: string,
    content: TemplateResult,
    options: {
      open?: boolean;
      icon?: string;
      badge?: TemplateResult;
      onToggle?: (open: boolean) => void;
    } = {},
  ): TemplateResult {
    const { open = true, icon, badge, onToggle } = options;
    const chevronPath = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";
    return html`
      <details
        class="section-card"
        ?open=${open}
        @toggle=${onToggle
          ? (event: Event) => onToggle((event.target as HTMLDetailsElement).open)
          : nothing}
      >
        <summary>
          <div class="section-summary-row">
            <div class="section-summary-left">
              ${icon ? this._renderSvgIcon(icon, "section-icon") : nothing}
              <span class="section-summary-label">${label}</span>
            </div>
            ${badge ? html`<div class="section-summary-badge">${badge}</div>` : nothing}
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
    return renderItemModeToggle(this, this._getControllableMode(index), (mode) => {
      if (mode === "yaml") {
        void this._enterControllableYamlMode(index);
      } else {
        this._exitControllableYamlMode(index);
      }
    });
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

  /**
   * Move a controllable, and return the whole list to visual mode.
   *
   * `_controllableModes`, `_controllableYamlValues` and `_controllableYamlErrors`
   * are keyed by list index, so a move or a remove leaves them describing a
   * different card than the one they were opened on -- which is what today's
   * remove already does. Clearing all three is one rule that cannot go stale,
   * where remapping every key through every move and remove would be a lot more
   * code for a rare interaction. Nothing is lost but YAML text that does not
   * parse yet: the draft already holds the last value that did.
   */
  private _moveControllable(fromIndex: number, toIndex: number): void {
    this._resetControllableModes();
    this._moveListItem(["controllables"], fromIndex, toIndex);
  }

  private _removeControllable(index: number): void {
    this._resetControllableModes();
    this._removeListItem(["controllables"], index);
  }

  private _resetControllableModes(): void {
    this._controllableModes = {};
    this._controllableYamlValues = {};
    this._controllableYamlErrors = {};
  }

  private _handleControllableYamlChanged(
    index: number,
    detail: YamlEditorValueChangedDetail,
  ): void {
    const parsed = parseItemYaml(detail);
    if (!parsed.ok) {
      this._controllableYamlErrors = {
        ...this._controllableYamlErrors,
        [index]: detail.errorMsg ?? this._t(parsed.errorKey),
      };
      return;
    }
    try {
      const nextConfig = cloneJson(this._config ?? {});
      setValueAtPath(nextConfig, ["controllables", index], cloneJson(parsed.value));
      this._config = nextConfig as JsonObject;
      this._dirty = true;
      this._validation = null;
      this._message = null;
      this._controllableYamlValues = { ...this._controllableYamlValues, [index]: parsed.value };
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
    return renderItemYamlEditor(this, {
      id: `controllable-${index}`,
      value: (this._controllableYamlValues[index] ??
        this._getValue(["controllables", index])) as JsonValue,
      error: this._controllableYamlErrors[index],
      onChange: (detail) => this._handleControllableYamlChanged(index, detail),
    });
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

  /**
   * The label a YAML editor announces itself by. Four sections share the
   * label "Forecast" -- one per power device -- so a section's own label
   * only tells them apart together with the section it sits in, which is
   * what the visual nesting shows and a screen reader otherwise misses.
   */
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

  private _renderVisualizationTab(): TemplateResult {
    return html`
      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.visualization.card_labels_and_history,
        html`
          <div class="field-grid">
            ${this._renderOptionalNumberField(
              ["visualization", "history_buckets"],
              "editor.fields.history_buckets",
              "editor.helpers.history_buckets",
              "editor.help.history_buckets",
            )}
            ${this._renderOptionalNumberField(
              ["visualization", "history_bucket_duration"],
              "editor.fields.history_bucket_duration",
              "editor.helpers.history_bucket_duration",
              "editor.help.history_bucket_duration",
            )}
            ${this._renderOptionalTextField(["visualization", "sources_title"], "editor.fields.sources_title")}
            ${this._renderOptionalTextField(["visualization", "consumers_title"], "editor.fields.consumers_title")}
            ${this._renderOptionalTextField(["visualization", "groups_title"], "editor.fields.groups_title")}
            ${this._renderOptionalTextField(["visualization", "others_group_label"], "editor.fields.others_group_label")}
            ${this._renderOptionalTextField(
              ["visualization", "power_sensor_name_cleaner_regex"],
              "editor.fields.power_sensor_name_cleaner_regex",
              "editor.helpers.power_sensor_name_cleaner_regex",
              "editor.help.power_sensor_name_cleaner_regex",
            )}
            ${this._renderBooleanField(
              ["visualization", "show_empty_groups"],
              "editor.fields.show_empty_groups",
              false,
            )}
            ${this._renderBooleanField(
              ["visualization", "show_others_group"],
              "editor.fields.show_others_group",
              true,
            )}
          </div>
        `,
      )}

      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.visualization.device_label_text,
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
          </div>

          ${this._renderSectionScope(
            SECTION_SCOPE_IDS.power_devices.house_forecast,
            html`
              <div class="field-grid">
                ${this._renderEntityGroup(
                  ["power_devices", "house", "forecast", "total_energy_entity_id"],
                  "editor.fields.forecast_total_energy_entity",
                  {
                    includeDomains: ["sensor"],
                    helpKey: "editor.help.house_forecast_total_energy_entity",
                  },
                )}
              </div>
            `,
            { initialOpen: false },
          )}
        `,
        { initialOpen: false },
      )}

      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.power_devices.solar,
        html`
          <div class="field-grid field-grid--roomy">
            ${this._renderPowerEntityGroup(
              "solar",
              "editor.fields.power_entity",
              "editor.help.solar_power_entity",
            )}
            ${this._renderEntityGroup(
              ["power_devices", "solar", "entities", "today_energy"],
              "editor.fields.today_energy_entity",
              {
                includeDomains: ["sensor"],
                helpKey: "editor.help.solar_today_energy_entity",
              },
            )}
          </div>

          ${this._renderSectionScope(
            SECTION_SCOPE_IDS.power_devices.solar_forecast,
            html`
              <p class="inline-note">${this._t("editor.notes.solar_forecast_bias_correction")}</p>
              <div class="field-grid field-grid--roomy">
                ${this._renderEntityGroup(
                  ["power_devices", "solar", "forecast", "total_energy_entity_id"],
                  "editor.fields.forecast_total_energy_entity",
                  {
                    includeDomains: ["sensor"],
                    helpKey: "editor.help.solar_forecast_total_energy_entity",
                  },
                )}
              </div>

              ${renderSortableList({
                items: dailyEnergyEntityIds,
                containerClass: "list-stack",
                renderItem: (_value, index) => this._renderDailyEnergyEntity(index),
                onMove: (oldIndex, newIndex) =>
                  this._moveListItem(
                    ["power_devices", "solar", "forecast", "daily_energy_entity_ids"],
                    oldIndex,
                    newIndex,
                  ),
              })}
              <div class="section-footer">
                <button type="button" class="add-button" @click=${this._handleAddDailyEnergyEntity}>
                  ${this._t("editor.actions.add_daily_energy_entity")}
                </button>
              </div>
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
            ${this._renderEntityGroup(
              ["power_devices", "battery", "entities", "remaining_energy"],
              "editor.fields.remaining_energy_entity",
              {
                includeDomains: ["sensor"],
                helpKey: "editor.help.battery_remaining_energy_entity",
              },
            )}
            ${this._renderEntityGroup(
              ["power_devices", "battery", "entities", "capacity"],
              "editor.fields.capacity_entity",
              {
                includeDomains: ["sensor"],
                helpKey: "editor.help.battery_capacity_entity",
              },
            )}
            ${this._renderEntityGroup(
              ["power_devices", "battery", "entities", "min_soc"],
              "editor.fields.min_soc_entity",
              {
                includeDomains: ["sensor"],
                helpKey: "editor.help.battery_min_soc_entity",
              },
            )}
            ${this._renderEntityGroup(
              ["power_devices", "battery", "entities", "max_soc"],
              "editor.fields.max_soc_entity",
              {
                includeDomains: ["sensor"],
                helpKey: "editor.help.battery_max_soc_entity",
              },
            )}
          </div>

          ${this._renderSectionScope(
            SECTION_SCOPE_IDS.power_devices.battery_forecast,
            html`
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
          </div>

          ${this._renderSectionScope(
            SECTION_SCOPE_IDS.power_devices.grid_forecast,
            html`
              <div class="field-grid">
                ${this._renderEntityGroup(
                  ["power_devices", "grid", "forecast", "sell_price_entity_id"],
                  "editor.fields.sell_price_entity",
                  {
                    includeDomains: ["sensor"],
                    helpKey: "editor.help.grid_sell_price_entity",
                  },
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
              ${renderSortableList({
                items: importPriceWindows,
                containerClass: "list-stack",
                renderItem: (windowConfig, index) =>
                  this._renderImportPriceWindow(windowConfig, index),
                onMove: (oldIndex, newIndex) =>
                  this._moveListItem(
                    ["power_devices", "grid", "forecast", "import_price_windows"],
                    oldIndex,
                    newIndex,
                  ),
              })}
              <div class="section-footer">
                <button type="button" class="add-button" @click=${this._handleAddImportPriceWindow}>
                  ${this._t("editor.actions.add_import_price_window")}
                </button>
              </div>
            `,
            { initialOpen: false },
          )}
        `,
        { initialOpen: false },
      )}
    `;
  }

  /**
   * The five history-window settings, relocated here from the two entities
   * that used to carry them. Same fields, same paths' meaning — only where
   * they live in the document and in the editor moved.
   *
   * P2 (issue #172) is what makes this page worth opening: prose under each
   * block says what the setting decides, and a table lists every entity the
   * window governs against its configured window/minimum and its measured
   * depth in both recorder tables. The table is fed by the same
   * `helman/inspect_entities` poll the pickers elsewhere in the editor use —
   * see `_trainingDepthTargets` — so it costs no second measurement path.
   *
   * Issue #305 puts each job's status on top of its section: an overview of
   * the batch with Train all now, then one panel per job in batch order, each
   * read from the one `helman/training/status` poll the tab badge reads too.
   *
   * Issue #306 moved the solar bias correction settings to this tab, and
   * #312 moved their data after them: every solar bias setting lives flat
   * under `training.solar_bias`, so the Solar bias panel is one YAML scope.
   *
   * Issue #313 gives every panel one shape, so the state reads at a glance
   * and the rest is a drill-down: a plain parent panel with the job's health
   * in its header, then the explanation, the status, a collapsed
   * Configuration scope -- the only part with a YAML toggle -- and a
   * collapsed Diagnostics panel holding the issues and the depth table. See
   * `_renderTrainingJobSection`.
   */
  private _renderTrainingTab(): TemplateResult {
    return html`
      ${this._renderSimpleSection(
        this._t("editor.sections.training_settings"),
        html`
          <helman-info-callout
            .hass=${this.hass}
            .text=${this._t("editor.notes.training_settings_what")}
          ></helman-info-callout>
          <helman-training-status
            .hass=${this.hass}
            .status=${this._trainingStatus}
            .disabled=${this._dirty}
            @helman-training-status-changed=${this._handleTrainingStatusChanged}
          ></helman-training-status>
          ${this._renderSectionScope(
            SECTION_SCOPE_IDS.training.settings,
            html`
              <div class="field-grid">
                ${this._renderOptionalTextField(
                  ["training", "training_time"],
                  "editor.fields.training_time",
                  "editor.helpers.training_time",
                  "editor.help.training_time",
                )}
              </div>
            `,
            { initialOpen: false },
          )}
        `,
        { icon: TAB_ICONS.training },
      )}

      ${this._renderTrainingJobSection(
        "solar_bias",
        "editor.notes.training_solar_bias_what",
        this._renderSectionScope(
          SECTION_SCOPE_IDS.training.solar_bias,
          html`
            <helman-info-callout
              .hass=${this.hass}
              .text=${this._t("editor.notes.training_solar_bias")}
            ></helman-info-callout>
            <div class="field-grid">
              ${this._renderOptionalNumberField(
                ["training", "solar_bias", "min_history_days"],
                "editor.fields.solar_bias_min_history_days",
                "editor.helpers.solar_bias_min_history_days",
                "editor.help.solar_bias_min_history_days",
              )}
              ${this._renderOptionalNumberField(
                ["training", "solar_bias", "max_training_window_days"],
                "editor.fields.solar_bias_max_training_window_days",
                "editor.helpers.solar_bias_max_training_window_days",
                "editor.help.solar_bias_max_training_window_days",
              )}
              ${this._renderOptionalNumberField(
                ["training", "solar_bias", "min_valid_slot_days"],
                "editor.fields.solar_bias_min_valid_slot_days",
                "editor.helpers.solar_bias_min_valid_slot_days",
                "editor.help.solar_bias_min_valid_slot_days",
              )}
            </div>
            <p class="inline-note">${this._t("editor.notes.training_solar_bias_min_valid_slot_days")}</p>
            <div class="field-grid">
              ${this._renderBooleanField(
                ["training", "solar_bias", "enabled"],
                "editor.fields.bias_correction_enabled",
                this._configDefaultValue(["training", "solar_bias", "enabled"]) === true,
                "editor.help.bias_correction_enabled",
              )}
              ${this._renderOptionalNumberField(
                ["training", "solar_bias", "clamp_min"],
                "editor.fields.bias_correction_clamp_min",
                undefined,
                "editor.help.bias_correction_clamp_min",
              )}
              ${this._renderOptionalNumberField(
                ["training", "solar_bias", "clamp_max"],
                "editor.fields.bias_correction_clamp_max",
                undefined,
                "editor.help.bias_correction_clamp_max",
              )}
              ${renderSelectFieldWithDefault(
                this,
                ["training", "solar_bias", "aggregation_method"],
                "editor.fields.bias_correction_aggregation_method",
                [
                  { value: "ratio_of_sums", label: this._optionLabel("editor.fields.bias_correction_aggregation_method_ratio_of_sums", "Ratio of Sums") },
                  { value: "trimmed_mean", label: this._optionLabel("editor.fields.bias_correction_aggregation_method_trimmed_mean", "Trimmed Mean") }
                ],
                String(this._configDefaultValue(["training", "solar_bias", "aggregation_method"]) ?? ""),
                "editor.help.bias_correction_aggregation_method",
              )}
              ${this._renderOptionalNumberField(
                ["training", "solar_bias", "max_interpolated_consecutive_slots"],
                "editor.fields.bias_correction_max_interpolated_consecutive_slots",
                "editor.helpers.bias_correction_max_interpolated_consecutive_slots",
                "editor.help.bias_correction_max_interpolated_consecutive_slots",
              )}
              ${this._renderEntityGroup(
                ["training", "solar_bias", "total_energy_entity_id"],
                "editor.fields.bias_correction_total_energy_entity",
                {
                  includeDomains: ["sensor"],
                  helpKey: "editor.help.bias_correction_total_energy_entity",
                },
              )}
            </div>

            ${this._renderSectionScope(
              SECTION_SCOPE_IDS.training.solar_bias_slot_invalidation,
              html`
                <helman-info-callout
                  .hass=${this.hass}
                  .text=${this._t("editor.notes.training_solar_bias_slot_invalidation")}
                ></helman-info-callout>
                <div class="field-grid">
                  ${this._renderOptionalNumberField(
                    ["training", "solar_bias", "slot_invalidation", "max_battery_soc_percent"],
                    "editor.fields.bias_correction_slot_invalidation_max_battery_soc_percent",
                    "editor.helpers.bias_correction_slot_invalidation_max_battery_soc_percent",
                    "editor.help.bias_correction_slot_invalidation_max_battery_soc_percent",
                    { min: 0, max: 100, suffix: "%" },
                  )}
                  ${this._renderOptionalNumberField(
                    ["training", "solar_bias", "slot_invalidation", "curtailment_max_export_w"],
                    "editor.fields.bias_correction_slot_invalidation_curtailment_max_export_w",
                    "editor.helpers.bias_correction_slot_invalidation_curtailment_max_export_w",
                    "editor.help.bias_correction_slot_invalidation_curtailment_max_export_w",
                    { min: 0, suffix: "W" },
                  )}
                  ${this._renderOptionalNumberField(
                    ["training", "solar_bias", "slot_invalidation", "curtailment_max_actual_forecast_ratio"],
                    "editor.fields.bias_correction_slot_invalidation_curtailment_max_actual_forecast_ratio",
                    "editor.helpers.bias_correction_slot_invalidation_curtailment_max_actual_forecast_ratio",
                    "editor.help.bias_correction_slot_invalidation_curtailment_max_actual_forecast_ratio",
                    { min: 0, max: 1 },
                  )}
                  ${this._renderOptionalNumberField(
                    ["training", "solar_bias", "slot_invalidation", "data_glitch_max_slot_wh"],
                    "editor.fields.bias_correction_slot_invalidation_data_glitch_max_slot_wh",
                    "editor.helpers.bias_correction_slot_invalidation_data_glitch_max_slot_wh",
                    "editor.help.bias_correction_slot_invalidation_data_glitch_max_slot_wh",
                    { min: 0, suffix: "Wh" },
                  )}
                  ${this._renderOptionalNumberField(
                    ["training", "solar_bias", "slot_invalidation", "data_glitch_min_neighbour_forecast_wh"],
                    "editor.fields.bias_correction_slot_invalidation_data_glitch_min_neighbour_forecast_wh",
                    "editor.helpers.bias_correction_slot_invalidation_data_glitch_min_neighbour_forecast_wh",
                    "editor.help.bias_correction_slot_invalidation_data_glitch_min_neighbour_forecast_wh",
                    { min: 0, suffix: "Wh" },
                  )}
                  ${this._renderOptionalNumberField(
                    ["training", "solar_bias", "slot_invalidation", "data_glitch_backfill_max_minutes"],
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
        ),
        this._solarBiasDepthRows(),
        html`
          <helman-solar-bias-diagnostics
            .hass=${this.hass}
            .job=${this._trainingJob("solar_bias")}
            .configRevision=${this._configBaseline}
          ></helman-solar-bias-diagnostics>
          ${this._renderSolarInspectorCard()}
        `,
        (open) => this._handleSolarDiagnosticsToggle(open),
      )}

      ${this._renderTrainingJobSection(
        "house_consumption",
        "editor.notes.training_house_consumption_what",
        this._renderSectionScope(
          SECTION_SCOPE_IDS.training.house_consumption,
          html`
            <helman-info-callout
              .hass=${this.hass}
              .text=${this._t("editor.notes.training_house_consumption")}
            ></helman-info-callout>
            <div class="field-grid">
              ${this._renderOptionalNumberField(
                ["training", "house_consumption", "min_history_days"],
                "editor.fields.house_consumption_min_history_days",
                "editor.helpers.house_consumption_min_history_days",
                "editor.help.house_consumption_min_history_days",
              )}
              ${this._renderOptionalNumberField(
                ["training", "house_consumption", "training_window_days"],
                "editor.fields.house_consumption_training_window_days",
                "editor.helpers.house_consumption_training_window_days",
                "editor.help.house_consumption_training_window_days",
              )}
            </div>
          `,
          { initialOpen: false },
        ),
        this._houseConsumptionDepthRows(),
      )}

      ${this._renderTrainingJobSection(
        "appliance_energy",
        "editor.notes.training_appliance_energy",
        nothing,
        this._applianceEnergyDepthRows(),
      )}
    `;
  }

  /**
   * One job's panel: explanation, status, Configuration, Diagnostics, in
   * that order, each left out when it has nothing to show.
   *
   * The Diagnostics header warns when the job reported issues or a depth
   * row is short. It is an icon rather than a count, because the two can be
   * the same problem -- an appliance's issue and its meter's short row.
   */
  private _renderTrainingJobSection(
    id: keyof typeof TRAINING_JOB_ICONS,
    explanationKey: string,
    configuration: TemplateResult | typeof nothing,
    depthRows: TrainingDepthRow[],
    extraDiagnostics: TemplateResult | typeof nothing = nothing,
    onDiagnosticsToggle?: (open: boolean) => void,
  ): TemplateResult {
    const job = this._trainingJob(id);
    const hasIssues = (job?.issues.length ?? 0) > 0;
    const needsAttention =
      hasIssues || depthRows.some((row) => this._isTrainingDepthRowShort(row));
    const hasDiagnostics =
      hasIssues || depthRows.length > 0 || extraDiagnostics !== nothing;
    const attentionLabel = this._t("editor.training_depth.attention");
    return this._renderSimpleSection(
      this._t(`editor.sections.${id}`),
      html`
        <helman-info-callout
          .hass=${this.hass}
          .text=${this._t(explanationKey)}
        ></helman-info-callout>
        ${this._renderTrainingJobStatus(id)}
        ${configuration}
        ${hasDiagnostics
          ? this._renderSimpleSection(
              this._t("editor.sections.diagnostics"),
              html`
                <helman-training-issues .hass=${this.hass} .job=${job}></helman-training-issues>
                ${extraDiagnostics}
                ${this._renderTrainingDepthTable(depthRows)}
              `,
              {
                open: false,
                icon: DIAGNOSTICS_ICON,
                onToggle: onDiagnosticsToggle,
                badge: needsAttention
                  ? html`<span
                      class="training-attention"
                      role="img"
                      title=${attentionLabel}
                      aria-label=${attentionLabel}
                    >${this._renderSvgIcon(mdiAlertOutline, "training-attention-icon")}</span>`
                  : undefined,
              },
            )
          : nothing}
      `,
      {
        icon: TRAINING_JOB_ICONS[id],
        badge: job
          ? html`<helman-training-health-badge
              .hass=${this.hass}
              .job=${job}
            ></helman-training-health-badge>`
          : undefined,
      },
    );
  }

  /**
   * Start loading the card artifact, the first time the panel is opened.
   *
   * A collapsed `details` still renders its content into the DOM, so the
   * laziness cannot come from the template -- the card would mount, and fetch a
   * day, before anyone asked to see it. Hence the toggle: the load starts on the
   * open and then never again, because the loader is the record of having asked.
   */
  private _handleSolarDiagnosticsToggle(open: boolean): void {
    if (!open) return;
    if (!this._inspectorRequested) {
      this._inspectorRequested = true;
      // Not reactive on its own: the render is otherwise driven by the load
      // settling, and an already-registered tag settles it in a microtask.
      this.requestUpdate();
    }
    // Once, failure included -- see the catch below.
    if (this._inspectorCardLoad) return;
    const url = this.panel?.config?.card_module_url;
    if (!url) {
      // No URL to import means no card, and a section that stayed blank would
      // read as a chart that had nothing to draw.
      this._inspectorCardError = this._t("editor.messages.card_module_url_missing");
      return;
    }
    this._inspectorCardLoad = inspectorCardLoader(url);
    void this._inspectorCardLoad()
      .then(() => {
        this._inspectorCardError = null;
        this.requestUpdate();
      })
      .catch((error) => {
        // The loader is deliberately *kept*: there is no retry to offer. A
        // failed dynamic import is memoised by the browser's module map, so
        // importing the same URL again rejects with the same error and without
        // even a request -- measured, not assumed. Only a reload clears it, and
        // a fresh URL is not an option: a differently spelled one is a second
        // module, which is the duplicate evaluation all of this exists to avoid.
        // Both halves, unlike the editor's other errors: what fails here is a
        // bare module fetch, whose message names a URL and nothing else, so on
        // its own it would not say which part of the page had gone missing.
        this._inspectorCardError = [
          this._t("editor.messages.load_inspector_card_failed"),
          this._formatError(error, ""),
        ]
          .filter(Boolean)
          .join(" ");
      });
  }

  /**
   * The embedded inspector, once its artifact has been evaluated.
   *
   * One element, built imperatively and interpolated as a node, because a card is
   * configured by a *call*: `setConfig` is Lovelace's contract, and a template can
   * set properties but cannot call a method. Built once and kept, so `setConfig`
   * runs once too; `hass` is assigned on every render, the way a dashboard does it.
   */
  private _renderSolarInspectorCard(): TemplateResult | typeof nothing {
    if (!this._inspectorRequested) return nothing;
    if (this._inspectorCardError) {
      return html`<div class="message error">${this._inspectorCardError}</div>`;
    }
    if (!customElements.get(INSPECTOR_CARD_TAG)) return nothing;
    if (!this._inspectorCard) {
      const card = document.createElement(INSPECTOR_CARD_TAG) as SolarInspectorCardElement;
      card.setConfig(SOLAR_INSPECTOR_EMBED_CONFIG);
      this._inspectorCard = card;
    }
    this._inspectorCard.hass = this.hass;
    return html`${this._inspectorCard}`;
  }

  private _trainingJob(id: string) {
    return this._trainingStatus?.jobs.find((job) => job.id === id) ?? null;
  }

  private _renderTrainingJobStatus(id: string): TemplateResult {
    return html`
      <helman-training-job-status
        data-job=${id}
        .hass=${this.hass}
        .job=${this._trainingJob(id)}
        .running=${this._trainingStatus?.isRunning === true}
        .disabled=${this._dirty}
        @helman-training-status-changed=${this._handleTrainingStatusChanged}
      ></helman-training-job-status>
    `;
  }

  /**
   * The house meter, plus one row per controllable's own energy meter.
   *
   * `controllables.*.consumption.energy_entity_id` is the same path a
   * controllable's picker already reads elsewhere in the editor — this is a
   * second, read-only view of it, not a second control. Each row also carries
   * that controllable's own `history_lookback_days` (really
   * `consumption.projection.lookback_days`), a *different* per-appliance
   * setting that happens to read the same entity: it governs only that one
   * appliance's own consumption projection, never the house trainer.
   */
  private _houseConsumptionDepthRows(): TrainingDepthRow[] {
    const controllables = asJsonArray(this._getValue(["controllables"])) ?? [];
    return [
      {
        label: this._t("editor.training_depth.house_meter"),
        path: ["power_devices", "house", "forecast", "total_energy_entity_id"],
        roleKey: "editor.training_depth.role_house_meter",
      },
      ...controllables.flatMap((controllable, index): TrainingDepthRow[] => {
        const entry = asJsonObject(controllable) ?? {};
        // The trainer's list, not the config's: `read_deferrable_consumers`
        // refuses the inverter (validation denies it a `consumption` block at
        // all) and honours `deferrable: false`, so a row for either would
        // claim the house window governs a meter it never reads.
        const consumption = asJsonObject(entry.consumption) ?? {};
        const deferrable = consumption.deferrable !== false;
        if (this._stringValue(entry.kind) === "inverter" || !deferrable) return [];
        const name =
          this._stringValue(entry.name) ||
          this._stringValue(entry.id) ||
          `${this._t("editor.training_depth.controllable_fallback_name")} ${index + 1}`;
        return [
          {
            label: name,
            path: ["controllables", index, "consumption", "energy_entity_id"],
            roleKey: "editor.training_depth.role_controllable",
          },
        ];
      }),
    ];
  }

   /**
   * Both sides of the comparison this trainer makes, then the two entities
   * that tell a capped slot from a genuinely poor one.
   *
   * The forecast side is two rows, and which one carries the requirement is
   * the point. `daily_energy_entity_ids[0]` is where the numbers come *from*
   * and is listed because a reader needs it named, but nothing reads its
   * history any more, so neither of its depth columns governs anything.
   * Helman republishes each slot's prediction as
   * `sensor.helman_solar_forecast_current` before that slot begins and the
   * trainer reads *that* entity's recorded history, so it is the one whose
   * depth decides how far back the fit can reach — and the only entity on this
   * page that is not a config path, its id being a constant Helman owns.
   *
   * Both of its columns matter and they mean different things: raw states are
   * the 15-minute detail the fit is built from and stop at `purge_keep_days`,
   * while statistics are hourly and kept forever. #183 taught the trainer to
   * splice the two -- statistics for the tail, raw states for the recent part
   * -- so the row's severity now binds on whichever column reaches deeper
   * (issue #186), not on the states column alone.
   *
   * Curtailment detection reads grid power and the battery SoC sensor (which
   * lives under the `capacity` key — see `actuals.py:411`). None of the three
   * supporting entities has a requirement of its own; all are judged against
   * the same `training.solar_bias.min_history_days` the production meter is.
   */
  private _solarBiasDepthRows(): TrainingDepthRow[] {
    return [
      {
        label: this._t("editor.training_depth.bias_meter"),
        path: ["training", "solar_bias", "total_energy_entity_id"],
        roleKey: "editor.training_depth.role_bias_meter",
      },
      {
        label: this._t("editor.training_depth.forecast_source"),
        path: ["power_devices", "solar", "forecast", "daily_energy_entity_ids", 0],
        roleKey: "editor.training_depth.role_forecast_source",
      },
      {
        label: this._t("editor.training_depth.forecast_recorded"),
        // Two segments, because the registry matches on dot-separated depth.
        path: ["helman", "solar_forecast_current"],
        roleKey: "editor.training_depth.role_forecast_recorded",
        ownEntity: true,
      },
      {
        label: this._t("editor.training_depth.grid_power"),
        path: ["power_devices", "grid", "entities", "power"],
        roleKey: "editor.training_depth.role_grid_power",
      },
      {
        label: this._t("editor.training_depth.battery_soc"),
        path: ["power_devices", "battery", "entities", "capacity"],
        roleKey: "editor.training_depth.role_battery_soc",
      },
    ];
  }

  /**
   * Every entity the appliance energy job reads, with the lookback it reads.
   *
   * A `history_average` appliance reads its meter and its switch or climate
   * entity -- the second is how training knows when it ran, so a deep meter
   * over a shallow switch still yields no estimate. A meter shared by generic
   * and climate appliances is read once over the longest lookback among the
   * sharers that learn, and every sharer's activity divides it, a `fixed` one
   * included. Mirrors `ApplianceEnergyTrainingRequest` and `read_shared_meters`.
   *
   * A second, read-only view of settings that live on each controllable --
   * the same kind of view `_houseConsumptionDepthRows` gives those meters.
   */
  private _applianceEnergyDepthRows(): TrainingDepthRow[] {
    const controllables = (asJsonArray(this._getValue(["controllables"])) ?? []).map(
      (controllable, index) => {
        const entry = asJsonObject(controllable) ?? {};
        const consumption = asJsonObject(entry.consumption) ?? {};
        const projection = asJsonObject(consumption.projection) ?? {};
        const kind = this._stringValue(entry.kind);
        const lookback = projection.lookback_days;
        return {
          index,
          name:
            this._stringValue(entry.name) ||
            this._stringValue(entry.id) ||
            `${this._t("editor.training_depth.controllable_fallback_name")} ${index + 1}`,
          meter: this._stringValue(consumption.energy_entity_id),
          // Only these two kinds share a meter or learn from history.
          activity: kind === "generic" ? "switch" : kind === "climate" ? "climate" : null,
          learns: projection.strategy === "history_average",
          // The backend trains on 30 days when the key is absent.
          lookback: typeof lookback === "number" ? lookback : 30,
        };
      },
    );
    const sharers = new Map<string, typeof controllables>();
    for (const item of controllables) {
      if (!item.meter || !item.activity) continue;
      sharers.set(item.meter, [...(sharers.get(item.meter) ?? []), item]);
    }
    const sharedLookback = (meter: string): number | null => {
      const members = sharers.get(meter) ?? [];
      const learners = members.filter((member) => member.learns);
      if (members.length < 2 || learners.length === 0) return null;
      return Math.max(...learners.map((member) => member.lookback));
    };
    return controllables.flatMap((item): TrainingDepthRow[] => {
      const shared = item.meter ? sharedLookback(item.meter) : null;
      const activityRow = (roleKey: string, days: number): TrainingDepthRow[] =>
        item.activity
          ? [
              {
                label: item.name,
                path: ["controllables", item.index, "controls", item.activity, "entity_id"],
                roleKey,
                roleParams: { days },
                requiredDays: days,
              },
            ]
          : [];
      if (!item.learns) {
        // A fixed sharer learns nothing, but when it ran still splits the meter.
        return shared === null
          ? []
          : activityRow("editor.training_depth.role_appliance_sharer_activity", shared);
      }
      const days = shared ?? item.lookback;
      return [
        {
          label: item.name,
          path: ["controllables", item.index, "consumption", "energy_entity_id"],
          roleKey: "editor.training_depth.role_appliance_meter",
          roleParams: { days },
          requiredDays: days,
        },
        ...activityRow("editor.training_depth.role_appliance_activity", days),
      ];
    });
  }

  /**
   * Every target the training tab's depth tables need, for the shared poll.
   *
   * Computed only while the training tab is active: the tables render
   * nothing otherwise, and asking about entities nobody can see would be a
   * poll that never pays for itself. `_pollEntityInspections` merges this
   * list with the mounted `helman-entity-group` paths and de-duplicates by
   * key, so this is not a second call and not a second cache.
   */
  private _trainingDepthTargets(): {
    key: string;
    path: PathSegment[];
    ownEntity: boolean;
  }[] {
    if (this._activeTab !== "training") return [];
    const rows = [
      ...this._houseConsumptionDepthRows(),
      ...this._solarBiasDepthRows(),
      ...this._applianceEnergyDepthRows(),
    ];
    return rows.map((row) => ({
      key: entityGroupKey(row.path),
      path: row.path,
      ownEntity: row.ownEntity === true,
    }));
  }

  /**
   * One depth table: what the trainer reads, and how much of it there is.
   *
   * Deliberately *not* here: the configured window and minimum. Both are the
   * same for every row -- they are this section's own settings, edited in the
   * fields directly above -- so a column of them repeated down the table said
   * nothing a reader could not already see. The appliance-energy table is the
   * exception: each row names its own lookback in the role text because that
   * per-appliance value is also the requirement used to highlight that row.
   *
   * What is left is what a reader cannot get anywhere else: which entities
   * this trainer reads, what it takes from each, and how deep the recorder
   * actually goes for them.
   */
  private _renderTrainingDepthTable(
    rows: TrainingDepthRow[],
  ): TemplateResult | typeof nothing {
    if (rows.length === 0) return nothing;
    return html`
      <div class="training-depth-table-wrap">
        <table class="training-depth-table">
          <thead>
            <tr>
              <th>${this._t("editor.training_depth.column_entity")}</th>
              <th>${this._t("editor.training_depth.column_role")}</th>
              <th class="training-depth-number">
                ${this._t("editor.training_depth.column_raw_states")}
              </th>
              <th class="training-depth-number">
                ${this._t("editor.training_depth.column_statistics")}
              </th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row) => this._renderTrainingDepthRow(row))}
          </tbody>
        </table>
      </div>
    `;
  }

  /** The inspection draft behind a depth row, and its history fact. */
  private _trainingDepthInspection(row: TrainingDepthRow) {
    const draft = this._entityInspections[entityGroupKey(row.path)]?.draft ?? null;
    const historyFact: EntityFact | undefined = draft?.facts?.find(
      (fact) => fact.id === "history",
    );
    return { draft, historyFact };
  }

  /**
   * Whether a depth row is short of the history it needs.
   *
   * Severity is a property of the pair now that `available` is the spliced
   * effective depth (issue #186) -- the raw-states cell alone no longer says
   * whether the row is short, so the highlight is on the row.
   */
  private _isTrainingDepthRowShort(row: TrainingDepthRow): boolean {
    const { historyFact } = this._trainingDepthInspection(row);
    const available = historyFact?.params?.["available"];
    if (row.requiredDays !== undefined) {
      return typeof available === "number" && available < row.requiredDays;
    }
    return historyFact?.severity === "warn";
  }

  private _renderTrainingDepthRow(row: TrainingDepthRow): TemplateResult {
    const { draft, historyFact } = this._trainingDepthInspection(row);
    // The config document first, then whatever the backend resolved. For every
    // row but one those are the same string. The exception is a row for an
    // entity Helman publishes: its path names nothing in the document, so only
    // the inspection knows the id, and without this the row renders as "no
    // entity configured" and is not clickable — while reporting a depth.
    const entityId =
      this._stringValue(this._getValue(row.path)) ||
      this._stringValue(draft?.entityId);
    const rawStates = historyFact?.params?.["raw_states"];
    const statistics = historyFact?.params?.["statistics"];
    const name = html`<div class="training-depth-label">${row.label}</div>`;
    return html`
      <tr class=${this._isTrainingDepthRowShort(row) ? "training-depth-warn" : ""}>
        <td>
          ${entityId
            ? html`<button
                type="button"
                class="training-depth-entity-button"
                aria-label=${this._moreInfoLabel(entityId)}
                title=${entityId}
                @click=${() => this._showMoreInfo(entityId)}
              >
                ${name}
                <div class="training-depth-entity-id">${entityId}</div>
              </button>`
            : html`${name}
                <div class="training-depth-entity-id training-depth-unset">
                  ${this._t("editor.training_depth.no_entity")}
                </div>`}
        </td>
        <td class="training-depth-role">
          ${row.roleParams ? this._tFormat(row.roleKey, row.roleParams) : this._t(row.roleKey)}
        </td>
        <td class="training-depth-number">${this._trainingDepthCell(rawStates)}</td>
        <td class="training-depth-number">${this._trainingDepthCell(statistics)}</td>
      </tr>
    `;
  }

  /**
   * Ask Home Assistant for its more-info dialog.
   *
   * `hass-more-info` is HA's own protocol, and its dialog manager listens on
   * the root `home-assistant` element several shadow roots above this one --
   * hence `composed`, without which the event stops at this panel's boundary.
   * Same contract `entity-group.ts` uses for the badge that opens an entity.
   */
  private _showMoreInfo(entityId: string): void {
    this.dispatchEvent(
      new CustomEvent("hass-more-info", {
        detail: { entityId },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** "Show details of sensor.x", with the id substituted if the string asks. */
  private _moreInfoLabel(entityId: string): string {
    const template = this._t("editor.entity_group.more_info_aria");
    return template.includes("{entity}")
      ? template.replace("{entity}", entityId)
      : `${template} ${entityId}`;
  }

  /** A measured cell: the number, or a dash while it is unknown. */
  private _trainingDepthCell(value: unknown): string {
    return typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
  }

  private _renderAutomationTab(): TemplateResult {
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

      ${this._renderOptimizerBucketSection("appliance_optimizers")}
      ${this._renderOptimizerBucketSection("system_optimizers")}
    `;
  }

  /**
   * One bucket's ordered optimizer list, as its own section.
   *
   * Appliance and system optimizers follow different rules -- an appliance
   * optimizer's order decides what a later one plans around, a system
   * optimizer's does not -- and the point of the split is that this is legible
   * from the shape of the screen: two sections, each with its own heading,
   * reorder bounds and add buttons, rather than one flat list a docs paragraph
   * has to explain.
   */
  private _renderOptimizerBucketSection(bucket: OptimizerBucket): TemplateResult {
    const optimizers = this._optimizersInBucket(bucket);
    const scopeId =
      bucket === "appliance_optimizers"
        ? SECTION_SCOPE_IDS.automation.appliance_optimizer_pipeline
        : SECTION_SCOPE_IDS.automation.system_optimizer_pipeline;
    const noteKey =
      bucket === "appliance_optimizers"
        ? "editor.notes.appliance_optimizer_pipeline"
        : "editor.notes.system_optimizer_pipeline";
    const emptyKey =
      bucket === "appliance_optimizers"
        ? "editor.empty.no_appliance_optimizers"
        : "editor.empty.no_system_optimizers";
    // Only kinds whose schema-derived bucket matches this section -- never a
    // literal kind list, which is exactly the drift `OptimizerSpec.bucket`
    // exists to prevent.
    const addableKinds = (this._optimizerSchema?.kinds ?? []).filter(
      (schema) => this._bucketKindOf(schema) === bucket,
    );

    return html`
      ${this._renderSectionScope(
        scopeId,
        html`
          <p class="inline-note">${this._t(noteKey)}</p>
          ${renderSortableList({
            items: optimizers,
            containerClass: "list-stack",
            renderItem: (_optimizer, index) => this._renderOptimizerEditor(bucket, index),
            onMove: (oldIndex, newIndex) =>
              this._moveListItem(["automation", bucket], oldIndex, newIndex),
          })}
          ${optimizers.length === 0
            ? html`
                <div class="message info">${this._t(emptyKey)}</div>
              `
            : nothing}
          <div class="section-footer">
            ${addableKinds.map(
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
   * Which bucket a kind's own add button belongs in.
   *
   * Reads `schema.bucket`, served from `OptimizerSpec.bucket` -- never a kind
   * list here. `schema.bucket` is optional only because a card must still
   * render against a schema served by an older backend; such a schema has no
   * bucket to be wrong about, so it falls back to the appliance section rather
   * than becoming impossible to add at all.
   */
  private _bucketKindOf(schema: OptimizerSchema): OptimizerBucket {
    return schema.bucket === "system" ? "system_optimizers" : "appliance_optimizers";
  }

  private _optimizersInBucket(bucket: OptimizerBucket): JsonValue[] {
    return asJsonArray(this._getValue(["automation", bucket])) ?? [];
  }

  /**
   * One optimizer, drawn by the element the solar inspector also mounts.
   *
   * The panel keeps the pipeline: the list actions in the card's summary are
   * *its* buttons, passed down, because moving and deleting change which
   * optimizers exist and that is a document-level edit. Everything inside the
   * card belongs to the element.
   */
  private _renderOptimizerEditor(
    bucket: OptimizerBucket,
    index: number,
  ): TemplateResult {
    return html`
      <helman-optimizer-editor
        .config=${this._config}
        .bucket=${bucket}
        .index=${index}
        .schema=${this._optimizerSchema}
        .applianceMetadata=${this._liveApplianceMetadata}
        .hass=${this.hass}
        .narrow=${this.narrow ?? false}
        .localize=${(key: string) => this._t(key)}
        .warning=${this._optimizerOrderingWarning(bucket, index)}
        .listActions=${(basePath: PathSegment[], enabled: boolean) =>
          this._renderOptimizerListActions(bucket, basePath, index, enabled)}
        @optimizer-config-changed=${this._handleOptimizerConfigChanged}
      ></helman-optimizer-editor>
    `;
  }

  /**
   * The `required_appliance_planned_later` warning against this card, if any.
   *
   * `config_validation.py`'s `_validate_requires_appliance` reports it at
   * `automation.<bucket>[<index>].conditions[<n>].requires_appliance` -- a
   * path under this optimizer's own `_basePath` -- so matching by prefix finds
   * it without a second copy of the rule that produced it. Reordering within
   * the appliance section is the fix, so the card is where a reader can act on
   * it, the same mechanism `automation-coverage.ts` uses to badge a lane.
   */
  private _optimizerOrderingWarning(bucket: OptimizerBucket, index: number): string | null {
    if (!this._validation) {
      return null;
    }
    const prefix = `automation.${bucket}[${index}].`;
    const issue = this._validation.warnings.find(
      (warning) =>
        warning.code === "required_appliance_planned_later" && warning.path.startsWith(prefix),
    );
    return issue?.message ?? null;
  }

  private _handleOptimizerConfigChanged = (event: Event): void => {
    const detail = (event as CustomEvent<OptimizerConfigChangedDetail>).detail;
    if (!detail?.config) {
      return;
    }
    // The edit came from a child element, but it is still an edit of this
    // draft, so it goes through the same bookkeeping rather than repeating it.
    this._config = detail.config;
    this._markDraftChanged();
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

  /**
   * The pipeline row in an optimizer card's summary: drag, enable, remove.
   *
   * The handle rides here rather than beside the card's title because the
   * summary's left half belongs to the shared card renderer, which the
   * inspector's dialog also mounts -- and that dialog passes no list actions at
   * all, so it gets a card with no way to disturb the list it came from.
   */
  private _renderOptimizerListActions(
    bucket: OptimizerBucket,
    basePath: PathSegment[],
    index: number,
    enabled: boolean,
  ): TemplateResult {
    return html`
      <div class="list-actions" @click=${this._preventSummaryToggle}>
        ${renderDragHandle(this)}
        ${this._renderOptimizerEnabledToggle([...basePath, "enabled"], enabled)}
        ${renderRemoveButton(this, {
          onRemove: () => this._removeListItem(["automation", bucket], index),
        })}
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
          ${controllables.length === 0
            ? html`<div class="list-stack">
                <div class="message info">${this._t("editor.empty.no_controllables")}</div>
              </div>`
            : renderSortableList({
                items: controllables,
                containerClass: "list-stack",
                renderItem: (controllable, index) =>
                  this._renderControllableCard(controllable, index),
                onMove: (oldIndex, newIndex) => this._moveControllable(oldIndex, newIndex),
              })}
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
    const categories = objectEntries(this._getValue(["visualization", "device_label_text"]));
    if (categories.length === 0) {
      return [html`<div class="message info">${this._t("editor.empty.no_device_label_categories")}</div>`];
    }

    return categories.map(([categoryKey, labels]) => {
      const labelEntries = objectEntries(labels);
      return html`
        <div class="list-card">
          <div class="card-header">
            <div class="card-title">
              <input
                class="category-key-input"
                .value=${categoryKey}
                title=${this._t("editor.fields.category_key")}
                aria-label=${this._t("editor.fields.category_key")}
                @change=${(event: Event) => {
                  this._handleRenameObjectKey(
                    ["visualization", "device_label_text"],
                    categoryKey,
                    (event.currentTarget as HTMLInputElement).value,
                  );
                }}
              />
              <span class="card-subtitle">${this._t("editor.card.category")}</span>
            </div>
            <div class="inline-actions">
              ${renderRemoveButton(this, {
                onRemove: () => this._removePath(["visualization", "device_label_text", categoryKey]),
                label: this._t("editor.actions.remove_category"),
              })}
            </div>
          </div>
          <div class="label-entry-rows">
            <div class="label-entry-row label-entry-head">
              <label class="label-key-cell">${this._t("editor.fields.label_key")}</label>
              <label class="badge-text-cell">${this._t("editor.fields.badge_text")}</label>
              <span class="label-entry-actions-spacer"></span>
            </div>
            ${labelEntries.map(([labelKey, badgeText]) => html`
              <div class="label-entry-row">
                <div class="field field-compact label-key-cell">
                  ${this._renderLabelKeyPicker(categoryKey, labelKey, labelEntries)}
                </div>
                <div class="field field-compact badge-text-cell">
                  <input
                    class="badge-text-input"
                    .value=${this._stringValue(badgeText)}
                    aria-label=${this._t("editor.fields.badge_text")}
                    @change=${(event: Event) => {
                      this._setRequiredString(
                        ["visualization", "device_label_text", categoryKey, labelKey],
                        (event.currentTarget as HTMLInputElement).value,
                      );
                    }}
                  />
                </div>
                <div class="list-actions">
                  ${renderRemoveButton(this, {
                    className: "remove-label-entry",
                    onRemove: () =>
                      this._removePath(["visualization", "device_label_text", categoryKey, labelKey]),
                  })}
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

  /**
   * The label a badge text applies to: Home Assistant's own labels, by name.
   *
   * `device_label_text` is keyed by label name, so the registry can offer the
   * keys directly. Two cases keep it honest: a stored key the registry does not
   * have is offered as its own option rather than silently rewritten, and a
   * registry that could not be read falls back to the free-text input the
   * section always had -- an editor that offered nothing would strand the keys.
   */
  private _renderLabelKeyPicker(
    categoryKey: string,
    labelKey: string,
    labelEntries: [string, unknown][],
  ): TemplateResult {
    const rename = (value: string) =>
      this._handleRenameObjectKey(["visualization", "device_label_text", categoryKey], labelKey, value);
    const title = this._t("editor.fields.label_key");
    // An empty registry is treated as no registry: a picker whose only entries
    // are the keys already stored can only take editing away. A Home Assistant
    // that simply has no labels yet is the common case for that.
    if (this._haLabelNames === null || this._haLabelNames.length === 0) {
      return html`
        <input
          class="label-key-input"
          .value=${labelKey}
          title=${title}
          aria-label=${title}
          @change=${(event: Event) => rename((event.currentTarget as HTMLInputElement).value)}
        />
      `;
    }
    // A name another row in this category already uses would collide on rename,
    // so it is offered only by the row holding it.
    const taken = new Set(
      labelEntries.map(([key]) => key).filter((key) => key !== labelKey),
    );
    const options = this._haLabelNames.filter((name) => !taken.has(name));
    return html`
      <select
        class="label-key-picker"
        title=${title}
        aria-label=${title}
        @change=${(event: Event) => rename((event.currentTarget as HTMLSelectElement).value)}
      >
        <option value="" ?selected=${labelKey.length === 0}>
          ${this._t("editor.values.select_label")}
        </option>
        ${labelKey.length > 0 && !options.includes(labelKey)
          ? html`<option value=${labelKey} ?selected=${true}>
              ${this._tFormat("editor.dynamic.unknown_label", { name: labelKey })}
            </option>`
          : nothing}
        ${options.map(
          (name) => html`
            <option value=${name} ?selected=${name === labelKey}>${name}</option>
          `,
        )}
      </select>
    `;
  }

  /**
   * One entry of the solar daily-forecast list, as a group.
   *
   * The item's value is no longer passed in: the group reads it from the
   * document at its own path, the same way every other group does, and a list
   * index is an ordinary path segment on both sides of the websocket.
   */
  private _renderDailyEnergyEntity(index: number): TemplateResult {
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
          <div class="appliance-summary-left">
            ${renderDragHandle(this)}
            <div class="card-title">
              <strong>${this._tFormat("editor.dynamic.daily_energy_entity", { index: index + 1 })}</strong>
            </div>
          </div>
          <div class="list-actions">
            ${renderRemoveButton(this, {
              onRemove: () =>
                this._removeListItem(
                  ["power_devices", "solar", "forecast", "daily_energy_entity_ids"],
                  index,
                ),
            })}
          </div>
        </div>
        ${this._renderEntityGroup(path, "editor.fields.entity_id", {
          includeDomains: ["sensor"],
          helpKey: "editor.help.solar_daily_energy_entity",
          required: true,
        })}
      </div>
    `;
  }

  private _renderImportPriceWindow(
    windowConfig: unknown,
    index: number,
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
          <div class="appliance-summary-left">
            ${renderDragHandle(this)}
            <div class="card-title">
              <strong>${this._tFormat("editor.dynamic.import_window", { index: index + 1 })}</strong>
              <span class="card-subtitle">${this._t("editor.card.local_time_window")}</span>
            </div>
          </div>
          <div class="list-actions">
            ${renderRemoveButton(this, {
              onRemove: () =>
                this._removeListItem(
                  ["power_devices", "grid", "forecast", "import_price_windows"],
                  index,
                ),
            })}
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

  private _renderControllableCard(controllable: unknown, index: number): TemplateResult {
    const applianceObject = asJsonObject(controllable) ?? {};
    const kind = this._stringValue(applianceObject.kind);
    if (kind === INVERTER_CONTROLLABLE_KIND) {
      return this._renderInverterControllable(applianceObject, index);
    }
    if (kind === "ev_charger") {
      return this._renderEvChargerAppliance(applianceObject, index);
    }
    if (kind === "climate") {
      return this._renderClimateAppliance(applianceObject, index);
    }
    if (kind === "generic") {
      return this._renderGenericAppliance(applianceObject, index);
    }
    return this._renderUnsupportedControllable(applianceObject, index);
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
      <details class="list-card ${isYaml ? "scope-yaml" : ""}">
        <summary>
          <div class="appliance-summary-row">
            <div class="appliance-summary-left">
              ${renderDragHandle(this)}
              ${this._renderSvgIcon(chevronPath, "appliance-chevron")}
              <div class="card-title">
                <strong>${controllableName}</strong>
                <span class="card-subtitle">${controllableId}</span>
              </div>
            </div>
            <div class="list-actions" @click=${this._preventSummaryToggle}>
              ${this._renderControllableModeToggle(index)}
              ${renderRemoveButton(this, {
                onRemove: () => this._removeControllable(index),
              })}
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
                  ${this._renderEntityGroup(
                    [...modePath, "entity_id"],
                    "editor.fields.mode_entity",
                    {
                      includeDomains: ["input_select", "select"],
                      helperKey: "editor.helpers.mode_entity",
                      helpKey: "editor.help.inverter_mode_entity",
                      required: true,
                    },
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
              ${renderDragHandle(this)}
              ${this._renderSvgIcon(chevronPath, "appliance-chevron")}
              <div class="card-title">
                <strong>${applianceName}</strong>
                <span class="card-subtitle">${subtitle}</span>
              </div>
            </div>
            <div class="list-actions" @click=${this._preventSummaryToggle}>
              ${renderRemoveButton(this, {
                onRemove: () => this._removeControllable(index),
              })}
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
      <details class="list-card ${isYaml ? "scope-yaml" : ""}">
        <summary>
          <div class="appliance-summary-row">
            <div class="appliance-summary-left">
              ${renderDragHandle(this)}
              ${this._renderSvgIcon(chevronPath, "appliance-chevron")}
              <div class="card-title">
                <strong>${applianceName}</strong>
                <span class="card-subtitle">${applianceId}</span>
              </div>
            </div>
            <div class="list-actions" @click=${this._preventSummaryToggle}>
              ${this._renderControllableModeToggle(index)}
              ${renderRemoveButton(this, {
                onRemove: () => this._removeControllable(index),
              })}
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
                  ${this._renderEntityGroup(
                    [...basePath, "controls", "charge", "entity_id"],
                    "editor.fields.charge_switch_entity",
                    {
                      includeDomains: ["switch"],
                      helpKey: "editor.help.ev_charge_switch_entity",
                      required: true,
                    },
                  )}
                  ${this._renderEntityGroup(
                    [...basePath, "controls", "use_mode", "entity_id"],
                    "editor.fields.use_mode_entity",
                    {
                      includeDomains: ["input_select", "select"],
                      helpKey: "editor.help.ev_use_mode_entity",
                      required: true,
                    },
                  )}
                  ${this._renderEntityGroup(
                    [...basePath, "controls", "eco_gear", "entity_id"],
                    "editor.fields.eco_gear_entity",
                    {
                      includeDomains: ["input_select", "select"],
                      helpKey: "editor.help.ev_eco_gear_entity",
                      required: true,
                    },
                  )}
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
                html`${renderSortableList({
                  items: vehicles,
                  containerClass: "list-stack",
                  renderItem: (vehicle, vehicleIndex) =>
                    this._renderVehicle(basePath, vehicle, vehicleIndex),
                  onMove: (oldIndex, newIndex) =>
                    this._moveListItem([...basePath, "vehicles"], oldIndex, newIndex),
                })}
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
      <details class="list-card ${isYaml ? "scope-yaml" : ""}">
        <summary>
          <div class="appliance-summary-row">
            <div class="appliance-summary-left">
              ${renderDragHandle(this)}
              ${this._renderSvgIcon(chevronPath, "appliance-chevron")}
              <div class="card-title">
                <strong>${applianceName}</strong>
                <span class="card-subtitle">${applianceId}</span>
              </div>
            </div>
            <div class="list-actions" @click=${this._preventSummaryToggle}>
              ${this._renderControllableModeToggle(index)}
              ${renderRemoveButton(this, {
                onRemove: () => this._removeControllable(index),
              })}
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
                  ${this._renderEntityGroup(
                    [...basePath, "controls", "switch", "entity_id"],
                    "editor.fields.switch_entity",
                    {
                      includeDomains: ["switch"],
                      helpKey: "editor.help.appliance_switch_entity",
                      required: true,
                    },
                  )}
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
      <details class="list-card ${isYaml ? "scope-yaml" : ""}">
        <summary>
          <div class="appliance-summary-row">
            <div class="appliance-summary-left">
              ${renderDragHandle(this)}
              ${this._renderSvgIcon(chevronPath, "appliance-chevron")}
              <div class="card-title">
                <strong>${applianceName}</strong>
                <span class="card-subtitle">${applianceId}</span>
              </div>
            </div>
            <div class="list-actions" @click=${this._preventSummaryToggle}>
              ${this._renderControllableModeToggle(index)}
              ${renderRemoveButton(this, {
                onRemove: () => this._removeControllable(index),
              })}
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
                  ${this._renderEntityGroup(
                    [...basePath, "controls", "climate", "entity_id"],
                    "editor.fields.climate_entity",
                    {
                      includeDomains: ["climate"],
                      helpKey: "editor.help.appliance_climate_entity",
                      required: true,
                    },
                  )}
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
          ${this._renderEntityGroup(
            [...consumptionPath, "energy_entity_id"],
            "editor.fields.consumption_energy_entity",
            {
              includeDomains: ["sensor"],
              helperKey: "editor.helpers.consumption_energy_entity",
              helpKey: "editor.help.consumption_energy_entity",
            },
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
  ): TemplateResult {
    const vehicleObject = asJsonObject(vehicle) ?? {};
    const basePath: PathSegment[] = [...appliancePath, "vehicles", index];
    return html`
      <div class="nested-card">
        <div class="card-header">
          <div class="appliance-summary-left">
            ${renderDragHandle(this)}
            <div class="card-title">
              <strong>${this._stringValue(vehicleObject.name) || this._tFormat("editor.dynamic.vehicle", { index: index + 1 })}</strong>
              <span class="card-subtitle">${this._stringValue(vehicleObject.id) || this._t("editor.values.missing_id")}</span>
            </div>
          </div>
          <div class="list-actions">
            ${renderRemoveButton(this, {
              onRemove: () => this._removeListItem([...appliancePath, "vehicles"], index),
            })}
          </div>
        </div>
        <div class="field-grid">
          ${this._renderRequiredTextField([...basePath, "id"], "editor.fields.vehicle_id", undefined, "editor.help.vehicle_id")}
          ${this._renderRequiredTextField([...basePath, "name"], "editor.fields.vehicle_name")}
          ${this._renderEntityGroup(
            [...basePath, "telemetry", "soc_entity_id"],
            "editor.fields.soc_entity",
            {
              includeDomains: ["sensor"],
              helpKey: "editor.help.vehicle_soc_entity",
              required: true,
            },
          )}
          ${this._renderEntityGroup(
            [...basePath, "telemetry", "charge_limit_entity_id"],
            "editor.fields.charge_limit_entity",
            {
              includeDomains: ["number"],
              helpKey: "editor.help.vehicle_charge_limit_entity",
            },
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
          placeholder=${this.configDefaultHint(path)}
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
    helpKey?: string,
  ): TemplateResult {
    const checked = this._booleanValue(this._getValue(path), defaultValue);
    const toggle = html`
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
    `;
    return html`
      <div class="field toggle-field">
        ${helpKey
          ? html`<div class="field-label-row">${toggle}${this._renderHelpIcon(labelKey, helpKey)}</div>`
          : toggle}
      </div>
    `;
  }

  /**
   * An entity picker, the settings that qualify it, and what it reads — as one.
   *
   * A picker in a bordered block, plus a slot: the settings that belong to
   * this entity are passed *into* it rather than rendered as siblings in the
   * same field grid, which is what makes a polarity read as part of its sensor
   * instead of as a loose select that happens to sit next to one.
   *
   * **Every entity picker in the editor goes through here.** A path with no
   * evaluator of its own is not a reason to render a bare field: the registry's
   * fallback states its current value, so the group is the one control an
   * entity is ever picked in — which is what lets the entities-only view claim
   * it shows all of them.
   *
   * What a revert restores is *not* decided here. The call site knows what it
   * put in the slot; only the evaluator knows which of those the reading was
   * made of, and it says so in the inspection's `dependsOn`. A training window
   * rendered beside a minimum history requirement is the same entity's setting
   * and is left alone by a revert, because it could never have caused one.
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
    } = {},
    slotted: TemplateResult | typeof nothing = nothing,
  ): TemplateResult {
    return html`
      <helman-entity-group
        .hass=${this.hass}
        .fieldHost=${this}
        .path=${path}
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
      },
      this._renderPolarityField(device),
    );
  }

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
  };

  /**
   * Read again now, because something the reading depends on moved.
   *
   * The single trigger for everything that is not the timer: a group mounting,
   * and every write into the draft document. It deliberately does *not* ask
   * which paths changed or which group owns them. The poll is one batched call
   * over the groups the collector finds in the DOM, and a config write is rare
   * enough that asking unconditionally is both simpler than a dependency map
   * and impossible to get subtly wrong -- a field added later cannot forget to
   * opt in.
   *
   * Leading edge, with a trailing call when the burst had more in it. Expanding
   * a section mounts several groups at once and the first of them fires before
   * its siblings exist, so the trailing call is what picks the rest up.
   */
  /**
   * A group announcing itself as it mounts.
   *
   * Deferred to a microtask, unlike a config write, because this one arrives
   * from inside the panel's own render commit: the group's `connectedCallback`
   * runs while Lit is inserting children, after the update is marked done, so
   * writing the reactive `_entityInspections` synchronously would schedule an
   * update from inside one -- the dev warning, and an extra render pass. The
   * write the user caused has no such problem and keeps its leading edge.
   */
  private _handleEntityGroupConnected = (): void => {
    queueMicrotask(() => this._requestEntityInspection());
  };

  private _requestEntityInspection = (): void => {
    if (this._inspectionDebounce !== undefined) {
      this._inspectionTrailing = true;
      return;
    }
    this._inspectionDebounce = setTimeout(() => {
      this._inspectionDebounce = undefined;
      if (this._inspectionTrailing) {
        this._inspectionTrailing = false;
        this._requestEntityInspection();
      }
    }, ENTITY_INSPECTION_DEBOUNCE_MS);
    void this._pollEntityInspections();
  };

  /**
   * Start the idle tick over.
   *
   * Called whenever a request actually goes out, so an immediate poll *resets*
   * the two-second rhythm instead of running beside it. Without this, a burst
   * of edits would leave the timer firing in the gaps between the polls the
   * edits already caused.
   */
  private _restartEntityInspectionTimer(): void {
    if (this._inspectionTimer !== undefined) {
      clearInterval(this._inspectionTimer);
    }
    this._inspectionTimer = setInterval(
      () => void this._pollEntityInspections("idle"),
      ENTITY_INSPECTION_INTERVAL_MS,
    );
  }

  /**
   * The groups actually on screen, read from the DOM at the moment of asking.
   *
   * Deliberately not a set maintained by mount/unmount events. A group cannot
   * announce its own removal — `disconnectedCallback` runs after the browser
   * has detached it, and an event dispatched from a detached node never
   * reaches this element — so a bookkeeping set would grow monotonically and
   * keep polling for groups that are gone. Querying is also simply true: a
   * collapsed `details` renders no group, and a tab switch removes them all.
   *
   * It descends nested shadow roots because a plain `querySelectorAll` stops
   * at the first one: `helman-optimizer-editor` renders the Automation tab
   * inside its own, and a group placed there would simply never be polled —
   * mounted, bordered and permanently blank, with nothing to say it was
   * missed. The whole invariant is that no picker goes factless, so the
   * collector has to reach every group that exists rather than every group
   * this element happened to render itself.
   */
  private _mountedEntityGroups(): HelmanEntityGroup[] {
    return queryDeep<HelmanEntityGroup>(this.shadowRoot, "helman-entity-group");
  }

  /**
   * One call for every mounted group, or none at all.
   *
   * A group is worth asking about when *either* document has something at its
   * path. The draft one is obvious; the saved one is the case that is easy to
   * get wrong — clearing a configured sensor leaves the draft blank, and that
   * is exactly when the saved reading and its revert control need to appear.
   * Skipping it would remove the revert affordance from the single edit most
   * likely to want it. When neither document has anything there is genuinely
   * nothing to ask, and no call goes out at all.
   *
   * A failed tick is swallowed — the last reading stays on screen rather than
   * the panel growing an error banner that reappears every two seconds.
   */
  private async _pollEntityInspections(trigger: "idle" | "change" = "change"): Promise<void> {
    if (!this.hass || !this._config) return;
    if (trigger === "idle" && this._inspectionInFlight > 0) return;
    const saved = this._savedConfig;
    // The mounted groups plus the training tab's depth-table targets (empty
    // outside that tab) -- one poll, one cache, deduplicated by key so a path
    // both a group and the table care about is asked about once.
    const seenKeys = new Set<string>();
    const candidates = [
      ...this._mountedEntityGroups().map((group) => ({
        key: group.key,
        path: group.path,
        ownEntity: false,
      })),
      ...this._trainingDepthTargets(),
    ];
    const targets = candidates
      .filter((target) => {
        if (seenKeys.has(target.key)) return false;
        seenKeys.add(target.key);
        return true;
      })
      .filter(
        ({ path, ownEntity }) =>
          ownEntity ||
          stringValue(this._getValue(path)) !== "" ||
          (!!saved && stringValue(getValueAtPath(saved, path)) !== ""),
      );
    if (targets.length === 0) {
      // Clearing is an answer like any other, so it takes an id too. Without
      // one, a slow earlier request could resolve after this and repaint the
      // reading for the entity that was just cleared.
      this._inspectionApplied = ++this._inspectionSequence;
      if (Object.keys(this._entityInspections).length > 0) {
        this._entityInspections = {};
      }
      return;
    }
    const sequence = ++this._inspectionSequence;
    this._restartEntityInspectionTimer();
    this._inspectionInFlight += 1;
    try {
      const response = await this.hass.callWS<{ results?: EntityInspectionResult[] }>({
        type: "helman/inspect_entities",
        config: this._config,
        ...(saved ? { saved_config: saved } : {}),
        // ``ownEntity`` is this element's own bookkeeping about which rows
        // survive the "is the picker set" filter. The request carries paths and
        // nothing else, so it is dropped here rather than sent and ignored.
        targets: targets.map(({ key, path }) => ({ key, path })),
      });
      // A slower earlier request must never repaint over a newer answer: that
      // would put the stale reading back on screen, which is the whole defect
      // the immediate poll exists to remove.
      if (sequence < this._inspectionApplied) return;
      this._inspectionApplied = sequence;
      const next: Record<string, EntityInspectionResult> = {};
      for (const row of response?.results ?? []) {
        next[row.key] = row;
      }
      this._entityInspections = next;
    } catch {
      // Polled: a dropped tick costs a stale badge, not a message.
    } finally {
      this._inspectionInFlight -= 1;
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
      power_devices: { errors: 0, warnings: 0 },
      training: { errors: 0, warnings: 0 },
      automation: { errors: 0, warnings: 0 },
      controllables: { errors: 0, warnings: 0 },
      visualization: { errors: 0, warnings: 0 },
    };

    if (this._validation) {
      for (const issue of this._validation.errors) {
        const tabId = TAB_SECTIONS[issue.section] ?? "power_devices";
        counts[tabId].errors += 1;
      }
      for (const issue of this._validation.warnings) {
        const tabId = TAB_SECTIONS[issue.section] ?? "power_devices";
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
      const [
        loadedResult,
        liveApplianceMetadataResult,
        schemaResult,
        defaultsResult,
        labelNamesResult,
      ] = await Promise.allSettled([
        this.hass.callWS<unknown>({ type: "helman/get_config" }),
        this._loadLiveApplianceMetadata(),
        fetchOptimizerSchema(this.hass),
        fetchConfigDefaults(this.hass),
        this._loadHaLabelNames(),
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
      this._configDefaults =
        defaultsResult.status === "fulfilled" ? defaultsResult.value : null;
      this._haLabelNames =
        labelNamesResult.status === "fulfilled" ? labelNamesResult.value : null;
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
    const existingKeys = objectEntries(this._getValue(["visualization", "device_label_text"])).map(
      ([key]) => key,
    );
    const categoryKey = createCategoryKey(existingKeys);
    this._applyMutation((draft) => {
      setValueAtPath(draft, ["visualization", "device_label_text", categoryKey], {});
    });
  };

  private _handleAddDeviceLabel(categoryKey: string): void {
    const existingKeys = objectEntries(this._getValue(["visualization", "device_label_text", categoryKey])).map(
      ([key]) => key,
    );
    // A new row starts on a label that exists, when the registry is in hand:
    // the picker's whole point is that a key is a Home Assistant label, and a
    // placeholder key would open as "not a Home Assistant label".
    const firstFreeLabel = (this._haLabelNames ?? []).find(
      (name) => !existingKeys.includes(name),
    );
    const labelKey = firstFreeLabel ?? createLabelKey(existingKeys);
    this._applyMutation((draft) => {
      setValueAtPath(draft, ["visualization", "device_label_text", categoryKey, labelKey], "");
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
    const bucket = this._bucketKindOf(schema);
    // Ids are unique across both buckets, not just the one being added to --
    // `config_validation.py`'s `_read_optimizer_buckets` rejects a collision
    // either way, so the draft must not offer one.
    const existingIds = [
      ...(asJsonArray(this._getValue(["automation", "appliance_optimizers"])) ?? []),
      ...(asJsonArray(this._getValue(["automation", "system_optimizers"])) ?? []),
    ]
      .map((optimizer) => this._stringValue(asJsonObject(optimizer)?.id))
      .filter((value) => value.length > 0);
    const draftOptimizer = createOptimizerDraft(existingIds, schema.kind, schema.newDraft);
    this._applyMutation((draft) => {
      const automationObject = asJsonObject(getValueAtPath(draft, ["automation"]));
      if (!automationObject) {
        setValueAtPath(draft, ["automation"], {
          enabled: true,
          appliance_optimizers: bucket === "appliance_optimizers" ? [draftOptimizer] : [],
          system_optimizers: bucket === "system_optimizers" ? [draftOptimizer] : [],
        });
        return;
      }
      appendListItem(draft, ["automation", bucket], draftOptimizer);
    });
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
        if (!Array.isArray(automationObject["appliance_optimizers"])) {
          setValueAtPath(draft, ["automation", "appliance_optimizers"], []);
        }
        if (!Array.isArray(automationObject["system_optimizers"])) {
          setValueAtPath(draft, ["automation", "system_optimizers"], []);
        }
        return;
      }

      setValueAtPath(draft, ["automation"], {
        enabled,
        appliance_optimizers: [],
        system_optimizers: [],
      });
    });
  }

  private _setBoolean(path: PathSegment[], value: boolean): void {
    this._applyMutation((draft) => {
      setValueAtPath(draft, path, value);
    });
  }

  /**
   * Keep each group member's `climate_mode` consistent with the controllable it names.
   *
   * Only `appliance_runtime` has a climate mode to keep, so only it is walked —
   * the other kinds drive the inverter, which has no modes of this sort.
   * `appliance_runtime`'s own `controllableKinds` are all appliance kinds, so
   * `OptimizerSpec.bucket` places it in `appliance_optimizers` always -- the
   * only bucket this needs to walk.
   */
  private _normalizeApplianceOptimizerTargets(config: JsonObject): boolean {
    const optimizers =
      asJsonArray(getValueAtPath(config, ["automation", "appliance_optimizers"])) ?? [];
    let changed = false;
    optimizers.forEach((optimizer, index) => {
      const optimizerObject = asJsonObject(optimizer);
      const optimizerKind = this._stringValue(optimizerObject?.kind);
      if (!optimizerObject || optimizerKind !== APPLIANCE_RUNTIME_OPTIMIZER_KIND) {
        return;
      }

      // One target per group member, in priority order.
      const listPath: PathSegment[] = [
        "automation",
        "appliance_optimizers",
        index,
        "target",
        "controllables",
      ];
      const members = asJsonArray(getValueAtPath(config, listPath)) ?? [];
      members.forEach((_member, memberIndex) => {
        const targetPath: PathSegment[] = [...listPath, memberIndex];
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
    });
    return changed;
  }

  /**
   * How every `_set*` helper writes into the draft document.
   *
   * They all funnel through here, which is why the entity groups' re-read is
   * wired into `_markDraftChanged` below rather than into the individual
   * renderers: a field added tomorrow gets a live reading for free and cannot
   * forget to ask for one. It is not the *only* door into the draft, though --
   * see `_markDraftChanged`.
   */
  private _applyMutation(mutator: (draft: JsonObject) => void): void {
    const draft = cloneJson(this._config ?? {});
    mutator(draft);
    this._config = draft;
    this._markDraftChanged();
  }

  /**
   * What every change to the draft owes, wherever the change came from.
   *
   * The panel's own fields all funnel through `_applyMutation`, but the
   * optimizer editor hands back a whole document of its own, and an entity
   * added there would otherwise never get a live reading. Keeping the
   * bookkeeping in one function is what stops the two paths drifting -- the
   * previous version of this comment claimed `_applyMutation` was the only
   * door, and it was already wrong.
   */
  private _markDraftChanged(): void {
    this._dirty = true;
    this._validation = null;
    this._message = null;
    this._requestEntityInspection();
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

  configDefaultHint(path: PathSegment[]): string {
    return configDefaultHint(this._configDefaults, path);
  }

  /**
   * The backend's default for a control that always renders some state.
   *
   * A checkbox drawn unchecked, or a select drawn blank, states that the
   * setting is off while the backend has it on -- a user who wants it off
   * would change nothing and leave it running. So these read the default
   * rather than falling back to an empty value.
   */
  private _configDefaultValue(path: PathSegment[]): string | number | boolean | undefined {
    return configDefaultValue(this._configDefaults, path);
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

  /**
   * The label names Home Assistant has, for the badge-text picker.
   *
   * ``device_label_text`` is keyed by label *name* -- that is what
   * ``_apply_label_badge_texts`` matches a device's labels against -- so the
   * picker offers names, not ids.
   */
  private async _loadHaLabelNames(): Promise<string[] | null> {
    if (!this.hass) {
      return null;
    }
    try {
      const labels = await this.hass.callWS<{ name?: unknown }[]>({
        type: "config/label_registry/list",
      });
      if (!Array.isArray(labels)) {
        return null;
      }
      const names = labels
        .map((label) => (typeof label?.name === "string" ? label.name.trim() : ""))
        .filter((name) => name.length > 0);
      return [...new Set(names)].sort((left, right) => left.localeCompare(right));
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
