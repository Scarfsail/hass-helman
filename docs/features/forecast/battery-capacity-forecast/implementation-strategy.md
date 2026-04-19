# Battery Capacity Forecast — Implementation Strategy

## Purpose

This document is the implementation handoff for future coding sessions.

The feature should be implemented **increment by increment**, with each increment independently testable and shippable enough for user review.

After every increment:

- run the validation that exists for the touched repo(s)
- provide the user with the increment-specific manual testing checklist
- update `implementation-progress.md`
- stop and wait for user confirmation before starting the next increment

## References

- **Feature proposal**: [`README.md`](./README.md)
- **Implementation progress**: [`implementation-progress.md`](./implementation-progress.md)
- **Backend repo root**: `/home/ondra/dev/hass/hass-helman`
- **Backend code**: `/home/ondra/dev/hass/hass-helman/custom_components/helman/`
- **Backend docs**: `/home/ondra/dev/hass/hass-helman/docs/features/forecast/battery-capacity-forecast/`
- **Frontend repo root**: `/home/ondra/dev/hass/hass-helman-card`
- **Frontend code**: `/home/ondra/dev/hass/hass-helman-card/src/`
- **Frontend battery detail area**: `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/`

## Agreed v1 scope

The implementation should target this exact first version:

- backend-owned `battery_capacity` forecast returned by `helman/get_forecast`
- use only `house_consumption.series[].nonDeferrable.value`
- if solar becomes unknown, the battery forecast becomes `partial`
- prediction starts from **now**, not the next full hour
- the first slot is a **fractional** hour from `now` to the next top-of-hour
- charge and discharge efficiency are configurable
- default charge and discharge efficiency are both `0.95`
- charge and discharge power limits are part of v1
- use a short-lived in-memory cache for `battery_capacity` only
- target TTL is about `5 minutes`
- render the feature in the battery detail of `custom:helman-simple-card`
- prioritize **SoC** in the UI and show remaining energy as secondary

## Explicitly out of scope for v1

Do not include these in the first implementation sequence:

- frontend-derived battery simulation logic
- persisted battery forecast snapshots in Home Assistant storage
- standalone battery forecast card
- schedule-aware deferrable load planning
- grid-price-optimized battery strategy
- weather-aware or ML-based battery modeling
- new standalone Home Assistant sensor entities for every battery forecast slot

## Validation reality in this codebase

Current repo situation:

- `hass-helman` does **not** currently expose a backend automated test suite
- `hass-helman-card` has a production build command but no dedicated FE test suite

So the realistic validation path is:

- backend: deploy/reload the custom component, check HA logs, inspect websocket payloads
- frontend: run `npm run build-prod` in `hass-helman-card`
- end-to-end: open the battery detail in Home Assistant and verify the UI manually

## Shared validation commands

### Frontend build

Run this after any frontend increment:

```bash
cd /home/ondra/dev/hass/hass-helman-card && npm run build-prod
```

### Backend runtime validation

After any backend increment:

1. Deploy the updated custom component from:
   - `/home/ondra/dev/hass/hass-helman/custom_components/helman/`
2. Reload or restart Home Assistant.
3. Verify the Helman integration loads without errors in HA logs.

## Paste-ready browser console helpers

Paste this into the browser console while logged into Home Assistant:

```js
(() => {
  const conn = document.querySelector("home-assistant")?.hass?.connection;
  if (!conn) {
    throw new Error("Home Assistant connection not found. Run this in the browser console while logged into Home Assistant.");
  }

  window.getHelmanConfig = () => conn.sendMessagePromise({ type: "helman/get_config" });
  window.getHelmanForecast = () => conn.sendMessagePromise({ type: "helman/get_forecast" });

  console.log("Helpers installed:");
  console.log("- await getHelmanConfig()");
  console.log("- await getHelmanForecast()");
})();
```

You can then reuse `await getHelmanForecast()` in the increment-specific checks below.

