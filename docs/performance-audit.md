# Performance Audit — `hass-helman`

Date: 2026-05-10
Scope: `custom_components/helman/` (~22k LOC, 76 files)
Method: code review of hot paths + cross-verification of every finding (line numbers, defaults, debounce intervals).

## Summary table

| #  | Severity | Finding                                                               | Primary location                                | Cost driver                                            | Fix idea                                              | Status |
|----|----------|-----------------------------------------------------------------------|-------------------------------------------------|--------------------------------------------------------|-------------------------------------------------------|--------|
| 1  | HIGH     | 1 s tick recomputes unmeasured powers via recursive tree walk         | `coordinator.py:2718-2787, 2947-2970`           | 60 walks/min over device tree, every second            | Raise default bucket to 5–10 s; cache flat tree       | ✅ Fixed (95bc3c4) — default raised to 5 s |
| 2  | HIGH     | 33 `deepcopy` calls in coordinator on forecast refresh path           | `coordinator.py` (34 grep hits)                 | Copies whole 8-day forecast snapshots multiple times   | Shallow copy / `dict \| {…}` / copy-on-write          | ✅ Fixed (e14a02b) — `_merge_grid_forecast_responses` and `_build_price_channel_snapshot` use shallow merges |
| 3  | HIGH     | Forecast refresh runs every 15 min, no debounce/cache vs solar bursts | `coordinator.py:2622`, `consumption_forecast_builder.py:411` | One recorder query per deferrable consumer per refresh | Cache consumer history with TTL; debounce rebuilds    | ✅ Fixed (d6a028c) — 5-min TTL cache on `_query_slot_history` keyed by `(entity_id, canonical_slot)` |
| 4  | MED-HIGH | Solar slot expansion scales with input granularity (can be ~21k iters)| `battery_capacity_forecast_builder.py:1115-1127`| `O(points × split_factor)` per refresh                 | Pre-allocate dict; vectorise; cap split factor        | ✅ Fixed (98936fe) — fast-path skips inner loop when `slot_value_divisor == 1` |
| 5  | MED      | Sensors `async_write_ha_state()` every tick with no hysteresis        | `sensor.py:144, 189, 214` ← `coordinator.py:_tick`| 60 state events/min/sensor → recorder + bus storms     | Skip write if delta < threshold or < N seconds        | ✅ Fixed (b5304f2) — 5 W / 30 s hysteresis on 3 power sensors |
| 6  | MED      | Solar-forecast state-change debounced only to 1 s                     | `coordinator.py:471-476, 437`                   | Bursty source updates fan out to full automation rebuild| Raise debounce to 30–60 s; hash-compare points        | ✅ Fixed (e9eca36) — debounce raised to 30 s; state+wh_period+last_changed guard added |
| 7  | MED      | Redundant `dt_util.now()` calls down forecast call stack              | `coordinator.py:525, 1669-1734` (and downstream)| Repeated tz conversions per forecast                   | Pass single `reference_time` through the call tree    | ✅ Fixed (89744b7) — startup block consolidated to single `reference_time = dt_util.now()` |
| 8  | MED      | Recorder post-processing runs on event loop after executor query      | `recorder_hourly_series.py:151-177`, `solar_bias_correction/forecast_history.py:252-282` | Loop iterates 10k+ states inline                       | Move parse/normalise into the executor job            | ✅ Fixed (de13b03) — all parsing/sampling moved into `_query_and_parse` executor closure |
| 9  | LOW-MED  | Snapshot saved on every forecast refresh                              | `coordinator.py:1683-1690`, `storage.py:84-92`  | HA `Store` has built-in 10 s debounce, but no hash check | Skip save if payload hash unchanged                  | ✅ Fixed (5073f2a) — SHA1 hash guard skips `async_save` when payload unchanged |
| 10 | LOW      | Per-consumer recorder queries re-run every refresh, no result cache   | `consumption_forecast_builder.py:411-449`       | N entities × 4 refreshes/h, no TTL                     | Cache result keyed by `(entity, slot_start)`, 10 min TTL | — Excluded (subsumed by #3 fix) |

---

## Details

### 1 — HIGH · 1-second tick + recursive tree walk
`coordinator.py:2722` reads `history_bucket_duration` with default **1**, passed straight into `async_track_time_interval(..., timedelta(seconds=bucket_duration))`. Each tick (`_tick`, line 2748) calls `_compute_all_unmeasured_powers()` which recurses through the device tree (`_traverse_for_unmeasured`, 2947-2970). On a typical setup that's 60 recursive walks/minute, 24×7. A bigger interval would be invisible to users — most consuming sensors are not visualised at sub-second resolution.

**Fix:** raise the default to 5 s (or 10 s); flatten the tree once on rebuild and iterate a list, not the tree.

### 2 — HIGH · `deepcopy` on the hot forecast path
`grep -c deepcopy coordinator.py` → 34 (1 import + 33 calls). Confirmed hot-path uses: `_merge_grid_forecast_responses` (142-160), `_async_get_canonical_solar_forecast` (828-846), the automation snapshot setup block (1653-1927). Forecast snapshots are 8 days × 96 slots of nested dicts; `copy.deepcopy` is recursive and roughly 50× slower than a shallow copy.

**Fix:** most call sites only need to swap one nested key; replace with `{**old, "key": new}` / list comprehension, or build the merged structure once and pass references.

### 3 — HIGH · Unconditional 15-min forecast rebuild + per-consumer recorder queries
`coordinator.py:2622-2627` schedules `async_track_time_change(minute=[0,15,30,45], second=0)`. `_async_refresh_house_forecast` (1624-1706) calls `ConsumptionForecastBuilder.build()` which loops `for consumer in consumers_config: await self._query_slot_history(...)` (411-449) — each call hits `state_changes_during_period`. Solar bursts arrive separately and *also* trigger rebuilds via the debouncer (see #6). Result: forecast rebuild and N recorder queries can run several times per 15-minute window with no result cache.

**Fix:** debounce the refresh end-to-end; cache `(entity_id, slot_start)` history for 5–10 min and only re-query slots that changed.

### 4 — MED-HIGH · Solar slot expansion is `O(points × split_factor)`
`battery_capacity_forecast_builder.py:1115-1127` nests `for split_index in range(slot_value_divisor)` inside the points loop, where `slot_value_divisor = interval_minutes // FORECAST_CANONICAL_GRANULARITY_MINUTES`. With high-frequency input (1-min points, 24 h horizon) this is 1440 × 15 ≈ **21 600** iterations per refresh, each doing dict look-ups. Initial estimate of "1500" was conservative.

**Fix:** pre-allocate `by_slot` with all keys, replace `.get(...,0) + v` with direct assignment, and bypass the inner loop when `slot_value_divisor == 1`.

### 5 — MED · Sensor writes every tick with no change guard
`sensor.py:144, 189, 214` call `self.async_write_ha_state()` unconditionally inside `update_value()`, and those `update_value` calls fire from `_tick()` every 1 s (see #1). Each write spawns a state-change event → bus subscribers + recorder. Power values are inherently noisy (±1 W) and produce a state row every second per sensor.

**Fix:** before writing, compare to the last value and skip if `|Δ| < threshold` and `Δt < N s`. Also benefits the recorder DB size — the same root cause as the bug fixed in `dc5811e`.

### 6 — MED · 1-second debounce on solar source state changes
`coordinator.py:471-476` listens to every solar-forecast entity. The debouncer at line 437 has `cooldown=1.0`. Cooldown=1 s means a noisy source still triggers `_async_refresh_forecast_and_request_automation` many times a minute — that path runs the full automation pipeline (recorder, simulator, optimiser).

**Fix:** raise cooldown to 30–60 s; or hash the parsed points and short-circuit when unchanged.

### 7 — MED · Repeated `dt_util.now()` in the forecast call tree
`coordinator.py` calls `dt_util.now()` at multiple levels (525, 542, 547, 784, 811, 863, 1248, 1288, 1295, 1311, 1402, 1457, 1488, 1624, 1669, 1734). Builders called from these points do their own `dt_util.now()` again. Each call performs a tz conversion. Not catastrophic individually, but multiplies on every refresh.

**Fix:** compute `reference_time` once at the public entrypoint and thread it through.

### 8 — MED · Post-recorder processing on the event loop
`recorder.async_add_executor_job(state_changes_during_period, ...)` correctly off-threads the DB call (`recorder_hourly_series.py:151`, `solar_bias_correction/forecast_history.py:256, 379`), but the *parsing/normalisation* of the returned states (lines 164-177 etc.) happens back on the event loop. With multi-thousand-state results this blocks the loop briefly.

**Fix:** wrap the entire query+parse pipeline in one executor job.

### 9 — LOW-MED · Snapshot saved every refresh, no content hash
`coordinator.py:1685` calls `self._storage.async_save_snapshots(...)` every forecast refresh. HA's `Store` already debounces (default 10 s delay), so this is **softer than originally claimed** — the disk-write rate is bounded. But there's no hash check, so identical snapshots still get serialised.

**Fix:** keep last-saved hash in memory; skip the call when unchanged.

### 10 — LOW · No caching of consumer history across refreshes
`consumption_forecast_builder.py:411-449` re-queries history for every consumer every refresh, even though completed slots are immutable.

**Fix:** memoise per-(entity, slot) for the past window; query only slots overlapping `now()`.

---

## Verification notes

Each finding was cross-checked by a second pass that read the cited code:
- Line numbers and defaults validated against the actual files (`coordinator.py` is 3022 lines).
- Claim originally stating "no Store debouncing" was downgraded once HA's built-in `Store` debounce was confirmed (#9).
- Claim 4's iteration estimate was raised after reading `_compute_split_factor` — actual cost depends on input granularity and can be ~14× the original estimate at 1-minute resolution.

## Recommended order of attack

1. **#1 + #5 together** (raise tick interval, add hysteresis) — cheapest change, biggest baseline-CPU impact.
2. **#3 + #6** — debounce + cache the rebuild trigger; reduces recorder load.
3. **#2** — replace `deepcopy` on the merge paths.
4. **#4** — only matters if you actually feed sub-15-min solar input.
5. **#7, #8, #9, #10** — incremental clean-up.
