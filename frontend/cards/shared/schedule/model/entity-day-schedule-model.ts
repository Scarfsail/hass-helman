import type { ScheduleApplianceMetadata } from "./schedule-appliance-metadata";
import type {
    ScheduleApplianceAction,
    ScheduleControllableAction,
    ScheduleControllableActions,
    ScheduleInverterAction,
    ScheduleSetBy,
    ScheduleSlot,
    ScheduleSlotPatch,
} from "../schedule-types";
import {
    INVERTER_CONTROLLABLE_ID,
    cloneScheduleApplianceAction,
    cloneScheduleInverterAction,
    getScheduleControllableActionIdentityKey,
    isScheduleInverterAction,
    cloneScheduleControllableAction,
    areScheduleControllableActionsEqual,
} from "../schedule-types";
import {
    formatScheduleDayLabel,
    getScheduleLocalDayStartMs,
    getScheduleTimeRangeLabels,
} from "./schedule-time";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Which single entity's lane of the schedule a view or edit is about: the
 * controllable's own id, `inverter` included.
 *
 * It used to be a two-arm union whose key function produced `"inverter"` or
 * `"appliance:<id>"`, because the schedule had two domains to tell apart. With
 * one id-keyed map there is nothing to disambiguate, so the target *is* the
 * key -- the same string the backend files its explanation records under and
 * the same one the lane's DOM node carries.
 */
export type EntityScheduleTarget = string;

/**
 * One controllable entity as a row of the editor: its lane in the schedule plus
 * what it takes to label and render it.
 */
export interface EntityScheduleLane {
    key: string;
    target: EntityScheduleTarget;
    /** The entity behind the lane, so a label can show its live state. */
    entityId: string;
    name: string;
    icon: string;
    appliance: ScheduleApplianceMetadata | null;
    /** The entity cannot be read right now; its schedule is still editable. */
    isAvailable: boolean;
    /** What the entity actually did earlier today, per elapsed slot. */
    actualSlots: readonly EntityActualSlot[];
}

/** One elapsed slot the entity spent doing something, as the recorder saw it. */
export interface EntityActualSlot {
    startMs: number;
    endMs: number;
    action: EntityScheduleAction;
    /** Share of the slot it was actually away from rest, 0-1. */
    ratio: number;
}

/**
 * A run that already happened: adjacent elapsed slots doing the same thing.
 *
 * Kept apart from `EntityScheduleBlock` because it is a different fact and
 * takes different rules -- it is measured rather than planned, it has no
 * author, and there is nothing about it left to edit.
 */
export interface EntityActualSegment {
    key: string;
    startMs: number;
    endMs: number;
    action: EntityScheduleAction;
    /** How long the entity was really running inside the segment. */
    activeMs: number;
}

/** Every lane's pending edits, keyed by lane key. */
export type EntityScheduleDrafts = Record<string, EntityScheduleDraft>;

/**
 * Block edges the user authored in the open dialog, keyed by lane key.
 *
 * A block is derived, not stored, so two touching runs carrying the same action
 * would otherwise fold into one. These edges say "the user meant these to be
 * separate series", and they live only as long as the dialog -- the saved slot
 * array has nowhere to record them, and a reopened dialog is meant to read the
 * saved schedule the way the config editor does.
 */
export type EntityScheduleBlockSplits = Record<string, ReadonlySet<number>>;

/**
 * One entity's action in one slot.
 *
 * `null` and `{ kind: "empty" }` both mean "nothing scheduled" -- the appliance
 * lane spells that as the absence of an action, the inverter lane as the empty
 * action, and `isEntityScheduleActionEmpty` is what the rest of the code asks
 * instead of caring which lane it is looking at.
 */
export type EntityScheduleAction = ScheduleInverterAction | ScheduleApplianceAction | null;

/** Pending per-slot actions, keyed by slot id. Absent = untouched. */
export type EntityScheduleDraft = Record<string, EntityScheduleAction>;

