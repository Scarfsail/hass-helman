# House Consumption Forecast Implementation Plan

## Purpose

This document is the implementation handoff for a future coding session.

The next session should implement the feature **increment by increment**, not all at once.

After each increment:

- run the available validation for the touched repo(s)
- stop and report what changed
- if the increment says **user validation required**, wait for confirmation before moving on

## Agreed v1 scope

The implementation should target this exact first version:

- backend-generated forecast in `hass-helman`
- forecast target is **hourly energy consumption** in `kWh`
- forecast horizon is **7 days** / `168` points
- historical source is **Home Assistant Recorder / statistics**
- prefer a **cumulative / `total_increasing`** house energy entity
- show forecast only when at least **14 days** of usable hourly history exist
- forecast **non-deferrable baseline**
- forecast each **deferrable consumer** separately
- return **one record per forecast hour**
- let the **frontend derive** `deferrableTotal` and `total` when needed
- run house forecast generation **every hour**
- persist the latest house forecast snapshot and load it again after restart
- return the **persisted / cached** house forecast on websocket requests
- include a **confidence band** for each hour
- render the feature in the **house detail** of `hass-helman-card`

## Explicitly out of scope for v1

Do not include these in the first implementation sequence:

- weather / temperature adjustment
- schedule-aware deferrable planning
- external ML frameworks
- a separate Helman-owned long-term history store
- new Home Assistant sensor entities for forecast output
- extending the standalone `helman-forecast-card` before the house-detail flow works well

Note: a **persisted forecast snapshot** is in scope. What remains out of scope is a separate Helman-owned long-term **history** store.

## Recommended config contract

Use this config shape as the target contract for v1:

```yaml
power_devices:
  house:
    entities:
      power: sensor.house_power
      today_energy: sensor.house_energy_today
    forecast:
      total_energy_entity_id: sensor.house_energy_total   # required source for forecast
      min_history_days: 14                      # optional, default 14
      training_window_days: 42                 # optional, default 42
      deferrable_consumers:
        - energy_entity_id: sensor.ev_charging_energy_total
          label: EV Charging
        - energy_entity_id: sensor.pool_heating_energy_total
          label: Pool Heating
```

### Resolution rules

- Feature enablement is controlled by the presence of `power_devices.house.forecast`.
- `power_devices.house.forecast.total_energy_entity_id` is required.
- If `total_energy_entity_id` is missing, the house forecast must return `not_configured`.
- Deferrable consumers should also use statistics-friendly energy entities when possible.
- Use `energy_entity_id` as the unique identity for each deferrable consumer; do not require a separate user-defined key.
- If history is insufficient, return a forecast status and **hide the UI**.

This is intentionally different from `house.entities.*`:

- `house.entities.*` should stay focused on the main house device and current summary info
- `house.forecast.*` should contain inputs used only by the forecast feature

## Recommended backend payload contract

Extend the existing `helman/get_forecast` response with a new `house_consumption` section.

Recommended DTO shape:

```json
{
  "house_consumption": {
    "status": "available",
    "generatedAt": "2026-03-12T08:05:00+01:00",
    "unit": "kWh",
    "resolution": "hour",
    "horizonHours": 168,
    "trainingWindowDays": 42,
    "historyDaysAvailable": 34,
    "requiredHistoryDays": 14,
    "model": "hour_of_week_baseline",
    "series": [
      {
        "timestamp": "2026-03-12T08:00:00+01:00",
        "nonDeferrable": {
          "value": 1.2,
          "lower": 0.9,
          "upper": 1.6
        },
        "deferrableConsumers": [
          {
            "entityId": "sensor.ev_charging_energy_total",
            "label": "EV Charging",
            "value": 0.3,
            "lower": 0.0,
            "upper": 1.0
          },
          {
            "entityId": "sensor.pool_heating_energy_total",
            "label": "Pool Heating",
            "value": 0.1,
            "lower": 0.0,
            "upper": 0.4
          }
        ]
      }
    ]
  }
}
```

This shape intentionally does **not** include:

- `total`
- `deferrableTotal`

The frontend should derive those by summing the per-hour record:

```text
total = nonDeferrable.value + sum(deferrableConsumers[*].value)
deferrableTotal = sum(deferrableConsumers[*].value)
```

### Recommended status values

Extend the forecast status union with:

- `insufficient_history`

So the total set becomes:

- `not_configured`
- `insufficient_history`
- `unavailable`
- `partial`
- `available`

`insufficient_history` is useful because the frontend can intentionally hide the chart while still showing a meaningful reason.

## Recommended runtime and persistence model

The house forecast should be treated as a **scheduled persisted snapshot**, not as a live on-demand calculation.

Recommended behavior:

- keep the latest `house_consumption` snapshot in memory inside the integration
- persist that snapshot to Home Assistant storage after each successful generation
- load the persisted snapshot during integration startup
- trigger a non-blocking refresh on startup so the snapshot becomes fresh again quickly
- schedule recurring refreshes **every hour**
- trigger an immediate refresh after relevant config changes
- have `helman/get_forecast` return the cached / persisted house forecast instead of recalculating it live

Recommended ownership:

- `consumption_forecast_builder.py` builds a new house forecast snapshot
- `storage.py` persists and loads the snapshot
- `coordinator.py` owns the refresh schedule, in-memory cache, startup load, and invalidation behavior

Why this is important:

- websocket responses stay fast and deterministic
- frontend always sees one stable forecast snapshot
- the feature survives Home Assistant restarts cleanly
- hourly generation cadence is explicit and testable

## Recommended file touchpoints

### Backend

Existing files likely to change:

- `custom_components/helman/const.py`
- `custom_components/helman/forecast_builder.py`
- `custom_components/helman/storage.py`
- `custom_components/helman/coordinator.py`

Existing files likely unchanged:

- `custom_components/helman/websockets.py`
- `custom_components/helman/sensor.py`
- `custom_components/helman/tree_builder.py`

Recommended new backend file:

- `custom_components/helman/consumption_forecast_builder.py`

Reason:

- keep `forecast_builder.py` as the top-level orchestrator
- isolate Recorder/statistics access and house-forecast math in one focused module
- reduce risk of breaking existing solar/grid forecast logic
- keep scheduler / cache concerns out of the math builder

### Frontend

Existing files likely to change:

- `src/helman-api.ts`
- `src/helman/DeviceConfig.ts`
- `src/helman/forecast-loader.ts`
- `src/helman-simple/node-detail/node-detail-house-content.ts`
- `src/localize/translations/cs.json`
- `README.md`

Recommended new frontend files:

- `src/helman-simple/node-detail/helman-house-forecast-detail.ts`
- `src/helman-simple/node-detail/house-forecast-detail-model.ts`

Reason:

- avoid overloading the existing solar/grid `helman-forecast-detail.ts` too early
- keep house forecast UI isolated until it is stable
- allow later refactoring of shared chart pieces only after the feature works

## Validation reality in this codebase

Current repo situation:

- `hass-helman` does **not** currently expose a backend test suite
- `hass-helman-card` has build scripts, but no dedicated FE test suite

So the realistic validation path is:

- backend: Home Assistant reload / restart + log inspection + manual smoke testing
- frontend: run `npm run build-prod` in `hass-helman-card`

Because of that, the **user validation checkpoints matter** and should not be skipped.

## Manual testing expectations for the future implementation session

After **every** increment, the implementing agent should provide a short manual testing section for the user with two parts:

- **Backend use-cases to test**
- **Frontend use-cases to test**

The backend checklist should describe what to inspect in websocket output.

The frontend checklist should describe what to verify in the Home Assistant UI.

### Paste-ready browser console snippet: read house forecast config

Paste this into the browser console while logged into Home Assistant:

