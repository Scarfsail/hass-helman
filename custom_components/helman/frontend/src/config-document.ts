import type { JsonArray, JsonObject, JsonValue, PathSegment } from "./types";

export type RenameObjectKeyResult =
  | { ok: true }
  | {
      ok: false;
      reason: "target_not_available" | "empty_key" | "duplicate_key" | "missing_key";
      key?: string;
    };

export function cloneJson<T extends JsonValue | JsonObject>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asJsonObject(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

export function asJsonArray(value: unknown): JsonArray | undefined {
  return Array.isArray(value) ? (value as JsonArray) : undefined;
}

export function objectEntries(value: unknown): Array<[string, JsonValue]> {
  const record = asJsonObject(value);
  if (!record) {
    return [];
  }
  return Object.entries(record) as Array<[string, JsonValue]>;
}

export function getValueAtPath(
  root: JsonObject,
  path: PathSegment[],
): JsonValue | undefined {
  let current: unknown = root;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[segment];
      continue;
    }

    if (!isJsonObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current as JsonValue | undefined;
}

export function setValueAtPath(
  root: JsonObject,
  path: PathSegment[],
  value: JsonValue,
): void {
  if (path.length === 0) {
    return;
  }

  let current: JsonObject | JsonArray = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    const nextSegment = path[index + 1];
    const shouldCreateArray = typeof nextSegment === "number";

    if (typeof segment === "number") {
      if (!Array.isArray(current)) {
        return;
      }
      let nextValue = current[segment];
      if (shouldCreateArray) {
        if (!Array.isArray(nextValue)) {
          nextValue = [];
          current[segment] = nextValue;
        }
      } else if (!isJsonObject(nextValue)) {
        nextValue = {};
        current[segment] = nextValue;
      }
      current = nextValue as JsonObject | JsonArray;
      continue;
    }

    let nextValue = current[segment];
    if (shouldCreateArray) {
      if (!Array.isArray(nextValue)) {
        nextValue = [];
        current[segment] = nextValue;
      }
    } else if (!isJsonObject(nextValue)) {
      nextValue = {};
      current[segment] = nextValue;
    }
    current = nextValue as JsonObject | JsonArray;
  }

  const lastSegment = path[path.length - 1];
  if (typeof lastSegment === "number") {
    if (!Array.isArray(current)) {
      return;
    }
    current[lastSegment] = value;
    return;
  }

  current[lastSegment] = value;
}

export function unsetValueAtPath(root: JsonObject, path: PathSegment[]): void {
  if (path.length === 0) {
    return;
  }
  removeDirectValue(root, path);
  cleanupEmptyAncestors(root, path.slice(0, -1));
}

export function appendListItem(
  root: JsonObject,
  path: PathSegment[],
  item: JsonValue,
): void {
  const existing = getValueAtPath(root, path);
  const list = Array.isArray(existing) ? existing : [];
  const nextList = [...list, item];
  setValueAtPath(root, path, nextList);
}

export function removeListItem(
  root: JsonObject,
  path: PathSegment[],
  index: number,
): void {
  const existing = getValueAtPath(root, path);
  if (!Array.isArray(existing) || index < 0 || index >= existing.length) {
    return;
  }
  const nextList = existing.filter((_, itemIndex) => itemIndex !== index);
  if (nextList.length === 0) {
    unsetValueAtPath(root, path);
    return;
  }
  setValueAtPath(root, path, nextList);
}

export function moveListItem(
  root: JsonObject,
  path: PathSegment[],
  fromIndex: number,
  toIndex: number,
): void {
  const existing = getValueAtPath(root, path);
  if (
    !Array.isArray(existing) ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= existing.length ||
    toIndex >= existing.length ||
    fromIndex === toIndex
  ) {
    return;
  }

  const nextList = [...existing];
  const [item] = nextList.splice(fromIndex, 1);
  nextList.splice(toIndex, 0, item);
  setValueAtPath(root, path, nextList);
}

export function renameObjectKey(
  root: JsonObject,
  path: PathSegment[],
  oldKey: string,
  newKey: string,
): RenameObjectKeyResult {
  const target = getValueAtPath(root, path);
  if (!isJsonObject(target)) {
    return { ok: false, reason: "target_not_available" };
  }

  const normalizedNewKey = newKey.trim();
  if (!normalizedNewKey) {
    return { ok: false, reason: "empty_key" };
  }
  if (normalizedNewKey === oldKey) {
    return { ok: true };
  }
  if (Object.prototype.hasOwnProperty.call(target, normalizedNewKey)) {
    return { ok: false, reason: "duplicate_key", key: normalizedNewKey };
  }

  const value = target[oldKey];
  if (value === undefined) {
    return { ok: false, reason: "missing_key", key: oldKey };
  }

  const reordered: JsonObject = {};
  for (const [key, item] of Object.entries(target)) {
    if (key === oldKey) {
      reordered[normalizedNewKey] = item as JsonValue;
      continue;
    }
    reordered[key] = item as JsonValue;
  }

  setValueAtPath(root, path, reordered);
  return { ok: true };
}

export function createCategoryKey(existingKeys: string[]): string {
  return createUniqueKey(existingKeys, "category");
}

