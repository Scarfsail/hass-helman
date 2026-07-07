export type BatteryFlowDirection = "charge" | "discharge" | "idle";
export type BatteryFlowSource = "forecast" | "actual_soc_delta" | "none";

export interface BatterySlotFlow {
    flowDirection: BatteryFlowDirection;
    flowMagnitudeKwh: number | null;
    flowSource: BatteryFlowSource;
}

interface ForecastBatteryFlowParams {
    chargedKwh: number;
    dischargedKwh: number;
}

interface ActualBatterySocFlowParams {
    startSocPct: number;
    endSocPct: number;
    nominalCapacityKwh: number | null;
}

const ACTUAL_SOC_DELTA_EPSILON = 0.05;

export function buildForecastBatterySlotFlow({
    chargedKwh,
    dischargedKwh,
}: ForecastBatteryFlowParams): BatterySlotFlow {
    if (chargedKwh <= 0 && dischargedKwh <= 0) {
        return {
            flowDirection: "idle",
            flowMagnitudeKwh: 0,
            flowSource: "forecast",
        };
    }

    if (chargedKwh >= dischargedKwh) {
        return {
            flowDirection: "charge",
            flowMagnitudeKwh: Math.max(chargedKwh, 0),
            flowSource: "forecast",
        };
    }

    return {
        flowDirection: "discharge",
        flowMagnitudeKwh: Math.max(dischargedKwh, 0),
        flowSource: "forecast",
    };
}

export function buildActualSocBatterySlotFlow({
    startSocPct,
    endSocPct,
    nominalCapacityKwh,
}: ActualBatterySocFlowParams): BatterySlotFlow {
    if (!Number.isFinite(startSocPct) || !Number.isFinite(endSocPct)) {
        return {
            flowDirection: "idle",
            flowMagnitudeKwh: 0,
            flowSource: "actual_soc_delta",
        };
    }

    const deltaSocPct = endSocPct - startSocPct;
    if (Math.abs(deltaSocPct) <= ACTUAL_SOC_DELTA_EPSILON) {
        return {
            flowDirection: "idle",
            flowMagnitudeKwh: 0,
            flowSource: "actual_soc_delta",
        };
    }

    const flowDirection: BatteryFlowDirection = deltaSocPct > 0 ? "charge" : "discharge";
    if (!Number.isFinite(nominalCapacityKwh ?? NaN) || nominalCapacityKwh === null || nominalCapacityKwh <= 0) {
        return {
            flowDirection,
            flowMagnitudeKwh: null,
            flowSource: "actual_soc_delta",
        };
    }

    return {
        flowDirection,
        flowMagnitudeKwh: nominalCapacityKwh * (Math.abs(deltaSocPct) / 100),
        flowSource: "actual_soc_delta",
    };
}

export function buildEmptyBatterySlotFlow(): BatterySlotFlow {
    return {
        flowDirection: "idle",
        flowMagnitudeKwh: null,
        flowSource: "none",
    };
}
