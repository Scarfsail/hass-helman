# Helman Scheduling Card — UI/UX Proposal

**Scope:** first proposal for a dedicated scheduling card backed by the new manual scheduling API

**Goal:** design a separate card that is clean at first glance, clearly shows where actions change, and still makes it easy to inspect or edit one or more explicitly selected slots inside an expanded interval.

---

## 1. Design goals

The first iteration should optimize for four things:

1. **Clean first glance**
   - the user should immediately see the important action changes
   - the card should not dump all `192` raw slots on screen by default

2. **Correct mental model**
   - the backend is slot-native, so the UI must not pretend intervals are the real source of truth
   - scheduled action and current runtime must stay visually distinct

3. **Easy editing**
   - expanding an interval should reveal the raw slots when needed
   - editing should work by selecting the exact slots to change inside an expanded interval
   - the primary edit flow should use a dialog, not a spreadsheet-like inline editor

4. **Room to grow**
   - this card will expand later
   - the architecture should leave room for forecast data, richer annotations, and more advanced editing without forcing a redesign

---

## 2. Backend constraints that shape the UI

The current backend contract gives us a few hard rules:

- the horizon is always the next `48` hours
- the resolution is always `15` minutes
- the card receives a full materialized grid of `192` slots
- writes stay slot-native via `helman/set_schedule`
- `normal` is implicit in storage, but materialized in reads
- `runtime` exists only for the **current slot**
- `runtime.executedAction` may differ from `action`
- there is a global `executionEnabled` toggle
- there is no subscription API yet, so the card must refresh after writes and at slot boundaries
- there is no backend concept of grouped intervals, block abstractions, or persisted overrides

That means:

- **slots are canonical**
- **intervals are a frontend presentation model**
- the UI must not blur **scheduled state** and **actual runtime**

---

## 3. Chosen direction

### Recommended approach

Use a **clean data architecture** with a **restrained row-based UI**:

- keep the raw slot grid as the canonical frontend state
- derive day sections and collapsible interval rows from that canonical slot grid
- show the current slot in a dedicated **Now** surface instead of letting runtime semantics leak into every interval row
- use expandable interval rows for inspection
- use checkboxes in expanded interval rows and a dialog for exact selected-slot editing

### Why this is the right fit

This matches both the backend and the expected future of the card:

- the backend remains the source of truth at slot level
- the user gets the clean overview they asked for
- the UI can grow later with accessory columns, forecast hints, or richer badges
- future features can be added by extending derived models instead of rewriting the core card

### Trade-off accepted

This approach adds a real modeling layer up front:

- raw slot state
- derived interval state
- derived day sections
- dialog draft state

That is more work than a quick one-file UI, but it is the better fit if this card is only the beginning.

---

## 4. Mental model and terminology

To keep the UI honest, the proposal uses these terms:

- **slot** = one canonical `15` minute backend unit
- **interval** = a contiguous visual grouping of slots with the same scheduled action
- **edited selection** = a user-applied change to one or more explicitly selected slots inside one expanded interval
- **runtime divergence** = when the current slot is scheduled for one action but the executor applied another one

Important wording choice:

- in the UI, avoid using **override** as a general storage concept
- use **edited selection** or **selected slots** for schedule changes
- use **runtime divergence** for the current-slot execution mismatch

That keeps the wording aligned with the backend we actually have today.

---

## 5. Information architecture

The card should have four visible layers.

### 5.1 Header

The header is the global control area.

It should contain:

- card title
- execution status
- execution on/off toggle
- lightweight refresh state
- optional manual refresh action

Suggested content:

- `Execution enabled`
- `Execution disabled`
- `Refreshing…`
- `Updated 20:15`

The execution toggle belongs here because it is global state, not per-interval state.

### 5.2 Now strip

This is a dedicated surface for the **current slot only**.

Purpose:

- show what is scheduled right now
- show what is actually being executed right now
- expose runtime error state without polluting the whole interval list

Suggested fields:

- current slot time window
- scheduled action chip
- runtime chip
- reason badge when relevant
- error badge when relevant

Examples:

- `Now 20:15–20:30 · Scheduled: Charge to 70% · Running: Stop discharging`
- `Now 20:15–20:30 · Scheduled: Normal · Runtime error`

