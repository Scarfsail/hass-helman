# Helman Card Performance Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the High and Medium per-render CPU/GC hot paths identified in `PERFORMANCE_FINDINGS.md` so the cards do not redo per-bucket math, color blending, SVG arithmetic, or full-tree re-renders on every Home Assistant state tick.

**Architecture:** The cards build a `DeviceNode` tree once at load and mutate it in-place from `HistoryEngine`. Most expensive work today happens inside `render()`. The fix pattern across all tasks is the same: move derived data into `willUpdate()` (recompute only when the *real* inputs change), cache the result on a private field or `@state`, and let `render()` be a thin template binding. For the `set hass` case we project the raw `HomeAssistant` object into a small derived `@state` slice instead of triggering a full re-render on every tick. For `HistoryEngine` we coalesce the timer-driven render into a single `requestAnimationFrame`.

**Tech Stack:** Lit 3 (`lit-element`, `@property`, `@state`, `willUpdate`), TypeScript strict, Vite. The project has no test runner — verification is `npm run build-dev` (TypeScript check + bundle) plus a manual smoke test in a Home Assistant tab using the dev bundle.

**Verification approach (no unit tests in repo):** Each task ends with `npm run build-dev` (must succeed with no new TS errors) and, where behavior could regress, a short manual smoke step describing what to look at in the HA UI. Use `git diff` between commits as the primary review signal.

