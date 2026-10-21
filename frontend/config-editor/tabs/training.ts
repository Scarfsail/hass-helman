import { html, nothing, type ReactiveController, type TemplateResult } from "lit";
import { mdiAlertOutline } from "@mdi/js";
import { LatestRequest } from "../../cards/shared/data/latest-request";
import { callHelman } from "../../cards/shared/data/helman-commands";
import {
  DIAGNOSTICS_ICON,
  SECTION_SCOPE_IDS,
  TAB_ICONS,
  TRAINING_JOB_ICONS,
} from "../config-editor-scopes";
import {
  formatError,
  renderBooleanField,
  renderOptionalNumberField,
  renderOptionalTextField,
  renderSelectFieldWithDefault,
  renderSimpleSection,
  renderSvgIcon,
  stringValue,
} from "../../cards/shared/config/form-fields";
import { configDefaultValue } from "../../cards/shared/config/config-defaults";
import { entityGroupKey, type EntityFact } from "../../cards/shared/config/entity-group";
import { asJsonArray, asJsonObject } from "../../cards/shared/config/config-document";
import {
  deviceKind,
  isCarvedMeterOwner,
  isSchedulable,
  iterDevices,
  ownMeter,
} from "../../cards/shared/config/devices";
import { vendorProvision } from "../../cards/shared/devices/hardware-profile";
import { resolvedDraft } from "../../cards/shared/config/resolved-draft";
import {
  renderDeviceEnergyValue,
  type DeviceEnergyInput,
} from "../../cards/shared/devices/device-energy";
import { trainingDepthCell } from "../../cards/shared/devices/helman-device-editor";
import {
  asTrainingStatus,
  type TrainingJobStatus,
  type TrainingStatus,
  type TrainingStatusChangedDetail,
} from "../training-status";
import "../info-callout";
import {
  INSPECTOR_CARD_TAG,
  INSPECTOR_EMBED_CONFIGS,
  inspectorCardLoader,
  nodeDetailDialogLoader,
  type InspectorEmbed,
  type SolarInspectorCardElement,
} from "../solar-inspector-embed";
import { getSharedHelmanStore } from "../../cards/shared/data/store";
import type { TreeItem } from "../../cards/shared/data/tree-item";
import { hydrateItem } from "../../cards/shared/data/tree-item-hydrator";
import type { JsonObject, PathSegment } from "../../cards/shared/config/types";
import type { HelmanConfigEditorPanel } from "../helman-config-editor";

/**
 * How often the editor re-asks `helman/training/status` while a run is in
 * progress, so the Training tab shows it advancing.
 */
export const TRAINING_RUN_POLL_MS = 15_000;

/** One row of a training tab depth table -- see `renderTrainingDepthTable`. */
export interface TrainingDepthRow {
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
   */
  ownEntity?: boolean;
}

/** One device of the appliance-energy table -- see `renderApplianceEnergyTable`. */
export interface ApplianceEnergyDepthDevice {
  index: number;
  id: string;
  name: string;
  device: JsonObject;
  learns: boolean;
  lookbackDays: number;
  /** Its (effective) meter, sub-meters, power sensor and activity entity. */
  entities: TrainingDepthRow[];
}

/**
 * State controller for the Training tab.
 *
 * Exposes inspection targets to the panel-level EntityInspectionController (`extraTargets`),
 * coordinates training run polling, and manages inspectors and device detail dialog state.
 */
export class TrainingTabController implements ReactiveController {
  private _status: TrainingStatus | null = null;
  get status(): TrainingStatus | null {
    return this._status;
  }
  set status(value: TrainingStatus | null) {
    if (this._status === value) return;
    this._status = value;
    this.host.requestUpdate();
  }

  public inspectorCardLoad?: () => Promise<void>;
  public inspectorRequested: Record<InspectorEmbed, boolean> = { solar: false, house: false };
  public inspectorCard: Partial<Record<InspectorEmbed, SolarInspectorCardElement>> = {};

  private _inspectorCardError: string | null = null;
  get inspectorCardError(): string | null {
    return this._inspectorCardError;
  }
  set inspectorCardError(value: string | null) {
    if (this._inspectorCardError === value) return;
    this._inspectorCardError = value;
    this.host.requestUpdate();
  }

  private _deviceTreeItems: Map<string, TreeItem> | null = null;
  get deviceTreeItems(): Map<string, TreeItem> | null {
    return this._deviceTreeItems;
  }
  set deviceTreeItems(value: Map<string, TreeItem> | null) {
    if (this._deviceTreeItems === value) return;
    this._deviceTreeItems = value;
    this.host.requestUpdate();
  }

