# Solar Bias Correction Trainer + Chart Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the solar bias correction so the corrected forecast is no longer dramatically inflated, and fix the visual inspector chart so the actual production line visually aligns with the forecast curve at peak hours.

**Architecture:** Replace the trainer's broken "uniform per-slot forecast" assumption with real per-slot historical forecasts loaded from the recorder, computing a true bias factor per slot. Switch the inspector chart from plotting raw bucket-energy (Wh) to average power (W) so series with different bucket sizes line up.

**Tech Stack:** Python 3.11 (Home Assistant custom component), pytest, Lit + TypeScript + Vite (frontend bundle), Home Assistant recorder.

---

## Context

### Problem 1: trainer algorithm is fundamentally wrong

`custom_components/helman/solar_bias_correction/trainer.py:104-109` distributes each historical day's **total** forecast uniformly across all 96 fifteen-minute slots:

```python
per_slot_forecast = s.forecast_wh / len(_ALL_SLOTS)   # day_total / 96
for slot in _ALL_SLOTS:
    slot_forecast_sums[slot] += per_slot_forecast    # SAME value every slot
    slot_actual_sums[slot]   += day_actuals.get(slot, 0.0)
```

This compares real per-slot **actual** energy to a fictional flat per-slot forecast (~625 Wh per 15 min when daily total is 60 kWh). At night actuals are ~0 → factor ~0 → clamped to `clamp_min` (default 0.3). At noon actuals are ~2.5 kWh / 15 min → factor ~4 → clamped to `clamp_max` (default 2.0).

The current stored profile (`.storage/helman.solar_bias_correction`) shows this exactly: every night slot pinned to 0.3, almost every 11:00-13:45 slot pinned to 2.0. Applying these factors to the real (already-shaped) hourly forecast inflates the corrected total by ~62% (today: raw 69.8 kWh, actual 69.5 kWh, corrected 112.8 kWh).

**Right algorithm:** for each historical day, load the per-slot **forecast** that was published that day, accumulate per-slot forecast and actual sums across days, compute `factor[slot] = sum_actual[slot] / sum_forecast[slot]`. The trainer must work at whatever slot granularity the forecast provider publishes (currently hourly via `wh_period` attribute).

### Problem 2: chart granularity mismatch

`custom_components/helman/frontend/src/bias-correction-inspector.ts:355-357` plots all three series on a single Wh y-axis, but raw/corrected forecast points cover 1 hour each (~9000 Wh at noon) while actual points cover 15 minutes each (~2300 Wh per quarter at noon). Visually the actual production line sits ~4× lower than the forecast curve even when daily totals match. Switching the y-axis to **average power** fixes this — a 9 kWh hour is 9 kW, four 2.25 kWh quarters are 9 kW each, they coincide.

### Constraint: recorder retention

Loading historical forecasts requires the recorder to retain attribute history of `daily_energy_entity_ids[0]` (the "today" entity) for at least `min_history_days` (default 10). Default Home Assistant recorder retention is 10 days, which is borderline. Document this assumption in code comments and in metadata (no enforcement). If history is missing for a day, that day is dropped (existing dropped_days mechanism).

---

## File Structure

**Backend (Python):**
- Modify `custom_components/helman/solar_bias_correction/models.py` — add `slot_forecast_wh: dict[str, float]` to `TrainerSample`.
- Modify `custom_components/helman/solar_bias_correction/forecast_history.py` — add `load_historical_per_slot_forecast(...)`; change `load_trainer_samples` to populate per-slot forecast.
- Modify `custom_components/helman/solar_bias_correction/trainer.py` — replace uniform distribution with real per-slot accumulation; aggregate actuals into the forecast's slot keys; rewrite floors and ratios accordingly.
- No changes to `service.py` or `adjuster.py` (data flow unchanged at API surface).

**Tests (Python):**
- Modify `tests/test_solar_bias_models.py` — `TrainerSample` new field.
- Modify `tests/test_solar_bias_forecast_history.py` — historical wh_period loader.
- Modify `tests/test_solar_bias_trainer.py` — new behavior.
- Modify `tests/test_solar_bias_service_runtime.py` — wiring (only if needed; minimal).

**Frontend (TypeScript / Lit):**
- Modify `custom_components/helman/frontend/src/bias-correction-inspector.ts` — convert each series to average power (W) for plotting; update axis label and ticks; keep totals in kWh (totals box unchanged).
- Modify `custom_components/helman/frontend/src/localize/translations/en.json` and `cs.json` — chart axis label.
- Run `npm run build`, commit `dist/helman-config-editor.js`.

**Operational:**
- After deploy: trigger retraining via `helman.solar_bias_train` service or the UI button.
- Verify in inspector: corrected total within ~15% of raw total on a normal day; factors no longer pinned to clamp boundaries.

---

## Phase 1 — Trainer algorithm fix

### Task 1: Extend `TrainerSample` model with per-slot forecast

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/models.py:26-30` (the `TrainerSample` dataclass)
- Test: `tests/test_solar_bias_models.py`

- [ ] **Step 1: Write failing test for TrainerSample new field**

Append to `tests/test_solar_bias_models.py` (create if missing — pattern same as other tests):

```python
def test_trainer_sample_has_slot_forecast_wh_field():
    from custom_components.helman.solar_bias_correction.models import TrainerSample

    sample = TrainerSample(
        date="2026-04-15",
        forecast_wh=60000.0,
        slot_forecast_wh={"12:00": 9000.0, "13:00": 9100.0},
    )
    assert sample.slot_forecast_wh == {"12:00": 9000.0, "13:00": 9100.0}
    assert sample.forecast_wh == 60000.0
