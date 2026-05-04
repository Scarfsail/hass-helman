# Solar Forecast Cache And Entities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted cached solar forecast snapshot that refreshes on the existing 15-minute coordinator path and expose `helman_energy_production_*` forecast summary sensors derived from that shared cache.

**Architecture:** Move solar forecast rebuilding out of `HelmanCoordinator.get_forecast()` and into the existing coordinator refresh pipeline so scheduled refresh, cache-miss recovery, websocket/API responses, and new entities all use one cached snapshot. Persist the canonical solar snapshot in `HelmanStorage`, then add sensor entities that aggregate local-day totals and `today_remaining` from the corrected forecast points, falling back to raw points only when corrected points are absent.

**Tech Stack:** Home Assistant custom component (`sensor` platform, HA storage helpers, HA datetime utilities), Python `unittest`/`pytest`-style isolated tests already used in this repo, existing Helman forecast response helpers.

---

## File map

- Modify: `custom_components/helman/storage.py`
  Add persisted solar snapshot load/save support alongside the existing house forecast snapshot.
- Modify: `custom_components/helman/coordinator.py`
  Add `_cached_solar_forecast`, shared refresh helpers, cache freshness checks, refresh-time solar snapshot rebuild, and cached-read `get_forecast()` behavior.
- Modify: `custom_components/helman/sensor.py`
  Register the new forecast summary entities and add local-day aggregation helpers.
- Modify: `tests/test_init_recovery.py`
  Extend startup/reload coverage so storage-backed setup continues to work once solar snapshot persistence is added.
- Modify: `tests/test_energy_platform.py`
  Keep Energy dashboard behavior covered as a regression against the refactored cached forecast path.
- Modify: `tests/test_solar_bias_response.py`
  Add focused response-shaping coverage if the cached canonical snapshot needs explicit corrected/raw fallback assertions.
- Create: `tests/test_solar_forecast_cache.py`
  Focused coordinator/storage tests for refresh-time solar snapshot caching and cache-miss fallback through the shared refresh path.
- Create: `tests/test_sensor_forecast_entities.py`
  Focused tests for `helman_energy_production_*` entity values, availability, and local-day aggregation semantics.

### Task 1: Persist and refresh the canonical solar snapshot

**Files:**
- Modify: `custom_components/helman/storage.py`
- Modify: `custom_components/helman/coordinator.py`
- Modify: `custom_components/helman/const.py`
- Test: `tests/test_solar_forecast_cache.py`
- Test: `tests/test_init_recovery.py`

- [ ] **Step 1: Write the failing storage/coordinator cache tests**

```python
class SolarForecastCacheTests(unittest.IsolatedAsyncioTestCase):
    async def test_refresh_forecast_persists_canonical_solar_snapshot(self) -> None:
        coordinator = self._build_coordinator()
        coordinator._async_build_canonical_solar_forecast = AsyncMock(
            return_value={
                "status": "available",
                "resolution": "15m",
                "horizonHours": 336,
                "points": [{"timestamp": "2026-05-03T10:00:00+02:00", "value": 1200.0}],
                "rawPoints": [{"timestamp": "2026-05-03T10:00:00+02:00", "value": 1500.0}],
                "generatedAt": "2026-05-03T09:45:00+02:00",
            }
        )

        await coordinator._async_refresh_forecast(reference_time=REFERENCE_TIME)

        self.assertEqual(
            coordinator._cached_solar_forecast["points"][0]["value"],
            1200.0,
        )
        self.assertEqual(
            coordinator._storage.saved_solar_snapshot["rawPoints"][0]["value"],
            1500.0,
        )

    async def test_get_forecast_uses_shared_refresh_path_when_solar_cache_missing(self) -> None:
        coordinator = self._build_coordinator()
        coordinator._cached_solar_forecast = None
        coordinator._async_refresh_forecast_and_request_automation = AsyncMock(
            side_effect=self._populate_solar_cache
        )

        await coordinator.get_forecast(granularity=60, forecast_days=7)

        coordinator._async_refresh_forecast_and_request_automation.assert_awaited_once()
```

- [ ] **Step 2: Run the focused cache tests to verify they fail**

Run: `pytest tests/test_solar_forecast_cache.py -q`

Expected: FAIL with missing `_cached_solar_forecast`, missing solar snapshot persistence, or `get_forecast()` still building solar forecast directly.

- [ ] **Step 3: Add storage support for the solar snapshot**

