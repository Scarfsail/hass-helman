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
| 4 | House forecast UI: total and baseline views | Done |
| 5 | Per-consumer deferrable breakdown | Done |
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

## Increment 4 — Done

### What was implemented

**Backend** — today's past hours preservation in `coordinator.py`:
- `_merge_today_past_hours()` method in coordinator: after each hourly forecast refresh, today's already-elapsed forecast hours from the previous snapshot are prepended to the new series so the frontend can render a full 24-hour day profile for today

**Frontend** — full house forecast UI in `helman-house-forecast-detail.ts`:
- `house-forecast-detail-model.ts` (new): pure data transformation grouping hourly `HouseConsumptionForecastHourDTO[]` into `HouseForecastDay[]` with per-hour `totalKwh` (nonDeferrable + sum of deferrableConsumers) and `baselineKwh` (nonDeferrable only), plus confidence band bounds (`totalLowerKwh`/`totalUpperKwh`, `baselineLowerKwh`/`baselineUpperKwh`) per hour and daily aggregates; today is padded to 24 hours (frontend fallback when backend has no previous snapshot)
- `helman-house-forecast-detail.ts` (rewritten): full render with day cards for 7 days, accordion-toggled hourly detail panel, pill-shaped segmented control for total/baseline view switching, confidence band markers (thin horizontal lines at lower/upper bounds), `willUpdate` memoization using `generatedAt` + `seriesLength` for stable identity (prevents user state reset on background refresh)
- `node-detail-shared-styles.ts`: added CSS for `.forecast-day-consumption-value`, `.house-total`/`.house-baseline` mini-chart bar colors, `.forecast-detail-bar.house-consumption`, `.forecast-detail-band` confidence band markers, `.forecast-view-toggle` pill segmented control
- `cs.json`: added `hourly_detail` key under `node_detail.house_forecast`

### Files touched

Backend:
- `coordinator.py` (+`_merge_today_past_hours()` method, +`dt_util` import)

Frontend:
- `src/helman-simple/node-detail/house-forecast-detail-model.ts` (new)
- `src/helman-simple/node-detail/helman-house-forecast-detail.ts` (rewritten)
- `src/helman-simple/node-detail/node-detail-shared-styles.ts` (+70 lines CSS)
- `src/localize/translations/cs.json` (+1 key)

### Design decisions

- Separate model file (`house-forecast-detail-model.ts`) follows the established pattern of `forecast-detail-model.ts` being separate from `helman-forecast-detail.ts`
- `willUpdate` memoization uses `generatedAt` + `seriesLength` instead of series reference to avoid resetting user interaction state (`_selectedDayKey`, `_activeView`) on background refresh cycles
- Pill segmented control rendered inline — no separate component, since only one consumer exists
- Confidence bands rendered as thin 2px horizontal line markers at lower/upper bound positions within each detail column
- Mini-chart scale uses total view max (always >= baseline) for stability across view switches
- Detail panel bar max is local to the selected day (not global) for maximum visual resolution
- Today's card padded to full 24-hour profile — missing past hours filled with zero values and muted, matching the solar forecast pattern
- Reused existing localization keys `forecast_detail.today`/`forecast_detail.tomorrow` for day labels
- `_normalizeBarHeight`, `_buildSparseHourLabelMap`, and formatting helpers copied from `helman-forecast-detail.ts` (not extracted to shared module, keeping components independent)

### Known items deferred

- Per-consumer deferrable breakdown — Increment 5
- `_addDaysToDayKey` duplication between `forecast-detail-model.ts` and `house-forecast-detail-model.ts` — could extract to shared utility in a future cleanup
- Both `helman-forecast-detail` and `helman-house-forecast-detail` independently fetch the full forecast payload — a shared forecast context/store could deduplicate this in the future

## Increment 5 — Done

### What was implemented

**Frontend** — per-consumer deferrable breakdown view in `helman-house-forecast-detail.ts`:
- Third "Rozpad" (breakdown) view added to the pill toggle alongside "Celkem" (total) and "Základ" (baseline)
- Breakdown view renders one bar-chart row per deferrable consumer plus a baseline row, all sharing a common Y-axis max and x-axis
- Consumer bars use `color-mix(in srgb, var(--primary-color) N%, transparent)` at cycling opacity levels (95%, 70%, 50%, 35%) to differentiate consumers while staying theme-aware
- Breakdown summary section shows per-consumer daily energy totals plus baseline
- Model layer (`house-forecast-detail-model.ts`) now preserves per-consumer identity through `ConsumerHourSnapshot[]` on each `HouseForecastHour` and computes `consumerDaySums` per day
- Padded (empty) hours carry `consumers: []` — breakdown gracefully shows zero-height bars
- With 0 consumers configured, breakdown view degrades to showing only the baseline row

**Backend** — no changes (Increment 3 produced the correct `deferrableConsumers[]` in each hour DTO)

### Files touched

Frontend:
- `src/helman-simple/node-detail/house-forecast-detail-model.ts` (added `ConsumerHourSnapshot`, `ConsumerDayTotal`, `consumers` field, `consumerDaySums` field, `_buildConsumerDaySums` helper)
- `src/helman-simple/node-detail/helman-house-forecast-detail.ts` (extended `HouseView` with `"breakdown"`, added `_renderBreakdownChart`, `_renderBreakdownSummary`, `_buildBreakdownRows`, `_renderConsumerDetailColumn`, `_renderDetailAxis`, `_renderStandardSummary`, `_renderSingleRowChart`)
- `src/helman-simple/node-detail/node-detail-shared-styles.ts` (no new CSS rules needed — consumer bars use inline `color` style)
- `src/localize/translations/cs.json` (added `breakdown` key)

### Design decisions

- Shared Y-axis max across all consumers + baseline — bars are directly comparable across rows (a consumer that draws 0.1 kWh shows a shorter bar than baseline at 2 kWh)
- `color-mix()` over bare `opacity` — only affects bar fill, not child text; adapts to any HA theme
- No peak highlight labels on consumer rows — avoids visual clutter with 4+ consumers; summary section shows absolute daily totals
- Consumer ordering by `entityId` (alphabetical sort) for stability across hours and days
- Axis rendering extracted to `_renderDetailAxis` to avoid duplication between single-row and breakdown charts
- No `deferrableTotal` aggregate row — each consumer shown individually as agreed

### Known items deferred

- `_addDaysToDayKey` duplication between `forecast-detail-model.ts` and `house-forecast-detail-model.ts` — could extract to shared utility in a future cleanup
- Both `helman-forecast-detail` and `helman-house-forecast-detail` independently fetch the full forecast payload — a shared forecast context/store could deduplicate this in the future
- Breakdown toggle is shown even when no deferrable consumers are configured (degrades to a single baseline row)

## What's next: Increment 6

**Goal**: Docs, config examples, and cleanup.

The next session should read the **Increment 6** section of [`implementation_plan.md`](./implementation_plan.md) for full details.