export interface EntityScheduleDay {
    dayKey: string;
    label: string;
    slots: ScheduleSlot[];
    /** Local midnight to local midnight, so the band can position by clock time. */
    startMs: number;
    endMs: number;
    /** The first slot the user may still change; later than `startMs` for today. */
    editableFromMs: number;
    /** The schedule's slot length, as the backend ships it: the grid every edit snaps to. */
    slotMinutes: number;
}

export type EntityScheduleBlockAuthorship = "user" | "automation";

/**
 * A run of adjacent slots holding the same action, which is the unit a person
 * thinks in ("the boiler runs 12:00-14:00") even though the schedule stores
 * slots.
 */
export interface EntityScheduleBlock {
    key: string;
    startMs: number;
    endMs: number;
    slotIds: string[];
    action: EntityScheduleAction;
    authorship: EntityScheduleBlockAuthorship;
    /** Some slot in the block differs from the saved schedule. */
    isDirty: boolean;
    /** Entirely behind the editable boundary, so it can only be read. */
    isPast: boolean;
    /** The run continues past the day edge, where this view clips it. */
    continuesBefore: boolean;
    continuesAfter: boolean;
}

/** Whether a lane is the inverter's, which is now a question about its id. */
export function isInverterScheduleTarget(target: EntityScheduleTarget): boolean {
    return target === INVERTER_CONTROLLABLE_ID;
}

export function isEntityScheduleActionEmpty(action: EntityScheduleAction): boolean {
    return action === null || (isScheduleInverterAction(action) && action.kind === "empty");
}

export function areEntityScheduleActionsEqual(
    left: EntityScheduleAction,
    right: EntityScheduleAction,
): boolean {
    return getScheduleControllableActionIdentityKey(left)
        === getScheduleControllableActionIdentityKey(right);
}

export function cloneEntityScheduleAction(action: EntityScheduleAction): EntityScheduleAction {
    if (action === null) {
        return null;
    }

    return isScheduleInverterAction(action)
        ? cloneScheduleInverterAction(action)
        : cloneScheduleApplianceAction(action);
}

/**
 * The action as the user would author it.
 *
 * Drops `conditionMet`: that flag marks an optimizer's candidate placement, and
 * carrying it into a hand-made action would write a slot the executor then
 * refuses to run. A user action is unconditional by definition.
 */
export function sanitizeEntityScheduleAction(action: EntityScheduleAction): EntityScheduleAction {
    const cloned = cloneEntityScheduleAction(action);
    if (cloned !== null) {
        delete (cloned as { conditionMet?: boolean }).conditionMet;
    }

    return cloned;
}

export function readEntityScheduleAction(
    slot: ScheduleSlot,
    target: EntityScheduleTarget,
): EntityScheduleAction {
    return slot.assignments[target]?.action ?? null;
}

export function readEntityScheduleSetBy(
    slot: ScheduleSlot,
    target: EntityScheduleTarget,
): ScheduleSetBy | null {
    return slot.assignments[target]?.setBy ?? null;
}

/** The draft value for a slot, falling back to what the schedule holds. */
export function readEntityScheduleDraftAction(
    slot: ScheduleSlot,
    target: EntityScheduleTarget,
    draft: EntityScheduleDraft,
): EntityScheduleAction {
    return slot.id in draft ? draft[slot.id] : readEntityScheduleAction(slot, target);
}

/**
 * The hours of today that have already gone, as empty slots.
 *
 * The schedule prunes what has elapsed, so its earliest slot is the one running
 * now -- which is why a day opens with a blank left half and a run that started
 * at 06:00 appears to start at the current slot. These stand in for the hours
 * before it, carrying no action and no author: they exist so the forecast rows
 * can plot what actually happened and so the day reads as a day.
 *
 * They are inert by construction. Every write path clamps to `editableFromMs`,
 * which is derived from the clock rather than from the array, and each of these
 * ends before it.
 */
