# Solar Forecast Bias Correction - V1 Model Design

## Status

Companion to `solar-forecast-bias-correction-requirements.md` and `solar-forecast-bias-correction-engine-architecture.md`. The buildable v1 implementation spec — which pins `min_history_days=10`, makes the clamp configurable, and defines persistence/scheduling/UI — lives in `solar-forecast-bias-correction-v1-implementation-design.md` and supersedes this doc wherever they overlap.

This document pins the **algorithmic** design of the v1 slot-of-day multiplicative bias profile: training formula, parameters, numeric bounds, and inference rule. Structural architecture (modules, response shape) and input-contract concerns (trainer samples, `daily_wh` source) live in the sibling docs.

## Scope

In scope:

- how factors are computed from historical samples
- how the profile is parameterized and shaped
- numeric bounds (clamping, sample thresholds)
- edge cases (near-zero forecasts, DST, outlier days)
- how the adjuster applies the profile at inference time

Out of scope:

- where historical data comes from (see **Data inputs** section of the engine-architecture doc)
- weather-aware correction (future extension)
- any non-multiplicative model family

## Model shape

### Bias profile

A `SolarBiasProfile` is a map keyed by **local slot key** `"HH:MM"` on the canonical 15-minute grid.

Each entry carries a single `factor` — the learned multiplicative correction, a float.

Slots with insufficient support are **omitted** from the profile. The adjuster defaults missing keys to `factor = 1.0`, so nighttime slots and shoulder slots that never accumulate signal simply do not appear.

The profile also carries aggregate metadata (`usableDays`, `omittedSlotCount`) for explainability rather than per-slot sample counts.

Keying by local-time slot (not absolute timestamp) is what makes "slot-of-day" learning work: a given slot's correction applies every day at that local time.

## Training algorithm

### Inputs

- N usable historical days, each with aligned `forecastPoints15m` and `actualPoints15m` on local canonical slots (the trainer input contract)
- configuration:
  - `minHistoryDays` (from `bias_correction.min_history_days`, default `10`)
  - `clampMin`, `clampMax` (from `bias_correction.clamp_min` / `clamp_max`, defaults `0.3` / `2.0`)

### Step 1 — day-level usability filter

For each candidate historical day, compute `dayRatio = sumActual / sumForecast` (over the whole day).

Drop the day as **unusable** if:

- `sumForecast < 100 Wh` (forecast too low to learn anything meaningful — e.g. fully-shaded days)
- `dayRatio < 0.05` or `dayRatio > 5.0` (data-quality sanity band — suggests missing actuals, sensor reset, or misaligned data)

Everything else is **usable**. This is the coarse outlier filter; it is not trying to detect cloudy days (those are the signal we want to learn from, not exclusions).

### Step 2 — gate on total usable days

If the count of usable days is below `minHistoryDays`, training returns a neutral profile (all factors = 1.0) and the service falls back to raw. Explainability carries `fallbackReason: "insufficient_history"`.

### Step 3 — per-slot factor

For each local slot `s` in the canonical 15-minute grid:

```
forecastSum_s = sum over usable days of forecast[s, d]
actualSum_s   = sum over usable days of actual[s, d]
```

Then:

- if `forecastSum_s < 50 Wh` → slot is **omitted** from the profile (adjuster defaults to 1.0 at inference)
- else → `factor_s = clamp(actualSum_s / forecastSum_s, clampMin, clampMax)`

The `forecastSum_s < 50 Wh` floor is the **near-zero forecast guard**: nighttime and deep-shoulder slots where forecasts are effectively zero across the window must not drive the factor, because dividing tiny numbers explodes. Because the sum is across all usable days, it implicitly requires both enough days of signal and enough per-day signal — a single threshold replaces separate per-day and sample-count gates.

### Why sum-ratio (not mean-of-ratios or median-of-ratios)

Sum-ratio weights each day by its energy. That gives bright days more influence than dim days — which is what we want: systematic clear-sky bias is the main target, and cloudy days are the noise. Mean-of-ratios lets a dim morning with a single cloud produce an extreme ratio that swamps a full sunny day. Median-of-ratios is more robust but loses the energy weighting.

If field experience later shows sum-ratio gets dragged by one unusually bright day, switching to a trimmed sum-ratio (drop top/bottom 10% of days by ratio) is a localized change.

### Clamp bounds

The clamp is configurable (`clamp_min` / `clamp_max`) with defaults `[0.3, 2.0]`. Defaults chosen so:

- a 3× underestimate (raw = 33% of reality) is bounded to a 2× correction — partial, not full
- a 3× overestimate (raw = 3× reality) is bounded to a 0.3× correction
- the default band is deliberately asymmetric: real-world systematic bias tilts toward overestimation (clear-sky assumptions), so more downward headroom is useful

Validation must enforce `clamp_min < clamp_max` (see requirements / v1 implementation design). Hard caps prevent inference-time blowups if training data is degenerate.

## Inference algorithm

Given a raw forecast point at absolute time `t` with value `raw_t`:

1. Compute `s = localSlotKey(t)` — convert `t` to local time on the canonical 15-minute grid.
2. Look up `factor_s` in the profile; default to `1.0` if the slot was omitted (insufficient support).
3. `adjusted_t = raw_t * factor_s`
4. Apply a final inference clamp: `adjusted_t = max(0, adjusted_t)`. Solar production cannot be negative.

The raw series is never mutated. The adjuster returns a new series.

## Edge cases

### Near-zero forecast values

Handled by the `forecastSum_s < 50 Wh` per-slot gate. Nighttime slots are omitted from the profile and default to `1.0` at inference; multiplying zero by 1.0 remains zero.

### DST transitions

Slot keys are **local** `"HH:MM"`. Consequences:

- **Spring-forward day (23 hours)**: the skipped hour's four slots simply get no contribution from that day. Training sees one fewer day of data for those slots. No special handling required.
- **Fall-back day (25 hours)**: the repeated local hour contributes twice to its four slots. The history adapter does **not** deduplicate — both aligned samples feed the sum, consistent with Step 3's per-slot sum formula. This over-weights those slots by roughly 1/N across the window, which is negligible for a 14+ day training window.

### Zero or missing raw forecast at inference

If `raw_t` is zero, `adjusted_t` is zero regardless of factor. If `raw_t` is missing entirely, the adjuster leaves the point missing; the adjusted series mirrors the raw series' shape.

### Training window size

No `training_window_days` config knob in v1 (see requirements). Training uses whatever completed days Recorder returns, provided the usable-day count meets `minHistoryDays`. If real-world data shows unbounded lookback causes drift or cost issues, introducing a cap is a localized change.

## Parameter table

| Name | Value | Source | Rationale |
| --- | --- | --- | --- |
| `minHistoryDays` | default `10`, configurable | `bias_correction.min_history_days` | requirements |
| factor clamp | default `[0.3, 2.0]`, configurable | `bias_correction.clamp_min` / `clamp_max` | caps extreme corrections (asymmetric defaults by design); configurable per v1 implementation design |
| day forecast floor | `100 Wh` | hardcoded v1 | filters fully-shaded / zero-forecast days |
| day ratio sanity band | `[0.05, 5.0]` | hardcoded v1 | filters sensor/data corruption, not cloudy days |
| per-slot forecast sum floor | `50 Wh` | hardcoded v1 | single near-zero / thin-support guard |
| inference non-negativity clamp | `max(0, …)` | hardcoded v1 | solar cannot be negative |

Only `minHistoryDays` and the factor clamp are configurable in v1. The remaining values are **implementation constants**. If field experience shows any of them needs to be tunable, promoting one to config is a localized change.

## What this model does **not** do (v1)

- no time decay or recency weighting across the training window
- no per-day outlier trimming beyond the coarse sanity band
- no confidence interval or per-slot sample count on factors
- no cross-slot smoothing (adjacent slots' factors are independent)
- no seasonal bucketing (one profile regardless of month)
- no weather features

Each of these is a candidate for a future iteration if v1 under-performs, but none is required to ship v1.

## Explainability hooks

Beyond the v1 minimum required by requirements (`applied`, `effectiveVariant`, `fallbackReason`), the training pipeline can cheaply surface:

- total usable days, total dropped days (with aggregate drop reasons)
- count of neutral vs non-neutral slots
- min/max/median non-neutral factor
- total raw Wh vs total adjusted Wh for the upcoming forecast horizon

These are optional, not contract-level, and can be added as implementation exposes them.

## Recommendation

V1 implements a sum-ratio slot-of-day multiplicative profile on the canonical 15-minute grid, with the day-level and slot-level sanity filters above and a configurable factor clamp (defaults `[0.3, 2.0]`). Day-level and slot-level sanity thresholds stay as implementation constants until real-world data shows they need to be exposed.
