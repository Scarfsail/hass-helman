import type { ForecastPayload, ForecastPointDTO } from "../helman-api";
import type {
    HelmanForecastSectionVisibility,
} from "./HelmanForecastCardConfig";
import {
    buildBatteryOverviewCardModel,
    type BatteryOverviewChartBarModel,
} from "./shared/battery-capacity-forecast-overview-model";
import {
    buildBatteryCapacityForecastModel,
    type BatteryCapacityForecastDay,
} from "./shared/battery-capacity-forecast-detail-model";
import {
    buildSolarForecastDetailModel,
    type SolarForecastDayModel,
    type ForecastSolarHourPoint,
} from "./shared/forecast-detail-model";
import {
    buildGridEnergyForecastModel,
    type GridEnergyForecastDay,
} from "./shared/grid-energy-forecast-detail-model";
import {
    buildGridPriceForecastDetailModel,
    type GridPriceForecastDayModel,
} from "./shared/grid-price-forecast-detail-model";
import {
    buildHouseForecastModel,
    type HouseForecastDay,
} from "./shared/house-forecast-detail-model";
import {
    buildHouseMiniChartBars,
    computeHouseMetricMax,
    type HouseMetricAccessors,
    type HouseMiniChartBarModel,
} from "./shared/house-forecast-chart-model";
import {
    getForecastPriceToneClass,
    type ForecastPriceToneClass,
} from "./shared/forecast-render-helpers";
import {
    clampForecastPercent,
    isPastForecastTimestamp,
    normalizeForecastBarHeight,
    type ForecastChartBuildContext,
} from "./shared/forecast-chart-shared";
import {
    alignPointsToSharedAxis,
    buildSharedForecastAxis,
    projectIntervalsToSharedAxis,
    type SharedForecastAxis,
} from "./shared/shared-forecast-axis";

interface SolarPriceMiniChartScaleModel {
    maxSolarHourValue: number;
    maxAbsolutePriceValue: number;
    hasNegativePriceValues: boolean;
}

export interface UnifiedSolarMiniChartBarModel {
    heightPercent: number;
    isPast: boolean;
    isGap: boolean;
}

export interface UnifiedPriceMiniChartBarModel {
    heightPercent: number;
    offsetPercent: number;
    toneClass: ForecastPriceToneClass;
    isPast: boolean;
    isGap: boolean;
}

export type UnifiedGridToneClass = "grid-import" | "grid-export" | "grid-neutral";

export interface UnifiedGridMiniChartBarModel {
    heightPercent: number;
    offsetPercent: number;
    toneClass: UnifiedGridToneClass;
    isPast: boolean;
    isGap: boolean;
}

export interface UnifiedPriceOverviewChip {
    shortLabel: string;
    value: number;
    toneClass: ForecastPriceToneClass;
    muted: boolean;
}

export interface UnifiedSolarOverviewModel {
    summaryKwh: number;
    totalKwh: number | null;
    gaugeFillPercent: number;
    totalGaugeFillPercent: number;
    miniChartBars: UnifiedSolarMiniChartBarModel[];
}

export type UnifiedGridFlowDirection = "import" | "export" | "neutral";

export interface UnifiedGridOverviewModel {
    importedDayKwh: number;
    exportedDayKwh: number;
    netDayKwh: number;
    direction: UnifiedGridFlowDirection;
    gaugeFillPercent: number;
    miniChartBars: UnifiedGridMiniChartBarModel[];
}

export interface UnifiedBatteryOverviewModel {
    endSocPct: number;
    minSocPct: number;
    maxSocPct: number;
    gaugeFillPercent: number;
    miniChartBars: BatteryOverviewChartBarModel[];
    coverageEndsAt: string;
    coversDayEnd: boolean;
}

export interface UnifiedHouseOverviewModel {
    baselineDayKwh: number;
    deferrableDayKwh: number;
    gaugeFillPercent: number;
    miniChartBars: HouseMiniChartBarModel[];
}

export interface UnifiedPriceOverviewModel {
    currentPrice: number | null;
    priceMin: number | null;
    priceMax: number | null;
    chips: UnifiedPriceOverviewChip[];
    miniChartBars: UnifiedPriceMiniChartBarModel[];
    hasNegativeValues: boolean;
}

