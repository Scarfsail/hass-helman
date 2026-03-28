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
- **Increment 3 is complete.**
- **Increment 4 is complete:** backend implementation, targeted validation, review-driven coordinator fixes, and restart-gated websocket validation all passed.
- **Increment 5 is still pending.**
- The next session should resume with **Increment 5**.

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
| 3 | Public response contract and stop-action simulation | BE | Complete | `helman/get_forecast` now exposes stop-action schedule-adjusted battery output plus baseline comparison fields; automated and live validation passed |
| 4 | Target actions and mid-slot crossing | BE | Complete | Target actions now simulate with scheduler-aligned semantics, executable-action gating, safe cache behavior, and live websocket validation passed |
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

- **Status**: Complete
- **Implemented paths**:
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/battery_capacity_forecast_builder.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/forecast_aggregation.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_battery_capacity_forecast_builder.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_battery_forecast_response.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_forecast_aggregation.py`
- **Actual implementation notes**:
  - Refactored the battery builder to materialize canonical slot inputs once, keep the passive baseline simulation immutable, and derive a second action-aware path only when a schedule overlay is present.
  - Implemented schedule-aware battery behavior for `stop_charging` and `stop_discharging` while keeping `normal` baseline-equivalent; `scheduleAdjusted` now flips only once a non-normal stop action actually changes the simulated path.
  - Added top-level `scheduleAdjusted` / `scheduleAdjustmentCoverageUntil` metadata plus per-slot `baselineSocPct` / `baselineRemainingEnergyKwh` when adjusted output is active.
  - Unsupported target actions are still deferred to Increment 4; once one appears after an earlier supported adjustment, the builder now falls back to the immutable baseline tail instead of continuing to emit misleading adjusted values.
  - Extended battery aggregation so baseline comparison fields survive `15 -> 30 -> 60`, and backfilled comparison fields across the whole emitted adjusted series so hourly aggregation cannot fail when a stop action begins mid-bucket.
  - `battery_forecast_response.py` and the `helman/get_forecast` request contract remained behaviorally unchanged beyond passing through the new battery metadata when present.
- **Actual validation notes**:
  - `python3 -m py_compile custom_components/helman/battery_capacity_forecast_builder.py custom_components/helman/forecast_aggregation.py tests/test_battery_capacity_forecast_builder.py tests/test_battery_forecast_response.py tests/test_forecast_aggregation.py` ✅
  - `python3 -m unittest -v tests.test_battery_capacity_forecast_builder tests.test_battery_forecast_response tests.test_forecast_aggregation tests.test_forecast_request_contract` ✅
  - `python3 -m unittest discover -s tests -v` ✅
  - New builder/response coverage now includes:
    - `stop_charging` adjusted output with baseline comparison fields
    - `stop_discharging` adjusted output with baseline comparison fields
    - all-normal overlays staying baseline-equivalent (`scheduleAdjusted = false`)
    - unsupported future target actions falling back cleanly to baseline output
    - mid-hour stop activation with baseline-field backfill so hourly aggregation stays valid
  - Restart-gated local HA websocket validation passed after Home Assistant restart confirmation:
    - baseline `helman/get_schedule` returned `executionEnabled = false` with the current slot still at `normal`
    - baseline `helman/get_forecast` returned the battery section with no exposed `scheduleAdjusted` contract yet (`status = "partial"` in the observed runtime state)
    - after mutating only the current slot to `stop_charging` and enabling execution, `helman/get_schedule` reported `runtime.executedAction = "stop_charging"` and `helman/get_forecast` returned `battery_capacity.scheduleAdjusted = true` with baseline comparison fields present
    - in the observed live conditions, the first `stop_charging` battery point matched the baseline comparison exactly, which is consistent with there being no active charging to suppress in that slot
    - after mutating only the current slot to `stop_discharging` and enabling execution, `helman/get_schedule` reported `runtime.executedAction = "stop_discharging"` and the first battery point returned higher `remainingEnergyKwh` / `socPct` than the baseline comparison fields
    - cleanup restored the current slot to `normal`, disabled execution again, and `helman/get_forecast` returned to the baseline battery contract afterward

## Increment 4 - Target actions and mid-slot crossing

- **Status**: Complete
- **Implemented paths**:
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/coordinator.py`
  - `/home/ondra/dev/hass/hass-helman/custom_components/helman/battery_capacity_forecast_builder.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_battery_capacity_forecast_builder.py`
  - `/home/ondra/dev/hass/hass-helman/tests/test_coordinator_battery_forecast_cache.py`
