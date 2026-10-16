import type { DayAggregateRow } from "../shared/data/helman-commands";
import { addDays, parseDayKey } from "../shared/time/day-key";
import { getScheduleGridScaleMagnitude } from "../shared/schedule/model/grid-surplus-display";
import { formatScheduleDayLabel } from "../shared/schedule/model/schedule-time";
import type { SlotForecastMap } from "../shared/schedule/model/slot-forecast-model";
import type {
    ScheduleTableDayAggregateModel,
    ScheduleTableForecastMeta,
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

export type SolarInspectorDayState = "measured" | "mixed" | "forecast";

/**
 * A past day's house energy: what the meter measured and what the house
 * forecast had predicted for it. Kept off the shared day aggregate, which the
 * schedule card reads too and which has no per-day house figure.
 */
export interface SolarInspectorDayHouse {
    actualWh: number | null;
    forecastWh: number | null;
}

export interface SolarInspectorDayPill {
    /** Local ISO date; the same string the inspector selects days by. */
    dayKey: string;
    /** "Yesterday" / "Today" / "Tomorrow" / a short weekday-and-date. */
    label: string;
    /** Null when neither the schedule nor the day's actuals reach it. */
    aggregate: ScheduleTableDayAggregateModel | null;
    availability: SolarInspectorDayPillAvailability;
    /**
     * Where the day's numbers come from.
     *
     * Today is the day that has both halves: the meters have the part behind,
     * and the schedule -- which prunes elapsed slots -- has exactly the part
     * ahead. A day like that is neither a measurement nor a prediction, and
     * drawing it as either one makes the row lie about the day the reader is
     * standing in.
     */
    dayState: SolarInspectorDayState;
    /** The measured half of a mixed day; null on any other day. */
    measuredSolarWh: number | null;
    /** The house's actual vs predicted energy; only on a fully elapsed day. */
    house: SolarInspectorDayHouse | null;
}

/** A past day, rebuilt from what the inspector measured for it. */
export interface SolarInspectorHistoryDay {
    dayKey: string;
    aggregate: ScheduleTableDayAggregateModel | null;
    availability: SolarInspectorDayPillAvailability;
    house: SolarInspectorDayHouse | null;
}

export interface SolarInspectorDayPillModel {
    pills: readonly SolarInspectorDayPill[];
    scale: ScheduleTableDayAggregateScale;
    /** The largest house figure, actual or predicted, across the pills. */
    houseMaxWh: number;
}

export const EMPTY_DAY_PILL_MODEL: SolarInspectorDayPillModel = {
    pills: [],
    scale: { solarMaxWh: 0, gridMaxKwh: 0, priceMaxAbs: 0 },
    houseMaxWh: 0,
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
        cursor = addDays(cursor, 1);
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
 * This is HA's `firstWeekdayIndex` (`common/datetime/first_weekday`)
 * reimplemented rather than imported, and the reason is mechanical: that module
 * falls back to the `weekstart` package, which is a dependency of HA's
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
        };
    });

    // The scale spans the pills alone, not the schedule card's day set: the row
    // is read against itself.
    const forecast = buildScheduleTableForecastMeta({
        slotForecastMap,
        sections,
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
        dayState: "forecast",
        measuredSolarWh: null,
        house: null,
    }));

    // The schedule and the forecast only reach forward, so a past day's pill can
    // only say what was measured. Those days take their measurements in place;
    // a measured day the row does not offer is simply not drawn.
    let scale = forecast.dayAggregateScale;
    let houseMaxWh = 0;
    const pillIndexByDayKey = new Map(pills.map((pill, index) => [pill.dayKey, index]));
    for (const historyDay of historyDays) {
        const index = pillIndexByDayKey.get(historyDay.dayKey);
        if (index === undefined) {
            continue;
        }
        const forecastPill = pills[index];
        // Only a day that is over: today's forecast covers the whole day and
        // its actual only the part lived through, so the two do not compare.
        const house = currentDayKey !== null && historyDay.dayKey < currentDayKey
            ? historyDay.house
            : null;
        houseMaxWh = Math.max(houseMaxWh, house?.actualWh ?? 0, house?.forecastWh ?? 0);
        // A day measured for its house alone leaves the rest of the pill to the
        // forecast, exactly as if it had not been measured at all.
        if (historyDay.aggregate === null) {
            pills[index] = { ...forecastPill, house };
            continue;
        }
        // Only today mixes, and only when both halves are actually there: a
        // measured day behind the row has no forecast left to add, and a today
        // the schedule does not reach is a measurement and nothing more.
        const mixed = historyDay.dayKey === currentDayKey
            && forecastPill.aggregate !== null;
        const aggregate = mixed
            ? _mergeMeasuredWithForecast(historyDay.aggregate!, forecastPill.aggregate!)
            : historyDay.aggregate;
        pills[index] = {
            dayKey: historyDay.dayKey,
            label: forecastPill.label,
            aggregate,
            availability: mixed
                ? {
                    battery: historyDay.availability.battery || forecastPill.availability.battery,
                    solar: historyDay.availability.solar || forecastPill.availability.solar,
                    grid: historyDay.availability.grid || forecastPill.availability.grid,
                }
                : historyDay.availability,
            dayState: mixed ? "mixed" : "measured",
            measuredSolarWh: mixed ? historyDay.aggregate!.solarWh : null,
            house,
        };
        // What was measured belongs on the same scale as what is forecast:
        // yesterday's sun is only worth showing next to tomorrow's if the two
        // bars mean the same thing. Today goes on it as the merged day, so the
        // scale covers what today is expected to reach and not the part of it
        // that has happened.
        scale = _extendScaleWithAggregate(scale, aggregate);
    }

    return { pills, scale, houseMaxWh };
}

