import type {
    ScheduleApplianceAction,
    ScheduleInverterAction,
    ScheduleRangeEditIntent,
    ScheduleSetBy,
    ScheduleSlot,
    ScheduleSlotPatch,
} from "../schedule-types";
import {
    cloneScheduleApplianceAction,
    cloneScheduleInverterAction,
    getScheduleActionIdentityKey,
    getScheduleApplianceActionIdentityKey,
} from "../schedule-types";
import { buildScheduleSlotPatches } from "./schedule-patch-builder";
import { formatScheduleDayLabel, getScheduleLocalTimeParts } from "./schedule-time";

const DAY_MS = 24 * 60 * 60 * 1000;
const FALLBACK_SLOT_DURATION_MS = 60 * 60 * 1000;

/** Which single entity's lane of the schedule a view or edit is about. */
export type EntityScheduleTarget =
    | { kind: "inverter" }
    | { kind: "appliance"; applianceId: string };

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
}

export type EntityScheduleBlockAuthorship = "user" | "automation" | "mixed";

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

export function isEntityInverterAction(
    action: EntityScheduleAction,
): action is ScheduleInverterAction {
    return action !== null && "kind" in action;
}

export function isEntityScheduleActionEmpty(action: EntityScheduleAction): boolean {
    return action === null || (isEntityInverterAction(action) && action.kind === "empty");
}

/** The "nothing scheduled" value for a lane, which differs between the two. */
export function getEmptyEntityScheduleAction(target: EntityScheduleTarget): EntityScheduleAction {
    return target.kind === "inverter" ? { kind: "empty" } : null;
}

export function getEntityScheduleActionKey(action: EntityScheduleAction): string {
    if (action === null) {
        return "none";
    }

    return isEntityInverterAction(action)
        ? `inverter:${getScheduleActionIdentityKey(action)}`
        : `appliance:${getScheduleApplianceActionIdentityKey(action)}`;
}

export function areEntityScheduleActionsEqual(
    left: EntityScheduleAction,
    right: EntityScheduleAction,
): boolean {
    return getEntityScheduleActionKey(left) === getEntityScheduleActionKey(right);
}

export function cloneEntityScheduleAction(action: EntityScheduleAction): EntityScheduleAction {
    if (action === null) {
        return null;
    }

    return isEntityInverterAction(action)
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
    if (target.kind === "inverter") {
        return slot.assignments.inverter.action;
    }

    return slot.assignments.appliances[target.applianceId]?.action ?? null;
}

export function readEntityScheduleSetBy(
    slot: ScheduleSlot,
    target: EntityScheduleTarget,
): ScheduleSetBy | null {
    if (target.kind === "inverter") {
        return slot.assignments.inverter.setBy;
    }

    return slot.assignments.appliances[target.applianceId]?.setBy ?? null;
}

/** The draft value for a slot, falling back to what the schedule holds. */
export function readEntityScheduleDraftAction(
    slot: ScheduleSlot,
    target: EntityScheduleTarget,
    draft: EntityScheduleDraft,
): EntityScheduleAction {
    return slot.id in draft ? draft[slot.id] : readEntityScheduleAction(slot, target);
}

