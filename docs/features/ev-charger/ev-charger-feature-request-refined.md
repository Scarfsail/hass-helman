# EV Charger Feature Request (Refined Draft)

## Status

Draft for requirements refinement. This document captures the currently preferred future-proof direction: EV charger support should be the **first appliance** added to a broader appliance architecture, not a one-off EV-only sidecar.

## Problem statement

Helman should support executable scheduling for appliances in a way that starts with an EV charger but scales naturally to future appliance types such as a pool heat pump and air conditioning.

The scheduler already has a clear top-level inverter concern. The next layer should therefore be an **appliances** concern that can hold one or more appliance-specific actions in each slot. EV charging is the first concrete appliance type that will use this model.

## Desired capabilities

### 1. Model appliances explicitly

- Keep `inverter` as a first-class top-level schedule concern.
- Add `appliances` as a sibling concern in the schedule and config.
- Let `appliances` contain multiple appliance instances over time, starting with an EV charger.

### 2. Configure EV charger and vehicles under appliances

- Support one charger appliance with direct HA control entities such as:
  - charge switch
  - use mode select
  - eco gear / current select
- Support one or more vehicles attached to that charger appliance.
- Each vehicle should have:
  - an explicit EV-specific `vehicleId`
  - a human-readable name
  - current SoC telemetry
  - optional charge-limit telemetry
  - manual battery capacity in kWh
  - manual max charging power in kW

### 3. Schedule appliance actions in the same slot as inverter actions

- A schedule slot should be able to contain both:
  - an inverter action
  - zero or more appliance actions
- For EV charging, slot-level control should support:
  - selected `vehicleId`
  - charge on / off
  - charger use mode
  - eco gear / amperage profile

### 4. Expose appliance state cleanly to frontend

- FE should not need raw config parsing to understand appliance capabilities.
- Backend should expose a dedicated appliance metadata DTO with:
  - appliance IDs, names, and kinds
  - configured control entities
  - schedule capabilities metadata
  - vehicle IDs, metadata, and telemetry entity IDs

### 5. Project expected appliance outcomes from the schedule

- FE should be able to show the current EV SoC and charge limit.
- FE should also be able to show the expected EV SoC when future slots schedule EV charging.
- The placement of this projected SoC data should be chosen so it still makes sense later for non-EV appliances.

## Clarified v1 product decisions

- V1 should **execute EV charging controls directly**, not only expose recommendations or state.
- V1 should optimize for a **future-proof appliance architecture**, because EV charging is only the first appliance type.
- The initial supported EV scope should be **one charger with multiple configured vehicles**, even though most real-world setups will usually have one EV.
- Each vehicle should have a **human-readable name** for FE display.
- Schedule slots should support **explicit vehicle selection by `vehicleId`**.
- Required slot-level EV controls in v1 are:
  - charge on / off
  - charger use mode
  - eco gear / amperage profile
- V1 does **not** currently require slot-level charge-limit writes or slot-level EV target SoC writes.
- It is acceptable for v1 to store **manual vehicle metadata** in config when entities do not provide it, including battery capacity in kWh and max charging power in kW.
- FE should receive appliance metadata through a **dedicated backend DTO / websocket surface**, not by reading raw config only.
- V1 should project expected EV SoC from scheduled charging.
- Core appliance-specific projection should land through a dedicated appliance projection surface first.
- A dedicated follow-up increment should then reflect scheduled appliance charging demand into existing `grid` and `battery_capacity` forecast products so aggregate system impact is visible.
- The EV-specific appliance contract may stay tailored to the current charger integration inside the EV charger appliance boundary. If future charger variants diverge, evolve that EV-specific layer before changing the generic `appliances` contract.

## Verified current codebase boundaries

