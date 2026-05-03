# Upstream Solar Forecast Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Helman's legacy `daily_energy_entity_ids` solar-forecast config with one upstream solar forecast provider config entry, while preserving corrected-forecast output and keeping solar-bias training functional where provider-owned forecast entities are discoverable.

**Architecture:** Add a backend source-resolver layer that owns provider eligibility, legacy-config migration, and provider-entity discovery. Live forecast ingestion moves to Home Assistant's Energy `async_get_solar_forecast(...)` contract, while solar-bias history continues through provider-owned `wh_period` entities discovered from the selected config entry when available. The config editor switches from a per-day entity list to a single provider picker fed by a backend websocket endpoint.

**Tech Stack:** Home Assistant config entries and Energy platform API, Python `unittest`/`pytest`, Lit/TypeScript config editor, Vite build.

---

## File Structure

### New files

- `custom_components/helman/solar_forecast_source.py`
  Owns upstream forecast provider discovery, eligibility checks, legacy migration helpers, current-provider forecast loading, and optional provider-entity discovery for solar-bias history.

- `tests/test_solar_forecast_source.py`
  Covers provider eligibility, self-exclusion, legacy migration, provider list payloads, and provider-entity discovery ordering.

- `custom_components/helman/frontend/test/solar-forecast-provider-model.test.ts`
  Covers frontend-only provider option labeling / empty-state / selected-value helpers.

### Existing files to modify

- `custom_components/helman/storage.py`
  Normalize stored config through one migration path so legacy `daily_energy_entity_ids` are removed from persisted config.

- `custom_components/helman/config_validation.py`
  Validate `source_config_entry_id` and stop treating `daily_energy_entity_ids` as an active user input.

- `custom_components/helman/websockets.py`
  Add websocket command for eligible upstream providers and use migration-aware config save/load handling.

- `custom_components/helman/forecast_builder.py`
  Replace daily-entity live forecast loading with Energy-provider ingestion via `wh_hours`.

- `custom_components/helman/solar_bias_correction/models.py`
  Replace `BiasConfig.daily_energy_entity_ids` with `source_config_entry_id`.

- `custom_components/helman/solar_bias_correction/forecast_history.py`
  Replace direct daily-entity config reads with provider-entity discovery based on the selected config entry.

- `custom_components/helman/solar_bias_correction/service.py`
  Stop deriving future horizon from `daily_energy_entity_ids`; use discovered provider horizon or current live raw forecast dates.

- `tests/test_config_validation.py`
  Replace legacy config expectations with `source_config_entry_id` validation coverage.

- `tests/test_forecast_builder_actual_history.py`
  Assert live solar forecast is read from Energy provider `wh_hours`.

- `tests/test_solar_bias_models.py`
  Assert `read_bias_config` reads `source_config_entry_id`.

- `tests/test_solar_bias_inspector.py`
  Assert forecast-history loading uses provider-owned discovered entities and empty discovery behaves safely.

- `custom_components/helman/frontend/src/helman-config-editor.ts`
  Remove daily-entity list UI and render one upstream provider picker.

- `custom_components/helman/frontend/src/config-editor-scopes.ts`
  Replace `daily_energy_entity_ids` projection with `source_config_entry_id`.

- `custom_components/helman/frontend/src/types.ts`
  Add typed payloads for upstream forecast provider options.

- `custom_components/helman/frontend/src/localize/translations/en.json`
- `custom_components/helman/frontend/src/localize/translations/cs.json`
  Replace daily-entity text with provider-picker text and empty-state messaging.

- `custom_components/helman/frontend/dist/helman-config-editor.js`
  Rebuilt artifact committed alongside frontend source changes.

---

### Task 1: Add backend source resolver and legacy migration

**Files:**
- Create: `custom_components/helman/solar_forecast_source.py`
- Create: `tests/test_solar_forecast_source.py`
- Modify: `custom_components/helman/__init__.py`

- [x] **Step 1: Write the failing backend tests for provider eligibility and migration**

Add `tests/test_solar_forecast_source.py` with focused tests for supported entries, self-exclusion, and config migration:

```python
from __future__ import annotations

from types import SimpleNamespace

from custom_components.helman.solar_forecast_source import (
    infer_source_config_entry_id_from_legacy_entities,
    is_supported_solar_forecast_entry,
    migrate_legacy_solar_forecast_config,
)


class _FakeConfigEntry:
    def __init__(self, entry_id: str, domain: str, title: str = "Forecast") -> None:
        self.entry_id = entry_id
        self.domain = domain
        self.title = title


class _FakeConfigEntries:
    def __init__(self, entries: dict[str, _FakeConfigEntry]) -> None:
        self._entries = entries

    def async_get_entry(self, entry_id: str):
        return self._entries.get(entry_id)

    def async_entries(self, domain: str | None = None):
        entries = list(self._entries.values())
        if domain is None:
            return entries
        return [entry for entry in entries if entry.domain == domain]


def test_is_supported_solar_forecast_entry_rejects_helman_self():
    hass = SimpleNamespace(config_entries=_FakeConfigEntries({
        "helman-entry": _FakeConfigEntry("helman-entry", "helman", "Helman"),
    }))

    assert is_supported_solar_forecast_entry(
        hass,
        "helman-entry",
        supported_domains={"helman", "forecast_solar"},
        helman_entry_id="helman-entry",
    ) is False


def test_infer_source_config_entry_id_from_legacy_entities_returns_single_match():
    entity_entries = {
        "sensor.energy_production_today": SimpleNamespace(config_entry_id="forecast-entry"),
        "sensor.energy_production_tomorrow": SimpleNamespace(config_entry_id="forecast-entry"),
    }

    inferred = infer_source_config_entry_id_from_legacy_entities(
        ["sensor.energy_production_today", "sensor.energy_production_tomorrow"],
        entity_entries=entity_entries,
        supported_entry_ids={"forecast-entry"},
        helman_entry_id="helman-entry",
    )

    assert inferred == "forecast-entry"


def test_migrate_legacy_solar_forecast_config_removes_daily_entities_when_inference_fails():
    config = {
        "power_devices": {
            "solar": {
                "forecast": {
                    "daily_energy_entity_ids": ["sensor.day_1", "sensor.day_2"],
                    "total_energy_entity_id": "sensor.solar_total",
                }
            }
        }
    }

    migrated = migrate_legacy_solar_forecast_config(
        config,
        inferred_source_config_entry_id=None,
    )

    forecast = migrated["power_devices"]["solar"]["forecast"]
    assert "daily_energy_entity_ids" not in forecast
    assert forecast.get("source_config_entry_id") is None
```

- [x] **Step 2: Run the new test file and verify failure**

Run:

```bash
pytest tests/test_solar_forecast_source.py -q
```

Expected: FAIL with `ModuleNotFoundError` for `custom_components.helman.solar_forecast_source` and missing helper functions.

- [x] **Step 3: Implement the new resolver module and expose Helman's own entry ID**

Create `custom_components/helman/solar_forecast_source.py` with pure helpers first, then wire `__init__.py` to remember Helman's entry ID for self-exclusion:

```python
from __future__ import annotations

from copy import deepcopy
from typing import Any

from homeassistant.components.energy.websocket_api import async_get_energy_platforms
from homeassistant.helpers import entity_registry as er

from .const import DOMAIN


def is_supported_solar_forecast_entry(
    hass,
    config_entry_id: str | None,
    *,
    supported_domains: set[str],
    helman_entry_id: str | None,
) -> bool:
    if not isinstance(config_entry_id, str) or not config_entry_id.strip():
        return False
    entry = hass.config_entries.async_get_entry(config_entry_id.strip())
    if entry is None:
        return False
    if helman_entry_id is not None and entry.entry_id == helman_entry_id:
        return False
    return entry.domain in supported_domains


def infer_source_config_entry_id_from_legacy_entities(
    daily_energy_entity_ids: list[str],
    *,
    entity_entries: dict[str, Any],
    supported_entry_ids: set[str],
    helman_entry_id: str | None,
) -> str | None:
    candidate_ids: set[str] = set()
    for entity_id in daily_energy_entity_ids:
        entry = entity_entries.get(entity_id)
        config_entry_id = getattr(entry, "config_entry_id", None)
        if not isinstance(config_entry_id, str):
            continue
        if helman_entry_id is not None and config_entry_id == helman_entry_id:
            continue
        if config_entry_id in supported_entry_ids:
            candidate_ids.add(config_entry_id)
    return next(iter(candidate_ids)) if len(candidate_ids) == 1 else None


def migrate_legacy_solar_forecast_config(
    config: dict[str, Any],
    *,
    inferred_source_config_entry_id: str | None,
) -> dict[str, Any]:
    migrated = deepcopy(config)
    forecast = (
        migrated.setdefault("power_devices", {})
        .setdefault("solar", {})
        .setdefault("forecast", {})
    )
    forecast.pop("daily_energy_entity_ids", None)
    if inferred_source_config_entry_id:
        forecast["source_config_entry_id"] = inferred_source_config_entry_id
    return migrated


async def async_list_supported_solar_forecast_entries(hass) -> list[dict[str, str]]:
    supported_domains = set(await async_get_energy_platforms(hass))
    helman_entries = hass.config_entries.async_entries(DOMAIN)
    helman_entry_id = helman_entries[0].entry_id if helman_entries else None
    payload: list[dict[str, str]] = []
    for entry in hass.config_entries.async_entries():
        if not is_supported_solar_forecast_entry(
            hass,
            entry.entry_id,
            supported_domains=supported_domains,
            helman_entry_id=helman_entry_id,
        ):
            continue
        payload.append(
            {"entry_id": entry.entry_id, "title": entry.title, "domain": entry.domain}
        )
    payload.sort(key=lambda item: (item["title"].lower(), item["entry_id"]))
    return payload
```