- **Actual implementation notes**:
  - The battery builder now resolves target actions at slot start via the shared scheduler resolver using **simulated** SoC, so forecast behavior matches executor semantics when a target is already reached.
  - Added explicit target-action simulation for `charge_to_target_soc` and `discharge_to_target_soc`, including forced charge/discharge energy flows, paired `stop_*` remainder handling, and proportional mid-slot splits for both full canonical slots and the fractional first forecast slot.
  - Target actions no longer trigger the previous baseline fallback path; instead, the adjusted series continues through supported target-action slots while still falling back cleanly for genuinely unknown action kinds.
  - The coordinator now normalizes the forecast-facing schedule document to **executable** actions only: if schedule control config is unavailable the battery forecast stays baseline-equivalent, and target-action slots are filtered out when the matching target control option is not configured so `helman/get_forecast` cannot claim behavior that `helman/get_schedule` / execution cannot actually apply.
  - Active executable target slots now bypass battery-forecast cache reuse, which avoids stale first-slot results when the current slot can still cross its target mid-slot even if the slot-start executed action has not changed yet.
  - Disabled schedules still reuse the battery cache because the raw schedule signature is empty whenever execution is off.
  - `forecast_overlay.py` and the public `helman/get_forecast` request contract did not need changes for this increment.
- **Actual validation notes**:
  - `python3 -m py_compile custom_components/helman/battery_capacity_forecast_builder.py custom_components/helman/coordinator.py tests/test_battery_capacity_forecast_builder.py tests/test_coordinator_battery_forecast_cache.py` ✅
  - `python3 -m unittest -v tests.test_battery_capacity_forecast_builder` ✅
  - `python3 -m unittest -v tests.test_coordinator_battery_forecast_cache` ✅
  - `python3 -m unittest discover -s tests -v` ⚠️ still fails in the existing suite because stub-based test modules contaminate later imports when discovery runs them in one Python process (observed `battery_state` and `runtime_status` import errors in builder / schedule-related modules, plus `_FailedTest` discovery fallout). The same isolation issue was also observable earlier in this session when combining targeted suites, so it is not specific to the Increment 4 code changes.
  - Restart-gated local HA websocket validation passed after Home Assistant restart confirmation:
    - baseline `helman/get_schedule` / `helman/get_forecast` were reset to `executionEnabled = false`, current slot `normal`, and no `scheduleAdjusted = true`; the live current SoC was `21%`, which gave runtime-safe targets of `61%` for charging and `15%` for discharging.
    - after mutating only the current slot to `charge_to_target_soc(61)` and enabling execution, `helman/get_schedule` reported `runtime.executedAction.kind = charge_to_target_soc` with reason `scheduled`, and `helman/get_forecast` returned `scheduleAdjusted = true` with the first battery point charging to `remainingEnergyKwh = 5.0932` from a `baselineRemainingEnergyKwh = 3.7162` and `importedFromGridKwh = 1.4495`.
    - after mutating only the current slot to `discharge_to_target_soc(15)` and enabling execution, `helman/get_schedule` reported `runtime.executedAction.kind = discharge_to_target_soc` with reason `scheduled`, and `helman/get_forecast` returned `scheduleAdjusted = true` with the first battery point discharging to `remainingEnergyKwh = 2.5914` from a `baselineRemainingEnergyKwh = 3.7159` and `exportedToGridKwh = 1.0773`.
    - cleanup restored the current slot to `normal`, disabled execution again, and `helman/get_forecast` returned to the baseline battery contract afterward.

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
