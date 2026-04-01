# Story 04 - Execute EV schedule actions in backend

Shared guide: [`../ev-charger-implementation-shared.md`](../ev-charger-implementation-shared.md)

Reference design: [`../ev-charger-feature-request-refined.md`](../ev-charger-feature-request-refined.md)

## User story

As a user, when schedule execution is enabled, the active EV slot should apply real charger control entities in Home Assistant and expose runtime outcomes back to FE.

## Depends on

- Story 01
- Story 02
- Story 03

## Scope

### In scope

- Decompose `ScheduleExecutor` into `InverterExecutor` + `AppliancesExecutor` → `EvChargerExecutor`
- Real EV control execution for:
  - charge switch
  - use mode select
  - eco gear select
- Slot transition behavior: stop charging when an EV action slot ends and the next slot has no EV action for that appliance (keep use_mode and eco_gear as-is)
- Per-domain runtime status: inverter and EV charger report independent success/failure
- Inverter and EV execution are independent and may be parallelized

### Out of scope

- Projection math
- Any frontend changes

## Exact file touchpoints

### Backend

Create:

- `custom_components/helman/appliances/execution.py`
- `tests/test_appliance_executor.py`

Modify:

- `custom_components/helman/appliances/config.py`
- `custom_components/helman/scheduling/runtime_status.py`
- `custom_components/helman/scheduling/schedule_executor.py`
- `custom_components/helman/coordinator.py`
- `tests/test_schedule_executor.py`
- `tests/test_coordinator_schedule_execution.py`

## Implementation plan

1. **Decompose `ScheduleExecutor`** into a hierarchy:
   - Extract existing inverter logic into `InverterExecutor`
   - Create `AppliancesExecutor` that iterates configured appliances and delegates to type-specific executors
   - Create `EvChargerExecutor` that handles EV charger entity control
   - `ScheduleExecutor` becomes the top-level orchestrator that triggers both branches and also reconciles when the current active-slot action changes

2. Add deterministic service application for EV actions in `EvChargerExecutor`:
   - when a slot becomes active and contains an EV action for that appliance, apply that slot action at the beginning of the slot / reconcile for the new active slot
   - write `charge` switch
   - set `useMode`
   - set `ecoGear` when relevant

3. **`slot_stop` transition behavior**:
   - When a slot with an active EV charging action transitions to a next slot without EV action for that same appliance: **stop charging only** (turn off the charge switch). Keep `use_mode` and `eco_gear` where they are.
   - When execution starts and no EV action exists in the current slot: **do nothing** for the EV charger.
   - When the next slot still contains an EV action for that appliance, treat it as the next normal apply/reconcile rather than `slot_stop`.

4. **Per-domain runtime status**: the per-domain runtime shape is already established in Story 01 (with only `inverter` populated). This story populates the `appliances` runtime entries keyed by `applianceId`. `slot_stop` must be distinguishable from `noop`, and any `get_schedule` runtime branch remains read-only.

5. **Parallelization**: inverter and appliance execution are independent. They may be parallelized within a reconcile cycle. The top-level `ScheduleExecutor` orchestrator acquires the schedule lock once per reconcile; inverter execution and each appliance execution run in parallel within that single lock acquisition.

6. **Manual override rule**: if a user manually changes charger controls mid-slot, the executor does not fight that override during periodic reconciles inside the same slot. The next scheduled write happens at slot transition or when the active-slot action itself changes.

7. Keep failures explicit per executor:
   - unavailable entity
   - unsupported option
   - failed service call

8. Do not build frontend runtime UI in this story.

## Acceptance criteria

- `ScheduleExecutor` is decomposed into `InverterExecutor` + `AppliancesExecutor` → `EvChargerExecutor`.
- Enabling schedule execution applies the active EV slot to the real HA charger entities.
- When a slot becomes active and contains an EV action, that action is applied at the beginning of the slot.
- Changing the current active-slot EV action triggers a fresh reconcile without waiting for the next normal scheduler tick.
- When a slot with EV charging transitions to a next slot without EV action for that appliance: only the charge switch is turned off; `use_mode` and `eco_gear` are kept as-is.
- When no EV action exists in the current slot at execution start: the EV charger is not touched.
- Manual charger changes made mid-slot are left alone until the next slot transition or an active-slot schedule change.
- Inverter and EV execution produce independent runtime status entries using the shared `actionKind` / `outcome` contract.
- Execution failures in one domain do not block the other domain.
- Execution failures are visible in the read-only `get_schedule` runtime payload with per-domain granularity.

## Automated validation

### Backend unit tests

- `python3 -m unittest -v tests.test_appliance_executor tests.test_schedule_executor tests.test_coordinator_schedule_execution`

## Websocket validation

Before running websocket tests, ask the user to restart local Home Assistant so backend code changes are loaded.

Then validate with the local-hass-api skill:

1. Save the EV appliance config.
2. Restart / reload local Home Assistant so the saved appliance config becomes active.
3. Set a schedule where the current slot should execute EV charging.
4. Enable execution with `helman/set_schedule_execution`.
5. Confirm via HA state reads that:
   - `switch.ev_nabijeni`
   - `select.solax_ev_charger_charger_use_mode`
   - `select.solax_ev_charger_eco_gear`
   moved to the expected values.
6. Update the currently active slot action and confirm the executor reconciles immediately to the new state.
7. Call `helman/get_schedule` and confirm the current slot runtime branch is populated as read-only data.

## Manual UI sign-off

No.
