import { GRID_SURPLUS_DISPLAY_ZERO_THRESHOLD_KWH } from "./schedule/model/grid-surplus-display";

/**
 * How the schedule's forecast numbers are written wherever they are shown.
 *
 * These started out private to the schedule table and moved here when the solar
 * inspector's day pills began drawing the same gauges: two places writing the
 * same kWh two ways would read as two different numbers.
 */

export const ZERO_KWH_DISPLAY_THRESHOLD = GRID_SURPLUS_DISPLAY_ZERO_THRESHOLD_KWH;

/** Solar day/slot energy as bare kWh — whole numbers from 10 kWh up. */
export function formatSolarGaugeValue(wh: number): string {
    const kwh = wh / 1000;
    return kwh >= 10 ? `${Math.round(kwh)}` : `${kwh.toFixed(1)}`;
}

export function formatSolarGaugeTitle(wh: number): string {
    return `${formatSolarGaugeValue(wh)} kWh`;
}

export function isZeroKwhDisplayValue(kwh: number): boolean {
    return Math.abs(kwh) < ZERO_KWH_DISPLAY_THRESHOLD;
}

/** Magnitude only: the sign is carried by which side of a gauge the value sits on. */
export function formatKwhValue(kwh: number): string {
    const absKwh = Math.abs(kwh);
    if (absKwh >= 10) {
        return absKwh.toFixed(0);
    }

    if (absKwh >= 1) {
        return absKwh.toFixed(1);
    }

    return absKwh.toFixed(2);
}

export function formatGridEnergy(kwh: number): string {
    return `${formatKwhValue(kwh)} kWh`;
}

export function formatPositiveGridDisplayValue(kwh: number): string {
    return `+${formatKwhValue(kwh)}`;
}

export function formatVisiblePriceValue(value: number): string {
    return value.toFixed(1);
}

export function formatPriceValue(value: number, unit: string | null): string {
    const formattedValue = formatVisiblePriceValue(value);
    return unit ? `${formattedValue} ${unit}` : formattedValue;
}