export function buildElapsedScheduleSlots({
    slots,
    slotMinutes,
    timeZone,
    locale,
}: {
    slots: readonly ScheduleSlot[];
    slotMinutes: number;
    timeZone: string;
    locale: string;
}): ScheduleSlot[] {
    const firstSlot = [...slots].sort((left, right) => left.startMs - right.startMs)[0];
    if (firstSlot === undefined) {
        return [];
    }

    const durationMs = slotMinutes * 60_000;
    const dayStartMs = getScheduleLocalDayStartMs(firstSlot.startMs, timeZone);
    const elapsed: ScheduleSlot[] = [];
    for (let startMs = dayStartMs; startMs < firstSlot.startMs; startMs += durationMs) {
        const endMs = Math.min(startMs + durationMs, firstSlot.startMs);
        const labels = getScheduleTimeRangeLabels({ startMs, endMs, locale, timeZone });
        elapsed.push({
            // Marked as its own kind of id: these are the editor's own
            // scaffolding and must never be mistaken for a slot the backend
            // knows about.
            id: `elapsed:${new Date(startMs).toISOString()}`,
            index: elapsed.length,
            startMs,
            endMs,
            dayKey: firstSlot.dayKey,
            timeLabel: labels.timeLabel,
            endLabel: labels.endLabel,
            rangeLabel: labels.rangeLabel,
            assignments: {},
            isCurrent: false,
        });
    }

    return elapsed;
}

/**
 * The schedule split into days, each with its clock-time bounds.
 *
 * Days come from the slots themselves rather than from a calendar walk, so a
 * schedule that starts mid-day or ends early produces exactly the days the user
 * can actually edit.
 */
export function buildEntityScheduleDays({
    slots,
    slotMinutes,
    timeZone,
    locale,
    currentDayKey,
    todayLabel,
    tomorrowLabel,
    nowMs,
}: {
    slots: readonly ScheduleSlot[];
    slotMinutes: number;
    timeZone: string;
    locale: string;
    currentDayKey: string | null;
    todayLabel: string;
    tomorrowLabel: string;
    nowMs: number;
}): EntityScheduleDay[] {
    const slotsByDayKey = new Map<string, ScheduleSlot[]>();
    for (const slot of [...slots].sort((left, right) => left.startMs - right.startMs)) {
        const daySlots = slotsByDayKey.get(slot.dayKey);
        if (daySlots === undefined) {
            slotsByDayKey.set(slot.dayKey, [slot]);
            continue;
        }

        daySlots.push(slot);
    }

    const days = [...slotsByDayKey.entries()];
    return days.map(([dayKey, daySlots], index) => {
        const startMs = getScheduleLocalDayStartMs(daySlots[0].startMs, timeZone);
        // A day ends where the next one's slots begin, so a schedule that stops
        // mid-day does not claim the hours it has no slots for.
        const nextDaySlots = days[index + 1]?.[1];
        const endMs = nextDaySlots === undefined
            ? startMs + DAY_MS
            : getScheduleLocalDayStartMs(nextDaySlots[0].startMs, timeZone);

        return {
            dayKey,
            label: formatScheduleDayLabel({
                dayKey,
                currentDayKey,
                locale,
                todayLabel,
                tomorrowLabel,
            }),
            slots: daySlots,
            startMs,
            endMs,
            editableFromMs: _resolveEditableFromMs(daySlots, nowMs),
            slotMinutes,
        };
    });
}

/**
 * Everything still ahead as one span: from the slot running now to the end of
 * the last slot the schedule holds.
 *
 * Shaped as a day so the band, the boundary pickers and the block clipping take
 * it unchanged -- but it is not one: it starts at the editable boundary rather
 * than at a midnight, and runs across as many midnights as the schedule does,
 * so a run across midnight is one block rather than two halves on two days.
 * Nothing elapsed is in it; the editor is about what can still be changed.
 */
