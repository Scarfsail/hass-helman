import { html, nothing, type ReactiveController, type TemplateResult } from "lit";
import {
  appendListItem,
  asJsonArray,
  asJsonObject,
  createOptimizerDraft,
  getValueAtPath,
  setValueAtPath,
  unsetValueAtPath,
} from "../../cards/shared/config/config-document";
import {
  booleanValue,
  renderBooleanField,
  renderOptionalNumberField,
  stringValue,
} from "../../cards/shared/config/form-fields";
import {
  renderDragHandle,
  renderRemoveButton,
  renderSortableList,
} from "../../cards/shared/config/sortable-list";
import {
  fetchOptimizerSchema,
  type OptimizerConfigBucket,
  type OptimizerSchema,
  type OptimizerSchemaDocument,
} from "../../cards/shared/optimizer/optimizer-schema";
import {
  buildControllableSelectionState,
  buildClimateModeFieldState,
} from "../../cards/shared/optimizer/controllable-target-ui";
import { callHelman } from "../../cards/shared/data/helman-commands";
import type {
  ApplianceMetadataResponse,
  JsonObject,
  JsonValue,
  PathSegment,
} from "../../cards/shared/config/types";
import type { OptimizerConfigChangedDetail } from "../../cards/shared/optimizer/helman-optimizer-editor";
import "../../cards/shared/optimizer/helman-optimizer-editor";
import { SECTION_SCOPE_IDS } from "../config-editor-scopes";
import type { HelmanConfigEditorPanel } from "../helman-config-editor";
import { preventSummaryToggle } from "./devices";

/** The two config buckets `automation` splits its optimizers into (#271, P1). */
export type OptimizerBucket = OptimizerConfigBucket;

export const APPLIANCE_RUNTIME_OPTIMIZER_KIND = "appliance_runtime";

/**
 * Replace all contents of target with source in place.
 */
export function replaceObjectContents(target: JsonObject, source: JsonObject): void {
  if (target === source) {
    return;
  }
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, source);
}

/**
 * Controller for the Automation tab: optimizer schema, appliance metadata, and optimizer pipeline mutations.
 */
export class AutomationTabController implements ReactiveController {
  private _schema: OptimizerSchemaDocument | null = null;
  get schema(): OptimizerSchemaDocument | null {
    return this._schema;
  }
  set schema(value: OptimizerSchemaDocument | null) {
    if (this._schema === value) return;
    this._schema = value;
    this.host.requestUpdate();
  }

  private _liveApplianceMetadata: ApplianceMetadataResponse | null = null;
  get liveApplianceMetadata(): ApplianceMetadataResponse | null {
    return this._liveApplianceMetadata;
  }
  set liveApplianceMetadata(value: ApplianceMetadataResponse | null) {
    if (this._liveApplianceMetadata === value) return;
    this._liveApplianceMetadata = value;
    this.host.requestUpdate();
  }

  constructor(public readonly host: HelmanConfigEditorPanel) {
    this.host.addController(this);
  }

  hostConnected(): void {}

  async loadOptimizerSchema(): Promise<void> {
    if (!this.host.hass) return;
    this.schema = await fetchOptimizerSchema(this.host.hass);
  }

  async loadLiveApplianceMetadata(): Promise<ApplianceMetadataResponse | null> {
    if (!this.host.hass) return null;
    try {
      const response = await callHelman(
        this.host.hass,
        "helman/get_appliances",
        {},
      );
      const result: ApplianceMetadataResponse = Array.isArray(response?.appliances)
        ? response
        : { appliances: [] };
      this.liveApplianceMetadata = result;
      return result;
    } catch {
      return null;
    }
  }

