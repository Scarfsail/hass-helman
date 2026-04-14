# Technical Proposal: Extra Energy Forecast Channel

## Status

Draft proposal updated with approved decisions:

- backend field: `availableSurplusKwh`
- expose publicly in `helman/get_forecast` v1
- no baseline comparison for the new field in v1
- semantics: reflect effective house/battery/prior-appliance effects, but stay independent from the final export-policy gate
- intended primary consumer: surplus-oriented automation optimizers
- lifecycle: recomputed after each optimizer from the current working schedule, so each later optimizer sees updated remaining available surplus for every slot

## Problem

Today the automation pipeline rebuilds the forecast snapshot after each optimizer. That is correct in principle because later optimizers should see the effects of earlier ones.

This proposal keeps that sequential model. `availableSurplusKwh` is intended to become the optimizer-facing input for surplus-oriented automation, and it should therefore be recalculated after every optimizer step from the latest working schedule. That means the value in each slot must always reflect the current combination of:

- manual actions already present in the schedule
- earlier automation actions written in the same run
- the resulting effective battery/house balance for that updated schedule

The issue is that `export_price` can write `stop_export`, and the forecast builder then sets `exportedToGridKwh` to `0.0` for those buckets. `surplus_appliance` currently treats `gridForecast.series[].exportedToGridKwh` as the available surplus signal, so later in the same run it concludes that no surplus remains and does not start the appliance.

This is a semantic mismatch:

- `exportedToGridKwh` means **what will actually be exported after inverter policy**
- `surplus_appliance` really needs **energy that remains after house load and battery behavior and could be redirected to either grid export or a surplus appliance**

Those are not the same thing when export is intentionally blocked.

## Current implementation seam

The current code already has a clean place to introduce a dedicated channel:

- `custom_components/helman/battery_capacity_forecast_builder.py`
  - `_simulate_slot(...)` computes the per-bucket energy balance
  - for positive net energy it currently calculates `exportedToGridKwh`
  - when `action_kind == stop_export`, it forces `exportedToGridKwh = 0.0`
- `custom_components/helman/grid_flow_forecast_builder.py`
  - projects selected fields from battery forecast series into the grid flow snapshot
- `custom_components/helman/grid_flow_forecast_response.py`
  - exposes the public `helman/get_forecast` grid series and preserves aggregation semantics
- `custom_components/helman/automation/optimizers/surplus_appliance.py`
  - reads `gridForecast.series[].exportedToGridKwh` as the available surplus signal

There is also an existing `baselineSeries` concept in the battery/grid forecast path, but it is **not** the right source for this feature. In the current implementation, baseline means "normal/empty schedule only" and strips all non-baseline actions, including charge/discharge controls. That makes it too broad for this use case because the new channel should still reflect effective battery behavior and any earlier appliance reservations; it should only be decoupled from the final export-policy write.

## Goal

Introduce a first-class per-bucket forecast channel that answers:

> How much energy remains after house consumption and effective battery behavior, and is therefore available to be either exported or consumed by a controllable surplus appliance?

This channel should stay visible even when `stop_export` blocks actual export.

It is intended to be the canonical optimizer input for surplus-oriented decisions: later surplus optimizers should consume `availableSurplusKwh`, not `exportedToGridKwh`.

## Recommended semantics

Working definition for each canonical forecast bucket:

- unit: `kWh`
- non-negative
- computed from the **effective** schedule-adjusted simulation, not from passive baseline
- reflects:
  - solar production
  - adjusted house forecast
  - effective battery charging/discharging behavior
  - earlier optimizer effects already materialized into the rebuilt schedule
  - earlier surplus-appliance reservations if they increase projected house demand
- does **not** collapse to zero merely because the inverter action forbids export

In other words:

- `exportedToGridKwh` = energy that will actually leave to grid
- `availableSurplusKwh` = energy that exists as excess local production after house/battery balancing, regardless of whether the inverter is currently allowed to export it

### Consequence under `stop_export`

For a bucket with positive net energy:

- if action is `normal`, new channel and `exportedToGridKwh` are equal
- if action is `stop_export`, `exportedToGridKwh` becomes `0.0`, but the new channel remains positive

This preserves the physical reality needed by `surplus_appliance` while keeping `exportedToGridKwh` truthful as an execution forecast.

## Proposed backend shape

### Internal battery forecast series

Add a new field to each simulated battery slot payload:

```json
{
  "timestamp": "2026-03-20T21:45:00+01:00",
  "durationHours": 0.25,
  "importedFromGridKwh": 0.0,
  "exportedToGridKwh": 0.0,
  "availableSurplusKwh": 0.18
}
```

Working formula inside `_simulate_slot(...)`:

```text
available_surplus_kwh =
  max(0.0, positive_net_energy_remaining_after_effective_battery_charge)
```

That means:

- compute it from the same intermediate value currently used to derive `exportedToGridKwh`
- do not zero it for `stop_export`
- keep `exportedToGridKwh` behavior unchanged

This is the least invasive change because the simulation already computes the exact intermediate quantity we need.

### Grid flow snapshot

Extend `build_grid_flow_forecast_snapshot(...)` so the new field is projected from battery forecast series into:

- `series`
- `baselineSeries`, if present and if we later decide baseline comparison should expose the same metric