- Runtime config is persisted through `helman/save_config` as a free-form dict in Home Assistant storage. There is no central schema validation today.
- The current schedule API is slot-native and strict: every slot has exactly one top-level `action` object shaped like `{ kind, targetSoc? }`.
- The current schedule executor can control only one `select` / `input_select` entity per applied action. It cannot currently toggle a switch, set a number, or fan out one slot into multiple coordinated entity writes.
- The current device tree DTO returned by `helman/get_device_tree` has no generic appliance capability metadata and is not the right contract for appliance control/state.
- `helman/get_forecast` currently returns `solar`, `house_consumption`, `grid`, and `battery_capacity`. There is no appliance projection branch today.
- Existing automation docs previously treated EV and appliance planning as recommendation-only; this request is explicitly asking for executable EV scheduling.

## Relevant backend touchpoints reviewed

- `custom_components/helman/storage.py`
- `custom_components/helman/websockets.py`
- `custom_components/helman/coordinator.py`
- `custom_components/helman/scheduling/schedule.py`
- `custom_components/helman/scheduling/schedule_executor.py`
- `custom_components/helman/tree_builder.py`
- `custom_components/helman/battery_state.py`
- `custom_components/helman/consumption_forecast_builder.py`

## Local Home Assistant snapshot used to ground the design

These values were read from the local Home Assistant instance during refinement.

### Charger controls observed

- `switch.ev_nabijeni`
  - current state: `off`
  - friendly name: `EV Nabíjení`
- `select.solax_ev_charger_charger_use_mode`
  - current state: `Stop`
  - options:
    - `Stop`
    - `Fast`
    - `ECO`
    - `Green`
- `select.solax_ev_charger_eco_gear`
  - current state: `6A`
  - options:
    - `6A`
    - `10A`
    - `16A`
    - `20A`
    - `25A`

### Vehicle telemetry observed

- `sensor.kona_ev_battery_level`
  - current state: `41`
  - unit: `%`
  - device class: `battery`
- `number.kona_ac_charging_limit`
  - current state: `90`
  - unit: `%`
  - min: `50`
  - max: `100`
  - step: `10`

These observed values make the following design assumptions more concrete:

- `slot_stop` is a runtime transition only. When an EV charging slot ends and the next slot has no EV action for that appliance, it means turning off the charge switch only. It does not imply resetting `use_mode` to `Stop` or `eco_gear` to `6A`.
- vehicle charge limit is naturally modeled as percentage-based telemetry/configuration, not as energy in kWh
- charger mode names and eco gear names should be preserved exactly as HA option strings in backend config and DTOs

## Selected architecture direction

The preferred direction is now:

- top-level schedule domains:
  - `inverter`
  - `appliances`
- `appliances` is an umbrella orchestration domain, not a claim that every appliance kind shares the same business behavior
- each configured appliance has an explicit stable `id`
- appliance-kind-specific handlers own config parsing, action validation, execution, projection policy, shared demand generation, and runtime-status mapping for that kind
- that appliance-kind boundary may be implemented as one class or as several focused collaborators, but the full concern stays inside the appliance-kind boundary rather than leaking into shared coordinator or forecast layers
- the first appliance type is `ev_charger`
- future appliance types may include `pool_heatpump`, `air_conditioning`, and others

This keeps the schedule future-proof without forcing every future appliance to become a top-level sibling domain, and it keeps the slot payload as small as possible.

Appliance-specific projection policy still lives in the appliance-kind handler even when it consumes contextual system inputs such as solar forecast and baseline house consumption. Those inputs inform the calculation, but they do not transfer ownership of EV charging policy to the forecast layer. The projection itself does not reason about battery discharge or grid import — those are downstream effects handled by the forecast recalculation after appliance demand is folded into the house consumption baseline.

## Identity model

