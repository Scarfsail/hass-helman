# Scheduler action pill visual options

## Problem

In the scheduler, the scheduled action is currently rendered as a pill whose meaning is carried almost entirely by text. That makes the slot table harder to scan, especially when several neighboring rows differ only by action label.

The goal of this proposal is to make scheduler actions easier to distinguish at a glance while preserving the current compact chip language and keeping scheduled actions visually separate from runtime, reason, and error badges.

## Current constraints

- The action domain is currently a fixed 5-kind union:
  - `normal`
  - `charge_to_target_soc`
  - `discharge_to_target_soc`
  - `stop_charging`
  - `stop_discharging`
- Scheduled action pills are rendered inline in `scheduling-slot-table.ts`.
- The same action semantics also appear in the edit dialog, which currently differs only by text and selection styling.
- Scheduling already reserves separate chip semantics for:
  - scheduled action
  - runtime
  - reason
  - error
  - disabled state
- Any new action colors should not reuse the exact same visual treatment as runtime, reason, or error chips.

## Shared design direction

These principles apply to all options below:

- Keep the existing text labels.
- Add a small leading icon.
- Use soft semantic tinting instead of loud solid badges.
- Mirror the same visual language in the edit dialog.
- Make `normal` feel intentionally neutral so the other actions stand out.
- Use a red family for stop actions, but keep it distinct from actual runtime error styling.

## Recommended semantic mapping

This mapping fits the requested semantics and keeps the visual language easy to scan:

| Action kind | Suggested icon | Suggested tone | Notes |
| --- | --- | --- | --- |
| `normal` | `mdi:circle-outline` | Neutral grey | Should visually recede. |
| `charge_to_target_soc` | `mdi:arrow-up-bold-circle-outline` | Soft green | Green reads naturally as charging/energy in. |
| `discharge_to_target_soc` | `mdi:arrow-down-bold-circle-outline` | Soft amber/orange | Distinct from charge without borrowing error red. |
| `stop_charging` | `mdi:arrow-up-bold-circle` | Soft red | Same stop family, differentiated by icon + text. |
| `stop_discharging` | `mdi:arrow-down-bold-circle` | Soft red | Same stop family, differentiated by icon + text. |

Notes:

- The exact MDI icons can still be refined later.
- Stop actions should not literally reuse the `.chip.error` style. They should use their own softer stop tone.
- Runtime, reason, and error chips should remain unchanged.

## Option 1: Minimal inline enhancement

### What it looks like

- Keep the current slot-table action button and chip structure.
- Add a small leading icon inside the chip.
- Add a per-kind tint class so the chip is no longer a single shared action color.
- In the edit dialog, keep the current option cards and add the same chip treatment to the option title area.

### Architecture

- Add a small helper near `schedule-labels.ts` that maps `ScheduleAction["kind"]` to:
  - icon
  - semantic CSS class
- Extend `scheduling-shared-styles.ts` with per-kind action classes.
- Keep all rendering inline in the existing slot table and dialog.

### Files touched if implemented

- `src/helman-scheduling/model/schedule-labels.ts`
- `src/helman-scheduling/styles/scheduling-shared-styles.ts`
- `src/helman-scheduling/components/scheduling-slot-table.ts`
- `src/helman-scheduling/dialogs/scheduling-range-edit-dialog.ts`

### Pros

- Smallest blast radius.
- Fastest route to a visibly better scheduler.
- No new components or data-model changes.

### Cons

- Presentation logic still lives across multiple render sites.
- Slot table and dialog remain loosely coupled.
- If new scheduler surfaces appear later, duplication may grow.

### Best fit

Choose this when the priority is the quickest safe UX win with minimal structural change.

## Option 2: Pragmatic shared mapping

### What it looks like

- Use icon + text chips with gentle semantic tint in the slot table.
- Reuse the same semantic language in the edit dialog.
- Keep the current compact scheduler visuals, but make each action kind recognizable without reading the full label first.
- Let selected dialog options lightly echo the same action tone without overwhelming the selection state.

### Architecture

- Keep the implementation lightweight, but centralize presentation mapping.
- Add a shared helper that returns action presentation metadata:
  - icon
  - semantic class
  - label context
- Use that helper in both:
  - `scheduling-slot-table.ts`
  - `scheduling-range-edit-dialog.ts`