export function buildEntityScheduleHorizon({
    slots,
    slotMinutes,
    nowMs,
}: {
    slots: readonly ScheduleSlot[];
    slotMinutes: number;
    nowMs: number;
}): EntityScheduleDay | null {
    const editableFromMs = _resolveEditableFromMs(slots, nowMs);
    const ahead = [...slots]
        .filter((slot) => slot.startMs >= editableFromMs)
        .sort((left, right) => left.startMs - right.startMs);
    const first = ahead[0];
    if (first === undefined) {
        return null;
    }

    return {
        dayKey: first.dayKey,
        label: "",
        slots: ahead,
        startMs: editableFromMs,
        endMs: ahead[ahead.length - 1].endMs,
        editableFromMs,
        slotMinutes,
    };
}

/**
 * The whole schedule as this entity's blocks, with the draft applied.
 *
 * Built across day boundaries and clipped afterwards, so a run that spans
 * midnight is one block that each day reports as continuing rather than two
 * unrelated ones.
 */
export function buildEntityScheduleBlocks({
    slots,
    target,
    draft,
    nowMs,
    splitAtMs,
}: {
    slots: readonly ScheduleSlot[];
    target: EntityScheduleTarget;
    draft: EntityScheduleDraft;
    nowMs: number;
    /**
     * Absolute ms the fold must never cross, so a block the user authored here
     * stays its own series even when its neighbour carries an identical action.
     * Absolute rather than day-relative, so it survives the day clipping below.
     */
    splitAtMs?: ReadonlySet<number>;
}): EntityScheduleBlock[] {
    const orderedSlots = [...slots].sort((left, right) => left.startMs - right.startMs);
    const blocks: EntityScheduleBlock[] = [];

    for (const slot of orderedSlots) {
        const action = readEntityScheduleDraftAction(slot, target, draft);
        if (isEntityScheduleActionEmpty(action)) {
            continue;
        }

        const { startMs, endMs } = slot;
        const isDirty = _isSlotDirty(slot, target, draft);
        // A drafted action is the user's by definition, whoever owned the slot
        // before -- placing it is the takeover, even when the action is the
        // one the automation had planned.
        const authorship: EntityScheduleBlockAuthorship = slot.id in draft
            || readEntityScheduleSetBy(slot, target) === "user"
            ? "user"
            : "automation";
        const previous = blocks[blocks.length - 1];
        // Authorship is an edge: a manual block placed against an automation
        // run carrying the same action is still two things, one of which the
        // automation will re-plan and one of which it will not.
        if (
            previous !== undefined
            && previous.endMs === startMs
            && splitAtMs?.has(startMs) !== true
            && previous.authorship === authorship
            && areEntityScheduleActionsEqual(previous.action, action)
        ) {
            previous.endMs = endMs;
            previous.slotIds.push(slot.id);
            previous.isDirty = previous.isDirty || isDirty;
            previous.isPast = previous.isPast && endMs <= nowMs;
            continue;
        }

        blocks.push({
            key: `${slot.id}:${getScheduleControllableActionIdentityKey(action)}`,
            startMs,
            endMs,
            slotIds: [slot.id],
            action: cloneEntityScheduleAction(action),
            authorship,
            isDirty,
            isPast: endMs <= nowMs,
            continuesBefore: false,
            continuesAfter: false,
        });
    }

    return blocks;
}

/**
 * The entity's elapsed runs, merged and clipped to one day.
 *
 * Merging on the action means a run that changed nothing about itself reads as
 * one bar, and a run still going meets its scheduled continuation at the
 * current slot boundary with no seam -- which is the point of drawing the past
 * on the same axis at all.
 */
