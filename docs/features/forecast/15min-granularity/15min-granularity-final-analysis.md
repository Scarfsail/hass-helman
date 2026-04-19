# 15-Minute Forecast Granularity: Final Combined Analysis

This document merges findings from four independent analyses and all user decisions. All design questions are resolved.

## Feature Summary

- Make battery forecast use 15-minute granularity internally (solar input is already 15-min)
- House consumption: keep hourly profile model, divide by 4 for 15-min slots
- Websocket API: add `granularity` (15/30/60, default 60) and `forecast_days` (default 7) parameters
- Granularity applies to **all** forecast sub-documents: solar, grid/price, house, battery — including `actualHistory`
- Backend always computes at 15-min canonical resolution, aggregates up for 30/60
- Implement battery forecast cache (infrastructure exists but is unwired)
- Rename `currentHour` to `currentSlot` for all granularities

## Resolved Design Decisions

| Question | Decision |
|---|---|
| Solar `wh_period` semantics | Absolute Wh per period (not a rate). Timestamp marks start of period (e.g. `10:00` = energy from 10:00–10:15) |
| House consumption sub-hourly strategy | Divide hourly profile value by 4 (keep hourly model, no sub-hourly Recorder queries for training) |
| Aggregation rules | Sum energies, last SoC/remaining, OR booleans, sum durations, average prices (confirmed) |
| Fractional first slot | Keep current behavior (now fraction of current 15-min period, max ~15 min vs former ~59 min) |
| Scope of `granularity` param | All sub-documents: solar, grid/price, house, battery + their `actualHistory` |
| Horizon | Default 7 days, new optional `forecast_days` param (max 14, capped by available solar entities) |
| Battery cache | Implement it (cache canonical 15-min result, re-aggregate on the fly for requested granularity) |
| `currentHour` naming | Rename to `currentSlot` for all granularities (breaking change, clean API) |

---

## Current Architecture

### Data flow

```
ws_get_forecast (websockets.py)
  -> coordinator.get_forecast() (coordinator.py)
      -> HelmanForecastBuilder.build()          -> solar + grid dicts
      -> ConsumptionForecastBuilder.build()     -> house dict (cached/persisted)
      -> BatteryCapacityForecastBuilder.build() -> battery dict
```

### Response structure

```json
{
  "solar":              { "status", "points[]", "actualHistory[]", ... },
  "grid":               { "status", "points[]", "currentSellPrice", ... },
  "house_consumption":  { "status", "series[]", "currentHour", "actualHistory[]", ... },
  "battery_capacity":   { "status", "series[]", "actualHistory[]", ... }
}
```

### Where 1-hour is currently baked in

| File | Location | What |
|---|---|---|
| `battery_capacity_forecast_builder.py:109` | `timedelta(hours=1)` | Next slot boundary |
| `battery_capacity_forecast_builder.py:139` | `range(HORIZON_HOURS)` | 168 iterations |
| `battery_capacity_forecast_builder.py:147` | `timedelta(hours=slot_index - 1)` | Slot stepping |
| `battery_capacity_forecast_builder.py:150` | `slot_duration_hours = 1.0` | Full slot duration |
| `battery_capacity_forecast_builder.py:179` | `* slot_duration_hours` | Solar treated as rate (bug) |
| `battery_capacity_forecast_builder.py:380-396` | `_build_solar_hour_map` | Sums sub-hourly to hourly |
| `battery_capacity_forecast_builder.py:361-378` | `_build_house_series_map` | Keyed by hour |
| `battery_capacity_forecast_builder.py:443-444` | `resolution: "hour"` | Payload metadata |
| `consumption_forecast_builder.py:42` | `_HORIZON_HOURS = 168` | Series length |
| `consumption_forecast_builder.py:149-156` | `timedelta(hours=1)` loop | Series generation |
| `consumption_forecast_builder.py:421` | `resolution: "hour"` | Payload metadata |
| `consumption_forecast_profiles.py:14` | `SLOTS = 168` | 7 * 24 hour-of-week model |
| `consumption_forecast_profiles.py:31` | `weekday * 24 + hour` | Slot index formula |
| `recorder_hourly_series.py:235` | `timedelta(hours=1)` | Boundary generation |
| `battery_actual_history_builder.py:29` | `timedelta(hours=1)` | SoC boundary stepping |
| `const.py:32` | `HORIZON_HOURS = 168` | Horizon constant |

---

## Existing Bug

`battery_capacity_forecast_builder.py:179`:
```python
solar_kwh = (solar_wh / 1000) * slot_duration_hours
```

