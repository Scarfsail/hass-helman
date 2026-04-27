# Solar Bias Correction Engine Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tune the solar bias correction engine so it can model a daily morning physical-obstruction shadow and the subsequent surge: switch slot aggregation from "ratio-of-sums" to a trimmed mean of daily ratios, raise training resolution to 15 minutes via the upstream `watts` attribute, and relax the bias clamps.

**Architecture:** Three independent phases against `custom_components/helman/solar_bias_correction/`, each shipping behind a fingerprint bump that forces a re-train. (1) Replace the slot factor formula in `trainer.py`. (2) Expand the hourly forecast in `forecast_history.py` into four 15-minute sub-slots using the `watts` attribute the upstream entity already exposes. (3) Update the two clamp defaults in `const.py`.

**Tech Stack:** Python 3.12, Home Assistant custom component, `pytest` (sync + `unittest.IsolatedAsyncioTestCase` for the recorder-touching code).

**Source spec:** `docs/features/forecast/solar-forecast-bias-correction/correction_engine_tuning_1.md`

---

## File Structure

| File | Phase | Responsibility |
|------|-------|----------------|
| `custom_components/helman/solar_bias_correction/trainer.py` | 1 | Replace ratio-of-sums with trimmed mean of daily ratios; bump algorithm version in `compute_fingerprint`. |
| `custom_components/helman/solar_bias_correction/forecast_history.py` | 2 | Read `watts` attribute alongside `wh_period`; emit 15-minute keyed slot forecast via watts-weighted split. |
| `custom_components/helman/const.py` | 3 | Update `SOLAR_BIAS_DEFAULT_CLAMP_MIN` and `SOLAR_BIAS_DEFAULT_CLAMP_MAX`. |
| `tests/test_solar_bias_trainer.py` | 1 | Tests for new aggregation; update existing tests that depend on ratio-of-sums semantics. |
| `tests/test_solar_bias_forecast_history.py` | 2 | Tests for 15-minute expansion: watts-weighted split, fallback when `watts` is missing/short, hourly total preservation. |

YAGNI notes:
- No new config knobs. Aggregation method is a single hard-coded choice (trimmed mean of daily ratios). Clamp defaults change in `const.py` but the existing config override path is unchanged.
- No fallback aggregator on top of the trimmed mean. The doc mentions median as a possible alternative; we ship one path.
- No "what if upstream lacks `watts`" gating. The single supported provider exposes both `wh_period` and `watts` (verified live: 24 vs 96 entries). If `watts` is missing or malformed for a given historical state, we omit that day's per-slot forecast (existing behaviour for missing `wh_period`), which the trainer already tolerates.

---

## Phase 1 — Trimmed Mean of Daily Ratios

The current trainer accumulates `slot_forecast_sums` and `slot_actual_sums` across the usable days, then divides. This blends a daily 0 Wh "blocked" outcome with rare bright mornings. Replace with: per-day per-slot ratio, drop the lowest one and highest one, average the rest. With the default `min_history_days = 10` and a 60-day window, dropping 1+1 absorbs typical single-day noise without snap behaviour.

