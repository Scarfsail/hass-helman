import type { HomeAssistant } from "../../types/ha";

/** Power units a reading converts from, to W; any other is no reading. */
export const WATTS: Record<string, number> = { w: 1, kw: 1000, mw: 1_000_000 };

/**
 * What a power reading multiplies by to be W: a unit-less sensor is W, as on
 * the card; `null` in a unit not known.
 */
export function powerUnitFactor(hass: HomeAssistant, entityId: string | null | undefined): number | null {
    const unit = entityId ? hass.states?.[entityId]?.attributes?.unit_of_measurement as string | undefined : undefined;
    if (unit === "mW") return null;
    return unit ? WATTS[unit.toLowerCase()] ?? null : 1;
}

/** Read live sensor power in W; unknown units and unreadable states have no reading. */
export function readPowerW(hass: HomeAssistant, entityId: string | null | undefined): number | null {
    const state = entityId ? hass.states?.[entityId] : undefined;
    const value = parseFloat(state?.state ?? "");
    const factor = powerUnitFactor(hass, entityId);
    return Number.isFinite(value) && factor !== null ? value * factor : null;
}
