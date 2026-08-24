/**
 * The one palette every inspector chart is drawn from.
 *
 * It lives in its own module rather than in `helman-solar-inspector.ts` only so
 * that the aggregate chart can share it without importing the card that mounts
 * it -- the map is the day view's, and the aggregate views take it as-is so the
 * two granularities cannot drift into two sets of colours for one quantity.
 *
 * `grid` is the *net* grid series the day chart draws as one signed band. Where
 * import and export are separate meters -- the money rows, the aggregate
 * views' six-meter panels -- they take `gridImport` and `gridExport`, because
 * two directions painted one colour say they are the same reading.
 */
import {
  BATT_COLOR,
  CHARGE_COLOR,
  DEFERRABLE_HOUSE_COLOR,
  DISCHARGE_COLOR,
  FORECAST_RAW_COLOR,
  GRID_COLOR,
  GRID_EXPORT_COLOR,
  GRID_IMPORT_COLOR,
  HOUSE_COLOR,
  SOLAR_COLOR,
} from "../color-utils";

export const CHART_COLORS = {
  raw:             FORECAST_RAW_COLOR,
  corrected:       SOLAR_COLOR,
  actual:          SOLAR_COLOR,
  house:           HOUSE_COLOR,
  houseDeferrable: DEFERRABLE_HOUSE_COLOR,
  battery:         BATT_COLOR,
  grid:            GRID_COLOR,
  gridImport:      GRID_IMPORT_COLOR,
  gridExport:      GRID_EXPORT_COLOR,
  impactPositive:  CHARGE_COLOR,
  impactNegative:  DISCHARGE_COLOR,
} as const;
