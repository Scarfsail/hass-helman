# Solar Bias Inspector Slot Explainability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add clickable correction-impact columns to the solar bias inspector and show selected-slot day values plus stored training contribution rows explaining the applied factor.

**Architecture:** Persist a training explainability snapshot with each trained solar bias profile, expose it through the existing selected-day inspector websocket payload, and render a combined chart plus selected-slot detail panel in the existing Lit inspector component. Keep the endpoint selected-day oriented; the chart data changes per requested day, while the training explainability snapshot explains the current stored profile for all slots.

**Tech Stack:** Python dataclasses and pytest for backend logic, Home Assistant websocket payloads, Lit 3 TypeScript component code, Vite TypeScript build for frontend verification.

---

## File Structure

- Modify `custom_components/helman/solar_bias_correction/models.py`
  Add dataclasses for training explainability rows/slots/snapshot and selected-day impact points. Extend inspector payload serialization.
- Modify `custom_components/helman/solar_bias_correction/trainer.py`
  Build the explainability snapshot during training using the same usable-day, invalidation, aggregation, and clamp logic as factor computation.
- Modify `custom_components/helman/solar_bias_correction/service.py`
  Persist and load the explainability snapshot, include it in serialized state, and add selected-day impact rows to the inspector response.
- Modify `tests/test_solar_bias_trainer.py`
  Cover ratio-of-sums rows, invalidated rows, omitted slots, dropped days, and trimmed-mean trimmed rows.
- Modify `tests/test_solar_bias_inspector.py`
  Cover payload serialization, inspector impact rows, and backward compatibility when a stored profile has no explainability snapshot.
- Modify `tests/test_solar_bias_store.py`
  Cover loading stored explainability and loading old profiles without it.
- Create `custom_components/helman/frontend/src/bias-correction-inspector-model.ts`
  Isolate selected-slot helper logic: default selection, day-value lookup, and training slot lookup.
- Create `custom_components/helman/frontend/test/bias-correction-inspector-model.test.ts`
  Test the helper functions without needing a browser DOM.
- Modify `custom_components/helman/frontend/src/bias-correction-inspector.ts`
  Render combined chart impact columns, keep selected slot across days, and render selected-day details plus contribution table.
- Modify `custom_components/helman/frontend/src/localize/translations/en.json`
  Add labels for selected slot details and table columns.
- Modify `custom_components/helman/frontend/src/localize/translations/cs.json`
  Add matching Czech keys. Use clear English fallback text if no Czech-specific wording is available in this codebase style.

---

### Task 1: Backend Models And Payload Serialization

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/models.py`
- Modify: `tests/test_solar_bias_inspector.py`

- [ ] **Step 1: Write failing serialization tests**

Add this test near `test_inspector_day_serializes_frontend_contract` in `tests/test_solar_bias_inspector.py`:

```python
def test_inspector_day_serializes_impact_and_training_explainability():
    payload = models.inspector_day_to_payload(
        models.SolarBiasInspectorDay(
            date="2026-04-25",
            timezone="Europe/Prague",
            status="applied",
            effective_variant="adjusted",
            trained_at="2026-04-25T03:00:04+02:00",
            min_date="2026-04-18",
            max_date="2026-04-27",
            series=models.SolarBiasInspectorSeries(
                raw=[],
                corrected=[],
                actual=[],
                factors=[models.SolarBiasFactorPoint(slot="12:00", factor=1.34)],
                impact=[
                    models.SolarBiasImpactPoint(
                        slot="12:00",
                        raw_wh=840.0,
                        corrected_wh=1120.0,
                        impact_wh=280.0,
                        factor=1.34,
                    )
                ],
            ),
            totals=models.SolarBiasInspectorTotals(
                raw_wh=None,
                corrected_wh=None,
                actual_wh=None,
            ),
            availability=models.SolarBiasInspectorAvailability(
                has_raw_forecast=False,
                has_corrected_forecast=False,
                has_actuals=False,
                has_profile=True,
            ),
            is_today=True,
            is_future=False,
            training_explainability=models.SolarBiasTrainingExplainability(
                trained_at="2026-04-25T03:00:04+02:00",
                aggregation_method="ratio_of_sums",
                slots={
                    "12:00": models.SolarBiasSlotExplainability(
                        factor=1.34,
                        raw_ratio=1.34,
                        clamped=False,
                        forecast_sum_wh=1500.0,
                        actual_sum_wh=2010.0,
                        rows=[
                            models.SolarBiasContributionRow(
                                date="2026-04-21",
                                forecast_wh=520.0,
                                actual_wh=610.0,
                                ratio=1.1730769231,
                                status="included",
                                reason=None,
                            )
                        ],
                    )
                },
            ),
        )
    )

    assert payload["series"]["impact"] == [
        {
            "slot": "12:00",
            "rawWh": 840.0,
            "correctedWh": 1120.0,
            "impactWh": 280.0,
            "factor": 1.34,
        }
    ]
    assert payload["trainingExplainability"] == {
        "trainedAt": "2026-04-25T03:00:04+02:00",
        "aggregationMethod": "ratio_of_sums",
        "slots": {
            "12:00": {
                "factor": 1.34,
                "rawRatio": 1.34,
                "clamped": False,
                "forecastSumWh": 1500.0,
                "actualSumWh": 2010.0,
                "rows": [
                    {
                        "date": "2026-04-21",
                        "forecastWh": 520.0,
                        "actualWh": 610.0,
                        "ratio": 1.1730769231,
                        "status": "included",
                        "reason": None,
                    }
                ],
            }
        },
    }
```

- [ ] **Step 2: Run the serialization test to verify it fails**

Run:

```bash
pytest tests/test_solar_bias_inspector.py::test_inspector_day_serializes_impact_and_training_explainability -q
```

Expected: FAIL with `AttributeError` for `SolarBiasImpactPoint` or `SolarBiasTrainingExplainability`.

- [ ] **Step 3: Add dataclasses and serialization**

In `custom_components/helman/solar_bias_correction/models.py`, add these dataclasses after `SolarBiasFactorPoint`:

```python
@dataclass
class SolarBiasImpactPoint:
    slot: str
    raw_wh: float | None
    corrected_wh: float | None
    impact_wh: float | None
    factor: float | None


@dataclass
class SolarBiasContributionRow:
    date: str
    forecast_wh: float | None
    actual_wh: float | None
    ratio: float | None
    status: str
    reason: str | None = None


@dataclass
class SolarBiasSlotExplainability:
    factor: float | None
    raw_ratio: float | None
    clamped: bool
    forecast_sum_wh: float
    actual_sum_wh: float
    rows: list[SolarBiasContributionRow]


@dataclass
class SolarBiasTrainingExplainability:
    trained_at: str
    aggregation_method: str
    slots: dict[str, SolarBiasSlotExplainability]