```

If the file doesn't exist, prepend the package-stub setup copied from `tests/test_solar_bias_trainer.py` lines 1-33 verbatim.

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_solar_bias_models.py::test_trainer_sample_has_slot_forecast_wh_field -v`
Expected: FAIL — `TypeError: TrainerSample.__init__() got an unexpected keyword argument 'slot_forecast_wh'`.

- [ ] **Step 3: Add the field**

In `custom_components/helman/solar_bias_correction/models.py`, change the `TrainerSample` dataclass (currently lines 26-30) to:

```python
@dataclass
class TrainerSample:
    date: str
    forecast_wh: float
    slot_forecast_wh: dict[str, float]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_solar_bias_models.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add custom_components/helman/solar_bias_correction/models.py tests/test_solar_bias_models.py
git commit -m "feat(solar-bias): extend TrainerSample with per-slot forecast"
```

---

### Task 2: Add `load_historical_per_slot_forecast` to `forecast_history.py`

Loads the `wh_period` attribute from the recorder for `daily_energy_entity_ids[0]` as it appeared at the start of `target_date`. Returns `dict[slot_key, wh]` where `slot_key = "HH:MM"` in local time, or `None` if data is unavailable.

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/forecast_history.py`
- Test: `tests/test_solar_bias_forecast_history.py`

- [ ] **Step 1: Write failing test**

Append to `tests/test_solar_bias_forecast_history.py`:

```python
class LoadHistoricalPerSlotForecastTests(unittest.IsolatedAsyncioTestCase):
    async def test_returns_slot_keyed_wh_for_past_day(self):
        from datetime import date as date_cls

        cfg = BiasConfig(
            enabled=True,
            min_history_days=10,
            training_time="03:00",
            clamp_min=0.3,
            clamp_max=2.0,
            daily_energy_entity_ids=["sensor.energy_production_today"],
            total_energy_entity_id=None,
        )

        target_date = date_cls(2026, 4, 15)
        local_now = datetime(2026, 4, 25, 10, 0, tzinfo=TZ)

        wh_period = {
            "2026-04-15T11:00:00+00:00": 7000.0,
            "2026-04-15T12:00:00+00:00": 9000.0,
            "2026-04-15T13:00:00+00:00": 8500.0,
        }
        historical_state = SimpleNamespace(
            state="24500",
            attributes={"wh_period": wh_period},
            last_updated=datetime(2026, 4, 15, 0, 5, tzinfo=TZ),
            last_changed=datetime(2026, 4, 15, 0, 5, tzinfo=TZ),
        )

        async def fake_history(*args, **kwargs):
            return {"sensor.energy_production_today": [historical_state]}

        with patch.object(
            forecast_history, "_read_history_for_entities", new=AsyncMock(side_effect=fake_history)
        ):
            result = await forecast_history.load_historical_per_slot_forecast(
                hass=SimpleNamespace(config=SimpleNamespace(time_zone="UTC")),
                cfg=cfg,
                target_date=target_date,
                local_now=local_now,
            )

        assert result == {"11:00": 7000.0, "12:00": 9000.0, "13:00": 8500.0}

    async def test_returns_none_when_state_missing(self):
        from datetime import date as date_cls

        cfg = BiasConfig(
            enabled=True,
            min_history_days=10,
            training_time="03:00",
            clamp_min=0.3,
            clamp_max=2.0,
            daily_energy_entity_ids=["sensor.energy_production_today"],
            total_energy_entity_id=None,
        )

        async def fake_history(*args, **kwargs):
            return {"sensor.energy_production_today": []}

        with patch.object(
            forecast_history, "_read_history_for_entities", new=AsyncMock(side_effect=fake_history)
        ):
            result = await forecast_history.load_historical_per_slot_forecast(
                hass=SimpleNamespace(config=SimpleNamespace(time_zone="UTC")),
                cfg=cfg,
                target_date=date_cls(2026, 4, 15),
                local_now=datetime(2026, 4, 25, 10, 0, tzinfo=TZ),
            )

        assert result is None

    async def test_returns_none_when_no_entity_configured(self):
        from datetime import date as date_cls

        cfg = BiasConfig(
            enabled=True,
            min_history_days=10,
            training_time="03:00",
            clamp_min=0.3,
            clamp_max=2.0,
            daily_energy_entity_ids=[],
            total_energy_entity_id=None,
        )

        result = await forecast_history.load_historical_per_slot_forecast(
            hass=SimpleNamespace(config=SimpleNamespace(time_zone="UTC")),
            cfg=cfg,
            target_date=date_cls(2026, 4, 15),
            local_now=datetime(2026, 4, 25, 10, 0, tzinfo=TZ),
        )

        assert result is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_solar_bias_forecast_history.py::LoadHistoricalPerSlotForecastTests -v`
Expected: FAIL — `AttributeError: module ... has no attribute 'load_historical_per_slot_forecast'`.

- [ ] **Step 3: Implement the loader**

In `custom_components/helman/solar_bias_correction/forecast_history.py`, add this function (place it after `load_forecast_points_for_day`, before `load_trainer_samples`):

```python
async def load_historical_per_slot_forecast(
    hass: HomeAssistant,
    cfg: BiasConfig,
    target_date: date,
    *,
    local_now: datetime,
) -> dict[str, float] | None:
    """Return slot_key -> Wh for the forecast as published at the start of target_date.

    Reads the `wh_period` attribute from the recorder history of
    daily_energy_entity_ids[0] (the "today" entity) as captured at start of
    target_date (local midnight). Returns None if no usable state is available.

    Slot keys are HH:MM in the configured local timezone.

    NOTE: requires recorder to retain attribute history >= min_history_days.
    """
    entity_ids = _read_entity_ids(cfg.daily_energy_entity_ids, limit=1)
    if not entity_ids:
        return None

    local_tz = ZoneInfo(str(hass.config.time_zone))
    local_start = datetime.combine(target_date, time.min, tzinfo=local_tz)
    local_end = local_start + timedelta(days=1)

    states_by_entity = await _read_history_for_entities_with_attributes(
        hass,
        entity_ids,
        local_start,
        local_end,
    )

    states = states_by_entity.get(entity_ids[0]) or states_by_entity.get(
        entity_ids[0].lower()
    )
    if not states:
        return None

    state = _select_first_state_for_window(states, after=dt_util.as_utc(local_start))
    if state is None:
        return None

    attributes = getattr(state, "attributes", {})
    if not isinstance(attributes, dict):
        return None
    wh_period = attributes.get("wh_period")
    if not isinstance(wh_period, dict):
        return None

    result: dict[str, float] = {}
    for raw_key, raw_value in wh_period.items():
        wh = _parse_attribute_wh(raw_value)
        ts = _parse_attribute_timestamp(raw_key, local_tz)
        if wh is None or ts is None:
            continue
        local_ts = dt_util.as_local(ts)
        slot_key = f"{local_ts.hour:02d}:{local_ts.minute:02d}"
        result[slot_key] = wh

    return result if result else None


