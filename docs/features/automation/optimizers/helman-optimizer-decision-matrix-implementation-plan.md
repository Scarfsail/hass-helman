# Helman Automation — Optimizer Decision Matrix (implementation plan)

Status: ready for implementation. Derived from
[`helman-optimizer-decision-matrix-brainstorm.md`](./helman-optimizer-decision-matrix-brainstorm.md)
(read it first — this doc assumes its data model, reason catalogue, and UI spec and does
not repeat them). Code anchors below verified against the tree on 2026-07-12.

## Scope

Attach a per-run diagnostic `trace` to `AutomationRunResult`, exposed over the existing
`helman/get_last_automation_run` websocket, and render it in a new
`helman-automation-inspector` Lovelace card (plus a follow-on "why" popover in the
scheduling card). Every (optimizer, slot) cell resolves to a reason via a hybrid of
optimizer-emitted decisions and frontend-derived predicates. Observability must never
fail an automation run.

## Locked decisions (from the brainstorm review)

1. **Partial trace on failure.** The trace is owned by the optimizer loop, not by
   `_PipelineExecutionResult`, and is attached to the result on the hard-failure and
   top-level-exception paths too, so a failed/aborted run still renders what was captured.
2. **Skip = discard partial + one note.** On `SurplusApplianceSkip` the framework discards
   that optimizer's partial decisions and collapses its column to a single horizon-wide
   `skipped` note; the coverage validator skips the gap check for `status="skipped"`.
3. **`blocked` is optimizer-emitted** — the framework write diff only sees committed writes.
4. **Reason catalogue is the v1 contract**, pinned by shared contract tests.
5. **Runtime never fails on coverage gaps** — warn + synthetic `unexplained` fill.

## Key facts the implementer needs (verified anchors)

### Grid / horizon
- 96 slots per run: `SCHEDULE_SLOT_MINUTES = 30`, `SCHEDULE_HORIZON_HOURS = 48`
  (`const.py:27-28`). Slot ids: `iter_horizon_slot_ids(reference_time)` →
  local ISO strings (`scheduling/schedule.py:496-505`); horizon end via
  `build_horizon_end` (`schedule.py:479-480`). **Reuse these — do not re-derive the grid.**
- Forecast buckets are 15-min canonical (`FORECAST_CANONICAL_GRANULARITY_MINUTES = 15`,
  `const.py:54`) → **2 buckets per 30-min slot**. A slot→bucket *fan-out* helper exists
  (`scheduling/forecast_overlay.py:61-103`); a **buckets→slot reducer does not** — you add
  one (sum for energies, end-of-slot for SoC).

### Snapshot & rail sources
- `OptimizationSnapshot` (`automation/snapshot.py:50-56`): `.schedule`,
  `.adjusted_house_forecast`, `.battery_forecast`, `.grid_forecast`, `.context`.
- Rail values are readable off the rebuilt snapshot dicts:
  - SoC trajectory: `battery_forecast["series"][*]["socPct"]`
    (`battery_capacity_forecast_builder.py:1047`)
  - Redirectable surplus: `grid_forecast["series"][*]["availableSurplusKwh"]`
    (`forecast_series_fields.py:26-32`, computed in the battery builder)
  - Static-ish: `battery_forecast["series"][*]["solarKwh"]` / `["baselineHouseKwh"]`
  - Gate: `adjusted_house_forecast["status"]`, `*_forecast["coverageUntil"]`
- Each series slot carries `timestamp` + `durationHours`; aggregate the 2 buckets per slot.
- `snapshot_to_dict()` (`snapshot.py:70-112`) already serializes `scheduleSlots`,
  `batteryForecast`, `gridForecast`, `adjustedHouseForecast`, `context`, `dayContexts`.

### Rebuild between steps
- `coordinator._build_automation_snapshot_from_schedule_locked(...)`
  (`coordinator.py:2149-2222`) → `OptimizationSnapshot`. The pipeline calls it after every
  optimizer (`automation/pipeline.py:472-477`) and on the `SurplusApplianceSkip` branch
  (`pipeline.py:430-437`). **The skip branch does its own rebuild** — a skipped step still
  produces a rail segment.

