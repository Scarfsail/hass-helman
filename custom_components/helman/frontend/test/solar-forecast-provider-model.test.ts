import { buildSolarForecastProviderLabel } from "../src/solar-forecast-provider-model.js";

function assertEqual(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
  }
}

assertEqual(
  buildSolarForecastProviderLabel({
    entry_id: "forecast-entry",
    title: "Forecast.Solar Roof",
    domain: "forecast_solar",
  }),
  "Forecast.Solar Roof (forecast_solar)",
);
