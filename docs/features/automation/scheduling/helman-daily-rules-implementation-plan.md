# Helman Automation - Day-Scoped Rules (Implementation Plan)

Status: design / implementation plan. Derived from
[`helman-daily-rules-brainstorm.md`](./helman-daily-rules-brainstorm.md) and constrained by
[`../optimizers/helman-automation-optimizer-pipeline-architecture.md`](../optimizers/helman-automation-optimizer-pipeline-architecture.md).

This plan turns the three brainstormed rule kinds plus the shared day context into a concrete
build. It assumes the existing optimizer pipeline (config-driven optimizers, per-run snapshot
rebuild, `setBy=automation` ownership) and does not change that contract except for the two
additive plumbing items called out below.

## Scope

**In scope (v1):**

- A shared, per-calendar-day **day context** (classification + price statistics + import band
  detection), computed framework-side once per run and frozen per day.
- Three new optimizer kinds: `charge_hold`, `charge_from_grid`, `daily_runtime`.
- Two additive `OptimizationContext` inputs: battery parameters, and framework-resolved
  yesterday-runtime per appliance.
- Config schema + validation for the above.
- Surfacing the frozen classification for the UI.

**Explicitly out of scope (v1):**

- Any in-optimizer re-simulation callback (rules compute single-pass over the input snapshot).
- Smarter price-band detection than "contiguous runs of the same tariff level".
- A general planner, proposal/acceptance workflow, or free-form condition DSL.
- EV charging in `daily_runtime`.

## Component map

New/changed files under `custom_components/helman/`:

```text
automation/
  config.py                 # + day_context block, + 3 new param readers, + KNOWN kinds
  input_bundle.py           # + yesterday_runtime_hours_by_appliance_id
  snapshot.py               # + battery params + day_contexts on OptimizationContext
  optimizer.py              # + register 3 new kinds in build_optimizer
  day_context.py            # NEW: DayContext type + builder (classification, price stats, bands)
  day_context_store.py      # NEW: tiny per-calendar-day frozen-classification persistence
  optimizers/
    charge_hold.py          # NEW
    charge_from_grid.py     # NEW
    daily_runtime.py        # NEW
coordinator.py              # populate new context inputs; build+freeze day context per run
config_validation.py        # validate new optimizer params + day_context block
```

Reused as-is (read the code map in the review, key anchors):

- `automation/pipeline.py` — the run loop; rebuilds snapshot between optimizers (`:429`). No
  contract change; day context is attached to the snapshot the loop already threads.
- `automation/ownership.py` — user-wins merge, `stamp_automation_appliance_action`, inverter
  stamping. New rules use the same helpers.
- `forecast_series_fields.py` — the per-slot battery/grid series the rules read.
- `scheduling/schedule.py` — `validate_schedule_domains` / `_validate_action` SoC-bound checks.
- `recorder_hourly_series.py` — recorder access, used only from the framework input-bundle path.
- `appliances/projection_builder.py` — `get_when_active_demand_profile` demand slices.

## Part A — framework plumbing (no behaviour change on its own)

Build this first; the three rules depend on it. Landing it behind the existing "no enabled
optimizers → cleanup-only" behaviour means it can ship before any rule is wired in.

### A1. Battery parameters on `OptimizationContext`

`charge_hold`'s single-pass math needs **max charge power (kW)**, **usable capacity (kWh)**,
and **charge efficiency**. These are used inside `BatteryCapacityForecastBuilder` today but are
not on the context.

- Add three fields to `OptimizationContext` (`automation/snapshot.py:24`).
- Populate them in `_build_automation_snapshot_from_schedule_locked`
  (`coordinator.py:2058`) from the same battery config the forecast builder reads. Source of
  truth stays the battery config; the context just surfaces the already-resolved numbers.
- They are static per run, so they can live on the pinned `AutomationInputBundle`
  (`input_bundle.py`) and be copied into each rebuilt snapshot's context.

### A2. Yesterday-runtime per appliance on the input bundle

`daily_runtime` needs "how many hours did this appliance actually run yesterday" (and today so
far, for the current-day budget) to honour `min_hours_per_day` and `max_consecutive_skips`.
Optimizers are synchronous and must not read the recorder.

- Add `runtime_hours_by_appliance_id_by_local_date: dict[str, dict[date, float]]` to
  `AutomationInputBundle`. Resolve a window of `max(max_consecutive_skips) + 1` days back from
  today (decision 3) — enough to evaluate the consecutive-skip guard for the largest configured
  `max_consecutive_skips`, plus today-so-far for the current-day budget.
