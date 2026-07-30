import { resolveSocDirection, type SocDirection } from "../shared/soc-columns";
import type { BatterySocPoint } from "./solar-inspector-model";

export type { SocDirection };

/** The SoC window one slot was held within; either end may be unknown. */
export type SocBoundsPoint = { slot: string; minPct: number | null; maxPct: number | null };

/** One column of the SoC strip: the level a slot reaches, and how it got there. */
export type SocBar = {
  slot: string;
  minutes: number;
  /** The level the slot ends at — the height the column draws. */
  pct: number;
  /** The level it set out from; equal to `pct` where the step is unknown. */
  fromPct: number;
  forecast: boolean;
  direction: SocDirection;
};

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

/**
 * The step between consecutive readings of one series, keyed by the slot it is
 * taken across.
 *
 * Which slot that is depends on where within a slot the series' readings sit.
 * An actual is measured instantaneously at a slot's start, so the step leading
 * away from it is the one crossing that same slot. A forecast instead reports
 * the level its slot has reached once simulated, so the step arriving at it is
 * the one that crossed the slot it is stamped with. Keyed this way, either
 * series describes the movement over the slot a column covers rather than a
 * neighbour's.
 *
 * Steps never cross from one series into the other: a forecast built hours ago
 * sits at whatever level it predicted, and subtracting an actual from it would
 * measure that disagreement rather than any charging.
 */
function stepsBySlot(
  points: readonly TimedPoint[],
  readingAt: "slot start" | "slot end",
): Map<string, number> {
  const steps = new Map<string, number>();
  for (let index = 0; index + 1 < points.length; index++) {
    const step = points[index + 1].pct - points[index].pct;
    steps.set(
      readingAt === "slot start" ? points[index].slot : points[index + 1].slot,
      step,
    );
  }
  return steps;
}

/**
 * One column per slot, measured where the day has been measured and forecast
 * from `forecastFrom` on — the same seam the chart above fills its stacks at.
 *
 * Every column stands for the level its slot *ends* at, whichever series drew
 * it, so the whole strip reads as one trajectory. The forecast already reports
 * exactly that: a simulated slot is stamped with its start but carries the
 * level left once its own flow has been applied. An actual does not — SoC is
 * read instantaneously — so a measured column takes the reading that opens the
 * following slot, the same reading its step already runs to.
 *
 * That is why the reading at the seam draws no column of its own: the clock is
 * still inside its slot and the movement across it has not happened yet, so it
 * serves as the level the last elapsed column climbs to, and the forecast draws
 * the slot itself.
 *
 * A measured column that reaches the seam with no later reading — a gap in the
 * recorder — borrows the forecast's step across its own slot, a step within the
 * forecast rather than across the seam. Failing that, and for the final column
 * of the day, nothing is known about the movement and the column holds at the
 * level it was read at.
 */
export function buildSocBars(
  actual: readonly BatterySocPoint[],
  forecast: readonly BatterySocPoint[],
  forecastFrom: number,
): SocBar[] {
  const measured = timed(actual);
  const projected = timed(forecast);
  const measuredSteps = stepsBySlot(measured, "slot start");
  const forecastSteps = stepsBySlot(projected, "slot end");

  const elapsed = measured.filter((point) => point.minutes < forecastFrom);
  // The forecast speaks only for the part of the day the actuals never reached,
  // so the two never contribute a column for the same slot. With no measured
  // column to yield to — no actuals, or the series hidden — it speaks for all
  // of it.
  const ahead = elapsed.length
    ? projected.filter((point) => point.minutes >= forecastFrom)
    : projected;

  return [
    ...elapsed.map((point) => {
      const step = measuredSteps.get(point.slot) ?? forecastSteps.get(point.slot) ?? 0;
      return {
        ...point,
        pct: point.pct + step,
        fromPct: point.pct,
        forecast: false,
        direction: resolveSocDirection(step),
      };
    }),
    ...ahead.map((point) => {
      const step = forecastSteps.get(point.slot) ?? 0;
      return {
        ...point,
        fromPct: point.pct - step,
        forecast: true,
        direction: resolveSocDirection(step),
      };
    }),
  ];
}