### 5.3 Day sections

The main body should be grouped by local day:

- `Today`
- `Tomorrow`
- explicit date labels after that

Intervals must be split at day boundaries for presentation, even if the scheduled action is unchanged across midnight.

This keeps scanning easy and avoids confusing cross-day collapsed rows.

### 5.4 Collapsed interval rows

Collapsed rows are the primary first-glance surface.

Each row should summarize:

- interval time range
- scheduled action
- slot count
- whether the interval contains the current slot
- whether the interval contains edited detail worth expanding
- disclosure affordance

Recommended columns:

- time
- main action / summary
- status badges
- reserved accessory lane
- expand/collapse chevron

The future accessory lane is not used in v1, but it should exist in the row model and layout.

### 5.5 Expanded interval details

Expanding a row reveals slot-level truth.

The expanded detail should contain:

- compact summary of the interval
- actions:
  - interval select-all checkbox
  - `Edit selected`
- a raw slot list for that interval with one checkbox per slot

Each slot row should show:

- selection checkbox
- slot time
- scheduled action
- current marker if applicable
- runtime detail if this is the current slot

The key point is that slot detail exists **inside** the interval, not as the default presentation.

---

## 6. Canonical model vs presentation model

This is the most important architectural rule in the proposal.

### 6.1 Canonical model

The frontend source of truth should stay slot-native.

Example shape:

```ts
type ScheduleSlotState = {
  id: string;
  dayKey: string;
  timeLabel: string;
  action: ScheduleAction;
  isCurrent: boolean;
  runtime: ActiveSlotRuntime | null;
};
```

This model mirrors backend reality and is the only state that should drive writes.

### 6.2 Presentation model

Everything the UI needs for readability is derived from the canonical slots.

Example shape:

```ts
type ScheduleIntervalRow = {
  id: string;
  dayKey: string;
  startSlotId: string;
  endSlotId: string;
  startLabel: string;
  endLabel: string;
  slotIds: string[];
  action: ScheduleAction;
  containsCurrentSlot: boolean;
  accessory: null;
};
```

### 6.3 Interval derivation rules

Rows are derived by grouping adjacent slots when all of the following are true:

- same local day
- same scheduled action kind
- same `targetSoc` when applicable

Rows should **not** be split just because the current slot has runtime metadata.

Instead:

- use the **Now** strip for current execution
- mark an interval with a small `Now` badge if it contains the current slot
- show runtime only inside the current slot row in expanded detail

This keeps the overview clean while still respecting the API.

---

## 7. Primary interaction flows

### 7.1 First glance

1. Card loads schedule
2. Header shows execution state
3. Now strip shows current slot truth
4. Main body shows only interval rows, grouped by day
5. The user immediately sees where actions change

That is the main scanning use case.

### 7.2 Inspect an interval

1. User taps an interval row
2. The row expands inline
3. Raw slots appear underneath
4. If the interval contains the current slot, that row shows runtime details

The card should prefer **single-row expansion** by default to keep the page readable.

### 7.3 Edit selected slots

1. User expands an interval
2. User checks one or more slot checkboxes
3. User can use the interval checkbox to quickly select or unselect the whole interval
4. The `Edit selected` button becomes enabled once at least one slot is selected
5. Dialog opens scoped to the exact checked slots
6. User chooses action and optional target SoC
7. Card writes only the checked slots
8. Card reloads the schedule

### 7.4 Select a whole interval quickly

1. User expands an interval
2. User toggles the interval checkbox in the action row
3. All slot checkboxes in that interval become checked or unchecked together
4. The interval checkbox becomes indeterminate when only some slots are selected
5. `Edit selected` always applies only to the currently checked slots in that interval

This covers both “one slot” and “multiple slots” without turning the UI into a dense grid editor.

### 7.5 Toggle execution

1. User uses the header toggle
2. Card disables the control while the request is pending
3. On success, card reloads the schedule
4. The Now strip updates with the new current runtime surface

If enabling or disabling fails, the card should show the websocket error clearly and keep the previous visible state until the next refresh.

---

## 8. ASCII mockups

### 8.1 Collapsed overview

