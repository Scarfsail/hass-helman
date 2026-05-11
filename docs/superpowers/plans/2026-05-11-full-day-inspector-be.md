# Full Day Inspector — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Home Assistant `helman` integration so the existing `helman/solar_bias/inspector` websocket payload also carries per-day house consumption (forecast + actual) and battery SoC (actual past + future-only forecast). Add a new house-consumption-forecast sensor whose recorder history makes past-day forecast retrieval possible.

**Architecture:** Mirror the existing solar bias inspector flow. A single new `SensorEntity` publishes the current 15-min house consumption forecast slot value in Wh-per-hour (W) units. A new `house_forecast_history.py` module reads back this sensor's recorder state changes for any past `target_date` and buckets them into 15-min slots. Battery actual SoC reuses `battery_actual_history_builder.build_battery_actual_history(interval_minutes=15)`; battery SoC forecast for today/future is filtered from the coordinator's current battery capacity forecast snapshot. The inspector service composes everything into the existing `SolarBiasInspectorDay` dataclass (extended with new fields) and the response builder serializes it.

**Tech Stack:** Python 3.x, Home Assistant integration framework, pytest, dataclasses.

**Cross-references:**
- Design spec: `../../../../hass-helman-card/docs/superpowers/specs/2026-05-11-full-day-inspector-design.md`
- FE plan (consumer of this payload): `../../../../hass-helman-card/docs/superpowers/plans/2026-05-11-full-day-inspector-fe.md`

---

## File map

**New files:**
- `custom_components/helman/solar_bias_correction/house_forecast_history.py` — query recorder for the new house forecast sensor's state changes during a target date and bucket into 15-min slot Wh points.
- `tests/test_house_forecast_history.py` — unit tests for the bucketing logic.
- `tests/test_inspector_house_battery_payload.py` — integration-style test that exercises `async_get_inspector_day` with mocked sources to verify all new fields appear in the payload.

**Modified files:**
- `custom_components/helman/sensor.py` — add `HelmanHouseConsumptionForecastCurrentSensor` class and register it in `async_setup_entry`.
- `custom_components/helman/coordinator.py` — expose a `get_house_consumption_forecast_current_w() -> float | None` accessor returning the current-slot house forecast as W (slot Wh × 4); call sensors' update on each cycle that produces a house forecast.
- `custom_components/helman/solar_bias_correction/models.py` — extend dataclasses (`SolarBiasInspectorSeries`, `SolarBiasInspectorTotals`, `SolarBiasInspectorAvailability`) with house + battery SoC fields; add `BatterySocPoint`.
- `custom_components/helman/solar_bias_correction/response.py` (or wherever `inspector_day_to_payload` lives — currently `models.py`) — serialize the new fields.
- `custom_components/helman/solar_bias_correction/service.py::async_get_inspector_day` — gather and attach the new series.
- `tests/test_consumption_forecast_builder.py` and `tests/test_battery_actual_history_builder.py` — only if needed to expose helpers used by the inspector.

---

## Task 1: Add `HelmanHouseConsumptionForecastCurrentSensor`

**Files:**
- Modify: `custom_components/helman/sensor.py` (add class after `HelmanSolarForecastRemainingSensor`)
- Modify: `custom_components/helman/sensor.py::async_setup_entry` (register instance)

- [ ] **Step 1: Add the sensor class**

Append the following class after `HelmanSolarForecastRemainingSensor`:

```python
class HelmanHouseConsumptionForecastCurrentSensor(SensorEntity):
    """Publishes the forecasted house consumption for the *current* 15-min slot.

    The state value is the slot's energy expressed in Wh-per-hour (i.e. W).
    A slot forecast of 250 Wh is published as `1000` because 250 Wh / 0.25 h = 1000 Wh/h.
    Reading the recorder history of this entity over a past day yields a stair-step
    series of past forecast values, one step per slot.
    """

    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.POWER
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "W"
    _attr_has_entity_name = True

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        self._coordinator = coordinator
        self.entity_id = "sensor.helman_house_consumption_forecast_current"
        self._attr_unique_id = f"{entry.entry_id}_house_consumption_forecast_current"
        self._attr_translation_key = "house_consumption_forecast_current"

    @property
    def available(self) -> bool:
        return self._coordinator.get_house_consumption_forecast_current_w() is not None

    @property
    def native_value(self) -> float | None:
        value = self._coordinator.get_house_consumption_forecast_current_w()
        if value is None:
            return None
        return round(value, 1)
```

