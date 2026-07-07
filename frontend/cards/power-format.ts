/**
 * Shared power formatting utilities for helman cards.
 */

export interface FormattedPower {
    value: string;
    unit: string;
    display: string; // combined "X.X kW" or "XXX W"
}

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
