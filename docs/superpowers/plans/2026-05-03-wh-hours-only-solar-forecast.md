# Wh-Hours-Only Solar Forecast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Helman consume solar forecast data only through the upstream Energy-provider `wh_hours` contract for live forecast, past-day forecast views, and bias training, while removing forecast-entity configuration and replacing the configured remaining-today forecast entity with a Helman-owned derived entity.

**Architecture:** Keep actual solar production on the explicit configured actual-energy statistic, matching Home Assistant Energy. Move all solar forecast reads behind one provider-facing seam in `solar_forecast_source.py`, and make every downstream consumer operate on normalized `wh_hours` data instead of provider entities or recorder attribute history. Publish one Helman sensor for remaining-today forecast so the existing frontend response contract can keep returning an entity ID without requiring frontend changes.

**Tech Stack:** Home Assistant custom integration Python, Home Assistant Energy platform contract, websocket APIs, entity registry/sensor exposure, Lit frontend config editor, pytest.

---

### Task 1: Introduce A Canonical `wh_hours` Forecast Source API

**Files:**
- Modify: `custom_components/helman/solar_forecast_source.py`
- Modify: `custom_components/helman/forecast_builder.py`
- Test: `tests/test_solar_forecast_source.py`
- Test: `tests/test_forecast_builder_actual_history.py`

- [ ] **Step 1: Write failing source-loader tests for normalized `wh_hours` access**

Add tests that pin the new source API around provider `wh_hours` only:

```python
async def test_async_load_upstream_solar_forecast_returns_provider_wh_hours():
    result = await solar_forecast_source.async_load_upstream_solar_forecast(
        hass, "entry-1"
    )
    assert result == {
        "wh_hours": {
            "2026-05-02T04:00:00+00:00": 93,
            "2026-05-02T05:00:00+00:00": 866,
        }
    }


async def test_async_load_upstream_solar_forecast_rejects_helman_entry():
    result = await solar_forecast_source.async_load_upstream_solar_forecast(
        hass, "helman-entry"
    )
    assert result is None
```

- [ ] **Step 2: Run the focused source tests and verify any new assertions fail**

Run: `pytest tests/test_solar_forecast_source.py -q`

Expected: FAIL after adding the new assertions because the code still exposes entity-discovery helpers and lacks a canonical helper for downstream historical slicing.

- [ ] **Step 3: Add normalized helpers in `solar_forecast_source.py`**

Refactor the module so downstream code consumes provider forecast through explicit helpers:

```python
async def async_load_upstream_solar_forecast(
    hass, source_config_entry_id: str
) -> dict[str, Any] | None:
    ...
    forecast = await loader(hass, source_config_entry_id)
    wh_hours = _normalize_wh_hours(_read_dict(forecast).get("wh_hours"))
    return {"wh_hours": wh_hours} if wh_hours else {"wh_hours": {}}


def build_points_from_wh_hours(raw_wh_hours: Any) -> list[dict[str, Any]]:
    ...


def slice_wh_hours_by_local_date(
    raw_wh_hours: Any,
    *,
    local_tz: ZoneInfo,
    target_date: date,
) -> list[dict[str, Any]]:
    ...
```

Delete provider-entity discovery helpers that exist only for forecast-entity history:

```python
async def async_discover_provider_daily_forecast_entities(...): ...
def _earliest_wh_period_timestamp(...): ...
def _parse_wh_period_timestamp(...): ...
```

- [ ] **Step 4: Switch `forecast_builder.py` to the shared `wh_hours` point builder**

Update the solar builder to reuse the source helper instead of maintaining a private point translator:

```python
from .solar_forecast_source import (
    async_load_upstream_solar_forecast,
    build_points_from_wh_hours,
)

...
points = build_points_from_wh_hours(
    self._read_dict(upstream_forecast).get("wh_hours")
)
```

Remove dead methods that were tied to entity-shaped upstream inputs:

```python
def _extract_hourly_solar_points(...): ...
def _build_local_hour_slots_for_date(...): ...
```

- [ ] **Step 5: Add/adjust builder tests for `wh_hours`-only live forecast**

