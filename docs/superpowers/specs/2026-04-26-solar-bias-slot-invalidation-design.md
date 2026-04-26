# Solar bias correction: per-slot training data invalidation

## Problem

When the house battery is near full (e.g. above ~97% SoC) **and** export is disabled, the inverter throttles solar generation: as battery charging power tapers, and with no consumer or grid sink available for the surplus, real solar production drops below the panels' actual potential. These actuals are not representative of true solar capacity, so feeding them into the bias-correction trainer biases the per-slot factors downward and degrades forecast quality on subsequent sunny days.

The trainer today filters at the *day* level (day-forecast floor, daily ratio band) but has no per-slot mechanism to drop polluted samples. We need a way to mark individual 15-minute / forecast-cadence slots on specific dates as "do not use for training" when the throttling conditions held.

## Goals

- Allow the user to opt in to per-slot invalidation of training data with two settings: a maximum SoC threshold and an "export enabled" sensor reference.
- When opted in: at training time, exclude any (date, slot) where the throttling conditions held — both the actual and the forecast contribution are skipped, so the per-slot factor is computed only from clean days.
- Surface invalidation in metadata, the bias-correction status panel, and the visual inspector so the user can verify the feature is doing what they expect.
- Zero overhead and zero behaviour change when the feature is off.
- Keep the editor user-experience aligned with the user-facing description: a sub-section labelled "Invalidate training slot data" containing exactly two fields.

## Non-goals

- Real-time invalidation flagging (recording a "this is being clipped right now" flag during runtime). The design relies entirely on historical recorder queries at training time.
- Modifying the bias-correction *application* (`adjuster.py`). Invalidation is a *training-time* concern only.
- Inferring throttling from solar/inverter telemetry (e.g. comparing inverter output to a theoretical limit). Out of scope.
- Live re-evaluation in the inspector for "today" / future days the trainer has not seen.

## Configuration schema

New sub-object under `power_devices.solar.forecast.bias_correction`:

```yaml
power_devices:
  solar:
    forecast:
      bias_correction:
        # ... existing fields (enabled, min_history_days, training_window_days,
        #     training_time, clamp_min, clamp_max, total_energy_entity_id) ...
        slot_invalidation:
          max_battery_soc_percent: 97
          export_enabled_entity_id: binary_sensor.fve_export_enabled
```

Rules:

- Sub-object is **opt-in**. If absent, training behaves exactly as today; no extra recorder queries are issued.
- All-or-nothing: if `slot_invalidation` is present, both fields are required. Validation error code `incomplete_slot_invalidation` if either is missing.
- `max_battery_soc_percent`: number in `(0, 100]`. Validation error code `invalid_range` otherwise.
- `export_enabled_entity_id`: any HA entity_id; validated via the existing `_validate_optional_entity_id` helper.
- **Battery SoC source is implicit:** the trainer reads the existing live SoC entity at `power_devices.battery.entities.capacity`. If `slot_invalidation` is set but `power_devices.battery.entities.capacity` is not configured, validation emits `missing_prerequisite` with the message "`slot_invalidation` requires `power_devices.battery.entities.capacity` to be configured".

## Invalidation rule

For each (date, forecast slot) pair in the training window the trainer evaluates:

- `peak_soc` = the maximum numeric SoC value observed during the slot, **including the last value at-or-before slot start** (so a slot with no internal state changes inherits its left-edge value).
- `export_off_at_any_moment` = `True` iff at least one observation during the slot has state `"off"`. Same left-edge inheritance applies.

A slot is **invalidated** iff *all* of the following hold:

1. At least one valid (numeric, finite) SoC sample is available for the slot.
2. At least one valid (`"on"` or `"off"`) export-enabled sample is available for the slot.
3. `peak_soc >= max_battery_soc_percent`.
4. `export_off_at_any_moment` is true.

If either signal is missing / unknown / unavailable for the slot, the slot is **not** invalidated. This matches the user's preference for keeping data when the throttling claim cannot be substantiated.

## Data model

`SolarActualsWindow` gains one field:

```python
@dataclass
class SolarActualsWindow:
    slot_actuals_by_date: dict[str, dict[str, float]]
    invalidated_slots_by_date: dict[str, set[str]]   # NEW
```

- Empty for every date when the feature is off.
- Slot keys use the `"HH:MM"` format. **Granularity is the forecast slot granularity** (whatever cadence the forecast uses — typically 15-min or hourly). This is the granularity the trainer loops over in `sorted_forecast_slots`. Note: this can differ from the 15-min cadence used by `slot_actuals_by_date`; when forecast slots are coarser, a single forecast slot covers several 15-min actual sub-slots, and invalidation flags the whole forecast slot together.