def _select_first_state_for_window(states: list[Any], *, after: datetime) -> Any | None:
    for state in sorted(states, key=_state_sort_key):
        if _state_sort_key(state) < after:
            continue
        return state
    return states[0] if states else None
```

Then add the new private helper that fetches history **with** attributes (the existing `_read_history_for_entities` passes `no_attributes=True`):

```python
async def _read_history_for_entities_with_attributes(
    hass: HomeAssistant,
    entity_ids: list[str],
    local_start: datetime,
    local_end: datetime,
) -> dict[str, list[Any]]:
    utc_start = dt_util.as_utc(local_start)
    utc_end = dt_util.as_utc(local_end)

    if get_significant_states is None:
        return {}

    try:
        from homeassistant.components.recorder import get_instance

        recorder = get_instance(hass)
        if recorder is not None:
            history = await recorder.async_add_executor_job(
                lambda: get_significant_states(
                    hass,
                    utc_start,
                    utc_end,
                    entity_ids=entity_ids,
                    include_start_time_state=True,
                    minimal_response=False,
                    no_attributes=False,
                    significant_changes_only=False,
                )
            )
        else:
            history = get_significant_states(
                hass,
                utc_start,
                utc_end,
                entity_ids=entity_ids,
                include_start_time_state=True,
                minimal_response=False,
                no_attributes=False,
                significant_changes_only=False,
            )

        if inspect.isawaitable(history):
            history = await history
        if isinstance(history, dict):
            return history
    except (TypeError, AttributeError):
        pass

    return {}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_solar_bias_forecast_history.py -v`
Expected: all `LoadHistoricalPerSlotForecastTests` PASS, existing tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add custom_components/helman/solar_bias_correction/forecast_history.py tests/test_solar_bias_forecast_history.py
git commit -m "feat(solar-bias): load historical per-slot forecast from recorder"
```

---