- [ ] **Step 2: Register the sensor in `async_setup_entry`**

In `async_setup_entry`, after the solar forecast sensors are added, append:

```python
house_consumption_forecast_current_sensor = HelmanHouseConsumptionForecastCurrentSensor(
    coordinator, entry,
)
async_add_entities([house_consumption_forecast_current_sensor])
coordinator.register_house_consumption_forecast_current_sensor(
    house_consumption_forecast_current_sensor,
)
```

(Exact API for registering the sensor with the coordinator is finalized in Task 2.)

- [ ] **Step 3: Commit**

```bash
git add custom_components/helman/sensor.py
git commit -m "feat(sensor): add helman house consumption forecast current sensor"
```

---

## Task 2: Coordinator exposes current-slot house forecast and pushes to sensor

**Files:**
- Modify: `custom_components/helman/coordinator.py` — add `register_house_consumption_forecast_current_sensor`, `get_house_consumption_forecast_current_w`, and call sensor `async_write_ha_state` on each cycle.

- [ ] **Step 1: Add registration + accessor**

Add to the coordinator class (placement near existing forecast accessors like `get_solar_forecast_day_total`):

```python
def register_house_consumption_forecast_current_sensor(self, sensor) -> None:
    self._house_consumption_forecast_current_sensor = sensor

def get_house_consumption_forecast_current_w(self) -> float | None:
    """Return the current 15-min slot house forecast as W (slot Wh / 0.25 h).

    Returns None if no house forecast is available.
    """
    forecast = self._cached_forecast  # canonical house forecast dict
    if not isinstance(forecast, dict):
        return None
    series = forecast.get("series") or []
    if not series:
        return None
    now_local = dt_util.as_local(dt_util.now())
    for entry in series:
        timestamp = _parse_timestamp(entry.get("timestamp"))
        if timestamp is None:
            continue
        slot_start = dt_util.as_local(timestamp)
        slot_end = slot_start + timedelta(minutes=15)
        if slot_start <= now_local < slot_end:
            slot_wh = entry.get("wh")
            if slot_wh is None:
                return None
            return float(slot_wh) / 0.25  # Wh per hour = W
    return None
```

(Note: `_parse_timestamp` already exists in this module for solar; reuse or import as needed. If `_cached_forecast` is not the right canonical-house-forecast source, locate the existing access used by `result["house_consumption"] = build_house_forecast_response(...)` in `coordinator.py:938` and reuse that source.)

- [ ] **Step 2: Init the sensor handle in `__init__`**

In coordinator `__init__`, add:

```python
self._house_consumption_forecast_current_sensor = None
```

- [ ] **Step 3: Push value on each cycle**

Where the coordinator finishes building each cycle's payload (where solar forecast sensors are notified), add:

```python
if self._house_consumption_forecast_current_sensor is not None:
    self._house_consumption_forecast_current_sensor.async_write_ha_state()
```

(If solar forecast sensors are not currently explicitly notified — they rely on `available` + state being recomputed on read — this still triggers a state update via the `available`/`native_value` properties. Confirm by grepping for `async_write_ha_state` near `forecast_sensors` handling.)

- [ ] **Step 4: Test the accessor manually**

Run:

```bash
pytest tests/test_consumption_forecast_builder.py -q
```

Expected: still passes (no behavioural change to builder).

- [ ] **Step 5: Commit**

```bash
git add custom_components/helman/coordinator.py
git commit -m "feat(coordinator): expose current-slot house forecast W and wire to sensor"
```

---

## Task 3: Bucketing helper `load_house_forecast_points_for_day`

**Files:**
- Create: `custom_components/helman/solar_bias_correction/house_forecast_history.py`
- Create: `tests/test_house_forecast_history.py`

- [ ] **Step 1: Write the failing test**

`tests/test_house_forecast_history.py`:

```python
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from custom_components.helman.solar_bias_correction.house_forecast_history import (
    load_house_forecast_points_for_day,
)

LOCAL_TZ = timezone(timedelta(hours=2))


def _state(value: float, ts_iso: str):
    return SimpleNamespace(state=str(value), last_changed=datetime.fromisoformat(ts_iso))


@pytest.mark.asyncio
async def test_buckets_state_changes_into_15min_slots(monkeypatch):
    target = date(2026, 5, 10)
    # Two state values spanning the day: 800 W from 00:00 to 12:00, then 1200 W
    states = [
        _state(800, "2026-05-10T00:00:00+02:00"),
        _state(1200, "2026-05-10T12:00:00+02:00"),
    ]
    fake_get_states = AsyncMock(return_value={
        "sensor.helman_house_consumption_forecast_current": states,
    })
    monkeypatch.setattr(
        "custom_components.helman.solar_bias_correction.house_forecast_history.get_significant_states",
        fake_get_states,
    )
    hass = SimpleNamespace(config=SimpleNamespace(time_zone="Europe/Prague"))
    points = await load_house_forecast_points_for_day(hass, target)
    assert len(points) == 96
    # First slot: 800 W → 800 / 4 = 200 Wh
    assert points[0]["timestamp"].endswith("00:00:00")
    assert pytest.approx(points[0]["wh"], rel=1e-3) == 200.0
    # Slot at 12:00 onward: 1200 W → 300 Wh
    noon = next(p for p in points if p["timestamp"].endswith("12:00:00"))
    assert pytest.approx(noon["wh"], rel=1e-3) == 300.0


@pytest.mark.asyncio
async def test_returns_empty_when_no_states(monkeypatch):
    target = date(2026, 5, 9)
    fake_get_states = AsyncMock(return_value={})
    monkeypatch.setattr(
        "custom_components.helman.solar_bias_correction.house_forecast_history.get_significant_states",
        fake_get_states,
    )
    hass = SimpleNamespace(config=SimpleNamespace(time_zone="Europe/Prague"))
    points = await load_house_forecast_points_for_day(hass, target)
    assert points == []
```

- [ ] **Step 2: Run and confirm it fails**

```bash
pytest tests/test_house_forecast_history.py -q
```