/** One day of `helman/solar_bias/day_aggregates`. */
export type SolarInspectorDayAggregateRow = Pick<DayAggregateRow,
    "date" | "solarWh" | "gridImportKwh" | "gridExportKwh" | "batteryMinSocPct" | "batteryMaxSocPct" | "houseForecastWh">
    & Partial<Pick<DayAggregateRow, "houseWh">>;

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
        const houseActualWh = _finiteOrNull(row.houseWh);
        const houseForecastWh = _finiteOrNull(row.houseForecastWh);
        const hasHouse = houseActualWh !== null || houseForecastWh !== null;
        if (!hasSolar && !hasBattery && !hasGrid && !hasHouse) {
            continue;
        }

        days.push({
            dayKey: row.date,
            // A day with house figures alone is kept for its house gauge; the
            // pill builder leaves the rest of such a day to the forecast.
            aggregate: !hasSolar && !hasBattery && !hasGrid ? null : {
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
            house: hasHouse ? { actualWh: houseActualWh, forecastWh: houseForecastWh } : null,
        });
    }
    return days;
}

/**
 * Today's two halves as one day.
 *
 * Solar and the grid meters add up, because the two sides describe disjoint
 * parts of the day; the SoC band is the union of the two ranges, because the
 * battery's day is where it has been *and* where it is going. Surplus and the
 * prices are forecast properties -- nothing measures a plan's headroom after
 * the fact -- so they come from the forecast half alone.
 */
/** Energy stays in Wh while the two halves are combined. */
interface DayEnergyWh {
    solarWh: number | null;
    gridImportWh: number | null;
    gridExportWh: number | null;
    availableSurplusWh: number | null;
}

function _energyWh(row: ScheduleTableDayAggregateModel): DayEnergyWh {
    return {
        solarWh: row.solarWh,
        gridImportWh: row.gridImportKwh === null ? null : row.gridImportKwh * 1000,
        gridExportWh: row.gridExportKwh === null ? null : row.gridExportKwh * 1000,
        availableSurplusWh: row.availableSurplusKwh === null ? null : row.availableSurplusKwh * 1000,
    };
}

/** The shared gauge model is the presentation boundary, which still uses kWh. */
function _energyForGauge(row: DayEnergyWh): Pick<ScheduleTableDayAggregateModel,
    "solarWh" | "gridImportKwh" | "gridExportKwh" | "availableSurplusKwh"> {
    return {
        solarWh: row.solarWh,
        gridImportKwh: row.gridImportWh === null ? null : row.gridImportWh / 1000,
        gridExportKwh: row.gridExportWh === null ? null : row.gridExportWh / 1000,
        availableSurplusKwh: row.availableSurplusWh === null ? null : row.availableSurplusWh / 1000,
    };
}

function _mergeMeasuredWithForecast(
    measured: ScheduleTableDayAggregateModel,
    forecast: ScheduleTableDayAggregateModel,
): ScheduleTableDayAggregateModel {
    const actual = _energyWh(measured);
    const expected = _energyWh(forecast);
    const sum = (a: number, b: number) => a + b;
    return {
        ...forecast,
        ..._energyForGauge({
            solarWh: _combine(actual.solarWh, expected.solarWh, sum),
            gridImportWh: _combine(actual.gridImportWh, expected.gridImportWh, sum),
            gridExportWh: _combine(actual.gridExportWh, expected.gridExportWh, sum),
            availableSurplusWh: expected.availableSurplusWh,
        }),
        batteryMinSocPct: _combine(measured.batteryMinSocPct, forecast.batteryMinSocPct, Math.min),
        batteryMaxSocPct: _combine(measured.batteryMaxSocPct, forecast.batteryMaxSocPct, Math.max),
    };
}

