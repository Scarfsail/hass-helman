import { asJsonObject, canonicalJson, cloneJson, getValueAtPath, setValueAtPath } from "./config-document";
import type { JsonObject, JsonValue, PathSegment, VendorDeviceInfo, VendorsResponse } from "./types";

/**
 * The draft as the backend runs it: every hardware profile's owned entities
 * and values written in.
 *
 * A profile device stores no entity ids, yet its meter is what the editor's
 * structural rules key on -- badges, meterless children, card keys, training
 * depth, the node-detail dialog's lookup. Those reads take their devices from
 * this copy. Edits, YAML and save keep using the stored draft, so an owned
 * key is never written back.
 */

const memo = new WeakMap<JsonObject, WeakMap<VendorsResponse, JsonObject>>();

/**
 * `config` with each `resolved` entity that is not `null` and each `values`
 * entry of `vendors.devices` written in, memoized on the identity of both.
 * The draft itself while there is no answer.
 *
 * A device's entries are written only while the device at that path still
 * stores the very `profile` the answer was computed for, binding included: a
 * stale answer, or one for another document, must not write another device's
 * meter in.
 */
export function resolvedDraft<T extends JsonObject | null | undefined>(
  config: T,
  vendors: VendorsResponse | null | undefined,
): T {
  if (!config || !vendors?.devices || Object.keys(vendors.devices).length === 0) return config;
  let byVendors = memo.get(config);
  if (!byVendors) memo.set(config, (byVendors = new WeakMap()));
  let resolved = byVendors.get(vendors);
  if (!resolved) {
    resolved = cloneJson(config);
    for (const [devicePath, info] of Object.entries(vendors.devices)) {
      const device = asJsonObject(getValueAtPath(config, parseValidationPath(devicePath)));
      if (device && answersFor(info, device)) writeProvided(resolved, info);
    }
    byVendors.set(vendors, resolved);
  }
  return resolved as T;
}

/** Whether `info` was computed for `device` as it now stores its `profile`, binding included. */
export function answersFor(info: VendorDeviceInfo, device: JsonObject): boolean {
  return !!device.profile && canonicalJson(device.profile) === canonicalJson(info.storedProfile);
}

/**
 * Write each `resolved` entity that is not `null` and each `values` entry of
 * one device's answer into `config`, but for the absolute paths in `skip`.
 */
export function writeProvided(config: JsonObject, info: VendorDeviceInfo, skip: readonly string[] = []): void {
  const entries: [string, JsonValue | null][] = [
    ...Object.entries(info.resolved ?? {}),
    ...Object.entries(info.values ?? {}),
  ];
  for (const [path, value] of entries) {
    if (value !== null && !skip.includes(path)) setValueAtPath(config, parseValidationPath(path), cloneJson(value));
  }
}

/** `devices.consumers[1].consumption.energy_entity_id` as path segments. */
function parseValidationPath(path: string): PathSegment[] {
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
}