- Every configured appliance has an explicit `id`.
- `helman/get_appliances`, schedule payloads, projections, and runtime status should all refer to appliances by that `id`.
- `helman/get_appliances.appliances` may stay ordered for presentation, but identity does not depend on array order.
- Every configured EV vehicle has an explicit `id` unique within that appliance.
- EV schedule payloads, EV metadata DTOs, and EV projection payloads should refer to vehicles by that `id`.
- Vehicle references stay EV-specific within EV action payloads via `vehicleId`; they are not part of the generic appliance identity model.
- In v1, `vehicleId` is part of the scheduled EV slot action context: it selects which configured vehicle metadata and charging limits apply to that slot's validation, execution context, and projection math.
- Vehicle arrays may stay ordered for presentation, but identity does not depend on array order.
- **Config changes require a Home Assistant restart and integration reload.** Stored config and active runtime config are therefore separate lifecycle stages.

## Proposed slot shape

Replace the current single-action slot model with:

```json
{
  "id": "2026-03-20T21:00:00+01:00",
  "domains": {
    "inverter": {
      "kind": "stop_charging"
    },
    "appliances": {
      "garage-ev": {
        "vehicleId": "kona",
        "charge": true,
        "useMode": "ECO",
        "ecoGear": "10A"
      }
    }
  }
}
```

### Why this shape

- `inverter` stays explicit and stable.
- `appliances` becomes the generic expansion point.
- Each appliance action is keyed by `applianceId`, so identity is explicit and independent from config order.
- The generic schedule layer only needs `applianceId -> action payload`; appliance-kind handlers validate the inner payload.
- Future pool heat pump and AC actions can fit under the same `appliances` object without another top-level schedule redesign.
- Redundant metadata such as appliance kind, appliance name, supported controls, and vehicle names lives in a dedicated metadata endpoint instead of every slot.

### Slot-action semantics

- `domains.appliances` is a sparse object keyed by `applianceId`.
- Omitted appliance IDs mean there is no explicit appliance action for that appliance in the slot.
- EV slot actions stay minimal and should not repeat appliance kind or appliance name.
- `charge = false` means the appliance should not charge in that slot; `useMode` and `ecoGear` should then be omitted.
- In v1, `charge = false` is the authored no-charge state. It is not modeled as scheduling `useMode = Stop`, and runtime `slot_stop` is a separate transition behavior.
- `charge = true` with `useMode = Fast` does not require `ecoGear`.
- `charge = true` with `useMode = ECO` requires `ecoGear`.

## Proposed config direction

Instead of a dedicated top-level `ev` branch, move to a top-level **`appliances`** config branch.

### Proposed shape

```yaml
appliances:
  - kind: ev_charger
    id: garage-ev
    name: Charger EV in Garage
    metadata:
      max_charging_power_kw: 11.0
    control:
      charge_entity_id: switch.ev_nabijeni
      use_mode_entity_id: select.solax_ev_charger_charger_use_mode
      eco_gear_entity_id: select.solax_ev_charger_eco_gear
    vehicles:
      - id: kona
        name: Kona
        telemetry:
          soc_entity_id: sensor.kona_ev_battery_level
          charge_limit_entity_id: number.kona_ac_charging_limit
        metadata:
          battery_capacity_kwh: 64.0
          max_charging_power_kw: 11.0
    projection:
      modes:
        Fast:
          behavior: fixed_power
        ECO:
          behavior: surplus_aware
          eco_gear_min_power_kw:
            6A: 1.4
            10A: 2.3
            16A: 3.7
            20A: 4.6
            25A: 5.8
```

### Notes on this config example

