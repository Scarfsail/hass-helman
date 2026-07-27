# Helman Automation — `appliance_runtime` merge (implementation plan)

Status: **implemented** (2026-07-27, branch `feat/appliance-runtime-merge`). Kept as the design
record — it explains *why* the shape is what it is, which the code cannot. Departures from the plan
as written are noted inline. Code anchors verified against the tree on 2026-07-27.

Merge `surplus_appliance` and `daily_runtime` into one kind, `appliance_runtime`, whose daily-hours
floor, window and skip-forcing are optional. Add a `min_soc_pct` condition, delete
`min_surplus_buffer_pct`, remove both old kinds from YAML and visual mode, migrate
`config_version` 2 → 4.

Assumes the shape and semantics of
[the conditions unification](helman-optimizer-conditions-unification-implementation-plan.md) —
`target` / `params` / `conditions[]`, a condition is a slot mask, groups OR and conditions AND.

---

## Decisions

| Decision | Note |
|---|---|
| Kind name `appliance_runtime` | `appliance_schedule` would collide with `ScheduleDocument` / `scheduling/`. |
| `daily_minimum` and `window` optional | Absent = uncapped / whole horizon. Only `daily_minimum` changes the algorithm. |
| `min_hours_per_day` + `max_consecutive_skips` nest under `daily_minimum`, both required inside | They are one concept and neither is meaningful alone; nesting makes the invalid combination unrepresentable instead of a validation rule, and gives the editor one toggle instead of two nullable scalars. Follows the `charge_hold.battery_first` precedent. |
| Unset means **key absent**, not `null` | `read_field` treats both alike (`fields.py:205`), but the editor and migration should omit rather than write nulls. |
| Delete `min_surplus_buffer_pct` | Unused: all five live instances are `enabled: false` on the schema default. Solar awareness survives as the ranking tiebreak. The *optimizers* are still migrated — only the condition is retired. |
| Add `min_soc_pct`, SLOT scope | The battery-aware gate, against a rail that already exists. |
| Surplus definition stays fixed | `availableSurplusKwh` only. |
| Append, not repaint | `daily_runtime`'s behaviour wins; `repaint_appliance` is deleted. |
| Old kinds removed outright | Not deprecated, not aliased. |

---

## Config shape

Capped:

```yaml
- id: pool-filtration-runtime
  kind: appliance_runtime
  target: { appliance_id: pool-filtration }
  params:
    daily_minimum:
      min_hours_per_day: 8
      max_consecutive_skips: 2
    window: { start: "08:00", end: "18:00" }
  conditions:
    - run_when: [surplus, tight]
      when_price_below: 1
      min_soc_pct: 70
```

Uncapped:

```yaml
- id: pool-heater-soak
  kind: appliance_runtime
  target: { appliance_id: appliance-heater-pool }
  params:
    window: { start: "10:00", end: "16:00" }
  conditions:
    - min_soc_pct: 90
```

`params: {}` with a single unconditioned group would mean *on for the whole horizon*, and is
rejected — see validation rule 3. It is also why migration rule 4 seeds `run_when` rather than
leaving a translated `surplus_appliance` group empty.

---

## Semantics

One fork in `optimize()`:

```
eligible = AND(group conditions) ∩ window        # window absent → whole horizon

if daily_minimum is absent:                      # uncapped
    place every eligible slot
else:                                            # capped
    per day: deficit = daily_minimum.min_hours_per_day - delivered_hours
             place cheapest ceil(deficit / slot_hours) of the matched group's slots
```

**Group resolution differs by mode.** Uncapped uses `eligibility.iter_slots()` (per slot); capped
uses `eligibility.for_day()` + `slot_ids_owned_by()`, because the daily minimum is a per-day
quantity. This is legal because `OptimizerSpec.param_scope` (`spec.py:43`) is advisory — no
production code reads it; the only other reference is `tests/test_automation_conditions.py:251`.

**Ranking is capped-mode only.** Uncapped has no solar or price preference; its gate is `window` +
conditions alone. State this in the module docstring.

**Overrides.** `merge_params` merges objects key-by-key (`fields.py:336`), so a group may override
`daily_minimum.min_hours_per_day` and inherit `max_consecutive_skips`. The latter keeps
`overridable=False` — it describes a chain of days, not one day in it — and `read_fields(partial=True)`
enforces that inside nested objects (`fields.py:180`). A group may not introduce or remove
`daily_minimum` itself: mode is a property of the optimizer, not of the day.

