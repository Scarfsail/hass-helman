# Helman Automation - Optimizer Pipeline Implementation Plan

Companion to [`helman_automation_optimizer_pipeline_architecture.md`](helman_automation_optimizer_pipeline_architecture.md).

This document breaks the architecture into small, independently implementable, independently testable, and independently commitable phases. Each phase is scoped so that the repo stays shippable after every commit.

## How to use this document

Each phase block below has the same shape:

- **Goal** — what this increment delivers
- **Files** — concrete files created / modified
- **Design notes** — non-obvious decisions
- **Unit tests** — new/extended `unittest` tests to write
- **Local HASS smoke test** — websocket commands to exercise after a HASS restart
- **Done criteria** — how you know the increment is complete

### Ritual for every phase

Every phase follows the same closing ritual before the commit lands:

1. Implement the increment.
2. Add / update unit tests for the increment. Run the full suite:
   ```bash
   python3 -m unittest discover -s tests -v
   ```
   All tests must pass before moving on.
3. Ask the user to restart local HASS. After the user confirms the restart, run the **Local HASS smoke test** steps for the phase via the HASS websocket API. Capture the observed responses in the session for review.
4. If the smoke test surfaced behavior that diverges from the architecture doc, **update [`helman_automation_optimizer_pipeline_architecture.md`](helman_automation_optimizer_pipeline_architecture.md) to reflect reality**. Do not silently absorb the divergence.
5. If the phase introduces or materially changes operator-facing config and it makes sense to expose that change in visual mode, **update the frontend config editor in the same phase** and rebuild `custom_components/helman/frontend/dist/helman-config-editor.js` before the commit. Do not leave UI catch-up as an implicit later cleanup task.
6. Mark the phase as **Done** in this file by checking its status box and appending a short note with the commit SHA once committed.
7. Re-read the remainder of this document and adjust any later phases whose assumptions have changed (file paths, class names, config keys, invariants).
8. Commit. One phase = one commit. Commit message format: `feat(automation): phase N - <short title>`.

### Websocket smoke test harness (reference)

Throughout the plan, "run command `X`" means: connect to the local HASS instance (`http://127.0.0.1:8123`) as an admin user and send the JSON payload over the authenticated websocket. The smoke steps list the exact payload shape. If a new websocket command is added in a phase, it is listed in that phase.

The pre-existing commands used repeatedly in smoke tests are:

- `helman/get_schedule`
- `helman/set_schedule`
- `helman/set_schedule_execution`
- `helman/get_forecast`
- `helman/get_appliances`
- `helman/get_appliance_projections`

---

## Phase status overview

- [x] **Phase 0** — Forecast input bundle capture _(commit 930a)_
- [x] **Phase 1** — Scaffolding, config schema, feature flag plumbing _(committed; SHA recorded in session handoff)_
- [x] **Phase 2** — Config editor UI for automation config _(commit c386936; local HASS smoke passed)_
- [x] **Phase 3** — Snapshot + runner skeleton (no optimizers, no persistence) _(local HASS smoke passed; SHA in git history)_
- [x] **Phase 4** — Automation-owned action ownership invariant in persistence path _(local HASS smoke passed)_
- [x] **Phase 5** — `export_price` optimizer (single-optimizer only) _(local HASS smoke passed; stricter price-only behavior validated live after restart)_
- [x] **Phase 6** — Rebuild-between-optimizers loop wiring _(commit c8a90c7; local HASS smoke passed)_
- [ ] **Phase 7** — `surplus_appliance` optimizer (generic + climate)
- [ ] **Phase 8** — Coordinator triggers (startup, execution-enable, slot refresh, post-user-edit) with coalescing
- [ ] **Phase 9** — Observability + `helman/run_automation` debug websocket command
- [ ] **Phase 10** — End-to-end hardening and docs sync

Each phase's "Done" box is checked as part of the ritual in step 5 above.

---

## Phase 0 — Forecast input bundle capture

### Goal

Create the coordinator-owned automation input bundle that later automation runs pin at run start. This phase adds no optimizer behavior and no new public API; it only makes the required refresh-derived inputs real and stable.

### Files

Create:

- `custom_components/helman/automation/__init__.py` — empty package marker so the shared automation input bundle type has a stable home before the rest of the automation package lands.
- `custom_components/helman/automation/input_bundle.py` — defines a frozen `AutomationInputBundle` dataclass carrying the latest refresh-derived automation inputs: fixed original unadjusted house forecast baseline, canonical solar forecast, canonical grid price forecast, and `when_active_hourly_energy_kwh_by_appliance_id` for eligible generic/climate appliances.
- `tests/test_automation_input_bundle.py`

Modify:

- `custom_components/helman/coordinator.py` — add coordinator-owned cached automation inputs and a small helper such as `async def _async_refresh_automation_input_bundle(...)` that updates them from the latest successful refresh path.
- `custom_components/helman/coordinator.py` — extend the slot-aligned refresh path so a successful refresh captures the full bundle by combining the persisted/cached house forecast snapshot with canonicalized solar + grid price forecasts and a resolved per-appliance when-active hourly energy map.
- `custom_components/helman/coordinator.py` — introduce a resolver that precomputes when-active hourly energy for all configured generic/climate appliances eligible for automation/projection decisions, not only appliances that already appear in the current schedule. Apply fixed/history/fallback semantics here so later rebuilds do not need recorder I/O.

### Design notes

- The bundle is **coordinator-owned cached state**, not a per-run mutable object. Later automation phases pin one copy at run start and reuse that same pinned bundle for every rebuild in the run.
- Capturing the bundle on the refresh path is intentional. Fresh `HelmanForecastBuilder` calls and recorder-backed history estimation may happen here; they must not happen inside the automation rebuild loop later.
- The bundle must include the real inputs later phases need: original unadjusted house forecast baseline, canonical solar forecast, canonical grid price forecast, and `when_active_hourly_energy_kwh_by_appliance_id`.
- `when_active_hourly_energy_kwh_by_appliance_id` must cover candidate generic/climate appliances even when they are not yet scheduled. Building it only from currently scheduled appliances would make `surplus_appliance` unable to evaluate a brand-new candidate write.
- Do **not** reuse the current schedule-driven `_async_build_history_projection_hourly_energy_by_appliance_id(...)` helper for bundle capture; it walks `_iter_projected_history_appliances(...)` and would silently miss unscheduled candidates. Phase 0 should resolve the map by iterating the eligible appliance registry directly.
- If a refresh fails to assemble the bundle, keep the last successful bundle rather than replacing it with partial or empty state.
- Existing public APIs (`helman/get_forecast`, `helman/get_appliance_projections`) must stay behaviorally unchanged in this phase.

### Unit tests (`tests/test_automation_input_bundle.py`)

- successful bundle refresh captures canonical house baseline, canonical solar forecast, and canonical grid price forecast
- the resolved `when_active_hourly_energy_kwh_by_appliance_id` includes eligible generic/climate appliances even when none of them are scheduled yet
- history-average appliances preserve the existing fixed/history/fallback resolution semantics when the map is built
- a failed bundle refresh leaves the previous successful bundle intact
- existing forecast/projection public paths keep their current behavior after the refactor