### Task 3: `load_trainer_samples` populates `slot_forecast_wh`

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/forecast_history.py:66-95` (the `load_trainer_samples` function)
- Test: `tests/test_solar_bias_forecast_history.py`

- [ ] **Step 1: Write failing test**

Append to `tests/test_solar_bias_forecast_history.py`:

```python
class LoadTrainerSamplesTests(unittest.IsolatedAsyncioTestCase):
    async def test_samples_carry_per_slot_forecast(self):
        cfg = BiasConfig(
            enabled=True,
            min_history_days=2,
            training_time="03:00",
            clamp_min=0.3,
            clamp_max=2.0,
            daily_energy_entity_ids=["sensor.energy_production_today"],
            total_energy_entity_id=None,
        )

        async def fake_total(hass, entity_ids, target_date, *, local_now):
            return 60000.0 if str(target_date) in {"2026-04-23", "2026-04-24"} else None

        async def fake_per_slot(hass, c, target_date, *, local_now):
            return {"12:00": 9000.0, "13:00": 9100.0}

        with patch.object(
            forecast_history, "_read_day_forecast_wh", new=AsyncMock(side_effect=fake_total)
        ), patch.object(
            forecast_history,
            "load_historical_per_slot_forecast",
            new=AsyncMock(side_effect=fake_per_slot),
        ):
            samples = await forecast_history.load_trainer_samples(
                hass=SimpleNamespace(config=SimpleNamespace(time_zone="UTC")),
                cfg=cfg,
                now=datetime(2026, 4, 25, 10, 0, tzinfo=TZ),
            )

        dates = [s.date for s in samples]
        assert "2026-04-23" in dates
        assert "2026-04-24" in dates
        for s in samples:
            assert s.slot_forecast_wh == {"12:00": 9000.0, "13:00": 9100.0}

    async def test_sample_dropped_when_per_slot_forecast_missing(self):
        cfg = BiasConfig(
            enabled=True,
            min_history_days=2,
            training_time="03:00",
            clamp_min=0.3,
            clamp_max=2.0,
            daily_energy_entity_ids=["sensor.energy_production_today"],
            total_energy_entity_id=None,
        )

        async def fake_total(hass, entity_ids, target_date, *, local_now):
            return 60000.0

        async def fake_per_slot(hass, c, target_date, *, local_now):
            return None  # recorder retention exhausted

        with patch.object(
            forecast_history, "_read_day_forecast_wh", new=AsyncMock(side_effect=fake_total)
        ), patch.object(
            forecast_history,
            "load_historical_per_slot_forecast",
            new=AsyncMock(side_effect=fake_per_slot),
        ):
            samples = await forecast_history.load_trainer_samples(
                hass=SimpleNamespace(config=SimpleNamespace(time_zone="UTC")),
                cfg=cfg,
                now=datetime(2026, 4, 25, 10, 0, tzinfo=TZ),
            )

        assert samples == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_solar_bias_forecast_history.py::LoadTrainerSamplesTests -v`
Expected: FAIL — samples either missing the new field or never dropped without per-slot data.

- [ ] **Step 3: Update `load_trainer_samples`**

Replace the body of `load_trainer_samples` in `custom_components/helman/solar_bias_correction/forecast_history.py` (currently lines 66-95) with:

```python
async def load_trainer_samples(
    hass: HomeAssistant, cfg: BiasConfig, now: datetime
) -> list[TrainerSample]:
    entity_ids = _read_entity_ids(cfg.daily_energy_entity_ids)
    if not entity_ids:
        return []

    local_now = dt_util.as_local(now)
    today = local_now.date()
    samples: list[TrainerSample] = []

    for offset in range(90, 0, -1):
        target_date = today - timedelta(days=offset)
        forecast_wh = await _read_day_forecast_wh(
            hass,
            entity_ids,
            target_date,
            local_now=local_now,
        )
        if forecast_wh is None:
            continue

        slot_forecast_wh = await load_historical_per_slot_forecast(
            hass,
            cfg,
            target_date,
            local_now=local_now,
        )
        if not slot_forecast_wh:
            # Recorder retention exhausted or attribute missing — cannot train this day.
            continue

        samples.append(
            TrainerSample(
                date=str(target_date),
                forecast_wh=forecast_wh,
                slot_forecast_wh=slot_forecast_wh,
            )
        )

    return samples
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_solar_bias_forecast_history.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add custom_components/helman/solar_bias_correction/forecast_history.py tests/test_solar_bias_forecast_history.py
git commit -m "feat(solar-bias): trainer samples carry per-slot forecast"
```

---

### Task 4: Rewrite `train()` to use real per-slot forecasts

The new algorithm:
- Determine the slot keys present across samples (whatever granularity the provider published — currently hourly).
- For each usable day: accumulate `forecast_wh` and `actual_in_slot` per **forecast** slot. Aggregate fine-grained actuals up to the forecast's slot keys (sum every actual whose slot floored to the forecast slot). For an hourly forecast slot `12:00`, the actuals contributing are slots `12:00, 12:15, 12:30, 12:45`.
- `factor[slot] = sum_actual / sum_forecast`, clamped to [clamp_min, clamp_max].
- A forecast slot is omitted if `sum_forecast < _SLOT_FORECAST_SUM_FLOOR_WH` (zero-output slots like 02:00 — no point computing a factor; default 1.0 in adjuster).

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/trainer.py`
- Test: `tests/test_solar_bias_trainer.py`

- [ ] **Step 1: Update existing tests for new `TrainerSample` field**

Existing tests build `TrainerSample(date=..., forecast_wh=...)`. With the field added in Task 1, those calls now require `slot_forecast_wh` (dataclass without default).

In `tests/test_solar_bias_trainer.py`, add a helper near the top after the existing helpers (line 43):

```python
def make_uniform_slot_forecast(forecast_wh: float, slots: list[str] | None = None) -> dict[str, float]:
    """Spread forecast evenly across hourly slots (00:00..23:00)."""
    keys = slots if slots is not None else [f"{h:02d}:00" for h in range(24)]
    if not keys:
        return {}
    per = forecast_wh / len(keys)
    return {k: per for k in keys}
```

Then in every existing `TrainerSample(date=..., forecast_wh=X)` call in the file, change to:

```python
TrainerSample(date=..., forecast_wh=X, slot_forecast_wh=make_uniform_slot_forecast(X))
```

Use `grep -n "TrainerSample(" tests/test_solar_bias_trainer.py` to find all sites; each one needs the new keyword arg. After each edit, run the file once to confirm no more `TypeError` on construction.

- [ ] **Step 2: Add the failing behavior test**

Append to `tests/test_solar_bias_trainer.py`:

```python
def test_factors_match_per_slot_actual_over_forecast():
    """factor[slot] = sum(actual_in_slot) / sum(forecast_in_slot), regardless of day total."""
    cfg = make_cfg(min_history_days=2, clamp_min=0.5, clamp_max=2.0)

    # Realistic single-hour forecast: 9 kWh at 12:00, 0 elsewhere.
    slot_forecast = {f"{h:02d}:00": 0.0 for h in range(24)}
    slot_forecast["12:00"] = 9000.0

    # Actuals: 4 quarters making up the 12:00 hour total 9000 Wh.
    actuals_full = {f"{h:02d}:{m:02d}": 0.0 for h in range(24) for m in (0, 15, 30, 45)}
    actuals_full["12:00"] = 2000.0
    actuals_full["12:15"] = 2500.0
    actuals_full["12:30"] = 2500.0
    actuals_full["12:45"] = 2000.0  # sum = 9000

    samples = [
        models.TrainerSample(
            date=f"2026-04-{15+i:02d}",
            forecast_wh=9000.0,
            slot_forecast_wh=dict(slot_forecast),
        )
        for i in range(2)
    ]
    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={s.date: dict(actuals_full) for s in samples}
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    assert outcome.metadata.last_outcome == "profile_trained"
    # Sum of 4 quarters / hourly forecast = 9000/9000 = 1.0 → factor at 12:00 must be ~1.0
    assert "12:00" in outcome.profile.factors
    assert abs(outcome.profile.factors["12:00"] - 1.0) < 1e-6
    # Slots with zero forecast must be omitted, not pinned to clamp_min
    assert "00:00" in outcome.profile.omitted_slots
    assert "00:00" not in outcome.profile.factors


def test_factors_not_pinned_to_clamps_when_forecast_is_realistic():
    """Regression test: previous algorithm pinned night to clamp_min and noon to clamp_max."""
    cfg = make_cfg(min_history_days=1, clamp_min=0.3, clamp_max=2.0)

    # Diurnal hourly forecast (Wh), totaling ~60 kWh.
    diurnal = {
        "06:00": 364.0, "07:00": 1292.5, "08:00": 3010.75, "09:00": 4747.75,
        "10:00": 6554.25, "11:00": 7995.75, "12:00": 8997.5, "13:00": 9158.25,
        "14:00": 8480.5, "15:00": 7262.5, "16:00": 5857.75, "17:00": 4044.5,
        "18:00": 1726.5, "19:00": 302.75,
    }
    slot_forecast = {f"{h:02d}:00": diurnal.get(f"{h:02d}:00", 0.0) for h in range(24)}

    # Actuals match forecast exactly, evenly split across 4 quarters in each hour.
    actuals = {f"{h:02d}:{m:02d}": 0.0 for h in range(24) for m in (0, 15, 30, 45)}
    for hour_key, hour_wh in diurnal.items():
        h = int(hour_key.split(":")[0])
        per_q = hour_wh / 4
        for m in (0, 15, 30, 45):
            actuals[f"{h:02d}:{m:02d}"] = per_q

    samples = [
        models.TrainerSample(
            date="2026-04-24",
            forecast_wh=sum(diurnal.values()),
            slot_forecast_wh=slot_forecast,
        ),
    ]
    actuals_window = models.SolarActualsWindow(
        slot_actuals_by_date={"2026-04-24": actuals}
    )

    outcome = trainer.train(samples, actuals_window, cfg, now=datetime.utcnow())
    assert outcome.metadata.last_outcome == "profile_trained"
    # All non-zero forecast slots have factor ~1.0 (perfect match)
    for slot, fcast in slot_forecast.items():
        if fcast > 0:
            assert slot in outcome.profile.factors, slot
            assert abs(outcome.profile.factors[slot] - 1.0) < 1e-6, (slot, outcome.profile.factors[slot])
    # No factor pinned to clamp boundaries
    vals = list(outcome.profile.factors.values())
    assert min(vals) > cfg.clamp_min + 1e-6
    assert max(vals) < cfg.clamp_max - 1e-6
```

- [ ] **Step 3: Run tests to confirm they fail**

Run: `pytest tests/test_solar_bias_trainer.py -v`
Expected:
- `test_factors_match_per_slot_actual_over_forecast` FAILS — current trainer ignores `slot_forecast_wh` and uses uniform distribution.
- `test_factors_not_pinned_to_clamps_when_forecast_is_realistic` FAILS for the same reason.
- Existing tests should already pass (they were updated in Step 1 to provide `slot_forecast_wh` from the helper, but the trainer logic still uses `forecast_wh / 96` so uniform actuals match uniform forecast and factors come out 1.0 — that is OK).

- [ ] **Step 4: Rewrite the `train()` function**

Replace the body of `train()` in `custom_components/helman/solar_bias_correction/trainer.py` (currently lines 45-143) with:

```python
def train(
    samples: list[TrainerSample],
    actuals: SolarActualsWindow,
    cfg: BiasConfig,
    now: datetime,
) -> TrainingOutcome:
    fingerprint = compute_fingerprint(cfg)

    usable_samples: List[TrainerSample] = []
    dropped_days: List[Dict[str, str]] = []

    for s in samples:
        if s.forecast_wh < _DAY_FORECAST_FLOOR_WH:
            dropped_days.append({"date": s.date, "reason": "day_forecast_too_low"})
            continue

        day_actuals = actuals.slot_actuals_by_date.get(s.date, {})
        sum_actual = sum(day_actuals.values())

        ratio = sum_actual / s.forecast_wh if s.forecast_wh else 0.0
        if ratio < _DAY_RATIO_MIN or ratio > _DAY_RATIO_MAX:
            dropped_days.append(
                {
                    "date": s.date,
                    "reason": "day_ratio_out_of_band",
                    "forecast_wh": f"{s.forecast_wh:.3f}",
                    "actual_wh": f"{sum_actual:.3f}",
                    "ratio": f"{ratio:.6f}",
                }
            )
            continue

        usable_samples.append(s)

    usable_days = len(usable_samples)
    trained_at = now.isoformat()

    if usable_days < cfg.min_history_days:
        profile = SolarBiasProfile(factors={}, omitted_slots=list(_ALL_SLOTS))
        metadata = SolarBiasMetadata(
            trained_at=trained_at,
            training_config_fingerprint=fingerprint,
            usable_days=usable_days,
            dropped_days=dropped_days,
            factor_min=None,
            factor_max=None,
            factor_median=None,
            omitted_slot_count=len(_ALL_SLOTS),
            last_outcome="insufficient_history",
            error_reason=None,
        )
        return TrainingOutcome(profile=profile, metadata=metadata)

    # Determine the union of forecast slot keys across usable days.
    forecast_slot_keys: set[str] = set()
    for s in usable_samples:
        forecast_slot_keys.update(s.slot_forecast_wh.keys())

    # Accumulate per-slot forecast and actual sums at the forecast's native granularity.
    slot_forecast_sums: Dict[str, float] = {slot: 0.0 for slot in forecast_slot_keys}
    slot_actual_sums: Dict[str, float] = {slot: 0.0 for slot in forecast_slot_keys}

    sorted_forecast_slots = sorted(forecast_slot_keys, key=_slot_to_minutes)
    for s in usable_samples:
        day_actuals = actuals.slot_actuals_by_date.get(s.date, {})
        for slot in sorted_forecast_slots:
            slot_forecast_sums[slot] += s.slot_forecast_wh.get(slot, 0.0)
            slot_actual_sums[slot] += _aggregate_actuals_into_forecast_slot(
                day_actuals,
                forecast_slot=slot,
                forecast_slot_keys=sorted_forecast_slots,
            )

    factors: Dict[str, float] = {}
    omitted_slots: List[str] = []

    for slot in sorted_forecast_slots:
        fcast = slot_forecast_sums[slot]
        if fcast < _SLOT_FORECAST_SUM_FLOOR_WH:
            omitted_slots.append(slot)
            continue

        raw = slot_actual_sums[slot] / fcast if fcast else 0.0
        clamped = max(cfg.clamp_min, min(raw, cfg.clamp_max))
        factors[slot] = clamped

    factor_values = list(factors.values())
    factor_min = min(factor_values) if factor_values else None
    factor_max = max(factor_values) if factor_values else None
    factor_median = _median(factor_values) if factor_values else None

    profile = SolarBiasProfile(factors=factors, omitted_slots=omitted_slots)
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
        error_reason=None,
    )

    return TrainingOutcome(profile=profile, metadata=metadata)


def _slot_to_minutes(slot: str) -> int:
    h, m = slot.split(":")
    return int(h) * 60 + int(m)


def _aggregate_actuals_into_forecast_slot(
    day_actuals: dict[str, float],
    *,
    forecast_slot: str,
    forecast_slot_keys: list[str],
) -> float:
    """Sum every actual whose slot start falls in [forecast_slot, next_forecast_slot)."""
    start = _slot_to_minutes(forecast_slot)
    idx = forecast_slot_keys.index(forecast_slot)
    if idx + 1 < len(forecast_slot_keys):
        end = _slot_to_minutes(forecast_slot_keys[idx + 1])
    else:
        end = 24 * 60  # last forecast slot of day extends to end of day
    total = 0.0
    for actual_slot, value in day_actuals.items():
        try:
            minutes = _slot_to_minutes(actual_slot)
        except (ValueError, AttributeError):
            continue
        if start <= minutes < end:
            total += value
    return total
```