`_build_solar_hour_map` sums all 15-min absolute Wh values into one hour bucket (e.g., 4 x 250 = 1000 Wh total for the hour). Line 179 then multiplies by `slot_duration_hours`, treating the sum as a rate (Wh/h). For full 1-hour slots (`* 1.0`) this is correct by coincidence. For the fractional first slot (e.g., `* 0.38`), it incorrectly scales the total energy as if it were a rate.

Moving to 15-min granularity fixes this: each slot gets its own absolute Wh value, used directly as `solar_kwh = solar_wh / 1000`. The fractional first slot (now max ~15 min) uses proportional scaling within a single 15-min period, which is far more accurate than the current ~59-min approximation.

---

## Changes by File

### 1. `battery_capacity_forecast_builder.py` — HIGH

The core engine. Most changes concentrate here.

**Changes:**
- Main loop: iterate `forecast_days * 24 * 4` slots instead of 168
- `_build_solar_hour_map` -> `_build_solar_slot_map`: key by 15-min boundaries (using start-of-period timestamps), stop summing sub-hour values
- `_build_house_series_map` -> work with 15-min keyed house data
- Fix solar calculation: `solar_kwh = solar_wh / 1000` (absolute energy, no rate scaling). For fractional first slot, scale proportionally within the 15-min period
- `slot_duration_hours`: `0.25` for full slots (was `1.0`)
- First fractional slot: fraction of current 15-min period (max 15 min vs current 59 min)
- DST arithmetic: same UTC-based approach, `timedelta(minutes=15)` steps
- `_make_payload`: update `resolution` to reflect canonical 15-min, parameterize horizon
- Accept `forecast_days` parameter for horizon

**Key insight**: `_simulate_slot()` needs **zero changes** — it already accepts `duration_hours` as a parameter. The physics engine is already granularity-agnostic.

### 2. `consumption_forecast_builder.py` — MEDIUM

**Changes:**
- Series generation loop: `timedelta(minutes=15)` steps instead of `timedelta(hours=1)`
- Each entry's value = `hourly_profile_value / 4` (kWh per 15-min slot)
- `_HORIZON_HOURS` -> parameterized by `forecast_days * 24 * 4`
- `currentHour` -> `currentSlot` (covers current 15-min period)
- `_build_forecast_entry`: same profile lookup (weekday, hour), divide result by 4. All four 15-min entries within an hour get the same per-slot value
- `_make_payload`: update `resolution` field, rename `currentHour` key to `currentSlot`
- `actualHistory`: needs 15-min boundaries (see recorder changes)
- Accept `forecast_days` parameter

**Key insight**: The `HourOfWeekWinsorizedMeanProfile` (168 slots) stays unchanged. We just divide its output by 4. Aggregation back to hourly recovers the original values exactly (4 x V/4 = V).

### 3. `coordinator.py` — MEDIUM-HIGH

**Changes:**
- `get_forecast()` accepts `granularity` and `forecast_days`
- Pass `forecast_days` to all builders
- **Aggregation layer** (new code): aggregate 15-min canonical results to 30/60 before returning. See Aggregation Rules section below for full specification
- **Battery forecast cache** (implement existing stubs):
  - Cache the canonical 15-min result for the maximum available horizon (up to `forecast_days` worth of solar data)
  - Serve from cache within TTL (`BATTERY_CAPACITY_FORECAST_CACHE_TTL_SECONDS = 300`)
  - Re-aggregate cached result on the fly for different `granularity`; truncate for shorter `forecast_days`
  - A request with longer `forecast_days` than what's cached requires recomputation
  - `_invalidate_battery_forecast_cache()` becomes real (clears cached result)
  - Cache key / invalidation inputs:
    - House forecast `generatedAt` or `configFingerprint` change -> invalidate
    - Solar forecast entity states change (new `wh_period` data) -> invalidate
    - Battery live state change beyond a threshold (e.g., SoC drift > 1%) -> invalidate
    - TTL expiry (300s) -> invalidate
- House forecast cache: always compute at 15-min internally, persist at 15-min
- **Internal `currentHour` -> `currentSlot` references** that must be updated:
  - `battery_capacity_forecast_builder.py:348` — `_read_current_hour_house_value` reads `house_forecast.get("currentHour")` -> change to `"currentSlot"`
  - `battery_capacity_forecast_builder.py:345-359` — method name `_read_current_hour_house_value` -> rename to `_read_current_slot_house_value`
  - `battery_capacity_forecast_builder.py:356` — `_hour_start` comparison for current slot alignment -> change to 15-min boundary alignment
  - `coordinator.py` — `_has_compatible_forecast_snapshot` checks snapshot freshness by comparing the snapshot's current hour timestamp with `now`; must be updated to compare 15-min slot timestamps