**Scope:** All High and Medium findings from `PERFORMANCE_FINDINGS.md` (#1–#8). Low/design findings (#9, #10) are out of scope. Tasks are ordered by impact / cost ratio so each commit individually moves the needle.

---

## File Structure

| File | Role | Touched in tasks |
|------|------|------------------|
| `src/helman/history-engine.ts` | bucket-advance timer + tree mutation; will gain RAF coalesce | 1 |
| `src/helman/helman-card.ts` | full card root; `set hass` setter; passes hass into children | 2 |
| `src/helman-simple/helman-simple-card.ts` | simple card root; `set hass`; flow color computation in render | 2, 6 |
| `src/helman/power-house-devices-section.ts` | virtual group node aggregation; currently in render() | 3 |
| `src/helman/power-device-history-bars.ts` | per-bucket % math; currently in render() | 4 |
| `src/color-utils.ts` | color blend + dominant source color helpers | 5 (memo wrapper added) |
| `src/helman/DeviceNode.ts` | data class; will hold a cached `cachedSourceColor` slot | 5 |
| `src/helman/power-flow-arrows.ts` | static 10-strip animation array | 7 |
| `src/helman-simple/simple-card-battery.ts` | per-render SVG arithmetic | 8 |
| `src/helman-simple/simple-card-house.ts` | per-render SVG arithmetic (parallel to battery) | 8 |

No new files are created. All changes are in-place edits.

---

## Task 1 — RAF-coalesce HistoryEngine `_onTick` (Finding #3, High)

**Why first:** smallest diff, highest leverage. `_onTick` calls `requestUpdate()` synchronously from a `setInterval` callback; coalescing it into a `requestAnimationFrame` removes a guaranteed render burst every `bucketDuration` seconds and protects against any future caller that invokes `advanceBuckets()` manually back-to-back.

**Files:**
- Modify: `src/helman/history-engine.ts`

- [ ] **Step 1: Read current implementation**

Read `src/helman/history-engine.ts` end-to-end. Confirm `advanceBuckets()` is the only place that calls `_onTick()` and that `_onTick` is the constructor-injected callback that triggers `requestUpdate()` on the host card.

- [ ] **Step 2: Add a RAF-coalescing wrapper around `_onTick`**

Replace the existing `advanceBuckets()` and `stop()` methods, and add a `_rafHandle` field. The wrapper guarantees at most one `_onTick()` call per animation frame, even if `advanceBuckets` is called multiple times synchronously.

```typescript
export class HistoryEngine {
    private _interval?: number;
    private _rafHandle?: number;

    constructor(
        private _getHass: () => HomeAssistant | undefined,
        private _maxBuckets: number,
        private _onTick: () => void,
    ) {}

    // … walkTree, applyHistory unchanged …

    /** Push one live bucket per node and notify the card to re-render (coalesced to next animation frame). */
    advanceBuckets(nodes: DeviceNode[], sourceNodes: DeviceNode[]): void {
        if (!this._getHass()) return;
        this._advanceTree(nodes, sourceNodes);
        this._scheduleTick();
    }

    /** Start the periodic bucket advance. Stops any existing timer first. */
    start(bucketDuration: number, getNodes: () => DeviceNode[], getSourceNodes: () => DeviceNode[]): void {
        this.stop();
        this._interval = window.setInterval(() => {
            this.advanceBuckets(getNodes(), getSourceNodes());
        }, bucketDuration * 1000);
    }

    /** Stop the periodic timer and cancel any pending render frame. */
    stop(): void {
        if (this._interval !== undefined) {
            clearInterval(this._interval);
            this._interval = undefined;
        }
        if (this._rafHandle !== undefined) {
            cancelAnimationFrame(this._rafHandle);
            this._rafHandle = undefined;
        }
    }

    private _scheduleTick(): void {
        if (this._rafHandle !== undefined) return;
        this._rafHandle = requestAnimationFrame(() => {
            this._rafHandle = undefined;
            this._onTick();
        });
    }

    // _advanceTree unchanged …
}
```

- [ ] **Step 3: Build**

Run: `npm run build-dev`
Expected: Build completes with no new TypeScript errors. The bundle is written to `dist/helman-card-dev.js`.

- [ ] **Step 4: Manual smoke**

Load the dev bundle in HA. Confirm the helman-card and helman-simple-card still render and that history bars / flow widths animate as before. There should be no visible regression — the change is invisible in normal use because the 60-second cadence of `setInterval` is unchanged; this is purely about absorbing back-pressure.

- [ ] **Step 5: Commit**

```bash
git add src/helman/history-engine.ts
git commit -m "perf(history-engine): coalesce onTick into requestAnimationFrame"
```

---

## Task 2 — Filter `set hass` so unrelated state changes don't re-render (Finding #1, High)

**Why:** HA pushes a new `HomeAssistant` object on every state change anywhere in the home. Today both `helman-card` and `helman-simple-card` blindly assign `this._hass = hass`, which is a `@state()` field, so Lit re-renders the whole tree. We replace this with a comparator: only update `_hass` when one of the entity ids the card actually reads has changed state. The set of relevant ids is built from the hydrated device tree (power sensors + ratio sensors + battery soc/minSoc + grid/solar/battery sensors) plus the static UI signals we read (theme/locale via `_localize`).

This task ships the optimization in two steps: first the full card, then the simple card. Each gets its own commit so that a regression can be bisected to one card.

**Files:**
- Modify: `src/helman/helman-card.ts`
- Modify: `src/helman-simple/helman-simple-card.ts`

### Task 2a — `helman-card`

- [ ] **Step 1: Read context**

Open `src/helman/helman-card.ts`. Locate the `set hass` setter (lines 66-69), the `_hass` `@state` declaration (line 52), and the place where the device tree is hydrated (`_loadBackendData` / `_hydrateDeviceNodes`). Note that `_sourceNodes` already exists as a private field — the same idea will apply for collecting "watched entity ids".

- [ ] **Step 2: Add a watched-entity-id set populated when the tree is hydrated**

Add a private field and populate it at the end of the existing tree-hydration path. Do not search for entity ids inside the setter — that would defeat the optimization. The set is rebuilt only when the device tree is rebuilt.

```typescript
// near the other private fields
private _watchedEntityIds: Set<string> = new Set();

// after _deviceTree is assigned in _loadBackendData / wherever hydration completes,
// add a single helper call:
private _rebuildWatchedEntityIds(): void {
    const ids = new Set<string>();
    const visit = (nodes: DeviceNode[]) => {
        for (const n of nodes) {
            if (n.powerSensorId) ids.add(n.powerSensorId);
            if (n.ratioSensorId) ids.add(n.ratioSensorId);
            for (const c of n.children) visit([c]);
        }
    };
    visit(this._deviceTree);
    this._watchedEntityIds = ids;
}
```

Call `this._rebuildWatchedEntityIds()` immediately after `this._deviceTree = …` is assigned in the hydration path. (Search for `this._deviceTree =` to find the assignment.)

- [ ] **Step 3: Replace the unconditional `set hass`**

Replace the existing setter with one that only assigns `_hass` when a watched entity changed. We also keep the very first assignment (so the card boots) and we always store the *latest* hass on a non-reactive field so `_loadBackendData()` still has access to the freshest object.

```typescript
// non-reactive shadow of the latest hass — used by methods that need the freshest object
private _latestHass?: HomeAssistant;

public set hass(hass: HomeAssistant) {
    const previous = this._latestHass;
    this._latestHass = hass;
    if (!this._localize) this._localize = getLocalizeFunction(hass);

    if (!previous) {
        this._hass = hass;
        return;
    }
    if (this._watchedEntityIds.size === 0) {
        // Tree not yet hydrated — keep the simple behavior so initial load still works.
        this._hass = hass;
        return;
    }
    for (const id of this._watchedEntityIds) {
        if (previous.states[id] !== hass.states[id]) {
            this._hass = hass;
            return;
        }
    }
    // No watched entity changed — skip the re-render entirely.
}
```

Notes:
- HA frontend reuses `HassEntity` object identity until the entity actually changes, so reference equality on `previous.states[id]` vs `hass.states[id]` is the correct comparison and is O(1).
- We deliberately leave `_loadBackendData()` unchanged: anywhere it reads `this._hass`, behavior is identical because `_hass` is still the most recent *relevant* hass. If any code path needs the absolute latest hass (e.g. the `_loadBackendData` initial WS call), use `this._latestHass`.

- [ ] **Step 4: Audit usages of `this._hass`**

Run: `grep -n "this\._hass" src/helman/helman-card.ts`
Expected: every usage either (a) is fine reading the slightly-stale `_hass` because it only needs entity values the card watches, or (b) is in `_loadBackendData()` / WS subscription code that should switch to `this._latestHass`. Update those call sites to read `this._latestHass`.

- [ ] **Step 5: Build**

Run: `npm run build-dev`
Expected: no new TS errors.

- [ ] **Step 6: Manual smoke**

Load in HA. Toggle a watched entity (e.g. flip a switch that shows in the device tree) — card should react. Toggle an unrelated entity (e.g. a light somewhere else) — card should NOT re-render. Verify with browser devtools (Performance tab or `console.count` temporarily added inside `render()` if needed) that render frequency drops sharply when the home is producing many unrelated state events.

- [ ] **Step 7: Commit**

```bash
git add src/helman/helman-card.ts
git commit -m "perf(helman-card): skip rerender when no watched entity changed"
```

### Task 2b — `helman-simple-card`

- [ ] **Step 1: Locate the equivalent setter and watched ids**

Open `src/helman-simple/helman-simple-card.ts`. Find `set hass` (look for `public set hass`), the `_hass` `@state` field, and `_buildEntityMap` / `_readEnergyValues` (around line 360-380). The simple card already has an `_entityMap` — that gives us the watched ids "for free".

- [ ] **Step 2: Apply the same comparator pattern, sourcing ids from `_entityMap`**

Add a `_latestHass` field and a derived `_watchedEntityIds: Set<string>` that is rebuilt at the end of `_loadFromBackend()` (right after `_entityMap` is assigned). Walk `_entityMap` once and collect every string-typed entity id value.

```typescript
private _latestHass?: HomeAssistant;
private _watchedEntityIds: Set<string> = new Set();

private _rebuildWatchedEntityIds(): void {
    const ids = new Set<string>();
    if (this._entityMap) {
        for (const v of Object.values(this._entityMap)) {
            if (typeof v === 'string' && v.length > 0) ids.add(v);
        }
    }
    // Also include power/ratio sensors of any hydrated source/consumer nodes.
    const addNode = (n: DeviceNode | null | undefined) => {
        if (!n) return;
        if (n.powerSensorId) ids.add(n.powerSensorId);
        if (n.ratioSensorId) ids.add(n.ratioSensorId);
        for (const c of n.children) addNode(c);
    };
    addNode(this._solarNode);
    addNode(this._gridProducerNode);
    addNode(this._batteryProducerNode);
    addNode(this._batteryConsumerNode);
    addNode(this._gridConsumerNode);
    addNode(this._houseNode);
    this._watchedEntityIds = ids;
}
```

Call `this._rebuildWatchedEntityIds()` at the end of the successful path of `_loadFromBackend()`.

- [ ] **Step 3: Replace `set hass`**

Replace the existing setter using exactly the same shape as Task 2a Step 3 (substitute `helman-simple-card`'s field names if different). Re-read `_energy` from `_readEnergyValues(this._latestHass, this._entityMap)` only when `_hass` is actually advanced — otherwise old values are fine because by definition no watched entity changed.

```typescript
public set hass(hass: HomeAssistant) {
    const previous = this._latestHass;
    this._latestHass = hass;
    if (!this._localize) this._localize = getLocalizeFunction(hass);

    if (!previous || this._watchedEntityIds.size === 0) {
        this._hass = hass;
        if (this._entityMap) this._energy = this._readEnergyValues(hass, this._entityMap);
        return;
    }
    for (const id of this._watchedEntityIds) {
        if (previous.states[id] !== hass.states[id]) {
            this._hass = hass;
            if (this._entityMap) this._energy = this._readEnergyValues(hass, this._entityMap);
            return;
        }
    }
}
```

- [ ] **Step 4: Audit `this._hass` usages in this file**

Run: `grep -n "this\._hass" src/helman-simple/helman-simple-card.ts`
Expected: switch any "freshness-critical" reads (subscribeMessage, sendMessagePromise) to `this._latestHass`. The `render()` body and energy reads stay on `_hass`.

- [ ] **Step 5: Build + smoke + commit**

Run: `npm run build-dev`. Smoke: same as Task 2a — change a watched entity (battery SoC, solar power) and verify update; toggle unrelated entity and verify no render.

```bash
git add src/helman-simple/helman-simple-card.ts
git commit -m "perf(helman-simple-card): skip rerender when no watched entity changed"
```

---

## Task 3 — Move `_groupByCategory` aggregation out of `render()` (Finding #2, High)

**Why:** When a category chip is active, every render rebuilds the virtual group nodes (new `DeviceNode` instances + new `powerHistory` and `sourcePowerHistory` arrays). The result reference changes every render even when nothing meaningful changed, so `power-devices-container` reconciles every child. Moving the work into `willUpdate()` keyed on the real inputs gives stable references and removes the work from the hot path entirely.

**Files:**
- Modify: `src/helman/power-house-devices-section.ts`

- [ ] **Step 1: Read current code**

Read `src/helman/power-house-devices-section.ts`. The function in question is `_groupByCategory` (lines 93-178), called from `render()` at line 184. Note that `willUpdate` already exists (lines 28-32) and is currently only initializing `_localize`.

- [ ] **Step 2: Add cached state for the grouped result**

Add a `@state` slot for the grouped output and an input-fingerprint for cheap invalidation. The fingerprint is the active category, the device list reference, and the relevant `uiConfig` fields.

```typescript
@state() private _groupedDevices?: DeviceNode[];
private _groupedKey?: string;
```

- [ ] **Step 3: Compute the grouping in `willUpdate`**

Replace the body of `willUpdate` so it (a) keeps the existing `_localize` initialization, and (b) recomputes `_groupedDevices` only when one of its inputs changed. Use a string key built from references — we are not deep-comparing the device array, just checking whether its identity changed.

```typescript
willUpdate(changedProperties: Map<string, unknown>): void {
    if (!this._localize && changedProperties.has('hass') && this.hass) {
        this._localize = getLocalizeFunction(this.hass);
    }

    const cat = this._activeCategory;
    if (!cat) {
        // No grouping active — clear cache so a future activation rebuilds from scratch.
        if (this._groupedDevices !== undefined) {
            this._groupedDevices = undefined;
            this._groupedKey = undefined;
        }
        return;
    }

    const devices = this.devices || [];
    const ui = this.uiConfig;
    const key = `${cat}|${devices.length}|${ui?.show_others_group ?? true}|${ui?.show_empty_groups ?? false}|${ui?.others_group_label ?? ''}`;

    const inputsChanged =
        changedProperties.has('devices') ||
        changedProperties.has('_activeCategory') ||
        changedProperties.has('uiConfig') ||
        this._groupedKey !== key;

    if (!inputsChanged) return;

    this._groupedDevices = this._groupByCategory(devices, cat);
    this._groupedKey = key;
}
```

Note: this still recomputes when `this.devices` reference changes (it will every backend reload, which is fine — that is rare). It does *not* recompute when only live powerValue numbers tick, which is exactly the optimization we want.

- [ ] **Step 4: Use the cached result in `render()`**

Replace line 184 (`const devicesToShow = activeCat ? this._groupByCategory(filtered, activeCat) : filtered;`) with:

```typescript
const devicesToShow = activeCat ? (this._groupedDevices ?? filtered) : filtered;
```

- [ ] **Step 5: Trade-off note (acknowledge in the commit message, not in code)**

Live `powerValue` and `powerHistory` aggregation is now *not* refreshed on every hass tick — only when category, device list, or relevant uiConfig change. This is the intended trade-off: the underlying child `power-device` instances still render their own live numbers, and the virtual group node's `powerValue` is only used for the group's own header display, which is acceptable to update at the existing 60-second history-bucket cadence (when the parent re-pushes). If the group header must show truly-live aggregated power, that is out of scope and should be implemented as a small dedicated `@state` `_groupHeaderPowers: Record<string, number>` updated cheaply per tick — not by rebuilding nodes. Note this in the commit body.

- [ ] **Step 6: Build**

Run: `npm run build-dev`
Expected: no new TS errors.

- [ ] **Step 7: Manual smoke**

Load card. Click a category chip — devices should regroup. Click another category — should regroup. Click the same chip again to deactivate — flat list returns. Watch a few seconds with active category — should not visibly flicker on every HA tick.

- [ ] **Step 8: Commit**

```bash
git add src/helman/power-house-devices-section.ts
git commit -m "perf(power-house-devices-section): cache grouped nodes in willUpdate"
```

---

## Task 4 — Memoize history-bar percentage math (Finding #4, High)

**Why:** `power-device-history-bars.ts` recomputes `(p / maxHistoryPower) * 100` for every bucket and `Object.values(sourceHistory)` per bucket on every render, repeated across every device on the page. Move into `willUpdate()` and store a precomputed render plan.

**Files:**
- Modify: `src/helman/power-device-history-bars.ts`

- [ ] **Step 1: Define the precomputed shape and add a state field**

Add private types and a `@state` slot at the top of the class:

```typescript
type BarSegment = { heightPct: number; color: string };
type Bar = { heightPct: number; segments: BarSegment[] };

// inside the class
@state() private _bars: Bar[] = [];
```

- [ ] **Step 2: Compute `_bars` in `willUpdate`**

Add a `willUpdate` that recomputes `_bars` only when one of `historyToRender`, `maxHistoryPower`, `device`, or `historyBarColor` changed. The full recomputation cost is paid once per real change, instead of every render.

```typescript
willUpdate(changedProperties: Map<string, unknown>): void {
    if (!changedProperties.has('historyToRender')
        && !changedProperties.has('maxHistoryPower')
        && !changedProperties.has('device')
        && !changedProperties.has('historyBarColor')) {
        return;
    }

    const hist = this.historyToRender ?? [];
    const max = this.maxHistoryPower;
    const sourcePerBucket = this.device.sourcePowerHistory;
    const isSource = this.device.isSource;
    const fallbackColor = this.historyBarColor;

    const bars: Bar[] = new Array(hist.length);
    for (let i = 0; i < hist.length; i++) {
        const p = hist[i];
        const heightPct = max > 0 ? Math.min(100, (p / max) * 100) : 0;
        const sourceHistory = !isSource ? sourcePerBucket?.[i] : undefined;
        const segments: BarSegment[] = [];
        if (sourceHistory) {
            for (const s of Object.values(sourceHistory)) {
                if (p > 0) {
                    segments.push({ heightPct: (s.power / p) * 100, color: s.color });
                }
            }
        }
        if (segments.length === 0) {
            segments.push({ heightPct: 100, color: fallbackColor });
        }
        bars[i] = { heightPct, segments };
    }
    this._bars = bars;
}
```

- [ ] **Step 3: Simplify `render()`**

Replace the current `render()` body with a thin map over `_bars`:

```typescript
render(): TemplateResult {
    return html`
        <div class="historyContainer">
            ${this._bars.map(bar => html`
                <div class="historyBarContainer" style="height: ${bar.heightPct}%;">
                    ${bar.segments.map(s => html`
                        <div class="historyBarSegment"
                             style="height: ${s.heightPct}%; background-color: ${s.color};"></div>
                    `)}
                </div>
            `)}
        </div>
    `;
}
```

- [ ] **Step 4: Build + smoke**

Run: `npm run build-dev`. Open the full card; confirm history bars look identical to before — same heights, same per-source colored segments, same fallback color when no sources are present.

- [ ] **Step 5: Commit**

```bash
git add src/helman/power-device-history-bars.ts
git commit -m "perf(power-device-history-bars): precompute bar plan in willUpdate"
```

---

## Task 5 — Cache `computeSourceColor` / `computeDominantSourceColor` per node (Finding #6, Medium)

**Why:** Both functions parse hex strings and walk `Object.values(lastBucket)` on every call. They're called from multiple components per render. The result only changes when the *last bucket* of `sourcePowerHistory` is replaced — which happens at most once per `bucketDuration` (60 s). Cache on the `DeviceNode` itself, keyed by the bucket reference.

**Files:**
- Modify: `src/helman/DeviceNode.ts`
- Modify: `src/color-utils.ts`

- [ ] **Step 1: Read DeviceNode and color-utils**

Open `src/helman/DeviceNode.ts` and `src/color-utils.ts`. Note the exact signatures of `computeDominantSourceColor` and `computeSourceColor`: they both accept a structural object `{ sourcePowerHistory?: ... }`. We can keep the same callable signature but make the *cache* live on the DeviceNode.

- [ ] **Step 2: Add cache slots on `DeviceNode`**

In `DeviceNode.ts`, add four optional fields (two values + two cache keys = the bucket reference last computed against). Place them with the other instance fields.

```typescript
// derived-color caches; invalidated by reference comparison against the latest bucket
public _cachedDominantBucketRef?: object;
public _cachedDominantColor?: string;
public _cachedBlendedBucketRef?: object;
public _cachedBlendedColor?: string;
```

The leading underscore signals "internal cache, do not write directly". TypeScript will accept these as public — no need for accessors.

- [ ] **Step 3: Add memoized variants of the two helpers**

In `src/color-utils.ts`, add two new exports that take a `DeviceNode`-shaped object with cache slots and update them in place. Keep the original pure helpers exported (other call sites may still want the pure form).

```typescript
type CachingNode = {
    sourcePowerHistory?: { [sourceId: string]: { power: number; color: string } }[];
    _cachedDominantBucketRef?: object;
    _cachedDominantColor?: string;
    _cachedBlendedBucketRef?: object;
    _cachedBlendedColor?: string;
};

export function computeDominantSourceColorCached(node: CachingNode): string | undefined {
    const hist = node.sourcePowerHistory;
    if (!hist?.length) return undefined;
    const lastBucket = hist[hist.length - 1];
    if (node._cachedDominantBucketRef === lastBucket) return node._cachedDominantColor;
    const color = computeDominantSourceColor(node);
    node._cachedDominantBucketRef = lastBucket;
    node._cachedDominantColor = color;
    return color;
}

export function computeSourceColorCached(node: CachingNode): string | undefined {
    const hist = node.sourcePowerHistory;
    if (!hist?.length) return undefined;
    const lastBucket = hist[hist.length - 1];
    if (node._cachedBlendedBucketRef === lastBucket) return node._cachedBlendedColor;
    const color = computeSourceColor(node);
    node._cachedBlendedBucketRef = lastBucket;
    node._cachedBlendedColor = color;
    return color;
}
```

The cache key is the bucket *object reference*. `HistoryEngine._advanceTree` writes a *new* bucket object into the last slot every tick (line 112: `node.sourcePowerHistory[node.sourcePowerHistory.length - 1] = bucket;`), which is exactly when we want to recompute. When the bucket object identity is unchanged (every render between ticks), we hit the cache.

- [ ] **Step 4: Switch call sites to the cached variants**

Run: `grep -rn "computeDominantSourceColor\|computeSourceColor" src/`
For every call site that operates on a real `DeviceNode` (not an ad-hoc object literal), switch to the `*Cached` variant. Expected hits: `helman-simple-card.ts` (lines 283-284 plus a few in `simple-card-house.ts` / consumers if present), and any call in `helman-card.ts` chain.

Example replacement in `helman-simple-card.ts`:

```typescript
const gridSourceColor  = this._gridConsumerNode    ? computeDominantSourceColorCached(this._gridConsumerNode)    : undefined;
const houseSourceColor = this._houseNode           ? computeDominantSourceColorCached(this._houseNode)           : undefined;
```

Update the import at the top of each touched file accordingly:

```typescript
import { computeDominantSourceColorCached } from "../color-utils";
```

- [ ] **Step 5: Build + smoke**

Run: `npm run build-dev`. Smoke: dominant source colors on the simple card grid (battery / grid / house) should still update correctly after each 60-second history bucket advance (the moment when a new last-bucket object is assigned).

- [ ] **Step 6: Commit**

```bash
git add src/color-utils.ts src/helman/DeviceNode.ts src/helman-simple/helman-simple-card.ts
# plus any other files that switched to the cached variants
git commit -m "perf(color-utils): memoize source-color computation per DeviceNode bucket"
```

---

## Task 6 — Pull simple-card flow color/glow + format derivations into `willUpdate` (Finding #5, Medium)

**Why:** `helman-simple-card.render()` calls `getFlowColor` 6+ times, `getFlowGlow` several times, plus `computeDominantSourceColorCached` for two nodes (after Task 5). After Task 2b the render runs only when a watched entity changed, but the per-render arithmetic is still wasted: `getFlowColor("solar")` returns the same value forever (it depends only on the user's color theme), and the glow is a pure function of color. Hoist the constants.

**Files:**
- Modify: `src/helman-simple/helman-simple-card.ts`

- [ ] **Step 1: Find every `getFlowColor` / `getFlowGlow` call**

Run: `grep -n "getFlowColor\|getFlowGlow\|computeDominantSourceColor" src/helman-simple/helman-simple-card.ts`

Expect calls inside `render()` (around lines 274-284) and inside `_renderFlowOverlay`, `_flowH`, `_flowV` (around lines 518-586).

- [ ] **Step 2: Add cached fields**

Add private fields for the three flow colors and their precomputed glows. Glow depends on color, color depends on theme/config and is otherwise static.

```typescript
private _flowColors?: { solar: string; grid: string; battery: string };
private _flowGlows?:  { solar: string; grid: string; battery: string };
```

- [ ] **Step 3: Initialize the cache once and refresh on relevant changes**

In `willUpdate`, populate `_flowColors` and `_flowGlows` if undefined (initial mount) or if any input that `getFlowColor` depends on changed. The simplest sufficient trigger is "uiConfig changed" — `getFlowColor` reads from theme/config. Look at the function body (`grep -n "getFlowColor" src/helman-simple/flow-colors.ts` then read the file) to confirm. If it depends only on global CSS variables, initializing once at first willUpdate is enough.

```typescript
willUpdate(changedProperties: Map<string, unknown>): void {
    super.willUpdate?.(changedProperties);
    // … existing logic …
    if (!this._flowColors || changedProperties.has('_uiConfig') || changedProperties.has('_config')) {
        const solar   = getFlowColor("solar");
        const grid    = getFlowColor("grid");
        const battery = getFlowColor("battery");
        this._flowColors = { solar, grid, battery };
        this._flowGlows  = {
            solar:   getFlowGlow(solar),
            grid:    getFlowGlow(grid),
            battery: getFlowGlow(battery),
        };
    }
}
```

(Match the existing willUpdate pattern in this file. If a `willUpdate` already exists, extend it rather than redefining.)

- [ ] **Step 4: Replace direct calls in `render`, `_renderFlowOverlay`, `_flowH`, `_flowV`**

Replace each `getFlowColor("solar")` with `this._flowColors!.solar` (and analogous for grid/battery), and each `getFlowGlow(<color>)` site with the matching `this._flowGlows!.solar|grid|battery`. Inside `_flowH` / `_flowV`, the color is a parameter — derive the glow at call sites that already know which flow they're rendering, or pass both color and glow into the helper.

The cleanest refactor is to change `_flowH` / `_flowV` to accept `(color: string, glow: string, …)`:

```typescript
private _flowH(color: string, glow: string, /* existing other params */) { /* use glow instead of getFlowGlow(color) */ }
private _flowV(color: string, glow: string, /* existing other params */) { /* same */ }
```

Update each call site in `render()` to pass the matching cached glow alongside the color.

- [ ] **Step 5: Build + smoke**

Run: `npm run build-dev`. Smoke: simple card flows still animate with the right colors and the same glow. No visible difference is the success criterion.

- [ ] **Step 6: Commit**

```bash
git add src/helman-simple/helman-simple-card.ts
git commit -m "perf(helman-simple-card): hoist flow color/glow into willUpdate cache"
```

---

## Task 7 — Make `power-flow-arrows` strips a static template (Finding #7, Medium)

**Why:** `Array.from({ length: 10 }).map(...)` runs inside `render().map(devices)`. The 10 strips are static decorative DOM. Lifting them to a module-level `html` template makes Lit reuse the same fragment.

**Files:**
- Modify: `src/helman/power-flow-arrows.ts`

- [ ] **Step 1: Add a module-level constant**

At the top of the file (below imports, above the class), add:

```typescript
const STRIPS = html`
    ${[0,1,2,3,4,5,6,7,8,9].map(i => html`<div class="strip" style="--index: ${i}"></div>`)}
`;
```

- [ ] **Step 2: Use it in render**

Replace line 81 (`${Array.from({ length: 10 }).map((_, i) => html`<div class="strip" style="--index: ${i}"></div>`)}`) with `${STRIPS}`.

- [ ] **Step 3: Build + smoke**

Run: `npm run build-dev`. Smoke: arrows still animate with all ten strips.

- [ ] **Step 4: Commit**

```bash
git add src/helman/power-flow-arrows.ts
git commit -m "perf(power-flow-arrows): hoist static strip template out of render"
```

---

## Task 8 — Move `simple-card-battery` and `simple-card-house` SVG arithmetic to `willUpdate` (Finding #8, Medium)

**Why:** ~15 derived values per render in `simple-card-battery.ts` (clamps, `withAlpha`, `formatPower`, inner padding math), plus an analogous block in `simple-card-house.ts`. Compute once per real prop change.

This task is split per-component so each commit is small.

**Files:**
- Modify: `src/helman-simple/simple-card-battery.ts`
- Modify: `src/helman-simple/simple-card-house.ts`

### Task 8a — `simple-card-battery`

- [ ] **Step 1: Define a state-shaped derived view**

Add a private type and a single `@state` slot at the top of the class (after the `@property` declarations):

```typescript
type BatteryView = {
    coverClass: string;
    fillClass: string;
    powerClass: string;
    pulseColor: string | null;
    pulseColorSoft: string | null;
    fillY: number;
    fillHeight: number;
    innerX: number;
    innerWidth: number;
    innerFillY: number;
    innerFillHeight: number;
    socClampedRounded: string;
    formattedValue: string | number;
    formattedUnit: string;
    isCharging: boolean;
    isDischarging: boolean;
    svgSize: number;
    socAnchorX: number;
};

@state() private _view?: BatteryView;
```

(Place `BatteryView` at module scope above the `@customElement` line.)

- [ ] **Step 2: Compute the view in `willUpdate`**

Replace (or add) `willUpdate` so it recomputes only when `power`, `soc`, `minSoc`, `sourceColor`, or `compact` changed.

```typescript
willUpdate(changedProperties: Map<string, unknown>): void {
    if (!changedProperties.has('power')
        && !changedProperties.has('soc')
        && !changedProperties.has('minSoc')
        && !changedProperties.has('sourceColor')
        && !changedProperties.has('compact')
        && this._view !== undefined) {
        return;
    }

    const isCharging = this.power > 50;
    const isDischarging = this.power < -50;

    const socClamped = Math.max(0, Math.min(100, this.soc));
    const fillHeight = BODY_HEIGHT * socClamped / 100;
    const fillY = BODY_TOP + BODY_HEIGHT - fillHeight;

    const coverClass = (isCharging || isDischarging) ? 'active'
        : socClamped < this.minSoc ? 'low'
        : socClamped < this.minSoc + 10 ? 'low-orange'
        : '';

    const pulseColor = isCharging ? (this.sourceColor ?? BATT_COLOR) : isDischarging ? BATT_COLOR : null;
    const pulseColorSoft = pulseColor ? withAlpha(pulseColor, '88') : null;

    const fillColorClass = socClamped < this.minSoc ? 'fill-red' : socClamped < this.minSoc + 10 ? 'fill-orange' : 'fill-green';
    const fillClass = (isCharging || isDischarging)
        ? `${fillColorClass} fill-active`
        : (socClamped < 30 ? fillColorClass : 'fill-idle');

    const powerClass = isCharging ? 'charge' : isDischarging ? 'discharge' : '';

    const innerX = BODY_X + INNER_PAD;
    const innerWidth = BODY_WIDTH - INNER_PAD * 2;
    const innerFillY = Math.max(fillY, BODY_TOP + INNER_PAD);
    const innerFillHeight = Math.max(0, fillY + fillHeight - innerFillY - INNER_PAD);

    const { value, unit } = formatPower(Math.abs(this.power));

    this._view = {
        coverClass, fillClass, powerClass,
        pulseColor, pulseColorSoft,
        fillY, fillHeight,
        innerX, innerWidth, innerFillY, innerFillHeight,
        socClampedRounded: socClamped.toFixed(0),
        formattedValue: value, formattedUnit: unit,
        isCharging, isDischarging,
        svgSize: this.compact ? 40 : 50,
        socAnchorX: 2 + BODY_X + BODY_WIDTH / 2,
    };
}
```

- [ ] **Step 3: Rewrite `render()` to read from `_view`**

```typescript
render() {
    const v = this._view;
    if (!v) return html``;
    const pulseStyle = v.pulseColor
        ? `stroke: ${v.pulseColor}; --pulse-color: ${v.pulseColor}; --pulse-color-soft: ${v.pulseColorSoft};`
        : '';
    const terminalStyle = v.pulseColor ? `fill: ${v.pulseColor};` : '';

    return html`
        <div class="svg-wrapper" style="${this.compact ? 'width:40px;height:40px;' : ''}">
            <svg viewBox="-10 -15 77 112" width="${v.svgSize}" height="${v.svgSize}" xmlns="http://www.w3.org/2000/svg">
                <rect class="battery-terminal ${v.coverClass}"
                    x="${BODY_X + BODY_WIDTH / 2 - 8}" y="2" width="16" height="7" rx="3"
                    style="${terminalStyle}"/>
                <rect class="battery-body ${v.coverClass}"
                    x="${BODY_X}" y="${BODY_TOP}" width="${BODY_WIDTH}" height="${BODY_HEIGHT}" rx="5"
                    style="${pulseStyle}"/>
                <clipPath id="${this._clipId}">
                    <rect x="${v.innerX}" y="${BODY_TOP + INNER_PAD}"
                          width="${v.innerWidth}" height="${BODY_HEIGHT - INNER_PAD * 2}" rx="3"/>
                </clipPath>
                <rect class="${v.fillClass}"
                    x="${v.innerX}" y="${v.innerFillY}"
                    width="${v.innerWidth}" height="${v.innerFillHeight}" rx="2"
                    clip-path="url(#${this._clipId})"/>
                <text class="soc-label" dominant-baseline="middle">
                    <tspan x="${v.socAnchorX}" y="43">${v.socClampedRounded}</tspan>
                    <tspan x="${v.socAnchorX}" y="64" class="soc-percent">%</tspan>
                </text>
            </svg>
        </div>
        ${this.compact ? '' : html`
        <div class="power-label ${v.powerClass}">
            ${v.isCharging ? html`↑ ${v.formattedValue} <span class="unit">${v.formattedUnit}</span>`
                : v.isDischarging ? html`↓ ${v.formattedValue} <span class="unit">${v.formattedUnit}</span>`
                : html`${v.formattedValue} <span class="unit">${v.formattedUnit}</span>`}
        </div>`}
    `;
}
```

- [ ] **Step 4: Build + smoke**

Run: `npm run build-dev`. Smoke: battery widget renders with the same pulse animations, the same fill color logic at low SoC, the same charge/discharge arrows, and the compact (40px) variant when used inline as an icon.

- [ ] **Step 5: Commit**

```bash
git add src/helman-simple/simple-card-battery.ts
git commit -m "perf(simple-card-battery): precompute SVG view in willUpdate"
```

### Task 8b — `simple-card-house`

- [ ] **Step 1: Read current render**

Open `src/helman-simple/simple-card-house.ts`. Identify the same shape of in-render arithmetic.

- [ ] **Step 2-5: Apply the same pattern**

Mirror the structure from Task 8a: define a `HouseView` type, add `@state() private _view?: HouseView`, populate in `willUpdate` with the existing computations, rewrite `render()` to read from `_view`. Trigger inputs are the component's `@property`s (typically `power`, `sourceColor`, `compact` — confirm by reading the file).

- [ ] **Step 6: Build + smoke**

Run: `npm run build-dev`. Smoke: house widget visually identical.

- [ ] **Step 7: Commit**

```bash
git add src/helman-simple/simple-card-house.ts
git commit -m "perf(simple-card-house): precompute SVG view in willUpdate"
```

---

## Final pass — full smoke and PR

- [ ] **Run full prod build to confirm no regressions**

Run: `npm run build-prod`
Expected: build succeeds, minified bundle is produced under `dist/`.

- [ ] **Manual end-to-end smoke**

Load both `helman-card` and `helman-simple-card` in HA. Walk through:
- Initial load shows the device tree.
- History bars are filled and segmented per source color.
- Click each of the four simple-card nodes (solar/grid/house/battery) → detail dialog opens.
- Click a category chip in `power-house-devices-section` → grouping kicks in; click again → returns to flat.
- Toggle an unrelated entity from Developer Tools and observe the card does not re-render (use `console.count('render')` if needed inside one of the renders to verify).
- Wait at least 60 seconds and confirm history bars advance one bucket.

- [ ] **Cross-check against the findings doc**

Open `PERFORMANCE_FINDINGS.md` and tick off findings #1–#8 against the commits in `git log --oneline`. Each finding should map to at least one `perf(...)` commit.

- [ ] **Open PR**

Title: `perf: cut per-tick CPU/GC work in helman cards`. Body: paste the summary table from `PERFORMANCE_FINDINGS.md` rows 1-8 with checkboxes ticked.

---

## Self-review notes

- **Spec coverage:** Findings #1 (Task 2), #2 (Task 3), #3 (Task 1), #4 (Task 4), #5 (Task 6), #6 (Task 5), #7 (Task 7), #8 (Task 8a + 8b). All High and Medium covered.
- **Out of scope (intentional):** #9 `power-devices-container` Map allocation (low) and #10 mutable tree design (architectural). Mention in the PR body.
- **Type consistency:** `_view` / `BatteryView` / `HouseView` / `Bar` / `BarSegment` are file-local types; `_watchedEntityIds` and `_latestHass` use the same names in both root cards; `computeDominantSourceColorCached` / `computeSourceColorCached` are the canonical added exports from `color-utils.ts`.
- **No tests-in-repo caveat:** Verification is build + manual smoke. If the project later adopts a test runner, `power-device-history-bars`'s `_bars` precomputation and `color-utils`'s caching wrappers are the easiest unit-test targets — they are pure given inputs.
