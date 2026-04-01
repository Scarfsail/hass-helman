# EV / Appliances Implementation Shared Guide

This document defines the shared execution and validation rules for every EV/appliances story under [`stories/`](./stories/).

For a short diagram-first overview, see [`ev-charger-architecture-summary.md`](./ev-charger-architecture-summary.md).

Each implementation story is intended to be completed in a **fresh Copilot session**.

## Read order for every new session

1. Read this shared guide.
2. Read the short visual overview in [`ev-charger-architecture-summary.md`](./ev-charger-architecture-summary.md).
3. Read the target story document in [`stories/`](./stories/).
4. Re-read [`ev-charger-feature-request-refined.md`](./ev-charger-feature-request-refined.md).

## Repositories

- Backend: current repository, `hass-helman`
- Frontend: `/home/ondra/dev/hass/hass-medilog-card`

The frontend repository currently has no Helman-specific client or UI. Story 1 should establish that foundation instead of assuming it already exists.

The frontend already has Home Assistant websocket support available through `hass.callWS`. Helman FE stories should build thin typed wrappers around `hass.callWS`, not introduce a raw websocket transport.

Backend appliance configuration should remain a backend-managed file / stored config concern. Do **not** plan a frontend config editor for the `appliances` branch.

## Locked contract decisions

These decisions are already agreed and should not be renegotiated inside implementation stories unless the user explicitly changes them:

- EV is the first appliance inside a top-level `appliances` umbrella architecture with kind-specific handlers underneath it.
- EV-specific contracts may stay charger-tailored inside the EV charger appliance boundary. If future charger variants need different handling, evolve that EV-specific layer without leaking those details into the generic `appliances` contract.
- `helman/get_appliances` is **metadata-only** and should include appliance schedule-capabilities metadata.
- FE reads live values and select options directly from Home Assistant state using the entity IDs returned by `helman/get_appliances`, but FE should rely on appliance metadata for Helman authoring capabilities instead of inferring that only from raw HA option lists.
- Every appliance has an explicit `id`.
- Every EV vehicle has an explicit `id` within its appliance.
- `domains.appliances`, projection payloads, and appliance runtime-status payloads are keyed by `applianceId`.
- V1 supports only `Fast` and `ECO` scheduling/projection modes.
- `ECO` uses an explicit `ecoGear -> min power` config map; do not derive this from charger phases or voltage assumptions in backend logic.
- `helman/get_appliance_projections` remains appliance-specific, but it should expose `energyKwh` alongside EV SoC so FE and later forecast integration can explain the same simulated charging behavior without re-deriving energy demand from SoC deltas.
- Appliance-specific projection and aggregate system forecast integration are separate stories: `helman/get_appliance_projections` stays appliance-specific, while `helman/get_forecast` later reflects aggregate battery/grid impact.
- Projection ownership stays appliance-specific: appliance-kind handlers own their charging/projection policy and produce the shared `energyKwh` demand model. Solar/house forecast inputs and inverter constraints are contextual inputs to that logic, not a transfer of ownership to the forecast layer.
- **ECO algorithm**: `min(effective_max_power, max(solar - baseline_house, eco_gear_min_power))`. The projection computes only EV demand per slot; it does not reason about where shortfall energy comes from. Shortfall sourcing (battery discharge vs grid import) is a downstream concern handled by the forecast recalculation after EV demand is added to the house consumption baseline.
- **Forecast integration**: appliance energy demand is reflected by adding `energyKwh` to the house consumption baseline (`baseline_house_kwh`). In the current forecast engine, this reuses the existing `_simulate_slot()` flow rather than introducing a second demand model.
- **Locked forecast pipeline**: (1) build the original forecast without appliance demand, (2) calculate all appliance projections from that unmodified forecast, (3) aggregate all appliance `energyKwh` into house load, (4) recalculate downstream battery/grid forecasts. Every recalculation of projection needs a fresh, unmodified forecast — never feed adjusted outputs back into appliance projection. Both `get_appliance_projections` and `get_forecast` should share the same internal computation so the pipeline runs exactly once.
- **Effective max charging power** is always `min(appliance max_charging_power_kw, vehicle max_charging_power_kw)`.
- **Edge case — EV cannot absorb all surplus**: when `effective_max_power < (solar - baseline_house)`, the EV charges at `effective_max_power` and remaining surplus is available for battery charging. This is handled naturally by the forecast recalculation since only actual EV demand is added to the house baseline.
- **Vehicle SoC unavailability**: if vehicle SoC telemetry is `unavailable` or `unknown`, the SoC projection for that vehicle is unknown/omitted. Vehicle SoC is optional and used only for FE display — no backend logic depends on it.
- **Executor decomposition**: `ScheduleExecutor` → `InverterExecutor` + `AppliancesExecutor` → `EvChargerExecutor`. Each branch has independent runtime status. The top-level orchestrator acquires the schedule lock once per reconcile; sub-executors run within that single lock acquisition.
- **`slot_stop` transition behavior**: when a slot with EV charging ends and the next slot has no EV action for that same appliance, only the charge switch is turned off; `use_mode` and `eco_gear` are kept as-is. When no EV action exists in a slot, the system does nothing for that appliance.
- **Config changes require HA restart and integration reload.** No runtime config migration.
- **Projection caching** shares the same cache lifecycle as the battery forecast.