export interface UnifiedForecastDayModel {
    dayKey: string;
    isToday: boolean;
    isTomorrow: boolean;
    solarDay: SolarForecastDayModel | null;
    gridPriceDay: GridPriceForecastDayModel | null;
    gridDay: GridEnergyForecastDay | null;
    batteryDay: BatteryCapacityForecastDay | null;
    houseDay: HouseForecastDay | null;
    solar: UnifiedSolarOverviewModel | null;
    grid: UnifiedGridOverviewModel | null;
    battery: UnifiedBatteryOverviewModel | null;
    house: UnifiedHouseOverviewModel | null;
    price: UnifiedPriceOverviewModel | null;
}

export interface UnifiedForecastModel {
    days: UnifiedForecastDayModel[];
    visibleSections: HelmanForecastSectionVisibility;
}

const HOUSE_BASELINE_ACCESSORS: HouseMetricAccessors = {
    getHourValue: (hour) => hour.baselineKwh,
    getLowerValue: (hour) => hour.baselineLowerKwh,
    getUpperValue: (hour) => hour.baselineUpperKwh,
};

const EMPTY_FORECAST_MODEL: UnifiedForecastModel = {
    days: [],
    visibleSections: {
        solar: false,
        grid: false,
        battery: false,
        house: false,
        price: false,
    },
};