### Local HASS smoke test

After restart:

1. `helman/get_forecast` — still succeeds and returns the same public payload shape as before.
2. `helman/get_appliance_projections` — still succeeds and returns the same public payload shape as before.
3. Wait for the next `00/15/30/45` refresh boundary and repeat both calls — no public regression, no new user-visible automation behavior.

### Done criteria

- Unit tests green.
- The coordinator owns a real cached automation input bundle for later phases.
- Existing public forecast/projection APIs show no behavioral regression.

---

## Phase 1 — Scaffolding, config schema, feature flag plumbing

### Goal

Introduce the initial automation config surface now that the package exists, so later phases have a home. No runtime behavior is added.

### Files

Create:

- `custom_components/helman/automation/config.py` — pure, side-effect-free parsing of the `automation` config block into a frozen `AutomationConfig` dataclass with `enabled: bool = True` and an ordered list of `OptimizerInstanceConfig` entries (id, kind, enabled, params). Unknown optimizer kinds are rejected here with a descriptive validation error; kind-specific param validation is added in the optimizer phase that introduces that kind.
- `custom_components/helman/automation/optimizer.py` — defines the `Optimizer` protocol (`kind`, `id`, `optimize(snapshot, config) -> ScheduleDocument`) and an empty `KNOWN_OPTIMIZER_KINDS` set. No optimizer implementations yet.
- `tests/test_automation_config.py` — new unittest file.

Modify:

- `custom_components/helman/config_validation.py` — extend `validate_config_document` to tolerate an optional top-level `automation` object. For Phase 1, `AutomationConfig.from_dict` becomes the authoritative validator for `automation.enabled`, optimizer ordering, optimizer ids, and known optimizer kinds. No new required fields are introduced; `enabled` defaults to `true` when the `automation` block is present.

### Design notes

- `AutomationConfig` must be **entirely derivable from the config document**. No HASS dependency, no I/O. That keeps it trivially unit-testable and reusable.
- If the `automation` block is present and `enabled` is omitted, default it to `true`. If the entire `automation` block is absent, automation is treated as disabled.
- `optimizers` list order is execution order. `id` uniqueness is enforced at parse time.
- `enabled: false` instances are parsed but filtered out of the execution order at parse time so downstream code never sees them.
- Unknown `kind` values should produce a clear validation error (not silent drop) so typos in config surface immediately.

### Unit tests (`tests/test_automation_config.py`)

- parses a minimal valid `automation` block with zero optimizers and `enabled=True` by default
- parses a block with two optimizers, preserves order
- preserves an explicit top-level `enabled: false`
- rejects duplicate optimizer ids
- drops instances with `enabled: false` from the execution order
- rejects unknown optimizer kinds with a descriptive error
- is a no-op when `automation` is absent from the config document
- feeds through `validate_config_document`: a config with `automation` block passes `helman/validate_config`

### Local HASS smoke test

After restart:

1. `helman/get_config` — confirm it round-trips an `automation` block if present, including `enabled`. In Phase 1, keep the smoke payload to `optimizers: []`.
2. `helman/validate_config` with a doc that includes a valid `automation` block → returns `valid: true`.
3. `helman/validate_config` with `automation.optimizers[0].kind: "does_not_exist"` → returns `valid: false` with an error mentioning the unknown kind.
4. `helman/save_config` with a valid `automation` block → succeeds and reload completes.

### Done criteria

- Unit tests green.
- Config round-trips through the websocket API.
- No observable change to existing schedule or forecast behavior.

---

## Phase 2 — Config editor UI for automation config

### Goal

Expose the Phase 1 `automation` config block in the existing Helman config panel so it can be loaded, edited, validated, saved, and reloaded end to end before any automation runtime behavior exists. This is still a config-only increment: no runner, no triggers, no schedule mutations.

### Files

Modify:

- `custom_components/helman/frontend/src/config-editor-scopes.ts` — add a top-level `automation` tab and section scopes rooted under the `automation` branch so the existing scoped YAML/visual editor infrastructure can target it cleanly.
- `custom_components/helman/frontend/src/helman-config-editor.ts` — render the new Automation tab. In visual mode, expose the stable top-level surface now (`automation.enabled`) and a small optimizer-pipeline section that stays YAML-first until real optimizer kinds and per-kind param UIs arrive in later phases.
- `custom_components/helman/frontend/src/localize/translations/en.json` — add labels, helper text, empty-state text, and notes for the new Automation tab and sections.
- `custom_components/helman/frontend/src/localize/translations/cs.json` — Czech equivalents for the same Automation tab/section strings.
- `tests/test_config_editor_contract.py` — extend the editor-facing backend contract tests with automation round-trip cases that match how the panel uses `helman/get_config`, `helman/validate_config`, and `helman/save_config`.
- `custom_components/helman/frontend/dist/helman-config-editor.js` — rebuilt production bundle after the frontend source changes.

### Design notes

- Put automation on its own top-level tab, not under Scheduler. The config branch is top-level, and later phases will add optimizer-specific UI here.
- Phase 2 is intentionally the first **end-to-end config increment** only. It consumes the Phase 1 config schema and must not introduce automation runner code, debug websocket commands, or any schedule/forecast behavior changes.
- Visual mode in this phase should cover only the stable surface that already exists in Phase 1: `automation.enabled`. The ordered `optimizers` list should remain YAML-first until concrete optimizer kinds and param schemas land; do not build a throwaway generic object-list UI that later phases would immediately replace.
- When the config document has no `automation` branch, the UI should present automation as disabled. Enabling it should materialize an `automation` object with `enabled: true` and `optimizers: []`. Disabling an existing branch should set `enabled: false` but preserve any configured optimizer list so work-in-progress pipelines are not lost.
- The optimizer list editor must preserve order and unknown future keys/kinds exactly. This phase should not prune or rewrite optimizer entries beyond whatever backend validation already does.
- Reuse the existing config-editor architecture: scope adapters for branch-level YAML editing, the same one-time localization setup, and the same panel packaging flow with a rebuilt committed `dist/helman-config-editor.js`.
- Because this is a frontend phase, run `npm run build` in `custom_components/helman/frontend` and commit the rebuilt bundle together with the source changes.
- There is no dedicated frontend unit-test harness in this repo today. For this phase, Python contract tests plus the rebuilt panel bundle and manual panel smoke test are the intended validation surface.

### Unit tests (`tests/test_config_editor_contract.py`)

- `helman/get_config` returns a stored config containing an `automation` block unchanged, so the panel can hydrate the new Automation tab without special backend translation
- `helman/save_config` persists a minimal valid automation config such as `{ enabled: true, optimizers: [] }`
- `helman/save_config` preserves an existing `optimizers` array when the UI sets `automation.enabled: false`
- `helman/validate_config` still reports an unknown optimizer kind error for an Automation-tab payload, matching what the YAML editor will surface in the panel
- absence of the `automation` branch continues to round-trip unchanged so the UI can interpret "missing branch" as "disabled by default"

### Local HASS smoke test

After restart:

1. Open the Helman config panel and confirm a new **Automation** tab is visible.
2. In the Automation tab visual mode, enable automation and save/reload.
3. `helman/get_config` — confirm the stored config now includes `automation: { enabled: true, optimizers: [] }`.
4. Reload the panel and confirm the Automation tab still shows the saved state.
5. Switch the optimizer-pipeline section to YAML mode, enter a payload with an invalid optimizer kind such as `kind: "does_not_exist"`, run validation, and confirm the panel surfaces the backend validation error instead of silently accepting it.

### Done criteria

- The config panel exposes an Automation tab with no regression in existing tabs.
- `automation.enabled` can be edited and saved from the UI end to end.
- The optimizer list is editable/preservable through YAML mode without losing ordering or unknown keys.
- The frontend bundle is rebuilt and committed.
- No schedule, forecast, or automation runtime behavior changes are observable yet.

### Status note

- Code implementation, frontend bundle rebuild, and focused config-panel/backend tests landed together in the Phase 2 commit.
- Local HASS smoke passed on the running instance; the checkbox is now closed.

---

## Phase 3 — Snapshot + runner skeleton (no optimizers, no persistence)

### Goal

Introduce the full `OptimizationSnapshot` contract and the `AutomationRunner` skeleton that can:

- acquire the schedule lock
- load the persisted `ScheduleDocument`
- build a working in-memory copy
- call the existing forecast pipeline once to produce the initial snapshot
- return the run result without writing anything

No optimizers run. No persistence is changed. This phase exists to prove that the automation runner can reuse the existing forecast pipeline helpers cleanly.

### Files

Create:

- `custom_components/helman/automation/snapshot.py` — defines a frozen `OptimizationSnapshot` dataclass, its `OptimizationContext`, and a `snapshot_to_dict()` helper used by debug websocket responses. Lock the v1 contract here: `schedule`, `adjusted_house_forecast`, `battery_forecast`, `grid_forecast`, and `context { now, battery_state, solar_forecast, import_price_forecast, export_price_forecast, appliance_registry, when_active_hourly_energy_kwh_by_appliance_id }`, where `appliance_registry` is the source of appliance capabilities and authored DTO shape, while `when_active_hourly_energy_kwh_by_appliance_id` is the run-scoped demand-input surface pinned from the coordinator bundle. Keep any fixed rebuild-only baseline inputs (for example the original unadjusted house forecast) outside this public snapshot contract unless an optimizer truly needs to read them.
- `custom_components/helman/automation/pipeline.py` — defines a minimal `AutomationRunResult` envelope (`ranAutomation`, `reason`, `snapshot`) and `AutomationRunner` with one public coroutine `async run(*, reference_time) -> AutomationRunResult`. Phase 3 introduces the stable envelope immediately so later phases can enrich it without changing call sites.
- `tests/test_automation_pipeline_skeleton.py`

Modify:

- `custom_components/helman/coordinator.py` — extract the lower-level schedule -> projection -> adjusted-house -> battery/grid build steps so they can be reused in two modes:
  - the existing public/shared-cache forecast path
  - a new automation-only ephemeral path that never publishes intermediate state into shared forecast caches
- `custom_components/helman/coordinator.py` — add a new `async def _build_automation_snapshot_from_schedule_locked(...) -> OptimizationSnapshot` helper that takes an explicit `schedule_document` plus a coordinator-owned forecast input bundle captured from the last successful refresh (fixed original house forecast baseline, canonical solar forecast, canonical grid price forecast, and `when_active_hourly_energy_kwh_by_appliance_id`), assembles the full snapshot contract (including `grid_forecast` and live context), and reuses the existing lower-level builders without mutating shared caches.
- `custom_components/helman/coordinator.py` — `_async_get_appliance_forecast_pipeline` and `get_forecast()` remain thin wrappers over the shared-cache forecast path so existing forecast behavior and cache signatures do not change.
- `custom_components/helman/coordinator.py` — add `async def run_automation(self, *, reference_time=None)` that instantiates `AutomationRunner` with the coordinator and the current `AutomationConfig`. Not yet wired to any trigger. Guarded by `execution_enabled`, and it returns a non-running result if the required forecast input bundle is unavailable instead of performing fresh forecast I/O on the automation path.

### Design notes

- The runner owns the schedule lock for the full read/rebuild portion of the run. It calls the new automation snapshot builder while holding it.
- The runner **must not** call `_async_get_appliance_forecast_pipeline` directly, because that method re-acquires the lock and uses shared-cache behavior intended for public forecast endpoints.
- The runner acquires `_schedule_lock` once at the top, does all schedule read/rebuild work under it, and later phases release it before invoking any shared post-write side effects that may re-enter schedule locking.
- Automation snapshot rebuilds must use ephemeral/local state only. A debug or failed automation run must never change what `helman/get_forecast` or `helman/get_appliance_projections` returns.
- The runner consumes a coordinator-owned forecast input bundle pinned at run start rather than calling `HelmanForecastBuilder` or recorder-backed I/O inside the automation path. At minimum this bundle carries the fixed original unadjusted house forecast baseline, canonical solar forecast, canonical grid price forecast, and `when_active_hourly_energy_kwh_by_appliance_id`.
- Every rebuild in later phases must start from that same original unadjusted house forecast baseline. Never feed a previously adjusted house forecast into the next rebuild step.
- In the automation snapshot builder, `grid_forecast` is composed from two pieces: grid flow derived from the automation battery forecast, plus canonical grid price forecast data from the same coordinator-owned input bundle.
- The automation battery-forecast path must apply the same `_build_battery_forecast_schedule_document(...)` filtering semantics (or an extracted equivalent helper) as the public forecast path before building the battery schedule overlay, so non-executable target-SoC actions do not leak into optimizer inputs.
- `OptimizationSnapshot.context.appliance_registry` remains the canonical capability surface for optimizers; `context.when_active_hourly_energy_kwh_by_appliance_id` is the canonical pinned demand-input surface. Do not re-introduce recorder reads during rebuilds once this split exists.
- `snapshot_to_dict()` is the only serializer for snapshot websocket output. Do not let each caller invent its own JSON shape.
- `AutomationRunResult` is introduced in Phase 3 even though it is minimal. Later phases extend it rather than changing the `run()` return type.
- Phase 3 returns only a snapshot-bearing result — it does not yet strip previous automation actions, because Phase 4 owns the ownership invariant.

### Unit tests (`tests/test_automation_pipeline_skeleton.py`)

- `AutomationRunner.run` returns `{ ranAutomation: false, reason: "execution_disabled", snapshot: null }` when `execution_enabled=False`
- `AutomationRunner.run` returns `{ ranAutomation: false, reason: "automation_disabled", snapshot: null }` when `automation.enabled=False`
- `AutomationRunner.run` returns `{ ranAutomation: false, reason: "inputs_unavailable", snapshot: null }` when the coordinator does not yet have a usable forecast input bundle for the automation path
- `AutomationRunner.run` with a persisted baseline schedule returns `{ ranAutomation: true, snapshot: ... }` whose `snapshot.schedule` equals the persisted document
- the returned snapshot contains non-empty `adjusted_house_forecast`, `battery_forecast`, `grid_forecast`, and the locked `context` fields (populated from mocked builders / stubs), with `grid_forecast` composed from battery-derived grid flow plus canonical price inputs and `when_active_hourly_energy_kwh_by_appliance_id` pinned from the cached bundle
- running twice in a row returns results whose snapshots have the same schedule (no hidden mutation)

