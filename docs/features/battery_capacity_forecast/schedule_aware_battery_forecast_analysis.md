# Schedule-aware battery forecast analysis

## Goal

Make `battery_capacity` forecast respect the manual scheduler so the forecasted battery behavior matches scheduled inverter actions when schedule execution is enabled.

This analysis covers:

- current architecture and extension points
- confirmed action semantics
- config that already exists
- config or modeling gaps
- design options
- recommended architecture
- API/response recommendations

---

## Accepted direction

After review, the accepted direction is **Option C - pragmatic balance**.

That means:

- keep the current battery forecast pipeline and cache structure
- add a dedicated schedule-to-forecast overlay helper instead of moving all logic into the coordinator
- keep baseline simulation internally
- keep the internal canonical battery forecast slot size at `15` minutes
- keep the schedule-aware forecast path **slot-granularity agnostic** so future `SCHEDULE_SLOT_MINUTES` changes do not require follow-up battery-forecast code changes
- expose schedule-adjusted battery values as the primary output only when scheduler execution is enabled
- include baseline comparison values per slot so the UI can show the impact of the schedule

---

## Confirmed scope and semantics

Confirmed with the user and cross-checked against current scheduler code:

- When scheduler execution is **disabled**, battery forecast should remain the current baseline simulation.
- When scheduler execution is **enabled**, the primary `battery_capacity` numbers should reflect the **schedule-adjusted** simulation.
- The forecast should also expose a **baseline comparison** per slot so the UI can show the impact of the schedule. Recommended fields are:
  - `baselineSocPct`
  - `baselineRemainingEnergyKwh`
- Existing battery forecast settings should be reused:
  - `charge_efficiency`
  - `discharge_efficiency`
  - `max_charge_power_w`
  - `max_discharge_power_w`
- `charge_to_target_soc(target)` means:
  - force charging from grid / available supply at max configured charge power until the battery reaches `target`
  - once `target` is reached, behavior becomes `stop_discharging`
  - that same rule applies for later scheduled `charge_to_target_soc` slots if simulated SoC is already at or above target at slot start
- `discharge_to_target_soc(target)` means:
  - force discharging at max configured discharge power
  - house load consumes part of that output and the rest is exported to grid
  - once `target` is reached, behavior becomes `stop_charging`
  - that same rule applies for later scheduled `discharge_to_target_soc` slots if simulated SoC is already at or below target at slot start
- `stop_charging` blocks charging only; normal discharge may still happen.
- `stop_discharging` blocks discharging only; normal charging may still happen.
- Mid-slot target handling should match scheduler behavior: once target is reached, the remainder of the slot behaves like the paired `stop_*` action.

---

## Additional compatibility requirement

The schedule-aware battery forecast should not hard-code a `30`-minute scheduler.

Required design outcome:

- if `SCHEDULE_SLOT_MINUTES` later changes from `30` to `15`, the schedule-aware battery forecast should continue working without additional battery-forecast-specific code changes
- the scheduler's existing global slot-duration behavior may still apply as-is:
  - materialized schedule grid changes automatically
  - persisted schedules may reset if `slotMinutes` changes, because that is already how the scheduler subsystem works today
- therefore the new overlay/helper must derive its behavior from:
  - `SCHEDULE_SLOT_MINUTES`
  - `FORECAST_CANONICAL_GRANULARITY_MINUTES`
- when scheduler slot size already matches the canonical battery forecast grid, the overlay should naturally collapse to direct slot lookup instead of requiring a special follow-up implementation

This keeps the schedule-aware battery forecast aligned with the scheduler subsystem's current "one constant change" behavior instead of introducing a second maintenance point inside the forecast stack.

---

## Current architecture summary

### Forecast pipeline

Current forecast flow:

1. `helman/get_forecast` enters through `custom_components/helman/websockets.py`
2. `HelmanCoordinator.get_forecast()` assembles:
   - solar forecast via `forecast_builder.py`
   - house forecast via cached/persisted `ConsumptionForecastBuilder`
   - battery forecast via `BatteryCapacityForecastBuilder`
3. all forecast sections are canonicalized to `15`-minute data and reshaped to requested `15 / 30 / 60` output