export function buildUnifiedForecastModel({
    forecast,
    chartContext,
    sectionVisibility,
    chartSectionVisibility,
    remainingTodayKwhOverride,
    now = new Date(),
}: {
    forecast: ForecastPayload | null;
    chartContext: ForecastChartBuildContext;
    sectionVisibility: HelmanForecastSectionVisibility;
    chartSectionVisibility: HelmanForecastSectionVisibility;
    remainingTodayKwhOverride?: number | null;
    now?: Date;
}): UnifiedForecastModel {
    if (forecast === null) {
        return EMPTY_FORECAST_MODEL;
    }

    const solarDays = buildSolarForecastDetailModel({
        solarForecast: forecast.solar,
        timeZone: chartContext.timeZone,
        remainingTodayKwhOverride,
        now,
    });
    const gridPriceDays = buildGridPriceForecastDetailModel({
        gridForecast: forecast.grid,
        timeZone: chartContext.timeZone,
        now,
    });
    const gridDays = buildGridEnergyForecastModel({
        gridForecast: forecast.grid,
        timeZone: chartContext.timeZone,
        now,
    });
    const batteryDays = buildBatteryCapacityForecastModel({
        actualHistory: forecast.battery_capacity.actualHistory,
        series: forecast.battery_capacity.series,
        currentSoc: forecast.battery_capacity.currentSoc,
        startedAt: forecast.battery_capacity.startedAt,
        nominalCapacityKwh: forecast.battery_capacity.nominalCapacityKwh,
        timeZone: chartContext.timeZone,
        now,
    });
    const houseForecast = forecast.house_consumption;
    const houseDays = buildHouseForecastModel({
        actualHistory: houseForecast.actualHistory,
        currentSlot: houseForecast.currentSlot ?? houseForecast.currentHour ?? null,
        series: houseForecast.series,
        timeZone: chartContext.timeZone,
        now,
    });

    const solarPriceScale = _buildSolarPriceMiniChartScaleModel(solarDays, gridPriceDays);
    const maxSolarGaugeValueKwh = _getMaxSolarGaugeValueKwh(solarDays);
    const maxGridGaugeValueKwh = _getMaxGridGaugeValueKwh(gridDays);
    const maxGridMiniChartValueKwh = _getMaxGridMiniChartValueKwh(gridDays);
    const maxHouseGaugeValueKwh = Math.max(...houseDays.map((day) => day.baselineDayKwh), 0);
    const maxHouseMiniChartValue = computeHouseMetricMax(houseDays, HOUSE_BASELINE_ACCESSORS);

    const solarDaysByKey = new Map(solarDays.map((day) => [day.dayKey, day]));
    const gridPriceDaysByKey = new Map(gridPriceDays.map((day) => [day.dayKey, day]));
    const gridDaysByKey = new Map(gridDays.map((day) => [day.dayKey, day]));
    const batteryDaysByKey = new Map(batteryDays.map((day) => [day.dayKey, day]));
    const houseDaysByKey = new Map(houseDays.map((day) => [day.dayKey, day]));

    const days = Array.from(
        new Set([
            ...solarDaysByKey.keys(),
            ...gridPriceDaysByKey.keys(),
            ...gridDaysByKey.keys(),
            ...batteryDaysByKey.keys(),
            ...houseDaysByKey.keys(),
        ]),
    )
        .sort()
        .map((dayKey) => {
            const solarDay = solarDaysByKey.get(dayKey) ?? null;
            const gridPriceDay = gridPriceDaysByKey.get(dayKey) ?? null;
            const gridDay = gridDaysByKey.get(dayKey) ?? null;
            const batteryDay = batteryDaysByKey.get(dayKey) ?? null;
            const houseDay = houseDaysByKey.get(dayKey) ?? null;
            const isToday = solarDay?.isToday
                ?? gridPriceDay?.isToday
                ?? gridDay?.isToday
                ?? batteryDay?.isToday
                ?? houseDay?.isToday
                ?? false;
            const isTomorrow = solarDay?.isTomorrow
                ?? gridPriceDay?.isTomorrow
                ?? gridDay?.isTomorrow
                ?? batteryDay?.isTomorrow
                ?? houseDay?.isTomorrow
                ?? false;
            const hasSolarSection = sectionVisibility.solar && solarDay !== null && _hasSolarOverview(solarDay);
            const hasGridSection = sectionVisibility.grid && gridDay !== null;
            const hasBatterySection = sectionVisibility.battery && batteryDay !== null;
            const hasHouseSection = sectionVisibility.house && houseDay !== null;
            const hasPriceSection = sectionVisibility.price && gridPriceDay !== null;
            const overviewChartVisibility: HelmanForecastSectionVisibility = {
                solar: hasSolarSection && chartSectionVisibility.solar,
                grid: hasGridSection && chartSectionVisibility.grid,
                battery: hasBatterySection && chartSectionVisibility.battery,
                house: hasHouseSection && chartSectionVisibility.house,
                price: hasPriceSection && chartSectionVisibility.price,
            };
            const overviewAxis = _buildOverviewSharedAxis({
                dayKey,
                chartContext,
                chartVisibility: overviewChartVisibility,
                solarDay,
                gridDay,
                priceDay: gridPriceDay,
                batteryDay,
                houseDay,
            });
            const solar = hasSolarSection && solarDay !== null
                ? _buildSolarOverviewModel(
                    solarDay,
                    solarPriceScale,
                    chartContext,
                    maxSolarGaugeValueKwh,
                    overviewAxis,
                    overviewChartVisibility.solar,
                )
                : null;
            const grid = hasGridSection && gridDay !== null
                ? _buildGridOverviewModel(
                    gridDay,
                    maxGridGaugeValueKwh,
                    maxGridMiniChartValueKwh,
                    chartContext,
                    overviewAxis,
                    overviewChartVisibility.grid,
                )
                : null;
            const battery = hasBatterySection && batteryDay !== null
                ? _buildBatteryOverviewModel(
                    batteryDay,
                    chartContext,
                    overviewAxis,
                    overviewChartVisibility.battery,
                )
                : null;
            const house = hasHouseSection && houseDay !== null
                ? _buildHouseOverviewModel(
                    houseDay,
                    chartContext,
                    maxHouseGaugeValueKwh,
                    maxHouseMiniChartValue,
                    overviewAxis,
                    overviewChartVisibility.house,
                )
                : null;
            const price = hasPriceSection && gridPriceDay !== null
                ? _buildPriceOverviewModel(gridPriceDay, solarPriceScale, chartContext, overviewAxis)
                : null;

            if (solar === null && grid === null && battery === null && house === null && price === null) {
                return null;
            }

            return {
                dayKey,
                isToday,
                isTomorrow,
                solarDay,
                gridPriceDay,
                gridDay,
                batteryDay,
                houseDay,
                solar,
                grid,
                battery,
                house,
                price,
            } satisfies UnifiedForecastDayModel;
        })
        .filter((day): day is UnifiedForecastDayModel => day !== null);

    return {
        days,
        visibleSections: {
            solar: days.some((day) => day.solar !== null),
            grid: days.some((day) => day.grid !== null),
            battery: days.some((day) => day.battery !== null),
            house: days.some((day) => day.house !== null),
            price: days.some((day) => day.price !== null),
        },
    };
}

