# Solar Bias Correction: Slot Invalidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in feature that excludes individual training slots from the solar bias-correction trainer when, during that slot, the house battery was near full **and** export was disabled — conditions under which the inverter throttles solar generation and real-actuals are unrepresentative.

**Architecture:** Backend collects two extra recorder histories (battery SoC + export-enabled binary) over the existing training window, builds a per-(date, forecast-slot) invalidation set, and the trainer skips those (date, slot) pairs from both forecast and actual accumulation. The invalidation set is also persisted in the trained-profile metadata, partitions inspector actuals into red ("trained") vs gray ("excluded") dots, and is editable through a new sub-section in the config editor.

**Tech Stack:** Python 3.12 (Home Assistant integration), Lit/TypeScript frontend (Vite build), pytest unit tests, recorder `state_changes_during_period` API.

**Spec:** `docs/superpowers/specs/2026-04-26-solar-bias-slot-invalidation-design.md`.

---

## File Structure Overview

### Files modified

- `custom_components/helman/const.py` — bump storage version, add defaults if any.
- `custom_components/helman/solar_bias_correction/models.py` — `BiasConfig`, `SolarActualsWindow`, `SolarBiasMetadata`, `SolarBiasInspectorSeries`, `SolarBiasInspectorAvailability`, `inspector_day_to_payload`, `read_bias_config`.
- `custom_components/helman/solar_bias_correction/actuals.py` — extend `load_actuals_window` (+ a new helper for per-slot SoC peak / export-off detection).
- `custom_components/helman/solar_bias_correction/trainer.py` — skip invalidated slots, populate new metadata fields.
- `custom_components/helman/solar_bias_correction/service.py` — wire metadata fields into the persisted store payload, `_metadata_from_dict` migration, inspector partition (`async_get_inspector_day`), status payload field.
- `custom_components/helman/config_validation.py` — new validation block for `slot_invalidation`.
- `custom_components/helman/frontend/src/config-editor-scopes.ts` — new section scope.
- `custom_components/helman/frontend/src/localize/translations/en.json` — new translation keys.
- `custom_components/helman/frontend/src/bias-correction-inspector.ts` — gray-dot layer + legend.
- `custom_components/helman/frontend/dist/helman-config-editor.js` — rebuilt bundle.

### Files created

- `custom_components/helman/solar_bias_correction/slot_invalidation.py` — new module containing the per-slot peak-SoC + any-moment-export-off computation.

### Test files modified / created

- `tests/test_solar_bias_models.py` — new fields covered by dataclass roundtrip / `read_bias_config` tests.
- `tests/test_solar_bias_config_validation.py` — new validation cases.
- `tests/test_solar_bias_actuals.py` — invalidation loader tests (new `slot_invalidation` opt-in code path).
- `tests/test_solar_bias_trainer.py` — slot-skip behaviour and metadata population.
- `tests/test_solar_bias_store.py` — v1 → v2 migration roundtrip.
- `tests/test_solar_bias_inspector.py` — actual/invalidated partition.
- `tests/test_solar_bias_slot_invalidation.py` (NEW) — pure-function tests of the invalidation evaluator.

---

## Task 1: Extend dataclass models with the new fields

Add the new fields to `SolarActualsWindow`, `SolarBiasMetadata`, `SolarBiasInspectorSeries`, and `SolarBiasInspectorAvailability`. Update `inspector_day_to_payload` to emit them. Defaults are empty so existing callers keep compiling.

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/models.py`
- Test: `tests/test_solar_bias_models.py`

- [ ] **Step 1.1: Add a failing test for the new dataclass fields and payload keys**

Append to `tests/test_solar_bias_models.py`:

```python
def test_solar_actuals_window_has_invalidated_slots_by_date_field():
    from custom_components.helman.solar_bias_correction.models import SolarActualsWindow

    window = SolarActualsWindow(
        slot_actuals_by_date={"2026-04-20": {"12:00": 100.0}},
        invalidated_slots_by_date={"2026-04-20": {"12:00"}},
    )
    assert window.invalidated_slots_by_date == {"2026-04-20": {"12:00"}}


def test_solar_actuals_window_default_invalidated_slots_is_empty():
    from custom_components.helman.solar_bias_correction.models import SolarActualsWindow

    window = SolarActualsWindow(slot_actuals_by_date={})
    assert window.invalidated_slots_by_date == {}


def test_solar_bias_metadata_has_invalidation_fields_with_defaults():
    from custom_components.helman.solar_bias_correction.models import SolarBiasMetadata

    metadata = SolarBiasMetadata(
        trained_at="2026-04-26T03:00:00+00:00",
        training_config_fingerprint="sha256:abc",
        usable_days=14,
        dropped_days=[],
        factor_min=None,
        factor_max=None,
        factor_median=None,
        omitted_slot_count=0,
        last_outcome="profile_trained",
    )
    assert metadata.invalidated_slots_by_date == {}
    assert metadata.invalidated_slot_count == 0


def test_inspector_day_payload_includes_invalidated_series_and_availability():
    from custom_components.helman.solar_bias_correction.models import (
        SolarBiasInspectorAvailability,
        SolarBiasInspectorDay,
        SolarBiasInspectorPoint,
        SolarBiasInspectorSeries,
        SolarBiasInspectorTotals,
        inspector_day_to_payload,
    )

    day = SolarBiasInspectorDay(
        date="2026-04-20",
        timezone="UTC",
        status="applied",
        effective_variant="adjusted",
        trained_at=None,
        min_date="2026-04-13",
        max_date="2026-04-27",
        series=SolarBiasInspectorSeries(
            raw=[],
            corrected=[],
            actual=[SolarBiasInspectorPoint(timestamp="2026-04-20T11:00:00+00:00", value_wh=100.0)],
            factors=[],
            invalidated=[
                SolarBiasInspectorPoint(timestamp="2026-04-20T12:00:00+00:00", value_wh=80.0)
            ],
        ),
        totals=SolarBiasInspectorTotals(raw_wh=None, corrected_wh=None, actual_wh=180.0),
        availability=SolarBiasInspectorAvailability(
            has_raw_forecast=False,
            has_corrected_forecast=False,
            has_actuals=True,
            has_profile=False,
            has_invalidated=True,
        ),
        is_today=False,
        is_future=False,
    )

    payload = inspector_day_to_payload(day)

    assert payload["series"]["invalidated"] == [
        {"timestamp": "2026-04-20T12:00:00+00:00", "valueWh": 80.0}
    ]
    assert payload["availability"]["hasInvalidated"] is True
```

- [ ] **Step 1.2: Run the new tests and verify they fail**

Run:
```
pytest tests/test_solar_bias_models.py -v -k "invalidated_slots_by_date or has_invalidation_fields or includes_invalidated_series"
```
Expected: 4 failures (`TypeError: __init__() got an unexpected keyword argument`, `KeyError`, etc.).

- [ ] **Step 1.3: Add the new fields and payload keys**

In `custom_components/helman/solar_bias_correction/models.py`:

Edit `SolarActualsWindow`:
```python
@dataclass
class SolarActualsWindow:
    slot_actuals_by_date: dict[str, dict[str, float]]
    invalidated_slots_by_date: dict[str, set[str]] = field(default_factory=dict)
```

Edit `SolarBiasMetadata` (append new fields with defaults — they must come after the existing ones with defaults: `factor_*` and `error_reason`):
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
    error_reason: str | None = None
    invalidated_slots_by_date: dict[str, list[str]] = field(default_factory=dict)
    invalidated_slot_count: int = 0
```

Edit `SolarBiasInspectorSeries`:
```python
@dataclass
class SolarBiasInspectorSeries:
    raw: list[SolarBiasInspectorPoint]
    corrected: list[SolarBiasInspectorPoint]
    actual: list[SolarBiasInspectorPoint]
    factors: list[SolarBiasFactorPoint]
    invalidated: list[SolarBiasInspectorPoint] = field(default_factory=list)
```

Edit `SolarBiasInspectorAvailability`:
```python
@dataclass
class SolarBiasInspectorAvailability:
    has_raw_forecast: bool
    has_corrected_forecast: bool
    has_actuals: bool
    has_profile: bool
    has_invalidated: bool = False
```

Add the `field` import at the top (`from dataclasses import dataclass, field`).

Edit `inspector_day_to_payload` so the `series` and `availability` blocks include the new keys:

```python
        "series": {
            "raw": [_inspector_point_payload(point) for point in day.series.raw],
            "corrected": [
                _inspector_point_payload(point) for point in day.series.corrected
            ],
            "actual": [_inspector_point_payload(point) for point in day.series.actual],
            "factors": [
                {"slot": point.slot, "factor": point.factor}
                for point in day.series.factors
            ],
            "invalidated": [
                _inspector_point_payload(point) for point in day.series.invalidated
            ],
        },
        ...
        "availability": {
            "hasRawForecast": day.availability.has_raw_forecast,
            "hasCorrectedForecast": day.availability.has_corrected_forecast,
            "hasActuals": day.availability.has_actuals,
            "hasProfile": day.availability.has_profile,
            "hasInvalidated": day.availability.has_invalidated,
        },
```

- [ ] **Step 1.4: Run the model tests and verify all pass**

