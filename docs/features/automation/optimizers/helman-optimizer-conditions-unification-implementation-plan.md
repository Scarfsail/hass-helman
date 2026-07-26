# Helman Automation — Optimizer conditions unification (implementation plan)

Status: **implemented** (all four phases). Kept as the design record — it explains
*why* the shape is what it is, which the code cannot. Two deliberate departures from
the plan as written are noted inline below. Derived from
[issue #1](https://github.com/Scarfsail/hass-helman/issues/1) — read it first; this doc assumes
its target config shape, evaluation semantics and migration rules and does not repeat them.
Code anchors verified against the tree on 2026-07-26.

Revised 2026-07-26 after review: `soc_floor` re-modelled as self-gating rather than a slot mask,
mask signature and its two invariants (R1/R2) made explicit, coordinator wiring and the
`max_consecutive_skips` override moved into Phase 1, save-path migration/rejection added, and the
inspector's frontend derivation rules added to Phase 2.

## Scope

Replace the per-optimizer `params` + `condition` shape with `target` / `params` / `conditions[]`,
where `conditions` is an ORed list of groups, each group ANDing system conditions with `custom`
(Home Assistant conditions) and optionally overriding `params`. Ship an auto-migration. Along the
way, collapse five hand-written optimizers and five hand-written editor cards onto shared
machinery so a new optimizer is a **declaration**, not an implementation.

The uniformity requirement is the point, not a side effect: editing any optimizer must feel the
same, and that has to be true *by construction* rather than by discipline.

---

## The duplication we are removing

Verified counts across `custom_components/helman/automation/optimizers/*.py`:

| Duplicated thing | Copies | Files |
|---|---|---|
| `_parse_timestamp` | 5 | all five |
| `_read_optional_float` | 5 | all five |
| `condition_met = snapshot.context.condition_met_by_optimizer_id.get(self.id, True)` | 5 | all five |
| `deepcopy` + `ScheduleDocument(execution_enabled=…, slots=…)` preamble | 5 | all five |
| user-owned guard → rebuild `ScheduleDomains` → append to applied/blocked | 5 | all five |
| `_canonical_bucket_start` | 2 | export_price, surplus_appliance (one hardcodes granularity, one takes it as a param) |
| `_build_price_by_bucket_start` | 2 | daily_runtime, charge_from_grid (byte-identical) |
| `_WindowTime` + `_read_window_time` | 2 | charge_hold, daily_runtime |
| `_read_margin_pct` | 2 | charge_hold (nested), charge_from_grid (flat) |
| `_window_horizon_slots` / `_band_horizon_slots` | 2 | daily_runtime, charge_from_grid |
| `<Kind>ValidationError(field, message)` classes | 4 | charge_hold, daily_runtime, charge_from_grid, surplus_appliance — and export_price inconsistently raises bare `ValueError` |
| near-identical per-kind `try/except` blocks | 4 | `config_validation.py:994-1075` |
| per-kind optimizer card renderers (~90 lines each) | 5 | `helman-config-editor.ts` |

`trace.declare_derivable(iter_horizon_slot_ids(...))` appears in four of five — charge_hold omits
it, which is the kind of silent drift a shared base removes.

Existing good precedent to follow: `surplus-appliance-ui.ts` already shares the appliance-selection
state between the `surplus_appliance` and `daily_runtime` cards. Generalise that pattern.

---

## Core idea: every condition is a slot mask

The unifying abstraction that makes the whole thing DRY:

> **A condition is a function `(snapshot, value, target, master_params) -> SlotMask`**, where
> `SlotMask` is one boolean per horizon slot.

That single signature absorbs the scopes from the issue:

- **Per-slot** conditions (`export_price_below`, `surplus_buffer`) compute a real mask.
- **Per-day** conditions (`run_when`) produce a mask constant within each local date.
- **Per-run** conditions (`custom`) produce an all-true or all-false mask.
- **Self-gating** conditions (`soc_floor`) produce an all-true mask and are consumed by value — see
  "The `soc_floor` exception" below, which is *not* a per-slot mask and must not be modelled as one.

Then group/OR semantics are pure boolean algebra, written once:

```
group.system_mask = AND(mask(c) for c in group.conditions if c is not custom)
group.custom_met   = evaluate(group.custom)                      # constant per run
planned[s]   = any(g.system_mask[s] and g.custom_met for g in groups)
candidate[s] = (not planned[s]) and any(g.system_mask[s] for g in groups)
matched[s]   = first g with (g.system_mask[s] and g.custom_met), else first with g.system_mask[s]
```

This is exactly the semantics locked in the issue: candidates only when the system conditions
matched and only `custom` failed; first fully-matching group wins.

No optimizer implements *gating* any more. `export_price` loses `_find_candidate_slot_ids`,
`charge_hold` loses its `only_on_days` branch, `surplus_appliance` loses
`_slot_has_sufficient_surplus`, `daily_runtime` loses `_should_skip`. They all consume one
`Eligibility` object, which exposes the matched group's **resolved params and resolved condition
values** per slot, not just a boolean — the optimizer reads `eligibility.at(slot_id).params`
instead of `self.config.*`. That is what makes per-group param overrides work with zero
per-optimizer code.

### Two rules the mask signature depends on

Both are load-bearing; violating either produces a chicken-and-egg at implementation time.

**R1 — masks read `target` and *master* params only, never group overrides.** Resolved params
depend on which group matched, which depends on the masks; letting a mask read the override closes
the loop. `surplus_buffer` needs the appliance from `target` and the resolved when-active demand
profile (`surplus_appliance.py:95-145`); that is all reachable from `target` + snapshot. If a future
condition genuinely needs an overridden param, it is not a condition — it is optimizer logic.

**R2 — a kind may not combine SLOT-scope conditions with day- or band-scoped params.** Group
resolution is per slot, but `charge_hold` computes `needed_kwh` once per run from `target_soc` and
resolves one release slot per *day* (`charge_hold.py:117-152`), and `window` is now
group-overridable. That is only coherent because charge_hold's condition types (`run_when`,
`custom`) are both DAY/RUN scope, so every slot in a day resolves to the same group. Make this an
invariant checked in `OptimizerSpec` construction (a unit test over `OPTIMIZER_SPECS` is enough),
and give `Eligibility` a `for_day(local_date)` accessor alongside `at(slot_id)` so day-scoped
optimizers read resolved params at the granularity they actually think in.