Add or update a builder test that proves live solar output is built exclusively from provider `wh_hours` and no longer depends on configured forecast entities:

```python
async def test_build_solar_forecast_uses_provider_wh_hours_only(self):
    ...
    self.assertEqual(
        payload["points"],
        [
            {"timestamp": "2026-05-03T04:00:00+00:00", "value": 102.0},
            {"timestamp": "2026-05-03T05:00:00+00:00", "value": 909.0},
        ],
    )
```

- [ ] **Step 6: Run the focused tests and verify they pass**

Run: `pytest tests/test_solar_forecast_source.py tests/test_forecast_builder_actual_history.py -q`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add custom_components/helman/solar_forecast_source.py custom_components/helman/forecast_builder.py tests/test_solar_forecast_source.py tests/test_forecast_builder_actual_history.py
git commit -m "refactor: centralize solar wh_hours loading"
```


### Task 2: Remove Solar Forecast Entity Configuration And Migrate Old Config

**Files:**
- Modify: `custom_components/helman/config_validation.py`
- Modify: `custom_components/helman/solar_forecast_source.py`
- Modify: `custom_components/helman/websockets.py`
- Modify: `custom_components/helman/frontend/src/config-editor-scopes.ts`
- Modify: `custom_components/helman/frontend/src/helman-config-editor.ts`
- Test: `tests/test_config_validation.py`
- Test: `tests/test_config_editor_contract.py`

- [ ] **Step 1: Write failing validation and editor-contract tests for removed config fields**

Add tests asserting these solar forecast config inputs are no longer accepted or surfaced:

```python
def test_solar_validation_ignores_removed_forecast_entity_fields():
    config["power_devices"]["solar"]["forecast"]["total_energy_entity_id"] = "sensor.old"
    config["power_devices"]["solar"]["entities"]["remaining_today_energy_forecast"] = "sensor.old"
    report = validate_config_document(config)
    assert not any(issue["path"] == "power_devices.solar.forecast.total_energy_entity_id" for issue in report.to_payload()["issues"])
```

```python
def test_config_editor_contract_omits_removed_solar_forecast_entity_fields():
    assert "power_devices.solar.forecast.total_energy_entity_id" not in contract_paths
    assert "power_devices.solar.entities.remaining_today_energy_forecast" not in contract_paths
```

- [ ] **Step 2: Run the config-focused tests and verify they fail**

Run: `pytest tests/test_config_validation.py tests/test_config_editor_contract.py -q`

Expected: FAIL because validation and editor scopes still include the removed solar forecast entity fields.

- [ ] **Step 3: Remove validation/editor support for the removed forecast-entity fields**

Delete solar-forecast-only entity/config references while keeping actual-energy config intact:

```python
# config_validation.py
_validate_optional_entity_id(
    report,
    section,
    "power_devices.solar.entities.today_energy",
    entity_map.get("today_energy"),
)

# remove:
# - power_devices.solar.entities.remaining_today_energy_forecast
# - power_devices.solar.forecast.total_energy_entity_id
```

```ts
// config-editor-scopes.ts
const SOLAR_FORECAST_GENERAL_PROJECTION_MEMBERS = [
  {
    yamlKey: "source_config_entry_id",
    documentPath: ["power_devices", "solar", "forecast", "source_config_entry_id"],
  },
];
```

In `helman-config-editor.ts`, remove the rendered form controls and help text for:

```ts
["power_devices", "solar", "forecast", "total_energy_entity_id"]
["power_devices", "solar", "entities", "remaining_today_energy_forecast"]
```

- [ ] **Step 4: Expand legacy-config migration to scrub removed forecast entity fields**

Update `migrate_legacy_solar_forecast_config(...)` to remove all forecast-entity-era solar keys during migration:

```python
forecast.pop("daily_energy_entity_ids", None)
forecast.pop("total_energy_entity_id", None)

solar = _get_solar_section(migrated)
if solar is not None and isinstance(solar.get("entities"), dict):
    solar["entities"].pop("remaining_today_energy_forecast", None)