```python
class HelmanStorage:
    def __init__(self, hass: HomeAssistant) -> None:
        self._snapshot_store = storage.Store(
            hass, FORECAST_SNAPSHOT_STORAGE_VERSION, FORECAST_SNAPSHOT_STORAGE_KEY
        )
        self._snapshot: dict[str, Any] | None = None
        self._solar_snapshot: dict[str, Any] | None = None

    async def async_load(self) -> None:
        self._snapshot = await self._snapshot_store.async_load()
        if isinstance(self._snapshot, dict) and "house" in self._snapshot:
            self._solar_snapshot = self._snapshot.get("solar")
            self._snapshot = self._snapshot.get("house")
        else:
            self._solar_snapshot = None

    @property
    def solar_forecast_snapshot(self) -> dict[str, Any] | None:
        return self._solar_snapshot

    async def async_save_snapshots(
        self,
        *,
        house_snapshot: dict[str, Any],
        solar_snapshot: dict[str, Any] | None,
    ) -> None:
        self._snapshot = house_snapshot
        self._solar_snapshot = solar_snapshot
        await self._snapshot_store.async_save(
            {"house": house_snapshot, "solar": solar_snapshot}
        )
```

- [ ] **Step 4: Extend the coordinator refresh pipeline to build and cache solar data**

```python
class HelmanCoordinator:
    def __init__(self, hass: HomeAssistant, storage: HelmanStorage) -> None:
        self._cached_forecast: dict | None = None
        self._cached_solar_forecast: dict | None = None

    async def _async_build_canonical_solar_forecast(
        self,
        *,
        reference_time: datetime,
    ) -> dict[str, Any]:
        builder = HelmanForecastBuilder(self._hass, self._active_config)
        raw_result = await builder.build(reference_time=reference_time)
        canonical_raw = build_solar_forecast_response(
            raw_result["solar"],
            granularity=FORECAST_CANONICAL_GRANULARITY_MINUTES,
            forecast_days=MAX_FORECAST_DAYS,
        )
        bias_result = self._solar_bias_service.build_adjustment_result(
            canonical_raw.get("points", []),
            reference_time,
        ) if self._solar_bias_service is not None else None
        corrected_points = (
            bias_result.adjusted_points if bias_result is not None else canonical_raw.get("points", [])
        )
        snapshot = deepcopy(canonical_raw)
        snapshot["rawPoints"] = deepcopy(canonical_raw.get("points", []))
        snapshot["points"] = corrected_points
        snapshot["generatedAt"] = reference_time.isoformat()
        return snapshot

    async def _async_refresh_forecast(
        self, reference_time: datetime | None = None
    ) -> _ForecastRefreshResult:
        request_now = reference_time or dt_util.now()
        house_snapshot = await builder.build(...)
        solar_snapshot = await self._async_build_canonical_solar_forecast(
            reference_time=request_now
        )
        self._cached_forecast = house_snapshot
        self._cached_solar_forecast = solar_snapshot
        await self._storage.async_save_snapshots(
            house_snapshot=house_snapshot,
            solar_snapshot=solar_snapshot,
        )
```

- [ ] **Step 5: Load the persisted solar snapshot during setup**

```python
async def async_setup(self) -> None:
    self._cached_forecast = self._storage.forecast_snapshot
    self._cached_solar_forecast = self._storage.solar_forecast_snapshot
    if not self._has_current_slot_solar_forecast(
        self._cached_solar_forecast,
        reference_time=dt_util.now(),
    ):
        self._cached_solar_forecast = None
```

- [ ] **Step 6: Run the focused cache and init tests to verify they pass**

Run: `pytest tests/test_solar_forecast_cache.py tests/test_init_recovery.py -q`

Expected: PASS with solar snapshot persistence covered and startup still loading storage cleanly.

- [ ] **Step 7: Commit the refresh/cache slice**

```bash
git add custom_components/helman/const.py custom_components/helman/storage.py custom_components/helman/coordinator.py tests/test_solar_forecast_cache.py tests/test_init_recovery.py
git commit -m "feat: cache solar forecast snapshots"
```

### Task 2: Make `get_forecast()` a cached read path

**Files:**
- Modify: `custom_components/helman/coordinator.py`
- Modify: `custom_components/helman/point_forecast_response.py`
- Modify: `tests/test_energy_platform.py`
- Modify: `tests/test_solar_bias_response.py`
- Test: `tests/test_solar_forecast_cache.py`

- [ ] **Step 1: Write the failing cached-read response tests**

