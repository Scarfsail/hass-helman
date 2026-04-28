# Solar Bias Slot Invalidation: Live Tuning Findings (2026-04-28)

Investigation of the live Home Assistant instance at `192.168.0.44:8123`,
following the user's observations:

- The corrected forecast shows a noticeable drop around 15:00 local (CEST).
- Suspicion that some slots that *should* be invalidated are not.

This note is independent of the 2026-04-26 / 2026-04-27 root-cause findings;
those changes do not yet appear to be deployed to this instance (see
"Deployment delta" below).

## TL;DR

1. **Some slots that should be invalidated are not.** Live data reproduction
   confirms it: with the current repo's `compute_invalidated_slots_for_window`,
   slot `14:45` CEST on `2026-04-27` is invalidated (peak SoC = 100 %, export
   off throughout). The live training output (trained `2026-04-28T06:56`) does
   not list it.
2. **Some slots that should *not* be invalidated are.** On `2026-04-27`, slots
   `16:15`-`16:45` CEST are flagged in the live invalidated list even though
   the export switch flipped to `on` at `14:00:00.220 UTC` (= `16:00:00.220`
   CEST) and stayed on continuously through `18:17 UTC`. Per any version of
   the rule in git, those slots should not invalidate.
3. **Across days** (`2026-04-23` … `2026-04-27`) the live invalidation set is
   shifted relative to a local recomputation against the same recorder data:
   roughly 30-45 min later at the start, 30-45 min later at the end, with the
   total slot count similar. Pattern strongly suggests boundary semantics in
   `_segment_values` are misaligned with how the recorder reports timestamps,
   or the deployed code differs from the repo.
4. **Why the `15:00` drop in the corrected forecast.** The learned per-slot
   factor is lowest exactly where the rule under-invalidates. Slot `14:45`
   factor is `0.897`; slot `15:00` factor is `0.858`; surrounding slots are
   above `1.0`. When a curtailed `14:45` / `15:00` slot leaks into training
   uninvalidated, it contributes a low actual / forecast ratio for that slot,
   pulling the multi-day aggregate down. The drop is the symptom; the root
   cause is the missing invalidation on the `14:45-15:00` border.

## Live configuration

```yaml
power_devices.solar.forecast.bias_correction:
  enabled: true
  min_history_days: 10
  max_training_window_days: 30
  clamp_min: 0.0001
  clamp_max: 5
  aggregation_method: ratio_of_sums
  slot_invalidation:
    export_enabled_entity_id: switch.solax_export_enabled
    max_battery_soc_percent: 97
```

