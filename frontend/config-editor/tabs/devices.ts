import { html, nothing, type ReactiveController, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { keyed } from "lit/directives/keyed.js";
import { mdiDragVertical } from "@mdi/js";
import { LatestRequest } from "../../cards/shared/data/latest-request";
import { callHelman } from "../../cards/shared/data/helman-commands";
import { SECTION_SCOPE_IDS, type EditorMode } from "../config-editor-scopes";
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
  parseItemYaml,
  renderItemModeToggle,
  renderItemYamlEditor,
  type YamlEditorValueChangedDetail,
} from "../../cards/shared/config/item-yaml";
import { loadHaYamlEditor } from "../load-ha-elements";
import { entityGroupKey } from "../../cards/shared/config/entity-group";
import {
  appendListItem,
  asJsonArray,
  asJsonObject,
  cloneJson,
  getValueAtPath,
  removeListItem,
  setValueAtPath,
  unsetValueAtPath,
} from "../../cards/shared/config/config-document";
import {
  assignGroup,
  assignPhase,
  canHaveChildren,
  consumerGroups,
  consumerPhases,
  DEVICE_FILTERS,
  DEVICE_PHASES,
  isDevicePhase,
  deviceChildren,
  deviceIdFor,
  deviceKind,
  nameSlug,
  CONTROLLABLE_ID_INVERTER,
  isSchedulable,
  iterDevices,
  meterlessChildren,
  ownMeter,
  renameGroupReferences,
  slugId,
  stripGroupReferences,
  SWITCH_CONTROL_DOMAINS,
  uniqueDeviceId,
  type DeviceFilter,
  type GroupedDeviceEntry,
} from "../../cards/shared/config/devices";
import {
  freeCandidates,
  candidateLabel,
} from "../../cards/shared/devices/hardware-profile";
import {
  SEEDED_PROJECTION,
  EDITABLE_DEVICE_KINDS,
  deviceIdentityTargets,
  deviceIssues,
  deviceName,
  renderDeviceIssues,
  seedDeviceProjection,
  type DeviceConfigChangedDetail,
  type HelmanDeviceEditor,
} from "../../cards/shared/devices/helman-device-editor";
import { SENSOR_KIND_FILTERS } from "../../cards/shared/config/sensor-kind";
import type { EnergyImportPreview } from "../../cards/helman-api";
import type {
  JsonObject,
  JsonValue,
  PathSegment,
  VendorProfileInfo,
} from "../../cards/shared/config/types";
import type { HelmanConfigEditorPanel } from "../helman-config-editor";

/** The chevron of a collapsible card, as the device cards draw it. */
const GROUPING_CHEVRON_PATH = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";

/** A group's device chips move between lists but never sort within one. */
const MEMBER_SORTABLE_OPTIONS = { sort: false };

const stopEvent = (event: Event): void => event.stopPropagation();

/** Which device sits at which path; changes only when an edit moves devices. */
export function devicePathSignature(config: JsonObject | null): string {
  return iterDevices(config)
    .map(({ device, path }) => `${entityGroupKey(path)}=${stringValue(device.id)}`)
    .join("|");
}

/**
 * Controller for the Devices tab.
 *
 * Exposes inspection targets to the panel (`extraTargets`), owns per-device YAML modes,
 * filter state, energy import preview, add-device picker state, and groupings / phase board mutations.
 */
export class DevicesTabController implements ReactiveController {
  /** Per-device Visual / YAML state, keyed by the device's path key. */
  private _deviceModes: Partial<Record<string, EditorMode>> = {};
  get deviceModes(): Partial<Record<string, EditorMode>> {
    return this._deviceModes;
  }
  set deviceModes(value: Partial<Record<string, EditorMode>>) {
    if (this._deviceModes === value) return;
    this._deviceModes = value;
    this.host.requestUpdate();
  }

