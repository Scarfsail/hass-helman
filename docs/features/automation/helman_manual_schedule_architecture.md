# Helman Manual Schedule - Backend Architecture

## References

- Exact DTOs and websocket schemas: [`helman_manual_schedule_dto_spec.md`](./helman_manual_schedule_dto_spec.md)

## Goal

This document proposes the first implementation slice for scheduling in `hass-helman`.

The scope is intentionally narrow:

- manual schedule only
- no automatic planning yet
- rolling next `48` hours
- `15` minute resolution
- one-off schedule only
- backend automatically executes scheduled actions
- execution can be globally enabled or disabled from the frontend

The real Home Assistant control example for this slice is:

- `input_select.rezim_fv`

with options:

- `Standardní`
- `Nucené nabíjení`
- `Nucené vybíjení`
- `Zákaz nabíjení`
- `Zákaz vybíjení`

## Locked v1 behavior

The agreed v1 action vocabulary is:

- `normal`
- `charge_to_target_soc`
- `discharge_to_target_soc`
- `stop_charging`
- `stop_discharging`

Additional v1 decisions:

- schedule horizon is the rolling next `48` hours
- scheduled actions are one-off only
- target-SoC behavior is included in v1
- current battery SoC should reuse the existing Helman battery entity config
- frontend will use one write API for one or more selected slots
- execution has a global on/off toggle exposed through websocket API

## Why this fits the current codebase

This repo already has the right basic shape for this feature:

- `storage.py` persists simple dict snapshots
- `websockets.py` exposes thin websocket commands
- `coordinator.py` already owns periodic background work
- `battery_state.py` already reads normalized battery live state from config

So the simplest backend shape is:

1. store schedule state in HA storage
2. expose schedule CRUD over websocket
3. run a small executor loop in the backend
4. use the configured `input_select` mapping to apply the effective action

## Naming recommendation

I recommend using:

- **schedule** for user-facing API and DTO names
- **`custom_components/helman/scheduling/`** for the code package

Why:

- `schedule` is the clearest noun for what the user edits and what FE renders
- `scheduler` sounds like only the timer/runner part
- `scheduling` is broad enough to contain:
  - schedule data and helpers
  - schedule execution
  - later automated scheduling logic

That gives us clean naming now without boxing us in later.

## Key design choice: keep the backend slot-native and the API minimal

After comparing a few architecture variants, the most practical v1 choice is:

- **source of truth** = sparse 15-minute slots keyed by slot start time
- **frontend view** = full 15-minute slot grid for the next `48` hours

Why this is the simplest first implementation:

- your product model is explicitly slot-based
- a single selected slot is naturally just one stored record
- partial overwrites become trivial
- setting a slot back to `normal` is just deleting that explicit slot from storage
- target-SoC early completion can suppress the remainder of a contiguous identical run without rewriting larger structures

If the frontend wants to display blocks instead of individual slots, it can group adjacent slots that have the same action and `targetSoc`.

## Proposed backend modules

Create a dedicated package:

```text
custom_components/helman/scheduling/
```

That keeps the scheduling code isolated from the existing forecast and tree-building modules, and gives us a natural home for future automated scheduling phases.

### 1. Extend `storage.py`

Add a dedicated persisted store for manual schedule state.

Keep using the current `Home Assistant` `Store` pattern.

Suggested new persisted object:

```json
{
  "executionEnabled": false,
  "slots": {
    "2026-03-20T21:00:00+01:00": {
      "kind": "charge_to_target_soc",
      "targetSoc": 80
    },
    "2026-03-20T21:15:00+01:00": {
      "kind": "charge_to_target_soc",
      "targetSoc": 80
    }
  }
}
```

Notes:

- `normal` does not need to be stored explicitly
- missing slot in storage means implicit `normal`
- executor runtime state can stay in memory in v1

### 2. Add `scheduling/schedule.py`

This module should own:

- slot alignment
- slot validation
- slot patch application
- validation rules
- helper functions for finding the effective action for `now`

Suggested responsibilities:

- generate the rolling quarter-hour slot grid
- convert selected slot IDs to canonical slot timestamps
- apply one write request to one or more slots
- materialize the full upcoming slot array with implicit `normal`
- prune slots that ended before `now`

### 3. Add `scheduling/schedule_executor.py`

This module should own runtime execution:

- reconcile the current time against the saved schedule
- apply the desired `input_select` option
- monitor target-SoC actions
- complete actions early when the target is reached
- react to execution toggle changes