Run:
```
pytest tests/test_solar_bias_models.py -v
```
Expected: all tests pass (existing + 4 new).

- [ ] **Step 1.5: Commit**

```
git add custom_components/helman/solar_bias_correction/models.py tests/test_solar_bias_models.py
git commit -m "feat(solar-bias): add slot-invalidation fields to dataclass models"
```

---

## Task 2: Parse `slot_invalidation` in `read_bias_config`

Extend `BiasConfig` with `slot_invalidation_max_battery_soc_percent: float | None` and `slot_invalidation_export_enabled_entity_id: str | None`. Both are `None` when the user has not opted in.

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/models.py`
- Test: `tests/test_solar_bias_models.py`

- [ ] **Step 2.1: Add a failing test for `read_bias_config`**

Append to `tests/test_solar_bias_models.py`:

```python
def test_read_bias_config_returns_none_for_slot_invalidation_when_absent():
    from custom_components.helman.solar_bias_correction.models import read_bias_config

    cfg = read_bias_config({
        "power_devices": {
            "solar": {
                "forecast": {
                    "bias_correction": {
                        "enabled": True,
                    }
                }
            }
        }
    })
    assert cfg.slot_invalidation_max_battery_soc_percent is None
    assert cfg.slot_invalidation_export_enabled_entity_id is None


def test_read_bias_config_parses_slot_invalidation_when_present():
    from custom_components.helman.solar_bias_correction.models import read_bias_config

    cfg = read_bias_config({
        "power_devices": {
            "solar": {
                "forecast": {
                    "bias_correction": {
                        "slot_invalidation": {
                            "max_battery_soc_percent": 97,
                            "export_enabled_entity_id": "binary_sensor.fve_export_enabled",
                        }
                    }
                }
            }
        }
    })
    assert cfg.slot_invalidation_max_battery_soc_percent == 97.0
    assert cfg.slot_invalidation_export_enabled_entity_id == "binary_sensor.fve_export_enabled"
```

- [ ] **Step 2.2: Run the tests and verify they fail**

Run:
```
pytest tests/test_solar_bias_models.py -v -k "slot_invalidation"
```
Expected: 2 failures (`AttributeError: 'BiasConfig' object has no attribute 'slot_invalidation_...'`).

- [ ] **Step 2.3: Add fields to `BiasConfig` and parse them in `read_bias_config`**

Edit `custom_components/helman/solar_bias_correction/models.py`:

In `BiasConfig`:
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
    max_training_window_days: int = SOLAR_BIAS_DEFAULT_MAX_TRAINING_WINDOW_DAYS
    slot_invalidation_max_battery_soc_percent: float | None = None
    slot_invalidation_export_enabled_entity_id: str | None = None
```

In `read_bias_config`, after reading `clamp_max`:
```python
    slot_invalidation = bias.get("slot_invalidation") or {}
    slot_invalidation_max_battery_soc_percent: float | None = None
    raw_max_soc = slot_invalidation.get("max_battery_soc_percent")
    if isinstance(raw_max_soc, (int, float)) and not isinstance(raw_max_soc, bool):
        slot_invalidation_max_battery_soc_percent = float(raw_max_soc)
    slot_invalidation_export_enabled_entity_id: str | None = None
    raw_entity = slot_invalidation.get("export_enabled_entity_id")
    if isinstance(raw_entity, str) and raw_entity.strip():
        slot_invalidation_export_enabled_entity_id = raw_entity.strip()
```

And include them in the `BiasConfig(...)` constructor at the bottom:
```python
    return BiasConfig(
        enabled=enabled,
        min_history_days=min_history_days,
        training_time=training_time,
        clamp_min=clamp_min,
        clamp_max=clamp_max,
        daily_energy_entity_ids=daily_energy_entity_ids,
        total_energy_entity_id=total_energy_entity_id,
        max_training_window_days=max_training_window_days,
        slot_invalidation_max_battery_soc_percent=slot_invalidation_max_battery_soc_percent,
        slot_invalidation_export_enabled_entity_id=slot_invalidation_export_enabled_entity_id,
    )
```

- [ ] **Step 2.4: Run the tests and verify all pass**

Run:
```
pytest tests/test_solar_bias_models.py -v
```
Expected: all pass.

- [ ] **Step 2.5: Commit**

```
git add custom_components/helman/solar_bias_correction/models.py tests/test_solar_bias_models.py
git commit -m "feat(solar-bias): parse slot_invalidation config into BiasConfig"
```

---

## Task 3: Validate `slot_invalidation` in `config_validation.py`

The validation must reject partial config, out-of-range SoC, malformed entity ids, and slot-invalidation set without battery `capacity`.

**Files:**
- Modify: `custom_components/helman/config_validation.py`
- Test: `tests/test_solar_bias_config_validation.py`

- [ ] **Step 3.1: Inspect existing validation tests for patterns**

Read `tests/test_solar_bias_config_validation.py` (top and around `bias_correction`) so the new tests follow the same fixture/`ValidationReport` pattern.

```
sed -n '1,80p' tests/test_solar_bias_config_validation.py
```

- [ ] **Step 3.2: Add failing tests**

Append to `tests/test_solar_bias_config_validation.py`. Where the existing tests build a config dict via a helper, follow that helper; the snippet below uses an explicit `_validate_solar_config` invocation matching the pattern visible in `tests/test_solar_bias_config_validation.py` — adapt only the wrapping, not the inputs.

```python
def _config_with_bias(bias_overrides=None, *, with_battery_capacity=True):
    """Return a minimal-but-valid config with bias_correction overrides."""
    cfg = {
        "power_devices": {
            "solar": {
                "forecast": {
                    "daily_energy_entity_ids": ["sensor.solar_today"],
                    "bias_correction": {
                        "enabled": True,
                        "min_history_days": 7,
                        "training_window_days": 30,
                        "training_time": "03:00",
                        "clamp_min": 0.5,
                        "clamp_max": 2.0,
                        "total_energy_entity_id": "sensor.solar_total",
                    },
                }
            },
            "battery": {
                "entities": {
                    "remaining_energy": "sensor.battery_remaining",
                    "capacity": "sensor.battery_soc",
                    "min_soc": "number.battery_min_soc",
                    "max_soc": "number.battery_max_soc",
                }
            },
        }
    }
    if not with_battery_capacity:
        cfg["power_devices"]["battery"]["entities"].pop("capacity")
    if bias_overrides is not None:
        cfg["power_devices"]["solar"]["forecast"]["bias_correction"].update(bias_overrides)
    return cfg


def test_slot_invalidation_partial_config_is_rejected():
    cfg = _config_with_bias({"slot_invalidation": {"max_battery_soc_percent": 97}})
    report = run_validation(cfg)  # use the existing test runner / helper
    codes = {e.code for e in report.errors}
    assert "incomplete_slot_invalidation" in codes


def test_slot_invalidation_out_of_range_is_rejected():
    cfg = _config_with_bias({
        "slot_invalidation": {
            "max_battery_soc_percent": 150,
            "export_enabled_entity_id": "binary_sensor.fve_export_enabled",
        }
    })
    report = run_validation(cfg)
    codes = {e.code for e in report.errors}
    assert "invalid_range" in codes


def test_slot_invalidation_non_numeric_max_soc_is_rejected():
    cfg = _config_with_bias({
        "slot_invalidation": {
            "max_battery_soc_percent": "97",
            "export_enabled_entity_id": "binary_sensor.fve_export_enabled",
        }
    })
    report = run_validation(cfg)
    codes = {e.code for e in report.errors}
    assert "invalid_type" in codes


def test_slot_invalidation_requires_battery_capacity():
    cfg = _config_with_bias(
        {
            "slot_invalidation": {
                "max_battery_soc_percent": 97,
                "export_enabled_entity_id": "binary_sensor.fve_export_enabled",
            }
        },
        with_battery_capacity=False,
    )
    report = run_validation(cfg)
    codes = {e.code for e in report.errors}
    assert "missing_prerequisite" in codes


def test_slot_invalidation_valid_config_passes():
    cfg = _config_with_bias({
        "slot_invalidation": {
            "max_battery_soc_percent": 97,
            "export_enabled_entity_id": "binary_sensor.fve_export_enabled",
        }
    })
    report = run_validation(cfg)
    bias_errors = [e for e in report.errors if "bias_correction" in (e.path or "")]
    assert bias_errors == []
```

> **Adaptation note:** the test file already imports a validator entry point and `ValidationReport`. Replace `run_validation(cfg)` with whatever the existing tests call (look at how the existing `test_bias_correction_*` tests assemble and run validation in this file).

- [ ] **Step 3.3: Run the tests and verify they fail**

Run:
```
pytest tests/test_solar_bias_config_validation.py -v -k "slot_invalidation"
```
Expected: 5 failures.

- [ ] **Step 3.4: Add the validation block**

Edit `custom_components/helman/config_validation.py`. After the existing `clamp_min`/`clamp_max` block in the bias-correction validator (right after `# cross-field validation: clamp_min < clamp_max`), append:

```python
    # slot_invalidation subtree validation
    raw_slot_inv = bias_map.get("slot_invalidation")
    if raw_slot_inv is not None:
        slot_inv_path = f"{base_path}.slot_invalidation"
        slot_inv_map = _require_mapping(
            raw_slot_inv, slot_inv_path, section, report
        )
        if slot_inv_map is not None:
            max_soc = slot_inv_map.get("max_battery_soc_percent")
            export_entity = slot_inv_map.get("export_enabled_entity_id")

            if max_soc is None or export_entity is None:
                report.add_error(
                    section=section,
                    path=slot_inv_path,
                    code="incomplete_slot_invalidation",
                    message=(
                        f"{slot_inv_path} requires both max_battery_soc_percent "
                        "and export_enabled_entity_id when present"
                    ),
                )
            else:
                if isinstance(max_soc, bool) or not isinstance(
                    max_soc, (int, float)
                ):
                    report.add_error(
                        section=section,
                        path=f"{slot_inv_path}.max_battery_soc_percent",
                        code="invalid_type",
                        message=(
                            f"{slot_inv_path}.max_battery_soc_percent "
                            "must be a number"
                        ),
                    )
                elif not (0 < max_soc <= 100):
                    report.add_error(
                        section=section,
                        path=f"{slot_inv_path}.max_battery_soc_percent",
                        code="invalid_range",
                        message=(
                            f"{slot_inv_path}.max_battery_soc_percent "
                            "must be in (0, 100]"
                        ),
                    )

                _validate_optional_entity_id(
                    report,
                    section,
                    f"{slot_inv_path}.export_enabled_entity_id",
                    export_entity,
                )

            # Prerequisite: power_devices.battery.entities.capacity must be set
            battery_entities = (
                config.get("power_devices", {})
                .get("battery", {})
                .get("entities")
            )
            capacity = (
                battery_entities.get("capacity")
                if isinstance(battery_entities, dict)
                else None
            )
            if not (isinstance(capacity, str) and capacity.strip()):
                report.add_error(
                    section=section,
                    path=slot_inv_path,
                    code="missing_prerequisite",
                    message=(
                        "slot_invalidation requires "
                        "power_devices.battery.entities.capacity to be configured"
                    ),
                )
```

> If the surrounding validator function does not have `config` (the full config dict) in scope, propagate it from the caller — search `config_validation.py` for `_validate_solar_forecast_config` or equivalent and ensure the full config is reachable. The existing `_validate_battery_config` already takes `config: Mapping[str, Any]`, so the pattern is consistent.

- [ ] **Step 3.5: Run the validation tests**

Run:
```
pytest tests/test_solar_bias_config_validation.py -v
```
Expected: all pass.

- [ ] **Step 3.6: Commit**

```
git add custom_components/helman/config_validation.py tests/test_solar_bias_config_validation.py
git commit -m "feat(solar-bias): validate slot_invalidation config"
```

---

## Task 4: Pure-function evaluator for per-slot invalidation

Move the rule out of `actuals.py` so it has unit tests independent of the recorder.

**Files:**
- Create: `custom_components/helman/solar_bias_correction/slot_invalidation.py`
- Create: `tests/test_solar_bias_slot_invalidation.py`

- [ ] **Step 4.1: Create the failing test file**

Create `tests/test_solar_bias_slot_invalidation.py`:

```python
from __future__ import annotations

from datetime import datetime, timezone

import pathlib
import sys
import types


def _setup_stubs() -> None:
    repo_root = pathlib.Path(__file__).resolve().parents[1]
    custom_components_dir = repo_root / "custom_components"
    helman_dir = custom_components_dir / "helman"

    if "custom_components" not in sys.modules:
        pkg = types.ModuleType("custom_components")
        pkg.__path__ = [str(custom_components_dir)]
        sys.modules["custom_components"] = pkg

    if "custom_components.helman" not in sys.modules:
        pkg = types.ModuleType("custom_components.helman")
        pkg.__path__ = [str(helman_dir)]
        sys.modules["custom_components.helman"] = pkg


_setup_stubs()


from custom_components.helman.solar_bias_correction.slot_invalidation import (  # noqa: E402
    InvalidationInputs,
    StateSample,
    compute_invalidated_slots_for_window,
)


UTC = timezone.utc


def _slot_starts(date_str: str, slots: list[str]):
    return [
        datetime.fromisoformat(f"{date_str}T{s}:00+00:00") for s in slots
    ]


def test_no_inputs_returns_empty_set_per_date():
    inputs = InvalidationInputs(
        max_battery_soc_percent=97.0,
        soc_samples_utc=[],
        export_samples_utc=[],
        forecast_slot_starts_by_date={
            "2026-04-20": _slot_starts("2026-04-20", ["12:00", "12:15"]),
        },
        slot_keys_by_date={"2026-04-20": ["12:00", "12:15"]},
    )
    result = compute_invalidated_slots_for_window(inputs)
    assert result == {"2026-04-20": set()}


def test_slot_invalidated_when_peak_soc_high_and_export_off_at_any_moment():
    soc = [
        StateSample(timestamp=datetime(2026, 4, 20, 11, 50, tzinfo=UTC), value="96.0"),
        StateSample(timestamp=datetime(2026, 4, 20, 12, 5, tzinfo=UTC), value="97.5"),
        StateSample(timestamp=datetime(2026, 4, 20, 12, 10, tzinfo=UTC), value="96.5"),
    ]
    export = [
        StateSample(timestamp=datetime(2026, 4, 20, 11, 50, tzinfo=UTC), value="off"),
    ]
    inputs = InvalidationInputs(
        max_battery_soc_percent=97.0,
        soc_samples_utc=soc,
        export_samples_utc=export,
        forecast_slot_starts_by_date={
            "2026-04-20": _slot_starts("2026-04-20", ["12:00", "12:15"]),
        },
        slot_keys_by_date={"2026-04-20": ["12:00", "12:15"]},
    )
    result = compute_invalidated_slots_for_window(inputs)
    assert result["2026-04-20"] == {"12:00"}


def test_slot_not_invalidated_when_export_was_on_throughout():
    soc = [
        StateSample(timestamp=datetime(2026, 4, 20, 12, 0, tzinfo=UTC), value="98.0"),
    ]
    export = [
        StateSample(timestamp=datetime(2026, 4, 20, 11, 50, tzinfo=UTC), value="on"),
    ]
    inputs = InvalidationInputs(
        max_battery_soc_percent=97.0,
        soc_samples_utc=soc,
        export_samples_utc=export,
        forecast_slot_starts_by_date={
            "2026-04-20": _slot_starts("2026-04-20", ["12:00", "12:15"]),
        },
        slot_keys_by_date={"2026-04-20": ["12:00", "12:15"]},
    )
    result = compute_invalidated_slots_for_window(inputs)
    assert result["2026-04-20"] == set()


def test_slot_not_invalidated_when_no_soc_data_in_or_before_slot():
    soc = []  # no SoC samples at all
    export = [
        StateSample(timestamp=datetime(2026, 4, 20, 12, 5, tzinfo=UTC), value="off"),
    ]
    inputs = InvalidationInputs(
        max_battery_soc_percent=97.0,
        soc_samples_utc=soc,
        export_samples_utc=export,
        forecast_slot_starts_by_date={
            "2026-04-20": _slot_starts("2026-04-20", ["12:00", "12:15"]),
        },
        slot_keys_by_date={"2026-04-20": ["12:00", "12:15"]},
    )
    result = compute_invalidated_slots_for_window(inputs)
    assert result["2026-04-20"] == set()


def test_slot_not_invalidated_when_export_unknown():
    soc = [
        StateSample(timestamp=datetime(2026, 4, 20, 12, 0, tzinfo=UTC), value="99.0"),
    ]
    export = [
        StateSample(timestamp=datetime(2026, 4, 20, 12, 5, tzinfo=UTC), value="unavailable"),
    ]
    inputs = InvalidationInputs(
        max_battery_soc_percent=97.0,
        soc_samples_utc=soc,
        export_samples_utc=export,
        forecast_slot_starts_by_date={
            "2026-04-20": _slot_starts("2026-04-20", ["12:00", "12:15"]),
        },
        slot_keys_by_date={"2026-04-20": ["12:00", "12:15"]},
    )
    result = compute_invalidated_slots_for_window(inputs)
    assert result["2026-04-20"] == set()


def test_left_edge_inheritance_for_slot_with_no_internal_samples():
    # SoC stays at 99% from before slot start; no samples in slot itself.
    soc = [
        StateSample(timestamp=datetime(2026, 4, 20, 11, 0, tzinfo=UTC), value="99.0"),
    ]
    export = [
        StateSample(timestamp=datetime(2026, 4, 20, 11, 0, tzinfo=UTC), value="off"),
    ]
    inputs = InvalidationInputs(
        max_battery_soc_percent=97.0,
        soc_samples_utc=soc,
        export_samples_utc=export,
        forecast_slot_starts_by_date={
            "2026-04-20": _slot_starts("2026-04-20", ["12:00", "12:15"]),
        },
        slot_keys_by_date={"2026-04-20": ["12:00", "12:15"]},
    )
    result = compute_invalidated_slots_for_window(inputs)
    assert result["2026-04-20"] == {"12:00"}
```

