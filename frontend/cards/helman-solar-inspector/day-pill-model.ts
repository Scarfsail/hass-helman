import { getScheduleGridScaleMagnitude } from "../helman-scheduling/model/grid-surplus-display";
import { aggregateScheduleDayForecast, buildScheduleTableForecastMeta } from "../helman-scheduling/model/schedule-table-forecast";
import { formatScheduleDayLabel } from "../helman-scheduling/model/schedule-time";
import type { SlotForecastMap } from "../helman-scheduling/model/slot-forecast-model";
import type {
    ScheduleTableDayAggregateModel,
    ScheduleTableDayAggregateScale,
    ScheduleTableSectionModel,
} from "../helman-scheduling/schedule-table-types";
import type { ScheduleDisplaySlot } from "../helman-scheduling/schedule-types";

/**
 * The days the inspector can be switched to, each carrying the whole-day
 * numbers the schedule card shows in its day rows.
 *
 * The point of the row is comparison: which of the days ahead is the sunny one,
 * which drains the battery, which imports. So the days are aggregated together
 * and share one scale — a bar means the same width in every pill.
 */

/** Days a pill row will ever draw, however far a bad `maxDate` reaches. */
const MAX_PILL_DAYS = 31;

/**
 * Which of a pill's three metrics exist at all.
 *
 * It is per pill rather than per row because the row mixes two sources: the
 * days ahead come from the schedule's forecast, and a day behind comes from
 * what was actually measured. A house with no battery history still has a
 * battery forecast, and vice versa.
 */
export interface SolarInspectorDayPillAvailability {
    battery: boolean;
    solar: boolean;
    grid: boolean;
}

export interface SolarInspectorDayPill {
    /** Local ISO date; the same string the inspector selects days by. */
    dayKey: string;
    /** "Yesterday" / "Today" / "Tomorrow" / a short weekday-and-date. */
    label: string;
    /** Null when neither the schedule nor the day's actuals reach it. */
    aggregate: ScheduleTableDayAggregateModel | null;
    availability: SolarInspectorDayPillAvailability;
    /** True for the reconstructed past day, which is only ever the shown one. */
    isHistory: boolean;
}

/** A past day, rebuilt from what the inspector measured for it. */
export interface SolarInspectorHistoryDay {
    dayKey: string;
    aggregate: ScheduleTableDayAggregateModel | null;
    availability: SolarInspectorDayPillAvailability;
}

export interface SolarInspectorDayPillModel {
    pills: readonly SolarInspectorDayPill[];
    scale: ScheduleTableDayAggregateScale;
}

export const EMPTY_DAY_PILL_MODEL: SolarInspectorDayPillModel = {
    pills: [],
    scale: { solarMaxWh: 0, gridMaxKwh: 0, priceMaxAbs: 0 },
};

/** Every local date from `startDayKey` to `endDayKey`, inclusive. */
export function buildDayPillKeys(startDayKey: string, endDayKey: string): string[] {
    if (!_isDayKey(startDayKey) || !_isDayKey(endDayKey) || endDayKey < startDayKey) {
        return [];
    }

    const keys: string[] = [];
    let cursor = startDayKey;
    while (cursor <= endDayKey && keys.length < MAX_PILL_DAYS) {
        keys.push(cursor);
        cursor = _addDay(cursor);
    }

    return keys;
}

