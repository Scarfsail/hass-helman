# Historical Forecast in Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the visual inspector to show the raw and corrected forecasts for past days by reading historical states from the Home Assistant recorder.

**Architecture:** Extract the history lookup logic from `load_historical_per_slot_forecast` into a new helper function `_read_historical_forecast_state`. We will then update both `load_historical_per_slot_forecast` and `load_forecast_points_for_day` to use this new helper. This will allow `load_forecast_points_for_day` to return appropriately formatted historical points for days in the past (`offset < 0`).

**Tech Stack:** Python, Home Assistant `recorder` history API

---

### Task 1: Extract history state lookup helper

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/forecast_history.py`

- [ ] **Step 1: Extract `_read_historical_forecast_state` helper function**

Add this helper function above `load_historical_per_slot_forecast` in `forecast_history.py`:

```python
async def _read_historical_forecast_state(
    hass: HomeAssistant,
    cfg: BiasConfig,
    target_date: date,
) -> Any | None:
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

    return _select_first_state_for_window(states, after=dt_util.as_utc(local_start))
```

- [ ] **Step 2: Update `load_historical_per_slot_forecast` to use the helper**

Replace the existing state lookup logic in `load_historical_per_slot_forecast` with a call to the new helper:

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
    state = await _read_historical_forecast_state(hass, cfg, target_date)
    if state is None:
        return None

    local_tz = ZoneInfo(str(hass.config.time_zone))
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
```

- [ ] **Step 3: Run the tests to ensure the trainer function still works**

Run: `pytest tests/test_solar_bias_forecast_history.py -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add custom_components/helman/solar_bias_correction/forecast_history.py
git commit -m "refactor(solar-bias): extract historical state lookup helper"
```

### Task 2: Support past days in `load_forecast_points_for_day`

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/forecast_history.py`

- [ ] **Step 1: Update `load_forecast_points_for_day` to use historical lookups for `offset < 0`**

Modify `load_forecast_points_for_day` in `forecast_history.py` to use `_read_historical_forecast_state` for past days:

```python
async def load_forecast_points_for_day(
    hass: HomeAssistant,
    cfg: BiasConfig,
    target_date: date,
    *,
    local_now: datetime,
) -> list[dict[str, Any]]:
    entity_ids = _read_entity_ids(cfg.daily_energy_entity_ids, limit=None)
    if not entity_ids:
        return []

    local_tz = ZoneInfo(str(hass.config.time_zone))
    today = dt_util.as_local(local_now).date()
    offset = (target_date - today).days

    if offset < 0:
        state = await _read_historical_forecast_state(hass, cfg, target_date)
        if state is None:
            return []
    elif offset >= len(entity_ids):
        return []
    else:
        state = hass.states.get(entity_ids[offset])
        if state is None:
            return []

    attributes = getattr(state, "attributes", {})
    wh_period = attributes.get("wh_period") if isinstance(attributes, dict) else None
    if not isinstance(wh_period, dict):
        return []

    parsed_points: list[tuple[datetime, float]] = []
    for raw_key, raw_value in wh_period.items():
        parsed_value = _parse_attribute_wh(raw_value)
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

- [ ] **Step 2: Run all tests to ensure basic changes don't break existing behaviour**

Run: `pytest tests/test_solar_bias_inspector.py tests/test_solar_bias_forecast_history.py -v`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add custom_components/helman/solar_bias_correction/forecast_history.py
git commit -m "feat(solar-bias): load historical forecast points for past days"
```

### Task 3: Test `load_forecast_points_for_day` for past days

**Files:**
- Modify: `tests/test_solar_bias_inspector.py`

- [ ] **Step 1: Write a test for past days**

Add this new test function to `tests/test_solar_bias_inspector.py` below `test_load_forecast_points_for_day_returns_empty_outside_configured_horizon`:

```python
def test_load_forecast_points_for_day_reads_history_for_past_days():
    # Helper to mock the historical read
    async def mock_read_historical(hass, cfg, target_date):
        return SimpleNamespace(
            attributes={
                "wh_period": {
                    "2026-04-24T06:00:00+02:00": 100,
                    "2026-04-24T07:00:00+02:00": 200,
                }
            }
        )

    # Patch the helper specifically for this test
    original = forecast_history._read_historical_forecast_state
    forecast_history._read_historical_forecast_state = mock_read_historical
    
    try:
        hass = SimpleNamespace(
            states=SimpleNamespace(get=lambda entity_id: None),
            config=SimpleNamespace(time_zone="Europe/Prague"),
        )
        
        cfg = _make_cfg()
        cfg.daily_energy_entity_ids = ["sensor.today", "sensor.tomorrow"]

        # Date is yesterday
        result = asyncio.run(
            forecast_history.load_forecast_points_for_day(
                hass,
                cfg,
                date.fromisoformat("2026-04-24"),
                local_now=datetime.fromisoformat("2026-04-25T10:00:00+02:00"),
            )
        )

        assert len(result) == 24
        # 6:00 is slot 6
        assert result[6]["timestamp"] == "2026-04-24T06:00:00+02:00"
        assert result[6]["value"] == 100.0
        # 7:00 is slot 7
        assert result[7]["timestamp"] == "2026-04-24T07:00:00+02:00"
        assert result[7]["value"] == 200.0
    finally:
        forecast_history._read_historical_forecast_state = original
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `pytest tests/test_solar_bias_inspector.py::test_load_forecast_points_for_day_reads_history_for_past_days -v`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/test_solar_bias_inspector.py
git commit -m "test(solar-bias): verify past day forecast reads from history"
```