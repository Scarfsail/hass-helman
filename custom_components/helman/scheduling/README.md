# Scheduling

The current automation flow, optimizer order, and planning examples are in
[the automation guide](../../../docs/automation.md). This package holds the
schedule document, active-slot execution, and runtime status sent to the UI.

## Schedule shape

[schedule.py](schedule.py) defines parsing, validation, and serialization.
The WebSocket document has `executionEnabled` and `slots`. Each slot contains
an `id` and a `controllables` map. The map is keyed by controllable ID;
`inverter` is the inverter key, and appliance IDs identify appliance lanes.
`SCHEDULE_SLOT_KEYS` in `schedule.py` is the source for accepted slot keys.

The action shape depends on its controllable. See `slot_from_dict` and
`schedule_document_to_dict` in `schedule.py` for the accepted and emitted
fields. [websockets.py](../websockets.py) registers `helman/get_schedule`,
`helman/set_schedule`, and `helman/set_schedule_execution`, including their
request schemas and response construction.

## Execution and status

[schedule_service.py](schedule_service.py) owns the stored document: its lock, the one prune every reader goes through, the writes, the execution toggle and the executor. Its docstring lists which methods take the lock and which must be called under it.

[schedule_executor.py](schedule_executor.py) reconciles the active slot with
the current entity states. [runtime_status.py](runtime_status.py) defines the
per-controllable runtime record attached to the active slot in the schedule
response. The response includes the executed inverter action and appliance
outcomes when available.

Appliance projection and execution code lives under [appliances](../appliances/).
The automation guide explains how its demand estimates feed the optimizer
phases and how the final schedule reaches the executor.