Tests should stub the forecast builders the same way `tests/test_coordinator_schedule_execution.py` does.

### Local HASS smoke test

No production trigger yet, so add a **temporary debug websocket command** `helman/__debug_run_automation` (registered only when a new `HELMAN_AUTOMATION_DEBUG` env var is set, or behind a clearly temporary flag) that invokes `coordinator.run_automation()` and returns the `AutomationRunResult` as JSON for inspection. **This debug command is introduced in this phase purely as a smoke hook; its long-term home is Phase 9.**

After restart, with `executionEnabled: true`:

1. `helman/__debug_run_automation` → expect `{ ranAutomation: true, snapshot: ... }` where `snapshot` comes from `snapshot_to_dict()` and includes `scheduleSlots`, `adjustedHouseForecast.status == "available"`, `batteryForecast` carrying the live pipeline status (for example `"available"` or `"partial"`), and `gridForecast`.
2. Toggle `helman/set_schedule_execution` to `enabled: false` and call `helman/__debug_run_automation` again → expect a response shaped `{ "ranAutomation": false, "reason": "execution_disabled" }`.
3. Re-enable execution and confirm automation runs again.

### Done criteria

- Unit tests green.
- Existing forecast APIs still use only the persisted schedule and have no behavioral change after the refactor.
- Smoke test returns a valid snapshot via the debug command.
- Architecture doc still accurate; otherwise updated.

---

## Phase 4 — Automation-owned action ownership invariant in persistence path

### Goal

Guarantee that automation can only touch action positions that are empty or already `setBy=automation`, at the granularity of `(slot_id, "inverter")` and `(slot_id, "appliances", appliance_id)`. This phase wires the ownership rule into the persistence path **before any optimizer exists**, so the invariant is proven by tests independent of any optimizer logic.

### Files

Create:

- `custom_components/helman/automation/ownership.py` — pure helpers:
  - `strip_automation_owned_actions(doc: ScheduleDocument) -> ScheduleDocument`
  - `merge_automation_result(*, baseline: ScheduleDocument, automation_result: ScheduleDocument) -> ScheduleDocument` that refuses (raises `ScheduleActionError`) if automation tries to overwrite a user-owned key.
- `tests/test_automation_ownership.py`

Modify:

- `custom_components/helman/automation/pipeline.py` — at the top of `run()`, after loading the baseline schedule, build the working schedule by calling `strip_automation_owned_actions`. The result is the working schedule used to build the initial snapshot. No merge-back yet (no optimizers write), so `merge_automation_result` is only exercised by unit tests in this phase.
- `custom_components/helman/coordinator.py` — `set_schedule` path unchanged for `set_by="user"` except for extracting a small shared post-schedule-write side-effect helper that runs cache invalidation and reconciliation **outside** `_schedule_lock`, matching the existing `set_schedule` behavior.
- `custom_components/helman/coordinator.py` — add a new private `async def _persist_automation_result_locked(self, automation_result: ScheduleDocument) -> bool` that:
  1. loads the latest baseline under the already-held lock
  2. validates automation-produced changes with the same strict slot/domain rules used by user-authored schedule writes (including strict appliance validation)
  3. calls `merge_automation_result`
  4. runs the merged result back through the canonical persisted-document normalization / validation path, saves the canonical merged document, and returns whether the persisted document changed
  This helper is first called from the manual/debug runner path in Phase 5. Production triggers arrive in Phase 8.

### Design notes

- Ownership keys are per action position, not per slot. A slot can legitimately contain `inverter: setBy=user` and `appliances.boiler: setBy=automation` simultaneously.
- `strip_automation_owned_actions` iterates slots and:
  - drops `domains.inverter` (replaces with `EMPTY_SCHEDULE_ACTION`) iff its `set_by == "automation"`
  - drops any appliance entry in `domains.appliances` whose action's `set_by == "automation"`
  - removes a slot entirely if both domains become empty (`is_default_domains`)
- `merge_automation_result` compares position-by-position and treats `set_by=user` as absolute. Any attempt by automation to write over a user-owned key raises. This raise must be loud — it indicates an optimizer bug, not a user error.
- Any explicit persisted authored action whose `setBy` is missing must also be treated as user-owned for overwrite protection. Implicit default / empty positions remain writable.
- All automation-produced actions carry `set_by="automation"` before being merged. The merge helper re-stamps **unconditionally** to be safe and must not reuse `with_slot_set_by` / `with_appliance_schedule_actions_set_by`, because those helpers intentionally preserve existing ownership for the user-edit path.
- Strict validation of automation-produced changes happens before merge. Invalid appliance actions or unsupported appliance ids must fail loudly here rather than being silently pruned later by the persisted-document load/prune normalization path.
- Do not maintain a separate automation-only cache invalidation list. `_persist_automation_result_locked` must save only while `_schedule_lock` is held; the caller then runs the shared post-save side-effect helper after releasing the lock so public forecast/projection endpoints stay coherent without re-entering the schedule lock.
- Before Phase 4 is considered complete, copy the "missing `setBy` means user-owned explicit authored action" compatibility rule into the architecture doc and add a short migration note there.

### Unit tests (`tests/test_automation_ownership.py`)

- `strip_automation_owned_actions` removes inverter actions with `setBy=automation`, preserves `setBy=user` and unset
- `strip_automation_owned_actions` removes appliance entries with `setBy=automation` at the appliance-id granularity, preserves user-owned ones in the same slot
- `strip_automation_owned_actions` drops a slot entirely if it becomes default after stripping
- `merge_automation_result` writes new automation-owned inverter action into an empty slot
- `merge_automation_result` writes a new automation-owned appliance action into a slot whose inverter is user-owned (ownership is per key, not per slot)
- `merge_automation_result` refuses to overwrite a user-owned inverter action and raises
- `merge_automation_result` refuses to overwrite a user-owned appliance action of the same appliance_id
- `merge_automation_result` refuses to overwrite explicit authored actions whose `setBy` is missing
- `merge_automation_result` always stamps `set_by="automation"` on emitted changes
- coordinator-level persistence test: automation persistence reuses the same post-save side effects as user-authored `set_schedule`, with those side effects executed only after the caller releases `_schedule_lock`
- coordinator-level persistence test: `_persist_automation_result_locked` refuses to overwrite an explicit authored action whose `setBy` is missing
- coordinator-level persistence test: `_persist_automation_result_locked` rejects invalid automation-produced appliance actions or unsupported appliance ids during strict validation instead of silently pruning them

### Local HASS smoke test

This phase introduces no user-visible change. The smoke focus is: **prove that `set_schedule(set_by="user")` still works and that no existing slot got its `setBy` flipped**.

After restart:

1. `helman/get_schedule` — capture baseline.
2. `helman/set_schedule` with a user-authored slot patch for the current horizon. Include a target slot whose action you can inspect.
3. `helman/get_schedule` again — the patched slot's `setBy` must be `"user"`.
4. `helman/__debug_run_automation` from Phase 3 — still returns a snapshot, and `get_schedule` afterwards is byte-for-byte identical to before (no optimizers run yet → no mutation).

