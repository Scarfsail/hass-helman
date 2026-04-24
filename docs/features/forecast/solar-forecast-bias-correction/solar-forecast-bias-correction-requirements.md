# Solar Forecast Bias Correction Requirements

## Status

Requirements for v1 of the solar forecast bias-correction layer. The buildable v1 design — which pins cadence, persistence, the configurable clamp, default values, and UI scope — lives in `solar-forecast-bias-correction-v1-implementation-design.md` and supersedes this doc wherever they overlap.

The selected direction is a **clean-architecture solar forecast bias-correction layer** that:

- preserves the raw upstream solar forecast
- retains raw forecast history for learning
- exposes both raw and adjusted forecast to clients
- uses the adjusted forecast internally when adjustment is available
- keeps weather correlation as an optional later extension, not a v1 dependency

Home Assistant Energy re-exposure of the corrected forecast is tracked separately in `solar-forecast-bias-correction-energy-platform-exposure.md`.

## Problem statement

The upstream solar forecast is often directionally useful, but it can also be systematically wrong in repeatable ways. The goal is not to "beat weather uncertainty" in general. The goal is to reduce the negative impact of **persistent forecast bias** that can be observed by comparing:

- past solar forecast output
- actual solar production

Examples:

- the next-day forecast repeatedly predicts near-ideal production, but real production is consistently much lower
- the upstream source consistently underestimates morning ramp-up or overestimates afternoon production

`hass-helman` should learn those repeatable discrepancies and apply a transparent correction layer to future solar forecast output.

## Desired capabilities

### 1. Preserve the raw forecast

- Keep the current raw upstream solar forecast visible.
- Do not replace the raw source blindly.
- Let users and future UI/debugging surfaces compare raw vs adjusted output directly.

### 2. Learn from retained history

- Retain raw forecast history as a first-class input to the feature.
- Compare retained forecast history against actual solar production from Home Assistant Recorder.
- Learn repeatable correction patterns from that comparison.

### 3. Adjust future forecast output

- Produce an adjusted forecast for future solar points.
- Allow both:
  - **downward** correction when the raw source is repeatedly too optimistic
  - **upward** correction when the raw source is repeatedly too pessimistic

### 4. Keep the feature explainable

- Expose whether adjustment was applied, which variant downstream logic used, and if raw was used, why.
- Keep the adjusted output inspectable rather than opaque.

### 5. Fit the existing forecast pipeline

- Integrate with the existing canonical `15`-minute forecast architecture.
- Avoid forcing battery, grid, appliance projection, and automation consumers to each implement their own solar bias-correction logic.
- Keep one effective internal solar variant for downstream use.

### 6. Support future model evolution

- V1 should not require weather data.
- The design should leave a clean extension point for future weather-aware correction.

## Clarified product decisions

These points were explicitly resolved during refinement:

- The eventual feature should expose **both raw and adjusted** forecast.
- Weather correlation is an **optional extension**, not a v1 requirement.
- Raw forecast history retention is preferred over storing only derived bias stats.
- The algorithm may both downscale and upscale the forecast.
- Minimum history before adjustment becomes active must be **configurable**.
- The initial target default for minimum history is **10 days**.
- The factor clamp bounds must be **configurable** (see model-design).
- The feature must be **enabled by default** on first upgrade.
- Explainability metadata is required (see the explainability section below).

## Verified current codebase boundaries

The design is grounded in the current implementation:

- Solar forecast is built live from `power_devices.solar.forecast.daily_energy_entity_ids` and `wh_period`.
- Solar `actualHistory` currently covers **today so far**, not a retained multi-day solar history.
- There is currently **no persisted historical solar forecast archive**.
- Forecast internals already use a canonical `15`-minute model and aggregate to `15`, `30`, or `60` minute responses.
- Downstream forecast consumers already depend on the solar forecast path:
  - battery forecast
  - grid flow forecast
  - appliance projections
  - automation input bundle / snapshots
- Existing persisted stores currently cover:
  - config
  - one house forecast snapshot
  - schedule
- There is no weather input pipeline in the current forecast stack.

## Relevant touchpoints reviewed

- `custom_components/helman/forecast_builder.py`
- `custom_components/helman/coordinator.py`
- `custom_components/helman/storage.py`
- `custom_components/helman/point_forecast_response.py`
- `custom_components/helman/consumption_forecast_builder.py`
- `custom_components/helman/consumption_forecast_profiles.py`
- `custom_components/helman/consumption_forecast_statistics.py`
- `custom_components/helman/recorder_hourly_series.py`
- `custom_components/helman/battery_capacity_forecast_builder.py`
- `custom_components/helman/appliances/projection_builder.py`
- `custom_components/helman/config_validation.py`
- `custom_components/helman/websockets.py`

## Architecture options considered

### Option A - minimal daily scalar correction

Use one retained raw forecast snapshot per day and compute one daily correction factor from:

- raw forecast total for that day
- actual production total for that day

Apply the same factor to all future points.

**Pros**

- smallest implementation surface
- easiest v1 rollout
- low downstream churn

**Cons**

