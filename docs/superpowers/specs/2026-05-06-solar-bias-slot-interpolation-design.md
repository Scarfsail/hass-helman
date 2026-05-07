# Solar bias slot interpolation fallback

## Problem

The bias trainer aggregates per-slot correction factors across a rolling window of training days. When most training days have a slot invalidated (export disabled + battery at 100% during midday is the common case), the slot can fail the `min_valid_slot_days` gate and be omitted entirely, which makes the adjuster fall back to a multiplier of `1.0` for that slot.

The remaining valid days that scrape past the gate can also steer the factor in an unrealistic direction — a slot whose neighbors converged on `~0.7` should not jump to `~1.4` because two atypical days were the only ones that produced data.

We want a smoother fallback: when a slot does not have enough valid data, interpolate its factor linearly from neighboring healthy slots instead of omitting it.

## Scope

Single-gate solution that reuses the existing `min_valid_slot_days` check. Slots that fail that check become eligible for interpolation; if interpolation is not possible (gap too wide), they remain omitted exactly as today.

Out of scope: any change to the slot-invalidation pipeline, the day-level filters, the adjuster, or the storage schema beyond additive metadata fields.

## Configuration

One new field on `BiasConfig`:

- `max_interpolated_consecutive_slots: int`, default `2`.
  - `0` disables interpolation entirely (current behavior).
  - Included in `compute_fingerprint` so a change forces a re-train.

No second "valid ratio" parameter is introduced — the existing `min_valid_slot_days` already encodes "this slot has too little data".

## Algorithm

Inserted as a single pass at the end of `train()` in `custom_components/helman/solar_bias_correction/trainer.py`, after the per-slot loop has produced `factors`, `omitted_slots`, and `omitted_slot_reasons`, and before the metadata/explainability are built.

1. **Eligibility.** A slot is an interpolation candidate iff it appears in `omitted_slots` with reason `slot_insufficient_valid_days`. Slots omitted for `slot_forecast_sum_too_low` or `slot_no_ratio` are NOT eligible — those reasons mean the slot has no real forecast worth correcting.

2. **Snapshot anchors.** Take a snapshot of `factors` before the pass begins. All anchor lookups read this snapshot, so a slot filled by interpolation can never act as an anchor for another interpolated slot in the same run.

3. **Group into runs.** Walk `sorted_forecast_slots` (the existing union-of-keys list, sorted by minute-of-day). Collect consecutive eligible slots into runs. "Consecutive" means adjacent in `sorted_forecast_slots`, not adjacent in wall-clock time — this matches how the trainer already reasons about slot order.

4. **Per run of length L.**
   - If `L > max_interpolated_consecutive_slots`: leave the run as-is. Slots stay in `omitted_slots` with their existing reason.
   - Else: interpolate.
     - **Left anchor:** factor of the nearest preceding slot (in `sorted_forecast_slots`) present in the snapshot. If none → `0.0`.
     - **Right anchor:** factor of the nearest following slot present in the snapshot. If none → `0.0`.
     - For the i-th slot in the run (1-indexed):
       `factor = left + (right - left) * i / (L + 1)`
     - No clamping. Anchors are already clamped, and a linear blend of values inside `[clamp_min, clamp_max]` (or the edge case where one anchor is `0.0`) cannot escape the band in any way that warrants re-clamping.
     - Move the slot from `omitted_slots` (and from `omitted_slot_reasons`) into `factors`.

5. **Edge runs.** A run with no preceding healthy slot uses left anchor `0.0`; a run with no following healthy slot uses right anchor `0.0`. This keeps the math defined and reflects the physical reality at sunrise/sunset where forecast is near zero.

6. **Recompute summary stats.** After the pass, recompute `factor_min`/`factor_max`/`factor_median` from the updated `factors` so metadata reflects the interpolated values.

## Data model changes

Additive only.

`BiasConfig` (in `models.py`):
- `max_interpolated_consecutive_slots: int = 2`

`SolarBiasMetadata`:
- `interpolated_slot_count: int = 0` — number of slots filled by interpolation in this run.

`SolarBiasSlotExplainability`:
- `interpolated: bool = False`
- `interpolation_anchors: tuple[str | None, str | None] | None = None` — `(left_slot, right_slot)`, where `None` on either side means "edge zero".

The training-explainability builder appends a synthetic `SolarBiasContributionRow` to interpolated slots with `status="interpolated"` and `reason` encoding the anchors (e.g. `"left=11:30,right=12:30"` or `"left=edge_zero,right=06:00"`), so the existing slot inspector renders the source without UI changes.

## Fingerprint

`compute_fingerprint` adds `max_interpolated_consecutive_slots=...` to the payload string. Algorithm version stays the same — the change is gated by the new config value, and `0` reproduces today's behavior bit-for-bit.

## Adjuster

No changes. Interpolated factors land in `SolarBiasProfile.factors` like any other and are looked up identically.

## Testing

New unit tests in `tests/test_solar_bias_trainer.py` (or a focused new file if that one is already large):

- Run of 1 between two healthy slots → midpoint factor.
- Run of 2 between two healthy slots → 1/3 and 2/3 weights along the line.
- Run of 3 with `max_interpolated_consecutive_slots=2` → all three remain omitted.
- Morning-edge run (no left anchor) → interpolates from `0.0` toward the right anchor.
- Evening-edge run (no right anchor) → interpolates from the left anchor toward `0.0`.
- `max_interpolated_consecutive_slots=0` → output identical to current behavior (regression guard).
- Two runs separated by a single healthy slot → both interpolate independently using only the snapshot, so the healthy slot's factor is used as the right anchor of the first run AND the left anchor of the second run, but neither interpolated value influences the other.
- Slot omitted for `slot_forecast_sum_too_low` is not interpolated even when its neighbors are healthy.
- `compute_fingerprint` differs when `max_interpolated_consecutive_slots` differs.
- `interpolated_slot_count` and the per-slot explainability fields are populated correctly.

## Out of scope / non-goals

- No frontend work in this spec. The slot inspector already renders contribution rows; the new `status="interpolated"` row will appear automatically. Any dedicated UI affordance is a follow-up.
- No second config parameter for "valid ratio threshold" — `min_valid_slot_days` is the single source of truth.
- No clamping of interpolated factors.
- No interpolation across slots omitted for reasons other than insufficient valid days.