```

Also remove obsolete websocket editor error reporting for `daily_energy_entity_ids`.

- [ ] **Step 5: Run the config/editor tests and verify they pass**

Run: `pytest tests/test_config_validation.py tests/test_config_editor_contract.py -q`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add custom_components/helman/config_validation.py custom_components/helman/solar_forecast_source.py custom_components/helman/websockets.py custom_components/helman/frontend/src/config-editor-scopes.ts custom_components/helman/frontend/src/helman-config-editor.ts tests/test_config_validation.py tests/test_config_editor_contract.py
git commit -m "refactor: remove solar forecast entity config"
```


### Task 3: Publish A Helman-Owned Remaining-Today Forecast Entity

**Files:**
- Modify: `custom_components/helman/coordinator.py`
- Modify: `custom_components/helman/forecast_builder.py`
- Create or Modify: `custom_components/helman/sensor.py`
- Modify: `custom_components/helman/__init__.py`
- Test: `tests/test_forecast_builder_actual_history.py`
- Test: `tests/test_point_forecast_response.py`
- Test: `tests/test_solar_bias_response.py`

- [ ] **Step 1: Write failing tests for the derived remaining-today entity**

Add tests that pin the FE-facing contract while moving ownership to Helman:

```python
def test_forecast_payload_returns_helman_remaining_today_entity_id():
    payload = ...
    assert payload["remainingTodayEnergyEntityId"] == "sensor.helman_remaining_today_energy_forecast"
```

```python
async def test_remaining_today_sensor_state_is_sum_of_future_today_points():
    # points before now are excluded; later-today points are summed
    assert hass.states.get("sensor.helman_remaining_today_energy_forecast").state == "12345.0"
```

- [ ] **Step 2: Run the focused response tests and verify they fail**

Run: `pytest tests/test_forecast_builder_actual_history.py tests/test_point_forecast_response.py tests/test_solar_bias_response.py -q`

Expected: FAIL because the response still reads a configured entity ID and Helman does not yet publish its own remaining-today sensor.

- [ ] **Step 3: Derive remaining-today from Helman’s effective forecast**

In `forecast_builder.py`, replace config lookup with a fixed Helman-owned entity ID constant:

```python
REMAINING_TODAY_FORECAST_ENTITY_ID = "sensor.helman_remaining_today_energy_forecast"

return {
    "status": status,
    "unit": "Wh" if points else None,
    "remainingTodayEnergyEntityId": REMAINING_TODAY_FORECAST_ENTITY_ID,
    ...
}
```

Add a helper to compute the remaining-today sum:

```python
def _sum_remaining_today_wh(self, points: list[dict[str, Any]], reference_time: datetime) -> float:
    ...
```

- [ ] **Step 4: Publish the remaining-today entity from the integration**

Add one Helman-owned sensor that tracks the current effective remaining-today forecast:

```python
class HelmanRemainingTodayEnergyForecastSensor(...):
    _attr_name = "Helman Remaining Today Energy Forecast"
    _attr_native_unit_of_measurement = "Wh"
    _attr_device_class = SensorDeviceClass.ENERGY
    _attr_state_class = SensorStateClass.MEASUREMENT
```

Its value source should be coordinator-owned forecast state, not config.

- [ ] **Step 5: Run the focused sensor/response tests and verify they pass**

Run: `pytest tests/test_forecast_builder_actual_history.py tests/test_point_forecast_response.py tests/test_solar_bias_response.py -q`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add custom_components/helman/coordinator.py custom_components/helman/forecast_builder.py custom_components/helman/sensor.py custom_components/helman/__init__.py tests/test_forecast_builder_actual_history.py tests/test_point_forecast_response.py tests/test_solar_bias_response.py
git commit -m "feat: expose helman remaining-today forecast sensor"
```


### Task 4: Rework Bias Training And Historical Forecast Reads To Use Provider `wh_hours`

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/models.py`
- Modify: `custom_components/helman/solar_bias_correction/forecast_history.py`
- Modify: `custom_components/helman/solar_bias_correction/trainer.py`
- Modify: `custom_components/helman/coordinator.py`
- Test: `tests/test_solar_bias_forecast_history.py`
- Test: `tests/test_solar_bias_models.py`
- Test: `tests/test_solar_bias_service_runtime.py`
- Test: `tests/test_solar_bias_inspector.py`

