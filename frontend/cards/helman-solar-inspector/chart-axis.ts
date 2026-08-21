/**
 * A power tick scale symmetric about zero, in kW.
 *
 * Every watt supplied is a watt consumed, so the supply and demand stacks are
 * mirror images of each other and the axis has to be too: a slot reaching 3 kW
 * of production reaches 3 kW of consumption. One bound serves both directions.
 *
 * The bound is rounded up to a whole multiple of the step, which keeps the
 * outermost ticks on the plot edges and guarantees zero lands exactly on a
 * tick — the baseline the two stacks grow away from.
 */
export function symmetricPowerAxis(peakW: number): { maxKw: number; yTicks: number[] } {
  const bound = Math.max(1, Math.ceil(peakW / 1000));
  const step = Math.max(1, Math.ceil(bound / 3));
  const maxKw = Math.ceil(bound / step) * step;
  const yTicks: number[] = [];
  for (let value = -maxKw; value <= maxKw; value += step) {
    yTicks.push(value);
  }
  return { maxKw, yTicks };
}

/**
 * An energy tick scale symmetric about zero, in kWh.
 *
 * The aggregate views' counterpart to {@link symmetricPowerAxis}, and symmetric
 * for the same reason: a bucket's supply and its demand are two accounts of the
 * same energy, so they have to be read against one scale or the eye compares
 * heights that mean different things.
 *
 * It is a separate function rather than a unit argument because the two are not
 * the same quantity. A day collapsed into one column has no meaningful average
 * power — `toAveragePower` would divide a day's watt-hours by a bucket width
 * that no longer exists — so what these columns carry is energy, and the axis
 * has to say kWh.
 */
export function symmetricEnergyAxis(peakKwh: number): { maxKwh: number; yTicks: number[] } {
  const bound = Math.max(1, Math.ceil(peakKwh));
  const step = Math.max(1, Math.ceil(bound / 3));
  const maxKwh = Math.ceil(bound / step) * step;
  const yTicks: number[] = [];
  for (let value = -maxKwh; value <= maxKwh; value += step) {
    yTicks.push(value);
  }
  return { maxKwh, yTicks };
}
