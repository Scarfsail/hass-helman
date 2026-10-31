import { asJsonArray, asJsonObject, getValueAtPath } from "./config-document";
import type { JsonObject, JsonValue, PathSegment } from "./types";

/**
 * The draft's devices, read the way the backend reads them.
 *
 * Mirrors `custom_components/helman/controllables/config.py`: the
 * `devices.consumers` tree flattened depth first in document order, `kind`
 * defaults to `generic`, and only a device that says `schedulable: true` may
 * be planned or targeted. The inverter is no device: it lives at
 * {@link INVERTER_PATH} and is read through {@link findInverter}. Kept to what
 * the editor needs.
 */

/** The inverter's reserved controllable id, and its kind. Mirrors `CONTROLLABLE_ID_INVERTER`. */
export const CONTROLLABLE_ID_INVERTER = "inverter";

/** Where the inverter lives: one mapping, its id and kind implied. */
export const INVERTER_PATH: readonly PathSegment[] = ["energy_nodes", "inverter"];

/**
 * The draft's inverter, or `null` without one. Mirrors `find_inverter_device`:
 * an empty mapping is no inverter.
 */
export function findInverter(config: JsonObject | null | undefined): JsonObject | null {
  const inverter = asJsonObject(config ? getValueAtPath(config, [...INVERTER_PATH]) : undefined);
  return inverter && Object.keys(inverter).length > 0 ? inverter : null;
}

/** A device's document path as validation reports it: `devices.consumers[1].children[0]`. */
export function validationPath(path: readonly PathSegment[]): string {
  return path
    .map((segment, index) =>
      typeof segment === "number" ? `[${segment}]` : index === 0 ? segment : `.${segment}`,
    )
    .join("");
}

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
  walk(asJsonObject(config?.devices)?.consumers, null, ["devices", "consumers"]);
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
 * ungrouped, whatever its parent's group.
 */
export function consumerGroups(config: JsonObject | null | undefined, groupingId: string): GroupedDeviceEntry[] {
  return iterDevices(config).map((entry) => ({ ...entry, group: ownGroup(entry.device, groupingId) ?? null }));
}

/** Sets or unsets `groups.<groupingId>`, dropping a `groups` map left empty. */
function setOwnGroup(device: JsonObject, groupingId: string, groupId: string | null): void {
  const groups = asJsonObject(device.groups) ?? {};
  if (groupId !== null) groups[groupingId] = groupId;
  else delete groups[groupingId];
  if (Object.keys(groups).length > 0) device.groups = groups;
  else delete device.groups;
}

/** The consumer at `devicePath`, or `undefined` when that path is none. */
function consumerAt(config: JsonObject, devicePath: readonly PathSegment[]): JsonObject | undefined {
  // A device path ends at its list index; anything deeper is no device.
  const isConsumerPath = devicePath[1] === "consumers" && typeof devicePath[devicePath.length - 1] === "number";
  return isConsumerPath ? asJsonObject(getValueAtPath(config, [...devicePath])) : undefined;
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
  const device = consumerAt(config, devicePath);
  if (!device) return false;
  if ((ownGroup(device, groupingId) ?? null) === groupId) return false;
  setOwnGroup(device, groupingId, groupId);
  return true;
}

/** The house phases a consumer can be wired to, as `phase` stores them. Mirrors the backend's. */
export const DEVICE_PHASES = ["L1", "L2", "L3", "3ph"] as const;

/** Whether `value` is one of {@link DEVICE_PHASES}. */
export function isDevicePhase(value: unknown): value is (typeof DEVICE_PHASES)[number] {
  return (DEVICE_PHASES as readonly unknown[]).includes(value);
}

/** The device's own house phase, or `undefined`. */
export function ownPhase(device: JsonObject): string | undefined {
  const own = device.phase;
  return typeof own === "string" && own ? own : undefined;
}

/**
 * The consumers whose house phase is the user's choice: every top-level
 * device, and a child whose parent is one of them and wired `3ph`. Under a
 * single-phase or unassigned parent a child is on its parent's phase, so it
 * carries none of its own. The one place this rule lives.
 */
export function phaseAssignableDevices(config: JsonObject | null | undefined): Set<JsonObject> {
  const assignable = new Set<JsonObject>();
  // In document order, so a parent is decided before its children.
  for (const { device, parent } of iterDevices(config)) {
    if (parent === null || (assignable.has(parent) && ownPhase(parent) === "3ph")) assignable.add(device);
  }
  return assignable;
}

/**
 * Every {@link phaseAssignableDevices phase-assignable} consumer, in
 * {@link iterDevices} order, with its own house phase as its `group`. Only a
 * direct assignment counts, as in {@link consumerGroups}.
 */
export function consumerPhases(config: JsonObject | null | undefined): GroupedDeviceEntry[] {
  const assignable = phaseAssignableDevices(config);
  return iterDevices(config)
    .filter((entry) => assignable.has(entry.device))
    .map((entry) => ({ ...entry, group: ownPhase(entry.device) ?? null }));
}

