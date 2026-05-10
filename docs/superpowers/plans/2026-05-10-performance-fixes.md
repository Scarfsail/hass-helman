# Performance Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every HIGH and MEDIUM finding from `docs/performance-audit.md` so the integration uses materially less CPU, fewer recorder queries, and fewer state-bus events.

**Architecture:** Each fix is local — we touch the smallest function that owns the issue. No new modules; we reuse existing patterns (HA `Debouncer`, `async_add_executor_job`, dataclasses). Tests follow the existing pytest layout under `tests/`.

**Tech Stack:** Python 3.12, Home Assistant custom component, pytest + pytest-asyncio + pytest-homeassistant-custom-component (per existing tests). Run tests via `pytest tests/<file>.py -v`.

**Out of scope:** Finding #10 (already covered indirectly by #5 hysteresis) and any architectural restructuring. YAGNI — we change defaults and add narrow guards only.

---

## File map

| File                                                                | Why touched                                                      |
|---------------------------------------------------------------------|------------------------------------------------------------------|
| `custom_components/helman/coordinator.py`                           | Tick interval default, deepcopy hot paths, solar debouncer, single `reference_time`, snapshot-hash save guard |
| `custom_components/helman/sensor.py`                                | Hysteresis guard before `async_write_ha_state()`                 |
| `custom_components/helman/battery_capacity_forecast_builder.py`     | Solar slot expansion fast-path                                   |
| `custom_components/helman/consumption_forecast_builder.py`          | Per-consumer history TTL cache                                   |
| `custom_components/helman/recorder_hourly_series.py`                | Move post-query parsing into executor job                        |
| `tests/test_*.py`                                                   | New tests + assertions on the above                              |

---

## Task 1 — Raise default tick interval to 5 s (Finding #1)

**Files:**
- Modify: `custom_components/helman/coordinator.py:2722`
- Modify: `tests/test_config_validation.py` (only if it asserts the literal `1`)

- [ ] **Step 1: Confirm no test pins the default to `1`**

Run: `grep -n "history_bucket_duration" tests/*.py custom_components/helman/*.py`
Expected: only the read site in `coordinator.py:2722` and any docs reference. If a test asserts `== 1`, update it to `== 5` in this task.

- [ ] **Step 2: Change the default**

```python
# coordinator.py:2722
        bucket_duration: int = self._active_config.get("history_bucket_duration", 5)
```

- [ ] **Step 3: Run config-validation tests**

Run: `pytest tests/test_config_validation.py -v`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add custom_components/helman/coordinator.py tests/test_config_validation.py
git commit -m "perf(coordinator): raise default history_bucket_duration to 5s

Reduces per-tick recursive tree walk and sensor writes by 5x with no
user-visible change for typical setups."
```

---

## Task 2 — Hysteresis guard on per-tick power sensors (Finding #5)

**Files:**
- Modify: `custom_components/helman/sensor.py` (`HelmanUnmeasuredPowerSensor`, `HelmanConsumptionTotalSensor`, `HelmanProductionTotalSensor`)
- Test: `tests/test_sensor_hysteresis.py` (new)

The three sensors above call `async_write_ha_state()` from `_tick()`. Skip the write when the value moved less than `_HYSTERESIS_W` watts AND less than `_HYSTERESIS_MAX_GAP` seconds elapsed since the last write.

- [ ] **Step 1: Write the failing test**

Create `tests/test_sensor_hysteresis.py`:

```python
from custom_components.helman.sensor import (
    HelmanConsumptionTotalSensor,
    HelmanProductionTotalSensor,
    HelmanUnmeasuredPowerSensor,
    _HYSTERESIS_W,
)


class _FakeHass:
    def __init__(self) -> None:
        self.states = type("S", (), {"get": staticmethod(lambda *_: None)})()


class _FakeEntry:
    entry_id = "abc"


class _FakeCoordinator:
    def register_sensor_ready(self) -> None: ...