```python
async def test_get_forecast_uses_cached_corrected_points_without_rebuilding(self) -> None:
    coordinator = self._build_coordinator()
    coordinator._cached_solar_forecast = {
        "status": "available",
        "resolution": "15m",
        "horizonHours": 336,
        "points": [{"timestamp": "2026-05-03T10:00:00+02:00", "value": 900.5}],
        "rawPoints": [{"timestamp": "2026-05-03T10:00:00+02:00", "value": 1250.25}],
    }
    helman_builder = self.forecast_builder_mod.HelmanForecastBuilder
    helman_builder.build = AsyncMock(side_effect=AssertionError("should not rebuild"))

    result = await coordinator.get_forecast(granularity=60, forecast_days=7)

    self.assertEqual(result["solar"]["points"][0]["value"], 900.5)

async def test_get_forecast_falls_back_to_raw_points_when_corrected_missing(self) -> None:
    coordinator = self._build_coordinator()
    coordinator._cached_solar_forecast = {
        "status": "available",
        "resolution": "15m",
        "horizonHours": 336,
        "points": [],
        "rawPoints": [{"timestamp": "2026-05-03T10:00:00+02:00", "value": 1250.25}],
    }

    result = await coordinator.get_forecast(granularity=60, forecast_days=7)

    self.assertEqual(result["solar"]["points"][0]["value"], 1250.25)
```

- [ ] **Step 2: Run the focused response tests to verify they fail**

Run: `pytest tests/test_solar_forecast_cache.py tests/test_energy_platform.py -q`

Expected: FAIL because `get_forecast()` still constructs `HelmanForecastBuilder` directly and ignores cached solar snapshots.

- [ ] **Step 3: Add a cached solar snapshot accessor in the coordinator**

```python
async def _async_get_canonical_solar_forecast(
    self,
    *,
    reference_time: datetime,
) -> dict[str, Any] | None:
    if self._has_current_slot_solar_forecast(
        self._cached_solar_forecast,
        reference_time=reference_time,
    ):
        return self._cached_solar_forecast

    await self._async_refresh_forecast_and_request_automation(
        reason="request_refresh",
        reference_time=reference_time,
    )
    if self._has_current_slot_solar_forecast(
        self._cached_solar_forecast,
        reference_time=reference_time,
    ):
        return self._cached_solar_forecast
    return None
```

- [ ] **Step 4: Refactor `get_forecast()` to shape solar data from cache**

```python
async def get_forecast(
    self,
    *,
    granularity: int = DEFAULT_FORECAST_GRANULARITY_MINUTES,
    forecast_days: int = DEFAULT_FORECAST_DAYS,
) -> dict:
    ensure_supported_forecast_request(
        granularity=granularity,
        forecast_days=forecast_days,
    )
    request_now = dt_util.now()
    canonical_solar_forecast = await self._async_get_canonical_solar_forecast(
        reference_time=request_now
    )
    if canonical_solar_forecast is None:
        canonical_solar_forecast = {"status": "unavailable", "points": [], "rawPoints": []}

    effective_solar_forecast = deepcopy(canonical_solar_forecast)
    if not effective_solar_forecast.get("points"):
        effective_solar_forecast["points"] = deepcopy(
            canonical_solar_forecast.get("rawPoints", [])
        )

    result = {
        "solar": build_solar_forecast_response(
            effective_solar_forecast,
            granularity=granularity,
            forecast_days=forecast_days,
        )
    }
```

- [ ] **Step 5: Keep the solar response helper compatible with cached raw fallback**

```python
def build_solar_forecast_response(
    snapshot: dict[str, Any],
    *,
    granularity: int,
    forecast_days: int,
) -> dict[str, Any]:
    normalized_snapshot = deepcopy(snapshot)
    if not normalized_snapshot.get("points") and normalized_snapshot.get("rawPoints"):
        normalized_snapshot["points"] = deepcopy(normalized_snapshot["rawPoints"])
    return _build_point_forecast_response(
        normalized_snapshot,
        granularity=granularity,
        forecast_days=forecast_days,
        aggregation_mode="sum",
        include_actual_history=True,
    )
```

- [ ] **Step 6: Run the focused response regressions**

Run: `pytest tests/test_solar_forecast_cache.py tests/test_energy_platform.py tests/test_solar_bias_response.py -q`

Expected: PASS with cached corrected/raw response shaping and no direct on-demand solar rebuild path left in `get_forecast()`.

- [ ] **Step 7: Commit the cached-read refactor**

```bash
git add custom_components/helman/coordinator.py custom_components/helman/point_forecast_response.py tests/test_solar_forecast_cache.py tests/test_energy_platform.py tests/test_solar_bias_response.py
git commit -m "refactor: serve solar forecast from cached snapshots"
```

### Task 3: Add `helman_energy_production_*` forecast sensors

