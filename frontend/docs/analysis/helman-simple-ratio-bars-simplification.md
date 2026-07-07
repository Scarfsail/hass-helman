# Simplification Proposal: Extract Shared History Engine

## Context

The [ratio bars analysis](./helman-simple-ratio-bars.md) identifies a real bug —
`helman-simple-card` detail dialogs show 100% bars because `parentPowerHistory` and
`currentParentPower` are never wired up. However, the proposed 6-step fix duplicates
the virtual-node pattern already present in `helman-card`, violating the DRY principle.

This document proposes a cleaner approach: **extract the shared history logic into a
reusable module** used by both cards, then fix the ratio bars as a natural consequence.

---

## DRY Violations Today

The following methods are **near-identical** between `helman-card.ts` and
`helman-simple-card.ts`:

| Method | helman-card.ts | helman-simple-card.ts | Difference |
|--------|---------------|----------------------|------------|
| `_walkTree` | lines 260-270 | lines 605-614 | Identical |
| `_applyHistory` | lines 227-258 | lines 616-650 | Identical logic, only the node-list assembly differs |
| `_advanceTree` | lines 276-317 | lines 660-700 | Identical logic |
| `_advanceBuckets` | lines 271-274 | lines 652-659 | Same pattern: gather nodes → call `_advanceTree` → `requestUpdate()` |
| History interval setup | lines 161-164 | lines 375-379 | Same `setInterval` + `_advanceBuckets` pattern |
| `_hydrateNode` | lines 170-172 | line 595 | Both delegate to `hydrateNode()` |

That's **~150 lines** of near-identical history management code duplicated across two
card components.

---

## Proposed Solution: `HistoryEngine` class

Extract all shared history logic into a single class in a new file
`src/helman/history-engine.ts`. Both cards instantiate it, register their nodes, and
let it handle the rest.

### Responsibilities

| Concern | Currently in both cards | Moves to `HistoryEngine` |
|---------|------------------------|--------------------------|
| Walk device tree | `_walkTree()` | `walkTree()` |
| Apply backend history | `_applyHistory()` | `applyHistory()` |
| Advance history buckets | `_advanceTree()` / `_advanceBuckets()` | `advanceBuckets()` (calls internal `_advanceTree()`) |
| Read live sensor values | Inside `_advanceTree()` | Inside `_advanceTree()` |
| Compute source ratios | Inside `_applyHistory()` and `_advanceTree()` | Same, inside the engine |
| Interval lifecycle | `setInterval` / `clearInterval` in each card | `start()` / `stop()` |

### API Sketch

```typescript
// src/helman/history-engine.ts

export class HistoryEngine {
    private _interval?: number;

    constructor(
        private _getHass: () => HomeAssistant | undefined,
        private _sourceNodes: () => DeviceNode[],
        private _maxBuckets: number,
        private _bucketDuration: number,
        private _onTick: () => void,       // card calls requestUpdate()
    ) {}

    /** Apply entity_history from the backend payload to a list of nodes. */
    applyHistory(history: HistoryPayload, nodes: DeviceNode[]): void { /* extracted logic */ }

    /** Push one new bucket, update live values, trim to max length. */
    advanceBuckets(nodes: DeviceNode[]): void { /* extracted logic */ }

    /** Start the periodic bucket advance. */
    start(): void {
        this.stop();
        this._interval = window.setInterval(() => {
            // Card provides the node list each tick via a callback or direct call
            this._onTick();
        }, this._bucketDuration * 1000);
    }

    /** Stop the periodic timer. */
    stop(): void {
        clearInterval(this._interval);
    }

    /** Flatten a node tree. */
    static walkTree(nodes: DeviceNode[]): DeviceNode[] { /* extracted logic */ }
}
```

### Usage in `helman-card.ts` (simplified)

```typescript
private _historyEngine!: HistoryEngine;

async _loadBackendData() {
    // ... hydrate nodes as today ...
    this._historyEngine = new HistoryEngine(
        () => this._hass,
        () => this._sourceNodes,
        uiConfig.history_buckets,
        uiConfig.history_bucket_duration,
        () => { this._advanceBuckets(); },  // or inline
    );
    this._historyEngine.applyHistory(history, HistoryEngine.walkTree(this._deviceTree));
    this._historyEngine.start();
}

disconnectedCallback() {
    super.disconnectedCallback();
    this._historyEngine?.stop();
}

private _advanceBuckets() {
    this._historyEngine.advanceBuckets(HistoryEngine.walkTree(this._deviceTree));
    this.requestUpdate();
}
```

