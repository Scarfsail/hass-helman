# Proposal: Real HA Sensors for Virtual Grouping Nodes (Sources & Consumers Containers)

> **Related documents:**
> - [proposal_remove_power_summary_sensor.md](./proposal_remove_power_summary_sensor.md) — removes the dead-weight `sensor.helman_power_summary` and introduces per-node unmeasured-power sensors
> - [proposal_remove_power_summary_sensor_implementation.md](./proposal_remove_power_summary_sensor_implementation.md) — wires unmeasured-power sensors into the uniform history path

---

## 1 — Context: What Are the Virtual Grouping Nodes?

The FE tree has two synthetic root containers created purely for UI layout:

| Virtual node id | UI label (default) | Children | Power concept |
|----------------|-------------------|----------|---------------|
| `sources` | "Energy Sources" | solar, battery (source side), grid (source side) | Total energy produced / imported |
| `consumers` | "Energy Consumers" / "Distribuce energie" | house, battery (consumer side), grid (consumer side) | Total energy consumed / exported |

Both nodes are created entirely on the FE side in `hydrateDeviceNodes()` (backend mode). They have:

```typescript
node.isVirtual = true;
node.powerSensorId = null;    // ← no HA sensor backs them
```

By energy conservation, `total_production ≈ total_consumption` at every instant. They are two views of the same energy flow, split by the card's arrow layout.

---

## 2 — Current Architecture: How Virtual Node Histories Are Computed

### 2.1 History initialisation (`enrichDeviceTreeWithHistory`)

Because virtual nodes have no `powerSensorId`, the backend history response (`entity_history`, `source_ratios`) contains nothing for them. After all real-sensor nodes are populated, a dedicated client-side pass fills them in:

```typescript
// Step 1 — power history: recursive child-sum
function calculateVirtualNodeHistory(node: DeviceNode) {
    if (node.isVirtual) {
        const childWithHistory = node.children.find(c => c.powerHistory && c.powerHistory.length > 0);
        if (childWithHistory) {
            const historyLength = childWithHistory.powerHistory.length;
            node.powerHistory = Array(historyLength).fill(0);
            for (let i = 0; i < historyLength; i++) {
                for (const child of node.children) {
                    calculateVirtualNodeHistory(child);          // recurse first
                    node.powerHistory[i] += (child.powerHistory && child.powerHistory[i]) || 0;
                }
            }
        }
    } else {
        for (const child of node.children) {
            calculateVirtualNodeHistory(child);
        }
    }
}

// Note: the actual code calls calculateVirtualNodeHistory(child) inside the
// inner loop, so each child is recursed into historyLength times instead of
// once. This is harmless (idempotent for non-virtual children) but wasteful —
// O(buckets × children × depth) instead of O(children × depth + buckets × children).
// Moot after this proposal deletes the function.

// Step 2 — source ratio history: proportional derivation from sources
for (const node of allNodes) {
    if (node.isSource || node.powerSensorId || node.powerHistory.length === 0) continue;
    // ← virtual nodes fall into this branch
    node.sourcePowerHistory = [];
    for (let i = 0; i < bucketCount; i++) {
        const totalSourcePower = sourceNodes.reduce((sum, s) => sum + (s.powerHistory[i] || 0), 0);
        const nodePower = node.powerHistory[i] || 0;
        // Distribute nodePower proportionally across sources
        ...
    }
}
```

**Called for:** both `sources` and `consumers` virtual root containers.

### 2.2 Live update tick (`DeviceNode.updateLivePower`)

```typescript
if (this.isVirtual) {
    power = this.children.reduce((sum, child) => sum + (child.powerValue || 0), 0);
}
```

Virtual nodes sum their children's live `powerValue` on every 1-second timer tick. This is correct and lightweight — it is already data held in memory.

### 2.3 Source ratio history — the real problem

The proportional-derivation approach in step 2 above produces the correct result **only if no energy is lost/gained outside the tracked sources**. More importantly, it recomputes source fractions from the sources' histories — which are already accurate — so the derivation itself is mathematically sound. However:

- It is an **extra client-side pass** that runs entirely outside the uniform sensor path.
- Any future virtual node (e.g., a per-floor grouping) would need the same special handling.
- The `calculateVirtualNodeHistory` function with its double-nested loop (O(buckets × children)) runs even when the backend already has the total power value available.

---

## 3 — Proposal: `sensor.helman_total_power`

### 3.1 One new sensor on the backend

| Sensor entity id | Value | Formula |
|-----------------|-------|---------|
| `sensor.helman_total_power` | Total instantaneous power in the system | `house + |battery_charging| + |grid_export|` |

By energy conservation, total consumption approximately equals total production at every instant. The sensor sums the **consumer-side** values — this ensures the consumers container power exactly matches the sum of its visible children. A single sensor captures this value and is assigned to **both** virtual containers — the same pattern already used for battery and grid nodes, which share one entity ID across their source and consumer roles.

