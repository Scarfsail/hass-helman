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

  // Multiples of the stride from midnight, not from the window's own edge, so a
  // cropped day is still labelled on round hours.
  const labelled = (minutes: number) =>
    minutes % 60 === 0 && (minutes / 60) % labelStride === 0;

  const ticks: SlotGridTick[] = [];
  const first = Math.ceil(options.startMinutes / step) * step;
  for (let minutes = first; minutes <= options.endMinutes; minutes += step) {
    ticks.push({ minutes, hour: labelled(minutes) ? minutes / 60 : null });
  }
  // Doubling can step over a labelled hour (a 40-minute step clears 60), so the
  // labels are laid in independently -- the numbers are the coarse scale, and
  // one going missing would leave a stretch of the day unreadable.
  for (let hour = 0; hour <= 24; hour += labelStride) {
    const minutes = hour * 60;
    if (minutes < options.startMinutes || minutes > options.endMinutes) continue;
    if (minutes % step === 0) continue;
    ticks.push({ minutes, hour });
  }
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
    return svg`
      <line x1=${x} y1=${top} x2=${x} y2=${bottom}
            stroke="var(--divider-color)" stroke-width="1"
            opacity=${isLabelled ? SLOT_GRID_LINE_OPACITY.major : SLOT_GRID_LINE_OPACITY.minor}></line>
      ${isLabelled && labelY !== undefined
        ? svg`<text x=${x} y=${labelY} text-anchor="middle" fill="var(--secondary-text-color)" font-size="11">${String(tick.hour).padStart(2, "0")}</text>`
        : ""}
    `;
  });
}