### The `soc_floor` exception — `charge_from_grid` is self-gating

`soc_floor` cannot be a slot mask, and modelling it as one inverts the optimizer. In
`charge_from_grid.py:165-228` the floor test runs over the **expensive** band
(`_min_soc_over(band.start, band.end)`), while every slot it writes lies in the **preceding cheap**
band (`_pick_cheapest_slots(cheap_band=…)`). Those two sets are disjoint: a mask of "slots where
projected SoC dips below the floor" marks exactly the slots the optimizer never touches and masks
off the ones it does. Nor is the value the optimizer needs the config value — it needs
`dip = floor - window_min_soc`, computed per expensive band (`charge_from_grid.py:170`).

So `soc_floor` is registered with `scope=RUN` and `self_gating=True`:

- its `build_mask` returns an all-true mask, so OR/candidate algebra is unchanged and `custom`
  still gates the whole optimizer exactly as today;
- the optimizer reads `eligibility.at(slot_id).condition_value("soc_floor")` per cheap-band slot
  and keeps its own dip test and target-SoC arithmetic — that logic is explicitly a non-goal to
  change;
- because `soc_floor` contributes no discrimination, `charge_from_grid` with two groups differing
  only in `soc_floor` resolves every slot to group 0. That is correct and worth documenting: for a
  self-gating kind, groups discriminate on `custom` only, and the floor is a per-group *parameter*
  that happens to live under `conditions` for uniformity of presentation.

This keeps R2 satisfied for `charge_from_grid` (no SLOT-scope condition, so its band-scoped
`margin_pct` / `max_target_soc` params are safe) and keeps `charge_from_grid`'s decision logic
untouched.

---

## New / changed backend modules

