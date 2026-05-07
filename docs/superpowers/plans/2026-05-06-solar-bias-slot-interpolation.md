# Solar Bias Slot Interpolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a linear-interpolation fallback to the solar bias trainer so that slots failing the `min_valid_slot_days` gate are filled from neighboring healthy slots when the failing run is short enough, instead of being omitted (and silently corrected with a factor of 1.0 by the adjuster).

**Architecture:** All work is in the bias trainer. After the existing per-slot loop produces `factors` and `omitted_slots`, a new pass groups slots omitted with reason `slot_insufficient_valid_days` into runs of consecutive entries in `sorted_forecast_slots`. Runs of length ≤ `max_interpolated_consecutive_slots` are linearly interpolated between the nearest preceding/following healthy slots from a snapshot of `factors` (edge anchors default to `0.0`). Interpolated values are NOT re-clamped. Metadata gains an `interpolated_slot_count`, and the per-slot explainability gains `interpolated`/`interpolation_anchors` plus a synthetic contribution row.

**Tech Stack:** Python 3.12+, dataclasses, pytest. Module: `custom_components/helman/solar_bias_correction/trainer.py` and its sibling `models.py`. Tests in `tests/test_solar_bias_trainer.py`.

**Spec:** `docs/superpowers/specs/2026-05-06-solar-bias-slot-interpolation-design.md`

---

## File Structure

- **Modify** `custom_components/helman/const.py` — add `SOLAR_BIAS_DEFAULT_MAX_INTERPOLATED_CONSECUTIVE_SLOTS`.
- **Modify** `custom_components/helman/solar_bias_correction/models.py`
  - Add `max_interpolated_consecutive_slots: int` field to `BiasConfig` (with default).
  - Add `interpolated_slot_count: int` field to `SolarBiasMetadata`.
  - Add `interpolated: bool` and `interpolation_anchors: tuple[str | None, str | None] | None` to `SolarBiasSlotExplainability`.
  - Extend `read_bias_config` to parse the new key from YAML.
  - Extend `training_explainability_to_payload` to surface the new fields.
- **Modify** `custom_components/helman/solar_bias_correction/trainer.py`
  - Add `max_interpolated_consecutive_slots=...` to the `compute_fingerprint` payload.
  - Add `_interpolate_omitted_slots(...)` helper.
  - Call it in `train()` after the per-slot loop and before metadata/explainability assembly.
  - Pass interpolation results into `_build_training_explainability` so synthetic rows can be appended.
- **Modify** `tests/test_solar_bias_trainer.py` — extend the `make_cfg` helper and add new tests.

---

### Task 1: Add the new constant and config field

**Files:**
- Modify: `custom_components/helman/const.py`
- Modify: `custom_components/helman/solar_bias_correction/models.py`

- [ ] **Step 1: Write the failing test for the new BiasConfig field**

Add to `tests/test_solar_bias_trainer.py` (place near the other fingerprint/config tests):

```python
def test_bias_config_defaults_max_interpolated_consecutive_slots_to_two():
    cfg = make_cfg()
    assert cfg.max_interpolated_consecutive_slots == 2


def test_read_bias_config_parses_max_interpolated_consecutive_slots():
    from custom_components.helman.solar_bias_correction.models import read_bias_config

    cfg = read_bias_config(
        {
            "power_devices": {
                "solar": {
                    "forecast": {
                        "bias_correction": {
                            "max_interpolated_consecutive_slots": 4,
                        }
                    }
                }
            }
        }
    )
    assert cfg.max_interpolated_consecutive_slots == 4


def test_read_bias_config_max_interpolated_defaults_when_missing():
    from custom_components.helman.solar_bias_correction.models import read_bias_config

    cfg = read_bias_config({})
    assert cfg.max_interpolated_consecutive_slots == 2
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_solar_bias_trainer.py -k "max_interpolated" -v`
Expected: FAIL — `BiasConfig` has no field `max_interpolated_consecutive_slots`, and the helper `make_cfg` doesn't set it.

- [ ] **Step 3: Add the constant**

In `custom_components/helman/const.py`, after line 67 (after `SOLAR_BIAS_DEFAULT_AGGREGATION_METHOD`):

```python
SOLAR_BIAS_DEFAULT_MAX_INTERPOLATED_CONSECUTIVE_SLOTS = 2
```

- [ ] **Step 4: Add the field to BiasConfig**

In `custom_components/helman/solar_bias_correction/models.py`:

Update the import block (top of file) to include the new constant:

```python
from ..const import (
    SOLAR_BIAS_DEFAULT_ENABLED,
    SOLAR_BIAS_DEFAULT_MIN_HISTORY_DAYS,
    SOLAR_BIAS_DEFAULT_MAX_TRAINING_WINDOW_DAYS,
    SOLAR_BIAS_DEFAULT_TRAINING_TIME,
    SOLAR_BIAS_DEFAULT_CLAMP_MIN,
    SOLAR_BIAS_DEFAULT_CLAMP_MAX,
    SOLAR_BIAS_DEFAULT_MIN_VALID_SLOT_DAYS,
    SOLAR_BIAS_DEFAULT_AGGREGATION_METHOD,
    SOLAR_BIAS_DEFAULT_MAX_INTERPOLATED_CONSECUTIVE_SLOTS,
)
```

