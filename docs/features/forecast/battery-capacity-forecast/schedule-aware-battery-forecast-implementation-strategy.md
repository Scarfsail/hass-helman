# Schedule-aware Battery Forecast - Implementation Strategy

## Purpose

This document is the implementation handoff for future coding sessions.

The feature should be implemented increment by increment, with each increment small enough for a single session and safe enough to validate before moving on.

After every increment:

- run the relevant existing repo tests while iterating
- run the full backend unit suite before handoff
- ask the user to confirm that local Home Assistant has been restarted with the new code
- only after that confirmation, use the `local-hass-api` skill and validate via websocket API against the local HA instance
- update `schedule-aware-battery-forecast-implementation-progress.md`
- stop and wait for review before starting the next increment

## References

- **Analysis**: [`schedule-aware-battery-forecast-analysis.md`](./schedule-aware-battery-forecast-analysis.md)
- **Implementation progress**: [`schedule-aware-battery-forecast-implementation-progress.md`](./schedule-aware-battery-forecast-implementation-progress.md)
- **Feature overview**: [`README.md`](./README.md)
- **Related live smoke guide**: [`../../automation/scheduling/helman-manual-schedule-live-smoke.md`](../../automation/scheduling/helman-manual-schedule-live-smoke.md)
- **Backend repo root**: `/home/ondra/dev/hass/hass-helman`
- **Backend code**: `/home/ondra/dev/hass/hass-helman/custom_components/helman/`
- **Backend tests**: `/home/ondra/dev/hass/hass-helman/tests/`

## Accepted direction

Use **Option C - pragmatic balance** from the analysis document.

That means:

- keep the current forecast pipeline intact
- keep the battery simulation canonical at `15` minutes
- keep the current passive simulation as the internal baseline path
- add a dedicated schedule-to-forecast overlay helper under `custom_components/helman/scheduling/`
- reuse scheduler target-action semantics instead of inventing a second rule set
- expose schedule-adjusted battery values as the primary output only when schedule execution is enabled
- attach baseline comparison values so the UI can later show the impact of the schedule

## Granularity compatibility requirement

The schedule-aware battery forecast must not introduce any new hard-coded `30`-minute assumptions.

Required design rule:

- a future change of `SCHEDULE_SLOT_MINUTES` from `30` to `15` must not require follow-up battery-forecast-specific backend or UI code changes
- the implementation must derive schedule-to-forecast behavior from:
  - `SCHEDULE_SLOT_MINUTES`
  - `FORECAST_CANONICAL_GRANULARITY_MINUTES`
- when the two granularities are equal, the overlay must naturally behave as direct canonical slot lookup
- when the scheduler is coarser than the canonical forecast grid, the overlay may expand each schedule slot across the covered canonical forecast segments
- do not hard-code schedule slot counts like `96` or `192`; derive them from the configured slot duration and horizon

This requirement is about the schedule-aware forecast feature. The scheduler subsystem's existing persistence behavior on slot-size change may stay as-is.

## Agreed rollout scope

This rollout is intentionally **backend-only** in `hass-helman`.

The target behavior for this implementation sequence is:

- when scheduler execution is disabled, `battery_capacity` stays on the current baseline behavior
- when scheduler execution is enabled, `battery_capacity` reflects the schedule-adjusted simulation
- the response also exposes baseline comparison fields per slot:
  - `baselineSocPct`
  - `baselineRemainingEnergyKwh`
- the forecast remains request-compatible through `helman/get_forecast`
- no new mandatory config is required for v1

## Explicitly out of scope

Do not include these in this implementation sequence:

- frontend consumption changes in `hass-helman-card`
- new websocket request parameters or a new forecast endpoint
- a central config-schema rewrite
- inverter/grid throughput modeling beyond the current battery forecast settings
- accepted-plan or price-optimized automation scenarios
- extra persistent cache/storage for schedule-adjusted battery forecasts

## Shared validation workflow for every increment

### Automated backend validation

Run from repo root:

```bash
cd /home/ondra/dev/hass/hass-helman
python3 -m unittest discover -s tests -v
```

Recommended while iterating:

- run targeted test modules for the touched files first
- optionally run `python3 -m py_compile` for touched backend and test files as a quick syntax guard

Before handing off an increment, record:

- the targeted test modules that were run
- whether the full `unittest discover` run passed
- any intentionally deferred failures or blockers

### Restart-gated local HA websocket validation

This is required after every increment, but only after the user confirms that local Home Assistant has been restarted or reloaded with the new code.

The agent handling an increment must:

1. Ask the user to confirm the restart.
2. Wait for explicit confirmation.
3. Invoke the `local-hass-api` skill.
4. Use websocket API validation against local HA.
5. Record the observed results in the progress doc before ending the session.

Do not skip the confirmation step and do not assume the running HA instance already has the new code loaded.

### Shared websocket flow

Use the following commands as the base validation flow, adjusting the assertions per increment:

- `helman/get_config` for optional config sanity checks
- `helman/get_schedule`
- `helman/get_forecast`
- when needed for live schedule-aware checks:
  - `helman/set_schedule`
  - `helman/set_schedule_execution`

Live validation rules:

- always fetch the current slot fresh before mutating it
- mutate only the current slot during live smoke checks
- always revert the same slot to `normal`
- always disable execution again before ending validation
- compare `helman/get_schedule` runtime metadata with `helman/get_forecast` battery behavior once schedule-aware output is exposed

For low-risk increments that do not yet change public forecast behavior, websocket validation may be regression-only:

- `helman/get_schedule` still works
- `helman/get_forecast` still works
- existing baseline behavior is unchanged

## Increment overview

| Increment | Name | Repo(s) | Depends on | User validation required |
|-----------|------|---------|------------|--------------------------|
| 1 | Shared schedule overlay contract | BE | none | Yes |
| 2 | Coordinator plumbing and cache signatures | BE | 1 | Yes |
| 3 | Public response contract and stop-action simulation | BE | 1, 2 | Yes |
| 4 | Target actions and mid-slot crossing | BE | 1, 2, 3 | Yes |
| 5 | Horizon fallback, cache polish, and docs closeout | BE + docs | 4 | Yes |

## Increment 1 - Shared schedule overlay contract

### Goal

Introduce forecast-side schedule primitives and shared action semantics without changing the public battery forecast output yet.

### Backend paths

- Repo root: `/home/ondra/dev/hass/hass-helman`
- Likely files:
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/scheduling/forecast_overlay.py` (new)
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/scheduling/schedule_executor.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/scheduling/schedule.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_schedule_executor.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_schedule_forecast_overlay.py` (new)

### Scope

- Add a helper that:
  - prunes the persisted schedule
  - materializes the active `48h` horizon
  - derives schedule-to-forecast translation from `SCHEDULE_SLOT_MINUTES` and `FORECAST_CANONICAL_GRANULARITY_MINUTES`
  - behaves as direct slot lookup when scheduler and forecast granularities already match
- Extract or centralize target-action resolution semantics so the scheduler executor and forecast path can share the same rule family.
- Keep `helman/get_forecast` behavior unchanged in this increment.
- Do not wire the overlay into the coordinator yet.

### What should be testable after this increment

- overlay lookup returns the expected action windows for `normal`, `stop_*`, and target actions
- overlay behavior is proven under the current `30`-minute scheduler and under a future `15`-minute scheduler configuration
- charge target reached resolves to `stop_discharging`
- discharge target reached resolves to `stop_charging`
- existing scheduler executor tests still pass
- `helman/get_forecast` remains behaviorally unchanged

### Automated validation

- targeted:
  - `python3 -m unittest -v tests.test_schedule tests.test_schedule_executor`
  - the new overlay test module
- full:
  - `python3 -m unittest discover -s tests -v`

The new overlay tests should avoid hard-coded `30`-minute assumptions. They should verify both:

- current coarser-than-canonical behavior
- equal-granularity behavior after reloading or configuring the schedule module for `15`-minute slots

### Local HA websocket validation after restart confirmation

- regression-only check:
  - `helman/get_schedule` still returns current slot and runtime metadata correctly
  - `helman/get_forecast` still returns the existing baseline battery payload

### Exit criteria

- shared schedule-aware forecast primitives exist
- shared target semantics are covered by tests
- no public battery forecast behavior changes yet

## Increment 2 - Coordinator plumbing and cache signatures

### Goal

Wire schedule state into the battery forecast path and make battery-cache dependencies schedule-aware before public behavior changes land.

