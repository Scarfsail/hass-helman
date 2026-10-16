import { html, nothing, type TemplateResult } from "lit";
import type { InverterRuntimeDTO, ScheduleActionDTO, SchedulePayload } from "../../helman-api";
import type { LocalizeFunction } from "../../localize/localize";
import {
    addDaysToDayKey,
    getScheduleDayKey,
    resolveScheduleSlotBoundaries,
} from "../../shared/schedule/model/schedule-time";
import { getScheduleActionLabel, getScheduleReasonLabel } from "../../shared/schedule/model/schedule-labels";
import { INVERTER_CONTROLLABLE_ID } from "../../shared/schedule/schedule-types";

/**
 * The inverter's plan as the node details read it: runs of equal actions, the
 * one in progress, the executor's record for it and the next change.
 *
 * The plan is the inverter controllable's, whichever node shows it, so the
 * battery detail reads it through the same functions and the same strings as
 * the inverter detail.
 */

export interface ScheduleRun {
    startMs: number;
    endMs: number | null;
    action: ScheduleActionDTO;
}

/** The inverter's actions from the slot in progress at `now` on, merged into runs. */
export function scheduleRuns(schedule: SchedulePayload | null, now: number): ScheduleRun[] {
    if (!schedule?.slots?.length) return [];
    const { slots } = schedule;
    const byId = new Map(slots.map((slot) => [slot.id, slot]));
    const slotDurationMs = schedule.slotMinutes * 60_000;
    const runs: ScheduleRun[] = [];
    for (const { id, startMs } of resolveScheduleSlotBoundaries(slots.map((slot) => slot.id))) {
        const endMs = startMs + slotDurationMs;
        if (endMs <= now) continue;
        const action = (byId.get(id)?.controllables[INVERTER_CONTROLLABLE_ID] as ScheduleActionDTO | undefined)
            ?? { kind: "empty" as const };
        const last = runs[runs.length - 1];
        if (last && last.endMs === startMs && sameAction(last.action, action)) {
            last.endMs = endMs;
        } else {
            runs.push({ startMs, endMs, action });
        }
    }
    return runs;
}

/** The run in progress at `now`, unless it is an empty stretch. */
export function currentRun(runs: ScheduleRun[], now: number): ScheduleRun | null {
    const run = runs[0];
    return run && run.startMs <= now && run.action.kind !== "empty" ? run : null;
}

/** The executor's record, only when it is for the slot in progress at `now`. */
export function currentRuntime(schedule: SchedulePayload | null, now: number): InverterRuntimeDTO | null {
    const runtime = schedule?.runtime;
    if (!schedule || !runtime) return null;
    const slotDurationMs = schedule.slotMinutes * 60_000;
    const slots = resolveScheduleSlotBoundaries((schedule.slots ?? []).map((slot) => slot.id));
    const current = slots.find((slot) => slot.startMs <= now && now < slot.startMs + slotDurationMs);
    if (!current || current.id !== runtime.activeSlotId) return null;
    return (runtime.controllables[INVERTER_CONTROLLABLE_ID] as InverterRuntimeDTO | undefined) ?? null;
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
