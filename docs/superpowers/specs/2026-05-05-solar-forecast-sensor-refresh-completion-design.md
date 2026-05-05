# Solar forecast sensor refresh completion

## Problem

The local Helman backend now refreshes and persists a canonical solar forecast snapshot on the 15-minute coordinator cadence, and `helman/get_forecast` reads from that refreshed snapshot. However, the forecast summary entities do not reliably publish updated Home Assistant state when the solar snapshot changes.

In practice this leaves two backend surfaces out of sync:

- `helman/get_forecast` returns the latest refreshed and bias-corrected solar forecast
- `sensor.helman_energy_production_*` can continue exposing an older state value until some unrelated entity lifecycle event republishes it

This is not a forecast-model issue. It is an unfinished entity update path.

## Goals

- Make local Helman forecast summary entities publish fresh state whenever the coordinator refreshes the solar forecast snapshot.
- Keep the entity values sourced from the same cached solar snapshot used by `helman/get_forecast`.
- Preserve the existing 15-minute refresh cadence and on-demand stale-cache refresh behavior.
- Make the update ownership explicit in code so forecast entities are maintained like the other coordinator-driven sensors.

## Non-goals

- Reworking the solar bias correction algorithm.
- Changing the public `helman/get_forecast` response shape.
- Introducing a new refresh cadence for solar forecast entities.
- Solving remote entity mirroring or `remote_homeassistant` naming conflicts in this change.

## Current behavior

### Refresh path

- `_async_refresh_forecast()` rebuilds the canonical solar snapshot and stores it in `self._cached_solar_forecast`.
- The refreshed snapshot is persisted through `HelmanStorage.async_save_snapshots()`.
- `get_forecast()` reads the current canonical solar snapshot through `_async_get_canonical_solar_forecast()` and shapes it into the requested granularity.

This path is functioning.

### Entity path

- `HelmanSolarForecastEnergySensor` and `HelmanSolarForecastRemainingSensor` derive their values directly from coordinator helpers such as `get_solar_forecast_day_total()`.
- Unlike battery ETA, total power, unmeasured power, and source ratio sensors, forecast summary entities do not implement any `update_value()` method.
- The coordinator does not keep references to the forecast summary entities in `set_sensors()`.
- No code path calls `async_write_ha_state()` for forecast summary entities after `_cached_solar_forecast` changes.

This means the coordinator refresh updates the backing snapshot, but it does not actively republish entity state.

## Root cause

The implementation completed the data-source unification but not the entity publication step.

The forecast entities are modeled as coordinator-derived entities in terms of read logic, but they are not modeled as coordinator-driven entities in terms of write lifecycle. The coordinator owns the refresh, yet the refreshed entities are not part of the coordinator's post-refresh write fan-out.

As a result, `helman/get_forecast` sees the latest snapshot while Home Assistant state for `sensor.helman_energy_production_*` can remain stale.

## Recommended design

### Single source of truth remains unchanged

Keep `_cached_solar_forecast` as the only source for:

- `helman/get_forecast`
- local Helman forecast summary sensors

Do not introduce any second forecast-building path for entity publishing.

### Make forecast entities coordinator-driven

Bring solar forecast summary entities into the same update pattern already used by other Helman runtime sensors.

The design should:

- register forecast entity instances with the coordinator during setup
- give the coordinator an explicit method to republish forecast summary entities after solar snapshot refresh
- keep the entity value computation inside coordinator helpers so aggregation logic stays centralized

Two valid implementation shapes:

1. Add `update_value()` style state-caching methods to forecast entities and have the coordinator pass computed values into them.
2. Keep forecast entities stateless and add a coordinator-triggered `async_write_ha_state()` republish hook for each forecast entity after snapshot refresh.

Recommendation:

- Prefer the second shape.

Reasoning:

- The coordinator already owns the canonical forecast snapshot.
- The entities already compute their value from coordinator helper methods.
- Duplicating per-entity cached forecast values would create unnecessary second-layer state.
- The missing behavior is publication, not value storage.

### Post-refresh publication contract

After `_async_refresh_forecast()` assigns `self._cached_solar_forecast`, the coordinator must publish all local forecast summary entities in the same refresh cycle.

That publication step must happen:

- after the in-memory solar snapshot is updated
- before the refresh routine returns success
- regardless of whether the refresh was triggered by the scheduled 15-minute cadence or by `get_forecast()` stale-cache recovery

If the solar snapshot is unavailable or empty, the publication step should still run so entities transition to unavailable instead of retaining stale values.

### Coordinator responsibilities

Extend the coordinator’s sensor registration and refresh responsibilities:

- `set_sensors()` should accept forecast summary sensor references in addition to the already-managed runtime sensors.
- The coordinator should maintain a collection of forecast summary sensor entities.
- Add one private helper dedicated to republishing forecast summary entities, for example `_publish_solar_forecast_entities()`.

That helper should:

- iterate through all registered local forecast summary sensor entities
- call `async_write_ha_state()` only when the entity has been added to Home Assistant
- avoid any rebuild or recomputation outside the existing coordinator aggregation helpers

### Entity responsibilities

The forecast entities remain thin projections over coordinator state:

- `native_value` continues calling `get_solar_forecast_day_total()` or `get_solar_forecast_today_remaining()`
- `available` continues reflecting whether the relevant aggregation returns a value
- no separate forecast cache is introduced on the entity object

This keeps the behavior deterministic and avoids split ownership.

## Data flow after the fix

1. Forecast refresh is triggered by the 15-minute scheduler or stale-cache recovery.
2. `_async_refresh_forecast()` rebuilds the solar snapshot.
3. The coordinator stores the new snapshot in `self._cached_solar_forecast`.
4. The coordinator republishes all local forecast summary entities.
5. Home Assistant state for `sensor.helman_energy_production_*` now reflects the same snapshot that `helman/get_forecast` uses.

## Error handling

- If snapshot rebuild fails, do not publish fake values.
- If snapshot rebuild succeeds but one entity write fails, log the exception and continue publishing the remaining forecast entities.
- Entity publication should not mutate snapshot contents or trigger a secondary refresh.

## Testing

Add focused backend tests for:

- `_async_refresh_forecast()` republishes all registered forecast summary entities after storing a new solar snapshot
- a scheduled refresh updates both the snapshot and the entity publication path
- a `get_forecast()`-triggered stale-cache refresh also republishes the forecast entities
- forecast entities become unavailable when refreshed snapshot coverage for the requested day is missing
- entity values match the refreshed solar snapshot totals for:
  - `today`
  - `tomorrow`
  - `d2` through `d7`
  - `today_remaining`
- no second solar forecast builder path is introduced for entity publication

## Acceptance criteria

- After any successful solar forecast refresh, local Helman `sensor.helman_energy_production_*` entities are republished in the same refresh cycle.
- `helman/get_forecast` and local Helman forecast summary entities reflect the same refreshed solar snapshot.
- Entity state no longer depends on unrelated Home Assistant lifecycle events to pick up refreshed forecast data.
- The implementation keeps a single solar snapshot source of truth and does not add duplicated per-entity forecast storage.
