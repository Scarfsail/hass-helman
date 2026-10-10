import type { DataChangedConnection } from "../../helman/data-changed";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };
export type PathSegment = string | number;

export interface HomeAssistantLike {
  callWS<T = unknown>(message: Record<string, unknown>): Promise<T>;
  // Only the events API, and only so the editor can hear that the stored
  // config was saved from somewhere else. Optional because every existing
  // caller predates it.
  connection?: DataChangedConnection | null;
  states: Record<string, unknown>;
  // The entity and device registries, as far as the device editor reads them
  // to say which HA device a helman device's entities belong to.
  entities?: Record<string, { device_id?: string | null }>;
  devices?: Record<string, { name: string | null; name_by_user: string | null }>;
  localize?: (key: string) => string | undefined;
  // Lazily loads a frontend translation fragment (e.g. "config") so reused HA
  // components such as the condition builder show their own localized text.
  loadFragmentTranslation?: (fragment: string) => Promise<unknown>;
  language?: string;
  locale?: {
    language?: string;
  };
}

export interface ValidationIssue {
  section: string;
  path: string;
  code: string;
  message: string;
}

export interface ValidationReport {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface SaveConfigResponse {
  success: boolean;
  validation: ValidationReport;
  reloadStarted: boolean;
  reloadSucceeded?: boolean;
  reloadError?: string | null;
}

export interface StatusMessage {
  kind: "success" | "error" | "info";
  text: string;
}

export interface ApplianceMetadataEntry {
  id: string;
  name: string;
  kind: string;
  metadata?: {
    scheduleCapabilities?: {
      onOffToggle?: boolean;
      modes?: string[];
    };
  };
}

export interface ApplianceMetadataResponse {
  appliances: ApplianceMetadataEntry[];
}

/** One hardware profile, as `helman/get_vendors` serves it. */
export interface VendorProfileInfo {
  id: string;
  label: string;
  deviceKind: string;
  ownedConfigPaths: string[];
  ownedDevicePaths: string[];
  /** The vendor integration's config entries a device can be bound to. */
  entries: { entryId: string; title: string }[];
}

/** What a draft device's profile owns, and what each owned entity resolves to. */
export interface VendorDeviceInfo {
  profile: string;
  ownedConfigPaths: string[];
  ownedDevicePaths: string[];
  /** Absolute path → entity id, a device's owned mode control entity included. */
  resolved: Record<string, string | null>;
}

export interface VendorsResponse {
  profiles: VendorProfileInfo[];
  /** Keyed by the device's validation path, e.g. `devices.system[0]`. */
  devices: Record<string, VendorDeviceInfo>;
}