## Shared architecture rules

- Each appliance kind should be represented by a kind-specific handler/class that owns:
  - config parsing and validation for that kind
  - metadata DTO generation for `helman/get_appliances`
  - slot-action validation and normalization
  - execution logic for the active slot
  - projection policy and shared demand generation for that kind
  - runtime-status mapping for that kind
- That appliance-kind boundary may be implemented as one class or decomposed into narrower helper classes/services. What stays fixed is the architectural ownership: those responsibilities remain inside the appliance-kind boundary instead of spreading into shared coordinator or forecast layers.
- A shared base appliance abstraction is fine for common plumbing, but appliance-kind-specific contracts and policies stay inside the kind-specific handler boundary.
- The shared orchestrator layer should own:
  - building the runtime appliance registry from active config
  - dispatching actions by `applianceId` and appliance kind
  - triggering reconciliation on the normal schedule cycle and when the active slot action changes
  - composing shared schedule / projection / runtime read models
- Shared forecast layers may provide contextual inputs to appliance projection logic and later consume the resulting generic `energyKwh` demand model, but they do not own appliance-kind-specific charging policy.
- The shared internal appliance demand model should stay minimal and generic:
  - `applianceId`
  - `slotId`
  - `energyKwh`
- `slotId` is the only required time key for appliance demand and projection values. Values are interpreted as the end-state or full effect of that slot unless explicitly documented otherwise.

## Shared projection / forecast pipeline rule

Projection and aggregate forecasting must follow one ordered pipeline:

1. Build the original system forecast inputs exactly as today:
   - solar forecast
   - original `baseline_house_kwh`
   - other existing contextual inputs such as inverter constraints and battery state
2. Ask every appliance handler in the active runtime registry to calculate its appliance-specific projection and produce generic demand entries (`applianceId`, `slotId`, `energyKwh`) from those original inputs.
3. Aggregate `energyKwh` from **all** appliance demand producers by `slotId` and add that total to the original `baseline_house_kwh` to produce the adjusted house-consumption baseline.
4. Re-run the downstream aggregate battery/grid forecast builders from the adjusted house-consumption baseline.

**Critical loop prevention**: every recalculation of projection needs a fresh, unmodified forecast — never an already-adjusted one. This order is locked and must not be reversed, partially skipped, or collapsed in a way that feeds downstream outputs back into appliance projection. Appliance projections must never consume a house-consumption baseline that already includes projected appliance demand, otherwise an appliance would "see" its own added load and under-project the remaining solar available to it.

Both `helman/get_appliance_projections` and `helman/get_forecast` should share the same internal computation in the coordinator so the pipeline runs exactly once per cache cycle. The coordinator orchestrates the full pipeline and serves both endpoints from the same computed result.

The aggregation step is generic across appliance kinds. EV is only the first appliance-kind producer in v1; future appliance kinds should plug into the same shared `energyKwh` aggregation flow without changing the pipeline order.

Caching must respect the same dependency chain. If original forecast inputs or any appliance-demand producer changes, invalidate the adjusted house baseline and downstream battery/grid outputs together and recompute the pipeline in the locked order above. Shared cache lifecycle must not mean that downstream aggregate outputs become inputs to appliance projection.

Live vehicle SoC changes are intentionally **not** part of the cache key in v1. SoC remains optional display-oriented data for FE; cache invalidation is driven by forecast inputs, authored schedule changes, and config lifecycle rather than by every incoming vehicle telemetry update.

## Shared runtime-status rule

Runtime status is an **ephemeral execution read model**, not authored schedule data and not a mirror of live HA entity state.