**Files:**
- Modify: `custom_components/helman/sensor.py`
- Create: `tests/test_sensor_forecast_entities.py`
- Test: `tests/test_solar_forecast_cache.py`

- [ ] **Step 1: Write the failing forecast entity tests**

```python
class ForecastSensorEntityTests(unittest.IsolatedAsyncioTestCase):
    async def test_daily_entities_sum_local_day_buckets(self) -> None:
        entities = await self._setup_forecast_entities(
            [
                {"timestamp": "2026-05-03T08:00:00+02:00", "value": 500.0},
                {"timestamp": "2026-05-03T12:00:00+02:00", "value": 1500.0},
                {"timestamp": "2026-05-04T10:00:00+02:00", "value": 2000.0},
            ],
            now="2026-05-03T09:15:00+02:00",
        )

        self.assertEqual(entities["sensor.helman_energy_production_today"].native_value, 2000.0)
        self.assertEqual(entities["sensor.helman_energy_production_tomorrow"].native_value, 2000.0)

    async def test_today_remaining_excludes_elapsed_points(self) -> None:
        entities = await self._setup_forecast_entities(
            [
                {"timestamp": "2026-05-03T08:00:00+02:00", "value": 500.0},
                {"timestamp": "2026-05-03T09:15:00+02:00", "value": 750.0},
                {"timestamp": "2026-05-03T12:00:00+02:00", "value": 1500.0},
            ],
            now="2026-05-03T09:15:00+02:00",
        )

        self.assertEqual(
            entities["sensor.helman_energy_production_today_remaining"].native_value,
            2250.0,
        )

    async def test_missing_d4_bucket_is_unavailable(self) -> None:
        entities = await self._setup_forecast_entities(
            [{"timestamp": "2026-05-03T12:00:00+02:00", "value": 1500.0}],
            now="2026-05-03T09:15:00+02:00",
        )

        self.assertFalse(entities["sensor.helman_energy_production_d4"].available)
        self.assertIsNone(entities["sensor.helman_energy_production_d4"].native_value)
```

- [ ] **Step 2: Run the entity tests to verify they fail**

Run: `pytest tests/test_sensor_forecast_entities.py -q`

Expected: FAIL because the new entity classes and aggregation helpers do not exist yet.

- [ ] **Step 3: Register the new forecast entities in `async_setup_entry()`**

```python
forecast_entities = [
    HelmanSolarForecastEnergySensor(coordinator, entry, "today", day_offset=0),
    HelmanSolarForecastEnergySensor(coordinator, entry, "tomorrow", day_offset=1),
    HelmanSolarForecastEnergySensor(coordinator, entry, "d2", day_offset=2),
    HelmanSolarForecastEnergySensor(coordinator, entry, "d3", day_offset=3),
    HelmanSolarForecastEnergySensor(coordinator, entry, "d4", day_offset=4),
    HelmanSolarForecastEnergySensor(coordinator, entry, "d5", day_offset=5),
    HelmanSolarForecastEnergySensor(coordinator, entry, "d6", day_offset=6),
    HelmanSolarForecastEnergySensor(coordinator, entry, "d7", day_offset=7),
    HelmanSolarForecastRemainingSensor(coordinator, entry),
]
async_add_entities(
    [battery_time_to_full, battery_time_to_empty]
    + list(unmeasured_sensors.values())
    + [total_power, production_total]
    + list(source_ratio_sensors.values())
    + forecast_entities
)
```

- [ ] **Step 4: Implement local-day aggregation helpers and sensor classes**

```python
class HelmanSolarForecastEnergySensor(SensorEntity):
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.ENERGY
    _attr_native_unit_of_measurement = "Wh"

    def __init__(self, coordinator, entry: ConfigEntry, key: str, *, day_offset: int) -> None:
        self._coordinator = coordinator
        self._day_offset = day_offset
        self.entity_id = f"sensor.helman_energy_production_{key}"
        self._attr_unique_id = f"{entry.entry_id}_energy_production_{key}"
        self._attr_name = f"Helman Energy Production {key.replace('_', ' ').title()}"

    @property
    def available(self) -> bool:
        return self._coordinator.get_solar_forecast_day_total(self._day_offset) is not None

    @property
    def native_value(self) -> float | None:
        return self._coordinator.get_solar_forecast_day_total(self._day_offset)


class HelmanSolarForecastRemainingSensor(SensorEntity):
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.ENERGY
    _attr_native_unit_of_measurement = "Wh"

    @property
    def available(self) -> bool:
        return self._coordinator.get_solar_forecast_today_remaining() is not None

    @property
    def native_value(self) -> float | None:
        return self._coordinator.get_solar_forecast_today_remaining()
```