### Result storage / delivery (trace must be added in two places)
- `AutomationRunResult` is a frozen dataclass (`pipeline.py:85-94`); it is deepcopied on
  both store and retrieve (`coordinator.py:382-388`), so a new `trace` field survives.
- **`to_dict()` (`pipeline.py:156-173`) emits only explicitly listed keys** — a new field
  will NOT auto-serialize. You must add `trace` to the dataclass AND to `to_dict()`.
- Websocket `ws_get_last_automation_run` (`websockets.py:100-117`, registered `:97`)
  sends `result.to_dict()`; admin-gated. No frontend consumer exists yet.

---

## Phase 1 — Backend trace plumbing

**Goal:** capture the trace (writes, rails, decisions, notes) with zero reason content yet;
serialize it; add the coverage validator (warn + synthetic fill). No optimizer emits
decisions in this phase except the framework-synthesized fills — this proves the pipeline,
serialization, rail capture, and validator independently of reason work.

### New module: `automation/trace.py`
- `OptimizerTrace` recorder — a dumb appender, one instance per run, owned by the loop:
  - `decision(*, slot_ids, outcome, action=None, reason=None)` — appends to the current
    step's decision list. `outcome ∈ {applied, rejected, blocked, out_of_scope}`.
  - `note(*, code, params)` — run-level or step-level note.
  - `begin_step(optimizer_id, kind)` / `end_step(status, rails_in)` — the loop drives these.
  - `record_writes(step, writes)` — framework-owned (layer 1), see below.
  - `to_dict()` — emits the serialized shape from the brainstorm (`slotIds`, `staticRails`,
    `steps[]`, `railsFinal`). Parallel arrays keyed by `slotIds`.
- Reason objects are opaque dicts `{code, params, signals?}` — no formatting here.
- Frozen `@dataclass` DTOs (`TraceStep`, `TraceDecision`, `TraceWrite`) mirroring the JSON,
  matching the frozen-dataclass style of `pipeline.py`.

### Rail capture: buckets → slots reducer
- Add `aggregate_series_to_slots(series, slot_ids)` (in `trace.py` or a small helper next to
  `forecast_overlay.py`): for each 30-min `slot_id`, take the 2 covering 15-min buckets;
  **sum** energy fields (`availableSurplusKwh`, `solarKwh`, `baselineHouseKwh`),
  **end-of-slot** for `socPct`. Handle short/partial coverage (fewer than 2 buckets near
  `coverageUntil`) by aggregating what exists and leaving `null` past coverage.
- Static rails (once per run, off `initial_snapshot`): `importPrice`, `exportPrice`,
  `solarKwh`, `houseKwh` (baseline house). Import/export come from
  `context.import_price_forecast` / `context.export_price_forecast` `points[]`.
- Step-sensitive rails (`availableSurplusKwh`, `batterySocPct`): captured as
  `railsIn` **before** each step (the snapshot that step received) and `railsFinal` after
  the last step.

### Framework write diff upgrade (layer 1)
- Replace the count from `_count_changed_writable_action_positions`
  (`pipeline.py:595-622`) with a records collector returning
  `[{slotId, domain, before, after}]` for **committed** writes only (the existing
  user-owned exclusion stays — those are never "writes"; `blocked` is emitted separately by
  the optimizer). Keep the count as a derived `len(...)` so `OptimizerRunSummary.slots_written`
  is unchanged.
- `domain` ∈ `"inverter" | "appliance:<id>"`.

