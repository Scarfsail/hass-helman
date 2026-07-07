import type { BatteryCapacityForecastDay } from "./battery-capacity-forecast-detail-model";
import {
    clampForecastPercent,
    isPastForecastTimestamp,
    type ForecastChartBuildContext,
} from "./forecast-chart-shared";

export interface BatteryOverviewChartBarModel {
    heightPercent: number;
    isPast: boolean;
    isGap: boolean;
    toneClass: "soft" | "hit-min" | "hit-max";
}

export interface BatteryOverviewCardModel {
    gaugeFillPercent: number;
    miniChartBars: BatteryOverviewChartBarModel[];
}

interface BuildBatteryOverviewCardModelParams {
    day: BatteryCapacityForecastDay;
    context: ForecastChartBuildContext;
}

export function buildBatteryOverviewCardModel({
    day,
    context,
}: BuildBatteryOverviewCardModelParams): BatteryOverviewCardModel {
    return {
        gaugeFillPercent: clampForecastPercent(day.endSocPct) ?? 0,
        miniChartBars: day.slots.map((slot) => ({
            heightPercent: clampForecastPercent(slot.socPct) ?? 0,
            isPast: isPastForecastTimestamp(slot.timestamp, day.isToday, context),
            isGap: slot.source === "gap",
            toneClass: slot.hitMaxSoc
                ? "hit-max"
                : slot.hitMinSoc
                    ? "hit-min"
                    : "soft",
        })),
    };
}
