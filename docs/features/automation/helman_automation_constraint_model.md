# Helman Automation - Constraint and Objective Model

## Purpose

This document defines the high-level decision model for the agreed automation direction:

- rolling `48h` planning horizon
- battery-first execution in v1
- EV and appliance guidance as recommendations only in v1
- support for both plan-wide auto-accept and per-action user control

The goal is to make the planner **predictable, explainable, and override-friendly**.

## Design principles

### 1. Baseline forecast stays immutable

Helman should keep the existing forecast products as the baseline view:

- solar forecast
- grid price forecast
- house consumption forecast
- battery baseline simulation

Accepted actions and temporary directives should not rewrite that baseline. Instead, they should produce a separate **plan-adjusted scenario**.

### 2. Constraints come before optimization

The planner should first satisfy safety and user-defined constraints, then optimize within the remaining freedom.

That keeps the system understandable:

- first protect reserve
- then satisfy explicit SoC goals
- then choose the best timing for charging, export, or normal mode

### 3. Named profiles are better than free-form weights in v1

For the first version, Helman should use a small set of named objective profiles rather than an open-ended weighting system.

That makes the system easier to reason about and easier to explain in the UI.

### 4. Temporary directives are first-class

Short-lived decisions like:

- "charge to 80% tonight"
- "do not discharge to grid today"
- "keep 50% reserve tomorrow"

should be modeled explicitly, not hidden inside general configuration.

### 5. Accepted and manual actions should stay stable across replans

The planner may change fresh proposals as forecasts move, but it should not silently rewrite actions that the user has already accepted or explicitly overridden.

## Planning stack

The planning model should be layered like this:

1. **Forecast inputs**
   - solar
   - import price
   - export price
   - baseline house consumption
   - battery live state
2. **Objective profile**
   - what Helman should optimize for by default
3. **Default constraints**
   - longer-lived system preferences
4. **Temporary directives**
   - day-specific or time-boxed user instructions
5. **Accepted or manual actions**
   - committed plan items that must be preserved
6. **Execution safety filters**
   - stale data, missing entities, disabled automation
7. **Plan-adjusted scenario**
   - the effective future after all accepted decisions are applied

## Recommended v1 objective profiles

These should be configurable as the default system profile and also overridable for a day or time window.

### `balanced`

Recommended default.

Intent:

- balance lower cost, good self-consumption, and healthy reserve
- avoid extreme import/export behavior unless clearly beneficial

### `cost_saver`

Intent:

- minimize expected energy cost
- use cheap import windows when allowed
- prefer export or discharge when economically favorable and reserve remains safe

### `self_consumption`

Intent:

- maximize local use of solar energy
- avoid exporting unless necessary or explicitly preferred
- avoid grid charging unless needed to satisfy a stronger constraint

### `backup_first`

Intent:

- prioritize battery availability and outage resilience
- keep higher reserve
- avoid discharge-to-grid unless explicitly instructed

## Recommended v1 constraint categories

### A. Physical and safety constraints

These come from device reality and always win:

- battery min SoC
- battery max SoC
- max charge power
- max discharge power
- inverter capability limits
- action execution only when required entities are available

### B. Default planning constraints

These are persistent user preferences that shape normal planning behavior.

Recommended v1 fields:

- default objective profile
- default reserve floor SoC
- default morning target SoC
- default morning target deadline
- whether grid charging is allowed
- maximum grid-charge target SoC
- allowed grid-charge time window
- whether discharge to grid is allowed
- export preference threshold or minimum profitable export condition
- whether whole-plan auto-accept is enabled by default

### C. Temporary directives

These are time-boxed instructions that override the defaults.

Recommended examples:

- set reserve floor to `50%` until tomorrow evening
- charge to `80%` tonight before `06:00`
- disable discharge to grid today
- switch profile to `backup_first` for the weekend
- force review-only mode for the next 24 hours

### D. Accepted or manual actions

These are concrete plan items derived either from the planner or directly from the user.

Examples:

- charge from grid to `80%` between `01:00` and `05:00`
- block battery charging from solar between `10:00` and `12:00`
- return to normal mode at `12:00`

## Recommended v1 battery-first action families

These are the action families I would treat as first-class in v1.

### `charge_from_grid_to_target_soc`

Use when:

- cheap import is available
- tomorrow solar is likely insufficient
- reserve or morning target would otherwise be missed

Parameters:

- target SoC
- eligible window
- optional deadline

### `protect_reserve_window`

Use when:

- Helman should avoid discharging below a chosen reserve during a given window

Parameters:

- reserve floor SoC
- active window

### `export_priority_window`

Use when:

- export is allowed
- export price is attractive enough
- reserve and later SoC needs remain satisfied

Parameters:

- active window
- optional minimum remaining SoC after window

### `block_discharge_window`

Use when:

- the battery should not be used for the house or grid in a certain period
- reserve needs to be protected until a later event

Parameters:

- active window

### `normal_mode_window`

Use when:

- the planner wants the inverter back in normal behavior after a temporary forced mode

Parameters:

- start time
- end time or implied end by next action

## What should stay recommendation-only in v1