- [ ] **Step 5: Run all trainer tests to verify they pass**

Run: `pytest tests/test_solar_bias_trainer.py -v`
Expected: all PASS, including the two new behavior tests.

- [ ] **Step 6: Run the full bias-correction test suite to catch regressions**

Run: `pytest tests/test_solar_bias_models.py tests/test_solar_bias_trainer.py tests/test_solar_bias_forecast_history.py tests/test_solar_bias_actuals.py tests/test_solar_bias_adjuster.py tests/test_solar_bias_response.py tests/test_solar_bias_service_runtime.py tests/test_solar_bias_inspector.py tests/test_solar_bias_websocket.py tests/test_solar_bias_config_validation.py -v`
Expected: all PASS. If `test_solar_bias_service_runtime.py` constructs `TrainerSample` directly, update those constructors to pass `slot_forecast_wh={}` and re-run.

- [ ] **Step 7: Commit**

```bash
git add custom_components/helman/solar_bias_correction/trainer.py tests/test_solar_bias_trainer.py
git commit -m "fix(solar-bias): compute factors from real per-slot forecasts"
```

If service runtime tests required updates, include them in this commit.

---

## Phase 2 — Inspector chart fix

The chart needs to plot forecast and actuals on a comparable y-axis. Switch to **average power**: convert each point's energy to power using the gap between successive points (`Wh / hours = W`). The totals box keeps showing kWh.

### Task 5: Add a "to-power" helper and update chart rendering

**Files:**
- Modify: `custom_components/helman/frontend/src/bias-correction-inspector.ts:312-401` (the `_renderChart` method)

- [ ] **Step 1: Inspect current chart rendering**

Read `custom_components/helman/frontend/src/bias-correction-inspector.ts` lines 312-401. Confirm: `chartPoints` returns `{point, minutes}`; `linePath` plots `valueWh`; y-axis label is `kWh`.

- [ ] **Step 2: Replace `_renderChart` body**

In `custom_components/helman/frontend/src/bias-correction-inspector.ts`, replace the body of `_renderChart` (currently lines ~312-401, starting after the method signature and ending before `_renderFactorBands`) with the following. Keep the method signature and surrounding code unchanged.