In `custom_components/helman/__init__.py`, persist Helman's entry ID:

```python
    domain_data["entry_id"] = entry.entry_id
```

and remove it on unload:

```python
    hass.data[DOMAIN].pop("entry_id", None)
```

- [x] **Step 4: Run the new source-resolver tests and verify they pass**

Run:

```bash
pytest tests/test_solar_forecast_source.py -q
```

Expected: PASS for the new resolver and migration tests.

- [x] **Step 5: Commit**

```bash
git add custom_components/helman/solar_forecast_source.py \
        custom_components/helman/__init__.py \
        tests/test_solar_forecast_source.py
git commit -m "feat: add solar forecast source resolver"
```

### Task 2: Normalize stored config and validate `source_config_entry_id`

**Files:**
- Modify: `custom_components/helman/storage.py`
- Modify: `custom_components/helman/config_validation.py`
- Modify: `tests/test_config_validation.py`

- [x] **Step 1: Write failing config-validation tests for the new field**

Add tests near the solar forecast section in `tests/test_config_validation.py`:

```python
def test_solar_forecast_source_config_entry_id_accepts_non_empty_string():
    config = _valid_config()
    forecast = config["power_devices"]["solar"]["forecast"]
    forecast.pop("daily_energy_entity_ids", None)
    forecast["source_config_entry_id"] = "forecast-entry"

    report = validate_config_document(config)

    assert report.valid is True


def test_solar_forecast_source_config_entry_id_rejects_blank_string():
    config = _valid_config()
    forecast = config["power_devices"]["solar"]["forecast"]
    forecast.pop("daily_energy_entity_ids", None)
    forecast["source_config_entry_id"] = "   "

    report = validate_config_document(config)

    assert any(
        issue.path == "power_devices.solar.forecast.source_config_entry_id"
        for issue in report.errors
    )
```

- [x] **Step 2: Run the validation tests and confirm failure**

Run:

```bash
pytest tests/test_config_validation.py -q
```

Expected: FAIL because `source_config_entry_id` is not yet validated and `_valid_config()` still depends on `daily_energy_entity_ids`.

- [x] **Step 3: Implement config normalization in storage and validation for the new field**

In `custom_components/helman/storage.py`, normalize loaded and saved config through the migration helper:

```python
from .solar_forecast_source import migrate_legacy_solar_forecast_config


    async def async_load(self) -> None:
        stored = await self._store.async_load()
        merged = {**DEFAULT_CONFIG, **(stored or {})}
        self._config = migrate_legacy_solar_forecast_config(
            merged,
            inferred_source_config_entry_id=None,
        )
```

and in `async_save`:

```python
    async def async_save(self, new_config: dict[str, Any]) -> None:
        normalized = migrate_legacy_solar_forecast_config(
            new_config,
            inferred_source_config_entry_id=(
                new_config.get("power_devices", {})
                .get("solar", {})
                .get("forecast", {})
                .get("source_config_entry_id")
            ),
        )
        self._config = normalized
        await self._store.async_save(normalized)
```

In `custom_components/helman/config_validation.py`, replace the legacy list validation:

```python
    _validate_optional_entity_id(
        report,
        section,
        "power_devices.solar.forecast.total_energy_entity_id",
        forecast_map.get("total_energy_entity_id"),
    )

    source_config_entry_id = forecast_map.get("source_config_entry_id")
    if source_config_entry_id is not None:
        if not isinstance(source_config_entry_id, str) or not source_config_entry_id.strip():
            report.add_error(
                section=section,
                path="power_devices.solar.forecast.source_config_entry_id",
                code="invalid_type",
                message="power_devices.solar.forecast.source_config_entry_id must be a non-empty string",
            )
```

Update `_valid_config()` in `tests/test_config_validation.py` to use:

