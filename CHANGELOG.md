# Changelog

## Unreleased

### Breaking Changes

- `helman/get_forecast` `solar.points` now contains the raw canonical solar forecast. Consumers that need bias-corrected values should use `solar.adjustedPoints`.
- `helman/get_forecast` no longer exposes `solar.rawPoints`; use `solar.points` for raw values.
- `helman/get_forecast` now includes `solar.biasCorrection` whenever solar bias correction produced a result. `solar.adjustedPoints` is present only when `biasCorrection.effectiveVariant` is `adjusted`.

### Improvements

- Solar bias correction now interpolates correction factors for short runs of slots that
  fail the `min_valid_slot_days` gate, instead of leaving them at the implicit fallback
  of 1.0. Linear interpolation is performed between the nearest healthy neighbors (or
  zero at the edges of the day). The maximum run length is configurable via
  `bias_correction.max_interpolated_consecutive_slots` (default 2; set to 0 to disable).
