# Canonical Solar Forecast Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make corrected solar forecast values identical across `helman/get_forecast`, solar bias inspector, Helman day entities, and `today_remaining`.

**Architecture:** The canonical 15-minute solar snapshot stores raw and corrected series side by side. `solar.points` is raw canonical forecast, `adjustedPoints` is corrected canonical forecast when solar bias correction is effectively adjusted, and every corrected surface aggregates the canonical corrected series. One shared refresh/invalidation path rebuilds the canonical snapshot when upstream forecast inputs or solar bias state changes.

**Tech Stack:** Home Assistant custom integration, Python async coordinator, websocket response serialization, pytest/unittest test suite.

---

## Source Decision

This plan implements the agreed approach in `docs/features/forecast/solar-forecast-bias-correction/solar-forecast-discrepancy-analysis-2026-05-05.md`.

The contract after this plan:

- `solar.points`: raw canonical solar forecast.
- `solar.adjustedPoints`: corrected canonical solar forecast when `effectiveVariant == "adjusted"`.
- `solar.biasCorrection`: metadata describing solar bias state whenever the bias service produced a result, regardless of variant. Consumers branch on `effectiveVariant` (`"raw"` or `"adjusted"`).
- Helman solar day entities: aggregate corrected canonical points.
- Solar bias inspector `series.raw` and `series.corrected` (today/future): both come from canonical `rawPoints` / `correctedPoints`, aggregated to hourly buckets to stay slot-aligned with hourly actuals.

Internal-only:

- `_cached_solar_forecast` stores `rawPoints` and `correctedPoints` as side-by-side cache slots. These names are not part of the public `helman/get_forecast` response — `rawPoints` is dropped from the public surface.

## Breaking Changes

- `helman/get_forecast` `solar.points` semantics flip from corrected → raw. Any external consumer treating `points` as corrected must switch to `adjustedPoints`.
- `helman/get_forecast` `solar.rawPoints` is removed. Use `points` (now raw).
- `helman/get_forecast` `solar.adjustedPoints` and `solar.biasCorrection` are now reliably populated whenever bias correction has produced a result.

Migration: hard cutover, no compat shim. CHANGELOG entry lands with Task 7.

## File Map

- Modify `custom_components/helman/coordinator.py`
  - Stop overwriting canonical `points` with adjusted points.
  - Store `rawPoints`, `correctedPoints`, and correction metadata in `_cached_solar_forecast`.
  - Serialize `get_forecast()` with raw `points` and corrected `adjustedPoints`.
  - Change day entity aggregation to use corrected canonical points.
  - Register upstream forecast and solar bias invalidation.
- Modify `custom_components/helman/solar_bias_correction/response.py`
  - Extract reusable bias metadata serialization.
  - Build response from raw snapshot plus corrected canonical points without changing raw `points`.
- Modify `custom_components/helman/solar_bias_correction/service.py`
  - Accept a canonical forecast provider.
  - For today/future inspector dates, source both `series.raw` and `series.corrected` from canonical `rawPoints` / `correctedPoints`, hourly-aggregated. The `wh_period` re-extraction path is dropped for current/future dates.
  - Past inspector dates: keep recorder/history path unchanged.
  - Emit `helman_solar_bias_status_changed` on `(status, effective_variant)` transitions.
- Modify `custom_components/helman/point_forecast_response.py`
  - Remove the raw fallback that mutates empty `points` from `rawPoints`, once coordinator always supplies explicit raw `points`.
- Modify `custom_components/helman/energy.py`
  - Keep consuming `adjustedPoints` first and raw `points` only as fallback when correction is inactive or unavailable.
- Modify tests:
  - `tests/test_solar_forecast_cache.py`
  - `tests/test_solar_bias_response.py`
  - `tests/test_solar_bias_inspector.py`
  - `tests/test_sensor_forecast_entities.py`
  - `tests/test_energy_platform.py`
  - `tests/test_automation_input_bundle.py`
  - `tests/test_point_forecast_response.py`

---

### Task 1: Canonical Snapshot Stores Raw And Corrected Side By Side

**Files:**
- Modify: `custom_components/helman/coordinator.py`
- Test: `tests/test_solar_forecast_cache.py`

- [ ] **Step 1: Write failing test for canonical raw and corrected storage**

Add a test in `tests/test_solar_forecast_cache.py` near the existing solar cache tests:

```python
async def test_build_canonical_solar_forecast_keeps_raw_points_and_corrected_points_separate(self) -> None:
    coordinator_module, previous_modules = self._load_coordinator_module()
    try:
        coordinator = object.__new__(coordinator_module.HelmanCoordinator)
        coordinator._hass = SimpleNamespace()
        coordinator._active_config = {}

        raw_points = [
            {"timestamp": "2026-05-05T10:00:00+02:00", "value": 1000.0},
        ]
        adjusted_points = [
            {"timestamp": "2026-05-05T10:00:00+02:00", "value": 750.0},
        ]

        builder_instance = SimpleNamespace(
            build=AsyncMock(return_value={"solar": {"status": "available", "points": raw_points}})
        )
        bias_result = SimpleNamespace(
            status="applied",
            effective_variant="adjusted",
            adjusted_points=adjusted_points,
            explainability=None,
        )
        coordinator._solar_bias_service = SimpleNamespace(
            build_adjustment_result=Mock(return_value=bias_result)
        )

        with (
            patch.object(coordinator_module, "HelmanForecastBuilder", return_value=builder_instance, create=True),
            patch.object(
                coordinator_module,
                "build_solar_forecast_response",
                return_value={"status": "available", "points": raw_points},
                create=True,
            ),
        ):
            snapshot = await coordinator._async_build_canonical_solar_forecast(
                reference_time=REFERENCE_TIME
            )

        self.assertEqual(snapshot["points"], raw_points)
        self.assertEqual(snapshot["rawPoints"], raw_points)
        self.assertEqual(snapshot["correctedPoints"], adjusted_points)
        self.assertEqual(snapshot["biasCorrection"]["status"], "applied")
        self.assertEqual(snapshot["biasCorrection"]["effectiveVariant"], "adjusted")
    finally:
        _restore_modules(previous_modules)
        sys.modules.pop("custom_components.helman.coordinator", None)
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pytest tests/test_solar_forecast_cache.py::SolarForecastCacheTest::test_build_canonical_solar_forecast_keeps_raw_points_and_corrected_points_separate -q
```

