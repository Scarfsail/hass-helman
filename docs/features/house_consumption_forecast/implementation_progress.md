# House Consumption Forecast — Implementation Progress

## References

- **Implementation plan**: [`implementation_plan.md`](./implementation_plan.md) in this folder
- **Backend repo**: `/home/ondra/dev/hass/hass-helman/custom_components/helman/`
- **Frontend repo**: `/home/ondra/dev/hass/hass-helman-card/src/`

## Increment status

| Increment | Description | Status |
|-----------|-------------|--------|
| 1 | Shared contract and safe scaffolding | Done |
| 2 | Persistence, scheduler, source resolution, visibility rule | Done |
| 3 | Backend statistical model and final forecast payload | **Next** |
| 4 | House forecast UI: total and baseline views | Pending |
| 5 | Per-consumer deferrable breakdown | Pending |
| 6 | Docs, config examples, and cleanup | Pending |

## Increment 1 — Done

### What was implemented

**Backend** — new `consumption_forecast_builder.py` + wired into `forecast_builder.py`:
- `ConsumptionForecastBuilder` class with defensive config reading (same `_read_dict` / `_read_entity_id` pattern as `HelmanForecastBuilder`)
- `helman/get_forecast` now returns `house_consumption` alongside `solar` and `grid`
- Always returns `status: "not_configured"` with empty `series` in this increment
- Config path: `power_devices.house.forecast.total_energy_entity_id`

**Frontend** — types, placeholder component, wiring:
- `helman-api.ts`: new DTOs (`HouseConsumptionForecastDTO`, `ForecastBandValueDTO`, `HouseConsumptionForecastHourDTO`, `DeferrableConsumerHourValueDTO`), `insufficient_history` added to `ForecastStatus`, `ForecastPayload` extended with `house_consumption`
- `DeviceConfig.ts`: `HouseForecastConfig` and `HouseForecastDeferrableConsumerConfig` interfaces, `forecast?` added to `HouseDeviceConfig`
- `helman-house-forecast-detail.ts` (new): self-loading LitElement placeholder — loads forecast, hides when `not_configured`, shows status messages for `insufficient_history` / `unavailable`
- `node-detail-house-content.ts`: renders `<helman-house-forecast-detail>` below existing content
- `cs.json`: `node_detail.house_forecast.*` keys added

### Files touched

Backend:
- `consumption_forecast_builder.py` (new)
- `forecast_builder.py` (import + 1 line in `build()`)

Frontend:
- `src/helman-api.ts`
- `src/helman/DeviceConfig.ts`
- `src/helman-simple/node-detail/helman-house-forecast-detail.ts` (new)
- `src/helman-simple/node-detail/node-detail-house-content.ts`
- `src/localize/translations/cs.json`

### Design decisions

- `ForecastStatus` is a shared type (extended with `insufficient_history` for all forecast types, not just house)
- `ForecastPayload.house_consumption` uses snake_case key to match the backend wire format (same as `solar` / `grid`)
- Increment 1 calls `ConsumptionForecastBuilder` directly from `forecast_builder.py` (no coordinator involvement yet — that comes in Increment 2)
- `_read_deferrable_consumers` helper exists in the builder but is not called until Increment 3+

## Increment 2 — Done

### What was implemented

**Backend** — persisted snapshot, hourly scheduler, Recorder statistics query:
- `const.py`: added `FORECAST_SNAPSHOT_STORAGE_KEY` and `FORECAST_SNAPSHOT_STORAGE_VERSION`
- `storage.py`: added second `Store` for forecast snapshot (`forecast_snapshot` property, `async_save_snapshot()` method), loaded alongside config in `async_load()`
- `consumption_forecast_builder.py`: now accepts `hass`, `build()` is async, queries `statistics_during_period` with `period="hour"` and `types={"change"}` for `total_energy_entity_id`, computes `historyDaysAvailable` from oldest row, returns `not_configured` / `insufficient_history` / `available` with `generatedAt` timestamp, still returns empty `series`
- `coordinator.py`: loads persisted snapshot on startup (`_cached_forecast`), schedules hourly refresh via `async_track_time_interval`, fires non-blocking startup refresh via `async_create_task`, `get_forecast()` merges live solar/grid + cached `house_consumption`, `invalidate_forecast()` triggers background refresh
- `forecast_builder.py`: removed `house_consumption` from builder (coordinator now merges it from cache)
- `websockets.py`: calls `coordinator.invalidate_forecast()` on config save

