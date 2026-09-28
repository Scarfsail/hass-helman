import { asJsonArray, asJsonObject, getValueAtPath } from "./config-document";
import type { JsonObject, JsonValue, PathSegment } from "./types";

/**
 * The draft's devices, read the way the backend reads them.
 *
 * Mirrors `custom_components/helman/controllables/config.py`: the flat
 * `devices.system` list first, then the `devices.consumers` tree flattened
 * depth first in document order, `kind` defaults to `generic`, and only a
 * device that says `schedulable: true` (or the inverter) may be planned or
 * targeted. Kept to what the editor needs.
 */

/** One device, with its parent and where it sits in the document. */
export interface DeviceEntry {
  device: JsonObject;
  parent: JsonObject | null;
  path: PathSegment[];
}

export function iterDevices(config: JsonObject | null | undefined): DeviceEntry[] {
  const entries: DeviceEntry[] = [];
  const walk = (list: JsonValue | undefined, parent: JsonObject | null, path: PathSegment[]) => {
    (asJsonArray(list) ?? []).forEach((value, index) => {
      const device = asJsonObject(value);
      if (!device) return;
      const devicePath = [...path, index];
      entries.push({ device, parent, path: devicePath });
      walk(device.children, device, [...devicePath, "children"]);
    });
  };
  const devices = asJsonObject(config?.devices);
  // Flat: a system device never nests.
  (asJsonArray(devices?.system) ?? []).forEach((value, index) => {
    const device = asJsonObject(value);
    if (device) entries.push({ device, parent: null, path: ["devices", "system", index] });
  });
  walk(devices?.consumers, null, ["devices", "consumers"]);
  return entries;
}

/** A consumer and its own group in one grouping. */
export interface GroupedDeviceEntry extends DeviceEntry {
  group: string | null;
}

/** The device's own group in `groupingId`, or `undefined`. */
export function ownGroup(device: JsonObject, groupingId: string): string | undefined {
  const own = asJsonObject(device.groups)?.[groupingId];
  return typeof own === "string" && own ? own : undefined;
}

/**
 * Every consumer, in {@link iterDevices} order, with its own group in
 * `groupingId`. Only a direct assignment counts: a child with none is
 * ungrouped, whatever its parent's group. System devices are never grouped,
 * so they are left out.
 */
export function consumerGroups(config: JsonObject | null | undefined, groupingId: string): GroupedDeviceEntry[] {
  return iterDevices(config)
    .filter((entry) => entry.path[1] === "consumers")
    .map((entry) => ({ ...entry, group: ownGroup(entry.device, groupingId) ?? null }));
}

/** Sets or unsets `groups.<groupingId>`, dropping a `groups` map left empty. */
function setOwnGroup(device: JsonObject, groupingId: string, groupId: string | null): void {
  const groups = asJsonObject(device.groups) ?? {};
  if (groupId !== null) groups[groupingId] = groupId;
  else delete groups[groupingId];
  if (Object.keys(groups).length > 0) device.groups = groups;
  else delete device.groups;
}

/**
 * Puts the consumer at `devicePath` into group `groupId` of a grouping, or
 * takes it out (`null`). The one setter behind both the groupings section's
 * drag and drop and the device editor's picker. `false` when that path is no
 * consumer or nothing changes.
 */
export function assignGroup(
  config: JsonObject,
  devicePath: readonly PathSegment[],
  groupingId: string,
  groupId: string | null,
): boolean {
  // A device path ends at its list index; anything deeper is no device.
  const isConsumerPath = devicePath[1] === "consumers" && typeof devicePath[devicePath.length - 1] === "number";
  const device = isConsumerPath ? asJsonObject(getValueAtPath(config, [...devicePath])) : undefined;
  if (!device) return false;
  if ((ownGroup(device, groupingId) ?? null) === groupId) return false;
  setOwnGroup(device, groupingId, groupId);
  return true;
}

/** The Devices tab's filter: every device, or only the schedulable or passive ones. */
export const DEVICE_FILTERS = ["all", "schedulable", "passive"] as const;
export type DeviceFilter = (typeof DEVICE_FILTERS)[number];

export function deviceKind(device: JsonObject): string {
  const kind = device.kind;
  if (kind === undefined) return "generic";
  return typeof kind === "string" ? kind.trim() : "";
}

export function isSchedulable(device: JsonObject): boolean {
  return deviceKind(device) === "inverter" || device.schedulable === true;
}

/** The device's own `consumption.energy_entity_id`, or `""`. */
export function ownMeter(device: JsonObject): string {
  const meter = asJsonObject(device.consumption)?.energy_entity_id;
  return typeof meter === "string" ? meter.trim() : "";
}