## Increment overview

| Increment | Name | Repo(s) | Depends on | User validation required |
|-----------|------|---------|------------|--------------------------|
| 1 | Shared contract and safe scaffolding | BE + FE | none | Yes |
| 2 | House current-hour support | BE + FE | 1 | Yes |
| 3 | Battery simulation core from now | BE | 2 | Yes |
| 4 | Battery forecast TTL cache and invalidation | BE | 3 | Yes |
| 5 | Battery detail placeholder and status wiring | FE | 1, 3 | Yes |
| 6 | Daily SoC cards and summaries | FE | 5 | Yes |
| 7 | Hourly detail chart, polish, and docs closeout | FE + docs | 6 | Yes |

## Increment 1 — Shared contract and safe scaffolding

### Goal

Add the `battery_capacity` wire contract safely, without changing the battery UI yet.

### Backend paths

- Repo root: `/home/ondra/dev/hass/hass-helman`
- Likely files:
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/coordinator.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/const.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/battery_capacity_forecast_builder.py` (new)

### Frontend paths

- Repo root: `/home/ondra/dev/hass/hass-helman-card`
- Likely files:
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-api.ts`
  - `/home/ondra/dev/hass/hass-helman-card/src/helman/DeviceConfig.ts`

### Scope

- Extend the forecast payload with a `battery_capacity` section.
- Add DTO types on the frontend.
- Add a safe placeholder backend builder that returns a valid payload shape.
- Do **not** add visible battery forecast UI yet.

### What should be testable after this increment

- `helman/get_forecast` returns a `battery_capacity` key.
- Existing `solar`, `grid`, and `house_consumption` sections still work.
- Frontend builds successfully with the updated types.

### Browser console check

```js
const forecast = await getHelmanForecast();
console.table([{
  hasBatteryCapacity: Boolean(forecast?.battery_capacity),
  batteryStatus: forecast?.battery_capacity?.status ?? null,
  hasSolar: Boolean(forecast?.solar),
  hasGrid: Boolean(forecast?.grid),
  hasHouseConsumption: Boolean(forecast?.house_consumption),
}]);
console.log("battery_capacity:");
console.log(forecast?.battery_capacity ?? null);
console.log(JSON.stringify(forecast?.battery_capacity ?? null, null, 2));
```

### User validation checklist

- Backend:
  - Helman loads without errors.
  - `battery_capacity` is present in websocket output.
  - Existing forecast payload sections are unchanged.
- Frontend:
  - `npm run build-prod` succeeds.
  - Existing card behavior is unchanged.

### Exit criteria

- Shared contract exists.
- No real battery simulation yet.
- No battery forecast UI yet.

## Increment 2 — House current-hour support

### Goal

Expose an explicit current-hour baseline forecast entry so the battery simulation can start from **now** without guessing.

### Backend paths

- Repo root: `/home/ondra/dev/hass/hass-helman`
- Likely files:
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/consumption_forecast_builder.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/coordinator.py`

### Frontend paths

- Repo root: `/home/ondra/dev/hass/hass-helman-card`
- Likely files:
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-api.ts`

### Scope

- Extend `house_consumption` with an optional `currentHour` entry.
- Keep existing house forecast UI behavior unchanged.
- Make sure the current-hour entry has the same internal shape as a normal hourly house forecast item.

### What should be testable after this increment

- `house_consumption.currentHour` is present when the house forecast is available.
- `currentHour.timestamp` belongs to the current local hour.
- Existing house forecast UI still works because it ignores the extra field.

### Browser console check

```js
const forecast = await getHelmanForecast();
const house = forecast?.house_consumption ?? null;
const currentHour = house?.currentHour ?? null;

console.table([{
  status: house?.status ?? null,
  currentHourTimestamp: currentHour?.timestamp ?? null,
  baselineValue: currentHour?.nonDeferrable?.value ?? null,
  consumerCount: Array.isArray(currentHour?.deferrableConsumers) ? currentHour.deferrableConsumers.length : null,
}]);
console.log("house_consumption.currentHour:");
console.log(currentHour);
console.log(JSON.stringify(currentHour, null, 2));
```