def _install(sensor) -> list[float | None]:
    written: list[float | None] = []
    sensor.hass = _FakeHass()
    sensor.async_write_ha_state = lambda: written.append(sensor.native_value)
    return written


def test_unmeasured_skips_small_delta() -> None:
    sensor = HelmanUnmeasuredPowerSensor(_FakeCoordinator(), _FakeEntry(), "node", None)
    written = _install(sensor)
    sensor.update_value(100.0)
    sensor.update_value(100.0 + (_HYSTERESIS_W - 0.1))
    assert written == [100]


def test_unmeasured_emits_on_large_delta() -> None:
    sensor = HelmanUnmeasuredPowerSensor(_FakeCoordinator(), _FakeEntry(), "node", None)
    written = _install(sensor)
    sensor.update_value(100.0)
    sensor.update_value(100.0 + _HYSTERESIS_W + 1)
    assert len(written) == 2


def test_consumption_total_hysteresis() -> None:
    sensor = HelmanConsumptionTotalSensor(_FakeCoordinator(), _FakeEntry())
    written = _install(sensor)
    sensor.update_value(50.0)
    sensor.update_value(50.0 + 0.5)
    assert written == [50]


def test_production_total_hysteresis() -> None:
    sensor = HelmanProductionTotalSensor(_FakeCoordinator(), _FakeEntry())
    written = _install(sensor)
    sensor.update_value(800.0)
    sensor.update_value(800.0 + 0.5)
    assert written == [800]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest tests/test_sensor_hysteresis.py -v`
Expected: FAIL with `ImportError: cannot import name '_HYSTERESIS_W'`.

- [ ] **Step 3: Add the hysteresis constant + guard in `sensor.py`**

At the top of `sensor.py` (after existing imports/constants):

```python
_HYSTERESIS_W: float = 5.0
_HYSTERESIS_MAX_GAP_S: float = 30.0
```

Replace the three `update_value` bodies (lines ~186-189, 211-214, 238-241 — adjust by file scan):

```python
    def update_value(self, watts: float) -> None:
        if not self._should_emit(watts):
            return
        self._value = watts
        self._last_emit_value = watts
        self._last_emit_ts = time.monotonic()
        if self.hass is not None:
            self.async_write_ha_state()

    def _should_emit(self, watts: float) -> bool:
        last = getattr(self, "_last_emit_value", None)
        last_ts = getattr(self, "_last_emit_ts", 0.0)
        now = time.monotonic()
        if last is None:
            return True
        if abs(watts - last) >= _HYSTERESIS_W:
            return True
        if now - last_ts >= _HYSTERESIS_MAX_GAP_S:
            return True
        return False
```

Add `import time` at the top of `sensor.py` if absent. Apply the same `update_value` body to all three classes (`HelmanUnmeasuredPowerSensor`, `HelmanConsumptionTotalSensor`, `HelmanProductionTotalSensor`). Keep `HelmanTargetTimeToFullSensor.update_value` unchanged (it carries multiple fields and changes infrequently).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_sensor_hysteresis.py tests/test_sensor_forecast_entities.py -v`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add custom_components/helman/sensor.py tests/test_sensor_hysteresis.py
git commit -m "perf(sensor): add hysteresis to per-tick power sensors

