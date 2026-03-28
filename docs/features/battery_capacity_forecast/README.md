# Battery Capacity Forecast

## Status

Implemented in `hass-helman` and exposed through `helman/get_forecast`.

The battery simulation now runs on a **canonical 15-minute model** and the response layer aggregates that data to `15`, `30`, or `60` minute payloads. The current frontend compatibility path still requests hourly data.

## References

- **Implementation strategy**: [`implementation_strategy.md`](./implementation_strategy.md)
- **Implementation progress**: [`implementation_progress.md`](./implementation_progress.md)
- **Schedule-aware analysis**: [`schedule_aware_battery_forecast_analysis.md`](./schedule_aware_battery_forecast_analysis.md)
- **Schedule-aware implementation strategy**: [`schedule_aware_battery_forecast_implementation_strategy.md`](./schedule_aware_battery_forecast_implementation_strategy.md)
- **Schedule-aware implementation progress**: [`schedule_aware_battery_forecast_implementation_progress.md`](./schedule_aware_battery_forecast_implementation_progress.md)
- **Backend repo**: `/home/ondra/dev/hass/hass-helman/custom_components/helman/`
- **Frontend repo**: `/home/ondra/dev/hass/hass-helman-card/src/`

## Goal

Project battery SoC and remaining energy from:

- live battery state
- canonical solar forecast data
- canonical house baseline consumption
- configured charge / discharge efficiency
- configured charge / discharge power limits

The backend owns the simulation. The frontend only renders the returned payload.

## Request contract

`helman/get_forecast` accepts these optional forecast parameters:

- `granularity`: `15 | 30 | 60` — default `60`
- `forecast_days`: integer `1..14` — default `7`

The battery section is always simulated from one canonical 15-minute model. The returned `granularity` only changes response shaping.

## Current runtime behavior

- The simulation starts from **now**, not from the next bucket boundary.
- The first slot is fractional from `now` to the next 15-minute boundary, so `durationHours` is always `<= 0.25`.
- All following slots are canonical 15-minute slots.
- Solar input is treated as **absolute energy per source period**, not as a rate.
- If the solar source uses larger periods, the backend splits those values into canonical 15-minute slots before simulation.
- House input comes from the canonical `house_consumption.currentSlot` and `house_consumption.series[].nonDeferrable.value`.
- If future solar data runs out, the forecast returns `status: "partial"` with `partialReason` and `coverageUntil` instead of inventing zero-production slots.

## Schedule-aware battery behavior

- The request contract does **not** change when schedule-aware behavior is active. The battery section still comes from `helman/get_forecast`.
- When manual schedule execution is enabled and the forecast-facing schedule contains executable non-`normal` actions, the primary `battery_capacity.series` becomes schedule-adjusted.
- Schedule-aware behavior only applies inside the explicit rolling scheduler horizon. After the last non-`normal` effective schedule slot, the battery forecast continues with `normal` behavior from the current adjusted battery state.
- `scheduleAdjusted` is `true` when the returned battery series contains schedule-adjusted output.
- `scheduleAdjustmentCoverageUntil` is the end timestamp of the last returned slot where a non-`normal` effective schedule action was applied. It can be earlier than the forecast-wide `coverageUntil`.
- After `scheduleAdjustmentCoverageUntil`, later slots may still differ from the passive baseline because they continue from the battery state produced by the earlier scheduled actions.
- When adjusted output is active, each returned battery slot also includes:
  - `baselineRemainingEnergyKwh`
  - `baselineSocPct`
- Those baseline comparison fields survive `15 -> 30 -> 60` aggregation, so the hourly compatibility path can still compare adjusted output against the passive baseline.

## Cache behavior

- The coordinator keeps a **lazy in-memory battery cache** for about `5` minutes.
- The cache stores the canonical 15-minute battery response, not an hourly-only variant.
- Shorter `forecast_days` requests reuse the same canonical cached result and slice / aggregate it on demand.
- The cache is invalidated when:
  - the current 15-minute slot changes
  - the house snapshot changes
  - the canonical solar input changes
  - schedule execution state changes
  - the executable forecast-facing schedule signature changes
  - the cached projection no longer matches the current live battery state closely enough
  - the TTL expires
- Active executable target-action slots intentionally avoid cache reuse inside the current canonical slot so the first returned battery bucket cannot go stale while a target is still being crossed.
- The battery cache is **not** persisted across restart.

## Returned payload overview

The battery forecast is returned from `helman/get_forecast` under `battery_capacity`.