Add the field to `BiasConfig` (after `aggregation_method`):

```python
@dataclass
class BiasConfig:
    enabled: bool
    min_history_days: int
    training_time: str
    clamp_min: float
    clamp_max: float
    daily_energy_entity_ids: list[str]
    total_energy_entity_id: str | None
    min_valid_slot_days: int = SOLAR_BIAS_DEFAULT_MIN_VALID_SLOT_DAYS
    aggregation_method: str = SOLAR_BIAS_DEFAULT_AGGREGATION_METHOD
    max_interpolated_consecutive_slots: int = (
        SOLAR_BIAS_DEFAULT_MAX_INTERPOLATED_CONSECUTIVE_SLOTS
    )
    slot_invalidation_max_battery_soc_percent: float | None = None
    slot_invalidation_export_enabled_entity_id: str | None = None
    slot_invalidation_data_glitch_max_slot_wh: float | None = None
    slot_invalidation_data_glitch_min_neighbour_forecast_wh: float = 200.0
    slot_invalidation_data_glitch_backfill_max_minutes: int = 120
    max_training_window_days: int = SOLAR_BIAS_DEFAULT_MAX_TRAINING_WINDOW_DAYS
```

- [ ] **Step 5: Parse the new key in `read_bias_config`**

In `custom_components/helman/solar_bias_correction/models.py`, inside `read_bias_config`, after the `aggregation_method = bias.get(...)` line and before `slot_invalidation = bias.get("slot_invalidation") or {}`:

```python
    raw_max_interp = bias.get(
        "max_interpolated_consecutive_slots",
        SOLAR_BIAS_DEFAULT_MAX_INTERPOLATED_CONSECUTIVE_SLOTS,
    )
    max_interpolated_consecutive_slots = (
        SOLAR_BIAS_DEFAULT_MAX_INTERPOLATED_CONSECUTIVE_SLOTS
    )
    if isinstance(raw_max_interp, (int, float)) and not isinstance(raw_max_interp, bool):
        max_interpolated_consecutive_slots = max(0, int(raw_max_interp))
```

Then in the `BiasConfig(...)` return at the bottom, add:

```python
        max_interpolated_consecutive_slots=max_interpolated_consecutive_slots,
```

(place it next to `aggregation_method=aggregation_method,`).

- [ ] **Step 6: Run the new tests to verify they pass**

Run: `pytest tests/test_solar_bias_trainer.py -k "max_interpolated" -v`
Expected: PASS (3 tests).

- [ ] **Step 7: Run the full trainer suite to verify nothing else broke**

Run: `pytest tests/test_solar_bias_trainer.py -v`
Expected: All existing tests still pass (the new field has a default, so older callers are unaffected).

- [ ] **Step 8: Commit**

```bash
git add custom_components/helman/const.py \
        custom_components/helman/solar_bias_correction/models.py \
        tests/test_solar_bias_trainer.py
git commit -m "feat(solar-bias): add max_interpolated_consecutive_slots config"
```

---

### Task 2: Include the new field in the fingerprint

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/trainer.py:29-54`
- Modify: `tests/test_solar_bias_trainer.py`

- [ ] **Step 1: Write a failing fingerprint test**

Add to `tests/test_solar_bias_trainer.py` near the other fingerprint tests:

```python
def test_fingerprint_differs_when_max_interpolated_consecutive_slots_changes():
    cfg_a = make_cfg()
    cfg_a.max_interpolated_consecutive_slots = 2
    cfg_b = make_cfg()
    cfg_b.max_interpolated_consecutive_slots = 3
    assert trainer.compute_fingerprint(cfg_a) != trainer.compute_fingerprint(cfg_b)


def test_fingerprint_zero_max_interpolated_matches_payload_includes_value():
    cfg = make_cfg()
    cfg.max_interpolated_consecutive_slots = 0
    fp = trainer.compute_fingerprint(cfg)
    # Sanity: deterministic format from existing contract
    assert fp.startswith("sha256:")