/** Either value where the other is missing: a half-known metric is still known. */
function _combine(
    measured: number | null,
    forecast: number | null,
    merge: (a: number, b: number) => number,
): number | null {
    if (measured === null) return forecast;
    if (forecast === null) return measured;
    return merge(measured, forecast);
}

/**
 * The scale of just the days named, falling back to the row's own.
 *
 * The continuous calendar buffers about three months so it can be scrolled
 * without reloading, and one bright summer day anywhere in that buffer flattens
 * every autumn pill against it -- including today, whose bar then stops matching
 * the figures written on it. What a reader compares is what they can see, so the
 * scrolling calendar scales to the days on screen rather than to the buffer
 * behind them. A viewport whose days carry no figures at all keeps the row's
 * scale: a zero scale draws no bars, which is worse than bars drawn against a
 * day just out of view.
 *
 * Price is not derived here. It comes from the slots rather than from a day's
 * aggregate, and the pills draw no price bar -- the row's value is carried
 * through so the scale stays one whole thing.
 */
export function buildDayPillScaleForDays(
    pills: readonly SolarInspectorDayPill[],
    dayKeys: ReadonlySet<string>,
    rowScale: ScheduleTableDayAggregateScale,
): ScheduleTableDayAggregateScale {
    let scale: ScheduleTableDayAggregateScale = {
        solarMaxWh: 0,
        gridMaxKwh: 0,
        priceMaxAbs: rowScale.priceMaxAbs,
    };
    let drawn = false;
    for (const pill of pills) {
        if (!dayKeys.has(pill.dayKey) || pill.aggregate === null) {
            continue;
        }
        drawn = true;
        scale = _extendScaleWithAggregate(scale, pill.aggregate);
    }

    return drawn ? scale : rowScale;
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

function _finiteOrNull(value: number | null | undefined): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function _isDayKey(value: string): boolean {
    return parseDayKey(value) !== null;
}

const ZERO_PRICE_RANGE_THRESHOLD = 0.05;

function aggregateScheduleDayForecast({
    slots,
    slotForecastMap,
}: {
    slots: readonly ScheduleDisplaySlot[];
    slotForecastMap: SlotForecastMap;
}): ScheduleTableDayAggregateModel | null {
    const energy = _aggregateScheduleForecast({ slots, slotForecastMap });
    const aggregate = energy === null ? null : _energyForGauge(energy);
    const batteryRange = _aggregateScheduleDayBatteryRange({ slots, slotForecastMap });
    const priceRange = _aggregateScheduleDayPriceRange({ slots, slotForecastMap });
    if (aggregate === null && batteryRange.hasData === false && priceRange.priceHasData === false) {
        return null;
    }

    return batteryRange.hasData === false
        && (aggregate?.solarWh ?? null) === null
        && (aggregate?.gridImportKwh ?? null) === null
        && (aggregate?.gridExportKwh ?? null) === null
        && (aggregate?.availableSurplusKwh ?? null) === null
        && priceRange.priceHasData === false
        ? null
        : {
            batteryMinSocPct: batteryRange.minSocPct,
            batteryMaxSocPct: batteryRange.maxSocPct,
            solarWh: aggregate?.solarWh ?? null,
            gridImportKwh: aggregate?.gridImportKwh ?? null,
            gridExportKwh: aggregate?.gridExportKwh ?? null,
            availableSurplusKwh: aggregate?.availableSurplusKwh ?? null,
            priceHasData: priceRange.priceHasData,
            pricePositiveMin: priceRange.pricePositiveMin,
            pricePositiveMax: priceRange.pricePositiveMax,
            priceNegativeMin: priceRange.priceNegativeMin,
            priceNegativeMax: priceRange.priceNegativeMax,
        };
}

function _aggregateScheduleDayBatteryRange({
    slots,
    slotForecastMap,
}: {
    slots: readonly ScheduleDisplaySlot[];
    slotForecastMap: SlotForecastMap;
}): { hasData: boolean; minSocPct: number | null; maxSocPct: number | null } {
    let minSocPct: number | null = null;
    let maxSocPct: number | null = null;

    for (const slot of slots) {
        const socPct = slotForecastMap.points.get(slot.id)?.socPct;
        if (socPct === null || socPct === undefined) {
            continue;
        }

        minSocPct = minSocPct === null ? socPct : Math.min(minSocPct, socPct);
        maxSocPct = maxSocPct === null ? socPct : Math.max(maxSocPct, socPct);
    }

    return {
        hasData: minSocPct !== null && maxSocPct !== null,
        minSocPct,
        maxSocPct,
    };
}

function buildScheduleTableForecastMeta({
    slotForecastMap,
    sections,
}: {
    slotForecastMap: SlotForecastMap;
    sections: readonly ScheduleTableSectionModel[];
}): ScheduleTableForecastMeta {
    let dayAggregateScale: ScheduleTableDayAggregateScale = { solarMaxWh: 0, gridMaxKwh: 0, priceMaxAbs: 0 };
    for (const section of sections) {
        const aggregate = section.dayAggregate;
        dayAggregateScale = _extendScaleWithAggregate(dayAggregateScale, aggregate);
        if (aggregate) dayAggregateScale.priceMaxAbs = Math.max(
            dayAggregateScale.priceMaxAbs,
            ...[aggregate.pricePositiveMin, aggregate.pricePositiveMax, aggregate.priceNegativeMin, aggregate.priceNegativeMax].map(value => Math.abs(value ?? 0)),
        );
    }

    return {
        batteryAvailable: slotForecastMap.batteryAvailable,
        solarAvailable: slotForecastMap.solarAvailable,
        gridAvailable: slotForecastMap.gridAvailable,
        priceAvailable: slotForecastMap.priceAvailable,
        priceDisplayUnit: slotForecastMap.priceDisplayUnit,
        dayAggregateScale,
    };
}

function _aggregateScheduleDayPriceRange({
    slots,
    slotForecastMap,
}: {
    slots: readonly ScheduleDisplaySlot[];
    slotForecastMap: SlotForecastMap;
}): Pick<
    ScheduleTableDayAggregateModel,
    "priceHasData" | "pricePositiveMin" | "pricePositiveMax" | "priceNegativeMin" | "priceNegativeMax"
> {
    let priceHasData = false;
    let pricePositiveMin: number | null = null;
    let pricePositiveMax: number | null = null;
    let priceNegativeMin: number | null = null;
    let priceNegativeMax: number | null = null;

    for (const slot of slots) {
        const price = slotForecastMap.points.get(slot.id)?.price;
        if (price === null || price === undefined) {
            continue;
        }

        priceHasData = true;

        if (price > ZERO_PRICE_RANGE_THRESHOLD) {
            pricePositiveMin = pricePositiveMin === null ? price : Math.min(pricePositiveMin, price);
            pricePositiveMax = pricePositiveMax === null ? price : Math.max(pricePositiveMax, price);
            continue;
        }

        if (price < -ZERO_PRICE_RANGE_THRESHOLD) {
            priceNegativeMin = priceNegativeMin === null ? price : Math.min(priceNegativeMin, price);
            priceNegativeMax = priceNegativeMax === null ? price : Math.max(priceNegativeMax, price);
        }
    }

    return {
        priceHasData,
        pricePositiveMin,
        pricePositiveMax,
        priceNegativeMin,
        priceNegativeMax,
    };
}

function _aggregateScheduleForecast({
    slots,
    slotForecastMap,
}: {
    slots: readonly ScheduleDisplaySlot[];
    slotForecastMap: SlotForecastMap;
}): DayEnergyWh | null {
    if (slots.length === 0) {
        return null;
    }

    let solarTotal = 0;
    let hasSolar = false;
    let gridImportTotal = 0;
    let gridExportTotal = 0;
    let availableSurplusTotal = 0;
    let hasGrid = false;
    let hasAvailableSurplus = false;

    for (const slot of slots) {
        const point = slotForecastMap.points.get(slot.id);
        if (!point) {
            continue;
        }

        if (point.solarWh !== null) {
            solarTotal += point.solarWh;
            hasSolar = true;
        }

        if (
            point.gridImportKwh !== null
            || point.gridExportKwh !== null
            || point.availableSurplusKwh !== null
        ) {
            gridImportTotal += (point.gridImportKwh ?? 0) * 1000;
            gridExportTotal += (point.gridExportKwh ?? 0) * 1000;
            hasGrid = true;
        }

        if (point.availableSurplusKwh !== null) {
            availableSurplusTotal += point.availableSurplusKwh * 1000;
            hasAvailableSurplus = true;
        }

    }

    return {
        solarWh: hasSolar ? solarTotal : null,
        gridImportWh: hasGrid ? gridImportTotal : null,
        gridExportWh: hasGrid ? gridExportTotal : null,
        availableSurplusWh: hasAvailableSurplus ? availableSurplusTotal : null,
    };
}
