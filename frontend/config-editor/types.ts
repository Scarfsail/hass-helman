export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };
export type PathSegment = string | number;

export interface HomeAssistantLike {
  callWS<T = unknown>(message: Record<string, unknown>): Promise<T>;
  states: Record<string, unknown>;
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
