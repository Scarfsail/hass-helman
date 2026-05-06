# Solar Forecast Discrepancy Analysis - 2026-05-05

## Initial Observation

Queried from local Home Assistant on 2026-05-05. Values are normalized to kWh for local dates starting 2026-05-05.

| Date | Helman entity | Upstream forecast entity raw | Solar bias inspector raw | Solar bias inspector corrected | `helman/get_forecast` `solar.points` | `get_forecast` `adjustedPoints` |
|---|---:|---:|---:|---:|---:|---:|
| 2026-05-05 | 79.1486 | 70.6613 | 70.6613 | 69.8687 | 68.9501 | none |
| 2026-05-06 | 47.6315 | 42.7465 | 42.7465 | 41.9957 | 41.4677 | none |
| 2026-05-07 | 64.2674 | 57.8498 | 57.8498 | 56.9972 | 56.1963 | none |
| 2026-05-08 | 63.0657 | 56.3093 | 56.3093 | 55.7338 | 54.9887 | none |
| 2026-05-09 | 71.2005 | 63.8628 | 63.8628 | 63.2245 | 62.3222 | none |
| 2026-05-10 | 67.0396 | 60.2478 | 60.2478 | 59.5823 | 58.7071 | none |
| 2026-05-11 | 63.8688 | 57.0638 | 57.0638 | 56.3331 | 55.5673 | none |
| 2026-05-12 | 51.0721 | 46.4643 | 46.4643 | 45.7886 | 45.0030 | none |

Key observations:

- `helman/get_forecast` reports `biasCorrection: null` and no `adjustedPoints`, even though `helman/solar_bias/status` says `status: applied`, `effectiveVariant: adjusted`.
- `get_forecast solar.points` appears to already be adjusted, but it is lower than inspector corrected by roughly `0.5-0.9 kWh/day`.
- Helman day entities are much higher than both inspector and `get_forecast`. They were last updated at `2026-05-05T18:54:25Z`; upstream forecast entities updated later at `2026-05-05T19:04:48Z`, so the Helman entity surface looks stale relative to the current websocket results.
- Inspector raw exactly matches the upstream forecast entities, so that part is consistent.

Corrected-forecast bugs visible from this section:

- The corrected forecast has more than one public value for the same local day: inspector corrected, `helman/get_forecast solar.points`, and Helman day entities disagree.
- `helman/get_forecast` exposes corrected values in `solar.points` but says `biasCorrection: null` and omits `adjustedPoints`, so consumers cannot tell whether the values are corrected.
- Helman day entities can present an older corrected forecast than the websocket API, so the same integration shows different corrected totals depending on where the user looks.

Agreed approach:

Make the canonical 15-minute forecast snapshot the single source of truth for both raw and corrected forecast series. Raw forecast must remain raw everywhere, corrected forecast must remain corrected everywhere, and both must be derived from the same canonical pipeline.

The public contract should use explicit fields: `solar.points` is raw canonical forecast and `adjustedPoints` is corrected canonical forecast. `biasCorrection` explains the active correction. Helman day entities and inspector corrected totals must aggregate the same canonical corrected points, so the same local day produces the same corrected kWh value wherever it is shown.

Add a hard regression invariant: for the same request window and interval, summing corrected points from `helman/get_forecast`, inspector corrected, and Helman day entities must produce the same kWh value after the same rounding.

## Investigation: Upstream Forecast Entities And Solar Bias Inspector

Root cause: there is no independent upstream-vs-inspector raw discrepancy. The upstream forecast entity raw values and `helman/solar_bias/inspector` raw values match because both are built from the same configured daily forecast entities and the same `wh_period` attribute values. The corrected inspector series differs because the inspector explicitly applies the trained solar bias profile to a copy of those raw points when the service resolves to `effectiveVariant == "adjusted"`.

Exact code path:

- Upstream forecast extraction: `custom_components/helman/forecast_builder.py:38` reads `daily_energy_entity_ids`; `custom_components/helman/forecast_builder.py:53` maps each entity index to `today + index`; `custom_components/helman/forecast_builder.py:129` reads the entity state, extracts `attributes["wh_period"]`, parses/sorts values, then zips them onto expected local hourly slots.
- Inspector raw extraction: `custom_components/helman/solar_bias_correction/service.py:246` calls `load_forecast_points_for_day(...)`; `custom_components/helman/solar_bias_correction/forecast_history.py:67` reads the same configured entity for the requested day offset; `custom_components/helman/solar_bias_correction/forecast_history.py:86` reads `attributes["wh_period"]`, parses/sorts values, then zips them onto local hourly slots.
- Inspector corrected extraction: `custom_components/helman/solar_bias_correction/service.py:271` starts with a copy of `raw_points`; `custom_components/helman/solar_bias_correction/service.py:274` calls `adjust(raw_points, self._profile)` only when the resolved variant is adjusted.
- Payload serialization: `custom_components/helman/solar_bias_correction/service.py:292` places raw, corrected, impact, and totals into `SolarBiasInspectorDay`; `custom_components/helman/solar_bias_correction/models.py:191` serializes that as `series.raw`, `series.corrected`, `totals.rawWh`, and `totals.correctedWh`.

Why inspector raw matches upstream entity raw:

For current/future days, both paths read the same entity from `daily_energy_entity_ids[offset]`, read its `wh_period` attribute, parse numeric Wh values without unit conversion, sort by provider timestamp, and assign the sorted values to expected local day slots. In the observed 2026-05-05 data, the upstream entity state also equals the sum of its `wh_period` values divided by 1000, for example `sensor.energy_production_today` state `70.66125 kWh` and `wh_period` sum `70661.25 Wh`.

Why inspector corrected differs:

Corrected is not another upstream entity value. It is `raw_points * trained_slot_factor`, with timestamps preserved and values adjusted per local slot by the trained profile. That happens after raw extraction, so `series.raw` remains the upstream forecast while `series.corrected` reflects the active bias correction profile. The observed corrected totals are therefore lower than raw by roughly `0.5-0.9 kWh/day`, which is expected when the trained factors for contributing daylight slots are mostly below `1.0`.

Caveats:

- The match is between inspector raw and the upstream `wh_period`-derived forecast, not proof that the inspector reads the entity state value directly.
- Both extraction paths reassign sorted `wh_period` values onto expected local slots; they do not preserve provider timestamps as authoritative beyond ordering.
- This conclusion applies cleanly to today/future dates. Past inspector dates use recorder history for the first daily entity captured around that past day, which is a different path.

Corrected-forecast bugs visible from this section:

- The inspector corrected series is not the same corrected forecast used by the runtime forecast pipeline. It applies the bias profile directly to hourly points, while the runtime forecast applies bias after canonicalizing to 15-minute slots.
- Because inspector totals are computed from this separate hourly path, the inspector can report a corrected daily total that no user-facing forecast entity or websocket response will ever expose.
- The inspector therefore mixes two roles: it is reliable for diagnosing raw provider input, but its corrected output is not reliable as the canonical corrected forecast.

Agreed approach:

Keep the inspector raw path as a diagnostic view of provider input. Change inspector corrected output so `series.corrected` and `totals.correctedWh` mean canonical corrected forecast, not "the inspector's local adjustment of raw hourly input."

For current and future local days, both inspector `series.raw` and `series.corrected` should come from the canonical snapshot — `rawPoints` and `correctedPoints` respectively — selected by local day. Both series are then aggregated to hourly buckets so they remain slot-aligned with `load_actuals_for_day` (which is hourly) and with each other. The hourly `wh_period` re-extraction path is dropped for current/future raw. Past dates keep the recorder/history path unchanged.

Add regression coverage comparing inspector `totals.correctedWh` for today/future days with the same day's aggregate from `helman/get_forecast adjustedPoints`, using the same timezone and rounding.

## Investigation: `helman/get_forecast`

Root causes:

- `solar.points` is adjusted because `coordinator._async_build_canonical_solar_forecast()` stores solar-bias-adjusted values directly into the canonical snapshot's `points`, replacing raw points. Raw values are retained separately as `rawPoints`.
- `adjustedPoints` and `biasCorrection` are empty/null because the production `get_forecast()` path never calls `compose_solar_bias_response()`. It only calls `build_solar_forecast_response()`, which serializes whatever is in snapshot `points`; it does not synthesize solar-bias metadata fields.
- `solar.points` can be lower than solar-bias inspector corrected totals because the two paths apply bias at different granularities. `get_forecast` first expands hourly forecast values into 15-minute canonical slots, then applies per-15-minute factors. The inspector loads hourly `wh_period` points for a day and applies `adjust()` directly to those hourly points, so each whole hour is multiplied by the factor for only the hour-start slot.

