import { SLOT_MINUTES } from "./chart-stack";
import { slotToMinutes, type SocBar, type SocBoundsPoint } from "./chart-soc";
import { nodeAccentColor } from "../color-utils";
import type { BucketSourceMix } from "../shared/power-history-bars";
import type {
  ApplianceComponent,
  HouseBreakdownPoint,
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
export function timestampMinutes(timestamp: string): number | null {
  const match = /T(\d{2}):(\d{2})/.exec(timestamp);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** The wider bucket a minute-of-day falls in, as its start minute. */
function bucketStart(minutes: number, slotMinutes: number): number {
  return Math.floor(minutes / slotMinutes) * slotMinutes;
}

/**
 * The "HH:MM" slot key a timestamped sample belongs to.
 *
 * Series are keyed by timestamp and slots by time-of-day, so this is the one
 * rule that joins them; every lookup across the two must agree on it.
 */
export function slotKey(timestamp: string): string {
  return timestamp.slice(11, 16);
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

/**
 * How far the actuals reach, as the end minute of their last measured 15-minute
 * slot. Taken across every actual series so one lagging feed cannot pull the
 * others out of alignment.
 */
export function actualsCoverUntil(
  series: readonly (readonly InspectorPoint[])[],
): number | null {
  let latest: number | null = null;
  for (const points of series) {
    for (const point of points) {
      const minutes = timestampMinutes(point.timestamp);
      if (minutes === null) continue;
      if (latest === null || minutes > latest) latest = minutes;
    }
  }
  return latest === null ? null : latest + SLOT_MINUTES;
}

/**
 * Drop the buckets the actuals only partly cover.
 *
 * Inside the slot we are still living through, a wider bucket holds measurements
 * for the minutes that have passed and nothing for the rest, so summing it
 * produces a short column that reads as a real shortfall against the forecast.
 * A bucket only counts as measured once the actuals reach its end; the ones that
 * do not are dropped, which leaves the forecast to draw them as what they still
 * are — a projection.
 */
export function dropPartialBuckets<T>(
  points: readonly T[],
  slotMinutes: number,
  coverUntil: number | null,
  minutesOf: (point: T) => number | null,
): T[] {
  if (coverUntil === null) return [];
  return points.filter((point) => {
    const start = minutesOf(point);
    return start !== null && start + slotMinutes <= coverUntil;
  });
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
 * Sum the house breakdown into wider buckets. The unmeasured remainder and each
 * appliance are additive energy, so they sum the same way the house series they
 * decompose do; appliances are matched across sub-slots by their entity id so a
 * bucket carries one row per appliance regardless of which sub-slots it ran in.
 */
export function aggregateBreakdownSeries(
  points: HouseBreakdownPoint[],
  slotMinutes: number,
): HouseBreakdownPoint[] {
  if (slotMinutes <= SLOT_MINUTES) return points;
  const buckets = new Map<
    number,
    { unmeasuredWh: number; appliances: Map<string, ApplianceComponent> }
  >();
  for (const point of points) {
    const minutes = slotToMinutes(point.slot);
    if (minutes === null) continue;
    const start = bucketStart(minutes, slotMinutes);
    let bucket = buckets.get(start);
    if (!bucket) {
      bucket = { unmeasuredWh: 0, appliances: new Map() };
      buckets.set(start, bucket);
    }
    if (Number.isFinite(point.unmeasuredWh)) bucket.unmeasuredWh += point.unmeasuredWh;
    for (const appliance of point.appliances) {
      const key = applianceKey(appliance);
      const existing = bucket.appliances.get(key);
      if (existing) {
        existing.wh += Number.isFinite(appliance.wh) ? appliance.wh : 0;
      } else {
        bucket.appliances.set(key, { ...appliance });
      }
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, bucket]) => ({
      slot: minutesToSlot(start),
      unmeasuredWh: bucket.unmeasuredWh,
      appliances: [...bucket.appliances.values()],
    }));
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

/**
 * Sample a per-slot series that reports the level its slot *ends* at down to the
 * wider grid, by keeping each bucket's last reading and restamping it at the
 * bucket's start.
 *
 * The forecast SoC is such a series: a simulated slot is stamped with its start
 * but carries the level left once its own flow has been applied. Keeping the
 * reading at the bucket start — as `sampleOnGrid` does for an instantaneous
 * measurement — would show the level one native slot into the bucket, dragging
 * the whole trajectory late and painting columns as charging for as long after
 * the charge stopped as the bucket is wide.
 */
export function sampleBucketEndOnGrid<T extends { slot: string }>(
  points: T[],
  slotMinutes: number,
): T[] {
  if (slotMinutes <= SLOT_MINUTES) return points;
  const latest = new Map<number, { minutes: number; point: T }>();
  for (const point of points) {
    const minutes = slotToMinutes(point.slot);
    if (minutes === null) continue;
    const start = bucketStart(minutes, slotMinutes);
    const existing = latest.get(start);
    if (!existing || minutes > existing.minutes) latest.set(start, { minutes, point });
  }
  return [...latest.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, entry]) => ({ ...entry.point, slot: minutesToSlot(start) }));
}

/** Sample SoC bounds onto the wider grid, same as any per-slot series. */
export function sampleBounds(
  bounds: SocBoundsPoint[],
  slotMinutes: number,
): SocBoundsPoint[] {
  return sampleOnGrid(bounds, slotMinutes);
}

/**
 * Collapsing a hand-picked slot selection.
 *
 * A multi-slot selection is the same collapse the width buttons do, just over an
 * arbitrary set of slots instead of a fixed grid, so the rules below match the
 * bucket versions above one for one: energy sums null-aware, the correction
 * factor is recomputed from the summed raw and corrected energy rather than
 * averaged, the breakdown merges per appliance, and SoC — a level, not a flow —
 * is read at the selection's first slot instead of summed.
 *
 * Every function takes `slots` in chronological order and tolerates a selection
 * with no matching samples by returning null, so the panel renders "—" rather
 * than a fabricated zero.
 */

/** Sum a timestamp-keyed Wh series over the selected slots. */
export function sumWhOverSlots(
  points: readonly InspectorPoint[],
  slots: readonly string[],
): number | null {
  const wanted = new Set(slots);
  return sumNullable(
    points
      .filter((point) => wanted.has(slotKey(point.timestamp)))
      .map((point) => point.valueWh),
  );
}

/** Sum the correction impact over the selected slots, recomputing the factor. */
export function aggregateImpactOverSlots(
  points: readonly ImpactPoint[],
  slots: readonly string[],
): ImpactPoint | null {
  const wanted = new Set(slots);
  const group = points.filter((point) => wanted.has(point.slot));
  if (group.length === 0) return null;
  const rawWh = sumNullable(group.map((p) => p.rawWh));
  const correctedWh = sumNullable(group.map((p) => p.correctedWh));
  const impactWh = sumNullable(group.map((p) => p.impactWh));
  const factor =
    rawWh !== null && correctedWh !== null && rawWh !== 0 ? correctedWh / rawWh : null;
  // The slot key names where the selection starts, matching how a wider bucket
  // is stamped at its own start.
  return { slot: slots[0] ?? group[0].slot, rawWh, correctedWh, impactWh, factor };
}

/**
 * Split a house series into its deferrable and non-deferrable halves, using the
 * matching per-slot breakdown to say how much of each slot was shiftable.
 *
 * The deferrable half is summed from the breakdown's flagged appliances; the
 * non-deferrable half is whatever the house series has left, floored at zero. So
 * the pair always sums back to the original series — the unmeasured remainder and
 * every non-deferrable meter land in the non-deferrable half by construction —
 * and a slot the breakdown does not cover stays wholly non-deferrable rather than
 * disappearing.
 */
export function splitHouseByDeferrable(
  points: readonly InspectorPoint[],
  breakdown: readonly HouseBreakdownPoint[],
): { deferrable: InspectorPoint[]; nonDeferrable: InspectorPoint[] } {
  const deferrableBySlot = new Map<string, number>();
  for (const point of breakdown) {
    const wh = point.appliances.reduce(
      (sum, appliance) =>
        appliance.deferrable && Number.isFinite(appliance.wh) ? sum + appliance.wh : sum,
      0,
    );
    deferrableBySlot.set(point.slot, (deferrableBySlot.get(point.slot) ?? 0) + wh);
  }
  const deferrable: InspectorPoint[] = [];
  const nonDeferrable: InspectorPoint[] = [];
  for (const point of points) {
    const total = Number.isFinite(point.valueWh) ? point.valueWh : 0;
    const shiftable = Math.min(
      Math.max(0, deferrableBySlot.get(slotKey(point.timestamp)) ?? 0),
      Math.max(0, total),
    );
    deferrable.push({ timestamp: point.timestamp, valueWh: shiftable });
    nonDeferrable.push({ timestamp: point.timestamp, valueWh: total - shiftable });
  }
  return { deferrable, nonDeferrable };
}

/**
 * Whether the breakdown says anything about these slots at all.
 *
 * `splitHouseByDeferrable` leaves an uncovered slot wholly non-deferrable, which
 * is what the chart should draw — the band has to be somewhere. A figure quoted
 * in the popup must not read that silence as a measurement, though: the elapsed
 * half of today's forecast has no composition, and printing its deferrable share
 * as 0 Wh would understate it by exactly what it overstates the other row by.
 */
/**
 * What merges one appliance's rows across slots: its meter, or its name when it
 * has none — the same identity the panel keys its box on.
 */
function applianceKey(appliance: ApplianceComponent): string {
  return appliance.entityId ?? appliance.label;
}

export function breakdownCoversSlots(
  breakdown: readonly HouseBreakdownPoint[],
  slots: readonly string[],
): boolean {
  const wanted = new Set(slots);
  return breakdown.some((point) => wanted.has(point.slot));
}

/** Merge the house breakdown over the selected slots, one row per appliance. */
export function aggregateBreakdownOverSlots(
  points: readonly HouseBreakdownPoint[],
  slots: readonly string[],
): HouseBreakdownPoint | null {
  const wanted = new Set(slots);
  const group = points.filter((point) => wanted.has(point.slot));
  if (group.length === 0) return null;
  let unmeasuredWh = 0;
  const appliances = new Map<string, ApplianceComponent>();
  for (const point of group) {
    if (Number.isFinite(point.unmeasuredWh)) unmeasuredWh += point.unmeasuredWh;
    for (const appliance of point.appliances) {
      const key = applianceKey(appliance);
      const existing = appliances.get(key);
      if (existing) {
        existing.wh += Number.isFinite(appliance.wh) ? appliance.wh : 0;
      } else {
        appliances.set(key, { ...appliance });
      }
    }
  }
  return {
    slot: slots[0] ?? group[0].slot,
    unmeasuredWh,
    appliances: [...appliances.values()],
  };
}

/**
 * The native 15-minute slots a selection covers, in order.
 *
 * A selection is expressed on whatever grid the chart is drawn at, so at hour
 * width one selected slot is four real samples. Bars are meant to show the shape
 * of consumption *within* the selection, so they read off the native grid the
 * backend serves rather than the width the chart happens to use — selecting one
 * hour gives four bars, not one.
 */
export function expandSlotsToNative(
  slots: readonly string[],
  slotMinutes: number,
): string[] {
  const native: string[] = [];
  for (const slot of slots) {
    const start = slotToMinutes(slot);
    if (start === null) continue;
    for (let m = start; m < start + Math.max(SLOT_MINUTES, slotMinutes); m += SLOT_MINUTES) {
      native.push(minutesToSlot(m));
    }
  }
  return native;
}

/**
 * Which sources fed the house in each selected slot.
 *
 * The power card colours a consumer's bars from live source-ratio sensors, but
 * those are a few minutes of in-memory buffer — nothing survives for a slot the
 * inspector is looking back at. What does survive is this day's own per-slot
 * energy, so the same split is reconstructed from it: the grid and battery
 * meters say exactly how much each delivered, and solar takes the remainder.
 *
 * Deriving solar as the remainder rather than reading the production series
 * keeps the three parts summing to the house total by construction — production
 * that went to export or into the battery never reaches the house and must not
 * colour its bars.
 *
 * The result is a house-level mix: within one slot every consumer is shown the
 * same proportions, because the house draws from one blended bus and no
 * per-appliance source attribution is recorded anywhere.
 */
export function houseSourceMixBySlot(
  series: {
    houseActual: readonly InspectorPoint[];
    gridActual: readonly InspectorPoint[];
    batteryActual: readonly InspectorPoint[];
  },
  slots: readonly string[],
): Map<string, BucketSourceMix> {
  const bySlot = (points: readonly InspectorPoint[]) => {
    const map = new Map<string, number>();
    for (const point of points) {
      const value = point.valueWh;
      if (!Number.isFinite(value)) continue;
      map.set(slotKey(point.timestamp), value);
    }
    return map;
  };
  const house = bySlot(series.houseActual);
  const grid = bySlot(series.gridActual);
  const battery = bySlot(series.batteryActual);

  const mixes = new Map<string, BucketSourceMix>();
  for (const slot of slots) {
    const houseWh = house.get(slot);
    if (houseWh === undefined || houseWh <= 0) continue;
    // Positive grid is export and positive battery is charge, so the flows that
    // reach the house are the negated sides. Clamped, and capped at the house
    // total so a meter that over-reports cannot push solar negative.
    const fromGrid = Math.min(houseWh, Math.max(0, -(grid.get(slot) ?? 0)));
    const fromBattery = Math.min(houseWh - fromGrid, Math.max(0, -(battery.get(slot) ?? 0)));
    const fromSolar = Math.max(0, houseWh - fromGrid - fromBattery);
    const mix: BucketSourceMix = {};
    // nodeAccentColor, not the raw palette value: these are backgrounds drawn
    // behind text, and it is what the power card's own bars are painted with, so
    // both views read at the same strength.
    if (fromSolar > 0) mix.solar = { power: fromSolar, color: nodeAccentColor("solar") };
    if (fromBattery > 0) mix.battery = { power: fromBattery, color: nodeAccentColor("battery") };
    if (fromGrid > 0) mix.grid = { power: fromGrid, color: nodeAccentColor("grid") };
    if (Object.keys(mix).length > 0) mixes.set(slot, mix);
  }
  return mixes;
}

/**
 * One consumer's per-slot energy across the selection, as bar values paired with
 * the slot's source mix scaled to that consumer's share.
 *
 * Slots the consumer did not run in still yield a zero-height bar, so the row
 * keeps the selection's time axis and reads as "when did this run", not just
 * "how much".
 */
export function consumerBarsOverSlots(
  points: readonly HouseBreakdownPoint[],
  slots: readonly string[],
  /** An appliance's energy sensor, `null` for the unmetered remainder, or
   *  `undefined` for the whole house — every part summed. */
  entityId: string | null | undefined,
  mixes: Map<string, BucketSourceMix>,
): { values: number[]; sourceHistory: (BucketSourceMix | undefined)[] } {
  return partBarsOverSlots(points, slots, mixes, (point) => {
    if (entityId === undefined) {
      return (
        finiteWh(point.unmeasuredWh) +
        point.appliances.reduce((sum, a) => sum + finiteWh(a.wh), 0)
      );
    }
    if (entityId === null) return finiteWh(point.unmeasuredWh);
    const appliance = point.appliances.find((a) => a.entityId === entityId);
    return appliance ? finiteWh(appliance.wh) : 0;
  });
}

const finiteWh = (value: number) => (Number.isFinite(value) ? Math.max(0, value) : 0);

/**
 * Bars for any part of the house, named by how much of a slot it drew.
 *
 * The scaling of the source mix is the whole point of doing this once: a bar's
 * segments only mean anything if they are the house's own mix rescaled to that
 * part's energy, so one consumer, a group of them and the house itself are all
 * measured the same way and stack honestly against each other.
 */
export function partBarsOverSlots(
  points: readonly HouseBreakdownPoint[],
  slots: readonly string[],
  mixes: Map<string, BucketSourceMix>,
  energyInSlot: (point: HouseBreakdownPoint) => number,
): { values: number[]; sourceHistory: (BucketSourceMix | undefined)[] } {
  const bySlot = new Map(points.map((point) => [point.slot, point]));
  const values: number[] = [];
  const sourceHistory: (BucketSourceMix | undefined)[] = [];
  for (const slot of slots) {
    const point = bySlot.get(slot);
    const wh = point ? finiteWh(energyInSlot(point)) : 0;
    values.push(wh);
    // The house mix is a set of proportions; rescaling it to this consumer's own
    // energy keeps each segment's height meaningful against the bar it sits in.
    const houseMix = mixes.get(slot);
    if (!houseMix || wh <= 0) {
      sourceHistory.push(undefined);
      continue;
    }
    const houseTotal = Object.values(houseMix).reduce((sum, part) => sum + part.power, 0);
    if (houseTotal <= 0) {
      sourceHistory.push(undefined);
      continue;
    }
    const scaled: BucketSourceMix = {};
    for (const [sourceId, part] of Object.entries(houseMix)) {
      scaled[sourceId] = { power: (part.power / houseTotal) * wh, color: part.color };
    }
    sourceHistory.push(scaled);
  }
  return { values, sourceHistory };
}

/**
 * The level the selection *ends* at, read off the strip's own columns.
 *
 * Summing a level would be meaningless, so a selection reports a reading rather
 * than a total — and the reading that describes a span is the one it closes on,
 * the same statement every column of the strip makes about its own slot. Taking
 * it from the bars rather than the raw series is what keeps the two agreeing:
 * the bars already resolve where within a slot each series is read, so a
 * measured selection reports the reading that opens the slot after it and a
 * forecast one the level its last slot was simulated to.
 *
 * The last selected slot may have no column at all — a selection can run past
 * where a series reaches — so this walks back to the last one that does.
 */
export function socBarAtSelectionEnd(
  bars: readonly SocBar[],
  slots: readonly string[],
): SocBar | null {
  for (let index = slots.length - 1; index >= 0; index--) {
    const found = bars.find((bar) => bar.slot === slots[index]);
    if (found) return found;
  }
  return null;
}

/** Snap a selected "HH:MM" slot onto the wider grid's bucket start. */
export function snapSlotToGrid(slot: string, slotMinutes: number): string {
  const minutes = slotToMinutes(slot);
  if (minutes === null) return slot;
  return minutesToSlot(bucketStart(minutes, slotMinutes));
}