```js
(async () => {
  const conn = document.querySelector("home-assistant")?.hass?.connection;
  if (!conn) {
    throw new Error("Home Assistant connection not found. Run this in the browser console while logged into Home Assistant.");
  }

  const config = await conn.sendMessagePromise({ type: "helman/get_config" });
  const houseForecastConfig = config?.power_devices?.house?.forecast ?? null;
  console.log("house forecast config:");
  console.log(houseForecastConfig);
  console.log(JSON.stringify(houseForecastConfig, null, 2));
})();
```

### Paste-ready browser console snippet: read house forecast payload

Paste this into the browser console while logged into Home Assistant:

```js
(async () => {
  const conn = document.querySelector("home-assistant")?.hass?.connection;
  if (!conn) {
    throw new Error("Home Assistant connection not found. Run this in the browser console while logged into Home Assistant.");
  }

  const forecast = await conn.sendMessagePromise({ type: "helman/get_forecast" });
  const houseConsumption = forecast?.house_consumption ?? null;
  console.table([{
    status: houseConsumption?.status ?? null,
    generatedAt: houseConsumption?.generatedAt ?? null,
    seriesLength: Array.isArray(houseConsumption?.series) ? houseConsumption.series.length : null,
    historyDaysAvailable: houseConsumption?.historyDaysAvailable ?? null,
    requiredHistoryDays: houseConsumption?.requiredHistoryDays ?? null,
  }]);
  console.log("house_consumption:");
  console.log(houseConsumption);
  console.log(JSON.stringify(houseConsumption, null, 2));
})();
```

### What the agent should tell the user to look for in backend output

The increment-specific backend checklist should usually call out some subset of these:

- correct `status`
- correct `generatedAt`
- correct `requiredHistoryDays` and `historyDaysAvailable`
- correct `series.length`
- correct hourly `timestamp` alignment
- correct `nonDeferrable` object shape
- correct `deferrableConsumers[]` shape
- correct `entityId` and `label` values for deferrable consumers
- absence of deprecated fields such as backend `total` or `deferrableTotal`
- persisted snapshot availability after Home Assistant restart

## Increment sequence

The next session should follow this order.

## Increment 1 - Shared contract and safe scaffolding

### Goal

Add the shared config and API contract without changing existing forecast behavior for solar/grid.

### Backend changes

- Create `custom_components/helman/consumption_forecast_builder.py` as a stub that returns a well-formed `house_consumption` payload.
- Update `custom_components/helman/forecast_builder.py` to include `house_consumption` in the returned payload.
- Keep the initial backend status as `not_configured` until the feature is wired.
- Include `generatedAt` in the stub payload shape, even if it is initially `null`.
- Add defensive default reading for:
    - `house.forecast.total_energy_entity_id`
    - `house.forecast.min_history_days`
    - `house.forecast.training_window_days`
    - `house.forecast.deferrable_consumers`
- Prefer builder-level defaults over storage migration in this increment.

### Frontend changes

- Extend `src/helman-api.ts` with:
  - `HouseConsumptionForecastDTO`
  - `ForecastBandValueDTO`
  - `HouseConsumptionForecastHourDTO`
  - `DeferrableConsumerHourValueDTO`
  - the new `insufficient_history` status literal
- Extend `src/helman/DeviceConfig.ts` with:
  - `house.forecast?: { total_energy_entity_id: string; min_history_days?: number; training_window_days?: number; deferrable_consumers?: { energy_entity_id: string; label?: string }[] }`
- Add a new placeholder component:
    - `src/helman-simple/node-detail/helman-house-forecast-detail.ts`
- Render that component from:
    - `src/helman-simple/node-detail/node-detail-house-content.ts`
- Add initial localization keys in:
    - `src/localize/translations/cs.json`

### Important implementation notes

- Do **not** change `helman/get_forecast` endpoint shape for solar/grid.
- Do **not** reuse `helman-forecast-detail.ts` yet.
- Keep the house forecast component hidden when `house_consumption.status === "not_configured"`.

### Validation after increment

Implementer:

- run `npm run build-prod` in `hass-helman-card`
- restart / reload Home Assistant and confirm the integration still loads
- confirm no existing solar/grid/battery UI regressed

User validation required

