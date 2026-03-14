# Battery Capacity Forecast — Implementation Progress

## References

- **Feature proposal**: [`README.md`](./README.md)
- **Implementation strategy**: [`implementation_strategy.md`](./implementation_strategy.md)
- **Backend repo**: `/home/ondra/dev/hass/hass-helman/custom_components/helman/`
- **Frontend repo**: `/home/ondra/dev/hass/hass-helman-card/src/`

## Current status

- Planning is complete.
- **Increments 1-7 are complete.**
- **Increment 3 is validated by the user in Home Assistant.**
- **Increment 4 is validated by the user in Home Assistant.**
- **Increment 5 is validated by the user in Home Assistant.**
- **Increment 6 is validated by the user in Home Assistant.**
- **Increment 7 completes the v1 feature in code and is awaiting manual Home Assistant validation.**
- The next session should start with **manual validation of Increment 7** in Home Assistant; after the user validates it, the feature can be considered fully closed out.

## Rules for future sessions

When continuing this work in a new session:

1. Read `README.md`, `implementation_strategy.md`, and this file.
2. Implement **exactly one increment**.
3. Update this file before ending the session.
4. Stop for user validation before moving to the next increment.
5. When reporting validation, provide the user with exact manual testing steps, paste-ready browser-console snippets for websocket checks when relevant, and a clear list of expected results to verify.

## Increment status

| Increment | Name | Repos | Status | Notes |
|-----------|------|-------|--------|-------|
| 1 | Shared contract and safe scaffolding | BE + FE | Complete | Added backend placeholder payload and frontend DTO/config typing with no visible UI |
| 2 | House current-hour support | BE + FE | Complete | Added `house_consumption.currentHour` plus cache compatibility so the current-hour entry stays trustworthy |
| 3 | Battery simulation core from now | BE | Complete | Added live battery simulation from now with a fractional first slot and honest partial solar coverage |
| 4 | Battery forecast TTL cache and invalidation | BE | Complete | Added lazy 5-minute cache/invalidation and user validated the TTL behavior in Home Assistant |
| 5 | Battery detail placeholder and status wiring | FE | Complete | Added a SoC-first battery summary plus a visible forecast shell with backend status wiring |
| 6 | Daily SoC cards and summaries | FE | Complete | Grouped the battery forecast by day and added expandable SoC-first daily summary cards with honest partial-day labeling |
| 7 | Hourly detail chart, polish, and docs closeout | FE + docs | Complete | Added the hourly battery detail panel, polished shared chart styling, and updated the feature docs to the current implemented v1 state |

## Increment 1 — Shared contract and safe scaffolding

- **Status**: Complete
- **Backend planned paths**:
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/coordinator.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/const.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/battery_capacity_forecast_builder.py`
- **Frontend planned paths**:
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-api.ts`
  - `/home/ondra/dev/hass/hass-helman-card/src/helman/DeviceConfig.ts`
- **Implementation notes**:
  - Added a dedicated backend `BatteryCapacityForecastBuilder` that returns the full `battery_capacity` payload shape with an empty `series` and `not_configured` status.
  - Wired `battery_capacity` into `HelmanCoordinator.get_forecast()` as a new sibling section alongside the existing forecast payload sections.
  - Added battery forecast constants for the shared horizon and default charge/discharge efficiencies.
  - Extended frontend shared API types with `BatteryCapacityForecastDTO` and `BatteryCapacityForecastHourDTO`.
  - Extended frontend battery device config typing with an optional `forecast` block.
  - Kept the battery detail UI untouched so this increment remains contract-only with no visible rendering change.
- **Validation notes**:
  - Frontend baseline and post-change `npm run build-prod` succeeded in `/home/ondra/dev/hass/hass-helman-card`.
  - `python3 -m py_compile` succeeded for the touched backend files in `/home/ondra/dev/hass/hass-helman/custom_components/helman/`.
  - Backend repo does not currently expose an existing automated test/build command in the workspace; manual Home Assistant websocket validation is still recommended using the Increment 1 browser-console check from `implementation_strategy.md`.

## Increment 2 — House current-hour support

