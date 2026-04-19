# Helman Manual Schedule - DTO and API Spec

## Purpose

This document turns the manual schedule architecture into a code-ready backend contract.

For live validation steps and expected runtime outcomes on a running Home Assistant instance, see [`helman_manual_schedule_live_smoke.md`](./helman_manual_schedule_live_smoke.md).

It focuses on:

- exact websocket payload shapes
- internal Python DTOs
- storage document shape
- validation boundaries
- coordinator and executor method signatures

The guiding principle is still **YAGNI**:

- slot-native API
- no labels in payloads
- no backend grouping objects
- no range DTOs
- no subscription protocol in v1
- no explicit persisted `normal` slots

## Locked API shape

The v1 websocket commands are:

- `helman/get_schedule`
- `helman/set_schedule`
- `helman/set_schedule_execution`

The current authored schedule response is:

```json
{
  "executionEnabled": false,
  "slots": [
    {
      "id": "2026-03-20T21:00:00+01:00",
      "domains": {
        "inverter": {
          "kind": "normal"
        },
        "appliances": {
          "garage-ev": {
            "charge": true,
            "vehicleId": "kona",
            "useMode": "Fast"
          }
        }
      }
    },
    {
      "id": "2026-03-20T22:00:00+01:00",
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

## Constants

These should live in `custom_components/helman/const.py`.

```python
SCHEDULE_SLOT_MINUTES = 30
SCHEDULE_HORIZON_HOURS = 48

SCHEDULE_ACTION_NORMAL = "normal"
SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC = "charge_to_target_soc"
SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC = "discharge_to_target_soc"
SCHEDULE_ACTION_STOP_CHARGING = "stop_charging"
SCHEDULE_ACTION_STOP_DISCHARGING = "stop_discharging"

SCHEDULE_ACTION_KINDS = {
    SCHEDULE_ACTION_NORMAL,
    SCHEDULE_ACTION_CHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_DISCHARGE_TO_TARGET_SOC,
    SCHEDULE_ACTION_STOP_CHARGING,
    SCHEDULE_ACTION_STOP_DISCHARGING,
}
```

`SCHEDULE_SLOT_MINUTES` is the only slot-duration setting. The current implementation requires it to divide `60` evenly.

## Slot ID contract

Slot IDs should follow these rules:

- ISO 8601 timestamp string with timezone offset
- identifies the **slot start**
- aligned to the configured `SCHEDULE_SLOT_MINUTES` boundary
- local-time aware, not naive
- slot end is derived as `slot_start + SCHEDULE_SLOT_MINUTES`

Example:

```text
2026-03-20T21:00:00+01:00
```

## Internal Python DTOs

For v1, I would keep the DTOs simple and put them in `custom_components/helman/scheduling/schedule.py`.

If that file grows later, they can be split out.

### Action kind

```python
from typing import Literal

ScheduleActionKind = Literal[
    "normal",
    "charge_to_target_soc",
    "discharge_to_target_soc",
    "stop_charging",
    "stop_discharging",
]
```

### Internal action model

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class ScheduleAction:
    kind: ScheduleActionKind
    target_soc: int | None = None
```

Validation rules:

- `target_soc` is required for:
  - `charge_to_target_soc`
  - `discharge_to_target_soc`
- `target_soc` must be `None` for:
  - `normal`
  - `stop_charging`
  - `stop_discharging`

### Internal plan slot model

```python
@dataclass(frozen=True)
class ScheduleDomains:
    inverter: ScheduleAction
    appliances: dict[str, dict[str, Any]]

@dataclass(frozen=True)
class ScheduleSlot:
    id: str
    domains: ScheduleDomains
```

This same shape should be used for:

- the plan response slots
- the write request slots

### Persisted schedule document

```python
from dataclasses import dataclass, field

@dataclass
class ScheduleDocument:
    execution_enabled: bool = False
    slots: dict[str, ScheduleDomains] = field(default_factory=dict)
```

Important:

- missing slot means implicit `normal`
- `normal` should not be stored explicitly

### In-memory runtime state

Persisted schedule data stays unchanged. Runtime evaluation lives in a separate ephemeral model and is attached only to the currently running slot in `helman/get_schedule`.

```python
ScheduleExecutionReason = Literal["scheduled", "target_soc_reached"]
ScheduleRuntimeState = Literal["applied", "error"]

@dataclass(frozen=True)
class ActiveSlotRuntimeStatus:
    status: ScheduleRuntimeState
    executed_action: ScheduleAction | None = None
    reason: ScheduleExecutionReason | None = None
    error_code: str | None = None

@dataclass(frozen=True)
class ScheduleExecutionStatus:
    active_slot_id: str | None = None
    active_slot_runtime: ActiveSlotRuntimeStatus | None = None
```