The sensor is computed inside the debounced power computation pass introduced by
[proposal_remove_power_summary_sensor.md](./proposal_remove_power_summary_sensor.md)
(which deletes `_push_power_snapshot()` and replaces it with a 1000 ms debounced callback
that computes per-node unmeasured power and battery ETA). The total power computation
is added to the same debounced callback — no new subscriptions or trigger paths needed.

> **Prerequisite:** This proposal builds on top of the changes in Doc 1
> (`proposal_remove_power_summary_sensor.md`), which must be implemented first.
> In particular, `_push_power_snapshot()` and `_compute_snapshot()` no longer exist.

### 3.2 Backend changes

#### 3.2.1 `sensor.py` — one new sensor entity

```python
class HelmanTotalPowerSensor(SensorEntity):
    _attr_should_poll = False
    _attr_device_class = SensorDeviceClass.POWER
    _attr_native_unit_of_measurement = "W"
    _attr_name = "Helman Total Power"

    def __init__(self, coordinator, entry: ConfigEntry) -> None:
        self._coordinator = coordinator
        self._attr_unique_id = f"{entry.entry_id}_total_power"
        self._value: float | None = None

    @property
    def native_value(self) -> float | None:
        return round(self._value) if self._value is not None else None

    async def async_added_to_hass(self) -> None:
        self._coordinator.register_sensor_ready()

    def update_value(self, watts: float) -> None:
        self._value = watts
        self.async_write_ha_state()
```

The sensor is visible in the HA entities list by default — it represents a real, useful value that users may reference in automations or other cards.

#### 3.2.2 `coordinator.py` — compute and push in the debounced callback

The debounced power computation callback (introduced by Doc 1) already computes
per-node unmeasured power and battery ETA. Total power is added to the same pass:

```python
def _debounced_power_update(self) -> None:
    """Single computation pass, called once per debounce window."""
    ...
    # Existing: unmeasured power + battery ETA (from Doc 1)
    ...
    # New: total power for virtual containers
    total_power = self._compute_total_power()
    self._total_power_sensor.update_value(total_power)

def _compute_total_power(self) -> float:
    """Sum of all top-level consumer node powers (= total consumption ≈ total production)."""
    return sum(
        self._read_power(node.get("powerSensorId"), node.get("valueType", "default"))
        for node in self._cached_tree.get("consumers", [])
        if node.get("powerSensorId")
    )
```

#### 3.2.3 `get_device_tree` WS response — embed the sensor ID for both virtual containers

The WS response today returns:

```json
{
  "sources": [ ... ],
  "consumers": [ ... ]
}
```

Extend it with a single field used by both containers:

```json
{
  "sources": [ ... ],
  "consumers": [ ... ],
  "totalPowerSensorId": "sensor.helman_total_power"
}
```

The FE assigns this one entity ID to both `sourcesNode.powerSensorId` and `consumersNode.powerSensorId`.

#### 3.2.4 History aggregator — include the total power sensor

Add `sensor.helman_total_power` to `_power_sensor_ids` so it is included in the recorder
fetch and in `source_ratios`. Its source ratios are computed by the same
`_compute_source_ratios()` function as every other non-source sensor — no new logic.

### 3.3 Frontend changes

#### 3.3.1 `hydrateDeviceNodes` — set `powerSensorId` on both virtual containers

Both containers receive the same single entity ID, mirroring the battery/grid dual-role pattern:

```typescript
function hydrateDeviceNodes(
    sourceDTOs: DeviceNodeDTO[],
    consumerDTOs: DeviceNodeDTO[],
    config: HelmanCardConfig,
    totalPowerSensorId: string | null,   // ← new, shared by both containers
): DeviceNode[] {
    ...
    sourcesNode.isVirtual = true;
    sourcesNode.powerSensorId = totalPowerSensorId;    // ← now set

    consumersNode.isVirtual = true;
    consumersNode.powerSensorId = totalPowerSensorId;  // ← same sensor ID
    ...
}
```

#### 3.3.2 `enrichDeviceTreeWithHistory` — remove `calculateVirtualNodeHistory` and the virtual-node source-ratio loop

Because both virtual containers now have a `powerSensorId`, they are included in `nodesWithSensors` and receive their `powerHistory` and `sourcePowerHistory` from the standard loops — identical to every measured node. **No special handling remains for virtual nodes.**

The two functions / loops that are deleted:

| Removed | Lines (approx.) | Why |
|---------|----------------|-----|
| `calculateVirtualNodeHistory()` definition + call | ~20 lines | Virtual nodes now receive history via sensor path |
| Virtual-node source-ratio derivation loop (`!node.powerSensorId` branch) | ~20 lines | Covered by standard `source_ratios` loop |

#### 3.3.3 `DeviceNode.updateLivePower` — virtual nodes read from the sensor like any other node