```
automation/
  fields.py              NEW  primitive readers: time_hhmm, soc, margin_pct, positive_number,
                              non_negative_int, day_classifications, optional_float
  rails.py               NEW  snapshot readers: parse_timestamp, canonical_bucket_start,
                              price_by_bucket, soc_by_bucket, surplus_by_bucket,
                              clipped_surplus_by_bucket, horizon_slots_between
  spec.py                NEW  OptimizerSpec registry: per-kind target/params schema +
                              accepted condition types + cross-field validation hook
  conditions/
    __init__.py          NEW  ConditionType registry
    types.py             NEW  run_when, export_price_below, surplus_buffer, soc_floor, custom
    evaluation.py        NEW  build_eligibility(...) -> Eligibility  (mask algebra, once)
  migration.py           NEW  old shape -> new shape, config_version
  config.py              CHG  generic reader over OptimizerSpec; one OptimizerConfigError
  optimizer.py           CHG  build_optimizer() drives off the registry
  optimizers/*.py        CHG  action-writing only; all five shrink substantially
  base.py                NEW  apply_action(...) helper: user-owned guard + domain rebuild +
                              applied/blocked bookkeeping + trace decision, written once
```

Outside `automation/`:

```
coordinator.py         CHG  per-group condition checkers, per-group plan map, reality check
websockets.py          CHG  helman/get_optimizer_schema; config_version stamp on save
config_validation.py   CHG  one registry loop; old-shape rejection rules
storage.py             CHG  migration on load
```

`base.py` is what kills the fifth-copy problem: each optimizer's write loop becomes

```python
for slot_id, decision in eligibility.iter_planned():
    writer.set_inverter(slot_id, kind=SCHEDULE_ACTION_STOP_CHARGING, decision=decision)
```

with the deepcopy, `is_user_owned_*` guard, `ScheduleDomains` rebuild, `condition_met` stamping
and `blocked_user_owned` trace emission all inside `writer`.

Three things the writer must model rather than flatten:

- **Repaint vs append.** `surplus_appliance` calls `_clear_automation_owned_target_actions` before
  writing (`surplus_appliance.py:118-121`) — it fully repaints its appliance's domain each run,
  where the other four only add. The writer takes a `mode="repaint"|"append"` from the spec; it is
  not a per-optimizer preamble that can be deleted.
- **`SurplusApplianceSkip` is control flow, not an error.** The pipeline catches it and calls
  `restore_automation_owned_appliance_actions` against the baseline, then collapses the column
  (`pipeline.py`, the `except SurplusApplianceSkip` arm). The writer and the refactored optimizer
  must keep raising it on unavailable forecast inputs; it must not become a generic failure.
- **`condition_met` is per slot, from the matched group** — `ScheduleAction.condition_met` already
  is a per-slot field, so per-group semantics need no schedule-document change (an explicit
  non-goal that holds).

### Condition type registry

```python
@dataclass(frozen=True)
class ConditionType:
    key: str                      # yaml key, e.g. "run_when"
    scope: Scope                  # SLOT | DAY | RUN
    self_gating: bool = False     # RUN + all-true mask; consumed by value (see soc_floor)
    read: Callable[[object, str], Any]        # value reader, raises OptimizerConfigError
    build_mask: Callable[[Snapshot, Any, Target, MasterParams], SlotMask]   # R1
    reason_code: str              # single trace code per type, shared by every kind
```

Registered types (issue §Evaluation semantics):

| key | scope | mask source |
|---|---|---|
| `run_when` | DAY | `snapshot.context.day_contexts[date].classification` |
| `export_price_below` (`when_price_below`) | SLOT | `context.export_price_forecast` |
| `surplus_buffer` (`min_surplus_buffer_pct`) | SLOT | `grid_forecast.availableSurplusKwh` vs when-active demand, appliance from `target` |
| `soc_floor` (`reserve_floor_soc`) | RUN, self-gating | all-true; value read per band by `charge_from_grid` |
| `custom` | RUN | HA condition checkers |

Per-kind whitelist lives in `OptimizerSpec.condition_types` — adding `run_when` to `export_price`
later is one entry in a tuple.

**`only_on_days` is gone.** Per the decision, charge_hold's day condition is `run_when` — one name,
one widget, one validator, one reason code.

### OptimizerSpec

