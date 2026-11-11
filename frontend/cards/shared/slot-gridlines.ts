import { pad2 } from "./time/slot-time";
import { svg } from "lit";

/**
 * The vertical time grid every surface that draws a day against a time axis
 * rules itself by: the inspector's charts and strips, and the schedule band --
 * standalone in the day editor as much as stacked under those charts.
 *
 * One hairline per slot, so the grid is in the same unit the charts are drawn
 * and selected in -- a 15-minute bar sits between two lines rather than
 * somewhere inside a three-hour block. Only some of them carry an hour number:
 * a label per slot would be unreadable, so the widest hour stride that still
 * fits gets the digits and the rest stay muted, which keeps the labelled lines
 * legible as the coarse scale while the muted ones say where a slot begins.
 *
 * Its own module because the main chart, the SoC strip, the price strip and the
 * schedule band all have to answer this identically; a row computing its own
 * grid would be a row whose lines drift from the chart above it. Shared rather
 * than the inspector's, because the day editor rules the same day in the same
 * unit -- a slot -- and two surfaces answering "which lines, and which of them
 * carry an hour" differently is two surfaces that read as different diagrams.
 */
export type SlotGridTick = {
  /** Minute-of-day the line sits at. */
  minutes: number;
  /** The whole hour to print under the line, or null for an unlabelled line. */
  hour: number | null;
  /** The line is a local midnight; only ever set when the caller named its midnights. */
  midnight?: true;
};

/**
 * How hard each kind of line is drawn.
 *
 * The labelled lines stay stronger than the rest, which is what keeps the
 * coarse scale readable once there is a line every quarter hour. Exported
 * because the grid is drawn as SVG on the charts and as elements on the band,
 * and a grid that changed weight between the two would read as two grids.
 */
export const SLOT_GRID_LINE_OPACITY = { major: 0.55, minor: 0.22 } as const;

/** Hour strides tried in order; the first one whose labels fit is used. */
const LABEL_STRIDES = [1, 2, 3, 4, 6, 12] as const;

/** Room a two-digit hour needs before its neighbour, in viewBox units. */
const MIN_LABEL_SPACING = 30;

/** Below this, hairlines read as a wash rather than a grid, so they thin out. */
const MIN_LINE_SPACING = 4;