export function isEntityScheduleDraftDirty(
    slots: readonly ScheduleSlot[],
    target: EntityScheduleTarget,
    draft: EntityScheduleDraft,
): boolean {
    return slots.some((slot) => _isSlotDirty(slot, target, draft));
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
    timeZone,
    locale,
    currentDayKey,
    todayLabel,
    tomorrowLabel,
    nowMs,
}: {
    slots: readonly ScheduleSlot[];
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

    const dayKeys = [...slotsByDayKey.keys()];
    return dayKeys.map((dayKey, index) => {
        const daySlots = slotsByDayKey.get(dayKey) ?? [];
        const startMs = _resolveLocalDayStartMs(daySlots[0].startMs, timeZone);
        const nextDaySlots = slotsByDayKey.get(dayKeys[index + 1]);
        const endMs = nextDaySlots === undefined
            ? startMs + DAY_MS
            : _resolveLocalDayStartMs(nextDaySlots[0].startMs, timeZone);

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
        };
    });
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
}: {
    slots: readonly ScheduleSlot[];
    target: EntityScheduleTarget;
    draft: EntityScheduleDraft;
    nowMs: number;
}): EntityScheduleBlock[] {
    const orderedSlots = [...slots].sort((left, right) => left.startMs - right.startMs);
    const fallbackDurationMs = _resolveSlotDurationMs(orderedSlots);
    const blocks: EntityScheduleBlock[] = [];

    for (const slot of orderedSlots) {
        const action = readEntityScheduleDraftAction(slot, target, draft);
        if (isEntityScheduleActionEmpty(action)) {
            continue;
        }

        const startMs = slot.startMs;
        const endMs = slot.endMs ?? slot.startMs + fallbackDurationMs;
        const setBy = readEntityScheduleSetBy(slot, target);
        const isDirty = _isSlotDirty(slot, target, draft);
        // A drafted action is the user's by definition, whoever owned the slot
        // before -- editing is the takeover.
        const authorship: EntityScheduleBlockAuthorship = isDirty || setBy === "user"
            ? "user"
            : "automation";
        const previous = blocks[blocks.length - 1];
        if (
            previous !== undefined
            && previous.endMs === startMs
            && areEntityScheduleActionsEqual(previous.action, action)
        ) {
            previous.endMs = endMs;
            previous.slotIds.push(slot.id);
            previous.isDirty = previous.isDirty || isDirty;
            previous.authorship = previous.authorship === authorship ? authorship : "mixed";
            previous.isPast = previous.isPast && endMs <= nowMs;
            continue;
        }

        blocks.push({
            key: `${slot.id}:${getEntityScheduleActionKey(action)}`,
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
    const fallbackDurationMs = _resolveSlotDurationMs(day.slots);
    const boundaries = new Set<number>(includeMs ?? []);
    for (const slot of day.slots) {
        if (slot.startMs >= day.editableFromMs) {
            boundaries.add(slot.startMs);
        }

        const endMs = slot.endMs ?? slot.startMs + fallbackDurationMs;
        if (endMs > day.editableFromMs) {
            boundaries.add(Math.min(endMs, day.endMs));
        }
    }

    return [...boundaries].sort((left, right) => left - right);
}

/**
 * How far a block may be moved or stretched before it would hit something.
 *
 * Bounded by its neighbours, by the end of the day and by the part of the day
 * that has already happened. Shared by the time pickers and by dragging on the
 * band so both refuse the same moves: a block the user is not touching should
 * never be eaten, whichever way the edit was made.
 */
export function resolveEntityScheduleRangeLimits({
    blocks,
    day,
    startMs,
    endMs,
}: {
    blocks: readonly EntityScheduleBlock[];
    day: EntityScheduleDay;
    startMs: number;
    endMs: number;
}): { minMs: number; maxMs: number } {
    const editableFromMs = Math.max(day.startMs, day.editableFromMs);
    // Whatever overlaps the range is the block being edited, not a neighbour.
    const neighbours = blocks.filter((block) => block.endMs <= startMs || block.startMs >= endMs);
    return {
        minMs: neighbours
            .filter((block) => block.endMs <= startMs)
            .reduce((max, block) => Math.max(max, block.endMs), editableFromMs),
        maxMs: neighbours
            .filter((block) => block.startMs >= endMs)
            .reduce((min, block) => Math.min(min, block.startMs), day.endMs),
    };
}

/** The slots of a day covered by `[startMs, endMs)`. */
export function selectEntityScheduleSlotsInRange({
    day,
    startMs,
    endMs,
}: {
    day: EntityScheduleDay;
    startMs: number;
    endMs: number;
}): ScheduleSlot[] {
    const fallbackDurationMs = _resolveSlotDurationMs(day.slots);
    return day.slots.filter((slot) => {
        const slotEndMs = slot.endMs ?? slot.startMs + fallbackDurationMs;
        return slot.startMs < endMs && slotEndMs > startMs;
    });
}

/**
 * The whole draft as one batch of slot patches.
 *
 * Slots that land on the same action are patched together so the existing range
 * patch builder still does the work -- it is what knows how to keep the other
 * entities' actions in a slot intact. Slots the user may no longer write are
 * dropped here as well as in the UI: the backend rejects past slots, and a
 * rejected batch would take the whole day's edit with it.
 */
export function buildEntitySchedulePatches({
    slots,
    target,
    draft,
    nowMs,
}: {
    slots: readonly ScheduleSlot[];
    target: EntityScheduleTarget;
    draft: EntityScheduleDraft;
    nowMs: number;
}): ScheduleSlotPatch[] {
    const editableFromMs = _resolveEditableFromMs(slots, nowMs);
    const groups = new Map<string, { action: EntityScheduleAction; slots: ScheduleSlot[] }>();
    for (const slot of slots) {
        if (slot.startMs < editableFromMs || !_isSlotDirty(slot, target, draft)) {
            continue;
        }

        const action = readEntityScheduleDraftAction(slot, target, draft);
        const key = getEntityScheduleActionKey(action);
        const group = groups.get(key);
        if (group === undefined) {
            groups.set(key, { action, slots: [slot] });
            continue;
        }

        group.slots.push(slot);
    }

    return [...groups.values()]
        .flatMap((group) => buildScheduleSlotPatches({
            selectedSlots: group.slots,
            result: _buildEntityEditIntent(target, group.action),
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
}

function _buildEntityEditIntent(
    target: EntityScheduleTarget,
    action: EntityScheduleAction,
): ScheduleRangeEditIntent {
    if (target.kind === "inverter") {
        return {
            // "empty" is how the inverter lane says "no user action", so a
            // removed block and a never-set one write the same thing.
            inverter: {
                kind: "set_user",
                action: isEntityInverterAction(action) ? action : { kind: "empty" },
            },
            appliances: {},
        };
    }

    return {
        inverter: { kind: "keep" },
        appliances: {
            [target.applianceId]: action === null || isEntityInverterAction(action)
                ? { kind: "unset_user" }
                : { kind: "set_user", action },
        },
    };
}

function _isSlotDirty(
    slot: ScheduleSlot,
    target: EntityScheduleTarget,
    draft: EntityScheduleDraft,
): boolean {
    if (!(slot.id in draft)) {
        return false;
    }

    return !areEntityScheduleActionsEqual(draft[slot.id], readEntityScheduleAction(slot, target));
}

/**
 * The start of the slot containing now, or the schedule start when now is
 * behind it. Past slots are read-only, and the running slot counts as past:
 * rewriting it cannot change what is already happening.
 */
function _resolveEditableFromMs(slots: readonly ScheduleSlot[], nowMs: number): number {
    let editableFromMs = Number.POSITIVE_INFINITY;
    for (const slot of slots) {
        if (slot.startMs > nowMs) {
            editableFromMs = Math.min(editableFromMs, slot.startMs);
        }
    }

    return Number.isFinite(editableFromMs) ? editableFromMs : nowMs;
}

function _resolveSlotDurationMs(slots: readonly ScheduleSlot[]): number {
    for (const slot of slots) {
        if (slot.endMs !== null && slot.endMs > slot.startMs) {
            return slot.endMs - slot.startMs;
        }
    }

    return FALLBACK_SLOT_DURATION_MS;
}

/**
 * Local midnight of the day a moment falls in.
 *
 * Derived by subtracting the moment's own local clock time rather than by date
 * maths, so it stays correct in any zone without a second date library.
 */
function _resolveLocalDayStartMs(atMs: number, timeZone: string): number {
    const parts = getScheduleLocalTimeParts(atMs, timeZone);
    if (parts === null) {
        return atMs;
    }

    return atMs - (parts.hour * 60 + parts.minute) * 60_000;
}
