# Implementation: One Real HA Sensor per Node — Wiring Unmeasured Power Nodes into the Uniform Path

> **Parent proposal:** [proposal_remove_power_summary_sensor.md](./proposal_remove_power_summary_sensor.md)
> — that document motivates replacing the bulk `sensor.helman_power_summary` entity with
> per-node unmeasured-power sensors (entity IDs embedded in the `get_device_tree` DTO).
> This document details the concrete implementation: wiring those sensors fully into the
> history aggregator so that unmeasured power nodes travel the same code path as every other node.

---

## 1 — Terminology

| Term | Meaning |
|------|---------|
| **Source node** | A top-level supply node (solar, battery-discharging, grid-import). Already has a real sensor. |
| **Consumer node** | A top-level demand node (house, battery-charging, grid-export). Already has a real sensor. |
| **Child (measured) node** | A device inside `house` that has its own power sensor. Already has a real sensor. |
| **Unmeasured power node** | A synthetic child added automatically to every parent that has measured children. Represents `parent_power − Σ measured_children_power`. **Currently has no sensor — it is the only node type without one.** |
| **Virtual grouping node** | The synthetic `sources` / `consumers` container roots (e.g. the "Energy Distribution" node that wraps house, battery and grid consumers). These are pure UI groupings; no real power concept → no sensor, and this does NOT change. |

The key asymmetry today: unmeasured power nodes are the only nodes without a backing HA sensor.

---

## 2 — Current Architecture: Where the Asymmetry Lives

### 2.1 Frontend — history initialisation (backend mode)

`enrichDeviceTreeWithHistory()` in [energy-data-helper.ts](../../../src/energy-data-helper.ts):

```
For all real-sensor nodes          → node.powerHistory    = entity_history[sensorId]
                                     node.sourcePowerHistory = source_ratios[sensorId]
                                                               (pre-computed by BE)

For virtual container nodes        → powerHistory summed from children (simple sum, ~10 lines)
(sources / consumers)                sourcePowerHistory derived proportionally from children

For UNMEASURED POWER nodes         → **special-cased in enrichUnmeasuredDeviceTreeWithHistory()**
```

`enrichUnmeasuredDeviceTreeWithHistory()` (~70 lines of recursive logic):

```
For each bucket i:
  unmeasured.powerHistory[i]  = parent.powerHistory[i]
                              − Σ child.powerHistory[i]   (for all measured children)

  For each source s:
    unmeasured.sourcePowerHistory[i][s] = parent.sourcePowerHistory[i][s].power
                                        − Σ child.sourcePowerHistory[i][s].power
```

This function knows about the **parent**, the **parent's source ratios**, and every **sibling**.
It is the only place in the code that needs to traverse upward (or pass parent context downward)
to fill a node's history.

### 2.2 Frontend — live update tick

`DeviceNode.updateLivePower()`:

```typescript
if (this.isUnmeasured) {
    if (unmeasuredPower == undefined) return;   // ← must be passed in from parent
    power = unmeasuredPower;
} else {
    power = parseFloat(hass.states[this.powerSensorId].state);
}
```

The parent node is responsible for computing `unmeasuredPower` and passing it down:

```typescript
// inside updateLivePower, after processing regular children:
const childrenPower = this.children
    .filter(c => !c.isUnmeasured)
    .reduce((sum, c) => sum + (c.powerValue || 0), 0);
const unmeasuredPower = this.powerValue - childrenPower;
unmeasuredNode.updateLivePower(hass, sourceNodes, unmeasuredPower);
```

No other node type requires this cross-node value passing.

### 2.3 Backend — what already exists but is unused by FE

`coordinator.py`:

```python
def _compute_unmeasured_power(self) -> float:
    # Only handles house node — returns house_power − Σ measured_child_power
    ...

def _push_power_snapshot(self):
    ...
    if self._unmeasured_sensor is not None:
        unmeasured = self._compute_unmeasured_power()
        self._unmeasured_sensor.update_value(unmeasured)   # → sensor.helman_unmeasured_house_power
```

`tree_builder.py — _add_unmeasured_nodes()`:

```python
unmeasured = DeviceNodeDTO(
    id="unmeasured",
    power_sensor_id=None,   # ← no sensor ID is set
    is_unmeasured=True,
    ...
)
```

**The sensor already exists and is already being written. The FE simply never reads it.** 
The sensor entity ID (`sensor.helman_unmeasured_house_power`) is not transmitted to the FE, 
and the history aggregator does not include it in its fetch.

---

## 3 — Complexity Metrics for the Current Approach

