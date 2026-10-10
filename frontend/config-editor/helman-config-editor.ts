import { fetchEnergyImportPreview, type EnergyImportPreview } from "../cards/helman-api";
import { LitElement, css, html, nothing } from "lit";
import type { PropertyValues, TemplateResult } from "lit";
import { cache } from "lit/directives/cache.js";
import { keyed } from "lit/directives/keyed.js";
import { repeat } from "lit/directives/repeat.js";

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
  createDailyEnergyEntityDraft,
  createOptimizerDraft,
  createImportPriceWindowDraft,
  canonicalJson,
  getValueAtPath,
  moveListItem,
  removeListItem,
  setValueAtPath,
  unsetValueAtPath,
} from "../cards/shared/config/config-document";
import {
  assignGroup,
  canHaveChildren,
  consumerGroups,
  DEVICE_FILTERS,
  deviceChildren,
  deviceIdFor,
  deviceKind,
  CONTROLLABLE_ID_INVERTER,
  findInverter,
  INVERTER_PATH,
  isCarvedMeterOwner,
  isSchedulable,
  iterDevices,
  meterlessChildren,
  ownMeter,
  renameGroupReferences,
  slugId,
  stripGroupReferences,
  SWITCH_CONTROL_DOMAINS,
  type DeviceFilter,
  type GroupedDeviceEntry,
} from "../cards/shared/config/devices";
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
import { mdiAlertOutline, mdiDragVertical } from "@mdi/js";
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
  formatError,
  renderOptionalTextField,
  renderSimpleSection,
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
import "../cards/shared/devices/helman-device-editor";
import {
  TRAINING_STATUS_CHANGED,
  asTrainingStatus,
  type TrainingStatus,
  type TrainingStatusChangedDetail,
} from "./training-status";
import {
  INSPECTOR_CARD_TAG,
  INSPECTOR_EMBED_CONFIGS,
  inspectorCardLoader,
  nodeDetailDialogLoader,
  type InspectorEmbed,
  type SolarInspectorCardElement,
} from "./solar-inspector-embed";
import type { HomeAssistant } from "../hass-frontend/src/types";
import { HelmanClient } from "../cards/helman/client";
import type { TreeItem } from "../cards/helman/tree-item";
import { hydrateItem } from "../cards/helman/tree-item-hydrator";
import {
  getLocalizeFunction as getCardLocalizeFunction,
  type LocalizeFunction as CardLocalizeFunction,
} from "../cards/localize/localize";
import "./info-callout";
import "../cards/shared/config/entity-group";
import {
  entityGroupKey,
  renderEntityGroup,
  type EntityFact,
  type EntityGroupOptions,
} from "../cards/shared/config/entity-group";
import { SENSOR_KIND_FILTERS } from "../cards/shared/config/sensor-kind";
import { EntityInspectionController } from "../cards/shared/config/entity-inspection-controller";
import {
  EDITABLE_DEVICE_KINDS,
  SEEDED_PROJECTION,
  deviceEditorStyles,
  deviceIdentityTargets,
  deviceIssues,
  deviceName,
  newIssueSections,
  renderDeviceIssues,
  renderIssueCountBadge,
  renderTrackedSection,
  trainingDepthCell,
  validationPath,
  type DeviceConfigChangedDetail,
  type HelmanDeviceEditor,
} from "../cards/shared/devices/helman-device-editor";
import {
  deviceEnergyStyles,
  renderDeviceEnergyValue,
  type DeviceEnergyInput,
} from "../cards/shared/devices/device-energy";
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
  VendorsResponse,
} from "../cards/shared/config/types";
import type { ScopeAdapterValidationError } from "./config-scope-adapters";
import { normalizeYamlValue } from "../cards/shared/config/yaml-codec";

const APPLIANCE_RUNTIME_OPTIMIZER_KIND = "appliance_runtime";

/** The chevron of a collapsible card, as the device cards draw it. */
const GROUPING_CHEVRON_PATH = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";

/** A group's device chips move between lists but never sort within one. */
const MEMBER_SORTABLE_OPTIONS = { sort: false };

const stopEvent = (event: Event): void => event.stopPropagation();

/** Which device sits at which path; changes only when an edit moves devices. */
function devicePathSignature(config: JsonObject | null): string {
  return iterDevices(config)
    .map(({ device, path }) => `${entityGroupKey(path)}=${stringValue(device.id)}`)
    .join("|");
}

/** The two config buckets `automation` splits its optimizers into (#271, P1). */
type OptimizerBucket = OptimizerConfigBucket;

/**
 * The schedule actions an inverter's `controls.mode.options` maps, in the order
 * the card lays them out. Mirrors `CONTROLLABLE_SPECS["inverter"]` in Python:
 * the backend owns the list, this is the editor's copy of it.
 */
type InverterSectionKey = "hardware" | "controls" | "action_options";

/** The inverter sub-section that holds the field an issue points at. */
function inverterSectionOfIssue(path: readonly PathSegment[], issuePath: string): InverterSectionKey {
  const rest = issuePath.slice(validationPath(path).length).replace(/^\./, "");
  if (rest === "profile" || rest.startsWith("profile.")) return "hardware";
  if (rest.startsWith("controls.mode.options")) return "action_options";
  return "controls";
}

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
 * How often the editor asks `helman/training/status`, for the Training tab's
 * panels and its tab-bar badge alike. Slower than the entity poll: a training
 * run takes minutes, and the answer is read from memory on every tick.
 */
const TRAINING_STATUS_INTERVAL_MS = 5000;

// DUMMY: reuse Home Assistant's visual condition builder. Value is not persisted
// yet — this only proves the editor renders and round-trips inside our panel.
const OPTIMIZER_CONDITION_SELECTOR = {
  condition: {},
} as const;

/** One row of a training tab depth table -- see `_renderTrainingDepthTable`. */
interface TrainingDepthRow {
  /** Already localized, or (for a controllable) the reader's own name. */
  label: string;
  /** Where the entity id lives -- also the key the entity readings are read by. */
  path: PathSegment[];
  /** i18n key for what the trainer takes from this entity; the appliance table has no role column. */
  roleKey?: string;
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

/** One device of the appliance-energy table -- see `_renderApplianceEnergyTable`. */
interface ApplianceEnergyDepthDevice {
  index: number;
  id: string;
  name: string;
  device: JsonObject;
  learns: boolean;
  lookbackDays: number;
  /** Its (effective) meter, sub-meters, power sensor and activity entity. */
  entities: TrainingDepthRow[];
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
    _deviceModes: { state: true },
    _deviceYamlValues: { state: true },
    _deviceYamlErrors: { state: true },
    _deviceFilter: { state: true },
    _energyImport: { state: true },
    _deviceActionMessage: { state: true },
    _importLoading: { state: true },
    _addDeviceTarget: { state: true },
    _liveApplianceMetadata: { state: true },
    _optimizerSchema: { state: true },
    _configDefaults: { state: true },
    _helpDialog: { state: true },
    _entitiesOnly: { state: true },
    _inverterOpenSections: { state: true },
    _trainingStatus: { state: true },
    _inspectorCardError: { state: true },
    _deviceTreeItems: { state: true },
    _deviceDetail: { state: true },
    _vendors: { state: true },
  };