- The entity IDs are grounded in the live HA entities you provided.
- The option names `Stop`, `Fast`, `ECO`, `Green`, `6A`, `10A`, `16A`, `20A`, `25A` should be treated as exact HA-facing values.
- `charge_entity_id` / `charge` naming is intentionally aligned with the minimal slot payload.
- The live charger entity exposes `Stop`, but in v1 authored Helman no-charge intent is still represented by `charge = false` rather than scheduling `useMode = Stop`.
- The live charger entity exposes `Green`, but v1 should intentionally support only `Fast` and `ECO` in appliance scheduling and projection.
- `slot_stop` is runtime transition terminology in v1, not persisted appliance config. It applies only when an EV action ends and the next slot has no EV action for that appliance.
- `Fast` is the deterministic fixed-power projection mode and should use `min(appliance max_charging_power_kw, vehicle max_charging_power_kw)` as the effective charging power.
- `ECO` should be treated as a **surplus-aware** projection mode.
- In `ECO`, `eco_gear` selects an explicit configured minimum-power floor. If solar surplus is lower than that floor, the remainder is satisfied from battery discharge (if allowed and available) or imported from grid. Charging can still scale upward until the effective maximum is reached.
- Using an explicit `eco_gear_min_power_kw` map avoids baking charger phase / voltage assumptions into the backend projection logic.
- The `projection.modes` branch documents the supported authored modes and their mode-specific parameters. It is not intended to become a generic strategy DSL that lets runtime config redefine Helman's charging policy.
- The effective max charging power for any mode is always `min(appliance max_charging_power_kw, vehicle max_charging_power_kw)`.
- This EV-specific config surface may stay tailored to the current charger integration. If future charger variants need different config or command mapping, evolve that EV-specific layer without changing the generic `appliances` layer first.

## Proposed backend surfaces

### 1. `helman/get_appliances`

Recommended dedicated FE-facing metadata surface for:

- appliance list
- explicit appliance IDs, names, and kinds
- configured control entity IDs
- schedule capabilities metadata
- vehicle IDs and metadata
- vehicle telemetry entity IDs

Example direction:

```json
{
  "appliances": [
    {
      "id": "garage-ev",
      "name": "Charger EV in Garage",
      "kind": "ev_charger",
      "metadata": {
        "maxChargingPowerKw": 11.0,
        "scheduleCapabilities": {
          "chargeToggle": true,
          "useModes": ["Fast", "ECO"],
          "ecoGears": ["6A", "10A", "16A", "20A", "25A"],
          "requiresVehicleSelection": true
        }
      },
      "controls": {
        "charge": {
          "entityId": "switch.ev_nabijeni"
        },
        "useMode": {
          "entityId": "select.solax_ev_charger_charger_use_mode"
        },
        "ecoGear": {
          "entityId": "select.solax_ev_charger_eco_gear"
        }
      },
      "vehicles": [
        {
          "id": "kona",
          "name": "Kona",
          "telemetry": {
            "socEntityId": "sensor.kona_ev_battery_level",
            "chargeLimitEntityId": "number.kona_ac_charging_limit"
          },
          "metadata": {
            "batteryCapacityKwh": 64.0,
            "maxChargingPowerKw": 11.0
          }
        }
      ]
    }
  ]
}
```

FE is expected to read current values and current select options directly from Home Assistant state for the returned entity IDs, so this endpoint should stay mostly static and be read only occasionally. The `metadata.scheduleCapabilities` branch is the source of which Helman schedule/projection options are supported in v1; FE should not infer that only from raw HA option lists.

### 2. `helman/get_schedule` / `helman/set_schedule`

Updated composite slot DTO using:

- `domains.inverter`
- `domains.appliances` keyed by `applianceId`

If `helman/get_schedule` exposes runtime data, it should do so in a dedicated read-only `runtime` branch for the latest reconcile / active slot only. `helman/set_schedule` accepts authored schedule data only and must not accept runtime payloads.

### 3. `helman/get_appliance_projections`

Chosen dedicated surface for **derived future appliance outcomes**, including expected EV SoC.

Projection points may also expose `energyKwh` so FE and later aggregate forecast integration can explain the same simulated charging behavior without re-deriving energy demand from SoC deltas.

Example direction:

```json
{
  "generatedAt": "...",
  "appliances": {
    "garage-ev": {
      "vehicles": [
        {
          "id": "kona",
          "series": [ "... projected SoC and energy points ..." ]
        }
      ]
    }
  }
}
```