**Note**: Top-level metadata fields (`status`, `partialReason`, `coverageUntil`, `startedAt`, `generatedAt`) are not per-slot — they pass through as-is regardless of aggregation.

### 4. `websockets.py` — LOW

**Changes:**
- Add `vol.Optional("granularity", default=60): vol.In([15, 30, 60])` to `helman/get_forecast`
- Add `vol.Optional("forecast_days", default=7): vol.All(vol.Coerce(int), vol.Range(min=1, max=14))`
- Pass both params to `coordinator.get_forecast()`

~10 lines of code.

### 5. `forecast_builder.py` — LOW

**Changes:**
- Solar forecast points are already at 15-min granularity — no change to data extraction
- `_build_solar_actual_history`: switch from hourly to 15-min Recorder boundaries
- Accept `forecast_days` to control how many daily entities to read (already capped at 8)
- No change to grid forecast builder (source-timestamped pass-through; aggregation happens in coordinator)

### 6. `battery_actual_history_builder.py` — LOW-MEDIUM

**Changes:**
- Switch from hourly to 15-min boundary stepping (`timedelta(minutes=15)` instead of `timedelta(hours=1)`)
- `get_today_completed_local_hours` -> use 15-min equivalent from recorder helpers
- `query_hour_boundary_state_values` -> use 15-min boundary equivalent
- Each entry covers a 15-min period instead of 1 hour

### 7. `recorder_hourly_series.py` — LOW-MEDIUM

**Changes:**
- `_build_local_hour_starts_until`: generalize to `_build_local_slot_starts_until` with configurable interval (default 15 min)
- `get_today_completed_local_hours` -> generalize to `get_today_completed_local_slots` supporting 15-min boundaries
- `query_hour_boundary_state_values` -> generalize boundary generation to support 15-min intervals
- `query_cumulative_hourly_energy_changes` -> generalize to sub-hourly deltas for `actualHistory`
- The underlying Recorder query and observation unwrapping logic stays unchanged

**Note**: For house forecast *training*, we keep hourly queries (Option A). Sub-hourly recorder queries are only needed for `actualHistory` sections.

### 8. `const.py` — LOW

**Changes:**
- `BATTERY_CAPACITY_FORECAST_HORIZON_HOURS = 168` -> may become derived or replaced
- Add defaults: `DEFAULT_FORECAST_GRANULARITY_MINUTES = 60`, `DEFAULT_FORECAST_DAYS = 7`, `MAX_FORECAST_DAYS = 14`
- Add `CANONICAL_SLOT_MINUTES = 15`

### 9. `consumption_forecast_profiles.py` — NONE

The 168-slot hourly profile stays as-is. No changes needed with the divide-by-4 approach.

### 10. `storage.py` — LOW

**Changes:**
- House forecast snapshot format changes from hourly to 15-min series
- Strategy: invalidate old snapshots on upgrade (simplest — snapshot is rebuilt on the next hourly refresh cycle anyway)
- Could bump `FORECAST_SNAPSHOT_STORAGE_VERSION` or add a format marker to detect stale snapshots
- Config fingerprint logic in coordinator (`_has_compatible_forecast_snapshot`) may need to account for the format change

---

## Aggregation Rules

When aggregating from 15-min canonical output to 30-min (group 2) or 60-min (group 4):

### Battery series

| Field | Rule |
|---|---|
| `timestamp` | First slot's timestamp |
| `durationHours` | Sum |
| `solarKwh`, `baselineHouseKwh`, `netKwh` | Sum |
| `chargedKwh`, `dischargedKwh` | Sum |
| `importedFromGridKwh`, `exportedToGridKwh` | Sum |
| `remainingEnergyKwh`, `socPct` | Last slot's value |
| `hitMinSoc`, `hitMaxSoc` | OR across slots |
| `limitedByChargePower`, `limitedByDischargePower` | OR across slots |

### House series

| Field | Rule |
|---|---|
| `timestamp` | First entry's timestamp |
| `nonDeferrable.value/lower/upper` | Sum |
| `deferrableConsumers[].value/lower/upper` | Sum |

**Note on bands**: With Option A (divide by 4), summing 4 quarter-values recovers the original hourly value exactly. For 30-min aggregation (sum of 2), you get exactly half the hourly value. Statistically coherent because all quarters are identical.

### Solar points

| Field | Rule |
|---|---|
| `timestamp` | First point's timestamp |
| `value` | Sum (Wh) |

### Grid/price points

| Field | Rule |
|---|---|
| `timestamp` | First point's timestamp |
| `value` | Average |

### actualHistory

Same rules as their parent sub-document's series:
- Battery actual history: last SoC values per group
- House actual history: sum energy values per group
- Solar actual history: sum Wh values per group

### Top-level payload fields (not aggregated)