```

Update `SolarBiasInspectorSeries`:

```python
@dataclass
class SolarBiasInspectorSeries:
    raw: list[SolarBiasInspectorPoint]
    corrected: list[SolarBiasInspectorPoint]
    actual: list[SolarBiasInspectorPoint]
    factors: list[SolarBiasFactorPoint]
    invalidated: list[SolarBiasInspectorPoint] = field(default_factory=list)
    impact: list[SolarBiasImpactPoint] = field(default_factory=list)
```

Update `SolarBiasInspectorDay`:

```python
@dataclass
class SolarBiasInspectorDay:
    date: str
    timezone: str
    status: str
    effective_variant: str | None
    trained_at: str | None
    min_date: str
    max_date: str
    series: SolarBiasInspectorSeries
    totals: SolarBiasInspectorTotals
    availability: SolarBiasInspectorAvailability
    is_today: bool
    is_future: bool
    training_explainability: SolarBiasTrainingExplainability | None = None
```

Add serializer helpers:

```python
def _impact_point_payload(point: SolarBiasImpactPoint) -> dict[str, Any]:
    return {
        "slot": point.slot,
        "rawWh": point.raw_wh,
        "correctedWh": point.corrected_wh,
        "impactWh": point.impact_wh,
        "factor": point.factor,
    }


def training_explainability_to_payload(
    explainability: SolarBiasTrainingExplainability | None,
) -> dict[str, Any] | None:
    if explainability is None:
        return None
    return {
        "trainedAt": explainability.trained_at,
        "aggregationMethod": explainability.aggregation_method,
        "slots": {
            slot: {
                "factor": details.factor,
                "rawRatio": details.raw_ratio,
                "clamped": details.clamped,
                "forecastSumWh": details.forecast_sum_wh,
                "actualSumWh": details.actual_sum_wh,
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
            for slot, details in sorted(explainability.slots.items())
        },
    }
```

Update `inspector_day_to_payload()`:

```python
"impact": [
    _impact_point_payload(point) for point in day.series.impact
],
```

Add this top-level key to the returned dict:

```python
"trainingExplainability": training_explainability_to_payload(
    day.training_explainability
),
```

- [ ] **Step 4: Run the serialization test**

Run:

```bash
pytest tests/test_solar_bias_inspector.py::test_inspector_day_serializes_impact_and_training_explainability -q
```

Expected: PASS.

- [ ] **Step 5: Run existing inspector serialization test**

Run:

```bash
pytest tests/test_solar_bias_inspector.py::test_inspector_day_serializes_frontend_contract -q
```

Expected: FAIL because the expected payload lacks `series.impact` and `trainingExplainability`.

Update the expected payload in `test_inspector_day_serializes_frontend_contract`:

```python
"impact": [],
```

inside `"series"`, and:

```python
"trainingExplainability": None,
```

at the top level.

- [ ] **Step 6: Run model/inspector tests**

Run:

```bash
pytest tests/test_solar_bias_inspector.py::test_inspector_day_serializes_frontend_contract tests/test_solar_bias_inspector.py::test_inspector_day_serializes_impact_and_training_explainability -q
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add custom_components/helman/solar_bias_correction/models.py tests/test_solar_bias_inspector.py
git commit -m "feat(solar-bias): add inspector explainability payload models"
```

---

### Task 2: Build Training Explainability Snapshot

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/trainer.py`
- Modify: `tests/test_solar_bias_trainer.py`

- [ ] **Step 1: Write failing ratio-of-sums explainability test**

Add to `tests/test_solar_bias_trainer.py`:

```python
def test_training_explainability_records_ratio_of_sums_rows():
    cfg = make_cfg(min_history_days=2, clamp_min=0.5, clamp_max=2.0)
    samples = [
        models.TrainerSample(
            date="2026-04-21",
            forecast_wh=1000.0,
            slot_forecast_wh={"12:00": 400.0, "13:00": 600.0},
        ),
        models.TrainerSample(
            date="2026-04-22",
            forecast_wh=1000.0,
            slot_forecast_wh={"12:00": 600.0, "13:00": 400.0},
        ),
    ]
    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            "2026-04-21": {"12:00": 500.0, "13:00": 600.0},
            "2026-04-22": {"12:00": 700.0, "13:00": 400.0},
        }
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime(2026, 4, 23, 3, 0))

    details = outcome.explainability.slots["12:00"]
    assert details.factor == 1.2
    assert details.raw_ratio == 1.2
    assert details.clamped is False
    assert details.forecast_sum_wh == 1000.0
    assert details.actual_sum_wh == 1200.0
    assert [(row.date, row.forecast_wh, row.actual_wh, row.status) for row in details.rows] == [
        ("2026-04-21", 400.0, 500.0, "included"),
        ("2026-04-22", 600.0, 700.0, "included"),
    ]
    assert abs(details.rows[0].ratio - 1.25) < 1e-9
    assert abs(details.rows[1].ratio - (700.0 / 600.0)) < 1e-9
```

- [ ] **Step 2: Run ratio-of-sums test to verify it fails**

Run:

```bash
pytest tests/test_solar_bias_trainer.py::test_training_explainability_records_ratio_of_sums_rows -q
```

Expected: FAIL with `AttributeError: 'TrainingOutcome' object has no attribute 'explainability'`.

- [ ] **Step 3: Add `explainability` to `TrainingOutcome`**

In `custom_components/helman/solar_bias_correction/models.py`, update `TrainingOutcome`:

```python
@dataclass
class TrainingOutcome:
    profile: SolarBiasProfile
    metadata: SolarBiasMetadata
    explainability: SolarBiasTrainingExplainability | None = None
```

This is part of the trainer task because the trainer creates this value.

- [ ] **Step 4: Implement ratio-of-sums snapshot builder**

In `custom_components/helman/solar_bias_correction/trainer.py`, import the new models:

```python
    SolarBiasContributionRow,
    SolarBiasSlotExplainability,
    SolarBiasTrainingExplainability,
```

Add this helper near `_training_day_totals()`:

```python
def _build_training_explainability(
    *,
    usable_samples: list[TrainerSample],
    dropped_days: list[dict[str, str]],
    actuals: SolarActualsWindow,
    cfg: BiasConfig,
    trained_at: str,
    forecast_slot_keys: list[str],
    factors: dict[str, float],
    omitted_slots: list[str],
    slot_forecast_sums: dict[str, float],
    slot_actual_sums: dict[str, float],
    slot_raw_ratios: dict[str, float | None],
) -> SolarBiasTrainingExplainability:
    slots: dict[str, SolarBiasSlotExplainability] = {}
    omitted_slot_set = set(omitted_slots)

    for slot in forecast_slot_keys:
        rows: list[SolarBiasContributionRow] = []
        for sample in usable_samples:
            invalidated = actuals.invalidated_slots_by_date.get(sample.date, set())
            day_forecast = float(sample.slot_forecast_wh.get(slot, 0.0))
            if slot in invalidated:
                rows.append(
                    SolarBiasContributionRow(
                        date=sample.date,
                        forecast_wh=day_forecast,
                        actual_wh=None,
                        ratio=None,
                        status="invalidated",
                        reason="slot_invalidated",
                    )
                )
                continue
            if day_forecast <= 0.0:
                rows.append(
                    SolarBiasContributionRow(
                        date=sample.date,
                        forecast_wh=day_forecast,
                        actual_wh=None,
                        ratio=None,
                        status="forecast_zero",
                        reason="slot_forecast_zero",
                    )
                )
                continue
            day_actual = _aggregate_actuals_into_forecast_slot(
                actuals.slot_actuals_by_date.get(sample.date, {}),
                forecast_slot=slot,
                forecast_slot_keys=forecast_slot_keys,
            )
            rows.append(
                SolarBiasContributionRow(
                    date=sample.date,
                    forecast_wh=day_forecast,
                    actual_wh=day_actual,
                    ratio=day_actual / day_forecast,
                    status="included",
                    reason=None,
                )
            )

        for dropped in dropped_days:
            day = dropped.get("date")
            if not isinstance(day, str):
                continue
            rows.append(
                SolarBiasContributionRow(
                    date=day,
                    forecast_wh=None,
                    actual_wh=None,
                    ratio=None,
                    status="dropped_day",
                    reason=dropped.get("reason"),
                )
            )

        forecast_sum = float(slot_forecast_sums.get(slot, 0.0))
        actual_sum = float(slot_actual_sums.get(slot, 0.0))
        raw_ratio = slot_raw_ratios.get(slot)
        factor = factors.get(slot)
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
                        reason="slot_forecast_sum_too_low",
                    )
                ]
                if slot in omitted_slot_set
                else []
            ),
        )

    return SolarBiasTrainingExplainability(
        trained_at=trained_at,
        aggregation_method=cfg.aggregation_method,
        slots=slots,
    )
```

This initial helper handles `ratio_of_sums`. Task 3 refines it for `trimmed_mean`.

In `train()`, initialize raw-ratio storage before the final slot loop:

```python
    slot_raw_ratios: dict[str, float | None] = {}
```

Inside the final `for slot in sorted_forecast_slots:` loop, assign the raw ratio before clamp:

```python
        slot_raw_ratios[slot] = raw
```

Place that line after the `raw is None` guard and before:

```python
        clamped = max(cfg.clamp_min, min(raw, cfg.clamp_max))
```

After `factors` and `omitted_slots` are computed and before `return TrainingOutcome(...)`, add:

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
        slot_forecast_sums=slot_forecast_sums,
        slot_actual_sums=slot_actual_sums,
        slot_raw_ratios=slot_raw_ratios,
    )
