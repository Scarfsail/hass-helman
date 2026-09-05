import { getScheduleGridScaleMagnitude } from "../shared/schedule/model/grid-surplus-display";
import { aggregateScheduleDayForecast, buildScheduleTableForecastMeta } from "../shared/schedule/model/schedule-table-forecast";
import { formatScheduleDayLabel } from "../shared/schedule/model/schedule-time";
import type { SlotForecastMap } from "../shared/schedule/model/slot-forecast-model";
import type {
    ScheduleTableDayAggregateModel,
    ScheduleTableDayAggregateScale,
    ScheduleTableSectionModel,
} from "../shared/schedule/schedule-table-types";
import type { ScheduleDisplaySlot } from "../shared/schedule/schedule-types";

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
/** Three months (at most 92 days), rounded outward to complete weeks. */
export const MAX_CALENDAR_DAYS = 105;

export function calendarWindow(anchor: string, from: string, to: string, weekday: number): { start: string; end: string } {
    const month = new Date(`${anchor.slice(0, 7)}-01T00:00:00Z`);
    const key = (date: Date) => date.toISOString().slice(0, 10);
    let start = key(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1)));
    let end = key(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 2, 0)));
    if (from && start < from.slice(0, 7) + "-01") start = from.slice(0, 7) + "-01";
    if (to && end.slice(0, 7) > to.slice(0, 7)) {
        const last = new Date(`${to}T00:00:00Z`);
        end = key(new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 0)));
    }
    const first = new Date(`${start}T00:00:00Z`);
    first.setUTCDate(first.getUTCDate() - (first.getUTCDay() - weekday + 7) % 7);
    const last = new Date(`${end}T00:00:00Z`);
    last.setUTCDate(last.getUTCDate() + (weekday + 6 - last.getUTCDay() + 7) % 7);
    return { start: key(first), end: key(last) };
}

/** Home Assistant's `first_weekday` values, in `getUTCDay` order. */
const WEEKDAY_NAMES = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
];

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
export function buildDayPillKeys(startDayKey: string, endDayKey: string, maximum = MAX_PILL_DAYS): string[] {
    if (!_isDayKey(startDayKey) || !_isDayKey(endDayKey) || endDayKey < startDayKey) {
        return [];
    }

    const keys: string[] = [];
    let cursor = startDayKey;
    while (cursor <= endDayKey && keys.length < Math.min(MAX_CALENDAR_DAYS, maximum)) {
        keys.push(cursor);
        cursor = _addDay(cursor);
    }

    return keys;
}

/**
 * The pill list with the leading blanks a calendar grid needs.
 *
 * A month laid out as seven columns only reads as a calendar if the first of
 * the month sits under its own weekday, so the row is preceded by as many empty
 * cells as there are days between the week's start and that weekday. Trailing
 * blanks are not returned: a grid ends where its items do, and cells nobody can
 * see are cells the element would have to skip when rendering.
 *
 * The blanks are `null` rather than a placeholder shape, because that is what
 * they are — the element renders an inert spacer for each and nothing else.
 */
export function buildDayPillCalendarCells(
    pills: readonly SolarInspectorDayPill[],
    firstWeekdayIndex: number,
): readonly (SolarInspectorDayPill | null)[] {
    const first = pills[0];
    if (first === undefined || !_isDayKey(first.dayKey)) {
        return pills;
    }

    const weekday = new Date(`${first.dayKey}T00:00:00Z`).getUTCDay();
    // Modulo twice: the inner difference is negative whenever the week starts
    // after the first day's weekday, and a negative count of blanks would drop
    // the row a column to the left instead of shifting it right.
    const blanks = (((weekday - firstWeekdayIndex) % 7) + 7) % 7;
    return [...Array<null>(blanks).fill(null), ...pills];
}

/**
 * Which weekday a calendar starts on, from Home Assistant's locale settings.
 *
 * This is `firstWeekdayIndex` from `hass-frontend/src/common/datetime/first_weekday`
 * reimplemented rather than imported, and the reason is mechanical: that module
 * falls back to the `weekstart` package, which is a dependency of the vendored
 * frontend and is not installed for the card bundle, so importing it fails the
 * build. What is left is the same logic without that fallback — an explicit
 * setting wins, `"language"` asks `Intl`, and anything `Intl` cannot answer is
 * Monday, which is what the upstream fallback returns too.
 */
export function resolveFirstWeekdayIndex(
    locale: { language?: string; first_weekday?: string } | undefined,
): number {
    const explicit = locale?.first_weekday;
    if (explicit !== undefined && explicit !== "language") {
        const index = WEEKDAY_NAMES.indexOf(explicit);
        return index === -1 ? 1 : index;
    }

    try {
        const info = (new Intl.Locale(locale?.language || "en") as unknown as {
            weekInfo?: { firstDay?: number };
            getWeekInfo?: () => { firstDay?: number };
        });
        const firstDay = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay;
        if (typeof firstDay === "number") {
            // `Intl` counts Monday as 1 and Sunday as 7; `getUTCDay` counts
            // Sunday as 0, and the blanks above are computed against the latter.
            return firstDay % 7;
        }
    } catch {
        // A language string `Intl` will not parse is not worth a broken row.
    }
    return 1;
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