Expected: FAIL because `_async_build_canonical_solar_forecast()` currently replaces `snapshot["points"]` with adjusted points and does not store `correctedPoints` or serialized `biasCorrection`.

- [ ] **Step 3: Add reusable bias metadata serialization**

In `custom_components/helman/solar_bias_correction/response.py`, extract the existing metadata body into a helper:

```python
def build_bias_correction_payload(
    adjustment_result: SolarBiasAdjustmentResult,
) -> dict[str, Any]:
    explainability = adjustment_result.explainability
    explainability_payload = {
        "fallbackReason": None,
        "trainedAt": None,
        "usableDays": 0,
        "droppedDays": 0,
        "omittedSlotCount": 0,
        "factorSummary": {
            "min": None,
            "max": None,
            "median": None,
        },
    }
    if explainability is not None:
        explainability_payload = {
            "fallbackReason": explainability.fallback_reason,
            "trainedAt": explainability.trained_at,
            "usableDays": explainability.usable_days,
            "droppedDays": explainability.dropped_days,
            "omittedSlotCount": explainability.omitted_slot_count,
            "factorSummary": {
                "min": explainability.factor_min,
                "max": explainability.factor_max,
                "median": explainability.factor_median,
            },
        }
        if explainability.error is not None:
            explainability_payload["error"] = explainability.error

    return {
        "status": adjustment_result.status,
        "effectiveVariant": adjustment_result.effective_variant,
        "explainability": explainability_payload,
    }
```

Then change `compose_solar_bias_response()` to call `build_bias_correction_payload(adjustment_result)` instead of duplicating the metadata construction inline.

- [ ] **Step 4: Store corrected points without overwriting raw points**

In `custom_components/helman/coordinator.py`, import the new helper:

```python
from .solar_bias_correction.response import build_bias_correction_payload
```

(The existing `compose_solar_bias_response` import in coordinator.py is unused under the new contract — `get_forecast()` calls `build_solar_forecast_response` with `corrected_points` directly. Remove the unused import as part of this step.)

Change `_async_build_canonical_solar_forecast()` so the relevant block reads:

```python
snapshot = deepcopy(canonical_raw)
raw_points = snapshot.get("points", []) or []
# snapshot["points"] is already a deepcopy via the snapshot deepcopy above.
# Keep rawPoints as an independent copy so future mutation can't alias.
snapshot["rawPoints"] = deepcopy(raw_points)
solar_bias_service = getattr(self, "_solar_bias_service", None)
if solar_bias_service is not None:
    bias_result = solar_bias_service.build_adjustment_result(
        raw_points,
        reference_time,
    )
    if bias_result is not None:
        # biasCorrection is stored regardless of variant so that consumers
        # always have an authoritative status/variant to branch on.
        snapshot["biasCorrection"] = build_bias_correction_payload(bias_result)
        if bias_result.effective_variant == "adjusted":
            snapshot["correctedPoints"] = deepcopy(bias_result.adjusted_points)
snapshot["generatedAt"] = reference_time.isoformat()
return snapshot
```

The cache keys `rawPoints` and `correctedPoints` are internal only; they are not surfaced on the `helman/get_forecast` public response (see Task 2). The inspector path (Task 4) reads these internal cache slots through the canonical provider injection, not as response fields.

- [ ] **Step 5: Run the test**

Run:

```bash
pytest tests/test_solar_forecast_cache.py::SolarForecastCacheTest::test_build_canonical_solar_forecast_keeps_raw_points_and_corrected_points_separate -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add custom_components/helman/coordinator.py custom_components/helman/solar_bias_correction/response.py tests/test_solar_forecast_cache.py
git commit -m "refactor: store canonical solar raw and corrected series"
```

---

### Task 2: `helman/get_forecast` Serializes Raw Points And Corrected Adjusted Points

**Files:**
- Modify: `custom_components/helman/coordinator.py`
- Modify: `custom_components/helman/point_forecast_response.py`
- Modify: `custom_components/helman/solar_bias_correction/response.py`
- Test: `tests/test_solar_forecast_cache.py`
- Test: `tests/test_solar_bias_response.py`
- Test: `tests/test_point_forecast_response.py` (or wherever `build_solar_forecast_response` is unit-tested)

**Design note:** instead of calling `build_solar_forecast_response()` twice (once for raw, once for corrected) and stitching the results, extend the helper to accept an optional `corrected_points` argument. The expansion / interval detection / day windowing / aggregation pipeline is factored into a private `_expand_and_window()` helper invoked twice with identical parameters but different point lists. This guarantees both series share interval, split factor, window, and rounding by construction. The public response also drops `rawPoints` — `points` carries raw under the new contract.

- [ ] **Step 1: Update response helper tests to encode the contract**

In `tests/test_solar_bias_response.py`, update the adjusted response test so it asserts:

```python
self.assertEqual(response["points"][0]["value"], 200.0)
self.assertEqual(response["adjustedPoints"][0]["value"], 300.0)
self.assertEqual(response["biasCorrection"]["effectiveVariant"], "adjusted")
self.assertNotIn("rawPoints", response)
```

In the raw-variant test, change the expectation so the response always carries `biasCorrection` (with `effectiveVariant: "raw"`) when the bias service produced a result, but does not expose `adjustedPoints`:

```python
self.assertNotIn("adjustedPoints", response)
self.assertEqual(response["biasCorrection"]["effectiveVariant"], "raw")
self.assertNotIn("rawPoints", response)
```

Add a unit test in `tests/test_point_forecast_response.py` that calls `build_solar_forecast_response(snapshot, corrected_points=[...], granularity=..., forecast_days=...)` and asserts both `points` and `adjustedPoints` reflect the same expansion (e.g., same number of points, same timestamps, values differ only by the per-slot bias factor).

- [ ] **Step 2: Write failing coordinator response test**

Replace `test_get_forecast_uses_cached_corrected_points_without_rebuilding_solar_snapshot` in `tests/test_solar_forecast_cache.py` with this contract:

```python
async def test_get_forecast_returns_raw_points_and_adjusted_points_from_cached_snapshot(self) -> None:
    coordinator_module, previous_modules = self._load_coordinator_module()
    try:
        coordinator = object.__new__(coordinator_module.HelmanCoordinator)
        coordinator._hass = SimpleNamespace()
        coordinator._active_config = {}
        coordinator._cached_forecast = {"status": "available"}
        coordinator._cached_solar_forecast = {
            "status": "available",
            "resolution": "15m",
            "horizonHours": 336,
            "generatedAt": REFERENCE_TIME.isoformat(),
            "points": [
                {"timestamp": "2026-05-03T10:00:00+02:00", "value": 1250.25}
            ],
            "rawPoints": [
                {"timestamp": "2026-05-03T10:00:00+02:00", "value": 1250.25}
            ],
            "correctedPoints": [
                {"timestamp": "2026-05-03T10:00:00+02:00", "value": 900.5}
            ],
            "biasCorrection": {
                "status": "applied",
                "effectiveVariant": "adjusted",
                "explainability": {},
            },
        }
        coordinator._storage = SimpleNamespace(config={})
        coordinator._read_house_forecast_config = Mock(
            return_value=("sensor.house_total", 56, 14, "fp")
        )
        coordinator._has_compatible_forecast_snapshot = Mock(return_value=True)
        coordinator._async_refresh_forecast_and_request_automation = AsyncMock()
        coordinator._async_get_appliance_forecast_pipeline = AsyncMock(
            return_value=SimpleNamespace(
                adjusted_house_forecast={"status": "available"},
                battery_forecast={"status": "available", "series": []},
            )
        )

        builder_instance = SimpleNamespace(
            build=AsyncMock(
                return_value={
                    "grid": {
                        "export": {"status": "available", "currentPrice": 2.5},
                        "import": {"status": "available", "currentPrice": 7.0},
                    }
                }
            )
        )

        def fake_solar_response(snapshot, **kwargs):
            return deepcopy(snapshot)

        with (
            patch.object(coordinator_module, "HelmanForecastBuilder", return_value=builder_instance, create=True),
            patch.object(coordinator_module, "build_solar_forecast_response", side_effect=fake_solar_response, create=True),
            patch.object(coordinator_module, "build_house_forecast_response", return_value={"kind": "house"}, create=True),
            patch.object(coordinator_module, "build_battery_forecast_response", return_value={"kind": "battery"}, create=True),
            patch.object(coordinator_module, "build_grid_flow_forecast_snapshot", return_value={"canonical": "grid"}, create=True),
            patch.object(coordinator_module, "build_grid_flow_forecast_response", return_value={"kind": "grid-flow"}, create=True),
            patch.object(
                coordinator_module,
                "build_grid_price_forecast_response",
                return_value={
                    "exportPriceUnit": None,
                    "currentExportPrice": None,
                    "exportPricePoints": [],
                    "importPriceUnit": None,
                    "currentImportPrice": None,
                    "importPricePoints": [],
                },
                create=True,
            ),
        ):
            result = await coordinator.get_forecast(granularity=60, forecast_days=7)

        self.assertEqual(result["solar"]["points"][0]["value"], 1250.25)
        self.assertEqual(result["solar"]["adjustedPoints"][0]["value"], 900.5)
        self.assertEqual(result["solar"]["biasCorrection"]["effectiveVariant"], "adjusted")
        coordinator._async_refresh_forecast_and_request_automation.assert_not_awaited()
    finally:
        _restore_modules(previous_modules)
        sys.modules.pop("custom_components.helman.coordinator", None)
```

- [ ] **Step 3: Run failing tests**

Run:

```bash
pytest tests/test_solar_forecast_cache.py::SolarForecastCacheTest::test_get_forecast_returns_raw_points_and_adjusted_points_from_cached_snapshot tests/test_solar_bias_response.py -q
```

Expected: FAIL because `get_forecast()` currently serializes corrected values through `points`, and raw-variant response tests still expect mirrored `adjustedPoints`.

- [ ] **Step 4: Extend `build_solar_forecast_response` with `corrected_points`**

In `custom_components/helman/point_forecast_response.py`, factor the existing expansion/window/aggregation body into a private helper:

```python
def _expand_and_window_solar_points(
    points: list[dict[str, Any]],
    *,
    snapshot_meta: dict[str, Any],
    granularity: int,
    forecast_days: int,
) -> list[dict[str, Any]]:
    # Existing expansion logic that today operates on snapshot["points"]:
    # detect interval, compute split factor, expand to canonical 15-min slots
    # if needed, window to forecast_days, aggregate up to granularity.
    # Returns the final response point list.
```

Then change `build_solar_forecast_response` so it calls `_expand_and_window_solar_points` for `points` and, when `corrected_points` is provided, again for `adjustedPoints`:

```python
def build_solar_forecast_response(
    snapshot: dict[str, Any],
    *,
    granularity: int,
    forecast_days: int,
    corrected_points: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    response = _build_meta_response(snapshot)  # existing fields except points
    response["points"] = _expand_and_window_solar_points(
        snapshot.get("points") or [],
        snapshot_meta=snapshot,
        granularity=granularity,
        forecast_days=forecast_days,
    )
    if corrected_points:
        response["adjustedPoints"] = _expand_and_window_solar_points(
            corrected_points,
            snapshot_meta=snapshot,
            granularity=granularity,
            forecast_days=forecast_days,
        )
    return response
```

