import type { SchedulePayload } from "../../../helman-api";
import type {
    NormalizedScheduleModel,
    ScheduleSlot,
} from "../schedule-types";
import {
    extractScheduleSlotAssignments,
} from "./schedule-authorship";
import {
    getScheduleDayKey,
    getScheduleSlotStartMs,
    getScheduleTimeRangeLabels,
} from "./schedule-time";

export const EMPTY_NORMALIZED_SCHEDULE: NormalizedScheduleModel = {
    slots: [],
    activeSlotId: null,
    currentSlotId: null,
    currentDayKey: null,
    slotMinutes: null,
};

/**
 * The schedule structure with the expensive half memoised: the schedule as
 * slots, with the one the clock is inside marked.
 *
 * The structure is rebuilt only when the schedule itself changes, but which
 * slot is current is a fact about the clock, so it is re-applied on every
 * pass -- cheaply, since the model is returned unchanged when the answer has
 * not moved. Without it nothing is `isCurrent`, and the forecast's fallback
 * to the battery's live SoC and the live price -- the only readings the
 * in-progress slot has, since the projection starts at the next boundary --
 * never fires, leaving that slot blank in every chart drawn from it. The
 * day it belongs to goes unnamed too, which is what turns the editor's
 * "today" chip back into a date.
 *
 * **Load-bearing:** `get` returns the *same* `NormalizedScheduleModel` object
 * across calls for as long as neither the schedule, the time zone, nor the
 * current slot/day has moved -- `applyNormalizedScheduleCurrentState` returns
 * its argument unchanged in that case, and this cache holds on to it. Callers
 * key their own memos on that identity (the band strip's `_derivedFor.normalized`
 * is the worked example), so a "harmless" copy here rebuilds their entire
 * derived model on every render.
 *
 * `now` is a parameter, not `new Date()`, because the two callers legitimately
 * disagree about what the clock is: the day pills read the true wall clock,
 * while the band strip reads its own coarse 30 s `_nowMs` so that everything
 * derived from the clock moves in one step.
 */
export class NormalizedScheduleCache {
    private _model: NormalizedScheduleModel = EMPTY_NORMALIZED_SCHEDULE;
    private _for: { schedule: unknown; timeZone: string } | null = null;

    get(
        schedule: SchedulePayload | null,
        timeZone: string,
        locale: string,
        now: Date,
    ): NormalizedScheduleModel {
        if (
            this._for === null
            || this._for.schedule !== schedule
            || this._for.timeZone !== timeZone
        ) {
            this._model = buildNormalizedScheduleStructure({ schedule, timeZone, locale });
            this._for = { schedule, timeZone };
        }

        this._model = applyNormalizedScheduleCurrentState(this._model, timeZone, now);
        return this._model;
    }
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
            activeSlotId: null,
            currentSlotId: null,
            currentDayKey: null,
            slotMinutes: null,
        };
    }

    const { slotMinutes } = schedule;
    const slotDurationMs = slotMinutes * 60_000;
    const seenMs = new Set<number>();
    const activeSlotId = schedule.runtime?.activeSlotId ?? null;
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

            return [_normalizeSlot({
                slot,
                startMs,
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
        slots: normalizedSlots,
        activeSlotId,
        currentSlotId: activeSlotId,
        currentDayKey: null,
        slotMinutes,
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
    const runtimeSlotId = model.slots.find((slot) => slot.id === model.activeSlotId)?.id ?? null;
    const currentSlotId = model.slots.find((slot) =>
        slot.startMs <= nowMs && nowMs < slot.endMs
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
    startMs,
    slotDurationMs,
    timeZone,
    locale,
}: {
    slot: SchedulePayload["slots"][number];
    startMs: number;
    slotDurationMs: number;
    timeZone: string;
    locale: string;
}): Omit<ScheduleSlot, "index" | "isCurrent"> {
    const dayKey = getScheduleDayKey(slot.id, timeZone);
    if (dayKey === null) {
        throw new Error(`schedule: failed to derive day key for slot "${slot.id}"`);
    }

    const endMs = startMs + slotDurationMs;
    const labels = getScheduleTimeRangeLabels({
        startMs,
        endMs,
        locale,
        timeZone,
    });
    return {
        id: slot.id,
        startMs,
        endMs,
        dayKey,
        timeLabel: labels.timeLabel,
        endLabel: labels.endLabel,
        rangeLabel: labels.rangeLabel,
        assignments: extractScheduleSlotAssignments(slot.controllables, slot.id),
    };
}
