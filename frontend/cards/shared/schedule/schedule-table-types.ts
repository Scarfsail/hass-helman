export interface ScheduleTableForecastMeta {
    batteryAvailable: boolean;
    solarAvailable: boolean;
    gridAvailable: boolean;
    priceAvailable: boolean;
    priceDisplayUnit: string | null;
    dayAggregateScale: ScheduleTableDayAggregateScale;
}

export interface ScheduleTableDayAggregateScale {
    solarMaxWh: number;
    gridMaxKwh: number;
    priceMaxAbs: number;
}

export interface ScheduleTableDayAggregateModel {
    batteryMinSocPct: number | null;
    batteryMaxSocPct: number | null;
    solarWh: number | null;
    gridImportKwh: number | null;
    gridExportKwh: number | null;
    availableSurplusKwh: number | null;
    priceHasData: boolean;
    pricePositiveMin: number | null;
    pricePositiveMax: number | null;
    priceNegativeMin: number | null;
    priceNegativeMax: number | null;
}

export interface ScheduleTableSectionModel {
    dayKey: string;
    dayLabel: string;
    dayAggregate: ScheduleTableDayAggregateModel | null;
}
