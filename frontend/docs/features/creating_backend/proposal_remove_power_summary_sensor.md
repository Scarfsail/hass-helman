# Proposal: Replace `sensor.helman_power_summary` with WebSocket Sensor Map + Unmeasured Power Sensors

### Repositories (relative to this document's location)
  - Backend: ../../../../hass-helman/custom_components/helman/
  - Frontend: ../../../../hass-helman-card/src/

---

## 1 — Context: Current Data Transfer Analysis

### 1.1 Communication channels in backend mode

| # | Channel | Direction | Trigger | Frequency |
|---|---------|-----------|---------|-----------|
| A | `helman/get_device_tree` WS | BE → FE | `connectedCallback` once | **One-shot** |
| B | `helman/get_history` WS | BE → FE | `connectedCallback` once (BE caches 2 s) | **One-shot** |
| C | `sensor.helman_power_summary` HA entity state push | BE → all WS clients | Every individual power sensor state change → `_push_power_snapshot()` | Once per sensor update (up to N_sensors/s) |
| D | `sensor.helman_battery_time_to_target` HA entity state push | BE → all WS clients | Same trigger as C | Same as C |
| E | `sensor.helman_unmeasured_house_power` HA entity state push | BE → all WS clients | Same trigger as C | Same as C |
| F | Per-entity `hass.states[powerSensorId]` | HA core → all WS clients | HA delivers for free, one state-changed event per entity | Per sensor, already paid for |
| G | `setInterval` 1 s timer | FE only (in-memory) | Client-side timer | 1 Hz, **zero network cost** |

### 1.2 What the frontend reads from each channel (backend mode only)

| Channel | Frontend reads | Used for |
|---------|---------------|----------|
| **A** `get_device_tree` | `payload.sources[]`, `payload.consumers[]` — full node topology | Builds `DeviceNode` tree once |
| **B** `get_history` | `entity_history[entityId][bucket]`, `source_ratios[entityId][sourceId][bucket]` | Seeds `node.powerHistory` + `node.sourcePowerHistory` |
| **C** `sensor.helman_power_summary` presence | `hass.states["sensor.helman_power_summary"] !== undefined` — reference equality check only | Backend-mode detection flag + `requestUpdate()` kick |
| **C** attrs `.house_power`, `.solar_power`, `.battery_power`, `.grid_power`, `.devices{}` | ❌ **Read by nobody in backend mode** | Dead weight published on every sensor change |
| **D** `sensor.helman_battery_time_to_target` | `.state` (minutes), `.attributes.target_time`, `.attributes.target_soc` | Battery ETA row in `power-device-info.ts` |
| **E** `sensor.helman_unmeasured_house_power` | ❌ **Never read by the frontend** | FE computes unmeasured power client-side in `DeviceNode.updateLivePower()` |
| **F** `hass.states[powerSensorId].state` | Float string per real sensor node | Live watt values in `DeviceNode.updateLivePower()` |
| **G** `setInterval` | Reads (F) in-memory + appends to `node.powerHistory[]` | Smooth bucket advancement |

### 1.3 Size estimate — 50 consumers, 60 buckets, 3 sources

| Channel | Payload breakdown | Estimated size |
|---------|------------------|----------------|
| **A** `get_device_tree` (one-shot) | ~54 nodes × ~15 JSON fields, strings | **~50 KB once** |
| **B** `get_history` (one-shot) | `entity_history`: 55 × 60 floats = 3 300 numbers; `source_ratios`: 53 × 3 × 60 = 9 540 numbers → 12 840 total numbers in JSON | **~100 KB once** |
| **C** `sensor.helman_power_summary` per push | 4 top-level ints + ISO timestamp + `devices` dict: 54 entries × ~50 chars ≈ 3 KB attributes + HA WebSocket envelope | **~4–5 KB per push** |
| **C** push rate | `async_track_state_change_event` fires once per individual sensor change — no debouncing; 55 tracked sensors × ~1 update/s | **Up to ~220 KB/s continuous** |
| **D** `sensor.helman_battery_time_to_target` per push | 1 float + 1 ISO string + 1 int | **~100 bytes, rare** |
| **E** `sensor.helman_unmeasured_house_power` per push | 1 int, never read | **~50 bytes, wasted** |

### 1.4 Problem summary