- only corrects total bias
- does not handle intraday shape errors well
- weaker explainability for slot-specific errors

### Option B - pragmatic slot/daypart bias profile

Retain raw forecast history and learn a bounded slot-of-day or daypart bias profile on the canonical `15`-minute grid. Expose both raw and adjusted variants while keeping one effective internal series.

**Pros**

- strong accuracy/complexity trade-off
- aligns well with current canonical forecast granularity
- minimizes downstream churn

**Cons**

- adds archive/training logic without fully isolating the concern
- can still leave too much feature logic in coordinator/response code

### Option C - clean architecture **(selected direction)**

Introduce a dedicated solar forecast bias-correction layer with explicit modules for:

- forecast-history access
- actual-history access
- training
- adjustment
- response composition
- internal effective-variant selection

Use a slot-of-day multiplicative bias profile for v1, but keep the trainer boundary open for future weather-aware evolution.

**Pros**

- clearest separation of concerns
- easiest long-term evolution
- strongest explainability and inspectability
- reduces risk of coordinator bloat

**Cons**

- larger upfront scope than the minimal approach
- adds a new internal service boundary

## Selected architecture direction

The selected direction is **Option C - clean architecture**.

### Design summary

1. Build the raw solar forecast exactly as today.
2. Normalize it to the canonical `15`-minute form.
3. Read retained raw daily forecast history from Recorder for learning.
4. Query actual production from Recorder for completed historical days.
5. Train a v1 **slot-of-day multiplicative bias profile** from retained raw forecast vs actual production.
6. Produce:
   - raw forecast
   - adjusted forecast
   - explainability metadata
   - one effective internal solar variant used by downstream forecast consumers

### Why this direction was chosen

- It preserves the raw solar builder instead of overloading it with learning logic.
- It matches the repo's pattern of dedicated builders/services around forecast concerns.
- It keeps internal consumers on one effective solar series rather than spreading variant handling across battery, grid, appliance, and automation code.
- It preserves a clean path to later add weather-aware correction without redesigning v1.

## Proposed module boundaries

The feature should live in a dedicated `solar_bias_correction` package so feature-specific learning logic does not leak into `coordinator.py`.

The concrete module layout and per-module responsibilities are defined in `solar-forecast-bias-correction-engine-architecture.md`.

## V1 model requirements

V1 should use a **slot-of-day multiplicative bias profile** over canonical `15`-minute slots. The concrete training formula, numeric bounds, and edge-case handling are defined in `solar-forecast-bias-correction-model-design.md`.

### Required v1 behavior

- Learn from completed historical days only.
- Compare retained raw forecast values against actual production values aligned to the same local slot boundaries.
- Produce a multiplicative factor per canonical slot or slot group.
- Allow both factors below `1.0` and above `1.0`.
- Bound extreme factors to avoid unstable overcorrection.
- Fall back to neutral or coarse-grained behavior when support is weak.

### V1 fallback expectations

- If there is insufficient history, use the raw forecast as the effective internal variant.
- If some historical days are unusable, skip them rather than failing the whole feature.
- If the raw solar forecast is unavailable or not configured, the adjustment layer must not invent synthetic solar data.

## Proposed config direction

The feature should live under the existing solar forecast config branch.

### Suggested shape

```yaml
power_devices:
  solar:
    forecast:
      daily_energy_entity_ids:
        - sensor.energy_production_today
        - sensor.energy_production_tomorrow
      total_energy_entity_id: sensor.solar_energy_total
      bias_correction:
        enabled: true                    # default true
        min_history_days: 10             # default 10
        training_time: "03:00"           # local HH:MM, default "03:00"
        clamp_min: 0.3                   # factor lower bound, default 0.3
        clamp_max: 2.0                   # factor upper bound, default 2.0
```

### Config requirements

- `bias_correction` must be optional.
- `enabled` should control whether the feature is active; default `true`.
- `min_history_days` must be configurable and default to `10`.
- `training_time` must be configurable (local `HH:MM`) and default to `"03:00"`.
- `clamp_min` and `clamp_max` must be configurable (defaults `0.3` / `2.0`) and validation must enforce `clamp_min < clamp_max`.

### Out of scope for v1 config

- weather entity configuration
- multiple model families selected by config
- tunable training-window size (v1 uses a single implementation default; expose only if users need it)
- tuning of the day-level sanity thresholds (`sum_forecast` floor, day-ratio band, per-slot forecast floor) — these remain implementation constants in v1

## Persistence requirements

V1 does not introduce a forecast-history **archive**: historical forecast values are read from Recorder history of the daily forecast entity already consumed by Helman, and actual solar production is read from Recorder via the existing cumulative energy entity.

The **derived bias profile itself** is persisted in Helman's existing `Store` so that restarts and HA reboots do not force retraining on the next inference call. Training runs on a configurable daily schedule; an explicit "Train now" trigger and a training-config fingerprint guard against silent staleness after config edits. Concrete persistence payload, fingerprint, and scheduling rules live in `solar-forecast-bias-correction-v1-implementation-design.md`.

