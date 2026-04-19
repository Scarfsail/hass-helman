# 15-Minute Forecast Granularity — Implementation Plan

## Purpose

This document turns `docs/15min-granularity-final-analysis.md` into an execution plan for future coding sessions.

The feature should be implemented increment by increment, not as one large backend rewrite.

After every increment:

- add or update unit tests for the touched behavior before moving on
- run `python3 -m unittest discover -s tests -v`
- if backend code changed, stop and ask the user to restart Home Assistant before local runtime checks
- validate the increment through the local Home Assistant websocket API
- report the result before starting the next increment

## References

- Final combined analysis: [`15min-granularity-final-analysis.md`](./15min-granularity-final-analysis.md)
- Backend repo root: `/home/ondra/dev/hass/hass-helman`
- Backend code: `/home/ondra/dev/hass/hass-helman/custom_components/helman/`
- Frontend repo root: `/home/ondra/dev/hass/hass-helman-card`
- Frontend code: `/home/ondra/dev/hass/hass-helman-card/src/`

## Fixed assumptions for this plan

- `docs/15min-granularity-final-analysis.md` remains the source of truth for the resolved design decisions.
- Backend computation moves to canonical 15-minute slots and aggregates to `30` or `60` on demand.
- `helman/get_forecast` gains optional `granularity` and `forecast_days` parameters, with defaults `60` and `7`.
- The API rename from `currentHour` to `currentSlot` is still part of the target contract.
- The frontend stays on `60`-minute responses for now; do not attempt quarter-hour rendering in the card yet.
- Forecast granularity work must not change schedule slot sizing, `helman/get_history`, or live history bucket configuration.
- Manual runtime validation should happen against the local Home Assistant instance through the websocket API after the user restarts Hass.

## Current repo reality that affects sequencing

- `helman/get_forecast` currently accepts no request parameters and calls `HelmanCoordinator.get_forecast()` directly.
- `house_consumption` and `battery_capacity` are currently hourly payloads and still expose `currentHour`.
- Solar and grid forecast points are already timestamp-driven, but solar actual history and battery actual history are still built around hour boundaries.
- House forecast snapshots are persisted in HA storage, but the battery cache is not actually wired even though the TTL constant already exists.
- Older docs say there is no backend automated test suite, but that is stale. The repo now has a lightweight `unittest` suite, and `python3 -m unittest discover -s tests -v` currently passes.
- The frontend repo has a production build command: `cd /home/ondra/dev/hass/hass-helman-card && npm run build-prod`.

## Explicitly out of scope for the first rollout

- changing the schedule subsystem from its current `30`-minute slot size
- changing `helman/get_history` or live in-memory history bucket semantics
- adding new forecast sensor entities
- adding a frontend toggle for `15`/`30` minute views
- quarter-hour chart axes, quarter-hour refresh timers, or quarter-hour day-grouping in the card

## Shared validation workflow

### Backend unit tests

Every increment below includes unit-test expectations on purpose. Do not leave tests as a final cleanup task.

Use the existing backend suite as the minimum regression gate:

```bash
cd /home/ondra/dev/hass/hass-helman
python3 -m unittest discover -s tests -v
```

When new forecast-specific coverage is added, prefer small focused modules in `tests/` alongside the current `unittest` style, for example:

- `tests/test_forecast_request_contract.py`
- `tests/test_forecast_aggregation.py`
- `tests/test_consumption_forecast_builder.py`
- `tests/test_battery_capacity_forecast_builder.py`
- `tests/test_forecast_recorder_slots.py`

### Local Home Assistant API validation

After any backend increment:

1. Ask the user to restart Home Assistant so the changed custom component is loaded.
2. Verify the integration loads cleanly.
3. Exercise `helman/get_forecast` through the local websocket API.

Use the browser console while logged into Home Assistant:

