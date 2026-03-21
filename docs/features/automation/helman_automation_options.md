# Helman Automation - High-Level Direction Options

## Why this document exists

`helman_automation.md` captures the problem well: you want Helman to stop being only a forecast viewer and start acting like an energy planner for the next day or two.

This document keeps things high level and turns that raw idea into concrete directions we can compare before deciding what to build.

## Current codebase fit

The repo already has a strong base for planning, but not yet for control:

- the backend already owns forecast generation
- house consumption forecast is persisted and refreshed hourly
- battery capacity forecast is already a simulation built on forecast inputs
- `docs/features/modes.md` already defines a Helman-level battery mode vocabulary

The main gaps are:

- no durable plan model
- no accepted-vs-proposed action model
- no override model
- no execution engine
- no import-price path in the current grid forecast
- no control contract yet for deferrable consumers or EV charging

That suggests the next feature should be framed as a **planning and execution layer on top of the existing forecast layer**.

## Shared concept across all options

No matter which direction we choose, the shape should probably be:

1. Build a rolling plan for the next `24-48` hours.
2. Rebuild that plan on a schedule, for example hourly, and also after important changes.
3. Represent actions explicitly, for example:
   - charge battery from grid to `80%`
   - avoid charging battery from solar until `11:00`
   - keep at least `30%` reserve overnight
   - start EV charging in a selected window
4. Separate these states clearly:
   - forecast inputs
   - proposed actions
   - accepted plan
   - executed or skipped actions
5. Keep the baseline forecast immutable and build a separate plan-adjusted scenario on top of it.
6. Re-run simulation against the **accepted** plan, not only against the raw forecast.
7. Treat user overrides as first-class inputs with clear precedence and expiry.
8. Execute actions through Home Assistant service or script adapters, not by hardcoding vendor logic directly into the planner.

## Option A - Advisory planner only

### Overview

Helman creates a rolling `24-48h` plan with proposed actions and an updated simulation, but it does **not** execute anything yet. The user remains the operator.

### How it works

- Forecast inputs are combined into a proposed plan.
- The plan contains recommended actions, timing, and rationale.
- The simulation is recalculated using the user-accepted draft plan.
- The result is a high-quality decision-support tool, not an automation engine yet.

### Why this fits the codebase

This is the smallest change from the current forecast-first architecture. It reuses the existing backend builder pattern and avoids introducing actuation too early.

### Pros

- safest starting point
- fast to validate in Home Assistant
- helps refine the action model before adding control
- avoids early mistakes around inverter commands or appliance triggers

### Cons

- does not yet deliver the "system executes the plan" part
- still leaves final execution manual
- may feel like a half-step if your main goal is automation

### Best use

Choose this if you want to nail the planning UX and action language first, then add execution later with low risk.

## Option B - Approved plan with selective execution

### Overview

Helman creates a rolling plan, lets you approve or override actions, then automatically executes only the accepted actions. This is the most balanced option.

### How it works

- The planner builds a proposed `24-48h` action plan.
- You can:
  - accept the whole plan
  - accept or reject individual actions
  - replace an action with your own override
- The accepted plan is persisted.
- The simulation is rebuilt from the accepted plan, so the forecast reflects committed actions.
- Accepted and manual actions stay stable across replans, while unaccepted proposals are free to change.
- A small executor applies due actions at runtime.

### Good v1 scope

Keep the first executable scope narrow:

- battery-related actions only
- explicit import/export price handling
- reserve SoC handling
- user override and expiry
- execution audit or last-action status

Deferrable consumers and EV charging can still appear as proposals in v1, but real execution can wait until each device has a clean trigger contract.

### Pros

- matches your described mental model best
- delivers real value without going fully autonomous
- keeps the human in control
- fits the repo's current backend-owned planning style
- gives a clean path to add more device types later

### Cons

- needs new persistence for plan and overrides
- needs a new execution layer
- import-price support becomes a hard requirement
- still requires careful scoping to stay safe

### Best use

Choose this if you want Helman to become practically useful soon, but still understandable and override-friendly.

## Option C - Policy-driven autonomous orchestrator

### Overview

Helman becomes a more general optimization engine with configurable policies, automatic action acceptance, and multi-device orchestration.

### How it works