export function buildSolarInspectorDayPills({
    dayKeys,
    slots,
    slotForecastMap,
    historyDays,
    currentDayKey,
    locale,
    timeZone,
    todayLabel,
    tomorrowLabel,
    yesterdayLabel,
}: {
    dayKeys: readonly string[];
    slots: readonly ScheduleDisplaySlot[];
    slotForecastMap: SlotForecastMap;
    /** Past days measured for this row; one before it leads the row. */
    historyDays: readonly SolarInspectorHistoryDay[];
    currentDayKey: string | null;
    locale: string;
    timeZone: string;
    todayLabel: string;
    tomorrowLabel: string;
    yesterdayLabel: string;
}): SolarInspectorDayPillModel {
    const slotsByDayKey = new Map<string, ScheduleDisplaySlot[]>();
    for (const slot of slots) {
        const daySlots = slotsByDayKey.get(slot.dayKey);
        if (daySlots === undefined) {
            slotsByDayKey.set(slot.dayKey, [slot]);
        } else {
            daySlots.push(slot);
        }
    }

    const label = (dayKey: string): string => formatScheduleDayLabel({
        dayKey,
        currentDayKey,
        locale,
        todayLabel,
        tomorrowLabel,
        yesterdayLabel,
    });

    const sections: ScheduleTableSectionModel[] = dayKeys.map((dayKey) => {
        const daySlots = slotsByDayKey.get(dayKey) ?? [];
        return {
            dayKey,
            dayLabel: label(dayKey),
            dayAggregate: daySlots.length > 0
                ? aggregateScheduleDayForecast({ slots: daySlots, slotForecastMap })
                : null,
            rows: [],
        };
    });

    // The scale spans the pills alone, not the schedule card's day set: the row
    // is read against itself.
    const forecast = buildScheduleTableForecastMeta({
        slotForecastMap,
        sections,
        slots: sections.flatMap((section) => slotsByDayKey.get(section.dayKey) ?? []),
        timeZone,
    });
    const availability: SolarInspectorDayPillAvailability = {
        battery: forecast.batteryAvailable,
        solar: forecast.solarAvailable,
        grid: forecast.gridAvailable,
    };

    const pills: SolarInspectorDayPill[] = sections.map((section) => ({
        dayKey: section.dayKey,
        label: section.dayLabel,
        aggregate: section.dayAggregate,
        availability,
        isHistory: false,
    }));

    // The schedule and the forecast only reach forward, so a past day's pill
    // can only come from what was measured. A day inside the row takes its
    // measurements in place; one that sits before the row — the single past day
    // shown while the row still looks forward — leads it instead.
    // The schedule and the forecast only reach forward, so a past day's pill can
    // only say what was measured. Those days take their measurements in place;
    // a measured day the row does not offer is simply not drawn.
    let scale = forecast.dayAggregateScale;
    const pillIndexByDayKey = new Map(pills.map((pill, index) => [pill.dayKey, index]));
    for (const historyDay of historyDays) {
        const index = pillIndexByDayKey.get(historyDay.dayKey);
        if (index === undefined) {
            continue;
        }
        pills[index] = {
            dayKey: historyDay.dayKey,
            label: pills[index].label,
            aggregate: historyDay.aggregate,
            availability: historyDay.availability,
            isHistory: true,
        };
        // What was measured belongs on the same scale as what is forecast:
        // yesterday's sun is only worth showing next to tomorrow's if the two
        // bars mean the same thing.
        scale = _extendScaleWithAggregate(scale, historyDay.aggregate);
    }

    return { pills, scale };
}

/** One day of `helman/solar_bias/day_aggregates`. */
export interface SolarInspectorDayAggregateRow {
    date: string;
    solarWh: number | null;
    gridImportKwh: number | null;
    gridExportKwh: number | null;
    batteryMinSocPct: number | null;
    batteryMaxSocPct: number | null;
}

/**
 * The measured days the backend read in one go, as pills can carry them.
 *
 * A day the meters have nothing for is dropped rather than returned empty: its
 * pill then falls back to whatever the forecast says, which for a past day is
 * nothing, and the gauges read unavailable — the honest answer either way, but
 * without claiming a measured zero.
 *
 * Surplus has no measured counterpart — it is a property of a plan, not of a
 * day that has already happened — so it stays null and the gauge reads
 * import/export.
 */
export function buildHistoryDaysFromAggregates(
    rows: readonly SolarInspectorDayAggregateRow[],
): SolarInspectorHistoryDay[] {
    const days: SolarInspectorHistoryDay[] = [];
    for (const row of rows) {
        const hasSolar = row.solarWh !== null && Number.isFinite(row.solarWh);
        const hasBattery = row.batteryMinSocPct !== null && row.batteryMaxSocPct !== null;
        const hasGrid = row.gridImportKwh !== null || row.gridExportKwh !== null;
        if (!hasSolar && !hasBattery && !hasGrid) {
            continue;
        }

        days.push({
            dayKey: row.date,
            aggregate: {
                batteryMinSocPct: hasBattery ? row.batteryMinSocPct : null,
                batteryMaxSocPct: hasBattery ? row.batteryMaxSocPct : null,
                solarWh: hasSolar ? row.solarWh : null,
                gridImportKwh: hasGrid ? row.gridImportKwh ?? 0 : null,
                gridExportKwh: hasGrid ? row.gridExportKwh ?? 0 : null,
                availableSurplusKwh: null,
                priceHasData: false,
                pricePositiveMin: null,
                pricePositiveMax: null,
                priceNegativeMin: null,
                priceNegativeMax: null,
            },
            availability: { battery: hasBattery, solar: hasSolar, grid: hasGrid },
        });
    }
    return days;
}

function _extendScaleWithAggregate(
    scale: ScheduleTableDayAggregateScale,
    aggregate: ScheduleTableDayAggregateModel | null,
): ScheduleTableDayAggregateScale {
    if (aggregate === null) {
        return scale;
    }

    return {
        ...scale,
        solarMaxWh: Math.max(scale.solarMaxWh, aggregate.solarWh ?? 0),
        gridMaxKwh: Math.max(
            scale.gridMaxKwh,
            getScheduleGridScaleMagnitude({
                gridNetKwh: null,
                gridImportKwh: aggregate.gridImportKwh,
                gridExportKwh: aggregate.gridExportKwh,
                availableSurplusKwh: aggregate.availableSurplusKwh,
            }),
        ),
    };
}

function _isDayKey(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function _addDay(dayKey: string): string {
    const date = new Date(`${dayKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
}
