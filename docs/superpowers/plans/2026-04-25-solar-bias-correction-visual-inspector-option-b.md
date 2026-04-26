# Solar Bias Correction Visual Inspector Option B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a collapsed read-only solar bias correction visual inspector that shows one local day at a time in a single SVG chart with raw forecast, corrected forecast, actual production, and correction factor intensity as shaded background bands.

**Architecture:** The backend adds a dedicated inspector response model and websocket endpoint under the existing `solar_bias_correction` package, reusing the current in-memory profile and runtime status without retraining. The frontend adds a child Lit element owned by `helman-bias-correction-status`; it fetches one day over websocket, owns date navigation, and renders Option B as a compact single-chart SVG.

**Tech Stack:** Python 3.12, Home Assistant websocket API, existing Recorder helpers, pytest/unittest, TypeScript, Lit 3, Vite.

**Spec:** `docs/features/forecast/solar-forecast-bias-correction/solar-bias-correction-visual-inspector-proposal.md`, specifically Option B: Single chart with correction factor as shaded background.

**Primary test commands:**
- `/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/test_solar_bias_inspector.py tests/test_solar_bias_websocket.py -q`
- `npm --prefix custom_components/helman/frontend run build`

---

## File Structure

### Backend files

| File | Responsibility |
|---|---|
| `custom_components/helman/solar_bias_correction/models.py` | Add inspector dataclasses: `SolarBiasInspectorPoint`, `SolarBiasFactorPoint`, `SolarBiasInspectorSeries`, `SolarBiasInspectorTotals`, `SolarBiasInspectorAvailability`, `SolarBiasInspectorDay`. |
| `custom_components/helman/solar_bias_correction/forecast_history.py` | Add `load_forecast_points_for_day(hass, cfg, target_date, local_now)` to read raw forecast slot points for one local day from configured daily energy entities. |
| `custom_components/helman/solar_bias_correction/actuals.py` | Add `load_actuals_for_day(hass, cfg, target_date, local_now)` to read per-slot actual production for one local day. |
| `custom_components/helman/solar_bias_correction/service.py` | Add `async_get_inspector_day(date)` orchestration and payload serialization. |
| `custom_components/helman/solar_bias_correction/websocket.py` | Add async websocket command `helman/solar_bias/inspector` with ISO date validation and read-only admin access. |

### Frontend files

| File | Responsibility |
|---|---|
| `custom_components/helman/frontend/src/bias-correction-inspector.ts` | New custom element for collapsed panel, day navigation, websocket loading, totals, empty states, and Option B SVG chart. |
| `custom_components/helman/frontend/src/bias-correction-status.ts` | Import/register the inspector and render it below the existing status/training UI. |
| `custom_components/helman/frontend/src/localize/translations/en.json` | Add inspector strings. |
| `custom_components/helman/frontend/src/localize/translations/cs.json` | Add matching keys with English fallback text if no Czech translation is available. |
| `custom_components/helman/frontend/dist/helman-config-editor.js` | Rebuilt by Vite. Do not edit by hand. |

### Tests

| File | What it tests |
|---|---|
| `tests/test_solar_bias_inspector.py` | Service-level inspector payload, fallback behavior, totals, factors, date range, and missing-data states. |
| `tests/test_solar_bias_websocket.py` | New websocket command authorization, schema, date validation, service call, and error path. |

---

## Data Contract

The websocket request is:

```json
{
  "type": "helman/solar_bias/inspector",
  "date": "2026-04-25"
}
```

The response shape is:

```json
{
  "date": "2026-04-25",
  "timezone": "Europe/Prague",
  "status": "applied",
  "effectiveVariant": "adjusted",
  "trainedAt": "2026-04-25T03:00:04+02:00",
  "range": {
    "minDate": "2026-04-18",
    "maxDate": "2026-04-27",
    "canGoPrevious": true,
    "canGoNext": true,
    "isToday": true,
    "isFuture": false
  },
  "series": {
    "raw": [
      {"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 420.0}
    ],
    "corrected": [
      {"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 510.0}
    ],
    "actual": [
      {"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 480.0}
    ],
    "factors": [
      {"slot": "08:00", "factor": 1.21}
    ]
  },
  "totals": {
    "rawWh": 18400.0,
    "correctedWh": 15900.0,
    "actualWh": 16300.0
  },
  "availability": {
    "hasRawForecast": true,
    "hasCorrectedForecast": true,
    "hasActuals": true,
    "hasProfile": true
  }
}
```

Backend values use `valueWh`; frontend converts to kWh for display.

---

## Task 1: Inspector Models And Serialization

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/models.py`
- Test: `tests/test_solar_bias_inspector.py`

- [ ] **Step 1: Write failing model serialization test**

Append this to a new file:

```python
# tests/test_solar_bias_inspector.py
from __future__ import annotations

import asyncio
import importlib
import sys
import types
from datetime import date, datetime
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]


def _install_import_stubs() -> None:
    for name, path in [
        ("custom_components", ROOT / "custom_components"),
        ("custom_components.helman", ROOT / "custom_components" / "helman"),
        (
            "custom_components.helman.solar_bias_correction",
            ROOT / "custom_components" / "helman" / "solar_bias_correction",
        ),
    ]:
        pkg = sys.modules.get(name) or types.ModuleType(name)
        pkg.__path__ = [str(path)]
        sys.modules[name] = pkg

    core_mod = types.ModuleType("homeassistant.core")
    core_mod.HomeAssistant = type("HomeAssistant", (), {})
    core_mod.callback = lambda func: func
    sys.modules["homeassistant.core"] = core_mod

    util_mod = types.ModuleType("homeassistant.util")
    sys.modules["homeassistant.util"] = util_mod
    dt_mod = types.ModuleType("homeassistant.util.dt")
    dt_mod.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
    dt_mod.as_local = lambda value: value
    dt_mod.as_utc = lambda value: value
    sys.modules["homeassistant.util.dt"] = dt_mod
    util_mod.dt = dt_mod