This runtime state is:

- not part of persisted storage
- computed from the current slot and live SoC
- updated from the executor's last real outcome for the running slot
- used to expose response-only runtime metadata for the running slot

## JSON/storage shape

The HA storage document should stay as plain JSON-compatible dicts.

Suggested persisted shape:

```json
{
  "executionEnabled": false,
  "slotMinutes": 30,
  "slots": {
    "2026-03-20T21:00:00+01:00": {
      "inverter": {
        "kind": "normal"
      },
      "appliances": {
        "garage-ev": {
          "charge": true,
          "vehicleId": "kona",
          "useMode": "ECO",
          "ecoGear": "6A"
        }
      }
    },
    "2026-03-20T22:00:00+01:00": {
      "inverter": {
        "kind": "charge_to_target_soc",
        "targetSoc": 80
      },
      "appliances": {}
    }
  }
}
```

`slotMinutes` mirrors `SCHEDULE_SLOT_MINUTES` in storage so the backend can reset persisted schedule data when the configured slot duration changes.

## Mapping rules between Python and JSON

Use:

- `target_soc` in Python
- `targetSoc` in JSON
- `vehicle_id` / `use_mode` / `eco_gear` in Python-facing helpers when needed
- `vehicleId` / `useMode` / `ecoGear` in JSON

Helper signatures:

```python
def action_from_dict(data: Mapping[str, Any]) -> ScheduleAction: ...

def action_to_dict(action: ScheduleAction) -> dict[str, Any]: ...

def schedule_document_from_dict(data: Mapping[str, Any]) -> ScheduleDocument: ...

def schedule_document_to_dict(doc: ScheduleDocument) -> dict[str, Any]: ...
```

## Websocket command schemas

The current repo uses `voluptuous` command schemas plus extra domain validation inside the handler or delegated helper.

## Shared websocket schemas

```python
import voluptuous as vol

ACTION_KIND_SCHEMA = vol.In(SCHEDULE_ACTION_KINDS)

SCHEDULE_ACTION_SCHEMA = vol.Schema(
    {
        vol.Required("kind"): ACTION_KIND_SCHEMA,
        vol.Optional("targetSoc"): vol.Coerce(int),
    },
    extra=vol.PREVENT_EXTRA,
)

SCHEDULE_SLOT_SCHEMA = vol.Schema(
    {
        vol.Required("id"): str,
        vol.Required("domains"): dict,
    },
    extra=vol.PREVENT_EXTRA,
)
```

Note:

- `voluptuous` should only validate basic shape and types
- conditional rules like `targetSoc` required/forbidden should happen in domain validation

### `helman/get_schedule`

Handler schema:

```python
@websocket_api.websocket_command(
    {
        vol.Required("type"): "helman/get_schedule",
    }
)
@websocket_api.async_response
async def ws_get_schedule(...) -> None:
    ...
```

Request:

```json
{
  "id": 1,
  "type": "helman/get_schedule"
}
```

Response DTO:

```python
class ActiveSlotRuntimeDict(TypedDict):
    status: Literal["applied", "error"]
    executedAction: NotRequired[ScheduleActionDict]
    reason: NotRequired[Literal["scheduled", "target_soc_reached"]]
    errorCode: NotRequired[str]

class ScheduleResponse(TypedDict):
    executionEnabled: bool
    slots: list[ScheduleSlotDict]
```

Example response:

```json
{
  "executionEnabled": true,
  "slots": [
    {
      "id": "2026-03-20T21:00:00+01:00",
      "domains": {
        "inverter": {
          "kind": "charge_to_target_soc",
          "targetSoc": 80
        },
        "appliances": {
          "garage-ev": {
            "charge": true,
            "vehicleId": "kona",
            "useMode": "Fast"
          }
        }
      },
    }
  ],
  "runtime": {
    "activeSlotId": "2026-03-20T21:00:00+01:00",
    "appliances": {},
    "inverter": {
      "actionKind": "apply",
      "outcome": "success",
      "executedAction": {
        "kind": "stop_discharging"
      },
      "reason": "target_soc_reached"
    }
  }
}
```

Rules:

- always return all upcoming slots for the next `48` hours
- fill missing stored slots as `normal`
- attach `runtime` as a top-level read-only branch when execution is enabled
- keep `slots[*].domains` as the authored schedule state even when runtime differs
- omitted appliance IDs mean there is no explicit appliance action for that slot
- when runtime execution fails, return a machine-readable top-level runtime error state
- never return labels
- never return grouped ranges

### `helman/set_schedule`

Handler schema:

```python
@websocket_api.websocket_command(
    {
        vol.Required("type"): "helman/set_schedule",
        vol.Required("slots"): [SCHEDULE_SLOT_SCHEMA],
    }
)
@websocket_api.async_response
async def ws_set_schedule(...) -> None:
    ...
```

Request DTO:

```python
class SetScheduleRequest(TypedDict):
    slots: list[ScheduleSlotDict]
```

Example request:

```json
{
  "id": 2,
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
    },
    {
      "id": "2026-03-20T22:00:00+01:00",
      "domains": {
        "inverter": {
          "kind": "normal"
        },
        "appliances": {
          "garage-ev": {
            "charge": true,
            "vehicleId": "kona",
            "useMode": "ECO",
            "ecoGear": "6A"
          }
        }
      }
    },
    {
      "id": "2026-03-20T23:00:00+01:00",
      "domains": {
        "inverter": {
          "kind": "normal"
        },
        "appliances": {
          "garage-ev": {
            "charge": false
          }
        }
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

Write semantics:

- each provided slot is independent
- if inverter is `normal` and `domains.appliances` is empty, remove that slot from persisted storage
- otherwise overwrite that slot with the provided canonical `domains` payload
- no contiguity requirement
- duplicate slot IDs in one request are rejected
- `domains.appliances` is keyed by `applianceId`
- `charge = false` may omit `vehicleId`
- `charge = true` requires `vehicleId`
- `useMode = ECO` requires `ecoGear`
- `useMode = Fast` accepts `ecoGear` on input but ignores it in canonical persistence/readback
- appliance and vehicle references are validated against the active runtime appliance registry
- persisted stale appliance or vehicle references are dropped per appliance action during load normalization

### `helman/set_schedule_execution`

Handler schema:

```python
@websocket_api.websocket_command(
    {
        vol.Required("type"): "helman/set_schedule_execution",
        vol.Required("enabled"): bool,
    }
)
@websocket_api.async_response
async def ws_set_schedule_execution(...) -> None:
    ...
```

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

## TypedDicts for websocket payloads

These can live near the websocket handlers or in `scheduling/schedule.py`.

```python
from typing import NotRequired, TypedDict

class ScheduleActionDict(TypedDict):
    kind: ScheduleActionKind
    targetSoc: NotRequired[int]

class ScheduleSlotDict(TypedDict):
    id: str
    action: ScheduleActionDict
    runtime: NotRequired[ActiveSlotRuntimeDict]

class ScheduleResponseDict(TypedDict):
    executionEnabled: bool
    slots: list[ScheduleSlotDict]
```

## Domain validation layer

This should happen after websocket shape validation.

Suggested helper:

```python
def validate_slot_patch(
    *,
    slot_id: str,
    action: ScheduleAction,
    reference_time: datetime,
    battery_live_state: BatteryLiveState | None,
) -> None:
    ...
```

Checks:

- slot ID parses to timezone-aware datetime
- slot ID is aligned to the configured `SCHEDULE_SLOT_MINUTES` boundary
- slot is within rolling `48` hour horizon
- action kind is known
- `target_soc` is present only when required
- `target_soc` is within battery min/max SoC when battery state is available

Recommended request-level helper:

```python
def validate_slot_patch_request(
    *,
    slots: Sequence[ScheduleSlot],
    reference_time: datetime,
    battery_live_state: BatteryLiveState | None,
) -> None:
    ...
```

Additional checks:

- request is not empty
- slot IDs are unique

## Core helper signatures

These helpers should live in `scheduling/schedule.py`.

```python
def build_horizon_start(reference_time: datetime) -> datetime: ...

def build_horizon_end(reference_time: datetime) -> datetime: ...

def parse_slot_id(slot_id: str) -> datetime: ...

def format_slot_id(slot_start: datetime) -> str: ...

def iter_horizon_slot_ids(reference_time: datetime) -> list[str]: ...

def materialize_plan_slots(
    *,
    stored_slots: Mapping[str, ScheduleAction],
    reference_time: datetime,
) -> list[ScheduleSlot]:
    ...

def apply_slot_patches(
    *,
    stored_slots: Mapping[str, ScheduleAction],
    slot_patches: Sequence[ScheduleSlot],
) -> dict[str, ScheduleAction]:
    ...

def prune_expired_slots(
    *,
    stored_slots: Mapping[str, ScheduleAction],
    reference_time: datetime,
) -> dict[str, ScheduleAction]:
    ...
```

## Coordinator method signatures

These should live on `HelmanCoordinator` in v1, to stay aligned with the current repo shape.

```python
async def get_schedule(
    self,
    *,
    reference_time: datetime | None = None,
) -> ScheduleResponseDict:
    ...

async def set_schedule(
    self,
    *,
    slots: Sequence[ScheduleSlot],
    reference_time: datetime | None = None,
) -> None:
    ...