### Backend paths

- Repo root: `/home/ondra/dev/hass/hass-helman`
- Likely files:
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/coordinator.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/battery_capacity_forecast_builder.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/scheduling/forecast_overlay.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_coordinator_battery_forecast_cache.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_coordinator_schedule_execution.py`

### Scope

- Load and prune the schedule document during battery forecast assembly.
- Build and pass optional overlay context only when `executionEnabled` is true.
- Extend the battery-cache signature with:
  - `executionEnabled`
  - a signature of the pruned schedule document
- Invalidate the battery cache on:
  - `set_schedule()`
  - `set_schedule_execution()`
  - relevant config saves and existing forecast invalidation paths
- Let the builder accept overlay input, but keep public forecast behavior baseline-equivalent in this increment.

### What should be testable after this increment

- schedule mutation invalidates the battery forecast cache
- execution toggle invalidates the battery forecast cache
- compatible schedule state can still reuse the cache
- `helman/get_forecast` remains baseline-equivalent externally
- existing schedule APIs remain unchanged

### Automated validation

- targeted:
  - `python3 -m unittest -v tests.test_coordinator_battery_forecast_cache`
  - `python3 -m unittest -v tests.test_coordinator_schedule_execution`
- full:
  - `python3 -m unittest discover -s tests -v`

### Local HA websocket validation after restart confirmation

- regression-only check:
  - `helman/get_schedule` still works
  - `helman/get_forecast` still works
  - schedule mutation and execution toggling do not break the forecast path

### Exit criteria

- schedule state is now a first-class forecast dependency
- cache invalidation is correct before public schedule-aware behavior lands
- public forecast behavior is still unchanged

## Increment 3 - Public response contract and stop-action simulation

### Goal

Expose the schedule-aware battery forecast contract with the simplest adjusted behaviors first: `normal`, `stop_charging`, and `stop_discharging`.

### Backend paths

- Repo root: `/home/ondra/dev/hass/hass-helman`
- Likely files:
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/coordinator.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/battery_capacity_forecast_builder.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/battery_forecast_response.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/forecast_aggregation.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_battery_forecast_response.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_forecast_aggregation.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_forecast_request_contract.py`

### Scope

- Keep the baseline path immutable internally and compute an adjusted path only when schedule execution is enabled.
- Implement action-aware behavior for:
  - `normal`
  - `stop_charging`
  - `stop_discharging`
- Expose adjusted values as the primary battery series only when schedule execution is enabled.
- Add top-level metadata:
  - `scheduleAdjusted`
  - `scheduleAdjustmentCoverageUntil`
- Add per-slot comparison fields:
  - `baselineSocPct`
  - `baselineRemainingEnergyKwh`
- Extend aggregation so the comparison fields survive `15 -> 30 -> 60`.
- Preserve the `helman/get_forecast` request contract.

### What should be testable after this increment

- execution disabled returns the current baseline semantics
- execution enabled with stop actions returns schedule-adjusted primary values
- baseline comparison fields are present when adjustment is active
- `15`, `30`, and `60` minute responses aggregate the new fields correctly
- request-schema behavior for `helman/get_forecast` remains unchanged

### Automated validation

- targeted:
  - `python3 -m unittest -v tests.test_battery_capacity_forecast_builder`
  - `python3 -m unittest -v tests.test_battery_forecast_response`
  - `python3 -m unittest -v tests.test_forecast_aggregation`
  - `python3 -m unittest -v tests.test_forecast_request_contract`
- full:
  - `python3 -m unittest discover -s tests -v`

### Local HA websocket validation after restart confirmation

- baseline check with `executionEnabled = false`
- fetch `helman/get_schedule` and `helman/get_forecast`
- mutate only the current slot with either:
  - `stop_charging`
  - `stop_discharging`
- enable execution with `helman/set_schedule_execution`
- compare:
  - `slots[0].action`
  - `slots[0].runtime.executedAction`
  - `battery_capacity.scheduleAdjusted`
  - first adjusted battery slots versus baseline comparison fields
- revert the slot to `normal`
- disable execution
- confirm the forecast returns to baseline behavior

### Exit criteria

- schedule-aware battery output is visible through `helman/get_forecast`
- non-target stop actions match scheduler semantics closely enough to validate live

