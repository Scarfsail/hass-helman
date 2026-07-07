import {
  cloneJson,
  getValueAtPath,
  isJsonObject,
  setValueAtPath,
  unsetValueAtPath,
} from "./config-document";
import type { JsonObject, JsonValue, PathSegment } from "./types";

export type ScopeRootKind = "object" | "array";

export interface ScopeAdapterValidationError {
  code: "expected_object" | "expected_array" | "unexpected_key";
  key?: string;
}

export interface ScopeProjectionMember {
  yamlKey: string;
  documentPath: PathSegment[];
}

export interface ScopeYamlAdapter {
  read(document: JsonObject): JsonValue;
  apply(document: JsonObject, value: JsonValue): JsonObject;
  validate(value: JsonValue): ScopeAdapterValidationError | null;
}

export function createDocumentScopeAdapter(): ScopeYamlAdapter {
  return {
    read(document) {
      return cloneJson(document);
    },
    apply(_document, value) {
      return cloneJson(value as JsonObject);
    },
    validate(value) {
      return validateRootKind(value, "object");
    },
  };
}

export function createPathScopeAdapter(
  path: PathSegment[],
  options: {
    emptyValue: JsonValue;
    rootKind: ScopeRootKind;
  },
): ScopeYamlAdapter {
  return {
    read(document) {
      const currentValue =
        path.length === 0 ? document : getValueAtPath(document, path);
      if (currentValue === undefined) {
        return cloneJson(options.emptyValue);
      }
      return cloneJson(currentValue);
    },
    apply(document, value) {
      if (path.length === 0) {
        return cloneJson(value as JsonObject);
      }

      const nextDocument = cloneJson(document);
      setValueAtPath(nextDocument, path, cloneJson(value));
      return nextDocument;
    },
    validate(value) {
      return validateRootKind(value, options.rootKind);
    },
  };
}

export function createProjectionScopeAdapter(
  members: readonly ScopeProjectionMember[],
): ScopeYamlAdapter {
  const memberMap = new Map(members.map((member) => [member.yamlKey, member]));

  return {
    read(document) {
      const projection: JsonObject = {};
      for (const member of members) {
        const currentValue = getValueAtPath(document, member.documentPath);
        if (currentValue !== undefined) {
          projection[member.yamlKey] = cloneJson(currentValue);
        }
      }
      return projection;
    },
    apply(document, value) {
      const nextDocument = cloneJson(document);
      const projection = value as JsonObject;

      for (const member of members) {
        unsetValueAtPath(nextDocument, member.documentPath);
      }

      for (const member of members) {
        const nextValue = projection[member.yamlKey];
        if (nextValue !== undefined) {
          setValueAtPath(nextDocument, member.documentPath, cloneJson(nextValue));
        }
      }

      return nextDocument;
    },
    validate(value) {
      const kindError = validateRootKind(value, "object");
      if (kindError) {
        return kindError;
      }

      if (!isJsonObject(value)) {
        return { code: "expected_object" };
      }

      for (const key of Object.keys(value)) {
        if (!memberMap.has(key)) {
          return { code: "unexpected_key", key };
        }
      }

      return null;
    },
  };
}

function validateRootKind(
  value: JsonValue,
  rootKind: ScopeRootKind,
): ScopeAdapterValidationError | null {
  if (rootKind === "array") {
    return Array.isArray(value) ? null : { code: "expected_array" };
  }

  if (!isJsonObject(value)) {
    return { code: "expected_object" };
  }

  return null;
}