### Done criteria

- Unit tests green.
- Existing `test_schedule_*` and `test_coordinator_schedule_execution` tests still pass.
- Smoke test shows `setBy` is preserved across runner executions.
- The architecture doc explicitly records the missing-`setBy` compatibility rule before the phase ships.

---

## Phase 5 — `export_price` optimizer (single-optimizer only)

### Goal

Implement the first optimizer, `export_price`, as a **pure function** that takes the snapshot and its config and returns an updated `ScheduleDocument`. The runner is still called only via the debug websocket command — no triggers yet. To keep this phase shippable, it supports only one enabled optimizer instance at a time; multi-optimizer composition lands in Phase 6.

### Files

Create:

- `custom_components/helman/automation/optimizers/__init__.py`
- `custom_components/helman/automation/optimizers/export_price.py`
  - `ExportPriceOptimizer` implementing the `Optimizer` protocol
  - reads `snapshot.context.export_price_forecast`
  - writes inverter actions only to action positions that are empty or automation-owned
  - uses `stop_export` when `ScheduleControlConfig.stop_export_option` is available; otherwise skips the affected slot(s) and logs a warning rather than guessing an alternate inverter action
- `tests/test_automation_optimizer_export_price.py`

Modify:

- `custom_components/helman/automation/config.py` — add param schema for `export_price`: `when_price_below: float`, `action: Literal["stop_export"]` (v1 only value), optional defaults.
- `custom_components/helman/automation/optimizer.py` — register `ExportPriceOptimizer` in `KNOWN_OPTIMIZER_KINDS`.
- `custom_components/helman/automation/pipeline.py` — if `automation.enabled=False` or no enabled optimizer instances remain, perform a cleanup-only run: strip previous automation-owned actions, compare the stripped document directly with the loaded baseline, persist the cleaned schedule under lock only if it changed, then release the lock and run the shared post-write side effects before returning a non-running result. Otherwise, require exactly one enabled optimizer instance in this phase, call it once, persist via `_persist_automation_result_locked`, release `_schedule_lock`, and run the shared post-write side effects only if the locked persist reported a change. If more than one enabled optimizer is configured, fail the run with a clear Phase 5-only error explaining that multi-optimizer support lands in Phase 6.

### Design notes

- The optimizer **reads** the forecast-side of the snapshot, but **writes** only to `snapshot.schedule`. It returns a new `ScheduleDocument`; it does not mutate in place.
- Treat non-mutating behavior as a real contract, not just a style preference. The optimizer must return a new `ScheduleDocument` and leave `snapshot.schedule` untouched; add regression tests for this instead of relying on hidden runner-side deep copies.
- The optimizer must never write into a slot position that is user-owned. This is enforced by the optimizer itself (early skip) and re-enforced at merge time. Defensive: optimizer-level skip keeps decision logic honest even before merge.
- `export_price` is intentionally conservative: if a canonical export-price bucket is below the configured threshold, the optimizer writes `stop_export` for the owning schedule slot regardless of whether the current rebuild predicts non-zero exported energy there. Forecast misses must not allow an accidental negative-price export.
- `when_price_below` is interpreted in the same currency unit as `grid_price_forecast.exportPriceUnit`. No unit conversion — if the configured threshold and the forecast unit disagree, the optimizer raises.
- If `stop_export` is unavailable for the current control mapping, v1 logs a warning and skips those slot writes. Do not guess an alternate inverter action in this phase.
- Slot horizon is the already-existing rolling schedule horizon. The optimizer must not invent its own window.
- Phase 5 intentionally rejects configs with more than one enabled optimizer instance. That temporary guard is removed in Phase 6 once rebuild-between-optimizers exists.
- If the single optimizer raises, the runner aborts the run, does **not** persist, and returns a failure result. The baseline on disk remains unchanged.
- Cleanup-only is a dedicated branch: compare the loaded baseline with `strip_automation_owned_actions(baseline)` and persist only when they differ. Do not route cleanup-only through `merge_automation_result`, because "remove stale automation" is a different semantic from "optimizer authored zero new writes".
- Persistence is wired in this phase, but **no production trigger is connected yet**. The self-retrigger guard lands in Phase 8 by scoping the immediate post-edit trigger to successful user-authored `set_schedule(set_by="user")` writes only. Do not wire production triggers in Phase 5.

### Unit tests

- baseline snapshot with export price forecast all positive and `when_price_below=0` → optimizer returns an unchanged schedule
- baseline with export price forecast containing a negative window → optimizer writes `stop_export` inverter actions for exactly those slots, stamped `setBy=automation`
- baseline with a below-threshold price window but zero forecasted export in that bucket → optimizer still writes `stop_export` for the owning slot
- optimizer leaves user-owned inverter slots untouched even if their window overlaps a negative-price slot
- optimizer refreshes its own prior automation-owned actions (they've already been stripped by Phase 4's `strip_automation_owned_actions`, so this is implicitly tested by running twice)
- optimizer with `stop_export` missing from the control mapping skips writes for those slots and logs a warning
- optimizer does not mutate `snapshot.schedule` in place
- optimizer produces slot ids strictly inside the existing horizon
- Phase 5 runner rejects configs with more than one enabled optimizer instance
- if the optimizer raises, the runner does not persist and returns a failure result

### Local HASS smoke test

After restart, with a real grid export price forecast available:

1. Configure `automation.optimizers` with a single `export_price` instance, `when_price_below: 0.0`. Save via `helman/save_config`.
2. `helman/__debug_run_automation` → inspect the returned snapshot: any slots where export price is below `0.0` should now carry an inverter action with `kind: stop_export` and `setBy: automation` when that control option is supported, regardless of whether the current forecast predicts positive exported energy there; otherwise the run logs a warning and leaves those slots untouched.
3. `helman/get_schedule` → confirm those same slots are now persisted with `setBy: automation`.
4. `helman/set_schedule` with a `setBy: user` inverter action for one of those same slots.
5. `helman/__debug_run_automation` again → the user slot must be preserved as `setBy: user`; the automation-owned siblings in other slots may be refreshed.
6. Change `automation.enabled` to `false` **or** disable the only optimizer in config, save, restart, `helman/__debug_run_automation` → all previously-automation-owned inverter actions are stripped and not replaced; user-owned slots remain intact.

Observed on 2026-04-13:

- The exact `when_price_below: 0.0` live smoke did return a real snapshot after the post-reload quarter-hour refresh, but the live export-price forecast contained no negative points, so no `stop_export` slots were authored in that run.
- A supplemental live smoke with `when_price_below: 100.0` exercised the end-to-end persistence path anyway: the first debug run authored 13 `stop_export` slots with `setBy: automation`, a user overwrite on one of those slots remained `setBy: user` after the next debug rerun, and disabling the only optimizer triggered cleanup-only removal of the remaining automation-owned slots while preserving the user-owned slot.

### Done criteria

- Unit tests green.
- Smoke test confirms the `setBy=user` absolute ownership invariant under real HASS and cleanup-only behavior when automation is disabled.
- Architecture doc's description of `export_price` still matches implementation; if the unsupported-control behavior differs from the arch doc's wording, update the arch doc.

### Status note

