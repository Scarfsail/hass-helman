/**
 * Pure multi-select helpers for the inspector's time slots (`HH:MM`).
 *
 * The inspector keeps one selection that every surface shares: the charts draw a
 * highlight per selected slot, and the schedule-actions strip both renders and edits
 * that same set. This module owns the semantics — plain click replaces, ctrl/long-press
 * toggles, shift extends from the anchor — so the charts and the strip can't drift.
 *
 * Everything operates on `orderedSlots`, the day's impact slots in chronological order.
 * No component state is touched.
 */

export interface SlotSelectionState {
  /** The selection, in chronological order. */
  selectedSlots: string[];
  /** The slot whose detail panel is shown; always a member of `selectedSlots`. */
  focusSlot: string | null;
  /** Where a subsequent shift-click measures its range from. */
  anchorSlot: string | null;
}

export const EMPTY_SLOT_SELECTION: SlotSelectionState = {
  selectedSlots: [],
  focusSlot: null,
  anchorSlot: null,
};

/** How a click asked the selection to change. */
export type SlotSelectionMode = "replace" | "toggle" | "extend";

/** What a strip publishes when a click lands on it. */
export interface SlotPickDetail {
  /** Minute-of-day the click resolved to; `null` means "outside the plot". */
  minutes: number | null;
  mode: SlotSelectionMode;
}

/** Read the mode out of a mouse event; a long press maps to `toggle` separately. */
export function slotSelectionModeForEvent(event: MouseEvent): SlotSelectionMode {
  if (event.shiftKey) return "extend";
  if (event.ctrlKey || event.metaKey) return "toggle";
  return "replace";
}

/** Keep a selection in chronological order, dropping slots not on the day. */
export function buildSelectedSlotsInOrder(
  orderedSlots: readonly string[],
  selectedSet: ReadonlySet<string>,
): string[] {
  return orderedSlots.filter((slot) => selectedSet.has(slot));
}

/**
 * Apply a click to the current selection. `target` is the slot that was clicked;
 * an unknown slot leaves the selection untouched.
 */
export function applySlotSelection({
  orderedSlots,
  selection,
  target,
  mode,
}: {
  orderedSlots: readonly string[];
  selection: SlotSelectionState;
  target: string;
  mode: SlotSelectionMode;
}): SlotSelectionState {
  if (!orderedSlots.includes(target)) {
    return selection;
  }

  if (mode === "extend" && selection.anchorSlot !== null) {
    const anchorIndex = orderedSlots.indexOf(selection.anchorSlot);
    const targetIndex = orderedSlots.indexOf(target);
    if (anchorIndex !== -1) {
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      const next = new Set(selection.selectedSlots);
      for (const slot of orderedSlots.slice(start, end + 1)) {
        next.add(slot);
      }
      return {
        selectedSlots: buildSelectedSlotsInOrder(orderedSlots, next),
        focusSlot: target,
        // The anchor stays put, so dragging a shift-click back and forth keeps
        // measuring from the slot the range started at.
        anchorSlot: selection.anchorSlot,
      };
    }
  }

  if (mode === "toggle") {
    const next = new Set(selection.selectedSlots);
    if (next.delete(target)) {
      const selectedSlots = buildSelectedSlotsInOrder(orderedSlots, next);
      const focusSlot = selection.focusSlot === target
        ? selectedSlots[selectedSlots.length - 1] ?? null
        : selection.focusSlot;
      return {
        selectedSlots,
        focusSlot,
        anchorSlot: selectedSlots.length > 0 ? focusSlot : null,
      };
    }
    next.add(target);
    return {
      selectedSlots: buildSelectedSlotsInOrder(orderedSlots, next),
      focusSlot: target,
      anchorSlot: target,
    };
  }

  return { selectedSlots: [target], focusSlot: target, anchorSlot: target };
}

/**
 * Drop slots that are no longer on the day — after a reload, a day change, or a
 * slot-width switch. `remap` lets the caller move each slot onto a new grid first.
 */
export function reconcileSlotSelection(
  orderedSlots: readonly string[],
  selection: SlotSelectionState,
  remap: (slot: string) => string | null = (slot) => slot,
): SlotSelectionState {
  const available = new Set(orderedSlots);
  const remapped = new Set<string>();
  for (const slot of selection.selectedSlots) {
    const next = remap(slot);
    if (next !== null && available.has(next)) {
      remapped.add(next);
    }
  }
  const selectedSlots = buildSelectedSlotsInOrder(orderedSlots, remapped);

  const remapKept = (slot: string | null): string | null => {
    if (slot === null) return null;
    const next = remap(slot);
    return next !== null && remapped.has(next) ? next : null;
  };

  const focusSlot = remapKept(selection.focusSlot)
    ?? selectedSlots[selectedSlots.length - 1]
    ?? null;

  return {
    selectedSlots,
    focusSlot,
    anchorSlot: remapKept(selection.anchorSlot) ?? focusSlot,
  };
}