```js
(() => {
  const conn = document.querySelector("home-assistant")?.hass?.connection;
  if (!conn) {
    throw new Error("Home Assistant connection not found. Run this in the browser console while logged into Home Assistant.");
  }

  window.getHelmanForecast = (overrides = {}) =>
    conn.sendMessagePromise({ type: "helman/get_forecast", ...overrides });

  console.log("Helpers installed:");
  console.log("- await getHelmanForecast()");
  console.log("- await getHelmanForecast({ granularity: 60, forecast_days: 7 })");
  console.log("- await getHelmanForecast({ granularity: 15, forecast_days: 1 })");
})();
```

Notes:

- Before the websocket schema change lands, use `await getHelmanForecast()` with no overrides.
- The forecast contract itself is websocket-based, so this should be the primary runtime check.
- REST `curl` reads against `/api/states/<entity_id>` are still useful for debugging raw solar, battery, or house inputs when a forecast looks wrong.
- For future CLI-only sessions, the same runtime check can be done without the browser console by opening a websocket client directly against `ws://127.0.0.1:8123/api/websocket`, authenticating with a long-lived Home Assistant access token, and sending the same `helman/get_forecast` messages from a short local script (for example Node.js using the built-in `WebSocket` API).

## Increment overview

| Increment | Name | Main area | User validation required |
|---|---|---|---|
| 1 | Request contract and baseline protection (done) | websocket + coordinator + tests | Yes |
| 2 | Slot-aware recorder helpers (done) | recorder + actual history helpers + tests | Yes |
| 3 | Canonical 15-minute house forecast | house builder + snapshot compatibility + tests | Yes |
| 4 | Canonical 15-minute battery forecast (done) | battery builder + solar semantics + tests | Yes |
| 5 | Aggregation, cache, and rollout closeout (done) | coordinator + cache + docs + tests | Yes |
| 6 | Frontend follow-up (done) | hass-helman-card compatibility patch | Yes |

## Increment 1 — Request contract and baseline protection (done)

### Goal

Introduce the request contract safely while protecting existing hourly behavior.

### Likely backend files

- `custom_components/helman/websockets.py`
- `custom_components/helman/coordinator.py`
- `custom_components/helman/const.py`
- forecast aggregation helper code if extracted from the coordinator

### Scope

- Add optional websocket params:
  - `granularity`: `15 | 30 | 60`
  - `forecast_days`: integer `1..14`
- Keep defaults at the current behavior: `granularity=60`, `forecast_days=7`.
- Thread the parameters into `HelmanCoordinator.get_forecast()`.
- Add pure aggregation helpers and test them before any builder starts returning canonical 15-minute data.
- Preserve the current default response shape for existing clients.

### Unit tests to add or update

- New request-contract coverage:
  - default call still succeeds
  - explicit `{ granularity: 60, forecast_days: 7 }` matches the default path
  - invalid `granularity` and `forecast_days` values are rejected
- New pure aggregation coverage for the rules already agreed in the final analysis:
  - sum energy values
  - average price values
  - keep last SoC / remaining energy
  - OR the boolean flags

### Local HA API checks

- Baseline:
  - `await getHelmanForecast()`
- After the schema change:
  - `await getHelmanForecast({ granularity: 60, forecast_days: 7 })`
- Compare the default and explicit-hourly responses:
  - same section availability
  - same hourly lengths
  - same `currentHour` field and hourly payload contract until the intentional rename lands in Increment 3

### Exit criteria

- Existing frontend consumers are not broken.
- The backend accepts the future request shape.
- Aggregation rules have dedicated unit coverage before canonical 15-minute builders are wired in.
- Done: backend unit tests passed, local websocket validation confirmed the default and explicit hourly requests match, and future-shaped non-default requests are rejected with `not_supported` until later increments implement them.

## Increment 2 — Slot-aware recorder helpers (done)

### Goal

Generalize the shared time-boundary helpers so future and actual-history paths can work on 15-minute slots without duplicating hour-specific logic.

### Likely backend files

- `custom_components/helman/recorder_hourly_series.py`
- `custom_components/helman/battery_actual_history_builder.py`
- `custom_components/helman/forecast_builder.py`

