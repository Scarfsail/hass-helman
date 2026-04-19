# Story 01 - Break the DTO contract and scaffold the FE client

Shared guide: [`../ev-charger-implementation-shared.md`](../ev-charger-implementation-shared.md)

Reference design: [`../ev-charger-feature-request-refined.md`](../ev-charger-feature-request-refined.md)

## User story

As a backend/frontend developer, I can use the new appliance-ready websocket contract from both sides so later stories do not need another breaking DTO rewrite.

## Why this story is first

All later stories depend on the DTO surface being stable:

- `helman/get_schedule`
- `helman/set_schedule`
- `helman/get_appliances`
- `helman/get_appliance_projections`

This story should introduce those surfaces early, even if some of them initially return empty or placeholder data.

This is intentionally a **larger foundation story** because it must reflect the breaking websocket contract on both BE and FE sides. However, the FE work is limited to **fixing the breaking change only** — no new FE functionality should be introduced.

## Scope

### In scope

- Break schedule websocket payloads from top-level `action` to top-level `domains`
- Move existing inverter semantics under `domains.inverter`
- Change the internal `ScheduleDocument` / `ScheduleSlot` / `ScheduleAction` model to use the `domains` composite shape, so the internal model is already in its final form for future stories
- Replace the existing flat runtime status model with the new per-domain runtime status shape (`actionKind` / `outcome` per domain, keyed by `applianceId` for appliances)
- Register `helman/get_appliances`
- Register `helman/get_appliance_projections`
- Create the initial backend `appliances/` package stubs used by later stories
- Apply the minimum FE contract-compatibility changes needed so the frontend catches up with the backend breaking websocket change (including the new runtime status shape)
- Keep the FE build green after those contract updates

### Out of scope

- Real appliance config parsing
- Real appliance metadata assembly
- Appliance schedule validation beyond basic shape support
- EV execution
- EV projection math
- Real UI workflows
- New Helman FE functionality beyond breaking-contract catch-up

## Exact file touchpoints

### Backend

Modify:

- `custom_components/helman/websockets.py`
- `custom_components/helman/scheduling/schedule.py`
- `custom_components/helman/scheduling/schedule_executor.py`
- `custom_components/helman/scheduling/runtime_status.py`
- `custom_components/helman/coordinator.py`
- `custom_components/helman/scheduling/README.md`

Create:

- `custom_components/helman/appliances/__init__.py`
- `custom_components/helman/appliances/config.py`
- `custom_components/helman/appliances/dto.py`
- `tests/test_schedule_contract.py`

Extend as needed:

- `tests/test_schedule.py`
- `tests/test_schedule_executor.py`
- `tests/test_coordinator_schedule_execution.py`

### Frontend

Modify:

- `/home/ondra/dev/hass/hass-helman-card/src/helman-api.ts`
- `/home/ondra/dev/hass/hass-helman-card/src/helman-scheduling/schedule-owner.ts`
- `/home/ondra/dev/hass/hass-helman-card/src/helman-scheduling/model/schedule-normalizer.ts`
- `/home/ondra/dev/hass/hass-helman-card/src/helman-scheduling/schedule-types.ts`

Create:

- `/home/ondra/dev/hass/hass-helman-card/src/helman/models.ts`
- `/home/ondra/dev/hass/hass-helman-card/src/helman/client.ts`
- `/home/ondra/dev/hass/hass-helman-card/src/helman/store.ts`

## Implementation plan

1. Change the internal `ScheduleDocument` / `ScheduleSlot` / `ScheduleAction` model in `schedule.py` to use the `domains` composite shape. Each slot should internally carry `domains.inverter` and `domains.appliances`. This ensures the internal model is in its final shape from Story 01, so later stories only add content (appliance actions) without restructuring.

2. Update serialization so each slot serializes to `id`, `domains.inverter`, `domains.appliances`.

3. Keep inverter behavior identical to today, but nest it under `domains.inverter`.

4. Materialize `domains.appliances` as the new contract field, but keep it empty for now because real appliance config and appliance actions belong to later stories.

5. Replace the existing flat runtime status model in `runtime_status.py` with the new per-domain runtime shape: `actionKind: apply|slot_stop|noop`, `outcome: success|failed|skipped`, with appliance entries keyed by `applianceId`. In Story 01, only the `inverter` domain is populated; appliance runtime entries are added in Story 04.

6. Update websocket request validation in `websockets.py` so `helman/set_schedule` accepts the new `domains` shape and rejects the old `action` shape.

7. Add `helman/get_appliances` and `helman/get_appliance_projections` websocket commands with stable default responses:
     - `get_appliances` returns `{ "appliances": [] }`
     - `get_appliance_projections` returns a stable object with `generatedAt` and `appliances: {}`
    - old `action` payloads should fail with a clear migration-oriented error, not only a generic schema failure

8. Update coordinator methods so the new commands exist and the schedule read/write path uses the new DTO shape end-to-end.

9. In FE, create Helman-specific TypeScript models and thin `hass.callWS` wrappers for:
    - `getSchedule`
    - `setSchedule`
    - `getAppliances`
    - `getApplianceProjections`

10. Limit FE changes to the minimum needed for compatibility with the new backend DTOs:
    - update existing FE contract types/calls where needed (including the new per-domain runtime status shape)
    - add only the thinnest Helman-specific client/model scaffolding required to keep the breaking change consumable
    - do not add new screens, workflows, or placeholder feature UIs

## Acceptance criteria

- `helman/get_schedule` returns the new `domains` shape.
- `helman/set_schedule` accepts the new `domains` shape and rejects the old `action` payload shape.
- Internal `ScheduleDocument` / `ScheduleSlot` model uses the `domains` composite shape.
- Runtime status in `get_schedule` uses the new per-domain shape (`actionKind` / `outcome`, with domain-level granularity). In Story 01, only the `inverter` domain is populated.
- `helman/get_appliances` exists and returns a stable empty payload.
- `helman/get_appliance_projections` exists and returns a stable empty payload.
- Existing inverter scheduling still works under `domains.inverter`.
- FE catches up to the breaking websocket contract with only the minimum compatibility-oriented client/model changes (including the new runtime status shape).
- Old schedule payloads using top-level `action` are rejected with a clear error message.
- FE build remains green after the contract-compatibility changes.

## Automated validation

### Backend unit tests

Targeted modules:

- `python3 -m unittest -v tests.test_schedule tests.test_schedule_contract tests.test_schedule_executor tests.test_coordinator_schedule_execution`

### FE build validation

- `cd /home/ondra/dev/hass/hass-helman-card && npm run build-dev`

## Websocket validation

Before running websocket tests, ask the user to restart local Home Assistant.

Then validate with the local-hass-api skill:

- `helman/get_schedule`
- `helman/set_schedule` using the new `domains` payload with inverter-only content
- `helman/get_appliances`
- `helman/get_appliance_projections`

## Manual UI sign-off

No manual UI sign-off is required for this story if the FE work stays at data/client scaffold level or placeholder registration only.