By construction, `points` and `adjustedPoints` share interval, window, and rounding.

- [ ] **Step 5: Coordinator passes both series and surfaces `biasCorrection`**

In `custom_components/helman/coordinator.py`, replace the `effective_solar_forecast` block inside `get_forecast()`:

```python
solar_response = build_solar_forecast_response(
    canonical_solar_forecast,
    granularity=granularity,
    forecast_days=forecast_days,
    corrected_points=canonical_solar_forecast.get("correctedPoints"),
)
bias_correction = canonical_solar_forecast.get("biasCorrection")
if isinstance(bias_correction, dict):
    solar_response["biasCorrection"] = deepcopy(bias_correction)
result = {"solar": solar_response}
```

The public response carries `points` (raw), `adjustedPoints` (only when `correctedPoints` is present, i.e., `effectiveVariant == "adjusted"`), and `biasCorrection` (whenever the bias service produced a result, regardless of variant). `rawPoints` is not emitted on the public response.

In `custom_components/helman/solar_bias_correction/response.py`, align `compose_solar_bias_response()` with the same shape — call `build_solar_forecast_response` with `corrected_points` for the adjusted variant, always attach `biasCorrection`:

```python
response = build_solar_forecast_response(
    snapshot,
    granularity=granularity,
    forecast_days=forecast_days,
    corrected_points=(
        adjustment_result.adjusted_points
        if adjustment_result.effective_variant == "adjusted"
        else None
    ),
)
response["biasCorrection"] = build_bias_correction_payload(adjustment_result)
return response
```

- [ ] **Step 6: Remove fallback mutation from point response**

In `custom_components/helman/point_forecast_response.py`, remove this fallback from `build_solar_forecast_response()`:

```python
if (
    not normalized_snapshot.get("points")
    and normalized_snapshot.get("rawPoints")
):
    normalized_snapshot["points"] = deepcopy(
        normalized_snapshot["rawPoints"]
    )
```

After Task 1, callers must pass explicit `points`.

- [ ] **Step 7: Run response tests**

Run:

```bash
pytest tests/test_solar_forecast_cache.py::SolarForecastCacheTest::test_get_forecast_returns_raw_points_and_adjusted_points_from_cached_snapshot tests/test_solar_bias_response.py tests/test_point_forecast_response.py -q
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add custom_components/helman/coordinator.py custom_components/helman/point_forecast_response.py custom_components/helman/solar_bias_correction/response.py tests/test_solar_forecast_cache.py tests/test_solar_bias_response.py tests/test_point_forecast_response.py
git commit -m "fix: expose raw and corrected solar forecast separately"
```

---

### Task 3: Day Entities Aggregate Corrected Canonical Points

**Files:**
- Modify: `custom_components/helman/coordinator.py`
- Test: `tests/test_sensor_forecast_entities.py`

- [ ] **Step 1: Write failing entity aggregation test**

In `tests/test_sensor_forecast_entities.py`, add a coordinator unit test near the existing solar forecast day total tests:

```python
def test_solar_forecast_day_entities_use_corrected_points_when_available():
    coordinator = object.__new__(coordinator_module.HelmanCoordinator)
    coordinator._cached_solar_forecast = {
        "points": [
            {"timestamp": "2026-05-05T10:00:00+02:00", "value": 1000.0},
        ],
        "rawPoints": [
            {"timestamp": "2026-05-05T10:00:00+02:00", "value": 1000.0},
        ],
        "correctedPoints": [
            {"timestamp": "2026-05-05T10:00:00+02:00", "value": 700.0},
        ],
    }

    with patch.object(coordinator_module.dt_util, "now", return_value=datetime.fromisoformat("2026-05-05T08:00:00+02:00")):
        assert coordinator.get_solar_forecast_day_total(0) == 0.7
        assert coordinator.get_solar_forecast_today_remaining() == 0.7
```

If `tests/test_sensor_forecast_entities.py` imports the coordinator module differently, use the existing module variable/import pattern in that file and keep the same snapshot shape and assertions.

- [ ] **Step 2: Run the failing test**

Run:

```bash
pytest tests/test_sensor_forecast_entities.py::test_solar_forecast_day_entities_use_corrected_points_when_available -q
```

Expected: FAIL because `get_effective_solar_forecast_points()` currently returns `points`, which will now be raw.

- [ ] **Step 3: Replace effective point selection with corrected point selection**

In `custom_components/helman/coordinator.py`, replace `get_effective_solar_forecast_points()` with explicit helpers:

```python
def get_raw_solar_forecast_points(self) -> list[dict[str, Any]]:
    snapshot = self._cached_solar_forecast or {}
    points = snapshot.get("points")
    if isinstance(points, list):
        return points
    raw_points = snapshot.get("rawPoints")
    if isinstance(raw_points, list):
        return raw_points
    return []

def get_corrected_solar_forecast_points(self) -> list[dict[str, Any]]:
    snapshot = self._cached_solar_forecast or {}
    corrected_points = snapshot.get("correctedPoints")
    if isinstance(corrected_points, list) and corrected_points:
        return corrected_points
    return self.get_raw_solar_forecast_points()
```

Change `get_solar_forecast_day_total()` and `get_solar_forecast_today_remaining()` to call `get_corrected_solar_forecast_points()`.

- [ ] **Step 4: Run entity tests**

Run:

```bash
pytest tests/test_sensor_forecast_entities.py -q
```

Expected: PASS after updating existing test expectations that currently assume `points` is corrected.

- [ ] **Step 5: Commit**

