# Story 05 - Expose EV projections in backend API

Shared guide: [`../ev-charger-implementation-shared.md`](../ev-charger-implementation-shared.md)

Reference design: [`../ev-charger-feature-request-refined.md`](../ev-charger-feature-request-refined.md)

## User story

As a user, I can see projected EV charging outcomes from the authored schedule before those slots execute.

## Depends on

- Story 01
- Story 02
- Story 03

Story 04 is not a hard dependency for projection math, but it is still safer to land story 04 first unless you intentionally split work across multiple sessions in parallel.

## Scope

### In scope

- EV projection builder for `Fast` and `ECO`
- `helman/get_appliance_projections`
- Projection response fields for both EV SoC and `energyKwh`
- Sparse projection payload keyed by `applianceId`

### Out of scope

- Changing the baseline `helman/get_forecast` family in this story
- Non-EV appliance projections
- Pool/AC projections
- Any frontend changes

## Exact file touchpoints

### Backend

Create:

- `custom_components/helman/appliances/projection_builder.py`
- `custom_components/helman/appliances/projection_response.py`
- `tests/test_appliance_projection_builder.py`
- `tests/test_appliance_projection_response.py`

Modify:

- `custom_components/helman/appliances/config.py`
- `custom_components/helman/coordinator.py`
- `custom_components/helman/websockets.py`

## Implementation plan

1. Build an EV projection builder that consumes:
   - configured appliance metadata
   - selected vehicle metadata
   - authored schedule slots
   - `vehicleId` from the scheduled EV slot action so the builder uses the selected vehicle's metadata/capabilities for validation and effective max charging power
   - current SoC
   - `ecoGear -> min power` config map
   - solar forecast and the **original** house consumption forecast before appliance demand is folded back in (needed for ECO surplus calculation)

2. Keep projection ownership inside the EV appliance handler. It owns the EV-specific charging/projection policy and produces the shared internal demand series described in the shared guide, even though the calculation consumes contextual system inputs such as solar forecast, house consumption baseline, and inverter/battery constraints:
   - `applianceId`
   - `slotId`
   - `energyKwh`

3. Treat EV projection as an **upstream stage** of the later aggregate forecast pipeline. Story 05 must not consume a house-consumption baseline or battery/grid forecast output that already includes projected appliance demand, otherwise the EV demand would feed back into its own remaining-solar calculation.

4. Implement `Fast` projection as deterministic fixed power at `min(appliance max_charging_power_kw, vehicle max_charging_power_kw)`.

5. Implement `ECO` projection following the simplified algorithm from the refined spec:
   - Compute `ev_charging_power = min(effective_max_power, max(solar_kwh - baseline_house_kwh, eco_gear_min_power_kwh))`
   - Convert to `energyKwh` for the slot duration.
   - The projection computes only EV demand per slot. It does **not** reason about where shortfall energy comes from (battery discharge vs grid import) — that is a downstream concern handled by the forecast recalculation in Story 06.
   - **Edge case**: when `effective_max_power < (solar_kwh - baseline_house_kwh)`, the EV charges at `effective_max_power` and remaining surplus is available for battery charging.

6. Build the EV-specific projection DTO from that internal demand series plus EV-specific SoC data and explicit `vehicleId`.

7. Keep the response contract minimal:
   - appliance projections are keyed by `applianceId`
   - omit appliances with no projection data
   - keep point series sparse when there is no projected state change
   - expose explicit vehicle IDs inside EV-specific projection entries
   - expose `energyKwh` alongside EV-specific fields needed by Story 06

8. **SoC unavailability**: if vehicle SoC telemetry is `unavailable` or `unknown`, the SoC projection for that vehicle is unknown/omitted. Vehicle SoC is optional and used only for FE display — no backend logic depends on it. The `energyKwh` demand series is still produced regardless of SoC availability.

9. **Caching in Story 05**: keep projection cache behavior aligned with the final shared pipeline, but do not pull the full shared coordinator/cache orchestration from Story 06 into this story prematurely. In Story 05, cache invalidation should cover the projection's real upstream dependencies (forecast inputs, authored appliance schedule changes, and active config lifecycle) while still preserving the locked stage order. Live vehicle SoC changes do **not** invalidate the cache in v1.

10. Do not build frontend projection UI in this story.

### Projection response contract

The response should stay appliance-specific, but each projected point may include both EV SoC and `energyKwh`. Example direction:

```json
{
  "generatedAt": "...",
  "appliances": {
    "garage-ev": {
      "vehicles": [
        {
          "id": "kona",
          "series": [
            {
              "slotId": "...",
              "socPct": 58,
              "energyKwh": 1.75,
              "mode": "Fast"
            }
          ]
        }
      ]
    }
  }
}
```

## Acceptance criteria

- `helman/get_appliance_projections` returns sparse projection data keyed by `applianceId`.
- `Fast` projection uses `min(appliance max, vehicle max)` as effective power.
- `ECO` projection uses the formula `min(effective_max_power, max(solar - baseline_house, eco_gear_min_power))` and produces only EV demand — it does not reason about shortfall sourcing.
- `ECO` projection uses the original house-consumption baseline as its input and does not read a baseline already adjusted by projected appliance demand.
- When `effective_max_power < (solar - baseline_house)`, the EV charges at `effective_max_power` (remaining surplus is left for downstream battery/grid forecast).
- When vehicle SoC telemetry is unavailable, the SoC projection is unknown/omitted but the `energyKwh` demand series is still produced.
- EV projection entries expose explicit vehicle IDs.
- Projection points expose `energyKwh` alongside EV SoC progression.
- The EV projection builder also produces the shared internal `applianceId` + `slotId` + `energyKwh` demand series used by Story 06.
- Story 05 keeps projection invalidation aligned with the final pipeline inputs, but the shared one-pass pipeline/cache orchestration is finalized in Story 06.
- Live vehicle SoC changes do not invalidate the cache in v1.
- Aggregate effects on `helman/get_forecast` are intentionally left for Story 06, which consumes the shared demand series rather than re-deriving EV charging policy.

## Automated validation

### Backend unit tests

- `python3 -m unittest -v tests.test_appliance_projection_builder tests.test_appliance_projection_response`

## Websocket validation

Before running websocket tests, ask the user to restart local Home Assistant so backend code changes are loaded.

Then validate with the local-hass-api skill:

1. Save appliance config with explicit `ecoGear -> min power` mapping and explicit vehicle IDs.
2. Restart / reload local Home Assistant so the saved appliance config becomes active.
3. Save a schedule containing `Fast` and `ECO` EV actions using explicit `vehicleId`.
4. Call `helman/get_appliance_projections`.
5. Confirm:
   - appliance projections are keyed by `applianceId`
   - EV projection entries expose explicit vehicle IDs
   - appliances without projection data are omitted
   - only scheduled charging paths produce projection points
   - projection points expose the expected `energyKwh` fields

## Manual UI sign-off

No.