```python
                "forecast": {
                    "source_config_entry_id": "forecast-entry",
                    "total_energy_entity_id": "sensor.solar_total",
                },
```

- [x] **Step 4: Run the validation tests and verify pass**

Run:

```bash
pytest tests/test_config_validation.py -q
```

Expected: PASS with the base config updated to `source_config_entry_id`.

- [x] **Step 5: Commit**

```bash
git add custom_components/helman/storage.py \
        custom_components/helman/config_validation.py \
        tests/test_config_validation.py
git commit -m "feat: validate solar forecast source config entry"
```

### Task 3: Add provider-list websocket and migration-aware config save path

**Files:**
- Modify: `custom_components/helman/websockets.py`
- Modify: `custom_components/helman/storage.py`
- Modify: `tests/test_config_editor_contract.py`
- Modify: `tests/test_solar_forecast_source.py`

- [x] **Step 1: Write failing websocket-contract tests for provider discovery and legacy cleanup**

Add tests to `tests/test_config_editor_contract.py`:

```python
def test_get_solar_forecast_sources_returns_supported_entries_only():
    # expected payload shape:
    # [{"entry_id": "forecast-entry", "title": "Forecast.Solar", "domain": "forecast_solar"}]
    ...


def test_save_config_strips_legacy_daily_energy_entity_ids_from_persisted_config():
    config = {
        "power_devices": {
            "solar": {
                "forecast": {
                    "daily_energy_entity_ids": ["sensor.energy_production_today"],
                    "source_config_entry_id": "forecast-entry",
                }
            }
        }
    }
    ...
    assert "daily_energy_entity_ids" not in saved["power_devices"]["solar"]["forecast"]
```

Use the existing websocket-test pattern from this file rather than inventing a new harness.

- [x] **Step 2: Run the websocket contract tests and verify failure**

Run:

```bash
pytest tests/test_config_editor_contract.py -q
```

Expected: FAIL because the `helman/get_solar_forecast_sources` command does not exist and save-path normalization does not yet strip legacy fields after inference.

- [x] **Step 3: Implement the new websocket endpoint and migration-aware save path**

In `custom_components/helman/websockets.py`, register and implement a new command:

```python
from .solar_forecast_source import (
    async_list_supported_solar_forecast_entries,
    async_migrate_legacy_solar_forecast_config,
)


@websocket_api.websocket_command({
    vol.Required("type"): "helman/get_solar_forecast_sources",
})
@websocket_api.async_response
async def ws_get_solar_forecast_sources(hass, connection, msg):
    if not _require_admin(connection, msg):
        return
    connection.send_result(
        msg["id"],
        await async_list_supported_solar_forecast_entries(hass),
    )
```

Register it:

```python
    async_register_command(hass, ws_get_solar_forecast_sources)
```

Normalize config before validation/save:

```python
    normalized_config = await async_migrate_legacy_solar_forecast_config(
        hass,
        msg["config"],
    )
    validation = validate_config_document(normalized_config)
    ...
    await stor.async_save(normalized_config)
```

In `custom_components/helman/solar_forecast_source.py`, add the async migration helper:

```python
async def async_migrate_legacy_solar_forecast_config(hass, config: dict[str, Any]) -> dict[str, Any]:
    registry = er.async_get(hass)
    supported = await async_list_supported_solar_forecast_entries(hass)
    supported_entry_ids = {item["entry_id"] for item in supported}
    helman_entry_id = hass.data.get(DOMAIN, {}).get("entry_id")

    forecast = (
        config.get("power_devices", {})
        .get("solar", {})
        .get("forecast", {})
    )
    legacy_ids = forecast.get("daily_energy_entity_ids") or []
    inferred = infer_source_config_entry_id_from_legacy_entities(
        legacy_ids,
        entity_entries={entity_id: registry.async_get(entity_id) for entity_id in legacy_ids},
        supported_entry_ids=supported_entry_ids,
        helman_entry_id=helman_entry_id,
    )
    return migrate_legacy_solar_forecast_config(
        config,
        inferred_source_config_entry_id=inferred or forecast.get("source_config_entry_id"),
    )
```

- [x] **Step 4: Run websocket and source tests**

Run:

```bash
pytest tests/test_config_editor_contract.py tests/test_solar_forecast_source.py -q
```

Expected: PASS with provider-list payloads and config-save normalization working.

- [x] **Step 5: Commit**

```bash
git add custom_components/helman/websockets.py \
        custom_components/helman/storage.py \
        custom_components/helman/solar_forecast_source.py \
        tests/test_config_editor_contract.py \
        tests/test_solar_forecast_source.py
git commit -m "feat: expose solar forecast provider selection"
```