`SolarBiasMetadata` gains two fields:

```python
@dataclass
class SolarBiasMetadata:
    # ... existing fields ...
    invalidated_slots_by_date: dict[str, list[str]]   # NEW; sorted lex
    invalidated_slot_count: int                       # NEW; total across window
```

- Empty `{}` and `0` when the feature is off (backward-compatible default).

## Loader logic (`solar_bias_correction/actuals.py`)

The actuals loader is extended:

- If `slot_invalidation` config is absent → return `invalidated_slots_by_date = {}` for every date. No additional recorder queries.
- Otherwise:
  - One additional `state_changes_during_period` call for the battery `capacity` entity over the entire training window.
  - One additional `state_changes_during_period` call for the export-enabled entity over the same window.
  - For each date and each forecast slot in the window, compute `peak_soc` and `export_off_at_any_moment` using the rules above.
  - Apply the invalidation rule; collect invalidated slot keys per date.
- The implementation reuses the existing `recorder_hourly_series` helpers' patterns (executor-job dispatch, lower/upper case fallback for entity ids, left-edge sample inheritance).

## Trainer changes (`solar_bias_correction/trainer.py`)

Inside the per-slot accumulation loop:

```python
for s in usable_samples:
    day_actuals = actuals.slot_actuals_by_date.get(s.date, {})
    invalidated = actuals.invalidated_slots_by_date.get(s.date, set())
    for slot in sorted_forecast_slots:
        if slot in invalidated:
            continue   # skip BOTH forecast and actual contributions
        slot_forecast_sums[slot] += s.slot_forecast_wh.get(slot, 0.0)
        slot_actual_sums[slot] += _aggregate_actuals_into_forecast_slot(
            day_actuals,
            forecast_slot=slot,
            forecast_slot_keys=sorted_forecast_slots,
        )
```