/**
 * Wires the consumer at `devicePath` to `phase`, or unassigns it (`null`).
 * The one setter behind both the House phases card's drag and drop and the
 * device editor's picker. `false` when that path is no consumer, nothing
 * changes, or a phase is set on a device that is not
 * {@link phaseAssignableDevices phase-assignable}; unassigning one still
 * deletes its stale value.
 *
 * Compared against the stored key rather than {@link ownPhase}: an invalid
 * `phase: ""` or `phase: 3` reads as unassigned, yet unassigning must still
 * delete it, or the validation error it raises could never be cleared.
 */
export function assignPhase(config: JsonObject, devicePath: readonly PathSegment[], phase: string | null): boolean {
  const device = consumerAt(config, devicePath);
  if (!device) return false;
  if (phase === null ? !("phase" in device) : device.phase === phase) return false;
  if (phase !== null && !phaseAssignableDevices(config).has(device)) return false;
  if (phase !== null) device.phase = phase;
  else delete device.phase;
  return true;
}

/**
 * Deletes `phase` from every consumer that is not
 * {@link phaseAssignableDevices phase-assignable}, so a saved config never
 * stores wiring that cannot exist. Run at save, not while editing: a parent
 * switched back to `3ph` before saving keeps its children's phases. `true`
 * when anything was deleted.
 */
export function pruneUnassignablePhases(config: JsonObject): boolean {
  const assignable = phaseAssignableDevices(config);
  let changed = false;
  for (const { device } of iterDevices(config)) {
    if (assignable.has(device) || !("phase" in device)) continue;
    delete device.phase;
    changed = true;
  }
  return changed;
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
  return device.schedulable === true;
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
 * What counts as "on" for each switch-control entity: a switch or light is on,
 * a media player is in any state other than "off" / "unavailable" (spelling
 * out Home Assistant's closed MediaPlayerState set, with standby counting as on
 * by decision). Mirrors `SWITCH_ACTIVE_STATES` in
 * `custom_components/helman/controllables/config.py`.
 */
export const SWITCH_ACTIVE_STATES = [
  "on",
  "idle",
  "playing",
  "paused",
  "buffering",
  "standby",
] as const;

/**
 * The domains a `controls.switch` entity may use: a light's on/off state
 * means exactly what a switch's does, and a media player supports turn_on,
 * turn_off and toggle with any non-off state counting as on. Mirrors
 * `SWITCH_CONTROL_DOMAINS` in `custom_components/helman/controllables/config.py`.
 */
export const SWITCH_CONTROL_DOMAINS = ["switch", "light", "media_player"];

/** Whether a switch control's state counts as on. */
export function isSwitchOn(state: string | undefined): boolean {
  if (!state) return false;
  return (SWITCH_ACTIVE_STATES as readonly string[]).includes(state.trim().toLowerCase());
}

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

/** `name` folded to ASCII, then {@link slug}ged; empty when nothing is left. */
export const nameSlug = (name: string) => slug(name.normalize("NFKD").replace(/[^\x00-\x7f]/g, ""));

/**
 * A stable id slugged from `name`: folded to ASCII, then {@link slug}ged, with
 * `_2`, `_3`... on a clash and `fallback` when nothing is left (an emoji-only
 * name). What a new grouping or group gets, and what a typed id is committed
 * as; a rename changes only the name. Mirrors `_slug_id` in
 * `custom_components/helman/automation/migration.py`.
 */
export function slugId(name: string, taken: Iterable<string>, fallback: string): string {
  const takenIds = new Set(taken);
  const base = nameSlug(name) || fallback;
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
 * Moves every device's reference to a grouping over to its new id `newId`,
 * or, with `groupId`, every reference to that group of it -- so an id change
 * never leaves the draft naming one that is gone.
 */
export function renameGroupReferences(config: JsonObject, groupingId: string, newId: string, groupId?: string): void {
  for (const { device } of iterDevices(config)) {
    const groups = asJsonObject(device.groups);
    if (!groups || !(groupingId in groups)) continue;
    if (groupId === undefined) {
      // Rebuilt rather than re-keyed, so the grouping keeps its place in the map.
      device.groups = Object.fromEntries(
        Object.entries(groups).map(([key, value]) => [key === groupingId ? newId : key, value]),
      );
    } else if (groups[groupingId] === groupId) {
      setOwnGroup(device, groupingId, newId);
    }
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
  return uniqueDeviceId(entityId.split(".").slice(1).join(".") || entityId, takenIds, meterlessIds);
}

/**
 * `base` as a new device's id, or `base_2`, `base_3`... on a clash with a
 * taken id or, slugged, with a meterless device's id.
 */
export function uniqueDeviceId(
  base: string,
  takenIds: Iterable<string>,
  meterlessIds: Iterable<string> = [],
): string {
  const taken = new Set(takenIds);
  // Share sensors normalize punctuation and case, just like share_sensor_slug.
  const takenSlugs = new Set(Array.from(meterlessIds, slug));
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
