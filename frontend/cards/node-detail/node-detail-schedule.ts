import { html, nothing, type TemplateResult } from "lit";
import type { ControllableRuntimeDTO, InverterRuntimeDTO, ScheduleActionDTO, SchedulePayload, ScheduleSlotDTO } from "../helman-api";
import type { LocalizeFunction } from "../localize/localize";
import {
    addDaysToDayKey,
    getScheduleDayKey,
    resolveScheduleSlotBoundaries,
} from "../shared/schedule/model/schedule-time";
import { getScheduleActionLabel, getScheduleReasonLabel } from "../shared/schedule/model/schedule-labels";
import { INVERTER_CONTROLLABLE_ID } from "../shared/schedule/schedule-types";
import { SLOT_MS } from "../shared/time/slot-time";

/**
 * The plan as the node details read it: one controllable's runs of equal
 * actions, the executor's record for the slot in progress and, for the
 * inverter, the run in progress and the next change.
 *
 * The inverter's plan is the inverter controllable's, whichever node shows it,
 * so the battery and solar details read it through the same functions and the
 * same strings as the inverter detail.
 */

export interface ScheduleRun<A = ScheduleActionDTO> {
    startMs: number;
    endMs: number | null;
    action: A;
}

/**
 * Controllable `id`'s actions in the slots `boundaries` name, merged into
 * runs: consecutive slots whose actions are `same` as the run's first. A slot
 * whose action `include` refuses ends a run; one without an action does too,
 * unless `fillEmpty` reads it as an empty stretch.
 */
export function mergeRuns<A>(
    boundaries: ReadonlyArray<{ id: string; startMs: number }>,
    slotsById: ReadonlyMap<string, ScheduleSlotDTO>,
    id: string,
    include: (action: A) => boolean,
    same: (left: A, right: A) => boolean,
    { fillEmpty = false }: { fillEmpty?: boolean } = {},
): ScheduleRun<A>[] {
    const runs: ScheduleRun<A>[] = [];
    for (const { id: slotId, startMs } of boundaries) {
        const action = (slotsById.get(slotId)?.controllables[id] as A | undefined)
            ?? (fillEmpty ? { kind: "empty" } as A : undefined);
        if (action === undefined || !include(action)) continue;
        const endMs = startMs + SLOT_MS;
        const last = runs[runs.length - 1];
        if (last && last.endMs === startMs && same(last.action, action)) {
            last.endMs = endMs;
        } else {
            runs.push({ startMs, endMs, action });
        }
    }
    return runs;
}

/** The runs still going at `now` that started before it, today or tomorrow. */
export function withinTodayTomorrow<R extends { startMs: number; endMs: number | null }>(runs: R[], now: number, timeZone: string): R[] {
    const days = todayAndTomorrow(now, timeZone);
    // A run started yesterday and still going is kept: it is running now.
    return runs.filter((run) => (run.endMs === null || run.endMs > now)
        && (run.startMs <= now || days.includes(dayKey(run.startMs, timeZone))));
}

/** The inverter's actions from the slot in progress at `now` on, merged into runs. */
export function inverterRuns(schedule: SchedulePayload, now: number): ScheduleRun[] {
    const boundaries = resolveScheduleSlotBoundaries(schedule.slots.map((slot) => slot.id))
        .filter((slot) => slot.startMs + SLOT_MS > now);
    const slotsById = new Map(schedule.slots.map((slot) => [slot.id, slot]));
    return mergeRuns<ScheduleActionDTO>(boundaries, slotsById, INVERTER_CONTROLLABLE_ID, () => true, sameAction, { fillEmpty: true });
}

/** The run in progress at `now`, unless it is an empty stretch. */
export function currentRun(runs: ScheduleRun[], now: number): ScheduleRun | null {
    const run = runs[0];
    return run && run.startMs <= now && run.action.kind !== "empty" ? run : null;
}