```json
{
  "battery_capacity": {
    "status": "available",
    "generatedAt": "2026-03-20T21:20:30+01:00",
    "startedAt": "2026-03-20T21:20:00+01:00",
    "unit": "kWh",
    "resolution": "hour",
    "horizonHours": 24,
    "model": "battery_net_load_fractional_hour_v1",
    "currentSoc": 51.0,
    "currentRemainingEnergyKwh": 5.1,
    "minSoc": 10.0,
    "maxSoc": 90.0,
    "chargeEfficiency": 0.95,
    "dischargeEfficiency": 0.95,
    "maxChargePowerW": 5000,
    "maxDischargePowerW": 5000,
    "partialReason": null,
    "coverageUntil": "2026-03-21T21:00:00+01:00",
    "actualHistory": [
      {
        "timestamp": "2026-03-20T20:00:00+01:00",
        "startSocPct": 40.0,
        "socPct": 44.0
      }
    ],
    "series": [
      {
        "timestamp": "2026-03-20T21:20:00+01:00",
        "durationHours": 0.6667,
        "solarKwh": 0.6,
        "baselineHouseKwh": 0.3,
        "netKwh": 0.3,
        "chargedKwh": 0.3,
        "dischargedKwh": 0.0,
        "remainingEnergyKwh": 5.3,
        "socPct": 53.0,
        "importedFromGridKwh": 0.0,
        "exportedToGridKwh": 0.0,
        "hitMinSoc": false,
        "hitMaxSoc": false,
        "limitedByChargePower": false,
        "limitedByDischargePower": false
      }
    ]
  }
}
```

### Response semantics

- `resolution` reflects the returned payload granularity (`quarter_hour`, `half_hour`, or `hour`).
- `horizonHours` reflects the requested `forecast_days`.
- `series` starts with the **current returned battery bucket**.
- `actualHistory` uses the same returned granularity and only contains completed past buckets.
- `scheduleAdjusted` and `scheduleAdjustmentCoverageUntil` describe only the schedule-adjusted portion of the returned battery series.
- `scheduleAdjustmentCoverageUntil` may be earlier than the overall `coverageUntil`.
- `scheduleAdjustmentCoverageUntil` does **not** mean later forecast slots must equal the passive baseline; it only marks the last non-`normal` effective schedule slot.
- For aggregated battery buckets:
  - energy and duration fields are summed
  - `remainingEnergyKwh` and `socPct` come from the last sub-slot
  - `baselineRemainingEnergyKwh` and `baselineSocPct` also come from the last sub-slot
  - boolean limiter / boundary flags are ORed

## Input assumptions

- Battery live state comes from the configured battery entities under `power_devices.battery`.
- The simulation uses:
  - `remaining_energy`
  - `capacity`
  - `min_soc`
  - `max_soc`
- Forecast settings use:
  - `charge_efficiency`
  - `discharge_efficiency`
  - `max_charge_power_w`
  - `max_discharge_power_w`

If the required battery entities or forecast settings are missing, the section returns `not_configured`.

## Frontend compatibility

- `hass-helman-card` currently stays on the hourly compatibility path and requests `granularity: 60`.
- The backend is already canonical 15-minute; direct quarter-hour UI rendering is still a separate frontend follow-up.

## Validation workflow

Targeted validation for this feature:

```bash
cd /home/ondra/dev/hass/hass-helman
python3 -m py_compile \
  custom_components/helman/coordinator.py \
  custom_components/helman/battery_capacity_forecast_builder.py \
  tests/test_coordinator_battery_forecast_cache.py \
  tests/test_battery_capacity_forecast_builder.py \
  tests/test_battery_forecast_response.py
python3 -m unittest -v \
  tests.test_coordinator_battery_forecast_cache \
  tests.test_battery_capacity_forecast_builder \
  tests.test_battery_forecast_response \
  tests.test_schedule_forecast_overlay
```

Repo-standard full-suite check:

```bash
cd /home/ondra/dev/hass/hass-helman
python3 -m unittest discover -s tests -v
```

The repo-standard discovery command is still useful, but it is currently known to be polluted by stub-based test imports in one Python process. Treat those existing import-contamination failures as informational until that underlying test-suite issue is fixed.

Recommended runtime validation after a Home Assistant restart:

- `await getHelmanForecast({ granularity: 15, forecast_days: 1 })`
- `await getHelmanForecast({ granularity: 30, forecast_days: 1 })`
- `await getHelmanForecast({ granularity: 60, forecast_days: 1 })`
- call the same request twice in short succession to confirm cache reuse

## Known limitations

- The battery cache is intentionally in-memory only; restart always cold-starts the battery section.
- Battery availability still depends on live HA entity state and upstream solar forecast coverage.
- The frontend remains hourly for now even though the backend model is canonical 15-minute.