export function deviceChildren(device: JsonObject): JsonObject[] {
  return (asJsonArray(device.children) ?? []).flatMap((child) => {
    const object = asJsonObject(child);
    return object ? [object] : [];
  });
}

/** A meter owner's children that draw from its meter rather than their own. */
export function meterlessChildren(device: JsonObject): JsonObject[] {
  return deviceChildren(device).filter((child) => !ownMeter(child));
}

/**
 * Whether this device's meter is carved out of the house baseline — the rule
 * `read_carved_meters` applies: it is schedulable, or it has meterless children
 * and every one of them is schedulable.
 */
export function isCarvedMeterOwner(device: JsonObject): boolean {
  if (!ownMeter(device)) return false;
  if (isSchedulable(device)) return true;
  const meterless = meterlessChildren(device);
  return meterless.length > 0 && meterless.every(isSchedulable);
}

/**
 * Whether a device may hold children: it owns a meter and is not schedulable
 * (a schedulable device is a leaf). What the parent picker offers.
 */
export function canHaveChildren(device: JsonObject): boolean {
  return !!ownMeter(device) && !isSchedulable(device);
}

/**
 * The domains a `controls.switch` entity may use. Mirrors
 * `SWITCH_CONTROL_DOMAINS` in `custom_components/helman/controllables/config.py`.
 */
export const SWITCH_CONTROL_DOMAINS = ["switch", "light"];

/** Whether `controls` names an entity the device is switched by. */
export function hasSwitch(device: JsonObject): boolean {
  const controls = asJsonObject(device.controls) ?? {};
  return ["switch", "charge", "climate"].some((key) => {
    const entityId = asJsonObject(controls[key])?.entity_id;
    return typeof entityId === "string" && entityId.trim().length > 0;
  });
}

/** Lower-case, every other run of characters `_`, trimmed -- as `share_sensor_slug` does. */
const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/**
 * A stable id slugged from `name`: folded to ASCII, then {@link slug}ged, with
 * `_2`, `_3`... on a clash and `fallback` when nothing is left (an emoji-only
 * name). What a new grouping or group gets; generated once and never edited,
 * so a rename changes only the name. Mirrors `_slug_id` in
 * `custom_components/helman/automation/migration.py`.
 */
export function slugId(name: string, taken: Iterable<string>, fallback: string): string {
  const takenIds = new Set(taken);
  const base = slug(name.normalize("NFKD").replace(/[^\x00-\x7f]/g, "")) || fallback;
  let candidate = base;
  for (let suffix = 2; takenIds.has(candidate); suffix += 1) {
    candidate = `${base}_${suffix}`;
  }
  return candidate;
}

/**
 * Drops every device's reference to a grouping, or only to `groupId` of it,
 * and a `groups` map left empty -- so removing a grouping or a group never
 * leaves the draft naming one that is gone.
 */
export function stripGroupReferences(config: JsonObject, groupingId: string, groupId?: string): void {
  for (const { device } of iterDevices(config)) {
    const groups = asJsonObject(device.groups);
    if (!groups || !(groupingId in groups)) continue;
    if (groupId !== undefined && groups[groupingId] !== groupId) continue;
    setOwnGroup(device, groupingId, null);
  }
}

/**
 * The id a device added for `entityId` gets: the entity's object id, or `_2`,
 * `_3`... on a clash. Mirrors `meter_device_id` in
 * `custom_components/helman/controllables/energy_import.py`; generated once and
 * never edited, so a later entity swap keeps schedules and targets.
 */
export function deviceIdFor(
  entityId: string,
  takenIds: Iterable<string>,
  meterlessIds: Iterable<string> = [],
): string {
  const taken = new Set(takenIds);
  // Share sensors normalize punctuation and case, just like share_sensor_slug.
  const takenSlugs = new Set(Array.from(meterlessIds, slug));
  const base = entityId.split(".").slice(1).join(".") || entityId;
  let candidate = base;
  for (let suffix = 2; taken.has(candidate) || takenSlugs.has(slug(candidate)); suffix += 1) {
    candidate = `${base}_${suffix}`;
  }
  return candidate;
}

/**
 * The device a card row names, by the key the device tree carries for it:
 * its `id`, or its own meter. Ids and meters are each unique on their own
 * (`duplicate_meter` in `config_validation.py`) but not across each other,
 * so the caller says which one the key is. `null` when nothing matches.
 */
export function findDeviceByKey(
  config: JsonObject | null | undefined,
  key: string,
  by: "id" | "meter",
): DeviceEntry | null {
  return (
    iterDevices(config).find((entry) => (by === "id" ? entry.device.id : ownMeter(entry.device)) === key) ?? null
  );
}