```

Update the successful return:

```python
    return TrainingOutcome(
        profile=profile,
        metadata=metadata,
        explainability=explainability,
    )
```

For insufficient history, keep `explainability=None`.

- [ ] **Step 5: Run ratio-of-sums explainability test**

Run:

```bash
pytest tests/test_solar_bias_trainer.py::test_training_explainability_records_ratio_of_sums_rows -q
```

Expected: PASS.

- [ ] **Step 6: Write failing invalidated/dropped/omitted test**

Add:

```python
def test_training_explainability_marks_invalidated_dropped_and_omitted_rows():
    cfg = make_cfg(min_history_days=1, clamp_min=0.5, clamp_max=2.0)
    samples = [
        models.TrainerSample(
            date="2026-04-20",
            forecast_wh=50.0,
            slot_forecast_wh={"12:00": 50.0},
        ),
        models.TrainerSample(
            date="2026-04-21",
            forecast_wh=1000.0,
            slot_forecast_wh={"12:00": 40.0, "13:00": 960.0},
        ),
        models.TrainerSample(
            date="2026-04-22",
            forecast_wh=1000.0,
            slot_forecast_wh={"12:00": 40.0, "13:00": 960.0},
        ),
    ]
    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            "2026-04-20": {"12:00": 50.0},
            "2026-04-21": {"12:00": 40.0, "13:00": 960.0},
            "2026-04-22": {"12:00": 40.0, "13:00": 960.0},
        },
        invalidated_slots_by_date={"2026-04-21": {"12:00"}},
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime(2026, 4, 23, 3, 0))

    statuses = [(row.date, row.status, row.reason) for row in outcome.explainability.slots["12:00"].rows]
    assert ("2026-04-21", "invalidated", "slot_invalidated") in statuses
    assert ("2026-04-20", "dropped_day", "day_forecast_too_low") in statuses
    assert ("", "omitted_slot", "slot_forecast_sum_too_low") in statuses
    assert "12:00" in outcome.profile.omitted_slots
```

- [ ] **Step 7: Run invalidated/dropped/omitted test**

Run:

```bash
pytest tests/test_solar_bias_trainer.py::test_training_explainability_marks_invalidated_dropped_and_omitted_rows -q
```

Expected: PASS after the helper from Step 4.

- [ ] **Step 8: Run full trainer tests**

Run:

```bash
pytest tests/test_solar_bias_trainer.py -q
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```bash
git add custom_components/helman/solar_bias_correction/models.py custom_components/helman/solar_bias_correction/trainer.py tests/test_solar_bias_trainer.py
git commit -m "feat(solar-bias): store training explainability rows"
```

---

### Task 3: Trimmed-Mean Explainability Status

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/trainer.py`
- Modify: `tests/test_solar_bias_trainer.py`

- [ ] **Step 1: Write failing trimmed-mean explainability test**

Add:

```python
def test_training_explainability_marks_trimmed_mean_removed_rows():
    cfg = make_cfg(
        min_history_days=4,
        clamp_min=0.0,
        clamp_max=5.0,
        aggregation_method="trimmed_mean",
    )
    slot = "12:00"
    per_day = [
        ("2026-04-20", 100.0, 50.0),
        ("2026-04-21", 100.0, 100.0),
        ("2026-04-22", 100.0, 200.0),
        ("2026-04-23", 100.0, 400.0),
    ]
    samples = [
        models.TrainerSample(
            date=day,
            forecast_wh=1000.0,
            slot_forecast_wh={slot: forecast, "13:00": 900.0},
        )
        for day, forecast, _actual in per_day
    ]
    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            day: {slot: actual, "13:00": 900.0}
            for day, _forecast, actual in per_day
        }
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime(2026, 4, 24, 3, 0))

    rows = outcome.explainability.slots[slot].rows
    by_date = {row.date: row for row in rows}
    assert by_date["2026-04-20"].status == "trimmed"
    assert by_date["2026-04-20"].reason == "trimmed_mean_low"
    assert by_date["2026-04-23"].status == "trimmed"
    assert by_date["2026-04-23"].reason == "trimmed_mean_high"
    assert by_date["2026-04-21"].status == "included"
    assert by_date["2026-04-22"].status == "included"
    assert outcome.explainability.slots[slot].raw_ratio == 1.5
    assert outcome.profile.factors[slot] == 1.5