Because both virtual containers now have a `powerSensorId`, the standard `hass.states` path applies directly. The `isVirtual` branch in `updateLivePower` is **removed entirely** — virtual nodes with a sensor fall through to the regular sensor-read path:

```typescript
// BEFORE — special case for virtual nodes
if (this.isVirtual) {
    power = this.children.reduce((sum, child) => sum + (child.powerValue || 0), 0);
}

// AFTER — no special case; powerSensorId is set, so the standard branch handles it:
if (this.powerSensorId) {
    power = parseFloat(hass.states[this.powerSensorId].state) || 0;  // hass.states is in-memory
}
```

`hass.states` is an in-memory object on the client — there is no network call. The result is that `isVirtual` no longer has **any** computational effect: it becomes a pure UI flag.

---

## 4 — Before / After Comparison

### 4.1 Node type matrix

| Node type | History seeding | Live update | Source ratio | Special flag drives computation |
|-----------|----------------|-------------|--------------|-------------------------------|
| Source | ✅ uniform sensor | ✅ sensor read | n/a | — |
| Consumer (top-level measured) | ✅ uniform sensor | ✅ sensor read | ✅ uniform | — |
| Child (measured) | ✅ uniform sensor | ✅ sensor read | ✅ uniform | — |
| Unmeasured power | ✅ uniform sensor *(after impl. doc)* | ✅ sensor read *(after impl. doc)* | ✅ uniform *(after impl. doc)* | `isUnmeasured` UI-only |
| **Virtual grouping** (before) | ❌ `calculateVirtualNodeHistory` child-sum | child-sum | ❌ proportional derivation loop | `isVirtual` drives history + ratio |
| **Virtual grouping** (after) | ✅ **uniform sensor** | ✅ **sensor read** | ✅ **uniform** | `isVirtual` UI-only |

### 4.2 Code deleted

| File | Removed | Why |
|------|---------|-----|
| `energy-data-helper.ts` | `calculateVirtualNodeHistory()` (~20 lines) + call sites | Virtual containers have real sensor histories |
| `energy-data-helper.ts` | Virtual-node `sourcePowerHistory` derivation loop (~20 lines) | Covered by `source_ratios` from BE aggregator |

### 4.3 Code added / changed

| File | Change | Complexity |
|------|--------|-----------|
| `sensor.py` | `HelmanTotalPowerSensor` (one class) | Low — mirrors existing pattern |
| `coordinator.py` | `_compute_total_power()` + wire into debounced callback (from Doc 1) | Low — simple sum of top-level source node powers |
| `coordinator.py` | Add `sensor.helman_total_power` to `_power_sensor_ids` | Trivial |
| `websockets.py` / `coordinator.get_device_tree` | Append single `totalPowerSensorId` field to WS response | Trivial |
| `energy-data-helper.ts` — `fetchDeviceTreeFromBackend` | Read `totalPowerSensorId` from WS response; pass to `hydrateDeviceNodes` | Trivial |
| `energy-data-helper.ts` — `hydrateDeviceNodes` | Assign same `powerSensorId` on both virtual container nodes | ~2 lines |
| `DeviceNode.ts` — `updateLivePower` | Remove `isVirtual` child-sum branch (node now has `powerSensorId`) | ~5 lines deleted |

---

## 5 — Benefits

1. **`calculateVirtualNodeHistory` is deleted.** The function is the only recursive, multi-pass special case remaining in the history enrichment pipeline after the unmeasured-node changes. Eliminating it completes the "one uniform path" goal.

2. **Historical accuracy.** Currently, the consumers container history is computed as the sum of the three top-level consumer histories — which in turn were fetched from the HA recorder as separate time-series and re-bucketed independently. If any consumer sensor has a gap or stale value for a bucket, the sum is silently wrong. A dedicated sensor, written at the same instant as the snapshot, is always self-consistent.

3. **`isVirtual` is demoted to a pure UI flag with zero computational effect.** After this change, `isVirtual` has no impact on history computation, source ratio derivation, or live power calculation. It only affects rendering decisions (collapsing, showing children indicators, icon rendering). This opens the door to renaming it to something more descriptive — `isContainer` or `isCollapsible` — as a follow-up refactoring. See Open Questions.

4. **Extensibility.** Any future virtual grouping node (e.g., "per-floor" container that sums several house children) would automatically get history via this pattern — the coordinator computes its total and the FE assigns the sensor ID. No new client-side derivation logic is ever needed.

---

## 6 — Decisions

1. **`isVirtual` rename — keep as-is.** The name is not ideal but the scope of a rename
   is large relative to the benefit. `isVirtual` stays; it can be revisited later if needed.

2. **Consumer-side sum for `sensor.helman_total_power`.** The sensor sums the consumer-side
   values (`house + |battery_charging| + |grid_export|`), not the source-side. This ensures
   the consumers container power exactly matches the sum of its visible children. The sources
   container will show the same value — by energy conservation the difference is negligible,
   and consistent display is more important than showing two near-identical but slightly
   different totals.