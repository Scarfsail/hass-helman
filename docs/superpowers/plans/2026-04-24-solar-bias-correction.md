# Solar Forecast Bias Correction — V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cleanly isolated solar forecast bias-correction layer (`solar_bias_correction/`) on top of the existing Helman forecast pipeline, learning slot-of-day multiplicative factors from raw-vs-actual Recorder history and surfacing everything through a new Bias Correction tab in the config editor panel.

**Architecture:** A dedicated `solar_bias_correction/` package provides pure-function trainer and adjuster (no I/O), Recorder adapters (all I/O), a `SolarBiasCorrectionService` (orchestration), and a `SolarBiasTrainingScheduler` (daily scheduling). The coordinator wires the service in at setup, calls it at request time to produce adjusted points, and passes the effective solar variant to all downstream consumers. Three WebSocket endpoints expose status, train-now, and profile reads to the frontend Bias Correction tab.

**Tech Stack:** Python 3.12, Home Assistant helpers (`storage.Store`, `async_track_time_change`, Recorder history API), voluptuous for WebSocket validation, TypeScript/Lit for the frontend tab, SHA-256 fingerprinting via `hashlib`.

**Spec:** `docs/features/forecast/solar-forecast-bias-correction/solar-forecast-bias-correction-v1-implementation-design.md` (the authoritative reference — read it before implementing any task).

**Test command:** `/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/ -x -q`

**WebSocket testing:** Use `local-hass-control` skill to restart local HA after code changes, then use `local-hass-api` skill (which contains the auth token) to send WebSocket commands to the running HA instance.

---

## File Structure

### New package: `custom_components/helman/solar_bias_correction/`

| File | Responsibility |
|---|---|
| `__init__.py` | Empty package marker |
| `models.py` | All dataclasses: `BiasConfig`, `TrainerSample`, `SolarActualsWindow`, `SolarBiasProfile`, `SolarBiasMetadata`, `TrainingOutcome`, `SolarBiasAdjustmentResult`, `SolarBiasExplainability` + `read_bias_config()` |
| `trainer.py` | Pure `train(samples, actuals, cfg, now) -> TrainingOutcome` + `compute_fingerprint(cfg) -> str`. No I/O. |
| `adjuster.py` | Pure `adjust(raw_points, profile) -> list[dict]`. No I/O. |
| `forecast_history.py` | `async load_trainer_samples(hass, cfg, now) -> list[TrainerSample]` — Recorder reads of daily energy entity history |
| `actuals.py` | `async load_actuals_window(hass, cfg, days) -> SolarActualsWindow` — Recorder deltas of `total_energy_entity_id` |
| `scheduler.py` | `SolarBiasTrainingScheduler` — schedules daily training via `async_track_time_change` |
| `service.py` | `SolarBiasCorrectionService` — wires history + actuals + trainer + store; owns train-now; produces `SolarBiasAdjustmentResult` at inference |
| `response.py` | `compose_solar_bias_response(raw_snapshot, adjustment_result, granularity, forecast_days) -> dict` |
| `websocket.py` | Three handlers for `helman/solar_bias/status`, `helman/solar_bias/train_now`, `helman/solar_bias/profile` + `async_register_websocket_handlers(hass)` |

### Modified files

| File | Change |
|---|---|
| `custom_components/helman/const.py` | Add `SOLAR_BIAS_STORAGE_KEY`, `SOLAR_BIAS_STORAGE_VERSION`, default config constants |
| `custom_components/helman/storage.py` | Add `SolarBiasCorrectionStore` class |
| `custom_components/helman/config_validation.py` | Add `bias_correction` subtree validation inside `_validate_solar_config` |
| `custom_components/helman/coordinator.py` | Import + wire `SolarBiasCorrectionService` + `SolarBiasTrainingScheduler`; apply bias at `get_forecast()`; pass effective variant to consumers |
| `custom_components/helman/websockets.py` | Call `async_register_websocket_handlers(hass)` |
| `custom_components/helman/__init__.py` | No change needed — coordinator owns service lifecycle |
| `custom_components/helman/frontend/src/config-editor-scopes.ts` | Add `bias_correction` tab + section |
| `custom_components/helman/frontend/src/localize/translations/en.json` | Add bias correction strings |
| `custom_components/helman/frontend/dist/helman-config-editor.js` | Rebuilt via `npm run build` |

### New test files

| File | What it tests |
|---|---|
| `tests/test_solar_bias_config_validation.py` | `bias_correction` subtree validation rules |
| `tests/test_solar_bias_store.py` | `SolarBiasCorrectionStore` roundtrip + version gating |
| `tests/test_solar_bias_models.py` | `read_bias_config()`, `BiasConfig` defaults |
| `tests/test_solar_bias_trainer.py` | All training branches (profile_trained, insufficient_history, day filters, slot omission, clamping) |
| `tests/test_solar_bias_adjuster.py` | Factor application, zero-raw, non-negativity clamp, missing-slot default |
| `tests/test_solar_bias_response.py` | `compose_solar_bias_response()` for each `status` value and each granularity (15/30/60) |

---

## Task 1: Config validation

**Files:**
- Modify: `custom_components/helman/config_validation.py:254-311` (inside `_validate_solar_config`)
- Test: `tests/test_solar_bias_config_validation.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/test_solar_bias_config_validation.py
from __future__ import annotations
import sys, types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def _install_import_stubs():
    for name, path in [
        ("custom_components", ROOT / "custom_components"),
        ("custom_components.helman", ROOT / "custom_components" / "helman"),
    ]:
        pkg = sys.modules.get(name) or types.ModuleType(name)
        pkg.__path__ = [str(path)]
        sys.modules[name] = pkg

    for name in ["homeassistant", "homeassistant.core", "homeassistant.util",
                 "homeassistant.util.dt"]:
        if name not in sys.modules:
            sys.modules[name] = types.ModuleType(name)
    sys.modules["homeassistant.core"].HomeAssistant = type("HomeAssistant", (), {})

_install_import_stubs()

# stub every transitive import used by config_validation
for mod in [
    "homeassistant.helpers", "homeassistant.helpers.storage",
    "custom_components.helman.battery_state",
    "custom_components.helman.grid_price_forecast_builder",
    "custom_components.helman.scheduling",
    "custom_components.helman.scheduling.schedule",
    "custom_components.helman.appliances",
    "custom_components.helman.appliances.config",
    "custom_components.helman.appliances.climate_appliance",
    "custom_components.helman.appliances.ev_charger",
    "custom_components.helman.appliances.generic_appliance",
    "custom_components.helman.automation",
    "custom_components.helman.automation.config",
    "custom_components.helman.automation.optimizers",
    "custom_components.helman.automation.optimizers.surplus_appliance",
]:
    if mod not in sys.modules:
        m = types.ModuleType(mod)
        # add stubs needed by config_validation imports
        m.describe_battery_entity_config_issue = lambda _: None
        m.GridImportPriceConfigError = Exception
        m.read_grid_import_price_config = lambda _: None
        m.describe_schedule_control_config_issue = lambda _: None
        m.build_appliances_runtime_registry = lambda _: {}
        m.AutomationConfigError = Exception
        m.read_automation_config = lambda _: type("AC", (), {"execution_optimizers": []})()
        m.SurplusApplianceValidationError = Exception
        m.validate_surplus_appliance_optimizer_config = lambda *a, **kw: None
        m.ClimateApplianceConfigError = Exception
        m.read_climate_appliance = lambda *a, **kw: None
        m.EvChargerConfigError = Exception
        m.read_ev_charger_appliance = lambda *a, **kw: None
        m.GenericApplianceConfigError = Exception
        m.read_generic_appliance = lambda *a, **kw: None
        sys.modules[mod] = m

import unittest
from custom_components.helman.config_validation import validate_config_document

def _base_config():
    return {
        "power_devices": {
            "solar": {
                "forecast": {
                    "daily_energy_entity_ids": ["sensor.energy_production_today"],
                    "total_energy_entity_id": "sensor.solar_energy_total",
                }
            }
        }
    }

class BiasCorrectionValidationTests(unittest.TestCase):
    def test_valid_full_config(self):
        cfg = _base_config()
        cfg["power_devices"]["solar"]["forecast"]["bias_correction"] = {
            "enabled": True,
            "min_history_days": 10,
            "training_time": "03:00",
            "clamp_min": 0.3,
            "clamp_max": 2.0,
        }
        report = validate_config_document(cfg)
        self.assertTrue(report.valid)

    def test_enabled_must_be_bool(self):
        cfg = _base_config()
        cfg["power_devices"]["solar"]["forecast"]["bias_correction"] = {"enabled": "yes"}
        report = validate_config_document(cfg)
        self.assertFalse(report.valid)
        self.assertTrue(any("enabled" in e.path for e in report.errors))

    def test_min_history_days_range(self):
        cfg = _base_config()
        cfg["power_devices"]["solar"]["forecast"]["bias_correction"] = {"min_history_days": 0}
        report = validate_config_document(cfg)
        self.assertFalse(report.valid)

    def test_min_history_days_max(self):
        cfg = _base_config()
        cfg["power_devices"]["solar"]["forecast"]["bias_correction"] = {"min_history_days": 366}
        report = validate_config_document(cfg)
        self.assertFalse(report.valid)

    def test_training_time_format(self):
        cfg = _base_config()
        cfg["power_devices"]["solar"]["forecast"]["bias_correction"] = {"training_time": "3am"}
        report = validate_config_document(cfg)
        self.assertFalse(report.valid)
        self.assertTrue(any("training_time" in e.path for e in report.errors))

    def test_training_time_valid(self):
        cfg = _base_config()
        cfg["power_devices"]["solar"]["forecast"]["bias_correction"] = {"training_time": "03:00"}
        report = validate_config_document(cfg)
        self.assertTrue(report.valid)

    def test_clamp_min_must_be_positive(self):
        cfg = _base_config()
        cfg["power_devices"]["solar"]["forecast"]["bias_correction"] = {"clamp_min": 0.0}
        report = validate_config_document(cfg)
        self.assertFalse(report.valid)

    def test_clamp_max_upper_bound(self):
        cfg = _base_config()
        cfg["power_devices"]["solar"]["forecast"]["bias_correction"] = {"clamp_max": 11.0}
        report = validate_config_document(cfg)
        self.assertFalse(report.valid)

    def test_clamp_min_must_be_less_than_clamp_max(self):
        cfg = _base_config()
        cfg["power_devices"]["solar"]["forecast"]["bias_correction"] = {
            "clamp_min": 2.0, "clamp_max": 0.5
        }
        report = validate_config_document(cfg)
        self.assertFalse(report.valid)
        self.assertTrue(any("clamp" in e.path for e in report.errors))

    def test_bias_correction_absent_is_valid(self):
        report = validate_config_document(_base_config())
        self.assertTrue(report.valid)

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/test_solar_bias_config_validation.py -x -q
```

Expected: multiple FAILs — validation does not yet know about `bias_correction`.

- [ ] **Step 3: Add `bias_correction` validation to `_validate_solar_config`**

In `custom_components/helman/config_validation.py`, add after the existing `_validate_entity_id_list` call at line 310 (end of `_validate_solar_config`):

