# 15-Minute Forecast Granularity: Combined Analysis

This document combines findings from two independent codebase analyses and all user decisions.

## Feature Summary

- Make battery forecast use 15-minute granularity internally (solar input is already 15-min)
- House consumption: keep hourly profile model, divide by 4 for 15-min slots
- Websocket API: add `granularity` (15/30/60, default 60) and `forecast_days` (default 7) parameters
- Granularity applies to **all** forecast sub-documents: solar, grid/price, house, battery — including `actualHistory`
- Backend always computes at 15-min canonical resolution, aggregates up for 30/60
- Implement battery forecast cache (infrastructure exists but is unwired)

## User Decisions

| Question | Decision |
|---|---|
| Solar `wh_period` semantics | Absolute Wh per period (not a rate) |
| House consumption sub-hourly strategy | Divide hourly profile value by 4 (Option A) |
| Aggregation rules | Sum energies, last SoC/remaining, OR booleans, sum durations, average prices |
| Fractional first slot | Keep current behavior (fraction of current 15-min period) |
| Scope of `granularity` param | All sub-documents: solar, grid, house, battery + their `actualHistory` |
| Horizon | Default 7 days, new optional `forecast_days` param |
| Battery cache | Implement it (cache canonical 15-min result, re-aggregate on the fly) |

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

## Existing Bug Found

`battery_capacity_forecast_builder.py:179`:
```python
solar_kwh = (solar_wh / 1000) * slot_duration_hours
```

The `_build_solar_hour_map` sums all 15-min absolute Wh values into one hour bucket (e.g., 4 x 250 = 1000 Wh total for the hour). Line 179 then multiplies by `slot_duration_hours`, treating the sum as a rate (Wh/h). For full 1-hour slots (`* 1.0`) this is correct by coincidence. For the fractional first slot (e.g., `* 0.38`), it incorrectly scales the total energy as if it were a rate.

Moving to 15-min granularity fixes this: each slot gets its own absolute Wh value, used directly as `solar_kwh = solar_wh / 1000`.

---

## Changes by File

### 1. `battery_capacity_forecast_builder.py` — HIGH

The core engine. Most changes concentrate here.

**Changes:**
- Main loop: iterate `forecast_days * 24 * 4` slots instead of 168
- `_build_solar_hour_map` -> `_build_solar_slot_map`: key by 15-min boundaries, stop summing sub-hour values
- `_build_house_series_map` -> work with 15-min keyed house data
- Fix solar calculation: `solar_kwh = solar_wh / 1000` (absolute energy, no rate scaling)
- `slot_duration_hours`: `0.25` for full slots (was `1.0`)
- First fractional slot: fraction of current 15-min period (max 15 min vs current 59 min)
- DST arithmetic: same UTC-based approach, `timedelta(minutes=15)` steps
- `_make_payload`: update `resolution`, `horizonHours` -> parameterized
- Accept `forecast_days` parameter for horizon

**Key insight**: `_simulate_slot()` needs **zero changes** — it already accepts `duration_hours` as a parameter. The physics engine is already granularity-agnostic.

### 2. `consumption_forecast_builder.py` — MEDIUM

**Changes:**
- Series generation loop: `timedelta(minutes=15)` steps instead of `timedelta(hours=1)`
- Each entry's value = `hourly_profile_value / 4` (kWh per 15-min slot)
- `_HORIZON_HOURS` -> parameterized by `forecast_days * 24 * 4`
- `currentHour` -> `currentSlot` (covers current 15-min period)
- `_build_forecast_entry`: same profile lookup (weekday, hour), divide result by 4
- `_make_payload`: update `resolution` field
- `actualHistory`: needs 15-min boundaries (see recorder changes)
- Accept `forecast_days` parameter

**Key insight**: The `HourOfWeekWinsorizedMeanProfile` stays unchanged. We just divide its output.

### 3. `coordinator.py` — MEDIUM-HIGH

**Changes:**
- `get_forecast()` accepts `granularity` and `forecast_days`
- Pass `forecast_days` to all builders
- **Aggregation layer** (new code): aggregate 15-min canonical results to 30/60 before returning:
  - Battery: group N slots, sum energy fields, take last SoC/remaining, OR booleans, sum durations
  - House: group N entries, sum kWh values, combine bands (sum value/lower/upper)
  - Solar: group N points, sum Wh values
  - Grid/price: group N points, average price values
  - `actualHistory`: same grouping rules per sub-document
- **Battery forecast cache** (implement existing stubs):
  - Cache canonical 15-min result keyed by inputs (solar status, house fingerprint, battery state)
  - Serve from cache within TTL (`BATTERY_CAPACITY_FORECAST_CACHE_TTL_SECONDS = 300`)
  - Re-aggregate cached result on the fly for different `granularity`
  - `_invalidate_battery_forecast_cache()` becomes real (clears cached result)
- House forecast cache: always compute at 15-min, persist at 15-min

### 4. `websockets.py` — LOW

