# Solar forecast cache and entity exposure

## Problem

Helman already provides corrected solar forecast data, but it is exposed only through the websocket/API path and is rebuilt on demand in `HelmanCoordinator.get_forecast()`. That differs from standard forecast integrations, which also expose forecast summary entities such as `energy_production_today` and `energy_production_tomorrow`.

This creates two gaps:

- Home Assistant users cannot consume the corrected solar forecast through the familiar `sensor.*energy_production_*` entities.
- The websocket/API response can diverge from any future entity implementation because solar forecast data is currently rebuilt on request instead of being refreshed through the coordinator's existing slot-aligned forecast refresh cycle.

## Goals

- Expose the corrected solar forecast through Helman sensor entities matching standard forecast provider naming:
  - `sensor.helman_energy_production_today`
  - `sensor.helman_energy_production_tomorrow`
  - `sensor.helman_energy_production_d2`
  - `sensor.helman_energy_production_d3`
  - `sensor.helman_energy_production_d4`
  - `sensor.helman_energy_production_d5`
  - `sensor.helman_energy_production_d6`
  - `sensor.helman_energy_production_d7`
  - `sensor.helman_energy_production_today_remaining`
- Make solar forecast refresh follow the same 15-minute coordinator refresh path as house forecast refresh.
- Persist the refreshed solar forecast snapshot so startup and later requests can reuse the same data.
- Ensure websocket/API consumers and entities read the same cached forecast snapshot.
- Prefer corrected forecast points when available, and fall back to raw forecast points only if corrected points are absent in the cached snapshot.
- Report missing future day coverage as unavailable rather than `0`.

## Non-goals

- Adding a separate solar refresh cadence. Solar forecast stays on the existing 15-minute schedule.
- Updating `today_remaining` every minute. It will refresh on the same 15-minute cadence as the rest of the forecast entities.
- Introducing a second fallback builder path in `get_forecast()`. Cache miss recovery must use the same persisted refresh routine as scheduled refreshes.
- Changing the public forecast response structure beyond sourcing it from cached snapshots.

## Current behavior

- `_start_forecast_refresh()` schedules `_async_refresh_forecast_and_request_automation()` every 15 minutes for house forecast refresh.
- `get_forecast()` rebuilds solar forecast on demand by instantiating `HelmanForecastBuilder`, then applies bias correction and returns the result directly.
- House forecast has a persisted cached snapshot in storage, but solar forecast does not.

This means solar forecast has a different lifecycle than house forecast and any future summary entities would need either their own builder path or would lag behind websocket responses.

## Recommended design

### Single refresh path

Solar forecast is refreshed only through the existing coordinator refresh flow:

- The 15-minute scheduler continues to trigger `_async_refresh_forecast_and_request_automation()`.
- That flow is extended so it also rebuilds the canonical solar forecast snapshot, applies bias correction, stores the corrected series as the primary forecast, and persists the snapshot.
- `get_forecast()` stops rebuilding solar forecast directly. If the cached solar snapshot is missing or stale for the current slot, it triggers the same refresh routine, waits for completion, and then returns the standard response sourced from cache.

This guarantees one code path for scheduled refresh, startup recovery, cache miss fallback, websocket/API consumers, and new entities.

### Cached solar snapshot

Add a coordinator-held cached solar forecast snapshot, persisted through `HelmanStorage`, parallel to the existing house forecast snapshot.

The canonical cached snapshot should contain:

- status
- canonical resolution and horizon metadata
- the raw canonical forecast points
- the corrected canonical forecast points when bias correction is available
- current-slot metadata needed to determine whether the snapshot is current for the local slot
- generation timestamp

The coordinator will treat corrected points as the effective forecast when present. Raw points remain available only as a fallback for downstream aggregation or response shaping.

### `get_forecast()` behavior

`get_forecast()` becomes a cached read path:

1. Validate request parameters as today.
2. Ensure the canonical solar snapshot exists and is current for the local slot.
3. If not current, invoke the same refresh routine used by the scheduler.
4. Shape the cached canonical solar snapshot into the requested granularity and horizon response.
5. Reuse the same cached solar snapshot for appliance/house/battery/grid response assembly so all forecast consumers share one solar input.

No direct solar builder call remains inside `get_forecast()`.

### Entity exposure

Add a new family of solar forecast summary sensors in `sensor.py`:

- today
- tomorrow
- d2
- d3
- d4
- d5
- d6
- d7
- today_remaining