### 3.1 Source ratio derivation per bucket

For a parent with $N$ measured children, $S$ sources, and $B$ history buckets:

| Step | Current (derivation) | Proposed (direct) |
|------|---------------------|-------------------|
| Compute `unmeasured.powerHistory` | $O(N \times B)$ — subtract each child from parent | $O(B)$ — read from recorder via BE aggregator |
| Compute `unmeasured.sourcePowerHistory` | $O(N \times S \times B)$ — subtract each source fraction per child per bucket | $O(S \times B)$ — `power_i × (source_power_i / total_source_i)` same as every other node |
| **Coupling** | Needs parent object + all siblings to be pre-populated | Only needs own sensor ID |
| **Recursive depth** | Must recurse through all nested parents | Flat — same loop as any node |

For a typical setup (50 children, 3 sources, 60 buckets):
- Current derivation: $50 \times 3 \times 60 = 9\,000$ operations per nested parent
- Proposed: $3 \times 60 = 180$ operations per node, identical to any other node

### 3.2 Code paths touched per node type

| Node type | History seeding | Live update | Source ratio | Special flag |
|-----------|----------------|-------------|--------------|--------------|
| Source | ✅ uniform | ✅ uniform | n/a (source) | `isSource` (UI only) |
| Consumer (measured) | ✅ uniform | ✅ uniform | ✅ uniform | — |
| Child (measured) | ✅ uniform | ✅ uniform | ✅ uniform | — |
| **Unmeasured power** | ❌ **special function** | ❌ **parent must pass value** | ❌ **parent-subtraction derivation** | `isUnmeasured` drives computation |
| Virtual grouping | ✅ simple child-sum | ✅ sum of children | ✅ proportional from children | `isVirtual` (UI only) |

---

## 4 — Proposed Architecture: Sensor per Unmeasured Power Node

### 4.1 Backend changes

#### 4.1.1 Dynamic sensor creation

Currently `sensor.helman_unmeasured_house_power` is created statically for the `house` node.
The implementation generalises this to every unmeasured power node using the naming convention
from the parent proposal:

```
sensor.helman_<node_id>_unmeasured_power
```

Examples:

| Parent node id | New sensor entity id |
|---------------|---------------------|
| `house` | `sensor.helman_house_unmeasured_power` *(already exists)* |
| `boiler_circuit` | `sensor.helman_boiler_circuit_unmeasured_power` |
| `floor_heating` | `sensor.helman_floor_heating_unmeasured_power` |

#### 4.1.2 Coordinator generalisation

`_compute_unmeasured_power()` becomes `_compute_all_unmeasured_powers()` — walks the full
consumer tree and computes `parent_power − Σ measured_child_power` for every parent that has
children:

```python
def _compute_all_unmeasured_powers(self) -> dict[str, float]:
    """Returns { node_id → unmeasured_watts } for each unmeasured power node."""
    result: dict[str, float] = {}
    self._traverse_for_unmeasured(self._cached_tree.get("consumers", []), result)
    return result

def _traverse_for_unmeasured(self, nodes: list, result: dict) -> None:
    for node in nodes:
        children = node.get("children", [])
        if children:
            if not node.get("isVirtual"):
                parent_power = self._read_power(node.get("powerSensorId"), node.get("valueType", "default"))
                measured_sum = sum(
                    self._read_power(c.get("powerSensorId"), c.get("valueType", "default"))
                    for c in children
                    if not c.get("isVirtual") and not c.get("isUnmeasured") and c.get("powerSensorId")
                )
                result[node["id"]] = max(0.0, parent_power - measured_sum)
            self._traverse_for_unmeasured(children, result)
```

#### 4.1.3 History aggregator — include unmeasured sensor IDs

The `get_history` WS response already returns `entity_history` and `source_ratios` for every 
sensor ID in `_power_sensor_ids`. The unmeasured sensors need to be added to that list.
Since the unmeasured sensor states are written to HA state machine (and therefore recorded),
the aggregator fetches their history from the recorder exactly like any other sensor:

```python
# coordinator.get_history() — add unmeasured IDs to the fetch list
all_sensor_ids = self._power_sensor_ids + self._unmeasured_sensor_ids
```

Source ratios for unmeasured sensors are then computed by the **identical** `_compute_source_ratios()`
function already in `HelmanHistoryAggregator` — no new logic needed.

#### 4.1.4 Tree builder — set `power_sensor_id` on unmeasured nodes

