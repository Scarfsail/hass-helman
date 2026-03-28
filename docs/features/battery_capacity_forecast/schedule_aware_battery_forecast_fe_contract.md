# Schedule-aware Battery Forecast FE Contract

This note describes only the FE-relevant contract changes for `helman/get_forecast`.

## Where to read it

Use `battery_capacity` from the `helman/get_forecast` response.

## What stays the same

The existing battery forecast contract is still the base:

- `status`
- `generatedAt`
- `startedAt`
- `resolution`
- `horizonHours`
- `coverageUntil`
- `currentSoc`
- `minSoc`
- `maxSoc`
- `series`
- `actualHistory`

## Schedule-aware additions

These fields are optional.

### Top-level fields

- `scheduleAdjusted?: boolean`
  - `true`: the returned battery series is affected by schedule execution
  - `false`: schedule-aware evaluation ran, but the returned series stayed baseline-equivalent
  - absent: no schedule-aware path was applied

- `scheduleAdjustmentCoverageUntil?: string | null`
  - ISO timestamp
  - end of the last returned slot with a non-`normal` effective schedule action
  - can be earlier than `coverageUntil`

### Per-point comparison fields

Present when adjusted output is returned:

- `baselineRemainingEnergyKwh?: number`
- `baselineSocPct?: number`

These are the passive/no-schedule comparison values for the same returned point.

## FE semantics

- Treat `socPct` and `remainingEnergyKwh` as the primary forecast values.
- Use `baselineSocPct` and `baselineRemainingEnergyKwh` only for comparison UI.
- Do not treat `scheduleAdjustmentCoverageUntil` as "everything after this equals baseline".
- After `scheduleAdjustmentCoverageUntil`, the forecast continues with normal behavior from the already adjusted battery state, so later points may still differ from baseline.
- `resolution` can be `quarter_hour`, `half_hour`, or `hour`; the schedule-aware metadata survives aggregation.

## Practical UI rule

- If `battery_capacity.scheduleAdjusted === true`, show schedule-impact UI.
- Compare:
  - `socPct` vs `baselineSocPct`
  - `remainingEnergyKwh` vs `baselineRemainingEnergyKwh`