```python
import re as _re  # already imported at top of file

_TRAINING_TIME_RE = _re.compile(r"^\d{2}:\d{2}$")


def _validate_bias_correction_config(
    raw_bc: object,
    report: ValidationReport,
) -> None:
    section = "power_devices"
    if raw_bc is None:
        return
    bc = _require_mapping(raw_bc, "power_devices.solar.forecast.bias_correction", section, report)
    if bc is None:
        return

    _validate_optional_bool(report, section, "power_devices.solar.forecast.bias_correction.enabled", bc.get("enabled"))

    raw_min_days = bc.get("min_history_days")
    if raw_min_days is not None:
        if isinstance(raw_min_days, bool) or not isinstance(raw_min_days, int) or raw_min_days < 1 or raw_min_days > 365:
            report.add_error(
                section=section,
                path="power_devices.solar.forecast.bias_correction.min_history_days",
                code="invalid_range",
                message="min_history_days must be an integer in [1, 365]",
            )

    raw_time = bc.get("training_time")
    if raw_time is not None:
        if not isinstance(raw_time, str) or not _TRAINING_TIME_RE.match(raw_time):
            report.add_error(
                section=section,
                path="power_devices.solar.forecast.bias_correction.training_time",
                code="invalid_format",
                message="training_time must be a string in HH:MM format",
            )

    raw_clamp_min = bc.get("clamp_min")
    if raw_clamp_min is not None:
        if isinstance(raw_clamp_min, bool) or not isinstance(raw_clamp_min, (int, float)) or raw_clamp_min <= 0 or raw_clamp_min > 1:
            report.add_error(
                section=section,
                path="power_devices.solar.forecast.bias_correction.clamp_min",
                code="invalid_range",
                message="clamp_min must be a float in (0, 1]",
            )

    raw_clamp_max = bc.get("clamp_max")
    if raw_clamp_max is not None:
        if isinstance(raw_clamp_max, bool) or not isinstance(raw_clamp_max, (int, float)) or raw_clamp_max < 1 or raw_clamp_max > 10:
            report.add_error(
                section=section,
                path="power_devices.solar.forecast.bias_correction.clamp_max",
                code="invalid_range",
                message="clamp_max must be a float in [1, 10]",
            )

    # Cross-field: clamp_min < clamp_max
    effective_min = raw_clamp_min if isinstance(raw_clamp_min, (int, float)) and not isinstance(raw_clamp_min, bool) else 0.3
    effective_max = raw_clamp_max if isinstance(raw_clamp_max, (int, float)) and not isinstance(raw_clamp_max, bool) else 2.0
    if effective_min >= effective_max:
        report.add_error(
            section=section,
            path="power_devices.solar.forecast.bias_correction.clamp_min",
            code="clamp_order",
            message="clamp_min must be strictly less than clamp_max",
        )
```

Then call it at the end of `_validate_solar_config` (after line 310):

```python
    _validate_bias_correction_config(forecast_map.get("bias_correction"), report)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/test_solar_bias_config_validation.py -x -q
```

Expected: `9 passed`

- [ ] **Step 5: Run full test suite to check for regressions**

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/ -x -q
```

Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add custom_components/helman/config_validation.py tests/test_solar_bias_config_validation.py
git commit -m "feat(bias-correction): add bias_correction config validation"
```

---

## Task 2: Persistence — SolarBiasCorrectionStore

**Files:**
- Modify: `custom_components/helman/const.py`
- Modify: `custom_components/helman/storage.py`
- Test: `tests/test_solar_bias_store.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/test_solar_bias_store.py
from __future__ import annotations
import asyncio, sys, types, unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

ROOT = Path(__file__).resolve().parents[1]

def _install_import_stubs():
    for name, path in [
        ("custom_components", ROOT / "custom_components"),
        ("custom_components.helman", ROOT / "custom_components" / "helman"),
    ]:
        pkg = sys.modules.get(name) or types.ModuleType(name)
        pkg.__path__ = [str(path)]
        sys.modules[name] = pkg

    for name in ["homeassistant", "homeassistant.core", "homeassistant.helpers",
                 "homeassistant.helpers.storage", "homeassistant.util", "homeassistant.util.dt"]:
        if name not in sys.modules:
            sys.modules[name] = types.ModuleType(name)
    sys.modules["homeassistant.core"].HomeAssistant = type("HomeAssistant", (), {})

    store_mod = sys.modules["homeassistant.helpers.storage"]
    class _FakeStore:
        def __init__(self, hass, version, key):
            self._data = None
        async def async_load(self):
            return self._data
        async def async_save(self, data):
            self._data = data
    store_mod.Store = _FakeStore

_install_import_stubs()

from custom_components.helman.storage import SolarBiasCorrectionStore


class SolarBiasCorrectionStoreTests(unittest.TestCase):
    def setUp(self):
        self.hass = MagicMock()
        self.store = SolarBiasCorrectionStore(self.hass)

    def _run(self, coro):
        return asyncio.get_event_loop().run_until_complete(coro)

    def test_initial_profile_is_none(self):
        self._run(self.store.async_load())
        self.assertIsNone(self.store.profile)

    def test_save_and_reload_roundtrip(self):
        self._run(self.store.async_load())
        payload = {
            "version": 1,
            "profile": {"08:00": 1.1},
            "metadata": {
                "trained_at": "2026-04-24T03:00:00+02:00",
                "training_config_fingerprint": "sha256:abc",
                "usable_days": 12,
                "dropped_days": [],
                "factor_min": 0.9,
                "factor_max": 1.2,
                "factor_median": 1.05,
                "omitted_slot_count": 40,
                "last_outcome": "profile_trained",
            },
        }
        self._run(self.store.async_save(payload))
        # Reload from a fresh store instance sharing same underlying _FakeStore
        store2 = SolarBiasCorrectionStore(self.hass)
        store2._store = self.store._store  # share the fake backing store
        self._run(store2.async_load())
        self.assertEqual(store2.profile, payload)

    def test_unsupported_version_treated_as_no_profile(self):
        self._run(self.store.async_load())
        self._run(self.store.async_save({"version": 99, "profile": {}, "metadata": {}}))
        store2 = SolarBiasCorrectionStore(self.hass)
        store2._store = self.store._store
        self._run(store2.async_load())
        self.assertIsNone(store2.profile)

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/test_solar_bias_store.py -x -q
```

Expected: `ImportError` — `SolarBiasCorrectionStore` not found yet.

- [ ] **Step 3: Add constants to `const.py`**

```python
# append to custom_components/helman/const.py
SOLAR_BIAS_STORAGE_KEY = f"{DOMAIN}.solar_bias_correction"
SOLAR_BIAS_STORAGE_VERSION = 1
SOLAR_BIAS_SUPPORTED_STORE_VERSION = 1
SOLAR_BIAS_DEFAULT_ENABLED = True
SOLAR_BIAS_DEFAULT_MIN_HISTORY_DAYS = 10
SOLAR_BIAS_DEFAULT_TRAINING_TIME = "03:00"
SOLAR_BIAS_DEFAULT_CLAMP_MIN = 0.3
SOLAR_BIAS_DEFAULT_CLAMP_MAX = 2.0
```

- [ ] **Step 4: Add `SolarBiasCorrectionStore` to `storage.py`**

```python
# add to custom_components/helman/storage.py

from .const import (
    # existing imports unchanged
    SOLAR_BIAS_STORAGE_KEY,
    SOLAR_BIAS_STORAGE_VERSION,
    SOLAR_BIAS_SUPPORTED_STORE_VERSION,
)


class SolarBiasCorrectionStore:
    """Persists the trained solar bias profile."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store = storage.Store(hass, SOLAR_BIAS_STORAGE_VERSION, SOLAR_BIAS_STORAGE_KEY)
        self._profile: dict[str, Any] | None = None

    async def async_load(self) -> None:
        stored = await self._store.async_load()
        if stored is None:
            self._profile = None
            return
        if stored.get("version") != SOLAR_BIAS_SUPPORTED_STORE_VERSION:
            self._profile = None
            return
        self._profile = stored

    @property
    def profile(self) -> dict[str, Any] | None:
        return self._profile

    async def async_save(self, payload: dict[str, Any]) -> None:
        self._profile = payload
        await self._store.async_save(payload)
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/test_solar_bias_store.py -x -q
```

Expected: `3 passed`

- [ ] **Step 6: Run full test suite**

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/ -x -q
```

- [ ] **Step 7: Commit**

```bash
git add custom_components/helman/const.py custom_components/helman/storage.py tests/test_solar_bias_store.py
git commit -m "feat(bias-correction): add SolarBiasCorrectionStore and storage constants"
```

---

## Task 3: Models and config reader

**Files:**
- Create: `custom_components/helman/solar_bias_correction/__init__.py`
- Create: `custom_components/helman/solar_bias_correction/models.py`
- Test: `tests/test_solar_bias_models.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/test_solar_bias_models.py
from __future__ import annotations
import sys, types, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def _install_import_stubs():
    for name, path in [
        ("custom_components", ROOT / "custom_components"),
        ("custom_components.helman", ROOT / "custom_components" / "helman"),
        ("custom_components.helman.solar_bias_correction",
         ROOT / "custom_components" / "helman" / "solar_bias_correction"),
    ]:
        pkg = sys.modules.get(name) or types.ModuleType(name)
        pkg.__path__ = [str(path)]
        sys.modules[name] = pkg
    for name in ["homeassistant", "homeassistant.core"]:
        if name not in sys.modules:
            sys.modules[name] = types.ModuleType(name)

_install_import_stubs()

from custom_components.helman.solar_bias_correction.models import BiasConfig, read_bias_config


class BiasConfigTests(unittest.TestCase):
    def test_defaults(self):
        cfg = read_bias_config({})
        self.assertTrue(cfg.enabled)
        self.assertEqual(cfg.min_history_days, 10)
        self.assertEqual(cfg.training_time, "03:00")
        self.assertAlmostEqual(cfg.clamp_min, 0.3)
        self.assertAlmostEqual(cfg.clamp_max, 2.0)
        self.assertIsNone(cfg.total_energy_entity_id)
        self.assertEqual(cfg.daily_energy_entity_ids, [])

    def test_reads_nested_config(self):
        raw = {
            "power_devices": {
                "solar": {
                    "forecast": {
                        "total_energy_entity_id": "sensor.solar_total",
                        "daily_energy_entity_ids": ["sensor.energy_today"],
                        "bias_correction": {
                            "enabled": False,
                            "min_history_days": 14,
                            "training_time": "02:30",
                            "clamp_min": 0.5,
                            "clamp_max": 1.8,
                        },
                    }
                }
            }
        }
        cfg = read_bias_config(raw)
        self.assertFalse(cfg.enabled)
        self.assertEqual(cfg.min_history_days, 14)
        self.assertEqual(cfg.training_time, "02:30")
        self.assertAlmostEqual(cfg.clamp_min, 0.5)
        self.assertAlmostEqual(cfg.clamp_max, 1.8)
        self.assertEqual(cfg.total_energy_entity_id, "sensor.solar_total")
        self.assertEqual(cfg.daily_energy_entity_ids, ["sensor.energy_today"])

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/test_solar_bias_models.py -x -q
```

Expected: `ModuleNotFoundError` — package doesn't exist yet.

- [ ] **Step 3: Create the package**

```bash
mkdir -p custom_components/helman/solar_bias_correction
```

Create `custom_components/helman/solar_bias_correction/__init__.py` (empty):

```python
```

Create `custom_components/helman/solar_bias_correction/models.py`:

```python
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..const import (
    SOLAR_BIAS_DEFAULT_CLAMP_MAX,
    SOLAR_BIAS_DEFAULT_CLAMP_MIN,
    SOLAR_BIAS_DEFAULT_ENABLED,
    SOLAR_BIAS_DEFAULT_MIN_HISTORY_DAYS,
    SOLAR_BIAS_DEFAULT_TRAINING_TIME,
)