  static styles = [
    configFormStyles,
    optimizerCardStyles,
    deviceEditorStyles,
    deviceEnergyStyles,
    css`
    :host {
      display: block;
      min-height: 100%;
      background: var(--primary-background-color);
      color: var(--primary-text-color);
    }

    /* One group, one line: handle, name, id, short name, remove -- wrapping
       only when the card is too narrow to hold them. The columns are named
       once, in a head row, rather than labelled on every row. */
    .group-rows {
      display: grid;
      gap: 8px;
      padding: 0 16px 8px;
    }

    .group-rows-list {
      display: grid;
      gap: 8px;
    }

    .group-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }

    .group-row > .group-name-cell {
      flex: 2 1 220px;
      min-width: 150px;
    }

    /* An id is a short slug and the short name usually an emoji or two, so
       they take what is left over rather than half the row. */
    .group-row > .group-id-cell,
    .group-row > .group-short-name-cell {
      flex: 1 1 120px;
      min-width: 100px;
      max-width: 240px;
    }

    .group-row > .list-actions {
      margin-left: auto;
      flex: 0 0 auto;
    }

    .group-row-head label {
      font-weight: 600;
      font-size: 0.93rem;
      color: var(--secondary-text-color);
    }

    /* Hold the head row's columns over the drag handle and the remove button
       below them: each is its 18px glyph plus padding. */
    .group-row-handle-spacer,
    .group-row-actions-spacer {
      flex: 0 0 auto;
      width: 32px;
    }

    /* A group's devices, on their own line under its fields. The list keeps
       a height when empty, so a device can still be dropped into it. */
    .group-members {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-height: 32px;
      padding: 4px;
      box-sizing: border-box;
      border: 1px dashed var(--divider-color);
      border-radius: 12px;
    }

    .group-row > ha-sortable {
      flex: 1 0 100%;
    }

    .group-unassigned {
      display: grid;
      gap: 6px;
      padding: 0 16px 8px;
    }

    .member-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border: 1px solid var(--divider-color);
      border-radius: 999px;
      background: var(--secondary-background-color);
      font-size: 0.93rem;
    }

    /* The whole chip is the drag surface; like the sortable handle, it takes
       touch-action: none so on touch a drag wins over page scrolling. */
    .member-chip.draggable {
      cursor: grab;
      padding-left: 4px;
      touch-action: none;
    }

    .member-chip-glyph {
      width: 16px;
      height: 16px;
      fill: var(--secondary-text-color);
    }

    .member-parent {
      color: var(--secondary-text-color);
    }

    .member-parent::before {
      content: "· ";
    }

    .grouping-name {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 16px 16px 8px;
    }

    .grouping-name-input,
    .grouping-id-input {
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

    .tab-icon {
      flex-shrink: 0;
      width: 16px;
      height: 16px;
      fill: currentColor;
    }

    .yaml-field--document ha-yaml-editor {
      --code-mirror-height: clamp(420px, 72vh, 980px);
      --code-mirror-max-height: clamp(420px, 72vh, 980px);
    }

    .yaml-error {
      margin: 0;
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

    /* The Devices tab. A hidden card keeps its place in the sortable list, so
       the list's indices stay the document's; the card styles set a display,
       which would otherwise win over the hidden attribute. */
    details.device-card[hidden] {
      display: none;
    }

    .device-filter {
      justify-self: start;
    }

    /* A slot a hardware profile fills: read-only, where its picker would be. */
    .vendor-provided-entity {
      font-family: var(--code-font-family, monospace);
      overflow-wrap: anywhere;
    }

    .vendor-resolved ul {
      margin: 6px 0 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 4px;
    }

    .vendor-resolved li {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 12px;
      justify-content: space-between;
      overflow-wrap: anywhere;
    }

    .vendor-resolved .unresolved,
    .vendor-provided-entity.unresolved {
      color: var(--error-color);
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
  private _activeTab: TabId = "energy_nodes";
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
  /**
   * The hardware profiles, and what each draft device's profile owns.
   *
   * `helman/get_vendors` is the only place the editor learns which paths a
   * profile owns: re-asked whenever a device's `profile` changes in the draft
   * (`_vendorsKey`), never derived here.
   */
  private _vendors: VendorsResponse | null = null;
  private _vendorsKey: string | null = null;
  private _vendorsSequence = 0;
  /**
   * The inverter section's open sub-sections. Like a consumer card's, all start
   * closed; a section that gains a validation issue is opened, and only the
   * reader closes one.
   */
  private _inverterOpenSections = new Set<InverterSectionKey>();
  /** The inverter issues the last validation report raised, so only new ones open. */
  private _inverterFlaggedIssues = new Set<string>();
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
  /** Per-device Visual / YAML state, keyed by the device's path key. */
  private _deviceModes: Partial<Record<string, EditorMode>> = {};
  private _deviceYamlValues: Partial<Record<string, JsonValue>> = {};
  private _deviceYamlErrors: Partial<Record<string, string>> = {};
  /** Which devices the Devices tab lists; the rest stay rendered but hidden. */
  private _deviceFilter: DeviceFilter = "all";
  private _energyImport: { preview: EnergyImportPreview; draft: JsonObject } | null = null;
  private _deviceActionMessage = "";
  private _importLoading = false;
  private _energyImportRequest = 0;

  /** The path key of the device list whose "Add device" picker is open. */
  private _addDeviceTarget: string | null = null;
  private _liveApplianceMetadata: ApplianceMetadataResponse | null = null;
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
  // One collector for the whole editor: see `EntityInspectionController`.

  /** The stored document, as read. What a revert restores from. */
  private _savedConfig: JsonObject | null = null;
  private _inspections = new EntityInspectionController(this, {
    hass: () => this.hass,
    config: () => this._config,
    saved: () => this._savedConfig,
    // The training tab's depth tables and the devices tab's names and icons
    // (both empty outside their tab) ride the same poll and cache.
    extraTargets: () => [...this._trainingDepthTargets(), ...this._deviceIdentityTargets()],
    mutate: (mutator) => this._applyMutation(mutator),
  });

  // --- Training status -------------------------------------------------------
  //
  // One poll feeds both the Training tab's panels and its tab-bar badge, so the
  // badge shows a failure without the tab being open. `null` until the first
  // answer, and kept on a failed tick like the entity poll's last reading.
  private _trainingStatus: TrainingStatus | null = null;
  /**
   * The one-shot loader for the card artifact, and the cards built from it --
   * one per embed (the solar and the house Diagnostics), sharing the loader
   * because they are one artifact.
   *
   * Both survive the section being collapsed and reopened: the loader so the
   * artifact is fetched and evaluated once, each element so reopening shows the
   * day the reader had paged to rather than refetching it. Created on the first
   * open of a Diagnostics panel that embeds one and never on a `hass` tick --
   * see `_handleInspectorDiagnosticsToggle`.
   */
  private _inspectorCardLoad?: () => Promise<void>;
  /**
   * Whether the reader has opened each embed's panel at all.
   *
   * Separate from the loader, because the loader can be a no-op: Home Assistant
   * loads every Lovelace resource the first time any dashboard renders, so on the
   * ordinary path into this page -- Overview, then Helman in the sidebar -- the
   * card tag is already registered and there is nothing to load. Mounting on
   * "the tag exists" would then mount the card inside the closed panel, with its
   * clock, its listeners and a day fetch, which is the whole thing this is lazy
   * to avoid. The open is the signal; loading is only what may follow it.
   */
  private _inspectorRequested: Record<InspectorEmbed, boolean> = { solar: false, house: false };
  private _inspectorCard: Partial<Record<InspectorEmbed, SolarInspectorCardElement>> = {};
  private _inspectorCardError: string | null = null;
  /**
   * The saved device tree's items by `_deviceTreeKey`, as helman-card
   * hydrates them: what the appliance-energy table's device names open.
   * Fetched on the table's first render and again whenever the saved config
   * is re-read; `null` until then.
   */
  private _deviceTreeItems: Map<string, TreeItem> | null = null;
  private _deviceTreeRequested = false;
  private _deviceTreeSequence = 0;
  /** One loader for the dialog, so concurrent clicks share its import. */
  private _deviceDetailLoad?: () => Promise<void>;
  /** The device whose detail dialog is open. */
  private _deviceDetail: TreeItem | null = null;
  /** The card's own localize: the device detail dialog reads `node_detail.*` keys. */
  private _cardLocalize?: CardLocalizeFunction;
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
      this._cardLocalize = getCardLocalizeFunction(hass as unknown as HomeAssistant);
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
    if (this._trainingStatusTimer !== undefined) {
      clearInterval(this._trainingStatusTimer);
      this._trainingStatusTimer = undefined;
    }
  }

  protected willUpdate(changedProperties: PropertyValues<this>): void {
    super.willUpdate(changedProperties);
    if (changedProperties.has("_validation")) {
      const path = [...INVERTER_PATH];
      const { flagged, fresh } = newIssueSections(
        this._validation,
        path,
        this._inverterFlaggedIssues,
        (issuePath) => inverterSectionOfIssue(path, issuePath),
      );
      if (fresh.length) {
        this._inverterOpenSections = new Set([...this._inverterOpenSections, ...fresh]);
      }
      this._inverterFlaggedIssues = flagged;
    }
  }

  protected updated(changedProperties: PropertyValues<this>): void {
    super.updated(changedProperties);
    if (!this._hasLoadedOnce && this.hass) {
      this._hasLoadedOnce = true;
      void this._loadConfig({ showMessage: false });
      void this._pollTrainingStatus();
    }
    if (this.hass && this._config) {
      const inverter = findInverter(this._config);
      const vendorsKey = canonicalJson([
        ...(inverter ? [{ device: inverter, path: [...INVERTER_PATH] }] : []),
        ...iterDevices(this._config),
      ]
        .filter(({ device }) => device.profile !== undefined)
        .map(({ device, path }) => [validationPath(path), device.profile]));
      if (vendorsKey !== this._vendorsKey) {
        this._vendorsKey = vendorsKey;
        void this._loadVendors();
      }
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
    for (;;) {
      const pending = [
        ...this.renderRoot.querySelectorAll<HelmanDeviceEditor>("helman-device-editor"),
      ].filter((editor) => editor.isUpdatePending);
      if (pending.length === 0) return;
      await Promise.all(pending.map((editor) => editor.updateComplete));
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
      ${this._deviceDetail
        ? html`
            <node-detail-dialog
              .hass=${this.hass}
              .localize=${this._cardLocalize}
              .open=${true}
              .params=${{ nodeType: "device", item: this._deviceDetail }}
              @closed=${() => {
                this._deviceDetail = null;
              }}
            ></node-detail-dialog>
          `
        : nothing}
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
                // The training tab's depth table and the devices tab's
                // name and icon placeholders ask about paths no mounted
                // `helman-entity-group` announces -- nothing else triggers a
                // poll on a plain tab switch, so this one does.
                if (tab.id === "training" || tab.id === "devices") {
                  this._inspections.request();
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
      case "energy_nodes":
        return this._renderTabScope(
          TAB_SCOPE_IDS.energy_nodes,
          this._renderEnergyNodesTab(),
        );
      case "training":
        return this._renderTabScope(TAB_SCOPE_IDS.training, this._renderTrainingTab());
      case "automation":
        return this._renderTabScope(
          TAB_SCOPE_IDS.automation,
          this._renderAutomationTab(),
        );
      case "devices":
        return this._renderTabScope(TAB_SCOPE_IDS.devices, this._renderDevicesTab());
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
   * On every tab rather than only on Energy nodes, which is where the noise
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
   * Deliberately *not* a shadow-crossing walk, unlike the entity inspection
   * collector's.
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
    options: { initialOpen?: boolean; badge?: TemplateResult | typeof nothing } = {},
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
            ${options.badge ? html`<div class="device-badges">${options.badge}</div>` : nothing}
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
    return renderSimpleSection(label, content, options);
  }

  private _getDeviceMode(path: PathSegment[]): EditorMode {
    return this._deviceModes[entityGroupKey(path)] ?? "visual";
  }

  private _renderDeviceModeToggle(path: PathSegment[]): TemplateResult {
    return renderItemModeToggle(this, this._getDeviceMode(path), (mode) => {
      if (mode === "yaml") {
        void this._enterDeviceYamlMode(path);
      } else {
        this._exitDeviceYamlMode(path);
      }
    });
  }

  private async _enterDeviceYamlMode(path: PathSegment[]): Promise<void> {
    if (this._getDeviceMode(path) === "yaml") return;
    const key = entityGroupKey(path);
    try {
      await loadHaYamlEditor();
      if (!this._config) return;
      const value = this._getValue(path) as JsonValue;
      this._deviceModes = { ...this._deviceModes, [key]: "yaml" };
      this._deviceYamlValues = { ...this._deviceYamlValues, [key]: value };
      const nextErrors = { ...this._deviceYamlErrors };
      delete nextErrors[key];
      this._deviceYamlErrors = nextErrors;
      this._message = null;
    } catch (error) {
      this._message = {
        kind: "error",
        text: this._formatError(error, this._t("editor.messages.load_ha_yaml_editor_failed")),
      };
    }
  }

  private _exitDeviceYamlMode(path: PathSegment[]): void {
    const key = entityGroupKey(path);
    if (this._getDeviceMode(path) !== "yaml" || this._deviceYamlErrors[key]) return;
    const nextModes = { ...this._deviceModes };
    delete nextModes[key];
    const nextValues = { ...this._deviceYamlValues };
    delete nextValues[key];
    const nextErrors = { ...this._deviceYamlErrors };
    delete nextErrors[key];
    this._deviceModes = nextModes;
    this._deviceYamlValues = nextValues;
    this._deviceYamlErrors = nextErrors;
  }

  /**
   * Move a device within its list, and return every device to visual mode.
   *
   * `_deviceModes`, `_deviceYamlValues` and `_deviceYamlErrors` are keyed by
   * the device's path, so a move, a remove or a new parent leaves them
   * describing a different card than the one they were opened on. Clearing all
   * three is one rule that cannot go stale, where remapping every key through
   * every move would be a lot more code for a rare interaction. Nothing is lost
   * but YAML text that does not parse yet: the draft already holds the last
   * value that did.
   */
  private _moveDevice(listPath: PathSegment[], fromIndex: number, toIndex: number): void {
    this._resetDeviceModes();
    this._moveListItem(listPath, fromIndex, toIndex);
  }

  /** Remove a device with its subtree; an emptied `children` list goes too. */
  private _removeDevice(path: PathSegment[]): void {
    this._resetDeviceModes();
    this._removeListItem(path.slice(0, -1), path[path.length - 1] as number);
  }

  private _resetDeviceModes(): void {
    this._addDeviceTarget = null;
    this._deviceModes = {};
    this._deviceYamlValues = {};
    this._deviceYamlErrors = {};
  }

  /** Replacing an ancestor invalidates every descendant's path-keyed editor state. */
  private _clearDescendantDeviceModes(path: PathSegment[]): void {
    const prefix = `${entityGroupKey(path)}.`;
    const keep = <T>(values: Partial<Record<string, T>>): Partial<Record<string, T>> =>
      Object.fromEntries(Object.entries(values).filter(([key]) => !key.startsWith(prefix)));
    this._deviceModes = keep(this._deviceModes);
    this._deviceYamlValues = keep(this._deviceYamlValues);
    this._deviceYamlErrors = keep(this._deviceYamlErrors);
    if (this._addDeviceTarget?.startsWith(prefix)) this._addDeviceTarget = null;
  }

  private _handleDeviceYamlChanged(
    path: PathSegment[],
    detail: YamlEditorValueChangedDetail,
  ): void {
    const key = entityGroupKey(path);
    const parsed = parseItemYaml(detail);
    if (!parsed.ok) {
      this._deviceYamlErrors = {
        ...this._deviceYamlErrors,
        [key]: detail.errorMsg ?? this._t(parsed.errorKey),
      };
      return;
    }
    try {
      const nextConfig = cloneJson(this._config ?? {});
      setValueAtPath(nextConfig, path, cloneJson(parsed.value));
      this._clearDescendantDeviceModes(path);
      this._config = nextConfig as JsonObject;
      this._dirty = true;
      this._validation = null;
      this._message = null;
      this._deviceYamlValues = { ...this._deviceYamlValues, [key]: parsed.value };
      const nextErrors = { ...this._deviceYamlErrors };
      delete nextErrors[key];
      this._deviceYamlErrors = nextErrors;
    } catch (error) {
      this._deviceYamlErrors = {
        ...this._deviceYamlErrors,
        [key]: this._formatError(error, this._t("editor.yaml.errors.apply_failed")),
      };
    }
  }

  private _renderDeviceYamlEditor(path: PathSegment[]): TemplateResult {
    const key = entityGroupKey(path);
    return renderItemYamlEditor(this, {
      id: `device-${key.replaceAll(".", "-")}`,
      value: (this._deviceYamlValues[key] ?? this._getValue(path)) as JsonValue,
      error: this._deviceYamlErrors[key],
      onChange: (detail) => this._handleDeviceYamlChanged(path, detail),
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
        { initialOpen: false },
      )}
    `;
  }

