import type {
    ApplianceRuntimeDTO,
    InverterRuntimeDTO,
    SchedulePayload,
} from "../../helman-api";
import type {
    NormalizedScheduleModel,
    ScheduleApplianceRuntime,
    ScheduleInverterRuntime,
    ScheduleRuntime,
    ScheduleSlot,
} from "../schedule-types";
import {
    cloneScheduleInverterAction,
    cloneScheduleRuntime,
} from "../schedule-types";
import {
    extractScheduleSlotAssignments,
} from "./schedule-authorship";
import {
    deriveScheduleGranularityMinutes,
    getScheduleDayKey,
    getScheduleSlotDayKey,
    getScheduleSlotStartMs,
    getScheduleTimeRangeLabels,
    resolveScheduleSlotBoundaries,
} from "./schedule-time";

export function normalizeSchedulePayload({
    schedule,
    timeZone,
    locale,
    now = new Date(),
}: {
    schedule: SchedulePayload | null;
    timeZone: string;
    locale: string;
    now?: Date;
}): NormalizedScheduleModel {
    return applyNormalizedScheduleCurrentState(
        buildNormalizedScheduleStructure({
            schedule,
            timeZone,
            locale,
        }),
        timeZone,
        now,
    );
}

export function buildNormalizedScheduleStructure({
    schedule,
    timeZone,
    locale,
}: {
    schedule: SchedulePayload | null;
    timeZone: string;
    locale: string;
}): NormalizedScheduleModel {
    if (schedule === null) {
        return {
            slots: [],
            currentSlotId: null,
            currentDayKey: null,
            granularityMinutes: null,
        };
    }

    const granularityMinutes = deriveScheduleGranularityMinutes(schedule.slots.map((slot) => slot.id));
    const slotDurationMs = granularityMinutes !== null ? granularityMinutes * 60_000 : null;
    const slotBoundaries = resolveScheduleSlotBoundaries(schedule.slots.map((slot) => slot.id));
    const slotBoundariesByMs = new Map(slotBoundaries.map((slot) => [slot.startMs, slot]));
    const seenMs = new Set<number>();
    const normalizedRuntime = _normalizeScheduleRuntime(schedule.runtime);
    const runtimeSlotId = normalizedRuntime?.slotId ?? null;
    const normalizedSlots = schedule.slots
        .flatMap((slot) => {
            const startMs = getScheduleSlotStartMs(slot.id);
            if (startMs === null) {
                return [];
            }

            if (seenMs.has(startMs)) {
                return [];
            }
            seenMs.add(startMs);

            const boundary = slotBoundariesByMs.get(startMs);
            if (boundary === undefined) {
                return [];
            }

            return [_normalizeSlot({
                slot,
                boundary,
                slotDurationMs,
                timeZone,
                locale,
            })];
        })
        .sort((left, right) => left.startMs - right.startMs)
        .map((slot, index) => ({
            ...slot,
            index,
            isCurrent: false,
        }));

    return {
        slots: normalizedSlots.map((slot) => ({
            ...slot,
            runtime: slot.id === runtimeSlotId && normalizedRuntime !== null
                ? cloneScheduleRuntime(normalizedRuntime.runtime)
                : null,
        })),
        currentSlotId: runtimeSlotId,
        currentDayKey: null,
        granularityMinutes,
    };
}

export function applyNormalizedScheduleCurrentState(
    model: NormalizedScheduleModel,
    timeZone: string,
    now: Date = new Date(),
): NormalizedScheduleModel {
    if (model.slots.length === 0) {
        return model.currentSlotId === null && model.currentDayKey === null
            ? model
            : {
                ...model,
                currentSlotId: null,
                currentDayKey: null,
            };
    }

    const nowMs = now.getTime();
    const runtimeSlotId = model.slots.find((slot) => slot.runtime !== null)?.id ?? null;
    const currentSlotId = model.slots.find((slot) =>
        slot.startMs <= nowMs && (slot.endMs === null || nowMs < slot.endMs)
    )?.id
        ?? runtimeSlotId
        ?? null;
    const currentDayKey = getScheduleDayKey(now, timeZone);

    if (model.currentSlotId === currentSlotId && model.currentDayKey === currentDayKey) {
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
        currentDayKey,
    };
}

function _normalizeSlot({
    slot,
    boundary,
    slotDurationMs,
    timeZone,
    locale,
}: {
    slot: SchedulePayload["slots"][number];
    boundary: { startMs: number; endMs: number | null };
    slotDurationMs: number | null;
    timeZone: string;
    locale: string;
}): Omit<ScheduleSlot, "index" | "isCurrent"> {
    const dayKey = getScheduleSlotDayKey(slot.id, timeZone);
    if (dayKey === null) {
        throw new Error(`helman-scheduling: failed to derive day key for slot "${slot.id}"`);
    }

    const labels = getScheduleTimeRangeLabels({
        startMs: boundary.startMs,
        endMs: slotDurationMs !== null ? boundary.startMs + slotDurationMs : boundary.endMs,
        locale,
        timeZone,
    });
    return {
        id: slot.id,
        startMs: boundary.startMs,
        endMs: slotDurationMs !== null ? boundary.startMs + slotDurationMs : boundary.endMs,
        dayKey,
        timeLabel: labels.timeLabel,
        endLabel: labels.endLabel,
        rangeLabel: labels.rangeLabel,
        assignments: extractScheduleSlotAssignments(slot.domains, slot.id),
        runtime: null,
    };
}

function _normalizeScheduleRuntime(
    runtime: SchedulePayload["runtime"],
): { slotId: string; runtime: ScheduleRuntime } | null {
    if (runtime === undefined) {
        return null;
    }

    return {
        slotId: runtime.activeSlotId,
        runtime: {
            inverter: runtime.inverter
                ? _normalizeInverterRuntime(runtime.inverter)
                : null,
            appliances: Object.fromEntries(
                Object.entries(runtime.appliances).map(([applianceId, applianceRuntime]) => [
                    applianceId,
                    _normalizeApplianceRuntime(applianceRuntime),
                ]),
            ),
            reconciledAt: runtime.reconciledAt,
        },
    };
}

function _normalizeInverterRuntime(runtime: InverterRuntimeDTO): ScheduleInverterRuntime {
    return {
        actionKind: runtime.actionKind,
        outcome: runtime.outcome,
        reason: runtime.reason,
        errorCode: runtime.errorCode,
        message: runtime.message,
        executedAction: runtime.executedAction
            ? cloneScheduleInverterAction(runtime.executedAction)
            : undefined,
    };
}

function _normalizeApplianceRuntime(runtime: ApplianceRuntimeDTO): ScheduleApplianceRuntime {
    return {
        actionKind: runtime.actionKind,
        outcome: runtime.outcome,
        errorCode: runtime.errorCode,
        message: runtime.message,
        updatedAt: runtime.updatedAt,
    };
}