```python
OPTIMIZER_SPECS = {
    "charge_hold": OptimizerSpec(
        kind="charge_hold",
        target=(),                                   # inverter-wide
        params=(F.object("window", F.time("start"), F.time("end")),
                F.object("battery_first", F.soc("target_soc"), F.margin("margin_pct"))),
        condition_types=("run_when", "custom"),
        validate=validate_charge_hold_cross_fields,  # window.end > window.start
        build=build_charge_hold_optimizer,           # see "build hooks" below
    ),
    ...
}
```

**Build hooks, not pure declarations.** `build_optimizer` cannot be fully generic: `export_price`
needs `control_config` (`stop_export_supported`) and `surplus_appliance` / `daily_runtime` need the
`AppliancesRuntimeRegistry` to resolve `target.appliance_id` into a runtime and an authored action.
A per-kind constructor receives `(resolved_config, control_config, appliance_registry)`; the
registry removes the *dispatch*, not the construction.

> **As shipped:** the constructor lookup is a dict in `optimizer.py`, not a `build` field on
> `OptimizerSpec`. Putting it on the spec would make `spec.py` import the optimizer modules, which
> import `conditions/` and (for typing) `config.py` — a cycle, for no gain over a dict lookup. The `target` half
of appliance resolution (`appliance_id` + `climate_mode` → `authored_action`) is shared between the
two appliance kinds and moves into one helper.

One generic reader walks the spec; `_read_export_price_params`,
`_read_surplus_appliance_params`, `_read_export_price_action`, `_read_surplus_appliance_action`
and the shape half of all five `validate_*_optimizer_config` functions delete. The four
`<Kind>ValidationError` classes collapse into one `OptimizerConfigError(path, code, message)`
reusing the existing `AutomationConfigError` shape, and the four near-identical try/except blocks
in `config_validation.py:994-1075` collapse to one loop over the registry.

Two behaviour changes hiding in that collapse — both intended, both worth stating so review does
not read them as accidents:

- **Validation timing moves for `export_price`.** It is the only kind that validates lazily inside
  `optimize()` (`_read_threshold` / `_read_action`, `export_price.py:214-227`, raising bare
  `ValueError`). Under the generic reader it validates at build time like the other four, so a
  missing `when_price_below` becomes a config error at save/load instead of a run failure mid-plan.
  That is strictly better, but it is a change in *when* users see the failure.
- **Validation scope stays on enabled optimizers.** `config_validation.py:993` walks
  `automation_config.execution_optimizers`, i.e. enabled ones only, so a disabled optimizer with a
  broken group is not reported. That is pre-existing and this plan does **not** change it —
  widening it would surface errors on configs users deliberately parked. Noted here so the registry
  loop is not "simplified" into walking all optimizers by accident.

Param merge (issue: one level deep) is one function in `spec.py`, used by both the reader and the
migration, and mirrored in TS by the editor's preview of inherited values.

---

## Schema as the single source of truth across BE and FE

The spec above is defined **once, in Python**, and served to the editor over a new websocket
command `helman/get_optimizer_schema` (register beside `ws_validate_config` /
`ws_save_config`, `websockets.py:83`). The editor renders from the served schema.

This is the "plenty of shared functionality on both BE and FE" the brief calls out. The
alternative — hand-maintaining a parallel TS schema — guarantees drift between what the editor
lets you build and what the reader accepts, which is exactly the current failure mode (the editor
today renders a `hold_action` field that no Python code has ever read).

Split of responsibilities:

- **Schema (from backend):** field structure, types, ranges, required-ness, which condition types
  a kind accepts, which params are overridable.
- **Translations (`en.json` / `cs.json`):** all human text, keyed by convention —
  `editor.fields.<field_key>`, `editor.help.<kind>_<field_key>`, falling back to
  `editor.help.<field_key>` so shared fields (`window`, `margin_pct`) need one string, not five.

Missing-translation fallback must be visible in dev, not silent, so a new field can't ship unnamed.

---

## Frontend structure

```
frontend/config-editor/
  optimizer-schema.ts          NEW  types for the served schema + fetch/cache
  optimizer-field-renderer.ts  NEW  schema node -> existing _render*Field primitives
  optimizer-condition-groups.ts NEW group list: add / remove / reorder / last-group guard,
                                    per-type condition widgets, custom via ha-automation-condition,
                                    params-override sub-form
  optimizer-card.ts            NEW  ONE renderer for all five kinds
  helman-config-editor.ts      CHG  five _render*OptimizerCard methods delete;
                                    _renderOptimizerConditionSection replaced
```