### User validation checklist

- Backend:
  - `house_consumption.currentHour` appears with the expected shape.
  - The timestamp belongs to the current hour in local time.
- Frontend:
  - `npm run build-prod` succeeds.
  - Existing house forecast rendering does not regress.

### Exit criteria

- Battery simulation can depend on a clean current-hour house baseline contract.

## Increment 3 — Battery simulation core from now

### Goal

Implement the actual battery simulation from **now**, including the fractional first slot, efficiency, and power limits.

### Backend paths

- Repo root: `/home/ondra/dev/hass/hass-helman`
- Likely files:
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/battery_state.py` (new)
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/battery_capacity_forecast_builder.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/coordinator.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/const.py`

### Frontend paths

- No required frontend code changes in this increment.

### Scope

- Normalize live battery state.
- Normalize battery forecast config.
- Simulate battery progression using:
  - current SoC
  - current remaining energy
  - min/max SoC
  - base house forecast only
  - solar forecast
  - efficiency and power limits
- Start at `now` with a fractional first slot.
- Stop and return `partial` if solar becomes unknown.
- Do the calculation live on every request in this increment.

### What should be testable after this increment

- The first slot starts at `now`, not the next hour.
- `durationHours` for the first slot is between `0` and `1`.
- SoC stays inside min/max bounds.
- Power-limit and grid import/export fields are present.

### Browser console checks

#### Check battery forecast metadata

```js
const battery = (await getHelmanForecast())?.battery_capacity ?? null;
const outOfBounds = (battery?.series ?? []).filter((slot) =>
  slot.socPct < (battery?.minSoc ?? -Infinity) - 0.01 ||
  slot.socPct > (battery?.maxSoc ?? Infinity) + 0.01
);

console.table([{
  status: battery?.status ?? null,
  startedAt: battery?.startedAt ?? null,
  currentSoc: battery?.currentSoc ?? null,
  minSoc: battery?.minSoc ?? null,
  maxSoc: battery?.maxSoc ?? null,
  firstTimestamp: battery?.series?.[0]?.timestamp ?? null,
  firstDurationHours: battery?.series?.[0]?.durationHours ?? null,
  seriesLength: Array.isArray(battery?.series) ? battery.series.length : null,
  outOfBoundsCount: outOfBounds.length,
}]);
console.log("First five slots:");
console.table((battery?.series ?? []).slice(0, 5).map((slot) => ({
  timestamp: slot.timestamp,
  durationHours: slot.durationHours,
  solarKwh: slot.solarKwh,
  baselineHouseKwh: slot.baselineHouseKwh,
  socPct: slot.socPct,
  remainingEnergyKwh: slot.remainingEnergyKwh,
})));
console.log("Out-of-bounds slots:", outOfBounds);
```

#### Check battery forecast config

```js
const config = await getHelmanConfig();
console.log("battery forecast config:");
console.log(config?.power_devices?.battery?.forecast ?? null);
console.log(JSON.stringify(config?.power_devices?.battery?.forecast ?? null, null, 2));
```

### User validation checklist

- Backend:
  - `battery_capacity.startedAt` is close to the current time.
  - First slot is fractional.
  - SoC never drops below `minSoc` or rises above `maxSoc`.
  - `partial` appears if solar coverage ends.
- Frontend:
  - no frontend changes required

### Exit criteria

- Real battery simulation works correctly from current SoC.
- Cache is not added yet.

## Increment 4 — Battery forecast TTL cache and invalidation

### Goal

Add a lazy in-memory cache for `battery_capacity` so repeated requests within the TTL reuse the same result.

### Backend paths

