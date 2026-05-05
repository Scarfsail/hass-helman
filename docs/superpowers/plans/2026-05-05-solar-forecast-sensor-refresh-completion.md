# Solar Forecast Sensor Refresh Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local Helman `sensor.helman_energy_production_*` entities republish fresh Home Assistant state whenever the canonical solar forecast snapshot refreshes.

**Architecture:** Keep `_cached_solar_forecast` as the single source of truth and close the missing publication path by registering forecast summary entities with `HelmanCoordinator`, then fan out `async_write_ha_state()` calls immediately after `_async_refresh_forecast()` stores the refreshed snapshot. Forecast entities remain stateless projections over coordinator helpers, so the change is limited to coordinator ownership, setup wiring, and regression tests around refresh-triggered publication and unavailability.

**Tech Stack:** Home Assistant custom component sensors, `HelmanCoordinator`, Python `unittest`/`AsyncMock` tests, existing solar forecast cache/entity tests.

---

## File map

- Modify: `custom_components/helman/sensor.py`
  Register forecast summary sensor instances with `set_sensors()` during platform setup.
- Modify: `custom_components/helman/coordinator.py`
  Store forecast sensor references, publish them after solar refresh, guard writes to added entities only, and clear the registration on unload.
- Modify: `tests/test_solar_forecast_cache.py`
  Add refresh-path tests proving the coordinator republishes registered forecast entities after both direct refresh and stale-cache recovery.
- Modify: `tests/test_sensor_forecast_entities.py`
  Add setup/registration coverage and keep entity availability/value behavior pinned to coordinator helpers with no extra entity cache.

### Task 1: Cover the missing publication contract first

**Files:**
- Modify: `tests/test_solar_forecast_cache.py`
- Modify: `tests/test_sensor_forecast_entities.py`

- [ ] **Step 1: Add a failing coordinator refresh test for post-refresh publication**

```python
async def test_refresh_forecast_republishes_registered_forecast_entities(self) -> None:
    coordinator = object.__new__(coordinator_module.HelmanCoordinator)
    coordinator._hass = SimpleNamespace()
    coordinator._active_config = {}
    coordinator._cached_forecast = None
    coordinator._cached_solar_forecast = None
    coordinator._invalidate_battery_forecast_cache = Mock()
    coordinator._async_refresh_automation_input_bundle = AsyncMock(return_value=True)
    coordinator._storage = SimpleNamespace(async_save_snapshots=AsyncMock())
    forecast_entity = SimpleNamespace(
        hass=object(),
        entity_id="sensor.helman_energy_production_today",
        async_write_ha_state=Mock(),
    )
    coordinator._solar_forecast_sensors = [forecast_entity]

    builder_instance = SimpleNamespace(build=AsyncMock(return_value={"status": "available"}))
    coordinator._async_build_canonical_solar_forecast = AsyncMock(
        return_value={"status": "available", "points": [], "rawPoints": []}
    )

    with patch.object(
        coordinator_module,
        "ConsumptionForecastBuilder",
        return_value=builder_instance,
    ):
        await coordinator._async_refresh_forecast(reference_time=REFERENCE_TIME)

    forecast_entity.async_write_ha_state.assert_called_once_with()
```

- [ ] **Step 2: Add a failing stale-cache recovery regression**

```python
async def test_get_canonical_solar_forecast_refresh_path_republishes_entities(self) -> None:
    coordinator = object.__new__(coordinator_module.HelmanCoordinator)
    coordinator._cached_solar_forecast = None
    forecast_entity = SimpleNamespace(
        hass=object(),
        entity_id="sensor.helman_energy_production_tomorrow",
        async_write_ha_state=Mock(),
    )
    coordinator._solar_forecast_sensors = [forecast_entity]

    async def _refresh(*, reason: str, reference_time=None) -> None:
        coordinator._cached_solar_forecast = {
            "status": "available",
            "points": [{"timestamp": "2026-05-03T10:00:00+02:00", "value": 900.0}],
            "rawPoints": [],
        }
        coordinator._publish_solar_forecast_entities()

    coordinator._async_refresh_forecast_and_request_automation = AsyncMock(side_effect=_refresh)

    result = await coordinator._async_get_canonical_solar_forecast(
        reference_time=REFERENCE_TIME
    )

    self.assertIsNotNone(result)
    forecast_entity.async_write_ha_state.assert_called_once_with()
```

