# Solar Forecast Bias Correction - V1 Implementation Design

## Status

Implementation-ready v1 design. Pins the brainstorming outcomes from 2026-04-24 on top of the existing companion docs in this folder:

- `solar-forecast-bias-correction-idea.md` — original motivation
- `solar-forecast-bias-correction-requirements.md` — product requirements
- `solar-forecast-bias-correction-engine-architecture.md` — module boundaries and integration seam
- `solar-forecast-bias-correction-model-design.md` — algorithmic pin
- `solar-forecast-bias-correction-energy-platform-exposure.md` — deferred stub

This document is the **buildable** spec: where the earlier docs left choices open or deliberately out of scope, this one commits. It supersedes those docs only where explicitly called out in the "Deltas vs. earlier docs" section. Everything else — algorithm, explainability, response contract, deferrals — remains as written there.

## Goal

Ship v1 of a cleanly isolated solar forecast bias-correction layer on top of the existing Helman forecast pipeline. The layer learns repeatable slot-of-day bias from retained raw-vs-actual history, produces an adjusted forecast when confidence is sufficient, and makes that decision explicit both in the public forecast response and through a dedicated tab in the existing Helman config editor panel.

## Non-goals

- weather-aware correction
- Home Assistant Energy platform re-exposure
- sensor-entity re-exposure of the corrected forecast
- the Helman consumer card / forecast visualization UI
- in-sample auto-learning of hyperparameters
- a factor-profile chart in the config panel (endpoint is exposed; UI deferred)

## Deltas vs. earlier docs

v1 introduces these concrete choices on top of the companion docs:

| # | Delta | Supersedes |
|---|---|---|
| 1 | Default `min_history_days` is `10` (was `14`) | requirements.md §Clarified product decisions, model-design.md §Parameter table |
| 2 | Factor clamp `clamp_min` / `clamp_max` is **configurable** (defaults `0.3` / `2.0`) | model-design.md §Parameter table: "hardcoded v1" for the clamp |
| 3 | Trained profile is **persisted** to Helman `Store` | requirements.md §Persistence requirements; engine-architecture.md §Persistence boundary: "learned bias factors remain derived rather than durable truth" |
| 4 | Training runs once per day at a **configurable local time** (default `03:00`) with an explicit **"Train now"** trigger | earlier docs left cadence open |
| 5 | Config-change detection via a **training-config fingerprint**; stale profiles are flagged and **not applied** | new in v1 |
| 6 | Feature is **enabled by default** | earlier docs left default open |
| 7 | v1 ships a new top-level **"Bias Correction" tab** in the existing custom config editor panel (`custom_components/helman/frontend/`), including status readout and "Train now" | new in v1 |
| 8 | Same-day day-start capture (Option A) remains the v1 choice | reaffirms engine-architecture.md §Capture-selection rule |

## Config surface

### YAML shape

Extends the existing solar forecast config branch per requirements.md.

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
        clamp_min: 0.3                   # default 0.3
        clamp_max: 2.0                   # default 2.0
