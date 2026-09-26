import { asJsonArray, asJsonObject } from "./config-document";
import type { JsonObject, JsonValue, PathSegment } from "./types";

/**
 * The draft's `devices` tree, read the way the backend reads it.
 *
 * Mirrors `custom_components/helman/controllables/config.py`: the tree is
 * flattened depth first in document order, `kind` defaults to `generic`, and
 * only a device that says `schedulable: true` (or the inverter) may be planned
 * or targeted. Kept to what the editor needs until the Devices tab replaces the
 * top-level list.
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
  walk(config?.devices, null, ["devices"]);
  return entries;
}

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

function children(device: JsonObject): JsonObject[] {
  return (asJsonArray(device.children) ?? []).flatMap((child) => {
    const object = asJsonObject(child);
    return object ? [object] : [];
  });
}

/** A meter owner's children that draw from its meter rather than their own. */
export function meterlessChildren(device: JsonObject): JsonObject[] {
  return children(device).filter((child) => !ownMeter(child));
}

/**
 * Whether this device's meter is carved out of the house baseline — the rule
 * `read_carved_meters` applies: it is schedulable, or it has meterless children
 * and every one of them is schedulable.
 */
export function isCarvedMeterOwner(device: JsonObject): boolean {
  if (deviceKind(device) === "inverter" || !ownMeter(device)) return false;
  if (isSchedulable(device)) return true;
  const meterless = meterlessChildren(device);
  return meterless.length > 0 && meterless.every(isSchedulable);
}