Behavior:

- Entity IDs use the `helman_` prefix and match the standard forecast integration naming pattern.
- Values are derived strictly from the cached solar snapshot.
- Corrected points are used when present; raw points are used only if corrected points are absent from the cached snapshot.
- `today_remaining` uses the same cached point series and same 15-minute refresh cadence as the other entities.
- If the requested local day does not exist in the snapshot coverage, the entity is unavailable.

### Day aggregation rules

Aggregation is by local calendar day.

- `today` sums all forecast points whose timestamps fall within the current local day.
- `tomorrow` sums the next local day.
- `d2` through `d7` sum local days offset by 2 through 7 from today.
- `today_remaining` sums only the forecast points from the current local time onward that still belong to the current local day.

The aggregation helper must use local timezone parsing consistent with the rest of the integration so that DST and midnight boundaries match Home Assistant expectations.

### Refresh cadence and rollover semantics

- Entities refresh when the 15-minute forecast refresh runs.
- Midnight rollover is achieved through the next scheduled refresh after local midnight.
- If `get_forecast()` is called after midnight before the scheduled refresh and the cache is stale for the current slot, it triggers the same shared refresh path, which also realigns the entity source data.

This keeps semantics correct without adding a separate per-minute scheduler.

## Data model changes

### Coordinator

Add:

- `_cached_solar_forecast: dict | None`
- helper methods equivalent to the house forecast cache checks for:
  - compatibility
  - current-slot freshness
  - cache invalidation

The solar cache invalidation rules can be simpler than house forecast because solar forecast is not tied to the consumption-forecast training configuration, but it must still verify canonical granularity, horizon, and current-slot alignment.

### Storage

Persist the canonical solar forecast snapshot alongside the existing persisted house forecast snapshot.

Storage migration requirements:

- Existing stores without a solar snapshot must load cleanly with a `None` default.
- Writing the new store version includes the solar snapshot payload.
- Startup should preload `_cached_solar_forecast` from storage the same way `_cached_forecast` is preloaded for house forecast.

## Implementation notes

### Solar snapshot builder

The solar refresh step should reuse the same low-level forecast building logic already used today in `get_forecast()`:

- build canonical raw solar forecast
- compute bias correction result
- store corrected canonical points as the effective primary series
- keep raw points in the snapshot for fallback and diagnostics

The change is architectural, not algorithmic: move the existing solar-forecast build responsibility into the shared refresh pipeline instead of leaving it in the request path.

### Response shaping

When serving `get_forecast()`, compose the `solar` response from the cached canonical snapshot using the existing response helpers so the external websocket/API contract remains unchanged.

### Entity metadata

The new forecast summary entities should follow energy forecast conventions:

- device class: `energy`
- native unit: `Wh`
- state class should be omitted unless an existing Helman pattern clearly requires it for forecast entities
- polling disabled; updates come from coordinator writes

Each entity should have a stable unique ID based on config entry ID plus the forecast key.

## Testing

Add tests for:

- scheduled refresh populates and persists the solar snapshot
- startup loads persisted solar snapshot
- `get_forecast()` serves solar data from cache instead of rebuilding on demand
- cache miss or stale cache in `get_forecast()` triggers the same shared refresh routine
- corrected points are preferred over raw points
- new sensor entities expose expected values for:
  - today
  - tomorrow
  - d2 through d7
  - today_remaining
- missing future day coverage makes entities unavailable
- day aggregation uses local-day boundaries correctly, including midnight transitions and DST-sensitive timestamps

## Risks and constraints

- Moving solar forecast into the shared refresh path changes the timing model from fully on-demand to slot-aligned caching. The fallback refresh in `get_forecast()` mitigates cold-start and stale-cache cases.
- The existing coordinator refresh routine currently centers on house forecast and automation inputs. Extending it must keep automation behavior intact and avoid partial updates where house forecast is refreshed but solar snapshot is not.
- Storage versioning must remain backward-compatible for existing users upgrading with persisted data already present.

## Acceptance criteria

- Helman exposes the nine new `helman_energy_production_*` entities.
- Entity values and websocket/API solar forecast agree within a refresh window because they are sourced from the same cached snapshot.
- Solar forecast is refreshed on the existing 15-minute schedule and persisted.
- `get_forecast()` does not rebuild solar forecast through a separate on-demand code path.
- Missing daily coverage yields unavailable entities rather than zero values.