```ts
    const width = 720;
    const height = 260;
    const margin = { top: 18, right: 24, bottom: 34, left: 48 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;

    const pointMinutes = (timestamp: string) => {
      const match = timestamp.match(/T(\d{2}):(\d{2})/);
      if (!match) return null;
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (
        !Number.isFinite(hour) ||
        !Number.isFinite(minute) ||
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59
      ) {
        return null;
      }
      return hour * 60 + minute;
    };

    type ChartEntry = { point: InspectorPoint; minutes: number; powerW: number };

    const toAveragePower = (points: InspectorPoint[]): ChartEntry[] => {
      const parsed = points
        .map((point) => ({ point, minutes: pointMinutes(point.timestamp) }))
        .filter(
          (entry): entry is { point: InspectorPoint; minutes: number } =>
            entry.minutes !== null && Number.isFinite(entry.point.valueWh),
        )
        .sort((a, b) => a.minutes - b.minutes);

      if (parsed.length === 0) return [];

      // Estimate bucket size in minutes per point. Use the gap to the next point;
      // for the last point reuse the previous gap. If only one point, default to 60.
      const gaps: number[] = [];
      for (let i = 0; i < parsed.length - 1; i++) {
        gaps.push(parsed[i + 1].minutes - parsed[i].minutes);
      }
      const fallbackGap = parsed.length === 1 ? 60 : gaps[gaps.length - 1] ?? 60;

      return parsed.map((entry, index) => {
        const gap = index < gaps.length ? gaps[index] : fallbackGap;
        const hours = gap / 60;
        const powerW = hours > 0 ? entry.point.valueWh / hours : 0;
        return { point: entry.point, minutes: entry.minutes, powerW };
      });
    };

    const rawPoints = toAveragePower(payload.series.raw);
    const correctedPoints = toAveragePower(payload.series.corrected);
    const actualPoints = toAveragePower(payload.series.actual);
    const allPower = [
      ...rawPoints.map((entry) => entry.powerW),
      ...correctedPoints.map((entry) => entry.powerW),
      ...actualPoints.map((entry) => entry.powerW),
    ];
    const maxW = Math.max(1000, ...allPower);
    const maxKw = Math.ceil(maxW / 1000);
    const yTicks = this._buildYTicks(maxKw);

    const xForMinutes = (minutes: number) => margin.left + (minutes / 1440) * plotWidth;
    const yForW = (powerW: number) =>
      margin.top + plotHeight - (powerW / (maxKw * 1000)) * plotHeight;

    const linePath = (points: ChartEntry[]) =>
      points
        .map((entry, index) => {
          const command = index === 0 ? "M" : "L";
          return `${command}${xForMinutes(entry.minutes).toFixed(1)},${yForW(entry.powerW).toFixed(1)}`;
        })
        .join(" ");

    return svg`
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label=${this._t("bias_correction.inspector.title")}>
        <rect x="0" y="0" width=${width} height=${height} fill="var(--card-background-color)"></rect>
        ${this._renderFactorBands(payload.series.factors, margin.left, margin.top, plotWidth, plotHeight)}
        ${yTicks.map((tick) => {
          const y = yForW(tick * 1000);
          return svg`
            <line x1=${margin.left} y1=${y} x2=${width - margin.right} y2=${y} stroke="var(--divider-color)" stroke-width="1"></line>
            <text x=${margin.left - 8} y=${y + 4} text-anchor="end" fill="var(--secondary-text-color)" font-size="11">${tick.toFixed(1)}</text>
          `;
        })}
        ${[0, 3, 6, 9, 12, 15, 18, 21, 24].map((hour) => {
          const x = margin.left + (hour / 24) * plotWidth;
          return svg`
            <line x1=${x} y1=${margin.top} x2=${x} y2=${height - margin.bottom} stroke="var(--divider-color)" stroke-width="1" opacity="0.55"></line>
            <text x=${x} y=${height - 10} text-anchor="middle" fill="var(--secondary-text-color)" font-size="11">${String(hour).padStart(2, "0")}</text>
          `;
        })}
        <text x="12" y="16" fill="var(--secondary-text-color)" font-size="11">${this._t("bias_correction.inspector.power_axis_label")}</text>
        ${rawPoints.length > 1
          ? svg`<path d=${linePath(rawPoints)} fill="none" stroke="#1565c0" stroke-width="2.4"></path>`
          : rawPoints.length === 1
            ? svg`<circle cx=${xForMinutes(rawPoints[0].minutes)} cy=${yForW(rawPoints[0].powerW)} r="3.5" fill="#1565c0"></circle>`
            : ""}
        ${correctedPoints.length > 1
          ? svg`<path d=${linePath(correctedPoints)} fill="none" stroke="#2e7d32" stroke-width="2.4"></path>`
          : correctedPoints.length === 1
            ? svg`<circle cx=${xForMinutes(correctedPoints[0].minutes)} cy=${yForW(correctedPoints[0].powerW)} r="3.5" fill="#2e7d32"></circle>`
          : ""}
        ${actualPoints.map((entry) => svg`
          <circle cx=${xForMinutes(entry.minutes)} cy=${yForW(entry.powerW)} r="3.5" fill="#c62828"></circle>
        `)}
      </svg>
    `;
```

- [ ] **Step 3: Add the new translation key**

In `custom_components/helman/frontend/src/localize/translations/en.json` (around line 414, in the `inspector` block, after `"correction_factor"`), add:

```json
      "power_axis_label": "kW (avg)",
```

In `custom_components/helman/frontend/src/localize/translations/cs.json`, find the equivalent `inspector` block and add:

```json
      "power_axis_label": "kW (prům.)",
```

(If the Czech file has different existing strings or wording — match its tone. If you cannot translate confidently, copy the English value and put a TODO comment in the PR description, not in the JSON.)

- [ ] **Step 4: Build the frontend**

Run from `custom_components/helman/frontend/`:

```bash
cd custom_components/helman/frontend
npm run build
```

Expected: vite build succeeds; `dist/helman-config-editor.js` is updated. (Per `frontend/CLAUDE.md`, this dist file MUST be committed alongside source changes.)

- [ ] **Step 5: Manual verification**

Restart the Home Assistant dev container (or reload the integration). Open the Helman config panel → Bias correction → Visual inspector.

Expected on a sunny day where forecast ≈ actual:
- Y-axis labelled `kW (avg)`.
- Raw and corrected forecast lines now peak around the same kW value as the actual production dots.
- The actual production dots cluster ON or near the corrected/raw line during daylight, not 4× lower.
- Daily totals at the bottom unchanged (still kWh).

If anything looks off, check browser console for parse errors and confirm `dist/helman-config-editor.js` was rebuilt.

- [ ] **Step 6: Commit**