```

- [ ] **Step 2: Run to verify the differs test fails**

Run: `pytest tests/test_solar_bias_trainer.py -k "fingerprint_differs_when_max_interpolated" -v`
Expected: FAIL — current `compute_fingerprint` ignores the new field, so both fingerprints are identical.

- [ ] **Step 3: Update `compute_fingerprint`**

In `custom_components/helman/solar_bias_correction/trainer.py`, modify the `payload` string in `compute_fingerprint` to add the new field at the end (do NOT change ordering of existing fields — algorithm version unchanged because legacy behavior is reproduced when `max_interpolated_consecutive_slots=0` AND existing default is `2`, so we accept that re-training will trigger once on rollout). Replace:

```python
    payload = (
        f"algo={_ALGORITHM_VERSION};"
        f"min_history_days={cfg.min_history_days};"
        f"clamp_min={cfg.clamp_min};"
        f"clamp_max={cfg.clamp_max};"
        f"min_valid_slot_days={cfg.min_valid_slot_days};"
        f"aggregation_method={cfg.aggregation_method};"
        "slot_invalidation_max_battery_soc_percent="
        f"{cfg.slot_invalidation_max_battery_soc_percent};"
        "slot_invalidation_export_enabled_entity_id="
        f"{cfg.slot_invalidation_export_enabled_entity_id};"
        "slot_invalidation_data_glitch_max_slot_wh="
        f"{cfg.slot_invalidation_data_glitch_max_slot_wh};"
        "slot_invalidation_data_glitch_min_neighbour_forecast_wh="
        f"{cfg.slot_invalidation_data_glitch_min_neighbour_forecast_wh};"
        "slot_invalidation_data_glitch_backfill_max_minutes="
        f"{cfg.slot_invalidation_data_glitch_backfill_max_minutes}"
    )
```

with:

```python
    payload = (
        f"algo={_ALGORITHM_VERSION};"
        f"min_history_days={cfg.min_history_days};"
        f"clamp_min={cfg.clamp_min};"
        f"clamp_max={cfg.clamp_max};"
        f"min_valid_slot_days={cfg.min_valid_slot_days};"
        f"aggregation_method={cfg.aggregation_method};"
        "slot_invalidation_max_battery_soc_percent="
        f"{cfg.slot_invalidation_max_battery_soc_percent};"
        "slot_invalidation_export_enabled_entity_id="
        f"{cfg.slot_invalidation_export_enabled_entity_id};"
        "slot_invalidation_data_glitch_max_slot_wh="
        f"{cfg.slot_invalidation_data_glitch_max_slot_wh};"
        "slot_invalidation_data_glitch_min_neighbour_forecast_wh="
        f"{cfg.slot_invalidation_data_glitch_min_neighbour_forecast_wh};"
        "slot_invalidation_data_glitch_backfill_max_minutes="
        f"{cfg.slot_invalidation_data_glitch_backfill_max_minutes};"
        "max_interpolated_consecutive_slots="
        f"{cfg.max_interpolated_consecutive_slots}"
    )
```

- [ ] **Step 4: Run the new tests**

Run: `pytest tests/test_solar_bias_trainer.py -k "fingerprint" -v`
Expected: PASS — the new test passes; pre-existing fingerprint tests still pass because they all build configs via `make_cfg`, which now uses the same default for both compared configs.

- [ ] **Step 5: Commit**

```bash
git add custom_components/helman/solar_bias_correction/trainer.py \
        tests/test_solar_bias_trainer.py
git commit -m "feat(solar-bias): include interpolation cap in training fingerprint"
```

---

### Task 3: Extend metadata and slot explainability dataclasses

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/models.py`

- [ ] **Step 1: Write a failing test asserting default values**

Add to `tests/test_solar_bias_trainer.py`:

```python
def test_metadata_default_interpolated_slot_count_is_zero():
    md = models.SolarBiasMetadata(
        trained_at="2026-05-06T00:00:00",
        training_config_fingerprint="sha256:abc",
        usable_days=0,
        dropped_days=[],
        factor_min=None,
        factor_max=None,
        factor_median=None,
        omitted_slot_count=0,
        last_outcome="insufficient_history",
    )
    assert md.interpolated_slot_count == 0


def test_slot_explainability_default_interpolation_fields():
    se = models.SolarBiasSlotExplainability(
        factor=None,
        raw_ratio=None,
        clamped=False,
        forecast_sum_wh=0.0,
        actual_sum_wh=0.0,
        rows=[],
    )
    assert se.interpolated is False
    assert se.interpolation_anchors is None
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/test_solar_bias_trainer.py -k "default_interpolated_slot_count or default_interpolation_fields" -v`
Expected: FAIL — attributes don't exist.

- [ ] **Step 3: Add the fields**

In `custom_components/helman/solar_bias_correction/models.py`:

Update `SolarBiasMetadata` (after `error_reason: str | None = None` field):

```python
@dataclass
class SolarBiasMetadata:
    trained_at: str
    training_config_fingerprint: str
    usable_days: int
    dropped_days: list[dict[str, str]]
    factor_min: float | None
    factor_max: float | None
    factor_median: float | None
    omitted_slot_count: int
    last_outcome: str
    invalidated_slots_by_date: dict[str, list[str]] = field(default_factory=dict)
    invalidated_slot_count: int = 0
    error_reason: str | None = None
    interpolated_slot_count: int = 0
```

Update `SolarBiasSlotExplainability` (add two fields with defaults at the end):

```python
@dataclass
class SolarBiasSlotExplainability:
    factor: float | None
    raw_ratio: float | None
    clamped: bool
    forecast_sum_wh: float
    actual_sum_wh: float
    rows: list[SolarBiasContributionRow]
    interpolated: bool = False
    interpolation_anchors: tuple[str | None, str | None] | None = None
```

- [ ] **Step 4: Surface the new fields in the JSON payload**

