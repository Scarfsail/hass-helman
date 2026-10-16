export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };
/** The versioned document stored by Helman. */
export type ConfigDocument = JsonObject & {
  config_version: number;
  energy_nodes?: JsonObject;
  devices?: JsonObject;
  automation?: JsonObject;
};
export interface ConfigSnapshot { config: ConfigDocument; revision: string }
export type PathSegment = string | number;

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
  conflict?: boolean;
  config?: ConfigDocument;
  revision?: string;
  validation?: ValidationReport;
  reloadStarted?: boolean;
  reloadSucceeded?: boolean;
  reloadError?: string | null;
}

export interface StatusMessage {
  kind: "success" | "error" | "info";
  text: string;
}

export type ApplianceMetadataEntry = Pick<import("../../helman-api").ApplianceMetadataDTO, "id" | "name" | "kind" | "metadata">;
export type ApplianceMetadataResponse = Pick<import("../../helman-api").AppliancesPayload, "appliances">;

/** One hardware profile, as `helman/get_vendors` serves it. */
export interface VendorProfileInfo {
  id: string;
  label: string;
  deviceKind: string;
  /** What a device's `profile` names: a config entry, or one HA device. */
  binding: "entry" | "device";
  ownedConfigPaths: string[];
  ownedDevicePaths: string[];
  /** An entry-bound profile's config entries a device can be bound to. */
  entries?: { entryId: string; title: string }[];
  /** A device-bound profile's HA devices: every one it fully resolves on. */
  candidates?: { deviceId: string; name: string; entryTitle: string }[];
}

/** What a draft device's profile owns, and what each owned entity resolves to. */
export interface VendorDeviceInfo {
  profile: string;
  /** The device's stored `profile` the answer was computed for. */
  storedProfile: JsonObject;
  ownedConfigPaths: string[];
  ownedDevicePaths: string[];
  /** Absolute path → entity id, a device's owned mode control entity included. */
  resolved: Record<string, string | null>;
  /** Absolute path → the value the profile fills in, such as a use mode map. */
  values: Record<string, JsonValue>;
  /** The `resolved` paths that are Helman's own entities, which exist only under the profile. */
  helmanEntityPaths: string[];
}

export interface VendorsResponse {
  profiles: VendorProfileInfo[];
  /** Keyed by the device's validation path, e.g. `energy_nodes.inverter`. */
  devices: Record<string, VendorDeviceInfo>;
}
