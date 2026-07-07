# Scheduler `setBy` final proposal

## Scope

This document captures the final agreed direction for visualizing schedule action authorship:

- **Table:** use the former **Option 2** approach
- **Edit dialog:** use the former **Option C** approach

No alternative proposals remain in scope in this document.

## Problem

The scheduler backend returns `setBy` authorship metadata on schedule actions in read responses.

- `domains.inverter.setBy`
- `domains.appliances[applianceId].setBy`

Supported values:

- `user`
- `automation`

Important constraints:

1. `setBy` is **per action**, not per slot.
2. On schedule reads, the server returns `setBy` for actions.
3. User-driven FE writes may omit `setBy`; backend will persist those as `user`.

This matters because one visible slot can still contain mixed authorship.

Example:

- inverter -> `user`
- garage EV -> `automation`
- dishwasher -> `user`

So the UI must not collapse authorship into a simple slot-level flag.

## Current UI constraints

The current scheduling UI already has a few important constraints:

- action cells are compact and mostly icon-first
- inverter and EV actions are first-class visible chips
- non-EV appliances may collapse into one summary chip
- appliance chips already use a top-right projection badge
- detail rows below the table are currently reserved for runtime/compliance information
- the edit dialog already has a guarded pattern for mixed values: summary first, then explicit overwrite, then editable controls

## Final table proposal

### Pattern

Use a **thick authorship border ring** around each visible action chip.

Color mapping:

- `automation` -> **blue**
- `user` -> **amber / gold**
- `mixed` -> **orange**

Important styling rule:

- this is an **outer ring / halo**, not the chip's main border
- the current inner chip border and tone must continue to represent the action itself

The reason for this is simple: the chip already uses tone and border for action semantics, so authorship should layer on top instead of replacing that meaning.

### Why amber / gold instead of bright yellow

The selected direction keeps the user color in the yellow family, but uses a darker amber / gold rather than a bright pure yellow.

That keeps the intended semantics while improving contrast across Home Assistant themes.

## Table behavior

### Single-action chips

For inverter chips and individually rendered appliance chips:

- keep the existing chip fill, icon, and action tone unchanged
- add the outer authorship ring

Examples:

- automation-authored EV action -> blue ring
- user-authored inverter action -> amber ring

### Mixed slots

Mixed authorship is shown by the chips themselves.

Example slot:

- inverter chip -> amber ring
- EV chip -> blue ring
- appliance summary chip -> orange ring if the hidden appliance actions are mixed

### Appliance summary chips

The summary chip should aggregate authorship for the hidden appliance actions:

- all user -> amber ring
- all automation -> blue ring
- mixed user + automation -> orange ring

### Aggregated hour rows

Hour rows should use the same aggregation rule on each visible chip:

- if the aggregated underlying actions share one author -> blue or amber
- if they share the same action value but not the same author -> orange

The whole row should **not** receive an authorship background. Authorship stays attached to the chip, not the row container.

## Secondary non-color cue

The border ring should not be the only cue.

Add one tiny inline-start shape marker:

- automation -> round dot
- user -> square dot
- mixed -> diamond

This is important because:

- the chips are very small in the table
- colors alone are weaker for accessibility
- orange and amber can visually drift toward existing warm action tones if unsupported by shape

## Accessibility

The table should also expose authorship through text:

- chip `title`
- action-cell `aria-label`

Examples:

- `Charge to target SoC, set by user`
- `EV fast charge, set by automation`
- `Appliances, mixed authorship`

For summary chips and aggregated hour chips, the accessible label should include the aggregated meaning, and may include counts if useful.

Example:

- `Appliances, mixed authorship, 2 user and 1 automation`

## Final edit dialog proposal

### Pattern

Use a **decision row** with two explicit states:

- `Keep existing`
- `Replace with manual action`

This is the dialog equivalent of the current mixed-value overwrite flow, but with clearer wording for authorship takeover.

### Why this pattern

The current dialog already uses a guarded interaction for mixed values:

1. show a summary
2. require explicit overwrite intent
3. only then enable the editor controls

This proposal keeps that structure, but makes the authorship meaning explicit rather than hiding it behind a generic overwrite switch.

## Dialog behavior

### Uniform automation-authored selection

If the selected inverter or appliance action is uniformly automation-authored:

1. show a summary block such as:
   - `Automation currently owns this action`
2. show the current action chip or chips
3. show the decision row:
   - `Keep existing`
   - `Replace with manual action`
4. keep the editor controls disabled while `Keep existing` is selected
5. enable the controls only after `Replace with manual action` is chosen

### Mixed user / automation selection

If the selected range contains both user- and automation-authored actions:

1. keep the existing mixed-value summary block if values differ
2. add authorship summary copy such as:
   - `Selected slots contain both user and automation actions`
3. show the same decision row
4. enable controls only after `Replace with manual action` is chosen

This keeps one consistent interaction model for both:

- uniform automation ownership
- mixed authorship ownership

## Dialog copy and tone

The dialog should make the manual takeover intent clear, not just the fact that editing is possible.

Preferred phrases:

- `Automation currently owns this action`
- `Replace with manual action`
- `Keep existing`

Avoid weaker generic phrasing like:

- `Overwrite existing actions`

That wording is acceptable technically, but it is less clear about what the user is actually doing.

## Relationship between value state and authorship state

The dialog must treat these as separate axes:

- **value state** = `uniform` or `mixed`
- **authorship state** = `user`, `automation`, or `mixed`

They should not be collapsed into one summary concept.

Why:

- a selection can be uniform in value but automation-authored
- a selection can be mixed in value but uniform in authorship
- a selection can be mixed in both

The final dialog should keep the current value-mixed handling and add a separate authorship summary / takeover gate on top.

## Implementation notes

### 1. Preserve `setBy` in frontend read models

The frontend currently drops authorship metadata in some cloning paths.

`setBy` needs to be preserved explicitly in:

- schedule DTOs used for reads
- normalized schedule models
- table item builders
- dialog summary builders

Write DTOs may still omit `setBy` for user-driven edits.

### 2. Add a derived table authorship state

Each visible table action item should derive:

- `user`
- `automation`
- `mixed`

This should exist for:

- inverter chips
- appliance chips
- appliance summary chips
- aggregated hour-row chips

### 3. Add a derived dialog authorship state

The dialog should independently derive:

- inverter authorship -> `user | automation | mixed`
- appliance authorship -> `user | automation | mixed`

This state should drive:

- summary copy
- whether the decision row is shown
- whether controls start enabled or disabled
- any authorship decoration reused inside the dialog

### 4. Keep authorship separate from action equality

This is important.

`setBy` should affect presentation, but should not automatically become part of every equality helper used for editing.

Otherwise we risk:

- false mixed-value states in the edit dialog
- noisier selection summaries
- unnecessary fragmentation of grouped values

Better rule:

- **table presentation** should be authorship-aware
- **edit-value equality** should stay authorship-agnostic unless we explicitly decide otherwise

### 5. Manual edits should write back as user-authored

When the user changes an action in the edit dialog, FE should normally omit `setBy` in the outgoing patch and let the backend persist it as `user`.

That ensures a manual overwrite actually becomes user-authored, instead of accidentally preserving old automation ownership.

### 6. Localization and accessibility

Add localized labels for:

- `user`
- `automation`
- `mixed`
- `Automation currently owns this action`
- `Replace with manual action`
- `Keep existing`

Also update:

- chip `title`
- action-cell `aria-label`
- dialog summary copy

## Final decision summary

### Table

Use **thick outer authorship border rings**:

- blue = automation
- amber / gold = user
- orange = mixed

with a tiny shape cue on the inline-start edge.

### Edit dialog

Use an explicit **decision row**:

- `Keep existing`
- `Replace with manual action`

and keep controls gated until the user explicitly chooses the manual replacement path.