```python
def _add_unmeasured_nodes(self, node: DeviceNodeDTO, unmeasured_title: str) -> None:
    if not node.children or node.is_virtual:
        return
    # Slugify node.id: replace dots with underscores to produce a valid HA entity ID
    # (entity IDs allow only [a-z0-9_] after the domain dot).
    slug = node.id.replace(".", "_")
    sensor_id = f"sensor.helman_{slug}_unmeasured_power"
    unmeasured = DeviceNodeDTO(
        id=f"{slug}_unmeasured",
        power_sensor_id=sensor_id,   # ← now set!
        is_unmeasured=True,
        ...
    )
    node.children.append(unmeasured)
    for child in node.children:
        self._add_unmeasured_nodes(child, unmeasured_title)
```

### 4.2 Frontend changes

#### 4.2.1 Remove `enrichUnmeasuredDeviceTreeWithHistory` entirely

Because the unmeasured node now has a `powerSensorId`, the uniform backend-mode path already
handles it:

```typescript
// This existing loop now covers unmeasured power nodes too — no special case needed:
for (const [entityId, nodes] of nodesWithSensors) {
    const rawHistory = entity_history[entityId];   // ← unmeasured sensor is in entity_history
    for (const node of nodes) {
        node.powerHistory = processedHistory;
    }
}

// source_ratios now contains the unmeasured entity ID — same loop assigns sourcePowerHistory:
for (const node of allNodes) {
    if (node.isSource || !node.powerSensorId) continue;
    const nodeRatios = source_ratios[node.powerSensorId];   // ← includes unmeasured
    ...
}
```

The ~70-line `enrichUnmeasuredDeviceTreeWithHistory` **and its call sites** are deleted.

#### 4.2.2 Simplify `DeviceNode.updateLivePower`

The `isUnmeasured` branch in `updateLivePower` becomes a regular sensor read:

```typescript
// BEFORE
if (this.isUnmeasured) {
    if (unmeasuredPower == undefined) return;
    power = unmeasuredPower;
}

// AFTER — same branch as every other sensor-backed node:
// (The isUnmeasured branch is simply removed; the node has powerSensorId and falls
//  through to the standard hass.states read)
```

The parent's computation block that derives `unmeasuredPower` and calls 
`unmeasuredNode.updateLivePower(hass, sourceNodes, unmeasuredPower)` is also removed.

#### 4.2.3 Remove `!this.isUnmeasured` from the live source-ratio guard

The live source power calculation guard currently reads:

```typescript
if (!this.isSource && !this.isVirtual && !this.isUnmeasured && this.powerSensorId) {
```

The `!this.isUnmeasured` condition must be removed. After this proposal, unmeasured nodes
have a `powerSensorId` and participate in the standard sensor-read path — they must also
participate in the live source-ratio calculation. Without this change, unmeasured nodes'
source-ratio bars would freeze at the last historical value and only refresh on a full
history reload:

```typescript
// AFTER — unmeasured nodes are regular sensor-backed nodes:
if (!this.isSource && !this.isVirtual && this.powerSensorId) {
```

#### 4.2.4 `isUnmeasured` flag — demoted to UI-only

`isUnmeasured` can be retained as a UI hint (e.g., to suppress the switch toggle button or
apply a different icon) but no longer drives any computational logic. Its role becomes
analogous to `isSource` — a marker for rendering decisions only.

---

## 5 — Before / After Summary

### 5.1 Data flow per node type (after proposal)

| Node type | History seeding | Live update | Source ratio | Special flag |
|-----------|----------------|-------------|--------------|--------------|
| Source | ✅ uniform | ✅ uniform | n/a | `isSource` (UI) |
| Consumer (measured) | ✅ uniform | ✅ uniform | ✅ uniform | — |
| Child (measured) | ✅ uniform | ✅ uniform | ✅ uniform | — |
| **Unmeasured power** | ✅ **uniform** | ✅ **uniform** | ✅ **uniform** | `isUnmeasured` (UI only) |
| Virtual grouping | child-sum | child-sum | proportional | `isVirtual` (UI) |

### 5.2 Code deleted

| Location | What is removed | Why it can go |
|----------|----------------|---------------|
| `energy-data-helper.ts` | `enrichUnmeasuredDeviceTreeWithHistory()` (~70 lines) + 2 call sites | Unmeasured power nodes now have real sensor histories |
| `DeviceNode.ts` — `updateLivePower` | `isUnmeasured` power-derivation branch + parent's `unmeasuredPower` calculation + special call + `!this.isUnmeasured` guard in live source-ratio block | Node reads from `hass.states` directly; source ratios computed via standard path |
| `coordinator.py` | `_compute_unmeasured_power()` single-house method | Replaced by `_compute_all_unmeasured_powers()` generic traversal |