```

- [ ] **Step 2: Run trimmed-mean test to verify it fails**

Run:

```bash
pytest tests/test_solar_bias_trainer.py::test_training_explainability_marks_trimmed_mean_removed_rows -q
```

Expected: FAIL because all valid rows are marked `included`.

- [ ] **Step 3: Refine `_build_training_explainability()` for trimmed mean**

Inside `_build_training_explainability()`, after `rows` are built for a slot and before assigning `SolarBiasSlotExplainability`, add:

```python
        if cfg.aggregation_method == "trimmed_mean":
            ratio_rows = [
                row for row in rows
                if row.status == "included" and row.ratio is not None
            ]
            if len(ratio_rows) >= 3:
                low = min(ratio_rows, key=lambda row: row.ratio or 0.0)
                high = max(ratio_rows, key=lambda row: row.ratio or 0.0)
                trimmed_rows = {id(low): "trimmed_mean_low", id(high): "trimmed_mean_high"}
                rows = [
                    SolarBiasContributionRow(
                        date=row.date,
                        forecast_wh=row.forecast_wh,
                        actual_wh=row.actual_wh,
                        ratio=row.ratio,
                        status="trimmed",
                        reason=trimmed_rows[id(row)],
                    )
                    if id(row) in trimmed_rows
                    else row
                    for row in rows
                ]
```

No raw-ratio change is needed in this task because Task 2 already passes `slot_raw_ratios`, which stores the pre-clamp raw value for both aggregation methods.

- [ ] **Step 4: Run trimmed-mean test**

Run:

```bash
pytest tests/test_solar_bias_trainer.py::test_training_explainability_marks_trimmed_mean_removed_rows -q
```

Expected: PASS.

- [ ] **Step 5: Run trainer tests**

Run:

```bash
pytest tests/test_solar_bias_trainer.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add custom_components/helman/solar_bias_correction/trainer.py tests/test_solar_bias_trainer.py
git commit -m "feat(solar-bias): explain trimmed mean slot contributions"
```

---

### Task 4: Persist And Load Explainability Snapshot

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/service.py`
- Modify: `tests/test_solar_bias_store.py`
- Modify: `tests/test_solar_bias_inspector.py`

- [ ] **Step 1: Write failing loader tests**

Add to `tests/test_solar_bias_store.py` near existing `_metadata_from_dict` tests:

```python
def test_training_explainability_from_dict_parses_valid_snapshot():
    service_mod = importlib.import_module(
        "custom_components.helman.solar_bias_correction.service"
    )

    parsed = service_mod._training_explainability_from_dict(
        {
            "trainedAt": "2026-04-25T03:00:00+02:00",
            "aggregationMethod": "ratio_of_sums",
            "slots": {
                "12:00": {
                    "factor": 1.34,
                    "rawRatio": 1.34,
                    "clamped": False,
                    "forecastSumWh": 1500,
                    "actualSumWh": 2010,
                    "rows": [
                        {
                            "date": "2026-04-21",
                            "forecastWh": 520,
                            "actualWh": 610,
                            "ratio": 1.1730769231,
                            "status": "included",
                            "reason": None,
                        }
                    ],
                }
            },
        }
    )

    assert parsed is not None
    assert parsed.trained_at == "2026-04-25T03:00:00+02:00"
    assert parsed.aggregation_method == "ratio_of_sums"
    assert parsed.slots["12:00"].rows[0].status == "included"


def test_training_explainability_from_dict_returns_none_for_missing_snapshot():
    service_mod = importlib.import_module(
        "custom_components.helman.solar_bias_correction.service"
    )

    assert service_mod._training_explainability_from_dict(None) is None
```

- [ ] **Step 2: Run loader tests to verify they fail**

Run:

```bash
pytest tests/test_solar_bias_store.py::test_training_explainability_from_dict_parses_valid_snapshot tests/test_solar_bias_store.py::test_training_explainability_from_dict_returns_none_for_missing_snapshot -q
```

Expected: FAIL because `_training_explainability_from_dict` does not exist.

- [ ] **Step 3: Add service field and loader helpers**

In `custom_components/helman/solar_bias_correction/service.py`, import:

```python
    SolarBiasContributionRow,
    SolarBiasSlotExplainability,
    SolarBiasTrainingExplainability,
    training_explainability_to_payload,
```

Add `self._explainability` in `__init__`:

```python
        self._explainability: SolarBiasTrainingExplainability | None = None
```

In `async_setup()`, when there is no stored profile or invalid stored data, set:

```python
            self._explainability = None
```

After metadata is loaded successfully:

```python
        self._explainability = _training_explainability_from_dict(
            stored.get("trainingExplainability", stored.get("training_explainability"))
        )
```

Add helper functions near `_metadata_from_dict()`:

```python
def _training_explainability_from_dict(
    raw_value: Any,
) -> SolarBiasTrainingExplainability | None:
    if not isinstance(raw_value, dict):
        return None
    trained_at = raw_value.get("trainedAt", raw_value.get("trained_at"))
    aggregation_method = raw_value.get(
        "aggregationMethod", raw_value.get("aggregation_method")
    )
    raw_slots = raw_value.get("slots")
    if not isinstance(trained_at, str) or not isinstance(aggregation_method, str):
        return None
    if not isinstance(raw_slots, dict):
        return None

    slots: dict[str, SolarBiasSlotExplainability] = {}
    for slot, raw_slot in raw_slots.items():
        if not isinstance(slot, str) or not isinstance(raw_slot, dict):
            continue
        raw_rows = raw_slot.get("rows")
        if not isinstance(raw_rows, list):
            continue
        rows: list[SolarBiasContributionRow] = []
        for raw_row in raw_rows:
            if not isinstance(raw_row, dict):
                continue
            date_value = raw_row.get("date")
            status = raw_row.get("status")
            if not isinstance(date_value, str) or not isinstance(status, str):
                continue
            reason = raw_row.get("reason")
            rows.append(
                SolarBiasContributionRow(
                    date=date_value,
                    forecast_wh=_optional_float(raw_row.get("forecastWh", raw_row.get("forecast_wh"))),
                    actual_wh=_optional_float(raw_row.get("actualWh", raw_row.get("actual_wh"))),
                    ratio=_optional_float(raw_row.get("ratio")),
                    status=status,
                    reason=reason if isinstance(reason, str) else None,
                )
            )
        slots[slot] = SolarBiasSlotExplainability(
            factor=_optional_float(raw_slot.get("factor")),
            raw_ratio=_optional_float(raw_slot.get("rawRatio", raw_slot.get("raw_ratio"))),
            clamped=bool(raw_slot.get("clamped", False)),
            forecast_sum_wh=_optional_float(raw_slot.get("forecastSumWh", raw_slot.get("forecast_sum_wh"))) or 0.0,
            actual_sum_wh=_optional_float(raw_slot.get("actualSumWh", raw_slot.get("actual_sum_wh"))) or 0.0,
            rows=rows,
        )

    return SolarBiasTrainingExplainability(
        trained_at=trained_at,
        aggregation_method=aggregation_method,
        slots=slots,
    )
```