Relevant files:

- `custom_components/helman/coordinator.py`
- `custom_components/helman/forecast_builder.py`
- `custom_components/helman/consumption_forecast_builder.py`
- `custom_components/helman/battery_capacity_forecast_builder.py`
- `custom_components/helman/battery_forecast_response.py`

### Battery forecast today

Current battery simulation is a **passive net-balance model**:

- input = solar energy minus baseline house consumption
- positive net charges battery
- negative net discharges battery
- behavior is clamped by:
  - min/max SoC
  - charge/discharge efficiency
  - max charge/discharge power

Current simulation does **not** understand control modes such as forced charge, forced discharge, stop charge, or stop discharge.

Relevant files:

- `custom_components/helman/battery_capacity_forecast_builder.py`
- `custom_components/helman/battery_state.py`

### Scheduler today

Current scheduler is already implemented as a separate subsystem:

- sparse persisted schedule document
- rolling `48h` horizon
- `30`-minute slots
- action kinds:
  - `normal`
  - `charge_to_target_soc`
  - `discharge_to_target_soc`
  - `stop_charging`
  - `stop_discharging`
- runtime executor that applies the active slot to a configured mode entity

Important distinction in current scheduler design:

- `action` = requested scheduled action
- `runtime.executedAction` = what executor actually applied for the current slot

Relevant files:

- `custom_components/helman/scheduling/schedule.py`
- `custom_components/helman/scheduling/schedule_executor.py`
- `custom_components/helman/scheduling/README.md`
- `custom_components/helman/websockets.py`

### Key fact

Battery forecast and scheduler currently share the same coordinator, but they are **not connected**. The battery forecast builder currently accepts only:

- `solar_forecast`
- `house_forecast`
- `started_at`
- `forecast_days`

It receives no schedule input.

---

## Config already present

The following config is already available and is sufficient for a first schedule-aware version if the existing battery limits represent the real forced-mode behavior.

### Battery entities

Under `power_devices.battery.entities`:

- `remaining_energy`
- `capacity`
- `min_soc`
- `max_soc`

Important note: in current code, `capacity` is actually used as the **current SoC percent sensor**, not as nominal battery capacity.

### Battery forecast settings

Under `power_devices.battery.forecast`:

- `charge_efficiency`
- `discharge_efficiency`
- `max_charge_power_w`
- `max_discharge_power_w`

### Scheduler control config

Under `scheduler.control`:

- `mode_entity_id`
- `action_option_map.normal`
- `action_option_map.charge_to_target_soc`
- `action_option_map.discharge_to_target_soc`
- `action_option_map.stop_charging`
- `action_option_map.stop_discharging`

### Schedule enable/disable state

This is **not** stored in config. It lives in the persisted schedule document as `executionEnabled`.

### Effective current config shape

```yaml
power_devices:
  battery:
    entities:
      remaining_energy: sensor.battery_remaining_energy
      capacity: sensor.battery_soc   # current SoC in current code
      min_soc: sensor.battery_min_soc
      max_soc: sensor.battery_max_soc
    forecast:
      charge_efficiency: 0.95
      discharge_efficiency: 0.95
      max_charge_power_w: 5000
      max_discharge_power_w: 5000

scheduler:
  control:
    mode_entity_id: input_select.rezim_fv
    action_option_map:
      normal: Standardni
      charge_to_target_soc: Nucene nabijeni
      discharge_to_target_soc: Nucene vybijeni
      stop_charging: Zakaz nabijeni
      stop_discharging: Zakaz vybijeni
```

### Important config-model note

There is currently no central validated schema for Helman config. The saved config is a free-form dict written by `helman/save_config`, and individual readers extract what they need.

That is acceptable for this feature, but it means any added config should be minimized and documented carefully.

---

## Main technical constraints

### 1. Schedule slots are `30` minutes, battery forecast is canonical `15` minutes

- scheduler: `SCHEDULE_SLOT_MINUTES = 30`
- battery forecast: canonical `15`-minute model

This means schedule actions cannot be consumed directly by the battery forecast. They need a translation layer.

### 2. Schedule horizon is `48h`, forecast horizon can be up to `14` days