### Scope

- Generalize local boundary generation from hour-specific helpers to slot-aware helpers driven by interval minutes.
- Preserve the UTC-based stepping approach so DST gaps and repeated hours stay safe.
- Add the primitives needed for:
  - 15-minute house actual history
  - 15-minute solar actual history
  - 15-minute battery actual history
- Keep default public behavior stable until the builders are switched over in later increments.

### Unit tests to add or update

- Extend `tests/test_forecast_dst.py` with 15-minute stepping assertions across spring-forward and fall-back transitions.
- Add focused tests for slot-boundary generation and boundary sampling logic.
- Add focused tests for battery and solar actual-history builders once they use slot-based helpers.

### Local HA API checks

- After restart, call `await getHelmanForecast()` and confirm no regression in the default hourly response.
- If any actual-history path is exposed during this increment, inspect the timestamps and confirm:
  - they are correctly ordered
  - they stay timezone-safe through DST-sensitive dates
  - there are no duplicate local slot timestamps created by wall-clock arithmetic

### Exit criteria

- Shared recorder helpers can generate slot boundaries safely.
- DST coverage exists for 15-minute stepping.
- No default hourly contract regressions are introduced.
- Done: backend unit tests passed, local websocket validation confirmed the default and explicit hourly requests match materially, the live hourly payload remained stable, visible actual-history timestamps were ordered and unique, and future-shaped `15`-minute requests still return `not_supported` until later increments implement them.

## Increment 3 — Canonical 15-minute house forecast (done)

### Goal

Move house forecast generation to canonical 15-minute slots while keeping the current frontend safe through `60`-minute responses.

### Likely backend files

- `custom_components/helman/consumption_forecast_builder.py`
- `custom_components/helman/coordinator.py`
- `custom_components/helman/storage.py`
- `custom_components/helman/const.py`

### Scope

- Generate the house forecast internally at 15-minute resolution.
- Keep the hourly training model unchanged and divide each hourly profile value by `4` for the quarter-hour output.
- Replace `currentHour` with `currentSlot`.
- Parameterize the horizon from `forecast_days`.
- Aggregate canonical house data back to the requested response granularity in the coordinator.
- Update snapshot compatibility logic so old hourly snapshots are treated as stale and rebuilt.
- Update freshness checks to compare slot timestamps, not hour timestamps.

### Unit tests to add or update

- Canonical 15-minute house series length:
  - `forecast_days=1` -> `96` slots
  - `forecast_days=7` -> `672` slots
- Round-trip accuracy:
  - four 15-minute baseline values sum back to the previous hourly value
  - the same holds for each deferrable consumer band
- `currentSlot` alignment and slot freshness checks
- snapshot invalidation or version-bump behavior when an old hourly snapshot is loaded

### Local HA API checks

- Default compatibility path:
  - `await getHelmanForecast({ granularity: 60, forecast_days: 1 })`
- Canonical path:
  - `await getHelmanForecast({ granularity: 15, forecast_days: 1 })`
- Verify:
  - `house_consumption.resolution` reflects the returned granularity
  - `house_consumption.currentSlot` exists
  - `series.length` matches the requested horizon
  - the first four `15`-minute entries sum to the first `60`-minute value

### Exit criteria

- House forecast is canonical at 15 minutes.
- Stored snapshot compatibility is handled explicitly.
- The hourly frontend path remains available through aggregated `60`-minute responses.
- Done: backend unit tests passed, local websocket validation confirmed the default hourly response still worked, `granularity=60` with `forecast_days=1` returned `resolution: "hour"` with `currentSlot` and `24` series entries, `granularity=15` with `forecast_days=1` returned `resolution: "quarter_hour"` with `currentSlot` and `96` series entries, and aligned quarter-hour house values summed to the corresponding hourly bucket.

## Increment 4 — Canonical 15-minute battery forecast (done)

### Goal

Move the battery simulation to 15-minute slots and remove the current solar-energy scaling bug.