### Optimizer contract change
- `automation/optimizer.py` `Optimizer.optimize(snapshot, config)` →
  `optimize(snapshot, config, trace)` (Protocol at `optimizer.py:34-38`). Update the
  Protocol and all five `optimize` signatures (`export_price.py:34`, `charge_hold.py:77`,
  `charge_from_grid.py:64`, `daily_runtime.py:79`, `surplus_appliance.py:62`). In this phase
  they accept and ignore `trace` (except surplus_appliance's skip handling, below).

### Pipeline wiring (`pipeline.py`)
- Create `trace = OptimizerTrace(slot_ids=iter_horizon_slot_ids(reference_time))` in
  `_async_execute_optimizer_loop_locked` before the loop (`pipeline.py:397-411`).
- Capture static rails from `initial_snapshot` once.
- Per step: `trace.begin_step(...)`; capture `railsIn` from the pre-step `snapshot`; call
  `optimizer.optimize(snapshot, optimizer_config, trace)`; after the rebuild
  (`:472-477`) record writes via the new diff; `trace.end_step(status="ok", ...)`.
- **Skip path** (`:423-456`): on `SurplusApplianceSkip`, call `trace.discard_step_decisions()`
  then `trace.note_step(code="optimizer_skipped", params={...})` expanded column-wide, and
  `end_step(status="skipped")`. Coverage validator exempts skipped steps.
- Capture `railsFinal` after the loop.
- **Failure-path survival (locked decision 1):**
  - Thread `trace` onto `_PipelineExecutionResult` (add field) for the success path.
  - Carry `trace` on `_OptimizerExecutionError` (add field, alongside `snapshot`) so the
    `except _OptimizerExecutionError` branch in `run()` (`:337-343`) can attach it.
  - Thread it into `_build_runner_failed_result` (`:572-592`) for the top-level `except`.
- Add `trace: OptimizerTrace | None = None` to `AutomationRunResult` (`:85-94`) and emit
  `payload["trace"] = self.trace.to_dict()` in `to_dict()` (`:156-174`) when present.

### Coverage validator (warn + synthetic fill)
- After each **non-skipped** step: every horizon slot must be covered by exactly one
  emitted decision OR fall in the kind's declared derivable space (a per-kind predicate the
  backend registers as "these slots are frontend-explained"). Gaps → `WARNING` + synthetic
  `{code: "unexplained"}` decision; step `complete = false`.
- Overlaps (two decisions, same slot, same step) → `WARNING`; last emission wins.
- A committed write with no covering `applied` decision → louder `WARNING` + the write's
  slot flagged `unexplained` (still rendered). In Phase 1 (no emissions yet) every writing
  step legitimately warns — that is expected and disappears in Phase 2.

### Phase 1 acceptance
- A completed run's `to_dict()["trace"]` matches the brainstorm's serialized shape;
  `slotIds` length == `len(iter_horizon_slot_ids(...))`; `staticRails`/rail arrays are the
  same length; ~40–100 KB.
- A forced optimizer failure and a forced `SurplusApplianceSkip` both yield a `trace` on the
  websocket payload (partial for failure; the skipped column carries one `skipped` note).
- Coverage gaps warn and fill; **no run is ever failed by the validator** (assert via a test
  that injects an uncovered slot).
- Tests: extend `test_automation_optimizer_*.py` / pipeline tests for shape, rail lengths,
  failure-path trace presence, skip-path column, and validator warn-not-fail.

---

## Phase 2 — Emitted reasons + contract tests

**Goal:** make every write and every non-derivable rationale explained at the source, per
the v1 catalogue. Scoped by the **E/D split** — do not add `rejected` emission where the
catalogue marks it **D**.

### Per-optimizer emission (insert `trace.decision(...)` at mapped sites)
Anchors from the decision-point map:

- **export_price** (`export_price.py`): `applied` at the write loop `:66-76`;
  `blocked_user_owned` at `:68-69`; `stop_export_unsupported` note at the capability gate
  `:56-64`; whole-run `out_of_scope` on the no-candidates early return `:50-51`.
  **No `rejected` emission** — `price_not_below_threshold` is **D** (Phase 3).
- **charge_hold** (`charge_hold.py`): `applied` at write loop `:137-147`; `blocked` at
  `:139-140`; `hold_window_applied` params (`neededKwh`, `marginPct`, `releaseSlot`,
  `boundBy`) computed in `_resolve_release_slot` `:213-246` — thread `trace` into it or
  return a rationale struct; `no_room_to_hold` (`release_slot is None`) `:188-189`/`:237-240`;
  `day_not_matched` `:122-123`; `after_release`/`outside_window` for window-complement slots;
  `battery_params_missing` note at `:92-101`.
- **charge_from_grid** (`charge_from_grid.py`): `applied` (`bridge_window`) in `_plan_window`
  write loop `:173-189` (`expensiveWindow`, `deficitKwh`, `targetSoc`); `blocked` in
  `_pick_cheapest_slots` `:207`; `cheaper_slot_chosen` (`rejected`) at the cheapest-N cut in
  `_pick_cheapest_slots` `:191-212`; `window_covered` (`rejected`) at the `dip <= 0` return
  `:148-150`; `out_of_scope` for band-not-expensive `:105-106` and no-cheap-band `:107-109`.
