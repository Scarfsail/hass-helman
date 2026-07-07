import type {
    GridForecastBaselineDTO,
    GridForecastDTO,
    GridForecastSlotDTO,
} from "../../helman-api";
import { getCachedLocalDateTimeParts } from "./local-date-time-parts-cache";

export type GridEnergySlotSource = "forecast" | "gap";

export interface GridEnergyForecastSlot {
    source: GridEnergySlotSource;
    timestamp: string;
    endsAt: string;
    durationHours: number;
    importedFromGridKwh: number;
    exportedToGridKwh: number;
    netKwh: number;
    baseline: GridForecastBaselineDTO | null;
}

export interface GridEnergyForecastDay {
    dayKey: string;
    isToday: boolean;
    isTomorrow: boolean;
    coverageEndsAt: string;
    coversDayEnd: boolean;
    importedDayKwh: number;
    exportedDayKwh: number;
    netDayKwh: number;
    slots: GridEnergyForecastSlot[];
}

export function buildGridEnergyForecastModel({
    gridForecast,
    timeZone,
    now = new Date(),
}: {
    gridForecast: GridForecastDTO | null;
    timeZone: string;
    now?: Date;
}): GridEnergyForecastDay[] {
    const currentLocalParts = getCachedLocalDateTimeParts(now, timeZone);
    if (currentLocalParts === null) {
        return [];
    }

    const todayKey = currentLocalParts.dayKey;
    const tomorrowKey = _addDaysToDayKey(todayKey, 1);
    const dayMap = _groupForecastSlotsByDay(
        (gridForecast?.series ?? []).map(_mapGridForecastSlot),
        timeZone,
        todayKey,
    );

    return Array.from(dayMap.entries())
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([dayKey, slots]) => {
            const sortedSlots = [...slots].sort((left, right) =>
                new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()
            );
            const lastSlot = sortedSlots[sortedSlots.length - 1];
            const coverageEndsAt = lastSlot?.endsAt ?? _addHour(`${dayKey}T00:00:00Z`);
            const coverageEndLocalParts = getCachedLocalDateTimeParts(coverageEndsAt, timeZone);

            return {
                dayKey,
                isToday: dayKey === todayKey,
                isTomorrow: dayKey === tomorrowKey,
                coverageEndsAt,
                coversDayEnd: coverageEndLocalParts !== null && coverageEndLocalParts.dayKey > dayKey,
                importedDayKwh: sortedSlots.reduce((sum, slot) => sum + slot.importedFromGridKwh, 0),
                exportedDayKwh: sortedSlots.reduce((sum, slot) => sum + slot.exportedToGridKwh, 0),
                netDayKwh: sortedSlots.reduce((sum, slot) => sum + slot.netKwh, 0),
                slots: sortedSlots,
            };
        });
}

export function buildEmptyGridEnergySlot(timestamp: string, endsAt: string | null = null): GridEnergyForecastSlot {
    return {
        source: "gap",
        timestamp,
        endsAt: endsAt ?? _addHour(timestamp),
        durationHours: 1,
        importedFromGridKwh: 0,
        exportedToGridKwh: 0,
        netKwh: 0,
        baseline: null,
    };
}

function _mapGridForecastSlot(slot: GridForecastSlotDTO): GridEnergyForecastSlot {
    return {
        source: "forecast",
        timestamp: slot.timestamp,
        endsAt: _computeSlotEnd(slot.timestamp, slot.durationHours),
        durationHours: slot.durationHours,
        importedFromGridKwh: slot.importedFromGridKwh,
        exportedToGridKwh: slot.exportedToGridKwh,
        netKwh: slot.exportedToGridKwh - slot.importedFromGridKwh,
        baseline: slot.baseline ?? null,
    };
}

function _groupForecastSlotsByDay(
    slots: GridEnergyForecastSlot[],
    timeZone: string,
    todayKey: string,
): Map<string, GridEnergyForecastSlot[]> {
    const dayMap = new Map<string, GridEnergyForecastSlot[]>();
    for (const slot of slots) {
        const slotLocalParts = getCachedLocalDateTimeParts(slot.timestamp, timeZone);
        if (slotLocalParts === null || slotLocalParts.dayKey < todayKey) {
            continue;
        }

        const daySlots = dayMap.get(slotLocalParts.dayKey) ?? [];
        daySlots.push(slot);
        dayMap.set(slotLocalParts.dayKey, daySlots);
    }

    return dayMap;
}

function _computeSlotEnd(timestamp: string, durationHours: number): string {
    const startMs = new Date(timestamp).getTime();
    if (Number.isNaN(startMs)) {
        return timestamp;
    }

    return new Date(startMs + durationHours * 3600000).toISOString();
}

function _addHour(timestamp: string): string {
    const parsed = new Date(timestamp).getTime();
    if (Number.isNaN(parsed)) {
        return timestamp;
    }

    return new Date(parsed + 3600000).toISOString();
}

function _addDaysToDayKey(dayKey: string, days: number): string {
    const date = new Date(`${dayKey}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}