- [ ] **Step 4: Store explainability after training**

In `async_train()`, add to the saved payload:

```python
                "trainingExplainability": training_explainability_to_payload(
                    outcome.explainability
                ),
```

After assigning metadata:

```python
            self._explainability = outcome.explainability
```

When preserving previous profile on training failure, preserve previous explainability:

```python
        previous_explainability = self._explainability
```

Inside `except`:

```python
            self._explainability = previous_explainability if preserve_profile else None
```

Update `_serialize_state()` to include:

```python
            "trainingExplainability": training_explainability_to_payload(
                self._explainability
            ),
```

- [ ] **Step 5: Run loader tests**

Run:

```bash
pytest tests/test_solar_bias_store.py::test_training_explainability_from_dict_parses_valid_snapshot tests/test_solar_bias_store.py::test_training_explainability_from_dict_returns_none_for_missing_snapshot -q
```

Expected: PASS.

- [ ] **Step 6: Write failing service save test**

Add to `tests/test_solar_bias_inspector.py`:

```python
def test_service_saves_training_explainability_after_training():
    service = _make_service()
    service._cfg.min_history_days = 1
    sample = models.TrainerSample(
        date="2026-04-24",
        forecast_wh=1000.0,
        slot_forecast_wh={"12:00": 1000.0},
    )

    async def fake_samples(*args, **kwargs):
        return [sample]

    async def fake_actuals_window(*args, **kwargs):
        return models.SolarActualsWindow(
            slot_actuals_by_date={"2026-04-24": {"12:00": 1200.0}}
        )

    old_samples = service_mod.load_trainer_samples
    old_actuals_window = service_mod.load_actuals_window
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_trainer_samples = fake_samples
        service_mod.load_actuals_window = fake_actuals_window
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T03:00:00+02:00")
        asyncio.run(service.async_train())
    finally:
        service_mod.load_trainer_samples = old_samples
        service_mod.load_actuals_window = old_actuals_window
        service_mod.dt_util.now = old_now

    saved = service._store.saved
    assert saved["trainingExplainability"]["aggregationMethod"] == "ratio_of_sums"
    assert saved["trainingExplainability"]["slots"]["12:00"]["rows"][0]["status"] == "included"
```

- [ ] **Step 7: Run service save test**

Run:

```bash
pytest tests/test_solar_bias_inspector.py::test_service_saves_training_explainability_after_training -q
```

Expected: PASS.

- [ ] **Step 8: Run affected tests**

Run:

```bash
pytest tests/test_solar_bias_store.py tests/test_solar_bias_inspector.py -q
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```bash
git add custom_components/helman/solar_bias_correction/service.py tests/test_solar_bias_store.py tests/test_solar_bias_inspector.py
git commit -m "feat(solar-bias): persist training explainability snapshot"
```

---

### Task 5: Inspector Impact Rows And Explainability Response

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/service.py`
- Modify: `tests/test_solar_bias_inspector.py`

- [ ] **Step 1: Write failing inspector response test**

Add:

```python
def test_inspector_day_returns_selected_day_impact_and_training_explainability():
    service = _make_service()
    service._profile = models.SolarBiasProfile(
        factors={"08:00": 1.5, "09:00": 0.5},
        omitted_slots=[],
    )
    service._metadata = models.SolarBiasMetadata(
        trained_at="2026-04-25T03:00:00+02:00",
        training_config_fingerprint=service_mod.compute_fingerprint(_make_cfg()),
        usable_days=12,
        dropped_days=[],
        factor_min=0.5,
        factor_max=1.5,
        factor_median=1.0,
        omitted_slot_count=0,
        last_outcome="profile_trained",
        error_reason=None,
    )
    service._explainability = models.SolarBiasTrainingExplainability(
        trained_at="2026-04-25T03:00:00+02:00",
        aggregation_method="ratio_of_sums",
        slots={
            "08:00": models.SolarBiasSlotExplainability(
                factor=1.5,
                raw_ratio=1.5,
                clamped=False,
                forecast_sum_wh=100.0,
                actual_sum_wh=150.0,
                rows=[],
            )
        },
    )

    async def fake_forecast_points(*args, **kwargs):
        return [
            {"timestamp": "2026-04-25T08:00:00+02:00", "value": 100.0},
            {"timestamp": "2026-04-25T09:00:00+02:00", "value": 200.0},
        ]

    async def fake_actuals(*args, **kwargs):
        return {}

    old_forecast = service_mod.load_forecast_points_for_day
    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_forecast_points_for_day = fake_forecast_points
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-25"))
    finally:
        service_mod.load_forecast_points_for_day = old_forecast
        service_mod.load_actuals_for_day = old_actuals
        service_mod.dt_util.now = old_now

    assert payload["series"]["impact"] == [
        {
            "slot": "08:00",
            "rawWh": 100.0,
            "correctedWh": 150.0,
            "impactWh": 50.0,
            "factor": 1.5,
        },
        {
            "slot": "09:00",
            "rawWh": 200.0,
            "correctedWh": 100.0,
            "impactWh": -100.0,
            "factor": 0.5,
        },
    ]
    assert payload["trainingExplainability"]["slots"]["08:00"]["factor"] == 1.5
```

- [ ] **Step 2: Run inspector response test to verify it fails**

Run:

```bash
pytest tests/test_solar_bias_inspector.py::test_inspector_day_returns_selected_day_impact_and_training_explainability -q
```

Expected: FAIL because `series.impact` is empty.

- [ ] **Step 3: Implement impact-point helper**

In `service.py`, import `SolarBiasImpactPoint`.

Add helper near `_factor_points_for_profile()`:

```python
def _impact_points_for_day(
    raw_points: list[dict[str, Any]],
    corrected_points: list[dict[str, Any]],
    profile: SolarBiasProfile | None,
) -> list[SolarBiasImpactPoint]:
    corrected_by_slot: dict[str, float] = {}
    for point in corrected_points:
        timestamp = point.get("timestamp")
        if not isinstance(timestamp, str):
            continue
        try:
            corrected_by_slot[timestamp[11:16]] = float(point.get("value"))
        except (TypeError, ValueError):
            continue

    impact: list[SolarBiasImpactPoint] = []
    for point in raw_points:
        timestamp = point.get("timestamp")
        if not isinstance(timestamp, str):
            continue
        slot = timestamp[11:16]
        try:
            raw_wh = float(point.get("value"))
        except (TypeError, ValueError):
            continue
        corrected_wh = corrected_by_slot.get(slot)
        if corrected_wh is None:
            continue
        factor = profile.factors.get(slot) if profile is not None else None
        impact.append(
            SolarBiasImpactPoint(
                slot=slot,
                raw_wh=raw_wh,
                corrected_wh=corrected_wh,
                impact_wh=corrected_wh - raw_wh,
                factor=float(factor) if factor is not None else None,
            )
        )
    return impact
```