**Changes:**
- Add `vol.Optional("granularity", default=60): vol.In([15, 30, 60])` to `helman/get_forecast`
- Add `vol.Optional("forecast_days", default=7): vol.All(vol.Coerce(int), vol.Range(min=1, max=14))`
- Pass both params to `coordinator.get_forecast()`

~10 lines of code.

### 5. `forecast_builder.py` — LOW

**Changes:**
- Solar points are already at 15-min granularity — no change to data extraction
- `_build_solar_actual_history`: switch from hourly to 15-min Recorder boundaries
- Accept `forecast_days` to control how many daily entities to read (already capped at 8)

### 6. `battery_actual_history_builder.py` — LOW-MEDIUM

**Changes:**
- Switch from hourly to 15-min boundary stepping (`timedelta(minutes=15)` instead of `timedelta(hours=1)`)
- `get_today_completed_local_hours` -> use 15-min equivalent from recorder helpers
- `query_hour_boundary_state_values` -> use 15-min boundary equivalent
- Each entry covers a 15-min period instead of 1 hour

### 7. `recorder_hourly_series.py` — LOW-MEDIUM

**Changes:**
- `_build_local_hour_starts_until`: generalize to `_build_local_slot_starts_until` with configurable interval (15/60 min)
- `get_today_completed_local_hours` -> generalize to support 15-min boundaries
- `query_hour_boundary_state_values` -> generalize boundary generation
- `query_cumulative_hourly_energy_changes` -> generalize to sub-hourly deltas for `actualHistory`
- The underlying Recorder query and observation unwrapping logic stays unchanged

**Note**: For house forecast *training*, we keep hourly queries (Option A). Sub-hourly recorder queries are only needed for `actualHistory` sections.

### 8. `const.py` — LOW

**Changes:**
- `BATTERY_CAPACITY_FORECAST_HORIZON_HOURS = 168` -> may become derived or replaced
- Add defaults: `DEFAULT_FORECAST_GRANULARITY_MINUTES = 60`, `DEFAULT_FORECAST_DAYS = 7`
- Add `CANONICAL_SLOT_MINUTES = 15`

### 9. `consumption_forecast_profiles.py` — NONE

The 168-slot hourly profile stays as-is. No changes needed with Option A.

### 10. `storage.py` — LOW

**Changes:**
- If the persisted house forecast snapshot format changes (15-min series instead of hourly), need either:
  - Schema migration, or
  - Invalidate old snapshots on upgrade (simpler — snapshot is rebuilt hourly anyway)

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
Same rules as their parent sub-document's series.

---

## Implementation Sequence

1. **Generalize recorder helpers** — make `_build_local_slot_starts_until` accept interval parameter
2. **Extend websocket schema** — add `granularity` and `forecast_days` params, thread through coordinator
3. **Update consumption forecast builder** — generate 15-min series (divide hourly by 4), parameterize horizon
4. **Update battery forecast builder** — 15-min slot loop, 15-min solar map, fix solar_kwh calculation
5. **Update battery actual history builder** — 15-min boundaries
6. **Update solar actual history** — 15-min boundaries
7. **Build aggregation layer** — in coordinator, aggregate 15-min -> 30/60 for all sub-documents
8. **Implement battery cache** — wire up existing stubs, cache canonical 15-min result
9. **Handle snapshot compatibility** — invalidate old hourly snapshots on upgrade
10. **Update tests** — DST at 15-min, aggregation, cache, websocket schema

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

**Overall: MEDIUM** — the simulation engine (`_simulate_slot`) needs no changes, the profile model stays hourly, and the data flow architecture remains the same. The work is in loop mechanics, map construction, and the new aggregation layer.

---

## Risk Areas

1. **DST transitions at 15-min boundaries** — existing UTC arithmetic approach should work, but needs dedicated tests
2. **Fractional first slot accuracy** — now covers max 15 min instead of 59 min, so the linear approximation is much less impactful
3. **Cache invalidation correctness** — cache must invalidate when battery state, solar forecast, or house forecast changes
4. **Snapshot migration** — old hourly snapshots must not crash the system on upgrade
5. **Performance** — 672 slots vs 168 for 7-day horizon; cache mitigates this but first-call latency increases ~4x

---

## Testing Impact

### Existing tests
- `tests/test_forecast_dst.py` (DST safety) — needs 15-min equivalents

### New test areas
- 15-min slot generation across DST transitions
- Aggregation from 15-min to 30-min and 60-min for all sub-documents
- Battery cache: hit, miss, invalidation, re-aggregation
- Websocket schema validation for `granularity` and `forecast_days`
- House split heuristic (hourly / 4)
- Snapshot compatibility / invalidation on upgrade
- Solar actual history at 15-min boundaries

---

## Documentation Impact

Files to update:
- `docs/features/house_consumption_forecast/README.md`
- `docs/features/house_consumption_forecast/history_behavior_explained.md`
- `docs/features/battery_capacity_forecast/README.md`
- Websocket API docs (new params, response format changes)

Note: battery docs mention a short-lived cache that isn't currently implemented. This gets resolved as part of this feature.