```bash
git add custom_components/helman/frontend/src/bias-correction-inspector.ts \
        custom_components/helman/frontend/src/localize/translations/en.json \
        custom_components/helman/frontend/src/localize/translations/cs.json \
        custom_components/helman/frontend/dist/helman-config-editor.js
git commit -m "fix(solar-bias-inspector): plot series as average power so granularities align"
```

---

## Phase 3 — Operational verification

### Task 6: Force a retrain and confirm the fix end-to-end

- [ ] **Step 1: Restart Home Assistant**

Use the project's `local-hass-control` skill or `ha core restart` to pick up the new code.

- [ ] **Step 2: Inspect the previous (broken) profile for comparison**

```bash
cat /home/ondra/dev/hass/hass-core/config/.storage/helman.solar_bias_correction \
  | python3 -c "import json,sys;d=json.load(sys.stdin);f=d['data']['profile']['factors'];print('min',min(f.values()),'max',max(f.values()),'pinned_to_clamp_min',sum(1 for v in f.values() if abs(v-0.3)<1e-6),'pinned_to_clamp_max',sum(1 for v in f.values() if abs(v-2.0)<1e-6))"
```

Record the numbers (expected current state: many slots pinned at 0.3 and 2.0).

- [ ] **Step 3: Trigger retraining**

Either click "Train now" in the bias correction status panel, or via the API:

```bash
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://127.0.0.1:8123/api/services/helman/solar_bias_train -d '{}'
```

(Match the exact service name your installation registers — search for `async_register` in `custom_components/helman` if uncertain.)

- [ ] **Step 4: Re-inspect the new profile**

Re-run the python one-liner from Step 2.

Expected:
- `min` strictly greater than `clamp_min` (0.3) for daylight slots, OR a far smaller number of clamp-pinned slots.
- `max` strictly less than `clamp_max` (2.0) for the typical day, OR clamp-pinning only on truly anomalous slots.
- Far fewer factors at exactly 0.3 / 2.0.
- Slot keys may be 24 hourly entries (since the provider publishes hourly), not 96.

- [ ] **Step 5: Verify inspector output**

Open the inspector for "Today". Expected:
- "Raw forecast" and "Corrected forecast" totals within ~15% of each other on a normal day. (On 2026-04-25 with raw 69.8 and actual 69.5, corrected should land in roughly 60-80 kWh, not 112 kWh.)
- Chart: corrected forecast line tracks the raw line at ~similar amplitude; actuals dots overlap the lines around peak hours.
- Factor bands display a smooth diurnal pattern, not a sharp bimodal pin to clamp colours.

- [ ] **Step 6 (optional): Document an honest retention note**

If `min_history_days <= recorder retention days`, no action.

If you discover that recorder retention is shorter than `min_history_days`, file a follow-up to either increase recorder `purge_keep_days` for `daily_energy_entity_ids[0]`, or add a snapshotting layer (out of scope here). Mention in the PR description.

- [ ] **Step 7: Commit any documentation tweaks**

If you added comments or doc updates during verification:

```bash
git add ...
git commit -m "docs(solar-bias): note recorder attribute retention requirement"
```

---

## Self-Review Checklist (already applied during plan authoring)

- **Spec coverage:** trainer algorithm fix (Tasks 1-4), historical forecast loader (Task 2), chart fix (Task 5), operational verification (Task 6). Covered.
- **Type consistency:** `slot_forecast_wh: dict[str, float]` used identically in `models.py`, `forecast_history.py`, `trainer.py`, and tests. `forecast_slot_keys` (sorted list) used inside trainer only. `ChartEntry` type local to `_renderChart`.
- **Placeholders:** none. Every step contains exact code or exact commands. Czech translation has an explicit fallback instruction.
- **Order:** model field → loader → wiring → algorithm → tests → chart → manual verification. Each task is independently committable.

---

## Out of scope (deliberate non-goals)

- Snapshotting daily forecasts to a dedicated store (would let training reach beyond recorder retention; bigger refactor).
- Changing the persisted profile schema. The schema accepts any slot keys (24 hourly or 96 quarter-hourly). Existing profiles continue to deserialize via `_profile_from_dict`. The adjuster's `profile.factors.get(slot, 1.0)` correctly returns 1.0 for any quarter-hour slot not present in a 24-key hourly profile.
- Reworking factor band rendering. With hourly factors the bands will become 24 wide bands (1/24 of plot width each). If the visual gap looks bad in practice, follow up by switching `bandWidth = Math.max(2, plotWidth / 96)` to derive the count from `factors.length`. Keep it minimal — only change if needed.
- Migrating `_DAY_RATIO_*` thresholds. The day-level total/total ratio remains a useful sanity check independent of the per-slot fix.
- Adjuster changes. The adjuster already does `factor = profile.factors.get(slot, 1.0)`, which works for any slot granularity in the profile.

---

## Quick reference for the next session

- Today (2026-04-25) numbers used to validate: raw forecast 69.8 kWh, actual 69.5 kWh, broken corrected 112.8 kWh.
- Key files: `solar_bias_correction/{trainer.py, forecast_history.py, models.py}`; `frontend/src/bias-correction-inspector.ts`.
- Storage location: `/home/ondra/dev/hass/hass-core/config/.storage/helman.solar_bias_correction`.
- Forecast entity providing `wh_period`: `sensor.energy_production_today` (and d1..d7).
- Total energy entity for actuals: `sensor.solax_total_solar_energy`.
- Daily total sensor (cross-check): `sensor.solax_today_s_solar_energy`.
- Default clamps in const.py: `CLAMP_MIN=0.3`, `CLAMP_MAX=2.0`, `MIN_HISTORY_DAYS=10`.
- After any frontend source change, MUST run `npm run build` in `custom_components/helman/frontend/` and commit the rebuilt `dist/helman-config-editor.js` (per `frontend/CLAUDE.md`).