### Task 4: Switch live solar forecast building to Energy-provider `wh_hours`

**Files:**
- Modify: `custom_components/helman/forecast_builder.py`
- Modify: `tests/test_forecast_builder_actual_history.py`

- [x] **Step 1: Write the failing forecast-builder tests for provider-backed live forecast**

Replace the daily-entity live test in `tests/test_forecast_builder_actual_history.py` with provider-based expectations:

```python
    async def test_build_solar_forecast_reads_points_from_source_config_entry_id(self) -> None:
        _, builder = self._make_builder()
        builder._config = {
            "power_devices": {
                "solar": {
                    "forecast": {
                        "source_config_entry_id": "forecast-entry",
                    },
                    "entities": {
                        "remaining_today_energy_forecast": "sensor.remaining_today_energy",
                    },
                }
            }
        }

        with (
            patch.object(builder, "_build_solar_actual_history", AsyncMock(return_value=[])),
            patch("custom_components.helman.forecast_builder.async_load_upstream_solar_forecast",
                  AsyncMock(return_value={
                      "wh_hours": {
                          "2026-03-20T10:00:00+01:00": 250.0,
                          "2026-03-20T11:00:00+01:00": 300.0,
                      }
                  })),
        ):
            payload = await builder._build_solar_forecast(REFERENCE_TIME)

        assert payload["status"] == "available"
        assert payload["points"] == [
            {"timestamp": "2026-03-20T10:00:00+01:00", "value": 250.0},
            {"timestamp": "2026-03-20T11:00:00+01:00", "value": 300.0},
        ]
```

- [x] **Step 2: Run the targeted forecast-builder test and confirm failure**

Run:

```bash
pytest tests/test_forecast_builder_actual_history.py -q
```

Expected: FAIL because `forecast_builder.py` still reads `daily_energy_entity_ids`.

- [x] **Step 3: Implement provider-backed live forecast loading**

In `custom_components/helman/forecast_builder.py`, replace the legacy list logic with a provider loader:

```python
from .solar_forecast_source import async_load_upstream_solar_forecast


    async def _build_solar_forecast(self, reference_time: datetime) -> dict[str, Any]:
        power_devices = self._read_dict(self._config.get("power_devices"))
        solar_config = self._read_dict(power_devices.get("solar"))
        solar_forecast = self._read_dict(solar_config.get("forecast"))
        source_config_entry_id = self._read_entity_id(
            solar_forecast.get("source_config_entry_id")
        )

        if source_config_entry_id is None:
            return {
                "status": "not_configured",
                "unit": None,
                "actualHistory": [],
                "points": [],
            }

        upstream = await async_load_upstream_solar_forecast(
            self._hass,
            source_config_entry_id,
        )
        points = self._build_points_from_wh_hours(upstream.get("wh_hours"))
        status = "available" if points else "unavailable"
        actual_history = await self._build_solar_actual_history(
            reference_time,
            interval_minutes=FORECAST_CANONICAL_GRANULARITY_MINUTES,
        )
        return {
            "status": status,
            "unit": "Wh" if points else None,
            "remainingTodayEnergyEntityId": self._read_entity_id(
                self._read_dict(solar_config.get("entities")).get("remaining_today_energy_forecast")
            ),
            "actualHistory": actual_history,
            "points": points,
        }
```

Add a point adapter helper:

```python
    def _build_points_from_wh_hours(self, raw_wh_hours: Any) -> list[dict[str, Any]]:
        if not isinstance(raw_wh_hours, dict):
            return []
        parsed: list[tuple[datetime, float]] = []
        for timestamp, value in raw_wh_hours.items():
            parsed_timestamp = self._parse_attribute_timestamp(timestamp)
            parsed_value = self._parse_float(value)
            if parsed_timestamp is None or parsed_value is None:
                continue
            parsed.append((parsed_timestamp, parsed_value))
        parsed.sort(key=lambda item: dt_util.as_utc(item[0]))
        return [
            {"timestamp": point_time.isoformat(), "value": value}
            for point_time, value in parsed
        ]
```

- [x] **Step 4: Run the forecast-builder tests and confirm pass**

Run:

```bash
pytest tests/test_forecast_builder_actual_history.py -q
```

Expected: PASS with live solar forecast points now coming from provider `wh_hours`.

- [x] **Step 5: Commit**

```bash
git add custom_components/helman/forecast_builder.py \
        tests/test_forecast_builder_actual_history.py
git commit -m "feat: read live solar forecast from provider contract"
```