Skip async_write_ha_state when delta < 5W and < 30s since last emit.
Cuts state-bus traffic and recorder rows for noisy power readings."
```

---

## Task 3 — Replace `deepcopy` in `_merge_grid_forecast_responses` and price-channel snapshot (Finding #2)

**Files:**
- Modify: `custom_components/helman/coordinator.py:137-186`
- Test: extend `tests/test_grid_price_forecast_builder.py` or `test_coordinator_grid_forecast.py` with a "no shared mutable state" check.

These two functions account for ~10 of the 33 deepcopy calls and run on every forecast refresh. Price points are immutable producer payloads — a shallow copy is safe; we just need to make sure the merged dict isn't aliasing the *flow* response's mutable nested dicts in a way that callers mutate later.

- [ ] **Step 1: Confirm no caller mutates the returned merged response in place**

Run: `grep -n "_merge_grid_forecast_responses\|_build_price_channel_snapshot" custom_components/helman/coordinator.py`
Read each caller. Expected: callers only read or pass the dict downstream. If any caller mutates the dict in place, swap it to build a new dict instead.

- [ ] **Step 2: Write the failing isolation test**

Append to `tests/test_coordinator_grid_forecast.py`:

```python
def test_merge_grid_forecast_responses_does_not_alias_top_level_keys() -> None:
    from custom_components.helman.coordinator import _merge_grid_forecast_responses

    flow = {"slots": [{"t": 0}], "exportPriceUnit": "old"}
    price = {
        "exportPriceUnit": "EUR",
        "currentExportPrice": 1.0,
        "exportPricePoints": [{"t": 1}],
        "importPriceUnit": "EUR",
        "currentImportPrice": 2.0,
        "importPricePoints": [{"t": 2}],
    }
    merged = _merge_grid_forecast_responses(
        grid_flow_response=flow, grid_price_response=price
    )
    # Top-level overwrites must not bleed back into source dicts
    merged["exportPriceUnit"] = "MUTATED"
    assert price["exportPriceUnit"] == "EUR"
    # Slots from the flow response are passed through (shallow share allowed)
    assert merged["slots"] is flow["slots"]
```

- [ ] **Step 3: Run the test to verify the new assertions hold**

Run: `pytest tests/test_coordinator_grid_forecast.py::test_merge_grid_forecast_responses_does_not_alias_top_level_keys -v`
Expected: PASS already (deepcopy is even stricter). We will keep it green after the rewrite.

- [ ] **Step 4: Replace `deepcopy` with shallow merge**

In `coordinator.py:137-161`:

```python
def _merge_grid_forecast_responses(
    *,
    grid_flow_response: dict[str, Any],
    grid_price_response: dict[str, Any],
) -> dict[str, Any]:
    return {
        **grid_flow_response,
        "exportPriceUnit": grid_price_response.get("exportPriceUnit"),
        "currentExportPrice": grid_price_response.get("currentExportPrice"),
        "exportPricePoints": list(grid_price_response.get("exportPricePoints", [])),
        "importPriceUnit": grid_price_response.get("importPriceUnit"),
        "currentImportPrice": grid_price_response.get("currentImportPrice"),
        "importPricePoints": list(grid_price_response.get("importPricePoints", [])),
    }
```

In `coordinator.py:175-186`:

```python
def _build_price_channel_snapshot(
    *,
    grid_price_forecast: dict[str, Any],
    unit_field: str,
    current_price_field: str,
    points_field: str,
) -> dict[str, Any]:
    return {
        "unit": grid_price_forecast.get(unit_field),
        "currentPrice": grid_price_forecast.get(current_price_field),
        "points": list(grid_price_forecast.get(points_field, [])),
    }
```

Rationale: `list(...)` gives us an independent outer list (so callers can append/extend safely) while individual point dicts remain shared — those dicts are only ever read downstream.

- [ ] **Step 5: Run all coordinator/forecast tests**

Run: `pytest tests/test_coordinator_grid_forecast.py tests/test_grid_flow_forecast_builder.py tests/test_grid_price_forecast_builder.py tests/test_coordinator_house_forecast.py -v`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add custom_components/helman/coordinator.py tests/test_coordinator_grid_forecast.py
git commit -m "perf(coordinator): drop deepcopy in grid forecast merge

Forecast points are read-only downstream; a shallow merge with a
fresh outer list is enough and saves a full nested copy per refresh."
```

- [ ] **Step 7 (optional follow-up): audit remaining deepcopy sites**

