# Helman Automation — `appliance_runtime` self-sustainability (implementation plan)

Status: **implemented** (branch `feat/appliance-runtime-self-sustainability`). Resolves
[issue #3](https://github.com/Scarfsail/hass-helman/issues/3). Code anchors verified against the
tree on 2026-07-29.

Revised 2026-08-13 by [issue #99](https://github.com/Scarfsail/hass-helman/issues/99), which
replaced the `soft`/`strict` level with a single 0–100 day budget and moved `margin_pct` from
`params` into a condition beside it. The two words were never two points on one scale, so there was
no way to say "the appliance may lean on the battery a little"; `0` and `100` reproduce them
exactly. This document describes the current shape — see the config-migration section for what
existing configs become.

Make `appliance_runtime` aware of what running the appliance *does* to the house, rather than only
of what the house looks like when the appliance is ignored.

| Addition | Kind | Question it answers |
|---|---|---|
| `min_solar_coverage_pct` | SLOT condition (mask) | Is this slot's energy free *right now*? |
| `ensure_self_sustainability: 0..100` | RUN condition, self-gating | Will running here cost me *later*? |
| `self_sustainability_margin_pct` | RUN condition, qualifier, default `5` | How much headroom above the inverter's reserve? |

Assumes the shape and semantics of
[the conditions unification](helman-optimizer-conditions-unification-implementation-plan.md) and
[the `appliance_runtime` merge](helman-appliance-runtime-merge-implementation-plan.md).

---

## Decisions

| Decision | Note |
|---|---|
| Coverage and self-sustainability stay independent | Neither subsumes the other. Coverage refuses a slot with thin sun even when the battery is full and would cover it for nothing; self-sustainability permits battery use precisely when the simulation shows it is harmless. |
| The floor is `inverter min_soc + self_sustainability_margin_pct`, in **percentage points** | Not a bare SoC threshold. A floor *at* `min_soc` is provably inert: `min_energy_kwh = nominal × min_soc/100` (`battery_state.py:243`), every discharge path clamps `remaining = max(min_energy_kwh, …)`, and `socPct = remaining/nominal × 100` — so the projected SoC can never reach `min_soc`, let alone breach it. Only a floor strictly above it can ever fire. |
| The budget is the condition's *value*, not a bool | One key, per group, and absent still means unconstrained. A bool plus a separate knob would let them contradict. **`0` is the strictest value, not the absent one** — every reader tests `is None`, never truthiness. |
| Both numbers are conditions | The margin was a param, which buried it in the optimizer's general section and let its label fall back to the shared `margin_pct` string. As a condition it sits beside the budget it qualifies and is natively per-group. |
| `ensure_self_sustainability` is **self-gating** | It couples slots — placing at 09:00 changes whether 20:00 is feasible — and `system_mask &= mask` (`evaluation.py:201`) assumes slot independence. Follows the `reserve_floor_soc` precedent (`conditions/types.py:227`, `charge_from_grid.py:180`). |
| The budget **inherits** the floor rather than replacing it | A day can come in under budget while still dipping through the floor at noon. The floor test runs first and unconditionally, at every budget value. |
| The budget sums battery drain and grid import | Both are energy the sun did not provide, and which of them a placement lands on is battery physics rather than anything the optimizer picks — budgeting one would leave the other ungoverned. SoC alone especially does not prove solar paid, since grid import can leave the battery unchanged; see "Why ΔSoC alone is not enough". |
| `100` means *unbounded*, not one battery's worth | A multi-kW appliance running a full window can exceed nominal capacity in a day, so a literal 100 % budget would still refuse placements the floor alone was meant to govern. |
| `min_soc_pct` is kept | "Is the battery low *now*" is a different question from "will the plan *make* it low". |
| Forced runs bypass self-sustainability | Consistent with today: `max_consecutive_skips` already defeats every group's conditions. The forced ranking inverts to `(covered, price)` so the run takes the least damaging slots. |
| `when_price_below`'s bucket aggregation is **out of scope** | It is a pre-existing inconsistency in a condition shared with `export_price`, with its own design question. Tracked as #5 — see "Deliberately not here". |
| Midnight-crossing windows stay out of scope | Separate issue (#4). |

---

## Config shape

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
    - name: sunny
      run_when: [surplus]
      min_solar_coverage_pct: 80
      ensure_self_sustainability: 100          # floor only
      self_sustainability_margin_pct: 5        # floor = inverter min_soc + 5pp
    - name: tight
      run_when: [tight]
      when_price_below: 1
      ensure_self_sustainability: 0            # the day must pay for itself
```

`min_solar_coverage_pct` and `ensure_self_sustainability` are optional per group; **absent means
unconstrained for that group**, never "inherit a default". A condition field carrying a schema
default is filled into groups that never mentioned it (`fields.py:208`) — how the deleted
`min_surplus_buffer_pct` acquired an unchosen `5` in every live config.

### The margin is the one condition that *does* carry a default

`self_sustainability_margin_pct` is deliberately the exception, because it is not a gate: it moves
the floor that `ensure_self_sustainability`'s own test compares against. A group that asked for a
budget but named no margin still needs one, and `5` is what it always had as a param.

That makes it a **qualifier** — `ConditionType.qualifier=True` — which has two consequences the
`min_surplus_buffer_pct` lesson demands:

* **No explanation column.** Nothing resolves it, so a node could only ever read `not_evaluated`,
  on every group the default touches. `_column_keys` skips qualifiers entirely rather than emitting
  a column with no nodes in it.
* **It cannot satisfy the uncapped "narrows nothing" rule** (`spec.py`). It admits every slot, and
  it is defaulted — counting it would stop that check ever firing again, for any group.

Neither exclusion is by name: both read the flag, so a second qualifier inherits them.

The floor is in percentage *points* above the inverter's own reserve rather than a bare SoC
threshold. A floor *at* `min_soc` is provably inert (see the decision table), so only the margin
gives it teeth — which is also why a margin of `0` is legal and simply never fires.

### Config migration (document v10 → v11)

`_unify_self_sustainability` in `automation/migration.py`, on `appliance_runtime` optimizers only:

| Before | After |
|---|---|
| `ensure_self_sustainability: strict` | `ensure_self_sustainability: 0` |
| `ensure_self_sustainability: soft` | `ensure_self_sustainability: 100` |
| `params.self_sustainability.margin_pct: 12` | `self_sustainability_margin_pct: 12` on **every** group, including ones with no budget |
| a group override setting `margin_pct: 20` | `self_sustainability_margin_pct: 20` on that group, beating the master |
| the feature used, no margin named anywhere | `self_sustainability_margin_pct: 5` — the old param default, written out |
| no margin named, and a group that never used the feature | nothing written; the condition field's own default covers it |

The first and last rows look inconsistent and are not. A named master margin *was* what every group
resolved, so dropping it from the ones without a budget would mean a group that gains one later
silently runs on `5` instead of the 12 the config has said all along. A margin nobody typed has no
such meaning to preserve, and writing it out would be noise on every group of every appliance.

`params.self_sustainability` is removed either way, as is a group `params` override the move
empties — an empty override renders in the editor as a group that overrides params when it does not.

---

## `min_solar_coverage_pct`

`ConditionType` in `conditions/types.py`: `scope=Scope.SLOT`,
`field=F.percent("min_solar_coverage_pct", required=False)`,
`reason_code="insufficient_solar_coverage"`.

`F.percent` does not exist yet — add it to `fields.py` as `Field(type="number", minimum=0,
maximum=100)`. Structurally that is what `F.soc` already is (`fields.py:100`), but the name carries
battery semantics this field does not have.

**Semantics.** For every 15-minute bucket the slot spans, the appliance's demand for that bucket
(`build_when_active_demand_slices`, `projection_builder.py:441`) must be covered by projected
`availableSurplusKwh` (`rails.py:138`) to at least the configured share. Every bucket must clear —
sampling one end would authorise a slot on a value that holds for half of it.

`100` reproduces today's `_slot_is_solar_covered` (`appliance_runtime.py:590`), promoted from a
ranking tiebreak to a gate. Values below 100 exist because full coverage is unreachable for the
appliance class this targets: a 1 kW pool pump against 0.8 kW of surplus is *never* covered, so a
strict-only condition would mean "never runs".

### Why coverage needs no simulation

`availableSurplusKwh` is what remains **after** the battery has charged
(`battery_capacity_forecast_builder.py:608`) — non-zero only when solar exceeds what the battery can
or will absorb. Consuming it therefore neither discharges the battery nor reduces its charge rate,
so the SoC trajectory is unchanged; and distinct slots consume distinct buckets, so one placement
never changes another's coverage. That is what makes it a legal mask.

Traced through all five simulation paths and confirmed: normal (`:599-611`), forced charge
(`:890-898`), forced discharge (`:968`), `STOP_CHARGING` (`:586-588`), `STOP_EXPORT` (`:612-616`).
In each, `actual_charge_input_kwh` is invariant to reducing `net_kwh` by up to the surplus.

One caveat to document: during a `charge_to_target` bucket the surplus can be non-zero *while the
house is simultaneously importing*, so "solar-covered" does not imply "free".

### Ranking keeps its tiebreak

For thresholds below 100 the boolean "fully covered" tiebreak in `_rank_slots`
(`appliance_runtime.py:537`, sort key at `:547`) still discriminates among slots that passed the
gate. Unchanged.

---

## `ensure_self_sustainability`

`ConditionType`: `scope=Scope.RUN`, `field=F.percent("ensure_self_sustainability",
required=False)`, `build_mask=_all_slots_mask`, `self_gating=True`. Reason codes are emitted by the
optimizer, not the mask — see "Trace".

**The floor**: `battery_state.min_soc + self_sustainability_margin_pct`, in percentage points. With
`min_soc = 10` and a margin of `5` the floor is **15%**. It is a *state* constraint over the whole
horizon: the trajectory, **re-simulated including this appliance's own placements**, must not fall
below it anywhere in the remaining plannable horizon. It is tested first and at every budget value.

### The day budget — how much the sun did not pay for

A *flow* constraint, scored per local date (to local midnight) against the no-appliance baseline:

```
budget_kwh = tolerance_pct / 100 * nominal_capacity_kwh          # tolerance_pct < 100
spent_kwh  = max(0, -Δend_energy_kwh) + max(0, Δimported_kwh)
reject if spent_kwh > budget_kwh + epsilon_kwh
```

Both terms are clamped at zero, so a day ending *better* than the baseline banks nothing against a
day ending worse. `epsilon_kwh` is `max(0.05, 0.005 × nominal)` — the two former "≈ 0" tolerances
(0.5 pp of SoC, 0.05 kWh of import), now on the single axis the budget lives on.

**`0` is the old `strict`**: the battery must be restored and no extra grid energy bought, which
together mean the appliance's energy came from solar that would otherwise have been exported or
curtailed. **`100` is the old `soft`**: the budget test is skipped and the floor alone governs.

The battery may still be drained mid-morning provided the day's sun refills it — which is exactly
what `min_solar_coverage_pct` cannot express, since coverage is per-slot and cannot time-shift.

**Consequence, intended:** energy consumed after sunset cannot be repaid by today's sun, so a zero
budget confines the appliance to daylight hours. Evening slots are rejected by construction.

### Why ΔSoC alone is not enough — and why import joins the same budget

Grid import also leaves the battery unchanged. Concretely: `charge_from_grid` is charging to a
target SoC; the appliance drains 1 kWh at 03:00; the charger simply imports 1 kWh more to still hit
its target. End-of-day SoC is identical and the appliance ran on imported energy.

`importedFromGridKwh` is emitted on every simulation path (`_make_simulated_slot_payload`,
`battery_capacity_forecast_builder.py:1089`) and survives into the optimizer-visible snapshot
unprojected (`coordinator.py:2669`). But it is non-zero in four situations that are **not** the
battery running dry:

1. a `stop_discharging` action imports the whole deficit (`:626-627`);
2. a discharge *power* limit imports even with energy available (`:651-656`);
3. `charge_to_target_soc` imports deliberately (`:889-899`);
4. `discharge_to_target_soc` stops at the target, not the physical minimum (`:947-958`).

All four appear in the baseline too, so they cancel in the delta. This is why the test must compare
against a baseline rather than test for absolute zero import.

The two quantities are not alternatives the optimizer chooses between: a slot's shortfall is covered
by the battery first, capped by `max_discharge_power_w` and floored at `min_energy_kwh`, and only the
remainder becomes grid import (`battery_slot_simulation.py:178-205`). Which one a placement lands on
is physics. That is why they sum into one budget rather than being tested separately — budgeting one
would leave the other ungoverned.

**Known gap:** an SoC floor cannot see import caused by case 2 — adding the appliance's load can push
instantaneous demand above the inverter's discharge limit, forcing import with a full battery.
Negligible for a ~1 kW pump against a multi-kW inverter; real for an EV charger. Document, do not
solve.

---

## Placement algorithm

```
baseline = simulate(no appliance placements)          # once per run

for local_date in day_contexts:                        # already ascending
    plan   = _plan_for_day(...)                        # unchanged
    ranked = _promote_in_flight_slot(_rank_slots(...))  # unchanged
    for candidate in ranked:
        if len(accepted_today) == slots_needed: break
        if holds(accepted | {candidate}):              # NEW
            accepted.add(candidate)
        else:
            reject(candidate, ...)
```

`holds()` re-simulates the horizon with every accepted slot's demand plus the candidate's, and checks
the floor — and, below a budget of 100, the day's spend against `baseline`.

**The day loop is already chronological.** `build_day_contexts` inserts in `sorted(solar_by_date)`
order (`day_context.py:121`) and every hop preserves it. No change needed — but the *dependency* is
now real, so say so in a comment.

**Acceptance re-checks the whole accepted set**, not just the candidate. Accepting an 18:00 slot
changes SoC after 18:00, which lies inside the region a 13:00 slot was checked over.

**Both settings are constant within a day.** Capped placement intersects the window with
`slot_ids_owned_by(resolved.group)` (`appliance_runtime.py:375-376`), so every placeable slot of a
day has the same owning group — hence the same budget and the same margin. No "effective floor
changes mid-day" rule is needed. **Uncapped mode** iterates `eligibility.iter_slots()` across groups,
so it can mix: there, apply the budget and margin of the group owning the candidate, and accept
candidates in chronological order (uncapped has no ranking to order them).

**Forced runs** skip `holds()` entirely but rank by `(covered, price)` instead of `(price, covered)`,
so the run takes the slots that move SoC least. The coverage flag is already computed.

**A day the floor blocks entirely is not seen as short in the same pass.** `_plan_for_day` decides
shortness from the mask-derived `placeable_slots` (`appliance_runtime.py:387`), and a self-gating
condition contributes an all-true mask, so it rejects *after* that decision. The shortfall reaches
`max_consecutive_skips` only via `runtime_hours_by_appliance_id_by_local_date`, which the coordinator
populates for past days and today (`coordinator.py:3222-3223`) — so it is counted a calendar day
later. Accepted; note it, because it is the first gating condition with this asymmetry.

---

## Re-simulation

The optimizer must not reimplement the battery physics; two copies would drift silently.

**Seam.** `_simulate_schedule_action_slot` (`battery_capacity_forecast_builder.py:462`) and its whole
callee subtree touch no instance state — `self._hass` / `self._config` appear only in `__init__`,
`build`, `build_with_history` and `_build_actual_history`. Extraction to module-level functions is
clean. The builder keeps calling it; the optimizer calls it too.

**Inputs the optimizer already has:** per-bucket `solarKwh` / `baselineHouseKwh` / `durationHours` /
`remainingEnergyKwh` from `snapshot.battery_forecast["series"]` (unprojected in memory —
`BATTERY_PUBLIC_SERIES_FIELDS` is applied only in `snapshot_to_dict`, `snapshot.py:136-144`), and
`battery_state` from the context. `baselineHouseKwh` is the *adjusted* house — `_read_house_entry_value`
reads `nonDeferrable.value` (`battery_capacity_forecast_builder.py:1179`), into which
`build_adjusted_house_forecast` has already folded every other appliance's scheduled demand. This
appliance is absent, because `strip_automation_owned_actions` removed its prior-run actions.

### Two plumbing gaps

**1. Discharge parameters.** `max_discharge_power_w` and `discharge_efficiency` are not on
`OptimizationContext`; only the charge-side A1 values are (`snapshot.py:34-39`). Add them alongside.

**2. The inverter overlay is not reconstructible from `snapshot.schedule`.** The forecast was
simulated from a document that is *not* what the snapshot carries:

* `snapshot.schedule` is `deepcopy(schedule_document)` — the **unstripped** original
  (`coordinator.py:2667`);
* the forecast path uses `strip_candidate_actions(schedule_document)` (`coordinator.py:2636-2638`,
  `scheduling/schedule.py:681-710`), which blanks actions stamped `condition_met=False`;
* then `_build_battery_forecast_schedule_document` (`coordinator.py:2851-2875`) **drops**
  `charge_to_target_soc` / `discharge_to_target_soc` slots when the inverter control config lacks the
  matching option;
* only that document becomes the overlay (`coordinator.py:2519-2522`).

An optimizer building an overlay from `snapshot.schedule` would apply candidate actions the forecast
excluded and target-SoC actions it deliberately dropped, producing a trajectory that disagrees with
every rail, the inspector and `min_soc_pct`. `control_config` is not reachable either — `build_optimizer`
reduces it to a `stop_export_supported` bool (`optimizer.py:61`) and `build_appliance_runtime_optimizer`
discards `**_kwargs`.

**Fix: put the overlay the forecast actually used on `OptimizationSnapshot`.** The coordinator already
builds it; carrying it removes the divergence rather than inviting the optimizer to re-derive it.

Note `build_schedule_forecast_overlay` returns an effectively empty overlay when `execution_enabled`
is false (`forecast_overlay.py:66-73`), so the floor sees no inverter actions in that mode — correct,
since none will be executed.

### Cost

Clip the re-simulation to the 48 h schedule horizon (`const.py:32`) = 192 buckets. The series itself
is ~1344 entries, because the battery forecast is built with `forecast_days=MAX_FORECAST_DAYS`
(`coordinator.py:2527`, `const.py:69` = 14). Resume from the earliest changed bucket rather than from
`now`. Index the overlay by slot id — `lookup_slot` is a linear scan (`forecast_overlay.py:47-52`)
and would otherwise be O(buckets × slots) per candidate.

Prefer `remainingEnergyKwh` (4 dp) over `socPct × nominal_capacity_kwh` (2 dp) as the resume energy;
series values are rounded on the way out (`:1082-1088`).

**Horizon-end degradation is accepted.** A slot near the 48 h edge gets little forward check; day-2
plans are continuously re-planned. For the day budget, a day whose midnight lies beyond the horizon
falls back to the horizon end.

---

## Rails must raise, never fail closed

Both additions gate placement, so an empty result is indistinguishable from the conditions correctly
saying no. Raise `ConditionRailsUnavailable` — the pipeline restores the appliance's baseline actions
and collapses the column (`pipeline.py:586`).

| Rail | Today | Needed |
|---|---|---|
| surplus (`read_available_surplus_by_bucket`) | returns `None` only when the series is absent or empty; **never checks horizon coverage** (`rails.py:152-155`) | a `_forecast_covers_horizon` guard, as `read_soc_by_bucket_covering_horizon` has (`rails.py:114-135`) |
| appliance demand profile | `_slot_is_solar_covered` returns `False` | raise |
| `battery_state` | `BatteryLiveState \| None` (`snapshot.py:28`) | raise when `None` |
| battery series | empty on `unavailable` / `not_configured` / `insufficient_history` (`:1323`); **truncated** on `partial` (`:338-345`) | raise unless it covers the horizon |

A partial series is the dangerous one: it truncates rather than pads, so without a guard the coverage
mask silently empties for the back half of the horizon.

---

## Trace

New reason codes. **Four** registration sites, not three:

| Site | What |
|---|---|
| `frontend/cards/localize/translations/en.json` | title + detail |
| `frontend/cards/localize/translations/cs.json` | title + detail |
| `automation-inspector-model.ts:82` | `KNOWN_REASON_CODES` |
| `tests/automation_trace_contract.py:21` | `V1_REASON_CODES` — `assert_trace_contract` hard-asserts every emitted code against it (`:133-146`) |

| Code | Outcome | Params |
|---|---|---|
| `insufficient_solar_coverage` | rejected | `{requiredPct, coveragePct}` |
| `would_break_soc_floor` | rejected | `{floor, projectedMinSoc, atSlot}` |
| `over_battery_budget` | rejected | `{tolerancePct, budgetKwh, spentKwh, deltaSocPct, deltaImportKwh}` — the day budget. Both sides arrive summed, so the frontend compares them directly rather than re-deriving a total and re-knowing the epsilon. |
| `soc_floor_already_breached` | rejected | `{floor, baselineMinSoc}` |

`soc_floor_already_breached` is decided from the **baseline** simulated once per run: if the
no-appliance trajectory already dips below the floor, the appliance is not the cause. It must not be
derived by re-testing "the accepted set minus the candidate" — for the first candidate that set is
empty and the test passes trivially, so the first candidate would always be blamed.

---

## Validation

`_validate_appliance_runtime` (`spec.py:97`) rule 3 requires an uncapped group to narrow the horizon.
`min_solar_coverage_pct` narrows and counts. `ensure_self_sustainability` contributes an all-true
mask and **must not** count — the rule's `narrows` test is `key != "run_when"` (`spec.py:126-129`),
so it would count by default and let an uncapped optimizer place across the whole horizon.

---

## Phases

1. ✅ **Trace rejection fix** (`d7f89b7`). `Eligibility.rejection()` in place of a hardcoded
   `price_above_run_threshold` for every window slot the matched group did not own. Independent bug
   fix, shipped.
2. ✅ **`min_solar_coverage_pct`.** New condition, all-buckets natively, rails guards. No
   simulation, no plumbing. The threshold landed on the *mask*, not on
   `_slot_is_solar_covered`: the gate is the condition, and ranking still wants the plain
   "fully covered" boolean. Both now sit on one `rails.slot_solar_coverage_pct` primitive,
   which the trace also reads to quote a rejected slot its own coverage.
   Preceded by an independent fix (`aeaf261`): a day *no* group owns because a slot
   condition emptied it was formatted as a `run_when` rejection, so `list(threshold)` raised
   `TypeError`. Pre-existing under `when_price_below`; routine once an overcast day can do
   it.
3. ✅ **Re-simulation seam.** The pure slot simulator now lives in `battery_slot_simulation.py`
   rather than at module level inside the builder, so an optimizer can import the physics without
   pulling in `hass`, the recorder and the config reader. Discharge parameters went on
   `OptimizationContext` as planned; the overlay went on `OptimizationSnapshot` (it is a
   forecast input, not a run-invariant parameter) and is deliberately absent from
   `snapshot_to_dict`. No behaviour change — the parity test steps the extracted simulator over
   the builder's own slot inputs and compares entry for entry.
4. ✅ **The SoC floor.** Greedy acceptance, baseline simulation, forced-run re-ranking,
   `would_break_soc_floor` + `soc_floor_already_breached`. Rule 3 excludes the condition via
   `ConditionType.self_gating` rather than by name — a self-gating condition contributes an
   all-true mask *by definition*, so the exclusion is a property, not a list.
5. ✅ **The day budget.** Shipped first as `strict`'s ΔSoC/Δimport test, then generalised (issue
   #99) into `ensure_self_sustainability: 0..100` with the margin moved alongside it as a
   qualifier condition. `0` and `100` reproduce the two words exactly, which is what the migrated
   `strict`/`soft` suites assert. Both comparisons stay one-sided: ending a day *better* than the
   baseline is not a failure.

---

## Tests

* Config surface: a group that omits the margin resolves `5`; a group setting it wins; two groups
  may disagree; the old `params.self_sustainability` object is rejected rather than ignored; the
  budget is a percentage and refuses `"soft"`, `150` and `-1`. Plus the falsy-zero guard: a config
  of only `ensure_self_sustainability: 0` must build a live gate, not the null one.
* The budget between its ends: a slot the day cannot repay is refused at `0`, taken at `100`, and
  flips on the number alone at `1` versus `3` on a 10 kWh battery — the capability the two words
  could not express.
* Migration v10→v11: `strict`→`0`, `soft`→`100`; the margin resolved from master, from a group
  override, and from neither; a group that never used the feature gets no margin written, because
  the condition default already covers it.
* Coverage gate: 79 % fails `min_solar_coverage_pct: 80` and 81 % passes; every bucket must clear;
  a missing surplus rail, a partial surplus rail, and a missing demand profile each raise rather than
  emptying the mask.
* Floor: a placement that would breach is rejected while a cheaper-but-safe alternative is taken;
  an 18:00 acceptance that invalidates an accepted 13:00 slot is rejected; a floor at exactly
  `min_soc` (margin 0) never fires, proving the margin is what gives it teeth.
* Baseline attribution: a trajectory already below the floor emits `soc_floor_already_breached`, and
  specifically does so for the **first** candidate, not `would_break_soc_floor`.
* Strict: a morning drain repaid by midday sun passes; an evening slot fails; a placement that leaves
  SoC restored but raises `charge_from_grid`'s import fails on Δimport with ΔSoC ≈ 0 — the row-7 trap,
  and the reason both deltas exist.
* Cross-day: day 1's placements lower day 2's trajectory; a cheap day-2 slot never displaces a day-1
  slot.
* Forced runs: place despite a breach, and prefer covered slots.
* In-flight: the promoted slot survives when it passes and stops the appliance when it does not.
* Uncapped: candidates accepted chronologically; the level is read from the candidate's owning group;
  `ensure_self_sustainability` alone does not satisfy rule 3.
* Re-simulation parity: the extracted simulator reproduces `_build_schedule_adjusted_series` exactly.

---

## Deliberately not here

**`when_price_below`'s bucket aggregation.** A slot spans two buckets and the condition passes if
*either* is below the threshold, while `min_soc_pct` requires both. For `appliance_runtime` the union
is wrong — the appliance runs through the expensive half. But `when_price_below` is one
`ConditionType` shared with `export_price` (`spec.py:179`, `spec.py:206`), and the two kinds want
opposite aggregation: for `export_price` a true condition triggers a *protective* action, so the
union is the conservative reading, and flipping it would stop `stop_export` on a slot priced −0.1
then +0.2.

Nor can the choice live on the `ConditionType`: `evaluation.py:191` looks the type up in the global
`CONDITION_TYPES` dict and `MaskInputs` carries no optimizer kind, so both kinds share **one object**
(`spec.py:57-62`). Fixing it means threading the kind into `MaskInputs`, or a second condition key.

That is a pre-existing inconsistency with its own design question, and the new coverage condition
does not need it — being new, it is simply all-buckets by construction. Tracked as #5.

Note also that the export price forecast has **no density guarantee**: it is whatever the configured
sensor publishes as timestamped attributes (`grid_price_forecast_builder.py:46`), with no fixed grid
and no alignment validation. Any all-buckets treatment of it must expand prices as a step function —
carrying the last known price forward, as `price_points_to_slots` already documents
(`trace.py:476`) — not look buckets up exactly and fail closed.

## Other non-goals

* Midnight-crossing windows, and the per-calendar-day runtime budget they would need — issue #4.
* Optimal placement under the coupled constraint. Greedy over the existing ranking is deterministic
  and explainable.
* Import caused by discharge *power* limits rather than exhausted energy.
* Retiring `min_soc_pct`.
* Extending either condition to the other three optimizer kinds.
