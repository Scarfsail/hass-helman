# Battery Capacity Forecast

## Status

Implemented in code for v1 across Increments 1-7. Increment 7 is awaiting manual Home Assistant validation.

This document describes the current implemented battery capacity forecast in `hass-helman` and `hass-helman-card`, while keeping the reviewed design rationale that shaped the implementation.

## References

- **Implementation strategy**: [`implementation_strategy.md`](./implementation_strategy.md)
- **Implementation progress**: [`implementation_progress.md`](./implementation_progress.md)
- **Backend repo**: `/home/ondra/dev/hass/hass-helman/custom_components/helman/`
- **Frontend repo**: `/home/ondra/dev/hass/hass-helman-card/src/`

## Goal

Project battery state with **1 hour granularity** using:

- current battery SoC
- current battery energy
- min battery SoC
- max battery SoC
- solar forecast
- base house consumption forecast

The result should be a backend-owned forecast that the frontend only renders.

## Current implemented behavior

The current implementation:

- computes `battery_capacity` in the backend from live battery state, solar forecast, and the base house forecast
- starts the simulation from **now** with a fractional first slot and the shared 168-hour horizon
- keeps unknown future solar hours honest by returning `partial` coverage instead of inventing zero-production slots
- caches only the backend `battery_capacity` section in memory for about **5 minutes**
- renders SoC-first daily cards in battery detail with an expandable hourly panel for the selected day
- shows the selected day's SoC trajectory, remaining energy, charge/discharge movement, min/max SoC guide lines, and partial-coverage note

The sections below preserve the reviewed design decisions and continue to match the current v1 implementation unless noted otherwise.

## Decisions locked during review

These decisions now define the shipped v1 behavior:

- use only `house_consumption.series[].nonDeferrable.value`
- if solar forecast becomes unknown, keep the battery forecast `partial`; do not assume `0`
- start the prediction from **now**, not from the next full hour
- include a **partial first slot** from `now` to the next top-of-hour
- include configurable charge and discharge efficiency in v1
- default both efficiencies to `95%`
- include charge and discharge power limits in v1
- make SoC the primary UI metric and remaining energy the secondary one
- use a lazy in-memory backend cache with roughly **5 minutes TTL**
- do not persist the battery forecast to storage

## Current codebase fit

### Backend (`hass-helman`)

- `HelmanCoordinator.get_forecast()` already assembles the payload returned by `helman/get_forecast`.
- `HelmanForecastBuilder` already provides live `solar` and `grid` forecast sections.
- `ConsumptionForecastBuilder` already provides a cached hourly `house_consumption` snapshot.
- Battery state is already read in the coordinator for ETA sensors from:
  - `remaining_energy`
  - `capacity`
  - `min_soc`
  - `max_soc`

### Frontend (`hass-helman-card`)

- Forecast data is already loaded through `loadForecast()` from the same websocket endpoint.
- Existing forecast UI follows a clean pattern:
  - backend DTO
  - frontend day/chart model
  - detail component
- `node-detail-battery-content.ts` is the natural place to add battery forecast rendering.
- `node-detail-house-content.ts` and `helman-house-forecast-detail.ts` are the best existing patterns to mirror.

### Documentation fit

The existing feature docs live under `hass-helman/docs/features/`. This feature follows that same structure so it is easy to review alongside `house_consumption_forecast`.

## Implemented architecture

### 1. Keep the battery forecast in the backend

Do **not** calculate the battery forecast in `hass-helman-card`.

Reasoning:

- the backend already owns forecast generation
- current battery state must be read from live HA entities
- the house forecast already exists as a backend snapshot
- the frontend should stay focused on presentation

### 2. Add a dedicated `BatteryCapacityForecastBuilder`

Recommended backend modules:

- new helper module: `custom_components/helman/battery_state.py`
- new builder module: `custom_components/helman/battery_capacity_forecast_builder.py`

Recommended call site:

- build `battery_capacity` inside `HelmanCoordinator.get_forecast()`

This is the best fit because the battery forecast depends on:

- live battery state at request time
- live solar forecast data
- cached base house forecast data

### 3. Keep the house forecast snapshot, but add explicit support for the current hour

The current house forecast pipeline is almost a perfect dependency, but there is one important gap:

- the house forecast builder is centered on full-hour slots
- the battery forecast must start from **now**