async def set_schedule_execution(
    self,
    *,
    enabled: bool,
) -> bool:
    ...
```

Recommended private helpers:

```python
def _read_schedule_control_config(self) -> ScheduleControlConfig | None: ...

def _load_schedule_document(self) -> ScheduleDocument: ...

async def _save_schedule_document(self, doc: ScheduleDocument) -> None: ...

def _build_schedule_response(
    self,
    *,
    reference_time: datetime,
) -> ScheduleResponseDict:
    ...

def _ensure_schedule_executor_started(self) -> None: ...

def _stop_schedule_executor(self) -> None: ...
```

## Control config DTO

This is internal config, not websocket payload.

```python
@dataclass(frozen=True)
class ScheduleControlConfig:
    mode_entity_id: str
    normal_option: str
    stop_charging_option: str
    stop_discharging_option: str
    charge_to_target_soc_option: str | None = None
    discharge_to_target_soc_option: str | None = None
```

Helper signature:

```python
def read_schedule_control_config(config: Mapping[str, Any]) -> ScheduleControlConfig | None:
    ...
```

Read this from the top-level `scheduler.control` branch in the saved Helman config.

For slice 2, only `normal`, `stop_charging`, and `stop_discharging` mappings are required because target-SoC actions are not executed yet. The target-action mappings become relevant once slice 3 adds target-SoC execution.

## Executor method signatures

These should live in `scheduling/schedule_executor.py`.

```python
class ScheduleExecutor:
    def __init__(self, hass: HomeAssistant, coordinator: HelmanCoordinator) -> None: ...

    async def async_setup(self) -> None: ...

    async def async_unload(self) -> None: ...

    async def async_reconcile(
        self,
        *,
        reason: str,
        reference_time: datetime | None = None,
    ) -> None:
        ...
```

Recommended private helpers:

```python
def get_execution_status(self) -> ScheduleExecutionStatus: ...

def describe_execution_status(
    self,
    *,
    schedule_document: ScheduleDocument,
    reference_time: datetime,
) -> ScheduleExecutionStatus:
    ...

async def _async_apply_action(
    self,
    *,
    action: ScheduleAction,
) -> None:
    ...

async def _async_restore_normal(self) -> None: ...

def _read_active_slot(
    self,
    *,
    reference_time: datetime,
) -> ScheduleSlot | None:
    ...

def _describe_active_slot_runtime(
    self,
    *,
    slot: ScheduleSlot,
) -> ActiveSlotRuntimeStatus:
    ...
```

## Error codes

Stick to the existing websocket pattern using `connection.send_error`.

Recommended codes:

- `not_loaded`
- `invalid_slots`
- `invalid_action`
- `not_configured`
- `execution_unavailable`

Recommended mapping:

### `invalid_slots`

Use for:

- empty slot array
- duplicate slot IDs
- malformed slot ID
- slot outside horizon
- slot not aligned to the configured slot duration

### `invalid_action`

Use for:

- unknown action kind
- missing `targetSoc`
- unexpected `targetSoc`
- `targetSoc` out of battery min/max range

### `not_configured`

Use for:

- missing control entity config
- missing action option mapping
- missing battery config when target-SoC action needs SoC monitoring

### `execution_unavailable`

Use for:

- control entity unavailable when enabling execution
- mapped option missing from `input_select`
- battery state unavailable during active target action

## Minimal handler skeletons

These are not implementation code, just the intended flow.

```python
@websocket_api.async_response
async def ws_get_schedule(hass, connection, msg):
    coordinator = hass.data[DOMAIN].get("coordinator")
    if not coordinator:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return
    connection.send_result(msg["id"], await coordinator.get_schedule())
```

```python
@websocket_api.async_response
async def ws_set_schedule(hass, connection, msg):
    coordinator = hass.data[DOMAIN].get("coordinator")
    if not coordinator:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return
    await coordinator.set_schedule(slots=_slots_from_msg(msg["slots"]))
    connection.send_result(msg["id"], {"success": True})
```

```python
@websocket_api.async_response
async def ws_set_schedule_execution(hass, connection, msg):
    coordinator = hass.data[DOMAIN].get("coordinator")
    if not coordinator:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return
    enabled = await coordinator.set_schedule_execution(enabled=msg["enabled"])
    connection.send_result(msg["id"], {"success": True, "executionEnabled": enabled})
```

## Recommended implementation order

1. Add constants and DTO helpers
2. Extend storage with `ScheduleDocument`
3. Add slot parsing/materialization/validation helpers
4. Add `get_schedule`
5. Add `set_schedule`
6. Add `set_schedule_execution`
7. Add executor reconciliation and target-SoC completion