### 4. Extend `coordinator.py`

The coordinator should remain the orchestrator.

Suggested new coordinator responsibilities:

- load the manual schedule snapshot from storage on startup
- start and stop the executor interval
- expose:
  - `get_schedule()`
  - `set_schedule()`
  - `set_schedule_execution()`
- invalidate and reload schedule-control config after `helman/save_config`

This fits the repo better than creating a second top-level runtime owner right away, while still keeping most of the new code inside the dedicated `scheduling/` package.

## Proposed config shape

The mode mapping belongs in config, not in the persisted schedule state.

Suggested direction:

```yaml
power_devices:
  battery:
    entities:
      capacity: sensor.battery_soc
      min_soc: sensor.battery_min_soc
      max_soc: sensor.battery_max_soc
      remaining_energy: sensor.battery_remaining_energy
scheduler:
  control:
    mode_entity_id: input_select.rezim_fv
    action_option_map:
      normal: Standardní
      charge_to_target_soc: Nucené nabíjení
      discharge_to_target_soc: Nucené vybíjení
      stop_charging: Zákaz nabíjení
      stop_discharging: Zákaz vybíjení
    execution_enabled_default: false
```

Notes:

- `mode_entity_id` is the single controlled entity for this slice
- target-SoC actions still use the same mapped mode option as long as the action is active
- actual SoC monitoring still comes from `power_devices.battery.entities`; the mode mapping lives under `scheduler.control`

## Domain model

### Scheduled slot

This should be the internal source-of-truth object.

Suggested fields:

- `slotId`
- `action.kind`
- `action.targetSoc` optional

This same shape should also be the API contract for `set_schedule`, with `slotId` exposed as `id`.

The slot grid itself should be the backend contract. If the frontend wants grouped blocks, it should derive them from adjacent slots with the same action and `targetSoc`.

## Action semantics

### `normal`

- set the configured mode entity to the mapped `normal` option
- if no explicit slot covers a slot, the effective default should also be `normal`

### `charge_to_target_soc`

- set the configured mode entity to the mapped charge option
- while the action is active, monitor current battery SoC
- if current SoC reaches or exceeds `targetSoc`, mark the logical action as completed early
- once completed early, clear the current slot and any immediately following adjacent slots with the same action and `targetSoc`
- after completion, fall back to `normal` unless another different active slot takes over

### `discharge_to_target_soc`

- set the configured mode entity to the mapped discharge option
- while the action is active, monitor current battery SoC
- if current SoC reaches or drops below `targetSoc`, mark the logical action as completed early
- once completed early, clear the current slot and any immediately following adjacent slots with the same action and `targetSoc`
- after completion, fall back to `normal` unless another different active slot takes over

### `stop_charging`

- set the configured mode entity to the mapped stop-charging option for the duration of the window

### `stop_discharging`

- set the configured mode entity to the mapped stop-discharging option for the duration of the window

## Validation rules

When automation slots are written, the backend should validate:

- all slot IDs are inside the current rolling `48h` horizon
- all slot IDs are aligned to `15` minute boundaries
- slot IDs are unique within the request
- `targetSoc` is required for:
  - `charge_to_target_soc`
  - `discharge_to_target_soc`
- `targetSoc` is forbidden for:
  - `normal`
  - `stop_charging`
  - `stop_discharging`
- `targetSoc` must be between the configured battery `min_soc` and `max_soc`
- control config must be present before execution can be enabled

## Write semantics

The backend should treat slots as fully independent.

When the frontend sends `set_schedule`:

1. resolve the selected slot IDs
2. for each provided slot:
   - if the action is `normal`, delete the explicit stored slot
   - otherwise store the provided action for that slot

That is all. No range splitting or backend grouping is needed.

## Execution loop

### Interval

Use a small independent interval, for example every `30` or `60` seconds.

The existing history tick should not own this logic.

### Loop behavior

On each pass:

1. prune expired slots
2. if execution is disabled:
   - ensure the effective mode is `normal`
   - do not enforce scheduled actions
3. find the currently active action for `now`
4. if there is no active action:
   - ensure the effective mode is `normal`
5. if there is an active action:
   - resolve the mapped HA option
   - apply it only when it differs from the currently desired Helman-managed state
   - for target-SoC actions, read the current battery live state and complete early when the target is reached

### Target-SoC completion