To make that reliable, the battery design should not depend on "maybe the previous snapshot already contains the current hour".

Recommended supporting change:

- extend the house forecast snapshot with an explicit `currentHour` entry using the same shape as one normal hourly forecast item

That lets the battery forecast use:

- `house_consumption.currentHour.nonDeferrable` for the partial first slot
- `house_consumption.series[]` for the remaining full-hour slots

This keeps the existing house forecast UI intact while giving the battery simulation a clean way to start from the current SoC at the current time.

### 4. Add a short-lived in-memory cache in the coordinator

The original "recompute every request" approach is no longer the best fit after review.

The updated recommendation is:

- compute `battery_capacity` lazily on demand
- cache only that section in memory for about **5 minutes**
- reuse the cached result for repeated requests during the TTL
- recompute only when the TTL expires or the cache is invalidated

Why this is the right compromise:

- reduces repeated simulation work
- handles multiple frontend requests cleanly
- stays fresh enough for a review-focused forecast feature
- avoids persisting a stale battery projection across reloads or restarts

## Simulation model

### Inputs

The battery forecast should use:

- current remaining energy in `kWh`
- current SoC
- min SoC
- max SoC
- nominal battery capacity inferred from current energy and current SoC
- hourly solar forecast normalized to `kWh`
- hourly base house forecast from `nonDeferrable.value`
- configurable:
  - `charge_efficiency`
  - `discharge_efficiency`
  - `max_charge_power_w`
  - `max_discharge_power_w`

### Recommended battery forecast config

Add a new battery forecast config section:

```yaml
power_devices:
  battery:
    entities:
      power: sensor.battery_power
      capacity: sensor.battery_soc
      min_soc: sensor.battery_min_soc
      max_soc: sensor.battery_max_soc
      remaining_energy: sensor.battery_remaining_energy
    forecast:
      charge_efficiency: 0.95
      discharge_efficiency: 0.95
      max_charge_power_w: 5000
      max_discharge_power_w: 5000
```

Recommended behavior:

- `charge_efficiency` default: `0.95`
- `discharge_efficiency` default: `0.95`
- charge/discharge power limits are part of the v1 model
- if the required battery entities are missing, return `not_configured`
- if the required battery forecast limits are missing, prefer `not_configured` over silently pretending the limit is infinite

### Slot alignment

Keep the forecast at one-hour granularity, but let the **first** slot be fractional.

Recommended slot structure:

- slot `0`
  - `timestamp = now`
  - `durationHours = (next_top_of_hour - now) / 1h`
- remaining slots
  - one slot per full hour
  - `durationHours = 1`

Recommended horizon:

- keep `horizonHours = 168`
- return `168` slots total
- the first slot may be shorter than one hour

This keeps the hourly model intact while still honoring "start from now".

### Partial first slot behavior

For the first slot:

- read the forecast for the **current local hour**
- scale both hourly inputs by `durationHours`
- scale power caps by the same `durationHours`

Example:

- now = `14:18`
- next top-of-hour = `15:00`
- duration = `0.7 h`
- hourly solar forecast = `1.2 kWh`
- hourly base house forecast = `0.5 kWh`

Then the first slot should use:

- `solarKwh = 1.2 * 0.7 = 0.84`
- `baselineHouseKwh = 0.5 * 0.7 = 0.35`

Power limits for that slot become:

- `maxChargeEnergyThisSlotKwh = (maxChargePowerW / 1000) * durationHours`
- `maxDischargeEnergyThisSlotKwh = (maxDischargePowerW / 1000) * durationHours`

### Forecast progression

For each slot:

1. Start from the previous slot's `remainingEnergyKwh`.
2. Compute:
   - `solarKwh`
   - `baselineHouseKwh`
   - `netKwh = solarKwh - baselineHouseKwh`
3. If `netKwh > 0`:
   - apply charge power limit
   - apply charge efficiency
   - clamp to `maxSoc`
   - any leftover becomes `exportedToGridKwh`
4. If `netKwh < 0`:
   - apply discharge power limit
   - apply discharge efficiency
   - clamp to `minSoc`
   - any unmet deficit becomes `importedFromGridKwh`
5. Save the new:
   - `remainingEnergyKwh`
   - `socPct`
   - limit-hit flags

### Partial forecast rule

If solar input becomes unknown for a slot:

- do **not** assume `0`
- mark the forecast `partial`
- stop the simulation at that point

This is important because battery state is cumulative. Once one slot is unknown, every later battery state becomes unknown too.

## Proposed payload

Add a new sibling section to the existing forecast payload:

```ts
interface ForecastPayload {
  solar: SolarForecastDTO;
  grid: GridForecastDTO;
  house_consumption: HouseConsumptionForecastDTO;
  battery_capacity: BatteryCapacityForecastDTO;
}
```

Recommended DTO:

```ts
interface BatteryCapacityForecastHourDTO {
  timestamp: string;
  durationHours: number;
  solarKwh: number;
  baselineHouseKwh: number;
  netKwh: number;
  chargedKwh: number;
  dischargedKwh: number;
  remainingEnergyKwh: number;
  socPct: number;
  importedFromGridKwh: number;
  exportedToGridKwh: number;
  hitMinSoc: boolean;
  hitMaxSoc: boolean;
  limitedByChargePower: boolean;
  limitedByDischargePower: boolean;
}

interface BatteryCapacityForecastDTO {
  status: "not_configured" | "insufficient_history" | "unavailable" | "partial" | "available";
  generatedAt: string | null;
  startedAt: string | null;
  unit: "kWh";
  resolution: "hour";
  horizonHours: number;
  model: string | null;
  nominalCapacityKwh: number | null;
  currentRemainingEnergyKwh: number | null;
  currentSoc: number | null;
  minSoc: number | null;
  maxSoc: number | null;
  chargeEfficiency: number | null;
  dischargeEfficiency: number | null;
  maxChargePowerW: number | null;
  maxDischargePowerW: number | null;
  partialReason: string | null;
  coverageUntil: string | null;
  series: BatteryCapacityForecastHourDTO[];
}
```

Notes:

- keep the payload self-contained
- return both SoC and energy
- make the first slot explicit instead of hiding it behind a rounded hour timestamp
- surface partial coverage explicitly so the frontend can explain it

## Backend design

### New files

#### `custom_components/helman/battery_state.py`

Responsibilities:

- normalize live battery state from HA entities
- normalize battery forecast settings from config

Suggested outputs:

- `BatteryLiveState`
- `BatteryForecastSettings`

#### `custom_components/helman/battery_capacity_forecast_builder.py`

Responsibilities:

- build aligned slots starting from `now`
- consume:
  - live battery state
  - live solar forecast
  - current-hour + future base house forecast
- simulate the battery progression
- return the `battery_capacity` payload

### Modified backend files

#### `custom_components/helman/coordinator.py`

Changes:

- attach `battery_capacity` in `get_forecast()`
- add lazy TTL cache for the battery forecast
- invalidate that cache when:
  - config changes
  - the main forecast is invalidated
  - house forecast refresh succeeds

Suggested cache fields:

- `_battery_forecast_cache`
- `_battery_forecast_task`

This also allows in-flight request deduplication so multiple card requests do not trigger parallel recalculations.

#### `custom_components/helman/consumption_forecast_builder.py`

Recommended supporting change:

- expose an explicit `currentHour` forecast item in the house forecast payload

That is the cleanest way to satisfy the "start from now" requirement without forcing the battery builder to guess the current-hour baseline.

#### `custom_components/helman/const.py`

Recommended additions:

- `BATTERY_FORECAST_CACHE_TTL_SECONDS = 300`
- model ID constant
- default charge/discharge efficiency constants

### Status behavior

Recommended statuses:

- `not_configured`
  - battery forecast config missing
  - required battery entities missing
  - required charge/discharge limits missing
- `insufficient_history`
  - house forecast cannot provide a usable baseline due to insufficient history
- `unavailable`
  - battery state cannot be read
  - solar forecast unavailable
  - house forecast unavailable
- `partial`
  - solar forecast coverage ends before the requested horizon
  - or the current slot cannot be completed honestly
- `available`
  - aligned inputs and simulated output are present

### Validation details

- `max_charge_power_w` and `max_discharge_power_w` must be present as **positive** numbers; missing or non-positive values keep the forecast `not_configured`
- invalid `charge_efficiency` / `discharge_efficiency` values fall back to the default `95%` values
- `remaining_energy` currently accepts only `Wh`, `kWh`, or `MWh`
- live battery state is treated as `unavailable` when the current SoC is outside `(0, 100]`, when `min_soc` / `max_soc` are outside `[0, 100]`, when `min_soc > max_soc`, when current SoC is outside `[min_soc, max_soc]`, or when remaining energy / derived nominal capacity are invalid