In `async_get_inspector_day()`, pass impact and explainability:

```python
                impact=_impact_points_for_day(
                    raw_points,
                    corrected_points,
                    self._profile if has_profile else None,
                ),
```

In `SolarBiasInspectorDay(...)`, add:

```python
            training_explainability=self._explainability if has_profile else None,
```

- [ ] **Step 4: Run inspector response test**

Run:

```bash
pytest tests/test_solar_bias_inspector.py::test_inspector_day_returns_selected_day_impact_and_training_explainability -q
```

Expected: PASS.

- [ ] **Step 5: Update existing inspector tests**

Run:

```bash
pytest tests/test_solar_bias_inspector.py -q
```

Expected: Some tests may fail because expected payloads lack `"impact": []` or `"trainingExplainability": None`. Add these keys to expected dictionaries where needed. Do not loosen assertions; keep exact payload checks.

- [ ] **Step 6: Run affected tests**

Run:

```bash
pytest tests/test_solar_bias_inspector.py tests/test_solar_bias_websocket.py -q
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add custom_components/helman/solar_bias_correction/service.py tests/test_solar_bias_inspector.py
git commit -m "feat(solar-bias): expose inspector impact and explainability"
```

---

### Task 6: Frontend Selection Model Helpers

**Files:**
- Create: `custom_components/helman/frontend/src/bias-correction-inspector-model.ts`
- Create: `custom_components/helman/frontend/test/bias-correction-inspector-model.test.ts`

- [ ] **Step 1: Add TypeScript helper tests**

Create `custom_components/helman/frontend/test/bias-correction-inspector-model.test.ts`:

```typescript
import {
  chooseDefaultImpactSlot,
  findImpactForSlot,
  findPointForSlot,
  findTrainingSlot,
  type InspectorPoint,
  type ImpactPoint,
  type TrainingExplainability,
} from "../src/bias-correction-inspector-model.js";

function assertEqual(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
  }
}

const impacts: ImpactPoint[] = [
  { slot: "08:00", rawWh: 100, correctedWh: 150, impactWh: 50, factor: 1.5 },
  { slot: "09:00", rawWh: 200, correctedWh: 80, impactWh: -120, factor: 0.4 },
];

assertEqual(chooseDefaultImpactSlot(impacts), "09:00");
assertEqual(findImpactForSlot(impacts, "08:00")?.impactWh, 50);
assertEqual(findImpactForSlot(impacts, "10:00"), null);

const points: InspectorPoint[] = [
  { timestamp: "2026-04-25T08:00:00+02:00", valueWh: 123 },
];

assertEqual(findPointForSlot(points, "08:00")?.valueWh, 123);
assertEqual(findPointForSlot(points, "09:00"), null);

const explainability: TrainingExplainability = {
  trainedAt: "2026-04-25T03:00:00+02:00",
  aggregationMethod: "ratio_of_sums",
  slots: {
    "08:00": {
      factor: 1.5,
      rawRatio: 1.5,
      clamped: false,
      forecastSumWh: 100,
      actualSumWh: 150,
      rows: [],
    },
  },
};

assertEqual(findTrainingSlot(explainability, "08:00")?.factor, 1.5);
assertEqual(findTrainingSlot(explainability, "09:00"), null);
assertEqual(findTrainingSlot(null, "08:00"), null);
```

- [ ] **Step 2: Run helper test to verify it fails**

Run:

```bash
cd custom_components/helman/frontend
npx tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 test/bias-correction-inspector-model.test.ts
```

Expected: FAIL because `bias-correction-inspector-model.ts` does not exist.

- [ ] **Step 3: Implement helper module**

Create `custom_components/helman/frontend/src/bias-correction-inspector-model.ts`:

```typescript
export type InspectorPoint = { timestamp: string; valueWh: number };
export type FactorPoint = { slot: string; factor: number };
export type ImpactPoint = {
  slot: string;
  rawWh: number | null;
  correctedWh: number | null;
  impactWh: number | null;
  factor: number | null;
};
export type ContributionRow = {
  date: string;
  forecastWh: number | null;
  actualWh: number | null;
  ratio: number | null;
  status: string;
  reason: string | null;
};
export type TrainingSlotExplainability = {
  factor: number | null;
  rawRatio: number | null;
  clamped: boolean;
  forecastSumWh: number;
  actualSumWh: number;
  rows: ContributionRow[];
};
export type TrainingExplainability = {
  trainedAt: string;
  aggregationMethod: string;
  slots: Record<string, TrainingSlotExplainability>;
};

export function chooseDefaultImpactSlot(impacts: ImpactPoint[]): string | null {
  let selected: ImpactPoint | null = null;
  for (const point of impacts) {
    if (point.impactWh === null || !Number.isFinite(point.impactWh)) continue;
    if (
      selected === null ||
      Math.abs(point.impactWh) > Math.abs(selected.impactWh ?? 0)
    ) {
      selected = point;
    }
  }
  return selected?.slot ?? null;
}

export function findImpactForSlot(
  impacts: ImpactPoint[],
  slot: string | null,
): ImpactPoint | null {
  if (!slot) return null;
  return impacts.find((point) => point.slot === slot) ?? null;
}

export function findPointForSlot(
  points: InspectorPoint[],
  slot: string | null,
): InspectorPoint | null {
  if (!slot) return null;
  return points.find((point) => point.timestamp.slice(11, 16) === slot) ?? null;
}

export function findTrainingSlot(
  explainability: TrainingExplainability | null,
  slot: string | null,
): TrainingSlotExplainability | null {
  if (!explainability || !slot) return null;
  return explainability.slots[slot] ?? null;
}
```

- [ ] **Step 4: Run helper test**

Run:

```bash
cd custom_components/helman/frontend
npx tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 test/bias-correction-inspector-model.test.ts
node --loader ts-node/esm test/bias-correction-inspector-model.test.ts
```

Expected: `ts-node` may not be installed. If it is not installed, use this repository’s existing frontend test pattern instead:

```bash
cd custom_components/helman/frontend
npx tsc --outDir /tmp/helman-frontend-test --module NodeNext --moduleResolution NodeNext --target ES2022 test/bias-correction-inspector-model.test.ts
node /tmp/helman-frontend-test/test/bias-correction-inspector-model.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add custom_components/helman/frontend/src/bias-correction-inspector-model.ts custom_components/helman/frontend/test/bias-correction-inspector-model.test.ts
git commit -m "feat(solar-bias): add inspector selection helpers"
```

---

### Task 7: Frontend Combined Chart And Details Panel

**Files:**
- Modify: `custom_components/helman/frontend/src/bias-correction-inspector.ts`
- Modify: `custom_components/helman/frontend/src/localize/translations/en.json`
- Modify: `custom_components/helman/frontend/src/localize/translations/cs.json`