`get_forecast` code path:

- `custom_components/helman/coordinator.py:738`: `_async_build_canonical_solar_forecast()` builds the raw solar response.
- `custom_components/helman/coordinator.py:750`: copies the canonical raw response into `snapshot`.
- `custom_components/helman/coordinator.py:751`: stores raw canonical points into `rawPoints`.
- `custom_components/helman/coordinator.py:755`: calls `solar_bias_service.build_adjustment_result(raw_points, reference_time)`.
- `custom_components/helman/coordinator.py:759`: when a result exists, replaces `snapshot["points"]` with `bias_result.adjusted_points`.
- `custom_components/helman/coordinator.py:797`: `get_forecast()` serializes `effective_solar_forecast` with `build_solar_forecast_response()`, not `compose_solar_bias_response()`.

Bias application path:

- `custom_components/helman/solar_bias_correction/service.py:181`: `_resolve_status()` determines `effective_variant`.
- `custom_components/helman/solar_bias_correction/service.py:183`: if `effective_variant == "adjusted"` and a profile exists, it calls `adjust(raw_points, self._profile)`.
- `custom_components/helman/solar_bias_correction/adjuster.py:65`: factor lookup uses a local slot key like `HH:MM`.
- `custom_components/helman/solar_bias_correction/adjuster.py:73`: adjusted value is `raw_val * factor`, clamped non-negative.

Response metadata gap:

- `custom_components/helman/coordinator.py:81`: `compose_solar_bias_response` is imported.
- `custom_components/helman/solar_bias_correction/response.py:59`: `compose_solar_bias_response()` is the function that writes `adjustedPoints`.
- `custom_components/helman/solar_bias_correction/response.py:60`: the same function writes `biasCorrection`.
- Production search shows no call site for `compose_solar_bias_response()`, so the public websocket response cannot include those fields through the current path.

Granularity mismatch against inspector:

- `custom_components/helman/forecast_builder.py:55`: normal forecast builder extracts hourly solar points from daily forecast entities.
- `custom_components/helman/point_forecast_response.py:157`: response builder detects point interval and computes split factor.
- `custom_components/helman/point_forecast_response.py:160`: for solar sum mode, hourly values are split across canonical slots before later aggregation.
- `custom_components/helman/point_forecast_response.py:124`: requested coarser responses aggregate canonical slots back up.
- `custom_components/helman/solar_bias_correction/service.py:256`: inspector loads forecast points via `load_forecast_points_for_day()`.
- `custom_components/helman/solar_bias_correction/service.py:274`: inspector applies `adjust(raw_points, self._profile)` directly to those hourly points.
- `custom_components/helman/solar_bias_correction/service.py:312`: inspector totals sum raw and corrected point values directly.

Evidence from tests:

- `tests/test_solar_bias_response.py:482`, `tests/test_solar_bias_response.py:499`, and `tests/test_solar_bias_response.py:508` confirm `compose_solar_bias_response()` would produce `adjustedPoints` and `biasCorrection`.
- `tests/test_solar_forecast_cache.py:311` and `tests/test_solar_forecast_cache.py:407` confirm current coordinator behavior expects adjusted values directly in `solar.points`.
- `tests/test_solar_bias_inspector.py:468`, `tests/test_solar_bias_inspector.py:522`, and `tests/test_solar_bias_inspector.py:533` confirm inspector applies the profile and totals corrected values independently.
- `custom_components/helman/energy.py:30` masks the missing metadata for the Energy dashboard by using `adjustedPoints` if present, otherwise `points`.

Corrected-forecast bugs visible from this section:

- The websocket response has a metadata bug: it returns corrected effective points but reports no active correction metadata.
- The response shape is internally inconsistent: `rawPoints` exists, corrected values are in `points`, but `adjustedPoints` is absent even though the response composer has support for it.
- The runtime corrected value is probably the best candidate for the canonical corrected forecast because it already uses the canonical interval expansion, but the API does not make that contract explicit.

Agreed approach:

Clean up the `helman/get_forecast` contract so `solar.points` is raw canonical forecast and `adjustedPoints` is corrected canonical forecast. The cached solar snapshot should store named raw and corrected series side by side, for example `rawPoints` and `correctedPoints`, rather than overwriting `points` with whichever variant is effective.

Public serialization should be explicit and boring: `points` serializes raw canonical values, `adjustedPoints` serializes corrected canonical values when correction is active, and `biasCorrection` describes the active correction. This removes hidden "effective points" semantics and prevents future call sites from accidentally aggregating the wrong series.