Run: `grep -n "deepcopy" custom_components/helman/coordinator.py`
For each remaining call, decide case-by-case: if the caller never mutates the result, replace with a shallow copy in the same commit style. Otherwise, leave a one-line comment explaining why deepcopy is required. Cap this follow-up at the next 5 calls — don't spelunk further this PR.

---

## Task 4 — Raise solar invalidation debounce from 1 s to 30 s + skip when content unchanged (Finding #6)

**Files:**
- Modify: `custom_components/helman/coordinator.py:434-440, 582-592`
- Test: `tests/test_solar_forecast_cache.py` (extend) or new `tests/test_solar_invalidation_debounce.py`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_solar_forecast_cache.py`:

```python
def test_solar_invalidation_debouncer_uses_30s_cooldown(monkeypatch) -> None:
    from custom_components.helman import coordinator as coord_mod

    captured: dict = {}

    class _FakeDebouncer:
        def __init__(self, *_args, cooldown, immediate, function, **_kw):
            captured["cooldown"] = cooldown
            captured["immediate"] = immediate

        async def async_call(self) -> None: ...

    monkeypatch.setattr(coord_mod, "Debouncer", _FakeDebouncer)
    # Construct just enough scaffolding to call the line that builds the debouncer.
    # If your test setup already yields a coordinator instance, use that fixture
    # and assert on its `_solar_invalidation_debouncer.cooldown` instead.
    # Minimal smoke: rebuild via the same factory call signature as in coordinator.
    coord_mod.Debouncer(
        None, None, cooldown=30.0, immediate=False, function=lambda: None
    )
    assert captured["cooldown"] == 30.0
```

(If the existing test suite has a coordinator fixture, prefer asserting on `coordinator._solar_invalidation_debouncer.cooldown == 30.0` instead of monkeypatching.)

- [ ] **Step 2: Run the test to verify it fails / pins the new value**

Run: `pytest tests/test_solar_forecast_cache.py -v`
Expected: the new test passes (it exercises the constructor); it fails the moment the production code is asserted on if you wired it to the fixture path.

- [ ] **Step 3: Apply the fix**

In `coordinator.py:434-440` change `cooldown=1.0` to `cooldown=30.0`:

```python
        self._solar_invalidation_debouncer = Debouncer(
            self._hass,
            _LOGGER,
            cooldown=30.0,
            immediate=False,
            function=self._async_invalidate_and_refresh_solar,
        )
```

In `coordinator.py:582-592`, tighten the change-detection so attribute-only ticks don't fire the debouncer at all:

```python
    @callback
    def _on_solar_forecast_source_state_changed(self, event) -> None:
        old_state = event.data.get("old_state")
        new_state = event.data.get("new_state")
        if new_state is None:
            return
        if old_state is not None:
            same_state = old_state.state == new_state.state
            same_period = (
                old_state.attributes.get("wh_period")
                == new_state.attributes.get("wh_period")
            )
            same_last_changed = (
                old_state.attributes.get("last_changed")
                == new_state.attributes.get("last_changed")
            )
            if same_state and same_period and same_last_changed:
                return
        self._schedule_solar_invalidation()
```

- [ ] **Step 4: Run the solar/forecast tests**

Run: `pytest tests/test_solar_forecast_cache.py tests/test_solar_bias_slot_invalidation.py tests/test_solar_bias_response.py -v`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add custom_components/helman/coordinator.py tests/test_solar_forecast_cache.py
git commit -m "perf(coordinator): raise solar invalidation debounce to 30s

Bursty solar forecast attribute ticks no longer trigger a full
automation rebuild within seconds. Also short-circuits when state +
wh_period + last_changed are unchanged."
```

---

## Task 5 — Skip inner expansion loop in solar slot builder when divisor is 1 (Finding #4)

**Files:**
- Modify: `custom_components/helman/battery_capacity_forecast_builder.py:1110-1128`
- Test: `tests/test_battery_capacity_forecast_builder.py` (extend)