export function buildEntityActualSegments({
    actualSlots,
    day,
}: {
    actualSlots: readonly EntityActualSlot[];
    day: EntityScheduleDay;
}): EntityActualSegment[] {
    const segments: EntityActualSegment[] = [];
    const ordered = [...actualSlots]
        .filter((slot) => slot.startMs < day.endMs && slot.endMs > day.startMs)
        .sort((left, right) => left.startMs - right.startMs);

    for (const slot of ordered) {
        if (isEntityScheduleActionEmpty(slot.action)) {
            continue;
        }

        const previous = segments[segments.length - 1];
        const activeMs = (slot.endMs - slot.startMs) * slot.ratio;
        if (
            previous !== undefined
            && previous.endMs === slot.startMs
            && areEntityScheduleActionsEqual(previous.action, slot.action)
        ) {
            previous.endMs = slot.endMs;
            previous.activeMs += activeMs;
            continue;
        }

        segments.push({
            key: `actual:${slot.startMs}`,
            startMs: slot.startMs,
            endMs: slot.endMs,
            action: cloneEntityScheduleAction(slot.action),
            activeMs,
        });
    }

    return segments;
}

/** The blocks overlapping one day, clipped to it. */
export function selectEntityScheduleDayBlocks(
    blocks: readonly EntityScheduleBlock[],
    day: EntityScheduleDay,
): EntityScheduleBlock[] {
    const daySlotIds = new Set(day.slots.map((slot) => slot.id));
    return blocks
        .filter((block) => block.startMs < day.endMs && block.endMs > day.startMs)
        .map((block) => ({
            ...block,
            startMs: Math.max(block.startMs, day.startMs),
            endMs: Math.min(block.endMs, day.endMs),
            slotIds: block.slotIds.filter((slotId) => daySlotIds.has(slotId)),
            continuesBefore: block.startMs < day.startMs,
            continuesAfter: block.endMs > day.endMs,
        }));
}

/**
 * The slot boundaries a block's start and end may be moved to, within one day.
 *
 * Only boundaries the user may still write are offered, plus whatever the block
 * already starts at -- clamping an existing block's start to "now" would move a
 * block the user only meant to shorten at the other end.
 */
export function buildEntityScheduleBoundaryOptions({
    day,
    includeMs,
}: {
    day: EntityScheduleDay;
    includeMs?: readonly number[];
}): number[] {
    const boundaries = new Set<number>(includeMs ?? []);
    for (const slot of day.slots) {
        if (slot.startMs >= day.editableFromMs) {
            boundaries.add(slot.startMs);
        }

        if (slot.endMs > day.editableFromMs) {
            boundaries.add(Math.min(slot.endMs, day.endMs));
        }
    }

    return [...boundaries].sort((left, right) => left - right);
}

/** A stretch of time on the schedule's own grid, `[startMs, endMs)`. */
export interface EntityScheduleRange {
    startMs: number;
    endMs: number;
}

/**
 * Give a range of one lane back to the automation.
 *
 * A slot the automation planned is simply un-drafted, so its own block
 * reappears. A slot the user saved is drafted empty instead: it is freed, and
 * the automation re-plans it once the draft is saved. Slots that can no
 * longer be written are left alone -- freeing them would only make a block
 * vanish from the view while the schedule kept it.
 */
export function freeEntityScheduleRange({
    slots,
    target,
    draft,
    range,
    nowMs,
}: {
    slots: readonly ScheduleSlot[];
    target: EntityScheduleTarget;
    draft: EntityScheduleDraft;
    range: EntityScheduleRange;
    nowMs: number;
}): EntityScheduleDraft {
    const editableFromMs = _resolveEditableFromMs(slots, nowMs);
    const next: EntityScheduleDraft = { ...draft };
    for (const slot of slots) {
        if (slot.startMs < editableFromMs || slot.startMs >= range.endMs || slot.endMs <= range.startMs) {
            continue;
        }

        if (readEntityScheduleSetBy(slot, target) === "user") {
            next[slot.id] = null;
        } else {
            delete next[slot.id];
        }
    }

    return next;
}

/**
 * Put a manual action over a range of one lane, whatever is there.
 *
 * Manual always wins: the action overwrites automation and other manual
 * blocks alike, and the block's previous range (when it is being moved or
 * resized) is freed first, so what it leaves behind goes back to the
 * automation. Clamped to the first slot that can still be written and to the
 * last slot the schedule holds.
 */