- [ ] **Step 5: Add coordinator helpers used by the sensors**

```python
def get_effective_solar_forecast_points(self) -> list[dict[str, Any]]:
    snapshot = self._cached_solar_forecast or {}
    points = snapshot.get("points")
    if isinstance(points, list) and points:
        return points
    raw_points = snapshot.get("rawPoints")
    return raw_points if isinstance(raw_points, list) else []

def get_solar_forecast_day_total(self, day_offset: int) -> float | None:
    points = self.get_effective_solar_forecast_points()
    buckets = _bucket_points_by_local_day(points)
    target_day = (dt_util.now().date() + timedelta(days=day_offset)).isoformat()
    values = buckets.get(target_day)
    if not values:
        return None
    return round(sum(values), 4)

def get_solar_forecast_today_remaining(self) -> float | None:
    now = dt_util.now()
    total = 0.0
    found = False
    for point_time, value in _iter_local_solar_points(self.get_effective_solar_forecast_points()):
        if point_time.date() != now.date() or point_time < now:
            continue
        total += value
        found = True
    return round(total, 4) if found else None
```

- [ ] **Step 6: Run the focused sensor tests and the cache regression**

Run: `pytest tests/test_sensor_forecast_entities.py tests/test_solar_forecast_cache.py -q`

Expected: PASS with correct local-day totals, `today_remaining`, and unavailable missing-day semantics.

- [ ] **Step 7: Commit the entity slice**

```bash
git add custom_components/helman/sensor.py custom_components/helman/coordinator.py tests/test_sensor_forecast_entities.py tests/test_solar_forecast_cache.py
git commit -m "feat: expose solar forecast energy sensors"
```

### Task 4: Final verification and cleanup

**Files:**
- Modify: `custom_components/helman/coordinator.py`
- Modify: `custom_components/helman/storage.py`
- Modify: `custom_components/helman/sensor.py`
- Modify: `tests/test_init_recovery.py`
- Modify: `tests/test_energy_platform.py`
- Modify: `tests/test_solar_bias_response.py`
- Create: `tests/test_solar_forecast_cache.py`
- Create: `tests/test_sensor_forecast_entities.py`

- [ ] **Step 1: Run the full targeted verification set**

Run: `pytest tests/test_solar_forecast_cache.py tests/test_sensor_forecast_entities.py tests/test_energy_platform.py tests/test_init_recovery.py tests/test_solar_bias_response.py -q`

Expected: PASS with no direct solar rebuild regression and all new entity semantics covered.

- [ ] **Step 2: Run the broader forecast-related regression set**

Run: `pytest tests/test_forecast_builder_actual_history.py tests/test_solar_bias_forecast_history.py tests/test_energy_platform.py -q`

Expected: PASS, proving the cached solar path did not break forecast history assumptions used elsewhere in the integration.

- [ ] **Step 3: Inspect the final diff for accidental code-path duplication**

Run: `git diff -- custom_components/helman/coordinator.py custom_components/helman/storage.py custom_components/helman/sensor.py`

Expected: only one solar-refresh build path remains, with `get_forecast()` reading from cache and entity aggregation using coordinator helpers rather than rebuilding.

- [ ] **Step 4: Commit the final verified state**

```bash
git add custom_components/helman/coordinator.py custom_components/helman/storage.py custom_components/helman/sensor.py tests/test_init_recovery.py tests/test_energy_platform.py tests/test_solar_bias_response.py tests/test_solar_forecast_cache.py tests/test_sensor_forecast_entities.py
git commit -m "feat: align solar forecast cache and entity exposure"
```

## Self-review

- Spec coverage check:
  - Single shared refresh path: Task 1 and Task 2.
  - Persisted solar snapshot: Task 1.
  - `get_forecast()` cache-miss fallback through the same refresh routine: Task 1 and Task 2.
  - New `helman_energy_production_*` entities: Task 3.
  - Corrected-primary / raw-fallback behavior: Task 2 and Task 3.
  - Unavailable missing-day semantics: Task 3.
  - Verification against existing forecast consumers: Task 4.
- Placeholder scan:
  - No `TODO`/`TBD`.
  - Each code-bearing step shows concrete functions, test names, commands, and commit messages.
- Type consistency:
  - Plan uses `solar_forecast_snapshot`, `_cached_solar_forecast`, `_async_build_canonical_solar_forecast()`, `get_solar_forecast_day_total()`, and `get_solar_forecast_today_remaining()` consistently across tasks.
