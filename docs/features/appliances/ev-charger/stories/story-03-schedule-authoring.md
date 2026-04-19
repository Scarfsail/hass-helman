# Story 03 - Author appliance actions in backend schedule

Shared guide: [`../ev-charger-implementation-shared.md`](../ev-charger-implementation-shared.md)

Reference design: [`../ev-charger-feature-request-refined.md`](../ev-charger-feature-request-refined.md)

## User story

As a user, I can author EV appliance actions per slot alongside inverter actions and save/load them through the shared schedule contract.

## Depends on

- Story 01
- Story 02

## Scope

### In scope

- Real appliance action persistence in `get_schedule` / `set_schedule`
- `domains.appliances` keyed by explicit `applianceId`
- Validation for EV slot payload rules

### Out of scope

- Execution against Home Assistant
- Projection math
- Any frontend changes

## Exact file touchpoints

### Backend

Create:

- `tests/test_schedule_appliances.py`

Modify:

- `custom_components/helman/scheduling/schedule.py`
- `custom_components/helman/coordinator.py`
- `custom_components/helman/websockets.py`
- `custom_components/helman/scheduling/README.md`
- `tests/test_schedule.py`

## Implementation plan

1. Extend the backend schedule model so a slot can carry:
   - `domains.inverter`
   - `domains.appliances`

2. Implement real appliance slot parsing and serialization in `schedule.py`:
   - sparse object keyed by `applianceId`
   - omitted appliance IDs mean no explicit appliance action for that slot
   - EV-specific `vehicleId` handling stays inside the EV action payload
   - `charge`, `useMode`, `ecoGear`

3. Enforce the agreed EV action rules through the EV appliance-kind handler / validator:
    - `charge = false` means `useMode` and `ecoGear` must be omitted
    - `charge = false` may omit `vehicleId`
    - `charge = true` + `useMode = Fast` does not require `ecoGear`
    - `charge = true` + `useMode = Fast` accepts `ecoGear` on input but ignores it in canonical persistence/readback
    - `charge = true` + `useMode = ECO` requires `ecoGear`
    - the referenced `applianceId` must exist
    - any EV-specific `vehicleId` must be valid for that appliance
    - persisted stale appliance or vehicle references should be pruned per invalid appliance action during load normalization rather than resetting the whole slot or document

4. Keep persisted storage sparse where possible and preserve the keyed-by-`applianceId` shape in responses.

5. Update `get_schedule` / `set_schedule` coordinator flow to round-trip appliance actions without affecting execution yet.

6. Do not build frontend schedule UI in this story.

## Acceptance criteria

- Appliance actions round-trip through `helman/set_schedule` and `helman/get_schedule`.
- Omitted appliance IDs in `domains.appliances` mean there is no explicit appliance action for that slot.
- Invalid EV action combinations or unknown `vehicleId` values are rejected by backend validation.
- `charge = false` may omit `vehicleId`.
- `useMode = Fast` drops any provided `ecoGear` from canonical persistence/readback.
- Persisted stale appliance or vehicle references are removed surgically per appliance action on load.

## Automated validation

### Backend unit tests

- `python3 -m unittest -v tests.test_schedule tests.test_schedule_appliances`

## Websocket validation

Before running websocket tests, ask the user to restart local Home Assistant so backend code changes are loaded. If the appliance config used for validation was changed via `helman/save_config`, restart / reload again before calling schedule APIs so the active runtime registry sees the new appliance and vehicle IDs.

Then validate with the local-hass-api skill:

- `helman/get_schedule`
- `helman/set_schedule` with:
  - one slot with one keyed appliance action using `vehicleId`, `charge = true`, `useMode = Fast`
  - one slot with one keyed appliance action using `vehicleId`, `charge = true`, `useMode = ECO`, `ecoGear`
  - one slot with no `domains.appliances` entry for the appliance
- `helman/get_schedule` again to confirm readback shape

## Manual UI sign-off

No.
