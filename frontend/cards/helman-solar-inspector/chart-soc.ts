import type { BatterySocPoint } from "./solar-inspector-model";

/** What the battery did over the slot a column covers. */
export type SocDirection = "charging" | "discharging" | "idle";

/** The SoC window one slot was held within; either end may be unknown. */
export type SocBoundsPoint = { slot: string; minPct: number | null; maxPct: number | null };

/** One column of the SoC strip: a reading, and the movement it leads into. */
export type SocBar = {
  slot: string;
  minutes: number;
  pct: number;
  forecast: boolean;
  direction: SocDirection;
};

/** Below this much movement over a slot the battery is holding, not cycling. */
const IDLE_DEADBAND_PCT = 0.5;

type TimedPoint = { slot: string; minutes: number; pct: number };

export function slotToMinutes(slot: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(slot);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function timed(points: readonly BatterySocPoint[]): TimedPoint[] {
  return points
    .map((point) => ({ slot: point.slot, minutes: slotToMinutes(point.slot), pct: point.pct }))
    .filter((p): p is TimedPoint => p.minutes !== null && Number.isFinite(p.pct))
    .sort((a, b) => a.minutes - b.minutes);
}

function direction(deltaPct: number): SocDirection {
  if (deltaPct > IDLE_DEADBAND_PCT) return "charging";
  if (deltaPct < -IDLE_DEADBAND_PCT) return "discharging";
  return "idle";
}

/**
 * How the battery moves over each slot of one series.
 *
 * A reading is instantaneous but a column covers the slot that *starts* at it,
 * so the movement it stands for is the step to the next reading. Deltas never
 * cross from one series into the other: a forecast built hours ago sits at
 * whatever level it predicted, and subtracting an actual from it would measure
 * that disagreement rather than any charging.
 */
function directionsBySlot(points: readonly TimedPoint[]): Map<string, SocDirection> {
  const directions = new Map<string, SocDirection>();
  for (let index = 0; index + 1 < points.length; index++) {
    directions.set(points[index].slot, direction(points[index + 1].pct - points[index].pct));
  }
  return directions;
}

/**
 * One column per slot, measured where the day has been measured and forecast
 * from `forecastFrom` on — the same seam the chart above fills its stacks at.
 *
 * SoC is read instantaneously, so the actuals carry a reading at the start of
 * the slot the clock is still inside. That reading is real, but the movement
 * across its slot has not happened yet: it stands as the endpoint the last
 * elapsed column moves towards, and the forecast draws the slot itself.
 *
 * A measured column that reaches the seam with no later reading — a gap in the
 * recorder — borrows the forecast's step across its own slot, a delta within
 * the forecast rather than across the seam. Failing that, and for the final
 * column of the day, nothing is known about the movement and the column reads
 * as holding.
 */
export function buildSocBars(
  actual: readonly BatterySocPoint[],
  forecast: readonly BatterySocPoint[],
  forecastFrom: number,
): SocBar[] {
  const measured = timed(actual);
  const projected = timed(forecast);
  const measuredDirections = directionsBySlot(measured);
  const forecastDirections = directionsBySlot(projected);

  const elapsed = measured.filter((point) => point.minutes < forecastFrom);
  // The forecast speaks only for the part of the day the actuals never reached,
  // so the two never contribute a column for the same slot. With no measured
  // column to yield to — no actuals, or the series hidden — it speaks for all
  // of it.
  const ahead = elapsed.length
    ? projected.filter((point) => point.minutes >= forecastFrom)
    : projected;

  return [
    ...elapsed.map((point) => ({
      ...point,
      forecast: false,
      direction:
        measuredDirections.get(point.slot) ?? forecastDirections.get(point.slot) ?? "idle",
    })),
    ...ahead.map((point) => ({
      ...point,
      forecast: true,
      direction: forecastDirections.get(point.slot) ?? "idle",
    })),
  ];
}