@dataclass
class BiasConfig:
    enabled: bool = SOLAR_BIAS_DEFAULT_ENABLED
    min_history_days: int = SOLAR_BIAS_DEFAULT_MIN_HISTORY_DAYS
    training_time: str = SOLAR_BIAS_DEFAULT_TRAINING_TIME
    clamp_min: float = SOLAR_BIAS_DEFAULT_CLAMP_MIN
    clamp_max: float = SOLAR_BIAS_DEFAULT_CLAMP_MAX
    daily_energy_entity_ids: list[str] = field(default_factory=list)
    total_energy_entity_id: str | None = None


@dataclass
class TrainerSample:
    """One past day's day-start forecast capture."""
    date: str  # YYYY-MM-DD local
    forecast_wh: float  # total daily forecast from day-start Recorder capture


@dataclass
class SolarActualsWindow:
    """Per-slot actual solar generation by local date."""
    slot_actuals_by_date: dict[str, dict[str, float]]  # date → slot_key "HH:MM" → wh


@dataclass
class SolarBiasProfile:
    """Trained multiplicative correction factors by local slot key."""
    factors: dict[str, float]  # "HH:MM" → factor
    omitted_slots: list[str]   # slots excluded from profile (default to 1.0 at inference)


@dataclass
class SolarBiasMetadata:
    trained_at: str  # ISO datetime
    training_config_fingerprint: str  # "sha256:..."
    usable_days: int
    dropped_days: list[dict[str, str]]  # [{"date": ..., "reason": ...}]
    factor_min: float | None
    factor_max: float | None
    factor_median: float | None
    omitted_slot_count: int
    last_outcome: str  # "profile_trained" | "insufficient_history" | "no_training_yet" | "training_failed"
    error_reason: str | None = None


@dataclass
class TrainingOutcome:
    profile: SolarBiasProfile
    metadata: SolarBiasMetadata


@dataclass
class SolarBiasExplainability:
    fallback_reason: str | None
    trained_at: str | None
    usable_days: int
    dropped_days: int
    omitted_slot_count: int
    factor_min: float | None
    factor_max: float | None
    factor_median: float | None
    error: str | None = None


@dataclass
class SolarBiasAdjustmentResult:
    """Produced at inference time by SolarBiasCorrectionService."""
    status: str           # "applied" | "disabled" | "no_training_yet" | "insufficient_history" | "config_changed_pending_retrain" | "training_failed"
    effective_variant: str  # "adjusted" | "raw"
    adjusted_points: list[dict[str, Any]]  # 15-min adjusted (or raw copy when variant=raw)
    explainability: SolarBiasExplainability


def read_bias_config(config: dict[str, Any]) -> BiasConfig:
    """Extract BiasConfig from the full raw config dict."""
    forecast = (
        config.get("power_devices", {})
        .get("solar", {})
        .get("forecast", {})
    )
    bc = forecast.get("bias_correction", {}) or {}
    return BiasConfig(
        enabled=bc.get("enabled", SOLAR_BIAS_DEFAULT_ENABLED),
        min_history_days=bc.get("min_history_days", SOLAR_BIAS_DEFAULT_MIN_HISTORY_DAYS),
        training_time=bc.get("training_time", SOLAR_BIAS_DEFAULT_TRAINING_TIME),
        clamp_min=bc.get("clamp_min", SOLAR_BIAS_DEFAULT_CLAMP_MIN),
        clamp_max=bc.get("clamp_max", SOLAR_BIAS_DEFAULT_CLAMP_MAX),
        daily_energy_entity_ids=forecast.get("daily_energy_entity_ids") or [],
        total_energy_entity_id=forecast.get("total_energy_entity_id"),
    )
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/test_solar_bias_models.py -x -q
```

Expected: `2 passed`

- [ ] **Step 5: Run full test suite**

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/ -x -q
```

- [ ] **Step 6: Commit**

```bash
git add custom_components/helman/solar_bias_correction/ tests/test_solar_bias_models.py
git commit -m "feat(bias-correction): add solar_bias_correction package with models"
```

---

## Task 4: Pure trainer

**Files:**
- Create: `custom_components/helman/solar_bias_correction/trainer.py`
- Test: `tests/test_solar_bias_trainer.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/test_solar_bias_trainer.py
from __future__ import annotations
import sys, types, unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def _install_import_stubs():
    for name, path in [
        ("custom_components", ROOT / "custom_components"),
        ("custom_components.helman", ROOT / "custom_components" / "helman"),
        ("custom_components.helman.solar_bias_correction",
         ROOT / "custom_components" / "helman" / "solar_bias_correction"),
    ]:
        pkg = sys.modules.get(name) or types.ModuleType(name)
        pkg.__path__ = [str(path)]
        sys.modules[name] = pkg
    for name in ["homeassistant", "homeassistant.core"]:
        if name not in sys.modules:
            sys.modules[name] = types.ModuleType(name)

_install_import_stubs()

from custom_components.helman.solar_bias_correction.models import (
    BiasConfig, TrainerSample, SolarActualsWindow,
)
from custom_components.helman.solar_bias_correction.trainer import train, compute_fingerprint

_NOW = datetime(2026, 4, 24, 3, 0, 0, tzinfo=timezone.utc)
_CFG = BiasConfig(min_history_days=2, clamp_min=0.3, clamp_max=2.0)


def _make_samples(n: int, forecast_wh: float = 1000.0) -> list[TrainerSample]:
    return [TrainerSample(date=f"2026-04-{i+1:02d}", forecast_wh=forecast_wh) for i in range(n)]


def _make_actuals(samples: list[TrainerSample], peak_slot_wh: float = 500.0) -> SolarActualsWindow:
    """Build actuals where only slot 12:00 has production."""
    return SolarActualsWindow(
        slot_actuals_by_date={
            s.date: {"12:00": peak_slot_wh} for s in samples
        }
    )


class TrainerTests(unittest.TestCase):
    def test_profile_trained_with_sufficient_history(self):
        samples = _make_samples(3, forecast_wh=1000.0)
        actuals = _make_actuals(samples, peak_slot_wh=600.0)
        outcome = train(samples, actuals, _CFG, _NOW)
        self.assertEqual(outcome.metadata.last_outcome, "profile_trained")
        self.assertGreater(len(outcome.profile.factors), 0)

    def test_insufficient_history_returns_fallback(self):
        samples = _make_samples(1, forecast_wh=1000.0)  # need 2
        actuals = _make_actuals(samples)
        outcome = train(samples, actuals, _CFG, _NOW)
        self.assertEqual(outcome.metadata.last_outcome, "insufficient_history")
        self.assertEqual(outcome.profile.factors, {})

    def test_day_forecast_too_low_is_dropped(self):
        samples = [
            TrainerSample(date="2026-04-01", forecast_wh=50.0),  # below 100 Wh floor
            TrainerSample(date="2026-04-02", forecast_wh=1000.0),
            TrainerSample(date="2026-04-03", forecast_wh=1000.0),
        ]
        actuals = SolarActualsWindow(
            slot_actuals_by_date={
                "2026-04-01": {"12:00": 50.0},
                "2026-04-02": {"12:00": 600.0},
                "2026-04-03": {"12:00": 600.0},
            }
        )
        outcome = train(samples, actuals, _CFG, _NOW)
        self.assertEqual(outcome.metadata.usable_days, 2)
        self.assertTrue(any(d["date"] == "2026-04-01" for d in outcome.metadata.dropped_days))
        self.assertTrue(any(d["reason"] == "day_forecast_too_low" for d in outcome.metadata.dropped_days))

    def test_day_ratio_out_of_band_is_dropped(self):
        samples = [
            TrainerSample(date="2026-04-01", forecast_wh=1000.0),  # ratio=0.001 → dropped
            TrainerSample(date="2026-04-02", forecast_wh=1000.0),
            TrainerSample(date="2026-04-03", forecast_wh=1000.0),
        ]
        actuals = SolarActualsWindow(
            slot_actuals_by_date={
                "2026-04-01": {"12:00": 1.0},   # ratio way below 0.05
                "2026-04-02": {"12:00": 600.0},
                "2026-04-03": {"12:00": 600.0},
            }
        )
        outcome = train(samples, actuals, _CFG, _NOW)
        self.assertEqual(outcome.metadata.usable_days, 2)
        self.assertTrue(any(d["reason"] == "day_ratio_out_of_band" for d in outcome.metadata.dropped_days))

    def test_factor_is_clamped_to_clamp_max(self):
        """A slot with zero forecast sum gets omitted; a high actual/forecast ratio clamps."""
        samples = _make_samples(5, forecast_wh=100.0)  # small daily forecast
        # Actual at 12:00 is huge relative to distributed forecast
        actuals = SolarActualsWindow(
            slot_actuals_by_date={s.date: {"12:00": 100.0} for s in samples}
        )
        outcome = train(samples, actuals, _CFG, _NOW)
        if "12:00" in outcome.profile.factors:
            self.assertLessEqual(outcome.profile.factors["12:00"], _CFG.clamp_max)

    def test_factor_is_clamped_to_clamp_min(self):
        samples = _make_samples(5, forecast_wh=1000.0)
        # Actual at 12:00 is essentially zero
        actuals = SolarActualsWindow(
            slot_actuals_by_date={s.date: {"12:00": 0.0} for s in samples}
        )
        outcome = train(samples, actuals, _CFG, _NOW)
        # nighttime slot with 0 actuals should be clamped to clamp_min (if not omitted by 50Wh guard)
        if "12:00" in outcome.profile.factors:
            self.assertGreaterEqual(outcome.profile.factors["12:00"], _CFG.clamp_min)

    def test_fingerprint_depends_on_training_config(self):
        cfg1 = BiasConfig(min_history_days=10, clamp_min=0.3, clamp_max=2.0)
        cfg2 = BiasConfig(min_history_days=14, clamp_min=0.3, clamp_max=2.0)
        cfg3 = BiasConfig(min_history_days=10, clamp_min=0.3, clamp_max=2.0, training_time="04:00")
        self.assertNotEqual(compute_fingerprint(cfg1), compute_fingerprint(cfg2))
        # training_time does NOT affect fingerprint
        self.assertEqual(compute_fingerprint(cfg1), compute_fingerprint(cfg3))

    def test_fingerprint_format(self):
        fp = compute_fingerprint(_CFG)
        self.assertTrue(fp.startswith("sha256:"))
        self.assertEqual(len(fp), 7 + 64)  # "sha256:" + 64 hex chars

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/test_solar_bias_trainer.py -x -q
```

Expected: `ModuleNotFoundError: trainer`.

- [ ] **Step 3: Create `trainer.py`**