The field renderer sits on top of the primitives that already exist and are already shared —
`_renderRequiredTextField`, `_renderRequiredNumberField`, `_renderOptionalSelectField`,
`_renderOptionalEntityField`, `_renderHelpIcon` (`helman-config-editor.ts:3712-3971`) — so this is
a re-wiring, not a rewrite of the form layer.

**The override sub-form is literally the same renderer as the master params form**, given a
different base path plus the inherited value as placeholder. That is where the "well-known" feeling
comes from: a group's override looks exactly like the master block, with unset fields showing what
they inherit.

Condition widgets are keyed by condition *type*, not by optimizer kind — so the day-classification
picker (today `_renderDayClassificationField`, `helman-config-editor.ts:2372`) is one component
used wherever `run_when` appears, and the three numeric threshold conditions share one widget.

Delete on the way through: `editor.fields.optimizer_action` on the export_price and
surplus_appliance cards, `editor.fields.hold_action` on charge_hold (all three are read-only
displays of values nothing reads).

---

## Migration

**Two hook points, not one — the read path alone is not enough.**

*Load.* `HelmanStorage.async_load` (`storage.py:43-58`), which already merges `DEFAULT_CONFIG` and
is awaited from `async_setup_entry` (`__init__.py:27-34`). Migrate after load; persist via
`async_save` only when something changed; log a one-line summary naming each migrated optimizer.

*Save.* `ws_save_config` (`websockets.py:161`) writes the whole document straight from the editor,
and the editor exposes raw YAML per scope **and** a document-level YAML editor
(`helman-config-editor.ts:1064`). So a user can paste an old-shape `automation` block and save it,
and a YAML round-trip can drop `config_version` — which would silently re-trigger migration on the
next start, or worse, leave a half-old document that the reader mis-parses. Therefore:

1. `ws_save_config` stamps `config_version` to the current version on every save, before
   validation, so it can never be lost by a round-trip.
2. `validate_config_document` **rejects** the old shape rather than migrating it on save: a
   top-level `condition` key, or any dropped key (`params.action`, `params.hold_action`,
   `params.only_on_days`, `params.skip`, `params.appliance_id`, `params.reserve_floor_soc`,
   `params.when_price_below`, `params.min_surplus_buffer_pct`) produces an
   `invalid_value` error naming the new location. This is the issue's "fails loudly instead of
   being quietly discarded", made a concrete validation rule: hand-editing is a save-path concern,
   and silently rewriting a user's YAML under them is worse than refusing it.
3. Migration therefore runs *only* on load, against stored documents written before the upgrade.

- Add `config_version` at the document root. Absent → treat as version 1 (pre-unification).
- `automation/migration.py` owns the per-kind moves from the issue's migration table, including
  the `run_when` inversion — and its three-case rule, where **`max_consecutive_skips == 0` (the
  current default) means skipping never actually happened, so `run_when` must become all
  classifications, not the complement.** Getting this wrong silently changes behaviour for every
  existing `daily_runtime` config.
- Migration is a pure dict→dict function, so its tests are self-stubbing and run on the host
  without importing Home Assistant.
- **Fixture tests are not enough — check a real stored config.** Fixtures contain what the author
  remembered; a real `.storage/helman.config` contains what every past version of the editor
  actually wrote. This shipped a `params.release` that no Python has ever read, which the
  unknown-key check would have rejected on the first restart after upgrading, while every fixture
  test passed. `tests/test_stored_config_migration.py` now runs migrate → read → validate against
  the sibling Home Assistant checkout (or `HELMAN_STORED_CONFIG`) on every suite run, and skips
  where there is no store. Any future migration is covered by it for free.
- Optimizer order preserved verbatim — later optimizers overwrite earlier ones and charge_hold
  documents that it must precede export_price.

---

## Phases

Each phase is independently mergeable and green. Phase boundaries are drawn where behaviour stays
correct at the boundary, not where the diff is smallest — see the two call-outs in Phase 1 for the
splits that look attractive and are not safe.

### Phase 0 — primitive extraction (optional, separable)