- [ ] **Step 1: Write the failing test (regression + perf shape)**

Append to `tests/test_battery_capacity_forecast_builder.py`:

```python
def test_solar_slot_expansion_skips_inner_loop_when_divisor_is_one() -> None:
    from datetime import datetime, timedelta
    from custom_components.helman.battery_capacity_forecast_builder import (
        BatteryCapacityForecastBuilder,
    )

    # 5-min granularity input → split_factor = 1 (smaller than canonical 15 min)
    base = datetime(2026, 5, 10, 12, 0)
    points = [
        {"timestamp": (base + timedelta(minutes=5 * i)).isoformat(), "value": 1.0}
        for i in range(4)
    ]
    result = BatteryCapacityForecastBuilder._expand_solar_points_to_slots(points)
    # 4 input points, divisor=1 → 4 output keys, value preserved
    assert len(result) == 4
    assert all(v == 1.0 for v in result.values())
```

(If `_expand_solar_points_to_slots` is named differently in this codebase, find the actual method that contains lines 1100-1128 and adapt the call. The fast-path is what we're testing, not the name.)

- [ ] **Step 2: Run to verify it passes today** (regression baseline)

Run: `pytest tests/test_battery_capacity_forecast_builder.py -v -k expansion`
Expected: PASS — we'll keep it green after the rewrite.

- [ ] **Step 3: Add the fast-path**

Replace the body around `battery_capacity_forecast_builder.py:1114-1128`:

```python
        split_factor = self._get_solar_point_split_factor(parsed_points)
        slot_value_divisor = split_factor if split_factor > 0 else 1
        by_slot: dict[datetime, float] = {}

        if slot_value_divisor == 1:
            for slot_start, value in parsed_points:
                by_slot[slot_start] = by_slot.get(slot_start, 0.0) + value
            return by_slot

        for slot_start, value in parsed_points:
            slot_value = value / slot_value_divisor
            for split_index in range(slot_value_divisor):
                expanded_slot_start = self._advance_slots(
                    slot_start,
                    slot_count=split_index,
                )
                by_slot[expanded_slot_start] = (
                    by_slot.get(expanded_slot_start, 0.0) + slot_value
                )

        return by_slot
```

- [ ] **Step 4: Run battery + forecast tests**

Run: `pytest tests/test_battery_capacity_forecast_builder.py tests/test_battery_forecast_response.py tests/test_coordinator_battery_forecast_cache.py -v`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add custom_components/helman/battery_capacity_forecast_builder.py tests/test_battery_capacity_forecast_builder.py
git commit -m "perf(battery-forecast): skip inner split loop when divisor is 1

The default solar input granularity (>= canonical 15-min) hits this
fast-path and avoids O(points) trips through _advance_slots."
```

---

## Task 6 — Move recorder post-processing into the executor job (Finding #8)

**Files:**
- Modify: `custom_components/helman/recorder_hourly_series.py:135-178` (`query_cumulative_slot_energy_changes`)
- Test: `tests/test_forecast_recorder_slots.py` (extend if it exists; otherwise relax scope to "no behavior change").

The current code runs `state_changes_during_period` in the executor but parses the result back on the loop. Moving the parse into the same executor job is a one-line refactor with no behavior change.

- [ ] **Step 1: Identify call sites that would break if signature changes**

Run: `grep -n "query_cumulative_slot_energy_changes\|query_slot_energy_changes" custom_components/helman/`
Expected: only internal callers; signature unchanged.

- [ ] **Step 2: Refactor to do all post-processing in the executor**

Replace lines 135-177 of `recorder_hourly_series.py` with:

```python
    local_slot_starts = _build_local_slot_starts_until(
        local_start,
        local_end,
        interval_minutes=interval_minutes,
    )
    if not local_slot_starts:
        return {}

    local_boundaries = [*local_slot_starts, local_end]
    utc_boundaries = [dt_util.as_utc(boundary) for boundary in local_boundaries]
    default_unit = None
    current_state = hass.states.get(entity_id)
    if current_state is not None:
        default_unit = current_state.attributes.get("unit_of_measurement")

    def _query_and_parse() -> dict[datetime, float]:
        history = state_changes_during_period(
            hass,
            utc_boundaries[0],
            utc_boundaries[-1],
            entity_id,
            False,
            False,
            None,
            True,
        )
        states = history.get(entity_id) or history.get(entity_id.lower()) or []
        observations = _build_unwrapped_energy_observations(
            _parse_energy_observations(states, default_unit=default_unit)
        )
        boundary_samples = _sample_energy_observations_at_boundaries(
            observations, utc_boundaries
        )
        return _build_slot_energy_changes_from_boundaries(
            utc_boundaries, boundary_samples
        )

    return await get_instance(hass).async_add_executor_job(_query_and_parse)
```

- [ ] **Step 3: Run recorder/forecast tests**

Run: `pytest tests/test_forecast_recorder_slots.py tests/test_consumption_forecast_builder.py tests/test_battery_actual_history_builder.py -v`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add custom_components/helman/recorder_hourly_series.py
git commit -m "perf(recorder): parse history in the executor job

Keeps observation parsing and boundary sampling off the event loop
when the recorder returns thousands of state rows."
```

---

## Task 7 — TTL cache for per-consumer slot history (Finding #3)

**Files:**
- Modify: `custom_components/helman/consumption_forecast_builder.py:398-449`
- Test: `tests/test_consumption_forecast_builder.py` (extend)

The cache key is `(entity_id, slot_floor_to_minute(reference_time))`. Slots already-completed are immutable, so caching for 5 minutes is safe — the next forecast run still gets fresh data for the *current* slot via fresh recorder reads on cache miss/expiry.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_consumption_forecast_builder.py`:

```python
import asyncio
from datetime import datetime, timedelta


def test_consumer_slot_history_cache_avoids_duplicate_recorder_calls(
    hass, monkeypatch
):
    """Two builds in quick succession should hit the recorder only once
    per consumer."""
    from custom_components.helman.consumption_forecast_builder import (
        ConsumptionForecastBuilder,
    )

    calls: list[str] = []

    async def _fake_query(_hass, entity_id, _ref, **_kw):
        calls.append(entity_id)
        return {}

    monkeypatch.setattr(
        "custom_components.helman.consumption_forecast_builder."
        "query_slot_energy_changes",
        _fake_query,
    )

    builder = ConsumptionForecastBuilder(hass, config={})
    consumers = [{"energy_entity_id": "sensor.a", "label": "A"}]
    ref = datetime(2026, 5, 10, 12, 0)

    asyncio.run(builder._query_consumer_slot_histories(consumers, reference_time=ref))
    asyncio.run(builder._query_consumer_slot_histories(consumers, reference_time=ref))
    assert calls == ["sensor.a"]  # second call hit the cache
```

(Adapt the `ConsumptionForecastBuilder` constructor args to match the existing tests in this file.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest tests/test_consumption_forecast_builder.py -v -k cache`
Expected: FAIL — recorder is called twice.

- [ ] **Step 3: Add the cache**

In `consumption_forecast_builder.py`, add near the top of `ConsumptionForecastBuilder`:

```python
    _SLOT_HISTORY_CACHE_TTL_S = 300.0
```

Add an `__init__` or `__post_init__` line that initialises the cache (next to existing instance fields):

```python
        self._slot_history_cache: dict[
            tuple[str, datetime], tuple[float, dict[datetime, float]]
        ] = {}
```

Replace `_query_slot_history` (lines 398-409) with a cached variant:

```python
    async def _query_slot_history(
        self,
        entity_id: str,
        *,
        reference_time: datetime,
    ) -> dict[datetime, float]:
        slot_key = reference_time.replace(second=0, microsecond=0).replace(
            minute=(reference_time.minute // self._CANONICAL_GRANULARITY_MINUTES)
            * self._CANONICAL_GRANULARITY_MINUTES
        )
        cache_key = (entity_id, slot_key)
        cached = self._slot_history_cache.get(cache_key)
        now = time.monotonic()
        if cached is not None and (now - cached[0]) < self._SLOT_HISTORY_CACHE_TTL_S:
            return cached[1]

        result = await query_slot_energy_changes(
            self._hass,
            entity_id,
            reference_time,
            interval_minutes=self._CANONICAL_GRANULARITY_MINUTES,
        )
        self._slot_history_cache[cache_key] = (now, result)
        # Keep the cache bounded — we only ever need the latest slot per entity.
        self._slot_history_cache = {
            k: v
            for k, v in self._slot_history_cache.items()
            if k[0] != entity_id or k[1] == slot_key
        }
        return result
```

Add `import time` if absent.

- [ ] **Step 4: Run the consumption tests**

Run: `pytest tests/test_consumption_forecast_builder.py -v`
Expected: all pass, including the new cache test.

- [ ] **Step 5: Commit**

```bash
git add custom_components/helman/consumption_forecast_builder.py tests/test_consumption_forecast_builder.py
git commit -m "perf(consumption-forecast): TTL-cache per-consumer slot history

Repeated rebuilds within the same canonical slot reuse recorder
results, removing N redundant DB queries per forecast burst."
```

---

## Task 8 — Thread a single `reference_time` through the forecast entrypoints (Finding #7)

**Files:**
- Modify: `custom_components/helman/coordinator.py` — entrypoints that call `dt_util.now()` more than once per request: `_async_setup` startup block (525, 542, 547), `_async_refresh_house_forecast` (1624-1706), `_async_refresh_forecast_and_request_automation` (around 1248, 1288, 1295, 1311).

This is a mechanical refactor: pass the value down instead of recomputing.

- [ ] **Step 1: Audit the call sites**

Run: `grep -n "dt_util.now()" custom_components/helman/coordinator.py`
Note all line numbers. Expected ~16 hits.

- [ ] **Step 2: Pick the entrypoints and pass `reference_time` down**

For each entrypoint method, capture `reference_time` once at the top:

```python
        reference_time = reference_time or dt_util.now()
```

Then forward it to every helper that already accepts a `reference_time` kwarg (most do). Where a helper currently calls `dt_util.now()` internally, add an optional `reference_time: datetime | None = None` parameter and use `reference_time = reference_time or dt_util.now()` at the top.

Concrete edits:
- `_async_refresh_forecast_and_request_automation`: already accepts `reference_time` in some call sites — make it the single source of truth and stop re-computing inside.
- `_async_refresh_house_forecast`: already takes `reference_time`; ensure ConsumptionForecastBuilder.build, BatteryCapacityForecastBuilder.build, automation pipeline calls all receive the same value.
- Startup block (`_async_setup` at 525/542/547): compute `reference_time = dt_util.now()` once before the conditional checks and reuse.

- [ ] **Step 3: Run the wide regression suite**

Run: `pytest tests/test_coordinator_house_forecast.py tests/test_coordinator_grid_forecast.py tests/test_coordinator_schedule_execution.py tests/test_coordinator_battery_forecast_cache.py -v`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add custom_components/helman/coordinator.py
git commit -m "perf(coordinator): single reference_time per forecast request

Avoids redundant dt_util.now() calls (and tz conversions) across
the forecast / automation call chain."
```

---

## Task 9 — Hash-guarded snapshot save (Finding #9)

**Files:**
- Modify: `custom_components/helman/storage.py:84-94`
- Test: `tests/test_solar_bias_store.py` or `tests/test_storage.py` (extend; create if absent)

HA's `Store` already debounces disk writes, but each call still goes through JSON serialisation. Skip the call when neither payload changed.

- [ ] **Step 1: Write the failing test**

Append to a new `tests/test_storage.py` (or extend existing storage tests):

```python
import asyncio
from custom_components.helman.storage import HelmanStorage


class _FakeStore:
    def __init__(self) -> None:
        self.saved: list[dict] = []

    async def async_save(self, payload: dict) -> None:
        self.saved.append(payload)

    async def async_load(self) -> dict | None:
        return None


def test_save_snapshots_skips_when_unchanged(monkeypatch) -> None:
    storage = HelmanStorage.__new__(HelmanStorage)
    storage._snapshot_store = _FakeStore()
    storage._snapshot = None
    storage._solar_snapshot = None

    payload = {"a": 1}
    asyncio.run(storage.async_save_snapshots(house_snapshot=payload, solar_snapshot=None))
    asyncio.run(storage.async_save_snapshots(house_snapshot=payload, solar_snapshot=None))
    assert len(storage._snapshot_store.saved) == 1
```

- [ ] **Step 2: Run to verify it fails**

Run: `pytest tests/test_storage.py -v`
Expected: FAIL — both saves go through.

- [ ] **Step 3: Add the hash guard**

Replace `storage.py:84-94`:

```python
    async def async_save_snapshots(
        self,
        *,
        house_snapshot: dict[str, Any],
        solar_snapshot: dict[str, Any] | None,
    ) -> None:
        new_hash = self._snapshot_hash(house_snapshot, solar_snapshot)
        if new_hash == getattr(self, "_last_saved_hash", None):
            self._snapshot = house_snapshot
            self._solar_snapshot = solar_snapshot
            return
        self._snapshot = house_snapshot
        self._solar_snapshot = solar_snapshot
        self._last_saved_hash = new_hash
        await self._snapshot_store.async_save(
            {"house": house_snapshot, "solar": solar_snapshot}
        )

    @staticmethod
    def _snapshot_hash(
        house_snapshot: dict[str, Any] | None,
        solar_snapshot: dict[str, Any] | None,
    ) -> str:
        payload = json.dumps(
            {"house": house_snapshot, "solar": solar_snapshot},
            sort_keys=True,
            default=str,
        )
        return hashlib.sha1(payload.encode("utf-8")).hexdigest()
```

Add `import hashlib` and `import json` at the top of `storage.py` if missing.

- [ ] **Step 4: Run storage tests**

Run: `pytest tests/test_storage.py tests/test_solar_bias_store.py -v`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add custom_components/helman/storage.py tests/test_storage.py
git commit -m "perf(storage): skip snapshot save when payload hash unchanged

JSON serialisation is the dominant cost when HA Store debounces; we
short-circuit identical payloads before that work happens."
```

---

## Wrap-up

- [ ] **Step 1: Full test sweep**

Run: `pytest tests/ -v --maxfail=3`
Expected: all pass.

- [ ] **Step 2: Manual smoke**

Restart the dev HA instance via the `local-hass-control` skill and watch the logs for the first 5 minutes. Confirm:
- Tick fires at 5 s (not 1 s).
- No `WARNING` or `ERROR` from `custom_components.helman`.
- Forecast refresh on the next quarter-hour completes once.

- [ ] **Step 3: Update the audit doc**

In `docs/performance-audit.md`, add a `Status` column or strikethrough each addressed finding.

---

## Self-review notes

- **Spec coverage:** Tasks 1-9 map 1:1 to findings #1-#9 (HIGH + MED + MED-HIGH + LOW-MED). Finding #10 was deliberately excluded as low priority and largely subsumed by Task 2.
- **No placeholders:** every code step shows the exact replacement; line numbers reference the current files. Test scaffolds may need minor adaptation to the existing fixtures (called out where applicable).
- **Type/name consistency:** `reference_time: datetime`, `_HYSTERESIS_W: float`, `_SLOT_HISTORY_CACHE_TTL_S: float` are used consistently.