function _buildSolarOverviewModel(
    day: SolarForecastDayModel,
    scale: SolarPriceMiniChartScaleModel,
    chartContext: ForecastChartBuildContext,
    maxSolarGaugeValueKwh: number,
    overviewAxis: SharedForecastAxis | null,
    chartVisible: boolean,
): UnifiedSolarOverviewModel {
    return {
        summaryKwh: day.solarSummaryKwh!,
        totalKwh: day.solarTotalKwh,
        gaugeFillPercent: _normalizeGaugeFill(_getRemainingSolarGaugeValueKwh(day), maxSolarGaugeValueKwh),
        totalGaugeFillPercent: _normalizeGaugeFill(_getComparableSolarGaugeValueKwh(day), maxSolarGaugeValueKwh),
        miniChartBars: chartVisible
            ? _buildSolarMiniChartBars(day, scale, chartContext, overviewAxis)
            : [],
    };
}

function _buildGridOverviewModel(
    day: GridEnergyForecastDay,
    maxGridGaugeValueKwh: number,
    maxGridMiniChartValueKwh: number,
    chartContext: ForecastChartBuildContext,
    overviewAxis: SharedForecastAxis | null,
    chartVisible: boolean,
): UnifiedGridOverviewModel {
    return {
        importedDayKwh: day.importedDayKwh,
        exportedDayKwh: day.exportedDayKwh,
        netDayKwh: day.netDayKwh,
        direction: _getGridFlowDirection(day.netDayKwh),
        gaugeFillPercent: _normalizeHalfGaugeFill(day.netDayKwh, maxGridGaugeValueKwh),
        miniChartBars: chartVisible
            ? _buildGridMiniChartBars(day, maxGridMiniChartValueKwh, chartContext, overviewAxis)
            : [],
    };
}

function _buildBatteryOverviewModel(
    day: BatteryCapacityForecastDay,
    chartContext: ForecastChartBuildContext,
    overviewAxis: SharedForecastAxis | null,
    chartVisible: boolean,
): UnifiedBatteryOverviewModel {
    const overview = buildBatteryOverviewCardModel({ day, context: chartContext });
    return {
        endSocPct: day.endSocPct,
        minSocPct: day.minSocPct,
        maxSocPct: day.maxSocPct,
        gaugeFillPercent: overview.gaugeFillPercent,
        miniChartBars: chartVisible
            ? _buildBatteryMiniChartBars(day, chartContext, overviewAxis, overview.miniChartBars)
            : [],
        coverageEndsAt: day.coverageEndsAt,
        coversDayEnd: day.coversDayEnd,
    };
}

function _buildHouseOverviewModel(
    day: HouseForecastDay,
    chartContext: ForecastChartBuildContext,
    maxHouseGaugeValueKwh: number,
    maxHouseMiniChartValue: number,
    overviewAxis: SharedForecastAxis | null,
    chartVisible: boolean,
): UnifiedHouseOverviewModel {
    return {
        baselineDayKwh: day.baselineDayKwh,
        deferrableDayKwh: day.deferrableDayKwh,
        gaugeFillPercent: _normalizeGaugeFill(day.baselineDayKwh, maxHouseGaugeValueKwh),
        miniChartBars: chartVisible
            ? _buildHouseOverviewMiniChartBars(
                day,
                chartContext,
                maxHouseMiniChartValue,
                overviewAxis,
            )
            : [],
    };
}

function _buildPriceOverviewModel(
    day: GridPriceForecastDayModel,
    scale: SolarPriceMiniChartScaleModel,
    chartContext: ForecastChartBuildContext,
    overviewAxis: SharedForecastAxis | null,
): UnifiedPriceOverviewModel | null {
    const chips = _buildPriceOverviewChips(day);
    if (chips.length === 0 && day.priceHours.length === 0) {
        return null;
    }

    return {
        currentPrice: day.currentPrice,
        priceMin: day.priceMin,
        priceMax: day.priceMax,
        chips,
        miniChartBars: _buildPriceMiniChartBars(day, scale, chartContext, overviewAxis),
        hasNegativeValues: scale.hasNegativePriceValues,
    };
}