## Increment 4 - Target actions and mid-slot crossing

### Goal

Implement `charge_to_target_soc` and `discharge_to_target_soc`, including target-reached transitions inside a canonical segment.

### Backend paths

- Repo root: `/home/ondra/dev/hass/hass-helman`
- Likely files:
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/scheduling/forecast_overlay.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/coordinator.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/battery_capacity_forecast_builder.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_battery_capacity_forecast_builder.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_coordinator_battery_forecast_cache.py`

### Scope

- Implement action-aware behavior for:
  - `charge_to_target_soc`
  - `discharge_to_target_soc`
- Model:
  - forced grid charging when solar is insufficient
  - forced discharge with export when house load is lower than forced output
  - target reached at slot start
  - target reached mid-slot
  - fractional first-slot target crossing
- Reuse the shared target-semantics helper from the scheduler.
- Tighten cache compatibility where an active target action would otherwise survive an effective-action flip incorrectly.

### What should be testable after this increment

- target actions import/export energy correctly
- target reached at slot start resolves to the paired `stop_*` action
- target reached mid-slot splits behavior correctly
- fractional first-slot target crossing behaves correctly
- active target crossing or effective-action change does not reuse stale forecast behavior

### Automated validation

- targeted:
  - `python3 -m unittest -v tests.test_battery_capacity_forecast_builder`
  - `python3 -m unittest -v tests.test_coordinator_battery_forecast_cache`
- full:
  - `python3 -m unittest discover -s tests -v`

### Local HA websocket validation after restart confirmation

- validate current-slot `charge_to_target_soc`
- validate current-slot `discharge_to_target_soc`
- compare `slots[0].runtime.executedAction` with the adjusted battery behavior
- confirm target-reached behavior falls back to the paired `stop_*` mode
- revert and disable execution before ending the smoke test

### Exit criteria

- target-action behavior matches scheduler semantics closely enough to validate live
- mid-slot target transitions are covered by tests and live smoke

## Increment 5 - Horizon fallback, cache polish, and docs closeout

### Goal

Close the rollout with horizon-boundary correctness, final cache polish, and current docs.

### Backend paths

- Repo root: `/home/ondra/dev/hass/hass-helman`
- Likely files:
  - `/home/ondra/dev/hass/hass-helman/docs/features/forecast/battery-capacity-forecast/README.md`
  - `/home/ondra/dev/hass/hass-helman/docs/features/automation/scheduling/helman-manual-schedule-live-smoke.md`
  - `/home/ondra/dev/hass/hass-helman/docs/features/forecast/battery-capacity-forecast/schedule-aware-battery-forecast-analysis.md` (only if cross-links or small follow-up notes are needed)
  - tests touched only if final regression fixes are needed

### Scope

- Make the adjusted simulation fall back to `normal` after the explicit `48h` schedule horizon.
- Ensure `scheduleAdjustmentCoverageUntil` matches the actual adjusted horizon.
- Apply any final cache-compatibility polish uncovered by target-action live testing.
- Update consumer-facing docs to describe:
  - schedule-aware battery behavior
  - the new response metadata
  - baseline comparison fields
- Extend the live smoke guide so it explicitly compares `helman/get_schedule` and `helman/get_forecast`.
- Reconcile any final documentation gaps discovered during live validation.
- Mark the progress doc complete once the final validation passes.

### What should be testable after this increment

- schedule-aware behavior stops cleanly after the schedule horizon
- `scheduleAdjustmentCoverageUntil` reflects the adjusted horizon correctly
- docs match the implemented payload and live workflow
- final live smoke covers both target-action directions and a clean revert path

### Automated validation

- rerun touched tests
- rerun the full backend unit suite:
  - `python3 -m unittest discover -s tests -v`

### Local HA websocket validation after restart confirmation

- baseline / execution disabled
- current-slot `stop_charging` or `stop_discharging`
- current-slot `charge_to_target_soc`
- current-slot `discharge_to_target_soc`
- revert to `normal`
- disable execution
- confirm:
  - schedule runtime metadata matches the effective action
  - forecast returns to baseline after revert
  - schedule-aware behavior does not continue beyond the explicit schedule horizon

### Exit criteria

- docs and live validation guidance are current
- the rollout can be marked complete in the progress doc
