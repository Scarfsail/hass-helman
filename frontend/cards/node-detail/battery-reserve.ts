import type { HomeAssistant } from "../../types/ha";
import type { BatteryDetailPayload } from "../helman-api";
import { readEnergyKWh, readingNumber } from "./node-detail-readings";

/** The usable reserve, from the same capacity and SoC range as the forecast. */
export interface Reserve {
    soc: number;
    remainingKwh: number;
    /** `remaining ÷ SoC`, as `battery_state.read_battery_live_state` computes it. */
    capacityKwh: number;
    minSoc: number | null;
    maxSoc: number | null;
    /** Above the floor, kWh; `null` without a floor. */
    usableKwh: number | null;
    /** Below the ceiling, kWh; `null` without a ceiling. */
    roomKwh: number | null;
}

/**
 * Usable energy above the floor and room below the ceiling, from the live
 * SoC, remaining energy and SoC range with the forecast's own arithmetic:
 * capacity is remaining ÷ SoC, the floor and ceiling are its min and max SoC
 * shares. `null` without a valid SoC and remaining energy.
 *
 * More lenient than the backend's live-state reader on purpose: a bad SoC
 * bound drops that bound, where the backend refuses the whole state, so the
 * reserve still says what it can.
 */
export function readReserve(hass: HomeAssistant, overview: BatteryDetailPayload): Reserve | null {
    const soc = readingNumber(hass, overview.entities.soc);
    // A remaining energy with no or an unknown unit is not guessed at, as in the forecast.
    const remainingKwh = readEnergyKWh(hass, overview.entities.remaining_energy, false);
    if (soc === null || remainingKwh === null || soc <= 0 || soc > 100 || remainingKwh < 0) return null;
    const capacityKwh = remainingKwh / (soc / 100);
    // A zero capacity is a reading that means nothing; the forecast refuses it too.
    if (!(capacityKwh > 0)) return null;
    // Bounds outside 0–100 % or reversed are dropped: no floor or ceiling is
    // shown rather than one that means nothing.
    let minSoc = readingNumber(hass, overview.entities.min_soc);
    let maxSoc = readingNumber(hass, overview.entities.max_soc);
    const valid = (value: number | null) => value !== null && value >= 0 && value <= 100;
    if (!valid(minSoc)) minSoc = null;
    if (!valid(maxSoc)) maxSoc = null;
    if (minSoc !== null && maxSoc !== null && minSoc > maxSoc) minSoc = maxSoc = null;
    return {
        soc,
        remainingKwh,
        capacityKwh,
        minSoc,
        maxSoc,
        usableKwh: minSoc === null ? null : Math.max(0, remainingKwh - capacityKwh * minSoc / 100),
        roomKwh: maxSoc === null ? null : Math.max(0, capacityKwh * maxSoc / 100 - remainingKwh),
    };
}
