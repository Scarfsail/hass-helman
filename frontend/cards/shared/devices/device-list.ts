import {
  html,
  nothing,
  type ReactiveController,
  type ReactiveControllerHost,
  type ReactiveElement,
  type TemplateResult,
} from "lit";
import type { HomeAssistant } from "../../../types/ha";
import type { JsonObject, JsonValue, PathSegment, ValidationReport, VendorProfileInfo, VendorsResponse } from "../config/types";
import type { EntityInspectionResult } from "../config/entity-group";
import { entityGroupKey } from "../config/entity-group";
import { formatError, renderSvgIcon, stringValue } from "../config/form-fields";
import { renderDragHandle, renderRemoveButton, renderSortableList } from "../config/sortable-list";
import {
  parseItemYaml,
  renderItemModeToggle,
  renderItemYamlEditor,
  type YamlEditorValueChangedDetail,
} from "../config/item-yaml";
import { loadHaYamlEditor } from "../load-ha-elements";
import {
  appendListItem,
  asJsonArray,
  asJsonObject,
  cloneJson,
  getValueAtPath,
  moveListItem,
  removeListItem,
  setValueAtPath,
  unsetValueAtPath,
} from "../config/config-document";
import {
  canHaveChildren,
  deviceIdFor,
  deviceKind,
  nameSlug,
  CONTROLLABLE_ID_INVERTER,
  isSchedulable,
  iterDevices,
  meterlessChildren,
  ownMeter,
  SWITCH_CONTROL_DOMAINS,
  uniqueDeviceId,
} from "../config/devices";
import { freeCandidates, candidateLabel } from "./hardware-profile";
import {
  SEEDED_PROJECTION,
  EDITABLE_DEVICE_KINDS,
  deviceIssues,
  deviceName,
  renderDeviceIssues,
  seedDeviceProjection,
  type DeviceConfigChangedDetail,
  type HelmanDeviceEditor,
} from "./helman-device-editor";
import { SENSOR_KIND_FILTERS } from "../config/sensor-kind";
import type { DeviceEnergyInput } from "./device-energy";

type EditorMode = "visual" | "yaml";

/** The document and services supplied by either editing surface. */
export interface DeviceListSource {
  config(): JsonObject | null;
  savedConfig(): JsonObject | null;
  resolvedConfig(): JsonObject | null;
  hass(): HomeAssistant | undefined;
  vendors(): VendorsResponse | null;
  validation(): ValidationReport | null;
  inspections(): Readonly<Record<string, EntityInspectionResult>>;
  t(key: string, values?: Record<string, string | number>): string;
  narrow(): boolean;
  mutate(mutator: (draft: JsonObject) => void): void;
  /** Empty text clears the previous message when the YAML editor loads. */
  reportError(text: string): void;
  deviceVisible?(device: JsonObject): boolean;
  energyEstimate?(device: JsonObject, path: PathSegment[]): DeviceEnergyInput | undefined;
}

/** The chevron of a collapsible card, as the device cards draw it. */
export const GROUPING_CHEVRON_PATH = "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z";

/** Keeps a click on a summary's action row from toggling the card, padding and gaps included. */
export const preventSummaryToggle = (event: Event): void => {
  event.preventDefault();
  event.stopPropagation();
};

/** Which device sits at which path; changes only when an edit moves devices. */
export function devicePathSignature(config: JsonObject | null): string {
  return iterDevices(config)
    .map(({ device, path }) => `${entityGroupKey(path)}=${stringValue(device.id)}`)
    .join("|");
}

/** Shared list state and mutations for the panel and device dialog. */
export class DeviceListController implements ReactiveController {
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

  constructor(public readonly host: ReactiveControllerHost, public readonly source: DeviceListSource) {
    host.addController(this);
  }

  hostConnected(): void {}

  t = (key: string, values?: Record<string, string | number>): string => this.source.t(key, values);

  get hass(): HomeAssistant | undefined {
    return this.source.hass();
  }

