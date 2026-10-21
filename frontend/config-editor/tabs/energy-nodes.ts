import { html, nothing, type ReactiveController, type TemplateResult } from "lit";
import {
  appendListItem,
  asJsonArray,
  asJsonObject,
  createDailyEnergyEntityDraft,
  createImportPriceWindowDraft,
} from "../../cards/shared/config/config-document";
import {
  CONTROLLABLE_ID_INVERTER,
  INVERTER_PATH,
  validationPath,
} from "../../cards/shared/config/devices";
import {
  renderHelpIcon,
  renderOptionalNumberField,
  renderOptionalTextField,
  renderRequiredNumberField,
  renderSelectFieldWithDefault,
  stringValue,
} from "../../cards/shared/config/form-fields";
import {
  renderDragHandle,
  renderRemoveButton,
  renderSortableList,
} from "../../cards/shared/config/sortable-list";
import {
  deviceProfile,
  renderHardwareProfileFields,
  renderProfileEntities,
  renderProvidedField,
  vendorProvision,
} from "../../cards/shared/devices/hardware-profile";
import {
  deviceIssues,
  newIssueSections,
  renderDeviceIssues,
  renderIssueCountBadge,
  renderTrackedSection,
} from "../../cards/shared/devices/helman-device-editor";
import type { PathSegment } from "../../cards/shared/config/types";
import { SECTION_SCOPE_IDS } from "../config-editor-scopes";
import type { HelmanConfigEditorPanel } from "../helman-config-editor";

/**
 * Which sign a power sensor uses to carry its quantity, per power device.
 *
 * Mirrors ``POWER_POLARITY_OPTIONS`` in ``custom_components/helman/power_polarity.py``.
 */
export const POWER_POLARITY_OPTIONS = {
  solar: ["positive_is_production", "negative_is_production"],
  house: ["positive_is_consumption", "negative_is_consumption"],
  battery: ["positive_is_charging", "positive_is_discharging"],
  grid: ["positive_is_export", "positive_is_import"],
} as const satisfies Record<string, readonly [string, string]>;

export type PowerPolarityDevice = keyof typeof POWER_POLARITY_OPTIONS;

/**
 * The schedule actions an inverter's `controls.mode.options` maps, in the order
 * the card lays them out. Mirrors `CONTROLLABLE_SPECS["inverter"]` in Python:
 * the backend owns the list, this is the editor's copy of it.
 */
export type InverterSectionKey = "identity" | "controls" | "action_options";

/** The inverter sub-section that holds the field an issue points at. */
export function inverterSectionOfIssue(
  path: readonly PathSegment[],
  issuePath: string,
): InverterSectionKey {
  const rest = issuePath.slice(validationPath(path).length).replace(/^\./, "");
  if (rest === "profile" || rest.startsWith("profile.")) return "identity";
  if (rest.startsWith("controls.mode.options")) return "action_options";
  return "controls";
}