`fields.py`, `rails.py` — extract the primitives; point the five optimizers at them. Pure refactor,
no behaviour change, tests untouched. **Merge this first on its own** if convenient: it deletes ~15
duplicated helpers with zero semantic risk and shrinks the Phase 1 diff.

> **As shipped:** only `rails.py` landed in Phase 0. `fields.py`'s readers exist to raise
> `OptimizerConfigError`, which does not exist until Phase 1b — extracting them early would have
> meant an adapter translating to the old `<Kind>ValidationError` classes for exactly one commit.
> `fields.py` therefore lands in 1b with its final error type. Phase 0 stayed a pure, zero-risk
> refactor, which was the point of carving it out.

### Phase 1 — foundations, format, migration, runtime wiring

This phase is not splittable further. Two things in it look like Phase 2 material and are not:

> **Why the coordinator work is here.** `_async_evaluate_optimizer_conditions`
> (`coordinator.py:2257`) does `if not optimizer.condition: continue` and returns
> `{optimizer_id: bool}`. Once migration moves `condition` → `conditions[j].custom`, that loop sees
> nothing, the map comes back empty, and `condition_met_by_optimizer_id.get(id, True)` treats every
> optimizer as unconditionally met — turning what used to be non-executing candidates into real
> executed actions on a live system. `_last_plan_condition_map` (`coordinator.py:380, 425-430`) and
> the pre-execution reality check (`coordinator.py:3446`) fail the same way.

> **Why the `max_consecutive_skips` override is here.** Migration turns `skip.on_days` into
> `run_when`, a hard per-day mask. Today `_should_skip` (`daily_runtime.py:242-257`) only skips
> while `prior + 1 <= max_consecutive_skips`. Ship the mask without the override and any config
> with `max_consecutive_skips > 0` skips *indefinitely*.

1. `spec.py` + `conditions/` registry + `conditions/evaluation.py` (mask algebra, OR, candidates),
   including the R1/R2 invariants and the `self_gating` path for `soc_floor`.
2. `config.py` generic reader; one `OptimizerConfigError`; `config_validation.py` loop.
3. `base.py` writer; refactor the five optimizers to consume `Eligibility` and write via the
   writer. They keep their genuine logic (release-slot resolution, cheapest-slot ranking, runtime
   deficit placement, bridge sizing) and lose all gating and all bookkeeping.
4. `daily_runtime`'s `max_consecutive_skips` override: it defeats every group including `custom`,
   so it belongs in the optimizer, not the mask algebra — emit its own reason code
   (`forced_after_consecutive_skips`) so the inspector never shows a forced run as an unexplained
   one.
5. Coordinator condition checkers (`coordinator.py:2257-2363`): re-key
   `_optimizer_condition_checkers` from `optimizer.id` to `(optimizer_id, group_index)`; update
   build, cache-compare, prune, unload, `_last_plan_condition_map` and the condition-flip fast
   re-plan poll. The snapshot map becomes
   `condition_met_by_optimizer_id: dict[str, tuple[bool, ...]]` (per group, config order).
6. `migration.py` + `config_version` + the `async_load` hook + the `ws_save_config` stamp and the
   old-shape rejection rules in `validate_config_document`.

**Reality-check comparison must be on the OR outcome, not raw group bools.** The poll at
`coordinator.py:3446` compares the live condition map against the plan's. Comparing per-group
tuples makes any group flip trigger a re-plan *and* defer one execution cycle, even when the OR
result is unchanged (group 0 flips false→true while group 1 already matched — the plan is still
correct). Compare the derived per-optimizer eligibility, keeping the per-group tuple only for the
trace.

Exit criteria: existing five `tests/test_automation_optimizer_*.py` pass against migrated configs;
new tests cover OR evaluation, first-matching-group-wins, candidate-only-on-custom-failure, param
merge one level deep, the `max_consecutive_skips` override, R2 enforcement over `OPTIMIZER_SPECS`,
and every migration case — especially `max_consecutive_skips == 0` and `only_on_days` absent → all
three classifications. Plus: a config whose `custom` conditions are false still produces candidates
and still does not execute (the regression the coordinator ordering protects).

Trace still reports one `condition_met` per step in this phase (approximate but not wrong: it
reports whether *any* group matched fully).