- [ ] **Step 1: Update imports and payload types**

In `bias-correction-inspector.ts`, replace local type aliases for `InspectorPoint` and `FactorPoint` with imports:

```typescript
import {
  chooseDefaultImpactSlot,
  findImpactForSlot,
  findPointForSlot,
  findTrainingSlot,
  type FactorPoint,
  type ImpactPoint,
  type InspectorPoint,
  type TrainingExplainability,
  type TrainingSlotExplainability,
} from "./bias-correction-inspector-model";
```

Update `InspectorPayload`:

```typescript
  series: {
    raw: InspectorPoint[];
    corrected: InspectorPoint[];
    actual: InspectorPoint[];
    invalidated: InspectorPoint[];
    factors: FactorPoint[];
    impact: ImpactPoint[];
  };
  trainingExplainability: TrainingExplainability | null;
```

Add state:

```typescript
  @state() private _selectedSlot: string | null = null;
```

- [ ] **Step 2: Preserve selected slot across day loads**

In `_load()`, after assigning `this._payload = payload;`, add:

```typescript
        if (!this._selectedSlot) {
          this._selectedSlot = chooseDefaultImpactSlot(payload.series.impact);
        }
```

Do not clear `_selectedSlot` in `_load()`. This keeps the clicked slot selected when the day changes.

- [ ] **Step 3: Replace factor-band legend with impact-column legend**

In `_renderLegend()`, replace the correction factor legend item with:

```typescript
        ${payload.series.impact.length
          ? html`
              <span class="legend-item">
                <span class="impact-swatch positive"></span>
                ${this._t("bias_correction.inspector.positive_impact")}
              </span>
              <span class="legend-item">
                <span class="impact-swatch negative"></span>
                ${this._t("bias_correction.inspector.negative_impact")}
              </span>
            `
          : ""}
```

Add CSS:

```css
    .impact-swatch {
      width: 10px;
      height: 14px;
      border-radius: 2px;
      display: inline-block;
    }

    .impact-swatch.positive { background: rgba(245, 127, 23, 0.85); }
    .impact-swatch.negative { background: rgba(21, 101, 192, 0.75); }
```

- [ ] **Step 4: Render clickable impact columns**

Remove the call to `_renderFactorBands(...)` from `_renderChart()`.

Add this call after grid lines and before line paths:

```typescript
        ${this._renderImpactColumns(payload.series.impact, margin.left, margin.top, plotWidth, plotHeight)}
```

Add method:

```typescript
  private _renderImpactColumns(
    impacts: ImpactPoint[],
    plotLeft: number,
    plotTop: number,
    plotWidth: number,
    plotHeight: number,
  ) {
    const values = impacts
      .map((point) => Math.abs(point.impactWh ?? 0))
      .filter((value) => Number.isFinite(value));
    const maxImpact = Math.max(1, ...values);
    return impacts.map((point) => {
      if (point.impactWh === null || !Number.isFinite(point.impactWh)) return "";
      const match = point.slot.match(/^(\d{2}):(\d{2})$/);
      if (!match) return "";
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      const startMinutes = hour * 60 + minute;
      const x = plotLeft + (startMinutes / 1440) * plotWidth;
      const width = Math.max(3, plotWidth / 96);
      const columnHeight = Math.max(2, (Math.abs(point.impactWh) / maxImpact) * plotHeight);
      const y = plotTop + plotHeight - columnHeight;
      const selected = this._selectedSlot === point.slot;
      const fill = point.impactWh >= 0 ? "rgba(245, 127, 23, 0.72)" : "rgba(21, 101, 192, 0.62)";
      return svg`
        <rect
          x=${x}
          y=${y}
          width=${width}
          height=${columnHeight}
          fill=${fill}
          stroke=${selected ? "var(--primary-text-color)" : "transparent"}
          stroke-width=${selected ? "2" : "0"}
          style="cursor: pointer;"
          @click=${() => this._selectSlot(point.slot)}
        >
          <title>${point.slot} ${this._formatSignedWh(point.impactWh)}</title>
        </rect>
      `;
    });
  }
```

Add:

```typescript
  private _selectSlot(slot: string) {
    this._selectedSlot = slot;
  }
```

- [ ] **Step 5: Render selected-slot details below totals**

In `_renderContent()`, after `${this._renderTotals(payload)}`, add:

```typescript
            ${this._renderSelectedSlotDetails(payload)}
```

Add CSS:

```css
    .slot-details {
      border: 1px solid var(--divider-color);
      border-radius: 6px;
      overflow: hidden;
      background: var(--card-background-color);
    }

    .slot-summary {
      padding: 12px;
      border-bottom: 1px solid var(--divider-color);
    }

    .slot-metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 8px;
      margin-top: 10px;
    }

    .slot-metric {
      border: 1px solid var(--divider-color);
      border-radius: 6px;
      padding: 8px;
      min-width: 0;
    }

    .metric-label {
      color: var(--secondary-text-color);
      font-size: 0.78rem;
    }

    .metric-value {
      color: var(--primary-text-color);
      font-weight: 700;
      overflow-wrap: anywhere;
    }

    .contribution-table-wrap {
      overflow-x: auto;
    }

    .contribution-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.86rem;
    }

    .contribution-table th,
    .contribution-table td {
      padding: 8px 10px;
      border-bottom: 1px solid var(--divider-color);
      text-align: left;
      white-space: nowrap;
    }

    .contribution-table th.numeric,
    .contribution-table td.numeric {
      text-align: right;
    }
```

Add method:

```typescript
  private _renderSelectedSlotDetails(payload: InspectorPayload) {
    const selectedSlot = this._selectedSlot ?? chooseDefaultImpactSlot(payload.series.impact);
    if (!selectedSlot) return "";
    const impact = findImpactForSlot(payload.series.impact, selectedSlot);
    const raw = findPointForSlot(payload.series.raw, selectedSlot);
    const corrected = findPointForSlot(payload.series.corrected, selectedSlot);
    const actual = findPointForSlot(payload.series.actual, selectedSlot);
    const trainingSlot = findTrainingSlot(payload.trainingExplainability, selectedSlot);
    return html`
      <div class="slot-details">
        <div class="slot-summary">
          <strong>${this._tFormat("bias_correction.inspector.selected_slot", { slot: selectedSlot })}</strong>
          <div class="slot-metrics">
            ${this._renderMetric(this._t("bias_correction.inspector.raw_forecast"), this._formatWh(raw?.valueWh ?? impact?.rawWh ?? null))}
            ${this._renderMetric(this._t("bias_correction.inspector.corrected_forecast"), this._formatWh(corrected?.valueWh ?? impact?.correctedWh ?? null))}
            ${this._renderMetric(this._t("bias_correction.inspector.actual_production"), this._formatWh(actual?.valueWh ?? null))}
            ${this._renderMetric(this._t("bias_correction.inspector.correction_impact"), this._formatSignedWh(impact?.impactWh ?? null))}
            ${this._renderMetric(this._t("bias_correction.inspector.factor"), this._formatFactor(impact?.factor ?? trainingSlot?.factor ?? null))}
          </div>
        </div>
        ${this._renderContributionTable(payload, selectedSlot, trainingSlot)}
      </div>
    `;
  }

  private _renderMetric(label: string, value: string) {
    return html`
      <div class="slot-metric">
        <div class="metric-label">${label}</div>
        <div class="metric-value">${value}</div>
      </div>
    `;
  }
```

