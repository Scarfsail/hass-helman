import type { HomeAssistant } from "../../types/ha";
import { convertToKWh } from "../helman/energy-unit-converter";
import type { TreeItem } from "../shared/data/tree-item";

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
 * The lanes a device's Control tab drives, once each in tree order: its own,
 * and those its meter stands for, as a meter shared by several controllables.
 */
export const deviceControllableIds = (item: TreeItem): string[] => {
    const { controllableIds = [], ownControllableIds = [] } = item;
    return [...new Set([...controllableIds, ...ownControllableIds])];
};