export const INVERTER_ACTION_OPTIONS = [
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

/**
 * Controller for the Energy Nodes tab. Holds open inverter sections and responds to validation updates.
 */
export class EnergyNodesTabController implements ReactiveController {
  /**
   * The inverter section's open sub-sections. Like a consumer card's, all start
   * closed; a section that gains a validation issue is opened, and only the
   * reader closes one.
   */
  private _inverterOpenSections = new Set<InverterSectionKey>();
  get inverterOpenSections(): Set<InverterSectionKey> {
    return this._inverterOpenSections;
  }
  set inverterOpenSections(value: Set<InverterSectionKey>) {
    if (this._inverterOpenSections === value) return;
    this._inverterOpenSections = value;
    this.host.requestUpdate();
  }

  /** The inverter issues the last validation report raised, so only new ones open. */
  private _inverterFlaggedIssues = new Set<string>();

  constructor(public readonly host: HelmanConfigEditorPanel) {
    this.host.addController(this);
  }

  hostUpdate(): void {
    const path = [...INVERTER_PATH];
    const { flagged, fresh } = newIssueSections(
      this.host.validation,
      path,
      this._inverterFlaggedIssues,
      (issuePath) => inverterSectionOfIssue(path, issuePath),
    );
    if (fresh.length) {
      this._inverterOpenSections = new Set([...this._inverterOpenSections, ...fresh]);
    }
    this._inverterFlaggedIssues = flagged;
  }

  setInverterOpenSections(next: Set<InverterSectionKey>): void {
    this.inverterOpenSections = next;
  }

  handleAddDailyEnergyEntity = (): void => {
    this.host._applyMutation((draft) => {
      appendListItem(
        draft,
        ["energy_nodes", "solar", "forecast", "daily_energy_entity_ids"],
        createDailyEnergyEntityDraft(),
      );
    });
  };

  handleAddImportPriceWindow = (): void => {
    this.host._applyMutation((draft) => {
      appendListItem(
        draft,
        ["energy_nodes", "grid", "forecast", "import_price_windows"],
        createImportPriceWindowDraft(),
      );
    });
  };
}

export function renderPolarityField(
  host: HelmanConfigEditorPanel,
  device: PowerPolarityDevice,
): TemplateResult {
  const path: PathSegment[] = ["energy_nodes", device, "entities", "power_polarity"];
  const label = (value: string) =>
    host._t(`editor.fields.power_polarity_${value}`);
  const provision = vendorProvision(host.vendors, path);
  if (provision) {
    const value = provision.value;
    return renderProvidedField(
      host,
      path,
      "editor.fields.power_polarity",
      provision,
      nothing,
      typeof value === "string" ? label(value) : null,
    );
  }
  const options = POWER_POLARITY_OPTIONS[device].map((value) => ({ value, label: label(value) }));
  return renderSelectFieldWithDefault(
    host,
    path,
    "editor.fields.power_polarity",
    options,
    POWER_POLARITY_OPTIONS[device][0],
    `editor.help.power_polarity_${device}`,
  );
}

export function renderPowerEntityGroup(
  host: HelmanConfigEditorPanel,
  device: PowerPolarityDevice,
  labelKey: string,
  helpKey: string,
  required = false,
): TemplateResult {
  const entityPath: PathSegment[] = ["energy_nodes", device, "entities", "power"];
  return host._renderEntityGroup(
    entityPath,
    labelKey,
    {
      includeDomains: ["sensor"],
      sensorKind: "power",
      helpKey,
      required,
    },
    renderPolarityField(host, device),
  );
}

function renderInverterSubsection(
  host: HelmanConfigEditorPanel,
  controller: EnergyNodesTabController,
  key: InverterSectionKey,
  content: TemplateResult,
  chips: { key: string; text: string }[],
): TemplateResult {
  return renderTrackedSection(
    host._t(`editor.sections.${key}`),
    key,
    content,
    chips,
    controller.inverterOpenSections,
    (next) => controller.setInverterOpenSections(next),
  );
}

export function renderInverterSection(
  host: HelmanConfigEditorPanel,
  controller: EnergyNodesTabController,
): TemplateResult {
  const path: PathSegment[] = [...INVERTER_PATH];
  const inverter = asJsonObject(host._getValue(path)) ?? {};
  const modePath: PathSegment[] = [...path, "controls", "mode"];
  const mode = asJsonObject(asJsonObject(inverter.controls)?.mode) ?? {};
  const options = asJsonObject(mode.options) ?? {};
  const optionCount = INVERTER_ACTION_OPTIONS.filter(
    (option) => stringValue(options[option.key]) !== "",
  ).length;
  const profileLabel = deviceProfile(host.vendors, inverter, CONTROLLABLE_ID_INVERTER)?.label ?? "";
  const modeProvided = vendorProvision(host.vendors, [...modePath, "options"]) !== null;

  return html`
    <p class="inline-note">${host._t("editor.notes.inverter")}</p>
    <div class="inverter-section list-stack">
      ${renderDeviceIssues(host.validation, deviceIssues(host.validation, path))}
      ${renderInverterSubsection(
        host,
        controller,
        "identity",
        html`<div class="field-grid">
            ${renderHardwareProfileFields(host, host.vendors, path, CONTROLLABLE_ID_INVERTER)}
          </div>
          ${renderProfileEntities(host, host.vendors, path, CONTROLLABLE_ID_INVERTER)}`,
        profileLabel ? [{ key: "profile", text: profileLabel }] : [],
      )}
      ${renderInverterSubsection(
        host,
        controller,
        "controls",
        html`<div class="field-grid">
          ${host._renderEntityGroup(
            [...modePath, "entity_id"],
            "editor.fields.mode_entity",
            {
              includeDomains: ["input_select", "select"],
              helperKey: "editor.helpers.mode_entity",
              helpKey: "editor.help.inverter_mode_entity",
            },
          )}
        </div>`,
        stringValue(mode.entity_id)
          ? [{ key: "mode", text: host._t("editor.section_badges.mode") }]
          : [],
      )}
      ${modeProvided
        ? nothing
        : renderInverterSubsection(
            host,
            controller,
            "action_options",
            html`<div class="field-grid">
              ${INVERTER_ACTION_OPTIONS.map((option) =>
                renderOptionalTextField(
                  host,
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
                    text: host._t("editor.section_badges.count", { count: optionCount }),
                  },
                ]
              : [],
          )}
    </div>
  `;
}

export function renderDailyEnergyEntity(
  host: HelmanConfigEditorPanel,
  _controller: EnergyNodesTabController,
  index: number,
): TemplateResult {
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
          ${renderDragHandle(host)}
          <div class="card-title">
            <strong>${host._t("editor.dynamic.daily_energy_entity", { index: index + 1 })}</strong>
          </div>
        </div>
        <div class="list-actions">
          ${renderRemoveButton(host, {
            onRemove: () =>
              host._removeListItem(
                ["energy_nodes", "solar", "forecast", "daily_energy_entity_ids"],
                index,
              ),
          })}
        </div>
      </div>
      ${host._renderEntityGroup(path, "editor.fields.entity_id", {
        includeDomains: ["sensor"],
        sensorKind: "energy",
        helpKey: "editor.help.solar_daily_energy_entity",
        required: true,
      })}
    </div>
  `;
}