### Task 5: Rewire solar-bias history to the selected provider

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/models.py`
- Modify: `custom_components/helman/solar_bias_correction/forecast_history.py`
- Modify: `custom_components/helman/solar_bias_correction/service.py`
- Modify: `tests/test_solar_bias_models.py`
- Modify: `tests/test_solar_bias_inspector.py`

- [x] **Step 1: Write failing solar-bias model and inspector tests for provider-based history**

In `tests/test_solar_bias_models.py`, replace the legacy config assertion:

```python
def test_read_nested_config_reads_source_config_entry_id():
    config = {
        "power_devices": {
            "solar": {
                "forecast": {
                    "source_config_entry_id": "forecast-entry",
                    "total_energy_entity_id": "sensor.total",
                }
            }
        }
    }

    bias = read_bias_config(config)

    assert bias.source_config_entry_id == "forecast-entry"
    assert bias.total_energy_entity_id == "sensor.total"
```

In `tests/test_solar_bias_inspector.py`, replace `_make_cfg()` and add a provider-entity discovery test:

```python
def _make_cfg():
    return models.BiasConfig(
        enabled=True,
        min_history_days=2,
        training_time="03:00",
        clamp_min=0.3,
        clamp_max=2.0,
        aggregation_method="ratio_of_sums",
        source_config_entry_id="forecast-entry",
        total_energy_entity_id="sensor.solar_total",
    )


def test_load_forecast_points_for_day_discovers_provider_entities():
    hass = SimpleNamespace(
        states=_States(),
        config=SimpleNamespace(time_zone="Europe/Prague"),
    )

    with patch(
        "custom_components.helman.solar_bias_correction.forecast_history.discover_provider_daily_forecast_entities",
        return_value=["sensor.solar_today", "sensor.solar_tomorrow"],
    ):
        result = asyncio.run(
            forecast_history.load_forecast_points_for_day(
                hass,
                _make_cfg(),
                date.fromisoformat("2026-04-25"),
                local_now=datetime.fromisoformat("2026-04-25T10:00:00+02:00"),
            )
        )

    assert result[0]["timestamp"] == "2026-04-25T00:00:00+02:00"
```

- [x] **Step 2: Run the targeted solar-bias tests and confirm failure**

Run:

```bash
pytest tests/test_solar_bias_models.py tests/test_solar_bias_inspector.py -q
```

Expected: FAIL because `BiasConfig` and `forecast_history.py` still depend on `daily_energy_entity_ids`.

- [x] **Step 3: Implement provider-based bias config and optional entity discovery**

In `custom_components/helman/solar_bias_correction/models.py`, change `BiasConfig`:

```python
@dataclass
class BiasConfig:
    enabled: bool
    min_history_days: int
    training_time: str
    clamp_min: float
    clamp_max: float
    source_config_entry_id: str | None
    total_energy_entity_id: str | None
```

and in `read_bias_config`:

```python
    source_config_entry_id = forecast.get("source_config_entry_id")
    if not isinstance(source_config_entry_id, str) or not source_config_entry_id.strip():
        source_config_entry_id = None
```

In `custom_components/helman/solar_forecast_source.py`, add optional entity discovery:

```python
def discover_provider_daily_forecast_entities(hass, source_config_entry_id: str | None) -> list[str]:
    if not source_config_entry_id:
        return []
    registry = er.async_get(hass)
    candidates: list[tuple[str, str]] = []
    for entry in er.async_entries_for_config_entry(registry, source_config_entry_id):
        state = hass.states.get(entry.entity_id)
        attributes = getattr(state, "attributes", {})
        wh_period = attributes.get("wh_period") if isinstance(attributes, dict) else None
        if not isinstance(wh_period, dict) or not wh_period:
            continue
        first_timestamp = min(str(key) for key in wh_period)
        candidates.append((first_timestamp, entry.entity_id))
    candidates.sort()
    return [entity_id for _, entity_id in candidates]
```

Then in `custom_components/helman/solar_bias_correction/forecast_history.py`:

```python
from ..solar_forecast_source import discover_provider_daily_forecast_entities


    entity_ids = discover_provider_daily_forecast_entities(
        hass,
        cfg.source_config_entry_id,
    )
    if not entity_ids:
        return []
```

In `custom_components/helman/solar_bias_correction/service.py`, stop using `len(self._cfg.daily_energy_entity_ids)` and derive future range from provider discovery:

```python
        provider_entities = discover_provider_daily_forecast_entities(
            self._hass,
            self._cfg.source_config_entry_id,
        )
        max_date = today + timedelta(days=max(len(provider_entities) - 1, 0))