## Caching strategy

The updated recommendation is a **short-lived in-memory cache** in the coordinator.

### Cache scope

Cache only:

- `battery_capacity`

Do **not** cache:

- the full websocket payload
- the battery forecast in storage

### Current cache shape

```python
@dataclass
class _BatteryForecastCacheEntry:
    expires_monotonic: float
    payload: dict[str, Any]
```

Current read path:

1. if cache exists and both TTL checks still pass, return it
2. invalidate the cache when either the monotonic expiry or the payload `generatedAt` age exceeds the TTL
3. if a build task is already running, await it
4. otherwise build a fresh payload
5. cache only `available` payloads and `partial` payloads with a non-empty `series`
6. do not cache `not_configured`, `unavailable`, or empty `partial` responses

### Why this beats persistence

- it matches your "lazy-load every ~5 minutes" requirement
- it avoids stale projections after restart
- it still reuses work across repeated frontend refreshes

## Frontend design (`hass-helman-card`)

### Recommended entry point

Render the forecast inside:

- `src/helman-simple/node-detail/node-detail-battery-content.ts`

This matches the existing UX pattern:

- solar detail includes forecast
- house detail includes forecast
- battery detail should include forecast too

### Recommended frontend files

Create:

- `src/helman-simple/node-detail/battery-capacity-forecast-detail-model.ts`
- `src/helman-simple/node-detail/battery-capacity-forecast-chart-model.ts`
- `src/helman-simple/node-detail/helman-battery-forecast-detail.ts`

Modify:

- `src/helman-api.ts`
- `src/helman-simple/node-detail/node-detail-battery-content.ts`
- `src/helman/DeviceConfig.ts`
- localization files

### UI recommendation

Reuse the house forecast information architecture:

- daily summary cards
- expandable hourly detail panel

But use battery-specific visuals:

- **primary**: SoC trajectory
- **secondary**: remaining energy
- **supporting**: charge/discharge movement and limit-hit notes

Recommended daily summary:

- end-of-day SoC
- min SoC for the day
- max SoC for the day
- end-of-day remaining energy

Recommended detail panel:

- stepped SoC line or area chart
- reference lines for min/max SoC
- secondary bars for `chargedKwh` / `dischargedKwh`
- note when the forecast is partial

### Important frontend rule

Do **not** zero-pad missing battery hours in the frontend.

Unlike the current house forecast model, the battery forecast must preserve sparse or truncated data honestly. If coverage ends, the UI should show that it ends.

### Scope recommendation

For v1:

- add the battery forecast only to the battery detail dialog
- do not add a standalone battery forecast card yet
- keep Lovelace config changes minimal

## Alternatives considered

### Option A - Recommended

**Backend-owned battery forecast with lazy 5-minute in-memory cache**

Pros:

- matches current architecture
- respects live battery state
- avoids repeated recalculation for repeated requests
- keeps frontend simple

Cons:

- slightly stale within the TTL
- requires a clean solution for the current-hour base house forecast

### Option B - Persisted battery snapshot

Pros:

- simpler repeated reads

Cons:

- wrong fit for current SoC
- stale across restart
- less honest than the short-lived TTL cache

Rejected.

### Option C - Frontend-derived forecast

Pros:

- smaller backend change

Cons:

- duplicates forecast logic
- makes the UI responsible for business rules
- hard to keep aligned with backend data and config

Rejected.

### Option D - Tick-loop based forecast

Pros:

- reuses live battery code paths

Cons:

- wrong abstraction level
- optimized for rolling history and ETA sensors, not a 168-slot forecast series

Rejected.

## Recommendation summary

The best approach is:

- add a new backend-owned `battery_capacity` section
- start the forecast from **now** using a fractional first slot
- use only the **base house forecast**
- include configurable efficiency and charge/discharge power limits in v1
- keep unknown solar hours truly unknown and return `partial`
- cache only the battery forecast in memory for about **5 minutes**
- render it in the battery detail dialog with **SoC first** and energy second

This is the cleanest fit with the current architecture and with the decisions you provided during review.