- **Yes**
- Backend use-cases to test:
  - Paste the `helman/get_config` snippet and confirm the existing config still loads.
  - Paste the `helman/get_forecast` snippet and confirm `house_consumption` exists and is well-formed.
  - If forecast is not configured yet, confirm `house_consumption.status === "not_configured"`.
- Frontend use-cases to test:
  - Open the house detail and confirm that nothing existing broke.
  - Confirm solar, grid, battery, and current house detail still behave as before.
  - If forecast is not configured yet, confirm the new house forecast UI stays hidden and non-intrusive.

## Increment 2 - Persistence, scheduler, source resolution, and visibility rule

### Goal

Implement persisted snapshot loading/saving, hourly refresh scheduling, source resolution, and the `14 days minimum` visibility rule, but do not build the final forecast model yet.

### Backend changes

- In `custom_components/helman/storage.py`:
  - add a persisted store for the house forecast snapshot
  - keep it separate from config storage, even if both stay managed by the same module
- In `custom_components/helman/const.py`:
  - add storage key / version constants for the persisted forecast snapshot
- In `custom_components/helman/coordinator.py`:
  - load the persisted house forecast snapshot during startup
  - keep the latest house forecast snapshot in memory
  - schedule recurring refreshes **every hour**
  - trigger a non-blocking refresh on startup
  - trigger an immediate refresh after relevant config changes
  - make `get_forecast()` return the cached / persisted `house_consumption` data instead of recalculating it live
- In `custom_components/helman/consumption_forecast_builder.py`:

- Resolve the house history source in this order:

  1. `house.forecast.total_energy_entity_id`
- Query Recorder/statistics for the house source entity.
- Convert history into **local-time hourly buckets**.
- Compute:
    - `historyDaysAvailable`
    - `requiredHistoryDays`
    - `status`
- Return:
    - `not_configured` if the forecast config is absent or `total_energy_entity_id` is missing
    - `insufficient_history` if less than `14` usable days exist
    - `available` when enough history exists
- Return an empty `series` array for now; this increment is about data readiness, not prediction.
- Persist every newly generated snapshot, even if it only contains status metadata and an empty series.

### Frontend changes

In `helman-house-forecast-detail.ts`:

- Show a small status note for:
    - `insufficient_history`
    - `unavailable`
- Keep the chart area hidden when no forecast points exist.
- Show a friendly message like:
    - "Forecast will appear after 14 days of history."

### Important implementation notes

- Use `hass.config.time_zone` for bucket boundaries.
- Treat missing hourly data as **missing**, not zero.
- If the builder cannot query Recorder/statistics, log explicitly and return `unavailable`.
- Do not add debug-only websocket endpoints.
- The persisted snapshot should survive Home Assistant restart.

### Validation after increment

Implementer:

- smoke test backend startup
- run `npm run build-prod` in `hass-helman-card`

User validation required

- **Yes**
- Backend use-cases to test:
  - Paste the `helman/get_forecast` snippet and inspect `house_consumption.status`.
  - Confirm `generatedAt` is present after a refresh has been generated.
  - Confirm `requiredHistoryDays` is `14`.
  - Confirm `historyDaysAvailable` looks reasonable for your system.
  - Confirm `series` is still empty in this increment.
  - Restart Home Assistant, paste the snippet again, and confirm `house_consumption` is still returned from persisted storage immediately after restart.
- Frontend use-cases to test:
  - Confirm the forecast is hidden when history is insufficient.
  - Confirm the status note is understandable.
  - If your system already has enough history, confirm the component no longer says "insufficient history".
  - Sanity-check that the chosen source entity matches your expectation.

Do **not** move to the next increment until this is trusted, because the rest of the feature depends on history quality.

## Increment 3 - Backend statistical model and final forecast payload

### Goal

Implement the actual forecast generation in the backend, including non-deferrable values, per-consumer deferrable values, and confidence bands for each forecast hour.

### Backend changes

In `custom_components/helman/consumption_forecast_builder.py`:

- Read:
  - `training_window_days` default `42`
  - `min_history_days` default `14`
  - configured deferrable consumers
