import { asJsonArray, asJsonObject } from "./config-document";
import type { ApplianceMetadataEntry, ApplianceMetadataResponse, JsonObject } from "./types";

export type SurplusApplianceKind = "generic" | "climate";

export interface SurplusApplianceOption {
  id: string;
  name: string;
  kind: SurplusApplianceKind;
  liveClimateModes: string[] | null;
  selectionDisabled: boolean;
}

export interface SurplusApplianceSelectionState {
  options: SurplusApplianceOption[];
  selectedId: string;
  selectedOption: SurplusApplianceOption | null;
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

export function buildSurplusApplianceSelectionState(
  config: JsonObject | null | undefined,
  liveMetadata: ApplianceMetadataResponse | null | undefined,
  selectedIdRaw: string,
): SurplusApplianceSelectionState {
  const selectedId = selectedIdRaw.trim();
  const liveAppliancesById = _indexLiveAppliances(liveMetadata);
  const options = _readDraftApplianceOptions(config, liveAppliancesById);
  const selectedOption =
    selectedId.length === 0 ? null : options.find((option) => option.id === selectedId) ?? null;

  return {
    options,
    selectedId,
    selectedOption,
    selectedMissingFromDraft: selectedId.length > 0 && selectedOption === null,
  };
}

export function buildSurplusClimateModeFieldState(
  selectionState: SurplusApplianceSelectionState,
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

function _readDraftApplianceOptions(
  config: JsonObject | null | undefined,
  liveAppliancesById: Record<string, ApplianceMetadataEntry>,
): SurplusApplianceOption[] {
  if (!config) {
    return [];
  }

  const appliances = asJsonArray(config.appliances) ?? [];
  const options: SurplusApplianceOption[] = [];
  for (const appliance of appliances) {
    const applianceObject = asJsonObject(appliance);
    if (!applianceObject) {
      continue;
    }

    const applianceId = _readNonEmptyString(applianceObject.id);
    const applianceKind = _readSupportedApplianceKind(applianceObject.kind);
    if (!applianceId || !applianceKind) {
      continue;
    }

    const liveAppliance = liveAppliancesById[applianceId];
    options.push({
      id: applianceId,
      name: _readNonEmptyString(applianceObject.name) || applianceId,
      kind: applianceKind,
      liveClimateModes:
        applianceKind === "climate"
          ? _readLiveClimateModes(liveAppliance, applianceKind)
          : null,
      selectionDisabled:
        applianceKind === "climate"
          ? !_hasLiveClimateModes(liveAppliance, applianceKind)
          : false,
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
  expectedKind: SurplusApplianceKind,
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
  expectedKind: SurplusApplianceKind,
): boolean {
  return (_readLiveClimateModes(liveAppliance, expectedKind) ?? []).length > 0;
}

function _readNonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function _readSupportedApplianceKind(value: unknown): SurplusApplianceKind | null {
  return value === "generic" || value === "climate" ? value : null;
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