function _buildOverviewSharedAxis({
    dayKey,
    chartContext,
    chartVisibility,
    solarDay,
    gridDay,
    priceDay,
    batteryDay,
    houseDay,
}: {
    dayKey: string;
    chartContext: ForecastChartBuildContext;
    chartVisibility: HelmanForecastSectionVisibility;
    solarDay: SolarForecastDayModel | null;
    gridDay: GridEnergyForecastDay | null;
    priceDay: GridPriceForecastDayModel | null;
    batteryDay: BatteryCapacityForecastDay | null;
    houseDay: HouseForecastDay | null;
}): SharedForecastAxis | null {
    const referenceTimestamps = [
        ...(chartVisibility.solar ? solarDay?.solarHours.map((point) => point.timestamp) ?? [] : []),
        ...(chartVisibility.grid ? gridDay?.slots.map((slot) => slot.timestamp) ?? [] : []),
        ...(chartVisibility.price ? priceDay?.priceHours.map((point) => point.timestamp) ?? [] : []),
        ...(chartVisibility.battery ? batteryDay?.slots.map((slot) => slot.timestamp) ?? [] : []),
        ...(chartVisibility.house ? houseDay?.hours.map((hour) => hour.timestamp) ?? [] : []),
    ];

    if (referenceTimestamps.length === 0) {
        return null;
    }

    const overviewAxis = buildSharedForecastAxis({
        dayKey,
        chartContext,
        referenceTimestamps,
    });

    return overviewAxis.columns.length > 0 ? overviewAxis : null;
}

function _buildSolarMiniChartBars(
    day: SolarForecastDayModel,
    scale: SolarPriceMiniChartScaleModel,
    chartContext: ForecastChartBuildContext,
    overviewAxis: SharedForecastAxis | null,
): UnifiedSolarMiniChartBarModel[] {
    if (overviewAxis === null) {
        return day.solarHours.map((point) => _buildSolarMiniChartBar(point, day, scale, chartContext));
    }

    return alignPointsToSharedAxis(
        overviewAxis,
        day.solarHours,
        chartContext.timeZone,
        day.dayKey,
    ).map((projection) => ({
        heightPercent: normalizeForecastBarHeight(
            Math.max(projection.entry?.value ?? 0, 0),
            scale.maxSolarHourValue,
            100,
        ),
        isPast: projection.column.isPast,
        isGap: projection.entry === null || projection.entry.source === "gap",
    }));
}

function _buildBatteryMiniChartBars(
    day: BatteryCapacityForecastDay,
    chartContext: ForecastChartBuildContext,
    overviewAxis: SharedForecastAxis | null,
    fallbackBars: BatteryOverviewChartBarModel[],
): BatteryOverviewChartBarModel[] {
    if (overviewAxis === null) {
        return fallbackBars;
    }

    return projectIntervalsToSharedAxis(
        overviewAxis,
        day.slots,
        chartContext.timeZone,
        day.dayKey,
    ).map((projection) => ({
        heightPercent: clampForecastPercent(projection.entry?.socPct ?? null) ?? 0,
        isPast: projection.column.isPast,
        isGap: projection.entry === null || projection.entry.source === "gap",
        toneClass: projection.entry?.hitMaxSoc
            ? "hit-max"
            : projection.entry?.hitMinSoc
                ? "hit-min"
                : "soft",
    }));
}

function _buildHouseOverviewMiniChartBars(
    day: HouseForecastDay,
    chartContext: ForecastChartBuildContext,
    maxHouseMiniChartValue: number,
    overviewAxis: SharedForecastAxis | null,
): HouseMiniChartBarModel[] {
    if (overviewAxis === null) {
        return buildHouseMiniChartBars(
            day,
            HOUSE_BASELINE_ACCESSORS,
            maxHouseMiniChartValue,
            chartContext,
        );
    }

    return alignPointsToSharedAxis(
        overviewAxis,
        day.hours,
        chartContext.timeZone,
        day.dayKey,
    ).map((projection) => ({
        heightPercent: normalizeForecastBarHeight(
            Math.max(projection.entry?.baselineKwh ?? 0, 0),
            maxHouseMiniChartValue,
            100,
        ),
        isPast: projection.column.isPast,
        isGap: projection.entry === null || projection.entry.source === "gap",
    }));
}