Add response tests for the active-correction invariant: when `effectiveVariant == "adjusted"`, `biasCorrection` is not null, `adjustedPoints` is present, and `adjustedPoints` matches the canonical corrected series.

## Investigation: Helman Day Entities

Root cause: the Helman day entities are read-only views over `coordinator._cached_solar_forecast`, and they are only republished when the coordinator refreshes that cached snapshot. Upstream forecast entity state changes are not listened to, so changes in configured forecast source entities do not immediately trigger `async_write_ha_state()`.

Exact code path:

- Setup creates the day sensors in `custom_components/helman/sensor.py:40`, registers them with the coordinator in `custom_components/helman/sensor.py:58`, then adds them to HA in `custom_components/helman/sensor.py:75`.
- The entities do not store their own values. `today` through `d7` call `get_solar_forecast_day_total()` from `native_value` in `custom_components/helman/sensor.py:287`. `today_remaining` calls `get_solar_forecast_today_remaining()` in `custom_components/helman/sensor.py:308`.
- Those values are computed from `get_effective_solar_forecast_points()`, which reads `self._cached_solar_forecast["points"]` or `rawPoints` in `custom_components/helman/coordinator.py:1184`. Daily totals are bucketed by local day in `custom_components/helman/coordinator.py:1194`. Remaining today sums cached future points for today in `custom_components/helman/coordinator.py:1202`.
- The upstream forecast source entities are only read when `HelmanForecastBuilder.build()` runs. It reads `daily_energy_entity_ids` in `custom_components/helman/forecast_builder.py:38`, extracts `wh_period` from HA state attributes in `custom_components/helman/forecast_builder.py:129`, and uses `hass.states.get()` in `custom_components/helman/forecast_builder.py:191`.

What triggers recomputation and writes:

- Startup loads persisted forecast snapshots in `custom_components/helman/coordinator.py:464`, starts the slot refresh scheduler in `custom_components/helman/coordinator.py:485`, then schedules a startup refresh in `custom_components/helman/coordinator.py:506`.
- Scheduled refresh runs every 15 minutes at `:00/:15/:30/:45` via `async_track_time_change()` in `custom_components/helman/coordinator.py:2509`.
- `get_forecast()` can force a refresh only when the cached solar snapshot is not current for the current 15-minute slot, via `custom_components/helman/coordinator.py:764` and `custom_components/helman/coordinator.py:885`.
- Refresh rebuilds solar, assigns `_cached_solar_forecast`, persists it, then publishes the day entities in `custom_components/helman/coordinator.py:1575`.
- The only explicit `async_write_ha_state()` for these solar forecast entities is `_publish_solar_forecast_entities()` in `custom_components/helman/coordinator.py:393`, called after successful refresh in `custom_components/helman/coordinator.py:1601`.

Why observed timestamps look stale:

- There is no state listener for the upstream solar forecast source entities. The coordinator listens to registry/device/energy preference changes and time intervals, but not forecast entity state changes.
- The periodic `_tick()` updates unmeasured power, totals, ratios, and battery ETA sensors, but it never publishes solar day entities; see `custom_components/helman/coordinator.py:2637`.
- If upstream forecast entities change after the last coordinator refresh, the Helman day entities keep showing values from `_cached_solar_forecast` until the next 15-minute refresh, startup/reload refresh, or a `get_forecast()` call that finds the cache stale.
- If the cache is still considered current for the same 15-minute slot, `get_forecast()` returns the cached solar snapshot rather than rebuilding from upstream source state.
- HA timestamps reflect the last state write/change. Since these entities only write on `_publish_solar_forecast_entities()`, their timestamps can remain old even while upstream forecast entities have newer state.

Corrected-forecast bugs visible from this section:

- Helman day entities are not guaranteed to show the current corrected forecast. They can lag behind upstream source changes and behind any freshly rebuilt websocket forecast.
- The entity surface does not have its own invalidation path for upstream forecast source changes, solar bias profile changes, or solar bias status/variant changes.
- Even if entities read corrected `points` from `_cached_solar_forecast`, stale cache publication makes them inconsistent with the corrected forecast a user sees through `helman/get_forecast`.

Agreed approach:

Make `get_forecast()` and Helman day entities share one refresh/invalidation path. That path rebuilds the canonical raw and corrected snapshot, persists it, and publishes day entities by aggregating the canonical corrected series.