- [ ] **Step 4.2: Run the tests and verify they fail**

Run:
```
pytest tests/test_solar_bias_slot_invalidation.py -v
```
Expected: ImportError because the module does not yet exist.

- [ ] **Step 4.3: Create the module**

Create `custom_components/helman/solar_bias_correction/slot_invalidation.py`:

```python
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any


@dataclass(frozen=True)
class StateSample:
    timestamp: datetime
    value: Any  # raw recorder state value (string)


@dataclass
class InvalidationInputs:
    max_battery_soc_percent: float
    soc_samples_utc: list[StateSample]
    export_samples_utc: list[StateSample]
    # Per-date forecast slot start datetimes (UTC, sorted ascending).
    forecast_slot_starts_by_date: dict[str, list[datetime]]
    # Parallel per-date slot keys ("HH:MM"), same length and order as starts.
    slot_keys_by_date: dict[str, list[str]]


_UNKNOWN_STATES = {"unknown", "unavailable", "none", ""}


def _coerce_float(value: Any) -> float | None:
    try:
        if isinstance(value, bool):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _coerce_bool_state(value: Any) -> str | None:
    """Return 'on' / 'off' for valid binary states; None for unknown."""
    if value is None:
        return None
    if isinstance(value, bool):
        return "on" if value else "off"
    text = str(value).strip().lower()
    if text in ("on", "true"):
        return "on"
    if text in ("off", "false"):
        return "off"
    if text in _UNKNOWN_STATES:
        return None
    return None


def _last_at_or_before(
    samples: list[StateSample], cutoff: datetime
) -> StateSample | None:
    candidate: StateSample | None = None
    for sample in samples:
        if sample.timestamp <= cutoff:
            candidate = sample
        else:
            break
    return candidate


def _samples_in_slot(
    samples: list[StateSample], start: datetime, end: datetime
) -> list[StateSample]:
    return [s for s in samples if start <= s.timestamp < end]


def _peak_soc_for_slot(
    soc_samples: list[StateSample], start: datetime, end: datetime
) -> float | None:
    edge = _last_at_or_before(soc_samples, start)
    in_slot = _samples_in_slot(soc_samples, start, end)
    relevant_values: list[float] = []
    if edge is not None:
        coerced = _coerce_float(edge.value)
        if coerced is not None:
            relevant_values.append(coerced)
    for sample in in_slot:
        coerced = _coerce_float(sample.value)
        if coerced is not None:
            relevant_values.append(coerced)
    if not relevant_values:
        return None
    return max(relevant_values)


def _export_off_at_any_moment(
    export_samples: list[StateSample], start: datetime, end: datetime
) -> bool | None:
    """Return True iff export was 'off' at some moment of the slot.

    Returns None if neither the left-edge sample nor any in-slot sample is a
    definitive on/off (i.e. the signal was unknown for the whole slot)."""
    edge = _last_at_or_before(export_samples, start)
    in_slot = _samples_in_slot(export_samples, start, end)

    edge_state = _coerce_bool_state(edge.value) if edge is not None else None
    in_slot_states = [_coerce_bool_state(s.value) for s in in_slot]
    valid_in_slot_states = [s for s in in_slot_states if s is not None]

    if edge_state is None and not valid_in_slot_states:
        return None

    if edge_state == "off":
        return True
    if any(state == "off" for state in valid_in_slot_states):
        return True
    return False


def compute_invalidated_slots_for_window(
    inputs: InvalidationInputs,
) -> dict[str, set[str]]:
    soc_sorted = sorted(inputs.soc_samples_utc, key=lambda s: s.timestamp)
    export_sorted = sorted(inputs.export_samples_utc, key=lambda s: s.timestamp)

    result: dict[str, set[str]] = {}
    for date_str, slot_starts in inputs.forecast_slot_starts_by_date.items():
        slot_keys = inputs.slot_keys_by_date[date_str]
        invalidated: set[str] = set()
        for index, start in enumerate(slot_starts):
            end = (
                slot_starts[index + 1]
                if index + 1 < len(slot_starts)
                else start.replace(hour=23, minute=59, second=59, microsecond=999999)
            )
            peak_soc = _peak_soc_for_slot(soc_sorted, start, end)
            export_off = _export_off_at_any_moment(export_sorted, start, end)
            if peak_soc is None or export_off is None:
                continue
            if peak_soc >= inputs.max_battery_soc_percent and export_off:
                invalidated.add(slot_keys[index])
        result[date_str] = invalidated
    return result
```

- [ ] **Step 4.4: Run the tests and verify they pass**

Run:
```
pytest tests/test_solar_bias_slot_invalidation.py -v
```
Expected: all 6 tests pass.

- [ ] **Step 4.5: Commit**

```
git add custom_components/helman/solar_bias_correction/slot_invalidation.py tests/test_solar_bias_slot_invalidation.py
git commit -m "feat(solar-bias): pure-function evaluator for per-slot invalidation"
```

---

## Task 5: Extend `load_actuals_window` to populate invalidation set

The loader does the recorder queries (when feature is on) and builds the per-date forecast-slot start times needed by the evaluator from Task 4. When the feature is off, it returns the existing window with `invalidated_slots_by_date={}`.

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/actuals.py`
- Test: `tests/test_solar_bias_actuals.py`

- [ ] **Step 5.1: Add a failing test that the loader fills `invalidated_slots_by_date` when configured**

Append to `tests/test_solar_bias_actuals.py`:

```python
class SolarBiasActualsInvalidationTests(unittest.IsolatedAsyncioTestCase):
    async def test_load_actuals_window_returns_empty_invalidation_when_off(self) -> None:
        from custom_components.helman.solar_bias_correction import models

        cfg = models.BiasConfig(
            enabled=True,
            min_history_days=1,
            training_time="03:00",
            clamp_min=0.5,
            clamp_max=2.0,
            daily_energy_entity_ids=["sensor.solar_today"],
            total_energy_entity_id="sensor.solar_total",
        )

        with patch.object(
            actuals,
            "_read_day_slot_actuals",
            AsyncMock(return_value={"08:00": 100.0}),
        ):
            window = await actuals.load_actuals_window(SimpleNamespace(), cfg, days=2)

        self.assertEqual(window.invalidated_slots_by_date, {})

    async def test_load_actuals_window_calls_evaluator_when_configured(self) -> None:
        from custom_components.helman.solar_bias_correction import models

        cfg = models.BiasConfig(
            enabled=True,
            min_history_days=1,
            training_time="03:00",
            clamp_min=0.5,
            clamp_max=2.0,
            daily_energy_entity_ids=["sensor.solar_today"],
            total_energy_entity_id="sensor.solar_total",
            slot_invalidation_max_battery_soc_percent=97.0,
            slot_invalidation_export_enabled_entity_id="binary_sensor.fve_export_enabled",
        )

        evaluator_called = {}

        def fake_evaluate(inputs):
            evaluator_called["max_soc"] = inputs.max_battery_soc_percent
            return {date_str: set() for date_str in inputs.forecast_slot_starts_by_date}

        with patch.object(
            actuals,
            "_read_day_slot_actuals",
            AsyncMock(return_value={"08:00": 100.0}),
        ), patch.object(
            actuals,
            "_load_state_samples_for_window",
            AsyncMock(return_value=[]),
        ), patch(
            "custom_components.helman.solar_bias_correction.actuals.compute_invalidated_slots_for_window",
            side_effect=fake_evaluate,
        ):
            window = await actuals.load_actuals_window(SimpleNamespace(), cfg, days=2)

        self.assertEqual(evaluator_called["max_soc"], 97.0)
        # Empty sets per date present
        self.assertTrue(set(window.invalidated_slots_by_date.keys()))
```

- [ ] **Step 5.2: Run the tests and verify they fail**

Run:
```
pytest tests/test_solar_bias_actuals.py -v -k "Invalidation"
```
Expected: 2 failures (`AttributeError`/`ImportError`).

- [ ] **Step 5.3: Extend the loader**

Edit `custom_components/helman/solar_bias_correction/actuals.py`:

```python
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from homeassistant.components.recorder import get_instance
from homeassistant.components.recorder.history import state_changes_during_period
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .models import BiasConfig, SolarActualsWindow
from .slot_invalidation import (
    InvalidationInputs,
    StateSample,
    compute_invalidated_slots_for_window,
)
from ..recorder_hourly_series import (
    get_local_current_slot_start,
    query_cumulative_slot_energy_changes,
)
```

Replace the body of `load_actuals_window` with:

```python
async def load_actuals_window(
    hass: HomeAssistant, cfg: BiasConfig, days: int
) -> SolarActualsWindow:
    entity_id = _read_entity_id(cfg.total_energy_entity_id)
    if entity_id is None or days <= 0:
        return SolarActualsWindow(slot_actuals_by_date={}, invalidated_slots_by_date={})

    local_now = dt_util.as_local(datetime.now(timezone.utc))
    slot_actuals_by_date: dict[str, dict[str, float]] = {}

    for offset in range(days, 0, -1):
        target_date = local_now.date() - timedelta(days=offset)
        slot_actuals_by_date[str(target_date)] = await _read_day_slot_actuals(
            hass,
            entity_id,
            target_date,
            local_now=local_now,
        )

    invalidated_slots_by_date = await _compute_invalidation_or_empty(
        hass, cfg, slot_actuals_by_date, local_now=local_now
    )

    return SolarActualsWindow(
        slot_actuals_by_date=slot_actuals_by_date,
        invalidated_slots_by_date=invalidated_slots_by_date,
    )