### Likely backend files

- `custom_components/helman/battery_capacity_forecast_builder.py`
- `custom_components/helman/battery_actual_history_builder.py`
- `custom_components/helman/forecast_builder.py`
- `custom_components/helman/recorder_hourly_series.py`

### Scope

- Replace the hour-based simulation loop with 15-minute stepping.
- Replace the hour-keyed solar map with a 15-minute slot map.
- Replace hour-keyed house lookup logic with 15-minute slot lookups.
- Fix the current solar handling bug by treating `wh_period` values as absolute energy per slot:
  - use `solar_kwh = solar_wh / 1000`
  - scale only the first partial slot within its own 15-minute period
- Keep the first slot fractional from `now` to the next 15-minute boundary.
- Move battery and solar actual history onto slot-aware helpers.

### Unit tests to add or update

- Fractional first-slot duration is never greater than `0.25` hours.
- Solar energy is not multiplied like a rate once slot granularity is canonical.
- Battery slot timestamps stay DST-safe at 15-minute steps.
- Partial coverage behavior still reports honest `partialReason` and `coverageUntil`.
- Aggregated `60`-minute battery data remains consistent with grouped quarter-hour slots.

### Local HA API checks

- Quarter-hour request:
  - `await getHelmanForecast({ granularity: 15, forecast_days: 1 })`
- Hourly compatibility request:
  - `await getHelmanForecast({ granularity: 60, forecast_days: 1 })`
- Inspect the first several battery slots and confirm:
  - timestamps advance in 15-minute steps
  - the first `durationHours` is fractional but `<= 0.25`
  - `socPct` stays bounded
  - `coverageUntil` is coherent
  - solar values look consistent with the upstream `wh_period` data

### Exit criteria

- Battery forecast is canonical at 15 minutes.
- The known solar-scaling bug is removed.
- Default hourly consumers still get coherent data through aggregation.
- Done: backend unit tests passed, local websocket validation after restart confirmed `granularity=15` returned `battery_capacity.resolution: "quarter_hour"` with `96` series entries and a fractional first slot `<= 0.25` hours, `granularity=60` returned `resolution: "hour"` with `24` series entries whose first bucket matched the grouped quarter-hour battery entries, and the live Home Assistant instance's hourly solar `wh_period` inputs were normalized into canonical quarter-hour battery slots without truncating the forecast after the first entry.

## Increment 5 — Aggregation, cache, and rollout closeout (done)

### Goal

Finish the end-to-end contract: aggregate all forecast sections correctly, wire the battery cache for real, and close the rollout with tests and docs.

### Likely backend files

- `custom_components/helman/coordinator.py`
- `custom_components/helman/websockets.py`
- `custom_components/helman/const.py`
- `docs/features/forecast/house-consumption-forecast/README.md`
- `docs/features/forecast/house-consumption-forecast/history-behavior-explained.md`
- `docs/features/forecast/battery-capacity-forecast/README.md`

### Scope

- Ensure the aggregation rules cover:
  - `house_consumption.series`
  - `house_consumption.actualHistory`
  - `battery_capacity.series`
  - `battery_capacity.actualHistory`
  - `solar.points`
  - `solar.actualHistory`
  - `grid.points`
- Make `resolution` and `horizonHours` reflect the returned payload granularity, not the internal canonical representation.
- Implement the real battery cache and invalidation behavior.
- Ensure shorter and longer `forecast_days` requests behave predictably with cached canonical data.
- Update documentation so the backend contract, cache behavior, and validation flow match reality.

### Unit tests to add or update

- Full aggregation coverage across every affected sub-document
- cache hit / miss / invalidation coverage
- restart-time snapshot rebuild or invalidation behavior
- regression coverage for default hourly compatibility

### Local HA API checks

- Compare:
  - `await getHelmanForecast({ granularity: 15, forecast_days: 1 })`
  - `await getHelmanForecast({ granularity: 30, forecast_days: 1 })`
  - `await getHelmanForecast({ granularity: 60, forecast_days: 1 })`
