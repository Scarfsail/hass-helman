# EV / Appliances Architecture Summary

> Visual summary of the EV/appliances design already captured in this folder. Source of truth remains `ev-charger-feature-request-refined.md`, `ev-charger-implementation-shared.md`, and `stories/story-01` through `stories/story-06`.

## Core contract

- `appliances` is an umbrella schedule domain beside `inverter`.
- Runtime, schedule, and projection appliance collections are keyed by `applianceId`; EV actions additionally carry `vehicleId`.
- The shared cross-layer demand model is `applianceId + slotId + energyKwh`.

## 1. Config and runtime lifecycle

```mermaid
flowchart LR
    Save["helman/save_config"] --> Stored["Stored config"]
    Stored --> Reload["HA restart / integration reload"]
    Reload --> Validate{"Per-appliance validation"}
    Validate -->|valid| Active["Validated active config"]
    Active --> Registry["Runtime appliance registry<br/>kind-specific handlers"]
    Validate -->|invalid| Ignored["Log explicit error<br/>ignore appliance"]

    Registry --> Metadata["get_appliances"]
    Registry --> Schedule["schedule validation"]
    Registry --> Execution["execution"]
    Registry --> Projection["projection"]
```

Runtime APIs operate on the runtime registry, not on raw stored config.

## 2. Action triggering and execution

```mermaid
sequenceDiagram
    participant Trigger as Scheduler tick / active-slot change
    participant SE as ScheduleExecutor
    participant IE as InverterExecutor
    participant AE as AppliancesExecutor
    participant EV as EvChargerExecutor
    participant HA as Home Assistant
    participant RT as Runtime status

    Trigger->>SE: reconcile()
    Note over SE: Acquire schedule lock once

    par Inverter branch
        SE->>IE: execute inverter action
        IE-->>RT: inverter outcome
    and Appliance branch
        SE->>AE: execute appliance actions
        AE->>EV: delegate EV action

        alt EV action exists in active slot
            EV->>HA: apply charge / useMode / ecoGear
            EV-->>RT: actionKind=apply
        else Previous EV action ended and next slot has none
            EV->>HA: turn off charge switch only
            EV-->>RT: actionKind=slot_stop
        else No EV action for appliance
            EV-->>RT: actionKind=noop
        end
    end
```

Manual overrides are left alone until the next slot transition or an active-slot action change.

## 3. Projection flow

```mermaid
flowchart LR
    Schedule["Authored schedule"] --> Handler["EV appliance handler<br/>owns validation and projection policy"]
    Registry["Runtime appliance registry"] --> Handler
    Meta["Appliance and vehicle metadata<br/>ecoGear -> min power"] --> Handler
    Solar["Solar forecast"] --> Handler
    Base["Original baseline_house_kwh"] --> Handler
    Soc["Current SoC (optional)"] --> Handler

    Handler --> Demand["Shared demand series<br/>applianceId + slotId + energyKwh"]
    Handler --> EVView["EV projection series<br/>vehicleId + socPct? + energyKwh"]
    EVView --> ProjectionApi["get_appliance_projections"]
```

- `Fast`: `min(appliance max, vehicle max)`
- `ECO`: `min(effective_max_power, max(solar - baseline_house, eco_gear_min_power))`
- Missing SoC telemetry omits SoC projection, but still keeps `energyKwh`

## 4. Forecast integration pipeline

```mermaid
flowchart TD
    Step1["Step 1: Build original forecast inputs<br/>solar + original baseline_house_kwh + battery/inverter context"]
    Step2["Step 2: Calculate appliance projections<br/>from unmodified inputs"]
    Step3["Step 3: Aggregate appliance demand<br/>sum energyKwh by slotId"]
    Step4["Step 4: Adjust house baseline<br/>original baseline + appliance demand"]
    Step5["Step 5: Re-run downstream forecast<br/>battery + grid outputs"]

    Step1 --> Step2 --> Step3 --> Step4 --> Step5
    Step2 --> ProjectionApi["get_appliance_projections"]
    Step5 --> ForecastApi["get_forecast"]

    NoLoop["Never feed adjusted outputs back into appliance projection"] -.-> Step2
```

- Appliance demand is treated as additional house consumption.
- Forecast integration consumes only generic `energyKwh`; EV policy stays inside the EV handler.
- `get_appliance_projections` and `get_forecast` share the same one-pass computation and cache lifecycle.
- Live vehicle SoC changes do not invalidate the v1 projection/forecast cache.

## Locked invariants

- `charge = false` is authored schedule intent; `slot_stop` is runtime-only transition behavior.
- `slot_stop` turns off charging only; it keeps `useMode` and `ecoGear` unchanged.
- `slotId` is the canonical time key and `energyKwh` is the canonical shared energy field.
- The projection -> forecast pipeline is one-way and generic across appliance kinds.