This surface should stay minimalistic. It should key appliance projections by `applianceId`, omit appliances without projection data, and only include projected points when scheduled charging actually produces a future EV state change. When points are present, they may carry both EV SoC progression and `energyKwh`.

### Why this placement was chosen

- Schedule stays the source of **authored intent**.
- `helman/get_appliances` stays the source of **appliance metadata and entity mapping**.
- `helman/get_appliance_projections` becomes the source of **derived future expectation**.
- This separation should age much better once Helman also needs to project pool temperature or AC behavior, not only EV SoC.
- A later forecast-integration increment may consume the same internal appliance demand model to update system-level `grid` and `battery_capacity` forecasts, but that does not change the role of `helman/get_appliance_projections` as the appliance-specific view.

### Projection object semantics

- `helman/get_appliance_projections.appliances` is keyed by `applianceId`.
- Omitted appliance IDs mean that appliance has no projection data.
- EV-specific `vehicles` content remains local to the EV charger projection shape, and each vehicle entry should expose explicit `id`.
- Projection series may stay sparse and include only slots where a scheduled action produces projected charging behavior.

### Rejected placements

- Do **not** persist projected SoC inside the slot action itself.
- Do **not** add projected appliance outcomes to the current baseline energy forecast family in v1.
- If FE later wants a small inline hint in `get_schedule`, it should be treated only as a read-only convenience echo of the projection endpoint, not as part of the authored schedule contract.

## Projection model direction

- `charge = false` should project no charging.
- `slot_stop` is a runtime transition behavior, not a separate authored projection mode.
- `Fast` should project a deterministic fixed-power charging profile at `min(appliance max, vehicle max)`.
- `ECO` should project EV charging demand using the formula: `min(effective_max_power, max(solar - baseline_house, eco_gear_min_power))`. The projection computes only EV `energyKwh` demand per slot; it does not reason about where shortfall energy comes from (battery discharge vs grid import) — that is a downstream concern handled by the forecast recalculation in Story 06.
- `ECO` charging can scale upward from the eco_gear floor until it reaches the effective max charging power (`min(appliance max, vehicle max)`).
- **Edge case**: when `effective_max_power < (solar - baseline_house)`, the EV cannot absorb all surplus and the remaining solar is available for battery charging. In typical residential setups this is rare, but the projection and forecast must handle it correctly.
- `Green` is intentionally excluded from v1 appliance scheduling and projection.
- If vehicle SoC telemetry is `unavailable` or `unknown` at projection time, the SoC projection for that vehicle is unknown/omitted. Vehicle SoC is optional and used only for FE display — no backend logic depends on it.

## ECO projection algorithm

The ECO projection consumes the same solar and house consumption baselines used by the battery forecast. The projection computes only EV demand per slot — it does not determine where shortfall energy comes from.

For each slot where ECO charging is active:

1. Compute `effective_max_power = min(appliance max_charging_power_kw, vehicle max_charging_power_kw)`.
2. Compute `ev_charging_power = min(effective_max_power, max(solar_kwh - baseline_house_kwh, eco_gear_min_power_kwh))`, where `baseline_house_kwh` means the **original house-consumption forecast before any projected appliance demand is added**.
3. Convert `ev_charging_power` to `energyKwh` for the slot duration.

The projection does not reason about battery discharge or grid import for the shortfall case. Those are downstream effects: when `ev_charging_power > (solar_kwh - baseline_house_kwh)`, the excess demand is automatically handled by the forecast recalculation (Story 06), which adds EV `energyKwh` to the house consumption baseline and re-runs the battery/grid simulation. The battery simulation's existing logic naturally resolves whether the shortfall comes from battery discharge or grid import based on inverter schedule constraints and battery availability.

