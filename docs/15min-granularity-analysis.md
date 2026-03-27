# 15-Minute Granularity: Codebase Analysis & Difficulty Assessment

## Feature Overview

Move battery forecast from 1-hour to 15-minute granularity internally, add websocket API parameters for `granularity` (15/30/60, default 60) and `forecast_days` (default 7). Backend aggregates when coarser granularity is requested.

## Decisions

- Solar `wh_period` = absolute Wh per period (not a rate)
- House consumption: divide hourly profile value by 4 (no sub-hourly Recorder queries)
- Aggregation: sum energies, last SoC/remaining, OR booleans, sum durations
- Fractional first slot: keep current behavior (now fraction of 15-min period)
- Granularity applies to all forecast sub-documents (solar, house, battery)
- New API params: `granularity` (15/30/60, default 60) + `forecast_days` (default 7)

---

## Changes by File

### 1. `battery_capacity_forecast_builder.py` — HIGH (most work, ~40%)

**What changes:**
- Main loop: iterate `forecast_days * 24 * 4` slots instead of `HORIZON_HOURS` (168 -> up to 672 for 7 days)
- `_build_solar_hour_map` -> `_build_solar_slot_map`: key by 15-min boundaries instead of hour boundaries (stop summing sub-hour values)
- `_build_house_series_map` -> needs to work with 15-min keyed house data
- **Fix the solar_kwh calculation**: `solar_kwh = solar_wh / 1000` (absolute energy, no rate scaling). For the fractional first slot, scale proportionally within the 15-min period
- `slot_duration_hours` changes from `1.0` to `0.25` for full slots
- First fractional slot: fraction of current 15-min period (max 15 min vs current max 59 min)
- `_make_payload`: update `resolution`, `horizonHours` fields
- DST arithmetic: same UTC-based approach, just with `timedelta(minutes=15)` steps

**Key insight**: The simulation engine (`_simulate_slot`) needs **zero changes** — it already accepts `duration_hours` as a parameter.

### 2. `consumption_forecast_builder.py` — MEDIUM (~15%)

**What changes:**
- Series generation loop: `timedelta(minutes=15)` steps instead of `timedelta(hours=1)`
- Each entry's `nonDeferrable.value` = `hourly_profile_value / 4` (kWh per 15-min slot)
- `_HORIZON_HOURS` -> parameterized by `forecast_days * 24 * 4`
- `currentHour` -> `currentSlot` (covers current 15-min period)
- `_build_forecast_entry`: same `HourOfWeekWinsorizedMeanProfile` lookup (by weekday+hour), just divide result by 4
- `_make_payload`: update `resolution` field

**Key insight**: The profile model stays hourly (168 slots). We just divide output by 4.

### 3. `coordinator.py` — MEDIUM (~25%)

**What changes:**
- `get_forecast()` accepts `granularity` and `forecast_days` params
- Pass `forecast_days` to builders for horizon calculation
- **Aggregation layer** (new code): if `granularity > 15`, aggregate the 15-min results before returning:
  - Battery: group N slots, sum energy fields, take last SoC, OR booleans
  - House: group N entries, sum kWh values, combine bands
  - Solar: group N points, sum Wh values
- House forecast cache: always compute at 15-min internally, aggregate on response
- Hourly refresh schedule (`minute=0, second=0`) can stay hourly (profile is hourly, refreshing more often adds no value with Option A)

**Key insight**: The aggregation layer is the main new code (~50-80 lines). Straightforward but needs care.

### 4. `websockets.py` — LOW (~10%)

**What changes:**
- Add `vol.Optional("granularity"): vol.In([15, 30, 60])` to `helman/get_forecast` schema
- Add `vol.Optional("forecast_days"): vol.All(vol.Coerce(int), vol.Range(min=1, max=14))`
- Pass both params to `coordinator.get_forecast()`

~10 lines of code.

### 5. `forecast_builder.py` — LOW

**What changes:**
- Solar points are **already at 15-min granularity** from Solcast — no change to data extraction
- `_build_solar_actual_history`: currently queries hourly boundaries. May want 15-min boundaries for actual history (optional)
- Accept `forecast_days` to limit how many daily entities to read (already limited to 8)

### 6. `const.py` — LOW

**What changes:**
- `BATTERY_CAPACITY_FORECAST_HORIZON_HOURS = 168` may become a derived value or be replaced
- Add default constants for granularity and forecast_days

### 7. `recorder_hourly_series.py` — NONE

No changes needed — we keep querying hourly and divide by 4.

### 8. `consumption_forecast_profiles.py` — NONE

The 168-slot hourly profile stays as-is.

---

## Existing Bug Found

`battery_capacity_forecast_builder.py:179`:
```python
solar_kwh = (solar_wh / 1000) * slot_duration_hours
```
For slot 0 (fractional), this scales the full hour's absolute Wh by a fraction — treating energy as a rate. With the current hourly granularity, full slots work by coincidence (`* 1.0`), but the fractional first slot is slightly wrong. Moving to 15-min granularity fixes this naturally since each slot gets its own absolute Wh value.

---

## Overall Difficulty: MODERATE

| Area | Effort |
|---|---|
| Battery builder (core loop + solar map) | ~40% |
| Aggregation layer (new code in coordinator) | ~25% |
| Consumption forecast builder (series loop) | ~15% |
| Websocket API + plumbing | ~10% |
| Tests | ~10% |
