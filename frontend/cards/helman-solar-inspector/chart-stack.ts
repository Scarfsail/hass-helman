import type { ChartEntry } from "./chart-power";

/**
 * One band of a stacked area: a colour, and average power per 15-minute slot in
 * the chart's supply-positive convention.
 *
 * Battery and grid appear in both the supply and the demand stack — the same
 * layer object, clamped to one side of zero at render time, since a single slot
 * is either charging or discharging but never both.
 */
export type StackLayer = { color: string; values: Map<number, number> };

/** Supply stacks upwards from zero, demand downwards, each in its own order. */
export type StackSet = { positive: StackLayer[]; negative: StackLayer[] };

export type StackBand = {
  layer: StackLayer;
  base: Map<number, number>;
  top: Map<number, number>;
};

export const SLOT_MINUTES = 15;

export function toSlotMap(entries: ChartEntry[]): Map<number, number> {
  return new Map(entries.map((entry) => [entry.minutes, entry.powerW]));
}

/** Clamp a slot's power to one side of zero: supply above, demand below. */
export function clampToSign(powerW: number, sign: 1 | -1): number {
  return sign > 0 ? Math.max(0, powerW) : Math.min(0, powerW);
}

/**
 * The contiguous run of slots the stack spans, from its first sample to its
 * last. Slots with no sample count as zero rather than as a hole, so a band
 * closes down to the baseline instead of bridging the gap at its own height.
 */
export function stackSlots(set: StackSet): number[] {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const layer of [...set.positive, ...set.negative]) {
    for (const minutes of layer.values.keys()) {
      if (minutes < first) first = minutes;
      if (minutes > last) last = minutes;
    }
  }
  if (!Number.isFinite(first)) return [];
  const slots: number[] = [];
  for (let m = first; m <= last; m += SLOT_MINUTES) slots.push(m);
  return slots;
}

/**
 * The last slot any layer of the stack has a sample for, or null when empty.
 *
 * Applied to the measured stack this is where history stops and the forecast
 * takes over as the only account of the day.
 */
export function lastStackSlot(set: StackSet): number | null {
  let last = Number.NEGATIVE_INFINITY;
  for (const layer of [...set.positive, ...set.negative]) {
    for (const minutes of layer.values.keys()) {
      if (minutes > last) last = minutes;
    }
  }
  return Number.isFinite(last) ? last : null;
}

/** Per-slot totals of both halves of a stack, for sizing the power axis. */
export function stackTotals(set: StackSet): number[] {
  const slots = stackSlots(set);
  const totals: number[] = [];
  for (const sign of [1, -1] as const) {
    const layers = sign > 0 ? set.positive : set.negative;
    for (const minutes of slots) {
      let total = 0;
      for (const layer of layers) total += clampToSign(layer.values.get(minutes) ?? 0, sign);
      totals.push(total);
    }
  }
  return totals;
}

/**
 * Running totals of a stack, band by band from the zero baseline outwards.
 *
 * Each band's `top` is the cumulative power at its outer edge and `base` the
 * inner one. Bands that never leave the baseline are dropped, so an
 * all-charging battery contributes nothing to the supply stack.
 */
/**
 * The slots where a band has height, grouped into contiguous runs.
 *
 * A band that is flat in a slot — a battery that charges at noon contributes
 * nothing to the supply stack there — would otherwise be drawn as a
 * zero-height sliver whose stroke lands exactly on the band beneath it. Each
 * run becomes its own path, so those slots are simply not drawn.
 */
export function bandRuns(band: StackBand, slots: number[]): number[][] {
  const runs: number[][] = [];
  let current: number[] = [];
  for (const minutes of slots) {
    if (band.top.get(minutes) !== band.base.get(minutes)) {
      current.push(minutes);
    } else if (current.length) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length) runs.push(current);
  return runs;
}

export function accumulateBands(
  layers: StackLayer[],
  slots: number[],
  sign: 1 | -1,
): StackBand[] {
  const bands: StackBand[] = [];
  let base = new Map(slots.map((minutes) => [minutes, 0]));
  for (const layer of layers) {
    const top = new Map<number, number>();
    let occupied = false;
    for (const minutes of slots) {
      const value = clampToSign(layer.values.get(minutes) ?? 0, sign);
      if (value !== 0) occupied = true;
      top.set(minutes, base.get(minutes)! + value);
    }
    if (occupied) bands.push({ layer, base, top });
    base = top;
  }
  return bands;
}