_install_import_stubs()

models = importlib.import_module("custom_components.helman.solar_bias_correction.models")


def test_inspector_day_serializes_frontend_contract():
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
                raw=[
                    models.SolarBiasInspectorPoint(
                        timestamp="2026-04-25T08:00:00+02:00",
                        value_wh=420.0,
                    )
                ],
                corrected=[
                    models.SolarBiasInspectorPoint(
                        timestamp="2026-04-25T08:00:00+02:00",
                        value_wh=510.0,
                    )
                ],
                actual=[
                    models.SolarBiasInspectorPoint(
                        timestamp="2026-04-25T08:00:00+02:00",
                        value_wh=480.0,
                    )
                ],
                factors=[models.SolarBiasFactorPoint(slot="08:00", factor=1.21)],
            ),
            totals=models.SolarBiasInspectorTotals(
                raw_wh=420.0,
                corrected_wh=510.0,
                actual_wh=480.0,
            ),
            availability=models.SolarBiasInspectorAvailability(
                has_raw_forecast=True,
                has_corrected_forecast=True,
                has_actuals=True,
                has_profile=True,
            ),
            is_today=True,
            is_future=False,
        )
    )

    assert payload == {
        "date": "2026-04-25",
        "timezone": "Europe/Prague",
        "status": "applied",
        "effectiveVariant": "adjusted",
        "trainedAt": "2026-04-25T03:00:04+02:00",
        "range": {
            "minDate": "2026-04-18",
            "maxDate": "2026-04-27",
            "canGoPrevious": True,
            "canGoNext": True,
            "isToday": True,
            "isFuture": False,
        },
        "series": {
            "raw": [{"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 420.0}],
            "corrected": [{"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 510.0}],
            "actual": [{"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 480.0}],
            "factors": [{"slot": "08:00", "factor": 1.21}],
        },
        "totals": {"rawWh": 420.0, "correctedWh": 510.0, "actualWh": 480.0},
        "availability": {
            "hasRawForecast": True,
            "hasCorrectedForecast": True,
            "hasActuals": True,
            "hasProfile": True,
        },
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/test_solar_bias_inspector.py::test_inspector_day_serializes_frontend_contract -q
```

Expected: FAIL with `AttributeError` for missing `inspector_day_to_payload` or missing dataclass.

- [ ] **Step 3: Add inspector dataclasses and serializer**

Append these definitions in `custom_components/helman/solar_bias_correction/models.py` after `SolarBiasAdjustmentResult`:

```python
@dataclass
class SolarBiasInspectorPoint:
    timestamp: str
    value_wh: float


@dataclass
class SolarBiasFactorPoint:
    slot: str
    factor: float


@dataclass
class SolarBiasInspectorSeries:
    raw: list[SolarBiasInspectorPoint]
    corrected: list[SolarBiasInspectorPoint]
    actual: list[SolarBiasInspectorPoint]
    factors: list[SolarBiasFactorPoint]


@dataclass
class SolarBiasInspectorTotals:
    raw_wh: float | None
    corrected_wh: float | None
    actual_wh: float | None


@dataclass
class SolarBiasInspectorAvailability:
    has_raw_forecast: bool
    has_corrected_forecast: bool
    has_actuals: bool
    has_profile: bool


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


def inspector_day_to_payload(day: SolarBiasInspectorDay) -> dict[str, Any]:
    return {
        "date": day.date,
        "timezone": day.timezone,
        "status": day.status,
        "effectiveVariant": day.effective_variant,
        "trainedAt": day.trained_at,
        "range": {
            "minDate": day.min_date,
            "maxDate": day.max_date,
            "canGoPrevious": day.date > day.min_date,
            "canGoNext": day.date < day.max_date,
            "isToday": day.is_today,
            "isFuture": day.is_future,
        },
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
        },
        "totals": {
            "rawWh": day.totals.raw_wh,
            "correctedWh": day.totals.corrected_wh,
            "actualWh": day.totals.actual_wh,
        },
        "availability": {
            "hasRawForecast": day.availability.has_raw_forecast,
            "hasCorrectedForecast": day.availability.has_corrected_forecast,
            "hasActuals": day.availability.has_actuals,
            "hasProfile": day.availability.has_profile,
        },
    }


def _inspector_point_payload(point: SolarBiasInspectorPoint) -> dict[str, Any]:
    return {"timestamp": point.timestamp, "valueWh": point.value_wh}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/test_solar_bias_inspector.py::test_inspector_day_serializes_frontend_contract -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add custom_components/helman/solar_bias_correction/models.py tests/test_solar_bias_inspector.py
git commit -m "feat: add solar bias inspector response models"
```

---

## Task 2: One-Day Raw Forecast And Actual Readers

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/forecast_history.py`
- Modify: `custom_components/helman/solar_bias_correction/actuals.py`
- Test: `tests/test_solar_bias_inspector.py`

- [ ] **Step 1: Write failing reader tests**

Append these tests to `tests/test_solar_bias_inspector.py`:

```python
forecast_history = importlib.import_module(
    "custom_components.helman.solar_bias_correction.forecast_history"
)
actuals = importlib.import_module("custom_components.helman.solar_bias_correction.actuals")


def _make_cfg():
    return models.BiasConfig(
        enabled=True,
        min_history_days=2,
        training_time="03:00",
        clamp_min=0.3,
        clamp_max=2.0,
        daily_energy_entity_ids=["sensor.solar_today", "sensor.solar_tomorrow"],
        total_energy_entity_id="sensor.solar_total",
    )


def test_load_forecast_points_for_day_reads_daily_entity_slots():
    class _States:
        def get(self, entity_id):
            if entity_id == "sensor.solar_today":
                return SimpleNamespace(
                    attributes={
                        "wh_period": {
                            "2026-04-25T00:00:00+02:00": 0,
                            "2026-04-25T01:00:00+02:00": 250,
                        }
                    }
                )
            return None

    hass = SimpleNamespace(
        states=_States(),
        config=SimpleNamespace(time_zone="Europe/Prague"),
    )

    result = asyncio.run(
        forecast_history.load_forecast_points_for_day(
            hass,
            _make_cfg(),
            date.fromisoformat("2026-04-25"),
            local_now=datetime.fromisoformat("2026-04-25T10:00:00+02:00"),
        )
    )

    assert result == [
        {"timestamp": "2026-04-25T00:00:00+02:00", "value": 0.0},
        {"timestamp": "2026-04-25T01:00:00+02:00", "value": 250.0},
    ]


def test_load_forecast_points_for_day_returns_empty_outside_configured_horizon():
    hass = SimpleNamespace(
        states=SimpleNamespace(get=lambda entity_id: None),
        config=SimpleNamespace(time_zone="Europe/Prague"),
    )

    result = asyncio.run(
        forecast_history.load_forecast_points_for_day(
            hass,
            _make_cfg(),
            date.fromisoformat("2026-04-29"),
            local_now=datetime.fromisoformat("2026-04-25T10:00:00+02:00"),
        )
    )

    assert result == []


def test_load_actuals_for_day_uses_existing_slot_actual_reader():
    captured = {}

    async def fake_read_day_slot_actuals(hass, entity_id, target_date, *, local_now):
        captured["args"] = (entity_id, target_date, local_now)
        return {"08:00": 120.0, "08:15": 80.0}

    original = actuals._read_day_slot_actuals
    actuals._read_day_slot_actuals = fake_read_day_slot_actuals
    try:
        result = asyncio.run(
            actuals.load_actuals_for_day(
                SimpleNamespace(),
                _make_cfg(),
                date.fromisoformat("2026-04-24"),
                local_now=datetime.fromisoformat("2026-04-25T10:00:00+02:00"),
            )
        )
    finally:
        actuals._read_day_slot_actuals = original

    assert captured["args"][0] == "sensor.solar_total"
    assert captured["args"][1] == date.fromisoformat("2026-04-24")
    assert result == {"08:00": 120.0, "08:15": 80.0}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/test_solar_bias_inspector.py -q
```

Expected: FAIL with missing `load_forecast_points_for_day` and `load_actuals_for_day`.

- [ ] **Step 3: Implement one-day forecast reader**

Add imports to `forecast_history.py`:

```python
from zoneinfo import ZoneInfo
```

Add this function near `load_trainer_samples()`:

```python
async def load_forecast_points_for_day(
    hass: HomeAssistant,
    cfg: BiasConfig,
    target_date: date,
    *,
    local_now: datetime,
) -> list[dict[str, Any]]:
    entity_ids = _read_entity_ids(cfg.daily_energy_entity_ids)
    if not entity_ids:
        return []

    local_tz = ZoneInfo(str(hass.config.time_zone))
    today = dt_util.as_local(local_now).date()
    offset = (target_date - today).days
    if offset < 0 or offset >= len(entity_ids):
        return []

    entity_id = entity_ids[offset]
    state = hass.states.get(entity_id)
    if state is None:
        return []

    wh_period = getattr(state, "attributes", {}).get("wh_period")
    if not isinstance(wh_period, dict):
        return []

    parsed_points: list[tuple[datetime, float]] = []
    for raw_key, raw_value in wh_period.items():
        parsed_value = _parse_state_wh(raw_value)
        parsed_timestamp = _parse_attribute_timestamp(raw_key, local_tz)
        if parsed_value is None or parsed_timestamp is None:
            continue
        parsed_points.append((parsed_timestamp, parsed_value))

    parsed_points.sort(key=lambda item: dt_util.as_utc(item[0]))
    expected_slots = _build_local_hour_slots_for_date(target_date, local_tz)
    return [
        {"timestamp": slot_start.isoformat(), "value": value}
        for slot_start, (_, value) in zip(expected_slots, parsed_points)
    ]
```

Add these helpers at the end of `forecast_history.py`:

```python
def _build_local_hour_slots_for_date(
    target_date: date,
    local_tz: ZoneInfo,
) -> list[datetime]:
    local_start = datetime.combine(target_date, time.min, tzinfo=local_tz)
    local_end = datetime.combine(target_date + timedelta(days=1), time.min, tzinfo=local_tz)

    slots: list[datetime] = []
    cursor_utc = dt_util.as_utc(local_start)
    end_utc = dt_util.as_utc(local_end)
    while cursor_utc < end_utc:
        slots.append(dt_util.as_local(cursor_utc))
        cursor_utc += timedelta(hours=1)
    return slots


def _parse_attribute_timestamp(raw_key: Any, local_tz: ZoneInfo) -> datetime | None:
    if not isinstance(raw_key, str):
        return None

    try:
        parsed = datetime.fromisoformat(raw_key.replace("Z", "+00:00"))
    except ValueError:
        return None

    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=local_tz)
    return parsed
```

- [ ] **Step 4: Implement one-day actual reader**

Add this function near `load_actuals_window()` in `actuals.py`:

```python
async def load_actuals_for_day(
    hass: HomeAssistant,
    cfg: BiasConfig,
    target_date: date,
    *,
    local_now: datetime,
) -> dict[str, float]:
    entity_id = _read_entity_id(cfg.total_energy_entity_id)
    if entity_id is None:
        return {}
    return await _read_day_slot_actuals(
        hass,
        entity_id,
        target_date,
        local_now=local_now,
    )
```

- [ ] **Step 5: Run reader tests to verify they pass**

Run:

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/test_solar_bias_inspector.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add custom_components/helman/solar_bias_correction/forecast_history.py custom_components/helman/solar_bias_correction/actuals.py tests/test_solar_bias_inspector.py
git commit -m "feat: add solar bias inspector day readers"
```

---

## Task 3: Service Orchestration For Inspector Day

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/service.py`
- Test: `tests/test_solar_bias_inspector.py`

- [ ] **Step 1: Write failing service tests**

Append these tests to `tests/test_solar_bias_inspector.py`:

```python
service_mod = importlib.import_module("custom_components.helman.solar_bias_correction.service")


class _DummyStore:
    profile = None

    async def async_save(self, payload):
        self.saved = payload


def _make_service():
    hass = SimpleNamespace(
        config=SimpleNamespace(time_zone="Europe/Prague"),
        bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None),
    )
    return service_mod.SolarBiasCorrectionService(hass, _DummyStore(), _make_cfg())


def test_inspector_day_applies_current_profile_and_totals():
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

    async def fake_forecast_points(*args, **kwargs):
        return [
            {"timestamp": "2026-04-25T08:00:00+02:00", "value": 100.0},
            {"timestamp": "2026-04-25T09:00:00+02:00", "value": 200.0},
        ]

    async def fake_actuals(*args, **kwargs):
        return {"08:00": 90.0}

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

    assert payload["status"] == "applied"
    assert payload["effectiveVariant"] == "adjusted"
    assert payload["availability"] == {
        "hasRawForecast": True,
        "hasCorrectedForecast": True,
        "hasActuals": True,
        "hasProfile": True,
    }
    assert payload["series"]["raw"] == [
        {"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 100.0},
        {"timestamp": "2026-04-25T09:00:00+02:00", "valueWh": 200.0},
    ]
    assert payload["series"]["corrected"] == [
        {"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 150.0},
        {"timestamp": "2026-04-25T09:00:00+02:00", "valueWh": 100.0},
    ]
    assert payload["series"]["actual"] == [
        {"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 90.0}
    ]
    assert payload["series"]["factors"] == [
        {"slot": "08:00", "factor": 1.5},
        {"slot": "09:00", "factor": 0.5},
    ]
    assert payload["totals"] == {"rawWh": 300.0, "correctedWh": 250.0, "actualWh": 90.0}
    assert payload["range"]["minDate"] == "2026-04-18"
    assert payload["range"]["isToday"] is True


def test_inspector_day_without_profile_keeps_corrected_equal_to_raw():
    service = _make_service()

    async def fake_forecast_points(*args, **kwargs):
        return [{"timestamp": "2026-04-25T08:00:00+02:00", "value": 100.0}]

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

    assert payload["effectiveVariant"] == "raw"
    assert payload["availability"]["hasProfile"] is False
    assert payload["availability"]["hasCorrectedForecast"] is True
    assert payload["series"]["corrected"] == payload["series"]["raw"]
    assert payload["series"]["factors"] == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/test_solar_bias_inspector.py -q
```

Expected: FAIL with missing `async_get_inspector_day` or imports.

- [ ] **Step 3: Add service imports**

Update imports in `service.py`:

```python
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo
```

Add these imports from local modules:

```python
from .actuals import load_actuals_for_day, load_actuals_window
from .forecast_history import load_forecast_points_for_day, load_trainer_samples
```

Add inspector model imports:

```python
    SolarBiasFactorPoint,
    SolarBiasInspectorAvailability,
    SolarBiasInspectorDay,
    SolarBiasInspectorPoint,
    SolarBiasInspectorSeries,
    SolarBiasInspectorTotals,
    inspector_day_to_payload,
```

- [ ] **Step 4: Implement `async_get_inspector_day`**

Add this public method after `get_profile_payload()` in `SolarBiasCorrectionService`:

```python
    async def async_get_inspector_day(self, raw_date: str) -> dict[str, Any]:
        target_date = date.fromisoformat(raw_date)
        local_now = dt_util.as_local(dt_util.now())
        today = local_now.date()
        min_date = today - timedelta(days=7)
        max_date = today + timedelta(days=max(len(self._cfg.daily_energy_entity_ids) - 1, 0))

        raw_points = await load_forecast_points_for_day(
            self._hass,
            self._cfg,
            target_date,
            local_now=local_now,
        )
        actuals_by_slot = {}
        if target_date <= today:
            actuals_by_slot = await load_actuals_for_day(
                self._hass,
                self._cfg,
                target_date,
                local_now=local_now,
            )

        status, effective_variant, _fallback_reason = self._resolve_status()
        corrected_points = _copy_points(raw_points)
        has_profile = self._has_usable_profile()
        if effective_variant == "adjusted" and self._profile is not None:
            corrected_points = adjust(raw_points, self._profile)

        factors = _factor_points_for_profile(self._profile if has_profile else None)
        actual_points = _actual_points_for_date(
            actuals_by_slot,
            target_date,
            ZoneInfo(str(self._hass.config.time_zone)),
        )
        day = SolarBiasInspectorDay(
            date=target_date.isoformat(),
            timezone=str(self._hass.config.time_zone),
            status=status,
            effective_variant=effective_variant,
            trained_at=self._trained_at,
            min_date=min_date.isoformat(),
            max_date=max_date.isoformat(),
            series=SolarBiasInspectorSeries(
                raw=_inspector_points(raw_points),
                corrected=_inspector_points(corrected_points),
                actual=actual_points,
                factors=factors,
            ),
            totals=SolarBiasInspectorTotals(
                raw_wh=_sum_point_values(raw_points) if raw_points else None,
                corrected_wh=(
                    _sum_point_values(corrected_points) if corrected_points else None
                ),
                actual_wh=sum(actuals_by_slot.values()) if actuals_by_slot else None,
            ),
            availability=SolarBiasInspectorAvailability(
                has_raw_forecast=bool(raw_points),
                has_corrected_forecast=bool(corrected_points),
                has_actuals=bool(actuals_by_slot),
                has_profile=has_profile,
            ),
            is_today=target_date == today,
            is_future=target_date > today,
        )
        return inspector_day_to_payload(day)
```

- [ ] **Step 5: Add service helper functions**

Add these module-level helpers near `_copy_points()` in `service.py`:

```python
def _inspector_points(raw_points: list[dict[str, Any]]) -> list[SolarBiasInspectorPoint]:
    points: list[SolarBiasInspectorPoint] = []
    for point in raw_points:
        timestamp = point.get("timestamp")
        value = point.get("value")
        if not isinstance(timestamp, str):
            continue
        try:
            value_wh = float(value)
        except (TypeError, ValueError):
            continue
        points.append(SolarBiasInspectorPoint(timestamp=timestamp, value_wh=value_wh))
    return points


def _sum_point_values(raw_points: list[dict[str, Any]]) -> float:
    total = 0.0
    for point in raw_points:
        try:
            total += float(point.get("value"))
        except (TypeError, ValueError):
            continue
    return total


def _factor_points_for_profile(
    profile: SolarBiasProfile | None,
) -> list[SolarBiasFactorPoint]:
    if profile is None:
        return []
    return [
        SolarBiasFactorPoint(slot=slot, factor=float(factor))
        for slot, factor in sorted(profile.factors.items())
    ]


def _actual_points_for_date(
    actuals_by_slot: dict[str, float],
    target_date: date,
    local_tz: ZoneInfo,
) -> list[SolarBiasInspectorPoint]:
    points: list[SolarBiasInspectorPoint] = []
    for slot, value in sorted(actuals_by_slot.items()):
        try:
            hour, minute = [int(part) for part in slot.split(":", 1)]
            timestamp = datetime.combine(
                target_date,
                time(hour=hour, minute=minute),
                tzinfo=local_tz,
            )
            points.append(
                SolarBiasInspectorPoint(
                    timestamp=timestamp.isoformat(),
                    value_wh=float(value),
                )
            )
        except (TypeError, ValueError):
            continue
    return points
```

- [ ] **Step 6: Run service tests**

Run:

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/test_solar_bias_inspector.py -q
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add custom_components/helman/solar_bias_correction/service.py tests/test_solar_bias_inspector.py
git commit -m "feat: build solar bias inspector payload"
```

---

## Task 4: Websocket Endpoint

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/websocket.py`
- Test: `tests/test_solar_bias_websocket.py`

- [ ] **Step 1: Write failing websocket tests**

Append these tests to `SolarBiasWebsocketTests` in `tests/test_solar_bias_websocket.py`:

```python
    async def test_inspector_returns_service_payload_for_date(self) -> None:
        payload = {
            "date": "2026-04-25",
            "timezone": "Europe/Prague",
            "series": {"raw": [], "corrected": [], "actual": [], "factors": []},
        }
        service = SimpleNamespace(
            async_get_inspector_day=AsyncMock(return_value=payload)
        )
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection()

        await self.solar_bias_ws.ws_get_solar_bias_inspector(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/inspector", "date": "2026-04-25"},
        )

        service.async_get_inspector_day.assert_awaited_once_with("2026-04-25")
        self.assertEqual(connection.results, [(1, payload)])
        self.assertEqual(connection.errors, [])

    async def test_inspector_requires_admin(self) -> None:
        service = SimpleNamespace(async_get_inspector_day=AsyncMock())
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection(is_admin=False)

        await self.solar_bias_ws.ws_get_solar_bias_inspector(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/inspector", "date": "2026-04-25"},
        )

        service.async_get_inspector_day.assert_not_awaited()
        self.assertEqual(
            connection.errors,
            [(1, "unauthorized", "Admin access required")],
        )

    async def test_inspector_rejects_invalid_date(self) -> None:
        service = SimpleNamespace(async_get_inspector_day=AsyncMock())
        coordinator = SimpleNamespace(_solar_bias_service=service)
        connection = FakeConnection()

        await self.solar_bias_ws.ws_get_solar_bias_inspector(
            FakeHass(coordinator),
            connection,
            {"id": 1, "type": "helman/solar_bias/inspector", "date": "04/25/2026"},
        )

        service.async_get_inspector_day.assert_not_awaited()
        self.assertEqual(
            connection.errors,
            [(1, "invalid_date", "Date must use YYYY-MM-DD format")],
        )
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/test_solar_bias_websocket.py -q
```

Expected: FAIL with missing `ws_get_solar_bias_inspector`.

- [ ] **Step 3: Implement websocket handler**

Add import at the top of `websocket.py`:

```python
from datetime import date
```

Add this command before `_get_solar_bias_service()`:

```python
@websocket_api.websocket_command(
    {
        vol.Required("type"): "helman/solar_bias/inspector",
        vol.Required("date"): str,
    }
)
@websocket_api.async_response
async def ws_get_solar_bias_inspector(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict,
) -> None:
    if not _require_admin(connection, msg):
        return

    raw_date = msg.get("date")
    try:
        date.fromisoformat(raw_date)
    except (TypeError, ValueError):
        connection.send_error(
            msg["id"],
            "invalid_date",
            "Date must use YYYY-MM-DD format",
        )
        return

    service = _get_solar_bias_service(hass, connection, msg)
    if service is None:
        return

    try:
        payload = await service.async_get_inspector_day(raw_date)
    except Exception:
        _LOGGER.exception("Unexpected solar bias inspector failure")
        connection.send_error(
            msg["id"],
            "internal_error",
            "Unexpected solar bias inspector failure",
        )
        return

    connection.send_result(msg["id"], payload)
```

- [ ] **Step 4: Run websocket tests**

Run:

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/test_solar_bias_websocket.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add custom_components/helman/solar_bias_correction/websocket.py tests/test_solar_bias_websocket.py
git commit -m "feat: expose solar bias inspector websocket"
```

---

## Task 5: Frontend Inspector Element Shell

**Files:**
- Create: `custom_components/helman/frontend/src/bias-correction-inspector.ts`
- Modify: `custom_components/helman/frontend/src/bias-correction-status.ts`
- Modify: `custom_components/helman/frontend/src/localize/translations/en.json`
- Modify: `custom_components/helman/frontend/src/localize/translations/cs.json`

- [ ] **Step 1: Add translations**

Add these keys under the top-level `bias_correction` object in both translation files:

```json
"inspector": {
  "title": "Visual inspector",
  "loading": "Loading inspector data...",
  "load_failed": "Failed to load inspector data.",
  "previous_day": "Previous day",
  "next_day": "Next day",
  "today": "Today",
  "forecast_only": "Forecast only",
  "raw_forecast": "Raw forecast",
  "corrected_forecast": "Corrected forecast",
  "actual_production": "Actual production",
  "correction_factor": "Correction factor",
  "daily_totals": "Daily totals",
  "actual_not_available": "not available",
  "no_profile": "No trained profile is available yet. Raw forecast and actual history can still be shown when available.",
  "no_data": "No data is available for {date}. Try a newer day or refresh after the next forecast update."
}
```

If `cs.json` does not have Czech wording ready, use the same English strings to keep localization lookup complete.

- [ ] **Step 2: Create element with data loading and empty rendering**

Create `custom_components/helman/frontend/src/bias-correction-inspector.ts`:

```ts
import { LitElement, css, html, svg } from "lit";
import { property, state } from "lit/decorators.js";
import { getLocalizeFunction, type LocalizeFunction } from "./localize/localize";

type InspectorPoint = { timestamp: string; valueWh: number };
type FactorPoint = { slot: string; factor: number };
type InspectorPayload = {
  date: string;
  timezone: string;
  status: string;
  effectiveVariant: string | null;
  trainedAt: string | null;
  range: {
    minDate: string;
    maxDate: string;
    canGoPrevious: boolean;
    canGoNext: boolean;
    isToday: boolean;
    isFuture: boolean;
  };
  series: {
    raw: InspectorPoint[];
    corrected: InspectorPoint[];
    actual: InspectorPoint[];
    factors: FactorPoint[];
  };
  totals: {
    rawWh: number | null;
    correctedWh: number | null;
    actualWh: number | null;
  };
  availability: {
    hasRawForecast: boolean;
    hasCorrectedForecast: boolean;
    hasActuals: boolean;
    hasProfile: boolean;
  };
};

export class HelmanBiasCorrectionInspector extends LitElement {
  @property({ attribute: false }) hass: any;

  @state() private _expanded = false;
  @state() private _selectedDate = this._todayIso();
  @state() private _payload: InspectorPayload | null = null;
  @state() private _loading = false;
  @state() private _error = "";

  private _fallbackLocalize: LocalizeFunction = getLocalizeFunction();

  static styles = css`
    .inspector {
      display: grid;
      gap: 12px;
      border-top: 1px solid var(--divider-color);
      padding-top: 12px;
    }

    .summary {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 0;
      border: 0;
      background: transparent;
      color: var(--primary-text-color);
      font-weight: 600;
      cursor: pointer;
    }

    .summary::before {
      content: "▸";
      width: 16px;
    }

    .summary[aria-expanded="true"]::before {
      content: "▾";
    }

    .body {
      display: grid;
      gap: 12px;
    }

    .nav {
      display: grid;
      grid-template-columns: 40px 1fr auto 40px;
      align-items: center;
      gap: 8px;
    }

    .icon-button {
      min-width: 40px;
      min-height: 36px;
      border: 1px solid var(--divider-color);
      border-radius: 6px;
      background: var(--card-background-color);
      color: var(--primary-text-color);
      cursor: pointer;
    }

    .icon-button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .day-label {
      min-width: 0;
      color: var(--primary-text-color);
      font-weight: 600;
    }

    .day-state {
      color: var(--secondary-text-color);
      font-size: 0.9rem;
      white-space: nowrap;
    }

    .note {
      padding: 12px;
      border-radius: 6px;
      border: 1px solid var(--divider-color);
      color: var(--secondary-text-color);
      background: var(--secondary-background-color);
      line-height: 1.35;
    }

    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      font-size: 0.85rem;
      color: var(--secondary-text-color);
    }

    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .swatch {
      width: 18px;
      height: 3px;
      border-radius: 2px;
      background: currentColor;
    }

    .swatch.raw { color: #1565c0; }
    .swatch.corrected { color: #2e7d32; }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #c62828;
    }
    .shade {
      width: 18px;
      height: 10px;
      background: rgba(245, 127, 23, 0.24);
      border: 1px solid rgba(245, 127, 23, 0.35);
    }

    .chart-wrap {
      min-height: 260px;
      border: 1px solid var(--divider-color);
      border-radius: 6px;
      overflow: hidden;
      background: var(--card-background-color);
    }

    svg {
      display: block;
      width: 100%;
      height: auto;
    }

    .totals {
      display: grid;
      gap: 6px;
      font-size: 0.9rem;
    }

    .total-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }
  `;

  protected updated(changed: Map<string, unknown>) {
    if (changed.has("hass") && this.hass && this._expanded && !this._payload) {
      this._load();
    }
  }

  render() {
    return html`
      <div class="inspector">
        <button
          class="summary"
          aria-expanded=${this._expanded ? "true" : "false"}
          @click=${this._toggle}
        >
          <span>${this._t("bias_correction.inspector.title")}</span>
        </button>
        ${this._expanded ? this._renderBody() : ""}
      </div>
    `;
  }

  private _renderBody() {
    return html`
      <div class="body">
        ${this._renderNavigation()}
        ${this._loading ? html`<div class="note">${this._t("bias_correction.inspector.loading")}</div>` : ""}
        ${this._error ? html`<div class="note">${this._error}</div>` : ""}
        ${this._payload ? this._renderContent(this._payload) : ""}
      </div>
    `;
  }

  private _renderNavigation() {
    const canGoPrevious = this._payload?.range.canGoPrevious ?? true;
    const canGoNext = this._payload?.range.canGoNext ?? true;
    return html`
      <div class="nav">
        <button class="icon-button" title=${this._t("bias_correction.inspector.previous_day")} ?disabled=${!canGoPrevious || this._loading} @click=${() => this._moveDay(-1)}>‹</button>
        <div class="day-label">${this._formatDay(this._selectedDate)}</div>
        <div class="day-state">${this._payload?.range.isToday ? this._t("bias_correction.inspector.today") : this._payload?.range.isFuture ? this._t("bias_correction.inspector.forecast_only") : ""}</div>
        <button class="icon-button" title=${this._t("bias_correction.inspector.next_day")} ?disabled=${!canGoNext || this._loading} @click=${() => this._moveDay(1)}>›</button>
      </div>
    `;
  }

  private _renderContent(payload: InspectorPayload) {
    const hasAnySeries =
      payload.availability.hasRawForecast ||
      payload.availability.hasCorrectedForecast ||
      payload.availability.hasActuals;

    return html`
      ${!payload.availability.hasProfile
        ? html`<div class="note">${this._t("bias_correction.inspector.no_profile")}</div>`
        : ""}
      ${hasAnySeries
        ? html`
            ${this._renderLegend(payload)}
            <div class="chart-wrap">${this._renderChart(payload)}</div>
            ${this._renderTotals(payload)}
          `
        : html`<div class="note">${this._tFormat("bias_correction.inspector.no_data", { date: this._formatDay(payload.date) })}</div>`}
    `;
  }

  private _renderLegend(payload: InspectorPayload) {
    return html`
      <div class="legend">
        <span class="legend-item"><span class="swatch raw"></span>${this._t("bias_correction.inspector.raw_forecast")}</span>
        <span class="legend-item"><span class="swatch corrected"></span>${this._t("bias_correction.inspector.corrected_forecast")}</span>
        ${payload.availability.hasActuals ? html`<span class="legend-item"><span class="dot"></span>${this._t("bias_correction.inspector.actual_production")}</span>` : ""}
        ${payload.availability.hasProfile ? html`<span class="legend-item"><span class="shade"></span>${this._t("bias_correction.inspector.correction_factor")}</span>` : ""}
      </div>
    `;
  }

  private _renderChart(payload: InspectorPayload) {
    return svg`<svg viewBox="0 0 720 260" role="img" aria-label=${this._t("bias_correction.inspector.title")}></svg>`;
  }

  private _renderTotals(payload: InspectorPayload) {
    return html`
      <div class="totals">
        <strong>${this._t("bias_correction.inspector.daily_totals")}</strong>
        <div class="total-row"><span>${this._t("bias_correction.inspector.raw_forecast")}</span><span>${this._formatWh(payload.totals.rawWh)}</span></div>
        <div class="total-row"><span>${this._t("bias_correction.inspector.corrected_forecast")}</span><span>${this._formatWh(payload.totals.correctedWh)}</span></div>
        <div class="total-row"><span>${this._t("bias_correction.inspector.actual_production")}</span><span>${this._formatWh(payload.totals.actualWh)}</span></div>
      </div>
    `;
  }

  private _toggle() {
    this._expanded = !this._expanded;
    if (this._expanded && !this._payload) {
      this._load();
    }
  }

  private async _load() {
    if (!this.hass) return;
    this._loading = true;
    this._error = "";
    try {
      this._payload = await this.hass.callWS({
        type: "helman/solar_bias/inspector",
        date: this._selectedDate,
      });
    } catch (err: any) {
      this._error = err?.message || this._t("bias_correction.inspector.load_failed");
    } finally {
      this._loading = false;
    }
  }

  private _moveDay(delta: number) {
    const next = new Date(`${this._selectedDate}T12:00:00`);
    next.setDate(next.getDate() + delta);
    this._selectedDate = next.toISOString().slice(0, 10);
    this._load();
  }

  private _todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  private _formatDay(value: string) {
    return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  private _formatWh(value: number | null) {
    if (value === null) return this._t("bias_correction.inspector.actual_not_available");
    return `${(value / 1000).toFixed(1)} kWh`;
  }

  private _t(key: string): string {
    return getLocalizeFunction(this.hass ?? undefined)(key) ?? this._fallbackLocalize(key);
  }

  private _tFormat(key: string, values: Record<string, string | number>): string {
    let text = this._t(key);
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "helman-bias-correction-inspector": HelmanBiasCorrectionInspector;
  }
}

if (!customElements.get("helman-bias-correction-inspector")) {
  customElements.define("helman-bias-correction-inspector", HelmanBiasCorrectionInspector);
}
```

- [ ] **Step 3: Mount inspector below status and training**

Add import at the top of `bias-correction-status.ts`:

```ts
import "./bias-correction-inspector";
```

Render the child element just before the final info box in `bias-correction-status.ts`:

```ts
<helman-bias-correction-inspector .hass=${this.hass}></helman-bias-correction-inspector>
```

- [ ] **Step 4: Build frontend**

Run:

```bash
npm --prefix custom_components/helman/frontend run build
```

Expected: PASS and `custom_components/helman/frontend/dist/helman-config-editor.js` changes.

- [ ] **Step 5: Commit**

```bash
git add custom_components/helman/frontend/src/bias-correction-inspector.ts custom_components/helman/frontend/src/bias-correction-status.ts custom_components/helman/frontend/src/localize/translations/en.json custom_components/helman/frontend/src/localize/translations/cs.json custom_components/helman/frontend/dist/helman-config-editor.js
git commit -m "feat: add solar bias visual inspector shell"
```

---

## Task 6: Option B Single SVG Chart

**Files:**
- Modify: `custom_components/helman/frontend/src/bias-correction-inspector.ts`

- [ ] **Step 1: Replace placeholder chart with Option B SVG**

Replace `_renderChart(payload: InspectorPayload)` in `bias-correction-inspector.ts` with:

```ts
  private _renderChart(payload: InspectorPayload) {
    const width = 720;
    const height = 260;
    const margin = { top: 18, right: 24, bottom: 34, left: 48 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const allEnergy = [
      ...payload.series.raw.map((point) => point.valueWh),
      ...payload.series.corrected.map((point) => point.valueWh),
      ...payload.series.actual.map((point) => point.valueWh),
    ].filter((value) => Number.isFinite(value));
    const maxWh = Math.max(1000, ...allEnergy);
    const maxKwh = Math.ceil(maxWh / 1000);
    const yTicks = this._buildYTicks(maxKwh);

    const xForTimestamp = (timestamp: string) => {
      const date = new Date(timestamp);
      const minutes = date.getHours() * 60 + date.getMinutes();
      return margin.left + (minutes / 1440) * plotWidth;
    };
    const yForWh = (valueWh: number) =>
      margin.top + plotHeight - (valueWh / (maxKwh * 1000)) * plotHeight;

    const linePath = (points: InspectorPoint[]) =>
      points
        .map((point, index) => {
          const command = index === 0 ? "M" : "L";
          return `${command}${xForTimestamp(point.timestamp).toFixed(1)},${yForWh(point.valueWh).toFixed(1)}`;
        })
        .join(" ");

    return svg`
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label=${this._t("bias_correction.inspector.title")}>
        <rect x="0" y="0" width=${width} height=${height} fill="var(--card-background-color)"></rect>
        ${this._renderFactorBands(payload.series.factors, margin.left, margin.top, plotWidth, plotHeight)}
        ${yTicks.map((tick) => {
          const y = yForWh(tick * 1000);
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
        <text x="12" y="16" fill="var(--secondary-text-color)" font-size="11">kWh</text>
        <path d=${linePath(payload.series.raw)} fill="none" stroke="#1565c0" stroke-width="2.4"></path>
        <path d=${linePath(payload.series.corrected)} fill="none" stroke="#2e7d32" stroke-width="2.4"></path>
        ${payload.series.actual.map((point) => svg`
          <circle cx=${xForTimestamp(point.timestamp)} cy=${yForWh(point.valueWh)} r="3.5" fill="#c62828"></circle>
        `)}
      </svg>
    `;
  }
```

- [ ] **Step 2: Add factor band and tick helpers**

Add these methods below `_renderChart()`:

```ts
  private _renderFactorBands(
    factors: FactorPoint[],
    plotLeft: number,
    plotTop: number,
    plotWidth: number,
    plotHeight: number,
  ) {
    if (!factors.length) return "";
    const values = factors.map((point) => point.factor).filter((value) => Number.isFinite(value));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(max - min, 0.01);
    return factors.map((point) => {
      const [hour, minute] = point.slot.split(":").map((part) => Number(part));
      if (!Number.isFinite(hour) || !Number.isFinite(minute)) return "";
      const startMinutes = hour * 60 + minute;
      const x = plotLeft + (startMinutes / 1440) * plotWidth;
      const bandWidth = Math.max(2, plotWidth / 96);
      const intensity = Math.abs(point.factor - 1) / Math.max(Math.abs(max - 1), Math.abs(min - 1), span);
      const opacity = Math.min(0.34, 0.06 + intensity * 0.28);
      const fill = point.factor >= 1 ? "245, 127, 23" : "21, 101, 192";
      return svg`<rect x=${x} y=${plotTop} width=${bandWidth} height=${plotHeight} fill="rgba(${fill}, ${opacity})"></rect>`;
    });
  }

  private _buildYTicks(maxKwh: number) {
    const step = maxKwh <= 4 ? 1 : Math.ceil(maxKwh / 4);
    const ticks: number[] = [];
    for (let value = 0; value <= maxKwh; value += step) {
      ticks.push(value);
    }
    if (ticks[ticks.length - 1] !== maxKwh) {
      ticks.push(maxKwh);
    }
    return ticks;
  }
```

- [ ] **Step 3: Build frontend**

Run:

```bash
npm --prefix custom_components/helman/frontend run build
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add custom_components/helman/frontend/src/bias-correction-inspector.ts custom_components/helman/frontend/dist/helman-config-editor.js
git commit -m "feat: render solar bias correction intensity chart"
```

---

## Task 7: Final Verification And Documentation Note

**Files:**
- Modify: `docs/features/forecast/solar-forecast-bias-correction/solar-bias-correction-visual-inspector-proposal.md`

- [ ] **Step 1: Add implementation note**

Append this note to the proposal:

```markdown
## Implementation Note

Implemented v1 uses Option B: a single solar energy SVG chart with correction factor intensity rendered as shaded background bands. The inspector remains read-only, collapsed by default, and fetches one local day at a time through `helman/solar_bias/inspector`.
```

- [ ] **Step 2: Run backend tests**

Run:

```bash
/home/ondra/dev/dojo/dateutil/.venv/bin/pytest tests/test_solar_bias_inspector.py tests/test_solar_bias_websocket.py tests/test_solar_bias_service_runtime.py tests/test_solar_bias_adjuster.py -q
```

Expected: PASS.

- [ ] **Step 3: Run frontend build**

Run:

```bash
npm --prefix custom_components/helman/frontend run build
```

Expected: PASS.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git diff --stat
git diff -- custom_components/helman/solar_bias_correction custom_components/helman/frontend/src tests docs/features/forecast/solar-forecast-bias-correction/solar-bias-correction-visual-inspector-proposal.md
```

Expected: diff only contains inspector-related backend, frontend, tests, built frontend bundle, and proposal note.

- [ ] **Step 5: Commit**

```bash
git add custom_components/helman/solar_bias_correction custom_components/helman/frontend/src custom_components/helman/frontend/dist/helman-config-editor.js tests docs/features/forecast/solar-forecast-bias-correction/solar-bias-correction-visual-inspector-proposal.md
git commit -m "feat: add solar bias visual inspector"
```

---

## Self-Review

**Spec coverage:** The plan implements the requested collapsed visual inspector placement, one local day at a time, today as default, previous/next navigation with backend boundaries, raw/corrected/actual series, daily totals, missing profile/no data states, and Option B shaded correction factor background. The plan does not implement Option A because the user explicitly requested Option B.

**Placeholder scan:** No placeholder markers or broad unspecific implementation steps remain. Each code-changing step includes the concrete code or exact insertion.

**Type consistency:** Backend uses `value` internally for existing forecast adjustment and serializes inspector output as `valueWh`. Frontend `InspectorPayload` matches the backend contract with `effectiveVariant`, `trainedAt`, `valueWh`, `rawWh`, `correctedWh`, and `actualWh`.