- Forecasts feed a scoring or rule engine.
- The engine continuously chooses actions based on policy:
  - minimize import cost
  - maximize export revenue
  - protect outage reserve
  - prefer solar self-consumption
  - honor device windows and constraints
- The system auto-accepts most actions unless the user pauses or overrides it.

### What it enables

- battery arbitrage
- EV charging strategies
- deferrable consumer scheduling
- richer conflict resolution across devices
- more advanced optimization later

### Pros

- clean long-term architecture
- strong support for future devices and strategies
- easiest model to extend once built

### Cons

- too large for the next day or two
- harder to explain and validate
- higher safety risk if execution goes wrong
- likely overkill before the plan and override model are proven

### Best use

Choose this if you want to invest in a more ambitious control platform rather than a focused first automation feature.

## Recommendation

I recommend **Option B: Approved plan with selective execution**.

It matches your idea most closely:

- there is a plan for the next day or two
- Helman proposes actions
- you can override any action
- accepted actions feed back into the simulation
- the system then executes what was accepted

It is also the best balance for this repo:

- it reuses the existing forecast and simulation patterns
- it does not require full autonomy on day one
- it keeps the execution boundary narrow and safer
- it allows battery automation first, then EV and appliances later

## Current working direction after discussion

The current preferred direction is now:

- start from **Option B**
- keep **battery-only execution** in v1
- keep **EV and appliance guidance as recommendations only** in v1
- support **both** approval styles:
  - approve the whole plan
  - approve or override individual actions
- allow the user to **auto-accept the whole plan** when desired
- use a rolling **48h** horizon

That keeps the first version useful and close to your original idea without trying to automate every device immediately.

## A concrete v1 slice I would suggest

If we choose Option B, I would keep the first slice intentionally narrow:

- rolling `48h` plan
- replan hourly and on relevant state changes
- battery-first actions only
- import and export price inputs
- user can accept, reject, or override actions
- accepted actions are persisted
- show both the baseline view and the plan-adjusted view
- battery simulation uses accepted actions as input
- executor handles only battery-mode actions in v1

Example v1 actions:

- charge from grid to target SoC before morning peak
- keep a minimum reserve SoC overnight
- prefer export over battery charging during selected windows
- block discharging during selected windows
- return to normal mode after a plan window ends

For v1, I would keep these out of execution scope:

- dishwasher and washing machine control
- EV charging optimization across multiple strategies
- fully automatic conflict resolution across many flexible devices

Those can still appear as future actions or proposal-only items in the plan.

## Constraint model worth defining next

You also highlighted an important next step: the planner should not be driven only by forecasts and prices. It also needs an explicit **constraint model**.

Examples of constraints that should likely exist:

- desired battery SoC by a given time
- minimum backup reserve SoC
- whether battery discharge to grid is allowed at all
- when export is valuable enough to prefer export over storage
- when grid charging is allowed
- whether a given day should favor cost, self-consumption, reserve, or another goal

I would treat these as two layers:

### Default configuration

Longer-lived preferences that shape normal behavior:

- default optimization goal
- normal reserve floor
- default morning target SoC
- rules for export-priority vs battery charging
- whether grid charging is allowed

### Per-day or temporary override

Short-lived instructions that can change the plan for a specific day or window:

- "tomorrow keep at least 50% reserve"
- "tonight charge to 80%"
- "do not discharge to grid today"
- "this weekend favor self-consumption over export"

That would make the planner much more practical than using one fixed optimization strategy forever.

## Remaining design topics

The main open topic is no longer the broad direction. It is the shape of the **constraint and objective model**:

1. Which battery constraints should be first-class in v1?
2. Which of them belong in default config vs day-specific override?
3. How should auto-accept behave when a plan conflicts with a temporary user preference?
4. How should the UI explain why a plan chose export, storage, or grid charging?

## Suggested documentation path after direction is chosen

If we move forward, I would likely keep:

- `helman_automation.md` as the original idea note
- `helman_automation_options.md` as the decision document
- `helman_automation_constraint_model.md` as the decision-rules document

And once we choose a direction, add a more standard feature-doc set:

- `docs/features/automation/README.md`
- `docs/features/automation/implementation_strategy.md`
- `docs/features/automation/implementation_progress.md`