**Edge case — EV cannot absorb all surplus**: when `effective_max_power < (solar_kwh - baseline_house_kwh)`, the EV charges at `effective_max_power` and the remaining surplus `(solar_kwh - baseline_house_kwh - effective_max_power)` is available for battery charging. This is handled naturally by the forecast recalculation since only the actual EV demand is added to the house baseline.

EV charging demand is effectively **additional house consumption** from the battery/grid forecast perspective. The appliance handler produces a per-slot `energyKwh` demand series, and that demand is reflected in the house consumption baseline used by the battery and grid forecast builders.

The important ownership boundary is that the appliance-kind handler still owns the EV-specific charging/projection policy and the resulting demand generation. The forecast layer supplies contextual inputs and later consumes the resulting `energyKwh` demand model; it does not take over EV charging policy.

## Locked projection -> forecast pipeline

The projection/forecast dependency chain is ordered, strictly one-directional, and generic across appliance kinds:

1. **Build the original forecast** exactly as today: solar forecast, original `baseline_house_kwh`, and the existing contextual battery / inverter inputs. This is the unmodified forecast with no appliance demand.
2. **Calculate all appliance projections** from that original, unmodified forecast. Each appliance-kind handler remains the owner of its own projection rules and returns generic `energyKwh` demand entries keyed by `applianceId` and `slotId`.
3. **Aggregate appliance demand**: sum `energyKwh` from all appliance demand producers by `slotId` and add the total to the original `baseline_house_kwh`.
4. **Recalculate the downstream battery/grid forecasts** from that adjusted house-consumption baseline.

**Critical loop prevention**: every recalculation of projection needs a fresh, unmodified forecast — never an already-adjusted one. The pipeline is strictly one-directional: steps 1 → 2 → 3 → 4. Appliance projections must not consume a house-consumption baseline that already includes projected appliance demand, otherwise they would see reduced remaining solar because of their own previously-added load and produce the wrong result. Downstream adjusted battery/grid forecast outputs must never be fed back into appliance projection inputs.

Both `helman/get_appliance_projections` and `helman/get_forecast` should share the same internal computation so this pipeline runs exactly once. The coordinator should orchestrate the full pipeline and serve both endpoints from the same computed result.

The battery/grid forecast layer is therefore strictly downstream. It consumes appliance demand but does not influence how that demand is first projected. EV is the first appliance-kind producer in v1, but the aggregation step is intentionally generic so future appliance kinds can join the same flow.

## Forecast integration model

EV charging demand from the projection is reflected in the system forecast by **adding it to the house consumption baseline** (Option A). This is the natural fit because EV charging is, from the grid/battery perspective, additional load on the system.

- Appliance-kind handlers produce a generic internal demand series containing only:
  - `applianceId`
  - `slotId`
  - `energyKwh`
- A shared aggregation step sums `energyKwh` from all appliance demand producers by `slotId` and adds that total to the **original** `baseline_house_kwh`.
- Battery/grid forecast builders are then re-run from the adjusted house-consumption baseline.
- This means the battery simulation automatically handles the downstream effects: reduced export, increased import, battery discharge behavior, and the interaction with inverter schedule constraints (e.g. stop_discharging).
- In the current forecast engine, this reuses the existing `_simulate_slot()` flow. The key architectural point is still that forecast integration consumes the shared `energyKwh` demand model instead of inventing a second one.
- When `effective_max_ev_power < (solar - baseline_house)`, the EV cannot absorb all surplus and the remaining solar is available for battery charging. This is handled naturally since only the actual EV demand is added to the baseline.
- The original house-consumption baseline remains the only valid baseline input for appliance projections. The adjusted house-consumption baseline is a downstream forecast-integration artifact only.
- Story 06 therefore consumes the demand model produced by the appliance projection logic. It does not re-derive or take ownership of EV-specific charging rules from Story 05.

## Projection and forecast time semantics

