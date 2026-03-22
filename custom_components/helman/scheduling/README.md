# Helman Scheduling

This package currently implements the **manual schedule backend** for Helman.

It is ready to be consumed by a frontend or other internal clients that need to:

- read the rolling schedule grid
- patch one or more slots
- enable or disable execution
- show what is **scheduled** for the current slot
- show what is **actually being executed** right now

## Current status

Implemented today:

- rolling `48` hour horizon
- slot resolution controlled by `SCHEDULE_SLOT_MINUTES` in `custom_components/helman/const.py`
- sparse persisted storage with materialized `normal` slots in responses
- websocket API:
  - `helman/get_schedule`
  - `helman/set_schedule`
  - `helman/set_schedule_execution`
- live execution of the current slot through the configured mode entity
- target-SoC actions resolved against live battery state
- active-slot runtime metadata in `helman/get_schedule`
- persisted schedule documents are treated as a fresh setup if their saved slot duration no longer matches the configured slot duration
- unit coverage and live smoke validation against a running Home Assistant instance

Not implemented yet:

- automatic planning / schedule generation
- websocket subscriptions or push updates for schedule changes
- persisted runtime history
- frontend-specific grouping, labels, or block abstractions

## Slot duration configuration

The only slot-duration setting is `SCHEDULE_SLOT_MINUTES` in `custom_components/helman/const.py`.

Technical constraint:

- `SCHEDULE_SLOT_MINUTES` must be a positive divisor of `60`

Persistence behavior:

- persisted schedule documents store the slot duration that was active when they were written
- if the configured slot duration changes later, persisted schedule data is reset on startup and treated as a fresh setup

## Consumer-facing model

The schedule is intentionally slot-native.

- horizon: next `48` hours
- slot size: configured by `SCHEDULE_SLOT_MINUTES` in `custom_components/helman/const.py`
- response grid size: derived from the `48` hour horizon and the configured slot size
- slot id: timezone-aware ISO 8601 timestamp representing the slot start
- missing persisted slot = implicit `normal`

Important frontend rule:

- `action` is the **requested scheduled action**
- `runtime` is the **actual executor outcome for the current slot only**

The backend never mutates the saved schedule just because a target has already been reached. For example, a slot can remain scheduled as `charge_to_target_soc(70)` while runtime says the executor actually applied `stop_discharging`.

## Supported action kinds

The current action vocabulary is:

- `normal`
- `charge_to_target_soc`
- `discharge_to_target_soc`
- `stop_charging`
- `stop_discharging`

### Action semantics

| Action kind | `targetSoc` | Effective execution behavior |
| --- | --- | --- |
| `normal` | not allowed | Applies the configured normal mode |
| `charge_to_target_soc` | required | If live SoC is below target, executes charge mode; otherwise executes `stop_discharging` |
| `discharge_to_target_soc` | required | If live SoC is above target, executes discharge mode; otherwise executes `stop_charging` |
| `stop_charging` | not allowed | Applies the configured stop-charging mode |
| `stop_discharging` | not allowed | Applies the configured stop-discharging mode |

Target actions are evaluated **independently per active slot**. There is no carry-over hold state across future slots.

## Runtime metadata

`runtime` may appear only on the **current slot** in `helman/get_schedule`.

It is present only when:

- schedule execution is enabled, and
- the executor has an execution status for the same current slot id

It is omitted:

- from all non-current slots
- from all slots when execution is disabled

### Runtime payload

```json
{
  "status": "applied",
  "executedAction": {
    "kind": "stop_discharging"
  },
  "reason": "target_soc_reached"
}
```

Current runtime fields:

- `status`
  - `applied`
  - `error`
- `executedAction`
  - optional
  - same action shape as normal schedule actions
- `reason`
  - optional
  - `scheduled`
  - `target_soc_reached`
- `errorCode`
  - optional
  - machine-readable schedule error code

### Important UI interpretation

Use both `action` and `runtime` together:

- `action` tells the user what the slot is configured to do
- `runtime.executedAction` tells the user what the executor actually applied right now

That distinction matters most for target actions.

## Websocket API

The current public schedule commands live in `custom_components/helman/websockets.py`.

### `helman/get_schedule`

Request:

```json
{
  "type": "helman/get_schedule"
}
```

Response shape:

```json
{
  "executionEnabled": true,
  "slots": [
    {
      "id": "2026-03-20T21:00:00+01:00",
      "action": {
        "kind": "charge_to_target_soc",
        "targetSoc": 70
      },
      "runtime": {
        "status": "applied",
        "executedAction": {
          "kind": "stop_discharging"
        },
        "reason": "target_soc_reached"
      }
    },
    {
      "id": "2026-03-20T22:00:00+01:00",
      "action": {
        "kind": "normal"
      }
    }
  ]
}
```

Behavior:

- always returns the full rolling `48` hour grid
- materializes missing stored slots as `normal`
- attaches `runtime` only to the current slot when applicable
- uses the executor's last real execution status instead of recomputing optimistically on read

### `helman/set_schedule`

Request:

```json
{
  "type": "helman/set_schedule",
  "slots": [
    {
      "id": "2026-03-20T21:00:00+01:00",
      "action": {
        "kind": "charge_to_target_soc",
        "targetSoc": 80
      }
    }
  ]
}
```

Success response:

```json
{
  "success": true
}
```

Behavior:

- patches one or more slots in a single request
- setting a slot to `normal` removes that slot from persisted storage
- leaves all other slots unchanged
- when execution is enabled and the schedule document changes, triggers a safe reconcile in the background

Frontend note:

- `set_schedule` does not return the updated materialized grid
- if the UI needs fresh slot or runtime data after a write, call `helman/get_schedule` again

### `helman/set_schedule_execution`

Request:

```json
{
  "type": "helman/set_schedule_execution",
  "enabled": true
}
```

Success response:

```json
{
  "success": true,
  "executionEnabled": true
}
```

Behavior when enabling:

- persists `executionEnabled = true`
- starts the executor
- immediately reconciles the current slot
- if the initial reconcile fails, the backend rolls the flag back to `false` and returns an error

Behavior when disabling:

- stops the executor
- attempts to restore `normal` mode immediately
- only then persists `executionEnabled = false`
- if restoring normal mode fails, the backend keeps execution enabled and returns an error

Frontend note:

- after toggling execution, call `helman/get_schedule` again if the screen shows current-slot runtime state

## Validation rules for `set_schedule`

Each request is validated before being stored.

Slot rules:

- at least one slot must be provided
- slot ids must be unique within a request
- slot ids must be timezone-aware ISO timestamps
- slot ids must align to the configured `SCHEDULE_SLOT_MINUTES` boundary
- slot ids must fall inside the rolling `48` hour horizon

Action rules:

- `charge_to_target_soc` and `discharge_to_target_soc` require `targetSoc`
- `normal`, `stop_charging`, and `stop_discharging` do not allow `targetSoc`
- `targetSoc` must be an integer
- `targetSoc` must be between `0` and `100`
- when writing target actions, the target must also fit inside the configured battery min/max SoC bounds

## Error model

Schedule websocket handlers return Home Assistant websocket errors using `ScheduleError.code`.

Current error codes:

| Error code | Meaning |
| --- | --- |
| `invalid_slots` | malformed slot ids, duplicate ids, empty request, out-of-horizon slot, or misaligned slot |
| `invalid_action` | unknown action kind, missing or disallowed `targetSoc`, or invalid target value |
| `not_configured` | missing required schedule config or missing battery bounds for target writes |
| `execution_unavailable` | live execution cannot proceed because required runtime state or control entity access is unavailable |

### Websocket error vs runtime error

These are different surfaces:

- websocket command error:
  - the command itself failed
  - for example, invalid input or failure while enabling execution
- `runtime.status = "error"`:
  - `helman/get_schedule` still succeeds
  - the current slot reports that the executor's last attempt failed

Example runtime error payload:

```json
{
  "status": "error",
  "errorCode": "execution_unavailable"
}
```

Sometimes runtime error status may also include `executedAction` and `reason` if the executor had already resolved the intended action before the failure happened.

## Config dependency

Execution depends on top-level `scheduler.control` in the Helman config.

That config maps abstract schedule action kinds to the actual Home Assistant option strings on the configured mode entity.

Important consumer rule:

- treat action kinds such as `stop_charging` or `charge_to_target_soc` as the API contract
- do not build UI logic around the localized mode option strings

## Recommended frontend flow

For a schedule editor or current-status view:

1. Call `helman/get_schedule` on screen load.
2. Render the returned `slots` array directly as the source of truth for the editable grid.
3. When the user edits slots, call `helman/set_schedule` with only the changed slots.
4. If the user toggles execution, call `helman/set_schedule_execution`.
5. After successful writes or toggles, call `helman/get_schedule` again.
6. If the screen shows current runtime state, re-read the schedule periodically or at slot boundaries, because there is currently no subscription API.

## Current non-goals

This package does **not** yet implement:

- automated schedule planning from prices, forecasts, or constraints
- deferrable load planning
- EV planning
- execution history or audit trail
- schedule subscriptions

Those belong to future automation/planning increments.

## References

- backend architecture: [`../../../docs/features/automation/helman_manual_schedule_architecture.md`](../../../docs/features/automation/helman_manual_schedule_architecture.md)
- DTO and websocket contract: [`../../../docs/features/automation/helman_manual_schedule_dto_spec.md`](../../../docs/features/automation/helman_manual_schedule_dto_spec.md)
- live smoke scenarios: [`../../../docs/features/automation/helman_manual_schedule_live_smoke.md`](../../../docs/features/automation/helman_manual_schedule_live_smoke.md)
