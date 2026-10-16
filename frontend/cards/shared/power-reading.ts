import type { ValueType } from "../helman-api";
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
    if (!isReadableState(state?.state)) return null;
    const value = parseFloat(state.state);
    const factor = powerUnitFactor(hass, entityId);
    return Number.isFinite(value) && factor !== null ? value * factor : null;
}

/**
 * Applies a ValueType transformation to a raw sensor reading.
 * - "positive": clamps to ≥ 0  (e.g. solar production)
 * - "negative": returns absolute value of the negative part (e.g. battery discharge)
 * - "default":  returns the raw value unchanged
 */
export function applyValueType(raw: number, vt: ValueType): number {
    if (vt === "positive") return Math.max(0, raw);
    if (vt === "negative") return Math.abs(Math.min(0, raw));
    return raw;
}

export function isReadableState(state: string | null | undefined): state is string {
    return state != null && state !== "" && state !== "unknown" && state !== "unavailable";
}

/** Vendor phase readings are shown positive for import/consumption. */
export function phaseSign(polarity: "positive_is_import" | "positive_is_export" | null): number {
    return polarity === "positive_is_export" ? -1 : 1;
}
