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

/**
 * One slot's money, as the day payload carries it.
 *
 * Either side is `null` where that direction's rail had no rate for the slot.
 * The energy is real and its price is unknown, which is not "it earned
 * nothing" — a day older than the sell-price entity exported real kWh — so the
 * unknown side travels as a null all the way to the em dash the reader sees,
 * and never as a zero some sum could quietly swallow.
 */
export interface MoneyPoint {
  /** Local `HH:MM` slot label, on the rails' own 15-minute grid. */
  slot: string;
  /** What the energy imported in this slot cost, or null if unpriced. */
  cost: number | null;
  /** What the energy exported in this slot earned, or null if unpriced. */
  gain: number | null;
}

/**
 * Cost, gain and their difference over some span of slots, each independently
 * unknown.
 *
 * The same shape the day payload's totals arrive in, so the day's totals and a
 * selection's sums cannot drift apart — and the shape the span views use too,
 * where a bucket the backend could not price on one side has always been null.
 */
export interface MoneyTotals {
  cost: number | null;
  gain: number | null;
  /** What the grid came to on balance: positive means it took money off you. */
  net: number | null;
}

/** Money over a span with nothing in it at all: three unknowns. */
export const UNPRICED_MONEY: MoneyTotals = Object.freeze({
  cost: null,
  gain: null,
  net: null,
});

export const EMPTY_MONEY: readonly MoneyPoint[] = Object.freeze([]);

/**
 * Sum a money series over a subset of slots.
 *
 * `slots` is the inspector's current selection, on the rails' native grid. The
 * whole day is not summed here — the payload already carries that total, and
 * re-deriving it would be the second opinion this module exists to not have.
 *
 * Each direction is summed over the selected slots that priced it, and is null
 * where none of them did — a selection with no priced slot at all is three
 * nulls, so "nothing selected here" and "it came to zero" stay apart. `net`
 * needs both sides: subtracting an unknown gain from a known cost would restate
 * the import bill as what the grid came to, which is the one claim the missing
 * rate does not support.
 */
export function sumMoney(
  points: readonly MoneyPoint[],
  slots: readonly string[],
): MoneyTotals {
  const wanted = new Set(slots);
  let cost: number | null = null;
  let gain: number | null = null;
  for (const point of points) {
    if (!wanted.has(point.slot)) continue;
    if (point.cost !== null) cost = (cost ?? 0) + point.cost;
    if (point.gain !== null) gain = (gain ?? 0) + point.gain;
  }
  return { cost, gain, net: moneyNet(cost, gain) };
}

/** What the grid came to, or null unless both directions are known. */
export function moneyNet(cost: number | null, gain: number | null): number | null {
  return cost === null || gain === null ? null : cost - gain;
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