- [ ] **Step 3: Add a failing sensor setup regression for registration**

```python
async def test_async_setup_entry_registers_forecast_entities_with_coordinator(self) -> None:
    sensor_module = _load_sensor_module()
    coordinator = SimpleNamespace(
        set_sensors=Mock(),
        set_entity_factory=Mock(),
    )

    await sensor_module.async_setup_entry(hass, entry, async_add_entities)

    forecast_sensors = coordinator.set_sensors.call_args.kwargs["forecast_sensors"]
    self.assertEqual(len(forecast_sensors), 9)
    self.assertEqual(
        forecast_sensors[0].entity_id,
        "sensor.helman_energy_production_today",
    )
```

- [ ] **Step 4: Run the focused tests to verify the gap is real**

Run: `pytest tests/test_solar_forecast_cache.py tests/test_sensor_forecast_entities.py -q`

Expected: FAIL because `HelmanCoordinator` has no forecast sensor registration/publish path and `sensor.async_setup_entry()` does not pass forecast entities into `set_sensors()`.

- [ ] **Step 5: Commit the test-only slice**

```bash
git add tests/test_solar_forecast_cache.py tests/test_sensor_forecast_entities.py
git commit -m "test: cover solar forecast entity refresh publication"
```

### Task 2: Register forecast entities and publish them from the coordinator refresh path

**Files:**
- Modify: `custom_components/helman/sensor.py`
- Modify: `custom_components/helman/coordinator.py`
- Test: `tests/test_solar_forecast_cache.py`

- [ ] **Step 1: Extend coordinator state and sensor registration**

```python
class HelmanCoordinator:
    def __init__(self, hass: HomeAssistant, storage: HelmanStorage) -> None:
        ...
        self._solar_forecast_sensors: list[Any] = []

    def set_sensors(
        self,
        battery_time_to_full,
        battery_time_to_empty,
        unmeasured_sensors: dict,
        total_power=None,
        production_total=None,
        source_ratio_sensors: dict | None = None,
        forecast_sensors: list[Any] | None = None,
    ) -> None:
        ...
        self._solar_forecast_sensors = list(forecast_sensors or [])
```

- [ ] **Step 2: Wire forecast entities into `sensor.async_setup_entry()`**

```python
coordinator.set_sensors(
    battery_time_to_full=battery_time_to_full,
    battery_time_to_empty=battery_time_to_empty,
    unmeasured_sensors=unmeasured_sensors,
    total_power=total_power,
    production_total=production_total,
    source_ratio_sensors=source_ratio_sensors,
    forecast_sensors=forecast_entities,
)
```

- [ ] **Step 3: Add a dedicated publish helper with write guards and per-entity error isolation**

```python
def _publish_solar_forecast_entities(self) -> None:
    for sensor in self._solar_forecast_sensors:
        if getattr(sensor, "hass", None) is None:
            continue
        try:
            sensor.async_write_ha_state()
        except Exception:
            _LOGGER.exception(
                "Error publishing solar forecast sensor state: %s",
                getattr(sensor, "entity_id", "<unknown>"),
            )
```

- [ ] **Step 4: Call the publish helper inside `_async_refresh_forecast()` immediately after the snapshot cache write**

```python
self._cached_forecast = house_snapshot
self._cached_solar_forecast = solar_snapshot
self._invalidate_battery_forecast_cache()
save_snapshots = getattr(self._storage, "async_save_snapshots", None)
...
self._publish_solar_forecast_entities()
```

Place the publish call after `_cached_solar_forecast` is assigned and after persistence succeeds, but before `_async_refresh_forecast()` returns. Keep it inside the success path only; refresh exceptions should still return `_ForecastRefreshResult(forecast_refreshed=False, bundle_ready=False)` without publishing fake data.

