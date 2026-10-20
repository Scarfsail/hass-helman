import { addDays, daysBetween, formatIsoDate, parseDayKey } from "../shared/time/day-key";
import { calendarWindow } from "./day-pill-model";

/**
 * Where the inspector can be navigated to, as pure functions of the dates and
 * the view they are asked about. The element owns the state; these answer what
 * a span, a month or the pill row is for it.
 */

/** Day view, or one of the two history-only aggregate widths. */
export type InspectorViewMode = "day" | "month" | "year";

/**
 * How far the inspector may be navigated, in either direction.
 *
 * Both payloads carry it, so a card that opened straight into a span view
 * navigates against the same floor a day view would have given it.
 */
export interface NavigationRange {
  minDate: string;
  maxDate: string;
}

/** One stop of the width toggle: a view to be in, and how wide its slots are. */
export interface ViewStop {
  label: string;
  mode: InspectorViewMode;
  minutes?: 15 | 30 | 60;
}

/**
 * The five stops the width toggle offers, narrowest first, in three groups.
 *
 * One control, because widening the axis is one idea to a reader: quarter hour,
 * half hour, hour, day, month. It is deliberately *not* five slot widths.
 * `_slotMinutes` means minutes everywhere -- some twenty arithmetic sites read
 * it as a number and three child strips re-floor by it -- and a month has no
 * fixed minute count, so the two wider stops carry a view mode instead and the
 * minutes field simply stops applying. Keeping them in one list is what makes
 * the toggle read as one axis while the states behind it stay honest.
 *
 * The grouping says which stops are the same thing. A group is one read of one
 * subject: the day view's slots drawn at three resolutions, a month of days, a
 * year of months. Moving within a group re-draws what is already on screen;
 * moving between groups fetches something else and swaps the chart under the
 * reader. The five stops looked identical while meaning those two very
 * different things, so the frame around each group is the toggle saying which
 * presses are which.
 */
const VIEW_STOP_GROUPS: readonly (readonly ViewStop[])[] = [
  [
    { label: "15", mode: "day", minutes: 15 },
    { label: "30", mode: "day", minutes: 30 },
    { label: "60", mode: "day", minutes: 60 },
  ],
  [{ label: "D", mode: "month" }],
  [{ label: "M", mode: "year" }],
];

/** The toggle's stop groups, without the aggregate ones where the config hides them. */
export function viewStopGroups(hideAggregateViews: boolean): readonly (readonly ViewStop[])[] {
  return hideAggregateViews
    ? VIEW_STOP_GROUPS.filter((group) => group.every((stop) => stop.mode === "day"))
    : VIEW_STOP_GROUPS;
}

/** A day key's parts, or today's for one that does not parse. */
export function parseOrToday(dayKey: string, today: string): { year: number; month: number; day: number } {
  return parseDayKey(dayKey) ?? parseDayKey(today)!;
}

/**
 * The first and last day of the calendar month a day falls in.
 *
 * View-independent on purpose, unlike {@link spanBounds}: the expanded pill
 * row is a month of days whichever view is on screen, and asking for a span
 * while the year view is up would answer with a year. Every caller goes
 * through here so a month has one definition.
 */
export function monthBounds(dayKey: string, today: string): { start: string; end: string } {
  const { year, month } = parseOrToday(dayKey, today);
  // Day zero of the next month is the last of this one, leap years included.
  const last = new Date(Date.UTC(year, month, 0));
  return {
    start: formatIsoDate(year, month, 1),
    end: formatIsoDate(year, month, last.getUTCDate()),
  };
}

/**
 * The first and last day of the span the given day falls in.
 *
 * A day in the day view, the containing month in the month view, the
 * containing year in the year view. The forward stop and the span request
 * both key off this one definition, so they cannot disagree about where a
 * span begins.
 */
export function spanBounds(
  mode: InspectorViewMode,
  dayKey: string,
  today: string,
): { start: string; end: string } {
  if (mode === "month") return monthBounds(dayKey, today);
  const { year } = parseOrToday(dayKey, today);
  if (mode === "year") return { start: formatIsoDate(year, 1, 1), end: formatIsoDate(year, 12, 31) };
  return { start: dayKey, end: dayKey };
}

/**
 * The days the pill row offers, derived from the selected one.
 *
 * Expanded detail uses a three-month buffer around the browsing anchor.
 * Aggregate views keep their single month around the focused bucket.
 *
 * Collapsed, the row is what it has always been: today to the end of the
 * forecast when the selection is not behind, and otherwise a fixed seven-day
 * block. The block is a function of the selection alone — no offset to keep
 * in step with it — and every day inside one block maps back to that same
 * block, so clicking a pill never moves the row out from under the click.
 */
export function pillWindow(options: {
  today: string;
  selectedDate: string;
  mode: InspectorViewMode;
  expanded: boolean;
  calendarAnchor: string;
  focusBucket: string | null;
  dayRange: NavigationRange | null;
  firstWeekday: number;
  houseFocus: boolean;
}): { start: string; end: string } {
  const { today, mode, expanded, dayRange } = options;
  const selected = options.selectedDate || today;
  if (expanded && mode === "day") {
    return calendarWindow(options.calendarAnchor || selected, dayRange?.minDate ?? selected,
      dayRange?.maxDate ?? today, options.firstWeekday);
  }
  if (expanded) {
    // Anchored on the bucket the aggregate views have selected, when they
    // have one, and only otherwise on the date. In the year view the selected
    // date is the span start, so anchoring on it alone drew January under
    // every month of the year -- and dropped the reader into a January day
    // when they clicked one.
    return monthBounds(options.focusBucket ?? selected, today);
  }
  if (options.houseFocus) {
    // House pills only carry elapsed days, so the row is a seven-day block
    // ending today rather than one starting there -- otherwise the panel
    // opens on a row of unavailable gauges.
    const daysBack = Math.max(0, daysBetween(selected, today));
    const end = addDays(today, -7 * Math.floor(daysBack / 7));
    return { start: addDays(end, -6), end };
  }
  if (selected >= today) {
    return { start: today, end: dayRange?.maxDate ?? today };
  }

  const daysBack = daysBetween(selected, today);
  const weeksBack = Math.ceil(daysBack / 7);
  const start = addDays(today, -7 * weeksBack);
  return { start, end: addDays(start, 6) };
}