```bash
git add custom_components/helman/coordinator.py tests/test_sensor_forecast_entities.py
git commit -m "fix: aggregate solar forecast entities from corrected points"
```

---

### Task 4: Inspector Sources Both Series From Canonical Snapshot

**Files:**
- Modify: `custom_components/helman/solar_bias_correction/service.py`
- Modify: `custom_components/helman/coordinator.py`
- Test: `tests/test_solar_bias_inspector.py`

**Design note:** for today/future dates, both `series.raw` and `series.corrected` come from the canonical snapshot — `rawPoints` and `correctedPoints` respectively — selected by local day. Both series are then aggregated to hourly buckets so they remain slot-aligned with `load_actuals_for_day` (which is keyed by `"HH:MM"` hour-start) and with each other. The hourly `wh_period` re-extraction path is dropped for current/future dates. Past dates keep the recorder/history path unchanged.

- [ ] **Step 1: Write failing inspector test**

In `tests/test_solar_bias_inspector.py`, replace `test_inspector_day_applies_current_profile_and_totals` with a test that proves both inspector raw and corrected values come from the canonical provider, aggregated to hourly:

```python
def test_inspector_day_uses_canonical_for_raw_and_corrected_today():
    # Canonical 15-min points: four slots in hour 08, four in hour 09.
    raw_15min = [
        {"timestamp": "2026-04-25T08:00:00+02:00", "value": 25.0},
        {"timestamp": "2026-04-25T08:15:00+02:00", "value": 25.0},
        {"timestamp": "2026-04-25T08:30:00+02:00", "value": 25.0},
        {"timestamp": "2026-04-25T08:45:00+02:00", "value": 25.0},
        {"timestamp": "2026-04-25T09:00:00+02:00", "value": 50.0},
        {"timestamp": "2026-04-25T09:15:00+02:00", "value": 50.0},
        {"timestamp": "2026-04-25T09:30:00+02:00", "value": 50.0},
        {"timestamp": "2026-04-25T09:45:00+02:00", "value": 50.0},
    ]
    corrected_15min = [
        {"timestamp": "2026-04-25T08:00:00+02:00", "value": 31.25},
        {"timestamp": "2026-04-25T08:15:00+02:00", "value": 31.25},
        {"timestamp": "2026-04-25T08:30:00+02:00", "value": 31.25},
        {"timestamp": "2026-04-25T08:45:00+02:00", "value": 31.25},
        {"timestamp": "2026-04-25T09:00:00+02:00", "value": 43.75},
        {"timestamp": "2026-04-25T09:15:00+02:00", "value": 43.75},
        {"timestamp": "2026-04-25T09:30:00+02:00", "value": 43.75},
        {"timestamp": "2026-04-25T09:45:00+02:00", "value": 43.75},
    ]

    async def canonical_provider(*, reference_time):
        return {"rawPoints": raw_15min, "correctedPoints": corrected_15min}

    service = _make_service(canonical_provider=canonical_provider)
    # ... profile/metadata setup as before ...

    async def fake_actuals(*args, **kwargs):
        return {"08:00": 90.0}

    old_actuals = service_mod.load_actuals_for_day
    old_now = service_mod.dt_util.now
    try:
        service_mod.load_actuals_for_day = fake_actuals
        service_mod.dt_util.now = lambda: datetime.fromisoformat("2026-04-25T10:00:00+02:00")
        payload = asyncio.run(service.async_get_inspector_day("2026-04-25"))
    finally:
        service_mod.load_actuals_for_day = old_actuals
        service_mod.dt_util.now = old_now

    # Both series aggregated to hourly buckets keyed by hour-start timestamp.
    assert payload["series"]["raw"] == [
        {"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 100.0},
        {"timestamp": "2026-04-25T09:00:00+02:00", "valueWh": 200.0},
    ]
    assert payload["series"]["corrected"] == [
        {"timestamp": "2026-04-25T08:00:00+02:00", "valueWh": 125.0},
        {"timestamp": "2026-04-25T09:00:00+02:00", "valueWh": 175.0},
    ]
    assert payload["totals"]["rawWh"] == 300.0
    assert payload["totals"]["correctedWh"] == 300.0
```

The historical path test (`test_inspector_day_uses_recorder_history_for_past_dates` or equivalent) must remain unchanged — past dates do not consult the canonical provider.

Update `_make_service()` in that test file to accept the provider:

```python
def _make_service(canonical_provider=None):
    hass = SimpleNamespace(
        config=SimpleNamespace(time_zone="Europe/Prague"),
        bus=SimpleNamespace(async_fire=lambda *args, **kwargs: None),
    )
    return service_mod.SolarBiasCorrectionService(
        hass,
        _DummyStore(),
        _make_cfg(),
        canonical_solar_forecast_provider=canonical_provider,
    )
```

- [ ] **Step 2: Run failing inspector test**

Run:

```bash
pytest tests/test_solar_bias_inspector.py::test_inspector_day_uses_canonical_for_raw_and_corrected_today -q
```

Expected: FAIL because `SolarBiasCorrectionService.__init__()` does not accept the provider and the inspector path for today/future dates still re-extracts `wh_period` and applies `adjust()` to hourly points instead of pulling from the canonical snapshot.

- [ ] **Step 3: Inject canonical forecast provider**

In `custom_components/helman/solar_bias_correction/service.py`, update the constructor:

```python
    def __init__(
        self,
        hass: HomeAssistant,
        store: SolarBiasCorrectionStore,
        cfg: BiasConfig,
        *,
        canonical_solar_forecast_provider=None,
    ) -> None:
        self._hass = hass
        self._store = store
        self._cfg = cfg
        self._canonical_solar_forecast_provider = canonical_solar_forecast_provider
```

Keep the existing field initialization after these assignments.

In `custom_components/helman/coordinator.py`, pass the provider when constructing the service:

```python
self._solar_bias_service = SolarBiasCorrectionService(
    self._hass,
    self._solar_bias_store,
    bias_config,
    canonical_solar_forecast_provider=self._async_get_canonical_solar_forecast,
)
```

- [ ] **Step 4: Add canonical day-point extraction with hourly aggregation**

In `custom_components/helman/solar_bias_correction/service.py`, add a helper that selects a local day's points from a canonical 15-min series and aggregates to hourly buckets keyed by hour-start timestamp:

```python
def _hourly_buckets_for_local_date(
    points: list[dict[str, Any]],
    target_date: date,
    timezone: ZoneInfo,
) -> list[dict[str, Any]]:
    buckets: dict[str, float] = {}
    for point in points:
        if not isinstance(point, dict):
            continue
        timestamp = dt_util.parse_datetime(point.get("timestamp"))
        value = point.get("value")
        if timestamp is None or not isinstance(value, (int, float)):
            continue
        local_timestamp = dt_util.as_local(timestamp).astimezone(timezone)
        if local_timestamp.date() != target_date:
            continue
        hour_start = local_timestamp.replace(minute=0, second=0, microsecond=0)
        key = hour_start.isoformat()
        buckets[key] = buckets.get(key, 0.0) + float(value)
    return [
        {"timestamp": ts, "value": round(value, 4)}
        for ts, value in sorted(buckets.items())
    ]
```

In `async_get_inspector_day()`, for today/future dates source both raw and corrected from the canonical provider:

```python
timezone = ZoneInfo(str(self._hass.config.time_zone))
if target_date >= today:
    provider = self._canonical_solar_forecast_provider
    if provider is not None:
        canonical_snapshot = await provider(reference_time=local_now)
    else:
        canonical_snapshot = None
    canonical_snapshot = canonical_snapshot if isinstance(canonical_snapshot, dict) else {}
    canonical_raw = canonical_snapshot.get("rawPoints") or []
    canonical_corrected = canonical_snapshot.get("correctedPoints") or []
    raw_points = _hourly_buckets_for_local_date(canonical_raw, target_date, timezone)
    if effective_variant == "adjusted" and canonical_corrected:
        corrected_points = _hourly_buckets_for_local_date(
            canonical_corrected, target_date, timezone
        )
    else:
        # No active correction (or no correctedPoints in snapshot): corrected mirrors raw.
        corrected_points = _copy_points(raw_points)
else:
    # Past dates: existing recorder/history path is unchanged.
    # Keep the current call signature for load_forecast_points_for_day
    # exactly as it exists today (do not modify args).
    raw_points = await load_forecast_points_for_day(
        self._hass, self._cfg, target_date
    )
    corrected_points = (
        adjust(raw_points, self._profile)
        if effective_variant == "adjusted" and self._profile is not None
        else _copy_points(raw_points)
    )
```

The old `load_forecast_points_for_day` call for current/future dates is dropped — the canonical snapshot is now the source of truth for both series. `load_forecast_points_for_day` remains used only for past dates.

- [ ] **Step 5: Run inspector tests**

Run:

```bash
pytest tests/test_solar_bias_inspector.py -q
```

Expected: PASS after updating any existing test that expected direct hourly adjustment for today/future corrected values.

- [ ] **Step 6: Commit**

```bash
git add custom_components/helman/coordinator.py custom_components/helman/solar_bias_correction/service.py tests/test_solar_bias_inspector.py
git commit -m "fix: source inspector corrected forecast from canonical snapshot"
```

---

### Task 5: Shared Debounced Invalidation For Source, Profile, And Status Changes

**Files:**
- Modify: `custom_components/helman/coordinator.py`
- Modify: `custom_components/helman/solar_bias_correction/service.py`
- Test: `tests/test_solar_forecast_cache.py`

**Design:** all three invalidation triggers funnel through one HA `Debouncer` so rapid bursts coalesce into a single canonical refresh.

Triggers:

1. **Upstream forecast source state changes** — `async_track_state_change_event` on every entity in `bias_config.daily_energy_entity_ids`. The handler ignores events where neither `state` nor `wh_period` changed (HA fires on attribute-only updates that don't affect the forecast).
2. **Bias trained / profile changed** — existing `helman_solar_bias_trained` event.
3. **Bias status / variant changed** — new `helman_solar_bias_status_changed` event fired by `SolarBiasCorrectionService` whenever `_resolve_status()` returns a different `(status, effective_variant)` tuple than the previously emitted one. Service tracks last emitted tuple in a private field and fires only on transitions.

- [ ] **Step 1: Write failing invalidation tests**

Add three tests in `tests/test_solar_forecast_cache.py`:

```python
async def test_solar_source_state_change_triggers_debounced_refresh(self) -> None:
    # Fire 5 state-change events with new wh_period values within 100ms,
    # plus 1 helman_solar_bias_trained event, plus 1 helman_solar_bias_status_changed event.
    # Assert: _async_refresh_forecast_and_request_automation awaited exactly once
    # after the debouncer cooldown elapses, and _cached_solar_forecast is None.

async def test_solar_source_state_change_ignores_attribute_only_updates(self) -> None:
    # old_state and new_state share identical state and wh_period.
    # Assert: refresh NOT scheduled.

async def test_solar_bias_status_change_event_triggers_refresh(self) -> None:
    # Fire helman_solar_bias_status_changed with payload
    # {"status": "applied", "effectiveVariant": "adjusted"}.
    # Assert: refresh awaited once, cache cleared.
```

- [ ] **Step 2: Run failing tests**

```bash
pytest tests/test_solar_forecast_cache.py -k "solar_source_state_change or solar_bias_status_change" -q
```

Expected: FAIL — no handlers, no debouncer, no status event.

- [ ] **Step 3: Add the debouncer and unified invalidation entry point**

In `custom_components/helman/coordinator.py`:

```python
from homeassistant.helpers.debounce import Debouncer
from homeassistant.helpers.event import (
    async_track_state_change_event,
    async_track_time_change,
    async_track_time_interval,
)
```

In `async_setup()`, before listener registration:

```python
self._solar_invalidation_debouncer = Debouncer(
    self._hass,
    _LOGGER,
    cooldown=1.0,
    immediate=False,
    function=self._async_invalidate_and_refresh_solar,
)
```

Add the unified handler:

```python
async def _async_invalidate_and_refresh_solar(self) -> None:
    self._cached_solar_forecast = None
    await self._async_refresh_forecast_and_request_automation(
        reason="solar_invalidation"
    )

@callback
def _schedule_solar_invalidation(self) -> None:
    self._hass.async_create_task(
        self._solar_invalidation_debouncer.async_call()
    )
```

- [ ] **Step 4: Wire the three triggers**

Source state-change handler with attribute filter:

```python
@callback
def _on_solar_forecast_source_state_changed(self, event) -> None:
    old_state = event.data.get("old_state")
    new_state = event.data.get("new_state")
    if old_state is not None and new_state is not None:
        if (
            old_state.state == new_state.state
            and old_state.attributes.get("wh_period")
            == new_state.attributes.get("wh_period")
        ):
            return
    self._schedule_solar_invalidation()

@callback
def _on_solar_bias_changed(self, event) -> None:
    self._schedule_solar_invalidation()
```

In `async_setup()`:

```python
if bias_config.daily_energy_entity_ids:
    self._unsub_listeners.append(
        async_track_state_change_event(
            self._hass,
            list(bias_config.daily_energy_entity_ids),
            self._on_solar_forecast_source_state_changed,
        )
    )
self._unsub_listeners.append(
    self._hass.bus.async_listen(
        "helman_solar_bias_trained",
        self._on_solar_bias_changed,
    )
)
self._unsub_listeners.append(
    self._hass.bus.async_listen(
        "helman_solar_bias_status_changed",
        self._on_solar_bias_changed,
    )
)
```

- [ ] **Step 5: Emit `helman_solar_bias_status_changed` from the service**

In `custom_components/helman/solar_bias_correction/service.py`, add a `_last_emitted_status: tuple[str, str] | None = None` field. After `_resolve_status()` produces `(status, effective_variant)`, compare to the last emitted tuple; if different, fire `helman_solar_bias_status_changed` with payload `{"status": status, "effectiveVariant": effective_variant}` and update the field. Place this at the end of `build_adjustment_result()` so transitions fire on the same path that exposes the new variant to the rest of the system.

- [ ] **Step 6: Run invalidation tests**

```bash
pytest tests/test_solar_forecast_cache.py -q
```

Expected: PASS. The debouncer cooldown is 1.0s — tests should advance the loop with `asyncio.sleep(1.1)` or use `freezegun` / direct debouncer flushing.

- [ ] **Step 7: Commit**

```bash
git add custom_components/helman/coordinator.py custom_components/helman/solar_bias_correction/service.py tests/test_solar_forecast_cache.py
git commit -m "fix: invalidate solar forecast on source, profile, and status changes"
```

---

### Task 6: Update Energy And Automation Consumers For Explicit Corrected Series

**Files:**
- Modify: `custom_components/helman/energy.py`
- Modify: any automation input bundle code that reads `solar.points` as corrected
- Test: `tests/test_energy_platform.py`
- Test: `tests/test_automation_input_bundle.py`

- [ ] **Step 1: Update enumerated consumers**

Each consumer below is classified as **raw** (must read `points`) or **corrected** (must read `adjustedPoints` first, fall back to `points` only when no correction is active).

| Consumer | File / location | Classification | Action |
|---|---|---|---|
| Energy dashboard forecast points | `custom_components/helman/energy.py:30` | corrected | Already prefers `adjustedPoints` then `points`. Keep, verify. |
| `sensor.helman_energy_production_*` day totals | `coordinator.get_solar_forecast_day_total` | corrected | Switched to `correctedPoints` in Task 3. |
| `today_remaining` sensor | `coordinator.get_solar_forecast_today_remaining` | corrected | Switched in Task 3. |
| Inspector `series.raw` / `series.corrected` (today/future) | `solar_bias_correction/service.async_get_inspector_day` | both, from canonical | Switched in Task 4. |
| Inspector historical path | same file | unchanged | Past dates keep recorder/history path. |
| Automation input bundle | every `_cached_solar_forecast["points"]` / `["correctedPoints"]` read in `coordinator.py` outside `get_forecast`/day-entity helpers | classify each | Audit per call site (see Step 2). |
| `helman/get_forecast` clients | external | breaking | Documented in CHANGELOG. |
| Test fixtures asserting `points` is corrected | `tests/test_*.py` | n/a | Updated in Tasks 1–5 and 7. |

- [ ] **Step 2: Audit `coordinator.py` reads of cached solar series**

Run:

```bash
rg -n "_cached_solar_forecast" custom_components/helman/coordinator.py
```

For each hit not already touched by Tasks 1–4, classify the call site as raw or corrected and update accordingly. Add a short inline comment at each updated site noting which series it reads (e.g. `# corrected canonical points for day-entity aggregation`). Expected hits: cache assignment in `_async_build_canonical_solar_forecast`, reads in `get_forecast()`, day-entity helpers, automation input assembly, persistence load/save. Anything else is unexpected and worth a closer look.

- [ ] **Step 3: Update Energy tests**

In `tests/test_energy_platform.py`, add or keep a test that verifies adjusted points are preferred:

```python
solar_forecast = {
    "points": [{"timestamp": "2026-05-05T10:00:00+02:00", "value": 1000.0}],
    "adjustedPoints": [{"timestamp": "2026-05-05T10:00:00+02:00", "value": 700.0}],
}
```

Assert the Energy platform receives `700.0`, not `1000.0`.

- [ ] **Step 4: Update consumer code**

Keep `custom_components/helman/energy.py` using:

```python
points = solar_forecast.get("adjustedPoints")
if not points:
    points = solar_forecast.get("points", [])
```

For any automation input code that needs corrected forecast, use the same selection rule. For any code that needs provider raw forecast, use `points`.

- [ ] **Step 5: Run consumer tests**

Run:

```bash
pytest tests/test_energy_platform.py tests/test_automation_input_bundle.py -q
```

Expected: PASS after expectation updates.

- [ ] **Step 6: Commit**

```bash
git add custom_components/helman/energy.py custom_components/helman tests/test_energy_platform.py tests/test_automation_input_bundle.py
git commit -m "fix: consume explicit corrected solar forecast series"
```

---

### Task 7: End-To-End Consistency Regression

**Files:**
- Modify: `tests/test_solar_forecast_cache.py`
- Modify: `tests/test_solar_bias_inspector.py`
- Modify: `tests/test_sensor_forecast_entities.py`

- [ ] **Step 1: Add aggregate helper in tests**

In the relevant test file, add a local helper:

```python
def _sum_wh(points):
    return round(sum(point["value"] for point in points), 4)
```

For inspector payload points:

```python
def _sum_inspector_wh(points):
    return round(sum(point["valueWh"] for point in points), 4)
```

- [ ] **Step 2: Add consistency assertions**

For the same canonical snapshot:

```python
canonical_corrected = [
    {"timestamp": "2026-05-05T10:00:00+02:00", "value": 700.0},
    {"timestamp": "2026-05-05T10:15:00+02:00", "value": 300.0},
]
```

Assert:

```python
self.assertEqual(_sum_wh(result["solar"]["adjustedPoints"]), 1000.0)
self.assertEqual(coordinator.get_solar_forecast_day_total(0), 1.0)
assert payload["totals"]["correctedWh"] == 1000.0
assert _sum_inspector_wh(payload["series"]["corrected"]) == 1000.0
```

- [ ] **Step 3: Run targeted consistency tests**

Run:

```bash
pytest tests/test_solar_forecast_cache.py tests/test_solar_bias_inspector.py tests/test_sensor_forecast_entities.py -q
```

Expected: PASS.

- [ ] **Step 4: Run full relevant suite**

Run:

```bash
pytest tests/test_solar_forecast_cache.py tests/test_solar_bias_response.py tests/test_solar_bias_inspector.py tests/test_sensor_forecast_entities.py tests/test_energy_platform.py tests/test_automation_input_bundle.py -q
```

Expected: PASS.

- [ ] **Step 5: Add CHANGELOG entry**

Append a "Breaking changes" entry to `CHANGELOG.md` (or equivalent) describing:

- `helman/get_forecast` `solar.points` now contains raw canonical forecast (previously corrected).
- `helman/get_forecast` `solar.rawPoints` is removed; use `points`.
- `helman/get_forecast` `solar.adjustedPoints` and `solar.biasCorrection` are now reliably populated whenever a bias result exists. `adjustedPoints` is present only when `effectiveVariant == "adjusted"`.

- [ ] **Step 6: Commit**

```bash
git add tests/test_solar_forecast_cache.py tests/test_solar_bias_response.py tests/test_solar_bias_inspector.py tests/test_sensor_forecast_entities.py tests/test_energy_platform.py tests/test_automation_input_bundle.py CHANGELOG.md
git commit -m "test: lock corrected solar forecast consistency"
```

---

## Final Verification

- [ ] Run the relevant test suite:

```bash
pytest tests/test_solar_forecast_cache.py tests/test_solar_bias_response.py tests/test_solar_bias_inspector.py tests/test_sensor_forecast_entities.py tests/test_energy_platform.py tests/test_automation_input_bundle.py -q
```

Expected: all selected tests pass.

- [ ] Run the broader solar-bias suite:

```bash
pytest tests/test_solar_bias_store.py tests/test_solar_bias_trainer.py tests/test_solar_bias_inspector.py tests/test_solar_bias_response.py tests/test_solar_forecast_cache.py -q
```

Expected: all selected tests pass.

- [ ] Search for old effective-points assumptions:

```bash
rg -n "\bget_effective_solar_forecast_points\b|\beffective_solar_forecast\b" custom_components tests -g '*.py'
```

Expected: zero hits in production code. Test hits are acceptable only when explicitly asserting the absence of the old API.

```bash
rg -n "\brawPoints\b" custom_components -g '*.py'
```

Expected: hits only in `coordinator.py` (internal cache slot) and possibly `solar_bias_correction/` (internal). No hits in `point_forecast_response.py` (public response) and no hits in any websocket response builder.

- [ ] Manual local Home Assistant verification:

Call `helman/get_forecast`, `helman/solar_bias/inspector`, and read Helman solar day entities for the same local day. Confirm:

```text
sum(get_forecast.solar.adjustedPoints for local day)
== inspector.totals.correctedWh
== sensor.helman_energy_production_<day>.state * 1000
```

`get_forecast.solar.points` must equal the raw canonical forecast aggregate, not the corrected aggregate.

## Self-Review Notes

- Spec coverage:
  - Raw/corrected side-by-side storage: Task 1.
  - `get_forecast` explicit contract: Task 2.
  - Helman day entities corrected aggregation: Task 3.
  - Inspector corrected canonical aggregation: Task 4.
  - Shared invalidation: Task 5.
  - Downstream consumers: Task 6.
  - Same corrected total everywhere: Task 7.
- Placeholder scan: no placeholder markers or unspecified implementation steps.
- Type consistency:
  - Cached canonical corrected series is named `correctedPoints` (internal only).
  - Cached canonical raw series is named `rawPoints` (internal only).
  - Public raw response series is `points`.
  - Public corrected response series is `adjustedPoints` (present only when `effectiveVariant == "adjusted"`).
  - `biasCorrection` is on the public response whenever the bias service produced a result, regardless of variant.
