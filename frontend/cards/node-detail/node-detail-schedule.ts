import { html, nothing, type TemplateResult } from "lit";
import type { ControllableRuntimeDTO, InverterRuntimeDTO, ScheduleActionDTO, ScheduleActionKind, ScheduleControllableActionDTO, SchedulePayload, ScheduleSetBy, ScheduleSlotDTO } from "../helman-api";
import { fillTemplate, getLocalizeFunction, type LocalizeFunction } from "../localize/localize";
import {
    addDaysToDayKey,
    formatScheduleTime,
    getScheduleDayKey,
    resolveScheduleSlotBoundaries,
} from "../shared/schedule/model/schedule-time";
import { getScheduleApplianceActionPresentation } from "../shared/schedule/model/schedule-appliance-action-presentation";
import { getScheduleActionLabel, getScheduleReasonLabel } from "../shared/schedule/model/schedule-labels";
import { INVERTER_CONTROLLABLE_ID } from "../shared/schedule/schedule-types";
import { getScheduleControllableActionIdentityKey, isScheduleApplianceActionEnabled, isScheduleInverterAction } from "../shared/schedule/schedule-types";
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

/**
 * The remaining runs for any schedule lane, including empty stretches. A
 * change of author (who set it, and which optimizer) alone continues a run
 * unless `byAuthor` asks for it to start a new one, as a run that names its
 * author must.
 */
export function laneRuns(schedule: SchedulePayload, controllableId: string, now: number, { byAuthor = false }: { byAuthor?: boolean } = {}): ScheduleRun<ScheduleControllableActionDTO>[] {
    const boundaries = resolveScheduleSlotBoundaries(schedule.slots.map((slot) => slot.id))
        .filter((slot) => slot.startMs + SLOT_MS > now);
    const slotsById = new Map(schedule.slots.map((slot) => [slot.id, slot]));
    return mergeRuns<ScheduleControllableActionDTO>(boundaries, slotsById, controllableId, () => true,
        (left, right) => {
            const { setBy: _left, optimizer: _leftOptimizer, ...leftAction } = left;
            const { setBy: _right, optimizer: _rightOptimizer, ...rightAction } = right;
            return (!byAuthor || (left.setBy === right.setBy && left.optimizer === right.optimizer))
                && getScheduleControllableActionIdentityKey(leftAction as ScheduleControllableActionDTO)
                === getScheduleControllableActionIdentityKey(rightAction as ScheduleControllableActionDTO);
        },
        { fillEmpty: true });
}

/** First action change after now on a lane, including a switch to an empty stretch. */
export function nextLaneChange(runs: ScheduleRun<ScheduleControllableActionDTO>[], now: number, timeZone: string): ScheduleRun<ScheduleControllableActionDTO> | null {
    const days = todayAndTomorrow(now, timeZone);
    const inverterLane = runs.some((run) => isScheduleInverterAction(run.action) && run.action.kind !== "empty");
    let previous: ScheduleControllableActionDTO = inverterLane ? { kind: "normal" } : { kind: "empty" };
    for (const run of runs) {
        const action = effectiveLaneAction(run.action, inverterLane);
        if (run.startMs > now && effectiveLaneKey(previous) !== effectiveLaneKey(action)) {
            return days.includes(dayKey(run.startMs, timeZone)) ? { ...run, action } : null;
        }
        previous = action;
    }
    return null;
}

/** One row of a lane's upcoming changes: when, what, whether it is a candidate and whether the lane is at rest. */
export interface LaneChange {
    startMs: number;
    endMs: number | null;
    action: ScheduleControllableActionDTO;
    candidate: boolean;
    /** The lane at rest: an appliance idle, the inverter in its normal mode. */
    atRest: boolean;
}

/**
 * Every change on a lane after now, today and tomorrow: each run whose
 * effective action differs from the run before it, or whose author does
 * while the lane does something; a change of author while it rests is no
 * change. A candidate is its own row, with the action it would take; the
 * effective action of one that is not met is the lane at rest. `runs` are
 * `laneRuns` by author.
 */
export function upcomingLaneChanges(runs: ScheduleRun<ScheduleControllableActionDTO>[], now: number, timeZone: string): LaneChange[] {
    const inverterLane = runs.some((run) => isScheduleInverterAction(run.action) && run.action.kind !== "empty");
    const changes: LaneChange[] = [];
    let previous: string | null = null;
    for (const run of withinTodayTomorrow(runs, now, timeZone)) {
        const candidate = run.action.conditionMet === false;
        const action = candidate ? run.action : effectiveLaneAction(run.action, inverterLane);
        const effective = effectiveLaneKey(candidate ? { ...action, conditionMet: true } : action);
        const atRest = !candidate && (effective === "idle" || (isScheduleInverterAction(action) && action.kind === "normal"));
        const key = `${candidate ? "candidate:" : ""}${effective}${atRest ? "" : `|${action.setBy ?? ""}|${action.optimizer ?? ""}`}`;
        if (run.startMs > now && key !== previous) changes.push({ startMs: run.startMs, endMs: run.endMs, action, candidate, atRest });
        previous = key;
    }
    return changes;
}

/** First future appliance start today or tomorrow, skipping idle and unmet candidates. */
export function nextLaneStart(runs: ScheduleRun<ScheduleControllableActionDTO>[], now: number, timeZone: string): ScheduleRun<ScheduleControllableActionDTO> | null {
    const days = todayAndTomorrow(now, timeZone);
    let wasEnabled = false;
    for (const run of runs) {
        const action = effectiveLaneAction(run.action);
        const enabled = !isScheduleInverterAction(action) && isScheduleApplianceActionEnabled(action) === true;
        if (run.startMs > now && enabled && !wasEnabled) {
            return days.includes(dayKey(run.startMs, timeZone)) ? { ...run, action } : null;
        }
        wasEnabled = enabled;
    }
    return null;
}