function _buildPriceMiniChartBars(
    day: GridPriceForecastDayModel,
    scale: SolarPriceMiniChartScaleModel,
    chartContext: ForecastChartBuildContext,
    overviewAxis: SharedForecastAxis | null,
): UnifiedPriceMiniChartBarModel[] {
    if (overviewAxis === null) {
        return day.priceHours.map((point) => _buildPriceMiniChartBar(point, day, scale, chartContext));
    }

    return alignPointsToSharedAxis(
        overviewAxis,
        day.priceHours,
        chartContext.timeZone,
        day.dayKey,
    ).map((projection) => {
        const value = projection.entry?.value ?? null;
        const heightPercent = normalizeForecastBarHeight(
            Math.abs(value ?? 0),
            scale.maxAbsolutePriceValue,
            scale.hasNegativePriceValues ? 50 : 100,
        );

        return {
            heightPercent,
            offsetPercent: value === null
                ? 0
                : scale.hasNegativePriceValues && value < 0
                    ? Math.max(0, 50 - heightPercent)
                    : scale.hasNegativePriceValues
                        ? 50
                        : 0,
            toneClass: getForecastPriceToneClass(value ?? 0),
            isPast: projection.column.isPast,
            isGap: projection.entry === null,
        } satisfies UnifiedPriceMiniChartBarModel;
    });
}

function _buildGridMiniChartBars(
    day: GridEnergyForecastDay,
    maxGridMiniChartValueKwh: number,
    chartContext: ForecastChartBuildContext,
    overviewAxis: SharedForecastAxis | null,
): UnifiedGridMiniChartBarModel[] {
    if (overviewAxis === null) {
        return day.slots.map((slot) => _buildGridMiniChartBar(
            slot.netKwh,
            day.isToday,
            slot.timestamp,
            maxGridMiniChartValueKwh,
            chartContext,
        ));
    }

    return projectIntervalsToSharedAxis(
        overviewAxis,
        day.slots,
        chartContext.timeZone,
        day.dayKey,
    ).map((projection) => {
        const value = projection.entry?.netKwh ?? null;
        const heightPercent = normalizeForecastBarHeight(
            Math.abs(value ?? 0),
            maxGridMiniChartValueKwh,
            50,
        );

        return {
            heightPercent,
            offsetPercent: value === null
                ? 0
                : value < 0
                    ? Math.max(0, 50 - heightPercent)
                    : 50,
            toneClass: _getGridToneClass(value),
            isPast: projection.column.isPast,
            isGap: projection.entry === null || projection.entry.source === "gap",
        } satisfies UnifiedGridMiniChartBarModel;
    });
}

function _buildSolarMiniChartBar(
    point: ForecastSolarHourPoint,
    day: SolarForecastDayModel,
    scale: SolarPriceMiniChartScaleModel,
    chartContext: ForecastChartBuildContext,
): UnifiedSolarMiniChartBarModel {
    return {
        heightPercent: normalizeForecastBarHeight(
            Math.max(point.value ?? 0, 0),
            scale.maxSolarHourValue,
            100,
        ),
        isPast: isPastForecastTimestamp(point.timestamp, day.isToday, chartContext),
        isGap: point.source === "gap",
    };
}

function _buildGridMiniChartBar(
    value: number,
    isToday: boolean,
    timestamp: string,
    maxGridMiniChartValueKwh: number,
    chartContext: ForecastChartBuildContext,
): UnifiedGridMiniChartBarModel {
    const heightPercent = normalizeForecastBarHeight(
        Math.abs(value),
        maxGridMiniChartValueKwh,
        50,
    );

    return {
        heightPercent,
        offsetPercent: value < 0 ? Math.max(0, 50 - heightPercent) : 50,
        toneClass: _getGridToneClass(value),
        isPast: isPastForecastTimestamp(timestamp, isToday, chartContext),
        isGap: false,
    };
}

function _buildPriceMiniChartBar(
    point: ForecastPointDTO,
    day: GridPriceForecastDayModel,
    scale: SolarPriceMiniChartScaleModel,
    chartContext: ForecastChartBuildContext,
): UnifiedPriceMiniChartBarModel {
    const heightPercent = normalizeForecastBarHeight(
        Math.abs(point.value),
        scale.maxAbsolutePriceValue,
        scale.hasNegativePriceValues ? 50 : 100,
    );

    return {
        heightPercent,
        offsetPercent: scale.hasNegativePriceValues && point.value < 0
            ? Math.max(0, 50 - heightPercent)
            : scale.hasNegativePriceValues
                ? 50
                : 0,
        toneClass: getForecastPriceToneClass(point.value),
        isPast: isPastForecastTimestamp(point.timestamp, day.isToday, chartContext),
        isGap: false,
    };
}