The adjusted simulation needs a rule for the time after the rolling schedule horizon.

Recommended rule:

- within `48h`: use schedule-aware simulation
- after `48h`: fall back to `normal` behavior

### 3. Current battery forecast is passive, not control-aware

Current `_simulate_slot()` only models passive charging/discharging driven by:

- solar surplus
- house deficit
- efficiency
- power limits
- SoC bounds

Forced grid charging and forced discharge/export are not modeled today.

### 4. Schedule semantics are split between requested action and effective runtime action

The scheduler intentionally keeps the stored action stable and computes the effective current behavior dynamically.

That is good, but the forecast must reuse the same semantics instead of inventing a second interpretation.

### 5. Current battery cache ignores schedule state

Current battery forecast cache is keyed by:

- TTL
- current `15`-minute slot
- house snapshot signature
- solar signature
- approximate live battery compatibility

It does **not** depend on:

- schedule contents
- `executionEnabled`
- current effective action

That becomes incorrect once the schedule affects the forecast.

### 6. Target crossings can happen inside a `15`-minute segment

Matching scheduler semantics correctly requires more than a simple one-action-per-slot rule.

Example:

- a `charge_to_target_soc(80)` segment may reach `80%` after `6` minutes
- the remaining `9` minutes of that segment should behave as `stop_discharging`

If this is ignored, the adjusted forecast will overshoot or misrepresent the actual behavior.

---

## Internal slot-alignment assessment

The relevant question is whether the **internal canonical battery forecast slot size** should be changed from `15` minutes to `30` minutes so it matches the scheduler.

Decision after review: keep the internal canonical battery forecast slot size at **`15` minutes**.

Short answer:

- **yes**, that would remove one layer of complexity
- **no**, it would not remove the hardest part of the feature
- overall, it is still **not the best trade-off** for this implementation

### What becomes simpler if internal battery simulation moves to `30` minutes

If battery forecast itself becomes canonical `30` minutes:

- one scheduler slot maps directly to one battery forecast slot
- no `30m -> 15m` overlay expansion is needed for the battery layer
- battery aggregation logic becomes simpler because the simulation grid already matches the scheduler grid
- some cache/debug reasoning becomes easier because schedule and battery operate on the same slot index

This is a **real** simplification.

### What does not become simple enough

Even with internal `30`-minute battery slots, the hardest behavior remains:

- forecast still starts from **now**, so the first slot is still fractional until the next boundary
- `charge_to_target_soc` and `discharge_to_target_soc` can still hit their target **inside** a `30`-minute slot
- once the target is hit, the rest of that same slot still needs to behave like the paired `stop_*` action

So to stay faithful to the scheduler semantics, the simulator would still need an internal two-phase calculation:

1. forced phase until target is reached
2. paired `stop_*` phase for the remaining part of the slot

That means internal `30`-minute alignment removes the **slot-mapping** complexity, but not the **mid-slot transition** complexity.

### What becomes worse or less elegant

There are also costs:

- solar and house forecast are already canonical `15` minutes, so battery would become the odd one out
- battery simulation would have to aggregate `15`-minute solar/house inputs into `30`-minute battery inputs before simulation
- if a target is reached inside a `30`-minute slot, the simulator would have to assume how solar and house energy are distributed inside that slot
- using a `30`-minute canonical battery model loses some fidelity compared with the current `15`-minute battery model, especially around the current partial slot and fast-changing solar periods

So the complexity does not disappear; some of it just moves from **slot overlay logic** into **coarser intra-slot assumptions**.

### Difficulty estimate

Changing internal battery canonical granularity from `15` minutes to `30` minutes is **medium difficulty**.

Reason:

- it is not just a constant change
- it affects simulation assumptions, aggregation behavior, tests, cache behavior, and alignment with the rest of the forecast stack

### Recommendation

For this feature, keep the **internal battery simulation canonical at `15` minutes**.

Why:

- the current solar and house inputs are already canonical `15` minutes
- it preserves better fidelity around partial current-slot behavior
- it keeps battery aligned with the rest of the forecast pipeline
- it still allows correct handling of target-reached-in-slot behavior with fewer coarse assumptions