```

### Validation rules

Enforced in `config_validation.py`:

- `enabled`: bool, default `true`.
- `min_history_days`: int, `[1, 365]`, default `10`.
- `training_time`: `HH:MM` string, local time, default `"03:00"`.
- `clamp_min`: float, `(0, 1]`, default `0.3`.
- `clamp_max`: float, `[1, 10]`, default `2.0`.
- `clamp_min < clamp_max` — required; validation error if violated.

### Training-config fingerprint

SHA-256 of the tuple `(min_history_days, clamp_min, clamp_max)`. These are the config values that change the *learned output* of a training run.

- `training_time` is excluded — it only affects scheduler timing, not the profile.
- `enabled` is excluded — flipping off then on should reuse a still-valid profile if the fingerprint still matches.

On coordinator init and on every config change, recompute the fingerprint and compare against the one embedded in the persisted profile metadata. Mismatch ⇒ profile is **stale**: not applied at inference, flagged in the status readout.

## Backend package layout

New package: `custom_components/helman/solar_bias_correction/`

| Module | Responsibility | Key exports |
|---|---|---|
| `models.py` | Dataclasses: `TrainerSample`, `SolarActualsWindow`, `SolarBiasProfile`, `SolarBiasExplainability`, `SolarBiasAdjustmentResult`, `TrainingOutcome` | dataclasses |
| `forecast_history.py` | Read historical `sensor.energy_production_today` states from Recorder, reconstruct `wh_period` per past day, normalize to canonical 15-min `TrainerSample` list. Implements Option A capture rule (first state after local midnight per past day). | `async load_trainer_samples(hass, cfg, now)` |
| `actuals.py` | Read per-slot actuals from Recorder deltas of `total_energy_entity_id`. Returns `SolarActualsWindow` aligned to local 15-min slots. | `async load_actuals_window(hass, cfg, days)` |
| `trainer.py` | Pure function. Takes normalized samples + actuals + config, returns `SolarBiasProfile` or a fallback outcome. Implements model-design.md exactly. No I/O. | `train(samples, actuals, cfg) -> TrainingOutcome` |
| `adjuster.py` | Pure function. Apply profile factors to raw points, preserve raw series, clamp non-negative. | `adjust(raw_points, profile) -> adjusted_points` |
| `scheduler.py` | HA-aware "fire training at configured local time-of-day" scheduler. Uses `async_track_time_change`. Handles reschedule on config change and cancel on teardown. | `SolarBiasTrainingScheduler` |
| `service.py` | Orchestration. Wires history + actuals + trainer + store. Produces `SolarBiasAdjustmentResult` for request-time use. Owns the "train now" entry point. Emits `helman_solar_bias_trained` on completion. | `SolarBiasCorrectionService` |
| `response.py` | Compose the public payload (`solar.adjustedPoints`, `solar.biasCorrection`) on top of the existing `solar` response. | `compose_solar_bias_response` |
| `websocket.py` | Three websocket handlers (see §WebSocket endpoints). Thin layer over `service`. | `async_register_websocket_handlers` |

### Touchpoints in existing code

- `storage.py` — add `SolarBiasCorrectionStore` (HA `Store` v1, key `helman_solar_bias_correction`).
- `coordinator.py` — wire service + scheduler into setup and teardown; pass effective variant downstream.
- `config_validation.py` — add `bias_correction` subtree validation.
- `websockets.py` — register new handlers via the package's `async_register_websocket_handlers`.
- `__init__.py` — instantiate service + scheduler during integration setup; dispose on teardown.

### Persisted profile payload

```json
{
  "version": 1,
  "profile": {
    "08:00": 1.12,
    "08:15": 1.09
  },
  "metadata": {
    "trained_at": "2026-04-24T03:00:04+02:00",
    "training_config_fingerprint": "sha256:…",
    "usable_days": 12,
    "dropped_days": [
      {"date": "2026-04-12", "reason": "day_ratio_out_of_band"}
    ],
    "factor_min": 0.41,
    "factor_max": 1.87,
    "factor_median": 1.04,
    "omitted_slot_count": 68,
    "last_outcome": "profile_trained"
  }
}
```

`last_outcome` is one of: `"profile_trained"`, `"insufficient_history"`, `"no_training_yet"`, `"training_failed"`.

### Pure-vs-I/O split

`trainer` and `adjuster` are pure functions. All Recorder I/O lives in `forecast_history` and `actuals`. All persistence lives in `storage.py`. `service` is the only module that composes them. This keeps the model and adjuster trivially unit-testable without Recorder or Store mocks.

## Runtime shape

### On integration setup / HA startup

1. Load persisted profile + metadata from `SolarBiasCorrectionStore`.
2. Compute the current training-config fingerprint from validated config.
3. Decide initial state:
   - No stored profile ⇒ `last_outcome: "no_training_yet"`, effective variant at inference = raw.
   - Fingerprint mismatch ⇒ stored profile marked **stale**, not applied; effective variant = raw; fallback reason = `"config_changed_pending_retrain"`.
   - Fingerprint match ⇒ profile is active; used at inference.
4. `SolarBiasTrainingScheduler` registers `async_track_time_change` at the configured `training_time` (local). No training kicks off on startup — the scheduler fires at the next configured time.

### On scheduled training run

1. Call `forecast_history.load_trainer_samples` — reconstruct per-past-day day-start captures from Recorder history of `sensor.energy_production_today`.
2. Call `actuals.load_actuals_window` — Recorder deltas of `total_energy_entity_id` aligned to local 15-min slots.
3. Call pure `trainer.train(samples, actuals, cfg)` ⇒ `TrainingOutcome`.
4. Persist profile + metadata (fresh `trained_at`, fresh fingerprint). Persist even when outcome is fallback so the status UI can show what happened.
5. Fire HA event `helman_solar_bias_trained`.
6. If training throws, persist `last_outcome: "training_failed"` with an error reason but **preserve the previously valid profile** in the `profile` field. The system keeps applying the older correction (better than falling back to raw for a transient Recorder glitch).

### On "Train now" websocket call

Same code path as the scheduled run, triggered immediately:

- Rejects if training is already in progress (`training_in_progress` error).
- Rejects if `bias_correction.enabled` is `false` (`bias_correction_not_configured` error) — respects the enabled flag.
- Returns the fresh `/status` payload synchronously after completion (typically <5 s).

### On config change (YAML reload or panel save)

1. Re-validate config.
2. Recompute fingerprint. If it differs from the stored profile's, mark stale in memory; leave the stored profile untouched on disk.
3. Cancel the existing scheduler timer; reschedule at the new `training_time` if it changed.
4. If `enabled` flipped false→true and the stored fingerprint still matches ⇒ the profile becomes active at inference again. If true→false ⇒ profile stays in storage, just isn't applied.

### Request-time flow (`helman/get_forecast`)

1. Coordinator builds raw solar forecast as today (unchanged).
2. Coordinator calls `service.build_adjustment_result(raw_solar, now)`.
3. Service uses the in-memory profile (loaded once from Store) and `adjuster` to produce adjusted points. No Recorder hit at inference.
4. Coordinator derives the effective internal variant:
   - `enabled=false` ⇒ raw, fallback `"disabled"`.
   - Stale ⇒ raw, fallback `"config_changed_pending_retrain"`.
   - No profile yet ⇒ raw, fallback `"no_training_yet"` or `"insufficient_history"` (whichever matches `last_outcome`).
   - Otherwise ⇒ adjusted.
5. Effective variant flows into battery / grid / appliance / automation consumers as the single solar series they read today (no per-consumer variant choice).
6. Public forecast payload carries raw `.points`, `.adjustedPoints`, and `.biasCorrection` metadata.

### Caching

Profile is held in memory on the service instance. First load happens at integration setup; subsequent loads happen only after a training run completes (which writes and then reloads). No Recorder work during inference.

## Public response contract

### Existing (unchanged)

```json
"solar": {
  "points": [ {"timestamp": "...", "valueWh": …}, … ],
  "actualHistory": [ … ]
}
```

### v1 additions

```json
"solar": {
  "points": [ … ],
  "actualHistory": [ … ],
  "adjustedPoints": [ … ],
  "biasCorrection": {
    "status": "applied",
    "effectiveVariant": "adjusted",
    "explainability": {
      "fallbackReason": null,
      "trainedAt": "2026-04-24T03:00:04+02:00",
      "usableDays": 12,
      "droppedDays": 2,
      "omittedSlotCount": 68,
      "factorSummary": { "min": 0.41, "max": 1.87, "median": 1.04 }
    }
  }
}
```

### `status` values

| Value | `effectiveVariant` | Meaning |
|---|---|---|
| `"applied"` | `"adjusted"` | Profile present, fingerprint match, applied |
| `"disabled"` | `"raw"` | `bias_correction.enabled = false` |
| `"no_training_yet"` | `"raw"` | Never trained |
| `"insufficient_history"` | `"raw"` | Last training returned fallback due to too few usable days |
| `"config_changed_pending_retrain"` | `"raw"` | Fingerprint mismatch — stored profile not applied |
| `"training_failed"` | `"raw"` | Last training threw; error reason in `explainability.error` |

### `adjustedPoints` population

Always populated. When `effectiveVariant = "raw"`, `adjustedPoints` mirrors `points` (raw values). This keeps downstream client code branch-free. The single variant decision lives in `effectiveVariant`.

### Granularity aggregation

`point_forecast_response.py` aggregates canonical 15-min points to the requested granularity (15/30/60). `adjustedPoints` goes through the **same** aggregation path — Wh sums per bucket — so both series stay consistent.

`biasCorrection` metadata is flat and does not aggregate.

### Internal effective variant

Coordinator passes one solar series to downstream forecast consumers (battery, grid, appliances, automation). The per-request variant selection is a single decision made by `service`; consumers continue reading `solar_forecast["points"]`-shaped input and remain unaware of the variant.

### Backwards compatibility

Clients reading only `solar.points` see raw values, unchanged from today. New fields are additive. The existing Helman consumer card remains functional without modification.

## WebSocket endpoints

Registered via `solar_bias_correction/websocket.py` and wired into `websockets.py`.

### `helman/solar_bias/status` — read

Lightweight; intended for polling by the config panel. Panel polls every 10 s while the Bias Correction tab is visible; stops on tab hide.

```json
{
  "enabled": true,
  "status": "applied",
  "effectiveVariant": "adjusted",
  "trainedAt": "2026-04-24T03:00:04+02:00",
  "nextScheduledTrainingAt": "2026-04-25T03:00:00+02:00",
  "trainingConfigFingerprint": "sha256:…",
  "isStale": false,
  "lastOutcome": "profile_trained",
  "fallbackReason": null,
  "usableDays": 12,
  "droppedDays": [
    {"date": "2026-04-12", "reason": "day_ratio_out_of_band"}
  ],
  "omittedSlotCount": 68,
  "factorSummary": { "min": 0.41, "max": 1.87, "median": 1.04 }
}
```

`droppedDays` here is **per-day** (unlike the forecast response's count-only form) — this endpoint is panel-facing.

### `helman/solar_bias/train_now` — action

- Rejects with `training_in_progress` if another training run is ongoing.
- Rejects with `bias_correction_not_configured` if `enabled = false`.
- Otherwise runs training on the same code path as the scheduler and returns the fresh `/status` payload synchronously.
- Fires `helman_solar_bias_trained` on completion.

### `helman/solar_bias/profile` — read

On-demand, not polled.

```json
{
  "trainedAt": "2026-04-24T03:00:04+02:00",
  "factors": { "08:00": 1.12, "08:15": 1.09 },
  "omittedSlots": ["00:00", "00:15"]
}
```

Omitted slots are listed separately so `factors` stays uniformly numeric.

### Error codes

Standard HA websocket error envelope:

| Code | When |
|---|---|
| `bias_correction_not_configured` | `train_now` while `enabled = false` |
| `training_in_progress` | Concurrent `train_now` |
| `no_profile` | `/profile` before any training run completed |
| `internal_error` | Unexpected exception (logged server-side) |

## Config editor panel — Bias Correction tab

The existing Helman custom config editor (Lit-based, in `custom_components/helman/frontend/`) gets a new top-level tab.

### Scope changes in `config-editor-scopes.ts`

Add to `TabId`:

```ts
export type TabId =
  | "general" | "power_devices" | "scheduler"
  | "automation" | "appliances"
  | "bias_correction";
