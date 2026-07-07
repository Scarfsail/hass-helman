# Implementation Progress: Remove `sensor.helman_power_summary` + Per-Node Sensors

## Source Documents
- [Doc 1 — Remove power summary sensor (architecture)](./proposal_remove_power_summary_sensor.md)
- [Doc 2 — Unmeasured power sensors implementation](./proposal_remove_power_summary_sensor_implementation.md)
- [Doc 3 — Virtual grouping sensors](./proposal_virtual_grouping_sensors.md)

## Implementation Plan

Four steps: BE first, FE second, then BE+FE for virtual sensor.
Each step is implemented by a sub-agent and reviewed before merging to the next step.

---

### Step 1 — BE: Debounce, per-node unmeasured sensors, remove `HelmanPowerSummarySensor` [ ]

**Files changed:** `sensor.py`, `coordinator.py`, `tree_builder.py`

#### Changes

**`tree_builder.py` — `_add_unmeasured_nodes()`**
- Set `power_sensor_id` on unmeasured node: `sensor.helman_{slug}_unmeasured_power`
  (slug = `node.id` with dots replaced by underscores, e.g. `house` → `house`)
- Apply recursively to all qualifying parent nodes (not just `house`)

**`sensor.py`**
- Delete `HelmanPowerSummarySensor` class
- Keep `HelmanBatteryTimeSensor` unchanged
- Rename `HelmanUnmeasuredPowerSensor` (rename `unique_id` and `_attr_name` to use node-id prefix)
- Make `async_setup_entry` dynamic: ask coordinator for tree, create one
  `HelmanUnmeasuredPowerSensor` per qualifying parent node
- `async_setup_entry` signature stays the same

**`coordinator.py`**
- Remove `_sensor: HelmanPowerSummarySensor | None` field
- Remove `_compute_snapshot()` method
- Remove `_push_power_snapshot()` method
- Add `_debounce_handle: asyncio.TimerHandle | None = None` field
- Add `_unmeasured_sensors: dict[str, HelmanUnmeasuredPowerSensor]` (node_id → sensor)
- Change `set_sensors(power_summary, battery_time, unmeasured)` →
  `set_sensors(battery_time, unmeasured_sensors: dict[str, sensor])` (drop power_summary)
- Update `_sensors_total` = `1 (battery_time) + len(unmeasured_sensors)`
- Rename `_compute_unmeasured_power()` → `_compute_all_unmeasured_powers()` returning
  `dict[str, float]` (node_id → watts); generic tree traversal, not house-specific
- Add `_debounced_power_update()`: calls `_compute_all_unmeasured_powers()` + battery ETA,
  pushes to respective sensors
- Change `_on_power_sensor_change`: schedule 1000 ms debounce
  (cancel existing handle first)
- Update `async_unload()`: cancel debounce handle; clear dict
- Update `_async_rebuild_subscriptions()`: trigger debounced update instead of old push

**Status:** ✅ Complete (review passed after fixes: removed sources walk from `_collect_qualifying_node_ids`, added `_sensors_total==0` guard in `register_sensor_ready`)

---

### Step 2 — FE: Remove legacy mode, use unmeasured sensor IDs from tree DTO [ ]

**Files changed:** `energy-data-helper.ts`, `helman-card.ts`, `DeviceNode.ts`

#### Changes

**`energy-data-helper.ts`**
- Remove `BACKEND_AVAILABLE_ENTITY` constant
- Remove `fetchSourceAndConsumerRootsLegacy()` function (entire legacy block ~200 lines)
- Remove `fetchDeviceTree()` function (~150 lines)
- Remove `inspectNodeAndAddUnmeasuredNodeToChildren()` function (only used by legacy)
- `fetchSourceAndConsumerRoots()` → simply calls `fetchDeviceTreeFromBackend()` unconditionally
  (no more conditional on `hass.states`)
- Remove `enrichUnmeasuredDeviceTreeWithHistory()` function (~70 lines) and both call sites
- Remove the `hass.states[BACKEND_AVAILABLE_ENTITY]` check used to reset histories
- Remove the legacy mode history fetch branch (everything after the backend mode block)
- Remove all legacy-mode-only code inside `enrichDeviceTreeWithHistory`
- Keep `calculateVirtualNodeHistory` for now (still needed by virtual nodes — removed in Step 4)
- Keep virtual-node source-ratio loop for now (removed in Step 4)

**`helman-card.ts`**
- Simplify `hass` setter: remove `sensor.helman_power_summary` guard;
  always call `this.requestUpdate()` when `_deviceTree.length > 0`