- Query hourly history for:
    - house total
    - each deferrable consumer
- Build historical **non-deferrable** series as:

```text
house_total - sum(deferrable_consumer_history)
```

- When subtracting:
    - clamp tiny negative residuals to `0`
    - if the residual is materially negative, log and drop the point rather than silently using bad data
- Build an **hour-of-week** statistical profile:
  - 168 slots
  - local-time aligned
  - recency-weighted
  - outlier trimming if helpful
- Generate forecasts for:
  - `nonDeferrable`
  - each configured deferrable consumer
- Recommended confidence band strategy for v1:
  - central value: weighted mean or weighted median
  - lower/upper band: percentile band from the training values for the slot
- Build the final DTO as one object per forecast hour:
  - `timestamp`
  - `nonDeferrable`
  - `deferrableConsumers[]`
- Each `deferrableConsumers[]` item should use `entityId` as its stable identifier in the payload.
- The backend may calculate `total` and `deferrableTotal` internally for sanity checks, but should **not** expose them in the DTO.
- Persist the completed forecast snapshot after every successful hourly refresh.
- Update `generatedAt` on each new snapshot.

### Frontend changes

- No major rendering work required in this increment.
- Only update DTO assumptions if the exact payload shape changes while implementing the backend.

### Important implementation notes

- If no deferrable consumers are configured:
  - return an empty `deferrableConsumers` array in each hour record
- Keep the output shape stable even when some series are empty.
- The backend should remain the single source of truth.

### Validation after increment

Implementer:

- backend smoke test in Home Assistant
- no user-facing stop required if increment 4 follows immediately

User validation required

- **Yes**
- Backend use-cases to test:
  - Paste the `helman/get_forecast` snippet and confirm `series` now contains hourly records.
  - Confirm `generatedAt` changes after a new refresh is produced.
  - Confirm each hourly record contains:
    - `timestamp`
    - `nonDeferrable`
    - `deferrableConsumers[]`
  - Confirm no backend `total` or `deferrableTotal` fields are exposed.
  - Confirm configured deferrable consumers appear with correct `entityId` and `label`.
  - Restart Home Assistant and confirm the same forecast snapshot structure is still returned before the next hourly refresh runs.
- Frontend use-cases to test:
  - Open the house detail and confirm the UI still loads without errors.
  - Confirm there are no browser console errors caused by the new payload shape.

This can be a quick checkpoint, but it should still be user-tested before moving on.

## Increment 4 - House forecast UI: total and baseline views

### Goal

Render the new house forecast in the house detail, but keep the first UI step focused: total and non-deferrable views first, per-consumer breakdown later.

### Frontend changes

Create:

- `src/helman-simple/node-detail/house-forecast-detail-model.ts`
- or equivalent mapper that groups hourly points into days and selected-day detail

Implement in `helman-house-forecast-detail.ts`:

- load forecast via existing `loadForecast()`
- refresh on the same `FORECAST_REFRESH_MS` cadence already used by other forecast views
- derive `total` and `deferrableTotal` locally from each hourly record
- render:
  - daily cards for the next 7 days
  - selected day detail with 24 hourly slots
  - switch / tabs / segmented control for:
    - `total`
    - `nonDeferrable`
- show confidence band visually, even if simple at first

Update:

- `node-detail-house-content.ts` to place the forecast section below the house summary
- `cs.json` with new strings for:
    - title
    - total
    - baseline
    - no data
    - insufficient history

### Backend changes

- None unless the frontend reveals small DTO issues that need cleanup

### Important implementation notes

- Reuse existing local-time helpers such as `local-date-time-parts-cache`.
- Keep the first UI visually simpler than the solar/grid forecast detail if needed.
- Do not refactor shared chart infrastructure unless necessary for correctness.

### Validation after increment

Implementer:

- run `npm run build-prod`
- verify no console errors in the browser

User validation required

- **Yes**
- Backend use-cases to test:
  - Paste the `helman/get_forecast` snippet and confirm the hourly payload still looks sane.
  - Confirm `generatedAt` is visible and reasonable.
  - Confirm the timestamps shown in the payload match the days and hours rendered in the UI.