```

Add the new helpers at the bottom of the file:

```python
async def _compute_invalidation_or_empty(
    hass: HomeAssistant,
    cfg: BiasConfig,
    slot_actuals_by_date: dict[str, dict[str, float]],
    *,
    local_now: datetime,
) -> dict[str, set[str]]:
    if (
        cfg.slot_invalidation_max_battery_soc_percent is None
        or cfg.slot_invalidation_export_enabled_entity_id is None
    ):
        return {date_str: set() for date_str in slot_actuals_by_date}

    soc_entity_id = _read_battery_soc_entity_id(hass)
    export_entity_id = cfg.slot_invalidation_export_enabled_entity_id
    if soc_entity_id is None:
        return {date_str: set() for date_str in slot_actuals_by_date}

    if not slot_actuals_by_date:
        return {}

    sorted_dates = sorted(slot_actuals_by_date.keys())
    window_start_local = datetime.combine(
        date.fromisoformat(sorted_dates[0]),
        time.min,
        tzinfo=local_now.tzinfo,
    )
    last_date = date.fromisoformat(sorted_dates[-1])
    window_end_local = datetime.combine(
        last_date + timedelta(days=1),
        time.min,
        tzinfo=local_now.tzinfo,
    )

    soc_samples = await _load_state_samples_for_window(
        hass,
        soc_entity_id,
        local_start=window_start_local,
        local_end=window_end_local,
    )
    export_samples = await _load_state_samples_for_window(
        hass,
        export_entity_id,
        local_start=window_start_local,
        local_end=window_end_local,
    )

    forecast_slot_starts_by_date: dict[str, list[datetime]] = {}
    slot_keys_by_date: dict[str, list[str]] = {}
    for date_str, day_actuals in slot_actuals_by_date.items():
        slot_keys = sorted(
            day_actuals.keys(),
            key=lambda s: int(s.split(":")[0]) * 60 + int(s.split(":")[1]),
        )
        slot_starts = []
        for slot_key in slot_keys:
            hh, mm = (int(p) for p in slot_key.split(":"))
            local_dt = datetime.combine(
                date.fromisoformat(date_str),
                time(hour=hh, minute=mm),
                tzinfo=local_now.tzinfo,
            )
            slot_starts.append(dt_util.as_utc(local_dt))
        forecast_slot_starts_by_date[date_str] = slot_starts
        slot_keys_by_date[date_str] = slot_keys

    inputs = InvalidationInputs(
        max_battery_soc_percent=cfg.slot_invalidation_max_battery_soc_percent,
        soc_samples_utc=soc_samples,
        export_samples_utc=export_samples,
        forecast_slot_starts_by_date=forecast_slot_starts_by_date,
        slot_keys_by_date=slot_keys_by_date,
    )
    return compute_invalidated_slots_for_window(inputs)


async def _load_state_samples_for_window(
    hass: HomeAssistant,
    entity_id: str,
    *,
    local_start: datetime,
    local_end: datetime,
) -> list[StateSample]:
    utc_start = dt_util.as_utc(local_start)
    utc_end = dt_util.as_utc(local_end)
    history = await get_instance(hass).async_add_executor_job(
        lambda: state_changes_during_period(
            hass,
            utc_start,
            utc_end,
            entity_id,
            False,
            False,
            None,
            True,
        )
    )
    states = history.get(entity_id) or history.get(entity_id.lower()) or []
    samples: list[StateSample] = []
    for state in states:
        ts = getattr(state, "last_updated", None) or getattr(state, "last_changed", None)
        if ts is None:
            continue
        samples.append(StateSample(timestamp=ts, value=getattr(state, "state", None)))
    return samples


def _read_battery_soc_entity_id(hass: HomeAssistant) -> str | None:
    # Reuse the integration's own config that stores capacity (= live SoC %).
    try:
        from ..battery_state import read_battery_entity_config  # local import to avoid cycle

        # battery_state expects the full config dict; obtain it from hass.data
        from ..const import DOMAIN  # noqa: WPS433
        config = hass.data[DOMAIN]["config"] if DOMAIN in hass.data else {}
    except Exception:
        return None
    entity_config = read_battery_entity_config(config)
    if entity_config is None:
        return None
    return entity_config.capacity_entity_id
```

> **Note on `hass.data[DOMAIN]["config"]`:** if the integration stores config differently in this codebase, look at how `service.py` or `coordinator.py` already accesses the full config and follow that pattern. Search for usages of `read_battery_entity_config(` to find the correct config-source idiom and adapt the helper accordingly.

Update the existing early-return in `load_actuals_window` (entity missing / `days <= 0`) so it includes `invalidated_slots_by_date={}`.

- [ ] **Step 5.4: Run the actuals tests and verify they pass**

Run:
```
pytest tests/test_solar_bias_actuals.py -v
```
Expected: existing tests still pass; the two new tests pass.

- [ ] **Step 5.5: Commit**

```
git add custom_components/helman/solar_bias_correction/actuals.py tests/test_solar_bias_actuals.py
git commit -m "feat(solar-bias): load per-slot invalidation set from recorder"
```

---

## Task 6: Trainer skips invalidated slots and populates metadata

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/trainer.py`
- Test: `tests/test_solar_bias_trainer.py`

- [ ] **Step 6.1: Add failing trainer tests**

Append to `tests/test_solar_bias_trainer.py`:

```python
def test_trainer_skips_invalidated_slot_for_one_day():
    cfg = make_cfg(min_history_days=2, clamp_min=0.5, clamp_max=2.0)

    samples = [
        models.TrainerSample(date="2023-01-01", forecast_wh=5000.0, slot_forecast_wh=make_uniform_slot_forecast(5000.0)),
        models.TrainerSample(date="2023-01-02", forecast_wh=5000.0, slot_forecast_wh=make_uniform_slot_forecast(5000.0)),
    ]

    # Day 2 actuals at 12:00 are intentionally low; that slot is invalidated for day 2.
    day2_actuals = make_uniform_actuals(5000.0)
    day2_actuals["12:00"] = 0.0  # if used, this would skew the factor downward

    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            "2023-01-01": make_uniform_actuals(5000.0),
            "2023-01-02": day2_actuals,
        },
        invalidated_slots_by_date={"2023-01-02": {"12:00"}},
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    # The 12:00 factor was computed only from clean day 1, so it should be ~1.0.
    assert abs(outcome.profile.factors["12:00"] - 1.0) < 1e-6

    # Metadata reflects the invalidation
    assert outcome.metadata.invalidated_slot_count == 1
    assert outcome.metadata.invalidated_slots_by_date == {"2023-01-02": ["12:00"]}


def test_trainer_with_no_invalidation_keeps_existing_behaviour():
    cfg = make_cfg(min_history_days=2, clamp_min=0.5, clamp_max=2.0)

    samples = [
        models.TrainerSample(date="2023-01-01", forecast_wh=5000.0, slot_forecast_wh=make_uniform_slot_forecast(5000.0)),
        models.TrainerSample(date="2023-01-02", forecast_wh=5000.0, slot_forecast_wh=make_uniform_slot_forecast(5000.0)),
    ]
    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            s.date: make_uniform_actuals(s.forecast_wh) for s in samples
        }
    )
    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    assert outcome.metadata.invalidated_slot_count == 0
    assert outcome.metadata.invalidated_slots_by_date == {}


def test_trainer_invalidating_all_days_for_slot_drops_it_to_omitted():
    cfg = make_cfg(min_history_days=2, clamp_min=0.5, clamp_max=2.0)

    samples = [
        models.TrainerSample(date="2023-01-01", forecast_wh=5000.0, slot_forecast_wh=make_uniform_slot_forecast(5000.0)),
        models.TrainerSample(date="2023-01-02", forecast_wh=5000.0, slot_forecast_wh=make_uniform_slot_forecast(5000.0)),
    ]

    actuals = models.SolarActualsWindow(
        slot_actuals_by_date={
            s.date: make_uniform_actuals(s.forecast_wh) for s in samples
        },
        invalidated_slots_by_date={
            "2023-01-01": {"12:00"},
            "2023-01-02": {"12:00"},
        },
    )

    outcome = trainer.train(samples, actuals, cfg, now=datetime.utcnow())

    # 12:00 had every day invalidated → its accumulated forecast falls under the
    # _SLOT_FORECAST_SUM_FLOOR_WH floor and it ends up omitted.
    assert "12:00" not in outcome.profile.factors
    assert "12:00" in outcome.profile.omitted_slots
```

- [ ] **Step 6.2: Run the new tests and verify they fail**

Run:
```
pytest tests/test_solar_bias_trainer.py -v -k "skips_invalidated or no_invalidation_keeps_existing or invalidating_all_days"
```
Expected: 3 failures.

- [ ] **Step 6.3: Update the trainer to skip invalidated slots**

Edit `custom_components/helman/solar_bias_correction/trainer.py`. Inside `train()`, replace the per-slot accumulation block:

```python
    sorted_forecast_slots = sorted(forecast_slot_keys, key=_slot_to_minutes)
    for s in usable_samples:
        day_actuals = actuals.slot_actuals_by_date.get(s.date, {})
        invalidated = actuals.invalidated_slots_by_date.get(s.date, set())
        for slot in sorted_forecast_slots:
            if slot in invalidated:
                continue
            slot_forecast_sums[slot] += s.slot_forecast_wh.get(slot, 0.0)
            slot_actual_sums[slot] += _aggregate_actuals_into_forecast_slot(
                day_actuals,
                forecast_slot=slot,
                forecast_slot_keys=sorted_forecast_slots,
            )
```

After the factors loop completes and before `metadata = SolarBiasMetadata(...)`, build the new metadata fields:

```python
    invalidated_slots_by_date_meta: dict[str, list[str]] = {
        date_str: sorted(slots)
        for date_str, slots in actuals.invalidated_slots_by_date.items()
        if slots
    }
    invalidated_slot_count = sum(
        len(v) for v in invalidated_slots_by_date_meta.values()
    )
```

And include them in the constructor:

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
        error_reason=None,
        invalidated_slots_by_date=invalidated_slots_by_date_meta,
        invalidated_slot_count=invalidated_slot_count,
    )