- The conservative `export_price` behavior now keys off below-threshold price alone: after a local HASS restart with `when_price_below: 1.5`, a live debug run authored 8 automation `stop_export` slots (`12:00` through `15:30`, including `13:00`), confirming the stricter fail-safe policy is active end to end.

---

## Phase 6 — Rebuild-between-optimizers loop wiring

### Goal

Make the runner rebuild the snapshot between optimizer steps so subsequent optimizers see the effect of earlier ones. This phase unlocks correct composition even though only `export_price` exists so far.

### Files

Modify:

- `custom_components/helman/automation/pipeline.py` — replace the simple for-loop with:
  ```
  working_doc = strip_automation_owned_actions(baseline)
  forecast_inputs = latest_forecast_inputs
  snapshot = build_snapshot(working_doc, forecast_inputs)
  for optimizer in instances:
      working_doc = optimizer.optimize(snapshot, optimizer.config)
      snapshot = build_snapshot(working_doc, forecast_inputs)
  persist(working_doc)
  ```
  where `build_snapshot` internally calls the automation-only snapshot builder from Phase 3 and reuses the same fixed forecast input bundle for every rebuild in that run.
- `custom_components/helman/automation/pipeline.py` — remove the temporary Phase 5 guard that required exactly one enabled optimizer instance.
- `custom_components/helman/coordinator.py` — the automation snapshot builder must already accept an explicit `schedule_document` argument (from Phase 3) and continue to bypass shared forecast caches.
- `tests/test_automation_pipeline_skeleton.py` — extend the existing runner harness with Phase 6 rebuild-loop coverage instead of duplicating the heavy import-stub / fake-coordinator scaffold in a new phase-specific test file.

### Design notes

- Rebuilds are the expensive part. Keep it correct first; add caching only if profiling later shows it matters. The rebuild is cheap relative to a full coordinator tick because solar + house forecast are already cached.
- The runner still holds `_schedule_lock` for the whole decision + final-save portion of the pipeline. All rebuilds therefore see a consistent view.
- Every rebuild in the loop must reuse the same fixed original unadjusted house forecast baseline and the same coordinator-owned forecast input bundle captured at run start, including `when_active_hourly_energy_kwh_by_appliance_id`. Only the working schedule changes between optimizer steps.
- No rebuild in this loop may perform fresh recorder-backed history estimation. Those demand inputs were already pinned into the bundle before the loop began.
- After the final locked save, the runner releases `_schedule_lock` before invoking the shared post-write side effects, matching `set_schedule` and avoiding re-entrant schedule locking.
- Later optimizers win by returning the new authoritative working document. That means a later optimizer may replace or clear an earlier automation-owned action on the same ownership key.
- If any optimizer raises, the runner aborts the whole run, does **not** call `_persist_automation_result_locked`, and logs once. The baseline on disk is unchanged. Any earlier `"ok"` entries later surfaced in `AutomationRunResult` are diagnostic only; they do not imply partial persistence.

### Unit tests (extend `tests/test_automation_pipeline_skeleton.py`)

- with a single optimizer, loop behavior equals Phase 5 behavior (regression guard)
- with a fake second optimizer that asserts `snapshot.schedule` contains the first optimizer's writes, the loop feeds the rebuilt snapshot correctly
- with a fake second optimizer, the rebuild loop reuses the original house-forecast baseline rather than feeding the previously adjusted house forecast back into the next rebuild
- with a fake second optimizer that clears or replaces the first optimizer's automation-owned write on the same ownership key, the final persisted document reflects the later optimizer
- if an optimizer raises, `_persist_automation_result_locked` is never called and the baseline on disk is untouched
- if an optimizer returns an unchanged document, the rebuild still happens (cheap and deterministic); this is fine

### Local HASS smoke test

After restart, configure two `export_price` instances (e.g. two different thresholds) to stress the loop even without the second optimizer kind:

1. `helman/__debug_run_automation` → snapshot should contain writes consistent with the **later** instance winning in slots where both apply (architecture rule: later config order wins).
2. `helman/get_schedule` → confirms the same.
3. Run `helman/__debug_run_automation` twice in a row → second run returns a snapshot whose schedule is identical to the first (idempotent when inputs are unchanged).

### Done criteria

- Unit tests green.
- Smoke test confirms later-instance-wins order and idempotency.
- Architecture doc's pipeline flow still matches.

### Status note

- Local HASS smoke passed with a temporary two-instance `export_price` config: the broader later threshold instance authored 12 automation `stop_export` slots, the second debug run was idempotent, and the original single-optimizer config was restored afterward.

---

## Phase 7 — `surplus_appliance` optimizer

### Goal

Second optimizer kind. Turns a configured generic or climate appliance on based on **remaining** forecast surplus after earlier optimizer steps, with the required surplus derived from the appliance's expected when-active demand profile plus an optional buffer. For climate appliances, the config also specifies which schedulable mode (`heat` or `cool`) should be authored when the optimizer decides to run it. **V1 is intentionally start-only**: it does not author explicit "off" actions when surplus disappears; that behavior is deferred to a later phase.

### Files

Create:

- `custom_components/helman/automation/optimizers/surplus_appliance.py`
- `tests/test_automation_optimizer_surplus_appliance.py`

Modify:

- `custom_components/helman/automation/config.py` — add `surplus_appliance` params: `appliance_id: str`, `action: Literal["on"]` (v1 run semantic), `climate_mode: Literal["heat", "cool"] | None = None`, `min_surplus_buffer_pct: int = 5`. `climate_mode` is required for climate appliances and forbidden for generic appliances.
- `custom_components/helman/automation/optimizer.py` — register the new kind.
- `custom_components/helman/appliances/projection_builder.py` — extract a shared helper such as `get_when_active_demand_profile(...)` next to the existing projection logic so both the projection path and `surplus_appliance` use the same demand-profile resolution rules. The helper consumes `snapshot.context.when_active_hourly_energy_kwh_by_appliance_id` (pinned from the Phase 0 bundle) instead of performing async I/O from inside optimizer logic.

### Design notes

- Reads from the **snapshot's adjusted house forecast and battery/grid forecast**, never from appliance projections. This is a hard rule — see the architecture doc's `surplus_appliance` section. Projections exist only because a schedule exists, so using them for a decision that produces a schedule is circular.
- v1 supports **generic** and **climate** appliances only. EV charging is intentionally out of scope for this optimizer kind in v1.
- Required surplus = appliance when-active expected consumption profile × (1 + `min_surplus_buffer_pct` / 100). Resolve that profile through one shared helper next to the existing projection code so calculation logic stays in one place. Generic and climate appliances may use different underlying data sources, but the optimizer gets one unified answer from `snapshot.context.when_active_hourly_energy_kwh_by_appliance_id`.
- Any recorder-backed history inputs needed for that demand-profile helper were already resolved when the Phase 0 bundle was captured. `surplus_appliance` itself stays synchronous/pure and must not perform its own async recorder access.
- Writes only appliance actions at `(slot_id, "appliances", appliance_id)`. Never touches inverter actions.
- For each authored schedule slot sized by `SCHEDULE_SLOT_MINUTES`, evaluate all covered 15-minute forecast buckets and require **every** covered bucket to satisfy the buffered surplus requirement before writing that slot. This is intentionally conservative and avoids authoring a run for a scheduler slot that only partially has enough surplus.
- If the selected appliance is generic, emit the existing authored DTO exactly: `{ "on": true }`.
- If the selected appliance is climate, emit the existing authored DTO exactly: `{ "mode": climate_mode }`, where `climate_mode` must be one of the runtime appliance's authorable modes. In the current backend that means `heat` or `cool`.
- The optimizer must reject unknown or unsupported `appliance_id` values loudly during validation / construction. If forecast inputs or the resolved demand profile are unavailable at run time, mark the optimizer as skipped with a clear reason and make no writes.
- Before Phase 7 ships, update the architecture doc's `surplus_appliance` section to match the committed scope here: generic + climate support, `climate_mode` for climate, per-kind authored DTOs, slot-size-constant-driven bucket mapping, and v1 start-only behavior.