```

This keeps training/inspector working when the chosen provider still owns compatible `wh_period` entities, and safely degrades to no history when it does not.

- [x] **Step 4: Run the solar-bias tests and confirm pass**

Run:

```bash
pytest tests/test_solar_bias_models.py tests/test_solar_bias_inspector.py -q
```

Expected: PASS with `source_config_entry_id` replacing legacy list config and forecast-history discovery using provider-owned entities.

- [x] **Step 5: Commit**

```bash
git add custom_components/helman/solar_bias_correction/models.py \
        custom_components/helman/solar_bias_correction/forecast_history.py \
        custom_components/helman/solar_bias_correction/service.py \
        custom_components/helman/solar_forecast_source.py \
        tests/test_solar_bias_models.py \
        tests/test_solar_bias_inspector.py
git commit -m "feat: use selected provider for solar bias history"
```

### Task 6: Replace frontend daily-entity UI with provider picker

**Files:**
- Modify: `custom_components/helman/frontend/src/types.ts`
- Modify: `custom_components/helman/frontend/src/config-editor-scopes.ts`
- Modify: `custom_components/helman/frontend/src/helman-config-editor.ts`
- Modify: `custom_components/helman/frontend/src/localize/translations/en.json`
- Modify: `custom_components/helman/frontend/src/localize/translations/cs.json`
- Create: `custom_components/helman/frontend/test/solar-forecast-provider-model.test.ts`
- Modify: `custom_components/helman/frontend/dist/helman-config-editor.js`

- [x] **Step 1: Write the failing frontend helper test**

Create `custom_components/helman/frontend/test/solar-forecast-provider-model.test.ts`:

```ts
import { buildSolarForecastProviderLabel } from "../src/helman-config-editor.js";

function assertEqual(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
  }
}

assertEqual(
  buildSolarForecastProviderLabel({
    entry_id: "forecast-entry",
    title: "Forecast.Solar Roof",
    domain: "forecast_solar",
  }),
  "Forecast.Solar Roof (forecast_solar)",
);
```

- [x] **Step 2: Run the TypeScript compile for the new frontend test and confirm failure**

Run:

```bash
cd custom_components/helman/frontend
npx tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 test/solar-forecast-provider-model.test.ts
```

Expected: FAIL because `buildSolarForecastProviderLabel` and provider types do not exist.

- [x] **Step 3: Implement frontend provider types, picker UI, and translations**

In `custom_components/helman/frontend/src/types.ts`, add:

```ts
export interface SolarForecastSourceOption {
  entry_id: string;
  title: string;
  domain: string;
}
```

In `custom_components/helman/frontend/src/config-editor-scopes.ts`, replace the forecast projection member:

```ts
const SOLAR_FORECAST_GENERAL_PROJECTION_MEMBERS = [
  {
    yamlKey: "total_energy_entity_id",
    documentPath: ["power_devices", "solar", "forecast", "total_energy_entity_id"],
  },
  {
    yamlKey: "source_config_entry_id",
    documentPath: ["power_devices", "solar", "forecast", "source_config_entry_id"],
  },
] satisfies ScopeProjectionMember[];
```

In `custom_components/helman/frontend/src/helman-config-editor.ts`, remove `dailyEnergyEntityIds` and add provider fetch/render helpers:

```ts
export function buildSolarForecastProviderLabel(option: SolarForecastSourceOption): string {
  return `${option.title} (${option.domain})`;
}

private _solarForecastSourceOptions: SolarForecastSourceOption[] = [];

private async _loadSolarForecastSourceOptions(): Promise<void> {
  if (!this.hass) {
    return;
  }
  const result = await this.hass.callWS<SolarForecastSourceOption[]>({
    type: "helman/get_solar_forecast_sources",
  });
  this._solarForecastSourceOptions = Array.isArray(result) ? result : [];
}
```

Render one picker in the solar forecast section:

```ts
<div class="field">
  <label>${this._t("editor.fields.solar_forecast_source")}</label>
  <select
    .value=${this._stringValue(this._getValue(["power_devices", "solar", "forecast", "source_config_entry_id"]))}
    @change=${(event: Event) => {
      const value = (event.target as HTMLSelectElement).value;
      this._setOptionalString(["power_devices", "solar", "forecast", "source_config_entry_id"], value);
    }}
  >
    <option value="">${this._t("editor.actions.select_option")}</option>
    ${this._solarForecastSourceOptions.map(
      (option) => html`<option value=${option.entry_id}>${buildSolarForecastProviderLabel(option)}</option>`
    )}
  </select>