**Cross-field validation** — `_validate_daily_runtime` (`spec.py:88`) becomes
`_validate_appliance_runtime`, over resolved params:

1. `window.end > window.start` — when `window` is present.
2. `window_hours >= daily_minimum.min_hours_per_day` — when both are present.
3. An **uncapped** group must narrow the horizon somehow: it declares a condition other than
   `run_when`, or a `run_when` narrower than all classifications, or the optimizer sets `window`.
   Otherwise the group places the appliance on for the whole horizon.

The rule "`max_consecutive_skips` without a minimum is an error" is gone: the nesting makes that
state unrepresentable.

⚠️ Rule 3 cannot live in `spec.validate` as it stands — the hook receives resolved *params* only
(`config.py:318`), and this rule reads condition values. `run_when` also carries a schema default
(`types.py:188`), so it is present in every group's `condition_values` and a naive "declares no
condition" test can never fire. Extend the hook to `validate(params, condition_values, path=…)`;
`_validate_daily_runtime` is its only current implementation, so the change is cheap, and it keeps
a kind-specific rule in `spec.py` rather than in the generic reader at `config.py:276`.

---

## `min_soc_pct`

`ConditionType` in `conditions/types.py`: `scope=Scope.SLOT`,
`field=F.soc("min_soc_pct", required=False)`, `reason_code="soc_below_threshold"`.

**No schema default.** A condition field with a `default` is filled in for groups that never
mentioned it (`fields.py:208`), which is what put an unchosen `5` in every live
`min_surplus_buffer_pct`. Absent must mean the key never reaches `condition_values`
(`config.py:299`), so no mask is built.

**Rail**: `read_soc_by_bucket` (`rails.py:94`) — `socPct`, 15-minute buckets (`const.py:65`).

**Test**: slots are 30 minutes (`const.py:31`), so each spans two buckets. A slot is eligible iff
**every** overlapping bucket satisfies `socPct >= threshold`. `socPct` is a level: no duration
scaling, no multiplier. Sampling only the slot start would let the appliance switch on into a
battery falling through the floor mid-slot. A missing bucket fails closed.

**Unavailable rails raise, never return empty.** An empty mask would place nothing, which is
indistinguishable from the conditions correctly saying no. Add
`read_soc_by_bucket_covering_horizon`, refusing partial coverage as
`read_available_surplus_by_bucket_covering_horizon` did (`rails.py:150-163`), and raise from the
mask. Rename the exception `SurplusApplianceSkip` → `ConditionRailsUnavailable` (`types.py:49`,
exported at `optimizers/__init__.py:10`); the pipeline's restore-baseline arm (`pipeline.py:586`)
is otherwise left without a raiser.

**Accepted imprecision.** The trace captures `batterySocPct` with `last_fields=("socPct",)`
(`pipeline.py:786`) — the last bucket in the slot — while the mask rejects on *any* bucket. A slot
rejected on its first bucket is therefore explained with a number that passes. Accepted rather than
adding a `min_fields` rail to every trace payload for every step; say so in the derivation rule's
comment. Revisit only if it confuses in practice.

---

## Deletions

No other callers; verified.

| Thing | Anchor |
|---|---|
| `optimizers/surplus_appliance.py` | whole file |
| `_surplus_buffer_mask` + its `ConditionType` | `types.py:129`, `types.py:204` |
| `read_available_surplus_by_bucket_covering_horizon` | `rails.py:138` |
| `ScheduleWriter.repaint_appliance` | `base.py:193` |
| `param_scope` | `spec.py:43` — delete, or mark advisory in its docstring |

Kept: `read_available_surplus_by_bucket` (`rails.py:114`) and `_slot_is_solar_covered`
(`daily_runtime.py:433`), the capped-mode ranking tiebreak.

---

## Migration (`config_version` 2 → 4)

### Restructure into a version chain first

Shipped as two steps: **v2 → v3** nests the params (Phase 2), **v3 → v4** renames the kind and
drops `surplus_appliance` (Phase 3).

`migration.py` implements one transform, v1 → v2, guarded only by an early return at
`migration.py:58`. Bumping the version with the module as-is runs the v1 transform over v2
documents: `_migrate_optimizer` rebuilds each optimizer excluding `"conditions"`
(`migration.py:118`) and re-adds a group holding only `custom` from a `"condition"` key v2
documents lack — replacing every condition group with `{"custom": []}`.