### Unit tests

- with a generic appliance whose surplus exceeds the buffered demand in slots `S1..S3` → optimizer writes `{"on": true}` actions for exactly those slots
- with a climate appliance and `climate_mode="heat"` (or `"cool"`) whose surplus exceeds the buffered demand in slots `S1..S3` → optimizer writes `{"mode": "heat"}` (or `"cool"`) actions for exactly those slots
- with a forecast where surplus is insufficient → no writes
- with a user-owned appliance action for that same appliance in a candidate slot → optimizer leaves that slot's appliance action untouched
- with another appliance owned by user in the same slot but **different appliance_id** → optimizer still writes its own appliance action (per-appliance granularity)
- buffer parameter: `min_surplus_buffer_pct=0` accepts exact-match surplus; default `5` rejects a slot whose surplus ties the raw demand
- climate appliance without `climate_mode`, or with an unsupported `climate_mode`, fails validation
- for a scheduler slot sized by `SCHEDULE_SLOT_MINUTES`, if one covered 15-minute forecast bucket has enough surplus but another does not, the optimizer skips the slot
- unknown or unsupported `appliance_id` → optimizer raises at validation / instantiation
- unavailable forecast or unavailable demand-profile data → optimizer is skipped with no writes
- parity test: `surplus_appliance` uses the same resolved when-active demand profile as the projection path for the same generic or climate appliance, including history-backed resolution / fallback behavior

### Local HASS smoke test

With a real generic or climate appliance and a forecast that has at least one sunny window:

1. Configure `automation.optimizers` with one `export_price` **and** one `surplus_appliance` pointing at the real appliance. If the appliance is climate, set `climate_mode: heat` or `cool`.
2. `helman/save_config`, wait for reload.
3. `helman/__debug_run_automation` → inspect snapshot: the `surplus_appliance` writes should be placed in slots where the adjusted house forecast (after `export_price` effects) shows sufficient surplus. Generic appliances should emit `{"on": true}`; climate appliances should emit `{"mode": "<configured mode>"}`.
4. `helman/get_schedule` → confirms persisted actions, `setBy: automation`.
5. `helman/get_appliance_projections` → the selected appliance should now show projected activity in those slots, including the authored climate mode when applicable.
6. Manually patch one of those slots with `helman/set_schedule` as `setBy: user` flipping the appliance off; re-run `helman/__debug_run_automation` → that specific slot stays user-owned, others may be refreshed.

### Done criteria

- Unit tests green.
- Smoke test confirms that surplus is computed **after** earlier optimizer effects and that generic/climate authored DTOs match the existing schedule contract.
- Architecture doc's `surplus_appliance` section matches the implementation before the phase ships, including generic + climate support, `climate_mode`, slot-size-constant-driven slot mapping, and v1 start-only scope.

---

## Phase 8 — Coordinator triggers (startup, execution-enable, slot refresh, post-user-edit) with coalescing

### Goal

Wire `coordinator.run_automation()` to real triggers so automation runs without the debug websocket command. Implement the two guardrails from the arch doc (coalesce rapid user writes; do not retrigger self from own persistence).

### Files

Modify:

- `custom_components/helman/coordinator.py`:
  - add an awaited wrapper such as `_async_refresh_forecast_and_schedule_automation(reason)` and use it from startup/reload and the slot-refresh callback instead of calling `_async_refresh_forecast()` directly. The wrapper queues automation only after a successful forecast refresh with usable inputs.
  - call `run_automation()` at the end of `set_schedule_execution(enabled=True)` on the success path.
  - on transition `set_schedule_execution(enabled=False)`, perform a one-shot cleanup that strips `setBy=automation` actions and persists before future automation runs short-circuit.
  - call `run_automation()` at the end of `set_schedule()` when `set_by == "user"` succeeded and the document changed.
  - implement a debounce/coalesce: the runner exposes a `schedule_run_soon(reason: str)` method that queues a run with a short debounce window (e.g. 500ms asyncio sleep). Repeated calls within the window collapse into one. The trigger sites call `schedule_run_soon` rather than awaiting `run` directly.
  - guard against self-retrigger: keep the immediate post-edit trigger scoped to successful user-authored `set_schedule(set_by="user")` writes only. Automation persistence uses `_persist_automation_result_locked` directly and therefore must not schedule another immediate rerun from its own save path.
  - on startup/reload, if `automation.enabled=false` or there are no enabled optimizer instances, schedule a cleanup-only automation pass so stale `setBy=automation` actions are stripped promptly.

### Design notes

- Coalesce window is 500ms by default, configurable via a private constant for now. This is short enough to feel responsive but long enough to collapse bursts of slot patches from the UI.
- The post-user-edit trigger lives inside `set_schedule`, not inside the runner — that way the runner never has to inspect `set_by`.
- Startup/reload and slot-refresh triggers must run only after a successful forecast refresh with usable data; do not queue automation from the raw time-change callback itself.
- On `execution_enabled: true -> false`, perform one cleanup pass immediately so persisted automation-owned actions do not linger on disk. After that transition, `run_automation` short-circuits while execution remains disabled.
- When execution is enabled but automation is disabled (or no enabled optimizers remain), `run_automation` performs cleanup-only behavior if stale automation-owned actions exist.
- Holding `_schedule_lock` for the automation decision + final-save portion is the intentional v1 trade-off for consistency. User-authored writes may briefly wait behind automation if the pipeline is busy; once the save completes, shared post-write side effects run outside the lock.
- If `schedule_run_soon(...)` is called while a debounced sleep or an active automation run already exists, bursts may be coalesced, but a follow-up rerun must remain queued after the active run if newer user edits or refresh signals arrived. Do not silently drop later triggers just because one run is already in flight.

### Unit tests (`tests/test_automation_triggers.py`)

- `schedule_run_soon` called three times in rapid succession results in exactly one `run_automation` invocation
- startup/reload uses the new forecast-refresh wrapper and schedules automation only after a successful refresh
- `run_automation` is called after a successful `set_schedule_execution(enabled=True)`
- transitioning `set_schedule_execution` from `true` to `false` strips persisted automation-owned actions once
- `run_automation` is called after a user-authored `set_schedule` that changes the document
- `run_automation` is **not** called after an automation-authored persistence write (no self-retrigger)
- when `execution_enabled=False`, the triggers still fire but the runner short-circuits and nothing is persisted
- when `automation.enabled=False` (or no enabled optimizers remain) and stale automation-authored actions exist, the startup/reload path strips them once
- if a new trigger arrives while an automation run is already active, exactly one follow-up rerun is queued after the active run completes