Expected: ImportError or collection failure (module doesn't exist).

- [ ] **Step 3: Implement `house_forecast_history.py`**

Create `custom_components/helman/solar_bias_correction/house_forecast_history.py`:

```python
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

try:
    from homeassistant.components.recorder.history import get_significant_states
except Exception:  # pragma: no cover
    get_significant_states = None  # type: ignore[assignment]

HOUSE_FORECAST_CURRENT_ENTITY = "sensor.helman_house_consumption_forecast_current"
_SLOT_MINUTES = 15
_SLOTS_PER_DAY = 24 * 60 // _SLOT_MINUTES  # 96
_SLOT_FRACTION_OF_HOUR = _SLOT_MINUTES / 60  # 0.25


async def load_house_forecast_points_for_day(
    hass: HomeAssistant,
    target_date: date,
) -> list[dict[str, Any]]:
    """Return per-15min house forecast slot points for target_date.

    Reads the recorder history of the house forecast sensor (W = Wh/h) and
    holds-forward each value across the slot it covers, then converts the
    W value into the slot's Wh (W * 0.25 h).

    Returns a list of {"timestamp": ISO local time, "wh": float}.
    Empty list if no recorder data for the day.
    """
    if get_significant_states is None:
        return []
    local_tz = ZoneInfo(str(hass.config.time_zone))
    day_start_local = datetime.combine(target_date, time(0, 0), tzinfo=local_tz)
    day_end_local = day_start_local + timedelta(days=1)
    start_utc = dt_util.as_utc(day_start_local)
    end_utc = dt_util.as_utc(day_end_local)

    states_by_entity = await get_significant_states(
        hass,
        start_utc,
        end_utc,
        [HOUSE_FORECAST_CURRENT_ENTITY],
        significant_changes_only=False,
    )
    states = states_by_entity.get(HOUSE_FORECAST_CURRENT_ENTITY) or []
    if not states:
        return []

    # Build a list of (instant_local, value_w) pairs.
    timeline: list[tuple[datetime, float]] = []
    for state in states:
        raw = getattr(state, "state", None)
        try:
            value_w = float(raw)
        except (TypeError, ValueError):
            continue
        ts = getattr(state, "last_changed", None) or getattr(state, "last_updated", None)
        if ts is None:
            continue
        timeline.append((dt_util.as_local(ts), value_w))
    if not timeline:
        return []
    timeline.sort(key=lambda pair: pair[0])

    points: list[dict[str, Any]] = []
    cursor = 0
    current_value: float | None = None
    for slot_index in range(_SLOTS_PER_DAY):
        slot_start = day_start_local + timedelta(minutes=slot_index * _SLOT_MINUTES)
        slot_end = slot_start + timedelta(minutes=_SLOT_MINUTES)
        # advance cursor while next change is <= slot_start
        while cursor < len(timeline) and timeline[cursor][0] <= slot_start:
            current_value = timeline[cursor][1]
            cursor += 1
        if current_value is None:
            continue
        slot_wh = current_value * _SLOT_FRACTION_OF_HOUR
        points.append(
            {
                "timestamp": slot_start.isoformat(),
                "wh": slot_wh,
            }
        )
    return points
```

- [ ] **Step 4: Run the tests**

```bash
pytest tests/test_house_forecast_history.py -q
```

Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add custom_components/helman/solar_bias_correction/house_forecast_history.py tests/test_house_forecast_history.py
git commit -m "feat(solar_bias): add house forecast history loader"
```

---

## Task 4: Extend inspector dataclasses with house + battery fields

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/models.py`

- [ ] **Step 1: Add `BatterySocPoint` and extend `SolarBiasInspectorSeries`, `SolarBiasInspectorTotals`, `SolarBiasInspectorAvailability`**

Add after `SolarBiasImpactPoint`:

```python
@dataclass
class BatterySocPoint:
    slot: str  # "HH:MM"
    pct: float
```

Modify `SolarBiasInspectorSeries`:

```python
@dataclass
class SolarBiasInspectorSeries:
    raw: list[SolarBiasInspectorPoint]
    corrected: list[SolarBiasInspectorPoint]
    actual: list[SolarBiasInspectorPoint]
    factors: list[SolarBiasFactorPoint]
    invalidated: list[SolarBiasInspectorPoint] = field(default_factory=list)
    impact: list[SolarBiasImpactPoint] = field(default_factory=list)
    house_forecast: list[SolarBiasInspectorPoint] = field(default_factory=list)
    house_actual: list[SolarBiasInspectorPoint] = field(default_factory=list)
    battery_soc_forecast: list[BatterySocPoint] = field(default_factory=list)
    battery_soc_actual: list[BatterySocPoint] = field(default_factory=list)
```

Modify `SolarBiasInspectorTotals`:

```python
@dataclass
class SolarBiasInspectorTotals:
    raw_wh: float | None
    corrected_wh: float | None
    actual_wh: float | None
    house_forecast_wh: float | None = None
    house_actual_wh: float | None = None
```

Modify `SolarBiasInspectorAvailability`:

```python
@dataclass
class SolarBiasInspectorAvailability:
    has_raw_forecast: bool
    has_corrected_forecast: bool
    has_actuals: bool
    has_profile: bool
    has_invalidated: bool = False
    has_house_forecast: bool = False
    has_house_actual: bool = False
    has_battery_soc_forecast: bool = False
    has_battery_soc_actual: bool = False
```

- [ ] **Step 2: Extend `inspector_day_to_payload`**

In `inspector_day_to_payload` (`models.py:198`), add to the `series` dict:

```python
"houseForecast": [_inspector_point_payload(p) for p in day.series.house_forecast],
"houseActual": [_inspector_point_payload(p) for p in day.series.house_actual],
"batterySocForecast": [
    {"slot": p.slot, "pct": p.pct} for p in day.series.battery_soc_forecast
],
"batterySocActual": [
    {"slot": p.slot, "pct": p.pct} for p in day.series.battery_soc_actual
],
```

Extend `totals` dict:

```python
"houseForecastWh": day.totals.house_forecast_wh,
"houseActualWh": day.totals.house_actual_wh,
```

Extend `availability` dict:

```python
"hasHouseForecast": day.availability.has_house_forecast,
"hasHouseActual": day.availability.has_house_actual,
"hasBatterySocForecast": day.availability.has_battery_soc_forecast,
"hasBatterySocActual": day.availability.has_battery_soc_actual,
```

- [ ] **Step 3: Verify existing solar bias tests still pass**

```bash
pytest tests/test_solar_bias_response.py tests/test_point_forecast_response.py -q
```

Expected: pass (new fields have defaults).

- [ ] **Step 4: Commit**

```bash
git add custom_components/helman/solar_bias_correction/models.py
git commit -m "feat(solar_bias): extend inspector models with house + battery SoC series"
```

---

## Task 5: Service populates new series

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/service.py::async_get_inspector_day`

- [ ] **Step 1: Add imports at top of file**

```python
from .house_forecast_history import load_house_forecast_points_for_day
from ..battery_actual_history_builder import build_battery_actual_history
from ..consumption_forecast_builder import ConsumptionForecastBuilder  # if not already
```

- [ ] **Step 2: After existing series assembly in `async_get_inspector_day`, gather new data**

Insert after `actuals_by_slot` / `actual_points` are computed and before the `SolarBiasInspectorDay(...)` construction:

```python
# --- House forecast (per 15-min slot, Wh) ---
house_forecast_points = await load_house_forecast_points_for_day(
    self._hass, target_date,
)

# --- House actual (per 15-min slot, Wh) ---
# Reuse the consumption forecast builder's per-slot actual history.
# ConsumptionForecastBuilder._build_slot_actual_history is private today;
# expose a thin public wrapper (Task 5b) or call via builder instance.
house_actual_points: list[dict[str, Any]] = []
try:
    builder = ConsumptionForecastBuilder(self._hass, self._raw_config_dict())
    house_actual_points = await builder.async_load_actual_slot_history(
        target_date,
        local_now=local_now,
        interval_minutes=15,
    )
except Exception:  # pragma: no cover - log and continue
    _LOGGER.exception("Failed to load house actual history for inspector")

# --- Battery SoC actual (per 15-min slot, %) ---
battery_soc_actual_points: list[dict[str, Any]] = []
try:
    battery_actual = await build_battery_actual_history(
        self._hass,
        battery_soc_entity_id=self._cfg.battery_soc_entity_id,  # adjust to actual config field
        target_date=target_date,
        interval_minutes=15,
    )
    battery_soc_actual_points = battery_actual
except Exception:  # pragma: no cover
    _LOGGER.exception("Failed to load battery actual history for inspector")

# --- Battery SoC forecast (future slots only, today/future dates) ---
battery_soc_forecast_points: list[dict[str, Any]] = []
if target_date >= today:
    battery_snapshot = self._coordinator_battery_forecast_snapshot()
    battery_soc_forecast_points = _filter_battery_soc_future(
        battery_snapshot,
        target_date=target_date,
        local_now=local_now,
        timezone=timezone,
    )
```

- [ ] **Step 3: Convert these into dataclass instances**

```python
def _inspector_points_from_raw(raw):
    return [
        SolarBiasInspectorPoint(timestamp=p["timestamp"], value_wh=float(p["wh"]))
        for p in raw
    ]


def _battery_soc_points_from_raw(raw):
    return [
        BatterySocPoint(slot=p["slot"], pct=float(p["pct"]))
        for p in raw
    ]
```

(Place these as private module helpers near other `_inspector_points`-style helpers.)

In the `SolarBiasInspectorSeries(...)` constructor block, pass:

```python
house_forecast=_inspector_points_from_raw(house_forecast_points),
house_actual=_inspector_points_from_raw(house_actual_points),
battery_soc_forecast=_battery_soc_points_from_raw(battery_soc_forecast_points),
battery_soc_actual=_battery_soc_points_from_raw(battery_soc_actual_points),
```

In `SolarBiasInspectorTotals(...)`, add:

```python
house_forecast_wh=sum(p["wh"] for p in house_forecast_points) if house_forecast_points else None,
house_actual_wh=sum(p["wh"] for p in house_actual_points) if house_actual_points else None,
```

In `SolarBiasInspectorAvailability(...)`, add:

```python
has_house_forecast=bool(house_forecast_points),
has_house_actual=bool(house_actual_points),
has_battery_soc_forecast=bool(battery_soc_forecast_points),
has_battery_soc_actual=bool(battery_soc_actual_points),
```

- [ ] **Step 4: Add `_filter_battery_soc_future` helper**

In `service.py` (module level, near other `_filter_*` helpers):

```python
def _filter_battery_soc_future(
    snapshot: dict[str, Any] | None,
    *,
    target_date: date,
    local_now: datetime,
    timezone: ZoneInfo,
) -> list[dict[str, Any]]:
    if not isinstance(snapshot, dict):
        return []
    series = snapshot.get("series") or []
    points: list[dict[str, Any]] = []
    now_local = dt_util.as_local(local_now)
    for entry in series:
        ts_raw = entry.get("timestamp")
        if ts_raw is None:
            continue
        try:
            ts = datetime.fromisoformat(ts_raw)
        except ValueError:
            continue
        ts_local = ts.astimezone(timezone) if ts.tzinfo else ts.replace(tzinfo=timezone)
        if ts_local.date() != target_date:
            continue
        if ts_local < now_local:
            continue
        pct = entry.get("socPercent") or entry.get("soc_pct") or entry.get("pct")
        if pct is None:
            continue
        slot = f"{ts_local.hour:02d}:{ts_local.minute:02d}"
        points.append({"slot": slot, "pct": float(pct)})
    return points
```

(Verify the actual battery forecast snapshot field name — check `battery_forecast_response.py::build_battery_forecast_response` output structure. Adapt the `pct` key accordingly.)

- [ ] **Step 5: Add `_coordinator_battery_forecast_snapshot` accessor**

If the bias service doesn't already hold a reference to the coordinator, plumb it through. The cleanest path is to accept a callable in `SolarBiasService.__init__` that returns the current battery forecast snapshot. Add:

```python
def __init__(self, ..., battery_forecast_provider=None, ...):
    ...
    self._battery_forecast_provider = battery_forecast_provider

def _coordinator_battery_forecast_snapshot(self) -> dict[str, Any] | None:
    if self._battery_forecast_provider is None:
        return None
    try:
        return self._battery_forecast_provider()
    except Exception:  # pragma: no cover
        _LOGGER.exception("Battery forecast provider failed")
        return None
```

Then wire it in the integration setup (`__init__.py` for the SBC submodule) to pass `lambda: coordinator.current_battery_forecast_snapshot()`. Implementor: locate where `SolarBiasService` is constructed and where the canonical battery forecast is stored on the coordinator (search for `build_battery_forecast_response`).

- [ ] **Step 6: Expose `async_load_actual_slot_history` on `ConsumptionForecastBuilder`**

In `consumption_forecast_builder.py`, add a public async method:

```python
async def async_load_actual_slot_history(
    self,
    target_date: date,
    *,
    local_now: datetime,
    interval_minutes: int = 15,
) -> list[dict[str, Any]]:
    """Return per-slot actual house consumption for target_date as
    [{"timestamp": iso_local, "wh": float}, ...]."""
    # Reuse the private slot-actual builder. If the existing private method
    # builds for "today" only, generalize it to accept target_date.
    rows = await self._build_slot_actual_history(  # adjust to existing signature
        target_date=target_date,
        local_now=local_now,
        interval_minutes=interval_minutes,
    )
    return rows
```

If `_build_slot_actual_history` is not generalizable, wrap `_query_slot_history` directly here.

- [ ] **Step 7: Run the full solar bias service test suite**

```bash
pytest tests/test_solar_bias_service_runtime.py tests/test_solar_bias_response.py -q
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add custom_components/helman/solar_bias_correction/service.py \
        custom_components/helman/consumption_forecast_builder.py
git commit -m "feat(solar_bias): inspector payload includes house and battery SoC series"
```

---

## Task 6: Integration test — full inspector payload

**Files:**
- Create: `tests/test_inspector_house_battery_payload.py`

- [ ] **Step 1: Write the test**

```python
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_inspector_payload_includes_house_and_battery_fields():
    """async_get_inspector_day produces all new fields with mocked sources."""
    # Pseudocode-shaped test — flesh out using the conventions in
    # tests/test_solar_bias_service_runtime.py for constructing a fake hass +
    # SolarBiasService.
    from custom_components.helman.solar_bias_correction.service import (
        SolarBiasService,
    )
    target = "2026-05-10"

    house_fc_points = [{"timestamp": f"{target}T00:00:00+02:00", "wh": 200.0}]
    house_actual_points = [{"timestamp": f"{target}T00:00:00+02:00", "wh": 180.0}]
    battery_actual = [{"slot": "00:00", "pct": 88.0}]
    battery_snapshot = {
        "series": [
            {"timestamp": f"{target}T18:00:00+02:00", "socPercent": 65.0},
        ],
    }

    with patch(
        "custom_components.helman.solar_bias_correction.service.load_house_forecast_points_for_day",
        AsyncMock(return_value=house_fc_points),
    ), patch(
        "custom_components.helman.solar_bias_correction.service.build_battery_actual_history",
        AsyncMock(return_value=battery_actual),
    ):
        # Build the service with stubbed dependencies. See
        # tests/test_solar_bias_service_runtime.py for the existing pattern.
        service = _build_service_with_mocks(
            house_actual_points=house_actual_points,
            battery_snapshot=battery_snapshot,
        )
        payload = await service.async_get_inspector_day(target)

    assert payload["series"]["houseForecast"][0]["wh"] == 200.0
    assert payload["series"]["houseActual"][0]["wh"] == 180.0
    assert payload["series"]["batterySocActual"][0] == {"slot": "00:00", "pct": 88.0}
    assert payload["series"]["batterySocForecast"][0]["slot"] == "18:00"
    assert payload["availability"]["hasHouseForecast"] is True
    assert payload["availability"]["hasBatterySocForecast"] is True
    assert payload["totals"]["houseForecastWh"] == 200.0
    assert payload["totals"]["houseActualWh"] == 180.0


def _build_service_with_mocks(*, house_actual_points, battery_snapshot):
    """Construct a SolarBiasService using the same conventions as
    tests/test_solar_bias_service_runtime.py. Implementor: copy the setup
    fixture from there and inject the consumption builder + battery provider mocks."""
    raise NotImplementedError("populate using existing test fixture conventions")
```

- [ ] **Step 2: Flesh out `_build_service_with_mocks` using the existing test fixture**

Open `tests/test_solar_bias_service_runtime.py`, copy the `_build_service` (or equivalent) helper into this file, and extend it to inject:

- `ConsumptionForecastBuilder` mock whose `async_load_actual_slot_history` returns `house_actual_points`
- `battery_forecast_provider` callable returning `battery_snapshot`

- [ ] **Step 3: Run**

```bash
pytest tests/test_inspector_house_battery_payload.py -q
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add tests/test_inspector_house_battery_payload.py
git commit -m "test(solar_bias): inspector payload integration test for house and battery"
```

---

## Task 7: README note about recorder retention

**Files:**
- Modify: `README.md` (or `docs/` index)

- [ ] **Step 1: Add a short note**

Add a section to the README:

```markdown
### Inspector history retention

The full day inspector reconstructs past-day house consumption forecast from
the recorder history of `sensor.helman_house_consumption_forecast_current`.
Home Assistant's default recorder retention is 10 days. If you want past-day
inspection beyond that window, increase `purge_keep_days` in your `recorder:`
config.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: note recorder retention for inspector history"
```

---

## Self-review checklist

- [ ] Every new dataclass field is serialized in `inspector_day_to_payload`.
- [ ] FE plan field names match exactly: `houseForecast`, `houseActual`, `batterySocForecast`, `batterySocActual`, `houseForecastWh`, `houseActualWh`, `hasHouseForecast`, `hasHouseActual`, `hasBatterySocForecast`, `hasBatterySocActual`.
- [ ] Battery SoC forecast is only emitted for `target_date >= today` and only for slots `>= local_now`.
- [ ] Recorder retention caveat documented.
