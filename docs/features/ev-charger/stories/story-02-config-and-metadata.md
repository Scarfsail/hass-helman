# Story 02 - Read appliance config and expose metadata (backend)

Shared guide: [`../ev-charger-implementation-shared.md`](../ev-charger-implementation-shared.md)

Reference design: [`../ev-charger-feature-request-refined.md`](../ev-charger-feature-request-refined.md)

## User story

As a user, once backend appliance configuration exists, I can fetch a metadata-only appliance map that FE can combine with live HA state and backend-declared schedule capabilities.

## Depends on

- Story 01

## Scope

### In scope

- Parse and validate top-level `appliances` config
- Implement `helman/get_appliances`
- Keep `get_appliances` metadata-only

### Out of scope

- Schedule authoring
- Execution
- Projection math
- Any frontend changes

## Exact file touchpoints

### Backend

Create:

- `custom_components/helman/appliances/state.py`
- `tests/test_appliance_config.py`
- `tests/test_appliance_state.py`

Modify:

- `custom_components/helman/appliances/config.py`
- `custom_components/helman/appliances/dto.py`
- `custom_components/helman/coordinator.py`
- `custom_components/helman/websockets.py`

## Implementation plan

1. Add a dedicated backend config reader for the top-level `appliances` branch instead of spreading ad-hoc dict reads across coordinator logic.

2. Validate only the parts needed for v1 EV support:
   - appliance `id`
   - appliance `kind`
   - appliance `name`
   - charger control entity IDs
   - vehicle list with explicit vehicle `id`
   - vehicle telemetry IDs
   - manual vehicle metadata
   - `ecoGear -> min power` map

3. Implement a metadata builder that returns:
   - appliance IDs
   - appliance names and kinds
   - control entity IDs
   - schedule capabilities metadata for v1 authoring
   - vehicle IDs and names
   - vehicle telemetry entity IDs
   - manual metadata

4. Treat config lifecycle according to the shared guide:
   - `save_config` updates stored config
   - restart / reload builds the validated active config and runtime appliance registry
   - `get_appliances` reads from the active runtime registry only
   - if the `appliances` config key is missing, the integration loads normally with no appliances active (not an error)
   - validate each appliance independently during restart / reload
   - if an appliance config is invalid, log an explicit error describing what is wrong and ignore that appliance — the rest of the integration continues to function since appliances are not mandatory

5. Keep `helman/get_appliances` strictly metadata-only:
   - do not echo current switch/select values
   - do not echo raw current select options as live state
   - do not duplicate current SoC or charge limit values
   - do expose backend-declared schedule capabilities so FE does not infer supported authoring modes only from raw HA options

6. Do not build any frontend configuration or summary UI in this story.

## Acceptance criteria

- A valid EV appliance config provided through existing backend config mechanisms is read successfully.
- Each returned appliance exposes an explicit `id`.
- Each returned EV vehicle exposes an explicit `id`.
- `helman/get_appliances` returns metadata, entity mapping, and schedule capabilities only, not live values/options.
- Invalid appliance config produces an explicit warning/error log and the invalid appliance is ignored instead of silently failing or poisoning the whole active runtime registry.

## Automated validation

### Backend unit tests

- `python3 -m unittest -v tests.test_appliance_config tests.test_appliance_state`

## Websocket validation

Before running websocket tests, ask the user to restart local Home Assistant so backend code changes are loaded.

Then validate with the local-hass-api skill:

- `helman/get_config`
- `helman/save_config` with one EV appliance and one vehicle using an explicit vehicle `id`
- restart / reload local Home Assistant so the saved appliance config becomes active
- `helman/get_appliances`

Confirm that the returned metadata uses the real local entity IDs, includes explicit vehicle IDs and schedule capabilities, and omits live values/options.

## Manual UI sign-off

No.
