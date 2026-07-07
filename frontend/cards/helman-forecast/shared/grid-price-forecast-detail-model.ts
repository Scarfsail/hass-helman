import type { ForecastPointDTO, GridForecastDTO } from "../../helman-api";
import { getLocalHourKey } from "./local-day-hour-axis";
import { getCachedLocalDateTimeParts } from "./local-date-time-parts-cache";

export interface GridPriceForecastDayModel {
    dayKey: string;
    isToday: boolean;
    isTomorrow: boolean;
    currentPrice: number | null;
    priceMin: number | null;
    priceMax: number | null;
    priceHours: ForecastPointDTO[];
    hasPriceData: boolean;
}

export function buildGridPriceForecastDetailModel({
    gridForecast,
    timeZone,
    now = new Date(),
}: {
    gridForecast: GridForecastDTO | null;
    timeZone: string;
    now?: Date;
}): GridPriceForecastDayModel[] {
    const currentLocalParts = getCachedLocalDateTimeParts(now, timeZone);
    if (currentLocalParts === null) {
        return [];
    }

    const todayKey = currentLocalParts.dayKey;
    const tomorrowKey = _addDaysToDayKey(todayKey, 1);
    const currentHourKey = getLocalHourKey(now, timeZone);
    const priceDayMap = _groupPointsByDay(
        gridForecast?.exportPricePoints ?? [],
        timeZone,
        todayKey,
    );
    if (!priceDayMap.has(todayKey) && gridForecast?.currentExportPrice !== null) {
        priceDayMap.set(todayKey, []);
    }

    return Array.from(priceDayMap.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([dayKey, dayPriceHours]) => {
            const currentPrice = dayKey === todayKey ? gridForecast?.currentExportPrice ?? null : null;
            const priceHours = _mergeCurrentPriceHour(
                dayPriceHours,
                currentPrice,
                dayKey === todayKey ? currentHourKey : null,
                timeZone,
            );

            return {
                dayKey,
                isToday: dayKey === todayKey,
                isTomorrow: dayKey === tomorrowKey,
                currentPrice,
                priceMin: priceHours.length > 0
                    ? Math.min(...priceHours.map((point) => point.value))
                    : null,
                priceMax: priceHours.length > 0
                    ? Math.max(...priceHours.map((point) => point.value))
                    : null,
                priceHours,
                hasPriceData: priceHours.length > 0,
            };
        });
}

function _groupPointsByDay(
    points: ForecastPointDTO[],
    timeZone: string,
    currentLocalDayKey?: string,
): Map<string, ForecastPointDTO[]> {
    const dayMap = new Map<string, ForecastPointDTO[]>();

    for (const point of points) {
        const pointLocalParts = getCachedLocalDateTimeParts(point.timestamp, timeZone);
        if (pointLocalParts === null) {
            continue;
        }

        if (currentLocalDayKey !== undefined && pointLocalParts.dayKey < currentLocalDayKey) {
            continue;
        }

        const dayPoints = dayMap.get(pointLocalParts.dayKey) ?? [];
        dayPoints.push(point);
        dayMap.set(pointLocalParts.dayKey, dayPoints);
    }

    for (const [dayKey, dayPoints] of dayMap.entries()) {
        dayMap.set(dayKey, [...dayPoints].sort(_comparePointsByTimestamp));
    }

    return dayMap;
}

function _mergeCurrentPriceHour(
    points: readonly ForecastPointDTO[],
    currentPrice: number | null,
    currentHourKey: string | null,
    timeZone: string,
): ForecastPointDTO[] {
    if (currentPrice === null || currentHourKey === null) {
        return [...points];
    }

    if (points.some((point) => getLocalHourKey(point.timestamp, timeZone) === currentHourKey)) {
        return [...points];
    }

    return [
        ...points,
        {
            timestamp: currentHourKey,
            value: currentPrice,
        },
    ].sort(_comparePointsByTimestamp);
}

function _addDaysToDayKey(dayKey: string, days: number): string {
    const date = new Date(`${dayKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function _comparePointsByTimestamp(a: ForecastPointDTO, b: ForecastPointDTO): number {
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
}