1. **`sensor.helman_power_summary` is almost entirely unused.** The FE only tests for its _existence_ — it never reads the `devices{}`, `house_power`, `solar_power`, `battery_power`, or `grid_power` fields from its attributes. All live power values are read directly from `hass.states[powerSensorId]` inside `DeviceNode.updateLivePower()`.

2. **No per-change debounce.** Every single power sensor update triggers a full `_push_power_snapshot()` → `async_write_ha_state()` on the summary sensor, publishing ~4–5 KB to every connected Lovelace client. With 55 sensors updating at 1 Hz this is ~220 KB/s of unused data.

3. **`sensor.helman_unmeasured_house_power` is never read by the FE** — the unmeasured remainder is computed client-side — yet it receives the same flood of pushes.

---

## 2 — Proposed Architecture

### 2.1 Overview

Replace `sensor.helman_power_summary` with:

| What | Purpose |
|----|---------|
| `sensor.helman_<node>_unmeasured_power` sensors | One real HA sensor per parent node that has children; BE computes and pushes the remainder (parent power − Σ measured children). `tree_builder.py` sets the sensor entity ID directly in the unmeasured node's `power_sensor_id` field, so the `get_device_tree` WS response carries a fully populated tree — no separate WS command needed. The FE assigns the entity ID to the unmeasured child node's `powerSensorId`, after which the standard live-update path in `DeviceNode.updateLivePower()` picks it up automatically. |

`sensor.helman_battery_time_to_target` remains unchanged.

### 2.2 New sensor naming convention

Pattern: `sensor.helman_<node_id>_unmeasured_power`

The `node_id` is the tree node's `id` field (already a slug: `house`, `boiler_circuit`, etc.).

| Node id | Sensor entity id |
|---------|-----------------|
| `house` | `sensor.helman_house_unmeasured_power` |
| `boiler_circuit` | `sensor.helman_boiler_circuit_unmeasured_power` |
| any future nested parent | `sensor.helman_<node_id>_unmeasured_power` |

> Naming change from current: `sensor.helman_unmeasured_house_power` →  `sensor.helman_house_unmeasured_power` (node id first, consistent with all future sensors).

### 2.3 Which nodes get an unmeasured sensor

A node qualifies if **all** of the following hold:
- It is **not virtual** (`isVirtual = False`)
- It has **at least one non-virtual, non-unmeasured child**
- It has a `powerSensorId` (so the measured total is known)

This means: `house` qualifies today; if a sub-circuit node gains children in future, it also qualifies automatically.

Virtual container nodes (`sources`, `consumers`) do **not** qualify — they have no real sensor behind them.

### 2.4 Unmeasured sensor IDs embedded in `get_device_tree`

`tree_builder.py` knows which nodes qualify for an unmeasured sensor (see 2.3) and fills their `powerSensorId` field directly with the deterministic slug `sensor.helman_<node_id>_unmeasured_power`. The FE receives a fully populated tree from the single `get_device_tree` call — no separate `get_sensor_map` command is needed.

### 2.5 Backend detection — no legacy fallback

The integration supports **backend mode only**. The legacy YAML-config path is removed as part of this change (Phase 7 scope). There is no need for a sentinel entity or a runtime mode-detection mechanism — the FE simply assumes the backend is present and calls `helman/get_device_tree` unconditionally.

---

## 3 — Frontend changes

| Location | Change |
|----------|--------|
| `energy-data-helper.ts` | Remove `BACKEND_AVAILABLE_ENTITY` constant and all legacy-mode branches — `fetchSourceAndConsumerRoots` calls `fetchDeviceTreeFromBackend` unconditionally |
| `energy-data-helper.ts` | Unmeasured nodes receive their `powerSensorId` directly from the tree DTO (already populated by `tree_builder.py`) — no post-hydration patching needed |
| `helman-card.ts` `hass` setter | Remove the `hass.states["sensor.helman_power_summary"]` guard — `requestUpdate()` is always called in backend mode |
| `DeviceNode.updateLivePower()` | Remove the `!this.isUnmeasured` guard from the live source-ratio calculation so that unmeasured nodes (which now have a `powerSensorId`) participate in source-ratio updates. Also remove the `isUnmeasured` power-derivation branch and the parent's `unmeasuredPower` pass-down block. |
| `power-device-info.ts` | **No change.** Battery ETA still reads `sensor.helman_battery_time_to_target` |

---