Recommended v1 choice:

- expose the new field on effective `series`
- keep baseline support optional
- do not block the feature on adding baseline comparison for the new field

The optimizer bug is solved by the effective-series field alone.

### Public `helman/get_forecast` response

Expose the field on `grid.series[]`:

```json
{
  "grid": {
    "series": [
      {
        "timestamp": "2026-03-20T21:45:00+01:00",
        "durationHours": 0.25,
        "importedFromGridKwh": 0.0,
        "exportedToGridKwh": 0.0,
        "availableSurplusKwh": 0.18
      }
    ]
  }
}
```

Aggregation should sum it the same way `importedFromGridKwh` and `exportedToGridKwh` are summed today.

## Automation proposal

Update `surplus_appliance` to read the new channel instead of `exportedToGridKwh`.

Desired behavior:

- use `gridForecast.series[].availableSurplusKwh` as the "available redirectable surplus" input
- preserve the current sequential optimizer model
- preserve the current "remaining surplus after previous optimizer effects" principle
- stop coupling appliance-start logic to whether export is currently permitted

This keeps the optimizer pipeline coherent:

- `export_price` still affects the execution forecast
- `surplus_appliance` still sees earlier schedule effects
- but export policy no longer destroys visibility of usable local excess energy

## Why not use `baselineSeries`

Using baseline export as the new signal looks tempting because it already survives `stop_export`, but it would be semantically wrong.

Current baseline semantics intentionally remove all non-baseline schedule actions. That would also ignore:

- charge-to-target behavior
- discharge behavior
- stop-charging / stop-discharging actions
- any future non-baseline schedule effect that should legitimately change available excess energy

So `baselineSeries.exportedToGridKwh` is too disconnected from the real working schedule. The new channel should instead be computed in the effective simulation and only remain independent from the final export gate.

## FE implications

This repo does not currently contain the forecast-visualization frontend, but the websocket/public forecast contract is the right place to expose the channel.

Suggested FE interpretation:

- primary truth for actual export remains `exportedToGridKwh`
- `availableSurplusKwh` is "energy available to redirect"
- when `availableSurplusKwh > exportedToGridKwh`, the difference is energy that cannot be exported under the current inverter/export policy and is a good candidate for visualization or appliance scheduling

Possible FE presentations:

1. Additional line/bar in the grid forecast chart
2. Tooltip field on existing grid series points
3. "Blocked excess energy" derived indicator:

```text
blocked_excess_energy_kwh = max(0.0, availableSurplusKwh - exportedToGridKwh)
```

That derived value does not need to be a dedicated backend field in v1.

## Proposed implementation steps

### 1. Add the new field in battery forecast simulation

Files:

- `custom_components/helman/battery_capacity_forecast_builder.py`

Change:

- include the new field in `_make_simulated_slot_payload(...)`
- compute it in `_simulate_slot(...)`

### 2. Propagate it through grid flow forecast snapshots

Files:

- `custom_components/helman/grid_flow_forecast_builder.py`
- `custom_components/helman/grid_flow_forecast_response.py`
- `custom_components/helman/forecast_aggregation.py`

Changes:

- include the new field in projected grid flow series
- preserve it during `quarter_hour` / `half_hour` / `hour` aggregation
- expose it in public response points

### 3. Switch surplus appliance optimizer to the new channel

Files:

- `custom_components/helman/automation/optimizers/surplus_appliance.py`

Change:

- build the surplus map from the new field instead of `exportedToGridKwh`

### 4. Update tests

Files likely affected:

- `tests/test_battery_capacity_forecast_builder.py`
- `tests/test_grid_flow_forecast_builder.py`
- `tests/test_grid_flow_forecast_response.py`
- `tests/test_automation_optimizer_export_price.py`
- optimizer pipeline / surplus-appliance tests covering the sequential `export_price -> surplus_appliance` interaction

Critical test cases:

1. `normal` slot: new channel equals `exportedToGridKwh`
2. `stop_export` slot: `exportedToGridKwh == 0` but new channel stays positive
3. deficit slot: new channel is `0`
4. aggregated hourly grid response sums the new field correctly
5. `surplus_appliance` can start from the new channel even when `export_price` wrote `stop_export`
6. multiple surplus appliances still consume remaining surplus via sequential snapshot rebuilds

### 5. Update docs/contracts

Files likely affected:

- `docs/features/optimizers/helman_automation_optimizer_pipeline_architecture.md`
- `docs/features/battery_capacity_forecast/schedule_aware_battery_forecast_fe_contract.md` or a grid-forecast contract note

## Naming decision

Approved backend field:

- `availableSurplusKwh`

Recommended human-facing label:

- **Available surplus**
- FE/product copy may still describe the concept as "extra energy" when that reads better in UI

Reason for the chosen field name:

- it is explicit that this is an optimizer-usable availability signal
- it stays consistent with existing per-point energy-field naming by keeping the `Kwh` suffix
- it avoids tying the concept too tightly to export-only behavior even though export remains one consumer of the surplus

## Approved scope decisions

1. Public exposure: include `availableSurplusKwh` in `helman/get_forecast` v1
2. Baseline comparison: do **not** add baseline comparison for this field in v1
3. Semantics: keep the channel tied to the effective working schedule, except that export policy must not zero it out
