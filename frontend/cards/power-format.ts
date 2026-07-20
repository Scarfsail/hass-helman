/**
 * Shared power and energy formatting utilities for helman cards.
 */

export interface FormattedPower {
    value: string;
    unit: string;
    display: string; // combined "X.X kW" or "XXX W"
}

/** What a device box's primary figure means, and so how it is formatted. */
export type ValueKind = "power" | "energy";

/**
 * Formats a watt value for display.
 * - < 1000 W  → "XXX W"
 * - ≥ 1000 W  → "X.X kW"
 */
export function formatPower(watts: number): FormattedPower {
    if (watts >= 1000) {
        const value = (watts / 1000).toFixed(1);
        return { value, unit: "kW", display: `${value} kW` };
    }
    const value = watts.toFixed(0);
    return { value, unit: "W", display: `${value} W` };
}

/**
 * Formats a watt-hour value for display, switching unit on the same threshold
 * `formatPower` does so a box reads the same way whichever it is showing.
 * - < 1000 Wh → "XXX Wh"
 * - ≥ 1000 Wh → "X.X kWh"
 */
export function formatEnergy(wattHours: number): FormattedPower {
    if (Math.abs(wattHours) >= 1000) {
        const value = (wattHours / 1000).toFixed(1);
        return { value, unit: "kWh", display: `${value} kWh` };
    }
    const value = wattHours.toFixed(0);
    return { value, unit: "Wh", display: `${value} Wh` };
}

/** Format a figure according to what it means. */
export function formatValue(value: number, kind: ValueKind): FormattedPower {
    return kind === "energy" ? formatEnergy(value) : formatPower(value);
}