- **daily_runtime** (`daily_runtime.py`): `applied` (`runtime_deficit_placed`) at write loop
  `:135-144` (`minHours`, `doneHours`, `placedHours`); `blocked` in `_pick_slots` `:193-195`;
  `ranked_more_expensive` (`rejected`) at the cheapest-N cut `:208-209`; `runtime_satisfied`
  (`out_of_scope`) at `:110-112`; `day_skipped` at `:114-119` (`classification`,
  `consecutiveSkips`).
- **surplus_appliance** (`surplus_appliance.py`): `applied` (`surplus_covers_demand`) at
  write loop `:134-141` (`requiredKwh`, `bufferPct`, `signals:["availableSurplusKwh"]`);
  `blocked` at `:115-118`; `forecast_unavailable` note on the `SurplusApplianceSkip` raises
  `:81-84`/`:93-97`/`:103-106` (recorded by the framework skip handler, Phase 1).
  **No `rejected` emission** — `surplus_insufficient` is **D** (Phase 3).

Prefer **group encoding** (one decision covers a slot list sharing a rationale) and carry
per-slot values via `signals` naming rails rather than duplicating per-slot params.

### Declared derivable space
- Each optimizer registers which slots it intentionally leaves to frontend derivation (the
  **D** rows), so the validator does not warn on them. Colocate this declaration with the
  emission code so the two stay in sync.

### Contract tests (hard enforcement)
- Shared assertion helper in the `test_automation_optimizer_*.py` suite:
  - every horizon slot is covered by an emitted decision or the kind's derivable space;
  - every committed write has a covering `applied` decision;
  - no overlaps;
  - every emitted `code` is in the v1 catalogue (pins the catalogue).
- Wire the helper into each optimizer's existing scenario tests. New optimizer kinds cannot
  ship uninstrumented (add a meta-test that every `KNOWN_OPTIMIZER_KINDS` entry is exercised
  by the helper).

### Phase 2 acceptance
- For representative scenarios, every non-skipped step is `complete: true` with **no**
  `unexplained` fills and **no** write-without-`applied` warnings.
- Contract tests fail if a write is unexplained or a bad code is emitted (verify by
  temporarily removing one `decision` call).

---

## Phase 3 — `helman-automation-inspector` card

**Goal:** the PLC block diagram + matrix + cell popovers, consuming the Phase 1/2 trace.
Depends only on the **serialized trace shape** (the seam) — can start against a fixture as
soon as Phase 1's shape is frozen.

### Files
- New dir `frontend/cards/helman-automation-inspector/`:
  - `helman-automation-inspector-card.ts` — Lovelace wrapper: `@customElement`,
    `setConfig`/`getStubConfig`/`getCardSize`, `window.customCards.push(...)`,
    `import "./helman-automation-inspector"`. Mirror
    `helman-solar-inspector/helman-solar-inspector-card.ts`.
  - `helman-automation-inspector.ts` — inner LitElement: `hass` property, `@state`
    loading/error/payload, `_load()` via `this.hass.callWS({ type:
    "helman/get_last_automation_run" })` (mirror `helman-solar-inspector.ts:1475-1478`,
    including the `_activeRequestId` de-dupe and re-fire from `updated()`), the block
    diagram, the matrix, popovers.
  - `automation-inspector-model.ts` — pure types + lookups over the trace (per-slot rail
    lookup, group-sibling resolution, derivation-rule registry per kind — the **D** rows).
  - view/geometry helper modules as needed (block diagram, matrix layout), mirroring the
    `chart-*.ts` split in the solar inspector.
  - `HelmanAutomationInspectorCardConfig.ts` — config interface `extends LovelaceCardConfig`.
- **Register**: add `import './helman-automation-inspector/helman-automation-inspector-card.ts'`
  to `frontend/cards/app.ts` (the single central entry list; Vite builds it via
  `build:card`).
- **DTO**: add `AutomationRunPayload` / `Trace*` interfaces to
  `frontend/cards/helman-api.ts`, matching `AutomationRunResult.to_dict()` + `trace`.