```python
_MIGRATIONS = {1: _migrate_v1_to_v2, 2: _migrate_v2_to_v3}

version = _document_version(document)
while version < CONFIG_DOCUMENT_VERSION:
    document = _MIGRATIONS[version](document)
    version += 1
```

The existing v1 body moves wholesale into `_migrate_v1_to_v2`, unchanged.

### v2 → v3 rules

1. `kind: daily_runtime` → `kind: appliance_runtime`; conditions verbatim.
2. `params.min_hours_per_day` and `params.max_consecutive_skips` → `params.daily_minimum.*`. Every
   v2 `daily_runtime` is capped (both keys were required), so the object is always created. Group
   `params` overrides carrying `min_hours_per_day` nest the same way.
3. `max_consecutive_skips` absent → materialise `0` inside the object. It reads like "never force"
   but means "force after the first short day" (`daily_runtime.py:307`), and Phase 2 gives absence
   the opposite meaning.
4. `kind: surplus_appliance` → `kind: appliance_runtime`, uncapped (no `daily_minimum`), `enabled`
   and `target` carried over untouched. Each group loses `min_surplus_buffer_pct` and gains
   `run_when: ["surplus"]` unless it already has one: an uncapped group that narrows nothing means
   "on for the whole horizon" and the reader rejects it (validation rule 3), so the retired
   condition cannot simply leave a hole. `run_when: ["surplus"]` is the closest honest reading of
   the kind and invents no threshold, unlike seeding a window or an SoC floor. It is a starting
   point to refine — most instances will want `min_soc_pct` — not a reproduction of the buffer
   test, which is no longer expressible.

### Save path

`validate_config_document` rejects old shapes rather than rewriting them. Add both retired kinds to
the rejected-kind rules, naming `appliance_runtime` in the message.

---

## Phases

Each ships independently and leaves the tree green.

> **Departure from the plan.** Phases 3 and 4 shipped as one commit, and there are **two**
> `config_version` bumps rather than one. A schema change and its migration cannot be separated
> without leaving the tree unable to read the stored config, so the params nesting migrated at
> v2 → v3 in Phase 2 and the kind rename at v3 → v4 in Phase 3. Two cheap migrations beat one
> broken intermediate commit.

### Phase 1 — `min_soc_pct` on `daily_runtime`

- `rails.py`: add `read_soc_by_bucket_covering_horizon`.
- `conditions/types.py`: rename the exception; add the `min_soc_pct` `ConditionType`.
- `spec.py`: `daily_runtime.condition_types = ("run_when", "when_price_below", "min_soc_pct")`.
- Frontend: `soc_below_threshold` into `KNOWN_REASON_CODES`
  (`automation-inspector-model.ts:82`); en/cs strings; editor help text.

### Phase 2 — optional params and uncapped mode

Still `kind: daily_runtime`; existing configs unaffected.

- `spec.py`: `window` becomes `required=False`; `min_hours_per_day` and `max_consecutive_skips` move
  into `F.obj("daily_minimum", ...)`, itself `required=False`, both members required inside and
  `max_consecutive_skips` losing its `default=0`. Extend the `validate` hook to take condition
  values (rule 3) and swap in `_validate_appliance_runtime`.
- `daily_runtime.py`: fork `optimize()` on `daily_minimum is None`; add the uncapped path over
  `eligibility.iter_slots()`.
- Trace codes: add `conditions_matched` for uncapped placement. `runtime_deficit_placed`,
  `ranked_more_expensive` and `runtime_satisfied` are capped-mode only; `surplus_covers_demand` and
  `surplus_insufficient` retire with the condition.
- **Editor: optional params in master mode.** `optimizer-field-renderer.ts:55` flattens objects into
  the parent grid and master fields always render via `renderRequiredNumberField` — there is no
  unset state outside override mode. Needs (a) an optional-object group that renders as a labelled
  block with an add/remove toggle rather than flattening, and (b) optional scalars in master mode.
  This is the bulk of Phase 2's frontend work; the nesting is what keeps it to one toggle.

⚠️ Dropping `default=0` changes resolved params for configs omitting `max_consecutive_skips`
(`0` → absent, force → never force). Covered by migration rule 3.

### Phase 3 — rename

- `optimizers/daily_runtime.py` → `optimizers/appliance_runtime.py`; class, builder,
  `optimizers/__init__.py`, `optimizer.py`.
