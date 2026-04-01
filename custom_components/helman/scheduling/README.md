# Helman Scheduling

This package implements the manual schedule backend and the Story 01 appliance-ready websocket contract.

It is ready to be consumed by frontend or internal clients that need to:

- read the rolling schedule grid
- patch one or more authored slots
- enable or disable execution
- inspect the current execution runtime read model
- read stable empty appliance metadata/projection endpoints ahead of later appliance stories

## Current status

Implemented today:

- rolling `48` hour horizon
- slot resolution controlled by `SCHEDULE_SLOT_MINUTES` in `custom_components/helman/const.py`
- sparse persisted storage with materialized `normal` slots in responses
- websocket API:
  - `helman/get_schedule`
  - `helman/set_schedule`
  - `helman/set_schedule_execution`
  - `helman/get_appliances`
  - `helman/get_appliance_projections`
- live execution of the current inverter slot through the configured mode entity
- target-SoC actions resolved against live battery state
- top-level runtime metadata in `helman/get_schedule`
- appliance-ready authored slot shape via `domains.inverter` and `domains.appliances`
- stable empty appliance metadata/projection payloads for Story 01
- persisted schedule documents are treated as a fresh setup if their saved slot duration no longer matches the configured slot duration

Not implemented yet:

- non-empty `domains.appliances` authoring
- appliance execution/runtime population
- appliance projection math
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

## Authored schedule model

The schedule is intentionally slot-native.

- horizon: next `48` hours
- slot size: configured by `SCHEDULE_SLOT_MINUTES`
- slot id: timezone-aware ISO 8601 timestamp representing the slot start
- missing persisted slot = implicit `normal`

Each authored slot uses the composite `domains` shape:

```json
{
  "id": "2026-03-20T21:00:00+01:00",
  "domains": {
    "inverter": {
      "kind": "charge_to_target_soc",
      "targetSoc": 70
    },
    "appliances": {}
  }
}
```

Story 01 keeps `domains.appliances` present but empty:

- `domains.appliances` must be an object
- non-empty `domains.appliances` is rejected
- later appliance stories will populate that branch without another DTO break

Legacy compatibility note:

- old top-level `action` payloads are rejected with a migration-oriented `invalid_action` error
- slot `runtime` is read-only and is also rejected from `helman/set_schedule`

## Supported inverter action kinds

The current inverter action vocabulary is:

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

Target actions are evaluated independently per active slot. There is no carry-over hold state across future slots.

## Runtime read model

Runtime is no longer attached to slots in the authored response. `helman/get_schedule` may expose a separate top-level read-only `runtime` branch when:

- schedule execution is enabled, and
- the executor has runtime state for the same current slot id

Runtime shape:

```json
{
  "activeSlotId": "2026-03-20T21:00:00+01:00",
  "reconciledAt": "2026-03-20T21:07:00+01:00",
  "inverter": {
    "actionKind": "apply",
    "outcome": "success",
    "executedAction": {
      "kind": "stop_discharging"
    },
    "reason": "target_soc_reached"
  },
  "appliances": {}
}
```

Current runtime fields:

- `activeSlotId`
- `reconciledAt`
- `inverter`
  - `actionKind`: `apply | slot_stop | noop`
  - `outcome`: `success | failed | skipped`
  - `executedAction`
  - `reason`
  - `errorCode`
  - `message`
- `appliances`
  - keyed by `applianceId`
  - always `{}` in Story 01

Important consumer rules:

- authored slot data lives only in `slots[*].domains`
- runtime is an ephemeral execution read model, not persisted schedule data
- consumers should match runtime to a slot via `runtime.activeSlotId`
- `helman/set_schedule` never accepts runtime input

## Websocket API

