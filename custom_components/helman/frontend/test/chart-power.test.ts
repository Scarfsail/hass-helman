import { toAveragePower } from "../src/chart-power.js";

function assertEqual(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
  }
}

const sparseActuals = toAveragePower(
  [
    { timestamp: "2026-04-28T14:15:00+02:00", valueWh: 2300 },
    { timestamp: "2026-04-28T16:15:00+02:00", valueWh: 1900 },
  ],
  { bucketMinutes: 15 },
);

assertEqual(sparseActuals[0].powerW, 9200);
assertEqual(sparseActuals[1].powerW, 7600);

const hourlyForecast = toAveragePower([
  { timestamp: "2026-04-28T14:00:00+02:00", valueWh: 8856.25 },
  { timestamp: "2026-04-28T15:00:00+02:00", valueWh: 7757.5 },
]);

assertEqual(hourlyForecast[0].powerW, 8856.25);
assertEqual(hourlyForecast[1].powerW, 7757.5);
