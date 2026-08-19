import type { InspectorPoint } from "./solar-inspector-model";
import type { PriceRailPoint } from "./helman-solar-price-strip";

/**
 * What the grid cost and paid, derived from energy and price rather than stored.
 *
 * Money is never computed in Python. The rails and the two grid directions all
 * arrive on the day payload, and the frontend already re-buckets every series
 * when the slot-size control changes, so a backend-computed money series would
 * have to be re-derived here anyway. Doing it once, here, keeps the arithmetic
 * in one place — the strip, the metric tiles and the tooltip all call this.
 *
 * The one rule worth stating plainly: cost and gain are computed per slot and
 * then summed. A day's cost is not its total imported energy times an average
 * price, because the expensive hours are rarely the ones you imported in.
 */

const MINUTES_PER_DAY = 24 * 60;
const RAIL_SLOT_MINUTES = 15;

/** One slot's money, in the price rail's currency. */
export interface MoneyPoint {
  /** Local `HH:MM` slot label, on the rail's own 15-minute grid. */
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
export const ZERO_TOTALS: MoneyTotals = Object.freeze({ cost: 0, gain: 0, net: 0 });

/** A rail keyed by slot label, dropping anything unparseable. */
function railBySlot(rail: readonly PriceRailPoint[] | undefined): Map<string, number> {
  const bySlot = new Map<string, number>();
  for (const point of rail ?? []) {
    const value = Number(point?.value);
    if (!Number.isFinite(value) || typeof point.slot !== "string") continue;
    bySlot.set(point.slot, value);
  }
  return bySlot;
}

/**
 * An energy series keyed by slot label, in kWh.
 *
 * The energy series are timestamped points carrying Wh, while the price rails
 * are slot-labelled — so this is where the two are brought onto one key. The
 * label is read off the timestamp's local time text rather than parsed into a
 * Date, which is what every other slot lookup in the inspector does and what
 * keeps a day that crosses a DST boundary on the grid the backend built.
 */
function energyKwhBySlot(points: readonly InspectorPoint[] | undefined): Map<string, number> {
  const bySlot = new Map<string, number>();
  for (const point of points ?? []) {
    const timestamp = point?.timestamp;
    if (typeof timestamp !== "string" || timestamp.length < 16) continue;
    const wh = Number(point.valueWh);
    if (!Number.isFinite(wh)) continue;
    const slot = timestamp.slice(11, 16);
    bySlot.set(slot, (bySlot.get(slot) ?? 0) + wh / 1000);
  }
  return bySlot;
}

/**
 * Cost and gain per slot, for one vintage (forecast or actual).
 *
 * A slot appears when either direction has energy for it and a price to value
 * it at. A direction with energy but no price contributes nothing rather than
 * zero — the difference matters, because a day past the recorder's reach has
 * real exported kWh whose rate is simply unknown, and calling that "earned
 * nothing" would be a claim the data does not support.
 */
export function buildMoneySeries(input: {
  importKwh: readonly InspectorPoint[] | undefined;
  exportKwh: readonly InspectorPoint[] | undefined;
  importPrice: readonly PriceRailPoint[] | undefined;
  exportPrice: readonly PriceRailPoint[] | undefined;
}): MoneyPoint[] {
  const imported = energyKwhBySlot(input.importKwh);
  const exported = energyKwhBySlot(input.exportKwh);
  const importRate = railBySlot(input.importPrice);
  const exportRate = railBySlot(input.exportPrice);

  const points: MoneyPoint[] = [];
  for (let minutes = 0; minutes < MINUTES_PER_DAY; minutes += RAIL_SLOT_MINUTES) {
    const slot = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    const importKwh = imported.get(slot);
    const exportKwh = exported.get(slot);
    const costRate = importRate.get(slot);
    const gainRate = exportRate.get(slot);
    const cost = importKwh !== undefined && costRate !== undefined ? importKwh * costRate : 0;
    const gain = exportKwh !== undefined && gainRate !== undefined ? exportKwh * gainRate : 0;
    const priced =
      (importKwh !== undefined && costRate !== undefined)
      || (exportKwh !== undefined && gainRate !== undefined);
    if (!priced) continue;
    points.push({ slot, cost, gain });
  }
  return points;
}

/**
 * Sum a money series, optionally over a subset of slots.
 *
 * `slots` is the inspector's current selection; passing null totals the day.
 * Summing per slot is the whole point — see the note at the top of the file.
 */
export function sumMoney(
  points: readonly MoneyPoint[],
  slots: readonly string[] | null = null,
): MoneyTotals {
  const wanted = slots === null ? null : new Set(slots);
  let cost = 0;
  let gain = 0;
  for (const point of points) {
    if (wanted !== null && !wanted.has(point.slot)) continue;
    cost += point.cost;
    gain += point.gain;
  }
  return { cost, gain, net: cost - gain };
}

/** One slot's money, or null where the day priced nothing for it. */
export function moneyAtSlot(
  points: readonly MoneyPoint[],
  slot: string | null,
): MoneyPoint | null {
  if (!slot) return null;
  return points.find((point) => point.slot === slot) ?? null;
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