In `custom_components/helman/solar_bias_correction/models.py`, update `training_explainability_to_payload` so each slot dict includes the new fields. Replace the per-slot dict literal (inside the `slots` comprehension) with:

```python
            slot: {
                "factor": details.factor,
                "rawRatio": details.raw_ratio,
                "clamped": details.clamped,
                "forecastSumWh": details.forecast_sum_wh,
                "actualSumWh": details.actual_sum_wh,
                "interpolated": details.interpolated,
                "interpolationAnchors": (
                    {
                        "left": details.interpolation_anchors[0],
                        "right": details.interpolation_anchors[1],
                    }
                    if details.interpolation_anchors is not None
                    else None
                ),
                "rows": [
                    {
                        "date": row.date,
                        "forecastWh": row.forecast_wh,
                        "actualWh": row.actual_wh,
                        "ratio": row.ratio,
                        "status": row.status,
                        "reason": row.reason,
                    }
                    for row in details.rows
                ],
            }
```

- [ ] **Step 5: Run the new tests**

Run: `pytest tests/test_solar_bias_trainer.py -k "default_interpolated_slot_count or default_interpolation_fields" -v`
Expected: PASS.

- [ ] **Step 6: Run the full suite to confirm no regressions**

Run: `pytest tests/test_solar_bias_trainer.py tests/test_solar_bias_response.py tests/test_solar_bias_models.py -v`
Expected: All tests pass. The new fields have defaults, so existing constructors and serializers are unaffected. If the response/models tests assert exact JSON shape, they may need a one-line update — see Step 7.

- [ ] **Step 7: Update any payload-shape tests if they fail**

If any test in `test_solar_bias_response.py` or `test_solar_bias_models.py` asserts on the exact payload of `training_explainability_to_payload` (e.g., `assert payload["slots"]["12:00"] == {...}`), update those tests to include `"interpolated": False` and `"interpolationAnchors": None`. Prefer asserting on a subset (e.g., specific keys) where reasonable; if the test compares the whole dict, add the two keys with their defaults.

- [ ] **Step 8: Commit**

```bash
git add custom_components/helman/solar_bias_correction/models.py \
        tests/test_solar_bias_trainer.py \
        $(git status --porcelain | awk '/test_solar_bias_(response|models)\.py/ {print $2}')
git commit -m "feat(solar-bias): add interpolation fields to metadata and explainability"
```

---

### Task 4: Implement the interpolation pass in `train()`

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/trainer.py`

This is the core feature. Tests are written first to drive each behavior.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_solar_bias_trainer.py` (near the bottom, before any final block; add a new section comment for clarity):