  public deviceTreeRequested = false;
  public readonly deviceTreeRequest = new LatestRequest<object>();
  public deviceDetailLoad?: () => Promise<void>;

  private _deviceDetail: TreeItem | null = null;
  get deviceDetail(): TreeItem | null {
    return this._deviceDetail;
  }
  set deviceDetail(value: TreeItem | null) {
    if (this._deviceDetail === value) return;
    this._deviceDetail = value;
    this.host.requestUpdate();
  }

  public trainingRunPoll?: ReturnType<typeof setInterval>;
  public trainingStatusSequence = 0;
  public trainingStatusApplied = 0;

  constructor(public readonly host: HelmanConfigEditorPanel) {
    this.host.addController(this);
  }

  hostConnected(): void {
    this.syncTrainingRunPoll();
  }

  hostDisconnected(): void {
    if (this.trainingRunPoll) {
      clearInterval(this.trainingRunPoll);
      this.trainingRunPoll = undefined;
    }
  }

  hostUpdated(): void {
    this.syncTrainingRunPoll();
  }

  /**
   * Every target the training tab's depth tables need, for the shared poll.
   * Empty when this tab is not active.
   */
  extraTargets(): { key: string; path: PathSegment[]; always: boolean }[] {
    if (this.host.activeTab !== "training") return [];
    const rows = [
      ...this.houseConsumptionDepthRows(),
      ...this.solarBiasDepthRows(),
      ...this.applianceEnergyDepthDevices().flatMap((device) => device.entities),
    ];
    return rows.map((row) => ({
      key: entityGroupKey(row.path),
      path: row.path,
      always: row.ownEntity === true || vendorProvision(this.host.vendors, row.path) !== null,
    }));
  }

  syncTrainingRunPoll(): void {
    const isRunning = this.host.isConnected && this.status?.isRunning === true;
    if (isRunning && !this.trainingRunPoll) {
      this.trainingRunPoll = setInterval(
        () => void this.loadTrainingStatus(),
        TRAINING_RUN_POLL_MS,
      );
    } else if (!isRunning && this.trainingRunPoll) {
      clearInterval(this.trainingRunPoll);
      this.trainingRunPoll = undefined;
    }
  }

  async loadTrainingStatus(): Promise<void> {
    if (!this.host.hass) return;
    const sequence = ++this.trainingStatusSequence;
    try {
      const status = asTrainingStatus(
        await callHelman(this.host.hass, "helman/training/status", {}),
      );
      if (sequence < this.trainingStatusApplied) return;
      this.trainingStatusApplied = sequence;
      if (status) this.status = status;
      this.syncTrainingRunPoll();
      this.host.requestUpdate();
    } catch {
      // A dropped answer keeps the last status on screen.
    }
  }

  handleTrainingStatusChanged = (
    event: CustomEvent<TrainingStatusChangedDetail>,
  ): void => {
    const { status, started } = event.detail;
    if (started) {
      if (!this.status) return;
      this.trainingStatusApplied = ++this.trainingStatusSequence;
      this.status = { ...this.status, isRunning: true };
      this.host.requestUpdate();
    } else if (status) {
      this.trainingStatusApplied = ++this.trainingStatusSequence;
      this.status = status;
      this.host.requestUpdate();
    } else {
      void this.loadTrainingStatus();
    }
  };

  handleInspectorDiagnosticsToggle(embed: InspectorEmbed, open: boolean): void {
    if (!open) return;
    if (!this.inspectorRequested[embed]) {
      this.inspectorRequested[embed] = true;
      this.host.requestUpdate();
    }
    if (this.inspectorCardLoad) return;
    const url = this.host.panel?.config?.card_module_url;
    if (!url) {
      this.inspectorCardError = this.host._t("editor.messages.card_module_url_missing");
      return;
    }
    this.inspectorCardLoad = inspectorCardLoader(url);
    void this.inspectorCardLoad()
      .then(() => {
        this.inspectorCardError = null;
        this.host.requestUpdate();
      })
      .catch((error) => {
        this.inspectorCardError = [
          this.host._t("editor.messages.load_inspector_card_failed"),
          formatError(error, ""),
        ]
          .filter(Boolean)
          .join(" ");
      });
  }

  trainingJob(id: string): TrainingJobStatus | null {
    return this.status?.jobs.find((job) => job.id === id) ?? null;
  }