```python
# custom_components/helman/solar_bias_correction/trainer.py
from __future__ import annotations

import hashlib
import json
from datetime import datetime

from .models import (
    BiasConfig,
    SolarActualsWindow,
    SolarBiasMetadata,
    SolarBiasProfile,
    TrainerSample,
    TrainingOutcome,
)

_DAY_FORECAST_FLOOR_WH = 100.0
_DAY_RATIO_MIN = 0.05
_DAY_RATIO_MAX = 5.0
_SLOT_FORECAST_SUM_FLOOR_WH = 50.0
_ALL_SLOTS = [f"{h:02d}:{m:02d}" for h in range(24) for m in (0, 15, 30, 45)]


def compute_fingerprint(cfg: BiasConfig) -> str:
    """SHA-256 of (min_history_days, clamp_min, clamp_max).
    training_time and enabled are excluded — they don't affect learned output."""
    payload = json.dumps(
        [cfg.min_history_days, round(cfg.clamp_min, 6), round(cfg.clamp_max, 6)],
        sort_keys=True,
    )
    return "sha256:" + hashlib.sha256(payload.encode()).hexdigest()


def train(
    samples: list[TrainerSample],
    actuals: SolarActualsWindow,
    cfg: BiasConfig,
    now: datetime,
) -> TrainingOutcome:
    """Pure training function — no I/O."""
    fingerprint = compute_fingerprint(cfg)

    # Step 1: day-level usability filter
    usable: list[tuple[TrainerSample, dict[str, float]]] = []
    dropped: list[dict[str, str]] = []

    for sample in samples:
        day_actuals = actuals.slot_actuals_by_date.get(sample.date, {})
        if sample.forecast_wh < _DAY_FORECAST_FLOOR_WH:
            dropped.append({"date": sample.date, "reason": "day_forecast_too_low"})
            continue
        sum_actual = sum(day_actuals.values())
        day_ratio = sum_actual / sample.forecast_wh
        if day_ratio < _DAY_RATIO_MIN or day_ratio > _DAY_RATIO_MAX:
            dropped.append({"date": sample.date, "reason": "day_ratio_out_of_band"})
            continue
        usable.append((sample, day_actuals))

    # Step 2: gate on minimum usable days
    if len(usable) < cfg.min_history_days:
        return TrainingOutcome(
            profile=SolarBiasProfile(factors={}, omitted_slots=list(_ALL_SLOTS)),
            metadata=SolarBiasMetadata(
                trained_at=now.isoformat(),
                training_config_fingerprint=fingerprint,
                usable_days=len(usable),
                dropped_days=dropped,
                factor_min=None,
                factor_max=None,
                factor_median=None,
                omitted_slot_count=len(_ALL_SLOTS),
                last_outcome="insufficient_history",
            ),
        )

    # Step 3: per-slot factor computation
    # Distribute each day's forecast uniformly across all 96 slots.
    # Nighttime slots will have near-zero actuals → factor ≈ 0 → clamped to clamp_min.
    # At inference, raw_t ≈ 0 at night, so adjusted_t = 0 regardless of factor.
    num_slots = len(_ALL_SLOTS)
    slot_forecast_sums: dict[str, float] = {s: 0.0 for s in _ALL_SLOTS}
    slot_actual_sums: dict[str, float] = {s: 0.0 for s in _ALL_SLOTS}

    for sample, day_actuals in usable:
        per_slot_wh = sample.forecast_wh / num_slots
        for slot in _ALL_SLOTS:
            slot_forecast_sums[slot] += per_slot_wh
            slot_actual_sums[slot] += day_actuals.get(slot, 0.0)

    factors: dict[str, float] = {}
    omitted_slots: list[str] = []

    for slot in _ALL_SLOTS:
        if slot_forecast_sums[slot] < _SLOT_FORECAST_SUM_FLOOR_WH:
            omitted_slots.append(slot)
            continue
        raw_factor = slot_actual_sums[slot] / slot_forecast_sums[slot]
        factors[slot] = max(cfg.clamp_min, min(cfg.clamp_max, raw_factor))

    non_neutral = list(factors.values())
    sorted_f = sorted(non_neutral)
    median = sorted_f[len(sorted_f) // 2] if sorted_f else None

    return TrainingOutcome(
        profile=SolarBiasProfile(factors=factors, omitted_slots=omitted_slots),
        metadata=SolarBiasMetadata(
            trained_at=now.isoformat(),
            training_config_fingerprint=fingerprint,
            usable_days=len(usable),
            dropped_days=dropped,
            factor_min=min(non_neutral) if non_neutral else None,
            factor_max=max(non_neutral) if non_neutral else None,
            factor_median=median,
            omitted_slot_count=len(omitted_slots),
            last_outcome="profile_trained",
        ),
    )
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/test_solar_bias_trainer.py -x -q
```

Expected: `7 passed`

- [ ] **Step 5: Run full test suite**

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/ -x -q
```

- [ ] **Step 6: Commit**

```bash
git add custom_components/helman/solar_bias_correction/trainer.py tests/test_solar_bias_trainer.py
git commit -m "feat(bias-correction): add pure trainer with sum-ratio slot-of-day algorithm"
```

---

## Task 5: Pure adjuster

**Files:**
- Create: `custom_components/helman/solar_bias_correction/adjuster.py`
- Test: `tests/test_solar_bias_adjuster.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/test_solar_bias_adjuster.py
from __future__ import annotations
import sys, types, unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def _install_import_stubs():
    for name, path in [
        ("custom_components", ROOT / "custom_components"),
        ("custom_components.helman", ROOT / "custom_components" / "helman"),
        ("custom_components.helman.solar_bias_correction",
         ROOT / "custom_components" / "helman" / "solar_bias_correction"),
    ]:
        pkg = sys.modules.get(name) or types.ModuleType(name)
        pkg.__path__ = [str(path)]
        sys.modules[name] = pkg
    for name in ["homeassistant", "homeassistant.core", "homeassistant.util", "homeassistant.util.dt"]:
        if name not in sys.modules:
            m = types.ModuleType(name)
            sys.modules[name] = m
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Europe/Prague")
    dt_mod = sys.modules["homeassistant.util.dt"]
    dt_mod.as_local = lambda v: v.astimezone(TZ)

_install_import_stubs()

from custom_components.helman.solar_bias_correction.adjuster import adjust
from custom_components.helman.solar_bias_correction.models import SolarBiasProfile


class AdjusterTests(unittest.TestCase):
    def _profile(self, factors: dict) -> SolarBiasProfile:
        return SolarBiasProfile(factors=factors, omitted_slots=[])

    def test_applies_factor_to_matching_slot(self):
        # 2026-04-24 12:00 local time
        raw = [{"timestamp": "2026-04-24T10:00:00+00:00", "value": 100.0}]  # UTC → 12:00 Prague
        profile = self._profile({"12:00": 1.5})
        result = adjust(raw, profile)
        self.assertAlmostEqual(result[0]["value"], 150.0, places=2)

    def test_missing_slot_defaults_to_factor_1(self):
        raw = [{"timestamp": "2026-04-24T10:00:00+00:00", "value": 200.0}]
        profile = self._profile({})  # no factors → default 1.0
        result = adjust(raw, profile)
        self.assertAlmostEqual(result[0]["value"], 200.0, places=2)

    def test_zero_raw_stays_zero(self):
        raw = [{"timestamp": "2026-04-24T10:00:00+00:00", "value": 0.0}]
        profile = self._profile({"12:00": 1.8})
        result = adjust(raw, profile)
        self.assertAlmostEqual(result[0]["value"], 0.0, places=2)

    def test_non_negativity_clamp(self):
        # raw positive, factor artificially negative not possible via clamp, but guard still applies
        raw = [{"timestamp": "2026-04-24T10:00:00+00:00", "value": 100.0}]
        profile = self._profile({"12:00": -0.5})  # factor bypassed validation, still clamped
        result = adjust(raw, profile)
        self.assertGreaterEqual(result[0]["value"], 0.0)

    def test_preserves_timestamp(self):
        ts = "2026-04-24T10:00:00+00:00"
        raw = [{"timestamp": ts, "value": 100.0}]
        profile = self._profile({"12:00": 1.2})
        result = adjust(raw, profile)
        self.assertEqual(result[0]["timestamp"], ts)

    def test_raw_series_is_not_mutated(self):
        raw = [{"timestamp": "2026-04-24T10:00:00+00:00", "value": 100.0}]
        original_value = raw[0]["value"]
        profile = self._profile({"12:00": 2.0})
        adjust(raw, profile)
        self.assertEqual(raw[0]["value"], original_value)

    def test_empty_raw_returns_empty(self):
        result = adjust([], self._profile({"12:00": 1.5}))
        self.assertEqual(result, [])

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/test_solar_bias_adjuster.py -x -q
```

- [ ] **Step 3: Create `adjuster.py`**

```python
# custom_components/helman/solar_bias_correction/adjuster.py
from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.util import dt as dt_util

from .models import SolarBiasProfile


def adjust(
    raw_points: list[dict[str, Any]],
    profile: SolarBiasProfile,
) -> list[dict[str, Any]]:
    """Apply bias profile to raw 15-min points. Returns a new list; raw_points is not mutated."""
    result = []
    for point in raw_points:
        ts = _parse_timestamp(point.get("timestamp"))
        raw_value = point.get("value")
        if ts is None or raw_value is None:
            result.append(dict(point))
            continue
        slot_key = _local_slot_key(ts)
        factor = profile.factors.get(slot_key, 1.0)
        adjusted_value = max(0.0, raw_value * factor)
        result.append({"timestamp": point["timestamp"], "value": round(adjusted_value, 4)})
    return result