- Verify:
  - four `15`-minute house values sum to one `60`-minute value
  - two `15`-minute price points average into one `30`-minute price point
  - the final SoC of a grouped battery slot matches the last sub-slot
- Call the endpoint twice in short succession and confirm cache behavior matches expectations.
- Ask the user to restart Hass, then re-run the API checks to confirm snapshot loading and cache rebuild are clean.

### Exit criteria

- The backend serves correct `15`, `30`, and `60` minute payloads from one canonical 15-minute model.
- Cache behavior is real, test-covered, and predictable.
- The repo docs match the implemented contract.
- Done: backend unit tests passed, the local Home Assistant websocket validation after restart confirmed the default and explicit hourly requests returned hourly payloads, `granularity=15`, `30`, and `60` returned the expected `resolution` and `horizonHours` values across house, battery, solar, and grid, aligned quarter-hour house values summed to the corresponding hourly bucket, quarter-hour grid prices averaged into the half-hour bucket, grouped battery buckets kept the last sub-slot SoC, and a repeated hourly request reused the cached battery result with matching `generatedAt` and `startedAt`.

## Increment 6 — Frontend follow-up (done; keep 60-minute intervals for now)

This is a compatibility patch for `hass-helman-card`, not a quarter-hour UI rollout.

### Files that should change in the frontend repo

#### `src/helman-api.ts`

- Add request typing for `granularity?: 15 | 30 | 60` and `forecast_days?: number`.
- Replace `currentHour` with `currentSlot` in the house forecast DTO.
- Relax any overly narrow `resolution` typing so it can represent the new backend values instead of assuming `"hour"` forever.
- Keep the existing hourly-oriented DTO shapes for now because the frontend will still request `60`-minute responses.

#### `src/helman/forecast-loader.ts`

- Change the request to send:
  - `type: "helman/get_forecast"`
  - `granularity: 60`
  - `forecast_days: 7`
- Keep the current short request cache behavior; because the frontend remains hourly, no 15-minute cache-key strategy is needed yet.

#### `src/helman-forecast/unified-forecast-model.ts`

- Read `house_consumption.currentSlot` instead of `currentHour`.
- Keep passing hourly data into the existing day models, because the request granularity stays at `60`.

#### `src/helman-forecast/shared/house-forecast-detail-model.ts`

- Rename the `currentHour` plumbing to `currentSlot`.
- Keep the current hour-based day grouping and axis logic unchanged while the card continues to request hourly data.

### Files that should stay hourly for now

These files currently encode hour-oriented rendering or refresh behavior and should remain that way until the frontend is intentionally upgraded to display quarter-hour data:

- `src/helman-forecast/shared/battery-capacity-forecast-detail-model.ts`
- `src/helman-forecast/shared/forecast-detail-model.ts`
- `src/helman-forecast/shared-forecast-owner.ts`
- `src/helman-forecast/helman-unified-forecast-detail.ts`
- `src/helman-simple/node-detail/node-detail-house-content.ts`
- `src/helman-simple/node-detail/node-detail-battery-content.ts`

For this first frontend step:

- do **not** add a `15` / `30` minute selector
- do **not** switch chart axes from hourly buckets to slot buckets
- do **not** change the hour-boundary refresh timer yet
- do **not** enable direct `15`-minute rendering until the frontend models and charts are made slot-aware end to end

### Frontend validation once touched

Run:

```bash
cd /home/ondra/dev/hass/hass-helman-card
npm run build-prod
```

Then verify in Home Assistant that the existing forecast detail still renders correctly while the card explicitly requests `granularity: 60`.

Done: `npm run build-prod` passed in `/home/ondra/dev/hass/hass-helman-card`, the frontend request is now explicitly `{ granularity: 60, forecast_days: 7 }`, the house forecast DTO/model wiring reads `currentSlot`, and the existing hourly grouping / axis / refresh behavior was intentionally left unchanged.