- Put the visual behavior in shared scheduler CSS using explicit per-kind semantic classes.

This follows the same broad pattern already used in forecast: model/helper decides the semantic class, render layer attaches it, shared CSS styles it.

### Files touched if implemented

- `src/helman-scheduling/model/schedule-labels.ts` or a sibling helper file
- `src/helman-scheduling/styles/scheduling-shared-styles.ts`
- `src/helman-scheduling/components/scheduling-slot-table.ts`
- `src/helman-scheduling/dialogs/scheduling-range-edit-dialog.ts`

### Pros

- Best balance of UX improvement and maintainability.
- Keeps slot table and dialog consistent.
- Centralizes the action-kind visual rules without introducing extra component layers.
- Fits the current codebase well.

### Cons

- Slightly more code than the minimal option.
- Still not as reusable as a dedicated chip component if scheduling grows further.

### Best fit

Choose this when the goal is a strong, clear improvement now without overengineering the scheduler.

## Option 3: Clean component architecture

### What it looks like

- Same visual treatment as Option 2 from a user perspective:
  - icon
  - gentle tint
  - unchanged labels
  - neutral normal state
  - red stop states
- The difference is architectural: action presentation becomes a small reusable scheduling UI subsystem.

### Architecture

- Add a dedicated action-presentation helper, for example:
  - `schedule-action-presentation.ts`
- Add a reusable presentational chip component, for example:
  - `scheduling-action-chip.ts`
- Optionally add a dialog-specific option component, for example:
  - `scheduling-action-option-card.ts`
- Use those building blocks from both the slot table and the edit dialog.

This aligns with the earlier scheduling UI proposal, which already anticipated dedicated `scheduling-action-chip` and `scheduling-runtime-chip` components.

### Files touched if implemented

- `src/helman-scheduling/model/schedule-action-presentation.ts` (new)
- `src/helman-scheduling/components/scheduling-action-chip.ts` (new)
- `src/helman-scheduling/components/scheduling-action-option-card.ts` (new, optional but clean)
- `src/helman-scheduling/styles/scheduling-shared-styles.ts`
- `src/helman-scheduling/components/scheduling-slot-table.ts`
- `src/helman-scheduling/dialogs/scheduling-range-edit-dialog.ts`

### Pros

- Cleanest long-term structure.
- Strongest reuse across future scheduler surfaces.
- Reduces presentation drift over time.

### Cons

- Highest implementation cost for a relatively small current UX issue.
- Adds more files and indirection.
- May feel heavier than necessary if this is the only scheduling surface that needs semantic action chips.

### Best fit

Choose this when scheduler expansion is already planned and you want to invest in the long-term UI architecture now.

## Comparison

| Option | User-visible improvement | Engineering cost | Long-term cleanliness | Fit for current codebase |
| --- | --- | --- | --- | --- |
| 1. Minimal inline enhancement | Good | Low | Fair | Good |
| 2. Pragmatic shared mapping | Very good | Low-medium | Good | Very good |
| 3. Clean component architecture | Very good | Medium-high | Very good | Good, but heavier |

## Recommendation

**Recommended option: Option 2 — Pragmatic shared mapping**

Why this is the best fit:

1. It solves the scanning problem clearly.
2. It keeps the slot table and dialog visually aligned.
3. It follows an existing repo pattern: semantic mapping in helper code, styling in shared CSS.
4. It avoids turning a focused UX improvement into an unnecessary component extraction project.
5. It leaves a clean upgrade path to Option 3 later if the scheduling UI grows more surfaces.

## Suggested implementation order

If Option 2 is chosen later, a sensible sequence would be:

1. Add the action presentation mapping.
2. Add semantic action classes and icon sizing to shared scheduling styles.
3. Update the slot-table action chip.
4. Mirror the same visual language in the edit dialog.
5. Verify that runtime/reason/error chips still read as separate semantics.

## Open detail to confirm during implementation

The only detail still worth validating in the real UI is the exact discharge tone:

- amber/orange is semantically distinct from charge and stop
- but it should still feel at home next to the existing scheduler palette

That can be fine-tuned visually during implementation without changing the underlying proposal.

## Current decision

- Preferred direction after review: **Option 3 — Clean component architecture**
- That means future implementation should favor a reusable action-presentation helper plus dedicated scheduling action chip building blocks rather than keeping the logic inline.