```python
# ---------------------------------------------------------------------------
# Slot interpolation fallback
# ---------------------------------------------------------------------------


def _interp_samples(
    *,
    days: int,
    slots: list[str],
    forecast_per_slot: float,
) -> list[models.TrainerSample]:
    """Build `days` identical training samples covering the given hourly slots."""
    out = []
    for i in range(days):
        date = f"2024-03-{i + 1:02d}"
        out.append(
            models.TrainerSample(
                date=date,
                forecast_wh=forecast_per_slot * len(slots),
                slot_forecast_wh={s: forecast_per_slot for s in slots},
            )
        )
    return out


def _interp_actuals(
    samples: list[models.TrainerSample],
    *,
    slot_actual_factor: dict[str, float],
    invalidated_slots_per_day: dict[str, set[str]] | None = None,
) -> models.SolarActualsWindow:
    """For each sample, produce actuals = forecast * factor[slot]."""
    by_date: dict[str, dict[str, float]] = {}
    for s in samples:
        per_slot = {}
        for slot, fcast in s.slot_forecast_wh.items():
            per_slot[slot] = fcast * slot_actual_factor.get(slot, 1.0)
        by_date[s.date] = per_slot
    return models.SolarActualsWindow(
        slot_actuals_by_date=by_date,
        invalidated_slots_by_date=invalidated_slots_per_day or {},
    )


def test_interpolation_fills_single_slot_between_two_healthy():
    # Slots 10:00 11:00 12:00. Healthy at 10 and 12; 11 is invalidated on most days.
    cfg = make_cfg(min_history_days=2)
    cfg.min_valid_slot_days = 5
    cfg.max_interpolated_consecutive_slots = 2
    samples = _interp_samples(days=6, slots=["10:00", "11:00", "12:00"], forecast_per_slot=200.0)
    # 10:00 actual ratio = 0.6, 12:00 actual ratio = 1.4, 11:00 invalidated 5/6 days.
    invalidated = {s.date: {"11:00"} for s in samples[:5]}
    actuals = _interp_actuals(
        samples,
        slot_actual_factor={"10:00": 0.6, "11:00": 1.0, "12:00": 1.4},
        invalidated_slots_per_day=invalidated,
    )
    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    # 11:00 should be interpolated as midpoint of (0.6, 1.4) = 1.0
    assert "11:00" in outcome.profile.factors
    assert "11:00" not in outcome.profile.omitted_slots
    assert abs(outcome.profile.factors["11:00"] - 1.0) < 1e-9
    assert outcome.metadata.interpolated_slot_count == 1
    assert outcome.explainability is not None
    slot_expl = outcome.explainability.slots["11:00"]
    assert slot_expl.interpolated is True
    assert slot_expl.interpolation_anchors == ("10:00", "12:00")
    # A synthetic contribution row of status=interpolated is appended.
    assert any(row.status == "interpolated" for row in slot_expl.rows)


def test_interpolation_fills_run_of_two_with_one_third_two_thirds_weights():
    cfg = make_cfg(min_history_days=2)
    cfg.min_valid_slot_days = 5
    cfg.max_interpolated_consecutive_slots = 2
    samples = _interp_samples(
        days=6, slots=["10:00", "11:00", "12:00", "13:00"], forecast_per_slot=200.0
    )
    invalidated = {s.date: {"11:00", "12:00"} for s in samples[:5]}
    actuals = _interp_actuals(
        samples,
        slot_actual_factor={"10:00": 0.4, "11:00": 1.0, "12:00": 1.0, "13:00": 1.6},
        invalidated_slots_per_day=invalidated,
    )
    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    # left=0.4, right=1.6, L=2 -> i=1: 0.4 + 1.2 * 1/3 = 0.8
    #                            i=2: 0.4 + 1.2 * 2/3 = 1.2
    assert abs(outcome.profile.factors["11:00"] - 0.8) < 1e-9
    assert abs(outcome.profile.factors["12:00"] - 1.2) < 1e-9
    assert outcome.metadata.interpolated_slot_count == 2


def test_interpolation_skipped_when_run_exceeds_max():
    cfg = make_cfg(min_history_days=2)
    cfg.min_valid_slot_days = 5
    cfg.max_interpolated_consecutive_slots = 2
    samples = _interp_samples(
        days=6,
        slots=["10:00", "11:00", "12:00", "13:00", "14:00"],
        forecast_per_slot=200.0,
    )
    invalidated = {s.date: {"11:00", "12:00", "13:00"} for s in samples[:5]}
    actuals = _interp_actuals(
        samples,
        slot_actual_factor={"10:00": 0.6, "11:00": 1.0, "12:00": 1.0, "13:00": 1.0, "14:00": 1.4},
        invalidated_slots_per_day=invalidated,
    )
    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    # All three remain omitted with the original reason.
    for slot in ("11:00", "12:00", "13:00"):
        assert slot in outcome.profile.omitted_slots
        assert slot not in outcome.profile.factors
    assert outcome.metadata.interpolated_slot_count == 0


def test_interpolation_morning_edge_uses_zero_left_anchor():
    cfg = make_cfg(min_history_days=2)
    cfg.min_valid_slot_days = 5
    cfg.max_interpolated_consecutive_slots = 2
    samples = _interp_samples(days=6, slots=["06:00", "07:00"], forecast_per_slot=200.0)
    invalidated = {s.date: {"06:00"} for s in samples[:5]}
    actuals = _interp_actuals(
        samples,
        slot_actual_factor={"06:00": 1.0, "07:00": 1.5},
        invalidated_slots_per_day=invalidated,
    )
    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    # left=0.0, right=1.5, L=1 -> midpoint = 0.75
    assert abs(outcome.profile.factors["06:00"] - 0.75) < 1e-9
    assert outcome.explainability.slots["06:00"].interpolation_anchors == (None, "07:00")


def test_interpolation_evening_edge_uses_zero_right_anchor():
    cfg = make_cfg(min_history_days=2)
    cfg.min_valid_slot_days = 5
    cfg.max_interpolated_consecutive_slots = 2
    samples = _interp_samples(days=6, slots=["18:00", "19:00"], forecast_per_slot=200.0)
    invalidated = {s.date: {"19:00"} for s in samples[:5]}
    actuals = _interp_actuals(
        samples,
        slot_actual_factor={"18:00": 1.4, "19:00": 1.0},
        invalidated_slots_per_day=invalidated,
    )
    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    # left=1.4, right=0.0, L=1 -> midpoint = 0.7
    assert abs(outcome.profile.factors["19:00"] - 0.7) < 1e-9
    assert outcome.explainability.slots["19:00"].interpolation_anchors == ("18:00", None)


def test_interpolation_disabled_when_max_is_zero_matches_legacy_behavior():
    cfg = make_cfg(min_history_days=2)
    cfg.min_valid_slot_days = 5
    cfg.max_interpolated_consecutive_slots = 0
    samples = _interp_samples(days=6, slots=["10:00", "11:00", "12:00"], forecast_per_slot=200.0)
    invalidated = {s.date: {"11:00"} for s in samples[:5]}
    actuals = _interp_actuals(
        samples,
        slot_actual_factor={"10:00": 0.6, "11:00": 1.0, "12:00": 1.4},
        invalidated_slots_per_day=invalidated,
    )
    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    assert "11:00" in outcome.profile.omitted_slots
    assert "11:00" not in outcome.profile.factors
    assert outcome.metadata.interpolated_slot_count == 0


def test_two_runs_separated_by_healthy_slot_use_snapshot_anchors():
    cfg = make_cfg(min_history_days=2)
    cfg.min_valid_slot_days = 5
    cfg.max_interpolated_consecutive_slots = 2
    slots = ["10:00", "11:00", "12:00", "13:00", "14:00"]
    samples = _interp_samples(days=6, slots=slots, forecast_per_slot=200.0)
    # Healthy at 10, 12, 14. 11 and 13 invalidated 5/6 days.
    invalidated = {s.date: {"11:00", "13:00"} for s in samples[:5]}
    actuals = _interp_actuals(
        samples,
        slot_actual_factor={
            "10:00": 0.4,
            "11:00": 1.0,
            "12:00": 1.0,
            "13:00": 1.0,
            "14:00": 1.6,
        },
        invalidated_slots_per_day=invalidated,
    )
    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    # 11:00 between 0.4 and 1.0 -> 0.7. 13:00 between 1.0 and 1.6 -> 1.3.
    # Critically: 12:00 is the right anchor of run #1 AND left anchor of run #2 -
    # both use the SAME (original) value of 1.0 from the snapshot.
    assert abs(outcome.profile.factors["11:00"] - 0.7) < 1e-9
    assert abs(outcome.profile.factors["13:00"] - 1.3) < 1e-9
    assert outcome.metadata.interpolated_slot_count == 2


def test_interpolation_does_not_apply_to_forecast_floor_omissions():
    # Slot is omitted because forecast sum is too low - NOT eligible for interpolation
    # even when neighbors are healthy.
    cfg = make_cfg(min_history_days=2)
    cfg.min_valid_slot_days = 1
    cfg.max_interpolated_consecutive_slots = 2
    # 11:00 forecast set very low so its summed forecast falls below the 50 Wh floor.
    samples = []
    for i in range(3):
        date = f"2024-03-{i + 1:02d}"
        samples.append(
            models.TrainerSample(
                date=date,
                forecast_wh=200.0 + 200.0 + 1.0,
                slot_forecast_wh={"10:00": 200.0, "11:00": 1.0, "12:00": 200.0},
            )
        )
    actuals = _interp_actuals(
        samples,
        slot_actual_factor={"10:00": 0.6, "11:00": 1.0, "12:00": 1.4},
    )
    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    assert "11:00" in outcome.profile.omitted_slots
    assert "11:00" not in outcome.profile.factors
    assert outcome.metadata.interpolated_slot_count == 0
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `pytest tests/test_solar_bias_trainer.py -k "interpolation or interpolated" -v`
Expected: Multiple FAILs — interpolation logic does not exist yet; slots that are omitted today stay omitted.

- [ ] **Step 3: Add the helper to `trainer.py`**

In `custom_components/helman/solar_bias_correction/trainer.py`, add this helper above `def train(...)` (e.g., right after `_build_training_explainability`):

```python
def _interpolate_omitted_slots(
    *,
    sorted_forecast_slots: list[str],
    factors: Dict[str, float],
    omitted_slots: List[str],
    omitted_slot_reasons: Dict[str, str],
    max_run: int,
) -> dict[str, tuple[str | None, str | None]]:
    """Fill short runs of slots omitted for `slot_insufficient_valid_days` via linear interpolation.

    Mutates `factors`, `omitted_slots`, and `omitted_slot_reasons` in place. Returns a mapping
    {slot: (left_anchor_slot_or_None, right_anchor_slot_or_None)} for every slot that was
    successfully interpolated, where None on either side means "edge zero anchor".

    Anchors are read from a snapshot of `factors` taken before the pass starts, so an
    interpolated slot can never act as anchor for another interpolated slot in the same run.
    """
    if max_run <= 0:
        return {}

    eligible_reason = "slot_insufficient_valid_days"
    eligible: set[str] = {
        slot
        for slot in omitted_slots
        if omitted_slot_reasons.get(slot) == eligible_reason
    }
    if not eligible:
        return {}

    anchor_factors: dict[str, float] = dict(factors)
    interpolated: dict[str, tuple[str | None, str | None]] = {}

    i = 0
    n = len(sorted_forecast_slots)
    while i < n:
        if sorted_forecast_slots[i] not in eligible:
            i += 1
            continue
        # Found the start of a run; extend while consecutive entries are also eligible.
        j = i
        while j < n and sorted_forecast_slots[j] in eligible:
            j += 1
        run = sorted_forecast_slots[i:j]
        run_len = len(run)

        if run_len <= max_run:
            # Find left anchor: nearest preceding slot that has a factor in the snapshot.
            left_idx = i - 1
            left_slot: str | None = None
            left_value = 0.0
            while left_idx >= 0:
                candidate = sorted_forecast_slots[left_idx]
                if candidate in anchor_factors:
                    left_slot = candidate
                    left_value = anchor_factors[candidate]
                    break
                left_idx -= 1

            # Find right anchor: nearest following slot that has a factor in the snapshot.
            right_idx = j
            right_slot: str | None = None
            right_value = 0.0
            while right_idx < n:
                candidate = sorted_forecast_slots[right_idx]
                if candidate in anchor_factors:
                    right_slot = candidate
                    right_value = anchor_factors[candidate]
                    break
                right_idx += 1

            # Linear interpolation across the run.
            for offset, slot in enumerate(run, start=1):
                value = left_value + (right_value - left_value) * offset / (run_len + 1)
                factors[slot] = value
                interpolated[slot] = (left_slot, right_slot)

            # Move slots out of the omitted list.
            for slot in run:
                omitted_slot_reasons.pop(slot, None)
            run_set = set(run)
            omitted_slots[:] = [s for s in omitted_slots if s not in run_set]

        i = j

    return interpolated