- Repo root: `/home/ondra/dev/hass/hass-helman`
- Likely files:
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/coordinator.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/const.py`

### Frontend paths

- No required frontend code changes in this increment.

### Scope

- Cache only `battery_capacity`, not the full forecast payload.
- Add in-flight request deduplication if practical.
- Invalidate the battery forecast cache when:
  - config is saved
  - forecast is invalidated
  - house forecast refresh succeeds

### What should be testable after this increment

- Two close-together requests return the same `generatedAt`.
- A request after TTL expiration returns a new `generatedAt`.
- A request after explicit invalidation returns a new `generatedAt`.

### Browser console checks

#### Check cache reuse inside the TTL

```js
const first = await getHelmanForecast();
await new Promise((resolve) => setTimeout(resolve, 2000));
const second = await getHelmanForecast();

console.table([{
  firstGeneratedAt: first?.battery_capacity?.generatedAt ?? null,
  secondGeneratedAt: second?.battery_capacity?.generatedAt ?? null,
  sameGeneratedAt: first?.battery_capacity?.generatedAt === second?.battery_capacity?.generatedAt,
}]);
```

#### Optional: force invalidation by saving the current config again

```js
const conn = document.querySelector("home-assistant")?.hass?.connection;
const config = await getHelmanConfig();
await conn.sendMessagePromise({ type: "helman/save_config", config });
console.log("Saved current config to trigger forecast invalidation.");
```

After that, run:

```js
const forecast = await getHelmanForecast();
console.table([{
  generatedAt: forecast?.battery_capacity?.generatedAt ?? null,
  status: forecast?.battery_capacity?.status ?? null,
}]);
```

### User validation checklist

- Backend:
  - Two requests inside the TTL reuse the cached battery forecast.
  - After TTL expiration or invalidation, `generatedAt` changes.
  - Existing solar/grid/house forecast behavior still works.
- Frontend:
  - no frontend changes required

### Exit criteria

- Battery forecast caching behavior is visible and predictable.

## Increment 5 — Battery detail placeholder and status wiring

### Goal

Show the new battery forecast section in the battery detail without adding the full charting UI yet.

### Backend paths

- No required backend changes in this increment if Increment 4 is complete.

### Frontend paths

- Repo root: `/home/ondra/dev/hass/hass-helman-card`
- Likely files:
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/helman-battery-forecast-detail.ts` (new)
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/node-detail-battery-content.ts`
  - `/home/ondra/dev/hass/hass-helman-card/src/localize/translations/cs.json`

### Scope

- Add a battery forecast detail component.
- Load `battery_capacity` from the existing forecast websocket.
- Show status, no-data, partial, and unavailable states.
- Reorder the battery summary so SoC is clearly first and remaining energy second.
- Do **not** build the full daily/hourly forecast UI yet.

### What should be testable after this increment

- The battery detail dialog contains a forecast section.
- The section reflects backend status correctly.
- Existing battery detail content still works.

### Browser console check

```js
const battery = (await getHelmanForecast())?.battery_capacity ?? null;
console.table([{
  status: battery?.status ?? null,
  seriesLength: Array.isArray(battery?.series) ? battery.series.length : null,
  partialReason: battery?.partialReason ?? null,
}]);
console.log("battery_capacity:");
console.log(battery);
```

### User validation checklist

- Backend:
  - payload already verified in previous increments
- Frontend:
  - `npm run build-prod` succeeds
  - battery detail opens without errors
  - SoC is visually more prominent than remaining energy
  - forecast section text matches backend status

### Exit criteria

- Battery detail has a stable forecast section shell.

## Increment 6 — Daily SoC cards and summaries

### Goal

Add the daily summary layer for the battery forecast.

### Backend paths

- No required backend changes in this increment.

### Frontend paths

- Repo root: `/home/ondra/dev/hass/hass-helman-card`
- Likely files:
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/battery-capacity-forecast-detail-model.ts` (new)
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/helman-battery-forecast-detail.ts`
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/node-detail-shared-styles.ts`