Important: invalidation skips both the forecast and the actual contribution for that (date, slot), so the resulting per-slot factor is computed exclusively from clean days. The existing `_SLOT_FORECAST_SUM_FLOOR_WH` floor still applies — if too many days got invalidated, the slot drops into `omitted_slots` (today's behaviour).

The trainer also populates the new metadata fields:

- `invalidated_slots_by_date`: a copy of the loader's set-of-strings dict turned into sorted lists.
- `invalidated_slot_count`: sum of all per-date list lengths.

## Storage and migration

Bump `SOLAR_BIAS_SUPPORTED_STORE_VERSION` from `1` to `2`. The existing `Store` migration path is extended:

- Reading a v1 store: default `invalidated_slots_by_date` to `{}` and `invalidated_slot_count` to `0`.
- Writing v2: include the new fields.

A unit test covers the migration round-trip.

## Surfaced telemetry

- **Trainer log:** one INFO-level line per training run including total invalidated slot count.
- **`bias_correction` status panel:** new line "Invalidated training slots: N (last training: <ISO timestamp>)", visible whenever `invalidated_slot_count > 0` or the feature is enabled.
- **WebSocket inspector payload:** see next section.

## Visual inspector

### Backend (`solar_bias_correction/response.py` and supporting builders)

`SolarBiasInspectorDay.series` gains a new field:

```python
series.invalidated: list[SolarBiasInspectorPoint]
```

Behaviour:

- The day's actual data points are **partitioned** between two arrays. Each actual point is mapped to its *containing forecast slot* (via the same `forecast_slot_keys` boundaries the trainer uses) and then routed:
  - Containing forecast slot **not** in `invalidated_slots_by_date[date]` → `series.actual` (today's behaviour).
  - Containing forecast slot **in** `invalidated_slots_by_date[date]` → `series.invalidated`, **and removed from `series.actual`**.
- Every actual measurement appears in exactly one of the two arrays — never both, never missing. When forecast slots are coarser than the actuals' cadence, all actual sub-points belonging to an invalidated forecast slot are gray together.
- For "today" or future days where the trainer has not seen them yet, `series.invalidated` is `[]`.

`SolarBiasInspectorAvailability` gains:

```python
has_invalidated: bool
```

True iff `series.invalidated` is non-empty.

The payload exposes the new field as `series.invalidated` (camelCase preserved) and `availability.hasInvalidated`.

### Frontend (`frontend/src/bias-correction-inspector.ts`)

The inspector currently renders actuals as red dots overlaid on the forecast lines. After this change:

- The chart renders **two layers of dots, on the same axis, at identical positions and size** — only the colour differs:
  - `series.actual` → red dot (unchanged).
  - `series.invalidated` → **gray dot** at the same Y position the red dot would have occupied if the slot were valid.
- A gray dot **replaces** the red dot for that slot. Red and gray dots never coexist at the same X coordinate.
- Visually: scanning a day, red dots mark slots that contributed to training; gray dots mark slots that were excluded. Same shape, same size, same Y axis (average power), same positions.
- Legend gains a "Invalidated (excluded from training)" entry with the gray swatch, shown only when `availability.hasInvalidated` is true.
- Tooltip on a gray dot reads: "excluded from training: battery full + export disabled".
- Color: a single muted gray (for example `#9aa0a6`).

### Frontend bundle

Per `custom_components/helman/frontend/CLAUDE.md`, after touching `src/**` we run `npm run build` and commit the updated `dist/helman-config-editor.js` alongside source.

## Editor UI

### Scopes (`frontend/src/config-editor-scopes.ts`)

A new section scope is added under the existing "Bias Correction" scope:

- Id: `section:power_devices.solar.bias_correction.slot_invalidation`
- Parent: `section:power_devices.solar.bias_correction`
- Tab: `power_devices`
- Label key: `editor.sections.bias_correction_slot_invalidation`
- Path adapter: `["power_devices", "solar", "forecast", "bias_correction", "slot_invalidation"]`

### Fields

- `max_battery_soc_percent` — number input, range hint `0–100`, suffix `%`.
- `export_enabled_entity_id` — entity picker.

### Translations (`frontend/src/localize/translations/en.json`)

New keys (mirrored to other locales currently shipped):

- `editor.sections.bias_correction_slot_invalidation` — "Invalidate training slot data"
- `bias_correction_slot_invalidation_max_battery_soc_percent` — "Max battery SoC (%)"
- `bias_correction_slot_invalidation_export_enabled_entity_id` — "Export enabled sensor"
- Description keys explaining the rationale: when battery is near full and export is disabled, the inverter throttles solar generation; readings during such slots are not representative and should be excluded from training.

## Validation (`config_validation.py`)

A new block under `bias_correction` validation:

- If `slot_invalidation` mapping is present:
  - If `max_battery_soc_percent` or `export_enabled_entity_id` is missing → error code `incomplete_slot_invalidation`.
  - `max_battery_soc_percent` must be a number with `0 < x <= 100` → error codes `invalid_type` / `invalid_range`.
  - `export_enabled_entity_id` validated via `_validate_optional_entity_id`.
  - Prerequisite: if `power_devices.battery.entities.capacity` is missing or unset → error code `missing_prerequisite` with the message "`slot_invalidation` requires `power_devices.battery.entities.capacity` to be configured".

## Testing strategy

### Trainer unit tests (`tests/solar_bias_correction/test_trainer.py` or equivalent)

- Slot invalidation off → factors identical to existing baseline.
- One date's slot invalidated → that (date, slot) contributes nothing; the slot's factor is computed from the remaining clean days.
- All days invalidated for a given slot → slot ends up in `omitted_slots` via the existing forecast-floor mechanism.
- `invalidated_slots_by_date` and `invalidated_slot_count` populated correctly in metadata.
- Mixed: some slots invalidated, others not, on the same day → per-slot independence.

### Actuals loader tests (`tests/solar_bias_correction/test_actuals.py` or equivalent)

- Peak-SoC computation: left-edge inheritance for slots with no internal state changes; max-within-slot honoured.
- "Export off at any moment": single `"off"` sample triggers; slot-start state inherited from prior state change.
- Sensor unknown / unavailable / missing → slot **not** invalidated (option C semantics).
- Battery prerequisite missing at runtime → loader logs and treats invalidation as off; no crash.
- No additional recorder queries are issued when feature is off.

### Validation tests (`tests/test_config_validation.py`)

- Partial config (only one of the two fields) → `incomplete_slot_invalidation`.
- `max_battery_soc_percent` out of range or non-numeric → `invalid_range` / `invalid_type`.
- Slot invalidation set but battery `capacity` missing → `missing_prerequisite`.
- Valid config passes.

### Inspector payload tests (`tests/solar_bias_correction/test_inspector.py` or equivalent)

- With invalidated slots: `series.actual` and `series.invalidated` partition the actual points.
- Day with no invalidations: `series.invalidated == []`, `availability.has_invalidated == False`.
- Today / future days: `series.invalidated == []` regardless of trainer metadata.

### Storage migration test

- v1 store loads with empty new fields. Round-tripping via v2 preserves them.

### Frontend

Rely on existing TypeScript build / linting; no test infrastructure change.

## Rollout / compatibility

- Feature is opt-in; existing users see no change until they configure `slot_invalidation`.
- Storage version bump (1 → 2) is forward-only; v1 stores are migrated transparently on load.
- No changes to forecast application; existing inspectors and downstream consumers see the new `series.invalidated` field as additive.

## Open questions

None at this stage; this design doc supersedes prior brainstorming exchange.
