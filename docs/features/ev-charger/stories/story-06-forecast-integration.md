# Story 06 - Reflect appliance demand in backend forecasts

Shared guide: [`../ev-charger-implementation-shared.md`](../ev-charger-implementation-shared.md)

Reference design: [`../ev-charger-feature-request-refined.md`](../ev-charger-feature-request-refined.md)

## User story

As a user, I can see how planned appliance charging changes system battery and grid import/export forecasts, not only the appliance-specific EV SoC projection.

## Depends on

- Story 02
- Story 04
- Story 05

## Scope

### In scope

- Reflect appliance charging demand into system-level forecast simulation
- Update `helman/get_forecast` battery and grid outputs to account for scheduled appliance demand
- Keep the aggregate forecast-integration pipeline generic across all appliance demand producers, even though EV is the only producer implemented in this story
- Respect the interaction between:
  - solar forecast
  - appliance charging demand
  - battery charge/discharge behavior
  - inverter schedule constraints such as stop discharging
- EV is the first appliance-kind demand producer in this story

### Out of scope

- Mutating `helman/get_appliance_projections` into a system forecast endpoint
- Adding pool/AC forecast integration
- Reworking the baseline `house_consumption` contract unless it becomes strictly necessary for consistency
- Any frontend changes

## Exact file touchpoints

### Backend

Create:

- `custom_components/helman/appliances/forecast_integration.py`
- `tests/test_appliance_forecast_integration.py`

Modify:

- `custom_components/helman/coordinator.py`
- `custom_components/helman/battery_capacity_forecast_builder.py`
- `custom_components/helman/grid_flow_forecast_builder.py`
- `tests/test_battery_capacity_forecast_builder.py`
- `tests/test_grid_flow_forecast_builder.py`
- `tests/test_coordinator_battery_forecast_cache.py`

## Implementation plan

1. Keep `helman/get_appliance_projections` as the appliance-specific source of EV SoC expectation and `energyKwh` visibility.

2. Reuse the same internal appliance demand model from the shared guide (`applianceId`, `slotId`, `energyKwh`) instead of re-deriving demand from SoC deltas.

3. Treat Story 06 as a consumer of the shared demand model, not the owner of EV charging policy. The EV appliance handler / projection logic from Story 05 remains responsible for EV-specific charging rules and demand generation; forecast integration only consumes that result.

4. Follow the locked projection/forecast pipeline:
   - calculate the original forecast inputs exactly as today, including the original `baseline_house_kwh` without projected appliance demand
   - ask all appliance demand producers in the active runtime registry to calculate their appliance-specific projections/demand from those original inputs
   - aggregate all appliance `energyKwh` by `slotId` and add the total to the original `baseline_house_kwh`
   - rerun the downstream battery/grid forecast builders from that adjusted house-consumption baseline

5. **Add appliance `energyKwh` demand to the house consumption baseline** (`baseline_house_kwh`) only in the dedicated aggregation step above. This is the agreed integration model for the current forecast engine: appliance demand is additional house load from the battery/grid forecast perspective, so the existing simulation path is reused instead of introducing a second demand model. The public `house_consumption` response is the appliance-adjusted read model.

6. **Do not pass appliance actions into the forecast layer.** The downstream battery/grid simulation should continue to consume the existing inverter schedule overlay/constraints exactly as it does today. Appliance influence enters the forecast only through the aggregated generic `energyKwh` demand added to `baseline_house_kwh`.

7. The forecast-integration layer should:
   - Read the per-slot `energyKwh` values from all appliance demand producers
   - Aggregate them by `slotId`
   - Add them to the corresponding original `baseline_house_kwh` values before the downstream battery/grid simulation runs
   - Keep inverter schedule constraints wired exactly through the existing forecast path; appliance scheduling data is **not** added to the overlay/read model consumed by forecast builders
   - The increased `baseline_house_kwh` naturally reduces surplus available for battery charging. **Edge case**: when `effective_max_ev_power < (solar - baseline_house)`, the EV cannot absorb all surplus and remaining solar is available for battery charging — this is handled naturally since only actual EV demand is added to the baseline.