  houseConsumptionDepthRows(): TrainingDepthRow[] {
    return [
      {
        label: this.host._t("editor.training_depth.house_meter"),
        path: ["energy_nodes", "house", "forecast", "total_energy_entity_id"],
        roleKey: "editor.training_depth.role_house_meter",
      },
      ...iterDevices(this.resolvedConfig()).flatMap(({ device, parent, path }, index): TrainingDepthRow[] => {
        const read =
          isCarvedMeterOwner(device) ||
          (parent !== null && isCarvedMeterOwner(parent) && ownMeter(device) !== "");
        if (!read) return [];
        const name =
          stringValue(device.name) ||
          stringValue(device.id) ||
          `${this.host._t("editor.training_depth.controllable_fallback_name")} ${index + 1}`;
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

  solarBiasDepthRows(): TrainingDepthRow[] {
    return [
      {
        label: this.host._t("editor.training_depth.bias_meter"),
        path: ["training", "solar_bias", "total_energy_entity_id"],
        roleKey: "editor.training_depth.role_bias_meter",
      },
      {
        label: this.host._t("editor.training_depth.forecast_source"),
        path: ["energy_nodes", "solar", "forecast", "daily_energy_entity_ids", 0],
        roleKey: "editor.training_depth.role_forecast_source",
      },
      {
        label: this.host._t("editor.training_depth.forecast_recorded"),
        path: ["helman", "solar_forecast_current"],
        roleKey: "editor.training_depth.role_forecast_recorded",
        ownEntity: true,
      },
      {
        label: this.host._t("editor.training_depth.grid_power"),
        path: ["energy_nodes", "grid", "entities", "power"],
        roleKey: "editor.training_depth.role_grid_power",
      },
      {
        label: this.host._t("editor.training_depth.battery_soc"),
        path: ["energy_nodes", "battery", "entities", "capacity"],
        roleKey: "editor.training_depth.role_battery_soc",
      },
    ];
  }

  applianceEnergyDepthDevices(): ApplianceEnergyDepthDevice[] {
    const items = iterDevices(this.resolvedConfig()).map(({ device, parent, path }, index) => {
      const consumption = asJsonObject(device.consumption) ?? {};
      const controls = asJsonObject(device.controls) ?? {};
      const projection = asJsonObject(consumption.projection) ?? {};
      const kind = deviceKind(device);
      const lookback = projection.lookback_days;
      const drawsFromParent = parent !== null && !ownMeter(device);
      return {
        index,
        id: stringValue(device.id),
        name:
          stringValue(device.name) ||
          stringValue(device.id) ||
          `${this.host._t("editor.training_depth.controllable_fallback_name")} ${index + 1}`,
        path,
        parent: drawsFromParent ? parent : null,
        hasMeter: Boolean(drawsFromParent ? parent && ownMeter(parent) : ownMeter(device)),
        meterPath: [
          ...(drawsFromParent ? path.slice(0, -2) : path),
          "consumption",
          "energy_entity_id",
        ],
        submeterPaths: drawsFromParent
          ? (asJsonArray(parent?.children) ?? []).flatMap((sibling, siblingIndex) => {
              const siblingDevice = asJsonObject(sibling);
              return siblingDevice && ownMeter(siblingDevice)
                ? [[...path.slice(0, -1), siblingIndex, "consumption", "energy_entity_id"]]
                : [];
            })
          : [],
        device,
        powerPath:
          !drawsFromParent && stringValue(consumption.power_entity_id)
            ? [...path, "consumption", "power_entity_id"]
            : null,
        activity:
          (kind === "ev_charger" ? ["switch", "charge", "climate"] : ["switch", "climate"]).find(
            (key) => stringValue(asJsonObject(controls[key])?.entity_id),
          ) ?? null,
        learns: isSchedulable(device) && projection.strategy === "history_average",
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
      if (!item.hasMeter || (item.parent && (!item.id || !item.activity))) return [];
      const days = item.parent
        ? (sharedLookback(item.parent) ?? 30)
        : item.learns
          ? item.lookback
          : 30;
      const entity = (label: string, path: PathSegment[]): TrainingDepthRow => ({
        label: this.host._t(`editor.training_depth.appliance_entity_${label}`),
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

  deviceEnergyEstimate(device: JsonObject): DeviceEnergyInput {
    const job = this.trainingJob("appliance_energy");
    const id = stringValue(device.id);
    const recordKey = this.deviceKey(device);
    const projection = asJsonObject(asJsonObject(device.consumption)?.projection);
    const hourly = projection?.hourly_energy_kwh;
    const projects = isSchedulable(device) && deviceKind(device) !== "ev_charger";
    const estimate = job?.estimates?.[id];
    const adopted = projection?.strategy === "history_average" && typeof estimate === "number";
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
        ? this.host._t("device_energy.failed", { reason: issue.reason })
        : stored || adopted
          ? undefined
          : this.host._t("device_energy.not_trained"),
    };
  }

  trainingDepthInspection(row: TrainingDepthRow) {
    const draft = this.host.inspections.results[entityGroupKey(row.path)]?.draft ?? null;
    const historyFact: EntityFact | undefined = draft?.facts?.find(
      (fact) => fact.id === "history",
    );
    return { draft, historyFact };
  }

  isTrainingDepthRowShort(row: TrainingDepthRow): boolean {
    const { historyFact } = this.trainingDepthInspection(row);
    const available = historyFact?.params?.["available"];
    if (row.requiredDays !== undefined) {
      return typeof available === "number" && available < row.requiredDays;
    }
    return historyFact?.severity === "warn";
  }

  resolvedConfig(): JsonObject | null {
    return resolvedDraft(this.host.config, this.host.vendors);
  }

  deviceKey(device: JsonObject): string {
    return ownMeter(device) || stringValue(device.id);
  }

  deviceTreeKey(device: JsonObject): string {
    return `${ownMeter(device) ? "meter" : "id"}:${this.deviceKey(device)}`;
  }

  treeItemKey(item: TreeItem): string {
    return `${item.deviceKeyIsMeter ? "meter" : "id"}:${item.deviceKey}`;
  }

  savedDeviceUnchanged(device: JsonObject): boolean {
    const key = this.deviceTreeKey(device);
    const id = stringValue(device.id);
    const name = stringValue(device.name);
    return iterDevices(resolvedDraft(this.host.savedConfig, this.host.vendors)).some(
      ({ device: saved }) =>
        this.deviceTreeKey(saved) === key &&
        stringValue(saved.id) === id &&
        stringValue(saved.name) === name,
    );
  }

  async loadDeviceTree(): Promise<void> {
    if (!this.host.hass || !this.host.localizeFunction || !this.host.panel?.config?.card_module_url) {
      this.deviceTreeRequested = false;
      return;
    }
    const request = this.deviceTreeRequest.begin({ hass: this.host.hass });
    if (request === null) return;
    try {
      const payload = await getSharedHelmanStore(this.host.hass).getDeviceTree();
      if (!this.deviceTreeRequest.isCurrent(request)) return;
      const items = new Map<string, TreeItem>();
      const walk = (item: TreeItem): void => {
        if (item.deviceKey) items.set(this.treeItemKey(item), item);
        item.children.forEach(walk);
      };
      for (const dto of [...payload.sources, ...payload.consumers]) {
        walk(hydrateItem(dto, payload.uiConfig.history_buckets, this.host.localizeFunction));
      }
      this.deviceTreeItems = items;
      if (this.deviceDetail) {
        this.deviceDetail = items.get(this.treeItemKey(this.deviceDetail)) ?? null;
      }
    } catch (error) {
      console.error("Helman: failed to load the device tree", error);
      if (!this.deviceTreeRequest.isCurrent(request)) return;
      this.deviceTreeItems = null;
      this.deviceTreeRequested = false;
    }
  }

  async showDeviceDetail(item: TreeItem): Promise<void> {
    const url = this.host.panel?.config?.card_module_url;
    if (!url) return;
    try {
      this.deviceDetailLoad ??= nodeDetailDialogLoader(url);
      await this.deviceDetailLoad();
    } catch (error) {
      this.host.setMessage({
        kind: "error",
        text: [this.host._t("editor.messages.load_device_detail_failed"), formatError(error, "")]
          .filter(Boolean)
          .join(" "),
      });
      return;
    }
    this.deviceDetail = item;
    this.host.requestUpdate();
  }

  closeDeviceDetail(): void {
    this.deviceDetail = null;
    this.host.requestUpdate();
  }
}

export function renderTrainingBadge(
  host: HelmanConfigEditorPanel,
  controller: TrainingTabController,
): TemplateResult | typeof nothing {
  if (!controller.status?.anyFailed) return nothing;
  const failed = controller.status.jobs.filter((job) => job.health === "failed").length;
  return html`<span
    class="tab-warning-dot"
    role="img"
    aria-label=${host._t("training.badge_failed", { count: failed })}
  ></span>`;
}

export function renderInspectorCard(
  host: HelmanConfigEditorPanel,
  controller: TrainingTabController,
  embed: InspectorEmbed,
): TemplateResult | typeof nothing {
  if (!controller.inspectorRequested[embed]) return nothing;
  if (controller.inspectorCardError) {
    return html`<div class="message error">${controller.inspectorCardError}</div>`;
  }
  if (!customElements.get(INSPECTOR_CARD_TAG)) return nothing;
  let card = controller.inspectorCard[embed];
  if (!card) {
    card = document.createElement(INSPECTOR_CARD_TAG) as SolarInspectorCardElement;
    card.setConfig(INSPECTOR_EMBED_CONFIGS[embed]);
    controller.inspectorCard[embed] = card;
  }
  card.hass = host.hass;
  return html`${card}`;
}

export function renderTrainingJobStatus(
  host: HelmanConfigEditorPanel,
  controller: TrainingTabController,
  id: string,
): TemplateResult {
  return html`
    <helman-training-job-status
      data-job=${id}
      .hass=${host.hass}
      .job=${controller.trainingJob(id)}
      .running=${controller.status?.isRunning === true}
      .disabled=${host.dirty}
      @helman-training-status-changed=${controller.handleTrainingStatusChanged}
    ></helman-training-job-status>
  `;
}

export function renderTrainingJobSection(
  host: HelmanConfigEditorPanel,
  controller: TrainingTabController,
  id: keyof typeof TRAINING_JOB_ICONS,
  explanationKey: string,
  configuration: TemplateResult | typeof nothing,
  depthRows: TrainingDepthRow[],
  extraDiagnostics: TemplateResult | typeof nothing = nothing,
  onDiagnosticsToggle?: (open: boolean) => void,
  renderDepthTable: (
    rows: TrainingDepthRow[],
  ) => TemplateResult | typeof nothing = (rows) =>
    renderTrainingDepthTable(host, controller, rows),
): TemplateResult {
  const job = controller.trainingJob(id);
  const hasIssues = (job?.issues.length ?? 0) > 0;
  const needsAttention =
    hasIssues || depthRows.some((row) => controller.isTrainingDepthRowShort(row));
  const hasDiagnostics =
    hasIssues || depthRows.length > 0 || extraDiagnostics !== nothing;
  const attentionLabel = host._t("editor.training_depth.attention");
  return renderSimpleSection(
    host._t(`editor.sections.${id}`),
    html`
      <helman-info-callout
        .hass=${host.hass}
        .text=${host._t(explanationKey)}
      ></helman-info-callout>
      ${renderTrainingJobStatus(host, controller, id)}
      ${configuration}
      ${hasDiagnostics
        ? renderSimpleSection(
            host._t("editor.sections.diagnostics"),
            html`
              <helman-training-issues .hass=${host.hass} .job=${job}></helman-training-issues>
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
                  >${renderSvgIcon(mdiAlertOutline, "training-attention-icon")}</span>`
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
            .hass=${host.hass}
            .job=${job}
          ></helman-training-health-badge>`
        : undefined,
    },
  );
}

function showMoreInfo(host: HelmanConfigEditorPanel, entityId: string): void {
  host.dispatchEvent(
    new CustomEvent("hass-more-info", {
      detail: { entityId },
      bubbles: true,
      composed: true,
    }),
  );
}

function moreInfoLabel(host: HelmanConfigEditorPanel, entityId: string): string {
  const template = host._t("editor.entity_group.more_info_aria");
  return template.includes("{entity}")
    ? host._t("editor.entity_group.more_info_aria", { entity: entityId })
    : `${template} ${entityId}`;
}

export function renderTrainingDepthEntity(
  host: HelmanConfigEditorPanel,
  controller: TrainingTabController,
  row: TrainingDepthRow,
  heading: TemplateResult | typeof nothing,
): TemplateResult {
  const entityId =
    stringValue(host._getValue(row.path)) ||
    stringValue(controller.trainingDepthInspection(row).draft?.entityId);
  return entityId
    ? html`<button
        type="button"
        class="training-depth-entity-button"
        aria-label=${moreInfoLabel(host, entityId)}
        title=${entityId}
        @click=${() => showMoreInfo(host, entityId)}
      >
        ${heading}
        <div class="training-depth-entity-id">${entityId}</div>
      </button>`
    : html`${heading}
        <div class="training-depth-entity-id training-depth-unset">
          ${host._t("editor.training_depth.no_entity")}
        </div>`;
}

export function renderTrainingDepthRow(
  host: HelmanConfigEditorPanel,
  controller: TrainingTabController,
  row: TrainingDepthRow,
): TemplateResult {
  const { historyFact } = controller.trainingDepthInspection(row);
  const rawStates = historyFact?.params?.["raw_states"];
  const statistics = historyFact?.params?.["statistics"];
  return html`
    <tr class=${controller.isTrainingDepthRowShort(row) ? "training-depth-warn" : ""}>
      <td>
        ${renderTrainingDepthEntity(
          host,
          controller,
          row,
          html`<div class="training-depth-label">${row.label}</div>`,
        )}
      </td>
      <td class="training-depth-role">${row.roleKey ? host._t(row.roleKey) : nothing}</td>
      <td class="training-depth-number">${trainingDepthCell(rawStates)}</td>
      <td class="training-depth-number">${trainingDepthCell(statistics)}</td>
    </tr>
  `;
}

export function renderTrainingDepthTable(
  host: HelmanConfigEditorPanel,
  controller: TrainingTabController,
  rows: TrainingDepthRow[],
): TemplateResult | typeof nothing {
  if (rows.length === 0) return nothing;
  return html`
    <div class="training-depth-table-wrap">
      <table class="training-depth-table">
        <thead>
          <tr>
            <th>${host._t("editor.training_depth.column_entity")}</th>
            <th>${host._t("editor.training_depth.column_role")}</th>
            <th class="training-depth-number">
              ${host._t("editor.training_depth.column_raw_states")}
            </th>
            <th class="training-depth-number">
              ${host._t("editor.training_depth.column_statistics")}
            </th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => renderTrainingDepthRow(host, controller, row))}
        </tbody>
      </table>
    </div>
  `;
}

function trainingDepthDays(host: HelmanConfigEditorPanel, value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? host._t("editor.training_depth.days", { days: value })
    : "—";
}

export function renderApplianceEnergyRow(
  host: HelmanConfigEditorPanel,
  controller: TrainingTabController,
  device: ApplianceEnergyDepthDevice,
): TemplateResult {
  const depths = device.entities.map(
    (row) => controller.trainingDepthInspection(row).historyFact?.params?.["available"],
  );
  const known = depths.every((depth) => typeof depth === "number");
  const short = device.entities.some((row) => controller.isTrainingDepthRowShort(row));
  const label = html`<div class="training-depth-label">${device.name}</div>`;
  const item = controller.savedDeviceUnchanged(device.device)
    ? controller.deviceTreeItems?.get(controller.deviceTreeKey(device.device))
    : undefined;
  return html`
    <tr class=${short ? "training-depth-warn" : ""}>
      <td>
        ${item
          ? html`<button
              type="button"
              class="training-depth-entity-button"
              aria-label=${host._t("editor.training_depth.device_detail_aria", {
                device: device.name,
              })}
              @click=${() => void controller.showDeviceDetail(item)}
            >
              ${label}
            </button>`
          : label}
        ${device.entities.map((row) => renderTrainingDepthEntity(host, controller, row, nothing))}
      </td>
      <td class="training-depth-role">
        ${renderDeviceEnergyValue(
          (key) => host._t(`device_energy.${key}`),
          controller.deviceEnergyEstimate(device.device),
        )}
      </td>
      <td class="training-depth-number">
        ${host._t("editor.training_depth.days", { days: device.lookbackDays })}
      </td>
      <td class="training-depth-number">
        <div>${known ? trainingDepthDays(host, Math.min(...(depths as number[]))) : "—"}</div>
        ${device.entities.map(
          (row, index) => html`<div class="training-depth-entity-id">
            ${row.label} ${trainingDepthDays(host, depths[index])}
          </div>`,
        )}
      </td>
    </tr>
  `;
}

export function renderApplianceEnergyTable(
  host: HelmanConfigEditorPanel,
  controller: TrainingTabController,
  devices: ApplianceEnergyDepthDevice[],
): TemplateResult | typeof nothing {
  if (devices.length === 0) return nothing;
  if (!controller.deviceTreeRequested) {
    controller.deviceTreeRequested = true;
    void controller.loadDeviceTree();
  }
  return html`
    <div class="training-depth-table-wrap">
      <table class="training-depth-table">
        <thead>
          <tr>
            <th>${host._t("editor.training_depth.column_device")}</th>
            <th>${host._t("device_energy.label")}</th>
            <th class="training-depth-number">
              ${host._t("editor.training_depth.column_lookback")}
            </th>
            <th class="training-depth-number">
              ${host._t("editor.training_depth.column_history_depth")}
            </th>
          </tr>
        </thead>
        <tbody>
          ${devices.map((device) => renderApplianceEnergyRow(host, controller, device))}
        </tbody>
      </table>
    </div>
    <p class="inline-note">${host._t("editor.training_depth.appliance_table_note")}</p>
  `;
}

export function renderDeviceDetailDialog(
  host: HelmanConfigEditorPanel,
  controller: TrainingTabController,
): TemplateResult | typeof nothing {
  if (!controller.deviceDetail) return nothing;
  return html`
    <node-detail-dialog
      .hass=${host.hass}
      .localize=${host.localizeFunction}
      .open=${true}
      .params=${{ nodeType: "device", item: controller.deviceDetail }}
      @closed=${() => {
        controller.closeDeviceDetail();
      }}
    ></node-detail-dialog>
  `;
}

export function renderTrainingTab(
  host: HelmanConfigEditorPanel,
  controller: TrainingTabController,
): TemplateResult {
  const applianceDevices = controller.applianceEnergyDepthDevices();
  return html`
    ${renderSimpleSection(
      host._t("editor.sections.training_settings"),
      html`
        <helman-info-callout
          .hass=${host.hass}
          .text=${host._t("editor.notes.training_settings_what")}
        ></helman-info-callout>
        <helman-training-status
          .hass=${host.hass}
          .status=${controller.status}
          .disabled=${host.dirty}
          @helman-training-status-changed=${controller.handleTrainingStatusChanged}
        ></helman-training-status>
        ${host._renderSectionScope(
          SECTION_SCOPE_IDS.training.settings,
          html`
            <div class="field-grid">
              ${renderOptionalTextField(
                host,
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

    ${renderTrainingJobSection(
      host,
      controller,
      "solar_bias",
      "editor.notes.training_solar_bias_what",
      host._renderSectionScope(
        SECTION_SCOPE_IDS.training.solar_bias,
        html`
          <helman-info-callout
            .hass=${host.hass}
            .text=${host._t("editor.notes.training_solar_bias")}
          ></helman-info-callout>
          <div class="field-grid">
            ${renderOptionalNumberField(
              host,
              ["training", "solar_bias", "min_history_days"],
              "editor.fields.solar_bias_min_history_days",
              "editor.helpers.solar_bias_min_history_days",
              "editor.help.solar_bias_min_history_days",
            )}
            ${renderOptionalNumberField(
              host,
              ["training", "solar_bias", "max_training_window_days"],
              "editor.fields.solar_bias_max_training_window_days",
              "editor.helpers.solar_bias_max_training_window_days",
              "editor.help.solar_bias_max_training_window_days",
            )}
            ${renderOptionalNumberField(
              host,
              ["training", "solar_bias", "min_valid_slot_days"],
              "editor.fields.solar_bias_min_valid_slot_days",
              "editor.helpers.solar_bias_min_valid_slot_days",
              "editor.help.solar_bias_min_valid_slot_days",
            )}
          </div>
          <p class="inline-note">${host._t("editor.notes.training_solar_bias_min_valid_slot_days")}</p>
          <div class="field-grid">
            ${renderBooleanField(
              host,
              ["training", "solar_bias", "enabled"],
              "editor.fields.bias_correction_enabled",
              configDefaultValue(host.configDefaults, ["training", "solar_bias", "enabled"]) === true,
              "editor.help.bias_correction_enabled",
            )}
            ${renderOptionalNumberField(
              host,
              ["training", "solar_bias", "clamp_min"],
              "editor.fields.bias_correction_clamp_min",
              undefined,
              "editor.help.bias_correction_clamp_min",
            )}
            ${renderOptionalNumberField(
              host,
              ["training", "solar_bias", "clamp_max"],
              "editor.fields.bias_correction_clamp_max",
              undefined,
              "editor.help.bias_correction_clamp_max",
            )}
            ${renderSelectFieldWithDefault(
              host,
              ["training", "solar_bias", "aggregation_method"],
              "editor.fields.bias_correction_aggregation_method",
              [
                {
                  value: "ratio_of_sums",
                  label: host._optionLabel(
                    "editor.fields.bias_correction_aggregation_method_ratio_of_sums",
                    "Ratio of Sums",
                  ),
                },
                {
                  value: "trimmed_mean",
                  label: host._optionLabel(
                    "editor.fields.bias_correction_aggregation_method_trimmed_mean",
                    "Trimmed Mean",
                  ),
                },
              ],
              String(
                configDefaultValue(host.configDefaults, [
                  "training",
                  "solar_bias",
                  "aggregation_method",
                ]) ?? "",
              ),
              "editor.help.bias_correction_aggregation_method",
            )}
            ${renderOptionalNumberField(
              host,
              ["training", "solar_bias", "max_interpolated_consecutive_slots"],
              "editor.fields.bias_correction_max_interpolated_consecutive_slots",
              "editor.helpers.bias_correction_max_interpolated_consecutive_slots",
              "editor.help.bias_correction_max_interpolated_consecutive_slots",
            )}
            ${host._renderEntityGroup(
              ["training", "solar_bias", "total_energy_entity_id"],
              "editor.fields.bias_correction_total_energy_entity",
              {
                includeDomains: ["sensor"],
                sensorKind: "energy",
                helpKey: "editor.help.bias_correction_total_energy_entity",
              },
            )}
          </div>

          ${host._renderSectionScope(
            SECTION_SCOPE_IDS.training.solar_bias_slot_invalidation,
            html`
              <helman-info-callout
                .hass=${host.hass}
                .text=${host._t("editor.notes.training_solar_bias_slot_invalidation")}
              ></helman-info-callout>
              <div class="field-grid">
                ${renderOptionalNumberField(
                  host,
                  ["training", "solar_bias", "slot_invalidation", "max_battery_soc_percent"],
                  "editor.fields.bias_correction_slot_invalidation_max_battery_soc_percent",
                  "editor.helpers.bias_correction_slot_invalidation_max_battery_soc_percent",
                  "editor.help.bias_correction_slot_invalidation_max_battery_soc_percent",
                  { min: 0, max: 100, suffix: "%" },
                )}
                ${renderOptionalNumberField(
                  host,
                  ["training", "solar_bias", "slot_invalidation", "curtailment_max_export_w"],
                  "editor.fields.bias_correction_slot_invalidation_curtailment_max_export_w",
                  "editor.helpers.bias_correction_slot_invalidation_curtailment_max_export_w",
                  "editor.help.bias_correction_slot_invalidation_curtailment_max_export_w",
                  { min: 0, suffix: "W" },
                )}
                ${renderOptionalNumberField(
                  host,
                  [
                    "training",
                    "solar_bias",
                    "slot_invalidation",
                    "curtailment_max_actual_forecast_ratio",
                  ],
                  "editor.fields.bias_correction_slot_invalidation_curtailment_max_actual_forecast_ratio",
                  "editor.helpers.bias_correction_slot_invalidation_curtailment_max_actual_forecast_ratio",
                  "editor.help.bias_correction_slot_invalidation_curtailment_max_actual_forecast_ratio",
                  { min: 0, max: 1 },
                )}
                ${renderOptionalNumberField(
                  host,
                  ["training", "solar_bias", "slot_invalidation", "data_glitch_max_slot_wh"],
                  "editor.fields.bias_correction_slot_invalidation_data_glitch_max_slot_wh",
                  "editor.helpers.bias_correction_slot_invalidation_data_glitch_max_slot_wh",
                  "editor.help.bias_correction_slot_invalidation_data_glitch_max_slot_wh",
                  { min: 0, suffix: "Wh" },
                )}
                ${renderOptionalNumberField(
                  host,
                  [
                    "training",
                    "solar_bias",
                    "slot_invalidation",
                    "data_glitch_min_neighbour_forecast_wh",
                  ],
                  "editor.fields.bias_correction_slot_invalidation_data_glitch_min_neighbour_forecast_wh",
                  "editor.helpers.bias_correction_slot_invalidation_data_glitch_min_neighbour_forecast_wh",
                  "editor.help.bias_correction_slot_invalidation_data_glitch_min_neighbour_forecast_wh",
                  { min: 0, suffix: "Wh" },
                )}
                ${renderOptionalNumberField(
                  host,
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
      controller.solarBiasDepthRows(),
      html`
        <helman-solar-bias-diagnostics
          .hass=${host.hass}
          .job=${controller.trainingJob("solar_bias")}
        ></helman-solar-bias-diagnostics>
        ${renderInspectorCard(host, controller, "solar")}
      `,
      (open) => controller.handleInspectorDiagnosticsToggle("solar", open),
    )}

    ${renderTrainingJobSection(
      host,
      controller,
      "house_consumption",
      "editor.notes.training_house_consumption_what",
      host._renderSectionScope(
        SECTION_SCOPE_IDS.training.house_consumption,
        html`
          <helman-info-callout
            .hass=${host.hass}
            .text=${host._t("editor.notes.training_house_consumption")}
          ></helman-info-callout>
          <div class="field-grid">
            ${renderOptionalNumberField(
              host,
              ["training", "house_consumption", "min_history_days"],
              "editor.fields.house_consumption_min_history_days",
              "editor.helpers.house_consumption_min_history_days",
              "editor.help.house_consumption_min_history_days",
            )}
            ${renderOptionalNumberField(
              host,
              ["training", "house_consumption", "training_window_days"],
              "editor.fields.house_consumption_training_window_days",
              "editor.helpers.house_consumption_training_window_days",
              "editor.help.house_consumption_training_window_days",
            )}
          </div>
        `,
        { initialOpen: false },
      ),
      controller.houseConsumptionDepthRows(),
      html`${renderInspectorCard(host, controller, "house")}`,
      (open) => controller.handleInspectorDiagnosticsToggle("house", open),
    )}

    ${renderTrainingJobSection(
      host,
      controller,
      "appliance_energy",
      "editor.notes.training_appliance_energy",
      nothing,
      applianceDevices.flatMap((device) => device.entities),
      nothing,
      undefined,
      () => renderApplianceEnergyTable(host, controller, applianceDevices),
    )}
  `;
}