  normalizeApplianceOptimizerTargets(config: JsonObject): boolean {
    const optimizers =
      asJsonArray(getValueAtPath(config, ["automation", "appliance_optimizers"])) ?? [];
    let changed = false;
    optimizers.forEach((optimizer, index) => {
      const optimizerObject = asJsonObject(optimizer);
      const optimizerKind = stringValue(optimizerObject?.kind);
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
        const applianceId = stringValue(
          getValueAtPath(config, [...targetPath, "controllable_id"]),
        );
        const currentClimateMode = stringValue(
          getValueAtPath(config, [...targetPath, "climate_mode"]),
        );
        const selectionState = buildControllableSelectionState(
          config,
          this.liveApplianceMetadata,
          applianceId,
          this.schema?.kinds.find(
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

  addOptimizer(schema: OptimizerSchema): void {
    const bucket = this.bucketKindOf(schema);
    // Ids are unique across both buckets, not just the one being added to --
    // `config_validation.py`'s `_read_optimizer_buckets` rejects a collision
    // either way, so the draft must not offer one.
    const existingIds = [
      ...(asJsonArray(this.host._getValue(["automation", "appliance_optimizers"])) ?? []),
      ...(asJsonArray(this.host._getValue(["automation", "system_optimizers"])) ?? []),
    ]
      .map((optimizer) => stringValue(asJsonObject(optimizer)?.id))
      .filter((value) => value.length > 0);
    const draftOptimizer = createOptimizerDraft(existingIds, schema.kind, schema.newDraft);
    this.host._applyMutation((draft) => {
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

  handleOptimizerConfigChanged = (event: Event): void => {
    const detail = (event as CustomEvent<OptimizerConfigChangedDetail>).detail;
    if (!detail?.config) {
      return;
    }
    this.host._applyMutation((draft) => {
      replaceObjectContents(draft, detail.config);
    });
  };

  getAutomationEnabled(): boolean {
    const automation = asJsonObject(this.host._getValue(["automation"]));
    if (!automation) {
      return false;
    }
    return booleanValue(automation["enabled"], true);
  }

  setAutomationEnabled(enabled: boolean): void {
    if (!enabled && this.host._getValue(["automation"]) === undefined) {
      return;
    }

    this.host._applyMutation((draft) => {
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

  optimizerOrderingWarning(bucket: OptimizerBucket, index: number): string | null {
    if (!this.host.validation) {
      return null;
    }
    const prefix = `automation.${bucket}[${index}].`;
    const issue = this.host.validation.warnings.find(
      (warning) =>
        warning.code === "required_appliance_planned_later" && warning.path.startsWith(prefix),
    );
    return issue?.message ?? null;
  }

  optimizersInBucket(bucket: OptimizerBucket): JsonValue[] {
    return asJsonArray(this.host._getValue(["automation", bucket])) ?? [];
  }

  bucketKindOf(schema: OptimizerSchema): OptimizerBucket {
    return schema.bucket === "system" ? "system_optimizers" : "appliance_optimizers";
  }
}

export function renderOptimizerEnabledToggle(
  host: HelmanConfigEditorPanel,
  path: PathSegment[],
  enabled: boolean,
): TemplateResult {
  return renderBooleanField(host, path, "editor.fields.optimizer_enabled", false, {
    variant: "summary-toggle",
    explicitValue: enabled,
    onToggleClick: (event: Event) => event.stopPropagation(),
  });
}

export function renderOptimizerListActions(
  host: HelmanConfigEditorPanel,
  _controller: AutomationTabController,
  bucket: OptimizerBucket,
  basePath: PathSegment[],
  index: number,
  enabled: boolean,
): TemplateResult {
  return html`
    <div class="list-actions" @click=${preventSummaryToggle}>
      ${renderDragHandle(host)}
      ${renderOptimizerEnabledToggle(host, [...basePath, "enabled"], enabled)}
      ${renderRemoveButton(host, {
        onRemove: () => host._removeListItem(["automation", bucket], index),
      })}
    </div>
  `;
}

export function renderAutomationEnabledField(
  host: HelmanConfigEditorPanel,
  controller: AutomationTabController,
): TemplateResult {
  const checked = controller.getAutomationEnabled();

  return html`
    <div class="field toggle-field">
      <ha-formfield .label=${host._t("editor.fields.automation_enabled")}>
        <ha-switch
          .checked=${checked}
          @change=${(event: Event) =>
            controller.setAutomationEnabled(
              (event.currentTarget as HTMLElement & { checked: boolean }).checked,
            )}
        ></ha-switch>
      </ha-formfield>
      <div class="helper">${host._t("editor.helpers.automation_enabled")}</div>
    </div>
  `;
}

export function renderOptimizerEditor(
  host: HelmanConfigEditorPanel,
  controller: AutomationTabController,
  bucket: OptimizerBucket,
  index: number,
): TemplateResult {
  return html`
    <helman-optimizer-editor
      .config=${host.config}
      .bucket=${bucket}
      .index=${index}
      .schema=${controller.schema}
      .applianceMetadata=${controller.liveApplianceMetadata}
      .hass=${host.hass}
      .narrow=${host.narrow ?? false}
      .localize=${(key: string, values?: Record<string, string | number>) => host._t(key, values)}
      .warning=${controller.optimizerOrderingWarning(bucket, index)}
      .listActions=${(basePath: PathSegment[], enabled: boolean) =>
        renderOptimizerListActions(host, controller, bucket, basePath, index, enabled)}
      @optimizer-config-changed=${controller.handleOptimizerConfigChanged}
    ></helman-optimizer-editor>
  `;
}

export function renderOptimizerBucketSection(
  host: HelmanConfigEditorPanel,
  controller: AutomationTabController,
  bucket: OptimizerBucket,
): TemplateResult {
  const optimizers = controller.optimizersInBucket(bucket);
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
  const addableKinds = (controller.schema?.kinds ?? []).filter(
    (schema) => controller.bucketKindOf(schema) === bucket,
  );

  return html`
    ${host._renderSectionScope(
      scopeId,
      html`
        <p class="inline-note">${host._t(noteKey)}</p>
        ${renderSortableList({
          items: optimizers,
          containerClass: "list-stack",
          renderItem: (_optimizer, index) => renderOptimizerEditor(host, controller, bucket, index),
          onMove: (oldIndex, newIndex) =>
            host._moveListItem(["automation", bucket], oldIndex, newIndex),
        })}
        ${optimizers.length === 0
          ? html`
              <div class="message info">${host._t(emptyKey)}</div>
            `
          : nothing}
        <div class="section-footer">
          ${addableKinds.map(
            (schema) => html`
              <button
                type="button"
                class="add-button"
                data-add-kind=${schema.kind}
                @click=${() => controller.addOptimizer(schema)}
              >
                ${host._t(`editor.actions.add_${schema.kind}_optimizer`)}
              </button>
            `,
          )}
        </div>
      `,
      { initialOpen: false },
    )}
  `;
}

export function renderAutomationTab(
  host: HelmanConfigEditorPanel,
  controller: AutomationTabController,
): TemplateResult {
  return html`
    ${host._renderSectionScope(
      SECTION_SCOPE_IDS.automation.settings,
      html`
        <p class="inline-note">
          ${host._t("editor.notes.automation")}
        </p>
        <div class="field-grid">
          ${renderAutomationEnabledField(host, controller)}
          ${renderOptionalNumberField(
            host,
            ["automation", "day_context", "deficit_below_ratio"],
            "editor.fields.day_context_deficit_ratio",
            "editor.helpers.day_context_deficit_ratio",
            "editor.help.day_context_deficit_ratio",
            { min: 0 },
          )}
          ${renderOptionalNumberField(
            host,
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

    ${renderOptimizerBucketSection(host, controller, "system_optimizers")}
    ${renderOptimizerBucketSection(host, controller, "appliance_optimizers")}
  `;
}
