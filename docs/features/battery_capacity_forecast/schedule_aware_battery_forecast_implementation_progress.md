# Schedule-aware Battery Forecast - Implementation Progress

## References

- **Analysis**: [`schedule_aware_battery_forecast_analysis.md`](./schedule_aware_battery_forecast_analysis.md)
- **Implementation strategy**: [`schedule_aware_battery_forecast_implementation_strategy.md`](./schedule_aware_battery_forecast_implementation_strategy.md)
- **Feature overview**: [`README.md`](./README.md)
- **Related live smoke guide**: [`../automation/helman_manual_schedule_live_smoke.md`](../automation/helman_manual_schedule_live_smoke.md)
- **Backend repo**: `/home/ondra/dev/hass/hass-helman/custom_components/helman/`
- **Backend tests**: `/home/ondra/dev/hass/hass-helman/tests/`

## Current status

- Planning is complete.
- The accepted implementation direction is **Option C - pragmatic balance** from the analysis doc.
- The rollout is **backend-only** in `hass-helman`.
- The work is split into **5 increments**.
- Granularity compatibility is a required outcome: a future `SCHEDULE_SLOT_MINUTES` change from `30` to `15` must not require follow-up battery-forecast-specific code changes.
- **Increment 1 is complete.**
- **Increment 2 is complete.**
- **Increments 3-5 are still pending.**
- The next session should start with **Increment 3 - Public response contract and stop-action simulation**.

## Rules for future sessions

When continuing this work in a new session:

1. Read `schedule_aware_battery_forecast_analysis.md`, `schedule_aware_battery_forecast_implementation_strategy.md`, and this file.
2. Implement **exactly one increment**.
3. Run relevant existing repo tests while iterating.
4. Before handing off the increment, run the full backend unit suite:
   - `python3 -m unittest discover -s tests -v`
5. Ask the user to confirm that local Home Assistant has been restarted with the new code before any websocket validation.
6. Only after the user confirms the restart, invoke the `local-hass-api` skill and run the increment-specific websocket validation.
7. Do not hard-code `30`-minute schedule assumptions in the schedule-aware forecast code, tests, or docs; derive behavior from scheduler/forecast granularity constants.
8. During live smoke checks, mutate only the current slot, then always revert it to `normal` and disable execution again.
9. Update this file with the actual implementation notes and validation results before ending the session.
10. Stop after the current increment and wait for review before moving to the next one.

## Increment status

| Increment | Name | Repos | Status | Notes |
|-----------|------|-------|--------|-------|
| 1 | Shared schedule overlay contract | BE | Complete | Added shared action resolution + canonical schedule overlay; automated and live regression validation passed |
| 2 | Coordinator plumbing and cache signatures | BE | Complete | Schedule state now participates in battery-cache dependencies and live regression confirms forecast remains baseline-equivalent externally |
| 3 | Public response contract and stop-action simulation | BE | Pending | Expose schedule-adjusted output for `normal` and `stop_*` behaviors with baseline comparison fields |
| 4 | Target actions and mid-slot crossing | BE | Pending | Add `charge_to_target_soc` and `discharge_to_target_soc`, including paired `stop_*` transitions |
| 5 | Horizon fallback, cache polish, and docs closeout | BE + docs | Pending | Finish horizon-boundary correctness, final cache polish, docs, and closeout smoke validation |

## Increment 1 - Shared schedule overlay contract

- **Status**: Complete
- **Implemented paths**:
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/scheduling/action_resolution.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/scheduling/forecast_overlay.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/scheduling/schedule_executor.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_schedule_forecast_overlay.py`
- **Actual implementation notes**:
  - Added `action_resolution.py` to centralize target-action semantics in a pure helper shared by scheduler execution and the future forecast path.
  - Added `forecast_overlay.py` to prune/materialize the rolling schedule horizon and translate scheduler slots onto canonical forecast slots from `SCHEDULE_SLOT_MINUTES` and `FORECAST_CANONICAL_GRANULARITY_MINUTES`.
  - The overlay behaves as direct canonical lookup when scheduler and forecast granularities match, with no hard-coded `30`-minute assumptions.
  - `ScheduleExecutor` now delegates target-action fallback decisions to the shared resolver, keeping existing runtime behavior unchanged.
  - `helman/get_forecast` was intentionally left untouched in this increment.
- **Actual validation notes**:
  - `python3 -m py_compile custom_components/helman/scheduling/action_resolution.py custom_components/helman/scheduling/forecast_overlay.py custom_components/helman/scheduling/schedule_executor.py tests/test_schedule_forecast_overlay.py` ✅
  - `python3 -m unittest -v tests.test_schedule tests.test_schedule_executor tests.test_schedule_forecast_overlay` ✅
  - `python3 -m unittest discover -s tests -v` ✅
  - New overlay tests cover:
    - current coarser `30 -> 15` expansion behavior
    - future equal-granularity `15 -> 15` direct lookup after module reload
    - preserved target-action windows
    - disabled-execution fallback to `normal`
    - shared target-action fallback semantics for both charge/discharge directions
  - Restart-gated local HA websocket regression validation passed after Home Assistant reload confirmation:
    - `helman/get_schedule` returned a valid `96`-slot horizon with `executionEnabled = false`, current-slot-first ordering, and no runtime metadata while execution remained disabled.
    - `helman/get_forecast` returned the existing baseline battery payload (`status = "partial"`, `resolution = "hour"`) with no premature `scheduleAdjusted`, `baselineSocPct`, or `baselineRemainingEnergyKwh` fields.

## Increment 2 - Coordinator plumbing and cache signatures

- **Status**: Complete
- **Implemented paths**:
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/coordinator.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/battery_capacity_forecast_builder.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_coordinator_battery_forecast_cache.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_coordinator_schedule_execution.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_battery_capacity_forecast_builder.py`
- **Actual implementation notes**:
  - `helman/get_forecast` now loads the pruned schedule document during battery forecast assembly and treats schedule execution state plus explicit pruned slot content as first-class battery-cache dependencies.
  - The coordinator only builds/passes a schedule overlay on cache misses when schedule execution is enabled, preserving the accepted overlay seam without changing the public battery response yet.
  - The battery builder now accepts optional overlay input, but Increment 2 intentionally keeps the simulation baseline-equivalent and does not expose new response fields.
  - Battery forecast cache invalidation now happens on manual schedule mutations and execution toggles in addition to the existing forecast/config invalidation paths.
  - Test-only import scaffolding in the coordinator/builder suites was tightened so the full backend suite can run reliably in one Python process.
