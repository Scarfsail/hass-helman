import { asJsonArray, asJsonObject } from "../config/config-document";
import type { ApplianceMetadataEntry, ApplianceMetadataResponse, JsonObject } from "../config/types";

/**
 * The optimizer target picker's state, over the draft `controllables` list.
 *
 * Every optimizer kind names what it drives the same way now — by controllable
 * id — so this reads one list and filters it by the kinds the optimizer's spec
 * says it may drive (`OptimizerSchema.controllableKinds`, which the backend
 * derives from `CONTROLLABLE_SPECS`). Filtering here rather than in the
 * renderer is what makes "the picker cannot offer an incompatible target" the
 * same rule as "validation rejects an incompatible target": both read the one
 * declaration.
 *
 * The *draft* list, deliberately: an appliance the user just added must be
 * targetable before they save. Live metadata only supplies what a draft cannot
 * — a climate entity's authorable modes.
 */

/** One option in the target picker. `kind` is the controllable kind. */
export interface ControllableTargetOption {
  id: string;
  name: string;
  kind: string;
  liveClimateModes: string[] | null;
  selectionDisabled: boolean;
}

export interface ControllableSelectionState {
  options: ControllableTargetOption[];
  selectedId: string;
  selectedOption: ControllableTargetOption | null;
  selectedMissingFromDraft: boolean;
}

export interface SurplusClimateModeOption {
  value: string;
  isUnknown: boolean;
}

export interface SurplusClimateModeFieldState {
  visible: boolean;
  disabled: boolean;
  unavailable: boolean;
  value: string;
  options: SurplusClimateModeOption[];
}

export function buildControllableSelectionState(
  config: JsonObject | null | undefined,
  liveMetadata: ApplianceMetadataResponse | null | undefined,
  selectedIdRaw: string,
  allowedKinds: readonly string[],
): ControllableSelectionState {
  const selectedId = selectedIdRaw.trim();
  const liveAppliancesById = _indexLiveAppliances(liveMetadata);
  const options = _readDraftControllableOptions(config, liveAppliancesById, allowedKinds);
  const selectedOption =
    selectedId.length === 0 ? null : options.find((option) => option.id === selectedId) ?? null;

  return {
    options,
    selectedId,
    selectedOption,
    selectedMissingFromDraft: selectedId.length > 0 && selectedOption === null,
  };
}

export function buildClimateModeFieldState(
  selectionState: ControllableSelectionState,
  currentClimateModeRaw: string,
): SurplusClimateModeFieldState {
  const currentClimateMode = currentClimateModeRaw.trim();
  if (selectionState.selectedOption?.kind !== "climate") {
    return {
      visible: false,
      disabled: true,
      unavailable: false,
      value: currentClimateMode,
      options: [],
    };
  }

  const liveClimateModes = selectionState.selectedOption.liveClimateModes;
  if (!liveClimateModes || liveClimateModes.length === 0) {
    return {
      visible: true,
      disabled: true,
      unavailable: true,
      value: currentClimateMode,
      options:
        currentClimateMode.length === 0
          ? []
          : [{ value: currentClimateMode, isUnknown: false }],
    };
  }

  const options: SurplusClimateModeOption[] = liveClimateModes.map((mode) => ({
    value: mode,
    isUnknown: false,
  }));
  if (
    currentClimateMode.length > 0 &&
    !liveClimateModes.includes(currentClimateMode)
  ) {
    options.unshift({ value: currentClimateMode, isUnknown: true });
  }

  return {
    visible: true,
    disabled: options.length === 1 && !options[0]?.isUnknown,
    unavailable: false,
    value: currentClimateMode.length > 0 ? currentClimateMode : options[0]?.value ?? "",
    options,
  };
}

function _readDraftControllableOptions(
  config: JsonObject | null | undefined,
  liveAppliancesById: Record<string, ApplianceMetadataEntry>,
  allowedKinds: readonly string[],
): ControllableTargetOption[] {
  if (!config) {
    return [];
  }

  const controllables = asJsonArray(config.controllables) ?? [];
  const options: ControllableTargetOption[] = [];
  for (const controllable of controllables) {
    const controllableObject = asJsonObject(controllable);
    if (!controllableObject) {
      continue;
    }

    const controllableId = _readNonEmptyString(controllableObject.id);
    const kind = _readNonEmptyString(controllableObject.kind);
    if (!controllableId || !allowedKinds.includes(kind)) {
      continue;
    }

    const liveAppliance = liveAppliancesById[controllableId];
    options.push({
      id: controllableId,
      name: _readNonEmptyString(controllableObject.name) || controllableId,
      kind,
      liveClimateModes:
        kind === "climate" ? _readLiveClimateModes(liveAppliance, kind) : null,
      selectionDisabled:
        kind === "climate" ? !_hasLiveClimateModes(liveAppliance, kind) : false,
    });
  }

  return options;
}

function _indexLiveAppliances(
  liveMetadata: ApplianceMetadataResponse | null | undefined,
): Record<string, ApplianceMetadataEntry> {
  const entries = Array.isArray(liveMetadata?.appliances) ? liveMetadata.appliances : [];
  const indexed: Record<string, ApplianceMetadataEntry> = {};
  for (const entry of entries) {
    if (!_isApplianceMetadataEntry(entry)) {
      continue;
    }
    indexed[entry.id] = entry;
  }
  return indexed;
}

function _readLiveClimateModes(
  liveAppliance: ApplianceMetadataEntry | undefined,
  expectedKind: string,
): string[] | null {
  if (!liveAppliance || liveAppliance.kind !== expectedKind) {
    return null;
  }

  const modes = liveAppliance.metadata?.scheduleCapabilities?.modes;
  if (!Array.isArray(modes)) {
    return null;
  }

  return modes.filter((mode): mode is string => typeof mode === "string" && mode.length > 0);
}

function _hasLiveClimateModes(
  liveAppliance: ApplianceMetadataEntry | undefined,
  expectedKind: string,
): boolean {
  return (_readLiveClimateModes(liveAppliance, expectedKind) ?? []).length > 0;
}

function _readNonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function _isApplianceMetadataEntry(value: unknown): value is ApplianceMetadataEntry {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as ApplianceMetadataEntry).id === "string" &&
      typeof (value as ApplianceMetadataEntry).name === "string" &&
      typeof (value as ApplianceMetadataEntry).kind === "string",
  );
}