- [ ] **Step 5: Clear the registration during unload**

```python
async def async_unload(self) -> None:
    ...
    self._source_ratio_sensors = {}
    self._solar_forecast_sensors = []
```

- [ ] **Step 6: Run focused refresh tests and keep the logging path covered if needed**

Run: `pytest tests/test_solar_forecast_cache.py -q`

Expected: PASS with refresh publication happening for direct refresh and stale-cache recovery, and skipped for entities not yet added to Home Assistant.

- [ ] **Step 7: Commit the coordinator wiring slice**

```bash
git add custom_components/helman/sensor.py custom_components/helman/coordinator.py tests/test_solar_forecast_cache.py
git commit -m "feat: republish solar forecast sensors after refresh"
```

### Task 3: Lock down entity semantics and unavailable transitions

**Files:**
- Modify: `tests/test_sensor_forecast_entities.py`
- Modify: `tests/test_solar_forecast_cache.py`
- Modify: `custom_components/helman/coordinator.py` (only if a tiny helper adjustment is needed)

- [ ] **Step 1: Add coverage that refreshed empty/missing day buckets make entities unavailable**

```python
async def test_forecast_entity_becomes_unavailable_after_refresh_with_missing_bucket(self) -> None:
    coordinator = object.__new__(coordinator_module.HelmanCoordinator)
    coordinator._cached_solar_forecast = {"status": "available", "points": [], "rawPoints": []}

    entity = sensor_module.HelmanSolarForecastEnergySensor(
        coordinator,
        _FakeEntry(),
        "d4",
        day_offset=4,
    )

    self.assertFalse(entity.available)
    self.assertIsNone(entity.native_value)
```

- [ ] **Step 2: Add explicit regression coverage for the full local entity set**

```python
async def test_day_offsets_and_today_remaining_match_cached_snapshot(self) -> None:
    coordinator = object.__new__(coordinator_module.HelmanCoordinator)
    coordinator._cached_solar_forecast = {
        "points": [
            {"timestamp": "2026-03-20T08:00:00+01:00", "value": 500.0},
            {"timestamp": "2026-03-20T12:00:00+01:00", "value": 1500.0},
            {"timestamp": "2026-03-21T10:00:00+01:00", "value": 2000.0},
        ]
    }

    self.assertEqual(coordinator.get_solar_forecast_day_total(0), 2.0)
    self.assertEqual(coordinator.get_solar_forecast_day_total(1), 2.0)
```
Add the remaining `d2` through `d7` assertions using sparse buckets so the test proves unavailable transitions instead of only the happy path. Keep `today_remaining` on the same shared snapshot path rather than introducing any separate forecast builder or cached entity value.

- [ ] **Step 3: Re-run the full forecast-related regression set**

Run: `pytest tests/test_sensor_forecast_entities.py tests/test_solar_forecast_cache.py tests/test_energy_platform.py tests/test_automation_input_bundle.py -q`

Expected: PASS with the entity helpers still reading the canonical snapshot, stale-cache recovery still using `_async_refresh_forecast_and_request_automation()`, and no regressions in existing forecast cache behavior.

- [ ] **Step 4: Commit the behavior-locking slice**

```bash
git add tests/test_sensor_forecast_entities.py tests/test_solar_forecast_cache.py tests/test_energy_platform.py tests/test_automation_input_bundle.py
git commit -m "test: lock solar forecast sensor refresh behavior"
```

## Self-review

- Spec coverage: registration, coordinator-owned publish helper, scheduled refresh behavior through `_async_refresh_forecast()`, stale-cache recovery through `_async_get_canonical_solar_forecast()`, unavailable transitions, and single-source-of-truth entity reads are all mapped to tasks above.
- Placeholder scan: no `TODO`/`TBD` placeholders remain; every task names exact files, commands, and the intended assertions.
- Type consistency: the plan consistently uses `forecast_sensors` for registration and `_solar_forecast_sensors` for coordinator storage, with `_publish_solar_forecast_entities()` as the single post-refresh fan-out hook.
