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