- `slotId` is the canonical time key for appliance demand and projection points.
- Projection and forecast values are interpreted as the full effect or resulting end-state of that slot unless explicitly stated otherwise.
- `energyKwh` is the canonical energy field across internal demand models and FE-facing projection DTOs.
- Power fields should not be part of the shared v1 contract; they may be derived later from `energyKwh` and slot duration if a concrete consumer needs them.

## Appliance projection caching

Appliance projections and the downstream aggregate battery/grid forecasts should share one dependency-aware cache lifecycle. Staged internal caches are acceptable, but invalidation and recomputation must preserve the locked pipeline above.

- If original forecast inputs change (TTL expiry, solar change, baseline house-consumption change, battery state change, inverter overlay inputs), invalidate appliance projections and all downstream adjusted battery/grid outputs.
- If any appliance schedule action changes, invalidate the affected appliance projections and all downstream adjusted battery/grid outputs.
- If appliance config changes, invalidate the whole projection/forecast pipeline after restart / reload.
- Changes in live vehicle SoC telemetry do **not** invalidate the projection/forecast cache in v1. SoC is display-oriented metadata and is intentionally outside the cache key even though cached projection payloads may include SoC-dependent fields.
- Downstream adjusted house/battery/grid forecast outputs must never be reused as inputs to appliance projection.

## Executor architecture direction

The existing `ScheduleExecutor` should be decomposed into a hierarchy:

- **`ScheduleExecutor`** — top-level orchestrator, triggered on the existing 30-second interval and when the active slot action changes
- **`InverterExecutor`** — handles inverter `select`/`input_select` entity control (existing logic, extracted)
  - **`AppliancesExecutor`** — iterates the active runtime appliance registry and delegates to appliance-kind handlers
    - **`EvChargerExecutor`** — handles EV charger entity control (switch + selects)
    - (future: `PoolHeatpumpExecutor`, etc.)

Each executor:
- Understands its own config section and its own part of the slot action
- Produces its own runtime status branch (so FE can show per-domain success/failure)
- Inverter and appliance execution are **independent** — one can succeed while the other fails
- Executors may be **parallelized** within a reconcile cycle
- Executes the current slot action for its appliance kind; the orchestrator is responsible for dispatch, not kind-specific behavior

**Lock scope**: the top-level `ScheduleExecutor` orchestrator acquires the schedule lock once per reconcile cycle. Both `InverterExecutor` and `AppliancesExecutor` run within that single lock acquisition — they do not acquire their own locks.

## Runtime status model

Runtime status is an **ephemeral execution read model**, not authored schedule data and not a mirror of live HA state. The new per-domain runtime status shape is part of the breaking DTO change in Story 01 — it replaces the existing flat runtime model.

- `get_schedule` may expose runtime status for the active slot / latest reconcile only, but only in a read-only branch
- runtime status reports what the executors attempted and what happened
- FE or other consumers should read live HA state separately from Home Assistant when they need current entity values
- `helman/set_schedule` accepts authored schedule data only and must not accept runtime payloads

Recommended generic runtime shape:

```json
{
  "activeSlotId": "2026-03-20T21:00:00+01:00",
  "reconciledAt": "...",
  "inverter": {
    "actionKind": "apply",
    "outcome": "success"
  },
  "appliances": {
    "garage-ev": {
      "actionKind": "slot_stop",
      "outcome": "success",
      "updatedAt": "..."
    }
  }
}
```

- `actionKind` values are `apply | slot_stop | noop`
- `outcome` values are `success | failed | skipped`
- appliance runtime entries are keyed by `applianceId`
- `slot_stop` is distinct from `noop`
- optional `errorCode` and `message` may be included for explicit failures

## Slot-stop and slot transition behavior