- [ ] **Step 1: Write failing bias-history tests for provider-`wh_hours` historical slicing**

Replace entity-history tests with provider-payload tests:

```python
async def test_load_forecast_points_for_past_day_reads_provider_wh_hours_slice():
    forecast = {
        "wh_hours": {
            "2026-05-02T04:00:00+00:00": 93,
            "2026-05-02T05:00:00+00:00": 866,
            "2026-05-03T04:00:00+00:00": 102,
        }
    }
    ...
    assert [point["value"] for point in points] == [93.0, 866.0]
```

```python
async def test_load_trainer_samples_drops_days_when_provider_has_insufficient_past_wh_hours():
    samples = await forecast_history.load_trainer_samples(...)
    assert samples == []
```

- [ ] **Step 2: Run the bias-history tests and verify they fail**

Run: `pytest tests/test_solar_bias_forecast_history.py tests/test_solar_bias_models.py tests/test_solar_bias_service_runtime.py tests/test_solar_bias_inspector.py -q`

Expected: FAIL because `forecast_history.py` still depends on discovered provider entities and recorder attribute history.

- [ ] **Step 3: Remove provider-entity and recorder-history dependencies from forecast history**

Refactor `forecast_history.py` around current upstream provider payload only:

```python
from ..solar_forecast_source import (
    async_load_upstream_solar_forecast,
    slice_wh_hours_by_local_date,
)

async def load_forecast_points_for_day(...):
    upstream = await async_load_upstream_solar_forecast(hass, cfg.source_config_entry_id)
    if upstream is None:
        return []
    return slice_wh_hours_by_local_date(
        upstream.get("wh_hours"),
        local_tz=local_tz,
        target_date=target_date,
    )
```

Delete obsolete recorder/entity helpers:

```python
async def _read_historical_forecast_state(...): ...
async def load_historical_per_slot_forecast(...): ...
async def _read_history_for_entities_with_attributes(...): ...
```

- [ ] **Step 4: Remove bias-model config fields that still imply forecast entities**

Drop `total_energy_entity_id` from `BiasConfig` if it is only there to represent the removed forecast-side source:

```python
@dataclass
class BiasConfig:
    ...
    source_config_entry_id: str | None
    min_valid_slot_days: int = ...
```

If actual-history config still needs an explicit solar actual entity, keep that outside `BiasConfig` and have actual-history loading resolve it from main config only.

- [ ] **Step 5: Make training availability explicit when provider history is too short**

In trainer/runtime handling, keep the current min/max-day knobs but align messaging with the new source:

```python
error_reason = "insufficient_provider_forecast_history"
```

Expected semantics:
- never inspect days older than `max_training_window_days`
- require at least `min_history_days` usable provider days
- if the current provider payload exposes fewer usable past days, training remains unavailable

- [ ] **Step 6: Run the bias-history/runtime tests and verify they pass**

Run: `pytest tests/test_solar_bias_forecast_history.py tests/test_solar_bias_models.py tests/test_solar_bias_service_runtime.py tests/test_solar_bias_inspector.py -q`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add custom_components/helman/solar_bias_correction/models.py custom_components/helman/solar_bias_correction/forecast_history.py custom_components/helman/solar_bias_correction/trainer.py custom_components/helman/coordinator.py tests/test_solar_bias_forecast_history.py tests/test_solar_bias_models.py tests/test_solar_bias_service_runtime.py tests/test_solar_bias_inspector.py
git commit -m "refactor: train solar bias from provider wh_hours"
```


### Task 5: Clean Up Public Contracts, Migration, And Documentation

**Files:**
- Modify: `custom_components/helman/frontend/src/types.ts`
- Modify: `custom_components/helman/frontend/src/solar-forecast-provider-model.ts`
- Modify: `docs/superpowers/specs/2026-05-02-upstream-solar-forecast-provider-design.md`
- Modify: `docs/features/forecast/solar-forecast-bias-correction/README.md`
- Modify: `docs/features/forecast/solar-forecast-bias-correction/solar-forecast-bias-correction-requirements.md`
- Test: `tests/test_config_editor_contract.py`
- Test: `tests/test_energy_platform.py`

- [ ] **Step 1: Write or extend contract tests for the final public surface**

Add assertions for the final expected shape:

```python
def test_editor_contract_exposes_only_source_config_entry_id_for_solar_forecast():
    assert "power_devices.solar.forecast.source_config_entry_id" in paths
    assert "power_devices.solar.forecast.total_energy_entity_id" not in paths