export function renderImportPriceWindow(
  host: HelmanConfigEditorPanel,
  _controller: EnergyNodesTabController,
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
          ${renderDragHandle(host)}
          <div class="card-title">
            <strong>${host._t("editor.dynamic.import_window", { index: index + 1 })}</strong>
            <span class="card-subtitle">${host._t("editor.card.local_time_window")}</span>
          </div>
        </div>
        <div class="list-actions">
          ${renderRemoveButton(host, {
            onRemove: () =>
              host._removeListItem(
                ["energy_nodes", "grid", "forecast", "import_price_windows"],
                index,
              ),
          })}
        </div>
      </div>
      <div class="field-grid">
        <div class="field">
          <div class="field-label-row">
            <label>${host._t("editor.fields.start")}</label>
            ${renderHelpIcon(host, "editor.fields.start", "editor.help.import_window_start")}
          </div>
          <input
            type="time"
            .value=${stringValue(windowObject.start)}
            @change=${(event: Event) =>
              host._setRequiredString(
                [...basePath, "start"],
                (event.currentTarget as HTMLInputElement).value,
              )}
          />
        </div>
        <div class="field">
          <div class="field-label-row">
            <label>${host._t("editor.fields.end")}</label>
            ${renderHelpIcon(host, "editor.fields.end", "editor.help.import_window_end")}
          </div>
          <input
            type="time"
            .value=${stringValue(windowObject.end)}
            @change=${(event: Event) =>
              host._setRequiredString(
                [...basePath, "end"],
                (event.currentTarget as HTMLInputElement).value,
              )}
          />
        </div>
        ${renderRequiredNumberField(
          host,
          [...basePath, "price"],
          "editor.fields.price",
          undefined,
          "any",
          "editor.help.import_window_price",
        )}
      </div>
    </div>
  `;
}

export function renderEnergyNodesTab(
  host: HelmanConfigEditorPanel,
  controller: EnergyNodesTabController,
): TemplateResult {
  const dailyEnergyEntityIds =
    asJsonArray(host._getValue(["energy_nodes", "solar", "forecast", "daily_energy_entity_ids"])) ?? [];
  const importPriceWindows =
    asJsonArray(host._getValue(["energy_nodes", "grid", "forecast", "import_price_windows"])) ?? [];

  return html`
    ${host._renderSectionScope(
      SECTION_SCOPE_IDS.energy_nodes.inverter,
      renderInverterSection(host, controller),
      {
        initialOpen: false,
        badge: renderIssueCountBadge(
          host,
          host.validation,
          deviceIssues(host.validation, [...INVERTER_PATH]),
        ),
      },
    )}

    ${host._renderSectionScope(
      SECTION_SCOPE_IDS.energy_nodes.house,
      html`
        <div class="field-grid">
          ${renderPowerEntityGroup(
            host,
            "house",
            "editor.fields.house_power_entity",
            "editor.help.house_power_entity",
            true,
          )}
        </div>

        ${host._renderSectionScope(
          SECTION_SCOPE_IDS.energy_nodes.house_forecast,
          html`
            <div class="field-grid">
              ${host._renderEntityGroup(
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

    ${host._renderSectionScope(
      SECTION_SCOPE_IDS.energy_nodes.solar,
      html`
        <div class="field-grid field-grid--roomy">
          ${renderPowerEntityGroup(
            host,
            "solar",
            "editor.fields.power_entity",
            "editor.help.solar_power_entity",
          )}
          ${host._renderEntityGroup(
            ["energy_nodes", "solar", "entities", "today_energy"],
            "editor.fields.today_energy_entity",
            {
              includeDomains: ["sensor"],
              sensorKind: "energy",
              helpKey: "editor.help.solar_today_energy_entity",
            },
          )}
          ${renderOptionalNumberField(
            host,
            ["energy_nodes", "solar", "max_power"],
            "editor.fields.max_power",
            undefined,
            "editor.help.solar_max_power",
            { min: 0, suffix: "W" },
          )}
        </div>

        ${host._renderSectionScope(
          SECTION_SCOPE_IDS.energy_nodes.solar_forecast,
          html`
            <p class="inline-note">${host._t("editor.notes.solar_forecast_bias_correction")}</p>
            <div class="field-grid field-grid--roomy">
              ${host._renderEntityGroup(
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
              renderItem: (_value, index) => renderDailyEnergyEntity(host, controller, index),
              onMove: (oldIndex, newIndex) =>
                host._moveListItem(
                  ["energy_nodes", "solar", "forecast", "daily_energy_entity_ids"],
                  oldIndex,
                  newIndex,
                ),
            })}
            <div class="section-footer">
              <button
                type="button"
                class="add-button"
                @click=${controller.handleAddDailyEnergyEntity}
              >
                ${host._t("editor.actions.add_daily_energy_entity")}
              </button>
            </div>
          `,
          { initialOpen: false },
        )}
      `,
      { initialOpen: false },
    )}

    ${host._renderSectionScope(
      SECTION_SCOPE_IDS.energy_nodes.battery,
      html`
        <p class="inline-note">${host._t("editor.notes.battery_entities")}</p>
        <div class="field-grid field-grid--roomy">
          ${renderPowerEntityGroup(
            host,
            "battery",
            "editor.fields.power_entity",
            "editor.help.battery_power_entity",
          )}
          ${host._renderEntityGroup(
            ["energy_nodes", "battery", "entities", "remaining_energy"],
            "editor.fields.remaining_energy_entity",
            {
              includeDomains: ["sensor"],
              sensorKind: "energy",
              helpKey: "editor.help.battery_remaining_energy_entity",
            },
          )}
          ${host._renderEntityGroup(
            ["energy_nodes", "battery", "entities", "capacity"],
            "editor.fields.capacity_entity",
            {
              includeDomains: ["sensor"],
              sensorKind: "energy",
              helpKey: "editor.help.battery_capacity_entity",
            },
          )}
          ${host._renderEntityGroup(
            ["energy_nodes", "battery", "entities", "min_soc"],
            "editor.fields.min_soc_entity",
            {
              includeDomains: ["sensor"],
              sensorKind: "soc",
              helpKey: "editor.help.battery_min_soc_entity",
            },
          )}
          ${host._renderEntityGroup(
            ["energy_nodes", "battery", "entities", "max_soc"],
            "editor.fields.max_soc_entity",
            {
              includeDomains: ["sensor"],
              sensorKind: "soc",
              helpKey: "editor.help.battery_max_soc_entity",
            },
          )}
          ${renderOptionalNumberField(
            host,
            ["energy_nodes", "battery", "max_power"],
            "editor.fields.max_power",
            undefined,
            "editor.help.battery_max_power",
            { min: 0, suffix: "W" },
          )}
        </div>

        ${host._renderSectionScope(
          SECTION_SCOPE_IDS.energy_nodes.battery_forecast,
          html`
            <div class="field-grid">
              ${renderOptionalNumberField(
                host,
                ["energy_nodes", "battery", "forecast", "charge_efficiency"],
                "editor.fields.charge_efficiency",
                undefined,
                "editor.help.battery_charge_efficiency",
              )}
              ${renderOptionalNumberField(
                host,
                ["energy_nodes", "battery", "forecast", "discharge_efficiency"],
                "editor.fields.discharge_efficiency",
                undefined,
                "editor.help.battery_discharge_efficiency",
              )}
              ${renderOptionalNumberField(
                host,
                ["energy_nodes", "battery", "forecast", "max_charge_power_w"],
                "editor.fields.max_charge_power_w",
                undefined,
                "editor.help.battery_max_charge_power_w",
              )}
              ${renderOptionalNumberField(
                host,
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

    ${host._renderSectionScope(
      SECTION_SCOPE_IDS.energy_nodes.grid,
      html`
        <div class="field-grid">
          ${renderPowerEntityGroup(
            host,
            "grid",
            "editor.fields.power_entity",
            "editor.help.grid_power_entity",
          )}
          ${renderOptionalNumberField(
            host,
            ["energy_nodes", "grid", "max_allowed_export_power"],
            "editor.fields.max_allowed_export_power",
            undefined,
            "editor.help.grid_max_allowed_export_power",
            { min: 0, suffix: "W" },
          )}
          ${renderOptionalNumberField(
            host,
            ["energy_nodes", "grid", "max_power"],
            "editor.fields.max_power",
            undefined,
            "editor.help.grid_max_power",
            { min: 0, suffix: "W" },
          )}
        </div>

        ${host._renderSectionScope(
          SECTION_SCOPE_IDS.energy_nodes.grid_forecast,
          html`
            <div class="field-grid">
              ${host._renderEntityGroup(
                ["energy_nodes", "grid", "forecast", "sell_price_entity_id"],
                "editor.fields.sell_price_entity",
                {
                  includeDomains: ["sensor"],
                  helpKey: "editor.help.grid_sell_price_entity",
                },
              )}
              ${renderOptionalTextField(
                host,
                ["energy_nodes", "grid", "forecast", "import_price_unit"],
                "editor.fields.import_price_unit",
                "editor.helpers.import_price_unit",
                "editor.help.grid_import_price_unit",
              )}
            </div>

            <p class="inline-note">${host._t("editor.notes.grid_import_windows")}</p>
            ${renderSortableList({
              items: importPriceWindows,
              containerClass: "list-stack",
              renderItem: (windowConfig, index) =>
                renderImportPriceWindow(host, controller, windowConfig, index),
              onMove: (oldIndex, newIndex) =>
                host._moveListItem(
                  ["energy_nodes", "grid", "forecast", "import_price_windows"],
                  oldIndex,
                  newIndex,
                ),
            })}
            <div class="section-footer">
              <button
                type="button"
                class="add-button"
                @click=${controller.handleAddImportPriceWindow}
              >
                ${host._t("editor.actions.add_import_price_window")}
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
