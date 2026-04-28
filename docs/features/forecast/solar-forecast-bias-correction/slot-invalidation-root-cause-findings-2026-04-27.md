# Solar Bias Slot Invalidation: Root Cause Findings (2026-04-27)

Follow-up to `slot-invalidation-investigation-2026-04-26.md`. This note focuses
exclusively on **Use Case 1** (export-off + high-SoC slots not being invalidated
between 14:30 and 16:45 on 2026-04-26 even though export was off and SoC was
100%). Use Case 2 (zero/spike data-quality rule) is intentionally out of scope.

## TL;DR

`compute_invalidated_slots_for_window` only ever evaluates slots that are
present in `forecast_slot_starts_by_date`. That dictionary is built from
`load_historical_per_slot_forecast`, which in turn depends on
`_select_first_state_for_window` to recover the historical forecast state for
the target day. That selector has a bug: it **skips the start-of-window
boundary state** that the recorder synthesizes via
`include_start_time_state=True`, and instead returns the *first state change
within the day window*. When that state change happens late in the day (e.g.
during an afternoon forecast refresh) and the forecast provider prunes already-
elapsed hours from the `wh_period`/`watts` attributes, the resulting
`slot_forecast_wh` only covers the late-afternoon hours.

For 2026-04-26 the captured "historical" forecast almost certainly came from a
mid-afternoon refresh with `wh_period`/`watts` truncated to roughly 17:00-21:00.
That is exactly the slot range over which invalidation fired. Slots 14:30-16:45
were silently absent from `forecast_slot_starts_by_date`, so
`compute_invalidated_slots_for_window` never even got the chance to test the
SoC + export rule for them.

## Evidence

### Symptom
- Inspector reported `series.invalidated` only for 17:00-18:45 on 2026-04-26.
- Real-data table (see investigation note) shows 14:30-16:45 satisfied the
  invalidation conditions trivially: SoC 100%, export off, threshold 97%.
- The trainer still consumed those slots' actuals, learning a depressed factor
  for early afternoon — meaning the slots WERE present for training, but were
  not flagged as invalidated.

That last point is important: the trainer iterates
`s.slot_forecast_wh.keys()` for each `TrainerSample`, so the trainer "saw" the
14:30-16:45 slots only because their forecast was present at training time.
But invalidation runs against `forecast_slot_starts_by_date`, which is sourced
from the *historical* forecast for the past day, via a different code path.

### Two independent forecast lookups, only one of them broken

There are two `wh_period` lookups on the path:

1. `load_trainer_samples` → `load_historical_per_slot_forecast` → trainer
   sample. (Trainer used the slots at 14:30-16:45 and learned a low factor.)
2. `_load_invalidated_slots_for_window` → `_load_forecast_slot_maps_for_window`
   → `load_historical_per_slot_forecast` → invalidation. (Invalidation only
   saw 17:00-18:45 slot starts.)

Both invocations call the same `load_historical_per_slot_forecast`. So why
would they return different slot sets? They wouldn't — *if called at the same
moment*. But:

- Trainer runs once and caches its samples.
- Invalidation runs against a fresh recorder query each time
  `load_actuals_window` is invoked (e.g. for inspector requests).

It is enough for **one** of those calls to land on a moment where the
recorder returns a truncated state for the slot lists to diverge. The most
recent inspector run is the one whose output we're looking at; the trainer's
run happened earlier, so it could perfectly well have seen all hours.

Whichever specific call is the truncated one, the underlying mechanism is the
same: `_select_first_state_for_window` does not return the state that was in
effect at midnight; it returns the first state change after midnight, whose
contents are at the mercy of the forecast provider's update cadence and
pruning behavior.

### The selector bug, in detail

`forecast_history.py`:

```python
async def _read_historical_forecast_state(...):
    ...
    return _select_first_state_for_window(states, after=dt_util.as_utc(local_start))
```

```python
def _select_first_state_for_window(states, *, after):
    for state in sorted(states, key=_state_sort_key):
        if _state_sort_key(state) < after:
            continue
        return state
    return None
```

`_state_sort_key` reads `last_updated` (or `last_changed`). When
`get_significant_states(..., include_start_time_state=True)` synthesizes a
boundary state at the start of the window, that boundary state's
`last_updated` is the original timestamp of the last update *before* the
window start — i.e. it is `< after`. The `if _state_sort_key(state) < after:
continue` clause therefore filters the boundary state out, and the function
returns whichever real state-change happened first inside the window.

That is the opposite of what `load_historical_per_slot_forecast`'s docstring
promises:

> Return slot_key -> Wh for the forecast as published at the start of
> target_date.

The state *as published at the start of target_date* is exactly the boundary
state.

### Why the truncated state is shaped like the observed symptom

When a forecast integration (Solcast / Forecast.Solar / similar) refreshes its
`today` entity mid-day, several behaviors are common:

- `wh_period` keeps only future hours, dropping already-elapsed hours.
- `watts` is similarly trimmed to the remaining day.
- The remaining hours run from the next hour boundary through the end of the
  day.

If the first state-change after midnight on 2026-04-26 happened around mid-
afternoon (roughly 16:30-17:00), `wh_period`/`watts` would cover only
~17:00-21:00. After `_expand_hourly_to_15min` (which requires all four
`HH:00 / HH:15 / HH:30 / HH:45` keys to be present in `watts` for the hour to
emit any 15-minute slots), the resulting `slot_forecast_wh` would have keys
roughly `17:00…20:45` — exactly the band where invalidation actually fired.

We have not observed the truncated `wh_period` directly in the recorder, but
the shape of the slot set produced by the bug matches the inspector symptom
precisely, and no other hypothesis we walked through (SoC peak miss, export
sample carry-over, slot key timezone mismatch, parser failure on 100%) survives
the data in the investigation table.

## Root cause statement

`_select_first_state_for_window` does not return the entity state that was in
effect at the start of `target_date`. It returns the first state-change within
the day window. When the forecast integration's first state-change of the day
happens after sunrise and/or trims past hours from `wh_period`/`watts`, the
historical-forecast slot set is missing the morning/early-afternoon hours.
`compute_invalidated_slots_for_window` consumes that slot set unmodified, and
therefore never evaluates the export+SoC rule for the missing slots.

This is why 14:30-16:45 on 2026-04-26 stayed un-invalidated despite trivially
matching the rule, while 17:00-18:45 (slots that *were* in the truncated
forecast) invalidated correctly.

## Proposed fix

### 1. Fix `_select_first_state_for_window` to honor the boundary state

Change the selector to return the latest state with `_state_sort_key <= after`
(i.e. the state in effect at `after`), and only fall back to the first state
strictly inside the window if no boundary state exists. Concretely:

```python
def _select_first_state_for_window(states, *, after):
    boundary: Any | None = None
    for state in sorted(states, key=_state_sort_key):
        key = _state_sort_key(state)
        if key <= after:
            boundary = state
            continue
        return boundary if boundary is not None else state
    return boundary
```

This makes `load_historical_per_slot_forecast` actually return the forecast
"as published at the start of target_date", matching its docstring. The same
fix should be carried into the trainer path because `load_trainer_samples`
ultimately depends on the same selector — which has the side benefit of
making trainer samples deterministic regardless of when training runs during
the day.

A short test should accompany the fix: build a fake `states` list with
- a synthetic boundary state whose `last_updated` is yesterday,
- a real state-change at, say, 16:30 on the target day,
and assert that the selector returns the boundary state.

### 2. Decouple slot invalidation from forecast slot availability

Even with (1) fixed, the current architecture is fragile: invalidation only
ever evaluates slots present in the historical forecast. If for any reason
the forecast attribute is missing or partial for a past day (recorder
retention gap, integration outage, attribute schema change), invalidation
silently does nothing for the missing slots, and the trainer cannot tell.

A more robust approach: drive `forecast_slot_starts_by_date` from
`slot_actuals_by_date` (the cumulative-delta-derived actuals), which we
already compute and which always reflects the real 15-minute slot grid for
the day. Concretely, replace `_build_slot_invalidation_inputs(...,
forecast_slots_by_date)` with a builder that walks `slot_actuals_by_date`
keys directly. The forecast lookup is then no longer on the invalidation
path at all.

Trade-off: invalidation will now also evaluate slots where the historical
forecast happened to be missing — which is exactly what we want, because the
trainer might still pick those slots up through the union path
`forecast_slot_keys.update(s.slot_forecast_wh.keys())`. It will not produce
spurious invalidations because the rule (SoC peak + export off) is purely
about real-state samples, independent of forecast presence.

(1) on its own is sufficient to fix the immediate 2026-04-26 symptom. (2) is
recommended additionally to make the rule robust against any future
forecast-history irregularity. They are independently mergeable.

### What this does not change

- The 14:15 borderline case in the investigation note remains a configuration
  question (threshold currently 97%, real SoC at end of slot was 96%); not
  in scope here.
- Use Case 2 (zero/spike data-quality rule) is independent and not addressed.

## Suggested verification once fixed

1. Re-run training for 2026-04-26 with the boundary-state fix in place and
   confirm `metadata.invalidated_slots_by_date["2026-04-26"]` includes
   14:30, 14:45, 15:00, 15:15, 15:30, 15:45, 16:00, 16:15, 16:30, 16:45 in
   addition to the 17:00-18:45 slots.
2. Re-check the resulting `factors` for the early-afternoon slot keys; the
   artificially low factor learned from curtailed slots should disappear.
3. Confirm trainer sample count for past days does not regress (the same
   fix is applied to a function shared with the trainer path).
