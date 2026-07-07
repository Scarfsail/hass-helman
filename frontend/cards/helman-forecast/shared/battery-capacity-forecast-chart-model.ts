import type {
    BatteryCapacityForecastDay,
    BatterySlotSource,
} from "./battery-capacity-forecast-detail-model";
import type {
    BatteryFlowDirection,
    BatteryFlowSource,
} from "./battery-capacity-flow";
import {
    buildSparseHourLabelMap,
    clampForecastPercent,
    isPastForecastTimestamp,
    normalizeForecastBarHeight,
    type ForecastChartBuildContext,
} from "./forecast-chart-shared";
import type { SharedForecastAxis } from "./shared-forecast-axis";

export type BatteryChartBuildContext = ForecastChartBuildContext;

export interface BatteryDetailColumnModel {
    source: BatterySlotSource;
    timestamp: string;
    endsAt: string;
    displayStartAt: string;
    displayEndAt: string;
    durationHours: number;
    hourLabel: string | null;
    isPast: boolean;
    isGap: boolean;
    startSocPct: number | null;
    endSocPct: number | null;
    socChangeOffsetPercent: number;
    socChangeHeightPercent: number;
    dashOffsetPercent: number;
    flowDirection: BatteryFlowDirection;
    flowSource: BatteryFlowSource;
    flowMagnitudeKwh: number | null;
    chargeHeightPercent: number;
    chargeOffsetPercent: number;
    dischargeHeightPercent: number;
    dischargeOffsetPercent: number;
    hasRenderableChargeBar: boolean;
    hasRenderableDischargeBar: boolean;
    chargedKwh: number;
    dischargedKwh: number;
    importedFromGridKwh: number;
    exportedToGridKwh: number;
    hitMinSoc: boolean;
    hitMaxSoc: boolean;
    limitedByChargePower: boolean;
    limitedByDischargePower: boolean;
}

export interface BatteryDetailChartModel {
    columns: BatteryDetailColumnModel[];
    minSocOffsetPercent: number | null;
    maxSocOffsetPercent: number | null;
}

interface BuildBatteryDetailChartModelParams {
    day: BatteryCapacityForecastDay;
    axis: SharedForecastAxis;
    minSoc: number | null;
    maxSoc: number | null;
    context: BatteryChartBuildContext;
}

const DETAIL_MAX_FLOW_HEIGHT = 34;

export function buildBatteryDetailChartModel({
    day,
    axis,
    minSoc,
    maxSoc,
    context,
}: BuildBatteryDetailChartModelParams): BatteryDetailChartModel {
    const timestamps = day.slots.map((slot) => slot.timestamp);
    const sparseHourLabels = buildSparseHourLabelMap(timestamps, context);
    const minSocThreshold = clampForecastPercent(minSoc) ?? 0;
    const maxSocThreshold = clampForecastPercent(maxSoc) ?? 100;
    const flowMaxKwh = Math.max(
        ...day.slots.flatMap((slot) => [Math.max(slot.chargedKwh, 0), Math.max(slot.dischargedKwh, 0)]),
        0,
    );

    return {
        columns: day.slots.map((slot, index) => {
            const normalizedStartSoc = clampForecastPercent(slot.startSocPct);
            const normalizedEndSoc = clampForecastPercent(slot.socPct);
            const dashOffsetPercent = normalizedEndSoc ?? normalizedStartSoc ?? 0;
            const isAtMinSoc = normalizedEndSoc !== null && normalizedEndSoc <= minSocThreshold;
            const isAtMaxSoc = normalizedEndSoc !== null && normalizedEndSoc >= maxSocThreshold;
            const rawChargeHeightPercent = normalizeForecastBarHeight(
                Math.max(slot.chargedKwh, 0),
                flowMaxKwh,
                DETAIL_MAX_FLOW_HEIGHT,
            );
            const rawDischargeHeightPercent = normalizeForecastBarHeight(
                Math.max(slot.dischargedKwh, 0),
                flowMaxKwh,
                DETAIL_MAX_FLOW_HEIGHT,
            );
            const hasRenderableChargeBar = slot.chargedKwh > 0;
            const hasRenderableDischargeBar = slot.dischargedKwh > 0;
            const chargeHeightPercent = hasRenderableChargeBar
                ? Math.min(rawChargeHeightPercent, dashOffsetPercent)
                : 0;
            const dischargeHeightPercent = hasRenderableDischargeBar
                ? Math.min(rawDischargeHeightPercent, 100 - dashOffsetPercent)
                : 0;

            return {
                source: slot.source,
                timestamp: slot.timestamp,
                endsAt: slot.endsAt,
                displayStartAt: axis.columns[index]?.timestamp ?? slot.timestamp,
                displayEndAt: axis.columns[index + 1]?.timestamp ?? slot.endsAt,
                durationHours: slot.durationHours,
                hourLabel: sparseHourLabels.get(index) ?? null,
                isPast: isPastForecastTimestamp(slot.timestamp, day.isToday, context),
                isGap: slot.source === "gap",
                startSocPct: slot.startSocPct,
                endSocPct: slot.socPct,
                socChangeOffsetPercent: normalizedStartSoc !== null && normalizedEndSoc !== null
                    ? Math.min(normalizedStartSoc, normalizedEndSoc)
                    : 0,
                socChangeHeightPercent: normalizedStartSoc !== null && normalizedEndSoc !== null
                    ? Math.abs(normalizedEndSoc - normalizedStartSoc)
                    : 0,
                dashOffsetPercent,
                flowDirection: slot.flowDirection,
                flowSource: slot.flowSource,
                flowMagnitudeKwh: slot.flowMagnitudeKwh,
                chargeHeightPercent,
                chargeOffsetPercent: Math.max(0, dashOffsetPercent - chargeHeightPercent),
                dischargeHeightPercent,
                dischargeOffsetPercent: dashOffsetPercent,
                hasRenderableChargeBar,
                hasRenderableDischargeBar,
                chargedKwh: slot.chargedKwh,
                dischargedKwh: slot.dischargedKwh,
                importedFromGridKwh: slot.importedFromGridKwh,
                exportedToGridKwh: slot.exportedToGridKwh,
                hitMinSoc: slot.hitMinSoc || isAtMinSoc,
                hitMaxSoc: slot.hitMaxSoc || isAtMaxSoc,
                limitedByChargePower: slot.limitedByChargePower,
                limitedByDischargePower: slot.limitedByDischargePower,
            };
        }),
        minSocOffsetPercent: clampForecastPercent(minSoc),
        maxSocOffsetPercent: clampForecastPercent(maxSoc),
    };
}