### 5.3 Code added / changed

| Location | Change | Complexity |
|----------|--------|-----------|
| `sensor.py` | Dynamic `HelmanUnmeasuredPowerSensor` instances (one per parent node in tree) | Low — mirrors existing single `sensor.helman_unmeasured_house_power` |
| `coordinator.py` | `_compute_all_unmeasured_powers()` + store list of unmeasured sensor entity IDs | Low — recursive traversal, same pattern as existing tree walkers |
| `tree_builder.py` — `_add_unmeasured_nodes()` | Set `power_sensor_id` with slugified node ID: `sensor.helman_{slug}_unmeasured_power` (dots replaced with underscores) | Trivial |
| `coordinator.py` — `async_setup` | Collect unmeasured sensor entity IDs; add to `_power_sensor_ids` for subscriptions and history | Low |

---

## 6 — Implications and Trade-offs

### 6.1 Benefits

1. **Uniform code path.** Every node with a power concept has a sensor. The FE needs zero
   special-case logic for unmeasured power nodes. Adding new nested parents in the future is free —
   the tree builder creates the sensor, the aggregator fetches its history automatically.

2. **Correct historical accuracy.** The current FE derivation
   (`parent_history − children_sum`) can silently produce wrong results whenever child devices
   are added/removed mid-window (the window spans historical time when those devices did not
   exist). A real BE sensor records the actual computed value at each point in time — no
   retro-computation needed.

3. **Simpler FE source ratio for unmeasured power nodes.** Currently ~40 lines of per-bucket subtraction.
   With a real sensor the BE `_compute_source_ratios()` function (already tested, shared with
   all other nodes) handles it in the same $O(S \times B)$ loop with zero new frontend logic.

4. **Completes the parent proposal intent.** The parent proposal introduced
   `sensor.helman_<node>_unmeasured_power` sensors embedded in the `get_device_tree` DTO.
   This implementation activates their full value by wiring them into the history
   aggregator and removing the FE derivation code.

### 6.2 Considerations

1. **Dynamic sensor registration.** HA sensors must be registered at integration-load time
   (or via a `ConfigEntry` reload). If the tree changes (new device added to Energy dashboard),
   a reload may be required for the new unmeasured sensor to appear. This is already the case
   for other tree-derived entities.

2. **Recorder overhead.** Each new unmeasured sensor will emit a `async_write_ha_state()`
   on every debounced computation pass (per Doc 1's 1000 ms debounce). For a single-level
   tree this is one extra entity per parent node. The state is already computed by
   `_compute_all_unmeasured_powers()`, so the marginal cost is a small attribute write.
   History fetch on page load is increased by one entity per parent — negligible.

3. **`isUnmeasured` stays in the DTO.** It is still useful for the FE to know that a node is
   the "remainder" slot (to suppress switches, apply different styling, etc.). It just no longer
   needs to control computation.

4. **Backwards compat / migration.** If an older FE version (before this change) encounters a
   unmeasured power node that now has `powerSensorId` set, it will simply attempt to read
   `hass.states[powerSensorId]` — which now exists — so there is no regression.

---

## 7 — Questions / Open Points

<!-- Fill in answers inline before implementation begins -->

1. **Sensor lifecycle on tree changes:** Should unmeasured sensors be created on first setup
   and persist, or should they be torn down and re-created on every `invalidate_tree()` call?
   The simplest approach is to rebuild on reload, similar to how the tree is rebuilt on config
   changes.

2. **Sensor naming uniqueness:** The `node.id` for child nodes is the `stat_consumption`
   entity ID (e.g., `sensor.shelly_boiler_energy`). A raw concatenation like
   `sensor.helman_sensor.shelly_boiler_energy_unmeasured_power` would contain embedded dots,
   which HA entity platform rejects (entity IDs allow only `[a-z0-9_]` after the domain dot).
   The `node.id` must be slugified before use — e.g., replace dots with underscores:
   `sensor.helman_sensor_shelly_boiler_energy_unmeasured_power`. Alternatively, a shorter
   hash/slug could be used.

3. **Edge case — unmeasured = 0:** When all children sum to the parent, the unmeasured sensor
   reports 0 W. This is fine — HA will record it and the bar will render as empty. No special
   handling needed.

4. **Legacy mode:** In legacy (non-backend) mode the FE builds the tree client-side. The
   `enrichUnmeasuredDeviceTreeWithHistory` derivation is currently also used in legacy mode
   (separate code path). The legacy path is out of scope for this proposal — it can stay as-is
   until legacy mode is deprecated.
