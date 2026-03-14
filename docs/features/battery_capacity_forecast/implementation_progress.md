# Battery Capacity Forecast — Implementation Progress

## References

- **Feature proposal**: [`README.md`](./README.md)
- **Implementation strategy**: [`implementation_strategy.md`](./implementation_strategy.md)
- **Backend repo**: `/home/ondra/dev/hass/hass-helman/custom_components/helman/`
- **Frontend repo**: `/home/ondra/dev/hass/hass-helman-card/src/`

## Current status

- Planning is complete.
- **Increment 1 is complete.**
- **Increment 2 is complete.**
- **Increment 3 is complete.**
- **Increment 3 is validated by the user in Home Assistant.**
- The next session should start with **Increment 4** from `implementation_strategy.md`.

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
| 4 | Battery forecast TTL cache and invalidation | BE | Planned | Add lazy 5-minute cache and invalidation |
| 5 | Battery detail placeholder and status wiring | FE | Planned | Add forecast section shell to battery detail |
| 6 | Daily SoC cards and summaries | FE | Planned | Add day grouping and SoC-first summaries |
| 7 | Hourly detail chart, polish, and docs closeout | FE + docs | Planned | Add detailed charting and update docs |

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

- **Status**: Planned
- **Backend planned paths**:
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/coordinator.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/const.py`
- **Frontend planned paths**:
  - none required
- **Implementation notes**:
  - _to be filled by future session_
- **Validation notes**:
  - _to be filled by future session_

## Increment 5 — Battery detail placeholder and status wiring

- **Status**: Planned
- **Backend planned paths**:
  - none required
- **Frontend planned paths**:
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/helman-battery-forecast-detail.ts`
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/node-detail-battery-content.ts`
  - `/home/ondra/dev/hass/hass-helman-card/src/localize/translations/cs.json`
- **Implementation notes**:
  - _to be filled by future session_
- **Validation notes**:
  - _to be filled by future session_

## Increment 6 — Daily SoC cards and summaries

- **Status**: Planned
- **Backend planned paths**:
  - none required
- **Frontend planned paths**:
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/battery-capacity-forecast-detail-model.ts`
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/helman-battery-forecast-detail.ts`
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/node-detail-shared-styles.ts`
- **Implementation notes**:
  - _to be filled by future session_
- **Validation notes**:
  - _to be filled by future session_

## Increment 7 — Hourly detail chart, polish, and docs closeout

- **Status**: Planned
- **Backend planned paths**:
  - only if small payload adjustments are needed
- **Frontend planned paths**:
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/battery-capacity-forecast-chart-model.ts`
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/helman-battery-forecast-detail.ts`
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-simple/node-detail/node-detail-shared-styles.ts`
  - `/home/ondra/dev/hass/hass-helman-card/src/localize/translations/cs.json`
- **Docs planned paths**:
  - `/home/ondra/dev/hass/hass-helman/docs/features/battery_capacity_forecast/README.md`
  - `/home/ondra/dev/hass/hass-helman/docs/features/battery_capacity_forecast/implementation_progress.md`
- **Implementation notes**:
  - _to be filled by future session_
- **Validation notes**:
  - _to be filled by future session_