/** The executor's record for controllable `id`, only when it is for the slot in progress at `now`. */
export function runtimeFor<T extends ControllableRuntimeDTO>(schedule: SchedulePayload | null, id: string, now: number): T | null {
    const runtime = schedule?.runtime;
    if (!schedule || !runtime) return null;
    const slots = resolveScheduleSlotBoundaries(schedule.slots.map((slot) => slot.id));
    const current = slots.find((slot) => slot.startMs <= now && now < slot.startMs + SLOT_MS);
    if (!current || current.id !== runtime.activeSlotId) return null;
    return (runtime.controllables[id] as T | undefined) ?? null;
}

/**
 * The first run today or tomorrow whose effective mode differs from the
 * one before it. An empty stretch counts: the executor returns the
 * inverter to its normal mode there, so it is reported as `normal`.
 */
export function nextChange(runs: ScheduleRun[], now: number, timeZone: string): ScheduleRun | null {
    const days = todayAndTomorrow(now, timeZone);
    // Before the first scheduled slot the inverter rests in normal mode.
    let previous: ScheduleActionDTO = { kind: "normal" };
    for (const run of runs) {
        const action = effectiveAction(run.action);
        if (run.startMs > now && !sameAction(previous, action)) {
            return days.includes(dayKey(run.startMs, timeZone)) ? { ...run, action } : null;
        }
        previous = action;
    }
    return null;
}

/** Local calendar days, so a 25-hour DST day still has a tomorrow. */
export function todayAndTomorrow(now: number, timeZone: string): [string | null, string | null] {
    const today = dayKey(now, timeZone);
    return [today, today === null ? null : addDaysToDayKey(today, 1)];
}

export function dayKey(ms: number, timeZone: string): string | null {
    return getScheduleDayKey(new Date(ms), timeZone);
}

/**
 * What the inverter does in a run: an empty stretch is its normal mode, and so
 * is a candidate whose condition is not met, which the executor strips.
 */
export function effectiveAction(action: ScheduleActionDTO): ScheduleActionDTO {
    return action.kind === "empty" || action.conditionMet === false ? { kind: "normal" } : action;
}

export function sameAction(left: ScheduleActionDTO, right: ScheduleActionDTO): boolean {
    return left.kind === right.kind
        && left.targetSoc === right.targetSoc
        && (left.conditionMet !== false) === (right.conditionMet !== false);
}

/** The executor's record in words: what it did, how it went and why. */
export function runtimeText(runtime: InverterRuntimeDTO, localize: LocalizeFunction): string {
    const t = (key: string) => localize(`node_detail.inverter.${key}`);
    const parts = [t(`runtime.action.${runtime.actionKind}`), t(`runtime.outcome.${runtime.outcome}`)];
    if (runtime.executedAction) parts.push(getScheduleActionLabel(runtime.executedAction, localize));
    const reason = getScheduleReasonLabel(runtime.reason, localize);
    if (reason) parts.push(reason);
    if (runtime.outcome === "failed" && runtime.message) parts.push(runtime.message);
    return parts.join(" · ");
}

/**
 * The slot in progress as the plan holds it: its action, target, author and
 * condition, and the reason the executor gave. The plan does not say why an
 * optimizer chose the action, and the note says so.
 */
export function renderCurrentSlot(
    run: ScheduleRun | null,
    runtime: InverterRuntimeDTO | null,
    localize: LocalizeFunction,
    row: (label: string, value: string) => TemplateResult,
): TemplateResult {
    const t = (key: string) => localize(`node_detail.inverter.${key}`);
    const action = run?.action;
    return html`
        <div class="section-title">${t("next.slot")}</div>
        ${row(t("next.kind"), action ? getScheduleActionLabel(action, localize) : t("why.nothing_scheduled"))}
        ${action?.targetSoc !== undefined ? row(t("next.target"), action.targetSoc + " %") : nothing}
        ${action?.setBy ? row(t("next.set_by"), t(`next.set_by_${action.setBy}`)) : nothing}
        ${action ? row(t("next.condition"), t(action.conditionMet === false ? "next.condition_not_met" : "next.condition_met")) : nothing}
        ${row(t("next.runtime_reason"), getScheduleReasonLabel(runtime?.reason, localize) ?? t("next.reason_not_provided"))}
        <p class="note">${t("next.optimizer_note")}</p>
    `;
}