```text
+----------------------------------------------------------------------------------+
| Helman Scheduling                                               [Refresh] [ ON ] |
| Execution enabled • Updated 20:15                                              |
|----------------------------------------------------------------------------------|
| Now 20:15–20:30                                                                 |
| Scheduled: [Charge to 70%]     Running: [Stop discharging]     Reason: target    |
|----------------------------------------------------------------------------------|
| Today                                                                            |
| 20:30–23:00   [Charge to 70%]                 10 slots   [Now]               >   |
| 23:00–06:00   [Normal]                        28 slots                         >   |
|                                                                                  |
| Tomorrow                                                                         |
| 06:00–08:00   [Stop charging]                 8 slots                          >  |
| 08:00–12:00   [Discharge to 30%]             16 slots                          >  |
+----------------------------------------------------------------------------------+
```

### 8.2 Expanded interval

```text
+----------------------------------------------------------------------------------+
| 20:30–23:00   [Charge to 70%]                 10 slots   [Now]               v   |
|----------------------------------------------------------------------------------|
| [ ] Select whole interval                                      [Edit selected]   |
|                                                                                  |
| [ ] 20:30   [Charge to 70%]                                                      |
| [ ] 20:45   [Charge to 70%]                                                      |
| [x] 21:00   [Charge to 70%]   current • running [Stop discharging]               |
| [x] 21:15   [Charge to 70%]                                                      |
| [ ] 21:30   [Charge to 70%]                                                      |
| ...                                                                              |
+----------------------------------------------------------------------------------+
```

### 8.3 Selected-slot edit dialog

```text
+--------------------------------------------------------------+
| Edit selected slots                                          |
|--------------------------------------------------------------|
| Interval: 20:30–23:00                                        |
| Selection: 2 slots                                           |
|                                                              |
| Action:                                                      |
|   ( ) Normal                                                 |
|   ( ) Charge to target SoC                                   |
|   ( ) Discharge to target SoC                                |
|   ( ) Stop charging                                          |
|   ( ) Stop discharging                                       |
|                                                              |
| Target SoC: [ 70 ] %                                         |
| Affects: 4 slots                                             |
|                                                              |
|                                  [Cancel] [Apply changes]    |
+--------------------------------------------------------------+
```

---

## 9. Display and behavior rules

### 9.1 Action chips

Actions should have compact, readable chips:

- `Normal`
- `Charge to 70%`
- `Discharge to 30%`
- `Stop charging`
- `Stop discharging`

Target actions must render the target in the collapsed row, because that is essential information.

### 9.2 Current slot treatment

The current slot should be visible in two places only:

- the Now strip
- the raw slot row inside expanded interval detail

Collapsed interval rows may show a `Now` badge, but should not try to summarize full runtime semantics inline.

### 9.3 Runtime treatment

Runtime is a separate visual surface from scheduled action.

Recommended pattern:

- scheduled action = filled action chip
- runtime state = secondary chip or text badge
- runtime error = error badge

Examples:

- `Scheduled: Charge to 70%`
- `Running: Stop discharging`
- `Runtime error`

### 9.4 Empty, loading, and stale states

The card should explicitly handle:

- loading
- backend error
- temporary stale data

Suggested behavior:

- show skeleton rows or muted placeholders while loading
- show an inline error surface if `get_schedule` fails
- show `Updated HH:mm` in the header
- refresh automatically after writes and at slot boundaries

### 9.5 Refresh policy

Because there are no subscriptions yet, the first version should:

- load on card connect
- refresh after `set_schedule`
- refresh after `set_schedule_execution`
- refresh on slot boundary
- allow manual refresh

This is enough for v1 without adding aggressive polling.

---

## 10. Future forecast readiness without adding forecast now

Forecast is intentionally out of scope for the first iteration, but the layout should stay ready for it.

### 10.1 Row layout reservation

Design interval rows as a real grid with a reserved accessory area:

```text
time | main action content | badges/status | accessory lane | disclosure
```

In v1:

- the accessory lane is empty or hidden

Later:

- it can show SoC trend hints
- solar or price mini-indicators
- tiny confidence or recommendation badges

### 10.2 Row model reservation

Keep a nullable accessory field in derived row/view models:

```ts
accessory: null | ScheduleAccessorySummary
```