```

The `insufficient_history` branch above also returns a `SolarBiasMetadata` — give it the same defaults explicitly:

```python
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
            invalidated_slots_by_date={},
            invalidated_slot_count=0,
        )
```

- [ ] **Step 6.4: Run trainer tests and verify they pass**

Run:
```
pytest tests/test_solar_bias_trainer.py -v
```
Expected: all pass.

- [ ] **Step 6.5: Commit**

```
git add custom_components/helman/solar_bias_correction/trainer.py tests/test_solar_bias_trainer.py
git commit -m "feat(solar-bias): trainer skips invalidated slots and surfaces them in metadata"
```

---

## Task 7: Storage v1 → v2 migration in service deserializer

The persisted profile gains the two new metadata fields. v1 stores must keep loading.

**Files:**
- Modify: `custom_components/helman/const.py` — bump versions.
- Modify: `custom_components/helman/storage.py` — accept v1 *and* v2 on read.
- Modify: `custom_components/helman/solar_bias_correction/service.py` — `_metadata_from_dict` defaults the new keys.
- Test: `tests/test_solar_bias_store.py`

- [ ] **Step 7.1: Inspect the existing store test patterns**

```
sed -n '1,80p' tests/test_solar_bias_store.py
```

Note where the store and service deserialization are tested so the new tests follow the same approach.

- [ ] **Step 7.2: Add a failing test for v1 migration**

Append to `tests/test_solar_bias_store.py` (adapt setup/imports to match the existing file's helpers):

```python
def test_metadata_from_dict_defaults_invalidation_fields_when_missing():
    from custom_components.helman.solar_bias_correction.service import (
        _metadata_from_dict,
    )

    raw = {
        "trained_at": "2026-04-26T03:00:00+00:00",
        "training_config_fingerprint": "sha256:abc",
        "usable_days": 5,
        "dropped_days": [],
        "factor_min": None,
        "factor_max": None,
        "factor_median": None,
        "omitted_slot_count": 0,
        "last_outcome": "profile_trained",
    }
    metadata = _metadata_from_dict(raw)
    assert metadata is not None
    assert metadata.invalidated_slots_by_date == {}
    assert metadata.invalidated_slot_count == 0


def test_metadata_from_dict_reads_invalidation_fields_when_present():
    from custom_components.helman.solar_bias_correction.service import (
        _metadata_from_dict,
    )

    raw = {
        "trained_at": "2026-04-26T03:00:00+00:00",
        "training_config_fingerprint": "sha256:abc",
        "usable_days": 5,
        "dropped_days": [],
        "factor_min": None,
        "factor_max": None,
        "factor_median": None,
        "omitted_slot_count": 0,
        "last_outcome": "profile_trained",
        "invalidated_slots_by_date": {"2026-04-20": ["12:00", "12:15"]},
        "invalidated_slot_count": 2,
    }
    metadata = _metadata_from_dict(raw)
    assert metadata is not None
    assert metadata.invalidated_slots_by_date == {"2026-04-20": ["12:00", "12:15"]}
    assert metadata.invalidated_slot_count == 2


async def test_store_accepts_v1_payload():
    from custom_components.helman.storage import SolarBiasCorrectionStore

    payload_v1 = {
        "version": 1,
        "profile": {"factors": {}, "omitted_slots": []},
        "metadata": {
            "trained_at": "2026-04-26T03:00:00+00:00",
            "training_config_fingerprint": "sha256:abc",
            "usable_days": 5,
            "dropped_days": [],
            "factor_min": None,
            "factor_max": None,
            "factor_median": None,
            "omitted_slot_count": 0,
            "last_outcome": "profile_trained",
        },
    }

    # Build a store backed by an in-memory stub of `homeassistant.helpers.storage.Store`.
    # Reuse the test harness already present in this file (e.g., FakeStore).
    store = make_store_with_stored_payload(payload_v1)  # helper to be reused/created
    await store.async_load()
    assert store.profile == payload_v1
```

> If `make_store_with_stored_payload` does not exist, copy the closest helper already used in `test_solar_bias_store.py` (search `class _Stub`/`FakeStore` etc.) and adapt; do not add new infra without checking.

- [ ] **Step 7.3: Run the new tests and verify they fail**

Run:
```
pytest tests/test_solar_bias_store.py -v -k "metadata_from_dict_defaults or metadata_from_dict_reads or accepts_v1_payload"
```
Expected: at least one failure (the v1 store currently rejects non-matching versions).

- [ ] **Step 7.4: Bump version constants**

Edit `custom_components/helman/const.py`:

```python
SOLAR_BIAS_STORAGE_VERSION = 2
SOLAR_BIAS_SUPPORTED_STORE_VERSION = 2
```

- [ ] **Step 7.5: Update store loading to accept v1 *or* v2**

Edit `custom_components/helman/storage.py` `SolarBiasCorrectionStore.async_load`:

```python
    async def async_load(self) -> None:
        stored = await self._store.async_load()
        if not stored:
            self._profile = None
            return

        version = stored.get("version")
        if version not in (1, self._supported_version):
            self._profile = None
            return

        self._profile = stored
```

(Profile/metadata defaulting for v1 happens in `_metadata_from_dict`.)

- [ ] **Step 7.6: Default the new keys in `_metadata_from_dict`**

Edit `custom_components/helman/solar_bias_correction/service.py` — `_metadata_from_dict`. Just before `return SolarBiasMetadata(...)`:

```python
    raw_invalidated_by_date = raw_value.get("invalidated_slots_by_date") or {}
    invalidated_slots_by_date: dict[str, list[str]] = {}
    if isinstance(raw_invalidated_by_date, dict):
        for k, v in raw_invalidated_by_date.items():
            if isinstance(k, str) and isinstance(v, list):
                invalidated_slots_by_date[k] = [s for s in v if isinstance(s, str)]

    raw_invalidated_count = raw_value.get("invalidated_slot_count")
    invalidated_slot_count = (
        raw_invalidated_count if isinstance(raw_invalidated_count, int) else 0
    )
```

Then pass them into the constructor:

```python
    return SolarBiasMetadata(
        trained_at=trained_at,
        training_config_fingerprint=training_config_fingerprint,
        usable_days=usable_days,
        dropped_days=deepcopy(dropped_days),
        factor_min=_optional_float(raw_value.get("factor_min")),
        factor_max=_optional_float(raw_value.get("factor_max")),
        factor_median=_optional_float(raw_value.get("factor_median")),
        omitted_slot_count=omitted_slot_count,
        last_outcome=last_outcome,
        error_reason=raw_value.get("error_reason") if isinstance(raw_value.get("error_reason"), str) else None,
        invalidated_slots_by_date=invalidated_slots_by_date,
        invalidated_slot_count=invalidated_slot_count,
    )
```

Bump the on-disk write version. In `service.py` `async_train`:

```python
            payload = {
                "version": 2,
                "profile": asdict(outcome.profile),
                "metadata": asdict(outcome.metadata),
            }
```

- [ ] **Step 7.7: Run the store tests and verify they pass**

Run:
```
pytest tests/test_solar_bias_store.py tests/test_solar_bias_models.py -v
```
Expected: all pass.

- [ ] **Step 7.8: Commit**

```
git add custom_components/helman/const.py custom_components/helman/storage.py custom_components/helman/solar_bias_correction/service.py tests/test_solar_bias_store.py
git commit -m "feat(solar-bias): persist invalidation metadata; migrate v1 stores to v2"
```

---

## Task 8: Inspector partition — actual vs invalidated dots

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/service.py`
- Test: `tests/test_solar_bias_inspector.py`

- [ ] **Step 8.1: Add failing inspector tests**

Append to `tests/test_solar_bias_inspector.py` (adapt the existing test scaffolding — there is already an inspector-day fixture that calls `async_get_inspector_day`):

