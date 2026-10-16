import { GRID_SURPLUS_DISPLAY_ZERO_THRESHOLD_KWH } from "./schedule/model/grid-surplus-display";

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

/** Named display contexts preserve deliberate gauge and axis precision. */
export type EnergyPrecision = "tile" | "gauge" | "axis";
export type MoneyPrecision = "money" | "axis" | "compact" | "ranking";

export function formatEnergyWh(wh: number, { signed = false, compact = false }: { signed?: boolean; compact?: boolean } = {}): FormattedPower {
    const unit = Math.abs(wh) >= 1000 ? "kWh" : "Wh";
    const value = (signed && wh > 0 ? "+" : "") + (unit === "kWh" ? (wh / 1000).toFixed(1) : wh.toFixed(0));
    return { value, unit, display: `${value}${compact ? "" : " "}${unit}` };
}

export function formatKwh(kwh: number, { precision = "tile" }: { precision?: EnergyPrecision } = {}): string {
    const magnitude = Math.abs(kwh);
    const decimals = precision === "axis" ? 1 : magnitude >= 10 ? 0 : precision === "gauge" || magnitude >= 1 ? 1 : 2;
    return kwh.toFixed(decimals);
}

/** Prices and money use two decimals unless the caller names an axis/compact context. */
export function formatMoney(amount: number, unit: string | null, { precision = "money" }: { precision?: MoneyPrecision } = {}): string {
    const decimals = precision === "axis" || precision === "ranking" ? 1 : precision === "compact" ? (Math.abs(amount) >= 10 ? 0 : 1) : 2;
    return `${amount.toFixed(decimals)}${unit ? " " + unit : ""}`;
}

export function orNa(value: number | null | undefined, fmt: (value: number) => string, naText: string): string {
    return value == null || !Number.isFinite(value) ? naText : fmt(value);
}

export function formatValue(value: number, kind: ValueKind): FormattedPower {
    return kind === "energy" ? formatEnergyWh(value) : formatPower(value);
}

export const ZERO_KWH_DISPLAY_THRESHOLD = GRID_SURPLUS_DISPLAY_ZERO_THRESHOLD_KWH;
export function isZeroKwhDisplayValue(kwh: number): boolean {
    return Math.abs(kwh) < ZERO_KWH_DISPLAY_THRESHOLD;
}