  private _deviceYamlValues: Partial<Record<string, JsonValue>> = {};
  get deviceYamlValues(): Partial<Record<string, JsonValue>> {
    return this._deviceYamlValues;
  }
  set deviceYamlValues(value: Partial<Record<string, JsonValue>>) {
    if (this._deviceYamlValues === value) return;
    this._deviceYamlValues = value;
    this.host.requestUpdate();
  }

  private _deviceYamlErrors: Partial<Record<string, string>> = {};
  get deviceYamlErrors(): Partial<Record<string, string>> {
    return this._deviceYamlErrors;
  }
  set deviceYamlErrors(value: Partial<Record<string, string>>) {
    if (this._deviceYamlErrors === value) return;
    this._deviceYamlErrors = value;
    this.host.requestUpdate();
  }

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

  /** The path key of the device list whose "Add device" picker is open. */
  private _addDeviceTarget: string | null = null;
  get addDeviceTarget(): string | null {
    return this._addDeviceTarget;
  }
  set addDeviceTarget(value: string | null) {
    if (this._addDeviceTarget === value) return;
    this._addDeviceTarget = value;
    this.host.requestUpdate();
  }

  /** The hardware profile picked in the open "Add device" picker; "" is Custom. */
  private _addDeviceProfile = "";
  get addDeviceProfile(): string {
    return this._addDeviceProfile;
  }
  set addDeviceProfile(value: string) {
    if (this._addDeviceProfile === value) return;
    this._addDeviceProfile = value;
    this.host.requestUpdate();
  }

  /** The device a profile add just created, whose card opens on it. */
  private _addedDeviceId: string | null = null;
  get addedDeviceId(): string | null {
    return this._addedDeviceId;
  }
  set addedDeviceId(value: string | null) {
    if (this._addedDeviceId === value) return;
    this._addedDeviceId = value;
    this.host.requestUpdate();
  }

  constructor(public readonly host: HelmanConfigEditorPanel) {
    this.host.addController(this);
  }

  hostConnected(): void {}

  /** Every device's name and icon path, for the shared poll, while the tab is open. */
  extraTargets(): { key: string; path: PathSegment[]; always: boolean }[] {
    if (this.host.activeTab !== "devices") return [];
    return iterDevices(this.host.config).flatMap(({ path }) => deviceIdentityTargets(path));
  }

  /** Resolves once no mounted device card, nested ones included, has an update pending. */
  async deviceCardsRendered(): Promise<void> {
    for (;;) {
      const pending = [
        ...this.host.renderRoot.querySelectorAll<HelmanDeviceEditor>("helman-device-editor"),
      ].filter((editor) => editor.isUpdatePending);
      if (pending.length === 0) return;
      await Promise.all(pending.map((editor) => editor.updateComplete));
    }
  }

  getDeviceMode(path: PathSegment[]): EditorMode {
    return this.deviceModes[entityGroupKey(path)] ?? "visual";
  }

  async enterDeviceYamlMode(path: PathSegment[]): Promise<void> {
    if (this.getDeviceMode(path) === "yaml") return;
    const key = entityGroupKey(path);
    try {
      await loadHaYamlEditor();
      if (!this.host.config) return;
      const value = this.host._getValue(path) as JsonValue;
      this.deviceModes = { ...this.deviceModes, [key]: "yaml" };
      this.deviceYamlValues = { ...this.deviceYamlValues, [key]: value };
      const nextErrors = { ...this.deviceYamlErrors };
      delete nextErrors[key];
      this.deviceYamlErrors = nextErrors;
      this.host.setMessage(null);
      this.host.requestUpdate();
    } catch (error) {
      this.host.setMessage({
        kind: "error",
        text: formatError(error, this.host._t("editor.messages.load_ha_yaml_editor_failed")),
      });
    }
  }

  exitDeviceYamlMode(path: PathSegment[]): void {
    const key = entityGroupKey(path);
    if (this.getDeviceMode(path) !== "yaml" || this.deviceYamlErrors[key]) return;
    const nextModes = { ...this.deviceModes };
    delete nextModes[key];
    const nextValues = { ...this.deviceYamlValues };
    delete nextValues[key];
    const nextErrors = { ...this.deviceYamlErrors };
    delete nextErrors[key];
    this.deviceModes = nextModes;
    this.deviceYamlValues = nextValues;
    this.deviceYamlErrors = nextErrors;
    this.host.requestUpdate();
  }