8. The aggregate-demand step must stay generic. Story 06 should not hardcode EV-specific aggregation logic; it should iterate appliance demand producers so future appliance kinds can join the same flow without changing the pipeline order.

9. Respect inverter schedule constraints already modeled by schedule overlay logic. Example target behavior:
   - EV charging demand in a slot first consumes available solar
   - remaining demand is satisfied by battery discharge if allowed and available
   - if battery discharge is blocked or insufficient, the remainder is imported from grid

10. Update aggregate forecast outputs so FE can see the changed:
    - battery trajectory
    - imported-from-grid
    - exported-to-grid

11. **Caching and shared orchestration**: Story 06 is where the final one-pass shared pipeline is consolidated. The aggregate battery/grid forecast cache is downstream of the appliance projection stage. Shared cache lifecycle is fine, but invalidation and recomputation must preserve the ordered flow above. Downstream adjusted battery/grid outputs must never be reused as inputs to appliance projection. `get_appliance_projections` and `get_forecast` should share the same internal computation in the coordinator so the pipeline runs exactly once. Live vehicle SoC changes do **not** invalidate this cache in v1. During active target-SOC slots, cache reuse is still allowed when the effective schedule signature and compatible live battery state still match.
12. When schedule execution is disabled, authored appliance schedule actions are ignored by both `helman/get_appliance_projections` and `helman/get_forecast` in v1.

13. Do not build frontend forecast-impact UI in this story.

## Acceptance criteria

- `helman/get_forecast` battery and grid outputs change when scheduled appliance charging changes system energy flows.
- Appliance `energyKwh` demand is reflected by adding it to `baseline_house_kwh` as the current forecast-engine integration path, keeping one shared demand model.
- The aggregate forecast follows the locked order: original baseline forecast inputs -> appliance projections/demand -> aggregate appliance demand into house consumption -> downstream battery/grid recalculation.
- Appliance projections are calculated from the original house-consumption baseline, not from a house-consumption baseline already adjusted by projected appliance demand.
- `helman/get_forecast.house_consumption` is the appliance-adjusted house forecast read model.
- When `house_consumption.nonDeferrable` exposes `lower` / `upper`, those bands shift together with `value` after appliance demand is applied so the adjusted response remains internally consistent.
- The forecast layer consumes generic appliance `energyKwh` demand only; it does **not** read appliance actions or require appliance schedule data in `ScheduleForecastOverlay`.
- Battery charging from solar is reduced in slots where EV charging is active (naturally, since EV demand consumes surplus). When `effective_max_ev_power < surplus`, remaining solar is available for battery charging.
- The aggregate forecast respects solar availability, battery availability, and inverter schedule constraints.
- Forecast integration aggregates demand generically across all appliance demand producers in the runtime registry; EV is simply the first implemented producer.
- Appliance-specific EV SoC projection remains available through `helman/get_appliance_projections`.
- Story 06 uses the same `energyKwh` semantics already exposed by Story 05 rather than inventing a second demand model or taking ownership of EV-specific charging policy.
- Cache invalidation/recomputation preserves the same upstream-to-downstream dependency chain.
- `get_appliance_projections` and `get_forecast` share the same internal computation — the pipeline runs exactly once per cache cycle.
- When schedule execution is disabled, authored appliance schedule actions do not affect projections or aggregate forecast outputs in v1.

## Automated validation

### Backend unit tests

- `python3 -m unittest -v tests.test_appliance_forecast_integration tests.test_battery_capacity_forecast_builder tests.test_grid_flow_forecast_builder tests.test_coordinator_battery_forecast_cache`

## Websocket validation

Before running websocket tests, ask the user to restart local Home Assistant so backend code changes are loaded.

Then validate with the local-hass-api skill:

1. Save appliance config with EV charger + vehicle metadata.
2. Restart / reload local Home Assistant so the saved appliance config becomes active.
3. Save a schedule that creates meaningful appliance charging demand.
4. Call `helman/get_appliance_projections` to confirm EV-specific projection exists.
5. Call `helman/get_forecast`.
6. Confirm that aggregate battery/grid outputs now reflect the scheduled appliance demand:
   - reduced export when EV consumes solar
   - battery discharge when allowed
   - grid import when battery discharge is blocked or insufficient

## Manual UI sign-off

No.