Status (this morning's training): `usableDays=30`, `omittedSlotCount=41`,
`invalidatedSlotCount=202`, `factorMedian≈1.026`.

## Profile factors (afternoon band)

```
13:00 1.118  13:15 1.026  13:30 1.062  13:45 1.116
14:00 0.958  14:15 0.981  14:30 0.975  14:45 0.897
15:00 0.858  15:15 1.119  15:30 0.993  15:45 0.935
16:00 1.123  16:15 1.127  16:30 1.115  16:45 1.100
17:00 1.121  17:15 1.186  17:30 1.158  17:45 1.081
```

`14:45` and `15:00` are the only two afternoon slots below `0.95`. Everything
else in 13:00-17:45 sits in `0.95-1.20`. This is the visible "drop around
15:00" the user reported.

## Reproduction

For each recent day I pulled the SoC, export, and PV-power history from the
live recorder and ran the current repo's
`compute_invalidated_slots_for_window` against it, with all 96 15-minute slots
of the day as forecast slot starts. The slot list it produced was compared to
the inspector's `series.invalidated` for the same date.

### 2026-04-27

Real data:

- `sensor.solax_battery_capacity` reaches `100` at `12:48:45.931 UTC` (=
  `14:48:45 CEST`).
- `switch.solax_export_enabled` transitions: `… off (09:00:00 UTC) → unknown
  (12:38:15) → off (12:39:24) → on (14:00:00.220 UTC) → unknown (18:17:28)
  → off (18:18:12) → on (18:18:19)`.
- So between `14:48:45` CEST (SoC = 100) and `16:00:00.220` CEST (export
  flipping back on), curtailment conditions hold continuously.

Recomputed (current repo code):

```
14:45, 15:00, 15:15, 15:30, 15:45, 16:00          (6 slots)
```

Live system reports:

```
15:00, 15:15, 15:30, 15:45, 16:00, 16:15, 16:30, 16:45   (8 slots)
```

- `14:45` is **missing** from the live set despite SoC peak `= 100` and a
  carry-over export of `off` over the entire slot.
- `16:15`-`16:45` are **extra** in the live set despite export being
  continuously `on` over those slots.

### 2026-04-26

- SoC reaches `100` at `12:17:46 UTC` (= `14:17:46 CEST`).
- Export carry-over is `off` from `07:00 UTC` until the on transition at
  `16:00:00 UTC` (= `18:00 CEST`).

Recomputed:

```
14:15, 14:30, 14:45, 15:00, … 17:45, 18:00       (16 slots)
```

Live system reports:

```
15:00, 15:15, …, 18:30, 18:45                    (16 slots)
```

Same count (16) but a clean ~45-minute shift later. Slots `14:15`, `14:30`,
`14:45` missing in front; `18:15`, `18:30`, `18:45` extra at the back, even
though export was already `on` from `18:00 CEST`.

This shift pattern recurs (less cleanly) on every other invalidated day in
the inspector window.

## Root-cause candidates

The shift+leakage pattern points at one or more of:

### A. Boundary microseconds + carry semantics

`_segment_values` (slot_invalidation.py:96) treats `sample.timestamp <=
slot_start` as carry, otherwise in-window. Real recorder timestamps for state
changes carry sub-second precision (e.g. the export `on` transition this
afternoon is at `14:00:00.220215 UTC`, not `14:00:00.000000`). The slot start
is exactly on the second boundary (`14:00:00.000000 UTC`). Consequences:

- A transition that "happens at the slot boundary" is treated as
  in-window-with-carry-from-before. So a slot whose entry was actually `on`
  the whole time but inherits a `False` carry from the previous slot ends up
  with `[False, True]` and invalidates anyway.
- Symmetric on the other side: a slot whose entry was `off` for its whole
  duration may produce `[False]` and invalidate as expected, but a slot whose
  carry was `None` (an `unknown`/`unavailable` state earlier) still produces
  `[None]` and is silently skipped — even when the *actual* electrical state
  was `off`.

The `2026-04-27` `14:45` slot fits this perfectly: SoC samples are
fine (peak 100), but if the export carry computation latched onto an
`unknown` instead of the preceding `off`, the slot gets skipped.

### B. The forecast-slot-set filter

Even with a perfect `_segment_values`, the invalidation function only
evaluates slots that are in `forecast_slot_starts_by_date`. That dict is
built from `load_historical_per_slot_forecast`, which selects a single
historical state of the daily forecast entity for the target day. As
documented in `slot-invalidation-root-cause-findings-2026-04-27.md`, this
selection is sensitive to recorder boundary semantics. If the picked state's
`wh_period`/`watts` is missing some hours, those slots can never invalidate
no matter what SoC and export look like. The `45-minute shift` on
`2026-04-26` is consistent with the historical state for that day having
truncated leading hours.

### C. Deployment delta

The fix landed today (`8b21b52`, repo) is not yet on this Home Assistant
instance. The instance also predates the `ec71606`
"invalidate-export-off-slots-with-unknown-samples" fix. Older code skipped
any slot whose export window contained a `None`, which lines up with the
under-invalidation symptoms above.

## What should be done

The live symptoms match a combination of (A) sub-second boundary treatment in
`_segment_values` and (B) the forecast-slot dependency. Today's repo fix
addresses neither directly.

### 1. Decouple slot invalidation from the historical forecast slot set

`compute_invalidated_slots_for_window` should evaluate every 15-minute slot
present in `slot_actuals_by_date[day]` (or every 15-minute slot of the day
the actuals window covers), not only those that survive
`load_historical_per_slot_forecast` →`_expand_hourly_to_15min`. The rule is a
property of the *physical* state (SoC, export switch), not of forecast
publication. This single change kills the `45-minute shift` on `2026-04-26`.

Concretely: in `_load_invalidated_slots_for_window`, replace
`_load_forecast_slot_maps_for_window` with a builder that produces a flat
`forecast_slot_starts_by_date` from the day grid (`00:00`, `00:15`, …,
`23:45`, in local time → UTC) for every day in `slot_actuals_by_date`. Drop
the historical-forecast call from the invalidation path entirely.

### 2. Fix the boundary semantics in `_segment_values`

Two concrete tweaks:

a. Use `sample.timestamp < slot_start` for carry (strict) and `>= slot_end`
   for break. Then a state change occurring exactly at `slot_start` is
   interpreted as "this slot starts in the new state", not "this slot
   inherits the previous state plus this new sample". Combined with sub-second
   recorder precision this no longer causes the carry-flip artefact at
   `16:00`-`16:45`.

   Equivalent alternative: round both slot starts and sample timestamps to
   second precision before comparing. Cleaner conceptually but makes test
   cases verbose. Prefer the strict-`<` version.

b. For export carry-over, treat the most recent *known* value (the latest
   `True`/`False` sample with `<= slot_start`) as the carry, ignoring any
   intervening `unknown`/`unavailable`. A short transient `unknown` (these
   are typically <100 ms in this recorder) should not throw away the
   knowledge that the switch was `off` immediately before. This keeps the
   invalidation deterministic under sensor blips.

### 3. Verify the deployment matches `main`

Confirm that the live HA at `192.168.0.44` is running at least
`8b21b52`. Some of the under-invalidation pattern on `14:45 CEST 2026-04-27`
may already disappear once `ec71606` (handle `None` export samples) is
deployed.

### 4. Re-train and observe

After (1) + (2): retrain on the same 30-day window. Expected outcome:

- `factors[14:45]` rises from `~0.897` toward neighbors (`~1.0`).
- `factors[15:00]` rises from `~0.858` toward neighbors.
- `invalidatedSlotCount` increases (currently `202` for 30 days = ~6.7
  slots/day; expect closer to `8-10` slots/day on sunny days).
- `dropped_days` should not regress.

### What is *not* the cause

- Recorder retention. SoC and export samples are still queryable for the
  full 30-day window; sample density is high enough.
- The `clamp_min = 0.0001`. Per existing project memory the floor can sit
  on `0.0` (outage protection is handled by slot-invalidation, not by the
  floor); the depressed factors are not at the floor here.
- Slot key timezone mismatch. Slot keys are produced in local time and
  recombined via `dt_util.as_utc`; same code path used for both forecast and
  invalidation paths.

## Appendix: Sample export switch transitions consumed

Verified via `/api/history/period`:

```
2026-04-26 09:00:00 UTC  off
2026-04-26 16:00:00 UTC  on
2026-04-27 09:00:00 UTC  off
2026-04-27 12:38:15.503 UTC  unknown
2026-04-27 12:39:24.839 UTC  off
2026-04-27 14:00:00.220 UTC  on
2026-04-27 18:17:28 UTC  unknown
2026-04-27 18:18:12 UTC  off
2026-04-27 18:18:19 UTC  on
```

Sub-second precision on transition timestamps is the norm, not the exception.