- [ ] **Step 6: Render contribution table**

Add:

```typescript
  private _renderContributionTable(
    payload: InspectorPayload,
    selectedSlot: string,
    trainingSlot: TrainingSlotExplainability | null,
  ) {
    if (!payload.availability.hasProfile) {
      return html`<div class="note">${this._t("bias_correction.inspector.no_profile")}</div>`;
    }
    if (!payload.trainingExplainability) {
      return html`<div class="note">${this._t("bias_correction.inspector.no_explainability")}</div>`;
    }
    if (!trainingSlot) {
      return html`<div class="note">${this._tFormat("bias_correction.inspector.no_slot_explainability", { slot: selectedSlot })}</div>`;
    }
    return html`
      <div class="slot-summary">
        <strong>${this._t("bias_correction.inspector.training_contribution")}</strong>
        <div class="day-state">
          ${this._tFormat("bias_correction.inspector.training_contribution_meta", {
            ratio: this._formatFactor(trainingSlot.rawRatio),
            factor: this._formatFactor(trainingSlot.factor),
          })}
        </div>
      </div>
      <div class="contribution-table-wrap">
        <table class="contribution-table">
          <thead>
            <tr>
              <th>${this._t("bias_correction.inspector.date")}</th>
              <th class="numeric">${this._t("bias_correction.inspector.forecast_wh")}</th>
              <th class="numeric">${this._t("bias_correction.inspector.actual_wh")}</th>
              <th class="numeric">${this._t("bias_correction.inspector.ratio")}</th>
              <th>${this._t("bias_correction.inspector.status")}</th>
            </tr>
          </thead>
          <tbody>
            ${trainingSlot.rows.map((row) => html`
              <tr>
                <td>${row.date || "-"}</td>
                <td class="numeric">${this._formatWh(row.forecastWh)}</td>
                <td class="numeric">${this._formatWh(row.actualWh)}</td>
                <td class="numeric">${this._formatFactor(row.ratio)}</td>
                <td>${this._formatContributionStatus(row.status, row.reason)}</td>
              </tr>
            `)}
          </tbody>
        </table>
      </div>
    `;
  }
```

Add formatters:

```typescript
  private _formatSignedWh(value: number | null) {
    if (value === null || !Number.isFinite(value)) return this._t("bias_correction.inspector.actual_not_available");
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(0)} Wh`;
  }

  private _formatFactor(value: number | null) {
    if (value === null || !Number.isFinite(value)) return "-";
    return value.toFixed(3);
  }

  private _formatContributionStatus(status: string, reason: string | null) {
    const translated = this._t(`bias_correction.inspector.contribution_status.${status}`);
    if (!reason) return translated;
    return `${translated} (${reason})`;
  }
```

- [ ] **Step 7: Add translation keys**

In both `en.json` and `cs.json`, under `bias_correction.inspector`, add:

```json
"positive_impact": "Added Wh",
"negative_impact": "Removed Wh",
"selected_slot": "Selected slot: {slot}",
"correction_impact": "Correction impact",
"factor": "Factor",
"no_explainability": "This profile predates stored explainability. Run training again to see contribution rows.",
"no_slot_explainability": "No training explainability is available for {slot}.",
"training_contribution": "Training contribution",
"training_contribution_meta": "Raw ratio {ratio} · factor {factor}",
"date": "Date",
"forecast_wh": "Forecast Wh",
"actual_wh": "Actual Wh",
"ratio": "Ratio",
"status": "Status",
"contribution_status": {
  "included": "Included",
  "trimmed": "Trimmed",
  "invalidated": "Invalidated",
  "forecast_zero": "Zero forecast",
  "dropped_day": "Dropped day",
  "omitted_slot": "Omitted slot"
}
```

For `cs.json`, use the same English strings if the file does not already maintain Czech translations for newly added technical labels.

- [ ] **Step 8: Run frontend build**

Run:

```bash
cd custom_components/helman/frontend
npm run build
```

Expected: PASS and `dist/helman-config-editor.js` updates.

- [ ] **Step 9: Run helper test**

Run:

```bash
cd custom_components/helman/frontend
npx tsc --outDir /tmp/helman-frontend-test --module NodeNext --moduleResolution NodeNext --target ES2022 test/bias-correction-inspector-model.test.ts
node /tmp/helman-frontend-test/test/bias-correction-inspector-model.test.js
```

Expected: PASS.

- [ ] **Step 10: Commit**

Run:

```bash
git add custom_components/helman/frontend/src/bias-correction-inspector.ts \
        custom_components/helman/frontend/src/bias-correction-inspector-model.ts \
        custom_components/helman/frontend/test/bias-correction-inspector-model.test.ts \
        custom_components/helman/frontend/src/localize/translations/en.json \
        custom_components/helman/frontend/src/localize/translations/cs.json \
        custom_components/helman/frontend/dist/helman-config-editor.js
git commit -m "feat(solar-bias): render slot explainability inspector"
```

---

### Task 8: Final Verification

**Files:**
- No source changes expected. Fix regressions in the file that introduced them if verification fails.

- [ ] **Step 1: Run backend solar bias tests**

Run:

```bash
pytest tests/test_solar_bias_trainer.py tests/test_solar_bias_inspector.py tests/test_solar_bias_websocket.py tests/test_solar_bias_store.py -q
```

Expected: PASS.

- [ ] **Step 2: Run frontend build**

Run:

```bash
cd custom_components/helman/frontend
npm run build
```

Expected: PASS.

- [ ] **Step 3: Check git status**

Run:

```bash
git status --short
```

Expected: only intentional committed changes are absent from status. If `custom_components/helman/frontend/dist/helman-config-editor.js` changed during build and is not committed, commit it with:

```bash
git add custom_components/helman/frontend/dist/helman-config-editor.js
git commit -m "build(frontend): update config editor bundle"
```

- [ ] **Step 4: Optional local smoke in Home Assistant UI**

If the local Home Assistant dev instance is running and bias correction is configured, open the Helman config editor, expand the bias correction visual inspector, and select several impact columns across two dates.

Expected: the selected slot remains selected across date changes, selected-day raw/corrected/actual values refresh, and the contribution table stays tied to the selected slot’s stored training snapshot.

- [ ] **Step 5: Check final status after optional smoke**

Run:

```bash
git status --short
```

Expected: clean status. If optional smoke or verification required source fixes, rerun the failed task’s tests and commit the fixed files using the commit command from that task.
