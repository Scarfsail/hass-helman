export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };
export type PathSegment = string | number;

export interface HomeAssistantLike {
  callWS<T = unknown>(message: Record<string, unknown>): Promise<T>;
  states: Record<string, unknown>;
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