**`DeviceNode.ts`**
- `updateLivePower()`: remove `isUnmeasured` power-derivation branch
- `updateLivePower()`: remove parent's `unmeasuredPower` calculation + special call to
  `unmeasuredNode.updateLivePower(hass, sourceNodes, unmeasuredPower)`
- `updateLivePower()`: remove `!this.isUnmeasured` from live source-ratio guard
  → guard becomes: `if (!this.isSource && !this.isVirtual && this.powerSensorId)`

**Status:** ✅ Complete (review passed after fixes: deleted 300-line block-commented legacy code; added null guard on `hass.states[powerSensorId]?.state` in `DeviceNode.ts`)

---

### Step 3 — BE: `sensor.helman_total_power`, embed `totalPowerSensorId` in tree response [ ]

**Files changed:** `sensor.py`, `coordinator.py`, `websockets.py` (or `coordinator.py` get_device_tree)

> **Prerequisite:** Steps 1 and 2 complete

#### Changes

**`sensor.py`**
- Add `HelmanTotalPowerSensor` class (mirrors `HelmanUnmeasuredPowerSensor` pattern)
  - unique_id: `{entry_id}_total_power`
  - name: `"Helman Total Power"`
  - device class: POWER, unit: W
  - `update_value(watts: float)` method

**`coordinator.py`**
- Add `_total_power_sensor: HelmanTotalPowerSensor | None = None` field
- Update `set_sensors()` to accept total_power sensor
- Update `_sensors_total` += 1
- Add `_compute_total_power() → float`: sum consumer-side top-level node powers
  (house + |battery_charging| + |grid_export|) using their `valueType` clamping
- Wire `_total_power_sensor.update_value()` into `_debounced_power_update()`
- Add `sensor.helman_total_power` to `_power_sensor_ids` so history aggregator includes it

**`get_device_tree` response**
- The tree dict returned by `coordinator.get_device_tree()` includes a new field:
  `totalPowerSensorId = "sensor.helman_total_power"`
- Embed this directly in `HelmanTreeBuilder.build()` return value

**Status:** ✅ Complete (review fixes: `SensorStateClass.MEASUREMENT` added to both power sensor classes; `TOTAL_POWER_ENTITY_ID` constant in `const.py` used in both files; null guard added to `_compute_total_power()`)

---

### Step 4 — FE: Virtual containers use `totalPowerSensorId`, delete special-case code [ ]

**Files changed:** `energy-data-helper.ts`, `DeviceNode.ts`

> **Prerequisite:** Step 3 complete

#### Changes

**`energy-data-helper.ts`**
- `fetchDeviceTreeFromBackend`: update WS response type to include `totalPowerSensorId: string | null`
- Pass `totalPowerSensorId` from payload to `hydrateDeviceNodes`
- `hydrateDeviceNodes`: add `totalPowerSensorId` param; assign it to both
  `sourcesNode.powerSensorId` and `consumersNode.powerSensorId`
- Remove `calculateVirtualNodeHistory()` function and its two call sites (backend mode + legacy)
  — at this point both call sites are in backend mode only (legacy was removed in Step 2)
- Remove the virtual-node source-ratio derivation loop
  (`for (const node of allNodes) { if (node.isSource || node.powerSensorId || ...) ...}`)

**`DeviceNode.ts`**
- `updateLivePower()`: remove `isVirtual` branch that summed children
  → virtual nodes now have a `powerSensorId`; they fall through to the standard sensor read

**Status:** ✅ Complete (review passed after fix: added `node.isVirtual` to source-ratio loop guard to exclude both virtual containers from `sourcePowerHistory` assignment)

---

## Progress Log

| Step | Status | Notes |
|------|--------|-------|
| Step 1 (BE sensors) | ✅ Complete | Fixed: sources walk removed from `_collect_qualifying_node_ids`; added `_sensors_total==0` guard |
| Step 2 (FE legacy removal + unmeasured) | ✅ Complete | Fixed: deleted 300-line block-commented legacy code; added null guard on `hass.states[powerSensorId]?.state` |
| Step 3 (BE total power sensor) | ✅ Complete | Fixed: `SensorStateClass.MEASUREMENT` on both power sensors; `TOTAL_POWER_ENTITY_ID` constant; null guard in `_compute_total_power()` |
| Step 4 (FE virtual containers) | ✅ Complete | Fixed: added `node.isVirtual` to source-ratio loop guard |