```

- [ ] **Step 4: Wire the helper into `train()`**

In `custom_components/helman/solar_bias_correction/trainer.py`, inside `train()`, after the `for slot in sorted_forecast_slots:` loop that builds `factors`/`omitted_slots`, and BEFORE the `factor_values = list(factors.values())` line that computes summary stats, insert:

```python
    interpolated_anchors = _interpolate_omitted_slots(
        sorted_forecast_slots=sorted_forecast_slots,
        factors=factors,
        omitted_slots=omitted_slots,
        omitted_slot_reasons=omitted_slot_reasons,
        max_run=cfg.max_interpolated_consecutive_slots,
    )
    interpolated_slot_count = len(interpolated_anchors)
```

The existing `factor_min`/`factor_max`/`factor_median` lines that follow will now naturally include the interpolated values because they read from `factors` directly. No further change needed there.

- [ ] **Step 5: Pass interpolation info into the metadata constructor**

In the same `train()` function, find the `metadata = SolarBiasMetadata(...)` call and add the new field:

```python
    metadata = SolarBiasMetadata(
        trained_at=trained_at,
        training_config_fingerprint=fingerprint,
        usable_days=usable_days,
        dropped_days=dropped_days,
        factor_min=factor_min,
        factor_max=factor_max,
        factor_median=factor_median,
        omitted_slot_count=len(omitted_slots),
        last_outcome="profile_trained",
        invalidated_slots_by_date=invalidated_slots_by_date,
        invalidated_slot_count=invalidated_slot_count,
        error_reason=None,
        interpolated_slot_count=interpolated_slot_count,
    )
