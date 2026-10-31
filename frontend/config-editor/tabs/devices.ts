import {
  DeviceListController,
  GROUPING_CHEVRON_PATH,
  preventSummaryToggle,
  renderDeviceList,
  renderAddDevice,
} from "../../cards/shared/devices/device-list";
import { html, nothing, type ReactiveController, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { keyed } from "lit/directives/keyed.js";
import { mdiDragVertical } from "@mdi/js";
import { LatestRequest } from "../../cards/shared/data/latest-request";
import { callHelman } from "../../cards/shared/data/helman-commands";
import { SECTION_SCOPE_IDS } from "../config-editor-scopes";
import {
  formatError,
  renderOptionalTextField,
  renderSvgIcon,
  stringValue,
} from "../../cards/shared/config/form-fields";
import {
  renderDragHandle,
  renderRemoveButton,
  renderSortableList,
} from "../../cards/shared/config/sortable-list";
import {
  appendListItem,
  asJsonArray,
  asJsonObject,
  cloneJson,
  getValueAtPath,
  removeListItem,
  setValueAtPath,
} from "../../cards/shared/config/config-document";
import {
  assignGroup,
  assignPhase,
  consumerGroups,
  consumerPhases,
  DEVICE_FILTERS,
  DEVICE_PHASES,
  isDevicePhase,
  deviceChildren,
  isSchedulable,
  iterDevices,
  renameGroupReferences,
  slugId,
  stripGroupReferences,
  type DeviceFilter,
  type GroupedDeviceEntry,
} from "../../cards/shared/config/devices";
import {
  deviceIdentityTargets,
  deviceName,
} from "../../cards/shared/devices/helman-device-editor";
import type { EnergyImportPreview } from "../../cards/helman-api";
import type {
  JsonObject,
  PathSegment,
} from "../../cards/shared/config/types";
import type { HelmanConfigEditorPanel } from "../helman-config-editor";

/** A group's device chips move between lists but never sort within one. */
const MEMBER_SORTABLE_OPTIONS = { sort: false };

const stopEvent = (event: Event): void => event.stopPropagation();

/**
 * Controller for the Devices tab.
 *
 * Exposes inspection targets to the panel (`extraTargets`) and owns filter state,
 * energy import preview, and groupings / phase board mutations. Device lists
 * and their YAML modes are shared with the device edit dialog.
 */
export class DevicesTabController implements ReactiveController {
  /** Which devices the Devices tab lists; the rest stay rendered but hidden. */
  private _deviceFilter: DeviceFilter = "all";
  get deviceFilter(): DeviceFilter {
    return this._deviceFilter;
  }
  set deviceFilter(value: DeviceFilter) {
    if (this._deviceFilter === value) return;
    this._deviceFilter = value;
    this.host.requestUpdate();
  }

  private _energyImport: { preview: EnergyImportPreview; draft: JsonObject } | null = null;
  get energyImport(): { preview: EnergyImportPreview; draft: JsonObject } | null {
    return this._energyImport;
  }
  set energyImport(value: { preview: EnergyImportPreview; draft: JsonObject } | null) {
    if (this._energyImport === value) return;
    this._energyImport = value;
    this.host.requestUpdate();
  }

  private _deviceActionMessage = "";
  get deviceActionMessage(): string {
    return this._deviceActionMessage;
  }
  set deviceActionMessage(value: string) {
    if (this._deviceActionMessage === value) return;
    this._deviceActionMessage = value;
    this.host.requestUpdate();
  }

  private _importLoading = false;
  get importLoading(): boolean {
    return this._importLoading;
  }
  set importLoading(value: boolean) {
    if (this._importLoading === value) return;
    this._importLoading = value;
    this.host.requestUpdate();
  }

  public readonly energyImportRequest = new LatestRequest<object>();

  readonly list: DeviceListController;

  constructor(public readonly host: HelmanConfigEditorPanel) {
    this.host.addController(this);
    this.list = new DeviceListController(host, {
      config: () => host.config,
      savedConfig: () => host.savedConfig,
      resolvedConfig: () => host.resolvedConfig(),
      hass: () => host.hass,
      vendors: () => host.vendors,
      validation: () => host.validation,
      inspections: () => host.inspections.results,
      t: (key, values) => host._t(key, values),
      narrow: () => host.narrow ?? false,
      mutate: (mutator) => host._applyMutation(mutator),
      reportError: (text) => host.setMessage(text ? { kind: "error", text } : null),
      deviceVisible: (device) => this.deviceMatchesFilter(device),
      energyEstimate: (device, path) => host.trainingTab.deviceEnergyEstimate(
        asJsonObject(getValueAtPath(host.resolvedConfig() ?? {}, path)) ?? device,
      ),
    });
  }

  hostConnected(): void {}

  /** Every device's name and icon path, for the shared poll, while the tab is open. */
  extraTargets(): { key: string; path: PathSegment[]; always: boolean }[] {
    if (this.host.activeTab !== "devices") return [];
    return iterDevices(this.host.config).flatMap(({ path }) => deviceIdentityTargets(path));
  }

  deviceMatchesFilter(device: JsonObject): boolean {
    if (this.deviceFilter === "all") return true;
    return (
      isSchedulable(device) === (this.deviceFilter === "schedulable") ||
      deviceChildren(device).some((child) => this.deviceMatchesFilter(child))
    );
  }

  async previewEnergyImport(): Promise<void> {
    if (!this.host.hass || !this.host.config) return;
    const draft = this.host.config;
    const hass = this.host.hass;
    const request = this.energyImportRequest.begin({ draft, hass });
    if (request === null) return;
    this.energyImport = null;
    this.deviceActionMessage = "";
    if (draft.devices != null && !asJsonObject(draft.devices)) {
      this.deviceActionMessage = this.host._t("editor.messages.import_energy_invalid_devices");
      return;
    }
    this.importLoading = true;
    this.host.requestUpdate();
    try {
      const preview = await callHelman(hass, "helman/preview_energy_import", { config: draft });
      if (this.host.config === draft && this.energyImportRequest.isCurrent(request))
        this.energyImport = { preview, draft };
    } catch (error) {
      if (this.host.config === draft && this.energyImportRequest.isCurrent(request))
        this.deviceActionMessage = formatError(error, this.host._t("editor.messages.import_energy_failed"));
    } finally {
      if (this.energyImportRequest.isCurrent(request)) {
        this.importLoading = false;
        this.host.requestUpdate();
      }
    }
  }

  handleAddGrouping = (): void => {
    const groupings = asJsonArray(this.host._getValue(["devices", "groupings"])) ?? [];
    const name = this.host._t("editor.dynamic.new_grouping", { index: groupings.length + 1 });
    const id = slugId(name, groupings.map((grouping) => stringValue(asJsonObject(grouping)?.id)), "grouping");
    this.host._applyMutation((draft) => {
      appendListItem(draft, ["devices", "groupings"], { id, name, groups: [] });
    });
  };

  handleAddGroup(groupingIndex: number): void {
    const groupsPath: PathSegment[] = ["devices", "groupings", groupingIndex, "groups"];
    const groups = asJsonArray(this.host._getValue(groupsPath)) ?? [];
    const number = groups.length + 1;
    const name = this.host._t("editor.dynamic.new_group", { index: number });
    const id = slugId(name, groups.map((group) => stringValue(asJsonObject(group)?.id)), "group");
    this.host._applyMutation((draft) => {
      appendListItem(draft, groupsPath, { id, name, short_name: String(number) });
    });
  }

  handleRemoveGrouping(index: number): void {
    const groupingId = stringValue(this.host._getValue(["devices", "groupings", index, "id"]));
    this.host._applyMutation((draft) => {
      removeListItem(draft, ["devices", "groupings"], index);
      stripGroupReferences(draft, groupingId);
    });
  }

  async handleRenameGrouping(index: number, input: HTMLInputElement): Promise<void> {
    const newId = this.commitId(["devices", "groupings"], index, input, "grouping", (draft, oldId, id) =>
      renameGroupReferences(draft, oldId, id),
    );
    if (newId === null) return;
    await this.host.updateComplete;
    const card = this.host.renderRoot?.querySelector<HTMLDetailsElement>(
      `details.grouping-card[data-grouping-id="${newId}"]`,
    );
    if (card) card.open = true;
  }

  handleRenameGroup(groupingIndex: number, groupIndex: number, input: HTMLInputElement): void {
    const groupingPath: PathSegment[] = ["devices", "groupings", groupingIndex];
    const groupingId = stringValue(this.host._getValue([...groupingPath, "id"]));
    this.commitId([...groupingPath, "groups"], groupIndex, input, "group", (draft, oldId, id) =>
      renameGroupReferences(draft, groupingId, id, oldId),
    );
  }

  commitId(
    listPath: PathSegment[],
    index: number,
    input: HTMLInputElement,
    fallback: string,
    rewrite: (draft: JsonObject, oldId: string, newId: string) => void,
  ): string | null {
    const entries = asJsonArray(this.host._getValue(listPath)) ?? [];
    const oldId = stringValue(asJsonObject(entries[index])?.id);
    const siblings = entries
      .filter((_, otherIndex) => otherIndex !== index)
      .map((entry) => stringValue(asJsonObject(entry)?.id));
    const raw = input.value;
    const newId = raw.trim() ? slugId(raw, siblings, fallback) : oldId;
    if (newId === oldId) {
      input.value = oldId;
      return null;
    }
    this.list.resetDeviceModes();
    this.host._omitScopeIdsFromYaml([SECTION_SCOPE_IDS.devices.consumers]);
    this.host._applyMutation((draft) => {
      setValueAtPath(draft, [...listPath, index, "id"], newId);
      rewrite(draft, oldId, newId);
    });
    return newId;
  }

  handleRemoveGroup(groupingIndex: number, groupIndex: number): void {
    const groupingPath: PathSegment[] = ["devices", "groupings", groupingIndex];
    const groupingId = stringValue(this.host._getValue([...groupingPath, "id"]));
    const groupId = stringValue(this.host._getValue([...groupingPath, "groups", groupIndex, "id"]));
    this.host._applyMutation((draft) => {
      removeListItem(draft, [...groupingPath, "groups"], groupIndex);
      stripGroupReferences(draft, groupingId, groupId);
    });
  }
}

export function renderEnergyImport(
  host: HelmanConfigEditorPanel,
  controller: DevicesTabController,
): TemplateResult | typeof nothing {
  if (!controller.energyImport || controller.energyImport.draft !== host.config)
    return nothing;
  const { preview } = controller.energyImport;
  const hasChanges =
    preview.additions.length +
    preview.powerEntities.length +
    preview.nestingChanges.length > 0;
  return html`<div class="list-card energy-import-preview">
    <strong>${host._t("editor.import.preview")}</strong>
    <p>${host._t("editor.import.draft_only")}</p>
    <ul>
      ${preview.additions.map((item) => html`<li>${host._t("editor.import.add")}: ${item.deviceId} — ${item.energyEntityId}${item.powerEntityId ? html`, ${item.powerEntityId}` : nothing}${item.parentId ? html` → ${item.parentId}` : nothing}</li>`)}
      ${preview.powerEntities.map((item) => html`<li>${host._t("editor.import.power")}: ${item.deviceId} → ${item.entityId}</li>`)}
      ${preview.nestingChanges.map((item) => html`<li>${host._t("editor.import.move")}: ${item.deviceId} → ${item.parentId}</li>`)}
      ${preview.skippedRows.map((item) => html`<li>${host._t("editor.import.skipped")}: ${item.energy_entity_id} — ${host._t(`editor.import.skip_reasons.${item.reason}`, { device: item.device_id ?? "" })}</li>`)}
      ${preview.warnings.map((item) => html`<li class="message info">${host._t(`editor.import.warnings.${item.reason}`, { meter: item.energy_entity_id, device: item.device_id ?? "" })}</li>`)}
      ${preview.validation.errors.length ? html`<li>${host._t("editor.import.blocked")}</li>` : nothing}
      ${preview.validation.errors.map((item) => html`<li class="message error">${item.path}: ${item.message}</li>`)}
    </ul>
    ${!hasChanges ? html`<p>${host._t("editor.import.no_changes")}</p>` : nothing}
    <div class="inline-actions">
    <button
      class="add-button primary apply-energy-import"
      type="button"
      ?disabled=${!preview.validation.valid || !hasChanges}
      @click=${() => {
        if (
          !controller.energyImport ||
          controller.energyImport.draft !== host.config ||
          !preview.validation.valid ||
          !hasChanges
        )
          return;
        controller.list.resetDeviceModes();
        host._applyMutation((draft) => {
          draft.devices = { ...(asJsonObject(draft.devices) ?? {}), consumers: cloneJson(preview.devices) };
        });
        controller.energyImport = null;
        host.requestUpdate();
      }}
    >
      ${host._t("editor.actions.apply")}
    </button>
    <button
      class="add-button cancel-energy-import"
      type="button"
      @click=${() => {
        controller.energyImport = null;
        host.requestUpdate();
      }}
    >
      ${host._t("editor.actions.cancel")}
    </button>
    </div>
  </div>`;
}

export function renderDeviceFilter(
  host: HelmanConfigEditorPanel,
  controller: DevicesTabController,
): TemplateResult {
  return html`
    <div
      class="mode-toggle device-filter"
      role="group"
      aria-label=${host._t("editor.device_filter.label")}
    >
      ${DEVICE_FILTERS.map(
        (filter) => html`
          <button
            type="button"
            class=${controller.deviceFilter === filter ? "active" : ""}
            aria-pressed=${controller.deviceFilter === filter}
            @click=${() => {
              controller.deviceFilter = filter;
              host.requestUpdate();
            }}
          >
            ${host._t(`editor.device_filter.${filter}`)}
          </button>
        `,
      )}
    </div>
  `;
}

export function renderBoardSummary(
  title: string,
  subtitle: string,
  actions: TemplateResult | typeof nothing = nothing,
): TemplateResult {
  return html`
    <summary>
      <div class="appliance-summary-row">
        <div class="appliance-summary-left">
          ${renderSvgIcon(GROUPING_CHEVRON_PATH, "appliance-chevron")}
          <div class="card-title">
            <strong>${title}</strong>
            <span class="card-subtitle">${subtitle}</span>
          </div>
        </div>
        ${actions}
      </div>
    </summary>
  `;
}

export function renderMemberChip(
  host: HelmanConfigEditorPanel,
  entry: GroupedDeviceEntry,
): TemplateResult {
  const { device, parent, path } = entry;
  return html`
    <div class="member-chip draggable" data-device-id=${stringValue(device.id)} .sortableData=${path}>
      ${renderSvgIcon(mdiDragVertical, "member-chip-glyph")}
      <span class="member-name">${deviceName(host, host.inspections.results, device, path)}</span>
      ${parent
        ? html`<span class="member-parent">${deviceName(host, host.inspections.results, parent, path.slice(0, -2))}</span>`
        : nothing}
    </div>
  `;
}

export function renderGroupMembers(
  host: HelmanConfigEditorPanel,
  dragGroup: string,
  bucketId: string | null,
  members: GroupedDeviceEntry[],
  assign: (draft: JsonObject, devicePath: PathSegment[], bucketId: string | null) => boolean,
): TemplateResult {
  return html`
    <ha-sortable
      group=${dragGroup}
      draggable-selector=".member-chip.draggable"
      .options=${MEMBER_SORTABLE_OPTIONS}
      @item-added=${(event: Event) => {
        event.stopPropagation();
        const devicePath = (event as CustomEvent<{ data?: unknown }>).detail?.data;
        if (!Array.isArray(devicePath)) return;
        host._applyMutation((draft) => assign(draft, devicePath, bucketId));
      }}
      @item-moved=${stopEvent}
      @item-removed=${stopEvent}
    >
      <div class="group-members" data-group-id=${bucketId ?? ""}>
        ${repeat(
          members,
          (entry) => entry.path.join("."),
          (entry) => renderMemberChip(host, entry),
        )}
      </div>
    </ha-sortable>
  `;
}

export function renderGroupRow(
  host: HelmanConfigEditorPanel,
  controller: DevicesTabController,
  group: JsonObject,
  groupingIndex: number,
  groupIndex: number,
  groupingId: string,
  members: GroupedDeviceEntry[],
): TemplateResult {
  const path: PathSegment[] = ["devices", "groupings", groupingIndex, "groups", groupIndex];
  const groupId = stringValue(group.id);
  const nameLabel = host._t("editor.fields.group_name");
  const idLabel = host._t("editor.fields.group_id");
  const shortNameLabel = host._t("editor.fields.group_short_name");
  return html`
    <div class="group-row">
      ${renderDragHandle(host)}
      <div class="field field-compact group-name-cell">
        <input
          class="group-name-input"
          .value=${stringValue(group.name)}
          aria-label=${nameLabel}
          @change=${(event: Event) =>
            host._setRequiredString([...path, "name"], (event.currentTarget as HTMLInputElement).value)}
        />
      </div>
      <div class="field field-compact group-id-cell">
        <input
          class="group-id-input"
          .value=${groupId}
          aria-label=${idLabel}
          @change=${(event: Event) =>
            controller.handleRenameGroup(groupingIndex, groupIndex, event.currentTarget as HTMLInputElement)}
        />
      </div>
      <div class="field field-compact group-short-name-cell">
        <input
          class="group-short-name-input"
          .value=${stringValue(group.short_name)}
          aria-label=${shortNameLabel}
          @change=${(event: Event) =>
            host._setRequiredString([...path, "short_name"], (event.currentTarget as HTMLInputElement).value)}
        />
      </div>
      <div class="list-actions">
        ${renderRemoveButton(host, {
          className: "remove-group",
          onRemove: () => controller.handleRemoveGroup(groupingIndex, groupIndex),
        })}
      </div>
      ${renderGroupMembers(
        host,
        "helman-grouping-" + groupingId,
        groupId,
        members.filter((entry) => entry.group === groupId),
        (draft, devicePath, bucketId) => assignGroup(draft, devicePath, groupingId, bucketId),
      )}
    </div>
  `;
}

export function renderGrouping(
  host: HelmanConfigEditorPanel,
  controller: DevicesTabController,
  grouping: JsonObject,
  index: number,
): TemplateResult {
  const path: PathSegment[] = ["devices", "groupings", index];
  const groups = asJsonArray(grouping.groups) ?? [];
  const groupingId = stringValue(grouping.id);
  const members = consumerGroups(host.config, groupingId);
  const groupIds = new Set(groups.map((group) => stringValue(asJsonObject(group)?.id)));
  const nameLabel = host._t("editor.fields.grouping_name");
  const idLabel = host._t("editor.fields.grouping_id");
  return html`
    <details class="list-card grouping-card" data-grouping-id=${groupingId}>
      ${renderBoardSummary(
        stringValue(grouping.name),
        host._t("editor.card.grouping"),
        html`<div class="list-actions" @click=${preventSummaryToggle}>
          ${renderRemoveButton(host, {
            className: "remove-grouping",
            onRemove: () => controller.handleRemoveGrouping(index),
            label: host._t("editor.actions.remove_grouping"),
          })}
        </div>`,
      )}
      <div class="grouping-name">
        <input
          class="grouping-name-input"
          .value=${stringValue(grouping.name)}
          title=${nameLabel}
          aria-label=${nameLabel}
          @change=${(event: Event) =>
            host._setRequiredString([...path, "name"], (event.currentTarget as HTMLInputElement).value)}
        />
        <input
          class="grouping-id-input"
          .value=${groupingId}
          title=${idLabel}
          aria-label=${idLabel}
          @change=${(event: Event) =>
            controller.handleRenameGrouping(index, event.currentTarget as HTMLInputElement)}
        />
      </div>
      ${groups.length > 0
        ? html`
            <div class="group-rows">
              <div class="group-row group-row-head">
                <span class="group-row-handle-spacer"></span>
                <label class="group-name-cell">${host._t("editor.fields.group_name")}</label>
                <label class="group-id-cell">${host._t("editor.fields.group_id")}</label>
                <label class="group-short-name-cell">${host._t("editor.fields.group_short_name")}</label>
                <span class="group-row-actions-spacer"></span>
              </div>
              ${renderSortableList({
                items: groups,
                containerClass: "group-rows-list",
                renderItem: (group, groupIndex) =>
                  renderGroupRow(host, controller, asJsonObject(group) ?? {}, index, groupIndex, groupingId, members),
                onMove: (oldIndex, newIndex) => host._moveListItem([...path, "groups"], oldIndex, newIndex),
              })}
            </div>
          `
        : nothing}
      <div class="group-unassigned">
        <strong>${host._t("editor.device_groups.unassigned")}</strong>
        ${renderGroupMembers(
          host,
          "helman-grouping-" + groupingId,
          null,
          members.filter((entry) => entry.group === null || !groupIds.has(entry.group)),
          (draft, devicePath, groupId) => assignGroup(draft, devicePath, groupingId, groupId),
        )}
      </div>
      <div class="section-footer">
        <button type="button" class="add-button add-group" @click=${() => controller.handleAddGroup(index)}>
          ${host._t("editor.actions.add_group")}
        </button>
      </div>
    </details>
  `;
}

export function renderGroupings(
  host: HelmanConfigEditorPanel,
  controller: DevicesTabController,
): TemplateResult {
  const groupings = asJsonArray(host._getValue(["devices", "groupings"])) ?? [];
  if (groupings.length === 0) {
    return html`<div class="message info">${host._t("editor.empty.no_device_groupings")}</div>`;
  }
  return html`
    <div class="list-stack">
      ${groupings.map((value, index) => {
        const grouping = asJsonObject(value) ?? {};
        return keyed(stringValue(grouping.id), renderGrouping(host, controller, grouping, index));
      })}
    </div>
  `;
}

export function renderPhaseBoard(
  host: HelmanConfigEditorPanel,
  _controller: DevicesTabController,
): TemplateResult {
  const members = consumerPhases(host.config);
  return html`
    <details class="list-card phase-card">
      ${renderBoardSummary(host._t("editor.card.house_phases"), host._t("editor.card.phases"))}
      <div class="group-rows">
        ${DEVICE_PHASES.map(
          (phase) => html`
            <div class="group-row">
              <strong class="phase-name">${host._t(`editor.device_phases.${phase}`)}</strong>
              ${renderGroupMembers(
                host,
                "helman-phases",
                phase,
                members.filter((entry) => entry.group === phase),
                assignPhase,
              )}
            </div>
          `,
        )}
      </div>
      <div class="group-unassigned">
        <strong>${host._t("editor.device_phases.unassigned")}</strong>
        ${renderGroupMembers(
          host,
          "helman-phases",
          null,
          members.filter((entry) => !isDevicePhase(entry.group)),
          assignPhase,
        )}
      </div>
    </details>
  `;
}

export function renderDevicesTab(
  host: HelmanConfigEditorPanel,
  controller: DevicesTabController,
): TemplateResult {
  const consumers = asJsonArray(host._getValue(["devices", "consumers"])) ?? [];
  return html`
    ${host._renderSectionScope(
      SECTION_SCOPE_IDS.devices.settings,
      html`
        <div class="field-grid">
          ${renderOptionalTextField(
            host,
            ["devices", "name_cleaner_regex"],
            "editor.fields.power_sensor_name_cleaner_regex",
            "editor.helpers.power_sensor_name_cleaner_regex",
            "editor.help.power_sensor_name_cleaner_regex",
          )}
          ${renderOptionalTextField(
            host,
            ["devices", "power_sensor_label"],
            "editor.fields.power_sensor_label",
          )}
          ${renderOptionalTextField(
            host,
            ["devices", "power_switch_label"],
            "editor.fields.power_switch_label",
          )}
        </div>
      `,
      { initialOpen: false },
    )}

    ${host._renderSectionScope(
      SECTION_SCOPE_IDS.devices.groupings,
      html`
        <p class="inline-note">${host._t("editor.notes.device_groupings")}</p>
        ${renderPhaseBoard(host, controller)}
        ${renderGroupings(host, controller)}
        <div class="section-footer">
          <button
            type="button"
            class="add-button add-grouping"
            @click=${controller.handleAddGrouping}
          >
            ${host._t("editor.actions.add_grouping")}
          </button>
        </div>
      `,
      { initialOpen: false },
    )}

    ${host._renderSectionScope(
      SECTION_SCOPE_IDS.devices.consumers,
      html`
        <p class="inline-note">${host._t("editor.notes.devices")}</p>
        ${consumers.length > 0
          ? html`${renderDeviceFilter(host, controller)}${renderDeviceList(controller.list, ["devices", "consumers"], null)}`
          : html`<div class="message info devices-empty">${host._t("editor.empty.no_devices")}</div>`}
        ${renderAddDevice(
          controller.list,
          ["devices", "consumers"],
          null,
          html`<button
            class="add-button import-energy"
            type="button"
            ?disabled=${controller.importLoading}
            @click=${() => controller.previewEnergyImport()}
          >
            ${host._t("editor.actions.import_energy")}
          </button>`,
        )}
        ${controller.deviceActionMessage
          ? html`<div class="message error">${controller.deviceActionMessage}</div>`
          : nothing}
        ${renderEnergyImport(host, controller)}
      `,
      { initialOpen: false },
    )}
  `;
}
