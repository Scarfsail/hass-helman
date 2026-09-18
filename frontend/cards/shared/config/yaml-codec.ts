import type { JsonObject, JsonValue } from "./types";

export type YamlNormalizationErrorCode = "non_json_value";

export type YamlNormalizationResult =
  | { ok: true; value: JsonValue }
  | { ok: false; code: YamlNormalizationErrorCode };

const NON_JSON_VALUE_ERROR =
  "YAML must resolve to JSON-compatible scalars, arrays, and objects.";

export function normalizeYamlValue(value: unknown): YamlNormalizationResult {
  try {
    return {
      ok: true,
      value: normalizeValue(value),
    };
  } catch {
    return { ok: false, code: "non_json_value" };
  }
}

function normalizeValue(value: unknown): JsonValue {
  if (value === null) {
    return null;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(NON_JSON_VALUE_ERROR);
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(NON_JSON_VALUE_ERROR);
    }

    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = normalizeValue(item);
    }
    return result;
  }

  throw new Error(NON_JSON_VALUE_ERROR);
}