export function placeEntityScheduleManualRange({
    slots,
    target,
    draft,
    previous,
    range,
    action,
    nowMs,
}: {
    slots: readonly ScheduleSlot[];
    target: EntityScheduleTarget;
    draft: EntityScheduleDraft;
    /** The block's range before this placement, or null for a new block. */
    previous: EntityScheduleRange | null;
    range: EntityScheduleRange;
    action: EntityScheduleAction;
    nowMs: number;
}): EntityScheduleDraft {
    const next = previous === null
        ? { ...draft }
        : freeEntityScheduleRange({ slots, target, draft, range: previous, nowMs });
    const editableFromMs = _resolveEditableFromMs(slots, nowMs);
    for (const slot of slots) {
        if (slot.startMs >= editableFromMs && slot.startMs < range.endMs && slot.endMs > range.startMs) {
            next[slot.id] = action;
        }
    }

    return next;
}

/**
 * The saved runs a lane's draft replaces inside a range, clipped to it.
 *
 * A run counts when any of its slots inside the range is dirty -- including
 * one whose action the draft repeats but whose owner was the automation,
 * because the claim is itself the change. `baselineBlocks` are the lane's
 * saved runs, built from `slots` with no draft.
 */
export function selectEntityScheduleReplacedRuns({
    slots,
    baselineBlocks,
    target,
    draft,
    range,
}: {
    slots: readonly ScheduleSlot[];
    baselineBlocks: readonly EntityScheduleBlock[];
    target: EntityScheduleTarget;
    draft: EntityScheduleDraft;
    range: EntityScheduleRange;
}): EntityScheduleBlock[] {
    const dirtySlotIds = new Set(slots
        .filter((slot) => slot.startMs < range.endMs && slot.endMs > range.startMs
            && _isSlotDirty(slot, target, draft))
        .map((slot) => slot.id));
    return baselineBlocks
        .filter((block) => block.startMs < range.endMs && block.endMs > range.startMs
            && block.slotIds.some((slotId) => dirtySlotIds.has(slotId)))
        .map((block) => ({
            ...block,
            startMs: Math.max(block.startMs, range.startMs),
            endMs: Math.min(block.endMs, range.endMs),
        }));
}

/**
 * The stretches a draft frees from the user: saved manual slots drafted
 * empty, which the automation re-plans after Save.
 */
export function buildEntityScheduleFreedRanges({
    slots,
    target,
    draft,
}: {
    slots: readonly ScheduleSlot[];
    target: EntityScheduleTarget;
    draft: EntityScheduleDraft;
}): EntityScheduleRange[] {
    const ranges: EntityScheduleRange[] = [];
    for (const slot of [...slots].sort((left, right) => left.startMs - right.startMs)) {
        if (!(slot.id in draft) || !isEntityScheduleActionEmpty(draft[slot.id])
            || readEntityScheduleSetBy(slot, target) !== "user") {
            continue;
        }

        const previous = ranges[ranges.length - 1];
        if (previous !== undefined && previous.endMs === slot.startMs) {
            previous.endMs = slot.endMs;
        } else {
            ranges.push({ startMs: slot.startMs, endMs: slot.endMs });
        }
    }

    return ranges;
}

/**
 * Every lane's draft as one batch of slot patches.
 *
 * A patch carries the slot's whole set of user domains, so two lanes that both
 * changed the same slot have to arrive as one patch built from both -- sending
 * one patch per lane would make the last one win and silently drop the other
 * entity's edit. Elapsed slots are omitted before constructing their patches.
 *
 * Every drafted slot that holds an action is claimed, even one equal to the
 * automation's: holding "normal" over an automation's "normal" is still the
 * user saying "this is mine" -- see `_isSlotDirty`.
 */
