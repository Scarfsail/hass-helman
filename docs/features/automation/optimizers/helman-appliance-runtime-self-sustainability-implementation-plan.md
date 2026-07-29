# Helman Automation — `appliance_runtime` self-sustainability (implementation plan)

Status: **proposed** (branch `feat/appliance-runtime-self-sustainability`). Resolves
[issue #3](https://github.com/Scarfsail/hass-helman/issues/3). Code anchors verified against the
tree on 2026-07-29.

Make `appliance_runtime` aware of what running the appliance *does* to the house, rather than only
of what the house looks like when the appliance is ignored.

| Addition | Kind | Question it answers |
|---|---|---|
| `min_solar_coverage_pct` | SLOT condition (mask) | Is this slot's energy free *right now*? |
| `ensure_self_sustainability: soft \| strict` | RUN condition, self-gating | Will running here cost me *later*? |
| `params.self_sustainability.margin_pct` | param, overridable, default `5` | How much headroom above the inverter's reserve? |

Assumes the shape and semantics of
[the conditions unification](helman-optimizer-conditions-unification-implementation-plan.md) and
[the `appliance_runtime` merge](helman-appliance-runtime-merge-implementation-plan.md).

---

## Decisions

| Decision | Note |
|---|---|
| Coverage and self-sustainability stay independent | Neither subsumes the other. Coverage refuses a slot with thin sun even when the battery is full and would cover it for nothing; self-sustainability permits battery use precisely when the simulation shows it is harmless. |
| The floor is `inverter min_soc + margin_pct`, in **percentage points** | Not a bare SoC threshold. A floor *at* `min_soc` is provably inert: `min_energy_kwh = nominal × min_soc/100` (`battery_state.py:243`), every discharge path clamps `remaining = max(min_energy_kwh, …)`, and `socPct = remaining/nominal × 100` — so the projected SoC can never reach `min_soc`, let alone breach it. Only a floor strictly above it can ever fire. |
| Level is the condition's *value*, not a bool | One key, three states (absent / `soft` / `strict`), per group. A bool plus a separate level knob would let them contradict. |
| `margin_pct` is a param, the level is a condition | The margin is a property of the installation; the level is a policy that varies by day type. Params are overridable per group, so the margin still can be. |
| `ensure_self_sustainability` is **self-gating** | It couples slots — placing at 09:00 changes whether 20:00 is feasible — and `system_mask &= mask` (`evaluation.py:201`) assumes slot independence. Follows the `reserve_floor_soc` precedent (`conditions/types.py:227`, `charge_from_grid.py:180`). |
| Strict = soft **plus** a day-balance test | A day can balance while still dipping through the floor at noon, so strict inherits the floor check rather than replacing it. |
| Strict compares **both** ΔSoC and Δimport | SoC alone does not prove solar paid: grid import also leaves the battery unchanged. See "Why ΔSoC alone is not enough". |
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
    self_sustainability:
      margin_pct: 5            # floor = inverter min_soc + 5pp
  conditions:
    - name: sunny
      run_when: [surplus]
      min_solar_coverage_pct: 80
      ensure_self_sustainability: soft
    - name: tight
      run_when: [tight]
      when_price_below: 1
      ensure_self_sustainability: strict
```

`min_solar_coverage_pct` and `ensure_self_sustainability` are optional per group; **absent means
unconstrained for that group**, never "inherit a default". A condition field carrying a schema
default is filled into groups that never mentioned it (`fields.py:208`) — how the deleted
`min_surplus_buffer_pct` acquired an unchosen `5` in every live config. `margin_pct` is a *param*,
where a default is legitimate (`charge_from_grid.max_target_soc` precedent, `spec.py:225`).

### The default must live on the object, not only on the member

```python
F.obj(
    "self_sustainability",
    F.percent("margin_pct", default=5),
    default={},                          # ← without this the member default never fires
)
```

`read_field` returns `MISSING` for an absent field *before* descending into an object
(`fields.py:203-210`), so a nested member's default only fires once the parent has a value. Giving
the **object** `default={}` supplies that value, and `read_fields` then fills each member from its
own default. Verified against the real reader:

| Config | Resolved |
|---|---|
| `params` omits `self_sustainability` | `{"self_sustainability": {"margin_pct": 5.0}}` |
| `self_sustainability: {margin_pct: 12}` | `{"self_sustainability": {"margin_pct": 12.0}}` |
| group override omits it (`partial=True`) | `{}` — inherits master, as intended |
| group override sets `margin_pct: 20` | `{"self_sustainability": {"margin_pct": 20.0}}` |

This is the **first defaulted object** in `spec.py` — `daily_minimum` and `window` are optional with
no defaulted members, and `battery_first` has a defaulted member but is `required=True`. The
mechanism is not new (it falls out of `Field.default` + `read_field`'s object branch); only its use
is. Pin it with a test, because nothing else in the tree would catch a regression.

Nesting is kept rather than flattened to `self_sustainability_margin_pct` because it matches the
house style (`daily_minimum`, `battery_first`), reads alongside the `ensure_self_sustainability`
condition it belongs to, and leaves room for a second member without a config break —
`merge_params` merges objects key-by-key (`fields.py:336`), so a group overriding one member would
still inherit the rest.

The object is present on every `appliance_runtime` instance whether or not any group sets
`ensure_self_sustainability`, and is simply unread when none does — as `max_target_soc` is on a
`charge_from_grid` with no window to bridge. So no cross-field validation ties the two together.

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

`ConditionType`: `scope=Scope.RUN`, `field=F.string("ensure_self_sustainability",
required=False, choices=("soft", "strict"))`, `build_mask=_all_slots_mask`, `self_gating=True`.
Reason codes are emitted by the optimizer, not the mask — see "Trace".

**The floor**: `battery_state.min_soc + params.self_sustainability.margin_pct`, in percentage
points. With `min_soc = 10` and `margin_pct = 5` the floor is **15%**.

### soft — the battery never breaks the floor

The SoC trajectory, **re-simulated including this appliance's own placements**, must not fall below
the floor anywhere in the remaining plannable horizon.

### strict — soft, plus the day pays for itself

Additionally, over the day the slot belongs to (to local midnight), against the no-appliance
baseline:

* **ΔSoC at the day boundary ≈ 0** — the battery is restored, and
* **Δimport over the day ≈ 0** — no extra grid energy was bought.

Together these mean the appliance's energy came from solar that would otherwise have been exported
or curtailed. The battery may be drained mid-morning provided the day's sun refills it — which is
exactly what `min_solar_coverage_pct` cannot express, since coverage is per-slot and cannot
time-shift.

**Consequence, intended:** energy consumed after sunset cannot be repaid by today's sun, so strict
confines the appliance to daylight hours. Evening slots are rejected by construction.

### Why ΔSoC alone is not enough

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

All four appear in the baseline too, so they cancel in the delta. This is why strict must compare
against a baseline rather than test for absolute zero import.

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
the floor — and, under `strict`, the day-boundary deltas against `baseline`.

**The day loop is already chronological.** `build_day_contexts` inserts in `sorted(solar_by_date)`
order (`day_context.py:121`) and every hop preserves it. No change needed — but the *dependency* is
now real, so say so in a comment.

**Acceptance re-checks the whole accepted set**, not just the candidate. Accepting an 18:00 slot
changes SoC after 18:00, which lies inside the region a 13:00 slot was checked over.

**Both settings are constant within a day.** Capped placement intersects the window with
`slot_ids_owned_by(resolved.group)` (`appliance_runtime.py:375-376`), so every placeable slot of a
day has the same owning group — hence the same level and the same resolved `margin_pct`. No
"effective floor changes mid-day" rule is needed. **Uncapped mode** iterates `eligibility.iter_slots()`
across groups, so it can mix: there, apply the level of the group owning the candidate, and accept
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
plans are continuously re-planned. For `strict`, a day whose midnight lies beyond the horizon falls
back to the horizon end.

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
| `not_solar_neutral` | rejected | `{deltaSocPct, deltaImportKwh}` — strict's day-balance test |
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
4. ✅ **`ensure_self_sustainability: soft`.** Greedy acceptance, baseline simulation, forced-run
   re-ranking, `would_break_soc_floor` + `soc_floor_already_breached`. Rule 3 excludes the
   condition via `ConditionType.self_gating` rather than by name — a self-gating condition
   contributes an all-true mask *by definition*, so the exclusion is a property, not a list.
5. **`ensure_self_sustainability: strict`.** The day-boundary ΔSoC/Δimport test and
   `not_solar_neutral`.

---

## Tests

* Config surface: a config that omits `self_sustainability` entirely still resolves
  `margin_pct: 5`; a group overriding it wins; a group that omits it inherits master. This is the
  first defaulted object in the tree, so nothing else guards it.
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