These tests build on the existing `tests/test_coordinator_schedule_execution.py` stub harness.

### Local HASS smoke test

1. Start with `execution_enabled=false` and `automation.enabled=true` with configured optimizers.
2. `helman/set_schedule_execution { enabled: true }` → within ~1s, `helman/get_schedule` should show automation-owned actions appearing.
3. `helman/set_schedule` with a user-authored slot change → within ~1s, automation should have re-run and refreshed its own siblings. Confirm via `get_schedule`.
4. Send five rapid `helman/set_schedule` patches in a row → automation should have run **once**, not five times. Verify by checking HASS logs for a single "automation run completed" log line after the burst (logging is added in Phase 9 — for this phase, add a single temporary `_LOGGER.info("automation run completed, reason=%s", reason)` line in `run_automation` and remove it in Phase 9).
5. Wait for the next `00/15/30/45` slot boundary and observe a run triggered by the slot refresh.
6. `helman/set_schedule_execution { enabled: false }` → persisted automation-owned actions are stripped once, user-owned actions remain, and subsequent triggers do not recreate automation state while execution stays disabled.
7. Save config with `automation.enabled: false`, reload, and confirm previously automation-owned actions are removed while user-owned actions remain intact.

### Done criteria

- Unit tests green.
- All four trigger sources observed in smoke test.
- Burst coalescing observed.
- No self-retrigger loop (HASS logs show one automation run per user edit burst, not an ever-growing stack).

---

## Phase 9 — Observability + `helman/run_automation` debug websocket command

### Goal

Replace the temporary debug command from earlier phases with a first-class, admin-only `helman/run_automation` websocket command that exposes:

- the final snapshot
- which optimizers ran
- per-optimizer count of written actions
- duration
- any errors

Also add structured logging in `pipeline.py` at INFO level for one line per run and DEBUG level for per-optimizer detail.

### Files

Create:

- None.

Modify:

- `custom_components/helman/websockets.py` — register `helman/run_automation` with `@websocket_api.async_response`, admin required, parameter-less. It calls `coordinator.run_automation()` and returns the enriched `AutomationRunResult`.
- `custom_components/helman/automation/pipeline.py` — extend the existing `AutomationRunResult` with per-optimizer summary, duration, and cleanup metadata. Existing callers keep using the same envelope.
- Remove any temporary `__debug_run_automation` command introduced in Phase 3 if still present.
- Remove the temporary single INFO log line from Phase 8 in favor of the structured logging introduced here.

### Design notes

- The run result dataclass is in-memory only, not persisted. Only the final schedule state lives on disk.
- Summary shape per optimizer: `{ id, kind, status: "ok"|"skipped"|"failed", slotsWritten, durationMs, error? }`.
- Top-level non-running / cleanup reasons should be explicit, e.g. `execution_disabled`, `automation_disabled`, `no_enabled_optimizers`, or `cleanup_only`.
- `AutomationRunResult` is diagnostic metadata about the attempted run. If a later optimizer fails, earlier optimizer entries may still appear as `"ok"` for observability, but none of that failed run's candidate changes are persisted.
- The websocket command holds no special privilege compared to what trigger-driven runs do — it simply manually kicks the runner and returns the same result. Use the existing `_require_admin` helper.

### Unit tests

- `AutomationRunResult` is populated correctly for a happy-path multi-optimizer run
- `AutomationRunResult` preserves the Phase 3 envelope shape while adding richer fields in place
- an optimizer skipped because forecast or demand-profile data is unavailable is reported as `status: "skipped"` with a readable reason
- a failing optimizer shows `status: "failed"` with its error message and the earlier optimizers' results still populated, while the persisted schedule remains unchanged for that failed run
- cleanup-only runs are reported distinctly from "did not run" results
- the websocket command returns a valid dict when execution is enabled and a `{ ranAutomation: false }` style result when execution is disabled
- admin check: a non-admin connection is rejected

### Local HASS smoke test

1. `helman/run_automation` with admin → returns `{ ranAutomation: true, snapshot: {...}, optimizers: [...] }` with at least the snapshot fields described above.
2. Induce a failure by configuring a `surplus_appliance` pointing at a non-existent appliance → `helman/run_automation` returns one of the optimizers with `status: "failed"` and a readable error, the previous optimizers still show `"ok"`, and the baseline on disk is unchanged.
3. Check HASS logs: one INFO line per run, DEBUG lines per optimizer when log level is raised.

### Done criteria

- Unit tests green.
- Smoke test confirms structured result shape.
- The debug command from Phase 3 is fully removed.

---

## Phase 10 — End-to-end hardening and docs sync

### Goal

Tighten the rough edges discovered during the previous phases and make sure the architecture doc, this plan, and the code all agree.

### Files

Modify:

- Any file where rough edges were flagged in earlier phases.
- `docs/features/optimizers/helman_automation_optimizer_pipeline_architecture.md` — sweep for any details that drifted.
- `docs/features/optimizers/helman_automation_optimizer_pipeline_implementation_plan.md` (this file) — mark all phases done.

### Design notes

- This phase exists deliberately as a dedicated commit to catch drift. It should be small by the time you get here — if it is large, earlier phases were not following the "update the arch doc before the commit" ritual.

### Unit tests

- Run the full suite. Add a regression test for any bug discovered during the smoke steps of earlier phases.

### Local HASS smoke test

1. Full round-trip:
   - fresh restart
   - `helman/set_schedule_execution { enabled: true }`
   - wait for the first automation run
   - add a user-owned slot
   - wait for the second automation run
   - disable execution
   - re-enable execution
   - observe automation re-runs
2. `helman/run_automation` at any point returns a sane snapshot.
3. Review HASS logs for unexpected warnings.

### Done criteria

- Full unit suite green.
- Smoke test has no regressions.
- Architecture doc matches the shipped code.
- All phases in this file are marked done.

---

## Cross-cutting conventions

- **No new HASS service calls from optimizers.** All device effect is mediated through the schedule executor.
- **No optimizer-to-optimizer direct communication.** They see each other only through the rebuilt snapshot.
- **No optimizer reads appliance projection output directly.** They read the adjusted house forecast and the battery/grid forecast.
- **`surplus_appliance` v1 supports generic and climate appliances only.** EV charging stays out of scope for this optimizer kind until it has its own explicit contract.
- **`setBy` is ownership only.** If per-optimizer attribution becomes needed later, add new metadata rather than overloading `setBy`.
- **One commit per phase.** This makes bisecting trivial if a later regression is spotted.
- **Tests live under `tests/` and are runnable via `python3 -m unittest discover -s tests -v`.** No new test framework is introduced.
- **Docs sync is part of the commit, not a follow-up.** If the architecture doc is out of date at commit time, the commit is incomplete.
- **Config-editor catch-up is part of the phase when it makes sense.** If a phase adds or materially changes user-facing config that should be editable in visual mode, update the frontend editor and ship the rebuilt bundle in the same phase.
