import type { ScheduleSlotToggleDetail } from "../schedule-types";

/**
 * Pure slot-selection helpers shared between the scheduling card and the solar
 * inspector's schedule-actions strip, so multi-select / shift-range / dialog-target
 * semantics stay identical across both surfaces.
 *
 * Everything operates on `orderedSlotIds` — the schedule's slot ids in chronological
 * order — plus the current selection and anchor. No component state is touched.
 */

export interface ScheduleSelectionState {
    selectedSlotIds: string[];
    anchorSlotIds: string[] | null;
}

/** Keep a selection in schedule order, dropping ids not present in the schedule. */
export function buildSelectedSlotIdsInScheduleOrder(
    orderedSlotIds: readonly string[],
    selectedIdSet: ReadonlySet<string>,
): string[] {
    return orderedSlotIds.filter((id) => selectedIdSet.has(id));
}

/** The slots a toggle/open event targets, deduped and ordered. */
export function resolveTargetSlotIds(
    orderedSlotIds: readonly string[],
    slotId: string,
    slotIds?: readonly string[],
): string[] {
    const candidateSlotIds = slotIds?.length ? slotIds : [slotId];
    return buildSelectedSlotIdsInScheduleOrder(orderedSlotIds, new Set(candidateSlotIds));
}

function resolveTargetBounds(
    orderedSlotIds: readonly string[],
    slotIds: readonly string[],
): { startIndex: number; endIndex: number; slotIds: string[] } | null {
    const ordered = buildSelectedSlotIdsInScheduleOrder(orderedSlotIds, new Set(slotIds));
    const firstSlotId = ordered[0];
    const lastSlotId = ordered[ordered.length - 1];
    if (!firstSlotId || !lastSlotId) {
        return null;
    }

    const startIndex = orderedSlotIds.indexOf(firstSlotId);
    const endIndex = orderedSlotIds.indexOf(lastSlotId);
    if (startIndex === -1 || endIndex === -1) {
        return null;
    }

    return { startIndex, endIndex, slotIds: ordered };
}

function selectTargetRange(
    orderedSlotIds: readonly string[],
    selectedSlotIds: readonly string[],
    anchorSlotIds: readonly string[],
    targetSlotIds: readonly string[],
): { selectedSlotIds: string[]; nextAnchorSlotIds: string[] } | null {
    const anchorBounds = resolveTargetBounds(orderedSlotIds, anchorSlotIds);
    const targetBounds = resolveTargetBounds(orderedSlotIds, targetSlotIds);
    if (anchorBounds === null || targetBounds === null) {
        return null;
    }

    const selectedIdSet = new Set(selectedSlotIds);
    const startIndex = Math.min(anchorBounds.startIndex, targetBounds.startIndex);
    const endIndex = Math.max(anchorBounds.endIndex, targetBounds.endIndex);
    for (const id of orderedSlotIds.slice(startIndex, endIndex + 1)) {
        selectedIdSet.add(id);
    }

    return {
        selectedSlotIds: buildSelectedSlotIdsInScheduleOrder(orderedSlotIds, selectedIdSet),
        nextAnchorSlotIds: [...targetBounds.slotIds],
    };
}

/**
 * Apply a slot toggle event to the current selection, returning the next selection and
 * anchor. Mirrors the scheduling card's original in-place logic: shift extends a range
 * from the anchor; a multi-slot target toggles the whole group; a single slot toggles
 * itself.
 */
export function applyScheduleSlotSelection({
    orderedSlotIds,
    selectedSlotIds,
    anchorSlotIds,
    detail,
}: {
    orderedSlotIds: readonly string[];
    selectedSlotIds: readonly string[];
    anchorSlotIds: readonly string[] | null;
    detail: ScheduleSlotToggleDetail;
}): ScheduleSelectionState {
    const currentSelected = [...selectedSlotIds];
    const currentAnchor = anchorSlotIds === null ? null : [...anchorSlotIds];
    const targetSlotIds = resolveTargetSlotIds(orderedSlotIds, detail.slotId, detail.slotIds);
    if (targetSlotIds.length === 0) {
        return { selectedSlotIds: currentSelected, anchorSlotIds: currentAnchor };
    }

    if (detail.shiftKey && currentAnchor !== null) {
        const rangeSelection = selectTargetRange(orderedSlotIds, selectedSlotIds, currentAnchor, targetSlotIds);
        if (rangeSelection !== null) {
            return {
                selectedSlotIds: rangeSelection.selectedSlotIds,
                anchorSlotIds: rangeSelection.nextAnchorSlotIds,
            };
        }
    }

    if (targetSlotIds.length > 1) {
        const selectedIdSet = new Set(selectedSlotIds);
        const allSelected = targetSlotIds.every((id) => selectedIdSet.has(id));
        if (allSelected) {
            for (const id of targetSlotIds) {
                selectedIdSet.delete(id);
            }
            const nextSelectedSlotIds = buildSelectedSlotIdsInScheduleOrder(orderedSlotIds, selectedIdSet);
            return {
                selectedSlotIds: nextSelectedSlotIds,
                anchorSlotIds: nextSelectedSlotIds.length > 0 ? [...targetSlotIds] : null,
            };
        }

        for (const id of targetSlotIds) {
            selectedIdSet.add(id);
        }
        return {
            selectedSlotIds: buildSelectedSlotIdsInScheduleOrder(orderedSlotIds, selectedIdSet),
            anchorSlotIds: [...targetSlotIds],
        };
    }

    const [targetSlotId] = targetSlotIds;
    if (!targetSlotId) {
        return { selectedSlotIds: currentSelected, anchorSlotIds: currentAnchor };
    }

    if (selectedSlotIds.includes(targetSlotId)) {
        const nextSelectedSlotIds = currentSelected.filter((id) => id !== targetSlotId);
        return {
            selectedSlotIds: nextSelectedSlotIds,
            anchorSlotIds: nextSelectedSlotIds.length > 0 ? [...targetSlotIds] : null,
        };
    }

    return {
        selectedSlotIds: buildSelectedSlotIdsInScheduleOrder(
            orderedSlotIds,
            new Set([...selectedSlotIds, targetSlotId]),
        ),
        anchorSlotIds: [...targetSlotIds],
    };
}

/**
 * Which slots an "open dialog" action should edit: the existing selection when the
 * click landed inside it (or there is no explicit target), otherwise just the target.
 */
export function resolveScheduleDialogSelectionIds({
    orderedSlotIds,
    selectedSlotIds,
    targetSlotIds,
}: {
    orderedSlotIds: readonly string[];
    selectedSlotIds: readonly string[];
    targetSlotIds: readonly string[];
}): string[] {
    const selected = buildSelectedSlotIdsInScheduleOrder(orderedSlotIds, new Set(selectedSlotIds));
    if (targetSlotIds.length === 0) {
        return selected;
    }

    if (selected.length > 0 && targetSlotIds.some((slotId) => selectedSlotIds.includes(slotId))) {
        return selected;
    }

    return buildSelectedSlotIdsInScheduleOrder(orderedSlotIds, new Set(targetSlotIds));
}