  moveDevice(listPath: PathSegment[], fromIndex: number, toIndex: number): void {
    this.resetDeviceModes();
    this.host._moveListItem(listPath, fromIndex, toIndex);
  }

  removeDevice(path: PathSegment[]): void {
    this.resetDeviceModes();
    this.host._removeListItem(path.slice(0, -1), path[path.length - 1] as number);
  }

  resetDeviceModes(): void {
    this.addDeviceTarget = null;
    this.deviceModes = {};
    this.deviceYamlValues = {};
    this.deviceYamlErrors = {};
    this.host.requestUpdate();
  }

  clearDescendantDeviceModes(path: PathSegment[]): void {
    const prefix = `${entityGroupKey(path)}.`;
    const keep = <T>(values: Partial<Record<string, T>>): Partial<Record<string, T>> =>
      Object.fromEntries(Object.entries(values).filter(([key]) => !key.startsWith(prefix)));
    this.deviceModes = keep(this.deviceModes);
    this.deviceYamlValues = keep(this.deviceYamlValues);
    this.deviceYamlErrors = keep(this.deviceYamlErrors);
    if (this.addDeviceTarget?.startsWith(prefix)) this.addDeviceTarget = null;
    this.host.requestUpdate();
  }

  handleDeviceYamlChanged(
    path: PathSegment[],
    detail: YamlEditorValueChangedDetail,
  ): void {
    const key = entityGroupKey(path);
    const parsed = parseItemYaml(detail);
    if (!parsed.ok) {
      this.deviceYamlErrors = {
        ...this.deviceYamlErrors,
        [key]: detail.errorMsg ?? this.host._t(parsed.errorKey),
      };
      this.host.requestUpdate();
      return;
    }
    try {
      this.host._applyMutation((draft) => {
        setValueAtPath(draft, path, cloneJson(parsed.value));
      });
      this.clearDescendantDeviceModes(path);
      this.deviceYamlValues = { ...this.deviceYamlValues, [key]: parsed.value };
      const nextErrors = { ...this.deviceYamlErrors };
      delete nextErrors[key];
      this.deviceYamlErrors = nextErrors;
      this.host.requestUpdate();
    } catch (error) {
      this.deviceYamlErrors = {
        ...this.deviceYamlErrors,
        [key]: formatError(error, this.host._t("editor.yaml.errors.apply_failed")),
      };
      this.host.requestUpdate();
    }
  }

  handleDeviceConfigChanged = (event: Event): void => {
    const { path, value } = (event as CustomEvent<DeviceConfigChangedDetail>).detail;
    const before = devicePathSignature(this.host.config);
    this.host._applyMutation((draft) => {
      if (value === undefined) unsetValueAtPath(draft, path);
      else setValueAtPath(draft, path, value);
    });
    if (devicePathSignature(this.host.config) !== before) this.resetDeviceModes();
  };

  deviceMatchesFilter(device: JsonObject): boolean {
    if (this.deviceFilter === "all") return true;
    return (
      isSchedulable(device) === (this.deviceFilter === "schedulable") ||
      deviceChildren(device).some((child) => this.deviceMatchesFilter(child))
    );
  }

  deviceIds(): string[] {
    return iterDevices(this.host.config)
      .map(({ device }) => stringValue(device.id).trim())
      .filter((value) => value.length > 0);
  }

  addProfileDevice(
    path: PathSegment[],
    profile: VendorProfileInfo,
    candidate: NonNullable<VendorProfileInfo["candidates"]>[number],
  ): void {
    const id = uniqueDeviceId(nameSlug(candidate.name) || profile.deviceKind, [
      CONTROLLABLE_ID_INVERTER,
      ...this.deviceIds(),
    ]);
    this.addDeviceTarget = null;
    this.addedDeviceId = id;
    this.host._applyMutation((draft) => {
      appendListItem(draft, path.slice(0, -1), {
        id,
        name: candidate.name,
        kind: profile.deviceKind,
        profile: { id: profile.id, device_id: candidate.deviceId },
      });
      seedDeviceProjection(draft, path);
    });
  }