- **Actual validation notes**:
  - `python3 -m py_compile custom_components/helman/coordinator.py custom_components/helman/battery_capacity_forecast_builder.py tests/test_coordinator_battery_forecast_cache.py tests/test_coordinator_schedule_execution.py tests/test_battery_capacity_forecast_builder.py` ✅
  - `python3 -m unittest -v tests.test_coordinator_battery_forecast_cache tests.test_coordinator_schedule_execution tests.test_battery_capacity_forecast_builder` ✅
  - `python3 -m unittest discover -s tests -v` ✅
  - Restart-gated local HA websocket regression validation passed after Home Assistant restart confirmation:
    - baseline `helman/get_schedule` returned `executionEnabled = false` with the current slot still at `normal`
    - baseline `helman/get_forecast` returned the existing battery payload shape (`status = "partial"`, `resolution = "hour"`) with no premature `scheduleAdjusted`, `baselineSocPct`, or `baselineRemainingEnergyKwh` fields
    - after mutating only the current slot to `stop_charging` and enabling execution, `helman/get_schedule` reported runtime metadata for the active slot and `helman/get_forecast` still returned the baseline-equivalent battery contract
    - forecast rebuild evidence was visible through fresh `startedAt` / `generatedAt` values after the schedule mutation, showing the schedule-aware cache dependency was active
    - cleanup restored the current slot to `normal`, disabled execution again, and `helman/get_schedule` returned no runtime metadata afterward

## Increment 3 - Public response contract and stop-action simulation

- **Status**: Pending
- **Planned paths**:
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/coordinator.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/battery_capacity_forecast_builder.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/battery_forecast_response.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/forecast_aggregation.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_battery_forecast_response.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_forecast_aggregation.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_forecast_request_contract.py`
- **Planned implementation notes**:
  - Keep the baseline path immutable internally and expose an adjusted path only when execution is enabled.
  - Implement schedule-aware behavior first for `normal`, `stop_charging`, and `stop_discharging`.
  - Expose schedule-adjusted battery values as primary output only when schedule execution is enabled.
  - Add `scheduleAdjusted`, `scheduleAdjustmentCoverageUntil`, `baselineSocPct`, and `baselineRemainingEnergyKwh`.
  - Preserve the request shape and the non-battery forecast sections.
- **Planned validation notes**:
  - Run targeted response/aggregation/forecast-contract tests plus the full backend unit suite.
  - After restart confirmation, use websocket validation with current-slot `stop_charging` and `stop_discharging` scenarios to compare `helman/get_schedule` runtime data with `helman/get_forecast` battery behavior.

## Increment 4 - Target actions and mid-slot crossing

- **Status**: Pending
- **Planned paths**:
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/scheduling/forecast_overlay.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/coordinator.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/battery_capacity_forecast_builder.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_battery_capacity_forecast_builder.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_coordinator_battery_forecast_cache.py`
- **Planned implementation notes**:
  - Implement `charge_to_target_soc` and `discharge_to_target_soc`.
  - Handle target reached at slot start, target reached mid-slot, and fractional first-slot target crossing.
  - Reuse the shared target-semantics helper so executor and forecast stay aligned.
  - Tighten compatibility around active target transitions so the cache does not survive an effective-action change incorrectly.
- **Planned validation notes**:
  - Run targeted battery-builder and cache tests plus the full backend unit suite.
  - After restart confirmation, use websocket validation with current-slot `charge_to_target_soc` and `discharge_to_target_soc` scenarios and confirm runtime metadata matches the adjusted battery behavior.

## Increment 5 - Horizon fallback, cache polish, and docs closeout

- **Status**: Pending
- **Planned paths**:
  - `/home/ondra/dev/hass/hass-helman/docs/features/battery_capacity_forecast/README.md`
  - `/home/ondra/dev/hass/hass-helman/docs/features/automation/helman_manual_schedule_live_smoke.md`
  - `/home/ondra/dev/hass/hass-helman/docs/features/battery_capacity_forecast/schedule_aware_battery_forecast_analysis.md`
- **Planned implementation notes**:
  - Make adjusted behavior fall back to `normal` after the explicit `48h` schedule horizon.
  - Ensure `scheduleAdjustmentCoverageUntil` reflects the actual adjusted horizon.
  - Apply any final cache-compatibility polish uncovered by target-action live testing.
  - Update the feature docs to describe the implemented schedule-aware battery behavior and new response fields.
  - Extend the live smoke guide so it explicitly compares schedule runtime metadata with forecast output.
  - Mark the rollout complete in this file once the final validation passes.
- **Planned validation notes**:
  - Rerun touched tests and the full backend unit suite.
  - After restart confirmation, run one final websocket smoke pass covering baseline, `stop_*`, force-charge, force-discharge, revert, and execution disable.
