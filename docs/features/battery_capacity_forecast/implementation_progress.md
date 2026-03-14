# Battery Capacity Forecast — Implementation Progress

## References

- **Feature proposal**: [`README.md`](./README.md)
- **Implementation strategy**: [`implementation_strategy.md`](./implementation_strategy.md)
- **Backend repo**: `/home/ondra/dev/hass/hass-helman/custom_components/helman/`
- **Frontend repo**: `/home/ondra/dev/hass/hass-helman-card/src/`

## Current status

- Planning is complete.
- **Increment 1 is complete.**
- The next session should start with **Increment 2** from `implementation_strategy.md`.

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
| 2 | House current-hour support | BE + FE | Planned | Add `house_consumption.currentHour` for the fractional first slot |
| 3 | Battery simulation core from now | BE | Planned | Live calculation, no TTL cache yet |
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

- **Status**: Planned
- **Backend planned paths**:
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/consumption_forecast_builder.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/coordinator.py`
- **Frontend planned paths**:
  - `/home/ondra/dev/hass/hass-helman-card/src/helman-api.ts`
- **Implementation notes**:
  - _to be filled by future session_
- **Validation notes**:
  - _to be filled by future session_

## Increment 3 — Battery simulation core from now

- **Status**: Planned
- **Backend planned paths**:
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/battery_state.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/battery_capacity_forecast_builder.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/coordinator.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/const.py`
- **Frontend planned paths**:
  - none required
- **Implementation notes**:
  - _to be filled by future session_
- **Validation notes**:
  - _to be filled by future session_

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
