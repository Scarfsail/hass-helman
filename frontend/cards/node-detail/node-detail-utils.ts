import type { HomeAssistant } from "../../types/ha";
import { convertToKWh } from "../helman/energy-unit-converter";
import type { TreeItem } from "../shared/data/tree-item";
import type { EvChargerDetailPayload } from "../helman-api";
import { readPowerW } from "../shared/power-reading";
import { IDLE_W } from "./live-flows";

type HassState = HomeAssistant["states"][string];

export const readState = (
    hass: HomeAssistant,
    entityId: string | null,
): HassState | null => {
    if (!entityId) return null;
    return hass.states[entityId] ?? null;
};

export const readKWh = (
    hass: HomeAssistant,
    entityId: string | null,
): number | null => {
    const state = readState(hass, entityId);
    if (!state) return null;

    const raw = parseFloat(state.state);
    if (isNaN(raw)) return null;

    return convertToKWh(raw, state.attributes.unit_of_measurement);
};

/**
 * The lanes a device's Schedule tab drives, once each in tree order.
 */
export const deviceControllableIds = (item: TreeItem): string[] => {
    return item.controllableIds ?? [];
};

/** A device's power sensor: none when its configured power sensor is its energy meter. */
export const powerEntity = (item: TreeItem): string | undefined =>
    item.powerSensorId && item.powerSensorId !== item.energyEntityId ? item.powerSensorId : undefined;

/** HA controls on a device. An AC names its climate entity as its switch signal. */
export const deviceDirectControls = (item: TreeItem): { switchEntityId: string | null; climateEntityId: string | null; coverEntityId: string | null } | null => {
    const { switchEntityId, climateEntityId, coverEntityId } = item;
    const switchId = switchEntityId !== climateEntityId ? switchEntityId : null;
    return switchId || climateEntityId || coverEntityId ? { switchEntityId: switchId, climateEntityId, coverEntityId: coverEntityId ?? null } : null;
};

/** The entities a device detail lists: switch, climate, cover, power sensor and energy meter. */
export const deviceEntities = (item: TreeItem): Array<string | null | undefined> => [
    deviceDirectControls(item)?.switchEntityId ?? item.switchEntityId,
    item.climateEntityId,
    item.coverEntityId,
    item.powerSensorId,
    item.energyEntityId,
];

/**
 * The config devices above a device in the house tree, top down: no house, not
 * the device itself. Matched as a refreshed tree remaps an open device, by id
 * and side; `[]` when the device is not in the tree.
 */
export const deviceAncestors = (houseNode: TreeItem | null, item: TreeItem): TreeItem[] => {
    const search = (items: readonly TreeItem[], path: TreeItem[]): TreeItem[] | null => {
        for (const child of items) {
            if (child.id === item.id && child.isSource === item.isSource) return path;
            const found = search(child.children, child.deviceKey ? [...path, child] : path);
            if (found) return found;
        }
        return null;
    };
    return houseNode ? search(houseNode.children, []) ?? [] : [];
};

/**
 * The charger id when the device is one schedulable EV charger, by its
 * configured appliance kind; `null` for any other device.
 */
export const evChargerId = (item: TreeItem): string | null => {
    const ids = item.controllableIds ?? [];
    if (ids.length !== 1) return null;
    return item.applianceKind === "ev_charger" ? ids[0] : null;
};

/** Charging as reported; a Custom charger without a status, by its power. */
export const evCharging = (hass: HomeAssistant, overview: EvChargerDetailPayload): boolean => {
    if (overview.status) return overview.status.kind === "charging";
    if (overview.entities.run_mode) return false;
    const power = readPowerW(hass, overview.entities.power);
    return power !== null && power > IDLE_W;
};