export function buildEntityScheduleLanePatches({
    slots,
    lanes,
    nowMs,
}: {
    slots: readonly ScheduleSlot[];
    lanes: readonly { target: EntityScheduleTarget; draft: EntityScheduleDraft }[];
    nowMs: number;
}): ScheduleSlotPatch[] {
    const editableFromMs = _resolveEditableFromMs(slots, nowMs);
    const patches: ScheduleSlotPatch[] = [];
    for (const slot of slots) {
        if (slot.startMs < editableFromMs) {
            continue;
        }

        const dirtyLanes = lanes.filter((lane) => _isSlotDirty(slot, lane.target, lane.draft));
        if (dirtyLanes.length === 0) {
            continue;
        }

        const current: ScheduleControllableActions = {};
        for (const [id, assignment] of Object.entries(slot.assignments)) {
            if (assignment.setBy === "user") {
                current[id] = cloneScheduleControllableAction(assignment.action);
            }
        }
        const next: ScheduleControllableActions = { ...current };
        for (const lane of dirtyLanes) {
            const action = readEntityScheduleDraftAction(slot, lane.target, lane.draft);
            if (isEntityScheduleActionEmpty(action)) {
                delete next[lane.target];
            } else {
                next[lane.target] = cloneScheduleControllableAction(action as ScheduleControllableAction);
            }
        }
        if (dirtyLanes.some((lane) => slot.assignments[lane.target]?.setBy !== "user")
            || !areScheduleControllableActionsEqual(current, next)) {
            patches.push({ id: slot.id, controllables: next });
        }
    }
    return patches.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Some lane's draft differs from the saved schedule *in a slot that can still
 * be written*.
 *
 * The elapsed slots are filtered out here exactly as they are when the patches
 * are built, so "there is something to save" and "saving produces a patch"
 * cannot disagree. Without that, a draft whose slots quietly elapsed would keep
 * Save enabled and then close the dialog over an empty batch, as if the day had
 * been written.
 */
export function areEntityScheduleLanesDirty(
    slots: readonly ScheduleSlot[],
    lanes: readonly { target: EntityScheduleTarget; draft: EntityScheduleDraft }[],
    nowMs: number,
): boolean {
    const editableFromMs = _resolveEditableFromMs(slots, nowMs);
    return slots.some((slot) => slot.startMs >= editableFromMs
        && lanes.some((lane) => _isSlotDirty(slot, lane.target, lane.draft)));
}

/**
 * The draft changes the slot: a different action, or an action the user now
 * claims from the automation even though it is the one it had planned.
 */
function _isSlotDirty(
    slot: ScheduleSlot,
    target: EntityScheduleTarget,
    draft: EntityScheduleDraft,
): boolean {
    if (!(slot.id in draft)) {
        return false;
    }

    const action = draft[slot.id];
    return !areEntityScheduleActionsEqual(action, readEntityScheduleAction(slot, target))
        || (!isEntityScheduleActionEmpty(action) && readEntityScheduleSetBy(slot, target) !== "user");
}

/**
 * The first moment the user may still write: the start of the slot that is
 * running right now.
 *
 * The running slot is editable, not read-only. "Start it now" is the most
 * common thing to want from this editor, and at 09:15 that means a block from
 * 09:00 -- the backend's write horizon begins at the same floored boundary, and
 * a write reconciles the active slot immediately, so the block really does
 * start. Only slots that have fully elapsed are beyond reach.
 */
function _resolveEditableFromMs(slots: readonly ScheduleSlot[], nowMs: number): number {
    let currentStartMs: number | null = null;
    let nextStartMs = Number.POSITIVE_INFINITY;
    for (const slot of slots) {
        if (slot.startMs <= nowMs && slot.endMs > nowMs) {
            currentStartMs = Math.max(currentStartMs ?? slot.startMs, slot.startMs);
            continue;
        }

        if (slot.startMs > nowMs) {
            nextStartMs = Math.min(nextStartMs, slot.startMs);
        }
    }

    if (currentStartMs !== null) {
        return currentStartMs;
    }

    return Number.isFinite(nextStartMs) ? nextStartMs : nowMs;
}