- **Status**: Complete
- **Backend planned paths**:
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/consumption_forecast_builder.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/coordinator.py`
- **Frontend planned paths**:
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-api.ts`
- **Implementation notes**:
  - Added a shared backend helper inside `ConsumptionForecastBuilder` so one hourly house forecast item can be built for any local datetime using the same shape as `series[]`.
  - Extended the available `house_consumption` payload with an optional `currentHour` entry stamped to the start of the current local hour.
  - Kept the existing `series` generation unchanged so the current house forecast UI contract stays backward-compatible.
  - Tightened `HelmanCoordinator` cached snapshot compatibility so an `available` snapshot is only reused when it already contains a valid `currentHour` for the current local hour.
  - Switched the house forecast refresh schedule to top-of-hour refreshes so cached `currentHour` data does not drift into the previous hour after the clock rolls over.
  - Extended the frontend shared `HouseConsumptionForecastDTO` typing with optional `currentHour` support and left the existing UI untouched.
- **Validation notes**:
  - Frontend baseline and post-change `npm run build-prod` succeeded in `/home/ondra/dev/hass/hass-helman-card`.
  - Backend baseline and post-change `python3 -m py_compile` succeeded for the touched files in `/home/ondra/dev/hass/hass-helman/custom_components/helman/`.
  - Backend repo does not currently expose an existing automated test/build command in the workspace; manual Home Assistant websocket validation is still required after reloading the custom component.
  - Use the Increment 2 browser-console check from `implementation_strategy.md` and confirm that `house_consumption.currentHour` exists, has the same shape as a normal house forecast item, and its `timestamp` belongs to the current local hour.

## Increment 3 — Battery simulation core from now