That keeps the future extension additive instead of structural.

### 10.3 Expanded detail reservation

The expanded interval detail should also reserve a small secondary section below the slot list for future contextual information.

Not used in v1, but later it could host:

- forecast strip for the interval
- expected SoC effect
- solar context

### 10.4 What not to do yet

Do **not** add in v1:

- forecast columns with fake or disconnected values
- schedule-aware battery projections
- optimization hints
- planner recommendations

The first iteration should stay honest: manual schedule first, forecast later.

---

## 11. Proposed future file/component layout

The future implementation should live in its own folder:

```text
src/
  helman-scheduling/
    HelmanSchedulingCardConfig.ts
    helman-scheduling-card.ts
    schedule-types.ts
    schedule-owner.ts

    model/
      schedule-normalizer.ts
      schedule-interval-builder.ts
      schedule-patch-builder.ts

    components/
      scheduling-card-header.ts
      scheduling-now-strip.ts
      scheduling-day-section.ts
      scheduling-interval-row.ts
      scheduling-slot-list.ts
      scheduling-action-chip.ts
      scheduling-runtime-chip.ts

    dialogs/
      scheduling-range-edit-dialog.ts

    styles/
      scheduling-shared-styles.ts
```

### Component responsibilities

#### `helman-scheduling-card.ts`

- card entrypoint
- owns high-level UI state
- subscribes to `schedule-owner`
- holds expanded row key
- opens and closes dialog

#### `schedule-owner.ts`

- connection-scoped data owner, similar in spirit to the forecast owner
- fetches schedule
- refreshes on slot boundaries
- exposes loading/error/stale state
- centralizes write + reload behavior

#### `schedule-types.ts`

- schedule-specific DTOs and view-model types
- keep local initially
- extract into shared API files later only if another card needs them

#### `schedule-normalizer.ts`

- converts raw backend payload into frontend slot state
- handles day keys, labels, and current slot markers

#### `schedule-interval-builder.ts`

- derives interval rows from canonical slots
- splits rows at day boundaries
- keeps interval derivation rules centralized

#### `schedule-patch-builder.ts`

- builds slot patch payloads for the exact selected slots
- keeps dialog logic out of render components

#### `scheduling-card-header.ts`

- execution status
- toggle
- refresh status
- manual refresh action

#### `scheduling-now-strip.ts`

- current slot summary
- scheduled vs runtime display
- runtime error messaging

#### `scheduling-day-section.ts`

- day heading
- interval row list for one day

#### `scheduling-interval-row.ts`

- collapsed row summary
- expanded interval container
- interval selection controls and selected-slot edit action

#### `scheduling-slot-list.ts`

- renders raw slot rows inside expanded interval detail
- current-slot highlight
- per-slot edit affordance

#### `scheduling-range-edit-dialog.ts`

- edit action
- edit target SoC when needed
- choose start and end slot within a selected interval

### Integration points outside the folder

Later implementation should also touch:

- `src/app.ts` to register the card in the main bundle
- localization files for labels and action names
- optionally a dedicated Vite config only if a separate JS artifact is needed later

---

## 12. Non-goals for v1

The first version should **not** try to do all of this at once:

- drag-to-paint timeline editing
- non-contiguous bulk selection
- automated planning
- forecast-aware scheduling
- execution history
- websocket subscriptions
- audit trail

That work can come later once the base card is stable.

---

## 13. Alternatives considered

### A. Minimal approach

Pros:

- fastest to build
- easiest to explain

Cons:

- weaker internal layering
- less ready for future growth

Why not chosen:

- this card is expected to grow, so the extra model separation is worth it

### B. Pragmatic balanced approach

Pros:

- very good UX shape
- easy to make visually native to the repo

Cons:

- can drift toward ad-hoc modeling if the data layer is not explicit

Why not chosen:

- the UX ideas are strong, but the clean architecture direction is the better base for long-term expansion

---

## 14. Final recommendation

Build the scheduling card around this rule:

> **Keep slots canonical, derive interval rows for readability, and use a dedicated Now surface for runtime truth.**

That gives the user the clean first-glance experience they want, while keeping the frontend architecture honest, extensible, and ready for future schedule-related growth.