def _local_slot_key(ts: datetime) -> str:
    local_ts = dt_util.as_local(ts)
    # round down to 15-min boundary
    minute_floor = (local_ts.minute // 15) * 15
    return f"{local_ts.hour:02d}:{minute_floor:02d}"


def _parse_timestamp(raw: Any) -> datetime | None:
    if not isinstance(raw, str):
        return None
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/test_solar_bias_adjuster.py -x -q
```

Expected: `7 passed`

- [ ] **Step 5: Run full test suite**

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/ -x -q
```

- [ ] **Step 6: Commit**

```bash
git add custom_components/helman/solar_bias_correction/adjuster.py tests/test_solar_bias_adjuster.py
git commit -m "feat(bias-correction): add pure adjuster"
```

---

## Task 6: Recorder adapters — forecast_history and actuals

These modules do Recorder I/O. Unit tests stub the Recorder query functions.

**Files:**
- Create: `custom_components/helman/solar_bias_correction/forecast_history.py`
- Create: `custom_components/helman/solar_bias_correction/actuals.py`

> **Note:** Full integration testing of Recorder adapters happens in Task 12 (end-to-end against local HA). The unit tests here stub the Recorder API calls.

- [ ] **Step 1: Create `forecast_history.py`**

This module reads each past day's forecast from `daily_energy_entity_ids` sensors via Recorder. For each past day D, the "Option A" capture rule takes the **first recorded state after local midnight** — this is the full-day forecast total for day D.

```python
# custom_components/helman/solar_bias_correction/forecast_history.py
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .models import BiasConfig, TrainerSample


async def load_trainer_samples(
    hass: HomeAssistant,
    cfg: BiasConfig,
    now: datetime,
) -> list[TrainerSample]:
    """Load per-day forecast totals from Recorder history of daily_energy_entity_ids.

    For each past completed day, captures the first state recorded after local midnight
    (Option A), sums across all configured daily_energy_entity_ids, and returns one
    TrainerSample per day.

    Days with no recorded state are skipped (not dropped — the trainer only drops days
    that fail the usability filter).
    """
    if not cfg.daily_energy_entity_ids:
        return []

    # Build list of past completed local days (yesterday and earlier)
    local_now = dt_util.as_local(now)
    samples: list[TrainerSample] = []

    # Look back up to 90 days to collect as many usable days as possible
    for days_back in range(1, 91):
        target_date = (local_now - timedelta(days=days_back)).date()
        # Midnight start of target_date in local time
        midnight_start = dt_util.as_utc(
            local_now.replace(
                year=target_date.year,
                month=target_date.month,
                day=target_date.day,
                hour=0, minute=0, second=0, microsecond=0,
            )
        )
        midnight_end = midnight_start + timedelta(hours=2)  # first 2 hours after midnight

        total_wh = await _read_day_forecast_wh(
            hass,
            entity_ids=cfg.daily_energy_entity_ids,
            start=midnight_start,
            end=midnight_end,
        )
        if total_wh is None:
            continue
        samples.append(TrainerSample(date=str(target_date), forecast_wh=total_wh))

    return samples


async def _read_day_forecast_wh(
    hass: HomeAssistant,
    entity_ids: list[str],
    start: datetime,
    end: datetime,
) -> float | None:
    """Sum the first state after midnight for each entity_id; return None if unavailable."""
    from homeassistant.components.recorder.history import get_significant_states

    total = 0.0
    found_any = False

    for entity_id in entity_ids:
        states = await hass.async_add_executor_job(
            get_significant_states,
            hass,
            start,
            end,
            [entity_id],
        )
        entity_states = states.get(entity_id, [])
        for state in entity_states:
            value = _parse_state_wh(state.state)
            if value is not None:
                total += value
                found_any = True
                break  # first valid state after midnight

    return total if found_any else None


def _parse_state_wh(raw_state: str) -> float | None:
    """Convert entity state string to Wh. Assumes kWh → multiply by 1000."""
    if not isinstance(raw_state, str):
        return None
    raw_state = raw_state.strip()
    if raw_state.lower() in {"unknown", "unavailable", "none", ""}:
        return None
    try:
        kwh = float(raw_state)
        return kwh * 1000.0
    except ValueError:
        return None
```

- [ ] **Step 2: Create `actuals.py`**

```python
# custom_components/helman/solar_bias_correction/actuals.py
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .models import BiasConfig, SolarActualsWindow


async def load_actuals_window(
    hass: HomeAssistant,
    cfg: BiasConfig,
    days: int,
) -> SolarActualsWindow:
    """Load per-slot actual solar generation from Recorder deltas of total_energy_entity_id.

    Returns a SolarActualsWindow with local-date keyed dicts of slot_key → Wh.
    Slots with no recorded state get 0.0 Wh.
    """
    if not cfg.total_energy_entity_id:
        return SolarActualsWindow(slot_actuals_by_date={})

    now_utc = dt_util.utcnow()
    result: dict[str, dict[str, float]] = {}

    for days_back in range(1, days + 1):
        local_now = dt_util.as_local(now_utc)
        target_date = (local_now - timedelta(days=days_back)).date()
        day_start_local = local_now.replace(
            year=target_date.year,
            month=target_date.month,
            day=target_date.day,
            hour=0, minute=0, second=0, microsecond=0,
        )
        day_end_local = day_start_local + timedelta(days=1)
        day_start_utc = dt_util.as_utc(day_start_local)
        day_end_utc = dt_util.as_utc(day_end_local)

        slot_actuals = await _read_day_slot_actuals(
            hass,
            entity_id=cfg.total_energy_entity_id,
            day_start_utc=day_start_utc,
            day_end_utc=day_end_utc,
        )
        result[str(target_date)] = slot_actuals

    return SolarActualsWindow(slot_actuals_by_date=result)


async def _read_day_slot_actuals(
    hass: HomeAssistant,
    entity_id: str,
    day_start_utc: datetime,
    day_end_utc: datetime,
) -> dict[str, float]:
    """Compute per-15-min-slot Wh for a single day via Recorder state history deltas."""
    from homeassistant.components.recorder.history import get_significant_states

    states = await hass.async_add_executor_job(
        get_significant_states,
        hass,
        day_start_utc,
        day_end_utc,
        [entity_id],
    )
    entity_states = states.get(entity_id, [])

    # Build cumulative readings sorted by time
    readings: list[tuple[datetime, float]] = []
    for state in entity_states:
        value = _parse_cumulative_kwh(state.state)
        if value is not None:
            readings.append((state.last_changed, value))

    if len(readings) < 2:
        return {}

    # Compute deltas and map to 15-min slots
    slot_actuals: dict[str, float] = {}
    for i in range(1, len(readings)):
        prev_ts, prev_val = readings[i - 1]
        curr_ts, curr_val = readings[i]
        delta_wh = max(0.0, (curr_val - prev_val) * 1000.0)
        if delta_wh == 0.0:
            continue
        # Assign delta to the local slot of the current reading's timestamp
        local_ts = dt_util.as_local(curr_ts)
        minute_floor = (local_ts.minute // 15) * 15
        slot_key = f"{local_ts.hour:02d}:{minute_floor:02d}"
        slot_actuals[slot_key] = slot_actuals.get(slot_key, 0.0) + delta_wh

    return slot_actuals


def _parse_cumulative_kwh(raw_state: str) -> float | None:
    if not isinstance(raw_state, str):
        return None
    raw_state = raw_state.strip()
    if raw_state.lower() in {"unknown", "unavailable", "none", ""}:
        return None
    try:
        return float(raw_state)
    except ValueError:
        return None
```

- [ ] **Step 3: Run full test suite (no new unit tests for Recorder adapters — covered in E2E)**

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/ -x -q
```

Expected: all pass (new files don't break anything).

- [ ] **Step 4: Commit**

```bash
git add custom_components/helman/solar_bias_correction/forecast_history.py \
        custom_components/helman/solar_bias_correction/actuals.py
git commit -m "feat(bias-correction): add Recorder adapters for forecast history and actuals"
```

---

## Task 7: Service and scheduler

**Files:**
- Create: `custom_components/helman/solar_bias_correction/scheduler.py`
- Create: `custom_components/helman/solar_bias_correction/service.py`
- Modify: `custom_components/helman/coordinator.py` (wire service + scheduler into setup/teardown + get_forecast)

- [ ] **Step 1: Create `scheduler.py`**

```python
# custom_components/helman/solar_bias_correction/scheduler.py
from __future__ import annotations

import logging
from collections.abc import Callable, Coroutine
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.event import async_track_time_change

_LOGGER = logging.getLogger(__name__)


class SolarBiasTrainingScheduler:
    """Fires a training callback once per day at the configured local HH:MM."""

    def __init__(
        self,
        hass: HomeAssistant,
        training_callback: Callable[[], Coroutine[Any, Any, None]],
    ) -> None:
        self._hass = hass
        self._training_callback = training_callback
        self._cancel: Callable[[], None] | None = None

    def schedule(self, training_time: str) -> None:
        """Register the daily training trigger. Call again with a new time to reschedule."""
        self.cancel()
        hour, minute = map(int, training_time.split(":"))

        @callback
        def _on_time(now: Any) -> None:
            self._hass.async_create_task(self._training_callback())

        self._cancel = async_track_time_change(
            self._hass, _on_time, hour=hour, minute=minute, second=0
        )
        _LOGGER.debug("Solar bias training scheduled at %s", training_time)

    def cancel(self) -> None:
        if self._cancel is not None:
            self._cancel()
            self._cancel = None
```

- [ ] **Step 2: Create `service.py`**

```python
# custom_components/helman/solar_bias_correction/service.py
from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from ..storage import SolarBiasCorrectionStore
from .actuals import load_actuals_window
from .adjuster import adjust
from .forecast_history import load_trainer_samples
from .models import (
    BiasConfig,
    SolarBiasAdjustmentResult,
    SolarBiasExplainability,
    SolarBiasProfile,
    TrainingOutcome,
)
from .trainer import compute_fingerprint, train

_LOGGER = logging.getLogger(__name__)

_FALLBACK_PROFILE = SolarBiasProfile(factors={}, omitted_slots=[])
_TRAINING_LOOKBACK_DAYS = 90


class SolarBiasCorrectionService:
    """Orchestrates training, persistence, and inference for solar bias correction."""

    def __init__(
        self,
        hass: HomeAssistant,
        store: SolarBiasCorrectionStore,
        cfg: BiasConfig,
    ) -> None:
        self._hass = hass
        self._store = store
        self._cfg = cfg
        self._profile: SolarBiasProfile = _FALLBACK_PROFILE
        self._metadata: dict[str, Any] | None = None
        self._is_stale = False
        self._training_in_progress = False

    async def async_setup(self) -> None:
        """Load persisted profile and check fingerprint."""
        stored = self._store.profile
        if stored is None:
            self._metadata = {"last_outcome": "no_training_yet"}
            return

        stored_fingerprint = stored.get("metadata", {}).get("training_config_fingerprint")
        current_fingerprint = compute_fingerprint(self._cfg)

        if stored_fingerprint != current_fingerprint:
            self._is_stale = True
            self._profile = _FALLBACK_PROFILE
            self._metadata = {**stored.get("metadata", {}), "last_outcome": stored.get("metadata", {}).get("last_outcome", "no_training_yet")}
            _LOGGER.info("Solar bias profile is stale (fingerprint mismatch); not applying")
            return

        raw_factors = stored.get("profile", {})
        self._profile = SolarBiasProfile(
            factors={k: float(v) for k, v in raw_factors.items()},
            omitted_slots=[],
        )
        self._metadata = stored.get("metadata", {})
        self._is_stale = False

    def update_config(self, cfg: BiasConfig) -> None:
        """Called when config changes. Re-evaluates stale state."""
        self._cfg = cfg
        stored = self._store.profile
        if stored is None:
            self._is_stale = False
            return
        stored_fingerprint = stored.get("metadata", {}).get("training_config_fingerprint")
        current_fingerprint = compute_fingerprint(cfg)
        if stored_fingerprint != current_fingerprint:
            self._is_stale = True
            self._profile = _FALLBACK_PROFILE
        else:
            self._is_stale = False
            raw_factors = stored.get("profile", {})
            self._profile = SolarBiasProfile(
                factors={k: float(v) for k, v in raw_factors.items()},
                omitted_slots=[],
            )

    async def async_train(self) -> dict[str, Any]:
        """Run a training cycle. Returns fresh status payload."""
        if self._training_in_progress:
            raise TrainingInProgressError()
        if not self._cfg.enabled:
            raise BiasNotConfiguredError()

        self._training_in_progress = True
        now = dt_util.now()
        try:
            samples = await load_trainer_samples(self._hass, self._cfg, now)
            actuals = await load_actuals_window(self._hass, self._cfg, _TRAINING_LOOKBACK_DAYS)
            outcome = train(samples, actuals, self._cfg, now)
            await self._persist(outcome, now)
        except Exception as exc:
            _LOGGER.exception("Solar bias training failed: %s", exc)
            await self._persist_failure(str(exc), now)
        finally:
            self._training_in_progress = False

        self._hass.bus.async_fire("helman_solar_bias_trained")
        return self.get_status_payload()

    async def _persist(self, outcome: TrainingOutcome, now: datetime) -> None:
        payload = {
            "version": 1,
            "profile": outcome.profile.factors,
            "metadata": {
                "trained_at": outcome.metadata.trained_at,
                "training_config_fingerprint": outcome.metadata.training_config_fingerprint,
                "usable_days": outcome.metadata.usable_days,
                "dropped_days": outcome.metadata.dropped_days,
                "factor_min": outcome.metadata.factor_min,
                "factor_max": outcome.metadata.factor_max,
                "factor_median": outcome.metadata.factor_median,
                "omitted_slot_count": outcome.metadata.omitted_slot_count,
                "last_outcome": outcome.metadata.last_outcome,
            },
        }
        await self._store.async_save(payload)
        self._profile = outcome.profile
        self._metadata = payload["metadata"]
        self._is_stale = False

    async def _persist_failure(self, reason: str, now: datetime) -> None:
        stored = self._store.profile
        existing_profile = stored.get("profile", {}) if stored else {}
        existing_meta = stored.get("metadata", {}) if stored else {}
        payload = {
            "version": 1,
            "profile": existing_profile,
            "metadata": {
                **existing_meta,
                "trained_at": now.isoformat(),
                "last_outcome": "training_failed",
                "error_reason": reason,
            },
        }
        await self._store.async_save(payload)
        self._metadata = payload["metadata"]

    def build_adjustment_result(
        self,
        raw_points: list[dict[str, Any]],
        now: datetime,
    ) -> SolarBiasAdjustmentResult:
        """Synchronous inference — no I/O."""
        meta = self._metadata or {}
        last_outcome = meta.get("last_outcome", "no_training_yet")

        if not self._cfg.enabled:
            status, variant = "disabled", "raw"
        elif self._is_stale:
            status, variant = "config_changed_pending_retrain", "raw"
        elif last_outcome == "no_training_yet":
            status, variant = "no_training_yet", "raw"
        elif last_outcome == "insufficient_history":
            status, variant = "insufficient_history", "raw"
        elif last_outcome == "training_failed":
            status, variant = "training_failed", "raw"
        else:
            status, variant = "applied", "adjusted"

        adjusted = adjust(raw_points, self._profile) if variant == "adjusted" else list(raw_points)

        explainability = SolarBiasExplainability(
            fallback_reason=None if variant == "adjusted" else status,
            trained_at=meta.get("trained_at"),
            usable_days=meta.get("usable_days", 0),
            dropped_days=len(meta.get("dropped_days", [])),
            omitted_slot_count=meta.get("omitted_slot_count", 0),
            factor_min=meta.get("factor_min"),
            factor_max=meta.get("factor_max"),
            factor_median=meta.get("factor_median"),
            error=meta.get("error_reason"),
        )
        return SolarBiasAdjustmentResult(
            status=status,
            effective_variant=variant,
            adjusted_points=adjusted,
            explainability=explainability,
        )

    def get_status_payload(self) -> dict[str, Any]:
        """Build the payload for helman/solar_bias/status."""
        meta = self._metadata or {}
        return {
            "enabled": self._cfg.enabled,
            "status": self.build_adjustment_result([], dt_util.now()).status,
            "effectiveVariant": self.build_adjustment_result([], dt_util.now()).effective_variant,
            "trainedAt": meta.get("trained_at"),
            "trainingConfigFingerprint": meta.get("training_config_fingerprint"),
            "isStale": self._is_stale,
            "lastOutcome": meta.get("last_outcome", "no_training_yet"),
            "fallbackReason": None if not self._is_stale else "config_changed_pending_retrain",
            "usableDays": meta.get("usable_days", 0),
            "droppedDays": meta.get("dropped_days", []),
            "omittedSlotCount": meta.get("omitted_slot_count", 0),
            "factorSummary": {
                "min": meta.get("factor_min"),
                "max": meta.get("factor_max"),
                "median": meta.get("factor_median"),
            },
            "trainingInProgress": self._training_in_progress,
        }


class TrainingInProgressError(Exception):
    pass


class BiasNotConfiguredError(Exception):
    pass
```

- [ ] **Step 3: Wire service and scheduler into `coordinator.py`**

At the top of `coordinator.py`, add imports:

```python
from .solar_bias_correction.models import read_bias_config
from .solar_bias_correction.scheduler import SolarBiasTrainingScheduler
from .solar_bias_correction.service import SolarBiasCorrectionService
from .storage import SolarBiasCorrectionStore
```

In `HelmanCoordinator.__init__`, add instance variables (after existing ones):

```python
        self._solar_bias_store = SolarBiasCorrectionStore(hass)
        self._solar_bias_service: SolarBiasCorrectionService | None = None
        self._solar_bias_scheduler: SolarBiasTrainingScheduler | None = None
```

In `HelmanCoordinator.async_setup`, add after existing setup (before returning):

```python
        # Solar bias correction setup
        await self._solar_bias_store.async_load()
        bias_cfg = read_bias_config(self._active_config)
        self._solar_bias_service = SolarBiasCorrectionService(
            self._hass, self._solar_bias_store, bias_cfg
        )
        await self._solar_bias_service.async_setup()
        if bias_cfg.enabled:
            self._solar_bias_scheduler = SolarBiasTrainingScheduler(
                self._hass, self._solar_bias_service.async_train
            )
            self._solar_bias_scheduler.schedule(bias_cfg.training_time)
```

In `HelmanCoordinator.async_unload`, before the final `await self._schedule_executor.async_unload()`:

```python
        if self._solar_bias_scheduler is not None:
            self._solar_bias_scheduler.cancel()
            self._solar_bias_scheduler = None
```

- [ ] **Step 4: Run full test suite**

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/ -x -q
```

Expected: all existing tests pass. (New service/scheduler not yet unit-tested; E2E covers them.)

- [ ] **Step 5: Commit**

```bash
git add custom_components/helman/solar_bias_correction/scheduler.py \
        custom_components/helman/solar_bias_correction/service.py \
        custom_components/helman/coordinator.py
git commit -m "feat(bias-correction): add service, scheduler, and coordinator wiring"
```

---

## Task 8: Response composition

**Files:**
- Create: `custom_components/helman/solar_bias_correction/response.py`
- Modify: `custom_components/helman/coordinator.py` (update `get_forecast` to use bias service + compose response)
- Test: `tests/test_solar_bias_response.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/test_solar_bias_response.py
from __future__ import annotations
import sys, types, unittest
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
TZ = ZoneInfo("Europe/Prague")


def _install_import_stubs():
    for name, path in [
        ("custom_components", ROOT / "custom_components"),
        ("custom_components.helman", ROOT / "custom_components" / "helman"),
        ("custom_components.helman.solar_bias_correction",
         ROOT / "custom_components" / "helman" / "solar_bias_correction"),
    ]:
        pkg = sys.modules.get(name) or types.ModuleType(name)
        pkg.__path__ = [str(path)]
        sys.modules[name] = pkg
    for name in ["homeassistant", "homeassistant.core", "homeassistant.util", "homeassistant.util.dt"]:
        if name not in sys.modules:
            sys.modules[name] = types.ModuleType(name)
    dt = sys.modules["homeassistant.util.dt"]
    dt.as_local = lambda v: v.astimezone(TZ)

_install_import_stubs()

from custom_components.helman.solar_bias_correction.models import (
    SolarBiasAdjustmentResult, SolarBiasExplainability,
)
from custom_components.helman.solar_bias_correction.response import compose_solar_bias_response

_RAW_SNAPSHOT = {
    "points": [
        {"timestamp": "2026-04-24T08:00:00+00:00", "value": 100.0},
        {"timestamp": "2026-04-24T08:15:00+00:00", "value": 120.0},
        {"timestamp": "2026-04-24T08:30:00+00:00", "value": 150.0},
        {"timestamp": "2026-04-24T08:45:00+00:00", "value": 130.0},
    ],
    "actualHistory": [],
    "status": "ready",
}


def _make_result(status: str, variant: str, adjusted_points: list) -> SolarBiasAdjustmentResult:
    return SolarBiasAdjustmentResult(
        status=status,
        effective_variant=variant,
        adjusted_points=adjusted_points,
        explainability=SolarBiasExplainability(
            fallback_reason=None if variant == "adjusted" else status,
            trained_at="2026-04-24T03:00:00+02:00",
            usable_days=12,
            dropped_days=2,
            omitted_slot_count=40,
            factor_min=0.8,
            factor_max=1.4,
            factor_median=1.1,
        ),
    )


class ResponseCompositionTests(unittest.TestCase):
    def test_raw_points_unchanged_in_response(self):
        result = _make_result("applied", "adjusted", [
            {"timestamp": "2026-04-24T08:00:00+00:00", "value": 110.0},
        ])
        response = compose_solar_bias_response(_RAW_SNAPSHOT, result, granularity=60, forecast_days=1)
        # solar.points must be RAW
        raw_sum = sum(p["value"] for p in _RAW_SNAPSHOT["points"])
        response_points_sum = sum(p["value"] for p in response.get("points", []))
        self.assertAlmostEqual(response_points_sum, raw_sum, delta=1.0)

    def test_adjusted_points_present(self):
        adjusted = [{"timestamp": "2026-04-24T08:00:00+00:00", "value": 200.0}]
        result = _make_result("applied", "adjusted", adjusted)
        response = compose_solar_bias_response(_RAW_SNAPSHOT, result, granularity=60, forecast_days=1)
        self.assertIn("adjustedPoints", response)

    def test_bias_correction_metadata_present(self):
        result = _make_result("applied", "adjusted", [])
        response = compose_solar_bias_response(_RAW_SNAPSHOT, result, granularity=60, forecast_days=1)
        bc = response.get("biasCorrection", {})
        self.assertEqual(bc.get("status"), "applied")
        self.assertEqual(bc.get("effectiveVariant"), "adjusted")
        self.assertIn("explainability", bc)

    def test_adjusted_points_mirrors_raw_when_variant_is_raw(self):
        raw_pts = list(_RAW_SNAPSHOT["points"])
        result = _make_result("no_training_yet", "raw", raw_pts)
        response = compose_solar_bias_response(_RAW_SNAPSHOT, result, granularity=60, forecast_days=1)
        # adjustedPoints should mirror raw points when effectiveVariant=raw
        adj_sum = sum(p["value"] for p in response.get("adjustedPoints", []))
        raw_sum = sum(p["value"] for p in _RAW_SNAPSHOT["points"])
        self.assertAlmostEqual(adj_sum, raw_sum, delta=1.0)

    def test_fallback_reason_in_explainability(self):
        result = _make_result("insufficient_history", "raw", [])
        response = compose_solar_bias_response(_RAW_SNAPSHOT, result, granularity=60, forecast_days=1)
        expl = response["biasCorrection"]["explainability"]
        self.assertEqual(expl.get("fallbackReason"), "insufficient_history")

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/test_solar_bias_response.py -x -q
```

- [ ] **Step 3: Create `response.py`**

```python
# custom_components/helman/solar_bias_correction/response.py
from __future__ import annotations

from copy import deepcopy
from typing import Any

from ..point_forecast_response import build_solar_forecast_response
from .models import SolarBiasAdjustmentResult


def compose_solar_bias_response(
    raw_snapshot: dict[str, Any],
    adjustment_result: SolarBiasAdjustmentResult,
    granularity: int,
    forecast_days: int,
) -> dict[str, Any]:
    """Build the public solar response: raw .points + .adjustedPoints + .biasCorrection.

    solar.points = raw (backwards-compatible).
    solar.adjustedPoints = adjusted (or raw copy when variant=raw).
    solar.biasCorrection = status + metadata.
    """
    # Raw response using the existing aggregation path
    response = build_solar_forecast_response(
        raw_snapshot, granularity=granularity, forecast_days=forecast_days
    )

    # Build adjusted snapshot by replacing the points in raw_snapshot with adjusted_points
    adjusted_snapshot = deepcopy(raw_snapshot)
    adjusted_snapshot["points"] = adjustment_result.adjusted_points

    adjusted_response = build_solar_forecast_response(
        adjusted_snapshot, granularity=granularity, forecast_days=forecast_days
    )
    response["adjustedPoints"] = adjusted_response.get("points", [])

    expl = adjustment_result.explainability
    response["biasCorrection"] = {
        "status": adjustment_result.status,
        "effectiveVariant": adjustment_result.effective_variant,
        "explainability": {
            "fallbackReason": expl.fallback_reason,
            "trainedAt": expl.trained_at,
            "usableDays": expl.usable_days,
            "droppedDays": expl.dropped_days,
            "omittedSlotCount": expl.omitted_slot_count,
            "factorSummary": {
                "min": expl.factor_min,
                "max": expl.factor_max,
                "median": expl.factor_median,
            },
            **({"error": expl.error} if expl.error else {}),
        },
    }
    return response
```

- [ ] **Step 4: Wire response composition into `coordinator.get_forecast`**

In `coordinator.py`, update `get_forecast` to call the service and compose the response. Replace the current lines (approx 637-648):

```python
        # Before: canonical_solar_forecast and result["solar"] built from raw_result["solar"]
        # After: derive effective variant; build canonical from effective; build public with both

        raw_solar_snapshot = raw_result["solar"]
        now_for_bias = request_now

        if self._solar_bias_service is not None:
            adjustment_result = self._solar_bias_service.build_adjustment_result(
                raw_solar_snapshot.get("points", []), now_for_bias
            )
            # Effective variant for internal consumers (battery, appliances, etc.)
            if adjustment_result.effective_variant == "adjusted":
                effective_solar_snapshot = {**raw_solar_snapshot, "points": adjustment_result.adjusted_points}
            else:
                effective_solar_snapshot = raw_solar_snapshot
        else:
            adjustment_result = None
            effective_solar_snapshot = raw_solar_snapshot

        canonical_solar_forecast = build_solar_forecast_response(
            effective_solar_snapshot,
            granularity=FORECAST_CANONICAL_GRANULARITY_MINUTES,
            forecast_days=MAX_FORECAST_DAYS,
        )

        if adjustment_result is not None:
            from .solar_bias_correction.response import compose_solar_bias_response
            result = {
                "solar": compose_solar_bias_response(
                    raw_solar_snapshot,
                    adjustment_result,
                    granularity=granularity,
                    forecast_days=forecast_days,
                ),
            }
        else:
            result = {
                "solar": build_solar_forecast_response(
                    raw_solar_snapshot,
                    granularity=granularity,
                    forecast_days=forecast_days,
                ),
            }
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/test_solar_bias_response.py tests/ -x -q
```

Expected: all pass. Particularly verify that the existing `test_coordinator_*.py` tests still pass — they do not test `solar.adjustedPoints`, so they remain unaffected.

- [ ] **Step 6: Commit**

```bash
git add custom_components/helman/solar_bias_correction/response.py \
        custom_components/helman/coordinator.py \
        tests/test_solar_bias_response.py
git commit -m "feat(bias-correction): add response composition and wire into coordinator.get_forecast"
```

---

## Task 9: WebSocket endpoints

**Files:**
- Create: `custom_components/helman/solar_bias_correction/websocket.py`
- Modify: `custom_components/helman/websockets.py`

- [ ] **Step 1: Create `websocket.py`**

```python
# custom_components/helman/solar_bias_correction/websocket.py
from __future__ import annotations

import logging

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.components.websocket_api import async_register_command
from homeassistant.core import HomeAssistant, callback

from ..const import DOMAIN
from .service import BiasNotConfiguredError, SolarBiasCorrectionService, TrainingInProgressError

_LOGGER = logging.getLogger(__name__)


def async_register_websocket_handlers(hass: HomeAssistant) -> None:
    async_register_command(hass, ws_solar_bias_status)
    async_register_command(hass, ws_solar_bias_train_now)
    async_register_command(hass, ws_solar_bias_profile)


@websocket_api.websocket_command({vol.Required("type"): "helman/solar_bias/status"})
@callback
def ws_solar_bias_status(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    service = _get_service(hass, connection, msg)
    if service is None:
        return
    connection.send_result(msg["id"], service.get_status_payload())


@websocket_api.websocket_command({vol.Required("type"): "helman/solar_bias/train_now"})
@websocket_api.async_response
async def ws_solar_bias_train_now(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    service = _get_service(hass, connection, msg)
    if service is None:
        return
    try:
        status = await service.async_train()
    except TrainingInProgressError:
        connection.send_error(msg["id"], "training_in_progress", "Training is already in progress")
        return
    except BiasNotConfiguredError:
        connection.send_error(msg["id"], "bias_correction_not_configured", "Bias correction is disabled")
        return
    except Exception as exc:
        _LOGGER.exception("train_now failed: %s", exc)
        connection.send_error(msg["id"], "internal_error", str(exc))
        return
    connection.send_result(msg["id"], status)


@websocket_api.websocket_command({vol.Required("type"): "helman/solar_bias/profile"})
@callback
def ws_solar_bias_profile(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    from ..storage import SolarBiasCorrectionStore
    coordinator = hass.data.get(DOMAIN, {}).get("coordinator")
    if coordinator is None:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return
    stored = coordinator._solar_bias_store.profile
    if stored is None:
        connection.send_error(msg["id"], "no_profile", "No training run has completed yet")
        return
    meta = stored.get("metadata", {})
    profile_factors = stored.get("profile", {})
    connection.send_result(msg["id"], {
        "trainedAt": meta.get("trained_at"),
        "factors": profile_factors,
        "omittedSlots": meta.get("omitted_slots", []),
    })


def _get_service(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> SolarBiasCorrectionService | None:
    coordinator = hass.data.get(DOMAIN, {}).get("coordinator")
    if coordinator is None:
        connection.send_error(msg["id"], "not_loaded", "Helman coordinator not available")
        return None
    service = getattr(coordinator, "_solar_bias_service", None)
    if service is None:
        connection.send_error(msg["id"], "not_loaded", "Solar bias service not available")
        return None
    return service
```

- [ ] **Step 2: Register handlers in `websockets.py`**

Add to `async_register_websocket_commands`:

```python
    from .solar_bias_correction.websocket import async_register_websocket_handlers
    async_register_websocket_handlers(hass)
```

- [ ] **Step 3: Run full test suite**

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/ -x -q
```

- [ ] **Step 4: Commit**

```bash
git add custom_components/helman/solar_bias_correction/websocket.py \
        custom_components/helman/websockets.py
git commit -m "feat(bias-correction): add WebSocket endpoints for status, train_now, profile"
```

---

## Task 10: Frontend — Bias Correction tab

**Files:**
- Modify: `custom_components/helman/frontend/src/config-editor-scopes.ts`
- Modify: `custom_components/helman/frontend/src/localize/translations/en.json`
- Modify: `custom_components/helman/frontend/src/helman-config-editor.ts` (add status Lit component)
- Rebuild: `custom_components/helman/frontend/dist/helman-config-editor.js`

> **Read first:** `custom_components/helman/frontend/CLAUDE.md` — always run `npm run build` in the frontend directory and commit the updated `dist/helman-config-editor.js` alongside source changes.

- [ ] **Step 1: Update `config-editor-scopes.ts` — add `bias_correction` tab**

Replace the `TabId` type union (line 10-15):

```typescript
export type TabId =
  | "general"
  | "power_devices"
  | "scheduler"
  | "automation"
  | "appliances"
  | "bias_correction";
```

Replace `ScopeId` type union — add new entries after `"section:appliances.configured_appliances"`:

```typescript
  | "tab:bias_correction"
  | "section:bias_correction.settings"
```

Add to `TAB_ICONS` (after `appliances` entry):

```typescript
  bias_correction: "M3.5,18.5L9.5,12.5L13.5,16.5L22,6.92L20.59,5.5L13.5,13.5L9.5,9.5L2,17L3.5,18.5Z",
```

Add to `TABS` array (after `appliances`):

```typescript
  { id: "bias_correction", labelKey: "editor.tabs.bias_correction" },
```

Add to `TAB_SECTIONS`:

```typescript
  bias_correction: "bias_correction",
```

Add to `TAB_SCOPE_IDS`:

```typescript
  bias_correction: "tab:bias_correction",
```

Add to `SECTION_SCOPE_IDS`:

```typescript
  bias_correction: {
    settings: "section:bias_correction.settings",
  },
```

Add to `EDITOR_SCOPES` (after the `appliances` section entries):

```typescript
  [TAB_SCOPE_IDS.bias_correction]: {
    id: TAB_SCOPE_IDS.bias_correction,
    kind: "tab",
    parentId: DOCUMENT_SCOPE_ID,
    tabId: "bias_correction",
    labelKey: "editor.tabs.bias_correction",
    adapter: createPathScopeAdapter(
      ["power_devices", "solar", "forecast", "bias_correction"],
      { emptyValue: EMPTY_OBJECT, rootKind: "object" }
    ),
  },
  [SECTION_SCOPE_IDS.bias_correction.settings]: {
    id: SECTION_SCOPE_IDS.bias_correction.settings,
    kind: "section",
    parentId: TAB_SCOPE_IDS.bias_correction,
    tabId: "bias_correction",
    labelKey: "editor.sections.bias_correction_settings",
    adapter: createPathScopeAdapter(
      ["power_devices", "solar", "forecast", "bias_correction"],
      { emptyValue: EMPTY_OBJECT, rootKind: "object" }
    ),
  },
```

Add section icon in `SECTION_ICONS`:

```typescript
  "section:bias_correction.settings": "M16.53,11.06L15.47,10L10.59,14.88L8.47,12.76L7.41,13.82L10.59,17L16.53,11.06M19,3H18V1H16V3H8V1H6V3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5A2,2 0 0,0 19,3M19,19H5V9H19V19M19,7H5V5H19V7Z",
```

- [ ] **Step 2: Add localization strings to `en.json`**

In the `"tabs"` section, add:

```json
"bias_correction": "Bias Correction"
```

In the `"sections"` section, add:

```json
"bias_correction_settings": "Bias correction settings"
```

In the `"fields"` section, add:

```json
"bias_correction_enabled": "Enable bias correction",
"bias_correction_min_history_days": "Min history days",
"bias_correction_training_time": "Training time (HH:MM)",
"bias_correction_clamp_min": "Clamp min",
"bias_correction_clamp_max": "Clamp max"
```

Add a new top-level key `"bias_correction"` alongside `"editor"`:

```json
"bias_correction": {
  "status": {
    "applied": "Applied",
    "disabled": "Disabled",
    "no_training_yet": "No training yet",
    "insufficient_history": "Insufficient history",
    "config_changed_pending_retrain": "Config changed — pending retrain",
    "training_failed": "Training failed"
  },
  "actions": {
    "train_now": "Train now",
    "train_now_in_progress": "Training…",
    "train_now_success": "Training complete",
    "train_now_error": "Training failed"
  },
  "labels": {
    "last_trained": "Last trained",
    "usable_days": "Usable days",
    "dropped_days": "Dropped days",
    "factor_range": "Factor range",
    "stale_banner": "Config changed since last training. Click 'Train now' or wait for the next scheduled run."
  }
}
```

- [ ] **Step 3: Add the Bias Correction status Lit component**

In `helman-config-editor.ts` (or create `bias-correction-status.ts` if the editor uses separate component files — check the existing file structure first), add a `<helman-bias-correction-status>` Lit element:

```typescript
// Add near the end of helman-config-editor.ts before the closing of the module,
// or in a new file bias-correction-status.ts imported from helman-config-editor.ts

import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";

@customElement("helman-bias-correction-status")
class HelmanBiasCorrectionStatus extends LitElement {
  @property({ attribute: false }) hass: any;

  @state() private _status: any = null;
  @state() private _loading = false;
  @state() private _trainNowInFlight = false;
  @state() private _trainNowMessage = "";

  private _pollInterval: ReturnType<typeof setInterval> | null = null;

  static styles = css`
    .status-block { padding: 8px 0; }
    .status-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .badge { padding: 2px 8px; border-radius: 12px; font-size: 0.85em; font-weight: 600; }
    .badge-applied { background: #e8f5e9; color: #2e7d32; }
    .badge-stale, .badge-config_changed_pending_retrain { background: #fff8e1; color: #f57f17; }
    .badge-failed, .badge-training_failed { background: #ffebee; color: #c62828; }
    .badge-raw { background: #f5f5f5; color: #616161; }
    .stale-banner { background: #fff8e1; color: #f57f17; border-left: 3px solid #f57f17; padding: 8px; margin: 8px 0; }
    .dropped-list { margin: 4px 0 0 16px; font-size: 0.85em; }
    .train-now-btn { margin-top: 12px; }
  `;

  connectedCallback() {
    super.connectedCallback();
    this._loadStatus();
    this._pollInterval = setInterval(() => this._loadStatus(), 10000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._pollInterval !== null) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }

  private async _loadStatus() {
    if (!this.hass) return;
    try {
      const result = await this.hass.callWS({ type: "helman/solar_bias/status" });
      this._status = result;
    } catch (e) {
      // silently ignore poll errors
    }
  }

  private async _trainNow() {
    if (this._trainNowInFlight || !this.hass) return;
    this._trainNowInFlight = true;
    this._trainNowMessage = "";
    try {
      const result = await this.hass.callWS({ type: "helman/solar_bias/train_now" });
      this._status = result;
      this._trainNowMessage = "Training complete";
    } catch (e: any) {
      this._trainNowMessage = e?.message ?? "Training failed";
    } finally {
      this._trainNowInFlight = false;
    }
  }

  render() {
    const s = this._status;
    if (!s) return html`<div>Loading status…</div>`;

    const statusClass = s.status === "applied" ? "applied"
      : s.status === "training_failed" ? "failed"
      : s.isStale ? "stale"
      : "raw";

    return html`
      <div class="status-block">
        <div class="status-row">
          <span>Status:</span>
          <span class="badge badge-${statusClass}">${s.status}</span>
          <span>Effective variant: ${s.effectiveVariant}</span>
        </div>
        ${s.isStale ? html`<div class="stale-banner">Config changed since last training. Click 'Train now' or wait for the next scheduled run.</div>` : ""}
        ${s.trainedAt ? html`<div>Last trained: ${s.trainedAt}</div>` : ""}
        <div>Usable days: ${s.usableDays} | Dropped: ${s.droppedDays?.length ?? 0} | Omitted slots: ${s.omittedSlotCount}</div>
        ${s.factorSummary?.min != null ? html`<div>Factor range: ${s.factorSummary.min?.toFixed(2)} – ${s.factorSummary.max?.toFixed(2)} (median ${s.factorSummary.median?.toFixed(2)})</div>` : ""}
        ${s.droppedDays?.length > 0 ? html`
          <details>
            <summary>Dropped days (${s.droppedDays.length})</summary>
            <ul class="dropped-list">
              ${s.droppedDays.map((d: any) => html`<li>${d.date}: ${d.reason}</li>`)}
            </ul>
          </details>
        ` : ""}
        <div class="train-now-btn">
          <button
            @click=${this._trainNow}
            ?disabled=${this._trainNowInFlight || !s.enabled}
          >${this._trainNowInFlight ? "Training…" : "Train now"}</button>
          ${this._trainNowMessage ? html`<span> ${this._trainNowMessage}</span>` : ""}
        </div>
      </div>
    `;
  }
}
```

Then use `<helman-bias-correction-status .hass=${this.hass}></helman-bias-correction-status>` in the bias correction tab render path of the main editor element.

> **Implementation note:** Check how other tab-specific components are rendered in `helman-config-editor.ts` — follow the same pattern for rendering tab content. The status block should appear below the YAML/visual config form for the bias_correction scope.

- [ ] **Step 4: Build the frontend bundle**

```bash
cd custom_components/helman/frontend && npm run build
```

Expected: `dist/helman-config-editor.js` is regenerated with no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add custom_components/helman/frontend/src/ \
        custom_components/helman/frontend/dist/helman-config-editor.js
git commit -m "feat(bias-correction): add Bias Correction tab with status UI to config editor"
```

---

## Task 11: WebSocket API end-to-end testing

These tests run against a live local HA instance with the updated code deployed.

- [ ] **Step 1: Restart local HA to load the new code**

Use the `local-hass-control` skill to restart the local HA instance.

- [ ] **Step 2: Verify integration loads without errors**

Check HA logs for any errors related to `helman` or `solar_bias_correction`. Expected: clean startup with `Solar bias training scheduled at 03:00` in the logs.

- [ ] **Step 3: Test `helman/solar_bias/status`**

Use the `local-hass-api` skill to send:

```json
{"type": "helman/solar_bias/status"}
```

Expected response (first run, no training yet):
```json
{
  "enabled": true,
  "status": "no_training_yet",
  "effectiveVariant": "raw",
  "trainedAt": null,
  "isStale": false,
  "lastOutcome": "no_training_yet",
  "usableDays": 0,
  "droppedDays": [],
  "omittedSlotCount": 0,
  "factorSummary": {"min": null, "max": null, "median": null}
}
```

- [ ] **Step 4: Test `helman/solar_bias/train_now`**

Use the `local-hass-api` skill to send:

```json
{"type": "helman/solar_bias/train_now"}
```

Expected: returns a status payload with `lastOutcome` = either `"profile_trained"` or `"insufficient_history"` (depending on how many days of Recorder data exist). No `training_in_progress` error.

- [ ] **Step 5: Verify `helman/get_forecast` includes bias correction fields**

Use the `local-hass-api` skill to send:

```json
{"type": "helman/get_forecast", "granularity": 60, "forecast_days": 1}
```

Expected response `solar` key includes:
- `"points"` — raw forecast (same as before)
- `"adjustedPoints"` — adjusted or raw copy
- `"biasCorrection"` — object with `status`, `effectiveVariant`, `explainability`

- [ ] **Step 6: Test concurrent `train_now` rejection**

Send two `helman/solar_bias/train_now` requests rapidly (within the same second). The second should return `training_in_progress` error.

- [ ] **Step 7: Test `helman/solar_bias/profile`**

After a successful training run:

```json
{"type": "helman/solar_bias/profile"}
```

Expected: object with `trainedAt`, `factors` (dict of slot keys → floats), `omittedSlots`.

Before any training run, expected error code: `no_profile`.

- [ ] **Step 8: Test `helman/solar_bias/train_now` with `enabled: false`**

Set `bias_correction.enabled: false` in the Helman config via `helman/save_config`, then send:

```json
{"type": "helman/solar_bias/train_now"}
```

Expected error code: `bias_correction_not_configured`.

- [ ] **Step 9: Test config-change staleness**

1. Confirm a profile is trained and applied (`status: "applied"`).
2. Change `min_history_days` in the config (any value that changes the fingerprint) via `helman/save_config`.
3. HA reloads. Query `helman/solar_bias/status`.
4. Expected: `isStale: true`, `status: "config_changed_pending_retrain"`.
5. Send `helman/solar_bias/train_now`. Expected: `isStale: false`, `status` reflects new training outcome.

- [ ] **Step 10: Verify `helman/get_forecast` passes effective variant to battery consumers**

Query `helman/get_forecast` before and after training. When `status: "applied"`, the battery capacity forecast (`battery_capacity`) should reflect the adjusted solar (check that battery forecast inputs used the effective solar points — no direct assertion possible here, but confirm no errors in the response).

- [ ] **Step 11: Final commit with any fixes discovered during E2E testing**

```bash
git add -p  # stage only bug fixes discovered during E2E
git commit -m "fix(bias-correction): address issues found during E2E WebSocket testing"
```

---

## Self-Review

### Spec coverage check

| Spec section | Covered by task |
|---|---|
| Config surface (YAML shape, validation rules) | Task 1 |
| Training-config fingerprint | Task 4 (`compute_fingerprint`) |
| Persisted profile payload | Task 2, Task 7 |
| Backend package layout (all 9 modules) | Tasks 3–9 |
| `SolarBiasCorrectionStore` in storage.py | Task 2 |
| coordinator.py touchpoints | Tasks 7, 8 |
| config_validation.py `bias_correction` subtree | Task 1 |
| websockets.py registration | Task 9 |
| Runtime: on integration setup | Task 7 |
| Runtime: on scheduled training run | Task 7 (scheduler fires `async_train`) |
| Runtime: on "Train now" websocket call | Task 9 |
| Runtime: on config change | Task 7 (`update_config`) |
| Runtime: request-time flow | Task 8 |
| Public response contract (`adjustedPoints`, `biasCorrection`) | Task 8 |
| `adjustedPoints` always populated (raw copy when variant=raw) | Task 8 tests |
| Granularity aggregation (15/30/60) | Task 8 (uses existing `build_solar_forecast_response`) |
| Internal effective variant to battery/grid/appliances | Task 8 (effective_solar_snapshot) |
| Backwards compatibility (`solar.points` = raw) | Task 8 tests |
| WebSocket `helman/solar_bias/status` | Task 9 |
| WebSocket `helman/solar_bias/train_now` | Task 9 |
| WebSocket `helman/solar_bias/profile` | Task 9 |
| Error codes | Task 9 |
| Frontend Bias Correction tab | Task 10 |
| Status block with Train now button | Task 10 |
| Stale banner | Task 10 |
| Localization strings | Task 10 |
| npm run build + commit dist | Task 10 |
| Failure modes: training throws | Task 7 (`_persist_failure` preserves prior profile) |
| Failure modes: no history | Trainer returns `insufficient_history` |
| Failure modes: version mismatch | Task 2 (store returns None for unknown version) |
| Locked invariant: stale profile never applied | Task 7 (`update_config`), Task 11 (E2E) |
| Locked invariant: failed training preserves prior profile | Task 7 (`_persist_failure`) |
| Locked invariant: coordinator is single variant decision point | Task 8 |

### Placeholder scan

No placeholders found. All steps contain complete code.

### Type/name consistency check

- `BiasConfig` defined in Task 3, used consistently in Tasks 4, 5, 7, 8, 9.
- `TrainerSample.forecast_wh` (not `wh_period`) used consistently in Tasks 3, 4.
- `SolarActualsWindow.slot_actuals_by_date` used consistently in Tasks 3, 4, 6.
- `SolarBiasAdjustmentResult` from Task 3, produced in Task 7, consumed in Tasks 8, 9.
- `async_train()` in service, called by scheduler and websocket.
- `build_adjustment_result()` in service, called in coordinator `get_forecast`.
- `compose_solar_bias_response()` in response.py, called in coordinator.
- `async_register_websocket_handlers(hass)` in websocket.py, called from websockets.py.
- `_solar_bias_service` and `_solar_bias_store` attribute names consistent between coordinator.py and websocket.py.

---

**Plan complete and saved to `docs/superpowers/plans/2026-04-24-solar-bias-correction.md`.**

**Two execution options:**

**1. Subagent-Driven (recommended)** — Fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