function _buildPriceOverviewChips(day: GridPriceForecastDayModel): UnifiedPriceOverviewChip[] {
    const hasCurrentPrice = day.isToday && day.currentPrice !== null;
    const chips: UnifiedPriceOverviewChip[] = [];

    if (hasCurrentPrice && day.currentPrice !== null) {
        chips.push({
            shortLabel: "",
            value: day.currentPrice,
            toneClass: getForecastPriceToneClass(day.currentPrice),
            muted: false,
        });
    }

    if (day.priceMin !== null) {
        chips.push({
            shortLabel: "↓",
            value: day.priceMin,
            toneClass: getForecastPriceToneClass(day.priceMin),
            muted: hasCurrentPrice,
        });
    }

    if (day.priceMax !== null) {
        chips.push({
            shortLabel: "↑",
            value: day.priceMax,
            toneClass: getForecastPriceToneClass(day.priceMax),
            muted: hasCurrentPrice,
        });
    }

    return chips;
}

function _buildSolarPriceMiniChartScaleModel(
    solarDays: SolarForecastDayModel[],
    priceDays: GridPriceForecastDayModel[],
): SolarPriceMiniChartScaleModel {
    return {
        maxSolarHourValue: Math.max(
            ...solarDays.flatMap((day) => day.solarHours.map((point) => Math.max(point.value ?? 0, 0))),
            0,
        ),
        maxAbsolutePriceValue: Math.max(
            ...priceDays.flatMap((day) => day.priceHours.map((point) => Math.abs(point.value))),
            0,
        ),
        hasNegativePriceValues: priceDays.some((day) => day.priceHours.some((point) => point.value < 0)),
    };
}

function _hasSolarOverview(day: SolarForecastDayModel): boolean {
    return day.hasSolarData && day.solarSummaryKwh !== null;
}

function _getMaxSolarGaugeValueKwh(days: SolarForecastDayModel[]): number {
    return days.reduce((maxValue, day) => {
        const comparableSolarKwh = _getComparableSolarGaugeValueKwh(day);
        if (comparableSolarKwh === null) {
            return maxValue;
        }

        return Math.max(maxValue, comparableSolarKwh);
    }, 0);
}

function _getComparableSolarGaugeValueKwh(day: SolarForecastDayModel): number | null {
    return day.solarTotalKwh ?? day.solarSummaryKwh;
}

function _getRemainingSolarGaugeValueKwh(day: SolarForecastDayModel): number | null {
    if (day.solarSummaryKwh === null) {
        return null;
    }

    if (day.solarTotalKwh === null) {
        return day.solarSummaryKwh;
    }

    return Math.max(0, Math.min(day.solarSummaryKwh, day.solarTotalKwh));
}

function _getMaxGridGaugeValueKwh(days: GridEnergyForecastDay[]): number {
    return Math.max(...days.map((day) => Math.abs(day.netDayKwh)), 0);
}

function _getMaxGridMiniChartValueKwh(days: GridEnergyForecastDay[]): number {
    return Math.max(...days.flatMap((day) => day.slots.map((slot) => Math.abs(slot.netKwh))), 0);
}

function _getGridFlowDirection(value: number): UnifiedGridFlowDirection {
    if (value < 0) {
        return "import";
    }
    if (value > 0) {
        return "export";
    }
    return "neutral";
}

function _normalizeHalfGaugeFill(value: number | null, maxValue: number): number {
    if (value === null || maxValue <= 0) {
        return 0;
    }

    return Math.min((Math.abs(value) / maxValue) * 100, 100);
}

function _getGridToneClass(value: number | null): UnifiedGridToneClass {
    if (value === null || value === 0) {
        return "grid-neutral";
    }

    return value < 0 ? "grid-import" : "grid-export";
}

function _normalizeGaugeFill(value: number | null, maxValue: number): number {
    if (value === null || maxValue <= 0) {
        return 0;
    }

    return Math.min((value / maxValue) * 100, 100);
}