```python
async def test_inspector_partitions_actual_points_for_invalidated_slots():
    """When metadata.invalidated_slots_by_date marks a slot, the inspector
    routes that slot's actual point into series.invalidated and removes it
    from series.actual."""
    # Set up a service whose metadata has an invalidated slot for a past date.
    service = await build_service_with_invalidated_metadata(
        date_str="2026-04-20",
        invalidated_slots=["12:00"],
        actuals_by_slot={"11:45": 100.0, "12:00": 80.0, "12:15": 110.0},
    )
    payload = await service.async_get_inspector_day("2026-04-20")

    actual_timestamps = {p["timestamp"] for p in payload["series"]["actual"]}
    invalidated_timestamps = {p["timestamp"] for p in payload["series"]["invalidated"]}

    # 12:00 belongs to invalidated, others to actual; no overlap.
    assert any(ts.endswith("T12:00:00+00:00") for ts in invalidated_timestamps)
    assert all(not ts.endswith("T12:00:00+00:00") for ts in actual_timestamps)
    assert payload["availability"]["hasInvalidated"] is True


async def test_inspector_invalidated_empty_when_no_metadata_for_date():
    service = await build_service_with_invalidated_metadata(
        date_str="2026-04-21",
        invalidated_slots=[],
        actuals_by_slot={"11:45": 100.0, "12:00": 80.0},
    )
    payload = await service.async_get_inspector_day("2026-04-21")
    assert payload["series"]["invalidated"] == []
    assert payload["availability"]["hasInvalidated"] is False


async def test_inspector_today_has_empty_invalidated():
    service = await build_service_today(
        actuals_by_slot={"08:00": 50.0},
    )
    today = service._hass.config.local_today()  # use existing test pattern
    payload = await service.async_get_inspector_day(today.isoformat())
    assert payload["series"]["invalidated"] == []
```

> The names `build_service_with_invalidated_metadata`, `build_service_today` are placeholders for whatever test factory pattern this file already uses. Inspect the existing tests in the file (e.g. `setup_service_*`, `make_service_*`) and use that idiom — do not invent a new fixture if a similar one already exists.

- [ ] **Step 8.2: Run the new tests and verify they fail**

Run:
```
pytest tests/test_solar_bias_inspector.py -v -k "partitions_actual or invalidated_empty_when_no_metadata or today_has_empty_invalidated"
```
Expected: 3 failures.

- [ ] **Step 8.3: Implement the partition in `async_get_inspector_day`**

Edit `custom_components/helman/solar_bias_correction/service.py`. Replace the inspector construction block (the `actual_points = ...` line and the `series=SolarBiasInspectorSeries(...)` call) with the partition:

```python
        actual_points_all = _actual_points_for_date(
            actuals_by_slot,
            target_date,
            ZoneInfo(str(self._hass.config.time_zone)),
        )
        invalidated_keys = self._metadata.invalidated_slots_by_date.get(
            target_date.isoformat(), []
        )
        actual_points, invalidated_points = _partition_actual_points(
            actual_points_all,
            invalidated_keys=set(invalidated_keys),
            slot_actuals_by_slot=actuals_by_slot,
            forecast_slot_keys=sorted(
                self._profile.factors.keys()
                if self._profile is not None and self._profile.factors
                else actuals_by_slot.keys(),
                key=lambda s: int(s.split(":")[0]) * 60 + int(s.split(":")[1]),
            ),
        )
        ...
        series=SolarBiasInspectorSeries(
            raw=_inspector_points(raw_points),
            corrected=_inspector_points(corrected_points),
            actual=actual_points,
            factors=factors,
            invalidated=invalidated_points,
        ),
        ...
        availability=SolarBiasInspectorAvailability(
            has_raw_forecast=bool(raw_points),
            has_corrected_forecast=bool(corrected_points),
            has_actuals=bool(actuals_by_slot),
            has_profile=has_profile,
            has_invalidated=bool(invalidated_points),
        ),
```

Add the helper at the bottom of `service.py`:

```python
def _partition_actual_points(
    actual_points: list[SolarBiasInspectorPoint],
    *,
    invalidated_keys: set[str],
    slot_actuals_by_slot: dict[str, float],
    forecast_slot_keys: list[str],
) -> tuple[list[SolarBiasInspectorPoint], list[SolarBiasInspectorPoint]]:
    if not invalidated_keys:
        return actual_points, []

    # Map every actual sub-slot to its containing forecast slot, then route.
    sub_to_forecast: dict[str, str] = {}
    for sub_slot in slot_actuals_by_slot.keys():
        sub_minutes = int(sub_slot.split(":")[0]) * 60 + int(sub_slot.split(":")[1])
        containing = None
        for forecast_slot in forecast_slot_keys:
            f_minutes = int(forecast_slot.split(":")[0]) * 60 + int(
                forecast_slot.split(":")[1]
            )
            if f_minutes <= sub_minutes:
                containing = forecast_slot
            else:
                break
        sub_to_forecast[sub_slot] = containing or sub_slot

    actual: list[SolarBiasInspectorPoint] = []
    invalidated: list[SolarBiasInspectorPoint] = []
    for point in actual_points:
        # Reconstruct the sub-slot key from the timestamp (HH:MM at the end of the time component).
        time_part = point.timestamp.split("T", 1)[1] if "T" in point.timestamp else ""
        sub_slot = time_part[:5]  # "HH:MM"
        forecast_slot = sub_to_forecast.get(sub_slot, sub_slot)
        if forecast_slot in invalidated_keys:
            invalidated.append(point)
        else:
            actual.append(point)
    return actual, invalidated
```

- [ ] **Step 8.4: Run inspector tests and verify they pass**

Run:
```
pytest tests/test_solar_bias_inspector.py -v
```
Expected: all pass.

- [ ] **Step 8.5: Commit**

```
git add custom_components/helman/solar_bias_correction/service.py tests/test_solar_bias_inspector.py
git commit -m "feat(solar-bias): partition inspector actuals into invalidated subset"
```

---

## Task 9: Status payload — surface invalidated slot count

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/service.py` — `get_status_payload`
- Test: `tests/test_solar_bias_service_runtime.py` (if present) or `tests/test_solar_bias_response.py`

- [ ] **Step 9.1: Locate the status payload test**

```
grep -n "get_status_payload\|invalidated\|status\b" tests/test_solar_bias_service_runtime.py | head -30
```

Pick the closest existing fixture/test for status payload composition.

- [ ] **Step 9.2: Add a failing test for `invalidatedSlotCount` in the status payload**

Append to that test file (adapt naming to existing patterns):

```python
def test_status_payload_includes_invalidated_slot_count():
    service = build_service_with_metadata(
        invalidated_slots_by_date={"2026-04-20": ["12:00", "12:15"]},
        invalidated_slot_count=2,
    )
    payload = service.get_status_payload()
    assert payload["invalidatedSlotCount"] == 2
```

- [ ] **Step 9.3: Run the new test and verify it fails**

Run:
```
pytest tests/test_solar_bias_service_runtime.py -v -k "invalidated_slot_count"
```
Expected: failure (`KeyError` or `AssertionError`).

- [ ] **Step 9.4: Add the new field to `get_status_payload`**

In `service.py` `get_status_payload`, add:

```python
            "invalidatedSlotCount": self._metadata.invalidated_slot_count,
```

Pick a stable position alongside the other `*Count` fields.

- [ ] **Step 9.5: Run the test and verify it passes**

Run:
```
pytest tests/test_solar_bias_service_runtime.py -v
```

- [ ] **Step 9.6: Commit**

```
git add custom_components/helman/solar_bias_correction/service.py tests/test_solar_bias_service_runtime.py
git commit -m "feat(solar-bias): surface invalidatedSlotCount in status payload"
```

---

## Task 10: Frontend editor scope for `slot_invalidation`

**Files:**
- Modify: `custom_components/helman/frontend/src/config-editor-scopes.ts`

- [ ] **Step 10.1: Read `config-editor-scopes.ts` to find the `solar_bias_correction` block**

```
grep -n "solar_bias_correction\|bias_correction" custom_components/helman/frontend/src/config-editor-scopes.ts
```

- [ ] **Step 10.2: Add the new scope id and entry**

In the section that defines `SECTION_SCOPE_IDS.power_devices`, add:

```ts
    bias_correction_slot_invalidation:
      "section:power_devices.solar.bias_correction.slot_invalidation",
```

In the matching scope id union:

```ts
  | "section:power_devices.solar.bias_correction.slot_invalidation"
```

If there is an icon dictionary keyed by scope id, add a sensible icon (for example reuse the bias_correction icon). Then add the entry in `EDITOR_SCOPES`:

```ts
  [SECTION_SCOPE_IDS.power_devices.bias_correction_slot_invalidation]: {
    id: SECTION_SCOPE_IDS.power_devices.bias_correction_slot_invalidation,
    kind: "section",
    parentId: SECTION_SCOPE_IDS.power_devices.solar_bias_correction,
    tabId: "power_devices",
    labelKey: "editor.sections.bias_correction_slot_invalidation",
    adapter: createPathScopeAdapter(
      ["power_devices", "solar", "forecast", "bias_correction", "slot_invalidation"],
      {
        emptyValue: EMPTY_OBJECT,
        rootKind: "object",
      },
    ),
  },