- When a slot becomes active and the current slot has an EV action defined, the executor applies that slot action for the appliance at the beginning of the slot / reconcile for that new active slot.
- When execution starts and the current slot has **no EV action defined**, the system does **nothing** for that appliance. It does not apply safe defaults proactively.
- When a slot **with an active EV charging action ends** and the next slot has **no EV action for that appliance**, the system:
  - Stops charging (`charge: false` / switch off)
  - Keeps `use_mode` where it was (does not reset)
  - Keeps `eco_gear` where it was (does not reset)
- If the next slot still contains an EV action for that appliance, the executor should treat it as the next normal apply/reconcile rather than as `slot_stop`.
- This transition behavior should be documented as **`slot_stop`**, not as a generic safe-default restoration.

## Manual override behavior

- If a user manually changes charger controls (mode, gear, switch) during execution, **nothing happens until the next slot transition**. The executor does not fight manual overrides mid-slot or re-assert the same slot action just because the periodic reconcile ran again inside that slot.
- `Green` mode is intentionally excluded from v1. If the charger is manually set to `Green`, the executor ignores it and will apply the next scheduled action at slot transition.

## Config lifecycle model

The appliance config has three distinct lifecycle stages:

1. **Stored config**
   - persisted by `helman/save_config`
2. **Validated active config**
   - loaded and validated during restart / integration reload
3. **Runtime appliance registry**
   - in-memory appliance handlers built from the validated active config

Runtime APIs such as `helman/get_appliances`, schedule execution, and projections operate on the active runtime registry, not directly on raw stored config.

If appliance config is changed through `helman/save_config`, that save updates stored config only. Restart / reload again before validating runtime APIs against the new appliance setup.

Each part of the application is responsible for loading its own config section. Appliances are optional — if the `appliances` config key is missing, the integration loads normally with no appliances active. Validation should happen per appliance during restart / integration reload. If one appliance config is invalid, log an explicit error describing what is wrong and ignore that appliance. The rest of the integration continues to function, since appliances are not a mandatory component. Only valid appliances should be added to the active runtime registry.

Ignored appliances are absent from `helman/get_appliances`, schedule validation/runtime behavior, execution, and projections until the config is fixed and reloaded.

## Intentional v1 boundaries

- Keep one global execution toggle in v1.
- Keep appliance-specific projections and system-level forecast integration as separate implementation stories.
- When aggregate forecast integration is added, it should update `grid` and `battery_capacity` forecasts from appliance demand without overloading `get_appliance_projections`.
- Do not add slot-level EV target SoC or slot-level charge-limit writes yet.
- Treat vehicle selection as schedule context and projection context using explicit `vehicleId`, not as an assumed charger-side HA control.
- EV-specific contracts may stay charger-tailored within the EV charger appliance boundary; if future charger variants diverge, evolve that EV-specific layer before changing the generic appliance layer.
- Treat appliances as explicit IDs across contracts; keep any EV-only vehicle references local to EV-specific payloads rather than the generic appliance layer.
- Do not overload `get_device_tree` with appliance capability/state data.
- **Config changes require a Home Assistant restart and integration reload.** No runtime config migration is needed.
- Charging error reporting is limited to execution status for v1. No notification or auto-disable escalation.

## Open implementation notes

The main architectural questions have been resolved:

- **ECO algorithm**: `min(effective_max_power, max(solar - baseline_house, eco_gear_min_power))`. Projection computes only EV demand; shortfall sourcing (battery discharge vs grid import) is a downstream forecast concern. See "ECO projection algorithm" section above.
- **Forecast integration**: EV demand is added to house consumption baseline (Option A). See "Forecast integration model" section above.
- **Executor decomposition**: ScheduleExecutor → InverterExecutor + AppliancesExecutor → EvChargerExecutor. See "Executor architecture direction" section above.
- **Caching**: Projection shares the battery forecast cache lifecycle. See "Appliance projection caching" section above.
- **Identity**: Appliance contracts use explicit `applianceId`; schedule/projection/runtime appliance collections are keyed by that ID. See "Identity model" and related sections above.