Configured `daily_energy_entity_ids`, solar bias profile/configuration, and correction status/variant are first-class invalidation inputs to this shared path. When any of them changes, the cached canonical forecast must be rebuilt before corrected values are exposed again.

Do not add entity-side forecast calculation, entity-side bias correction, or special-case refresh logic. Those would create another source of truth. Add entity-level regression coverage showing that after changing a configured upstream forecast entity or active bias profile, `sensor.helman_energy_production_today` and the matching `get_forecast` corrected daily aggregate converge after the same refresh/invalidation event.

## Consolidated Root Cause

The discrepancies are caused by four separate contract/cache mismatches:

1. Inspector raw vs upstream raw is consistent. Both read the same configured daily forecast `wh_period` data for today/future offsets.
2. Inspector corrected vs `get_forecast solar.points` is inconsistent because correction is applied at different points in the pipeline. `get_forecast` corrects canonical 15-minute points, while inspector corrects hourly day points directly.
3. `get_forecast` response metadata is inconsistent with the apparent public contract. The current coordinator writes adjusted values into `solar.points`, retains raw values in `rawPoints`, but never calls the response composer that would expose `adjustedPoints` and `biasCorrection`.
4. Helman day entities are stale because they publish cached snapshot-derived values only on coordinator forecast refresh. They do not subscribe to upstream forecast entity state changes, and `get_forecast()` does not necessarily refresh if the cached snapshot is still current for the same 15-minute slot.

Practical interpretation of the observed table:

- Upstream forecast entities and inspector raw are the reliable baseline for provider raw daily totals.
- Inspector corrected is the bias model applied on the inspector's hourly diagnostic path.
- `helman/get_forecast solar.points` is currently the runtime effective forecast after correction, but that overloaded meaning is part of the contract problem.
- Helman day entities are cached presentation entities and can lag behind both upstream provider entities and a freshly rebuilt forecast.

Agreed consistency target:

- Treat the canonical 15-minute corrected solar forecast as the authoritative corrected forecast.
- Treat the canonical 15-minute raw solar forecast as the authoritative raw forecast.
- Store raw and corrected canonical series side by side. Do not overwrite one with the other.
- Keep raw/provider forecast handling available for diagnostics, but do not use the raw diagnostic path to compute any public corrected total.
- Expose the same corrected canonical points through all corrected surfaces:
  - `helman/get_forecast adjustedPoints` when `effectiveVariant == "adjusted"`.
  - `helman/solar_bias/inspector series.corrected` and `totals.correctedWh` for today/future dates.
  - Helman day forecast entities and `today_remaining`.
- Expose raw canonical points as raw data:
  - `helman/get_forecast solar.points`.
  - Drop the public `rawPoints` field. Internal `_cached_solar_forecast` keeps separate `rawPoints`/`correctedPoints` cache slots for clarity, but the websocket response only ships `points` (raw) and `adjustedPoints` (corrected when active).
- Always emit `biasCorrection` on the `get_forecast` response whenever the bias service produced a result, regardless of variant. Consumers branch on `effectiveVariant` (`"raw"` or `"adjusted"`). `adjustedPoints` is present only when `effectiveVariant == "adjusted"`.
- Rebuild and republish that canonical corrected snapshot whenever upstream forecast source entities, solar bias profile/configuration, or correction status/variant changes. All three triggers funnel through one debounced refresh path.

Agreed implementation direction:

Use the explicit contract-cleanup architecture as the target:

- Make `solar.points` raw canonical forecast everywhere.
- Make `adjustedPoints` corrected canonical forecast everywhere correction is active.
- Store canonical raw and corrected series side by side. Do not overwrite raw `points` with adjusted values.
- Update Energy dashboard fallback logic, tests, docs, and any callers that currently consume corrected values from `points`.
- Change inspector corrected totals to aggregate canonical corrected points.
- Change Helman day entities and `today_remaining` to aggregate canonical corrected points.
- Add upstream-source and bias-profile invalidation so all surfaces republish from the same canonical snapshot.

Do not keep the current "effective points" model as the final design, and do not add a diagnostic split with another corrected-looking output unless a concrete future workflow requires it. The agreed long-term model is explicit: `points` is raw, `adjustedPoints` is corrected, `biasCorrection` explains the correction, and every corrected surface aggregates the same canonical corrected data.