These can still appear in the plan, but should not execute automatically yet:

- EV charging timing
- washing machine start timing
- dishwasher start timing

The planner can still say things like:

- "enough surplus solar is likely between 11:00 and 15:00 for EV charging"
- "night import is cheap enough for the dishwasher after battery needs are covered"

## Precedence model

The planner should use explicit precedence so behavior is predictable.

### Recommended precedence order

1. **Physical and safety constraints**
2. **Global automation state**
   - paused, review-only, or execution enabled
3. **Temporary user directives**
4. **Manual user-created actions**
5. **User-accepted planned actions**
6. **Auto-accepted whole-plan actions**
7. **Default profile and persistent constraints**
8. **Advisory-only recommendations**

This means:

- a temporary "do not discharge to grid today" directive beats an auto-accepted export action
- a manual "charge to 80% tonight" action beats the currently active optimization profile
- a paused automation state prevents execution even if actions were previously accepted

## Auto-accept semantics

Whole-plan auto-accept should exist, but it should still behave conservatively.

### Recommended behavior

- the planner may mark eligible actions as auto-accepted when auto-accept is enabled
- auto-accepted actions should carry a distinct origin, for example `accepted_auto`
- explicit user actions should always outrank auto-accepted actions
- auto-accept should respect all active temporary directives before accepting anything

### Good v1 rule

Only auto-accept action families that are:

- battery-related
- explainable
- reversible
- safe to restore back to normal mode

## Explainability requirements

Every proposed or accepted action should include a short human-readable reason.

Example:

> Charge from grid to 80% between 02:00 and 04:30 because import price is low, tomorrow solar forecast is weak, and the configured morning reserve target would otherwise be missed.

Good explanations should reference:

- the active profile
- the relevant constraint
- the key forecast signal
- the expected outcome

## Recommended split: default config vs temporary override

### Default config

Use this for long-lived behavior:

- default profile
- default reserve floor
- normal morning target SoC and deadline
- whether grid charging is generally allowed
- whether discharge to grid is generally allowed
- default auto-accept policy

### Temporary override

Use this for exceptional days or short periods:

- "tomorrow backup first"
- "tonight charge to 80%"
- "today never discharge to grid"
- "disable auto-accept until tomorrow morning"

## Recommended v1 high-level config shape

This is not a final schema, just a high-level direction.

```yaml
automation:
  enabled: true
  planning_horizon_hours: 48
  approval_mode: support_both
  auto_accept_whole_plan: false
  objective:
    default_profile: balanced
  battery:
    reserve_floor_soc: 30
    morning_target_soc: 50
    morning_target_deadline: "07:00"
    grid_charge:
      allowed: true
      max_target_soc: 80
      allowed_window:
        start: "00:00"
        end: "06:00"
    export:
      discharge_to_grid_allowed: false
      minimum_export_advantage: null
```

A temporary override might look conceptually like:

```yaml
automation_overrides:
  - start: "2026-03-21T00:00:00+01:00"
    end: "2026-03-21T23:59:00+01:00"
    profile: backup_first
    reserve_floor_soc: 50
    discharge_to_grid_allowed: false
```

## Decision flow

At a high level, the planner should work like this:

1. Build or load baseline forecast inputs.
2. Read the active objective profile.
3. Apply default constraints.
4. Apply active temporary directives.
5. Apply accepted or manual actions.
6. Simulate the effective scenario.
7. Detect unmet goals or opportunities.
8. Generate new proposals only where freedom remains.
9. If auto-accept is enabled, auto-accept only eligible battery-safe actions.

## Example plan behavior

### Scenario 1 - cloudy winter day

Inputs:

- weak solar forecast tomorrow
- cheap import at night
- reserve floor `30%`
- morning target `60%` by `07:00`

Likely plan:

- charge from grid overnight to meet the morning target
- avoid unnecessary discharge before sunrise
- recommend no large flexible loads overnight if they would jeopardize battery target

### Scenario 2 - strong solar day with valuable export

Inputs:

- strong solar forecast
- export price unusually high around midday
- discharge to grid allowed
- reserve and evening needs still safe

Likely plan:

- preserve enough SoC for the morning and evening
- allow export-priority during the valuable midday window
- return to normal mode after the export window ends

### Scenario 3 - backup-first day override

Inputs:

- temporary profile override `backup_first`
- reserve floor raised to `50%`
- whole-plan auto-accept enabled

Likely plan:

- auto-accept only actions that improve reserve safely
- suppress aggressive export behavior
- prefer grid charging if needed to hit the raised reserve

## Data gaps and graceful degradation

The planner should degrade honestly when important inputs are missing.

### If import price is missing

- do not propose cost-based grid charging
- continue with reserve and self-consumption logic if possible

### If export price is missing

- do not propose discharge-to-grid or export-priority actions based on price

### If solar forecast is partial

- mark the future scenario as partial
- avoid overcommitting to actions that depend on unknown solar production

## Recommended next step after this document

The next useful design step would be to define the **v1 constraint fields and action DTOs** more concretely:

- exact override fields
- exact action statuses
- plan payload shape
- how auto-accepted vs manually accepted actions are represented