- **Localization**: add an `automation.inspector.*` namespace as a sibling of
  `bias_correction` in **both** `frontend/cards/localize/translations/en.json` and
  `cs.json`; reuse `getLocalizeFunction` + `_t`/`_tFormat` helpers
  (`localize/localize.ts:12`).

### Reuse
- **Final column + action chips**: `getScheduleActionPresentation(action, localize)` →
  `{icon, label, toneClass}` (`helman-scheduling/model/schedule-action-presentation.ts:17-28`);
  tone CSS in `helman-scheduling/styles/scheduling-shared-styles.ts:151-156`.
- **Derivation rules (D)**: implement per-kind predicate functions colocated with the reason
  formatter — `export_price` rejected = `exportPrice[slot] >= when_price_below`;
  `surplus_appliance` rejected = `availableSurplusKwh[slot] < requiredKwh * (1 + bufferPct)`.
  Pin their inputs to the recorded rails/config so they can't silently drift from a fixture.

### UI per the brainstorm
- Block diagram doubles as the matrix column header; step-sensitive rail columns (`S`, `⚡`)
  flank each optimizer column; static rails in one left column; collapsible rails; day-group
  headers from `dayContexts`; `◀ now` marker; "only rows with activity" filter; `Run now`
  button (reuse `helman/run_automation`, `websockets.py:376`).
- Cell states, popover-as-zoomed-block, group hover-highlight, rebuild-connector hover — per
  the brainstorm's cell visual language.
- Unknown reason `code`s render as `code` + raw params (never break on a new backend code).

### Phase 3 acceptance
- Card loads the last run, renders all 96-row-max future slots grouped by day, every cell
  clickable with a reason, failed/skipped columns badged, rail deltas visible between
  columns. Verify against a real run via the local HA instance.

---

## Phase 4 — Scheduling card "why" popover

**Goal:** explain automation-owned actions in place in the existing scheduling card, reusing
the Phase 2 trace + Phase 3 reason formatter.

- Anchor: `helman-scheduling/components/scheduling-slot-table.ts` `_renderActionItem`
  inverter branch (`:1605-1616`) / the `<scheduling-action-chip>` element
  (`components/scheduling-action-chip.ts:103-118`) — attach a "why" popover keyed by slot +
  domain, looked up in the trace via the shared model/formatter from Phase 3.
- Load the same `helman/get_last_automation_run` payload (or lift it to a shared provider if
  both cards are mounted).

### Phase 4 acceptance
- Hovering/clicking an automation-owned action in the scheduling card shows the same
  formatted reason as the inspector's cell popover for that slot.

---

## Parallelization / sub-agent work packages

The **serialized trace shape** (`OptimizerTrace.to_dict()`) is the single seam between
backend and frontend. Freeze it at the end of Phase 1 (commit a JSON fixture from a real
run into the frontend test fixtures) and the streams decouple:

- **WP-A (backend, blocking):** Phase 1. Must land first — everything keys off the shape.
- **WP-B (backend):** Phase 2. Sequential after WP-A; can be split per optimizer across
  agents since each optimizer's emission is independent, but they share the contract-test
  helper — land the helper first, then fan out the five optimizers.
- **WP-C (frontend):** Phase 3. Starts against the WP-A fixture in parallel with WP-B. The
  **D** derivation rules need Phase 2's config/rail semantics but not its code — codify them
  from the catalogue.
- **WP-D (frontend):** Phase 4. After WP-C's model/formatter exist.

Contract that keeps parallel work honest: the v1 reason catalogue + the serialized shape.
Any change to either is a cross-cutting change — update the fixture and the contract tests
in the same commit.

## Testing & verification notes

- Python tests run in the `bold_gagarin` dev container (host can't import HA) — see project
  memory. Backend phases must pass `test_automation_optimizer_*.py` + new pipeline/trace
  tests there.
- Frontend: `frontend/` Vite build (`build:card`) must stay green; add model unit tests for
  derivation rules and trace lookups against the committed fixture.
- End-to-end: drive a real run on the local HA dev instance and open the card (Phase 3/4
  acceptance) rather than trusting fixtures alone.

## Out of scope (v1)

Persisted trace history / run-to-run comparison (last run only, in memory). Revisit if the
need shows up. Rail-density auto-collapse heuristics: start collapsible, tune with real data.
</content>
</invoke>
