import type { HomeAssistant } from "../../../hass-frontend/src/types";
import { convertToKWh } from "../../helman/energy-unit-converter";

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