- Frontend use-cases to test:
  - Confirm the house detail now shows a useful forecast section.
  - Confirm the day labels and hourly alignment match your local timezone.
  - Confirm the forecast is hidden when history is insufficient.
  - Confirm the `total` vs `non-deferrable` split is understandable.
  - Confirm the frontend-derived totals look correct.

## Increment 5 - Per-consumer deferrable breakdown

### Goal

Expose each deferrable consumer individually in the UI.

### Frontend changes

In `helman-house-forecast-detail.ts` and its model helper:

- render a per-consumer breakdown section for the selected day
- show each configured deferrable consumer by `label`
- show at least:
  - daily sum
  - hourly shape for the selected day
- optionally include a compact frontend-derived aggregate view for `deferrableTotal`

Recommended UI order:

1. total
2. non-deferrable
3. deferrable total
4. per-consumer list

### Backend changes

- None expected if increment 3 was completed cleanly

### Important implementation notes

- The per-consumer breakdown is part of the agreed v1 scope.
- Use `entityId` as the rendering key / stable identifier in the frontend.
- Keep labels entirely backend-driven from config, not hardcoded in the card.
- If one deferrable consumer has no usable data, render the rest and mark the payload `partial`.

### Validation after increment

Implementer:

- run `npm run build-prod`
- verify layout on both narrow and wide card widths

User validation required

- **Yes**
- Backend use-cases to test:
  - Paste the `helman/get_forecast` snippet and confirm each deferrable consumer appears with the expected `entityId` and `label`.
  - Confirm each hour record contains the expected consumer set for your config.
- Frontend use-cases to test:
  - Confirm the configured consumers appear with the correct labels.
  - Confirm the consumer totals add up to the frontend-derived `deferrableTotal`.
  - Confirm the frontend-derived `total = non-deferrable + deferrable total` in the UI.

This is the most important product validation checkpoint before polishing.

## Increment 6 - Docs, config examples, and cleanup

### Goal

Make the feature understandable and maintainable after the implementation is finished.

### Backend changes

- Clean up any temporary comments or debug-only status text
- keep the builder readable and well-factored

### Frontend changes

- ensure localization keys are complete
- clean up any temporary placeholder UI

### Documentation changes

Update:

- `hass-helman/docs/features/house_consumption_forecast/README.md`
- `hass-helman/docs/features/house_consumption_forecast/implementation_plan.md` if reality drifted
- `hass-helman-card/README.md`

Document:

- new house `forecast.total_energy_entity_id`
- `forecast.total_energy_entity_id` is required; there is no fallback to `today_energy`
- `house.forecast` config shape
- deferrable consumer examples
- 14-day history requirement
- hourly forecast generation cadence
- persisted snapshot behavior across requests and restarts
- meaning of non-deferrable, per-consumer deferrables, and frontend-derived totals

### Validation after increment

Implementer:

- run `npm run build-prod`
- do one final Home Assistant smoke test

User validation required

- **Yes**
- Backend use-cases to test:
  - Paste both the `helman/get_config` and `helman/get_forecast` snippets and confirm the final config/payload shape matches the documentation.
  - Confirm no deprecated fields remain in the payload.
- Frontend use-cases to test:
  - Final review of labels, layout, and practical usefulness.
  - Confirm the configuration example matches what you actually use in Home Assistant.

## Suggested stop points for the future implementation session

The next session should definitely stop after:

- Increment 1
- Increment 2
- Increment 4
- Increment 5

It may continue directly from Increment 3 to Increment 4 if the backend-only state is not yet useful for review.

## Practical advice for the future implementation session

- Keep solar and grid forecast behavior untouched until the house forecast works.
- Prefer a new dedicated house forecast component over early shared refactors.
- Prefer one new backend forecast module over spreading logic across many files.
- Do not introduce ML dependencies in v1.
- Do not add a second history store in Helman unless Recorder/statistics proves unusable.