## 4 — Backend changes

| Location | Change |
|----------|--------|
| `sensor.py` | Delete `HelmanPowerSummarySensor` class and its `extra_state_attributes` snapshot |
| `sensor.py` | Add `HelmanUnmeasuredPowerSensor` instantiation **per qualifying node** (dynamically from the built tree). Rename the existing single instance: `helman_unmeasured_house_power` → `helman_house_unmeasured_power`. |
| `coordinator.py` | Delete `_compute_snapshot()`, `_push_power_snapshot()` and all snapshot dict building |
| `coordinator.py` | Extend `_compute_unmeasured_power()` to cover **all qualifying nodes** (not just house); push each result to its dedicated sensor. Add a **1000 ms debounce**: `_on_power_sensor_change` schedules a single delayed task; subsequent events within the window cancel and reschedule it, so one burst of sensor changes produces exactly one computation pass. |
| `coordinator.py` | The `_on_power_sensor_change` callback triggers only per-node unmeasured computations and battery ETA — no full snapshot |
| `tree_builder.py` | Populate `power_sensor_id` on unmeasured placeholder nodes with `sensor.helman_<slugified_node_id>_unmeasured_power` so `get_device_tree` returns a fully populated tree. Node IDs containing dots (e.g., `sensor.shelly_boiler_energy`) are slugified by replacing dots with underscores. |

---

## 5 — Decisions

### 5.1 Sensor IDs embedded in `get_device_tree` — no separate WS command

`tree_builder.py` fills `power_sensor_id` for all unmeasured placeholder nodes with the deterministic slug directly. The `get_device_tree` response is fully self-contained; no `get_sensor_map` command will be added.

### 5.2 Backend-only mode — no sentinel entity

The integration operates in backend mode exclusively. The legacy YAML-config path is removed entirely as part of this change. No sentinel entity (`binary_sensor.helman_active` or similar) is needed — there is no fallback to detect.

### 5.3 Debounce window: 1000 ms

`_on_power_sensor_change` will schedule a single delayed task with a **1000 ms** window. Any further event within that window cancels and reschedules the task, ensuring one computation pass per burst regardless of how many individual sensors fire. This window matches the minimum history bucket duration and is imperceptible to the user.

### 5.4 Sensor naming convention (confirmed)

| | Pattern | Example |
|-|---------|--------|
| Entity ID | `sensor.helman_{node_id}_unmeasured_power` | `sensor.helman_house_unmeasured_power` |
| Human-readable name | `Helman {Node Name} Unmeasured Power` | `Helman House Unmeasured Power` |

Subject (node) comes immediately after the integration prefix; metric qualifier follows. This is consistent with the existing `sensor.helman_battery_time_to_target` / `Helman Battery Time to Target` pattern.

---

## 6 — Savings estimate after this change

| Item | Before | After |
|------|--------|-------|
| State push on every sensor change | ~4–5 KB × up to 55/s = **~220 KB/s** | `sensor.helman_house_unmeasured_power`: ~200 bytes × ~1 change/s after debounce = **~200 B/s** |
| `sensor.helman_unmeasured_house_power` (unused, never read) | ~50 bytes per push, ~55/s | Replaced by a correctly-named, correctly-used sensor — debounced |
| Snapshot computation in coordinator | Full `_compute_snapshot()` on every event: O(N_nodes) dict building | Eliminated entirely |
| Net WS traffic reduction | baseline ~220 KB/s (55 sensors × 4 KB) | **> 99 % reduction** for the summary channel |
| One-shot startup cost | Unchanged (A + B remain) | Unchanged |

> Numbers assume all 55 sensors update at roughly 1 Hz and that HA does not already batch coincident state changes (it does not — each entity fires its own event).

---

## 7 — Summary of entity changes

| Entity | Before | After |
|--------|--------|-------|
| `sensor.helman_power_summary` | Existed, 95 % of payload unread | **Deleted** |
| `sensor.helman_unmeasured_house_power` | Existed, never read by FE | **Renamed** → `sensor.helman_house_unmeasured_power`; now has `powerSensorId` set in tree DTO and is read by FE via standard live path |
| `sensor.helman_<node>_unmeasured_power` | Did not exist for nested parents | **Created dynamically** per qualifying parent node |
| `sensor.helman_battery_time_to_target` | Existed, read correctly | **Unchanged** |