export function effectiveLaneAction(action: ScheduleControllableActionDTO, inverterLane = false): ScheduleControllableActionDTO {
    if (isScheduleInverterAction(action)) return action.kind === "empty" && !inverterLane ? action : effectiveAction(action);
    if (action.conditionMet !== false) return action;
    if ("on" in action) return { on: false };
    if ("charge" in action) return { charge: false };
    return "mode" in action ? { mode: "off" } : action;
}

function effectiveLaneKey(action: ScheduleControllableActionDTO): string {
    if (isScheduleInverterAction(action) ? action.kind === "empty" : isScheduleApplianceActionEnabled(action) !== true) return "idle";
    const { setBy: _author, optimizer: _optimizer, conditionMet: _condition, ...effective } = action;
    return getScheduleControllableActionIdentityKey(effective as ScheduleControllableActionDTO);
}

/** An optimizer kind by the name the Automations list gives it; `null` when it has none. */
export function optimizerName(kind: string, localize: LocalizeFunction): string | null {
    const key = `editor.values.${kind}`;
    return (localize.has?.(key) ?? getLocalizeFunction().has(key)) ? localize(key) : null;
}

/**
 * Who set a scheduled action: you, the optimizer that placed it by name, or
 * Helman's schedule when the plan does not name one.
 */
export function scheduleReason(action: { setBy?: ScheduleSetBy; optimizer?: string }, localize: LocalizeFunction): string {
    if (action.setBy === "user") return localize("node_detail.shared.you");
    return (action.optimizer ? optimizerName(action.optimizer, localize) : null) ?? localize("node_detail.shared.helman_schedule");
}

/**
 * An action's label. With the lane's appliance kind, an empty stretch reads
 * as the appliance at rest: off, or not charging.
 */
export function laneActionLabel(action: ScheduleControllableActionDTO, localize: LocalizeFunction, applianceKind?: string | null): string {
    if (applianceKind && isScheduleInverterAction(action) && action.kind === "empty") {
        return laneActionLabel(applianceKind === "ev_charger" ? { charge: false } : applianceKind === "climate" ? { mode: "off" } : { on: false }, localize);
    }
    if (isScheduleInverterAction(action)) return getScheduleActionLabel(action, localize);
    if ("on" in action) return localize(`node_detail.control.${action.on ? "on" : "off"}`);
    if ("charge" in action) return localize(`node_detail.shared.${action.charge ? "charging" : "idle"}`);
    return "mode" in action
        ? getScheduleApplianceActionPresentation({ appliance: { kind: "climate", icon: "" }, action, localize }).label
        : localize("node_detail.shared.schedule.none");
}

/** The short name of an inverter mode, as the details and the Schedule strip show it. */
export function inverterModeLabel(localize: (key: string) => string, kind: ScheduleActionKind): string {
    return localize(`node_detail.inverter.mode_short.${kind}`);
}

/**
 * What a lane is doing now by the plan, and until when unless the run lasts
 * to the plan's end: "Nothing planned", with no run, when it does nothing.
 * Runs `byAuthor` end where the author changes.
 */
export function laneDoingNow(
    schedule: SchedulePayload,
    controllableId: string,
    now: number,
    localize: LocalizeFunction,
    locale: string,
    timeZone: string,
    { byAuthor = false }: { byAuthor?: boolean } = {},
): { text: string; run: ScheduleRun<ScheduleControllableActionDTO> | null } {
    const runs = laneRuns(schedule, controllableId, now, { byAuthor });
    const run = runs.find((candidate) => candidate.startMs <= now && (candidate.endMs === null || now < candidate.endMs));
    const action = run ? effectiveLaneAction(run.action, controllableId === INVERTER_CONTROLLABLE_ID) : null;
    if (!run || action === null || (isScheduleInverterAction(action) && action.kind === "empty")) {
        return { text: localize("node_detail.shared.schedule.none"), run: null };
    }
    const label = laneActionLabel(action, localize);
    const text = run.endMs === null || run.endMs === runs[runs.length - 1].endMs ? label
        : `${label} ${fillTemplate(localize("node_detail.shared.until"), { time: formatScheduleTime(run.endMs, locale, timeZone) })}`;
    return { text, run };
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
    const slots = resolveScheduleSlotBoundaries((schedule.slots ?? []).map((slot) => slot.id));
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

/**
 * An executor's record in words: what it did, how it went, the inverter's
 * executed action and reason, and when it failed, why.
 */
export function runtimeText(runtime: ControllableRuntimeDTO, localize: LocalizeFunction): string {
    const t = (key: string) => localize(`node_detail.inverter.${key}`);
    const parts = [t(`runtime.action.${runtime.actionKind}`), t(`runtime.outcome.${runtime.outcome}`)];
    if ("executedAction" in runtime && runtime.executedAction) parts.push(getScheduleActionLabel(runtime.executedAction, localize));
    const reason = "reason" in runtime ? getScheduleReasonLabel(runtime.reason, localize) : null;
    if (reason) parts.push(reason);
    if (runtime.outcome === "failed") parts.push(runtime.message ?? runtime.errorCode ?? "");
    return parts.filter(Boolean).join(" · ");
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