```

Add to `ScopeId`:

```ts
| "tab:bias_correction"
| "section:bias_correction.settings"
```

Tab icon: distinct from the existing `power_devices.solar` sun icon — e.g. a curve/chart MDI icon to convey "correction curve". Placement in the `TABS` array: after `appliances`.

### Scope adapter

Projection scope over the nested config path:

```ts
documentPath: ["power_devices", "solar", "forecast", "bias_correction"]
```

All five config fields surface at the tab level via `createProjectionScopeAdapter`. YAML stays nested at `power_devices.solar.forecast.bias_correction.*`.

### Tab layout

Single page, no sub-tabs. Two vertical regions:

1. **Config form** — standard visual/YAML editor for the five fields (enabled toggle, min_history_days numeric, training_time HH:MM, clamp_min numeric, clamp_max numeric).
2. **Status block** — Lit component below the form:
   - Current status with color cue (green for `applied`, yellow for `config_changed_pending_retrain`, red for `training_failed`, neutral for the others).
   - Effective variant.
   - Last trained at; next scheduled training at.
   - Fingerprint match indicator.
   - Usable / dropped day counts; factor range (min–max, median).
   - **Train now** button (disabled during in-flight call; spinner while running; refreshes on response).
   - Stale banner when `isStale` is true: "Config changed since last training. Click 'Train now' or wait for the next scheduled run."
   - Collapsible "Dropped days" list when `droppedDays.length > 0`.

### Data flow

- Config fields: existing YAML round-trip — no new wiring, only the new adapter.
- Status block: subscribes to `helman/solar_bias/status` via the existing websocket wrapper. Polls every 10 s while the tab is visible.
- Train-now button: calls `helman/solar_bias/train_now`. Response replaces the status payload in one round-trip.
- Profile endpoint: **not consumed in v1** — exposed for future chart UI.

### Localization

New strings under these keys (follow the existing `localize` folder convention):

- `editor.tabs.bias_correction`
- `editor.sections.bias_correction_settings`
- `editor.fields.bias_correction.*` (the five config fields)
- `bias_correction.status.*` (labels, status values, banner text, dropped-days reasons)
- `bias_correction.actions.train_now` (and its states: idle / in_progress / success / error)

### Bundle

Per `custom_components/helman/frontend/CLAUDE.md`: run `npm run build` in the frontend directory after changes and commit `dist/helman-config-editor.js` alongside source.

## Failure-mode summary

| Failure | Response |
|---|---|
| Training throws (Recorder unavailable, etc.) | Persist `last_outcome: "training_failed"` with reason string; keep previously valid profile on disk; status block shows red. |
| No history returned (fresh install, short retention) | `last_outcome: "insufficient_history"`; fall back to raw; status shows the count so the user understands the gate. |
| Persisted store has a newer `version` than code supports | Refuse to load; treat as `no_training_yet`; schedule fresh training. |
| `total_energy_entity_id` or `daily_energy_entity_ids` missing at training time | `last_outcome: "training_failed"`, reason `"solar_entities_unavailable"`. |
| `train_now` hits while scheduler is running | Returns `training_in_progress` immediately; no concurrency. |

## Locked invariants

All invariants from engine-architecture.md §Locked invariants continue to hold. v1 adds:

- The persisted profile is the **only** source of truth for the in-memory factor map. Memory state is a cache, not a fork.
- A profile with a mismatched fingerprint is **never applied** at inference.
- A failed training run **does not** overwrite the previously valid profile's factor data — only its metadata fields flip to record the failure.
- `train_now` must respect the `enabled` flag — disabled ⇒ reject, not silent success.
- The coordinator is the single place that decides the effective variant; downstream consumers never know which they received.

## Out of scope for v1 (explicit)

Beyond the feature-level exclusions already listed in requirements.md §Explicitly out of scope for v1, this v1 also excludes:

- weather-aware correction (deferred)
- Home Assistant Energy platform re-exposure (deferred — see its own stub doc)
- factor-profile chart in the config panel (endpoint exposed, UI deferred)
- per-day forecast-vs-actual comparison view
- manual editing of per-slot factors
- in-sample auto-learning of hyperparameters
- Helman consumer card changes

## Suggested implementation sequence

1. **Config + validation.** Add `bias_correction` subtree to `config_validation.py`. Update `const.py` if needed. Unit tests.
2. **Persistence.** Add `SolarBiasCorrectionStore` to `storage.py` with versioned schema. Unit tests for roundtrip and version gating.
3. **Pure algorithm core.** Ship `models.py`, `trainer.py`, `adjuster.py` with unit tests derived directly from model-design.md examples. No I/O.
4. **Recorder adapters.** Ship `forecast_history.py` and `actuals.py` with integration tests against a stubbed Recorder.
5. **Service + scheduler.** Ship `service.py` and `scheduler.py`. Wire into `__init__.py` and `coordinator.py`. Integration tests for startup, scheduled fire, train-now, stale detection.
6. **Response composition.** Ship `response.py`. Wire into coordinator response assembly. Tests for each `status` value and for aggregation to 15/30/60-min granularity.
7. **Downstream wiring.** Change coordinator to pass the effective variant into battery/grid/appliance/automation consumers. Regression tests for each consumer.
8. **WebSocket endpoints.** Ship `websocket.py`. Tests for each handler including error codes.
9. **Frontend tab.** Add scope + localization + status Lit component + Train now button. `npm run build`; commit bundle.
10. **End-to-end tests.** Scenarios: fresh install, enabled-by-default first forecast, first scheduled training, train-now, config change → stale → retrain, training_failed with prior valid profile preserved.

Each step is independently mergeable behind the shipped default `enabled: true` because without a persisted profile the service returns raw with `status: "no_training_yet"`.

## Recommendation

V1 ships as a cleanly isolated layer in `solar_bias_correction/`, drives training on a configurable daily schedule with explicit "Train now" control, persists the derived profile with a training-config fingerprint that guards against silent staleness, and surfaces everything — config, status, and trigger — through a dedicated Bias Correction tab in the existing custom config editor panel. The earlier docs in this folder remain authoritative for the algorithm, response contract, and long-term roadmap (weather-aware, Energy platform re-exposure); this document pins the eight v1 deltas that make them buildable.
