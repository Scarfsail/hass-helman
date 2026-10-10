import type { HaEntityPickerEntityFilterFunc } from "../../../hass-frontend/src/data/entity/entity";
import { asJsonObject } from "../config/config-document";
import { ownMeter } from "../config/devices";
import { stringValue } from "../config/form-fields";
import type { HomeAssistantLike, JsonObject } from "../config/types";

type EntityRegistry = NonNullable<HomeAssistantLike["entities"]>;

/**
 * The one HA device a helman device's entities belong to, or `null`.
 *
 * Entities with no HA device -- helpers, utility meters, entities without a
 * unique id -- are ignored, as the backend suggestions ignore them. Entities
 * under two or more HA devices, or none under any, resolve to nothing.
 */
export function sharedHaDevice(
    hass: Pick<HomeAssistantLike, "entities"> | undefined,
    entityIds: readonly string[],
): string | null {
    const devices = new Set(
        entityIds.map((id) => hass?.entities?.[id]?.device_id).filter((id): id is string => !!id),
    );
    return devices.size === 1 ? [...devices][0] : null;
}

/**
 * The entities suggestions may come from, most telling first; empty when
 * the device names none.
 *
 * The backend uses the first one with an HA device, so a helper meter never
 * blocks them. Only the meters and the control the device switches by
 * qualify: a mode or gear select may belong to another integration's device
 * (evcc, the car, the inverter's battery), whose sensors would then be
 * offered, or auto-filled, as this device's meter.
 */
export function suggestionAnchors(device: JsonObject): string[] {
    const controls = asJsonObject(device.controls) ?? {};
    const entity = (value: unknown) => stringValue(asJsonObject(value)?.entity_id).trim();
    const anchors = [
        ownMeter(device),
        stringValue(asJsonObject(device.consumption)?.power_entity_id).trim(),
        ...["switch", "charge", "climate"].map((key) => entity(controls[key])),
    ].filter(Boolean);
    return [...new Set(anchors)];
}

/**
 * Filters built per entity registry, then per (device, current value).
 *
 * `ha-entity-picker` rebuilds its list whenever the filter's identity changes,
 * and the editor re-renders on every hass update, so a picker must see the same
 * function until something it depends on changes. Keying the outer cache by the
 * registry object keeps each filter reading the registry it was built from:
 * HA replaces `hass.entities` only when the registry changes, which is exactly
 * when a filter has to be rebuilt anyway, and a state update keeps it.
 */
const filterCache = new WeakMap<EntityRegistry, Map<string, HaEntityPickerEntityFilterFunc>>();

/** A picker filter admitting the HA device's entities and the picker's own value. */
export function haDeviceEntityFilter(
    hass: Pick<HomeAssistantLike, "entities"> | undefined,
    deviceId: string,
    currentValue: string,
): HaEntityPickerEntityFilterFunc {
    const entities: EntityRegistry = hass?.entities ?? {};
    let byKey = filterCache.get(entities);
    if (!byKey) {
        byKey = new Map();
        filterCache.set(entities, byKey);
    }
    const key = JSON.stringify([deviceId, currentValue]);
    let filter = byKey.get(key);
    if (!filter) {
        filter = (stateObj) =>
            stateObj.entity_id === currentValue ||
            entities[stateObj.entity_id]?.device_id === deviceId;
        byKey.set(key, filter);
    }
    return filter;
}