### Scope

- Group the battery forecast into days.
- Show daily cards with:
  - end-of-day SoC
  - day min/max SoC
  - end-of-day remaining energy
- Preserve sparse/truncated data honestly; do **not** zero-pad unknown slots.
- Keep the detail chart out of scope for this increment.

### What should be testable after this increment

- Daily cards appear in the battery detail.
- Day-level SoC values match the websocket payload.
- Partial coverage is shown honestly when the series ends early.

### Browser console check

```js
const battery = (await getHelmanForecast())?.battery_capacity ?? null;
const endOfDay = [
  ...((battery?.series ?? []).reduce((map, slot) => {
    map.set(slot.timestamp.slice(0, 10), slot);
    return map;
  }, new Map())).entries()
].map(([day, slot]) => ({
  day,
  endSoc: slot.socPct,
  endEnergy: slot.remainingEnergyKwh,
}));

console.table(endOfDay);
```

### User validation checklist

- Frontend:
  - `npm run build-prod` succeeds
  - daily cards appear and expand/collapse cleanly
  - day summaries match the payload values
  - partial forecasts do not show fake zero-filled future data

### Exit criteria

- The battery forecast is useful at a day-summary level.

## Increment 7 — Hourly detail chart, polish, and docs closeout

### Goal

Finish the battery detail experience with hourly detail rendering and close out the docs for the implemented state.

### Backend paths

- Usually none, unless a small payload adjustment is discovered during FE wiring.

### Frontend paths

- Repo root: `/home/ondra/dev/hass/hass-helman-card`
- Likely files:
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/battery-capacity-forecast-chart-model.ts` (new)
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/helman-battery-forecast-detail.ts`
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/node-detail-shared-styles.ts`
  - `/home/ondra/dev/hass/hass-helman-card/src/localize/translations/cs.json`

### Docs paths

- `/home/ondra/dev/hass/hass-helman/docs/features/forecast/battery-capacity-forecast/README.md`
- `/home/ondra/dev/hass/hass-helman/docs/features/forecast/battery-capacity-forecast/implementation-progress.md`

### Scope

- Add the hourly detail panel.
- Render:
  - SoC trajectory as the primary chart
  - remaining energy as secondary context
  - charge/discharge movement
  - min/max SoC reference lines
  - partial-coverage note
- Update docs to describe the shipped behavior.

### What should be testable after this increment

- Expanding a day shows an hourly detail panel.
- The panel matches the websocket payload for the selected day.
- The docs now describe the implemented feature, not just the proposal.

### Browser console check

```js
const battery = (await getHelmanForecast())?.battery_capacity ?? null;
const firstDay = battery?.series?.[0]?.timestamp?.slice(0, 10);
const dayRows = (battery?.series ?? [])
  .filter((slot) => slot.timestamp.slice(0, 10) === firstDay)
  .map((slot) => ({
    timestamp: slot.timestamp,
    durationHours: slot.durationHours,
    socPct: slot.socPct,
    remainingEnergyKwh: slot.remainingEnergyKwh,
    chargedKwh: slot.chargedKwh,
    dischargedKwh: slot.dischargedKwh,
    importedFromGridKwh: slot.importedFromGridKwh,
    exportedToGridKwh: slot.exportedToGridKwh,
    hitMinSoc: slot.hitMinSoc,
    hitMaxSoc: slot.hitMaxSoc,
  }));

console.table(dayRows);
```

### User validation checklist

- Frontend:
  - `npm run build-prod` succeeds
  - hourly detail panel renders correctly
  - chart values align with the payload for the selected day
  - partial coverage is clearly explained
- Docs:
  - README is updated to current-state behavior
  - `implementation-progress.md` reflects the completed increments

### Exit criteria

- Battery forecast feature is complete for v1.
- Docs and progress file are updated for future maintenance.