So:

- internal `30`-minute alignment would help **somewhat**
- but it would **not** reduce complexity enough to outweigh the loss of precision and the extra asymmetry it introduces into the forecast stack

If the main goal is to simplify the system structurally, a stronger simplification would be to align the **scheduler downward** to the forecast grid, not the battery forecast upward to the scheduler grid. That said, changing the scheduler slot size is a separate product/UX decision and is outside this feature's current scope.

---

## Design options

### Option A - minimal patch

Inject the schedule directly into `BatteryCapacityForecastBuilder` and add `if/else` branches inside the existing simulation loop.

How it would work:

- coordinator loads pruned schedule document
- schedule is expanded from `30` minutes to `15` minutes
- builder receives an optional per-slot action map
- `_simulate_slot()` is extended to handle manual actions

Pros:

- smallest diff
- fastest path to a working feature
- maximum reuse of existing builder structure

Cons:

- mixes schedule translation, target resolution, and battery physics into one module
- harder to test cleanly
- higher risk of duplicating scheduler semantics instead of sharing them
- future planning/automation work would likely need a refactor

### Option B - clean architecture

Create a dedicated schedule-to-forecast layer and keep battery simulation policy-aware but not scheduler-aware.

How it would work:

- new scheduling helper builds canonical forecast overlay actions
- shared action resolver is used by both executor and forecast
- battery forecast engine consumes generic effective battery actions
- baseline and adjusted scenarios are modeled as separate scenario products internally

Pros:

- clearest separation of concerns
- easiest to reuse for future accepted-plan simulation
- best long-term testability
- avoids divergent semantics between runtime execution and forecast simulation

Cons:

- more moving parts
- larger upfront change
- probably too much abstraction for the first integration slice

### Option C - pragmatic balance **(accepted direction)**

Introduce one dedicated forecast-overlay helper under `scheduling/`, keep the current battery builder as the simulation owner, and extend the simulation with action-aware behavior plus baseline comparison fields.

How it would work:

- coordinator builds a canonical schedule overlay only when `executionEnabled` is true
- battery builder computes:
  - baseline scenario
  - adjusted scenario
- adjusted scenario becomes the primary response when schedule execution is enabled
- baseline SoC / remaining-energy values are attached as comparison fields per slot

Pros:

- small enough for this repo
- keeps the main simulation in one place
- avoids jamming schedule math directly into the coordinator
- preserves a clean path toward future plan-adjusted scenarios

Cons:

- still some coupling between scheduler semantics and battery simulation
- response aggregation needs careful extension

---

## Recommended architecture

### Recommendation summary

**Option C is the accepted direction.**

Rationale:

- it is small enough to be realistic here
- it keeps current forecasting flow intact
- it respects the scheduler's existing semantics
- it leaves room for future "accepted plan" simulation without forcing a large redesign now

### 1. Keep baseline simulation immutable internally

Internally, keep the current simulation as the **baseline** path.

Then:

- if scheduler execution is disabled, return baseline exactly as today
- if scheduler execution is enabled, compute an adjusted scenario and expose it as the primary `battery_capacity` output
- attach baseline comparison values to adjusted series entries

This preserves the codebase's existing "baseline stays immutable" direction while still matching the requested UI behavior.

### 2. Add a canonical schedule overlay for forecasting

Recommended new helper module:

- `custom_components/helman/scheduling/forecast_overlay.py`

Responsibilities:

- load and prune schedule document
- ignore schedule entirely when `executionEnabled` is false
- materialize the next `48h` schedule horizon
- translate schedule slots from the configured scheduler granularity into canonical `15`-minute action windows
- when `SCHEDULE_SLOT_MINUTES == 15`, behave as direct canonical slot lookup with no extra translation-specific code path
- expose a lookup for "scheduled action covering canonical segment X"

Recommended rule after `48h`:

- no explicit action
- behave as `normal`

### 3. Share target-action resolution semantics with scheduler execution

The forecast should not invent new target logic. It should reuse the same rule family that the executor uses today:

- `charge_to_target_soc` -> `stop_discharging` once target is reached
- `discharge_to_target_soc` -> `stop_charging` once target is reached

