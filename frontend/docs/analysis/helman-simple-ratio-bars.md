# Analysis: Missing Parent Power Context in helman-simple Detail Dialogs

## Problem Statement

In **helman-card**, source and consumer nodes render their history bars and the live
percentage proportionally to a shared total (production total or consumption total).
With 500 W solar and 500 W battery (1 000 W total) each shows **50%** — bar height
and the percentage label on the right.

In **helman-simple-card** detail dialogs the same nodes show **100%** — because neither
`parentPowerHistory` nor `currentParentPower` is wired up to the `<power-device>` elements.

---

## Two Properties That Control the Display

### `parentPowerHistory: number[]` → bar HEIGHT scale

File: [src/helman/power-device.ts:175](../../src/helman/power-device.ts#L175)

```typescript
const maxHistoryPower = this.parentPowerHistory
    ? Math.max(...this.parentPowerHistory)   // shared Y-axis denominator
    : Math.max(...historyToRender);           // ← falls back to own max → always 100% peak
```

### `currentParentPower: number` → live percentage label on the right

File: [src/helman/power-device-power-display.ts:53-59](../../src/helman/power-device-power-display.ts#L53-L59)

```typescript
let parentPower = this.currentParentPower;
if (!parentPower || parentPower === 0) {
    parentPower = currentPower;   // ← no parent → always 100%
}
const currentPercentage = (parentPower > 0) ? (currentPower / parentPower) * 100 : 0;
```

Both default to **self** when missing, so every node independently peaks at 100%.

---

## Where the Data Already Exists: The Backend Payload

`TreePayload` (helman-api.ts) already carries two total-sensor IDs:

```typescript
export interface TreePayload {
    sources: DeviceNodeDTO[];
    consumers: DeviceNodeDTO[];
    consumptionTotalSensorId: string | null;   // ← total consumption entity
    productionTotalSensorId:  string | null;   // ← total production entity
    uiConfig: HelmanUiConfig;
}
```

### How helman-card uses them

File: [src/helman/helman-card.ts:194-222](../../src/helman/helman-card.ts#L194-L222)

```typescript
// Virtual "sources" container — its powerSensorId IS the production total entity
const sourcesNode = new DeviceNode("sources", ..., historyBuckets);
sourcesNode.powerSensorId = productionTotalSensorId;   // ← backend sensor, no computation
sourcesNode.children = sources.map(dto => this._hydrateNode(dto));

// Virtual "consumers" container — its powerSensorId IS the consumption total entity
const consumersNode = new DeviceNode("consumers", ..., historyBuckets);
consumersNode.powerSensorId = consumptionTotalSensorId; // ← backend sensor, no computation
consumersNode.children = consumers.map(dto => this._hydrateNode(dto));
```

Both virtual nodes participate normally in `_applyHistory` and `_advanceBuckets`, so they
get their `powerHistory` (array of historical watt values) and `powerValue` (live watt
reading) populated from `entity_history` and `hass.states` — **no client-side summation**.

Then in the render:

```typescript
// Sources section: every source bar is relative to production total
<power-devices-container
    .currentParentPower=${sourcesNode.powerValue}    // ← live production W
    .parentPowerHistory=${sourcesNode.powerHistory}  // ← production history

// Consumers section: every consumer bar is relative to consumption total
<power-devices-container
    .currentParentPower=${consumerNode.powerValue}
    .parentPowerHistory=${consumerNode.powerHistory}

// House children: relative to house power (a child of consumersNode)
<power-house-devices-section
    .currentParentPower=${houseNode.powerValue}
    .parentPowerHistory=${houseNode.powerHistory}
```

### What helman-simple-card does with them

File: [src/helman-simple/helman-simple-card.ts:341-385](../../src/helman-simple/helman-simple-card.ts#L341-L385)

```typescript
const payload = await ...sendMessagePromise<TreePayload>({ type: "helman/get_device_tree" });
this._uiConfig = payload.uiConfig;
this._entityMap = this._buildEntityMap(payload);  // ← productionTotalSensorId DISCARDED here
```

`_buildEntityMap` only extracts the four individual source/house power sensor IDs.
`consumptionTotalSensorId` and `productionTotalSensorId` are never stored anywhere.
There is no equivalent of `sourcesNode` or `consumersNode` in helman-simple-card.

---

## Dialog-by-Dialog Breakdown

### Solar dialog

```typescript
// _renderSolar
<power-device
    .device=${p.solarNode}
    <!-- ❌ no currentParentPower  → percentage always 100% -->
    <!-- ❌ no parentPowerHistory  → bar always peaks at own max (100%) -->
    <!-- correct parent: production total (productionTotalSensorId) -->
>
```

### Battery dialog

```typescript
<power-device .device=${p.batteryProducerNode}>
    <!-- ❌ missing — correct parent: production total -->

<power-device .device=${p.batteryConsumerNode}>
    <!-- ❌ missing — correct parent: consumption total -->
```

### Grid dialog — same pattern as battery

### House dialog

```typescript
// Top power-device for the house node itself:
<power-device .device=${p.houseNode}>
    <!-- ❌ no currentParentPower / parentPowerHistory -->
    <!-- correct parent: consumption total (house is one of the consumers) -->

// Children section:
<power-house-devices-section
    .currentParentPower=${p.power}              // ✓ live house W
    .parentPowerHistory=${p.parentPowerHistory}  // ✓ houseNode.powerHistory
>
    <!-- ✓ house CHILDREN already receive the correct parent context -->
```

**The house children section already works correctly** — both props flow from
`_buildDialogParams` (lines 496-497) through the dialog to the section.
The broken element is the **top-level house `<power-device>`** which always shows 100%.

Summary:

| Element | `currentParentPower` | `parentPowerHistory` | Status |
|---------|---------------------|---------------------|--------|
| Solar node | ❌ missing | ❌ missing | Broken |
| Battery producer | ❌ missing | ❌ missing | Broken |
| Battery consumer | ❌ missing | ❌ missing | Broken |
| Grid producer | ❌ missing | ❌ missing | Broken |
| Grid consumer | ❌ missing | ❌ missing | Broken |
| House node (top `power-device`) | ❌ missing | ❌ missing | Broken |
| House children (`power-house-devices-section`) | ✓ `p.power` | ✓ `houseNode.powerHistory` | Working |

---

## Recommended Fix

Mirror helman-card's approach exactly: create two virtual DeviceNodes in
helman-simple-card — `_productionNode` and `_consumptionNode` — wired to the backend
sensor IDs, included in the existing history machinery, and passed into the dialog params.
**No client-side computation is needed.**

### Step 1: Create virtual nodes in `_loadFromBackend`

```typescript
// New private fields alongside the existing node fields:
private _productionNode:  DeviceNode | null = null;
private _consumptionNode: DeviceNode | null = null;

// In _loadFromBackend, after receiving payload:
this._productionNode = payload.productionTotalSensorId
    ? new DeviceNode('production-total', '', payload.productionTotalSensorId, null, histBuckets)
    : null;
this._consumptionNode = payload.consumptionTotalSensorId
    ? new DeviceNode('consumption-total', '', payload.consumptionTotalSensorId, null, histBuckets)
    : null;
```

### Step 2: Include in `_applyHistory`

```typescript
const extraNodes = [this._productionNode, this._consumptionNode]
    .filter((n): n is DeviceNode => n !== null);
for (const node of [...this._sourceNodes, ...houseNodes, ...consumerNodes, ...extraNodes]) {
    // existing logic unchanged — entity_history lookup handles the rest
```

### Step 3: Include in `_advanceBuckets`

```typescript
if (this._productionNode)  nodes.push(this._productionNode);
if (this._consumptionNode) nodes.push(this._consumptionNode);
```

`_advanceTree` already reads `hass.states[node.powerSensorId]` to update `powerValue` —
no additional logic required.

### Step 4: Add fields to detail param interfaces (`node-detail-dialog.ts`)

```typescript
// SolarDetailParams
productionNode: DeviceNode | null;

// BatteryDetailParams / GridDetailParams
productionNode:  DeviceNode | null;  // for producer
consumptionNode: DeviceNode | null;  // for consumer

// HouseDetailParams
consumptionNode: DeviceNode | null;  // for top house power-device
```

### Step 5: Populate in `_buildDialogParams` (`helman-simple-card.ts`)

```typescript
case 'solar':   return { ..., productionNode: this._productionNode };
case 'battery': return { ..., productionNode: this._productionNode,
                              consumptionNode: this._consumptionNode };
case 'grid':    return { ..., productionNode: this._productionNode,
                              consumptionNode: this._consumptionNode };
case 'house':   return { ..., consumptionNode: this._consumptionNode };
```

### Step 6: Pass props in dialog render methods (`node-detail-dialog.ts`)

```typescript
// _renderSolar
<power-device
    .device=${p.solarNode}
    .currentParentPower=${p.productionNode?.powerValue}
    .parentPowerHistory=${p.productionNode?.powerHistory}
    ...
>

// _renderBattery
<power-device
    .device=${p.batteryProducerNode}
    .currentParentPower=${p.productionNode?.powerValue}
    .parentPowerHistory=${p.productionNode?.powerHistory}
    ...
>
<power-device
    .device=${p.batteryConsumerNode}
    .currentParentPower=${p.consumptionNode?.powerValue}
    .parentPowerHistory=${p.consumptionNode?.powerHistory}
    ...
>

// _renderGrid — same pattern as _renderBattery

// _renderHouse — fix only the top house node; section unchanged
<power-device
    .device=${p.houseNode}
    .currentParentPower=${p.consumptionNode?.powerValue}
    .parentPowerHistory=${p.consumptionNode?.powerHistory}
    ...
>
// power-house-devices-section: no change needed — already working
```

---

## Why Not Client-Side Computation?

Summing individual source `powerValue` / `powerHistory` arrays in `_buildDialogParams`
would be fragile:

- It diverges from the backend total if the backend uses different aggregation logic
  (e.g. AC-only production, grid-import sign handling)
- Per-bucket array summation is error-prone across nodes with different value types or
  mismatched array lengths
- `productionTotalSensorId` / `consumptionTotalSensorId` already exist in the payload
  precisely for this purpose — helman-card uses them directly, with zero computation

The two virtual DeviceNodes cost only two extra sensor lookups in `_applyHistory` and
`_advanceBuckets`, using the identical mechanism that already handles every other node.