**Frontend** — dynamic status messages, series guard:
- `helman-house-forecast-detail.ts`: `insufficient_history` message now uses `requiredHistoryDays` from DTO via `%d` replacement, added `localize` guard at top of `render()`, added series-empty guard showing `no_data` message
- `cs.json`: `insufficient_history` value changed to use `%d` placeholder

### Files touched

Backend:
- `const.py` (+2 constants)
- `storage.py` (snapshot store added)
- `consumption_forecast_builder.py` (rewritten: async, Recorder query, status logic)
- `coordinator.py` (forecast cache, scheduler, invalidation)
- `forecast_builder.py` (removed `house_consumption` from builder)
- `websockets.py` (+1 line: `invalidate_forecast()` call)

Frontend:
- `src/helman-simple/node-detail/helman-house-forecast-detail.ts`
- `src/localize/translations/cs.json`

### Design decisions

- Used `"change"` type for Recorder statistics (gives per-hour kWh delta directly, no manual cumulative-to-delta conversion needed)
- Snapshot stored in separate HA `Store` under key `helman.forecast_snapshot` (not mixed with config)
- Coordinator owns the forecast lifecycle: load → cache → schedule → serve. `HelmanForecastBuilder` only builds solar/grid; coordinator merges cached `house_consumption`
- Fallback stub in `get_forecast()` reads actual config defaults (not hardcoded) via `ConsumptionForecastBuilder._make_payload()`
- `insufficient_history` message uses `%d` placeholder with `.replace()` since the localize function has no interpolation support
- `historyDaysAvailable` computed from oldest Recorder row date vs today — does not account for gaps (known approximation, acceptable for v1)

### Known items deferred to Increment 3

- `series` is always empty — Increment 3 adds the hour-of-week statistical model
- `_read_deferrable_consumers` exists but is not called — Increment 3 will use it for per-consumer history queries
- Both `helman-forecast-detail` and `helman-house-forecast-detail` independently fetch the full forecast payload — a shared forecast context/store could deduplicate this in the future

## What's next: Increment 3

**Goal**: Implement the actual forecast generation — hour-of-week statistical model, non-deferrable baseline, per-consumer deferrable values, and confidence bands. The `series` array will finally contain real hourly forecast records.

The next session should read the **Increment 3** section of [`implementation_plan.md`](./implementation_plan.md) for full details. Summary:

### Backend

- **`consumption_forecast_builder.py`**: read `training_window_days`, `min_history_days`, and configured deferrable consumers; query hourly history for house total and each deferrable consumer; compute non-deferrable as `house_total - sum(deferrable_history)`; build hour-of-week statistical profile (168 slots, local-time aligned, recency-weighted); generate `nonDeferrable` and `deferrableConsumers[]` forecasts with confidence bands; populate the `series` array with one record per forecast hour

### Frontend

- No major changes expected — only update DTO assumptions if the exact payload shape changes

### Key notes for Increment 3

- The persistence, scheduling, and caching infrastructure from Increment 2 is fully in place — Increment 3 only changes what `ConsumptionForecastBuilder.build()` returns
- Clamp tiny negative residuals to `0` when subtracting deferrable from total; log and drop materially negative points
- If no deferrable consumers are configured, return empty `deferrableConsumers` array in each hour record
- Do **not** expose `total` or `deferrableTotal` in the backend DTO — frontend derives those
