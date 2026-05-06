# Changelog

## Unreleased

### Breaking Changes

- `helman/get_forecast` `solar.points` now contains the raw canonical solar forecast. Consumers that need bias-corrected values should use `solar.adjustedPoints`.
- `helman/get_forecast` no longer exposes `solar.rawPoints`; use `solar.points` for raw values.
- `helman/get_forecast` now includes `solar.biasCorrection` whenever solar bias correction produced a result. `solar.adjustedPoints` is present only when `biasCorrection.effectiveVariant` is `adjusted`.