**Trimming rule (concrete):**
- Compute `daily_ratio[d] = actual[d,slot] / forecast[d,slot]` for each usable day where `forecast[d,slot] > 0`. (Days with `forecast[d,slot] == 0` contribute nothing — they were not part of the slot's training set even before.)
- Skip days where `slot in invalidated_slots_by_date[d]`.
- After collection, if `n < 3`: fall back to the plain mean of the values present (no trimming possible).
- If `n >= 3`: drop the single highest and single lowest, average the rest.
- `_SLOT_FORECAST_SUM_FLOOR_WH` (50 Wh, summed across days) still gates whether a slot is admitted into the profile at all.

### Task 1.1: Add `_trimmed_mean` helper

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/trainer.py`
- Test: `tests/test_solar_bias_trainer.py`

- [ ] **Step 1: Write the failing tests for `_trimmed_mean`**

Append to `tests/test_solar_bias_trainer.py`:

```python
def test_trimmed_mean_returns_none_for_empty():
    assert trainer._trimmed_mean([]) is None


def test_trimmed_mean_plain_mean_for_small_n():
    # n < 3: trimming is not safe — return plain mean
    assert trainer._trimmed_mean([1.0]) == 1.0
    assert trainer._trimmed_mean([1.0, 3.0]) == 2.0


def test_trimmed_mean_drops_one_high_one_low():
    # n == 3: drop min and max, leave the middle
    assert trainer._trimmed_mean([0.0, 1.0, 5.0]) == 1.0


def test_trimmed_mean_eight_values():
    # Mirrors the worked example from correction_engine_tuning_1.md, section 3:
    # [0,0,0,0,0,0.958,1.297,2.057] -> drop 0 and 2.057 -> mean of remaining 6
    values = [0.0, 0.0, 0.0, 0.0, 0.0, 0.958, 1.297, 2.057]
    expected = (0.0 + 0.0 + 0.0 + 0.0 + 0.958 + 1.297) / 6
    assert abs(trainer._trimmed_mean(values) - expected) < 1e-9
```

- [ ] **Step 2: Run the new tests and confirm they fail**

Run: `pytest tests/test_solar_bias_trainer.py -k trimmed_mean -v`
Expected: 4 FAILs with `AttributeError: module ... has no attribute '_trimmed_mean'`.

- [ ] **Step 3: Implement `_trimmed_mean` in `trainer.py`**

In `custom_components/helman/solar_bias_correction/trainer.py`, immediately after `_median`:

```python
def _trimmed_mean(values: List[float]) -> float | None:
    """Trimmed mean of `values`: drop one min and one max, average the rest.

    For n < 3 there is nothing safe to drop, so return the plain mean.
    Returns None for an empty input.
    """
    n = len(values)
    if n == 0:
        return None
    if n < 3:
        return sum(values) / n
    s = sorted(values)
    trimmed = s[1:-1]
    return sum(trimmed) / len(trimmed)
```

- [ ] **Step 4: Run the new tests and confirm they pass**

Run: `pytest tests/test_solar_bias_trainer.py -k trimmed_mean -v`
Expected: 4 PASSES.

- [ ] **Step 5: Commit**

```bash
git add custom_components/helman/solar_bias_correction/trainer.py tests/test_solar_bias_trainer.py
git commit -m "feat(solar-bias): add _trimmed_mean helper for daily-ratio aggregation"
```

### Task 1.2: Replace ratio-of-sums with trimmed mean of daily ratios

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/trainer.py:154-188`
- Test: `tests/test_solar_bias_trainer.py`

- [ ] **Step 1: Write a failing test for the new aggregation behaviour**

Append to `tests/test_solar_bias_trainer.py`:

```python
def test_slot_factor_uses_trimmed_mean_of_daily_ratios():
    """8 days at 06:00: five zero-actual days, three above-forecast days.

    Ratio-of-sums on this set gave ~0.39 (see correction_engine_tuning_1.md sec. 3).
    Trimmed mean of daily ratios drops one zero (lowest) and 2.057 (highest)
    -> mean of [0,0,0,0,0.958,1.297] = 0.376.
    """
    cfg = make_cfg(min_history_days=8, clamp_min=0.0, clamp_max=3.0)
    slot = "06:00"

    per_day = [
        ("2026-04-15",  97.2, 200.0),
        ("2026-04-16", 198.8,   0.0),
        ("2026-04-17", 231.2, 300.0),
        ("2026-04-21", 115.0,   0.0),
        ("2026-04-22", 313.2, 300.0),
        ("2026-04-23", 370.5,   0.0),
        ("2026-04-25", 364.0,   0.0),
        ("2026-04-26", 385.8,   0.0),
    ]

    # Each sample carries a single-slot forecast at 06:00. day_forecast is set
    # to the same value so the day-level ratio filter (>= 0.05) is not what
    # rejects the all-zero-actual days; they reach the slot aggregator.
    samples = [
        models.TrainerSample(
            date=d,
            forecast_wh=max(fcast, 100.0) * 24,  # comfortably > _DAY_FORECAST_FLOOR_WH
            slot_forecast_wh={slot: fcast},
        )
        for d, fcast, _ in per_day
    ]
    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            d: ({slot: act} if act > 0 else {})  # zero days have no actual entry
            for d, _, act in per_day
        }
    )

    outcome = trainer.train(samples, actuals, cfg, datetime(2026, 4, 27, 3, 0))

    # Note: days where total day actual / day forecast < 0.05 are dropped
    # by the day-level filter. We make sure that doesn't happen here by
    # giving each day enough non-slot actuals to stay above the floor.
    # The simplest way: include a single off-slot actual per zero day.
    assert slot in outcome.profile.factors
    expected = (0.0 + 0.0 + 0.0 + 0.0 + 0.958 + 1.297) / 6
    # Allow a small tolerance because the "actual" zero-day ratios are
    # exact zero, but the three non-zero ratios have rounding.
    assert abs(outcome.profile.factors[slot] - expected) < 0.01
```

(The test's day-level filter caveat will require giving each "zero-actual" day a small off-slot actual so its day-level ratio sits in `[0.05, 5.0]`. Adjust the `slot_actuals_by_date` construction accordingly when implementing — the simplest fix is to add `"12:00": s.forecast_wh * 0.5` for every day so the day-level ratio is comfortably ~0.5.)

- [ ] **Step 2: Run the new test, confirm it fails on the current ratio-of-sums implementation**

Run: `pytest tests/test_solar_bias_trainer.py::test_slot_factor_uses_trimmed_mean_of_daily_ratios -v`
Expected: FAIL — actual factor is ~0.39, not ~0.376.

- [ ] **Step 3: Replace the slot aggregation block in `trainer.py`**

In `custom_components/helman/solar_bias_correction/trainer.py`, replace the block from `# Accumulate per-slot forecast and actual sums...` through the end of the `for slot in sorted_forecast_slots:` loop that builds `factors` (currently lines ~159–188) with:

```python
    # Per-slot, collect daily ratios actual/forecast. The slot is admitted
    # to the profile only if its summed forecast across the window clears
    # _SLOT_FORECAST_SUM_FLOOR_WH (matches previous gating).
    slot_forecast_sums: Dict[str, float] = {slot: 0.0 for slot in forecast_slot_keys}
    slot_daily_ratios: Dict[str, List[float]] = {slot: [] for slot in forecast_slot_keys}

    sorted_forecast_slots = sorted(forecast_slot_keys, key=_slot_to_minutes)
    for s in usable_samples:
        day_actuals = actuals.slot_actuals_by_date.get(s.date, {})
        invalidated_slots = actuals.invalidated_slots_by_date.get(s.date, set())
        for slot in sorted_forecast_slots:
            if slot in invalidated_slots:
                continue
            day_fcast = s.slot_forecast_wh.get(slot, 0.0)
            slot_forecast_sums[slot] += day_fcast
            if day_fcast <= 0.0:
                # No forecast for this day's slot -> ratio is undefined; skip.
                continue
            day_actual = _aggregate_actuals_into_forecast_slot(
                day_actuals,
                forecast_slot=slot,
                forecast_slot_keys=sorted_forecast_slots,
            )
            slot_daily_ratios[slot].append(day_actual / day_fcast)

    factors: Dict[str, float] = {}
    omitted_slots: List[str] = []

    for slot in sorted_forecast_slots:
        if slot_forecast_sums[slot] < _SLOT_FORECAST_SUM_FLOOR_WH:
            omitted_slots.append(slot)
            continue
        ratios = slot_daily_ratios[slot]
        raw = _trimmed_mean(ratios)
        if raw is None:
            omitted_slots.append(slot)
            continue
        clamped = max(cfg.clamp_min, min(raw, cfg.clamp_max))
        factors[slot] = clamped
```

- [ ] **Step 4: Adjust the new test if needed and re-run the focused test**

If the test from Step 1 still fails because of the day-level filter, add a `12:00` filler actual to each day's `slot_actuals_by_date` entry (≈ 50 % of `forecast_wh`) so every day's day-ratio is ~0.5 and clears `_DAY_RATIO_MIN`.

Run: `pytest tests/test_solar_bias_trainer.py::test_slot_factor_uses_trimmed_mean_of_daily_ratios -v`
Expected: PASS.

- [ ] **Step 5: Run the full trainer test module and fix any pre-existing tests that assumed ratio-of-sums semantics**

Run: `pytest tests/test_solar_bias_trainer.py -v`

Expected outcome:
- Tests that build `slot_actuals_by_date` such that *every* day's per-slot ratio equals the same constant (e.g. all uniform splits) will continue to pass — the trimmed mean of identical values is that value.
- Tests like `test_factor_clamps_to_clamp_max`, `test_factor_clamps_to_clamp_min`, `test_factors_not_pinned_to_clamps_when_forecast_is_realistic`, and any "ratio" assertion that constructed asymmetric per-day actuals/forecasts may need their per-day numbers reshaped so the *daily* ratio, not the aggregated ratio, lands at the asserted value. Adjust each failing test by giving every contributing day the same per-slot ratio you want the trimmed mean to produce.
- If any test asserts an exact factor value derived from `sum(actuals)/sum(forecasts)` across asymmetric days, change it to assert the trimmed mean of the per-day ratios instead.

For each failing test, edit the test (not the code) to reflect the new aggregation contract, then re-run the focused test to verify the fix.

- [ ] **Step 6: Commit**

```bash
git add custom_components/helman/solar_bias_correction/trainer.py tests/test_solar_bias_trainer.py
git commit -m "feat(solar-bias): aggregate slot factors via trimmed mean of daily ratios"
```

### Task 1.3: Bump training fingerprint so existing profiles re-train

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/trainer.py:25-33`
- Test: `tests/test_solar_bias_trainer.py`

- [ ] **Step 1: Write a failing test asserting the fingerprint changes shape**

Append to `tests/test_solar_bias_trainer.py`:

```python
def test_compute_fingerprint_includes_algorithm_version():
    cfg = make_cfg()
    fp = trainer.compute_fingerprint(cfg)
    # The fingerprint payload now embeds an algorithm version. We check the
    # payload (pre-hash) by re-computing it ourselves via the same pieces.
    assert fp.startswith("sha256:")
    # And we lock the current value so a future, unintentional bump shows up
    # as a test failure rather than silently re-training every deployment.
    expected_payload = (
        "algo=trimmed_mean_of_daily_ratios_v1;"
        f"min_history_days={cfg.min_history_days};"
        f"clamp_min={cfg.clamp_min};"
        f"clamp_max={cfg.clamp_max}"
    )
    import hashlib
    expected = "sha256:" + hashlib.sha256(expected_payload.encode("utf-8")).hexdigest()
    assert fp == expected
```

- [ ] **Step 2: Run the test, confirm it fails (current payload lacks `algo=`)**

Run: `pytest tests/test_solar_bias_trainer.py::test_compute_fingerprint_includes_algorithm_version -v`
Expected: FAIL — current fingerprint matches the old payload.

- [ ] **Step 3: Update `compute_fingerprint`**

In `custom_components/helman/solar_bias_correction/trainer.py`:

```python
_ALGORITHM_VERSION = "trimmed_mean_of_daily_ratios_v1"


def compute_fingerprint(cfg: BiasConfig) -> str:
    """Compute a deterministic fingerprint of the training-relevant parts of BiasConfig.

    Includes the algorithm version so that an aggregator/resolution change
    invalidates existing profiles and forces a re-train at the next run.
    """
    payload = (
        f"algo={_ALGORITHM_VERSION};"
        f"min_history_days={cfg.min_history_days};"
        f"clamp_min={cfg.clamp_min};"
        f"clamp_max={cfg.clamp_max}"
    )
    h = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return f"sha256:{h}"
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `pytest tests/test_solar_bias_trainer.py::test_compute_fingerprint_includes_algorithm_version -v`
Expected: PASS.

- [ ] **Step 5: Run the full solar-bias test suite to catch knock-on fingerprint assertions**

Run: `pytest tests/ -k solar_bias -v`
Expected: any test that hard-codes a previous `sha256:...` literal will fail. Update those assertions to recompute the fingerprint via `trainer.compute_fingerprint(cfg)` rather than embedding the literal.

- [ ] **Step 6: Commit**

```bash
git add custom_components/helman/solar_bias_correction/trainer.py tests/
git commit -m "feat(solar-bias): bump fingerprint to invalidate ratio-of-sums profiles"
```

---

## Phase 2 — 15-Minute Resolution via Watts-Weighted Split

The upstream `sensor.energy_production_today` exposes a `watts` attribute with 96 instantaneous-power values at 15-minute spacing alongside the existing 24-entry `wh_period`. Use it to split each hourly Wh into four sub-slot Wh values, weighted by the watts the source itself predicts at those four boundaries:

`wh_15[t] = wh_period[h] * watts[t] / sum(watts[h..h+45])`

If `sum(watts[h..h+45]) == 0` (sun is fully below the horizon), spread equally — i.e. `wh_period[h] / 4` — which preserves the hourly total. This branch is for safety; in practice such hours have `wh_period[h] == 0` anyway.

### Task 2.1: Extract sub-slot expansion into a pure helper

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/forecast_history.py`
- Test: `tests/test_solar_bias_forecast_history.py`

- [ ] **Step 1: Write failing tests for the helper**

Append to `tests/test_solar_bias_forecast_history.py` (top-level, not inside a class):

```python
def test_expand_to_15min_uses_watts_weighting():
    from custom_components.helman.solar_bias_correction import forecast_history as fh

    # 1 hour, hourly Wh = 1000, watts unevenly distributed across the 4 sub-slots.
    hourly = {"07:00": 1000.0}
    watts = {"07:00": 0.0, "07:15": 600.0, "07:30": 200.0, "07:45": 200.0}

    result = fh._expand_hourly_to_15min(hourly, watts)

    assert set(result) == {"07:00", "07:15", "07:30", "07:45"}
    assert result["07:00"] == 0.0
    assert result["07:15"] == 600.0
    assert result["07:30"] == 200.0
    assert result["07:45"] == 200.0
    # Hourly Wh total preserved exactly
    assert abs(sum(result.values()) - 1000.0) < 1e-9


def test_expand_to_15min_falls_back_to_equal_split_when_watts_sum_zero():
    from custom_components.helman.solar_bias_correction import forecast_history as fh

    hourly = {"00:00": 0.0, "12:00": 800.0}
    watts = {
        "00:00": 0.0, "00:15": 0.0, "00:30": 0.0, "00:45": 0.0,
        "12:00": 0.0, "12:15": 0.0, "12:30": 0.0, "12:45": 0.0,
    }

    result = fh._expand_hourly_to_15min(hourly, watts)

    assert result["00:00"] == 0.0
    assert result["00:15"] == 0.0
    # Equal split for non-zero hourly with all-zero watts
    assert result["12:00"] == 200.0
    assert result["12:15"] == 200.0
    assert result["12:30"] == 200.0
    assert result["12:45"] == 200.0


def test_expand_to_15min_skips_hours_missing_from_watts():
    from custom_components.helman.solar_bias_correction import forecast_history as fh

    # Only 07:00 has matching watts -> only 07:00 is expanded.
    hourly = {"07:00": 400.0, "08:00": 800.0}
    watts = {"07:00": 100.0, "07:15": 100.0, "07:30": 100.0, "07:45": 100.0}

    result = fh._expand_hourly_to_15min(hourly, watts)

    assert set(result) == {"07:00", "07:15", "07:30", "07:45"}
    assert result["07:00"] == 100.0
    assert result["07:15"] == 100.0
    assert result["07:30"] == 100.0
    assert result["07:45"] == 100.0
```

- [ ] **Step 2: Run, confirm failing**

Run: `pytest tests/test_solar_bias_forecast_history.py -k expand_to_15min -v`
Expected: 3 FAILs — `_expand_hourly_to_15min` does not exist.

- [ ] **Step 3: Implement the helper**

Add to `custom_components/helman/solar_bias_correction/forecast_history.py` (top of the file, after the existing imports):

```python
_SUB_SLOT_OFFSETS_MIN = (0, 15, 30, 45)


def _expand_hourly_to_15min(
    hourly_wh: dict[str, float],
    watts: dict[str, float],
) -> dict[str, float]:
    """Split each hourly Wh into four 15-minute sub-slots.

    Each sub-slot's share is proportional to the upstream `watts` value at
    that 15-minute boundary. If all four watts are zero (e.g. night), the
    hourly Wh is split equally so the hourly total is preserved.

    Hours whose four sub-slot watts entries are not all present in `watts`
    are skipped (cannot be expanded reliably).
    """
    result: dict[str, float] = {}
    for hour_key, hour_wh in hourly_wh.items():
        try:
            h = int(hour_key.split(":")[0])
        except (ValueError, AttributeError):
            continue
        sub_keys = [f"{h:02d}:{m:02d}" for m in _SUB_SLOT_OFFSETS_MIN]
        if not all(k in watts for k in sub_keys):
            continue
        sub_watts = [float(watts[k]) for k in sub_keys]
        total_w = sum(sub_watts)
        if total_w <= 0.0:
            share = hour_wh / 4.0
            for k in sub_keys:
                result[k] = share
        else:
            for k, w in zip(sub_keys, sub_watts):
                result[k] = hour_wh * w / total_w
    return result
```

- [ ] **Step 4: Run, confirm passing**

Run: `pytest tests/test_solar_bias_forecast_history.py -k expand_to_15min -v`
Expected: 3 PASSES.

- [ ] **Step 5: Commit**

```bash
git add custom_components/helman/solar_bias_correction/forecast_history.py tests/test_solar_bias_forecast_history.py
git commit -m "feat(solar-bias): add watts-weighted hourly->15min expansion helper"
```

### Task 2.2: Wire `load_historical_per_slot_forecast` to emit 15-minute slots

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/forecast_history.py:100-138`
- Test: `tests/test_solar_bias_forecast_history.py`

- [ ] **Step 1: Write a failing test**

Append to `tests/test_solar_bias_forecast_history.py` inside `LoadHistoricalPerSlotForecastTests`:

```python
async def test_returns_15min_keys_when_watts_attribute_present(self):
    from datetime import date as date_cls

    cfg = BiasConfig(
        enabled=True,
        min_history_days=10,
        training_time="03:00",
        clamp_min=0.0,
        clamp_max=3.0,
        daily_energy_entity_ids=["sensor.energy_production_today"],
        total_energy_entity_id=None,
    )

    target_date = date_cls(2026, 4, 15)
    local_now = datetime(2026, 4, 25, 10, 0, tzinfo=TZ)

    wh_period = {
        "2026-04-15T07:00:00+00:00": 1000.0,
        "2026-04-15T08:00:00+00:00": 2400.0,
    }
    watts = {
        "2026-04-15T07:00:00+00:00": 0.0,
        "2026-04-15T07:15:00+00:00": 600.0,
        "2026-04-15T07:30:00+00:00": 200.0,
        "2026-04-15T07:45:00+00:00": 200.0,
        "2026-04-15T08:00:00+00:00": 300.0,
        "2026-04-15T08:15:00+00:00": 400.0,
        "2026-04-15T08:30:00+00:00": 800.0,
        "2026-04-15T08:45:00+00:00": 900.0,
    }

    historical_state = SimpleNamespace(
        state="3400",
        attributes={"wh_period": wh_period, "watts": watts},
        last_updated=datetime(2026, 4, 15, 0, 5, tzinfo=TZ),
        last_changed=datetime(2026, 4, 15, 0, 5, tzinfo=TZ),
    )

    async def fake_history(*args, **kwargs):
        return {"sensor.energy_production_today": [historical_state]}

    with patch.object(
        forecast_history,
        "_read_history_for_entities_with_attributes",
        new=AsyncMock(side_effect=fake_history),
    ):
        result = await forecast_history.load_historical_per_slot_forecast(
            hass=SimpleNamespace(config=SimpleNamespace(time_zone="UTC")),
            cfg=cfg,
            target_date=target_date,
            local_now=local_now,
        )

    assert result is not None
    # 07:00 hour expands by watts: 0 / 600 / 200 / 200
    assert result["07:00"] == 0.0
    assert result["07:15"] == 600.0
    assert result["07:30"] == 200.0
    assert result["07:45"] == 200.0
    # 08:00 hour totals 2400 split by [300, 400, 800, 900]
    total_w_08 = 300 + 400 + 800 + 900  # 2400
    assert abs(result["08:00"] - 2400.0 * 300 / total_w_08) < 1e-9
    assert abs(result["08:15"] - 2400.0 * 400 / total_w_08) < 1e-9
    assert abs(result["08:30"] - 2400.0 * 800 / total_w_08) < 1e-9
    assert abs(result["08:45"] - 2400.0 * 900 / total_w_08) < 1e-9
    # And no hourly residue
    assert "07:01" not in result
```

- [ ] **Step 2: Run, confirm failing**

Run: `pytest tests/test_solar_bias_forecast_history.py::LoadHistoricalPerSlotForecastTests::test_returns_15min_keys_when_watts_attribute_present -v`
Expected: FAIL — current implementation returns hourly keys only.

- [ ] **Step 3: Update `load_historical_per_slot_forecast`**

In `custom_components/helman/solar_bias_correction/forecast_history.py`, replace the body of `load_historical_per_slot_forecast` (after the `state` and `attributes` reads) with:

```python
    wh_period = attributes.get("wh_period")
    if not isinstance(wh_period, dict):
        return None

    watts_raw = attributes.get("watts")
    if not isinstance(watts_raw, dict):
        return None

    hourly: dict[str, float] = {}
    for raw_key, raw_value in wh_period.items():
        wh = _parse_attribute_wh(raw_value)
        ts = _parse_attribute_timestamp(raw_key, local_tz)
        if wh is None or ts is None:
            continue
        local_ts = dt_util.as_local(ts)
        slot_key = f"{local_ts.hour:02d}:{local_ts.minute:02d}"
        hourly[slot_key] = wh

    watts: dict[str, float] = {}
    for raw_key, raw_value in watts_raw.items():
        w = _parse_attribute_wh(raw_value)  # tolerant numeric parser, units don't matter
        ts = _parse_attribute_timestamp(raw_key, local_tz)
        if w is None or ts is None:
            continue
        local_ts = dt_util.as_local(ts)
        slot_key = f"{local_ts.hour:02d}:{local_ts.minute:02d}"
        watts[slot_key] = w

    expanded = _expand_hourly_to_15min(hourly, watts)
    return expanded if expanded else None
```

- [ ] **Step 4: Run the new test and the existing forecast_history tests**

Run: `pytest tests/test_solar_bias_forecast_history.py -v`
Expected: the new 15-min test passes. The existing `test_returns_slot_keyed_wh_for_past_day` test (which constructs a state with `wh_period` only and asserts hourly-keyed output) will now fail because we now require `watts`. Update it: either add a matching `watts` attribute and assert 15-min keys, or assert the `None` return when `watts` is absent — pick the expressive one and adjust.

- [ ] **Step 5: Commit**

```bash
git add custom_components/helman/solar_bias_correction/forecast_history.py tests/test_solar_bias_forecast_history.py
git commit -m "feat(solar-bias): expand historical forecast to 15-min slots via watts"
```

### Task 2.3: Bump algorithm version to invalidate hourly profiles

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/trainer.py`
- Test: `tests/test_solar_bias_trainer.py`

- [ ] **Step 1: Update the test from Task 1.3 to assert the new version**

In `tests/test_solar_bias_trainer.py`, change `test_compute_fingerprint_includes_algorithm_version`:

```python
    expected_payload = (
        "algo=trimmed_mean_of_daily_ratios_v1+15min_v1;"
        f"min_history_days={cfg.min_history_days};"
        f"clamp_min={cfg.clamp_min};"
        f"clamp_max={cfg.clamp_max}"
    )
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `pytest tests/test_solar_bias_trainer.py::test_compute_fingerprint_includes_algorithm_version -v`
Expected: FAIL.

- [ ] **Step 3: Bump `_ALGORITHM_VERSION`**

In `custom_components/helman/solar_bias_correction/trainer.py`:

```python
_ALGORITHM_VERSION = "trimmed_mean_of_daily_ratios_v1+15min_v1"
```

- [ ] **Step 4: Run the full solar-bias test suite**

Run: `pytest tests/ -k solar_bias -v`
Expected: PASS. Any test whose fingerprint comparison was updated in Task 1.3 keeps passing because they all recompute via `trainer.compute_fingerprint(cfg)`.

- [ ] **Step 5: Commit**

```bash
git add custom_components/helman/solar_bias_correction/trainer.py tests/test_solar_bias_trainer.py
git commit -m "feat(solar-bias): bump fingerprint for 15-min resolution change"
```

---

## Phase 3 — Relax Default Clamps

The day-level filter (`_DAY_RATIO_MIN = 0.05`) and the slot-invalidation pipeline already guard against the historical reasons for the `[0.3, 2.0]` floor/ceiling. With phases 1 + 2 in place, those clamps now actively distort the morning shadow + surge pattern. Lower the floor to `0.0` so the engine can model "panels are physically dark"; raise the ceiling to `3.0` so the engine can model the post-shadow surge.

### Task 3.1: Update clamp defaults

**Files:**
- Modify: `custom_components/helman/const.py:64-65`
- Test: `tests/test_solar_bias_config_validation.py`, plus any other suite that hard-codes `0.3` / `2.0` defaults

- [ ] **Step 1: Find every test that asserts the old defaults**

Run: `grep -nR "SOLAR_BIAS_DEFAULT_CLAMP\|clamp_min=0.3\|clamp_max=2.0" tests/`
Expected: a list of test files that either import the constants or hard-code the literals.

- [ ] **Step 2: Update the defaults in `const.py`**

In `custom_components/helman/const.py`:

```python
SOLAR_BIAS_DEFAULT_CLAMP_MIN = 0.0
SOLAR_BIAS_DEFAULT_CLAMP_MAX = 3.0
```

- [ ] **Step 3: Update tests that assert defaults**

For each test surfaced in Step 1:
- If the test imports `SOLAR_BIAS_DEFAULT_CLAMP_MIN/MAX` and asserts a specific value: update the asserted value to `0.0` / `3.0`.
- If the test passes `clamp_min=0.3, clamp_max=2.0` explicitly to construct a `BiasConfig` for an unrelated reason (e.g. forecast-history tests just need *some* config): leave it alone — those literals are not asserting "this is the default".
- If a test's behavioural assertion depended on the default values *and* on the value being `0.3` (e.g. "factors should be ≥ 0.3 in the default config") — convert it to assert against the new floor or rewrite it to pass an explicit `clamp_min` so the test does not couple to the default.

- [ ] **Step 4: Run the full test suite**

Run: `pytest tests/ -v`
Expected: all PASSES.

- [ ] **Step 5: Update the config-editor UI documentation/defaults if they mirror const.py**

Run: `grep -nR "0\.3\|2\.0" custom_components/helman/frontend/src/ | grep -i "clamp"`

If hits exist (likely tooltip/placeholder strings or default config templates the UI seeds): update them to `0.0` and `3.0` and rebuild the bundle if the project's convention requires it (recent commit `0c161d1 build(solar-ui): rebuild bundle ...` suggests that pattern).

- [ ] **Step 6: Commit**

```bash
git add custom_components/helman/const.py tests/ custom_components/helman/frontend/
git commit -m "feat(solar-bias): relax default clamps to [0.0, 3.0] for shadow+surge modelling"
```

---

## Phase 4 — Final Verification

### Task 4.1: Full regression sweep

- [ ] **Step 1: Run the full test suite**

Run: `pytest tests/ -v`
Expected: all PASSES.

- [ ] **Step 2: Run `ruff` / project linter if configured**

Run: `ruff check custom_components/helman/solar_bias_correction/ custom_components/helman/const.py` (or whatever the project standardises on — check `pyproject.toml` / `Makefile` first; if none configured, skip).
Expected: no new findings.

- [ ] **Step 3: Manual smoke check via inspector (optional, requires running HA dev container)**

If a HA dev container is running, follow the existing inspector workflow:
- Trigger a re-train (the fingerprint bump from Task 2.3 should make the next scheduled training run produce a new profile automatically; otherwise call the existing `helman/solar_bias/train_now`-style service if present).
- Open the visual inspector for a recent past day with morning shadow.
- Confirm the corrected curve now shows a 0 Wh ramp at the dawn slots and a sharper surge on the post-shadow 15-minute slot, instead of the previous flat hourly average.

This step is observational — note any anomalies and fix-forward in a follow-up rather than blocking the merge.

- [ ] **Step 4: Final commit (only if any docs/cleanup needed)**

If the smoke check surfaced no issues, no commit here. Otherwise:

```bash
git add <fixed files>
git commit -m "fix(solar-bias): <specific issue> noticed during inspector smoke check"
```

---

## Notes

- All three substantive phases (1, 2, 3) can be merged behind a single fingerprint bump per phase. Phase 1 introduces `_ALGORITHM_VERSION = "trimmed_mean_of_daily_ratios_v1"`; Phase 2 extends it to `"trimmed_mean_of_daily_ratios_v1+15min_v1"`. Phase 3 relies on `clamp_min`/`clamp_max` already being in the fingerprint payload — changing the defaults shifts the fingerprint for any deployment using defaults, forcing the expected re-train.
- The plan deliberately avoids: per-deployment configurability of the aggregation method, runtime feature flags, and a 1-hour fallback when `watts` is missing. Those decisions can be reversed cheaply later if a real second provider arrives — see the YAGNI guidance in `~/.claude/projects/.../memory/feedback_yagni.md`.
- If executing this plan in a worktree, after final verification follow `superpowers:finishing-a-development-branch` to choose the merge / PR path.
