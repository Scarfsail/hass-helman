import type { ScheduleApplianceMetadata } from "./schedule-appliance-metadata";
import type {
    ScheduleApplianceAction,
    ScheduleControllableAction,
    ScheduleEditIntent,
    ScheduleInverterAction,
    ScheduleRangeEditIntent,
    ScheduleSetBy,
    ScheduleSlot,
    ScheduleSlotPatch,
} from "../schedule-types";
import {
    INVERTER_CONTROLLABLE_ID,
    cloneScheduleApplianceAction,
    cloneScheduleInverterAction,
    getScheduleActionIdentityKey,
    getScheduleApplianceActionIdentityKey,
} from "../schedule-types";
import { buildScheduleSlotPatches } from "./schedule-patch-builder";
import {
    formatScheduleDayLabel,
    getScheduleLocalTimeParts,
    getScheduleTimeRangeLabels,
} from "./schedule-time";

const DAY_MS = 24 * 60 * 60 * 1000;
const FALLBACK_SLOT_DURATION_MS = 60 * 60 * 1000;

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

/** Whether a lane is the inverter's, which is now a question about its id. */
export function isInverterScheduleTarget(target: EntityScheduleTarget): boolean {
    return target === INVERTER_CONTROLLABLE_ID;
}

export function isEntityScheduleActionEmpty(action: EntityScheduleAction): boolean {
    return action === null || (isEntityInverterAction(action) && action.kind === "empty");
}

/**
 * The "nothing scheduled" value for a lane -- `null` for every lane alike.
 *
 * The inverter used to spell it `{ kind: "empty" }` because its domain always
 * held an action; since the flattening it says it the way an appliance always
 * has, by not being in the slot's map at all.
 */
export function getEmptyEntityScheduleAction(_target: EntityScheduleTarget): EntityScheduleAction {
    return null;
}

export function getEntityScheduleActionKey(action: EntityScheduleAction): string {
    if (action === null) {
        return "none";
    }

    return isEntityInverterAction(action)
        // Prefixed by the action's *shape*, not by a lane: two lanes never
        // compare their keys, but an inverter action and an appliance action
        // must never collide on one. Deliberately not the bare word
        // "appliance", which used to prefix a lane key and no longer prefixes
        // anything.
        ? `inverter-action:${getScheduleActionIdentityKey(action)}`
        : `appliance-action:${getScheduleApplianceActionIdentityKey(action)}`;
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
    timeZone,
    locale,
}: {
    slots: readonly ScheduleSlot[];
    timeZone: string;
    locale: string;
}): ScheduleSlot[] {
    const firstSlot = [...slots].sort((left, right) => left.startMs - right.startMs)[0];
    if (firstSlot === undefined) {
        return [];
    }

    const durationMs = _resolveSlotDurationMs(slots);
    const dayStartMs = _resolveLocalDayStartMs(firstSlot.startMs, timeZone);
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
            runtime: null,
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

    const days = [...slotsByDayKey.entries()];
    return days.map(([dayKey, daySlots], index) => {
        const startMs = _resolveLocalDayStartMs(daySlots[0].startMs, timeZone);
        // A day ends where the next one's slots begin, so a schedule that stops
        // mid-day does not claim the hours it has no slots for.
        const nextDaySlots = days[index + 1]?.[1];
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
            && splitAtMs?.has(startMs) !== true
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
    return buildEntityScheduleLanePatches({ slots, lanes: [{ target, draft }], nowMs });
}

/**
 * Every lane's draft as one batch of slot patches.
 *
 * A patch carries the slot's whole set of user domains, so two lanes that both
 * changed the same slot have to arrive as one patch built from both -- sending
 * one patch per lane would make the last one win and silently drop the other
 * entity's edit. Slots are therefore grouped by their combined intent, not by
 * one lane's action.
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
    const groups = new Map<string, { intent: ScheduleRangeEditIntent; slots: ScheduleSlot[] }>();
    for (const slot of slots) {
        if (slot.startMs < editableFromMs) {
            continue;
        }

        const dirtyLanes = lanes.filter((lane) => _isSlotDirty(slot, lane.target, lane.draft));
        if (dirtyLanes.length === 0) {
            continue;
        }

        const intent = _buildCombinedEditIntent(slot, dirtyLanes);
        const key = _getEditIntentKey(intent);
        const group = groups.get(key);
        if (group === undefined) {
            groups.set(key, { intent, slots: [slot] });
            continue;
        }

        group.slots.push(slot);
    }

    return [...groups.values()]
        .flatMap((group) => buildScheduleSlotPatches({
            selectedSlots: group.slots,
            result: group.intent,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
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

function _buildCombinedEditIntent(
    slot: ScheduleSlot,
    lanes: readonly { target: EntityScheduleTarget; draft: EntityScheduleDraft }[],
): ScheduleRangeEditIntent {
    const intent: ScheduleRangeEditIntent = {};
    for (const lane of lanes) {
        intent[lane.target] = _buildEntityEditIntent(
            readEntityScheduleDraftAction(slot, lane.target, lane.draft),
        );
    }

    return intent;
}

/** Two slots share a patch group only when they are being written identically. */
function _getEditIntentKey(intent: ScheduleRangeEditIntent): string {
    return Object.keys(intent)
        .sort()
        .map((controllableId) => `${controllableId}=${JSON.stringify(intent[controllableId])}`)
        .join(",");
}

/**
 * One lane's drafted action as an edit intent -- the same rule for every lane.
 *
 * "Nothing here" is `unset_user` whichever lane it came from. The inverter used
 * to need `set_user` with an `empty` action instead, because its domain always
 * carried one; with the flat map an absent entry says it, so a cleared inverter
 * block and a cleared boiler block write the same thing.
 */
function _buildEntityEditIntent(action: EntityScheduleAction): ScheduleEditIntent {
    if (action === null || (isEntityInverterAction(action) && action.kind === "empty")) {
        return { kind: "unset_user" };
    }

    return { kind: "set_user", action: action as ScheduleControllableAction };
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
        const endMs = slot.endMs ?? Number.POSITIVE_INFINITY;
        if (slot.startMs <= nowMs && endMs > nowMs) {
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