  private _renderEnergyNodesTab(): TemplateResult {
    const dailyEnergyEntityIds =
      asJsonArray(this._getValue(["energy_nodes", "solar", "forecast", "daily_energy_entity_ids"])) ?? [];
    const importPriceWindows =
      asJsonArray(this._getValue(["energy_nodes", "grid", "forecast", "import_price_windows"])) ?? [];

    return html`
      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.energy_nodes.inverter,
        this._renderInverterSection(),
        {
          initialOpen: false,
          badge: renderIssueCountBadge(this, this._validation, deviceIssues(this._validation, [...INVERTER_PATH])),
        },
      )}

      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.energy_nodes.house,
        html`
          <div class="field-grid">
            ${this._renderPowerEntityGroup(
              "house",
              "editor.fields.house_power_entity",
              "editor.help.house_power_entity",
              true,
            )}
          </div>

          ${this._renderSectionScope(
            SECTION_SCOPE_IDS.energy_nodes.house_forecast,
            html`
              <div class="field-grid">
                ${this._renderEntityGroup(
                  ["energy_nodes", "house", "forecast", "total_energy_entity_id"],
                  "editor.fields.forecast_total_energy_entity",
                  {
                    includeDomains: ["sensor"],
                    sensorKind: "energy",
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
        SECTION_SCOPE_IDS.energy_nodes.solar,
        html`
          <div class="field-grid field-grid--roomy">
            ${this._renderPowerEntityGroup(
              "solar",
              "editor.fields.power_entity",
              "editor.help.solar_power_entity",
            )}
            ${this._renderEntityGroup(
              ["energy_nodes", "solar", "entities", "today_energy"],
              "editor.fields.today_energy_entity",
              {
                includeDomains: ["sensor"],
                sensorKind: "energy",
                helpKey: "editor.help.solar_today_energy_entity",
              },
            )}
          </div>

          ${this._renderSectionScope(
            SECTION_SCOPE_IDS.energy_nodes.solar_forecast,
            html`
              <p class="inline-note">${this._t("editor.notes.solar_forecast_bias_correction")}</p>
              <div class="field-grid field-grid--roomy">
                ${this._renderEntityGroup(
                  ["energy_nodes", "solar", "forecast", "total_energy_entity_id"],
                  "editor.fields.forecast_total_energy_entity",
                  {
                    includeDomains: ["sensor"],
                    sensorKind: "energy",
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
                    ["energy_nodes", "solar", "forecast", "daily_energy_entity_ids"],
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
        SECTION_SCOPE_IDS.energy_nodes.battery,
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
              ["energy_nodes", "battery", "entities", "remaining_energy"],
              "editor.fields.remaining_energy_entity",
              {
                includeDomains: ["sensor"],
                sensorKind: "energy",
                helpKey: "editor.help.battery_remaining_energy_entity",
              },
            )}
            ${this._renderEntityGroup(
              ["energy_nodes", "battery", "entities", "capacity"],
              "editor.fields.capacity_entity",
              {
                includeDomains: ["sensor"],
                sensorKind: "energy",
                helpKey: "editor.help.battery_capacity_entity",
              },
            )}
            ${this._renderEntityGroup(
              ["energy_nodes", "battery", "entities", "min_soc"],
              "editor.fields.min_soc_entity",
              {
                includeDomains: ["sensor"],
                sensorKind: "soc",
                helpKey: "editor.help.battery_min_soc_entity",
              },
            )}
            ${this._renderEntityGroup(
              ["energy_nodes", "battery", "entities", "max_soc"],
              "editor.fields.max_soc_entity",
              {
                includeDomains: ["sensor"],
                sensorKind: "soc",
                helpKey: "editor.help.battery_max_soc_entity",
              },
            )}
          </div>

          ${this._renderSectionScope(
            SECTION_SCOPE_IDS.energy_nodes.battery_forecast,
            html`
              <div class="field-grid">
                ${this._renderOptionalNumberField(
                  ["energy_nodes", "battery", "forecast", "charge_efficiency"],
                  "editor.fields.charge_efficiency",
                  undefined,
                  "editor.help.battery_charge_efficiency",
                )}
                ${this._renderOptionalNumberField(
                  ["energy_nodes", "battery", "forecast", "discharge_efficiency"],
                  "editor.fields.discharge_efficiency",
                  undefined,
                  "editor.help.battery_discharge_efficiency",
                )}
                ${this._renderOptionalNumberField(
                  ["energy_nodes", "battery", "forecast", "max_charge_power_w"],
                  "editor.fields.max_charge_power_w",
                  undefined,
                  "editor.help.battery_max_charge_power_w",
                )}
                ${this._renderOptionalNumberField(
                  ["energy_nodes", "battery", "forecast", "max_discharge_power_w"],
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
        SECTION_SCOPE_IDS.energy_nodes.grid,
        html`
          <div class="field-grid">
            ${this._renderPowerEntityGroup(
              "grid",
              "editor.fields.power_entity",
              "editor.help.grid_power_entity",
            )}
            ${this._renderOptionalNumberField(
              ["energy_nodes", "grid", "max_allowed_export_power"],
              "editor.fields.max_allowed_export_power",
              undefined,
              "editor.help.grid_max_allowed_export_power",
              { min: 0, suffix: "W" },
            )}
          </div>

          ${this._renderSectionScope(
            SECTION_SCOPE_IDS.energy_nodes.grid_forecast,
            html`
              <div class="field-grid">
                ${this._renderEntityGroup(
                  ["energy_nodes", "grid", "forecast", "sell_price_entity_id"],
                  "editor.fields.sell_price_entity",
                  {
                    includeDomains: ["sensor"],
                    helpKey: "editor.help.grid_sell_price_entity",
                  },
                )}
                ${this._renderOptionalTextField(
                  ["energy_nodes", "grid", "forecast", "import_price_unit"],
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
                    ["energy_nodes", "grid", "forecast", "import_price_windows"],
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
    const applianceDevices = this._applianceEnergyDepthDevices();
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
        { open: false, icon: TAB_ICONS.training },
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
                  sensorKind: "energy",
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
          ${this._renderInspectorCard("solar")}
        `,
        (open) => this._handleInspectorDiagnosticsToggle("solar", open),
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
        html`${this._renderInspectorCard("house")}`,
        (open) => this._handleInspectorDiagnosticsToggle("house", open),
      )}

      ${this._renderTrainingJobSection(
        "appliance_energy",
        "editor.notes.training_appliance_energy",
        nothing,
        applianceDevices.flatMap((device) => device.entities),
        nothing,
        undefined,
        () => this._renderApplianceEnergyTable(applianceDevices),
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
    renderDepthTable: (
      rows: TrainingDepthRow[],
    ) => TemplateResult | typeof nothing = (rows) => this._renderTrainingDepthTable(rows),
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
                ${renderDepthTable(depthRows)}
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
        open: false,
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
  private _handleInspectorDiagnosticsToggle(embed: InspectorEmbed, open: boolean): void {
    if (!open) return;
    if (!this._inspectorRequested[embed]) {
      this._inspectorRequested[embed] = true;
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
  private _renderInspectorCard(embed: InspectorEmbed): TemplateResult | typeof nothing {
    if (!this._inspectorRequested[embed]) return nothing;
    if (this._inspectorCardError) {
      return html`<div class="message error">${this._inspectorCardError}</div>`;
    }
    if (!customElements.get(INSPECTOR_CARD_TAG)) return nothing;
    let card = this._inspectorCard[embed];
    if (!card) {
      card = document.createElement(INSPECTOR_CARD_TAG) as SolarInspectorCardElement;
      card.setConfig(INSPECTOR_EMBED_CONFIGS[embed]);
      this._inspectorCard[embed] = card;
    }
    card.hass = this.hass;
    return html`${card}`;
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
   * The house meter, plus one row per carved meter.
   *
   * `devices.consumers.*.consumption.energy_entity_id` is the same path a device's
   * picker already reads elsewhere in the editor — this is a second, read-only
   * view of it, not a second control. Children are walked too: the AC breaker
   * is carved for the air conditioners behind it.
   */
  private _houseConsumptionDepthRows(): TrainingDepthRow[] {
    return [
      {
        label: this._t("editor.training_depth.house_meter"),
        path: ["energy_nodes", "house", "forecast", "total_energy_entity_id"],
        roleKey: "editor.training_depth.role_house_meter",
      },
      ...iterDevices(this._config).flatMap(({ device, parent, path }, index): TrainingDepthRow[] => {
        // The trainer's list, not the config's: `read_carved_meters` keeps
        // only a meter whose demand is all schedulable, so a row for any
        // other would claim the house window governs a meter it never reads.
        // A carved meter's metered children are read too: its own energy is
        // the meter minus theirs.
        const read =
          isCarvedMeterOwner(device) ||
          (parent !== null && isCarvedMeterOwner(parent) && ownMeter(device) !== "");
        if (!read) return [];
        const name =
          this._stringValue(device.name) ||
          this._stringValue(device.id) ||
          `${this._t("editor.training_depth.controllable_fallback_name")} ${index + 1}`;
        return [
          {
            label: name,
            path: [...path, "consumption", "energy_entity_id"],
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
        path: ["energy_nodes", "solar", "forecast", "daily_energy_entity_ids", 0],
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
        path: ["energy_nodes", "grid", "entities", "power"],
        roleKey: "editor.training_depth.role_grid_power",
      },
      {
        label: this._t("editor.training_depth.battery_soc"),
        path: ["energy_nodes", "battery", "entities", "capacity"],
        roleKey: "editor.training_depth.role_battery_soc",
      },
    ];
  }

  /**
   * Every device the appliance energy job reads, with the lookback it reads.
   *
   * Every consumer device learns its usage record: its meter, its power
   * sensor and its switch or climate entity -- the last is how training knows
   * when it ran, so a deep meter over a shallow switch still yields no
   * `history_average` estimate. A meterless child reads its parent's meter,
   * and that meter is read once for all of the parent's meterless children,
   * over the longest lookback among those that learn, else 30 days; every one
   * of them divides it. Any other device reads 30 days unless it learns on
   * its own lookback. Mirrors `ApplianceEnergyTrainingRequest` and
   * `read_shared_meters`.
   *
   * A second, read-only view of settings that live on each device -- the same
   * kind of view `_houseConsumptionDepthRows` gives those meters.
   */
  private _applianceEnergyDepthDevices(): ApplianceEnergyDepthDevice[] {
    const items = iterDevices(this._config).map(({ device, parent, path }, index) => {
      const consumption = asJsonObject(device.consumption) ?? {};
      const controls = asJsonObject(device.controls) ?? {};
      const projection = asJsonObject(consumption.projection) ?? {};
      const kind = deviceKind(device);
      const lookback = projection.lookback_days;
      const drawsFromParent = parent !== null && !ownMeter(device);
      return {
        index,
        id: this._stringValue(device.id),
        name:
          this._stringValue(device.name) ||
          this._stringValue(device.id) ||
          `${this._t("editor.training_depth.controllable_fallback_name")} ${index + 1}`,
        path,
        parent: drawsFromParent ? parent : null,
        // Nothing to learn from without one, as the backend skips it.
        hasMeter: Boolean(drawsFromParent ? parent && ownMeter(parent) : ownMeter(device)),
        // Its effective meter: a meterless child reads its parent's.
        meterPath: [
          ...(drawsFromParent ? path.slice(0, -2) : path),
          "consumption",
          "energy_entity_id",
        ],
        // The parent's own energy is its meter minus these, so training reads
        // their history as well before splitting what is left.
        submeterPaths: drawsFromParent
          ? (asJsonArray(parent?.children) ?? []).flatMap((sibling, siblingIndex) => {
              const siblingDevice = asJsonObject(sibling);
              return siblingDevice && ownMeter(siblingDevice)
                ? [[...path.slice(0, -1), siblingIndex, "consumption", "energy_entity_id"]]
                : [];
            })
          : [],
        device,
        // Its own power sensor: how its runs are found. A meterless child
        // has none; its runs are its share of the meter.
        powerPath:
          !drawsFromParent && this._stringValue(consumption.power_entity_id)
            ? [...path, "consumption", "power_entity_id"]
            : null,
        // The control whose history tells when it ran: the same running signal
        // the backend reads (`running_signal`), first configured of these.
        activity:
          (kind === "ev_charger" ? ["switch", "charge", "climate"] : ["switch", "climate"]).find(
            (key) => this._stringValue(asJsonObject(controls[key])?.entity_id),
          ) ?? null,
        learns: isSchedulable(device) && projection.strategy === "history_average",
        // The backend trains on 30 days when the key is absent.
        lookback: typeof lookback === "number" ? lookback : 30,
      };
    });
    const sharedLookback = (parent: JsonObject | null): number | null => {
      if (!parent) return null;
      const learners = items.filter((item) => item.parent === parent && item.learns);
      if (learners.length === 0) return null;
      return Math.max(...learners.map((member) => member.lookback));
    };
    return items.flatMap((item): ApplianceEnergyDepthDevice[] => {
      // The backend trains only a device with a meter, and a meterless child
      // only as a member of its parent's split: with an id and a running signal.
      if (!item.hasMeter || (item.parent && (!item.id || !item.activity))) return [];
      const days = item.parent
        ? (sharedLookback(item.parent) ?? 30)
        : item.learns
          ? item.lookback
          : 30;
      const entity = (label: string, path: PathSegment[]): TrainingDepthRow => ({
        label: this._t(`editor.training_depth.appliance_entity_${label}`),
        path,
        requiredDays: days,
      });
      const activity = item.activity
        ? [entity(item.activity, [...item.path, "controls", item.activity, "entity_id"])]
        : [];
      return [
        {
          index: item.index,
          id: item.id,
          name: item.name,
          device: item.device,
          learns: item.learns,
          lookbackDays: days,
          entities: [
            entity("meter", item.meterPath),
            ...item.submeterPaths.map((submeterPath) => entity("submeter", submeterPath)),
            ...(item.powerPath ? [entity("power", item.powerPath)] : []),
            ...activity,
          ],
        },
      ];
    });
  }

  /**
   * What the appliance energy job learned for one device, or why not.
   *
   * The one reader of the job's `estimates`, its appliance issues and its
   * device records, shared by the Diagnostics table and the device's own
   * settings so the two cannot disagree.
   *
   * The record is looked up by the card's deviceKey (its own meter, else its
   * id) for every device, learners included. `configured` is the
   * `hourly_energy_kwh` the forecast projects with: a schedulable device's on
   * `fixed`, or on `history_average` until it has an adopted estimate. The
   * note is the job's failure for it, else "not trained yet" without a record.
   */
  private _deviceEnergyEstimate(device: JsonObject): DeviceEnergyInput {
    const job = this._trainingJob("appliance_energy");
    const id = this._stringValue(device.id);
    const recordKey = this._deviceKey(device);
    const projection = asJsonObject(asJsonObject(device.consumption)?.projection);
    const hourly = projection?.hourly_energy_kwh;
    // An EV charger is scheduled but never projected, so it headlines its
    // power while active like any device the scheduler does not project.
    const projects = isSchedulable(device) && deviceKind(device) !== "ev_charger";
    const estimate = job?.estimates?.[id];
    const adopted = projection?.strategy === "history_average" && typeof estimate === "number";
    // The adopted estimate is what the forecast projects with. It normally
    // equals the record's figure, but survives a meter change before the
    // refit files a record under the new key, so it wins over the record.
    const stored = job?.devices?.[recordKey];
    const record = adopted ? { ...stored, on_kwh_per_hour: estimate } : stored;
    const issue = job?.issues.find(
      (candidate) => candidate.subject === id || candidate.subject === recordKey,
    );
    return {
      record,
      schedulable: projects,
      configured:
        projects && !adopted && typeof hourly === "number" && Number.isFinite(hourly)
          ? hourly
          : undefined,
      note: issue
        ? this._tFormat("device_energy.failed", { reason: issue.reason })
        : stored || adopted
          ? undefined
          : this._t("device_energy.not_trained"),
    };
  }

  /**
   * Every target the training tab's depth tables need, for the shared poll.
   *
   * Computed only while the training tab is active: the tables render
   * nothing otherwise, and asking about entities nobody can see would be a
   * poll that never pays for itself. The inspection collector merges this
   * list with the mounted `helman-entity-group` paths and de-duplicates by
   * key, so this is not a second call and not a second cache.
   */
  private _trainingDepthTargets(): {
    key: string;
    path: PathSegment[];
    always: boolean;
  }[] {
    if (this._activeTab !== "training") return [];
    const rows = [
      ...this._houseConsumptionDepthRows(),
      ...this._solarBiasDepthRows(),
      ...this._applianceEnergyDepthDevices().flatMap((device) => device.entities),
    ];
    return rows.map((row) => ({
      key: entityGroupKey(row.path),
      path: row.path,
      // Helman's own entity exists whatever the draft says, and so does one a
      // hardware profile fills in: the backend reads the path through it.
      always: row.ownEntity === true || this._vendorProvision(row.path) !== null,
    }));
  }

  /**
   * One depth table: what the trainer reads, and how much of it there is.
   *
   * Deliberately *not* here: the configured window and minimum. Both are the
   * same for every row -- they are this section's own settings, edited in the
   * fields directly above -- so a column of them repeated down the table said
   * nothing a reader could not already see. The appliance-energy table is the
   * exception, with a table of its own: see `_renderApplianceEnergyTable`.
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
    const draft = this._inspections.results[entityGroupKey(row.path)]?.draft ?? null;
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
    const { historyFact } = this._trainingDepthInspection(row);
    const rawStates = historyFact?.params?.["raw_states"];
    const statistics = historyFact?.params?.["statistics"];
    return html`
      <tr class=${this._isTrainingDepthRowShort(row) ? "training-depth-warn" : ""}>
        <td>
          ${this._renderTrainingDepthEntity(
            row,
            html`<div class="training-depth-label">${row.label}</div>`,
          )}
        </td>
        <td class="training-depth-role">${row.roleKey ? this._t(row.roleKey) : nothing}</td>
        <td class="training-depth-number">${this._trainingDepthCell(rawStates)}</td>
        <td class="training-depth-number">${this._trainingDepthCell(statistics)}</td>
      </tr>
    `;
  }

  /**
   * A depth row's entity id under `heading`, as one more-info button.
   *
   * The config document first, then whatever the backend resolved. For every
   * row but one those are the same string. The exception is a row for an
   * entity Helman publishes: its path names nothing in the document, so only
   * the inspection knows the id, and without this the row renders as "no
   * entity configured" and is not clickable — while reporting a depth.
   */
  private _renderTrainingDepthEntity(
    row: TrainingDepthRow,
    heading: TemplateResult | typeof nothing,
  ): TemplateResult {
    const entityId =
      this._stringValue(this._getValue(row.path)) ||
      this._stringValue(this._trainingDepthInspection(row).draft?.entityId);
    return entityId
      ? html`<button
          type="button"
          class="training-depth-entity-button"
          aria-label=${this._moreInfoLabel(entityId)}
          title=${entityId}
          @click=${() => this._showMoreInfo(entityId)}
        >
          ${heading}
          <div class="training-depth-entity-id">${entityId}</div>
        </button>`
      : html`${heading}
          <div class="training-depth-entity-id training-depth-unset">
            ${this._t("editor.training_depth.no_entity")}
          </div>`;
  }

  /**
   * The appliance energy table: one row per device, with what it learned.
   *
   * A device's meter and activity entity are listed inside its one row, not
   * as sibling rows, because the job trains the device -- two rows read as
   * two trainings. Depth is the effective one (`available`, #186) per entity:
   * the only question for an appliance is whether each entity reaches back as
   * far as the lookback, so the raw-states / statistics split stays in the
   * solar and house tables. The row warns when any of its entities is short.
   */
  private _renderApplianceEnergyTable(
    devices: ApplianceEnergyDepthDevice[],
  ): TemplateResult | typeof nothing {
    if (devices.length === 0) return nothing;
    if (!this._deviceTreeRequested) {
      this._deviceTreeRequested = true;
      void this._loadDeviceTree();
    }
    return html`
      <div class="training-depth-table-wrap">
        <table class="training-depth-table">
          <thead>
            <tr>
              <th>${this._t("editor.training_depth.column_device")}</th>
              <th>${this._t("device_energy.label")}</th>
              <th class="training-depth-number">
                ${this._t("editor.training_depth.column_lookback")}
              </th>
              <th class="training-depth-number">
                ${this._t("editor.training_depth.column_history_depth")}
              </th>
            </tr>
          </thead>
          <tbody>
            ${devices.map((device) => this._renderApplianceEnergyRow(device))}
          </tbody>
        </table>
      </div>
      <p class="inline-note">${this._t("editor.training_depth.appliance_table_note")}</p>
    `;
  }

  private _renderApplianceEnergyRow(device: ApplianceEnergyDepthDevice): TemplateResult {
    const depths = device.entities.map(
      (row) => this._trainingDepthInspection(row).historyFact?.params?.["available"],
    );
    const known = depths.every((depth) => typeof depth === "number");
    const short = device.entities.some((row) => this._isTrainingDepthRowShort(row));
    const label = html`<div class="training-depth-label">${device.name}</div>`;
    // Clickable only when the saved tree holds the device: an unsaved one, or
    // a tree that never loaded, has no detail to open.
    const item = this._savedDeviceUnchanged(device.device)
      ? this._deviceTreeItems?.get(this._deviceTreeKey(device.device))
      : undefined;
    return html`
      <tr class=${short ? "training-depth-warn" : ""}>
        <td>
          ${item
            ? html`<button
                type="button"
                class="training-depth-entity-button"
                aria-label=${this._tFormat("editor.training_depth.device_detail_aria", {
                  device: device.name,
                })}
                @click=${() => void this._showDeviceDetail(item)}
              >
                ${label}
              </button>`
            : label}
          ${device.entities.map((row) => this._renderTrainingDepthEntity(row, nothing))}
        </td>
        <td class="training-depth-role">${this._renderApplianceEnergyValue(device)}</td>
        <td class="training-depth-number">
          ${this._tFormat("editor.training_depth.days", { days: device.lookbackDays })}
        </td>
        <td class="training-depth-number">
          <div>${known ? this._trainingDepthDays(Math.min(...(depths as number[]))) : "—"}</div>
          ${device.entities.map(
            (row, index) => html`<div class="training-depth-entity-id">
              ${row.label} ${this._trainingDepthDays(depths[index])}
            </div>`,
          )}
        </td>
      </tr>
    `;
  }

  /**
   * A device's key in the training records: its own meter, else its id --
   * also the hydrator's deviceKey, which `_deviceTreeKey` qualifies.
   */
  private _deviceKey(device: JsonObject): string {
    return ownMeter(device) || this._stringValue(device.id);
  }

  /**
   * The tree's key for a device: its deviceKey qualified by which kind it is,
   * since a meter and a device id are each unique only among their own kind.
   */
  private _deviceTreeKey(device: JsonObject): string {
    return `${ownMeter(device) ? "meter" : "id"}:${this._deviceKey(device)}`;
  }

  private _treeItemKey(item: TreeItem): string {
    return `${item.deviceKeyIsMeter ? "meter" : "id"}:${item.deviceKey}`;
  }

  /**
   * Whether the saved config holds this draft device as it is: same key, id
   * and name. The tree is the saved one, so a draft that swapped meters or
   * reused a removed device's key must not open what the saved key names.
   */
  private _savedDeviceUnchanged(device: JsonObject): boolean {
    const key = this._deviceTreeKey(device);
    const id = this._stringValue(device.id);
    const name = this._stringValue(device.name);
    return iterDevices(this._savedConfig ?? {}).some(
      ({ device: saved }) =>
        this._deviceTreeKey(saved) === key &&
        this._stringValue(saved.id) === id &&
        this._stringValue(saved.name) === name,
    );
  }

  /**
   * Fetch the saved device tree and index it by `_deviceTreeKey`.
   *
   * The same command and hydration helman-card builds its items from, so the
   * dialog shows what the card would. Skipped without a card URL, since the
   * dialog could not be loaded anyway; a failed fetch leaves the names plain.
   */
  private async _loadDeviceTree(): Promise<void> {
    if (!this.hass || !this._cardLocalize || !this.panel?.config?.card_module_url) {
      // Not ready yet: let the table's next render ask again.
      this._deviceTreeRequested = false;
      return;
    }
    const sequence = ++this._deviceTreeSequence;
    try {
      const payload = await new HelmanClient(this.hass as unknown as HomeAssistant).getDeviceTree();
      // A later fetch has been asked for; its tree is the newer one.
      if (sequence !== this._deviceTreeSequence) return;
      const items = new Map<string, TreeItem>();
      const walk = (item: TreeItem): void => {
        if (item.deviceKey) items.set(this._treeItemKey(item), item);
        item.children.forEach(walk);
      };
      for (const dto of [...payload.sources, ...payload.consumers]) {
        walk(hydrateItem(dto, payload.uiConfig.history_buckets, this._cardLocalize));
      }
      this._deviceTreeItems = items;
      // An open detail follows the re-read tree, so a rename or re-wiring
      // saved meanwhile shows; a device that is gone closes it.
      if (this._deviceDetail) {
        this._deviceDetail = items.get(this._treeItemKey(this._deviceDetail)) ?? null;
      }
    } catch (error) {
      console.error("Helman: failed to load the device tree", error);
      if (sequence !== this._deviceTreeSequence) return;
      // The previous tree may no longer match the saved config, so no name
      // opens it; the table's next render asks again.
      this._deviceTreeItems = null;
      this._deviceTreeRequested = false;
    }
  }

  /** Open the card's device detail for `item`, loading the card artifact first. */
  private async _showDeviceDetail(item: TreeItem): Promise<void> {
    const url = this.panel?.config?.card_module_url;
    if (!url) return;
    try {
      this._deviceDetailLoad ??= nodeDetailDialogLoader(url);
      await this._deviceDetailLoad();
    } catch (error) {
      // Both halves, as for the inspector: the import error names only a URL.
      this._message = {
        kind: "error",
        text: [this._t("editor.messages.load_device_detail_failed"), this._formatError(error, "")]
          .filter(Boolean)
          .join(" "),
      };
      return;
    }
    this._deviceDetail = item;
  }

  /** The Energy cell, read from `_deviceEnergyEstimate`. */
  private _renderApplianceEnergyValue(device: ApplianceEnergyDepthDevice): TemplateResult {
    return renderDeviceEnergyValue(
      (key) => this._t(`device_energy.${key}`),
      this._deviceEnergyEstimate(device.device),
    );
  }

  /** A depth in days, or a dash while it is unknown. */
  private _trainingDepthDays(value: unknown): string {
    return typeof value === "number" && Number.isFinite(value)
      ? this._tFormat("editor.training_depth.days", { days: value })
      : "—";
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
    return trainingDepthCell(value);
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
        { initialOpen: false },
      )}

      ${this._renderOptimizerBucketSection("system_optimizers")}
      ${this._renderOptimizerBucketSection("appliance_optimizers")}
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
        { initialOpen: false },
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

  /**
   * The Devices tab: the settings every device shares, the groupings, then
   * the `devices.consumers` tree as nested cards. Every section starts collapsed, so the tab reads as an
   * overview first.
   *
   * A consumer card renders its `children` with the same card, recursively.
   * The filter hides cards rather than dropping them, which keeps the sortable
   * list's indices equal to the document's.
   */
  private _renderDevicesTab(): TemplateResult {
    const consumers = asJsonArray(this._getValue(["devices", "consumers"])) ?? [];
    return html`
      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.devices.settings,
        html`
          <div class="field-grid">
            ${this._renderOptionalTextField(
              ["devices", "name_cleaner_regex"],
              "editor.fields.power_sensor_name_cleaner_regex",
              "editor.helpers.power_sensor_name_cleaner_regex",
              "editor.help.power_sensor_name_cleaner_regex",
            )}
            ${this._renderOptionalTextField(
              ["devices", "power_sensor_label"],
              "editor.fields.power_sensor_label",
            )}
            ${this._renderOptionalTextField(
              ["devices", "power_switch_label"],
              "editor.fields.power_switch_label",
            )}
          </div>
        `,
        { initialOpen: false },
      )}

      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.devices.groupings,
        html`
          <p class="inline-note">${this._t("editor.notes.device_groupings")}</p>
          ${this._renderGroupings()}
          <div class="section-footer">
            <button type="button" class="add-button add-grouping" @click=${this._handleAddGrouping}>
              ${this._t("editor.actions.add_grouping")}
            </button>
          </div>
        `,
        { initialOpen: false },
      )}

      ${this._renderSectionScope(
        SECTION_SCOPE_IDS.devices.consumers,
        html`
          <p class="inline-note">${this._t("editor.notes.devices")}</p>
          ${consumers.length > 0
            ? html`${this._renderDeviceFilter()}${this._renderDeviceList(["devices", "consumers"], null)}`
            : html`<div class="message info devices-empty">${this._t("editor.empty.no_devices")}</div>`}
          ${this._renderAddDevice(
            ["devices", "consumers"],
            null,
            html`<button
              class="add-button import-energy"
              type="button"
              ?disabled=${this._importLoading}
              @click=${() => this._previewEnergyImport()}
            >
              ${this._t("editor.actions.import_energy")}
            </button>`,
          )}
          ${this._deviceActionMessage ? html`<div class="message error">${this._deviceActionMessage}</div>` : nothing}
          ${this._renderEnergyImport()}
        `,
        { initialOpen: false },
      )}
    `;
  }

  private async _previewEnergyImport(): Promise<void> {
    if (!this.hass || !this._config) return;
    const draft = this._config;
    const hass = this.hass;
    const request = ++this._energyImportRequest;
    this._energyImport = null;
    this._deviceActionMessage = "";
    // The backend reads a devices value that is not an object as no devices,
    // so an import onto an old-shape list would replace it with the import.
    if (draft.devices != null && !asJsonObject(draft.devices)) {
      this._deviceActionMessage = this._t("editor.messages.import_energy_invalid_devices");
      return;
    }
    this._importLoading = true;
    try {
      const preview = await fetchEnergyImportPreview(hass, draft);
      if (this._config === draft && request === this._energyImportRequest)
        this._energyImport = { preview, draft };
    } catch (error) {
      if (this._config === draft && request === this._energyImportRequest)
        this._deviceActionMessage = this._formatError(error, this._t("editor.messages.import_energy_failed"));
    } finally {
      if (request === this._energyImportRequest) this._importLoading = false;
    }
  }

  private _renderEnergyImport(): TemplateResult | typeof nothing {
    if (!this._energyImport || this._energyImport.draft !== this._config)
      return nothing;
    const { preview } = this._energyImport;
    const hasChanges =
      preview.additions.length +
      preview.powerEntities.length +
      preview.nestingChanges.length > 0;
    return html`<div class="list-card energy-import-preview">
      <strong>${this._t("editor.import.preview")}</strong>
      <p>${this._t("editor.import.draft_only")}</p>
      <ul>
        ${preview.additions.map((item) => html`<li>${this._t("editor.import.add")}: ${item.deviceId} — ${item.energyEntityId}${item.powerEntityId ? html`, ${item.powerEntityId}` : nothing}${item.parentId ? html` → ${item.parentId}` : nothing}</li>`)}
        ${preview.powerEntities.map((item) => html`<li>${this._t("editor.import.power")}: ${item.deviceId} → ${item.entityId}</li>`)}
        ${preview.nestingChanges.map((item) => html`<li>${this._t("editor.import.move")}: ${item.deviceId} → ${item.parentId}</li>`)}
        ${preview.skippedRows.map((item) => html`<li>${this._t("editor.import.skipped")}: ${item.energy_entity_id} — ${this._tFormat(`editor.import.skip_reasons.${item.reason}`, { device: item.device_id ?? "" })}</li>`)}
        ${preview.warnings.map((item) => html`<li class="message info">${this._tFormat(`editor.import.warnings.${item.reason}`, { meter: item.energy_entity_id, device: item.device_id ?? "" })}</li>`)}
        ${preview.validation.errors.length ? html`<li>${this._t("editor.import.blocked")}</li>` : nothing}
        ${preview.validation.errors.map((item) => html`<li class="message error">${item.path}: ${item.message}</li>`)}
      </ul>
      ${!hasChanges ? html`<p>${this._t("editor.import.no_changes")}</p>` : nothing}
      <div class="inline-actions">
      <button
        class="add-button primary apply-energy-import"
        type="button"
        ?disabled=${!preview.validation.valid || !hasChanges}
        @click=${() => {
          if (
            !this._energyImport ||
            this._energyImport.draft !== this._config ||
            !preview.validation.valid ||
            !hasChanges
          )
            return;
          // Moves shift device paths, which key the YAML mode state.
          this._resetDeviceModes();
          this._applyMutation((draft) => {
            draft.devices = { ...(asJsonObject(draft.devices) ?? {}), consumers: cloneJson(preview.devices) };
          });
          this._energyImport = null;
        }}
      >
        ${this._t("editor.actions.apply")}
      </button>
      <button
        class="add-button cancel-energy-import"
        type="button"
        @click=${() => {
          this._energyImport = null;
        }}
      >
        ${this._t("editor.actions.cancel")}
      </button>
      </div>
    </div>`;
  }

  private _renderDeviceFilter(): TemplateResult {
    return html`
      <div
        class="mode-toggle device-filter"
        role="group"
        aria-label=${this._t("editor.device_filter.label")}
      >
        ${DEVICE_FILTERS.map(
          (filter) => html`
            <button
              type="button"
              class=${this._deviceFilter === filter ? "active" : ""}
              aria-pressed=${this._deviceFilter === filter}
              @click=${() => {
                this._deviceFilter = filter;
              }}
            >
              ${this._t(`editor.device_filter.${filter}`)}
            </button>
          `,
        )}
      </div>
    `;
  }

  /** Whether the filter shows this device: it matches, or something under it does. */
  private _deviceMatchesFilter(device: JsonObject): boolean {
    if (this._deviceFilter === "all") return true;
    return (
      isSchedulable(device) === (this._deviceFilter === "schedulable") ||
      deviceChildren(device).some((child) => this._deviceMatchesFilter(child))
    );
  }

  private _renderDeviceList(listPath: PathSegment[], parent: JsonObject | null): TemplateResult {
    return renderSortableList({
      items: asJsonArray(this._getValue(listPath)) ?? [],
      containerClass: "list-stack",
      renderItem: (value, index) =>
        this._renderDeviceItem(asJsonObject(value) ?? {}, [...listPath, index], parent),
      onMove: (oldIndex, newIndex) => this._moveDevice(listPath, oldIndex, newIndex),
    });
  }

  private _renderDeviceItem(
    device: JsonObject,
    path: PathSegment[],
    parent: JsonObject | null,
  ): TemplateResult {
    const kind = deviceKind(device);
    if (!(EDITABLE_DEVICE_KINDS as readonly string[]).includes(kind)) {
      return this._renderUnsupportedDevice(device, path);
    }
    return this._renderDeviceCard(device, path, parent);
  }

  /**
   * "Add device": pick one entity, and the device is created from it.
   *
   * At the top level the entity is the new device's energy meter. Under a
   * parent it is either the child's own meter (a sensor) or, for a child that
   * draws from the parent's meter, the switch or climate entity that tells when
   * it runs. The `id` is generated from the entity once and never edited.
   */
  private _renderAddDevice(
    listPath: PathSegment[],
    parent: JsonObject | null,
    /** Another list action shown beside "Add device". */
    sibling: TemplateResult | typeof nothing = nothing,
  ): TemplateResult {
    const key = entityGroupKey(listPath);
    const child = parent !== null;
    if (this._addDeviceTarget !== key) {
      return html`
        <div class="section-footer inline-actions">
          <button
            type="button"
            class="add-button primary add-device"
            @click=${() => {
              this._addDeviceTarget = key;
            }}
          >
            ${this._t(child ? "editor.actions.add_child_device" : "editor.actions.add_device")}
          </button>
          ${sibling}
        </div>
      `;
    }
    return html`
      <div class="field add-device-picker">
        <label>
          ${this._t(child ? "editor.fields.add_child_device_entity" : "editor.fields.add_device_entity")}
        </label>
        <ha-entity-picker
          .hass=${this.hass}
          .includeDomains=${child ? ["sensor", ...SWITCH_CONTROL_DOMAINS, "climate"] : ["sensor"]}
          .entityFilter=${SENSOR_KIND_FILTERS.energy}
          @value-changed=${(event: CustomEvent<{ value?: string }>) =>
            this._addDevice(listPath, parent, event.detail?.value ?? "")}
        ></ha-entity-picker>
        <div class="helper">
          ${this._t(child ? "editor.helpers.add_child_device" : "editor.helpers.add_device")}
        </div>
        <div class="section-footer">
          <button
            type="button"
            class="add-button"
            @click=${() => {
              this._addDeviceTarget = null;
            }}
          >
            ${this._t("editor.actions.cancel")}
          </button>
        </div>
      </div>
    `;
  }

  private _addDevice(listPath: PathSegment[], parent: JsonObject | null, rawEntityId: string): void {
    const entityId = rawEntityId.trim();
    if (!entityId) return;
    const domain = entityId.split(".")[0];
    const meterlessIds = parent !== null && domain !== "sensor"
      ? iterDevices(this._config)
          .filter((entry) => entry.parent !== null && !ownMeter(entry.device))
          .map((entry) => this._stringValue(entry.device.id))
      : [];
    const id = deviceIdFor(entityId, [CONTROLLABLE_ID_INVERTER, ...this._deviceIds()], meterlessIds);
    let device: JsonObject;
    if (domain === "sensor" || parent === null) {
      device = { id, consumption: { energy_entity_id: entityId } };
    } else {
      device =
        domain === "climate"
          ? { id, kind: "climate", controls: { climate: { entity_id: entityId } } }
          : { id, controls: { switch: { entity_id: entityId } } };
      // Meterless siblings are all schedulable or all passive.
      if (meterlessChildren(parent).some((sibling) => isSchedulable(sibling))) {
        device.schedulable = true;
        device.consumption = { projection: { ...SEEDED_PROJECTION } };
      }
    }
    this._addDeviceTarget = null;
    this._applyMutation((draft) => {
      appendListItem(draft, listPath, device);
    });
  }

  /**
   * `devices.groupings`: one card per grouping, its groups as sortable rows.
   *
   * Ids are slugged from the name when the entry is added and editable after:
   * a typed id is slugged on commit, and every device reference to the old id
   * is rewritten in the same mutation. A rename touches the name only.
   */
  private _renderGroupings(): TemplateResult {
    const groupings = asJsonArray(this._getValue(["devices", "groupings"])) ?? [];
    if (groupings.length === 0) {
      return html`<div class="message info">${this._t("editor.empty.no_device_groupings")}</div>`;
    }
    return html`
      <div class="list-stack">
        ${groupings.map((value, index) => {
          const grouping = asJsonObject(value) ?? {};
          // ha-sortable reads its drag group only when created: a card reused for
          // another grouping would keep the old one, so each grouping keeps its own.
          return keyed(this._stringValue(grouping.id), this._renderGrouping(grouping, index));
        })}
      </div>
    `;
  }

  private _renderGrouping(grouping: JsonObject, index: number): TemplateResult {
    const path: PathSegment[] = ["devices", "groupings", index];
    const groups = asJsonArray(grouping.groups) ?? [];
    const groupingId = this._stringValue(grouping.id);
    const members = consumerGroups(this._config, groupingId);
    const groupIds = new Set(groups.map((group) => this._stringValue(asJsonObject(group)?.id)));
    const nameLabel = this._t("editor.fields.grouping_name");
    const idLabel = this._t("editor.fields.grouping_id");
    return html`
      <details class="list-card grouping-card" data-grouping-id=${groupingId}>
        <summary>
          <div class="appliance-summary-row">
            <div class="appliance-summary-left">
              ${this._renderSvgIcon(GROUPING_CHEVRON_PATH, "appliance-chevron")}
              <div class="card-title">
                <strong>${this._stringValue(grouping.name)}</strong>
                <span class="card-subtitle">${this._t("editor.card.grouping")}</span>
              </div>
            </div>
            <div class="list-actions" @click=${this._preventSummaryToggle}>
              ${renderRemoveButton(this, {
                className: "remove-grouping",
                onRemove: () => this._handleRemoveGrouping(index),
                label: this._t("editor.actions.remove_grouping"),
              })}
            </div>
          </div>
        </summary>
        <div class="grouping-name">
          <input
            class="grouping-name-input"
            .value=${this._stringValue(grouping.name)}
            title=${nameLabel}
            aria-label=${nameLabel}
            @change=${(event: Event) =>
              this._setRequiredString([...path, "name"], (event.currentTarget as HTMLInputElement).value)}
          />
          <input
            class="grouping-id-input"
            .value=${groupingId}
            title=${idLabel}
            aria-label=${idLabel}
            @change=${(event: Event) =>
              this._handleRenameGrouping(index, event.currentTarget as HTMLInputElement)}
          />
        </div>
        ${groups.length > 0
          ? html`
              <div class="group-rows">
                <div class="group-row group-row-head">
                  <span class="group-row-handle-spacer"></span>
                  <label class="group-name-cell">${this._t("editor.fields.group_name")}</label>
                  <label class="group-id-cell">${this._t("editor.fields.group_id")}</label>
                  <label class="group-short-name-cell">${this._t("editor.fields.group_short_name")}</label>
                  <span class="group-row-actions-spacer"></span>
                </div>
                ${renderSortableList({
                  items: groups,
                  containerClass: "group-rows-list",
                  renderItem: (group, groupIndex) =>
                    this._renderGroupRow(asJsonObject(group) ?? {}, index, groupIndex, groupingId, members),
                  onMove: (oldIndex, newIndex) => this._moveListItem([...path, "groups"], oldIndex, newIndex),
                })}
              </div>
            `
          : nothing}
        <div class="group-unassigned">
          <strong>${this._t("editor.device_groups.unassigned")}</strong>
          ${this._renderGroupMembers(
            groupingId,
            null,
            // An id the grouping does not have fails validation; until it is
            // fixed the device shows here rather than nowhere.
            members.filter((entry) => entry.group === null || !groupIds.has(entry.group)),
          )}
        </div>
        <div class="section-footer">
          <button type="button" class="add-button add-group" @click=${() => this._handleAddGroup(index)}>
            ${this._t("editor.actions.add_group")}
          </button>
        </div>
      </details>
    `;
  }

  private _renderGroupRow(
    group: JsonObject,
    groupingIndex: number,
    groupIndex: number,
    groupingId: string,
    members: GroupedDeviceEntry[],
  ): TemplateResult {
    const path: PathSegment[] = ["devices", "groupings", groupingIndex, "groups", groupIndex];
    const groupId = this._stringValue(group.id);
    const nameLabel = this._t("editor.fields.group_name");
    const idLabel = this._t("editor.fields.group_id");
    const shortNameLabel = this._t("editor.fields.group_short_name");
    return html`
      <div class="group-row">
        ${renderDragHandle(this)}
        <div class="field field-compact group-name-cell">
          <input
            class="group-name-input"
            .value=${this._stringValue(group.name)}
            aria-label=${nameLabel}
            @change=${(event: Event) =>
              this._setRequiredString([...path, "name"], (event.currentTarget as HTMLInputElement).value)}
          />
        </div>
        <div class="field field-compact group-id-cell">
          <input
            class="group-id-input"
            .value=${groupId}
            aria-label=${idLabel}
            @change=${(event: Event) =>
              this._handleRenameGroup(groupingIndex, groupIndex, event.currentTarget as HTMLInputElement)}
          />
        </div>
        <div class="field field-compact group-short-name-cell">
          <input
            class="group-short-name-input"
            .value=${this._stringValue(group.short_name)}
            aria-label=${shortNameLabel}
            @change=${(event: Event) =>
              this._setRequiredString([...path, "short_name"], (event.currentTarget as HTMLInputElement).value)}
          />
        </div>
        <div class="list-actions">
          ${renderRemoveButton(this, {
            className: "remove-group",
            onRemove: () => this._handleRemoveGroup(groupingIndex, groupIndex),
          })}
        </div>
        ${this._renderGroupMembers(
          groupingId,
          groupId,
          members.filter((entry) => entry.group === groupId),
        )}
      </div>
    `;
  }

  /**
   * One group's devices, or "Unassigned"'s (`groupId` null), as chips dragged
   * between the lists of one grouping. Their order is the tree's: it is not
   * stored, so the list does not sort.
   *
   * A drop is applied from the target's item-added; ha-sortable's rollback
   * first puts the dragged chip back where it came from, so the DOM is Lit's again before it redraws from the document.
   * The events are stopped here because they bubble, and the group rows'
   * own list would take an item-moved for a reorder of the groups.
   */
  private _renderGroupMembers(
    groupingId: string,
    groupId: string | null,
    members: GroupedDeviceEntry[],
  ): TemplateResult {
    return html`
      <ha-sortable
        group=${"helman-grouping-" + groupingId}
        draggable-selector=".member-chip.draggable"
        .options=${MEMBER_SORTABLE_OPTIONS}
        @item-added=${(event: Event) => {
          event.stopPropagation();
          const devicePath = (event as CustomEvent<{ data?: unknown }>).detail?.data;
          if (!Array.isArray(devicePath)) return;
          this._applyMutation((draft) => assignGroup(draft, devicePath, groupingId, groupId));
        }}
        @item-moved=${stopEvent}
        @item-removed=${stopEvent}
      >
        <div class="group-members" data-group-id=${groupId ?? ""}>
          ${repeat(
            members,
            (entry) => entry.path.join("."),
            (entry) => this._renderMemberChip(entry),
          )}
        </div>
      </ha-sortable>
    `;
  }

  /** A device in a group: its name and, for a child, its parent's. */
  private _renderMemberChip(entry: GroupedDeviceEntry): TemplateResult {
    const { device, parent, path } = entry;
    return html`
      <div class="member-chip draggable" data-device-id=${this._stringValue(device.id)} .sortableData=${path}>
        ${this._renderSvgIcon(mdiDragVertical, "member-chip-glyph")}
        <span class="member-name">${deviceName(this, this._inspections.results, device, path)}</span>
        ${parent
          ? html`<span class="member-parent">${deviceName(this, this._inspections.results, parent, path.slice(0, -2))}</span>`
          : nothing}
      </div>
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
      "energy_nodes",
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
                  ["energy_nodes", "solar", "forecast", "daily_energy_entity_ids"],
                  index,
                ),
            })}
          </div>
        </div>
        ${this._renderEntityGroup(path, "editor.fields.entity_id", {
          includeDomains: ["sensor"],
          sensorKind: "energy",
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
      "energy_nodes",
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
                  ["energy_nodes", "grid", "forecast", "import_price_windows"],
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

  /**
   * `energy_nodes.inverter`, laid out straight in its section: the hardware
   * profile, the controls and the action options. Always shown, like House or
   * Battery: an inverter with nothing set is simply not configured. First on the tab, because its hardware profile fills the nodes
   * below. No projection section: the inverter has no demand of its own. The
   * section's own YAML mode edits the mapping as a whole.
   */
  private _renderInverterSection(): TemplateResult {
    const path: PathSegment[] = [...INVERTER_PATH];
    const inverter = asJsonObject(this._getValue(path)) ?? {};
    const modePath: PathSegment[] = [...path, "controls", "mode"];
    const mode = asJsonObject(asJsonObject(inverter.controls)?.mode) ?? {};
    const options = asJsonObject(mode.options) ?? {};
    const optionCount = INVERTER_ACTION_OPTIONS.filter(
      (option) => this._stringValue(options[option.key]) !== "",
    ).length;
    const profileLabel = this._vendorProfile(inverter)?.label ?? "";
    // A profile that owns the mode control maps every action itself: only the
    // entity it points at is shown, read-only, in the controls section.
    const modeProvided = this._vendorProvision([...modePath, "options"]) !== null;

    return html`
      <p class="inline-note">${this._t("editor.notes.inverter")}</p>
      <div class="inverter-section list-stack">
        ${renderDeviceIssues(this._validation, deviceIssues(this._validation, path))}
        ${this._renderInverterSubsection(
          "hardware",
          this._renderHardwareProfile(inverter, path),
          profileLabel ? [{ key: "profile", text: profileLabel }] : [],
        )}
        ${this._renderInverterSubsection(
          "controls",
          html`<div class="field-grid">
            ${this._renderEntityGroup(
              [...modePath, "entity_id"],
              "editor.fields.mode_entity",
              {
                includeDomains: ["input_select", "select"],
                helperKey: "editor.helpers.mode_entity",
                helpKey: "editor.help.inverter_mode_entity",
              },
            )}
          </div>`,
          this._stringValue(mode.entity_id)
            ? [{ key: "mode", text: this._t("editor.section_badges.mode") }]
            : [],
        )}
        ${modeProvided
          ? nothing
          : this._renderInverterSubsection(
              "action_options",
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
              optionCount > 0
                ? [
                    {
                      key: "count",
                      text: this._tFormat("editor.section_badges.count", { count: optionCount }),
                    },
                  ]
                : [],
            )}
      </div>
    `;
  }

  /** One of the inverter's sub-sections, open while the reader keeps it open. */
  private _renderInverterSubsection(
    key: InverterSectionKey,
    content: TemplateResult,
    chips: { key: string; text: string }[],
  ): TemplateResult {
    return renderTrackedSection(
      this._t(`editor.sections.${key}`),
      key,
      content,
      chips,
      this._inverterOpenSections,
      (next) => (this._inverterOpenSections = next),
    );
  }

  /** The known profile a device's `profile` names, if any. */
  private _vendorProfile(device: JsonObject) {
    const profileId = this._stringValue(asJsonObject(device.profile)?.id);
    return profileId
      ? (this._vendors?.profiles ?? []).find((profile) => profile.id === profileId)
      : undefined;
  }

  /**
   * A device's hardware profile: the picker, the vendor's config entry, and
   * every entity the profile fills in, read-only.
   *
   * "Custom" is the absence of `profile`, so a device without one keeps every
   * hand-mapped slot exactly as before. Only the inverter has profiles today,
   * and its kind comes from its location, as the backend reads it.
   */
  private _renderHardwareProfile(device: JsonObject, path: PathSegment[]): TemplateResult {
    const profiles = (this._vendors?.profiles ?? []).filter(
      (profile) => profile.deviceKind === CONTROLLABLE_ID_INVERTER,
    );
    const stored = asJsonObject(device.profile);
    const profileId = this._stringValue(stored?.id);
    const entryId = this._stringValue(stored?.entry_id);
    const profile = this._vendorProfile(device);
    const info = this._vendors?.devices?.[validationPath(path)];
    return html`
      <p class="inline-note">${this._t("editor.notes.hardware_profile")}</p>
      <div class="field-grid">
        <div class="field">
          <div class="field-label-row">
            <label>${this._t("editor.fields.hardware_profile")}</label>
            ${this._renderHelpIcon("editor.fields.hardware_profile", "editor.help.hardware_profile")}
          </div>
          <select
            data-field="hardware-profile"
            @change=${(event: Event) =>
              this._setDeviceProfile(path, (event.currentTarget as HTMLSelectElement).value)}
          >
            <option value="" ?selected=${profileId === ""}>
              ${this._t("editor.values.profile_custom")}
            </option>
            ${profiles.map(
              (option) => html`
                <option value=${option.id} ?selected=${option.id === profileId}>${option.label}</option>
              `,
            )}
          </select>
        </div>
        ${profile
          ? html`
              <div class="field">
                <div class="field-label-row">
                  <label>${this._t("editor.fields.vendor_entry")}</label>
                  ${this._renderHelpIcon("editor.fields.vendor_entry", "editor.help.vendor_entry")}
                </div>
                ${profile.entries.length === 0
                  ? html`
                      <div class="vendor-provided-entity unresolved" data-field="vendor-no-entries">
                        ${this._tFormat("editor.dynamic.vendor_no_entries", { profile: profile.label })}
                      </div>
                    `
                  : nothing}
                <select
                  ?hidden=${profile.entries.length === 0}
                  data-field="vendor-entry"
                  @change=${(event: Event) =>
                    this._setDeviceVendorEntry(path, (event.currentTarget as HTMLSelectElement).value)}
                >
                  <option value="" ?selected=${entryId === ""}></option>
                  ${profile.entries.map(
                    (entry) => html`
                      <option value=${entry.entryId} ?selected=${entry.entryId === entryId}>
                        ${entry.title}
                      </option>
                    `,
                  )}
                </select>
              </div>
            `
          : nothing}
      </div>
      ${profile && info
        ? html`
            <div class="vendor-resolved">
              <div class="inline-note">
                ${this._tFormat("editor.dynamic.provided_by", { profile: profile.label })}
              </div>
              <ul>
                ${Object.entries(info.resolved).map(
                  ([configPath, entityId]) => html`
                    <li class=${entityId ? "" : "unresolved"} data-path=${configPath}>
                      <code>${configPath}</code>
                      <span>
                        ${entityId ??
                        this._t("editor.dynamic.vendor_entity_unresolved")}
                      </span>
                    </li>
                  `,
                )}
              </ul>
            </div>
          `
        : nothing}
    `;
  }

  /**
   * Which profile provides a config path, and the entity it resolves to.
   *
   * A path under one of a device's owned paths counts too, such as the
   * inverter's `controls.mode.entity_id`. `null` when no draft device's profile owns the path, which is every path
   * under "Custom".
   */
  private _vendorProvision(
    path: PathSegment[],
  ): { label: string; entityId: string | null } | null {
    const dotted = validationPath(path);
    for (const [devicePath, device] of Object.entries(this._vendors?.devices ?? {})) {
      const owned =
        device.ownedConfigPaths?.includes(dotted) ||
        device.ownedDevicePaths?.some((relative) => {
          const ownedPath = `${devicePath}.${relative}`;
          return dotted === ownedPath || dotted.startsWith(`${ownedPath}.`);
        });
      if (!owned) continue;
      const profile = this._vendors?.profiles?.find((option) => option.id === device.profile);
      return {
        label: profile?.label ?? device.profile,
        entityId: device.resolved?.[dotted] ?? null,
      };
    }
    return null;
  }

  /** An owned entity slot, where its picker would be: read-only, flagged if unresolved. */
  private _renderVendorProvidedField(
    path: PathSegment[],
    labelKey: string,
    provision: { label: string; entityId: string | null },
    slotted: TemplateResult | typeof nothing = nothing,
  ): TemplateResult {
    return html`
      <div class="field vendor-provided" data-path=${validationPath(path)}>
        <label>${this._t(labelKey)}</label>
        <div class="inline-note">
          ${this._tFormat("editor.dynamic.provided_by", { profile: provision.label })}
        </div>
        <div class=${provision.entityId ? "vendor-provided-entity" : "vendor-provided-entity unresolved"}>
          ${provision.entityId ??
          this._t("editor.dynamic.vendor_entity_unresolved")}
        </div>
        ${slotted}
      </div>
    `;
  }

  /**
   * Pick a device's hardware profile, or "Custom" for none.
   *
   * Picking one deletes the paths it owns from the draft: they are its now,
   * and a stored copy would be refused on save. The first config entry is
   * preselected, which on a single-inverter install is the only one.
   */
  private _setDeviceProfile(path: PathSegment[], profileId: string): void {
    const profile = (this._vendors?.profiles ?? []).find((option) => option.id === profileId);
    // Until the refetch answers, nothing is owned: a stale answer would keep
    // hiding the fields of a device just switched back to Custom.
    if (this._vendors) this._vendors = { ...this._vendors, devices: {} };
    this._applyMutation((draft) => {
      if (!profile) {
        unsetValueAtPath(draft, [...path, "profile"]);
        return;
      }
      for (const owned of profile.ownedConfigPaths) {
        unsetValueAtPath(draft, owned.split("."));
      }
      for (const owned of profile.ownedDevicePaths) {
        unsetValueAtPath(draft, [...path, ...owned.split(".")]);
      }
      const entry = profile.entries[0];
      setValueAtPath(draft, [...path, "profile"], {
        id: profile.id,
        ...(entry ? { entry_id: entry.entryId } : {}),
      });
    });
  }

  private _setDeviceVendorEntry(path: PathSegment[], entryId: string): void {
    this._applyMutation((draft) => {
      if (entryId) {
        setValueAtPath(draft, [...path, "profile", "entry_id"], entryId);
      } else {
        unsetValueAtPath(draft, [...path, "profile", "entry_id"]);
      }
    });
  }

  private async _loadVendors(): Promise<void> {
    if (!this.hass) return;
    const sequence = ++this._vendorsSequence;
    try {
      const vendors = await this.hass.callWS<VendorsResponse>({
        type: "helman/get_vendors",
        config: this._config ?? {},
      });
      if (sequence === this._vendorsSequence) this._vendors = vendors;
    } catch {
      // Without an answer nothing is owned, which is the Custom editor.
      if (sequence === this._vendorsSequence) this._vendors = null;
    }
  }

  private _renderUnsupportedDevice(device: JsonObject, path: PathSegment[]): TemplateResult {
    const chevronPath = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";
    const subtitle = this._tFormat("editor.dynamic.unsupported_appliance_kind", {
      kind: this._stringValue(device.kind) || this._t("editor.values.unknown"),
    });
    return html`
      <details class="list-card device-card" ?hidden=${!this._deviceMatchesFilter(device)}>
        <summary>
          <div class="appliance-summary-row">
            <div class="appliance-summary-left">
              ${renderDragHandle(this)}
              ${this._renderSvgIcon(chevronPath, "appliance-chevron")}
              <div class="card-title">
                <strong>${deviceName(this, this._inspections.results, device, path)}</strong>
                <span class="card-subtitle">${subtitle}</span>
              </div>
            </div>
            <div class="list-actions" @click=${this._preventSummaryToggle}>
              ${renderRemoveButton(this, {
                onRemove: () => this._removeDevice(path),
              })}
            </div>
          </div>
        </summary>
        <div class="appliance-body">
          ${renderDeviceIssues(this._validation, deviceIssues(this._validation, path))}
          <pre class="raw-preview">${JSON.stringify(device, null, 2)}</pre>
        </div>
      </details>
    `;
  }

  /**
   * One device of the tree, drawn by the element the device edit dialog also
   * mounts, and -- through `_renderDeviceChildren` -- the devices under it.
   *
   * The panel keeps what is list- and document-level: the drag handle, the
   * YAML toggle and remove in the summary, the YAML editor those toggle to,
   * the children list, and the filter that hides the card. Everything inside
   * the form belongs to the element.
   */
  private _renderDeviceCard(
    device: JsonObject,
    path: PathSegment[],
    parent: JsonObject | null,
  ): TemplateResult {
    return html`
      <helman-device-editor
        ?hidden=${!this._deviceMatchesFilter(device)}
        .config=${this._config}
        .path=${path}
        .parent=${parent}
        .hass=${this.hass}
        .narrow=${this.narrow ?? false}
        .localize=${(key: string) => this._t(key)}
        .validation=${this._validation}
        .inspections=${this._inspections.results}
        .energyEstimate=${this._deviceEnergyEstimate(device)}
        .listActions=${(devicePath: PathSegment[]) => this._renderDeviceListActions(devicePath)}
        .renderChildren=${(child: JsonObject, childPath: PathSegment[]) =>
          this._renderDeviceChildren(child, childPath)}
        .renderYaml=${(devicePath: PathSegment[]) =>
          this._getDeviceMode(devicePath) === "yaml" ? this._renderDeviceYamlEditor(devicePath) : null}
        @device-config-changed=${this._handleDeviceConfigChanged}
      ></helman-device-editor>
    `;
  }

  /** A device card's pipeline row: drag, Visual / YAML, remove. */
  private _renderDeviceListActions(path: PathSegment[]): TemplateResult {
    return html`
      <div class="list-actions" @click=${this._preventSummaryToggle}>
        ${renderDragHandle(this)}
        ${this._renderDeviceModeToggle(path)}
        ${renderRemoveButton(this, {
          onRemove: () => this._removeDevice(path),
        })}
      </div>
    `;
  }

  /**
   * A device card's edit, applied to the draft like any field of the panel's.
   *
   * The YAML state is keyed by device path, so an edit that moves devices to
   * other paths -- a new parent -- returns every card to visual mode, as a
   * drag or a remove does.
   */
  private _handleDeviceConfigChanged = (event: Event): void => {
    const { path, value } = (event as CustomEvent<DeviceConfigChangedDetail>).detail;
    const before = devicePathSignature(this._config);
    this._applyMutation((draft) => {
      if (value === undefined) unsetValueAtPath(draft, path);
      else setValueAtPath(draft, path, value);
    });
    if (devicePathSignature(this._config) !== before) this._resetDeviceModes();
  };

  /** Every device's name and icon path, for the shared poll, while the tab is open. */
  private _deviceIdentityTargets(): { key: string; path: PathSegment[]; always: boolean }[] {
    if (this._activeTab !== "devices") return [];
    return iterDevices(this._config).flatMap(({ path }) => deviceIdentityTargets(path));
  }

  /** A device's children, and -- when it can hold them -- a way to add one. */
  private _renderDeviceChildren(
    device: JsonObject,
    path: PathSegment[],
  ): TemplateResult | typeof nothing {
    const hasChildren = (asJsonArray(device.children) ?? []).length > 0;
    const canParent = canHaveChildren(device);
    if (!hasChildren && !canParent) return nothing;
    return html`
      ${hasChildren ? this._renderDeviceList([...path, "children"], device) : nothing}
      ${canParent ? this._renderAddDevice([...path, "children"], device) : nothing}
    `;
  }

  private _renderOptionalTextField(
    path: PathSegment[],
    labelKey: string,
    helperKey?: string,
    helpKey?: string,
    placeholder?: string,
  ): TemplateResult {
    return renderOptionalTextField(this, path, labelKey, helperKey, helpKey, placeholder);
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
      ["energy_nodes", device, "entities", "power_polarity"],
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
    options: EntityGroupOptions = {},
    slotted: TemplateResult | typeof nothing = nothing,
  ): TemplateResult {
    const provision = this._vendorProvision(path);
    if (provision) return this._renderVendorProvidedField(path, labelKey, provision, slotted);
    return renderEntityGroup(this, this._inspections.results, path, labelKey, options, slotted);
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
    const entityPath: PathSegment[] = ["energy_nodes", device, "entities", "power"];
    return this._renderEntityGroup(
      entityPath,
      labelKey,
      {
        includeDomains: ["sensor"],
        sensorKind: "power",
        helpKey,
        required,
      },
      // A profile that owns the polarity fixes it; one that owns only the
      // entity leaves the user's polarity in force, so it stays editable.
      this._vendorProvision(["energy_nodes", device, "entities", "power_polarity"])
        ? nothing
        : this._renderPolarityField(device),
    );
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
      ] = await Promise.allSettled([
        this.hass.callWS<unknown>({ type: "helman/get_config" }),
        this._loadLiveApplianceMetadata(),
        fetchOptimizerSchema(this.hass),
        fetchConfigDefaults(this.hass),
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
      // The tree is the saved config's too: a reload, an announced change or
      // a save from the device detail's own editor re-reads it.
      if (this._deviceTreeRequested) void this._loadDeviceTree();
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
        // The tree is built from the saved config, so a device just added or
        // re-metered only becomes clickable once it is re-read.
        if (this._deviceTreeRequested) void this._loadDeviceTree();
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
      if (
        scopeId === DOCUMENT_SCOPE_ID ||
        scopeId === TAB_SCOPE_IDS.devices ||
        scopeId === SECTION_SCOPE_IDS.devices.consumers
      ) {
        this._resetDeviceModes();
      }
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
      Object.values(this._deviceYamlErrors).some(
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
    this._deviceModes = {};
    this._deviceYamlValues = {};
    this._deviceYamlErrors = {};
    this._addDeviceTarget = null;
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

  private _handleAddGrouping = (): void => {
    const groupings = asJsonArray(this._getValue(["devices", "groupings"])) ?? [];
    const name = this._tFormat("editor.dynamic.new_grouping", { index: groupings.length + 1 });
    const id = slugId(name, groupings.map((grouping) => this._stringValue(asJsonObject(grouping)?.id)), "grouping");
    this._applyMutation((draft) => {
      appendListItem(draft, ["devices", "groupings"], { id, name, groups: [] });
    });
  };

  private _handleAddGroup(groupingIndex: number): void {
    const groupsPath: PathSegment[] = ["devices", "groupings", groupingIndex, "groups"];
    const groups = asJsonArray(this._getValue(groupsPath)) ?? [];
    const number = groups.length + 1;
    const name = this._tFormat("editor.dynamic.new_group", { index: number });
    const id = slugId(name, groups.map((group) => this._stringValue(asJsonObject(group)?.id)), "group");
    this._applyMutation((draft) => {
      appendListItem(draft, groupsPath, { id, name, short_name: String(number) });
    });
  }

  /** Removes a grouping and, in the same mutation, every device's reference to it. */
  private _handleRemoveGrouping(index: number): void {
    const groupingId = this._stringValue(this._getValue(["devices", "groupings", index, "id"]));
    this._applyMutation((draft) => {
      removeListItem(draft, ["devices", "groupings"], index);
      stripGroupReferences(draft, groupingId);
    });
  }

  /**
   * Commits a typed grouping id -- see {@link _commitId} -- and reopens its
   * card: the card is keyed by id, so it comes back as a new, collapsed one.
   */
  private async _handleRenameGrouping(index: number, input: HTMLInputElement): Promise<void> {
    const newId = this._commitId(["devices", "groupings"], index, input, "grouping", (draft, oldId, id) =>
      renameGroupReferences(draft, oldId, id),
    );
    if (newId === null) return;
    await this.updateComplete;
    const card = this.shadowRoot?.querySelector<HTMLDetailsElement>(
      `details.grouping-card[data-grouping-id="${newId}"]`,
    );
    if (card) card.open = true;
  }

  /** Commits a typed group id among its sibling groups -- see {@link _commitId}. */
  private _handleRenameGroup(groupingIndex: number, groupIndex: number, input: HTMLInputElement): void {
    const groupingPath: PathSegment[] = ["devices", "groupings", groupingIndex];
    const groupingId = this._stringValue(this._getValue([...groupingPath, "id"]));
    this._commitId([...groupingPath, "groups"], groupIndex, input, "group", (draft, oldId, id) =>
      renameGroupReferences(draft, groupingId, id, oldId),
    );
  }

  /**
   * Commits a typed id for the entry at `listPath[index]`: slugged, unique
   * among its siblings, and every device reference moved over by `rewrite` in
   * the same mutation. Device YAML editors and the consumers section's go back
   * to visual mode, as their snapshot still names the old id and its next edit
   * would put it back. An empty or unchanged id leaves the draft
   * alone and `input` shows the stored id again; that returns `null`. The
   * input is written here rather than bound with `live()`, which would reset
   * it on every render while the user is still typing.
   */
  private _commitId(
    listPath: PathSegment[],
    index: number,
    input: HTMLInputElement,
    fallback: string,
    rewrite: (draft: JsonObject, oldId: string, newId: string) => void,
  ): string | null {
    const entries = asJsonArray(this._getValue(listPath)) ?? [];
    const oldId = this._stringValue(asJsonObject(entries[index])?.id);
    const siblings = entries
      .filter((_, otherIndex) => otherIndex !== index)
      .map((entry) => this._stringValue(asJsonObject(entry)?.id));
    const raw = input.value;
    const newId = raw.trim() ? slugId(raw, siblings, fallback) : oldId;
    if (newId === oldId) {
      input.value = oldId;
      return null;
    }
    this._resetDeviceModes();
    const consumersScope = [SECTION_SCOPE_IDS.devices.consumers];
    this._scopeModes = this._omitScopeIds(this._scopeModes, consumersScope);
    this._scopeYamlValues = this._omitScopeIds(this._scopeYamlValues, consumersScope);
    this._scopeYamlErrors = this._omitScopeIds(this._scopeYamlErrors, consumersScope);
    this._applyMutation((draft) => {
      setValueAtPath(draft, [...listPath, index, "id"], newId);
      rewrite(draft, oldId, newId);
    });
    return newId;
  }

  /** Removes one group and, in the same mutation, every device's reference to it. */
  private _handleRemoveGroup(groupingIndex: number, groupIndex: number): void {
    const groupingPath: PathSegment[] = ["devices", "groupings", groupingIndex];
    const groupingId = this._stringValue(this._getValue([...groupingPath, "id"]));
    const groupId = this._stringValue(this._getValue([...groupingPath, "groups", groupIndex, "id"]));
    this._applyMutation((draft) => {
      removeListItem(draft, [...groupingPath, "groups"], groupIndex);
      stripGroupReferences(draft, groupingId, groupId);
    });
  }

  private _handleAddDailyEnergyEntity = (): void => {
    this._applyMutation((draft) => {
      appendListItem(
        draft,
        ["energy_nodes", "solar", "forecast", "daily_energy_entity_ids"],
        createDailyEnergyEntityDraft(),
      );
    });
  };

  private _handleAddImportPriceWindow = (): void => {
    this._applyMutation((draft) => {
      appendListItem(
        draft,
        ["energy_nodes", "grid", "forecast", "import_price_windows"],
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

  /** Every device id in the draft tree: ids are unique across all of it. */
  private _deviceIds(): string[] {
    return iterDevices(this._config)
      .map(({ device }) => this._stringValue(device.id))
      .filter((value) => value.length > 0);
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
  private _applyMutation(mutator: (draft: JsonObject) => void | boolean): void {
    const draft = cloneJson(this._config ?? {});
    // `false` is a mutator declining: the draft stays as it was.
    if (mutator(draft) === false) return;
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
    this._energyImport = null;
    this._dirty = true;
    this._validation = null;
    this._message = null;
    this._inspections.request();
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

  private _formatError(error: unknown, fallback: string): string {
    return formatError(error, fallback);
  }
}