export function slotGridTicks(options: {
  startMinutes: number;
  endMinutes: number;
  slotMinutes: number;
  plotWidth: number;
  /**
   * The local midnights the span runs across, in the same minutes, for a span
   * that is not one day: each midnight's line is marked, and hours are read
   * off the local clock rather than counted from minute zero, so past a
   * midnight they start again from 00 instead of running on past 24. Left
   * out, the span is one day counted from its own midnight -- the grid every
   * single-day chart has always been ruled by.
   */
  midnightMinutes?: readonly number[];
  /**
   * The local clock's minute of the day at a line, for the midnight path:
   * what makes its labels clock hours on a daylight-saving day too, where the
   * minutes elapsed since midnight are an hour off the clock after the change.
   * Left out, the minutes since the midnight before the line stand in for it,
   * which is right on every other day.
   */
  clockMinutesAt?: (minutes: number) => number;
}): SlotGridTick[] {
  const span = options.endMinutes - options.startMinutes;
  if (span <= 0 || options.plotWidth <= 0) return [];
  const pxPerMinute = options.plotWidth / span;
  const slot = options.slotMinutes > 0 ? options.slotMinutes : 60;
  const labelStride =
    LABEL_STRIDES.find((stride) => stride * 60 * pxPerMinute >= MIN_LABEL_SPACING) ?? 24;
  // Too narrow for a line per slot: double the step until the lines are apart
  // enough to read as a grid, rather than dropping to hours only -- doubling
  // keeps every line on a slot boundary, which is what the grid is for.
  let step = slot;
  while (step * pxPerMinute < MIN_LINE_SPACING && step < labelStride * 60) {
    step *= 2;
  }
  // Never coarser than the labels: past that there is nothing left to thin out.
  step = Math.min(step, labelStride * 60);

  const named = options.midnightMinutes;
  const midnights = named === undefined ? [0] : [...named].sort((a, b) => a - b);
  // The clock the label reads: minutes since the midnight a line follows,
  // unless the caller can read the real clock.
  const sinceMidnight = (minutes: number) =>
    minutes - (midnights.filter((midnight) => midnight <= minutes).pop() ?? 0);
  const clockOf = named === undefined ? sinceMidnight : options.clockMinutesAt ?? sinceMidnight;
  // Multiples of the stride from midnight, not from the window's own edge, so a
  // cropped day is still labelled on round hours.
  const hourOf = (minutes: number) => {
    const clock = clockOf(minutes);
    return clock % 60 === 0 && (clock / 60) % labelStride === 0 ? clock / 60 : null;
  };
  const tick = (minutes: number): SlotGridTick => {
    const hour = hourOf(minutes);
    return named !== undefined && named.includes(minutes)
      ? { minutes, hour, midnight: true }
      : { minutes, hour };
  };

  const ticks: SlotGridTick[] = [];
  const first = Math.ceil(options.startMinutes / step) * step;
  for (let minutes = first; minutes <= options.endMinutes; minutes += step) {
    ticks.push(tick(minutes));
  }
  // Doubling can step over a labelled hour (a 40-minute step clears 60), so the
  // labels are laid in independently -- the numbers are the coarse scale, and
  // one going missing would leave a stretch of the day unreadable. A named
  // midnight can fall off the step too, on the day after a clock change.
  midnights.forEach((midnight, index) => {
    // One day's hours, up to its own 24 when it is the only day; otherwise up
    // to the next midnight, which labels itself. Past a midnight every whole
    // hour is tried and only the labelled ones kept: after a clock change the
    // stride's hours are no longer a stride of elapsed minutes apart.
    const last = named === undefined ? midnight + 24 * 60 : (midnights[index + 1] ?? Infinity) - 1;
    const stride = named === undefined ? labelStride * 60 : 60;
    for (let minutes = midnight; minutes <= Math.min(last, options.endMinutes); minutes += stride) {
      if (minutes < options.startMinutes) continue;
      if (minutes % step === 0) continue;
      const added = tick(minutes);
      if (named !== undefined && added.hour === null) continue;
      ticks.push(added);
    }
  });
  ticks.sort((a, b) => a.minutes - b.minutes);
  return ticks;
}

/**
 * The grid as SVG: a line per tick between `top` and `bottom`, and -- where a
 * `labelY` is given -- the hour under each labelled one. Rows that sit under
 * the main chart pass no `labelY`: the numbers are printed once, on the axis of
 * the chart that owns them.
 */
export function renderSlotGridlines(options: {
  ticks: readonly SlotGridTick[];
  xForMinutes: (minutes: number) => number;
  top: number;
  bottom: number;
  labelY?: number;
}) {
  const { ticks, xForMinutes, top, bottom, labelY } = options;
  return ticks.map((tick) => {
    const x = xForMinutes(tick.minutes);
    const isLabelled = tick.hour !== null;
    // A named midnight is the day boundary, dashed in the text colour the way
    // the schedule band dashes its own, so a span across it is seen to cross.
    return svg`
      ${tick.midnight
        ? svg`<line class="midnight-line" x1=${x} y1=${top} x2=${x} y2=${bottom}
                    stroke="var(--primary-text-color)" stroke-width="1" stroke-dasharray="4 3"
                    opacity="0.7"></line>`
        : svg`<line x1=${x} y1=${top} x2=${x} y2=${bottom}
                    stroke="var(--divider-color)" stroke-width="1"
                    opacity=${isLabelled ? SLOT_GRID_LINE_OPACITY.major : SLOT_GRID_LINE_OPACITY.minor}></line>`}
      ${tick.hour !== null && labelY !== undefined
        ? svg`<text x=${x} y=${labelY} text-anchor="middle" fill="var(--secondary-text-color)" font-size="11">${pad2(tick.hour)}</text>`
        : ""}
    `;
  });
}