  getValue(path: PathSegment[]): unknown {
    return getValueAtPath(this.source.config() ?? {}, path);
  }

  hasYamlErrors(): boolean {
    return Object.values(this.deviceYamlErrors).some((error) => typeof error === "string" && error.length > 0);
  }

  /** Resolves once no mounted device card, nested ones included, has an update pending. */
  async deviceCardsRendered(): Promise<void> {
    for (;;) {
      const pending = [
        ...(this.host as ReactiveElement).renderRoot.querySelectorAll<HelmanDeviceEditor>("helman-device-editor"),
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
      if (!this.source.config()) return;
      const value = this.getValue(path) as JsonValue;
      this.deviceModes = { ...this.deviceModes, [key]: "yaml" };
      this.deviceYamlValues = { ...this.deviceYamlValues, [key]: value };
      const nextErrors = { ...this.deviceYamlErrors };
      delete nextErrors[key];
      this.deviceYamlErrors = nextErrors;
      this.source.reportError("");
      this.host.requestUpdate();
    } catch (error) {
      this.source.reportError(formatError(error, this.t("editor.messages.load_ha_yaml_editor_failed")));
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
    this.source.mutate((draft) => moveListItem(draft, listPath, fromIndex, toIndex));
  }

  removeDevice(path: PathSegment[]): void {
    this.resetDeviceModes();
    this.source.mutate((draft) => removeListItem(draft, path.slice(0, -1), path[path.length - 1] as number));
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
        [key]: detail.errorMsg ?? this.t(parsed.errorKey),
      };
      this.host.requestUpdate();
      return;
    }
    try {
      this.source.mutate((draft) => {
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
        [key]: formatError(error, this.t("editor.yaml.errors.apply_failed")),
      };
      this.host.requestUpdate();
    }
  }

  handleDeviceConfigChanged = (event: Event): void => {
    const { path, value } = (event as CustomEvent<DeviceConfigChangedDetail>).detail;
    const before = devicePathSignature(this.source.config());
    this.source.mutate((draft) => {
      if (value === undefined) unsetValueAtPath(draft, path);
      else setValueAtPath(draft, path, value);
    });
    if (devicePathSignature(this.source.config()) !== before) this.resetDeviceModes();
  };

  deviceIds(): string[] {
    return iterDevices(this.source.config())
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
    this.source.mutate((draft) => {
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
    if (parent !== null && domain === "cover" && meterlessChildren(parent).some((sibling) => isSchedulable(sibling))) {
      return;
    }
    const meterlessIds = parent !== null && domain !== "sensor"
      ? iterDevices(this.source.resolvedConfig())
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
          : domain === "cover"
            ? { id, controls: { cover: { entity_id: entityId } } }
            : { id, controls: { switch: { entity_id: entityId } } };
      if (domain !== "cover" && meterlessChildren(parent).some((sibling) => isSchedulable(sibling))) {
        device.schedulable = true;
        device.consumption = { projection: { ...SEEDED_PROJECTION } };
      }
    }
    this.addDeviceTarget = null;
    this.source.mutate((draft) => {
      appendListItem(draft, listPath, device);
    });
  }
}

export function renderDeviceModeToggle(
  controller: DeviceListController,
  path: PathSegment[],
): TemplateResult {
  return renderItemModeToggle(controller, controller.getDeviceMode(path), (mode) => {
    if (mode === "yaml") {
      void controller.enterDeviceYamlMode(path);
    } else {
      controller.exitDeviceYamlMode(path);
    }
  });
}

export function renderDeviceYamlEditor(
  controller: DeviceListController,
  path: PathSegment[],
): TemplateResult {
  const key = entityGroupKey(path);
  return renderItemYamlEditor(controller, {
    id: `device-${key.replaceAll(".", "-")}`,
    value: (controller.deviceYamlValues[key] ?? controller.getValue(path)) as JsonValue,
    error: controller.deviceYamlErrors[key],
    onChange: (detail) => controller.handleDeviceYamlChanged(path, detail),
  });
}

export function renderDeviceListActions(
  controller: DeviceListController,
  path: PathSegment[],
): TemplateResult {
  return html`
    <div class="list-actions" @click=${preventSummaryToggle}>
      ${renderDragHandle(controller)}
      ${renderDeviceModeToggle(controller, path)}
      ${renderRemoveButton(controller, {
        onRemove: () => controller.removeDevice(path),
      })}
    </div>
  `;
}

export function renderUnsupportedDevice(
  controller: DeviceListController,
  device: JsonObject,
  path: PathSegment[],
): TemplateResult {
  const subtitle = controller.t("editor.dynamic.unsupported_appliance_kind", {
    kind: stringValue(device.kind) || controller.t("editor.values.unknown"),
  });
  return html`
    <details class="list-card device-card" ?hidden=${!(controller.source.deviceVisible?.(device) ?? true)}>
      <summary>
        <div class="appliance-summary-row">
          <div class="appliance-summary-left">
            ${renderDragHandle(controller)}
            ${renderSvgIcon(GROUPING_CHEVRON_PATH, "appliance-chevron")}
            <div class="card-title">
              <strong>${deviceName(controller, controller.source.inspections(), device, path)}</strong>
              <span class="card-subtitle">${subtitle}</span>
            </div>
          </div>
          <div class="list-actions" @click=${preventSummaryToggle}>
            ${renderRemoveButton(controller, {
              onRemove: () => controller.removeDevice(path),
            })}
          </div>
        </div>
      </summary>
      <div class="appliance-body">
        ${renderDeviceIssues(controller.source.validation(), deviceIssues(controller.source.validation(), path))}
        <pre class="raw-preview">${JSON.stringify(device, null, 2)}</pre>
      </div>
    </details>
  `;
}

export function renderDeviceChildren(
  controller: DeviceListController,
  device: JsonObject,
  path: PathSegment[],
): TemplateResult | typeof nothing {
  const hasChildren = (asJsonArray(device.children) ?? []).length > 0;
  const canParent = canHaveChildren(device);
  if (!hasChildren && !canParent) return nothing;
  return html`
    ${hasChildren ? renderDeviceList(controller, [...path, "children"], device) : nothing}
    ${canParent ? renderAddDevice(controller, [...path, "children"], device) : nothing}
  `;
}

export function renderDeviceCard(
  controller: DeviceListController,
  device: JsonObject,
  path: PathSegment[],
  parent: JsonObject | null,
): TemplateResult {
  return html`
    <helman-device-editor
      ?hidden=${!(controller.source.deviceVisible?.(device) ?? true)}
      .config=${controller.source.config()}
      .savedConfig=${controller.source.savedConfig()}
      .path=${path}
      .parent=${parent}
      .hass=${controller.hass}
      .narrow=${controller.source.narrow()}
      .localize=${(key: string, values?: Record<string, string | number>) => controller.t(key, values)}
      .validation=${controller.source.validation()}
      .inspections=${controller.source.inspections()}
      .vendors=${controller.source.vendors()}
      .expanded=${controller.addedDeviceId !== null && device.id === controller.addedDeviceId}
      .energyEstimate=${controller.source.energyEstimate?.(device, path)}
      .listActions=${(devicePath: PathSegment[]) => renderDeviceListActions(controller, devicePath)}
      .renderChildren=${(child: JsonObject, childPath: PathSegment[]) =>
        renderDeviceChildren(controller, child, childPath)}
      .renderYaml=${(devicePath: PathSegment[]) =>
        controller.getDeviceMode(devicePath) === "yaml" ? renderDeviceYamlEditor(controller, devicePath) : null}
      @device-config-changed=${controller.handleDeviceConfigChanged}
    ></helman-device-editor>
  `;
}

export function renderDeviceItem(
  controller: DeviceListController,
  device: JsonObject,
  path: PathSegment[],
  parent: JsonObject | null,
): TemplateResult {
  const kind = deviceKind(device);
  if (!(EDITABLE_DEVICE_KINDS as readonly string[]).includes(kind)) {
    return renderUnsupportedDevice(controller, device, path);
  }
  return renderDeviceCard(controller, device, path, parent);
}

export function renderDeviceList(
  controller: DeviceListController,
  listPath: PathSegment[],
  parent: JsonObject | null,
): TemplateResult {
  return renderSortableList({
    items: asJsonArray(controller.getValue(listPath)) ?? [],
    containerClass: "list-stack",
    renderItem: (value, index) =>
      renderDeviceItem(controller, asJsonObject(value) ?? {}, [...listPath, index], parent),
    onMove: (oldIndex, newIndex) => controller.moveDevice(listPath, oldIndex, newIndex),
  });
}

export function renderAddProfileDevice(
  controller: DeviceListController,
  listPath: PathSegment[],
  profile: VendorProfileInfo,
): TemplateResult {
  const newPath = [...listPath, (asJsonArray(controller.getValue(listPath)) ?? []).length];
  const candidates = freeCandidates(controller, profile, newPath);
  if (candidates.length === 0) {
    return html`
      <div class="vendor-provided-entity unresolved" data-field="vendor-no-devices">
        ${controller.t("editor.dynamic.vendor_no_devices", { profile: profile.label })}
      </div>
    `;
  }
  return html`
    <label>${controller.t("editor.fields.add_device_vendor_device")}</label>
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
    <div class="helper">${controller.t("editor.helpers.add_device_profile")}</div>
  `;
}

export function renderAddDevice(
  controller: DeviceListController,
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
            controller.host.requestUpdate();
          }}
        >
          ${controller.t(child ? "editor.actions.add_child_device" : "editor.actions.add_device")}
        </button>
        ${sibling}
      </div>
    `;
  }
  const profiles = (controller.source.vendors()?.profiles ?? []).filter(
    (option: VendorProfileInfo) =>
      option.binding === "device" && (EDITABLE_DEVICE_KINDS as readonly string[]).includes(option.deviceKind),
  );
  const profile = profiles.find((option: VendorProfileInfo) => option.id === controller.addDeviceProfile);
  return html`
    <div class="field add-device-picker">
      <label>${controller.t("editor.fields.add_device_profile")}</label>
      <select
        data-field="add-device-profile"
        @change=${(event: Event) => {
          controller.addDeviceProfile = (event.currentTarget as HTMLSelectElement).value;
          controller.host.requestUpdate();
        }}
      >
        <option value="" ?selected=${!profile}>${controller.t("editor.values.profile_custom")}</option>
        ${profiles.map(
          (option: VendorProfileInfo) => html`<option value=${option.id} ?selected=${option === profile}>${option.label}</option>`,
        )}
      </select>
      ${profile ? renderAddProfileDevice(controller, listPath, profile) : html`
        <label>
          ${controller.t(child ? "editor.fields.add_child_device_entity" : "editor.fields.add_device_entity")}
        </label>
        <ha-entity-picker
          .hass=${controller.hass}
          .includeDomains=${child
            ? parent !== null && meterlessChildren(parent).some((sibling) => isSchedulable(sibling))
              ? ["sensor", ...SWITCH_CONTROL_DOMAINS, "climate"]
              : ["sensor", ...SWITCH_CONTROL_DOMAINS, "cover", "climate"]
            : ["sensor"]}
          .entityFilter=${SENSOR_KIND_FILTERS.energy}
          @value-changed=${(event: CustomEvent<{ value?: string }>) =>
            controller.addDevice(listPath, parent, event.detail?.value ?? "")}
        ></ha-entity-picker>
        <div class="helper">
          ${controller.t(child ? "editor.helpers.add_child_device" : "editor.helpers.add_device")}
        </div>
      `}
      <div class="section-footer">
        <button
          type="button"
          class="add-button"
          @click=${() => {
            controller.addDeviceTarget = null;
            controller.host.requestUpdate();
          }}
        >
          ${controller.t("editor.actions.cancel")}
        </button>
      </div>
    </div>
  `;
}