export function createLabelKey(existingKeys: string[]): string {
  return createUniqueKey(existingKeys, "label");
}

export function createApplianceDraft(
  existingIds: string[],
  applianceName: string,
  vehicleName: string,
): JsonObject {
  const applianceId = createUniqueKey(existingIds, "ev-charger");
  return {
    kind: "ev_charger",
    id: applianceId,
    name: applianceName,
    limits: {
      max_charging_power_kw: 11,
    },
    controls: {
      charge: {
        entity_id: "",
      },
      use_mode: {
        entity_id: "",
        values: {
          Fast: {
            behavior: "fixed_max_power",
          },
          ECO: {
            behavior: "surplus_aware",
          },
        },
      },
      eco_gear: {
        entity_id: "",
        values: {
          "6A": {
            min_power_kw: 1.4,
          },
        },
      },
    },
    vehicles: [createVehicleDraft([], vehicleName)],
  };
}

export function createGenericApplianceDraft(
  existingIds: string[],
  applianceName: string,
): JsonObject {
  const applianceId = createUniqueKey(existingIds, "generic-appliance");
  return {
    kind: "generic",
    id: applianceId,
    name: applianceName,
    controls: {
      switch: {
        entity_id: "",
      },
    },
    projection: {
      strategy: "fixed",
      hourly_energy_kwh: 1,
    },
  };
}

export function createClimateApplianceDraft(
  existingIds: string[],
  applianceName: string,
): JsonObject {
  const applianceId = createUniqueKey(existingIds, "climate-appliance");
  return {
    kind: "climate",
    id: applianceId,
    name: applianceName,
    controls: {
      climate: {
        entity_id: "",
      },
    },
    projection: {
      strategy: "fixed",
      hourly_energy_kwh: 1,
    },
  };
}

export function createExportPriceOptimizerDraft(existingIds: string[]): JsonObject {
  const optimizerId = createUniqueKey(existingIds, "export-price");
  return {
    id: optimizerId,
    kind: "export_price",
    enabled: true,
    params: {
      when_price_below: 0,
      action: "stop_export",
    },
  };
}

export function createSurplusApplianceOptimizerDraft(
  existingIds: string[],
  applianceId = "",
): JsonObject {
  const optimizerId = createUniqueKey(existingIds, "surplus-appliance");
  return {
    id: optimizerId,
    kind: "surplus_appliance",
    enabled: true,
    params: {
      appliance_id: applianceId,
      action: "on",
      min_surplus_buffer_pct: 5,
    },
  };
}

export function createVehicleDraft(existingIds: string[], vehicleName: string): JsonObject {
  const vehicleId = createUniqueKey(existingIds, "vehicle");
  return {
    id: vehicleId,
    name: vehicleName,
    telemetry: {
      soc_entity_id: "",
    },
    limits: {
      battery_capacity_kwh: 64,
      max_charging_power_kw: 11,
    },
  };
}

export function createUseModeEntry(): JsonObject {
  return {
    behavior: "fixed_max_power",
  };
}

export function createEcoGearEntry(): JsonObject {
  return {
    min_power_kw: 1.4,
  };
}

export function createDeferrableConsumerDraft(label: string): JsonObject {
  return {
    energy_entity_id: "",
    label,
  };
}

export function createImportPriceWindowDraft(): JsonObject {
  return {
    start: "00:00",
    end: "06:00",
    price: 1,
  };
}

export function createDailyEnergyEntityDraft(): string {
  return "";
}

export function createModeKey(existingKeys: string[]): string {
  return createUniqueKey(existingKeys, "mode");
}

export function createGearKey(existingKeys: string[]): string {
  return createUniqueKey(existingKeys, "gear");
}

function removeDirectValue(root: JsonObject, path: PathSegment[]): void {
  const parentPath = path.slice(0, -1);
  const parentValue =
    parentPath.length === 0 ? root : getValueAtPath(root, parentPath);
  if (parentValue === undefined) {
    return;
  }

  const key = path[path.length - 1];
  if (typeof key === "number") {
    if (!Array.isArray(parentValue) || key < 0 || key >= parentValue.length) {
      return;
    }
    parentValue.splice(key, 1);
    return;
  }

  if (!isJsonObject(parentValue) || !(key in parentValue)) {
    return;
  }
  delete parentValue[key];
}

function cleanupEmptyAncestors(root: JsonObject, path: PathSegment[]): void {
  for (let length = path.length; length > 0; length -= 1) {
    const currentPath = path.slice(0, length);
    const currentValue = getValueAtPath(root, currentPath);
    const isEmptyObject = isJsonObject(currentValue) && Object.keys(currentValue).length === 0;
    const isEmptyArray = Array.isArray(currentValue) && currentValue.length === 0;
    if (!isEmptyObject && !isEmptyArray) {
      break;
    }
    removeDirectValue(root, currentPath);
  }
}

function createUniqueKey(existingKeys: string[], baseKey: string): string {
  const taken = new Set(existingKeys);
  if (!taken.has(baseKey)) {
    return baseKey;
  }

  let index = 2;
  while (taken.has(`${baseKey}-${index}`)) {
    index += 1;
  }
  return `${baseKey}-${index}`;
}