The public scheduling commands live in `custom_components/helman/websockets.py`.

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
      "domains": {
        "inverter": {
          "kind": "charge_to_target_soc",
          "targetSoc": 70
        },
        "appliances": {}
      }
    },
    {
      "id": "2026-03-20T21:30:00+01:00",
      "domains": {
        "inverter": {
          "kind": "normal"
        },
        "appliances": {}
      }
    }
  ],
  "runtime": {
    "activeSlotId": "2026-03-20T21:00:00+01:00",
    "reconciledAt": "2026-03-20T21:07:00+01:00",
    "inverter": {
      "actionKind": "apply",
      "outcome": "success",
      "executedAction": {
        "kind": "stop_discharging"
      },
      "reason": "target_soc_reached"
    },
    "appliances": {}
  }
}
```

Behavior:

- always returns the full rolling `48` hour grid
- materializes missing stored slots as `normal`
- returns authored slot state in `slots[*].domains`
- adds top-level `runtime` only when current execution runtime exists
- uses the executor's last real execution status instead of recomputing optimistically on read

### `helman/set_schedule`

Request:

```json
{
  "type": "helman/set_schedule",
  "slots": [
    {
      "id": "2026-03-20T21:00:00+01:00",
      "domains": {
        "inverter": {
          "kind": "charge_to_target_soc",
          "targetSoc": 80
        },
        "appliances": {}
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
- setting a slot to inverter `normal` removes that slot from persisted storage
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

### `helman/get_appliances`

Request:

```json
{
  "type": "helman/get_appliances"
}
```

Response:

```json
{
  "appliances": []
}
```

### `helman/get_appliance_projections`

Request:

```json
{
  "type": "helman/get_appliance_projections"
}
```

Response:

```json
{
  "generatedAt": "2026-03-20T21:07:00+01:00",
  "appliances": {}
}
```

## Validation rules for `set_schedule`

Each request is validated before being stored.

Slot rules:

- at least one slot must be provided
- slot ids must be unique within a request
- slot ids must be timezone-aware ISO timestamps
- slot ids must align to the configured `SCHEDULE_SLOT_MINUTES` boundary
- slot ids must fall inside the rolling `48` hour horizon
- only `id` and `domains` are accepted on authored slot payloads

Domain rules:

- `domains.inverter` must be an object with a supported inverter action
- `domains.appliances` must be an object
- Story 01 requires `domains.appliances` to stay empty

Inverter action rules:

- `charge_to_target_soc` and `discharge_to_target_soc` require `targetSoc`
- `normal`, `stop_charging`, and `stop_discharging` do not allow `targetSoc`
- `targetSoc` must be an integer
- `targetSoc` must be between `0` and `100`
- when writing target actions, the target must also fit inside the configured battery min/max SoC bounds

## Error model

Scheduling websocket handlers return Home Assistant websocket errors using `ScheduleError.code`.

Current error codes:

| Error code | Meaning |
| --- | --- |
| `invalid_slots` | malformed slot ids, duplicate ids, empty request, out-of-horizon slot, or unsupported authored slot fields |
| `invalid_action` | unknown action kind, invalid `domains` shape, missing or disallowed `targetSoc`, legacy top-level `action`, non-empty Story 01 `domains.appliances`, or incoming slot `runtime` |
| `not_configured` | missing required schedule config or missing battery bounds for target writes |
| `execution_unavailable` | live execution cannot proceed because required runtime state or control entity access is unavailable |

Runtime errors stay in the top-level `runtime` branch; they do not turn `helman/get_schedule` itself into a websocket error.

## Recommended frontend flow

For a schedule editor or current-status view:

1. Call `helman/get_schedule` on screen load.
2. Render the returned `slots` array as the source of truth for authored schedule state.
3. If the UI wants slot-local current execution state, adapt the top-level `runtime` branch onto the slot with id `runtime.activeSlotId`.
4. When the user edits slots, call `helman/set_schedule` with only the changed authored slots.
5. If the user toggles execution, call `helman/set_schedule_execution`.
6. After successful writes or toggles, call `helman/get_schedule` again.
7. If the screen shows current runtime state, re-read the schedule periodically or at slot boundaries because there is currently no subscription API.