- `spec.py`: rename the spec, delete the `surplus_appliance` spec. `KNOWN_OPTIMIZER_KINDS` and
  `helman/get_optimizer_schema` (`websockets.py:167`) follow from `OPTIMIZER_SPECS`.
- Apply the [Deletions](#deletions) table.
- Frontend: collapse `SURPLUS_APPLIANCE_OPTIMIZER_KIND` / `DAILY_RUNTIME_OPTIMIZER_KIND`
  (`helman-config-editor.ts:89-90`) to one constant, simplifying the test at `:4402`. Rename
  `surplus-appliance-ui.ts` → `appliance-optimizer-ui.ts` (`buildSurplusApplianceSelectionState`
  → `buildApplianceSelectionState`). Retire the `kind === "surplus_appliance"` derivation rule
  (`automation-inspector-model.ts:445`).
- Translations en + cs: `editor.help.automation` (`en.json:83`) names `surplus_appliance`; merge
  `surplus_appliance_*` (`:219-228`, `:368-370`) and `daily_runtime_*` (`:379-382`) into one
  `appliance_runtime_*` set; delete `:370` (buffer pct).
- Tests: merge the two optimizer test files into
  `test_automation_optimizer_appliance_runtime.py`; re-target the three
  `SurplusApplianceSkip` assertions (`:554`, `:569`, `:619`) at `min_soc_pct`.

### Phase 4 — migration

Merged into Phases 2 and 3; see the departure note above. What landed:

- `const.py`: `CONFIG_DOCUMENT_VERSION = 4`.
- `migration.py`: version chain, `_migrate_v2_to_v3` (nesting), `_migrate_v3_to_v4` (rename+drop).
- `config.py`: `RETIRED_OPTIMIZER_KINDS` raises `retired_optimizer_kind` naming the replacement,
  rather than the generic unknown-kind error listing every supported kind.
- `tests/test_stored_config_migration.py` is the acceptance gate; the real store migrates to
  `appliance_runtime` with `min_hours_per_day: 8` and `max_consecutive_skips: 2` preserved, and
  the five disabled `surplus_appliance` optimizers dropped.

---

## Tests

- **`min_soc_pct` mask**, threshold 70, 30-minute slots over 15-minute buckets:

  | slot | buckets | verdict |
  |---|---|---|
  | 10:00 | 62, 66 | rejected |
  | 10:30 | 71, 74 | eligible |
  | 11:00 | 70, 82 | eligible — `>=` is exact |
  | 11:30 | 91, 69 | rejected — second bucket fails |
  | 12:00 | 88, *absent* | rejected — fails closed |

  Plus: a battery forecast short of the horizon raises `ConditionRailsUnavailable`.
- **Mode fork** — identical snapshot, one config each way: uncapped places every eligible slot,
  capped places exactly `ceil(deficit / 0.5h)`.
- **Uncapped ignores runtime history** — `delivered_hours` must not shrink an uncapped placement.
- **Validation** — a partial `daily_minimum` (either member alone) rejected; `window` narrower than
  `daily_minimum.min_hours_per_day` rejected. Rule 3: uncapped with a default `run_when` and no
  other condition rejected; the same plus a `window`, or plus `min_soc_pct`, or with a narrowed
  `run_when`, accepted; a *capped* optimizer with no conditions accepted.
- **Overrides** — a group overriding `daily_minimum.min_hours_per_day` inherits
  `max_consecutive_skips`; overriding `max_consecutive_skips` is rejected.
- **Migration** — table-driven v2 → v3 including the nesting move, plus: a v2 document through the
  chain keeps its condition groups.
- **Groups** — `min_soc_pct` AND `when_price_below` in one group; the same two across two groups
  giving the union.

`scripts/run_tests.sh`, one process per file. Frontend via `cd frontend && npm run build`.

---

## Non-goals

- Changing the ranking function (`daily_runtime.py:398-430`).
- Making `min_soc_pct` self-gating. The mask is built once from the pre-run snapshot, so it cannot
  see the appliance's own draw depressing the SoC that authorised it — the same blind spot
  `min_surplus_buffer_pct` had. Document it in the condition's docstring; revisit if it bites.
- A per-appliance max-hours cap.
- The other three optimizer kinds.
- Exact SoC in the inspector — see "Accepted imprecision" under `min_soc_pct`.