For v1, completion should be simple:

- `charge_to_target_soc`: complete when `current_soc >= targetSoc`
- `discharge_to_target_soc`: complete when `current_soc <= targetSoc`

Once completed:

- clear the current slot and any immediately following adjacent slots with the same action and `targetSoc`
- fall back to `normal` unless another active action applies

## Execution toggle semantics

Suggested v1 behavior:

- editing the schedule is always allowed
- execution can be toggled on or off independently
- turning execution off should immediately stop enforcement and return the controlled mode to `normal`
- turning execution on should immediately reconcile to the currently active action, if one exists

This is the safest and easiest behavior to explain in the UI.

## Websocket API

The current repo uses simple websocket commands. I would keep that style and add only three commands in v1.

### 1. `helman/get_schedule`

Purpose:

- return the rolling upcoming slot array
- return the execution toggle
- nothing more than FE needs

Request:

```json
{
  "id": 1,
  "type": "helman/get_schedule"
}
```

Response:

```json
{
  "executionEnabled": false,
  "slots": [
    {
      "id": "2026-03-20T21:00:00+01:00",
      "action": {
        "kind": "charge_to_target_soc",
        "targetSoc": 80
      }
    },
    {
      "id": "2026-03-20T21:15:00+01:00",
      "action": {
        "kind": "normal"
      }
    }
  ]
}
```

Rules:

- all upcoming slots inside the rolling `48h` horizon are always returned
- default action is always `normal`
- no labels are returned
- `targetSoc` is present only for actions that require it

### 2. `helman/set_schedule`

Purpose:

- set one or more slots explicitly
- one slot is just an array with one element
- setting `normal` means “clear back to implicit default”

Request:

```json
{
  "id": 2,
  "type": "helman/set_schedule",
  "slots": [
    {
      "id": "2026-03-20T21:00:00+01:00",
      "action": {
        "kind": "charge_to_target_soc",
        "targetSoc": 80
      }
    },
    {
      "id": "2026-03-20T21:15:00+01:00",
      "action": {
        "kind": "charge_to_target_soc",
        "targetSoc": 80
      }
    }
  ]
}
```

Response:

```json
{
  "success": true
}
```

Special case:

```json
{
  "type": "helman/set_schedule",
  "slots": [
    {
      "id": "2026-03-20T21:00:00+01:00",
      "action": {
        "kind": "normal"
      }
    }
  ]
}
```

This means:

- clear the explicit scheduled slot
- fall back to implicit `normal`

### 3. `helman/set_schedule_execution`

Purpose:

- enable or disable execution without changing the saved schedule

Request:

```json
{
  "id": 3,
  "type": "helman/set_schedule_execution",
  "enabled": true
}
```

Response:

```json
{
  "success": true,
  "executionEnabled": true
}
```

## Error handling

Keep it aligned with existing websocket style:

- `not_loaded` if Helman storage or coordinator is unavailable
- `invalid_slots` for:
  - empty slot array
  - duplicate slot IDs
  - malformed slot ID
  - slot outside horizon
- `invalid_action` for:
  - unknown action kind
  - missing target SoC
  - unexpected target SoC
- `not_configured` if the mode-control config is missing
- `execution_unavailable` if execution is enabled but required battery or mode entities are not usable

## Recommended vertical slices

### Slice 1 - Manual schedule persistence and read API

Deliver:

- config shape for mode entity and action mapping
- persisted sparse schedule slots
- slot materialization
- `helman/get_schedule`
- `helman/set_schedule`

This gives FE a real editable timeline quickly.

### Slice 2 - Execution toggle and non-target actions

Deliver:

- executor interval
- `helman/set_schedule_execution`
- execution of:
  - `normal`
  - `stop_charging`
  - `stop_discharging`

This validates the end-to-end backend execution path.

### Slice 3 - Target-SoC execution

Deliver:

- `charge_to_target_soc`
- `discharge_to_target_soc`
- early completion when target SoC is reached
- fallback-to-normal behavior

This finishes the agreed v1 action set.

## How this evolves later

This architecture should evolve cleanly into later automation:

- manual scheduled slots remain one source of truth
- automated planning can later generate the same slot shape or expand planner windows into slots
- the slot API can remain unchanged for FE
- the executor does not care whether a slot assignment came from the user or from a planner

That is the main reason to keep the backend source of truth as **typed sparse slot assignments** rather than only a transient UI grid.