```

> If the editor uses a separate field-level definition (e.g. a per-section "fields" array elsewhere), follow that file's pattern as well — search the codebase for `bias_correction_min_history_days` to find the field-list anchor, and insert the two new fields (`max_battery_soc_percent` and `export_enabled_entity_id`) alongside it. If the editor renders fields automatically from the schema, you may need only the scope and translation keys.

- [ ] **Step 10.3: Run the frontend type check**

```
cd custom_components/helman/frontend && npx tsc --noEmit
```

Expected: no type errors. Address any compiler errors before continuing.

- [ ] **Step 10.4: Commit**

```
git add custom_components/helman/frontend/src/config-editor-scopes.ts
git commit -m "feat(solar-bias): editor scope for slot_invalidation sub-section"
```

---

## Task 11: Frontend translations

**Files:**
- Modify: `custom_components/helman/frontend/src/localize/translations/en.json`
- Modify: each other locale file under `frontend/src/localize/translations/` (mirror keys with English fallback)

- [ ] **Step 11.1: Find existing locales**

```
ls custom_components/helman/frontend/src/localize/translations/
```

- [ ] **Step 11.2: Add the new translation keys to `en.json`**

Add to the `editor.sections` block:

```json
    "bias_correction_slot_invalidation": "Invalidate training slot data",
```

Add to the field-labels block (alongside `bias_correction_min_history_days`):

```json
    "bias_correction_slot_invalidation_max_battery_soc_percent": "Max battery SoC (%)",
    "bias_correction_slot_invalidation_export_enabled_entity_id": "Export enabled sensor",
```

Add to the descriptions block (alongside the other `bias_correction_*` descriptions):

```json
    "bias_correction_slot_invalidation_max_battery_soc_percent": "When the battery SoC reaches or exceeds this percentage during a forecast slot AND the export-enabled sensor reports off at any moment in that slot, the slot is excluded from training. Reason: at high SoC with export disabled, the inverter throttles solar generation and the actuals understate true solar capacity. Recommended: 95–98.",
    "bias_correction_slot_invalidation_export_enabled_entity_id": "Binary sensor / switch / input boolean that indicates whether grid export is enabled. State 'off' means export is disabled. Used together with Max battery SoC to detect inverter clipping."
```

- [ ] **Step 11.3: Mirror to other locales**

For each other locale file, add the same English keys (so the editor falls back gracefully if a locale lacks translations). If the project follows a different fallback pattern (e.g. only `en.json` is used as source), mirror only what the existing pattern requires.

- [ ] **Step 11.4: Commit**

```
git add custom_components/helman/frontend/src/localize/translations/
git commit -m "feat(solar-bias): translations for slot_invalidation section and fields"
```

---

## Task 12: Frontend inspector renders gray dots for invalidated slots

**Files:**
- Modify: `custom_components/helman/frontend/src/bias-correction-inspector.ts`

- [ ] **Step 12.1: Read the existing actuals rendering**

```
grep -n "actual\|red\|series\.\|legend" custom_components/helman/frontend/src/bias-correction-inspector.ts | head -50
```

Identify how `series.actual` is read from the WS payload, where the red dot is drawn (color string and dataset/series array), and where the legend entries are constructed.

- [ ] **Step 12.2: Render the invalidated layer**

Edit `bias-correction-inspector.ts`. Where the component reads the WS payload, also pull the new fields:

```ts
const actual = response?.series?.actual ?? [];
const invalidated = response?.series?.invalidated ?? [];
const hasInvalidated = !!response?.availability?.hasInvalidated;
```

In the chart-builder section that currently emits a red-dot dataset for `actual`, emit a *second* dataset for `invalidated` immediately after, with identical shape/size/Y-axis but a gray fill:

```ts
// existing red-dot dataset for series.actual:
{
  label: this.localize("bias_correction.legend.actual"),
  data: actual.map(p => ({ x: p.timestamp, y: avgPower(p) })),
  type: "scatter",
  pointRadius: 4,
  backgroundColor: "#d32f2f",          // red — unchanged
  showLine: false,
},
// new gray-dot dataset for invalidated slots — same shape, gray colour:
{
  label: this.localize("bias_correction.legend.invalidated"),
  data: invalidated.map(p => ({ x: p.timestamp, y: avgPower(p) })),
  type: "scatter",
  pointRadius: 4,
  backgroundColor: "#9aa0a6",
  showLine: false,
  hidden: !hasInvalidated,             // hides the legend swatch when nothing to show
},
```

(Adapt selectors/options to match whatever charting library this file already uses — Chart.js, vis, ECharts, etc. The point is: the gray dataset uses the **same** coordinate computation as the red dataset; the WS payload guarantees no overlap because the backend partitions.)

If the file constructs a tooltip formatter, special-case the gray dataset's tooltip to read:

```ts
this.localize("bias_correction.tooltip.invalidated")
```

- [ ] **Step 12.3: Add the legend/tooltip translation keys**

Add to the relevant translation files (en.json):

```json
    "bias_correction": {
      ...
      "legend": {
        ...
        "invalidated": "Invalidated (excluded from training)"
      },
      "tooltip": {
        ...
        "invalidated": "excluded from training: battery full + export disabled"
      }
    }
```

(Match existing nesting; do not introduce new top-level structures.)

- [ ] **Step 12.4: Manual visual verification (smoke test)**

```
cd custom_components/helman/frontend && npm run build
```

If a dev server is configured (`npm run dev`), launch it and load the inspector in a browser pointed at a Home Assistant instance with a profile containing `invalidated_slots_by_date` to verify gray vs red rendering. If no dev path exists, rely on the unit tests already added at the backend level — note that explicitly in the commit message.

- [ ] **Step 12.5: Commit**

```
git add custom_components/helman/frontend/src/bias-correction-inspector.ts custom_components/helman/frontend/src/localize/translations/
git commit -m "feat(solar-bias): inspector renders gray dots for invalidated slots"
```

---

## Task 13: Build and commit the frontend bundle

**Files:**
- Modify: `custom_components/helman/frontend/dist/helman-config-editor.js`

- [ ] **Step 13.1: Build**

```
cd custom_components/helman/frontend && npm run build
```

Expected: build succeeds; `dist/helman-config-editor.js` is updated.

- [ ] **Step 13.2: Verify the diff is plausible**

```
git diff --stat custom_components/helman/frontend/dist/helman-config-editor.js
```

Expected: a non-trivial diff; not unrelated to the source changes.

- [ ] **Step 13.3: Commit**

```
git add custom_components/helman/frontend/dist/helman-config-editor.js
git commit -m "build(frontend): rebuild bundle for slot_invalidation feature"
```

---

## Task 14: Whole-suite regression run

- [ ] **Step 14.1: Run the full backend test suite**

```
pytest tests/ -v
```

Expected: all tests pass. If any unrelated failures surface, investigate before merging.

- [ ] **Step 14.2: Run the frontend type check**

```
cd custom_components/helman/frontend && npx tsc --noEmit
```

Expected: no type errors.

- [ ] **Step 14.3: Final manual sanity walk-through**

Verify in the spec that every numbered requirement has a backing task:

- Configuration schema (Tasks 2, 3, 10, 11)
- Invalidation rule (Task 4)
- Data model (Task 1)
- Loader logic (Task 5)
- Trainer changes (Task 6)
- Storage / migration (Task 7)
- Surfaced telemetry — status panel (Task 9), inspector payload (Task 8), trainer log (note: optional follow-up; if the user wants the explicit log line, add a `_LOGGER.info(...)` line at the end of `service.async_train` referring to `outcome.metadata.invalidated_slot_count`)
- Visual inspector backend & frontend (Tasks 8, 12)
- Editor UI (Tasks 10, 11)
- Validation (Task 3)
- Tests (each task ships its own)
- Frontend bundle (Task 13)

- [ ] **Step 14.4: Commit a summary tag (optional)**

If using milestone commits, add an empty commit:

```
git commit --allow-empty -m "feat(solar-bias): slot invalidation feature complete"
```

---

## Self-review notes

- Plan covers every spec section: data model (T1), config parsing (T2), validation (T3), pure-rule (T4), loader (T5), trainer (T6), storage migration (T7), inspector backend (T8), status payload (T9), editor scope (T10), translations (T11), inspector frontend (T12), bundle (T13), suite (T14).
- All steps either show concrete code or invoke an existing pattern with a clear pointer — no `TBD`, no "implement later".
- Type/name consistency: `BiasConfig.slot_invalidation_max_battery_soc_percent` and `slot_invalidation_export_enabled_entity_id` used identically across T2, T5; `SolarActualsWindow.invalidated_slots_by_date` typed `dict[str, set[str]]` in T1 and consumed identically in T6; `SolarBiasMetadata.invalidated_slots_by_date` typed `dict[str, list[str]]` (sorted), consumed in T6/T7/T8; payload keys (`series.invalidated`, `availability.hasInvalidated`, `invalidatedSlotCount`) consistent across T1, T8, T9, T12.
- Trainer log line is flagged in T14 as the only optional spec item; everything else maps to a concrete task.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-26-solar-bias-slot-invalidation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
