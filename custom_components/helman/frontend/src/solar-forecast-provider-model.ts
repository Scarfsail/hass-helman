import type { SolarForecastSourceOption } from "./types";

export function buildSolarForecastProviderLabel(
  option: SolarForecastSourceOption,
): string {
  return `${option.title} (${option.domain})`;
}