- Resolve it in the framework refresh/pin path using `recorder_hourly_series` +
  `history.state_changes_during_period`, iterating the **eligible appliance registry**
  (not the schedule) so unscheduled candidate appliances are still present — same rule the
  architecture doc states for demand inputs (`optimizer-pipeline-architecture.md:151`).
- Surface it read-only on `OptimizationContext`. The rule reads it synchronously.

### A3. Day context: type, builder, per-day segmentation

`day_context.py` defines a per-calendar-day payload and a builder run once per automation run.

```text
DayContext
- local_date
- classification: "surplus" | "tight" | "deficit"
- predicted_solar_kwh
- predicted_consumption_kwh
- export_price_min, export_price_max
- day_min_window: (start, end)          # slot window containing the export-price minimum
- import_bands: list[(level: "cheap"|"expensive", start, end)]
```

Builder inputs: the pinned bundle (solar forecast, grid price forecast, house forecast) plus
the initial snapshot's `batteryForecast` / `gridForecast` (for the SoC-aware refinement).
Builder output: a `dict[local_date, DayContext]` for **every calendar day present in the 48 h
horizon** — today always, tomorrow once tomorrow's prices have arrived (~14:00).

Per-day computation (each over that day's slots only):

1. **Totals** — sum `solarKwh` and `baselineHouseKwh` over the day's slots.
2. **Classification** — ratio `predicted_solar_kwh / predicted_consumption_kwh` against
   configured `deficit_below_ratio` / `surplus_above_ratio` (the intuition), *refined* by the
   engine's simulated baseline trajectory per brainstorm resolution 11: if the simulated SoC
   reaches full with surplus export → lean `surplus`; if it shows imports in expensive hours →
   lean `deficit`. v1 keeps this simple: ratio picks the band, the simulated end-of-day SoC and
   presence of expensive-hour imports can only *demote* surplus→tight or tight→deficit, never
   promote. (Exact refinement rule is a small tunable; start with ratio-only + a surplus guard
   that a `surplus` day must actually reach full in the baseline sim.)
3. **Export-price stats** — min/max over the day; `day_min_window` = the slot(s) at the minimum.
4. **Import bands** — partition the day's import price into contiguous runs of the same tariff
   level; cheap = the lower level. (Two-level step tariff today; nothing smarter in v1.)

### A4. Freezing the classification (per-calendar-day persistence)

Per the brainstorm's stability decision (option 1), freeze the classification and the day-min
window per calendar day.

- `day_context_store.py` — a tiny JSON store keyed by `local_date`, holding `{classification,
  day_min_window, frozen_at}`. Modeled on the existing schedule store's load/save shape; small
  and separate.
- On each run, for each day in the horizon:
  - if a frozen record exists for that date → reuse its `classification` and `day_min_window`;
    recompute only the volatile fields (totals, bands, current price stats) from the live
    forecast.
  - else → compute everything and persist the frozen fields.
- Prune records whose date is before today.
- Everything else (the battery-first safety bounds in `charge_hold`) is recomputed live every
  run so the hold can only ever *shorten*.

This is the one deliberate, narrowly scoped exception to the stateless-optimizer model; it is
framework-owned and invisible to the optimizer contract.

## Part B — `charge_hold` (use case 1)

Config (in `automation.optimizers[]`):

```yaml
- id: morning-export
  kind: charge_hold
  params:
    only_on_days: [surplus]
    hold_action: stop_charging
    release: day_price_min
    window: { start: "06:00", end: "14:00" }
    battery_first:
      target_soc: 100
      margin_pct: 20
```

Algorithm (single pass, per day in horizon, read-only over the input snapshot):

1. **Gate** — resolve the slot's `DayContext`; if `classification ∉ only_on_days`, write nothing
   for that day.
2. **needed_kwh** — `(target_soc − current_socPct) × usable_capacity / charge_efficiency`, from
   the snapshot's current SoC and the A1 battery params.
3. **surplus_after(t)** — for each candidate release slot `t` in `window`, sum over slots `≥ t`
   of `max(0, solarKwh − baselineHouseKwh)`, clipping each slot at max charge power × slot hours.
4. **latest_safe_release** — the latest `t` with `surplus_after(t) ≥ needed_kwh × (1 +
   margin_pct/100)`.
5. **release_slot** — `min(day_min_window.start, latest_safe_release)` (release at the earlier of
   the price minimum and the latest safe slot; price bound may only move it earlier).
6. **Write** — `stop_charging` (`setBy=automation`) for each slot in `[window.start,
   release_slot)` intersected with the day and the rolling horizon, **only** where the inverter
   action is empty or already automation-owned (`ownership.is_user_owned_inverter_action`).
7. **Corner cases** — if even releasing at `window.start` can't cover `needed_kwh`, write
   nothing (no room to hold); if `needed_kwh ≤ 0`, hold across the whole window.

Never writes `normal` — releasing means it stops writing `stop_charging`, leaving those slots
free for other rules / default `normal`.

**Ordering:** must run **before** `export_price` in config order, so `export_price`'s protective
`stop_export` wins any slot both want (they share the single inverter action position). Document
this; validation can warn if `export_price` precedes a `charge_hold`.

## Part C — `charge_from_grid` (use case 4)

Config:

```yaml
- id: grid-bridge-charge
  kind: charge_from_grid
  params:
    reserve_floor_soc: 30
    margin_pct: 10
    max_target_soc: 100
```

Self-gating (no `only_on_days`). Algorithm per run, per day's bands:

1. **Bands** — from `DayContext.import_bands`.
2. **Per expensive window** — read the snapshot's simulated `socPct` through the window; if it
   never dips below `reserve_floor_soc`, skip (covered).
3. **Target** — `dip` = how far below `reserve_floor_soc` the trajectory falls (in SoC pts);
   `target = window_start_soc + dip × (1 + margin_pct/100)`; then **clamp to `[min_soc,
   min(max_soc, max_target_soc)]`** so `set_schedule` validation (`schedule.py:902-917`) accepts
   it. If the window can't be bridged even from full, charge to the cap (partial bridging still
   displaces the priciest hours).