Recommended change:

- extract action-resolution logic into a shared helper usable by both:
  - `schedule_executor.py`
  - schedule-aware battery forecast

The forecast version must resolve actions against **simulated** SoC, not live current SoC.

### 4. Make the battery simulation action-aware

Extend simulation so each canonical segment can be evaluated under an effective action.

Recommended effective-action behavior:

| Effective action | Simulation behavior |
| --- | --- |
| `normal` | Keep current passive behavior. |
| `stop_charging` | Do not allow battery charging. Solar surplus exports instead. Battery may still discharge normally to cover deficit. |
| `stop_discharging` | Do not allow battery discharge. House deficit imports from grid instead. Battery may still charge normally from solar surplus. |
| `charge_to_target_soc` | Force charging toward target at up to `max_charge_power_w`. Use solar surplus first; import the remainder from grid. Once target is reached, switch to `stop_discharging` for the remainder of the segment. |
| `discharge_to_target_soc` | Force discharge toward target at up to `max_discharge_power_w`. House load consumes part of the output; remainder exports to grid. Once target is reached, switch to `stop_charging` for the remainder of the segment. |

### 5. Handle mid-segment target crossing explicitly

This is the most important modeling detail.

Recommended approach:

- while simulating a canonical segment, calculate whether the target can be reached before the segment ends
- if not, simulate the whole segment with the forced action
- if yes, split the segment into two phases:
  - phase A: forced action until target time
  - phase B: paired `stop_*` action for the remainder

That keeps forecast behavior aligned with current scheduler semantics.

### 6. Treat the current forecast slot carefully

Current battery forecast starts from **now**, not from the next boundary. The first segment may therefore be fractional.

Recommended handling:

- keep current "first slot can be fractional" behavior
- resolve schedule overlay against canonical `15`-minute segments
- when the forecast starts in the middle of a canonical segment, simulate only the remaining fraction of that segment under the effective action

### 7. Update coordinator and cache behavior

`coordinator.py` should:

- load / prune schedule document before building adjusted forecast
- pass schedule overlay only when `executionEnabled` is true
- invalidate adjusted battery cache on:
  - `set_schedule()`
  - `set_schedule_execution()`
  - config changes affecting schedule control or battery settings
- include a schedule signature in battery-cache compatibility checks

Recommended cache additions:

- `executionEnabled`
- hash/signature of pruned schedule document
- stricter current-slot compatibility when a target action is active

Important nuance:

The current cache tolerance can miss the exact moment when an active target action should switch from forced mode to `stop_*`. Once schedule-aware behavior exists, cache validity should also depend on whether the **effective action** would still be the same.

---

## API and response recommendation

### Response strategy

Keep one `battery_capacity` response section.

When scheduler execution is disabled:

- response shape stays backward-compatible
- current values remain baseline values

When scheduler execution is enabled:

- primary series values become **schedule-adjusted**
- add baseline comparison fields to each series entry

Recommended top-level fields:

- `scheduleAdjusted: bool`
- `scheduleAdjustmentCoverageUntil: str | null`

Recommended per-series fields:

- `baselineRemainingEnergyKwh`
- `baselineSocPct`

Recommended example:

```json
{
  "battery_capacity": {
    "scheduleAdjusted": true,
    "scheduleAdjustmentCoverageUntil": "2026-03-30T20:00:00+01:00",
    "series": [
      {
        "timestamp": "2026-03-27T21:15:00+01:00",
        "socPct": 74.1,
        "remainingEnergyKwh": 7.41,
        "baselineSocPct": 68.3,
        "baselineRemainingEnergyKwh": 6.83
      }
    ]
  }
}
```

### Why not embed full schedule action metadata into `battery_capacity.series`

Not recommended for v1.

Reason:

- `battery_capacity` is aggregated to `15 / 30 / 60`
- schedule actions are slot-native and most precise at `30` minutes
- full per-bucket action metadata becomes awkward after aggregation
- `helman/get_schedule` already exposes the schedule timeline and current runtime metadata cleanly

If action/debug metadata is later needed inside `battery_capacity`, it should be added carefully and with explicit aggregation rules.

---

