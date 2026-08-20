/**
 * The money the inspector shows, and the one thing still done to it here.
 *
 * Cost and gain are computed in Python, per slot, from each grid direction's
 * own energy and its own rate, and arrive on the day payload alongside every
 * other total — see `_money_points` in `solar_bias_correction/service.py`. That
 * is what keeps money and energy agreeing about the slot in progress: the drawn
 * money series stops before it exactly as the drawn energy series do, and the
 * day's money totals count it exactly as the day's energy totals do.
 *
 * What is left here is the selection. The tiles can be asked for a subset of
 * the day, which is a sum over supplied amounts rather than a re-derivation —
 * money is a quantity, so slots aggregate by adding.
 */

/** One slot's money, as the day payload carries it. */
export interface MoneyPoint {
  /** Local `HH:MM` slot label, on the rails' own 15-minute grid. */
  slot: string;
  /** What the energy imported in this slot cost. Never negative energy. */
  cost: number;
  /** What the energy exported in this slot earned. Negative if the rate was. */
  gain: number;
}

/** Cost, gain and their difference over some span of slots. */
export interface MoneyTotals {
  cost: number;
  gain: number;
  /** What the grid came to on balance: positive means it took money off you. */
  net: number;
}

export const EMPTY_MONEY: readonly MoneyPoint[] = Object.freeze([]);

/**
 * Sum a money series over a subset of slots.
 *
 * `slots` is the inspector's current selection, on the rails' native grid. The
 * whole day is not summed here — the payload already carries that total, and
 * re-deriving it would be the second opinion this module exists to not have.
 */
export function sumMoney(
  points: readonly MoneyPoint[],
  slots: readonly string[],
): MoneyTotals {
  const wanted = new Set(slots);
  let cost = 0;
  let gain = 0;
  for (const point of points) {
    if (!wanted.has(point.slot)) continue;
    cost += point.cost;
    gain += point.gain;
  }
  return { cost, gain, net: cost - gain };
}

/**
 * The currency a price rail's unit implies: `CZK/kWh` becomes `CZK`.
 *
 * Derived rather than configured, so a setup priced in anything else follows
 * its own unit without a second place to keep in step.
 */
export function currencyFromPriceUnit(unit: string | null | undefined): string {
  if (typeof unit !== "string" || !unit) return "";
  const [currency] = unit.split("/");
  return currency.trim();
}