```

- [ ] **Step 6: Pass interpolation info into the explainability builder**

In the same `train()`, update the `explainability = _build_training_explainability(...)` call to add a new keyword argument:

```python
    explainability = _build_training_explainability(
        usable_samples=usable_samples,
        dropped_days=dropped_days,
        actuals=actuals,
        cfg=cfg,
        trained_at=trained_at,
        forecast_slot_keys=sorted_forecast_slots,
        factors=factors,
        omitted_slots=omitted_slots,
        omitted_slot_reasons=omitted_slot_reasons,
        slot_forecast_sums=slot_forecast_sums,
        slot_actual_sums=slot_actual_sums,
        slot_raw_ratios=slot_raw_ratios,
        interpolated_anchors=interpolated_anchors,
    )
```

- [ ] **Step 7: Extend `_build_training_explainability` to accept the new arg**

In `custom_components/helman/solar_bias_correction/trainer.py`, update the signature and body of `_build_training_explainability`:

Add the new keyword parameter (after `slot_raw_ratios`):

```python
    interpolated_anchors: dict[str, tuple[str | None, str | None]] | None = None,
```

Inside the function, just before the `slots[slot] = SolarBiasSlotExplainability(...)` call, build the interpolation extras and append a synthetic row:

```python
        is_interpolated = (
            interpolated_anchors is not None and slot in interpolated_anchors
        )
        anchors_for_slot: tuple[str | None, str | None] | None = None
        if is_interpolated and interpolated_anchors is not None:
            anchors_for_slot = interpolated_anchors[slot]
            left_label = anchors_for_slot[0] if anchors_for_slot[0] is not None else "edge_zero"
            right_label = anchors_for_slot[1] if anchors_for_slot[1] is not None else "edge_zero"
            rows = rows + [
                SolarBiasContributionRow(
                    date="",
                    forecast_wh=None,
                    actual_wh=None,
                    ratio=None,
                    status="interpolated",
                    reason=f"left={left_label},right={right_label}",
                )
            ]
```

Then update the `slots[slot] = SolarBiasSlotExplainability(...)` call to use the new fields and to include the (possibly extended) `rows`. Replace the existing constructor with:

```python
        slots[slot] = SolarBiasSlotExplainability(
            factor=factor,
            raw_ratio=raw_ratio,
            clamped=(
                raw_ratio is not None
                and factor is not None
                and abs(float(factor) - raw_ratio) > 1e-12
            ),
            forecast_sum_wh=forecast_sum,
            actual_sum_wh=actual_sum,
            rows=rows
            + (
                [
                    SolarBiasContributionRow(
                        date="",
                        forecast_wh=None,
                        actual_wh=None,
                        ratio=None,
                        status="omitted_slot",
                        reason=omitted_slot_reasons.get(slot, "slot_forecast_sum_too_low"),
                    )
                ]
                if slot in omitted_slot_set
                else []
            ),
            interpolated=is_interpolated,
            interpolation_anchors=anchors_for_slot,
        )