- **Status**: Complete
- **Backend planned paths**:
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/battery_state.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/battery_capacity_forecast_builder.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/coordinator.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/const.py`
- **Frontend planned paths**:
  - none required
- **Implementation notes**:
  - Added a dedicated backend `battery_state.py` helper that normalizes required battery entity IDs, battery forecast settings, live battery state, and remaining-energy units for the simulation path.
  - Switched the coordinator ETA calculations to use the same shared battery-state helper so ETA sensors and the new forecast follow one consistent interpretation of battery entities and units.
  - Replaced the placeholder `BatteryCapacityForecastBuilder` with a live request-time simulation that starts at `now`, emits a fractional first slot, and keeps the existing 168-slot horizon contract.
  - Wired the battery builder to consume the already-built `solar` and `house_consumption` payload sections from `HelmanCoordinator.get_forecast()` so the battery forecast reuses the same request snapshot as the rest of the forecast response.
  - Used `house_consumption.currentHour.nonDeferrable.value` for the fractional first slot and filtered later house input by timestamp so prepended past hours in `house_consumption.series` do not corrupt future battery slots.
  - Added a backend battery forecast model ID constant and filled the live payload with current battery metadata, simulated slot details, import/export figures, and charge/discharge power-limit flags.
  - Kept Increment 3 cache-free as planned; the battery forecast is recalculated on every request and still stops honestly with `status: "partial"` when required solar coverage ends.
- **Validation notes**:
  - Baseline and post-change `python3 -m py_compile custom_components/helman/*.py` succeeded in `/home/ondra/dev/hass/hass-helman`.
  - A local stubbed Python smoke test exercised the new builder in both `available` and `partial` scenarios because the Home Assistant Python package is not installed in this workspace.
  - Manual Home Assistant validation succeeded after deploying `/home/ondra/dev/hass/hass-helman/custom_components/helman/`, reloading the custom component, and adding the missing battery forecast power limits with `max_charge_power_w = 10000` and `max_discharge_power_w = 10000`.
  - Use the Increment 3 browser-console helpers and checks from `implementation_strategy.md`, then verify:
    - `battery_capacity.startedAt` is close to the current time.
    - `battery_capacity.series[0].durationHours` is greater than `0` and less than or equal to `1`.
    - `battery_capacity.series` contains 168 slots when solar coverage is available for the full horizon.
    - no simulated slot SoC drops below `minSoc` or rises above `maxSoc`.
    - `battery_capacity.status` switches to `partial` with truncated series coverage when required solar hours are missing.
  - The user verified the original Increment 3 request end-to-end and confirmed the runtime behavior matched expectations.

## Increment 4 — Battery forecast TTL cache and invalidation

- **Status**: Complete
- **Backend planned paths**:
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/coordinator.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/const.py`
- **Frontend planned paths**:
  - none required
- **Implementation notes**:
  - Added a dedicated backend TTL constant for the battery forecast cache and kept the cache strictly in-memory inside `HelmanCoordinator`.
  - Switched `HelmanCoordinator.get_forecast()` to reuse a cached `battery_capacity` payload for up to five minutes when the current request can safely rely on the compatible cached house forecast snapshot.
  - Added a shared in-flight battery forecast task so overlapping websocket requests can await one battery build instead of triggering parallel recalculations.
  - Invalidated the battery forecast cache when the house forecast is explicitly invalidated, when a fresh house forecast snapshot is accepted, and when the cached house snapshot is no longer compatible with the current local hour.
  - Kept transient fallback states honest by caching only simulated `available` payloads and non-empty `partial` payloads; `unavailable`-style responses still rebuild immediately on the next request.
  - Tightened the TTL implementation after runtime validation so cache expiry is checked at actual lookup time and uses a monotonic clock instead of wall-clock datetimes.
  - Added a fallback expiry guard based on the cached payload's own `generatedAt` timestamp plus debug logging for battery cache hit/store/expire events to aid runtime verification.
- **Validation notes**:
  - Baseline and post-change `python3 -m py_compile custom_components/helman/*.py` succeeded in `/home/ondra/dev/hass/hass-helman`.
  - Backend repo still does not expose an existing automated test suite in the workspace, so manual Home Assistant websocket validation is still required after deploying the updated custom component and reloading the integration.
  - Use the Increment 4 browser-console helpers and checks from `implementation_strategy.md`, then verify:
    - two close-together requests inside the TTL reuse the same `battery_capacity.generatedAt`
    - a request after TTL expiration returns a newer `battery_capacity.generatedAt`
    - saving the current config again invalidates the battery cache so the next request returns a newer `battery_capacity.generatedAt`
    - existing `solar`, `grid`, and `house_consumption` sections still return as expected alongside the cached battery payload
  - The user redeployed the updated backend, restarted Home Assistant, and confirmed the final TTL behavior end-to-end: repeated requests within the TTL reuse `battery_capacity.generatedAt`, and requests after the TTL now return a newer timestamp.

## Increment 5 — Battery detail placeholder and status wiring

- **Status**: Complete
- **Backend planned paths**:
  - none required
- **Frontend planned paths**:
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/helman-battery-forecast-detail.ts`
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/node-detail-battery-content.ts`
  - `/home/ondra/dev/hass/hass-helman-card/src/localize/translations/cs.json`
- **Implementation notes**:
  - Added a dedicated frontend `helman-battery-forecast-detail` component that loads the existing `battery_capacity` payload through the shared forecast websocket helper and refreshes on the shared 5-minute cadence.
  - Wired the new forecast section into `node-detail-battery-content.ts` so battery detail now matches the existing "detail shell + forecast child component" composition used by the other node detail dialogs.
  - Reworked the battery summary to make SoC the primary battery metric and keep remaining energy as a secondary detail row while preserving the existing battery producer/consumer device cards and more-info links.
  - Added Czech battery forecast localization for section labels, localized status names, placeholder copy, and human-readable partial-coverage messaging.
- **Validation notes**:
  - Baseline and post-change `npm run build-prod` succeeded in `/home/ondra/dev/hass/hass-helman-card`.
  - Manual Home Assistant validation is still required after redeploying `/home/ondra/dev/hass/hass-helman-card/dist/helman-card-prod.js` (or your normal card build artifact path) and reloading the dashboard.
  - Use the Increment 5 browser-console check from `implementation_strategy.md`, then confirm:
    - the battery detail dialog opens without frontend errors
    - SoC is shown before remaining energy and is visually more prominent
    - the new battery forecast section is visible and its localized status text matches the current backend `battery_capacity.status`
    - partial payloads show a partial note and coverage timestamp when the backend provides `coverageUntil`
    - daily cards and hourly charts are still absent in this increment
  - The user visually validated Increment 5 in Home Assistant and confirmed the new battery detail layout matched expectations for this increment.
  - The screenshot still showed raw `node_detail.battery_forecast.*` keys, but the committed source JSON and built `dist/helman-card-prod.js` both contain the Czech translations; if those raw keys still appear after deployment, hard-refresh the browser/Home Assistant frontend to flush the cached card bundle.

## Increment 6 — Daily SoC cards and summaries

- **Status**: Complete
- **Backend planned paths**:
  - none required
- **Frontend planned paths**:
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/battery-capacity-forecast-detail-model.ts`
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/helman-battery-forecast-detail.ts`
  - `/home/ondra/dev/hass/hass-helman-card/src/localize/translations/cs.json`
- **Implementation notes**:
  - Added a dedicated frontend `battery-capacity-forecast-detail-model.ts` that groups `battery_capacity.series` into local-day buckets and derives end-of-day/last-covered SoC, min/max SoC, ending energy, and honest per-day coverage metadata without zero-padding missing future slots.
  - Reworked `helman-battery-forecast-detail.ts` to replace the placeholder copy with selectable day cards plus a selected-day summary panel that keeps SoC as the primary metric and uses explicit "last" labeling when the final day ends before day-end coverage.
  - Reused the existing shared forecast card and detail-panel layout so battery detail now matches the other node detail forecast sections while keeping the hourly detail panel out of scope for Increment 6 and explicitly deferred to Increment 7.
  - Included the forecast start SoC in the day-summary min/max calculation so the first partial day does not under-report the real SoC range.
  - Added Czech localization keys for the new battery day-summary labels while reusing the existing shared forecast card/panel classes unchanged.
- **Validation notes**:
  - Baseline and post-change `npm run build-prod` succeeded in `/home/ondra/dev/hass/hass-helman-card`.
  - Manual Home Assistant validation is still required after redeploying `/home/ondra/dev/hass/hass-helman-card/dist/helman-card-prod.js` (or your normal card build artifact path) and reloading the dashboard.
  - Use the Increment 6 browser-console check from `implementation_strategy.md`, then confirm:
    - daily cards appear in the battery detail and selecting a card opens/closes the summary panel cleanly
    - the visible day summaries match the websocket payload for `endSoc`, `min/max SoC`, and ending energy
    - the last partial day uses honest "last" labeling instead of pretending the value is the end of the day
    - truncated forecasts do not render fake zero-filled future slots or extra future days beyond `coverageUntil`

## Increment 7 — Hourly detail chart, polish, and docs closeout

- **Status**: Complete
- **Backend planned paths**:
  - only if small payload adjustments are needed
- **Frontend planned paths**:
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/battery-capacity-forecast-chart-model.ts`
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/battery-capacity-forecast-detail-model.ts`
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/helman-battery-forecast-detail.ts`
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/node-detail-shared-styles.ts`
  - `/home/ondra/dev/hass/hass-helman-card/src/localize/translations/cs.json`
- **Docs planned paths**:
  - `/home/ondra/dev/hass/hass-helman/docs/features/battery_capacity_forecast/README.md`
  - `/home/ondra/dev/hass/hass-helman/docs/features/battery_capacity_forecast/implementation_progress.md`
- **Implementation notes**:
  - Added a dedicated frontend `battery-capacity-forecast-chart-model.ts` that shapes one selected day into hourly chart columns with sparse time labels, SoC step positions, remaining-energy bars, charge/discharge movement bars, and min/max SoC reference offsets.
  - Extended `battery-capacity-forecast-detail-model.ts` to keep each day's starting SoC and remaining energy so the hourly detail panel can render the first intra-day transition honestly instead of pretending the day started at the first slot endpoint.
  - Reworked `helman-battery-forecast-detail.ts` so selecting a day now opens a real hourly detail panel with a SoC-first step chart, remaining-energy context row, charge/discharge movement row, in-panel partial-coverage note, richer slot tooltips, and smooth scrolling to the expanded panel.
  - Added shared battery-chart styling in `node-detail-shared-styles.ts` and Czech localization keys for the hourly panel labels and slot metadata.
  - Updated `README.md` to describe the current implemented v1 behavior instead of only the earlier proposal state.
- **Validation notes**:
  - Baseline and post-change `npm run build-prod` succeeded in `/home/ondra/dev/hass/hass-helman-card`.
  - Increment 7 did not require backend changes, so no backend validation command was needed in this session.
  - Manual Home Assistant validation is still required after redeploying `/home/ondra/dev/hass/hass-helman-card/dist/helman-card-prod.js` (or your normal card build artifact path) and reloading the dashboard.
  - Use the Increment 7 browser-console check from `implementation_strategy.md`, then confirm:
    - expanding a battery day card opens an hourly detail panel below the day cards
    - the visible SoC trajectory, remaining-energy row, and charge/discharge row match the websocket payload for the selected day
    - the min/max SoC guide lines line up with the configured battery limits shown in the summary values
    - partial final days show an in-panel partial note plus `coverageUntil` instead of pretending the forecast covers the full day
    - `README.md` and this progress file now describe the completed v1 feature state