4. **Place** — in the immediately preceding cheap window, sort slots by import price ascending,
   take the cheapest until the required energy (given max charge power) is met, and write
   `charge_to_target_soc` with the clamped target (`setBy=automation`), only on empty /
   automation-owned inverter positions. No contiguity requirement.

Each expensive window is planned against its own preceding cheap window only (no joint planning).
Not frozen — churn between runs is accepted (only adds energy; elapsed slots aren't rewritten).

## Part D — `daily_runtime` appliance rule (use case 3)

Supports both **generic** and **climate** appliances (decision 4). A generic appliance (the
pool pump) emits `{"on": true}`; a climate appliance emits `{"mode": climate_mode}` and requires
`climate_mode` in params — same authored-DTO split as `surplus_appliance`.

Config (generic example):

```yaml
- id: pool-filtration
  kind: daily_runtime
  params:
    appliance_id: pool-pump        # generic appliance → {"on": true}
    min_hours_per_day: 8
    window: { start: "08:00", end: "18:00" }
    skip:
      on_days: [deficit]
      max_consecutive_skips: 1
```

Config (climate example): add `climate_mode` and target a climate appliance:

```yaml
- id: daily-preheat
  kind: daily_runtime
  params:
    appliance_id: living_room_climate   # climate appliance → {"mode": heat}
    climate_mode: heat
    min_hours_per_day: 4
    window: { start: "09:00", end: "17:00" }
    skip:
      on_days: [deficit]
      max_consecutive_skips: 1
```

Algorithm per day in horizon (kind-agnostic; only the authored action differs):

1. **Already delivered** — from A2's per-appliance runtime for that date, subtract hours already
   run (manual or automation) from `min_hours_per_day` to get the remaining budget. Recorder
   "on" runtime is defined per appliance kind: generic = the on/off state, climate = the
   configured `climate_mode` being active.
2. **Skip decision** — if `classification ∈ skip.on_days` **and** skipping now would not exceed
   `max_consecutive_skips` (checked against A2's prior-day runtimes: a prior day with
   `< min_hours` counts as a skip) → write nothing for the day.
3. **Placement** — otherwise pick the remaining-budget hours from slots inside `window`, ranked
   by: (a) prefer slots where forecast solar surplus covers the appliance's when-active demand
   (free self-consumed energy — read `availableSurplusKwh` vs the demand from
   `get_when_active_demand_profile`), then (b) lowest export price among those. Write the authored
   action for the appliance kind — `{"on": true}` (generic) or `{"mode": climate_mode}`
   (climate), via `stamp_automation_appliance_action` — for the chosen slots, only on empty /
   automation-owned appliance positions for that `appliance_id`.

Stateless beyond the framework-resolved A2 input; manual runs count automatically because they
show up in recorder history.

## Part E — config schema + validation

- `automation/config.py`:
  - add `"charge_hold"`, `"charge_from_grid"`, `"daily_runtime"` to `KNOWN_OPTIMIZER_KINDS`.
  - add per-kind param readers (`_read_charge_hold_params`, etc.) mirroring the strict typing of
    the existing readers (`_read_float`, `_read_non_negative_int`, enum/window checks).
  - add a top-level `automation.day_context` block: `deficit_below_ratio`,
    `surplus_above_ratio` (floats; validate `deficit_below_ratio < surplus_above_ratio`).
- `config_validation.py:_validate_automation_config` (`:961`):
  - `charge_hold` / `charge_from_grid` require a configured battery (SoC bounds resolvable);
    fail loudly at startup otherwise.
  - `daily_runtime` requires `appliance_id` present in the registry and of a supported kind
    (**generic or climate**), and `window` width ≥ `min_hours_per_day`. `climate_mode` is
    required for climate appliances (validated against `appliance.authorable_modes`, as
    `surplus_appliance` does) and forbidden for generic ones.
  - warn (not fail) if a `charge_hold` instance is ordered after an `export_price` instance.

## Part F — UI surfacing

- Expose the frozen `DayContext` (per day: classification, day-min window) in the
  `AutomationRunResult` snapshot metadata and/or a small read path, so the frontend can show
  "today: surplus day" and why the schedule is shaped as it is. Reuse the existing automation
  run-result surface (`helman/get_last_automation_run`); add the day-context summary to it
  rather than a new endpoint if the shape fits.

## Build sequence

Each phase is independently shippable and testable.

1. **A1–A2 plumbing** — battery params + yesterday-runtime on context/bundle. No behaviour.
   Tests: bundle resolution against a fake recorder; context population.
2. **A3–A4 day context** — builder + per-day segmentation + freeze store. No rule consumes it
   yet. Tests: classification thresholds, day-min window, band partition, freeze/reuse/prune.
3. **`charge_hold`** — first consumer of day context + battery params. Tests: latest-safe-release
   math (clip at charge power, margin), release = earlier-of, gate on classification, ownership
   respect, "no room" and "already full" corner cases, shorten-on-degrade across two runs.
4. **`charge_from_grid`** — Tests: band detection, dip→target, clamp to bounds, cheapest-slot
   pick, covered-window skip, sunny-day no-op.
5. **`daily_runtime`** — Tests: remaining-budget from delivered history, skip gate +
   consecutive-skip guard, solar/export ranking, ownership respect, manual-run counting.
6. **UI surfacing** — expose frozen classification in the run result.

Ordering rationale: 1→2 are pure inputs; 3 exercises the hardest math and the freeze path; 4–5
are independent of each other and can parallelize; 6 is cosmetic and last.

## Testing strategy

- **Unit** per optimizer with hand-built `OptimizationSnapshot` fixtures (synthetic per-slot
  series), asserting exact written slots + ownership stamping + that `snapshot.schedule` is not
  mutated in place (contract invariant, architecture `:277`).
- **Day-context builder** unit tests over synthetic forecasts (season-agnostic ratios; two-day
  horizon; missing-tomorrow-prices case).
- **Freeze** tests: first-run computes+persists, later run reuses classification but recomputes
  volatile stats, prune drops past days.
- **Pipeline integration** test: config with all three kinds in order runs end-to-end through
  `AutomationRunner`, produces a merged schedule, user-owned slots survive, re-run is stable
  (no churn on unchanged inputs).
- **Validation** tests for each new param reader and the startup registry/battery checks.

## Confirmed decisions

All resolved; folded into the sections above.

1. **Classification refinement rule (A3 step 2)** — ship **ratio-only** in v1 with a "surplus
   must reach full in the baseline sim" guard; the fuller SoC-aware demotion is a follow-up.
2. **Day-context freeze store** — **standalone** JSON store, keyed by calendar date, separate
   from the schedule document (A4).
3. **A2 runtime history window** — resolve `max(max_consecutive_skips) + 1` days back, plus
   today-so-far.
4. **`daily_runtime` appliance kinds** — support **generic and climate** (climate requires
   `climate_mode`, same as `surplus_appliance`); Part D and Part E updated accordingly.