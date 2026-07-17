import { SLOT_MINUTES } from "./chart-stack";
import { slotToMinutes, type SocBoundsPoint } from "./chart-soc";
import type {
  BatterySocPoint,
  ImpactPoint,
  InspectorPoint,
} from "./solar-inspector-model";

/**
 * Collapsing 15-minute slots into wider ones.
 *
 * The backend always serves the day at its native 15-minute resolution. To draw
 * it at 30 or 60 minutes the card re-buckets the series here before rendering,
 * so everything downstream — stacks, hit-testing, the selected-slot panel —
 * sees one slot per wider bucket. The chosen width is always a multiple of 15,
 * so every wider bucket lands on real sample boundaries and no slot is split.
 */

/** Minute-of-day from an ISO-ish "…THH:MM…" timestamp; null if unparseable. */
function timestampMinutes(timestamp: string): number | null {
  const match = /T(\d{2}):(\d{2})/.exec(timestamp);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** The wider bucket a minute-of-day falls in, as its start minute. */
function bucketStart(minutes: number, slotMinutes: number): number {
  return Math.floor(minutes / slotMinutes) * slotMinutes;
}

/** "HH:MM" for a minute-of-day. */
export function minutesToSlot(minutes: number): string {
  const clamped = Math.max(0, Math.floor(minutes));
  const hh = String(Math.floor(clamped / 60)).padStart(2, "0");
  const mm = String(clamped % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * The sample timestamp with its time-of-day rewritten to the bucket start,
 * keeping the date, seconds and zone offset so the rest of the card parses it
 * unchanged. A series may start off the wider grid — actuals often begin
 * mid-hour — so the bucket must be stamped at its grid-aligned start, not at the
 * earliest sample, or `stackSlots` would step off the sample keys and drop every
 * band but the first.
 */
function bucketTimestamp(sampleTimestamp: string, bucketStartMinutes: number): string {
  const hh = String(Math.floor(bucketStartMinutes / 60)).padStart(2, "0");
  const mm = String(bucketStartMinutes % 60).padStart(2, "0");
  return sampleTimestamp.replace(/T\d{2}:\d{2}/, `T${hh}:${mm}`);
}

/**
 * Sum a Wh series into wider buckets, stamping each at its grid-aligned start so
 * downstream slot keys land on the wider grid regardless of where the series
 * begins.
 */
export function aggregateWhSeries(
  points: InspectorPoint[],
  slotMinutes: number,
): InspectorPoint[] {
  if (slotMinutes <= SLOT_MINUTES) return points;
  const buckets = new Map<number, { timestamp: string; valueWh: number }>();
  for (const point of points) {
    const minutes = timestampMinutes(point.timestamp);
    if (minutes === null || !Number.isFinite(point.valueWh)) continue;
    const start = bucketStart(minutes, slotMinutes);
    const existing = buckets.get(start);
    if (existing) {
      existing.valueWh += point.valueWh;
    } else {
      buckets.set(start, { timestamp: bucketTimestamp(point.timestamp, start), valueWh: point.valueWh });
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, bucket]) => ({ timestamp: bucket.timestamp, valueWh: bucket.valueWh }));
}

/** Null-aware sum: null when every contributor is null, else the finite total. */
function sumNullable(values: (number | null)[]): number | null {
  let total = 0;
  let seen = false;
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue;
    total += value;
    seen = true;
  }
  return seen ? total : null;
}

/**
 * Sum the correction impact into wider buckets. Raw, corrected and impact energy
 * are all additive; the factor is a ratio, so it is recomputed from the summed
 * raw and corrected energy rather than averaged.
 */
export function aggregateImpactSeries(
  points: ImpactPoint[],
  slotMinutes: number,
): ImpactPoint[] {
  if (slotMinutes <= SLOT_MINUTES) return points;
  const buckets = new Map<number, ImpactPoint[]>();
  for (const point of points) {
    const minutes = slotToMinutes(point.slot);
    if (minutes === null) continue;
    const start = bucketStart(minutes, slotMinutes);
    (buckets.get(start) ?? buckets.set(start, []).get(start)!).push(point);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, group]) => {
      const rawWh = sumNullable(group.map((p) => p.rawWh));
      const correctedWh = sumNullable(group.map((p) => p.correctedWh));
      const impactWh = sumNullable(group.map((p) => p.impactWh));
      const factor =
        rawWh !== null && correctedWh !== null && rawWh !== 0 ? correctedWh / rawWh : null;
      return { slot: minutesToSlot(start), rawWh, correctedWh, impactWh, factor };
    });
}

/**
 * Sample a per-slot series down to the wider grid by keeping only the readings
 * that land on a bucket start. SoC is a level, not a flow, so a wider column
 * shows the reading at its start rather than a sum across it — the same reading
 * the 15-minute column at that time already showed.
 */
export function sampleOnGrid<T extends { slot: string }>(
  points: T[],
  slotMinutes: number,
): T[] {
  if (slotMinutes <= SLOT_MINUTES) return points;
  return points.filter((point) => {
    const minutes = slotToMinutes(point.slot);
    return minutes !== null && minutes % slotMinutes === 0;
  });
}

/** Sample SoC bounds onto the wider grid, same as any per-slot series. */
export function sampleBounds(
  bounds: SocBoundsPoint[],
  slotMinutes: number,
): SocBoundsPoint[] {
  return sampleOnGrid(bounds, slotMinutes);
}

/** Snap a selected "HH:MM" slot onto the wider grid's bucket start. */
export function snapSlotToGrid(slot: string, slotMinutes: number): string {
  const minutes = slotToMinutes(slot);
  if (minutes === null) return slot;
  return minutesToSlot(bucketStart(minutes, slotMinutes));
}