The concrete source selection, normalization, and capture rules for inputs are defined in the **Data inputs** section of `solar-forecast-bias-correction-engine-architecture.md`.

## Response contract requirements

The public response must preserve the raw solar series while making the adjusted output and the effective variant explicit.

Required semantics:

- `solar.points` stays raw upstream.
- An adjusted series must be exposed alongside raw.
- An effective-variant field must tell clients which series downstream Helman logic used.
- If adjustment is not applied, the response must explain why the adjusted variant was not selected.

The concrete payload shape is defined in `solar-forecast-bias-correction-engine-architecture.md`.

## Internal consumption requirements

Downstream forecast consumers should not each implement their own adjustment choice.

### Required internal behavior

- The solar bias-correction service must expose one effective internal solar forecast variant.
- Battery forecast, grid flow forecast, appliance projections, and automation inputs should consume that effective internal variant.
- The public API should still show the raw source series and the adjusted series explicitly.

## Home Assistant re-exposure

Re-exposing the corrected forecast through Home Assistant's official Energy platform is a separate concern. See `solar-forecast-bias-correction-energy-platform-exposure.md`.

The bias-correction design must leave that re-exposure feasible: the corrected forecast must be reachable from a single source of truth so the energy-platform adapter does not need to maintain an independent model.

## Explainability requirements

Explainability is a hard requirement, not a nice-to-have. The response must carry at least:

- whether adjustment was applied
- which variant downstream logic used (raw or adjusted)
- fallback reason when raw was used

Additional detail (model identifier, history day counts, factor summary, raw-vs-adjusted totals) may be added as implementation surfaces them, but is not part of the v1 minimum contract.

The concrete payload shape is defined in `solar-forecast-bias-correction-engine-architecture.md`.

## Weather correlation follow-up

Weather-aware adjustment is intentionally **not required** in v1.

### V1 rule

- V1 must work without weather entities, weather history, or weather forecast ingestion.

### Future requirement

- The trainer boundary should allow a later v2 model to incorporate weather features such as cloud cover, temperature, rain, or similar signals without replacing the v1 foundation.

## Explicitly out of scope for v1

Consolidated from the config and persistence sections above, plus feature-level exclusions:

- mandatory weather integration (also: weather entity configuration)
- ML-heavy or black-box model requirements (also: multiple model families selected by config)
- tunable training-window size (v1 uses a single implementation default)
- any persisted forecast-history archive — duplicated actual solar archive outside Recorder, mandatory Helman-owned forecast archive, or storing every forecast refresh (the persisted **derived profile** is distinct from a forecast-history archive and is in scope)
- frontend-specific visualization requirements beyond payload support (a factor-profile chart is explicitly deferred past v1 even though the `helman/solar_bias/profile` websocket endpoint is exposed)
- backfilling forecast history from before the feature exists
- Helman consumer card changes (the existing forecast card is not modified in v1)

## Suggested implementation order

This high-level ordering reflects the core engine boundary. The full build sequence — including persistence, scheduler, websocket endpoints, and the new Bias Correction tab in the config editor — is pinned in `solar-forecast-bias-correction-v1-implementation-design.md`.

1. Add config constants and validation for `power_devices.solar.forecast.bias_correction`.
2. Add the `solar_bias_correction` package with `models.py`, `forecast_history.py` reading `daily_wh` from Recorder, and `actuals.py` reading completed solar production from Recorder.
3. Add `trainer.py` and `adjuster.py` implementing the v1 slot-of-day bias profile.
4. Add persistence for the derived profile and a daily scheduler that triggers training at the configured local time.
5. Add `service.py` to orchestrate training, adjustment, and effective-variant selection (including fingerprint-based staleness detection).
6. Add `response.py` to compose the public payload (raw + `adjustedPoints` + `biasCorrection` metadata).
7. Add websocket endpoints (`status`, `train_now`, `profile`) and the Bias Correction tab in the config editor panel.
8. Wire coordinator to pass the effective internal solar variant to downstream consumers.
9. Add focused tests for forecast-history, actuals, trainer, adjuster, scheduler, fingerprint staleness, response, websocket handlers, and coordinator wiring.

Home Assistant Energy re-exposure follows once the corrected forecast is stable — see its own doc.

## Future extensions

These are explicitly deferred past v1 but should not be blocked by the v1 design:

- **Home Assistant Energy platform re-exposure** — see `solar-forecast-bias-correction-energy-platform-exposure.md`.
- **Sensor-based Home Assistant re-exposure** — expose corrected forecast sensor entities for dashboards, templates, or integrations that do not use Home Assistant's energy platform. Any such sensors must reuse the same corrected forecast source of truth as other exposures, not maintain a parallel model.
- **Weather-aware correction** — see the "Weather correlation follow-up" section above.

## Summary

The feature should be defined as a **cleanly isolated solar forecast bias-correction layer** on top of the existing solar forecast pipeline. V1 should retain raw forecast history, learn a bounded slot-of-day bias profile from raw-vs-actual comparisons, expose both raw and adjusted forecast, use the adjusted variant internally when available, and keep weather-aware learning as a future extension.