## Concrete file impact

### Existing files likely to change

- `custom_components/helman/coordinator.py`
  - pass schedule overlay into adjusted battery forecast
  - extend battery cache signature / invalidation
- `custom_components/helman/battery_capacity_forecast_builder.py`
  - compute baseline and adjusted paths
  - add action-aware simulation
  - attach baseline comparison fields
- `custom_components/helman/battery_forecast_response.py`
  - preserve new top-level metadata
  - aggregate new baseline fields
- `custom_components/helman/forecast_aggregation.py`
  - extend battery aggregation rules for baseline comparison fields
- `custom_components/helman/scheduling/schedule_executor.py`
  - ideally consume shared effective-action resolution helper

### Recommended new file

- `custom_components/helman/scheduling/forecast_overlay.py`
  - pruned schedule materialization for forecast use
  - granularity-aware schedule-to-forecast translation derived from `SCHEDULE_SLOT_MINUTES`
  - shared target-action resolution helpers

---

## Config assessment and gaps

### No new config strictly required for v1

Assuming the user's confirmed semantics are correct for the installation:

- existing battery forecast power limits are also the forced-mode limits
- existing efficiencies are valid for forced modes
- current scheduler action mapping already represents the inverter behavior well enough

then this feature can be built **without adding mandatory config**.

### Recommended clarifications or future improvements

### 1. Document that `power_devices.battery.entities.capacity` means current SoC

This is currently misleading and easy to misconfigure.

### 2. Consider explicit usable battery capacity in future

Current code derives nominal capacity from:

- current remaining energy
- current SoC

That is acceptable for now but less robust than an explicit capacity value.

### 3. Consider import/export/inverter throughput caps in future

Not required for the requested manual-schedule integration, but important if real hardware limits differ from battery charge/discharge limits.

Examples:

- max grid import power
- max grid export power
- shared inverter AC limit
- different forced-mode caps than passive battery limits

### 4. Current scheduler control model supports one mode entity only

`docs/features/modes.md` suggests some inverter setups may need multiple HA entities to represent Helman modes.

This is not necessarily a blocker for this feature if current schedule execution already works in the real installation, but it is a structural limitation worth documenting.

### 5. There is no central config schema

This is not a blocker, but it increases the importance of:

- keeping new config minimal
- documenting exact paths
- validating assumptions in tests

---

## Testing strategy for the eventual implementation

Recommended new or expanded tests:

### Battery forecast unit tests

- `stop_charging` blocks charging but still allows normal discharge
- `stop_discharging` blocks discharge but still allows normal charge
- `charge_to_target_soc` imports from grid when solar is insufficient
- `discharge_to_target_soc` exports to grid when house load is lower than forced output
- target reached mid-segment switches to paired `stop_*`
- adjusted forecast falls back to `normal` beyond `48h`
- scheduler disabled returns unchanged baseline behavior

### Aggregation tests

- `baselineSocPct` is aggregated by taking the last sub-slot value
- `baselineRemainingEnergyKwh` is aggregated by taking the last sub-slot value
- `scheduleAdjusted` and `scheduleAdjustmentCoverageUntil` propagate correctly

### Coordinator/cache tests

- schedule change invalidates battery forecast cache
- schedule execution toggle invalidates battery forecast cache
- active target crossing invalidates cache when effective action changes

### Runtime validation

- compare `helman/get_schedule` and `helman/get_forecast` before and after enabling schedule execution
- confirm adjusted forecast matches force-charge / force-discharge windows
- confirm adjusted forecast reverts to baseline after schedule horizon ends

---

## Final recommendation

Build this as a **schedule overlay on top of the existing battery forecast**, not as a rewrite of the forecast subsystem.

Recommended implementation direction:

1. add a canonical forecast overlay for manual schedule actions
2. reuse shared target-action semantics from the scheduler
3. keep baseline simulation internally
4. expose adjusted values as primary values only when schedule execution is enabled
5. include baseline SoC / remaining-energy comparison values per slot
6. update cache invalidation to include schedule state and effective-action changes

This satisfies the requested behavior while staying aligned with the current codebase and its longer-term direction toward baseline-plus-adjusted scenarios.