### Phase 2 — observability

1. `OptimizerTrace.set_condition_met` (`pipeline.py:562-566`) becomes per-group; add
   `matchedGroup` to decision reason params; give groups an optional `name` falling back to index.
2. Reason codes move onto the condition types, so `day_not_matched` / `price_below_threshold` /
   `day_skipped` / `surplus_covers_demand` are emitted from one place per type rather than
   per-kind.
3. **Fix the inspector's frontend derivation rules, which OR groups break.**
   `automation-inspector-model.ts:114-116` keeps a *single* `exportThreshold` and
   `surplusBufferPct` per step, scraped from emitted decision params, and `_deriveCell` (`:380-412`)
   uses them to explain every slot the optimizer declared derivable via `declare_derivable`
   (`trace.py:190`). With per-group thresholds there is no single threshold, so those cells render
   wrong reasons — and `_validate_coverage` (`trace.py:270-308`) cannot catch it, because the slots
   are explicitly declared derivable. Fix by carrying the per-group threshold set on the step DTO
   and having `_deriveCell` test the slot against `min`/`max` of the ORed set (a slot is only
   `price_not_below_threshold` if it clears *every* group's threshold). Update
   `tests/automation_trace_contract.py`, which lists `price_not_below_threshold` as a D-row.
   If that proves fiddly, the fallback is to stop declaring those slots derivable and emit explicit
   rejections — correct but noisier in the trace payload.

Exit criteria: inspector can answer "why this slot" naming the matched group; a condition flip that
changes the OR outcome in any group triggers a re-plan; no derived cell contradicts an emitted one
on a two-group `export_price` fixture.

### Phase 3 — editor

1. `helman/get_optimizer_schema` websocket + TS schema types and cache.
2. `optimizer-field-renderer.ts`, `optimizer-condition-groups.ts`, `optimizer-card.ts`.
3. Delete the five per-kind card renderers and `_renderOptimizerConditionSection`.
4. Translations: `custom` → "Custom conditions", group labels, new help keys, remove the three dead
   field keys, collapse per-kind duplicates onto shared field keys.
5. Save-blocking: zero condition groups is unsavable, and the UI cannot reach that state (new
   optimizers start with one group; removing the last group is disabled).

Exit criteria: `cd frontend && npm run build` clean (vite build; the compiled bundle is gitignored); adding a
sixth optimizer kind requires no new TS file.

---

## Risks and how the plan handles them

- **Behaviour change hidden in the `run_when` inversion.** Highest-risk item in the whole change,
  because it silently affects existing configs. Mitigated by making migration a pure function with
  table-driven tests over all three cases before anything else depends on it.
- **Over-abstracting the registry (YAGNI).** The registry only exists because there are five
  concrete kinds duplicating the same ten helpers today — it is extracted from real duplication,
  not designed for hypothetical kinds. No plugin loading, no dynamic registration, no
  user-defined condition types.
- **Schema-over-websocket adds a round trip.** Cache it with the config load; the editor already
  awaits a config fetch, so it costs no extra user-visible latency.
- **Phase 1 is the big one, and it does not shrink.** The tempting splits — deferring the
  coordinator re-key, deferring the `max_consecutive_skips` override — each ship a window in which
  a live system silently executes actions it should not, or skips a day it should not. Phase 0
  (fields/rails) is the only safe carve-out.
- **Forcing `soc_floor` into the slot-mask abstraction.** The abstraction is worth having, and
  `charge_from_grid` does not fit it; the `self_gating` escape hatch keeps one registry without
  pretending. Resist "unifying" it later without re-reading `charge_from_grid.py:165-228` — the
  conditioned band and the acted-on band are different bands.
- **`Eligibility` looking per-slot to optimizers that think per-day.** R2 plus the `for_day`
  accessor keeps this honest; the invariant is cheap to test and expensive to discover at runtime.

## Explicit non-goals

- No new optimizer kinds.
- No changes to the optimizers' actual decision logic (release-slot resolution, slot ranking,
  bridge sizing) beyond removing gating and bookkeeping.
- No user-defined or templated condition types — `custom` already covers arbitrary logic via HA.
- No change to the schedule document, action model, or execution path.
