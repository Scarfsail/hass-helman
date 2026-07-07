import type { ForecastPayload } from "../../helman-api";
import { getEffectiveSolarForecastPoints } from "../../helman-api";
import type {
    NormalizedScheduleModel,
    ScheduleDisplaySlot,
    ScheduleTimelineModel,
} from "../schedule-types";
import { getScheduleDayKey, getScheduleTimeRangeLabels } from "./schedule-time";

export function buildScheduleTimelineModel({
    normalizedSchedule,
    forecast,
    locale,
    timeZone,
    now = new Date(),
}: {
    normalizedSchedule: NormalizedScheduleModel;
    forecast: ForecastPayload | null;
    locale: string;
    timeZone: string;
    now?: Date;
}): ScheduleTimelineModel {
    return applyScheduleTimelineCurrentState(
        buildScheduleTimelineStructure({
            normalizedSchedule,
            forecast,
            locale,
            timeZone,
        }),
        now,
    );
}

export function buildScheduleTimelineStructure({
    normalizedSchedule,
    forecast,
    locale,
    timeZone,
}: {
    normalizedSchedule: NormalizedScheduleModel;
    forecast: ForecastPayload | null;
    locale: string;
    timeZone: string;
}): ScheduleTimelineModel {
    const scheduleSlots = normalizedSchedule.slots;
    if (scheduleSlots.length === 0) {
        return {
            slots: [],
            currentSlotId: null,
        };
    }

    const granularityMinutes = normalizedSchedule.granularityMinutes;
    if (granularityMinutes === null) {
        const slots = scheduleSlots.map<ScheduleDisplaySlot>((slot) => ({
            source: "schedule",
            id: slot.id,
            startMs: slot.startMs,
            endMs: slot.endMs,
            dayKey: slot.dayKey,
                timeLabel: slot.timeLabel,
                endLabel: slot.endLabel,
                rangeLabel: slot.rangeLabel,
                isCurrent: false,
                scheduleSlot: slot,
            }));
        return {
            slots,
            currentSlotId: null,
        };
    }

    const slotDurationMs = granularityMinutes * 60_000;
    const scheduleSlotsByStart = new Map(scheduleSlots.map((slot) => [slot.startMs, slot]));
    const firstStartMs = scheduleSlots[0].startMs;
    const lastScheduleEndMs = scheduleSlots.reduce(
        (latest, slot) => Math.max(latest, slot.endMs ?? (slot.startMs + slotDurationMs)),
        firstStartMs + slotDurationMs,
    );
    const forecastEndMs = _resolveForecastTimelineEndMs(forecast, slotDurationMs);
    const timelineEndMs = Math.max(lastScheduleEndMs, forecastEndMs ?? lastScheduleEndMs);

    const slots: ScheduleDisplaySlot[] = [];
    for (let startMs = firstStartMs; startMs < timelineEndMs; startMs += slotDurationMs) {
        const endMs = startMs + slotDurationMs;
        const scheduleSlot = scheduleSlotsByStart.get(startMs);
        if (scheduleSlot) {
            slots.push({
                source: "schedule",
                id: scheduleSlot.id,
                startMs: scheduleSlot.startMs,
                endMs: scheduleSlot.endMs,
                dayKey: scheduleSlot.dayKey,
                timeLabel: scheduleSlot.timeLabel,
                endLabel: scheduleSlot.endLabel,
                rangeLabel: scheduleSlot.rangeLabel,
                isCurrent: false,
                scheduleSlot,
            });
            continue;
        }

        const dayKey = getScheduleDayKey(new Date(startMs), timeZone);
        if (dayKey === null) {
            continue;
        }

        const labels = getScheduleTimeRangeLabels({
            startMs,
            endMs,
            locale,
            timeZone,
        });
        slots.push({
            source: "forecast_only",
            id: `forecast_only:${new Date(startMs).toISOString()}`,
            startMs,
            endMs,
            dayKey,
            timeLabel: labels.timeLabel,
            endLabel: labels.endLabel,
            rangeLabel: labels.rangeLabel,
            isCurrent: false,
            scheduleSlot: null,
        });
    }

    return {
        slots,
        currentSlotId: null,
    };
}

export function applyScheduleTimelineCurrentState(
    model: ScheduleTimelineModel,
    now: Date = new Date(),
): ScheduleTimelineModel {
    if (model.slots.length === 0) {
        return model.currentSlotId === null
            ? model
            : {
                ...model,
                currentSlotId: null,
            };
    }

    const nowMs = now.getTime();
    const currentSlotId = model.slots.find((slot) => _isCurrentSlot(slot.startMs, slot.endMs, nowMs))?.id ?? null;
    if (model.currentSlotId === currentSlotId) {
        return model;
    }

    return {
        ...model,
        slots: model.slots.map((slot) => {
            const isCurrent = slot.id === currentSlotId;
            return slot.isCurrent === isCurrent
                ? slot
                : {
                    ...slot,
                    isCurrent,
                };
        }),
        currentSlotId,
    };
}

function _resolveForecastTimelineEndMs(
    forecast: ForecastPayload | null,
    slotDurationMs: number,
): number | null {
    if (forecast === null) {
        return null;
    }

    const endCandidates = [
        _parseTimestamp(forecast.grid.coverageUntil),
        _parseTimestamp(forecast.battery_capacity.coverageUntil),
        ...getEffectiveSolarForecastPoints(forecast.solar).map((point) => _parseTimestamp(point.timestamp, slotDurationMs)),
        ...forecast.grid.exportPricePoints.map((point) => _parseTimestamp(point.timestamp, slotDurationMs)),
        ...forecast.grid.series.map((point) => _parseTimestamp(point.timestamp, point.durationHours * 3_600_000)),
        ...forecast.battery_capacity.series.map((point) => _parseTimestamp(point.timestamp, point.durationHours * 3_600_000)),
    ].filter((value): value is number => value !== null);

    if (endCandidates.length === 0) {
        return null;
    }

    return Math.max(...endCandidates);
}

function _parseTimestamp(value: string | null | undefined, durationMs = 0): number | null {
    if (!value) {
        return null;
    }

    const startMs = new Date(value).getTime();
    if (Number.isNaN(startMs)) {
        return null;
    }

    return startMs + durationMs;
}

function _isCurrentSlot(startMs: number, endMs: number | null, nowMs: number): boolean {
    return startMs <= nowMs && (endMs === null || nowMs < endMs);
}
