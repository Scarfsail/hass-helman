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
| 3 | Backend statistical model and final forecast payload | Done |
| 4 | House forecast UI: total and baseline views | **Next** |
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

## Increment 3 — Done

### What was implemented

**Backend** — hour-of-week statistical model in `consumption_forecast_builder.py`:
- `HourOfWeekProfile` class: 168-slot (7 days x 24 hours) statistical profile with recency-weighted data points (exponential decay, half-life 14 days)
- Each slot produces weighted mean + 10th/90th weighted percentile confidence bands
- Slots with < 2 data points fall back to same-hour-any-day aggregation
- `_weighted_percentile` module-level function with linear interpolation and fraction clamping
- `build()` now queries house total + each deferrable consumer from Recorder, computes non-deferrable residual (`house_total - sum(deferrables)`), feeds hour-of-week profiles, generates 168-hour forecast series
- `_query_hourly_history()` replaces `_query_history_days()` — returns raw rows for reuse in both history-days computation and profile building
- `_make_payload()` extended with optional `model` and `series` params (backward compatible with coordinator's direct call)
- `_read_deferrable_consumers()` now deduplicates by entity ID
- Negative residuals: tiny (>= -0.01 kWh) clamped to 0, materially negative dropped with debug log
- `model` field set to `"hour_of_week_baseline"` when forecast is available

**Frontend** — no changes (payload shape matches existing DTOs from Increment 1)

### Files touched

Backend:
- `consumption_forecast_builder.py` (rewritten: `HourOfWeekProfile`, full forecast model, series generation)

### Design decisions

- Exponential decay recency weighting with 14-day half-life — recent patterns dominate, tunable later
- 10th/90th percentile for confidence bands — wide enough for useful range without being overwhelming
- Same-hour-any-day fallback when a weekday+hour slot has < 2 data points (42-day window gives ~6 points per slot)
- Always include configured deferrable consumers in series with `value: 0` if they have no history data (frontend can show them by label)
- `_compute_history_days()` uses `min(row["start"])` instead of `rows[0]["start"]` for safety against row ordering assumptions
- Forecast starts at the next full hour from generation time
- No `total` or `deferrableTotal` in backend DTO — frontend derives those

### Known items deferred

- `partial` status when a deferrable consumer has no usable data — deferred to Increment 5
- Both `helman-forecast-detail` and `helman-house-forecast-detail` independently fetch the full forecast payload — a shared forecast context/store could deduplicate this in the future

## What's next: Increment 4

**Goal**: Render the house forecast in the house detail UI — daily cards for 7 days, selected-day hourly detail, total vs non-deferrable views, confidence bands.

The next session should read the **Increment 4** section of [`implementation_plan.md`](./implementation_plan.md) for full details. Summary:

### Frontend

- Create `house-forecast-detail-model.ts` (or equivalent mapper) to group hourly points into days and selected-day detail
- Implement in `helman-house-forecast-detail.ts`: load forecast, refresh on `FORECAST_REFRESH_MS` cadence, derive `total` and `deferrableTotal` locally, render daily cards + selected-day 24-hour detail with total/nonDeferrable switch, show confidence bands
- Update `node-detail-house-content.ts` to place forecast below house summary
- Add localization keys in `cs.json`

### Backend

- No changes expected unless the frontend reveals small DTO issues

### Key notes for Increment 4

- Reuse existing local-time helpers such as `local-date-time-parts-cache`
- Keep the first UI visually simpler than the solar/grid forecast detail if needed
- Do not refactor shared chart infrastructure unless necessary for correctness