These are per-forecast metadata, not per-slot. They pass through unchanged regardless of granularity:
- `status`, `generatedAt`, `startedAt`
- `partialReason`, `coverageUntil`
- `nominalCapacityKwh`, `currentRemainingEnergyKwh`, `currentSoc`
- `minSoc`, `maxSoc`, `chargeEfficiency`, `dischargeEfficiency`
- `maxChargePowerW`, `maxDischargePowerW`
- `model`, `configFingerprint`, `unit`

The `resolution` and `horizonHours` fields should reflect the **requested** granularity (after aggregation), not the canonical 15-min internal resolution.

---

## Implementation Sequence

1. **Generalize recorder helpers** — make `_build_local_slot_starts_until` accept interval parameter, add 15-min boundary equivalents
2. **Extend websocket schema** — add `granularity` and `forecast_days` params, thread through coordinator
3. **Update consumption forecast builder** — generate 15-min series (divide hourly by 4), rename `currentHour` to `currentSlot`, parameterize horizon
4. **Update battery forecast builder** — 15-min slot loop, 15-min solar map (keyed by start-of-period), fix solar_kwh calculation, parameterize horizon
5. **Update battery actual history builder** — 15-min boundaries
6. **Update solar actual history** — 15-min boundaries in `forecast_builder.py`
7. **Build aggregation layer** — in coordinator, aggregate 15-min -> 30/60 for all sub-documents including `actualHistory`
8. **Implement battery cache** — wire up existing stubs, cache canonical 15-min result, re-aggregate on the fly
9. **Handle snapshot compatibility** — invalidate old hourly snapshots on upgrade (version bump or format marker)
10. **Update tests** — DST at 15-min, aggregation, cache, websocket schema, snapshot compatibility

---

## Difficulty Assessment

| Area | Effort | Difficulty |
|---|---|---|
| Battery builder (core loop + solar map) | ~30% | HIGH |
| Aggregation layer (new code) | ~20% | MEDIUM |
| Battery cache implementation | ~10% | MEDIUM |
| Consumption forecast builder | ~10% | MEDIUM |
| Recorder helpers + actual history builders | ~10% | LOW-MEDIUM |
| Websocket API + coordinator plumbing | ~5% | LOW |
| Constants + storage compatibility | ~5% | LOW |
| Tests | ~10% | MEDIUM |

**Overall: MEDIUM** — the simulation engine (`_simulate_slot`) needs no changes, the profile model stays hourly, and the data flow architecture remains the same. The work is in loop mechanics, map construction, the new aggregation layer, and wiring up the battery cache.

---

## Risk Areas

1. **DST transitions at 15-min boundaries** — existing UTC arithmetic approach should work, but needs dedicated tests for quarter-hour stepping across spring-forward/fall-back
2. **Fractional first slot accuracy** — now covers max ~15 min instead of ~59 min, so the linear approximation error is much smaller
3. **Cache invalidation correctness** — cache must invalidate when battery state, solar forecast, or house forecast changes; incorrect invalidation leads to stale forecasts
4. **Snapshot migration** — old hourly snapshots must not crash the system on upgrade; simplest fix is to treat format mismatch as "stale" and rebuild
5. **Performance** — 672 slots vs 168 for 7-day horizon; cache mitigates repeat-request cost but first-call latency increases ~4x
6. **Aggregation edge cases** — partial groups at the end of the series (e.g., 3 remaining slots when grouping by 4); the first fractional slot may not align to a clean group boundary

---

## Testing Impact

### Existing tests
- `tests/test_forecast_dst.py` (DST safety) — needs 15-min equivalents

### New test areas
- 15-min slot generation across DST transitions (spring-forward and fall-back)
- Aggregation from 15-min to 30-min and 60-min for all sub-documents (battery, house, solar, grid)
- Aggregation edge cases: partial groups, fractional first slot, series shorter than one group
- Battery cache: hit, miss, invalidation, re-aggregation for different granularities
- Websocket schema validation for `granularity` and `forecast_days`
- House split heuristic (hourly / 4): verify round-trip accuracy
- Snapshot compatibility / invalidation on upgrade from hourly to 15-min format
- Solar actual history at 15-min boundaries
- Battery actual history at 15-min boundaries

---

## Documentation Impact

Files to update:
- `docs/features/forecast/house-consumption-forecast/README.md`
- `docs/features/forecast/house-consumption-forecast/history-behavior-explained.md`
- `docs/features/forecast/battery-capacity-forecast/README.md`
- Websocket API docs (new params `granularity` and `forecast_days`, response format changes, `currentHour` -> `currentSlot`)

Note: battery docs currently mention a short-lived cache that isn't implemented. This gets resolved as part of this feature.