### Usage in `helman-simple-card.ts` (simplified)

```typescript
private _historyEngine!: HistoryEngine;
private _productionNode:  DeviceNode | null = null;   // ← new virtual node
private _consumptionNode: DeviceNode | null = null;   // ← new virtual node

async _loadFromBackend() {
    // ... hydrate individual nodes as today ...

    // Create virtual total nodes (same pattern as helman-card)
    this._productionNode = productionTotalSensorId
        ? new DeviceNode('production-total', '', productionTotalSensorId, null, histBuckets)
        : null;
    this._consumptionNode = consumptionTotalSensorId
        ? new DeviceNode('consumption-total', '', consumptionTotalSensorId, null, histBuckets)
        : null;

    this._historyEngine = new HistoryEngine(
        () => this._hass,
        () => this._sourceNodes,
        uiConfig.history_buckets,
        uiConfig.history_bucket_duration,
        () => { this._advanceBuckets(); },
    );
    this._historyEngine.applyHistory(history, this._allTrackedNodes());
    this._historyEngine.start();
}

private _allTrackedNodes(): DeviceNode[] {
    const nodes = [...this._sourceNodes];
    if (this._houseNode) nodes.push(...HistoryEngine.walkTree([this._houseNode]));
    if (this._batteryConsumerNode) nodes.push(this._batteryConsumerNode);
    if (this._gridConsumerNode) nodes.push(this._gridConsumerNode);
    if (this._productionNode) nodes.push(this._productionNode);
    if (this._consumptionNode) nodes.push(this._consumptionNode);
    return nodes;
}
```

Virtual nodes get their `powerHistory` and `powerValue` populated automatically — for
free — because the engine already handles any node with a `powerSensorId`.

---

## How This Fixes the Ratio Bars

Once the two virtual nodes exist and are tracked by the engine, passing parent context
to dialogs is just a matter of reading their properties. The dialog param interfaces
need only two extra optional fields:

```typescript
// Extend existing interfaces
export interface SolarDetailParams {
    // ... existing fields ...
    productionNode?: DeviceNode | null;
}

export interface BatteryDetailParams {
    // ... existing fields ...
    productionNode?: DeviceNode | null;
    consumptionNode?: DeviceNode | null;
}

export interface GridDetailParams {
    // ... existing fields ...
    productionNode?: DeviceNode | null;
    consumptionNode?: DeviceNode | null;
}

export interface HouseDetailParams {
    // ... existing fields ...
    consumptionNode?: DeviceNode | null;
}
```

Then in dialog render methods, add `currentParentPower` and `parentPowerHistory` to
each `<power-device>`:

```html
<!-- Solar -->
<power-device
    .device=${p.solarNode}
    .currentParentPower=${p.productionNode?.powerValue}
    .parentPowerHistory=${p.productionNode?.powerHistory}
    ...
>

<!-- Battery producer → production total; consumer → consumption total -->
<!-- Grid: same pattern -->
<!-- House top node → consumption total -->
```

No client-side summation, no new computation — identical to how `helman-card` already
works, except using the shared engine avoids duplicating the machinery.

---

## Summary of Changes

| File | Action |
|------|--------|
| `src/helman/history-engine.ts` | **New** — extracted shared logic (~80 lines) |
| `src/helman/helman-card.ts` | **Refactor** — replace `_walkTree`, `_applyHistory`, `_advanceTree`, `_advanceBuckets`, interval setup with `HistoryEngine` usage |
| `src/helman-simple/helman-simple-card.ts` | **Refactor** — same replacement; add `_productionNode` + `_consumptionNode`; wire into `_buildDialogParams` |
| `src/helman-simple/node-detail-dialog.ts` | **Extend** — add optional parent node fields to param interfaces; pass to `<power-device>` |

**Net code delta**: The ~150 lines duplicated today become ~80 lines in the shared
engine. Each card keeps ~15 lines of integration code. The ratio bars fix adds ~10 lines
total (param fields + template attributes).

---

## Why This Approach Over the Original Proposal

| Aspect | Original 6-step fix | This proposal |
|--------|---------------------|---------------|
| DRY | Adds more duplication (virtual node creation, history wiring, advance logic all mirrored) | Eliminates existing duplication |
| Maintenance | Two places to update if history logic changes | One place |
| Bug surface | Easy to forget to sync changes between cards | Shared engine is tested once |
| Scope | Fixes the symptom only | Fixes the symptom AND the structural problem |
| Complexity | Low per-step but high total (6 steps across 2 files) | One refactor + a small fix |
