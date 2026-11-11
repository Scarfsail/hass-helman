import { daysBetween } from "../shared/time/day-key";
import { MINUTES_PER_DAY, type DayWindow } from "./inspector-day-model";

/**
 * The arithmetic of the day view's dragged window: which neighbouring day it
 * reaches into, which day holds most of it, and how far it may go.
 *
 * Pure, and in minutes relative to the selected day's midnight, the frame
 * `DayWindow` is measured in. A day counts as 1440 minutes here exactly as it
 * does everywhere else in the inspector's day model.
 */

/** Which neighbour the window reaches into: -1 the day before, 1 the day after, 0 neither. */
export function overhangSide(window: DayWindow): -1 | 0 | 1 {
  if (window.startMinutes < 0) return -1;
  if (window.endMinutes > MINUTES_PER_DAY) return 1;
  return 0;
}

/**
 * The day covering more than half of the window, as an offset from the
 * selected one. A tie keeps the selected day.
 */
export function majorityDayOffset(window: DayWindow): -1 | 0 | 1 {
  const width = window.endMinutes - window.startMinutes;
  const before = Math.max(0, Math.min(window.endMinutes, 0) - window.startMinutes);
  const after = Math.max(0, window.endMinutes - Math.max(window.startMinutes, MINUTES_PER_DAY));
  if (before * 2 > width) return -1;
  if (after * 2 > width) return 1;
  return 0;
}

/** The window moved by whole days, e.g. into the frame of a neighbouring day. */
export function shiftWindow(window: DayWindow, days: number): DayWindow {
  const offset = days * MINUTES_PER_DAY;
  return { startMinutes: window.startMinutes + offset, endMinutes: window.endMinutes + offset };
}

/** A window `width` minutes wide around `centre`. */
export function windowAround(centre: number, width: number): DayWindow {
  return { startMinutes: centre - width / 2, endMinutes: centre + width / 2 };
}

/**
 * The window held inside the days navigation can reach: not before the first
 * day's midnight, not past the last day's end. An empty bound is no bound.
 */
export function clampWindow(
  window: DayWindow,
  selectedDate: string,
  range: { minDate: string; maxDate: string } | null,
): DayWindow {
  const width = window.endMinutes - window.startMinutes;
  let start = window.startMinutes;
  if (range?.maxDate) {
    const latestEnd = (daysBetween(selectedDate, range.maxDate) + 1) * MINUTES_PER_DAY;
    start = Math.min(start, latestEnd - width);
  }
  if (range?.minDate) {
    start = Math.max(start, daysBetween(selectedDate, range.minDate) * MINUTES_PER_DAY);
  }
  return { startMinutes: start, endMinutes: start + width };
}

/** The window with its start on the slot grid, as the editor snaps its own. */
export function snapWindow(window: DayWindow, slotMinutes: number): DayWindow {
  // Widths are whole minutes -- whole hours, in fact -- so the rounding only
  // sheds the float noise a drag's arithmetic leaves on them.
  const width = Math.round(window.endMinutes - window.startMinutes);
  const slot = slotMinutes > 0 ? slotMinutes : 15;
  const start = Math.round(window.startMinutes / slot) * slot;
  return { startMinutes: start, endMinutes: start + width };
}