```

```python
async def test_energy_platform_still_exports_wh_hours_from_helman_points():
    result = await energy.async_get_solar_forecast(hass, "entry-1")
    assert "wh_hours" in result
```

- [ ] **Step 2: Run the contract tests and verify they fail if docs/contracts are stale**

Run: `pytest tests/test_config_editor_contract.py tests/test_energy_platform.py -q`

Expected: PASS or targeted FAIL depending on what still references removed forecast-entity fields; fix any remaining contract mismatches before touching docs.

- [ ] **Step 3: Update frontend/public wording to match the cleaned model**

Adjust labels/help text so solar forecast config describes:
- upstream provider selection
- Helman-owned derived remaining-today entity
- no user-supplied forecast entities

Keep the FE response field name `remainingTodayEnergyEntityId` unchanged.

- [ ] **Step 4: Update docs to state the final source-of-truth model**

Revise docs so they no longer describe:
- `daily_energy_entity_ids`
- solar `forecast.total_energy_entity_id`
- recorder history of provider forecast entities

Replace with:
- actuals from explicit configured actual-energy statistic/entity
- forecast from provider `wh_hours`
- training limited to past days currently exposed in provider `wh_hours`

- [ ] **Step 5: Run the final targeted tests**

Run: `pytest tests/test_config_editor_contract.py tests/test_energy_platform.py -q`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add custom_components/helman/frontend/src/types.ts custom_components/helman/frontend/src/solar-forecast-provider-model.ts docs/superpowers/specs/2026-05-02-upstream-solar-forecast-provider-design.md docs/features/forecast/solar-forecast-bias-correction/README.md docs/features/forecast/solar-forecast-bias-correction/solar-forecast-bias-correction-requirements.md tests/test_config_editor_contract.py tests/test_energy_platform.py
git commit -m "docs: align solar forecast contracts with wh_hours model"
```


### Task 6: Full Verification

**Files:**
- Test only

- [ ] **Step 1: Run the backend solar-forecast test suite**

Run:

```bash
pytest tests/test_solar_forecast_source.py tests/test_forecast_builder_actual_history.py tests/test_solar_bias_forecast_history.py tests/test_solar_bias_models.py tests/test_solar_bias_service_runtime.py tests/test_solar_bias_inspector.py tests/test_config_validation.py tests/test_config_editor_contract.py tests/test_energy_platform.py tests/test_point_forecast_response.py tests/test_solar_bias_response.py -q
```

Expected: PASS

- [ ] **Step 2: Run frontend checks if the editor sources changed**

Run:

```bash
cd custom_components/helman/frontend && npm test -- --runInBand
cd custom_components/helman/frontend && npm run build
```

Expected: PASS

- [ ] **Step 3: Smoke-check the live HA contracts manually**

Use local HA websocket/API and confirm:

```text
1. `energy/solar_forecast` returns the selected provider `wh_hours`
2. `helman/get_forecast` returns `remainingTodayEnergyEntityId = sensor.helman_remaining_today_energy_forecast`
3. The Helman remaining-today sensor exists and matches the remaining sum of the current effective solar forecast
4. Starting training with insufficient provider past days reports an explicit insufficient-history outcome
```

- [ ] **Step 4: Final commit if any verification fixes were needed**

```bash
git add -A
git commit -m "test: verify wh-hours-only solar forecast flow"
```

---

**Plan self-review**

- Spec coverage: covers source unification, config removal, remaining-today replacement entity, training refactor, public contract cleanup, and verification.
- Placeholder scan: no TODO/TBD markers remain; each task names exact files and commands.
- Type consistency: final model consistently uses `source_config_entry_id` + provider `wh_hours` for forecast and leaves actual production on the configured actual-energy source.