- appliance runtime entries are keyed by `applianceId`
- `actionKind` values are `apply | slot_stop | noop`
- `outcome` values are `success | failed | skipped`
- `slot_stop` is distinct from `noop`
- runtime status should be updated on the normal scheduler reconcile cycle and when the user changes the current active-slot action
- when exposed through `helman/get_schedule`, runtime status lives in a read-only ephemeral branch and must not be accepted back through `helman/set_schedule`

Execution timing should stay explicit:

- when a slot becomes active and contains an appliance action, apply that slot action at the beginning of that slot / reconcile
- when a slot with an EV action ends and the next slot has no EV action for that appliance, emit `slot_stop`
- periodic reconcile inside the same slot must not fight manual charger changes; it may refresh runtime status, but the next scheduled appliance control write happens on slot transition or when the active-slot action itself changes

## Shared config lifecycle rule

Document and keep separate:

1. **Stored config**
   - persisted by `helman/save_config`
2. **Validated active config**
   - loaded and validated during restart / integration reload
3. **Runtime appliance registry**
   - in-memory appliance handlers built from the validated active config

Runtime APIs should operate on the active runtime registry, not on raw stored config.

Each part of the application is responsible for loading its own config section. Appliances are optional — if the `appliances` config key is missing, the integration loads normally with no appliances active. Validation should happen per appliance during restart / integration reload. If one appliance config is invalid, log an explicit error describing what is wrong and ignore that appliance. The rest of the integration continues to function, since appliances are not a mandatory component.

Only valid appliances should be materialized in the runtime appliance registry. Ignored appliances are absent from `helman/get_appliances`, schedule validation/runtime behavior, execution, and projections until the config is fixed and reloaded.

If a validation flow changes appliance config via `helman/save_config`, that save updates only stored config. Restart / reload again before validating runtime APIs against the new appliance setup.

## Delivery model

- Story 01 is the only intentionally mixed BE/FE story because it must reflect the breaking websocket contract on both sides. It should fix the FE for the breaking change but **not introduce any new FE functionality**.
- Stories 02-06 are **backend-only**.
- There are currently **no FE-only follow-up stories** in scope. If FE planning resumes later, it should start from fresh research rather than from stale placeholder story docs.

## Story execution policy

- Complete **one story per Copilot session**.
- Do not start a later story before its dependencies are green.
- Keep each story shippable on its own.
- Keep the vertical-slice delivery style unless the user explicitly changes that direction.
- If a story includes UI changes, stop after automated validation and wait for the user to do manual UI testing before the story is considered commit-ready.

## Required validation for every story

### 1. Backend unit tests

- Use **targeted** `unittest` modules only.
- Do **not** rely on full `python3 -m unittest discover -s tests -v` as the primary gate; this repository has a known history of stub-import contamination across the full suite.
- Run only the tests relevant to the story plus directly coupled tests.

### 2. Local websocket validation

- If the story changes backend code, ask the user to **restart the local Home Assistant instance** so code changes are loaded.
- If websocket validation also persists appliance config via `helman/save_config`, ask the user for another restart / integration reload after the save before calling runtime APIs that depend on the new appliance config.
- After the restart, use the **local-hass-api** skill for live websocket/API validation.
- Validate only the websocket commands touched by the story.
- FE-only stories do not require a Home Assistant restart unless backend changes are also included.

### 3. Frontend build validation

When FE files under `/home/ondra/dev/hass/hass-medilog-card` change:

- run the FE build already present in that repo
- prefer `npm run build-dev`

If a story changes the FE build setup itself, the story is not green until the adjusted build still produces the expected outputs.

### 4. Manual UI sign-off

If a story changes visible UI:

- automated validation must pass first
- then the user performs manual UI testing
- the story is **not** commit-ready until the user explicitly confirms the UI is good

## Story 01 FE implementation rule

Story 01 is the only place where FE files should change in the current plan.

- Keep FE work limited to the minimum contract-compatibility changes needed for the new backend websocket DTOs.
- Use `hass.callWS` wrappers for Helman websocket commands rather than building a standalone websocket client implementation.
- Do not add new Helman UI functionality or a frontend editor for backend appliance configuration.

## Shared websocket validation rule

Every story that changes websocket behavior should document:

- the exact commands to validate
- the minimum payload example to send
- the expected success shape or runtime effect

## Shared deliverables per story

Every story document should remain actionable enough that a future session can execute it without re-planning:

- clear user story
- exact file touchpoints
- ordered implementation steps
- acceptance criteria
- targeted unit-test plan
- websocket validation plan
- UI sign-off requirement

## Optional parallel work

There is **no clean early parallelism** during the backend phase because stories 02-06 all overlap backend schedule, coordinator, websocket, and forecast seams.

Complete backend stories sequentially.