  addDevice(listPath: PathSegment[], parent: JsonObject | null, rawEntityId: string): void {
    const entityId = rawEntityId.trim();
    if (!entityId) return;
    const domain = entityId.split(".")[0];
    const meterlessIds = parent !== null && domain !== "sensor"
      ? iterDevices(this.host.resolvedConfig())
          .filter((entry) => entry.parent !== null && !ownMeter(entry.device))
          .map((entry) => stringValue(entry.device.id))
      : [];
    const id = deviceIdFor(entityId, [CONTROLLABLE_ID_INVERTER, ...this.deviceIds()], meterlessIds);
    let device: JsonObject;
    if (domain === "sensor" || parent === null) {
      device = { id, consumption: { energy_entity_id: entityId } };
    } else {
      device =
        domain === "climate"
          ? { id, kind: "climate", controls: { climate: { entity_id: entityId } } }
          : { id, controls: { switch: { entity_id: entityId } } };
      if (meterlessChildren(parent).some((sibling) => isSchedulable(sibling))) {
        device.schedulable = true;
        device.consumption = { projection: { ...SEEDED_PROJECTION } };
      }
    }
    this.addDeviceTarget = null;
    this.host._applyMutation((draft) => {
      appendListItem(draft, listPath, device);
    });
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
    this.resetDeviceModes();
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

export function renderDeviceModeToggle(
  host: HelmanConfigEditorPanel,
  controller: DevicesTabController,
  path: PathSegment[],
): TemplateResult {
  return renderItemModeToggle(host, controller.getDeviceMode(path), (mode) => {
    if (mode === "yaml") {
      void controller.enterDeviceYamlMode(path);
    } else {
      controller.exitDeviceYamlMode(path);
    }
  });
}

export function renderDeviceYamlEditor(
  host: HelmanConfigEditorPanel,
  controller: DevicesTabController,
  path: PathSegment[],
): TemplateResult {
  const key = entityGroupKey(path);
  return renderItemYamlEditor(host, {
    id: `device-${key.replaceAll(".", "-")}`,
    value: (controller.deviceYamlValues[key] ?? host._getValue(path)) as JsonValue,
    error: controller.deviceYamlErrors[key],
    onChange: (detail) => controller.handleDeviceYamlChanged(path, detail),
  });
}

export function renderDeviceListActions(
  host: HelmanConfigEditorPanel,
  controller: DevicesTabController,
  path: PathSegment[],
): TemplateResult {
  return html`
    <div class="list-actions" @click=${stopEvent}>
      ${renderDragHandle(host)}
      ${renderDeviceModeToggle(host, controller, path)}
      ${renderRemoveButton(host, {
        onRemove: () => controller.removeDevice(path),
      })}
    </div>
  `;
}

export function renderUnsupportedDevice(
  host: HelmanConfigEditorPanel,
  controller: DevicesTabController,
  device: JsonObject,
  path: PathSegment[],
): TemplateResult {
  const subtitle = host._t("editor.dynamic.unsupported_appliance_kind", {
    kind: stringValue(device.kind) || host._t("editor.values.unknown"),
  });
  return html`
    <details class="list-card device-card" ?hidden=${!controller.deviceMatchesFilter(device)}>
      <summary>
        <div class="appliance-summary-row">
          <div class="appliance-summary-left">
            ${renderDragHandle(host)}
            ${renderSvgIcon(GROUPING_CHEVRON_PATH, "appliance-chevron")}
            <div class="card-title">
              <strong>${deviceName(host, host.inspections.results, device, path)}</strong>
              <span class="card-subtitle">${subtitle}</span>
            </div>
          </div>
          <div class="list-actions" @click=${stopEvent}>
            ${renderRemoveButton(host, {
              onRemove: () => controller.removeDevice(path),
            })}
          </div>
        </div>
      </summary>
      <div class="appliance-body">
        ${renderDeviceIssues(host.validation, deviceIssues(host.validation, path))}
        <pre class="raw-preview">${JSON.stringify(device, null, 2)}</pre>
      </div>
    </details>
  `;
}

export function renderDeviceChildren(
  host: HelmanConfigEditorPanel,
  controller: DevicesTabController,
  device: JsonObject,
  path: PathSegment[],
): TemplateResult | typeof nothing {
  const hasChildren = (asJsonArray(device.children) ?? []).length > 0;
  const canParent = canHaveChildren(device);
  if (!hasChildren && !canParent) return nothing;
  return html`
    ${hasChildren ? renderDeviceList(host, controller, [...path, "children"], device) : nothing}
    ${canParent ? renderAddDevice(host, controller, [...path, "children"], device) : nothing}
  `;
}

export function renderDeviceCard(
  host: HelmanConfigEditorPanel,
  controller: DevicesTabController,
  device: JsonObject,
  path: PathSegment[],
  parent: JsonObject | null,
): TemplateResult {
  return html`
    <helman-device-editor
      ?hidden=${!controller.deviceMatchesFilter(device)}
      .config=${host.config}
      .savedConfig=${host.savedConfig}
      .path=${path}
      .parent=${parent}
      .hass=${host.hass}
      .narrow=${host.narrow ?? false}
      .localize=${(key: string, values?: Record<string, string | number>) => host._t(key, values)}
      .validation=${host.validation}
      .inspections=${host.inspections.results}
      .vendors=${host.vendors}
      .expanded=${controller.addedDeviceId !== null && device.id === controller.addedDeviceId}
      .energyEstimate=${host.trainingTab.deviceEnergyEstimate(
        asJsonObject(getValueAtPath(host.resolvedConfig() ?? {}, path)) ?? device,
      )}
      .listActions=${(devicePath: PathSegment[]) => renderDeviceListActions(host, controller, devicePath)}
      .renderChildren=${(child: JsonObject, childPath: PathSegment[]) =>
        renderDeviceChildren(host, controller, child, childPath)}
      .renderYaml=${(devicePath: PathSegment[]) =>
        controller.getDeviceMode(devicePath) === "yaml" ? renderDeviceYamlEditor(host, controller, devicePath) : null}
      @device-config-changed=${controller.handleDeviceConfigChanged}
    ></helman-device-editor>
  `;
}

export function renderDeviceItem(
  host: HelmanConfigEditorPanel,
  controller: DevicesTabController,
  device: JsonObject,
  path: PathSegment[],
  parent: JsonObject | null,
): TemplateResult {
  const kind = deviceKind(device);
  if (!(EDITABLE_DEVICE_KINDS as readonly string[]).includes(kind)) {
    return renderUnsupportedDevice(host, controller, device, path);
  }
  return renderDeviceCard(host, controller, device, path, parent);
}

export function renderDeviceList(
  host: HelmanConfigEditorPanel,
  controller: DevicesTabController,
  listPath: PathSegment[],
  parent: JsonObject | null,
): TemplateResult {
  return renderSortableList({
    items: asJsonArray(host._getValue(listPath)) ?? [],
    containerClass: "list-stack",
    renderItem: (value, index) =>
      renderDeviceItem(host, controller, asJsonObject(value) ?? {}, [...listPath, index], parent),
    onMove: (oldIndex, newIndex) => controller.moveDevice(listPath, oldIndex, newIndex),
  });
}

export function renderAddProfileDevice(
  host: HelmanConfigEditorPanel,
  controller: DevicesTabController,
  listPath: PathSegment[],
  profile: VendorProfileInfo,
): TemplateResult {
  const newPath = [...listPath, (asJsonArray(host._getValue(listPath)) ?? []).length];
  const candidates = freeCandidates(host, profile, newPath);
  if (candidates.length === 0) {
    return html`
      <div class="vendor-provided-entity unresolved" data-field="vendor-no-devices">
        ${host._t("editor.dynamic.vendor_no_devices", { profile: profile.label })}
      </div>
    `;
  }
  return html`
    <label>${host._t("editor.fields.add_device_vendor_device")}</label>
    <select
      data-field="add-device-vendor-device"
      @change=${(event: Event) => {
        const candidate = candidates.find(
          (option) => option.deviceId === (event.currentTarget as HTMLSelectElement).value,
        );
        if (candidate) controller.addProfileDevice(newPath, profile, candidate);
      }}
    >
      <option value="" selected></option>
      ${candidates.map(
        (candidate) =>
          html`<option value=${candidate.deviceId}>${candidateLabel(candidate)}</option>`,
      )}
    </select>
    <div class="helper">${host._t("editor.helpers.add_device_profile")}</div>
  `;
}

export function renderAddDevice(
  host: HelmanConfigEditorPanel,
  controller: DevicesTabController,
  listPath: PathSegment[],
  parent: JsonObject | null,
  sibling: TemplateResult | typeof nothing = nothing,
): TemplateResult {
  const key = entityGroupKey(listPath);
  const child = parent !== null;
  if (controller.addDeviceTarget !== key) {
    return html`
      <div class="section-footer inline-actions">
        <button
          type="button"
          class="add-button primary add-device"
          @click=${() => {
            controller.addDeviceTarget = key;
            controller.addDeviceProfile = "";
            controller.addedDeviceId = null;
            host.requestUpdate();
          }}
        >
          ${host._t(child ? "editor.actions.add_child_device" : "editor.actions.add_device")}
        </button>
        ${sibling}
      </div>
    `;
  }
  const profiles = (host.vendors?.profiles ?? []).filter(
    (option: VendorProfileInfo) =>
      option.binding === "device" && (EDITABLE_DEVICE_KINDS as readonly string[]).includes(option.deviceKind),
  );
  const profile = profiles.find((option: VendorProfileInfo) => option.id === controller.addDeviceProfile);
  return html`
    <div class="field add-device-picker">
      <label>${host._t("editor.fields.add_device_profile")}</label>
      <select
        data-field="add-device-profile"
        @change=${(event: Event) => {
          controller.addDeviceProfile = (event.currentTarget as HTMLSelectElement).value;
          host.requestUpdate();
        }}
      >
        <option value="" ?selected=${!profile}>${host._t("editor.values.profile_custom")}</option>
        ${profiles.map(
          (option: VendorProfileInfo) => html`<option value=${option.id} ?selected=${option === profile}>${option.label}</option>`,
        )}
      </select>
      ${profile ? renderAddProfileDevice(host, controller, listPath, profile) : html`
        <label>
          ${host._t(child ? "editor.fields.add_child_device_entity" : "editor.fields.add_device_entity")}
        </label>
        <ha-entity-picker
          .hass=${host.hass}
          .includeDomains=${child ? ["sensor", ...SWITCH_CONTROL_DOMAINS, "climate"] : ["sensor"]}
          .entityFilter=${SENSOR_KIND_FILTERS.energy}
          @value-changed=${(event: CustomEvent<{ value?: string }>) =>
            controller.addDevice(listPath, parent, event.detail?.value ?? "")}
        ></ha-entity-picker>
        <div class="helper">
          ${host._t(child ? "editor.helpers.add_child_device" : "editor.helpers.add_device")}
        </div>
      `}
      <div class="section-footer">
        <button
          type="button"
          class="add-button"
          @click=${() => {
            controller.addDeviceTarget = null;
            host.requestUpdate();
          }}
        >
          ${host._t("editor.actions.cancel")}
        </button>
      </div>
    </div>
  `;
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
        controller.resetDeviceModes();
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
        html`<div class="list-actions" @click=${stopEvent}>
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
          ? html`${renderDeviceFilter(host, controller)}${renderDeviceList(host, controller, ["devices", "consumers"], null)}`
          : html`<div class="message info devices-empty">${host._t("editor.empty.no_devices")}</div>`}
        ${renderAddDevice(
          host,
          controller,
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