</div>
```

and empty-state note:

```ts
${this._solarForecastSourceOptions.length === 0
  ? html`<p class="inline-note">${this._t("editor.help.solar_forecast_source_empty")}</p>`
  : nothing}
```

Update translations:

```json
"solar_forecast_source": "Upstream solar forecast provider",
"solar_forecast_source_empty": "No eligible solar forecast providers were found. Install or configure an integration that exposes a Home Assistant Energy solar forecast."
```

- [x] **Step 4: Run frontend verification and rebuild dist**

Run:

```bash
cd custom_components/helman/frontend
npx tsc --noEmit
npx tsc --outDir /tmp/helman-frontend-test --module NodeNext --moduleResolution NodeNext --target ES2022 test/solar-forecast-provider-model.test.ts
node /tmp/helman-frontend-test/test/solar-forecast-provider-model.test.js
npm run build
```

Expected:
- `npx tsc --noEmit` succeeds
- compiled helper test exits with no output
- `vite build` succeeds and updates `dist/helman-config-editor.js`

- [x] **Step 5: Commit**

```bash
git add custom_components/helman/frontend/src/types.ts \
        custom_components/helman/frontend/src/config-editor-scopes.ts \
        custom_components/helman/frontend/src/helman-config-editor.ts \
        custom_components/helman/frontend/src/localize/translations/en.json \
        custom_components/helman/frontend/src/localize/translations/cs.json \
        custom_components/helman/frontend/test/solar-forecast-provider-model.test.ts \
        custom_components/helman/frontend/dist/helman-config-editor.js
git commit -m "feat: replace solar daily entities with provider picker"
```

### Task 7: Run cross-cutting regression verification

**Files:**
- Modify: none
- Test: `tests/test_solar_forecast_source.py`
- Test: `tests/test_config_validation.py`
- Test: `tests/test_config_editor_contract.py`
- Test: `tests/test_forecast_builder_actual_history.py`
- Test: `tests/test_solar_bias_models.py`
- Test: `tests/test_solar_bias_inspector.py`

- [x] **Step 1: Run the backend regression subset**

Run:

```bash
pytest tests/test_solar_forecast_source.py \
       tests/test_config_validation.py \
       tests/test_config_editor_contract.py \
       tests/test_forecast_builder_actual_history.py \
       tests/test_solar_bias_models.py \
       tests/test_solar_bias_inspector.py -q
```

Expected: PASS for all targeted backend/config/bias/provider tests.

- [x] **Step 2: Re-run frontend verification**

Run:

```bash
cd custom_components/helman/frontend
npx tsc --noEmit
npm run build
```

Expected: PASS and `dist/helman-config-editor.js` remains up to date.

- [x] **Step 3: Sanity-check the worktree**

Run:

```bash
git status --short
```

Expected: clean worktree or only intentional uncommitted changes outside this feature.

- [x] **Step 4: Commit final verification marker if needed**

```bash
git add -A
git commit -m "test: verify upstream solar forecast provider migration"
```

Only create this commit if Task 7 required follow-up fixes. If Task 6 already left the branch clean and fully verified, skip this commit.

---

## Self-Review

### Spec coverage

- Single Helman-owned `source_config_entry_id`: covered in Tasks 2, 3, and 6.
- No Energy-preferences coupling: covered by provider resolver in Tasks 1 and 3.
- Live forecast via Energy-provider `wh_hours`: covered in Task 4.
- Helman self-exclusion: covered in Tasks 1 and 3.
- Legacy migration and removal of `daily_energy_entity_ids`: covered in Tasks 1, 2, and 3.
- Frontend picker and empty state: covered in Task 6.
- Solar-bias continuity: covered in Task 5 with provider-owned entity discovery.

### Placeholder scan

- No `TBD` / `TODO` placeholders remain.
- Every task includes exact files, commands, and concrete code snippets.

### Type consistency

- New config field is consistently named `source_config_entry_id`.
- Helper module is consistently named `solar_forecast_source.py`.
- Frontend option payload is consistently named `SolarForecastSourceOption`.

### Implementation note for the engineer

The approved spec assumes Energy-provider live forecast consumption is generic. In practice, solar-bias training history cannot be reconstructed from the Energy contract alone. This plan addresses that by discovering provider-owned `wh_period` entities from the selected config entry when available; if a provider exposes the Energy contract but no compatible entities, live forecast continues to work while solar-bias history safely degrades to unavailable rather than silently resurrecting legacy config.