```

Note: by the time `_build_training_explainability` runs, interpolated slots are no longer in `omitted_slots`, so `omitted_slot_set = set(omitted_slots)` won't add the spurious "omitted_slot" row to them. That ordering is important — the synthetic `interpolated` row is appended via the new block above, and the existing `omitted_slot` row block leaves interpolated slots alone.

- [ ] **Step 8: Run all the new interpolation tests**

Run: `pytest tests/test_solar_bias_trainer.py -k "interpolation or interpolated" -v`
Expected: All new tests PASS.

- [ ] **Step 9: Run the full trainer test file**

Run: `pytest tests/test_solar_bias_trainer.py -v`
Expected: PASS for all tests, including the pre-existing ones. The `test_slot_with_too_few_valid_slot_days_is_omitted` test should still pass because its scenario uses adjacent slots only at `12:00` with no neighbors that have factors, so the interpolation pass finds no valid anchors and... wait — review carefully: `min_valid_slot_days=2`, only `12:00` is in the slot set, the run is length 1 ≤ 2. With no left and no right anchor (both zero), interpolated value is `0.0 + (0.0 - 0.0) * 1/2 = 0.0`. That would fill `12:00` with `0.0` and the test would FAIL because it asserts `"12:00" not in outcome.profile.factors`.

  - **Action:** if that test fails, fix it by setting `cfg.max_interpolated_consecutive_slots = 0` at the top of the test (it's verifying the legacy gate, not interpolation). Specifically, in `test_slot_with_too_few_valid_slot_days_is_omitted`, after `cfg.min_valid_slot_days = 2`, add:

```python
    cfg.max_interpolated_consecutive_slots = 0
```

  Re-run and confirm green.

- [ ] **Step 10: Run the broader bias-correction suites for regressions**

Run: `pytest tests/test_solar_bias_trainer.py tests/test_solar_bias_models.py tests/test_solar_bias_response.py tests/test_solar_bias_inspector.py tests/test_solar_bias_service_runtime.py tests/test_solar_bias_websocket.py tests/test_solar_bias_forecast_history.py tests/test_solar_bias_store.py tests/test_solar_bias_actuals.py tests/test_solar_bias_adjuster.py -v`
Expected: All pass. If a payload-shape test fails because it asserted on the exact dict shape of `training_explainability_to_payload`, update that test the same way as in Task 3 Step 7 (add `"interpolated": False`, `"interpolationAnchors": None` to the expected dict).

- [ ] **Step 11: Commit**

```bash
git add custom_components/helman/solar_bias_correction/trainer.py \
        tests/test_solar_bias_trainer.py
# include any payload-shape test files that needed updates
git status
git commit -m "feat(solar-bias): interpolate omitted slots from healthy neighbors"
```

---

### Task 5: Update changelog and run final verification

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Inspect existing changelog format**

Run: `head -40 CHANGELOG.md`
Use the same heading style (e.g., `## Unreleased` or a dated entry) that already exists.

- [ ] **Step 2: Add a changelog entry**

Add an entry under the appropriate "Unreleased" or current-version section:

```markdown
- Solar bias correction now interpolates correction factors for short runs of slots that
  fail the `min_valid_slot_days` gate, instead of leaving them at the implicit fallback
  of 1.0. Linear interpolation is performed between the nearest healthy neighbors (or
  zero at the edges of the day). The maximum run length is configurable via
  `bias_correction.max_interpolated_consecutive_slots` (default 2; set to 0 to disable).
```

- [ ] **Step 3: Run the full test suite one more time**

Run: `pytest tests/ -v`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog entry for solar bias slot interpolation"
```

---

## Verification Summary

When the plan is complete, the following must all be true:

- `BiasConfig.max_interpolated_consecutive_slots` exists with default `2`, parsed from YAML key `bias_correction.max_interpolated_consecutive_slots`.
- `compute_fingerprint` includes the new field; changing it forces a re-train.
- `train()` interpolates short runs (length ≤ `max_interpolated_consecutive_slots`) of slots omitted with reason `slot_insufficient_valid_days`. Other omission reasons are untouched.
- Interpolation reads anchors from a snapshot taken before the pass; interpolated slots cannot anchor other interpolated slots.
- Edge runs use `0.0` as the missing anchor.
- Interpolated factors are NOT re-clamped.
- `SolarBiasMetadata.interpolated_slot_count` reports the count of interpolated slots.
- `SolarBiasSlotExplainability.interpolated`, `.interpolation_anchors`, and a synthetic `status="interpolated"` row are populated and surfaced in the JSON payload.
- All pre-existing tests continue to pass; new tests cover: midpoint, two-slot run, run too long, morning edge, evening edge, disabled (`max=0`), two-runs-with-shared-snapshot, and ineligibility for `slot_forecast_sum_too_low`.
