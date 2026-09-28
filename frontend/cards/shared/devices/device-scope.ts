import type { HaEntityPickerEntityFilterFunc } from "../../../hass-frontend/src/data/entity/entity";
import type { HomeAssistantLike } from "../config/types";

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
